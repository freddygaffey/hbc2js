// A wider dense integer switch (0..39, 40 cases) to exercise a larger
// SwitchImm/UIntSwitchImm jump table (more entries -> bigger table, bigger
// tableOffset) than 52-switch-jumptable's 13-case table. Also mixes in
// fallthrough runs and a default in the middle of the case list (default
// is not necessarily last -- decompilers must not assume so).
function bucket(n) {
  let out = [];
  switch (n) {
    case 0: case 1: case 2: case 3:
      out.push('low');
      break;
    case 4: case 5: case 6: case 7: case 8: case 9:
      out.push('mid-low');
      break;
    case 10:
      out.push('ten');
    case 11:
      out.push('ten-or-eleven');
      break;
    case 12: case 13: case 14: case 15: case 16:
    case 17: case 18: case 19: case 20: case 21:
      out.push('teens-twenties');
      break;
    default:
      out.push('other');
      break;
    case 22: case 23: case 24: case 25: case 26:
    case 27: case 28: case 29: case 30:
      out.push('high-twenties');
      break;
    case 31: case 32: case 33: case 34: case 35:
      out.push('thirties');
      break;
    case 36: case 37: case 38: case 39:
      out.push('late-thirties');
      break;
  }
  return out.join('+');
}

for (const n of [0, 3, 4, 9, 10, 11, 12, 21, 22, 30, 31, 35, 36, 39, -5, 40, 1000]) {
  print(n, '=>', bucket(n));
}
