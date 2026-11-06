// turn-lock (OpenCode V2 plugin) — hold at most N local-agent sessions on the
// model engine; every other session waits before its model request is sent.
//
// Why: the local engine (strata on 18500) serves one request at a time and
// switches context per request, so N interleaved agent sessions thrash the
// conversation cache. By default the slot covers one *request*: it is taken in
// the `context` hook and freed when that request's tools start. A
// `session.step.ended` with `finish: "tool-calls"` therefore does not free the
// slot at once: the lease is kept until the first `session.tool.called` (or
// `handoffMs`), so another session cannot slip into the gap between the model
// answer and the tool. The queue is ordered by the absolute session creation
// time (`session.time.created`), not by when the wait began: inside a level the
// oldest session is served first. `lockScope: "turn"` restores the whole-turn
// lease.
//
// Cloud providers are never gated: the `context` hook checks the provider of
// the outgoing request and returns immediately unless it is local. Auxiliary
// request kinds (`title`, `summary`/`compaction`, `generate`) are not hooked at
// all, so cloud sessions and local bookkeeping calls are never delayed.
//
// Subagents are gated on their own in `request` scope: each request takes a
// slot and inherits the level of its parent chain (a parent waiting for its
// subagent does not hold a slot, so there is nothing to share). In `turn` scope
// a subagent is covered by its parent's lease instead, exactly as before.
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
//     "limit": 1,                       // concurrent local sessions
//     "localProviders": ["strata"],     // provider ids treated as local
//     "localHosts": ["127.0.0.1", "localhost", "::1", "0.0.0.0"],
//     "acquireTimeoutMs": 14400000,     // 4 h: max wait before onTimeout applies
//     "onTimeout": "proceed",           // "proceed" (fail-open) | "hold"
//     "leaseTimeoutMs": 7200000,        // lease without refresh = abandoned
//     "pollMs": 200,
//     "handoffMs": 1000,                // hold the slot across a step boundary until its first tool starts
//     "fifoGraceMs": 2000,              // how long place 1 may take a freed slot before place 2 gets it
//     "refreshEveryMs": 20000,
//     "sweepMs": 60000,
//     "releaseOnForm": true,            // a `question` tool form frees the slot
//     "releaseOnPermission": true,      // a permission prompt frees the slot
//     "remindEveryMs": 60000,           // title countdown tick + log line for a long wait
//     "markWaitingTitle": true,         // prefix the session title with "⏳ " while it waits
//     "titleMarks": "none",             // "all" (⚡/▽/☁️/⏳) | "waiting" (⏳ only) | "none"
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
import {
  aheadInLevel,
  compareQueue,
  levelEntry,
  outranking,
  parsePriorityArgument,
  toggleLevel,
  type PriorityLevel,
  type QueueEntry,
} from "./priority.ts"
import { createPriorityFlags } from "./priority-store.ts"
import { readState, withState, type TurnLockState } from "./state.ts"
import { fileStore, processAlive } from "./store-file.ts"
import {
  formatWait,
  stripWaitPrefix,
  withCloudMark,
  withLevelMark,
  withWaitPrefix,
  withoutLevelMark,
  type QueuePlace,
} from "./title.ts"

// The priority vocabulary and the title grammar live in their own modules; the
// plugin entry re-exports them, so `/prio`, the GUI and the tests keep importing
// everything from this file.
export * from "./priority.ts"
export * from "./title.ts"

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
  /** What one lease covers: a single model request (`request`, the default) or
   *  the whole turn (`turn`). In `request` scope the slot is freed when the
   *  step's tools start, and taken again by the next request of the session. */
  lockScope: "request" | "turn"
  /** How long a `request`-scope lease is kept across a step boundary while the
   *  first tool of that step starts (`finish: "tool-calls"`) or a continuation
   *  arrives (`finish: "length"`). This is not a queue reservation: the slot is
   *  freed at the tool event, and the timer is only the fallback for a step
   *  that never continues. 0 frees the slot at `step.ended` at once. */
  handoffMs: number
  pollMs: number
  /** How long the head of a level may take a freed slot before the next waiter
   *  of the same level is let through. 0 disables the FIFO order (first awake wins). */
  fifoGraceMs: number
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
  // The local engine serves one request at a time (one slot, `prefill_pipe: 0`),
  // so a second lease only hides the queue inside the engine and costs the exact
  // priority this plugin exists to give.
  limit: 1,
  localProviders: ["strata"],
  localHosts: ["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0", "::", "[::]"],
  // A long queued turn is normal here: the point is to let one goal finish
  // before the next session is admitted, and goals can take hours. The timeout
  // is only the last-resort anti-deadlock (a live holder refreshes its lease
  // every refreshEveryMs, so a wedged holder is the case it covers).
  acquireTimeoutMs: 4 * 60 * 60_000,
  onTimeout: "proceed",
  leaseTimeoutMs: 2 * 60 * 60_000,
  // One lease per model request: the slot is free while a tool runs, and the
  // queue is ordered by the session's creation time, so its next step is still
  // first in line. `"turn"` restores the old whole-turn lease.
  lockScope: "request",
  pollMs: 200,
  // A step boundary is not a real pause: the next thing that happens is either
  // a tool starting (a few milliseconds) or a continuation request. Keeping the
  // slot for that moment costs nothing — the engine is idle anyway — and it
  // stops another session from taking the slot in the gap. The timer is only
  // the fallback for a step that never continues.
  handoffMs: 1_000,
  // The head of a level gets two poll ticks to take a freed slot; if it does not
  // (dead process, wedged event loop), the next place is served instead.
  fifoGraceMs: 2_000,
  refreshEveryMs: 20_000,
  sweepMs: 60_000,
  releaseOnForm: true,
  releaseOnPermission: true,
  remindEveryMs: 60_000,
  markWaitingTitle: true,
  // The UI draws the wait from `metadata.since` (badge with a live label), so by
  // default the title stays the user's own text. `"waiting"` keeps the old
  // `⏳ 2/5 · 9m ·` prefix for clients without the plugin (phone, TUI), and
  // `"all"` also restores the `⚡`/`▽`/`☁️` marks.
  titleMarks: "none",
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
 *  the agent is blocked on the human (question form / permission prompt). In
 *  `request` scope `step.ended`/`step.failed` also release, at the end of one
 *  model request; in `turn` scope they are ignored. */
export const RELEASE_EVENTS = [
  "session.step.ended",
  "session.step.failed",
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

/** Events that carry a model but not a release. A session's provider is known
 *  from the moment it is created or its model is switched, and the UI needs the
 *  cloud flag then — not at the first request. */
const MODEL_EVENTS = ["session.created", "session.model.selected"] as const

/** The first tool of a step. In `request` scope the slot is kept across the
 *  step boundary until one of these arrives, so another session cannot slip
 *  into the gap between the model answer and the tool that follows it. */
const HANDOFF_EVENTS = ["session.tool.called"] as const

const EVENT_TYPES = [...RELEASE_EVENTS, ...MODEL_EVENTS, ...HANDOFF_EVENTS] as string[]

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
    model?: { providerID?: string }
    /** `session.step.ended`: why the step ended. `tool-calls` and `length` mean
     *  the request is not really over — a tool or a continuation follows. */
    finish?: string
    /** `session.tool.called`: whether the runtime executes the call. */
    executed?: boolean
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
    lockScope: value.lockScope === "turn" ? "turn" : value.lockScope === "request" ? "request" : base.lockScope,
    leaseTimeoutMs: asNumber(value.leaseTimeoutMs, base.leaseTimeoutMs, 1_000),
    pollMs: Math.max(5, asNumber(value.pollMs, base.pollMs, 5)),
    handoffMs: Math.max(0, asNumber(value.handoffMs, base.handoffMs, 0)),
    fifoGraceMs: Math.max(0, asNumber(value.fifoGraceMs, base.fifoGraceMs, 0)),
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
    /** Steps whose slot is kept across the boundary until the first tool of that
     *  step starts (or a continuation request arrives). Not a queue reservation:
     *  the slot is freed at the tool event, and the timer only covers a step
     *  that never continues. */
    const handoffs = new Map<string, { kind: "tool" | "continue"; timer?: ReturnType<typeof setTimeout> }>()
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
    // Bumped by every new mark. A teardown that started before the bump must
    // not delete the sidecar or clear the place of the wait that replaced it.
    const waitGeneration = new Map<string, number>()
    const generationOf = (sid: string) => waitGeneration.get(sid) ?? 0
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
      holding?: number | null
    }
    const applyPatch = (state: TurnLockState, patch: StatePatch): TurnLockState => {
      const next: TurnLockState = { ...state }
      if (patch.level) next.level = patch.level
      for (const key of ["cloud", "position", "total", "since", "holding"] as const) {
        const value = patch[key]
        if (value === undefined) continue
        if (value === null) delete next[key]
        else (next as Record<string, unknown>)[key] = value
      }
      return next
    }

    // Two writers can race on one session (a level switch while the wait tick
    // writes the place), and each write replaces the whole metadata object.
    // Chaining the writes per session serializes them inside this instance;
    // every write still re-reads the session first, because another instance
    // (one plugin per location, all sharing the state directory) may have
    // written `since` or `cloud` in between, and a cached copy would drop it.
    const stateQueue = new Map<string, Promise<void>>()

    const writeState = async (sid: string, patch: StatePatch): Promise<void> => {
      try {
        const info: any = await ctx.session.get({ sessionID: sid })
        const metadata =
          info?.metadata && typeof info.metadata === "object" ? { ...(info.metadata as Record<string, unknown>) } : {}
        const state = readState(metadata) ?? { level: "normal" }
        const next = applyPatch(state, patch)
        if (JSON.stringify(next) === JSON.stringify(state)) return
        await ctx.session.update({ sessionID: sid, metadata: withState(metadata, next) })
      } catch (error) {
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

    type WaitMark = { pid?: number; owner?: string; since?: number; createdAt?: number; markedAt?: number }

    const readWaitMark = (sid: string): WaitMark | undefined => {
      try {
        const value = JSON.parse(readFileSync(waitPath(sid), "utf8"))
        return value && typeof value === "object" ? (value as WaitMark) : undefined
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

    /** The sidecar is the only shared record of the queue, so it also carries
     *  the ordering key: the absolute creation time of the session. Another
     *  instance (one plugin per location, all sharing this directory) cannot ask
     *  the server about a session it does not own, and the age has to mean the
     *  same thing for everyone. */
    const writeWaitMark = (sid: string, since: number, created?: number) => {
      try {
        mkdirSync(config.dir, { recursive: true })
        writeFileSync(
          waitPath(sid),
          JSON.stringify({
            sid,
            pid: process.pid,
            owner,
            since,
            ...(created !== undefined ? { createdAt: created } : {}),
            markedAt: Date.now(),
          }),
          "utf8",
        )
      } catch {
        // the title mark still works without the sidecar
      }
    }

    // The queue is ordered by when a session was created, not by when its wait
    // began: a session that comes back after a tool is still the oldest, and a
    // session created later never cuts in front of it inside a level. The value
    // is `session.time.created`; a server that does not expose it falls back to
    // the wait start in `entryOf`.
    const createdAt = new Map<string, number>()
    const createdAtAsked = new Set<string>()

    const rememberCreatedAt = (sid: string, info: any): void => {
      const raw = info?.time?.created
      if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) createdAt.set(sid, raw)
    }

    /** The session's creation time, cached. `parentOf` fills the cache with the
     *  same `session.get` it already makes; this is the fallback for a session
     *  that has not been through the gate yet. Asked at most once per process:
     *  a server that never reports `time.created` must not be polled for it. */
    const createdAtOf = async (sid: string): Promise<number | undefined> => {
      const cached = createdAt.get(sid)
      if (cached !== undefined) return cached
      if (createdAtAsked.has(sid)) return undefined
      createdAtAsked.add(sid)
      try {
        const info: any = await ctx.session.get({ sessionID: sid })
        rememberCreatedAt(sid, info)
        return createdAt.get(sid)
      } catch {
        return undefined
      }
    }

    /** Turn tickets are gone: the queue no longer keeps a place across steps.
     *  Files from a previous version are only noise now; drop them on boot
     *  unless another live process still owns one. */
    const pruneTickets = (): number => {
      let names: string[]
      try {
        names = readdirSync(config.dir)
      } catch {
        return 0
      }
      let removed = 0
      for (const name of names) {
        if (!name.endsWith(".turn.json")) continue
        const path = join(config.dir, name)
        try {
          const value = JSON.parse(readFileSync(path, "utf8"))
          const pid = typeof value?.pid === "number" ? value.pid : undefined
          if (pid !== undefined && pid !== process.pid && processAlive(pid)) continue
          unlinkSync(path)
          removed += 1
        } catch {
          // a broken or already removed file is not a ticket
        }
      }
      return removed
    }

    /** Everyone waiting right now, oldest wait first. The sidecars are the only
     *  shared record of waiters (the store holds granted leases only), so the
     *  queue position is derived from them; a waiter whose process is gone is
     *  ignored. `createdAt` is the session's absolute creation time, carried in
     *  the sidecar because another instance cannot read a session it does not
     *  own; it is the key the queue is actually ordered by. */
    const readWaiters = (): Array<{ sid: string; since: number; createdAt?: number }> => {
      let names: string[]
      try {
        names = readdirSync(config.dir)
      } catch {
        return []
      }
      // A waiter rewrites its sidecar on every reminder tick, so `markedAt` is
      // its heartbeat. A mark that has not moved for several ticks belongs to a
      // wait that ended without a terminal event — a session deleted while it
      // was queued, a turn killed from another client — and must not keep
      // holding place 1 (or a high-priority reservation) forever. With
      // `remindEveryMs: 0` there is no heartbeat, so age proves nothing and the
      // liveness of the process stays the only signal.
      const staleAfterMs = config.remindEveryMs > 0 ? Math.max(config.remindEveryMs * 3, 5 * 60_000) : Infinity
      const waiters: Array<{ sid: string; since: number; createdAt?: number }> = []
      for (const name of names) {
        if (!name.endsWith(".wait.json")) continue
        const sid = name.slice(0, -".wait.json".length)
        const mark = readWaitMark(sid)
        if (!mark) continue
        const pid = typeof mark.pid === "number" ? mark.pid : undefined
        if (pid !== undefined && pid !== process.pid && !processAlive(pid)) continue
        const since = typeof mark.since === "number" ? mark.since : typeof mark.markedAt === "number" ? mark.markedAt : 0
        const markedAt = typeof mark.markedAt === "number" ? mark.markedAt : since
        if (Date.now() - markedAt > staleAfterMs) {
          dropWaitMark(sid)
          continue
        }
        const created = typeof mark.createdAt === "number" && mark.createdAt > 0 ? mark.createdAt : undefined
        waiters.push({ sid, since, createdAt: created })
      }
      return waiters.sort((a, b) => a.since - b.since || a.sid.localeCompare(b.sid))
    }

    const placeOf = (sid: string, since: number): QueuePlace => {
      const order = orderedWaiters(sid, since)
      const index = order.indexOf(sid)
      return { position: index + 1, total: order.length }
    }

    /** A place belongs to the queue, not to one waiter: when the head is served
     *  or someone joins, every badge behind it moves. A waiter rewrites its own
     *  place only on its reminder tick (60s by default), which is far too slow
     *  for that — right after a grant the new head would keep showing `2/8`.
     *  So every queue change republishes the whole queue. Passes are serialized
     *  and coalesced: a change that lands mid-pass schedules exactly one more,
     *  so a burst of grants cannot interleave read-modify-write cycles. */
    let placesDirty = false
    let placesPass: Promise<void> | undefined
    const refreshPlaces = (): Promise<void> => {
      placesDirty = true
      if (placesPass) return placesPass
      // Start the pass in a microtask: an empty queue finishes synchronously,
      // and the cleanup below would otherwise run before `placesPass` is set.
      const pass = Promise.resolve().then(async () => {
        try {
          while (placesDirty) {
            placesDirty = false
            const order = orderedWaiters()
            const total = order.length
            // `since` comes from the wait sidecar, not from a previous write: a
            // waiter restored after a plugin reload (or marked by another
            // instance) has a sidecar but may have no `since` in its metadata,
            // and a place without a start time draws no timer in the UI.
            const starts = new Map(readWaiters().map((waiter) => [waiter.sid, waiter.since]))
            for (const [index, id] of order.entries()) {
              const since = starts.get(id)
              await syncState(id, { position: index + 1, total, ...(since ? { since } : {}) })
            }
          }
        } catch (error) {
          log("debug", `places: ${String(error)}`)
        }
      })
      placesPass = pass
      void pass.finally(() => {
        if (placesPass === pass) placesPass = undefined
      })
      return pass
    }

    // Priority. The flag sidecar and its rules (TTL, legacy shapes, root
    // inheritance) live in priority-store.ts; the plugin only supplies the lock
    // directory and the ancestry cache. A flag is inert while its session neither
    // waits nor holds a slot, so a forgotten mark costs nothing — and it expires
    // anyway after priorityTtlMs.
    //
    // A subagent runs the work of its parent, so it queues at the parent's
    // level: the root is cached when the session is first gated. A session that
    // has not been seen yet falls back to its own flag (a root session's own
    // flag is the root flag anyway).
    const roots = new Map<string, string>()

    const flags = createPriorityFlags({
      dir: config.dir,
      ttlMs: config.priorityTtlMs,
      enabled: config.priorityEnabled,
      owner,
      rootOf: (sid) => roots.get(sid),
    })

    const flagOf = flags.flagOf
    const levelOf = flags.levelOf
    const rankOf = flags.rankOf

    /**
     * One waiter as the queue sees it. The age is the absolute creation time of
     * the session; when the server does not report it, the start of this wait is
     * the fallback. A flag only supplies the level — inside a level the oldest
     * session is still served first.
     */
    const entryOf = (sid: string, waited: number, created?: number): QueueEntry => {
      const flag = flagOf(sid)
      return levelEntry(sid, flag?.level ?? "normal", created ?? createdAt.get(sid) ?? waited)
    }

    /** Everyone queued right now. A waiter that already holds a slot is being
     *  served, so it is not in this list. */
    const rankedWaiters = (): QueueEntry[] =>
      readWaiters()
        .filter((waiter) => !store.read(waiter.sid))
        .map((waiter) => entryOf(waiter.sid, waiter.since, waiter.createdAt))

    /** Waiters of a strictly better level than `rank`: they take the next free slot
     *  first, and a holder of `rank` gives its own slot up to them. */
    const waitingAbove = (rank: number, except?: string) => outranking(rankedWaiters(), except ?? "", rank)

    /** When a slot last freed. The head of a level may take it at once; the next
     *  place is let through only after another `fifoGraceMs`, so a head that
     *  stopped polling cannot hold the slot. */
    const slotFreePath = join(config.dir, "slot-free.json")

    const readFreeAt = (): number => {
      try {
        const value = JSON.parse(readFileSync(slotFreePath, "utf8"))
        return typeof value?.at === "number" ? value.at : 0
      } catch {
        return 0
      }
    }

    const writeFreeAt = (at: number): void => {
      try {
        mkdirSync(config.dir, { recursive: true })
        writeFileSync(slotFreePath, JSON.stringify({ at }), "utf8")
      } catch {
        // best-effort: without the file the queue falls back to the first awake
      }
    }

    /** May `sid` take a free slot? No, while anyone goes before it: a better
     *  level always, and an older waiter of its own level until the head has had
     *  its `fifoGraceMs`. `since` is when this wait began; the age that orders it
     *  is the session's creation time, exactly like `orderedWaiters`. */
    const holdsBack = (sid: string, since: number): boolean => {
      const me = entryOf(sid, since)
      const waiters = rankedWaiters()
      if (outranking(waiters, sid, me.rank).length) return true
      if (config.fifoGraceMs <= 0) return false
      const ahead = aheadInLevel(waiters, me)
      if (!ahead.length) return false
      // Each place ahead gets one grace window: the head takes the slot at once,
      // place 2 after one window, place 3 after two, and so on. The window is at
      // least two polls, so a head always gets a real chance to wake up.
      const availableAt = readFreeAt()
      const grace = Math.max(config.fifoGraceMs, config.pollMs * 2)
      return Date.now() - availableAt < ahead.length * grace
    }

    /** The queue in the order it will actually be served: the best level first
     *  (`⚡`, then ordinary, then `▽`), inside a level by creation time.
     *  `sid` is included even before its sidecar exists, so a place is always defined. */
    const orderedWaiters = (sid?: string, since = 0): string[] => {
      const entries = new Map<string, QueueEntry>()
      for (const waiter of readWaiters()) entries.set(waiter.sid, entryOf(waiter.sid, waiter.since, waiter.createdAt))
      if (sid) entries.set(sid, entryOf(sid, since))
      return [...entries.values()].sort(compareQueue).map((entry) => entry.sid)
    }

    /** `/prio` in the session's composer. A command callback runs immediately
     *  and is not a model request, so it also reaches a session that is sitting
     *  in the queue — which is exactly when it matters. */
    async function applyLevel(sid: string, level: PriorityLevel): Promise<void> {
      waitEpoch.set(sid, epochOf(sid) + 1) // an in-flight title update must not win
      flags.write(sid, level)
      void syncState(sid, { level })
      const waiting = readWaitMark(sid)
      const waitedMs = waiting && typeof waiting.since === "number" ? Date.now() - waiting.since : undefined
      if (waitedMs !== undefined) {
        await markWaiting(sid, waitedMs) // rebuilds `⚡ ⏳ 2/3 · 4m · …` in one go
        await refreshPlaces() // the level moved this session, so every place moved
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
      waitGeneration.set(sid, generationOf(sid) + 1)
      const since = Date.now() - waitedMs
      // The sidecar carries the ordering key, so it is written with the mark,
      // not after a server round-trip. A cold cache (a wait restored after a hot
      // reload) is filled in the background and the age is published then.
      const known = createdAt.get(sid) ?? readWaitMark(sid)?.createdAt
      writeWaitMark(sid, since, known)
      if (known === undefined) {
        void createdAtOf(sid).then((created) => {
          if (created === undefined) return
          const current = readWaitMark(sid)
          if (!current) return // the wait ended while the age was looked up
          writeWaitMark(sid, typeof current.since === "number" ? current.since : since, created)
        })
      }
      const place = placeOf(sid, since)
      void syncState(sid, {
        position: place?.position ?? null,
        total: place?.total ?? null,
        since,
        // A waiter cannot be the holder: a `holding` left behind by a killed
        // instance (or by the turn that has just released) is stale here.
        holding: null,
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
      const generation = generationOf(sid)
      // A wait that started while this one was being torn down owns the queue
      // now: its sidecar and its place must survive. Without the guard a late
      // grant could delete the mark of the wait that replaced it and leave a
      // `position` in metadata with no sidecar behind it.
      const settled = () => generationOf(sid) === generation
      const clear = () =>
        settled() ? syncState(sid, { position: null, total: null, since: null }) : Promise.resolve()
      const wasMarked = marked.delete(sid)
      if (!wasMarked && !readWaitMark(sid)) {
        void clear()
        return
      }
      // A session that no longer exists has no title to restore, so the usual
      // "keep the sidecar, retry on the next boot" would keep a phantom waiter
      // in the queue for good. Drop it now.
      if (reason === "session.deleted" || reason === "session.archived") {
        if (settled()) dropWaitMark(sid)
        void clear()
        return
      }
      if (!canEditTitle()) {
        if (settled()) dropWaitMark(sid)
        void clear()
        return
      }
      try {
        const info: any = await ctx.session.get({ sessionID: sid })
        if (!settled()) return // a new wait already marked the title again
        const title = typeof info?.title === "string" ? info.title : ""
        const base = stripWaitPrefix(title)
        if (base !== title) {
          await ctx.session.update({ sessionID: sid, title: base })
          log("debug", `unmark ${sid}: ${reason}`)
        }
        if (!settled()) return
        dropWaitMark(sid)
        void clear()
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

    /** Metadata is a view of the queue, and a write can be lost when a process
     *  is unloaded in the middle of a grant: the session then keeps a `position`
     *  without a wait mark, and the badge draws a queue place for a session that
     *  is not waiting. The sidecars are the only record of who waits, so on boot
     *  every session is checked against them. */
    async function clearOrphanPlaces(): Promise<number> {
      if (!config.stateMetadata || !canEditTitle() || typeof ctx.session.list !== "function") return 0
      const waiting = new Set(readWaiters().map((waiter) => waiter.sid))
      // A `holding` with no lease behind it belongs to a session that stopped
      // holding while this instance was not watching (another instance served
      // the release, or the plugin reloaded and lost its `held` set). The badge
      // must not keep saying "держит слот" about a session that is not running.
      const leased = new Set(lock.snapshot().leases.map((lease) => lease.sid))
      let cleared = 0
      let cursor: string | undefined
      for (let page = 0; page < 50; page += 1) {
        let listed: { data?: unknown[]; cursor?: { next?: string | null } }
        try {
          listed = (await ctx.session.list({ limit: 100, cursor })) as typeof listed
        } catch (error) {
          log("debug", `orphan sweep: ${String(error)}`)
          break
        }
        const items = Array.isArray(listed?.data) ? listed.data : []
        for (const item of items) {
          const info = item as { id?: unknown; metadata?: unknown }
          const sid = typeof info.id === "string" ? info.id : ""
          if (!sid || waiting.has(sid)) continue
          const state = readState(info.metadata)
          if (!state) continue
          const place = state.position !== undefined || state.total !== undefined || state.since !== undefined
          const hold = state.holding !== undefined && !leased.has(sid)
          if (!place && !hold) continue
          await syncState(sid, {
            ...(place ? { position: null, total: null, since: null } : {}),
            ...(hold ? { holding: null } : {}),
          })
          cleared += 1
        }
        const next = listed?.cursor?.next
        if (!next) break
        cursor = next
      }
      return cleared
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
          void unmarkWaiting(event.sid, "grant").finally(() => {
            void refreshPlaces()
          })
          break
        case "wait":
          log(
            "info",
            `wait ${event.sid}: ${
              event.blocked === "ahead"
                ? `a session ahead in the queue takes the next free slot (${event.held}/${event.limit} busy)`
                : `${event.held}/${event.limit} local sessions are busy`
            }${event.waitedMs ? ` (already ${Math.round(event.waitedMs / 1000)}s)` : ""}`,
          )
          void markWaiting(event.sid, event.waitedMs)
          // The new waiter wrote its sidecar synchronously; everyone else's
          // total changed with it.
          void refreshPlaces()
          break
        case "release":
          log("info", `release ${event.sid}: ${event.reason} (held ${event.held}/${config.limit})`)
          void unmarkWaiting(event.sid, "release").finally(() => {
            void refreshPlaces()
          })
          break
        case "cancel":
          log("debug", `cancel wait ${event.sid}: ${event.reason}`)
          void unmarkWaiting(event.sid, "cancel").finally(() => {
            void refreshPlaces()
          })
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
        // The same lookup feeds the queue: a session's absolute creation time is
        // its ordering key, and this is the one `session.get` every gated
        // request already makes.
        rememberCreatedAt(sid, info)
        const raw = info?.parentID ?? info?.session?.parentID ?? null
        parent = typeof raw === "string" && raw ? raw : null
      } catch (error) {
        log("debug", `parent lookup failed for ${sid}: ${String(error)}`)
        parent = null
      }
      parents.set(sid, parent)
      return parent
    }

    /** The top of the parent chain, cached. A subagent inherits its level. */
    const rootOf = async (sid: string): Promise<string> => {
      const cached = roots.get(sid)
      if (cached) return cached
      let current = sid
      let depth = 0
      while (depth < 8) {
        const parent = await parentOf(current)
        if (!parent) break
        current = parent
        depth += 1
      }
      roots.set(sid, current)
      return current
    }

    /** The ancestor whose *live* lease covers `sid`, if any. Unlike `resolveGate`
     *  this is never cached: in `request` scope the parent's lease comes and goes
     *  with its steps, so the child has to ask again on every request. */
    const coveredBy = async (sid: string): Promise<string | null> => {
      let current = await parentOf(sid)
      let depth = 0
      while (current && depth < 8) {
        if (store.read(current)) return current
        current = await parentOf(current)
        depth += 1
      }
      return null
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
      // In `request` scope the hold-back is also what orders waiters by the
      // session's creation time, so it must stay on even without `/prio`: the
      // levels simply become inert (a flag reads as nothing when priority is off).
      holdBack: config.priorityEnabled || config.lockScope === "request" ? holdsBack : undefined,
      onFree: writeFreeAt,
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

        if (config.lockScope === "request") {
          // One lease per model request. The root is cached here so a subagent
          // inherits its parent's level; the same lookup records the session's
          // absolute creation time, which orders the queue.
          await rootOf(sid)
          const handoff = handoffs.get(sid)
          if (handoff) {
            // This request continues the step the slot was kept for (a `length`
            // continuation, or a step whose tool never started). The lease is
            // already held; releasing and retaking it would open exactly the gap
            // the handoff exists to close.
            if (handoff.timer) clearTimeout(handoff.timer)
            handoffs.delete(sid)
            lock.refresh(sid)
          } else if (held.has(sid)) {
            // A step event was lost: this is a new context, so the previous
            // request is over and the lease must not turn back into a turn lease.
            held.delete(sid)
            lock.release(sid, "step-boundary")
            void syncState(sid, { holding: null })
          }
          // A step of the parent covers its subagents. While a `task` tool runs,
          // the parent still holds the slot and its step cannot end until the
          // child answers, so a child that queued for a slot of its own would
          // deadlock the pair until the timeout. The child rides the parent's
          // lease instead: one request in flight, no second slot.
          const cover = await coveredBy(sid)
          if (cover) {
            lock.refresh(cover)
            log("info", `subagent ${sid}: covered by ${cover}`)
            void unmarkWaiting(sid, "covered").finally(() => {
              void refreshPlaces()
            })
            return
          }
        } else {
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
              void syncState(sid, { holding: null })
            }
          }
        }

        waiting.add(sid)
        const result = await lock.acquire(sid).finally(() => waiting.delete(sid))
        if (!result.granted) {
          log("debug", `skip ${sid}: ${result.reason ?? "not granted"}`)
          return
        }
        held.add(sid)
        // The badge: the holder of the slot is drawn as the active row, with its
        // own timer. The start is the lease's `since`, not `Date.now()` — a
        // lease that outlived a plugin reload, or a turn lease reused by the
        // next step, must not restart the clock on every request.
        const leaseSince = lock.snapshot().leases.find((lease) => lease.sid === sid)?.since
        void syncState(sid, { holding: leaseSince ?? Date.now() })
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
              const level = verdict === "toggle" ? toggleLevel(levelOf(sid)) : verdict
              await applyLevel(sid, level)
            },
          })
        })
      } catch (error) {
        log("warn", `command /${config.priorityCommand} not registered: ${String(error)}`)
      }
    }

    /** Keep a `request`-scope lease across a step boundary for a moment: the step
     *  is followed either by its first tool (`finish: "tool-calls"`) or by a
     *  continuation request (`finish: "length"`), and freeing the slot in that
     *  gap would let another session take it before the engine is really free.
     *  The lease is released on the matching event; the timer is only the
     *  fallback for a step that never continues. */
    const armHandoff = (sid: string, kind: "tool" | "continue"): void => {
      const previous = handoffs.get(sid)
      if (previous?.timer) clearTimeout(previous.timer)
      const timer = setTimeout(() => {
        handoffs.delete(sid)
        if (!held.delete(sid)) return
        lock.release(sid, kind === "tool" ? "no tool started" : "no continuation")
        void syncState(sid, { holding: null })
      }, Math.max(config.handoffMs, config.pollMs * 2))
      if (typeof (timer as { unref?: () => void }).unref === "function") (timer as { unref: () => void }).unref()
      handoffs.set(sid, { kind, timer })
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
          // The cloud flag is the UI's "not gated" signal: it draws the badge and
          // sorts the row. A session that has not made a request yet has no flag
          // from `context`, so a freshly created cloud session looked ordinary
          // until its first prompt. The model is on the event, so mark it now;
          // `context` re-asserts the flag on every request, which keeps a model
          // switch correct even if this event is missed.
          if ((MODEL_EVENTS as readonly string[]).includes(type)) {
            let providerID = (event as AnyEvent).data?.model?.providerID
            if (!providerID) {
              // A session created without an explicit model has the default one
              // on the record, not on the event; the event is still the earliest
              // moment the UI needs the flag.
              try {
                const info: any = await ctx.session.get({ sessionID: sid })
                providerID = typeof info?.model?.providerID === "string" ? info.model.providerID : undefined
              } catch {
                // not readable yet: `context` will mark it at the first request
              }
            }
            if (!providerID) continue
            const local = await isLocalProvider(providerID)
            // A fresh local session needs no flag: its `normal` level is the
            // default and the row already sorts as local.
            if (local && type === "session.created") continue
            log("info", `${type} ${sid}: ${local ? "local" : "cloud"} (${providerID})`)
            void syncState(sid, { cloud: local ? null : true })
            void applyCloudTitle(sid, !local)
            continue
          }
          // A step ends one model request, not the turn. In `request` scope the
          // slot is freed here — unless the step is followed at once by a tool
          // or a continuation, in which case the lease is kept across the gap
          // (`handoffMs`) and released on the matching event. In `turn` scope a
          // step is not a release at all.
          if (type === "session.step.ended" || type === "session.step.failed") {
            if (config.lockScope !== "request") continue
            // Only a request this instance actually served is a handoff: a cloud
            // session's step must not reserve a local slot.
            const released = held.has(sid)
            const finish = type === "session.step.ended" ? String((event as AnyEvent).data?.finish ?? "") : ""
            if (released && config.handoffMs > 0 && (finish === "tool-calls" || finish === "length")) {
              armHandoff(sid, finish === "tool-calls" ? "tool" : "continue")
              continue
            }
            held.delete(sid)
            lock.release(sid, type)
            // The step is over, so nobody holds the slot any more — clear the
            // badge even when another instance served the request and this one
            // has no `held` entry for it.
            void syncState(sid, { holding: null })
            continue
          }
          // The first tool of a step. If the step boundary kept the slot for
          // exactly this moment, the engine is now really free: release it.
          if (type === "session.tool.called") {
            const handoff = handoffs.get(sid)
            if (!handoff) continue
            if (handoff.timer) clearTimeout(handoff.timer)
            handoffs.delete(sid)
            if (!held.delete(sid)) continue
            lock.release(sid, "tool started")
            void syncState(sid, { holding: null })
            continue
          }
          // A terminal event ends the request or turn for good; the lease is
          // released here and the badge must go with it. A queued session has no
          // `holding`, so this write is a no-op for it.
          held.delete(sid)
          const pending = handoffs.get(sid)
          if (pending) {
            if (pending.timer) clearTimeout(pending.timer)
            handoffs.delete(sid)
          }
          lock.release(sid, type)
          void syncState(sid, { holding: null })
          // `release` only frees a slot this session held; a queued one has no
          // lease. Its wait is a separate polling loop, and the reminder tick
          // would keep re-marking the title and take the next free slot for a
          // run that will never happen.
          if (END_OF_RUN_EVENTS.has(type)) {
            lock.cancelWait(sid, type)
          }
          // A session that no longer runs cannot be the one the user needs now.
          if (type === "session.deleted" || type === "session.archived") {
            flags.drop(sid)
          }
          // A queued session has no lease, so a terminal event for it (deleted,
          // inbox cancelled) releases nothing — still drop its title mark.
          void unmarkWaiting(sid, type).finally(() => {
            void refreshPlaces()
          })
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
    const prunedTickets = pruneTickets()
    const orphans = await clearOrphanPlaces()
    // Places left by another instance may be older than its last tick; the
    // queue is the source of truth, so publish it once on boot.
    await refreshPlaces()

    log(
      "info",
      `ready: src=${SOURCE} scope=${config.lockScope} limit=${config.limit} handoff=${
        config.handoffMs
      }ms local=${config.localProviders.join(",")} timeout=${Math.round(
        config.acquireTimeoutMs / 60_000,
      )}min onTimeout=${config.onTimeout} mark=${config.markWaitingTitle} prio=${
        config.priorityEnabled ? `/${config.priorityCommand}` : "off"
      } dir=${config.dir} pruned=${pruned.length} tickets=${prunedTickets} restored=${restored} orphans=${orphans}`,
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
      for (const handoff of handoffs.values()) {
        if (handoff.timer) clearTimeout(handoff.timer)
      }
      handoffs.clear()
      for (const sid of held) lock.release(sid, "unload")
      held.clear()
      for (const sid of [...marked]) await unmarkWaiting(sid, "unload")
      log("info", "unloaded")
    }
  },
})
