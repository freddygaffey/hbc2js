// src/projdb/ix-write.ts — §8 step 2 (docs/specs/16-project-db.md §2.4,
// §4.1): writes an `IndexRows` bundle (`src/artifact/index-rows.ts`, the
// same extractors `src/artifact/write.ts` uses for JSONL) into an open
// project DB's `ix_*` tables, plus the `meta` identity rows and the `init` +
// `rebuild-index` `log` rows §4.1 steps 2/4 require. One transaction: a
// partial write can never be observed.
import type { DatabaseSync } from "node:sqlite";
import { sha256Hex, type CallRow, type FunctionRow, type GlobalRow, type ModulesIndex, type NativeRow, type RangeRow, type ResolvedCallRow, type StringsIndex, type StringUseRow } from "../artifact/schema.ts";
import { HOST_GLOBALS } from "../artifact/host-globals.ts";
import type { IndexRows } from "../artifact/index-rows.ts";

/** §2.4 `ix_functions` rows, in `FunctionRow` order (already `fn`-sorted by
 *  its builder; the table's own `PRIMARY KEY (fn)` is the source of truth,
 *  insertion order is not relied on elsewhere). */
function writeFunctions(db: DatabaseSync, rows: readonly FunctionRow[]): void {
  const stmt = db.prepare("INSERT INTO ix_functions (fn,name,params,module,parent,kind,offset,size) VALUES (?,?,?,?,?,?,?,?)");
  for (const r of rows) stmt.run(r.fn, r.name, r.params, r.module, r.parent, r.kind, r.offset, r.size);
}

/** §2.4 `ix_calls` rows. `callee` is stored TEXT always — a numeric
 *  `CalleeRef` becomes its decimal string form, matching `v_json_calls`'s
 *  `GLOB '[0-9]*'` reconstruction rule (schema.sql §3.1) exactly. */
function writeCalls(db: DatabaseSync, rows: readonly CallRow[]): void {
  const stmt = db.prepare("INSERT INTO ix_calls (caller,site,callee,kind,via,why) VALUES (?,?,?,?,?,?)");
  for (const r of rows) stmt.run(r.caller, r.site, String(r.callee), r.kind, r.via ?? null, r.why ?? null);
}

/** §2.4 `ix_strings` rows. Non-truncated `StringRow`s (`{sid,v}`) carry no
 *  `len` field in the JSONL shape (§2.3) — the column is `NOT NULL`, so it
 *  is derived here as `v.length` (chars, same unit `strings.ts`'s own
 *  `TRUNCATE_AT`/`v.length` truncation check uses). */
function writeStrings(db: DatabaseSync, index: StringsIndex): void {
  const stmt = db.prepare("INSERT INTO ix_strings (sid,v,len,sha256,head) VALUES (?,?,?,?,?)");
  for (const r of index.entries) {
    if ("v" in r) stmt.run(r.sid, r.v, r.v.length, null, null);
    else stmt.run(r.sid, null, r.len, r.sha256, r.head);
  }
}

function writeStringUses(db: DatabaseSync, rows: readonly StringUseRow[]): void {
  const stmt = db.prepare("INSERT INTO ix_string_uses (sid,fn,role,n) VALUES (?,?,?,?)");
  for (const r of rows) stmt.run(r.sid, r.fn, r.role, r.n);
}

function writeGlobals(db: DatabaseSync, rows: readonly GlobalRow[]): void {
  const stmt = db.prepare("INSERT INTO ix_globals (g,fn,access,n) VALUES (?,?,?,?)");
  for (const r of rows) stmt.run(r.g, r.fn, r.access, r.n);
}

function writeNative(db: DatabaseSync, rows: readonly NativeRow[]): void {
  const stmt = db.prepare("INSERT INTO ix_native (fn,surface,name,n) VALUES (?,?,?,?)");
  for (const r of rows) stmt.run(r.fn, r.surface, r.name, r.n);
}

/** §2.4 `ix_modules` + `ix_module_deps` — `ModulesIndex.modules[].deps` is
 *  its own JSONL-kind (`index/module-deps` per schema.sql's `v_json_module_deps`
 *  note) here split into the ordered `(id,ord,dep)` rows the DDL models it
 *  as. */
function writeModules(db: DatabaseSync, index: ModulesIndex): void {
  const stmtModule = db.prepare("INSERT INTO ix_modules (id,file,factory_fn,segment) VALUES (?,?,?,?)");
  const stmtDep = db.prepare("INSERT INTO ix_module_deps (id,ord,dep) VALUES (?,?,?)");
  for (const m of index.modules) {
    stmtModule.run(m.id, m.file, m.factoryFn, m.segment);
    m.deps.forEach((dep, ord) => stmtDep.run(m.id, ord, dep));
  }
}

/** §2.2a `ix_calls_resolved` rows (MIGRATION 5, docs/BUGS.md 2026-09-05
 *  `ix_calls_resolved` row) — the `require(N)` points-to pass's edges,
 *  `IndexRows.resolvedCallRows`, mirroring `index/calls-resolved.jsonl`
 *  exactly (own table, never a rewrite of `ix_calls`). */
function writeResolvedCalls(db: DatabaseSync, rows: readonly ResolvedCallRow[]): void {
  const stmt = db.prepare("INSERT INTO ix_calls_resolved (caller,site,callee,module,name,confidence) VALUES (?,?,?,?,?,?)");
  for (const r of rows) stmt.run(r.caller, r.site, r.callee, r.module, r.name, r.confidence);
}

function writeRanges(db: DatabaseSync, rows: readonly RangeRow[]): void {
  const stmt = db.prepare("INSERT INTO ix_ranges (fn,file,line_start,line_end) VALUES (?,?,?,?)");
  for (const r of rows) stmt.run(r.fn, r.file, r.lines[0], r.lines[1]);
}

/** Writes every `ix_*` table from one `IndexRows` bundle. Caller owns the
 *  transaction (`initProjectDb` below wraps this + the `meta`/`log` rows in
 *  one `BEGIN`/`COMMIT` so a partial `init` can never be observed). */
export function writeIxRows(db: DatabaseSync, rows: IndexRows): void {
  writeFunctions(db, rows.functionRows);
  writeCalls(db, rows.callRows);
  writeResolvedCalls(db, rows.resolvedCallRows);
  writeStrings(db, rows.stringsIndex);
  writeStringUses(db, rows.stringUseRows);
  writeGlobals(db, rows.globalRows);
  writeNative(db, rows.nativeRows);
  writeModules(db, rows.modulesIndex);
  writeRanges(db, rows.rangeRows);
}

/** sha256 of the in-repo curated host-globals list (schema.sql's
 *  `meta.host_globals_sha` comment, spec 10 §2.5) — the exact list
 *  `src/artifact/native.ts`'s builtin-surface recogniser consults. */
export function hostGlobalsSha(): string {
  return sha256Hex(JSON.stringify(HOST_GLOBALS));
}

export interface InitProjectDbOptions {
  readonly actorWho: string;
  readonly actorRun?: string | null;
}

/** §4.1 steps 2–4: writes the `meta` identity rows, every `ix_*` row from
 *  `rows`, and the `log` rows `init` + `rebuild-index` (gen 1) into a FRESH
 *  project DB (`db` must already have had the DDL applied by
 *  `openProjectDb`, and must otherwise be empty — this never clears an
 *  existing project, matching §4.1's "refuses if the file exists" rule,
 *  enforced by the caller before `openProjectDb` is ever called). One
 *  transaction. */
export function initProjectDb(db: DatabaseSync, rows: IndexRows, opts: InitProjectDbOptions): void {
  db.exec("BEGIN;");
  try {
    const insertMeta = db.prepare("INSERT INTO meta (key,value) VALUES (?,?)");
    const bundleSha256 = rows.manifest.bundle.sha256;
    const producerJson = JSON.stringify(rows.manifest.producer);
    const indexBuiltFor = sha256Hex(`${bundleSha256}:${producerJson}`);
    insertMeta.run("bundle_sha256", bundleSha256);
    insertMeta.run("bundle_bytes", String(rows.manifest.bundle.bytes));
    insertMeta.run("hbc_version", String(rows.manifest.bundle.hbcVersion));
    insertMeta.run("function_count", String(rows.manifest.bundle.functionCount));
    insertMeta.run("producer_json", producerJson);
    insertMeta.run("index_gen", "1");
    insertMeta.run("index_built_for", indexBuiltFor);
    insertMeta.run("render_hash", rows.manifest.render.hash);
    insertMeta.run("host_globals_sha", hostGlobalsSha());

    writeIxRows(db, rows);

    const now = new Date().toISOString();
    const insertLog = db.prepare(
      "INSERT INTO log (ts,actor_source,actor_who,actor_run,op,rid,gen,detail) VALUES (?,?,?,?,?,?,?,?)",
    );
    insertLog.run(now, "tool", opts.actorWho, opts.actorRun ?? null, "init", null, null, JSON.stringify({ bundleSha256 }));
    insertLog.run(
      now,
      "tool",
      opts.actorWho,
      opts.actorRun ?? null,
      "rebuild-index",
      null,
      1,
      JSON.stringify({
        functions: rows.functionRows.length,
        calls: rows.callRows.length,
        strings: rows.stringsIndex.entries.length,
        modules: rows.modulesIndex.modules.length,
      }),
    );
    db.exec("COMMIT;");
  } catch (err) {
    db.exec("ROLLBACK;");
    throw err;
  }
}
