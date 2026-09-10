import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openStream, replies, sleep, startHowdy, usage } from "./support/harness.ts";
import type { Howdy } from "./support/harness.ts";

const newBot = async (h: Howdy, name = "Sre") =>
  (await h.post<{ id: string; slug: string }>("/api/bots", { name }));

test("a full turn runs end to end: request, stream, persist, account", async (t) => {
  const h = await startHowdy();
  t.after(() => h.cleanup());

  const bot = await newBot(h);
  const stream = await openStream(h.url);
  t.after(() => stream.close());

  h.setScript(replies("The presync hook is wedged on a bad entrypoint."));
  await h.post("/api/rooms/general/messages", { text: "why is the deploy stuck?", botId: bot.id });

  await stream.waitFor("turnStarted");
  const chunk = await stream.waitFor("chunk");
  assert.equal(chunk["botId"], bot.id);

  const finished = await stream.waitFor("turnFinished");
  assert.equal((finished["usage"] as { outputTokens: number }).outputTokens, 200);

  const spend = await stream.waitFor("spend");
  assert.equal(spend["tokensToday"], 600);
  assert.equal(spend["ceiling"], 1_000_000);

  const messages = await h.get<{ speakerKind: string; content: string; botId: string | null }[]>(
    "/api/rooms/general/messages",
  );
  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.speakerKind, "human");
  assert.equal(messages[0]?.content, "why is the deploy stuck?");
  assert.equal(messages[1]?.speakerKind, "bot");
  assert.equal(messages[1]?.content, "The presync hook is wedged on a bad entrypoint.");
  assert.equal(messages[1]?.botId, bot.id);
});

test("streamed chunks reassemble into exactly the final message", async (t) => {
  const h = await startHowdy();
  t.after(() => h.cleanup());
  const bot = await newBot(h);
  const stream = await openStream(h.url);
  t.after(() => stream.close());

  const answer = "Checked the cluster, the autoscaler metric is stale by ninety seconds.";
  h.setScript(replies(answer, 6));
  await h.post("/api/rooms/general/messages", { text: "look into it", botId: bot.id });
  await stream.waitFor("turnFinished");

  const assembled = stream.events
    .filter((e) => e.event.kind === "chunk")
    .map((e) => e.event["text"] as string)
    .join("");
  assert.equal(assembled, answer);

  const messages = await h.get<{ content: string }[]>("/api/rooms/general/messages");
  assert.equal(messages[1]?.content, answer);
});

test("halting mid-turn kills the turn and records no bot message", async (t) => {
  const h = await startHowdy();
  t.after(() => h.cleanup());
  const bot = await newBot(h);
  const stream = await openStream(h.url);
  t.after(() => stream.close());

  h.setScript(async (input) => {
    input.onText?.("starting the long job");
    await sleep(30_000, input.signal);
    throw new Error("should never finish");
  });

  await h.post("/api/rooms/general/messages", { text: "do the slow thing", botId: bot.id });
  await stream.waitFor("chunk");

  const stopped = await h.post<{ stopped: number }>("/api/rooms/general/halt");
  assert.ok(stopped.stopped >= 1);
  await stream.waitFor("halted");

  const announce = await stream.waitFor("announce");
  assert.match(String(announce["text"]), /Turn failed/);

  const messages = await h.get<{ speakerKind: string }[]>("/api/rooms/general/messages");
  assert.deepEqual(messages.map((m) => m.speakerKind), ["human"]);
});

test("the watchdog reaps a hung turn without wedging the queue", async (t) => {
  const h = await startHowdy({ turnTimeoutMs: 250 });
  t.after(() => h.cleanup());
  const bot = await newBot(h);
  const stream = await openStream(h.url);
  t.after(() => stream.close());

  h.setScript(async (input) => {
    await sleep(30_000, input.signal);
    throw new Error("unreachable");
  });
  await h.post("/api/rooms/general/messages", { text: "hang please", botId: bot.id });

  const announce = await stream.waitFor("announce");
  assert.match(String(announce["text"]), /watchdog/);

  h.setScript(replies("second turn is fine"));
  await h.post("/api/rooms/general/messages", { text: "and now?", botId: bot.id });
  await stream.waitFor("turnFinished");
  const messages = await h.get<{ content: string }[]>("/api/rooms/general/messages");
  assert.equal(messages.at(-1)?.content, "second turn is fine");
});

test("a tool the bot is not trusted with prompts, and approval lets it through", async (t) => {
  const h = await startHowdy();
  t.after(() => h.cleanup());
  const bot = await newBot(h);
  const stream = await openStream(h.url);
  t.after(() => stream.close());

  h.setScript(async (input) => {
    const decision = await input.canUseTool?.(
      "Bash",
      { command: "terraform apply" },
      { signal: input.signal },
    );
    const allowed = decision?.behavior === "allow";
    return {
      text: allowed ? "terraform ran" : "terraform was refused",
      toolCalls: allowed ? ["Bash"] : [],
      usage: usage(10, 10),
      costUsd: 0,
      sessionId: null,
      isError: false,
      detail: null,
    };
  });

  await h.post("/api/rooms/general/messages", { text: "apply it", botId: bot.id });
  const request = await stream.waitFor("permissionRequest");
  assert.equal(request["tool"], "Bash");
  assert.match(String(request["detail"]), /terraform apply/);

  const pending = await h.get<{ id: string; rule: string }[]>("/api/permissions");
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.rule, "terraform");

  await h.post(`/api/permissions/${String(request["id"])}`, { allowed: true, always: false });
  await stream.waitFor("permissionResolved");
  await stream.waitFor("turnFinished");

  const messages = await h.get<{ content: string }[]>("/api/rooms/general/messages");
  assert.equal(messages.at(-1)?.content, "terraform ran");
});

test("denying a prompt refuses the tool without failing the turn", async (t) => {
  const h = await startHowdy();
  t.after(() => h.cleanup());
  const bot = await newBot(h);
  const stream = await openStream(h.url);
  t.after(() => stream.close());

  h.setScript(async (input) => {
    const decision = await input.canUseTool?.("Bash", { command: "terraform destroy" }, { signal: input.signal });
    return {
      text: decision?.behavior === "deny" ? "refused, standing down" : "ran it",
      toolCalls: [],
      usage: usage(10, 10),
      costUsd: 0,
      sessionId: null,
      isError: false,
      detail: null,
    };
  });

  await h.post("/api/rooms/general/messages", { text: "destroy it", botId: bot.id });
  const request = await stream.waitFor("permissionRequest");
  await h.post(`/api/permissions/${String(request["id"])}`, { allowed: false });
  await stream.waitFor("turnFinished");

  const messages = await h.get<{ content: string }[]>("/api/rooms/general/messages");
  assert.equal(messages.at(-1)?.content, "refused, standing down");
});

test("an allowlisted command never reaches the operator", async (t) => {
  const h = await startHowdy();
  t.after(() => h.cleanup());
  const bot = await newBot(h);
  const stream = await openStream(h.url);
  t.after(() => stream.close());

  h.setScript(async (input) => {
    const decision = await input.canUseTool?.("Bash", { command: "gh pr list" }, { signal: input.signal });
    return {
      text: `behaviour=${decision?.behavior ?? "none"}`,
      toolCalls: ["Bash"],
      usage: usage(10, 10),
      costUsd: 0,
      sessionId: null,
      isError: false,
      detail: null,
    };
  });

  await h.post("/api/rooms/general/messages", { text: "list prs", botId: bot.id });
  await stream.waitFor("turnFinished");
  assert.equal(stream.kinds().includes("permissionRequest"), false);
  const messages = await h.get<{ content: string }[]>("/api/rooms/general/messages");
  assert.equal(messages.at(-1)?.content, "behaviour=allow");
});

test("a forbidden command is refused by the server, not by the operator", async (t) => {
  const h = await startHowdy();
  t.after(() => h.cleanup());
  const bot = await newBot(h);
  const stream = await openStream(h.url);
  t.after(() => stream.close());

  h.setScript(async (input) => {
    const decision = await input.canUseTool?.("Bash", { command: "sudo rm -rf /" }, { signal: input.signal });
    return {
      text: decision?.behavior === "deny" ? "blocked" : "escaped",
      toolCalls: [],
      usage: usage(10, 10),
      costUsd: 0,
      sessionId: null,
      isError: false,
      detail: null,
    };
  });

  await h.post("/api/rooms/general/messages", { text: "nuke it", botId: bot.id });
  await stream.waitFor("turnFinished");
  assert.equal(stream.kinds().includes("permissionRequest"), false, "hard denials must not prompt");
  const messages = await h.get<{ content: string }[]>("/api/rooms/general/messages");
  assert.equal(messages.at(-1)?.content, "blocked");
});

test("the daily ceiling refuses the next turn once it is spent", async (t) => {
  const h = await startHowdy({ dailyTokenCeiling: 500 });
  t.after(() => h.cleanup());
  const bot = await newBot(h);
  const stream = await openStream(h.url);
  t.after(() => stream.close());

  h.setScript(replies("first and only"));
  await h.post("/api/rooms/general/messages", { text: "one", botId: bot.id });
  await stream.waitFor("spend");

  await assert.rejects(
    () => h.post("/api/rooms/general/messages", { text: "two", botId: bot.id }),
    (e: unknown) => (e as { status: number }).status === 429,
  );

  const messages = await h.get<unknown[]>("/api/rooms/general/messages");
  assert.equal(messages.length, 2, "the refused turn must not have been recorded");
});

test("turns run one at a time even when several rooms ask at once", async (t) => {
  const h = await startHowdy();
  t.after(() => h.cleanup());
  const bot = await newBot(h);

  let concurrent = 0;
  let peak = 0;
  h.setScript(async (input) => {
    concurrent += 1;
    peak = Math.max(peak, concurrent);
    await sleep(40, input.signal);
    concurrent -= 1;
    return {
      text: "done",
      toolCalls: [],
      usage: usage(10, 10),
      costUsd: 0,
      sessionId: null,
      isError: false,
      detail: null,
    };
  });

  await Promise.all(
    ["a", "b", "c", "d"].map((room) =>
      h.post(`/api/rooms/${room}/messages`, { text: "go", botId: bot.id }),
    ),
  );
  await sleep(600);
  assert.equal(peak, 1, "concurrency must stay at one to protect 4GB of RAM");
  for (const room of ["a", "b", "c", "d"]) {
    const messages = await h.get<unknown[]>(`/api/rooms/${room}/messages`);
    assert.equal(messages.length, 2, `room ${room} should have both messages`);
  }
});

test("a reconnecting client replays exactly what it missed", async (t) => {
  const h = await startHowdy();
  t.after(() => h.cleanup());
  const bot = await newBot(h);

  const first = await openStream(h.url);
  h.setScript(replies("one"));
  await h.post("/api/rooms/general/messages", { text: "first", botId: bot.id });
  await first.waitFor("turnFinished");
  const lastSeen = first.events.at(-1)?.id ?? 0;
  first.close();

  h.setScript(replies("two"));
  await h.post("/api/rooms/general/messages", { text: "second", botId: bot.id });
  await sleep(300);

  const resumed = await openStream(h.url, lastSeen);
  t.after(() => resumed.close());
  await resumed.waitFor("turnFinished");
  assert.ok(resumed.events.every((e) => e.id > lastSeen), "must not replay already-seen events");
  assert.ok(resumed.events.length > 0);
});

test("everything survives a restart on the same database", async (t) => {
  const first = await startHowdy();
  const bot = await newBot(first, "Persistent");
  const stream = await openStream(first.url);
  first.setScript(replies("remember me"));
  await first.post("/api/rooms/general/messages", { text: "hello", botId: bot.id });
  await stream.waitFor("turnFinished");
  stream.close();
  const root = first.root;
  await first.stop();

  const second = await startHowdy({}, root);
  t.after(() => second.cleanup());
  const bots = await second.get<{ name: string }[]>("/api/bots");
  assert.deepEqual(bots.map((b) => b.name), ["Persistent"]);
  const messages = await second.get<{ content: string }[]>("/api/rooms/general/messages");
  assert.deepEqual(messages.map((m) => m.content), ["hello", "remember me"]);
});

test("creating a bot scaffolds a real workspace and an editable personality", async (t) => {
  const h = await startHowdy();
  t.after(() => h.cleanup());
  const bot = await h.post<{ id: string; slug: string; workspacePath: string }>("/api/bots", {
    name: "Filesystem Bot",
  });
  assert.equal(bot.slug, "filesystem-bot");

  const onDisk = readFileSync(join(h.root, "bots", bot.slug, "personality.md"), "utf8");
  assert.match(onDisk, /Filesystem Bot/);

  const detail = await h.get<{ personality: string }>(`/api/bots/${bot.id}`);
  assert.equal(detail.personality, onDisk);
});

test("the personality on disk is what the turn is actually given", async (t) => {
  const h = await startHowdy();
  t.after(() => h.cleanup());
  const bot = await newBot(h, "Terse");

  await fetch(`${h.url}/api/bots/${bot.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ personality: "You answer in exactly three words." }),
  });

  let seen = "";
  h.setScript(async (input) => {
    seen = input.systemPrompt;
    return {
      text: "three words only",
      toolCalls: [],
      usage: usage(1, 1),
      costUsd: 0,
      sessionId: null,
      isError: false,
      detail: null,
    };
  });

  const stream = await openStream(h.url);
  t.after(() => stream.close());
  await h.post("/api/rooms/general/messages", { text: "hi", botId: bot.id });
  await stream.waitFor("turnFinished");

  assert.match(seen, /You answer in exactly three words\./);
  assert.match(seen, /You are Terse\./);
});

test("the turn prompt carries the conversation so far", async (t) => {
  const h = await startHowdy();
  t.after(() => h.cleanup());
  const bot = await newBot(h);
  const stream = await openStream(h.url);
  t.after(() => stream.close());

  h.setScript(replies("noted"));
  await h.post("/api/rooms/general/messages", { text: "the cluster is prod-eu", botId: bot.id });
  await stream.waitFor("turnFinished");

  let prompt = "";
  h.setScript(async (input) => {
    prompt = input.prompt;
    return {
      text: "prod-eu",
      toolCalls: [],
      usage: usage(1, 1),
      costUsd: 0,
      sessionId: null,
      isError: false,
      detail: null,
    };
  });
  await h.post("/api/rooms/general/messages", { text: "which cluster?", botId: bot.id });
  await sleep(300);

  assert.match(prompt, /the cluster is prod-eu/);
  assert.match(prompt, /noted/);
  assert.match(prompt, /which cluster\?/);
});

test("the bot runs with its own workspace as the working directory", async (t) => {
  const h = await startHowdy();
  t.after(() => h.cleanup());
  const one = await newBot(h, "One");
  const two = await newBot(h, "Two");

  const cwds: string[] = [];
  h.setScript(async (input) => {
    cwds.push(input.cwd);
    return {
      text: "ok",
      toolCalls: [],
      usage: usage(1, 1),
      costUsd: 0,
      sessionId: null,
      isError: false,
      detail: null,
    };
  });

  await h.post("/api/rooms/general/messages", { text: "a", botId: one.id });
  await sleep(200);
  await h.post("/api/rooms/general/messages", { text: "b", botId: two.id });
  await sleep(300);

  assert.equal(cwds.length, 2);
  assert.match(cwds[0] ?? "", /workspaces\/one$/);
  assert.match(cwds[1] ?? "", /workspaces\/two$/);
  assert.notEqual(cwds[0], cwds[1], "bots must not share a workspace");
});

test("full text search finds something a bot said earlier", async (t) => {
  const h = await startHowdy();
  t.after(() => h.cleanup());
  const bot = await newBot(h);
  const stream = await openStream(h.url);
  t.after(() => stream.close());

  h.setScript(replies("The autoscaler metric adapter caches for sixty seconds."));
  await h.post("/api/rooms/general/messages", { text: "why is scaling laggy", botId: bot.id });
  await stream.waitFor("turnFinished");

  const hits = await h.get<{ content: string }[]>("/api/search?q=autoscaler");
  assert.equal(hits.length, 1);
  assert.match(hits[0]?.content ?? "", /sixty seconds/);
});

test("panic stops everything across every room at once", async (t) => {
  const h = await startHowdy();
  t.after(() => h.cleanup());
  const bot = await newBot(h);
  const stream = await openStream(h.url);
  t.after(() => stream.close());

  h.setScript(async (input) => {
    input.onText?.("working");
    await sleep(30_000, input.signal);
    throw new Error("unreachable");
  });
  await h.post("/api/rooms/one/messages", { text: "go", botId: bot.id });
  await h.post("/api/rooms/two/messages", { text: "go", botId: bot.id });
  await stream.waitFor("chunk");

  const result = await h.post<{ stopped: number }>("/api/panic");
  assert.equal(result.stopped, 2, "both the running and the queued turn must stop");
  await sleep(200);
  assert.equal((await h.get<{ queueDepth: number }>("/api/health")).queueDepth, 0);
});
