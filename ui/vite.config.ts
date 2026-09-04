import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Localhost-only dev server (spec 19 §3 Option A: no auth, bind 127.0.0.1).
// `VITE_API_BASE` points at src/ui-server (default http://127.0.0.1:7331).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { host: "127.0.0.1", port: 5173, strictPort: false },
  build: { outDir: "dist", emptyOutDir: true, sourcemap: true },
});
