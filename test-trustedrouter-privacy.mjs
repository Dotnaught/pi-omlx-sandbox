// Unit tests for the TrustedRouter gateway attestation check and the privacy
// display text. Run via ./test.sh, or `node --test test-trustedrouter-privacy.mjs`.

import { strict as assert } from "node:assert";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import { once } from "node:events";
import { createServer } from "node:http";

import {
  AUDIENCE,
  ISSUER,
  inspectPiPath,
  piProxyEnv,
  verifyGatewayToken,
} from "./extensions/trustedrouter/attestation.mjs";
import { registerPrivacyDisplay } from "./extensions/trustedrouter/index.ts";
import {
  confidentialRoutes,
  gatewayLines,
  modelLines,
  servedStatus,
} from "./extensions/trustedrouter/privacy.mjs";

// --- gateway attestation ---

const NOW = Date.UTC(2026, 10, 23, 12, 0, 0);
const DIGEST = "sha256:e0934d3e257daa1bac62658adb11a428e44aaf5a8d8598e949787d0a85241e11";
const BINDINGS = {
  nonce: "aa".repeat(32),
  exporter: "bb".repeat(32),
  certFingerprint: "cc".repeat(32),
};

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWKS = {
  keys: [{ ...publicKey.export({ format: "jwk" }), kid: "google-key", alg: "RS256" }],
};
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });

const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

function claims(overrides = {}) {
  return {
    iss: ISSUER,
    aud: AUDIENCE,
    iat: NOW / 1000 - 10,
    nbf: NOW / 1000 - 10,
    exp: NOW / 1000 + 3600,
    hwmodel: "GCP_INTEL_TDX",
    swname: "CONFIDENTIAL_SPACE",
    secboot: true,
    dbgstat: "disabled-since-boot",
    eat_nonce: [BINDINGS.certFingerprint, BINDINGS.exporter, BINDINGS.nonce],
    submods: { container: { image_digest: DIGEST } },
    tdx: { gcp_attester_tcb_status: "UpToDate" },
    ...overrides,
  };
}

const GOOGLE_HEADER = { alg: "RS256", kid: "google-key" };

function token({ payload = claims(), header = GOOGLE_HEADER, key = privateKey } = {}) {
  const input = `${encode(header)}.${encode(payload)}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), key).toString("base64url")}`;
}

const check = (overrides = {}) =>
  verifyGatewayToken({
    token: token(),
    jwks: JWKS,
    publishedDigest: DIGEST,
    bindings: BINDINGS,
    now: NOW,
    ...overrides,
  });

test("accepts a valid, bound attestation and summarises it", () => {
  assert.deepEqual(check(), {
    hardware: "GCP_INTEL_TDX",
    software: "CONFIDENTIAL_SPACE",
    secureBoot: true,
    debug: "disabled-since-boot",
    tcbStatus: "UpToDate",
    imageDigest: DIGEST,
    certFingerprint: BINDINGS.certFingerprint,
  });
});

test("accepts an audience list and a token with surrounding whitespace", () => {
  const audienceList = token({ payload: claims({ aud: ["other", AUDIENCE] }) });
  assert.equal(check({ token: `\n${audienceList}\n` }).imageDigest, DIGEST);
});

for (const [label, overrides, reason] of [
  ["a token that is not a JWT", { token: "not-a-token" }, /not a signed token/],
  ["a signature from another key", { token: token({ key: other.privateKey }) }, /does not verify/],
  ["an unknown key id", { token: token({ header: { alg: "RS256", kid: "x" } }) }, /not among/],
  [
    "a non-RS256 algorithm",
    { token: token({ header: { alg: "none", kid: "google-key" } }) },
    /none/,
  ],
  ["another issuer", { token: token({ payload: claims({ iss: "https://evil" }) }) }, /issuer/],
  ["another audience", { token: token({ payload: claims({ aud: "someone" }) }) }, /audience/],
  ["an expired token", { now: NOW + 2 * 3600 * 1000 }, /expired/],
  ["a token not yet valid", { now: NOW - 3600 * 1000 }, /not valid yet/],
  [
    "debugging enabled",
    { token: token({ payload: claims({ dbgstat: "enabled" }) }) },
    /debugging enabled/,
  ],
  [
    "debugging enabled in a nested claim",
    {
      token: token({
        payload: claims({ submods: { container: { image_digest: DIGEST }, dbgstat: "enabled" } }),
      }),
    },
    /debugging enabled/,
  ],
  ["an unpublished image", { publishedDigest: "sha256:other" }, /publishes sha256:other/],
  ["a replayed token", { bindings: { ...BINDINGS, nonce: "dd".repeat(32) } }, /replay/],
  ["another TLS session", { bindings: { ...BINDINGS, exporter: "dd".repeat(32) } }, /TLS session/],
  [
    "another certificate",
    { bindings: { ...BINDINGS, certFingerprint: "dd".repeat(32) } },
    /certificate the gateway presented/,
  ],
]) {
  test(`rejects ${label}`, () => {
    assert.throws(() => check(overrides), reason);
  });
}

// A tampered claim set must fail the signature, not slip through the checks.
test("rejects claims altered after signing", () => {
  const [header, , signature] = token().split(".");
  const forged = `${header}.${encode(claims({ submods: { container: { image_digest: "x" } } }))}`;
  assert.throws(() => check({ token: `${forged}.${signature}` }), /does not verify/);
});

// --- route list ---

const endpoint = (provider, tier, facts = {}) => ({
  provider_name: provider,
  trustedrouter: {
    privacy_tier: tier,
    privacy_tier_label: tier >= 4 ? "Trusted" : tier === 3 ? "Confidential" : "Zero retention",
    provider_headquarters_country: "DE",
    provider_confidential_compute: true,
    provider_e2ee: true,
    provider_zero_data_retention: true,
    stores_content: false,
    provider_policy_url: `https://${provider.toLowerCase()}.example/policy`,
    ...facts,
  },
});

test("keeps only routes a confidential request can use, once per operator", () => {
  const routes = confidentialRoutes({
    data: [
      endpoint("Parasail", 2),
      endpoint("Privatemode", 4),
      endpoint("Privatemode", 4),
      endpoint("Tinfoil", 3, { provider_headquarters_country: "US" }),
    ],
  });
  assert.deepEqual(
    routes.map((route) => [route.operator, route.country, route.tier]),
    [
      ["Privatemode", "DE", "Trusted"],
      ["Tinfoil", "US", "Confidential"],
    ],
  );
});

test("rejects an unexpected endpoints payload", () => {
  assert.throws(() => confidentialRoutes({ models: [] }), /expected a data array/);
});

// --- display text ---

test("states the privacy floor and lists each route's guarantees", () => {
  const [floor, route] = modelLines(
    "z-ai/glm-5.3-flash",
    confidentialRoutes({ data: [endpoint("Privatemode", 4)] }),
  );
  assert.match(floor, /requires min_privacy "confidential"/);
  assert.match(floor, /refused rather than sent elsewhere/);
  assert.equal(
    route,
    "  Route Privatemode (DE, Trusted): confidential compute yes · end-to-end encryption yes · " +
      "zero retention yes · stores content no · https://privatemode.example/policy",
  );
});

test("flags missing and unreported guarantees rather than hiding them", () => {
  const [, route] = modelLines(
    "m",
    confidentialRoutes({
      data: [
        endpoint("Odd", 3, {
          provider_e2ee: null,
          provider_zero_data_retention: false,
          stores_content: true,
        }),
      ],
    }),
  );
  assert.match(route, /end-to-end encryption unreported/);
  assert.match(route, /zero retention NO/);
  assert.match(route, /stores content YES/);
});

test("says when no route qualifies, the lookup is running, or it failed", () => {
  assert.equal(modelLines("m", "pending")[1], "  Routes: looking up...");
  assert.match(modelLines("m", [])[1], /No route currently qualifies/);
  assert.match(modelLines("m", new Error("HTTP 503"))[1], /Route details unavailable: HTTP 503/);
});

test("describes the pools instead of listing routes", () => {
  assert.match(modelLines("trustedrouter/confidential", [])[1], /picks a qualifying route for/);
  assert.match(
    modelLines("trustedrouter/trusted", [])[1],
    /from Tinfoil, Privatemode and Maple/,
  );
});

const GATEWAY = {
  hardware: "GCP_INTEL_TDX",
  software: "CONFIDENTIAL_SPACE",
  debug: "disabled-since-boot",
  tcbStatus: "UpToDate",
  certFingerprint: "cc".repeat(32),
};

test("reports a verified gateway reached directly", () => {
  const [gateway, path] = gatewayLines({
    gateway: GATEWAY,
    path: { certFingerprint: "cc".repeat(32), issuer: "Let's Encrypt, YE1" },
  });
  assert.match(gateway, /^Gateway attestation verified: Intel TDX CONFIDENTIAL_SPACE/);
  assert.match(gateway, /image matches TrustedRouter's published release/);
  assert.equal(path, "Pi's connection ends at the attested gateway (same TLS certificate)");
});

// Inside the sandbox the sbx proxy terminates TLS to inject the key.
test("names the sbx proxy when it sits between Pi and the gateway", () => {
  const [, path] = gatewayLines({
    gateway: GATEWAY,
    path: {
      certFingerprint: "dd".repeat(32),
      issuer: "Docker Sandboxes, Docker Sandboxes Proxy CA",
    },
  });
  assert.match(path, /re-encrypted by Docker Sandboxes, Docker Sandboxes Proxy CA \(the sbx proxy/);
  assert.match(path, /that hop can read prompts/);
});

test("reports any other interception, and failures of either check", () => {
  const [, intercepted] = gatewayLines({
    gateway: GATEWAY,
    path: { certFingerprint: "dd".repeat(32), issuer: "Corp, Inspection CA" },
  });
  assert.match(intercepted, /re-encrypted by Corp, Inspection CA before/);
  assert.doesNotMatch(intercepted, /sbx proxy/);
  const [failed, unchecked] = gatewayLines({
    gateway: new Error("attestation has expired"),
    path: new Error("ECONNRESET"),
  });
  assert.equal(failed, "Gateway attestation FAILED: attestation has expired");
  assert.equal(unchecked, "Pi's connection could not be checked: ECONNRESET");
});

// With no verified gateway there is no attested certificate to match against.
test("does not call a connection attested when the gateway check failed", () => {
  const [, path] = gatewayLines({
    gateway: new Error("x"),
    path: { certFingerprint: "cc".repeat(32), issuer: "Let's Encrypt, YE1" },
  });
  assert.equal(
    path,
    "Pi's connection presents a certificate from Let's Encrypt, YE1; with no verified " +
      "attestation there is nothing to compare it with",
  );
});

test("shows the pending and offline states", () => {
  assert.deepEqual(gatewayLines("pending"), ["Gateway attestation: checking..."]);
  assert.deepEqual(gatewayLines("offline"), [
    "Gateway attestation: not checked (PI_OFFLINE is set)",
  ]);
});

test("counts fallbacks in the footer and ignores chunks without a routing report", () => {
  assert.equal(servedStatus(undefined), undefined);
  assert.equal(servedStatus({ prompt_tokens: 3 }), undefined);
  assert.match(
    servedStatus({
      provider_usage: {
        selected_provider: "chutes",
        selected_model: "m",
        gateway_region: "eu",
        fallback_attempt_count: 2,
      },
    }),
    /served by chutes · m · gateway eu · 2 fallback\(s\)/,
  );
});

// --- which path Pi's requests take ---

// Pi's HTTP client is undici's EnvHttpProxyAgent; the check must pick the same proxy.
test("picks the proxy Pi's HTTP client would use", () => {
  assert.equal(piProxyEnv({}), undefined);
  assert.deepEqual(piProxyEnv({ HTTPS_PROXY: "http://s:1" }), {
    HTTPS_PROXY: "http://s:1",
    NO_PROXY: "",
  });
  // undici falls back to the plain-HTTP proxy for HTTPS; Node's own support does not.
  assert.equal(piProxyEnv({ HTTP_PROXY: "http://p:1" }).HTTPS_PROXY, "http://p:1");
  const both = { https_proxy: "http://l:1", HTTPS_PROXY: "http://u:1" };
  assert.equal(piProxyEnv(both).HTTPS_PROXY, "http://l:1");
  assert.equal(piProxyEnv({ https_proxy: "", HTTP_PROXY: "http://p:1" }).HTTPS_PROXY, "http://p:1");
  const exclusions = { HTTPS_PROXY: "http://s:1", no_proxy: "a", NO_PROXY: "b" };
  assert.equal(piProxyEnv(exclusions).NO_PROXY, "a");
});

// A proxy that refuses every tunnel, recording what it was asked for.
async function refusingProxy() {
  const tunnels = [];
  const server = createServer();
  server.on("connect", (request, socket) => {
    tunnels.push(request.url);
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { tunnels, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

test("checks Pi's path through an HTTP_PROXY-only proxy, as Pi would send it", async () => {
  const proxy = await refusingProxy();
  try {
    await assert.rejects(inspectPiPath(AbortSignal.timeout(5000), { HTTP_PROXY: proxy.url }));
    assert.deepEqual(proxy.tunnels, ["api.trustedrouter.com:443"]);
  } finally {
    proxy.close();
  }
});

test("bypasses the proxy for a host listed in NO_PROXY, as Pi would", async () => {
  const proxy = await refusingProxy();
  try {
    const env = { HTTPS_PROXY: proxy.url, NO_PROXY: "api.trustedrouter.com" };
    // Goes direct, so the outcome depends on the network; only the proxy matters here.
    await inspectPiPath(AbortSignal.timeout(3000), env).catch(() => {});
    assert.deepEqual(proxy.tunnels, []);
  } finally {
    proxy.close();
  }
});

// --- display scheduling and caching ---

const VERIFIED = { gateway: GATEWAY, path: { certFingerprint: "cc".repeat(32), issuer: "LE" } };
const FAILED = { gateway: new Error("timed out"), path: new Error("timed out") };

function display(checks) {
  const handlers = {};
  registerPrivacyDisplay({ on: (event, handler) => (handlers[event] = handler) }, checks);
  const widgets = [];
  const ctx = {
    hasUI: true,
    ui: { setWidget: (_key, lines) => widgets.push(lines), setStatus: () => {} },
  };
  const select = (id) => handlers.model_select({ model: { provider: "trustedrouter", id } }, ctx);
  return { select, widgets, latest: () => widgets.at(-1)?.join("\n") };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

// Pi awaits handlers, so returning the check would hold up /model until it ends.
test("does not make Pi wait for the checks", async () => {
  const never = new Promise(() => {});
  const { select, latest } = display({ gateway: () => never, routes: () => never });
  assert.equal(select("z-ai/glm-5.3"), undefined);
  assert.match(latest(), /checking\.\.\./);
});

test("runs the gateway check once while it succeeds", async () => {
  let calls = 0;
  const { select } = display({
    gateway: async () => (calls += 1, VERIFIED),
    routes: async () => [],
  });
  select("z-ai/glm-5.3");
  await settle();
  select("z-ai/glm-5.2");
  await settle();
  assert.equal(calls, 1);
});

test("retries a failed gateway check on the next selection", async () => {
  const results = [FAILED, VERIFIED];
  let calls = 0;
  const { select, latest } = display({
    gateway: async () => results[calls++],
    routes: async () => [],
  });
  select("z-ai/glm-5.3");
  await settle();
  assert.match(latest(), /FAILED: timed out/);
  select("z-ai/glm-5.3");
  await settle();
  assert.equal(calls, 2);
  assert.match(latest(), /Gateway attestation verified/);
});

test("retries a failed route lookup but keeps a successful one", async () => {
  const lookups = [];
  const results = [new Error("HTTP 503"), [], []];
  const { select } = display({
    gateway: async () => VERIFIED,
    routes: async (id) => (lookups.push(id), results[lookups.length - 1]),
  });
  for (let i = 0; i < 3; i++) {
    select("z-ai/glm-5.3");
    await settle();
  }
  assert.deepEqual(lookups, ["z-ai/glm-5.3", "z-ai/glm-5.3"]);
});

test("does not look up routes for the pools", async () => {
  const lookups = [];
  const { select } = display({
    gateway: async () => VERIFIED,
    routes: async (id) => (lookups.push(id), []),
  });
  select("trustedrouter/confidential");
  select("trustedrouter/trusted");
  await settle();
  assert.deepEqual(lookups, []);
});

test("does not overwrite the display with a model the user has left", async () => {
  let release;
  const slow = new Promise((resolve) => (release = resolve));
  const { select, latest } = display({
    gateway: async () => VERIFIED,
    routes: (id) => (id === "slow/model" ? slow : Promise.resolve([])),
  });
  select("slow/model");
  select("fast/model");
  await settle();
  release([]);
  await settle();
  assert.match(latest(), /TrustedRouter fast\/model/);
});
