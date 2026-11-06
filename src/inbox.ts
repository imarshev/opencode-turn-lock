// inbox.ts — the client half that sorts the "Working" section of the inbox.
//
// The web client (and the desktop app, which renders the same bundle) orders
// working sessions by `time.busy` and knows nothing about /prio. The priority is
// already in the session title, so this module only has to put the rows in the
// right visual order. It uses CSS `order` on the flex rows instead of moving DOM
// nodes: the list is a Solid keyed `For`, and moving its nodes behind its back
// would fight reconciliation.
//
// This is a DOM hack, not an API: `data-slot` and `span[dir="auto"]` are the
// client's internal markup. See the README and docs/upstream for the supported
// path (a plugin-replaceable left navigation).

export type InboxLevel = "high" | "normal" | "low"

/** Visual rank: high first, ordinary next, low last. */
export const INBOX_RANK: Record<InboxLevel, number> = { high: 0, normal: 1, low: 2 }

/** The mark the server part writes at the start of a title; ordinary has none. */
export function inboxLevel(title: string | null | undefined): InboxLevel {
  const text = String(title ?? "")
  return text.startsWith("⚡") ? "high" : text.startsWith("▽") ? "low" : "normal"
}

/**
 * CSS `order` for a row: the level, then the row's current position. The index
 * keeps the client's own `time.busy` order inside a level, and the multiplier
 * keeps the levels apart for any realistic number of rows.
 */
export function inboxOrder(title: string | null | undefined, index: number): number {
  return INBOX_RANK[inboxLevel(title)] * 1_000_000 + Math.max(0, Math.trunc(index))
}

/** A stable sort by level; exported for tests and for callers with their own DOM. */
export function sortInboxRows<T extends { title?: string | null }>(rows: readonly T[]): T[] {
  return rows
    .map((row, index) => ({ row, order: inboxOrder(row.title, index) }))
    .sort((left, right) => left.order - right.order)
    .map((entry) => entry.row)
}

const WORKING = '[data-slot="sidebar-inbox-working"]'
const ROW = '[data-slot="sidebar-inbox-item"]'
const TITLE = 'span[dir="auto"]'

/**
 * Apply the order to the rows currently in the working section. Returns true
 * when something changed, so a caller can stop after the first pass. Rows are
 * only styled, never moved.
 */
export function applyInboxSort(root: ParentNode): boolean {
  const section = root.querySelector(WORKING)
  if (!section) return false

  // The section header is inserted before the scroll container, so the rows are
  // found by their own marker rather than as `firstElementChild`.
  const rows = Array.from(section.querySelectorAll(ROW))
  if (rows.length < 2) return false

  let changed = false
  rows.forEach((row, index) => {
    const title = row.querySelector(TITLE)?.textContent ?? ""
    const order = String(inboxOrder(title, index))
    const style = (row as HTMLElement).style
    if (style.order === order) return
    style.order = order
    changed = true
  })
  return changed
}

export type InboxSortOptions = {
  /** How often to re-read the titles. A priority change is a rename, so 1s is enough. */
  intervalMs?: number
  /** The document (or a test double) to look in. */
  root?: () => ParentNode | null
  /** Skip work while the tab is hidden. */
  visible?: () => boolean
}

/**
 * Keep the working section sorted until the returned function is called.
 * Safe to call outside a browser: it does nothing when there is no document.
 */
export function startInboxSort(options: InboxSortOptions = {}): () => void {
  const intervalMs = options.intervalMs ?? 1_000
  const root = options.root ?? (() => (typeof document === "undefined" ? null : document))
  const visible =
    options.visible ??
    (() => typeof document === "undefined" || document.visibilityState === "visible")

  const tick = () => {
    if (!visible()) return
    const node = root()
    if (node) applyInboxSort(node)
  }

  tick()
  const timer = setInterval(tick, intervalMs)
  // A cosmetic sort must not keep a Node process alive (tests, CLI hosts).
  if (typeof (timer as { unref?: () => void }).unref === "function") (timer as { unref: () => void }).unref()
  return () => clearInterval(timer)
}
