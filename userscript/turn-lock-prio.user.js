// ==UserScript==
// @name         opencode: очередь /prio (turn-lock) в веб-UI
// @namespace    https://github.com/imarshev/opencode-turn-lock
// @version      0.6.0
// @description  Пилюля очереди /prio (три уровня: обычный, приоритет, низкий) и бейджи приоритета/облака/места, времени ожидания и удержания слота для working-сессий в веб-клиенте opencode. Неофициальный хак: веб-хост пока не монтирует GUI-плагины.
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
// It is deliberately dumb, exactly like the desktop pill: the state is the
// `turn-lock` key of `session.metadata` (the server writes `{level, cloud,
// position, total}` there), and the switch is the server-side `/prio` command.
// So it cannot disagree with the scheduler, and a change made on the phone shows
// up here on the next refresh. One click moves one step down the ladder:
// ordinary → `⚡` → `▽` → ordinary. Titles written by an older version still
// read as marks, so nothing has to be migrated by hand.
//
// It also draws the "Working" section of the inbox: rows are ordered with CSS
// `order` (the DOM is not moved: the list is a Solid keyed `For`) and each row
// gets a badge — level icon, cloud, place in the queue and how long it has been
// waiting ("9 мин"), read from `metadata.since` so the label ticks on its own
// between session updates. Set INBOX_UI to false below to turn both off.
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

  // The marks the server part writes into a title; ordinary carries none. One
  // click moves one step down this ladder.
  const MARKS = { high: "⚡", low: "▽" }
  const CYCLE = { normal: "high", high: "low", low: "normal" }
  const levelOf = (title) => {
    const text = String(title || "")
    return text.startsWith(MARKS.high) ? "high" : text.startsWith(MARKS.low) ? "low" : "normal"
  }

  // ------------------------------------------------------------------ inbox
  //
  // The web client renders the "Working" section as a flex column, sorted by
  // `time.busy`, and knows nothing about the queue. The state now lives in
  // `session.metadata` (the server writes `{level, cloud, position, total}`), so
  // this half reads the same `/api/session` list and draws a real badge: an icon
  // for the level, a cloud for a session that is not gated, and the place in the
  // queue. Nothing is moved in the DOM: the order is CSS `order` on the flex row
  // and the badge is one extra node in the row's header line, which Solid does
  // not recreate when the title changes.
  //
  // A row carries no session id in the DOM, so a click is routed by title; two
  // sessions with the same title would share the first match.
  const INBOX_UI = true
  const STATE_KEY = "turn-lock"
  const WORKING = '[data-slot="sidebar-inbox-working"]'
  const INBOX_ROW = '[data-slot="sidebar-inbox-item"]'
  const BADGE = "tl-badge"
  const ICONS = {
    high: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M9.5 1 3 9h3.8L6 15l6.5-8H8.6L9.5 1z"/></svg>',
    low: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3.5 6.5 8 11l4.5-4.5"/></svg>',
    cloud:
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4.6 12a2.9 2.9 0 0 1 .3-5.8 3.9 3.9 0 0 1 7.4 1.2A2.3 2.3 0 0 1 11.7 12z"/></svg>',
    clock:
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="8" cy="8" r="5.6"/><path d="M8 4.9V8l2.2 1.4"/></svg>',
    hold: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="8" cy="8" r="3.6"/></svg>',
  }
  const BADGE_CSS = `
[data-slot="sidebar-inbox-item"] .${BADGE} {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 14px;
  padding: 0 4px;
  margin-inline-start: 2px;
  border-radius: 999px;
  border: 1px solid color-mix(in oklab, currentColor 35%, transparent);
  background: color-mix(in oklab, currentColor 12%, transparent);
  font-size: 9px;
  font-weight: 600;
  line-height: 1;
  letter-spacing: 0.02em;
  flex: 0 0 auto;
  cursor: pointer;
  user-select: none;
}
[data-slot="sidebar-inbox-item"] .${BADGE}[data-level="high"] { color: #f59e0b; }
[data-slot="sidebar-inbox-item"] .${BADGE}[data-level="low"] { color: #94a3b8; }
[data-slot="sidebar-inbox-item"] .${BADGE}[data-cloud="true"] { color: #38bdf8; }
[data-slot="sidebar-inbox-item"] .${BADGE}[data-holding="true"] { border-color: #22c55e; }
[data-slot="sidebar-inbox-item"] .${BADGE} .tl-hold { color: #22c55e; display: inline-flex; align-items: center; gap: 3px; }
[data-slot="sidebar-inbox-item"] .${BADGE}:hover { filter: brightness(1.25); }
[data-slot="sidebar-inbox-item"] .${BADGE} svg { width: 9px; height: 9px; }
[data-slot="sidebar-inbox-item"] .${BADGE} .tl-wait { font-variant-numeric: tabular-nums; white-space: nowrap; }
`

  const positive = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Math.trunc(Number(value)) : undefined)

  // The same shape src/state.ts reads and writes; a malformed value is ordinary.
  const readState = (metadata) => {
    const raw = metadata && typeof metadata === "object" ? metadata[STATE_KEY] : null
    if (!raw || typeof raw !== "object") return undefined
    const state = { level: ["high", "normal", "low"].includes(raw.level) ? raw.level : "normal" }
    if (raw.cloud === true) state.cloud = true
    const position = positive(raw.position)
    const total = positive(raw.total)
    if (position !== undefined && total !== undefined && position <= total) {
      state.position = position
      state.total = total
    }
    if (Number.isFinite(Number(raw.since)) && Number(raw.since) > 0) state.since = Number(raw.since)
    if (Number.isFinite(Number(raw.holding)) && Number(raw.holding) > 0) state.holding = Number(raw.holding)
    return state
  }

  // The fallback for sessions marked by an older version.
  const stateFromTitle = (title) => {
    let text = String(title || "")
    const state = { level: "normal" }
    let found = false
    if (/^☁️ ?/.test(text)) {
      state.cloud = true
      text = text.replace(/^☁️ ?/, "")
      found = true
    }
    if (/^⚡ ?/.test(text)) {
      state.level = "high"
      text = text.replace(/^⚡ ?/, "")
      found = true
    } else if (/^▽ ?/.test(text)) {
      state.level = "low"
      text = text.replace(/^▽ ?/, "")
      found = true
    }
    const wait = /^⏳ (?:(\d+)\/(\d+) · )?/.exec(text)
    if (wait) {
      const position = Number(wait[1])
      const total = Number(wait[2])
      if (position > 0 && total >= position) {
        state.position = position
        state.total = total
      }
      found = true
    }
    return found ? state : undefined
  }

  // Cloud first (it is never gated), then the level, then the place in the
  // queue — running sessions (no place) before the waiters, waiters by number —
  // then the client's own order.
  const rankOf = (state, title, index) => {
    const value = state || stateFromTitle(title) || { level: "normal" }
    return [
      value.cloud ? 0 : 1,
      value.level === "high" ? 0 : value.level === "low" ? 2 : 1,
      value.position !== undefined ? value.position : -1,
      index,
    ]
  }
  const compareRank = (left, right) => {
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) return left[index] - right[index]
    }
    return 0
  }

  // A wait as a badge-sized label ("42 с", "9 мин", "2 ч 5 мин") and as a
  // sentence for the tooltip ("ждёт 9 минут"). The badge is a UI element, so it
  // says the wait in words instead of the old compact `9m` in the title.
  const plural = (n, one, few, many) => {
    const mod10 = n % 10
    const mod100 = n % 100
    if (mod10 === 1 && mod100 !== 11) return one
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few
    return many
  }
  const waitParts = (waitedMs) => {
    const seconds = Math.max(0, Math.floor((Number.isFinite(waitedMs) ? waitedMs : 0) / 1000))
    const minutes = Math.floor(seconds / 60)
    return { seconds, minutes, hours: Math.floor(minutes / 60), rest: minutes % 60 }
  }
  const waitLabel = (waitedMs) => {
    const { seconds, minutes, hours, rest } = waitParts(waitedMs)
    if (seconds < 60) return RU ? `${seconds} с` : `${seconds} s`
    if (minutes < 60) return RU ? `${minutes} мин` : `${minutes} min`
    if (rest === 0) return RU ? `${hours} ч` : `${hours} h`
    return RU ? `${hours} ч ${rest} мин` : `${hours} h ${rest} min`
  }
  const waitSentence = (waitedMs) => {
    const { seconds, minutes, hours, rest } = waitParts(waitedMs)
    if (!RU) {
      if (seconds < 60) return `waiting ${seconds} s`
      if (minutes < 60) return `waiting ${minutes} min`
      return rest === 0 ? `waiting ${hours} h` : `waiting ${hours} h ${rest} min`
    }
    if (seconds < 60) return `ждёт ${seconds} ${plural(seconds, "секунду", "секунды", "секунд")}`
    if (minutes < 60) return `ждёт ${minutes} ${plural(minutes, "минуту", "минуты", "минут")}`
    const head = `ждёт ${hours} ${plural(hours, "час", "часа", "часов")}`
    return rest === 0 ? head : `${head} ${rest} ${plural(rest, "минуту", "минуты", "минут")}`
  }
  const holdSentence = (heldMs) => {
    const { seconds, minutes, hours, rest } = waitParts(heldMs)
    if (!RU) {
      if (seconds < 60) return `holding the slot ${seconds} s`
      if (minutes < 60) return `holding the slot ${minutes} min`
      return rest === 0 ? `holding the slot ${hours} h` : `holding the slot ${hours} h ${rest} min`
    }
    if (seconds < 60) return `держит слот ${seconds} ${plural(seconds, "секунду", "секунды", "секунд")}`
    if (minutes < 60) return `держит слот ${minutes} ${plural(minutes, "минуту", "минуты", "минут")}`
    const head = `держит слот ${hours} ${plural(hours, "час", "часа", "часов")}`
    return rest === 0 ? head : `${head} ${rest} ${plural(rest, "минуту", "минуты", "минут")}`
  }

  const describe = (state, now) => {
    const parts = []
    if (state.cloud) parts.push(RU ? "облачная модель" : "cloud model")
    if (state.level === "high") parts.push(RU ? "высокий приоритет" : "high priority")
    if (state.level === "low") parts.push(RU ? "низкий приоритет" : "low priority")
    if (state.position !== undefined) {
      parts.push(RU ? `${state.position}/${state.total} в очереди` : `${state.position}/${state.total} in queue`)
    }
    if (state.since !== undefined) parts.push(waitSentence(now - state.since))
    if (state.holding !== undefined) parts.push(holdSentence(now - state.holding))
    return parts.join(" · ")
  }

  const hasBadge = (state) =>
    Boolean(
      state &&
        (state.cloud ||
          state.level !== "normal" ||
          state.position !== undefined ||
          state.since !== undefined ||
          state.holding !== undefined),
    )

  const badgeHtml = (state, now) => {
    const icons = `${state.cloud ? ICONS.cloud : ""}${
      state.level === "high" ? ICONS.high : state.level === "low" ? ICONS.low : ""
    }`
    const place = state.position !== undefined ? `<span>${state.position}/${state.total}</span>` : ""
    // The wait ticks on its own: it is computed from `since`, so the server does
    // not have to rewrite anything once a minute.
    const wait = state.since !== undefined ? `${ICONS.clock}<span class="tl-wait">${waitLabel(now - state.since)}</span>` : ""
    // The holder is drawn apart: a filled dot and its own timer.
    const hold =
      state.holding !== undefined
        ? `<span class="tl-hold">${ICONS.hold}<span class="tl-wait">${waitLabel(now - state.holding)}</span></span>`
        : ""
    return `${icons}${place}${wait}${hold}`
  }

  const ensureStyle = () => {
    if (document.querySelector("style[data-turn-lock]")) return
    const style = document.createElement("style")
    style.setAttribute("data-turn-lock", "badge")
    style.textContent = BADGE_CSS
    ;(document.head || document.documentElement).appendChild(style)
  }

  // title -> { id, state }, refreshed from the list the client itself reads.
  // Two seconds is enough: a level change is a metadata write, not a stream.
  const rowsByTitle = new Map()
  let statesAt = 0
  let statesBusy = false
  const loadStates = async () => {
    if (statesBusy) return
    statesBusy = true
    try {
      const response = await api("/api/session")
      if (!response.ok) return
      const body = await response.json()
      const list = (body && body.data) || []
      rowsByTitle.clear()
      for (const session of list) {
        if (!session || typeof session.title !== "string") continue
        rowsByTitle.set(session.title, { id: session.id, state: readState(session.metadata) })
      }
      statesAt = Date.now()
    } catch {
      // keep the last known map; the next tick retries
    } finally {
      statesBusy = false
    }
  }

  const sortInbox = () => {
    if (!INBOX_UI) return
    const section = document.querySelector(WORKING)
    if (!section) return
    const rows = [...section.querySelectorAll(INBOX_ROW)]
    if (!rows.length) return
    ensureStyle()
    const ordered = rows
      .map((row, index) => {
        const title = row.querySelector('span[dir="auto"]')?.textContent || ""
        const entry = rowsByTitle.get(title)
        return { row, title, index, data: entry, state: (entry && entry.state) || stateFromTitle(title) }
      })
      .sort(
        (left, right) =>
          compareRank(rankOf(left.state, left.title, left.index), rankOf(right.state, right.title, right.index)) ||
          left.index - right.index,
      )

    const now = Date.now()
    ordered.forEach((entry, order) => {
      const value = String(order)
      if (entry.row.style.order !== value) entry.row.style.order = value
      let badge = entry.row.querySelector(`.${BADGE}`)
      if (!hasBadge(entry.state)) {
        if (badge) badge.remove()
        return
      }
      if (!badge) {
        badge = document.createElement("span")
        badge.className = BADGE
        const header = entry.row.firstElementChild
        if (header) header.insertBefore(badge, header.lastElementChild)
        else entry.row.appendChild(badge)
      }
      const html = badgeHtml(entry.state, now)
      if (badge.innerHTML !== html) badge.innerHTML = html
      badge.dataset.level = entry.state.level
      badge.dataset.cloud = entry.state.cloud ? "true" : "false"
      badge.dataset.holding = entry.state.holding !== undefined ? "true" : "false"
      badge.title = describe(entry.state, now)
      badge.onclick = (event) => {
        event.preventDefault()
        event.stopPropagation()
        if (!entry.data || !entry.data.id) return
        void setLevel(entry.data.id, CYCLE[entry.state.level] || "normal").catch(() => {})
      }
    })
  }

  const ROUTE = /^\/server\/[^/]+\/session\/([^/?#]+)/
  const COMMAND = "prio"
  const RU = (navigator.language || "").toLowerCase().startsWith("ru")

  const T = RU
    ? {
        ordinary: "Очередь: обычная",
        priority: "Очередь: приоритет",
        low: "Очередь: низкий",
        hint: "Приоритет забирает следующий свободный слот; низкий ждёт за всеми и уступает им. Работающий вызов не прерывается. Один клик: обычная → приоритет → низкий → обычная.",
        failed: "не удалось изменить приоритет",
        missing: "команда /prio не зарегистрирована на сервере",
      }
    : {
        ordinary: "Queue: ordinary",
        priority: "Queue: priority",
        low: "Queue: low",
        hint: "Priority takes the next free slot; low waits behind everyone and yields to them. Nothing running is interrupted. One click: ordinary → priority → low → ordinary.",
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
      level: (readState(info && info.metadata) || {}).level || levelOf(info && info.title),
      directory: info && info.location ? info.location.directory : undefined,
      // A subagent session is judged by its parent's verdict, not its own: a
      // `/prio` there would write a flag the scheduler never reads.
      parent: Boolean(info && info.parentID),
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

  // The command takes the level by name (`on`/`off` still work server-side, but
  // three states are clearer asked for explicitly).
  const setLevel = async (id, level) => {
    const response = await api(`/api/session/${encodeURIComponent(id)}/command`, {
      method: "POST",
      body: JSON.stringify({ name: COMMAND, text: level }),
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
  const INLINE_CSS = `${BASE};display:flex;align-items:center;flex:0 1 auto;min-width:0`
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
          height:32px; max-width:100%; min-width:0;
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
        button[data-level="high"] {
          border-color: color-mix(in oklab, #f5a524 65%, transparent);
          background: color-mix(in oklab, #f5a524 20%, Canvas);
        }
        // Low is deliberately the least loud of the three: same shape, grey.
        button[data-level="low"] {
          border-color: color-mix(in oklab, #8b8b93 55%, transparent);
          background: color-mix(in oklab, #8b8b93 16%, Canvas);
          opacity: 0.8;
        }
        button[data-state="error"] { border-color:#e5484d; color:#e5484d }
        .mark { font-size:14px; line-height:1; flex:0 0 auto }
        .text { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
      </style>
      <button type="button" data-level="normal" title="">
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
    button.dataset.level = state.level
    button.dataset.state = state.error ? "error" : state.missing ? "missing" : "ok"
    button.disabled = Boolean(state.busy)
    button.title = state.error ? T.failed : T.hint
    root.querySelector(".mark").textContent =
      state.level === "high" ? MARKS.high : state.level === "low" ? MARKS.low : "↑"
    label.textContent = state.error
      ? T.failed
      : state.level === "high"
        ? T.priority
        : state.level === "low"
          ? T.low
          : T.ordinary
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

  const state = { id: null, level: "normal", busy: false, error: false, missing: false, parent: false }
  let lastRead = 0
  let reading = false

  const refresh = async (force) => {
    const id = sessionID()
    if (!id) {
      hide()
      return
    }
    if (reading) return
    if (!force && Date.now() - lastRead < 2000) return
    reading = true
    try {
      const info = await readSession(id)
      state.id = id
      state.level = info.level
      state.parent = info.parent
      state.error = false
      state.missing = false
      try {
        state.missing = !(await commandExists(info.directory))
      } catch {
        state.missing = false // an unreachable command list hides nothing
      }
      // Subagent sessions inherit the parent's verdict, so there is nothing to
      // switch here; the parent session's pill is the only control.
      if (state.parent || state.missing) {
        hide()
      } else {
        mount()
        attach()
        show()
      }
      render(state)
      lastRead = Date.now()
    } catch {
      // keep the last known state: the server may be restarting
      if (state.id !== id) {
        state.id = id
        state.level = "normal"
        state.parent = false
        render(state)
      }
    } finally {
      reading = false
    }
  }

  async function onClick() {
    const id = sessionID()
    if (!id || state.busy) return
    const was = state.level
    const next = CYCLE[was]
    state.busy = true
    state.level = next // optimistic: the rename confirms or corrects it
    state.error = false
    render(state)
    try {
      await setLevel(id, next)
      await refresh(true)
    } catch {
      state.level = was
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
    // The inbox is on the home route, not on a session route, so the view is a
    // separate tick rather than part of refresh(). The state comes from the
    // session list, refreshed at most every two seconds while the section is up.
    if (INBOX_UI) {
      void loadStates().then(() => sortInbox())
      sortInbox()
    }
    setInterval(() => {
      if (document.visibilityState === "visible") {
        if (INBOX_UI && Date.now() - statesAt > 2000 && document.querySelector(WORKING)) {
          void loadStates().then(() => sortInbox())
        }
        sortInbox()
      }
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
      if (document.visibilityState === "visible") {
        if (INBOX_UI) void loadStates().then(() => sortInbox())
        sortInbox()
        void refresh(true)
      }
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
