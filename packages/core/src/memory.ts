export type MemoryEntry = {
  readonly date: string;
  readonly text: string;
  readonly tags: readonly string[];
};

const LINE = /^- \((\d{4}-\d{2}-\d{2})\)\s*(.*)$/;

export const parseMemory = (raw: string): readonly MemoryEntry[] =>
  raw
    .split("\n")
    .map((line) => LINE.exec(line.trim()))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => {
      const body = m[2] ?? "";
      const tags = [...body.matchAll(/#([a-z0-9][a-z0-9_-]*)/gi)].map((t) =>
        (t[1] ?? "").toLowerCase(),
      );
      const text = body.replace(/#[a-z0-9][a-z0-9_-]*/gi, "").replace(/\s+/g, " ").trim();
      return { date: m[1] ?? "", text, tags };
    });

export const renderMemory = (entries: readonly MemoryEntry[]): string =>
  entries
    .map((e) => {
      const tags = e.tags.map((t) => ` #${t}`).join("");
      return `- (${e.date}) ${e.text}${tags}`;
    })
    .join("\n") + (entries.length > 0 ? "\n" : "");

const normalise = (text: string): string =>
  text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

export type Compaction = {
  readonly kept: readonly MemoryEntry[];
  readonly dropped: readonly MemoryEntry[];
  readonly reason: "duplicates" | "overflow" | "both" | "none";
};

export const compactMemory = (
  entries: readonly MemoryEntry[],
  limit: number,
): Compaction => {
  const seen = new Map<string, MemoryEntry>();
  const duplicates: MemoryEntry[] = [];

  for (const entry of entries) {
    const key = normalise(entry.text);
    if (key === "") continue;
    const existing = seen.get(key);
    if (existing === undefined) {
      seen.set(key, entry);
      continue;
    }
    duplicates.push(existing);
    seen.set(key, entry);
  }

  const unique = [...seen.values()];
  const overflow = Math.max(0, unique.length - limit);
  const kept = overflow === 0 ? unique : unique.slice(overflow);
  const dropped = [...duplicates, ...(overflow === 0 ? [] : unique.slice(0, overflow))];

  const reason: Compaction["reason"] =
    duplicates.length > 0 && overflow > 0
      ? "both"
      : duplicates.length > 0
        ? "duplicates"
        : overflow > 0
          ? "overflow"
          : "none";

  return { kept, dropped, reason };
};

export const searchMemory = (
  entries: readonly MemoryEntry[],
  query: string,
  limit = 8,
): readonly MemoryEntry[] => {
  const terms = normalise(query).split(" ").filter((t) => t.length > 2);
  if (terms.length === 0) return entries.slice(-limit);
  const scored = entries
    .map((entry) => {
      const hay = normalise(entry.text);
      const score = terms.reduce((acc, t) => acc + (hay.includes(t) ? 1 : 0), 0);
      return { entry, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.entry);
};
