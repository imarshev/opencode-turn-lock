// Tests for the inbox view (src/inbox.ts): the order the rows get and the badge
// that is drawn on them. The DOM is a small fake that mirrors the client's
// markup: a flex row whose first child is the project/time line, a title span
// with `dir="auto"`, and a scroll box inside `data-slot=sidebar-inbox-working`.
// Run: node --test "tests/*.test.ts"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { applyInboxView, BADGE_CLASS, inboxLevel, type InboxRowData } from "../src/inbox.ts"

type Fake = {
  children: Fake[]
  parent?: Fake
  style: Record<string, string>
  dataset: Record<string, string>
  className: string
  innerHTML: string
  title: string
  textContent: string
  onclick?: (event: unknown) => void
  tagName: string
  ownerDocument?: FakeDocument
  firstElementChild?: Fake
  lastElementChild?: Fake
  appendChild: (child: Fake) => void
  insertBefore: (child: Fake, before?: Fake | null) => void
  remove: () => void
  setAttribute: (name: string, value: string) => void
  querySelector: (selector: string) => Fake | null
  querySelectorAll: (selector: string) => Fake[]
}

type FakeDocument = {
  head: Fake
  documentElement: Fake
  styles: Fake[]
  createElement: (tag: string) => Fake
  querySelector: (selector: string) => Fake | null
}

function node(props: Partial<Fake> = {}): Fake {
  const value: Fake = {
    children: [],
    style: {},
    dataset: {},
    className: "",
    innerHTML: "",
    title: "",
    textContent: "",
    tagName: "DIV",
    appendChild(child) {
      child.parent = value
      value.children.push(child)
    },
    insertBefore(child, before) {
      const index = before ? value.children.indexOf(before) : -1
      child.parent = value
      if (index >= 0) value.children.splice(index, 0, child)
      else value.children.push(child)
    },
    remove() {
      const parent = value.parent
      if (parent) parent.children.splice(parent.children.indexOf(value), 1)
      value.parent = undefined
    },
    setAttribute() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    ...props,
  }
  Object.defineProperty(value, "firstElementChild", { get: () => value.children[0] })
  Object.defineProperty(value, "lastElementChild", { get: () => value.children[value.children.length - 1] })
  return value
}

function document(): FakeDocument {
  const head = node()
  const doc: FakeDocument = {
    head,
    documentElement: head,
    styles: [],
    createElement(tag) {
      return node({ tagName: tag.toUpperCase() })
    },
    querySelector(selector) {
      return selector === "style[data-turn-lock]" ? (doc.styles[0] ?? null) : null
    },
  }
  const create = doc.createElement.bind(doc)
  doc.createElement = (tag) => {
    const element = create(tag)
    if (tag === "style") doc.styles.push(element)
    return element
  }
  return doc
}

function row(doc: FakeDocument, title: string): Fake {
  const time = node({ textContent: "26m" })
  const header = node()
  header.appendChild(time)
  const titleSpan = node({ textContent: title })
  const element = node({ ownerDocument: doc })
  element.appendChild(header)
  element.appendChild(titleSpan)
  element.querySelector = (selector) => (selector === 'span[dir="auto"]' ? titleSpan : null)
  return element
}

function mount(rows: Fake[]): { root: Fake; section: Fake } {
  const section = node()
  section.querySelectorAll = (selector) =>
    selector === '[data-slot="sidebar-inbox-item"]' ? rows : []
  const root = node()
  root.querySelector = (selector) =>
    selector === '[data-slot="sidebar-inbox-working"]' ? section : null
  return { root, section }
}

const state = (level: "high" | "normal" | "low", extra: Record<string, unknown> = {}) => ({ level, ...extra })

test("the level from a title is still readable (fallback path)", () => {
  assert.equal(inboxLevel("⚡ Поправить отчёт"), "high")
  assert.equal(inboxLevel("▽ Черновик"), "low")
  assert.equal(inboxLevel("Поправить отчёт"), "normal")
  assert.equal(inboxLevel("⚡ ⏳ 2/5 · 26m · Поправить отчёт"), "high")
})

test("rows are ordered by metadata: cloud, level, queue place, then the client's order", () => {
  const doc = document()
  const low = row(doc, "low")
  const highTwo = row(doc, "high 2/5")
  const highOne = row(doc, "high 1/5")
  const ordinary = row(doc, "ordinary")
  const cloud = row(doc, "cloud")
  const { root } = mount([low, highTwo, highOne, ordinary, cloud])

  const rows: InboxRowData[] = [
    { title: "low", state: state("low") },
    { title: "high 2/5", state: state("high", { position: 2, total: 5 }) },
    { title: "high 1/5", state: state("high", { position: 1, total: 5 }) },
    { title: "ordinary", state: state("normal") },
    { title: "cloud", state: state("low", { cloud: true }) },
  ]

  assert.equal(applyInboxView(root as unknown as ParentNode, rows), true)
  const order = (element: Fake) => Number(element.style.order)
  assert.ok(order(cloud) < order(highOne), "cloud goes above every priority")
  assert.ok(order(highOne) < order(highTwo), "waiters go 1/5 before 2/5")
  assert.ok(order(highTwo) < order(ordinary), "high goes before ordinary")
  assert.ok(order(ordinary) < order(low), "ordinary goes before low")
})

test("a waiting row shows how long it waits, in words and without a title change", () => {
  const doc = document()
  const waiting = row(doc, "waiting")
  const lonely = row(doc, "lonely")
  const { root } = mount([waiting, lonely])

  const since = 1_700_000_000_000
  const now = since + 2 * 3_600_000 + 5 * 60_000
  const rows: InboxRowData[] = [
    { title: "waiting", state: { level: "normal", position: 2, total: 5, since } },
    // A wait without a place still has something to say: the clock.
    { title: "lonely", state: { level: "normal", since } },
  ]

  assert.equal(applyInboxView(root as unknown as ParentNode, rows, undefined, now), true)
  const badgeOf = (element: Fake) => element.firstElementChild?.children.find((child) => child.className === BADGE_CLASS)

  const badge = badgeOf(waiting)
  assert.ok(badge, "a waiting row is badged even at the ordinary level")
  assert.match(badge.innerHTML, /tl-wait/)
  assert.match(badge.innerHTML, /2 ч 5 мин/)
  assert.match(badge.title, /ждёт 2 часа 5 минут/)
  assert.match(badge.title, /2\/5 в очереди/)
  assert.ok(badgeOf(lonely), "the wait alone is enough for a badge")

  // The label is derived from `since`, so the next pass ticks it without a
  // server write and without a new state object.
  applyInboxView(root as unknown as ParentNode, rows, undefined, now + 60_000)
  assert.match(badgeOf(waiting)!.innerHTML, /2 ч 6 мин/)

  // English, when the interface is English.
  applyInboxView(root as unknown as ParentNode, rows, undefined, now, "en")
  assert.match(badgeOf(waiting)!.innerHTML, /2 h 5 min/)
  assert.match(badgeOf(waiting)!.title, /waiting 2 h 5 min/)
})

test("a badge is drawn only where there is something to say", () => {
  const doc = document()
  const high = row(doc, "high")
  const ordinary = row(doc, "ordinary")
  const cloud = row(doc, "cloud")
  const { root } = mount([high, ordinary, cloud])

  const rows: InboxRowData[] = [
    { id: "ses_high", title: "high", state: state("high", { position: 2, total: 5 }) },
    { id: "ses_ordinary", title: "ordinary", state: state("normal") },
    { id: "ses_cloud", title: "cloud", state: state("normal", { cloud: true }) },
  ]

  const clicked: string[] = []
  applyInboxView(root as unknown as ParentNode, rows, (entry) => clicked.push(entry.id ?? ""))

  const badgeOf = (element: Fake) => element.firstElementChild?.children.find((child) => child.className === BADGE_CLASS)
  const highBadge = badgeOf(high)
  assert.ok(highBadge, "the high row has a badge")
  assert.equal(highBadge.dataset.level, "high")
  assert.match(highBadge.innerHTML, /2\/5/)
  assert.match(highBadge.title, /высокий приоритет/)
  assert.match(highBadge.title, /2\/5 в очереди/)

  assert.equal(badgeOf(ordinary), undefined, "an ordinary row without a place stays clean")

  const cloudBadge = badgeOf(cloud)
  assert.ok(cloudBadge)
  assert.equal(cloudBadge.dataset.cloud, "true")
  assert.match(cloudBadge.title, /облачная модель/)

  highBadge.onclick?.({ preventDefault() {}, stopPropagation() {} })
  assert.deepEqual(clicked, ["ses_high"])

  // Clearing the state removes the badge again.
  applyInboxView(root as unknown as ParentNode, [{ id: "ses_high", title: "high", state: state("normal") }])
  assert.equal(badgeOf(high), undefined)
})

test("the view tolerates a section without rows and a missing section", () => {
  const doc = document()
  const { root } = mount([])
  assert.equal(applyInboxView(root as unknown as ParentNode, []), false)
  assert.equal(applyInboxView(node() as unknown as ParentNode, []), false)
  assert.equal(doc.styles.length, 0, "nothing is injected when there is nothing to draw")
})

test("the Tampermonkey script reads the same metadata and draws the same badge", () => {
  const source = readFileSync(new URL("../userscript/turn-lock-prio.user.js", import.meta.url), "utf8")

  assert.match(source, /const INBOX_UI = true/)
  assert.match(source, /data-slot="sidebar-inbox-working"/)
  assert.match(source, /data-slot="sidebar-inbox-item"/)
  assert.match(source, /span\[dir="auto"\]/)
  assert.match(source, /tl-badge/)
  assert.match(source, /\/api\/session/)
  assert.match(source, /metadata/)
})
