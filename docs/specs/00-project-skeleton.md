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
  passes/                     M4+ — one readability/recovery pass per module (D11)
  harness/                    M3 — empty until spec 06 (reconcile with tools/equiv/ then)
tools/
  get-hermesc.sh              EXISTS — do not modify
  gen-tables/                 spec 01 §5: opcode/builtin table generator
    vendor.sh                 fetch + pin BytecodeList.def etc. from facebook/hermes
    gen.ts                    parse the .def files, emit src/tables/generated/*
third_party/hermes/<tableId>/ vendored MIT .def/.h files + LICENSE (committed)
tests/
  support/
    fixtures.ts               fixture discovery (reads tests/fixtures/, never writes)
    hermesc.ts                locate tools/hermesc/vNN/hermesc; skip helpers
    oracles.ts               locate hbc-file-parser / hbc-disassembler; skip helpers
    golden.ts                 deterministic JSON snapshot read/write/compare
    bytes.ts                  read a fixture .hbc as Uint8Array
  unit/**/*.test.ts           pure unit tests (no external binaries)
  golden/**                   committed snapshot JSON (see spec 01 §8 T5)
  oracle/**/*.test.ts         tests that shell out to hermesc / hermes-dec
  fixtures/                   OWNED BY ANOTHER AGENT — read only
```

`src/cfg`, `src/structure`, `src/emit`, `src/passes`, `src/harness` are created
as empty directories with a `.gitkeep` — do not stub types into them; the M3/M4
specs own their interfaces. `src/passes/` is reserved for D11's one-module-per-
recovery-pass structure.

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
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "node --test \"tests/unit/**/*.test.ts\" \"tests/oracle/**/*.test.ts\"",
    "test:unit": "node --test \"tests/unit/**/*.test.ts\"",
    "test:oracle": "node --test \"tests/oracle/**/*.test.ts\"",
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
another agent). As of writing:

```
tests/fixtures/<group>/<name>/
    source.js       always
    expected.txt    constructs/ only — `node source.js` stdout, D2 ground truth
    licence.txt     always
    versions.txt    only when some hermesc version cannot compile this fixture
    v84.hbc v94.hbc v99.hbc [v99-public.hbc]   only for versions that compiled
```

Groups today: `constructs/` (51 dirs, `NN-topic`) and `hermes-dec-sample/`
(one dir, four `.hbc` files, of which `v94.hbc`/`v99.hbc` are **preserved
historical originals**).

```ts
export interface FixtureBinary {
  readonly version: 84 | 94 | 99;
  readonly variant: "" | "public";   // "public" => v99-public.hbc
  readonly path: string;             // absolute
  readonly bytes: () => Uint8Array;  // lazy, cached
  /** true when `tests/fixtures/build.sh` can reproduce this file byte-for-byte
   *  from source.js with the fetched hermesc (false for the two preserved
   *  historical originals; see docs/TOOLCHAIN.md). */
  readonly reproducible: boolean;
}
export interface Fixture {
  readonly group: string;            // "constructs" | "hermes-dec-sample"
  readonly name: string;             // "09-switch-fallthrough"
  readonly dir: string;
  readonly sourcePath: string;
  readonly expectedPath: string | null;
  readonly binaries: readonly FixtureBinary[];
}
export function listFixtures(filter?: { group?: string; version?: number }): readonly Fixture[];
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

### 7.2 `hermesc` (`tests/support/hermesc.ts`)

```ts
export interface Hermesc { readonly version: 84 | 94 | 99; readonly path: string; }
export function findHermesc(version: 84 | 94 | 99): Hermesc | null;
export function requireHermesc(t: TestContext, version: 84 | 94 | 99): Hermesc | null;
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

## 8. CI outline (`.github/workflows/ci.yml`)

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
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "${{ matrix.node }}", cache: npm }
      - run: npm ci
      - run: npm run typecheck
      - run: npm run gen:tables:check      # generated tables are reproducible
      - uses: actions/cache@v4             # hermesc binaries (~40 MB), keyed on the fetch script
        with:
          path: tools/hermesc
          key: hermesc-${{ runner.os }}-${{ hashFiles('tools/get-hermesc.sh') }}
      - run: tools/get-hermesc.sh all
      - run: npm run test:unit
      - run: npm run test:oracle           # hermesc-backed diff tests (spec 02 §7A)

  oracle-hermes-dec:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    env:
      HBC2JS_REQUIRE_ORACLES: "1"
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "24", cache: npm }
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - run: pip install "hermes-dec==0.1.7"
      - run: npm ci
      - run: npm run test:oracle

  licence-guard:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: No AGPL contamination (D4 / risk R6)
        run: |
          set -e
          ! grep -rInE 'hermes_dec|hermes-dec/|site-packages|pass[0-9]_transform_code|CatchBlockStart|_fun[0-9]*_ip' \
              src/ tools/gen-tables/ \
            || { echo "hermes-dec-derived identifier found in src/ — see docs/DECISIONS.md D4"; exit 1; }
```

Notes:

* **Matrix rationale.** `22.18` is the lowest supported runtime (type stripping
  on by default); `24` is current LTS-track. macOS runners are arm64 and the npm
  `hermesc` builds are universal Mach-O, so they work; Linux runners are x86_64,
  the only Linux arch with a published `hermesc` (`docs/TOOLCHAIN.md`). **Do not
  add a Linux arm64 runner** until a source-built `hermesc` exists.
* `npm run test:oracle` appears in both jobs on purpose: in `build-test` the
  hermes-dec oracles skip (not installed) and the hermesc ones run; in
  `oracle-hermes-dec` the reverse. Together they cover both. If that double-run
  becomes slow, split the oracle tests into `tests/oracle/hermesc/**` and
  `tests/oracle/hermes-dec/**` and give each job its own glob.
* `gen:tables:check` regenerates the tables into a temp dir and fails if the
  committed files differ (spec 01 §5.4). This is what makes "generated from a
  pinned MIT commit" verifiable rather than a claim.
* A `fixtures-reproducible` step (`tests/fixtures/build.sh && git diff --exit-code
  tests/fixtures`) is desirable but **is not added by this spec** — that path
  belongs to another agent right now. Propose it to the overseer later (O-4).

---

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
- [ ] `npm run typecheck` passes with zero errors and zero `any` in `src/`
      (`grep -rn ": any\b\|as any" src/` returns nothing).
- [ ] `npm run build` emits `dist/cli.js` with a shebang, `dist/index.js`,
      and `.d.ts` files; `node dist/cli.js --help` prints usage and exits 0.
- [ ] `node src/cli.ts --help` (no build step) prints the same usage — proving
      the type-stripping path works.
- [ ] `npm test` runs and passes with **zero** tests silently skipped when
      `HBC2JS_REQUIRE_ORACLES=1` and all binaries are present.
- [ ] `src/errors.ts` exports every code in §6.1; a unit test asserts
      `Hbc2jsError` instances serialise their `code`, `message` and `context`.
- [ ] `tests/support/fixtures.ts` discovers ≥ 52 fixture directories and
      ≥ 138 `.hbc` binaries, is deterministic across two runs, and writes
      nothing (verify with `git status --porcelain tests/fixtures` after a run).
- [ ] `tests/support/hermesc.ts` returns `null` (not a throw) when a binary is
      absent, and `requireHermesc` fails rather than skips under
      `HBC2JS_REQUIRE_ORACLES=1`.
- [ ] Exit codes in §6.3 are exercised by at least one CLI test each for 0, 2, 3.
- [ ] `.github/workflows/ci.yml` exists with the three jobs of §8 and the
      licence-guard job fails when a test file containing `CatchBlockStart` is
      temporarily added under `src/` (verify locally, then remove).
- [ ] No file under `tests/fixtures/**` or `tools/equiv/**` is modified by this
      commit (`git status --porcelain` shows only the intended paths).

---

## 11. Estimated complexity

**Sonnet, comfortably.** ~600 lines of scaffolding, no algorithms. The only
places to slow down are (a) getting `erasableSyntaxOnly` +
`rewriteRelativeImportExtensions` right in both the `tsc` and the strip-types
paths, and (b) the CI YAML matrix. Budget one session. No Opus review needed
unless O-1 is answered in a way that changes the runtime baseline.

---

## 12. Open questions for the overseer

* **O-1 — Node floor.** `>=22.18` lets tests run `.ts` with no flags but rules
  out Node 20 (still LTS-supported until 2026-04). Confirm 22.18 is acceptable,
  or we add a `tsc`-before-test step and drop to `>=20.11`.
* **O-2 — `private: true`.** The skeleton marks the package private (nothing is
  published yet). If hbc2js is meant to be `npm publish`-able at M5, say so and
  the `files`/`exports`/`repository` fields get filled in now instead.
* **O-3 — JS parser dependency at M4.** R3's mitigation ("assert every emitted
  identifier is bound") needs a real JS parser. Pre-approve `acorn` (MIT) as a
  **devDependency** for the M4 verifier, or decide the check happens by
  executing under `node:vm` only?
* **O-4 — fixture reproducibility gate in CI.** Adding a
  `tests/fixtures/build.sh && git diff --exit-code` step would catch fixture rot,
  but touches a path another agent owns. Want it, and if so, who adds it?
* **O-5 — coverage.** `node --test --experimental-test-coverage` is available.
  Do we want a coverage floor in CI (e.g. 85 % lines in `src/parse`), or is the
  golden/oracle suite the real gate?
