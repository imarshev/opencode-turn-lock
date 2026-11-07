// gui.tsx — the desktop half of turn-lock: a pill above the composer that moves
// the session it sits over up or down the queue.
//
// It is deliberately thin. The state and the work already live in the server
// part (`<sessionID>.prio.json` plus the "⚡ "/"▽ " title prefix), and `/prio`
// already does everything; this file only puts that command under the cursor. So
// the pill reads the very mark the session list shows: the switch can never
// disagree with the list, and a change made on the phone is reflected here as
// soon as the session is renamed.
//
// One click, one step down the ladder: ordinary → `⚡` → `▽` → ordinary. Three
// states do not fit a toggle, and a menu would cost a second click for the
// commonest case; the mark in the title always says where the session stands.
//
// The pill hides only when the server *answered* that `/prio` is not registered
// (`priorityEnabled: false`). An unreachable or still-starting server is not an
// answer: the app restores the last session before its sidecar answers, and a
// probe cached as "missing" there would take the control away from that
// directory until the window was reopened. A failed probe runs again.
//
// Desktop only, by the host's own design: the web build never mounts a plugin
// GUI bundle (its host is created without the plugin bridge), so the phone keeps
// the slash command. This bundle is `./gui-experimental`, built by
// `npm run build` into `dist/gui-experimental.cjs`; the app loads no second
// chunk, and modules it provides itself (solid-js, effect, @opencode/*) must stay
// out of the bundle — the preset in `vite.config.ts` keeps them external.

import { createSignal } from "solid-js"
import { ComposerPill, Plugin, type ComposerPillProps, type MountedSession } from "@opencode/plugin/gui"

import { inboxLevel, startInboxView } from "./inbox.ts"
import { answerFrom, pillVisible, type PillAnswer } from "./pill.ts"
import { LEVEL_CYCLE, type PriorityLevel } from "./priority.ts"
import { readState } from "./state.ts"

/** Which level a title claims — the same reading the session list shows. */
const levelOf = inboxLevel

/** How long a failed probe waits before it runs again. */
const RETRY_MS = 3_000

export default Plugin.define({
  i18n: {
    en: {
      ordinary: "Queue: ordinary",
      priority: "Queue: priority",
      low: "Queue: low",
      hint: "Priority takes the next free slot, and an active session yields its slot at its next step. Nothing running is interrupted. One click: ordinary → priority → low → ordinary.",
      failed: "turn-lock: the priority change failed",
    },
    ru: {
      ordinary: "Очередь: обычная",
      priority: "Очередь: приоритет",
      low: "Очередь: низкий",
      hint: "Приоритет заберёт следующий свободный слот, а активная сессия уступит свой на границе своего следующего шага. Никакой работающий вызов не прерывается. Один клик: обычная → приоритет → низкий → обычная.",
      failed: "turn-lock: приоритет изменить не удалось",
    },
  },

  setup(ctx) {
    const command =
      typeof ctx.options?.priorityCommand === "string" && ctx.options.priorityCommand
        ? ctx.options.priorityCommand
        : "prio"
    const enabled = ctx.options?.priorityEnabled !== false
    // Client-only: the server part never sees this option. The sorter lives in
    // the same window as the sidebar, so it can style the rows the host renders.
    const sortInbox = ctx.options?.sortInbox !== false

    // session key -> level. A plain signal holding a new Map, so every pill
    // re-reads when any session's state changes.
    const [state, setState] = createSignal(new Map<string, PriorityLevel>())
    const remember = (key: string, level: PriorityLevel) =>
      setState((current) => {
        if (current.get(key) === level) return current
        const next = new Map(current)
        next.set(key, level)
        return next
      })

    // What the command list says about each directory. Only a real answer that
    // lacks the command hides the pill; `unknown` — the probe has not finished,
    // or the server was unreachable — shows it. `answered`/`probing` are
    // non-reactive on purpose: they only stop a request from being repeated on
    // every re-render.
    const [answers, setAnswers] = createSignal(new Map<string, PillAnswer>())
    const answered = new Set<string>()
    const probing = new Set<string>()

    const answerOf = (directory: string): PillAnswer => answers().get(directory) ?? "unknown"

    // A probe that failed runs again, so a server part that is off
    // (`priorityEnabled: false`) still hides the pill once it answers.
    const retrying = new Set<string>()
    const timers = new Set<ReturnType<typeof setTimeout>>()
    const retry = (key: string, run: () => void) => {
      if (retrying.has(key)) return
      retrying.add(key)
      const timer = setTimeout(() => {
        retrying.delete(key)
        timers.delete(timer)
        if (!ctx.signal.aborted) run()
      }, RETRY_MS)
      timers.add(timer)
    }

    // A subagent session has no priority of its own: the scheduler judges it by
    // its parent's verdict, so a `/prio` typed here would write a flag nothing
    // reads. The host hides pills in a subagent's session already; this keeps
    // the rule here too, for a host that does not.
    const [child, setChild] = createSignal(new Set<string>())

    const probe = (key: string, isChild: boolean) =>
      setChild((current) => {
        if (current.has(key) === isChild) return current
        const next = new Set(current)
        if (isChild) next.add(key)
        else next.delete(key)
        return next
      })

    // A session's level and its parent are read once. A failed read leaves the
    // pill alone — it shows with the ordinary label — and runs again when the
    // server reconnects or the session is mounted again.
    const readDone = new Set<string>()
    const reading = new Set<string>()

    const read = async (session: MountedSession) => {
      const key = session.key
      if (readDone.has(key) || reading.has(key)) return
      reading.add(key)
      try {
        const info = await session.server.client.session.get({ sessionID: session.id })
        // The level lives in metadata; the title is the fallback for sessions
        // marked by an older version.
        remember(key, readState(info?.metadata)?.level ?? levelOf(String(info?.title ?? "")))
        probe(key, Boolean((info as { parentID?: string } | undefined)?.parentID))
        readDone.add(key)
      } catch {
        // The pill still shows; the label stays ordinary until the next read.
      } finally {
        reading.delete(key)
      }
    }

    const check = async (session: MountedSession) => {
      const directory = session.directory
      if (answered.has(directory) || probing.has(directory)) return
      probing.add(directory)
      try {
        // The session's own server, not the plugin's: a session can live on a
        // server other than the one that runs this plugin, and its command list
        // is the one that matters.
        const list = await session.server.client.command.list({ location: { directory } })
        const answer = answerFrom(
          (list?.data ?? []).map((entry) => entry?.name),
          command,
        )
        answered.add(directory)
        setAnswers((current) => {
          if (current.get(directory) === answer) return current
          const next = new Map(current)
          next.set(directory, answer)
          return next
        })
      } catch {
        // An unreachable server hides nothing: the pill stays and the probe
        // runs again.
        retry(`check:${directory}`, () => void check(session))
      } finally {
        probing.delete(directory)
      }
    }

    // The state lives in metadata now; a rename is only a fallback for marks
    // written by an older version. Both events carry enough to update the pill
    // without re-reading the session. A stream that ends with the server (a
    // restart, not a window close) is opened again.
    //
    // The same stream is the inbox's fast path: every event means a row may be
    // stale (a place, a hold, a new title, a row entering or leaving Working),
    // so the list is re-read at once instead of waiting for its 2s poll. The
    // view coalesces the burst, because one queue change rewrites every waiter.
    let refreshInbox: (() => void) | undefined
    const listen = async () => {
      try {
        for await (const event of ctx.client.event.subscribe({
          types: [
            "session.renamed",
            "session.metadata.updated",
            "session.created",
            "session.deleted",
            "session.execution.started",
            "session.execution.succeeded",
            "session.execution.failed",
            "session.execution.interrupted",
            "session.idle",
          ],
          signal: ctx.signal,
        })) {
          refreshInbox?.()
          const type = (event as { type?: string }).type
          // Only these two carry a level; the rest are here for the inbox and
          // must not reset a remembered level.
          if (type !== "session.renamed" && type !== "session.metadata.updated") continue
          const data = event?.data as { sessionID?: string; title?: string; metadata?: unknown } | undefined
          const sessionID = data?.sessionID
          if (!sessionID) continue
          const level =
            type === "session.metadata.updated"
              ? (readState(data?.metadata)?.level ?? "normal")
              : levelOf(String(data?.title ?? ""))
          setState((current) => {
            let touched = false
            const next = new Map(current)
            for (const key of next.keys()) {
              if (!key.endsWith(`\n${sessionID}`)) continue
              if (next.get(key) === level) continue
              next.set(key, level)
              touched = true
            }
            return touched ? next : current
          })
        }
      } catch {
        // The stream closed with the window or the server went away.
      }
      if (ctx.signal.aborted) return
      retry("events", () => void listen())
    }
    void listen()

    const move = (session: MountedSession, from: PriorityLevel) => {
      const next = LEVEL_CYCLE[from]
      remember(session.key, next) // optimistic: the rename confirms or corrects it
      void session.server.client.session.command({ sessionID: session.id, name: command, text: next }).catch(() => {
        remember(session.key, from)
        ctx.toast.show({ title: ctx.t("failed"), variant: "error" })
      })
    }

    // The host re-renders the list on its own schedule, so the view keeps
    // re-applying the order and the badges while the plugin is loaded. The
    // interval is cleared when the window closes or the plugin is reloaded.
    const stopInboxSort = sortInbox
      ? startInboxView({
          // The badge text follows the interface language, and a language switch
          // redraws it on the next tick.
          lang: () => (ctx.locale.locale().toLowerCase().startsWith("ru") ? "ru" : "en"),
          load: async () => {
            const list = await ctx.client.session.list()
            const data = (list?.data ?? []) as Array<{ id?: string; title?: string; metadata?: unknown }>
            return data.map((session) => ({
              id: session.id,
              title: String(session.title ?? ""),
              state: readState(session.metadata),
            }))
          },
          cycle: (row) => {
            // A row carries no session id in the DOM, so the loader's id is the
            // only route back; without it the badge stays read-only.
            if (!row.id) return
            const from = row.state?.level ?? inboxLevel(row.title)
            void ctx.client.session.command({ sessionID: row.id, name: command, text: LEVEL_CYCLE[from] }).catch(() => {
              ctx.toast.show({ title: ctx.t("failed"), variant: "error" })
            })
          },
          // The event stream above is the fast path; the 2s poll stays as the
          // fallback for a stream that is down.
          watch: (refresh) => {
            refreshInbox = refresh
            return () => {
              if (refreshInbox === refresh) refreshInbox = undefined
            }
          },
        })
      : undefined

    ctx.add(ComposerPill, () => ({
      id: "priority",
      show: (input: ComposerPillProps) => {
        if (!enabled) return undefined
        const session = input.session
        // Reading the connection makes the probes run again when the server
        // comes back: the first mount can land before the sidecar answers.
        const connected = session.server.connected
        if (connected) {
          void check(session)
          void read(session)
        }
        const isChild = child().has(session.key)
        if (!pillVisible({ enabled, answer: answerOf(session.directory), child: isChild })) return undefined
        const level = state().get(session.key) ?? "normal"
        return {
          label: ctx.t(level === "high" ? "priority" : level === "low" ? "low" : "ordinary"),
          icon: level === "low" ? "fill-triangle-down" : "arrow-up",
          tone: level === "high" ? "warning" : level === "low" ? "danger" : undefined,
          title: ctx.t("hint"),
          run: () => move(session, level),
        }
      },
    }))

    return () => {
      stopInboxSort?.()
      refreshInbox = undefined
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
    }
  },
})
