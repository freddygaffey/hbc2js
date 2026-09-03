#!/usr/bin/env node
// tools/appgen/generate.mjs — app-generation fuzzer, SOURCE GENERATOR
// (docs/specs/09-fuzzing.md §2 "What is generated"). First increment: only
// the source-generation axes named in the brief are implemented —
//   - router shape: "stack" (literal Stack.Screen list), "tabs" (literal
//     Tab.Screen list), "weird" (routes built from a mapped array, screens
//     re-exported through a barrel — both variants the brief names)
//   - dependency-loading style: "static" import, "lazyRequire" (require()
//     inside a function), "reexport" (barrel indirection)
//   - 2-4 screens with seeded, distinctive names (tools/appgen/lib/wordlist.mjs)
// Build-config axes (spec §2.1's table): RN/Hermes version is now selectable
// via `generateApp(seed, { rnVersion })` (tools/appgen/lib/versions.mjs's
// pin table; build.mjs picks it). bundler (Metro plain/RAM) and obfuscation
// are build.mjs concerns, not source-generation ones -- see its header.
// libraries axis is still NOT varied (future increment). The seed fully
// determines the app; `fingerprint()` (tools/appgen/lib/manifest.mjs) is the
// dedup key used to reject a same-app re-generation (spec §2.3.1).
//
// Usage:
//   node tools/appgen/generate.mjs --seed 12345 --out /path/to/app-dir
//
// Also exports `generateApp(seed)` (pure, no fs) for tests and for build.mjs.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { makeRng } from "./lib/prng.mjs";
import { SCREEN_ADJECTIVES, SCREEN_NOUNS } from "./lib/wordlist.mjs";
import { fingerprint } from "./lib/manifest.mjs";

const ROUTER_SHAPES = ["stack", "tabs", "weird"];
const DEP_STYLES = ["static", "lazyRequire", "reexport"];

function screenNames(rng, count) {
  // Distinct adjective+noun combos, deterministic draw order.
  const adjectives = rng.pickDistinct(SCREEN_ADJECTIVES, count);
  const nouns = rng.pickDistinct(SCREEN_NOUNS, count);
  return adjectives.map((adj, i) => `${adj}${nouns[i]}`);
}

function screenFile(name) {
  return `${name}Screen`;
}

function screenSource(name) {
  const comp = screenFile(name);
  return `import React from 'react';
import { View, Text, Button } from 'react-native';

export default function ${comp}({ navigation }) {
  return (
    <View>
      <Text>${name}</Text>
      <Button title="Go" onPress={() => navigation && navigation.goBack && navigation.goBack()} />
    </View>
  );
}
`;
}

function barrelSource(names) {
  return names.map((n) => `export { default as ${screenFile(n)} } from './${screenFile(n)}';`).join("\n") + "\n";
}

function navigationSource(routerShape, depStyle, names) {
  const files = names.map(screenFile);
  const navigatorImport =
    routerShape === "tabs"
      ? "import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';\nconst Nav = createBottomTabNavigator();"
      : "import { createNativeStackNavigator } from '@react-navigation/native-stack';\nconst Nav = createNativeStackNavigator();";

  let screenImports;
  let screenRefs; // expression -> component identifier per screen file name
  if (depStyle === "static") {
    screenImports = `import { ${files.join(", ")} } from '../screens';`;
    screenRefs = files;
  } else if (depStyle === "lazyRequire") {
    // Metro's static dependency graph needs a literal string argument to
    // `require()` (dynamic path concatenation is rejected at transform
    // time), so "lazy" here means "require() deferred inside a function
    // body, one literal call per screen" rather than a top-level import —
    // still a distinct load shape from "static" and "reexport".
    screenImports = files
      .map((f) => `function load${f}() {\n  return require('../screens/${f}').default;\n}\nconst ${f} = load${f}();`)
      .join("\n");
    screenRefs = files;
  } else {
    // reexport: namespace import from the barrel, indirection through a
    // second identifier so the decompiled bundle actually shows a
    // re-export hop (spec §2's "re-export indirection" axis).
    screenImports = `import * as Screens from '../screens';\n${files.map((f) => `const ${f} = Screens.${f};`).join("\n")}`;
    screenRefs = files;
  }

  let body;
  if (routerShape === "weird") {
    const routeList = names
      .map((n, i) => `  { name: '${n}', component: ${screenRefs[i]} }`)
      .join(",\n");
    body = `const routeConfigs = [
${routeList},
];

export default function AppNavigator() {
  return (
    <Nav.Navigator>
      {routeConfigs.map((r) => (
        <Nav.Screen key={r.name} name={r.name} component={r.component} />
      ))}
    </Nav.Navigator>
  );
}
`;
  } else {
    const literalScreens = names
      .map((n, i) => `      <Nav.Screen name="${n}" component={${screenRefs[i]}} />`)
      .join("\n");
    body = `export default function AppNavigator() {
  return (
    <Nav.Navigator>
${literalScreens}
    </Nav.Navigator>
  );
}
`;
  }

  return `import React from 'react';
${navigatorImport}
${screenImports}

${body}`;
}

function appSource() {
  return `import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import AppNavigator from './src/navigation';

export default function App() {
  return (
    <NavigationContainer>
      <AppNavigator />
    </NavigationContainer>
  );
}
`;
}

function indexSource(appName) {
  return `import { AppRegistry } from 'react-native';
import App from './App';

AppRegistry.registerComponent('${appName}', () => App);
`;
}

function babelConfigSource() {
  return `module.exports = {
  presets: ['module:@react-native/babel-preset'],
};
`;
}

function metroConfigSource() {
  return `const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
module.exports = mergeConfig(getDefaultConfig(__dirname), {});
`;
}

// docs/specs/09-fuzzing.md §2.1 "RN + Hermes version" axis (increment-2 task
// brief item 1): react/babel-preset/metro-config versions must track the
// pinned react-native release (peer-dependency requirement), so this table
// keys off rnVersion rather than hardcoding one release everywhere.
const RN_TOOLING = {
  "0.73.11": { react: "18.2.0", babelPreset: "0.73.21", metroConfig: "0.73.5" },
  // RN >= 0.83 split @react-native-community/cli out of react-native core
  // (discovered empirically: `react-native bundle` fails without it in
  // devDependencies), unlike the 0.73.11 pin above.
  "0.86.0": { react: "19.2.3", babelPreset: "0.86.0", metroConfig: "0.86.0", cli: "^20.0.0" },
};

function packageJsonSource(appName, rnVersion) {
  const tooling = RN_TOOLING[rnVersion] || RN_TOOLING["0.73.11"];
  const pkg = {
    name: appName,
    version: "0.0.1",
    private: true,
    scripts: { start: "react-native start" },
    dependencies: {
      react: tooling.react,
      "react-native": rnVersion,
      "@react-navigation/native": "^6.1.9",
      "@react-navigation/native-stack": "^6.9.17",
      "@react-navigation/bottom-tabs": "^6.5.11",
      "react-native-screens": "^3.29.0",
      "react-native-safe-area-context": "^4.8.2",
    },
    devDependencies: {
      "@babel/core": "^7.20.0",
      "@babel/runtime": "^7.20.0",
      "@react-native/babel-preset": tooling.babelPreset,
      "@react-native/metro-config": tooling.metroConfig,
      ...(tooling.cli ? { "@react-native-community/cli": tooling.cli } : {}),
    },
  };
  return JSON.stringify(pkg, null, 2) + "\n";
}

/** Pure app-tree generator: `seed -> { manifest, files }` with no fs access,
 *  so it is trivially unit-testable for determinism (tests/appgen/generate.test.ts).
 *  `files` is a Map of repo-root-relative path -> file content string. */
export function generateApp(seed, { rnVersion = "0.73.11" } = {}) {
  const rng = makeRng(seed);
  const routerShape = rng.pick(ROUTER_SHAPES);
  const depStyle = rng.pick(DEP_STYLES);
  const count = 2 + rng.int(3); // 2..4
  const names = screenNames(rng, count);
  const appName = `Appgen${fingerprintSlug(seed)}`;

  const files = new Map();
  files.set("package.json", packageJsonSource(appName, rnVersion));
  files.set("babel.config.js", babelConfigSource());
  files.set("metro.config.js", metroConfigSource());
  files.set("index.js", indexSource(appName));
  files.set("App.js", appSource());
  files.set("src/screens/index.js", barrelSource(names));
  for (const n of names) {
    files.set(`src/screens/${screenFile(n)}.js`, screenSource(n));
  }
  files.set("src/navigation/index.js", navigationSource(routerShape, depStyle, names));

  const manifest = {
    schemaVersion: 1,
    seed: String(seed),
    seed32: rng.seed32,
    appName,
    routerShape,
    depStyle,
    screens: names,
    rnVersion,
    files: [...files.keys()].sort(),
  };
  manifest.fingerprint = fingerprint(manifest);

  return { manifest, files };
}

function fingerprintSlug(seed) {
  // Short, stable, filesystem-safe slug derived from the seed alone (not
  // the manifest — needed before the manifest exists, for the app name).
  const rng = makeRng(seed);
  return rng.seed32.toString(36);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--seed") out.seed = argv[++i];
    else if (argv[i] === "--out") out.out = argv[++i];
  }
  return out;
}

function writeApp(outDir, files) {
  for (const [rel, content] of files) {
    const full = join(outDir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.seed === undefined || args.out === undefined) {
    console.error("usage: node tools/appgen/generate.mjs --seed <seed> --out <dir>");
    process.exit(2);
  }
  const { manifest, files } = generateApp(args.seed);
  mkdirSync(args.out, { recursive: true });
  writeApp(args.out, files);
  writeFileSync(join(args.out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(JSON.stringify(manifest, null, 2));
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) main();
