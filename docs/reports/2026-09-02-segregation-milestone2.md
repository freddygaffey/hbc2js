# 2026-09-02 — segregation milestone 2 (naming) — Sonnet, lean
Tokens 127k · tool calls 79 · green first try.

`segregate.ts` names src/ modules via spec §2.1 steps 1–5 (entry→index.js; registerComponent→App.js; displayName; default export; createSlice→store/xSlice.js; conf 0.6; id-ordered collisions). Loader switched from filename-regex to a static id→path map so free-form names resolve. rn-template: module 0 → src/App.js (app-registration wins over entry when both fire on one module — documented deviation); 1/72 (1.4%) named — expected, the template has no screens/store; steps 3–5 proven on a synthetic tree. Boot still reaches registerComponent. Milestone 3 = screens/navigators (needs router-heavy fixture).
