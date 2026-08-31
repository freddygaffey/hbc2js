// Sparse arrays and holes: what list-manipulation code sees when it deletes
// slots, grows `length`, or builds from Array(n).
var slots = [];
slots[0] = 'a';
slots[3] = 'd';
slots[7] = 'h';
print('length=' + slots.length + ' keys=' + Object.keys(slots).join(',') + ' join=' + slots.join('|'));
print('in: ' + [0 in slots, 1 in slots, 3 in slots, 8 in slots].join(',') + ' indexOf(undefined)=' + slots.indexOf(undefined) + ' includes(undefined)=' + slots.includes(undefined));

var visited = [];
slots.forEach(function (v, i) { visited.push(i + ':' + v); });
print('forEach visits ' + visited.join(' '));
var mapped = slots.map(function (v) { return v.toUpperCase(); });
print('map length=' + mapped.length + ' keys=' + Object.keys(mapped).join(',') + ' [1]=' + mapped[1]);
var filtered = slots.filter(function () { return true; });
print('filter -> ' + filtered.length + ' ' + filtered.join(','));
var counted = 0;
for (var i = 0; i < slots.length; i++) counted += slots[i] === undefined ? 0 : 1;
var forIn = [];
for (var k in slots) forIn.push(k);
print('for loop counted ' + counted + ', for-in keys ' + forIn.join(','));
print('reduce: ' + slots.reduce(function (acc, v, i) { return acc + i; }, 0) + ' some(undef)=' + slots.some(function (v) { return v === undefined; }) + ' every(str)=' + slots.every(function (v) { return typeof v === 'string'; }));

delete slots[3];
print('after delete: length=' + slots.length + ' keys=' + Object.keys(slots).join(',') + ' 3 in=' + (3 in slots));
slots.length = 2;
print('after length=2: ' + JSON.stringify(slots) + ' keys=' + Object.keys(slots).join(','));
slots.length = 5;
slots.push('p');
print('after grow+push: length=' + slots.length + ' last=' + slots[slots.length - 1] + ' keys=' + Object.keys(slots).join(','));

var fresh = Array(4);
print('Array(4): length=' + fresh.length + ' keys=[' + Object.keys(fresh).join(',') + '] join=' + fresh.join('-') + ' fill=' + fresh.fill(0).join(''));
var literal = [1, , 3, , ];
print('literal: length=' + literal.length + ' keys=' + Object.keys(literal).join(',') + ' from=' + Array.from(literal).map(String).join(',') + ' spread=' + [...literal].map(String).join(','));
print('Array.from({length:3}) = ' + Array.from({ length: 3 }, function (_, i) { return i * i; }).join(','));
print('apply(null, Array(3)) length = ' + (function () { return arguments.length; }).apply(null, Array(3)));

// sort with undefined and holes: undefined sorts last, holes vanish past it.
var mixed = [3, undefined, 1, , 2];
mixed.sort();
print('sorted length=' + mixed.length + ' keys=' + Object.keys(mixed).join(',') + ' -> ' + mixed.map(String).join(','));
var objs = [{ n: 2 }, { n: 1 }, { n: 3 }];
objs.sort(function (a, b) { return a.n - b.n; });
print(objs.map(function (o) { return o.n; }).join(''));

// Array-likes and negative / string indices.
var arrayLike = { 0: 'x', 1: 'y', length: 2, extra: 'z' };
print(Array.prototype.join.call(arrayLike, '+') + ' ' + Array.prototype.slice.call(arrayLike).length);
var arr = [10, 20, 30];
arr[-1] = 'neg';
arr['1'] = 'str';
arr['02'] = 'pad';
print('length=' + arr.length + ' keys=' + Object.keys(arr).join(',') + ' [-1]=' + arr[-1] + ' [1]=' + arr[1] + ' [2]=' + arr[2]);
print([arr.lastIndexOf(30), arr.indexOf('str'), arr.findIndex(function (v) { return v === 'nope'; }), arr.find(function (v) { return typeof v === 'number'; })].join(','));
