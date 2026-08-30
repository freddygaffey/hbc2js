// Control flow: labeled break across nested loops

let result = [];

outer: for (let i = 0; i < 3; i++) {
  for (let j = 0; j < 3; j++) {
    result.push(i * 10 + j);
    if (i === 1 && j === 1) {
      break outer;
    }
  }
}

print('break-outer:', result.join(','));

let result2 = [];

inner: for (let i = 0; i < 3; i++) {
  for (let j = 0; j < 3; j++) {
    result2.push(i * 10 + j);
    if (i === 1 && j === 1) {
      break inner;
    }
  }
}

print('break-inner:', result2.join(','));
