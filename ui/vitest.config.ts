// ui/vitest.config.ts — spec 19 §2 layer 2 (Component/DOM tests), added by
// spec 26 L7. Testing Library discipline over jsdom: semantics (roles,
// accessible names, structure), never pixels — that is layer 4
// (ui/e2e/visual.spec.ts), a different runner entirely. `ui/`-only: this
// devDependency never touches the root package's zero-runtime-dependency
// rule, and `npm run test:dom` is not part of the root gate.
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [tailwindcss(), react()],
  // Same `@ui-core` alias `vite.config.ts` defines (its own comment explains
  // why: the repo-root `src/ui-core/` action registry/keymap, imported
  // directly rather than copied) — missing here meant any `.dom.test.tsx`
  // that pulls in `ui/src/actions/registry.ts` (menu/keymap wiring) failed
  // to resolve, which is what surfaced this (spec 28 landing 4c's
  // WorkersPane.readability.dom.test.tsx is the first dom test to import a
  // pane that uses it).
  resolve: { alias: { "@ui-core": fileURLToPath(new URL("../src/ui-core", import.meta.url)) } },
  test: {
    environment: "jsdom",
    include: ["src/**/*.dom.test.{ts,tsx}"],
    globals: false,
  },
});
