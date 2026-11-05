// ==UserScript==
// @name         opencode: очередь /prio (turn-lock) в веб-UI
// @namespace    https://github.com/imarshev/opencode-turn-lock
// @version      0.2.2
// @description  Пилюля приоритета для opencode-turn-lock в веб-клиенте opencode. Неофициальный хак: веб-хост пока не монтирует GUI-плагины.
// @author       imarshev
// @match        http://*/*
// @match        https://*/*
// @grant        none
// @run-at       document-start
// @noframes
// @updateURL    https://raw.githubusercontent.com/imarshev/opencode-turn-lock/main/userscript/turn-lock-prio.user.js
// @downloadURL  https://raw.githubusercontent.com/imarshev/opencode-turn-lock/main/userscript/turn-lock-prio.user.js
// ==/UserScript==

// Why this exists: the web client ships the GUI-plugin loader but its host object
// has no `platform.plugins` bridge, so a plugin's `gui` half never mounts there
// (see docs/upstream/web-gui-plugins.md). Until that is fixed upstream, this
// script draws the same pill the desktop app gets from ./gui-experimental.
//
// It is deliberately dumb, exactly like the desktop pill: the state is the "⚡"
// prefix of the session title, and the switch is the server-side `/prio`
// command. So it cannot disagree with the session list, and a toggle made on
// the phone shows up here on the next refresh.
//
// Auth: the script never asks for the password. It wraps `fetch` at
// document-start and reuses the `Authorization` header the app itself sends to
// /api/*. Nothing is stored and nothing leaves this origin.
//
// Scope: match patterns cannot wildcard inside a host, so the manifest above is
// deliberately broad (@match http://*/*) and the guard below keeps it inert
// outside local networks. Do not "fix" this by writing @include globs for LAN
// ranges: Tampermonkey converts a trailing `.*` in a glob host into its `.tld`
// marker and then swaps it for a top-level-domain alternation, so
// `@include http://192.168.*/*` matches only hosts like `192.168.com` -- never
// an IP address. That is exactly why 0.2.0 showed "script not running" on a LAN
// origin.

;(() => {
  "use strict"

  // The broad @match above is the only way to reach a LAN IP (see the header),
  // so this guard is the real scope. Outside loopback / RFC1918 / mDNS names
  // the script does nothing at all.
  const hostname = location.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  const local =
    hostname === "localhost" ||
    hostname === "::1" ||
    /^127\./.test(hostname) ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
    /\.(local|lan|home\.arpa)$/.test(hostname)
  if (!local) return

  const MARK = "⚡"
  const ROUTE = /^\/server\/[^/]+\/session\/([^/?#]+)/
  const COMMAND = "prio"
  const RU = (navigator.language || "").toLowerCase().startsWith("ru")

  const T = RU
    ? {
        ordinary: "Очередь: обычная",
        priority: "Очередь: приоритет",
        hint: "Приоритет забирает следующий свободный слот; активная сессия уступит свой на границе своего следующего шага. Работающий вызов не прерывается.",
        failed: "не удалось изменить приоритет",
        missing: "команда /prio не зарегистрирована на сервере",
      }
    : {
        ordinary: "Queue: ordinary",
        priority: "Queue: priority",
        hint: "Priority takes the next free slot; an active session yields its slot at its next step. Nothing running is interrupted.",
        failed: "the priority change failed",
        missing: "the /prio command is not registered on the server",
      }

  // ---------------------------------------------------------------- transport

  let auth = null

  const headerOf = (headers, name) => {
    try {
      if (!headers) return null
      if (typeof Headers !== "undefined" && headers instanceof Headers) return headers.get(name)
      if (Array.isArray(headers)) {
        const hit = headers.find((pair) => Array.isArray(pair) && String(pair[0]).toLowerCase() === name)
        return hit ? String(hit[1]) : null
      }
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === name) return String(headers[key])
      }
    } catch {
      /* ignore */
    }
    return null
  }

  // The app authenticates every /api/* call with Basic auth. Borrow that header
  // instead of asking the user for the password a second time.
  const nativeFetch = window.fetch
  if (typeof nativeFetch === "function") {
    window.fetch = function (input, init) {
      try {
        const url = typeof input === "string" ? input : input && input.url ? input.url : ""
        if (url.includes("/api/")) {
          const found =
            headerOf(init && init.headers, "authorization") ||
            (typeof Request !== "undefined" && input instanceof Request ? input.headers.get("authorization") : null)
          if (found) auth = found
        }
      } catch {
        /* never break the app */
      }
      return nativeFetch.apply(this, arguments)
    }
  }

  const api = (path, init) => {
    const options = Object.assign({ cache: "no-store" }, init || {})
    const headers = Object.assign({}, (init && init.headers) || {})
    if (auth) headers.authorization = auth
    if (options.body !== undefined && !headers["content-type"]) headers["content-type"] = "application/json"
    options.headers = headers
    return fetch(location.origin + path, options)
  }

  const sessionID = () => {
    const hit = ROUTE.exec(location.pathname)
    return hit ? decodeURIComponent(hit[1]) : null
  }

  const readSession = async (id) => {
    const response = await api(`/api/session/${encodeURIComponent(id)}`)
    if (!response.ok) throw new Error(`session ${response.status}`)
    const body = await response.json()
    const info = body && body.data ? body.data : body
    return {
      on: String(info && info.title ? info.title : "").startsWith(MARK),
      directory: info && info.location ? info.location.directory : undefined,
    }
  }

  // The pill hides itself when the server part is off (`priorityEnabled: false`
  // registers no command), the same way the desktop pill does.
  const known = new Map()
  const commandExists = async (directory) => {
    if (!COMMAND) return true
    if (directory && known.has(directory)) return known.get(directory)
    const query = directory ? `?location[directory]=${encodeURIComponent(directory)}` : ""
    const response = await api(`/api/command${query}`)
    if (!response.ok) throw new Error(`command ${response.status}`)
    const body = await response.json()
    const list = (body && body.data) || []
    const found = list.some((entry) => entry && entry.name === COMMAND)
    if (directory) known.set(directory, found)
    return found
  }

  const toggle = async (id, on) => {
    const response = await api(`/api/session/${encodeURIComponent(id)}/command`, {
      method: "POST",
      body: JSON.stringify({ name: COMMAND, text: on ? "off" : "on" }),
    })
    if (!response.ok) throw new Error(`command ${response.status}`)
  }

  // --------------------------------------------------------------------- view

  // The web client draws its own "N shells" chip in a row above the composer
  // (`session-activity-chips`), and it already reserves a slot in that same row
  // for plugin pills (`session-plugin-pills`) -- the place the desktop build
  // puts a ComposerPill. So the pill mounts there and flows with the row
  // instead of floating over it. The fixed position is only a fallback for the
  // case where the slot is gone (markup change).
  const SLOT = '[data-component="session-plugin-pills"]'
  const LANE = '[data-component="session-composer-lane"]'

  let host = null
  let root = null
  let button = null
  let label = null
  let inline = null // true: the host lives in the composer row
  let hidden = false

  const BASE =
    "pointer-events:none;max-width:calc(100vw - 32px);font:13px/1.2 system-ui,-apple-system,'Segoe UI',sans-serif"
  const INLINE_CSS = `${BASE};display:flex;align-items:center;flex:0 0 auto`
  const FIXED_CSS = `${BASE};position:fixed;right:16px;bottom:96px;z-index:2147483000`

  const paint = () => {
    if (!host) return
    host.style.cssText = (inline ? INLINE_CSS : FIXED_CSS) + (hidden ? ";display:none" : "")
    host.toggleAttribute("data-floating", !inline)
  }

  const mount = () => {
    if (host || !document.body) return
    host = document.createElement("div")
    host.setAttribute("data-turn-lock-prio", "")
    root = host.attachShadow({ mode: "open" })
    // Sized and rounded like the client's own chips (32px tall, 8px radius,
    // 13px text, same muted surface) so the row stays visually uniform.
    root.innerHTML = `
      <style>
        button {
          pointer-events:auto;
          display:inline-flex; align-items:center; gap:6px;
          height:32px; max-width:100%;
          box-sizing:border-box;
          padding:0 10px;
          border-radius:8px;
          border:1px solid transparent;
          background: color-mix(in oklab, CanvasText 11%, Canvas);
          color: CanvasText;
          font:inherit; font-size:13px; font-weight:500;
          cursor:pointer;
          opacity:.94;
          transition: opacity .15s, border-color .15s, background .15s;
        }
        :host([data-floating]) button {
          box-shadow: 0 2px 10px color-mix(in oklab, CanvasText 18%, transparent);
        }
        button:hover { opacity:1; border-color: color-mix(in oklab, CanvasText 30%, transparent) }
        button:disabled { cursor:progress; opacity:.6 }
        button[data-on="true"] {
          border-color: color-mix(in oklab, #f5a524 65%, transparent);
          background: color-mix(in oklab, #f5a524 20%, Canvas);
        }
        button[data-state="error"] { border-color:#e5484d; color:#e5484d }
        .mark { font-size:14px; line-height:1 }
      </style>
      <button type="button" data-on="false" title="">
        <span class="mark" aria-hidden="true">↑</span><span class="text"></span>
      </button>`
    button = root.querySelector("button")
    label = root.querySelector(".text")
    button.addEventListener("click", (event) => {
      event.preventDefault()
      event.stopPropagation()
      void onClick()
    })
    paint()
    attach()
  }

  // Re-assert the home of the host: the row is re-created by the client on
  // navigation, and appending once at mount would leave the pill orphaned.
  const attach = () => {
    if (!host) return
    const slot = document.querySelector(SLOT) || document.querySelector(LANE)
    const parent = slot || document.body
    if (!parent) return
    if (host.parentElement !== parent) parent.appendChild(host)
    const want = Boolean(slot)
    if (want !== inline) {
      inline = want
      paint()
    }
    if (!inline) place()
  }

  // Fallback position: the composer is anchored to the bottom and changes
  // height with the window, so a fixed offset ends up on top of it. Anchor the
  // pill just above the composer instead of at a constant height.
  const place = () => {
    if (!host || inline) return
    let top = null
    for (const el of document.querySelectorAll('[contenteditable="true"], textarea')) {
      const rect = el.getBoundingClientRect()
      if (rect.height < 16 || rect.width < 60) continue
      if (top === null || rect.top > top) top = rect.top
    }
    const bottom = top === null ? 96 : Math.max(12, Math.round(innerHeight - top + 10))
    host.style.bottom = `${bottom}px`
  }

  const render = (state) => {
    if (!button) return
    const on = state.on
    button.dataset.on = on ? "true" : "false"
    button.dataset.state = state.error ? "error" : state.missing ? "missing" : "ok"
    button.disabled = Boolean(state.busy)
    button.title = state.error ? T.failed : T.hint
    root.querySelector(".mark").textContent = on ? "⚡" : "↑"
    label.textContent = state.error ? T.failed : on ? T.priority : T.ordinary
  }

  const hide = () => {
    hidden = true
    paint()
  }
  const show = () => {
    hidden = false
    paint()
  }

  // --------------------------------------------------------------------- loop

  const state = { id: null, on: false, busy: false, error: false, missing: false }
  let lastRead = 0
  let reading = false

  const refresh = async (force) => {
    const id = sessionID()
    if (!id) {
      hide()
      return
    }
    mount()
    if (!host) return
    attach()
    show()
    if (reading) return
    if (!force && Date.now() - lastRead < 2000) return
    reading = true
    try {
      const info = await readSession(id)
      state.id = id
      state.on = info.on
      state.error = false
      state.missing = false
      try {
        state.missing = !(await commandExists(info.directory))
      } catch {
        state.missing = false // an unreachable command list hides nothing
      }
      if (state.missing) hide()
      else show()
      render(state)
      lastRead = Date.now()
    } catch {
      // keep the last known state: the server may be restarting
      if (state.id !== id) {
        state.id = id
        state.on = false
        render(state)
      }
    } finally {
      reading = false
    }
  }

  async function onClick() {
    const id = sessionID()
    if (!id || state.busy) return
    const was = state.on
    state.busy = true
    state.on = !was // optimistic: the rename confirms or corrects it
    state.error = false
    render(state)
    try {
      await toggle(id, was)
      await refresh(true)
    } catch {
      state.on = was
      state.error = true
      render(state)
      setTimeout(() => {
        state.error = false
        render(state)
      }, 2500)
    } finally {
      state.busy = false
      render(state)
    }
  }

  const start = () => {
    // No pill off-route: refresh() mounts it only when the URL is a session.
    void refresh(true)
    setInterval(() => {
      // SPA navigation changes the path without a load, so the route is checked
      // every tick; the title is re-read less often.
      const id = sessionID()
      if (id !== state.id) {
        lastRead = 0
        void refresh(true)
        return
      }
      if (document.visibilityState === "visible") void refresh(false)
    }, 1000)
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void refresh(true)
    })
    // The client re-renders the composer row and can drop or replace the node
    // the pill sits in, so its home is re-asserted here; the composer also
    // moves (a growing prompt, a window resize), so the fallback offset is
    // re-measured.
    setInterval(() => {
      attach()
      place()
    }, 5000)
    window.addEventListener("resize", place)
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true })
  } else {
    start()
  }
})()
