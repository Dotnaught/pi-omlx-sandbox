import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { fetchChatModels, toProviderModels } from "./catalog.mjs";

const BASE_URL =
  process.env.OMLX_BASE_URL ??
  `http://host.docker.internal:${process.env.OMLX_PORT ?? "8010"}/v1`;

// Pi treats whatever refreshModels returns as the replacement catalog, so there
// is no typed way to say "leave it alone" — undefined is the signal, and the
// declared array return has to be cast away to express it.
const KEEP_EXISTING_CATALOG = undefined as unknown as ReturnType<typeof toProviderModels>;

/**
 * Keeps Pi's oMLX catalog in step with the server.
 *
 * pi-start.sh seeds models.json at container start; this replaces that snapshot
 * whenever Pi refreshes catalogs (session start, and each time the model picker
 * opens), so context windows edited in the oMLX admin panel are picked up
 * without a restart.
 */
export default function (pi: ExtensionAPI) {
  pi.registerProvider("omlx", {
    name: "oMLX",
    baseUrl: BASE_URL,
    apiKey: "local",
    api: "openai-completions",
    async refreshModels(context) {
      // Pi calls this on every refresh, including offline ones.
      if (!context.allowNetwork || context.signal.aborted) {
        return KEEP_EXISTING_CATALOG;
      }
      // Errors propagate on purpose: Pi records them per provider, warns
      // "Could not refresh omlx; searching cached models", and keeps the
      // previous catalog because it never reaches its publish step.
      return toProviderModels(await fetchChatModels(BASE_URL, context.signal));
    },
  });
}
