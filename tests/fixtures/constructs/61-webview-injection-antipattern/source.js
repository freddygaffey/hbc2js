// Minimal shapes of the WebView-injection anti-pattern (hunt lead C1,
// docs/specs/hunt-tooling-backlog.md line ~55, spec 17 §14.3): a static
// string whose quotes wrap a runtime substitution, built both as a template
// literal (hermesc: one `HermesInternal.concat` call) and as `+`
// concatenation (hermesc: an `Add`/`AddN`/`AddS` chain — never `concat`,
// docs/lowering/template-literals.md).
function injectTemplate(userValue) {
  return `window.postMessage('${userValue}')`;
}
print(injectTemplate('abc'));

function injectConcat(userValue) {
  return "window.postMessage('" + userValue + "')";
}
print(injectConcat('xyz'));

// Control: a substitution OUTSIDE any quotes is not the anti-pattern.
function safeTemplate(name) {
  return `Hello, ${name}!`;
}
print(safeTemplate('World'));
