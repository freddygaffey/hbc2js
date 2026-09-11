---
id: hbc-classify
kind: name-module
version: 1
---

# hbc-classify -- giving a decompiled module a role and a filename

You are looking at one module recovered from a React Native Hermes bundle. It
currently has a placeholder path such as `src/module_412.js`. Your job is to
say what the module IS and propose a filename that a human reading the tree
would recognise. You never change the module's code.

## Inputs

- `source` -- the decompiled module body as it renders today.
- `summary` -- module index, export shape, line count, and the placeholder path.
- `deps` -- the modules it requires and the modules that require it, with names
  where the dependency extractor already identified a package.
- `segregation` -- the bucket the module landed in (`app` / `vendor`) and the
  name signal the splitter recorded, if any.
- `strings` -- literals the module loads: route names, endpoint paths, action
  types, display strings.

Only `src/` (app) modules reach you. `node_modules` are already identified by
the dependency extractor and are never classified here.

## Rules

1. Choose exactly one role from: `screen`, `navigator`, `store`, `api-client`,
   `component`, `util`. If nothing fits, abstain rather than force a fit.
   - `screen` -- rendered as a route target; route/title strings, navigation
     params, a full-page layout.
   - `navigator` -- builds a navigator or a route table.
   - `store` -- holds and mutates app state; reducers, action types, selectors.
   - `api-client` -- talks to a network endpoint; URL literals, fetch/axios.
   - `component` -- a reusable presentational unit, not a route target.
   - `util` -- pure helpers with no UI and no state.
2. The filename follows the role's convention:
   `LoginScreen.js`, `RootNavigator.js`, `authStore.js`, `apiClient.js`,
   `PrimaryButton.js`, `formatDate.js`. A hook module is named for the hook it
   exports (`useAuth.js`).
3. Propose a directory that groups by feature, not by role
   (`src/auth/LoginScreen.js`, not `src/screens/LoginScreen.js`), when the
   evidence shows a feature; otherwise leave the directory as it is.
4. Evidence first: a route name literal, an endpoint path, a displayed title,
   or an exported hook name beats any structural hunch.
5. Never propose a filename that collides with an existing path in the tree,
   and never propose one that implies a security role the module does not have.
6. Leave a module alone if it already has a meaningful path.

## Output contract

Reply with one JSON object and nothing else:

```json
{
  "names": [
    {
      "bindingId": { "module": 412 },
      "name": "src/auth/LoginScreen.js",
      "confidence": "high",
      "evidence": "renders a form and registers route name \"Login\"; loads \"/v1/auth/login\""
    }
  ],
  "role": "screen",
  "abstained": false
}
```

- `bindingId` is echoed back from the request, unchanged.
- `name` is the full repo-relative path you propose, including the extension.
- `confidence` is `high` only when a route name, endpoint or exported hook
  name states the answer; `med` for a strong structural inference; `low`
  otherwise.
- `role` is one of the six roles above, omitted when you abstain.

## Abstain

Emit `{"names": [], "abstained": true}` when the module is a generated shim, a
bundler artefact, an unrecognisable fragment, or already well named. A tree
with honest `module_412.js` entries is better than a tree of confident lies.
