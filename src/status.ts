// status.ts — the one line a session shows before its answer exists.
//
// The client draws "Работает" (the i18n key `session.timeline.working`) whenever
// a session is `busy` and the timeline has nothing to show yet. For a session
// held in the gate that sentence is false: its request has not reached the
// engine at all. The server knows better and says so in `session.metadata`
// (`phase`, see state.ts), so this module replaces that one label for as long as
// the phase is known and puts the host's own text back the moment it is not.
//
// Everything here is DOM work on the host's markup:
//  * `[data-component="session-working"]` — the timeline's status row. The host
//    renders its spinner and the word inside; the whole row is hidden and one
//    span of ours is drawn instead, so a re-render of the inner text cannot
//    fight the patch.
//  * `[data-session-title] [role="status"][aria-label]` — the small dot next to
//    the session title, which carries no text at all. Only its `aria-label` and
//    `title` are borrowed, and the original is restored.
//
// Both are best-effort: a renamed attribute upstream leaves the host's own
// "Работает" in place, which is the state this module started from.

import { phaseOf, waitLabel, waitSentence, type Lang, type Phase, type TurnLockState } from "./state.ts"
import type { PriorityLevel } from "./priority.ts"

/** The class of the span that carries our label. */
export const STATUS_CLASS = "tl-status"

/** What the host draws while a session is busy and has answered nothing yet. */
const WORKING = '[data-component="session-working"]'

/** The title-row dot: no text, only an accessible name. */
const HEADER = '[data-session-title] [role="status"][aria-label]'

/**
 * Hide the host's own children, not its container: the spinner and the word are
 * re-rendered on their own, while the container survives. Without a phase the
 * attribute is absent and this rule matches nothing.
 */
export const STATUS_CSS = `
[data-component="session-working"][data-turn-lock-phase] > :not(.${STATUS_CLASS}) {
  display: none !important;
}
[data-component="session-working"] .${STATUS_CLASS} {
  display: inline-flex;
  align-items: center;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
`

const WORDS = {
  ru: {
    queued: "В очереди",
    sending: "Отправлено в движок",
    queuedHint: "ждёт свободный слот локального движка",
    sendingHint: "слот получен, ответ движка ещё не начал приходить",
  },
  en: {
    queued: "Queued",
    sending: "Sent to the engine",
    queuedHint: "waiting for a free slot on the local engine",
    sendingHint: "the slot is taken; the engine's answer has not started arriving",
  },
} as const

/** What replaces the host's label, and why. */
export type WorkingLabel = {
  phase: Phase
  /** The visible text: a glyph, then the words. */
  text: string
  /** The same words without the glyph, for the accessible name. */
  spoken: string
  /** The tooltip: what the session is waiting for. */
  title: string
}

/**
 * The label a state asks for, or undefined when the host's own text is true —
 * the session is neither queued nor sending.
 */
export function workingLabel(
  state: TurnLockState | undefined,
  now = Date.now(),
  lang: Lang = "ru",
): WorkingLabel | undefined {
  const phase = phaseOf(state)
  if (!phase) return undefined
  const words = WORDS[lang]
  const value: TurnLockState = state ?? { level: "normal" as PriorityLevel }

  if (phase === "queued") {
    const place = value.position !== undefined && value.total !== undefined ? `${value.position}/${value.total}` : ""
    // The wait ticks on its own: it is computed from `since`, so the server does
    // not have to rewrite anything once a second.
    const wait = value.since !== undefined ? waitLabel(now - value.since, lang) : ""
    const short = [place, wait].filter(Boolean).join(" · ")
    const hint: string[] = [words.queuedHint]
    if (place) hint.push(lang === "ru" ? `${place} в очереди` : `${place} in queue`)
    if (value.since !== undefined) hint.push(waitSentence(now - value.since, lang))
    const said = `${words.queued}${short ? ` · ${short}` : ""}`
    return { phase, text: `⏳ ${said}`, spoken: said, title: hint.join(" · ") }
  }

  return { phase, text: `▶ ${words.sending}`, spoken: words.sending, title: words.sendingHint }
}

/** The span we own inside a container, and the `aria-label` the host wrote. */
const mounts = new WeakMap<Element, Element>()
const originals = new WeakMap<Element, string>()

function ensureStyle(doc: Document): void {
  // Our own marker, not the inbox badge's `data-turn-lock`: the two views must
  // not think the other already injected its rules.
  if (doc.querySelector("style[data-turn-lock-status]")) return
  const style = doc.createElement("style")
  style.setAttribute("data-turn-lock-status", "label")
  style.textContent = STATUS_CSS
  ;(doc.head ?? doc.documentElement)?.appendChild(style)
}

function clearContainer(container: Element): boolean {
  let changed = false
  const own = mounts.get(container)
  if (own) {
    own.remove()
    mounts.delete(container)
    changed = true
  }
  const dataset = (container as HTMLElement).dataset
  if (dataset.turnLockPhase !== undefined) {
    delete dataset.turnLockPhase
    changed = true
  }
  if (container.getAttribute("title") !== null) {
    container.removeAttribute("title")
    changed = true
  }
  return changed
}

/**
 * Draw (or remove) the label for one state. Returns true when the DOM changed,
 * so a caller can skip work on the next tick.
 */
export function applyWorkingStatus(
  root: ParentNode,
  state: TurnLockState | undefined,
  now = Date.now(),
  lang: Lang = "ru",
): boolean {
  const label = workingLabel(state, now, lang)
  let changed = false

  const container = root.querySelector(WORKING)
  if (container) {
    if (!label) {
      changed = clearContainer(container) || changed
    } else {
      const doc = container.ownerDocument ?? (globalThis as { document?: Document }).document
      if (!doc) return false
      ensureStyle(doc)
      // The host can rebuild the row; a span of ours that lost its parent is
      // simply made again, and the old node goes with the old container.
      let own = mounts.get(container)
      if (!own || own.parentNode !== container) {
        own = doc.createElement("span")
        own.className = STATUS_CLASS
        container.appendChild(own)
        mounts.set(container, own)
        changed = true
      }
      if (own.textContent !== label.text) {
        own.textContent = label.text
        changed = true
      }
      const dataset = (container as HTMLElement).dataset
      if (dataset.turnLockPhase !== label.phase) {
        dataset.turnLockPhase = label.phase
        changed = true
      }
      if (container.getAttribute("title") !== label.title) {
        container.setAttribute("title", label.title)
        changed = true
      }
    }
  }

  const header = root.querySelector(HEADER)
  if (header) {
    if (label) {
      if (!originals.has(header)) originals.set(header, header.getAttribute("aria-label") ?? "")
      if (header.getAttribute("aria-label") !== label.spoken) {
        header.setAttribute("aria-label", label.spoken)
        changed = true
      }
      if (header.getAttribute("title") !== label.title) {
        header.setAttribute("title", label.title)
        changed = true
      }
    } else {
      const original = originals.get(header)
      if (original !== undefined) {
        if (header.getAttribute("aria-label") !== original) {
          header.setAttribute("aria-label", original)
          changed = true
        }
        originals.delete(header)
      }
      if (header.getAttribute("title") !== null) {
        header.removeAttribute("title")
        changed = true
      }
    }
  }

  return changed
}

/** Whether the document currently has anything to patch at all. */
function hasTarget(node: ParentNode): boolean {
  return Boolean(node.querySelector(WORKING) ?? node.querySelector(HEADER))
}

export type StatusViewOptions = {
  /** How often the wait label is redrawn (it counts up on its own). */
  intervalMs?: number
  /** How often the state is re-read; an event cuts this short. */
  reloadMs?: number
  /** How long a burst of events waits before it becomes one read. */
  refreshDebounceMs?: number
  /** The document (or a test double) to look in. */
  root?: () => ParentNode | null
  /** Skip work while the window is hidden. */
  visible?: () => boolean
  /** Where the state comes from: the routed session's metadata. */
  load?: () => Promise<TurnLockState | undefined>
  /** The language of the label; reactive so a language switch redraws. */
  lang?: () => Lang
  /** A live stream of changes: it is handed a function that re-reads at once. */
  watch?: (refresh: () => void) => () => void
}

/**
 * Keep the session's status label honest until the returned function is called.
 * Safe outside a browser: with no document it does nothing.
 */
export function startStatusView(options: StatusViewOptions = {}): () => void {
  const intervalMs = options.intervalMs ?? 1_000
  const reloadMs = options.reloadMs ?? 2_000
  const debounceMs = options.refreshDebounceMs ?? 120
  const root = options.root ?? (() => (typeof document === "undefined" ? null : document))
  const visible =
    options.visible ?? (() => typeof document === "undefined" || document.visibilityState === "visible")
  const lang = options.lang ?? (() => "ru" as const)

  // `loaded` separates "nothing is gated" (an answer: clear the patch) from "no
  // read has landed yet" (do not touch the host's own label).
  let current: TurnLockState | undefined
  let loaded = false
  let loading = false
  let attemptedAt = 0
  let again = false
  let pending: ReturnType<typeof setTimeout> | undefined
  let stopped = false

  const draw = () => {
    const node = root()
    if (node) applyWorkingStatus(node, loaded ? current : undefined, Date.now(), lang())
  }

  const read = () => {
    if (!options.load || loading) return
    loading = true
    attemptedAt = Date.now()
    options
      .load()
      .then((next) => {
        current = next
        loaded = true
        draw()
      })
      .catch(() => {
        // A failed read keeps the last known state; the next tick retries.
      })
      .finally(() => {
        loading = false
        if (again) {
          again = false
          read()
        }
      })
  }

  const tick = () => {
    if (!visible()) return
    const node = root()
    if (!node) return
    // No status row and no title dot: the host is drawing no label, so there is
    // nothing to correct and nothing to read for. The next tick picks the row up
    // the moment the host draws one — at the first request of a session.
    if (!hasTarget(node)) return
    if (loaded) applyWorkingStatus(node, current, Date.now(), lang())
    if (attemptedAt !== 0 && Date.now() - attemptedAt < reloadMs) return
    read()
  }

  const refresh = () => {
    if (stopped || pending !== undefined) return
    pending = setTimeout(() => {
      pending = undefined
      if (loading) {
        again = true
        return
      }
      attemptedAt = 0
      tick()
    }, debounceMs)
    if (typeof (pending as { unref?: () => void }).unref === "function") (pending as { unref: () => void }).unref()
  }

  const unwatch = options.watch?.(refresh)
  tick()
  const timer = setInterval(tick, intervalMs)
  // A cosmetic label must not keep a Node process alive (tests, CLI hosts).
  if (typeof (timer as { unref?: () => void }).unref === "function") (timer as { unref: () => void }).unref()
  return () => {
    stopped = true
    clearInterval(timer)
    if (pending !== undefined) clearTimeout(pending)
    pending = undefined
    unwatch?.()
  }
}
