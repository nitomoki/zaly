import type { LoopVerifyOptions } from "./types.ts"

import { Spawn, TextStream } from "@zaly/shared/process"

const DEFAULT_TIMEOUT_MS = 2 * 60_000
const MAX_OUTPUT = 8000

export interface VerifyResult {
  ok: boolean
  code: number
  output: string
}

/**
 * Run a verification command and capture its combined output.
 *
 * Non-zero exits are normal (a failing test run is a signal, not an
 * exception). Spawn failures are folded into the same result shape so the
 * loop controller has one branch to handle.
 */
export async function runVerify(
  opts: LoopVerifyOptions,
  signal?: AbortSignal
): Promise<VerifyResult> {
  const [cmd, ...args] = opts.command
  if (!cmd) return { code: -1, ok: false, output: "no verification command configured" }

  const stdout = new TextStream()
  const stderr = new TextStream()

  try {
    const proc = new Spawn(cmd, args, {
      cwd: opts.cwd,
      signal,
      stderr,
      stdout,
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    })
    const result = await proc.result
    const output = `${stdout.result}${stderr.result}`.trim()
    return {
      code: result.code,
      ok: result.code === 0 && !result.killed,
      output: truncate(output),
    }
  } catch (error) {
    return {
      code: -1,
      ok: false,
      output: truncate(error instanceof Error ? error.message : String(error)),
    }
  }
}

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT) return text
  return `… (truncated)\n${text.slice(-MAX_OUTPUT)}`
}
