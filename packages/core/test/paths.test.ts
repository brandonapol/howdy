import { test } from "node:test";
import assert from "node:assert/strict";
import { describePath, isContained, normalizePath } from "../dist/index.js";

const WS = "/home/user/.howdy/workspaces/sre";

test("normalizing collapses dots, slashes and traversal", () => {
  assert.equal(normalizePath("/a/./b//c"), "/a/b/c");
  assert.equal(normalizePath("/a/b/../c"), "/a/c");
  assert.equal(normalizePath("/a/b/../../.."), "/");
  assert.equal(normalizePath("a/b/../c"), "a/c");
  assert.equal(normalizePath("/a/b/"), "/a/b");
});

test("paths inside the workspace are contained", () => {
  assert.equal(isContained(WS, WS), true);
  assert.equal(isContained(WS, `${WS}/notes/today.md`), true);
  assert.equal(isContained(WS, `${WS}/`), true);
  assert.equal(isContained(WS, `${WS}/deep/nested/file.ts`), true);
});

test("a sibling directory sharing a prefix is not contained", () => {
  assert.equal(isContained(WS, "/home/user/.howdy/workspaces/sre-evil/x"), false);
  assert.equal(isContained("/a/b", "/a/bc"), false);
});

test("traversal out of the workspace is caught after normalizing", () => {
  assert.equal(isContained(WS, `${WS}/../dev/secrets`), false);
  assert.equal(isContained(WS, `${WS}/notes/../../../../etc/passwd`), false);
  assert.equal(isContained(WS, "/etc/shadow"), false);
});

test("traversal that lands back inside is allowed", () => {
  assert.equal(isContained(WS, `${WS}/notes/../plan.md`), true);
});

test("describePath renders workspace-relative paths for the UI", () => {
  assert.equal(describePath(WS, `${WS}/notes/a.md`), "notes/a.md");
  assert.equal(describePath(WS, WS), ".");
  assert.equal(describePath(WS, "/etc/passwd"), "/etc/passwd");
});
