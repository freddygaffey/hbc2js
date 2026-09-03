// tests/fixtures/security/vuln-app/source/App.js — seeded-vulnerable fixture,
// spec 13 (P2.4 reuse-validation) §2.3 step 1. A small RN-shaped source app
// (NOT a real app; no actual react-native/require wiring) containing exactly
// the 10 seeded vulnerability classes spec 13 lists, one `// SEED:<class-id>`
// comment per class, ids matching tests/fixtures/security/vuln-app/ground-truth.json.
//
// This file is a TEST FIXTURE for scanner validation (Lane S / Semgrep,
// spec 13 §2). It is deliberately, obviously insecure — do not copy any
// pattern here into real code.
//
// The hardcoded-credential value below is DEFUSED AT REST: it is not the
// literal secret shape (no real vendor prefix/entropy), it is the
// tests/secrets/support/materialize.ts base64-chunked encoding of a fake
// Stripe-shaped test string, so this file never contains a byte sequence
// that could trip GitHub push protection or any of our own tier-C secret
// patterns (see tests/secrets/at-rest-defused.test.ts for the standing
// check on that scheme). Lane S implementation (spec 13 step 3) that needs
// the *materialized* (real-shaped) value for recall testing must undefuse
// it into a scratch copy at run time — see the fixture README, "materialize
// step" — never persist the materialized form to the repo.

// SEED:eval-network-data — eval() over data received from the network.
function handleServerConfig(responseBody) {
  return eval('(' + responseBody + ')');
}

// SEED:command-injection — unsanitized input reaches a shell-style bridge call.
function runDeviceCommand(userInput) {
  return NativeBridge.exec('sh -c "' + userInput + '"');
}

// SEED:sql-injection — string-built SQL query.
function findUserByName(name) {
  return db.query("SELECT * FROM users WHERE name = '" + name + "'");
}

// SEED:insecure-deeplink — deep-link handler navigates on unvalidated input.
function onDeepLink(url) {
  var target = url.replace('myapp://', '');
  return navigate(target);
}

// SEED:weak-hash — MD5 used for a password/credential hash.
function hashPassword(password) {
  return crypto.createHash('md5').update(password).digest('hex');
}

// SEED:hardcoded-credential — defused at rest, see file header + README.
var API_SECRET = 'hbc2js-defused:c2tfbGl2.ZV9GQUtF.MTIzNDU2.Nzg5MGFi.Y2RlZkZB.S0U5ODc2.NTQzMjEw';

// SEED:insecure-random — Math.random() used to mint a security token.
function makeSessionToken() {
  return Math.floor(Math.random() * 1000000000).toString(36);
}

// SEED:html-injection — unsanitized string injected into a WebView as HTML.
function renderBio(bio) {
  return webview.injectJavaScript('document.body.innerHTML = "' + bio + '"');
}

// SEED:path-traversal — user-controlled path segment concatenated onto a base dir.
function readAsset(name) {
  return FS.readFileSync(ASSET_DIR + '/' + name);
}

// SEED:disabled-tls — TLS verification explicitly turned off on a fetch.
function fetchInsecure(url) {
  return fetch(url, { rejectUnauthorized: false });
}

print(
  handleServerConfig,
  runDeviceCommand,
  findUserByName,
  onDeepLink,
  hashPassword,
  API_SECRET,
  makeSessionToken,
  renderBio,
  readAsset,
  fetchInsecure
);

// ---------------------------------------------------------------------------
// Lane O dependency stand-ins (spec 13 P2.4 step 2, docs/specs/13-reuse-
// validation.md §8.2 "extends the §2.3 fixture's build"). These are NOT real
// lodash/minimist/axios source (never copy third-party code into this repo,
// AGPL-adjacent hard rule applies to any third-party source generally) --
// they are synthetic Metro-__d()-shaped factories tagged with the real
// pinned package name+version (lockfile.json / ground-truth.json
// lockfilePins), so `hbc2js deps`'s existing __d() module-graph recovery
// (src/deps/dscan.ts) and signature-DB matching (src/deps/match.ts) can
// attribute them for real against a project-local signature DB generated
// from this exact compiled bytecode (tools/security/build-vulnapp-sigdb.ts
// -- self-consistent plumbing test, not a real-world detection claim; see
// README.md "Lane O fixture bundling" section). `__d` itself is a minimal
// stand-in for Metro's runtime module registrar (also not copied from
// anywhere -- three lines, calls its factory immediately).
function __d(factory, moduleId, deps) {
  factory();
}

// Each factory's own bytecode (not a nested closure -- exact-hash
// normalisation masks string-literal content, so a generic "declare a
// const, create a closure, return it" outer shape would hash identically
// across all three and could never be package-distinguishing evidence; the
// distinguishing control flow has to live in the factory body itself) is
// what the project-local signature (tools/security/build-vulnapp-sigdb.ts)
// fingerprints, giving both function- and module-level exact-hash evidence.
__d(
  function () {
    var total = 0;
    for (var i = 0; i < 7; i++) {
      total = total + 3 * 5 - i;
      if (total > 1000) {
        total = total % 997;
      }
    }
    return total + 'lodash@4.17.15'.length;
  },
  9001,
  []
);

__d(
  function () {
    var argv = ['--port', '--verbose'];
    var out = {};
    for (var i = 0; i < argv.length; i++) {
      var part = argv[i];
      if (part.indexOf('--') === 0) {
        out[part.slice(2)] = true;
      }
    }
    return out.count === undefined ? 'minimist@0.0.8'.length : out;
  },
  9002,
  []
);

__d(
  function () {
    var url = 'https://example.invalid/api';
    var method = 'GET';
    var full = url + (url.indexOf('?') >= 0 ? '&' : '?') + 'v=' + 'axios@0.21.0'.length;
    return { method: method, url: full };
  },
  9003,
  []
);
