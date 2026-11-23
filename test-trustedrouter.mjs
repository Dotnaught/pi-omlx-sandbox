// Unit tests for the TrustedRouter provider extension.
// Run via ./test.sh, or directly with `node --test test-trustedrouter.mjs`.

import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const HOUR_MS = 60 * 60 * 1000;

const confidential = (id, overrides = {}) => ({
  id,
  name: `Name of ${id}`,
  context_length: 262144,
  architecture: { input_modalities: ["text"], output_modalities: ["text"] },
  supported_parameters: ["tools", "max_tokens"],
  pricing: { prompt: "0.0000003", completion: "0.0000015", input_cache_read: "0.00000015" },
  top_provider: { max_completion_tokens: 131072 },
  trustedrouter: { capabilities: { confidential: true, tools: true } },
  ...overrides,
});

// Pool rows describe a set of routes, so they carry no capabilities block and
// report no output ceiling of their own.
const pool = (id, overrides = {}) => ({
  id,
  name: `Pool ${id}`,
  context_length: 1048576,
  architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
  supported_parameters: ["tools", "max_tokens"],
  pricing: {
    prompt: "0.00000001",
    completion: "0.00000007",
    prompt_max: "0.000004",
    completion_max: "0.00002",
  },
  top_provider: { max_completion_tokens: null },
  trustedrouter: { route_kind: "e2e_pool" },
  ...overrides,
});

const PAYLOAD = {
  data: [
    confidential("z-ai/glm-5.3", {
      architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
      supported_parameters: ["tools", "reasoning", "reasoning_effort"],
    }),
    confidential("openai/gpt-5.5", {
      trustedrouter: { capabilities: { confidential: false, tools: true } },
    }),
    confidential("deepseek/deepseek-ocr-2", {
      trustedrouter: { capabilities: { confidential: true, tools: false } },
    }),
    confidential("qwen/qwen3-embedding-4b", {
      architecture: { input_modalities: ["text"], output_modalities: ["embeddings"] },
    }),
    // Router aliases such as trustedrouter/auto carry no capabilities block.
    { id: "trustedrouter/auto", context_length: 1048576, trustedrouter: {} },
    confidential("qwen/qwen3.8-27b", {
      context_length: 65536,
      top_provider: { max_completion_tokens: 65536 },
    }),
  ],
};

const ok = (payload) => async () => ({ ok: true, status: 200, json: async () => payload });
const failing = (message) => async () => Promise.reject(new Error(message));
const signal = { aborted: false };
const online = { allowNetwork: true, signal };

// Counts requests, so tests can assert that a fresh cache avoids the network.
function serve(impl = ok(PAYLOAD)) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(url);
    return impl(url, init);
  };
  return { calls, restore: () => (globalThis.fetch = original) };
}

function captureStderr() {
  const original = console.error;
  const lines = [];
  console.error = (line) => lines.push(String(line));
  return { lines, restore: () => (console.error = original) };
}

// Each test gets its own agent directory, so caches never leak between tests.
function freshAgentDir() {
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "tr-test-"));
  return process.env.PI_CODING_AGENT_DIR;
}

const cacheFile = (dir) => join(dir, "trustedrouter-models.json");

function writeCache(dir, rows, ageMs) {
  writeFileSync(cacheFile(dir), JSON.stringify({ checkedAt: Date.now() - ageMs, rows }));
}

const readCache = (dir) => JSON.parse(readFileSync(cacheFile(dir), "utf8"));

// The factory reads the environment and the cache at load, so each call
// imports under a distinct specifier and runs the factory afresh.
let loads = 0;
let handlers = {};
async function register() {
  loads += 1;
  const { default: activate } = await import(`./extensions/trustedrouter/index.ts?${loads}`);
  const registered = [];
  handlers = {};
  await activate({
    registerProvider: (id, config) => registered.push({ id, config }),
    on: (event, handler) => (handlers[event] = handler),
  });
  return registered;
}

// Runs the factory against a stubbed catalog with stderr captured, and
// returns the registered config, the request log and the warnings.
async function load(impl) {
  const server = serve(impl);
  const stderr = captureStderr();
  try {
    const registered = await register();
    const config = registered[0]?.config;
    return { config, registered, calls: server.calls, warnings: stderr.lines };
  } finally {
    stderr.restore();
    server.restore();
  }
}

const ids = (models) => models.map((model) => model.id);

process.env.TRUSTEDROUTER_API_KEY = "placeholder";
delete process.env.PI_OFFLINE;

test("registers nothing without TRUSTEDROUTER_API_KEY, and fetches nothing", async () => {
  freshAgentDir();
  delete process.env.TRUSTEDROUTER_API_KEY;
  try {
    const { registered, calls } = await load();
    assert.deepEqual(registered, []);
    assert.deepEqual(calls, []);
  } finally {
    process.env.TRUSTEDROUTER_API_KEY = "placeholder";
  }
});

test("registers the provider with the key read from the environment", async () => {
  freshAgentDir();
  const { registered } = await load();
  assert.equal(registered[0].id, "trustedrouter");
  assert.equal(registered[0].config.baseUrl, "https://api.trustedrouter.com/v1");
  assert.equal(registered[0].config.api, "openai-completions");
  // A literal key here would bypass the sbx placeholder the proxy swaps out.
  assert.equal(registered[0].config.apiKey, "$TRUSTEDROUTER_API_KEY");
});

// --- startup and the cache ---

test("fetches /v1/models at startup when nothing is saved, and saves it", async () => {
  const dir = freshAgentDir();
  const { config, calls } = await load();
  assert.deepEqual(calls, ["https://api.trustedrouter.com/v1/models"]);
  assert.deepEqual(ids(config.models), ["z-ai/glm-5.3", "qwen/qwen3.8-27b"]);
  const saved = readCache(dir);
  assert.deepEqual(ids(saved.rows), ["z-ai/glm-5.3", "qwen/qwen3.8-27b"]);
  assert.ok(Date.now() - saved.checkedAt < 5000);
});

test("starts from a fresh saved list without touching the network", async () => {
  const dir = freshAgentDir();
  writeCache(dir, [confidential("saved/model")], HOUR_MS / 2);
  const { config, calls } = await load();
  assert.deepEqual(calls, []);
  assert.deepEqual(ids(config.models), ["saved/model"]);
});

test("refetches a saved list older than an hour", async () => {
  const dir = freshAgentDir();
  writeCache(dir, [confidential("saved/model")], HOUR_MS + 1000);
  const { config, calls } = await load();
  assert.equal(calls.length, 1);
  assert.deepEqual(ids(config.models), ["z-ai/glm-5.3", "qwen/qwen3.8-27b"]);
  assert.deepEqual(ids(readCache(dir).rows), ["z-ai/glm-5.3", "qwen/qwen3.8-27b"]);
});

test("uses a stale saved list under PI_OFFLINE without fetching", async () => {
  const dir = freshAgentDir();
  writeCache(dir, [confidential("saved/model")], HOUR_MS * 24);
  process.env.PI_OFFLINE = "1";
  try {
    const { config, calls } = await load();
    assert.deepEqual(calls, []);
    assert.deepEqual(ids(config.models), ["saved/model"]);
  } finally {
    delete process.env.PI_OFFLINE;
  }
});

test("under PI_OFFLINE with nothing saved, warns and registers no models", async () => {
  freshAgentDir();
  process.env.PI_OFFLINE = "1";
  try {
    const { config, calls, warnings } = await load();
    assert.deepEqual(calls, []);
    assert.equal(config.models, undefined);
    assert.match(warnings.join("\n"), /PI_OFFLINE is set/);
    assert.match(warnings.join("\n"), /hint: start Pi once without PI_OFFLINE/);
  } finally {
    delete process.env.PI_OFFLINE;
  }
});

test("keeps a stale saved list when the startup fetch fails", async () => {
  const dir = freshAgentDir();
  writeCache(dir, [confidential("saved/model")], HOUR_MS * 2);
  const { config, warnings } = await load(failing("ECONNREFUSED"));
  assert.deepEqual(ids(config.models), ["saved/model"]);
  assert.match(warnings.join("\n"), /ECONNREFUSED.*using the saved list/);
});

test("ignores a corrupt saved list, with a warning, and refetches", async () => {
  const dir = freshAgentDir();
  writeFileSync(cacheFile(dir), "{ not json");
  const { config, calls, warnings } = await load();
  assert.equal(calls.length, 1);
  assert.deepEqual(ids(config.models), ["z-ai/glm-5.3", "qwen/qwen3.8-27b"]);
  assert.match(warnings.join("\n"), /not a saved TrustedRouter model list/);
});

test("still registers the models when the list cannot be saved", async () => {
  // A file where the agent directory should be makes every write fail.
  const parent = mkdtempSync(join(tmpdir(), "tr-test-"));
  writeFileSync(join(parent, "agent"), "");
  process.env.PI_CODING_AGENT_DIR = join(parent, "agent");
  const { config, warnings } = await load();
  assert.deepEqual(ids(config.models), ["z-ai/glm-5.3", "qwen/qwen3.8-27b"]);
  assert.match(warnings.join("\n"), /cannot save/);
});

// oMLX models do not depend on TrustedRouter, so its outage must not stop Pi,
// and the warning has to explain the "not found" Pi reports afterwards.
for (const [label, impl, reason] of [
  ["unreachable", failing("ECONNREFUSED"), /ECONNREFUSED/],
  ["erroring", async () => ({ ok: false, status: 503, json: async () => ({}) }), /HTTP 503/],
  ["serving an unexpected payload", ok({ models: [] }), /expected a data array/],
  ["listing no usable models", ok({ data: [PAYLOAD.data[1]] }), /no confidential models/],
]) {
  test(`warns and registers no models when TrustedRouter is ${label}`, async () => {
    freshAgentDir();
    const { config, warnings } = await load(impl);
    assert.equal(config.models, undefined);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], reason);
    assert.match(warnings[0], /including the fallback when oMLX is down/);
  });
}

// --- the model list ---

test("offers only confidential, tool-capable chat models", async () => {
  freshAgentDir();
  const { config } = await load();
  assert.deepEqual(ids(config.models), ["z-ai/glm-5.3", "qwen/qwen3.8-27b"]);
});

test("requires confidential compute on every model it offers", async () => {
  freshAgentDir();
  const { config } = await load();
  for (const model of config.models) {
    assert.deepEqual(model.compat.openRouterRouting, { min_privacy: "confidential" });
  }
});

test("maps catalog metadata onto Pi's model fields", async () => {
  freshAgentDir();
  const { config } = await load();
  const [glm, qwen] = config.models;
  assert.equal(glm.name, "Name of z-ai/glm-5.3");
  assert.equal(glm.reasoning, true);
  assert.equal(qwen.reasoning, false);
  assert.deepEqual(glm.input, ["text", "image"]);
  assert.deepEqual(qwen.input, ["text"]);
  assert.equal(glm.contextWindow, 262144);
  assert.ok(Math.abs(glm.cost.input - 0.3) < 1e-9);
  assert.ok(Math.abs(glm.cost.output - 1.5) < 1e-9);
  assert.ok(Math.abs(glm.cost.cacheRead - 0.15) < 1e-9);
  assert.equal(glm.cost.cacheWrite, 0);
});

// TrustedRouter answers HTTP 400 when prompt plus max_tokens exceeds the window,
// and Pi sends maxTokens on every request, so a model's own ceiling would fail
// as soon as the conversation grew past window minus ceiling.
test("caps the output budget at Pi's compaction reserve", async () => {
  freshAgentDir();
  const { config } = await load();
  for (const model of config.models) {
    assert.equal(model.maxTokens, 16384, model.id);
  }
});

test("keeps the output budget within a smaller context window", async () => {
  freshAgentDir();
  const { config } = await load(
    ok({ data: [confidential("tiny/model", { context_length: 8192 })] }),
  );
  assert.equal(config.models[0].maxTokens, 8192);
});

test("keeps a model's own output ceiling when it is below the cap", async () => {
  freshAgentDir();
  const { config } = await load(
    ok({ data: [confidential("gemma", { top_provider: { max_completion_tokens: 8000 } })] }),
  );
  assert.equal(config.models[0].maxTokens, 8000);
});

test("offers the confidential and trusted routing pools", async () => {
  freshAgentDir();
  const { config } = await load(
    ok({
      data: [
        pool("trustedrouter/confidential"),
        pool("trustedrouter/trusted"),
        pool("trustedrouter/auto"),
        confidential("z-ai/glm-5.3"),
      ],
    }),
  );
  assert.deepEqual(ids(config.models), [
    "trustedrouter/confidential",
    "trustedrouter/trusted",
    "z-ai/glm-5.3",
  ]);
  const [confidentialPool] = config.models;
  assert.equal(confidentialPool.maxTokens, 16384);
  assert.deepEqual(confidentialPool.compat.openRouterRouting, { min_privacy: "confidential" });
});

// A pool's plain prices are its cheapest route's. Pi's cost display must not
// understate a bill that can be set by the pool's dearest route.
test("prices a pool at its most expensive route", async () => {
  freshAgentDir();
  const { config } = await load(ok({ data: [pool("trustedrouter/trusted")] }));
  assert.ok(Math.abs(config.models[0].cost.input - 4) < 1e-9);
  assert.ok(Math.abs(config.models[0].cost.output - 20) < 1e-9);
});

test("leaves out a pool that stops accepting tool calls", async () => {
  freshAgentDir();
  const { config } = await load(
    ok({
      data: [
        pool("trustedrouter/trusted", { supported_parameters: ["max_tokens"] }),
        confidential("z-ai/glm-5.3"),
      ],
    }),
  );
  assert.deepEqual(ids(config.models), ["z-ai/glm-5.3"]);
});

// --- refreshes while Pi runs ---

async function refresh(config, context, impl = ok(PAYLOAD)) {
  const server = serve(impl);
  try {
    return { result: await config.refreshModels(context), calls: server.calls };
  } finally {
    server.restore();
  }
}

test("refresh keeps the current list without network or once aborted", async () => {
  freshAgentDir();
  const { config } = await load();
  for (const context of [
    { allowNetwork: false, signal },
    { allowNetwork: true, signal: { aborted: true } },
  ]) {
    const { result, calls } = await refresh(config, context);
    assert.equal(result, undefined);
    assert.deepEqual(calls, []);
  }
});

test("refresh keeps the current list while the saved one is fresh", async () => {
  freshAgentDir();
  const { config } = await load();
  const { result, calls } = await refresh(config, online);
  assert.equal(result, undefined);
  assert.deepEqual(calls, []);
});

test("refresh refetches and saves once the saved list is stale", async () => {
  const dir = freshAgentDir();
  const { config } = await load();
  writeCache(dir, [confidential("saved/model")], HOUR_MS + 1000);
  const newer = ok({ data: [confidential("new/model")] });
  const { result, calls } = await refresh(config, online, newer);
  assert.equal(calls.length, 1);
  assert.deepEqual(ids(result), ["new/model"]);
  assert.deepEqual(ids(readCache(dir).rows), ["new/model"]);
});

test("a forced refresh fetches even when the saved list is fresh", async () => {
  freshAgentDir();
  const { config } = await load();
  const { result, calls } = await refresh(config, { ...online, force: true });
  assert.equal(calls.length, 1);
  assert.deepEqual(ids(result), ["z-ai/glm-5.3", "qwen/qwen3.8-27b"]);
});

// Pi reports a failed refresh and keeps the current list; a fallback value
// returned here would hide that warning.
test("refresh propagates failures so Pi can report them", async () => {
  freshAgentDir();
  const { config } = await load();
  const server = serve(async () => ({ ok: false, status: 502, json: async () => ({}) }));
  try {
    await assert.rejects(
      config.refreshModels({ ...online, force: true }),
      /TrustedRouter catalog refresh failed \(TrustedRouter returned HTTP 502/,
    );
  } finally {
    server.restore();
  }
});

// --- thinking levels ---

const withEfforts = (id, efforts) =>
  confidential(id, {
    supported_parameters: ["tools", "reasoning", "reasoning_effort"],
    trustedrouter: { capabilities: { confidential: true, tools: true, reasoning_effort: efforts } },
  });

// GLM's confidential route rejects "medium", Pi's default level, with HTTP 400.
test("marks levels a route does not accept as unsupported", async () => {
  freshAgentDir();
  const glm = withEfforts("z-ai/glm-5.3-flash", ["low", "high", "max"]);
  const { config } = await load(ok({ data: [glm] }));
  assert.deepEqual(config.models[0].thinkingLevelMap, {
    minimal: null,
    low: "low",
    medium: null,
    high: "high",
    xhigh: null,
    max: "max",
  });
});

test("maps off to an accepted none", async () => {
  freshAgentDir();
  const { config } = await load(ok({ data: [withEfforts("m/none", ["none", "low", "high"])] }));
  assert.equal(config.models[0].thinkingLevelMap.off, "none");
});

test("leaves unverified models on Pi's defaults", async () => {
  freshAgentDir();
  const { config } = await load(ok({ data: [withEfforts("m/unverified", null)] }));
  assert.equal(config.models[0].thinkingLevelMap, undefined);
  assert.equal(config.models[0].reasoning, true);
});

test("turns reasoning off for a route verified to accept no effort", async () => {
  freshAgentDir();
  const { config } = await load(ok({ data: [withEfforts("m/no-effort", [])] }));
  assert.equal(config.models[0].reasoning, false);
  assert.equal(config.models[0].thinkingLevelMap, undefined);
});

// The catalog leaves DeepSeek V4.1 unverified, but its routes reject "medium".
test("applies the probed levels where the catalog has none", async () => {
  freshAgentDir();
  const { config } = await load(
    ok({ data: [withEfforts("deepseek/deepseek-v4.1-flash", null)] }),
  );
  const map = config.models[0].thinkingLevelMap;
  assert.equal(map.medium, null);
  assert.equal(map.minimal, null);
  assert.equal(map.high, "high");
  assert.equal(map.xhigh, "xhigh");
  assert.equal(map.off, "none");
});

// --- privacy display wiring (no network: offline, or not a TrustedRouter model) ---

function fakeUi() {
  const widgets = {};
  const statuses = {};
  return {
    widgets,
    statuses,
    ctx: {
      hasUI: true,
      ui: {
        setWidget: (key, lines) => (widgets[key] = lines),
        setStatus: (key, text) => (statuses[key] = text),
      },
    },
  };
}

test("clears the privacy display when a non-TrustedRouter model is selected", async () => {
  freshAgentDir();
  await load();
  const { widgets, statuses, ctx } = fakeUi();
  widgets.trustedrouter = ["stale"];
  statuses.trustedrouter = "stale";
  await handlers.model_select({ model: { provider: "omlx", id: "qwen" } }, ctx);
  assert.equal(widgets.trustedrouter, undefined);
  assert.equal(statuses.trustedrouter, undefined);
});

test("shows the privacy requirement without network access under PI_OFFLINE", async () => {
  freshAgentDir();
  await load();
  const { widgets, ctx } = fakeUi();
  process.env.PI_OFFLINE = "1";
  const server = serve();
  try {
    await handlers.model_select({ model: { provider: "trustedrouter", id: "z-ai/glm-5.3" } }, ctx);
  } finally {
    server.restore();
    delete process.env.PI_OFFLINE;
  }
  assert.deepEqual(server.calls, []);
  const text = widgets.trustedrouter.join("\n");
  assert.match(text, /requires min_privacy "confidential"/);
  assert.match(text, /not checked \(PI_OFFLINE is set\)/);
});

test("draws nothing without a UI", async () => {
  freshAgentDir();
  await load();
  const { widgets, ctx } = fakeUi();
  await handlers.model_select(
    { model: { provider: "trustedrouter", id: "z-ai/glm-5.3" } },
    { ...ctx, hasUI: false },
  );
  assert.deepEqual(widgets, {});
});

test("names the route that served each TrustedRouter reply in the footer", async () => {
  freshAgentDir();
  await load();
  const { statuses, ctx } = fakeUi();
  const usage = {
    provider_usage: {
      selected_provider: "tinfoil",
      selected_model: "deepseek/deepseek-v4.1-flash-1017",
      gateway_region: "us-east4",
      fallback_attempt_count: 0,
    },
  };
  handlers.provider_stream_event({ provider: "omlx", data: { usage } }, ctx);
  assert.equal(statuses.trustedrouter, undefined);
  handlers.provider_stream_event({ provider: "trustedrouter", data: { choices: [] } }, ctx);
  assert.equal(statuses.trustedrouter, undefined);
  handlers.provider_stream_event({ provider: "trustedrouter", data: { usage } }, ctx);
  assert.equal(
    statuses.trustedrouter,
    "TrustedRouter: served by tinfoil · deepseek/deepseek-v4.1-flash-1017 · gateway us-east4",
  );
});
