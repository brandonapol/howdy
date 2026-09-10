# Howdy

A local bot party. A small cast of persistent Claude-backed bots you can chat
with, configure, and put in a room together — with real CLI access, memory that
survives a reboot, and enough restraint that they will not talk to each other
until your token budget is gone.

LAN-only. Runs on an ODROID.

## Where things stand

| Milestone | State |
| --- | --- |
| M0 Foundations | pure core, scheduler, budgets, detectors — **done, 40 tests green** |
| M1 One bot, one room | next |
| M2 Identity & memory | planned |
| M3 Tools & permissions | planned |
| M4 The party | planned |
| M5 Ship it | planned |

Read [`docs/PLAN.md`](docs/PLAN.md) for the architecture and
[`docs/TICKETS.md`](docs/TICKETS.md) for the work breakdown.

## Layout

```
packages/core     pure domain — no I/O, no dependencies, all of it unit tested
packages/server   Hono + SQLite + the Claude Agent SDK runner   (M1)
packages/web      React + Vite UI                                (M1)
ops/              systemd unit and install notes                 (M5)
```

`core` is where the party rules live. It is deliberately free of I/O so the
things you actually worry about — runaway loops, token burn, bots agreeing with
each other forever — can be tested without spending a token.

## Develop

```bash
npm install
npm run typecheck
npm test
```

Node 22+. No native dependencies in `core`, on purpose.

## The safety rails

Four independent things stop a party, in increasing order of politeness:

1. **Killswitch** — aborts the in-flight subprocess. Button, `Esc Esc`, or `curl`.
2. **Ceilings** — turns, effective tokens, wall clock, tool calls per turn. Any
   one of them halts the room and says which.
3. **Detectors** — repetition, agreement cascades, and content-free chatter, all
   caught with cheap heuristics rather than a model call.
4. **Noisiness** — a per-bot dial from lurker to motormouth.

All four are pure functions in `packages/core`. The scheduler takes a seeded RNG,
so a party that misbehaves can be replayed exactly rather than guessed at.
