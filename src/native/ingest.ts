// src/native/ingest.ts — the native-ingestion orchestrator.
// docs/specs/27-native-side.md §L1.4: open an APK (or an extracted directory),
// read each source with the own-TS parsers, and write
// `<artifact>/native/{classes,methods,strings,resources,assets}.jsonl` +
// `native/manifest.json` + the `native` provenance block.
//
// Pure Node: the container is read by `src/native/zip.ts`, not by `unzip(1)`
// (spec 27 §L1 "no native binaries in the core path"). Read-only, local-only.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { nativeMethodKey, nativeTypeKey } from "../name-overlay/id.ts";
import { emptyManifest, looksLikeAxml, manifestFromAxml, parseAxml } from "./axml.ts";
import { looksLikeArsc, parseArsc, resourceRows } from "./arsc.ts";
import { parseDex } from "./dex.ts";
import { buildReactModules } from "./react-modules.ts";
import {
  assetKind,
  nativeHeader,
  sha256Hex,
  toNativeJsonl,
  type NativeAssetRow,
  type NativeClassRow,
  type NativeManifest,
  type NativeMethodRow,
  type NativeModuleRow,
  type NativeProvenance,
  type NativeResourceRow,
  type NativeStringRow,
  type SeamRow,
} from "./schema.ts";
import { writeSeams } from "./seams.ts";
import { readZipDirectory, readZipEntry } from "./zip.ts";

/** A read-only view of an APK or an extracted directory. */
export interface NativeContainer {
  readonly label: string;
  readonly sha256: string;
  /** Entry names, `/`-separated, archive order. */
  list(): string[];
  /** Bytes of one entry, or `null` when it is absent. */
  read(name: string): Uint8Array | null;
}

export function openApk(apkPath: string): NativeContainer {
  const bytes = new Uint8Array(readFileSync(apkPath));
  const dir = readZipDirectory(bytes);
  return {
    label: apkPath,
    sha256: sha256Hex(bytes),
    list: () => dir.filter((e) => !e.name.endsWith("/")).map((e) => e.name),
    read(name: string): Uint8Array | null {
      for (const e of dir) if (e.name === name) return readZipEntry(bytes, e);
      return null;
    },
  };
}

export function openExtractedDir(root: string): NativeContainer {
  const files: string[] = [];
  const walk = (d: string): void => {
    for (const ent of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile()) files.push(relative(root, p).split(sep).join("/"));
    }
  };
  walk(root);
  // The container sha of a directory is the sha of its sorted path+sha list:
  // recomputable, and it changes whenever any input file changes (§4.5).
  const digestInput = files.map((f) => `${f} ${sha256Hex(new Uint8Array(readFileSync(join(root, f))))}`).join("\n");
  return {
    label: root,
    sha256: sha256Hex(digestInput),
    list: () => [...files],
    read(name: string): Uint8Array | null {
      const p = join(root, ...name.split("/"));
      return existsSync(p) && statSync(p).isFile() ? new Uint8Array(readFileSync(p)) : null;
    },
  };
}

/** Every table L1 owns, before it is serialised. */
export interface NativeTables {
  readonly classes: readonly NativeClassRow[];
  readonly methods: readonly NativeMethodRow[];
  readonly strings: readonly NativeStringRow[];
  readonly resources: readonly NativeResourceRow[];
  readonly assets: readonly NativeAssetRow[];
  readonly reactModules: readonly NativeModuleRow[];
  readonly manifest: NativeManifest;
  readonly dexFiles: readonly string[];
  readonly notes: readonly string[];
}

/** `classes.dex`, `classes2.dex`, ... in load order (§L1.1 multi-dex). */
export function dexEntryNames(names: readonly string[]): string[] {
  const found: { name: string; n: number }[] = [];
  for (const name of names) {
    const m = /^classes(\d*)\.dex$/.exec(name);
    if (m === null) continue;
    found.push({ name, n: m[1] === "" ? 1 : Number(m[1]) });
  }
  found.sort((a, b) => a.n - b.n);
  return found.map((f) => f.name);
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Build every native table from a container. Pure: same bytes, same rows
 *  (§4.1) — no clock, no environment, no external tool. */
export function buildNativeTables(container: NativeContainer): NativeTables {
  const names = container.list();
  const notes: string[] = [];
  const classes: NativeClassRow[] = [];
  const methods: NativeMethodRow[] = [];
  const strings: NativeStringRow[] = [];

  const dexFiles = dexEntryNames(names);
  if (dexFiles.length === 0) notes.push("no classes*.dex in the container; zero class/method/string rows (absence, not failure)");
  dexFiles.forEach((name, dexIndex) => {
    const bytes = container.read(name);
    if (bytes === null) return;
    const image = parseDex(bytes);
    image.strings.forEach((s, i) => strings.push({ i, s, dex: dexIndex }));
    for (const c of image.classes) {
      classes.push({
        key: nativeTypeKey(c.name),
        name: c.name,
        super: c.super,
        interfaces: c.interfaces,
        access: c.access,
        sourceFile: c.sourceFile,
        annotations: c.annotations.map((a) => ({ type: a.type, elements: a.elements })),
        dex: dexIndex,
      });
      for (const m of c.methods) {
        methods.push({
          key: nativeMethodKey(c.name, m.name, m.proto),
          class: nativeTypeKey(c.name),
          name: m.name,
          proto: m.proto,
          access: m.access,
          annotations: m.annotations.map((a) => ({ type: a.type, elements: a.elements })),
          dex: dexIndex,
          ...(m.constStringReturn === undefined ? {} : { constStringReturn: m.constStringReturn }),
        });
      }
    }
  });

  // AndroidManifest.xml (§L1.2).
  let manifest: NativeManifest;
  const manifestBytes = container.read("AndroidManifest.xml");
  if (manifestBytes === null) {
    manifest = emptyManifest("no AndroidManifest.xml in the container; no manifest facts are recorded (absence, not a guess)");
  } else if (looksLikeAxml(manifestBytes)) {
    manifest = manifestFromAxml(parseAxml(manifestBytes));
  } else {
    manifest = heuristicManifest(manifestBytes);
  }
  notes.push(...manifest.notes);

  // resources.arsc (§L1.3).
  let resources: NativeResourceRow[] = [];
  const arscBytes = container.read("resources.arsc");
  if (arscBytes === null) {
    notes.push("no resources.arsc in the container; zero resource rows (absence, not failure)");
  } else if (!looksLikeArsc(arscBytes)) {
    notes.push("resources.arsc is present but does not start with the RES_TABLE chunk magic; zero resource rows, refused rather than guessed");
  } else {
    const table = parseArsc(arscBytes);
    resources = resourceRows(table);
    notes.push(...table.notes);
  }

  // assets (§L1 "inventory only": path/size/sha, never the bytes).
  const assets: NativeAssetRow[] = [];
  for (const name of names) {
    if (!name.startsWith("assets/")) continue;
    const bytes = container.read(name);
    if (bytes === null) continue;
    assets.push({ path: name, size: bytes.length, sha256: sha256Hex(bytes), kind: assetKind(name) });
  }

  classes.sort((a, b) => cmp(a.key, b.key) || a.dex - b.dex);
  methods.sort((a, b) => cmp(a.key, b.key) || a.dex - b.dex);
  strings.sort((a, b) => a.dex - b.dex || a.i - b.i);
  assets.sort((a, b) => cmp(a.path, b.path));

  // spec 27 §L2: derived from the classes/methods tables above, never from
  // raw DEX bytes directly (react-modules.ts only ever reads these rows).
  const reactModules = buildReactModules(classes, methods);

  return { classes, methods, strings, resources, assets, reactModules, manifest, dexFiles, notes };
}

/** §L1.2's documented fallback: when AndroidManifest.xml carries no AXML chunk
 *  magic we fall back to `apk.ts`'s heuristic UTF-16 string scan and SAY SO in
 *  `notes`, so no consumer mistakes a heuristic for a decode. */
function heuristicManifest(bytes: Uint8Array): NativeManifest {
  const strings: string[] = [];
  let cur = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const lo = bytes[i]!;
    const hi = bytes[i + 1]!;
    if (hi === 0 && lo >= 0x20 && lo < 0x7f) cur += String.fromCharCode(lo);
    else {
      if (cur.length >= 4) strings.push(cur);
      cur = "";
    }
  }
  if (cur.length >= 4) strings.push(cur);
  const permissions = strings.filter((s) => /^[a-z]+(\.[a-z]+)*\.permission\.[A-Z0-9_]+$/.test(s)).sort();
  const pkg = strings.find((s) => /^[a-z][a-z0-9_]*(\.[a-z0-9_]+){1,}$/.test(s) && !s.includes(".permission.")) ?? null;
  return {
    package: pkg,
    versionName: null,
    versionCode: null,
    permissions: [...new Set(permissions)],
    usesSdk: { min: null, target: null },
    components: [],
    notes: [
      "AndroidManifest.xml has no AXML chunk magic; fell back to apk.ts's heuristic UTF-16 string scan (spec 27 §L1.2) — package/permissions are heuristic, components are NOT recorded rather than guessed",
    ],
  };
}

/** Serialised form of every native file, relative path -> contents. */
export function serialiseNativeTables(tables: NativeTables): Map<string, string> {
  return new Map<string, string>([
    ["native/classes.jsonl", toNativeJsonl(nativeHeader("classes", "dex"), tables.classes)],
    ["native/methods.jsonl", toNativeJsonl(nativeHeader("methods", "dex"), tables.methods)],
    ["native/strings.jsonl", toNativeJsonl(nativeHeader("strings", "dex"), tables.strings)],
    ["native/resources.jsonl", toNativeJsonl(nativeHeader("resources", "arsc"), tables.resources)],
    ["native/assets.jsonl", toNativeJsonl(nativeHeader("assets", "zip"), tables.assets)],
    ["native/react-modules.jsonl", toNativeJsonl(nativeHeader("react-modules", "dex"), tables.reactModules)],
    ["native/manifest.json", JSON.stringify({ ...tables.manifest, notes: tables.manifest.notes }, null, 2) + "\n"],
  ]);
}

export function nativeProvenance(container: NativeContainer, tables: NativeTables, files: ReadonlyMap<string, string>): NativeProvenance {
  const fileBlock: Record<string, { sha256: string; rows: number }> = {};
  for (const [name, text] of [...files].sort((a, b) => cmp(a[0], b[0]))) {
    const lines = text.split("\n").filter((l) => l.length > 0);
    fileBlock[name] = { sha256: sha256Hex(text), rows: name.endsWith(".jsonl") ? lines.length - 1 : 1 };
  }
  return {
    schema: "hbc2js-native/1",
    source: container.label,
    sourceSha256: container.sha256,
    dexCount: tables.dexFiles.length,
    tool: "own-parser",
    files: fileBlock,
    counts: {
      classes: tables.classes.length,
      methods: tables.methods.length,
      strings: tables.strings.length,
      resources: tables.resources.length,
      assets: tables.assets.length,
      reactModules: tables.reactModules.length,
      components: tables.manifest.components.length,
    },
    notes: tables.notes,
  };
}

export interface IngestResult {
  readonly tables: NativeTables;
  readonly files: ReadonlyMap<string, string>;
  readonly provenance: NativeProvenance;
  /** spec 27 L3: rows written to `native/seams.jsonl`, or `null` when this
   *  directory holds no JS artifact to join against (no file is written). */
  readonly seams: readonly SeamRow[] | null;
}

/** Read `container` and write `<outDir>/native/*`. When `outDir` already holds
 *  an artifact `manifest.json`, the `native` provenance block is merged into
 *  it (§L1.4); the same block is always written to `native/ingest.json` so a
 *  standalone native ingest is still self-describing and staleness-checkable. */
export function ingestNative(container: NativeContainer, outDir: string): IngestResult {
  const tables = buildNativeTables(container);
  const files = serialiseNativeTables(tables);
  const provenance = nativeProvenance(container, tables, files);
  mkdirSync(join(outDir, "native"), { recursive: true });
  for (const [name, text] of files) writeFileSync(join(outDir, ...name.split("/")), text);
  // spec 27 L3: the JS<->native join, written only when BOTH halves exist.
  // Deliberately after the native tables above and outside `provenance`: the
  // provenance block describes what was read from the APK's bytes, and a seam
  // row is a join over two artifacts, not a byte reading.
  const seams = writeSeams(outDir, tables.reactModules);
  writeFileSync(join(outDir, "native", "ingest.json"), JSON.stringify(provenance, null, 2) + "\n");
  const artifactManifest = join(outDir, "manifest.json");
  if (existsSync(artifactManifest)) {
    const parsed = JSON.parse(readFileSync(artifactManifest, "utf8")) as Record<string, unknown>;
    parsed["native"] = provenance;
    writeFileSync(artifactManifest, JSON.stringify(parsed, null, 2) + "\n");
  }
  return { tables, files, provenance, seams: seams === null ? null : seams.rows };
}
