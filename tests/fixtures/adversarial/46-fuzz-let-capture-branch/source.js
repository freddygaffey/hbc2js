// Reduced (103 -> 76 lines, signature-preserving, 302 live checks) from
// construct-fuzzer find reports/fuzz/finds/v96-seed780933.js with
// tools/fuzz/minimise-live.mjs at v96, seed 780933 -- fuzz family F2
// (docs/BUGS.md 2026-09-04 family F2 row). OPEN BUG, kept per D22a.
//
// The candidate disagrees with the real Hermes VM on which branch of f3's
// `if ((0 === (outer + '')))` runs: the VM (and the JS spec) take the else
// branch and print `0 true` / `1 true`, the decompiled candidate takes the
// if branch and prints neither. `outer` is a module-level `let` captured by
// every f*, and it is read here through a string concatenation, so the
// condition is `0 === "0"` (false). Reducing further loses the signature:
// hermesc constant-folds a smaller `outer` (never reassigned) away, so the
// captured-environment read disappears with it.
let outer = 0;
function f0(a1, b1 = 0) {
  for (let i = 0; i < 3; i++) {
  print(i, true);
}
  if ((a1 ? `v-${-1}` : (a1 === 1))) {
  let t3 = ('b' ? true : 0);
} else {
  switch ([true, t3]) {
  default: print('other', false);
}
}
  return ('b' ? 'b' : 0);
}
function f1(a2, b2 = 0) {
  for (let i = 0; i < 2; i++) {
  print(i, ('b' ? 0 : true));
}
  for (let i = 0; i < 1; i++) {
  print(i, 'a');
}
  return '';
}
function f2(a3, b3 = 0) {
  switch ((0 < '')) {
  default: print('other', true);
}
  return (0 > b3);
}
function f3(a4, b4 = 0) {
  for (let i = 0; i < 1; i++) {
  print(i, (true ?? false));
}
  if ((0 === (outer + ''))) {
  switch ((b4 ? true : false)) {
}
} else {
  for (let i = 0; i < 2; i++) {
  print(i, true);
}
}
  return `v-${true}`;
}
try {
  const g = f0(0, 0);
  if (typeof g === 'object' && g !== null && typeof g.next === 'function') {
  } else {
    print('f0', g);
  }
} catch (e) {
}
try {
  const g = f1(0, 0);
  if (typeof g === 'object' && g !== null && typeof g.next === 'function') {
  } else {
    print('f1', g);
  }
} catch (e) {
}
try {
  const g = f2(0, 0);
  if (typeof g === 'object' && g !== null && typeof g.next === 'function') {
  } else {
    print('f2', g);
  }
} catch (e) {
}
try {
  const g = f3(0, 0);
  if (typeof g === 'object' && g !== null && typeof g.next === 'function') {
  } else {
    print('f3', g);
  }
} catch (e) {
}
print('outer', outer);