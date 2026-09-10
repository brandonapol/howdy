import { useState } from "react";
import type { Bot } from "../types.js";

type Props = {
  readonly bots: readonly Bot[];
  readonly onCancel: () => void;
  readonly onCreate: (input: {
    name: string;
    goal: string | null;
    stepMode: boolean;
    ceilings: Record<string, number>;
    participants: { botId: string; noisiness: number; cooldownTurns: number }[];
  }) => void;
};

type Row = { readonly botId: string; readonly on: boolean; readonly noisiness: number; readonly cooldownTurns: number };

export const PartyDialog = ({ bots, onCancel, onCreate }: Props) => {
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [stepMode, setStepMode] = useState(false);
  const [maxTurns, setMaxTurns] = useState(20);
  const [maxTokens, setMaxTokens] = useState(100_000);
  const [minutes, setMinutes] = useState(10);
  const [rows, setRows] = useState<readonly Row[]>(
    bots.map((b) => ({ botId: b.id, on: false, noisiness: b.noisiness, cooldownTurns: b.cooldownTurns })),
  );

  const chosen = rows.filter((r) => r.on);
  const nameOf = (id: string) => bots.find((b) => b.id === id)?.name ?? id;
  const patch = (botId: string, fields: Partial<Row>) =>
    setRows(rows.map((r) => (r.botId === botId ? { ...r, ...fields } : r)));

  return (
    <div className="scrim" role="dialog" aria-modal="true" aria-labelledby="party-title">
      <div className="prompt wide">
        <h2 id="party-title">Start a party</h2>

        <div className="field">
          <label htmlFor="party-name">Name</label>
          <input
            id="party-name"
            value={name}
            placeholder="deploy post-mortem"
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="party-goal">Goal (optional)</label>
          <input
            id="party-goal"
            value={goal}
            placeholder="work out why the argo sync wedged"
            onChange={(e) => setGoal(e.target.value)}
          />
          <span className="note">Given to every bot in the room.</span>
        </div>

        <div className="field">
          <label>Cast</label>
          {bots.length === 0 && <span className="note">Make some bots first.</span>}
          <div className="cast">
            {rows.map((row) => (
              <div className={`cast-row ${row.on ? "on" : ""}`} key={row.botId}>
                <label className="pick">
                  <input
                    type="checkbox"
                    checked={row.on}
                    onChange={(e) => patch(row.botId, { on: e.target.checked })}
                  />
                  <span>{nameOf(row.botId)}</span>
                </label>
                <label className="slider">
                  <span>noise {row.noisiness.toFixed(2)}</span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    disabled={!row.on}
                    value={row.noisiness}
                    onChange={(e) => patch(row.botId, { noisiness: Number(e.target.value) })}
                  />
                </label>
                <label className="slider narrow">
                  <span>cooldown</span>
                  <input
                    type="number"
                    min={0}
                    max={10}
                    disabled={!row.on}
                    value={row.cooldownTurns}
                    onChange={(e) => patch(row.botId, { cooldownTurns: Number(e.target.value) })}
                  />
                </label>
              </div>
            ))}
          </div>
        </div>

        <div className="field">
          <label>Ceilings</label>
          <div className="row3">
            <label className="slider narrow">
              <span>turns</span>
              <input type="number" min={1} max={500} value={maxTurns}
                onChange={(e) => setMaxTurns(Number(e.target.value))} />
            </label>
            <label className="slider narrow">
              <span>tokens</span>
              <input type="number" min={1000} step={10_000} value={maxTokens}
                onChange={(e) => setMaxTokens(Number(e.target.value))} />
            </label>
            <label className="slider narrow">
              <span>minutes</span>
              <input type="number" min={1} max={120} value={minutes}
                onChange={(e) => setMinutes(Number(e.target.value))} />
            </label>
          </div>
          <span className="note">
            Whichever is hit first stops the room. Speaking to it resets the window.
          </span>
        </div>

        <label className="pick">
          <input type="checkbox" checked={stepMode} onChange={(e) => setStepMode(e.target.checked)} />
          <span>Step mode — hold every turn until I ask for it</span>
        </label>

        <div className="actions">
          <button
            className="primary"
            disabled={chosen.length < 2 || name.trim() === ""}
            onClick={() =>
              onCreate({
                name: name.trim(),
                goal: goal.trim() === "" ? null : goal.trim(),
                stepMode,
                ceilings: {
                  maxTurns,
                  maxTokens,
                  maxWallClockMs: minutes * 60_000,
                },
                participants: chosen.map((r) => ({
                  botId: r.botId,
                  noisiness: r.noisiness,
                  cooldownTurns: r.cooldownTurns,
                })),
              })
            }
          >
            Start
          </button>
          <button onClick={onCancel}>Cancel</button>
          <span style={{ flex: 1 }} />
          <span className="note">
            {chosen.length < 2 ? "Pick at least two bots" : `${chosen.length} bots`}
          </span>
        </div>
      </div>
    </div>
  );
};
