# pi-omlx-sandbox

A Docker sandbox that runs [Pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent) — a terminal AI coding agent — backed by a local [oMLX](https://github.com/jundot/omlx) model server running on your Mac.

Pi runs inside an isolated container with filesystem isolation enforced by sbx. Network access is set to Open so the sandbox can reach oMLX on the host.

## Prerequisites

**macOS (Apple Silicon) only.** oMLX is built on Apple's MLX framework and does not run on Linux or Windows.

- Docker Desktop for Mac
- [oMLX](https://github.com/jundot/omlx) installed and running on the host at port 8010
- [`sbx`](https://github.com/docker/sandbox) CLI v0.45 or later (`brew install docker/tap/sbx`); earlier releases cannot read a Kits v3 descriptor
- At least one LLM or VLM model available in oMLX

## One-time setup

### 1. oMLX: port and API key verification

The sbx proxy routes container traffic through its own localhost, so oMLX sees all requests as coming from `127.0.0.1`. Enable the matching setting so no API key is required, and move oMLX off its default port:

1. Open the oMLX Admin Dashboard
2. Go to **Global Settings**
3. Set **Skip API key verification** to **On**
4. Set the server port to **8010**

Inside the sandbox, `host.docker.internal` can resolve to an IPv6 address, and oMLX listens on IPv4 only. On port 8000, anything else on the Mac that publishes 8000 over IPv6 — a Docker container with `ports: ["8000:8000"]`, for example — answers in oMLX's place, and startup fails with `oMLX returned HTTP 404`. To use a different port, change `OMLX_PORT` in `pi.dockerfile` and the `host.docker.internal` entry in `pi.yaml` together.

### 2. sbx: sign in and start the daemon

```sh
sbx login
sbx daemon start -d
```

`-d` detaches the daemon. Without it, the daemon runs in the foreground and stops
when that terminal closes, and the next build fails with `load built kit image into
the sandbox runtime: ... sandboxd.sock: connect: no such file or directory`.
`sbx daemon status` shows whether it is running.

### 3. sbx: set network policy to Open

The proxy must be able to reach oMLX on the host:

```sh
sbx policy set-default open
```

### 4. GitHub token

Store the token in sbx's secret keychain. The proxy injects it into requests to
`api.github.com`, so it never enters the sandbox:

```sh
sbx secret set github          # prompts, or: sbx secret import
```

Optional — without it, GitHub API calls from the sandbox are unauthenticated
(60 requests/hour, public repos only). An exported environment variable is not a
substitute: `pi.yaml` resolves this credential from the keychain only.

Private npm packages are not wired up. `npm` is not one of sbx's built-in secret
services, so it would need `sbx secret set-custom` plus a matching
`credential@1` entry in `pi.yaml`.

## The kit

This repo is a [Kits v3](https://github.com/docker/sandbox-kit-spec) workload kit:
`pi.yaml` declares what the sandbox may reach and which credentials it gets, and
`pi.dockerfile` builds its content. There is no separate build or load step —
`sbx run` builds the kit from this directory when a sandbox is created and caches
the result by source hash.

To build and inspect the kit's resolved declarations without starting a sandbox:

```sh
sbx kit inspect ~/Code/repos/pi-omlx-sandbox
```

### Updating Pi

The image installs the latest Pi release when the kit is built, and `pi-start.sh`
runs `pi update --self` every time Pi launches, so a running sandbox picks up new
releases without being recreated. If the update fails — for example, the npm
registry is unreachable — it prints a warning and launches the version already
installed.

### Tests

```sh
./test.sh
```

Covers `pi-start.sh` model selection, self-update and error paths against fixture payloads with `curl` and `pi` stubbed out, `pi-sbx` against a stubbed `sbx`, then `pi.yaml`, then the extension's refresh behaviour. Needs neither Docker nor a running oMLX for the first and last parts.

The `pi.yaml` checks build the kit and assert on `sbx kit inspect --json`, because a descriptor can be well-formed and still resolve to the wrong policy. They are skipped when `sbx` is not on `PATH`, and building the kit needs Docker Desktop and the sbx daemon running.

## Run

Link `pi-sbx` onto your `PATH` once:

```sh
ln -s ~/Code/repos/pi-omlx-sandbox/pi-sbx ~/.local/bin/pi-sbx
```

Then, from any project directory:

```sh
pi-sbx                    # Pi on the current directory
pi-sbx -- --continue      # continue the most recent session
pi-sbx -- --resume        # pick a session interactively
pi-sbx ~/Code/repos/myapp # Pi on another directory
```

Each project gets its own sandbox, named after the directory plus a short hash of
its path (`pi-myapp-1a2b3c4d`), so two projects that share a directory name never
share a sandbox. The first run creates the sandbox from this kit; every later run
re-attaches to it. `pi-sbx` prints the name when it creates one, and `sbx ls`
lists them with their workspaces.

Options that only apply when the sandbox is created:

```sh
pi-sbx -m qwen3-8b                          # make this oMLX model Pi's default
pi-sbx ~/Code/repos/myapp ~/docs:ro          # mount more paths; :ro for read-only
```

Passing either to an existing sandbox fails with the `sbx rm` command to run first.
Removing a sandbox keeps its session history (see [Session history](#session-history)).

Pi connects to oMLX on the host at `host.docker.internal:8010`.

### Without the wrapper

`pi-sbx` wraps two `sbx run` forms. A run that names the kit always creates a
sandbox:

```sh
sbx run ~/Code/repos/pi-omlx-sandbox --name pi-myapp ~/Code/repos/myapp
```

Re-attaching leaves the kit out, and agent arguments go after `--`:

```sh
sbx run --name pi-myapp -- --continue
```

### Path casing must match exactly

macOS is case-insensitive, so `cd ~/code/repos/myapp` works even when the directory
is really `~/Code/repos/myapp`. sbx mounts the workspace at its literal host path
inside a Linux VM, which is case-sensitive, so a mismatched path fails there: the
sandbox is still created, and the agent dies immediately:

```
OCI runtime exec failed: chdir to `/Users/<username>/code/repos/myapp`: No such file or directory
ERROR: agent exited with code 127
```

`pi-sbx` resolves the project path with `realpath`, which returns the on-disk
casing. Running `sbx run` by hand, pass `"$(realpath .)"` (or `"${PWD:A}"` in zsh)
instead of `.`, which expands to `$PWD` with whatever casing you typed. `pwd -P`
is not a substitute: it keeps the typed casing of the last component.

The workspace mount is fixed at creation, so recovering from a failed run means
removing the sandbox and creating it again.

### Using your host Pi config

To load extensions from your Mac's Pi config, mount it read-only when creating the
sandbox:

```sh
pi-sbx ~/Code/repos/myapp ~/.pi/agent:ro
```

sbx mounts it at its literal host path (`/Users/<username>/.pi/agent`), not at the
container user's home, so add that absolute path to `~/.pi/agent/settings.json` on
your Mac for Pi to discover extensions from it:

```json
{
  "extensions": [
    "/Users/<username>/.pi/agent/extensions"
  ]
}
```

Skills come from the sbx skills store instead (see [Adding skills](#adding-skills)).

### Session history

Pi stores sessions under `~/.pi/agent/sessions`, grouped by working directory.
`pi.yaml` puts that directory on an sbx volume, which outlives the sandbox: after
`sbx rm`, creating a sandbox with the same name from this kit reattaches it, so
`--continue` and `--resume` pick up where you left off. `pi-sbx` always derives
the same name for a project, so removing and recreating a sandbox — to change the
model, add a mount, or rebuild after editing the kit — keeps its history.

Starting without `--continue` or `--resume` starts a fresh session but does not
delete previous ones.

## Changing the model

Nothing to configure — Pi tracks oMLX in two stages.

At container start, `pi-start.sh` reads `/v1/models/status` and seeds `models.json`
with every LLM and VLM oMLX serves, defaulting to one that is already loaded. That
seed exists so `pi --model` resolves before any refresh, and so the sandbox keeps
working if oMLX goes away mid-session.

The `omlx` extension (`extensions/omlx/`) then registers a provider with a
`refreshModels` callback. Pi calls it at session start and every time the model
picker opens, replacing the seed with a fresh read of `/v1/models/status`. So a
model downloaded, or a context window changed, in the oMLX admin panel is picked up
by opening `/model` — no restart, no rebuild.

Context limits come along with it. oMLX rejects prompts above its
`max_context_window` (32768 by default); without that value Pi assumes 128k and
would not compact the session in time.

Refresh is not continuous: an admin-panel change does not reach a conversation
already in flight until the next refresh, and the current turn's budget is already
fixed. Setting `PI_OFFLINE` disables network refresh entirely, leaving only the seed.

If oMLX is unreachable when a refresh runs, Pi warns (`Could not refresh omlx;
searching cached models`) and keeps the catalog it already has, so the session
carries on with the seed.

To pin one model, create the sandbox with `pi-sbx -m <id>` (or
`sbx run ... --kit-arg model=<id>`) using an exact model ID. Startup fails with the
list of valid IDs if it does not match. Pinning sets the default model; it does not
hide the others from `/model`.

## Access limitations

| Dimension | Protection | Notes |
|---|---|---|
| Host filesystem | Strong | Only the paths passed to `sbx run`, plus the read-only skills store |
| Local network | Minimal | Open policy; Pi can reach any port on the host via `host.docker.internal` |
| Internet | Minimal | Open policy; Pi can reach any domain |
| Credentials | Proxy-managed | Tokens injected by proxy, never exposed in container env |
| Git identity | Disclosed | Your Git `user.name` and `user.email` are set inside the sandbox so Pi's commits are attributed to you |

Filesystem isolation is the primary protection. Pi runs inside a Docker container as a non-root `agent` user and can reach only the host paths passed to `sbx run` (read-only where marked `:ro`) and the sbx skills store, which is mounted read-only.

Network isolation is weak by design. Open policy (`sbx policy set-default open`) is required for the sbx proxy to reach oMLX on the host. Under Open policy, all outbound traffic is allowed — the `network-policy@1` allow list in `pi.yaml` is not an enforced allow-list. Its role is to enable credential injection: the sbx proxy adds the stored `github` secret to requests to `api.github.com`, so Pi never sees the real token value.

If tighter network control is needed, you would need to switch to a Balanced or Locked Down sbx policy. That requires a different approach to oMLX connectivity — for example, running oMLX as an internet-accessible service with a real API key rather than relying on the localhost loopback.

## Global instructions (CLAUDE.md)

`CLAUDE.md` in this repo is copied into the image at `~/.pi/agent/CLAUDE.md`. Pi loads it at startup for every session, regardless of which project it's working in. Edit it to set coding standards, tool preferences, commit conventions, and anything else Pi should always follow.

For project-specific instructions, add a `CLAUDE.md` or `AGENTS.md` to the project repo. Pi walks up the directory tree from the working directory and loads all matches, so project files layer on top of the global one automatically — no sandbox changes needed.

After editing `CLAUDE.md`, remove the sandbox with `sbx rm <name>` and run `pi-sbx` again, which rebuilds the kit because its source changed. Session history is kept.

## Adding skills

Skills are Markdown files that give Pi specialized knowledge and workflows. They live in sbx's shared skills store on the host, which `pi.yaml` asks sbx to mount read-only at `~/.pi/agent/skills`, where Pi discovers global skills. They survive sandbox recreation, and new ones reach a sandbox without a rebuild.

Install skills from a Git repository:

```sh
sbx skills add <owner>/<repo>
```

Or import the ones already on your Mac. `sbx skills import` reads the directories other agents use, such as `~/.agents/skills` and `~/.claude/skills` — not `~/.pi/agent/skills`, so move Pi-only skills to `~/.agents/skills` first:

```sh
sbx skills import
sbx skills ls
```

Pi loads the name and description of all available skills at startup. It reads the full instructions when a task matches the description, or when you invoke the skill explicitly with `/skill:<name>`.

The mount is on by default. `sbx run --skills=off` starts a sandbox without it.

## What's in the image

- Base: `docker/sandbox-templates:shell`, pinned by digest (`BASE_DIGEST` in `pi.dockerfile`), which provides Node.js. The `shell-docker` variant is avoided because it runs a Docker engine for the life of the sandbox
- `@earendil-works/pi-coding-agent` (global npm install as `agent`, updated at every launch)
- `fd` (pre-installed so Pi doesn't download it at runtime)
- `uv` and `ruff` (Python toolchain), pinned by `UV_VERSION` and `RUFF_VERSION` in `pi.dockerfile`
- `pi-start.sh` — entrypoint that writes Pi's provider config, updates Pi, and launches the agent
- `extensions/omlx/` — the oMLX provider extension, copied to `~/.pi/agent/extensions/`
- `CLAUDE.md` — global instructions copied to `~/.pi/agent/CLAUDE.md`
