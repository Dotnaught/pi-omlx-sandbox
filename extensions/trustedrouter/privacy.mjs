// Turns TrustedRouter's route catalog, the gateway attestation check and each
// response's routing report into the lines Pi shows while a TrustedRouter
// model is selected.

import { CONFIDENTIAL_POOLS, PRIVACY_ROUTING } from "./catalog.mjs";

// TrustedRouter's privacy tiers: 3 is Confidential, 4 is Trusted. Lower tiers
// cannot serve a request carrying PRIVACY_ROUTING, so they are not shown.
const CONFIDENTIAL_TIER = 3;

const TRUSTED_POOL_OPERATORS = "Tinfoil, Privatemode and Maple";

const mark = (value) => {
  if (value === true) {
    return "yes";
  }
  return value === false ? "NO" : "unreported";
};

/**
 * Reduces GET /v1/models/{id}/endpoints to the routes a confidential request
 * may take, one per operator (prepaid and bring-your-own-key rows repeat it).
 */
export function confidentialRoutes(payload) {
  const endpoints = payload?.data;
  if (!Array.isArray(endpoints)) {
    throw new Error("unexpected TrustedRouter endpoints payload; expected a data array");
  }
  const routes = new Map();
  for (const endpoint of endpoints) {
    const facts = endpoint.trustedrouter ?? {};
    if (!(facts.privacy_tier >= CONFIDENTIAL_TIER) || routes.has(endpoint.provider_name)) {
      continue;
    }
    routes.set(endpoint.provider_name, {
      operator: endpoint.provider_name,
      country: facts.provider_headquarters_country,
      tier: facts.privacy_tier_label,
      confidentialCompute: facts.provider_confidential_compute,
      endToEndEncryption: facts.provider_e2ee,
      zeroRetention: facts.provider_zero_data_retention,
      storesContent: facts.stores_content,
      policyUrl: facts.provider_policy_url,
    });
  }
  return [...routes.values()];
}

function routeLine(route) {
  const where = [route.country, route.tier].filter(Boolean).join(", ");
  const facts =
    `confidential compute ${mark(route.confidentialCompute)} · ` +
    `end-to-end encryption ${mark(route.endToEndEncryption)} · ` +
    `zero retention ${mark(route.zeroRetention)} · ` +
    `stores content ${route.storesContent ? "YES" : "no"}`;
  const policy = route.policyUrl ? ` · ${route.policyUrl}` : "";
  return `  Route ${route.operator}${where ? ` (${where})` : ""}: ${facts}${policy}`;
}

/**
 * Lines describing what the model's requests require and which routes can
 * serve them. `routes` is an array, "pending" while the lookup runs, or an
 * Error when it failed.
 */
export function modelLines(modelId, routes) {
  const lines = [
    `TrustedRouter ${modelId}: every request requires min_privacy ` +
      `"${PRIVACY_ROUTING.min_privacy}" (verified confidential compute, end-to-end ` +
      "encryption and zero retention) and is refused rather than sent elsewhere if no route " +
      "qualifies",
  ];
  if (CONFIDENTIAL_POOLS.includes(modelId)) {
    const operators = modelId.endsWith("/trusted") ? ` from ${TRUSTED_POOL_OPERATORS}` : "";
    lines.push(
      `  Pool: TrustedRouter picks a qualifying route${operators} for each request; ` +
        "the footer names the one that served the last reply",
    );
    return lines;
  }
  if (routes === "pending") {
    lines.push("  Routes: looking up...");
  } else if (routes instanceof Error) {
    lines.push(`  Route details unavailable: ${routes.message}`);
  } else if (routes.length === 0) {
    lines.push("  No route currently qualifies, so requests to this model will be refused");
  } else {
    lines.push(...routes.map(routeLine));
  }
  return lines;
}

const HARDWARE_NAMES = { GCP_INTEL_TDX: "Intel TDX" };

function gatewayLine(gateway) {
  if (gateway instanceof Error) {
    return `Gateway attestation FAILED: ${gateway.message}`;
  }
  const hardware = HARDWARE_NAMES[gateway.hardware] ?? gateway.hardware;
  return (
    `Gateway attestation verified: ${hardware} ${gateway.software}, debug ${gateway.debug}, ` +
    `TCB ${gateway.tcbStatus}, image matches TrustedRouter's published release, ` +
    "TLS key bound to the measured workload"
  );
}

function pathLine(path, gateway) {
  if (path instanceof Error) {
    return `Pi's connection could not be checked: ${path.message}`;
  }
  if (gateway instanceof Error) {
    return (
      `Pi's connection presents a certificate from ${path.issuer}; with no verified ` +
      "attestation there is nothing to compare it with"
    );
  }
  if (path.certFingerprint === gateway.certFingerprint) {
    return "Pi's connection ends at the attested gateway (same TLS certificate)";
  }
  const sandboxProxy = path.issuer.includes("Docker Sandboxes")
    ? " (the sbx proxy on this machine, which adds the API key)"
    : "";
  return (
    `Pi's connection is decrypted and re-encrypted by ${path.issuer}${sandboxProxy} ` +
    "before it reaches the gateway, so that hop can read prompts"
  );
}

/**
 * Lines for the gateway check: "pending", "offline", or the settled
 * { gateway, path } pair, each a result object or an Error.
 */
export function gatewayLines(check) {
  if (check === "pending") {
    return ["Gateway attestation: checking..."];
  }
  if (check === "offline") {
    return ["Gateway attestation: not checked (PI_OFFLINE is set)"];
  }
  return [gatewayLine(check.gateway), pathLine(check.path, check.gateway)];
}

/** Footer text naming the route that served a reply, from its usage report. */
export function servedStatus(usage) {
  const report = usage?.provider_usage;
  if (!report?.selected_provider) {
    return undefined;
  }
  const fallbacks = report.fallback_attempt_count
    ? ` · ${report.fallback_attempt_count} fallback(s)`
    : "";
  return (
    `TrustedRouter: served by ${report.selected_provider} · ${report.selected_model} · ` +
    `gateway ${report.gateway_region}${fallbacks}`
  );
}
