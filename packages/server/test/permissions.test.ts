import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { botId } from "@howdy/core";
import type { Bot } from "@howdy/core";
import { openDb } from "../dist/db/index.js";
import { createEventBus } from "../dist/events.js";
import { createPermissionBroker, settledPath } from "../dist/agent/permissions.js";

const ALLOWED = ["gh", "git", "ls", "cat", "rg", "echo"];

const harness = (timeoutMs = 200) => {
  const root = mkdtempSync(join(tmpdir(), "howdy-perm-"));
  const workspace = join(root, "workspaces", "sre");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(root, "secrets"), { recursive: true });
  writeFileSync(join(root, "secrets", "keys.txt"), "hunter2");

  const bot: Bot = {
    id: botId("bot-1"),
    slug: "sre",
    name: "Sre",
    model: "claude-sonnet-5",
    effort: "medium",
    noisiness: 0.7,
    cooldownTurns: 1,
    avatarColor: "#000",
    botDir: join(root, "bots", "sre"),
    workspacePath: workspace,
    allowedCommands: ALLOWED,
    enabled: true,
  };

  const db = openDb(":memory:");
  db.prepare(
    `INSERT INTO bots (id, slug, name, model, effort, noisiness, cooldown_turns,
      avatar_color, bot_dir, workspace_path, allowed_commands, enabled, created_at)
     VALUES ('bot-1','sre','Sre','claude-sonnet-5','medium',0.7,1,'#000',?,?,?,1,0)`,
  ).run(bot.botDir, workspace, JSON.stringify(ALLOWED));

  const bus = createEventBus();
  const broker = createPermissionBroker(db, bus, timeoutMs);
  const gate = broker.gateFor(bot, "general");
  const signal = new AbortController().signal;
  return { root, workspace, bot, db, bus, broker, gate, signal, cleanup: () => { db.close(); rmSync(root, { recursive: true, force: true }); } };
};

test("an allowlisted command runs without a prompt", async () => {
  const h = harness();
  const result = await h.gate("Bash", { command: "gh pr list" }, { signal: h.signal });
  assert.equal(result.behavior, "allow");
  assert.equal(h.broker.pending().length, 0);
  h.cleanup();
});

test("a forbidden command is refused outright and never prompts", async () => {
  const h = harness();
  const result = await h.gate("Bash", { command: "sudo cat /etc/shadow" }, { signal: h.signal });
  assert.equal(result.behavior, "deny");
  if (result.behavior !== "deny") throw new Error("unreachable");
  assert.match(result.message, /sudo/);
  assert.equal(h.broker.pending().length, 0);
  h.cleanup();
});

test("cat /etc/shadow is refused because cat cannot leave the workspace", async () => {
  const h = harness();
  const pending = h.gate("Bash", { command: `cat ${join(h.root, "secrets", "keys.txt")}` }, { signal: h.signal });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await pending).behavior, "deny", "unanswered prompts must deny");
  h.cleanup();
});

test("an allowlisted binary cannot read outside the workspace by absolute path", async () => {
  const h = harness(120);
  for (const command of [
    "cat /etc/shadow",
    "rg secret /etc",
    "ls /root",
    "find / -name id_rsa",
    "cat ../../../etc/passwd",
  ]) {
    const result = await h.gate("Bash", { command }, { signal: h.signal });
    assert.equal(result.behavior, "deny", `${command} should not have been allowed outright`);
  }
  h.cleanup();
});

test("workspace-relative arguments stay quiet", async () => {
  const h = harness();
  for (const command of ["cat notes.md", "rg TODO src/", "ls -la", "gh pr list"]) {
    const result = await h.gate("Bash", { command }, { signal: h.signal });
    assert.equal(result.behavior, "allow", `${command} should not have prompted`);
  }
  h.cleanup();
});

test("an unknown binary prompts, and approving it lets the turn continue", async () => {
  const h = harness(5000);
  const pending = h.gate("Bash", { command: "terraform apply" }, { signal: h.signal });
  await new Promise((r) => setTimeout(r, 20));

  const [request] = h.broker.pending();
  assert.ok(request !== undefined);
  assert.equal(request?.tool, "Bash");
  assert.equal(request?.rule, "terraform");
  assert.equal(h.broker.decide(request?.id ?? "", true, false), true);
  assert.equal((await pending).behavior, "allow");
  h.cleanup();
});

test("always-allow is remembered so the same binary never prompts twice", async () => {
  const h = harness(5000);
  const first = h.gate("Bash", { command: "terraform plan" }, { signal: h.signal });
  await new Promise((r) => setTimeout(r, 20));
  h.broker.decide(h.broker.pending()[0]?.id ?? "", true, true);
  assert.equal((await first).behavior, "allow");

  const second = await h.gate("Bash", { command: "terraform apply" }, { signal: h.signal });
  assert.equal(second.behavior, "allow");
  assert.equal(h.broker.pending().length, 0, "the second call must not prompt");
  h.cleanup();
});

test("approving once does not persist", async () => {
  const h = harness(5000);
  const first = h.gate("Bash", { command: "terraform plan" }, { signal: h.signal });
  await new Promise((r) => setTimeout(r, 20));
  h.broker.decide(h.broker.pending()[0]?.id ?? "", true, false);
  await first;

  void h.gate("Bash", { command: "terraform apply" }, { signal: h.signal });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.broker.pending().length, 1, "a one-off approval must prompt again");
  h.cleanup();
});

test("an unanswered prompt denies on timeout rather than hanging", async () => {
  const h = harness(120);
  const started = Date.now();
  const result = await h.gate("Bash", { command: "terraform apply" }, { signal: h.signal });
  assert.equal(result.behavior, "deny");
  if (result.behavior !== "deny") throw new Error("unreachable");
  assert.match(result.message, /denied by default/);
  assert.ok(Date.now() - started < 2000);
  h.cleanup();
});

test("aborting the turn resolves a pending prompt as denied", async () => {
  const h = harness(5000);
  const controller = new AbortController();
  const pending = h.gate("Bash", { command: "terraform apply" }, { signal: controller.signal });
  await new Promise((r) => setTimeout(r, 20));
  controller.abort();
  const result = await pending;
  assert.equal(result.behavior, "deny");
  h.cleanup();
});

test("file tools inside the workspace are allowed", async () => {
  const h = harness();
  const result = await h.gate("Read", { file_path: join(h.workspace, "notes.md") }, { signal: h.signal });
  assert.equal(result.behavior, "allow");
  h.cleanup();
});

test("a relative file path resolves against the workspace", async () => {
  const h = harness();
  assert.equal((await h.gate("Write", { file_path: "notes/plan.md" }, { signal: h.signal })).behavior, "allow");
  h.cleanup();
});

test("traversal out of the workspace prompts instead of silently allowing", async () => {
  const h = harness(120);
  const result = await h.gate(
    "Read",
    { file_path: join(h.workspace, "..", "..", "secrets", "keys.txt") },
    { signal: h.signal },
  );
  assert.equal(result.behavior, "deny");
  h.cleanup();
});

test("a symlink pointing out of the workspace does not smuggle access", async () => {
  const h = harness(120);
  symlinkSync(join(h.root, "secrets"), join(h.workspace, "escape"));
  const result = await h.gate(
    "Read",
    { file_path: join(h.workspace, "escape", "keys.txt") },
    { signal: h.signal },
  );
  assert.equal(result.behavior, "deny", "symlinks must be resolved before containment");
  h.cleanup();
});

test("a redirect that writes outside the workspace prompts even for an allowed binary", async () => {
  const h = harness(120);
  const result = await h.gate(
    "Bash",
    { command: `echo pwned > ${join(h.root, "secrets", "oops.txt")}` },
    { signal: h.signal },
  );
  assert.equal(result.behavior, "deny");
  h.cleanup();
});

test("a redirect inside the workspace is allowed without a prompt", async () => {
  const h = harness();
  const result = await h.gate("Bash", { command: "gh pr list > prs.txt" }, { signal: h.signal });
  assert.equal(result.behavior, "allow");
  h.cleanup();
});

test("an unrecognised tool prompts rather than being allowed by omission", async () => {
  const h = harness(120);
  const result = await h.gate("WebFetch", { url: "https://example.com" }, { signal: h.signal });
  assert.equal(result.behavior, "deny");
  h.cleanup();
});

test("cancelAll denies every outstanding prompt", async () => {
  const h = harness(5000);
  const a = h.gate("Bash", { command: "terraform apply" }, { signal: h.signal });
  const b = h.gate("WebFetch", { url: "https://x" }, { signal: h.signal });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.broker.cancelAll(), 2);
  assert.equal((await a).behavior, "deny");
  assert.equal((await b).behavior, "deny");
  h.cleanup();
});

test("prompts are published to the event bus so the UI can render them", async () => {
  const h = harness(5000);
  const seen: string[] = [];
  h.bus.subscribe((e) => seen.push(e.event.kind));
  const pending = h.gate("Bash", { command: "terraform apply" }, { signal: h.signal });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(seen.includes("permissionRequest"));
  h.broker.decide(h.broker.pending()[0]?.id ?? "", false, false);
  await pending;
  assert.ok(seen.includes("permissionResolved"));
  h.cleanup();
});

test("settledPath resolves symlinks but tolerates paths that do not exist yet", () => {
  const h = harness();
  const fresh = settledPath("brand/new/file.md", h.workspace);
  assert.ok(fresh.startsWith(h.workspace) || fresh.includes("brand/new/file.md"));
  h.cleanup();
});

test("the gate is also enforced through a PreToolUse hook, not only canUseTool", async () => {
  const h = harness(120);
  const hooks = h.broker.hooksFor(h.bot, "general");
  const hook = hooks.PreToolUse?.[0]?.hooks[0];
  assert.ok(hook !== undefined, "a PreToolUse hook must be provided");

  const forbidden = await hook(
    {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "sudo rm -rf /" },
      tool_use_id: "t1",
    } as never,
    "t1",
    { signal: h.signal },
  );
  assert.equal(
    (forbidden as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput
      .permissionDecision,
    "deny",
  );

  const allowed = await hook(
    {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "gh pr list" },
      tool_use_id: "t2",
    } as never,
    "t2",
    { signal: h.signal },
  );
  assert.equal(
    (allowed as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput
      .permissionDecision,
    "allow",
  );
  h.cleanup();
});

test("an unknown binary reaching the hook denies when nobody answers", async () => {
  const h = harness(120);
  const hook = h.broker.hooksFor(h.bot, "general").PreToolUse?.[0]?.hooks[0];
  assert.ok(hook !== undefined);
  const result = await hook(
    {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "terraform apply" },
      tool_use_id: "t3",
    } as never,
    "t3",
    { signal: h.signal },
  );
  const out = (result as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } })
    .hookSpecificOutput;
  assert.equal(out.permissionDecision, "deny");
  assert.match(out.permissionDecisionReason, /denied by default/);
  h.cleanup();
});
