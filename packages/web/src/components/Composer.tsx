import { useRef, useState } from "react";

type Props = {
  readonly disabled: boolean;
  readonly placeholder: string;
  readonly onSend: (text: string) => void;
};

export const Composer = ({ disabled, placeholder, onSend }: Props) => {
  const [text, setText] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);

  const submit = () => {
    const trimmed = text.trim();
    if (trimmed === "" || disabled) return;
    onSend(trimmed);
    setText("");
    if (box.current !== null) box.current.style.height = "auto";
  };

  return (
    <div className="composer">
      <div className="row">
        <textarea
          ref={box}
          value={text}
          placeholder={placeholder}
          rows={1}
          onChange={(e) => {
            setText(e.target.value);
            e.target.style.height = "auto";
            e.target.style.height = `${Math.min(200, e.target.scrollHeight)}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button onClick={submit} disabled={disabled || text.trim() === ""}>
          Send
        </button>
      </div>
      <p className="hint">Enter to send, Shift+Enter for a new line. Esc twice halts everything.</p>
    </div>
  );
};
