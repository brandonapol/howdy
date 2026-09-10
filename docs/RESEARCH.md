# Competitive notes — Grok Bot, and what the research says about group chats

Research date: 2026-09-10. Grok Bot launched in beta 2026-08-11, so this is a
one-month-old product and these notes will age quickly.

## What Grok Bot actually ships

Persistent named bots, a cloud computer, browser and terminal access, plugins
and MCP, group chats, agent-to-agent handoffs, skills, routines, and human
approvals. Bots keep working after you close the laptop and come back to you
only when something needs a human decision. Bundled into Cursor/SuperGrok
subscriptions from $20/month; no free tier, no standalone plan.

### Feature-by-feature against Howdy

| Grok Bot | Howdy | Verdict |
| --- | --- | --- |
| Persistent named bots | Bot dirs with `personality.md` | Parity, and ours is editable in vim |
| One shared cloud computer | Per-bot workspace on your ODROID | **We win** — see below |
| Terminal access | Agent SDK Bash + allowlist | Parity |
| Browser access | Not planned | **They win**, deliberately (see below) |
| Plugins / MCP | Agent SDK `mcpServers` | Parity |
| Group chats | Rooms + the party scheduler | Parity, with better rails |
| Agent-to-agent handoffs | Missing → **H-33** | Gap, now ticketed |
| Skills | Missing → **H-39** | Gap, now ticketed |
| Routines (scheduled) | Missing → **H-34** | Gap, now ticketed |
| Human approvals | Permission gate (H-17) | Parity |
| Comes back when a decision is needed | Missing → **H-35** | Gap, now ticketed |
| Usage controls | Ceilings + killswitch + **H-31** | **We win** — see below |

### The shared-computer mistake

All of a user's Grok bots share **one** cloud computer. Files, browser sessions
and logins are pooled, and xAI's own docs say separate bots should not be
treated as a security boundary. Two weeks in, a confirmed incident had that
shared computer enter a stuck state and *every bot on the account stopped at
once*.

Howdy gives each bot its own workspace directory and runs each turn as its own
subprocess. One wedged turn cannot take the cast down with it. This was already
the design; the incident just makes it a selling point rather than a detail.

### The cost problem, which is the whole ballgame

The single most reported complaint, by a distance: usage limits burn far faster
than anyone expects. A weekly limit exhausted in one day on the $200 tier. A
six-agent business burning 42% of a weekly allowance on day one. Roughly 100
completions plus one ten-minute script measured at 5% of a week. xAI
acknowledged it on 2026-08-24 and reset everyone's limits on 2026-08-26.

This is exactly the failure Howdy was built to avoid, and it validates putting
budgets in the domain model rather than in a config file. But it also exposes a
real gap: **our ceilings are per-room**. Grok's users did not blow their budget
in one room — they blew it across six agents running all week. A per-room
ceiling does nothing about that.

→ **H-31, a global spend governor**: daily and weekly caps across every room and
routine, checked before a turn is dispatched, not after. Promoted to M4.

### Stalled agents

Also widely reported: agents that stall, plus browser crashes and profile
resets. Our `maxWallClockMs` is a *room* ceiling — a single turn that hangs
forever would sit there until the room clock expires, holding the
concurrency-1 queue and blocking every other room on the box.

→ **H-32, a per-turn watchdog.** Promoted to M1, because the queue is worthless
without it.

### Missing context and model controls

Users report no control over context or model choice. We already have per-bot
model selection; H-15 should also expose context depth and memory size, so add
those fields to the bot config rather than hard-coding them.

### Browser access — deliberately skipped

Grok has it, we will not, at least not on this box. Chromium plus a profile is
several hundred MB of a 4GB budget, and "browser crashes and profile resets" is
already one of their top complaints. `curl` and `gh` through the Bash allowlist
cover the realistic home cases. Revisit only if the ODROID gets replaced.

## What the multi-agent literature says

Independent of Grok, the orchestration research is unusually consistent, and it
mostly says we picked right:

- **Centralise turn allocation.** "If every agent decides for itself whether to
  speak, the result is either chatter or paralysis." Our `step()` returns
  exactly one `runTurn` effect, ever. Confirmed.
- **Terminate centrally.** Termination must be evaluated in one place so the
  chat ends predictably. Our budget and detector checks live in the same
  reducer. Confirmed.
- **Per-pair handoffs do not scale.** They work for two or three agents and fall
  apart as the cast grows — so H-33 should route handoffs *through* the
  scheduler as a mention, not as a direct bot-to-bot channel.
- **Round-robin is blind to relevance.** An LLM chair is relevance-aware but
  costs a model call per turn. Our noisiness roll is a cheap middle ground; a
  real chair should be opt-in for rooms that can afford it.
  → **H-36, optional LLM chair.**
- **Check for task completion each round.** Systems that summarise and test for
  completion can return early instead of running to a turn limit. We currently
  only stop on budget or degeneracy — a party that *finishes* still runs until
  something breaks.
  → **H-37, room goals and completion detection.** This is the difference
  between "the bots stopped" and "the bots are done", and it is probably the
  single biggest quality win available.

## Standing implications

1. Budgets are the product. The market leader's top complaint is runaway spend;
   ceilings, forecasts and a killswitch are features, not chores.
2. Isolation is a feature. Say so in the README.
3. Finishing beats stopping. H-37 deserves to land in M4, not M6.
4. Do not chase browser automation on 4GB.

Sources: [DataCamp](https://www.datacamp.com/blog/grok-bot) ·
[CellCog problems](https://cellcog.ai/blog/grok-bot-problems/) ·
[CellCog overview](https://cellcog.ai/blog/what-is-grok-bot/) ·
[Market Intelligence Research](https://marketintelligenceresearch.com/blog/grok-bot-two-weeks-in-agent-workforce/) ·
[Semantic Kernel group chat](https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/agent-orchestration/group-chat) ·
[AgentGroupChat-V2](https://arxiv.org/html/2506.15451v1) ·
[Group-Chat Manager pattern](https://www.agentpatternscatalog.org/patterns/group-chat-manager/)
