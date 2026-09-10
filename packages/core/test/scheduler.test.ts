import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultCeilings, step } from "../dist/index.js";
import type { Effect, RoomState } from "../dist/index.js";
import { botIdOf, botMessage, humanMessage, makeState, participant, usage } from "./helpers.ts";

const runTurns = (effects: readonly Effect[]) =>
  effects.filter((e): e is Extract<Effect, { kind: "runTurn" }> => e.kind === "runTurn");

test("a human message hands the turn to a willing bot", () => {
  const state = makeState([participant("alpha")]);
  const [next, effects] = step(state, {
    kind: "humanMessage",
    message: humanMessage("howdy"),
    mentions: [],
  });
  assert.equal(next.status.kind, "running");
  assert.equal(runTurns(effects).length, 1);
  assert.equal(runTurns(effects)[0]?.speaker, botIdOf("alpha"));
});

test("an @mention overrides the noisiness roll and the cooldown", () => {
  const state = makeState([
    participant("alpha", 1),
    participant("lurker", 0, 99),
  ]);
  const [next, effects] = step(state, {
    kind: "humanMessage",
    message: humanMessage("hey @lurker"),
    mentions: [botIdOf("lurker")],
  });
  assert.equal(runTurns(effects)[0]?.speaker, botIdOf("lurker"));
  assert.deepEqual(next.pendingMentions, []);
});

test("a bot does not speak twice in a row while another is willing", () => {
  const state = makeState([participant("alpha"), participant("beta")], {
    status: { kind: "running", speaker: botIdOf("alpha") },
  });
  const [, effects] = step(state, {
    kind: "turnCompleted",
    message: botMessage("alpha", "Here is a genuinely substantive first take on the migration."),
  });
  assert.equal(runTurns(effects)[0]?.speaker, botIdOf("beta"));
});

test("a lone bot may take consecutive turns", () => {
  const state = makeState([participant("alpha")], {
    status: { kind: "running", speaker: botIdOf("alpha") },
  });
  const [, effects] = step(state, {
    kind: "turnCompleted",
    message: botMessage("alpha", "A substantive and reasonably long first observation about Argo."),
  });
  assert.equal(runTurns(effects)[0]?.speaker, botIdOf("alpha"));
});

test("cooldown keeps a bot silent for the configured number of turns", () => {
  const state = makeState([participant("alpha", 1, 5)], {
    participants: [{ ...participant("alpha", 1, 5), lastSpokeAtTurn: 1 }],
    turnIndex: 3,
  });
  const [next, effects] = step(state, {
    kind: "humanMessage",
    message: humanMessage("anyone?"),
    mentions: [],
  });
  assert.equal(next.status.kind, "idle");
  assert.equal(runTurns(effects).length, 0);
});

test("nobody willing means the room idles rather than forcing a turn", () => {
  const state = makeState([participant("alpha", 0), participant("beta", 0)]);
  const [next, effects] = step(state, {
    kind: "humanMessage",
    message: humanMessage("anyone home"),
    mentions: [],
  });
  assert.equal(next.status.kind, "idle");
  assert.deepEqual(effects, []);
});

test("a manual halt aborts the in-flight turn", () => {
  const state = makeState([participant("alpha")], {
    status: { kind: "running", speaker: botIdOf("alpha") },
  });
  const [next, effects] = step(state, { kind: "haltRequested" });
  assert.equal(next.status.kind, "halted");
  assert.ok(effects.some((e) => e.kind === "abortTurn"));
  assert.ok(effects.some((e) => e.kind === "halted"));
});

test("halting twice is a no-op", () => {
  const halted = makeState([participant("alpha")], {
    status: { kind: "halted", reason: { kind: "manual" } },
  });
  const [next, effects] = step(halted, { kind: "haltRequested" });
  assert.equal(next.status.kind, "halted");
  assert.deepEqual(effects, []);
});

test("a halted room ignores further messages and turns", () => {
  const halted = makeState([participant("alpha")], {
    status: { kind: "halted", reason: { kind: "manual" } },
  });
  const [, humanEffects] = step(halted, {
    kind: "humanMessage",
    message: humanMessage("please keep going"),
    mentions: [],
  });
  assert.deepEqual(humanEffects, []);
  const [, turnEffects] = step(halted, {
    kind: "turnCompleted",
    message: botMessage("alpha", "sneaking one in"),
  });
  assert.deepEqual(turnEffects, []);
});

test("resume clears a manual halt but refuses a budget halt", () => {
  const manual = makeState([participant("alpha")], {
    status: { kind: "halted", reason: { kind: "manual" } },
  });
  const [resumed] = step(manual, { kind: "resumeRequested" });
  assert.equal(resumed.status.kind, "running");

  const budgetHalted = makeState([participant("alpha")], {
    status: {
      kind: "halted",
      reason: { kind: "budget", breach: { kind: "turns", used: 20, ceiling: 20 } },
    },
  });
  const [stillHalted, effects] = step(budgetHalted, { kind: "resumeRequested" });
  assert.equal(stillHalted.status.kind, "halted");
  assert.ok(effects.some((e) => e.kind === "announce"));
});

test("the turn ceiling halts the party and names the breach", () => {
  let state: RoomState = makeState([participant("alpha"), participant("beta")], {
    budget: {
      ceilings: { ...defaultCeilings, maxTurns: 1 },
      turnsUsed: 0,
      tokensUsed: 0,
      startedAt: 0,
      now: 0,
    },
  });
  const [next] = step(state, {
    kind: "turnCompleted",
    message: botMessage("alpha", "One substantive contribution about the payments migration.", usage(10, 10)),
  });
  assert.equal(next.status.kind, "halted");
  if (next.status.kind !== "halted") throw new Error("unreachable");
  assert.equal(next.status.reason.kind, "budget");
});

test("a clock tick past the wall clock ceiling halts", () => {
  const state = makeState([participant("alpha")], {
    budget: {
      ceilings: { ...defaultCeilings, maxWallClockMs: 1000 },
      turnsUsed: 0,
      tokensUsed: 0,
      startedAt: 0,
      now: 0,
    },
  });
  const [next] = step(state, { kind: "clockTick", now: 5000 });
  assert.equal(next.status.kind, "halted");
});

test("step mode parks the turn until it is asked for", () => {
  const state = makeState([participant("alpha")], { stepMode: true });
  const [parked, parkedEffects] = step(state, {
    kind: "humanMessage",
    message: humanMessage("go"),
    mentions: [],
  });
  assert.equal(parked.status.kind, "awaitingTurn");
  assert.deepEqual(parkedEffects, []);

  const [running, runningEffects] = step(parked, { kind: "stepRequested" });
  assert.equal(running.status.kind, "running");
  assert.equal(runTurns(runningEffects).length, 1);
});

test("a failed turn is announced, charged a turn, and does not retry the same bot", () => {
  const state = makeState([participant("alpha"), participant("beta")], {
    status: { kind: "running", speaker: botIdOf("alpha") },
  });
  const [next, effects] = step(state, {
    kind: "turnFailed",
    speaker: botIdOf("alpha"),
    detail: "subprocess exited",
  });
  assert.equal(next.budget.turnsUsed, 1);
  assert.ok(effects.some((e) => e.kind === "announce"));
  assert.equal(runTurns(effects)[0]?.speaker, botIdOf("beta"));
});

const LINES: readonly string[] = [
  "The ingress controller rewrite landed and the nginx annotations no longer map cleanly onto the gateway API resources we standardised on last quarter.",
  "Sync waves are the culprit: wave zero contains both the namespace and a job that assumes the namespace already exists, which races on a cold cluster.",
  "Helm renders the checksum annotation from a configmap that itself templates a timestamp, so every diff shows drift even when nothing meaningful changed.",
  "Node pressure eviction kicked in on the arm workers because the kubelet reserve was never tuned after we doubled the pod density per node.",
  "Our readiness probe hits a path that fans out to three downstream services, so a single slow dependency marks the whole replica set unhealthy.",
  "Image pull secrets rotate weekly but the service account patch runs monthly, which explains the pull failures clustering at the start of each month.",
  "Terraform state drifted after somebody widened a security group by hand during an incident and never folded the change back into the module.",
  "The horizontal autoscaler is reading a stale custom metric because the adapter caches for sixty seconds and our scrape interval is ninety.",
  "Postgres connection pooling sits in the application rather than pgbouncer, so a rolling restart briefly triples the connection count.",
  "Certificate renewal succeeded but the pods were never restarted, leaving the old chain in memory until the next unrelated deploy shook them loose.",
  "Log volume tripled after somebody set the root logger to debug in a base image, and the shipper is now the most expensive thing on the cluster.",
  "The cronjob has no concurrency policy, so a slow run overlaps the next one and both compete for the same advisory lock.",
  "Persistent volume expansion is stuck pending because the storage class was created without allowVolumeExpansion and cannot be patched retroactively.",
  "Service mesh sidecars start after the application container, so early outbound calls bypass the proxy entirely and skip mutual authentication.",
  "The registry garbage collector removed a layer still referenced by an older tag, which is why the rollback failed rather than the deploy.",
  "Resource requests were copied from a template nobody owns, and the aggregate request now exceeds the allocatable capacity of two whole nodes.",
  "DNS lookups inside the cluster append five search domains before the real one, quintupling query volume against an already saturated resolver.",
  "The webhook has a failure policy of ignore, so a broken admission controller silently stopped enforcing the policy we thought was protecting us.",
  "Blue green cutover left the old target group draining for an hour because the deregistration delay was inherited from a legacy module default.",
  "Secrets are mounted as environment variables, which means every crash loop writes them into the container runtime logs in plain text.",
  "The migration job runs with the same service account as the api, giving it far broader database privileges than a schema change requires.",
  "Backups complete but have never been restored, so the recovery time objective on the runbook is an estimate rather than a measurement.",
  "Prometheus retention was cut to seven days to save disk, which quietly broke every dashboard panel with a thirty day comparison window.",
  "The load balancer health check uses TCP rather than HTTP, so a process that accepts connections but returns errors stays in rotation forever.",
];

const line = (index: number): string => LINES[index % LINES.length] ?? "a further observation";

const simulate = (seedState: RoomState, limit: number) => {
  const transcript: string[] = [];
  let state = seedState;
  let [next, effects] = step(state, {
    kind: "humanMessage",
    message: humanMessage("Kick off a review of the deploy pipeline."),
    mentions: [],
  });
  state = next;
  let iterations = 0;
  while (iterations < limit) {
    const pending = runTurns(effects)[0];
    if (pending === undefined) break;
    transcript.push(String(pending.speaker));
    [next, effects] = step(state, {
      kind: "turnCompleted",
      message: botMessage(String(pending.speaker), line(iterations), usage(400, 200), 1),
    });
    state = next;
    iterations += 1;
  }
  return { state, transcript, iterations };
};

test("a two-bot party always terminates inside its ceilings", () => {
  const run = simulate(makeState([participant("alpha", 0.9), participant("beta", 0.9)]), 200);
  assert.ok(run.iterations < 200, `party ran away: ${run.iterations} turns`);
  assert.notEqual(run.state.status.kind, "running");
  assert.ok(run.state.budget.turnsUsed <= defaultCeilings.maxTurns);
});

test("a maximally noisy party is stopped by the turn ceiling", () => {
  const run = simulate(makeState([participant("alpha", 1), participant("beta", 1)]), 200);
  assert.equal(run.state.status.kind, "halted");
  if (run.state.status.kind !== "halted") throw new Error("unreachable");
  const reason = run.state.status.reason;
  assert.equal(reason.kind, "budget");
  if (reason.kind !== "budget") throw new Error("unreachable");
  assert.equal(reason.breach.kind, "turns");
  assert.equal(run.iterations, defaultCeilings.maxTurns);
});

test("the same seed produces the same party twice", () => {
  const seed = makeState([
    participant("alpha", 0.6),
    participant("beta", 0.6),
    participant("gamma", 0.6),
  ]);
  assert.deepEqual(simulate(seed, 200).transcript, simulate(seed, 200).transcript);
  assert.ok(simulate(seed, 200).transcript.length > 1);
});

test("a different seed produces a different party", () => {
  const a = simulate(
    makeState([participant("alpha", 0.5), participant("beta", 0.5)], { rngState: 12345 }),
    200,
  );
  const b = simulate(
    makeState([participant("alpha", 0.5), participant("beta", 0.5)], { rngState: 999 }),
    200,
  );
  assert.notDeepEqual(a.transcript, b.transcript);
});

test("a token-heavy party stops on tokens rather than turns", () => {
  const seed = makeState(
    [participant("alpha", 1), participant("beta", 1)],
    {},
    { ...defaultCeilings, maxTurns: 500, maxTokens: 3000 },
  );
  const run = simulate(seed, 200);
  assert.equal(run.state.status.kind, "halted");
  if (run.state.status.kind !== "halted") throw new Error("unreachable");
  const reason = run.state.status.reason;
  assert.equal(reason.kind, "budget");
  if (reason.kind !== "budget") throw new Error("unreachable");
  assert.equal(reason.breach.kind, "tokens");
});

test("a degenerate party is stopped by a detector well before its ceilings", () => {
  let state = makeState([participant("alpha", 1), participant("beta", 1)]);
  let [next, effects] = step(state, {
    kind: "humanMessage",
    message: humanMessage("what do you make of the plan"),
    mentions: [],
  });
  state = next;
  let iterations = 0;
  while (iterations < 50) {
    const pending = runTurns(effects)[0];
    if (pending === undefined) break;
    iterations += 1;
    [next, effects] = step(state, {
      kind: "turnCompleted",
      message: botMessage(String(pending.speaker), "Absolutely, I agree, that plan is a really strong one."),
    });
    state = next;
  }
  assert.equal(state.status.kind, "halted");
  if (state.status.kind !== "halted") throw new Error("unreachable");
  assert.equal(state.status.reason.kind, "degeneracy");
  assert.ok(iterations < defaultCeilings.maxTurns, `took ${iterations} turns to notice`);
});
