# 2026-09-02 — segregation spec — Sonnet, lean
Tokens 73k · tool calls 38 · green (design only).

`docs/specs/08-segregation.md` (standalone post-split tool, not a pass). Naming (first-hit, conf 0.6, id-ordered collisions): entry→index.js; registerComponent name→App.js; displayName/default export→name; createSlice→store/xSlice.js; navigator route→screens/XScreen.js; else module_<id>.js (id + classify signal kept in header). Signals w/ confidence: navigator (createXNavigator via deps, 0.9/0.6), screen (route-config walk, 0.85/0.5), store (createSlice 0.9, zustand 0.4), component-vs-util (jsx-recover 0.9). Correctness: byte-diff untouched bodies + re-run boot-split.mjs. Milestone 1: node_modules/ vs src/ by classify.ts only, no naming — implementable now.
