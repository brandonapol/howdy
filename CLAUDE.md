# Working on Howdy

A LAN-only bot party app for a 4GB arm64 ODROID. Read `docs/PLAN.md` for the
architecture, `docs/TICKETS.md` for what is done and what is next, and
`docs/RESEARCH.md` for why the safety rails are shaped the way they are.

## Non-negotiables

**`packages/core` has no dependencies and no I/O.** Everything in it is a pure
function over plain data — the scheduler, budgets, detectors, the bash
analyser, prompt assembly, path containment, memory parsing. That is what makes
runaway parties and token burn testable without spending a token. If you find
yourself wanting `fs` or `Date.now()` in core, the value belongs in the state
or in an argument instead.

**The orchestrator is a thin shell.** `step(state, event) => [state, effects]`
decides; `packages/server/src/orchestrator/rooms.ts` performs. Logic that
creeps into the shell stops being testable, and this project's whole safety
argument rests on that split.

**Concurrency stays at one.** The turn queue runs a single agent subprocess at
a time. It is the main reason a party cannot exhaust 4GB, and it makes spend
predictable. Do not parallelise it.

**Avoid native dependencies.** `better-sqlite3` is the only one and it has
arm64 prebuilds. Everything else, including the CSS, is deliberately plain so
the project builds anywhere.

## Conventions

- TypeScript throughout, ESM, strict. Functional style: `readonly` types, pure
  functions, effects pushed to the edges. No classes unless an API forces one.
- **No comments in code unless asked.** The repo owner's preference. Names and
  tests carry the explanation.
- No emoji in code or commits.
- Node's built-in test runner, never Jest.

## Testing

```bash
npm test          # unit + API end-to-end
npm run test:e2e  # browser end-to-end (needs: npx playwright install chromium)
```

Three layers, all offline. The agent runner and the goal judge are **injected**
(`startServer({ runTurn, judge })`), so end-to-end tests drive scripted fakes
through the real queue, gate, database and SSE without calling Claude. Set
`HOWDY_CHROMIUM` if Chromium lives somewhere unusual.

Two things this codebase has learned the hard way:

- **Write end-to-end tests that use a browser and a real port.** Bugs found
  only at that level so far: an infinite render loop firing 1618 requests, a
  shutdown that hung on open SSE connections, a connection indicator invisible
  on mobile, and a restore that silently produced empty personalities.
- **When a test fixture trips a detector, suspect the fixture first, then the
  detector.** It has been both. Fake transcripts must vary, or the repetition
  detector will correctly stop your party at turn three.

## Where things live

```
packages/core     pure domain: scheduler, budget, degeneracy, bash, paths, memory, prompt
packages/server   Hono + SQLite + Agent SDK runner + permission gate + orchestrator
packages/web      React + Vite, hand-written CSS
ops/              systemd units, install script, ODROID and GitHub notes
```

## Gotchas

- `docs/TICKETS.md` is the source of truth for status. Update it when you
  finish something.
- Migrations are forward-only, appended to the array in
  `packages/server/src/db/migrations.ts`. Never edit an existing one.
- Bot directory and workspace paths are **derived** from config plus slug, never
  stored, so backups restore onto any machine.
- The permission gate checks binaries *and* path arguments. A bot with `cat`
  allowlisted still cannot read `/etc/shadow`.
- Room ceilings mean "how far this may run unattended". A human message resets
  the window. Global daily and weekly ceilings sit above that and are checked
  before a subprocess is spawned.
