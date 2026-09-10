import { query } from "@anthropic-ai/claude-agent-sdk";
import type { CanUseTool, McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { AgentFrame, TurnOutcome } from "./outcome.js";
import { emptyOutcome, foldFrame } from "./outcome.js";

export type RunTurnInput = {
  readonly prompt: string;
  readonly systemPrompt: string;
  readonly cwd: string;
  readonly model: string;
  readonly allowedTools: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly resume?: string | undefined;
  readonly maxTurns: number;
  readonly signal: AbortSignal;
  readonly canUseTool?: CanUseTool;
  readonly mcpServers?: Record<string, McpServerConfig>;
  readonly onText?: (text: string) => void;
  readonly onToolUse?: (tool: string) => void;
};

const link = (signal: AbortSignal): AbortController => {
  const controller = new AbortController();
  if (signal.aborted) controller.abort(signal.reason);
  else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  return controller;
};

export const runTurn = async (input: RunTurnInput): Promise<TurnOutcome> => {
  const controller = link(input.signal);
  let outcome = emptyOutcome;
  let emittedText = "";
  let emittedTools = 0;

  const stream = query({
    prompt: input.prompt,
    options: {
      cwd: input.cwd,
      model: input.model,
      systemPrompt: { type: "custom", prompt: input.systemPrompt },
      allowedTools: [...input.allowedTools],
      ...(input.disallowedTools === undefined
        ? {}
        : { disallowedTools: [...input.disallowedTools] }),
      ...(input.canUseTool === undefined ? {} : { canUseTool: input.canUseTool }),
      ...(input.mcpServers === undefined ? {} : { mcpServers: input.mcpServers }),
      ...(input.resume === undefined ? {} : { resume: input.resume }),
      maxTurns: input.maxTurns,
      settingSources: [],
      abortController: controller,
    },
  });

  for await (const frame of stream) {
    outcome = foldFrame(outcome, frame as unknown as AgentFrame);

    if (outcome.text.length > emittedText.length) {
      input.onText?.(outcome.text.slice(emittedText.length));
      emittedText = outcome.text;
    }
    for (const tool of outcome.toolCalls.slice(emittedTools)) input.onToolUse?.(tool);
    emittedTools = outcome.toolCalls.length;

    if (controller.signal.aborted) break;
  }

  if (controller.signal.aborted) {
    throw (controller.signal.reason as Error | undefined) ?? new Error("turn aborted");
  }
  return outcome;
};
