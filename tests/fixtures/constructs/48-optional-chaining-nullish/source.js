// Optional chaining (?., ?.(), ?.[]) combined with ??.
const user = { profile: { name: 'Ada', contacts: null } };
print(user?.profile?.name);
print(user?.profile?.contacts?.email);
print(user?.missing?.deeper?.value);
print(user?.profile?.contacts?.email ?? 'no-email-on-file');

const arr = [1, 2, 3];
print(arr?.[0], arr?.[10] ?? 'out-of-range');

const api = {
  fetch: function () { return 'fetched'; }
};
print(api?.fetch?.());
print(api?.missingMethod?.() ?? 'method-not-found');

let calls = 0;
function withSideEffect() { calls++; return null; }
const shortCircuited = withSideEffect()?.property;
print('short-circuit result:', shortCircuited, 'calls:', calls);

print('zero is not nullish:', 0 ?? 'fallback');
print('empty string is not nullish:', '' ?? 'fallback');
print('null triggers fallback:', null ?? 'fallback');
print('false is not nullish:', false ?? 'fallback');
