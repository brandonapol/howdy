import { emptyUsage } from "@howdy/core";
import type { Usage } from "@howdy/core";

export type AgentFrame = {
  readonly type: string;
  readonly subtype?: string;
  readonly session_id?: string;
  readonly is_error?: boolean;
  readonly result?: string;
  readonly total_cost_usd?: number;
  readonly modelUsage?: Record<string, {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cacheReadInputTokens?: number;
    readonly cacheCreationInputTokens?: number;
    readonly costUSD?: number;
  }>;
  readonly message?: {
    readonly content?: readonly { readonly type: string; readonly text?: string; readonly name?: string }[];
  };
};

export type TurnOutcome = {
  readonly text: string;
  readonly toolCalls: readonly string[];
  readonly usage: Usage;
  readonly costUsd: number;
  readonly sessionId: string | null;
  readonly isError: boolean;
  readonly detail: string | null;
};

export const emptyOutcome: TurnOutcome = {
  text: "",
  toolCalls: [],
  usage: emptyUsage,
  costUsd: 0,
  sessionId: null,
  isError: false,
  detail: null,
};

const sumModelUsage = (frame: AgentFrame): { usage: Usage; costUsd: number } => {
  const entries = Object.values(frame.modelUsage ?? {});
  const usage = entries.reduce<Usage>(
    (acc, m) => ({
      inputTokens: acc.inputTokens + (m.inputTokens ?? 0),
      outputTokens: acc.outputTokens + (m.outputTokens ?? 0),
      cacheReadTokens: acc.cacheReadTokens + (m.cacheReadInputTokens ?? 0),
      cacheCreationTokens: acc.cacheCreationTokens + (m.cacheCreationInputTokens ?? 0),
    }),
    emptyUsage,
  );
  const costUsd =
    frame.total_cost_usd ?? entries.reduce((acc, m) => acc + (m.costUSD ?? 0), 0);
  return { usage, costUsd };
};

export const foldFrame = (outcome: TurnOutcome, frame: AgentFrame): TurnOutcome => {
  if (frame.type === "assistant") {
    const blocks = frame.message?.content ?? [];
    const text = blocks
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text ?? "")
      .join("");
    const tools = blocks
      .filter((b) => b.type === "tool_use")
      .map((b) => b.name ?? "unknown");
    return {
      ...outcome,
      text: outcome.text + text,
      toolCalls: [...outcome.toolCalls, ...tools],
      sessionId: frame.session_id ?? outcome.sessionId,
    };
  }

  if (frame.type === "result") {
    const { usage, costUsd } = sumModelUsage(frame);
    const failed = frame.is_error === true || frame.subtype !== "success";
    return {
      ...outcome,
      usage,
      costUsd,
      sessionId: frame.session_id ?? outcome.sessionId,
      isError: failed,
      detail: failed ? (frame.result ?? frame.subtype ?? "agent reported an error") : null,
      text: outcome.text.trim() === "" && typeof frame.result === "string" && !failed
        ? frame.result
        : outcome.text,
    };
  }

  return outcome;
};

export const foldFrames = (frames: Iterable<AgentFrame>): TurnOutcome => {
  let outcome = emptyOutcome;
  for (const frame of frames) outcome = foldFrame(outcome, frame);
  return outcome;
};
