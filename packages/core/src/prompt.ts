import type { Bot, RoomMessage } from "./types.js";

export type PromptContext = {
  readonly roomName: string;
  readonly goal: string | null;
  readonly participants: readonly string[];
  readonly isParty: boolean;
};

export type SystemPrompt = {
  readonly text: string;
  readonly stablePrefixLength: number;
};

const PARTY_RULES = `You are in a room with other bots and a human.

Speak only when you add something. If you agree and have nothing to add, say so in
one short line, or say nothing of substance rather than padding. Never restate what
another bot just said in different words.

Prefer concrete specifics: names, paths, commands, numbers. Ask a direct question
when you need one answered rather than speculating at length.

Do not thank, congratulate, or compliment the other bots. Do not open with an
assessment of the previous message. Begin with your actual contribution.

Keep it under 150 words unless you are reporting the result of real work.`;

const SOLO_RULES = `You are talking one to one with a human.

Be direct and concrete. Ask when you need a decision rather than guessing. Prefer
doing the work with your tools over describing what could be done.`;

export const buildSystemPrompt = (
  bot: Bot,
  personality: string,
  memory: string,
  context: PromptContext,
): SystemPrompt => {
  const stable = [
    `You are ${bot.name}.`,
    "",
    personality.trim(),
    "",
    context.isParty ? PARTY_RULES : SOLO_RULES,
    "",
    `Your workspace is ${bot.workspacePath}. Everything you create belongs there.`,
  ].join("\n");

  const volatile = [
    memory.trim() === "" ? "" : `What you remember from before:\n${memory.trim()}`,
    "",
    `Room: ${context.roomName}`,
    context.goal === null ? "" : `Goal: ${context.goal}`,
    context.participants.length > 0
      ? `Also here: ${context.participants.join(", ")}`
      : "",
  ]
    .filter((line) => line !== "")
    .join("\n");

  return {
    text: volatile === "" ? stable : `${stable}\n\n${volatile}`,
    stablePrefixLength: stable.length,
  };
};

const speakerLabel = (
  message: RoomMessage,
  nameOf: (id: string) => string,
): string => {
  switch (message.speaker.kind) {
    case "human":
      return "Human";
    case "system":
      return "System";
    case "bot":
      return nameOf(String(message.speaker.botId));
  }
};

export const buildTurnPrompt = (
  recent: readonly RoomMessage[],
  nameOf: (id: string) => string,
  limit = 20,
): string => {
  const window = recent.slice(-limit);
  if (window.length === 0) return "Open the conversation.";
  const transcript = window
    .map((m) => `${speakerLabel(m, nameOf)}: ${m.content}`)
    .join("\n\n");
  return `${transcript}\n\nYour turn.`;
};

export const extractMentions = (
  text: string,
  slugToId: ReadonlyMap<string, string>,
): readonly string[] => {
  const found: string[] = [];
  for (const match of text.matchAll(/(?:^|[\s(,])@([a-z0-9][a-z0-9_-]*)/gi)) {
    const slug = match[1]?.toLowerCase();
    if (slug === undefined) continue;
    const id = slugToId.get(slug);
    if (id !== undefined && !found.includes(id)) found.push(id);
  }
  return found;
};
