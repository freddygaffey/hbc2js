// A dense string switch, large enough for hermesc to emit StringSwitchImm at
// v98/v99 (catalogue row 8). v84/v94/v96 lower the same source as a compare
// chain, so the fixture also pins the version boundary itself.
function classify(word) {
  switch (word) {
    case 'alpha': return 1;
    case 'bravo': return 2;
    case 'charlie': return 3;
    case 'delta': return 4;
    case 'echo': return 5;
    case 'foxtrot': return 6;
    case 'golf': return 7;
    case 'hotel': return 8;
    case 'india': return 9;
    case 'juliett': return 10;
    case 'kilo': return 11;
    case 'lima': return 12;
    case 'mike': return 13;
    case 'november': return 14;
    case 'oscar': return 15;
    case 'papa': return 16;
    case 'quebec': return 17;
    case 'romeo': return 18;
    case 'sierra': return 19;
    case 'tango': return 20;
    case 'uniform': return 21;
    case 'victor': return 22;
    case 'whiskey': return 23;
    case 'xray': return 24;
    default: return -1;
  }
}

// Two adjacent cases sharing one body, so the jump table has a repeated target.
function bucket(word) {
  switch (word) {
    case 'red':
    case 'crimson':
      return 'warm';
    case 'blue':
    case 'azure':
      return 'cool';
    default:
      return 'other';
  }
}

const words = ['alpha', 'mike', 'xray', 'quebec', 'not-a-word', 'echo'];
for (let i = 0; i < words.length; i++) {
  print(words[i] + ' -> ' + classify(words[i]));
}
print(bucket('red') + ' ' + bucket('azure') + ' ' + bucket('green'));

// A switch on a value only known at run time, so nothing can be folded away.
let total = 0;
for (let i = 0; i < words.length; i++) {
  total += classify(words[i]);
}
print('total=' + total);
