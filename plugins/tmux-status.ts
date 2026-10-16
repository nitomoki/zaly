/**
 * Mirror zaly's run state onto the tmux pane indicator.
 *
 * The pane-border glyph in `~/.config/tmux/tmux.conf` reads `@cc_status`, which
 * `~/.claude/hooks/cc-status.sh` keeps up to date from Claude Code's hooks. The
 * script takes `busy | waiting | done | clear`, writes the state onto the
 * calling pane (`$TMUX_PANE`), aggregates every pane's state into its session,
 * and refreshes the clients.
 *
 * Rather than reimplement that aggregation (a second source of truth that would
 * drift the moment the script changes), this plugin drives the same script from
 * zaly's agent events. Both agents can then share one indicator, and the
 * session still shows whatever needs attention first.
 *
 * Only the coarse transitions reach tmux: `streaming`, `running-tools` and
 * `compacting` all mean "busy", so a tool-heavy turn triggers one call, not one
 * per step. Outside tmux — or without the script — this is a no-op.
 *
 * Configure the script with `ZALY_TMUX_STATUS`; it defaults to
 * `~/.claude/hooks/cc-status.sh`.
 */

import type { AgentStatus } from "@zaly/agent"
import type { PluginApi } from "@zaly/plugin"

import { spawnCmd, which } from "@zaly/shared/process"
import { homedir } from "node:os"
import { join } from "node:path"

/** States the `cc-status.sh` protocol accepts. */
export type TmuxStatus = "busy" | "waiting" | "done" | "clear"

/** zaly's status → the indicator. `paused` covers errors, aborts and
 *  `max-steps`: the agent stopped without finishing, so it wants attention.
 *  `waiting` is an open permission prompt — the run is suspended on the user. */
export function tmuxStatus(status: AgentStatus): TmuxStatus {
  switch (status) {
    case "streaming": {
      return "busy"
    }
    case "running-tools": {
      return "busy"
    }
    case "compacting": {
      return "busy"
    }
    case "waiting": {
      return "waiting"
    }
    case "idle": {
      return "done"
    }
    case "paused": {
      return "waiting"
    }
  }
}

export type StatusRunner = (status: TmuxStatus) => unknown

export type Tracker = {
  /** Track an agent status. Repeated statuses that map to the same
   *  indicator are collapsed. */
  update: (status: AgentStatus) => void
  /** Send `clear` and forget the last state. */
  clear: () => void
}

/** Collapse agent statuses into indicator transitions and hand them to
 *  `run`. Kept separate from the tmux plumbing so it can be tested without
 *  spawning anything. */
export function createTracker(run: StatusRunner): Tracker {
  let last: TmuxStatus | undefined
  const send = (status: TmuxStatus) => {
    if (status === last) return
    last = status
    run(status)
  }
  return {
    clear: () => {
      last = undefined
      run("clear")
    },
    update: (status) => send(tmuxStatus(status)),
  }
}

/** Run `cc-status.sh` for the calling pane. Returns `undefined` when zaly
 *  isn't inside tmux or the script is missing, so the caller can stay quiet. */
export function tmuxRunner(env: NodeJS.ProcessEnv = process.env): StatusRunner | undefined {
  if (!env.TMUX || !env.TMUX_PANE) return undefined
  const script = env.ZALY_TMUX_STATUS ?? join(homedir(), ".claude", "hooks", "cc-status.sh")
  if (!which(script)) return undefined
  return (status) => {
    // The script reads `$TMUX_PANE` from the environment, which zaly inherits
    // from the shell it was launched in.
    void spawnCmd(script, status).catch(() => undefined)
  }
}

export default function TmuxStatusPlugin(api: PluginApi) {
  const run = tmuxRunner()
  if (!run) return

  const tracker = createTracker(run)
  api.events.on("agent:status", ({ status }) => tracker.update(status))
  // Leaving zaly shouldn't leave a stale glyph behind.
  api.signal.addEventListener("abort", () => tracker.clear())
}
