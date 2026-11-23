# pi-omlx-sandbox

A Docker sandbox that runs [Pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent) — a terminal AI coding agent — backed by a local [oMLX](https://github.com/jundot/omlx) model server running on your Mac.

Optionally, it can also use hosted [TrustedRouter](https://trustedrouter.com) models that run on verified confidential compute. You can switch to them mid-session, start on them directly, or fall back to them when oMLX is not running.

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

### 5. TrustedRouter key (optional)

To use hosted [TrustedRouter](https://trustedrouter.com) models alongside oMLX
(see [Hosted models](#hosted-models-trustedrouter)), store your inference key as an
sbx custom secret:

```sh
printf '%s' "$TRUSTEDROUTER_API_KEY" | sbx secret set-custom \
  --host api.trustedrouter.com --env TRUSTEDROUTER_API_KEY --value-stdin
```

Inside the sandbox, `TRUSTEDROUTER_API_KEY` holds a placeholder (`sbx-cs-…`), not
the key. The sbx proxy replaces the placeholder with the real key on requests to
`api.trustedrouter.com`, so the key never enters the sandbox. Exporting the
variable on the host does nothing by itself, because sbx does not pass host
environment variables into the sandbox.

sbx sets the placeholder variable when it creates a sandbox, so store the secret
first. A sandbox created before then does not get the variable, even after a
restart. Remove it with `sbx rm <name>` and run `pi-sbx` again; session history is
kept. Without the secret, the TrustedRouter provider is simply not registered.

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
sbx kit inspect /path/to/pi-omlx-sandbox
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

Covers `pi-start.sh` model selection, self-update and error paths against fixture payloads with `curl` and `pi` stubbed out, `pi-sbx` against a stubbed `sbx`, then `pi.yaml`, then both extensions' catalog and refresh behaviour with `fetch` stubbed out. Needs neither Docker, a running oMLX, nor network access for the first and last parts.

The `pi.yaml` checks build the kit and assert on `sbx kit inspect --json`, because a descriptor can be well-formed and still resolve to the wrong policy. They are skipped when `sbx` is not on `PATH`, and building the kit needs Docker Desktop and the sbx daemon running.

## Run

Link `pi-sbx` onto your `PATH` once, from the root of your clone of this repo
(any directory on your `PATH` works in place of `~/.local/bin`):

```sh
ln -s "$PWD/pi-sbx" ~/.local/bin/pi-sbx
```

Then, from any project directory:

```sh
pi-sbx                    # Pi on the current directory
pi-sbx -- --continue      # continue the most recent session
pi-sbx -- --resume        # pick a session interactively
pi-sbx ~/projects/myapp   # Pi on another directory
pi-sbx -t                 # start on the sandbox's TrustedRouter model, skipping oMLX
pi-sbx -- --model trustedrouter/z-ai/glm-5.3   # start on one TrustedRouter model
```

`-t` and `--model trustedrouter/...` apply to that launch only, on new and existing
sandboxes alike, and need the [TrustedRouter key](#5-trustedrouter-key-optional).

Each project gets its own sandbox, named after the directory plus a short hash of
its path (`pi-myapp-1a2b3c4d`), so two projects that share a directory name never
share a sandbox. The first run creates the sandbox from this kit; every later run
re-attaches to it. `pi-sbx` prints the name when it creates one, and `sbx ls`
lists them with their workspaces.

Options that only apply when the sandbox is created:

```sh
pi-sbx -m qwen3-8b                    # make this oMLX model Pi's default
pi-sbx -H trustedrouter/z-ai/glm-5.3  # TrustedRouter model for -t and the oMLX fallback
pi-sbx ~/projects/myapp ~/docs:ro     # mount more paths; :ro for read-only
```

Passing any of these to an existing sandbox fails with the `sbx rm` command to run first.
Removing a sandbox keeps its session history (see [Session history](#session-history)).

Pi connects to oMLX on the host at `host.docker.internal:8010`. If oMLX is not
running and a TrustedRouter key is stored, Pi starts on the sandbox's TrustedRouter
model instead (see [Hosted models](#hosted-models-trustedrouter)).

### Without the wrapper

`pi-sbx` wraps two `sbx run` forms. A run that names the kit always creates a
sandbox:

```sh
sbx run /path/to/pi-omlx-sandbox --name pi-myapp ~/projects/myapp
```

Re-attaching leaves the kit out, and agent arguments go after `--`:

```sh
sbx run --name pi-myapp -- --continue
```

### Path casing must match exactly

macOS is case-insensitive, so `cd ~/projects/myapp` works even when the directory
is really `~/Projects/myapp`. sbx mounts the workspace at its literal host path
inside a Linux VM, which is case-sensitive, so a mismatched path fails there: the
sandbox is still created, and the agent dies immediately:

```
OCI runtime exec failed: chdir to `/Users/<username>/projects/myapp`: No such file or directory
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
pi-sbx ~/projects/myapp ~/.pi/agent:ro
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

## Hosted models (TrustedRouter)

With the [TrustedRouter secret](#5-trustedrouter-key-optional) stored, the
`trustedrouter` extension (`extensions/trustedrouter/`) adds TrustedRouter models
next to the oMLX ones. Switch between them in a running session with `/model`. Local
models show up as `omlx/<id>` and hosted ones as `trustedrouter/<vendor>/<model>`.

### Choosing where a session starts

| Situation | Starting model |
|---|---|
| `pi-sbx` with oMLX running | The oMLX default (a loaded model, or the `-m` pin) |
| `pi-sbx` with oMLX down and a key stored | The hosted model, after a warning |
| `pi-sbx` with oMLX down and no key | None: startup fails and says to start oMLX or store a key |
| `pi-sbx -t` | The hosted model; oMLX is not contacted |
| `pi-sbx -- --model trustedrouter/<id>` | That model; oMLX is not contacted |

The hosted model is `trustedrouter/confidential` unless the sandbox was created
with `pi-sbx -H trustedrouter/<id>` (or `--kit-arg hosted_model=trustedrouter/<id>`).
Like `-m`, it is fixed at creation; `sbx rm` the sandbox and run `pi-sbx -H` again to
change it, which keeps session history. Startup rejects a value that does not start
with `trustedrouter/`. An ID TrustedRouter does not list passes that check, but Pi
then reports the model as not found. List valid IDs with
`pi --list-models trustedrouter` inside the sandbox, or on a host Pi with the
extension installed.

Only an unreachable oMLX triggers the fallback. An oMLX that answers with an error,
such as an auth rejection or no chat models, still stops startup, because that
needs fixing in oMLX. In a hosted session the oMLX provider stays registered, so
if oMLX starts later, its models appear the next time `/model` opens.

Without the wrapper, pass the same Pi arguments after `--`:
`sbx run --name <name> -- --hosted` for the hosted model (the marker must come
first), or `sbx run --name <name> -- --model trustedrouter/<id>`.

### Routing pools

Besides individual models, the list includes two pools where TrustedRouter picks the
model per request:

- `trustedrouter/confidential` — any route that meets the confidential floor below
- `trustedrouter/trusted` — the same, restricted further to operators TrustedRouter
  vets (Tinfoil, Privatemode and Maple)

Before each request, TrustedRouter reserves credit at the price of the most
expensive model in the pool, multiplied by the output cap below. That reservation
is about $0.36. It is not the final charge, but a request fails with
`402 Insufficient credits` when the balance cannot cover it. With a smaller balance,
pick an individual model, such as `trustedrouter/z-ai/glm-5.3-flash`, and make it
the sandbox's hosted model with `pi-sbx -H`.

Pi prices a pool at its most expensive model, the same rate TrustedRouter reserves
against, so the running cost Pi shows for a pool session is an upper bound.

### Privacy floor

Every TrustedRouter request carries
[`"provider": {"min_privacy": "confidential"}`](https://trustedrouter.com/docs#require-confidential-verified-compute-e2ee-zdr).
That floor requires verified confidential compute, end-to-end encryption and zero
data retention on the same route. TrustedRouter fails closed on it: when no route
for the model meets all three, the request is rejected before inference rather than
sent to a weaker route.

### What Pi shows about privacy

While a TrustedRouter model is selected, a panel above the editor shows:

- **The requirement:** every request carries the confidential floor above.
- **Qualifying routes:** for an individual model, each operator that meets the
  floor, from `GET /v1/models/{id}/endpoints`. Each line gives the operator's
  country, tier, confidential compute, end-to-end encryption, zero retention,
  whether content is stored, and its policy URL. A guarantee the catalog does not
  report shows as `unreported` and a missing one as `NO`, rather than being
  hidden. For a pool, the panel names the eligible operators.
- **Gateway attestation:** the result of TrustedRouter's
  [published client verification](https://trustedrouter.com/trust). The extension
  fetches `/attestation` with a fresh random nonce over a direct TLS connection and
  checks that:
  - Google's Confidential Space keys sign the token (issuer
    `confidentialcomputing.googleapis.com`, audience `quill-cloud`), and it has not
    expired;
  - the enclave runs with debugging disabled;
  - the measured container image matches the digest TrustedRouter publishes at
    `trustedrouter.com/trust/image-digest-gcp.txt`;
  - the token echoes the nonce, so it is fresh, and binds both that TLS session's
    exporter value and the gateway's certificate. This puts the gateway's TLS key
    inside the measured workload.

  Any failure is shown as `Gateway attestation FAILED` with the reason.
- **Pi's own connection:** whether the certificate on the path Pi's requests take
  is the attested one. The extension follows the same proxy rules as Pi's HTTP
  client: `https_proxy`
  or `HTTPS_PROXY`, falling back to `HTTP_PROXY`, with `NO_PROXY` exclusions and
  Pi's `httpProxy` setting. So a proxy that inspects TLS shows up here under its
  own name. On a Mac without a proxy, the certificate is the attested one, and the
  panel says Pi's connection ends at the attested gateway.

  **In the sbx sandbox it is not.** Pi's requests go through the sbx proxy on your
  Mac, which decrypts each request to swap the key placeholder for the real key,
  then re-encrypts it to TrustedRouter. The panel names the proxy and says that
  this hop can read prompts. The proxy is local sbx software, not a third party,
  but it is outside the attested path. Any other TLS-inspecting proxy shows up the
  same way, under its own name.

The checks run in the background, so selecting a model never waits for them. A
successful result is kept for the rest of the Pi session. A failed one, such as a
timeout, is retried the next time a TrustedRouter model is selected.

After each reply, the footer names the route that served it, for example
`TrustedRouter: served by privatemode · z-ai/glm-5.3-flash · gateway us-west1`. This
comes from TrustedRouter's routing report in the response.

The panel appears only in Pi's interactive and RPC modes, not with `-p`. Under
`PI_OFFLINE` the extension makes no network calls, and the panel says the checks
were skipped.

What this does not prove:

- The attestation covers TrustedRouter's gateway. The operator lines (confidential
  compute, end-to-end encryption, zero retention) are what TrustedRouter's catalog
  records about each operator; the extension does not verify them itself.
  TrustedRouter's [security page](https://trustedrouter.com/security) describes the
  gateway checking an operator's attestation itself for Chutes TEE routes; for
  other operators it relies on their published policies.
- TrustedRouter's verifier also expects sensitive requests to be sent over the same
  TLS connection that fetched the attestation. Pi opens its own connections, so the
  extension can only confirm that they reach a gateway holding the same attested
  certificate.
- Signed per-response receipts (`x-inference-receipt`) are not requested. They are
  opt-in and raise TrustedRouter's fee from 5.5% to 12%.

### Model list and limits

The model list comes from the public `GET /v1/models` catalog. It is filtered to
models that report a confidential route, accept tool calls and produce text, so
embedding, speech and non-confidential models are left out.

The catalog is about 1.5 MB, so the extension saves the filtered list (about 50 KB)
to `~/.pi/agent/trustedrouter-models.json`, or under `PI_CODING_AGENT_DIR` when that
is set. Pi starts from the saved list without contacting TrustedRouter. The list is
fetched again only when it is more than an hour old, at startup or when the model
picker opens. The first start in a new sandbox fetches it, which adds about a
second. With `PI_OFFLINE` set, the extension never fetches and uses the saved list
at any age.

If the catalog cannot be fetched, Pi uses the saved list and warns. With no saved
list, Pi warns that TrustedRouter models are unavailable for the session and starts
with oMLX models only. Every `trustedrouter/` model then reports "not found",
including the fallback when oMLX is down, and the warning says so.

Each model's thinking levels follow the reasoning settings its confidential routes
accept: the catalog's verified list, plus measured values for DeepSeek V4.1, which
the catalog leaves unverified but which rejects `medium`. Levels a route rejects
are hidden in Pi, and the session's level moves up to the next accepted one. For
example, Pi's default `medium` becomes `high` on GLM-5.3. Models whose levels are
unverified keep Pi's defaults.

Output is capped at 16384 tokens per response, which matches Pi's default
compaction reserve. Pi sends the cap as `max_tokens` on every request, and
TrustedRouter rejects any request whose prompt plus `max_tokens` exceeds the model's
context window. With a model's own ceiling (often most of a 1M window), long
sessions would start failing well before Pi compacted them.

Hosted usage is billed to your TrustedRouter account. Pi's usage display shows the
catalog prices: for individual models the listed rate, and for pools the most
expensive model's rate.

### Using the extension outside the sandbox

The extension does not depend on the sandbox, so any Pi installation can use it. This
repo is a Pi package whose manifest loads only the TrustedRouter extension, not the
oMLX one:

```sh
export TRUSTEDROUTER_API_KEY=sk-tr-...   # outside sbx, the real key
pi install git:github.com/Dotnaught/pi-omlx-sandbox
```

Or, from a local clone, `pi install /path/to/pi-omlx-sandbox`. To try it for a single
run without installing, use `pi -e /path/to/pi-omlx-sandbox`. Then choose a model
with `/model`, or start on one with `pi --model trustedrouter/confidential`. Pi only
lists the models when `TRUSTEDROUTER_API_KEY` is set in the environment it starts
from.

## Access limitations

| Dimension | Protection | Notes |
|---|---|---|
| Host filesystem | Strong | Only the paths passed to `sbx run`, plus the read-only skills store |
| Local network | Minimal | Open policy; Pi can reach any port on the host via `host.docker.internal` |
| Internet | Minimal | Open policy; Pi can reach any domain |
| Credentials | Proxy-managed | Tokens injected by proxy, never exposed in container env; TrustedRouter's env var holds only a placeholder |
| Git identity | Disclosed | Your Git `user.name` and `user.email` are set inside the sandbox so Pi's commits are attributed to you |

Filesystem isolation is the primary protection. Pi runs inside a Docker container as a non-root `agent` user and can reach only the host paths passed to `sbx run` (read-only where marked `:ro`) and the sbx skills store, which is mounted read-only.

Network isolation is weak by design. Open policy (`sbx policy set-default open`) is required for the sbx proxy to reach oMLX on the host. Under Open policy, all outbound traffic is allowed — the `network-policy@1` allow list in `pi.yaml` is not an enforced allow-list. Its role is to enable credential injection: the sbx proxy adds the stored `github` secret to requests to `api.github.com`, and swaps the TrustedRouter placeholder for the real key on requests to `api.trustedrouter.com`, so Pi never sees either real value.

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
- `extensions/trustedrouter/` — the TrustedRouter provider extension, copied alongside it
- `CLAUDE.md` — global instructions copied to `~/.pi/agent/CLAUDE.md`
