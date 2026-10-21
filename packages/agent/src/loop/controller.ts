import type { ToolCallPart, ToolResult } from "@zaly/ai"
import type { Agent } from "../agent.ts"
import type { TurnResult } from "../types.ts"
import type {
  LoopBudgetSnapshot,
  LoopDecision,
  LoopNoProgressAction,
  LoopOptions,
  LoopPhase,
  LoopProfile,
  LoopProgressSnapshot,
  LoopSnapshot,
  LoopStopKind,
  LoopTodo,
  LoopToolApi,
} from "./types.ts"

import { safeParseToolParams, stringifyContent } from "@zaly/ai"
import { toError } from "@zaly/shared"
import { runVerify } from "./verify.ts"

const DEFAULTS = {
  maxNoProgressTurns: 3,
  maxRetries: 3,
  maxTurns: 20,
  onNoProgress: "reflect" as const,
  profile: "interactive" as const,
  retryBaseMs: 1000,
  retryMaxMs: 30_000,
}

type ResolvedOptions = LoopOptions & {
  profile: LoopProfile
  maxNoProgressTurns: number
  maxRetries: number
  maxTurns: number
  onNoProgress: LoopNoProgressAction
  retryBaseMs: number
  retryMaxMs: number
}

export class LoopController implements LoopToolApi {
  readonly #agent: Agent
  readonly #opts: ResolvedOptions
  readonly #onChange?: (state: LoopSnapshot) => void

  #goal?: string
  #completedGoal?: string
  #finished = false
  #phase: LoopPhase = "idle"
  #status: LoopSnapshot["status"] = "idle"
  #reason?: string
  #iteration = 0
  #turns = 0
  #steps = 0
  #toolCalls = 0
  #tokens = 0
  #costUsd = 0
  #startedAt = Date.now()
  #progress: LoopProgressSnapshot = emptyProgress()
  #todos?: LoopTodo[]
  #checkpoint?: LoopProgressSnapshot["checkpoint"]
  #blocked?: LoopSnapshot["blocked"]
  #completion?: LoopSnapshot["completion"]
  #noProgressTurns = 0
  #lastFingerprint?: string
  #persistPromise: Promise<void> = Promise.resolve()
  #reflections = 0
  #retries = 0
  #maxTurnsExplicit = false
  #watchId?: string

  constructor(
    agent: Agent,
    opts: LoopOptions | undefined,
    onChange?: (state: LoopSnapshot) => void
  ) {
    this.#agent = agent
    this.#opts = { ...DEFAULTS, ...opts } as ResolvedOptions
    this.#onChange = onChange

    const saved = agent.session.loop
    this.#maxTurnsExplicit = opts?.maxTurns !== undefined
    this.#hydrate(saved)
    const sameGoal = saved !== undefined && opts?.goal === saved.goal
    const terminal = saved !== undefined && (saved.status === "done" || saved.status === "stopped")
    if (opts?.goal !== undefined && (!sameGoal || terminal)) {
      this.#goal = opts.goal
      this.#completedGoal = undefined
      this.#finished = false
      this.#resetGoalState()
    }
  }

  /** True when this agent should behave as a LoopAgent. */
  get active(): boolean {
    if (this.#finished) return false
    if (this.#opts.enabled === true) return true
    if (
      this.#opts.enabled === false &&
      this.#goal === undefined &&
      this.#opts.doneWhen === undefined &&
      this.#opts.verify === undefined
    ) {
      return false
    }
    return (
      this.#goal !== undefined ||
      this.#opts.doneWhen !== undefined ||
      this.#opts.verify !== undefined ||
      this.#opts.profile !== "interactive"
    )
  }

  get goal(): string | undefined {
    return this.#goal
  }

  /** Supervisor profile: expose the swarm tools for delegated work. */
  get supervisor(): boolean {
    return this.#opts.profile === "supervisor"
  }

  get profile(): LoopProfile {
    return this.#opts.profile
  }

  get autoStart(): boolean {
    return this.#opts.autoStart === true
  }

  /** CI runs are non-interactive; blocked questions turn into a stop. */
  get allowQuestions(): boolean {
    return this.#opts.profile !== "ci"
  }

  /** Goal text appended to the system prompt for the first and every
   *  subsequent request while the goal is active. */
  prompt(): string[] {
    if (!this.active) return []
    if (this.#goal === undefined) {
      return [
        `## LoopAgent\nProfile: ${this.#opts.profile}\nLoop mode is active. Inspect the current state and decide the next action. Call \`loop({ action: "done", summary, evidence })\` when the work is complete.`,
      ]
    }
    return [
      [
        "## LoopAgent",
        `Profile: ${this.#opts.profile}`,
        `Goal: ${this.#goal}`,
        "",
        'Work in explicit cycles. Publish a plan with `loop({ action: "plan", steps })`,',
        'checkpoint after milestones, and call `loop({ action: "done", summary, evidence })`',
        "only when the goal is complete. If blocked on a user decision, use",
        '`loop({ action: "blocked", reason, question })`.',
      ].join("\n"),
    ]
  }

  get state(): LoopSnapshot {
    const progress: LoopProgressSnapshot = {
      ...this.#progress,
      checkpoint: this.#checkpoint,
      filesChanged: [...this.#progress.filesChanged],
      filesRead: [...this.#progress.filesRead],
      todosDone: this.#todos?.filter((t) => t.status === "done").length,
      todosTotal: this.#todos?.length,
      verification: this.#progress.verification,
    }
    return {
      blocked: this.#blocked,
      budget: this.#budget(),
      completion: this.#completion,
      goal: this.#goal ?? this.#completedGoal,
      iteration: this.#iteration,
      limits: {
        costUsd: this.#opts.maxCostUsd,
        steps: this.#opts.maxSteps,
        turns: this.#turnLimit(),
        wallTimeMs: this.#opts.maxWallTimeMs,
      },
      phase: this.#phase,
      profile: this.#opts.profile,
      progress,
      reason: this.#reason,
      startedAt: this.#startedAt,
      status: this.#status,
      todos: this.#todos,
    }
  }

  setGoal(goal: string | undefined): void {
    if (goal === this.#goal && !this.#finished) return
    if (goal === undefined) {
      this.#completedGoal ??= this.#goal
      this.#goal = undefined
      this.#finished = true
      this.#status = "stopped"
      this.#phase = "stopped"
      this.#cancelWatch()
      this.#persist()
      this.#emit()
      return
    }
    this.#goal = goal
    this.#completedGoal = undefined
    this.#finished = false
    this.#resetGoalState()
    this.#persist()
    this.#emit()
  }

  reset(): void {
    this.#cancelWatch()
    this.#hydrate(this.#agent.session.loop)
  }

  #hydrate(saved?: LoopSnapshot): void {
    this.#goal = saved?.goal
    this.#completedGoal =
      saved?.status === "done" || saved?.status === "stopped" ? saved.goal : undefined
    this.#finished = saved?.status === "done" || saved?.status === "stopped"
    this.#phase = saved?.phase ?? (this.#goal ? "plan" : "idle")
    this.#status = saved?.status ?? "idle"
    this.#startedAt = saved?.startedAt ?? Date.now()
    this.#turns = saved?.budget.turns ?? 0
    this.#steps = saved?.budget.steps ?? 0
    this.#toolCalls = saved?.budget.toolCalls ?? 0
    this.#tokens = saved?.budget.tokens ?? 0
    this.#costUsd = saved?.budget.costUsd ?? 0
    this.#iteration = saved?.iteration ?? 0
    this.#progress = saved?.progress
      ? {
          ...saved.progress,
          filesChanged: [...saved.progress.filesChanged],
          filesRead: [...saved.progress.filesRead],
        }
      : emptyProgress()
    this.#todos = saved?.todos
    this.#checkpoint = saved?.progress ? saved.progress.checkpoint : undefined
    this.#blocked = saved?.blocked
    this.#completion = saved?.completion
    this.#reason = saved?.reason
    this.#noProgressTurns = 0
    this.#lastFingerprint = undefined
    this.#reflections = 0
    this.#retries = 0
    if (saved?.status === "running") {
      this.#status = "idle"
      this.#reason = "previous loop was interrupted"
    }
  }

  #resetGoalState(): void {
    this.#cancelWatch()
    this.#turns = 0
    this.#steps = 0
    this.#toolCalls = 0
    this.#tokens = 0
    this.#costUsd = 0
    this.#iteration = 0
    this.#startedAt = Date.now()
    this.#progress = emptyProgress()
    this.#todos = undefined
    this.#checkpoint = undefined
    this.#completion = undefined
    this.#blocked = undefined
    this.#noProgressTurns = 0
    this.#lastFingerprint = undefined
    this.#reflections = 0
    this.#retries = 0
    this.#status = "idle"
    this.#phase = "plan"
    this.#reason = undefined
  }

  /** Prepare a new `run()` without resetting goal-level counters. */
  beginRun(): void {
    this.#retries = 0
  }

  turnStart(): void {
    if (!this.active) return
    this.#turns++
    this.#iteration = this.#turns
    this.#status = "running"
    this.#scheduleWatch()
    if (this.#phase === "idle" || this.#phase === "plan" || this.#phase === "done") {
      this.#phase = "act"
    }
    this.#persist()
    this.#emit()
  }

  onStep(): void {
    if (!this.active) return
    this.#steps++
  }

  onStepSuccess(): void {
    this.#retries = 0
  }

  onToolCall(call: ToolCallPart): void {
    if (!this.active) return
    this.#toolCalls++
    this.#progress.toolCalls = this.#toolCalls

    if (call.name !== "loop") return
    const params = safeParseToolParams(call.params) as Record<string, unknown> | undefined
    const action = typeof params?.action === "string" ? params.action : undefined
    if (action === "plan") this.plan(parseTodos(params?.steps))
    else if (action === "checkpoint") {
      this.checkpoint({
        next: typeof params?.next === "string" ? params.next : undefined,
        summary: typeof params?.summary === "string" ? params.summary : undefined,
      })
    } else if (action === "done") {
      this.done({
        evidence: typeof params?.evidence === "string" ? params.evidence : undefined,
        summary: typeof params?.summary === "string" ? params.summary : undefined,
      })
    } else if (action === "blocked") {
      this.block({
        question: typeof params?.question === "string" ? params.question : undefined,
        reason: typeof params?.reason === "string" ? params.reason : "blocked",
      })
    }
  }

  onToolResult(call: ToolCallPart, result: ToolResult): void {
    if (!this.active) return

    const meta = result.meta as { kind?: unknown; path?: unknown } | undefined
    if (typeof meta?.path === "string") {
      if (meta.kind === "write" || meta.kind === "edit")
        addUnique(this.#progress.filesChanged, meta.path)
      else if (meta.kind === "read") addUnique(this.#progress.filesRead, meta.path)
    }
    if (call.name === "bash") this.#progress.commands++

    if (result.isError) {
      this.#progress.errors++
      const text = result.error?.message ?? stringifyContent(result.content)
      this.#progress.lastError = text.slice(0, 500)
    }
  }

  /** Decide whether the loop should continue after a natural turn. */
  async afterTurn(result: TurnResult, agent: Agent): Promise<LoopDecision> {
    this.#updateBudget(agent)
    const reason = result.reason === undefined ? undefined : toError(result.reason).message
    if (!this.active) {
      return {
        action: "stop",
        kind: result.kind === "natural" ? "natural" : result.kind,
        reason,
      }
    }
    if (result.kind !== "natural") {
      return {
        action: "stop",
        kind: result.kind,
        reason,
      }
    }

    this.#phase = "verify"
    if (this.#blocked) {
      return this.#finish("blocked", this.#blocked.reason)
    }

    const budget = this.#budgetDecision()
    if (budget) return budget

    if (this.#opts.doneWhen) {
      const done = await this.#evaluateDone()
      if (done) return this.#finish("goal-met", this.#goal ?? "doneWhen returned true")
      if (!this.#opts.verify) {
        const noProgress = await this.#checkNoProgress(agent)
        if (noProgress) return noProgress
        return {
          action: "continue",
          inject: {
            content: `doneWhen is not satisfied yet. Keep working toward the goal.\n\n${this.#summary()}`,
            tag: "loop",
          },
        }
      }
    }

    if (this.#opts.verify) {
      const verify = await runVerify(
        { ...this.#opts.verify, cwd: this.#opts.verify.cwd ?? agent.cwd },
        agent.signal
      )
      this.#progress.verification = { code: verify.code, ok: verify.ok, output: verify.output }
      if (!verify.ok) {
        this.#phase = "act"
        this.#progress.errors++
        this.#progress.lastError = `verification failed (${verify.code})`
        this.#persist()
        this.#emit()
        return {
          action: "continue",
          inject: {
            content:
              `Verification failed with exit code ${verify.code}. Fix the failures and continue. ` +
              `Do not declare completion until verification passes.\n\n` +
              `\`\`\`\n${verify.output}\n\`\`\``,
            data: { code: verify.code, ok: false },
            tag: "loop-verification",
          },
        }
      }
      if (this.#opts.doneWhen) {
        const done = await this.#evaluateDone()
        if (!done) {
          return {
            action: "continue",
            inject: {
              content:
                "Verification passed, but doneWhen is still false. " +
                "Review the remaining work and continue.",
              data: { ok: true },
              tag: "loop-verification",
            },
          }
        }
      }
      return this.#finish("goal-met", "verification passed")
    }

    if (this.#completion) {
      return this.#finish("goal-met", this.#completion.summary ?? "completion requested")
    }

    const noProgress = await this.#checkNoProgress(agent)
    if (noProgress) return noProgress

    if (this.#opts.profile === "watch") {
      this.#phase = "act"
      this.#persist()
      this.#emit()
      return { action: "stop", kind: "natural", reason: "watch: waiting for next interval" }
    }

    if (this.#goal || this.#opts.enabled === true || this.#opts.profile !== "interactive") {
      this.#phase = "act"
      this.#persist()
      this.#emit()
      return {
        action: "continue",
        inject: {
          content:
            `Continue working toward the goal${this.#goal ? `: ${this.#goal}` : ""}. ` +
            `When finished, call \`loop({ action: "done", summary, evidence })\` ` +
            `so the harness can verify completion.\n\n${this.#summary()}`,
          tag: "loop",
        },
      }
    }

    return { action: "stop", kind: "natural" }
  }

  /** Record a final stop and persist the snapshot. */
  stop(kind: string, reason?: string): void {
    // A terminal loop is already persisted. In particular, reset() hydrates
    // the target session and then calls stop("natural"); allowing that through
    // would rewrite a done snapshot as idle and revive the goal on next start.
    if (this.#finished) return
    if (!this.active && this.#status !== "done" && this.#status !== "blocked") return
    // reset() calls stop("natural") after hydrating the target session.
    // Only watch needs that transition (idle between ticks); for other
    // profiles it would overwrite a resumed blocked/running snapshot.
    if (kind === "natural" && (this.#opts.profile !== "watch" || this.#status === "blocked")) {
      return
    }
    this.#reason = reason
    if (
      kind === "goal-met" ||
      kind === "no-progress" ||
      kind === "budget-exhausted" ||
      kind === "verification-failed"
    ) {
      this.#finished = true
      this.#cancelWatch()
    }
    if (kind === "goal-met") {
      this.#completedGoal ??= this.#goal
      this.#goal = undefined
      this.#status = "done"
      this.#phase = "done"
    } else if (kind === "blocked") {
      this.#status = "blocked"
      this.#phase = "blocked"
    } else if (kind === "natural" || kind === "paused" || kind === "aborted" || kind === "error") {
      this.#status = "idle"
      this.#phase = "act"
    } else {
      this.#status = "stopped"
      this.#phase = "stopped"
    }
    this.#persist()
    this.#emit()
  }

  /** Transient-error retry decision. Returns undefined when no retry. */
  retry(error: unknown): { attempt: number; delayMs: number } | undefined {
    if (!this.active) return undefined
    const err = toError(error)
    if (!isTransient(err)) return undefined
    const max = this.#opts.maxRetries
    if (this.#retries >= max) return undefined
    const attempt = ++this.#retries
    const base = this.#opts.retryBaseMs
    const maxDelay = this.#opts.retryMaxMs
    const delayMs = Math.min(maxDelay, base * 2 ** (attempt - 1)) * (0.5 + Math.random())
    return { attempt, delayMs }
  }

  // ── LoopToolApi ──────────────────────────────────────────────────────

  plan(steps: LoopTodo[]): void {
    this.#todos = steps
    this.#phase = "plan"
    this.#persist()
    this.#emit()
  }

  checkpoint(input: { summary?: string; next?: string }): void {
    this.#checkpoint = { ...input, at: Date.now() }
    this.#phase = "act"
    this.#persist()
    this.#emit()
  }

  done(input: { summary?: string; evidence?: string }): void {
    this.#completion = { ...input, at: Date.now() }
    this.#phase = "verify"
    this.#persist()
    this.#emit()
  }

  block(input: { reason: string; question?: string }): void {
    this.#blocked = input
    this.#phase = "blocked"
    this.#persist()
    this.#emit()
  }

  unblock(): void {
    if (this.#blocked === undefined) return
    this.#blocked = undefined
    this.#phase = "act"
    this.#persist()
    this.#emit()
  }

  // ── Internals ────────────────────────────────────────────────────────

  async #evaluateDone(): Promise<boolean> {
    if (!this.#opts.doneWhen) return false
    try {
      return await this.#opts.doneWhen(this.state)
    } catch (error) {
      this.#progress.lastError = `doneWhen: ${toError(error).message}`
      return false
    }
  }

  async #checkNoProgress(agent: Agent): Promise<LoopDecision | undefined> {
    if (this.#opts.profile === "watch") return undefined
    const fingerprint = this.#fingerprint()
    if (fingerprint === this.#lastFingerprint) this.#noProgressTurns++
    else {
      this.#noProgressTurns = 0
      this.#lastFingerprint = fingerprint
    }
    if (this.#noProgressTurns < this.#opts.maxNoProgressTurns) return undefined

    if (this.#reflections === 0) {
      this.#reflections++
      this.#noProgressTurns = 0
      this.#phase = "reflect"
      this.#persist()
      this.#emit()
      return {
        action: "continue",
        inject: {
          content: `No measurable progress for ${this.#opts.maxNoProgressTurns} turns. Stop repeating the same approach. Summarize what you tried, why it failed, and choose a materially different next step.\n\n${this.#summary()}`,
          tag: "loop-reflection",
        },
      }
    }

    const action = this.#opts.profile === "ci" ? "stop" : this.#opts.onNoProgress
    if (action === "ask") {
      const answer = await agent.question({
        context: this.#summary(),
        question:
          `I have made no measurable progress for ${this.#opts.maxNoProgressTurns} turns. ` +
          `What should I change or do next?`,
      })
      if (answer === undefined) return this.#finish("blocked", "no progress and no user response")
      this.#noProgressTurns = 0
      this.#phase = "act"
      this.#persist()
      this.#emit()
      return {
        action: "continue",
        inject: { content: `User guidance: ${answer}`, tag: "loop-guidance" },
      }
    }

    if (action === "reflect") {
      return this.#finish("no-progress", "no measurable progress after reflection")
    }
    return this.#finish("no-progress", "no measurable progress")
  }

  #budgetDecision(): LoopDecision | undefined {
    const budget = this.#budget()
    const limits = this.#opts
    if (budget.turns >= this.#turnLimit()) {
      return this.#finish("budget-exhausted", `maxTurns (${this.#turnLimit()}) reached`)
    }
    if (limits.maxSteps !== undefined && budget.steps >= limits.maxSteps) {
      return this.#finish("budget-exhausted", `maxSteps (${limits.maxSteps}) reached`)
    }
    if (limits.maxWallTimeMs !== undefined && budget.elapsedMs >= limits.maxWallTimeMs) {
      return this.#finish("budget-exhausted", `maxWallTime (${limits.maxWallTimeMs}ms) reached`)
    }
    if (limits.maxCostUsd !== undefined && budget.costUsd >= limits.maxCostUsd) {
      return this.#finish("budget-exhausted", `maxCost ($${limits.maxCostUsd.toFixed(2)}) reached`)
    }
    return undefined
  }

  #finish(kind: LoopStopKind, reason: string): LoopDecision {
    if (kind !== "blocked") {
      this.#finished = true
      this.#cancelWatch()
    }
    if (kind === "goal-met") {
      this.#completedGoal = this.#goal
      this.#goal = undefined
      this.#status = "done"
      this.#phase = "done"
    } else if (kind === "blocked") {
      this.#status = "blocked"
      this.#phase = "blocked"
    } else {
      this.#status = "stopped"
      this.#phase = "stopped"
    }
    this.#reason = reason
    this.#persist()
    this.#emit()
    return { action: "stop", kind, reason }
  }

  #turnLimit(): number {
    if (this.#opts.profile !== "watch") return this.#opts.maxTurns
    const attempts = Math.max(1, this.#opts.watch?.maxAttempts ?? 60)
    return this.#maxTurnsExplicit ? Math.min(this.#opts.maxTurns, attempts) : attempts
  }

  #budget(): LoopBudgetSnapshot {
    return {
      costUsd: this.#costUsd,
      elapsedMs: Math.max(0, Date.now() - this.#startedAt),
      steps: this.#steps,
      tokens: this.#tokens,
      toolCalls: this.#toolCalls,
      turns: this.#turns,
    }
  }

  #updateBudget(agent: Agent): void {
    this.#tokens = agent.totalUsage.input + agent.totalUsage.output
    const cost = agent.usage.cost
    this.#costUsd =
      cost.input +
      cost.output +
      (cost.cacheRead ?? 0) +
      (cost.cacheWrite ?? 0) +
      (cost.reasoning ?? 0)
  }

  #fingerprint(): string {
    const p = this.#progress
    return JSON.stringify({
      filesChanged: [...p.filesChanged].toSorted(),
      filesRead: p.filesRead.length,
      lastError: p.lastError,
      todosDone: this.#todos?.filter((t) => t.status === "done").length,
      verification: p.verification?.ok,
    })
  }

  #summary(): string {
    const p = this.#progress
    const parts = [
      `turns=${this.#turns}`,
      `steps=${this.#steps}`,
      `files changed=${p.filesChanged.length}`,
      `commands=${p.commands}`,
      `errors=${p.errors}`,
    ]
    if (this.#todos?.length) {
      parts.push(
        `todos=${this.#todos.filter((t) => t.status === "done").length}/${this.#todos.length}`
      )
    }
    if (p.verification) parts.push(`verification=${p.verification.ok ? "passed" : "failed"}`)
    if (this.#checkpoint?.summary) parts.push(`checkpoint=${this.#checkpoint.summary}`)
    return parts.join(", ")
  }

  async flush(): Promise<void> {
    await this.#persistPromise
  }

  #scheduleWatch(): void {
    if (this.#opts.profile !== "watch" || this.#watchId !== undefined) return
    const watch = this.#opts.watch ?? { everyMs: 60_000, maxAttempts: 60 }
    this.#watchId = this.#agent.scheduleWakeup({
      everyMs: Math.max(1, watch.everyMs),
      hint: watch.hint ?? "watch: check state and continue",
      maxAttempts: watch.maxAttempts,
    })
  }

  #cancelWatch(): void {
    if (this.#watchId === undefined) return
    this.#agent.cancelWakeup(this.#watchId)
    this.#watchId = undefined
  }

  #persist(): void {
    this.#persistPromise = this.#persistPromise
      .then(() => this.#agent.session.addLoop(this.state))
      .then(() => undefined)
      .catch(() => undefined)
  }

  #emit(): void {
    this.#onChange?.(this.state)
  }
}

export function isTransient(error: Error): boolean {
  if (error.name === "AbortError") return false
  const text = `${error.name} ${error.message}`.toLowerCase()
  return /(rate.?limit|too many requests|429|5\d\d|overloaded|timeout|timed out|econnreset|etimedout|eai_again|network|fetch failed|service unavailable|temporar)/.test(
    text
  )
}

function emptyProgress(): LoopProgressSnapshot {
  return {
    commands: 0,
    errors: 0,
    filesChanged: [],
    filesRead: [],
    toolCalls: 0,
  }
}

function addUnique(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value)
}

function parseTodos(value: unknown): LoopTodo[] {
  if (!Array.isArray(value)) return []
  const ret: LoopTodo[] = []
  for (const item of value) {
    if (typeof item === "string") ret.push({ text: item })
    else if (
      item &&
      typeof item === "object" &&
      typeof (item as { text?: unknown }).text === "string"
    ) {
      const status = (item as { status?: unknown }).status
      ret.push({
        status:
          status === "pending" ||
          status === "in_progress" ||
          status === "done" ||
          status === "cancelled"
            ? status
            : undefined,
        text: (item as { text: string }).text,
      })
    }
  }
  return ret
}
