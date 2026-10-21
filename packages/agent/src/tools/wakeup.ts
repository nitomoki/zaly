import type { Agent } from "../agent.ts"

import { defineTool, AiError } from "@zaly/ai"
import { Type } from "typebox"

/**
 * Schedule a future wake-up of the agent loop.
 *
 * Behavior:
 *  - If `delayMs` elapses without anything else waking the loop, the
 *    agent receives a system message containing the wakeup id and the
 *    optional `hint`. The loop ticks; the model decides what to do next.
 *  - If task completion / heartbeat / user message wakes the loop first,
 *    the wakeup is auto-cancelled. Any cancelled wakeups carry their
 *    `hint`s forward as a system message tagged `status="cancelled"` so
 *    the model still sees what it scheduled — the timing context is just
 *    explicit ("I scheduled this; it didn't fire on its own").
 *
 * Use cases:
 *  - Watch an external (non-task) process: "wake me in 60s to re-fetch
 *    the build status URL."
 *  - Poll-style fallback for long-running tasks the model cares about
 *    finishing: "wake me in 30s in case the build hasn't completed yet."
 *  - "Take a moment" patterns: "wake me in 5min to reflect on whether
 *    this approach is right."
 *
 * No companion `wakeup_cancel` tool exists — by the time the model has
 * a turn to call cancel, the wakeup has either fired or been auto-
 * cancelled for it. The only useful state transition is "fire," and that
 * the harness handles automatically.
 */
export interface WakeupContext {
  /** The agent that scheduled the wakeup — provided via ToolContext
   *  augmentation so the tool can call `scheduleWakeup` without a
   *  cross-package dep on `Agent`. */
  agent?: Agent
}

// oxlint-disable-next-line sort-keys -- semantic field order: name, desc, params, call
export const wakeupTool = defineTool({
  name: "wakeup",
  desc:
    "Schedule a wake-up of the agent loop. Use `delayMs` for a one-shot " +
    "reminder, or `everyMs` to watch external state (a build, a deploy, a " +
    "CI run) until `maxAttempts` is reached. One-shot wakeups are cancelled " +
    "when something else wakes the loop first; repeating wakeups keep going. " +
    "Useful for polling external state or scheduling a return to a thought.",
  parallel: true,
  // oxlint-disable-next-line sort-keys -- semantic param order
  params: Type.Object({
    delayMs: Type.Optional(
      Type.Integer({
        description:
          "How long to wait before the first wake-up, in milliseconds. " +
          "Defaults to `everyMs` for repeating wakeups.",
        minimum: 1,
      })
    ),
    everyMs: Type.Optional(
      Type.Integer({
        description:
          "Repeat interval in milliseconds. Use for watch mode. Stops after " +
          "`maxAttempts` if set.",
        minimum: 1,
      })
    ),
    maxAttempts: Type.Optional(
      Type.Integer({
        description: "Maximum number of wake-ups for a repeating wakeup.",
        minimum: 1,
      })
    ),
    hint: Type.Optional(
      Type.String({
        description:
          "Short text the wakeup carries — what you wanted to remember " +
          "to do at this point. Keep it concise; treat it as a TODO line.",
      })
    ),
  }),

  call(args, ctx) {
    if (!ctx.agent) {
      throw new AiError({
        code: "MISSING_TOOL_CONTEXT",
        message: "wakeup requires an Agent reference on the context (set up by the agent harness).",
      })
    }
    if (args.delayMs === undefined && args.everyMs === undefined) {
      throw new AiError({
        code: "INVALID_PARAMS",
        message: "wakeup requires `delayMs` or `everyMs`.",
      })
    }
    const id = ctx.agent.scheduleWakeup({
      delayMs: args.delayMs,
      everyMs: args.everyMs,
      hint: args.hint,
      maxAttempts: args.maxAttempts,
    })
    const when = new Date(Date.now() + (args.delayMs ?? args.everyMs ?? 0)).toISOString()
    const repeat = args.everyMs ? ` every ${args.everyMs}ms` : ""
    return `wakeup ${id} scheduled for ${when}${repeat}`
  },
})
