// Sweep 2026-09-03 finding 2: several gate/artifact test files independently
// `decompile()`/`splitProject()` the *same* bundle (rn-template-0.72) with
// the *same* options — the single heaviest repeated unit of gate wall time.
//
// `node --test` runs each `*.test.ts` as its own child process (verified
// empirically; there is no `--experimental-test-isolation=none` in use
// here), so a plain in-memory memo only pays off for repeated calls *inside*
// one file — most of these files already get that for free via a
// module-scope `const result = splitProject(...)`. The actual cross-file win
// needs a cache that survives process exit: this stores the full
// `decompile()`/`splitProject()` result on disk in `os.tmpdir()`, using
// `node:v8`'s structured-clone serializer (not JSON — `DecompileResult` and
// `SplitResult` carry `Map`s and `Uint8Array`s that JSON can't round-trip),
// keyed by (bundle bytes hash, options, a fingerprint of every `src/**/*.ts`
// file's size+mtime). Any edit under `src/` changes the fingerprint and the
// next call recomputes and overwrites the entry — a stale hit is not
// possible without also touching mtimes, and a partial write can't corrupt a
// reader because writes land in a temp file first and are renamed into place
// (atomic on both POSIX filesystems this project targets).
//
// This is deliberately narrow: it caches `decompile`/`splitProject`
// directly, not the tool-level wrappers (`measureApp`, `measureJsxRecoverBundle`,
// …) that read their own bytes and call them internally — those stay
// uncached here (see docs/AGENT-LOG.md's 2026-09-03 entry for the list).
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deserialize, serialize } from "node:v8";
import { analyseModule } from "../../src/cfg/index.ts";
import { decompile as decompileImpl, parseForDecompile } from "../../src/decompile.ts";
import type { DecompileOptions, DecompileResult } from "../../src/decompile.ts";
import { parseHbc } from "../../src/parse/module.ts";
import { splitProject as splitProjectImpl } from "../../src/split/index.ts";
import type { SplitOptions, SplitResult } from "../../src/split/index.ts";
import { repoRoot } from "./paths.ts";

let srcFingerprintCache: string | undefined;

/** sha1 of every `src/**\/*.ts` file's path+size+mtime. Cheap (a few hundred
 *  `stat`s) and memoised per process; recomputing per call would still be
 *  fine but there is no reason to pay it twice in one file. */
function srcFingerprint(): string {
  if (srcFingerprintCache !== undefined) return srcFingerprintCache;
  const h = createHash("sha1");
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      const st = statSync(p);
      h.update(`${p}:${st.size}:${st.mtimeMs}\n`);
    }
  };
  walk(join(repoRoot(), "src"));
  srcFingerprintCache = h.digest("hex");
  return srcFingerprintCache;
}

function cacheDir(): string {
  const dir = join(tmpdir(), "hbc2js-test-decompile-cache-v1");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Deterministic (key-sorted) stringify — good enough for the plain
 *  string/number/boolean/array option shapes `DecompileOptions`/`SplitOptions`
 *  actually use; not a general-purpose canonicaliser. */
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "undefined";
}

function cacheKey(kind: string, bytes: Uint8Array, opts: unknown): string {
  const h = createHash("sha1");
  h.update(kind).update(":").update(bytes).update(":").update(stableStringify(opts)).update(":").update(srcFingerprint());
  return h.digest("hex");
}

function readCache<T>(key: string): T | undefined {
  try {
    return deserialize(readFileSync(join(cacheDir(), `${key}.v8`))) as T;
  } catch {
    return undefined;
  }
}

function writeCache(key: string, value: unknown): void {
  const dir = cacheDir();
  const target = join(dir, `${key}.v8`);
  const tmp = join(dir, `.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
  try {
    writeFileSync(tmp, serialize(value));
    renameSync(tmp, target);
  } catch {
    // Best-effort cache: a write race, a full disk or a shared-tmpdir
    // permission wrinkle must never fail a test that would otherwise pass.
  }
}

// `DecompileResult.module`/`SplitResult.module`+`.analysis` are excluded
// from the cached blob: `HbcModule.sections` embeds a real closure
// (`src/parse/sections.ts`'s `span()`), which `v8.serialize` refuses (it
// throws for the whole value, not just that field), and `ModuleAnalysis` is
// large enough that serialising it is not obviously a win either. Both are
// cheap to rebuild on a cache hit — `parseHbc`/`parseForDecompile` take
// ~15 ms and `analyseModule` ~65 ms on the RN template bundle, against a
// multi-second `decompile`/`splitProject` — and `splitProject`/`decompile`
// call them with fixed arguments (`parseHbc(bytes)`,
// `analyseModule(module, { strictEnv: false })` for split; `parseForDecompile
// (bytes, opts)`, `analyseModule(module, { strictEnv, ...opts.analysis })`
// for decompile), so the rebuild is exact, not an approximation.
type CachedDecompile = Omit<DecompileResult, "module">;

/** Memoised `decompile()` — same bytes + same options (deep-equal, not
 *  reference-equal) returns the same `DecompileResult`, computed at most
 *  once across every process in a single `npm test` run (and reused by
 *  later runs on the same machine, until `src/**` or the inputs change). */
export function cachedDecompile(bytes: Uint8Array, opts: DecompileOptions = {}): DecompileResult {
  const key = cacheKey("decompile", bytes, opts);
  const hit = readCache<CachedDecompile>(key);
  if (hit !== undefined) {
    const { module } = parseForDecompile(bytes, opts);
    return { ...hit, module };
  }
  const result = decompileImpl(bytes, opts);
  const { module: _module, ...cacheable } = result;
  writeCache(key, cacheable);
  return result;
}

type CachedSplit = Omit<SplitResult, "module" | "analysis">;

/** Memoised `splitProject()`, same contract as `cachedDecompile`. */
export function cachedSplitProject(bytes: Uint8Array, opts: SplitOptions = {}): SplitResult {
  const key = cacheKey("split", bytes, opts);
  const hit = readCache<CachedSplit>(key);
  if (hit !== undefined) {
    const module = parseHbc(bytes);
    const analysis = analyseModule(module, { strictEnv: false });
    return { ...hit, module, analysis };
  }
  const result = splitProjectImpl(bytes, opts);
  const { module: _module, analysis: _analysis, ...cacheable } = result;
  writeCache(key, cacheable);
  return result;
}
