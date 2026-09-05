// src/native/react-modules.ts — RN native-module registration extraction.
// docs/specs/27-native-side.md §L2: over L1's classes.jsonl + methods.jsonl,
// recognise React Native module registrations (old-architecture bridge
// modules, new-architecture TurboModule spec classes, view managers) and
// write one `native/react-modules.jsonl` row per discovered module.
//
// Truth rule (spec 27 §1.4 / §4.2): a row is emitted only from facts present
// in the tables. A module whose name cannot be recovered is still emitted
// (never dropped), with `nameEvidence:"unresolved"` and `jsName:null` — never
// an invented name. A class that matches none of the known RN base
// classes/interfaces produces no row at all.
import { nativeModuleKey } from "../name-overlay/id.ts";
import type { NativeClassRow, NativeMethodRow, NativeModuleKind, NativeModuleNameEvidence, NativeModuleRow } from "./schema.ts";

// Known framework type descriptors. These are never resolved from a class row
// of our own (they are framework classes, not app code, so they never appear
// in `classes.jsonl`) — matched purely by descriptor string, exactly as they
// appear in a class's `super`/`interfaces` fields.
const BRIDGE_BASE_CLASSES = new Set<string>([
  "Lcom/facebook/react/bridge/ReactContextBaseJavaModule;",
  "Lcom/facebook/react/bridge/BaseJavaModule;",
]);
const VIEW_MANAGER_BASE_CLASSES = new Set<string>([
  "Lcom/facebook/react/uimanager/ViewManager;",
  "Lcom/facebook/react/uimanager/SimpleViewManager;",
]);
const TURBO_MODULE_MARKER = "Lcom/facebook/react/turbomodule/core/interfaces/TurboModule;";
const REACT_MODULE_ANNOTATION = "Lcom/facebook/react/module/annotations/ReactModule;";
const REACT_METHOD_ANNOTATION = "Lcom/facebook/react/bridge/ReactMethod;";

/** `Lcom/x/NativeFooSpec;` -> `Foo`, the RN codegen naming convention for a
 *  TurboModule spec class. `null` when the class name does not match. */
function turboSpecClassName(descriptor: string): string | null {
  const m = /\/Native([A-Za-z0-9_]+)Spec;$/.exec(descriptor);
  return m === null ? null : m[1]!;
}

function annotationName(c: NativeClassRow): string | null {
  for (const ann of c.annotations) {
    if (ann.type !== REACT_MODULE_ANNOTATION) continue;
    const v = ann.elements["name"];
    if (typeof v === "string") return v;
  }
  return null;
}

/** `methods` is already narrowed to one class by the caller (§L2 keys off
 *  `NativeClassRow.key`, not the raw descriptor `getName` reads off). */
function getNameConst(methods: readonly NativeMethodRow[]): string | null {
  for (const m of methods) {
    if (m.name !== "getName") continue;
    if (typeof m.constStringReturn === "string") return m.constStringReturn;
  }
  return null;
}

function classify(c: NativeClassRow): NativeModuleKind | null {
  if (c.super !== null && VIEW_MANAGER_BASE_CLASSES.has(c.super)) return "viewmanager";
  const isBridgeBase = c.super !== null && BRIDGE_BASE_CLASSES.has(c.super);
  if (!isBridgeBase) return null;
  const isTurbo = c.interfaces.includes(TURBO_MODULE_MARKER) || turboSpecClassName(c.name) !== null;
  return isTurbo ? "turbo" : "bridge";
}

function resolveName(c: NativeClassRow, kind: NativeModuleKind, methodsByClass: readonly NativeMethodRow[]): { jsName: string | null; evidence: NativeModuleNameEvidence } {
  const fromAnnotation = annotationName(c);
  if (fromAnnotation !== null) return { jsName: fromAnnotation, evidence: "annotation" };
  const fromGetName = getNameConst(methodsByClass);
  if (fromGetName !== null) return { jsName: fromGetName, evidence: "getName-const" };
  if (kind === "turbo") {
    const fromClassname = turboSpecClassName(c.name);
    if (fromClassname !== null) return { jsName: fromClassname, evidence: "classname" };
  }
  return { jsName: null, evidence: "unresolved" };
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Build `native/react-modules.jsonl` rows from L1's classes + methods
 *  tables. Pure: same input rows, same output rows (spec 27 §4.1). */
export function buildReactModules(classes: readonly NativeClassRow[], methods: readonly NativeMethodRow[]): NativeModuleRow[] {
  const methodsByClassKey = new Map<string, NativeMethodRow[]>();
  for (const m of methods) {
    const list = methodsByClassKey.get(m.class);
    if (list === undefined) methodsByClassKey.set(m.class, [m]);
    else list.push(m);
  }

  const rows: NativeModuleRow[] = [];
  for (const c of classes) {
    const kind = classify(c);
    if (kind === null) continue;
    const classMethods = methodsByClassKey.get(c.key) ?? [];
    const { jsName, evidence } = resolveName(c, kind, classMethods);

    let exported: readonly NativeMethodRow[];
    if (kind === "turbo") {
      exported = classMethods.filter((m) => m.access.includes("abstract"));
    } else if (kind === "viewmanager") {
      exported = [];
    } else {
      exported = classMethods.filter((m) => m.annotations.some((a) => a.type === REACT_METHOD_ANNOTATION));
    }

    rows.push({
      key: nativeModuleKey(jsName ?? c.name),
      jsName,
      kind,
      implClass: c.key,
      methods: exported.map((m) => ({ jsName: m.name, nativeMethod: m.key })).sort((a, b) => cmp(a.nativeMethod, b.nativeMethod)),
      nameEvidence: evidence,
      firstParty: null,
    });
  }

  rows.sort((a, b) => cmp(a.key, b.key));
  return rows;
}
