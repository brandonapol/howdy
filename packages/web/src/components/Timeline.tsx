import { useEffect, useState } from "react";
import { api } from "../api.js";
import type { Bot, TimelineEntry } from "../types.js";

type Props = {
  readonly roomId: string;
  readonly bots: readonly Bot[];
  readonly refreshKey: number;
};

const duration = (ms: number | null | undefined): string =>
  ms === null || ms === undefined ? "—" : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;

const tokens = (n: number | null | undefined): string =>
  n === null || n === undefined ? "—" : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

export const Timeline = ({ roomId, bots, refreshKey }: Props) => {
  const [entries, setEntries] = useState<readonly TimelineEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .timeline(roomId)
      .then((next) => {
        if (live) setEntries(next);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [roomId, refreshKey]);

  if (error !== null) return <div className="timeline"><p className="notice alert">{error}</p></div>;
  if (entries.length === 0) {
    return <div className="timeline"><p className="empty">Nothing has happened here yet.</p></div>;
  }

  const spend = entries.reduce((acc, e) => acc + (e.tokens ?? 0), 0);
  const failures = entries.filter((e) => e.kind === "turn" && e.status === "failed").length;

  return (
    <div className="timeline">
      <div className="tl-summary">
        <span>{entries.filter((e) => e.kind === "turn").length} turns</span>
        <span>{tokens(spend)} tokens</span>
        {failures > 0 && <span className="bad">{failures} failed</span>}
      </div>

      <table className="tl">
        <tbody>
          {entries.map((entry, i) => {
            if (entry.kind === "note") {
              return (
                <tr className="tl-note" key={`n${i}`}>
                  <td colSpan={5}>{entry.content}</td>
                </tr>
              );
            }
            const bot = bots.find((b) => b.id === entry.botId);
            return (
              <tr className={entry.status === "failed" ? "bad" : ""} key={`t${i}`}>
                <td className="tl-who">
                  <span className="swatch" style={{ background: bot?.avatarColor ?? "#888" }} />
                  {bot?.name ?? "gone"}
                </td>
                <td className="tl-num">{duration(entry.durationMs)}</td>
                <td className="tl-num">{tokens(entry.tokens)}</td>
                <td className="tl-num">{entry.toolCalls ? `${entry.toolCalls} tools` : ""}</td>
                <td className="tl-text">
                  {entry.status === "failed"
                    ? (entry.detail ?? "failed")
                    : (entry.content ?? "").slice(0, 90)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};
