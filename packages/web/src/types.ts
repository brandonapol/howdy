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

export type HowdyEvent =
  | { readonly kind: "message"; readonly roomId: string; readonly message: Message }
  | { readonly kind: "chunk"; readonly roomId: string; readonly botId: string; readonly text: string }
  | { readonly kind: "toolUse"; readonly roomId: string; readonly botId: string; readonly tool: string; readonly summary: string }
  | { readonly kind: "turnStarted"; readonly roomId: string; readonly botId: string }
  | { readonly kind: "turnFinished"; readonly roomId: string; readonly botId: string; readonly usage: Usage; readonly costUsd: number }
  | { readonly kind: "halted"; readonly roomId: string; readonly reason: { readonly kind: string } }
  | { readonly kind: "announce"; readonly roomId: string; readonly text: string }
  | { readonly kind: "queueDepth"; readonly depth: number }
  | { readonly kind: "spend"; readonly tokensToday: number; readonly ceiling: number }
  | { readonly kind: "roomStatus"; readonly roomId: string; readonly status: unknown }
  | { readonly kind: "permissionRequest"; readonly id: string; readonly roomId: string; readonly botId: string; readonly tool: string; readonly detail: string }
  | { readonly kind: "permissionResolved"; readonly id: string; readonly allowed: boolean };

export type Envelope = { readonly id: number; readonly event: HowdyEvent };
