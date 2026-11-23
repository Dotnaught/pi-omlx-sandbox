// Shared oMLX catalog mapping. Imported by pi-start.sh to seed models.json at
// container start, and by index.ts to refresh the catalog while Pi is running.

const CHAT_MODEL_TYPES = ["llm", "vlm", undefined, null];

// Mirrors Pi's built-in llama.cpp provider, which targets the same class of
// local OpenAI-compatible server. oMLX accepts max_tokens (ChatCompletionRequest
// aliases it with max_completion_tokens) and stream_options.include_usage.
// supportsReasoningEffort is deliberately absent: Pi's detection defaults it to
// true for a generic local server, and setting it false suppresses every branch
// that emits a thinking parameter, so the model never reasons at all.
const LOCAL_SERVER_COMPAT = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsUsageInStreaming: true,
  supportsStrictMode: false,
  maxTokensField: "max_tokens",
};

// oMLX's own server default. Guessing high would let Pi overrun the prompt size
// oMLX accepts; guessing low only makes Pi compact sooner than it needs to.
const DEFAULT_CONTEXT_WINDOW = 32768;
const DEFAULT_MAX_TOKENS = 16384;

export const STATUS_PATH = "/models/status";

const positive = (value) => (typeof value === "number" && value > 0 ? value : undefined);

export function chatModels(payload) {
  const entries = payload?.models;
  if (!Array.isArray(entries)) {
    throw new Error("unexpected /v1/models/status payload; expected a models array");
  }
  // Embedding, reranker and audio models share the listing but cannot back a
  // coding agent. Absent model_type means an older oMLX that only served LLMs.
  const chat = entries.filter((model) => CHAT_MODEL_TYPES.includes(model.model_type));
  if (chat.length === 0) {
    throw new Error(
      "oMLX serves no llm or vlm models\n" +
        "hint: download a chat model in the oMLX admin panel",
    );
  }
  return chat;
}

// Entries are complete rather than minimal because Pi fills defaults only for
// models.json definitions; extension-supplied models are spread verbatim.
export function toProviderModels(chat) {
  return chat.map((model) => {
    const contextWindow = positive(model.max_context_window) ?? DEFAULT_CONTEXT_WINDOW;
    return {
      id: model.id,
      name: model.id,
      // /models/status reports no reasoning capability, and oMLX IDs carry no
      // reliable marker, so every chat model is flagged. The failure modes are
      // asymmetric: a missed flag collapses Pi's thinking levels to ["off"] and
      // hides the control in /settings, whereas a spurious reasoning_effort is
      // ignored — checked against gemma-4-12B-it-qat, which has no thinking
      // mode and answers identically with and without it.
      reasoning: true,
      input: model.model_type === "vlm" ? ["text", "image"] : ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      // An output budget cannot exceed the window it is drawn from, and a small
      // model plus the default would do exactly that.
      maxTokens: Math.min(positive(model.max_tokens) ?? DEFAULT_MAX_TOKENS, contextWindow),
      compat: { ...LOCAL_SERVER_COMPAT },
    };
  });
}

export function selectModel(chat, pin) {
  if (!pin) {
    return (chat.find((model) => model.loaded) ?? chat[0]).id;
  }
  if (!chat.some((model) => model.id === pin)) {
    throw new Error(
      `OMLX_MODEL "${pin}" is not served by oMLX as a chat model\n` +
        `available: ${chat.map((model) => model.id).join(", ")}\n` +
        "hint: recreate the sandbox without --kit-arg model to track whatever oMLX has loaded",
    );
  }
  return pin;
}

export async function fetchChatModels(baseUrl, signal) {
  const response = await fetch(`${baseUrl}${STATUS_PATH}`, { signal });
  if (!response.ok) {
    throw new Error(`oMLX returned HTTP ${response.status} for ${STATUS_PATH}`);
  }
  return chatModels(await response.json());
}
