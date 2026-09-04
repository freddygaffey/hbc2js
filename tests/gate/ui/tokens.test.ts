// tests/gate/ui/tokens.test.ts — spec 20 §1.2's token rule, mechanically
// enforced (spec 22 §3.4: "components use tokens only ... enforced by a
// gate test that greps `ui/src` for literal colours").
//
// This test is PURE FILE SCANNING on purpose: it runs under the root
// `npm test` with no `ui/node_modules` present and no build step, exactly
// like tests/gate/passes/imports.test.ts. It never imports from ui/.
//
// The rule: a colour may be named ONCE, in the theme layer
// (`ui/themes/*.json`, loaded to `:root` CSS variables by `ui/src/theme/**`).
// Everywhere else a colour is a token (`var(--accent)`, `bg-surface`,
// `text-sev-crit`). A component that types `#4c9be8` or `bg-slate-900` has
// invented art direction the owner did not seed, which is precisely what
// spec 20 §1.2 forbids.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { repoRoot } from "../../support/paths.ts";

const uiDir = join(repoRoot(), "ui");
const srcDir = join(uiDir, "src");
const themesDir = join(uiDir, "themes");

/** Files under here may name raw colours: this IS the token layer. */
const EXEMPT_DIRS = [join("src", "theme")];

const SCAN_EXT = [".ts", ".tsx", ".css"];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      out.push(...walk(p));
    } else if (SCAN_EXT.some((e) => entry.endsWith(e))) out.push(p);
  }
  return out;
}

const TAILWIND_PALETTE =
  "slate|gray|grey|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const COLOUR_UTILITIES =
  "bg|text|border|ring|fill|stroke|from|via|to|decoration|outline|shadow|accent|caret|divide|placeholder";

const RULES: readonly { readonly name: string; readonly re: RegExp }[] = [
  // `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa`. The lookbehind keeps HTML
  // entities (`&#8984;`) and fragment identifiers out of it.
  { name: "hex colour literal", re: /(?<![\w&])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![0-9a-fA-F\w-])/g },
  { name: "css colour function", re: /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix)\s*\(/g },
  { name: "tailwind literal colour class", re: new RegExp(String.raw`\b(?:${COLOUR_UTILITIES})-(?:${TAILWIND_PALETTE})-(?:50|[1-9]00|950)\b`, "g") },
  { name: "tailwind black/white class", re: new RegExp(String.raw`\b(?:${COLOUR_UTILITIES})-(?:black|white)\b`, "g") },
];

/** Every literal-colour violation in `text`, as `line: match` strings. */
function findColourLiterals(text: string): string[] {
  const out: string[] = [];
  const lines = text.split("\n");
  for (const rule of RULES) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      for (const m of line.matchAll(rule.re)) out.push(`line ${i + 1}: ${rule.name} ${JSON.stringify(m[0])}`);
    }
  }
  return out;
}

function isExempt(path: string): boolean {
  const rel = relative(uiDir, path);
  return EXEMPT_DIRS.some((d) => rel === d || rel.startsWith(d + sep));
}

test("ui components name no literal colours — tokens only (spec 20 §1.2)", () => {
  const files = [...walk(srcDir), join(uiDir, "index.html")].filter((f) => !isExempt(f));
  assert.ok(files.length > 5, `expected the UI shell's sources to be scanned, found ${files.length} files`);
  const violations: string[] = [];
  for (const f of files) {
    for (const v of findColourLiterals(readFileSync(f, "utf8"))) violations.push(`${relative(repoRoot(), f)} ${v}`);
  }
  assert.deepEqual(
    violations,
    [],
    `literal colours outside the token layer (ui/src/theme/**, ui/themes/*.json):\n${violations.join("\n")}\n` +
      "Use a token: var(--accent) / bg-surface / text-sev-crit. Add the colour to ui/themes/*.json if it does not exist yet.",
  );
});

test("the colour-literal detector actually fires (the gate cannot silently degrade)", () => {
  const samples: readonly string[] = [
    'const c = "#4c9be8";',
    "background: rgb(14 21 32);",
    "color: hsl(210 40% 50%);",
    '<div className="bg-slate-900" />',
    '<div className="text-red-500" />',
    '<div className="border-white" />',
  ];
  for (const s of samples) {
    assert.ok(findColourLiterals(s).length > 0, `detector missed a literal colour: ${s}`);
  }
  // ...and does not fire on the token forms the shell actually uses.
  for (const ok of ['className="bg-surface-2 text-text-muted"', "background: var(--bg);", "&#8984;K", 'className="text-sev-crit border-border"']) {
    assert.deepEqual(findColourLiterals(ok), [], `detector false-positived on a token form: ${ok}`);
  }
});

// -- theme presets ----------------------------------------------------------

type Json = string | number | boolean | null | { readonly [k: string]: Json } | readonly Json[];

function readJson(path: string): Json {
  return JSON.parse(readFileSync(path, "utf8")) as Json;
}

function isObject(v: Json): v is { readonly [k: string]: Json } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Every leaf token path, e.g. `palette.accent`, `densities.compact.unit`. */
function tokenPaths(v: Json, prefix = ""): string[] {
  if (!isObject(v)) return [prefix];
  const out: string[] = [];
  for (const [k, child] of Object.entries(v)) out.push(...tokenPaths(child, prefix === "" ? k : `${prefix}.${k}`));
  return out;
}

test("dark and light presets carry exactly the same tokens", () => {
  const dark = tokenPaths(readJson(join(themesDir, "dark.json"))).sort();
  const light = tokenPaths(readJson(join(themesDir, "light.json"))).sort();
  const onlyDark = dark.filter((p) => !light.includes(p));
  const onlyLight = light.filter((p) => !dark.includes(p));
  assert.deepEqual(onlyDark, [], `tokens only in dark.json: ${onlyDark.join(", ")}`);
  assert.deepEqual(onlyLight, [], `tokens only in light.json: ${onlyLight.join(", ")}`);
  assert.ok(dark.includes("palette.accent") && dark.includes("severity.crit"), "presets must carry palette + severity tokens");
});

test("ui/theme.json resolves to a preset, and overrides only known tokens", () => {
  const cfg = readJson(join(uiDir, "theme.json"));
  assert.ok(isObject(cfg), "ui/theme.json must be an object");
  const preset = cfg["preset"];
  assert.equal(typeof preset, "string", "ui/theme.json must name a preset");
  const presetPath = join(themesDir, `${String(preset)}.json`);
  assert.ok(existsSync(presetPath), `ui/theme.json names preset "${String(preset)}" but ${relative(repoRoot(), presetPath)} does not exist`);
  const known = new Set(tokenPaths(readJson(presetPath)));
  const overrides = cfg["overrides"];
  if (overrides !== undefined) {
    assert.ok(isObject(overrides), "ui/theme.json overrides must be an object");
    const unknown = tokenPaths(overrides).filter((p) => p !== "" && !known.has(p));
    assert.deepEqual(unknown, [], `ui/theme.json overrides unknown token paths: ${unknown.join(", ")}`);
  }
});

test("every density named by a preset is a full density spec", () => {
  for (const name of ["dark", "light"]) {
    const preset = readJson(join(themesDir, `${name}.json`));
    assert.ok(isObject(preset));
    const densities: Json | undefined = preset["densities"];
    assert.ok(densities !== undefined && isObject(densities), `${name}.json must carry a densities map`);
    for (const d of ["compact", "comfortable"]) {
      const spec: Json | undefined = densities[d];
      assert.ok(spec !== undefined && isObject(spec), `${name}.json is missing the "${d}" density`);
      for (const key of ["unit", "fontSize", "rowHeight"]) {
        assert.equal(typeof spec[key], "string", `${name}.json densities.${d}.${key} must be a string`);
      }
    }
    assert.ok(
      preset["density"] === "compact" || preset["density"] === "comfortable",
      `${name}.json must default to a known density`,
    );
  }
});
