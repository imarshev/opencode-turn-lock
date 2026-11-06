// Tests for the priority vocabulary and the queue order (src/priority.ts): the
// rank of each level, the mark it carries, the one-click cycle, the `/prio`
// argument, and the order two waiters are served in.
// Run: node --test "tests/*.test.ts"
import assert from "node:assert/strict"
import test from "node:test"

import {
  aheadInLevel,
  compareQueue,
  isLevel,
  LEVEL_CYCLE,
  LEVEL_RANK,
  LEVELS,
  levelEntry,
  LOW_MARK,
  markFor,
  nextLevel,
  outranking,
  parsePriorityArgument,
  PRIORITY_MARK,
  PRIORITY_RANK,
  toggleLevel,
  type PriorityLevel,
  type QueueEntry,
} from "../src/priority.ts"

const entry = (sid: string, level: PriorityLevel, age: number): QueueEntry => levelEntry(sid, level, age)

test("levels: the rank and the visual order are inverses", () => {
  assert.deepEqual(LEVELS, ["low", "normal", "high"])
  assert.deepEqual(PRIORITY_RANK, { low: 0, normal: 1, high: 2 })
  assert.deepEqual(LEVEL_RANK, { high: 0, normal: 1, low: 2 })
  for (const level of LEVELS) {
    assert.equal(PRIORITY_RANK[level] + LEVEL_RANK[level], PRIORITY_RANK.high, `${level} is ranked once`)
  }
})

test("levels: only the three names are levels, and each carries its mark", () => {
  assert.deepEqual(LEVELS.filter(isLevel), ["low", "normal", "high"])
  assert.equal(isLevel("HIGH"), false)
  assert.equal(isLevel("urgent"), false)
  assert.equal(isLevel(2), false)
  assert.equal(isLevel(undefined), false)

  assert.equal(markFor("high"), PRIORITY_MARK)
  assert.equal(markFor("low"), LOW_MARK)
  assert.equal(markFor("normal"), "")
})

test("one click cycles ordinary → high → low → ordinary; a bare /prio toggles high", () => {
  assert.deepEqual(LEVEL_CYCLE, { normal: "high", high: "low", low: "normal" })
  assert.equal(nextLevel("normal"), "high")
  assert.equal(nextLevel("high"), "low")
  assert.equal(nextLevel("low"), "normal")

  assert.equal(toggleLevel("normal"), "high")
  assert.equal(toggleLevel("low"), "high")
  assert.equal(toggleLevel("high"), "normal")
})

test("the command argument survives both shapes a client may send", () => {
  assert.equal(parsePriorityArgument("", "prio"), "toggle")
  assert.equal(parsePriorityArgument("  ", "prio"), "toggle")
  assert.equal(parsePriorityArgument("on", "prio"), "high")
  assert.equal(parsePriorityArgument("OFF", "prio"), "normal")
  assert.equal(parsePriorityArgument("remove", "prio"), "normal")
  assert.equal(parsePriorityArgument("normal", "prio"), "normal")
  assert.equal(parsePriorityArgument("low", "prio"), "low")
  assert.equal(parsePriorityArgument("DOWN", "prio"), "low")
  assert.equal(parsePriorityArgument("high", "prio"), "high")
  assert.equal(parsePriorityArgument("anything else", "prio"), "toggle")
  // a client that hands over the whole line instead of only the arguments
  assert.equal(parsePriorityArgument("/prio", "prio"), "toggle")
  assert.equal(parsePriorityArgument("prio", "prio"), "toggle")
  assert.equal(parsePriorityArgument("/prio off", "prio"), "normal")
  assert.equal(parsePriorityArgument("  /PRIO low ", "prio"), "low")
  assert.equal(parsePriorityArgument("/prio HIGH", "prio"), "high")
})

test("the queue is ordered by rank, then age, then id", () => {
  const queue = [
    entry("ses_late", "high", 20),
    entry("ses_low", "low", 1),
    entry("ses_early", "high", 10),
    entry("ses_normal", "normal", 5),
    entry("ses_b", "normal", 5),
    entry("ses_a", "normal", 5),
  ].sort(compareQueue)

  assert.deepEqual(
    queue.map((item) => item.sid),
    ["ses_early", "ses_late", "ses_a", "ses_b", "ses_normal", "ses_low"],
  )
})

test("outranking: strictly better levels only, never the session itself", () => {
  const waiters = [
    entry("ses_1", "high", 1),
    entry("ses_2", "normal", 2),
    entry("ses_3", "low", 3),
  ]
  assert.deepEqual(
    outranking(waiters, "ses_2", PRIORITY_RANK.normal).map((item) => item.sid),
    ["ses_1"],
  )
  assert.deepEqual(outranking(waiters, "ses_1", PRIORITY_RANK.high), [])
  assert.deepEqual(
    outranking(waiters, "ses_3", PRIORITY_RANK.low).map((item) => item.sid),
    ["ses_1", "ses_2"],
  )
})

test("aheadInLevel: only the same level, and only a strictly earlier place", () => {
  const self = entry("ses_2", "normal", 10)
  const waiters = [
    entry("ses_1", "normal", 5), // older: ahead
    entry("ses_3", "normal", 10), // same age, bigger id: behind
    entry("ses_0", "normal", 10), // same age, smaller id: ahead
    entry("ses_9", "high", 1), // better level: not an in-level place
    entry("ses_8", "normal", 15), // younger: behind
    entry("ses_2", "normal", 10), // itself
  ]
  assert.deepEqual(
    aheadInLevel(waiters, self).map((item) => item.sid),
    ["ses_1", "ses_0"],
  )
  assert.deepEqual(aheadInLevel([], self), [])
})
