import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import type { Room, Routine, Schedule } from "../types.js";

type Props = {
  readonly rooms: readonly Room[];
  readonly onClose: () => void;
};

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const when = (r: Routine): string =>
  r.enabled && r.nextRunAt !== null
    ? `next ${new Date(r.nextRunAt).toLocaleString()}`
    : "paused";

export const Routines = ({ rooms, onClose }: Props) => {
  const [routines, setRoutines] = useState<readonly Routine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [roomId, setRoomId] = useState(rooms[0]?.id ?? "");
  const [kind, setKind] = useState<Schedule["kind"]>("daily");
  const [hour, setHour] = useState(8);
  const [minute, setMinute] = useState(30);
  const [weekday, setWeekday] = useState(1);
  const [minutes, setMinutes] = useState(60);

  const refresh = useCallback(
    () =>
      api
        .routines()
        .then(setRoutines)
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e))),
    [],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const schedule = (): Schedule =>
    kind === "interval"
      ? { kind: "interval", minutes }
      : kind === "weekly"
        ? { kind: "weekly", weekday, hour, minute }
        : { kind: "daily", hour, minute };

  return (
    <div className="editor">
      <div className="grid">
        <h2 style={{ margin: 0, fontSize: 17 }}>Routines</h2>
        <p className="note">
          A routine posts a prompt into a room on a schedule. Every firing is subject
          to the same ceilings as anything else, and is skipped if the daily or weekly
          budget is already spent.
        </p>

        {error !== null && <p className="notice alert">{error}</p>}

        {routines.length > 0 && (
          <table className="tl">
            <tbody>
              {routines.map((r) => (
                <tr key={r.id} className={r.enabled ? "" : "bad"}>
                  <td className="tl-who">{r.name}</td>
                  <td className="tl-num">{r.description}</td>
                  <td className="tl-text">{when(r)}</td>
                  <td className="tl-text">{r.lastStatus ?? ""}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <button onClick={() => void api.runRoutine(r.id).then(refresh)}>Run</button>{" "}
                    <button
                      onClick={() =>
                        void api.updateRoutine(r.id, { enabled: !r.enabled }).then(refresh)
                      }
                    >
                      {r.enabled ? "Pause" : "Resume"}
                    </button>{" "}
                    <button
                      className="halt"
                      onClick={() => void api.deleteRoutine(r.id).then(refresh)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="field">
          <label htmlFor="r-name">New routine</label>
          <input
            id="r-name"
            value={name}
            placeholder="morning PR sweep"
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="r-prompt">What to ask</label>
          <textarea
            id="r-prompt"
            rows={3}
            value={prompt}
            placeholder="check my open PRs and tell me anything that needs a decision"
            onChange={(e) => setPrompt(e.target.value)}
          />
        </div>

        <div className="row3">
          <div className="field">
            <label htmlFor="r-room">Room</label>
            <select id="r-room" value={roomId} onChange={(e) => setRoomId(e.target.value)}>
              {rooms.map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="r-kind">Schedule</label>
            <select
              id="r-kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as Schedule["kind"])}
            >
              <option value="daily">daily</option>
              <option value="weekly">weekly</option>
              <option value="interval">every N minutes</option>
            </select>
          </div>
          <div className="field">
            {kind === "interval" ? (
              <>
                <label htmlFor="r-min">Minutes</label>
                <input
                  id="r-min" type="number" min={5} max={1440} value={minutes}
                  onChange={(e) => setMinutes(Number(e.target.value))}
                />
              </>
            ) : (
              <>
                <label htmlFor="r-time">Time</label>
                <input
                  id="r-time" type="time"
                  value={`${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`}
                  onChange={(e) => {
                    const [h, m] = e.target.value.split(":");
                    setHour(Number(h ?? 8));
                    setMinute(Number(m ?? 0));
                  }}
                />
              </>
            )}
          </div>
        </div>

        {kind === "weekly" && (
          <div className="field">
            <label htmlFor="r-day">Day</label>
            <select id="r-day" value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>
              {WEEKDAYS.map((d, i) => (
                <option key={d} value={i}>{d}</option>
              ))}
            </select>
          </div>
        )}

        <div className="actions">
          <button
            className="primary"
            disabled={name.trim() === "" || prompt.trim() === "" || roomId === ""}
            onClick={() => {
              api
                .createRoutine({
                  name: name.trim(),
                  roomId,
                  prompt: prompt.trim(),
                  schedule: schedule(),
                })
                .then(() => {
                  setName("");
                  setPrompt("");
                  return refresh();
                })
                .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
            }}
          >
            Add routine
          </button>
          <button onClick={onClose}>Close</button>
          {rooms.length === 0 && <span className="note">Make a party first.</span>}
        </div>
      </div>
    </div>
  );
};
