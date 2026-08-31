// Optional chaining and nullish coalescing in a navigation/route resolver:
// deep `?.`, `?.()`, `?.[]`, `??` vs `||`, logical assignment, and
// short-circuit side-effect counting.
let evaluations = 0;
function tick(v) { evaluations++; return v; }

const routes = {
  home: { params: { id: 0, title: '' }, meta: { deep: { level: 3 } }, onEnter: () => 'entered home' },
  profile: { params: null, meta: { deep: null }, onEnter: null },
  settings: { params: { id: 7, title: 'Settings' }, meta: undefined },
  0: { params: { id: 'zero' } },
};

function resolve(name) {
  const route = routes[name];
  const id = route?.params?.id ?? 'no-id';
  const title = route?.params?.title || 'untitled';
  const titleStrict = route?.params?.title ?? 'untitled';
  const level = route?.meta?.deep?.level ?? -1;
  const entered = route?.onEnter?.() ?? 'no handler';
  const viaIndex = routes?.[name]?.['params']?.['id'];
  return `${name}: id=${id} title=${title}/${titleStrict} level=${level} enter=${entered} idx=${viaIndex}`;
}

for (const name of ['home', 'profile', 'settings', 'missing', 0]) print(resolve(name));

// Short-circuiting stops evaluating the rest of the chain.
evaluations = 0;
const nothing = null;
const r1 = nothing?.[tick('a')].b[tick('c')];
const r2 = routes.home?.params[tick('id')];
const r3 = nothing?.method(tick('arg'));
print(`chain results ${r1} ${r2} ${r3}, evaluations=${evaluations}`);

// ?? only replaces null/undefined; || replaces every falsy value.
const falsy = [0, '', false, null, undefined, NaN];
print(falsy.map((v) => `${String(v)}:${v ?? 'N'}/${v || 'F'}`).join(' '));
print(String(null ?? undefined ?? 0 ?? 'x') + ' ' + String((null || undefined) ?? 'y') + ' ' + String(0 || null || 'z'));

// Logical assignment operators on a settings object.
const settings = { volume: 0, name: '', locale: null, debug: false };
settings.volume ??= 50;
settings.name ||= 'anon';
settings.locale ??= 'en';
settings.debug &&= 'never-set';
settings.extra ??= 'added';
settings.volume ||= 99;
settings.name &&= settings.name.toUpperCase();
print(JSON.stringify(settings));

// Function/getter targets inside chains.
const api = {
  get user() { evaluations++; return { name: 'Kim', friends: [{ name: 'Lee' }] }; },
  fetch: undefined,
};
evaluations = 0;
print(`${api.user?.friends?.[0]?.name} ${api.user?.friends?.[1]?.name} ${api.fetch?.('x')} ${api.missing?.deep.deeper.deepest} evaluations=${evaluations}`);
print(String(typeof api.fetch?.bind) + ' ' + String(routes.home.onEnter?.call?.(null)) + ' ' + String(delete routes.home?.meta) + ' ' + String(routes.home.meta));

// Optional chain with a throwing callee after a present object still throws.
try {
  routes.home.params?.id.toFixed(1).nope();
} catch (e) {
  print('threw ' + e.name);
}
print(String(routes.home.params?.id.toFixed?.(1)) + ' ' + String(routes.profile.params?.id.toFixed(1)));
