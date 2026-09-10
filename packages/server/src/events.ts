import type { Effect, HaltReason, RoomStatus, Usage } from "@howdy/core";

export type HowdyEvent =
  | { readonly kind: "message"; readonly roomId: string; readonly message: unknown }
  | { readonly kind: "chunk"; readonly roomId: string; readonly botId: string; readonly text: string }
  | { readonly kind: "toolUse"; readonly roomId: string; readonly botId: string; readonly tool: string; readonly summary: string }
  | { readonly kind: "turnStarted"; readonly roomId: string; readonly botId: string }
  | { readonly kind: "turnFinished"; readonly roomId: string; readonly botId: string; readonly usage: Usage; readonly costUsd: number }
  | {
      readonly kind: "roomStatus";
      readonly roomId: string;
      readonly status: RoomStatus;
      readonly turnsUsed: number;
      readonly tokensUsed: number;
      readonly ceilings: { readonly maxTurns: number; readonly maxTokens: number };
    }
  | { readonly kind: "halted"; readonly roomId: string; readonly reason: HaltReason }
  | { readonly kind: "announce"; readonly roomId: string; readonly text: string }
  | { readonly kind: "queueDepth"; readonly depth: number }
  | { readonly kind: "spend"; readonly tokensToday: number; readonly ceiling: number }
  | { readonly kind: "permissionRequest"; readonly id: string; readonly roomId: string; readonly botId: string; readonly tool: string; readonly detail: string }
  | { readonly kind: "permissionResolved"; readonly id: string; readonly allowed: boolean }
  | {
      readonly kind: "remembered";
      readonly roomId: string;
      readonly botId: string;
      readonly fact: string;
      readonly total: number;
    }
  | {
      readonly kind: "routineFired";
      readonly routineId: string;
      readonly roomId: string;
      readonly name: string;
    }
  | { readonly kind: "shutdown" };

export type Envelope = { readonly id: number; readonly event: HowdyEvent };

export type Subscriber = (envelope: Envelope) => void;

export type EventBus = {
  readonly publish: (event: HowdyEvent) => Envelope;
  readonly subscribe: (subscriber: Subscriber, since?: number) => () => void;
  readonly replay: (since: number) => readonly Envelope[];
  readonly subscriberCount: () => number;
};

export const createEventBus = (bufferSize = 500): EventBus => {
  const subscribers = new Set<Subscriber>();
  let buffer: Envelope[] = [];
  let nextId = 1;

  const replay = (since: number): readonly Envelope[] =>
    buffer.filter((e) => e.id > since);

  return {
    publish: (event) => {
      const envelope: Envelope = { id: nextId, event };
      nextId += 1;
      buffer.push(envelope);
      if (buffer.length > bufferSize) buffer = buffer.slice(-bufferSize);
      for (const s of subscribers) {
        try {
          s(envelope);
        } catch {
          subscribers.delete(s);
        }
      }
      return envelope;
    },
    subscribe: (subscriber, since) => {
      if (since !== undefined) for (const e of replay(since)) subscriber(e);
      subscribers.add(subscriber);
      return () => {
        subscribers.delete(subscriber);
      };
    },
    replay,
    subscriberCount: () => subscribers.size,
  };
};

export const effectToEvent = (roomId: string, effect: Effect): HowdyEvent | null => {
  switch (effect.kind) {
    case "announce":
      return { kind: "announce", roomId, text: effect.text };
    case "halted":
      return { kind: "halted", roomId, reason: effect.reason };
    case "runTurn":
      return { kind: "turnStarted", roomId, botId: String(effect.speaker) };
    case "abortTurn":
      return null;
  }
};
