import { useEffect } from "react";
import type { Bot } from "../types.js";
import type { PermissionRequest } from "../state.js";

type Props = {
  readonly request: PermissionRequest;
  readonly queued: number;
  readonly bots: readonly Bot[];
  readonly onDecide: (id: string, allowed: boolean, always: boolean) => void;
};

export const PermissionPrompt = ({ request, queued, bots, onDecide }: Props) => {
  const bot = bots.find((b) => b.id === request.botId);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "a" && !e.metaKey && !e.ctrlKey) onDecide(request.id, true, false);
      if (e.key === "d" && !e.metaKey && !e.ctrlKey) onDecide(request.id, false, false);
      if (e.key === "A" && e.shiftKey) onDecide(request.id, true, true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [request.id, onDecide]);

  return (
    <div className="scrim" role="dialog" aria-modal="true" aria-labelledby="perm-title">
      <div className="prompt">
        <h2 id="perm-title">
          <span className="swatch" style={{ background: bot?.avatarColor ?? "#888" }} />
          {bot?.name ?? "A bot"} wants to run {request.tool}
        </h2>
        <pre className="command">{request.detail}</pre>
        <p className="note">
          It is confined to {bot?.workspacePath ?? "its workspace"}.
          {queued > 1 ? ` ${queued - 1} more waiting.` : ""}
        </p>
        <div className="actions">
          <button className="primary" onClick={() => onDecide(request.id, true, false)}>
            Allow once <kbd>a</kbd>
          </button>
          <button onClick={() => onDecide(request.id, true, true)}>
            Always allow <kbd>A</kbd>
          </button>
          <span style={{ flex: 1 }} />
          <button className="halt" onClick={() => onDecide(request.id, false, false)}>
            Deny <kbd>d</kbd>
          </button>
        </div>
      </div>
    </div>
  );
};
