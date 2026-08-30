// tools/pkgsig/lib/fingerprint.mjs — T8 prototype v2 core (docs/PACKAGE-SIGNATURES.md §5).
//
// Fingerprints every function in a compiled `.hbc` into the v2 signature-DB
// format (§5.2): per-function exact/fuzzy/string-set-hash tiers (using the
// pkgsig-local normaliser in sig-normalise.mjs, which masks the
// require()-call-site dependency-map index — the v1 prototype's measured
// gap, docs §2.4/§3.2) plus a module-level entry per recovered `__d()`
// registration (dscan.mjs).
//
// No src/** files are imported for anything but parsing/disassembly
// (parseHbc, decodeFunction, readLiterals, getBuiltinTable) — the normaliser
// itself is pkgsig's own fork (sig-normalise.mjs's header comment explains
// why: D3's oracle normaliser must stay byte-exact, so the fix lives here).

import { createHash } from "node:crypto";
import { normaliseFunctionForSignature } from "./sig-normalise.mjs";
import { scanModuleRegistrations } from "./dscan.mjs";

// Truncated to 96 bits (24 hex chars): signature DBs must stay compact
// (docs/PACKAGE-SIGNATURES.md §5.2 — "hashes and metadata, not code") and a
// birthday-bound collision at 2^96 is not a realistic risk at the function
// counts these DBs ever reach (the largest starter-set package here is under
// 9,000 functions, docs §5.5).
function sha256(s) {
  return createHash("sha256").update(s, "utf8").digest("hex").slice(0, 24);
}

/** Bare mnemonic sequence — every operand dropped (§2.2's fuzzy tier,
 *  unchanged from the v1 prototype: since it keeps no operands at all, it
 *  was never affected by the require-immediate gap that exactHash had). */
function fuzzyText(fn) {
  const lines = [];
  for (const insn of fn.instructions) {
    const label = fn.labels.get(insn.offset);
    const prefix = label !== undefined ? "L:" : "";
    if (insn.kind === "switch") {
      const st = insn.switchTable;
      lines.push(`${prefix}SWITCH(${st ? st.cases.length : 0})`);
      continue;
    }
    lines.push(prefix + insn.name);
  }
  return lines.join("\n");
}

function stringSetHash(mod, fn) {
  const set = new Set();
  for (const insn of fn.instructions) {
    for (const op of insn.operands) {
      if (op.role === "string") set.add(mod.strings.get(op.value));
    }
  }
  const sorted = [...set].sort();
  return { hash: sha256(sorted.join("\n")), count: sorted.length };
}

/**
 * Fingerprint one already-parsed module into the v2 per-function + per-module
 * signature arrays. `parseHbc`/`decodeFunction` are passed in by the caller
 * (build-db.mjs / build-signatures.mjs) so this file has zero direct
 * dependency on *which* src/** entry points are used, beyond the shapes
 * documented in sig-normalise.mjs/dscan.mjs.
 */
export function fingerprintModule(mod, decodeFunction) {
  const functions = [];
  for (let i = 0; i < mod.functions.length; i++) {
    const fn = decodeFunction(mod, i);
    const exactHash = sha256(normaliseFunctionForSignature(mod, fn));
    const fuzzyHash = sha256(fuzzyText(fn));
    const ss = stringSetHash(mod, fn);
    functions.push({
      index: i,
      name: fn.name,
      paramCount: fn.header.paramCount,
      instrCount: fn.instructions.length,
      exactHash,
      fuzzyHash,
      stringSetHash: ss.hash,
      stringCount: ss.count,
    });
  }

  let modules = [];
  if (mod.functions.length > 0) {
    const globalFn = decodeFunction(mod, 0);
    const byIndex = new Map(functions.map((f) => [f.index, f]));
    const collectNested = (factoryIdx, seen) => {
      // Nested closures: any function whose CreateClosure appears lexically
      // inside the factory's own bytecode. One level only (matches docs
      // §3.1's "helper closures a module defines" framing) — recursing
      // further would just re-walk functions already counted at the module
      // level for deeply-nested factories, which is fine to leave for a v3.
      const fn = decodeFunction(mod, factoryIdx);
      const nested = [];
      for (const insn of fn.instructions) {
        for (const op of insn.operands) {
          if (op.role === "function" && !seen.has(op.value)) {
            seen.add(op.value);
            nested.push(op.value);
          }
        }
      }
      return nested;
    };

    modules = scanModuleRegistrations(mod, globalFn).map((reg) => {
      const seen = new Set([reg.factoryFunctionIndex]);
      const nestedIdx = collectNested(reg.factoryFunctionIndex, seen);
      const factory = byIndex.get(reg.factoryFunctionIndex);
      const nestedHashes = nestedIdx.map((i) => byIndex.get(i)?.exactHash).filter((h) => h !== undefined);
      const allHashes = [factory?.exactHash, ...nestedHashes].filter((h) => h !== undefined).sort();
      return {
        factoryFunctionIndex: reg.factoryFunctionIndex,
        localModuleId: reg.moduleId,
        depCount: reg.depCount,
        depIds: reg.depIds,
        factoryExactHash: factory?.exactHash ?? null,
        factoryFuzzyHash: factory?.fuzzyHash ?? null,
        nestedFunctionCount: nestedIdx.length,
        functionSetHash: sha256(allHashes.join("\n")),
      };
    });
  }

  return { functions, modules };
}
