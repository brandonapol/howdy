import { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";
import { useStream } from "./useStream.js";
import { emptyRoom, seedRoom } from "./state.js";
import type { Bot } from "./types.js";
import { BotSidebar } from "./components/BotSidebar.js";
import { Transcript } from "./components/Transcript.js";
import { Composer } from "./components/Composer.js";
import { BotEditor } from "./components/BotEditor.js";
import { Meter } from "./components/Meter.js";

const ROOM = "general";

export const App = () => {
  const { state, connection, patch } = useStream();
  const [bots, setBots] = useState<readonly Bot[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshBots = useCallback(
    () =>
      api
        .bots()
        .then((list) => {
          setBots(list);
          setSelected((current) => current ?? list[0]?.id ?? null);
          return list;
        })
        .catch((e: unknown) => {
          setError(e instanceof Error ? e.message : String(e));
          return [] as Bot[];
        }),
    [],
  );

  useEffect(() => {
    void refreshBots();
    api
      .messages(ROOM)
      .then((messages) => patch((s) => seedRoom(s, ROOM, messages)))
      .catch(() => undefined);
    api
      .health()
      .then((h) =>
        patch((s) => ({
          ...s,
          queueDepth: h.queueDepth,
          tokensToday: h.spend.tokens,
          tokenCeiling: h.tokenCeiling,
        })),
      )
      .catch(() => undefined);
  }, [refreshBots, patch]);

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

  const room = state.rooms[ROOM] ?? emptyRoom;
  const busy = room.activeBot !== null || state.queueDepth > 0;
  const current = bots.find((b) => b.id === selected) ?? null;

  const send = (text: string) => {
    if (selected === null) return;
    api.send(ROOM, text, selected).catch((e: unknown) => {
      setError(e instanceof Error ? e.message : String(e));
    });
  };

  return (
    <div className="app">
      <BotSidebar
        bots={bots}
        selected={selected}
        activeBot={room.activeBot}
        connection={connection}
        onSelect={(id) => {
          setSelected(id);
          setEditing(false);
        }}
        onCreate={() => {
          const name = prompt("Name your bot");
          if (name === null || name.trim() === "") return;
          api
            .createBot(name.trim())
            .then((bot) =>
              refreshBots().then(() => {
                setSelected(bot.id);
                setEditing(true);
              }),
            )
            .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
        }}
        onEdit={() => setEditing((v) => !v)}
      />

      <main className="main">
        <div className="topbar">
          <span className="title">
            {editing ? `Configuring ${current?.name ?? ""}` : current?.name ?? "Howdy"}
          </span>
          <span className="spacer" />
          {state.queueDepth > 0 && (
            <span className="notice">queue {state.queueDepth}</span>
          )}
          <Meter label="tokens today" used={state.tokensToday} ceiling={state.tokenCeiling} />
          <button
            className="halt"
            disabled={!busy}
            onClick={() => void api.halt(ROOM).catch(() => undefined)}
          >
            Halt
          </button>
        </div>

        {error !== null && (
          <div className="notices" style={{ padding: "8px 16px" }}>
            <div className="notice alert" onClick={() => setError(null)}>
              {error} (click to dismiss)
            </div>
          </div>
        )}

        {editing && selected !== null ? (
          <BotEditor
            botId={selected}
            onClose={() => setEditing(false)}
            onSaved={() => {
              void refreshBots();
              setEditing(false);
            }}
            onDeleted={() => {
              setEditing(false);
              setSelected(null);
              void refreshBots();
            }}
          />
        ) : (
          <>
            <Transcript room={room} bots={bots} notices={state.notices} />
            <Composer
              disabled={selected === null}
              placeholder={
                selected === null ? "Create a bot first" : `Message ${current?.name ?? ""}`
              }
              onSend={send}
            />
          </>
        )}
      </main>
    </div>
  );
};
