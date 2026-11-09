// turn-lock (OpenCode V2 plugin) — hold at most N local-agent sessions on the
// model engine; every other session waits before its model request is sent.
//
// Why: the local engine (strata on 18500) serves one request at a time and
// switches context per request, so N interleaved agent sessions thrash the
// conversation cache. By default the slot covers one *request*: it is taken in
// the `context` hook and freed at the end of that request (`session.step.ended`).
// A `finish: "tool-calls"` or `"length"` step also writes a *return ticket* for
// the session, so when it sends the next request it is served at the front of
// its level — but only once someone has actually been admitted since it released
// (otherwise it would grab back the slot it just freed while a sibling stood at
// the head of the queue). The queue is ordered by the absolute session creation
// time (`session.time.created`), not by when the wait began: inside a level the
// oldest session is served first. `lockScope: "turn"` restores the whole-turn
// lease.
//
// Cloud providers are never gated: both hooks check the provider of the outgoing
// request and return immediately unless it is local. A compaction/summary is a
// model request of its own and is gated by the `compaction` hook, because the
// summary runs on the same local engine: the session keeps the slot it already
// holds until `session.compaction.ended`. `title` and `generate` are not hooked,
// so local bookkeeping calls are never delayed.
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
//     "acquireTimeoutMs": 57600000,     // 16 h: max wait before onTimeout applies (fail-open last resort)
//     "onTimeout": "proceed",           // "proceed" (fail-open) | "hold"
//     "leaseTimeoutMs": 7200000,        // lease without refresh = abandoned
//     "pollMs": 200,
//     "returnTicketTtlMs": 300000,      // how long a released step's return right stays fresh (5 min)
//     "warmHandoffMs": 12000,           // keep the slot across a short tool so the continuation is warm; 0 = free at the tool start
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
//     "logLevel": "info",               // "off" | "info" | "debug"
//     "traceEnabled": true,             // JSON-lines decision trace (see trace.ts)
//     "traceDir": "%TEMP%/opencode/turn-lock-trace",
//     "traceKeepMs": 86400000,          // a day of trace files, older ones are deleted
//     "traceEveryMs": 60000             // queue/lease snapshot cadence, 0 = off
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
import { createReturnTickets } from "./tickets.ts"
import { readState, withState, type Phase, type TurnLockState } from "./state.ts"
import { fileStore, processAlive } from "./store-file.ts"
import { createTrace, type TraceFields } from "./trace.ts"
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
   *  step ends, and returned to the session at the front of its level when it
   *  asks again. */
  lockScope: "request" | "turn"
  /** How long a released step's *return ticket* stays valid. While the ticket
   *  is alive and its holder comes back for the next request, it is served at
   *  the front of its level (once someone has been admitted since it released);
   *  an older ticket is dropped. 0 disables the return priority entirely. */
  returnTicketTtlMs: number
  /** `request` scope only: how long the session keeps its lease after its first
   *  tool starts, so the continuation lands on the engine's warm prompt cache
   *  instead of queueing and re-reading the prompt. The slot is not offered to
   *  the queue during the window; when it runs out the lease is freed and a
   *  return ticket is written, exactly as at a step boundary. 0 frees the slot
   *  at the tool start (the behaviour before 09.11.2026). The old name
   *  `handoffMs` is still read when this key is absent. */
  warmHandoffMs: number
  /** How long a compaction may keep the slot without its end event. The summary
   *  runs on the local engine like any other request, so the slot must stay with
   *  the session that asked for it; `session.compaction.ended` releases it, and
   *  this cap is the last resort for a lost event. 0 disables the cap. */
  compactionHoldMs: number
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
  /** Structured JSON-lines trace of every gate decision (trace.ts). */
  traceEnabled: boolean
  traceDir: string
  /** How long trace day files are kept. One day by default. */
  traceKeepMs: number
  /** Cadence of the `snapshot` line (leases + queue + held set). 0 = off. */
  traceEveryMs: number
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
  // every refreshEveryMs, so a wedged holder is the case it covers). It is kept
  // high on purpose: sessions are meant to wait their turn honestly, and only
  // fail open as a last resort.
  acquireTimeoutMs: 16 * 60 * 60_000,
  onTimeout: "proceed",
  leaseTimeoutMs: 2 * 60 * 60_000,
  // One lease per model request: the slot is freed at the end of each request,
  // and the returning session holds a five-minute return ticket that puts it at
  // the front of its level. `"turn"` restores the old whole-turn lease.
  lockScope: "request",
  pollMs: 200,
  // The return ticket replaces the old handoff at the step boundary: the slot
  // is freed at `step.ended` at once, and the ticket is what stops the
  // returning session from being pushed behind waiters that joined while it
  // worked. It only lives 5 minutes — a session that does not come back within
  // the window simply queues again.
  returnTicketTtlMs: 5 * 60_000,
  // Keep the slot warm across a tool call. The engine drops a conversation's
  // prompt cache when another conversation takes the slot, and at the night's
  // budget the parked copy was evicted within a few requests (measured
  // 09.11.2026: 298 evictions in 8 h, 185 re-reads of 150-210k tokens, 2.4 h
  // of prefill). Tools are short (p50 1 s, p90 6 s), so 12 s lets almost every
  // continuation land on the same engine state; a longer tool costs at most
  // the window, not a full re-read.
  warmHandoffMs: 12_000,
  // A compaction summary is a full local request (often 150-210k tokens), and
  // the primary request follows it. The slot must stay with the session across
  // the summary; the end event normally releases it, so half an hour is only
  // the anti-deadlock cap for an event the stream never delivered.
  compactionHoldMs: 30 * 60_000,
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
  // The trace is what a post-mortem reads: one JSON line per decision, kept for
  // a day so a night of traffic can be replayed. It is cheap (append-only, one
  // small line per event) and off only when asked for.
  traceEnabled: true,
  traceDir: join(tmpdir(), "opencode", "turn-lock-trace"),
  traceKeepMs: 24 * 60 * 60_000,
  traceEveryMs: 60_000,
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

/** The start of a step's tool call. In `request` scope this is the moment the
 *  model request is really over: the answer is streamed, the engine is free
 *  while the tool runs. `session.step.ended` cannot serve as that moment —
 *  OpenCode closes a `tool-calls` step only after the tool has returned, so a
 *  slow tool would hold the slot for its whole run (measured 08.11.2026: a
 *  93 s shell diff held the only slot while the model was idle). */
const TOOL_EVENTS = ["session.tool.called", "session.tool.input.started"] as const

/** The summary request. Compaction runs on the local engine like any other
 *  request, so the slot must stay with the session that asked for it; the
 *  `compaction` hook takes it, and these events say when the summary is over. */
const COMPACTION_EVENTS = [
  "session.compaction.started",
  "session.compaction.ended",
  "session.compaction.failed",
] as const

/** Tools whose run is itself a model request: a subagent's requests ride the
 *  parent's lease (`coveredBy`), so the parent must not free it at the tool
 *  start. `task` is the pre-V2 name of the same tool. */
const SUBAGENT_TOOLS = new Set(["subagent", "task"])

const EVENT_TYPES = [...RELEASE_EVENTS, ...MODEL_EVENTS, ...TOOL_EVENTS, ...COMPACTION_EVENTS] as string[]

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

/** Terminal-event releases after which the session is expected to continue
 *  (a pause for the human). The run resumes, so the session keeps its place by
 *  getting a return ticket, exactly like an expected-continuation step. */
const RETURNING_RELEASE_EVENTS = new Set<string>([
  "form.created",
  "form.replied",
  "form.cancelled",
  "permission.asked",
  "permission.replied",
])

const isRunContinuing = (type: string): boolean => RETURNING_RELEASE_EVENTS.has(type)

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
    /** `session.tool.input.started`: the call the name belongs to. */
    id?: string
    name?: string
    /** `session.step.ended` and `session.tool.called`: the assistant message of
     *  the step. A step that ended late is recognised by it, so its event does
     *  not free a lease the continuation already resumed. */
    assistantMessageID?: string
    /** `session.compaction.*`: `auto` or `manual`. Auto compaction is followed
     *  by the primary request; manual compaction is not. */
    reason?: string
    /** `session.compaction.failed`: the error the summary stopped with. */
    error?: string
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
    warmHandoffMs: Math.max(0, asNumber(value.warmHandoffMs ?? value.handoffMs, base.warmHandoffMs, 0)),
    compactionHoldMs: Math.max(0, asNumber(value.compactionHoldMs, base.compactionHoldMs, 0)),
    returnTicketTtlMs: Math.max(0, asNumber(value.returnTicketTtlMs, base.returnTicketTtlMs, 0)),
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
    traceEnabled: asBoolean(value.traceEnabled, base.traceEnabled),
    traceDir: typeof value.traceDir === "string" && value.traceDir ? value.traceDir : base.traceDir,
    traceKeepMs: asNumber(value.traceKeepMs, base.traceKeepMs, 0),
    traceEveryMs: asNumber(value.traceEveryMs, base.traceEveryMs, 0),
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
    // Tool names by call id. `session.tool.called` carries no name, but a
    // subagent tool must keep its parent's lease: the child's requests run on
    // that lease, so freeing it at the tool start would let a queued session
    // take the slot between a parent and its child. The name arrives on the
    // earlier `session.tool.input.started`, so it is remembered until the call
    // is seen. The map is bounded: a call that never reaches `called` (aborted
    // step) must not grow it forever.
    const toolNames = new Map<string, string>()
    const rememberTool = (id: string, name: string): void => {
      if (toolNames.size >= 500) {
        const oldest = toolNames.keys().next().value
        if (oldest !== undefined) toolNames.delete(oldest)
      }
      toolNames.set(id, name)
    }
    const owner = String(ctx?.location?.directory ?? "")

    // The decision trace (trace.ts). Every line carries the instance's pid and
    // location, so a night of lines from several plugin instances can be split
    // by process and by location afterwards.
    const trace = createTrace({
      dir: config.traceDir,
      prefix: "lock",
      keepMs: config.traceKeepMs,
      enabled: config.traceEnabled,
      base: { pid: process.pid, owner },
    })
    const t = (event: string, fields?: TraceFields) => trace.write(event, fields)
    /** Wall-clock age of a lease, for the "how long did this hold" question. */
    const leaseAge = (since: number): number => Math.max(0, Math.round(Date.now() - since))

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
      phase?: Phase | null
      position?: number | null
      total?: number | null
      since?: number | null
      holding?: number | null
    }
    const applyPatch = (state: TurnLockState, patch: StatePatch): TurnLockState => {
      const next: TurnLockState = { ...state }
      if (patch.level) next.level = patch.level
      for (const key of ["cloud", "phase", "position", "total", "since", "holding"] as const) {
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

    // Warm handoff (`request` scope). The lease is kept after the first tool
    // starts for `warmHandoffMs`, so the continuation finds the engine's prompt
    // cache warm instead of queueing for the slot and re-reading the prompt.
    // The map holds the pending release of each session; `since` is when the
    // window began, for the trace.
    const warmHolds = new Map<string, { timer: ReturnType<typeof setTimeout>; since: number }>()
    // The step whose tool opened the window, and the step whose end arrived
    // after its continuation had already started. OpenCode normally emits
    // `step.ended` before the next request (0.3% of contexts arrive first), but
    // that late event must not free a lease the resumed request is using.
    const warmStep = new Map<string, string>()
    const lateStep = new Map<string, string>()
    const clearWarm = (sid: string): number | undefined => {
      const entry = warmHolds.get(sid)
      if (!entry) return undefined
      clearTimeout(entry.timer)
      warmHolds.delete(sid)
      return entry.since
    }
    // The window ran out before the session asked again: free the slot exactly
    // as a step boundary would, with a return ticket so the session is not
    // pushed behind waiters that joined while its tool ran.
    const expireWarm = (sid: string): void => {
      // A compaction owns the lease now: the warm timer must not free the slot
      // under the summary. `startCompaction` already absorbed the window, so
      // this only drops a timer that raced the compaction hook.
      if (compactionHolds.has(sid)) {
        clearWarm(sid)
        return
      }
      const since = clearWarm(sid)
      if (since === undefined) return
      warmStep.delete(sid)
      lateStep.delete(sid)
      if (!held.has(sid)) return
      t("step.release", { type: "warm-handoff", sid, finish: null, returning: true, warm: "expired" })
      held.delete(sid)
      lock.release(sid, "warm handoff expired")
      returnTickets.write(sid)
      t("ticket.write", { sid, why: "warm handoff expired" })
      void syncState(sid, { holding: null })
    }

    // Compaction (`request` scope) is a model request of its own: the summary
    // runs on the local engine, so the session keeps the slot until
    // `session.compaction.ended`. Without this, the warm window expired while
    // the summary was still generating and the queue took the engine — the
    // continuation then queued behind another session (measured 09.11.2026:
    // 13 of 17 compactions lost the slot mid-summary).
    type CompactionHold = {
      since: number
      reason: string
      timer?: ReturnType<typeof setTimeout>
      /** A warm window was absorbed: an auto summary is followed by the primary
       *  request, so the window is reopened when the summary ends. */
      warm: boolean
    }
    const compactionHolds = new Map<string, CompactionHold>()

    const clearCompaction = (sid: string): CompactionHold | undefined => {
      const entry = compactionHolds.get(sid)
      if (!entry) return undefined
      if (entry.timer) clearTimeout(entry.timer)
      compactionHolds.delete(sid)
      return entry
    }

    const startCompaction = (sid: string, reason: string): void => {
      const previous = clearCompaction(sid)
      // The summary replaces the tool's continuation: the warm timer would
      // otherwise fire mid-summary. The window is remembered so an auto
      // compaction can reopen it for the primary request.
      const warm = previous?.warm === true || warmHolds.has(sid)
      if (warmHolds.has(sid)) {
        const since = clearWarm(sid)
        warmStep.delete(sid)
        t("compaction.absorb-warm", { sid, heldMs: since === undefined ? null : Date.now() - since })
      }
      const entry: CompactionHold = {
        since: previous?.since ?? Date.now(),
        reason: reason || previous?.reason || "summary",
        warm,
      }
      if (config.compactionHoldMs > 0) {
        entry.timer = setTimeout(() => expireCompaction(sid), config.compactionHoldMs)
        if (typeof (entry.timer as { unref?: () => void }).unref === "function") {
          ;(entry.timer as { unref: () => void }).unref()
        }
      }
      compactionHolds.set(sid, entry)
      t("compaction.start", {
        sid,
        reason: entry.reason,
        holdMs: config.compactionHoldMs,
        warm: entry.warm,
        scope: config.lockScope,
      })
      const leaseSince = lock.snapshot().leases.find((lease) => lease.sid === sid)?.since
      // The clients draw the held slot from `phase`/`holding`; a queued wait has
      // left its `position` behind, so it is cleared here.
      void syncState(sid, {
        phase: "sending",
        holding: leaseSince ?? entry.since,
        position: null,
        total: null,
        since: null,
      })
    }

    /** The summary is over. `auto` is followed by the primary request, so the
     *  slot stays warm; `manual` (or a failure) frees it with a return ticket. */
    const endCompaction = (sid: string, reason: string, failed = false): void => {
      const entry = clearCompaction(sid)
      if (!entry) return
      t("compaction.end", {
        sid,
        reason: reason || entry.reason,
        heldMs: Date.now() - entry.since,
        warm: entry.warm,
        failed,
      })
      // A turn lease is the whole turn's; a summary inside it changes nothing.
      if (config.lockScope === "turn") return
      if (!held.has(sid)) return
      if (!failed && reason === "auto" && config.warmHandoffMs > 0) {
        const timer = setTimeout(() => expireWarm(sid), config.warmHandoffMs)
        if (typeof (timer as { unref?: () => void }).unref === "function") (timer as { unref: () => void }).unref()
        warmHolds.set(sid, { timer, since: Date.now() })
        t("step.warm-hold", { sid, ms: config.warmHandoffMs, tool: null, after: "compaction" })
        return
      }
      t("step.release", { type: "compaction", sid, finish: reason || null, returning: true, compaction: "ended" })
      held.delete(sid)
      lock.release(sid, failed ? "compaction failed" : `compaction ${reason || "ended"}`)
      returnTickets.write(sid)
      t("ticket.write", { sid, why: "compaction ended" })
      void syncState(sid, { holding: null, phase: null })
    }

    /** The end event was lost: free the slot before it can wedge the queue. */
    const expireCompaction = (sid: string): void => {
      const entry = clearCompaction(sid)
      if (!entry) return
      t("compaction.expired", { sid, heldMs: Date.now() - entry.since, reason: entry.reason })
      if (!held.has(sid)) return
      t("step.release", { type: "compaction", sid, finish: "expired", returning: true, compaction: "expired" })
      held.delete(sid)
      lock.release(sid, "compaction hold expired")
      returnTickets.write(sid)
      t("ticket.write", { sid, why: "compaction hold expired" })
      void syncState(sid, { holding: null, phase: null })
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

    type WaitMark = {
      pid?: number
      owner?: string
      since?: number
      createdAt?: number
      markedAt?: number
      /** A subagent: it waits for the engine, but its session list row is hidden
       *  under the parent, so it must not take a visible queue place. */
      child?: boolean
    }

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
     *  same thing for everyone.
     *
     *  `child` is sticky: a reminder tick or a late `createdAt` fill rewrites the
     *  file without knowing the ancestry, and must not turn a subagent into a
     *  root in the queue. */
    const writeWaitMark = (sid: string, since: number, created?: number, child?: boolean) => {
      try {
        mkdirSync(config.dir, { recursive: true })
        const isChild = child === true || (child === undefined && readWaitMark(sid)?.child === true)
        writeFileSync(
          waitPath(sid),
          JSON.stringify({
            sid,
            pid: process.pid,
            owner,
            since,
            ...(created !== undefined ? { createdAt: created } : {}),
            ...(isChild ? { child: true } : {}),
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

    /** Return tickets that have expired or belong to a dead process are dropped on
     *  boot; these are the only `.turn.json` files the plugin keeps, so the old
     *  "tickets are gone, drop them all" cleanup is replaced by the sweep. */
    const pruneTickets = (): number => returnTickets.sweep(processAlive)

    /** Everyone waiting right now, oldest wait first. The sidecars are the only
     *  shared record of waiters (the store holds granted leases only), so the
     *  queue position is derived from them; a waiter whose process is gone is
     *  ignored. `createdAt` is the session's absolute creation time, carried in
     *  the sidecar because another instance cannot read a session it does not
     *  own; it is the key the queue is actually ordered by. */
    const readWaiters = (): Array<{ sid: string; since: number; createdAt?: number; child?: boolean }> => {
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
      const waiters: Array<{ sid: string; since: number; createdAt?: number; child?: boolean }> = []
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
        waiters.push({ sid, since, createdAt: created, ...(mark.child === true ? { child: true } : {}) })
      }
      return waiters.sort((a, b) => a.since - b.since || a.sid.localeCompare(b.sid))
    }

    /**
     * Whether this waiter is a subagent. A child waits for the engine exactly
     * like a session, but it has no row of its own in the session list: its
     * wait belongs to the parent's turn, and counting it as a separate place
     * made the badge say `1/10` over a list of six visible sessions. The sidecar
     * is authoritative (it is the shared record), and the parent cache is the
     * fallback for a mark that could not be written.
     */
    const isChildWaiter = (sid: string): boolean => {
      const mark = readWaitMark(sid)
      if (mark) return mark.child === true
      return parents.get(sid) != null
    }

    /** Waiters in visual order: the ones the session list can show. Children
     *  keep their place in the *serving* order (`orderedWaiters`), not in this
     *  one. */
    const visibleWaiters = (sid?: string, since = 0): string[] => {
      const marks = readWaiters()
      const hidden = new Set(marks.filter((waiter) => waiter.child === true).map((waiter) => waiter.sid))
      // A mark that could not be written still has its ancestry in this process.
      if (sid && !marks.some((waiter) => waiter.sid === sid) && parents.get(sid) != null) hidden.add(sid)
      return orderedWaiters(sid, since).filter((id) => !hidden.has(id))
    }

    const placeOf = (sid: string, since: number): QueuePlace | undefined => {
      if (isChildWaiter(sid)) return undefined
      const order = visibleWaiters(sid, since)
      const index = order.indexOf(sid)
      return index < 0 ? undefined : { position: index + 1, total: order.length }
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
            const waiters = readWaiters()
            // Only the rows the session list can draw take a place: a subagent
            // has no row of its own, so counting it made the badge promise more
            // waiters than the list shows. It keeps waiting (and its `since`),
            // it just does not get a `position`.
            const order = visibleWaiters()
            const total = order.length
            // `since` comes from the wait sidecar, not from a previous write: a
            // waiter restored after a plugin reload (or marked by another
            // instance) has a sidecar but may have no `since` in its metadata,
            // and a place without a start time draws no timer in the UI.
            const starts = new Map(waiters.map((waiter) => [waiter.sid, waiter.since]))
            for (const [index, id] of order.entries()) {
              const since = starts.get(id)
              await syncState(id, { position: index + 1, total, ...(since ? { since } : {}) })
            }
            // A child that was counted by an older version (or before its
            // ancestry was known) must lose the place it never had a row for.
            for (const waiter of waiters) {
              if (waiter.child !== true) continue
              await syncState(waiter.sid, { position: null, total: null })
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

    /** When a slot last freed. The head of a level may take it at once; the next
     *  place is let through only after another `fifoGraceMs`, so a head that
     *  stopped polling cannot hold the slot. The same file carries the shared
     *  grant counter (`grants`): how many times a fresh lease has been admitted,
     *  which lets a returning session tell whether it was overtaken while it was
     *  away. An older file with only `at`, or no file at all, reads as grants 0,
     *  so nothing depends on the field existing. */
    const slotFreePath = join(config.dir, "slot-free.json")

    const readSlotFree = (): { at: number; grants: number } => {
      try {
        const value = JSON.parse(readFileSync(slotFreePath, "utf8"))
        return {
          at: typeof value?.at === "number" ? value.at : 0,
          grants: typeof value?.grants === "number" ? value.grants : 0,
        }
      } catch {
        return { at: 0, grants: 0 }
      }
    }

    const readFreeAt = (): number => readSlotFree().at

    /** Current grant counter: how many fresh leases have been admitted. */
    const readGrants = (): number => readSlotFree().grants

    const writeFreeAt = (at: number): void => {
      try {
        mkdirSync(config.dir, { recursive: true })
        const grants = readSlotFree().grants
        writeFileSync(slotFreePath, JSON.stringify({ at, ...(grants ? { grants } : {}) }), "utf8")
      } catch {
        // best-effort: without the file the queue falls back to the first awake
      }
    }

    /** Count one more admitted lease. Wired to the core's `onTake`. */
    const bumpGrants = (): void => {
      try {
        mkdirSync(config.dir, { recursive: true })
        const { at, grants } = readSlotFree()
        writeFileSync(slotFreePath, JSON.stringify({ ...(at ? { at } : {}), grants: grants + 1 }), "utf8")
      } catch {
        // best-effort
      }
    }

    // The return ticket: a session that released its slot at a step boundary
    // and means to continue holds a short right to be served at the front of its
    // level. The module is root-aware (a subagent rides its parent's ticket) and
    // reads the grant counter above.
    const returnTickets = createReturnTickets({
      dir: config.dir,
      ttlMs: config.returnTicketTtlMs,
      owner,
      rootOf: (sid) => roots.get(sid),
      readGrants,
    })

    /**
     * One waiter as the queue sees it. The age is the absolute creation time of
     * the session; when the server does not report it, the start of this wait is
     * the fallback. A flag only supplies the level — inside a level the oldest
     * session is still served first. A live return ticket changes that: if a
     * new grant has happened since the session released, it is `boost`ed to the
     * front of its level; otherwise it is `defer`red until its ticket is lifted.
     */
    const entryOf = (sid: string, waited: number, created?: number): QueueEntry => {
      const flag = flagOf(sid)
      const entry = levelEntry(sid, flag?.level ?? "normal", created ?? createdAt.get(sid) ?? waited)
      const ticket = returnTickets.read(sid)
      if (ticket) {
        // An overtaken session comes back to the front of its level; a session
        // whose release has not been overtaken yet simply waits its turn.
        if (readGrants() > ticket.releasedGrants) entry.boost = ticket.releasedAt
        else entry.defer = true
      }
      return entry
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

    /** May `sid` take a free slot? No, while anyone goes before it: a better
     *  level always, and an older waiter of its own level until the head has had
     *  its `fifoGraceMs`. A returning session additionally holds back while its
     *  release has not been overtaken and others queue behind it — it must not
     *  grab back the slot it just freed until a grant lifts its ticket and
     *  boosts it forward. `since` is when this wait began; the age that orders it
     *  is the session's creation time, exactly like `orderedWaiters`. */
    const holdsBack = (sid: string, since: number): boolean => {
      const me = entryOf(sid, since)
      const waiters = rankedWaiters()
      if (outranking(waiters, sid, me.rank).length) return true
      // Return-ticket staging: while the releasing session has not been overtaken
      // (grants <= releasedGrants), it must not take a free slot either — the slot
      // it freed would ping-pong back to it before a sibling at the head gets a
      // turn. Once a grant lifts the ticket the entry is boosted and this check
      // lets go.
      const ticket = returnTickets.read(sid)
      if (ticket && readGrants() <= ticket.releasedGrants) {
        // Only a waiter that can actually take the slot is worth deferring for,
        // and only one that would be served before `sid`. A waiter of a worse
        // level never can: `sid` outranks it, so the level check above already
        // holds it back. Deferring for such a waiter deadlocks the queue — the
        // slot stays free, no grant lifts the ticket, and everyone waits until
        // `acquireTimeoutMs` or the ticket expires.
        const others = waiters.some(
          (waiter) => waiter.sid !== sid && !waiter.defer && compareQueue(waiter, me) < 0,
        )
        if (others) return true
      }
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
      t("priority", { sid, level, waitedMs: waitedMs ?? null })
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
      // The ancestry is cached by the gate that sent this session here; a child
      // is recorded as such, so every instance can tell a hidden row from a
      // visible one without asking a server that may not own the session.
      const known = createdAt.get(sid) ?? readWaitMark(sid)?.createdAt
      const child = parents.has(sid) ? parents.get(sid) != null : undefined
      writeWaitMark(sid, since, known, child)
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
        phase: "queued",
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
    async function unmarkWaiting(sid: string, reason: string, phase: Phase | null = null): Promise<void> {
      waitEpoch.set(sid, epochOf(sid) + 1)
      const generation = generationOf(sid)
      // A wait that started while this one was being torn down owns the queue
      // now: its sidecar and its place must survive. Without the guard a late
      // grant could delete the mark of the wait that replaced it and leave a
      // `position` in metadata with no sidecar behind it.
      const settled = () => generationOf(sid) === generation
      const clear = () =>
        settled() ? syncState(sid, { position: null, total: null, since: null, phase }) : Promise.resolve()
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
          // A phase that outlived its place is stale too, but a live lease owns
          // its `sending`: the sweep must not wipe a request that is in flight.
          const stale = state.phase !== undefined && !leased.has(sid)
          if (!place && !hold && !stale) continue
          await syncState(sid, {
            ...(place ? { position: null, total: null, since: null } : {}),
            ...(hold ? { holding: null } : {}),
            phase: null,
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
          t("grant", {
            sid: event.sid,
            waited: event.waited,
            waitedMs: event.waitedMs,
            overLimit: event.overLimit,
            held: event.held,
            limit: event.limit,
          })
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
          void unmarkWaiting(event.sid, "grant", "sending").finally(() => {
            void refreshPlaces()
          })
          break
        case "wait":
          t("wait", {
            sid: event.sid,
            held: event.held,
            limit: event.limit,
            waitedMs: event.waitedMs,
            blocked: event.blocked ?? null,
          })
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
          t("release", {
            sid: event.sid,
            reason: event.reason,
            held: event.held,
            since: event.since ?? null,
            ageMs: event.since === undefined ? null : leaseAge(event.since),
          })
          log("info", `release ${event.sid}: ${event.reason} (held ${event.held}/${config.limit})`)
          void unmarkWaiting(event.sid, "release").finally(() => {
            void refreshPlaces()
          })
          break
        case "cancel":
          t("cancel", { sid: event.sid, reason: event.reason })
          log("debug", `cancel wait ${event.sid}: ${event.reason}`)
          void unmarkWaiting(event.sid, "cancel").finally(() => {
            void refreshPlaces()
          })
          break
        case "stale":
          t("stale", { sid: event.sid, ageMs: event.ageMs })
          log("warn", `drop stale lease ${event.sid} (no refresh for ${Math.round(event.ageMs / 1000)}s)`)
          break
        case "timeout":
          t("timeout", { sid: event.sid, waitedMs: event.waitedMs, onTimeout: config.onTimeout })
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
      onTake: bumpGrants,
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
    // tool-driven continuations); title/summary/generate are other hooks. A
    // compaction is a model request of its own and is gated by the `compaction`
    // hook below, because the summary runs on the same local engine.
    const takeSlot = async (sid: string, source: "context" | "compaction"): Promise<boolean> => {
      waiting.add(sid)
      const acquireAt = Date.now()
      t("acquire.start", { sid, level: levelOf(sid), waiting: waiting.size, source })
      const result = await lock.acquire(sid).finally(() => waiting.delete(sid))
      t("acquire.result", {
        sid,
        granted: result.granted,
        waitedMs: Date.now() - acquireAt,
        overLimit: result.overLimit,
        reason: result.reason ?? null,
        source,
      })
      if (!result.granted) {
        log("debug", `skip ${sid}: ${result.reason ?? "not granted"}`)
        return false
      }
      held.add(sid)
      // The badge: the holder of the slot is drawn as the active row, with its
      // own timer. The start is the lease's `since`, not `Date.now()` — a
      // lease that outlived a plugin reload, or a turn lease reused by the
      // next step, must not restart the clock on every request.
      const leaseSince = lock.snapshot().leases.find((lease) => lease.sid === sid)?.since
      t("lease.taken", { sid, since: leaseSince ?? null, level: levelOf(sid), source })
      // The session now holds the slot, so its return right has been used up;
      // the next release writes a fresh ticket.
      returnTickets.drop(sid)
      void syncState(sid, { holding: leaseSince ?? Date.now() })
      return true
    }

    await ctx.session.hook(
      "context",
      async (event: { sessionID?: string; model?: { providerID?: string }; messages?: unknown[] }) => {
        const sid = event?.sessionID
        if (!sid) return
        t("context.enter", { sid, providerID: event?.model?.providerID ?? null, scope: config.lockScope })
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
        if (!local) {
          t("context.cloud", { sid, providerID: event?.model?.providerID ?? null })
          return
        }

        if (config.lockScope === "request") {
          // One lease per model request. The root is cached here so a subagent
          // inherits its parent's level; the same lookup records the session's
          // absolute creation time, which orders the queue.
          await rootOf(sid)
          // The continuation the warm window was kept for: the lease is still
          // ours and the engine still holds this conversation, so the request
          // goes out at once — no queue wait, no re-read of the prompt.
          if (held.has(sid) && warmHolds.has(sid)) {
            const since = clearWarm(sid)
            // A `step.ended` for this same message may still be in flight; the
            // guard in the step branch must recognise it and leave the lease.
            const message = warmStep.get(sid)
            warmStep.delete(sid)
            if (message) lateStep.set(sid, message)
            t("step.warm-resume", {
              sid,
              heldMs: since === undefined ? null : Date.now() - since,
              level: levelOf(sid),
            })
            log("info", `warm resume ${sid}: the continuation arrived inside the handoff window`)
            returnTickets.drop(sid)
            const leaseSince = lock.snapshot().leases.find((lease) => lease.sid === sid)?.since
            void syncState(sid, { holding: leaseSince ?? Date.now() })
            return
          }
          if (held.has(sid)) {
            // A compaction still owns the lease: the summary is in flight, so a
            // context for the same session must not release the slot under it.
            if (compactionHolds.has(sid)) {
              t("context.compaction-keep", { sid })
              return
            }
            // A step event was lost: this is a new context, so the previous
            // request is over and the lease must not turn back into a turn lease.
            t("context.reacquire", { sid, why: "no step event for the held lease" })
            held.delete(sid)
            lock.release(sid, "step-boundary")
            // The run continues, so the released request hands back a return
            // ticket: the session comes next time at the front of its level.
            returnTickets.write(sid)
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
            t("context.covered", { sid, root: cover })
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
            t("context.subagent", { sid, kind: gate.kind, root: gate.root })
            log("info", `subagent ${sid}: ${gate.kind} by ${gate.root}`)
            return
          }

          // Soft preemption. Never interrupt a model or tool call: this hook runs
          // at a step boundary, which is the only place a slot can be given up
          // without breaking anything. A holder that sees a waiter of a better level
          // queued gives its own slot up and re-queues below; it resumes on its own
          // as soon as that waiter is served. So `▽` yields to everyone, `⚡` to nobody.
          if (held.has(sid) && !compactionHolds.has(sid)) {
            const ahead = waitingAbove(rankOf(sid), sid)
            if (ahead.length) {
              const who = ahead.map((waiter) => waiter.sid).join(", ")
              t("yield", { sid, ahead: ahead.map((waiter) => waiter.sid), level: levelOf(sid) })
              log("info", `yield ${sid}: ${who} ${ahead.length === 1 ? "outranks" : "outrank"} it`)
              held.delete(sid)
              lock.release(sid, "priority")
              void syncState(sid, { holding: null, phase: null })
            }
          }
        }

        const granted = await takeSlot(sid, "context")
        if (!granted) return
      },
    )

    // The compaction gate. A summary is a model request of its own, so it needs
    // the same slot as the agent loop — and the session must keep the slot it
    // already holds while the summary generates. Without this hook the warm
    // window expired mid-summary and the queue took the engine (13 of 17
    // compactions on 09.11.2026), so the continuation queued behind another
    // session right after its own compaction.
    await ctx.session.hook(
      "compaction",
      async (event: { sessionID?: string; model?: { providerID?: string }; messages?: unknown[] }) => {
        const sid = event?.sessionID
        if (!sid) return
        t("compaction.enter", { sid, providerID: event?.model?.providerID ?? null, scope: config.lockScope })
        const local = await isLocalProvider(event?.model?.providerID)
        void syncState(sid, { cloud: local ? null : true })
        void applyCloudTitle(sid, !local)
        if (!local) {
          t("compaction.cloud", { sid, providerID: event?.model?.providerID ?? null })
          return
        }

        if (config.lockScope === "request") {
          await rootOf(sid)
          // The tool that opened the warm window is still the same engine use:
          // the summary replaces the continuation, so the lease stays and the
          // window is absorbed into the compaction hold.
          if (held.has(sid)) {
            startCompaction(sid, "held")
            return
          }
          // A child's summary runs on the parent's lease, exactly like its
          // requests; taking a second slot would deadlock the pair.
          const cover = await coveredBy(sid)
          if (cover) {
            lock.refresh(cover)
            t("compaction.covered", { sid, root: cover })
            log("info", `subagent ${sid}: compaction covered by ${cover}`)
            return
          }
        } else {
          const gate = await resolveGate(sid)
          if (gate.kind !== "root") {
            if (gate.kind === "covered") lock.refresh(gate.root)
            t("compaction.subagent", { sid, kind: gate.kind, root: gate.root })
            log("info", `subagent ${sid}: compaction ${gate.kind} by ${gate.root}`)
            return
          }
          // A turn lease already covers the summary; just remember it so the
          // step/terminal guards do not free the slot mid-compaction.
          if (held.has(sid)) {
            startCompaction(sid, "held")
            return
          }
        }

        if (!(await takeSlot(sid, "compaction"))) return
        startCompaction(sid, "acquired")
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

    const controller = new AbortController()
    // Stream liveness: a subscription that dies silently is the one failure the
    // queue cannot survive (the holder keeps refreshing a lease nobody releases),
    // so the trace records how long the stream lived and how many events it saw.
    const stream = { openedAt: Date.now(), events: 0, lastAt: 0 }
    void (async () => {
      try {
        t("stream.open", { types: EVENT_TYPES.length })
        for await (const event of ctx.event.subscribe({ types: EVENT_TYPES, signal: controller.signal })) {
          stream.events += 1
          stream.lastAt = Date.now()
          const type = String((event as AnyEvent).type ?? "")
          const sid = eventSessionID(event as AnyEvent)
          t("event.recv", {
            type,
            sid: sid ?? null,
            finish: (event as AnyEvent).data?.finish ?? null,
            status: (event as AnyEvent).data?.status?.type ?? null,
            held: sid ? held.has(sid) : null,
            waiting: sid ? waiting.has(sid) : null,
            n: stream.events,
          })
          if (type === "config.updated" || type === "provider.updated") {
            localCache.clear()
            continue
          }
          if (type === "form.created" && !config.releaseOnForm) {
            t("event.ignore", { type, sid: sid ?? null, why: "releaseOnForm=false" })
            continue
          }
          if (type === "permission.asked" && !config.releaseOnPermission) {
            t("event.ignore", { type, sid: sid ?? null, why: "releaseOnPermission=false" })
            continue
          }
          if (!sid) {
            t("event.drop", { type, why: "no session id (status busy/retry, or no payload)" })
            continue
          }
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
            t("event.model", { type, sid, providerID, local })
            // A fresh local session needs no flag: its `normal` level is the
            // default and the row already sorts as local.
            if (local && type === "session.created") continue
            log("info", `${type} ${sid}: ${local ? "local" : "cloud"} (${providerID})`)
            void syncState(sid, { cloud: local ? null : true })
            void applyCloudTitle(sid, !local)
            continue
          }
          // The tool name arrives before the call itself; keep it so the call
          // can tell a subagent (which keeps the slot) from an ordinary tool.
          if (type === "session.tool.input.started") {
            const data = (event as AnyEvent).data
            if (data?.id && data?.name) rememberTool(String(data.id), String(data.name))
            continue
          }
          // The first tool of a step. In `request` scope the model answer that
          // produced it is already streamed, so the engine is free while the
          // tool runs: the slot goes to the queue now, not at `step.ended`
          // (which OpenCode emits only after the tool returns). The session gets
          // a return ticket, so a fast tool cannot bounce the slot back and a
          // slow one keeps its place in the queue meanwhile.
          if (type === "session.tool.called") {
            if (config.lockScope !== "request") {
              t("event.ignore", { type, sid, why: "turn scope" })
              continue
            }
            // Same ownership rule as the step boundary: only the instance that
            // served the request may free its lease, and only once — the other
            // tools of the step find no lease here and are ignored.
            if (!held.has(sid)) {
              t("event.ignore", { type, sid, why: "step of a lease this instance does not hold" })
              continue
            }
            const callID = String((event as AnyEvent).data?.id ?? "")
            const name = toolNames.get(callID)
            if (callID) toolNames.delete(callID)
            if (name && SUBAGENT_TOOLS.has(name)) {
              // The child's requests run on this lease, so the engine is not
              // free: the parent keeps the slot until its step really ends.
              t("event.ignore", { type, sid, why: "subagent tool keeps the slot for its child" })
              continue
            }
            if (!name) {
              // The name arrives on `session.tool.input.started`, which a plugin
              // that reloaded mid-run has not seen. An unknown tool may be a
              // subagent, whose child rides this lease: freeing the slot now
              // would deadlock the pair (the parent cannot end its step until
              // the child answers). Keep the slot until the step boundary.
              t("event.ignore", { type, sid, why: "tool name unknown: the slot stays until the step ends" })
              continue
            }
            if (config.warmHandoffMs > 0) {
              // Hold the slot for a moment instead of freeing it at once: the
              // tool is short (p50 1 s, p90 6 s) and the continuation then
              // lands on the same engine state, so the prompt is not read
              // again. A slow tool pays at most the window; `expireWarm` then
              // frees the slot exactly as a step boundary would. The second
              // tool of a parallel batch only extends the same window.
              const previous = warmHolds.get(sid)
              if (previous) clearTimeout(previous.timer)
              else t("step.warm-hold", { sid, ms: config.warmHandoffMs, tool: name ?? null })
              const timer = setTimeout(() => expireWarm(sid), config.warmHandoffMs)
              if (typeof (timer as { unref?: () => void }).unref === "function") (timer as { unref: () => void }).unref()
              warmHolds.set(sid, { timer, since: previous?.since ?? Date.now() })
              const message = String((event as AnyEvent).data?.assistantMessageID ?? "")
              if (message) warmStep.set(sid, message)
              continue
            }
            t("step.release", { type, sid, finish: "tool-calls", returning: true })
            held.delete(sid)
            lock.release(sid, "tool started")
            returnTickets.write(sid)
            t("ticket.write", { sid, why: "tool-calls" })
            void syncState(sid, { holding: null })
            continue
          }
          // Compaction is a request of its own. The `compaction` hook took the
          // slot (or kept the one already held); these events are its end. Only
          // the instance that holds the compaction may decide — the stream is
          // server-wide, like every other event.
          if ((COMPACTION_EVENTS as readonly string[]).includes(type)) {
            const reason = String((event as AnyEvent).data?.reason ?? "")
            if (type === "session.compaction.started") {
              t("compaction.event", { type, sid, reason: reason || null })
              // The hook runs before the summary. If it was missed (a reload
              // between the tool and the summary), a held lease still must not
              // lose the slot to the warm timer.
              if (held.has(sid) && !compactionHolds.has(sid)) startCompaction(sid, "event")
              continue
            }
            if (!compactionHolds.has(sid)) {
              t("event.ignore", { type, sid, why: "compaction of a lease this instance does not hold" })
              continue
            }
            endCompaction(sid, reason, type === "session.compaction.failed")
            continue
          }
          // A step ends one model request, not the turn. In `request` scope the
          // slot is freed here for any finish. A `tool-calls` or `length` step
          // is followed by another request from the same session, so it also
          // writes a return ticket: the session is served at the front of its
          // level next time (once someone has been admitted since it released).
          // In `turn` scope a step is not a release at all.
          if (type === "session.step.ended" || type === "session.step.failed") {
            if (config.lockScope !== "request") {
              t("event.ignore", { type, sid, why: "turn scope" })
              continue
            }
            // The event stream is server-wide, so every instance of every
            // location sees this step — but only the instance that served the
            // request may decide what its boundary means. Releasing here
            // unconditionally would drop a lease another instance is keeping for
            // the request it is currently serving. A lease left by a dead
            // instance is the stale sweep's job, not a sibling's.
            if (!held.has(sid)) {
              t("event.ignore", { type, sid, why: "step of a lease this instance does not hold" })
              continue
            }
            const finish = type === "session.step.ended" ? String((event as AnyEvent).data?.finish ?? "") : ""
            // The summary is in flight: a step boundary (the summary's own, or
            // a late one from the tool that opened the window) is not the end of
            // this session's engine use.
            if (compactionHolds.has(sid)) {
              t("step.compaction-keep", { type, sid, finish })
              continue
            }
            // The step that ended late: its continuation already started on the
            // warm lease, so this event must not free the slot it is using.
            const message = String((event as AnyEvent).data?.assistantMessageID ?? "")
            if (message && lateStep.get(sid) === message) {
              lateStep.delete(sid)
              t("event.ignore", { type, sid, why: "step ended after its continuation had already started" })
              continue
            }
            // A warm hold is still pending: the step boundary is not the end of
            // this session's engine use. `tool-calls`/`length` continue the run
            // right away, so the lease and the window stay; any other finish
            // means the turn is over and the slot must go now.
            if (warmHolds.has(sid)) {
              if (finish === "tool-calls" || finish === "length") {
                t("step.warm-keep", { type, sid, finish })
                continue
              }
              clearWarm(sid)
              warmStep.delete(sid)
              lateStep.delete(sid)
              t("step.release", { type, sid, finish, returning: false, warm: "ended" })
              held.delete(sid)
              lock.release(sid, finish || type)
              void syncState(sid, { holding: null })
              continue
            }
            t("step.release", { type, sid, finish, returning: finish === "tool-calls" || finish === "length" })
            held.delete(sid)
            lock.release(sid, finish === "tool-calls" || finish === "length" ? "step-boundary" : type)
            if (finish === "tool-calls" || finish === "length") {
              // The request is going to continue; hand the session a return right.
              returnTickets.write(sid)
              t("ticket.write", { sid, why: "step-boundary" })
            }
            // The step is over, so nobody holds the slot any more — clear the
            // badge even when another instance served the request and this one
            // has no `held` entry for it.
            void syncState(sid, { holding: null })
            continue
          }
          // A terminal event ends the request or turn for good; the lease is
          // released here and the badge must go with it. A queued session has no
          // `holding`, so this write is a no-op for it.
          //
          // A compaction is still generating on this lease: an idle or a status
          // event belongs to the work around the summary, not to its end, and
          // must not hand the engine to the queue. The cap in `expireCompaction`
          // is the way out if the end event never arrives.
          if (compactionHolds.has(sid) && type !== "session.deleted" && type !== "session.archived") {
            t("terminal.compaction-keep", { type, sid })
            continue
          }
          if (compactionHolds.has(sid)) clearCompaction(sid)
          t("terminal", { type, sid, held: held.has(sid) })
          clearWarm(sid)
          warmStep.delete(sid)
          lateStep.delete(sid)
          const wasHeld = held.delete(sid)
          lock.release(sid, type)
          void syncState(sid, { holding: null })
          // `release` only frees a slot this session held; a queued one has no
          // lease. Its wait is a separate polling loop, and the reminder tick
          // would keep re-marking the title and take the next free slot for a
          // run that will never happen.
          if (END_OF_RUN_EVENTS.has(type)) {
            lock.cancelWait(sid, type)
            returnTickets.drop(sid)
          }
          // A session that no longer runs cannot be the one the user needs now.
          if (type === "session.deleted" || type === "session.archived") {
            flags.drop(sid)
            returnTickets.drop(sid)
          }
          // A form/permission pause frees the slot but the run continues after
          // the human answers, so the pausing session keeps its place: it gets a
          // return ticket, exactly like a step it is expected to continue from.
          if (wasHeld && isRunContinuing(type)) {
            returnTickets.write(sid)
            t("ticket.write", { sid, why: type })
          }
          // A queued session has no lease, so a terminal event for it (deleted,
          // inbox cancelled) releases nothing — still drop its title mark.
          void unmarkWaiting(sid, type).finally(() => {
            void refreshPlaces()
          })
        }
        // The iterator ended without throwing. On unload that is the normal
        // path (the abort signal stops the loop); at any other time it means
        // the subscription is over and this instance will never see a step
        // boundary again. Either way the line must exist: `stream.open`
        // without a matching `closed` is itself the symptom.
        t("stream.closed", {
          events: stream.events,
          livedMs: Date.now() - stream.openedAt,
          lastEventAgoMs: stream.lastAt ? Date.now() - stream.lastAt : null,
          aborted: controller.signal.aborted,
          how: "ended",
          error: null,
        })
        if (!controller.signal.aborted) {
          log("warn", `event stream ended unexpectedly after ${stream.events} events`)
        }
      } catch (error) {
        // The stream closed: on unload that is expected, at any other time it
        // means this instance will never see a step boundary again. The trace
        // line is what makes that visible after the fact.
        const closed = {
          events: stream.events,
          livedMs: Date.now() - stream.openedAt,
          lastEventAgoMs: stream.lastAt ? Date.now() - stream.lastAt : null,
          aborted: controller.signal.aborted,
          how: "threw",
          error: String((error as { message?: string })?.message ?? error),
        }
        t("stream.closed", closed)
        if (!controller.signal.aborted) {
          log("warn", `event stream closed unexpectedly: ${closed.error} (after ${closed.events} events)`)
        }
      }
    })()

    const sweeper = setInterval(() => {
      t("sweep", { leases: lock.snapshot().leases.length })
      lock.sweep()
    }, config.sweepMs)
    if (typeof (sweeper as { unref?: () => void }).unref === "function") (sweeper as { unref: () => void }).unref()

    // Keep leases of this process fresh: a live session doing a long single
    // generation must not look abandoned to other processes.
    const heartbeat =
      config.refreshEveryMs > 0
        ? setInterval(() => {
            for (const sid of held) {
              lock.refresh(sid)
              t("refresh", { sid, source: "heartbeat" })
            }
            t("heartbeat", { held: [...held], waiting: [...waiting] })
          }, config.refreshEveryMs)
        : undefined
    if (heartbeat && typeof (heartbeat as { unref?: () => void }).unref === "function") {
      ;(heartbeat as { unref: () => void }).unref()
    }

    // The snapshot is the trace's backbone: even if every event line were lost,
    // a minute-by-minute picture of who held the slot, who waited and what this
    // instance thought it held is enough to reconstruct the night.
    const snapshotter =
      config.traceEveryMs > 0
        ? setInterval(() => {
            let leases: Array<Record<string, unknown>> = []
            try {
              leases = lock.snapshot().leases.map((lease) => ({
                sid: lease.sid,
                since: lease.since,
                seen: lease.seen,
                ageMs: leaseAge(lease.since),
                staleMs: Date.now() - lease.seen,
                over: lease.over === true,
                pid: lease.pid ?? null,
                owner: lease.owner ?? null,
              }))
            } catch {
              // a snapshot is best-effort
            }
            const queue = rankedWaiters()
              .sort(compareQueue)
              .map((entry, index) => ({
                sid: entry.sid,
                rank: entry.rank,
                position: index + 1,
                age: entry.age,
                boost: entry.boost ?? null,
                defer: !!entry.defer,
              }))
            t("snapshot", {
              leases,
              queue,
              held: [...held],
              warm: [...warmHolds.keys()],
              compaction: [...compactionHolds.keys()],
              waiting: [...waiting],
              events: stream.events,
              lastEventAgoMs: stream.lastAt ? Date.now() - stream.lastAt : null,
            })
          }, config.traceEveryMs)
        : undefined
    if (snapshotter && typeof (snapshotter as { unref?: () => void }).unref === "function") {
      ;(snapshotter as { unref: () => void }).unref()
    }

    const restored = await restoreStaleMarks()
    const prunedTickets = pruneTickets()
    const orphans = await clearOrphanPlaces()
    // Places left by another instance may be older than its last tick; the
    // queue is the source of truth, so publish it once on boot.
    await refreshPlaces()

    t("boot", {
      scope: config.lockScope,
      limit: config.limit,
      warmHandoffMs: config.warmHandoffMs,
      compactionHoldMs: config.compactionHoldMs,
      returnTicketTtlMs: config.returnTicketTtlMs,
      leaseTimeoutMs: config.leaseTimeoutMs,
      pollMs: config.pollMs,
      refreshEveryMs: config.refreshEveryMs,
      sweepMs: config.sweepMs,
      timeoutMs: config.acquireTimeoutMs,
      onTimeout: config.onTimeout,
      localProviders: config.localProviders,
      dir: config.dir,
      logFile: config.logFile,
      traceFile: trace.file(),
      pruned: pruned.length,
      prunedSids: pruned,
      tickets: prunedTickets,
      restored,
      orphans,
      source: SOURCE,
      node: process.version,
    })

    log(
      "info",
      `ready: src=${SOURCE} scope=${config.lockScope} limit=${config.limit} ticket=${
        config.returnTicketTtlMs
      }ms warm=${config.warmHandoffMs}ms compaction=${config.compactionHoldMs}ms local=${config.localProviders.join(",")} timeout=${Math.round(
        config.acquireTimeoutMs / 60_000,
      )}min onTimeout=${config.onTimeout} mark=${config.markWaitingTitle} prio=${
        config.priorityEnabled ? `/${config.priorityCommand}` : "off"
      } dir=${config.dir} pruned=${pruned.length} tickets=${prunedTickets} restored=${restored} orphans=${orphans}`,
    )

    return async () => {
      t("shutdown", { held: [...held], waiting: [...waiting], events: stream.events })
      controller.abort()
      clearInterval(sweeper)
      if (heartbeat) clearInterval(heartbeat)
      if (snapshotter) clearInterval(snapshotter)
      // A pending warm release must not fire after the instance is gone: the
      // session is released below, and the timer would then free a lease the
      // next instance may already own.
      for (const entry of warmHolds.values()) clearTimeout(entry.timer)
      warmHolds.clear()
      warmStep.clear()
      lateStep.clear()
      for (const entry of compactionHolds.values()) {
        if (entry.timer) clearTimeout(entry.timer)
      }
      compactionHolds.clear()
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
