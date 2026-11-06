// inbox.ts — the client half that draws the "Working" section of the inbox.
//
// The web client (and the desktop app, which renders the same bundle) orders
// working sessions by `time.busy` and knows nothing about the queue. The state
// now lives in `session.metadata` (see state.ts), so this module only has to
// put the rows in the right visual order and draw a small badge.
//
// Both are DOM work on the client's internal markup: `data-slot` attributes,
// the row's first child (the project/time line) and `span[dir="auto"]` (the
// title). The list is a Solid keyed `For`, so nodes are never moved: the order
// is CSS `order` on the flex row, and the badge is one extra node inside the
// header line, which Solid does not recreate when the title changes.
//
// A row carries no session id in the DOM, so a badge click can only be routed
// back to a session by its title. That is the one ambiguity here: two sessions
// with the same title would share the first match. The alternative — no click
// at all — loses the useful part, so the caller decides by passing `cycle`.

import { holdSentence, rowOrder, stateFromTitle, waitLabel, waitSentence, type Lang, type TurnLockState } from "./state.ts"
import { levelOfTitle } from "./title.ts"
import type { PriorityLevel } from "./priority.ts"

/** The three queue levels, as the client draws them. */
export type InboxLevel = PriorityLevel

/** The level a title claims; kept for the composer pill's fallback path. */
export function inboxLevel(title: string | null | undefined): InboxLevel {
  return levelOfTitle(String(title ?? ""))
}

/** One row as the loader sees it: the title is the key the DOM exposes. */
export type InboxRowData = {
  title: string
  state?: TurnLockState
  /** The session id, when the loader knows it (needed for a click). */
  id?: string
}

export type InboxViewOptions = {
  /** How often the state is re-read. A rename is a write, so 1s is enough. */
  intervalMs?: number
  /** How often the rows' states are re-read from the loader. */
  reloadMs?: number
  /** The document (or a test double) to look in. */
  root?: () => ParentNode | null
  /** Skip work while the tab is hidden. */
  visible?: () => boolean
  /** Where the rows' states come from (metadata). Without it, titles are parsed. */
  load?: () => Promise<readonly InboxRowData[]>
  /** Called when a badge is clicked; the caller cycles the level. */
  cycle?: (row: InboxRowData) => void
  /** The language of the badge text; reactive so a language switch redraws. */
  lang?: () => Lang
}

const WORKING = '[data-slot="sidebar-inbox-working"]'
const ROW = '[data-slot="sidebar-inbox-item"]'
const TITLE = 'span[dir="auto"]'

/** The badge, its styles and its glyphs. One string, injected once. */
export const BADGE_CLASS = "tl-badge"

export const BADGE_CSS = `
[data-slot="sidebar-inbox-item"] .${BADGE_CLASS} {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 14px;
  padding: 0 4px;
  margin-inline-start: 2px;
  border-radius: 999px;
  border: 1px solid color-mix(in oklab, currentColor 35%, transparent);
  background: color-mix(in oklab, currentColor 12%, transparent);
  font-size: 9px;
  font-weight: 600;
  line-height: 1;
  letter-spacing: 0.02em;
  flex: 0 0 auto;
  cursor: pointer;
  user-select: none;
}
[data-slot="sidebar-inbox-item"] .${BADGE_CLASS}[data-level="high"] { color: #f59e0b; }
[data-slot="sidebar-inbox-item"] .${BADGE_CLASS}[data-level="low"] { color: #94a3b8; }
[data-slot="sidebar-inbox-item"] .${BADGE_CLASS}[data-cloud="true"] { color: #38bdf8; }
[data-slot="sidebar-inbox-item"] .${BADGE_CLASS}[data-holding="true"] { border-color: #22c55e; }
[data-slot="sidebar-inbox-item"] .${BADGE_CLASS} .tl-hold { color: #22c55e; display: inline-flex; align-items: center; gap: 3px; }
[data-slot="sidebar-inbox-item"] .${BADGE_CLASS}:hover { filter: brightness(1.25); }
[data-slot="sidebar-inbox-item"] .${BADGE_CLASS} svg { width: 9px; height: 9px; }
[data-slot="sidebar-inbox-item"] .${BADGE_CLASS} .tl-wait { font-variant-numeric: tabular-nums; white-space: nowrap; }
`

const ICON = {
  high: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M9.5 1 3 9h3.8L6 15l6.5-8H8.6L9.5 1z"/></svg>',
  low: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3.5 6.5 8 11l4.5-4.5"/></svg>',
  cloud:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4.6 12a2.9 2.9 0 0 1 .3-5.8 3.9 3.9 0 0 1 7.4 1.2A2.3 2.3 0 0 1 11.7 12z"/></svg>',
  clock:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="8" cy="8" r="5.6"/><path d="M8 4.9V8l2.2 1.4"/></svg>',
  hold: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="8" cy="8" r="3.6"/></svg>',
} as const

const WORDS = {
  ru: { cloud: "облачная модель", high: "высокий приоритет", low: "низкий приоритет", place: (p: string) => `${p} в очереди` },
  en: { cloud: "cloud model", high: "high priority", low: "low priority", place: (p: string) => `${p} in queue` },
} as const

/**
 * Human-readable description of a state, used as the badge's tooltip. The wait
 * is spelled out here in full ("ждёт 9 минут") while the badge itself only has
 * room for the short form ("9 мин").
 */
export function describeState(state: TurnLockState, now = Date.now(), lang: Lang = "ru"): string {
  const words = WORDS[lang]
  const parts: string[] = []
  if (state.cloud) parts.push(words.cloud)
  if (state.level === "high") parts.push(words.high)
  if (state.level === "low") parts.push(words.low)
  if (state.position !== undefined && state.total !== undefined) parts.push(words.place(`${state.position}/${state.total}`))
  if (state.since !== undefined) parts.push(waitSentence(now - state.since, lang))
  if (state.holding !== undefined) parts.push(holdSentence(now - state.holding, lang))
  return parts.join(" · ")
}

/** A row needs a badge only when it has something to say. */
function hasBadge(state: TurnLockState | undefined): state is TurnLockState {
  if (!state) return false
  return (
    state.cloud === true ||
    state.level !== "normal" ||
    state.position !== undefined ||
    state.since !== undefined ||
    state.holding !== undefined
  )
}

function badgeHtml(state: TurnLockState, now: number, lang: Lang): string {
  const icons = `${state.cloud ? ICON.cloud : ""}${state.level === "high" ? ICON.high : state.level === "low" ? ICON.low : ""}`
  const place = state.position !== undefined && state.total !== undefined ? `${state.position}/${state.total}` : ""
  // The wait is the one part that changes on its own, so it is drawn from the
  // start time on every pass instead of being rewritten by the server.
  const wait =
    state.since !== undefined
      ? `${ICON.clock}<span class="tl-wait">${waitLabel(now - state.since, lang)}</span>`
      : ""
  // The holder is drawn apart: a filled dot and its own timer, so the row that
  // is actually being served is distinguishable from the ones waiting for it.
  const hold =
    state.holding !== undefined
      ? `<span class="tl-hold">${ICON.hold}<span class="tl-wait">${waitLabel(now - state.holding, lang)}</span></span>`
      : ""
  return `${icons}${place ? `<span>${place}</span>` : ""}${wait}${hold}`
}

/** The row's title, as the client renders it. */
function titleOf(row: Element): string {
  return row.querySelector(TITLE)?.textContent ?? ""
}

const badges = new WeakMap<Element, HTMLElement>()

function ensureStyle(doc: Document): void {
  if (doc.querySelector("style[data-turn-lock]")) return
  const style = doc.createElement("style")
  style.setAttribute("data-turn-lock", "badge")
  style.textContent = BADGE_CSS
  ;(doc.head ?? doc.documentElement)?.appendChild(style)
}

/**
 * Place the badge inside the row's header line, before the elapsed time. The
 * header is the row's first child; inserting there keeps the flex layout and
 * survives title updates, which only touch the title span.
 */
function mountBadge(row: Element, doc: Document): HTMLElement {
  const element = doc.createElement("span")
  element.className = BADGE_CLASS
  const header = row.firstElementChild
  if (header) header.insertBefore(element, header.lastElementChild)
  else row.appendChild(element)
  badges.set(row, element)
  return element
}

/**
 * Sort the working rows and draw a badge on each. Returns true on any change.
 * `now` and `lang` default to the current time and Russian; the view passes
 * both so a badge's wait label ticks without a second `Date.now()` per row.
 */
export function applyInboxView(
  root: ParentNode,
  rows: readonly InboxRowData[],
  cycle?: (row: InboxRowData) => void,
  now = Date.now(),
  lang: Lang = "ru",
): boolean {
  const section = root.querySelector(WORKING)
  if (!section) return false
  const elements = Array.from(section.querySelectorAll(ROW))
  if (elements.length === 0) return false

  // The loader knows the session's state; the title is only the join key and a
  // fallback for rows the loader did not return.
  const byTitle = new Map<string, InboxRowData>()
  for (const row of rows) byTitle.set(row.title, row)

  const doc = elements[0].ownerDocument ?? (globalThis as { document?: Document }).document
  if (!doc) return false
  ensureStyle(doc)

  let changed = false
  const ordered = elements
    .map((element, index) => {
      const title = titleOf(element)
      const data = byTitle.get(title)
      const state = data?.state ?? stateFromTitle(title)
      return { element, index, title, data, state }
    })
    .sort((left, right) => {
      const a = rowOrder(left.state, left.title, left.index)
      const b = rowOrder(right.state, right.title, right.index)
      for (let i = 0; i < a.length; i += 1) {
        if (a[i] !== b[i]) return a[i] - b[i]
      }
      return left.index - right.index
    })

  ordered.forEach((entry, rank) => {
    const order = String(rank)
    if ((entry.element as HTMLElement).style.order !== order) {
      ;(entry.element as HTMLElement).style.order = order
      changed = true
    }

    const state = entry.state
    if (!hasBadge(state)) {
      const stale = badges.get(entry.element)
      if (stale) {
        stale.remove()
        badges.delete(entry.element)
        changed = true
      }
      return
    }

    const badge = badges.get(entry.element) ?? mountBadge(entry.element, doc)
    const html = badgeHtml(state, now, lang)
    if (badge.innerHTML !== html) {
      badge.innerHTML = html
      changed = true
    }
    const cloud = state.cloud ? "true" : "false"
    if (badge.dataset.level !== state.level) badge.dataset.level = state.level
    if (badge.dataset.cloud !== cloud) badge.dataset.cloud = cloud
    const holding = state.holding !== undefined ? "true" : "false"
    if (badge.dataset.holding !== holding) badge.dataset.holding = holding
    badge.title = describeState(state, now, lang)
    badge.onclick = (event: Event) => {
      event.preventDefault()
      event.stopPropagation()
      cycle?.(entry.data ?? { title: entry.title, state })
    }
  })
  return changed
}

/**
 * Keep the working section sorted and badged until the returned function is
 * called. Safe to call outside a browser: it does nothing when there is no
 * document.
 */
export function startInboxView(options: InboxViewOptions = {}): () => void {
  const intervalMs = options.intervalMs ?? 1_000
  const root = options.root ?? (() => (typeof document === "undefined" ? null : document))
  const visible =
    options.visible ?? (() => typeof document === "undefined" || document.visibilityState === "visible")

  // A state change is a metadata write, not a stream, so re-reading the list
  // once every `reloadMs` is enough — and the read is skipped while the section
  // is not on screen, so a session route costs nothing.
  const reloadMs = options.reloadMs ?? 2_000
  const lang = options.lang ?? (() => "ru" as const)
  let rows: readonly InboxRowData[] = []
  let loading = false
  let attemptedAt = 0
  const tick = () => {
    if (!visible()) return
    const node = root()
    if (!node) return
    applyInboxView(node, rows, options.cycle, Date.now(), lang())
    if (!options.load || loading) return
    if (!node.querySelector(WORKING)) return
    if (attemptedAt !== 0 && Date.now() - attemptedAt < reloadMs) return
    loading = true
    attemptedAt = Date.now()
    options
      .load()
      .then((next) => {
        rows = next
        const again = root()
        if (again) applyInboxView(again, rows, options.cycle, Date.now(), lang())
      })
      .catch(() => {
        // A failed read keeps the last known state; the next tick retries.
      })
      .finally(() => {
        loading = false
      })
  }

  tick()
  const timer = setInterval(tick, intervalMs)
  // A cosmetic sort must not keep a Node process alive (tests, CLI hosts).
  if (typeof (timer as { unref?: () => void }).unref === "function") (timer as { unref: () => void }).unref()
  return () => clearInterval(timer)
}
