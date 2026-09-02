# 2026-09-02 — navigator role-naming fallback — Sonnet, lean
Tokens 112k · tool calls 85 · green.

Added roleNameForRoutes/domainToken to src/split/segregate.ts: a navigator with >=4 resolved routes named after the domain token covering >=half its routes, else RootNavigator/MainTabNavigator (tab-aware). 3 new fixtures. react-navigation-example pinned (4/54, 6/58). NSW: of 26 navigators, 3 now route/role-named (VenueSignInNavigator + 2x RootNavigator), 23 still generic — because their ROUTE SETS don't resolve yet (two-statement depmap index + unrecognized route-config shapes, tracked in BUGS), not a naming-rule gap. Screens unchanged (36). Next lever: more route resolution → cascades to both navigator names AND more screens.
