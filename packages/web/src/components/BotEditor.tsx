import { useEffect, useState } from "react";
import { api } from "../api.js";
import type { BotDetail } from "../types.js";

type Props = {
  readonly botId: string;
  readonly onClose: () => void;
  readonly onSaved: () => void;
  readonly onDeleted: () => void;
};

const MODELS = ["claude-sonnet-5", "claude-opus-5", "claude-haiku-4-5"] as const;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export const BotEditor = ({ botId, onClose, onSaved, onDeleted }: Props) => {
  const [bot, setBot] = useState<BotDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .bot(botId)
      .then((b) => {
        if (live) setBot(b);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [botId]);

  if (error !== null) return <div className="editor"><p className="notice alert">{error}</p></div>;
  if (bot === null) return <div className="editor"><p className="empty">Loading…</p></div>;

  const patch = (fields: Partial<BotDetail>) => setBot({ ...bot, ...fields });

  const save = () => {
    setSaving(true);
    api
      .updateBot(bot.id, {
        name: bot.name,
        model: bot.model,
        effort: bot.effort,
        noisiness: bot.noisiness,
        cooldownTurns: bot.cooldownTurns,
        avatarColor: bot.avatarColor,
        personality: bot.personality,
      })
      .then(() => onSaved())
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setSaving(false));
  };

  return (
    <div className="editor">
      <div className="grid">
        <div className="row2">
          <div className="field">
            <label htmlFor="name">Name</label>
            <input
              id="name"
              value={bot.name}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="color">Colour</label>
            <input
              id="color"
              type="color"
              value={bot.avatarColor}
              onChange={(e) => patch({ avatarColor: e.target.value })}
            />
          </div>
        </div>

        <div className="row2">
          <div className="field">
            <label htmlFor="model">Model</label>
            <select
              id="model"
              value={bot.model}
              onChange={(e) => patch({ model: e.target.value })}
            >
              {MODELS.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
            <span className="note">Sonnet for chatter, Opus for real work.</span>
          </div>
          <div className="field">
            <label htmlFor="effort">Effort</label>
            <select
              id="effort"
              value={bot.effort}
              onChange={(e) => patch({ effort: e.target.value })}
            >
              {EFFORTS.map((e) => (
                <option key={e} value={e}>{e}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="row2">
          <div className="field">
            <label htmlFor="noisiness">Noisiness · {bot.noisiness.toFixed(2)}</label>
            <input
              id="noisiness"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={bot.noisiness}
              onChange={(e) => patch({ noisiness: Number(e.target.value) })}
            />
            <span className="note">
              0 is a lurker who speaks only when named. 1 never passes a turn.
            </span>
          </div>
          <div className="field">
            <label htmlFor="cooldown">Cooldown turns</label>
            <input
              id="cooldown"
              type="number"
              min={0}
              max={20}
              value={bot.cooldownTurns}
              onChange={(e) => patch({ cooldownTurns: Number(e.target.value) })}
            />
            <span className="note">Turns this bot must sit out after speaking.</span>
          </div>
        </div>

        <div className="field">
          <label htmlFor="personality">personality.md</label>
          <textarea
            id="personality"
            rows={16}
            value={bot.personality}
            onChange={(e) => patch({ personality: e.target.value })}
          />
          <span className="note">
            {bot.personality.length} chars · roughly {Math.ceil(bot.personality.length / 4)} tokens ·
            also editable at {bot.workspacePath.replace("/workspaces/", "/bots/")}/personality.md
          </span>
        </div>

        {bot.memory.trim() !== "" && (
          <div className="field">
            <label>memory.md (the bot writes this)</label>
            <textarea rows={6} value={bot.memory} readOnly />
          </div>
        )}

        <div className="actions">
          <button onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
          <button onClick={onClose}>Close</button>
          <span style={{ flex: 1 }} />
          <button
            className="halt"
            onClick={() => {
              if (!confirm(`Delete ${bot.name}? Its files stay on disk.`)) return;
              api.deleteBot(bot.id).then(onDeleted).catch(() => undefined);
            }}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
};
