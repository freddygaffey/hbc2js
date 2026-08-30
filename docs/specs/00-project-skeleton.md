# Spec 00 — Project skeleton

**Milestone:** M0.5 (prerequisite for M1)
**Status:** ready to implement
**Owner model:** Sonnet (per `docs/DECISIONS.md` D5)
**Prerequisites:** none
**Consumers:** every later spec

This spec defines the TypeScript/Node project that specs 01 (parser) and 02
(disassembler) are implemented inside. It is deliberately prescriptive: an
implementation agent should be able to create every file below without making
design decisions of its own.

> **Concurrency notice.** `tests/fixtures/**` and `tools/equiv/**` are being
> authored by other agents right now. **Do not create, edit or delete anything
> under those two paths.** Nothing in this spec, 01 or 02 may depend on
> `tools/equiv/**`; the M1/M2 test-support layer lives in `tests/support/`.
> When staging a commit, name files explicitly — never `git add -A`.

---

## 1. Baseline decisions

| Decision | Value | Source |
|---|---|---|
| Language | TypeScript, strict | D1 |
| Runtime | Node ≥ 22.18.0 | D1, native type-stripping is on by default from 22.18 / 24 |
| Module system | ESM only (`"type": "module"`) | `docs/AGENT-WORKFLOW.md` |
| Test runner | `node --test` | `docs/AGENT-WORKFLOW.md` |
| Runtime dependencies | **zero** | see §3.1 |
| Build | `tsc` (for `dist/` + `.d.ts`); tests run straight off `.ts` | §3, §4 |
| Platforms | macOS (arm64 + x86_64) and Linux x86_64 | `CLAUDE.md` |

**Tests do not need a build step.** Node strips the types and runs `.ts`
directly. `tsc` exists to *typecheck* (stripping does not) and to emit `dist/`
for the CLI. This is why `erasableSyntaxOnly` is mandatory in §4 — it makes the
two paths agree by construction.

---

## 2. Repository layout

```
package.json
tsconfig.json                 typecheck config (src + tests + tools)
tsconfig.build.json           emit config (src only)  -> dist/
.github/workflows/ci.yml
src/
  index.ts                    public API barrel (parse, disassemble, version info)
  cli.ts                      #!/usr/bin/env node — arg parsing, exit codes, IO
  errors.ts                   Hbc2jsError hierarchy, ErrorCode, Diagnostic
  version.ts                  package version constant (generated at build? no — literal)
  util/
    reader.ts                 BinaryReader: bounds-checked cursor over Uint8Array
    bits.ts                   bitfield extraction from little-endian words
    text.ts                   ASCII/UTF-16LE decode, JS string escaping
    fmt.ts                    hex/offset formatting used by CLI + disassembler
  tables/
    types.ts                  OperandType, OpcodeDef, OpcodeTable, BuiltinTable
    registry.ts               table id -> table, selection helpers, startup asserts
    generated/
      opcodes-<tableId>.ts    GENERATED — do not hand-edit
      builtins-<tableId>.ts   GENERATED — do not hand-edit
      PROVENANCE.md           GENERATED — commit SHAs + file hashes
  parse/                      spec 01
    layout.ts  header.ts  sections.ts  strings.ts  functions.ts
    exceptions.ts  buffers.ts  bigint.ts  regexp.ts  cjs.ts  debug.ts  module.ts
  disasm/                     spec 02
    decode.ts  labels.ts  switchtable.ts  print.ts
  cfg/                        M4 — empty until spec 03
  structure/                  M4 — empty until spec 04
  emit/                       M4 — empty until spec 05
  passes/                     M4+ — one directory per recovery pass (D11/D12)
    registry.ts               ordered pass list; the only place a pass is enabled
    types.ts                  Match, PassContext, Pass interfaces
    <name>/match.ts           pure `match(node, ctx) => Match | null`, never mutates
    <name>/rewrite.ts         `rewrite(match) => node`, emits idiomatic JS
    <name>/check.ts           `check(before, after)` local control-flow guard
  harness/                    M3 — promoted from tools/equiv/ (D15); spec 06 owns it
docs/
  LOWERING-CATALOGUE.md       created empty (headers only) by this spec; one row
                              per Hermes lowering idiom, grown by M4+ (D12)
tools/
  get-hermesc.sh              EXISTS — do not modify (fetches v84/v94/v98/v99)
  build-hermes-vm.sh          EXISTS — do not modify (D14 VM oracle)
  equiv/                      EXISTS, another agent's — do not modify; promoted
                              into src/harness/ by spec 06 (D15)
  gen-tables/                 spec 01 §5: opcode/builtin table generator
    vendor.sh                 fetch + pin BytecodeList.def etc. from facebook/hermes
    gen.ts                    parse the .def files, emit src/tables/generated/*
third_party/hermes/<tableId>/ vendored MIT .def/.h files + LICENSE (committed)
tests/
  support/
    fixtures.ts               fixture discovery (reads tests/fixtures/, never writes)
    hermesc.ts                locate tools/hermesc/vNN/hermesc; skip helpers
    hermesvm.ts               locate a Hermes VM per D14; skip helpers
    oracles.ts                locate hbc-file-parser / hbc-disassembler; skip helpers
    golden.ts                 deterministic JSON snapshot read/write/compare
    bytes.ts                  read a fixture .hbc as Uint8Array
    tiers.ts                  gate/sweep tier selection from env (D13)
  gate/**/*.test.ts           D13 gate tier — every commit, seconds
  sweep/**/*.test.ts          D13 sweep tier — nightly/on demand, minutes
  golden/**                   committed snapshot data (spec 01 §8 T5, spec 02 §7.D)
  fixtures/                   OWNED BY ANOTHER AGENT — read only
```

### 2.1 Test tiers (D13, D16)

Tests are filed by **cost tier**, not by subject, because that is what CI splits
on. Within a tier, mirror the source layout (`tests/gate/parse/…`,
`tests/gate/disasm/…`).

| Tier | Directory | Runs | Contents |
|---|---|---|---|
| **gate** | `tests/gate/**` | every commit, target < 60 s | unit tests; `constructs/**` and `hermes-dec-sample/**` through parser/disassembler goldens and (from M3) the equivalence checker; `constructs/*/source.min.js` variants (C2) |
| **sweep** | `tests/sweep/**` | nightly + `--sweep`, minutes | `bundles/**` (C3) and their hardened builds (C4); obfuscated construct variants (C2-obf); harvested Hermes lit tests, test262/quickjs subsets; D3 recompile round-trip at bundle scale |
| **local-corpus** | `tests/sweep/local-corpus/**` | sweep, **skipped as INCONCLUSIVE when absent** | C5 proprietary APK bundles under the gitignored `tests/fixtures/local-corpus/`. Never commit the bundles or anything derived from them; only `MANIFEST.json` (hashes) is committed. |

Tier selection is by env var, read once in `tests/support/tiers.ts`:
`HBC2JS_TIER=gate` (default) | `sweep` | `all`. A sweep test file starts with a
`tiers.requireSweep(t)` guard so a bare `npm test` never spends minutes.

**A missing oracle is never a pass.** Per D15, INCONCLUSIVE is its own verdict:
a skipped test must report the reason, and `HBC2JS_REQUIRE_ORACLES=1` (set in
CI) turns "oracle missing" skips into failures.

**Oracle precedence for behavioural tests (D14).** The reference trace is the
**Hermes VM running the original `.hbc`**, not Node running `source.js` —
Hermes diverges from spec/Node on per-iteration `let`, TDZ with shadowing, and
sloppy `arguments` aliasing at every version tested. `expected.txt` (captured
under Node) is the reference **only** when no VM exists for that version and the
fixture is not in the known-divergence set. `tests/support/hermesvm.ts` locates
a VM (`tools/hermesc/v84/hermes`, or a build produced by
`tools/build-hermes-vm.sh`) and reports INCONCLUSIVE when it cannot. M1/M2 do not
execute anything, so this matters from M3 on — it is specified here because
`tests/support/` is built now.

`src/cfg`, `src/structure`, `src/emit` are created as empty directories with a
`.gitkeep` — do not stub types into them; the M4 specs own their interfaces.

`src/passes/` and `src/harness/` are different: their *shape* is fixed by D11–D16
and is recorded here so that M1/M2 scaffolding does not have to be moved later.

* **`src/passes/` (D11, D12).** Every recovery pass is a directory exporting
  exactly three pure modules — `match.ts` (recognises one Hermes lowering idiom,
  returns a `Match` or `null`, never mutates), `rewrite.ts` (emits idiomatic JS
  for exactly the captured shape), `check.ts` (asserts the rewritten subtree
  preserves control-flow entry/exit edges; on failure the pass is abandoned *for
  that site* and the correct-but-ugly form survives). `registry.ts` holds the
  ordered list and is the only place a pass is switched on — passes are
  individually toggleable, and pass order follows fixture numbering unless a
  dependency forces otherwise. Every pass has exactly one row in
  **`docs/LOWERING-CATALOGUE.md`** (idiom, matcher, writer, the fixture that
  exercises it); adding a construct is one catalogue row + one fixture + one pass
  directory. That catalogue is a first-class repo artefact, created empty by
  this spec with its column headers, and grown by M4+.
* **`src/harness/` (D15).** Not written from scratch: `tools/equiv/` is the
  reference implementation of the three-valued equivalence checker
  (PASS/DIVERGENT/INCONCLUSIVE over the `node --check` → trace → differential-fuzz
  → recompile-round-trip ladder) and is **promoted** into `src/harness/` by spec
  06. M1/M2 must not import from `tools/equiv/` and must not pre-empt its
  interfaces; see `docs/EQUIVALENCE.md`.

---

## 3. `package.json`

```json
{
  "name": "hbc2js",
  "version": "0.1.0",
  "private": true,
  "description": "Hermes bytecode (HBC) -> runnable JavaScript decompiler",
  "license": "MIT",
  "type": "module",
  "engines": { "node": ">=22.18.0" },
  "bin": { "hbc2js": "./dist/cli.js" },
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.build.json && node -e \"require('fs').chmodSync('dist/cli.js', 0o755)\"",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "node --test \"tests/gate/**/*.test.ts\"",
    "test:gate": "node --test \"tests/gate/**/*.test.ts\"",
    "test:sweep": "HBC2JS_TIER=sweep node --test \"tests/sweep/**/*.test.ts\"",
    "test:all": "HBC2JS_TIER=all node --test \"tests/gate/**/*.test.ts\" \"tests/sweep/**/*.test.ts\"",
    "gen:tables": "node tools/gen-tables/gen.ts",
    "gen:tables:check": "node tools/gen-tables/gen.ts --check",
    "fixtures": "tests/fixtures/build.sh",
    "cli": "node src/cli.ts"
  },
  "devDependencies": {
    "typescript": "^5.8.0",
    "@types/node": "^22.15.0"
  }
}
```

### 3.1 Dependency justification (required by the task; keep this table current)

| Package | Kind | Why it is unavoidable | Alternative rejected |
|---|---|---|---|
| `typescript` | dev | Type-stripping does **not** typecheck. `tsc` is the only thing that enforces `strict`, and it emits `dist/` + `.d.ts` for the CLI. | none viable |
| `@types/node` | dev | Types for `node:fs`, `node:test`, `node:vm`, `import.meta.dirname`. Ships separately from the runtime. | hand-written ambient decls (worse, drifts) |

**Note on the `bin` file mode (review S2).** `tsc` emits `dist/cli.js` as
`-rw-r--r--` — the shebang survives but the executable bit does not, so
`./dist/cli.js` fails with `permission denied` (exit 126) until `npm install` /
`npm link` does its bin-linking. The `build` script therefore `chmod`s it
explicitly (portably, via `node -e`, not `chmod(1)`). Tests still invoke
`node dist/cli.js` rather than `./dist/cli.js`.

**Runtime dependencies: none, permanently.** Adding one requires an ADR in
`docs/DECISIONS.md`. Explicitly rejected and why:

* `tsx` / `ts-node` — superseded by Node's built-in type stripping (§4).
* `vitest` / `jest` / `mocha` — `node --test` covers describe/it, subtests,
  `t.skip()`, `--test-concurrency`, coverage (`--experimental-test-coverage`).
* `commander` / `yargs` — the CLI has ≤ 10 flags; a ~60-line hand parser in
  `src/cli.ts` is smaller than the dependency's `node_modules` footprint.
* `chalk` / `picocolors` — emit raw ANSI from `src/util/fmt.ts`, gated on
  `process.stdout.isTTY && !process.env.NO_COLOR`.
* `zod` — nothing here validates user JSON; the parser validates *bytes*, and
  that logic is bespoke (spec 01 §7).
* A JS parser (`acorn`, `@babel/parser`) — **not needed for M1/M2.** M4's R3
  mitigation ("assert every emitted identifier is bound") will need one; it
  will be added then, as a **devDependency only**, by the M4 spec. See O-3.

---

## 4. `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "moduleDetection": "force",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "allowImportingTsExtensions": true,
    "rewriteRelativeImportExtensions": true,
    "resolveJsonModule": false,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true,
    "outDir": "dist",
    "noEmit": true
  },
  "include": ["src/**/*.ts", "tests/**/*.ts", "tools/**/*.ts"],
  "exclude": ["tests/fixtures/**", "tools/equiv/**", "dist", "node_modules"]
}
```

`tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": false, "noUnusedLocals": false },
  "include": ["src/**/*.ts"]
}
```

Consequences the implementer must live with:

* **`erasableSyntaxOnly`** bans `enum`, `namespace`, parameter properties
  (`constructor(private x)`), and `declare` class fields. Use `const` objects +
  `typeof`-derived union types instead of enums (§5).
* **`allowImportingTsExtensions` + `rewriteRelativeImportExtensions`** means
  every relative import is written with `.ts` (`import { read } from
  "./util/reader.ts"`) and `tsc` rewrites it to `.js` in `dist/`. Node runs the
  `.ts` form directly. Do not write extensionless relative imports.
* **`noUncheckedIndexedAccess`** makes `arr[i]` be `T | undefined`. This is
  deliberate for a binary parser. Contain it: `BinaryReader` and the table
  registry return non-optional values and do their own bounds checks, so the
  `| undefined` noise stays out of `parse/` and `disasm/`.

---

## 5. Naming and code conventions

* **Files** `kebab-case.ts`. **Types/interfaces** `PascalCase`. **Values**
  `camelCase`. **Generated files** carry `// GENERATED by tools/gen-tables/gen.ts
  — DO NOT EDIT` as line 1.
* **No default exports.** Named exports only (better for grep, rename, and
  `verbatimModuleSyntax`).
* **No `enum`.** The pattern is:
  ```ts
  export const LayoutClass = { A: "A", B: "B", C: "C", D: "D", E: "E" } as const;
  export type LayoutClass = (typeof LayoutClass)[keyof typeof LayoutClass];
  ```
  For plain string unions (most cases) just write the union: `type StringKind =
  "String" | "Identifier"`.
* **Immutability.** Every interface describing parsed data is `readonly` in all
  fields and uses `readonly T[]` for arrays. Parsed structures are never mutated
  after construction.
* **No `any`.** `unknown` + narrowing. `as` casts only immediately after a
  bounds/shape check, with a one-line comment saying what guarantees it.
* **Numbers.** All HBC quantities are `uint32` or narrower and fit in a JS
  number; use `number`. The only `bigint`s are (a) the 8-byte magic and (b)
  decoded BigInt literals.
* **Bytes.** `Uint8Array` everywhere at API boundaries, never `Buffer` (keeps
  the core runnable in non-Node engines later and avoids `Buffer`'s pooled-slice
  footguns). Internally, read via a single `DataView` over the whole file.
  `subarray` (view) not `slice` (copy) for function bodies and storage blobs.
* **Comments cite sources.** Any constant derived from Hermes gets a comment
  naming the file it came from, e.g.
  `// BytecodeFileFormat.h: SmallFuncHeader (v51-v96)`. Any behaviour verified
  against a fixture cites the doc section, e.g. `// docs/HBC-FORMAT.md §3.1`.
* **Never cite hermes-dec as a source** (D4/R6). Its *output* may be quoted in
  a test expectation; its code may not be read. See §9's licence guard.
* **One component per commit**, message imperative, tests + docs in the same
  commit (`CLAUDE.md`).

---

## 6. Error handling policy

### 6.1 Types (`src/errors.ts`)

```ts
export const ErrorCode = {
  // usage / IO
  E_USAGE:              "E_USAGE",
  E_IO:                 "E_IO",
  // container-level
  E_BAD_MAGIC:          "E_BAD_MAGIC",
  E_TRUNCATED:          "E_TRUNCATED",
  E_UNSUPPORTED_VERSION:"E_UNSUPPORTED_VERSION",
  E_LAYOUT_AMBIGUOUS:   "E_LAYOUT_AMBIGUOUS",
  E_LAYOUT_NO_CANDIDATE:"E_LAYOUT_NO_CANDIDATE",
  // structural
  E_SECTION_OVERRUN:    "E_SECTION_OVERRUN",
  E_SECTION_MISMATCH:   "E_SECTION_MISMATCH",
  E_BAD_STRING_ID:      "E_BAD_STRING_ID",
  E_BAD_FUNCTION_ID:    "E_BAD_FUNCTION_ID",
  E_BAD_HANDLER:        "E_BAD_HANDLER",
  E_BAD_LITERAL_TAG:    "E_BAD_LITERAL_TAG",
  // decode
  E_UNKNOWN_OPCODE:     "E_UNKNOWN_OPCODE",
  E_OPERAND_OVERRUN:    "E_OPERAND_OVERRUN",
  E_JUMP_OUT_OF_RANGE:  "E_JUMP_OUT_OF_RANGE",
  E_JUMP_MISALIGNED:    "E_JUMP_MISALIGNED",
  E_SWITCH_TABLE:       "E_SWITCH_TABLE",
  // tables
  E_TABLE_ASSERT:       "E_TABLE_ASSERT",
  // internal
  E_INTERNAL:           "E_INTERNAL",
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ErrorContext {
  readonly offset?: number;        // absolute file offset
  readonly section?: string;       // e.g. "smallStringTable"
  readonly functionIndex?: number;
  readonly expected?: string;
  readonly actual?: string;
  readonly hint?: string;          // one sentence, actionable
}

export class Hbc2jsError extends Error {
  readonly code: ErrorCode;
  readonly context: ErrorContext;
  constructor(code: ErrorCode, message: string, context?: ErrorContext);
}
export class ParseError extends Hbc2jsError {}
export class DecodeError extends Hbc2jsError {}

export type Severity = "warn" | "info";
export interface Diagnostic {
  readonly severity: Severity;
  readonly code: string;           // "W_..." namespace, distinct from ErrorCode
  readonly message: string;
  readonly context: ErrorContext;
}
```

### 6.2 Rules

1. **Throw for impossibility, diagnose for oddity.** A structural contradiction
   (section overrun, unknown opcode, misaligned jump target) throws. A tolerable
   anomaly (footer SHA-1 mismatch, `segmentID != 0`, unknown `options` bits,
   trailing bytes after `fileLength`) appends a `Diagnostic` and continues.
   Spec 01 §7 fixes the classification per invariant; do not improvise.
2. **Never guess on ambiguity** (D8 / R1). Zero viable layouts →
   `E_LAYOUT_NO_CANDIDATE`; more than one → `E_LAYOUT_AMBIGUOUS` whose message
   lists the surviving candidates and the flag that forces a choice. A silently
   wrong parse is the worst outcome this project can produce.
3. **Every thrown error carries a byte offset** where one exists. A bug report
   should be reproducible from `code + offset` alone.
4. **`src/**` never writes to stdout/stderr and never calls `process.exit`.**
   Only `src/cli.ts` does IO and exits. Library callers get values, exceptions,
   and `diagnostics[]`.
5. **No `try { } catch { }` swallowing.** If you catch, either re-throw wrapped
   in `Hbc2jsError` with added context, or record a `Diagnostic`. Never both
   silently.
6. **Assertions.** `assertInternal(cond, msg)` throws `E_INTERNAL`. Use it for
   invariants that only our own code can break; use `ParseError` for anything
   an attacker-controlled file can trigger.

### 6.3 CLI exit codes (`src/cli.ts`)

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | unexpected internal error (`E_INTERNAL`, or a non-`Hbc2jsError` escape) |
| 2 | usage error (`E_USAGE`) |
| 3 | parse/decode error on a well-formed-looking file |
| 4 | unsupported or ambiguous version/layout (`E_UNSUPPORTED_VERSION`, `E_LAYOUT_*`) |
| 5 | verification failure (a `--verify`-style check found a mismatch) |

Stderr format: `hbc2js: <CODE>: <message>` then, indented, `at 0x<offset> in
<section>` and `hint: <hint>` when present. `--json` makes errors a single JSON
object on stdout instead.

---

## 7. Fixtures and `hermesc` in tests

### 7.1 Fixture discovery (`tests/support/fixtures.ts`)

The fixture layout is documented in `tests/fixtures/README.md` (authored by
another agent, and moving fast — **re-read it and re-count before relying on any
number below**). Surveyed at the time of this revision:

```
tests/fixtures/<group>/<name>/
    source.js       always
    expected.txt    constructs/ only — `node source.js` stdout (see D14 caveat)
    licence.txt     always
    versions.txt    only when some hermesc version cannot compile this fixture
    v84.hbc v94.hbc v98.hbc v99.hbc [v99-public.hbc]   only versions that compiled
```

| Group | Contents |
|---|---|
| `constructs/` | **53** dirs `01-…`–`53-…`; 196 of 212 (source × version) combinations compile; 52/53 are the switch-jump-table fixtures |
| `hermes-dec-sample/` | one dir, **five** `.hbc` (`v84`, `v94`, `v98`, `v99`, `v99-public`); `v94.hbc` and `v99.hbc` are **preserved historical originals** |
| `bundles/` | C3 real Metro bundles (D16), e.g. `rn-template-0.72/` with four `.hbc` flag variants (1.2–2.7 MB, HBC 94) plus the `.bundle` source |
| `local-corpus/` | C5, **gitignored**; only `MANIFEST.json` is committed |

Four `hermesc` versions are now fetched (`tools/get-hermesc.sh` handles
`84|94|98|99|all`), so every version-keyed helper, matrix and table in this
project must cover **98** as well.

```ts
export interface FixtureBinary {
  readonly version: 84 | 94 | 98 | 99;
  readonly variant: "" | "public";   // "public" => v99-public.hbc
  readonly path: string;             // absolute
  readonly bytes: () => Uint8Array;  // lazy, cached
  /** true when `tests/fixtures/build.sh` can reproduce this file byte-for-byte
   *  from source.js with the fetched hermesc (false for the two preserved
   *  historical originals; see docs/TOOLCHAIN.md). */
  readonly reproducible: boolean;
}
export interface Fixture {
  readonly group: string;            // "constructs" | "hermes-dec-sample" | "bundles"
  readonly name: string;             // "09-switch-fallthrough"
  readonly dir: string;
  readonly sourcePath: string;
  readonly expectedPath: string | null;
  readonly binaries: readonly FixtureBinary[];
}
export function listFixtures(filter?: { group?: string; version?: number }): readonly Fixture[];
/** C3 bundle inputs (sweep tier). Separate call so a gate test cannot pull in
 *  megabytes by accident. */
export function listBundles(): readonly FixtureBinary[];
export function fixture(group: string, name: string): Fixture;   // throws if absent
```

Rules:

* Discovery is **read-only**. Tests must not create, delete or recompile
  anything under `tests/fixtures/`. If a `.hbc` is missing, the test `t.skip()`s
  with the reason from `versions.txt` when one exists.
* `reproducible` is `false` exactly for `hermes-dec-sample/v94.hbc` and
  `hermes-dec-sample/v99.hbc`. (v94's *content* is byte-identical to a fresh
  compile, but the file is preserved, not generated; treat `v99.hbc` as the one
  that genuinely cannot be reproduced — see `docs/TOOLCHAIN.md`.)
* Discovery must be deterministic: sort by `(group, name, version, variant)`.
* `bundles/**` is **never** returned by `listFixtures()` — gate tests must not
  touch multi-megabyte inputs. Use `listBundles()` from a sweep test.

### 7.2 `hermesc` (`tests/support/hermesc.ts`)

```ts
export type HbcVersion = 84 | 94 | 98 | 99;
export interface Hermesc { readonly version: HbcVersion; readonly path: string; }
export function findHermesc(version: HbcVersion): Hermesc | null;
export function requireHermesc(t: TestContext, version: HbcVersion): Hermesc | null;
export function runHermesc(h: Hermesc, args: readonly string[], cwd: string): {
  readonly status: number; readonly stdout: string; readonly stderr: string;
};
```

* Lookup order: `process.env[`HERMESC_V${version}`]` → `<repo>/tools/hermesc/v<version>/hermesc`.
  Repo root is found from `import.meta.dirname` walking up to the dir containing
  `package.json` — never `process.cwd()`.
* **Tests never invoke `tools/get-hermesc.sh`.** It downloads from npm; test
  runs must be offline-safe and side-effect-free. CI runs it as an explicit
  step (§8). A missing binary is a `t.skip()`.
* `requireHermesc` honours `HBC2JS_REQUIRE_ORACLES=1`: under that env var a
  missing binary is a **failure**, not a skip. CI sets it, so silent skipping
  cannot hide rot.
* `runHermesc` uses `node:child_process.spawnSync` with `shell: false` and an
  **argv array** — never a command string (§10). Always pass a relative input
  filename and a `cwd` inside a temp dir, because hermesc embeds the invoked
  filename in the output (`docs/TOOLCHAIN.md`).

### 7.3 hermes-dec oracles (`tests/support/oracles.ts`)

```ts
export type OracleName = "hbc-file-parser" | "hbc-disassembler";
export function findOracle(name: OracleName): string | null;   // PATH lookup, HERMES_DEC_BIN_DIR override
export function requireOracle(t: TestContext, name: OracleName): string | null;
export function runOracle(bin: string, args: readonly string[]): { status: number; stdout: string; };
```

Same skip/require semantics. **Reading hermes-dec's stdout is allowed; reading
its source is forbidden** (D4). Put a comment saying so at the top of the file.

---

## 8. CI outline (`.github/workflows/`)

Two workflows, matching D13's cost tiers: `ci.yml` (every push/PR, gate only)
and `sweep.yml` (nightly + manual, everything else).

### 8.1 `ci.yml` — gate

```yaml
name: ci
on:
  push: { branches: ["**"] }
  pull_request:
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  build-test:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest]
        node: ["22.18", "24"]
    runs-on: ${{ matrix.os }}
    timeout-minutes: 25
    env:
      HBC2JS_REQUIRE_ORACLES: "1"
      HBC2JS_TIER: gate
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "${{ matrix.node }}", cache: npm }
      - run: npm ci
      - run: npm run typecheck
      - run: npm run gen:tables:check      # generated tables are reproducible
      - uses: actions/cache@v4             # hermesc binaries, keyed on the fetch script
        with:
          path: tools/hermesc
          key: hermesc-${{ runner.os }}-${{ hashFiles('tools/get-hermesc.sh') }}
      - run: tools/get-hermesc.sh all      # v84, v94, v98, v99
      - run: npm run build                 # also proves dist/cli.js is executable
      - run: npm run test:gate

  oracle-hermes-dec:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    env:
      HBC2JS_REQUIRE_ORACLES: "1"
      HBC2JS_TIER: gate
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "24", cache: npm }
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - run: pip install "hermes-dec==0.1.7"
      - run: npm ci
      - run: npm run test:gate

  licence-guard:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: No AGPL contamination (D4 / risk R6)
        run: |
          set -e
          ! grep -rInE 'hermes_dec|hermes-dec/|site-packages|pass[0-9]_transform_code|_fun[0-9]+_ip|CatchBlockStart' \
              src/ tools/gen-tables/ \
            || { echo "hermes-dec-derived identifier found in src/ — see docs/DECISIONS.md D4"; exit 1; }
```

### 8.2 `sweep.yml` — sweep

```yaml
name: sweep
on:
  schedule: [{ cron: "0 3 * * *" }]
  workflow_dispatch:
jobs:
  sweep:
    runs-on: ubuntu-latest
    timeout-minutes: 90
    env:
      HBC2JS_REQUIRE_ORACLES: "1"
      HBC2JS_TIER: sweep
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "24", cache: npm }
      - uses: actions/cache@v4
        with: { path: tools/hermesc, key: hermesc-Linux-${{ hashFiles('tools/get-hermesc.sh') }} }
      - run: npm ci
      - run: tools/get-hermesc.sh all
      - run: npm run test:sweep            # bundles/**, round-trip, obfuscated variants
```

Notes:

* **Matrix rationale.** `22.18` is the lowest supported runtime (type stripping
  on by default); `24` is current LTS-track. macOS runners are arm64 and the npm
  `hermesc` builds are universal Mach-O, so they work; Linux runners are x86_64,
  the only Linux arch with a published `hermesc` (`docs/TOOLCHAIN.md`). **Do not
  add a Linux arm64 runner** until a source-built `hermesc` exists. The `22.18`
  leg is the *only* place that floor gets exercised — it was never verified
  locally (review S3), so a green `22.18` leg is what closes that question, and
  it must not be dropped from the matrix for speed.
* `npm run test:gate` appears in both `build-test` and `oracle-hermes-dec`: in
  the first, the hermes-dec oracle tests skip (not installed) and the hermesc
  ones run; in the second, the reverse. Together they cover both.
* `gen:tables:check` regenerates the tables into a temp dir and fails if the
  committed files differ (spec 01 §5.4). That is what makes "generated from a
  pinned MIT commit" verifiable rather than a claim.
* **Licence-guard false-positive hazard (review S5).** The guard greps for
  `_fun[0-9]+_ip`, which is hermes-dec's dispatch-variable shape (`_fun5_ip`) —
  and also the most natural name for the `for(;;) switch(ip)` debug escape hatch
  D6/D7 retain. That collision would make the guard fire on legitimately
  original code, and the fix must never be to weaken the guard. **The M4
  fallback emitter must name its dispatch variable `__dispatchPc` (not
  `_funN_ip`, `_ip`, or anything of that shape).** Recorded here because this
  spec defines the gate; restate it in the M4 emitter spec.
* A `fixtures-reproducible` step (`tests/fixtures/build.sh && git diff --exit-code
  tests/fixtures`) is desirable but **is not added by this spec** — that path
  belongs to another agent right now (O-4).

## 9. Cross-platform rules

1. **Paths.** `node:path` (`join`, `resolve`) always; never string concat with
   `/`. Never assume `process.cwd()`; resolve from `import.meta.dirname`.
2. **Repo root.** One helper (`tests/support/paths.ts` / `src/util/paths.ts`):
   walk up from `import.meta.dirname` to the first dir containing
   `package.json`. Cache the result.
3. **Subprocesses.** `spawnSync(bin, argsArray, { shell: false })`. Never build
   a shell string; never rely on `sh`, `bash`, `find`, `sed`, `grep`, `sha1sum`
   from TypeScript. (`.sh` files under `tools/` and `tests/fixtures/` are exempt
   — they already exist and are POSIX-clean.)
4. **Line endings.** Files are LF. Any text produced for diffing is normalised
   with `text.replace(/\r\n/g, "\n")` before comparison, and written with `\n`.
   Add `.gitattributes` with `* text=auto eol=lf` and `*.hbc binary`.
5. **Case sensitivity.** macOS is case-insensitive, Linux is not. Import paths
   must match on-disk case exactly. Never create two files differing only in
   case.
6. **Temp files.** `node:fs.mkdtempSync(path.join(os.tmpdir(), "hbc2js-"))`,
   removed in a `t.after()` hook. Never `/tmp` literals.
7. **No native/architecture assumptions.** No `os.arch()` branching in `src/`.
   Endianness: HBC is little-endian on the wire; always read through explicit
   `DataView.getUint32(o, /* littleEndian */ true)` — never `Buffer.readUInt32LE`
   and never a typed-array view over unaligned data (typed arrays inherit host
   endianness *and* require alignment).
8. **Text decoding.** Do not use `TextDecoder("utf-16le")` for HBC strings — it
   replaces unpaired surrogates with U+FFFD and HBC strings legitimately contain
   them (spec 01 §3.3). Hand-roll with `String.fromCharCode`.
9. **Time/locale.** No `toLocaleString`, no locale-dependent `sort` comparators
   (`Intl.Collator` never; use code-unit `<`), no `Date` in any output that is
   compared or committed.

---

## 10. Acceptance criteria

An implementation agent can self-verify all of these.

- [ ] `npm ci` succeeds on macOS and Linux with exactly the two devDependencies
      in §3; `node_modules` contains no runtime dependency of `hbc2js` itself.
- [ ] `npm run typecheck` passes with zero errors and no `any` in `src/`
      (`git grep -nE '\bas any\b|: *any\b' -- src/` returns nothing; use
      `git grep` so the check is word-aware and respects `.gitignore` — a plain
      `grep -rn` also matches the word inside comments and strings, review N2).
- [ ] `npm run build` emits `dist/cli.js` with a shebang **and mode 0755**
      (`test -x dist/cli.js`), plus `dist/index.js` and `.d.ts` files;
      `node dist/cli.js --help` prints usage and exits 0.
- [ ] `node src/cli.ts --help` (no build step) prints the same usage — proving
      the type-stripping path works.
- [ ] `npm test` (gate tier) runs and passes with **zero** silently skipped tests
      when `HBC2JS_REQUIRE_ORACLES=1` and all binaries are present; every skip
      that remains prints its reason and is classified INCONCLUSIVE, never PASS.
- [ ] `npm run test:sweep` runs, and skips cleanly (INCONCLUSIVE, with reasons)
      when `bundles/**` or `local-corpus/**` inputs are absent.
- [ ] `src/errors.ts` exports every code in §6.1; a unit test asserts
      `Hbc2jsError` instances serialise their `code`, `message` and `context`.
- [ ] `tests/support/fixtures.ts` discovers **54** fixture directories
      (53 `constructs/` + 1 `hermes-dec-sample/`) and **201** `.hbc` binaries
      (196 + 5), is deterministic across two runs, excludes `bundles/**` from
      `listFixtures()`, and writes nothing (`git status --porcelain
      tests/fixtures` is empty afterwards). **Re-derive these two counts from the
      tree before hardcoding them** — the corpus is being extended concurrently.
- [ ] `tests/support/hermesc.ts` handles versions 84/94/**98**/99, returns `null`
      (not a throw) when a binary is absent, and `requireHermesc` fails rather
      than skips under `HBC2JS_REQUIRE_ORACLES=1`.
- [ ] `tests/support/tiers.ts` gates sweep tests: with `HBC2JS_TIER` unset, no
      file under `tests/sweep/` executes a body.
- [ ] Exit codes in §6.3 are exercised by at least one CLI test each for 0, 2, 3.
- [ ] `docs/LOWERING-CATALOGUE.md` exists with its column headers and a one-
      paragraph preamble pointing at D12; it is empty of rows at M1/M2.
- [ ] `src/passes/{registry.ts,types.ts}` exist with the D12 `Pass` /
      `Match` / `PassContext` interfaces and an **empty** ordered registry; no
      pass directories yet.
- [ ] `.github/workflows/ci.yml` and `sweep.yml` exist as in §8; the
      licence-guard job fails when a file containing `CatchBlockStart` is
      temporarily added under `src/` (verify locally, then remove).
- [ ] Nothing under `tests/fixtures/**`, `tools/**` (including `tools/equiv/`),
      or any other agent's paths is modified by this commit.

---

## 11. Estimated complexity

**Sonnet, comfortably.** ~700 lines of scaffolding, no algorithms. Slow down in
three places: (a) `erasableSyntaxOnly` + `rewriteRelativeImportExtensions` must
work in both the `tsc` and the strip-types paths; (b) the two CI workflows;
(c) fixture discovery, which must stay deterministic and must not accidentally
pull `bundles/**` into the gate tier. Budget one session.

---

## 12. Open questions for the overseer

* **O-1 — Node floor.** `>=22.18` lets tests run `.ts` with no flags but rules
  out Node 20 (LTS-supported until 2026-04). The claim was verified only on the
  Node in this sandbox (v25.9.0); the CI `22.18` leg is what will actually
  confirm it (review S3). Confirm 22.18 is acceptable, or we add a
  `tsc`-before-test step and drop to `>=20.11`.
* **O-2 — `private: true`.** The skeleton marks the package private. If hbc2js
  is meant to be `npm publish`-able at M5, say so and the
  `files`/`exports`/`repository` fields get filled in now instead.
* **O-3 — JS parser dependency at M4.** R3's mitigation ("assert every emitted
  identifier is bound") needs a real JS parser. Pre-approve `acorn` (MIT) as a
  **devDependency** for the M4 verifier, or decide the check happens only by
  executing under `node:vm`?
* **O-4 — fixture reproducibility gate in CI.** A
  `tests/fixtures/build.sh && git diff --exit-code` step would catch fixture rot
  but touches a path another agent owns. Want it, and who adds it?
* **O-5 — coverage.** `node --test --experimental-test-coverage` is available.
  Do we want a coverage floor in CI (e.g. 85 % lines in `src/parse`), or is the
  golden/oracle suite the real gate?

---

## 13. Review responses (`docs/specs/REVIEW-01-02.md`)

| Item | Verdict | Where |
|---|---|---|
| **S2** `tsc` does not set the executable bit on `dist/cli.js` | **Fixed** | §3 `build` script now chmods 0755 via `node -e`; §3.1 note; §10 asserts `test -x` |
| **S3** Node `>=22.18` floor unverified | **Fixed (as far as it can be)** | §8 notes the `22.18` matrix leg is the only thing that closes it and must not be dropped; O-1 kept open until that leg is green |
| **S5** licence-guard `_fun[0-9]*_ip` false positive vs D6/D7's `switch(ip)` fallback | **Fixed** | §8 note: the guard is kept as-is (tightened to `_fun[0-9]+_ip`) and the M4 fallback is required to name its dispatch variable `__dispatchPc`. Weakening the guard was rejected — the guard is the cheap defence for R6, the naming constraint costs nothing |
| **N2** `grep -rn ": any\|as any"` has no comment/string exclusion | **Fixed** | §10 now uses `git grep -nE '\bas any\b\|: *any\b' -- src/`. A full AST check was rejected as disproportionate: it would need the M4 parser dependency (O-3) to exist first |
| B1, B2, B3, S1, S4, S6, N1, N3, N4, N5 | Not this spec's | Addressed in specs 01 and 02; N1 relayed to the fixtures agent via §7.1's "re-derive the counts" instruction |
