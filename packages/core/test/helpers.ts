import {
  botId,
  createBudget,
  defaultCeilings,
  emptyUsage,
  messageId,
  roomId,
  seedFrom,
} from "../dist/index.js";
import type {
  BotId,
  Ceilings,
  ParticipantState,
  RoomMessage,
  RoomState,
  Usage,
} from "../dist/index.js";

export const participant = (
  id: string,
  noisiness = 1,
  cooldownTurns = 0,
): ParticipantState => ({
  botId: botId(id),
  noisiness,
  cooldownTurns,
  lastSpokeAtTurn: null,
});

export const makeState = (
  participants: readonly ParticipantState[],
  overrides: Partial<RoomState> = {},
  ceilings: Ceilings = defaultCeilings,
): RoomState => ({
  roomId: roomId("r1"),
  participants,
  status: { kind: "idle" },
  budget: createBudget(ceilings, 0),
  turnIndex: 0,
  recent: [],
  pendingMentions: [],
  stepMode: false,
  decayCount: 0,
  rngState: seedFrom("howdy"),
  ...overrides,
});

let counter = 0;

export const botMessage = (
  id: string,
  content: string,
  usage: Usage = emptyUsage,
  toolCallCount = 0,
): RoomMessage => {
  counter += 1;
  return {
    id: messageId(`m${counter}`),
    roomId: roomId("r1"),
    speaker: { kind: "bot", botId: botId(id) },
    content,
    turnIndex: counter,
    toolCallCount,
    usage,
    createdAt: counter * 1000,
  };
};

export const humanMessage = (content: string): RoomMessage => {
  counter += 1;
  return {
    id: messageId(`m${counter}`),
    roomId: roomId("r1"),
    speaker: { kind: "human" },
    content,
    turnIndex: counter,
    toolCallCount: 0,
    usage: emptyUsage,
    createdAt: counter * 1000,
  };
};

export const usage = (input: number, output: number): Usage => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
});

export const botIdOf = (id: string): BotId => botId(id);
