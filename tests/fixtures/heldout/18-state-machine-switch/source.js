// A connection state machine: switch on strings with fallthrough, nested
// switch, default in the middle, switch inside a while driving a labelled
// break, and a lookup-table alternative compared against it.
function transition(state, event) {
  switch (state) {
    case 'idle':
      switch (event) {
        case 'connect': return 'connecting';
        case 'ping':
        case 'pong': return 'idle';
        default: return 'error';
      }
    case 'connecting':
      if (event === 'ack') return 'online';
      if (event === 'timeout') return 'retrying';
      // fall through to the shared error handling below
    case 'retrying':
      if (event === 'connect') return 'connecting';
      if (event === 'giveup') return 'offline';
      return state === 'connecting' ? 'error' : 'retrying';
    case 'online':
      switch (event) {
        default: return 'online';
        case 'drop': return 'retrying';
        case 'close':
        case 'giveup': return 'offline';
      }
    case 'offline':
      return event === 'connect' ? 'connecting' : 'offline';
    default:
      return 'error';
  }
}

function run(events) {
  let state = 'idle';
  const trail = [state];
  let i = 0;
  loop: while (i < events.length) {
    const ev = events[i++];
    const next = transition(state, ev);
    switch (next) {
      case 'error':
        trail.push('!' + ev);
        break loop;
      case state:
        trail.push('(' + ev + ')');
        continue loop;
      default:
        trail.push(next);
    }
    state = next;
    if (state === 'offline') break;
  }
  return trail.join(' > ') + ' | consumed ' + i + '/' + events.length;
}

print(run(['connect', 'ack', 'ping', 'drop', 'connect', 'timeout', 'giveup', 'connect']));
print(run(['ping', 'pong', 'connect', 'bogus', 'ack']));
print(run(['connect', 'timeout', 'timeout', 'connect', 'ack', 'close']));
print(run([]));
print(run(['fly']));

// Switch with mixed types: strict comparison, no coercion; expression cases.
function kind(v) {
  const one = 1;
  switch (v) {
    case one: return 'number one';
    case '1': return 'string one';
    case true: return 'true';
    case null: return 'null';
    case undefined: return 'undefined';
    case one + one: return 'two';
    case NaN: return 'nan (unreachable)';
    case 'a' + 'b': return 'ab';
    default: return 'other:' + typeof v;
  }
}
print([1, '1', true, null, undefined, 2, NaN, 'ab', [1], 0].map(kind).join(' | '));

// Dense integer switch (jump-table shaped) with holes and a shared body.
function dayType(d) {
  let label;
  switch (d) {
    case 0: case 6: label = 'weekend'; break;
    case 1: label = 'monday'; break;
    case 2: case 3: case 4: label = 'midweek'; break;
    case 5: label = 'friday'; break;
    case 10: label = 'ten'; break;
    default: label = 'invalid';
  }
  return label;
}
print([0, 1, 2, 3, 4, 5, 6, 7, 10, -1, 1.5, '1'].map(dayType).join(','));

// Side effects in case expressions are evaluated in order until a match.
const probes = [];
function probe(v) { probes.push(v); return v; }
switch (3) {
  case probe(1): probes.push('body1');
  case probe(2): probes.push('body2'); break;
  case probe(3): probes.push('body3');
  case probe(4): probes.push('body4'); break;
  case probe(5): probes.push('body5');
}
print(probes.join(','));
