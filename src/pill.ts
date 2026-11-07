// pill.ts — when the composer pill shows, and how one command-list answer is
// read. Pure: no fs, no OpenCode, no timers, so the GUI half and `node --test`
// can both load it.
//
// The rule is the userscript's: only a server that *answered* without /prio
// hides the pill. An unknown answer — the probe is still running, or the server
// was unreachable — shows it, so a session whose composer mounted before the
// server part was ready keeps its control instead of losing it for good.

/** What one command list says about a directory. */
export type PillAnswer = "unknown" | "present" | "missing"

/** Read a command list into an answer. Names are matched exactly: the pill
 *  sends the configured command, so a same-named command from a project config
 *  counts too. */
export function answerFrom(names: readonly (string | undefined)[], command: string): PillAnswer {
  return names.some((name) => name === command) ? "present" : "missing"
}

/** Whether the pill shows above a session's composer: priority is on, the
 *  directory's command list did not answer without the command, and the session
 *  is not a subagent (whose priority is its parent's). */
export function pillVisible(input: {
  readonly enabled: boolean
  readonly answer: PillAnswer
  readonly child: boolean
}): boolean {
  return input.enabled && input.answer !== "missing" && !input.child
}
