// A priority scheduler with a simulated clock: closures as jobs, a heap-ish
// sorted queue, nested loops with labelled continue, a while loop with
// multiple exits, and counters captured per job via bind/closure.
function createScheduler() {
  var queue = [];
  var now = 0;
  var seq = 0;
  var history = [];

  function schedule(name, at, priority, fn) {
    var job = { name: name, at: at, priority: priority, seq: seq++, fn: fn, runs: 0 };
    queue.push(job);
    queue.sort(function (a, b) { return a.at - b.at || b.priority - a.priority || a.seq - b.seq; });
    return function cancel() {
      var i = queue.indexOf(job);
      if (i < 0) return false;
      queue.splice(i, 1);
      return true;
    };
  }

  function runUntil(limit, maxJobs) {
    var ran = 0;
    tick: while (queue.length > 0) {
      if (queue[0].at > limit) break;
      if (ran >= maxJobs) { history.push('budget exhausted at t=' + now); return ran; }
      var job = queue.shift();
      now = Math.max(now, job.at);
      job.runs++;
      var result;
      try {
        result = job.fn(now, job);
      } catch (e) {
        history.push(job.name + '@' + now + ' threw ' + e.message);
        continue tick;
      }
      ran++;
      history.push(job.name + '@' + now + (result === undefined ? '' : '=' + result));
      if (result === 'stop') break tick;
    }
    return ran;
  }

  return { schedule: schedule, runUntil: runUntil, history: function () { return history.join(' '); }, pending: function () { return queue.map(function (j) { return j.name; }).join(','); }, time: function () { return now; } };
}

var s = createScheduler();
var repeatCount = 0;
function repeating(interval, times) {
  return function job(t, self) {
    repeatCount++;
    if (--times > 0) s.schedule(self.name, t + interval, self.priority, job);
    return 'left ' + times;
  };
}
s.schedule('heartbeat', 0, 1, repeating(5, 4));
s.schedule('flaky', 3, 2, function () { throw new Error('boom'); });
s.schedule('low', 3, 0, function () { return 'lo'; });
s.schedule('high', 3, 9, function () { return 'hi'; });
var cancelSpy = s.schedule('spy', 4, 5, function () { return 'should not run'; });
var cancelNever = s.schedule('never', 100, 0, function () {});
print('cancel spy: ' + cancelSpy() + ', again: ' + cancelSpy());
print('ran ' + s.runUntil(10, 100) + ' jobs by t=' + s.time() + ' pending=' + s.pending());
print(s.history());
print('ran ' + s.runUntil(50, 1) + ' with budget 1; ' + s.history().split(' ').slice(-2).join(' '));
print('ran ' + s.runUntil(200, 100) + ' pending=[' + s.pending() + '] repeatCount=' + repeatCount + ' cancelNever=' + cancelNever());

// Per-job counters via bind and via closure over a shared object.
var s2 = createScheduler();
var shared = { total: 0 };
function counterJob(label, state) {
  state.count = (state.count || 0) + 1;
  shared.total++;
  return label + state.count;
}
var stateA = {}, stateB = {};
for (var i = 0; i < 3; i++) {
  s2.schedule('A', i * 2, 0, counterJob.bind(null, 'a', stateA));
  s2.schedule('B', i * 2 + 1, 0, counterJob.bind(null, 'b', stateB));
}
s2.schedule('stopper', 3, 1, function () { return 'stop'; });
print('ran ' + s2.runUntil(100, 100) + ': ' + s2.history());
print('a=' + stateA.count + ' b=' + stateB.count + ' total=' + shared.total + ' pending=' + s2.pending());
print('ran ' + s2.runUntil(100, 100) + ' more; total=' + shared.total);

// Jobs scheduled in the same tick by a running job run after higher-priority peers of that tick.
var s3 = createScheduler();
s3.schedule('parent', 1, 5, function (t) { s3.schedule('child-hi', t, 9, function () { return 'c'; }); s3.schedule('child-lo', t, 1, function () { return 'c'; }); return 'p'; });
s3.schedule('sibling', 1, 3, function () { return 's'; });
s3.runUntil(1, 10);
print(s3.history());
