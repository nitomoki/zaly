/**
 * Build-time overrides applied on top of the models.dev snapshot.
 *
 * Each entry describes how we deviate from what the catalog ships:
 *   - `adapter`      — force a specific adapter family (e.g. route
 *                      google / xai / groq through our openai adapter
 *                      via their openai-compat endpoints)
 *   - `baseUrl`      — override the endpoint URL (pairs with adapter
 *                      reroutes to point at the compat URL)
 *   - `headers`      — request headers sent on every call
 *   - `quirks`       — default `Quirks` for every model on this provider
 *   - `modelQuirks`  — per-model quirks overlay; merged on top of `quirks`
 *   - `transform`    — escape hatch for arbitrary per-model editing;
 *                      return `undefined` to drop the model entirely.
 *
 * Hand-maintained. Adding a new entry is typically the answer when a
 * provider has a quirk models.dev's catalog can't express.
 */

import type { CostSchedule, ModelProvider } from "../types.ts"
import type { ModelCatalog } from "./catalog.ts"

/** DeepSeek bills peak hours at double the off-peak rate, and models.dev
 *  publishes the off-peak numbers — so a flat quote halves the real bill
 *  during peak. Peak is Mon–Fri 01:00–04:00 and 06:00–10:00 UTC; every
 *  other hour, plus weekends and Chinese public holidays in full, is
 *  off-peak.
 *
 *  Holidays are the one part we can't derive: China's State Council
 *  publishes them a year at a time, so list them in `holidays` as
 *  `YYYY-MM-DD` (UTC). Until then a peak weekday that falls on a holiday
 *  is overestimated — the safe direction for a budget. */
const DEEPSEEK_COST: CostSchedule = {
  windows: [
    { days: [1, 2, 3, 4, 5], end: "04:00", multiplier: 2, start: "01:00" },
    { days: [1, 2, 3, 4, 5], end: "10:00", multiplier: 2, start: "06:00" },
  ],
}

// oxlint-disable-next-line sort-keys
export const builtinOverrides: Record<string, Partial<ModelProvider> | undefined> = {
  // ── OpenAI Codex (ChatGPT subscription backend) ─────────────────────
  // Synthetic provider that clones the codex-family models from the
  // openai catalog and routes them at the chatgpt.com backend used by
  // codex CLI. Auth comes from `codexAuth` (PKCE, see `loginCodex`),
  // not env. Clone rules are intentionally pattern-based so newly
  // released codex variants get picked up automatically.
  // oxlint-disable-next-line sort-keys
  "openai-codex": {
    id: "openai-codex",
    api: "openai-responses",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    doc: "https://platform.openai.com/docs/models",
    name: "OpenAI Codex (ChatGPT Plus/Pro)",
    quirks: {
      friendlyErrors: "codex",
      maxTokensField: "none",
      responsesInclude: ["reasoning.encrypted_content"],
      responsesStore: false,
      responsesSystemAs: "instructions",
      sessionHeader: "session-id",
    },
    oauth: async () => import("../auth/openai-codex.ts").then((m) => m.codexOauth),
    // The codex backend serves the codex-family models plus a curated
    // set of mainline gpt-5.x reasoning models. Pattern catches future
    // codex variants automatically; the explicit entries cover the
    // dual-routed mainline models. New mainline GPT-5.x reasoning
    // models would need to be added here as they release.
    models: async (catalog: ModelCatalog) => {
      const openai = catalog.provider("openai")
      if (!openai) return []
      const want = new Set([
        "gpt-6.1-sol",
        "gpt-6-astra",
        "gpt-6-sol",
        "gpt-6-luna",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "gpt-5.5",
      ])
      return (
        (openai.models ?? [])
          .filter((m) => want.has(m.id))
          // oxlint-disable-next-line oxc/no-map-spread
          .map((m) => ({
            ...m,
            contextSize: Math.min(270_000, m.contextSize ?? 270_000), // codex backend has a 270k context limit
          }))
      )
    },
  },
  "opencode-go": {
    quirks: { sessionHeader: "x-opencode-session" },
  },

  // ── Native OpenAI ─────────────────────────────────────────────────
  openai: {
    quirks: {
      maxTokensField: "max_completion_tokens",
      thinkingFormat: "openai",
    },
  },

  // ── OpenRouter ────────────────────────────────────────────────────
  openrouter: {
    headers: {
      "HTTP-Referer": "https://zaly.sh",
      "X-Title": "Zaly",
    },
    quirks: {
      maxTokensField: "max_tokens",
      reasoningField: "reasoning",
      thinkingFormat: "openrouter",
    },
  },

  // ── DeepSeek ──────────────────────────────────────────────────────
  deepseek: {
    // Re-emit the catalog models with the peak/off-peak schedule attached,
    // so `Model.stream` can price by request time. Appending (rather than
    // `replaceModels`) keeps the catalog as the source of the model list
    // and of the price table itself.
    models: (cat) =>
      (cat.provider("deepseek")?.models ?? [])
        // oxlint-disable-next-line oxc/no-map-spread
        .map((m) => ({ ...m, costSchedule: DEEPSEEK_COST })),
    quirks: {
      maxTokensField: "max_tokens",
      // Thinking mode hands reasoning back across turns: a request whose
      // history omits `reasoning_content` is rejected outright.
      reasoningEcho: true,
      reasoningField: "reasoning_content",
      thinkingFormat: "deepseek",
    },
  },

  // ── Z.ai ──────────────────────────────────────────────────────────
  zai: {
    quirks: {
      maxTokensField: "max_tokens",
      thinkingFormat: "zai",
    },
  },

  // ── Moonshot (Kimi) ───────────────────────────────────────────────
  moonshotai: {
    quirks: {
      maxTokensField: "max_tokens",
      thinkingFormat: "openai",
    },
  },

  // ── openai-compat reroutes ────────────────────────────────────────
  // These providers ship native SDKs in the Vercel AI ecosystem but
  // also expose an OpenAI-compatible REST endpoint. We route them
  // through our createOpenAI adapter with the compat URL until we
  // implement their native protocols.
  google: {
    api: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
  },
  xai: {
    api: "openai",
    baseUrl: "https://api.x.ai/v1",
  },
  groq: {
    api: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
  },
  mistral: {
    api: "openai",
    baseUrl: "https://api.mistral.ai/v1",
  },
  cohere: {
    api: "openai",
    baseUrl: "https://api.cohere.com/compatibility/v1",
  },
  togetherai: {
    api: "openai",
    baseUrl: "https://api.together.xyz/v1",
  },
}
