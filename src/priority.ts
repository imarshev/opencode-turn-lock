// priority.ts — the queue levels of the plugin, and nothing else.
//
// Three levels decide where a session stands: high (`⚡`) cuts the queue,
// ordinary carries no flag, low (`▽`) waits behind everyone. This module owns
// the vocabulary (the level type, its mark, its rank against the others), the
// `/prio` argument, and the order two waiters are served in. It is pure: no fs,
// no OpenCode, so the server half and the GUI can both import it and
// `node --test` can load it without a build.
//
// The title grammar that carries the mark lives in title.ts; the flag file that
// records the user's choice lives in priority-store.ts.

/** The queue levels, best first. `normal` is the absence of a flag: no sidecar
 *  file, no mark in the title. */
export type PriorityLevel = "low" | "normal" | "high"

/** The levels, worst first — the same direction as `PRIORITY_RANK`. */
export const LEVELS = ["low", "normal", "high"] as const satisfies readonly PriorityLevel[]

const rankMap = (levels: readonly PriorityLevel[]): Record<PriorityLevel, number> =>
  Object.fromEntries(levels.map((level, index) => [level, index])) as Record<PriorityLevel, number>

/** What one level is worth against another: `high` beats `normal` beats `low`. */
export const PRIORITY_RANK = rankMap(LEVELS)

/** The visual order the inbox draws: high first, then ordinary, then low. It is
 *  the inverse of `PRIORITY_RANK`, derived from it so the two cannot drift. */
export const LEVEL_RANK = rankMap([...LEVELS].reverse())

/** Prefix of a session the user needs now: it cuts the queue and takes the next
 *  free slot. It sits outside the waiting prefix, so a priority session that is
 *  itself queued reads as `⚡ ⏳ 2/3 · 26m · <title>`. */
export const PRIORITY_MARK = "⚡"

/** Prefix of a session that should wait last: it stands behind every ordinary
 *  waiter and gives its slot up to them, so `▽ ⏳ 3/3 · 26m · <title>`. */
export const LOW_MARK = "▽"

/** The mark of a level in a session title; ordinary carries none. */
export function markFor(level: PriorityLevel): string {
  return level === "high" ? PRIORITY_MARK : level === "low" ? LOW_MARK : ""
}

/** Is this value one of the three level names? */
export function isLevel(value: unknown): value is PriorityLevel {
  return typeof value === "string" && (LEVELS as readonly string[]).includes(value)
}

/** The order one click on the pill moves through: ordinary → `⚡` → `▽` → ordinary. */
export const LEVEL_CYCLE: Record<PriorityLevel, PriorityLevel> = { normal: "high", high: "low", low: "normal" }

/** The level after one click on the pill. */
export function nextLevel(level: PriorityLevel): PriorityLevel {
  return LEVEL_CYCLE[level]
}

/** A bare `/prio` keeps its two-level meaning: on, unless the session is `⚡`. */
export function toggleLevel(level: PriorityLevel): PriorityLevel {
  return level === "high" ? "normal" : "high"
}

/**
 * Reads the intent out of a command's text: `/prio`, `/prio on`, `/prio low`.
 * Tolerates both shapes a client may hand over — just the arguments, or the
 * whole line including the command name — because that is not specified.
 * `toggle` is the bare `/prio` of the two-level days: it still means "on unless
 * this session is already `⚡`", so an old habit keeps working and `low` is only
 * ever asked for by name.
 */
export function parsePriorityArgument(text: string, command: string): PriorityLevel | "toggle" {
  let argument = String(text ?? "").trim().toLowerCase()
  const name = String(command ?? "").toLowerCase()
  for (const prefix of [`/${name}`, name]) {
    if (argument === prefix) return "toggle"
    if (argument.startsWith(`${prefix} `)) {
      argument = argument.slice(prefix.length + 1).trim()
      break
    }
  }
  if (/^(off|remove|false|0|no|normal|ordinary|mid|middle|medium|default|base)$/.test(argument)) return "normal"
  if (/^(low|lo|down|bottom|least|min|background)$/.test(argument)) return "low"
  if (/^(on|add|true|1|yes|high|hi|up|max|first|priority|urgent)$/.test(argument)) return "high"
  return "toggle"
}

/**
 * One waiter as the queue sees it: the session, the rank of the level it is
 * served at, and the age that orders it against its own level. The age is the
 * absolute creation time of the session (`session.time.created`): a session that
 * comes back after a tool is still older than everyone who queued while it
 * worked. A flag only supplies the level; inside a level the oldest session is
 * served first.
 *
 * Two optional overrides come from a *return ticket* (a session released its
 * slot at a step boundary and is coming back for the next request):
 * `boost` is the moment the session released — a returning session with a
 * "lifted" ticket goes to the front of its level, ordered among its boosted
 * fellows by release time; `defer` marks a returning session whose ticket is
 * not yet lifted — it waits behind everyone while its slot handoff settles. A
 * session is never both boosted and deferred.
 */
export type QueueEntry = { sid: string; rank: number; age: number; boost?: number; defer?: boolean }

/** A queue entry for `sid` at `level`, ordered by `age`. */
export function levelEntry(sid: string, level: PriorityLevel, age: number): QueueEntry {
  return { sid, rank: PRIORITY_RANK[level], age }
}

/** Whether `left` is served before `right` inside the same level: a boosted
 *  session first (ordered by release time, earliest first), then a plain one,
 *  then a deferred one, then by age, then by id. */
export function beforeInLevel(left: QueueEntry, right: QueueEntry): boolean {
  const leftBoost = left.boost !== undefined
  const rightBoost = right.boost !== undefined
  if (leftBoost !== rightBoost) return leftBoost
  if (leftBoost && rightBoost && left.boost !== right.boost) return (left.boost ?? 0) < (right.boost ?? 0)
  const leftDefer = left.defer === true
  const rightDefer = right.defer === true
  if (leftDefer !== rightDefer) return !leftDefer
  if (left.age !== right.age) return left.age < right.age
  return left.sid < right.sid
}

/** The order waiters are served in: better level, then the in-level order
 *  (`beforeInLevel`), then id. The id keeps two identical entries deterministic
 *  across processes. */
export function compareQueue(left: QueueEntry, right: QueueEntry): number {
  const rank = right.rank - left.rank
  if (rank !== 0) return rank
  if (beforeInLevel(left, right)) return -1
  if (beforeInLevel(right, left)) return 1
  return 0
}

/** Waiters of a strictly better level than `rank`: they take the next free slot
 *  first, and a holder of `rank` gives its own slot up to them. */
export function outranking(entries: readonly QueueEntry[], sid: string, rank: number): QueueEntry[] {
  return entries.filter((entry) => entry.sid !== sid && entry.rank > rank)
}

/** Waiters of the same level that go before `self`, in the exact serving order
 *  (`beforeInLevel`). These are the places the FIFO grace windows protect. */
export function aheadInLevel(entries: readonly QueueEntry[], self: QueueEntry): QueueEntry[] {
  return entries.filter(
    (entry) => entry.sid !== self.sid && entry.rank === self.rank && beforeInLevel(entry, self),
  )
}
