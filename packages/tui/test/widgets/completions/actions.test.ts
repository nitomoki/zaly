import type { Match, SearchItem } from "../../../src/search/index.ts"
import type { CompletionSource } from "../../../src/widgets/autocomplete.ts"
import type { Option } from "../../../src/widgets/select.ts"

import { describe, expect, test, vi } from "vitest"
import { createCtx } from "../../../src/core/ctx.ts"
import { unwrap } from "../../../src/index.ts"
import { Actions } from "../../../src/input/actions.ts"
import { Matcher } from "../../../src/search/index.ts"
import { autocomplete } from "../../../src/widgets/autocomplete.ts"
import { actionsSource } from "../../../src/widgets/completions/actions.ts"
import { input } from "../../../src/widgets/input.ts"

const match = <T extends SearchItem = SearchItem>(q: string): Match<T> => {
  const matcher = new Matcher<T>()
  matcher.init(q)
  const fn = (s: string | T) => matcher.match(s)
  return Object.assign(fn, {
    matcher: (pattern: string) => {
      const m = new Matcher<T>()
      m.init(pattern)
      return (s: string | T) => m.match(s)
    },
  })
}

const complete = async <T extends Option>(src: CompletionSource<T>, query: string) => {
  const items = unwrap(src.complete)
  return typeof items === "function" ? await items(query, match(query)) : items
}

describe("actionsSource", () => {
  test("emits raw ActionInfo + id items from the registry", async () => {
    const actions = new Actions()
    actions.register({
      "app.commit": { desc: "commit changes", cmd: "commit" },
      "app.quit": { desc: "quit the app", cmd: "quit" },
    })
    const src = actionsSource({ actions })
    const items = await complete(src, "")
    expect(items.map((i) => i.id)).toContain("app.commit")
    const commit = items.find((i) => i.id === "app.commit")!
    expect(commit.cmd).toBe("commit")
    expect(commit.desc).toBe("commit changes")
    expect(commit.text).toBe("commit")
  })

  test("fuzzy-matches the displayed name", async () => {
    const actions = new Actions()
    actions.register({
      "app.commit": { cmd: "commit" },
      "app.quit": { cmd: "quit" },
      "app.restart": { cmd: "restart" },
    })
    const src = actionsSource({ actions })
    const items = await complete(src, "qt")
    expect(items.map((i) => i.cmd)).toEqual(["quit"])
  })

  test("filter excludes entries (default skips hidden)", async () => {
    const actions = new Actions()
    actions.register({
      "app.quit": { hidden: true, cmd: "quit" },
      "app.visible": { cmd: "visible" },
    })
    const src = actionsSource({ actions })
    const items = await complete(src, "")
    expect(items.map((i) => i.cmd)).toEqual(["visible"])
  })

  test("accept dispatches the action via the registry and returns undefined", async () => {
    const actions = new Actions()
    const fn = vi.fn()
    actions.register({ "app.quit": { fn, cmd: "quit" } })
    const src = actionsSource({ actions })
    const item = { id: "app.quit", name: "quit", score: 1, text: "quit" }
    const result = src.accept!(item, "quit")
    expect(result).toBeUndefined()
    await Promise.resolve()
    expect(fn).toHaveBeenCalled()
  })

  test("accepting from autocomplete runs the action after the typed /cmd is removed", async () => {
    const i = input({})
    await i.render(createCtx({ width: 40 }))
    const actions = new Actions()
    const seen: string[] = []
    actions.register({ "app.effort": { cmd: "effort", fn: () => seen.push(i.state.value ?? "") } })
    const ac = autocomplete({ input: i, sources: { slash: actionsSource({ actions }) } })
    i.state.set({ cursor: 7, value: "/effort" })
    await new Promise((resolve) => setImmediate(resolve))
    ac.select.actions["select.accept"]()
    await Promise.resolve()
    expect(seen).toEqual([""])
  })

  test("default trigger matches a leading /", () => {
    const actions = new Actions()
    const src = actionsSource({ actions })
    expect(src.triggers[0].test("/x")).toBe(true)
    expect(src.triggers[0].test("/  x")).toBe(true)
    expect(src.triggers[0].test("hello /x")).toBe(false)
  })
})
