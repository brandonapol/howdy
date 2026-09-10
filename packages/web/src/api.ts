import type { Bot, BotDetail, Message } from "./types.js";

const secret = (): string | null => {
  try {
    return localStorage.getItem("howdy.secret");
  } catch {
    return null;
  }
};

export const setSecret = (value: string): void => {
  try {
    if (value === "") localStorage.removeItem("howdy.secret");
    else localStorage.setItem("howdy.secret", value);
  } catch {
    return;
  }
};

const headers = (): Record<string, string> => {
  const s = secret();
  return s === null
    ? { "content-type": "application/json" }
    : { "content-type": "application/json", "x-howdy-secret": s };
};

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, { ...init, headers: headers() });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
};

export const streamUrl = (since: number): string => {
  const s = secret();
  const query = new URLSearchParams({ since: String(since) });
  if (s !== null) query.set("secret", s);
  return `/api/stream?${query.toString()}`;
};

export const api = {
  bots: () => request<Bot[]>("/api/bots"),
  bot: (id: string) => request<BotDetail>(`/api/bots/${id}`),
  createBot: (name: string) =>
    request<Bot>("/api/bots", { method: "POST", body: JSON.stringify({ name }) }),
  updateBot: (id: string, patch: Record<string, unknown>) =>
    request<Bot>(`/api/bots/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteBot: (id: string) =>
    request<{ ok: boolean }>(`/api/bots/${id}`, { method: "DELETE" }),
  messages: (roomId: string) => request<Message[]>(`/api/rooms/${roomId}/messages`),
  send: (roomId: string, text: string, botId: string) =>
    request<{ ok: boolean }>(`/api/rooms/${roomId}/messages`, {
      method: "POST",
      body: JSON.stringify({ text, botId }),
    }),
  halt: (roomId: string) =>
    request<{ stopped: number }>(`/api/rooms/${roomId}/halt`, { method: "POST" }),
  panic: () => request<{ stopped: number }>("/api/panic", { method: "POST" }),
  health: () =>
    request<{
      ok: boolean;
      queueDepth: number;
      spend: { tokens: number };
      tokenCeiling: number;
    }>("/api/health"),
};
