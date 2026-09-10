import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import type { Browser } from "playwright";
import { startHowdy, replies, sleep, usage } from "../../server/test/support/harness.ts";
import type { Howdy } from "../../server/test/support/harness.ts";
import { launch, openApp } from "./support/browser.ts";

const WEB_DIST = resolve(import.meta.dirname, "..", "dist");

let browser: Browser;
before(async () => {
  browser = await launch();
});
after(async () => {
  await browser.close();
});

const stage = async (): Promise<Howdy> =>
  startHowdy({ webDist: WEB_DIST });

test("the app loads, lists bots, and reports a live connection", async (t) => {
  const h = await stage();
  t.after(() => h.cleanup());
  await h.post("/api/bots", { name: "Sre" });
  await h.post("/api/bots", { name: "Dev" });

  const app = await openApp(browser, h.url);
  t.after(() => app.close());

  await app.page.waitForSelector(".bot");
  assert.deepEqual(await app.page.locator(".bot .name").allTextContents(), ["Dev", "Sre"]);
  await app.page.waitForSelector(".dot.open", { timeout: 5000 });
  assert.match((await app.page.locator(".meter .label").textContent()) ?? "", /tokens today/);
  assert.deepEqual(app.errors, []);
});

test("sending a message streams the reply and then settles into the transcript", async (t) => {
  const h = await stage();
  t.after(() => h.cleanup());
  await h.post("/api/bots", { name: "Sre" });

  const app = await openApp(browser, h.url);
  t.after(() => app.close());
  await app.page.waitForSelector(".dot.open");

  h.setScript(replies("The presync hook is stuck on a shell wrapper that never execs.", 8, 150));
  await app.page.locator("textarea").fill("why is the deploy stuck?");
  await app.page.locator("textarea").press("Enter");

  await app.page.waitForSelector(".msg.human", { timeout: 5000 });
  assert.match((await app.page.locator(".msg.human .body").textContent()) ?? "", /why is the deploy stuck/);

  await app.page.waitForSelector(".cursor", { timeout: 5000 });
  await app.page.waitForFunction(
    () => document.querySelectorAll(".msg.bot").length > 0 && !document.querySelector(".cursor"),
    undefined,
    { timeout: 10000 },
  );

  assert.match(
    (await app.page.locator(".msg.bot .body").last().textContent()) ?? "",
    /never execs/,
  );
  assert.deepEqual(app.errors, []);
});

test("the token meter moves after a turn is paid for", async (t) => {
  const h = await stage();
  t.after(() => h.cleanup());
  await h.post("/api/bots", { name: "Sre" });
  const app = await openApp(browser, h.url);
  t.after(() => app.close());
  await app.page.waitForSelector(".dot.open");

  const before = (await app.page.locator(".meter .label").textContent()) ?? "";
  h.setScript(replies("done"));
  await app.page.locator("textarea").fill("go");
  await app.page.locator("textarea").press("Enter");
  await app.page.waitForFunction(
    (previous) => (document.querySelector(".meter .label")?.textContent ?? "") !== previous,
    before,
    { timeout: 10000 },
  );
  assert.match((await app.page.locator(".meter .label").textContent()) ?? "", /600/);
});

test("a permission prompt appears and approving it lets the turn finish", async (t) => {
  const h = await stage();
  t.after(() => h.cleanup());
  await h.post("/api/bots", { name: "Sre" });
  const app = await openApp(browser, h.url);
  t.after(() => app.close());
  await app.page.waitForSelector(".dot.open");

  h.setScript(async (input) => {
    const decision = await input.canUseTool?.(
      "Bash",
      { command: "terraform apply -auto-approve" },
      { signal: input.signal },
    );
    return {
      text: decision?.behavior === "allow" ? "terraform applied cleanly" : "stood down",
      toolCalls: [],
      usage: usage(10, 10),
      costUsd: 0,
      sessionId: null,
      isError: false,
      detail: null,
    };
  });

  await app.page.locator("textarea").fill("apply the plan");
  await app.page.locator("textarea").press("Enter");

  await app.page.waitForSelector(".prompt", { timeout: 8000 });
  assert.match((await app.page.locator(".prompt h2").textContent()) ?? "", /Sre wants to run Bash/);
  assert.match((await app.page.locator(".prompt .command").textContent()) ?? "", /terraform apply -auto-approve/);

  await app.page.locator(".prompt button.primary").click();
  await app.page.waitForSelector(".prompt", { state: "detached", timeout: 8000 });
  await app.page.waitForFunction(
    () => (document.body.textContent ?? "").includes("terraform applied cleanly"),
    undefined,
    { timeout: 10000 },
  );
  assert.deepEqual(app.errors, []);
});

test("denying a prompt from the keyboard refuses the tool", async (t) => {
  const h = await stage();
  t.after(() => h.cleanup());
  await h.post("/api/bots", { name: "Sre" });
  const app = await openApp(browser, h.url);
  t.after(() => app.close());
  await app.page.waitForSelector(".dot.open");

  h.setScript(async (input) => {
    const decision = await input.canUseTool?.("Bash", { command: "terraform destroy" }, { signal: input.signal });
    return {
      text: decision?.behavior === "deny" ? "refused to destroy anything" : "destroyed it",
      toolCalls: [],
      usage: usage(10, 10),
      costUsd: 0,
      sessionId: null,
      isError: false,
      detail: null,
    };
  });

  await app.page.locator("textarea").fill("destroy it");
  await app.page.locator("textarea").press("Enter");
  await app.page.waitForSelector(".prompt", { timeout: 8000 });
  await app.page.keyboard.press("d");
  await app.page.waitForSelector(".prompt", { state: "detached", timeout: 8000 });
  await app.page.waitForFunction(
    () => (document.body.textContent ?? "").includes("refused to destroy anything"),
    undefined,
    { timeout: 10000 },
  );
});

test("the halt button stops a running turn and says so", async (t) => {
  const h = await stage();
  t.after(() => h.cleanup());
  await h.post("/api/bots", { name: "Sre" });
  const app = await openApp(browser, h.url);
  t.after(() => app.close());
  await app.page.waitForSelector(".dot.open");

  h.setScript(async (input) => {
    input.onText?.("starting a very long job");
    await sleep(30_000, input.signal);
    throw new Error("unreachable");
  });

  await app.page.locator("textarea").fill("do the slow thing");
  await app.page.locator("textarea").press("Enter");
  await app.page.waitForSelector(".cursor", { timeout: 8000 });

  const halt = app.page.locator("button.halt").first();
  await halt.waitFor({ state: "visible" });
  await app.page.waitForFunction(
    () => !(document.querySelector("button.halt") as HTMLButtonElement | null)?.disabled,
    undefined,
    { timeout: 8000 },
  );
  await halt.click();

  await app.page.waitForSelector(".notice.alert", { timeout: 8000 });
  assert.match((await app.page.locator(".notice.alert").first().textContent()) ?? "", /Halted/);
  assert.equal(await app.page.locator(".cursor").count(), 0, "streaming must stop");
});

test("a bot can be configured in the browser and the change reaches the next turn", async (t) => {
  const h = await stage();
  t.after(() => h.cleanup());
  await h.post("/api/bots", { name: "Sre" });
  const app = await openApp(browser, h.url);
  t.after(() => app.close());
  await app.page.waitForSelector(".dot.open");

  await app.page.locator("button:has-text('Configure')").click();
  await app.page.waitForSelector("#personality");
  await app.page.locator("#personality").fill("You only ever reply in haiku.");
  await app.page.locator("#model").selectOption("claude-opus-5");
  await app.page.locator("button:has-text('Save')").click();
  await app.page.waitForSelector("#personality", { state: "detached", timeout: 8000 });

  await app.page.waitForFunction(
    () => (document.querySelector(".bot .sub")?.textContent ?? "").includes("opus-5"),
    undefined,
    { timeout: 8000 },
  );

  let seenPrompt = "";
  let seenModel = "";
  h.setScript(async (input) => {
    seenPrompt = input.systemPrompt;
    seenModel = input.model;
    return {
      text: "old pond, a frog leaps",
      toolCalls: [],
      usage: usage(1, 1),
      costUsd: 0,
      sessionId: null,
      isError: false,
      detail: null,
    };
  });

  await app.page.locator("textarea").fill("hello");
  await app.page.locator("textarea").press("Enter");
  await app.page.waitForFunction(
    () => (document.body.textContent ?? "").includes("old pond"),
    undefined,
    { timeout: 10000 },
  );
  assert.match(seenPrompt, /You only ever reply in haiku\./);
  assert.equal(seenModel, "claude-opus-5");
});

test("a reload brings the whole conversation back", async (t) => {
  const h = await stage();
  t.after(() => h.cleanup());
  await h.post("/api/bots", { name: "Sre" });
  const app = await openApp(browser, h.url);
  t.after(() => app.close());
  await app.page.waitForSelector(".dot.open");

  h.setScript(replies("the answer is prod-eu"));
  await app.page.locator("textarea").fill("which cluster");
  await app.page.locator("textarea").press("Enter");
  await app.page.waitForFunction(
    () => (document.body.textContent ?? "").includes("prod-eu"),
    undefined,
    { timeout: 10000 },
  );

  await app.page.reload({ waitUntil: "domcontentloaded" });
  await app.page.waitForSelector(".msg.bot", { timeout: 8000 });
  assert.equal(await app.page.locator(".msg").count(), 2);
  assert.match((await app.page.locator(".msg.bot .body").textContent()) ?? "", /prod-eu/);
});

test("two browsers watching the same room both see the reply", async (t) => {
  const h = await stage();
  t.after(() => h.cleanup());
  await h.post("/api/bots", { name: "Sre" });
  const one = await openApp(browser, h.url);
  const two = await openApp(browser, h.url);
  t.after(async () => {
    await one.close();
    await two.close();
  });
  await one.page.waitForSelector(".dot.open");
  await two.page.waitForSelector(".dot.open");

  h.setScript(replies("broadcast to everyone"));
  await one.page.locator("textarea").fill("tell us all");
  await one.page.locator("textarea").press("Enter");

  for (const session of [one, two]) {
    await session.page.waitForFunction(
      () => (document.body.textContent ?? "").includes("broadcast to everyone"),
      undefined,
      { timeout: 10000 },
    );
  }
});

test("the daily ceiling surfaces as an error rather than a silent failure", async (t) => {
  const h = await startHowdy({ webDist: WEB_DIST, dailyTokenCeiling: 100 });
  t.after(() => h.cleanup());
  await h.post("/api/bots", { name: "Sre" });
  const app = await openApp(browser, h.url);
  t.after(() => app.close());
  await app.page.waitForSelector(".dot.open");

  h.setScript(replies("first"));
  await app.page.locator("textarea").fill("one");
  await app.page.locator("textarea").press("Enter");
  await app.page.waitForFunction(
    () => (document.body.textContent ?? "").includes("first"),
    undefined,
    { timeout: 10000 },
  );

  await app.page.locator("textarea").fill("two");
  await app.page.locator("textarea").press("Enter");
  await app.page.waitForSelector(".notice.alert", { timeout: 8000 });
  assert.match(
    (await app.page.locator(".notice.alert").first().textContent()) ?? "",
    /daily token ceiling/,
  );
});

test("the phone layout keeps everything reachable", async (t) => {
  const h = await stage();
  t.after(() => h.cleanup());
  await h.post("/api/bots", { name: "Sre" });
  const app = await openApp(browser, h.url);
  t.after(() => app.close());
  await app.page.setViewportSize({ width: 390, height: 780 });
  await app.page.waitForSelector(".dot.open");

  assert.equal(await app.page.locator("textarea").isVisible(), true);
  assert.equal(await app.page.locator(".bot").first().isVisible(), true);
  assert.equal(await app.page.locator("button.halt").isVisible(), true);
  assert.equal(
    await app.page.locator(".dot").isVisible(),
    true,
    "connection state must stay visible on a phone",
  );

  const overflows = await app.page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  assert.equal(overflows, false, "the phone layout must not scroll sideways");
});

const twoBots = async (h: Howdy) => {
  await h.post("/api/bots", { name: "Sre" });
  await h.post("/api/bots", { name: "Dev" });
};

const PARTY_LINES = [
  "Sync wave zero holds both the namespace and a job that assumes it exists.",
  "Helm templates a timestamp into the checksum, so every diff shows drift.",
  "Kubelet reserve was never retuned after we doubled pod density.",
  "The autoscaler reads a metric the adapter caches past our scrape interval.",
  "Pull secrets rotate weekly but the service account patch runs monthly.",
  "Terraform drifted when a security group was widened by hand.",
];

const partyScript = () => {
  let n = 0;
  return async (input: Parameters<Parameters<Howdy["setScript"]>[0]>[0]) => {
    const text = PARTY_LINES[n % PARTY_LINES.length] ?? "another point";
    n += 1;
    input.onText?.(text);
    await sleep(60, input.signal);
    return {
      text,
      toolCalls: [],
      usage: usage(300, 150),
      costUsd: 0.001,
      sessionId: null,
      isError: false,
      detail: null,
    };
  };
};

test("a party can be assembled in the browser and shows up in the sidebar", async (t) => {
  const h = await stage();
  t.after(() => h.cleanup());
  await twoBots(h);
  const app = await openApp(browser, h.url);
  t.after(() => app.close());
  await app.page.waitForSelector(".dot.open");

  await app.page.locator("button:has-text('New party')").click();
  await app.page.waitForSelector(".prompt.wide");

  const start = app.page.locator(".prompt button:has-text('Start')");
  assert.equal(await start.isDisabled(), true, "cannot start a party with nobody in it");

  await app.page.locator("#party-name").fill("deploy post-mortem");
  await app.page.locator("#party-goal").fill("work out why the sync wedged");
  for (const box of await app.page.locator(".cast-row .pick input").all()) await box.check();
  await app.page.locator(".row3 input").first().fill("4");

  assert.equal(await start.isDisabled(), false);
  await start.click();
  await app.page.waitForSelector(".prompt.wide", { state: "detached", timeout: 8000 });

  await app.page.waitForSelector(".roombar", { timeout: 8000 });
  assert.match((await app.page.locator(".roombar .goal").textContent()) ?? "", /sync wedged/);
  assert.match(
    (await app.page.locator(".bot .name").last().textContent()) ?? "",
    /deploy post-mortem/,
  );
  assert.deepEqual(app.errors, []);
});

test("bots take turns in the browser and the room meters fill up", async (t) => {
  const h = await stage();
  t.after(() => h.cleanup());
  const bots = await Promise.all([
    h.post<{ id: string }>("/api/bots", { name: "Sre" }),
    h.post<{ id: string }>("/api/bots", { name: "Dev" }),
  ]);
  const room = await h.post<{ id: string }>("/api/rooms", {
    name: "the party",
    kind: "party",
    ceilings: { maxTurns: 5 },
    participants: bots.map((b) => ({ botId: b.id, noisiness: 1, cooldownTurns: 0 })),
  });

  const app = await openApp(browser, h.url);
  t.after(() => app.close());
  await app.page.waitForSelector(".dot.open");
  await app.page.locator(`.bot:has-text("the party")`).click();
  await app.page.waitForSelector(".roombar");

  h.setScript(partyScript());
  await app.page.locator("textarea").fill("why is the deploy stuck?");
  await app.page.locator("textarea").press("Enter");

  await app.page.waitForFunction(
    () => document.querySelectorAll(".msg.bot").length >= 3,
    undefined,
    { timeout: 20000 },
  );
  await app.page.waitForSelector(".roombar .state.halted", { timeout: 20000 });

  const turns = (await app.page.locator(".roombar .meter .label").first().textContent()) ?? "";
  assert.match(turns, /turns/);
  assert.match(turns, /5 \/ 5/, `expected the turn meter to be full, saw "${turns}"`);
  assert.match((await app.page.locator(".roombar .state").textContent()) ?? "", /ceiling/);
  assert.ok(await app.page.locator("button:has-text('Resume')").isVisible());

  void room;
  assert.deepEqual(app.errors, []);
});

test("step mode releases exactly one turn per click", async (t) => {
  const h = await stage();
  t.after(() => h.cleanup());
  const bots = await Promise.all([
    h.post<{ id: string }>("/api/bots", { name: "Sre" }),
    h.post<{ id: string }>("/api/bots", { name: "Dev" }),
  ]);
  await h.post("/api/rooms", {
    name: "slow party",
    kind: "party",
    stepMode: true,
    ceilings: { maxTurns: 20 },
    participants: bots.map((b) => ({ botId: b.id, noisiness: 1, cooldownTurns: 0 })),
  });

  const app = await openApp(browser, h.url);
  t.after(() => app.close());
  await app.page.waitForSelector(".dot.open");
  await app.page.locator(`.bot:has-text("slow party")`).click();
  await app.page.waitForSelector(".roombar");

  h.setScript(partyScript());
  await app.page.locator("textarea").fill("go");
  await app.page.locator("textarea").press("Enter");

  await app.page.waitForSelector("button:has-text('Next turn')", { timeout: 10000 });
  assert.equal(await app.page.locator(".msg.bot").count(), 0, "nothing runs unasked");

  await app.page.locator("button:has-text('Next turn')").click();
  await app.page.waitForFunction(
    () => document.querySelectorAll(".msg.bot").length === 1,
    undefined,
    { timeout: 10000 },
  );
  await sleep(700);
  assert.equal(await app.page.locator(".msg.bot").count(), 1, "exactly one turn per click");
});

test("halting a party from the room bar stops it and offers a way back", async (t) => {
  const h = await stage();
  t.after(() => h.cleanup());
  const bots = await Promise.all([
    h.post<{ id: string }>("/api/bots", { name: "Sre" }),
    h.post<{ id: string }>("/api/bots", { name: "Dev" }),
  ]);
  await h.post("/api/rooms", {
    name: "runaway",
    kind: "party",
    ceilings: { maxTurns: 100 },
    participants: bots.map((b) => ({ botId: b.id, noisiness: 1, cooldownTurns: 0 })),
  });

  const app = await openApp(browser, h.url);
  t.after(() => app.close());
  await app.page.waitForSelector(".dot.open");
  await app.page.locator(`.bot:has-text("runaway")`).click();

  h.setScript(async (input) => {
    input.onText?.("thinking at length");
    await sleep(20_000, input.signal);
    throw new Error("unreachable");
  });

  await app.page.locator("textarea").fill("start");
  await app.page.locator("textarea").press("Enter");
  await app.page.waitForSelector(".cursor", { timeout: 10000 });

  await app.page.locator("button.halt").click();
  await app.page.waitForSelector(".roombar .state.halted", { timeout: 10000 });
  assert.match((await app.page.locator(".roombar .state").textContent()) ?? "", /halted by you/);
  assert.equal(await app.page.locator(".cursor").count(), 0);
  assert.ok(await app.page.locator("button:has-text('Resume')").isVisible());
});

test("each bot keeps its own conversation", async (t) => {
  const h = await stage();
  t.after(() => h.cleanup());
  await twoBots(h);
  const app = await openApp(browser, h.url);
  t.after(() => app.close());
  await app.page.waitForSelector(".dot.open");

  h.setScript(replies("this is Dev speaking"));
  await app.page.locator(".bot:has-text('Dev')").click();
  await app.page.locator("textarea").fill("hello Dev");
  await app.page.locator("textarea").press("Enter");
  await app.page.waitForFunction(
    () => (document.body.textContent ?? "").includes("this is Dev speaking"),
    undefined,
    { timeout: 10000 },
  );

  await app.page.locator(".bot:has-text('Sre')").click();
  await sleep(500);
  assert.equal(
    (await app.page.locator(".transcript").textContent())?.includes("hello Dev"),
    false,
    "one bot's conversation must not leak into another's",
  );
  assert.equal(await app.page.locator(".msg").count(), 0);
});

test("the timeline explains what a party cost and why it stopped", async (t) => {
  const h = await stage();
  t.after(() => h.cleanup());
  const bots = await Promise.all([
    h.post<{ id: string }>("/api/bots", { name: "Sre" }),
    h.post<{ id: string }>("/api/bots", { name: "Dev" }),
  ]);
  await h.post("/api/rooms", {
    name: "audit me",
    kind: "party",
    ceilings: { maxTurns: 4 },
    participants: bots.map((b) => ({ botId: b.id, noisiness: 1, cooldownTurns: 0 })),
  });

  const app = await openApp(browser, h.url);
  t.after(() => app.close());
  await app.page.waitForSelector(".dot.open");
  await app.page.locator(`.bot:has-text("audit me")`).click();

  h.setScript(partyScript());
  await app.page.locator("textarea").fill("go");
  await app.page.locator("textarea").press("Enter");
  await app.page.waitForSelector(".roombar .state.halted", { timeout: 25000 });

  await app.page.locator("button:has-text('Timeline')").click();
  await app.page.waitForSelector(".tl", { timeout: 8000 });

  const rows = await app.page.locator(".tl tr").count();
  assert.ok(rows >= 4, `expected a row per turn, saw ${rows}`);
  assert.match((await app.page.locator(".tl-summary").textContent()) ?? "", /4 turns/);
  assert.match((await app.page.locator(".tl-summary").textContent()) ?? "", /tokens/);

  const names = await app.page.locator(".tl-who").allTextContents();
  assert.equal(new Set(names).size, 2, "both bots should appear in the audit");

  await app.page.locator("button:has-text('Transcript')").click();
  await app.page.waitForSelector(".transcript", { timeout: 5000 });
  assert.deepEqual(app.errors, []);
});

test("a routine can be created, run and paused from the browser", async (t) => {
  const h = await stage();
  t.after(() => h.cleanup());
  const bots = await Promise.all([
    h.post<{ id: string }>("/api/bots", { name: "Sre" }),
    h.post<{ id: string }>("/api/bots", { name: "Dev" }),
  ]);
  await h.post("/api/rooms", {
    name: "standup",
    kind: "party",
    ceilings: { maxTurns: 2 },
    participants: bots.map((b) => ({ botId: b.id, noisiness: 1, cooldownTurns: 0 })),
  });

  const app = await openApp(browser, h.url);
  t.after(() => app.close());
  await app.page.waitForSelector(".dot.open");

  await app.page.locator("button:has-text('Routines')").click();
  await app.page.waitForSelector("#r-name");

  await app.page.locator("#r-name").fill("morning PR sweep");
  await app.page.locator("#r-prompt").fill("check my open PRs");
  await app.page.locator("#r-time").fill("08:30");
  await app.page.locator("button:has-text('Add routine')").click();

  await app.page.waitForSelector(".tl", { timeout: 8000 });
  const row = (await app.page.locator(".tl tr").first().textContent()) ?? "";
  assert.match(row, /morning PR sweep/);
  assert.match(row, /daily at 08:30/);
  assert.match(row, /next /);

  h.setScript(replies("Two PRs need you."));
  await app.page.locator("button:has-text('Run')").first().click();
  await app.page.waitForFunction(
    () => (document.querySelector(".tl")?.textContent ?? "").includes("ran"),
    undefined,
    { timeout: 10000 },
  );

  await app.page.locator("button:has-text('Pause')").first().click();
  await app.page.waitForFunction(
    () => (document.querySelector(".tl")?.textContent ?? "").includes("paused"),
    undefined,
    { timeout: 8000 },
  );

  const rooms = await h.get<{ id: string; name: string }[]>("/api/rooms");
  const standup = rooms.find((r) => r.name === "standup");
  assert.ok(standup !== undefined, "the party room should still exist");
  const messages = await h.get<{ content: string }[]>(`/api/rooms/${standup.id}/messages`);
  assert.ok(
    messages.some((m) => m.content === "check my open PRs"),
    `the routine prompt should have landed in the room, saw: ${messages.map((m) => m.content).join(" | ")}`,
  );
  assert.deepEqual(app.errors, []);
});
