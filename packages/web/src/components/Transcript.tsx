import { useEffect, useRef } from "react";
import type { Bot, Message } from "../types.js";
import type { Notice, RoomView } from "../state.js";

type Props = {
  readonly room: RoomView;
  readonly bots: readonly Bot[];
  readonly notices: readonly Notice[];
};

const nameOf = (bots: readonly Bot[], id: string | null): string =>
  bots.find((b) => b.id === id)?.name ?? "Bot";

const colorOf = (bots: readonly Bot[], id: string | null): string =>
  bots.find((b) => b.id === id)?.avatarColor ?? "#7a7a7a";

const Bubble = ({ message, bots }: { message: Message; bots: readonly Bot[] }) => (
  <div className={`msg ${message.speakerKind}`}>
    <div
      className="swatch"
      style={{
        background:
          message.speakerKind === "bot" ? colorOf(bots, message.botId) : undefined,
      }}
    />
    <div>
      <div className="who">
        {message.speakerKind === "human" ? "You" : nameOf(bots, message.botId)}
      </div>
      <div className="body">{message.content}</div>
      {message.toolCallCount > 0 && (
        <div className="tools">
          {message.toolCallCount} tool call{message.toolCallCount === 1 ? "" : "s"}
        </div>
      )}
    </div>
  </div>
);

export const Transcript = ({ room, bots, notices }: Props) => {
  const end = useRef<HTMLDivElement>(null);
  const streaming = Object.entries(room.streaming);

  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [room.messages.length, streaming.map(([, t]) => t.length).join(",")]);

  const empty = room.messages.length === 0 && streaming.length === 0;

  return (
    <div className="transcript">
      <div className="wrap">
        {empty && <p className="empty">Say something to get started.</p>}

        {room.messages.map((m) => (
          <Bubble key={m.id} message={m} bots={bots} />
        ))}

        {streaming.map(([botId, text]) => (
          <div className="msg bot" key={`stream-${botId}`}>
            <div className="swatch" style={{ background: colorOf(bots, botId) }} />
            <div>
              <div className="who">{nameOf(bots, botId)}</div>
              <div className="body">
                {text}
                <span className="cursor" />
              </div>
              {room.tools.length > 0 && (
                <div className="tools">{room.tools.join(" · ")}</div>
              )}
            </div>
          </div>
        ))}

        {room.activeBot !== null && streaming.length === 0 && (
          <div className="msg bot">
            <div className="swatch" style={{ background: colorOf(bots, room.activeBot) }} />
            <div>
              <div className="who">{nameOf(bots, room.activeBot)}</div>
              <div className="body">
                <span className="cursor" />
              </div>
              {room.tools.length > 0 && (
                <div className="tools">{room.tools.join(" · ")}</div>
              )}
            </div>
          </div>
        )}

        {notices.length > 0 && (
          <div className="notices">
            {notices.map((n) => (
              <div key={n.id} className={`notice ${n.tone}`}>
                {n.text}
              </div>
            ))}
          </div>
        )}

        <div ref={end} />
      </div>
    </div>
  );
};
