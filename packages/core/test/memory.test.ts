import { test } from "node:test";
import assert from "node:assert/strict";
import { compactMemory, parseMemory, renderMemory, searchMemory } from "../dist/index.js";

const raw = `- (2026-09-01) The prod cluster is prod-eu #infra
- (2026-09-02) Brandon prefers functional TypeScript #style
not a memory line
- (2026-09-03) The prod cluster is prod-eu
`;

test("parsing keeps only well-formed lines and extracts tags", () => {
  const entries = parseMemory(raw);
  assert.equal(entries.length, 3);
  assert.equal(entries[0]?.date, "2026-09-01");
  assert.deepEqual(entries[0]?.tags, ["infra"]);
  assert.deepEqual(entries[1]?.tags, ["style"]);
});

test("parsing an empty file yields nothing rather than throwing", () => {
  assert.deepEqual(parseMemory(""), []);
  assert.deepEqual(parseMemory("   \n\n"), []);
});

test("rendering round-trips through parsing, tags included", () => {
  const entries = parseMemory(raw);
  const again = parseMemory(renderMemory(entries));
  assert.deepEqual(again.map((e) => e.text), entries.map((e) => e.text));
  assert.deepEqual(again.map((e) => e.tags), entries.map((e) => e.tags));
});

test("a tag is metadata, not part of the fact", () => {
  const entries = parseMemory("- (2026-09-01) the cluster is prod-eu #infra #urgent\n");
  assert.equal(entries[0]?.text, "the cluster is prod-eu");
  assert.deepEqual(entries[0]?.tags, ["infra", "urgent"]);
});

test("rendering nothing produces an empty file, not a stray newline", () => {
  assert.equal(renderMemory([]), "");
});

test("compaction drops restatements and keeps the newest wording", () => {
  const result = compactMemory(parseMemory(raw), 100);
  assert.equal(result.reason, "duplicates");
  assert.equal(result.kept.length, 2);
  assert.equal(result.dropped.length, 1);
  assert.equal(
    result.kept.find((e) => e.text.includes("prod-eu"))?.date,
    "2026-09-03",
    "the most recent statement of a fact should survive",
  );
});

test("compaction treats punctuation and case as noise", () => {
  const entries = parseMemory(
    `- (2026-09-01) The deploy script lives in ops/deploy.sh
- (2026-09-02) the deploy script lives in ops/deploy.sh!
`,
  );
  assert.equal(compactMemory(entries, 100).kept.length, 1);
});

test("compaction trims the oldest entries once the limit is passed", () => {
  const entries = Array.from({ length: 12 }, (_, i) => ({
    date: "2026-09-01",
    text: `distinct fact number ${i}`,
    tags: [],
  }));
  const result = compactMemory(entries, 5);
  assert.equal(result.reason, "overflow");
  assert.equal(result.kept.length, 5);
  assert.equal(result.kept[0]?.text, "distinct fact number 7");
  assert.equal(result.dropped.length, 7);
});

test("compaction reports when both problems apply", () => {
  const entries = [
    ...Array.from({ length: 8 }, (_, i) => ({ date: "2026-09-01", text: `fact ${i}`, tags: [] })),
    { date: "2026-09-02", text: "fact 0", tags: [] },
  ];
  assert.equal(compactMemory(entries, 3).reason, "both");
});

test("compaction is a no-op on a tidy short file", () => {
  const entries = parseMemory("- (2026-09-01) one thing\n- (2026-09-02) another thing\n");
  const result = compactMemory(entries, 50);
  assert.equal(result.reason, "none");
  assert.deepEqual(result.dropped, []);
  assert.equal(result.kept.length, 2);
});

test("no fact asserted in the fixture is lost to compaction", () => {
  const facts = [
    "the prod cluster is prod-eu",
    "brandon prefers functional typescript",
    "the deploy script lives in ops/deploy.sh",
    "argo runs in the argocd namespace",
  ];
  const entries = facts.flatMap((text, i) => [
    { date: "2026-09-01", text, tags: [] },
    { date: `2026-09-0${i + 2}`, text: `${text}.`, tags: [] },
  ]);
  const kept = compactMemory(entries, 100).kept.map((e) => e.text.toLowerCase().replace(/\.$/, ""));
  for (const fact of facts) assert.ok(kept.includes(fact), `lost: ${fact}`);
});

test("recall ranks by how many query terms match", () => {
  const entries = parseMemory(
    `- (2026-09-01) The prod cluster is prod-eu and runs argo
- (2026-09-02) Brandon prefers functional TypeScript
- (2026-09-03) Argo lives in the argocd namespace
`,
  );
  const hits = searchMemory(entries, "which cluster runs argo");
  assert.ok((hits[0]?.text ?? "").includes("prod-eu"));
  assert.equal(hits.length, 2);
});

test("recall with no useful terms falls back to the most recent entries", () => {
  const entries = parseMemory(
    `- (2026-09-01) one
- (2026-09-02) two
- (2026-09-03) three
`,
  );
  const hits = searchMemory(entries, "is a", 2);
  assert.deepEqual(hits.map((e) => e.text), ["two", "three"]);
});

test("recall on a miss returns nothing rather than everything", () => {
  const entries = parseMemory("- (2026-09-01) the prod cluster is prod-eu\n");
  assert.deepEqual(searchMemory(entries, "kubernetes ingress certificates"), []);
});
