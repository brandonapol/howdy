import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { applyEnvelope, initialState } from "./state.js";
import type { UiState } from "./state.js";
import type { Envelope } from "./types.js";
import { streamUrl } from "./api.js";

type Action =
  | { readonly kind: "envelope"; readonly envelope: Envelope }
  | { readonly kind: "patch"; readonly patch: (state: UiState) => UiState };

const reducer = (state: UiState, action: Action): UiState =>
  action.kind === "envelope"
    ? applyEnvelope(state, action.envelope)
    : action.patch(state);

export type Connection = "connecting" | "open" | "closed";

const MAX_BACKOFF_MS = 15_000;
const BASE_BACKOFF_MS = 500;

export const useStream = (): {
  state: UiState;
  connection: Connection;
  patch: (fn: (state: UiState) => UiState) => void;
} => {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [connection, setConnection] = useState<Connection>("connecting");
  const lastId = useRef(0);

  useEffect(() => {
    let disposed = false;
    let current: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    const scheduleRetry = () => {
      if (disposed || retry !== undefined) return;
      const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
      attempt += 1;
      retry = setTimeout(() => {
        retry = undefined;
        connect();
      }, backoff + Math.random() * 250);
    };

    const connect = () => {
      if (disposed || current !== null) return;
      setConnection((c) => (c === "open" ? c : "connecting"));

      const source = new EventSource(streamUrl(lastId.current));
      current = source;

      const teardown = () => {
        if (current !== source) return;
        current = null;
        source.close();
      };

      source.addEventListener("open", () => {
        if (current !== source) return;
        attempt = 0;
        setConnection("open");
      });

      source.addEventListener("howdy", (event) => {
        if (current !== source) return;
        try {
          const envelope = JSON.parse((event as MessageEvent<string>).data) as Envelope;
          lastId.current = Math.max(lastId.current, envelope.id);
          dispatch({ kind: "envelope", envelope });
        } catch {
          return;
        }
      });

      source.addEventListener("error", () => {
        if (current !== source) return;
        teardown();
        setConnection("closed");
        scheduleRetry();
      });
    };

    connect();

    return () => {
      disposed = true;
      if (retry !== undefined) clearTimeout(retry);
      const source = current;
      current = null;
      source?.close();
    };
  }, []);

  const patch = useCallback(
    (fn: (current: UiState) => UiState) => dispatch({ kind: "patch", patch: fn }),
    [],
  );

  return { state, connection, patch };
};
