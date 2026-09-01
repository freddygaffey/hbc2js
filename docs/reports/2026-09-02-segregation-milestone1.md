# 2026-09-02 — segregation milestone 1 (node_modules/ vs src/) — Sonnet, lean
Tokens 112k · tool calls 75 · green first try.

`hbc2js segregate <split-dir> [outDir] --deps-report <f>`: places each module into node_modules/<pkg>/ (deps-attributed), node_modules/_vendor/ (anon library), src/ (app per classify.ts), or _unclassified/ (no verdict — never guessed). Rewrites the __d/__r loader require specifiers; bodies byte-identical (gate-tested on all 435). rn-template-0.72: 308/435 (70.8%) node_modules (303 react-native + 5 _vendor), 72 (16.6%) src/, 55 (12.6%) _unclassified. Boot still reaches AppRegistry.registerComponent("HelloHermes072") on the segregated tree. Milestone 2 = naming.
