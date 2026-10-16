import { afterEach, describe, expect, test } from "vitest"
import { createCtx } from "../../src/core/ctx.ts"
import { CURSOR_MARKER, Frame } from "../../src/renderer/frame.ts"
import { Terminal } from "../../src/renderer/terminal.ts"
import { defaultTheme } from "../../src/themes/registry.ts"
import { MockReader, MockWriter } from "./mock.ts"

function testFrame() {
  const terminal = new Terminal({
    hookSignals: false,
    stdin: new MockReader(),
    stdout: new MockWriter(20, 5),
  })
  return {
    ctx: createCtx({ theme: { ...defaultTheme, selection: { inverse: true } }, width: 20 }),
    frame: new Frame(terminal).begin(),
  }
}

describe("Frame default colors", () => {
  const terminals: Terminal[] = []
  afterEach(() => {
    for (const terminal of terminals) terminal.stop()
    terminals.length = 0
  })

  function setup() {
    const writer = new MockWriter(20, 5)
    const terminal = new Terminal({ hookSignals: false, stdin: new MockReader(), stdout: writer })
    terminals.push(terminal)
    terminal.start()
    writer.clear()
    const frame = new Frame(terminal)
    frame.setDefaultStyle("\x1b[31m", "\x1b[44m")
    return { frame, terminal, writer }
  }

  test("keeps raw mirrors and does not write unchanged frames", () => {
    const { frame, writer } = setup()
    const paint = frame.begin()
    paint.set(5, "hello")
    paint.commitBase()
    paint.paint()
    expect(writer.all.startsWith("\x1b[0m\x1b[31m\x1b[44m")).toBe(true)
    expect(writer.all.endsWith("\x1b[0m")).toBe(true)
    expect(frame.slice(5, undefined, undefined)?.line).toBe("hello")
    writer.clear()
    expect(frame.begin().get(5)).toBe("hello")
    expect(frame.begin().paint()).toEqual({ ops: 0, rows: 0 })
    expect(writer.all).toBe("")
  })

  test("repaints when only default colors change", () => {
    const { frame, writer } = setup()
    const paint = frame.begin()
    paint.set(5, "same")
    paint.commitBase()
    paint.paint()
    writer.clear()
    frame.setDefaultStyle("\x1b[32m", "\x1b[45m")
    expect(frame.begin().paint().rows).toBe(5)
    expect(writer.all).toContain("same")
    expect(writer.all).toContain("\x1b[32m\x1b[45m")
  })

  test("establishes defaults around queued scroll operations", () => {
    const { frame, terminal, writer } = setup()
    frame.begin().paint()
    writer.clear()
    const paint = frame.begin()
    paint.scrollUp(1, 5, 1, (t) => t.write(t.scrollUp(1)))
    paint.paint()
    expect(writer.all).toBe(`\x1b[0m\x1b[31m\x1b[44m${terminal.scrollUp(1)}\x1b[0m`)
  })

  test("restores terminal defaults if a queued operation throws", () => {
    const { frame, writer } = setup()
    const paint = frame.begin()
    paint.queue(() => {
      throw new Error("failed")
    })
    expect(() => paint.paint()).toThrow("failed")
    expect(writer.all.endsWith("\x1b[0m")).toBe(true)
  })
})

describe("RenderFrame.slice", () => {
  test("returns a full line plus the clamped selected range", () => {
    const { frame } = testFrame()
    frame.set(1, "hello")

    expect(frame.slice(1, -10, 4)).toEqual({ from: 1, line: "hello", to: 4 })
    expect(frame.slice(1, 5, 5)).toBeUndefined()
    expect(frame.slice(10, 1, 2)).toBeUndefined()
  })
})

describe("RenderFrame.takeCursor", () => {
  test("strips the cursor marker and returns its 1-based screen cell", () => {
    const { frame } = testFrame()
    frame.set(3, `> 日本${CURSOR_MARKER}\x1b[7m \x1b[27m`)
    expect(frame.takeCursor()).toEqual({ col: 7, row: 3 })
    expect(frame.get(3)).toBe("> 日本\x1b[7m \x1b[27m")
  })

  test("returns undefined when no row carries the marker", () => {
    const { frame } = testFrame()
    frame.set(1, "hello")
    expect(frame.takeCursor()).toBeUndefined()
  })
})

describe("RenderFrame.highlight", () => {
  test("wraps a screen-column range in inverse video", () => {
    const { ctx, frame } = testFrame()
    frame.set(1, "hello world")
    expect(frame.highlight(1, 3, 7, ctx)).toEqual({ from: 3, line: "hello world", to: 7 })
    expect(frame.get(1)).toBe("he\x1b[7mllo \x1b[0mworld")
  })

  test("clamps ranges and ignores empty or offscreen highlights", () => {
    const { ctx, frame } = testFrame()
    frame.set(1, "hello")
    expect(frame.highlight(1, -10, 4, ctx)).toEqual({ from: 1, line: "hello", to: 4 })
    expect(frame.highlight(1, 5, 5, ctx)).toBeUndefined()
    expect(frame.highlight(10, 1, 2, ctx)).toBeUndefined()
    expect(frame.get(1)).toBe("\x1b[7mhel\x1b[0mlo")
  })

  test("preserves surrounding ANSI-styled content", () => {
    const { ctx, frame } = testFrame()
    frame.set(1, "a\x1b[31mbcd\x1b[0me")
    expect(frame.highlight(1, 2, 4, ctx)).toEqual({ from: 2, line: "a\x1b[31mbcd\x1b[0me", to: 4 })
    expect(frame.get(1)).toContain("\x1b[7m")
    expect(frame.get(1)).toContain("\x1b[0m")
    expect(frame.get(1)).toContain("\x1b[31m")
  })
})
