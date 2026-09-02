# Rename tool — Design C (reconciled A+B, 2026-09-02)

> Reconciliation of **Design A** (mechanical rename primitive, the overseer's reading
> of Fred's request) and **Design B** (LLM naming pipeline). Key finding: A and B are
> not competing designs — they are **two layers**. A is the execution primitive; B's
> value is the orchestration layer that drives it. This spec keeps A as the core and
> folds in B's naming discipline and audit trail. Nothing is built yet.

## 0. Architecture — two layers
- **Layer 1 — `rename` primitive.** Mechanical, scope-correct, single-operation.
  The LLM lives OUTSIDE it. This is Design A, adopted almost wholesale.
- **Layer 2 — naming orchestration.** The LLM loop that *chooses* names and drives
  Layer 1, maintaining an audit ledger. This is Design B's real content, moved on top.

Layers ship as separate components with separate acceptance tests. Layer 1 is usable
on its own; Layer 2 depends on Layer 1.

---

# LAYER 1 — the rename primitive (from Design A)

## 1.1 Purpose
A mechanical, scope-correct variable rename callable many times, cheaply, and safely:
give it a location and a new name, get back valid, consistently-renamed code. It must
never break the code and never rename the wrong binding. It does NOT choose names.

## 1.2 Implementation — delegate, do not hand-roll
Rename correctness is delegated to an existing TypeScript tool. This is the single most
important decision and it corrects Design B (which assumed Babel; the repo has only
`typescript`).
- **Primary: `ts-morph`.** `id.rename(newName)` resolves the binding, updates every real
  reference across files for globals/exports, leaves shadowed same-named bindings alone,
  keeps output valid. We write only the thin locating/output/service layer.
- **Fallback: the bare TS language service** (`getRenameInfo` + `findRenameLocations`),
  since `typescript` is already a dependency. Same scope-correctness, more glue code.

## 1.3 Interface
CLI (thin wrapper, for one-offs and tests):
```
hbc2js rename <file> <line> <oldName> <newName> [--local] [--json] [--dry-run] [--root <dir>] [--verify]
```
Programmatic / resident service (PRIMARY interface for the loop — see §1.7):
```ts
rename({ file, line, oldName, newName, local?, root?, dryRun?, verify? }): RenameResult
```

## 1.4 Scope model
- **Default = whole segregated project.** Extent is computed from the AST binding, not
  declared by the caller. Global/module-exported → every reference across all module
  files. Local → only its scope (no cross-file refs exist). Correctness falls out of
  scope analysis; the caller need not know which case applies.
- **`--local`** = single-file fast path (load one file). Optimisation, never a
  correctness switch.
- **`--root <dir>`** = project root for the whole-project search. Default: auto-detect
  the nearest segregated-tree / package boundary, else the file's directory.
  (Resolves A open-question: auto-detect with explicit override.)

## 1.5 Locating the target (rough line accepted)
Parse `<file>`, collect `Identifier` tokens named `<oldName>`. Exact line → use it.
Rough line → snap to the nearest `<oldName>` occurrence (ties → earliest column), so an
LLM may cite an approximate line. No `<oldName>` near `<line>` → clear error, never
rename a different name. Resolve the chosen occurrence to its binding; all rename
locations derive from the binding.

## 1.6 Output (token-minimal — hard requirement)
Success, one line: `renamed r7 → userInput: 5 refs in 2 files`
`--json`: `{ "old","new","refs","files":[...],"scope":"local"|"module" }`
No diff, no file dumps. `--dry-run` reports counts without writing.
**Every call also appends one record to the rename ledger (§2.3)** — this is the bridge
to Layer 2 and the one addition to Design A's output contract.

## 1.7 Performance
- Fast startup for `--local` (one file, not the tree).
- **Resident service mode is the primary interface for the fuzzing loop** (resolves A
  open-question): a persistent language service, incremental document updates, warm
  program. The suite issues successive `{file,line,old,new}` requests without re-parsing.
- **In-memory documents supported** (resolves A open-question): the suite may hand a
  buffer not yet written to disk; ts-morph / TS-LS both support in-memory source files.

## 1.8 Correctness rules / edge cases
- **Shadowing:** rename only the binding the target reference resolves to.
- **Collision:** if `<newName>` already binds where the rename would capture/be captured,
  **refuse** and change nothing (resolves A open-question: primitive hard-refuses; the
  orchestration layer may retry with a suffixed name — §2.4). No `--force` in v1.
- **`<newName>` not a valid identifier / reserved word →** refuse.
- **Property keys / string-keyed members / dynamic accesses are NEVER renamed** — only
  lexical variable bindings. (Shared by both designs; non-negotiable.)
- **Function names and parameters ARE in scope** (resolves A open-question): same
  ts-morph machinery, and readability needs them. Still lexical bindings only.
- **Cross-module** follows only real binding references (import/export/`require`
  interop), never same-named unrelated globals in other files.
- **Behaviour preservation:** pure alpha-rename. Because correctness is delegated to TS,
  no per-call heavy check is needed. `--verify` re-parses the result (cheap). Heavy
  checks (execute-and-compare, structural isomorphism) run in CI, not the hot path
  (this is where Design B's verification belongs — off the per-call path).

## 1.9 Layer-1 tests
Local rename (in-scope only; same-named var elsewhere untouched); exported/global
(updates every dependent file); shadowed (only intended binding); collision (refused, no
writes); rough line (snaps correctly); `--local` vs default identical for a true local,
default additionally spans files for a true global; function-name and parameter rename;
in-memory buffer rename; output is exactly the one-line / JSON shape.

---

# LAYER 2 — naming orchestration (from Design B)

## 2.1 Purpose
Drive Layer 1 to turn a module of default identifiers into readable, meaningfully-named
code, producing an audit trail fit for security review. The LLM proposes names; Layer 1
applies them; Layer 2 records what happened and how sure it was.

## 2.2 Naming discipline (the prompt enforces)
- **No name without evidence** from the code: assigned-from expression, functions the
  value is passed to, properties accessed on it, nearby literals, API call names.
- **Neutral-descriptive when evidence is weak:** `serverResponse`, not `validatedLicence`,
  unless the code proves validation. Do not inject unproven interpretation.
- **JS conventions:** camelCase locals/functions, PascalCase classes/components,
  UPPER_SNAKE_CASE module constants. Specific but not verbose.
- **Confidence tier + one-line evidence** attached to every proposed name.

## 2.3 The rename ledger (the audit trail — Design B's key addition to A)
An append-only record, fed by every Layer-1 call, one row per rename:
`{ old, new, scope, refs, files, confidence, evidence }`.
Purpose: a security analyst (or a later LLM pass) can see that a variable was named
`isValid` on **low** confidence and trace it back to ground truth. Emit a review report
sorted by confidence ascending, so the shakiest names are reviewed first. A name is a
hypothesis, exactly like a finding.

## 2.4 Confidence policy
Configurable. Default: apply high and medium confidence names; for low confidence, either
keep the original with a `/* suggested: <name> */` comment, or apply with a marker — the
analyst chooses per run. On a Layer-1 collision refusal, the orchestrator MAY retry once
with a suffixed name; it never forces.

## 2.5 Consistency across modules
Handled for free by Layer 1: renaming an exported binding updates all its references
across files, so cross-module consistency is a property of the primitive, not a glossary
the orchestrator must maintain. (This supersedes Design B's weaker "v1 per-module only.")

## 2.6 Layer-2 tests
Evidence rule (no name emitted without a cited reason; mockable LLM); confidence policy
(low-confidence handled per config); ledger completeness + reversibility (every applied
rename recorded; inverse restores originals); malformed-LLM handling (garbage output →
originals kept, no crash, skip reported); determinism harness (LLM mocked via fixtures,
no network); CI-only behaviour check (execute-and-compare on runnable fixtures).

---

## 3. What changed from each source
- **From A, kept:** the whole primitive — ts-morph delegation, scope model, rough-line
  snap, terse output, resident service, collision-refuse, properties-never.
- **From A, resolved open questions:** resident service = primary; collision = refuse
  (orchestrator may suffix); function names + params = in scope; root = auto-detect +
  override; in-memory buffers = yes.
- **From B, kept:** naming discipline, confidence tiers + evidence, the rename ledger /
  audit trail, confidence policy, mocked-LLM determinism.
- **From B, corrected:** implementation is TS/ts-morph, not Babel; heavy behaviour
  verification moves from per-call to CI; cross-module consistency comes from the
  primitive, not a glossary.

## 4. Non-goals (v1)
Renaming object properties, string-keyed members, dynamic accesses. Operating on an
unsplit bundle. Semantic renaming *inside* the primitive (Layer 1 never chooses names).
`--force` collision override. Type inference.
