import type { Bot, Room } from "../types.js";
import type { Connection } from "../useStream.js";

export type Selection =
  | { readonly kind: "bot"; readonly botId: string }
  | { readonly kind: "room"; readonly roomId: string };

type Props = {
  readonly bots: readonly Bot[];
  readonly rooms: readonly Room[];
  readonly selection: Selection | null;
  readonly activeBot: string | null;
  readonly connection: Connection;
  readonly onSelect: (selection: Selection) => void;
  readonly onNewBot: () => void;
  readonly onNewParty: () => void;
  readonly onConfigure: () => void;
};

const same = (a: Selection | null, b: Selection): boolean =>
  a !== null &&
  a.kind === b.kind &&
  (a.kind === "bot" && b.kind === "bot"
    ? a.botId === b.botId
    : a.kind === "room" && b.kind === "room"
      ? a.roomId === b.roomId
      : false);

export const Sidebar = ({
  bots, rooms, selection, activeBot, connection, onSelect, onNewBot, onNewParty, onConfigure,
}: Props) => (
  <aside className="sidebar">
    <div className="brand">
      <h1>Howdy</h1>
      <span className={`dot ${connection}`} title={connection} />
    </div>

    <div className="bots">
      <p className="section">Bots</p>
      {bots.length === 0 ? (
        <p className="empty">No bots yet.</p>
      ) : (
        bots.map((bot) => (
          <button
            key={bot.id}
            className={`bot ${same(selection, { kind: "bot", botId: bot.id }) ? "active" : ""}`}
            onClick={() => onSelect({ kind: "bot", botId: bot.id })}
          >
            <span className="swatch" style={{ background: bot.avatarColor }} />
            <span className="meta">
              <span className="name">{bot.name}</span>
              <span className="sub">
                {bot.id === activeBot ? "thinking…" : bot.model.replace("claude-", "")}
              </span>
            </span>
          </button>
        ))
      )}

      <p className="section">Parties</p>
      {rooms.length === 0 ? (
        <p className="empty">No parties yet.</p>
      ) : (
        rooms.map((room) => (
          <button
            key={room.id}
            className={`bot ${same(selection, { kind: "room", roomId: room.id }) ? "active" : ""}`}
            onClick={() => onSelect({ kind: "room", roomId: room.id })}
          >
            <span className="swatch stack">
              {room.participants.slice(0, 4).map((id) => (
                <i key={id} style={{ background: bots.find((b) => b.id === id)?.avatarColor ?? "#888" }} />
              ))}
            </span>
            <span className="meta">
              <span className="name">{room.name}</span>
              <span className="sub">
                {room.status.kind === "halted" ? "halted" : `${room.participants.length} bots`}
              </span>
            </span>
          </button>
        ))
      )}
    </div>

    <div className="sidebar-foot">
      <button onClick={onNewBot}>New bot</button>
      <button onClick={onNewParty} disabled={bots.length < 2}>New party</button>
      <button onClick={onConfigure} disabled={selection?.kind !== "bot"}>Configure</button>
    </div>
  </aside>
);
