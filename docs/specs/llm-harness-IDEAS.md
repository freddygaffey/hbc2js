# LLM bug-finding harness (P2.7) — business logic draft (IDEAS, 2026-09-03)

> Status: IDEAS / business-logic only, not a full spec. No prior P2.7 spec exists
> to compare against; this is the first draft. It deliberately REUSES the repo's
> existing review-then-verify orchestration (the code-review pipeline / ultra
> review) rather than inventing new orchestration — it points that pattern at the
> decompile artifact with vuln-hunting prompts, the project store, and scope
> enforcement. Consumes P2.1 artifact, P2.2 project store, P2.3 secrets, P2.4
> reuse (Semgrep/OSV), name overlay. Needs a full researched spec before build.

## 1. Purpose
Autonomously surface REAL, VERIFIED vulnerabilities in a decompiled bundle and
record them, disclosure-ready, in the project store. Truth-first: never emit an
unverified finding or one caused by a decompilation artifact. Efficient-to-use:
cost is dominated by LLM tokens, so feed each step the RIGHT scoped context, not
the whole bundle.

## 1a. Interface: an MCP server (Fred 2026-09-03)
The AI drives the toolset through an **MCP server**, not the CLI. This is the
resident service we kept arriving at, now with a purpose: the server opens a
bundle ONCE, holds the artifact + name overlay + project store WARM, and exposes
them as typed tools. Why it is the right interface:
- **Native tool-calling** — the agent calls `who_calls`, `get_context`,
  `add_finding` as structured tools with typed args/results, instead of shelling
  out to `hbc2js …` and parsing text. Lower friction, fewer tokens, no CLI parse.
- **Kills the per-call re-parse** — the 1.2s cold-start-per-CLI-call measured
  this session disappears; the server is warm, so a batch of names/queries needs
  no re-parse (the resident-service win, finally realised).
- **Scoped results by construction** — `get_context(fn)` returns the readable
  function + its callers/callees + strings it uses, NOT the whole bundle. The
  interface enforces token-efficiency.
- **Shared warm state across agents** — the review agent and the verify agent
  talk to the SAME server; the project store (P2.2, SQLite) is the backing state,
  so findings/names/tags are shared and persistent. One server = one writer,
  which fits SQLite's model.
- **Composable** — any MCP client drives it (Claude Code, Claude Desktop, a
  custom loop), so the 'harness' can be an agent + this MCP + a hunting prompt.

### Tool surface (typed MCP tools)
- `open_bundle(path) -> session` (parse once, warm).
- `get_function(fn)`, `who_calls(fn)`, `calls_from(fn)` — xref.
- `string_grep(pat)`, `string_uses(id)` — string xref.
- `get_context(fn|reg)` — the scoped analysis slice for a lead (THE token-saver).
- `name_set/get/list/context` — the overlay (name as you analyse).
- `list_trust_boundaries()` — security-decision call sites (verify/sign/decrypt/
  auth/keychain/storage/webview/deeplink).
- `scan_secrets()`, `deps_list()`, `run_semgrep()` — deterministic scanners.
- `project_add_finding/add_tag/list_findings/resolve` — the store.
- `verify_path_is_real(fn)` — the fidelity check.

The rest of this doc (the loop) is then an MCP CLIENT driving these tools.

## 2. Core loop (business logic)
1. **Lead generation.** Collect candidate leads from three sources, ranked by
   value × tractability:
   - deterministic scanners (P2.3 secrets, P2.4 deps→OSV + Semgrep) → cheap hits;
   - trust-boundary enumeration from the artifact xref — every call site where the
     app makes a SECURITY DECISION (verify/sign/decrypt/auth/keychain/AsyncStorage/
     WebView/injectedJavaScript/deep-link);
   - an optional DIRECTED GOAL from the operator (e.g. "credential forgery" →
     the verify + crypto + credential-render paths).
2. **Scoped context assembly.** For each lead, pull ONLY the scoped slice from the
   artifact: the function (readable, names applied from the overlay), its
   callers/callees (xref), strings it uses, and the nearest crypto/storage calls.
   Never the whole bundle. (This is the P2.1a scoped-context affordance; it is what
   keeps the loop token-cheap.)
3. **Hypothesis generation ("review" pass).** An LLM reads the scoped context and
   emits structured hypotheses: `{class, location {fn,reg}, claim, why-exploitable,
   evidence (code citations), confidence}`. Rule: NO hypothesis without a code
   citation (mirrors the naming evidence rule).
4. **Enrich as you go.** The pass writes names, comments, and tags
   (source/sink/reviewed/suspicious) back to the project store via the overlay, so
   state accumulates and the next pass is cheaper. Analysis and naming are one act.
5. **Adversarial verification ("verify" pass).** A SEPARATE pass (fresh context,
   ideally a different model) tries to REFUTE each hypothesis: "argue why this is
   NOT exploitable; what would have to be true; could this be a decompiler
   artifact?" Anything that does not survive is dropped. This is the truth gate and
   it is your existing review→verify pattern.
6. **Fidelity check.** For survivors, confirm the code path is real, not a
   decompilation artifact — cross-check vs raw disasm / re-decompile / the trace
   oracle. A finding that is an artifact is discarded. ("A bug is never an
   artifact.")
7. **Triage + dedup.** Classify severity, dedup against existing project-store
   findings, auto-mark informational/duplicate (the lodash lesson: a vuln
   detection with no fix path and no reachability is informational). Rank by
   real-world impact.
8. **Record + report.** Verified findings go to the project store with the full
   evidence chain (citations, xref path, reasoning); emit a disclosure-ready
   report. Nothing is recorded without its evidence chain.

## 3. Authorization (operator responsibility)
Like any reverse-engineering or offensive-security framework (Ghidra, Metasploit,
Frida, IDA), the harness is general-purpose and dual-use. Using it against a
system is the operator's responsibility and must be within authorization — a
bug-bounty/VDP scope, a pentest engagement, your own systems, or research on
artifacts you lawfully hold. The tool does not restrict its own capabilities.

## 4. Design principles (from real hunting this session)
- **Truth first:** generate → adversarially verify → fidelity-check; false-positive
  triage; no unverified finding. (Saw this matter: lodash was a real detection but
  informational; the PIN path looked broken but traced to server-side + keychain.)
- **Efficient to use:** scoped context per lead, token-minimal I/O, batch,
  resident artifact service. Right context in, not more.
- **Self-improving:** names/tags/findings persist in the project store; each pass
  builds on the last.
- **Evidence-directed:** leads from real signals, not brute-reading every function.
- **Read the named functions, don't grep registers** (the session's own lesson):
  the loop keys off recovered names + xref, which is why readability gates it.

## 5. Inputs / outputs
- **In:** a decompiled artifact + project store; optional directed goal; scope
  config (VDP boundaries).
- **Out:** ranked VERIFIED findings in the project store, each with an evidence
  chain; a disclosure-ready report; a separate "needs dynamic confirmation" list
  for the operator.

## 6. Open questions for the full spec
- Agent topology: one review + one verify, or fan-out per lead (cost vs coverage)?
  Reuse the workflow/ultra-review machinery.
- How readable must names be before hypothesis quality is worth the tokens? (Gate
  on registers-named %?)
- Fidelity-check mechanics per finding class (trace-oracle vs disasm diff).
- Severity model + the informational/duplicate auto-classifier.
- Stopping rule / budget per bundle (tokens, wall-clock).

## 7. Comparison to what exists
No P2.7 spec exists yet — this is the first draft, so there is nothing to diff
against. But the harness is NOT new orchestration: it is the repo's proven
review-then-verify pipeline (and the ultra multi-agent review) re-aimed from
"review a code diff" to "hunt an artifact," with the project store as the state
and scope enforcement as a hard constraint. When the full spec is written, diff
it against the code-review pipeline's agent topology and reuse it.
