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
const SIMPLE_VIEW_MANAGER = "Lcom/facebook/react/uimanager/SimpleViewManager;";

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

/** classes.dex for `rn-modules.apk` (docs/specs/27-native-side.md §L2's own
 *  fixture — deliberately separate from `synthetic.apk`/`no-resources.apk`,
 *  which L1's tests pin). Every shape §L2's acceptance tests need, one class
 *  each: an annotated bridge module with both @ReactMethod and a plain
 *  method, a bridge module whose name only comes from a trivial getName()
 *  const-string body, a TurboModule spec class, a (Simple)ViewManager, a
 *  bridge module whose getName() has no decodable body (unresolvable), and an
 *  ordinary class that is not an RN module at all. */
const RN_MODULES_DEX = [
  {
    name: "Lcom/example/rn/CryptoBridge;",
    super: RCBJM,
    access: 0x11,
    sourceFile: "CryptoBridge.java",
    annotations: [{ type: REACT_MODULE_ANN, visibility: 1, elements: { name: { string: "CryptoBridge" } } }],
    directMethods: [{ name: "<init>", ret: "V", params: [], access: 0x10001 }],
    virtualMethods: [
      { name: "getName", ret: STRING, params: [], access: 0x1, body: { constString: "ShouldNeverWin" } },
      {
        name: "doWork",
        ret: "V",
        params: [STRING, PROMISE],
        access: 0x1,
        annotations: [{ type: REACT_METHOD_ANN, visibility: 1, elements: {} }],
      },
      { name: "internalOnly", ret: "V", params: [], access: 0x2 },
    ],
  },
  {
    name: "Lcom/example/rn/TrivialNameModule;",
    super: RCBJM,
    access: 0x11,
    sourceFile: "TrivialNameModule.java",
    directMethods: [{ name: "<init>", ret: "V", params: [], access: 0x10001 }],
    virtualMethods: [
      { name: "getName", ret: STRING, params: [], access: 0x1, body: { constString: "TrivialName" } },
      {
        name: "ping",
        ret: "V",
        params: [],
        access: 0x1,
        annotations: [{ type: REACT_METHOD_ANN, visibility: 1, elements: {} }],
      },
    ],
  },
  {
    name: "Lcom/example/rn/NativeStatsSpec;",
    super: RCBJM,
    interfaces: [TURBO_MARKER],
    access: 0x401, // public abstract
    sourceFile: "NativeStatsSpec.java",
    virtualMethods: [
      { name: "getStats", ret: STRING, params: [], access: 0x401 },
      { name: "reset", ret: "V", params: [], access: 0x401 },
    ],
  },
  {
    name: "Lcom/example/rn/StatsViewManager;",
    super: SIMPLE_VIEW_MANAGER,
    access: 0x11,
    sourceFile: "StatsViewManager.java",
    directMethods: [{ name: "<init>", ret: "V", params: [], access: 0x10001 }],
    virtualMethods: [{ name: "getName", ret: STRING, params: [], access: 0x1, body: { constString: "StatsView" } }],
  },
  {
    name: "Lcom/example/rn/UnresolvedModule;",
    super: RCBJM,
    access: 0x11,
    sourceFile: "UnresolvedModule.java",
    directMethods: [{ name: "<init>", ret: "V", params: [], access: 0x10001 }],
    // getName() with NO body at all: code_off stays 0, exactly like every
    // other non-trivial method — the honest "we cannot read this" case.
    virtualMethods: [{ name: "getName", ret: STRING, params: [], access: 0x1 }],
  },
  {
    name: "Lcom/example/rn/PlainUtil;",
    super: "Ljava/lang/Object;",
    access: 0x11,
    sourceFile: "PlainUtil.java",
    directMethods: [{ name: "<init>", ret: "V", params: [], access: 0x10001 }],
    virtualMethods: [{ name: "helperMethod", ret: "V", params: [], access: 0x1 }],
  },
];

/** classes.dex for `seams.apk` (docs/specs/27-native-side.md L3's own
 *  fixture — again separate bytes, so L1's and L2's pinned .apk files are
 *  untouched). The native half of the `66-native-module-seams` construct
 *  fixture: the CryptoModule-shaped regression (`@ReactModule(name="Crypto")`
 *  + `@ReactMethod generateKey`), a `CryptoStore` module that must NEVER link
 *  to the JS `Crypto` reference (the no-substring-matching proof), a native
 *  module the JS side never mentions (`native-only`), a view manager named
 *  `Y` (the `requireNativeComponent("Y")` half) and a TurboModule spec for
 *  `X` (the `TurboModuleRegistry.get("X")` half). */
const SEAMS_DEX = [
  {
    name: "Lcom/example/seam/CryptoModule;",
    super: RCBJM,
    access: 0x11,
    sourceFile: "CryptoModule.java",
    annotations: [{ type: REACT_MODULE_ANN, visibility: 1, elements: { name: { string: "Crypto" } } }],
    directMethods: [{ name: "<init>", ret: "V", params: [], access: 0x10001 }],
    virtualMethods: [
      {
        name: "generateKey",
        ret: "V",
        params: [STRING, PROMISE],
        access: 0x1,
        annotations: [{ type: REACT_METHOD_ANN, visibility: 1, elements: {} }],
      },
      { name: "wipe", ret: "V", params: [], access: 0x2 },
    ],
  },
  {
    name: "Lcom/example/seam/CryptoStoreModule;",
    super: RCBJM,
    access: 0x11,
    sourceFile: "CryptoStoreModule.java",
    annotations: [{ type: REACT_MODULE_ANN, visibility: 1, elements: { name: { string: "CryptoStore" } } }],
    directMethods: [{ name: "<init>", ret: "V", params: [], access: 0x10001 }],
    virtualMethods: [
      {
        name: "generateKey",
        ret: "V",
        params: [STRING, PROMISE],
        access: 0x1,
        annotations: [{ type: REACT_METHOD_ANN, visibility: 1, elements: {} }],
      },
    ],
  },
  {
    name: "Lcom/example/seam/AnalyticsModule;",
    super: RCBJM,
    access: 0x11,
    sourceFile: "AnalyticsModule.java",
    annotations: [{ type: REACT_MODULE_ANN, visibility: 1, elements: { name: { string: "Analytics" } } }],
    directMethods: [{ name: "<init>", ret: "V", params: [], access: 0x10001 }],
    virtualMethods: [
      {
        name: "track",
        ret: "V",
        params: [STRING],
        access: 0x1,
        annotations: [{ type: REACT_METHOD_ANN, visibility: 1, elements: {} }],
      },
    ],
  },
  {
    name: "Lcom/example/seam/NativeXSpec;",
    super: RCBJM,
    interfaces: [TURBO_MARKER],
    access: 0x401, // public abstract
    sourceFile: "NativeXSpec.java",
    virtualMethods: [{ name: "ping", ret: STRING, params: [], access: 0x401 }],
  },
  {
    name: "Lcom/example/seam/YViewManager;",
    super: SIMPLE_VIEW_MANAGER,
    access: 0x11,
    sourceFile: "YViewManager.java",
    directMethods: [{ name: "<init>", ret: "V", params: [], access: 0x10001 }],
    virtualMethods: [{ name: "getName", ret: STRING, params: [], access: 0x1, body: { constString: "Y" } }],
  },
];

const SEAMS_MANIFEST = {
  name: "manifest",
  attrs: [{ ns: null, name: "package", value: { s: "com.example.seam" } }],
  children: [{ name: "uses-sdk", attrs: [a("minSdkVersion", { int: 24 }), a("targetSdkVersion", { int: 34 })] }],
};

const RN_MODULES_MANIFEST = {
  name: "manifest",
  attrs: [{ ns: null, name: "package", value: { s: "com.example.rn" } }],
  children: [{ name: "uses-sdk", attrs: [a("minSdkVersion", { int: 24 }), a("targetSdkVersion", { int: 34 })] }],
};

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

  // The L2-owned third fixture (docs/specs/27-native-side.md §L2): every RN
  // module-registration shape, none of the L1-pinned bytes above touched.
  const rnManifest = buildAxml(RN_MODULES_MANIFEST);
  const rnDex = buildDex(RN_MODULES_DEX);
  const rnModules = buildZip([
    { name: "AndroidManifest.xml", data: rnManifest },
    { name: "classes.dex", data: rnDex },
  ]);
  writeFileSync(join(outDir, "rn-modules.apk"), rnModules);

  // The L3-owned fourth fixture (docs/specs/27-native-side.md L3): the native
  // half of the `66-native-module-seams` construct fixture.
  const seamsApk = buildZip([
    { name: "AndroidManifest.xml", data: buildAxml(SEAMS_MANIFEST) },
    { name: "classes.dex", data: buildDex(SEAMS_DEX) },
  ]);
  writeFileSync(join(outDir, "seams.apk"), seamsApk);

  return {
    apk: join(outDir, "synthetic.apk"),
    bare: join(outDir, "no-resources.apk"),
    rnModules: join(outDir, "rn-modules.apk"),
    seams: join(outDir, "seams.apk"),
    sizes: { apk: apk.length, bare: bare.length, rnModules: rnModules.length, seams: seamsApk.length },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const out = process.argv[2] ?? join(root, "tests", "fixtures", "native");
  const r = generate(out);
  process.stdout.write(`wrote ${r.apk} (${r.sizes.apk} bytes), ${r.bare} (${r.sizes.bare} bytes), ${r.rnModules} (${r.sizes.rnModules} bytes) and ${r.seams} (${r.sizes.seams} bytes)\n`);
}
