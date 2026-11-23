// TrustedRouter catalog mapping, kept apart from index.ts so the tests can
// exercise it without registering a provider.

export const BASE_URL = "https://api.trustedrouter.com/v1";

// Sent as the request body's `provider` field on every call. TrustedRouter
// fails closed on it: a request whose model has no route with verified
// confidential compute, end-to-end encryption and zero data retention is
// rejected before inference instead of falling back to a weaker route.
export const PRIVACY_ROUTING = { min_privacy: "confidential" };

// TrustedRouter is OpenRouter-compatible. Pi copies compat.openRouterRouting
// into the body's `provider` field for any openai-completions endpoint, not
// only openrouter.ai, which is what carries the privacy floor.
const ROUTER_COMPAT = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsUsageInStreaming: true,
  maxTokensField: "max_tokens",
  openRouterRouting: PRIVACY_ROUTING,
};

// Pi sends maxTokens as max_tokens on every request, and TrustedRouter rejects
// any request whose prompt plus max_tokens exceeds the window (HTTP 400). Pi
// compacts once free context drops below reserveTokens (16384 by default), so
// an output budget no larger than that always fits; a model's own ceiling,
// often most of a 1M window, would start failing long before compaction.
const MAX_OUTPUT_TOKENS = 16384;

const positive = (value) => (typeof value === "number" && value > 0 ? value : undefined);

// Catalog prices are USD per token as decimal strings; Pi wants USD per million.
const perMillion = (price) => {
  const value = Number(price);
  return Number.isFinite(value) && value > 0 ? value * 1_000_000 : 0;
};

// Routing pools that let TrustedRouter pick the model per request.
// "confidential" draws on every route meeting PRIVACY_ROUTING; "trusted" further
// restricts it to operators TrustedRouter vets. Pool rows carry no capabilities
// block, so they are listed by ID instead of passing the filter below.
export const CONFIDENTIAL_POOLS = ["trustedrouter/confidential", "trustedrouter/trusted"];

const isChatCapable = (row) =>
  row.architecture?.output_modalities?.includes("text") === true &&
  positive(row.context_length) !== undefined;

// The catalog mixes embeddings, speech, transcription and non-confidential
// models. A coding agent needs text out and tool calls, and only models with a
// confidential route can serve a request carrying PRIVACY_ROUTING.
function isConfidentialAgentModel(row) {
  if (CONFIDENTIAL_POOLS.includes(row.id)) {
    return isChatCapable(row) && row.supported_parameters?.includes("tools") === true;
  }
  const capabilities = row.trustedrouter?.capabilities;
  return capabilities?.confidential === true && capabilities.tools === true && isChatCapable(row);
}

export function confidentialAgentModels(payload) {
  const rows = payload?.data;
  if (!Array.isArray(rows)) {
    throw new Error("unexpected TrustedRouter /v1/models payload; expected a data array");
  }
  const usable = rows.filter(isConfidentialAgentModel);
  if (usable.length === 0) {
    throw new Error("TrustedRouter lists no confidential models with tool support");
  }
  return usable;
}

const PI_THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];

// The catalog leaves these models' accepted reasoning_effort values unverified
// (null), but their confidential routes reject "minimal" and "medium" with HTTP
// 400, which is Pi's default level. Probed against the live routes on
// 2026-11-23; the routes' own error messages name the same set.
export const REASONING_EFFORT_OVERRIDES = {
  "deepseek/deepseek-v4.1-flash": ["none", "low", "high", "xhigh", "max"],
  "deepseek/deepseek-v4.1-flash-1017": ["none", "low", "high", "xhigh", "max"],
};

// Catalog semantics: a non-empty list is the verified set of accepted values,
// [] means the effort control must not be sent, and null means unverified.
const acceptedEfforts = (row) =>
  REASONING_EFFORT_OVERRIDES[row.id] ?? row.trustedrouter?.capabilities?.reasoning_effort;

// Levels outside the accepted set map to null, which Pi treats as unsupported:
// it hides them and clamps the session's level to the next supported one up,
// so a default "medium" becomes "high" rather than a rejected request.
// Unverified models keep Pi's defaults, since restricting them would only guess.
function thinkingLevelMap(efforts) {
  if (!Array.isArray(efforts) || efforts.length === 0) {
    return undefined;
  }
  const map = {};
  for (const level of PI_THINKING_LEVELS) {
    map[level] = efforts.includes(level) ? level : null;
  }
  if (efforts.includes("none")) {
    map.off = "none";
  }
  return map;
}

function reasoningFields(row) {
  const efforts = acceptedEfforts(row);
  if (Array.isArray(efforts) && efforts.length === 0) {
    return { reasoning: false };
  }
  const parameters = row.supported_parameters ?? [];
  const map = thinkingLevelMap(efforts);
  return {
    reasoning: parameters.includes("reasoning") || parameters.includes("reasoning_effort"),
    ...(map ? { thinkingLevelMap: map } : {}),
  };
}

// Entries are complete rather than minimal because Pi fills defaults only for
// models.json definitions; extension-supplied models are spread verbatim.
export function toProviderModels(rows) {
  return rows.map((row) => {
    const contextWindow = row.context_length;
    return {
      id: row.id,
      name: row.name ?? row.id,
      ...reasoningFields(row),
      input: row.architecture.input_modalities?.includes("image") ? ["text", "image"] : ["text"],
      cost: {
        // A pool's plain prices are its cheapest route's; the _max prices are
        // its dearest, which TrustedRouter also reserves credit against.
        // Overstating keeps Pi's running cost from understating the bill.
        input: perMillion(row.pricing?.prompt_max ?? row.pricing?.prompt),
        output: perMillion(row.pricing?.completion_max ?? row.pricing?.completion),
        cacheRead: perMillion(row.pricing?.input_cache_read),
        cacheWrite: perMillion(row.pricing?.input_cache_write),
      },
      contextWindow,
      maxTokens: Math.min(
        positive(row.top_provider?.max_completion_tokens) ?? MAX_OUTPUT_TOKENS,
        MAX_OUTPUT_TOKENS,
        contextWindow,
      ),
      compat: { ...ROUTER_COMPAT },
    };
  });
}

export async function fetchConfidentialModels(signal) {
  const response = await fetch(`${BASE_URL}/models`, { signal });
  if (!response.ok) {
    throw new Error(`TrustedRouter returned HTTP ${response.status} for /v1/models`);
  }
  return confidentialAgentModels(await response.json());
}
