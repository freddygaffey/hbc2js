// src/projdb/artifact-read.ts — §8 step 4 (docs/specs/16-project-db.md §3.2,
// §5.2): the DB-backed read path for `ArtifactService`. Loads the exact same
// row shapes `src/artifact/write.ts`'s JSONL readers produce, via prepared
// SELECTs over `ix_*`, so `ArtifactService` can populate its private maps
// identically regardless of backend — the verb layer (caps, slicing,
// truncation) is byte-for-byte the same code either way (§3.2's "same
// answers, same caps" is enforced by construction, not by parallel logic).
//
// Staleness (§5.2): `checkDbStaleness` mirrors the JSONL path's two checks
// (`E_STALE_RANGES` for a render-hash mismatch, `E_STALE_INDEX` for a
// bundle/producer mismatch) but reads its "current" value from `meta`
// instead of `ranges.jsonl`'s header / `manifest.index.builtFor`.
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ErrorCode, Hbc2jsError } from "../errors.ts";
import {
  ARTIFACT_SCHEMA,
  INDEX_SCHEMA,
  sha256Hex,
  type CallRow,
  type FunctionRow,
  type GlobalRow,
  type Manifest,
  type ModulesIndex,
  type NativeRow,
  type RangeRow,
  type StringRow,
  type StringUseRow,
  type StringsIndex,
} from "../artifact/schema.ts";
import { verifyProjectDb } from "./db.ts";

/** True iff `artifactDir` holds a `project.hbcproj` — the §4.3 backend
 *  selector every DB-aware constructor in `src/artifact/service.ts` and
 *  `src/project/service.ts` calls first. */
export function hasProjectDb(artifactDir: string): boolean {
  return existsSync(dbPath(artifactDir));
}

export function dbPath(artifactDir: string): string {
  return join(artifactDir, "project.hbcproj");
}

/** Opens `project.hbcproj` read-only for a query-time backend, verifying its
 *  identity pragmas + `meta.schema` (§1.1) — refuses a mismatch rather than
 *  guessing, same rule as `openProjectDb`. Read-only: query paths never
 *  write `ix_*` (§2.5 — only `rebuild-index`, §5.2, does). */
export function openProjectDbReadonly(artifactDir: string): DatabaseSync {
  const path = dbPath(artifactDir);
  const db = new DatabaseSync(path, { readOnly: true });
  verifyProjectDb(db, path);
  return db;
}

export function readMeta(db: DatabaseSync): Map<string, string> {
  const rows = db.prepare("SELECT key, value FROM meta").all() as { key: string; value: string }[];
  return new Map(rows.map((r) => [r.key, r.value]));
}

function metaGet(meta: Map<string, string>, key: string): string {
  const v = meta.get(key);
  if (v === undefined) throw new Hbc2jsError(ErrorCode.E_IO, `project.hbcproj: meta.${key} missing — not a fully-initialised project DB`);
  return v;
}

/** Builds a `Manifest`-shaped object from `meta` alone, for a DB project with
 *  no `manifest.json` on disk (§4.1's spec-10 build step has not yet been
 *  layered onto `hbc2js init`'s current CLI implementation — see AGENT-LOG).
 *  Every field the query verbs actually read (`bundle`, `producer`,
 *  `render.hash`, `index.builtFor`) is populated from `meta`; fields with no
 *  DB analogue (`render.form`/`ts`, `degraded`, `index.semanticHash`) get
 *  conservative defaults that are never compared against anything. */
export function synthesizeManifestFromMeta(meta: Map<string, string>): Manifest {
  const bundleSha256 = metaGet(meta, "bundle_sha256");
  const producerJson = metaGet(meta, "producer_json");
  const producer = JSON.parse(producerJson) as Manifest["producer"];
  return {
    schema: ARTIFACT_SCHEMA,
    bundle: {
      sha256: bundleSha256,
      bytes: Number(metaGet(meta, "bundle_bytes")),
      hbcVersion: Number(metaGet(meta, "hbc_version")),
      functionCount: Number(metaGet(meta, "function_count")),
    },
    producer,
    render: {
      hash: metaGet(meta, "render_hash"),
      form: "flat",
      ts: meta.get("created_at") ?? new Date(0).toISOString(),
      overlayHash: null,
    },
    index: {
      semanticHash: "",
      builtFor: { bundleSha256, producer: sha256Hex(producerJson) },
    },
  };
}

/** §5.2 staleness, DB-path version of `ArtifactService`'s JSONL-path checks:
 *  a `meta.render_hash` mismatch against the manifest's live render hash is
 *  `E_STALE_RANGES`; a `meta.bundle_sha256`/`producer_json` mismatch against
 *  the manifest's bundle/producer is `E_STALE_INDEX`. Called whenever a
 *  `manifest.json` independent of `meta` is available (i.e. every real-world
 *  layout, §4.1 step 1) — when it is not, `synthesizeManifestFromMeta` built
 *  the manifest FROM `meta`, so there is nothing independent to check against
 *  and this is skipped (never "answer anyway" against a wrong value — there
 *  is simply no second source in that configuration). */
export function checkDbStaleness(artifactDir: string, meta: Map<string, string>, manifest: Manifest): void {
  const renderHash = metaGet(meta, "render_hash");
  if (renderHash !== manifest.render.hash) {
    throw new Hbc2jsError(
      ErrorCode.E_STALE_RANGES,
      `${artifactDir}: project.hbcproj meta.render_hash (${renderHash}) != manifest.render.hash (${manifest.render.hash}) — ` +
        `run \`hbc2js render\` to regenerate before querying (docs/specs/16-project-db.md §5.2)`,
    );
  }
  const bundleSha256 = metaGet(meta, "bundle_sha256");
  const expectedIndexBuiltFor = sha256Hex(`${manifest.bundle.sha256}:${JSON.stringify(manifest.producer)}`);
  const indexBuiltFor = metaGet(meta, "index_built_for");
  if (bundleSha256 !== manifest.bundle.sha256 || indexBuiltFor !== expectedIndexBuiltFor) {
    throw new Hbc2jsError(
      ErrorCode.E_STALE_INDEX,
      `${artifactDir}: project.hbcproj's index was built for a different bundle/producer than this manifest — ` +
        `the semantic layer is stale (docs/specs/16-project-db.md §5.2); run \`hbc2js project rebuild-index\``,
    );
  }
}

export interface DbIndexRows {
  readonly functionRows: readonly FunctionRow[];
  readonly callRows: readonly CallRow[];
  readonly stringsIndex: StringsIndex;
  readonly stringUseRows: readonly StringUseRow[];
  readonly globalRows: readonly GlobalRow[];
  readonly nativeRows: readonly NativeRow[];
  readonly modulesIndex: ModulesIndex;
  readonly rangeRows: readonly RangeRow[];
}

/** Reads every `ix_*` table into the exact row shapes the JSONL loader
 *  produces (§2.4's "one table per JSONL kind" makes this a direct column
 *  mapping, no re-derivation) — prepared SELECTs, one per table, `ORDER BY`
 *  the table's own primary key (matching the `v_json_*` views' sort order,
 *  §3.1) so a DB-backed artifact iterates in the same order a JSONL one did. */
export function loadIndexRowsFromDb(db: DatabaseSync): DbIndexRows {
  const functionRows = (
    db.prepare("SELECT fn, name, params, module, parent, kind, offset, size FROM ix_functions ORDER BY fn").all() as {
      fn: number;
      name: string | null;
      params: number;
      module: number | null;
      parent: number | null;
      kind: FunctionRow["kind"];
      offset: number;
      size: number;
    }[]
  ).map((r) => ({ ...r }));

  const callRowsRaw = db.prepare("SELECT caller, site, callee, kind, via, why FROM ix_calls ORDER BY caller, site").all() as {
    caller: number;
    site: number;
    callee: string;
    kind: CallRow["kind"];
    via: string | null;
    why: string | null;
  }[];
  const callRows: CallRow[] = callRowsRaw.map((r) => ({
    caller: r.caller,
    site: r.site,
    callee: /^[0-9]+$/.test(r.callee) ? Number(r.callee) : r.callee,
    kind: r.kind,
    ...(r.via !== null ? { via: r.via } : {}),
    ...(r.why !== null ? { why: r.why } : {}),
  }));

  const stringRowsRaw = db.prepare("SELECT sid, v, len, sha256, head FROM ix_strings ORDER BY sid").all() as {
    sid: number;
    v: string | null;
    len: number;
    sha256: string | null;
    head: string | null;
  }[];
  const stringEntries: StringRow[] = stringRowsRaw.map((r) => (r.v !== null ? { sid: r.sid, v: r.v } : { sid: r.sid, len: r.len, sha256: r.sha256 as string, head: r.head as string }));
  const stringsIndex: StringsIndex = { schema: INDEX_SCHEMA, kind: "strings", renderIndependent: true, entries: stringEntries };

  const stringUseRows = db.prepare("SELECT sid, fn, role, n FROM ix_string_uses ORDER BY sid, fn, role").all() as unknown as StringUseRow[];
  const globalRows = db.prepare("SELECT g, fn, access, n FROM ix_globals ORDER BY g, fn, access").all() as unknown as GlobalRow[];
  const nativeRows = db.prepare("SELECT fn, surface, name, n FROM ix_native ORDER BY fn, surface, name").all() as unknown as NativeRow[];

  const moduleRowsRaw = db.prepare("SELECT id, file, factory_fn, segment FROM ix_modules ORDER BY id").all() as {
    id: number;
    file: string;
    factory_fn: number | null;
    segment: number;
  }[];
  const depsById = new Map<number, number[]>();
  for (const d of db.prepare("SELECT id, dep FROM ix_module_deps ORDER BY id, ord").all() as { id: number; dep: number }[]) {
    const list = depsById.get(d.id) ?? [];
    list.push(d.dep);
    depsById.set(d.id, list);
  }
  const fnOwnership: Record<string, number> = {};
  for (const f of functionRows) if (f.module !== null) fnOwnership[String(f.fn)] = f.module;
  const modulesIndex: ModulesIndex = {
    schema: INDEX_SCHEMA,
    kind: "modules",
    renderIndependent: true,
    modules: moduleRowsRaw.map((m) => ({ id: m.id, file: m.file, factoryFn: m.factory_fn, deps: depsById.get(m.id) ?? [], segment: m.segment })),
    entry: null,
    fnOwnership,
  };

  const rangeRowsRaw = db.prepare("SELECT fn, file, line_start, line_end FROM ix_ranges ORDER BY fn").all() as {
    fn: number;
    file: string;
    line_start: number;
    line_end: number;
  }[];
  const rangeRows: RangeRow[] = rangeRowsRaw.map((r) => ({ fn: r.fn, file: r.file, lines: [r.line_start, r.line_end] }));

  return { functionRows, callRows, stringsIndex, stringUseRows, globalRows, nativeRows, modulesIndex, rangeRows };
}
