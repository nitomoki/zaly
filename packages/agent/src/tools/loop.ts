import type { LoopTodo } from "../loop/types.ts"

import { AiError, defineTool } from "@zaly/ai"
import { Type } from "typebox"

/**
 * LoopAgent control tool.
 *
 * The model uses this to externalize its plan, checkpoint progress, ask
 * to finish, or declare itself blocked. `done` is a *request*, not a
 * unilateral stop: the loop controller runs `doneWhen` / `verify` before
 * accepting it.
 */
// oxlint-disable-next-line sort-keys -- semantic field order: name, desc, params, call
export const loopTool = defineTool({
  name: "loop",
  desc:
    "Control the current LoopAgent. Use `plan` to publish or update the " +
    "task list, `checkpoint` to save a short progress note, `done` when " +
    "you believe the goal is complete (the harness verifies before " +
    "stopping), and `blocked` when you need user input or cannot proceed.",
  // oxlint-disable-next-line sort-keys -- semantic field order
  params: Type.Object({
    action: Type.Union([
      Type.Literal("plan"),
      Type.Literal("checkpoint"),
      Type.Literal("done"),
      Type.Literal("blocked"),
    ]),
    steps: Type.Optional(
      Type.Array(
        Type.Object({
          status: Type.Optional(
            Type.Union([
              Type.Literal("pending"),
              Type.Literal("in_progress"),
              Type.Literal("done"),
              Type.Literal("cancelled"),
            ])
          ),
          text: Type.String(),
        })
      )
    ),
    summary: Type.Optional(Type.String()),
    next: Type.Optional(Type.String()),
    evidence: Type.Optional(Type.String()),
    reason: Type.Optional(Type.String()),
    question: Type.Optional(Type.String()),
  }),

  async call(args, ctx) {
    const loop = ctx.loop
    if (!loop) {
      throw new AiError({
        code: "LOOP_DISABLED",
        message: "LoopAgent is not enabled for this agent. Start it with a goal or --loop.",
      })
    }

    switch (args.action) {
      case "plan": {
        const steps: LoopTodo[] = (args.steps ?? []).map((s) => ({
          status: s.status,
          text: s.text,
        }))
        loop.plan(steps)
        return `Planned ${steps.length} step${steps.length === 1 ? "" : "s"}.`
      }
      case "checkpoint": {
        loop.checkpoint({ next: args.next, summary: args.summary })
        return "Checkpoint saved."
      }
      case "done": {
        loop.done({ evidence: args.evidence, summary: args.summary })
        return (
          "Completion requested. The harness will run the configured " +
          "verification before stopping."
        )
      }
      case "blocked": {
        const reason = args.reason ?? "blocked"
        loop.block({ question: args.question, reason })
        if (!args.question) return `Blocked: ${reason}`
        if (!ctx.question) {
          return `Blocked: ${reason}. No interactive user is available to answer the question.`
        }
        const answer = await ctx.question({
          context: reason,
          question: args.question,
        })
        if (answer === undefined) {
          return `Blocked: ${reason}. The user did not answer.`
        }
        loop.unblock()
        return `User answered: ${answer}`
      }
    }
  },
})

export type LoopTool = typeof loopTool
