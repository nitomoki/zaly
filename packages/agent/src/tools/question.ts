import { AiError, defineTool } from "@zaly/ai"
import { Type } from "typebox"

/** Ask the user a structured question and return their answer. */
// oxlint-disable-next-line sort-keys -- semantic field order: name, desc, params, call
export const questionTool = defineTool({
  name: "question",
  desc:
    "Ask the user a focused question and wait for the answer. Use when " +
    "you are genuinely blocked on a decision that only the user can make. " +
    "Prefer one question over a list; include options when the choice is finite.",
  // oxlint-disable-next-line sort-keys -- semantic field order
  params: Type.Object({
    question: Type.String({ description: "The question to ask." }),
    options: Type.Optional(
      Type.Array(Type.String(), {
        description: "Suggested answers. The user can still type a free-form answer.",
      })
    ),
    multiple: Type.Optional(
      Type.Boolean({ default: false, description: "Allow selecting more than one option." })
    ),
    context: Type.Optional(
      Type.String({ description: "Short context that helps the user answer." })
    ),
  }),

  async call(args, ctx) {
    if (!ctx.question) {
      throw new AiError({
        code: "NO_USER",
        message: "No interactive user is available to answer questions.",
      })
    }
    const answer = await ctx.question(args)
    if (answer === undefined) {
      throw new AiError({
        code: "NO_ANSWER",
        message: "The user did not answer the question.",
      })
    }
    return answer
  },
})

export type QuestionTool = typeof questionTool
