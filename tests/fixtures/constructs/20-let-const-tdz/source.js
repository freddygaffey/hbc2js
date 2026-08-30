// Temporal dead zone: referencing let/const before declaration throws.
function tdzDemo() {
  try {
    print(beforeLet);
  } catch (e) {
    print('caught:', e.constructor.name, e instanceof ReferenceError);
  }
  let beforeLet = 'now-initialized';
  print('after declaration:', beforeLet);
}
tdzDemo();

function blockTdz() {
  let val = 'outer';
  {
    try {
      print(val);
    } catch (e) {
      print('inner block TDZ caught:', e.constructor.name);
    }
    let val2 = 'inner-shadow';
    let val = 'shadowed';
    print('inner val:', val, 'val2:', val2);
  }
  print('outer val unchanged:', val);
}
blockTdz();
