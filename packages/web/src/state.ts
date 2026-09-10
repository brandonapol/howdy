import type { Envelope, HowdyEvent, Message } from "./types.js";

export type Notice = {
  readonly id: string;
  readonly roomId: string;
  readonly text: string;
  readonly tone: "info" | "alert";
};

export type RoomView = {
  readonly messages: readonly Message[];
  readonly streaming: Readonly<Record<string, string>>;
  readonly activeBot: string | null;
  readonly tools: readonly string[];
};

export type UiState = {
  readonly rooms: Readonly<Record<string, RoomView>>;
  readonly queueDepth: number;
  readonly tokensToday: number;
  readonly tokenCeiling: number;
  readonly notices: readonly Notice[];
  readonly lastEventId: number;
};

export const emptyRoom: RoomView = {
  messages: [],
  streaming: {},
  activeBot: null,
  tools: [],
};

export const initialState: UiState = {
  rooms: {},
  queueDepth: 0,
  tokensToday: 0,
  tokenCeiling: 0,
  notices: [],
  lastEventId: 0,
};

const NOTICE_LIMIT = 6;

const roomOf = (state: UiState, roomId: string): RoomView =>
  state.rooms[roomId] ?? emptyRoom;

const withRoom = (state: UiState, roomId: string, room: RoomView): UiState => ({
  ...state,
  rooms: { ...state.rooms, [roomId]: room },
});

const addNotice = (state: UiState, notice: Notice): UiState => ({
  ...state,
  notices: [...state.notices, notice].slice(-NOTICE_LIMIT),
});

export const mergeMessage = (
  messages: readonly Message[],
  message: Message,
): readonly Message[] => {
  if (messages.some((m) => m.id === message.id)) {
    return messages.map((m) => (m.id === message.id ? message : m));
  }
  return [...messages, message].sort((a, b) =>
    a.createdAt === b.createdAt ? a.turnIndex - b.turnIndex : a.createdAt - b.createdAt,
  );
};

export const applyEvent = (state: UiState, event: HowdyEvent): UiState => {
  switch (event.kind) {
    case "message": {
      const room = roomOf(state, event.roomId);
      const botId = event.message.botId;
      const streaming =
        botId === null ? room.streaming : omit(room.streaming, botId);
      return withRoom(state, event.roomId, {
        ...room,
        messages: mergeMessage(room.messages, event.message),
        streaming,
        tools: botId === null ? room.tools : [],
      });
    }

    case "chunk": {
      const room = roomOf(state, event.roomId);
      return withRoom(state, event.roomId, {
        ...room,
        streaming: {
          ...room.streaming,
          [event.botId]: (room.streaming[event.botId] ?? "") + event.text,
        },
      });
    }

    case "toolUse": {
      const room = roomOf(state, event.roomId);
      return withRoom(state, event.roomId, {
        ...room,
        tools: [...room.tools, event.summary].slice(-8),
      });
    }

    case "turnStarted": {
      const room = roomOf(state, event.roomId);
      return withRoom(state, event.roomId, {
        ...room,
        activeBot: event.botId,
        tools: [],
      });
    }

    case "turnFinished": {
      const room = roomOf(state, event.roomId);
      return withRoom(state, event.roomId, { ...room, activeBot: null });
    }

    case "halted": {
      const room = roomOf(state, event.roomId);
      const halted = withRoom(state, event.roomId, {
        ...room,
        activeBot: null,
        streaming: {},
      });
      return addNotice(halted, {
        id: `halt-${state.lastEventId}`,
        roomId: event.roomId,
        text: `Halted: ${event.reason.kind}`,
        tone: "alert",
      });
    }

    case "announce":
      return addNotice(state, {
        id: `note-${state.lastEventId}`,
        roomId: event.roomId,
        text: event.text,
        tone: "info",
      });

    case "queueDepth":
      return { ...state, queueDepth: event.depth };

    case "spend":
      return { ...state, tokensToday: event.tokensToday, tokenCeiling: event.ceiling };

    default:
      return state;
  }
};

export const applyEnvelope = (state: UiState, envelope: Envelope): UiState => {
  if (envelope.id <= state.lastEventId) return state;
  return { ...applyEvent(state, envelope.event), lastEventId: envelope.id };
};

export const seedRoom = (
  state: UiState,
  roomId: string,
  messages: readonly Message[],
): UiState =>
  withRoom(state, roomId, { ...roomOf(state, roomId), messages });

const omit = (
  record: Readonly<Record<string, string>>,
  key: string,
): Readonly<Record<string, string>> => {
  const next = { ...record };
  delete next[key];
  return next;
};
