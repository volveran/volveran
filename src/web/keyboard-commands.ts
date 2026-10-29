// The keyboard-command module: maps a key press and the view state to a
// command. Components dispatch the commands and never interpret keys
// themselves.
/** The parts of a keydown event that choose a command. */
export interface KeyPress {
  /** KeyboardEvent.key: `j`, `D` (with Shift), `ArrowDown`, ` ` (Space), `?`… */
  key: string;
  shiftKey: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
}

export interface KeyboardState {
  view: 'queue-list' | 'checkout';
  /** What has focus: a text field (text input, select, textarea), another control (button, checkbox, link), or neither. */
  focus: FocusKind;
  /** A prompt (Discard reason, Move destination) or the shortcut list is open. */
  prompt: boolean;
  /** How many Messages the Selection holds. */
  selection: number;
  /** A queue or Message is focused in the list. */
  focusedItem: boolean;
}

export type FocusKind = 'text-field' | 'control' | 'other';

/** Which Decision a key assigns. Discard and Move open their reason or destination prompt first. */
export type DecisionKind = 'discard' | 'replay' | 'move' | 'keep';

export type KeyboardCommand =
  /** Focus the next (1) or previous (-1) queue or Message; in a Checkout, extendSelection adds both to the Selection. */
  | { kind: 'move'; by: 1 | -1; extendSelection: boolean }
  | { kind: 'start-checkout' }
  | { kind: 'toggle-selection' }
  | { kind: 'assign'; decision: DecisionKind; to: 'selection' | 'focused-message' }
  | { kind: 'focus-filter' }
  | { kind: 'clear-selection' }
  /** Open the comparison of the two Messages in the Selection. */
  | { kind: 'compare' }
  | { kind: 'close-prompt' }
  | { kind: 'show-shortcuts' };

const DECISION_KEYS: Record<string, DecisionKind> = { D: 'discard', R: 'replay', M: 'move', K: 'keep' };

/**
 * The command a key press gives, or null to leave the key to the browser.
 * No key Applies, Approves, Rejects or Restores: those always need a click
 * on their confirmation.
 */
export function commandFor(press: KeyPress, state: KeyboardState): KeyboardCommand | null {
  const { key, shiftKey } = press;
  if (press.ctrlKey || press.altKey || press.metaKey) return null;
  // Typing a reason, a queue name or a filter never triggers anything.
  if (state.focus === 'text-field') return null;

  // `?` and `/` need Shift on some layouts; every other key that is not a Decision goes without it.
  const escape = key === 'Escape' && !shiftKey;
  if (state.prompt) return escape ? { kind: 'close-prompt' } : null;
  if (key === '?') return { kind: 'show-shortcuts' };

  const down = key === 'ArrowDown' || (key === 'j' && !shiftKey);
  const up = key === 'ArrowUp' || (key === 'k' && !shiftKey);
  if (down || up) {
    const by = down ? 1 : -1;
    if (!shiftKey) return { kind: 'move', by, extendSelection: false };
    return state.view === 'checkout' ? { kind: 'move', by, extendSelection: true } : null;
  }

  if (state.view === 'queue-list') {
    // On a focused button Enter presses the button instead.
    return key === 'Enter' && !shiftKey && state.focusedItem && state.focus !== 'control' ? { kind: 'start-checkout' } : null;
  }

  if (key === ' ' && !shiftKey) {
    return state.focusedItem && state.focus !== 'control' ? { kind: 'toggle-selection' } : null;
  }
  const decision = shiftKey ? DECISION_KEYS[key] : undefined;
  if (decision) {
    if (state.selection > 0) return { kind: 'assign', decision, to: 'selection' };
    return state.focusedItem ? { kind: 'assign', decision, to: 'focused-message' } : null;
  }
  if (key === '/') return { kind: 'focus-filter' };
  if (key === 'c' && !shiftKey) return state.selection === 2 ? { kind: 'compare' } : null;
  if (escape) return state.selection > 0 ? { kind: 'clear-selection' } : null;
  return null;
}

/** Input types that are pressed rather than typed into. */
const CONTROL_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file', 'color', 'range']);

/** What kind of element has focus (document.activeElement), for KeyboardState.focus. */
export function focusKindOf(element: { tagName: string; type?: string; isContentEditable?: boolean } | null): FocusKind {
  if (!element) return 'other';
  if (element.isContentEditable) return 'text-field';
  switch (element.tagName.toUpperCase()) {
    case 'SELECT':
    case 'TEXTAREA':
      return 'text-field';
    case 'INPUT':
      return CONTROL_INPUTS.has((element.type ?? 'text').toLowerCase()) ? 'control' : 'text-field';
    case 'BUTTON':
    case 'A':
    case 'SUMMARY':
      return 'control';
    default:
      return 'other';
  }
}

export interface Shortcut {
  /** Each key press that does it, written `j`, `Shift+D`, `Space`, `ArrowDown`. */
  keys: string[];
  does: string;
}

/** The shortcut list that `?` opens; a unit test checks it against commandFor. */
export const SHORTCUTS: Array<{ view: KeyboardState['view']; title: string; shortcuts: Shortcut[] }> = [
  {
    view: 'queue-list',
    title: 'Queue list',
    shortcuts: [
      { keys: ['j', 'ArrowDown'], does: 'Focus the next queue' },
      { keys: ['k', 'ArrowUp'], does: 'Focus the previous queue' },
      { keys: ['Enter'], does: 'Start a Checkout on the focused queue' },
      { keys: ['?'], does: 'Open this list' },
      { keys: ['Escape'], does: 'Close this list' },
    ],
  },
  {
    view: 'checkout',
    title: 'Checkout',
    shortcuts: [
      { keys: ['j', 'ArrowDown'], does: 'Focus the next Message and show it' },
      { keys: ['k', 'ArrowUp'], does: 'Focus the previous Message and show it' },
      { keys: ['Space'], does: 'Add the focused Message to the Selection, or take it out' },
      { keys: ['Shift+ArrowDown', 'Shift+ArrowUp'], does: 'Extend the Selection to the next or previous Message' },
      { keys: ['Shift+D'], does: 'Discard the Selection, or else the focused Message (asks for a reason)' },
      { keys: ['Shift+R'], does: 'Replay the Selection, or else the focused Message' },
      { keys: ['Shift+M'], does: 'Move the Selection, or else the focused Message (asks for a destination)' },
      { keys: ['Shift+K'], does: 'Keep the Selection, or else the focused Message' },
      { keys: ['c'], does: 'Compare the two Messages in the Selection' },
      { keys: ['/'], does: 'Focus the filter' },
      { keys: ['Escape'], does: 'Close the open prompt or this list, or else clear the Selection' },
      { keys: ['?'], does: 'Open this list' },
    ],
  },
];
