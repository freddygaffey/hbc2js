// The overlay store — docs/specs/rename-tool-DESIGN-D-overlay.md §4, §9.
//
// A versioned, append-only sidecar (one JSON file per analysed bundle), the
// single source of truth for names. It is NEVER the emitted `.js`. This module
// is pure data: it runs no gate and reads no bytecode (that is `gate.ts` /
// `render.ts`). Keeping it side-effect-free is what makes history/revert/search
// unit-testable with no network and no VM (spec §11.9).
//
// The append-only supersession/revert engine is `RevisionStore<T>` (spec
// 11-project-store.md §2.4/§7 step 1) — this module is a thin consumer: it
// maps a `BindingId` to its slot key (`bindingKey`) and a name's fields to/from
// the engine's generic `value`, and owns the on-disk `.names.json` shape
// itself, which the engine knows nothing about (byte-identical contract with
// every prior release — see `tests/gate/name-overlay/store.test.ts`).

import { readFileSync, writeFileSync } from "node:fs";
import type { BindingId } from "./id.ts";
import { bindingKey, parseKey } from "./id.ts";
import { RevisionStore } from "../project/revision-store.ts";
import type { Revision } from "../project/revision-store.ts";

export type Confidence = "low" | "med" | "high";
export type Source = "llm" | "heuristic" | "human";
export type Gate = "passed" | "overridden";

/** One assigned name — spec §4's record shape, plus a store-local `rid` (the
 *  record's own id, referenced by a later record's `supersedes`) and an
 *  `active` flag (the currently-rendered record for a binding; `revert` flips
 *  it without destroying history). */
export interface NameRecord {
  readonly rid: string;
  readonly id: BindingId;
  readonly name: string;
  readonly confidence: Confidence;
  readonly evidence: string;
  readonly source: Source;
  readonly gate: Gate;
  readonly ts: string;
  readonly supersedes: string | null;
  readonly active: boolean;
  /** Render-time collision flag (spec §7): the deterministic suffix render had
   *  to add because this name clashed in-frame, or absent when it rendered
   *  cleanly. Advisory metadata; never changes behaviour. */
  readonly renderedAs?: string;
}

/** Caller-supplied metadata for `setName`. `gate`/`confidence` may be forced by
 *  the gate layer (an override forces `gate:"overridden"` + `confidence:"low"`,
 *  spec §6); the store records exactly what it is handed. */
export interface NameMeta {
  readonly confidence: Confidence;
  readonly evidence: string;
  readonly source: Source;
  readonly gate: Gate;
  /** ISO timestamp; injectable so tests are deterministic (spec §11.9). */
  readonly ts?: string;
}

export interface SetResult {
  readonly record: NameRecord;
  readonly superseded: NameRecord | null;
}

export interface NameQuery {
  readonly confidence?: Confidence;
  readonly source?: Source;
  readonly gate?: Gate;
  readonly fn?: number;
  /** Case-insensitive substring over name and evidence. */
  readonly text?: string;
}

const STORE_VERSION = 1;

interface StoreFile {
  readonly version: number;
  readonly bundle?: string;
  readonly seq: number;
  readonly records: readonly NameRecord[];
}

/** The engine's `value` shape: every `NameRecord` field except the ones the
 *  engine already owns (`rid`, `ts`, `supersedes`, `active`) and the ones that
 *  fold into the slot key (`id`). */
type NameFields = Pick<NameRecord, "name" | "confidence" | "evidence" | "source" | "gate" | "renderedAs">;

/** Reconstruct a `NameRecord` from an engine revision, in the field order the
 *  on-disk format has always used (byte-identical contract). */
function toNameRecord(r: Revision<NameFields>): NameRecord {
  const { name, confidence, evidence, source, gate, renderedAs } = r.value;
  return {
    rid: r.rid,
    id: parseKey(r.target),
    name,
    confidence,
    evidence,
    source,
    gate,
    ts: r.ts,
    supersedes: r.supersedes,
    active: r.active,
    ...(renderedAs !== undefined ? { renderedAs } : {}),
  };
}

function toRevision(r: NameRecord): Revision<NameFields> {
  const { name, confidence, evidence, source, gate, renderedAs } = r;
  return {
    rid: r.rid,
    target: bindingKey(r.id),
    value: { name, confidence, evidence, source, gate, ...(renderedAs !== undefined ? { renderedAs } : {}) },
    ts: r.ts,
    supersedes: r.supersedes,
    active: r.active,
  };
}

/** The append-only overlay store. In-memory; `save`/`load` persist the JSON
 *  sidecar. A binding's records form a supersession chain; at most one is
 *  `active` at a time. Thin consumer of `RevisionStore<NameFields>`: this
 *  class owns id<->slot-key mapping and the on-disk shape, the engine owns
 *  append/supersede/revert. */
export class OverlayStore {
  private readonly engine: RevisionStore<NameFields>;
  readonly bundle: string | undefined;
  /** Injectable clock — overridden in tests for deterministic timestamps. */
  now: () => string = () => new Date().toISOString();

  constructor(init?: { readonly bundle?: string; readonly records?: readonly NameRecord[]; readonly seq?: number }) {
    this.engine = new RevisionStore<NameFields>({
      ...(init?.records ? { records: init.records.map(toRevision) } : {}),
      ...(init?.seq !== undefined ? { seq: init.seq } : {}),
    });
    this.bundle = init?.bundle;
  }

  /** Load a store from its JSON sidecar. A missing/unreadable file yields an
   *  empty store for `bundle` (the first `setName` will create it on `save`). */
  static load(path: string, bundle?: string): OverlayStore {
    let parsed: StoreFile | undefined;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8")) as StoreFile;
    } catch {
      return new OverlayStore(bundle !== undefined ? { bundle } : {});
    }
    const b = parsed.bundle ?? bundle;
    return new OverlayStore({ ...(b !== undefined ? { bundle: b } : {}), records: parsed.records ?? [], seq: parsed.seq ?? (parsed.records?.length ?? 0) });
  }

  save(path: string): void {
    const file: StoreFile = {
      version: STORE_VERSION,
      ...(this.bundle !== undefined ? { bundle: this.bundle } : {}),
      seq: this.engine.currentSeq(),
      records: this.allRecords(),
    };
    writeFileSync(path, JSON.stringify(file, null, 2) + "\n");
  }

  /** Every record ever written, oldest first (the raw append log). */
  allRecords(): readonly NameRecord[] {
    return this.engine.allRecords().map(toNameRecord);
  }

  /** The currently-active record for `id`, or `null` (an unnamed binding, or
   *  one reverted back to `rN`). */
  getName(id: BindingId): NameRecord | null {
    const r = this.engine.get(bindingKey(id));
    return r ? toNameRecord(r) : null;
  }

  /** The full supersession chain for `id`, newest first (spec §9 `history`). */
  history(id: BindingId): readonly NameRecord[] {
    return this.engine.history(bindingKey(id)).map(toNameRecord);
  }

  /** Assign a name (spec §5). Append-only: any prior active record for the
   *  binding is superseded (deactivated, its `rid` recorded on the new one),
   *  never overwritten. */
  setName(id: BindingId, name: string, meta: NameMeta): SetResult {
    const { record, superseded } = this.engine.set(
      bindingKey(id),
      { name, confidence: meta.confidence, evidence: meta.evidence, source: meta.source, gate: meta.gate },
      meta.ts ?? this.now(),
    );
    return { record: toNameRecord(record), superseded: superseded ? toNameRecord(superseded) : null };
  }

  /** Revert (spec §5/§9). With `toTs`, re-activate the record for `id` bearing
   *  that timestamp. Without it, re-activate the immediately-prior record in
   *  the chain; if none exists, clear to `rN` (no active record). Nothing is
   *  destroyed — a revert only flips `active`. Returns the now-active record,
   *  or `null` when cleared to `rN`. */
  revert(id: BindingId, toTs?: string): NameRecord | null {
    const r = this.engine.revert(bindingKey(id), toTs);
    return r ? toNameRecord(r) : null;
  }

  /** Filtered query over active records (spec §5/§9). Empty result is empty,
   *  never an error. */
  search(query: NameQuery): readonly NameRecord[] {
    const text = query.text?.toLowerCase();
    return this.engine
      .search((r) => {
        if (query.confidence !== undefined && r.value.confidence !== query.confidence) return false;
        if (query.source !== undefined && r.value.source !== query.source) return false;
        if (query.gate !== undefined && r.value.gate !== query.gate) return false;
        if (query.fn !== undefined && parseKey(r.target).fn !== query.fn) return false;
        if (text !== undefined && !r.value.name.toLowerCase().includes(text) && !r.value.evidence.toLowerCase().includes(text)) return false;
        return true;
      })
      .map(toNameRecord);
  }

  /** Every active register-local name for function `fn`, as a `reg → name` map
   *  — what `render` applies. */
  activeNamesForFn(fn: number): ReadonlyMap<number, NameRecord> {
    const out = new Map<number, NameRecord>();
    for (const r of this.engine.allRecords()) {
      if (!r.active) continue;
      const id = parseKey(r.target);
      if (id.kind !== "reg" || id.fn !== fn) continue;
      out.set(id.reg, toNameRecord(r));
    }
    return out;
  }

  /** Record the deterministic name render actually emitted for a binding when
   *  it had to disambiguate a collision (spec §7). Advisory; does not supersede.
   *  Idempotent when `renderedAs` is unchanged. */
  flagCollision(id: BindingId, renderedAs: string): void {
    const key = bindingKey(id);
    const current = this.engine.get(key);
    if (current !== undefined && current.value.renderedAs !== renderedAs) {
      this.engine.patchActive(key, (v) => ({ ...v, renderedAs }));
    }
  }

}

export { bindingKey, parseKey };
