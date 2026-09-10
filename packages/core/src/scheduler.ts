import { advanceClock, applyUsage, exceeded, describeBreach, resetWindow } from "./budget.js";
import { defaultDegeneracyConfig, inspect } from "./degeneracy.js";
import type { DegeneracyConfig } from "./degeneracy.js";
import { nextRng } from "./rng.js";
import type {
  BotId,
  Effect,
  HaltReason,
  ParticipantState,
  RoomEvent,
  RoomMessage,
  RoomState,
  Step,
} from "./types.js";

const RECENT_LIMIT = 50;

const appendRecent = (
  recent: readonly RoomMessage[],
  message: RoomMessage,
): readonly RoomMessage[] =>
  recent.some((m) => m.id === message.id)
    ? recent
    : [...recent, message].slice(-RECENT_LIMIT);

const halt = (state: RoomState, reason: HaltReason): Step => {
  const abort: readonly Effect[] =
    state.status.kind === "running"
      ? [{ kind: "abortTurn", speaker: state.status.speaker }]
      : [];
  return [
    { ...state, status: { kind: "halted", reason } },
    [...abort, { kind: "halted", reason }],
  ];
};

const lastBotSpeaker = (recent: readonly RoomMessage[]): BotId | null => {
  const last = recent[recent.length - 1];
  if (last === undefined) return null;
  return last.speaker.kind === "bot" ? last.speaker.botId : null;
};

const offCooldown = (p: ParticipantState, turnIndex: number): boolean =>
  p.lastSpokeAtTurn === null || turnIndex - p.lastSpokeAtTurn >= p.cooldownTurns;

const decayNoisiness = (
  participants: readonly ParticipantState[],
): readonly ParticipantState[] =>
  participants.map((p) => ({ ...p, noisiness: p.noisiness / 2 }));

const selectSpeaker = (state: RoomState): Step => {
  const breach = exceeded(state.budget);
  if (breach !== null) return halt(state, { kind: "budget", breach });

  const byId = new Map(state.participants.map((p) => [p.botId, p]));

  const mention = state.pendingMentions.find((id) => byId.has(id));
  if (mention !== undefined) {
    return dispatch(
      { ...state, pendingMentions: state.pendingMentions.filter((id) => id !== mention) },
      mention,
    );
  }

  const excluded = state.participants.length > 1 ? lastBotSpeaker(state.recent) : null;
  const eligible = state.participants
    .filter((p) => p.botId !== excluded)
    .filter((p) => offCooldown(p, state.turnIndex));

  let rngState = state.rngState;
  let best: { readonly botId: BotId; readonly margin: number } | null = null;
  for (const p of eligible) {
    const roll = nextRng(rngState);
    rngState = roll.state;
    const margin = p.noisiness - roll.value;
    if (margin > 0 && (best === null || margin > best.margin)) {
      best = { botId: p.botId, margin };
    }
  }

  const settled: RoomState = { ...state, rngState };
  if (best === null) return [{ ...settled, status: { kind: "idle" } }, []];
  return dispatch(settled, best.botId);
};

const dispatch = (state: RoomState, speaker: BotId): Step =>
  state.stepMode
    ? [{ ...state, status: { kind: "awaitingTurn", speaker } }, []]
    : [
        { ...state, status: { kind: "running", speaker } },
        [{ kind: "runTurn", speaker, turnIndex: state.turnIndex }],
      ];

const afterMessage = (
  state: RoomState,
  config: DegeneracyConfig,
): Step => {
  const verdict = inspect(state.recent, config);

  if (verdict.kind === "halt") {
    return halt(state, {
      kind: "degeneracy",
      detector: verdict.detector,
      detail: verdict.detail,
    });
  }

  if (verdict.kind === "decay") {
    const decayCount = state.decayCount + 1;
    if (decayCount >= 2) {
      return halt(
        { ...state, decayCount },
        { kind: "degeneracy", detector: verdict.detector, detail: verdict.detail },
      );
    }
    const [next, effects] = selectSpeaker({
      ...state,
      decayCount,
      participants: decayNoisiness(state.participants),
    });
    return [
      next,
      [
        { kind: "announce", text: `Quieting down: ${verdict.detail}.` },
        ...effects,
      ],
    ];
  }

  return selectSpeaker(state);
};

export const step = (
  state: RoomState,
  event: RoomEvent,
  config: DegeneracyConfig = defaultDegeneracyConfig,
): Step => {
  switch (event.kind) {
    case "handoff": {
      if (state.status.kind === "halted") return [state, []];
      const known = state.participants.some((p) => p.botId === event.to);
      if (!known) {
        return [state, [{ kind: "announce", text: `Cannot hand off: no such bot in this room.` }]];
      }
      if (state.pendingMentions.includes(event.to)) return [state, []];
      return [
        { ...state, pendingMentions: [...state.pendingMentions, event.to] },
        [],
      ];
    }

    case "goalReached":
      return state.status.kind === "halted"
        ? [state, []]
        : halt(state, { kind: "complete", summary: event.summary });

    case "haltRequested":
      return state.status.kind === "halted"
        ? [state, []]
        : halt(state, { kind: "manual" });

    case "resumeRequested": {
      if (state.status.kind !== "halted") return [state, []];
      if (state.status.reason.kind === "complete") {
        return [
          state,
          [{ kind: "announce", text: "This room already reached its goal." }],
        ];
      }
      if (state.status.reason.kind === "budget") {
        return [
          state,
          [
            {
              kind: "announce",
              text: `Cannot resume: ${describeBreach(state.status.reason.breach)}. Raise the ceiling first.`,
            },
          ],
        ];
      }
      return selectSpeaker({ ...state, status: { kind: "idle" }, decayCount: 0 });
    }

    case "humanMessage": {
      if (state.status.kind === "halted") {
        const reason = state.status.reason.kind;
        const machineStopped = reason === "budget" || reason === "degeneracy";
        if (!machineStopped) return [state, []];
      }
      return selectSpeaker({
        ...state,
        recent: appendRecent(state.recent, event.message),
        turnIndex: state.turnIndex + 1,
        pendingMentions: [...state.pendingMentions, ...event.mentions],
        decayCount: 0,
        status: { kind: "idle" },
        budget: resetWindow(state.budget, event.message.createdAt),
        participants: state.participants.map((p) => ({
          ...p,
          noisiness: p.baseNoisiness,
        })),
      });
    }

    case "turnCompleted": {
      if (state.status.kind === "halted") return [state, []];
      const speaker =
        event.message.speaker.kind === "bot" ? event.message.speaker.botId : null;
      const turnIndex = state.turnIndex + 1;
      return afterMessage(
        {
          ...state,
          recent: appendRecent(state.recent, event.message),
          turnIndex,
          budget: applyUsage(state.budget, event.message.usage),
          participants: state.participants.map((p) =>
            p.botId === speaker ? { ...p, lastSpokeAtTurn: turnIndex } : p,
          ),
        },
        config,
      );
    }

    case "turnFailed": {
      if (state.status.kind === "halted") return [state, []];
      const turnIndex = state.turnIndex + 1;
      const [next, effects] = selectSpeaker({
        ...state,
        turnIndex,
        budget: { ...state.budget, turnsUsed: state.budget.turnsUsed + 1 },
        participants: state.participants.map((p) =>
          p.botId === event.speaker ? { ...p, lastSpokeAtTurn: turnIndex } : p,
        ),
      });
      return [
        next,
        [
          { kind: "announce", text: `Turn failed: ${event.detail}` },
          ...effects,
        ],
      ];
    }

    case "stepRequested": {
      if (state.status.kind !== "awaitingTurn") return [state, []];
      const speaker = state.status.speaker;
      return [
        { ...state, status: { kind: "running", speaker } },
        [{ kind: "runTurn", speaker, turnIndex: state.turnIndex }],
      ];
    }

    case "clockTick": {
      if (state.status.kind === "halted") return [state, []];
      const budget = advanceClock(state.budget, event.now);
      const breach = exceeded(budget);
      const ticked = { ...state, budget };
      return breach === null ? [ticked, []] : halt(ticked, { kind: "budget", breach });
    }
  }
};
