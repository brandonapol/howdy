# Howdy — tickets

Sized so each is one sitting. `deps` are hard ordering constraints; anything
without a shared dep can be done in any order.

Status: `todo` · `wip` · `done`

---

## M0 — Foundations

### H-1 · Monorepo scaffold — `done`
npm workspaces: `packages/core`, `packages/server`, `packages/web`. Strict TS
(`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), ESM
throughout, `node:test` as the runner (no Jest — it is heavy on an ODROID and we
need zero extra native deps). Root scripts: `build`, `test`, `dev`, `typecheck`.

**Done when:** `npm test` and `npm run typecheck` pass green on an empty suite.

### H-2 · Core domain types — `done`
`packages/core/src/types.ts`. `Bot`, `Room`, `RoomMessage`, `RoomState`,
`Budget`, `TurnRecord`, `Usage`, `Effect`, `RoomEvent`. All `readonly`. No
classes, no I/O, no imports outside `core`.

**Done when:** types compile and `core` has an empty `dependencies` block.

### H-3 · Budget arithmetic — `done`
`packages/core/src/budget.ts`. Pure: `applyUsage`, `remaining`, `exceeded`
returning the *first* breached ceiling, `describeBreach`. Guard against negative
and `NaN` token counts coming back from a truncated SDK result.

**Done when:** unit tests cover each ceiling, plus the zero/negative edges.
deps: H-2

### H-4 · Turn scheduler — `done`
`packages/core/src/scheduler.ts`. The heart of it.
`step(state, event) => [state, effects]`, total and pure, with an injected seeded
RNG. Implements: weighted round-robin, `@mention` override, no-double-turn,
per-bot cooldown, noisiness roll, budget checks, halt propagation, idle-on-stall.

**Done when:** a seeded 200-turn simulation is deterministic and terminates, and
tests cover mention override, cooldown, stall, and each halt reason.
deps: H-2, H-3

### H-5 · Degeneracy detectors — `done`
`packages/core/src/degeneracy.ts`. Pure heuristics over recent messages:
trigram Jaccard repetition, agreement cascade, low-substance chatter. Each
returns a verdict plus a human-readable reason. No model calls, ever.

**Done when:** tests use real transcripts of a good conversation (must not fire)
and a degenerate one (must fire within 4 messages).
deps: H-2

### H-6 · Prompt assembly — `done`
`packages/core/src/prompt.ts`. `buildSystemPrompt(bot, memory, roomCtx)` and
`buildTurnPrompt(recent, speaker)`. Stable content first for cache hits; the
volatile transcript last. Emits the cache breakpoint position rather than calling
the API itself.

**Done when:** snapshot tests prove the prefix is byte-identical across two turns
that differ only in transcript.
deps: H-2

---

## M1 — One bot, one room

### H-7 · SQLite schema + migrations — `done`
`packages/server/src/db/`. Tables: `bots`, `rooms`, `room_participants`,
`messages`, `turns`, `permissions`. FTS5 virtual table over `messages.content`.
WAL, `synchronous=NORMAL`, `busy_timeout`. Forward-only numbered migrations.

**Done when:** migrations run twice with no error, and FTS5 returns a hit.

### H-8 · Hono server + SSE event bus — `done`
`packages/server/src/http/`. `GET /api/stream` SSE with heartbeat and
`Last-Event-ID` replay from a bounded ring buffer. Typed event union shared from
`core`. Serves the built web bundle in production.

**Done when:** two browser tabs both receive an event published from a REPL, and
a killed tab does not leak a listener.
deps: H-2

### H-9 · Agent runner — `done`
`packages/server/src/agent/run.ts`. Wraps `query()` from
`@anthropic-ai/claude-agent-sdk`. Owns the `AbortController` registry, translates
`SDKMessage` into domain events, extracts usage from the result message, and
guarantees the controller is unregistered in a `finally`.

**Verify the real SDK types against `node_modules/@anthropic-ai/claude-agent-sdk`
before writing this — do not trust the docs summary or memory.**

**Done when:** a bot answers "say howdy" end to end, and `abort()` mid-turn kills
the subprocess within 2s.
deps: H-8

### H-10 · Turn queue — `done`
`packages/server/src/orchestrator/queue.ts`. Concurrency 1. Serializes every
agent turn process-wide, surfaces queue depth as an event, drains cleanly on
shutdown. This is the thing standing between a bot party and 4GB of swap death.

**Done when:** ten concurrent turn requests execute strictly in sequence and a
mid-queue halt drops the pending ones.
deps: H-9

### H-11 · Chat UI — `done`
`packages/web`. React + Vite + Tailwind. Room view with streamed messages, bot
sidebar, composer. Consumes the SSE stream via a typed hook with reconnect.

**Done when:** you can hold a real conversation with one bot in a browser.
deps: H-8, H-9

### H-32 · Per-turn watchdog — `done`
A hard timeout on a single agent turn, independent of the room's wall-clock
ceiling. On expiry: abort the subprocess, emit `turnFailed`, release the queue.
Default 180s, per-bot override.

Grok Bot's users report stalled agents as a top-three complaint, and with
concurrency 1 a single hung turn blocks every room on the box. The queue is not
safe to ship without this.

**Done when:** a deliberately hung turn is reaped inside the timeout and the
next queued turn runs.
deps: H-10

---

## M2 — Identity & memory

### H-12 · Bot store — `done`
`packages/server/src/bots/`. CRUD over SQLite plus the on-disk directory
(`personality.md`, `memory.md`, `notes/`, workspace). Creating a bot scaffolds
the directory from a template; deleting archives rather than removes. A file
watcher reloads `personality.md` when you edit it in vim.

**Done when:** editing `personality.md` on disk changes the next turn's behaviour
with no restart.
deps: H-7

### H-13 · `remember` MCP tool — `done`
An in-process MCP server exposing `remember(fact, tags)` which appends a
timestamped line to the bot's `memory.md`, and `recall(query)` backed by FTS5.
Wired into the agent runner's `mcpServers`.

**Done when:** a bot told a fact in room A cites it unprompted in room B.
deps: H-9, H-12

### H-14 · Memory compaction — `done`
Runs after every `remember`. Deduplicates restatements (newest wording wins),
trims the oldest entries past a 200-fact cap, and archives everything it drops
to `memory.archive.md` rather than deleting it.

Built as a pure function with **no model call** — the plan called for a cheap
Haiku pass, but exact-restatement dedupe plus a cap covers the real growth
case, costs nothing, runs instantly on an ODROID, and is deterministic enough
to test. The tradeoff is no semantic merging: "the cluster is prod-eu" and
"we deploy to prod-eu" both survive. Revisit if memory files get noisy.

**Done when:** a 200-line memory file compacts without losing any fact asserted
in a fixture test.
deps: H-13

### H-15 · Bot config UI — `done`
Editor for name, model, effort, noisiness, cooldown, avatar colour, tool
allowlist, and a Markdown editor for `personality.md` with a live token count.

**Done when:** a bot can be created and given a personality without touching a
terminal.
deps: H-11, H-12

---

## M3 — Tools & permissions

### H-16 · Bash command parser + allowlist — `done`
`packages/core/src/bash.ts`. Pure. Splits on pipes, `&&`, `||`, `;`, command
substitution; extracts each invoked binary; classifies against allow/deny lists.
Denylist covers `rm -rf /`, `curl|sh`, `dd`, `mkfs`, fork bombs, and history
rewrites on shared branches.

**Done when:** a fixture table of ~60 commands classifies correctly, including
the nasty nested-substitution cases.
deps: H-2

### H-17 · Permission gate — `done`
`packages/server/src/agent/permissions.ts`. `canUseTool` implementation:
allowlist for Bash, workspace containment (with symlink resolution) for file
tools, SSE prompt for everything else, 120s timeout defaulting to deny,
"always allow" persisted per bot.

**Done when:** a bot is refused `cat /etc/shadow`, allowed `gh pr list`, and an
unattended unknown tool denies on timeout rather than hanging.
deps: H-9, H-16

### H-18 · Permission prompt UI — `done`
Modal showing the bot, the tool, the exact command, and approve / deny / always.
Keyboard-driven. Queues if several arrive.

**Done when:** you can approve a `gh` call from your phone on the LAN.
deps: H-11, H-17

### H-19 · GitHub CLI enablement — `docs done` (ops/GITHUB.md); needs a real ODROID to verify
Document and script `gh auth login` on the ODROID under the service account,
confirm the bots inherit the token, add a `gh`-shaped smoke test.

**Done when:** a bot opens a draft PR on a scratch repo unaided.
deps: H-17

---

## M4 — The party

### H-20 · Orchestrator wiring — `done`
`packages/server/src/orchestrator/`. Binds the pure `step()` to real effects:
enqueue turn, persist message, emit SSE, halt. The impure shell stays thin — if
logic creeps in here instead of `core`, it stops being testable.

**Done when:** a two-bot room runs to a natural stop with no human input.
deps: H-4, H-5, H-10

### H-21 · Killswitch — `done`
Per-room halt and global panic. Aborts in-flight turns, drains the queue, marks
the room, posts a system message. Big red button, `Esc Esc` shortcut, and a
`POST /api/panic` you can `curl` from anywhere on the LAN.

**Done when:** a running party stops within 2s, subprocess included, measured.
deps: H-20

### H-22 · Budget meter UI — `done`
Live tokens/turns/wall-clock against ceilings, per room. Goes amber at 75%,
red at 90%. Shows which ceiling stopped a halted party.

**Done when:** the meter matches the SQLite `turns` totals exactly.
deps: H-11, H-20

### H-23 · Party controls — `done`
Room composer: pick participants, set per-bot noisiness, ceilings, a topic seed,
and step mode. Save as reusable presets.

**Done when:** a saved preset reproduces the same party shape twice.
deps: H-15, H-20

### H-24 · Party observability — `todo`
Timeline view: who spoke, what it cost, which rule fired, why the party stopped.
The thing you actually read when a party goes weird.

**Done when:** every halt reason from H-4 renders with its trigger.
deps: H-22

### H-31 · Global spend governor — `done`
Daily and weekly token ceilings across **every** room, routine and bot, checked
*before* a turn is dispatched rather than after it lands. Rolling windows in
SQLite, a dedicated UI meter, and a hard stop that no room can talk its way past.

This is the single most reported Grok Bot failure: per-conversation limits did
nothing about six agents running all week. Per-room ceilings alone reproduce
that bug exactly.

**Done when:** with a daily cap of 50k, the eleventh 5k-token turn is refused
before it spawns a subprocess, in a different room from the first ten.
deps: H-20

### H-37 · Room goals and completion detection — `done`
A room may carry a goal string. After each round, a cheap Haiku call judges
whether the goal is met and returns `done | continue | stuck`. On `done`, the
party stops and posts a summary.

Today a party that has genuinely finished keeps going until a ceiling or a
detector stops it. The difference between "the bots stopped" and "the bots are
done" is most of the perceived quality.

**Done when:** a room asked to settle one factual question ends on `done` in
fewer turns than its ceiling, and an open-ended room still ends on a ceiling.
deps: H-20

### H-33 · Agent-to-agent handoff — `done`
A `handoff(botSlug, reason)` tool. The handoff is routed **through the
scheduler** as a mention, never as a direct bot-to-bot channel — the research is
clear that per-pair handoffs work for three agents and collapse beyond that, and
routing through `step()` keeps one component owning turn allocation.

**Done when:** a bot hands off mid-party, the named bot speaks next, and the
handoff still respects ceilings and the killswitch.
deps: H-20

### H-35 · Escalation and notification — `todo`
A bot may escalate to a human with a question and park the room in
`awaitingHuman`. Notification via ntfy or a web push subscription so your phone
buzzes on the LAN. This is Grok's "comes back to you only when something needs a
human decision", which is most of why an always-on bot is tolerable.

**Done when:** an escalation reaches a phone and answering it resumes the room.
deps: H-20, H-18

### H-36 · Optional LLM chair — `todo`
Per-room switch from the noisiness roll to a Haiku "chair" that reads the recent
transcript and names the next speaker. Relevance-aware, one cheap call per turn.
Off by default; the cost belongs to the room's own budget.

**Done when:** on a transcript where one bot is obviously the right responder,
the chair picks it and the roll does not.
deps: H-20, H-31

---

## M5 — Ship it

### H-25 · systemd + install — `done`
`ops/howdy.service` (user service, `Restart=on-failure`, memory cap),
`ops/install.sh`, arm64 notes, `claude setup-token` walkthrough, LAN bind and
shared-secret header.

**Done when:** a reboot brings Howdy back with no keyboard involved.

### H-26 · Backup & restore — `done`
`howdy backup` tars the SQLite file (via the online backup API, not `cp`) plus
all bot directories. `howdy restore` puts it back. Weekly timer to a USB mount.

**Done when:** a restore onto a blank box reproduces every bot and transcript.
deps: H-25

---

## M6 — Polish

### H-27 · Transcript export — `todo` — Markdown/JSON export per room.
### H-28 · Bot cloning — `todo` — fork a bot with its personality, fresh memory.
### H-29 · Mobile layout — `todo` — the LAN phone case is the real remote control.
### H-34 · Routines — `todo` — cron-triggered bot tasks ("check my PRs each morning"), each with its own tight budget, all subject to H-31's global governor.
### H-39 · Skills — `todo` — reusable capability packs mounted per bot, via the Agent SDK's skill support.
### H-38 · Preflight estimate — `todo` — before a party starts, estimate its cost from the ceilings and show it. Cheap to build, and it reframes the ceiling as a decision rather than a limit.
### H-30 · Idle chatter mode — `todo` — bots occasionally start their own party on a cron, under a tight daily budget. Fun, and the single most dangerous feature here, so it lands last and off by default.
