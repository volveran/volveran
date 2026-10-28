// The keyboard-command module: which command a key press gives in the queue
// list and in a Checkout, given what has focus, the Selection and whether a
// prompt is open.
import { describe, expect, it } from 'vitest';
import {
  commandFor,
  focusKindOf,
  SHORTCUTS,
  type KeyboardState,
  type KeyPress,
} from '../../src/web/keyboard-commands.js';

/** A key press written the way the shortcut list shows it: `j`, `Shift+D`, `Space`, `Shift+ArrowDown`. */
function press(written: string): KeyPress {
  const shift = written.startsWith('Shift+');
  const key = shift ? written.slice('Shift+'.length) : written;
  return { key: key === 'Space' ? ' ' : key, shiftKey: shift };
}

const queueList: KeyboardState = { view: 'queue-list', focus: 'other', prompt: false, selection: 0, focusedItem: true };
const checkout: KeyboardState = { view: 'checkout', focus: 'other', prompt: false, selection: 0, focusedItem: true };

describe('Keyboard commands in the queue list', () => {
  it('moves with j/k or the arrow keys', () => {
    expect(commandFor(press('j'), queueList)).toEqual({ kind: 'move', by: 1, extendSelection: false });
    expect(commandFor(press('ArrowDown'), queueList)).toEqual({ kind: 'move', by: 1, extendSelection: false });
    expect(commandFor(press('k'), queueList)).toEqual({ kind: 'move', by: -1, extendSelection: false });
    expect(commandFor(press('ArrowUp'), queueList)).toEqual({ kind: 'move', by: -1, extendSelection: false });
  });

  it('starts a Checkout on the focused queue with Enter, and leaves Enter to a focused button', () => {
    expect(commandFor(press('Enter'), queueList)).toEqual({ kind: 'start-checkout' });
    expect(commandFor(press('Enter'), { ...queueList, focusedItem: false })).toBeNull();
    expect(commandFor(press('Enter'), { ...queueList, focus: 'control' })).toBeNull();
  });

  it('has no Checkout bindings', () => {
    for (const k of ['Space', 'Shift+D', 'Shift+R', 'Shift+M', 'Shift+K', 'Shift+ArrowDown', '/']) {
      expect(commandFor(press(k), { ...queueList, selection: 3 }), k).toBeNull();
    }
  });
});

describe('Keyboard commands in a Checkout', () => {
  it('moves with j/k or the arrow keys, and leaves Enter alone', () => {
    expect(commandFor(press('j'), checkout)).toEqual({ kind: 'move', by: 1, extendSelection: false });
    expect(commandFor(press('ArrowDown'), checkout)).toEqual({ kind: 'move', by: 1, extendSelection: false });
    expect(commandFor(press('k'), checkout)).toEqual({ kind: 'move', by: -1, extendSelection: false });
    expect(commandFor(press('ArrowUp'), checkout)).toEqual({ kind: 'move', by: -1, extendSelection: false });
    expect(commandFor(press('Enter'), checkout)).toBeNull();
  });

  it('extends the Selection with Shift and an arrow key', () => {
    expect(commandFor(press('Shift+ArrowDown'), checkout)).toEqual({ kind: 'move', by: 1, extendSelection: true });
    expect(commandFor(press('Shift+ArrowUp'), checkout)).toEqual({ kind: 'move', by: -1, extendSelection: true });
  });

  it('toggles the focused Message in the Selection with Space, unless a button has focus', () => {
    expect(commandFor(press('Space'), checkout)).toEqual({ kind: 'toggle-selection' });
    expect(commandFor(press('Space'), { ...checkout, focusedItem: false })).toBeNull();
    expect(commandFor(press('Space'), { ...checkout, focus: 'control' })).toBeNull();
  });

  it('assigns a Decision to the Selection, or else to the focused Message, with Shift', () => {
    const withSelection = { ...checkout, selection: 2 };
    expect(commandFor(press('Shift+D'), withSelection)).toEqual({ kind: 'assign', decision: 'discard', to: 'selection' });
    expect(commandFor(press('Shift+R'), withSelection)).toEqual({ kind: 'assign', decision: 'replay', to: 'selection' });
    expect(commandFor(press('Shift+M'), withSelection)).toEqual({ kind: 'assign', decision: 'move', to: 'selection' });
    expect(commandFor(press('Shift+K'), withSelection)).toEqual({ kind: 'assign', decision: 'keep', to: 'selection' });
    expect(commandFor(press('Shift+D'), checkout)).toEqual({ kind: 'assign', decision: 'discard', to: 'focused-message' });
    expect(commandFor(press('Shift+K'), checkout)).toEqual({ kind: 'assign', decision: 'keep', to: 'focused-message' });
    expect(commandFor(press('Shift+R'), { ...checkout, focusedItem: false })).toBeNull();
  });

  it('assigns nothing without Shift: d, r and m do nothing and k moves', () => {
    expect(commandFor(press('d'), checkout)).toBeNull();
    expect(commandFor(press('r'), checkout)).toBeNull();
    expect(commandFor(press('m'), checkout)).toBeNull();
    expect(commandFor(press('k'), checkout)).toEqual({ kind: 'move', by: -1, extendSelection: false });
    // Caps Lock gives an upper-case key without Shift.
    expect(commandFor({ key: 'D', shiftKey: false }, checkout)).toBeNull();
  });

  it('focuses the filter with /', () => {
    expect(commandFor(press('/'), checkout)).toEqual({ kind: 'focus-filter' });
  });

  it('closes a prompt with Escape, or else clears the Selection', () => {
    expect(commandFor(press('Escape'), { ...checkout, prompt: true, selection: 2 })).toEqual({ kind: 'close-prompt' });
    expect(commandFor(press('Escape'), { ...checkout, selection: 2 })).toEqual({ kind: 'clear-selection' });
    expect(commandFor(press('Escape'), checkout)).toBeNull();
  });

  it('opens the shortcut list with ?', () => {
    // `?` is Shift+/ on most layouts.
    expect(commandFor({ key: '?', shiftKey: true }, checkout)).toEqual({ kind: 'show-shortcuts' });
    expect(commandFor({ key: '?', shiftKey: true }, queueList)).toEqual({ kind: 'show-shortcuts' });
  });

  it('does nothing else while a prompt or the shortcut list is open', () => {
    const open = { ...checkout, prompt: true, selection: 2 };
    for (const k of ['j', 'ArrowDown', 'Shift+ArrowDown', 'Space', 'Shift+D', 'Shift+R', 'Shift+M', 'Shift+K', '/', '?']) {
      expect(commandFor(press(k), open), k).toBeNull();
    }
  });

  it('only closes the Apply confirmation while it is open, whatever button has focus', () => {
    // The Apply confirmation opens with Cancel (or the typed queue name) focused and counts as a prompt.
    for (const focus of ['control', 'other'] as const) {
      const confirming = { ...checkout, focus, prompt: true, selection: 2 };
      for (const p of everyPress()) {
        const escape = p.key === 'Escape' && !p.shiftKey && !p.ctrlKey && !p.altKey && !p.metaKey;
        expect(commandFor(p, confirming), `${focus} ${JSON.stringify(p)}`).toEqual(
          escape ? { kind: 'close-prompt' } : null,
        );
      }
    }
  });

  it('leaves Ctrl, Alt and Meta combinations to the browser', () => {
    expect(commandFor({ key: 'R', shiftKey: true, ctrlKey: true }, checkout)).toBeNull();
    expect(commandFor({ key: 'k', shiftKey: false, metaKey: true }, checkout)).toBeNull();
    expect(commandFor({ key: 'j', shiftKey: false, altKey: true }, checkout)).toBeNull();
  });
});

/** Every key press worth trying: letters in both cases, digits, punctuation and named keys, with each modifier. */
function everyPress(): KeyPress[] {
  const keys = [
    ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/?!.,;:-_=+[]{}\\\'"`~@#$%^&*() ',
    ...['Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'],
  ];
  const presses: KeyPress[] = [];
  for (const key of keys) {
    for (const shiftKey of [false, true]) {
      presses.push({ key, shiftKey });
      presses.push({ key, shiftKey, ctrlKey: true });
      presses.push({ key, shiftKey, metaKey: true });
      presses.push({ key, shiftKey, altKey: true });
    }
  }
  return presses;
}

/** Every view state: both views, each focus, prompt open or not, with and without a Selection and a focused item. */
function everyState(): KeyboardState[] {
  const states: KeyboardState[] = [];
  for (const view of ['queue-list', 'checkout'] as const)
    for (const focus of ['text-field', 'control', 'other'] as const)
      for (const prompt of [false, true])
        for (const selection of [0, 5])
          for (const focusedItem of [false, true]) states.push({ view, focus, prompt, selection, focusedItem });
  return states;
}

describe('Keyboard commands everywhere', () => {
  it('fire nothing while a text input, select or textarea has focus', () => {
    expect(focusKindOf({ tagName: 'INPUT', type: 'text' })).toBe('text-field');
    expect(focusKindOf({ tagName: 'INPUT', type: 'search' })).toBe('text-field');
    expect(focusKindOf({ tagName: 'SELECT' })).toBe('text-field');
    expect(focusKindOf({ tagName: 'TEXTAREA' })).toBe('text-field');
    expect(focusKindOf({ tagName: 'DIV', isContentEditable: true })).toBe('text-field');
    expect(focusKindOf({ tagName: 'INPUT', type: 'checkbox' })).toBe('control');
    expect(focusKindOf({ tagName: 'BUTTON' })).toBe('control');
    expect(focusKindOf({ tagName: 'A' })).toBe('control');
    expect(focusKindOf({ tagName: 'DIV' })).toBe('other');
    expect(focusKindOf({ tagName: 'TR' })).toBe('other');
    expect(focusKindOf(null)).toBe('other');

    for (const state of everyState().filter((s) => s.focus === 'text-field')) {
      for (const p of everyPress()) expect(commandFor(p, state), JSON.stringify({ p, state })).toBeNull();
    }
  });

  it('never Apply, Approve, Reject or Restore', () => {
    const kinds = new Set<string>();
    for (const state of everyState()) {
      for (const p of everyPress()) {
        const command = commandFor(p, state);
        if (command) kinds.add(command.kind);
      }
    }
    expect([...kinds].sort()).toEqual([
      'assign',
      'clear-selection',
      'close-prompt',
      'focus-filter',
      'move',
      'show-shortcuts',
      'start-checkout',
      'toggle-selection',
    ]);
  });
});

describe('The shortcut list', () => {
  /** How a key press is written in the list; `?` and `/` are listed bare whatever Shift the layout needs. */
  const written = (p: KeyPress) => {
    const name = p.key === ' ' ? 'Space' : p.key;
    return p.shiftKey && name !== '?' && name !== '/' ? `Shift+${name}` : name;
  };

  it('lists keys that each give a command in their view', () => {
    for (const group of SHORTCUTS) {
      for (const shortcut of group.shortcuts) {
        for (const keys of shortcut.keys) {
          const p = keys === '?' ? { key: '?', shiftKey: true } : press(keys);
          const fires = everyState().some((s) => s.view === group.view && commandFor(p, s) !== null);
          expect(fires, `${group.view} ${keys}`).toBe(true);
        }
      }
    }
  });

  it('lists every key that gives a command', () => {
    const listed = (view: KeyboardState['view']) =>
      new Set(SHORTCUTS.filter((g) => g.view === view).flatMap((g) => g.shortcuts.flatMap((s) => s.keys)));
    for (const state of everyState()) {
      for (const p of everyPress()) {
        if (commandFor(p, state)) expect(listed(state.view), `${state.view} ${written(p)}`).toContain(written(p));
      }
    }
  });
});
