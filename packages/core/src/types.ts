export type Brand<T, B extends string> = T & { readonly __brand: B };

export type BotId = Brand<string, "BotId">;
export type RoomId = Brand<string, "RoomId">;
export type MessageId = Brand<string, "MessageId">;
export type TurnId = Brand<string, "TurnId">;

export const botId = (raw: string): BotId => raw as BotId;
export const roomId = (raw: string): RoomId => raw as RoomId;
export const messageId = (raw: string): MessageId => raw as MessageId;
export const turnId = (raw: string): TurnId => raw as TurnId;

export type ModelId =
  | "claude-opus-5"
  | "claude-sonnet-5"
  | "claude-haiku-4-5";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type Usage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
};

export const emptyUsage: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

export type Bot = {
  readonly id: BotId;
  readonly slug: string;
  readonly name: string;
  readonly model: ModelId;
  readonly effort: Effort;
  readonly noisiness: number;
  readonly cooldownTurns: number;
  readonly avatarColor: string;
  readonly botDir: string;
  readonly workspacePath: string;
  readonly allowedCommands: readonly string[];
  readonly enabled: boolean;
};

export type Speaker =
  | { readonly kind: "human" }
  | { readonly kind: "bot"; readonly botId: BotId }
  | { readonly kind: "system" };

export type RoomMessage = {
  readonly id: MessageId;
  readonly roomId: RoomId;
  readonly speaker: Speaker;
  readonly content: string;
  readonly turnIndex: number;
  readonly toolCallCount: number;
  readonly usage: Usage;
  readonly createdAt: number;
};

export type Ceilings = {
  readonly maxTurns: number;
  readonly maxTokens: number;
  readonly maxWallClockMs: number;
  readonly maxToolCallsPerTurn: number;
};

export const defaultCeilings: Ceilings = {
  maxTurns: 20,
  maxTokens: 100_000,
  maxWallClockMs: 10 * 60 * 1000,
  maxToolCallsPerTurn: 15,
};

export type Budget = {
  readonly ceilings: Ceilings;
  readonly turnsUsed: number;
  readonly tokensUsed: number;
  readonly startedAt: number;
  readonly now: number;
};

export type BreachKind = "turns" | "tokens" | "wallClock";

export type Breach = {
  readonly kind: BreachKind;
  readonly used: number;
  readonly ceiling: number;
};

export type HaltReason =
  | { readonly kind: "manual" }
  | { readonly kind: "complete"; readonly summary: string }
  | { readonly kind: "budget"; readonly breach: Breach }
  | { readonly kind: "degeneracy"; readonly detector: string; readonly detail: string }
  | { readonly kind: "error"; readonly detail: string };

export type RoomStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "awaitingTurn"; readonly speaker: BotId }
  | { readonly kind: "running"; readonly speaker: BotId }
  | { readonly kind: "halted"; readonly reason: HaltReason };

export type ParticipantState = {
  readonly botId: BotId;
  readonly noisiness: number;
  readonly baseNoisiness: number;
  readonly cooldownTurns: number;
  readonly lastSpokeAtTurn: number | null;
};

export type RoomState = {
  readonly roomId: RoomId;
  readonly participants: readonly ParticipantState[];
  readonly status: RoomStatus;
  readonly budget: Budget;
  readonly turnIndex: number;
  readonly recent: readonly RoomMessage[];
  readonly pendingMentions: readonly BotId[];
  readonly stepMode: boolean;
  readonly decayCount: number;
  readonly rngState: number;
};

export type RoomEvent =
  | { readonly kind: "humanMessage"; readonly message: RoomMessage; readonly mentions: readonly BotId[] }
  | { readonly kind: "turnCompleted"; readonly message: RoomMessage }
  | { readonly kind: "turnFailed"; readonly speaker: BotId; readonly detail: string }
  | { readonly kind: "handoff"; readonly to: BotId; readonly reason: string }
  | { readonly kind: "goalReached"; readonly summary: string }
  | { readonly kind: "haltRequested" }
  | { readonly kind: "resumeRequested" }
  | { readonly kind: "stepRequested" }
  | { readonly kind: "clockTick"; readonly now: number };

export type Effect =
  | { readonly kind: "runTurn"; readonly speaker: BotId; readonly turnIndex: number }
  | { readonly kind: "abortTurn"; readonly speaker: BotId }
  | { readonly kind: "announce"; readonly text: string }
  | { readonly kind: "halted"; readonly reason: HaltReason };

export type Step = readonly [RoomState, readonly Effect[]];
