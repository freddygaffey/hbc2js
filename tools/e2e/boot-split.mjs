#!/usr/bin/env node
// tools/e2e/boot-split.mjs — Stage-3 boot harness (docs/e2e/STAGE3-FEASIBILITY.md
// §f/§e's "recommended first milestone"): drive a decompiled `--split` tree
// as far as it will go under bare Node (no react-native-web, no jsdom),
// reusing the loader + recording-proxy native stub `tests/gate/split/loadable.test.ts`
// already landed (Gap A/B), and reporting how far it got.
//
//   node tools/e2e/boot-split.mjs <split-dir-or-bundle.hbc> [--json] [--stub-report]
//
// If the argument is a directory, it's required as an already-`--split`
// project tree (must contain index.js + MODULES.json). If it's a bundle
// (.hbc/.bundle) it's split into a scratch temp dir first (this repo's
// `splitProject`, never a re-implementation).
//
// This is deliberately a *harness*, not a test: `tests/sweep/e2e/boot-split.test.ts`
// drives it and pins a floor; iterating shims here is meant to be run by
// hand while developing (`--stub-report` to see the native surface, `--json`
// for machine consumption by the sweep test / CI).
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, extname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");

function parseArgs(argv) {
  let input;
  let json = false;
  let stubReport = false;
  for (const a of argv) {
    if (a === "--json") json = true;
    else if (a === "--stub-report") stubReport = true;
    else if (!a.startsWith("-")) input = a;
  }
  return { input, json, stubReport };
}

function splitToScratch(bundlePath) {
  const outDir = mkdtempSync(join(tmpdir(), "hbc2js-boot-split-"));
  const r = spawnSync(process.execPath, [join(repoRoot, "src", "cli.ts"), bundlePath, "--split", outDir], {
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(`hbc2js --split failed (status ${r.status}): ${r.stderr}`);
  }
  return outDir;
}

// The harness process: runs in a child so patched globals (Object.defineProperty,
// Module._load) never leak into the driving script, matching
// tests/gate/split/loadable.test.ts's isolation approach.
const HARNESS_SCRIPT = `
"use strict";
const path = require("path");

// --- native-surface recording proxy (same shape as
// tests/gate/split/loadable.test.ts / docs/e2e/STAGE3-FEASIBILITY.md §f) ---
const nativeAccesses = new Set();
function makeRecordingProxy(label) {
  const handler = {
    get(_t, prop) {
      if (prop === Symbol.toPrimitive) return () => 0;
      if (prop === "valueOf") return () => 0;
      if (prop === "toString") return () => "";
      if (prop === Symbol.iterator) return function* () {};
      if (prop === "then") return undefined;
      const next = label + "." + String(prop);
      nativeAccesses.add(next);
      return makeRecordingProxy(next);
    },
    apply() {
      nativeAccesses.add(label + "()");
      return makeRecordingProxy(label + "()");
    },
    construct() {
      nativeAccesses.add("new " + label);
      return makeRecordingProxy("new " + label);
    },
  };
  return new Proxy(function () {}, handler);
}

global.nativeModuleProxy = makeRecordingProxy("nativeModuleProxy");
global.__fbBatchedBridge = makeRecordingProxy("__fbBatchedBridge");
global.nativeFabricUIManager = makeRecordingProxy("nativeFabricUIManager");
global.nativePerformanceNow = () => 0;
global.performance = makeRecordingProxy("performance");
global.HermesInternal = makeRecordingProxy("HermesInternal");

// --- minimal browser-environment shims: enough to survive typeof/property
// checks, not a DOM (docs/e2e/STAGE3-FEASIBILITY.md: "do NOT pull in jsdom
// unless bare shims stall") ---
global.window = global;
global.self = global;
global.document = {
  createElement: () => makeRecordingProxy("document.createElement()"),
  addEventListener: () => {},
  removeEventListener: () => {},
};
// global.navigator already exists as a getter-only accessor on modern Node
// (process.getBuiltinModule-backed); redefine it rather than assign.
Object.defineProperty(global, "navigator", {
  value: { userAgent: "hbc2js-boot-harness", product: "hbc2js" },
  writable: true,
  configurable: true,
});

const rafQueue = [];
global.requestAnimationFrame = (cb) => {
  nativeAccesses.add("requestAnimationFrame()");
  rafQueue.push(cb);
  return rafQueue.length;
};
global.cancelAnimationFrame = () => {
  nativeAccesses.add("cancelAnimationFrame()");
};

// --- AppRegistry.registerComponent recording: react-native's own module
// exposes AppRegistry via a lazy Object.defineProperty getter (confirmed
// empirically: module_1.js's fn#109 "get AppRegistry"), so intercepting
// Object.defineProperty's "get" descriptors, and wrapping the resulting
// object's registerComponent method the first time it's produced, catches
// the call without needing to know which module id defines it ---
let registerComponentCall = null;
const origDefineProperty = Object.defineProperty;
Object.defineProperty = function (obj, prop, descriptor) {
  if (descriptor && typeof descriptor.get === "function") {
    const origGet = descriptor.get;
    let patched = false;
    descriptor = Object.assign({}, descriptor, {
      get() {
        const result = origGet.call(this);
        if (!patched && result && typeof result.registerComponent === "function") {
          patched = true;
          const origRegister = result.registerComponent;
          result.registerComponent = function (name, componentProvider) {
            if (registerComponentCall === null) {
              registerComponentCall = { name: String(name) };
            }
            return origRegister.apply(this, arguments);
          };
        }
        return result;
      },
    });
  }
  return origDefineProperty.call(this, obj, prop, descriptor);
};

const ran = new Set();
global.__hbc_split_onModuleRun = (id) => ran.add(id);

let threw = null;
let throwModule = null;
try {
  require(path.join(process.argv[2], "index.js"));
} catch (e) {
  const stack = e && e.stack ? String(e.stack) : String(e);
  threw = stack.split("\\n")[0];
  const m = /module_(\\d+)\\.js/.exec(stack);
  throwModule = m ? Number(m[1]) : null;
}

process.stdout.write(JSON.stringify({
  ran: Array.from(ran),
  threw,
  throwModule,
  registerComponentCall,
  nativeAccesses: Array.from(nativeAccesses).sort(),
}));
`;

function boot(splitDir) {
  const modulesJson = JSON.parse(readFileSync(join(splitDir, "MODULES.json"), "utf8"));
  const outDir = mkdtempSync(join(tmpdir(), "hbc2js-boot-harness-"));
  const harnessPath = join(outDir, "__harness.cjs");
  writeFileSync(harnessPath, HARNESS_SCRIPT);
  const r = spawnSync(process.execPath, [harnessPath, resolve(splitDir)], { encoding: "utf8", shell: false });
  if (r.status !== 0 && !r.stdout) {
    throw new Error(`boot harness process failed (status ${r.status}): ${r.stderr}`);
  }
  const parsed = JSON.parse(r.stdout);
  return {
    modulesExecuted: parsed.ran.length,
    total: modulesJson.moduleCount,
    reachedRegisterComponent: parsed.registerComponentCall !== null,
    componentName: parsed.registerComponentCall ? parsed.registerComponentCall.name : null,
    firstThrow: parsed.threw === null ? null : { module: parsed.throwModule, message: parsed.threw },
    nativeAccesses: parsed.nativeAccesses,
  };
}

function main() {
  const { input, json, stubReport } = parseArgs(process.argv.slice(2));
  if (!input) {
    process.stderr.write("usage: node tools/e2e/boot-split.mjs <split-dir-or-bundle.hbc> [--json] [--stub-report]\n");
    process.exit(2);
  }
  const inputPath = resolve(input);
  if (!existsSync(inputPath)) {
    process.stderr.write(`hbc2js boot-split: no such path ${inputPath}\n`);
    process.exit(2);
  }
  const isDir = statSync(inputPath).isDirectory();
  const splitDir = isDir ? inputPath : splitToScratch(inputPath);
  if (!isDir && !existsSync(join(splitDir, "index.js"))) {
    process.stderr.write(`hbc2js boot-split: split of ${inputPath} did not produce index.js\n`);
    process.exit(1);
  }

  const result = boot(splitDir);

  if (json) {
    process.stdout.write(JSON.stringify(result, null, stubReport ? 2 : 0) + "\n");
  } else {
    process.stdout.write(`modules executed: ${result.modulesExecuted} / ${result.total}\n`);
    process.stdout.write(`reached AppRegistry.registerComponent: ${result.reachedRegisterComponent}${result.componentName ? ` (component "${result.componentName}")` : ""}\n`);
    if (result.firstThrow) {
      process.stdout.write(`first unrecovered throw: module ${result.firstThrow.module ?? "?"}: ${result.firstThrow.message}\n`);
    } else {
      process.stdout.write("no unrecovered throw\n");
    }
    process.stdout.write(`distinct native/global accesses: ${result.nativeAccesses.length}\n`);
  }
  if (stubReport) {
    process.stdout.write("\n--- native/global access report ---\n");
    for (const a of result.nativeAccesses) process.stdout.write(a + "\n");
  }
}

main();
