// priority-store.ts — the shared record of where the user wants a session to
// stand: `<sessionID>.prio.json` in the lock directory.
//
// `/prio` writes it from any client; every process that shares the directory
// reads it. `level` is `high` (`⚡`, cuts the queue) or `low` (`▽`, stands at the
// back of it); no file means ordinary. A flag is inert while its session
// neither waits nor holds a slot, so a forgotten mark costs nothing — and it
// expires anyway after `ttlMs`.
//
// The rule that a subagent inherits its root's level lives here too: it is the
// same "which flag applies to this session" question. The root itself is cached
// by the caller (`rootOf`), so this module stays free of ancestry lookups and
// of the plugin runtime.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { PRIORITY_RANK, type PriorityLevel } from "./priority.ts"

/** A recorded flag: which end of the queue the session asked for, and since when. */
export type PriorityFlag = { level: "high" | "low"; since: number }

export type PriorityFlagsOptions = {
  /** The lock directory shared by every plugin instance. */
  dir: string
  /** A flag older than this stops working and is removed. */
  ttlMs: number
  /** `priorityEnabled: false` makes every flag inert. */
  enabled: boolean
  /** Who wrote the flag, for debugging a shared directory. */
  owner: string
  now?: () => number
  pid?: number
  /** The session's root, when the caller has cached it: a subagent has no level
   *  of its own. Returning `undefined` (or the session itself) means "own flag". */
  rootOf?: (sid: string) => string | undefined
}

export type PriorityFlags = {
  path: (sid: string) => string
  read: (sid: string) => PriorityFlag | undefined
  write: (sid: string, level: PriorityLevel) => void
  drop: (sid: string) => void
  /** The flag that decides this session's level: its root's, or its own. */
  flagOf: (sid: string) => PriorityFlag | undefined
  levelOf: (sid: string) => PriorityLevel
  rankOf: (sid: string) => number
}

export function createPriorityFlags(options: PriorityFlagsOptions): PriorityFlags {
  const now = options.now ?? (() => Date.now())
  const pid = options.pid ?? process.pid
  const path = (sid: string) => join(options.dir, `${sid.replace(/[^A-Za-z0-9_.-]/g, "_")}.prio.json`)

  const drop = (sid: string): void => {
    try {
      if (existsSync(path(sid))) unlinkSync(path(sid))
    } catch {
      // best-effort
    }
  }

  const read = (sid: string): PriorityFlag | undefined => {
    if (!options.enabled) return undefined
    try {
      const value = JSON.parse(readFileSync(path(sid), "utf8"))
      const since = typeof value?.since === "number" ? value.since : 0
      if (!since) return undefined
      if (now() - since > options.ttlMs) {
        drop(sid)
        return undefined
      }
      // Ordinary is the absence of a flag: a file saying so is stale, and a file
      // without `level` was written before levels existed — it meant `⚡` then.
      if (value?.level === "normal") {
        drop(sid)
        return undefined
      }
      return { level: value?.level === "low" ? "low" : "high", since }
    } catch {
      return undefined
    }
  }

  /** Asks for `level` in the queue; ordinary is the absence of a flag. */
  const write = (sid: string, level: PriorityLevel): void => {
    if (level === "normal") {
      drop(sid)
      return
    }
    try {
      mkdirSync(options.dir, { recursive: true })
      writeFileSync(path(sid), JSON.stringify({ sid, pid, owner: options.owner, since: now(), level }), "utf8")
    } catch {
      // priority is best-effort: without the file the session simply stays ordinary
    }
  }

  const flagOf = (sid: string): PriorityFlag | undefined => {
    const root = options.rootOf?.(sid)
    if (root && root !== sid) return read(root)
    return read(sid)
  }

  const levelOf = (sid: string): PriorityLevel => flagOf(sid)?.level ?? "normal"

  return {
    path,
    read,
    write,
    drop,
    flagOf,
    levelOf,
    rankOf: (sid: string) => PRIORITY_RANK[levelOf(sid)],
  }
}
