export type Bot = {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly model: string;
  readonly effort: string;
  readonly noisiness: number;
  readonly cooldownTurns: number;
  readonly avatarColor: string;
  readonly workspacePath: string;
  readonly enabled: boolean;
};

export type BotDetail = Bot & {
  readonly personality: string;
  readonly memory: string;
};

export type Message = {
  readonly id: string;
  readonly roomId: string;
  readonly speakerKind: "human" | "bot" | "system";
  readonly botId: string | null;
  readonly content: string;
  readonly turnIndex: number;
  readonly toolCallCount: number;
  readonly createdAt: number;
};

export type Usage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
};

export type Ceilings = {
  readonly maxTurns: number;
  readonly maxTokens: number;
  readonly maxWallClockMs: number;
  readonly maxToolCallsPerTurn: number;
};

export type RoomStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "awaitingTurn"; readonly speaker: string }
  | { readonly kind: "running"; readonly speaker: string }
  | { readonly kind: "halted"; readonly reason: HaltReason };

export type HaltReason =
  | { readonly kind: "manual" }
  | { readonly kind: "budget"; readonly breach: { readonly kind: string; readonly used: number; readonly ceiling: number } }
  | { readonly kind: "degeneracy"; readonly detector: string; readonly detail: string }
  | { readonly kind: "error"; readonly detail: string };

export type Room = {
  readonly id: string;
  readonly name: string;
  readonly kind: "solo" | "party";
  readonly goal: string | null;
  readonly stepMode: boolean;
  readonly ceilings: Ceilings;
  readonly participants: readonly string[];
  readonly status: RoomStatus;
  readonly budget: {
    readonly turnsUsed: number;
    readonly tokensUsed: number;
    readonly ceilings: Ceilings;
  };
};

export type TimelineEntry = {
  readonly kind: "turn" | "note";
  readonly botId?: string;
  readonly status?: "ok" | "failed" | "running";
  readonly detail?: string | null;
  readonly durationMs?: number | null;
  readonly tokens?: number | null;
  readonly toolCalls?: number | null;
  readonly content?: string | null;
  readonly startedAt?: number;
};

export type HowdyEvent =
  | { readonly kind: "message"; readonly roomId: string; readonly message: Message }
  | { readonly kind: "chunk"; readonly roomId: string; readonly botId: string; readonly text: string }
  | { readonly kind: "toolUse"; readonly roomId: string; readonly botId: string; readonly tool: string; readonly summary: string }
  | { readonly kind: "turnStarted"; readonly roomId: string; readonly botId: string }
  | { readonly kind: "turnFinished"; readonly roomId: string; readonly botId: string; readonly usage: Usage; readonly costUsd: number }
  | { readonly kind: "halted"; readonly roomId: string; readonly reason: HaltReason }
  | { readonly kind: "announce"; readonly roomId: string; readonly text: string }
  | { readonly kind: "queueDepth"; readonly depth: number }
  | { readonly kind: "spend"; readonly tokensToday: number; readonly ceiling: number }
  | {
      readonly kind: "roomStatus";
      readonly roomId: string;
      readonly status: RoomStatus;
      readonly turnsUsed: number;
      readonly tokensUsed: number;
      readonly ceilings: { readonly maxTurns: number; readonly maxTokens: number };
    }
  | { readonly kind: "permissionRequest"; readonly id: string; readonly roomId: string; readonly botId: string; readonly tool: string; readonly detail: string }
  | { readonly kind: "permissionResolved"; readonly id: string; readonly allowed: boolean }
  | {
      readonly kind: "remembered";
      readonly roomId: string;
      readonly botId: string;
      readonly fact: string;
      readonly total: number;
    };

export type Envelope = { readonly id: number; readonly event: HowdyEvent };
