#!/bin/bash
# Exercises pi-start.sh model selection, self-update and error paths against
# fixture payloads with curl and pi stubbed out, then pi.yaml and the
# extension's behaviour. Needs neither Docker nor a running oMLX, except to
# build the kit for the pi.yaml checks.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

mkdir -p "$work/bin" "$work/home"

cat >"$work/bin/pi" <<'EOF'
#!/bin/bash
if [[ "${1:-}" == "update" ]]; then
  echo "PI_UPDATE: $*"
  exit "${PI_UPDATE_STATUS:-0}"
fi
echo "PI_ARGS: $*"
EOF

cat >"$work/bin/curl" <<'EOF'
#!/bin/bash
# Mimics `curl -s -o FILE -w '%{http_code}'`: copy the fixture, print the code.
out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o)
      out="$2"
      shift 2
      ;;
    *) shift ;;
  esac
done
[[ -n "$out" && -f "${FIXTURE:-}" ]] && cp "$FIXTURE" "$out"
printf '%s' "${HTTP_CODE:-200}"
[[ "${HTTP_CODE:-200}" == "000" ]] && exit 7
exit 0
EOF

chmod +x "$work/bin/pi" "$work/bin/curl"

fixture() { printf '%s' "$2" >"$work/$1"; }

# The loaded chat model is deliberately not first, so a "take chat[0]"
# regression is distinguishable from correct loaded-first selection.
fixture loaded.json '{"models":[
 {"id":"bge-reranker-v2-m3","model_type":"reranker","loaded":true},
 {"id":"nomic-embed","model_type":"embedding","loaded":true},
 {"id":"gemma-4-27b","model_type":"llm","loaded":false},
 {"id":"Qwen3.6-35B","model_type":"llm","loaded":true,"max_context_window":32768,"max_tokens":8192},
 {"id":"qwen3-8b","model_type":"llm","loaded":false},
 {"id":"Qwen3-VL-8B","model_type":"vlm","loaded":false}]}'
fixture none-loaded.json '{"models":[
 {"id":"nomic-embed","model_type":"embedding","loaded":false},
 {"id":"gemma-4-27b","model_type":"llm","loaded":false}]}'
fixture no-chat.json '{"models":[{"id":"nomic-embed","model_type":"embedding","loaded":true}]}'
fixture legacy.json '{"models":[{"id":"legacy-model","loaded":true}]}'
fixture bad-shape.json '{"data":[{"id":"x"}]}'
fixture not-json.json '<html><body>502 Bad Gateway</body></html>'
fixture server-error.json '{"detail":"engine pool is not initialized"}'
fixture empty.json ''
fixture long-error.json "$(printf 'x%.0s' {1..300})PAST-THE-CAP"
fixture zero-ctx.json '{"models":[{"id":"m","model_type":"llm","loaded":true,"max_context_window":0}]}'

pass=0
fail=0

# Prints the entrypoint's combined output followed by "exit=N", so assertions
# can cover the exit status as well as the message.
launch() { # fixture http_code [omlx_model] -- keeps whatever $HOME already holds
  local output status
  output=$(
    env PATH="$work/bin:$PATH" HOME="$work/home" FIXTURE="$work/$1" \
      HTTP_CODE="$2" OMLX_MODEL="${3:-}" PI_UPDATE_STATUS="${PI_UPDATE_STATUS:-0}" OMLX_PORT=8010 \
      OMLX_CATALOG="$script_dir/extensions/omlx/catalog.mjs" \
      bash "$script_dir/pi-start.sh" 2>&1
  ) && status=0 || status=$?
  printf '%s\nexit=%s' "$output" "$status"
}

run() { # fixture http_code [omlx_model] -- starts from an empty $HOME
  find "$work/home" -mindepth 1 -delete 2>/dev/null || true
  launch "$@"
}

expect() { # label expected_substring actual
  if [[ "$3" == *"$2"* ]]; then
    pass=$((pass + 1))
    echo "ok   - $1"
  else
    fail=$((fail + 1))
    echo "FAIL - $1"
    echo "       expected to contain: $2"
    echo "       got: $3"
  fi
}

expect "prefers the loaded chat model over loaded non-chat models" \
  "PI_ARGS: --model omlx/Qwen3.6-35B" "$(run loaded.json 200)"
expect "launches Pi successfully" "exit=0" "$(run loaded.json 200)"
expect "falls back to the first chat model when none are loaded" \
  "PI_ARGS: --model omlx/gemma-4-27b" "$(run none-loaded.json 200)"
expect "accepts a model with no model_type (legacy oMLX)" \
  "PI_ARGS: --model omlx/legacy-model" "$(run legacy.json 200)"
expect "honours a valid OMLX_MODEL pin" \
  "PI_ARGS: --model omlx/gemma-4-27b" "$(run loaded.json 200 gemma-4-27b)"
expect "rejects an OMLX_MODEL pin that oMLX does not serve" \
  'is not served by oMLX' "$(run loaded.json 200 nope-27B-fp16)"
expect "lists valid IDs when a pin is rejected" \
  "available: gemma-4-27b, Qwen3.6-35B" "$(run loaded.json 200 nope-27B-fp16)"
expect "errors when oMLX serves no chat models" \
  "serves no llm or vlm models" "$(run no-chat.json 200)"
expect "errors on an unexpected payload shape" \
  "expected a models array" "$(run bad-shape.json 200)"
expect "reports non-JSON bodies without a stack trace" \
  "returned a non-JSON response" "$(run not-json.json 200)"
expect "echoes the offending body snippet" \
  "502 Bad Gateway" "$(run not-json.json 200)"
expect "distinguishes an unreachable server" \
  "cannot reach oMLX" "$(run loaded.json 000)"
expect "distinguishes an auth rejection from an outage" \
  "skip API key verification" "$(run loaded.json 401)"
expect "surfaces other HTTP failures" \
  "returned HTTP 500" "$(run server-error.json 500)"
expect "echoes the body of other HTTP failures" \
  "body: {\"detail\":\"engine pool is not initialized\"}" "$(run server-error.json 500)"
expect "omits the body line when the failure has no body" \
  "no-body" "$(
    result="$(run empty.json 500)"
    [[ "$result" != *body:* ]] && echo "no-body"
  )"
expect "caps the echoed body at 300 bytes" \
  "capped" "$(
    result="$(run long-error.json 500)"
    [[ "$result" == *"body: xxx"* && "$result" != *PAST-THE-CAP* ]] && echo "capped"
  )"

# Every error path must abort rather than fall through into launching Pi.
for case in "no-chat.json 200" "bad-shape.json 200" "not-json.json 200" \
  "loaded.json 000" "loaded.json 401" "loaded.json 500"; do
  # shellcheck disable=SC2086  # deliberate word splitting of the case pair
  result="$(run $case)"
  expect "aborts on $case" "exit=1" "$result"
  expect "does not launch Pi on $case" "no-launch" "$(
    [[ "$result" != *PI_ARGS* ]] && echo "no-launch"
  )"
  expect "does not update Pi on $case" "no-update" "$(
    [[ "$result" != *PI_UPDATE* ]] && echo "no-update"
  )"
done
expect "aborts on a rejected pin" "exit=1" "$(run loaded.json 200 nope-27B-fp16)"

result=$(
  env -u OMLX_PORT PATH="$work/bin:$PATH" HOME="$work/home" FIXTURE="$work/loaded.json" \
    OMLX_CATALOG="$script_dir/extensions/omlx/catalog.mjs" bash "$script_dir/pi-start.sh" 2>&1
) && status=0 || status=$?
expect "refuses to start without OMLX_PORT" "OMLX_PORT is not set" "$result"
expect "exits non-zero without OMLX_PORT" "exit=1" "exit=$status"
expect "does not launch Pi without OMLX_PORT" "no-launch" "$(
  [[ "$result" != *PI_ARGS* && "$result" != *PI_UPDATE* ]] && echo "no-launch"
)"

result=$(run loaded.json 200)
expect "updates Pi on launch" "PI_UPDATE: update --self" "$result"
expect "updates Pi before launching it" "update-first" "$(
  [[ "$result" == *PI_UPDATE*PI_ARGS* ]] && echo "update-first"
)"
result=$(PI_UPDATE_STATUS=1 run loaded.json 200)
expect "warns when the update fails" "could not update Pi" "$result"
expect "launches the installed Pi when the update fails" \
  "PI_ARGS: --model omlx/Qwen3.6-35B" "$result"
expect "exits cleanly when the update fails" "exit=0" "$result"

run loaded.json 200 >/dev/null
config=$(cat "$work/home/.pi/agent/models.json")
expect "passes through the oMLX context window" '"contextWindow": 32768' "$config"
expect "passes through the oMLX max output tokens" '"maxTokens": 8192' "$config"
expect "marks vlm models as image-capable" '"image"' "$config"
expect "sets the local-server compat flags" '"maxTokensField": "max_tokens"' "$config"

# reasoning: false collapses Pi's thinking levels to ["off"], and an explicit
# supportsReasoningEffort: false suppresses the reasoning_effort parameter
# outright. Either one silently stops the model from thinking.
expect "flags every chat model as reasoning-capable" "none-disabled" "$(
  [[ "$config" != *'"reasoning": false'* ]] && echo "none-disabled"
)"
expect "never disables reasoning_effort support" "not-disabled" "$(
  [[ "$config" != *'"supportsReasoningEffort": false'* ]] && echo "not-disabled"
)"

# Extension-supplied models are spread verbatim, so every field Pi would
# otherwise default must be present in the shared mapping.
for field in name reasoning input cost contextWindow maxTokens compat; do
  expect "emits a complete entry: $field" "\"$field\"" "$config"
done

run zero-ctx.json 200 >/dev/null
expect "falls back to oMLX's default window when the reported one is unusable" \
  '"contextWindow": 32768' "$(cat "$work/home/.pi/agent/models.json")"

fixture small-model.json '{"models":[
 {"id":"tiny","model_type":"llm","loaded":true,"max_context_window":4096}]}'
run small-model.json 200 >/dev/null
expect "never lets the output budget exceed the context window" \
  '"maxTokens": 4096' "$(cat "$work/home/.pi/agent/models.json")"

# Pi writes /settings changes into the same file the entrypoint pins the
# provider in, so a restart must merge rather than replace.
run loaded.json 200 >/dev/null
printf '%s' '{"theme":"dark","defaultThinkingLevel":"high"}' \
  >"$work/home/.pi/agent/settings.json"
launch loaded.json 200 >/dev/null
settings=$(cat "$work/home/.pi/agent/settings.json")
expect "keeps the thinking level chosen in /settings" \
  '"defaultThinkingLevel": "high"' "$settings"
expect "keeps unrelated settings across a restart" '"theme": "dark"' "$settings"
expect "still pins the provider" '"defaultProvider": "omlx"' "$settings"
expect "still pins the selected model" '"defaultModel": "Qwen3.6-35B"' "$settings"

# The entrypoint is the only way into the sandbox, so an unusable settings file
# has to be recoverable in-band: warn, reset, and still launch.
for bad in 'not json' '"a string"' '[1,2]' 'null'; do
  printf '%s' "$bad" >"$work/home/.pi/agent/settings.json"
  result=$(launch loaded.json 200)
  expect "warns about an unusable settings file: $bad" "warning: resetting" "$result"
  expect "still launches Pi with an unusable settings file: $bad" "exit=0" "$result"
  # Asserting on the whole key set rather than probing for spread index keys,
  # which only the string and array inputs can produce.
  expect "resets to nothing but the provider pin: $bad" "ok" "$(
    node -e '
      const fs = require("node:fs");
      const settings = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const keys = Object.keys(settings).sort().join(",");
      process.stdout.write(keys === "defaultModel,defaultProvider" ? "ok" : keys);
    ' "$work/home/.pi/agent/settings.json"
  )"
  expect "still pins the provider after a reset: $bad" \
    '"defaultProvider": "omlx"' "$(cat "$work/home/.pi/agent/settings.json")"
done

# pi-sbx runs against an sbx stub that lists SBX_EXISTING as its sandboxes and
# echoes every other call, framed so a trailing extra argument fails a match.
# /bin/bash is used on purpose: macOS ships bash 3.2, where an empty array
# expansion under set -u is an error.
mkdir -p "$work/sbxbin" "$work/projects/My App" "$work/projects/other/My App" \
  "$work/projects/日本"
cat >"$work/sbxbin/sbx" <<'EOF'
#!/bin/bash
if [[ "$1 ${2:-}" == "ls -q" ]]; then
  [[ -n "${SBX_LS_FAIL:-}" ]] && exit 1
  printf '%s\n' ${SBX_EXISTING:-}
  exit 0
fi
printf 'SBX:'
printf ' %s' "$@"
printf ' <END>\n'
EOF
chmod +x "$work/sbxbin/sbx"

wrap() { # cwd [pi-sbx args...]; prints output then "exit=N"
  local dir="$1" output status
  shift
  output=$(cd "$dir" && PATH="$work/sbxbin:$PATH" /bin/bash "$script_dir/pi-sbx" "$@" 2>&1) &&
    status=0 || status=$?
  printf '%s\nexit=%s' "$output" "$status"
}
name_of() { sed -n 's/^SBX: run --name \([^ ]*\) .*/\1/p' <<<"$1"; }

app="$work/projects/My App"
app_real=$(cd "$app" && pwd -P)
kit_real=$(cd "$script_dir" && pwd -P)
created=$(wrap "$app")
app_name=$(name_of "$created")
expect "creates a sandbox from the kit on the current directory" \
  "SBX: run --name $app_name $kit_real $app_real -- <END>" "$created"
expect "names the sandbox from the sanitized directory name" "ok" \
  "$([[ "$app_name" =~ ^pi-my-app-[0-9a-f]{8}$ ]] && echo ok || echo "$app_name")"
expect "the name is stable across runs" "$app_name" "$(name_of "$(wrap "$app")")"
other_name=$(name_of "$(wrap "$work/projects/other/My App")")
expect "same-named projects in different places get different sandboxes" "ok" \
  "$([[ -n "$other_name" && "$other_name" != "$app_name" ]] && echo ok)"
expect "falls back to a generic name when nothing in the directory name is usable" "ok" \
  "$([[ "$(name_of "$(wrap "$work/projects/日本")")" =~ ^pi-project-[0-9a-f]{8}$ ]] && echo ok)"
expect "takes the project directory as an argument" \
  "SBX: run --name $app_name $kit_real $app_real -- <END>" "$(wrap / "$app")"
pinned="SBX: run --name $app_name --kit-arg model=qwen3-8b $kit_real $app_real"
expect "passes the model pin and extra mounts when creating" \
  "$pinned /tmp:ro -- --continue <END>" "$(wrap / -m qwen3-8b "$app" /tmp:ro -- --continue)"
expect "re-attaches by name, without the kit, when the sandbox exists" \
  "SBX: run --name $app_name -- --resume <END>" \
  "$(SBX_EXISTING="other $app_name" wrap "$app" -- --resume)"
refused=$(SBX_EXISTING="$app_name" wrap "$app" -m qwen3-8b)
expect "refuses a model pin for an existing sandbox" "only when creating it" "$refused"
expect "says how to recreate it" "hint: sbx rm $app_name" "$refused"
expect "exits non-zero when refusing" "exit=1" "$refused"
expect "refuses extra mounts for an existing sandbox" "only when creating it" \
  "$(SBX_EXISTING="$app_name" wrap / "$app" /tmp:ro)"
expect "rejects a missing project directory" "error: not a directory: /nonexistent" \
  "$(wrap / /nonexistent)"
expect "rejects -m without a value" "error: -m needs a model ID" "$(wrap "$app" -m)"
expect "rejects unknown options" "error: unknown option: --bogus" "$(wrap "$app" --bogus)"
listing_failed=$(SBX_LS_FAIL=1 wrap "$app")
expect "fails fast when sandboxes cannot be listed" "error: could not list sandboxes" \
  "$listing_failed"
expect "does not try to create a sandbox when listing fails" "ok" \
  "$([[ "$listing_failed" != *"SBX: run"* ]] && echo ok)"
# Only meaningful where the filesystem ignores case, as macOS does by default.
if [[ -d "$work/projects/my app" ]]; then
  expect "mounts the on-disk casing, not the typed one" \
    "SBX: run --name $app_name $kit_real $app_real -- <END>" \
    "$(wrap / "$work/projects/my app")"
else
  echo "skip - case-sensitive filesystem; casing check skipped"
fi

# `sbx kit inspect --json` drops the entry-level `optional` flag and the whole
# agent-skills and git-identity capabilities, so these are read from pi.yaml
# itself. Losing `optional: true` makes the sandbox refuse to start without a
# github secret, under `sbx run --skills=off`, or on a host with no Git
# identity, while every other check still passes.
capabilities=$(awk '
  /^  - type: / { type = $3; print "type:" type }
  type && /^    optional: true$/ { print "optional:" type }
  type && /^      path: / { print "path:" type "=" $2 }
' "$script_dir/pi.yaml")
expect "the github credential is optional" \
  "optional:com.docker.sandbox/credential@1" "$capabilities"
expect "the skills mount is optional" \
  "optional:com.docker.sandbox/agent-skills@1" "$capabilities"
expect "the skills store mounts where Pi reads global skills" \
  "path:com.docker.sandbox/agent-skills@1=/home/agent/.pi/agent/skills" "$capabilities"
expect "commits carry the user's Git identity" \
  "type:com.docker.sandbox/git-identity@1" "$capabilities"
expect "the Git identity is optional" \
  "optional:com.docker.sandbox/git-identity@1" "$capabilities"

# A well-formed descriptor can still resolve to the wrong policy, and `sbx kit
# validate` does not accept a v3 source kit at all, so build the kit and assert
# on what sbx resolved from it.
if command -v sbx >/dev/null 2>&1; then
  kit_json=$(sbx kit inspect "$script_dir" --json 2>"$work/kit.err") || kit_json=""
  spec=""
  if [[ -n "$kit_json" ]]; then
    # A stray line on stdout (a warning, a progress message) makes the output
    # unparseable, which is reported below rather than letting set -e abort.
    # shellcheck disable=SC2016  # single quotes are required: the ${...} below
    # are JS template literals resolved by node, not bash expansions.
    spec=$(printf '%s' "$kit_json" | node -e '
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  const kit = JSON.parse(raw);
  const creds = kit.credentials ?? [];
  const injects = creds.flatMap((c) => c.apiKey?.inject ?? []);
  const allow = kit.permissions?.network?.allow ?? [];
  const allowedHosts = new Set(allow.map((a) => a.replace(/:\d+$/, "")));
  const out = {
    "schema": kit.schemaVersion ?? "missing",
    "empty-service": creds.filter((c) => !c.service).length,
    "inject-rules": injects.length,
    "incomplete-inject": injects.filter((i) => !i.domain || !i.header).length,
    "inject-outside-allow": injects.filter((i) => !allowedHosts.has(i.domain)).length,
    "network-allow-empty": allow.length === 0 ? "yes" : "no",
    "omlx-port": allow.find((d) => d.startsWith("host.docker.internal:"))?.split(":")[1] ?? "none",
    "npm-allowed": allowedHosts.has("registry.npmjs.org") ? "yes" : "no",
    "entrypoint": (kit.sandbox?.entrypoint ?? ["missing"]).join(" "),
    "volumes": (kit.volumes ?? []).map((v) => v.path).join(",") || "none",
    "model-env": JSON.stringify(kit.environment?.variables?.OMLX_MODEL ?? null),
  };
  for (const [k, v] of Object.entries(out)) console.log(`${k}=${v}`);
});
' 2>/dev/null) || spec=""
  fi

  if [[ -z "$kit_json" ]]; then
    fail=$((fail + 1))
    echo "FAIL - could not build or inspect the kit; pi.yaml is unverified"
    echo "       building needs Docker and the sbx daemon (sbx daemon status)"
    sed 's/^/       sbx: /' "$work/kit.err"
  elif [[ -z "$spec" ]]; then
    fail=$((fail + 1))
    echo "FAIL - sbx kit inspect did not return JSON; pi.yaml is unverified"
    printf '%s\n' "$kit_json" | head -5 | sed 's/^/       sbx: /'
  else
    expect "pi.yaml is kit-spec v3" "schema=3" "$spec"
    expect "every credential has a service identifier" "empty-service=0" "$spec"
    expect "credential injection is configured" "inject-rules=1" "$spec"
    expect "every inject rule has a domain and header" "incomplete-inject=0" "$spec"
    expect "every inject domain is on the allow list" "inject-outside-allow=0" "$spec"
    expect "the network allow list survives the schema" "network-allow-empty=no" "$spec"
    # The allow entry and the ENV that pi-start.sh reads are two copies of one
    # port; if they drift apart, the sandbox dials a port the policy never opened.
    dockerfile_port=$(sed -n 's/^ENV OMLX_PORT=//p' "$script_dir/pi.dockerfile")
    expect "OMLX_PORT is set in pi.dockerfile" "set" "$([[ -n "$dockerfile_port" ]] && echo set)"
    expect "the allow list opens the port OMLX_PORT names" \
      "omlx-port=${dockerfile_port:-unset}" "$spec"
    expect "the npm registry is reachable for pi update" "npm-allowed=yes" "$spec"
    expect "the entrypoint matches the path pi.dockerfile installs" \
      "entrypoint=/usr/local/bin/pi-start.sh" "$spec"
    expect "sessions persist on a volume where Pi stores them" \
      "volumes=/home/agent/.pi/agent/sessions" "$spec"
    # A non-empty default would pin every sandbox to one model, and a missing
    # export would make --kit-arg model a silent no-op.
    expect "the model arg reaches OMLX_MODEL, empty by default" 'model-env=""' "$spec"
  fi
else
  echo "skip - sbx not installed; pi.yaml checks skipped"
fi

echo
echo "passed: $pass  failed: $fail"
[[ $fail -eq 0 ]] || exit 1

echo
echo "--- extension ---"
node --test "$script_dir/test-extension.mjs"
