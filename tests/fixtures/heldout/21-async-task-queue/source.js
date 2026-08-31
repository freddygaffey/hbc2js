// A concurrency-limited task queue: Promise.race, sequential vs parallel
// awaiting, rejection paths inside loops (catch + continue), finally with
// rethrow, and promise chain ordering.
const order = [];
function task(name, steps, fail) {
  return async function () {
    for (let i = 0; i < steps; i++) {
      order.push(name + i);
      await null;
    }
    if (fail) throw new Error(name + ' failed');
    return name.toUpperCase();
  };
}

async function runLimited(tasks, limit) {
  const results = [];
  const running = new Set();
  for (const [index, t] of tasks.entries()) {
    const p = t().then(
      (v) => { results[index] = 'ok:' + v; },
      (e) => { results[index] = 'err:' + e.message; },
    ).finally(() => running.delete(p));
    running.add(p);
    if (running.size >= limit) await Promise.race(running);
  }
  await Promise.all(running);
  return results;
}

async function sequential(tasks) {
  const out = [];
  for (const t of tasks) {
    try {
      out.push(await t());
    } catch (e) {
      out.push('skipped(' + e.message + ')');
      continue;
    } finally {
      out.push('|');
    }
  }
  return out.join('');
}

async function withCleanup(fn) {
  let stage = 'start';
  try {
    stage = 'running';
    return await fn();
  } catch (e) {
    stage = 'failed';
    throw new Error('wrapped: ' + e.message);
  } finally {
    order.push('cleanup@' + stage);
  }
}

async function main() {
  const tasks = [task('a', 3), task('b', 1, true), task('c', 2), task('d', 1), task('e', 2, true)];
  print((await runLimited(tasks, 2)).join(' '));
  print('interleaving: ' + order.join(','));
  order.length = 0;
  print(await sequential(tasks));
  print('sequential: ' + order.join(','));
  order.length = 0;

  print(await withCleanup(task('x', 1)));
  try {
    await withCleanup(task('y', 1, true));
  } catch (e) {
    print(e.message);
  }
  print(order.join(','));

  const winner = await Promise.race([task('slow', 3)(), task('fast', 1)(), new Promise((r) => r('immediate'))]);
  print('race winner: ' + winner);
  const raceReject = await Promise.race([task('z', 2)(), task('w', 0, true)()]).then((v) => 'resolved ' + v, (e) => 'rejected ' + e.message);
  print(raceReject);

  const chain = [];
  const p = Promise.resolve(1)
    .then((v) => { chain.push('then1'); return v + 1; })
    .then((v) => { chain.push('then2'); throw new Error('mid ' + v); })
    .then(() => chain.push('skipped'))
    .catch((e) => { chain.push('catch:' + e.message); return 'recovered'; })
    .finally(() => chain.push('finally'))
    .then((v) => { chain.push('then3:' + v); return v; });
  chain.push('sync');
  print(await p + ' ' + chain.join(' '));

  const thenable = { then(resolve) { resolve('from thenable'); } };
  print(await thenable);
  return 'main done';
}

main().then(print, (e) => print('main crashed: ' + e.message));
print('scheduled');
