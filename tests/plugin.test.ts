// End-to-end tests for the shipped plugin entry point src/index.ts.
//
// @opencode/plugin is replaced by tests/stubs/opencode-plugin.mjs through
// module.registerHooks; everything else (hook gating, event releases, shared
// file store, boot cleanup, timeout) is the real code.
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { registerHooks } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@opencode/plugin") {
      return { url: new URL("./stubs/opencode-plugin.mjs", import.meta.url).href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})

const mod = await import("../src/index.ts")
const plugin = mod.default
const { fileStore } = await import("../src/store-file.ts")
const { readState } = await import("../src/state.ts")

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function until(predicate: () => boolean, label: string, timeoutMs = 4_000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return
    await wait(10)
  }
  throw new Error(`timed out waiting for ${label}`)
}

type Hook = { name: string; callback: (event: unknown) => unknown }

function makeEventBus() {
  const subscribers = new Set<{
    types?: string[]
    items: unknown[]
    wake?: () => void
    done: boolean
  }>()

  const emit = (event: { type: string; data?: unknown }) => {
    for (const subscriber of subscribers) {
      if (subscriber.types && !subscriber.types.includes(event.type)) continue
      subscriber.items.push(event)
      subscriber.wake?.()
    }
  }

  const subscribe = (options?: { types?: string[]; signal?: AbortSignal }) => {
    const subscriber = { types: options?.types, items: [] as unknown[], wake: undefined as (() => void) | undefined, done: false }
    subscribers.add(subscriber)
    options?.signal?.addEventListener("abort", () => {
      subscriber.done = true
      subscriber.wake?.()
    })
    return {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            for (;;) {
              if (subscriber.items.length) return { value: subscriber.items.shift(), done: false }
              if (subscriber.done) return { value: undefined, done: true }
              await new Promise<void>((resolve) => {
                subscriber.wake = resolve
              })
              subscriber.wake = undefined
            }
          },
          async return() {
            subscriber.done = true
            return { value: undefined, done: true as const }
          },
        }
      },
    }
  }

  return { emit, subscribe, size: () => subscribers.size }
}

const PROVIDERS: Record<string, unknown> = {
  strata: { id: "strata", name: "Strata", activation: "enabled", package: "x", settings: { baseURL: "http://127.0.0.1:18500/v1" } },
  // a second local engine on an explicit loopback host, resolved by baseURL only
  local2: { id: "local2", name: "Local 2", activation: "enabled", package: "x", settings: { baseURL: "http://localhost:18601/v1" } },
  polzaai: { id: "polzaai", name: "Polza", activation: "enabled", package: "x", settings: { baseURL: "https://polza.ai/api/v1" } },
}

type Behavior = {
  failUpdate?: boolean
  parents?: Record<string, string>
  titles?: Record<string, string>
  /** Sessions the server answers with "not found" (deleted, archived). */
  missing?: Set<string>
  /** Metadata already stored on a session before the plugin starts. */
  metadata?: Record<string, Record<string, unknown>>
  /** Explicit session creation times (`session.time.created`). A session not
   *  listed here reports `1`, so two unlisted sessions tie and the queue falls
   *  back to the session id — the same order the tests use in their names. */
  created?: Record<string, number>
}

function makeCtx(options: Record<string, unknown>, behavior: Behavior = {}, sharedBus?: ReturnType<typeof makeEventBus>) {
  const hooks: Hook[] = []
  // The real server hands the same event stream to every plugin instance (one
  // per location), so a test that models two locations must share one bus.
  const bus = sharedBus ?? makeEventBus()
  const updates: Array<{ sessionID: string; title: string }> = []
  const parents = behavior.parents ?? {}
  const titles = new Map<string, string>(Object.entries(behavior.titles ?? {}))
  const metadata = new Map<string, Record<string, unknown>>(Object.entries(behavior.metadata ?? {}))
  const created = new Map<string, number>(Object.entries(behavior.created ?? {}))
  const createdOf = (sessionID: string) => created.get(sessionID) ?? 1
  const titleOf = (sessionID: string) => titles.get(sessionID) ?? "test session"
  const commands: Array<{ name: string; description?: string; execute: (input: unknown) => Promise<void> }> = []
  const ctx = {
    app: { version: "test" },
    location: { directory: "C:/work" },
    options,
    session: {
      hook: async (name: string, callback: (event: unknown) => unknown) => {
        const hook = { name, callback }
        hooks.push(hook)
        return {
          dispose: async () => {
            const index = hooks.indexOf(hook)
            if (index >= 0) hooks.splice(index, 1)
          },
        }
      },
      get: async ({ sessionID }: { sessionID: string }) => {
        if (behavior.missing?.has(sessionID)) throw new Error(`session ${sessionID} not found`)
        return {
          id: sessionID,
          parentID: parents[sessionID],
          title: titleOf(sessionID),
          metadata: metadata.get(sessionID),
          time: { created: createdOf(sessionID) },
        }
      },
      list: async ({ limit = 100, cursor }: { limit?: number; cursor?: string } = {}) => {
        const ids = [...new Set([...titles.keys(), ...metadata.keys()])].sort()
        const start = cursor ? ids.indexOf(cursor) + 1 : 0
        const data = ids.slice(start, start + limit).map((id) => ({
          id,
          parentID: parents[id],
          title: titleOf(id),
          metadata: metadata.get(id),
          time: { created: createdOf(id) },
        }))
        const next = start + limit < ids.length ? ids[start + limit] : undefined
        return { data, cursor: { next } }
      },
      update: async ({ sessionID, title, metadata: next }: { sessionID: string; title?: string; metadata?: Record<string, unknown> }) => {
        if (behavior.failUpdate) throw new Error("session update failed")
        if (typeof title === "string") {
          titles.set(sessionID, title)
          updates.push({ sessionID, title })
        }
        if (next !== undefined) metadata.set(sessionID, next)
      },
    },
    provider: {
      get: async ({ providerID }: { providerID: string }) => {
        const info = PROVIDERS[providerID]
        if (!info) throw new Error(`unknown provider ${providerID}`)
        return info
      },
    },
    command: {
      transform: async (callback: (editor: { add: (command: (typeof commands)[number]) => void }) => void) => {
        callback({
          add: (command) => {
            const index = commands.findIndex((candidate) => candidate.name === command.name)
            if (index >= 0) commands.splice(index, 1, command)
            else commands.push(command)
          },
        })
        return { dispose: async () => {} }
      },
      list: async () => commands,
    },
    event: { subscribe: bus.subscribe },
  }
  return { ctx, hooks, bus, titles, metadata, updates, commands }
}

type Harness = Awaited<ReturnType<typeof setup>>

async function setup(
  overrides: Record<string, unknown> = {},
  behavior: Behavior = {},
  before?: (dir: string) => void,
  shared: { dir?: string; bus?: ReturnType<typeof makeEventBus> } = {},
) {
  const dir = shared.dir ?? mkdtempSync(join(tmpdir(), "turn-lock-plugin-"))
  before?.(dir)
  const logFile = join(dir, "turn-lock.log")
  const { ctx, hooks, bus, titles, metadata, updates, commands } = makeCtx(
    {
      dir,
      logFile,
      pollMs: 10,
      acquireTimeoutMs: 4_000,
      refreshEveryMs: 0,
      remindEveryMs: 0,
      sweepMs: 60_000,
      // The tests below spell out the limit they exercise; the shipped default
      // (1) is asserted separately. `handoffMs` is the old name of the warm
      // window; the harness sets it to 0 so a tool start frees the slot at once
      // unless a test asks for the window by name.
      limit: 2,
      handoffMs: 0,
      // The original behaviour is the reference for these tests; the request
      // scope has its own tests below.
      lockScope: "turn",
      // The decision trace goes next to the test's temp dir; no snapshot timer,
      // so a test only reads the lines its own actions produced.
      traceDir: join(dir, "trace"),
      traceEveryMs: 0,
      ...overrides,
    },
    behavior,
    shared.bus,
  )
  const returned = await plugin.setup(ctx as unknown as Parameters<typeof plugin.setup>[0])
  // `setup` may return nothing (a disabled plugin), so the cleanup is optional
  const cleanup = async () => {
    if (typeof returned === "function") await returned()
  }
  const harness = {
    dir,
    logFile,
    hooks,
    bus,
    titles,
    metadata,
    updates,
    commands,
    cleanup,
    /** Runs a plugin-registered slash command the way the server does: the
     *  callback runs immediately, with the session it was typed in. */
    async command(sessionID: string, name = "prio", text = "") {
      const definition = commands.find((candidate) => candidate.name === name)
      if (!definition) throw new Error(`plugin did not register /${name}`)
      await definition.execute({ sessionID, prompt: { text }, delivery: "steer" })
    },
    prioFiles() {
      return readdirSync(dir)
        .filter((name) => name.endsWith(".prio.json"))
        .map((name) => name.slice(0, -".prio.json".length))
    },
    logText() {
      return readFileSync(logFile, "utf8")
    },
    /** Every line of the decision trace, parsed. */
    traceLines(): Array<Record<string, any>> {
      const traceDir = join(dir, "trace")
      if (!existsSync(traceDir)) return []
      const lines: Array<Record<string, any>> = []
      for (const name of readdirSync(traceDir)) {
        if (!name.endsWith(".jsonl")) continue
        for (const line of readFileSync(join(traceDir, name), "utf8").split("\n")) {
          if (line.trim()) lines.push(JSON.parse(line))
        }
      }
      return lines
    },
    async context(sessionID: string, providerID = "strata", messages: unknown[] = []) {
      const hook = hooks.find((candidate) => candidate.name === "context")
      if (!hook) throw new Error("plugin did not register the context hook")
      await hook.callback({
        sessionID,
        model: { providerID },
        agent: "build",
        system: [],
        messages,
        options: {},
        tools: {},
      })
    },
    async events() {
      // give the subscription loop a chance to start before the first emit
      await wait(20)
    },
    async teardown() {
      await cleanup?.()
      rmSync(dir, { recursive: true, force: true })
    },
  }
  await harness.events()
  return harness
}

test("limit: 2 local sessions run, the third waits until a slot is released", async () => {
  const harness = await setup()
  try {
    await harness.context("ses_1")
    await harness.context("ses_2")

    let thirdDone = false
    const third = harness.context("ses_3").then(() => {
      thirdDone = true
    })

    await wait(150)
    assert.equal(thirdDone, false, "third local session must not reach the model")

    harness.bus.emit({ type: "session.idle", data: { sessionID: "ses_1" } })
    await third
    assert.equal(thirdDone, true, "the freed slot admits the waiting session")
  } finally {
    await harness.teardown()
  }
})

test("cloud sessions bypass the limit entirely (and never create a lease)", async () => {
  const harness = await setup()
  try {
    await harness.context("ses_local_1")
    await harness.context("ses_local_2")

    const started = Date.now()
    await harness.context("ses_cloud_1", "polzaai")
    await harness.context("ses_cloud_2", "polzaai")
    assert.ok(Date.now() - started < 500, "cloud requests are not delayed")

    // unknown provider is treated as remote -> bypass, not block
    const started2 = Date.now()
    await harness.context("ses_unknown", "does-not-exist")
    assert.ok(Date.now() - started2 < 500)

    const leases = fileStore(harness.dir).list()
    assert.deepEqual(
      leases.map((lease: { sid: string }) => lease.sid).sort(),
      ["ses_local_1", "ses_local_2"],
      "only local sessions hold leases",
    )
  } finally {
    await harness.teardown()
  }
})

test("a local provider is detected by its loopback baseURL, not only by id", async () => {
  const harness = await setup()
  try {
    await harness.context("ses_a", "local2")
    await harness.context("ses_b", "local2")

    let thirdDone = false
    const third = harness.context("ses_c", "local2").then(() => {
      thirdDone = true
    })
    await wait(150)
    assert.equal(thirdDone, false, "localhost:18601 is local too")

    harness.bus.emit({ type: "session.status", data: { sessionID: "ses_a", status: { type: "idle" } } })
    await third
  } finally {
    await harness.teardown()
  }
})

test("releases: idle, succeeded, failed, interrupted, deleted, form.created, permission.asked", async () => {
  const cases: Array<{ name: string; event: { type: string; data: unknown } }> = [
    { name: "session.idle", event: { type: "session.idle", data: { sessionID: "ses_1" } } },
    { name: "session.execution.succeeded", event: { type: "session.execution.succeeded", data: { sessionID: "ses_1" } } },
    { name: "session.execution.failed", event: { type: "session.execution.failed", data: { sessionID: "ses_1", error: {} } } },
    { name: "session.execution.interrupted", event: { type: "session.execution.interrupted", data: { sessionID: "ses_1", reason: "user" } } },
    { name: "session.deleted", event: { type: "session.deleted", data: { sessionID: "ses_1" } } },
    { name: "session.archived", event: { type: "session.archived", data: { sessionID: "ses_1" } } },
    { name: "form.created", event: { type: "form.created", data: { form: { sessionID: "ses_1" } } } },
    { name: "permission.asked", event: { type: "permission.asked", data: { id: "p1", sessionID: "ses_1", action: "bash", resources: [] } } },
    { name: "session.status idle", event: { type: "session.status", data: { sessionID: "ses_1", status: { type: "idle" } } } },
  ]

  for (const testCase of cases) {
    const harness = await setup()
    try {
      await harness.context("ses_1")
      await harness.context("ses_2")

      let thirdDone = false
      const third = harness.context("ses_3").then(() => {
        thirdDone = true
      })
      await wait(80)
      assert.equal(thirdDone, false, `${testCase.name}: still blocked before the event`)

      harness.bus.emit(testCase.event)
      await third
      assert.equal(thirdDone, true, `${testCase.name} frees the slot`)
    } finally {
      await harness.teardown()
    }
  }
})

test("a queued session whose run ends stops waiting: no re-mark, no phantom lease", async () => {
  const harness = await setup(
    { remindEveryMs: 30, titleMarks: "waiting" },
    { titles: { ses_1: "one", ses_2: "two", ses_3: "three" } },
  )
  try {
    await harness.context("ses_1")
    await harness.context("ses_2")

    let thirdDone = false
    const third = harness.context("ses_3").then(() => {
      thirdDone = true
    })

    await until(() => harness.titles.get("ses_3")?.startsWith("⏳") === true, "waiting mark")
    assert.equal(thirdDone, false, "the third session is queued")

    // The user stops that turn while it is still queued. Nothing will ever run
    // for it, so its place in the queue must be given up.
    harness.bus.emit({ type: "session.execution.interrupted", data: { sessionID: "ses_3", reason: "user" } })
    await third

    // A waiting loop that outlived its run re-marks the title on every reminder.
    await wait(200)
    assert.equal(harness.titles.get("ses_3"), "three", "the finished turn keeps its own title")
    assert.equal(
      readdirSync(harness.dir).filter((name) => name === "ses_3.wait.json").length,
      0,
      "no wait sidecar is left behind",
    )

    // ...and it would take the first slot that frees, for a turn that never runs.
    harness.bus.emit({ type: "session.idle", data: { sessionID: "ses_1" } })
    await wait(200)
    const held = fileStore(harness.dir)
      .list()
      .map((lease: { sid: string }) => lease.sid)
      .sort()
    assert.deepEqual(held, ["ses_2"], "a finished turn never takes a slot")
  } finally {
    await harness.teardown()
  }
})

test("a busy/retry status update does not free the slot", async () => {
  const harness = await setup()
  try {
    await harness.context("ses_1")
    await harness.context("ses_2")
    let thirdDone = false
    const third = harness.context("ses_3").then(() => {
      thirdDone = true
    })

    harness.bus.emit({ type: "session.status", data: { sessionID: "ses_1", status: { type: "busy" } } })
    harness.bus.emit({ type: "session.status", data: { sessionID: "ses_1", status: { type: "retry", attempt: 1 } } })
    await wait(150)
    assert.equal(thirdDone, false, "busy is not a release")

    harness.bus.emit({ type: "session.idle", data: { sessionID: "ses_1" } })
    await third
  } finally {
    await harness.teardown()
  }
})

test("timeout fails open: the third session proceeds over the limit", async () => {
  const harness = await setup({ acquireTimeoutMs: 120 })
  try {
    await harness.context("ses_1")
    await harness.context("ses_2")

    const started = Date.now()
    await harness.context("ses_3")
    assert.ok(Date.now() - started >= 100, "waited for the configured timeout")
    assert.equal(fileStore(harness.dir).list().length, 3, "over-limit lease was taken")
  } finally {
    await harness.teardown()
  }
})

test("onTimeout=hold never fails open", async () => {
  const harness = await setup({ acquireTimeoutMs: 80, onTimeout: "hold" })
  try {
    await harness.context("ses_1")
    await harness.context("ses_2")

    let thirdDone = false
    const third = harness.context("ses_3").then(() => {
      thirdDone = true
    })
    await wait(250)
    assert.equal(thirdDone, false, "still waiting after the timeout")

    harness.bus.emit({ type: "session.idle", data: { sessionID: "ses_2" } })
    await third
  } finally {
    await harness.teardown()
  }
})

test("boot cleans leases left by a dead server and keeps live ones", async () => {
  const dir = mkdtempSync(join(tmpdir(), "turn-lock-boot-"))
  try {
    const store = fileStore(dir)
    store.write({ sid: "ses_dead", since: Date.now(), seen: Date.now(), pid: 999_999 })
    store.write({ sid: "ses_live", since: Date.now(), seen: Date.now(), pid: process.pid })

    const harness = await setup({ dir, logFile: join(dir, "log.txt") })
    try {
      const remaining = fileStore(dir).list().map((lease: { sid: string }) => lease.sid)
      assert.deepEqual(remaining, ["ses_live"], "dead server leases are dropped")
    } finally {
      await harness.teardown()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("unload releases everything this process held", async () => {
  const harness = await setup()
  await harness.context("ses_1")
  await harness.context("ses_2")
  assert.equal(fileStore(harness.dir).list().length, 2)

  await harness.cleanup()
  assert.equal(fileStore(harness.dir).list().length, 0)
  rmSync(harness.dir, { recursive: true, force: true })
})

test("unload ends a queued wait instead of leaving it polling", async () => {
  const harness = await setup(
    { remindEveryMs: 30, titleMarks: "waiting" },
    { titles: { ses_1: "one", ses_2: "two", ses_3: "three" } },
  )
  try {
    await harness.context("ses_1")
    await harness.context("ses_2")
    let thirdDone = false
    const third = harness.context("ses_3").then(() => {
      thirdDone = true
    })
    await until(() => harness.titles.get("ses_3")?.startsWith("⏳") === true, "waiting mark")

    await harness.cleanup()
    await third
    const updates = harness.updates.length

    // An orphaned loop would keep polling the shared store and re-mark the title.
    await wait(150)
    assert.equal(thirdDone, true, "the pending hook is let go")
    assert.equal(harness.updates.length, updates, "nothing re-marks the title after unload")
    assert.equal(fileStore(harness.dir).list().length, 0, "no lease is left behind")
  } finally {
    await harness.teardown()
  }
})

test("disabled config registers no hook and never blocks", async () => {
  const harness = await setup({ enabled: false })
  try {
    assert.equal(harness.hooks.length, 0)
    assert.deepEqual(fileStore(harness.dir).list(), [])
  } finally {
    await harness.teardown()
  }
})

test("releaseOnForm/releaseOnPermission can be turned off", async () => {
  const harness = await setup({ releaseOnForm: false, releaseOnPermission: false })
  try {
    await harness.context("ses_1")
    await harness.context("ses_2")

    let thirdDone = false
    const third = harness.context("ses_3").then(() => {
      thirdDone = true
    })
    harness.bus.emit({ type: "form.created", data: { form: { sessionID: "ses_1" } } })
    harness.bus.emit({ type: "permission.asked", data: { id: "p", sessionID: "ses_1" } })
    await wait(150)
    assert.equal(thirdDone, false, "form/permission releases are disabled")

    harness.bus.emit({ type: "session.idle", data: { sessionID: "ses_1" } })
    await third
  } finally {
    await harness.teardown()
  }
})

test("a queued session is marked in the session list and unmarked on grant", async () => {
  const harness = await setup({ titleMarks: "waiting" }, { titles: { ses_1: "one", ses_2: "two", ses_3: "three" } })
  try {
    await harness.context("ses_1")
    await harness.context("ses_2")

    let thirdDone = false
    const third = harness.context("ses_3").then(() => {
      thirdDone = true
    })
    await until(() => harness.titles.get("ses_3") === "⏳ three", "waiting mark")

    assert.equal(thirdDone, false, "still queued")
    assert.equal(harness.titles.get("ses_1"), "one", "running sessions keep their title")
    assert.equal(harness.titles.get("ses_2"), "two")

    harness.bus.emit({ type: "session.idle", data: { sessionID: "ses_1" } })
    await third
    await until(() => harness.titles.get("ses_3") === "three", "title restored")
  } finally {
    await harness.teardown()
  }
})

test("only one mark is written while a session keeps waiting", async () => {
  const harness = await setup({ remindEveryMs: 60, titleMarks: "waiting" }, { titles: { ses_3: "three" } })
  try {
    await harness.context("ses_1")
    await harness.context("ses_2")
    const third = harness.context("ses_3")
    await wait(400)

    assert.equal(
      harness.updates.filter((update) => update.sessionID === "ses_3" && update.title === "⏳ three").length,
      1,
      "reminders refresh the wait, not the title",
    )

    harness.bus.emit({ type: "session.idle", data: { sessionID: "ses_1" } })
    await third
  } finally {
    await harness.teardown()
  }
})

test("two waiters see their place in the queue", async () => {
  const harness = await setup(
    { remindEveryMs: 40, titleMarks: "waiting" },
    { titles: { ses_3: "three", ses_4: "four" } },
  )
  try {
    await harness.context("ses_1")
    await harness.context("ses_2")
    let thirdDone = false
    let fourthDone = false
    const third = harness.context("ses_3").then(() => {
      thirdDone = true
    })
    await until(() => harness.titles.get("ses_3") === "⏳ three", "first waiter marked")
    const fourth = harness.context("ses_4").then(() => {
      fourthDone = true
    })

    await until(() => harness.titles.get("ses_3") === "⏳ 1/2 · three", "first in queue")
    await until(() => harness.titles.get("ses_4") === "⏳ 2/2 · four", "second in queue")

    harness.bus.emit({ type: "session.idle", data: { sessionID: "ses_1" } })
    await until(() => thirdDone, "the older waiter got the slot")
    assert.equal(fourthDone, false, "the younger waiter is still queued")

    // The place is now enforced, so the older waiter is the one served and the
    // younger one drops its "N/M" and stays at the head of the remaining queue.
    await until(() => harness.titles.get("ses_4") === "⏳ four", "queue shrank after a grant")

    harness.bus.emit({ type: "session.idle", data: { sessionID: "ses_2" } })
    await Promise.all([third, fourth])
    assert.equal(fourthDone, true)
  } finally {
    await harness.teardown()
  }
})

test("a head that stopped polling does not hold the slot past the grace", async () => {
  const harness = await setup({ limit: 1, remindEveryMs: 0, fifoGraceMs: 40 }, { titles: { ses_1: "one", ses_2: "two" } })
  try {
    await harness.context("ses_1")
    let secondDone = false
    const second = harness.context("ses_2").then(() => {
      secondDone = true
    })
    await until(() => readState(harness.metadata.get("ses_2"))?.position === 1, "the waiter is marked")

    // Alive (its pid is this process) but never polls: it owns place 1 and will
    // never take the slot. After one grace window the slot must go to place 2.
    writeFileSync(
      join(harness.dir, "ses_ghost.wait.json"),
      JSON.stringify({ sid: "ses_ghost", pid: process.pid, owner: "C:/work", since: Date.now() - 60_000, markedAt: Date.now() }),
      "utf8",
    )

    harness.bus.emit({ type: "session.idle", data: { sessionID: "ses_1" } })
    await until(() => secondDone, "the next place took the slot after the grace")
  } finally {
    await harness.teardown()
  }
})

test("a title regenerated while waiting is marked again", async () => {
  const harness = await setup({ remindEveryMs: 60, titleMarks: "waiting" }, { titles: { ses_3: "three" } })
  try {
    await harness.context("ses_1")
    await harness.context("ses_2")
    const third = harness.context("ses_3")
    await until(() => harness.titles.get("ses_3") === "⏳ three", "first mark")

    // The server generates a session title after the first message and replaces
    // the one we just marked; the next reminder tick must restore the prefix.
    harness.titles.set("ses_3", "generated title")
    await until(() => harness.titles.get("ses_3") === "⏳ generated title", "re-mark")

    harness.bus.emit({ type: "session.idle", data: { sessionID: "ses_1" } })
    await third
    await until(() => harness.titles.get("ses_3") === "generated title", "restored after grant")
  } finally {
    await harness.teardown()
  }
})

test("markWaitingTitle=false leaves titles alone", async () => {
  const harness = await setup({ markWaitingTitle: false }, { titles: { ses_3: "three" } })
  try {
    await harness.context("ses_1")
    await harness.context("ses_2")
    const third = harness.context("ses_3")
    await wait(150)
    assert.equal(harness.titles.get("ses_3"), "three")
    assert.equal(harness.updates.length, 0)

    harness.bus.emit({ type: "session.idle", data: { sessionID: "ses_1" } })
    await third
  } finally {
    await harness.teardown()
  }
})

test("a failing title update never breaks the gate", async () => {
  const harness = await setup({}, { failUpdate: true })
  try {
    await harness.context("ses_1")
    await harness.context("ses_2")
    let thirdDone = false
    const third = harness.context("ses_3").then(() => {
      thirdDone = true
    })
    await wait(120)
    assert.equal(thirdDone, false)

    harness.bus.emit({ type: "session.idle", data: { sessionID: "ses_1" } })
    await third
    assert.equal(thirdDone, true, "the queue does not depend on the title")
  } finally {
    await harness.teardown()
  }
})

test("boot restores a mark left by a dead process", async () => {
  const dir = mkdtempSync(join(tmpdir(), "turn-lock-mark-"))
  try {
    writeFileSync(
      join(dir, "ses_ghost.wait.json"),
      JSON.stringify({ sid: "ses_ghost", pid: 999_999, owner: "C:/work", markedAt: Date.now() }),
      "utf8",
    )
    const harness = await setup({ dir, logFile: join(dir, "log.txt") }, { titles: { ses_ghost: "⏳ 12 мин · old title" } })
    try {
      assert.equal(harness.titles.get("ses_ghost"), "old title", "the marker is removed on boot")
    } finally {
      await harness.teardown()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a wait mark left by a session that is gone never takes the first place", async () => {
  const harness = await setup({ remindEveryMs: 60 }, { titles: { ses_1: "one", ses_2: "two", ses_3: "three" } })
  try {
    // A session deleted while it was queued leaves its sidecar behind: the
    // terminal event cannot restore a title for a session that no longer
    // exists. Nothing but the mark's age says the wait is over — and the
    // reminder tick refreshes that age on every pass, so an hour-old mark is a
    // phantom, not a waiter. It must not hold place 1 forever.
    writeFileSync(
      join(harness.dir, "ses_gone.wait.json"),
      JSON.stringify({
        sid: "ses_gone",
        pid: process.pid,
        owner: "C:/work",
        since: Date.now() - 3_600_000,
        markedAt: Date.now() - 3_600_000,
      }),
      "utf8",
    )

    await harness.context("ses_1")
    await harness.context("ses_2")
    const third = harness.context("ses_3")
    await until(() => readState(harness.metadata.get("ses_3"))?.position === 1, "the first free place")
    assert.equal(readState(harness.metadata.get("ses_3"))?.total, 1, "the phantom is not counted")
    assert.equal(readdirSync(harness.dir).includes("ses_gone.wait.json"), false, "the phantom is pruned")

    harness.bus.emit({ type: "session.idle", data: { sessionID: "ses_1" } })
    await third
  } finally {
    await harness.teardown()
  }
})

test("deleting a queued session drops its sidecar instead of leaving a phantom", async () => {
  const missing = new Set<string>()
  const harness = await setup(
    { remindEveryMs: 60 },
    { titles: { ses_1: "one", ses_2: "two", ses_3: "three" }, missing },
  )
  try {
    await harness.context("ses_1")
    await harness.context("ses_2")
    const third = harness.context("ses_3")
    await until(() => readState(harness.metadata.get("ses_3"))?.since !== undefined, "the wait is recorded")

    // The user deletes the queued session. There is no title left to restore,
    // so the sidecar must go right away rather than wait for the age check.
    missing.add("ses_3")
    harness.bus.emit({ type: "session.deleted", data: { sessionID: "ses_3" } })
    await third
    await until(
      () => readdirSync(harness.dir).includes("ses_3.wait.json") === false,
      "the sidecar of a deleted session is dropped",
    )
  } finally {
    await harness.teardown()
  }
})

test("serving the head republishes the place of everyone behind it", async () => {
  const harness = await setup(
    { limit: 1, remindEveryMs: 0 },
    { titles: { ses_1: "one", ses_2: "two", ses_3: "three" } },
  )
  try {
    await harness.context("ses_1")
    const second = harness.context("ses_2")
    const third = harness.context("ses_3")
    await until(() => readState(harness.metadata.get("ses_3"))?.position === 2, "the third waits in place 2")
    assert.equal(readState(harness.metadata.get("ses_3"))?.total, 2)

    // The head is served. The badge of the new head has to say `1/1` right
    // away, not after its own reminder tick — this test has no ticks at all.
    harness.bus.emit({ type: "session.idle", data: { sessionID: "ses_1" } })
    await second
    await until(() => readState(harness.metadata.get("ses_3"))?.position === 1, "the place shrinks at once")
    assert.equal(readState(harness.metadata.get("ses_3"))?.total, 1)

    harness.bus.emit({ type: "session.idle", data: { sessionID: "ses_2" } })
    await third
  } finally {
    await harness.teardown()
  }
})

test("a place-only write keeps what another instance wrote in between", async () => {
  const harness = await setup(
    { limit: 1, remindEveryMs: 0 },
    { titles: { ses_1: "one", ses_2: "two", ses_3: "three" } },
  )
  try {
    await harness.context("ses_1")
    const second = harness.context("ses_2")
    await until(() => readState(harness.metadata.get("ses_2"))?.position === 1, "the first waiter")

    // Another plugin instance (one per location, same state directory) records
    // the cloud flag. Republishing the place from here must not wipe it.
    const stored = harness.metadata.get("ses_2") ?? {}
    harness.metadata.set("ses_2", {
      ...stored,
      "turn-lock": { ...(stored["turn-lock"] as Record<string, unknown>), cloud: true },
    })

    const third = harness.context("ses_3")
    await until(() => readState(harness.metadata.get("ses_2"))?.total === 2, "the first waiter sees the longer queue")
    assert.equal(readState(harness.metadata.get("ses_2"))?.cloud, true, "the external flag survives")

    harness.bus.emit({ type: "session.idle", data: { sessionID: "ses_1" } })
    await second
    harness.bus.emit({ type: "session.idle", data: { sessionID: "ses_2" } })
    await third
  } finally {
    await harness.teardown()
  }
})

test("a new waiter updates the total of the ones ahead of it", async () => {
  const harness = await setup(
    { limit: 1, remindEveryMs: 0 },
    { titles: { ses_1: "one", ses_2: "two", ses_3: "three" } },
  )
  try {
    await harness.context("ses_1")
    const second = harness.context("ses_2")
    await until(() => readState(harness.metadata.get("ses_2"))?.position === 1, "the first waiter")
    assert.equal(readState(harness.metadata.get("ses_2"))?.total, 1)

    const third = harness.context("ses_3")
    await until(() => readState(harness.metadata.get("ses_3"))?.position === 2, "the second waiter")
    await until(() => readState(harness.metadata.get("ses_2"))?.total === 2, "the first waiter sees the longer queue")

    harness.bus.emit({ type: "session.idle", data: { sessionID: "ses_1" } })
    await second
    harness.bus.emit({ type: "session.idle", data: { sessionID: "ses_2" } })
    await third
  } finally {
    await harness.teardown()
  }
})

test("a waiting subagent takes no visible place in the queue", async () => {
  // The session list draws root sessions only: a child's row is nested under
  // its parent. Counting children as separate places made a badge say `1/3`
  // over two visible rows — the counter promised rows the list cannot show.
  const harness = await setup(
    { limit: 1, remindEveryMs: 0, lockScope: "request" },
    {
      parents: { ses_child: "ses_parent" },
      titles: { ses_1: "one", ses_parent: "parent", ses_child: "child" },
      created: { ses_1: 1, ses_parent: 2, ses_child: 3 },
    },
  )
  try {
    await harness.context("ses_1") // holds the only slot
    const parent = harness.context("ses_parent")
    await until(() => readState(harness.metadata.get("ses_parent"))?.position === 1, "the parent waits")
    assert.equal(readState(harness.metadata.get("ses_parent"))?.total, 1)

    const child = harness.context("ses_child")
    await until(() => readState(harness.metadata.get("ses_child"))?.since !== undefined, "the child waits")

    const mark = JSON.parse(readFileSync(join(harness.dir, "ses_child.wait.json"), "utf8"))
    assert.equal(mark.child, true, "the sidecar records the ancestry for other instances")
    assert.equal(readState(harness.metadata.get("ses_child"))?.position, undefined, "a child has no visible place")
    assert.equal(readState(harness.metadata.get("ses_child"))?.total, undefined)
    assert.equal(readState(harness.metadata.get("ses_parent"))?.total, 1, "the parent's total ignores the child")

    harness.bus.emit({ type: "session.idle", data: { sessionID: "ses_1" } })
    await parent
    harness.bus.emit({ type: "session.idle", data: { sessionID: "ses_parent" } })
    await child
  } finally {
    await harness.teardown()
  }
})

test("a priority switch republishes the places of the whole queue", async () => {
  const harness = await setup(
    { limit: 1, remindEveryMs: 0 },
    { titles: { ses_1: "one", ses_2: "two", ses_3: "three" } },
  )
  try {
    await harness.context("ses_1")
    const second = harness.context("ses_2")
    const third = harness.context("ses_3")
    await until(() => readState(harness.metadata.get("ses_2"))?.position === 1, "the ordinary waiter is first")
    assert.equal(readState(harness.metadata.get("ses_3"))?.position, 2)

    await harness.command("ses_3", "prio", "high")
    await until(() => readState(harness.metadata.get("ses_3"))?.position === 1, "the priority waiter cuts in")
    await until(() => readState(harness.metadata.get("ses_2"))?.position === 2, "the ordinary waiter moves back")

    harness.bus.emit({ type: "session.idle", data: { sessionID: "ses_1" } })
    await third
    harness.bus.emit({ type: "session.idle", data: { sessionID: "ses_3" } })
    await second
  } finally {
    await harness.teardown()
  }
})

test("boot clears a place left in metadata by a waiter that is gone", async () => {
  const harness = await setup(
    {},
    {
      titles: { ses_ghost: "ghost" },
      metadata: {
        ses_ghost: { "turn-lock": { level: "normal", position: 3, total: 3, since: Date.now() - 60_000 } },
      },
    },
  )
  try {
    await until(
      () => readState(harness.metadata.get("ses_ghost"))?.position === undefined,
      "the orphan place is cleared on boot",
    )
    assert.equal(readState(harness.metadata.get("ses_ghost"))?.since, undefined, "the wait start goes with it")
    assert.equal(readState(harness.metadata.get("ses_ghost"))?.level, "normal", "the level is kept")
  } finally {
    await harness.teardown()
  }
})

test("boot clears a hold left in metadata by a session that no longer holds", async () => {
  const harness = await setup(
    {},
    {
      titles: { ses_stale: "stale" },
      metadata: {
        ses_stale: { "turn-lock": { level: "high", holding: Date.now() - 600_000 } },
      },
    },
  )
  try {
    await until(
      () => readState(harness.metadata.get("ses_stale"))?.holding === undefined,
      "a hold with no lease behind it is cleared on boot",
    )
    assert.equal(readState(harness.metadata.get("ses_stale"))?.level, "high", "the level is kept")
  } finally {
    await harness.teardown()
  }
})

test("turn-lock notices from an older version never reach the model", async () => {
  const harness = await setup({ limit: 1 })
  try {
    const messages = [
      { type: "user", text: "do the thing" },
      { type: "assistant", text: "ok" },
      { type: "synthetic", metadata: { plugin: "turn-lock", kind: "wait" }, text: "⏳ turn-lock: в очереди" },
      { type: "synthetic", text: "⏳ turn-lock: всё ещё в очереди (5 мин)" },
      { type: "synthetic", text: "<shell>output</shell>" },
    ]
    await harness.context("ses_1", "strata", messages)
    assert.deepEqual(
      messages.map((message) => (message as { type: string }).type),
      ["user", "assistant", "synthetic"],
      "only unrelated synthetic entries survive",
    )
  } finally {
    await harness.teardown()
  }
})

test("subagents of an ungated (cloud) session are never gated", async () => {
  const harness = await setup({}, { parents: { ses_child: "ses_cloud" } })
  try {
    await harness.context("ses_local_1")
    await harness.context("ses_local_2")

    const started = Date.now()
    await harness.context("ses_child", "strata") // child runs the local model
    assert.ok(Date.now() - started < 500, "parent run is not gated, so the child is not either")

    assert.equal(
      fileStore(harness.dir).list().length,
      2,
      "the child takes no slot of its own",
    )
  } finally {
    await harness.teardown()
  }
})

test("subagents of a gated session are covered by the parent slot (no deadlock, no extra slot)", async () => {
  const harness = await setup({ limit: 1 }, { parents: { ses_child: "ses_parent", ses_grandchild: "ses_child" } })
  try {
    await harness.context("ses_parent")
    assert.equal(fileStore(harness.dir).list().length, 1)

    const started = Date.now()
    await harness.context("ses_child")
    await harness.context("ses_grandchild")
    assert.ok(Date.now() - started < 500, "children never wait behind their own parent")

    assert.deepEqual(
      fileStore(harness.dir).list().map((lease: { sid: string }) => lease.sid),
      ["ses_parent"],
      "only the root session holds a slot",
    )
  } finally {
    await harness.teardown()
  }
})

test("a covered subagent cannot starve an unrelated third session", async () => {
  const harness = await setup({ limit: 2 }, { parents: { ses_child: "ses_parent" } })
  try {
    await harness.context("ses_parent")
    await harness.context("ses_other")
    await harness.context("ses_child") // covered, immediate

    let thirdDone = false
    const third = harness.context("ses_third").then(() => {
      thirdDone = true
    })
    await wait(150)
    assert.equal(thirdDone, false, "the subagent did not consume the second slot")

    harness.bus.emit({ type: "session.idle", data: { sessionID: "ses_other" } })
    await third
  } finally {
    await harness.teardown()
  }
})

test("priority mark composes with the waiting prefix", () => {
  assert.equal(mod.withPriorityMark("do it"), "⚡ do it")
  assert.equal(mod.withPriorityMark("⚡ do it"), "⚡ do it")
  assert.equal(mod.withoutPriorityMark("⚡ ⏳ 3m · do it"), "⏳ 3m · do it")
  assert.equal(mod.withoutPriorityMark("do it"), "do it")
  assert.equal(mod.hasPriorityMark("⚡ ⏳ do it"), true)
  assert.equal(mod.hasPriorityMark("⏳ do it"), false)

  assert.equal(mod.withWaitPrefix("⚡ do it", 3 * 60_000, { position: 1, total: 2 }), "⚡ ⏳ 1/2 · 3m · do it")
  assert.equal(mod.withWaitPrefix("do it", 3 * 60_000, { position: 2, total: 2 }, false), "⏳ 2/2 · 3m · do it")
  assert.equal(mod.withWaitPrefix("⚡ ⏳ 4m · do it", 5 * 60_000, undefined, false), "⏳ 5m · do it")
  assert.equal(mod.withWaitPrefix("⚡ ⏳ 4m · do it", 5 * 60_000), "⚡ ⏳ 5m · do it")

  assert.equal(mod.stripWaitPrefix("⚡ ⏳ 2/3 · 1h5m · do it"), "⚡ do it")
  assert.equal(mod.stripWaitPrefix("⚡ do it"), "⚡ do it")
  assert.equal(mod.stripWaitPrefix("⏳ 2/3 · 3m · do it"), "do it")
})

test("/prio marks the session and writes the flag; a second call clears both", async () => {
  const harness = await setup({ titleMarks: "all" }, { titles: { ses_1: "one" } })
  try {
    await harness.context("ses_1")
    assert.equal(harness.titles.get("ses_1"), "one", "an ordinary session keeps its title")

    await harness.command("ses_1", "prio")
    assert.equal(harness.titles.get("ses_1"), "⚡ one")
    assert.deepEqual(harness.prioFiles(), ["ses_1"])

    await harness.command("ses_1", "prio") // no argument toggles
    assert.equal(harness.titles.get("ses_1"), "one")
    assert.deepEqual(harness.prioFiles(), [])

    await harness.command("ses_1", "prio", "on")
    assert.equal(harness.titles.get("ses_1"), "⚡ one")
    await harness.command("ses_1", "prio", "off")
    assert.equal(harness.titles.get("ses_1"), "one")
    assert.deepEqual(harness.prioFiles(), [])
  } finally {
    await harness.teardown()
  }
})

test("a priority waiter takes the next free slot ahead of an older ordinary waiter", async () => {
  const harness = await setup({ titleMarks: "all" }, { titles: { ses_3: "three", ses_4: "four" } })
  try {
    await harness.context("ses_1")
    await harness.context("ses_2")

    let thirdDone = false
    let fourthDone = false
    const third = harness.context("ses_3").then(() => {
      thirdDone = true
    })
    await until(() => harness.titles.get("ses_3") === "⏳ three", "older waiter marked")
    const fourth = harness.context("ses_4").then(() => {
      fourthDone = true
    })
    await until(() => harness.titles.get("ses_4") === "⏳ 2/2 · four", "newer waiter marked")

    await harness.command("ses_4", "prio", "on")
    assert.equal(harness.titles.get("ses_4"), "⚡ ⏳ 1/2 · four", "the priority session is first in the queue")

    harness.bus.emit({ type: "session.idle", data: { sessionID: "ses_1" } })
    await until(() => fourthDone, "the priority session got the freed slot")
    await wait(150)
    assert.equal(thirdDone, false, "an ordinary waiter holds back while a priority session queues")

    harness.bus.emit({ type: "session.idle", data: { sessionID: "ses_2" } })
    await Promise.all([third, fourth])
  } finally {
    await harness.teardown()
  }
})

test("an active session yields its slot at the next step, without breaking the running one", async () => {
  const harness = await setup({ titleMarks: "all" }, { titles: { ses_1: "one", ses_3: "three" } })
  try {
    await harness.context("ses_1") // one step done, the slot is held
    await harness.context("ses_2")

    let thirdDone = false
    const third = harness.context("ses_3").then(() => {
      thirdDone = true
    })
    await until(() => harness.titles.get("ses_3") === "⏳ three", "waiter marked")

    await harness.command("ses_3", "prio", "on")
    assert.equal(thirdDone, false, "priority does not interrupt the session that is already running")

    // ses_1's next step boundary: it gives the slot up and queues again.
    let firstDone = false
    const first = harness.context("ses_1").then(() => {
      firstDone = true
    })
    await until(() => thirdDone, "the priority session starts after one step")
    await wait(150)
    assert.equal(firstDone, false, "the preempted session waits for a slot again")
    assert.match(harness.logText(), /yield ses_1: ses_3 outranks it/)

    // It resumes on its own: the other holder ends its turn, nothing priority waits.
    harness.bus.emit({ type: "session.idle", data: { sessionID: "ses_2" } })
    await first
    assert.equal(harness.titles.get("ses_1"), "one", "the queue mark comes off when the slot is back")
    await third
  } finally {
    await harness.teardown()
  }
})

test("priority off leaves nobody holding a slot back", async () => {
  const harness = await setup({ titleMarks: "all" }, { titles: { ses_3: "three" } })
  try {
    await harness.context("ses_1")
    await harness.context("ses_2")
    let thirdDone = false
    const third = harness.context("ses_3").then(() => {
      thirdDone = true
    })
    await until(() => harness.titles.get("ses_3") === "⏳ three", "waiter marked")

    await harness.command("ses_3", "prio", "on")
    await harness.command("ses_3", "prio", "off")
    assert.equal(harness.titles.get("ses_3"), "⏳ three", "the ⚡ mark is gone")
    assert.deepEqual(harness.prioFiles(), [])

    harness.bus.emit({ type: "session.idle", data: { sessionID: "ses_1" } })
    await third
    assert.match(harness.titles.get("ses_3") ?? "", /^three$/)
  } finally {
    await harness.teardown()
  }
})

test("the command argument survives both shapes a client may send", () => {
  assert.equal(mod.parsePriorityArgument("", "prio"), "toggle")
  assert.equal(mod.parsePriorityArgument("  ", "prio"), "toggle")
  assert.equal(mod.parsePriorityArgument("on", "prio"), "high")
  assert.equal(mod.parsePriorityArgument("OFF", "prio"), "normal")
  assert.equal(mod.parsePriorityArgument("remove", "prio"), "normal")
  assert.equal(mod.parsePriorityArgument("normal", "prio"), "normal")
  assert.equal(mod.parsePriorityArgument("low", "prio"), "low")
  assert.equal(mod.parsePriorityArgument("DOWN", "prio"), "low")
  assert.equal(mod.parsePriorityArgument("high", "prio"), "high")
  assert.equal(mod.parsePriorityArgument("anything else", "prio"), "toggle")
  // a client that hands over the whole line instead of only the arguments
  assert.equal(mod.parsePriorityArgument("/prio", "prio"), "toggle")
  assert.equal(mod.parsePriorityArgument("prio", "prio"), "toggle")
  assert.equal(mod.parsePriorityArgument("/prio off", "prio"), "normal")
  assert.equal(mod.parsePriorityArgument("  /PRIO low ", "prio"), "low")
  assert.equal(mod.parsePriorityArgument("/prio HIGH", "prio"), "high")
})

test("/prio with the command name still in the text turns priority off", async () => {
  const harness = await setup({ titleMarks: "all" }, { titles: { ses_1: "one" } })
  try {
    await harness.context("ses_1")
    await harness.command("ses_1", "prio", "on")
    assert.equal(harness.titles.get("ses_1"), "⚡ one")
    await harness.command("ses_1", "prio", "/prio off")
    assert.equal(harness.titles.get("ses_1"), "one", "the whole line is parsed, not treated as a toggle")
    assert.deepEqual(harness.prioFiles(), [])
  } finally {
    await harness.teardown()
  }
})

test("the low mark composes with the waiting prefix", () => {
  assert.equal(mod.withLowMark("do it"), "▽ do it")
  assert.equal(mod.withLowMark("▽ do it"), "▽ do it")
  assert.equal(mod.withLowMark("⚡ do it"), "▽ do it", "a session is at one level at a time")
  assert.equal(mod.withPriorityMark("▽ do it"), "⚡ do it")
  assert.equal(mod.withoutLowMark("▽ ⏳ 3m · do it"), "⏳ 3m · do it")
  assert.equal(mod.hasLowMark("▽ ⏳ do it"), true)
  assert.equal(mod.hasLowMark("⚡ do it"), false)
  assert.deepEqual(["⚡ do it", "▽ do it", "do it"].map(mod.levelOfTitle), ["high", "low", "normal"])
  assert.equal(mod.withLevelMark("▽ do it", "normal"), "do it")

  assert.equal(mod.withWaitPrefix("▽ do it", 3 * 60_000, { position: 3, total: 3 }), "▽ ⏳ 3/3 · 3m · do it")
  assert.equal(mod.withWaitPrefix("⚡ ⏳ 4m · do it", 5 * 60_000, undefined, "low"), "▽ ⏳ 5m · do it")
  assert.equal(mod.withWaitPrefix("▽ ⏳ 4m · do it", 5 * 60_000, undefined, "normal"), "⏳ 5m · do it")
  assert.equal(mod.stripWaitPrefix("▽ ⏳ 2/3 · 1h5m · do it"), "▽ do it")
  assert.deepEqual(mod.PRIORITY_RANK, { low: 0, normal: 1, high: 2 })
})

test("/prio low marks the session with ▽ and records the level", async () => {
  const harness = await setup({ titleMarks: "all" }, { titles: { ses_1: "one" } })
  try {
    await harness.context("ses_1")

    await harness.command("ses_1", "prio", "low")
    assert.equal(harness.titles.get("ses_1"), "▽ one")
    const flag = JSON.parse(readFileSync(join(harness.dir, "ses_1.prio.json"), "utf8"))
    assert.equal(flag.level, "low")

    // one level at a time: ⚡ replaces ▽, ordinary drops the flag again
    await harness.command("ses_1", "prio", "high")
    assert.equal(harness.titles.get("ses_1"), "⚡ one")
    await harness.command("ses_1", "prio", "normal")
    assert.equal(harness.titles.get("ses_1"), "one")
    assert.deepEqual(harness.prioFiles(), [])
  } finally {
    await harness.teardown()
  }
})

test("by default the level and the wait live in metadata, not in the title", async () => {
  const harness = await setup({ limit: 1 }, { titles: { ses_1: "one", ses_2: "two" } })
  try {
    await harness.context("ses_1") // the only slot is held
    await harness.command("ses_2", "prio", "high")
    assert.equal(harness.titles.get("ses_2"), "two", "no ⚡ in the title")
    await until(() => readState(harness.metadata.get("ses_2"))?.level === "high", "the level is stored")

    let done = false
    const waiting = harness.context("ses_2").then(() => {
      done = true
    })
    await until(() => readState(harness.metadata.get("ses_2"))?.since !== undefined, "the wait start is stored")
    const state = readState(harness.metadata.get("ses_2"))
    assert.equal(state?.level, "high", "the level survives the wait")
    assert.equal(state?.position, 1)
    assert.equal(state?.total, 1)
    assert.equal(harness.titles.get("ses_2"), "two", "the title is never touched: the badge draws the wait")

    harness.bus.emit({ type: "session.idle", data: { sessionID: "ses_1" } })
    await waiting
    await until(() => readState(harness.metadata.get("ses_2"))?.position === undefined, "the place is cleared on grant")
    assert.equal(harness.titles.get("ses_2"), "two")
    assert.equal(done, true)
  } finally {
    await harness.teardown()
  }
})

test("the holder of the slot is marked as active, with its own timer", async () => {
  const harness = await setup({ limit: 1, lockScope: "turn" }, { titles: { ses_1: "one", ses_2: "two" } })
  try {
    await harness.context("ses_1")
    await until(() => readState(harness.metadata.get("ses_1"))?.holding !== undefined, "the grant is stored")
    const held = readState(harness.metadata.get("ses_1"))
    assert.equal(held?.holding !== undefined, true, "the holder carries a start time")
    assert.equal(held?.position, undefined, "a holder has no place in the queue")

    // A turn keeps its lease across steps, so the timer must not restart on the
    // next request of the same turn.
    const started = held?.holding
    await harness.context("ses_1")
    assert.equal(readState(harness.metadata.get("ses_1"))?.holding, started, "the turn keeps one timer")

    harness.bus.emit({ type: "session.idle", data: { sessionID: "ses_1" } })
    await until(() => readState(harness.metadata.get("ses_1"))?.holding === undefined, "the release clears the timer")
  } finally {
    await harness.teardown()
  }
})

test("a waiter carries no hold timer, a released holder loses it", async () => {
  const harness = await setup({ limit: 1 }, { titles: { ses_1: "one", ses_2: "two" } })
  try {
    await harness.context("ses_1")
    await until(() => readState(harness.metadata.get("ses_1"))?.holding !== undefined, "ses_1 holds")

    const waiting = harness.context("ses_2")
    await until(() => readState(harness.metadata.get("ses_2"))?.since !== undefined, "ses_2 waits")
    assert.equal(readState(harness.metadata.get("ses_2"))?.holding, undefined, "a waiter is not a holder")

    harness.bus.emit({ type: "session.idle", data: { sessionID: "ses_1" } })
    await waiting
    await until(() => readState(harness.metadata.get("ses_1"))?.holding === undefined, "the old holder is cleared")
    await until(() => readState(harness.metadata.get("ses_2"))?.holding !== undefined, "the new holder is marked")
    assert.equal(readState(harness.metadata.get("ses_2"))?.since, undefined, "the place is gone once it holds")
  } finally {
    await harness.teardown()
  }
})

test("a cloud request is recorded in metadata and leaves the title alone", async () => {
  const harness = await setup({}, { titles: { ses_cloud: "cloud" } })
  try {
    await harness.context("ses_cloud", "polzaai")
    await until(() => readState(harness.metadata.get("ses_cloud"))?.cloud === true, "the cloud flag is stored")
    assert.equal(harness.titles.get("ses_cloud"), "cloud", "no ☁️ in the title by default")

    await harness.context("ses_cloud", "strata")
    await until(() => readState(harness.metadata.get("ses_cloud"))?.cloud === undefined, "switching back clears it")
    assert.equal(harness.titles.get("ses_cloud"), "cloud")
  } finally {
    await harness.teardown()
  }
})

test("a created cloud session is flagged before its first request", async () => {
  const harness = await setup({}, { titles: { ses_new: "new" } })
  try {
    harness.bus.emit({
      type: "session.created",
      data: { sessionID: "ses_new", model: { providerID: "polzaai", id: "deepseek" } },
    })
    await until(
      () => readState(harness.metadata.get("ses_new"))?.cloud === true,
      "the cloud flag is written at creation, not at the first request",
    )
    assert.equal(existsSync(join(harness.dir, "ses_new.lease.json")), false, "creation takes no slot")
    assert.equal(harness.titles.get("ses_new"), "new", "no ☁️ in the title by default")
  } finally {
    await harness.teardown()
  }
})

test("a created cloud session carries the ☁️ mark at once when titles are marked", async () => {
  const harness = await setup({ titleMarks: "all" }, { titles: { ses_new: "new" } })
  try {
    harness.bus.emit({
      type: "session.created",
      data: { sessionID: "ses_new", model: { providerID: "polzaai", id: "deepseek" } },
    })
    await until(() => harness.titles.get("ses_new") === "☁️ new", "the cloud mark is added at creation")
  } finally {
    await harness.teardown()
  }
})

test("a created local session is not written to at all", async () => {
  const harness = await setup({}, { titles: { ses_local: "local" } })
  try {
    harness.bus.emit({
      type: "session.created",
      data: { sessionID: "ses_local", model: { providerID: "strata", id: "qwen" } },
    })
    await wait(80)
    assert.equal(harness.metadata.get("ses_local"), undefined, "an ordinary local row needs no metadata")
    assert.equal(harness.updates.length, 0, "and no title write either")
  } finally {
    await harness.teardown()
  }
})

test("switching the model updates the cloud flag at once", async () => {
  const harness = await setup({}, { titles: { ses_switch: "switch" } })
  try {
    harness.bus.emit({
      type: "session.model.selected",
      data: { sessionID: "ses_switch", model: { providerID: "polzaai", id: "deepseek" } },
    })
    await until(() => readState(harness.metadata.get("ses_switch"))?.cloud === true, "a switch to cloud marks the session")

    harness.bus.emit({
      type: "session.model.selected",
      data: { sessionID: "ses_switch", model: { providerID: "strata", id: "qwen" } },
    })
    await until(
      () => readState(harness.metadata.get("ses_switch"))?.cloud === undefined,
      "a switch back to local clears the flag",
    )
  } finally {
    await harness.teardown()
  }
})

test("the queue is served by level: ⚡ first, then ordinary, then ▽", async () => {
  const harness = await setup({ limit: 1, titleMarks: "all" }, { titles: { ses_2: "two", ses_3: "three", ses_4: "four" } })
  try {
    await harness.context("ses_1") // the only slot is held

    let twoDone = false
    let threeDone = false
    let fourDone = false
    const two = harness.context("ses_2").then(() => {
      twoDone = true
    })
    await until(() => harness.titles.get("ses_2") === "⏳ two", "the ordinary waiter is marked")
    await harness.command("ses_3", "prio", "on")
    const three = harness.context("ses_3").then(() => {
      threeDone = true
    })
    await until(() => harness.titles.get("ses_3") === "⚡ ⏳ 1/2 · three", "the priority waiter is first")
    await harness.command("ses_4", "prio", "low")
    const four = harness.context("ses_4").then(() => {
      fourDone = true
    })
    await until(() => harness.titles.get("ses_4") === "▽ ⏳ 3/3 · four", "the low waiter is last in the queue")

    // The freed slot is not a race here: the ordinary waiter is held back by the
    // priority one and the low one by both, so ⚡ takes it.
    harness.bus.emit({ type: "session.idle", data: { sessionID: "ses_1" } })
    await until(() => threeDone, "the priority session got the freed slot")
    await wait(150)
    assert.equal(twoDone, false, "an ordinary waiter holds back while a priority one queues")
    assert.equal(fourDone, false, "the low waiter holds back behind both")

    // Next level: ordinary. The low one is still not served.
    harness.bus.emit({ type: "session.idle", data: { sessionID: "ses_3" } })
    await until(() => twoDone, "the ordinary session got the next slot")
    await wait(150)
    assert.equal(fourDone, false, "the low waiter holds back while an ordinary one queues")

    // Last level.
    harness.bus.emit({ type: "session.idle", data: { sessionID: "ses_2" } })
    await Promise.all([two, three, four])
    assert.equal(harness.titles.get("ses_4"), "▽ four", "the ▽ mark stays while the flag is on")
  } finally {
    await harness.teardown()
  }
})

test("a low session gives its slot up to an ordinary waiter", async () => {
  const harness = await setup({ titleMarks: "all" }, { titles: { ses_1: "one", ses_3: "three" } })
  try {
    await harness.command("ses_1", "prio", "low")
    assert.equal(harness.titles.get("ses_1"), "▽ one", "the flag marks the session before it runs")
    await harness.context("ses_1") // one step done, the slot is held
    await harness.context("ses_2")

    let thirdDone = false
    const third = harness.context("ses_3").then(() => {
      thirdDone = true
    })
    await until(() => harness.titles.get("ses_3") === "⏳ three", "the ordinary waiter is marked")

    // ses_1's next step boundary: an ordinary waiter outranks ▽, so it gives up.
    let firstDone = false
    const first = harness.context("ses_1").then(() => {
      firstDone = true
    })
    await until(() => thirdDone, "the ordinary session took the yielded slot")
    await wait(150)
    assert.equal(firstDone, false, "the preempted session waits for a slot again")
    assert.match(harness.logText(), /yield ses_1: ses_3 outranks it/)
    // Whether the place label is already there depends on when ses_3's grant
    // dropped its wait sidecar, so only the mark and the countdown are asserted.
    assert.match(
      harness.titles.get("ses_1") ?? "",
      /^▽ ⏳ (?:\d+\/\d+ · )?one$/,
      "it re-queues at the back, still ▽",
    )

    harness.bus.emit({ type: "session.idle", data: { sessionID: "ses_2" } })
    harness.bus.emit({ type: "session.idle", data: { sessionID: "ses_3" } })
    await first
    assert.equal(harness.titles.get("ses_1"), "▽ one", "the queue mark comes off when the slot is back")
  } finally {
    await harness.teardown()
  }
})

test("a flag file written before levels existed still means ⚡", async () => {
  const harness = await setup({ limit: 1, titleMarks: "all" }, { titles: { ses_2: "two", ses_3: "three" } })
  try {
    await harness.context("ses_1")
    // the shape 0.1 wrote: no `level` field at all
    writeFileSync(join(harness.dir, "ses_3.prio.json"), JSON.stringify({ sid: "ses_3", pid: process.pid, since: Date.now() }))

    let twoDone = false
    let threeDone = false
    const two = harness.context("ses_2").then(() => {
      twoDone = true
    })
    await until(() => harness.titles.get("ses_2") === "⏳ two", "the ordinary waiter is marked")
    const three = harness.context("ses_3").then(() => {
      threeDone = true
    })
    await until(() => harness.titles.get("ses_3") === "⚡ ⏳ 1/2 · three", "the legacy flag is read as priority")

    harness.bus.emit({ type: "session.idle", data: { sessionID: "ses_1" } })
    await until(() => threeDone, "the legacy priority session got the freed slot")
    await wait(150)
    assert.equal(twoDone, false, "the ordinary waiter still holds back for it")

    harness.bus.emit({ type: "session.idle", data: { sessionID: "ses_3" } })
    await Promise.all([two, three])
  } finally {
    await harness.teardown()
  }
})

test("wait label: compact and international", () => {
  assert.equal(mod.formatWait(0), "")
  assert.equal(mod.formatWait(59_000), "")
  assert.equal(mod.formatWait(60_000), "1m")
  assert.equal(mod.formatWait(26 * 60_000), "26m")
  assert.equal(mod.formatWait(65 * 60_000), "1h5m")
  assert.equal(mod.formatWait(120 * 60_000), "2h")
  assert.equal(mod.formatWait(3 * 60_000, { position: 2, total: 3 }), "2/3 · 3m")
  assert.equal(mod.formatWait(0, { position: 2, total: 3 }), "2/3")
  assert.equal(mod.formatWait(3 * 60_000, { position: 1, total: 1 }), "3m")

  assert.equal(mod.withWaitPrefix("do it", 0), "⏳ do it")
  assert.equal(mod.withWaitPrefix("do it", 3 * 60_000), "⏳ 3m · do it")
  assert.equal(mod.withWaitPrefix("do it", 3 * 60_000, { position: 2, total: 3 }), "⏳ 2/3 · 3m · do it")
  assert.equal(mod.withWaitPrefix("⏳ 3m · do it", 4 * 60_000), "⏳ 4m · do it")
  assert.equal(mod.withWaitPrefix("⏳ do it", 2 * 60_000), "⏳ 2m · do it")

  assert.equal(mod.stripWaitPrefix("⏳ 4m · do it"), "do it")
  assert.equal(mod.stripWaitPrefix("⏳ 2/3 · 1h5m · do it"), "do it")
  assert.equal(mod.stripWaitPrefix("⏳ 4 мин · do it"), "do it")
  assert.equal(mod.stripWaitPrefix("⏳ 1 ч 5 мин · do it"), "do it")
  assert.equal(mod.stripWaitPrefix("⏳ ждёт · do it"), "do it")
  assert.equal(mod.stripWaitPrefix("⏳ do it"), "do it")
  assert.equal(mod.stripWaitPrefix("⏳ 2/3 · ⏳ 5m · do it"), "do it")
  assert.equal(mod.stripWaitPrefix("plain title"), "plain title")
})

test("default wait tick fits a visible countdown", () => {
  assert.equal(mod.DEFAULTS.remindEveryMs, 60_000)
})

test("default timeout is 16 hours (long-running goals stay serialised)", () => {
  assert.equal(mod.DEFAULTS.acquireTimeoutMs, 16 * 60 * 60_000)
  assert.equal(mod.DEFAULTS.onTimeout, "proceed")
  assert.equal(mod.DEFAULTS.markWaitingTitle, true)
})

test("helper predicates: baseURL classification and event session ids", () => {
  assert.equal(mod.isLocalBaseUrl("http://127.0.0.1:18500/v1", mod.DEFAULTS.localHosts), true)
  assert.equal(mod.isLocalBaseUrl("http://localhost:18601/v1", mod.DEFAULTS.localHosts), true)
  assert.equal(mod.isLocalBaseUrl("http://127.1.2.3:8000", mod.DEFAULTS.localHosts), true)
  assert.equal(mod.isLocalBaseUrl("https://polza.ai/api/v1", mod.DEFAULTS.localHosts), false)
  assert.equal(mod.isLocalBaseUrl(undefined, mod.DEFAULTS.localHosts), undefined)

  assert.equal(mod.eventSessionID({ type: "session.idle", data: { sessionID: "ses_x" } }), "ses_x")
  assert.equal(mod.eventSessionID({ type: "form.created", data: { form: { sessionID: "ses_y" } } }), "ses_y")
  assert.equal(mod.eventSessionID({ type: "session.status", data: { sessionID: "ses_z", status: { type: "busy" } } }), undefined)
})

test("a stale lease left in the store stops blocking after leaseTimeoutMs", async () => {
  const harness = await setup({ limit: 1, leaseTimeoutMs: 1_000 })
  try {
    const now = Date.now()
    fileStore(harness.dir).write({ sid: "ses_ghost", since: now - 60_000, seen: now - 60_000, pid: process.pid })

    const started = Date.now()
    await harness.context("ses_new")
    assert.ok(Date.now() - started < 900, "the stale lease is swept, not waited out")
    assert.equal(fileStore(harness.dir).list().length, 1)
  } finally {
    await harness.teardown()
  }
})

// --- lockScope: "request" -------------------------------------------------
//
// In request scope a lease covers one model request, so the slot is freed when
// the step's tools start (or at `session.step.ended` when nothing follows) and
// taken again at the next `context`. The queue is ordered by the session's
// absolute creation time, so a session that comes back after a tool is still
// the oldest one in its level.

test("request scope: one step, not the whole turn, frees the slot", async () => {
  const harness = await setup({ lockScope: "request" })
  try {
    await harness.context("ses_1")
    await harness.context("ses_2")

    let thirdDone = false
    const third = harness.context("ses_3").then(() => {
      thirdDone = true
    })
    await wait(150)
    assert.equal(thirdDone, false, "both requests are in flight, so the third session waits")

    harness.bus.emit({
      type: "session.step.ended",
      data: { sessionID: "ses_1", assistantMessageID: "msg_1", finish: "tool-calls" },
    })
    await until(() => thirdDone, "the end of one request admits the waiter")

    // `step.failed` is the same boundary.
    harness.bus.emit({
      type: "session.step.failed",
      data: { sessionID: "ses_2", assistantMessageID: "msg_2", error: "boom" },
    })
    let fourthDone = false
    const fourth = harness.context("ses_4").then(() => {
      fourthDone = true
    })
    await until(() => fourthDone, "a failed step frees its slot too")

    assert.deepEqual(
      fileStore(harness.dir)
        .list()
        .map((lease: { sid: string }) => lease.sid)
        .sort(),
      ["ses_3", "ses_4"],
      "the slots are held by the two sessions that asked last",
    )
    void third
    void fourth
  } finally {
    await harness.teardown()
  }
})

test("request scope: a session gets its place back on the step after it released the slot", async () => {
  const harness = await setup(
    { lockScope: "request" },
    { created: { ses_a: 100, ses_b: 200, ses_c: 300, ses_d: 400 } },
  )
  try {
    await harness.context("ses_a")
    await harness.context("ses_b")

    let cDone = false
    let dDone = false
    const c = harness.context("ses_c").then(() => {
      cDone = true
    })
    await until(() => existsSync(join(harness.dir, "ses_c.wait.json")), "the first waiter is queued")
    const d = harness.context("ses_d").then(() => {
      dDone = true
    })
    await until(() => existsSync(join(harness.dir, "ses_d.wait.json")), "the second waiter is queued")

    // a's step is over: the oldest waiter takes the slot, as usual.
    harness.bus.emit({
      type: "session.step.ended",
      data: { sessionID: "ses_a", assistantMessageID: "msg_a", finish: "tool-calls" },
    })
    await until(() => cDone, "the oldest waiter took the freed slot")
    assert.equal(dDone, false, "the younger waiter still waits")

    // a asks for the model again. It was created before d, so it is not sent to
    // the back of the queue.
    let aDone = false
    const a = harness.context("ses_a").then(() => {
      aDone = true
    })
    await until(() => existsSync(join(harness.dir, "ses_a.wait.json")), "the returning session is queued")

    harness.bus.emit({
      type: "session.step.ended",
      data: { sessionID: "ses_b", assistantMessageID: "msg_b", finish: "tool-calls" },
    })
    await until(() => aDone, "the returning session took the next slot ahead of the younger waiter")
    await wait(150)
    assert.equal(dDone, false, "the younger waiter is still behind it")

    harness.bus.emit({ type: "session.idle", data: { sessionID: "ses_c" } })
    await until(() => dDone, "the last waiter runs once a slot is really free")
    void a
    void c
  } finally {
    await harness.teardown()
  }
})

test("request scope: a continuing step releases the slot and leaves a return ticket", async () => {
  const harness = await setup({ lockScope: "request" })
  try {
    await harness.context("ses_1")
    assert.equal(existsSync(join(harness.dir, "ses_1.turn.json")), false, "a held slot has no ticket")

    harness.bus.emit({
      type: "session.step.ended",
      data: { sessionID: "ses_1", assistantMessageID: "msg_1", finish: "tool-calls" },
    })
    await until(() => !existsSync(join(harness.dir, "ses_1.lease.json")), "the step released the slot")
    assert.equal(existsSync(join(harness.dir, "ses_1.turn.json")), true, "the continuing session keeps its place")

    const ticket = JSON.parse(readFileSync(join(harness.dir, "ses_1.turn.json"), "utf8"))
    assert.equal(ticket.sid, "ses_1")
    assert.equal(typeof ticket.releasedGrants, "number", "the ticket records how many grants had happened")
    assert.ok(ticket.expiresAt > ticket.releasedAt, "the ticket has a deadline")
  } finally {
    await harness.teardown()
  }
})

test("request scope: the first tool of a step frees the slot before the step ends", async () => {
  const harness = await setup({ lockScope: "request", limit: 1 })
  try {
    await harness.context("ses_1")

    let secondDone = false
    const second = harness.context("ses_2").then(() => {
      secondDone = true
    })
    await until(() => existsSync(join(harness.dir, "ses_2.wait.json")), "the second session is queued")

    // The model has answered and its tool is starting. OpenCode closes the step
    // only after the tool returns, so a slow tool would hold the slot for its
    // whole run; the tool start is the moment the engine is really free. The
    // name arrives first, as it does in a real stream.
    harness.bus.emit({
      type: "session.tool.input.started",
      data: { sessionID: "ses_1", assistantMessageID: "msg_1", id: "call_1", name: "bash" },
    })
    harness.bus.emit({
      type: "session.tool.called",
      data: { sessionID: "ses_1", assistantMessageID: "msg_1", id: "call_1", input: {}, executed: true },
    })
    await until(() => secondDone, "the running tool does not hold the slot")
    assert.equal(existsSync(join(harness.dir, "ses_1.lease.json")), false, "the lease is gone while the tool runs")
    assert.equal(
      existsSync(join(harness.dir, "ses_1.turn.json")),
      true,
      "the session keeps its place while its tool runs",
    )

    // The step closes after the tool; it must not release the slot the next
    // session now holds, and it must not leave a second ticket.
    harness.bus.emit({
      type: "session.step.ended",
      data: { sessionID: "ses_1", assistantMessageID: "msg_1", finish: "tool-calls" },
    })
    await wait(80)
    assert.equal(existsSync(join(harness.dir, "ses_2.lease.json")), true, "the late step end leaves the new holder alone")
    const releases = harness.traceLines().filter((line) => line.ev === "release" && line.sid === "ses_1")
    assert.equal(releases.length, 1, "one release per step")
    assert.equal(releases[0].reason, "tool started", "the release names the tool start")
    void second
  } finally {
    await harness.teardown()
  }
})

test("request scope: a tool event for a session without a lease changes nothing", async () => {
  const harness = await setup({ lockScope: "request" })
  try {
    await harness.context("ses_1")
    harness.bus.emit({
      type: "session.tool.called",
      data: { sessionID: "ses_9", assistantMessageID: "msg_9", id: "call_9", input: {}, executed: true },
    })
    await wait(80)
    assert.equal(existsSync(join(harness.dir, "ses_1.lease.json")), true, "another session's lease is untouched")
    assert.equal(existsSync(join(harness.dir, "ses_9.turn.json")), false, "no ticket for a session that held nothing")
  } finally {
    await harness.teardown()
  }
})

test("request scope: a subagent tool keeps the slot for the child it starts", async () => {
  const harness = await setup({ lockScope: "request", limit: 1 })
  try {
    await harness.context("ses_parent")
    harness.bus.emit({
      type: "session.tool.input.started",
      data: { sessionID: "ses_parent", assistantMessageID: "msg_p", id: "call_p", name: "subagent" },
    })
    harness.bus.emit({
      type: "session.tool.called",
      data: { sessionID: "ses_parent", assistantMessageID: "msg_p", id: "call_p", input: {}, executed: true },
    })
    await wait(80)
    assert.equal(
      existsSync(join(harness.dir, "ses_parent.lease.json")),
      true,
      "the child's requests run on the parent's slot, so the parent keeps it",
    )
    assert.equal(existsSync(join(harness.dir, "ses_parent.turn.json")), false, "no ticket while the child runs")
  } finally {
    await harness.teardown()
  }
})

test("turn scope: a tool event does not free the slot", async () => {
  const harness = await setup({ lockScope: "turn" })
  try {
    await harness.context("ses_1")
    harness.bus.emit({
      type: "session.tool.called",
      data: { sessionID: "ses_1", assistantMessageID: "msg_1", id: "call_1", input: {}, executed: true },
    })
    await wait(80)
    assert.equal(existsSync(join(harness.dir, "ses_1.lease.json")), true, "a turn lease covers its tools")
    assert.equal(existsSync(join(harness.dir, "ses_1.turn.json")), false, "a turn lease needs no return ticket")
  } finally {
    await harness.teardown()
  }
})

test("request scope: a short tool keeps the slot warm and the continuation is served at once", async () => {
  const harness = await setup({ lockScope: "request", limit: 1, warmHandoffMs: 5_000 })
  try {
    await harness.context("ses_1")

    let secondDone = false
    const second = harness.context("ses_2").then(() => {
      secondDone = true
    })
    await until(() => existsSync(join(harness.dir, "ses_2.wait.json")), "the second session is queued")

    // The model has answered and its tool is starting. The slot is not offered
    // to the queue: the tool is a second away and the engine still holds this
    // conversation, so the continuation can read the prompt from its cache.
    harness.bus.emit({
      type: "session.tool.input.started",
      data: { sessionID: "ses_1", assistantMessageID: "msg_1", id: "call_1", name: "bash" },
    })
    harness.bus.emit({
      type: "session.tool.called",
      data: { sessionID: "ses_1", assistantMessageID: "msg_1", id: "call_1", input: {}, executed: true },
    })
    await wait(80)
    assert.equal(existsSync(join(harness.dir, "ses_1.lease.json")), true, "the lease stays for the window")
    assert.equal(existsSync(join(harness.dir, "ses_1.turn.json")), false, "nothing was released, so no ticket")
    assert.equal(secondDone, false, "the waiter does not take the slot")

    // The tool returned, the step closed, the session asks for its next request.
    harness.bus.emit({
      type: "session.step.ended",
      data: { sessionID: "ses_1", assistantMessageID: "msg_1", finish: "tool-calls" },
    })
    await wait(30)
    await harness.context("ses_1")
    assert.equal(secondDone, false, "the continuation runs on the slot it kept")
    assert.equal(existsSync(join(harness.dir, "ses_1.lease.json")), true, "the lease is still the session's")

    const events = harness.traceLines().map((line) => line.ev)
    assert.ok(events.includes("step.warm-hold"), "the window opened at the tool start")
    assert.ok(events.includes("step.warm-keep"), "the continuing step did not close it")
    assert.ok(events.includes("step.warm-resume"), "the continuation resumed on it")
    assert.equal(
      harness.traceLines().filter((line) => line.ev === "ticket.write" && line.sid === "ses_1").length,
      0,
      "a window that was used leaves no return ticket",
    )
    assert.equal(events.includes("context.reacquire"), false, "the resume is not a lost step event")
    void second
  } finally {
    await harness.teardown()
  }
})

test("request scope: the warm window expires and hands the slot to the queue", async () => {
  const harness = await setup({ lockScope: "request", limit: 1, warmHandoffMs: 200 })
  try {
    await harness.context("ses_1")

    let secondDone = false
    const second = harness.context("ses_2").then(() => {
      secondDone = true
    })
    await until(() => existsSync(join(harness.dir, "ses_2.wait.json")), "the second session is queued")

    harness.bus.emit({
      type: "session.tool.input.started",
      data: { sessionID: "ses_1", assistantMessageID: "msg_1", id: "call_1", name: "bash" },
    })
    harness.bus.emit({
      type: "session.tool.called",
      data: { sessionID: "ses_1", assistantMessageID: "msg_1", id: "call_1", input: {}, executed: true },
    })
    await wait(60)
    assert.equal(secondDone, false, "the slot is kept while the window lasts")

    await until(() => secondDone, "the expired window admits the waiter", 2_000)
    assert.equal(existsSync(join(harness.dir, "ses_1.lease.json")), false, "the lease is gone")
    assert.equal(existsSync(join(harness.dir, "ses_1.turn.json")), true, "the session keeps its return right")
    const release = harness.traceLines().find((line) => line.ev === "release" && line.sid === "ses_1")
    assert.equal(release?.reason, "warm handoff expired", "the release names the window")
    void second
  } finally {
    await harness.teardown()
  }
})

test("request scope: a stop step closes the warm window at once", async () => {
  const harness = await setup({ lockScope: "request", limit: 1, warmHandoffMs: 5_000 })
  try {
    await harness.context("ses_1")

    let secondDone = false
    const second = harness.context("ses_2").then(() => {
      secondDone = true
    })
    await until(() => existsSync(join(harness.dir, "ses_2.wait.json")), "the second session is queued")

    harness.bus.emit({
      type: "session.tool.called",
      data: { sessionID: "ses_1", assistantMessageID: "msg_1", id: "call_1", input: {}, executed: true },
    })
    await wait(60)
    assert.equal(secondDone, false, "the slot is kept during the tool")

    // No continuation is coming: the turn is over, so the window is worthless.
    harness.bus.emit({
      type: "session.step.ended",
      data: { sessionID: "ses_1", assistantMessageID: "msg_1", finish: "stop" },
    })
    await until(() => secondDone, "the finished turn frees the slot", 1_000)
    assert.equal(existsSync(join(harness.dir, "ses_1.turn.json")), false, "a finished turn leaves no return ticket")
    void second
  } finally {
    await harness.teardown()
  }
})

test("request scope: a step that ends after its continuation started does not free the slot", async () => {
  // OpenCode normally emits `step.ended` before the next request, but 0.3% of
  // contexts arrive first (measured 08.11.2026). Such a late event belongs to
  // the step the continuation already resumed on; freeing the slot there would
  // let a waiter into a request that is still in flight.
  const harness = await setup({ lockScope: "request", limit: 1, warmHandoffMs: 5_000 })
  try {
    await harness.context("ses_1")

    let secondDone = false
    const second = harness.context("ses_2").then(() => {
      secondDone = true
    })
    await until(() => existsSync(join(harness.dir, "ses_2.wait.json")), "the second session is queued")

    harness.bus.emit({
      type: "session.tool.input.started",
      data: { sessionID: "ses_1", assistantMessageID: "msg_1", id: "call_1", name: "bash" },
    })
    harness.bus.emit({
      type: "session.tool.called",
      data: { sessionID: "ses_1", assistantMessageID: "msg_1", id: "call_1", input: {}, executed: true },
    })
    // The event loop processes the call before the next request, so let the
    // handler open the window first (the bus is asynchronous).
    await wait(40)
    await harness.context("ses_1")
    // The step of `msg_1` closes only now, after its continuation is running.
    harness.bus.emit({
      type: "session.step.ended",
      data: { sessionID: "ses_1", assistantMessageID: "msg_1", finish: "tool-calls" },
    })
    await wait(80)
    assert.equal(existsSync(join(harness.dir, "ses_1.lease.json")), true, "the late step leaves the lease alone")
    assert.equal(secondDone, false, "the waiter is still held back")
    const ignore = harness.traceLines().find(
      (line) => line.ev === "event.ignore" && line.why === "step ended after its continuation had already started",
    )
    assert.ok(ignore, "the late event is named in the trace")
    void second
  } finally {
    await harness.teardown()
  }
})

test("request scope: warmHandoffMs 0 frees the slot at the tool start", async () => {
  const harness = await setup({ lockScope: "request", limit: 1, warmHandoffMs: 0 })
  try {
    await harness.context("ses_1")
    let secondDone = false
    const second = harness.context("ses_2").then(() => {
      secondDone = true
    })
    await until(() => existsSync(join(harness.dir, "ses_2.wait.json")), "the second session is queued")
    harness.bus.emit({
      type: "session.tool.input.started",
      data: { sessionID: "ses_1", assistantMessageID: "msg_1", id: "call_1", name: "bash" },
    })
    harness.bus.emit({
      type: "session.tool.called",
      data: { sessionID: "ses_1", assistantMessageID: "msg_1", id: "call_1", input: {}, executed: true },
    })
    await until(() => secondDone, "the old behaviour frees the slot at once")
    assert.equal(existsSync(join(harness.dir, "ses_1.turn.json")), true, "and leaves the return ticket")
    void second
  } finally {
    await harness.teardown()
  }
})

test("request scope: a stop step leaves no return ticket", async () => {
  const harness = await setup({ lockScope: "request" })
  try {
    await harness.context("ses_1")
    harness.bus.emit({
      type: "session.step.ended",
      data: { sessionID: "ses_1", assistantMessageID: "msg_1", finish: "stop" },
    })
    await until(() => !existsSync(join(harness.dir, "ses_1.lease.json")), "the stop step released the slot")
    assert.equal(existsSync(join(harness.dir, "ses_1.turn.json")), false, "a finished run has no place to keep")
  } finally {
    await harness.teardown()
  }
})

test("request scope: a covered subagent leaves the second slot to an unrelated session", async () => {
  const harness = await setup({ lockScope: "request", limit: 2 }, { parents: { ses_child: "ses_parent" } })
  try {
    await harness.context("ses_parent")
    await harness.context("ses_child")
    assert.deepEqual(
      fileStore(harness.dir)
        .list()
        .map((lease: { sid: string }) => lease.sid)
        .sort(),
      ["ses_parent"],
      "the child rides the parent's slot instead of taking a second one",
    )

    await harness.context("ses_third")
    assert.deepEqual(
      fileStore(harness.dir)
        .list()
        .map((lease: { sid: string }) => lease.sid)
        .sort(),
      ["ses_parent", "ses_third"],
      "the second slot goes to an unrelated session, not to the covered child",
    )

    let fourthDone = false
    const fourth = harness.context("ses_fourth").then(() => {
      fourthDone = true
    })
    await wait(150)
    assert.equal(fourthDone, false, "both slots are in use")

    harness.bus.emit({
      type: "session.step.ended",
      data: { sessionID: "ses_parent", assistantMessageID: "msg_p", finish: "tool-calls" },
    })
    await until(() => fourthDone, "the parent's step end frees a slot for the fourth session")
    void fourth
  } finally {
    await harness.teardown()
  }
})

test("request scope: a returning session does not jump over a priority waiter", async () => {
  const harness = await setup({ lockScope: "request" })
  try {
    await harness.context("ses_a")
    await harness.context("ses_b")

    let cDone = false
    const c = harness.context("ses_c").then(() => {
      cDone = true
    })
    await until(() => existsSync(join(harness.dir, "ses_c.wait.json")), "the ordinary waiter is queued")

    harness.bus.emit({
      type: "session.step.ended",
      data: { sessionID: "ses_a", assistantMessageID: "msg_a", finish: "tool-calls" },
    })
    await until(() => cDone, "the ordinary waiter took the slot")

    let aDone = false
    const a = harness.context("ses_a").then(() => {
      aDone = true
    })
    await until(() => existsSync(join(harness.dir, "ses_a.wait.json")), "the returning session is queued")

    await harness.command("ses_d", "prio", "on")
    let dDone = false
    const d = harness.context("ses_d").then(() => {
      dDone = true
    })
    await until(() => existsSync(join(harness.dir, "ses_d.wait.json")), "the priority waiter is queued")

    harness.bus.emit({
      type: "session.step.ended",
      data: { sessionID: "ses_b", assistantMessageID: "msg_b", finish: "tool-calls" },
    })
    await until(() => dDone, "the priority waiter took the freed slot")
    await wait(150)
    assert.equal(aDone, false, "an older creation time does not outrank ⚡")
    void a
    void c
    void d
  } finally {
    await harness.teardown()
  }
})

test("request scope: creation time orders the queue even with /prio off", async () => {
  const harness = await setup(
    { lockScope: "request", priorityEnabled: false },
    { created: { ses_a: 100, ses_b: 200, ses_c: 300, ses_d: 400 } },
  )
  try {
    await harness.context("ses_a")
    await harness.context("ses_b")

    let cDone = false
    const c = harness.context("ses_c").then(() => {
      cDone = true
    })
    await until(() => existsSync(join(harness.dir, "ses_c.wait.json")), "the first waiter is queued")

    harness.bus.emit({
      type: "session.step.ended",
      data: { sessionID: "ses_a", assistantMessageID: "msg_a", finish: "tool-calls" },
    })
    await until(() => cDone, "the first waiter took the freed slot")

    let aDone = false
    const a = harness.context("ses_a").then(() => {
      aDone = true
    })
    await until(() => existsSync(join(harness.dir, "ses_a.wait.json")), "the returning session is queued")

    let dDone = false
    const d = harness.context("ses_d").then(() => {
      dDone = true
    })
    await until(() => existsSync(join(harness.dir, "ses_d.wait.json")), "a later waiter is queued")

    harness.bus.emit({
      type: "session.step.ended",
      data: { sessionID: "ses_b", assistantMessageID: "msg_b", finish: "tool-calls" },
    })
    await until(() => aDone, "the older session wins without any priority flag")
    await wait(150)
    assert.equal(dDone, false, "the later waiter still waits")
    void a
    void c
    void d
  } finally {
    await harness.teardown()
  }
})

test("request scope: a subagent rides the slot its parent holds", async () => {
  const harness = await setup(
    { lockScope: "request", limit: 1 },
    { parents: { ses_child: "ses_parent" } },
  )
  try {
    await harness.context("ses_parent")
    assert.ok(existsSync(join(harness.dir, "ses_parent.lease.json")), "the parent holds the slot")

    // The parent's step cannot end until this child answers, so the child must
    // not queue for a slot of its own: that is a deadlock, not a wait.
    let childDone = false
    const child = harness.context("ses_child").then(() => {
      childDone = true
    })
    await until(() => childDone, "the subagent is served under the parent's slot")
    assert.equal(existsSync(join(harness.dir, "ses_child.wait.json")), false, "the subagent never queues")
    assert.equal(existsSync(join(harness.dir, "ses_child.lease.json")), false, "the subagent takes no second slot")
    await child
  } finally {
    await harness.teardown()
  }
})

test("request scope: the subagent queues again once the parent's slot is gone", async () => {
  const harness = await setup(
    { lockScope: "request", limit: 1 },
    { parents: { ses_child: "ses_parent" } },
  )
  try {
    await harness.context("ses_parent")
    await harness.context("ses_child")
    harness.bus.emit({ type: "session.step.ended", data: { sessionID: "ses_parent" } })
    await until(() => !existsSync(join(harness.dir, "ses_parent.lease.json")), "the parent's step freed the slot")

    await harness.context("ses_other")
    let childDone = false
    const child = harness.context("ses_child").then(() => {
      childDone = true
    })
    await until(() => existsSync(join(harness.dir, "ses_child.wait.json")), "the uncovered child queues for its own slot")
    assert.equal(childDone, false, "no free slot, so the child waits")

    harness.bus.emit({ type: "session.idle", data: { sessionID: "ses_other" } })
    await child
    assert.equal(childDone, true, "the child is served when the slot frees")
  } finally {
    await harness.teardown()
  }
})

test("request scope: a subagent queues at its parent's level", async () => {
  const harness = await setup(
    { lockScope: "request", limit: 1 },
    { parents: { ses_child: "ses_parent" } },
  )
  try {
    await harness.context("ses_holder")
    await harness.command("ses_parent", "prio", "low")

    let childDone = false
    const child = harness.context("ses_child").then(() => {
      childDone = true
    })
    await until(() => existsSync(join(harness.dir, "ses_child.wait.json")), "the subagent is queued")

    let ordinaryDone = false
    const ordinary = harness.context("ses_ordinary").then(() => {
      ordinaryDone = true
    })
    await until(() => existsSync(join(harness.dir, "ses_ordinary.wait.json")), "the ordinary waiter is queued")

    harness.bus.emit({ type: "session.idle", data: { sessionID: "ses_holder" } })
    await until(() => ordinaryDone, "the ordinary waiter outranks the low parent's subagent")
    await wait(150)
    assert.equal(childDone, false, "the subagent waits at its parent's level")

    harness.bus.emit({ type: "session.idle", data: { sessionID: "ses_ordinary" } })
    await until(() => childDone, "the subagent runs once the ordinary waiter is served")
    void child
    void ordinary
  } finally {
    await harness.teardown()
  }
})

test("request scope: a subagent rides its parent's return ticket", async () => {
  const harness = await setup(
    { lockScope: "request", limit: 1 },
    { parents: { ses_child: "ses_parent" }, created: { ses_parent: 100, ses_child: 150, ses_other: 50, ses_late: 900 } },
  )
  try {
    await harness.context("ses_parent")
    harness.bus.emit({
      type: "session.step.ended",
      data: { sessionID: "ses_parent", assistantMessageID: "msg_p", finish: "tool-calls" },
    })
    await until(() => existsSync(join(harness.dir, "ses_parent.turn.json")), "the parent left a ticket")

    // The other session takes the freed slot, which lifts the parent's ticket.
    await harness.context("ses_other")

    // The child asks next; it reads the parent's ticket through rootOf.
    let childDone = false
    const child = harness.context("ses_child").then(() => {
      childDone = true
    })
    await until(() => existsSync(join(harness.dir, "ses_child.wait.json")), "the child is queued")

    // A session created much later queues behind it.
    let lateDone = false
    const late = harness.context("ses_late").then(() => {
      lateDone = true
    })
    await until(() => existsSync(join(harness.dir, "ses_late.wait.json")), "the later waiter is queued")

    harness.bus.emit({ type: "session.idle", data: { sessionID: "ses_other" } })
    await until(() => childDone, "the child is served on the parent's ticket")
    await wait(150)
    assert.equal(lateDone, false, "an ordinary later session waits behind the ticket")
    void child
    void late
  } finally {
    await harness.teardown()
  }
})

test("boot drops turn tickets left by a previous version", async () => {
  const harness = await setup({}, {}, (dir) => {
    writeFileSync(
      join(dir, "ses_1.turn.json"),
      JSON.stringify({ sid: "ses_1", pid: 0, since: Date.now() - 60_000, seen: Date.now() - 60_000 }),
    )
  })
  try {
    assert.equal(existsSync(join(harness.dir, "ses_1.turn.json")), false, "the obsolete ticket is gone")
    assert.match(harness.logText(), /tickets=1/, "boot reports what it cleaned up")
  } finally {
    await harness.teardown()
  }
})

test("turn scope: step events do not free the slot", async () => {
  const harness = await setup({ lockScope: "turn" })
  try {
    await harness.context("ses_1")
    await harness.context("ses_2")
    let thirdDone = false
    const third = harness.context("ses_3").then(() => {
      thirdDone = true
    })
    await wait(150)

    harness.bus.emit({
      type: "session.step.ended",
      data: { sessionID: "ses_1", assistantMessageID: "msg_1", finish: "tool-calls" },
    })
    await wait(200)
    assert.equal(thirdDone, false, "the whole turn still owns the slot")
    assert.match(harness.logText(), /scope=turn/)

    harness.bus.emit({ type: "session.idle", data: { sessionID: "ses_1" } })
    await until(() => thirdDone, "only the end of the turn admits the waiter")
    void third
  } finally {
    await harness.teardown()
  }
})

// --- request scope: the step boundary and the return ticket -----------------
//
// A step boundary ends one model request: the slot is freed at once, so the
// engine can serve the next session while this one runs its tools. A
// `finish: "tool-calls"` or `"length"` step leaves a return ticket, so the
// session that comes back for the next request is served at the front of its
// level — but only after another session has actually been admitted, so the
// release is a real handover rather than a bounce.

test("shipped defaults: one slot, 200 ms polling, a 12 s warm handoff, a 5-minute ticket", () => {
  assert.equal(mod.DEFAULTS.limit, 1, "the engine serves one request at a time")
  assert.equal(mod.DEFAULTS.pollMs, 200)
  assert.equal(mod.DEFAULTS.warmHandoffMs, 12_000, "the slot stays warm across a short tool")
  assert.equal(mod.DEFAULTS.returnTicketTtlMs, 5 * 60_000)
  assert.equal(mod.DEFAULTS.lockScope, "request")
  assert.equal("requeueGraceMs" in mod.DEFAULTS, false, "the fory is gone")
})

test("request scope: a tool-calls step frees the slot at once", async () => {
  const harness = await setup({ lockScope: "request", limit: 1 })
  try {
    await harness.context("ses_a")
    let bDone = false
    const b = harness.context("ses_b").then(() => {
      bDone = true
    })
    await until(() => existsSync(join(harness.dir, "ses_b.wait.json")), "the waiter is queued")

    harness.bus.emit({
      type: "session.step.ended",
      data: { sessionID: "ses_a", assistantMessageID: "msg_a", finish: "tool-calls" },
    })
    await until(() => bDone, "the end of the request admits the waiter")
    assert.equal(existsSync(join(harness.dir, "ses_a.lease.json")), false, "the slot is free while the tools run")
    assert.equal(existsSync(join(harness.dir, "ses_a.turn.json")), true, "the returning session keeps its place")
    void b
  } finally {
    await harness.teardown()
  }
})

test("request scope: a sibling instance does not free a lease it did not take", async () => {
  // Every plugin instance (one per location) receives every server event, but
  // only the instance that served the request may decide what its boundary
  // means. The holder frees its own slot; the sibling only records why it left
  // the lease alone, and the holder's return ticket survives.
  const bus = makeEventBus()
  const dir = mkdtempSync(join(tmpdir(), "turn-lock-plugin-"))
  const holder = await setup({ lockScope: "request", limit: 1 }, {}, undefined, { dir, bus })
  const sibling = await setup({ lockScope: "request", limit: 1 }, {}, undefined, { dir, bus })
  try {
    await holder.context("ses_1")
    assert.ok(existsSync(join(dir, "ses_1.lease.json")), "the holder took the slot")

    bus.emit({
      type: "session.step.ended",
      data: { sessionID: "ses_1", assistantMessageID: "msg_1", finish: "tool-calls" },
    })
    await until(() => !existsSync(join(dir, "ses_1.lease.json")), "the holder frees its own slot")
    assert.equal(existsSync(join(dir, "ses_1.turn.json")), true, "the holder wrote the return ticket")

    const ignored = sibling
      .traceLines()
      .filter((line) => line.ev === "event.ignore")
      .map((line) => line.why)
    assert.ok(
      ignored.some((why) => String(why).includes("does not hold")),
      "the sibling says it did not hold the lease",
    )
  } finally {
    await sibling.teardown()
    await holder.teardown()
  }
})

test("request scope: a stop step frees the slot at once", async () => {
  const harness = await setup({ lockScope: "request", limit: 1 })
  try {
    await harness.context("ses_a")
    let bDone = false
    const b = harness.context("ses_b").then(() => {
      bDone = true
    })
    await until(() => existsSync(join(harness.dir, "ses_b.wait.json")), "the waiter is queued")

    harness.bus.emit({
      type: "session.step.ended",
      data: { sessionID: "ses_a", assistantMessageID: "msg_a", finish: "stop" },
    })
    await until(() => bDone, "a finished turn does not hold the slot")
    void b
  } finally {
    await harness.teardown()
  }
})

test("request scope: a length step frees the slot and leaves a ticket", async () => {
  const harness = await setup({ lockScope: "request", limit: 1 })
  try {
    await harness.context("ses_a")
    let bDone = false
    const b = harness.context("ses_b").then(() => {
      bDone = true
    })
    await until(() => existsSync(join(harness.dir, "ses_b.wait.json")), "the waiter is queued")

    harness.bus.emit({
      type: "session.step.ended",
      data: { sessionID: "ses_a", assistantMessageID: "msg_a", finish: "length" },
    })
    await until(() => bDone, "a truncated step frees the slot too")
    assert.equal(existsSync(join(harness.dir, "ses_a.turn.json")), true, "the continuation keeps its place")

    // The continuation comes back as a normal request: it queues, but its
    // ticket is already lifted by b's admission, so it is boosted.
    let aDone = false
    const a = harness.context("ses_a").then(() => {
      aDone = true
    })
    await until(() => existsSync(join(harness.dir, "ses_a.wait.json")), "the continuation is queued")
    harness.bus.emit({
      type: "session.step.ended",
      data: { sessionID: "ses_b", assistantMessageID: "msg_b", finish: "tool-calls" },
    })
    await until(() => aDone, "the continuation takes the next slot")
    void a
    void b
  } finally {
    await harness.teardown()
  }
})

test("request scope: a fast tool cannot take the slot back before the waiter is admitted", async () => {
  // The tool that follows a step may finish in milliseconds, so the session can
  // ask for the model again before the waiter has even polled. The ticket must
  // not let it bounce the slot back: the handover has to happen first.
  const harness = await setup({ lockScope: "request", limit: 1 })
  try {
    await harness.context("ses_a")
    let bDone = false
    const b = harness.context("ses_b").then(() => {
      bDone = true
    })
    await until(() => existsSync(join(harness.dir, "ses_b.wait.json")), "the waiter is queued")

    harness.bus.emit({
      type: "session.step.ended",
      data: { sessionID: "ses_a", assistantMessageID: "msg_a", finish: "tool-calls" },
    })
    // a comes back at once, before b has polled.
    let aDone = false
    const a = harness.context("ses_a").then(() => {
      aDone = true
    })
    await until(() => bDone, "the queued waiter is admitted first")
    await wait(150)
    assert.equal(aDone, false, "the returning session waits for the handover to finish")

    harness.bus.emit({
      type: "session.step.ended",
      data: { sessionID: "ses_b", assistantMessageID: "msg_b", finish: "tool-calls" },
    })
    await until(() => aDone, "the returning session takes the next slot")
    void a
    void b
  } finally {
    await harness.teardown()
  }
})

test("request scope: a high returning head is not blocked by the ordinary queue behind it", async () => {
  // The head came back from a `tool-calls` step, so its return ticket is not
  // lifted yet: no grant has happened since it released. The waiters behind it
  // are ordinary, so they cannot take the slot while the head outranks them —
  // nobody can. Deferring the head for them deadlocks the queue until the
  // ticket expires (five minutes), which is exactly the stall this test pins.
  //
  // `pollMs` is deliberately huge: nobody gets a second poll, so the only
  // attempt that can take the freed slot is the head's own first one. That
  // makes the assertion about the defer rule deterministic instead of a race
  // between the head re-queueing and the waiter's next tick.
  const harness = await setup({ lockScope: "request", limit: 1, pollMs: 2_000 })
  try {
    await harness.context("ses_a")
    await harness.command("ses_a", "prio", "high")
    assert.deepEqual(harness.prioFiles(), ["ses_a"], "the head is high priority")

    let bDone = false
    const b = harness.context("ses_b").then(() => {
      bDone = true
    })
    await until(() => existsSync(join(harness.dir, "ses_b.wait.json")), "the ordinary waiter is queued")
    assert.equal(bDone, false, "the waiter does not take the busy slot")

    harness.bus.emit({
      type: "session.step.ended",
      data: { sessionID: "ses_a", assistantMessageID: "msg_a", finish: "tool-calls" },
    })
    await until(() => !existsSync(join(harness.dir, "ses_a.lease.json")), "the head frees its slot")
    await until(() => existsSync(join(harness.dir, "ses_a.turn.json")), "the head keeps its return ticket")

    let aDone = false
    const a = harness.context("ses_a").then(() => {
      aDone = true
    })
    // Well under `acquireTimeoutMs` (4 s in the harness): only a real grant can
    // satisfy this, not the fail-open timer.
    await until(() => aDone, "the high head is served at once instead of waiting out its ticket", 1_000)
    assert.equal(bDone, false, "the ordinary waiter still yields to the high session")
    void a
    void b
  } finally {
    await harness.teardown()
  }
})

test("request scope: the queue is ordered by creation time, not by when the wait began", async () => {
  const harness = await setup(
    { lockScope: "request", limit: 1 },
    { created: { ses_old: 100, ses_mid: 200, ses_new: 300 } },
  )
  try {
    await harness.context("ses_holder")
    let midDone = false
    let oldDone = false
    // The older session queues *after* the younger one.
    const mid = harness.context("ses_mid").then(() => {
      midDone = true
    })
    await until(() => existsSync(join(harness.dir, "ses_mid.wait.json")), "the younger waiter is queued")
    const old = harness.context("ses_old").then(() => {
      oldDone = true
    })
    await until(() => existsSync(join(harness.dir, "ses_old.wait.json")), "the older waiter is queued")

    harness.bus.emit({ type: "session.idle", data: { sessionID: "ses_holder" } })
    await until(() => oldDone, "the oldest session takes the slot")
    assert.equal(midDone, false, "the session created later waits behind it")
    void old
    void mid
  } finally {
    await harness.teardown()
  }
})

test("request scope: the creation time travels in the wait sidecar", async () => {
  const harness = await setup({ lockScope: "request", limit: 1 }, { created: { ses_1: 4_242 } })
  try {
    await harness.context("ses_holder")
    const waiter = harness.context("ses_1")
    await until(() => existsSync(join(harness.dir, "ses_1.wait.json")), "the waiter is queued")
    const mark = JSON.parse(readFileSync(join(harness.dir, "ses_1.wait.json"), "utf8"))
    assert.equal(mark.createdAt, 4_242, "another instance can order the queue by the same key")
    void waiter
  } finally {
    await harness.teardown()
  }
})

test("request scope: the trace records the gate, the step and the release", async () => {
  const harness = await setup({ lockScope: "request", limit: 1 })
  try {
    await harness.context("ses_a")
    harness.bus.emit({
      type: "session.step.ended",
      data: { sessionID: "ses_a", assistantMessageID: "msg_a", finish: "stop" },
    })
    await until(() => !existsSync(join(harness.dir, "ses_a.lease.json")), "the stop step frees the slot")

    const lines = harness.traceLines()
    const events = lines.map((line) => line.ev)
    for (const expected of ["boot", "context.enter", "acquire.start", "acquire.result", "lease.taken", "event.recv", "step.release", "release"]) {
      assert.ok(events.includes(expected), `trace has ${expected}`)
    }
    const step = lines.find((line) => line.ev === "step.release")
    assert.equal(step?.sid, "ses_a")
    assert.equal(step?.finish, "stop")
    const release = lines.find((line) => line.ev === "release")
    assert.equal(release?.reason, "session.step.ended")
    assert.equal(typeof release?.ageMs, "number", "the release line says how long the lease was held")
    // Every line carries the instance it came from.
    for (const line of lines) {
      assert.equal(typeof line.pid, "number")
      assert.equal(typeof line.owner, "string")
      assert.equal(typeof line.ms, "number")
    }
  } finally {
    await harness.teardown()
  }
})

test("request scope: the trace records a returning step and its ticket", async () => {
  const harness = await setup({ lockScope: "request", limit: 1 })
  try {
    await harness.context("ses_a")
    harness.bus.emit({
      type: "session.step.ended",
      data: { sessionID: "ses_a", assistantMessageID: "msg_a", finish: "tool-calls" },
    })
    await until(() => existsSync(join(harness.dir, "ses_a.turn.json")), "the ticket is written")

    const lines = harness.traceLines()
    const step = lines.find((line) => line.ev === "step.release")
    assert.equal(step?.sid, "ses_a")
    assert.equal(step?.finish, "tool-calls")
    assert.equal(step?.returning, true, "the step says the run continues")
    const release = lines.find((line) => line.ev === "release")
    assert.equal(release?.reason, "step-boundary", "the release reason names the boundary")
    const ticket = lines.find((line) => line.ev === "ticket.write")
    assert.equal(ticket?.sid, "ses_a")
    assert.equal(ticket?.why, "step-boundary")
  } finally {
    await harness.teardown()
  }
})

test("request scope: a sibling instance traces why it left the lease alone", async () => {
  const bus = makeEventBus()
  const dir = mkdtempSync(join(tmpdir(), "turn-lock-plugin-"))
  const holder = await setup({ lockScope: "request", limit: 1 }, {}, undefined, { dir, bus })
  const sibling = await setup({ lockScope: "request", limit: 1 }, {}, undefined, { dir, bus })
  try {
    await holder.context("ses_1")
    bus.emit({
      type: "session.step.ended",
      data: { sessionID: "ses_1", assistantMessageID: "msg_1", finish: "tool-calls" },
    })
    await until(() => !existsSync(join(dir, "ses_1.lease.json")), "the holder released its slot")
    const ignored = sibling
      .traceLines()
      .filter((line) => line.ev === "event.ignore")
      .map((line) => line.why)
    assert.ok(
      ignored.some((why) => String(why).includes("does not hold")),
      "the sibling says it did not hold the lease",
    )
    assert.ok(holder.traceLines().some((line) => line.ev === "ticket.write"), "the holder wrote the return ticket")
  } finally {
    await sibling.teardown()
    await holder.teardown()
  }
})

test("request scope: unloading the plugin closes the stream line", async () => {
  const harness = await setup({ lockScope: "request", limit: 1 })
  try {
    await harness.context("ses_a")
    await harness.cleanup?.()
    await until(
      () => harness.traceLines().some((line) => line.ev === "stream.closed"),
      "the trace records the closed subscription",
    )
    const lines = harness.traceLines()
    const closed = lines.find((line) => line.ev === "stream.closed")
    assert.equal(closed?.aborted, true, "unload is an aborted stream")
    assert.equal(closed?.how, "ended", "the iterator ended rather than throwing")
    assert.equal(typeof closed?.events, "number")
    assert.ok(lines.some((line) => line.ev === "shutdown"), "shutdown says what the instance held")
  } finally {
    await harness.teardown()
  }
})

test("request scope: a step with no finish frees the slot at once", async () => {
  const harness = await setup({ lockScope: "request", limit: 1 })
  try {
    await harness.context("ses_a")
    let bDone = false
    const b = harness.context("ses_b").then(() => {
      bDone = true
    })
    await until(() => existsSync(join(harness.dir, "ses_b.wait.json")), "the waiter is queued")

    harness.bus.emit({ type: "session.step.ended", data: { sessionID: "ses_a" } })
    await until(() => bDone, "an unknown finish releases the slot")
    void b
  } finally {
    await harness.teardown()
  }
})












