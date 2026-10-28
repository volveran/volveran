// Keyboard plumbing for the views: a document keydown listener that asks the
// keyboard-command module (keyboard-commands.ts) for a command and hands it
// to the view, the modal prompt used by the Decision prompts and the shortcut
// list, and the shortcut list itself, rendered from SHORTCUTS.
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { commandFor, focusKindOf, SHORTCUTS, type KeyboardCommand, type KeyboardState } from './keyboard-commands.js';

/** Dispatches the command of each key press while `enabled`; the view's state is read at the time of the press. */
export function useKeyboardCommands(
  enabled: boolean,
  state: Omit<KeyboardState, 'focus'>,
  dispatch: (command: KeyboardCommand) => void,
) {
  const latest = useRef({ state, dispatch });
  useLayoutEffect(() => {
    latest.current = { state, dispatch };
  });
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const command = commandFor(e, { ...latest.current.state, focus: focusKindOf(active) });
      if (!command) return;
      e.preventDefault();
      latest.current.dispatch(command);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
}

/**
 * A modal prompt (native <dialog>): opening focuses its first field or
 * button, it holds the focus while open, Escape closes it, and closing gives
 * the focus back to where it was.
 */
export function Prompt({ label, onClose, children }: { label: string; onClose(): void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="prompt"
      aria-label={label}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      {children}
    </dialog>
  );
}

const KEY_NAMES: Record<string, string> = { ArrowDown: '↓', ArrowUp: '↑', Escape: 'Esc' };

function Keys({ keys }: { keys: string }) {
  const parts = keys.split('+');
  return (
    <span className="keys">
      {parts.map((p, i) => (
        <span key={i}>
          {i > 0 && '+'}
          <kbd>{KEY_NAMES[p] ?? p}</kbd>
        </span>
      ))}
    </span>
  );
}

/** Every shortcut, from the same table the keyboard-command module is tested against. */
export function ShortcutList({ onClose }: { onClose(): void }) {
  return (
    <Prompt label="Keyboard shortcuts" onClose={onClose}>
      <h2>Keyboard shortcuts</h2>
      {SHORTCUTS.map((group) => (
        <section key={group.view}>
          <h3>{group.title}</h3>
          <dl className="shortcuts">
            {group.shortcuts.map((s) => (
              <div key={s.keys.join()}>
                <dt>
                  {s.keys.map((k, i) => (
                    <span key={k}>
                      {i > 0 && ' or '}
                      <Keys keys={k} />
                    </span>
                  ))}
                </dt>
                <dd>{s.does}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
      <p className="muted">
        Shortcuts do nothing while a text field has focus. No key Applies, approves, rejects or Restores.
      </p>
      <button onClick={onClose}>
        Close
      </button>
    </Prompt>
  );
}
