// A vhost's Dead-letter Map: where a rejected Message ends up, as inline SVG
// with columns from the queues that dead-letter first (dead-letter-map-view.ts).
// Each queue links to its history and starts a Checkout. The diagram is for the
// mouse: the text listing and the table under it say the same for screen
// readers and the keyboard, and the text is what an incident report copies.
import { useEffect, useState } from 'react';
import type { DeadLetterMap, DeadLetterMapQueue } from '../shared/dead-letter-map.js';
import { historyPath } from '../shared/history-link.js';
import type { Role } from '../shared/roles.js';
import { api, ApiError } from './api.js';
import { exchangeLabel, layoutMap, mapComponent, mapListing, type PlacedEdge, type PlacedNode } from './dead-letter-map-view.js';
import { ErrorBox } from './ErrorBox.js';
import { CheckoutCell, mayCheckOut, SetupWarnings, severityLabel } from './queue-cells.js';

const NODE = { width: 180, queueHeight: 78, smallHeight: 36 };
const CELL = { width: 320, height: 104 };
const PAD = 16;
/** Room under the last row for the edges that go back. */
const BOTTOM = 40;

const nodeHeight = (n: PlacedNode) => (n.kind === 'queue' ? NODE.queueHeight : NODE.smallHeight);
const nodeX = (n: PlacedNode) => PAD + n.column * CELL.width;
const nodeY = (n: PlacedNode) => PAD + n.row * CELL.height + (NODE.queueHeight - nodeHeight(n)) / 2;

function shorten(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.ceil((max - 1) / 2))}…${text.slice(-Math.floor((max - 1) / 2))}`;
}

function markerOf(edge: PlacedEdge): string {
  if (edge.kind === 'drop') return 'url(#map-arrow-loss)';
  return edge.inCycle ? 'url(#map-arrow-cycle)' : 'url(#map-arrow)';
}

function Edge({ edge, from, to }: { edge: PlacedEdge; from: PlacedNode; to: PlacedNode }) {
  const x1 = nodeX(from) + NODE.width;
  const y1 = nodeY(from) + nodeHeight(from) / 2;
  const x2 = nodeX(to);
  const y2 = nodeY(to) + nodeHeight(to) / 2;
  let d: string;
  let label: { x: number; y: number };
  if (from === to) {
    const x = nodeX(from) + NODE.width / 2;
    const y = nodeY(from) + nodeHeight(from);
    d = `M${x - 20} ${y} C${x - 40} ${y + 30} ${x + 40} ${y + 30} ${x + 20} ${y + 2}`;
    label = { x, y: y + 34 };
  } else if (edge.back) {
    // Under the rows, so it never runs through a node on the way.
    const sx = nodeX(from) + NODE.width / 2;
    const sy = nodeY(from) + nodeHeight(from);
    const ex = nodeX(to) + NODE.width / 2;
    const ey = nodeY(to) + nodeHeight(to) + 2;
    const low = Math.max(sy, ey) + 26;
    d = `M${sx} ${sy} C${sx} ${low} ${ex} ${low} ${ex} ${ey}`;
    label = { x: (sx + ex) / 2, y: low + 2 };
  } else {
    const bend = (x2 - x1) / 2;
    d = `M${x1} ${y1} C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2 - 2} ${y2}`;
    label = { x: (x1 + x2) / 2, y: (y1 + y2) / 2 - 5 };
  }
  const text = edge.labels.join(', ');
  return (
    <g className={`map-edge map-edge-${edge.kind}${edge.inCycle ? ' in-cycle' : ''}`}>
      <path d={d} markerEnd={markerOf(edge)} />
      {text && (
        <text x={label.x} y={label.y} textAnchor="middle">
          <title>{text}</title>
          {shorten(text, 26)}
        </text>
      )}
    </g>
  );
}

function worstSeverity(queue: DeadLetterMapQueue) {
  return queue.setupWarnings.some((w) => w.severity === 'loses_messages') ? 'loses_messages' : 'may_lose_messages';
}

function QueueNode({ node, profile, vhost, role, onCheckout }: { node: DeadLetterMapQueue & PlacedNode; profile: string; vhost: string; role: Role | undefined; onCheckout(queue: string): void }) {
  const warnings = node.setupWarnings.length;
  const severity = worstSeverity(node);
  const canCheckOut = mayCheckOut(role) && node.checkout.available && !node.checkedOutBy;
  return (
    <g className={`map-node map-queue${node.inCycle ? ' in-cycle' : ''}`} transform={`translate(${nodeX(node)} ${nodeY(node)})`}>
      <rect width={NODE.width} height={NODE.queueHeight} rx={6} />
      <text className="map-name" x={8} y={17}>
        <title>{node.name}</title>
        {shorten(node.name, 24)}
      </text>
      <text className="map-detail" x={8} y={33}>
        ≈ {node.approximateMessages} · {node.type}
        {node.inCycle && <tspan className="map-cycle-flag"> · ↻ cycle</tspan>}
      </text>
      {warnings > 0 && (
        <text className={`map-warning severity-${severity}`} x={8} y={49}>
          <title>{node.setupWarnings.map((w) => `${severityLabel[w.severity]}: ${w.message}`).join('\n')}</title>
          ⚠ {warnings} set-up {warnings === 1 ? 'warning' : 'warnings'}
        </text>
      )}
      {/* Mouse only: the table under the map has the same actions for the keyboard. */}
      {node.deadLetterQueue && (
        <a className="map-action" href={historyPath({ profile, vhost, queue: node.name })} tabIndex={-1}>
          <text x={8} y={68}>History</text>
        </a>
      )}
      {canCheckOut && (
        <text className="map-action" x={node.deadLetterQueue ? 62 : 8} y={68} onClick={() => onCheckout(node.name)}>
          Check out
        </text>
      )}
    </g>
  );
}

function OtherNode({ node }: { node: PlacedNode }) {
  if (node.kind === 'queue') return null;
  const className =
    node.kind === 'exchange' ? `map-exchange${node.missing ? ' missing' : ''}${node.inCycle ? ' in-cycle' : ''}` : node.kind === 'loss' ? 'map-loss' : 'map-unresolved';
  const name = node.kind === 'exchange' ? exchangeLabel(node.name) : node.kind === 'loss' ? '✕ Messages lost' : '? Cannot be told from the set-up';
  const detail = node.kind === 'exchange' && node.missing ? `${name} (does not exist)` : name;
  return (
    <g className={`map-node ${className}`} transform={`translate(${nodeX(node)} ${nodeY(node)})`}>
      <rect width={NODE.width} height={NODE.smallHeight} rx={node.kind === 'exchange' ? 18 : 4} />
      <text className="map-name" x={NODE.width / 2} y={22} textAnchor="middle">
        <title>{detail}</title>
        {shorten(name, 26)}
      </text>
    </g>
  );
}

function Diagram({ map, profile, vhost, role, onCheckout }: { map: DeadLetterMap; profile: string; vhost: string; role: Role | undefined; onCheckout(queue: string): void }) {
  const layout = layoutMap(map);
  const byId = new Map(layout.nodes.map((n) => [n.id, n]));
  const width = 2 * PAD + (layout.columns - 1) * CELL.width + NODE.width;
  const height = 2 * PAD + (layout.rows - 1) * CELL.height + NODE.queueHeight + BOTTOM;
  return (
    <div className="map-diagram">
      <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} aria-hidden="true">
        <defs>
          {['', '-loss', '-cycle'].map((suffix) => (
            <marker key={suffix} id={`map-arrow${suffix}`} className={`map-arrowhead${suffix}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" orient="auto">
              <path d="M0 0 L8 4 L0 8 Z" />
            </marker>
          ))}
        </defs>
        {layout.edges.map((e) => (
          <Edge key={`${e.from}>${e.to}>${e.kind}`} edge={e} from={byId.get(e.from)!} to={byId.get(e.to)!} />
        ))}
        {layout.nodes.map((n) =>
          n.kind === 'queue' ? <QueueNode key={n.id} node={n} profile={profile} vhost={vhost} role={role} onCheckout={onCheckout} /> : <OtherNode key={n.id} node={n} />,
        )}
      </svg>
    </div>
  );
}

function Listing({ text }: { text: string }) {
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const onCopy = () => {
    if (!navigator.clipboard) return setCopy('failed');
    navigator.clipboard.writeText(text).then(
      () => setCopy('copied'),
      () => setCopy('failed'),
    );
  };
  return (
    <>
      <h3>As text</h3>
      <pre className="map-listing" tabIndex={0} aria-label="The Dead-letter Map as text">
        {text}
      </pre>
      <p>
        <button type="button" onClick={onCopy}>
          {copy === 'copied' ? 'Copied' : 'Copy text'}
        </button>{' '}
        {copy === 'failed' && <span className="muted">This browser would not copy it: select the text above instead.</span>}
      </p>
    </>
  );
}

export function DeadLetterMapView({
  profile,
  vhost,
  role,
  search,
  onSearch,
  onCheckout,
}: {
  profile: string;
  vhost: string;
  role: Role | undefined;
  search: string;
  onSearch(search: string): void;
  onCheckout(queue: string): void;
}) {
  const [map, setMap] = useState<DeadLetterMap>();
  const [error, setError] = useState<ApiError>();
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .deadLetterMap(profile, vhost)
      .then((answer) => {
        if (cancelled) return;
        setMap(answer);
        setError(undefined);
      })
      .catch((err) => {
        if (cancelled) return;
        setMap(undefined);
        setError(err);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [profile, vhost, tick]);

  const shown = map && mapComponent(map, search);
  const queues = (shown?.nodes ?? []).filter((n): n is DeadLetterMapQueue => n.kind === 'queue');
  const header = `Dead-letter Map of vhost ${vhost}, Broker Profile ${profile}${search.trim() ? `, connected to "${search.trim()}"` : ''}`;

  return (
    <section className="dead-letter-map">
      <h2>Dead-letter Map of {vhost}</h2>
      <p className="muted">Where a rejected Message ends up, from the broker's set-up: it does not show which Messages took a path. Depths are approximate.</p>
      <div className="controls">
        <input type="search" placeholder="Search for a queue" value={search} onChange={(e) => onSearch(e.target.value)} aria-label="Search for a queue on the map" />
        <button type="button" onClick={() => setTick((n) => n + 1)} disabled={loading}>
          Refresh
        </button>
      </div>
      {error && <ErrorBox error={error} />}
      {map?.nodes.length === 0 && <p className="empty">No queue in this vhost dead-letters or is dead-lettered into.</p>}
      {map && map.nodes.length > 0 && queues.length === 0 && <p className="empty">No queue on the map matches.</p>}
      {shown && queues.length > 0 && (
        <>
          {shown.cycles.map((cycle) => (
            <p key={cycle.join()} className="warning map-cycle-note" role="note">
              <strong>Cycle:</strong> Messages can come back to {cycle.flatMap((id) => (id.startsWith('queue:') ? [id.slice('queue:'.length)] : [])).join(', ')}.
            </p>
          ))}
          <Diagram map={shown} profile={profile} vhost={vhost} role={role} onCheckout={onCheckout} />
          <Listing text={`${header}\n\n${mapListing(shown)}`} />
          <h3>Queues on the map</h3>
          <table className="queues">
            <thead>
              <tr>
                <th>Queue</th>
                <th className="num">Messages <small>(approx.)</small></th>
                <th>History</th>
                <th>Checkout</th>
              </tr>
            </thead>
            <tbody>
              {queues.map((q) => (
                <tr key={q.id}>
                  <td className="name">
                    {q.name} <span className={`badge type-${q.type}`}>{q.type}</span> {q.inCycle && <span className="badge severity-may_lose_messages">↻ cycle</span>}
                    <SetupWarnings warnings={q.setupWarnings} />
                  </td>
                  <td className="num">≈ {q.approximateMessages}</td>
                  <td>{q.deadLetterQueue && <a className="history-link" href={historyPath({ profile, vhost, queue: q.name })} aria-label={`Depth history of ${q.name}`}>History</a>}</td>
                  <td>
                    <CheckoutCell queue={q.name} checkout={q.checkout} checkedOutBy={q.checkedOutBy} role={role} onCheckout={onCheckout} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
