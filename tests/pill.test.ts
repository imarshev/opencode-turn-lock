import assert from "node:assert/strict"
import test from "node:test"

import { answerFrom, pillVisible } from "../src/pill.ts"

// The regression this file exists for: the pill used to require a *confirmed*
// /prio, so a probe that failed while the app was still starting its sidecar
// took the control away from that directory until the window was reopened.
test("an unanswered probe shows the pill: an unreachable server hides nothing", () => {
  assert.equal(pillVisible({ enabled: true, answer: "unknown", child: false }), true)
})

test("a command list without the command hides the pill", () => {
  assert.equal(pillVisible({ enabled: true, answer: "missing", child: false }), false)
})

test("a command list with the command shows the pill", () => {
  assert.equal(pillVisible({ enabled: true, answer: "present", child: false }), true)
})

test("a subagent session gets no pill, and a turned-off priority gets none at all", () => {
  assert.equal(pillVisible({ enabled: true, answer: "present", child: true }), false)
  assert.equal(pillVisible({ enabled: false, answer: "present", child: false }), false)
})

test("answerFrom reads the command out of a command list", () => {
  assert.equal(answerFrom(["init", "prio", "review"], "prio"), "present")
  assert.equal(answerFrom(["init", undefined], "prio"), "missing")
  assert.equal(answerFrom([], "prio"), "missing")
  assert.equal(answerFrom(["prio-two"], "prio"), "missing")
})
