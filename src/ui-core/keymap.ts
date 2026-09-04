// src/ui-core/keymap.ts — docs/specs/22-ui-mvp.md §3.2: an app-level
// multi-key sequence dispatcher (editor-level vim motions are a separate
// concern, handled by @replit/codemirror-vim in the shell). Pure TypeScript,
// no DOM — the shell normalises browser KeyboardEvents into `KeyEvent`s and
// feeds them one at a time to `Keymap.feed`.
//
// Chord grammar (a chord binds one string to one action id):
//   - A chord is a sequence of steps, written with no separator needed
//     between bare-character steps: "gd" is g-then-d, "]f" is ]-then-f.
//   - A step is either a bare character ("g", "]", "/", "K" — case is
//     significant: "K" means the shifted key, matched via KeyEvent.key,
//     not an explicit Shift modifier), or `Mod[-Mod...]-Key` where Mod is
//     Ctrl|Alt|Shift|Meta and Key is a single character or one of the named
//     keys F1..F12, Left, Right, Up, Down, Enter, Tab, Escape, Space,
//     Backspace, Delete (aliased to KeyEvent.key values, e.g. Left ->
//     "ArrowLeft"). Examples: "Ctrl-o", "Ctrl-Shift-F", "Alt-Left".
//   - `<leader>` expands to the configured leader key (default "\\") as a
//     bare step; other bracket tokens: <esc> <cr>/<enter> <tab> <space> <bs>.
//   - At runtime (not in chord strings) a leading run of digit KeyEvents
//     (no leading "0") before any chord step accumulates as a repeat count,
//     e.g. typing "3" then "]" then "f" resolves `]f` with count 3.
//   - Two bound chords may never be prefix/extension of one another
//     (`createKeymap` throws at construction, naming both) — that would
//     make the shorter one unreachable or the dispatcher ambiguous.
//
// `Keymap.feed` returns `{ actionId, count }` once a chord resolves,
// `"pending"` while a (possibly multi-key) sequence is still in progress,
// or `"none"` when the sequence dead-ends (and is cleared). `Escape` and a
// gap longer than `timeoutMs` between keys both clear any pending sequence.

export interface KeyEvent {
  key: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  meta?: boolean;
}

export interface KeymapMatch {
  actionId: string;
  count: number;
}

export type KeymapResult = KeymapMatch | "pending" | "none";

export interface Keymap {
  /** Feed one normalised key event. `now` defaults to `Date.now()`; tests pass explicit timestamps to make timeouts deterministic. */
  feed(event: KeyEvent, now?: number): KeymapResult;
  /** Clear any in-progress sequence/count (also what `Escape` does). */
  reset(): void;
  /** True while a multi-key sequence or a count prefix is in progress. */
  isPending(): boolean;
  /** The chord string bound to `actionId` (the first one found, for display), if any. */
  chordFor(actionId: string): string | undefined;
}

export interface CreateKeymapOptions {
  /** chord string -> action id, e.g. the parsed contents of a preset JSON file. */
  preset: Record<string, string>;
  /** chord string -> action id, or `null` to unbind a preset chord. Overrides win over the preset. */
  overrides?: Record<string, string | null>;
  /** Bare key used for the `<leader>` token. Default "\\". */
  leader?: string;
  /** Gap (ms) after which a pending sequence is abandoned. Default 800. */
  timeoutMs?: number;
}

interface Step {
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

interface TrieNode {
  actionId?: string;
  chord?: string;
  children: Map<string, TrieNode>;
}

const NAMED_KEY_ALIASES: Record<string, string> = {
  left: "ArrowLeft",
  right: "ArrowRight",
  up: "ArrowUp",
  down: "ArrowDown",
  escape: "Escape",
  space: "Space",
  enter: "Enter",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
};

const BRACKET_TOKEN_ALIASES: Record<string, string> = {
  esc: "Escape",
  escape: "Escape",
  cr: "Enter",
  enter: "Enter",
  tab: "Tab",
  space: "Space",
  bs: "Backspace",
  backspace: "Backspace",
};

function bareStep(key: string): Step {
  return { key, ctrl: false, alt: false, shift: false, meta: false };
}

const NAMED_KEY_PATTERN = /^(F[1-9][0-9]?|Left|Right|Up|Down|Enter|Tab|Escape|Space|Backspace|Delete|.)/;
const MODIFIER_WORD_PATTERN = /^(Ctrl|Alt|Shift|Meta)-/i;

/** Parses a chord string (preset/override key) into a step sequence. Throws on malformed grammar. */
export function parseChord(chordStr: string, leader: string): Step[] {
  const steps: Step[] = [];
  let i = 0;
  while (i < chordStr.length) {
    const ch = chordStr[i]!;
    if (ch === " ") {
      i += 1;
      continue;
    }
    if (ch === "<") {
      const end = chordStr.indexOf(">", i);
      if (end === -1) throw new Error(`ui-core/keymap: unterminated "<" token in chord "${chordStr}"`);
      const name = chordStr.slice(i + 1, end).toLowerCase();
      i = end + 1;
      if (name === "leader") {
        steps.push(bareStep(leader));
        continue;
      }
      const alias = BRACKET_TOKEN_ALIASES[name];
      if (!alias) throw new Error(`ui-core/keymap: unknown token "<${name}>" in chord "${chordStr}"`);
      steps.push(bareStep(alias));
      continue;
    }
    let ctrl = false;
    let alt = false;
    let shift = false;
    let meta = false;
    let sawModifier = false;
    let j = i;
    for (;;) {
      const m = MODIFIER_WORD_PATTERN.exec(chordStr.slice(j));
      if (!m) break;
      sawModifier = true;
      const word = m[1]!.toLowerCase();
      if (word === "ctrl") ctrl = true;
      else if (word === "alt") alt = true;
      else if (word === "shift") shift = true;
      else meta = true;
      j += m[0].length;
    }
    // Whether or not a modifier prefix was consumed, the key itself may be
    // a multi-character named key (e.g. "F12", "Escape") or a single bare
    // character — both go through the same longest-match pattern so that
    // "F12" (no modifier) and "Shift-F12" parse the key identically.
    const keyMatch = NAMED_KEY_PATTERN.exec(chordStr.slice(j));
    if (!keyMatch || keyMatch[1] === undefined || keyMatch[1] === "") {
      if (sawModifier) throw new Error(`ui-core/keymap: chord "${chordStr}" has a modifier with no following key`);
      throw new Error(`ui-core/keymap: could not parse chord "${chordStr}" at position ${i}`);
    }
    const rawKey = keyMatch[1];
    const key = NAMED_KEY_ALIASES[rawKey.toLowerCase()] ?? rawKey;
    steps.push({ key, ctrl, alt, shift, meta });
    i = j + keyMatch[0].length;
  }
  if (steps.length === 0) throw new Error(`ui-core/keymap: empty chord`);
  return steps;
}

/**
 * The lookup key a chord step and a live KeyEvent must BOTH produce for the
 * step to match — so the normalisation below is symmetric by construction
 * (review-2026-09-05-keys, docs/BUGS.md).
 *
 * Three cases, because "case is significant" only makes sense for a bare
 * character step:
 *   - a NAMED key ("F12", "ArrowLeft"): shift is an explicit slot, as before;
 *   - a BARE single character ("K", "]", "/"): case-significant, shift is
 *     implicit in the character itself, so the slot is ignored ("x") — vim's
 *     "K" and a hypothetical "k" stay different chords;
 *   - a single character WITH Ctrl/Alt/Meta ("Ctrl-P", "Ctrl-Shift-N"): the
 *     character is lower-cased, because a browser reports `key: "p"` for
 *     Ctrl+P while the chord string writes it "P" — the two used to hash
 *     differently and the binding could never fire. Shift is then a real
 *     slot for letters (Ctrl-N and Ctrl-Shift-N are different chords) but
 *     ignored for punctuation and digits, whose shift state is keyboard-
 *     layout dependent ("/" is unshifted on US, shifted elsewhere).
 */
function stepMapKey(step: { key: string; ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }): string {
  const hasMod = step.ctrl || step.alt || step.meta;
  let key = step.key;
  let slot: string;
  if (key.length > 1) {
    slot = step.shift ? "1" : "0";
  } else if (!hasMod) {
    slot = "x";
  } else {
    const lower = key.toLowerCase();
    const isLetter = lower >= "a" && lower <= "z";
    key = lower;
    slot = isLetter ? (step.shift ? "1" : "0") : "x";
  }
  return `${step.ctrl ? 1 : 0}${step.alt ? 1 : 0}${step.meta ? 1 : 0}${slot}:${key}`;
}

function eventMapKey(event: KeyEvent): string {
  return stepMapKey({
    key: event.key,
    ctrl: !!event.ctrl,
    alt: !!event.alt,
    shift: !!event.shift,
    meta: !!event.meta,
  });
}

/** The normalised step keys of `chordStr` — the same strings `feed` hashes
 *  live events to. Two chords collide exactly when one array is a prefix of
 *  (or equal to) the other, which is what `keymap-resolve.ts`'s conflict
 *  check uses to vet a chord BEFORE `createKeymap` would throw on it. */
export function chordStepKeys(chordStr: string, leader: string = "\\"): string[] {
  return parseChord(chordStr, leader).map(stepMapKey);
}

function firstDescendantChord(node: TrieNode): string {
  if (node.chord !== undefined) return node.chord;
  for (const child of node.children.values()) {
    const found = firstDescendantChord(child);
    if (found) return found;
  }
  return "?";
}

function insertChord(root: TrieNode, chordStr: string, steps: Step[], actionId: string): void {
  let node = root;
  for (const step of steps) {
    if (node.actionId !== undefined) {
      throw new Error(
        `ui-core/keymap: chord "${chordStr}" conflicts with "${node.chord}" — "${node.chord}" is a prefix of "${chordStr}"`,
      );
    }
    const key = stepMapKey(step);
    let child = node.children.get(key);
    if (!child) {
      child = { children: new Map() };
      node.children.set(key, child);
    }
    node = child;
  }
  if (node.actionId !== undefined) {
    throw new Error(`ui-core/keymap: duplicate binding for chord "${chordStr}" (already bound to "${node.actionId}")`);
  }
  if (node.children.size > 0) {
    const longer = firstDescendantChord(node);
    throw new Error(`ui-core/keymap: chord "${chordStr}" conflicts with "${longer}" — "${chordStr}" is a prefix of "${longer}"`);
  }
  node.actionId = actionId;
  node.chord = chordStr;
}

function isCountDigit(event: KeyEvent, countStr: string): boolean {
  if (event.ctrl || event.alt || event.meta) return false;
  if (event.key.length !== 1) return false;
  const c = event.key;
  if (c < "0" || c > "9") return false;
  if (countStr === "" && c === "0") return false;
  return true;
}

/** KeyEvent key value -> the token a chord string writes it as. */
const KEY_TO_TOKEN: Record<string, string> = {
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
  " ": "Space",
};

/**
 * The chord string for a single live key event — what the in-app binding
 * recorder writes into `overrides`. Round-trips: `parseChord(formatChord(e))`
 * produces the step `e` matches.
 *
 * A bare printable character is written as itself (case-significant, shift
 * implicit: "?" not "Shift-/"); anything with Ctrl/Alt/Meta, or a named key,
 * gets the `Mod-…` form with a letter upper-cased the way the presets write
 * it ("Ctrl-P"). Returns undefined for a modifier pressed on its own.
 */
export function formatChord(event: KeyEvent): string | undefined {
  const raw = KEY_TO_TOKEN[event.key] ?? event.key;
  if (raw === "Shift" || raw === "Control" || raw === "Alt" || raw === "Meta" || raw === "CapsLock" || raw === "Dead") {
    return undefined;
  }
  const hasMod = !!event.ctrl || !!event.alt || !!event.meta;
  if (!hasMod && raw.length === 1) return raw;
  const parts: string[] = [];
  if (event.ctrl) parts.push("Ctrl");
  if (event.alt) parts.push("Alt");
  if (event.shift) parts.push("Shift");
  if (event.meta) parts.push("Meta");
  parts.push(raw.length === 1 ? raw.toUpperCase() : raw);
  return parts.join("-");
}

export function createKeymap(options: CreateKeymapOptions): Keymap {
  const leader = options.leader ?? "\\";
  const timeoutMs = options.timeoutMs ?? 800;

  const bindings = new Map<string, string>();
  for (const [chord, actionId] of Object.entries(options.preset)) bindings.set(chord, actionId);
  for (const [chord, actionId] of Object.entries(options.overrides ?? {})) {
    if (actionId === null) bindings.delete(chord);
    else bindings.set(chord, actionId);
  }

  const root: TrieNode = { children: new Map() };
  const chordForAction = new Map<string, string>();
  for (const [chord, actionId] of bindings) {
    const steps = parseChord(chord, leader);
    insertChord(root, chord, steps, actionId);
    if (!chordForAction.has(actionId)) chordForAction.set(actionId, chord);
  }

  let pendingNode = root;
  let countStr = "";
  let lastTime = 0;

  function reset(): void {
    pendingNode = root;
    countStr = "";
  }

  function isPending(): boolean {
    return pendingNode !== root || countStr !== "";
  }

  function feed(event: KeyEvent, now: number = Date.now()): KeymapResult {
    if (isPending() && now - lastTime > timeoutMs) {
      reset();
    }
    if (event.key === "Escape" && !event.ctrl && !event.alt && !event.meta) {
      reset();
      return "none";
    }
    if (pendingNode === root && isCountDigit(event, countStr)) {
      countStr += event.key;
      lastTime = now;
      return "pending";
    }
    const next = pendingNode.children.get(eventMapKey(event));
    if (!next) {
      reset();
      return "none";
    }
    lastTime = now;
    if (next.actionId !== undefined) {
      const count = countStr === "" ? 1 : Number.parseInt(countStr, 10);
      const actionId = next.actionId;
      reset();
      return { actionId, count };
    }
    pendingNode = next;
    return "pending";
  }

  function chordFor(actionId: string): string | undefined {
    return chordForAction.get(actionId);
  }

  return { feed, reset, isPending, chordFor };
}
