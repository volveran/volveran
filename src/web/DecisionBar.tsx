// The Selection count and the Decisions that can be given to it: Discard
// (with a reason), Replay, Move and Keep (which clears a Decision). The Move
// destination is typed for now: a queue, or an exchange with a routing key.
import { useState } from 'react';
import type { Decision, MoveDestination } from './api.js';

export function DecisionBar({
  selected,
  replayUnavailable,
  busy,
  onDecide,
  onClearSelection,
}: {
  selected: number;
  /** Selected Messages that can't be given Replay (no x-death history). */
  replayUnavailable: number;
  busy: boolean;
  onDecide: (decision: Decision) => void;
  onClearSelection: () => void;
}) {
  const disabled = busy || selected === 0;
  const [reason, setReason] = useState('');
  const [moveTo, setMoveTo] = useState<'queue' | 'exchange'>('queue');
  const [queue, setQueue] = useState('');
  const [exchange, setExchange] = useState('');
  const [routingKey, setRoutingKey] = useState('');

  const destination: MoveDestination | null =
    moveTo === 'queue'
      ? queue.trim()
        ? { queue: queue.trim() }
        : null
      : exchange.trim()
        ? { exchange: exchange.trim(), routingKey }
        : null;

  return (
    <div className="decision-bar">
      <strong>{selected} selected</strong>
      <span className="decision-group">
        <input
          type="text"
          aria-label="Discard reason"
          placeholder="Reason for the Discard (required)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <button
          className="danger"
          disabled={disabled || reason.trim() === ''}
          onClick={() => onDecide({ kind: 'discard', reason: reason.trim() })}
          title="Removes the Messages for good on Apply; each Audit Entry keeps a full copy so it can be Restored"
        >
          Discard
        </button>
      </span>
      <button
        disabled={disabled || replayUnavailable === selected}
        onClick={() => onDecide({ kind: 'replay' })}
        title={
          replayUnavailable > 0
            ? `${replayUnavailable} selected Message(s) have no x-death history, so there is no queue to Replay them to; they keep their Decision.`
            : 'Send back to the queue that dead-lettered each Message (its most recent x-death entry)'
        }
      >
        Replay{replayUnavailable > 0 && replayUnavailable < selected ? ` (${selected - replayUnavailable})` : ''}
      </button>
      <span className="decision-group">
        <select aria-label="Move to" value={moveTo} onChange={(e) => setMoveTo(e.target.value as 'queue' | 'exchange')}>
          <option value="queue">Move to queue</option>
          <option value="exchange">Move to exchange</option>
        </select>
        {moveTo === 'queue' ? (
          <input type="text" aria-label="Destination queue" placeholder="queue name" value={queue} onChange={(e) => setQueue(e.target.value)} />
        ) : (
          <>
            <input type="text" aria-label="Destination exchange" placeholder="exchange" value={exchange} onChange={(e) => setExchange(e.target.value)} />
            <input type="text" aria-label="Routing key" placeholder="routing key" value={routingKey} onChange={(e) => setRoutingKey(e.target.value)} />
          </>
        )}
        <button disabled={disabled || destination === null} onClick={() => destination && onDecide({ kind: 'move', destination })}>
          Move
        </button>
      </span>
      <button disabled={disabled} onClick={() => onDecide({ kind: 'keep' })} title="Clears the Decision">
        Keep
      </button>
      <button disabled={selected === 0} onClick={onClearSelection} className="link">
        Clear selection
      </button>
    </div>
  );
}
