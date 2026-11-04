// Unit tests for the filesystem lease store (src/store-file.ts).
import assert from "node:assert/strict"
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { createTurnLock } from "../src/core.ts"
import { fileStore, processAlive } from "../src/store-file.ts"

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "turn-lock-test-"))
}

test("write/read/list/remove round-trip through real files", () => {
  const dir = tempDir()
  try {
    const store = fileStore(dir)
    assert.deepEqual(store.list(), [])
    assert.equal(store.read("ses_missing"), undefined)

    const lease = { sid: "ses_a", since: 1.5, seen: 2, pid: 42, owner: "C:/work" }
    store.write(lease)
    assert.deepEqual(store.read("ses_a"), lease)
    assert.deepEqual(store.list(), [lease])

    store.write({ ...lease, seen: 3 }) // atomic replace, not append
    assert.equal(store.read("ses_a")?.seen, 3)

    store.remove("ses_a")
    assert.equal(store.read("ses_a"), undefined)
    assert.deepEqual(store.list(), [])
    store.remove("ses_a") // idempotent
    assert.equal(readdirSync(dir).filter((name) => name.endsWith(".tmp")).length, 0, "no temp files left")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a corrupt lease file is treated as absent and does not break list()", () => {
  const dir = tempDir()
  try {
    const store = fileStore(dir)
    writeFileSync(join(dir, "ses_bad.lease.json"), "{not json", "utf8")
    writeFileSync(join(dir, "ses_shape.lease.json"), JSON.stringify({ sid: "ses_shape" }), "utf8")
    writeFileSync(join(dir, "unrelated.txt"), "x", "utf8")
    assert.equal(store.read("ses_bad"), undefined)
    assert.equal(store.read("ses_shape"), undefined)
    assert.deepEqual(store.list(), [])

    store.write({ sid: "ses_bad", since: 1, seen: 1 })
    assert.deepEqual(store.read("ses_bad"), { sid: "ses_bad", since: 1, seen: 1 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("pruneDead drops leases of dead processes and keeps live ones", () => {
  const dir = tempDir()
  try {
    const store = fileStore(dir)
    store.write({ sid: "ses_dead", since: 1, seen: 1, pid: 999_999 })
    store.write({ sid: "ses_live", since: 1, seen: 1, pid: process.pid })

    const removed = store.pruneDead(processAlive)
    assert.deepEqual(removed, ["ses_dead"])
    assert.deepEqual(
      store.list().map((lease) => lease.sid),
      ["ses_live"],
    )
    assert.equal(processAlive(999_999), false)
    assert.equal(processAlive(process.pid), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("two lock instances on one directory share the limit (simulated two servers)", async () => {
  const dir = tempDir()
  try {
    const storeA = fileStore(dir)
    const storeB = fileStore(dir)
    const lockA = createTurnLock({ store: storeA, limit: 2, pollMs: 10, pid: 111, acquireTimeoutMs: 5_000 })
    const lockB = createTurnLock({ store: storeB, limit: 2, pollMs: 10, pid: 222, acquireTimeoutMs: 5_000 })

    await lockA.acquire("ses_a")
    await lockB.acquire("ses_b")

    let third: boolean | undefined
    const pending = lockB.acquire("ses_c").then((result) => {
      third = result.granted
      return result
    })
    await wait(120)
    assert.equal(third, undefined, "third session waits across instances")
    assert.equal(storeA.list().length, 2)

    lockA.release("ses_a", "idle")
    const granted = await pending
    assert.equal(granted.granted, true)
    assert.deepEqual(
      storeA
        .list()
        .map((lease) => lease.sid)
        .sort(),
      ["ses_b", "ses_c"],
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
