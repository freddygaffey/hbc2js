// The overlay store — docs/specs/rename-tool-DESIGN-D-overlay.md §4, §9.
//
// A versioned, append-only sidecar (one JSON file per analysed bundle), the
// single source of truth for names. It is NEVER the emitted `.js`. This module
// is pure data: it runs no gate and reads no bytecode (that is `gate.ts` /
// `render.ts`). Keeping it side-effect-free is what makes history/revert/search
// unit-testable with no network and no VM (spec §11.9).

import { readFileSync, writeFileSync } from "node:fs";
import type { BindingId } from "./id.ts";
import { bindingKey, parseKey } from "./id.ts";

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

/** The append-only overlay store. In-memory; `save`/`load` persist the JSON
 *  sidecar. A binding's records form a supersession chain; at most one is
 *  `active` at a time. */
export class OverlayStore {
  private records: NameRecord[];
  private seq: number;
  readonly bundle: string | undefined;
  /** Injectable clock — overridden in tests for deterministic timestamps. */
  now: () => string = () => new Date().toISOString();

  constructor(init?: { readonly bundle?: string; readonly records?: readonly NameRecord[]; readonly seq?: number }) {
    this.records = init?.records ? [...init.records] : [];
    this.seq = init?.seq ?? this.records.length;
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
    const file: StoreFile = { version: STORE_VERSION, ...(this.bundle !== undefined ? { bundle: this.bundle } : {}), seq: this.seq, records: this.records };
    writeFileSync(path, JSON.stringify(file, null, 2) + "\n");
  }

  /** Every record ever written, oldest first (the raw append log). */
  allRecords(): readonly NameRecord[] {
    return this.records;
  }

  /** The currently-active record for `id`, or `null` (an unnamed binding, or
   *  one reverted back to `rN`). */
  getName(id: BindingId): NameRecord | null {
    const key = bindingKey(id);
    for (let i = this.records.length - 1; i >= 0; i--) {
      const r = this.records[i]!;
      if (r.active && bindingKey(r.id) === key) return r;
    }
    return null;
  }

  /** The full supersession chain for `id`, newest first (spec §9 `history`). */
  history(id: BindingId): readonly NameRecord[] {
    const key = bindingKey(id);
    return this.records.filter((r) => bindingKey(r.id) === key).slice().reverse();
  }

  /** Assign a name (spec §5). Append-only: any prior active record for the
   *  binding is superseded (deactivated, its `rid` recorded on the new one),
   *  never overwritten. */
  setName(id: BindingId, name: string, meta: NameMeta): SetResult {
    const prior = this.getName(id);
    if (prior !== null) this.deactivate(prior.rid);
    const rid = String(this.seq++);
    const record: NameRecord = {
      rid,
      id,
      name,
      confidence: meta.confidence,
      evidence: meta.evidence,
      source: meta.source,
      gate: meta.gate,
      ts: meta.ts ?? this.now(),
      supersedes: prior?.rid ?? null,
      active: true,
    };
    this.records.push(record);
    return { record, superseded: prior };
  }

  /** Revert (spec §5/§9). With `toTs`, re-activate the record for `id` bearing
   *  that timestamp. Without it, re-activate the immediately-prior record in
   *  the chain; if none exists, clear to `rN` (no active record). Nothing is
   *  destroyed — a revert only flips `active`. Returns the now-active record,
   *  or `null` when cleared to `rN`. */
  revert(id: BindingId, toTs?: string): NameRecord | null {
    const key = bindingKey(id);
    const chain = this.records.filter((r) => bindingKey(r.id) === key);
    if (chain.length === 0) return null;
    const current = chain.find((r) => r.active) ?? null;
    let target: NameRecord | null;
    if (toTs !== undefined) {
      target = chain.find((r) => r.ts === toTs) ?? null;
      if (target === null) throw new Error(`revert: no record for ${key} at ts ${toTs}`);
    } else {
      // The record `current` superseded (its `supersedes` rid), else — when
      // `current` is the chain's first — clear to `rN`.
      target = current?.supersedes != null ? chain.find((r) => r.rid === current.supersedes) ?? null : null;
    }
    if (current !== null) this.deactivate(current.rid);
    if (target !== null) this.activate(target.rid);
    return target;
  }

  /** Filtered query over active records (spec §5/§9). Empty result is empty,
   *  never an error. */
  search(query: NameQuery): readonly NameRecord[] {
    const text = query.text?.toLowerCase();
    return this.records.filter((r) => {
      if (!r.active) return false;
      if (query.confidence !== undefined && r.confidence !== query.confidence) return false;
      if (query.source !== undefined && r.source !== query.source) return false;
      if (query.gate !== undefined && r.gate !== query.gate) return false;
      if (query.fn !== undefined && r.id.fn !== query.fn) return false;
      if (text !== undefined && !r.name.toLowerCase().includes(text) && !r.evidence.toLowerCase().includes(text)) return false;
      return true;
    });
  }

  /** Every active register-local name for function `fn`, as a `reg → name` map
   *  — what `render` applies. */
  activeNamesForFn(fn: number): ReadonlyMap<number, NameRecord> {
    const out = new Map<number, NameRecord>();
    for (const r of this.records) {
      if (!r.active || r.id.kind !== "reg" || r.id.fn !== fn) continue;
      out.set(r.id.reg, r);
    }
    return out;
  }

  /** Record the deterministic name render actually emitted for a binding when
   *  it had to disambiguate a collision (spec §7). Advisory; does not supersede.
   *  Idempotent when `renderedAs` is unchanged. */
  flagCollision(id: BindingId, renderedAs: string): void {
    const key = bindingKey(id);
    for (let i = this.records.length - 1; i >= 0; i--) {
      const r = this.records[i]!;
      if (r.active && bindingKey(r.id) === key) {
        if (r.renderedAs !== renderedAs) this.records[i] = { ...r, renderedAs };
        return;
      }
    }
  }

  private deactivate(rid: string): void {
    const i = this.records.findIndex((r) => r.rid === rid);
    if (i >= 0) this.records[i] = { ...this.records[i]!, active: false };
  }

  private activate(rid: string): void {
    const i = this.records.findIndex((r) => r.rid === rid);
    if (i >= 0) this.records[i] = { ...this.records[i]!, active: true };
  }
}

export { bindingKey, parseKey };
