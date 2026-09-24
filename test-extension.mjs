// Unit tests for the oMLX provider extension's refresh behaviour.
// Run via ./test.sh, or directly with `node --test test-extension.mjs`.

import { strict as assert } from "node:assert";
import test from "node:test";

const BASE_URL = "http://omlx.test/v1";

const PAYLOAD = {
  models: [
    { id: "nomic-embed", model_type: "embedding", loaded: true },
    { id: "gemma-4-27b", model_type: "llm", loaded: false },
    {
      id: "Qwen3.6-35B",
      model_type: "llm",
      loaded: true,
      max_context_window: 32768,
      max_tokens: 8192,
    },
  ],
};

// The extension resolves its base URL once at module load, so tests that need a
// different environment import under a distinct specifier to force re-evaluation.
async function register(cacheBust = "") {
  const { default: activate } = await import(`./extensions/omlx/index.ts${cacheBust}`);
  const registered = [];
  activate({ registerProvider: (id, config) => registered.push({ id, config }) });
  return registered;
}

function stubFetch(impl) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return () => {
    globalThis.fetch = original;
  };
}

const ok = (payload) => async () => ({ ok: true, status: 200, json: async () => payload });
const online = { allowNetwork: true, signal: { aborted: false } };

process.env.OMLX_BASE_URL = BASE_URL;

test("registers an omlx provider pointing at the configured server", async () => {
  const [entry] = await register();
  assert.equal(entry.id, "omlx");
  assert.equal(entry.config.baseUrl, BASE_URL);
  assert.equal(entry.config.api, "openai-completions");
  assert.equal(typeof entry.config.refreshModels, "function");
});

test("honours OMLX_PORT when no explicit base URL is set", async () => {
  const saved = process.env.OMLX_BASE_URL;
  delete process.env.OMLX_BASE_URL;
  process.env.OMLX_PORT = "8123";
  try {
    const [entry] = await register("?port");
    assert.equal(entry.config.baseUrl, "http://host.docker.internal:8123/v1");
  } finally {
    process.env.OMLX_BASE_URL = saved;
    delete process.env.OMLX_PORT;
  }
});

test("refuses to load when neither OMLX_BASE_URL nor OMLX_PORT is set", async () => {
  const saved = process.env.OMLX_BASE_URL;
  delete process.env.OMLX_BASE_URL;
  delete process.env.OMLX_PORT;
  try {
    await assert.rejects(register("?unset"), /neither OMLX_BASE_URL nor OMLX_PORT is set/);
  } finally {
    process.env.OMLX_BASE_URL = saved;
  }
});

test("returns the live catalog, filtered to chat models", async () => {
  const restore = stubFetch(ok(PAYLOAD));
  try {
    const [{ config }] = await register();
    const models = await config.refreshModels(online);
    assert.deepEqual(
      models.map((m) => m.id),
      ["gemma-4-27b", "Qwen3.6-35B"],
    );
    assert.equal(models[1].contextWindow, 32768);
    assert.equal(models[1].maxTokens, 8192);
  } finally {
    restore();
  }
});

// A refresh replaces the seeded catalog wholesale, so it has to carry the
// thinking configuration too: reasoning: false collapses Pi's thinking levels
// to ["off"], and supportsReasoningEffort: false drops the parameter entirely.
test("keeps refreshed models thinking-capable", async () => {
  const restore = stubFetch(ok(PAYLOAD));
  try {
    const [{ config }] = await register();
    const models = await config.refreshModels(online);
    for (const model of models) {
      assert.equal(model.reasoning, true, `${model.id} must stay reasoning-capable`);
      assert.equal(model.compat.supportsReasoningEffort, undefined);
    }
  } finally {
    restore();
  }
});

test("requests the status endpoint, not the plain model listing", async () => {
  let requested;
  const restore = stubFetch(async (url) => {
    requested = url;
    return { ok: true, status: 200, json: async () => PAYLOAD };
  });
  try {
    const [{ config }] = await register();
    await config.refreshModels(online);
    assert.equal(requested, `${BASE_URL}/models/status`);
  } finally {
    restore();
  }
});

// An empty array would replace the seeded catalog; undefined leaves it alone.
// Both cases must also skip the request entirely rather than fail into it.
test("skips the request and keeps the seed when the refresh is offline", async () => {
  let called = false;
  const restore = stubFetch(async () => {
    called = true;
    return { ok: true, status: 200, json: async () => PAYLOAD };
  });
  try {
    const [{ config }] = await register();
    const context = { allowNetwork: false, signal: { aborted: false } };
    assert.equal(await config.refreshModels(context), undefined);
    assert.equal(called, false, "offline refresh must not reach the network");
  } finally {
    restore();
  }
});

test("skips the request and keeps the seed when already aborted", async () => {
  let called = false;
  const restore = stubFetch(async () => {
    called = true;
    return { ok: true, status: 200, json: async () => PAYLOAD };
  });
  try {
    const [{ config }] = await register();
    const context = { allowNetwork: true, signal: { aborted: true } };
    assert.equal(await config.refreshModels(context), undefined);
    assert.equal(called, false, "aborted refresh must not reach the network");
  } finally {
    restore();
  }
});

// Failures propagate rather than being swallowed: Pi records them per provider,
// warns the user, and retains the previous catalog by never reaching its publish
// step. Returning a fallback here would hide the warning.
test("propagates connection failures so Pi can report them", async () => {
  const restore = stubFetch(async () => {
    throw new Error("ECONNREFUSED");
  });
  try {
    const [{ config }] = await register();
    await assert.rejects(config.refreshModels(online), /ECONNREFUSED/);
  } finally {
    restore();
  }
});

test("propagates HTTP errors with the status code", async () => {
  const restore = stubFetch(async () => ({ ok: false, status: 503, json: async () => ({}) }));
  try {
    const [{ config }] = await register();
    await assert.rejects(config.refreshModels(online), /503/);
  } finally {
    restore();
  }
});

test("propagates a catalog with no chat models", async () => {
  const restore = stubFetch(ok({ models: [{ id: "nomic-embed", model_type: "embedding" }] }));
  try {
    const [{ config }] = await register();
    await assert.rejects(config.refreshModels(online), /no llm or vlm models/);
  } finally {
    restore();
  }
});

test("clamps the output budget to the context window", async () => {
  const restore = stubFetch(
    ok({ models: [{ id: "tiny", model_type: "llm", max_context_window: 4096 }] }),
  );
  try {
    const [{ config }] = await register();
    const [model] = await config.refreshModels(online);
    assert.equal(model.contextWindow, 4096);
    assert.equal(model.maxTokens, 4096);
  } finally {
    restore();
  }
});
