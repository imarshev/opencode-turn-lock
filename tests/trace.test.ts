// Unit tests for src/trace.ts — the daily JSON-lines decision trace.
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { createTrace, dayKey } from "../src/trace.ts"

const DAY = 24 * 60 * 60_000

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "turn-lock-trace-"))
}

test("trace: writes one JSON line per event, with the base fields", () => {
  const dir = tempDir()
  try {
    const trace = createTrace({
      dir,
      now: () => 1_800_000_000_000,
      base: { pid: 42, owner: "F:\\work" },
    })
    trace.write("release", { sid: "ses_a", reason: "step" })
    trace.write("grant", { sid: "ses_b" })

    const file = join(dir, `lock-${dayKey(1_800_000_000_000)}.jsonl`)
    assert.ok(existsSync(file), "the day file exists")
    const lines = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line))
    assert.equal(lines.length, 2)
    assert.deepEqual(lines[0], {
      t: new Date(1_800_000_000_000).toISOString(),
      ms: 1_800_000_000_000,
      pid: 42,
      owner: "F:\\work",
      ev: "release",
      sid: "ses_a",
      reason: "step",
    })
    assert.equal(lines[1].ev, "grant")
    assert.equal(lines[1].sid, "ses_b")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("trace: rotates to a new file when the local day changes", () => {
  const dir = tempDir()
  try {
    let now = 1_800_000_000_000
    const trace = createTrace({ dir, keepMs: 0, now: () => now })
    trace.write("boot")
    now += DAY
    trace.write("boot")
    const files = readdirSync(dir).filter((name) => name.endsWith(".jsonl")).sort()
    assert.equal(files.length, 2, `two day files: ${files.join(", ")}`)
    assert.equal(trace.file(), join(dir, files[1]))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("trace: deletes files older than the retention window and keeps the fresh one", () => {
  const dir = tempDir()
  try {
    const now = Date.now()
    const old = join(dir, "lock-2020-01-01.jsonl")
    const fresh = join(dir, "lock-2020-01-02.jsonl")
    const foreign = join(dir, "notes.jsonl")
    for (const file of [old, fresh, foreign]) writeFileSync(file, "{}\n", "utf8")
    const longAgo = (now - 2 * DAY) / 1000
    utimesSync(old, longAgo, longAgo)
    utimesSync(foreign, longAgo, longAgo)

    const trace = createTrace({ dir, keepMs: DAY, now: () => now })
    trace.write("boot")

    assert.equal(existsSync(old), false, "the expired day file is gone")
    assert.equal(existsSync(fresh), true, "the file inside the window stays")
    assert.equal(existsSync(foreign), true, "files that are not ours are left alone")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("trace: keepMs 0 never prunes", () => {
  const dir = tempDir()
  try {
    const now = Date.now()
    const old = join(dir, "lock-2020-01-01.jsonl")
    writeFileSync(old, "{}\n", "utf8")
    const longAgo = (now - 30 * DAY) / 1000
    utimesSync(old, longAgo, longAgo)

    const trace = createTrace({ dir, keepMs: 0, now: () => now })
    trace.write("boot")
    assert.equal(existsSync(old), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("trace: disabled writes nothing and reports no file", () => {
  const dir = tempDir()
  try {
    const trace = createTrace({ dir, enabled: false })
    assert.equal(trace.on, false)
    trace.write("boot")
    assert.equal(existsSync(dir) ? readdirSync(dir).length : 0, 0)
    assert.equal(trace.file(), "")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("trace: a payload field cannot overwrite the envelope", () => {
  const dir = tempDir()
  try {
    const at = 1_800_000_000_000
    const trace = createTrace({ dir, now: () => at })
    // A handoff duration used to be written as `ms` and clobbered the
    // timestamp; the envelope must win.
    trace.write("handoff.arm", { sid: "ses_a", delayMs: 1000, ms: 1000, ev: "fake", t: "fake" })
    const file = join(dir, `lock-${dayKey(at)}.jsonl`)
    const line = JSON.parse(readFileSync(file, "utf8").trim())
    assert.equal(line.ms, at)
    assert.equal(line.ev, "handoff.arm")
    assert.equal(line.t, new Date(at).toISOString())
    assert.equal(line.delayMs, 1000)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("trace: dayKey is the local calendar day", () => {
  const at = new Date(2026, 10, 7, 1, 30, 0).getTime()
  assert.equal(dayKey(at), "2026-11-07")
})
