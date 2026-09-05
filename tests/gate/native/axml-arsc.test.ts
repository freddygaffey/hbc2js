// tests/gate/native/axml-arsc.test.ts
// ACCEPTANCE: spec 27 (docs/specs/27-native-side.md L1 — the minimal binary-XML
// (AndroidManifest.xml) and resources.arsc chunk decoders, spec 27 §1.2 / the
// native/manifest.json + native/resources.jsonl contracts). Shipped skipped
// with the spec, before implementation; property-based, against the hermetic
// synthetic APK fixture (spec 27 §3). Truth rule: an absent android:exported
// attribute is `null` (unknown), never a guessed boolean; a resource that is a
// reference stays a reference, never flattened by guessing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { looksLikeArsc, parseArsc, resolveReference, resourceRows } from "../../../src/native/arsc.ts";
import { looksLikeAxml, manifestFromAxml, parseAxml } from "../../../src/native/axml.ts";
import { openApk } from "../../../src/native/ingest.ts";

const APK = "tests/fixtures/native/synthetic.apk";

function entry(name: string): Uint8Array {
  const bytes = openApk(APK).read(name);
  assert.ok(bytes !== null, `${name} is missing from ${APK}`);
  return bytes;
}

test("axml: decodes AndroidManifest package + permissions + exported components from real binary-XML bytes (superset of apk.ts's heuristic)", () => {
  const bytes = entry("AndroidManifest.xml");
  assert.ok(looksLikeAxml(bytes), "the fixture manifest must be real binary XML, not text");
  const manifest = manifestFromAxml(parseAxml(bytes));
  // Everything apk.ts's heuristic string scan can reach:
  assert.equal(manifest.package, "com.example.app");
  assert.deepEqual([...manifest.permissions], ["android.permission.INTERNET"]);
  // ...and strictly more, which only a real decode can produce: versions, the
  // sdk block, components, their exported flag and their intent filters.
  assert.equal(manifest.versionName, "1.0.0");
  assert.equal(manifest.versionCode, 42);
  assert.deepEqual(manifest.usesSdk, { min: 24, target: 34 });
  const activity = manifest.components.find((c) => c.name === "com.example.app.MainActivity");
  assert.ok(activity !== undefined, "the exported activity was not decoded");
  assert.equal(activity.kind, "activity");
  assert.equal(activity.exported, true);
  assert.equal(activity.intentFilters.length, 1);
  const filter = activity.intentFilters[0]!;
  assert.deepEqual([...filter.actions], ["android.intent.action.VIEW"]);
  assert.deepEqual([...filter.categories], ["android.intent.category.BROWSABLE", "android.intent.category.DEFAULT"]);
  assert.deepEqual([...filter.data], [{ scheme: "exampleapp", host: "open", pathPrefix: null }]);
  // A real decode reports no heuristic caveat.
  assert.deepEqual([...manifest.notes], []);
});

test("axml: a manifest with no `android:exported` attribute yields `exported:null`, never a guessed boolean", () => {
  const root = parseAxml(entry("AndroidManifest.xml"));
  const manifest = manifestFromAxml(root);
  const service = manifest.components.find((c) => c.name === "com.example.app.CryptoService");
  assert.ok(service !== undefined, "the attribute-less service component was not decoded");
  assert.equal(service.kind, "service");
  // The fixture authors this component with NO android:exported at all.
  const findEl = (el: { name: string; attributes: readonly { name: string }[]; children: readonly unknown[] }): boolean => {
    if (el.name === "service") return el.attributes.some((a) => a.name === "exported");
    return (el.children as typeof el[]).some(findEl);
  };
  assert.equal(findEl(root), false, "the fixture's service must carry no android:exported attribute");
  assert.equal(service.exported, null);
  assert.notEqual(service.exported, false);
});

test("arsc: resolves an `@string/x` reference to its default-config value", () => {
  const bytes = entry("resources.arsc");
  assert.ok(looksLikeArsc(bytes));
  const table = parseArsc(bytes);
  assert.equal(resolveReference(table, "@string/APIGEE_DOMAIN"), "https://api.example.test");
  assert.equal(resolveReference(table, "@string/app_name"), "Example App");
  // Package-qualified and bare forms agree; an unknown name resolves to null
  // (absence), never to some other entry's value.
  assert.equal(resolveReference(table, "@com.example.app:string/APIGEE_DOMAIN"), "https://api.example.test");
  assert.equal(resolveReference(table, "@string/not_a_real_resource"), null);
  const rows = resourceRows(table);
  for (const r of rows) assert.equal(r.config, "default");
  assert.ok(rows.every((r) => r.key.startsWith("native:res:com.example.app/string/")));
});

test("arsc: a value that is itself a resource reference stays `{ref:...}`, not flattened", () => {
  const table = parseArsc(entry("resources.arsc"));
  const alias = resolveReference(table, "@string/api_url_alias");
  assert.ok(alias !== null && typeof alias === "object" && "ref" in alias, `expected a reference, got ${JSON.stringify(alias)}`);
  assert.equal(alias.ref, "@string/APIGEE_DOMAIN");
  // The whole point: it is NOT flattened to the target's value.
  assert.notEqual(JSON.stringify(alias), JSON.stringify("https://api.example.test"));
  const row = resourceRows(table).find((r) => r.key.endsWith("/api_url_alias"));
  assert.ok(row !== undefined);
  assert.deepEqual(row.value, { ref: "@string/APIGEE_DOMAIN" });
});
