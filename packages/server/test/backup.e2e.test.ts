import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, listBackups, restore } from "../dist/backup.js";
import { openStream, replies, startHowdy } from "./support/harness.ts";

test("a backup captures every bot and transcript, and restores onto a blank box", async (t) => {
  const source = await startHowdy();
  const bot = await source.post<{ id: string; slug: string }>("/api/bots", { name: "Sre" });
  const stream = await openStream(source.url);
  source.setScript(replies("the prod cluster is prod-eu"));
  await source.post("/api/rooms/general/messages", { text: "which cluster?", botId: bot.id });
  await stream.waitFor("turnFinished");
  stream.close();

  writeFileSync(
    join(source.root, "bots", bot.slug, "personality.md"),
    "# Sre\n\nYou are extremely terse.\n",
  );
  writeFileSync(
    join(source.root, "bots", bot.slug, "memory.md"),
    "- (2026-09-01) The prod cluster is prod-eu\n",
  );

  const vault = mkdtempSync(join(tmpdir(), "howdy-vault-"));
  t.after(() => rmSync(vault, { recursive: true, force: true }));
  const archive = await backup(source.config, vault);
  assert.match(archive, /howdy-.*\.tar\.gz$/);
  assert.equal(listBackups(vault).length, 1);
  await source.cleanup();

  const blank = mkdtempSync(join(tmpdir(), "howdy-blank-"));
  const target = await startHowdy({}, blank);
  assert.deepEqual(await target.get<unknown[]>("/api/bots"), [], "the new box starts empty");
  await target.stop();

  restore(target.config, archive);

  const revived = await startHowdy({}, blank);
  t.after(() => revived.cleanup());

  const bots = await revived.get<{ id: string; slug: string; name: string }[]>("/api/bots");
  assert.deepEqual(bots.map((b) => b.name), ["Sre"]);

  const detail = await revived.get<{ personality: string; memory: string }>(
    `/api/bots/${bots[0]?.id ?? ""}`,
  );
  assert.match(detail.personality, /extremely terse/);
  assert.match(detail.memory, /prod-eu/);

  const messages = await revived.get<{ content: string }[]>("/api/rooms/general/messages");
  assert.deepEqual(messages.map((m) => m.content), ["which cluster?", "the prod cluster is prod-eu"]);

  const hits = await revived.get<unknown[]>("/api/search?q=prod-eu");
  assert.equal(hits.length, 1, "the search index must survive a restore");
});

test("a backup is taken while the server is running, without corrupting it", async (t) => {
  const h = await startHowdy();
  t.after(() => h.cleanup());
  const bot = await h.post<{ id: string }>("/api/bots", { name: "Busy" });
  const stream = await openStream(h.url);
  t.after(() => stream.close());
  h.setScript(replies("still working"));
  await h.post("/api/rooms/general/messages", { text: "go", botId: bot.id });

  const vault = mkdtempSync(join(tmpdir(), "howdy-live-"));
  t.after(() => rmSync(vault, { recursive: true, force: true }));
  const archive = await backup(h.config, vault);

  await stream.waitFor("turnFinished");
  assert.equal(listBackups(vault).length, 1);
  assert.ok(readFileSync(archive).length > 0);

  const after = await h.get<{ ok: boolean }>("/api/health");
  assert.equal(after.ok, true, "the live database must still be usable");
});

test("restoring keeps a copy of what it replaced", async (t) => {
  const h = await startHowdy();
  await h.post("/api/bots", { name: "Original" });
  const vault = mkdtempSync(join(tmpdir(), "howdy-keep-"));
  t.after(() => rmSync(vault, { recursive: true, force: true }));
  const archive = await backup(h.config, vault);
  const root = h.root;
  const config = h.config;
  await h.stop();

  restore(config, archive);
  const revived = await startHowdy({}, root);
  t.after(() => revived.cleanup());
  assert.equal((await revived.get<unknown[]>("/api/bots")).length, 1);
});

test("restoring a missing archive fails loudly", async (t) => {
  const h = await startHowdy();
  t.after(() => h.cleanup());
  assert.throws(() => restore(h.config, "/nope/missing.tar.gz"), /no such archive/);
});

test("listing backups in an empty or missing directory is not an error", () => {
  assert.deepEqual(listBackups("/tmp/howdy-definitely-not-here"), []);
});
