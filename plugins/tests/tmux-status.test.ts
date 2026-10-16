import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { createTracker, tmuxRunner, tmuxStatus } from "../tmux-status.ts"

describe("tmuxStatus", () => {
  test("maps the working states to busy", () => {
    expect(tmuxStatus("streaming")).toBe("busy")
    expect(tmuxStatus("running-tools")).toBe("busy")
    expect(tmuxStatus("compacting")).toBe("busy")
  })

  test("maps a finished turn to done and a stalled one to waiting", () => {
    expect(tmuxStatus("idle")).toBe("done")
    // Errors, aborts and `max-steps` all land on `paused` — the agent stopped
    // without finishing, which is what `waiting` means.
    expect(tmuxStatus("paused")).toBe("waiting")
    // An open permission prompt is also "needs you", not "working".
    expect(tmuxStatus("waiting")).toBe("waiting")
  })
})

describe("createTracker", () => {
  test("collapses every working status into a single busy transition", () => {
    const seen: string[] = []
    const tracker = createTracker((status) => seen.push(status))

    tracker.update("streaming")
    tracker.update("running-tools")
    tracker.update("streaming")
    tracker.update("compacting")
    expect(seen).toEqual(["busy"])

    tracker.update("idle")
    expect(seen).toEqual(["busy", "done"])
  })

  test("clear resets the state so the next transition is sent again", () => {
    const seen: string[] = []
    const tracker = createTracker((status) => seen.push(status))
    tracker.update("streaming")
    tracker.update("idle")
    tracker.clear()
    expect(seen).toEqual(["busy", "done", "clear"])

    tracker.update("idle")
    expect(seen).toEqual(["busy", "done", "clear", "done"])
  })
})

describe("tmuxRunner", () => {
  let dir: string
  let script: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "zaly-tmux-status-"))
    script = join(dir, "cc-status.sh")
    // Records the state it was called with, like the real script would.
    await writeFile(script, '#!/bin/sh\nprintf "%s" "$1" >> "$OUT"\n')
    await chmod(script, 0o755)
    process.env.OUT = join(dir, "out.txt")
  })

  afterEach(async () => {
    delete process.env.OUT
    await rm(dir, { force: true, recursive: true })
  })

  test("is a no-op outside tmux", () => {
    expect(tmuxRunner({ TMUX: undefined, TMUX_PANE: undefined })).toBeUndefined()
    expect(tmuxRunner({ TMUX: "/tmp/tmux-1000/default,1,0" })).toBeUndefined()
    expect(tmuxRunner({ TMUX_PANE: "%1" })).toBeUndefined()
  })

  test("is a no-op when the script is missing", () => {
    const env = { TMUX: "x", TMUX_PANE: "%1", ZALY_TMUX_STATUS: join(dir, "nope.sh") }
    expect(tmuxRunner(env)).toBeUndefined()
  })

  test("runs the configured script with the state", async () => {
    const run = tmuxRunner({ TMUX: "x", TMUX_PANE: "%1", ZALY_TMUX_STATUS: script })
    expect(run).toBeDefined()
    run!("busy")
    run!("done")
    // The runner is fire-and-forget, so give the child a moment to exit.
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(await readFile(process.env.OUT!, "utf8")).toBe("busydone")
  })
})
