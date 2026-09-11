# Readability layer -- the rewrite gate (spec 28, landing 2)

The readability layer lets a model (or another agent, or you) propose a
**rewrite** of one decompiled function: rename the locals, restate a lowered
state machine as the `for` loop it came from, collapse the temps the compiler
introduced. What makes that safe is not the model. It is this gate.

**The single guarantee.** A rewrite is kept only if
`hbc2js equiv --hbc <bundle.hbc> <rewrite.js>` says the program still behaves
exactly as the bytecode does. Anything else -- a rewrite that does not parse, a
rewrite that changes a result, a rewrite the oracle could not prove either way
-- is discarded, and the faithful decompile is what you keep. The faithful
render is never edited in place; a candidate only ever lives in a temp file for
the length of the oracle run.

## Using it

```
hbc2js readability rewrite <input.hbc> --fn N --code <candidate.js> \
    [--evidence "<why>"] [--out <sidecar.json>] [--out-js <file>] [--fuzz N] [--json]
```

- `--fn N` is the function index the candidate replaces.
- `--code <candidate.js>` holds the candidate: **exactly one**
  `function _fnN(...) { ... }` declaration and nothing else. `_fnN` is the name
  the emitter gives function `N`.
- `--out-js` writes the whole module render with the rewrite spliced in --
  only when the rewrite is accepted.
- `--out` writes the change record (below).
- Exit status: `0` accepted, `1` rejected, `2` usage.

Rejections print the class and leave everything alone:

| verdict | what happened |
| --- | --- |
| `ACCEPTED` | the oracle said PASS; the record is written with its proof |
| `REJECTED_PARSE` | the candidate, or the module with it spliced in, is not valid JavaScript. The oracle never runs |
| `REJECTED_SHAPE` | valid JavaScript, but not a single `function _fnN` declaration, or the faithful function could not be located unambiguously |
| `REJECTED_DIVERGENT` | the oracle proved the behaviour differs |
| `REJECTED_INCONCLUSIVE` | the oracle could not prove anything: no Hermes VM for that bytecode version, no output observed, or coverage too thin. INCONCLUSIVE is never PASS |

## What the oracle actually checks (spec 28 section 9.4, REWRITE row)

Two legs, and the weaker one can only ever lower the verdict.

1. **`module-hbc`** -- the Hermes VM runs the original bytecode, the same VM
   runs the module with your rewrite spliced in, and the printed output is
   compared. This is the guarantee. The rewrite is *restricted to the affected
   function* in the literal sense: the spliced render is byte-identical to the
   faithful one outside that one function's span, so the only thing that can
   move the verdict is the rewrite.
2. **`function-fuzz`** -- when the module's own run observed only a couple of
   output lines (thin trace coverage), the faithful function and the rewritten
   one are also driven differentially over the seeded fuzz corpus (spec 09),
   each as the only global of its own program, and every call must agree. If
   every fuzzed call throws on both sides, nothing was observed and the verdict
   is INCONCLUSIVE -- "both sides broke identically" is not evidence.

Both legs are callable as a library (`src/harness/hbc-equiv.ts`:
`hbcVsJsUnderHermes`, `runFunctionEquiv`), which is what the gate uses; the CLI
is a thin wrapper over the same code.

## What an accepted rewrite is stored as

A `suggested` change record (`RewriteChangeRecord` in
`src/readability/rewrite.ts`), spec 28 section 9.5's transaction shape:

- `who` / `tier` / `ts` -- provenance. A worker writes `tier: "suggested"` and
  never promotes its own work; a human or a reviewer promotes.
- `inputs` / `outputs` -- the bytecode origins the code derives from. An output
  with no origin is an orphan and invalidates the record.
- `equiv` -- the `EquivProof`: verdict, the **verbatim** oracle invocation, and
  the coverage (`inputs` fuzzed, `records` compared) it rests on. Read the
  coverage: a PASS proven over 8 output lines is weaker than one proven over
  8 lines plus 50 fuzzed calls, and the proof says which you have.
- `prior` -- the sha256 of the faithful render it replaced, so a revert is
  exact.

Landing 3 turns these records into rows of the transaction log; until then they
are returned in memory or written to the `--out` JSON sidecar, which is derived
data (rebuildable, never authoritative).

## Writing a candidate a gate will accept

There is no skill file for rewrites yet (docs/PUSHBACK.md P-57 says why); this
is the contract a prompt or a human should follow.

- Emit exactly one `function _fnN(...) { ... }` declaration, same name, same
  parameter count. Nothing before it, nothing after it.
- Change only what makes it readable: local names, loop form, redundant temps,
  obvious re-association. Never change what is printed, thrown, returned, or
  in what order.
- Do not touch property keys, globals, or anything reached by a string --
  those are outside the rename domain (spec 28 section 0a rule 1) and will
  either be refused or diverge.
- Prefer a conservative rewrite where the function is barely exercised. Thin
  coverage means the oracle has less to prove with, and an unprovable rewrite
  is rejected exactly like a wrong one.
- Say why in the evidence field. A rewrite with no stated reason is still
  gated, but a reviewer has nothing to judge its *quality* by, and quality is
  the half the oracle cannot check.
