// Tests for the priority flag sidecar (src/priority-store.ts): the file that
// records where the user wants a session to stand, its legacy shapes, the TTL,
// and the rule that a subagent inherits its root's level.
// Run: node --test "tests/*.test.ts"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import test from "node:test"

import { createPriorityFlags, type PriorityFlagsOptions } from "../src/priority-store.ts"

function setup(options: Partial<PriorityFlagsOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "turn-lock-prio-"))
  let clock = 1_000
  const flags = createPriorityFlags({
    dir,
    ttlMs: 60_000,
    enabled: true,
    owner: "test-owner",
    now: () => clock,
    ...options,
  })
  return {
    dir,
    flags,
    advance: (ms: number) => {
      clock += ms
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

test("a flag round-trips through the sidecar with its level, age and owner", () => {
  const harness = setup()
  try {
    harness.flags.write("ses_1", "high")
    assert.equal(existsSync(harness.flags.path("ses_1")), true)
    assert.deepEqual(harness.flags.read("ses_1"), { level: "high", since: 1_000 })
    assert.equal(harness.flags.levelOf("ses_1"), "high")
    assert.equal(harness.flags.rankOf("ses_1"), 2)

    const raw = JSON.parse(readFileSync(harness.flags.path("ses_1"), "utf8"))
    assert.deepEqual(raw, { sid: "ses_1", pid: process.pid, owner: "test-owner", since: 1_000, level: "high" })
  } finally {
    harness.cleanup()
  }
})

test("ordinary is the absence of a flag: writing normal removes the file", () => {
  const harness = setup()
  try {
    harness.flags.write("ses_1", "low")
    assert.equal(harness.flags.levelOf("ses_1"), "low")
    assert.equal(harness.flags.rankOf("ses_1"), 0)

    harness.flags.write("ses_1", "normal")
    assert.equal(existsSync(harness.flags.path("ses_1")), false)
    assert.equal(harness.flags.read("ses_1"), undefined)
    assert.equal(harness.flags.levelOf("ses_1"), "normal")
    assert.equal(harness.flags.rankOf("ses_1"), 1)
  } finally {
    harness.cleanup()
  }
})

test("a file written before levels existed still means high", () => {
  const harness = setup()
  try {
    // the shape 0.1 wrote: no `level` field at all
    writeFileSync(
      join(harness.dir, "ses_legacy.prio.json"),
      JSON.stringify({ sid: "ses_legacy", pid: process.pid, since: 500 }),
    )
    assert.deepEqual(harness.flags.read("ses_legacy"), { level: "high", since: 500 })
  } finally {
    harness.cleanup()
  }
})

test("a stale file that says normal is dropped instead of counting", () => {
  const harness = setup()
  try {
    writeFileSync(
      join(harness.dir, "ses_1.prio.json"),
      JSON.stringify({ sid: "ses_1", pid: process.pid, since: 500, level: "normal" }),
    )
    assert.equal(harness.flags.read("ses_1"), undefined)
    assert.equal(existsSync(join(harness.dir, "ses_1.prio.json")), false)
  } finally {
    harness.cleanup()
  }
})

test("a flag older than the TTL expires and is removed", () => {
  const harness = setup({ ttlMs: 10_000 })
  try {
    harness.flags.write("ses_1", "high")
    harness.advance(9_000)
    assert.equal(harness.flags.levelOf("ses_1"), "high")
    harness.advance(2_000)
    assert.equal(harness.flags.read("ses_1"), undefined)
    assert.equal(existsSync(harness.flags.path("ses_1")), false)
  } finally {
    harness.cleanup()
  }
})

test("priority off reads nothing, even when a file is there", () => {
  const harness = setup({ enabled: false })
  try {
    writeFileSync(
      join(harness.dir, "ses_1.prio.json"),
      JSON.stringify({ sid: "ses_1", pid: process.pid, since: 500, level: "high" }),
    )
    assert.equal(harness.flags.read("ses_1"), undefined)
    assert.equal(harness.flags.levelOf("ses_1"), "normal")
  } finally {
    harness.cleanup()
  }
})

test("a subagent queues at its root's level, not its own", () => {
  const harness = setup({ rootOf: (sid) => (sid === "ses_child" ? "ses_root" : undefined) })
  try {
    harness.flags.write("ses_root", "high")
    harness.flags.write("ses_child", "low")
    assert.equal(harness.flags.levelOf("ses_root"), "high")
    assert.equal(harness.flags.levelOf("ses_child"), "high", "the root's flag wins")
    assert.equal(harness.flags.rankOf("ses_child"), 2)

    // The root's flag disappears: the child's own flag is not consulted either,
    // because the root is known and ordinary means "no flag".
    harness.flags.write("ses_root", "normal")
    assert.equal(harness.flags.levelOf("ses_child"), "normal")
  } finally {
    harness.cleanup()
  }
})

test("a missing, corrupt or timeless file reads as no flag", () => {
  const harness = setup()
  try {
    assert.equal(harness.flags.read("ses_missing"), undefined)
    writeFileSync(join(harness.dir, "ses_bad.prio.json"), "{ not json")
    assert.equal(harness.flags.read("ses_bad"), undefined)
    writeFileSync(join(harness.dir, "ses_undated.prio.json"), JSON.stringify({ level: "high" }))
    assert.equal(harness.flags.read("ses_undated"), undefined)
  } finally {
    harness.cleanup()
  }
})

test("the sidecar name is sanitized, so a session id cannot escape the directory", () => {
  const harness = setup()
  try {
    const path = harness.flags.path("../../evil/id")
    assert.equal(basename(path).endsWith(".prio.json"), true)
    assert.equal(dirname(path), harness.dir, "the file stays inside the lock directory")
  } finally {
    harness.cleanup()
  }
})
