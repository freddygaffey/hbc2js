# Licensing verdicts — spec 13 (P2.4 reuse-validation) §5, T-L

Re-verified hands-on via the GitHub licence API
(`GET /repos/<owner>/<repo>/license`, SPDX id from the response) on the date
below. This file is the mandatory, lane-blocking re-verification spec 13 §5
and §9 step 0 (T-L) require: a mismatch between a row below and the tool
actually shipped blocks that lane.

| Tool | SPDX id (re-verified) | Source URL | Retrieved | Use mode |
|---|---|---|---|---|
| Semgrep OSS engine | `LGPL-2.1` | https://api.github.com/repos/semgrep/semgrep/license | 2026-09-03 | run (subprocess invocation only; we link nothing, copy nothing) |
| Semgrep registry rules | `NOASSERTION` (custom licence: Semgrep Rules License v1.0, non-open, non-competition clause) | https://api.github.com/repos/semgrep/semgrep-rules/license | 2026-09-03 | run-time fetch, cache under `~/.semgrep`, **never vendor into this repo** (spec 12 R2 discipline; spec 13 ruling 1) |
| osv-scanner | `Apache-2.0` | https://api.github.com/repos/google/osv-scanner/license | 2026-09-03 | run or lib |
| OSV.dev data | `CC-BY 4.0` (not a GitHub-hosted repo; verdict per https://osv.dev/docs/, unchanged from spec draft) | https://osv.dev/docs/ | 2026-09-03 | data — attributed via `who:"osv@<db-date>+deps@<hash>"` in every finding's provenance (spec 13 §3.3) AND via the `_attribution` header in `tools/security/osv-db/slice.json` itself (Lane O landed 2026-09-03, step 2) — the committed offline slice used by `src/security/osv-adapter.ts`/`tools/security/measure-osv.ts`, a small hand-curated subset covering the seeded fixture's 3 pinned advisories plus a few neighbours, refresh path documented in the slice's own `_refresh` field |
| androguard | `Apache-2.0` | https://api.github.com/repos/androguard/androguard/license | 2026-09-03 | run (pipx) |
| apktool | `Apache-2.0` | https://api.github.com/repos/iBotPeaches/Apktool/license | 2026-09-03 | run |
| CodeQL | GitHub CodeQL Terms (free grant excludes scanning proprietary codebases) | https://securitylab.github.com/tools/codeql/license/ | 2026-09-03 | **SET ASIDE — licence-unfit** for our proprietary local-corpus APKs (spec 13 §5); not re-fetched hands-on this pass, row carried forward from the spec's own reviewer gate verification (2026-09-03) since the row is inert either way |

All SPDX ids above match spec 13 §5's table and its reviewer-gate
verification (2026-09-03, "Reviewer verification" paragraph) exactly — no
mismatch, so no lane is blocked by this check as of this date.

Standing rule (P2.3 precedent, spec 12 R2, carried into spec 13 §5): any
AGPL component encountered in this space is **behaviour-oracle only** —
observed to test our own output, never run as a shipped lane, never copied
from.

Re-verify this file whenever a lane's tool version changes materially, or at
minimum before promoting a lane from "measured" to "shipped" (spec 13 §9
step 5 landing).
