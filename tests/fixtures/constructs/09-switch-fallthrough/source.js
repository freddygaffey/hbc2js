// switch with intentional fallthrough and a default in the middle.
function classify(n) {
  let out = [];
  switch (n) {
    case 1:
    case 2:
      out.push('one-or-two');
    case 3:
      out.push('through-three');
      break;
    default:
      out.push('default-hit');
    case 100:
      out.push('through-hundred');
      break;
    case 4:
      out.push('four');
  }
  return out.join('+');
}
for (const n of [1, 2, 3, 4, 50, 100]) {
  print(n, '=>', classify(n));
}
