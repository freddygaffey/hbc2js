#!/usr/bin/env node
// tools/native-fixture/gen.mjs — generate the hermetic synthetic APK fixtures
// of docs/specs/27-native-side.md §3.
//
// Hard constraint (CLAUDE.md / D16 C5): no real-world APK may ever be
// committed. Every byte here is authored by us from the public AOSP format
// documentation, so the fixture is unquestionably ours and the parser
// round-trip (generate -> parse -> assert the authored values) is the property
// under test. No JVM, no download, no network: `node tools/native-fixture/
// gen.mjs` is the whole toolchain.
//
// Usage: node tools/native-fixture/gen.mjs [outDir]   (default tests/fixtures/native)
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDex } from "./dex.mjs";
import { ANDROID_NS, buildArsc, buildAxml } from "./res.mjs";
import { buildZip } from "./writer.mjs";

const RCBJM = "Lcom/facebook/react/bridge/ReactContextBaseJavaModule;";
const REACT_MODULE_ANN = "Lcom/facebook/react/module/annotations/ReactModule;";
const REACT_METHOD_ANN = "Lcom/facebook/react/bridge/ReactMethod;";
const PROMISE = "Lcom/facebook/react/bridge/Promise;";
const STRING = "Ljava/lang/String;";
const TURBO_MARKER = "Lcom/facebook/react/turbomodule/core/interfaces/TurboModule;";

/** classes.dex: the first-party bridge module (the CryptoModule-shaped
 *  regression for L3) + BuildConfig (the L6 `.env` channel). */
const DEX1 = [
  {
    name: "Lcom/example/app/CryptoModule;",
    super: RCBJM,
    access: 0x11,
    sourceFile: "CryptoModule.java",
    annotations: [{ type: REACT_MODULE_ANN, visibility: 1, elements: { name: { string: "Crypto" } } }],
    directMethods: [{ name: "<init>", ret: "V", params: [], access: 0x10001 }],
    virtualMethods: [
      { name: "getName", ret: STRING, params: [], access: 0x1 },
      {
        name: "generateKey",
        ret: "V",
        params: [STRING, PROMISE],
        access: 0x1,
        annotations: [{ type: REACT_METHOD_ANN, visibility: 1, elements: { isBlockingSynchronousMethod: false } }],
      },
      { name: "internalHelper", ret: "V", params: [], access: 0x2 },
    ],
  },
  {
    name: "Lcom/example/app/BuildConfig;",
    super: "Ljava/lang/Object;",
    access: 0x11,
    sourceFile: "BuildConfig.java",
    staticFields: [
      { name: "APPLICATION_ID", type: STRING, access: 0x19, value: { string: "com.example.app" } },
      { name: "APIGEE_DOMAIN", type: STRING, access: 0x19, value: { string: "https://api.example.test" } },
      { name: "DEBUG", type: "Z", access: 0x19, value: false },
    ],
    directMethods: [{ name: "<init>", ret: "V", params: [], access: 0x10001 }],
  },
];

/** classes2.dex: a third-party-shaped module (L4/L7) + a TurboModule spec (L2).
 *  Multi-dex is deliberate: the `dex` column must stay stable (L1 acceptance). */
const DEX2 = [
  {
    name: "Lcom/example/app/NativeCryptoSpec;",
    super: RCBJM,
    interfaces: [TURBO_MARKER],
    access: 0x401, // public abstract
    sourceFile: "NativeCryptoSpec.java",
    virtualMethods: [{ name: "generateKey", ret: STRING, params: [STRING], access: 0x401 }],
  },
  {
    name: "Lcom/oblador/keychain/KeychainModule;",
    super: RCBJM,
    access: 0x1,
    sourceFile: "KeychainModule.java",
    directMethods: [{ name: "<init>", ret: "V", params: [], access: 0x10001 }],
    virtualMethods: [
      { name: "getName", ret: STRING, params: [], access: 0x1 },
      {
        name: "setGenericPassword",
        ret: "V",
        params: [STRING, PROMISE],
        access: 0x1,
        annotations: [{ type: REACT_METHOD_ANN, visibility: 1, elements: {} }],
      },
    ],
  },
];

const a = (name, value) => ({ ns: ANDROID_NS, name, value });

/** The manifest: a package, a permission, an exported activity with a deep-link
 *  intent-filter, and one component with NO `exported` attribute (the
 *  `exported:null` acceptance test). */
const MANIFEST = {
  name: "manifest",
  attrs: [{ ns: null, name: "package", value: { s: "com.example.app" } }, a("versionCode", { int: 42 }), a("versionName", { s: "1.0.0" })],
  children: [
    { name: "uses-sdk", attrs: [a("minSdkVersion", { int: 24 }), a("targetSdkVersion", { int: 34 })] },
    { name: "uses-permission", attrs: [a("name", { s: "android.permission.INTERNET" })] },
    {
      name: "application",
      attrs: [a("label", { s: "Example App" })],
      children: [
        {
          name: "activity",
          attrs: [a("name", { s: "com.example.app.MainActivity" }), a("exported", { bool: true })],
          children: [
            {
              name: "intent-filter",
              children: [
                { name: "action", attrs: [a("name", { s: "android.intent.action.VIEW" })] },
                { name: "category", attrs: [a("name", { s: "android.intent.category.BROWSABLE" })] },
                { name: "category", attrs: [a("name", { s: "android.intent.category.DEFAULT" })] },
                { name: "data", attrs: [a("scheme", { s: "exampleapp" }), a("host", { s: "open" })] },
              ],
            },
          ],
        },
        // No android:exported at all -> exported must decode as null, never false.
        { name: "service", attrs: [a("name", { s: "com.example.app.CryptoService" })] },
      ],
    },
  ],
};

const RESOURCES = [
  { type: "string", name: "app_name", value: { s: "Example App" } },
  { type: "string", name: "APIGEE_DOMAIN", value: { s: "https://api.example.test" } },
  // A reference to APIGEE_DOMAIN (0x7f010001): must stay `{ref:...}`, never flattened.
  { type: "string", name: "api_url_alias", value: { ref: 0x7f010001 } },
];

const ASSET_INDEX = Buffer.from('{"hello":"native"}\n', "utf8");
const ASSET_FONT = Buffer.from("EXAMPLE-TTF-PLACEHOLDER\n", "utf8");

export function generate(outDir) {
  mkdirSync(outDir, { recursive: true });
  const manifest = buildAxml(MANIFEST);
  const dex1 = buildDex(DEX1);
  const dex2 = buildDex(DEX2);
  const arsc = buildArsc(0x7f, "com.example.app", RESOURCES);

  const apk = buildZip([
    { name: "AndroidManifest.xml", data: manifest },
    { name: "classes.dex", data: dex1 },
    { name: "classes2.dex", data: dex2 },
    { name: "resources.arsc", data: arsc },
    { name: "assets/index.json", data: ASSET_INDEX },
    { name: "assets/fonts/Example.ttf", data: ASSET_FONT },
  ]);
  writeFileSync(join(outDir, "synthetic.apk"), apk);

  // A second, deliberately incomplete APK: no resources.arsc and no assets, so
  // the "absent input yields zero rows + a note, never an error" rule has a
  // fixture of its own.
  const bare = buildZip([
    { name: "AndroidManifest.xml", data: manifest },
    { name: "classes.dex", data: dex1 },
  ]);
  writeFileSync(join(outDir, "no-resources.apk"), bare);
  return { apk: join(outDir, "synthetic.apk"), bare: join(outDir, "no-resources.apk"), sizes: { apk: apk.length, bare: bare.length } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const out = process.argv[2] ?? join(root, "tests", "fixtures", "native");
  const r = generate(out);
  process.stdout.write(`wrote ${r.apk} (${r.sizes.apk} bytes) and ${r.bare} (${r.sizes.bare} bytes)\n`);
}
