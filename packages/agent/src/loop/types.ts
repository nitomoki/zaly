/**
 * LoopAgent primitives.
 *
 * The loop controller is intentionally separate from `StopPolicy`:
 * `StopPolicy` owns hard caps and duplicate-call detection, while the
 * controller owns the goal, phases, progress, verification, and budgets
 * that turn a normal agent run into a goal-driven loop.
 *
 * Everything in this file is serializable (except `LoopOptions.doneWhen`
 * and the callbacks) so the controller can persist a compact snapshot to
 * the session DAG.
 */

import type { AgentStopKind } from "../events.ts"

export type LoopPhase =
  | "idle"
  | "plan"
  | "act"
  | "verify"
  | "reflect"
  | "done"
  | "blocked"
  | "stopped"

export type LoopProfile = "interactive" | "autonomous" | "ci" | "watch" | "supervisor"

export type LoopNoProgressAction = "reflect" | "ask" | "stop"

export type LoopStopKind =
  | "goal-met"
  | "no-progress"
  | "budget-exhausted"
  | "verification-failed"
  | "blocked"

export type LoopStatus = "idle" | "running" | "done" | "blocked" | "stopped"

export type LoopTodoStatus = "pending" | "in_progress" | "done" | "cancelled"

export interface LoopTodo {
  text: string
  status?: LoopTodoStatus
}

export interface LoopVerifyOptions {
  /** Command + arguments. The first element is the executable. */
  command: string[]
  /** Defaults to the agent's cwd. */
  cwd?: string
  /** Kill deadline. Defaults to two minutes. */
  timeoutMs?: number
}

export interface LoopQuestion {
  question: string
  options?: string[]
  multiple?: boolean
  context?: string
}

export interface LoopProgressSnapshot {
  filesChanged: string[]
  filesRead: string[]
  commands: number
  errors: number
  toolCalls: number
  lastError?: string
  todosTotal?: number
  todosDone?: number
  verification?: { ok: boolean; output?: string; code?: number }
  checkpoint?: { summary?: string; next?: string; at: number }
}

export interface LoopBudgetSnapshot {
  turns: number
  steps: number
  toolCalls: number
  tokens: number
  costUsd: number
  elapsedMs: number
}

export interface LoopLimits {
  turns?: number
  steps?: number
  wallTimeMs?: number
  costUsd?: number
}

export interface LoopSnapshot {
  goal?: string
  phase: LoopPhase
  /** Wall-clock start of the goal, preserved across runs. */
  startedAt: number
  status: LoopStatus
  profile: LoopProfile
  iteration: number
  progress: LoopProgressSnapshot
  budget: LoopBudgetSnapshot
  limits: LoopLimits
  todos?: LoopTodo[]
  blocked?: { reason: string; question?: string }
  completion?: { summary?: string; evidence?: string; at: number }
  reason?: string
}

export interface LoopOptions {
  /** Explicitly opt into looping even without a goal/verifier. */
  enabled?: boolean
  /** Start a run as soon as the agent is ready (CLI --goal / --loop). */
  autoStart?: boolean
  goal?: string
  /** Deterministic completion check. Runs after each natural turn. */
  doneWhen?: (state: LoopSnapshot) => boolean | Promise<boolean>
  /** Command-based verification. A non-zero exit keeps the loop going. */
  verify?: LoopVerifyOptions
  maxTurns?: number
  maxSteps?: number
  maxWallTimeMs?: number
  maxCostUsd?: number
  maxNoProgressTurns?: number
  maxParallel?: number
  onNoProgress?: LoopNoProgressAction
  profile?: LoopProfile
  heartbeatMs?: number
  /** Retries for transient provider errors while the loop is active. */
  maxRetries?: number
  retryBaseMs?: number
  retryMaxMs?: number
  /** Watch profile: wake the loop on this cadence and end the run between ticks. */
  watch?: { everyMs: number; maxAttempts?: number; hint?: string }
}

export interface LoopInjection {
  content: string
  tag: string
  data?: Record<string, unknown>
}

export interface LoopDecision {
  action: "continue" | "stop"
  kind?: AgentStopKind
  reason?: string
  inject?: LoopInjection
}

/** The subset exposed to tools through `ToolContext.loop`. */
export interface LoopToolApi {
  readonly state: LoopSnapshot
  plan: (steps: LoopTodo[]) => void
  checkpoint: (input: { summary?: string; next?: string }) => void
  done: (input: { summary?: string; evidence?: string }) => void
  block: (input: { reason: string; question?: string }) => void
  unblock: () => void
}
