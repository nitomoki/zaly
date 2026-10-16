/**
 * DeepSeek's peak/off-peak pricing, minus the part that changes.
 *
 * DeepSeek bills peak hours at twice its off-peak rate, and charges the
 * off-peak rate for whole days on Chinese public holidays. zaly itself only
 * knows the peak *windows* (`builtinOverrides.deepseek` in `@zaly/ai`); the
 * holidays come from China's State Council once a year, which is exactly the
 * kind of data that should not live in zaly's source tree.
 *
 * So this plugin fetches them, caches them, and merges them into the schedule
 * of every DeepSeek model. Updating the calendar never touches zaly itself.
 *
 * Two assumptions worth knowing:
 *
 * - Peak is weekday 01:00-04:00 and 06:00-10:00 UTC, i.e. 09:00-12:00 and
 *   14:00-18:00 in Beijing. Every peak instant is therefore the same calendar
 *   day in both zones, and matching the holiday list against the request's
 *   UTC date needs no timezone conversion. A window that wrapped past local
 *   midnight would break this.
 * - DeepSeek's docs call weekends off-peak in full, which is how the schema
 *   reads them. So the makeup workdays China schedules on weekends do not
 *   re-enable peak pricing; only weekday holidays matter.
 *
 * Source: https://github.com/NateScarlet/holiday-cn, which republishes the
 * State Council notice (linked back through `papers`) as JSON within hours of
 * its release.
 */

import type { FetchLike, ModelCatalog, ModelInfo } from "@zaly/ai"
import type { PluginApi } from "@zaly/plugin"

import { safeReadJson, writeJson } from "@zaly/shared/json"
import { zalyPaths } from "@zaly/shared/paths"
import { defineAction } from "@zaly/tui"
import { join } from "node:path"

export type HolidayCache = {
  /** `YYYY-MM-DD` days that DeepSeek bills at the off-peak rate all day. */
  holidays: string[]
  /** Where the list came from, for the `/deepseek-holidays` command. */
  source: string
  /** When the list was fetched, ISO-8601. */
  updatedAt: string
}

export type HolidayLoadOpts = {
  /** Fetch implementation. Defaults to the platform `fetch`. */
  fetch?: FetchLike
  /** Re-fetch even when the cache is still fresh. */
  force?: boolean
  /** Clock override, for tests. */
  now?: Date
  /** Called when the source is unreachable and the cache is used instead. */
  onError?: (error: Error) => void
}

const SOURCE = "https://raw.githubusercontent.com/NateScarlet/holiday-cn/master"
const CACHE_FILE = "deepseek-holidays.json"
/** The calendar changes at most once a year; a week keeps it current without
 *  a request on every start. */
const TTL = 7 * 24 * 60 * 60 * 1000
const TIMEOUT = 15_000

function cachePath(): string {
  return join(zalyPaths.env.cache, CACHE_FILE)
}

/** Off-days in one yearly file, sorted and de-duplicated. Workdays are
 *  dropped: they only exist to move a holiday window, and weekends are
 *  off-peak either way. */
export function parseHolidays(data: unknown): string[] {
  if (typeof data !== "object" || data === null) return []
  const days = (data as { days?: unknown }).days
  if (!Array.isArray(days)) return []
  const ret = new Set<string>()
  for (const entry of days as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue
    const day = entry as { date?: unknown; isOffDay?: unknown }
    if (day.isOffDay !== true) continue
    if (typeof day.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day.date)) continue
    ret.add(day.date)
  }
  return [...ret].toSorted()
}

async function fetchYear(year: number, fetchImpl: FetchLike): Promise<string[]> {
  const res = await fetchImpl(`${SOURCE}/${year}.json`, { signal: AbortSignal.timeout(TIMEOUT) })
  // Next year's calendar is only published in November, so a miss there is
  // expected rather than an error.
  if (res.status === 404) return []
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`)
  return parseHolidays(await res.json())
}

/** Fetch the calendar for this year and the next and cache it. Throws when
 *  the source is unreachable; {@link loadHolidays} is the lenient wrapper. */
export async function refreshHolidays(opts: HolidayLoadOpts = {}): Promise<HolidayCache> {
  const now = opts.now ?? new Date()
  const fetchImpl = opts.fetch ?? fetch
  const year = now.getUTCFullYear()
  const years = [year, year + 1]
  const fetched = await Promise.all(years.map((y) => fetchYear(y, fetchImpl)))
  const holidays = [...new Set(fetched.flat())].toSorted()
  // Every year has off-days, so an empty result for the current year means the
  // source changed shape rather than that there are no holidays. Keep the old
  // cache instead of quietly pricing everything as peak.
  if (!holidays.some((day) => day.startsWith(String(year)))) {
    throw new Error(`no ${year} holidays in ${SOURCE}/${year}.json`)
  }
  const cache: HolidayCache = { holidays, source: SOURCE, updatedAt: now.toISOString() }
  await writeJson(cachePath(), cache)
  return cache
}

/** Cached holidays, re-fetched when older than {@link TTL}. Never throws:
 *  a stale cache beats no holidays, and no holidays beat a failed startup. */
export async function loadHolidays(opts: HolidayLoadOpts = {}): Promise<string[]> {
  const now = opts.now ?? new Date()
  const cache = await safeReadJson<HolidayCache>(cachePath())
  const age = cache ? now.getTime() - Date.parse(cache.updatedAt) : Infinity
  if (!opts.force && cache && age < TTL) return cache.holidays
  try {
    const fresh = await refreshHolidays(opts)
    return fresh.holidays
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error))
    if (cache) {
      opts.onError?.(err)
      return cache.holidays
    }
    opts.onError?.(err)
    return []
  }
}

/** Attach `holidays` to every model that has a schedule to attach them to.
 *  Models without one (no catalog pricing, or a provider we don't know the
 *  peak windows for) are left untouched. */
export function withHolidays(
  models: readonly ModelInfo[],
  holidays: readonly string[]
): ModelInfo[] {
  if (holidays.length === 0) return [...models]
  return models.map((model) =>
    model.costSchedule
      ? { ...model, costSchedule: { ...model.costSchedule, holidays: [...holidays] } }
      : model
  )
}

export default async function DeepSeekHolidaysPlugin(api: PluginApi) {
  // One load per process, however many times the catalog is rebuilt.
  let pending: Promise<string[]> | undefined
  const holidays = () =>
    (pending ??= loadHolidays({ onError: (error) => api.log.warn("holiday fetch failed", error) }))

  api.model.register({
    id: "deepseek",
    models: async (catalog: ModelCatalog) =>
      withHolidays(catalog.provider("deepseek")?.models ?? [], await holidays()),
    // Without this the merge would fall back to the provider id and show up
    // as "deepseek" wherever the provider name is rendered.
    name: "DeepSeek",
  })

  api.ui.registerActions(
    defineAction({
      args: {
        refresh: {
          desc: "Re-fetch the calendar before printing it",
          short: "r",
          type: "boolean",
        },
      },
      cmd: "deepseek-holidays",
      desc: "Show the DeepSeek off-peak calendar that cost estimates use",
      fn: async ({ args }) => {
        if (args?.refresh) {
          const cache = await refreshHolidays()
          api.ui.notify(`${cache.holidays.length} off-peak days, updated just now.`)
          return
        }
        const list = await loadHolidays()
        const today = new Date().toISOString().slice(0, 10)
        const upcoming = list.filter((day) => day >= today).slice(0, 5)
        api.ui.notify(
          [
            `**${list.length}** off-peak days cached.`,
            upcoming.length > 0 ? `Next: ${upcoming.join(", ")}` : "None left this year.",
          ].join("\n")
        )
      },
      id: "deepseek-holidays",
    })
  )
}
