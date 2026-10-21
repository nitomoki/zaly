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

  test("puts the goal in the first request's system prompt", async () => {
    const model = mockModel([[{ delta: "ok", type: "text-delta" }, finish]])
    const prompts: string[][] = []
    const stream = model.provider.stream
    model.provider.stream = (req) => {
      prompts.push(req.ctx.prompt ?? [])
      return stream(req)
    }
    const agent = await loadAgent({
      loop: { goal: "ship the feature" },
      messages: [{ content: "go", role: "user" }],
      model,
    })
    await agent.run()
    expect(prompts[0].some((p) => p.includes("Goal: ship the feature"))).toBe(true)
  })

  test("keeps budgets across runs instead of resetting per message", async () => {
    const model = mockModel([
      [{ delta: "one", type: "text-delta" }, finish],
      [{ delta: "two", type: "text-delta" }, finish],
    ])
    const agent = await loadAgent({
      loop: {
        enabled: true,
        maxNoProgressTurns: 100,
        maxTurns: 2,
        profile: "watch",
        watch: { everyMs: 1e9, maxAttempts: 2 },
      },
      model,
    })
    agent.send({ content: "first", role: "user" })
    expect(await agent.run()).toBe("natural")
    agent.send({ content: "second", role: "user" })
    expect(await agent.run()).toBe("budget-exhausted")
    await agent.dispose()
  })

  test("does not restart a completed goal on the next message", async () => {
    const model = mockModel([
      [{ delta: "done", type: "text-delta" }, finish],
      [{ delta: "hello", type: "text-delta" }, finish],
    ])
    const agent = await loadAgent({
      loop: { doneWhen: () => true, goal: "finish" },
      model,
    })
    agent.send({ content: "go", role: "user" })
    expect(await agent.run()).toBe("goal-met")
    expect(agent.loop.active).toBe(false)
    agent.send({ content: "just a question", role: "user" })
    expect(await agent.run()).toBe("natural")
    expect(agent.loop.active).toBe(false)
  })

  test("does not keep looping after an explicit done in enabled mode", async () => {
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
      [{ delta: "done", type: "text-delta" }, finish],
      [{ delta: "answer", type: "text-delta" }, finish],
    ])
    const agent = await loadAgent({ loop: { enabled: true }, model })
    agent.send({ content: "go", role: "user" })
    expect(await agent.run()).toBe("goal-met")
    expect(agent.loop.active).toBe(false)
    agent.send({ content: "quick question", role: "user" })
    expect(await agent.run()).toBe("natural")
    expect(agent.loop.active).toBe(false)
  })

  test("watch keeps running through idle ticks", async () => {
    const model = mockModel(
      Array.from({ length: 12 }, () => [{ delta: "idle", type: "text-delta" }, finish])
    )
    const agent = await loadAgent({
      loop: {
        enabled: true,
        maxTurns: 100,
        profile: "watch",
        watch: { everyMs: 1e9 },
      },
      model,
    })
    const stops: string[] = []
    for (let tick = 0; tick < 8; tick++) {
      agent.send({ content: `tick ${tick}`, role: "user" })
      stops.push(await agent.run())
    }
    expect(stops.every((s) => s === "natural")).toBe(true)
    expect(agent.loop.active).toBe(true)
    await agent.dispose()
  })

  test("restarts the same goal after budget exhaustion", async () => {
    const agent = await loadAgent({
      loop: { doneWhen: () => false, goal: "g", maxTurns: 1 },
      messages: [{ content: "go", role: "user" }],
      model: mockModel([[{ delta: "x", type: "text-delta" }, finish]]),
    })
    expect(await agent.run()).toBe("budget-exhausted")
    agent.setGoal("g")
    expect(agent.loop.active).toBe(true)
    expect(agent.loop.state.budget.turns).toBe(0)
  })

  test("resumes a finished session with a new goal", async () => {
    const session = await Session.load()
    await session.start()
    await session.add({ content: "go", role: "user" })
    const first = await loadAgent({
      loop: { doneWhen: () => true, goal: "old" },
      model: mockModel([[{ delta: "done", type: "text-delta" }, finish]]),
      session,
    })
    expect(await first.run()).toBe("goal-met")
    const second = await loadAgent({
      loop: { goal: "new goal" },
      model: mockModel([[{ delta: "hi", type: "text-delta" }, finish]]),
      session,
    })
    expect(second.loop.active).toBe(true)
    expect(second.loop.goal).toBe("new goal")
  })

  test("keeps a done session done when switching to it", async () => {
    const session = await Session.load()
    await session.start()
    await session.add({ content: "go", role: "user" })
    const first = await loadAgent({
      loop: { doneWhen: () => true, goal: "old" },
      model: mockModel([[{ delta: "done", type: "text-delta" }, finish]]),
      session,
    })
    expect(await first.run()).toBe("goal-met")
    expect(session.loop?.status).toBe("done")

    const other = await loadAgent({
      loop: { goal: "other" },
      model: mockModel([]),
    })
    await other.ctx.useSession(session)
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(other.loop.goal).toBe("old")
    expect(other.loop.state.status).toBe("done")
    expect(other.loop.active).toBe(false)
    expect(session.loop?.status).toBe("done")
  })

  test("preserves progress when reopening the same non-terminal goal", async () => {
    const session = await Session.load()
    await session.start()
    await session.addLoop({
      budget: { costUsd: 0, elapsedMs: 1000, steps: 4, tokens: 100, toolCalls: 5, turns: 3 },
      goal: "g",
      iteration: 3,
      limits: { turns: 20 },
      phase: "act",
      profile: "interactive",
      progress: { commands: 0, errors: 0, filesChanged: [], filesRead: [], toolCalls: 5 },
      startedAt: Date.now() - 1000,
      status: "running",
      todos: [{ status: "in_progress", text: "keep me" }],
    })

    const agent = await loadAgent({ loop: { goal: "g" }, model: mockModel([]), session })
    expect(agent.loop.state.budget.turns).toBe(3)
    expect(agent.loop.state.todos?.[0]?.text).toBe("keep me")
    expect(agent.loop.active).toBe(true)
  })

  test("tells the model which loop profile is active", async () => {
    const agent = await loadAgent({
      loop: { enabled: true, profile: "watch" },
      model: mockModel([[finish]]),
    })
    expect(agent.loop.prompt().join("\n")).toContain("Profile: watch")
  })

  test("ci profile is non-interactive and caps parallelism lower", async () => {
    const agent = await loadAgent({
      loop: { enabled: true, profile: "ci" },
      model: mockModel([[finish]]),
    })
    expect(agent.loop.allowQuestions).toBe(false)
    expect(agent.tasks.maxParallel).toBe(2)
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
