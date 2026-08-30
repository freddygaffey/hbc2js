// Destructuring/spread: variable swap via destructuring

let a = 10;
let b = 20;

// Swap using destructuring
[a, b] = [b, a];

print('after swap - a:', a);
print('after swap - b:', b);

// More complex swap
let x = { val: 1 };
let y = { val: 2 };

[x, y] = [y, x];

print('x.val:', x.val);
print('y.val:', y.val);

// Swap in destructuring assignment with others
let c = 1;
let d = 2;
let e = 3;

[c, d, e] = [e, c, d];
print('rotated:', c, d, e);
