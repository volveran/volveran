// The Selection count and the Decisions that can be given to it: Discard
// (with a reason), Replay, Move and Keep (which clears a Decision). Discard
// and Move open a prompt (DecisionPrompt) for the reason or the destination,
// the same prompt their keys open (Shift+D, Shift+M). The Move destination is
// picked from what exists in the Checkout's vhost: another queue, or an
// exchange plus a routing key; Spring AMQP Messages prefill the exchange and
// routing key they were first published with. With exactly two Messages selected, Compare
// shows them side by side (ComparisonView).
import { useState } from 'react';
import type { Decision, MoveDestination, MoveDestinations } from './api.js';
import { Prompt } from './keyboard.js';

export function DecisionBar({
  selected,
  replayUnavailable,
  busy,
  onPrompt,
  onDecide,
  onClearSelection,
  onCompare,
}: {
  selected: number;
  /** Selected Messages that can't be given Replay (no Replay origin). */
  replayUnavailable: number;
  busy: boolean;
  /** Opens the Discard or Move prompt for the Selection. */
  onPrompt: (kind: 'discard' | 'move') => void;
  onDecide: (decision: Decision) => void;
  onClearSelection: () => void;
  /** Shows the two selected Messages side by side. */
  onCompare: () => void;
}) {
  const disabled = busy || selected === 0;
  return (
    <div className="decision-bar">
      <strong>{selected} selected</strong>
      <button
        className="danger"
        disabled={disabled}
        onClick={() => onPrompt('discard')}
        aria-keyshortcuts="Shift+D"
        title="Asks for a reason. Removes the Messages for good on Apply; each Audit Entry keeps a full copy so it can be Restored (Shift+D)"
      >
        Discard…
      </button>
      <button
        disabled={disabled || replayUnavailable === selected}
        onClick={() => onDecide({ kind: 'replay' })}
        aria-keyshortcuts="Shift+R"
        title={
          replayUnavailable > 0
            ? `${replayUnavailable} selected Message(s) have no queue to Replay them to (see each one's "no Replay" badge); they keep their Decision.`
            : 'Send back to the queue that dead-lettered each Message (its most recent x-death entry, or its MassTransit input queue) (Shift+R)'
        }
      >
        Replay{replayUnavailable > 0 && replayUnavailable < selected ? ` (${selected - replayUnavailable})` : ''}
      </button>
      <button
        disabled={disabled}
        onClick={() => onPrompt('move')}
        aria-keyshortcuts="Shift+M"
        title="Asks for a destination. Publishes the Messages to it on Apply, with the same header rules as Replay; a destination that cannot route them leaves them in the queue (Shift+M)"
      >
        Move…
      </button>
      <button
        disabled={disabled}
        onClick={() => onDecide({ kind: 'keep' })}
        aria-keyshortcuts="Shift+K"
        title="Clears the Decision (Shift+K)"
      >
        Keep
      </button>
      <button
        disabled={selected !== 2}
        onClick={onCompare}
        aria-keyshortcuts="c"
        title="Show the two selected Messages side by side, with what differs highlighted (c)"
      >
        Compare
      </button>
      <button disabled={selected === 0} onClick={onClearSelection} className="link" aria-keyshortcuts="Escape">
        Clear selection
      </button>
    </div>
  );
}

/** The Discard reason or Move destination prompt, for `count` Messages. */
export function DecisionPrompt({
  kind,
  count,
  sourceQueue,
  destinations,
  suggestedMove,
  busy,
  onDecide,
  onClose,
}: {
  kind: 'discard' | 'move';
  count: number;
  /** The queue being triaged: not a Move destination. */
  sourceQueue: string;
  /** Where every one of these Messages was first published (Spring AMQP), prefilled. */
  suggestedMove?: MoveDestination | null;
  /** The picker's choices; undefined while loading, a string when they could not be loaded. */
  destinations: MoveDestinations | string | undefined;
  busy: boolean;
  onDecide: (decision: Decision) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const suggested = suggestedMove && 'exchange' in suggestedMove ? suggestedMove : null;
  const [moveTo, setMoveTo] = useState<'queue' | 'exchange'>(suggested ? 'exchange' : 'queue');
  const [queue, setQueue] = useState(suggestedMove && 'queue' in suggestedMove ? suggestedMove.queue : '');
  const [exchange, setExchange] = useState(suggested?.exchange ?? '');
  const [routingKey, setRoutingKey] = useState(suggested?.routingKey ?? '');

  const loaded = typeof destinations === 'object' ? destinations : null;
  const queues = loaded?.queues.filter((q) => q !== sourceQueue) ?? [];
  const exchanges = loaded?.exchanges ?? [];
  const destination: MoveDestination | null =
    moveTo === 'queue'
      ? queues.includes(queue)
        ? { queue }
        : null
      : exchanges.some((e) => e.name === exchange)
        ? { exchange, routingKey }
        : null;
  const messages = count === 1 ? '1 Message' : `${count} Messages`;
  const decision: Decision | null =
    kind === 'discard'
      ? reason.trim() === ''
        ? null
        : { kind: 'discard', reason: reason.trim() }
      : destination && { kind: 'move', destination };

  return (
    <Prompt label={kind === 'discard' ? `Discard ${messages}` : `Move ${messages}`} onClose={onClose}>
      <form
        className="decision-prompt"
        onSubmit={(e) => {
          e.preventDefault();
          if (!decision || busy) return;
          onDecide(decision);
          onClose();
        }}
      >
        <h3>{kind === 'discard' ? `Discard ${messages}` : `Move ${messages}`}</h3>
        {kind === 'discard' ? (
          <label>
            Reason (required)
            <input
              type="text"
              placeholder="Why these Messages are Discarded"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
        ) : (
          <span className="decision-group">
            <select aria-label="Move to" value={moveTo} onChange={(e) => setMoveTo(e.target.value as 'queue' | 'exchange')}>
              <option value="queue">Move to queue</option>
              <option value="exchange">Move to exchange</option>
            </select>
            {typeof destinations === 'string' ? (
              <span className="muted" title={destinations}>
                Cannot list the destinations
              </span>
            ) : moveTo === 'queue' ? (
              <select aria-label="Destination queue" value={queue} onChange={(e) => setQueue(e.target.value)}>
                <option value="">{loaded ? 'Pick a queue' : 'Loading…'}</option>
                {queues.map((q) => (
                  <option key={q} value={q}>
                    {q}
                  </option>
                ))}
              </select>
            ) : (
              <>
                <select aria-label="Destination exchange" value={exchange} onChange={(e) => setExchange(e.target.value)}>
                  <option value="">{loaded ? 'Pick an exchange' : 'Loading…'}</option>
                  {exchanges.map((x) => (
                    <option key={x.name} value={x.name}>
                      {x.name} ({x.type})
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  aria-label="Routing key"
                  placeholder="routing key"
                  value={routingKey}
                  onChange={(e) => setRoutingKey(e.target.value)}
                />
              </>
            )}
          </span>
        )}
        <span>
          <button type="submit" className={kind === 'discard' ? 'danger' : undefined} disabled={busy || !decision}>
            {kind === 'discard' ? 'Discard' : 'Move'}
          </button>{' '}
          <button type="button" className="link" onClick={onClose}>
            Cancel
          </button>
        </span>
      </form>
    </Prompt>
  );
}
