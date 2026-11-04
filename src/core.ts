// core.ts — the pure scheduling core of the turn-lock plugin.
//
// No imports on purpose: the file is unit-tested with `node --test` (Node 24
// strips TypeScript types) and must stay independent of @opencode/plugin and
// of node:fs. The filesystem store lives in store-file.ts.
//
// Contract:
//  * A *lease* is a session's permission to send model requests. It is held
//    from the first gated request of a turn until the turn ends (idle /
//    success / failure / interrupt / delete / form) or the lease goes stale.
//  * At most `limit` live leases may exist. Everyone else waits, polling the
//    shared store, until a slot frees, its wait is cancelled, or the acquire
//    timeout fires.
//  * On timeout the waiter takes an "over" lease and proceeds (default), so a
//    wedged holder can never freeze the whole agent; "hold" keeps waiting.

export type Lease = {
  sid: string
  since: number
  seen: number
  over?: boolean
  pid?: number
  owner?: string
}

export interface LeaseStore {
  read(sid: string): Lease | undefined
  write(lease: Lease): void
  remove(sid: string): void
  list(): Lease[]
}

export type ChangeEvent =
  | { type: "grant"; sid: string; waited: boolean; waitedMs: number; overLimit: boolean; held: number; limit: number }
  | { type: "wait"; sid: string; held: number; limit: number; waitedMs: number }
  | { type: "release"; sid: string; reason: string; held: number }
  | { type: "cancel"; sid: string; reason: string }
  | { type: "stale"; sid: string; ageMs: number }
  | { type: "timeout"; sid: string; waitedMs: number }

export type AcquireResult = {
  granted: boolean
  waited: boolean
  overLimit: boolean
  reason?: string
}

export type TurnLockOptions = {
  store: LeaseStore
  limit?: number
  acquireTimeoutMs?: number
  leaseTimeoutMs?: number
  pollMs?: number
  onTimeout?: "proceed" | "hold"
  /** While waiting, re-emit a `wait` event every this many ms (0 = once). */
  remindEveryMs?: number
  owner?: string
  pid?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  onChange?: (event: ChangeEvent) => void
  /** How long a cancelled wait stays flagged, so the polling loop can see it. */
  cancelTtlMs?: number
}

export type TurnLock = {
  acquire(sid: string): Promise<AcquireResult>
  refresh(sid: string): void
  release(sid: string, reason: string): void
  cancelWait(sid: string, reason: string): void
  sweep(): void
  snapshot(): { leases: Lease[]; cancelled: string[] }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export function createTurnLock(options: TurnLockOptions): TurnLock {
  const store = options.store
  const limit = Math.max(1, options.limit ?? 2)
  const acquireTimeoutMs = Math.max(0, options.acquireTimeoutMs ?? 10 * 60_000)
  const leaseTimeoutMs = Math.max(1_000, options.leaseTimeoutMs ?? 60 * 60_000)
  const pollMs = Math.max(5, options.pollMs ?? 1_000)
  const onTimeout = options.onTimeout ?? "proceed"
  const remindEveryMs = Math.max(0, options.remindEveryMs ?? 5 * 60_000)
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleep ?? defaultSleep
  const onChange = options.onChange ?? (() => {})
  const cancelTtlMs = Math.max(pollMs * 2, options.cancelTtlMs ?? 5_000)

  const cancelled = new Map<string, number>() // sid -> expiresAt
  const timers = new Set<ReturnType<typeof setTimeout>>()

  const isCancelled = (sid: string): boolean => {
    const until = cancelled.get(sid)
    if (until === undefined) return false
    if (now() > until) {
      cancelled.delete(sid)
      return false
    }
    return true
  }

  const isExpired = (lease: Lease, at: number): boolean => at - lease.seen > leaseTimeoutMs

  const freshLeases = (at: number): Lease[] => store.list().filter((lease) => !isExpired(lease, at))

  const removeStale = (at: number): void => {
    for (const lease of store.list()) {
      if (!isExpired(lease, at)) continue
      store.remove(lease.sid)
      try {
        onChange({ type: "stale", sid: lease.sid, ageMs: at - lease.seen })
      } catch {
        // listeners must never break the lock
      }
    }
  }

  const emit = (event: ChangeEvent): void => {
    try {
      onChange(event)
    } catch {
      // listeners must never break the lock
    }
  }

  // The check-and-write block below contains no `await`, so within one process
  // it is atomic. Across processes two writers can still race; the post-write
  // verification keeps the limit honest: the loser removes its own lease and
  // keeps waiting.
  const tryTake = (sid: string, at: number): "taken" | "full" => {
    const mine = store.read(sid)
    if (mine) return "taken"
    const live = freshLeases(at)
    if (live.length >= limit) return "full"
    const lease: Lease = {
      sid,
      // sub-millisecond jitter gives a deterministic, fair tie-break between
      // processes that write in the same millisecond.
      since: at + Math.random(),
      seen: at,
      pid: options.pid,
      owner: options.owner,
    }
    store.write(lease)
    const after = freshLeases(now())
    if (after.length <= limit) return "taken"
    const ordered = after
      .slice()
      .sort((a, b) => a.since - b.since || a.sid.localeCompare(b.sid))
    const index = ordered.findIndex((candidate) => candidate.sid === sid)
    if (index >= 0 && index < limit) return "taken"
    store.remove(sid)
    return "full"
  }

  const acquire = async (sid: string): Promise<AcquireResult> => {
    const started = now()
    let waited = false
    let lastWaitAt = started
    for (;;) {
      if (isCancelled(sid)) {
        emit({ type: "cancel", sid, reason: "cancelled" })
        return { granted: false, waited, overLimit: false, reason: "cancelled" }
      }
      const at = now()
      removeStale(at)
      const mine = store.read(sid)
      if (mine) {
        mine.seen = at
        store.write(mine)
        return { granted: true, waited, overLimit: mine.over === true }
      }
      const held = freshLeases(at).length
      if (tryTake(sid, at) === "taken") {
        if (waited) {
          emit({ type: "grant", sid, waited: true, waitedMs: at - started, overLimit: false, held: held + 1, limit })
        }
        return { granted: true, waited, overLimit: false }
      }
      const waitedMs = at - started
      if (onTimeout === "proceed" && waitedMs >= acquireTimeoutMs) {
        store.write({ sid, since: at + Math.random(), seen: at, over: true, pid: options.pid, owner: options.owner })
        emit({ type: "timeout", sid, waitedMs })
        emit({ type: "grant", sid, waited: true, waitedMs, overLimit: true, held: held + 1, limit })
        return { granted: true, waited: true, overLimit: true }
      }
      if (!waited) {
        waited = true
        lastWaitAt = at
        emit({ type: "wait", sid, held, limit, waitedMs: 0 })
      } else if (remindEveryMs > 0 && at - lastWaitAt >= remindEveryMs) {
        lastWaitAt = at
        emit({ type: "wait", sid, held, limit, waitedMs })
      }
      await sleep(pollMs)
    }
  }

  const refresh = (sid: string): void => {
    const mine = store.read(sid)
    if (!mine) return
    mine.seen = now()
    store.write(mine)
  }

  const release = (sid: string, reason: string): void => {
    const mine = store.read(sid)
    cancelled.delete(sid)
    if (!mine) return
    store.remove(sid)
    emit({ type: "release", sid, reason, held: Math.max(0, freshLeases(now()).length - 1) })
  }

  const cancelWait = (sid: string, reason: string): void => {
    cancelled.set(sid, now() + cancelTtlMs)
    emit({ type: "cancel", sid, reason })
    const timer = setTimeout(() => {
      timers.delete(timer)
      cancelled.delete(sid)
    }, cancelTtlMs)
    if (typeof (timer as { unref?: () => void }).unref === "function") (timer as { unref: () => void }).unref()
    timers.add(timer)
  }

  const sweep = (): void => {
    removeStale(now())
  }

  const snapshot = () => ({
    leases: freshLeases(now()),
    cancelled: [...cancelled.keys()],
  })

  return { acquire, refresh, release, cancelWait, sweep, snapshot }
}

/** In-memory store: used by tests and as a fallback when no directory is available. */
export function memoryStore(): LeaseStore {
  const map = new Map<string, Lease>()
  return {
    read: (sid) => {
      const lease = map.get(sid)
      return lease ? { ...lease } : undefined
    },
    write: (lease) => {
      map.set(lease.sid, { ...lease })
    },
    remove: (sid) => {
      map.delete(sid)
    },
    list: () => [...map.values()].map((lease) => ({ ...lease })),
  }
}
