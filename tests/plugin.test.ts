// End-to-end tests for the shipped plugin entry point src/index.ts.
//
// @opencode/plugin is replaced by tests/stubs/opencode-plugin.mjs through
// module.registerHooks; everything else (hook gating, event releases, shared
// file store, boot cleanup, timeout) is the real code.
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
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
}

function makeCtx(options: Record<string, unknown>, behavior: Behavior = {}) {
  const hooks: Hook[] = []
  const bus = makeEventBus()
  const updates: Array<{ sessionID: string; title: string }> = []
  const parents = behavior.parents ?? {}
  const titles = new Map<string, string>(Object.entries(behavior.titles ?? {}))
  const titleOf = (sessionID: string) => titles.get(sessionID) ?? "test session"
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
        return { id: sessionID, parentID: parents[sessionID], title: titleOf(sessionID) }
      },
      update: async ({ sessionID, title }: { sessionID: string; title: string }) => {
        if (behavior.failUpdate) throw new Error("session update failed")
        titles.set(sessionID, title)
        updates.push({ sessionID, title })
      },
    },
    provider: {
      get: async ({ providerID }: { providerID: string }) => {
        const info = PROVIDERS[providerID]
        if (!info) throw new Error(`unknown provider ${providerID}`)
        return info
      },
    },
    event: { subscribe: bus.subscribe },
  }
  return { ctx, hooks, bus, titles, updates }
}

type Harness = Awaited<ReturnType<typeof setup>>

async function setup(overrides: Record<string, unknown> = {}, behavior: Behavior = {}) {
  const dir = mkdtempSync(join(tmpdir(), "turn-lock-plugin-"))
  const logFile = join(dir, "turn-lock.log")
  const { ctx, hooks, bus, titles, updates } = makeCtx(
    {
      dir,
      logFile,
      pollMs: 10,
      acquireTimeoutMs: 4_000,
      refreshEveryMs: 0,
      remindEveryMs: 0,
      sweepMs: 60_000,
      ...overrides,
    },
    behavior,
  )
  const cleanup = await plugin.setup(ctx)
  const harness = {
    dir,
    logFile,
    hooks,
    bus,
    titles,
    updates,
    cleanup,
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
  const harness = await setup({}, { titles: { ses_1: "one", ses_2: "two", ses_3: "three" } })
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
  const harness = await setup({ remindEveryMs: 60 }, { titles: { ses_3: "three" } })
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

test("a title regenerated while waiting is marked again", async () => {
  const harness = await setup({ remindEveryMs: 60 }, { titles: { ses_3: "three" } })
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
    const harness = await setup({ dir, logFile: join(dir, "log.txt") }, { titles: { ses_ghost: "⏳ old title" } })
    try {
      assert.equal(harness.titles.get("ses_ghost"), "old title", "the marker is removed on boot")
    } finally {
      await harness.teardown()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
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

test("default timeout is 4 hours (long-running goals stay serialised)", () => {
  assert.equal(mod.DEFAULTS.acquireTimeoutMs, 4 * 60 * 60_000)
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
