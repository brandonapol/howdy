import { query } from "@anthropic-ai/claude-agent-sdk";
import type { RoomMessage } from "@howdy/core";

export type Verdict =
  | { readonly kind: "done"; readonly summary: string }
  | { readonly kind: "continue" }
  | { readonly kind: "stuck"; readonly summary: string };

export type Judge = (
  goal: string,
  transcript: readonly RoomMessage[],
  signal: AbortSignal,
) => Promise<Verdict>;

const SYSTEM = `You judge whether a conversation between assistants has finished its goal.

Reply with exactly one line, in one of these three forms and nothing else:

DONE: <one sentence saying what was concluded>
STUCK: <one sentence saying what they are missing>
CONTINUE

Answer DONE only when the goal is genuinely settled - a conclusion reached, a
decision made, or the work reported as finished. Answer STUCK when they are
circling, blocked on something only a human can supply, or repeating each other.
Otherwise answer CONTINUE. Prefer CONTINUE when unsure.`;

export const parseVerdict = (raw: string): Verdict => {
  const line = raw.trim().split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
  const done = /^DONE:\s*(.+)$/i.exec(line);
  if (done !== null) return { kind: "done", summary: (done[1] ?? "").trim() };
  const stuck = /^STUCK:\s*(.+)$/i.exec(line);
  if (stuck !== null) return { kind: "stuck", summary: (stuck[1] ?? "").trim() };
  return { kind: "continue" };
};

const render = (transcript: readonly RoomMessage[], limit = 12): string =>
  transcript
    .slice(-limit)
    .map((m) => {
      const who =
        m.speaker.kind === "human" ? "Human" : m.speaker.kind === "system" ? "System" : "Assistant";
      return `${who}: ${m.content}`;
    })
    .join("\n\n");

export const createJudge = (model = "claude-haiku-4-5"): Judge =>
  async (goal, transcript, signal) => {
    const controller = new AbortController();
    if (signal.aborted) return { kind: "continue" };
    signal.addEventListener("abort", () => controller.abort(), { once: true });

    let text = "";
    try {
      const stream = query({
        prompt: `Goal: ${goal}\n\nConversation so far:\n\n${render(transcript)}\n\nVerdict?`,
        options: {
          model,
          systemPrompt: { type: "custom", prompt: SYSTEM },
          tools: [],
          maxTurns: 1,
          settingSources: [],
          abortController: controller,
        },
      });
      for await (const frame of stream) {
        const f = frame as { type: string; result?: string; message?: { content?: { type: string; text?: string }[] } };
        if (f.type === "assistant") {
          for (const block of f.message?.content ?? []) {
            if (block.type === "text" && typeof block.text === "string") text += block.text;
          }
        }
        if (f.type === "result" && text.trim() === "" && typeof f.result === "string") {
          text = f.result;
        }
      }
    } catch {
      return { kind: "continue" };
    }
    return parseVerdict(text);
  };
