// src/deps/apk.ts — D17a's APK-side evidence: manifest permissions,
// bundled native `.so` names, and asset files like `google-services.json`
// (present only when `hbc2js deps` was given an `.apk` rather than a bare
// `.hbc`/`.js`). Read-only, local-only (docs/DECISIONS.md D16 C5's rules
// apply equally here: never uploads or publishes anything extracted).
//
// Uses `aapt` (Android SDK build-tools) when it's on `PATH` for accurate
// manifest decoding; otherwise falls back to a minimal heuristic scan of the
// raw binary-XML `AndroidManifest.xml` bytes (its string pool holds plain
// UTF-16LE text — permission names and the package identifier survive even
// without a real AXML parser). No third-party AXML parser is vendored, per
// the zero-runtime-deps rule; when `unzip` itself is unavailable this stage
// reports nothing and says so, rather than failing the whole `deps` run.

import { execFileSync } from "node:child_process";

export interface ApkEvidence {
  readonly packageName: string | null;
  readonly permissions: readonly string[];
  /** Basenames of every `lib/<abi>/*.so` entry, deduplicated across ABIs. */
  readonly nativeLibs: readonly string[];
  readonly assetHints: readonly string[];
  readonly usedAapt: boolean;
  readonly notes: readonly string[];
}

// Asset paths whose mere presence is itself an npm-package clue.
const ASSET_HINT_PACKAGES: ReadonlyMap<string, string> = new Map([
  ["assets/google-services.json", "@react-native-firebase/app"],
  ["res/values/google_services.xml", "@react-native-firebase/app"],
]);

function which(bin: string): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function listZipEntries(apkPath: string): string[] {
  try {
    const out = execFileSync("unzip", ["-Z1", apkPath], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return out.split("\n").filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

function readZipEntry(apkPath: string, entry: string): Uint8Array | null {
  try {
    return execFileSync("unzip", ["-p", apkPath, entry], { maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}

/** Every printable-ASCII-or-Latin1-decodable UTF-16LE run of length >= 4 in
 *  `bytes` — good enough to recover binary-AXML's string-pool text without a
 *  real AXML parser (permission names and package identifiers are always
 *  plain 7-bit ASCII). */
function extractUtf16Strings(bytes: Uint8Array): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const lo = bytes[i]!;
    const hi = bytes[i + 1]!;
    if (hi === 0 && lo >= 0x20 && lo < 0x7f) {
      cur += String.fromCharCode(lo);
    } else {
      if (cur.length >= 4) out.push(cur);
      cur = "";
    }
  }
  if (cur.length >= 4) out.push(cur);
  return out;
}

function manifestEvidenceViaAapt(apkPath: string): { packageName: string | null; permissions: string[] } | null {
  if (!which("aapt")) return null;
  try {
    const badging = execFileSync("aapt", ["dump", "badging", apkPath], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    const pkgMatch = /package: name='([^']+)'/.exec(badging);
    const permissions = [...badging.matchAll(/uses-permission(?:-sdk-23)?:\s*name='([^']+)'/g)].map((m) => m[1]!);
    return { packageName: pkgMatch?.[1] ?? null, permissions };
  } catch {
    return null;
  }
}

function manifestEvidenceHeuristic(apkPath: string): { packageName: string | null; permissions: string[] } {
  const manifestBytes = readZipEntry(apkPath, "AndroidManifest.xml");
  if (manifestBytes === null) return { packageName: null, permissions: [] };
  const strings = extractUtf16Strings(manifestBytes);
  const permissions = [...new Set(strings.filter((s) => /^android\.permission\.[A-Z0-9_.]+$/.test(s)))];
  // A reverse-DNS-shaped string with >=2 dots, all-lowercase segments, that
  // isn't itself a permission/package-class name, is the best heuristic
  // proxy for the manifest's own `package="…"` attribute without decoding
  // the AXML attribute table for real.
  const dnsLike = strings.filter((s) => /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$/.test(s) && !s.startsWith("android.") && !s.startsWith("com.google.android") && !s.startsWith("androidx."));
  const packageName = dnsLike[0] ?? null;
  return { packageName, permissions };
}

export function analyzeApk(apkPath: string): ApkEvidence {
  const notes: string[] = [];
  if (!which("unzip")) {
    return { packageName: null, permissions: [], nativeLibs: [], assetHints: [], usedAapt: false, notes: ["`unzip` not found on PATH; APK evidence stage skipped entirely"] };
  }

  const entries = listZipEntries(apkPath);
  const nativeLibs = [...new Set(entries.filter((e) => /^lib\/[^/]+\/.+\.so$/.test(e)).map((e) => e.slice(e.lastIndexOf("/") + 1)))].sort();
  const assetHints = [...ASSET_HINT_PACKAGES.keys()].filter((path) => entries.includes(path));

  const viaAapt = manifestEvidenceViaAapt(apkPath);
  const manifest = viaAapt ?? manifestEvidenceHeuristic(apkPath);
  if (viaAapt === null) {
    notes.push("`aapt` not found on PATH; manifest package name/permissions recovered via a heuristic raw-string scan of AndroidManifest.xml (may miss or over-report — no real binary-XML parser is vendored, per the zero-runtime-deps rule)");
  }

  return {
    packageName: manifest.packageName,
    permissions: manifest.permissions.sort(),
    nativeLibs,
    assetHints,
    usedAapt: viaAapt !== null,
    notes,
  };
}

export interface ExtractedBundle {
  readonly bytes: Uint8Array;
  readonly entryPath: string;
  readonly isHermes: boolean;
  readonly hbcVersion: number | null;
}

const HERMES_MAGIC = Buffer.from([0xc6, 0x1f, 0xbc, 0x03, 0xc1, 0x03, 0x19, 0x1f]);

/** Find and extract the Metro JS/Hermes bundle from an APK — the same
 *  candidate-path search as `tools/extract-apk-bundle.sh` (kept in sync by
 *  hand; this one returns bytes in-process for `hbc2js deps app.apk`
 *  instead of writing into the committed local-corpus fixture tree). */
export function extractBundleFromApk(apkPath: string): ExtractedBundle {
  if (!which("unzip")) {
    throw new Error("`unzip` not found on PATH; cannot extract a bundle from an .apk");
  }
  const entries = listZipEntries(apkPath);
  const candidates = ["assets/index.android.bundle", "assets/index.bundle"];
  let entryPath = candidates.find((c) => entries.includes(c));
  if (entryPath === undefined) {
    entryPath = entries.find((e) => /^assets\/.*\.hbc$/.test(e));
  }
  if (entryPath === undefined) {
    throw new Error(`no bundle found in ${apkPath} (looked for ${candidates.join(", ")} and assets/*.hbc)`);
  }
  const bytes = readZipEntry(apkPath, entryPath);
  if (bytes === null) {
    throw new Error(`found ${entryPath} in ${apkPath} but could not read it`);
  }
  const isHermes = bytes.length >= 12 && Buffer.from(bytes.subarray(0, 8)).equals(HERMES_MAGIC);
  const hbcVersion = isHermes ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8, true) : null;
  return { bytes, entryPath, isHermes, hbcVersion };
}

// Android permission -> npm-package hint, for guess.ts's `apkHints` (D17a
// point 3: "manifest permissions such as BILLING ... map to a guess"). The
// hint string is matched against a module's own string constants, so these
// are deliberately specific enough not to fire on unrelated code.
export function apkHintsFromEvidence(evidence: ApkEvidence): Map<string, string> {
  const hints = new Map<string, string>();
  for (const perm of evidence.permissions) {
    if (perm.endsWith("BILLING")) hints.set("react-native-iap", "react-native-iap");
    if (perm.includes("CAMERA")) hints.set("RNCamera", "react-native-camera");
    if (perm.includes("ACCESS_FINE_LOCATION") || perm.includes("ACCESS_COARSE_LOCATION")) hints.set("RNCGeolocation", "@react-native-community/geolocation");
  }
  for (const lib of evidence.nativeLibs) {
    if (lib.startsWith("libreanimated")) hints.set(lib, "react-native-reanimated");
    if (lib.startsWith("libhermes")) continue; // the runtime itself, not a dependency
    if (lib.startsWith("librnscreens")) hints.set(lib, "react-native-screens");
    if (lib.startsWith("libRNGoogleMaps") || lib.startsWith("libmaps")) hints.set(lib, "react-native-maps");
  }
  for (const asset of evidence.assetHints) {
    const pkg = ASSET_HINT_PACKAGES.get(asset);
    if (pkg !== undefined) hints.set(asset, pkg);
  }
  return hints;
}
