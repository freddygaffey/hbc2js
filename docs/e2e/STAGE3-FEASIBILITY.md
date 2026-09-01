# Stage-3 feasibility: can a decompiled `--split` tree be re-bundled and BOOTED?

CONSOLIDATION item 31 (Fred, 2026-09-01). Design-only doc plus a time-boxed
spike (`docs/e2e/STAGE3-FEASIBILITY.md`'s own scratch script, not shipped —
see §(f)). Scope: rn-template-0.72's `index.android.hbc`, 435 modules.

## (a) What the split tree is today, and what a Metro-loadable project needs

`src/split/index.ts` (D17i stage 1) writes one file per Metro module:

```js
// module_<id>.js
function factory(a1, a2, a3, a4, a5, a6, a7) { ... }
module.exports = factory;
```

`a1..a7` is exactly Metro's factory shape: `(global, require, importDefault,
importAll, module, exports, dependencyMap)` — the decompiled function keeps
its original bytecode parameter count and order, which happens to already
match Metro's convention because that's what Hermes compiled. `MODULES.json`
records `{ id, file, factoryFunctionIndex, deps }` per module plus a
resolved `entry` id (from the global code's `__r()` call, `src/split/entry.ts`),
and `index.js` does `module.exports = require('./module_<entry>.js')`.

Nothing currently *invokes* the factories. `index.js` requiring a module
file yields the `factory` function itself (because of `module.exports =
factory`), not a running module — Node's own `require()` has no concept of
Metro's numeric module ids or its `__d`/`__r` registry. A loader has to
supply that.

**Two loader options considered:**

1. **A Metro-compatible `__d`/`__r` shim.** Read `MODULES.json`, `require()`
   each `module_N.js` (a plain Node require — cheap, yields the factory
   function only, doesn't run it), register `{factory, deps}` by id, then
   `__r(entryId)`: lazily invoke a module's factory once, caching
   `module.exports`, tolerating circular deps by caching the module object
   *before* the factory runs (exactly Metro's protocol). The factory's `a2`
   (require) parameter becomes `(depId) => __r(depId)` and `a7`
   (dependencyMap) becomes the module's own `deps` array from
   `MODULES.json` — no path resolution needed, everything is by numeric id.
   This is the closest match to what the original bytecode does (Metro's
   runtime *is* an id-keyed `__d`/`__r` registry; Hermes's `require()`
   opcode-level behaviour is `dependencyMap[i]` → `__r`), so semantics
   transfer with the least new code.

2. **Rewrite every module boundary to relative `require('./module_N.js')`
   and rely on Node's own CommonJS loader.** `src/split/rewrite.ts` already
   does a *partial* version of this — for statically-recognised top-level
   `require(dependencyMap[i])` call sites (readability only, per the file's
   header comment) it rewrites `Reflect.apply(<requireParam>, undefined,
   [<depMapParam>[i]])` to a literal `require('./module_N.js')`. **This is
   a real hazard for booting, not just readability:** because `module_N.js`
   does `module.exports = factory`, a plain `require('./module_N.js')`
   returns the *unexecuted factory*, not the module's actual exports. Code
   like `r4 = r2.AppRegistry` (where `r2` came from such a rewritten
   require) would read `AppRegistry` off a function object and get
   `undefined`. Confirmed empirically in the spike (§f): the shim has to
   monkey-patch `Module._load` to intercept `./module_N.js` requests and
   route them through `__r(N)` instead of letting Node's loader run — i.e.
   option 2 does not stand on its own; it needs option 1's registry
   underneath it to be correct. `requireRewrites` coverage is also partial:
   381/435 split files still contain unrewritten `Reflect.apply` call
   shapes (not all of them requires — this repo's M4 baseline emits every
   call, including plain function calls, as `Reflect.apply`; the number is
   an upper bound on how much of the graph rewrite.ts's matcher missed, not
   a precise "requires missed" count).

**Recommendation: option 1** (a `__d`/`__r` shim), with the *existing*
`require('./module_N.js')` literal rewrite treated as a `Module._load`
interception target rather than removed — it's harmless and even a little
useful as a human-readable annotation of which numeric id a call resolves
to, as long as the loader intercepts it. Building a real project (RN-web or
Metro-alias) would want the shim itself, or Metro's own runtime
(`metro-runtime`'s `require.js`), driving execution; `--split`'s job stays
"prove the require graph + emit readable per-module files", not "emit a
runnable loader" — that's Stage 3's own deliverable, layered on top.

A secondary gap found while building the spike: **`--split` does not emit
the hbc2js runtime helper prelude** (`src/runtime/helpers.ts`'s
`__hbc_makeGenerator`, `__hbc_iterBegin`, `__hbc_HermesInternal`, etc. —
`grep -ohE '__hbc_[A-Za-z]+' module_*.js | sort -u` finds 8 distinct names
in the rn-template split tree) into any file or a shared runtime module.
Every module file that uses a helper references it as a bare, undefined
global. `decompile()`'s single-file output presumably prepends
`helperPrelude()`; `--split` needs its own copy of that logic (one
`__hbc_runtime.js` file + a `require` in every module that uses a helper,
or a global the loader installs) before a split tree can run standalone.
Filed as a follow-up, not fixed here (docs-only task).

## (b) Native surface inventory (rn-template-0.72, `--split` tree)

`grep -lE 'NativeModules|TurboModuleRegistry|requireNativeComponent|nativeFabricUIManager' module_*.js` → 7 of 435 files touch the surface *directly by name* (mostly inside React Native's own entry module, `module_1.js`, which defines lazy getters for `TurboModuleRegistry`/`NativeModules`/`requireNativeComponent`, plus a couple of error-message string literals and one Fabric `dispatchCommand` site). Everything else reaches native modules *through* that module, so the useful inventory is the set of module-name string literals passed to `TurboModuleRegistry.get[Enforcing]("<Name>")` / `NativeModules.<Name>`, found by grepping the string literal immediately preceding each `getEnforcing`/`.get(` call site across the whole tree:

50 distinct literals, 47 real module/native-component names after dropping incidental `"window"`/`"null"` matches:

| Class | Count | Names |
|---|---|---|
| **react-native-web provides (or the surface is unreachable on web)** | 15 | `AppState`, `Clipboard`, `Appearance`, `Vibration`, `AccessibilityInfo`, `PlatformConstants`, `Networking` (browser `fetch`/`XHR` underlies rnweb), `Timing` (rnweb uses `setTimeout`), `UIManager` (rnweb stub), `DevSettings`, `SourceCode`, `StatusBarManager` (no-op on web), `RCTView`, `RCTScrollView`, `RCTImageView` (rnweb reimplements `View`/`ScrollView`/`Image` as DOM components at the JS layer — `requireNativeComponent` calls for these should never fire once `react-native` is aliased to `react-native-web`, since rnweb's own `View`/etc. modules don't call `requireNativeComponent`) |
| **Stub with a no-op / fake (rnweb has no equivalent, but nothing app-visible depends on real behaviour)** | 16 | `AccessibilityManager`, `ActionSheetManager`, `BugReporting`, `DeviceEventManager`, `ExceptionsManager` (dev red-box, safe no-op), `FrameRateLogger`, `HeadlessJsTaskSupport`, `ImageLoader`, `JSCHeapCapture`, `JSCSamplingProfiler` (JSC-only, safe no-op under V8/Node), `LinkingManager` (rnweb's `Linking` uses `window.location`/`history`, module unreachable once aliased), `ModalManager`, `RedBox`, `SegmentFetcher`, `SoundManager`, `WebSocketModule` (browser already has a native `WebSocket` global; RN's module backs the same global on-device — unreachable once the environment provides its own `WebSocket`) |
| **Android-only, platform-gated (unreachable in a web/jsdom boot at all — `Platform.OS !== 'android'` branches never execute)** | 6 | `DialogManagerAndroid`, `IntentAndroid`, `PermissionsAndroid`, `ToastAndroid`, `PushNotificationManager`, `KeyboardObserver` (Android soft-keyboard events) |
| **Hard — needs real native, no web/stub equivalent that preserves behaviour** | 6 | `DeviceInfo` (dimensions — rnweb approximates via `window.innerWidth/innerHeight`, doable but not a straight stub), `NativeAnimatedModule`, `NativeAnimatedTurboModule` (rnweb's `Animated` runs JS-only, bypassing these — unreachable once aliased, downgrade from "hard" once confirmed empirically), `NativePerformanceCxx`, `NativePerformanceObserverCxx` (perf hooks — stub to no-op-with-zeroes, "hard" only in the sense of not being meaningfully emulable, not blocking) |

Net read: **most of the 47-name inventory disappears once `react-native` is
aliased to `react-native-web`**, because rnweb reimplements the JS-facing
API without calling `requireNativeComponent`/`NativeModules` for the things
it supports — the modules above are what's left *inside React Native
core's own module* (`module_1.js`) as lazy getters that are only exercised
if something actually calls them. The jsdom-without-rnweb spike in §(f)
necessarily hits a much smaller, more O/S-shaped surface (`DeviceInfo`,
`UIManager`, `window`) because it never gets past React Native core's own
early bootstrapping.

## (c) RN-web path

Two ways to get react-native-web providing the JS-facing API:

1. **Module alias** (Metro/webpack/jsdom-loader `resolve.alias`:
   `'react-native': 'react-native-web'`). Cleanest — every `require('react-native')`
   in the split tree (module 1 in this bundle) resolves to rnweb's package
   instead of the decompiled RN-core module, so the entire "hard" and
   "Android-only" rows in §(b) never execute. Needs a build step (Metro
   config or a webpack/esbuild alias) between the split tree and the
   browser/jsdom run, since `require('react-native')` currently means "the
   decompiled module 1", and would need renaming/removal so the alias can
   take over — a real integration step, not just a loader shim.
2. **Stub-and-boot the decompiled RN core as-is** (what §(f)'s spike does):
   keep module 1 as the decompiled React Native, and instead stub the
   *native* primitives it reaches for (`nativeModuleProxy`,
   `__fbBatchedBridge`, `nativeFabricUIManager`, `window`/DOM globals via
   jsdom) one level lower. Slower to converge (every native call site needs
   a stub, not just the ones rnweb doesn't cover) but doesn't require
   rewriting `require('react-native')` edges, so it composes directly with
   `--split`'s current output.

Recommended order: **(2) first, get to `AppRegistry.registerComponent`
under bare Node with recording stubs (§f's approach) to find the real
native-call floor; only pull in `react-native-web` + jsdom once that floor
is enumerated**, per the brief's "don't add rnweb until the shim boots
clean" instruction. "Boots", measured:

- No uncaught exception through `__r(entryId)`.
- `AppRegistry.registerComponent(name, factory)` observed to run (it's the
  last statement of `module_0.js`'s decompiled global-code entry — trivial
  to detect by wrapping/spying on the `AppRegistry` object the loader hands
  back from `__r(1)`, or simpler: instrument `Object.defineProperty`/method
  interception on the stub islands and look for a `registerComponent` call
  in the access log).
- Optionally, call the registered component factory and confirm it returns
  a React element tree (`react-test-renderer` or `ReactDOM` under jsdom) —
  a stronger "booted" bar than just registration, appropriate for the
  *next* milestone once registration itself is reliable.

## (d) Device path (`tools/device-roundtrip.sh`)

The existing script (read: header only, `tools/device-roundtrip.sh:1-40`)
proves decompile → repackage → run on a real Android device, but for a
**single re-assembled bundle** (`--variant js`, the whole decompiled file
dropped in place of `assets/index.android.bundle`), not a `--split` tree —
Hermes/Metro on-device wants one bundle, not 435 files. Extending this path
to Stage 3 means either (a) concatenating the split tree back into one
Metro-shaped bundle (the `__d`/`__r` shim's registration code, inlined,
followed by all 435 factories, followed by the entry `__r` call — this is
literally "write the shim as a bundle prelude instead of a Node script",
so §(f)'s shim is directly reusable there) or (b) serving the split tree
from a Metro dev server and pointing a debug-build RN app at it, which
exercises real Metro rather than a hand-rolled loader but is a much bigger
setup lift. (a) is the natural next step once the JS-side shim is proven —
same code, different host.

## (e) Effort/risk table

| Step | Effort | Risk | Notes |
|---|---|---|---|
| `--split` emits the runtime helper prelude | S | Low | Needed by any loader; currently every helper call is an undefined global in the split tree. Mechanical — reuse `helperPrelude()`. |
| `__d`/`__r` Node shim (§f's spike, hardened) | S–M | Low | Spike got 76/435 modules executing with ~3 stub iterations; diminishing-effort curve after that is native-surface enumeration, not shim design. |
| Enumerate + stub the native floor (bare Node, no rnweb) | M | Medium | Each new stub reveals the next call site; convergence isn't guaranteed to be fast — some code paths (Animated, Fabric) may need real semantics, not just "return a Proxy", to avoid *masking* bugs instead of booting past them. |
| jsdom for DOM globals (`window`, `document`) | S | Low | Off-the-shelf package; the spike's next failure (module 154, `ReferenceError: Property 'window' doesn't exist`) is exactly this. |
| react-native-web alias + real render | M–L | Medium | Requires deciding how `require('react-native')` edges get redirected in a `--split` tree (rewrite vs. loader-level alias) and a real DOM renderer; first point where "boots" can mean "produced pixels". |
| Device path (bundle-shaped shim via `device-roundtrip.sh`) | M | Medium-High | Depends on the JS-side shim being solid first; device flakiness (docs/DEVICE-TESTING.md quirks) adds its own cost independent of Stage 3. |

**Recommended first milestone:** *rn-template's `__r(entry)` runs under
bare Node (no rnweb, no jsdom) to `AppRegistry.registerComponent` being
observed, with every native access recorded and the stub list checked in*
— i.e., harden and land §(f)'s spike as a real `tools/e2e/`-style script
plus a fixture-pinned list of expected native accesses (so new accesses
show up as a diff, not a silent pass/fail). This is strictly upstream of
both the rnweb path and the device path, and per §(f) is roughly 60 more
native-surface stubs away from done, not a new architecture.

## (f) Spike result

Script: `Module._load`-patching `__d`/`__r` Node shim (`boot.mjs`) run
against the setup command's split tree, with `src/runtime/helpers.ts`'s
full helper prelude installed globally and every RN native touchpoint
(`nativeModuleProxy`, `__fbBatchedBridge`, `nativeFabricUIManager`,
`nativePerformanceNow`, `HermesInternal`, `performance`) replaced with a
recording `Proxy` whose function calls and constructions also return
proxies (so chained access like `NativeModules.DeviceInfo.getConstants().Dimensions.window.width`
doesn't throw partway through) and whose `Symbol.toPrimitive`/`valueOf`
return `0` (so arithmetic on stubbed values doesn't throw either). 3 stub
iterations, per the brief's cap:

1. **Baseline** — 17/435 modules executed, threw in module 181:
   `TypeError: Cannot read properties of undefined (reading 'Dimensions')`
   — `nativeModuleProxy.DeviceInfo.getConstants()` returned `undefined`
   because the proxy's `apply` trap returned `undefined`.
2. **Function calls return proxies too** — same module count/throw point,
   different error: `TypeError: Cannot convert object to primitive value`
   — arithmetic on `Dimensions.windowPhysicalPixels.width` (a proxy) has no
   primitive coercion.
3. **`Symbol.toPrimitive`/`valueOf`/`toString`/`Symbol.iterator` stubs** —
   **76/435 modules executed**, entry did not run to completion. First
   failure: **module 154**, `ReferenceError: Property 'window' doesn't
   exist` — a `typeof`/`in`-style browser-environment check with no
   fallback, i.e. exactly the jsdom boundary §(c) recommends stopping at
   for this spike (brief: don't add rnweb/DOM until the bare shim boots
   clean — this *is* that clean-stop point, not a dead end).

Top recorded native accesses (of 34 distinct, all from `DeviceInfo` and
`UIManager` — the app hasn't reached React Native's `nativeFabricUIManager`
or Turbo/Bridge internals yet, consistent with §(b)'s read that most native
surface is gated behind code paths the app hasn't executed yet):

```
4  nativeModuleProxy.DeviceInfo.getConstants().Dimensions.windowPhysicalPixels.scale.Symbol(Symbol.toPrimitive)
3  nativeModuleProxy.DeviceInfo.getConstants().Dimensions.windowPhysicalPixels.scale
3  nativeModuleProxy.DeviceInfo.getConstants().Dimensions.screenPhysicalPixels.scale
2  nativeModuleProxy.DeviceInfo.getConstants().Dimensions.screenPhysicalPixels.scale.Symbol(Symbol.toPrimitive)
2  nativeModuleProxy.UIManager.getConstants
2  nativeModuleProxy.UIManager.getConstants.()
2  nativeModuleProxy.UIManager.getConstants().ViewManagerNames
```

Confirms §(a)'s finding independently: the pre-existing `require('./module_N.js')`
literal rewrite in the split tree had to be intercepted at the Node module
loader level (`Module._load`) for booting to work at all — without that
patch the shim throws immediately (`r2.AppRegistry` on a factory function)
in module 0, before a single native access is recorded.

Not attempted in this spike (explicitly out of scope per the brief):
react-native-web, jsdom/DOM globals, device path.
