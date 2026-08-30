// Dense integer switch intended to lower to a SwitchImm jump table:
// cases 0..12 (13 consecutive integers), with fallthrough in the middle
// and a default. `n` is read from an array so hermesc can't constant-fold it.
function classify(n) {
  let out = [];
  switch (n) {
    case 0:
      out.push('zero');
      break;
    case 1:
    case 2:
      out.push('one-or-two');
      break;
    case 3:
      out.push('three');
    case 4:
      out.push('three-or-four');
      break;
    case 5:
      out.push('five');
      break;
    case 6:
      out.push('six');
      break;
    case 7:
      out.push('seven');
      break;
    case 8:
      out.push('eight');
      break;
    case 9:
      out.push('nine');
      break;
    case 10:
      out.push('ten');
      break;
    case 11:
      out.push('eleven');
      break;
    case 12:
      out.push('twelve');
      break;
    default:
      out.push('other');
  }
  return out.join('+');
}

for (const n of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, -1, 100]) {
  print(n, '=>', classify(n));
}
