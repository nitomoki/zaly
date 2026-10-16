import type { Usage, TokenCount } from "./provider.ts"
import type { Cost, CostSchedule, CostWindow } from "./types.ts"

const M = 1_000_000

/** Compute per-field USD cost from token counts + a price table.
 *  Models.dev prices are USD per million tokens. Cache reads/writes
 *  fall back to the input price when the catalog doesn't break them
 *  out (rare — most providers publish all three).
 *
 *  `usage.input` is already the uncached portion (see `TokenCount`
 *  docs), so each tier multiplies by its own price directly — no
 *  subtraction needed.
 *
 *  `multiplier` scales every tier and comes from `costMultiplier` for
 *  providers with time-of-day pricing; 1 (the default) is a flat table. */
export function computeCost(usage: Usage, prices: Cost, multiplier = 1): TokenCount {
  const cacheRead = usage.cacheRead ?? 0
  const cacheWrite = usage.cacheWrite ?? 0
  const cost: TokenCount = {
    input: (usage.input * prices.input * multiplier) / M,
    output: (usage.output * prices.output * multiplier) / M,
  }
  if (cacheRead > 0)
    cost.cacheRead = (cacheRead * (prices.cache_read ?? prices.input) * multiplier) / M
  if (cacheWrite > 0)
    cost.cacheWrite = (cacheWrite * (prices.cache_write ?? prices.input) * multiplier) / M
  if (usage.reasoning !== undefined && prices.reasoning !== undefined) {
    cost.reasoning = (usage.reasoning * prices.reasoning * multiplier) / M
  }
  return cost
}

/** The multiple of the base price that applies at `at`, or 1 when no
 *  window matches (or the model has no schedule).
 *
 *  Providers with peak pricing bill the request when it is sent, so
 *  callers should pass that instant — not the time the usage is read
 *  back, which would reprice history on every replay. */
export function costMultiplier(schedule: CostSchedule | undefined, at: Date): number {
  if (!schedule) return 1
  if (schedule.holidays?.includes(isoDate(at))) return 1
  const day = at.getUTCDay() || 7 // JS Sunday = 0; ours is ISO 7
  const minutes = at.getUTCHours() * 60 + at.getUTCMinutes()
  for (const window of schedule.windows) {
    if (window.days && !window.days.includes(day)) continue
    if (within(minutes, window)) return window.multiplier
  }
  return 1
}

function isoDate(at: Date): string {
  return at.toISOString().slice(0, 10)
}

function within(minutes: number, window: CostWindow): boolean {
  const start = toMinutes(window.start)
  const end = toMinutes(window.end)
  if (start <= end) return minutes >= start && minutes < end
  return minutes >= start || minutes < end // window wraps past midnight
}

/** `HH:MM` → minutes since UTC midnight. Accepts `24:00` so a window
 *  can run to the end of the day. */
function toMinutes(at: string): number {
  const [hours = "0", mins = "0"] = at.split(":")
  return Number(hours) * 60 + Number(mins)
}
