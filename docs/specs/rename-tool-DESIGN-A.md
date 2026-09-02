# Rename tool — Design A (overseer's reading of Fred's suggestion, 2026-09-02)

> This is the design as the overseer understood it from Fred's spoken request, written so
> Fred's own incoming spec ("Design B") can be **compared against it** and a reconciled
> spec chosen before anything is implemented. Nothing here is built yet.

## 1. Purpose & context
Fred is building an LLM-driven vulnerability-fuzzing suite on top of hbc2js's decompiled
output. In that loop, an LLM reads decompiled JavaScript (currently full of `rN` register
names) and wants to assign **meaningful variable names** so it can reason about the code
while hunting for vulnerabilities. It needs a tool it can call **many times, cheaply, and
safely**: give it a location and a new name, and get back valid, consistently-renamed code.

The tool's job is a **mechanical, scope-correct variable rename** — not a text substitution.
It must never break the code and never rename the wrong binding.

## 2. Interface

### CLI
```
hbc2js rename <file> <line> <oldName> <newName> [--local] [--json] [--dry-run] [--root <dir>]
```
- `<file>`   — path to the JS file containing the reference (relative to `--root` or cwd).
- `<line>`   — 1-based line number, or a *rough* line (see §4, snapping).
- `<oldName>`— the current identifier text (e.g. `r7`). Disambiguates when a line has several.
- `<newName>`— the desired identifier.

### Programmatic (for the suite to import, avoiding process startup)
```ts
rename({ file, line, oldName, newName, local?, root?, dryRun? }): RenameResult
```
A long-lived process/service form is desirable (see §7) so the suite can issue thousands of
renames without re-parsing the world each call.

## 3. Scope model (the core behaviour Fred specified)
- **Default = whole segregated project.** The extent of the rename is determined by the
  variable's *real* scope, computed from the AST — NOT declared by the caller:
  - If the binding at the location is a **global / module-exported** variable, every
    reference across **all module files** is renamed.
  - If it is a **local** (function/block-scoped), only references within that scope change,
    even though the whole project was searched — a local is a distinct binding, so no
    cross-file references exist to match.
  - The caller does not need to know which it is. "Rename globally *if it is global*,
    locally *if it is local*" — correctness falls out of scope analysis.
- **`--local` flag** = single-file fast path. Same correctness, but only the one file is
  loaded — for when the caller already knows the target is a local and wants minimal
  startup cost. (An optimisation, never a correctness switch.)
- **`--root <dir>`** = the project root for the whole-project search (defaults to the nearest
  ancestor containing the segregated tree / a package boundary, else the file's directory).

## 4. Locating the target (rough line accepted)
1. Parse `<file>`; collect all `Identifier` tokens named `<oldName>`.
2. If `<line>` names an exact occurrence, use it. If `<line>` is *rough*, snap to the
   **nearest** `<oldName>` occurrence by line distance (ties → earliest column). This lets an
   LLM cite an approximate line without failing.
3. If no `<oldName>` occurs near `<line>`, error clearly (see §6) — never rename a different
   name.
4. Resolve that occurrence to its **binding** (the declaration it refers to). All rename
   locations derive from the binding, so picking any one reference on the line is sufficient.

## 5. Implementation (recommended — use an EXISTING TS tool, do not hand-roll)
**Fred's steer (2026-09-02): prefer an existing TypeScript tool — safer than writing our own
rename logic.** Two existing options, in order of preference:

**(a) ts-morph** (recommended) — a mature, widely-used wrapper over the TS compiler with
scope-correct rename as a first-class API:
```ts
const project = new Project();                 // or add just the file for --local
project.addSourceFilesAtPaths(`${root}/**/*.js`);
const id = sourceFile.getDescendantAtPos(pos); // the Identifier at/near the target
id.rename(newName);                            // updates EVERY real reference, cross-file
project.save();                                // write changed files
```
`ts-morph`'s `.rename()` is exactly this tool's core: it resolves the binding, updates all
references across files for globals/exports, leaves shadowed same-named bindings alone, and
keeps output valid. It also exposes reference counts (`getReferences`) for the terse output.
This is the safest path — the rename correctness is delegated to a well-tested library, and
we only write the thin CLI/locating/output layer. (Adds one dependency; acceptable.)

**(b) The bare TypeScript language service** — `typescript` is already a dependency:
- Build a `LanguageService` over the file set (one file for `--local`; the project's module
  files for the default).
- `getRenameInfo(file, pos)` to validate the target; `findRenameLocations(file, pos, ...)` to
  get every reference (this is exactly scope-correct and spans files for exports/globals).
- Apply the returned text spans as edits, write the changed files.
- The output JS is guaranteed syntactically valid because only identifier tokens at real
  reference sites are replaced.

(Alternative: acorn + a scope analyser like `eslint-scope`. TS is preferred since it's
already present and handles cross-module `import`/`export` and `require` interop.)

## 6. Output (token-minimal — a hard requirement)
Success (default text form), ONE line:
```
renamed r7 → userInput: 5 refs in 2 files
```
`--json`:
```json
{ "old": "r7", "new": "userInput", "refs": 5, "files": ["src/App.js", "src/screens/Home.js"], "scope": "module" }
```
- No diff, no file dumps — the caller already has the files.
- `scope` is `"local"` or `"module"` so the LLM learns what it just did.
- `--dry-run` reports the same counts **without writing** (for the suite to preview).

## 7. Performance (called thousands of times)
- Fast startup path for `--local` (load one file, not the tree).
- A resident/service mode (persistent language service, incremental document updates) so a
  fuzzing loop can issue many renames against the same project without re-parsing each call.
  The suite hands successive `{file,line,old,new}` requests; the service keeps the program
  warm and returns the terse result.

## 8. Correctness rules / edge cases
- **Shadowing:** never rename a binding of the same text in a different scope — only the
  binding the target reference resolves to. (TS handles this.)
- **Collision:** if `<newName>` already binds in a scope the rename would move into (would
  capture or be captured), **refuse** with a clear error and change nothing — unless a
  `--force` is later specified (out of scope for v1; default is refuse).
- **Not an identifier / keyword / reserved word** as `<newName>` → refuse.
- **Property keys / string names** are NOT renamed (renaming `o.r7` the property is a
  different, unsafe operation) — only lexical variable bindings. State this explicitly.
- **Cross-module** only follows real binding references (imports/exports/`require` interop of
  the same binding), never same-named unrelated globals in other files.
- Rename must not change any run-time behaviour — it is pure alpha-renaming; a
  `--verify` option could re-parse the result to confirm it still parses (cheap) and,
  optionally, that the identifier graph is isomorphic modulo the renamed binding.

## 9. Tests
- Rename a **local** → only in-scope references change; a same-named var elsewhere untouched.
- Rename an **exported/global** → updates every dependent module file.
- **Shadowed** variable → only the intended binding changes.
- **Collision** with an existing in-scope name → refused, no files written.
- **Rough line** → snaps to the nearest occurrence and renames correctly.
- `--local` vs default produce identical edits for a true local; default additionally spans
  files for a true global.
- Output is exactly the one-line / JSON shape (token-minimal).

## 10. Non-goals (v1)
- Renaming object properties, string-keyed members, or dynamic accesses.
- Renaming across a bundle that hasn't been split/segregated (operate on the emitted `.js`).
- Semantic renaming suggestions — the *caller* (the LLM) chooses names; this tool only
  applies them correctly.

## 11. Open questions for the comparison against Fred's spec (Design B)
- Does Fred want a **resident service** (persistent, for the fuzzing loop) as the primary
  interface, or is per-call CLI acceptable?
- Collision policy: hard-refuse (this design) vs auto-suffix vs `--force`.
- Should it also rename **function names** and **parameters** (same machinery) or strictly
  local/global *variables*?
- Scope-root discovery: explicit `--root` vs auto-detect the segregated project.
- Any need to operate on a file **not yet written to disk** (in-memory buffer the suite
  holds) rather than a path?
