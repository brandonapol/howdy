# Giving the bots GitHub access

Bots reach GitHub through the `gh` CLI over the Bash tool. There is no GitHub
token in Howdy's config and none in the database — `gh` owns the credential, and
the bots simply inherit whatever the service account is already logged in as.

## Setup on the ODROID

Run this as the same user the `howdy` service runs as. Doing it as your own user
and then running the service as another will silently give the bots no access.

```bash
sudo apt install gh          # or: brew install gh
gh auth login                # HTTPS, authenticate with a browser or a token
gh auth status               # confirm before going further
```

Verify the bots will actually see it:

```bash
sudo -u howdy -H gh auth status
sudo -u howdy -H gh repo list --limit 3
```

## Scope the token deliberately

The bots get exactly what this token gets. A classic PAT with `repo` and
`read:org` is usually right for a home setup. Consider a **fine-grained** token
limited to the handful of repositories you actually want a bot touching — this
is the cheapest guardrail available and it costs nothing to set up.

Things worth *not* granting: `delete_repo`, `admin:org`, `workflow` unless a bot
genuinely needs to edit Actions.

## What the permission gate does and does not do

`gh` is on the default allowlist, so `gh pr list`, `gh pr view`, `gh issue
create` and friends run without prompting. The gate checks the **binary** and
any filesystem paths, not the GitHub verb — it will not stop `gh repo delete` on
its own.

Two mitigations, use both:

1. Scope the token as above. This is the real boundary.
2. Take `gh` off a bot's allowlist in its config if it has no business touching
   GitHub. Removing it means every `gh` call prompts you instead.

`git push --force` is denied outright by the analyser, so a bot cannot rewrite
shared history even with a permissive token. `--force-with-lease` is allowed.

## Smoke test

With the service running and a bot configured:

```bash
curl -s localhost:4747/api/rooms/general/messages \
  -H 'content-type: application/json' \
  -d '{"botId":"<bot-id>","text":"run gh pr list in this repo and summarise it"}'
```

You should see the turn stream back with a `Bash` tool call and no permission
prompt. If you get a prompt, `gh` is missing from that bot's allowlist. If you
get an auth error in the reply, the service account is not logged in.
