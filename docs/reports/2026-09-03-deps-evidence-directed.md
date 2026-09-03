# 2026-09-03 — deps speedup (a): evidence-directed matching (lean Sonnet)

175k tokens (over ~120k budget — outlier rank), 116 calls, ~27 min. Commits 377abff, 6531e3e.

- Aho-Corasick candidate derivation from the bundle's OWN strings (O(patterns+text)); loadSignatures candidate-filtered; default = evidence-directed, --exhaustive = byte-identical old path.
- Correctness bar MET: 0 attribution divergences default-vs-exhaustive on rn-template; react-navigation 9/9 known deps still confirmed. Baseline 902->948 (+46 tests).
- Speed: ~27x at bulk-DB scale (32,708 synthetic files vs real NSW inventory: 4.37s -> 0.16s). HONEST caveat: real bulk DB unreachable (deb gone) — synthetic-content extrapolation, not a reproduction of the >159s.
- Gate: targeted 118/118 + tsc clean; full-run's 2 fails (parse/fuzz, pipeline-speed CPU-ratio) verified green in isolation by orchestrator — campaign contention.
- Parts (b) pool + (c) sha256 cache: held per hold mode.
