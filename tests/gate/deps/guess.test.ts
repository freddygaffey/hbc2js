// docs/DECISIONS.md D17a point (1) "guess": evidence-scored candidates for
// modules the match stage left unattributed. Pure unit tests against
// synthetic ModuleInventory/MatchReport shapes — no real bundle or network
// access needed to exercise the scoring logic itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { guessModules } from "../../../src/deps/guess.ts";
import type { ModuleInventory, InventoryModule } from "../../../src/deps/inventory.ts";
import type { MatchReport, ModuleAttribution } from "../../../src/deps/match.ts";

function invModule(overrides: Partial<InventoryModule>): InventoryModule {
  return {
    factoryFunctionIndex: 0,
    localModuleId: 0,
    depCount: 0,
    depIds: [],
    nestedFunctionIndices: [],
    functionIndices: [0],
    instrCount: 20,
    stringConstants: [],
    exactHash: null,
    fuzzyHash: null,
    stringSetHash: "x",
    factoryStringSetHash: null,
    factoryStringCount: 0,
    ...overrides,
  };
}

function attribution(overrides: Partial<ModuleAttribution>): ModuleAttribution {
  return { localModuleId: 0, factoryFunctionIndex: 0, depCount: 0, nestedFunctionCount: 0, instrCount: 20, stringConstants: [], owners: [], ownerBasis: null, ...overrides };
}

function makeInventoryAndReport(modules: InventoryModule[], attributions: ModuleAttribution[]): { inventory: ModuleInventory; matchReport: MatchReport } {
  const inventory: ModuleInventory = { hbcVersion: 94, totalFunctions: modules.length, moduledFunctionCount: modules.length, modules, functions: [] };
  const unattributed = attributions.filter((a) => a.owners.length === 0);
  const matchReport: MatchReport = { hbcVersion: 94, totalFunctions: modules.length, totalModules: modules.length, packagesChecked: 0, packages: [], moduleAttributions: attributions, unattributedModules: unattributed };
  return { inventory, matchReport };
}

test("native-module string constant is a strong, direct guess", async () => {
  const mod = invModule({ factoryFunctionIndex: 1, localModuleId: 1, stringConstants: ["RNCAsyncStorage", "getItem", "setItem"] });
  const { inventory, matchReport } = makeInventoryAndReport([mod], [attribution({ factoryFunctionIndex: 1, localModuleId: 1 })]);

  const guesses = await guessModules(inventory, matchReport, { offline: true });
  assert.equal(guesses.length, 1);
  const best = guesses[0]!.candidates[0]!;
  assert.equal(best.package, "@react-native-async-storage/async-storage");
  assert.ok(best.evidence.some((e) => e.kind === "native-module"));
});

test("a hostile string constant named after an Object.prototype member is never mistaken for a native-module hit", async () => {
  // Guards against the plain-object-literal prototype-pollution footgun this
  // map used to have: NATIVE_MODULE_TO_PACKAGE["hasOwnProperty"] must be
  // undefined, not Object.prototype.hasOwnProperty.
  const mod = invModule({ factoryFunctionIndex: 1, localModuleId: 1, stringConstants: ["hasOwnProperty", "toString", "constructor"] });
  const { inventory, matchReport } = makeInventoryAndReport([mod], [attribution({ factoryFunctionIndex: 1, localModuleId: 1 })]);

  const guesses = await guessModules(inventory, matchReport, { offline: true });
  assert.equal(guesses.length, 0, "no real evidence here — must not guess anything, and definitely not a function object");
});

test("URL/API host constant maps to its SDK package", async () => {
  const mod = invModule({ factoryFunctionIndex: 2, localModuleId: 2, stringConstants: ["https://api.stripe.com/v1/tokens", "unrelated string"] });
  const { inventory, matchReport } = makeInventoryAndReport([mod], [attribution({ factoryFunctionIndex: 2, localModuleId: 2 })]);

  const guesses = await guessModules(inventory, matchReport, { offline: true });
  assert.equal(guesses.length, 1);
  assert.equal(guesses[0]!.candidates[0]!.package, "@stripe/stripe-react-native");
});

test("dependency-edge propagation requires a non-trivial identified fraction, not a single lucky hit", async () => {
  // Module 5 depends on [10, 11, 12, 13, 14, 15, 16] (7 deps); only module 10
  // is identified (owned by "leftpad@1.0.0"). 1/7 identified must NOT be
  // enough to call this "leftpad" — the single-coincidence risk match.ts's
  // own module-count tiering guards against (docs/PACKAGE-SIGNATURES.md §5.4).
  const owned = attribution({ localModuleId: 10, factoryFunctionIndex: 10, owners: ["leftpad@1.0.0"] });
  const unmatched = invModule({ factoryFunctionIndex: 5, localModuleId: 5, depCount: 7, depIds: [10, 11, 12, 13, 14, 15, 16] });
  const { inventory, matchReport } = makeInventoryAndReport([invModule({ factoryFunctionIndex: 10, localModuleId: 10 }), unmatched], [owned, attribution({ factoryFunctionIndex: 5, localModuleId: 5 })]);

  const guesses = await guessModules(inventory, matchReport, { offline: true });
  assert.equal(guesses.length, 0, "1/7 identified deps is too weak a signal to guess a package");
});

test("dependency-edge propagation fires when most/all identified deps agree on one package", async () => {
  const owned1 = attribution({ localModuleId: 10, factoryFunctionIndex: 10, owners: ["some-pkg@2.0.0"] });
  const owned2 = attribution({ localModuleId: 11, factoryFunctionIndex: 11, owners: ["some-pkg@2.0.0"] });
  const unmatched = invModule({ factoryFunctionIndex: 5, localModuleId: 5, depCount: 2, depIds: [10, 11] });
  const { inventory, matchReport } = makeInventoryAndReport(
    [invModule({ factoryFunctionIndex: 10, localModuleId: 10 }), invModule({ factoryFunctionIndex: 11, localModuleId: 11 }), unmatched],
    [owned1, owned2, attribution({ factoryFunctionIndex: 5, localModuleId: 5 })],
  );

  const guesses = await guessModules(inventory, matchReport, { offline: true });
  assert.equal(guesses.length, 1);
  assert.equal(guesses[0]!.candidates[0]!.package, "some-pkg");
  assert.equal(
    guesses[0]!.candidates[0]!.evidence.find((e) => e.kind === "dependency-edge")?.detail,
    "2/2 deps owned by some-pkg@2.0.0",
  );
});

test("react-foundation/react-native-foundation baseline owners never seed a dependency-edge guess", async () => {
  const owned = attribution({ localModuleId: 10, factoryFunctionIndex: 10, owners: ["react-foundation@18.2.0"] });
  const unmatched = invModule({ factoryFunctionIndex: 5, localModuleId: 5, depCount: 1, depIds: [10] });
  const { inventory, matchReport } = makeInventoryAndReport([invModule({ factoryFunctionIndex: 10, localModuleId: 10 }), unmatched], [owned, attribution({ factoryFunctionIndex: 5, localModuleId: 5 })]);

  const guesses = await guessModules(inventory, matchReport, { offline: true });
  assert.equal(guesses.length, 0, "a baseline-only dependency is not real signal about which package an unmatched module belongs to");
});

test("offline mode never calls the injected search function", async () => {
  const mod = invModule({ factoryFunctionIndex: 1, localModuleId: 1, stringConstants: ["some-totally-unknown-package-name"] });
  const { inventory, matchReport } = makeInventoryAndReport([mod], [attribution({ factoryFunctionIndex: 1, localModuleId: 1 })]);

  let called = false;
  await guessModules(inventory, matchReport, { offline: true, search: async () => ((called = true), []) });
  assert.equal(called, false);
});

test("online mode falls back to the injected npm search when no direct clue exists", async () => {
  const mod = invModule({ factoryFunctionIndex: 1, localModuleId: 1, stringConstants: ["some-totally-unknown-package-name"] });
  const { inventory, matchReport } = makeInventoryAndReport([mod], [attribution({ factoryFunctionIndex: 1, localModuleId: 1 })]);

  const guesses = await guessModules(inventory, matchReport, {
    offline: false,
    search: async (query) => {
      assert.equal(query, "some-totally-unknown-package-name");
      return [{ name: "found-package", version: "1.2.3", description: undefined }];
    },
  });
  assert.equal(guesses.length, 1);
  assert.equal(guesses[0]!.candidates[0]!.package, "found-package");
  assert.equal(guesses[0]!.candidates[0]!.version, "1.2.3");
});
