// title.ts — the session title as the plugin's state channel.
//
// The title carries three optional marks in a fixed order: the cloud mark
// (`☁️ `), the level (`⚡ `/`▽ `), and the waiting prefix (`⏳ 2/3 · 9m · `).
// Metadata is the primary channel now, but titles are what every client shows,
// and they are the fallback for sessions marked by an older version — so the
// grammar has to live in exactly one place.
//
// Pure string algebra: no fs, no OpenCode. `index.ts` re-exports it for the
// plugin's public API, `state.ts` parses titles with it, and the GUI reads the
// same marks. The levels themselves live in priority.ts.

import { LOW_MARK, PRIORITY_MARK, markFor, type PriorityLevel } from "./priority.ts"

/** The cloud prefix the server may write into a title (`titleMarks: "all"`). */
export const CLOUD_MARK = "☁️ "

/** Prefix a queued session's title with this, so any session list shows it is waiting. */
export const WAITING_MARK = "⏳ "

/** A mark plus the space the marks are joined by, if any. */
const prefixOf = (mark: string) => new RegExp(`^${mark} ?`)

const CLOUD_PREFIX = prefixOf(CLOUD_MARK.trim())
const PRIORITY_PREFIX = prefixOf(PRIORITY_MARK)
const LOW_PREFIX = prefixOf(LOW_MARK)

/** Does this title carry the cloud mark? */
export function hasCloudMark(title: string): boolean {
  return CLOUD_PREFIX.test(title)
}

/** Title with every cloud mark removed (idempotent, touches nothing else). */
export function withoutCloudMark(title: string): string {
  let result = title
  for (;;) {
    const next = result.replace(CLOUD_PREFIX, "")
    if (next === result) return result
    result = next
  }
}

/** Title carrying (or not) the cloud mark, with every other mark left in place. */
export function withCloudMark(title: string, cloud: boolean): string {
  const base = withoutCloudMark(title)
  return cloud ? `${CLOUD_MARK}${base}` : base
}

/** Run `transform` on the title after the cloud mark, then put the mark back. */
function afterCloud(title: string, transform: (text: string) => string): string {
  const cloud = hasCloudMark(title)
  const next = transform(withoutCloudMark(title))
  return cloud ? `${CLOUD_MARK}${next}` : next
}

/** The level a title carries: its leading mark, or ordinary when it has none. */
export function levelOfTitle(title: string): PriorityLevel {
  const text = withoutCloudMark(title)
  if (PRIORITY_PREFIX.test(text)) return "high"
  if (LOW_PREFIX.test(text)) return "low"
  return "normal"
}

/** Title with every level mark removed (idempotent, touches nothing else). */
export function withoutLevelMark(title: string): string {
  return afterCloud(title, (text) => {
    let result = text
    for (;;) {
      const next = result.replace(PRIORITY_PREFIX, "").replace(LOW_PREFIX, "")
      if (next === result) return result
      result = next
    }
  })
}

/** Title carrying exactly this level's mark (idempotent; `normal` removes both). */
export function withLevelMark(title: string, level: PriorityLevel): string {
  const cloud = hasCloudMark(title) ? CLOUD_MARK : ""
  const mark = markFor(level)
  const base = withoutLevelMark(withoutCloudMark(title))
  return `${cloud}${mark ? `${mark} ` : ""}${base}`
}

/** Title with the priority mark added (idempotent). A `▽` is replaced: a session
 *  is at one level at a time. */
export function withPriorityMark(title: string): string {
  return withLevelMark(title, "high")
}

/** Title with the priority mark removed (idempotent, touches nothing else). */
export function withoutPriorityMark(title: string): string {
  return afterCloud(title, (text) => text.replace(PRIORITY_PREFIX, ""))
}

/** Does this title carry the priority mark? */
export function hasPriorityMark(title: string): boolean {
  return PRIORITY_PREFIX.test(withoutCloudMark(title))
}

/** Title with the low-priority mark added (idempotent; replaces a `⚡`). */
export function withLowMark(title: string): string {
  return withLevelMark(title, "low")
}

/** Title with the low-priority mark removed (idempotent, touches nothing else). */
export function withoutLowMark(title: string): string {
  return afterCloud(title, (text) => text.replace(LOW_PREFIX, ""))
}

/** Does this title carry the low-priority mark? */
export function hasLowMark(title: string): boolean {
  return LOW_PREFIX.test(withoutCloudMark(title))
}

/**
 * Matches the whole waiting prefix, not just the emoji: `⏳ 2/3 · 3h10m · `,
 * `⏳ 3m · `, the Russian wording older versions wrote (`⏳ ждёт · `,
 * `⏳ 4 мин · `), and the bare `⏳ `. Applied in a loop, so a title that was
 * marked twice is still cleaned up. The two capture groups are the place in the
 * queue (`state.ts` reads them from a title that has no metadata).
 */
export const WAIT_PREFIX =
  /^⏳ (?:(?:(\d+)\/(\d+)) · )?(?:(?:\d+h(?:\d+m)?|\d+m|\d+ мин|\d+ ч(?: \d+ мин)?|ждёт) · )?/

/** Where a waiting session stands: `position` of `total` waiters, 1-based. */
export type QueuePlace = { position: number; total: number }

/** Compact wait label for the title: "" under a minute, "26m", "3h10m",
 *  prefixed by "2/3 · " when the session is not alone in the queue. */
export function formatWait(waitedMs: number, place?: QueuePlace): string {
  const minutes = Math.floor(Math.max(0, waitedMs) / 60_000)
  const parts: string[] = []
  if (place && place.total > 1) parts.push(`${place.position}/${place.total}`)
  if (minutes >= 60) parts.push(`${Math.floor(minutes / 60)}h${minutes % 60 ? `${minutes % 60}m` : ""}`)
  else if (minutes >= 1) parts.push(`${minutes}m`)
  return parts.join(" · ")
}

/** Original title with every waiting prefix removed. A leading level mark is not
 *  a waiting prefix: it stays where it is. */
export function stripWaitPrefix(title: string): string {
  const cloud = hasCloudMark(title)
  const mark = markFor(levelOfTitle(title))
  let result = withoutLevelMark(withoutCloudMark(title))
  while (WAIT_PREFIX.test(result)) result = result.replace(WAIT_PREFIX, "")
  return `${cloud ? CLOUD_MARK : ""}${mark ? `${mark} ${result}` : result}`
}

/** Title of a waiting session: `⏳ 2/3 · 3h10m · <title>`, or `⚡ ⏳ …` / `▽ ⏳ …`
 *  when it is waiting *and* flagged. The level defaults to whatever the title
 *  already carries; pass it explicitly to move the session in the same write.
 *  `true`/`false` are accepted for the two-level callers (`true` = `high`). */
export function withWaitPrefix(
  title: string,
  waitedMs: number,
  place?: QueuePlace,
  level: PriorityLevel | boolean = levelOfTitle(title),
): string {
  const cloud = hasCloudMark(title)
  const base = withoutCloudMark(withoutLevelMark(stripWaitPrefix(title)))
  const label = formatWait(waitedMs, place)
  const mark = markFor(level === true ? "high" : level === false ? "normal" : level)
  return `${cloud ? CLOUD_MARK : ""}${mark ? `${mark} ` : ""}${WAITING_MARK}${label ? `${label} · ` : ""}${base}`
}
