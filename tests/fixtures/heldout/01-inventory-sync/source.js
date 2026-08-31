// Inventory reconciliation: nested loops with labelled break/continue, a
// switch inside the loop, early returns and a running summary.
var warehouses = [
  { id: 'north', bins: [{ sku: 'A1', qty: 4 }, { sku: 'B2', qty: 0 }, { sku: 'C3', qty: 9 }] },
  { id: 'east', bins: [{ sku: 'A1', qty: 1 }, { sku: 'HALT', qty: 0 }, { sku: 'D4', qty: 2 }] },
  { id: 'west', bins: [{ sku: 'B2', qty: 5 }, { sku: 'C3', qty: 0 }, { sku: 'E5', qty: 7 }] },
];

function classify(bin) {
  if (bin.sku === 'HALT') return 'halt';
  if (bin.qty === 0) return 'empty';
  if (bin.qty < 3) return 'low';
  return 'ok';
}

function reconcile(list) {
  var totals = {};
  var visited = 0;
  var skipped = 0;
  outer: for (var w = 0; w < list.length; w++) {
    var wh = list[w];
    for (var b = 0; b < wh.bins.length; b++) {
      var bin = wh.bins[b];
      visited++;
      switch (classify(bin)) {
        case 'halt':
          print('halt seen in ' + wh.id + ' after ' + visited + ' bins');
          break outer;
        case 'empty':
          skipped++;
          continue;
        case 'low':
          print('low stock: ' + wh.id + '/' + bin.sku + '=' + bin.qty);
          // fall through
        case 'ok':
          totals[bin.sku] = (totals[bin.sku] || 0) + bin.qty;
          break;
        default:
          print('unreachable');
      }
      if (visited > 100) return null;
    }
    print('finished ' + wh.id);
  }
  return { totals: totals, visited: visited, skipped: skipped };
}

var r = reconcile(warehouses);
print('visited=' + r.visited + ' skipped=' + r.skipped);
var keys = Object.keys(r.totals).sort();
for (var i = 0; i < keys.length; i++) print(keys[i] + ' -> ' + r.totals[keys[i]]);

// Second pass without the halting bin: every warehouse finishes.
var r2 = reconcile(warehouses.map(function (wh) {
  return { id: wh.id, bins: wh.bins.filter(function (b) { return b.sku !== 'HALT'; }) };
}));
print('visited=' + r2.visited + ' skipped=' + r2.skipped + ' skus=' + Object.keys(r2.totals).length);

// A while(true) that returns from inside, and a do-while with continue.
function firstNegative(nums) {
  var i = 0;
  while (true) {
    if (i >= nums.length) return -1;
    if (nums[i] < 0) return i;
    i++;
  }
}
print('firstNegative=' + firstNegative([3, 2, -1, 0]) + ',' + firstNegative([]) + ',' + firstNegative([0, 0]));
var n = 0, acc = [];
do {
  n++;
  if (n % 2) continue;
  acc.push(n);
} while (n < 7);
print('evens=' + acc.join('|'));
