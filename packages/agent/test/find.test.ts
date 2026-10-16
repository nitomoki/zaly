import type { MetaPart, TextPart, ToolContext } from "@zaly/ai"
import type { FindToolMeta } from "../src/tools/find.ts"

import { justText } from "@zaly/ai"
import { find as findFiles } from "@zaly/shared/find"
import { which } from "@zaly/shared/process"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "pathe"
import { afterEach, beforeEach, expect, test } from "vitest"
import { findTool } from "../src/tools/find.ts"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "zaly-find-test-"))
  execFileSync("git", ["init", "-q", dir])
  mkdirSync(join(dir, ".github"))
  mkdirSync(join(dir, "src"))
  mkdirSync(join(dir, "node_modules"))
  writeFileSync(join(dir, ".gitignore"), "ignored.txt\n")
  writeFileSync(join(dir, ".github", "config.yml"), "")
  writeFileSync(join(dir, "src", "main.ts"), "")
  writeFileSync(join(dir, "ignored.txt"), "")
  writeFileSync(join(dir, "node_modules", "dependency.js"), "")
  for (const file of [
    "packages/config/src/schemas/tpl/models.ts",
    "packages/ai/test/catalog.test.ts",
    "packages/dev/test/smoke.test.ts",
    "packages/dev/test/pack.test.ts",
  ]) {
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), "")
  }
})
afterEach(() => rmSync(dir, { force: true, recursive: true }))

async function search(args: Record<string, unknown> = {}) {
  const params = await findTool.validator.validateParams(args)
  const ctx: ToolContext<FindToolMeta> = { cwd: dir }
  const parts = (await findTool.call(params, ctx)) as (MetaPart | TextPart)[]
  return { meta: ctx.meta, parts }
}

async function find(args: Record<string, unknown> = {}) {
  const { parts } = await search(args)
  return justText(parts).trim().split("\n")
}

test("exposes only the five file-discovery parameters", () => {
  const schema = findTool.params as unknown as { properties: Record<string, unknown> }
  expect(Object.keys(schema.properties)).toEqual(["glob", "paths", "hidden", "ignore", "limit"])
})

test("includes hidden files while respecting ignore files and default exclusions", async () => {
  const files = await find()
  expect(files).toContain(".github/config.yml")
  expect(files).toContain(".gitignore")
  expect(files).toContain("src/main.ts")
  expect(files).not.toContain("ignored.txt")
  expect(files.some((file) => file.startsWith(".git/"))).toBe(false)
  expect(files.some((file) => file.startsWith("node_modules/"))).toBe(false)
})

test("glob fallback returns ignore files while respecting their rules", async () => {
  const batches = await Array.fromAsync(findFiles({ backend: "glob", cwd: dir, hidden: true }))
  const files = batches.flat()
  expect(files).toContain(".gitignore")
  expect(files).toContain(".github/config.yml")
  expect(files).not.toContain("ignored.txt")
  expect(files.some((file) => file.startsWith(".git/"))).toBe(false)
})

test("can hide dotfiles explicitly", async () => {
  const files = await find({ hidden: false })
  expect(files).toContain("src/main.ts")
  expect(files.some((file) => file.startsWith("."))).toBe(false)
})

test("can include ignored files without dropping default exclusions", async () => {
  const files = await find({ ignore: false })
  expect(files).toContain("ignored.txt")
  expect(files.some((file) => file.startsWith(".git/"))).toBe(false)
  expect(files.some((file) => file.startsWith("node_modules/"))).toBe(false)
})

test("supports absolute search paths and filename globs", async () => {
  const files = await find({ glob: "*.ts", paths: [join(dir, "src")] })
  expect(files).toHaveLength(1)
  expect(files[0]).toMatch(/(?:^|\/)main\.ts$/)
})

test("supports arrays mixing recursive path and filename globs", async () => {
  const files = await find({
    glob: ["**/schemas/tpl/**", "*catalog*.test.ts", "**/*smoke*.test.ts", "**/*pack*.test.ts"],
  })
  expect(files.toSorted()).toEqual([
    "packages/ai/test/catalog.test.ts",
    "packages/config/src/schemas/tpl/models.ts",
    "packages/dev/test/pack.test.ts",
    "packages/dev/test/smoke.test.ts",
  ])
})

test.each([false, true])(
  "preserves matches and warns about missing roots (missing first: %s)",
  async (missingFirst) => {
    const { parts } = await search({
      paths: missingFirst ? ["missing", "src"] : ["src", "missing"],
    })
    const text = justText(parts)
    expect(text).toContain("src/main.ts")
    expect(text).toContain("Warning: Search incomplete")
    expect(text).toContain("missing")
    expect(parts.find((part) => part.type === "meta")).toMatchObject({
      tag: "find",
      data: { incomplete: true },
    })
  }
)

test("limits displayed paths and marks additional results as truncated", async () => {
  const { meta, parts } = await search({ limit: 1 })
  expect(meta?.truncated).toBe(true)
  const text = justText(parts)
  const paths = text
    .trim()
    .split("\n")
    .filter((line) => !line.startsWith(" [ … truncated"))
  expect(paths).toHaveLength(1)
})

test("keeps warnings visible when paths are truncated", async () => {
  const { meta, parts } = await search({ limit: 1, paths: ["missing", "src", "packages"] })
  expect(meta?.truncated).toBe(true)
  expect(justText(parts)).toContain("Warning: Search incomplete")
  expect(justText(parts)).toContain("missing")
})

test("does not mark a complete result at the limit as truncated", async () => {
  const { meta } = await search({ limit: 1, paths: ["src"] })
  expect(meta?.truncated).toBe(false)
})

test("fails rather than claiming no matches when a search root is missing", async () => {
  await expect(find({ glob: "*.missing", paths: ["src", "missing"] })).rejects.toMatchObject({
    code: "FIND_FAILED",
  })
  await expect(find({ paths: ["missing"] })).rejects.toMatchObject({ code: "FIND_FAILED" })
})

test("allows explicitly targeting an otherwise excluded directory", async () => {
  const files = await find({ paths: ["node_modules"] })
  expect(files).toContain("node_modules/dependency.js")
})

const backends = {
  fd: !!(which("fd") ?? which("fdfind")),
  glob: true,
  rg: !!which("rg"),
}
for (const [backend, available] of Object.entries(backends)) {
  test.skipIf(!available)(`limit caps the total ${backend} returns across paths`, async () => {
    mkdirSync(join(dir, "few"))
    mkdirSync(join(dir, "many"))
    for (let i = 0; i < 2; i++) writeFileSync(join(dir, "few", `f${i}.ts`), "")
    for (let i = 0; i < 50; i++) writeFileSync(join(dir, "many", `f${i}.ts`), "")
    const backendName = backend as keyof typeof backends
    const opts = { backend: backendName, cwd: dir, limit: 3, paths: ["few", "many"] }
    const batches = await Array.fromAsync(findFiles(opts))
    expect(batches.flat()).toHaveLength(3)
  })
}
