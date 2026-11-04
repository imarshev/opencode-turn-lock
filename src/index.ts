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
// While a session is queued it posts one synthetic message into its own
// transcript ("запрос стоит в очереди, занято N из M, ждёт ses_…") and repeats
// it every `remindEveryMs` while it keeps waiting. The notice uses
// `delivery: "queue"` and `resume: false`, so it never preempts the running
// step and never schedules another run.
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
//     "notify": "wait",                 // "off" | "wait" (queued notice) | "all" (+ granted/over-limit)
//     "notifyEveryMs": 30000,           // at most one queue notice per session per interval
//     "remindEveryMs": 300000,          // repeat the notice while still queued
//     "dir": "%TEMP%/opencode/turn-lock",
//     "logFile": "%TEMP%/opencode/turn-lock.log",
//     "logLevel": "info"                // "off" | "info" | "debug"
//   }

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { Plugin } from "@opencode/plugin"

import { createTurnLock, type ChangeEvent } from "./core.ts"
import { fileStore, processAlive } from "./store-file.ts"

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
  notify: "off" | "wait" | "all"
  notifyEveryMs: number
  remindEveryMs: number
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
  notify: "wait",
  notifyEveryMs: 30_000,
  remindEveryMs: 5 * 60_000,
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
    notify: value.notify === "off" || value.notify === "all" ? value.notify : value.notify === "wait" ? "wait" : base.notify,
    notifyEveryMs: asNumber(value.notifyEveryMs, base.notifyEveryMs, 0),
    remindEveryMs: asNumber(value.remindEveryMs, base.remindEveryMs, 0),
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

/** Compact session id for human-facing notices: `ses_1234…abcd`. */
export function shortSessionID(sid: string): string {
  return sid.length <= 13 ? sid : `${sid.slice(0, 8)}…${sid.slice(-4)}`
}

/** Human duration: "42 с", "13 мин", "2 ч 5 мин". */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1_000))
  if (seconds < 90) return `${seconds} с`
  const minutes = Math.round(seconds / 60)
  if (minutes < 90) return `${minutes} мин`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours} ч ${rest} мин` : `${hours} ч`
}

/**
 * Text of the in-session queue notice. Delivered as a synthetic message
 * (`delivery: "queue"`, `resume: false`), so it shows up in the session
 * transcript without scheduling another run or preempting the current step.
 */
export function queueNotice(input: {
  held: number
  limit: number
  holders: Array<{ sid: string; since: number }>
  now: number
  waitedMs: number
}): string {
  const holders = input.holders
    .slice(0, 3)
    .map((holder) => `${shortSessionID(holder.sid)} — ${formatDuration(input.now - holder.since)}`)
    .join(", ")
  const repeat = input.waitedMs > 0
  const head = repeat
    ? `⏳ turn-lock: всё ещё в очереди (${formatDuration(input.waitedMs)})`
    : "⏳ turn-lock: запрос стоит в очереди"
  return `${head} — занято ${input.held} из ${input.limit} локальных слотов${holders ? ` (${holders})` : ""}. Запрос уйдёт в модель автоматически, как только слот освободится.`
}

export function grantNotice(waitedMs: number, overLimit: boolean): string {
  if (overLimit) {
    return `⚠ turn-lock: слот не освободился за ${formatDuration(waitedMs)} — отправляю запрос сверх лимита.`
  }
  return `▶ turn-lock: слот получен, запрос уходит в модель (ожидание ${formatDuration(waitedMs)}).`
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
    const notifiedAt = new Map<string, number>()

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
            void notify(event.sid, "grant", grantNotice(event.waitedMs, event.overLimit))
          } else {
            log("debug", `grant ${event.sid} (held ${event.held}/${event.limit})`)
          }
          break
        case "wait":
          log(
            "info",
            `wait ${event.sid}: ${event.held}/${event.limit} local sessions are busy${
              event.waitedMs ? ` (already ${Math.round(event.waitedMs / 1000)}s)` : ""
            }`,
          )
          void notify(
            event.sid,
            "wait",
            queueNotice({
              held: event.held,
              limit: event.limit,
              holders: lock.snapshot().leases.filter((lease) => lease.sid !== event.sid),
              now: Date.now(),
              waitedMs: event.waitedMs,
            }),
          )
          break
        case "release":
          log("info", `release ${event.sid}: ${event.reason} (held ${event.held}/${config.limit})`)
          break
        case "cancel":
          log("debug", `cancel wait ${event.sid}: ${event.reason}`)
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
      owner: String(ctx?.location?.directory ?? ""),
      onChange,
    })

    /** In-session queue notice: a durable synthetic message, queued (never a
     *  preemption) and without scheduling a run. Best-effort and unawaited so
     *  a slow or failing notice can never delay or break the gate. */
    async function notify(sid: string, kind: "wait" | "grant", text: string): Promise<void> {
      if (config.notify === "off") return
      if (kind === "grant" && config.notify !== "all") return
      if (kind === "wait" && config.notifyEveryMs > 0) {
        const at = Date.now()
        const last = notifiedAt.get(sid)
        if (last !== undefined && at - last < config.notifyEveryMs) return
        notifiedAt.set(sid, at)
      }
      if (typeof ctx?.session?.synthetic !== "function") return
      try {
        await ctx.session.synthetic({
          sessionID: sid,
          text,
          delivery: "queue",
          resume: false,
          metadata: { plugin: "turn-lock", kind },
        })
        log("debug", `notice ${sid}: ${kind}`)
      } catch (error) {
        log("debug", `notice ${sid} failed: ${String(error)}`)
      }
    }

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
    await ctx.session.hook("context", async (event: { sessionID?: string; model?: { providerID?: string } }) => {
      const sid = event?.sessionID
      if (!sid) return
      if (!(await isLocalProvider(event?.model?.providerID))) return

      const gate = await resolveGate(sid)
      if (gate.kind !== "root") {
        // A subagent: covered by the parent's slot (keep it fresh) or exempt
        // because the parent run is not gated at all.
        if (gate.kind === "covered") lock.refresh(gate.root)
        log("info", `subagent ${sid}: ${gate.kind} by ${gate.root}`)
        return
      }

      const result = await lock.acquire(sid)
      if (!result.granted) {
        log("debug", `skip ${sid}: ${result.reason ?? "not granted"}`)
        return
      }
      held.add(sid)
    })

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

    log(
      "info",
      `ready: limit=${config.limit} local=${config.localProviders.join(",")} timeout=${Math.round(
        config.acquireTimeoutMs / 60_000,
      )}min onTimeout=${config.onTimeout} notify=${config.notify} dir=${config.dir} pruned=${pruned.length}`,
    )

    return async () => {
      controller.abort()
      clearInterval(sweeper)
      if (heartbeat) clearInterval(heartbeat)
      for (const sid of held) lock.release(sid, "unload")
      held.clear()
      log("info", "unloaded")
    }
  },
})
