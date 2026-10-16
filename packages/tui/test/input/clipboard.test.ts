import { which } from "@zaly/shared/process"
import { execFileSync } from "node:child_process"
import { rmSync } from "node:fs"
import { platform } from "node:process"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { clipboard } from "../../src/input/clipboard.ts"

// Native providers (xclip, wl-copy, pbcopy) would win over tmux outside an
// SSH session, so only Linux with the display variables cleared reaches the
// terminal clipboard path deterministically.
describe.skipIf(!which("tmux") || platform !== "linux")("clipboard.write inside tmux", () => {
  const socket = `zaly-clipboard-test-${process.pid}`
  const tmux = (...args: string[]) =>
    execFileSync("tmux", ["-L", socket, "-f", "/dev/null", ...args], { encoding: "utf8" })
  const saved = {
    DISPLAY: process.env.DISPLAY,
    TMUX: process.env.TMUX,
    WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY,
  }

  let socketPath = ""

  beforeEach(() => {
    tmux("new-session", "-d", "sleep 30")
    socketPath = tmux("display", "-p", "#{socket_path}").trim()
    process.env.TMUX = `${socketPath},0,0`
    delete process.env.DISPLAY
    delete process.env.WAYLAND_DISPLAY
    clipboard.reset()
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    clipboard.reset()
    tmux("kill-server")
    // tmux leaves the socket file behind after kill-server.
    rmSync(socketPath, { force: true })
  })

  test("copied text lands in a tmux buffer", async () => {
    expect(await clipboard.write("こんにちは")).toBe(true)
    expect(tmux("show-buffer")).toBe("こんにちは")
  })
})
