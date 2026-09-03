# 2026-09-03 — P2.4 spec review gate (lean Fable) — APPROVED

46k tokens, 10 tool calls, ~4 min. Commit 1072d17.

- Rulings 1-5: registry-rules runtime-fetch accepted (SHA pin + anti-vendoring tripwire binding); claim-tier no-prefix accepted WITH new repo-wide demotion tripwire on any measured misattribution; Expensify held-out stands; fixture APK committed (.hbc precedent), gate never needs Android tooling; ratchet bars accepted pre-registered.
- R-M fix: lane-M measurability — raw facts diff vs aapt2, effective-exported vs hand-verified expected file (androguard computes Android-12 defaulting; naive diff self-grades).
- Licenses verified hands-on at the gate (semgrep LGPL-2.1, rules NOASSERTION/custom, osv-scanner/androguard/apktool Apache-2.0); T-L re-verification mandatory + lane-blocking.
- Order: steps 0-1 scaffolding, then Lane O (OSV) first, S next, M last.
