import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { Bot } from "@howdy/core";

export type RoomToolDeps = {
  readonly roomId: string;
  readonly speaker: Bot;
  readonly others: readonly Bot[];
  readonly handoff: (toBotId: string, reason: string) => boolean;
};

const text = (body: string) => ({ content: [{ type: "text" as const, text: body }] });

export const createRoomServer = (deps: RoomToolDeps): McpSdkServerConfigWithInstance => {
  const roster = deps.others.map((b) => `${b.slug} (${b.name})`).join(", ");

  return createSdkMcpServer({
    name: "howdy-room",
    version: "1.0.0",
    instructions:
      `You are in a room with: ${roster || "nobody else"}. Use handoff when ` +
      "another bot is genuinely better placed to answer than you are. Do not use it " +
      "to be polite, to pass work you could do, or to bounce a question back.",
    tools: [
      tool(
        "handoff",
        "Ask another bot in this room to take the next turn, because it is better placed than you.",
        {
          bot: z.string().describe(`The slug of the bot to hand to. One of: ${roster}`),
          reason: z.string().min(3).describe("Why they are better placed, in one sentence."),
        },
        async ({ bot, reason }) => {
          const target = deps.others.find(
            (b) => b.slug === bot.toLowerCase() || b.name.toLowerCase() === bot.toLowerCase(),
          );
          if (target === undefined) {
            return text(`No bot called "${bot}" is in this room. Here: ${roster || "nobody"}.`);
          }
          const accepted = deps.handoff(String(target.id), reason);
          return text(
            accepted
              ? `${target.name} will take the next turn. Finish your thought first.`
              : `${target.name} is already queued to speak next.`,
          );
        },
      ),
    ],
  });
};
