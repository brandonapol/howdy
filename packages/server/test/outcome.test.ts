import { test } from "node:test";
import assert from "node:assert/strict";
import { foldFrames } from "../dist/agent/outcome.js";
import type { AgentFrame } from "../dist/agent/outcome.js";

const assistant = (blocks: readonly { type: string; text?: string; name?: string }[]): AgentFrame => ({
  type: "assistant",
  session_id: "sess-1",
  message: { content: blocks },
});

const result = (over: Partial<AgentFrame> = {}): AgentFrame => ({
  type: "result",
  subtype: "success",
  is_error: false,
  session_id: "sess-1",
  total_cost_usd: 0.0123,
  modelUsage: {
    "claude-sonnet-5": {
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadInputTokens: 8000,
      cacheCreationInputTokens: 500,
      costUSD: 0.0123,
    },
  },
  ...over,
});

test("assistant text blocks concatenate in order", () => {
  const outcome = foldFrames([
    assistant([{ type: "text", text: "Howdy. " }]),
    assistant([{ type: "text", text: "Checked the cluster." }]),
    result(),
  ]);
  assert.equal(outcome.text, "Howdy. Checked the cluster.");
});

test("tool_use blocks are counted and named", () => {
  const outcome = foldFrames([
    assistant([{ type: "tool_use", name: "Bash" }, { type: "text", text: "running" }]),
    assistant([{ type: "tool_use", name: "Read" }]),
    result(),
  ]);
  assert.deepEqual(outcome.toolCalls, ["Bash", "Read"]);
});

test("usage is summed from modelUsage across every model", () => {
  const outcome = foldFrames([
    assistant([{ type: "text", text: "hi" }]),
    result({
      modelUsage: {
        "claude-sonnet-5": { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 1, cacheCreationInputTokens: 2 },
        "claude-haiku-4-5": { inputTokens: 50, outputTokens: 5, cacheReadInputTokens: 3, cacheCreationInputTokens: 4 },
      },
    }),
  ]);
  assert.equal(outcome.usage.inputTokens, 150);
  assert.equal(outcome.usage.outputTokens, 15);
  assert.equal(outcome.usage.cacheReadTokens, 4);
  assert.equal(outcome.usage.cacheCreationTokens, 6);
});

test("thinking and unknown block types contribute no text", () => {
  const outcome = foldFrames([
    assistant([{ type: "thinking", text: "internal musing" }, { type: "text", text: "answer" }]),
    result(),
  ]);
  assert.equal(outcome.text, "answer");
});

test("an error result is flagged with its detail and does not pretend to succeed", () => {
  const outcome = foldFrames([
    assistant([{ type: "text", text: "partial" }]),
    result({ subtype: "error_during_execution", is_error: true, result: "tool crashed" }),
  ]);
  assert.equal(outcome.isError, true);
  assert.equal(outcome.detail, "tool crashed");
});

test("a result with no assistant text falls back to the result string", () => {
  const outcome = foldFrames([result({ result: "done, nothing to report" })]);
  assert.equal(outcome.text, "done, nothing to report");
  assert.equal(outcome.isError, false);
});

test("a missing modelUsage block yields zero usage rather than NaN", () => {
  const outcome = foldFrames([
    assistant([{ type: "text", text: "hi" }]),
    { type: "result", subtype: "success", is_error: false },
  ]);
  assert.equal(outcome.usage.inputTokens, 0);
  assert.equal(outcome.costUsd, 0);
  assert.ok(Number.isFinite(outcome.usage.outputTokens));
});

test("cost falls back to summed per-model cost when the total is absent", () => {
  const outcome = foldFrames([
    result({
      total_cost_usd: undefined,
      modelUsage: {
        a: { costUSD: 0.01 },
        b: { costUSD: 0.02 },
      },
    }),
  ]);
  assert.ok(Math.abs(outcome.costUsd - 0.03) < 1e-9);
});

test("unrelated frame types are ignored without disturbing the fold", () => {
  const outcome = foldFrames([
    { type: "system", subtype: "init" },
    assistant([{ type: "text", text: "hello" }]),
    { type: "status" },
    { type: "hook_started" },
    result(),
  ]);
  assert.equal(outcome.text, "hello");
  assert.equal(outcome.sessionId, "sess-1");
  assert.equal(outcome.isError, false);
});

test("the session id survives for later resumption", () => {
  const outcome = foldFrames([assistant([{ type: "text", text: "x" }]), result()]);
  assert.equal(outcome.sessionId, "sess-1");
});
