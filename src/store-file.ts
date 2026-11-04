// store-file.ts — filesystem-backed lease store for the turn-lock plugin.
//
// Why a file store and not a module-level Map: OpenCode instantiates a plugin
// once per *location* (project directory), while its event stream and the
// local model engine are server-wide. Two locations must therefore agree on who
// holds a slot, so leases live in one small directory shared by every instance
// of every process that points at the same TURN_LOCK_DIR.
//
// One file per session: "<sid>.lease.json". Writes are atomic (tmp + rename),
// reads are tolerant (a half-written or corrupt file is treated as absent and
// is overwritten by the next write).

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import type { Lease, LeaseStore } from "./core.ts"

const SUFFIX = ".lease.json"

/** Session ids are `ses_<id>`; sanitize anyway so a stray sid cannot escape the directory. */
function fileName(sid: string): string {
  return `${sid.replace(/[^A-Za-z0-9_.-]/g, "_")}${SUFFIX}`
}

function parseLease(text: string): Lease | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!value || typeof value !== "object") return undefined
  const lease = value as Record<string, unknown>
  if (typeof lease.sid !== "string" || !lease.sid) return undefined
  if (typeof lease.since !== "number" || !Number.isFinite(lease.since)) return undefined
  if (typeof lease.seen !== "number" || !Number.isFinite(lease.seen)) return undefined
  const parsed: Lease = { sid: lease.sid, since: lease.since, seen: lease.seen }
  if (lease.over === true) parsed.over = true
  if (typeof lease.pid === "number") parsed.pid = lease.pid
  if (typeof lease.owner === "string") parsed.owner = lease.owner
  return parsed
}

export type FileLeaseStore = LeaseStore & {
  readonly dir: string
  /** Remove leases whose recorded pid is no longer alive. Returns removed session ids. */
  pruneDead(isAlive: (pid: number) => boolean): string[]
}

export function fileStore(dir: string): FileLeaseStore {
  const path = (sid: string) => join(dir, fileName(sid))

  const ensure = () => {
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    } catch {
      // A missing directory is re-reported by the write below; never throw here.
    }
  }

  const read: LeaseStore["read"] = (sid) => {
    const file = path(sid)
    try {
      return parseLease(readFileSync(file, "utf8"))
    } catch {
      return undefined
    }
  }

  const write: LeaseStore["write"] = (lease) => {
    ensure()
    const file = path(lease.sid)
    const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
    const text = JSON.stringify(lease)
    try {
      writeFileSync(temp, text, "utf8")
      renameSync(temp, file) // atomic replace on POSIX and on Windows (MoveFileEx)
    } catch {
      // Fall back to a direct write: an interleaved partial read is tolerated by parseLease.
      try {
        writeFileSync(file, text, "utf8")
      } catch {
        // The store is best-effort: a broken temp directory must not break the agent.
      }
      try {
        if (existsSync(temp)) unlinkSync(temp)
      } catch {
        // ignore
      }
    }
  }

  const remove: LeaseStore["remove"] = (sid) => {
    try {
      if (existsSync(path(sid))) unlinkSync(path(sid))
    } catch {
      // ignore
    }
  }

  const list: LeaseStore["list"] = () => {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return []
    }
    const leases: Lease[] = []
    for (const name of names) {
      if (!name.endsWith(SUFFIX)) continue
      const lease = read(name.slice(0, -SUFFIX.length))
      if (lease) leases.push(lease)
    }
    return leases
  }

  const pruneDead = (isAlive: (pid: number) => boolean): string[] => {
    const removed: string[] = []
    for (const lease of list()) {
      if (typeof lease.pid !== "number") continue
      if (isAlive(lease.pid)) continue
      remove(lease.sid)
      removed.push(lease.sid)
    }
    return removed
  }

  return { dir, read, write, remove, list, pruneDead }
}

/**
 * Liveness probe used at boot to clear leases left behind by a dead server.
 * `process.kill(pid, 0)` is supported for this on Windows too: it throws ESRCH
 * for a missing process and EPERM for one we may not signal.
 */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as { code?: string } | undefined)?.code === "EPERM"
  }
}
