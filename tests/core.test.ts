// Unit tests for the turn-lock scheduling core (src/core.ts).
// Run: node --test "tests/*.test.ts"
import assert from "node:assert/strict"
import test from "node:test"

import { createTurnLock, memoryStore, type AcquireResult, type LeaseStore } from "../src/core.ts"

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const ids = (store: LeaseStore) =>
  store
    .list()
    .map((lease) => lease.sid)
    .sort()

test("second session enters immediately, third waits for a free slot", async () => {
  const store = memoryStore()
  const lock = createTurnLock({ store, limit: 2, pollMs: 10, acquireTimeoutMs: 5_000 })

  const a = await lock.acquire("sa")
  const b = await lock.acquire("sb")
  assert.equal(a.granted, true)
  assert.equal(a.waited, false)
  assert.equal(b.granted, true)
  assert.equal(b.waited, false)

  let third: AcquireResult | undefined
  const pending = lock.acquire("sc").then((result) => {
    third = result
    return result
  })

  await wait(120)
  assert.equal(third, undefined, "the third session must not be admitted while 2 are held")
  assert.deepEqual(ids(store), ["sa", "sb"])
  assert.equal(lock.snapshot().leases.length, 2)

  lock.release("sa", "idle")
  const c = await pending
  assert.equal(c.granted, true)
  assert.equal(c.waited, true)
  assert.deepEqual(ids(store), ["sb", "sc"])
})

test("a re-acquire by the holder is free (one lease per session, not per model call)", async () => {
  const store = memoryStore()
  const lock = createTurnLock({ store, limit: 2, pollMs: 10 })
  await lock.acquire("sa")
  const again = await lock.acquire("sa")
  assert.equal(again.granted, true)
  assert.equal(again.waited, false)
  assert.deepEqual(ids(store), ["sa"])
})

test("release is idempotent and every reason frees the slot", async () => {
  const store = memoryStore()
  const lock = createTurnLock({ store, limit: 1, pollMs: 10, acquireTimeoutMs: 5_000 })

  for (const reason of ["idle", "succeeded", "failed", "interrupted", "deleted", "form", "permission"]) {
    await lock.acquire("holder")
    const pending = lock.acquire("waiter")
    await wait(40)
    assert.equal(store.list().length, 1, `${reason}: one slot is held`)
    lock.release("holder", reason)
    const granted = await pending
    assert.equal(granted.granted, true, `${reason}: waiter takes the freed slot`)
    lock.release("waiter", "idle")
  }

  // releasing a session without a lease is a no-op, not an error
  lock.release("ghost", "idle")
  assert.equal(store.list().length, 0)
})

test("timeout with onTimeout=proceed fails open with an over-limit lease", async () => {
  const store = memoryStore()
  const lock = createTurnLock({ store, limit: 1, pollMs: 10, acquireTimeoutMs: 80, onTimeout: "proceed" })
  await lock.acquire("holder")

  const started = Date.now()
  const result = await lock.acquire("blocked")
  assert.equal(result.granted, true)
  assert.equal(result.overLimit, true)
  assert.ok(Date.now() - started >= 70, "must wait for the timeout first")
  assert.equal(store.list().length, 2)
  assert.equal(store.read("blocked")?.over, true)
})

test("timeout with onTimeout=hold keeps waiting until a slot frees", async () => {
  const store = memoryStore()
  const lock = createTurnLock({ store, limit: 1, pollMs: 10, acquireTimeoutMs: 60, onTimeout: "hold" })
  await lock.acquire("holder")

  let result: AcquireResult | undefined
  const pending = lock.acquire("blocked").then((value) => {
    result = value
    return value
  })

  await wait(200)
  assert.equal(result, undefined, "hold must not fail open")
  assert.equal(store.list().length, 1)

  lock.release("holder", "idle")
  const granted = await pending
  assert.equal(granted.granted, true)
  assert.equal(granted.overLimit, false)
  assert.deepEqual(ids(store), ["blocked"])
})

test("a lease without refresh expires and stops blocking the queue", async () => {
  const store = memoryStore()
  const now = Date.now()
  store.write({ sid: "abandoned", since: now - 120_000, seen: now - 120_000, pid: 999_999 })
  const lock = createTurnLock({ store, limit: 1, pollMs: 10, leaseTimeoutMs: 1_000 })

  const result = await lock.acquire("fresh")
  assert.equal(result.granted, true)
  assert.deepEqual(ids(store), ["fresh"])
})

test("refresh keeps a lease alive past leaseTimeoutMs", async () => {
  const store = memoryStore()
  const lock = createTurnLock({ store, limit: 1, pollMs: 10, leaseTimeoutMs: 300 })
  await lock.acquire("long")

  for (let index = 0; index < 5; index += 1) {
    await wait(80)
    lock.refresh("long")
  }
  const snapshot = lock.snapshot()
  assert.deepEqual(
    snapshot.leases.map((lease) => lease.sid),
    ["long"],
  )
})

test("cancelWait stops a waiter without granting it, and does not poison its next acquire", async () => {
  const store = memoryStore()
  const lock = createTurnLock({ store, limit: 1, pollMs: 10, cancelTtlMs: 60, acquireTimeoutMs: 5_000 })
  await lock.acquire("holder")

  const pending = lock.acquire("blocked")
  await wait(50)
  lock.cancelWait("blocked", "interrupted")
  const cancelled = await pending
  assert.equal(cancelled.granted, false)
  assert.equal(cancelled.reason, "cancelled")
  assert.equal(store.read("blocked"), undefined)

  await wait(90) // cancel flag TTL passed
  lock.release("holder", "idle")
  const retry = await lock.acquire("blocked")
  assert.equal(retry.granted, true)
})

test("two lock instances over one store enforce a single shared limit", async () => {
  const store = memoryStore()
  const lockA = createTurnLock({ store, limit: 2, pollMs: 10, pid: 111, acquireTimeoutMs: 5_000 })
  const lockB = createTurnLock({ store, limit: 2, pollMs: 10, pid: 222, acquireTimeoutMs: 5_000 })

  const a1 = await lockA.acquire("a1")
  const b1 = await lockB.acquire("b1")
  assert.equal(a1.granted, true)
  assert.equal(b1.granted, true)

  let b2: AcquireResult | undefined
  const pending = lockB.acquire("b2").then((result) => {
    b2 = result
    return result
  })
  await wait(120)
  assert.equal(b2, undefined, "instance B sees instance A's lease")
  assert.equal(store.list().length, 2)

  lockA.release("a1", "idle")
  const granted = await pending
  assert.equal(granted.granted, true)
  assert.deepEqual(ids(store), ["b1", "b2"])
})

test("simultaneous acquires across instances never exceed the limit", async () => {
  const store = memoryStore()
  const lockA = createTurnLock({ store, limit: 1, pollMs: 5, acquireTimeoutMs: 5_000 })
  const lockB = createTurnLock({ store, limit: 1, pollMs: 5, acquireTimeoutMs: 5_000 })

  const pendingA = lockA.acquire("a")
  const pendingB = lockB.acquire("b")
  await wait(100)
  assert.ok(store.list().length <= 1, `store holds ${store.list().length} leases with limit 1`)

  lockA.cancelWait("a", "test")
  lockB.cancelWait("b", "test")
  const [resultA, resultB] = await Promise.all([pendingA, pendingB])
  assert.equal(Number(resultA.granted) + Number(resultB.granted), 1, "exactly one writer wins")

  lockA.release("a", "test")
  lockB.release("b", "test")
  assert.equal(store.list().length, 0)
})
