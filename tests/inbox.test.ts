// Tests for the inbox sorter (src/inbox.ts) and the userscript half that
// mirrors it. The sorter is deliberately tiny: the priority is already in the
// session title, so the only thing to get right is the rank and a stable
// secondary order.
// Run: node --test "tests/*.test.ts"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { applyInboxSort, inboxLevel, inboxOrder, sortInboxRows } from "../src/inbox.ts"

test("the mark in the title is the level, including a waiting prefix", () => {
  assert.equal(inboxLevel("⚡ Поправить отчёт"), "high")
  assert.equal(inboxLevel("▽ Черновик"), "low")
  assert.equal(inboxLevel("Поправить отчёт"), "normal")
  assert.equal(inboxLevel("⚡ ⏳ 2/3 · 26m · Поправить отчёт"), "high")
  assert.equal(inboxLevel("▽ ⏳ 3/3 · 26m · Черновик"), "low")
  assert.equal(inboxLevel("⏳ 2/3 · 26m · Поправить отчёт"), "normal")
  assert.equal(inboxLevel(undefined), "normal")
})

test("high goes first, low goes last, and the current order survives inside a level", () => {
  const rows = [
    { title: "▽ low" },
    { title: "⚡ high #1" },
    { title: "ordinary" },
    { title: "⚡ high #2" },
  ]

  assert.deepEqual(
    sortInboxRows(rows).map((row) => row.title),
    ["⚡ high #1", "⚡ high #2", "ordinary", "▽ low"],
  )
  assert.ok(inboxOrder("⚡ x", 100) < inboxOrder("x", 0))
  assert.ok(inboxOrder("x", 0) < inboxOrder("▽ x", 0))
})

test("applyInboxSort writes CSS order to the working rows only", () => {
  const row = (title: string) => ({
    style: { order: "" },
    querySelector: (selector: string) =>
      selector === 'span[dir="auto"]' ? { textContent: title } : null,
  })

  const rows = [row("▽ low"), row("⚡ high"), row("ordinary")]
  const section = {
    querySelectorAll: (selector: string) =>
      selector === '[data-slot="sidebar-inbox-item"]' ? rows : [],
  }
  const root = {
    querySelector: (selector: string) =>
      selector === '[data-slot="sidebar-inbox-working"]' ? section : null,
  }

  assert.equal(applyInboxSort(root as unknown as ParentNode), true)
  const orders = rows.map((entry) => Number(entry.style.order))
  assert.ok(orders[1] < orders[2] && orders[2] < orders[0], `high < ordinary < low: ${orders}`)
  assert.equal(applyInboxSort(root as unknown as ParentNode), false, "a second pass changes nothing")
})

test("the Tampermonkey script sorts the same rows by the same marks", () => {
  const source = readFileSync(new URL("../userscript/turn-lock-prio.user.js", import.meta.url), "utf8")

  assert.match(source, /const SORT_WORKING = true/)
  assert.match(source, /data-slot="sidebar-inbox-working"/)
  assert.match(source, /data-slot="sidebar-inbox-item"/)
  assert.match(source, /span\[dir="auto"\]/)
  assert.match(source, /const inboxOrder = \(title, index\)/)
})
