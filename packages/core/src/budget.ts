import type { Breach, Budget, Ceilings, Usage } from "./types.js";
import { emptyUsage } from "./types.js";

const CACHE_READ_WEIGHT = 0.1;
const CACHE_CREATION_WEIGHT = 1.25;

const safe = (n: number): number =>
  Number.isFinite(n) && n > 0 ? n : 0;

export const sanitizeUsage = (usage: Partial<Usage> | undefined): Usage =>
  usage === undefined
    ? emptyUsage
    : {
        inputTokens: safe(usage.inputTokens ?? 0),
        outputTokens: safe(usage.outputTokens ?? 0),
        cacheReadTokens: safe(usage.cacheReadTokens ?? 0),
        cacheCreationTokens: safe(usage.cacheCreationTokens ?? 0),
      };

export const effectiveTokens = (usage: Usage): number => {
  const u = sanitizeUsage(usage);
  return Math.round(
    u.inputTokens +
      u.outputTokens +
      u.cacheReadTokens * CACHE_READ_WEIGHT +
      u.cacheCreationTokens * CACHE_CREATION_WEIGHT,
  );
};

export const addUsage = (a: Usage, b: Usage): Usage => {
  const x = sanitizeUsage(a);
  const y = sanitizeUsage(b);
  return {
    inputTokens: x.inputTokens + y.inputTokens,
    outputTokens: x.outputTokens + y.outputTokens,
    cacheReadTokens: x.cacheReadTokens + y.cacheReadTokens,
    cacheCreationTokens: x.cacheCreationTokens + y.cacheCreationTokens,
  };
};

export const createBudget = (ceilings: Ceilings, startedAt: number): Budget => ({
  ceilings,
  turnsUsed: 0,
  tokensUsed: 0,
  startedAt,
  now: startedAt,
});

export const applyUsage = (budget: Budget, usage: Usage): Budget => ({
  ...budget,
  turnsUsed: budget.turnsUsed + 1,
  tokensUsed: budget.tokensUsed + effectiveTokens(usage),
});

export const resetWindow = (budget: Budget, now: number): Budget => ({
  ...budget,
  turnsUsed: 0,
  tokensUsed: 0,
  startedAt: now,
  now,
});

export const advanceClock = (budget: Budget, now: number): Budget =>
  now > budget.now ? { ...budget, now } : budget;

export const remaining = (budget: Budget) => ({
  turns: Math.max(0, budget.ceilings.maxTurns - budget.turnsUsed),
  tokens: Math.max(0, budget.ceilings.maxTokens - budget.tokensUsed),
  wallClockMs: Math.max(
    0,
    budget.ceilings.maxWallClockMs - (budget.now - budget.startedAt),
  ),
});

export const exceeded = (budget: Budget): Breach | null => {
  if (budget.turnsUsed >= budget.ceilings.maxTurns) {
    return { kind: "turns", used: budget.turnsUsed, ceiling: budget.ceilings.maxTurns };
  }
  if (budget.tokensUsed >= budget.ceilings.maxTokens) {
    return { kind: "tokens", used: budget.tokensUsed, ceiling: budget.ceilings.maxTokens };
  }
  const elapsed = budget.now - budget.startedAt;
  if (elapsed >= budget.ceilings.maxWallClockMs) {
    return { kind: "wallClock", used: elapsed, ceiling: budget.ceilings.maxWallClockMs };
  }
  return null;
};

export const utilisation = (budget: Budget): number => {
  const r = [
    budget.turnsUsed / Math.max(1, budget.ceilings.maxTurns),
    budget.tokensUsed / Math.max(1, budget.ceilings.maxTokens),
    (budget.now - budget.startedAt) / Math.max(1, budget.ceilings.maxWallClockMs),
  ];
  return Math.min(1, Math.max(0, ...r));
};

export const describeBreach = (breach: Breach): string => {
  switch (breach.kind) {
    case "turns":
      return `turn ceiling reached (${breach.used}/${breach.ceiling} turns)`;
    case "tokens":
      return `token ceiling reached (${breach.used.toLocaleString()}/${breach.ceiling.toLocaleString()} effective tokens)`;
    case "wallClock":
      return `time ceiling reached (${Math.round(breach.used / 1000)}s/${Math.round(breach.ceiling / 1000)}s)`;
  }
};
