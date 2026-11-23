#!/bin/bash
set -euo pipefail

if [[ -z "${OMLX_PORT:-}" ]]; then
  echo "error: OMLX_PORT is not set" >&2
  echo "hint: restore ENV OMLX_PORT in pi.dockerfile, then recreate the sandbox" >&2
  exit 1
fi
port="$OMLX_PORT"
base_url="http://host.docker.internal:${port}"
status_url="${base_url}/v1/models/status"
config_dir="$HOME/.pi/agent"
catalog="${OMLX_CATALOG:-$config_dir/extensions/omlx/catalog.mjs}"

# The sandbox's hosted model: where `--hosted` (pi-sbx -t) starts, and where a
# session starts when oMLX is down. Set at creation with the hosted_model kit
# arg (pi-sbx -H); empty means TrustedRouter's confidential pool.
hosted_default="${TRUSTEDROUTER_MODEL:-trustedrouter/confidential}"
if [[ "$hosted_default" != trustedrouter/?* ]]; then
  echo "error: TRUSTEDROUTER_MODEL \"${hosted_default}\" is not a TrustedRouter model ID" >&2
  echo "hint: recreate the sandbox with pi-sbx -H trustedrouter/<id>; list IDs with" \
    "pi --list-models trustedrouter" >&2
  exit 1
fi

# The oMLX extension reads this even in a hosted session, so models served by
# an oMLX started mid-session appear the next time the model picker opens.
export OMLX_BASE_URL="${base_url}/v1"

# Pi tracks upstream by updating itself at launch rather than by image rebuilds.
# A failed update (registry unreachable, npm error) must not cost the session,
# so it falls back to the version already installed.
update_pi() {
  if ! pi update --self; then
    echo "warning: could not update Pi; launching the installed version" >&2
  fi
}

# pi-sbx -t runs on the host and cannot see this sandbox's hosted model, so it
# sends this marker, which must come first, and the model is filled in here.
if [[ "${1:-}" == "--hosted" ]]; then
  shift
  set -- --model "$hosted_default" "$@"
fi

# Prints the model when Pi's own arguments select a TrustedRouter one
# (`--model trustedrouter/...`), and nothing otherwise.
requested_hosted_model() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
    --model=trustedrouter/*)
      printf '%s' "${1#--model=}"
      return
      ;;
    --model)
      if [[ "${2:-}" == trustedrouter/* ]]; then
        printf '%s' "$2"
        return
      fi
      ;;
    esac
    shift
  done
}

trustedrouter_configured() { [[ -n "${TRUSTEDROUTER_API_KEY:-}" ]]; }

hosted=$(requested_hosted_model "$@")
if [[ -n "$hosted" ]]; then
  if ! trustedrouter_configured; then
    echo "error: ${hosted} needs a TrustedRouter key, but TRUSTEDROUTER_API_KEY is not set" >&2
    echo "hint: store it with sbx secret set-custom (README step 5), then recreate the sandbox" >&2
    exit 1
  fi
  update_pi
  exec pi "$@"
fi

response=$(mktemp)
trap 'rm -f "$response"' EXIT

# /v1/models lists every model on disk with no load status; /v1/models/status
# adds the `loaded` flag, `model_type` and context limits Pi needs.
code=$(curl -s -o "$response" -w '%{http_code}' --max-time 10 "$status_url") || code="000"

# Inside a sandbox the connection is to the sbx proxy, not oMLX, so a stopped
# oMLX shows up as the proxy's own HTTP 502 rather than a refused connection.
if [[ "$code" == "502" && "$(head -c 10 "$response")" == "sbx proxy:" ]]; then
  code="000"
fi

case "$code" in
200) ;;
000)
  if trustedrouter_configured; then
    echo "warning: cannot reach oMLX at ${status_url}; starting on ${hosted_default}" >&2
    echo "hint: once oMLX is running, pick an omlx model with /model" >&2
    # exec replaces this shell, so the EXIT trap never runs.
    rm -f "$response"
    update_pi
    exec pi --model "$hosted_default" "$@"
  fi
  echo "error: cannot reach oMLX at ${status_url}" >&2
  echo "hint: start oMLX on the host, then restart the sandbox" >&2
  echo "hint: or store a TrustedRouter key (README step 5) to fall back to hosted models" >&2
  exit 1
  ;;
401 | 403)
  echo "error: oMLX rejected the request (HTTP ${code})" >&2
  echo "hint: enable 'skip API key verification' in the oMLX admin panel" >&2
  exit 1
  ;;
*)
  echo "error: oMLX returned HTTP ${code} for ${status_url}" >&2
  # The body usually carries oMLX's own reason, which the code alone hides.
  if [[ -s "$response" ]]; then
    echo "body: $(head -c 300 "$response")" >&2
  fi
  exit 1
  ;;
esac

mkdir -p "$config_dir"

# The extension refreshes this catalog live; models.json is only the seed that
# lets `pi --model` resolve before the first refresh, and the fallback when
# oMLX is unreachable mid-session.
#
# shellcheck disable=SC2016  # single quotes are required: the ${...} below are
# JS template literals resolved by node, not bash parameter expansions.
model=$(
  OMLX_PIN="${OMLX_MODEL:-}" \
    CONFIG_DIR="$config_dir" \
    STATUS_FILE="$response" \
    CATALOG_PATH="$catalog" \
    BASE_URL="${base_url}/v1" \
    node --input-type=module -e '
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { chatModels, toProviderModels, selectModel } = await import(
  pathToFileURL(process.env.CATALOG_PATH).href
);

const raw = readFileSync(process.env.STATUS_FILE, "utf8");
let payload;
try {
  payload = JSON.parse(raw);
} catch (err) {
  console.error(`error: oMLX returned a non-JSON response: ${err.message}`);
  console.error(`body: ${raw.trim().slice(0, 300)}`);
  process.exit(1);
}

let chat;
let selected;
try {
  chat = chatModels(payload);
  selected = selectModel(chat, process.env.OMLX_PIN);
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exit(1);
}

const modelsPath = join(process.env.CONFIG_DIR, "models.json");
writeFileSync(
  modelsPath,
  JSON.stringify({
    providers: {
      omlx: {
        baseUrl: process.env.BASE_URL,
        api: "openai-completions",
        apiKey: "local",
        models: toProviderModels(chat),
      },
    },
  }, null, 2) + "\n",
);
chmodSync(modelsPath, 0o600);

// An unusable settings file is reset rather than fatal. This script is the
// container entrypoint, so aborting would exit the sandbox with no shell left
// to repair the file from. Pi does the same on load.
function readSettings(path) {
  if (!existsSync(path)) {
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    console.error(`warning: resetting ${path}; it is not valid JSON (${err.message})`);
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    console.error(`warning: resetting ${path}; expected a JSON object`);
    return {};
  }
  return parsed;
}

// Pi keeps defaultThinkingLevel, theme, extensions, compaction and packages in
// this same file, so the provider pin is merged in rather than replacing it.
const settingsPath = join(process.env.CONFIG_DIR, "settings.json");
const settings = readSettings(settingsPath);

writeFileSync(
  settingsPath,
  JSON.stringify({ ...settings, defaultProvider: "omlx", defaultModel: selected }, null, 2) + "\n",
);

process.stdout.write(selected);
'
)

# exec replaces this shell, so the EXIT trap never runs.
rm -f "$response"

update_pi
exec pi --model "omlx/${model}" "$@"
