# Orchestrator handoff — decisions (Fred, 2026-09-02)

Runs fully autonomous, day and night. **No manual ratification by Fred.** Fred
sets direction rarely; every gate below is an AGENT gate, never a human one.
(Pre-existing safety approvals stay as-is: nothing pushes outside
`github.com/freddygaffey`, no PRs, external publish / golden regen still wait for
Fred — those are irreversible/outward-facing, not routine dev.)

Governing goal order (already in QUEUE/ROADMAP/specs): **truth first**, then
**tools efficient to use** (low token/context cost per operation, NOT token
rationing), without dropping valuable features.

## Model allocation
- **Orchestrator = Fable** — the judgment apex now that Fred is out of the loop
  (and the project's original Fable-overseer design). Keep it CONTEXT-LEAN per the
  standing rule: reads agent reports + short summaries only, never transcripts /
  large docs / source dumps; a Sonnet reviewer returns diff/log verdicts.
- **Spec-writing + the decision-8 target/review gate = Fable** (hard/design +
  review). With no human ratification this gate is the last line of defense for
  truth, so it gets the best model.
- **Implementation = lean Sonnet.**
- **Caveat (own logs):** Fable is a SEPARATE weekly bucket, scarce by mid-week
  (a 60–90 min Fable agent ≈ 250–330k tokens ≈ 5–8% of its week). If that bucket
  is the constraint, drop the orchestrator to Opus. Lean agents (~100k), cap 1–2.

## Decisions

1. **Construct-level fuzzing — MUST, prioritise.** Random JS → compile with
   Hermes → decompile → compare execution traces. Unbounded, oracle-backed
   faithfulness coverage beyond the hand-built fixtures.

2. **App-generation fuzzing — MUST, diverse + combinatorial.** Fuzz app SOURCE
   *and* BUILD config: vary framework, bundler (Metro plain / RAM, Expo),
   router, libraries, Hermes + RN version, obfuscation on/off. Build yields
   `(bundle, map, source)` triples = ground truth for naming/structure accuracy
   (fixes the 1-map / 895-bundle gap). **Do NOT run the full matrix every run —
   rotate a sample each run.** Diversity is the point; reject same-app-N-times.

3. **Corpus = fix ground truth, not count.** Keep the 27-app regression set ~as
   is (do not grow for count). Grow map-bearing apps 1 → ~8–12 via #2. Report a
   pass MATRIX per Hermes-version & bundler, not one aggregate.

4. **Blind held-out set.** Hold out SOME of the generated custom apps AND some of
   the existing apps; never tune against them; measure generalisation on them.

5. **Metrics scoreboard — standing, one row/day** (already queued under `## Now`).
   Trends over snapshots.

6. **Cost/velocity = TOKENS per landed item** (NOT dollars — subscription plan).
   Log token count in the AGENT-LOG line for each landed item, then RANK so an
   outlier ("4x the median") is visible. *Where:* extend the landing convention
   (merge→gate→push→report + AGENT-LOG line) and the AGENT-LOG row format to
   carry a token field.

7. **Scheduled architecture/simplification sweep.** Whole-repo `/simplify` +
   `/code-review` on a cadence (not just the per-PR gate) to counter design-debt
   accretion at ~140 commits/day.

8. **Specs must carry a measurable target — enforced by AGENTS, not Fred.** The
   spec-agent states metric + target number + measurement method + held-out
   check; a reviewer agent (Fable) verifies the spec includes it and the target is sane
   before implementation launches. This replaces the human ratification step.

Optional: spot-check the 25% comment density and 0.79x docs ratio for
rationale-vs-restatement; trim write-only artifacts (e.g. 6-line reports).
