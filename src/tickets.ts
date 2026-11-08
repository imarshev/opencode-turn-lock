// tickets.ts — the return-ticket record of the turn-lock plugin.
//
// In `request` scope a lease is freed at the end of every model request
// (`session.step.ended`), so a session that will send another request a moment
// later goes back into the queue like everyone else. The return ticket gives
// that session its old place back: whoever comes back after having released its
// slot is served ahead of waiters that queued while it worked.
//
// A ticket is written under `<root>.turn.json` the moment a slot is freed at a
// boundary the session is expected to continue from (`finish: "tool-calls"` or
// `"length"`, or a form/permission pause). It records how many slot grants the
// world had performed when the session released (`releasedGrants`). The queue
// reads it while the session waits: if nobody was admitted since the release
// (`grants <= releasedGrants`) the session is *deferred* — it must not grab the
// slot it just freed while others queue behind it — and once someone has been
// admitted (`grants > releasedGrants`) it is *boosted* to the front of its
// level. The ticket expires after `ttlMs`; root-aware (`rootOf`) so a subagent
// reads and rides its parent's ticket.
//
// Like priority-store.ts this module is pure fs: the grant counter and the
// ancestry cache live in the caller (`readGrants`), and it never imports the
// plugin runtime.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/** A recorded return: when the slot was freed and how many grants had happened. */
export type ReturnTicket = {
  sid: string
  pid: number
  owner: string
  releasedAt: number
  expiresAt: number
  releasedGrants: number
}

export type ReturnTicketsOptions = {
  /** The lock directory shared by every plugin instance. */
  dir: string
  /** How long a return ticket stays valid before the session loses its place. */
  ttlMs: number
  /** Who wrote the ticket, for debugging a shared directory. */
  owner: string
  pid?: number
  now?: () => number
  /** The session's root, when the caller has cached it: a subagent's ticket is
   *  kept under its root's name, so the root's return jumps the child's queue. */
  rootOf?: (sid: string) => string | undefined
  /** The shared grant counter (how many slots have been admitted). A ticket
   *  records it at release so the queue can tell whether the releasing session
   *  was overtaken before it came back. */
  readGrants: () => number
}

export type ReturnTickets = {
  path: (sid: string) => string
  read: (sid: string) => ReturnTicket | undefined
  write: (sid: string) => void
  drop: (sid: string) => void
  /** Remove expired tickets and tickets of dead processes; returns how many
   *  were removed. A ticket whose pid is alive and unexpired is kept. */
  sweep: (isAlive?: (pid: number) => boolean) => number
}

export function createReturnTickets(options: ReturnTicketsOptions): ReturnTickets {
  const now = options.now ?? (() => Date.now())
  const pid = options.pid ?? process.pid
  const keyOf = (sid: string): string => {
    const root = options.rootOf?.(sid)
    return root && root !== sid ? root : sid
  }
  const path = (sid: string) => join(options.dir, `${keyOf(sid).replace(/[^A-Za-z0-9_.-]/g, "_")}.turn.json`)

  const drop = (sid: string): void => {
    try {
      if (existsSync(path(sid))) unlinkSync(path(sid))
    } catch {
      // best-effort
    }
  }

  const read = (sid: string): ReturnTicket | undefined => {
    try {
      const value = JSON.parse(readFileSync(path(sid), "utf8"))
      const expiresAt = typeof value?.expiresAt === "number" ? value.expiresAt : 0
      // A ticket written before the expiry field existed, or already stale, is
      // not a return right: drop it and report nothing.
      if (!expiresAt) {
        drop(sid)
        return undefined
      }
      if (now() > expiresAt) {
        drop(sid)
        return undefined
      }
      return {
        sid: typeof value?.sid === "string" ? value.sid : keyOf(sid),
        pid: typeof value?.pid === "number" ? value.pid : 0,
        owner: typeof value?.owner === "string" ? value.owner : "",
        releasedAt: typeof value?.releasedAt === "number" ? value.releasedAt : 0,
        expiresAt,
        releasedGrants: typeof value?.releasedGrants === "number" ? value.releasedGrants : 0,
      }
    } catch {
      return undefined
    }
  }

  const write = (sid: string): void => {
    const target = keyOf(sid)
    const releasedAt = now()
    const file = path(sid)
    const tmp = `${file}.${pid}.tmp`
    try {
      mkdirSync(options.dir, { recursive: true })
      writeFileSync(
        tmp,
        JSON.stringify({
          sid: target,
          pid,
          owner: options.owner,
          releasedAt,
          expiresAt: releasedAt + Math.max(0, options.ttlMs),
          releasedGrants: options.readGrants(),
        }),
        "utf8",
      )
      // Atomic like the lease store: a reader in another process must never see
      // half a ticket (which would then look like garbage to `sweep`).
      renameSync(tmp, file)
    } catch {
      // a return ticket is best-effort: without it the session simply queues normally
      try {
        if (existsSync(tmp)) unlinkSync(tmp)
      } catch {
        // best-effort
      }
    }
  }

  const sweep = (isAlive?: (pid: number) => boolean): number => {
    let names: string[]
    try {
      names = readdirSync(options.dir)
    } catch {
      return 0
    }
    let removed = 0
    for (const name of names) {
      if (!name.endsWith(".turn.json")) continue
      const file = join(options.dir, name)
      try {
        const value = JSON.parse(readFileSync(file, "utf8"))
        const ticketPid = typeof value?.pid === "number" ? value.pid : undefined
        const expiresAt = typeof value?.expiresAt === "number" ? value.expiresAt : 0
        // Without a liveness oracle an unexpired ticket is kept: dropping a live
        // session's return right is worse than keeping a stale one for a moment.
        const alivePid =
          ticketPid !== undefined && ticketPid !== process.pid && isAlive ? Boolean(isAlive(ticketPid)) : true
        const expired = expiresAt !== 0 && now() > expiresAt
        if (alivePid && !expired && typeof value?.sid === "string") continue
        unlinkSync(file)
        removed += 1
      } catch {
        // A file that does not parse is garbage: the writer renames atomically,
        // so a half-written ticket cannot be a live one. Drop it.
        try {
          unlinkSync(file)
          removed += 1
        } catch {
          // already removed
        }
      }
    }
    return removed
  }

  return { path, read, write, drop, sweep }
}