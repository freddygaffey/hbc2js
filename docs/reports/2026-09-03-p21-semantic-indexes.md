# 2026-09-03 — P2.1 semantic indexes (lean Sonnet)

231k tokens (BIGGEST outlier of the day — justified: operand-layout research + 2 real dataflow bugs found by real-bundle spot-checks), 151 tool calls, ~40 min. Commit f07dc98.

- src/artifact/{semantic-walk,strings,native,host-globals}.ts: calls/globals/string-uses at OPCODE level (post-lowering, AST prints ambiguous shapes identically — sound-signal argument), strings.json w/ >4KB head+hash truncation, native + curated host-globals + >=3-fn auto-surfacing (A10).
- rn-template: 15,546 call edges (302 closure / 280 global / 2,535 require / 685 construct); 12,188 ? edges (computed-callee 11,377, deep-global-member 811 — honestly unprovable by local dataflow); strings 5,265; uses 25,482; globals 1,805; native 1,364. 50/50 sampled require edges match SplitResult deps.
- 2 real bugs fixed: operand .role/.type mixup disabling the unhandled-instruction safety net; LoadParam missing from the walk (fixing one without the other collapsed require detection to 2/1789 — caught by spot-checks, not tests).
- Deferred honestly: bridge-module native surface (needs deps/classify wiring; 0 rows + BUGS row, never guessed). measure.ts = next step.
- Gate: 1775/1775, 0 fail (harness agent's WIP present and green in tree).
