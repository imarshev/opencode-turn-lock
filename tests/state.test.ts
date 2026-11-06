// Tests for the shared queue state (src/state.ts): the metadata shape, the
// fallback for titles written by older versions, and the sort key both halves
// use.
// Run: node --test "tests/*.test.ts"
import assert from "node:assert/strict"
import test from "node:test"

import {
  compareOrder,
  orderRows,
  readState,
  rowOrder,
  stateFromTitle,
  STATE_KEY,
  waitLabel,
  waitSentence,
  withState,
  type TurnLockState,
} from "../src/state.ts"

test("metadata: a stored state round-trips, junk degrades to ordinary", () => {
  const state: TurnLockState = { level: "high", cloud: true, position: 2, total: 5, since: 1_700_000_000_000 }
  assert.deepEqual(readState(withState({}, state)), state)

  const holding: TurnLockState = { level: "normal", holding: 1_700_000_000_000 }
  assert.deepEqual(readState(withState({}, holding)), holding)

  assert.equal(readState(undefined), undefined)
  assert.equal(readState({}), undefined)
  assert.equal(readState({ [STATE_KEY]: "high" }), undefined)
  assert.deepEqual(readState({ [STATE_KEY]: { level: "nonsense" } }), { level: "normal" })
  assert.deepEqual(readState({ [STATE_KEY]: { level: "low", position: 9, total: 2 } }), { level: "low" })
  assert.deepEqual(readState({ [STATE_KEY]: { level: "normal", cloud: "yes" } }), { level: "normal" })
  assert.deepEqual(readState({ [STATE_KEY]: { level: "normal", holding: "soon" } }), { level: "normal" })
})

test("metadata: our key is written without touching the session's own keys", () => {
  const metadata = { experimental: { instructions: "keep me" } }
  const next = withState(metadata, { level: "low", position: 3, total: 4 })
  assert.deepEqual(next.experimental, { instructions: "keep me" })
  assert.deepEqual(next[STATE_KEY], { level: "low", position: 3, total: 4 })

  const cleared = withState(next, undefined)
  assert.deepEqual(cleared, { experimental: { instructions: "keep me" } })
})

test("a title from an older version still reads as a state", () => {
  assert.deepEqual(stateFromTitle("⚡ Поправить отчёт"), { level: "high" })
  assert.deepEqual(stateFromTitle("▽ Черновик"), { level: "low" })
  assert.deepEqual(stateFromTitle("⏳ 2/5 · 26m · Поправить отчёт"), { level: "normal", position: 2, total: 5 })
  assert.deepEqual(stateFromTitle("⚡ ⏳ 3/5 · 9m · Отчёт"), { level: "high", position: 3, total: 5 })
  assert.deepEqual(stateFromTitle("☁️ ⚡ ⏳ 1/4 · Отчёт"), { level: "high", cloud: true, position: 1, total: 4 })
  assert.deepEqual(stateFromTitle("☁️ Облачная сессия"), { level: "normal", cloud: true })
  assert.equal(stateFromTitle("Поправить отчёт"), undefined)
  assert.equal(stateFromTitle(undefined), undefined)
})

test("a wait reads as words, not as the old compact label", () => {
  assert.equal(waitLabel(0), "0 с")
  assert.equal(waitLabel(-5_000), "0 с", "a clock skew must not print a negative wait")
  assert.equal(waitLabel(42_000), "42 с")
  assert.equal(waitLabel(9 * 60_000), "9 мин")
  assert.equal(waitLabel(60 * 60_000), "1 ч")
  assert.equal(waitLabel(2 * 3_600_000 + 5 * 60_000), "2 ч 5 мин")
  assert.equal(waitLabel(9 * 60_000, "en"), "9 min")
  assert.equal(waitLabel(2 * 3_600_000 + 5 * 60_000, "en"), "2 h 5 min")

  assert.equal(waitSentence(30_000), "ждёт 30 секунд")
  assert.equal(waitSentence(60_000), "ждёт 1 минуту")
  assert.equal(waitSentence(2 * 60_000), "ждёт 2 минуты")
  assert.equal(waitSentence(5 * 60_000), "ждёт 5 минут")
  assert.equal(waitSentence(11 * 60_000), "ждёт 11 минут")
  assert.equal(waitSentence(21 * 60_000), "ждёт 21 минуту")
  assert.equal(waitSentence(3_600_000), "ждёт 1 час")
  assert.equal(waitSentence(2 * 3_600_000 + 5 * 60_000), "ждёт 2 часа 5 минут")
  assert.equal(waitSentence(90_000, "en"), "waiting 1 min")
})

test("cloud sessions come first, then the level, then the queue place", () => {
  const cloudLow: TurnLockState = { level: "low", cloud: true }
  const highWorking: TurnLockState = { level: "high" }
  const highWaiting2: TurnLockState = { level: "high", position: 2, total: 5 }
  const highWaiting1: TurnLockState = { level: "high", position: 1, total: 5 }
  const normal: TurnLockState = { level: "normal" }
  const low: TurnLockState = { level: "low" }

  assert.ok(compareOrder(rowOrder(cloudLow, "", 9), rowOrder(highWorking, "", 0)) < 0, "cloud beats high")
  assert.ok(compareOrder(rowOrder(highWorking, "", 9), rowOrder(normal, "", 0)) < 0, "high beats ordinary")
  assert.ok(compareOrder(rowOrder(normal, "", 9), rowOrder(low, "", 0)) < 0, "ordinary beats low")
  assert.ok(compareOrder(rowOrder(highWorking, "", 9), rowOrder(highWaiting1, "", 0)) < 0, "running beats waiting")
  assert.ok(
    compareOrder(rowOrder(highWaiting1, "", 9), rowOrder(highWaiting2, "", 0)) < 0,
    "waiters go 1/5 before 2/5",
  )
})

test("the title is the fallback when metadata is missing, and the index breaks ties", () => {
  const entries = [
    { title: "▽ low", index: 0 },
    { title: "⚡ ⏳ 2/5 · 26m · high #2", index: 1 },
    { title: "ordinary", index: 2 },
    { title: "⚡ high #1", index: 3 },
    { title: "⚡ ⏳ 1/5 · 26m · high #0", index: 4 },
  ]
  assert.deepEqual(
    orderRows(entries).map((entry) => entry.title),
    ["⚡ high #1", "⚡ ⏳ 1/5 · 26m · high #0", "⚡ ⏳ 2/5 · 26m · high #2", "ordinary", "▽ low"],
  )

  const withMetadata = [
    { title: "same", index: 0, state: { level: "low" as const } },
    { title: "same", index: 1, state: { level: "high" as const } },
    { title: "same", index: 2, state: { level: "high" as const, cloud: true } },
  ]
  assert.deepEqual(
    orderRows(withMetadata).map((entry) => entry.index),
    [2, 1, 0],
    "metadata wins over the title, and the index keeps equal rows in place",
  )
})
