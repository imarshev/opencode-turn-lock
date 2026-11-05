import { defineConfig } from "vite"
import { gui } from "@opencode/plugin/gui/vite"

// Builds the desktop GUI half: one CJS file at dist/gui-experimental.cjs, with
// every dynamic import inlined and the modules the app provides itself
// (solid-js, effect, @opencode/*) left external. A second copy of those would not
// share the app's instance, and the preset fails the build on them.
export default defineConfig({
  plugins: [gui()],
})
