import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addUsage,
  advanceClock,
  applyUsage,
  createBudget,
  defaultCeilings,
  describeBreach,
  effectiveTokens,
  exceeded,
  remaining,
  sanitizeUsage,
  utilisation,
} from "../dist/index.js";
import { usage } from "./helpers.ts";

test("effectiveTokens weights cache reads down and cache writes up", () => {
  const t = effectiveTokens({
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 1000,
    cacheCreationTokens: 200,
  });
  assert.equal(t, 100 + 50 + 100 + 250);
});

test("sanitizeUsage clamps negative, NaN and missing counts to zero", () => {
  const u = sanitizeUsage({
    inputTokens: -5,
    outputTokens: Number.NaN,
    cacheReadTokens: Number.POSITIVE_INFINITY,
  });
  assert.deepEqual(u, {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  });
});

test("sanitizeUsage tolerates an entirely absent usage block", () => {
  assert.equal(effectiveTokens(sanitizeUsage(undefined)), 0);
});

test("addUsage sums componentwise", () => {
  const sum = addUsage(usage(10, 20), usage(1, 2));
  assert.equal(sum.inputTokens, 11);
  assert.equal(sum.outputTokens, 22);
});

test("turn ceiling breaches first and is reported", () => {
  let budget = createBudget({ ...defaultCeilings, maxTurns: 2 }, 0);
  assert.equal(exceeded(budget), null);
  budget = applyUsage(budget, usage(1, 1));
  assert.equal(exceeded(budget), null);
  budget = applyUsage(budget, usage(1, 1));
  const breach = exceeded(budget);
  assert.equal(breach?.kind, "turns");
  assert.match(describeBreach(breach!), /turn ceiling/);
});

test("token ceiling breaches", () => {
  let budget = createBudget({ ...defaultCeilings, maxTokens: 100 }, 0);
  budget = applyUsage(budget, usage(60, 60));
  const breach = exceeded(budget);
  assert.equal(breach?.kind, "tokens");
  assert.equal(breach?.used, 120);
});

test("wall clock ceiling breaches on clock advance only", () => {
  const budget = createBudget({ ...defaultCeilings, maxWallClockMs: 1000 }, 0);
  assert.equal(exceeded(budget), null);
  const later = advanceClock(budget, 1500);
  assert.equal(exceeded(later)?.kind, "wallClock");
});

test("advanceClock never moves the clock backwards", () => {
  const budget = advanceClock(createBudget(defaultCeilings, 500), 100);
  assert.equal(budget.now, 500);
});

test("remaining never goes negative", () => {
  let budget = createBudget({ ...defaultCeilings, maxTokens: 10 }, 0);
  budget = applyUsage(budget, usage(500, 500));
  assert.equal(remaining(budget).tokens, 0);
});

test("utilisation reports the closest ceiling and stays in range", () => {
  let budget = createBudget({ ...defaultCeilings, maxTurns: 4, maxTokens: 1_000_000 }, 0);
  budget = applyUsage(budget, usage(1, 1));
  assert.equal(utilisation(budget), 0.25);
  budget = applyUsage(budget, usage(10_000_000, 0));
  assert.equal(utilisation(budget), 1);
});
