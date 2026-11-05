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
// Priority (`/prio`, marked "⚡ " in the title) answers "the priorities changed:
// I need a newer session's result first" without stopping anything. Two rules:
// an ordinary session never takes a free slot while a priority session queues,
// and a session that already holds a slot gives it up at its *next step
// boundary* — never in the middle of a model or tool call. The preempted session
// re-queues itself and resumes on its own, so work continues unattended.
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
//     "priorityEnabled": true,          // /prio: a session the user needs now cuts the queue
//     "priorityCommand": "prio",        // the slash command that toggles it
//     "priorityTtlMs": 86400000,        // a forgotten ⚡ stops working after this long
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
  priorityEnabled: true,
  priorityCommand: "prio",
  // A forgotten ⚡ must not starve everyone forever: after a day the flag stops
  // having any effect and its file is dropped on the next read.
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

/** The priority mark plus the space the two marks are joined by, if any. */
const PRIORITY_PREFIX = /^⚡ ?/

/** Title with the priority mark added (idempotent). */
export function withPriorityMark(title: string): string {
  return PRIORITY_PREFIX.test(title) ? title : `${PRIORITY_MARK} ${title}`
}

/** Title with the priority mark removed (idempotent, touches nothing else). */
export function withoutPriorityMark(title: string): string {
  return title.replace(PRIORITY_PREFIX, "")
}

/** Does this title carry the priority mark? */
export function hasPriorityMark(title: string): boolean {
  return PRIORITY_PREFIX.test(title)
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

/** Original title with every waiting prefix removed. A leading priority mark
 *  is not a waiting prefix: it stays where it is. */
export function stripWaitPrefix(title: string): string {
  const priority = hasPriorityMark(title)
  let result = title.replace(PRIORITY_PREFIX, "")
  while (WAIT_PREFIX.test(result)) result = result.replace(WAIT_PREFIX, "")
  return priority ? `${PRIORITY_MARK} ${result}` : result
}

/** Title of a waiting session: `⏳ 2/3 · 3h10m · <title>`, or `⚡ ⏳ …` when it
 *  is waiting *and* priority. Priority defaults to whatever the title already
 *  carries; pass it explicitly to add or remove the mark in the same write. */
export function withWaitPrefix(
  title: string,
  waitedMs: number,
  place?: QueuePlace,
  priority: boolean = hasPriorityMark(title),
): string {
  const base = withoutPriorityMark(stripWaitPrefix(title))
  const label = formatWait(waitedMs, place)
  return `${priority ? `${PRIORITY_MARK} ` : ""}${WAITING_MARK}${label ? `${label} · ` : ""}${base}`
}

/**
 * Reads the intent out of a command's text: `/prio`, `/prio on`, `/prio off`.
 * Tolerates both shapes a client may hand over — just the arguments, or the
 * whole line including the command name — because that is not specified.
 */
export function parsePriorityArgument(text: string, command: string): "on" | "off" | "toggle" {
  let argument = String(text ?? "").trim().toLowerCase()
  const name = String(command ?? "").toLowerCase()
  for (const prefix of [`/${name}`, name]) {
    if (argument === prefix) return "toggle"
    if (argument.startsWith(`${prefix} `)) {
      argument = argument.slice(prefix.length + 1).trim()
      break
    }
  }
  if (argument === "off" || argument === "remove" || argument === "false" || argument === "0") return "off"
  if (argument === "on" || argument === "add" || argument === "true" || argument === "1") return "on"
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
    const waitEpoch = new Map<string, number>()
    const epochOf = (sid: string) => waitEpoch.get(sid) ?? 0
    const waitPath = (sid: string) => join(config.dir, `${sid.replace(/[^A-Za-z0-9_.-]/g, "_")}.wait.json`)

    const canEditTitle = (): boolean =>
      typeof ctx?.session?.get === "function" && typeof ctx?.session?.update === "function"

    const readWaitMark = (sid: string): { pid?: number; owner?: string; since?: number } | undefined => {
      try {
        const value = JSON.parse(readFileSync(waitPath(sid), "utf8"))
        return value && typeof value === "object" ? (value as { pid?: number; owner?: string; since?: number }) : undefined
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

    // Priority. `<sessionID>.prio.json` is the shared record that the user needs
    // this session now: `/prio` writes it from any client, every process sharing
    // the lock directory reads it. A flag is inert while its session neither
    // waits nor holds a slot, so a forgotten ⚡ costs nothing — and it expires
    // anyway after priorityTtlMs.
    const prioPath = (sid: string) => join(config.dir, `${sid.replace(/[^A-Za-z0-9_.-]/g, "_")}.prio.json`)

    const dropPriority = (sid: string) => {
      try {
        if (existsSync(prioPath(sid))) unlinkSync(prioPath(sid))
      } catch {
        // best-effort
      }
    }

    const readPriority = (sid: string): { since: number } | undefined => {
      if (!config.priorityEnabled) return undefined
      try {
        const value = JSON.parse(readFileSync(prioPath(sid), "utf8"))
        const since = typeof value?.since === "number" ? value.since : 0
        if (!since) return undefined
        if (Date.now() - since > config.priorityTtlMs) {
          dropPriority(sid)
          return undefined
        }
        return { since }
      } catch {
        return undefined
      }
    }

    const writePriority = (sid: string) => {
      try {
        mkdirSync(config.dir, { recursive: true })
        writeFileSync(prioPath(sid), JSON.stringify({ sid, pid: process.pid, owner, since: Date.now() }), "utf8")
      } catch {
        // priority is best-effort: without the file the session simply stays ordinary
      }
    }

    /** Priority sessions queued right now, oldest flag first. One that already
     *  holds a slot is being served, so it is not in this list. */
    const priorityWaiters = (): Array<{ sid: string; since: number }> => {
      const flagged: Array<{ sid: string; since: number }> = []
      for (const waiter of readWaiters()) {
        if (store.read(waiter.sid)) continue
        const mine = readPriority(waiter.sid)
        if (mine) flagged.push({ sid: waiter.sid, since: mine.since })
      }
      return flagged.sort((a, b) => a.since - b.since || a.sid.localeCompare(b.sid))
    }

    /** The queue in the order it will actually be served: priority first (by the
     *  age of the flag), the rest by the moment they started waiting. `sid` is
     *  included even before its sidecar exists, so a place is always defined. */
    const orderedWaiters = (sid?: string, since = 0): string[] => {
      const waiting = new Map<string, number>()
      for (const waiter of readWaiters()) waiting.set(waiter.sid, waiter.since)
      const flagged = new Map<string, number>()
      for (const priority of priorityWaiters()) flagged.set(priority.sid, priority.since)
      if (sid) {
        waiting.set(sid, since)
        const mine = readPriority(sid)
        if (mine) flagged.set(sid, mine.since)
      }
      const first = [...flagged.entries()]
        .filter(([id]) => waiting.has(id))
        .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
        .map(([id]) => id)
      const then = [...waiting.entries()]
        .filter(([id]) => !flagged.has(id))
        .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
        .map(([id]) => id)
      return [...first, ...then]
    }

    /** May `sid` take a free slot? No, while a priority session queues ahead of
     *  it: any ordinary session behind every priority waiter, and between two
     *  priority sessions the one flagged later. */
    const holdsBack = (sid: string): boolean => {
      const ahead = priorityWaiters()
      if (!ahead.length) return false
      const mine = readPriority(sid)
      if (!mine) return true
      return ahead.some((w) => w.sid !== sid && (w.since < mine.since || (w.since === mine.since && w.sid < sid)))
    }

    /** `/prio` in the session's composer. A command callback runs immediately
     *  and is not a model request, so it also reaches a session that is sitting
     *  in the queue — which is exactly when it matters. */
    async function applyPriority(sid: string, on: boolean): Promise<void> {
      waitEpoch.set(sid, epochOf(sid) + 1) // an in-flight title update must not win
      if (on) writePriority(sid)
      else dropPriority(sid)
      const waiting = readWaitMark(sid)
      const waitedMs = waiting && typeof waiting.since === "number" ? Date.now() - waiting.since : undefined
      if (waitedMs !== undefined) {
        await markWaiting(sid, waitedMs) // rebuilds `⚡ ⏳ 2/3 · 4m · …` in one go
      } else if (canEditTitle()) {
        try {
          const info: any = await ctx.session.get({ sessionID: sid })
          const title = typeof info?.title === "string" ? info.title : ""
          const next = on ? withPriorityMark(title) : withoutPriorityMark(title)
          if (title && next !== title) await ctx.session.update({ sessionID: sid, title: next })
        } catch (error) {
          log("debug", `priority ${sid}: title update failed: ${String(error)}`)
        }
      }
      log("info", `priority ${sid}: ${on ? "on" : "off"}`)
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
      if (!config.markWaitingTitle || marking.has(sid) || !canEditTitle()) return
      marking.add(sid)
      const epoch = epochOf(sid)
      try {
        const info: any = await ctx.session.get({ sessionID: sid })
        if (epochOf(sid) !== epoch) return // the slot was granted while we looked
        const title = typeof info?.title === "string" ? info.title : ""
        if (!title) return
        const place = placeOf(sid, since)
        // The flag, not the title, decides the mark: /prio can be typed while
        // this session is already queued, and the next tick has to notice.
        const next = withWaitPrefix(title, waitedMs, place, Boolean(readPriority(sid)))
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
                ? `a priority session takes the next free slot (${event.held}/${event.limit} busy)`
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
        if (!(await isLocalProvider(event?.model?.providerID))) return

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
        // without breaking anything. An ordinary holder that sees a priority
        // session queued releases its own slot and re-queues below; it resumes on
        // its own as soon as the priority session is served.
        if (held.has(sid) && !readPriority(sid)) {
          const ahead = priorityWaiters()
          if (ahead.length) {
            const who = ahead.map((waiter) => waiter.sid).join(", ")
            log("info", `yield ${sid}: ${who} ${ahead.length === 1 ? "has priority" : "have priority"}`)
            held.delete(sid)
            lock.release(sid, "priority")
          }
        }

        const result = await lock.acquire(sid)
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
    // is the ⚡ in the title.
    if (config.priorityEnabled && typeof ctx?.command?.transform === "function") {
      try {
        await ctx.command.transform((editor: { add: (command: unknown) => void }) => {
          editor.add({
            name: config.priorityCommand,
            description: "turn-lock: this session cuts the queue (⚡). No argument toggles, or pass on/off",
            execute: async (input: { sessionID?: string; prompt?: { text?: string } }) => {
              const sid = input?.sessionID
              if (!sid) return
              const verdict = parsePriorityArgument(input?.prompt?.text ?? "", config.priorityCommand)
              await applyPriority(sid, verdict === "off" ? false : verdict === "on" ? true : !readPriority(sid))
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
      for (const sid of held) lock.release(sid, "unload")
      held.clear()
      for (const sid of [...marked]) await unmarkWaiting(sid, "unload")
      log("info", "unloaded")
    }
  },
})
