# Howdy

A local bot party. A small cast of persistent Claude-backed bots you can chat
with, configure, and put in a room together — with real CLI access, memory that
survives a reboot, and enough restraint that they will not talk to each other
until your token budget is gone.

LAN-only. Runs on an ODROID.

## Where things stand

| Milestone | State |
| --- | --- |
| M0 Foundations | pure core, scheduler, budgets, detectors — **done** |
| M1 One bot, one room | server, DB, SSE, agent runner, queue, **UI — done** |
| M2 Identity & memory | bot dirs, `personality.md`, config UI, `remember`/`recall` tools, compaction — **done** |
| M3 Tools & permissions | bash analyser, permission gate, approval UI — **done**; `gh` setup documented |
| M4 The party | orchestrator, killswitch, governors, party UI — **done**; handoff, goals and the timeline outstanding |
| M5 Ship it | planned |

**292 tests green**, including 37 API end-to-end and 16 browser end-to-end. See [`docs/RESEARCH.md`](docs/RESEARCH.md) for how this
compares to Grok Bot and what the multi-agent literature says.

Read [`docs/PLAN.md`](docs/PLAN.md) for the architecture and
[`docs/TICKETS.md`](docs/TICKETS.md) for the work breakdown.

## Layout

```
packages/core     pure domain — no I/O, no dependencies, all of it unit tested
packages/server   Hono + SQLite + the Claude Agent SDK runner
packages/web      React + Vite UI, hand-written CSS, no framework
ops/              systemd unit and install notes                 (M5)
```

`core` is where the party rules live. It is deliberately free of I/O so the
things you actually worry about — runaway loops, token burn, bots agreeing with
each other forever — can be tested without spending a token.

## Develop

```bash
npm install
npm run typecheck
npm test          # unit + API end-to-end
npm run test:e2e  # browser end-to-end (needs: npx playwright install chromium)

npm run build

HOWDY_ROOT=~/.howdy HOWDY_WEB_DIST=packages/web/dist npm start --workspace @howdy/server
```

Then open `http://<your-odroid>:4747`. For UI development with hot reload, run
the server as above and `npm run dev --workspace @howdy/web` alongside it; Vite
proxies `/api` through.

Node 22+. No native dependencies in `core`, on purpose.

| Env var | Default | Purpose |
| --- | --- | --- |
| `HOWDY_ROOT` | `~/.howdy` | bot dirs, workspaces, SQLite |
| `HOWDY_PORT` | `4747` | listen port |
| `HOWDY_SECRET` | unset | if set, required as `x-howdy-secret` on every `/api` call bar health |
| `HOWDY_TURN_TIMEOUT_MS` | `180000` | per-turn watchdog |
| `HOWDY_DAILY_TOKEN_CEILING` | `2000000` | refuses new turns once spent |

## Testing

Three layers, all runnable offline — no API key, no tokens spent.

| Layer | Where | What it proves |
| --- | --- | --- |
| Unit | `packages/*/test/*.test.ts` | Pure logic: the scheduler, budgets, degeneracy detectors, the bash analyser (a 74-command fixture table), path containment, the UI reducer. |
| API end-to-end | `packages/server/test/e2e.test.ts` | A real HTTP server on a real port with real SSE and a real SQLite file. Full turn lifecycle, halt, watchdog, permission round-trips, the daily ceiling, queue serialisation, reconnect replay, restart persistence. |
| Browser end-to-end | `packages/web/test/ui.e2e.test.ts` | Real Chromium against the real server and the built bundle. Streaming, permission prompts by mouse and keyboard, halt, bot configuration reaching the next turn, reload, two clients at once, phone layout, and assembling a party then watching it run and stop. |
| Party end-to-end | `packages/server/test/party.e2e.test.ts` | Multi-bot rooms driving themselves: bots converse and alternate, every ceiling stops the room and names itself, detectors fire early, a lurker stays quiet until mentioned, the killswitch lands in seconds, step mode releases one turn, both governors bite, and a seed reproduces a party exactly. |

The agent itself is injected (`startServer({ runTurn })`), so end-to-end tests
drive a scripted fake through the genuine code path — same queue, same gate,
same persistence — without calling Claude. If Chromium lives somewhere unusual,
set `HOWDY_CHROMIUM`.

## The safety rails

Four independent things stop a party, in increasing order of politeness:

1. **Killswitch** — aborts the in-flight subprocess. Button, `Esc Esc`, or `curl`.
2. **Ceilings** — turns, effective tokens, wall clock, tool calls per turn, plus
   a per-turn watchdog and a daily global ceiling checked *before* a subprocess
   is spawned. Any one of them halts the room and says which.
3. **Detectors** — repetition, agreement cascades, and content-free chatter, all
   caught with cheap heuristics rather than a model call.
4. **Noisiness** — a per-bot dial from lurker to motormouth.

Room ceilings mean *how far this may run unattended*. Speaking to a room resets
the window, so solo chat never stalls and an unattended party is always bounded.
A room the machinery stopped revives when you speak to it; a room you stopped by
hand needs a deliberate Resume. Above all of it sit daily and weekly token
ceilings, checked before a subprocess is spawned — because the market leader's
users did not blow their budget in one conversation, they blew it across many
agents over a week.

All four are pure functions in `packages/core`. The scheduler takes a seeded RNG,
so a party that misbehaves can be replayed exactly rather than guessed at.
