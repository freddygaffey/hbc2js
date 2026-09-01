# 2026-09-02 — generator .obf E_UNBOUND_IDENT — Sonnet, lean
Tokens 131k · tool calls 113 · green first try.

Root cause: `emit/function.ts` emits the generator/async resume dispatcher as a `k:"func"` closure that SHARES its parent's register frame; `src/passes/ast.ts` `countUses` treated every closure as a separate frame, so once any rung fired inside the body, `pruneRegisterDecls` deleted a still-live `let r0, r1…`. Fix: `sameFrame: true` marker on that closure; `countUses` is transparent through it. Regression test on 23/26 `.obf` at v94 with all passes. Likely the same cause as the Service NSW whole-file abort (async lowering uses the same opcodes) — verified next.
