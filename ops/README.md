# Running Howdy on an ODROID

Written for a 4GB arm64 ODROID with eMMC, on a home LAN, never exposed to the
internet. Nothing here needs root except installing Node.

## Install

```bash
sudo apt install -y nodejs   # must be v22+; see below if your distro is older
git clone https://github.com/brandonapol/howdy ~/howdy
cd ~/howdy
./ops/install.sh
```

`install.sh` builds, creates `~/.howdy`, writes a config file, installs three
systemd **user** units, and enables lingering so the service survives logout.
Run it as the account you want the bots to act as — the same one you run
`gh auth login` and `claude setup-token` as. Not with sudo.

## Node 22 on arm64

Debian and Ubuntu ship something older. Use NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node --version   # expect v22.x or newer
```

`better-sqlite3` is the only native dependency and publishes linux-arm64
prebuilds, so `npm install` should not compile anything. If it does start
building from source, install `build-essential python3` and be patient — it is
a one-off, and slow on eMMC.

## Authenticating Claude

Howdy uses your Claude subscription rather than a metered API key, so a runaway
party costs you rate limit rather than money:

```bash
claude setup-token
```

Run it as the service account. The credential lands under `~/.claude` and the
Agent SDK finds it. To use a metered API key instead, put
`ANTHROPIC_API_KEY=sk-ant-...` in `~/.howdy/env`.

## Configuration

Everything lives in `~/.howdy/env` (chmod 600), read by the service on start.

| Variable | Default | What it does |
| --- | --- | --- |
| `HOWDY_ROOT` | `~/.howdy` | bot directories, workspaces, SQLite, backups |
| `HOWDY_HOST` | `0.0.0.0` | bind address — set to `127.0.0.1` for localhost only |
| `HOWDY_PORT` | `4747` | listen port |
| `HOWDY_SECRET` | unset | if set, required as `x-howdy-secret` on every API call |
| `HOWDY_DAILY_TOKEN_CEILING` | `2000000` | global stop across every room, per day |
| `HOWDY_WEEKLY_TOKEN_CEILING` | `10000000` | global stop across every room, per week |
| `HOWDY_TURN_TIMEOUT_MS` | `180000` | watchdog on a single bot turn |
| `HOWDY_PERMISSION_TIMEOUT_MS` | `120000` | unanswered approval prompts deny after this |

Changed something? `systemctl --user restart howdy`.

## Day to day

```bash
systemctl --user status howdy
journalctl --user -u howdy -f
systemctl --user restart howdy

node ~/howdy/packages/server/dist/cli.js backup      # snapshot now
node ~/howdy/packages/server/dist/cli.js backups     # list snapshots
node ~/howdy/packages/server/dist/cli.js restore <archive>
```

A weekly backup runs Sunday 03:30 via `howdy-backup.timer`. Snapshots use
SQLite's online backup API, so taking one while the service is running is safe.
They land in `~/.howdy/backups`; point the timer at a USB mount if you want
them off the eMMC.

## Memory and the 4GB budget

The service caps itself at 1200M with `MemoryMax`, and Node at 768M of heap.
Only one agent subprocess runs at a time — that is the concurrency-1 turn queue,
and it is the main reason a party cannot exhaust the box.

If you see the service restarting under load, lower `HOWDY_TURN_TIMEOUT_MS` so
stuck turns are reaped sooner, and check `journalctl --user -u howdy | grep -i
oom`.

## Being kind to eMMC

eMMC has finite write endurance, and a chatty database will grind at it.
Already done for you: SQLite runs in WAL with `synchronous=NORMAL`, nothing logs
per-token to disk, and only completed turns are written.

Worth doing yourself:

- Put backups on a USB stick or NAS rather than the eMMC.
- `journalctl --user --vacuum-size=100M` occasionally, or set
  `SystemMaxUse=100M` in `/etc/systemd/journald.conf`.
- Leave `commit=600` off the root filesystem unless you know you want it.

## Building the web bundle elsewhere

`vite build` works on the ODROID but is slow on eMMC. Building on your laptop
and copying the output over is often nicer:

```bash
npm run build --workspace @howdy/web
rsync -a packages/web/dist/ odroid:~/howdy/packages/web/dist/
```

## Security posture

This is a home-LAN appliance and the threat model is honest about that:

- **Bots are confined to their own workspace.** File tools resolve symlinks
  before checking containment; Bash commands have their binaries and their path
  arguments checked. Anything outside prompts you.
- **`gh` is the real boundary for GitHub.** Scope the token; see
  [GITHUB.md](GITHUB.md).
- **`HOWDY_SECRET` is thin.** It is a shared header, not authentication. It
  exists so a housemate's laptop cannot drive your bots by accident. If your LAN
  is genuinely untrusted, put Howdy behind a reverse proxy with real auth, or
  bind to `127.0.0.1` and reach it over SSH.
- **Do not expose this to the internet.** There is no rate limiting, no user
  model, and the bots have a shell.

## Uninstall

```bash
systemctl --user disable --now howdy.service howdy-backup.timer
rm ~/.config/systemd/user/howdy*.{service,timer}
systemctl --user daemon-reload
# your data stays in ~/.howdy until you delete it
```
