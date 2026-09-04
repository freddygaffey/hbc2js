import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Localhost-only dev server (spec 19 §3 Option A: no auth, bind 127.0.0.1).
// `VITE_API_BASE` points at src/ui-server (default http://127.0.0.1:7331).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // `@ui-core` is the repo-root `src/ui-core/` (action registry, keymap,
  // presets): spec 22 §3.1's single source for menu, palette and keymap.
  // It is pure TypeScript with no dependencies, so the ui/ package imports
  // it directly rather than keeping a second copy (see ui/tsconfig.json's
  // matching `paths` entry).
  resolve: { alias: { "@ui-core": fileURLToPath(new URL("../src/ui-core", import.meta.url)) } },
  server: { host: "127.0.0.1", port: 5173, strictPort: false },
  build: { outDir: "dist", emptyOutDir: true, sourcemap: true },
});
