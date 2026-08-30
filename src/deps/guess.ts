// src/deps/guess.ts — the D17a "guess" stage: for each module the match
// stage left unattributed, derive candidate `package@version`s from
// evidence, each clue weighted (docs/DECISIONS.md D17a).
//
// Clue sources, in priority order:
//   1. `NativeModules.X` / `TurboModuleRegistry.get('X')` names — a curated
//      map (`native-modules.ts`) near-uniquely identifies the npm package.
//   2. String constants: URL/API hosts of known third-party SDKs, and (with
//      much lower confidence) anything shaped like an npm package name.
//   3. Dependency edges: an unattributed module whose declared dependencies
//      are themselves confidently owned by one package is very likely that
//      package's own internal (fingerprint-missed) code.
//   4. Whatever's left with no direct name becomes an npm registry search
//      query (network, skipped when `offline`).
//
// A module can (and often does) collect evidence from more than one source;
// candidates are merged by package name and their weights summed, capped at
// 1.0, then sorted best-first. This stage never claims certainty — even a
// same-name native-module hit is a "guess" until `--confirm` fingerprints a
// real build of the candidate against this module.

import { NATIVE_MODULE_TO_PACKAGE, guessPackageNameFromNativeModule } from "./native-modules.ts";
import type { MatchReport } from "./match.ts";
import type { ModuleInventory } from "./inventory.ts";

export interface Evidence {
  readonly kind: "native-module" | "url-host" | "package-name-string" | "dependency-edge" | "npm-search" | "apk";
  readonly detail: string;
  readonly weight: number;
}

export interface GuessCandidate {
  readonly package: string;
  /** Only set when a clue itself carries a version (rare pre-confirm); null
   *  otherwise — `--confirm` is what pins a version. */
  readonly version: string | null;
  readonly confidence: number;
  readonly evidence: readonly Evidence[];
}

export interface ModuleGuess {
  readonly factoryFunctionIndex: number;
  readonly localModuleId: number | null;
  readonly instrCount: number;
  readonly candidates: readonly GuessCandidate[];
}

// URL/API host -> npm package, for third-party SDKs that bake their own
// endpoint host into the bundle as a string literal (docs D17a "URL/API-host
// constants").
const HOST_TO_PACKAGE: ReadonlyMap<string, string> = new Map(Object.entries({
  "sentry.io": "@sentry/react-native",
  "stripe.com": "@stripe/stripe-react-native",
  "api.stripe.com": "@stripe/stripe-react-native",
  "branch.io": "react-native-branch",
  "amplitude.com": "@amplitude/react-native",
  "api2.amplitude.com": "@amplitude/react-native",
  "segment.com": "@segment/analytics-react-native",
  "api.segment.io": "@segment/analytics-react-native",
  "onesignal.com": "react-native-onesignal",
  "intercom.io": "react-native-intercom",
  "appsflyer.com": "react-native-appsflyer",
  "revenuecat.com": "react-native-purchases",
  "mixpanel.com": "mixpanel-react-native",
  "api.mixpanel.com": "mixpanel-react-native",
  "bugsnag.com": "@bugsnag/react-native",
  "sessions.bugsnag.com": "@bugsnag/react-native",
  "datadoghq.com": "@datadog/mobile-react-native",
  "crashlytics.com": "@react-native-firebase/crashlytics",
  "firebaseio.com": "@react-native-firebase/app",
  "firebaseinstallations.googleapis.com": "@react-native-firebase/app",
  "app-measurement.com": "@react-native-firebase/analytics",
  "googlesyndication.com": "react-native-google-mobile-ads",
}));

// A conservative shape for "this string looks like an npm package name" —
// used only to seed a search query, never emitted as a candidate on its own.
const PACKAGE_NAME_LIKE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const STOPWORD_LIKE_NAMES = new Set(["true", "false", "null", "undefined", "default", "index", "main", "src"]);

// A single string literal shaped like `<package-name>@<semver>` — some
// libraries bake their own `name@version` into a User-Agent string, a log
// prefix, or an internal assertion message. Matched against the curated name
// set below, this is the "package-name string literal with a version" clue
// D17a's `hint` tier names: a lone package-name-string match with *no*
// version is too generic to report alone (any code can contain a string that
// happens to equal a popular package's name), but one that also carries a
// version is effectively self-corroborating.
const PACKAGE_NAME_AT_VERSION = /^(@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;

function extractUrlHosts(strings: readonly string[]): string[] {
  const hosts = new Set<string>();
  for (const s of strings) {
    const m = /^[a-z][a-z0-9+.-]*:\/\/([^/\s]+)/i.exec(s) ?? /^([a-z0-9-]+(?:\.[a-z0-9-]+)+\.[a-z]{2,})(?:[/:]|$)/i.exec(s);
    if (m) hosts.add(m[1]!.toLowerCase());
  }
  return [...hosts];
}

function mergeCandidate(map: Map<string, GuessCandidate>, pkg: string, version: string | null, evidence: Evidence): void {
  const existing = map.get(pkg);
  if (existing === undefined) {
    map.set(pkg, { package: pkg, version, confidence: Math.min(1, evidence.weight), evidence: [evidence] });
    return;
  }
  map.set(pkg, {
    package: pkg,
    version: existing.version ?? version,
    confidence: Math.min(1, existing.confidence + evidence.weight),
    evidence: [...existing.evidence, evidence],
  });
}

export interface NpmSearchHit {
  readonly name: string;
  readonly version: string;
  readonly description: string | undefined;
}

/** `https://registry.npmjs.org/-/v1/search` — network only, callers gate on `--offline`. */
export async function npmRegistrySearch(query: string, size = 5): Promise<NpmSearchHit[]> {
  const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=${size}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return [];
  const data = (await res.json()) as { objects?: { package: { name: string; version: string; description?: string } }[] };
  return (data.objects ?? []).map((o) => ({ name: o.package.name, version: o.package.version, description: o.package.description }));
}

export interface GuessOptions {
  readonly offline?: boolean;
  /** Injectable for tests / to reuse a rate-limited client; defaults to `npmRegistrySearch`. */
  readonly search?: (query: string) => Promise<NpmSearchHit[]>;
  /** Extra weighted string->package hints from APK-side evidence (D17a point 3). */
  readonly apkHints?: ReadonlyMap<string, string>;
  /** Package names the caller knows exist (the loaded signature DB's) — a
   *  string constant that is exactly one of these, or one of this file's own
   *  curated names, is `package-name-string` evidence. */
  readonly knownPackages?: ReadonlySet<string>;
}

const CURATED_PACKAGE_NAMES: ReadonlySet<string> = new Set([...NATIVE_MODULE_TO_PACKAGE.values(), ...HOST_TO_PACKAGE.values()]);

/** Evidence kinds specific enough to stand alone at the `hint` tier
 *  (docs/DECISIONS.md D17a, extended 2026-08-30 per the overseer's decision
 *  after `docs/reviews/deps-v1.md`): a curated `NativeModules`/
 *  `TurboModuleRegistry` name, a curated API-host constant, or a
 *  package-name string literal that itself carries a version. Never a bare
 *  npm-search hit, an APK hint, a bare package-name string with no version,
 *  or a dependency-edge alone — none of those are specific enough to report
 *  on their own (`src/deps/report.ts`'s promotion logic is the only caller). */
export function isHintEligibleEvidence(kind: string, version: string | null): boolean {
  if (kind === "native-module" || kind === "url-host") return true;
  if (kind === "package-name-string" && version !== null) return true;
  return false;
}

/**
 * Guess candidate packages for every module `matchReport` left unattributed.
 * Modules already owned by a package (`matchReport`'s attributed modules) are
 * skipped — they're the input to the dependency-edge clue for their
 * unattributed neighbours, not something to re-guess.
 */
// Toolchain/foundation baseline "packages" (docs/PACKAGE-SIGNATURES.md §5.2)
// are not real npm dependencies — they exist only to be subtracted out of
// every other package's signature file. A module whose only identified
// dependency is one of these carries essentially no signal about which
// *real* package it belongs to (react-foundation alone touches a large
// fraction of any RN app's whole module graph), so they must never seed the
// dependency-edge clue below.
const BASELINE_PACKAGE_NAME = /^(metro-toolchain-empty|react-foundation|react-native-foundation)$/;

export async function guessModules(inventory: ModuleInventory, matchReport: MatchReport, opts: GuessOptions = {}): Promise<ModuleGuess[]> {
  const ownerByModuleId = new Map<number, string>();
  for (const attr of matchReport.moduleAttributions) {
    if (attr.owners.length === 0 || attr.localModuleId === null) continue;
    const owner = attr.owners.find((o) => !BASELINE_PACKAGE_NAME.test(o.slice(0, o.lastIndexOf("@"))));
    if (owner !== undefined) ownerByModuleId.set(attr.localModuleId, owner);
  }
  const depIdsByModuleId = new Map<number, readonly number[]>();
  for (const m of inventory.modules) {
    if (m.localModuleId !== null) depIdsByModuleId.set(m.localModuleId, m.depIds ?? []);
  }

  const search = opts.search ?? npmRegistrySearch;
  const guesses: ModuleGuess[] = [];

  for (const unmatched of matchReport.unattributedModules) {
    const invModule = inventory.modules.find((m) => m.factoryFunctionIndex === unmatched.factoryFunctionIndex);
    const strings = invModule?.stringConstants ?? unmatched.stringConstants;
    const candidates = new Map<string, GuessCandidate>();

    // 1. Native-module name hits: a string literal that is exactly a known
    // NativeModules/TurboModuleRegistry key.
    let sawNativeModule: string | null = null;
    for (const s of strings) {
      const pkg = NATIVE_MODULE_TO_PACKAGE.get(s);
      if (pkg !== undefined) {
        mergeCandidate(candidates, pkg, null, { kind: "native-module", detail: s, weight: 0.75 });
        sawNativeModule = s;
      }
    }

    // 2. URL/API host constants.
    for (const host of extractUrlHosts(strings)) {
      const pkg = HOST_TO_PACKAGE.get(host);
      if (pkg !== undefined) mergeCandidate(candidates, pkg, null, { kind: "url-host", detail: host, weight: 0.4 });
    }

    // 3. APK-side hints (manifest permissions, .so names, asset files) that
    // the caller has already turned into package-name suggestions.
    if (opts.apkHints !== undefined) {
      for (const [hint, pkg] of opts.apkHints) {
        if (strings.some((s) => s.includes(hint))) {
          mergeCandidate(candidates, pkg, null, { kind: "apk", detail: hint, weight: 0.2 });
        }
      }
    }

    // 3b. A string constant that *is* a known package name (libraries put
    // their own name in error/warning prefixes and `displayName`s) — no
    // version, so it's an independent evidence kind from the native-module/
    // host clues (what lets a native-module hit clear the report's ">= 2
    // independent kinds" bar without network) but too generic to report
    // alone. A single literal of the shape `name@version` is the stronger,
    // self-corroborating form: it names both the package *and* a specific
    // release, which is what makes a lone hit of this kind eligible for the
    // `hint` tier (`isHintEligibleEvidence` above).
    for (const s of strings) {
      if (CURATED_PACKAGE_NAMES.has(s) || opts.knownPackages?.has(s) === true) {
        mergeCandidate(candidates, s, null, { kind: "package-name-string", detail: s, weight: 0.3 });
        continue;
      }
      const versioned = PACKAGE_NAME_AT_VERSION.exec(s);
      if (versioned !== null) {
        const [, name, version] = versioned;
        if (CURATED_PACKAGE_NAMES.has(name!) || opts.knownPackages?.has(name!) === true) {
          mergeCandidate(candidates, name!, version!, { kind: "package-name-string", detail: s, weight: 0.3 });
        }
      }
    }

    // 4. Dependency-edge propagation: if every *identified* dependency this
    // module declares points to the same single package, AND that's a
    // non-trivial fraction of its declared dependencies (not just one lucky
    // hit among many unidentified ones — the same single-coincidence risk
    // match.ts's own module-count tiering guards against, §5.4), it's very
    // likely that package's own unmatched code.
    const depIds = unmatched.depCount !== null ? (depIdsByModuleId.get(unmatched.localModuleId ?? -1) ?? []) : [];
    const depOwners = depIds.map((id) => ownerByModuleId.get(id)).filter((o): o is string => o !== undefined);
    const identifiedFraction = depIds.length === 0 ? 0 : depOwners.length / depIds.length;
    if (depOwners.length > 0 && depOwners.every((o) => o === depOwners[0]) && (depOwners.length >= 2 || identifiedFraction >= 0.5)) {
      const pkgAtVersion = depOwners[0]!;
      const pkg = pkgAtVersion.slice(0, pkgAtVersion.lastIndexOf("@"));
      mergeCandidate(candidates, pkg, null, { kind: "dependency-edge", detail: `${depOwners.length}/${depIds.length} deps owned by ${pkgAtVersion}`, weight: Math.min(0.5, 0.2 * depOwners.length) });
    }

    // 5. Fallback: npm registry search, only when we have *some* lead
    // (a native-module name to derive a guessed package slug from, or a
    // package-name-shaped string) and the caller allows network.
    if (candidates.size === 0 && opts.offline !== true) {
      const nameLead = sawNativeModule !== null ? guessPackageNameFromNativeModule(sawNativeModule) : null;
      const stringLead = strings.find((s) => s.length >= 3 && s.length <= 40 && PACKAGE_NAME_LIKE.test(s) && !STOPWORD_LIKE_NAMES.has(s));
      const query = nameLead ?? stringLead ?? null;
      if (query !== null) {
        try {
          const hits = await search(query);
          for (const hit of hits.slice(0, 3)) {
            mergeCandidate(candidates, hit.name, hit.version, { kind: "npm-search", detail: `query="${query}"`, weight: 0.15 });
          }
        } catch {
          // Network failure: leave this module unguessed rather than fail
          // the whole run (D17a's guess stage is best-effort).
        }
      }
    }

    if (candidates.size > 0) {
      const ranked = [...candidates.values()].sort((a, b) => b.confidence - a.confidence);
      guesses.push({ factoryFunctionIndex: unmatched.factoryFunctionIndex, localModuleId: unmatched.localModuleId, instrCount: unmatched.instrCount, candidates: ranked });
    }
  }

  return guesses;
}
