import type { ModelInfo } from "@zaly/ai"

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { loadHolidays, parseHolidays, refreshHolidays, withHolidays } from "../deepseek-holidays.ts"

/** 2026-10-16 is a Friday, so the current year is 2026 and the next is 2027. */
const NOW = new Date("2026-10-16T00:00:00Z")

/** Shaped like one `<year>.json` from the source: off-days mixed with the
 *  makeup workdays that shift a holiday window. */
const fixture = (year: number) => ({
  days: [
    { date: `${year}-01-01`, isOffDay: true, name: "元旦" },
    { date: `${year}-01-02`, isOffDay: true, name: "元旦" },
    { date: `${year}-01-04`, isOffDay: false, name: "元旦" },
    { date: `${year}-02-15`, isOffDay: true, name: "春节" },
    { date: "not-a-date", isOffDay: true, name: "broken" },
  ],
  year,
})

const json = (body: unknown) => Response.json(body)

/** Stubs see the same input union `fetch` does. */
const url = (input: string | URL | Request) => {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.href
  return input.url
}

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "zaly-holidays-"))
  // `zalyPaths` reads this on every call, so the cache lands in the temp dir.
  process.env.ZALY_CACHE = dir
})

afterEach(async () => {
  delete process.env.ZALY_CACHE
  await rm(dir, { force: true, recursive: true })
})

describe("parseHolidays", () => {
  test("keeps off-days, sorted and unique", () => {
    expect(parseHolidays(fixture(2026))).toEqual(["2026-01-01", "2026-01-02", "2026-02-15"])
  })

  test("drops makeup workdays and malformed dates", () => {
    const days = parseHolidays(fixture(2026))
    expect(days).not.toContain("2026-01-04")
    expect(days).not.toContain("not-a-date")
  })

  test("tolerates a payload that isn't the expected shape", () => {
    expect(parseHolidays(undefined)).toEqual([])
    expect(parseHolidays({ days: "2026" })).toEqual([])
  })
})

describe("refreshHolidays", () => {
  test("fetches this year and the next", async () => {
    const asked: string[] = []
    const cache = await refreshHolidays({
      fetch: (input) => {
        asked.push(url(input))
        return Promise.resolve(json(fixture(Number(url(input).slice(-9, -5)))))
      },
      now: NOW,
    })
    expect(asked).toHaveLength(2)
    expect(asked[0]).toContain("/2026.json")
    expect(asked[1]).toContain("/2027.json")
    expect(cache.holidays).toContain("2027-02-15")
  })

  test("treats an unpublished year as empty rather than an error", async () => {
    const cache = await refreshHolidays({
      fetch: (input) =>
        Promise.resolve(
          url(input).includes("2027")
            ? new Response("not found", { status: 404 })
            : json(fixture(2026))
        ),
      now: NOW,
    })
    expect(cache.holidays).toEqual(["2026-01-01", "2026-01-02", "2026-02-15"])
  })

  test("refuses an empty current year, so a shape change can't wipe the cache", async () => {
    await expect(
      refreshHolidays({
        fetch: () => Promise.resolve(json({ days: [] })),
        now: NOW,
      })
    ).rejects.toThrow(/no 2026 holidays/)
  })
})

describe("loadHolidays", () => {
  test("uses a fresh cache without touching the network", async () => {
    await refreshHolidays({
      fetch: () => Promise.resolve(json(fixture(2026))),
      now: NOW,
    })
    const holidays = await loadHolidays({
      fetch: () => Promise.reject(new Error("should not fetch")),
      now: NOW,
    })
    expect(holidays).toContain("2026-01-01")
  })

  test("falls back to a stale cache when the source is unreachable", async () => {
    await refreshHolidays({ fetch: () => Promise.resolve(json(fixture(2026))), now: NOW })
    const errors: Error[] = []
    const holidays = await loadHolidays({
      fetch: () => Promise.reject(new Error("offline")),
      now: new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000),
      onError: (error) => errors.push(error),
    })
    expect(holidays).toContain("2026-01-01")
    expect(errors).toHaveLength(1)
  })

  test("returns nothing when there is no cache and no network", async () => {
    const errors: Error[] = []
    const holidays = await loadHolidays({
      fetch: () => Promise.reject(new Error("offline")),
      now: NOW,
      onError: (error) => errors.push(error),
    })
    expect(holidays).toEqual([])
    expect(errors).toHaveLength(1)
  })
})

describe("withHolidays", () => {
  const priced: ModelInfo = {
    cost: { input: 0.15, output: 0.6 },
    costSchedule: { windows: [{ end: "04:00", multiplier: 2, start: "01:00" }] },
    id: "deepseek-flash",
  }
  const unpriced: ModelInfo = { id: "unpriced" }

  test("merges holidays into a model that has a schedule", () => {
    const [model] = withHolidays([priced], ["2026-10-01"])
    expect(model.costSchedule).toEqual({
      holidays: ["2026-10-01"],
      windows: [{ end: "04:00", multiplier: 2, start: "01:00" }],
    })
    expect(model.cost).toEqual({ input: 0.15, output: 0.6 })
  })

  test("leaves models without a schedule untouched", () => {
    const [model] = withHolidays([unpriced], ["2026-10-01"])
    expect(model.costSchedule).toBeUndefined()
  })

  test("is a no-op without holidays", () => {
    expect(withHolidays([priced], [])[0]).toBe(priced)
  })
})
