import type { RoomMessage } from "./types.js";

export type Verdict =
  | { readonly kind: "ok" }
  | { readonly kind: "decay"; readonly detector: string; readonly detail: string }
  | { readonly kind: "halt"; readonly detector: string; readonly detail: string };

export type DegeneracyConfig = {
  readonly repetitionThreshold: number;
  readonly repetitionLookback: number;
  readonly cascadeRun: number;
  readonly chatterRun: number;
  readonly chatterMaxChars: number;
};

export const defaultDegeneracyConfig: DegeneracyConfig = {
  repetitionThreshold: 0.6,
  repetitionLookback: 5,
  cascadeRun: 3,
  chatterRun: 3,
  chatterMaxChars: 200,
};

const AGREEMENT_OPENERS: readonly string[] = [
  "yes", "yeah", "yep", "exactly", "totally", "absolutely", "agreed",
  "i agree", "great point", "good point", "spot on", "100%", "couldn't agree",
  "cannot agree", "well said", "indeed", "precisely", "right", "this",
  "love it", "love this", "same", "for sure", "definitely", "makes sense",
  "that's fair", "fair enough", "you're right", "youre right", "so true",
];

const normalize = (text: string): string =>
  text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

export const trigrams = (text: string): ReadonlySet<string> => {
  const n = normalize(text);
  const out = new Set<string>();
  if (n.length < 3) {
    if (n.length > 0) out.add(n);
    return out;
  }
  for (let i = 0; i + 3 <= n.length; i += 1) out.add(n.slice(i, i + 3));
  return out;
};

export const jaccard = (
  a: ReadonlySet<string>,
  b: ReadonlySet<string>,
): number => {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared += 1;
  return shared / (a.size + b.size - shared);
};

const entities = (text: string): ReadonlySet<string> => {
  const out = new Set<string>();
  for (const m of text.matchAll(/`([^`]+)`/g)) {
    const v = m[1];
    if (v !== undefined) out.add(v.toLowerCase());
  }
  for (const m of text.matchAll(/\b([A-Z][a-zA-Z0-9_.-]{2,})\b/g)) {
    const v = m[1];
    if (v === undefined) continue;
    const before = text.slice(0, m.index ?? 0).replace(/\s+$/, "");
    const prev = before.at(-1);
    const sentenceStart =
      before.length === 0 || prev === "." || prev === "!" || prev === "?";
    if (sentenceStart) continue;
    out.add(v.toLowerCase());
  }
  for (const m of text.matchAll(/\b\d+(?:\.\d+)?\b/g)) {
    const v = m[0];
    out.add(v);
  }
  return out;
};

const opensWithAgreement = (text: string): boolean => {
  const head = normalize(text).slice(0, 40);
  return AGREEMENT_OPENERS.some((p) => head.startsWith(p));
};

const isBot = (m: RoomMessage): boolean => m.speaker.kind === "bot";

const trailingBotRun = (recent: readonly RoomMessage[]): readonly RoomMessage[] => {
  const run: RoomMessage[] = [];
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const m = recent[i];
    if (m === undefined || !isBot(m)) break;
    run.unshift(m);
  }
  return run;
};

export const detectRepetition = (
  recent: readonly RoomMessage[],
  config: DegeneracyConfig = defaultDegeneracyConfig,
): Verdict => {
  const run = trailingBotRun(recent);
  const latest = run[run.length - 1];
  if (latest === undefined) return { kind: "ok" };
  const priors = run.slice(Math.max(0, run.length - 1 - config.repetitionLookback), run.length - 1);
  const target = trigrams(latest.content);
  for (const prior of priors) {
    const score = jaccard(target, trigrams(prior.content));
    if (score > config.repetitionThreshold) {
      return {
        kind: "halt",
        detector: "repetition",
        detail: `message repeats an earlier one (trigram similarity ${score.toFixed(2)})`,
      };
    }
  }
  return { kind: "ok" };
};

export const detectAgreementCascade = (
  recent: readonly RoomMessage[],
  config: DegeneracyConfig = defaultDegeneracyConfig,
): Verdict => {
  const run = trailingBotRun(recent).slice(-config.cascadeRun);
  if (run.length < config.cascadeRun) return { kind: "ok" };
  if (!run.every((m) => opensWithAgreement(m.content))) return { kind: "ok" };

  const seen = new Set<string>();
  const first = run[0];
  if (first !== undefined) for (const e of entities(first.content)) seen.add(e);
  let introduced = 0;
  for (const m of run.slice(1)) {
    for (const e of entities(m.content)) {
      if (!seen.has(e)) {
        introduced += 1;
        seen.add(e);
      }
    }
  }
  if (introduced > 0) return { kind: "ok" };
  return {
    kind: "decay",
    detector: "agreementCascade",
    detail: `${run.length} consecutive agreeing messages introduced nothing new`,
  };
};

export const detectChatter = (
  recent: readonly RoomMessage[],
  config: DegeneracyConfig = defaultDegeneracyConfig,
): Verdict => {
  const run = trailingBotRun(recent).slice(-config.chatterRun);
  if (run.length < config.chatterRun) return { kind: "ok" };
  const idle = run.every(
    (m) =>
      m.content.length < config.chatterMaxChars &&
      m.toolCallCount === 0 &&
      !m.content.includes("?"),
  );
  if (!idle) return { kind: "ok" };
  return {
    kind: "decay",
    detector: "chatter",
    detail: `${run.length} short messages with no tool use and no questions`,
  };
};

const RANK: Record<Verdict["kind"], number> = { ok: 0, decay: 1, halt: 2 };

export const inspect = (
  recent: readonly RoomMessage[],
  config: DegeneracyConfig = defaultDegeneracyConfig,
): Verdict =>
  [
    detectRepetition(recent, config),
    detectAgreementCascade(recent, config),
    detectChatter(recent, config),
  ].reduce<Verdict>(
    (worst, v) => (RANK[v.kind] > RANK[worst.kind] ? v : worst),
    { kind: "ok" },
  );
