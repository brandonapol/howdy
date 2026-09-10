# Howdy — a local bot party

A self-hosted, LAN-only app for running a small cast of persistent Claude-backed
bots. You chat with them individually, you configure them, they remember things
across restarts, they have real CLI access (including `gh`), and you can put them
in a room together without the conversation degenerating into a token bonfire.

Runs on an ODROID (arm64, 4GB RAM, eMMC). Never exposed to the internet.

---

## 1. Design constraints

These drive nearly every decision below.

| Constraint | Consequence |
| --- | --- |
| 4GB RAM, arm64 | One agent subprocess at a time. Avoid native deps without arm64 prebuilds. No vector DB, no embedded model. |
| eMMC storage | Limited write endurance. SQLite in WAL with `synchronous=NORMAL`, no per-token disk logging, rotate transcripts. |
| LAN-only, single user | No multi-tenant auth, no TLS termination, no rate limiting. One shared-secret header, and that is generosity. |
| Token spend is the top worry | Budgets are a first-class domain object, not a config afterthought. Every loop has a hard ceiling. |
| Bots need real CLI access | Agent SDK with a permission gate, not a hand-rolled shell tool. |
| Functional style | Pure reducers for orchestration, effects pushed to the edges, `readonly` types throughout. |

## 2. Resolved decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Agent engine | `@anthropic-ai/claude-agent-sdk` | Claude Code as a library. Bash/Read/Write/Edit/Grep/Glob, permission hooks, session resume, MCP — all shipped. `gh` access is free via Bash. |
| Auth | Claude subscription OAuth | Flat-rate against the plan instead of metered billing. Directly answers the token-burn worry. Token minted on the ODROID, stored `chmod 600`. |
| Default model | `claude-sonnet-5` per bot, opt-up to `claude-opus-5` | Most party turns are conversational. Workers that touch `gh` get bumped in their own config. |
| Sandbox | Per-bot workspace + Bash allowlist | Each bot lives in `~/.howdy/workspaces/<slug>`. Anything outside the allowlist raises a UI prompt. |
| Transport | SSE down, POST up | Only server→client push is needed. SSE reconnects on its own and survives an ODROID hiccup better than a WebSocket. |
| Persistence | SQLite (`better-sqlite3`) + flat Markdown | Structured state in SQLite; identity and memory as files you can edit in vim. |

## 3. Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Browser (LAN)                                               │
│  React + Vite. Room view, bot editor, budget meter,          │
│  permission prompts, the big red HALT button.                │
└───────────────┬──────────────────────────────┬───────────────┘
                │ POST /api/*                  │ GET /api/stream (SSE)
┌───────────────▼──────────────────────────────▼───────────────┐
│  Node 22 · Hono · single process                             │
│                                                              │
│  ┌────────────┐   ┌──────────────┐   ┌───────────────────┐   │
│  │ HTTP layer │──▶│ Orchestrator │──▶│  Turn queue       │   │
│  │ (routes)   │   │ (impure)     │   │  concurrency = 1  │   │
│  └────────────┘   └──────┬───────┘   └─────────┬─────────┘   │
│                          │                     │             │
│                   ┌──────▼───────┐    ┌────────▼─────────┐   │
│                   │  scheduler   │    │  Agent runner    │   │
│                   │  (PURE)      │    │  query() + abort │   │
│                   │  who speaks  │    └────────┬─────────┘   │
│                   │  budgets     │             │             │
│                   │  halts       │    ┌────────▼─────────┐   │
│                   └──────────────┘    │ Permission gate  │   │
│                                       │ canUseTool       │   │
│  ┌────────────┐  ┌──────────────┐     └────────┬─────────┘   │
│  │  SQLite    │  │ Event bus    │              │             │
│  │  rooms     │  │ (SSE fanout) │              │             │
│  │  messages  │  └──────────────┘              │             │
│  │  turns     │                                │             │
│  └────────────┘                                │             │
└────────────────────────────────────────────────┼─────────────┘
                                                 │ subprocess
                              ┌──────────────────▼──────────────┐
                              │ claude agent, cwd=bot workspace │
                              │ Bash(gh,git,rg,…) Read Write    │
                              └─────────────────────────────────┘
```

### Package layout

```
howdy/
├── packages/
│   ├── core/      pure domain — types, scheduler, budgets, prompt assembly
│   ├── server/    Hono HTTP, SQLite, agent runner, permission gate, SSE
│   └── web/       React + Vite UI
├── docs/
└── ops/           systemd unit, install notes
```

`core` has zero I/O and zero dependencies. Everything in it is a pure function
over plain data, which is what makes the party rules testable without spending
a single token.

## 4. Bot identity and memory

Each bot is a directory you can edit by hand:

```
~/.howdy/bots/<slug>/
├── personality.md    identity, voice, rules — YOU write this, never overwritten
├── memory.md         append-only facts the bot learned — the bot writes this
└── notes/            freeform scratch the bot owns
~/.howdy/workspaces/<slug>/   the bot's cwd for all tool use
```

Three memory layers, assembled by a pure `buildSystemPrompt`:

1. **`personality.md`** — verbatim, first in the prompt, behind a `cache_control`
   breakpoint so it caches. Never written by the bot.
2. **`memory.md`** — appended via a `remember` MCP tool the bot is given. When it
   exceeds a token threshold, a background compaction pass rewrites it into
   deduplicated bullets. Every compaction keeps a timestamped backup.
3. **Working context** — the last K messages of the room, plus SQLite FTS5 recall
   of older messages matching the current topic. FTS5 rather than embeddings:
   no model to host, no index to rebuild, and it is genuinely good enough for
   "what did we decide about the deploy script".

The Agent SDK's own session resume handles within-conversation continuity; layers
1-3 handle continuity *across* sessions and *across* rooms, which session resume
does not give you.

## 5. The party problem

This is the part worth getting right. Two bots left alone will happily agree with
each other in progressively longer paragraphs until the budget is gone.

Turn selection is a **pure reducer**:

```ts
step(state: RoomState, event: RoomEvent): readonly [RoomState, readonly Effect[]]
```

No timers, no I/O, no randomness inside — the RNG is injected as a seed. That
means the entire party dynamic is unit-testable, and a runaway loop can be
reproduced from a seed instead of guessed at.

### Rails, in order of bluntness

1. **Killswitch** — `POST /api/rooms/:id/halt` flips status to `halted` and calls
   `abort()` on the in-flight turn's `AbortController`, which kills the
   subprocess. A global panic halts every room. Bound to a UI button and to
   `Esc Esc`. Nothing is graceful about it, by design.

2. **Hard budgets** — a party stops when *any* ceiling is hit:
   `maxTurns` (default 20), `maxTokens` (default 100k), `maxWallClockMs`
   (default 10min), `maxToolCallsPerTurn` (default 15). On hit: halt, post a
   system message naming the ceiling, and optionally ask one bot for a wrap-up.

3. **Noisiness** — per-bot `0.0–1.0`. A bot offered a turn takes it with
   probability `noisiness × relevance`. At `0.2` a bot is a lurker who speaks
   when spoken to; at `1.0` it never passes. This is the knob for "helpful but
   not chatty".

4. **Speaker selection** — weighted round-robin, with overrides:
   - an `@mention` always wins the next turn
   - no bot speaks twice in a row while another is willing
   - per-bot cooldown of N turns

5. **Degeneracy detectors** — cheap, run before spending a turn, no model call:
   - *repetition*: trigram Jaccard similarity between the candidate's last message
     and the previous five > `0.6` → halt(`repetition`)
   - *agreement cascade*: three consecutive messages that open with agreement and
     introduce no new named entities → decay all noisiness by half, then halt if
     it recurs
   - *chatter*: three consecutive messages under 200 chars with no tool use and
     no question → decay noisiness
   - *stall*: nobody willing to speak → idle the room rather than forcing a turn

6. **Step mode** — optional. Every bot turn waits for a click. The debugger for
   when a party is behaving strangely and you want to watch it frame by frame.

7. **Serialized execution** — concurrency 1. Protects 4GB of RAM and makes spend
   predictable, since exactly one meter is running at a time.

### Turn lifecycle

```
scheduler says bot B speaks
  → build system prompt (personality + memory + recall)
  → build user content (recent transcript, who said what)
  → register AbortController in the turn registry
  → query({ prompt, options: { cwd: workspace, model, canUseTool, abortController } })
  → stream SDKMessages → SSE to the browser as they arrive
  → tool requests hit the permission gate
  → on finish: persist message + usage, decrement budgets
  → feed result back into step() → next decision
```

## 6. Permission gate

`canUseTool` is a pure predicate wrapped in one impure escape hatch:

- **Bash** — the command is parsed and every binary checked against the bot's
  allowlist (`gh`, `git`, `ls`, `cat`, `rg`, `fd`, `node`, `npm`, `kubectl`,
  `helm`, …). Pipes and `&&` chains are split and each segment checked. A denylist
  catches the obvious horrors (`rm -rf /`, `curl | sh`, `dd`, fork bombs).
- **File tools** — the resolved absolute path must stay inside the bot's
  workspace. Symlinks are resolved before the check.
- **Anything else** — emits a `permission_request` over SSE, the UI shows
  approve/deny/always, and the promise resolves on your click. A 120s timeout
  denies by default, so an unattended party cannot hang forever.

Decisions marked "always" persist to SQLite per bot.

## 7. Cost accounting

Subscription auth means no per-token invoice, but budgets still need a meter, so
usage is tracked regardless: every turn records `input`, `output`, `cacheRead`,
`cacheCreation` from the SDK result message. The UI shows tokens as the primary
unit and a dollar *estimate* as a secondary, clearly labelled, computed from a
static price table. Cost is never presented as authoritative under a subscription.

## 8. Deployment

Single systemd **user** service, `howdy.service`, bound to the LAN address.
Build the web bundle on your dev machine and rsync `dist/` over — `vite build`
on the ODROID works but is slow enough to be annoying on eMMC.

`ops/` carries the unit file, an install script, and the arm64 notes
(`better-sqlite3` prebuilds, Node 22 via nodesource, the `claude setup-token`
dance).

## 9. Milestones

| # | Milestone | Ships |
| --- | --- | --- |
| M0 | Foundations | Monorepo, TS config, core types, CI-less test runner |
| M1 | One bot, one room | Talk to a single bot in the browser, streamed |
| M2 | Identity & memory | personality.md, memory.md, `remember` tool, FTS5 recall |
| M3 | Tools & permissions | Bash allowlist, workspace containment, approval UI, `gh` |
| M4 | The party | Scheduler, noisiness, budgets, killswitch, detectors |
| M5 | Ship it | systemd unit, install docs, backup/restore |
| M6 | Polish | Step mode, transcript export, bot cloning, themes |

M0-M2 is a genuinely useful single-bot app. M4 is the fun part. Nothing in M4
can be built safely without M0's pure scheduler, which is why the scheduler is
ticket #4 and not ticket #14.
