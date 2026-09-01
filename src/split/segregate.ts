// src/split/segregate.ts — D17i stage 3, "milestone 1" (docs/specs/08-
// segregation.md §6): move an already-`--split` module tree into a real
// project layout — `node_modules/<pkg>/` for library-classified modules,
// `src/` for custom-classified ones, `_unclassified/` for anything
// `classify.ts` couldn't call either way (§4 "no silent loss") — and
// "milestone 2": name the `src/` modules from single-module signals (§2.1
// steps 1-5: entry, App-registration, displayName, default-export
// identifier, createSlice) instead of leaving every custom module
// `module_<id>.js`.
//
// Segregation changes zero semantics (spec §4): the only bytes this module
// ever rewrites are (a) a `require(...)` call's string-literal argument
// when the target module moved, (b) a renamed file's header comment (one
// line prepended, never touching the factory body itself), and (c) the
// loader `index.js`'s own bookkeeping (module registration `require()` list
// + the `Module._load` interception, now a MODULES.json-driven id->path map
// instead of a `module_<id>.js` filename regex, since milestone 2 gives
// modules free-form names/directories) — never a factory function's body.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ClassificationReport, ModuleClassKind } from "../deps/classify.ts";
import type { DepsReport, ModuleOwnership } from "../deps/report.ts";

export type SegregationBucket = "src" | "node_modules" | "unclassified";

export interface SegregatedModuleInfo {
  readonly id: number;
  readonly originalFile: string;
  /** Path of the module's file, relative to the segregated tree's root
   *  (posix separators, e.g. `"src/App.js"`, `"src/store/counterSlice.js"`,
   *  `"src/module_5.js"` (no naming signal), `"node_modules/react-
   *  native/module_2.js"`, `"node_modules/_vendor/module_9.js"`). */
  readonly newPath: string;
  readonly bucket: SegregationBucket;
  readonly classification: ModuleClassKind | null;
  readonly package: string | null;
  /** Milestone 2 (§2.1): which naming step fired, if any (`null` for
   *  node_modules/unclassified modules and for `src/` modules with no
   *  signal above the confidence floor — those keep `module_<id>.js`). */
  readonly nameSignal: string | null;
  readonly nameConfidence: number | null;
}

/** §2.1 naming candidate for a single `src/`-bucket module: a step fired on
 *  the module's own decompiled text (plus, for `app-registration`, a cheap
 *  pattern check rather than a verified require-hop — see `detectAppRegistration`)
 *  and produced a base name plus the sub-directory it routes to (2.2). Not
 *  yet collision-resolved or floor-checked — `nameCustomModules` does both. */
interface NameCandidate {
  readonly baseName: string;
  readonly dir: "src" | "src/store";
  readonly confidence: number;
  readonly signal: string;
}

const MIN_NAME_CONFIDENCE = 0.6; // spec §2.1 "Confidence floor", default; --min-name-confidence not wired yet (no caller passes a different value)

function detectAppRegistration(text: string): { confidence: number } | null {
  if (!text.includes("AppRegistry") || !text.includes(".registerComponent(")) return null;
  const call = /\.registerComponent\(\s*([^,]+),/.exec(text);
  if (call === null) return null;
  const arg = call[1]!.trim();
  if (/^(['"]).*\1$/.test(arg)) return { confidence: 0.95 }; // literal name argument
  // One-hop resolve shape confirmed on rn-template-0.72 module_0.js (spec
  // §2.1 step 2): `<v> = require("./module_N.js"); <v> = <v>.name;` feeding
  // the call — pattern-matched here, not content-verified against the
  // target module's text (milestone-2 scope simplification: the *file*
  // segregation names is always `App.js` regardless of the resolved
  // literal, which only ever seeds `package.json`'s `"name"` — not
  // implemented this milestone — so verifying the literal buys nothing yet).
  const hopRe = /(\w+)\s*=\s*require\((['"])\.\/module_\d+\.js\2\);\s*\n\s*\1\s*=\s*\1\.name;/;
  if (hopRe.test(text)) return { confidence: 0.8 };
  return null;
}

function detectDisplayName(text: string): { name: string; confidence: number } | null {
  const m = /\.displayName\s*=\s*(['"])([^'"]+)\1/.exec(text);
  return m === null ? null : { name: m[2]!, confidence: 0.9 };
}

function detectDefaultExportIdentifier(text: string): { name: string; confidence: number } | null {
  const declared = new Set<string>();
  for (const m of text.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)) declared.add(m[1]!);
  for (const m of text.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)\b/g)) declared.add(m[1]!);
  declared.delete("factory"); // src/split/index.ts's own wrapper name, never a source identifier
  for (const m of text.matchAll(/\.exports(?:\.default)?\s*=\s*([A-Za-z_$][\w$]*)\s*;/g)) {
    const ident = m[1]!;
    if (declared.has(ident)) return { name: ident, confidence: 0.7 };
  }
  return null;
}

function detectCreateSlice(text: string): { name: string; confidence: number } | null {
  const m = /createSlice\(\s*\{[^}]*\bname:\s*(['"])([^'"]+)\1/.exec(text);
  return m === null ? null : { name: m[2]!, confidence: 0.9 };
}

/** §2.1 steps 1-5, in priority order, applied per module. Reads only this
 *  module's own decompiled text (`text`) plus whether it is the split
 *  tree's entry (`isEntry`, from `MODULES.json.entry`) — no cross-module
 *  walking (milestone 3).
 *
 *  Documented deviation from the literal spec ordering ("entry ... always,
 *  regardless of any other signal"): on a real app the bundle's entry
 *  module is *usually* a thin wrapper distinct from the registered
 *  component, but on a minimal one-file app (rn-template-0.72's module 0)
 *  the entry module *is* the one calling `AppRegistry.registerComponent`
 *  directly. Naming that module `index.js` would bury the one signal an
 *  analyst actually wants (`App.js`, the registered component) behind a
 *  generic bootstrap name that, in this collapsed case, describes nothing
 *  else. When both signals fire on the *same* module, `app-registration`
 *  wins; an entry module with no `registerComponent` call of its own still
 *  gets `index.js` as spec'd. */
function nameCandidateFor(text: string, isEntry: boolean): NameCandidate | null {
  const appReg = detectAppRegistration(text);
  if (isEntry) {
    if (appReg !== null) return { baseName: "App", dir: "src", confidence: appReg.confidence, signal: "app-registration (entry module also calls registerComponent, §6 milestone-2 note)" };
    return { baseName: "index", dir: "src", confidence: 1.0, signal: "entry" };
  }
  if (appReg !== null) return { baseName: "App", dir: "src", confidence: appReg.confidence, signal: "app-registration" };
  const displayName = detectDisplayName(text);
  if (displayName !== null) return { baseName: displayName.name, dir: "src", confidence: displayName.confidence, signal: "displayName" };
  const defaultExport = detectDefaultExportIdentifier(text);
  if (defaultExport !== null) return { baseName: defaultExport.name, dir: "src", confidence: defaultExport.confidence, signal: "default-export-identifier" };
  const slice = detectCreateSlice(text);
  if (slice !== null) return { baseName: `${slice.name}Slice`, dir: "src/store", confidence: slice.confidence, signal: "createSlice" };
  return null;
}

/** Assigns §2.1 names to every `src`-bucket module: computes a candidate per
 *  module (`nameCandidateFor`), applies the confidence floor, then resolves
 *  same-path collisions deterministically by *module id* order (spec §2.1
 *  "Collisions" — open question 6.2 asks about a more stable disambiguator
 *  across incremental re-runs; this ships the spec's own stopgap, a numeric
 *  ordinal suffix, since Fred hasn't ruled on 6.2 yet). Returns the final
 *  `src/...`-relative path (or `null`, meaning "keep `module_<id>.js`") plus
 *  the signal/confidence used, per module id, for the header comment and
 *  audit trail (`MODULES.json`'s `segregated` field). */
function nameCustomModules(srcModules: readonly { id: number; text: string }[], entryId: number | null): Map<number, { path: string; signal: string; confidence: number } | null> {
  const raw = new Map<number, NameCandidate | null>();
  for (const m of srcModules) raw.set(m.id, nameCandidateFor(m.text, m.id === entryId));

  const byPath = new Map<string, number[]>();
  for (const [id, cand] of raw) {
    if (cand === null || cand.confidence < MIN_NAME_CONFIDENCE) continue;
    const path = cand.dir === "src/store" ? `src/store/${cand.baseName}.js` : `src/${cand.baseName}.js`;
    const list = byPath.get(path);
    if (list === undefined) byPath.set(path, [id]);
    else list.push(id);
  }

  const finalPathById = new Map<number, string>();
  for (const [path, ids] of byPath) {
    ids.sort((a, b) => a - b); // id-ordered collision suffixing (spec §2.1 "Collisions"; open Q 6.2: ordinal vs. hash — default ordinal)
    ids.forEach((id, i) => {
      if (i === 0) { finalPathById.set(id, path); return; }
      const dot = path.lastIndexOf(".js");
      finalPathById.set(id, `${path.slice(0, dot)}.${i + 1}${path.slice(dot)}`);
    });
  }

  const result = new Map<number, { path: string; signal: string; confidence: number } | null>();
  for (const [id, cand] of raw) {
    const path = finalPathById.get(id);
    result.set(id, path === undefined || cand === null ? null : { path, signal: cand.signal, confidence: cand.confidence });
  }
  return result;
}

export interface SegregateResult {
  /** Every file to write, keyed by path relative to the segregated tree's
   *  root — module files, the rewritten `index.js` loader, and the
   *  annotated `MODULES.json`. */
  readonly files: ReadonlyMap<string, string>;
  readonly modules: readonly SegregatedModuleInfo[];
}

interface SplitModulesJson {
  readonly hbcVersion: number;
  readonly moduleCount: number;
  readonly entry: number | null;
  readonly modules: readonly { id: number; file: string; factoryFunctionIndex: number; deps: readonly number[] }[];
}

const REQUIRE_RE = /require\((['"])\.\/module_(\d+)\.js\1\)/g;

/** The exact `Module._load` interception block `buildLoaderIndexJs`
 *  (src/split/index.ts) always emits — literal source text, not a JS
 *  RegExp value. Milestone 1 could get away with loosening this to a
 *  filename-suffix match (`/module_(\d+)\.js$/`) because every module kept
 *  its `module_<id>.js` name, just in a new directory. Milestone 2 gives
 *  `src/` modules free-form names (`App.js`, `store/counterSlice.js`, ...),
 *  so recovering a module id from the request string by filename no longer
 *  works at all — this whole block is replaced (see `buildPathMapLoadBlock`
 *  below) with a static id->absolute-path map built from the same
 *  `idToNewPath` this module already computes, resolved once against
 *  `index.js`'s own directory (the segregated tree's root). */
const LOADER_LOAD_BLOCK = [
  `var __hbc_split_Module = require("module");`,
  `var __hbc_split_origLoad = __hbc_split_Module._load;`,
  `__hbc_split_Module._load = function (request, parent, isMain) {`,
  `  var m = /^\\.\\/module_(\\d+)\\.js$/.exec(request);`,
  `  if (m) return __r(Number(m[1]));`,
  `  return __hbc_split_origLoad.apply(this, arguments);`,
  `};`,
].join("\n");

function buildPathMapLoadBlock(modules: readonly { id: number; file: string }[], idToNewPath: ReadonlyMap<number, string>): string {
  const lines: string[] = [];
  lines.push(`var __hbc_split_path = require("path");`);
  lines.push(`var __hbc_split_Module = require("module");`);
  lines.push(`var __hbc_split_origLoad = __hbc_split_Module._load;`);
  lines.push(`var __hbc_split_idByAbsPath = new Map();`);
  for (const m of modules) {
    const target = idToNewPath.get(m.id);
    if (target === undefined) continue;
    lines.push(`__hbc_split_idByAbsPath.set(__hbc_split_path.join(__dirname, ${JSON.stringify(target)}), ${m.id});`);
  }
  lines.push(`__hbc_split_Module._load = function (request, parent, isMain) {`);
  lines.push(`  if (parent && typeof request === "string" && request.charAt(0) === ".") {`);
  lines.push(`    var __hbc_resolved = __hbc_split_path.resolve(__hbc_split_path.dirname(parent.filename), request);`);
  lines.push(`    var __hbc_id = __hbc_split_idByAbsPath.get(__hbc_resolved);`);
  lines.push(`    if (__hbc_id !== undefined) return __r(__hbc_id);`);
  lines.push(`  }`);
  lines.push(`  return __hbc_split_origLoad.apply(this, arguments);`);
  lines.push(`};`);
  return lines.join("\n");
}

function packageDirName(pkg: string): string {
  // Scoped packages (`@scope/name`) become a two-level `node_modules/`
  // directory, same as npm itself — no sanitisation needed beyond that,
  // `pkg` comes from `moduleOwnership.package`, already a valid npm name.
  return pkg;
}

/** Posix-relative require specifier from `fromPath` (a file's own new path,
 *  relative to the segregated tree root) to `toPath` (another file's new
 *  path), always `./`- or `../`-prefixed. */
function relativeRequire(fromPath: string, toPath: string): string {
  const fromDir = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : "";
  const fromParts = fromDir === "" ? [] : fromDir.split("/");
  const toParts = toPath.split("/");
  let i = 0;
  while (i < fromParts.length && i < toParts.length - 1 && fromParts[i] === toParts[i]) i++;
  const ups = fromParts.length - i;
  const downs = toParts.slice(i);
  const rel = [...Array(ups).fill(".."), ...downs].join("/");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

function rewriteRequireStrings(content: string, ownPath: string, idToNewPath: ReadonlyMap<number, string>): string {
  return content.replace(REQUIRE_RE, (whole, quote: string, idStr: string) => {
    const id = Number(idStr);
    const target = idToNewPath.get(id);
    if (target === undefined) return whole; // unreachable in practice: every id in MODULES.json has a bucket
    const spec = relativeRequire(ownPath, target);
    return `require(${quote}${spec}${quote})`;
  });
}

/** Rewrites the `--split` loader's `index.js` (src/split/index.ts
 *  `buildLoaderIndexJs`) to (a) require every module from its new path and
 *  (b) recognise a require request for a moved module regardless of its
 *  new directory (see `LOADER_INTERCEPT_RE_SOURCE`). Structural changes to
 *  the loader's own bookkeeping, not a module factory body — outside the
 *  scope of the §4.1 byte-diff proof, which is about `module_<id>.js`
 *  files only. */
function rewriteLoaderIndexJs(original: string, modules: readonly { id: number; file: string }[], idToNewPath: ReadonlyMap<number, string>): string {
  let out = original;
  for (const m of modules) {
    const target = idToNewPath.get(m.id);
    if (target === undefined) continue;
    const oldReq = `require('./${m.file}');`;
    const newReq = `require('./${target}');`;
    out = out.split(oldReq).join(newReq);
  }
  if (!out.includes(LOADER_LOAD_BLOCK)) throw new Error("segregate: index.js did not contain the expected Module._load interception pattern");
  return out.split(LOADER_LOAD_BLOCK).join(buildPathMapLoadBlock(modules, idToNewPath));
}

/** Milestone 1 (docs/specs/08-segregation.md §6): buckets every module by
 *  `classification.classification` alone (never re-derived here — the spec
 *  is explicit that segregation reads classify.ts's verdict, it does not
 *  recompute it) and, for `library` modules, names the `node_modules/`
 *  directory from `moduleOwnership` when a confirmed package exists,
 *  falling back to one flat `node_modules/_vendor/` bucket otherwise (the
 *  spec's provisional flat-bucket option, open question 6.4 — per-hash
 *  subdirectories are a later refinement pending Fred). A module with no
 *  classification at all (no `--deps-report` given, or the module id isn't
 *  present in the report) is never guessed into either bucket — it lands
 *  in `_unclassified/` (spec §4 "no silent loss"). */
export function segregateSplitTree(splitFiles: ReadonlyMap<string, string>, deps: DepsReport | null): SegregateResult {
  const modulesJsonText = splitFiles.get("MODULES.json");
  if (modulesJsonText === undefined) throw new Error("segregate: split tree has no MODULES.json");
  const modulesJson = JSON.parse(modulesJsonText) as SplitModulesJson;

  const classification: ClassificationReport | null = deps?.classification ?? null;
  const classByModule = new Map<number, ModuleClassKind>();
  if (classification !== null) {
    for (const c of classification.modules) if (c.localModuleId !== null) classByModule.set(c.localModuleId, c.classification);
  }
  const ownershipByModule = new Map<number, ModuleOwnership>();
  if (deps !== null) {
    for (const o of deps.moduleOwnership) if (o.localModuleId !== null) ownershipByModule.set(o.localModuleId, o);
  }

  const idToNewPath = new Map<number, string>();
  const infos: SegregatedModuleInfo[] = [];
  for (const m of modulesJson.modules) {
    const cls = classByModule.get(m.id) ?? null;
    let bucket: SegregationBucket;
    let newPath: string;
    let pkg: string | null = null;
    if (cls === "library") {
      bucket = "node_modules";
      const owner = ownershipByModule.get(m.id);
      if (owner !== undefined) {
        pkg = owner.package;
        newPath = `node_modules/${packageDirName(pkg)}/module_${m.id}.js`;
      } else {
        newPath = `node_modules/_vendor/module_${m.id}.js`;
      }
    } else if (cls === "custom") {
      bucket = "src";
      newPath = `src/module_${m.id}.js`;
    } else {
      bucket = "unclassified";
      newPath = `_unclassified/module_${m.id}.js`;
    }
    idToNewPath.set(m.id, newPath);
    infos.push({ id: m.id, originalFile: m.file, newPath, bucket, classification: cls, package: pkg, nameSignal: null, nameConfidence: null });
  }
  infos.sort((a, b) => a.id - b.id);

  // Milestone 2 (§2.1 steps 1-5): name every `src`-bucket module from its
  // own decompiled text (plus entry-ness from MODULES.json) — never
  // node_modules/_unclassified modules, which keep module_<id>.js per §6
  // milestone 1.
  const srcTexts: { id: number; text: string }[] = [];
  for (const info of infos) {
    if (info.bucket !== "src") continue;
    const text = splitFiles.get(info.originalFile);
    if (text === undefined) throw new Error(`segregate: split tree has no file for module ${info.id} (${info.originalFile})`);
    srcTexts.push({ id: info.id, text });
  }
  const namesById = nameCustomModules(srcTexts, modulesJson.entry);
  for (let i = 0; i < infos.length; i++) {
    const info = infos[i]!;
    if (info.bucket !== "src") continue;
    const named = namesById.get(info.id) ?? null;
    if (named === null) continue;
    idToNewPath.set(info.id, named.path);
    infos[i] = { ...info, newPath: named.path, nameSignal: named.signal, nameConfidence: named.confidence };
  }

  const files = new Map<string, string>();
  for (const info of infos) {
    const original = splitFiles.get(info.originalFile);
    if (original === undefined) throw new Error(`segregate: split tree has no file for module ${info.id} (${info.originalFile})`);
    const rewritten = rewriteRequireStrings(original, info.newPath, idToNewPath);
    const withHeader =
      info.nameSignal === null
        ? rewritten
        : `// hbc2js segregate -- Metro module ${info.id} (was module_${info.id}.js; named via ${info.nameSignal}, confidence ${info.nameConfidence!.toFixed(2)})\n${rewritten}`;
    files.set(info.newPath, withHeader);
  }

  const originalIndexJs = splitFiles.get("index.js");
  if (originalIndexJs === undefined) throw new Error("segregate: split tree has no index.js");
  files.set("index.js", rewriteLoaderIndexJs(originalIndexJs, modulesJson.modules, idToNewPath));

  files.set(
    "MODULES.json",
    JSON.stringify(
      {
        ...modulesJson,
        modules: modulesJson.modules.map((m) => {
          const info = infos.find((i) => i.id === m.id)!;
          return { ...m, segregated: { path: info.newPath, bucket: info.bucket, classification: info.classification, package: info.package, nameSignal: info.nameSignal, nameConfidence: info.nameConfidence } };
        }),
      },
      null,
      2,
    ) + "\n",
  );

  // Every other file in the split tree (there are none today besides the
  // three above — `splitProject` only ever emits module files, `index.js`,
  // `MODULES.json`) is intentionally not carried forward unmodified: if a
  // future split-tree gains a new top-level file this throws loudly at the
  // caller instead of silently shipping something segregation never
  // reasoned about.
  for (const [name] of splitFiles) {
    if (name === "index.js" || name === "MODULES.json") continue;
    if (!infos.some((i) => i.originalFile === name)) {
      throw new Error(`segregate: split tree has an unexpected top-level file ${name} segregation does not know how to place`);
    }
  }

  return { files, modules: infos };
}

/** Reads a `--split`-written directory (top-level files only —
 *  `writeSplitResult`/`splitProject` never nest) into the
 *  `Map<string, string>` `segregateSplitTree` expects. */
export function readSplitDir(splitDir: string): ReadonlyMap<string, string> {
  const files = new Map<string, string>();
  for (const name of readdirSync(splitDir)) {
    files.set(name, readFileSync(join(splitDir, name), "utf8"));
  }
  return files;
}

export function writeSegregateResult(result: SegregateResult, outDir: string): void {
  for (const [relPath, content] of result.files) {
    const dest = join(outDir, relPath);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
  }
}
