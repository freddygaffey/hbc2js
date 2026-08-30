// Evaluation order: getter as receiver in member access
// Tests that a.b in a.b.c(x) where a.b is a getter is not double-evaluated

let evals = 0;
const obj = {
  get b() {
    evals++;
    return {
      c: function() {
        return 'called';
      }
    };
  }
};

const result = obj.b.c();
print('result:', result);
print('evals:', evals);  // should be 1, not 2
