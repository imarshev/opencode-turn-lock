// turn-lock (OpenCode V2 plugin) — hold at most N local-agent sessions on the
// model engine; every other session waits before its model request is sent.
//
// Why: the local engine (strata on 18500) serves one request at a time and
// switches context per request, so N interleaved agent sessions thrash the
// conversation cache. This plugin serialises *turns* per session: a session
// takes a lease on its first gated request and keeps it until its run ends
// (idle / success / failure / interrupt / delete / question), so a goal in one
// session runs to completion before the next session is admitted.
//
// Cloud providers are never gated: the `context` hook checks the provider of
// the outgoing request and returns immediately unless it is local. Auxiliary
// request kinds (`title`, `summary`/`compaction`, `generate`) are not hooked at
// all, so cloud sessions and local bookkeeping calls are never delayed.
//
// Subagents are never gated on their own: a subagent session inherits the
// verdict of its parent. If the parent holds a slot the child is covered (and
// refreshes the parent's lease); if the parent run is not gated (cloud) the
// child is exempt too. Without this, a local parent waiting for its own
// subagent would queue behind itself.
//
// A queued session used to get a synthetic "turn-lock: в очереди" message in
// its inbox. That message is invisible while the session waits (a queued
// request is held inside the `context` hook, so there is no step boundary that
// would drain the inbox), and once the slot is granted the inbox is flushed into
// the transcript — where the model reads the notice as user input and answers
// it. So the plugin no longer writes into sessions at all.
//
// Visibility comes from the one field every client renders: the title. A queued
// session's title is prefixed with "⏳ " while it waits and restored on
// grant/release (`markWaitingTitle`, on by default). The server reports a queued
// session exactly like a working one (`running`), so this prefix is the only
// signal the session list can show.
//
// Priority (`/prio`, marked "⚡ " or "▽ " in the title) answers "the priorities
// changed: I need a newer session's result first" without stopping anything.
// Three levels — high (`⚡`), ordinary (no mark) and low (`▽`) — and two rules:
// a session takes a free slot only while no session of a *higher* level queues
// behind it, and a session that already holds a slot gives it up at its *next
// step boundary* — never in the middle of a model or tool call — to a waiter of
// a higher level. The preempted session re-queues itself and resumes on its own,
// so work continues unattended.
//
// Configuration (optional), highest precedence last:
//   built-in defaults
//   ~/.config/opencode/turn-lock.json
//   plugins[].options in opencode.json  ->  ctx.options
//
//   {
//     "enabled": true,
//     "limit": 2,                       // concurrent local sessions
//     "localProviders": ["strata"],     // provider ids treated as local
//     "localHosts": ["127.0.0.1", "localhost", "::1", "0.0.0.0"],
//     "acquireTimeoutMs": 14400000,     // 4 h: max wait before onTimeout applies
//     "onTimeout": "proceed",           // "proceed" (fail-open) | "hold"
//     "leaseTimeoutMs": 7200000,        // lease without refresh = abandoned
//     "pollMs": 1000,
//     "refreshEveryMs": 20000,
//     "sweepMs": 60000,
//     "releaseOnForm": true,            // a `question` tool form frees the slot
//     "releaseOnPermission": true,      // a permission prompt frees the slot
//     "remindEveryMs": 60000,           // title countdown tick + log line for a long wait
//     "markWaitingTitle": true,         // prefix the session title with "⏳ " while it waits
//     "titleMarks": "waiting",          // "all" (⚡/▽/☁️/⏳) | "waiting" (⏳ only) | "none"
//     "stateMetadata": true,            // write level/cloud/place into session.metadata
//     "priorityEnabled": true,          // /prio: ⚡ cuts the queue, ▽ stands at the back of it
//     "priorityCommand": "prio",        // the slash command that sets the level
//     "priorityTtlMs": 86400000,        // a forgotten ⚡ or ▽ stops working after this long
//     "dir": "%TEMP%/opencode/turn-lock",
//     "logFile": "%TEMP%/opencode/turn-lock.log",
//     "logLevel": "info"                // "off" | "info" | "debug"
//   }

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { Plugin } from "@opencode/plugin"

import { createTurnLock, type ChangeEvent } from "./core.ts"
import { CLOUD_MARK, readState, withState, type TurnLockState } from "./state.ts"
import { fileStore, processAlive } from "./store-file.ts"

// Which copy of the plugin is running. A loose file in ~/.config/opencode/plugins
// and a package install of this project both load code that looks identical, so
// the `ready:` log line names its own source.
const SOURCE = (() => {
  try {
    return fileURLToPath(import.meta.url)
  } catch {
    return "unknown"
  }
})()

export type TurnLockConfig = {
  enabled: boolean
  limit: number
  localProviders: string[]
  localHosts: string[]
  acquireTimeoutMs: number
  onTimeout: "proceed" | "hold"
  leaseTimeoutMs: number
  pollMs: number
  refreshEveryMs: number
  sweepMs: number
  releaseOnForm: boolean
  releaseOnPermission: boolean
  remindEveryMs: number
  markWaitingTitle: boolean
  /** Which marks the server writes into the title. `waiting` keeps `⏳ 2/5 · 9m ·`
   *  (the only queue signal a client without the plugin can see) and leaves the
   *  priority and cloud marks to the UI, which reads them from metadata. */
  titleMarks: "all" | "waiting" | "none"
  /** Write `{level, cloud, position, total}` into `session.metadata`. */
  stateMetadata: boolean
  priorityEnabled: boolean
  priorityCommand: string
  priorityTtlMs: number
  dir: string
  logFile: string
  logLevel: "off" | "info" | "debug"
}

export const DEFAULTS: TurnLockConfig = {
  enabled: true,
  limit: 2,
  localProviders: ["strata"],
  localHosts: ["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0", "::", "[::]"],
  // A long queued turn is normal here: the point is to let one goal finish
  // before the next session is admitted, and goals can take hours. The timeout
  // is only the last-resort anti-deadlock (a live holder refreshes its lease
  // every refreshEveryMs, so a wedged holder is the case it covers).
  acquireTimeoutMs: 4 * 60 * 60_000,
  onTimeout: "proceed",
  leaseTimeoutMs: 2 * 60 * 60_000,
  pollMs: 1_000,
  refreshEveryMs: 20_000,
  sweepMs: 60_000,
  releaseOnForm: true,
  releaseOnPermission: true,
  remindEveryMs: 60_000,
  markWaitingTitle: true,
  // The UI reads the state from metadata; the title keeps only the wait label,
  // so a phone (or any client without the plugin) still sees the queue place.
  titleMarks: "waiting",
  stateMetadata: true,
  priorityEnabled: true,
  priorityCommand: "prio",
  // A forgotten mark must not skew the queue forever: after a day it stops having
  // any effect and its file is dropped on the next read.
  priorityTtlMs: 24 * 60 * 60_000,
  dir: join(tmpdir(), "opencode", "turn-lock"),
  logFile: join(tmpdir(), "opencode", "turn-lock.log"),
  logLevel: "info",
}

/** Leases are released on any of these: the run ended, the session is gone, or
 *  the agent is blocked on the human (question form / permission prompt). */
export const RELEASE_EVENTS = [
  "session.idle",
  "session.status",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.deleted",
  "session.archived",
  "session.inbox.cancelled",
  "form.created",
  "form.replied",
  "form.cancelled",
  "permission.asked",
  "permission.replied",
  "config.updated",
  "provider.updated",
] as const

const EVENT_TYPES = [...RELEASE_EVENTS] as string[]

/** Events after which this session's run is over, so a wait it queued must not
 *  outlive it. `form.*` and `permission.*` are deliberately absent: there the
 *  agent is paused for the human and continues afterwards. */
const END_OF_RUN_EVENTS = new Set<string>([
  "session.status", // only `idle` reaches here: eventSessionID drops busy/retry
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.deleted",
  "session.archived",
])

/** Fields of an OpenCode V2 event the lock cares about. */
type AnyEvent = {
  type?: string
  data?: {
    sessionID?: string
    status?: { type?: string }
    form?: { sessionID?: string }
  }
}

/**
 * Which session an event belongs to, or undefined when the event must not
 * release anything. `session.status` only releases on `idle`: `busy`/`retry`
 * mean the run continues.
 */
export function eventSessionID(event: AnyEvent): string | undefined {
  const type = event?.type
  if (!type) return undefined
  if (type === "session.status") {
    if (event.data?.status?.type !== "idle") return undefined
  }
  const direct = event.data?.sessionID
  if (typeof direct === "string" && direct) return direct
  const form = event.data?.form?.sessionID
  if (typeof form === "string" && form) return form
  return undefined
}

/** Strip line-start `//` comments so a hand-edited config may be commented. */
function parseJsonc(text: string): unknown {
  const stripped = text
    .split(/\r?\n/)
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n")
  return JSON.parse(stripped)
}

function asNumber(value: unknown, fallback: number, min: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= min ? value : fallback
}

function asStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback
  const items = value.filter((item): item is string => typeof item === "string" && item.length > 0)
  return items.length ? items : fallback
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

function mergeConfig(base: TurnLockConfig, raw: unknown): TurnLockConfig {
  if (!raw || typeof raw !== "object") return base
  const value = raw as Record<string, unknown>
  return {
    enabled: asBoolean(value.enabled, base.enabled),
    limit: Math.max(1, Math.floor(asNumber(value.limit, base.limit, 1))),
    localProviders: asStringArray(value.localProviders, base.localProviders),
    localHosts: asStringArray(value.localHosts, base.localHosts).map((host) => host.toLowerCase()),
    acquireTimeoutMs: asNumber(value.acquireTimeoutMs, base.acquireTimeoutMs, 0),
    onTimeout: value.onTimeout === "hold" ? "hold" : value.onTimeout === "proceed" ? "proceed" : base.onTimeout,
    leaseTimeoutMs: asNumber(value.leaseTimeoutMs, base.leaseTimeoutMs, 1_000),
    pollMs: Math.max(5, asNumber(value.pollMs, base.pollMs, 5)),
    refreshEveryMs: Math.max(0, asNumber(value.refreshEveryMs, base.refreshEveryMs, 0)),
    sweepMs: Math.max(1_000, asNumber(value.sweepMs, base.sweepMs, 1_000)),
    releaseOnForm: asBoolean(value.releaseOnForm, base.releaseOnForm),
    releaseOnPermission: asBoolean(value.releaseOnPermission, base.releaseOnPermission),
    markWaitingTitle: asBoolean(value.markWaitingTitle, base.markWaitingTitle),
    titleMarks:
      value.titleMarks === "all" || value.titleMarks === "none" || value.titleMarks === "waiting"
        ? value.titleMarks
        : base.titleMarks,
    stateMetadata: asBoolean(value.stateMetadata, base.stateMetadata),
    remindEveryMs: asNumber(value.remindEveryMs, base.remindEveryMs, 0),
    priorityEnabled: asBoolean(value.priorityEnabled, base.priorityEnabled),
    priorityCommand:
      typeof value.priorityCommand === "string" && /^[A-Za-z0-9_-]+$/.test(value.priorityCommand)
        ? value.priorityCommand
        : base.priorityCommand,
    priorityTtlMs: asNumber(value.priorityTtlMs, base.priorityTtlMs, 1_000),
    dir: typeof value.dir === "string" && value.dir ? value.dir : base.dir,
    logFile: typeof value.logFile === "string" && value.logFile ? value.logFile : base.logFile,
    logLevel: value.logLevel === "off" || value.logLevel === "debug" ? value.logLevel : base.logLevel,
  }
}

/**
 * Resolve the effective configuration: defaults <- turn-lock.json <- plugin
 * options. Unreadable or malformed files are ignored (defaults win) so a bad
 * config can never take the agent down.
 */
export function resolveConfig(options: unknown, configPath = join(homedir(), ".config", "opencode", "turn-lock.json")): TurnLockConfig {
  let config = DEFAULTS
  try {
    if (existsSync(configPath)) config = mergeConfig(config, parseJsonc(readFileSync(configPath, "utf8")))
  } catch {
    // ignore a broken user config
  }
  return mergeConfig(config, options)
}

const IPV4_LOOPBACK = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/

/** Is this URL served by a local engine? undefined when the URL is unparseable. */
export function isLocalBaseUrl(base: string | undefined, localHosts: string[]): boolean | undefined {
  if (typeof base !== "string" || !base) return undefined
  let host: string
  try {
    host = new URL(base).hostname.toLowerCase()
  } catch {
    return undefined
  }
  if (!host) return undefined
  if (localHosts.includes(host)) return true
  if (IPV4_LOOPBACK.test(host)) return true
  return false
}

function readBaseUrl(info: unknown): string | undefined {
  if (!info || typeof info !== "object") return undefined
  const record = info as Record<string, any>
  const nested = record.provider && typeof record.provider === "object" ? record.provider : undefined
  const candidates = [record, nested].filter(Boolean)
  for (const candidate of candidates) {
    const settings = candidate.settings
    if (settings && typeof settings === "object") {
      for (const key of ["baseURL", "baseUrl", "base_url"]) {
        if (typeof settings[key] === "string") return settings[key]
      }
    }
    for (const key of ["baseURL", "baseUrl", "base_url"]) {
      if (typeof candidate[key] === "string") return candidate[key]
    }
    const body = candidate.body
    if (body && typeof body === "object" && typeof body.baseURL === "string") return body.baseURL
  }
  return undefined
}

/** Prefix a queued session's title with this, so any session list shows it is waiting. */
export const WAITING_MARK = "⏳ "

/** Prefix of a session the user needs now: it cuts the queue and takes the next
 *  free slot. It sits outside the waiting prefix, so a priority session that is
 *  itself queued reads as `⚡ ⏳ 2/3 · 26m · <title>`. */
export const PRIORITY_MARK = "⚡"

/** Prefix of a session that should wait last: it stands behind every ordinary
 *  waiter and gives its slot up to them, so `▽ ⏳ 3/3 · 26m · <title>`. */
export const LOW_MARK = "▽"

/** The queue levels, best first. `normal` is the absence of a flag: no sidecar
 *  file, no mark in the title. */
export type PriorityLevel = "low" | "normal" | "high"

/** What one level is worth against another: `high` beats `normal` beats `low`. */
export const PRIORITY_RANK: Record<PriorityLevel, number> = { low: 0, normal: 1, high: 2 }

/** The mark of a level in a session title; ordinary carries none. */
export function markFor(level: PriorityLevel): string {
  return level === "high" ? PRIORITY_MARK : level === "low" ? LOW_MARK : ""
}

/** The level mark plus the space the two marks are joined by, if any. */
const PRIORITY_PREFIX = /^⚡ ?/
const LOW_PREFIX = /^▽ ?/
/** The cloud mark the server writes ahead of everything (`titleMarks: "all"`). */
const CLOUD_PREFIX = /^☁️ ?/

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
 * marked twice is still cleaned up.
 */
const WAIT_PREFIX =
  /^⏳ (?:(?:\d+\/\d+) · )?(?:(?:\d+h(?:\d+m)?|\d+m|\d+ мин|\d+ ч(?: \d+ мин)?|ждёт) · )?/

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
 * True for a synthetic transcript entry this plugin posted. Older versions
 * queued "turn-lock" notices into the session inbox; those become real messages
 * at the next step boundary and the model then answers them, so they must never
 * reach the request (`delivery: "queue"` does not keep them out of the context).
 */
export function isTurnLockNotice(message: unknown): boolean {
  if (!message || typeof message !== "object") return false
  const record = message as { type?: unknown; text?: unknown; metadata?: unknown }
  if (record.type !== "synthetic") return false
  const metadata = record.metadata as { plugin?: unknown } | undefined
  if (metadata?.plugin === "turn-lock") return true
  return typeof record.text === "string" && /^[⏳▶⚠] turn-lock:/.test(record.text)
}

export default Plugin.define({
  id: "turn-lock",
  async setup(ctx: any) {
    const config = resolveConfig(ctx?.options)
    const log = (level: "info" | "debug" | "warn", message: string) => {
      if (config.logLevel === "off") return
      if (level === "debug" && config.logLevel !== "debug") return
      try {
        mkdirSync(dirname(config.logFile), { recursive: true })
        try {
          if (existsSync(config.logFile) && statSync(config.logFile).size > 2_000_000) writeFileSync(config.logFile, "")
        } catch {
          // rotation is best-effort
        }
        appendFileSync(config.logFile, `${new Date().toISOString()} ${level.toUpperCase()} ${message}\n`, "utf8")
      } catch {
        // never let logging break the agent
      }
    }

    if (!config.enabled) {
      log("info", "disabled by config")
      return
    }

    const store = fileStore(config.dir)
    const pruned = store.pruneDead(processAlive)
    const held = new Set<string>()
    const owner = String(ctx?.location?.directory ?? "")

    // Queue visibility. Session lists render a title, and the server reports a
    // queued session exactly like a working one (`running`), so the wait is
    // marked on the title: "⏳ <title>" while queued, restored on grant. The
    // sidecar file `<sid>.wait.json` records the mark so a crash or hot reload
    // cannot leave a session labelled forever.
    const marked = new Set<string>()
    const marking = new Set<string>()
    // Sessions this instance is queueing right now. A wait lives in its own
    // polling loop, not in a lease: it ends on a grant, on the 4h timeout, or
    // when someone cancels it. So both ends of that loop have to be owned —
    // the turn ending (see END_OF_RUN_EVENTS) and this instance unloading.
    const waiting = new Set<string>()
    const waitEpoch = new Map<string, number>()
    const epochOf = (sid: string) => waitEpoch.get(sid) ?? 0
    const waitPath = (sid: string) => join(config.dir, `${sid.replace(/[^A-Za-z0-9_.-]/g, "_")}.wait.json`)

    const canEditTitle = (): boolean =>
      typeof ctx?.session?.get === "function" && typeof ctx?.session?.update === "function"

    // Machine-readable state, next to the title. `session.metadata` is a real
    // field (`GET /api/session` returns it), so the UI can read a structured
    // value instead of parsing a title, and the user's title stays clean. The
    // cache keeps the per-step hook from re-reading the session on every
    // request; an error drops the entry, so the next call starts from the
    // server's copy again. A session's metadata is ours to extend, not to own:
    // every other key is carried over untouched.
    type StatePatch = {
      level?: PriorityLevel
      cloud?: boolean | null
      position?: number | null
      total?: number | null
      since?: number | null
    }
    const metaCache = new Map<string, { metadata: Record<string, unknown>; state: TurnLockState }>()

    const applyPatch = (state: TurnLockState, patch: StatePatch): TurnLockState => {
      const next: TurnLockState = { ...state }
      if (patch.level) next.level = patch.level
      for (const key of ["cloud", "position", "total", "since"] as const) {
        const value = patch[key]
        if (value === undefined) continue
        if (value === null) delete next[key]
        else (next as Record<string, unknown>)[key] = value
      }
      return next
    }

    // Two writers can race on one session (a level switch while the wait tick
    // writes the place), and each writes the whole metadata object. Chaining the
    // writes per session makes every patch land on the previous result instead
    // of overwriting it with a stale copy.
    const stateQueue = new Map<string, Promise<void>>()

    const writeState = async (sid: string, patch: StatePatch): Promise<void> => {
      try {
        let entry = metaCache.get(sid)
        if (!entry) {
          const info: any = await ctx.session.get({ sessionID: sid })
          const metadata =
            info?.metadata && typeof info.metadata === "object" ? { ...(info.metadata as Record<string, unknown>) } : {}
          entry = { metadata, state: readState(metadata) ?? { level: "normal" } }
          metaCache.set(sid, entry)
        }
        const next = applyPatch(entry.state, patch)
        if (JSON.stringify(next) === JSON.stringify(entry.state)) return
        const metadata = withState(entry.metadata, next)
        await ctx.session.update({ sessionID: sid, metadata })
        metaCache.set(sid, { metadata, state: next })
      } catch (error) {
        metaCache.delete(sid)
        log("debug", `state ${sid}: ${String(error)}`)
      }
    }

    const syncState = (sid: string, patch: StatePatch): Promise<void> => {
      if (!config.stateMetadata || !canEditTitle()) return Promise.resolve()
      const previous = stateQueue.get(sid) ?? Promise.resolve()
      const next = previous.then(() => writeState(sid, patch))
      stateQueue.set(sid, next)
      void next.finally(() => {
        if (stateQueue.get(sid) === next) stateQueue.delete(sid)
      })
      return next
    }

    // The cloud mark in the title is only for `titleMarks: "all"`; the metadata
    // flag is written either way, so the UI always knows.
    const cloudMarked = new Map<string, boolean>()
    const applyCloudTitle = async (sid: string, cloud: boolean): Promise<void> => {
      if (config.titleMarks !== "all" || cloudMarked.get(sid) === cloud || !canEditTitle()) return
      cloudMarked.set(sid, cloud)
      try {
        const info: any = await ctx.session.get({ sessionID: sid })
        const title = typeof info?.title === "string" ? info.title : ""
        if (!title) return
        const next = withCloudMark(title, cloud)
        if (next !== title) await ctx.session.update({ sessionID: sid, title: next })
      } catch (error) {
        cloudMarked.delete(sid)
        log("debug", `cloud ${sid}: ${String(error)}`)
      }
    }

    const readWaitMark = (sid: string): { pid?: number; owner?: string; since?: number; markedAt?: number } | undefined => {
      try {
        const value = JSON.parse(readFileSync(waitPath(sid), "utf8"))
        return value && typeof value === "object"
          ? (value as { pid?: number; owner?: string; since?: number; markedAt?: number })
          : undefined
      } catch {
        return undefined
      }
    }

    const dropWaitMark = (sid: string) => {
      try {
        if (existsSync(waitPath(sid))) unlinkSync(waitPath(sid))
      } catch {
        // best-effort
      }
    }

    const writeWaitMark = (sid: string, since: number) => {
      try {
        mkdirSync(config.dir, { recursive: true })
        writeFileSync(
          waitPath(sid),
          JSON.stringify({ sid, pid: process.pid, owner, since, markedAt: Date.now() }),
          "utf8",
        )
      } catch {
        // the title mark still works without the sidecar
      }
    }

    /** Everyone waiting right now, oldest first. The sidecars are the only
     *  shared record of waiters (the store holds granted leases only), so the
     *  queue position is derived from them; a waiter whose process is gone is
     *  ignored. This is the wait order, not a guaranteed FIFO — slots are taken
     *  by whoever wakes first. */
    const readWaiters = (): Array<{ sid: string; since: number }> => {
      let names: string[]
      try {
        names = readdirSync(config.dir)
      } catch {
        return []
      }
      const waiters: Array<{ sid: string; since: number }> = []
      for (const name of names) {
        if (!name.endsWith(".wait.json")) continue
        const sid = name.slice(0, -".wait.json".length)
        const mark = readWaitMark(sid)
        if (!mark) continue
        const pid = typeof mark.pid === "number" ? mark.pid : undefined
        if (pid !== undefined && pid !== process.pid && !processAlive(pid)) continue
        const since = typeof mark.since === "number" ? mark.since : typeof mark.markedAt === "number" ? mark.markedAt : 0
        waiters.push({ sid, since })
      }
      return waiters.sort((a, b) => a.since - b.since || a.sid.localeCompare(b.sid))
    }

    const placeOf = (sid: string, since: number): QueuePlace => {
      const order = orderedWaiters(sid, since)
      const index = order.indexOf(sid)
      return { position: index + 1, total: order.length }
    }

    // Priority. `<sessionID>.prio.json` is the shared record of where the user
    // wants this session to stand in the queue: `/prio` writes it from any client,
    // every process sharing the lock directory reads it. `level` is `high` (⚡, cuts
    // the queue) or `low` (▽, stands at the back of it); no file means ordinary.
    // A flag is inert while its session neither waits nor holds a slot, so a
    // forgotten mark costs nothing — and it expires anyway after priorityTtlMs.
    const prioPath = (sid: string) => join(config.dir, `${sid.replace(/[^A-Za-z0-9_.-]/g, "_")}.prio.json`)

    /** A recorded flag: which end of the queue the session asked for, and since when. */
    type PriorityFlag = { level: Exclude<PriorityLevel, "normal">; since: number }

    const dropPriority = (sid: string) => {
      try {
        if (existsSync(prioPath(sid))) unlinkSync(prioPath(sid))
      } catch {
        // best-effort
      }
    }

    const readPriority = (sid: string): PriorityFlag | undefined => {
      if (!config.priorityEnabled) return undefined
      try {
        const value = JSON.parse(readFileSync(prioPath(sid), "utf8"))
        const since = typeof value?.since === "number" ? value.since : 0
        if (!since) return undefined
        if (Date.now() - since > config.priorityTtlMs) {
          dropPriority(sid)
          return undefined
        }
        // Ordinary is the absence of a flag: a file saying so is stale, and a file
        // without `level` was written before levels existed — it meant `⚡` then.
        if (value?.level === "normal") {
          dropPriority(sid)
          return undefined
        }
        return { level: value?.level === "low" ? "low" : "high", since }
      } catch {
        return undefined
      }
    }

    /** Asks for `level` in the queue; ordinary is the absence of a flag. */
    const writePriority = (sid: string, level: PriorityLevel) => {
      if (level === "normal") {
        dropPriority(sid)
        return
      }
      try {
        mkdirSync(config.dir, { recursive: true })
        writeFileSync(
          prioPath(sid),
          JSON.stringify({ sid, pid: process.pid, owner, since: Date.now(), level }),
          "utf8",
        )
      } catch {
        // priority is best-effort: without the file the session simply stays ordinary
      }
    }

    /** The level this session asked for, read from the shared flag. */
    const levelOf = (sid: string): PriorityLevel => {
      const flag = readPriority(sid)
      return flag ? flag.level : "normal"
    }

    const rankOf = (sid: string): number => PRIORITY_RANK[levelOf(sid)]

    /** Everyone queued right now, with the level they will be served at. `age` is
     *  what orders two waiters of one level: the moment the flag was set for a
     *  flagged one, the moment they started waiting for an ordinary one. A waiter
     *  that already holds a slot is being served, so it is not in this list. */
    const rankedWaiters = (): Array<{ sid: string; rank: number; age: number }> => {
      const ranked: Array<{ sid: string; rank: number; age: number }> = []
      for (const waiter of readWaiters()) {
        if (store.read(waiter.sid)) continue
        const flag = readPriority(waiter.sid)
        ranked.push(
          flag
            ? { sid: waiter.sid, rank: PRIORITY_RANK[flag.level], age: flag.since }
            : { sid: waiter.sid, rank: PRIORITY_RANK.normal, age: waiter.since },
        )
      }
      return ranked
    }

    /** Waiters of a strictly better level than `rank`: they take the next free slot
     *  first, and a holder of `rank` gives its own slot up to them. */
    const waitingAbove = (rank: number, except?: string) =>
      rankedWaiters().filter((waiter) => waiter.sid !== except && waiter.rank > rank)

    /** May `sid` take a free slot? No, while anyone goes before it: a better level,
     *  or the older flag inside the level it is flagged at. Two ordinary waiters
     *  have never been ordered against each other — the slot is the first one awake. */
    const holdsBack = (sid: string): boolean => {
      const flag = readPriority(sid)
      const mine = flag ? PRIORITY_RANK[flag.level] : PRIORITY_RANK.normal
      for (const waiter of rankedWaiters()) {
        if (waiter.sid === sid) continue
        if (waiter.rank > mine) return true
        if (!flag || waiter.rank !== mine) continue
        if (waiter.age < flag.since || (waiter.age === flag.since && waiter.sid < sid)) return true
      }
      return false
    }

    /** The queue in the order it will actually be served: the best level first
     *  (`⚡`, then ordinary, then `▽`), inside a level by the age that orders it.
     *  `sid` is included even before its sidecar exists, so a place is always defined. */
    const orderedWaiters = (sid?: string, since = 0): string[] => {
      const entries = new Map<string, { rank: number; age: number }>()
      const put = (id: string, flag: PriorityFlag | undefined, waited: number) =>
        entries.set(id, flag ? { rank: PRIORITY_RANK[flag.level], age: flag.since } : { rank: PRIORITY_RANK.normal, age: waited })
      for (const waiter of readWaiters()) put(waiter.sid, readPriority(waiter.sid), waiter.since)
      if (sid) put(sid, readPriority(sid), since)
      return [...entries.entries()]
        .sort((a, b) => b[1].rank - a[1].rank || a[1].age - b[1].age || a[0].localeCompare(b[0]))
        .map(([id]) => id)
    }

    /** `/prio` in the session's composer. A command callback runs immediately
     *  and is not a model request, so it also reaches a session that is sitting
     *  in the queue — which is exactly when it matters. */
    async function applyLevel(sid: string, level: PriorityLevel): Promise<void> {
      waitEpoch.set(sid, epochOf(sid) + 1) // an in-flight title update must not win
      writePriority(sid, level)
      void syncState(sid, { level })
      const waiting = readWaitMark(sid)
      const waitedMs = waiting && typeof waiting.since === "number" ? Date.now() - waiting.since : undefined
      if (waitedMs !== undefined) {
        await markWaiting(sid, waitedMs) // rebuilds `⚡ ⏳ 2/3 · 4m · …` in one go
      } else if (canEditTitle()) {
        try {
          const info: any = await ctx.session.get({ sessionID: sid })
          const title = typeof info?.title === "string" ? info.title : ""
          // With `titleMarks: "waiting"` the level lives only in the metadata,
          // so a mark left by an older version is removed on the next switch.
          const next = config.titleMarks === "all" ? withLevelMark(title, level) : withoutLevelMark(title)
          if (title && next !== title) await ctx.session.update({ sessionID: sid, title: next })
        } catch (error) {
          log("debug", `priority ${sid}: title update failed: ${String(error)}`)
        }
      }
      log("info", `priority ${sid}: ${level}`)
    }

    /** Records that `sid` is waiting (the sidecar is the only shared record of
     *  the queue) and refreshes its title. Best-effort and unawaited: a slow or
     *  failing update must never delay or break the gate. The title is re-read on
     *  every reminder tick, because a fresh session's title may be generated
     *  after the first mark and would overwrite it, and because the countdown
     *  itself has to move. */
    async function markWaiting(sid: string, waitedMs: number): Promise<void> {
      const since = Date.now() - waitedMs
      writeWaitMark(sid, since)
      const place = placeOf(sid, since)
      void syncState(sid, {
        position: place?.position ?? null,
        total: place?.total ?? null,
        since,
      })
      if (!config.markWaitingTitle || config.titleMarks === "none" || marking.has(sid) || !canEditTitle()) return
      marking.add(sid)
      const epoch = epochOf(sid)
      try {
        const info: any = await ctx.session.get({ sessionID: sid })
        if (epochOf(sid) !== epoch) return // the slot was granted while we looked
        const title = typeof info?.title === "string" ? info.title : ""
        if (!title) return
        // The flag, not the title, decides the mark: /prio can be typed while
        // this session is already queued, and the next tick has to notice.
        const level = config.titleMarks === "all" ? levelOf(sid) : "normal"
        const next = withWaitPrefix(title, waitedMs, place, level)
        if (next === title) {
          marked.add(sid)
          return
        }
        await ctx.session.update({ sessionID: sid, title: next })
        marked.add(sid)
        log("debug", `mark ${sid}: ${formatWait(waitedMs, place)}`)
      } catch (error) {
        marked.delete(sid)
        dropWaitMark(sid)
        log("debug", `mark ${sid} failed: ${String(error)}`)
      } finally {
        marking.delete(sid)
      }
    }

    /** Restore the original title once the wait is over. */
    async function unmarkWaiting(sid: string, reason: string): Promise<void> {
      waitEpoch.set(sid, epochOf(sid) + 1)
      void syncState(sid, { position: null, total: null, since: null })
      const wasMarked = marked.delete(sid)
      if (!wasMarked && !readWaitMark(sid)) return
      if (!canEditTitle()) {
        dropWaitMark(sid)
        return
      }
      try {
        const info: any = await ctx.session.get({ sessionID: sid })
        const title = typeof info?.title === "string" ? info.title : ""
        const base = stripWaitPrefix(title)
        if (base !== title) {
          await ctx.session.update({ sessionID: sid, title: base })
          log("debug", `unmark ${sid}: ${reason}`)
        }
        dropWaitMark(sid)
      } catch (error) {
        // keep the sidecar: the next boot retries the restore
        log("debug", `unmark ${sid} failed: ${String(error)}`)
      }
    }

    /** Restore marks left by a dead process or a previous load of this location.
     *  The sidecar is dropped either way: with `markWaitingTitle` off there is no
     *  title to restore, but the queue must not inherit a phantom waiter. */
    async function restoreStaleMarks(): Promise<number> {
      let names: string[]
      try {
        names = readdirSync(config.dir)
      } catch {
        return 0
      }
      let restored = 0
      for (const name of names) {
        if (!name.endsWith(".wait.json")) continue
        const sid = name.slice(0, -".wait.json".length)
        const mark = readWaitMark(sid)
        if (!mark) continue
        const pid = typeof mark.pid === "number" ? mark.pid : undefined
        if (pid !== undefined && pid !== process.pid && processAlive(pid)) continue
        if (pid === process.pid && mark.owner !== owner) continue
        if (!canEditTitle()) {
          dropWaitMark(sid)
          continue
        }
        try {
          const info: any = await ctx.session.get({ sessionID: sid })
          const title = typeof info?.title === "string" ? info.title : ""
          const base = stripWaitPrefix(title)
          if (base !== title) {
            await ctx.session.update({ sessionID: sid, title: base })
            restored += 1
          }
          dropWaitMark(sid)
        } catch (error) {
          log("debug", `restore ${sid} failed: ${String(error)}`)
        }
      }
      return restored
    }

    const onChange = (event: ChangeEvent) => {
      switch (event.type) {
        case "grant":
          if (event.waited) {
            log(
              "info",
              `grant ${event.sid} after ${Math.round(event.waitedMs / 1000)}s wait (held ${event.held}/${event.limit}${
                event.overLimit ? ", over limit" : ""
              })`,
            )
          } else {
            log("debug", `grant ${event.sid} (held ${event.held}/${event.limit})`)
          }
          void unmarkWaiting(event.sid, "grant")
          break
        case "wait":
          log(
            "info",
            `wait ${event.sid}: ${
              event.blocked === "priority"
                ? `a session of a higher priority takes the next free slot (${event.held}/${event.limit} busy)`
                : `${event.held}/${event.limit} local sessions are busy`
            }${event.waitedMs ? ` (already ${Math.round(event.waitedMs / 1000)}s)` : ""}`,
          )
          void markWaiting(event.sid, event.waitedMs)
          break
        case "release":
          log("info", `release ${event.sid}: ${event.reason} (held ${event.held}/${config.limit})`)
          void unmarkWaiting(event.sid, "release")
          break
        case "cancel":
          log("debug", `cancel wait ${event.sid}: ${event.reason}`)
          void unmarkWaiting(event.sid, "cancel")
          break
        case "stale":
          log("warn", `drop stale lease ${event.sid} (no refresh for ${Math.round(event.ageMs / 1000)}s)`)
          break
        case "timeout":
          log(
            "warn",
            `waited ${Math.round(event.waitedMs / 1000)}s for a slot; ${
              config.onTimeout === "proceed" ? "proceeding over the limit" : "still holding"
            }`,
          )
          break
      }
    }

    // Sessions and their ancestry. Subagent sessions are covered by their
    // parent's slot: a child of a gated session must not queue (it would
    // deadlock the parent that is waiting for it), and a child of an ungated
    // cloud session must not be gated either.
    const parents = new Map<string, string | null>()
    const gateCache = new Map<string, { kind: "root" } | { kind: "covered" | "exempt"; root: string }>()

    const parentOf = async (sid: string): Promise<string | null> => {
      if (parents.has(sid)) return parents.get(sid) ?? null
      let parent: string | null = null
      try {
        const info: any = await ctx.session.get({ sessionID: sid })
        const raw = info?.parentID ?? info?.session?.parentID ?? null
        parent = typeof raw === "string" && raw ? raw : null
      } catch (error) {
        log("debug", `parent lookup failed for ${sid}: ${String(error)}`)
        parent = null
      }
      parents.set(sid, parent)
      return parent
    }

    const resolveGate = async (
      sid: string,
    ): Promise<{ kind: "root" } | { kind: "covered" | "exempt"; root: string }> => {
      const cached = gateCache.get(sid)
      if (cached) return cached
      let decision: { kind: "root" } | { kind: "covered" | "exempt"; root: string } = { kind: "root" }
      let current = await parentOf(sid)
      let depth = 0
      while (current && depth < 8) {
        if (store.read(current)) {
          decision = { kind: "covered", root: current }
          break
        }
        current = await parentOf(current)
        depth += 1
      }
      if (decision.kind === "root") {
        const direct = parents.get(sid)
        if (direct) decision = { kind: "exempt", root: direct }
      }
      gateCache.set(sid, decision)
      return decision
    }

    const lock = createTurnLock({
      store,
      limit: config.limit,
      acquireTimeoutMs: config.acquireTimeoutMs,
      leaseTimeoutMs: config.leaseTimeoutMs,
      pollMs: config.pollMs,
      onTimeout: config.onTimeout,
      remindEveryMs: config.remindEveryMs,
      pid: process.pid,
      owner,
      onChange,
      holdBack: config.priorityEnabled ? holdsBack : undefined,
    })

    // Provider locality, cached until config/provider updates.
    const localCache = new Map<string, boolean>()
    const isLocalProvider = async (providerID: string | undefined): Promise<boolean> => {
      if (!providerID) return false
      if (config.localProviders.includes(providerID)) return true
      const cached = localCache.get(providerID)
      if (cached !== undefined) return cached
      let local = false
      try {
        const info = await ctx.provider.get({ providerID })
        const verdict = isLocalBaseUrl(readBaseUrl(info), config.localHosts)
        // An unknown provider is treated as remote: the cloud guarantee wins.
        local = verdict === true
        log("debug", `provider ${providerID}: baseURL=${readBaseUrl(info) ?? "(none)"} local=${local}`)
      } catch (error) {
        local = false
        log("debug", `provider ${providerID}: lookup failed (${String(error)}), treated as remote`)
      }
      localCache.set(providerID, local)
      return local
    }

    // The gate itself. `context` runs for the agent loop only (including
    // tool-driven continuations); title/summary/compaction/generate are other
    // hooks and are never delayed by this plugin.
    await ctx.session.hook(
      "context",
      async (event: { sessionID?: string; model?: { providerID?: string }; messages?: unknown[] }) => {
        const sid = event?.sessionID
        if (!sid) return
        // Defence in depth: a "turn-lock" notice posted by an older version may
        // still be sitting in this session's inbox. It is UI noise, not input —
        // never let the model answer it.
        if (Array.isArray(event.messages)) {
          for (let index = event.messages.length - 1; index >= 0; index -= 1) {
            if (isTurnLockNotice(event.messages[index])) event.messages.splice(index, 1)
          }
        }
        const local = await isLocalProvider(event?.model?.providerID)
        // The cloud flag is the UI's "this session is not gated" signal; it is
        // re-asserted on every request, so switching the model fixes the row.
        void syncState(sid, { cloud: local ? null : true })
        void applyCloudTitle(sid, !local)
        if (!local) return

        const gate = await resolveGate(sid)
        if (gate.kind !== "root") {
          // A subagent: covered by the parent's slot (keep it fresh) or exempt
          // because the parent run is not gated at all.
          if (gate.kind === "covered") lock.refresh(gate.root)
          log("info", `subagent ${sid}: ${gate.kind} by ${gate.root}`)
          return
        }

        // Soft preemption. Never interrupt a model or tool call: this hook runs
        // at a step boundary, which is the only place a slot can be given up
        // without breaking anything. A holder that sees a waiter of a better level
        // queued gives its own slot up and re-queues below; it resumes on its own
        // as soon as that waiter is served. So `▽` yields to everyone, `⚡` to nobody.
        if (held.has(sid)) {
          const ahead = waitingAbove(rankOf(sid), sid)
          if (ahead.length) {
            const who = ahead.map((waiter) => waiter.sid).join(", ")
            log("info", `yield ${sid}: ${who} ${ahead.length === 1 ? "outranks" : "outrank"} it`)
            held.delete(sid)
            lock.release(sid, "priority")
          }
        }

        waiting.add(sid)
        const result = await lock.acquire(sid).finally(() => waiting.delete(sid))
        if (!result.granted) {
          log("debug", `skip ${sid}: ${result.reason ?? "not granted"}`)
          return
        }
        held.add(sid)
      },
    )

    // `/prio` — the switch itself. A slash command is the one control every
    // client has (the composer), and a command callback is executed immediately
    // instead of being queued into the session inbox, so it reaches a session
    // that is blocked in the gate above. Nothing is sent to the model: the state
    // is the `⚡` or `▽` in the title.
    if (config.priorityEnabled && typeof ctx?.command?.transform === "function") {
      try {
        await ctx.command.transform((editor: { add: (command: unknown) => void }) => {
          editor.add({
            name: config.priorityCommand,
            description:
              "turn-lock: where this session stands in the queue — on/⚡ cuts it, low/▽ stands at the back of it, off is ordinary",
            execute: async (input: { sessionID?: string; prompt?: { text?: string } }) => {
              const sid = input?.sessionID
              if (!sid) return
              const verdict = parsePriorityArgument(input?.prompt?.text ?? "", config.priorityCommand)
              // A bare `/prio` keeps the meaning it had at two levels: on, unless
              // this session is already `⚡`. `low` is only ever asked for by name.
              const level = verdict === "toggle" ? (levelOf(sid) === "high" ? "normal" : "high") : verdict
              await applyLevel(sid, level)
            },
          })
        })
      } catch (error) {
        log("warn", `command /${config.priorityCommand} not registered: ${String(error)}`)
      }
    }

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ types: EVENT_TYPES, signal: controller.signal })) {
          const type = String((event as AnyEvent).type ?? "")
          if (type === "config.updated" || type === "provider.updated") {
            localCache.clear()
            continue
          }
          if (type === "form.created" && !config.releaseOnForm) continue
          if (type === "permission.asked" && !config.releaseOnPermission) continue
          const sid = eventSessionID(event as AnyEvent)
          if (!sid) continue
          held.delete(sid)
          lock.release(sid, type)
          // `release` only frees a slot this session held; a queued one has no
          // lease. Its wait is a separate polling loop, and the reminder tick
          // would keep re-marking the title and take the next free slot for a
          // run that will never happen.
          if (END_OF_RUN_EVENTS.has(type)) lock.cancelWait(sid, type)
          // A session that no longer runs cannot be the one the user needs now.
          if (type === "session.deleted" || type === "session.archived") dropPriority(sid)
          // A queued session has no lease, so a terminal event for it (deleted,
          // inbox cancelled) releases nothing — still drop its title mark.
          void unmarkWaiting(sid, type)
        }
      } catch {
        // the stream closed: the plugin is being unloaded
      }
    })()

    const sweeper = setInterval(() => lock.sweep(), config.sweepMs)
    if (typeof (sweeper as { unref?: () => void }).unref === "function") (sweeper as { unref: () => void }).unref()

    // Keep leases of this process fresh: a live session doing a long single
    // generation must not look abandoned to other processes.
    const heartbeat =
      config.refreshEveryMs > 0
        ? setInterval(() => {
            for (const sid of held) lock.refresh(sid)
          }, config.refreshEveryMs)
        : undefined
    if (heartbeat && typeof (heartbeat as { unref?: () => void }).unref === "function") {
      ;(heartbeat as { unref: () => void }).unref()
    }

    const restored = await restoreStaleMarks()

    log(
      "info",
      `ready: src=${SOURCE} limit=${config.limit} local=${config.localProviders.join(",")} timeout=${Math.round(
        config.acquireTimeoutMs / 60_000,
      )}min onTimeout=${config.onTimeout} mark=${config.markWaitingTitle} prio=${
        config.priorityEnabled ? `/${config.priorityCommand}` : "off"
      } dir=${config.dir} pruned=${pruned.length} restored=${restored}`,
    )

    return async () => {
      controller.abort()
      clearInterval(sweeper)
      if (heartbeat) clearInterval(heartbeat)
      // This instance's queue loops must die with it: after a hot reload they
      // would keep polling the shared store, re-mark titles and take slots for
      // hooks nobody awaits any more.
      for (const sid of waiting) lock.cancelWait(sid, "unload")
      waiting.clear()
      for (const sid of held) lock.release(sid, "unload")
      held.clear()
      for (const sid of [...marked]) await unmarkWaiting(sid, "unload")
      log("info", "unloaded")
    }
  },
})
