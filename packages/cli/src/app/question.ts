import type { LoopQuestion } from "@zaly/agent"
import type { App } from "./app.ts"

/**
 * Interactive resolver for `AgentOptions.question`.
 *
 * Uses the picker when the model supplied finite options, and falls back
 * to the free-form prompt. `multiple` is currently represented in the
 * prompt title rather than a multi-select overlay — the model can still
 * accept a comma-separated answer.
 */
export async function askQuestion(req: LoopQuestion, app: App): Promise<string | undefined> {
  const title = req.multiple
    ? `${req.question}\n\n_(select one or more, comma-separated)_`
    : req.question

  if (req.options?.length) {
    const items = [...req.options.map((text) => ({ text })), { text: "Other…" }]
    const picked = await app.pick({ details: req.context, items, title })
    if (picked && picked.text !== "Other…") return picked.text
  }

  return await app.prompt.open({ details: req.context, title })
}
