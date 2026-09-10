import type { Bot } from "../types.js";
import type { Connection } from "../useStream.js";

type Props = {
  readonly bots: readonly Bot[];
  readonly selected: string | null;
  readonly activeBot: string | null;
  readonly connection: Connection;
  readonly onSelect: (id: string) => void;
  readonly onCreate: () => void;
  readonly onEdit: () => void;
};

export const BotSidebar = ({
  bots, selected, activeBot, connection, onSelect, onCreate, onEdit,
}: Props) => (
  <aside className="sidebar">
    <div className="brand">
      <h1>Howdy</h1>
      <span className={`dot ${connection}`} title={connection} />
    </div>

    <div className="bots">
      {bots.length === 0 ? (
        <p className="empty">No bots yet.</p>
      ) : (
        bots.map((bot) => (
          <button
            key={bot.id}
            className={`bot ${bot.id === selected ? "active" : ""}`}
            onClick={() => onSelect(bot.id)}
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
    </div>

    <div className="sidebar-foot">
      <button onClick={onCreate}>New bot</button>
      <button onClick={onEdit} disabled={selected === null}>
        Configure
      </button>
    </div>
  </aside>
);
