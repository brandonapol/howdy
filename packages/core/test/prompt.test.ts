import { test } from "node:test";
import assert from "node:assert/strict";
import { botId, buildSystemPrompt, buildTurnPrompt, extractMentions } from "../dist/index.js";
import type { Bot } from "../dist/index.js";
import { botMessage, humanMessage } from "./helpers.ts";

const bot: Bot = {
  id: botId("b1"),
  slug: "sre",
  name: "Sre",
  model: "claude-sonnet-5",
  effort: "medium",
  noisiness: 0.7,
  cooldownTurns: 1,
  avatarColor: "#8899aa",
  botDir: "/home/user/.howdy/bots/sre",
  workspacePath: "/home/user/.howdy/workspaces/sre",
  allowedCommands: ["gh", "git"],
  enabled: true,
};

const context = {
  roomName: "deploys",
  goal: null,
  participants: ["Dev"],
  isParty: true,
};

test("the stable prefix is byte-identical across turns that differ only in memory", () => {
  const a = buildSystemPrompt(bot, "You are terse.", "fact one", context);
  const b = buildSystemPrompt(bot, "You are terse.", "fact one\nfact two", context);
  assert.equal(a.stablePrefixLength, b.stablePrefixLength);
  assert.equal(
    a.text.slice(0, a.stablePrefixLength),
    b.text.slice(0, b.stablePrefixLength),
  );
});

test("the personality and workspace both land in the stable prefix", () => {
  const p = buildSystemPrompt(bot, "You are terse and dry.", "", context);
  const prefix = p.text.slice(0, p.stablePrefixLength);
  assert.match(prefix, /You are Sre\./);
  assert.match(prefix, /terse and dry/);
  assert.match(prefix, /workspaces\/sre/);
});

test("party rules apply in a party and solo rules apply one to one", () => {
  const party = buildSystemPrompt(bot, "p", "", context);
  assert.match(party.text, /room with other bots/);
  assert.match(party.text, /Do not thank, congratulate/);

  const solo = buildSystemPrompt(bot, "p", "", { ...context, isParty: false, participants: [] });
  assert.match(solo.text, /one to one with a human/);
  assert.doesNotMatch(solo.text, /Do not thank, congratulate/);
});

test("an empty memory leaves no dangling header", () => {
  const p = buildSystemPrompt(bot, "p", "   ", context);
  assert.doesNotMatch(p.text, /What you remember/);
});

test("a goal is included only when set", () => {
  assert.doesNotMatch(buildSystemPrompt(bot, "p", "", context).text, /^Goal:/m);
  assert.match(
    buildSystemPrompt(bot, "p", "", { ...context, goal: "unstick the deploy" }).text,
    /Goal: unstick the deploy/,
  );
});

test("the turn prompt renders a labelled transcript and asks for a turn", () => {
  const prompt = buildTurnPrompt(
    [humanMessage("why is it stuck"), botMessage("b1", "Checking the hook now.")],
    (id) => (id === "b1" ? "Sre" : id),
  );
  assert.match(prompt, /Human: why is it stuck/);
  assert.match(prompt, /Sre: Checking the hook now\./);
  assert.match(prompt, /Your turn\.$/);
});

test("the turn prompt keeps only the most recent window", () => {
  const many = Array.from({ length: 30 }, (_, i) => humanMessage(`line ${i}`));
  const prompt = buildTurnPrompt(many, (id) => id, 5);
  assert.doesNotMatch(prompt, /line 24/);
  assert.match(prompt, /line 25/);
  assert.match(prompt, /line 29/);
});

test("an empty room prompts an opener", () => {
  assert.equal(buildTurnPrompt([], (id) => id), "Open the conversation.");
});

test("mentions resolve known slugs, ignore unknown ones, and never duplicate", () => {
  const slugs = new Map([["sre", "b1"], ["dev", "b2"]]);
  assert.deepEqual(extractMentions("hey @sre and @dev", slugs), ["b1", "b2"]);
  assert.deepEqual(extractMentions("@sre @sre again", slugs), ["b1"]);
  assert.deepEqual(extractMentions("@nobody here", slugs), []);
  assert.deepEqual(extractMentions("email me at a@dev.com", slugs), []);
  assert.deepEqual(extractMentions("(@dev) and, @sre", slugs), ["b2", "b1"]);
});

test("mentions are case insensitive", () => {
  assert.deepEqual(extractMentions("@SRE look", new Map([["sre", "b1"]])), ["b1"]);
});
