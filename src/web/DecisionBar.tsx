// The Selection count and the Decisions that can be given to it: Discard
// (with a reason), Replay, Move and Keep (which clears a Decision). The Move
// destination is picked from what exists in the Checkout's vhost: another
// queue, or an exchange plus a routing key.
import { useState } from 'react';
import type { Decision, MoveDestination, MoveDestinations } from './api.js';

export function DecisionBar({
  selected,
  sourceQueue,
  destinations,
  replayUnavailable,
  busy,
  onDecide,
  onClearSelection,
}: {
  selected: number;
  /** The queue being triaged: not a Move destination. */
  sourceQueue: string;
  /** The picker's choices; undefined while loading, a string when they could not be loaded. */
  destinations: MoveDestinations | string | undefined;
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
        <button
          disabled={disabled || destination === null}
          onClick={() => destination && onDecide({ kind: 'move', destination })}
          title="Publishes the Messages to the destination on Apply, with the same header rules as Replay; a destination that cannot route them leaves them in the queue"
        >
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
