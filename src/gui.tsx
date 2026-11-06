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
// Desktop only, by the host's own design: the web build never mounts a plugin
// GUI bundle (its host is created without the plugin bridge), so the phone keeps
// the slash command. This bundle is `./gui-experimental`, built by
// `npm run build` into `dist/gui-experimental.cjs`; the app loads no second
// chunk, and modules it provides itself (solid-js, effect, @opencode/*) must stay
// out of the bundle — the preset in `vite.config.ts` keeps them external.

import { createSignal } from "solid-js"
import { ComposerPill, Plugin, type ComposerPillProps, type MountedSession } from "@opencode/plugin/gui"

/** The queue levels, in the order one click moves through them. */
type Level = "normal" | "high" | "low"
const CYCLE: Record<Level, Level> = { normal: "high", high: "low", low: "normal" }

/** The marks the server part writes into a title. Ordinary carries none. */
const MARKS: Record<Exclude<Level, "normal">, string> = { high: "⚡", low: "▽" }

/** Which level a title claims — the same reading the session list shows. */
const levelOf = (title: string): Level => (title.startsWith(MARKS.high) ? "high" : title.startsWith(MARKS.low) ? "low" : "normal")

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

    // session key -> level. A plain signal holding a new Map, so every pill
    // re-reads when any session's state changes.
    const [state, setState] = createSignal(new Map<string, Level>())
    const remember = (key: string, level: Level) =>
      setState((current) => {
        if (current.get(key) === level) return current
        const next = new Map(current)
        next.set(key, level)
        return next
      })

    // Directories whose command list contains /prio: the pill has no reason to
    // show when the server part turned priority off, and hiding it is then exact
    // rather than hopeful. `loaded`/`checked` are non-reactive on purpose — they
    // only stop a request from being repeated on every re-render.
    const [ready, setReady] = createSignal(new Set<string>())
    const checked = new Set<string>()
    const loaded = new Set<string>()

    // A subagent session has no priority of its own: the scheduler judges it by
    // its parent's verdict, so a `/prio` typed here would write a flag nothing
    // reads. Such sessions get no pill; the parent session's pill is the only
    // control. `probed` keeps the pill from appearing before the session is
    // classified.
    const [child, setChild] = createSignal(new Set<string>())
    const [probed, setProbed] = createSignal(new Set<string>())

    const probe = (key: string, isChild: boolean) =>
      setChild((current) => {
        if (current.has(key) === isChild) return current
        const next = new Set(current)
        if (isChild) next.add(key)
        else next.delete(key)
        return next
      })

    const read = async (session: MountedSession) => {
      try {
        const info = await ctx.client.session.get({ sessionID: session.id })
        remember(session.key, levelOf(String(info?.title ?? "")))
        probe(session.key, Boolean((info as { parentID?: string } | undefined)?.parentID))
      } catch {
        // keep the last known state: the server may be restarting
      } finally {
        setProbed((current) => (current.has(session.key) ? current : new Set(current).add(session.key)))
      }
    }

    const check = async (session: MountedSession) => {
      try {
        const list = await ctx.client.command.list({ location: { directory: session.directory } })
        const found = (list?.data ?? []).some((entry) => entry?.name === command)
        setReady((current) => {
          if (current.has(session.directory) === found) return current
          const next = new Set(current)
          if (found) next.add(session.directory)
          else next.delete(session.directory)
          return next
        })
      } catch {
        // an unreachable server hides nothing: the last answer stands
      }
    }

    // The title is the state, so follow renames from any client — the phone, the
    // CLI, and this pill's own click.
    void (async () => {
      try {
        for await (const event of ctx.client.event.subscribe({ types: ["session.renamed"], signal: ctx.signal })) {
          const data = event?.data as { sessionID?: string; title?: string } | undefined
          const sessionID = data?.sessionID
          if (!sessionID) continue
          const level = levelOf(String(data?.title ?? ""))
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
        // the stream closed with the window
      }
    })()

    const move = (session: MountedSession, from: Level) => {
      const next = CYCLE[from]
      remember(session.key, next) // optimistic: the rename confirms or corrects it
      void ctx.client.session.command({ sessionID: session.id, name: command, text: next }).catch(() => {
        remember(session.key, from)
        ctx.toast.show({ title: ctx.t("failed"), variant: "error" })
      })
    }

    ctx.add(ComposerPill, () => ({
      id: "priority",
      show: (input: ComposerPillProps) => {
        if (!enabled) return undefined
        const session = input.session
        if (!checked.has(session.directory)) {
          checked.add(session.directory)
          void check(session)
        }
        if (!loaded.has(session.key)) {
          loaded.add(session.key)
          void read(session)
        }
        if (!ready().has(session.directory)) return undefined
        if (!probed().has(session.key)) return undefined
        if (child().has(session.key)) return undefined
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
  },
})
