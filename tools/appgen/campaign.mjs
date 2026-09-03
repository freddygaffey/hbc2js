#!/usr/bin/env node
// tools/appgen/campaign.mjs — app-gen fuzzer, SAMPLING/QUOTA CAMPAIGN
// (docs/specs/09-fuzzing.md §2.3 "Sampling, rotation, diversity (never the
// full matrix)"). Rotates a sample of build-config CELLS across the axes
// this increment implements: RN/HBC version (tools/appgen/lib/versions.mjs's
// RN_PINS), bundler (metro-plain | metro-ram), obfuscation (off |
// metro-minify). Selection is pure (`selectSample`) and deterministic given
// a seed, so it is testable without any build (tests/appgen/campaign.test.ts,
// gate-fast, dry-run only).
//
// Scoping note (spec §2.3 item 1's "(rn, bundler, router, sortedLibs,
// obfuscation)" fingerprint): router is a SOURCE-generation axis chosen by
// generate.mjs's own seeded RNG, not something the campaign picks up front,
// and the libraries axis is not yet implemented (generate.mjs's header).
// This module's `cellFingerprint` therefore covers the build-controlled
// axes (rn, bundler, obfuscation); router/depStyle/screens duplicate
// rejection already happens post-generation via build.mjs's
// `isDuplicate(store, manifest.fingerprint)` (spec §2.3's "source seeds are
// never reused" clause) -- the two dedup layers compose, they are not a
// substitute for each other.
//
// Usage:
//   node tools/appgen/campaign.mjs --sample 2 [--dry-run] [--seed <n>]
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { RN_PINS } from "./lib/versions.mjs";
import { axesOverQuota, loadStore } from "./lib/manifest.mjs";
import { buildOne } from "./build.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MANIFEST_PATH = join(ROOT, "tests/fixtures/appgen/manifest.json");

export const CAMPAIGN_AXES = {
  hbcVersion: Object.keys(RN_PINS).map(Number), // [96, 98]
  bundler: ["metro-plain", "metro-ram"],
  obfuscation: [false, true],
};

/** All build-config cells this campaign knows how to rotate across (the
 *  cartesian product of CAMPAIGN_AXES), in a fixed, deterministic order so
 *  "least-covered cell first" ties break the same way every run. */
export function allCells() {
  const cells = [];
  for (const hbcVersion of CAMPAIGN_AXES.hbcVersion) {
    for (const bundler of CAMPAIGN_AXES.bundler) {
      for (const obfuscation of CAMPAIGN_AXES.obfuscation) {
        cells.push({ hbcVersion, bundler, obfuscation });
      }
    }
  }
  return cells;
}

export function cellFingerprint(cell) {
  return `${cell.hbcVersion}:${cell.bundler}:${cell.obfuscation}`;
}

/** Tiny deterministic PRNG (mulberry32, same family as lib/prng.mjs) used
 *  only to pick a fresh seed per selected cell -- reuses no external state,
 *  so selection is a pure function of (store, sampleSize, rngSeed). */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** spec §2.3: pick `sampleSize` build-config cells for this run.
 *  1. Duplicate/quota rejection: drop cells whose axis value is already at
 *     or over the §2.3 item-2 40% quota (once the manifest holds >= 5
 *     entries; `axesOverQuota` no-ops below that).
 *  2. Coverage pressure: among quota-passing cells, prefer the ones with the
 *     lowest live-triple count (version x bundler first via CAMPAIGN_AXES
 *     order, obfuscation last), per spec item 3.
 *  Pure and deterministic: same (store, sampleSize, rngSeed) always yields
 *  the same selection and the same assigned per-cell seeds. */
export function selectSample(store, { sampleSize = 2, rngSeed = 1 } = {}) {
  const live = store.filter((e) => !e.evicted);
  const over = axesOverQuota(live.map((e) => ({ ...e, rnVersion: e.hbcVersion })), {
    axes: ["rnVersion", "bundler", "obfuscation"],
  });
  const rand = mulberry32(rngSeed >>> 0);

  const cellCount = (cell) =>
    live.filter(
      (e) => e.hbcVersion === cell.hbcVersion && e.bundler === cell.bundler &&
        (e.obfuscation === "metro-minify") === cell.obfuscation,
    ).length;

  const candidates = allCells()
    .filter((cell) => {
      if (over.has(`rnVersion:${cell.hbcVersion}`)) return false;
      if (over.has(`bundler:${cell.bundler}`)) return false;
      if (over.has(`obfuscation:${cell.obfuscation ? "metro-minify" : "off"}`)) return false;
      return true;
    })
    .map((cell) => ({ cell, count: cellCount(cell) }))
    .sort((a, b) => a.count - b.count || cellFingerprint(a.cell).localeCompare(cellFingerprint(b.cell)));

  const fallback = allCells()
    .map((cell) => ({ cell, count: cellCount(cell) }))
    .sort((a, b) => a.count - b.count || cellFingerprint(a.cell).localeCompare(cellFingerprint(b.cell)));
  const pool = candidates.length > 0 ? candidates : fallback;
  const usedSeeds = new Set(store.map((e) => String(e.seed)));

  const selection = [];
  for (let i = 0; i < sampleSize; i++) {
    const cell = pool[i % pool.length].cell;
    let seed;
    do {
      seed = Math.floor(rand() * 1e9);
    } while (usedSeeds.has(String(seed)));
    usedSeeds.add(String(seed));
    const rnPin = RN_PINS[cell.hbcVersion];
    selection.push({
      seed,
      rnPin,
      bundler: cell.bundler,
      obfuscate: cell.obfuscation,
      cellFingerprint: cellFingerprint(cell),
    });
  }
  return {
    selection,
    quotaSaturated: candidates.length === 0 && live.length >= 5,
  };
}

function parseArgs(argv) {
  const out = { sampleSize: 2, dryRun: false, rngSeed: Date.now() % 1e9 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--sample") out.sampleSize = Number(argv[++i]);
    else if (argv[i] === "--dry-run") out.dryRun = true;
    else if (argv[i] === "--seed") out.rngSeed = Number(argv[++i]);
  }
  return out;
}

export function runCampaign({ manifestPath = MANIFEST_PATH, sampleSize = 2, dryRun = false, rngSeed = 1 } = {}) {
  const store = loadStore(manifestPath, { existsSync, readFileSync: (p) => readFileSync(p, "utf8") });
  const { selection, quotaSaturated } = selectSample(store, { sampleSize, rngSeed });
  if (dryRun) return { dryRun: true, quotaSaturated, selection };

  const results = selection.map(({ seed, rnPin, bundler, obfuscate }) =>
    buildOne(seed, { manifestPath, rnPin, bundler, obfuscate }),
  );
  return { dryRun: false, quotaSaturated, results };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = runCampaign({ sampleSize: args.sampleSize, dryRun: args.dryRun, rngSeed: args.rngSeed });
  console.log(JSON.stringify(result, null, 2));
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) main();
