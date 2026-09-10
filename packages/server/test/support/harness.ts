import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../../dist/server.js";
import { openDb } from "../../dist/db/index.js";
import { createBotStore } from "../../dist/bots/store.js";
import { recallFor, rememberFor } from "../../dist/agent/memory.js";
import type { Bot } from "@howdy/core";
import type { RunningServer } from "../../dist/server.js";
import type { RunTurnInput } from "../../dist/agent/run.js";
import type { TurnOutcome } from "../../dist/agent/outcome.js";

export type Script = (input: RunTurnInput) => Promise<TurnOutcome>;

export const usage = (input = 400, output = 200) => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
});

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((done, fail) => {
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      fail((signal.reason as Error | undefined) ?? new Error("aborted"));
    });
  });

export const replies = (text: string, chunks = 3, delayMs = 5): Script =>
  async (input) => {
    const size = Math.ceil(text.length / chunks);
    for (let i = 0; i < text.length; i += size) {
      input.signal.throwIfAborted();
      input.onText?.(text.slice(i, i + size));
      await sleep(delayMs, input.signal);
    }
    return {
      text,
      toolCalls: [],
      usage: usage(),
      costUsd: 0.002,
      sessionId: "fake-session",
      isError: false,
      detail: null,
    };
  };

export type Howdy = RunningServer & {
  readonly root: string;
  readonly setScript: (script: Script) => void;
  readonly get: <T>(path: string) => Promise<T>;
  readonly post: <T>(path: string, body?: unknown) => Promise<T>;
  readonly cleanup: () => Promise<void>;
  readonly bot: (slug: string) => Bot;
  readonly remember: (slug: string, fact: string, tags?: readonly string[]) => string;
  readonly recall: (slug: string, query: string) => string;
};

export const startHowdy = async (
  overrides: Record<string, unknown> = {},
  root = mkdtempSync(join(tmpdir(), "howdy-e2e-")),
): Promise<Howdy> => {
  let script: Script = replies("Howdy. Everything looks fine.");

  const server = await startServer({
    config: {
      root,
      dbPath: join(root, "howdy.db"),
      botsDir: join(root, "bots"),
      workspacesDir: join(root, "workspaces"),
      host: "127.0.0.1",
      port: 0,
      sharedSecret: null,
      turnTimeoutMs: 5000,
      permissionTimeoutMs: 1000,
      dailyTokenCeiling: 1_000_000,
      webDist: null,
      ...overrides,
    },
    runTurn: (input) => script(input),
  });

  const call = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(`${server.url}${path}`, {
      ...init,
      headers: { "content-type": "application/json" },
    });
    const text = await response.text();
    const body = text === "" ? {} : (JSON.parse(text) as T);
    if (!response.ok) {
      throw Object.assign(new Error(`${response.status} ${text}`), { status: response.status, body });
    }
    return body;
  };

  const peek = () => {
    const db = openDb(join(root, "howdy.db"));
    const bots = createBotStore(db, server.config);
    return { db, bots, bus: server.bus };
  };

  const botBySlug = (slug: string): Bot => {
    const { bots, db } = peek();
    const found = bots.bySlug(slug);
    db.close();
    if (found === null) throw new Error(`no bot with slug ${slug}`);
    return found;
  };

  return {
    ...server,
    root,
    bot: botBySlug,
    remember: (slug, fact, tags = []) => {
      const ctx = peek();
      const bot = ctx.bots.bySlug(slug);
      if (bot === null) throw new Error(`no bot with slug ${slug}`);
      const out = rememberFor(bot, "test", ctx)(fact, tags);
      ctx.db.close();
      return out;
    },
    recall: (slug, query) => {
      const ctx = peek();
      const bot = ctx.bots.bySlug(slug);
      if (bot === null) throw new Error(`no bot with slug ${slug}`);
      const out = recallFor(bot, ctx)(query);
      ctx.db.close();
      return out;
    },
    setScript: (next) => {
      script = next;
    },
    get: (path) => call(path),
    post: (path, body) =>
      call(path, { method: "POST", body: JSON.stringify(body ?? {}) }),
    cleanup: async () => {
      await server.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
};

export type Collected = {
  readonly events: readonly { id: number; event: { kind: string; [k: string]: unknown } }[];
  readonly waitFor: (kind: string, timeoutMs?: number) => Promise<Record<string, unknown>>;
  readonly kinds: () => readonly string[];
  readonly close: () => void;
};

export const openStream = async (url: string, since = 0): Promise<Collected> => {
  const controller = new AbortController();
  const response = await fetch(`${url}/api/stream?since=${since}`, {
    signal: controller.signal,
    headers: { accept: "text/event-stream" },
  });
  if (response.body === null) throw new Error("no stream body");

  const events: { id: number; event: { kind: string; [k: string]: unknown } }[] = [];
  const listeners = new Set<() => void>();

  void (async () => {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const line = frame.split("\n").find((l) => l.startsWith("data: "));
          if (line === undefined) continue;
          const payload = line.slice(6);
          if (payload === "") continue;
          try {
            events.push(JSON.parse(payload) as never);
            for (const notify of listeners) notify();
          } catch {
            continue;
          }
        }
      }
    } catch {
      return;
    }
  })();

  return {
    events,
    kinds: () => events.map((e) => e.event.kind),
    waitFor: (kind, timeoutMs = 4000) =>
      new Promise((found, fail) => {
        const check = () => {
          const hit = events.find((e) => e.event.kind === kind);
          if (hit === undefined) return false;
          clearTimeout(timer);
          listeners.delete(check as never);
          found(hit.event);
          return true;
        };
        const timer = setTimeout(() => {
          listeners.delete(check as never);
          fail(new Error(`timed out waiting for ${kind}; saw ${events.map((e) => e.event.kind).join(", ")}`));
        }, timeoutMs);
        if (check()) return;
        listeners.add(check as never);
      }),
    close: () => controller.abort(),
  };
};
