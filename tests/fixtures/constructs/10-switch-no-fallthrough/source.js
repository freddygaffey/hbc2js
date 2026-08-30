// switch where every case breaks, plus a return inside a case.
function describe(day) {
  switch (day) {
    case 0:
      return 'Sunday';
    case 1:
    case 2:
    case 3:
    case 4:
    case 5: {
      const label = 'Weekday#' + day;
      return label;
    }
    case 6:
      return 'Saturday';
    default:
      return 'invalid';
  }
}
for (const d of [0, 1, 3, 5, 6, 9]) {
  print(d, '->', describe(d));
}
