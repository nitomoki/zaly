import type { CostSchedule } from "../src/types.ts"

import { describe, expect, test } from "vitest"
import { computeCost, costMultiplier } from "../src/pricing.ts"

/** DeepSeek's rule: peak Mon–Fri 01:00–04:00 and 06:00–10:00 UTC. */
const deepseek: CostSchedule = {
  windows: [
    { days: [1, 2, 3, 4, 5], end: "04:00", multiplier: 2, start: "01:00" },
    { days: [1, 2, 3, 4, 5], end: "10:00", multiplier: 2, start: "06:00" },
  ],
}

/** 2026-10-16 is a Friday; 2026-10-17 a Saturday. */
const at = (iso: string) => new Date(iso)

describe("costMultiplier", () => {
  test("no schedule is always the base rate", () => {
    expect(costMultiplier(undefined, at("2026-10-16T02:00:00Z"))).toBe(1)
  })

  test("charges peak inside a weekday window", () => {
    expect(costMultiplier(deepseek, at("2026-10-16T01:00:00Z"))).toBe(2)
    expect(costMultiplier(deepseek, at("2026-10-16T03:59:00Z"))).toBe(2)
    expect(costMultiplier(deepseek, at("2026-10-16T06:00:00Z"))).toBe(2)
    expect(costMultiplier(deepseek, at("2026-10-16T09:59:00Z"))).toBe(2)
  })

  test("treats window start as inclusive and end as exclusive", () => {
    expect(costMultiplier(deepseek, at("2026-10-16T00:59:00Z"))).toBe(1)
    expect(costMultiplier(deepseek, at("2026-10-16T04:00:00Z"))).toBe(1)
    expect(costMultiplier(deepseek, at("2026-10-16T10:00:00Z"))).toBe(1)
  })

  test("weekends are off-peak all day", () => {
    expect(costMultiplier(deepseek, at("2026-10-17T02:00:00Z"))).toBe(1)
    expect(costMultiplier(deepseek, at("2026-10-18T07:00:00Z"))).toBe(1)
  })

  test("holidays are off-peak all day", () => {
    const schedule: CostSchedule = { ...deepseek, holidays: ["2026-10-16"] }
    expect(costMultiplier(schedule, at("2026-10-16T02:00:00Z"))).toBe(1)
    expect(costMultiplier(schedule, at("2026-10-19T02:00:00Z"))).toBe(2)
  })

  test("supports windows that wrap past midnight and all-day windows", () => {
    const wrap: CostSchedule = { windows: [{ end: "02:00", multiplier: 3, start: "23:00" }] }
    expect(costMultiplier(wrap, at("2026-10-16T23:30:00Z"))).toBe(3)
    expect(costMultiplier(wrap, at("2026-10-16T01:30:00Z"))).toBe(3)
    expect(costMultiplier(wrap, at("2026-10-16T12:00:00Z"))).toBe(1)

    const allDay: CostSchedule = { windows: [{ end: "24:00", multiplier: 2, start: "00:00" }] }
    expect(costMultiplier(allDay, at("2026-10-16T00:00:00Z"))).toBe(2)
    expect(costMultiplier(allDay, at("2026-10-16T23:59:00Z"))).toBe(2)
  })
})

describe("computeCost", () => {
  const prices = { cache_read: 0.5, cache_write: 5, input: 1, output: 4, reasoning: 8 }
  const usage = { cacheRead: 200, cacheWrite: 100, input: 1000, output: 50, reasoning: 20 }

  test("applies the flat table when no multiplier is given", () => {
    const cost = computeCost(usage, prices)
    // Uncached input = 1000 - 200 - 100 = 700
    expect(cost.input).toBeCloseTo((700 * 1) / 1_000_000)
    expect(cost.output).toBeCloseTo((50 * 4) / 1_000_000)
    expect(cost.cacheRead).toBeCloseTo((200 * 0.5) / 1_000_000)
    expect(cost.cacheWrite).toBeCloseTo((100 * 5) / 1_000_000)
    expect(cost.reasoning).toBeCloseTo((20 * 8) / 1_000_000)
  })

  test("scales every tier by the multiplier", () => {
    const flat = computeCost(usage, prices)
    const peak = computeCost(usage, prices, 2)
    for (const key of Object.keys(flat) as (keyof typeof flat)[]) {
      expect(peak[key]).toBeCloseTo(flat[key]! * 2)
    }
  })
})
