# 2026-09-02 — OSS ground-truth benchmark — Sonnet, lean
Tokens 109k · tool calls 74 · green.

`tools/e2e/oss-benchmark.mjs` — north-star scorecard: decompile→split→deps→segregate, scored vs the app's source map. react-navigation-example (1782 modules): naming mean fuzzy 0.658 / 8.6% >=0.8; classification precision 52.2% / recall 6.1% (honest: no reliable module-id↔source alignment, documented); structure src/screens created; readability rN/1k=1299, Reflect.apply/1k=28. Baseline + sweep ratchet (fuzzy mean + precision may only rise). Fixed 2 bugs: pnpm .pnpm store dir in package extraction (take LAST node_modules/), and name-accuracy.mjs missing import.meta.url guard. Follow-up: add clonable Expo apps (needs network/deb).
