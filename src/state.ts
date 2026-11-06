// state.ts — the shared, machine-readable queue state of a session.
//
// Until now the only channel between the server half and any client was the
// session title: `⚡`, `▽`, `⏳ 2/5 · 9m ·`. That works everywhere, including a
// phone without the userscript, but it is text: every reader has to parse it,
// and the emoji sit in the user's title. The server can also write
// `session.metadata` (a free-form JSON object that `GET /api/session` returns),
// which is a real field rather than a string convention. This module owns that
// shape, the fallback for titles written by older versions, and the sort key.
//
// The metadata key is namespaced so the plugin never touches anyone else's
// data, and every reader tolerates a missing or malformed value: an old session
// has no metadata at all, and a hand-edited one must not break the list.

import type { PriorityLevel } from "./index.ts"

/** The key this plugin owns inside `session.metadata`. */
export const STATE_KEY = "turn-lock"

/** Everything a row needs to be sorted and drawn. `level` is always present. */
export type TurnLockState = {
  level: PriorityLevel
  /** The last model request went to a cloud provider (the session is not gated). */
  cloud?: boolean
  /** 1-based place in the queue, present only while the session waits. */
  position?: number
  /** How many sessions wait in total, present together with `position`. */
  total?: number
  /** When the wait started (epoch ms), used for the countdown. */
  since?: number
}

const LEVELS: readonly PriorityLevel[] = ["low", "normal", "high"]

/** Visual order of the levels: high first, ordinary next, low last. */
export const LEVEL_RANK: Record<PriorityLevel, number> = { high: 0, normal: 1, low: 2 }

const positive = (value: unknown): number | undefined => {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : undefined
}

/**
 * The state stored in a session's metadata, or undefined when there is none.
 * A malformed value degrades to "ordinary" instead of throwing: the list must
 * keep working even if something else wrote into the key.
 */
export function readState(metadata: unknown): TurnLockState | undefined {
  if (!metadata || typeof metadata !== "object") return undefined
  const raw = (metadata as Record<string, unknown>)[STATE_KEY]
  if (!raw || typeof raw !== "object") return undefined
  const value = raw as Record<string, unknown>

  const state: TurnLockState = {
    level: LEVELS.includes(value.level as PriorityLevel) ? (value.level as PriorityLevel) : "normal",
  }
  if (value.cloud === true) state.cloud = true
  const position = positive(value.position)
  const total = positive(value.total)
  if (position !== undefined && total !== undefined && position <= total) {
    state.position = position
    state.total = total
  }
  if (typeof value.since === "number" && Number.isFinite(value.since)) state.since = value.since
  return state
}

/** Drop undefined fields, so the stored JSON stays small and stable. */
function compact(state: TurnLockState): Record<string, unknown> {
  const value: Record<string, unknown> = { level: state.level }
  if (state.cloud) value.cloud = true
  if (state.position !== undefined) value.position = state.position
  if (state.total !== undefined) value.total = state.total
  if (state.since !== undefined) value.since = state.since
  return value
}

/**
 * A copy of `metadata` carrying exactly this state under our key, with every
 * other key of the session preserved. `undefined` removes the key.
 */
export function withState(metadata: unknown, state: TurnLockState | undefined): Record<string, unknown> {
  const base = metadata && typeof metadata === "object" ? { ...(metadata as Record<string, unknown>) } : {}
  if (!state) {
    delete base[STATE_KEY]
    return base
  }
  base[STATE_KEY] = compact(state)
  return base
}

/** The cloud prefix the server may write into a title (`titleMarks: "all"`). */
export const CLOUD_MARK = "☁️ "

const CLOUD_PREFIX = /^☁️ ?/
const PRIORITY_PREFIX = /^⚡ ?/
const LOW_PREFIX = /^▽ ?/
/** `⏳ 2/5 · 9m · ` and the older shapes the server has written. */
const WAIT_PREFIX = /^⏳ (?:(\d+)\/(\d+) · )?(?:(?:\d+h(?:\d+m)?|\d+m|\d+ мин|\d+ ч(?: \d+ мин)?|ждёт) · )?/

/**
 * The state a title claims, for sessions whose metadata is missing (everything
 * written before metadata existed, and anything another client renamed). Reads
 * the same marks the server writes, and nothing else.
 */
export function stateFromTitle(title: string | null | undefined): TurnLockState | undefined {
  let text = String(title ?? "")
  const state: TurnLockState = { level: "normal" }
  let found = false

  if (CLOUD_PREFIX.test(text)) {
    state.cloud = true
    text = text.replace(CLOUD_PREFIX, "")
    found = true
  }
  if (PRIORITY_PREFIX.test(text)) {
    state.level = "high"
    text = text.replace(PRIORITY_PREFIX, "")
    found = true
  } else if (LOW_PREFIX.test(text)) {
    state.level = "low"
    text = text.replace(LOW_PREFIX, "")
    found = true
  }
  const wait = WAIT_PREFIX.exec(text)
  if (wait) {
    const position = positive(wait[1])
    const total = positive(wait[2])
    if (position !== undefined && total !== undefined && position <= total) {
      state.position = position
      state.total = total
    }
    found = true
  }
  return found ? state : undefined
}

/** The two label languages this plugin speaks. */
export type Lang = "ru" | "en"

/** Russian plural form: 1 минута, 2 минуты, 5 минут. */
function ruPlural(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10
  const mod100 = count % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few
  return many
}

/** Seconds, minutes and hours of a wait, floored and never negative. */
function waitParts(waitedMs: number): { seconds: number; minutes: number; hours: number; rest: number } {
  const seconds = Math.max(0, Math.floor((Number.isFinite(waitedMs) ? waitedMs : 0) / 1_000))
  const minutes = Math.floor(seconds / 60)
  return { seconds, minutes, hours: Math.floor(minutes / 60), rest: minutes % 60 }
}

/**
 * A wait as a badge-sized label: `42 с`, `9 мин`, `2 ч 5 мин`. This is what the
 * title used to carry as `9m`, but readable — the badge is a UI element, not a
 * string the user has to decode.
 */
export function waitLabel(waitedMs: number, lang: Lang = "ru"): string {
  const { seconds, minutes, hours, rest } = waitParts(waitedMs)
  if (seconds < 60) return lang === "ru" ? `${seconds} с` : `${seconds} s`
  if (minutes < 60) return lang === "ru" ? `${minutes} мин` : `${minutes} min`
  if (rest === 0) return lang === "ru" ? `${hours} ч` : `${hours} h`
  return lang === "ru" ? `${hours} ч ${rest} мин` : `${hours} h ${rest} min`
}

/** The same wait as a sentence, for a tooltip: `ждёт 9 минут`. */
export function waitSentence(waitedMs: number, lang: Lang = "ru"): string {
  const { seconds, minutes, hours, rest } = waitParts(waitedMs)
  if (lang === "en") {
    if (seconds < 60) return `waiting ${seconds} s`
    if (minutes < 60) return `waiting ${minutes} min`
    return rest === 0 ? `waiting ${hours} h` : `waiting ${hours} h ${rest} min`
  }
  if (seconds < 60) return `ждёт ${seconds} ${ruPlural(seconds, "секунду", "секунды", "секунд")}`
  if (minutes < 60) return `ждёт ${minutes} ${ruPlural(minutes, "минуту", "минуты", "минут")}`
  const head = `ждёт ${hours} ${ruPlural(hours, "час", "часа", "часов")}`
  return rest === 0 ? head : `${head} ${rest} ${ruPlural(rest, "минуту", "минуты", "минут")}`
}

/**
 * Sort key of one row: cloud first (a cloud session is never gated, so it is
 * never in the queue), then the level, then the place in the queue — a session
 * that is already running (no place) goes before the waiters, and the waiters
 * go 1/5 → 2/5 → 3/5 — then the client's own position, which keeps its
 * `time.busy` order inside a group.
 */
export function rowOrder(state: TurnLockState | undefined, title: string | null | undefined, index: number): number[] {
  const value = state ?? stateFromTitle(title) ?? { level: "normal" as PriorityLevel }
  return [
    value.cloud ? 0 : 1,
    LEVEL_RANK[value.level],
    value.position !== undefined ? value.position : -1,
    Math.max(0, Math.trunc(index)),
  ]
}

/** Lexicographic comparison of two `rowOrder` keys. */
export function compareOrder(left: readonly number[], right: readonly number[]): number {
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/** One row, as the sort and the badge see it. */
export type InboxEntry = { title: string; index: number; state?: TurnLockState }

/** Rows in visual order, with the client's order as the tiebreak. */
export function orderRows(entries: readonly InboxEntry[]): InboxEntry[] {
  return entries
    .map((entry) => ({ entry, key: rowOrder(entry.state, entry.title, entry.index) }))
    .sort((left, right) => compareOrder(left.key, right.key) || left.entry.index - right.entry.index)
    .map((item) => item.entry)
}
