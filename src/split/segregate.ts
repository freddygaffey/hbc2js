// src/split/segregate.ts — D17i stage 3 "milestone 1" (docs/specs/08-segregation.md
// §6): move an already-`--split` module tree into a real project layout —
// `node_modules/<pkg>/` for library-classified modules, `src/` for
// custom-classified ones, `_unclassified/` for anything `classify.ts`
// couldn't call either way (§4 "no silent loss") — with **zero** naming
// heuristics (that's milestone 2): every module keeps `module_<id>.js`,
// only its containing directory changes.
//
// Segregation changes zero semantics (spec §4): the only bytes this module
// ever rewrites are (a) a `require(...)` call's string-literal argument
// when the target module moved, and (b) the loader `index.js`'s own
// bookkeeping (module registration `require()` list + the `Module._load`
// interception pattern) — never a factory function's body.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ClassificationReport, ModuleClassKind } from "../deps/classify.ts";
import type { DepsReport, ModuleOwnership } from "../deps/report.ts";

export type SegregationBucket = "src" | "node_modules" | "unclassified";

export interface SegregatedModuleInfo {
  readonly id: number;
  readonly originalFile: string;
  /** Path of the module's file, relative to the segregated tree's root
   *  (posix separators, e.g. `"src/module_5.js"`, `"node_modules/react-
   *  native/module_2.js"`, `"node_modules/_vendor/module_9.js"`). */
  readonly newPath: string;
  readonly bucket: SegregationBucket;
  readonly classification: ModuleClassKind | null;
  readonly package: string | null;
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
/** Milestone 1 never renames a file (every module keeps `module_<id>.js`,
 *  spec §6 milestone 1) — module ids are unique, so recovering the id from
 *  a require request needs only the filename suffix, not its directory,
 *  regardless of how deep segregation nests it. Replaces the un-segregated
 *  loader's `^\.\/module_(\d+)\.js$` (src/split/index.ts) which assumed
 *  every module sat flat next to `index.js`. Both are the literal regex
 *  *source text* as it appears inside the generated `index.js` file (not a
 *  JS RegExp value — `buildLoaderIndexJs` writes it as a plain string). */
const LOADER_INTERCEPT_RE_OLD = "/^\\.\\/module_(\\d+)\\.js$/";
const LOADER_INTERCEPT_RE_NEW = "/module_(\\d+)\\.js$/";

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
  const replaced = out.split(LOADER_INTERCEPT_RE_OLD).join(LOADER_INTERCEPT_RE_NEW);
  if (replaced === out) throw new Error("segregate: index.js did not contain the expected Module._load interception pattern");
  return replaced;
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
    infos.push({ id: m.id, originalFile: m.file, newPath, bucket, classification: cls, package: pkg });
  }
  infos.sort((a, b) => a.id - b.id);

  const files = new Map<string, string>();
  for (const info of infos) {
    const original = splitFiles.get(info.originalFile);
    if (original === undefined) throw new Error(`segregate: split tree has no file for module ${info.id} (${info.originalFile})`);
    files.set(info.newPath, rewriteRequireStrings(original, info.newPath, idToNewPath));
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
          return { ...m, segregated: { path: info.newPath, bucket: info.bucket, classification: info.classification, package: info.package } };
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
