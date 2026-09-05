// ui/vitest.config.ts — spec 19 §2 layer 2 (Component/DOM tests), added by
// spec 26 L7. Testing Library discipline over jsdom: semantics (roles,
// accessible names, structure), never pixels — that is layer 4
// (ui/e2e/visual.spec.ts), a different runner entirely. `ui/`-only: this
// devDependency never touches the root package's zero-runtime-dependency
// rule, and `npm run test:dom` is not part of the root gate.
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [tailwindcss(), react()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.dom.test.{ts,tsx}"],
    globals: false,
  },
});
