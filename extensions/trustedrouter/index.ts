import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { checkGateway, inspectPiPath } from "./attestation.mjs";
import {
  BASE_URL,
  CONFIDENTIAL_POOLS,
  fetchConfidentialModels,
  toProviderModels,
} from "./catalog.mjs";
import { confidentialRoutes, gatewayLines, modelLines, servedStatus } from "./privacy.mjs";

type CatalogRows = Awaited<ReturnType<typeof fetchConfidentialModels>>;
type ProviderModels = ReturnType<typeof toProviderModels>;

interface CatalogCache {
  checkedAt: number;
  rows: CatalogRows;
}

// The catalog is about 1.5 MB, and Pi refreshes on every start and every time
// the model picker opens, so a saved copy younger than this is reused as is.
export const CATALOG_MAX_AGE_MS = 60 * 60 * 1000;

// A fetch can hold up startup when there is no usable saved copy, so it is bounded.
const FETCH_TIMEOUT_MS = 10_000;

// See the oMLX extension: undefined is Pi's "keep the current catalog" signal.
const KEEP_EXISTING_CATALOG = undefined as unknown as ProviderModels;

// Pi's models store is not used for this: Pi resolves --model before an
// extension's startup refresh can finish, so a fresh store leaves trustedrouter/
// models "not found". The factory below is awaited, and reads this file.
export function cachePath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return join(agentDir, "trustedrouter-models.json");
}

/**
 * Adds TrustedRouter's confidential models beside the local oMLX ones, so
 * Pi's model picker (/model) switches between them mid-session.
 *
 * Inside the sandbox TRUSTEDROUTER_API_KEY holds an sbx placeholder, not the
 * key: the sbx proxy swaps in the real key on requests to api.trustedrouter.com
 * (`sbx secret set-custom`, see the README). Without it the provider is not
 * registered, so the picker never offers models that cannot authenticate.
 */
export default async function (pi: ExtensionAPI) {
  if (!process.env.TRUSTEDROUTER_API_KEY) {
    return;
  }
  const rows = await startupRows();
  pi.registerProvider("trustedrouter", {
    name: "TrustedRouter (confidential)",
    baseUrl: BASE_URL,
    apiKey: "$TRUSTEDROUTER_API_KEY",
    api: "openai-completions",
    ...(rows ? { models: toProviderModels(rows) } : {}),
    async refreshModels(context) {
      if (!context.allowNetwork || context.signal.aborted) {
        return KEEP_EXISTING_CATALOG;
      }
      const cached = await readCache();
      if (cached && isFresh(cached) && !context.force) {
        return KEEP_EXISTING_CATALOG;
      }
      // Pi reports a thrown error as a refresh warning and keeps the current list.
      try {
        return toProviderModels(await fetchAndSave(context.signal));
      } catch (err) {
        throw new Error(`TrustedRouter catalog refresh failed (${(err as Error).message})`, {
          cause: err,
        });
      }
    },
  });
  registerPrivacyDisplay(pi);
}

const DISPLAY_KEY = "trustedrouter";
const CHECK_TIMEOUT_MS = 20_000;

type Model = { provider: string; id: string } | undefined;
type UiContext = {
  hasUI: boolean;
  ui: {
    setWidget(key: string, lines: string[] | undefined): void;
    setStatus(key: string, text: string | undefined): void;
  };
};
type GatewayCheck = { gateway: object | Error; path: object | Error };
type Routes = ReturnType<typeof confidentialRoutes> | Error;

export interface PrivacyChecks {
  gateway(): Promise<GatewayCheck>;
  routes(modelId: string): Promise<Routes>;
}

const NETWORK_CHECKS: PrivacyChecks = { gateway: runGatewayCheck, routes: lookUpRoutes };

const failed = (check: GatewayCheck) =>
  check.gateway instanceof Error || check.path instanceof Error;

/**
 * Shows, while a TrustedRouter model is selected, what its requests require,
 * which routes can serve them, whether the gateway's attestation verifies,
 * and whether anything between Pi and the gateway can read prompts.
 *
 * Pi awaits event handlers, and setModel awaits model_select, so the checks
 * run detached: switching models must not wait on the network. Only successful
 * results are kept, so a transient failure is retried on the next selection
 * instead of standing for the rest of the session.
 */
export function registerPrivacyDisplay(pi: ExtensionAPI, checks: PrivacyChecks = NETWORK_CHECKS) {
  let selected: string | undefined;
  let gatewayCheck: Promise<GatewayCheck> | undefined;
  const routeLookups = new Map<string, Promise<Routes>>();

  function cachedGatewayCheck() {
    if (!gatewayCheck) {
      const pending = checks.gateway();
      gatewayCheck = pending;
      void pending.then((check) => {
        if (failed(check) && gatewayCheck === pending) {
          gatewayCheck = undefined;
        }
      });
    }
    return gatewayCheck;
  }

  // Pools have no route list of their own; modelLines describes them instead.
  function cachedRoutes(modelId: string): Promise<Routes> {
    if (CONFIDENTIAL_POOLS.includes(modelId)) {
      return Promise.resolve([]);
    }
    let pending = routeLookups.get(modelId);
    if (!pending) {
      const lookup = checks.routes(modelId);
      pending = lookup;
      routeLookups.set(modelId, lookup);
      void lookup.then((routes) => {
        if (routes instanceof Error && routeLookups.get(modelId) === lookup) {
          routeLookups.delete(modelId);
        }
      });
    }
    return pending;
  }

  async function show(model: Model, ctx: UiContext) {
    if (!ctx.hasUI) {
      return;
    }
    if (model?.provider !== "trustedrouter") {
      selected = undefined;
      ctx.ui.setWidget(DISPLAY_KEY, undefined);
      ctx.ui.setStatus(DISPLAY_KEY, undefined);
      return;
    }
    const modelId = model.id;
    selected = modelId;
    const offline = process.env.PI_OFFLINE !== undefined;
    ctx.ui.setWidget(DISPLAY_KEY, [
      ...modelLines(modelId, offline ? new Error("PI_OFFLINE is set") : "pending"),
      ...gatewayLines(offline ? "offline" : "pending"),
    ]);
    if (offline) {
      return;
    }
    const [routes, check] = await Promise.all([cachedRoutes(modelId), cachedGatewayCheck()]);
    // The user may have switched models while the checks ran.
    if (selected === modelId) {
      ctx.ui.setWidget(DISPLAY_KEY, [
        ...modelLines(modelId, routes),
        ...gatewayLines(check as Parameters<typeof gatewayLines>[0]),
      ]);
    }
  }

  // Deliberately not awaited; see above. Failures are reported, not dropped.
  function showDetached(model: Model, ctx: UiContext): void {
    show(model, ctx).catch((err: unknown) => {
      console.error(`warning: TrustedRouter privacy display failed (${(err as Error).message})`);
    });
  }

  pi.on("session_start", (_event, ctx) => showDetached(ctx.model as Model, ctx as UiContext));
  pi.on("model_select", (event, ctx) => showDetached(event.model as Model, ctx as UiContext));
  pi.on("provider_stream_event", (event, ctx) => {
    if (event.provider !== "trustedrouter" || !ctx.hasUI) {
      return;
    }
    const status = servedStatus((event.data as { usage?: unknown } | undefined)?.usage);
    if (status) {
      ctx.ui.setStatus(DISPLAY_KEY, status);
    }
  });
}

// Settles rather than rejects, so one failing half still reports the other.
async function runGatewayCheck(): Promise<GatewayCheck> {
  const signal = AbortSignal.timeout(CHECK_TIMEOUT_MS);
  const [gateway, path] = await Promise.allSettled([checkGateway(signal), inspectPiPath(signal)]);
  const settle = <T>(result: PromiseSettledResult<T>) =>
    result.status === "fulfilled" ? result.value : (result.reason as Error);
  return { gateway: settle(gateway), path: settle(path) };
}

async function lookUpRoutes(modelId: string): Promise<Routes> {
  try {
    const response = await fetch(`${BASE_URL}/models/${modelId}/endpoints`, {
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`TrustedRouter returned HTTP ${response.status} for the route list`);
    }
    return confidentialRoutes(await response.json());
  } catch (err) {
    return err as Error;
  }
}

// Never throws: TrustedRouter being unavailable must not cost a session that
// can still use oMLX.
async function startupRows(): Promise<CatalogRows | undefined> {
  const cached = await readCache();
  if (cached && (isFresh(cached) || process.env.PI_OFFLINE !== undefined)) {
    return cached.rows;
  }
  if (process.env.PI_OFFLINE !== undefined) {
    warnUnavailable(
      "PI_OFFLINE is set and no saved model list exists",
      "start Pi once without PI_OFFLINE to save the list",
    );
    return undefined;
  }
  try {
    return await fetchAndSave(AbortSignal.timeout(FETCH_TIMEOUT_MS));
  } catch (err) {
    if (cached) {
      console.error(
        `warning: could not refresh TrustedRouter models (${(err as Error).message}); ` +
          "using the saved list",
      );
      return cached.rows;
    }
    warnUnavailable(
      (err as Error).message,
      "check that api.trustedrouter.com is reachable, then restart Pi",
    );
    return undefined;
  }
}

// Without a model list every trustedrouter/ model reports "not found",
// including the one pi-start.sh falls back to when oMLX is down, so the warning
// names that consequence rather than leaving Pi's error to stand alone.
function warnUnavailable(reason: string, hint: string): void {
  console.error(
    `warning: TrustedRouter models are unavailable this session (${reason}); ` +
      "trustedrouter/ models, including the fallback when oMLX is down, will report " +
      `"not found"\nhint: ${hint}`,
  );
}

const isFresh = (cache: CatalogCache) => Date.now() - cache.checkedAt < CATALOG_MAX_AGE_MS;

async function fetchAndSave(signal: AbortSignal): Promise<CatalogRows> {
  const rows = await fetchConfidentialModels(signal);
  await writeCache({ checkedAt: Date.now(), rows });
  return rows;
}

async function readCache(): Promise<CatalogCache | undefined> {
  const path = cachePath();
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`warning: cannot read ${path} (${(err as Error).message}); ignoring it`);
    }
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.checkedAt === "number" && Array.isArray(parsed.rows)) {
      return parsed;
    }
  } catch {
    // Reported below with the shape failure, since both mean the same to the caller.
  }
  console.error(`warning: ignoring ${path}; it is not a saved TrustedRouter model list`);
  return undefined;
}

// Written to a temporary name first, so a Pi killed mid-write cannot leave a
// truncated file behind. A failed write only costs the next start a fetch.
async function writeCache(cache: CatalogCache): Promise<void> {
  const path = cachePath();
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temporary, JSON.stringify(cache));
    await rename(temporary, path);
  } catch (err) {
    console.error(`warning: cannot save ${path} (${(err as Error).message})`);
  }
}
