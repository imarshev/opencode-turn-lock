// trace.ts — the structured diagnostic trace of the turn-lock plugin.
//
// Two logs, two questions:
//   * `turn-lock.log` (index.ts) is the human line log: "what did the plugin
//     say" — one readable sentence per grant, release and wait.
//   * this file is the machine trace: "why did the slot move, and was it
//     reliable" — one JSON line per decision, written from inside the gate, the
//     event handler and the queue. A night of traffic can then be replayed with
//     a couple of queries instead of guessing from prose:
//
//       jq -r 'select(.ev=="release") | [.t,.sid,.reason,.ageMs] | @tsv' lock-*.jsonl
//       jq -r 'select(.ev=="event.recv") | .type' lock-*.jsonl | sort | uniq -c
//       jq -c 'select(.ev=="snapshot")' lock-*.jsonl | tail -1
//
// Layout: one file per local day, `<dir>/<prefix>-YYYY-MM-DD.jsonl`. Files older
// than `keepMs` (one day by default) are deleted on the first write of a new day,
// so the directory cannot grow without bound. Writes are append-only, one line
// per write, which is atomic enough for the several plugin instances (one per
// location) that share the directory.
//
// Nothing here may throw: the trace is diagnosis, never a dependency of the gate.

import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"

const SUFFIX = ".jsonl"

export type TraceFields = Record<string, unknown>

export type Trace = {
  /** True when lines are actually written. */
  readonly on: boolean
  /** Current file, or "" when the trace is off. */
  file(): string
  /** Append one line. `fields` are merged into the line as-is. */
  write(event: string, fields?: TraceFields): void
}

export type TraceOptions = {
  /** Directory that holds the daily files. */
  dir: string
  /** File-name prefix; files are `<prefix>-YYYY-MM-DD.jsonl`. */
  prefix?: string
  /** Delete files older than this. 0 keeps everything. */
  keepMs?: number
  enabled?: boolean
  now?: () => number
  /** Merged into every line: pid, owner, scope, … */
  base?: TraceFields
}

/** Local calendar day, which is what a human means by "the night's log". */
export function dayKey(ms: number): string {
  const date = new Date(ms)
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function createTrace(options: TraceOptions): Trace {
  const enabled = options.enabled !== false
  const prefix = options.prefix ?? "lock"
  const keepMs = Math.max(0, options.keepMs ?? 24 * 60 * 60_000)
  const now = options.now ?? (() => Date.now())
  const base = options.base ?? {}
  let currentDay = ""
  let currentFile = ""

  const fileFor = (day: string) => join(options.dir, `${prefix}-${day}${SUFFIX}`)

  /** Drop day files that fell out of the retention window. */
  const prune = (at: number): void => {
    if (keepMs <= 0) return
    let names: string[]
    try {
      names = readdirSync(options.dir)
    } catch {
      return
    }
    for (const name of names) {
      if (!name.startsWith(`${prefix}-`) || !name.endsWith(SUFFIX)) continue
      const path = join(options.dir, name)
      try {
        if (at - statSync(path).mtimeMs > keepMs) rmSync(path, { force: true })
      } catch {
        // a file someone still holds open stays until the next day
      }
    }
  }

  return {
    on: enabled,
    file: () => (enabled ? currentFile : ""),
    write(event, fields) {
      if (!enabled) return
      try {
        const at = now()
        const day = dayKey(at)
        if (day !== currentDay) {
          currentDay = day
          mkdirSync(options.dir, { recursive: true })
          currentFile = fileFor(day)
          prune(at)
        }
        const line = JSON.stringify({ t: new Date(at).toISOString(), ms: at, ...base, ev: event, ...fields })
        appendFileSync(currentFile, `${line}\n`, "utf8")
      } catch {
        // diagnosis must never break the agent
      }
    },
  }
}
