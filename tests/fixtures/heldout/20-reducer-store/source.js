// A Redux-style store: reducer with switch on action types, immutable
// updates via spread, subscriptions with unsubscribe, a memoized selector
// closure and middleware composition with reduceRight.
function createStore(reducer, initial, enhancers = []) {
  let state = initial;
  let listeners = [];
  let dispatching = false;
  const base = {
    getState: () => state,
    subscribe(fn) {
      listeners = [...listeners, fn];
      let active = true;
      return () => { if (!active) return false; active = false; listeners = listeners.filter((l) => l !== fn); return true; };
    },
    dispatch(action) {
      if (dispatching) throw new Error('reducers may not dispatch');
      dispatching = true;
      try {
        state = reducer(state, action);
      } finally {
        dispatching = false;
      }
      for (const l of listeners) l(state, action);
      return action;
    },
  };
  const dispatch = enhancers.reduceRight((next, mw) => mw(base)(next), base.dispatch);
  return { ...base, dispatch };
}

const initialState = { todos: [], filter: 'all', nextId: 1, log: [] };
function todos(state = initialState, action) {
  switch (action.type) {
    case 'add': {
      const todo = { id: state.nextId, text: action.text, done: false };
      return { ...state, todos: [...state.todos, todo], nextId: state.nextId + 1 };
    }
    case 'toggle':
      return { ...state, todos: state.todos.map((t) => (t.id === action.id ? { ...t, done: !t.done } : t)) };
    case 'remove':
      return { ...state, todos: state.todos.filter((t) => t.id !== action.id) };
    case 'filter':
      return state.filter === action.filter ? state : { ...state, filter: action.filter };
    case 'nested':
      store.dispatch({ type: 'add', text: 'never' });
      return state;
    default:
      return state;
  }
}

function memoizeSelector(input, compute) {
  let lastInput, lastResult, hits = 0, misses = 0;
  const selector = (s) => {
    const i = input(s);
    if (i === lastInput) { hits++; return lastResult; }
    misses++;
    lastInput = i;
    return (lastResult = compute(i, s));
  };
  selector.stats = () => `hits=${hits} misses=${misses}`;
  return selector;
}
const visibleTodos = memoizeSelector((s) => s.todos, (list, s) => list.filter((t) => s.filter === 'all' || (s.filter === 'done') === t.done).map((t) => t.text));

const logger = (api) => (next) => (action) => {
  const before = api.getState().todos.length;
  const result = next(action);
  logLines.push(`${action.type}:${before}->${api.getState().todos.length}`);
  return result;
};
const thunk = (api) => (next) => (action) => (typeof action === 'function' ? action(api.dispatch, api.getState) : next(action));
const logLines = [];
const store = createStore(todos, undefined, [thunk, logger]);

const notified = [];
const unsub = store.subscribe((s, a) => notified.push(a.type + '#' + s.todos.length));
store.dispatch({ type: 'add', text: 'write tests' });
store.dispatch({ type: 'add', text: 'ship' });
store.dispatch((dispatch, getState) => { dispatch({ type: 'toggle', id: getState().todos[0].id }); dispatch({ type: 'add', text: 'celebrate' }); });
print(visibleTodos(store.getState()).join(', ') + ' | ' + visibleTodos.stats());
print(visibleTodos(store.getState()).join(', ') + ' | ' + visibleTodos.stats());
store.dispatch({ type: 'filter', filter: 'done' });
print(visibleTodos(store.getState()).join(', ') + ' | ' + visibleTodos.stats() + ' (filter changed but todos identity did not)');
store.dispatch({ type: 'filter', filter: 'done' });
print('same filter keeps state identity: ' + (store.getState() === store.getState()));
store.dispatch({ type: 'remove', id: 2 });
store.dispatch({ type: 'filter', filter: 'open' });
print(visibleTodos(store.getState()).join(', ') + ' | ' + visibleTodos.stats());
print('unsub twice: ' + unsub() + ',' + unsub());
store.dispatch({ type: 'unknown' });
try {
  store.dispatch({ type: 'nested' });
} catch (e) {
  print('nested dispatch: ' + e.message);
}
store.dispatch({ type: 'add', text: 'after error' });
print('notified: ' + notified.join(' '));
print('log: ' + logLines.join(' '));
print(JSON.stringify(store.getState().todos) + ' nextId=' + store.getState().nextId + ' initial untouched=' + (initialState.todos.length === 0));
