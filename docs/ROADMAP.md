# hbc2js roadmap — chronological plan (2026-09-02)

Three stages: **1 readable src/**, **2 analysis & tagging environment**, **3 deobfuscation + dead-code**.
Loop: max 2 agents, prefer 1; lean type + model-by-difficulty; corpus regression harness guards every change; deobfuscation + dead-code are strictly last.

| # | Item | Stage | When (rough) | Status |
|---|------|-------|--------------|--------|
| 0 | **Land the 3 in-flight agents** (reg-split, Design-D overlay, corpus harness) — merge, gate, push | 1/2 | now | in flight |
| 1 | **reg-split** — split reused registers so they're nameable | 1 | tonight | in flight |
| 2 | **var-naming compound** — name the split registers (loop→i, arrays, usage/alias/literal heuristics) → the "reads like source" jump | 1 | tonight | queued |
| 3 | **Corpus guard tighten** — kill remaining false-positive screens across the 27 apps (local-max only partly fixed) | 1 | tonight/near | queued |
| 4 | **Non-deobf cleanup rungs** — literal-forms, try-clean, arguments-form, for-in/for-of | 1 | tonight → next day | queued |
| — | *Night target: ~20–22/30 rungs; readable function bodies with named variables* | 1 | — | — |
| 5 | **Rename tool = Design D naming overlay** (binding-id `{fn,reg}`, versioned store, render, gate-routed) — for the LLM fuzzing loop | 2 | in flight → near | building (Opus) |
| 6 | **Artifact format + xref/call-graph index** — the SEAM (who-calls, string→use, global-read, native surface, keyed to fnIndex). Spec first, concretely — gates all of Stage 2 | 2 | next (days) | not started |
| 7 | **Project store** — overlay generalized to comments/tags (source/sink/reviewed/suspicious)/bookmarks/findings | 2 | after #6 | not started |
| 8 | **String + secrets indexer** — string-table→use xref + entropy/pattern scan (cheap, high hit rate) | 2 | after #6 | not started |
| 9 | **Reuse validation (not build)** — Semgrep JS taint on emitted JS; OSV/GHSA match vs `src/deps/` (→ realistic CVE outcome); androguard manifest (exported components/permissions/deep-links); CodeQL licensing check | 2 | parallel w/ #7–8 | not started |
| 10 | **Version / decompile diff** keyed to binding ids (new endpoints, removed checks between app versions) | 2 | after #6–7 | not started |
| 11 | **Frida hook generation** (static→dynamic, keyed to fnIndex; own account/in-scope) | 2 | later | not started |
| 12 | **Orchestration + verify loop** — LLM bug-finding driver over #6–11, review-then-verify, decompilation-fidelity check | 2 | last of Stage 2 | not started |
| 13 | **Deobfuscation** — string-array-decode (`_0x..(i)`→literal) + obfuscation rungs | 3 | after Stage 2 | deferred |
| 14 | **Dead-code = ANNOTATE, not delete** — tag provably-dead in the store; **surface reachable-but-not-from-UI (hidden admin/debug/flagged routes) as FINDINGS** | 3 | after Stage 2 | deferred |

## Scheduling notes
- **Tonight:** single-threaded focus on Stage-1 readability (#1→#4) — the biggest-value, safest work (pure renaming, removes nothing). Realistic: reg-split + var-naming land + a few cleanup rungs (~20–22/30). **Will NOT finish the ladder** — the hard rungs (generators ≥v97, class-recover, closure-naming, finally-dedup) are multi-day and correctness-critical; deobfuscation rungs are Stage 3.
- **Interleave 1 & 2:** Design-D overlay (#5) is already building; the moment reg-split + overlay are in, the artifact-format spec (#6) can start alongside remaining Stage-1 rungs. Some Stage-2 tooling (xrefs, string/secrets, OSV) has more value than the last ladder rungs.
- **Stage 3 strictly last:** deobfuscation and dead-code wait until the analysis/tagging environment (Stage 2) is standing — dead-code handling is itself a project-store annotation.
- **Stage-2 success criteria are ORDERED: truth first, then tools that are efficient to USE (with valuable features):** truth — a faithful decompile and real findings, never a guess or artifact dressed as fact — is never traded away; then efficient to use — NOT rationing total tokens, but each tool cheap to interact with (minimal token/context overhead per operation, exactly the scoped context needed), so the LLM loop covers more code before exhausting context (see QUEUE **P2.1a**). Pursued within truth and without dropping features that find real bugs; a tool that lowers interaction cost by making output less true is a regression, not a win.
- **Guardrails throughout:** corpus regression harness fails CI on a generalization regression; every pass ships a sound checker + trace-oracle 0-DIVERGENT; main stays green (gate-guarded pushes).
- **Risks that shrink this:** usage limits (I stop + preserve), reg-split checker soundness (ships nothing rather than a half-correct split), deb disk at 96%.
