import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api.js";
import { useStream } from "./useStream.js";
import { emptyRoom, seedRoom } from "./state.js";
import type { Bot, Room } from "./types.js";
import { Sidebar } from "./components/Sidebar.js";
import type { Selection } from "./components/Sidebar.js";
import { Transcript } from "./components/Transcript.js";
import { Composer } from "./components/Composer.js";
import { BotEditor } from "./components/BotEditor.js";
import { PermissionPrompt } from "./components/PermissionPrompt.js";
import { PartyDialog } from "./components/PartyDialog.js";
import { Timeline } from "./components/Timeline.js";
import { Routines } from "./components/Routines.js";
import { Meter } from "./components/Meter.js";

const soloRoom = (bot: Bot): string => `solo-${bot.slug}`;

const describeHalt = (room: Room | undefined, fallback: string): string => {
  const reason = room?.status.kind === "halted" ? room.status.reason : null;
  if (reason === null) return fallback;
  switch (reason.kind) {
    case "manual": return "halted by you";
    case "budget": return `halted: ${reason.breach.kind} ceiling`;
    case "degeneracy": return `halted: ${reason.detector}`;
    case "error": return `halted: ${reason.detail}`;
  }
};

export const App = () => {
  const { state, connection, patch } = useStream();
  const [bots, setBots] = useState<readonly Bot[]>([]);
  const [rooms, setRooms] = useState<readonly Room[]>([]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [editing, setEditing] = useState(false);
  const [partying, setPartying] = useState(false);
  const [showTimeline, setShowTimeline] = useState(false);
  const [showRoutines, setShowRoutines] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [nextBots, nextRooms] = await Promise.all([api.bots(), api.rooms()]);
      setBots(nextBots);
      setRooms(nextRooms.filter((r) => r.kind === "party"));
      setSelection((current) =>
        current ?? (nextBots[0] === undefined ? null : { kind: "bot", botId: nextBots[0].id }),
      );
      return nextBots;
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      return [] as Bot[];
    }
  }, []);

  useEffect(() => {
    void refresh();
    api
      .health()
      .then((h) =>
        patch((s) => ({
          ...s, queueDepth: h.queueDepth, tokensToday: h.spend.tokens, tokenCeiling: h.tokenCeiling,
        })),
      )
      .catch(() => undefined);
  }, [refresh, patch]);

  const bot = useMemo(
    () => (selection?.kind === "bot" ? bots.find((b) => b.id === selection.botId) ?? null : null),
    [selection, bots],
  );
  const party = useMemo(
    () => (selection?.kind === "room" ? rooms.find((r) => r.id === selection.roomId) ?? null : null),
    [selection, rooms],
  );
  const roomId = bot !== null ? soloRoom(bot) : (party?.id ?? null);

  useEffect(() => {
    if (roomId === null) return;
    let live = true;
    api
      .messages(roomId)
      .then((messages) => {
        if (live) patch((s) => seedRoom(s, roomId, messages));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [roomId, patch]);

  useEffect(() => {
    let armed = 0;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") {
        armed = 0;
        return;
      }
      armed += 1;
      if (armed >= 2) {
        armed = 0;
        void api.panic().catch(() => undefined);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const room = roomId === null ? emptyRoom : (state.rooms[roomId] ?? emptyRoom);
  const busy = room.activeBot !== null || state.queueDepth > 0;
  const halted = room.status.kind === "halted";
  const awaiting = room.status.kind === "awaitingTurn";
  const pendingPermission = state.permissions[0] ?? null;
  const notices = state.notices.filter((n) => n.roomId === roomId || n.roomId === "*");

  const send = (text: string) => {
    if (roomId === null) return;
    api.send(roomId, text, bot?.id).catch((e: unknown) => {
      setError(e instanceof Error ? e.message : String(e));
    });
  };

  const decide = useCallback(
    (id: string, allowed: boolean, always: boolean) => {
      patch((s) => ({ ...s, permissions: s.permissions.filter((p) => p.id !== id) }));
      api.decidePermission(id, allowed, always).catch(() => undefined);
    },
    [patch],
  );

  return (
    <div className="app">
      {pendingPermission !== null && (
        <PermissionPrompt
          request={pendingPermission}
          queued={state.permissions.length}
          bots={bots}
          onDecide={decide}
        />
      )}

      {partying && (
        <PartyDialog
          bots={bots}
          onCancel={() => setPartying(false)}
          onCreate={(input) => {
            api
              .createRoom({ ...input, kind: "party" })
              .then((created) => {
                setPartying(false);
                setSelection({ kind: "room", roomId: created.id });
                return refresh();
              })
              .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
          }}
        />
      )}

      <Sidebar
        bots={bots}
        rooms={rooms}
        selection={selection}
        activeBot={room.activeBot}
        connection={connection}
        onSelect={(next) => {
          setSelection(next);
          setEditing(false);
          setShowTimeline(false);
          setShowRoutines(false);
        }}
        onNewBot={() => {
          const name = prompt("Name your bot");
          if (name === null || name.trim() === "") return;
          api
            .createBot(name.trim())
            .then((created) =>
              refresh().then(() => {
                setSelection({ kind: "bot", botId: created.id });
                setEditing(true);
              }),
            )
            .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
        }}
        onNewParty={() => setPartying(true)}
        onConfigure={() => setEditing((v) => !v)}
        onRoutines={() => {
          setShowRoutines((v) => !v);
          setEditing(false);
        }}
      />

      <main className="main">
        <div className="topbar">
          <span className="title">
            {editing ? `Configuring ${bot?.name ?? ""}` : (bot?.name ?? party?.name ?? "Howdy")}
          </span>
          <span className="spacer" />
          {state.queueDepth > 0 && <span className="notice">queue {state.queueDepth}</span>}
          <Meter label="tokens today" used={state.tokensToday} ceiling={state.tokenCeiling} />
          <button
            className="halt"
            disabled={!busy}
            onClick={() => {
              if (roomId !== null) void api.halt(roomId).catch(() => undefined);
            }}
          >
            Halt
          </button>
        </div>

        {party !== null && !editing && (
          <div className="roombar">
            <span className={`state ${room.status.kind}`}>
              {halted ? describeHalt({ ...party, status: room.status }, "halted") : room.status.kind}
            </span>
            {party.goal !== null && <span className="goal">{party.goal}</span>}
            <span className="spacer" style={{ flex: 1 }} />
            <Meter label="turns" used={room.turnsUsed} ceiling={room.maxTurns || party.ceilings.maxTurns} />
            <Meter label="room tokens" used={room.tokensUsed} ceiling={room.maxTokens || party.ceilings.maxTokens} />
            {awaiting && (
              <button className="primary" onClick={() => void api.advance(party.id)}>
                Next turn
              </button>
            )}
            {halted && (
              <button onClick={() => void api.resume(party.id).catch(() => undefined)}>
                Resume
              </button>
            )}
            <button onClick={() => setShowTimeline((v) => !v)}>
              {showTimeline ? "Transcript" : "Timeline"}
            </button>
          </div>
        )}

        {error !== null && (
          <div className="notices" style={{ padding: "8px 16px" }}>
            <div className="notice alert" onClick={() => setError(null)}>
              {error} (click to dismiss)
            </div>
          </div>
        )}

        {showRoutines ? (
          <Routines rooms={rooms} onClose={() => setShowRoutines(false)} />
        ) : editing && bot !== null ? (
          <BotEditor
            botId={bot.id}
            onClose={() => setEditing(false)}
            onSaved={() => {
              void refresh();
              setEditing(false);
            }}
            onDeleted={() => {
              setEditing(false);
              setSelection(null);
              void refresh();
            }}
          />
        ) : showTimeline && party !== null ? (
          <Timeline roomId={party.id} bots={bots} refreshKey={room.messages.length} />
        ) : (
          <>
            <Transcript room={room} bots={bots} notices={notices} />
            <Composer
              disabled={roomId === null}
              placeholder={
                roomId === null
                  ? "Create a bot first"
                  : bot !== null
                    ? `Message ${bot.name}`
                    : halted
                      ? "Say something to restart the room"
                      : "Say something to the room"
              }
              onSend={send}
            />
          </>
        )}
      </main>
    </div>
  );
};
