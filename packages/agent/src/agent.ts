// oxlint-disable no-await-in-loop
import type {
  AssistantMessage,
  Content,
  Context,
  Message,
  MetaOf,
  MetaPart,
  Model,
  ModelStreamOptions,
  ParamsOf,
  TokenCount,
  Tool,
  ToolCallPart,
  ToolContext,
  ToolResult,
} from "@zaly/ai"
import type { CompactionOptions } from "./compaction/compactions.ts"
import type { AgentContext } from "./ctx.ts"
import type { AgentEvents, AgentStatus, AgentStop, AgentStopKind } from "./events.ts"
import type { LoopQuestion } from "./loop/types.ts"
import type { Session } from "./session/session.ts"
import type { AgentOptions, ContextPressure, SendMode, StepResult, TurnResult } from "./types.ts"

import { AiError, isContextOverflow, runTool } from "@zaly/ai"
import { Emitter, toValue, toError } from "@zaly/shared"
import { LoopController } from "./loop/controller.ts"
import { StopPolicy } from "./stop.ts"
import { Tasks, taskCompletionMessage, taskInfoPart } from "./tasks.ts"
import { loopTool } from "./tools/loop.ts"
import { questionTool } from "./tools/question.ts"
import { subagentTool } from "./tools/subagent.ts"
import { agentSendTool, agentSpawnTool } from "./tools/swarm.ts"
import { wakeupTool } from "./tools/wakeup.ts"
import { TokenUsage } from "./utils/usage.ts"
import { uuidv7 } from "./utils/uuid.ts"

const PRESSURE_LEVELS = [0.75, 0.85, 0.95] as const

/**
 * Long-lived agent — drives the multi-turn loop, owns the run-time
 * status / queues, and delegates conversation state to a `Session`.
 *
 * Typical interactive use:
 *
 * ```ts
 * const agent = await Agent.load({ model, tools })
 * agent.session.on("node", (e) => render(e))
 * agent.send({ role: "user", content: "hi" })          // auto-runs
 * // …user types again later…
 * agent.send({ role: "user", content: "follow-up" })   // queues if running
 * ```
 *
 * Headless / one-shot use is just a thin wrapper on top — see
 * `runAgent` in the test helpers.
 */
export class Agent extends Emitter<AgentEvents> {
  readonly #opts: AgentOptions
  readonly #ctx: AgentContext
  readonly #stopPolicy: StopPolicy
  readonly #loopController: LoopController
  readonly #tasks: Tasks
  /** Tools added by the harness itself (loop, question) rather than the
   *  configured tool list. Kept separate so `agent.tools` stays a pure
   *  projection. */
  #extraTools: Tool[] = []
  /** Nesting depth — see `AgentOptions.depth`. Read-only; subagents pass
   *  `parent.depth + 1` when constructing their child. */
  readonly depth: number
  /** Cap on `depth` — see `AgentOptions.maxDepth`. */
  readonly maxDepth: number
  #started = false

  #parent?: Agent

  #injectQueue: Message[] = []
  #appendQueue: Message[][] = []
  #notifyQueue: MetaPart[] = []

  #status: AgentStatus = "idle"
  #abortController?: AbortController
  #pauseRequested?: string
  #steerRequested = false
  #running?: Promise<AgentStopKind>
  #usage: TokenUsage

  /** Pending future-injects scheduled via `scheduleWakeup`. Cleared
   *  whenever the loop becomes active for any reason — the scheduled
   *  inject was a fallback "wake me up at time T if nothing else does,"
   *  and once something else has, the timer is moot. Hints from cancelled
   *  wakeups carry over as a system message so the intent doesn't
   *  evaporate. */
  readonly #wakeups = new Map<
    string,
    {
      timer: ReturnType<typeof setTimeout>
      hint?: string
      everyMs?: number
      maxAttempts?: number
      attempts: number
    }
  >()

  #lastStop?: AgentStop

  /** Synchronous, low-level constructor. Prefer `Agent.load(opts)` —
   *  it runs the same construction *plus* any async setup (resolving
   *  `session: SessionOptions` to a built `Session`, skills discovery,
   *  future warm-ups). The constructor is `protected` so test doubles /
   *  subclasses can still call `super(init)` directly; they're
   *  responsible for providing a pre-built `Session` on `init.session`. */
  public constructor(ctx: AgentContext) {
    super()
    const opts = ctx.opts
    this.#ctx = ctx
    this.#opts = ctx.opts
    this.depth = opts.depth ?? 0
    this.maxDepth = opts.maxDepth ?? 2

    // Note: session.update() + initial messages are committed
    // asynchronously from `Agent.load`, NOT here. Constructors can't
    // be async; deferring those writes until after construction also
    // gives consumers a window to subscribe to session events before
    // the first node fires.

    this.#tasks = new Tasks()
    this.#tasks.$tools = async () => this.tools
    this.#tasks.heartbeatMs = opts.heartbeatMs
    this.#tasks.onEmitError = (error) => opts.logger?.child("tasks").error(error)
    // Post-round task completions inject a system message into the next
    // step, surfacing the result to the model. Round-internal completions
    // are folded into the round's returned parts and don't fire here.
    this.#tasks.on("task-done", ({ task }) => {
      this.send(taskCompletionMessage(task))
    })
    // Heartbeats keep the agent loop alive while long-running tasks are
    // in flight. Each pulse injects a small system note listing what's
    // still going. Tasks with incremental output ready to read get a
    // `*new*` marker so the model knows to call `task_poll` if it cares.
    this.#tasks.on("heartbeat", ({ running }) => {
      this.send({
        content: [{ content: [taskInfoPart(running)], tag: "heartbeat", type: "meta" }],
        role: "system",
      })
    })

    this.#stopPolicy = new StopPolicy(opts.stop)
    this.#stopPolicy.attach(this)
    this.onEmitError = (error) => opts.logger?.child("events").error(error)
    this.#ctx.attach(this)

    this.#loopController = new LoopController(
      this,
      opts.loop === false ? undefined : opts.loop,
      (state) => void this.emit("loop", { state })
    )
    if (this.#tasks.heartbeatMs === undefined && this.#loopController.active) {
      this.#tasks.heartbeatMs = opts.loop === false ? undefined : opts.loop?.heartbeatMs
    }
    this.#syncExtraTools()

    // Seed usage
    this.#usage = new TokenUsage(this.messages)
    this.#ctx.on("session", () => this.reset())
  }

  async reset(): Promise<void> {
    this.stop({ abort: true, reason: "reset" })
    await this.waitIdle()
    await this.#tasks.killAll()
    this.#cancelAllWakeups({ repeats: true })
    this.#usage = new TokenUsage(this.messages)
    this.#stopPolicy.reset({ keepUsage: false })
    this.#loopController.reset()
    this.#injectQueue = []
    this.#appendQueue = []
    this.#notifyQueue = []
    this.#wakeups.clear()
    this.#stop("natural")
  }

  /** Spawn a child agent that inherits this agent's runtime defaults —
   *  cwd, model, permissions, full effective tool list (user tools +
   *  the loaded skill tool), `depth + 1`, and `maxDepth`. Pass
   *  `overrides` to specialize: typical ones are `prompt` (the child
   *  has its own role), `session` (the child writes to its own JSONL),
   *  and `tools` (curated subset).
   *
   *  Used by the `subagent` tool for delegation; equally useful for
   *  ad-hoc parallel-agent patterns (multiple children working on
   *  pieces of a task in parallel).
   *
   *  Depth cap: when the child would be at `maxDepth`, the `subagent`
   *  tool is filtered out of its inherited tool list so recursion
   *  bottoms out cleanly. The model just doesn't see the tool — no
   *  error path. */
  async child(overrides: Partial<AgentOptions> = {}): Promise<Agent> {
    const childDepth = overrides.depth ?? this.depth + 1
    // Inherit the *effective* step tool list (includes the loaded
    // `skill` tool). The child opts out of its own skill scan since
    // the catalog is shared.

    let tools = [...this.tools].filter((t) => t.name !== "skill")
    if (!overrides.loop) tools = tools.filter((t) => t.name !== "loop")
    if (!overrides.question) tools = tools.filter((t) => t.name !== "question")
    if (childDepth >= this.maxDepth)
      tools = tools.filter((t) => t.name !== "subagent" && t.name !== "agent_spawn")
    const { createAgent } = await import("./ctx.ts")

    const ret = await createAgent({
      cwd: this.cwd,
      depth: childDepth,
      mask: this.#opts.mask,
      maxDepth: this.maxDepth,
      model: this.model,
      // Inherit the parent's `notify` setting so test roots that
      // disable the notifier (`notify: false`) propagate that to
      // children — otherwise spawning a child would silently re-enable
      // session-started / time / etc. injections that the harness
      // explicitly opted out of.
      notify: this.#opts.notify,
      permissions: await this.ctx.permissions(),
      skills: this.#ctx.skills, // shared catalog; child doesn't reload
      // Propagate the swarm so the child + every grandchild address
      // each other through the same registry. Override-able via
      // `overrides.swarm` if a caller wants the child outside the
      // tree (rare).
      swarm: await this.#ctx.swarm(),
      tools,
      ...overrides,
    })
    ret.#parent = this
    // Children are spawned ready — subagent dispatch typically calls
    // `.send()` immediately after, and inspecting `child.tools` /
    // `child.prompt` before sending should just work.
    await ret.start()
    return ret
  }

  // ── Read ──────────────────────────────────────────────────────────────

  /** Active conversation — delegates to the underlying `Session`. */
  get messages(): readonly Message[] {
    return this.session.messages
  }

  get status(): AgentStatus {
    return this.#status
  }

  get cwd(): string {
    return this.#ctx.cwd
  }

  get model(): Model | undefined {
    return this.#ctx.model
  }

  get session(): Session {
    return this.#ctx.session
  }

  get signal(): AbortSignal | undefined {
    return this.#abortController?.signal
  }

  /** Token usage from the most recent step's response. Drives
   *  `contextSize` and any "this turn used N tokens" UI. */
  get usage(): TokenUsage {
    return this.#usage
  }

  /** Cumulative token usage across every step in the current run.
   *  Useful for billing-style displays. */
  get totalUsage(): TokenCount {
    return this.#usage.total
  }
  /** Logical size of the current conversation in tokens — what the
   *  next request will send as input. Equals the last step's
   *  `input + output` (since the model's reply becomes part of the
   *  next prompt). Returns 0 before any step has run. */
  get contextSize(): number {
    return this.#usage.contextSize
  }

  get pressure(): ContextPressure {
    const used = this.contextSize
    const limit = this.model?.spec.contextSize ?? 0
    const ratio = limit > 0 ? used / limit : 0
    const level = PRESSURE_LEVELS.findLast((t) => ratio >= t) ?? 0
    return { level, limit, ratio, used }
  }

  get lastStop(): AgentStop | undefined {
    return this.#lastStop
  }

  get steps(): number {
    return this.#stopPolicy.steps
  }

  get parent(): Agent | undefined {
    return this.#parent
  }

  get tools() {
    return [...this.#ctx.tools, ...this.#extraTools]
  }

  /** LoopAgent controller — always present, `active` tells you whether
   *  this agent is running as a loop. */
  get loop(): LoopController {
    return this.#loopController
  }

  /** Start or replace the LoopAgent goal. Passing `undefined` clears it
   *  but keeps the controller available. */
  setGoal(goal: string | undefined): void {
    this.#loopController.setGoal(goal)
    this.#syncExtraTools()
  }

  /** Recompute harness-owned tools after the configured tool list changes. */
  syncTools(): void {
    this.#syncExtraTools()
  }

  #syncExtraTools(): void {
    const loopOpts = this.#opts.loop === false ? undefined : this.#opts.loop
    const parallel =
      this.#opts.maxParallel ??
      (this.#loopController.active ? (loopOpts?.maxParallel ?? 4) : Number.POSITIVE_INFINITY)
    this.#tasks.maxParallel = Number.isFinite(parallel) ? Math.max(1, parallel) : parallel
    const extra: Tool[] = []
    const has = (name: string) => this.#ctx.tools.some((t) => t.name === name)
    if (this.#loopController.active) {
      if (!has("loop")) extra.push(loopTool)
      if (!has("subagent")) extra.push(subagentTool)
      if (!has("wakeup")) extra.push(wakeupTool)
      if (this.#loopController.supervisor) {
        if (!has("agent_spawn")) extra.push(agentSpawnTool)
        if (!has("agent_send")) extra.push(agentSendTool)
      }
    }
    if (this.#opts.question && !has("question")) extra.push(questionTool)
    this.#extraTools = extra
  }

  get prompt() {
    return this.#ctx.prompt
  }

  get ctx(): AgentContext {
    return this.#ctx
  }

  /** Long-running task registry — exposed for the TUI / introspection
   *  tools (`task_list`, etc.). Mutating directly is a foot-gun;
   *  prefer the agent's higher-level surface. */
  get tasks(): Tasks {
    return this.#tasks
  }

  // ── Input ────────────────────────────────────────────────────────────

  #enqueue(message: Message | Message[], opts: { mode?: SendMode } = {}): void {
    const messages = Array.isArray(message) ? message : [message]
    if (!messages.length) return
    for (const m of messages) m.id ??= uuidv7()
    if (opts.mode === "append") this.#appendQueue.push(messages)
    else this.#injectQueue.push(...messages)
    void this.emit("pending", { messages })
  }

  /** Queue messages and start/resume the loop when idle or paused.
   *  `inject` (default) delivers before the next model step without
   *  interrupting an active response or tool batch. `append` waits until
   *  the current turn finishes naturally and no injections remain.
   *  `steer` aborts the in-flight stream but keeps the loop/turn alive:
   *  the new message lands before the next step, so the model can change
   *  direction without losing the conversation or tool results.
   *  Injections batch in queue order; appends run one send() submission
   *  at a time, keeping each submission's messages together.
   *  With `run: false`, only enqueue; omit messages to start/resume
   *  processing already queued work. */
  send(message?: Message | Message[], opts: { mode?: SendMode; run?: boolean } = {}): void {
    if (opts.mode === "steer") {
      this.#steerRequested = true
      this.#abortController?.abort("steer")
      this.#enqueue(message ?? [], { mode: "inject" })
      if (opts.run === false) return
      if (this.#status === "idle" || this.#status === "paused") void this.run()
      return
    }
    this.#enqueue(message ?? [], opts)
    if (opts.run === false) return
    if (this.#status === "idle" || this.#status === "paused") void this.run()
  }

  async useTool<T extends Tool = Tool>(
    name: T["name"],
    params: ParamsOf<T>,
    msg: string,
    opts: { hidden?: boolean } = {}
  ): Promise<{
    call: ToolCallPart<T["name"], ParamsOf<T>>
    result: ToolResult<MetaOf<T>>
    messages: [Message<"system">, Message<"assistant">, Message<"tool">]
  }> {
    const tool = this.tools.find((t) => t.name === name) as T | undefined
    if (!tool) throw new Error(`cannot inject tool use: no tool named "${name}"`)

    const id = uuidv7()
    const call: ToolCallPart = { id, name, params, type: "tool-call" }
    const result = await runTool(tool, params, await this.#toolContext(), { preflight: false })
    const messages: [Message<"system">, Message<"assistant">, Message<"tool">] = [
      {
        content: [
          {
            content: msg,
            data: { tool: name },
            tag: "user-tool-use",
            type: "meta",
          },
        ],
        role: "system",
      },
      {
        content: [call],
        role: "assistant",
      },
      {
        content: [
          {
            content: result.content,
            error: result.error,
            id,
            isError: result.isError,
            meta: result.meta,
            name,
            type: "tool-result",
          },
        ],
        role: "tool",
      },
    ]

    if (opts.hidden) for (const m of messages) m.hidden = true

    return { call, messages, result: result as ToolResult<MetaOf<T>> }
  }

  notify(type: string, data: Content | Record<string, unknown>): void {
    const meta: MetaPart =
      typeof data === "string" || Array.isArray(data)
        ? { content: data, tag: type, type: "meta" }
        : { data, tag: type, type: "meta" }
    this.#notifyQueue.push(meta)
  }

  /** Schedule a wake-up of the agent loop. With `delayMs` it fires once;
   *  with `everyMs` it repeats until `maxAttempts` is reached. One-shot
   *  wakeups are cancelled when something else wakes the loop first;
   *  repeating wakeups (watch mode) survive unrelated activity.
   *
   *  Returns the wakeup id. */
  scheduleWakeup(opts: {
    delayMs?: number
    everyMs?: number
    maxAttempts?: number
    hint?: string
  }): string {
    const id = uuidv7()
    const everyMs = opts.everyMs && opts.everyMs > 0 ? opts.everyMs : undefined
    const delay = opts.delayMs ?? everyMs
    if (delay === undefined || delay < 1) {
      throw new Error("scheduleWakeup requires a positive delayMs or everyMs")
    }

    const entry = {
      attempts: 0,
      everyMs,
      hint: opts.hint,
      maxAttempts: opts.maxAttempts,
      timer: undefined as unknown as ReturnType<typeof setTimeout>,
    }
    const arm = (ms: number) => {
      entry.timer = setTimeout(() => {
        entry.attempts++
        const final =
          entry.everyMs === undefined ||
          (entry.maxAttempts !== undefined && entry.attempts >= entry.maxAttempts)
        if (final) this.#wakeups.delete(id)
        this.send({
          content: [
            {
              content: opts.hint,
              data: {
                attempt: entry.attempts,
                everyMs: entry.everyMs,
                hint: opts.hint,
                id,
                maxAttempts: entry.maxAttempts,
              },
              tag: "wakeup",
              type: "meta",
            },
          ],
          role: "system",
        })
        if (!final && entry.everyMs) arm(entry.everyMs)
      }, ms)
      entry.timer.unref()
    }
    arm(delay)
    this.#wakeups.set(id, entry)
    return id
  }

  /** Cancel pending wakeups, surfacing their hints as a single system
   *  message so the model can see what was queued. One-shot wakeups are
   *  cancelled by `#setStatus` on an external wake; repeating wakeups are
   *  left alone unless `repeats` is set (reset / dispose). */
  #cancelAllWakeups(opts: { repeats?: boolean } = {}): void {
    if (this.#wakeups.size === 0) return
    const carried: { id: string; hint: string }[] = []
    for (const [id, entry] of this.#wakeups) {
      if (entry.everyMs !== undefined && !opts.repeats) continue
      clearTimeout(entry.timer)
      if (entry.hint) carried.push({ hint: entry.hint, id })
      this.#wakeups.delete(id)
    }
    if (carried.length === 0) return
    const parts: MetaPart[] = carried.map((c) => ({
      data: { hint: c.hint, id: c.id, status: "cancelled" as const },
      tag: "wakeup",
      type: "meta",
    }))
    this.#injectQueue.push({ content: parts, role: "system" })
  }

  // ── Loop control ─────────────────────────────────────────────────────

  /** Drive steps until the agent goes idle (no queued messages and
   *  the model stopped naturally) or hits a non-recoverable stop.
   *  Doubles as a resume from `paused` — drains queued messages and
   *  picks the loop back up. If a run is already in flight, returns
   *  the existing promise. */
  run(): Promise<AgentStopKind> {
    if (this.#running) return this.#running
    this.#pauseRequested = undefined
    this.#abortController = undefined
    this.#steerRequested = false
    this.#running = this.#loop()
      .catch(async (error) => {
        this.#opts.logger?.child("run").error(error)
        const ret = this.#stop(
          error instanceof Error && error.name === "AbortError" ? "aborted" : "error",
          error
        )
        await this.#loopController.flush()
        return ret
      })
      .finally(() => {
        this.#abortController = undefined
        this.#running = undefined
      })
    return this.#running
  }

  async #collect() {
    this.#abortController = new AbortController()
    const context = {
      cacheKey: this.ctx.session.id,
      messages: [...this.ctx.messages],
      prompt: this.prompt,
      sessionId: this.ctx.session.id,
      tools: this.tools,
    } satisfies Context
    await this.emitSerial("context", context)
    const model = this.model
    if (!model) throw new Error("model must be loaded to collect")
    return model.stream(context, this.#streamOpts())
  }

  #shouldAutoCompact(): boolean {
    const opts = toValue(this.#opts.compaction)
    const auto = opts?.enabled ?? true
    if (!auto) return false
    const threshold = opts?.threshold ?? 0.95
    return this.pressure.ratio >= threshold
  }

  #streamOpts(): ModelStreamOptions {
    const base = this.#opts.request ?? {}
    return {
      ...base,
      onEvent: (event) => {
        void this.emit("stream-event", { event })
        try {
          void this.#opts.onEvent?.(event)
        } catch (error) {
          this.#opts.logger?.child("stream").error(error)
        }
      },
      onUpdate: this.#opts.onUpdate,
      reasoning: { ...base.reasoning, effort: this.#ctx.reasoning },
      signal: this.#abortController?.signal,
    }
  }

  /** Run exactly one step. Useful for tests and custom drivers
   *  that want to interleave logic between steps. */
  async step(): Promise<StepResult> {
    if (this.#shouldAutoCompact()) await this.compact()
    // Drain the notify queue into the inject queue as a single system message
    if (this.#notifyQueue.length > 0) {
      this.#injectQueue.push({
        content: this.#notifyQueue.splice(0),
        role: "system",
      })
    }

    // Drain injections from send(), notifications, wakeups, and hooks.
    // Sequential await preserves queue order in the session.
    for (const m of this.#injectQueue.splice(0)) await this.session.add(m)

    this.#setStatus("streaming")

    let collected: AssistantMessage

    try {
      collected = await this.#collect()
    } catch (error) {
      const err = toError(error)
      const overflow = isContextOverflow({ message: err.message })
      if (overflow) this.#opts.logger?.warn("Context overflow detected:", err)
      return {
        error: err,
        finishReason: overflow ? "length" : "error",
        kind: overflow ? "context-overflow" : "error",
        usage: { input: 0, output: 0 },
      }
    }

    this.#usage.add(collected.meta.usage)
    this.#loopController.onStep()
    this.#loopController.onStepSuccess()

    const result: Omit<StepResult, "kind"> = {
      finishReason: collected.meta.finishReason,
      message: collected,
      usage: collected.meta.usage,
    }

    // Silent-overflow check BEFORE committing the message — gives the
    // session a chance to drop it and retry on a compacted history.
    if (
      this.#opts.contextLimit !== undefined &&
      isContextOverflow({
        contextLimit: this.#opts.contextLimit,
        // Total prompt size = uncached input + cached reads + cached
        // writes. `usage.input` is uncached-only; the cache fields are
        // separate billing tiers that still occupy the context window.
        usageInput:
          result.usage.input + (result.usage.cacheRead ?? 0) + (result.usage.cacheWrite ?? 0),
      })
    )
      return { kind: "context-overflow", ...result }

    const calls = await this.#parseToolCalls(collected)
    await this.session.add(collected)
    for (const call of calls) this.#loopController.onToolCall(call)

    if (calls.length === 0) return { kind: "natural", ...result }

    return {
      kind: "tool-calls",
      toolMessage: await this.#runTools(calls),
      ...result,
    }
  }

  async #parseToolCalls(message: Message): Promise<ToolCallPart[]> {
    if (typeof message.content === "string") return []
    const calls = message.content.filter((p): p is ToolCallPart => p.type === "tool-call")
    for (const call of calls) {
      const tool = this.tools.find((t) => t.name === call.name)
      if (!tool) continue
      try {
        call.params = (await tool.validator.cleanParams(call.params)) ?? call.params
      } catch {}
    }
    return calls
  }

  async compact(): Promise<void> {
    const prev = this.#status
    const pressure = this.pressure
    this.#setStatus("compacting")
    this.#usage.resetLast()
    try {
      const { Compaction } = await import("./compaction/compactions.ts")
      const opts: Partial<CompactionOptions> = {
        ...toValue(this.#opts.compaction),
        signal: this.#abortController?.signal,
      }
      const compactor = new Compaction(this, opts)
      await compactor.compact(pressure)
    } finally {
      this.#setStatus(prev)
    }
  }

  async #runTools(calls: ToolCallPart[]) {
    this.#setStatus("running-tools")
    void this.emit("tool-calls", { calls })
    for (const call of calls) void this.emit("tool-call", { call })

    const emitted = new Set<string>()
    // The whole batch — including streamable promotion, parallel chains,
    // grace timing, and ownerRound suppression — lives in Tasks.run().
    // What lands back here is a 1:1 array of result parts ready to commit.
    // The skill tool (when active) is passed via `extraTools` so dispatch
    // can resolve `name: "skill"` calls without polluting `tasks.tools`.
    const resultParts = await this.#tasks.run(calls, await this.#toolContext(), {
      onResult: (call, result) => {
        emitted.add(call.id)
        this.#loopController.onToolResult(call, result)
        void this.emit("tool-result", { call, result })
      },
    })

    for (let i = 0; i < calls.length; i++) {
      const call = calls[i]
      const part = resultParts[i]
      if (emitted.has(call.id)) continue
      const result = {
        content: part.content,
        error: part.error,
        isError: part.isError ?? false,
        meta: part.meta,
      }
      this.#loopController.onToolResult(call, result)
      void this.emit("tool-result", {
        call,
        result,
      })
    }
    const message: Message<"tool"> = { content: resultParts, role: "tool" }
    await this.session.add(message)
    return message
  }

  /** Resolve when the agent is in a quiescent state — `idle` or
   *  `paused`. If a run is currently in flight (or was just kicked off
   *  synchronously by `send` / `inject` / a wakeup), waits for it to
   *  settle before returning the final status. If no run is in flight,
   *  resolves immediately with the current status.
   *
   *  Use this in REPL-style drivers to await the loop without racing
   *  with internally-triggered runs (the wakeup timer, heartbeat, or
   *  task-completion injects all spawn `void this.run()` independently
   *  of caller-driven `await agent.run()`). The `#running` promise is
   *  set synchronously inside `run()` before any await point, so this
   *  catches every kicked-off cycle including the one `send` just fired.
   *
   *  Errors from the loop are swallowed — callers read `agent.lastError`
   *  / `agent.lastStopReason` for diagnostics. The point of `waitIdle`
   *  is just to know "the loop is no longer driving." */
  async waitIdle(timeout?: number): Promise<AgentStatus> {
    if (!this.#running) return this.#status
    const wait = [this.#running.catch(() => undefined)]
    if (timeout !== undefined) wait.push(new Promise((resolve) => setTimeout(resolve, timeout)))
    await Promise.race(wait)
    return this.#status
  }

  /** Stop the loop with a custom reason.
   * When `abort: true` (the default), also trigger the abort signal so any
   * in-flight stream or tool calls can react to the stop.
   * When `abort: false`, the agent still stops immediately, but any active
   * stream or tool calls are left to run to completion */
  stop(opts: { abort?: boolean; reason?: string } = {}): void {
    this.#steerRequested = false
    this.#pauseRequested ??= opts.reason ?? "stop"
    if (opts.abort ?? true) this.#abortController?.abort(opts.reason)
  }

  async start() {
    if (this.#started) return
    this.#started = true
    await this.emit("start")
    const saved = this.session.loop
    if (saved?.status === "running") {
      this.notify("loop-interrupted", {
        goal: saved.goal,
        iteration: saved.iteration,
        phase: saved.phase,
      })
    }
  }

  get started() {
    return this.#started
  }

  // ── Internals ────────────────────────────────────────────────────────

  async #turn(): Promise<TurnResult> {
    for (let step = 1; ; step++) {
      if (this.#steerPending()) return { kind: "steered" }
      if (this.#abortController?.signal.aborted)
        return { kind: "aborted", reason: this.#abortController.signal.reason }
      if (this.#pauseRequested !== undefined)
        return { kind: "paused", reason: this.#pauseRequested }

      void this.emit("step-start", { step })
      const outcome = await this.step()
      void this.emit("step-end", { outcome: outcome.kind, step })

      if (this.#steerPending()) return { kind: "steered" }

      if (outcome.kind === "error") {
        if (this.#steerPending()) return { kind: "steered" }
        return {
          kind: outcome.error?.name === "AbortError" ? "aborted" : "error",
          reason: outcome.error,
        }
      }

      if (outcome.kind === "natural") {
        return { kind: "natural" }
      }

      if (outcome.kind === "context-overflow") {
        // Auto-compaction also gates the overflow recovery path. With
        // `auto: false`, overflow stops cleanly instead of attempting
        // a recovery the user explicitly opted out of.
        if (toValue(this.#opts.compaction)?.enabled === false) return { kind: "context-overflow" }
        // Compactor mutates the conversation; the rejected message is
        // not committed — next step retries on the compacted state.
        this.#opts.logger
          ?.child("compaction")
          .warn(
            `context overflow detected (size ${this.contextSize}, limit ${this.pressure.limit}); running compaction`
          )
        await this.compact()
        continue
      }

      // outcome.kind === "tool-calls" — consult the policy.
      const stop = this.#stopPolicy.detect()
      if (stop) return { kind: stop }
    }
  }

  async #loop(): Promise<AgentStopKind> {
    if (!this.#started) await this.start()
    // Reset per-run counters (steps, consecutive errors, call history).
    // Token totals stay sticky across resets — they're billing-style
    // displays, not per-turn caps.
    this.#stopPolicy.reset()
    this.#loopController.reset()
    for (let turn = 1; ; turn++) {
      // Start one append submission only after pending injections have settled.
      if (this.#injectQueue.length === 0)
        for (const m of this.#appendQueue.shift() ?? []) await this.session.add(m)

      this.#loopController.turnStart(turn)
      void this.emit("turn-start", { turn })
      const result = await this.#turn()
      const reason = result.reason ? toError(result.reason).message : undefined
      void this.emit("turn-end", { outcome: result.kind, reason, turn })

      if (result.kind === "steered") {
        this.#steerRequested = false
        this.#abortController = undefined
        continue
      }

      if (result.kind === "error") {
        const retry = this.#loopController.retry(result.reason)
        if (retry) {
          this.notify("loop-retry", {
            attempt: retry.attempt,
            delayMs: retry.delayMs,
            error: reason,
          })
          await sleep(retry.delayMs)
          continue
        }
        return await this.#finishLoop("error", result.reason)
      }

      // If the model stopped naturally but there are still queued messages,
      // keep the loop alive to process them.
      if (
        result.kind === "natural" &&
        (this.#injectQueue.length > 0 || this.#appendQueue.length > 0)
      )
        continue

      if (result.kind === "natural") {
        const decision = await this.#loopController.afterTurn(result, this)
        if (decision.action === "continue") {
          if (decision.inject) {
            this.#injectQueue.push({
              content: [
                {
                  content: decision.inject.content,
                  data: decision.inject.data,
                  tag: decision.inject.tag,
                  type: "meta",
                },
              ],
              role: "system",
            })
          }
          continue
        }
        return await this.#finishLoop(
          (decision.kind ?? "natural") as AgentStopKind,
          decision.reason
        )
      }

      return await this.#finishLoop(result.kind, result.reason)
    }
  }

  async #finishLoop(kind: AgentStopKind, reason?: unknown): Promise<AgentStopKind> {
    const ret = this.#stop(kind, reason)
    await this.#loopController.flush()
    return ret
  }

  #stop(kind: AgentStopKind, reason?: unknown): AgentStopKind {
    this.#lastStop = {
      error: reason instanceof Error ? reason : undefined,
      kind,
      reason: reason === undefined ? undefined : toError(reason).message,
    }
    this.#loopController.stop(kind, this.#lastStop.reason)
    this.#syncExtraTools()
    const done = kind === "natural" || kind === "goal-met"
    this.#setStatus(done ? "idle" : "paused")
    void this.emit("stop", {
      status: this.#status,
      usage: this.usage,
      ...this.#lastStop,
    })
    return kind
  }

  /** Build the per-step `ToolContext` handed to each tool. The session
   *  cwd, an abort signal scoped to the in-flight stream, and the
   *  long-running spawn registry are all surfaced here. */
  async #toolContext(): Promise<ToolContext> {
    const masker = await this.#ctx.masker()
    return {
      agent: this,
      bash: this.#opts.bash,
      cwd: this.cwd,
      isMasked: (msgId: string, partIdx?: number) => masker?.isMasked(msgId, partIdx) ?? false,
      loop: this.#loopController,
      messages: this.session.messages,
      need: (scope, input) => this.#need(scope, input),
      perms: await this.ctx.permissions(),
      question: (req) => this.question(req),
      sessionDir: this.session.dir,
      signal: this.#abortController?.signal,
      swarm: () => this.#ctx.swarm(),
      tasks: this.#tasks,
    }
  }

  /** Ask the user a structured question. The run is reported as
   *  `waiting` for the duration, matching the permission-prompt path. */
  async question(req: LoopQuestion): Promise<string | undefined> {
    if (!this.#opts.question) return undefined
    const prev = this.#status
    this.#setStatus("waiting")
    try {
      return await this.#opts.question(req)
    } finally {
      this.#setStatus(prev)
    }
  }

  /** Implementation of `ctx.need(scope, input)`. Resolves on `allow`,
   *  throws a `PERMISSION_DENIED` `AiError` on `deny`, and escalates
   *  `ask` to `AgentOptions.allow` (treating it as `deny` when no
   *  callback is configured). */
  async #need(scope: string, input: string): Promise<void> {
    const perms = await this.ctx.permissions()
    const r = perms.validate(scope, input)
    if (r.verdict === "allow") return
    if (r.verdict === "ask" && this.#opts.allow) {
      // Reported as its own status: the run is suspended on the user, which is
      // a different thing from the surrounding tool execution and can last
      // indefinitely. UIs use it to surface "needs you" (the tmux pane
      // indicator maps it to `waiting`), so it has to cover the wait itself.
      const prev = this.#status
      this.#setStatus("waiting")
      let ok: boolean
      try {
        ok = await this.#opts.allow({
          ask: r.ask,
          input,
          reason: r.reason,
          scope,
          suggestions: r.suggestions,
        })
      } finally {
        this.#setStatus(prev)
      }
      if (ok) return
    }
    throw new AiError({
      code: "PERMISSION_DENIED",
      data: { input, scope, suggestions: r.suggestions, verdict: r.verdict },
      message: r.reason,
      // `ask` verdicts that the user denied this turn are retryable —
      // they may add a rule later. Hard `deny` is not.
      retryable: r.verdict === "ask",
    })
  }

  /** Tear down session-scoped resources. Called on agent disposal — the
   *  agent doesn't auto-dispose today, so callers (TUI on quit, headless
   *  runner on completion) should invoke this explicitly. */
  async dispose(): Promise<void> {
    this.clearListeners()
    this.#cancelAllWakeups({ repeats: true })
    await this.#tasks.killAll()
  }

  #steerPending(): boolean {
    return this.#steerRequested
  }

  #setStatus(status: AgentStatus): void {
    const prev = this.#status
    if (prev === status) return
    // Cancel wakeups only when an EXTERNAL wake-up brings the loop back
    // to active (idle/paused → streaming). Mid-turn transitions
    // (running-tools → streaming) are the same turn continuing — a
    // wakeup the model just scheduled mid-tool-call would otherwise be
    // killed before it ever fires. The "external wake-up" cases that
    // *should* cancel: a `task-done` inject, a heartbeat, a user
    // message — all route through `inject` → `send` → `run` from the
    // idle/paused state, hitting this branch correctly.
    if (status === "streaming" && (prev === "idle" || prev === "paused")) {
      this.#cancelAllWakeups()
    }
    this.#status = status
    void this.emit("status", { status })
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
