import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, type Plugin } from "vite"

const BASE = "/jobs/"

// The dev server expands %BASE_URL% to `/jobs/` and then prepends `base` to the
// result, so every icon and the manifest resolve to `/jobs/jobs/...`. Those URLs
// hit the SPA fallback and return index.html, which is why the tab showed the
// generic globe and the console logged "Manifest: Line: 1, column: 1, Syntax
// error" — the browser was parsing HTML as JSON. The build expands the token
// exactly once and is unaffected, so this collapse only runs in dev.
function dedupeDevBase(): Plugin {
  return {
    name: "dedupe-dev-base",
    apply: "serve",
    transformIndexHtml: {
      order: "post",
      handler: (html) => html.replaceAll(`${BASE}${BASE.slice(1)}`, BASE),
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  base: BASE,
  plugins: [react(), tailwindcss(), dedupeDevBase()],
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    // The API sets a SameSite=Lax cookie and sends no CORS headers, so it must look same-origin.
    proxy: { "/api": "http://localhost:3010" },
  },
})
