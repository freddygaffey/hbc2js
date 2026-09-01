# 2026-09-01 — M5 rung 12 jsx-recover (spec 08) — Fable, general-purpose type
Tokens 341k · tool calls 209 · landed green first try (merged 0f70af0, gate 1564/0) · killed twice by machine sleep, resumed from WIP commits.

- Opt-in `--jsx`: `jsx`/`jsxs`/`jsxDEV` (automatic runtime) and `createElement` (classic) → JSX; printer lowers JSX back to calls for `parses`/`node --check`; default output byte-identical.
- Fixture 59-jsx-runtime-calls (renamed from 58): 10/11 automatic sites + classic site recovered.
- rn-template: 154 element sites, 15 recovered (9.7%, floor 8%). Residue: `bad-type` 82 (type read off a `require()` call result — needs the require result NAMED: D17/closure-naming), `reflect-apply-callee` 25 (call-shape residue), `not-dead` 11, `jsxs-nonarray` 6.
- Spec-vs-reality: bytecode spills every operand into registers (callee/type defined in a preceding labeled block); matcher resolves through registers. Documented in spec §10.
- Follow-ups: name require results; hoist a real liveness walk into the framework; absorb across labeled blocks.
