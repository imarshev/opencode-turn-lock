// Tests for the session status label (src/status.ts): what it says for a
// queued or a sending request, and how the patch on the host's markup is made
// and undone. The DOM is a small fake that mirrors the two nodes the module
// touches: the timeline's `session-working` row and the title's status dot.
// Run: node --test "tests/*.test.ts"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { applyWorkingStatus, startStatusView, STATUS_CLASS, STATUS_CSS, workingLabel } from "../src/status.ts"

type Fake = {
  children: Fake[]
  parent?: Fake
  attributes: Record<string, string>
  dataset: Record<string, string>
  style: Record<string, string>
  className: string
  textContent: string
  tagName: string
  ownerDocument?: FakeDocument
  querySelector: (selector: string) => Fake | null
  querySelectorAll: (selector: string) => Fake[]
  appendChild: (child: Fake) => void
  remove: () => void
  getAttribute: (name: string) => string | null
  setAttribute: (name: string, value: string) => void
  removeAttribute: (name: string) => void
  get parentNode(): Fake | undefined
  get firstElementChild(): Fake | undefined
}

type FakeDocument = {
  head: Fake
  documentElement: Fake
  styles: Fake[]
  createElement: (tag: string) => Fake
  querySelector: (selector: string) => Fake | null
}

function node(props: Partial<Fake> = {}): Fake {
  const value = {
    children: [] as Fake[],
    attributes: {} as Record<string, string>,
    dataset: {} as Record<string, string>,
    style: {} as Record<string, string>,
    className: "",
    textContent: "",
    tagName: "DIV",
    appendChild(child: Fake) {
      child.parent = value as unknown as Fake
      value.children.push(child)
    },
    remove() {
      const parent = value.parent
      if (parent) parent.children.splice(parent.children.indexOf(value as unknown as Fake), 1)
      value.parent = undefined
    },
    getAttribute(name: string) {
      return Object.prototype.hasOwnProperty.call(value.attributes, name) ? value.attributes[name] : null
    },
    setAttribute(name: string, text: string) {
      value.attributes[name] = text
    },
    removeAttribute(name: string) {
      delete value.attributes[name]
    },
    querySelector: () => null,
    querySelectorAll: () => [] as Fake[],
    ...props,
  } as unknown as Fake
  Object.defineProperty(value, "parentNode", { get: () => value.parent })
  Object.defineProperty(value, "firstElementChild", { get: () => value.children[0] })
  return value
}

function document(): FakeDocument {
  const head = node()
  const doc: FakeDocument = {
    head,
    documentElement: head,
    styles: [],
    createElement(tag) {
      const element = node({ tagName: tag.toUpperCase() })
      if (tag === "style") doc.styles.push(element)
      return element
    },
    querySelector(selector) {
      return selector === "style[data-turn-lock-status]" ? (doc.styles[0] ?? null) : null
    },
  }
  return doc
}

/** The host's timeline row: a status div whose only child is the word. */
function workingRow(doc: FakeDocument): { root: Fake; container: Fake; word: Fake } {
  const container = node({ ownerDocument: doc })
  const word = node({ textContent: "Работает" })
  container.appendChild(word)
  const root = node({ ownerDocument: doc })
  root.appendChild(container)
  root.querySelector = (selector) =>
    selector === '[data-component="session-working"]' || selector === "[data-component=session-working]"
      ? container
      : null
  return { root, container, word }
}

/** The title dot carries no text: only its accessible name says "Работает". */
function headerDot(doc: FakeDocument, root: Fake): Fake {
  const dot = node({ ownerDocument: doc, attributes: { "aria-label": "Работает" } })
  root.appendChild(dot)
  const inner = root.querySelector
  root.querySelector = (selector) =>
    selector === '[data-session-title] [role="status"][aria-label]' ? dot : inner(selector)
  return dot
}

const NOW = 1_700_000_000_000
const queued = { level: "normal" as const, phase: "queued" as const, position: 2, total: 5, since: NOW - 9 * 60_000 }

test("a queued request says where it stands and for how long", () => {
  const label = workingLabel(queued, NOW)
  assert.equal(label?.phase, "queued")
  assert.equal(label?.text, "⏳ В очереди · 2/5 · 9 мин")
  assert.equal(label?.spoken, "В очереди · 2/5 · 9 мин")
  assert.match(label?.title ?? "", /ждёт свободный слот локального движка/)
  assert.match(label?.title ?? "", /2\/5 в очереди/)
  assert.match(label?.title ?? "", /ждёт 9 минут/)

  assert.equal(workingLabel(queued, NOW, "en")?.text, "⏳ Queued · 2/5 · 9 min")
})

test("a granted request says the engine has it; nothing else is patched", () => {
  const label = workingLabel({ level: "normal", phase: "sending", holding: NOW }, NOW)
  assert.deepEqual(label, {
    phase: "sending",
    text: "▶ Отправлено в движок",
    spoken: "Отправлено в движок",
    title: "слот получен, ответ движка ещё не начал приходить",
  })
  assert.equal(workingLabel({ level: "normal", phase: "sending" }, NOW, "en")?.text, "▶ Sent to the engine")

  assert.equal(workingLabel(undefined, NOW), undefined, "no metadata: the host's word is true")
  assert.equal(workingLabel({ level: "normal" }, NOW), undefined, "not gated")
  assert.equal(workingLabel({ level: "high", cloud: true }, NOW), undefined, "a cloud session is never gated")
})

test("a state written before the field existed still reads as a phase", () => {
  assert.equal(workingLabel({ level: "normal", position: 1, total: 3 }, NOW)?.phase, "queued")
  assert.equal(workingLabel({ level: "normal", since: NOW }, NOW)?.phase, "queued")
  assert.equal(workingLabel({ level: "normal", holding: NOW }, NOW)?.phase, "sending")
})

test("the host's row is replaced for as long as the phase is known", () => {
  const doc = document()
  const { root, container, word } = workingRow(doc)

  assert.equal(applyWorkingStatus(root as unknown as ParentNode, queued, NOW), true)
  const own = container.children.find((child) => child.className === STATUS_CLASS)
  assert.ok(own, "our span is appended next to the host's word")
  assert.equal(own?.textContent, "⏳ В очереди · 2/5 · 9 мин")
  assert.equal(container.dataset.turnLockPhase, "queued")
  assert.match(container.attributes.title ?? "", /ждёт свободный слот/)
  assert.equal(word.textContent, "Работает", "the host's node is left alone; CSS hides it")
  assert.equal(doc.styles.length, 1, "one style node, injected once")
  assert.equal(doc.styles[0].textContent, STATUS_CSS)

  assert.equal(applyWorkingStatus(root as unknown as ParentNode, queued, NOW), false, "a second pass changes nothing")
  assert.equal(doc.styles.length, 1)
})

test("the patch is undone when the session is no longer gated", () => {
  const doc = document()
  const { root, container } = workingRow(doc)

  applyWorkingStatus(root as unknown as ParentNode, queued, NOW)

  assert.equal(applyWorkingStatus(root as unknown as ParentNode, undefined, NOW), true)
  assert.equal(container.children.some((child) => child.className === STATUS_CLASS), false)
  assert.equal(container.dataset.turnLockPhase, undefined)
  assert.equal(container.getAttribute("title"), null)
  assert.equal(applyWorkingStatus(root as unknown as ParentNode, undefined, NOW), false, "clearing twice is a no-op")
})

test("the title dot lends its accessible name and gets it back", () => {
  const doc = document()
  const { root } = workingRow(doc)
  const dot = headerDot(doc, root)

  applyWorkingStatus(root as unknown as ParentNode, queued, NOW)
  assert.equal(dot.attributes["aria-label"], "В очереди · 2/5 · 9 мин")

  applyWorkingStatus(root as unknown as ParentNode, undefined, NOW)
  assert.equal(dot.attributes["aria-label"], "Работает", "the host's own word comes back")
  assert.equal(dot.getAttribute("title"), null)
})

test("the Tampermonkey script draws the same status label", () => {
  const source = readFileSync(new URL("../userscript/turn-lock-prio.user.js", import.meta.url), "utf8")

  assert.match(source, /data-component="session-working"/)
  assert.match(source, /data-session-title/)
  assert.match(source, /data-turn-lock-phase/)
  assert.match(source, /tl-status/)
  assert.match(source, /В очереди/)
  assert.match(source, /Отправлено в движок/)
  // The phase is read from the same metadata, with the same fallback rule.
  assert.match(source, /raw\.phase === "queued"/)
  assert.match(source, /const phaseOf =/)
})

test("an event re-reads the state at once instead of waiting for the poll", async () => {
  const doc = document()
  const { root, container } = workingRow(doc)

  let loads = 0
  let refresh: (() => void) | undefined
  const stop = startStatusView({
    intervalMs: 5,
    reloadMs: 60_000,
    refreshDebounceMs: 0,
    root: () => root as unknown as ParentNode,
    visible: () => true,
    load: async () => {
      loads += 1
      return loads === 1 ? queued : undefined
    },
    watch: (fn) => {
      refresh = fn
      return () => {}
    },
  })
  try {
    await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal(loads, 1, "the first tick reads once")
    assert.equal(container.dataset.turnLockPhase, "queued")

    refresh?.()
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(loads, 2, "the event cuts the poll short")
    assert.equal(container.dataset.turnLockPhase, undefined, "the re-read removed the label")
  } finally {
    stop()
  }
})
