// Control flow: switch with fallthrough and default in the middle

function switchTest(x) {
  let result = [];

  switch (x) {
    case 1:
      result.push('case-1');
      // fallthrough
    case 2:
      result.push('case-2');
      break;
    default:
      result.push('default');
      break;
    case 3:
      result.push('case-3');
      break;
  }

  return result.join('|');
}

print('switch 1:', switchTest(1));
print('switch 2:', switchTest(2));
print('switch 3:', switchTest(3));
print('switch 0:', switchTest(0));
