// A read of a *missing global* throws a ReferenceError in every engine, at
// the same point, with the same constructor -- but Hermes words the message
// `Property 'missingCallee' doesn't exist` and V8 words it
// `missingCallee is not defined`. A program that prints `String(e)` therefore
// carries engine-specific prose inside ordinary `print` output, where the
// harness's err/unhandled message-masking channel never sees it, and every
// such program looked DIVERGENT.
//
// Regression fixture for fuzz family F3 (docs/BUGS.md 2026-09-04 family F3;
// docs/reports/2026-09-04-fuzz-families.md). The harness now projects both
// renderings onto one canonical, name-preserving form
// (`normaliseEngineMessages`, src/harness/trace.ts).
try { missingCallee(0, 0); } catch (e) { print(String(e)); }
try { print(missingRead); } catch (e) { print(String(e)); }
try { print(missingA(missingB())); } catch (e) { print(String(e)); }
function f0() { try { return missingInFunction(); } catch (e) { return String(e); } }
print(f0());
// `typeof` on a missing global never throws, in either engine.
print(typeof neverDefined);
// The name is preserved, so two different missing globals stay distinguishable.
try { alpha(); } catch (e) { print(String(e)); }
try { beta(); } catch (e) { print(String(e)); }
