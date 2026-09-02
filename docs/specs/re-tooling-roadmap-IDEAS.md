# RE / bug-finding tooling — roadmap of ideas (2026-09-02)

> **Status: IDEAS, not a spec.** This is a general direction for turning hbc2js
> from a decompiler into a fuller reverse-engineering and bug-finding environment.
> It is deliberately shallow. Each tool below needs its own researched spec, with
> feasibility, format, and acceptance tests worked out by a stronger agent before
> anything is built. Treat every recommendation here as a starting hypothesis, not
> a decision. Related: `rename-tool-DESIGN-D-overlay.md` (the naming overlay,
> already specced), `src/deps/` (existing dependency identification).

## 1. The idea
hbc2js already does the hard part — a working Hermes-to-JavaScript decompiler and
signature-based dependency identification. What is missing is the *environment*
around it: cross-references, a project database, taint leads, diffing, and an
LLM-driven analysis loop. The goal is a workflow where an analyst (human or LLM)
can read a bundle, navigate it, and surface likely vulnerabilities, on a binary
they legally obtained, for coordinated disclosure.
The goals are ordered: **truth first** (a faithful decompile and real findings,
never a guess or a decompiler artifact dressed as fact), then **tools that are
efficient to use, with valuable features**. "Efficient" does NOT mean rationing
total tokens — spending tokens to do good work is fine. It means each tool is
cheap to interact with: it returns exactly the scoped context an LLM needs, in a
compact form, so the loop covers more code rather than burning context on
re-parsing, guessing, or reading a whole function to answer one question.

## 2. Organizing principles (carry these into every later spec)
- **The goals are ordered: truth first, then token efficiency — never the
  reverse.** Truth (correctness, a faithful decompile, real findings not
  decompiler artifacts, a plain `rN` over a wrong name) is never traded away.
- **The tools must be efficient to USE — the second goal.** This is NOT about
  rationing total tokens (spending tokens to do good work is fine); it is about
  each tool being cheap to interact with: minimal token/context overhead per
  operation, returning exactly the scoped context the LLM needs in a compact
  form. The win is that the loop covers more code and runs longer before
  exhausting context — not frugality. Pursue it ONLY within truth and without
  dropping valuable features: give the model the right scoped context, never less
  than a correct answer needs. A tool that re-parses per call, or makes the model
  read a whole function to name one register, is inefficient to use; one that
  lowers interaction cost by returning a less-true or less-capable answer fails
  truth, which is worse. Every Stage-2 spec states the token cost of USING it and
  how that is kept low.
- **Binding-id is the addressing substrate.** Everything addresses code through
  the binary-derived `{fn, reg}` ids from the overlay work, so names, xrefs,
  comments, findings, and dynamic hooks all point at the same anchors.
- **The artifact format is the real deliverable.** hbc2js's output contract
  should become a structured artifact — rendered source plus an index of ids,
  xrefs, strings, call graph, and native surface — and the analysis tools consume
  that, never hbc2js internals.
- **Build vs buy is gated by format.** Tools that eat JavaScript, an APK, or a
  library list can be pulled off the shelf. Tools that must address our ids or
  read Hermes must be ours.
- **Keep it in this repo for now, behind that internal seam.** Extract the
  reusable analysis layer into its own project later, only once the format has
  proven itself. Premature separation freezes the wrong interface.

## 3. Tools to BUILD (ours — they touch Hermes or our ids)
Rough priority order; each needs its own spec.
1. **Cross-reference / call-graph index + the artifact format.** The backbone:
   who-calls, string-used-where, global-read-where, keyed to `fnIndex`. Defining
   the artifact format is the central task here — it is the seam everything else
   sits on.
2. **Generalized project store.** The overlay generalized to hold comments, tags
   (source/sink/reviewed/suspicious), bookmarks, and findings on the same ids.
   Our equivalent of a Ghidra project / IDA database.
3. **Naming overlay** — already specced (Design D). Names are one kind of record
   in the project store.
4. **String + secrets indexer.** String-table to use-site xref, plus entropy and
   pattern secret scanning. Cheap, high hit rate, run first on any bundle.
5. **Version / decompile diff.** Keyed to binding ids: new endpoints, removed
   checks, freshly introduced code between app versions. Currently absent.
6. **Frida hook generation.** Static-to-dynamic: emit hooks keyed to `fnIndex` to
   confirm a hypothesis at runtime (own account, in scope only).
7. **Orchestration + verify loop.** The LLM bug-finding driver that consumes all
   the above, reuses the review-then-verify pipeline, and logs findings to the
   store. Include a decompilation-fidelity check so a "bug" is never an artifact.

## 4. Tools to REUSE (off the shelf — they already speak our formats)
- **Semgrep** — JS security rulesets + taint mode, runs on emitted JS as-is.
  Cheapest first win; covers much of pattern-scanning and part of taint.
- **CodeQL** — heavyweight dataflow/taint on JavaScript. Note the commercial
  licence restriction; research before committing.
- **Frida** — the dynamic instrumentation runtime; we generate scripts, never
  rebuild it.
- **OSV / GitHub Advisory database** — match libraries that `src/deps/` already
  identifies against known CVEs. This is the strongest reuse and powers the
  realistic CVE outcome.
- **androguard / apktool** — APK unpacking and manifest analysis (exported
  components, permissions, deep-link schemes). Do not rebuild manifest parsing.

## 5. Considered and set aside
- **Ghidra / IDA / BinDiff.** Built for native machine code and address-based
  databases. Hermes is a JS VM; forcing it in would need a SLEIGH spec, would
  yield worse-than-ours decompilation, and would fight our id model. Their value
  is native decompilation, which we already beat. Not pursued. (Re-examine only
  if a native component ever enters scope.)

## 6. Rough sequencing (not final)
Xrefs + artifact format and the project store first (everything queries them).
Then the string/secrets indexer and the reused scanners (Semgrep, OSV) for quick
value. Then taint and version diffing, the highest-leverage bug finders. Frida
generation and the orchestration loop last, once there is structure to drive.

## 7. What a later, stronger agent should do with this
- Turn each item in §3 into a researched spec (feasibility, format, acceptance
  tests), in the style of the Design docs.
- Pin the **artifact format** down first and concretely — it gates reuse and the
  future project split.
- Validate the reuse choices in §4 hands-on: Semgrep taint depth on decompiled
  JS, CodeQL licensing and extractor fit, OSV matching against `deps/` output.
- Add tools this sketch missed: type/shape recovery, protocol/wire-format
  reconstruction, coverage-guided input generation, and a proper findings/report
  format for disclosure. This list is not exhaustive by design.
