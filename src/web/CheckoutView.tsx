// A Checkout: how many Messages it holds, the list of held Messages and the
// detail of the selected one. Ending it returns every Message to the queue;
// leaving the page ends it too (a beacon), so nothing stays held by accident.
import { useEffect, useState } from 'react';
import { formatBytes, heldLine } from '../shared/held-line.js';
import { api, ApiError, type Checkout, type MessageDetail, type MessageSummary } from './api.js';

export function CheckoutView({ id, onClose }: { id: string; onClose(): void }) {
  const [checkout, setCheckout] = useState<Checkout>();
  const [selected, setSelected] = useState<number>();
  const [detail, setDetail] = useState<MessageDetail>();
  const [error, setError] = useState<ApiError>();
  const [ending, setEnding] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .checkout(id)
        .then((c) => !cancelled && setCheckout(c))
        .catch((err) => !cancelled && setError(err));
    load();
    // Notices a Lost Checkout while the page is open.
    const timer = setInterval(load, 5_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [id]);

  useEffect(() => {
    const end = () => navigator.sendBeacon(`/api/checkouts/${encodeURIComponent(id)}/end`);
    window.addEventListener('pagehide', end);
    return () => window.removeEventListener('pagehide', end);
  }, [id]);

  useEffect(() => {
    if (selected === undefined) return setDetail(undefined);
    let cancelled = false;
    api
      .message(id, selected)
      .then((m) => !cancelled && setDetail(m))
      .catch((err) => !cancelled && setError(err));
    return () => {
      cancelled = true;
    };
  }, [id, selected]);

  const end = async () => {
    setEnding(true);
    try {
      setCheckout(await api.endCheckout(id));
      onClose();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setEnding(false);
    }
  };

  if (!checkout) return error ? <ErrorBox error={error} /> : <p className="empty">Loading the Checkout…</p>;
  const active = checkout.status === 'active';

  return (
    <section className="checkout">
      <div className="checkout-head">
        <div>
          <h2>
            Checkout of {checkout.queue} <span className={`badge type-${checkout.queueType}`}>{checkout.queueType}</span>
          </h2>
          <p className="who">
            {checkout.profile} · vhost {checkout.vhost} · started by {checkout.operator} at{' '}
            {new Date(checkout.startedAt).toLocaleTimeString()}
          </p>
          <p className="held">{heldLine(checkout)}</p>
        </div>
        {active ? (
          <button onClick={end} disabled={ending} title="Every Message goes back to the queue in its original order">
            End Checkout
          </button>
        ) : (
          <button onClick={onClose}>Back to queues</button>
        )}
      </div>

      {checkout.status === 'lost' && (
        <div className="error" role="alert">
          <strong>Lost Checkout</strong>
          <p>{checkout.lostReason}</p>
        </div>
      )}
      {checkout.status === 'ended' && <p className="empty">This Checkout has ended; its Messages are back in the queue.</p>}
      {error && <ErrorBox error={error} />}

      {active && (
        <div className="checkout-body">
          <MessageTable
            messages={checkout.messages}
            quorum={checkout.queueType === 'quorum' && checkout.deliveryLimit !== null}
            selected={selected}
            onSelect={setSelected}
          />
          {detail && <MessageDetailView message={detail} />}
        </div>
      )}
    </section>
  );
}

function ErrorBox({ error }: { error: ApiError }) {
  return (
    <div className="error" role="alert">
      <p>{error.message}</p>
      <code>{error.code}</code>
    </div>
  );
}

function MessageTable(props: {
  messages: MessageSummary[];
  quorum: boolean;
  selected: number | undefined;
  onSelect(handle: number): void;
}) {
  if (props.messages.length === 0) return <p className="empty">The queue had no ready Messages.</p>;
  return (
    <table className="queues messages">
      <thead>
        <tr>
          <th>message_id</th>
          <th>Routing key</th>
          <th>Timestamp</th>
          <th>Dead-letter reason</th>
          <th>Original queue</th>
          {props.quorum && <th className="num">Delivery Budget</th>}
        </tr>
      </thead>
      <tbody>
        {props.messages.map((m) => (
          <tr
            key={m.handle}
            className={m.handle === props.selected ? 'match selected' : undefined}
            onClick={() => props.onSelect(m.handle)}
          >
            <td className="name">{m.messageId ?? <em>none</em>}</td>
            <td>{m.routingKey}</td>
            <td>{m.timestamp ? new Date(m.timestamp).toLocaleString() : ''}</td>
            <td>{m.deadLetterReason ?? ''}</td>
            <td>{m.originalQueue ?? ''}</td>
            {props.quorum && (
              <td className="num">
                {m.deliveryBudget?.remaining ?? ''}
                {m.deliveryBudget?.warning && (
                  <span className="badge limit-warning" title={m.deliveryBudget.warning}>
                    ⚠
                  </span>
                )}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function MessageDetailView({ message: m }: { message: MessageDetail }) {
  return (
    <div className="message-detail">
      <h3>{m.messageId ?? 'Message without message_id'}</h3>
      {m.deliveryBudget?.warning && (
        <div className="warning">
          <p>{m.deliveryBudget.warning}</p>
        </div>
      )}
      <dl>
        <dt>Exchange</dt>
        <dd>{m.exchange === '' ? '(default)' : m.exchange}</dd>
        <dt>Routing key</dt>
        <dd>{m.routingKey}</dd>
        <dt>Redelivered</dt>
        <dd>{m.redelivered ? 'yes' : 'no'}</dd>
        {m.deliveryLimit !== null && (
          <>
            <dt>Deliveries</dt>
            <dd>
              {m.deliveryCount ?? 0} of {m.deliveryLimit}
            </dd>
          </>
        )}
      </dl>

      <h4>Properties</h4>
      <pre>{JSON.stringify(m.properties, null, 2)}</pre>

      {m.xDeath.length > 0 && (
        <>
          <h4>Dead-letter history (x-death, most recent first)</h4>
          <table className="queues">
            <thead>
              <tr>
                <th>Queue</th>
                <th>Reason</th>
                <th className="num">Count</th>
                <th>First time</th>
                <th>Exchange</th>
                <th>Routing keys</th>
              </tr>
            </thead>
            <tbody>
              {m.xDeath.map((d, i) => (
                <tr key={i}>
                  <td>{d.queue}</td>
                  <td>{d.reason}</td>
                  <td className="num">{d.count}</td>
                  <td>{d.time ? new Date(d.time).toLocaleString() : ''}</td>
                  <td>{d.exchange}</td>
                  <td>{d.routingKeys.join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h4>Headers</h4>
      <pre>{JSON.stringify(m.headers, null, 2)}</pre>

      <h4>
        Body <small>({formatBytes(m.body.size)}, {m.body.kind})</small>
      </h4>
      {m.body.kind === 'binary' ? (
        <>
          <h5>Hex</h5>
          <pre className="wrap">{m.body.hex}</pre>
          <h5>Base64</h5>
          <pre className="wrap">{m.body.base64}</pre>
        </>
      ) : (
        <pre>{m.body.text}</pre>
      )}
    </div>
  );
}
