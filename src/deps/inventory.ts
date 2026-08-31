// src/deps/inventory.ts — the D17a "module inventory" step: enumerate Metro
// modules from the bytecode (the `__d(fn, id, deps)` registrations, found
// structurally via `dscan.ts` — never by decompiling everything) with their
// per-module function sets, string constants, and dependency edges.

import { decodeFunction } from "../disasm/decode.ts";
import { parseHbc } from "../parse/module.ts";
import type { HbcModule, ParseOptions } from "../parse/types.ts";
import { fingerprintModule, functionStrings } from "./fingerprint.ts";
import type { SigFunction } from "./sigdb-types.ts";

export interface InventoryModule {
  readonly factoryFunctionIndex: number;
  readonly localModuleId: number | null;
  readonly depCount: number | null;
  readonly depIds: readonly number[] | null;
  readonly nestedFunctionIndices: readonly number[];
  /** Factory function index followed by every nested closure — the module's
   *  full function set for the purposes of size/string-evidence gathering. */
  readonly functionIndices: readonly number[];
  readonly instrCount: number;
  readonly stringConstants: readonly string[];
  readonly exactHash: string | null;
  readonly fuzzyHash: string | null;
  /** The factory function's own `regMaskedHash` (D17h-c register-insensitive
   *  tier, `docs/DEPS.md` "Confidence tiers") — `null` if the factory
   *  couldn't be resolved. */
  readonly factoryRegMaskedHash: string | null;
  readonly stringSetHash: string;
  /** The factory function's own string-set hash (not the module-wide
   *  `stringSetHash`, which is over exact hashes) — corroborates a
   *  fuzzy-only factory match when register allocation differs between
   *  builds (`-g`), see `match.ts`. */
  readonly factoryStringSetHash: string | null;
  readonly factoryStringCount: number;
}

export interface ModuleInventory {
  readonly hbcVersion: number;
  readonly totalFunctions: number;
  /** Every function belonging to some `__d()` module (factory or nested). */
  readonly moduledFunctionCount: number;
  readonly modules: readonly InventoryModule[];
  readonly functions: readonly SigFunction[];
}

export function buildInventoryFromModule(mod: HbcModule): ModuleInventory {
  const { functions, modules } = fingerprintModule(mod, decodeFunction);
  const byIndex = new Map(functions.map((f) => [f.index, f]));

  const moduled = new Set<number>();
  const invModules: InventoryModule[] = modules.map((m) => {
    const nested = m.nestedFunctionIndices ?? [];
    const functionIndices = [m.factoryFunctionIndex, ...nested];
    for (const i of functionIndices) moduled.add(i);

    let instrCount = 0;
    const strings = new Set<string>();
    for (const idx of functionIndices) {
      const f = byIndex.get(idx);
      if (f !== undefined) instrCount += f.instrCount;
      const decoded = decodeFunction(mod, idx);
      for (const s of functionStrings(mod, decoded)) strings.add(s);
    }

    return {
      factoryFunctionIndex: m.factoryFunctionIndex,
      localModuleId: m.localModuleId,
      depCount: m.depCount,
      depIds: m.depIds,
      nestedFunctionIndices: nested,
      functionIndices,
      instrCount,
      stringConstants: [...strings].sort(),
      exactHash: m.factoryExactHash,
      fuzzyHash: m.factoryFuzzyHash,
      factoryRegMaskedHash: m.factoryRegMaskedHash ?? null,
      stringSetHash: m.functionSetHash,
      factoryStringSetHash: byIndex.get(m.factoryFunctionIndex)?.stringSetHash ?? null,
      factoryStringCount: byIndex.get(m.factoryFunctionIndex)?.stringCount ?? 0,
    };
  });

  return {
    hbcVersion: mod.header.version,
    totalFunctions: functions.length,
    moduledFunctionCount: moduled.size,
    modules: invModules,
    functions,
  };
}

export function buildInventory(bytes: Uint8Array, options: ParseOptions = {}): { readonly module: HbcModule; readonly inventory: ModuleInventory } {
  const module = parseHbc(bytes, options);
  return { module, inventory: buildInventoryFromModule(module) };
}
