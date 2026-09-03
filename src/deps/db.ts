// src/deps/db.ts — the D17b layered signature-DB: project-local -> user
// cache -> shared, one file format across all three so a project DB can be
// contributed upstream by copying (docs/DECISIONS.md D17b).
//
// Lookup order (first hit wins for a given package@version+hbcVersion):
//   1. project-local: `<outDir>/.hbc2js/sigdb/` (or `--sigdb <dir>`), written
//      by `hbc2js deps --confirm` so a decompilation project's results are
//      reproducible offline.
//   2. user cache: `~/.cache/hbc2js/sigdb/` (respects `XDG_CACHE_HOME`).
//   3. shared: `tools/pkgsig/db/` in this repo (the D17/T8 starter set),
//      disabled by `--no-shared-db`.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { packageNameFromSigFilename } from "./candidates.ts";
import type { SigDbFile, SigDbIndex, SigDbIndexEntry } from "./sigdb-types.ts";

export type DbLayerName = "project" | "user" | "shared";

export interface DbLayer {
  readonly name: DbLayerName;
  readonly dir: string;
}

export interface DbLayerOptions {
  /** Decompile output directory; project-local DB lives at `<outDir>/.hbc2js/sigdb`. */
  readonly outDir?: string;
  /** Overrides the project-local directory outright. */
  readonly sigdb?: string;
  readonly noSharedDb?: boolean;
}

/** `<repo-or-package-root>/tools/pkgsig/db` — works both from `src/deps/db.ts`
 *  (dev, `src/deps` -> repo root is two levels up) and from the built
 *  `dist/deps/db.js` (an npm install ships `tools/pkgsig/db` alongside
 *  `dist/`, see `package.json`'s `files`), since both sit two levels below
 *  the package root. */
export function defaultSharedDbDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "tools", "pkgsig", "db");
}

export function userCacheDbDir(): string {
  const base = process.env.XDG_CACHE_HOME && process.env.XDG_CACHE_HOME.length > 0 ? process.env.XDG_CACHE_HOME : join(homedir(), ".cache");
  return join(base, "hbc2js", "sigdb");
}

export function projectDbDir(opts: DbLayerOptions): string {
  if (opts.sigdb !== undefined) return opts.sigdb;
  return join(opts.outDir ?? ".", ".hbc2js", "sigdb");
}

export function resolveDbLayers(opts: DbLayerOptions): DbLayer[] {
  const layers: DbLayer[] = [
    { name: "project", dir: projectDbDir(opts) },
    { name: "user", dir: userCacheDbDir() },
  ];
  if (!opts.noSharedDb) layers.push({ name: "shared", dir: defaultSharedDbDir() });
  return layers;
}

export interface LoadedSig {
  readonly file: SigDbFile;
  readonly layer: DbLayerName;
  readonly path: string;
}

function listJsonFiles(dir: string, candidates?: ReadonlySet<string>): string[] {
  const files: string[] = [];
  if (!existsSync(dir)) return files;
  for (const name of readdirSync(dir)) {
    if (name === "index.json") continue;
    if (!name.endsWith(".json")) continue;
    // Evidence-directed filtering (QUEUE 22a, `candidates.ts`): when a
    // candidate set is given, skip any non-baseline file whose own
    // filename-derived package name isn't in it — this is what turns
    // "read and JSON.parse every signature file" into "read only the ones
    // the bundle's own strings gave a reason to check". `candidates`
    // undefined (the default for every existing caller of `loadSignatures`)
    // preserves the exact previous exhaustive behaviour.
    if (candidates !== undefined) {
      const pkg = packageNameFromSigFilename(name);
      if (pkg === null || !candidates.has(pkg)) continue;
    }
    files.push(join(dir, name));
  }
  // Baselines are foundational subtraction data (react/react-native/metro
  // "empty app" noise floors), not named npm packages a bundle's strings
  // could ever give evidence for — always loaded in full, regardless of
  // candidates, same as before this task.
  const baselines = join(dir, "_baselines");
  if (existsSync(baselines)) {
    for (const name of readdirSync(baselines)) {
      if (name.endsWith(".json")) files.push(join(baselines, name));
    }
  }
  return files;
}

function keyOf(f: SigDbFile): string {
  return `${f.package}@${f.version}__hbc${f.hbcVersion}`;
}

export interface LoadSignaturesOptions {
  /** Evidence-directed candidate set (QUEUE 22a, `candidates.ts`): when
   *  given, `user`/`shared` layers only load a non-baseline signature file
   *  whose own package name is in this set (baselines always load in full
   *  — see `listJsonFiles`). The `project` layer always loads in full
   *  regardless — it's small (this project's own `--confirm` results) and
   *  explicit, not something string-evidence should gate. Omitted (every
   *  existing caller before this task) preserves the exact previous
   *  exhaustive behaviour. */
  readonly candidates?: ReadonlySet<string>;
}

/**
 * Load every signature file across the given layers, in priority order,
 * deduplicating by `package@version` x HBC version so a project-local
 * confirmation shadows a stale shared/user-cache copy rather than being
 * matched twice.
 */
export function loadSignatures(layers: readonly DbLayer[], opts: LoadSignaturesOptions = {}): LoadedSig[] {
  const seen = new Set<string>();
  const out: LoadedSig[] = [];
  for (const layer of layers) {
    const candidates = layer.name === "project" ? undefined : opts.candidates;
    for (const path of listJsonFiles(layer.dir, candidates)) {
      let file: SigDbFile;
      try {
        file = JSON.parse(readFileSync(path, "utf8")) as SigDbFile;
      } catch {
        continue;
      }
      const key = keyOf(file);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ file, layer: layer.name, path });
    }
  }
  return out;
}

/** Write (or overwrite) one signature file into `dir` and update its
 *  `index.json` manifest. Used by the confirm stage (project-local + user
 *  cache) and by whoever seeds/rebuilds the shared DB. */
export function writeSignature(dir: string, db: SigDbFile): string {
  const outDir = db.toolchainBaseline ? join(dir, "_baselines") : dir;
  mkdirSync(outDir, { recursive: true });
  const safeName = db.package.replace(/\//g, "__");
  const outPath = join(outDir, `${safeName}@${db.version}__hbc${db.hbcVersion}.json`);
  writeFileSync(outPath, JSON.stringify(db));
  updateIndex(dir, {
    package: db.package,
    version: db.version,
    hbcVersion: db.hbcVersion,
    path: relative(dir, outPath),
    totalFunctions: db.totalFunctions,
    isBaseline: db.toolchainBaseline,
  });
  return outPath;
}

function updateIndex(dbDir: string, entry: SigDbIndexEntry): void {
  mkdirSync(dbDir, { recursive: true });
  const indexPath = join(dbDir, "index.json");
  let index: SigDbIndex = { schema: 1, entries: [] };
  if (existsSync(indexPath)) {
    try {
      index = JSON.parse(readFileSync(indexPath, "utf8")) as SigDbIndex;
    } catch {
      index = { schema: 1, entries: [] };
    }
  }
  index.entries = index.entries.filter((e) => !(e.package === entry.package && e.version === entry.version && e.hbcVersion === entry.hbcVersion));
  index.entries.push(entry);
  index.entries.sort((a, b) => (a.package < b.package ? -1 : a.package > b.package ? 1 : a.hbcVersion - b.hbcVersion));
  writeFileSync(indexPath, JSON.stringify(index, null, 1));
}
