# Web client ships the GUI-plugin loader but never mounts it: `platform.plugins` is missing

**Repository:** `anomalyco/opencode`
**Affects:** 2.2.5 (desktop app + the web client it serves)
**Labels (suggested):** `bug`, `web`, `plugins`

---

## Summary

A plugin can declare a GUI half (`features.gui`, bundle served by `GET /api/plugin/gui`), and the
web client **contains the whole loader for it** — the shared renderer, the `@opencode/plugin/gui`
runtime and the import map. It never runs, because the web host object is built without a
`plugins` bridge:

```js
// web host, _assets/index-*.js
function Hb(e){return{
  platform:{platform:`web`, draftStore:…, version:e, openExternal(…){…},
            restart:async()=>location.reload(), async notify(…){…}},
  currentServerUrl:Ub()}}
```

The loader is mounted behind that field only:

```js
// wb(): the piece that mounts plugin GUIs
let i = t.plugins, …                        // t = platform
… i && { bridge: i, set: …, reserved: p }   // provider value
… b(g,{ when: r, children: e => b(db,{ get bridge(){return e().bridge}, get onChange(){return e().set } }) })
```

`i` is undefined on the web, so `when: r` is false and `db()` (the loader) is never created. On the
desktop the same renderer code receives `platform.plugins` from the preload/main process and
everything works. So this is not "GUI plugins are desktop-only by design" — it is one missing
object in the web host.

## Environment

| | |
|---|---|
| opencode | `2.2.5` (`opencode --version`) |
| Install channel | `latest` (desktop auto-update, `app-update.yml`) |
| OS | Windows 10.0.26300 (win32 x64) |
| Server | `http://0.0.0.0:28894`, same process serves the API and the web SPA |
| Client | Chrome/Edge tab at `http://<host>:28894/` (also installed as PWA) |
| Plugins | 9 server-only + 1 with a GUI half (`turn-lock`, `features: {server: true, gui: true}`) |

## Steps to reproduce

Use any plugin with a GUI bundle. The one I have at hand is local, but the API shape is public, so
this can be reproduced with a minimal plugin:

1. Register a plugin that reports `features.gui` and serves a GUI bundle.
2. Confirm the server exposes it (this part already works):

   ```
   GET /api/plugin
   → {"location":{…},"data":[{"id":"turn-lock","source":{…},"features":{"server":true,"gui":true},
                              "state":{"status":"active"}}]}

   GET /api/plugin/gui?id=turn-lock
   → {"location":{…},"data":{"code":"\"use strict\";…","revision":"fb6952…","options":{…}}}
   ```

   (`PluginGuiBundle = { code: string; revision: string; options: Record<string, JsonValue> }`.)

3. Open the web client at the same origin, go to a session.
4. Open the desktop app on the same server and repeat.

## Expected

The web client mounts the same GUI bundles the desktop app mounts, the way it already renders
everything else from the shared renderer bundle (composer, sessions, slash commands are identical
in both).

## Actual

Nothing from `features.gui` appears in the web client. No error, no console warning — the mount
condition is simply false, so the plugin host is never instantiated. The desktop app on the same
server shows the plugin's pill above the composer.

## Additional context

### Why I am confident it is only the host object

The web bundle and `app.asar` share the renderer code; the loader exists verbatim in both. What
differs is the object passed to the root provider:

| | desktop (`app.asar` main/preload) | web (`_assets/index-*.js`) |
|---|---|---|
| `platform.platform` | `"desktop"` | `"web"` |
| `platform.plugins` | `{ on, pluginGuis, manager, … }` | **absent** |
| loader `db()` / `fb()` / `ub(id, code)` | present | present (`fb` ≈ `V7t` after minification) |
| `@opencode/plugin/gui` import map | present | present |

The loader needs exactly this interface (read off the shipped code):

```ts
// what db() and cb() consume from platform.plugins
on(cb: (event: { type: "pluginGuis"; plugins: Gui[]; reserved: string[] }
                | { type: "installed"; list: unknown[] }) => void): () => void
pluginGuis(): Promise<{ plugins: Array<{ id: string; revision: string; options: Record<string, unknown>; code: string }>; reserved: string[] }>
manager: { initial: Promise<unknown[]>; list(): Promise<{ id: string }[]> }
```

Those three members are all that is missing.

### The desktop main process already does the work the web host would need

`app.asar`, plugin host:

```js
pluginGuis: Oe,
…
list: G, async enable(id){…}, async disable(id){…}, async reload(id){…}
…
// bundle resolution
const i = await t.plugin.gui({ id: n }).then(e => e.data, …)   // GET /api/plugin/gui?id=…
if (i?.bundle.revision === o.revision) return [n, i]
if (l.get(n) === o.revision) { r.unsupported.add(n); … }       // "reserved"
```

with the same filter on `features.gui` before that. In other words the web host only has to make
the two calls it can already make with the same SDK instance the renderer has
(`client.plugin.list({ location })`, `client.plugin.gui({ location, id })`) and emit the
`pluginGuis` event.

### Minimal wiring sketch

```ts
// Hb(): build the web host
plugins: {
  manager: { initial: Promise.resolve([]), list: async () => [] },
  on() { return () => {} },                       // event source, empty for now
  async pluginGuis() {
    const location = { directory: currentDirectory() };
    const list = (await client.plugin.list({ location })).data;
    const guis = list.filter((p) => p.features.gui && p.state.status === "active" && p.id);
    const bundles = await Promise.all(
      guis.map(async (p) => ({ ...(await client.plugin.gui({ location, id: p.id })).data, id: p.id })),
    );
    // a bundle whose `code` the app cannot load is reported through `reserved`
    return { plugins: bundles.filter((b) => !unsupported(b)), reserved: bundles.filter(unsupported).map((b) => b.id) };
  },
},
```

The `client` instance the creator already has is enough; no new HTTP route, no new auth path. If a
location-scoped list is awkward on the web (it has no "current directory" on `/`), the server
side can return all GUI-enabled plugins for the canonical local server, which is what
`/api/plugin` with no `location` already does.

### Impact

A plugin's GUI half is currently unreachable from the browser and from mobile PWAs. For my plugin
that means the only way to flip a per-session setting from the phone is typing a slash command,
while the same setting is a button in the desktop app. The server API, the protocol types, the
renderer loader and the runtime are all already shipped, so the cost of closing this is one
object in the web host.

### Diagnostics

- opencode `2.2.5`, install channel `latest`
- Windows 10.0.26300, shell `cmd.exe`, `TERM=xterm-256color`
- `GET /api/plugin` → `turn-lock` with `features: {server: true, gui: true}`
- `GET /api/plugin/gui?id=turn-lock` → `code` length 2449, `revision` 64 hex chars
- web assets: `/_assets/index-BDq5uAY5.js` (2.2.5 build), loader symbols `db`, `fb`, `ub`, `wb`, `cb`
