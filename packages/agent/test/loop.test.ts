import type { Message, Model } from "@zaly/ai"

import { Model as ModelClass } from "@zaly/ai"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "pathe"
import { describe, expect, test } from "vitest"
import { Session } from "../src/session/index.ts"
import { loadAgent, mockModel, runAgent } from "./helpers.ts"

const finish = { finishReason: "stop", type: "finish", usage: { input: 10, output: 2 } } as const

describe("LoopAgent", () => {
  test("continues until doneWhen returns true", async () => {
    let checks = 0
    const model = mockModel([
      [{ delta: "not yet", type: "text-delta" }, finish],
      [{ delta: "done", type: "text-delta" }, finish],
    ])
    const result = await runAgent({
      loop: { doneWhen: () => ++checks >= 2, goal: "finish the task" },
      messages: [{ content: "go", role: "user" }],
      model,
    })
    expect(result.steps).toBe(2)
    expect(result.stopReason).toBe("goal-met")
    expect(checks).toBe(2)
  })

  test("accepts a loop done request", async () => {
    const model = mockModel([
      [
        {
          id: "c1",
          name: "loop",
          params: { action: "done", summary: "finished" },
          type: "tool-call",
        },
        { finishReason: "tool-calls", type: "finish", usage: { input: 10, output: 2 } },
      ],
      [{ delta: "Done.", type: "text-delta" }, finish],
    ])
    const result = await runAgent({
      loop: { goal: "finish the task" },
      messages: [{ content: "go", role: "user" }],
      model,
    })
    expect(result.stopReason).toBe("goal-met")
    const loopTool = result.messages.find(
      (m) => m.role === "tool" && m.content.some((p) => p.name === "loop")
    )
    expect(loopTool).toBeDefined()
  })

  test("keeps looping when verification fails, then stops when it passes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zaly-loop-"))
    const counter = join(dir, "counter")
    const script = join(dir, "verify.mjs")
    await writeFile(
      script,
      `import { readFileSync, writeFileSync } from "node:fs"\n` +
        `const p = ${JSON.stringify(counter)}\n` +
        `let n = 0\n` +
        `try { n = Number(readFileSync(p, "utf8")) } catch {}\n` +
        `n++\n` +
        `writeFileSync(p, String(n))\n` +
        `process.exit(n >= 2 ? 0 : 1)\n`
    )
    const model = mockModel([
      [{ delta: "first attempt", type: "text-delta" }, finish],
      [{ delta: "fixed", type: "text-delta" }, finish],
    ])
    const result = await runAgent({
      loop: {
        goal: "fix the tests",
        verify: { command: [process.execPath, script] },
      },
      messages: [{ content: "go", role: "user" }],
      model,
    })
    expect(result.steps).toBe(2)
    expect(result.stopReason).toBe("goal-met")
    expect(await readFile(counter, "utf8")).toBe("2")
  })

  test("stops when the turn budget is exhausted", async () => {
    const model = mockModel([
      [{ delta: "one", type: "text-delta" }, finish],
      [{ delta: "two", type: "text-delta" }, finish],
    ])
    const result = await runAgent({
      loop: {
        doneWhen: () => false,
        goal: "never",
        maxNoProgressTurns: 10,
        maxTurns: 2,
      },
      messages: [{ content: "go", role: "user" }],
      model,
    })
    expect(result.stopReason).toBe("budget-exhausted")
    expect(result.steps).toBe(2)
  })

  test("reflects and stops when there is no measurable progress", async () => {
    const model = mockModel(
      Array.from({ length: 5 }, () => [{ delta: "same", type: "text-delta" }, finish])
    )
    const result = await runAgent({
      loop: {
        doneWhen: () => false,
        goal: "never",
        maxNoProgressTurns: 2,
        maxTurns: 10,
        onNoProgress: "reflect",
      },
      messages: [{ content: "go", role: "user" }],
      model,
    })
    expect(result.stopReason).toBe("no-progress")
    expect(result.steps).toBe(5)
  })

  test("asks the user when the loop is blocked", async () => {
    const questions: string[] = []
    const model = mockModel([
      [
        {
          id: "c1",
          name: "loop",
          params: { action: "blocked", question: "Which approach?", reason: "ambiguous" },
          type: "tool-call",
        },
        { finishReason: "tool-calls", type: "finish", usage: { input: 10, output: 2 } },
      ],
      [{ delta: "using plan B", type: "text-delta" }, finish],
    ])
    const result = await runAgent({
      loop: { doneWhen: () => true, goal: "do it" },
      messages: [{ content: "go", role: "user" }],
      model,
      question: async (req) => {
        questions.push(req.question)
        return "plan B"
      },
    })
    expect(questions).toEqual(["Which approach?"])
    expect(result.stopReason).toBe("goal-met")
  })

  test("persists the loop snapshot to the session", async () => {
    const model = mockModel([[{ delta: "done", type: "text-delta" }, finish]])
    const agent = await loadAgent({
      loop: { doneWhen: () => true, goal: "finish" },
      messages: [{ content: "go", role: "user" }],
      model,
    })
    const stop = await agent.run()
    expect(stop).toBe("goal-met")
    expect(agent.session.loop?.status).toBe("done")
    expect(agent.session.loop?.goal).toBe("finish")
  })

  test("steers an in-flight turn without ending the run", async () => {
    const spec = {
      api: "mock",
      contextSize: 1_000_000,
      id: "mock/x",
      input: ["text"],
      maxTokens: 16_000,
      model: "x",
      name: "mock",
      output: ["text"],
      provider: { api: "mock", id: "mock", models: [], name: "Mock" },
      reasoning: false,
    } as Model["spec"]
    let calls = 0
    const model = new ModelClass({
      id: "mock/x",
      provider: {
        async *stream() {
          calls++
          if (calls === 1) {
            yield { delta: "first", type: "text-delta" }
            await new Promise((resolve) => setTimeout(resolve, 25))
          } else {
            yield { delta: "steered", type: "text-delta" }
          }
          yield finish
        },
      } as unknown as Model["provider"],
      spec,
    })

    const agent = await loadAgent({ model })
    agent.send({ content: "start", role: "user" })
    const run = agent.run()
    await new Promise((resolve) => setTimeout(resolve, 5))
    agent.send({ content: "change direction", role: "user" }, { mode: "steer" })
    const stop = await run

    expect(stop).toBe("natural")
    const users = agent.messages
      .filter((m): m is Message<"user"> => m.role === "user")
      .map((m) => m.content)
    expect(users).toContain("change direction")
  })

  test("supervisor profile exposes swarm tools and caps parallelism", async () => {
    const agent = await loadAgent({
      loop: { enabled: true, profile: "supervisor" },
      model: mockModel([[finish]]),
    })
    const names = agent.tools.map((t) => t.name)
    expect(names).toContain("agent_spawn")
    expect(names).toContain("agent_send")
    expect(agent.tasks.maxParallel).toBe(4)
  })

  test("repairs an interrupted tool call on resume", async () => {
    const session = await Session.load()
    await session.start()
    await session.add({ content: "go", role: "user" })
    await session.add({
      content: [{ id: "c1", name: "read", params: { path: "x" }, type: "tool-call" }],
      role: "assistant",
    })

    const agent = await loadAgent({
      model: mockModel([[finish]]),
      session,
    })
    const last = agent.session.messages.at(-1) as Message<"tool">
    expect(last.role).toBe("tool")
    expect(last.content[0].id).toBe("c1")
    expect(last.content[0].isError).toBe(true)
  })
})
