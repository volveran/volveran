// What the queue list and the Dead-letter Map both show of a queue: its set-up
// warnings, and whether this Operator can start a Checkout on it.
import { roleIncludes, type Role } from '../shared/roles.js';
import type { CheckoutAvailability, Queue, SetupWarning, SetupWarningSeverity } from './api.js';

export const severityLabel: Record<SetupWarningSeverity, string> = {
  loses_messages: 'Loses Messages',
  may_lose_messages: 'May lose Messages',
};

export const mayCheckOut = (role: Role | undefined) => role !== undefined && roleIncludes(role, 'operator');

export function SetupWarnings({ warnings }: { warnings: SetupWarning[] }) {
  return (
    <>
      {warnings.map((w) => (
        <span key={w.code} className="setup-warning" role="note">
          <span className={`badge severity-${w.severity}`}>{severityLabel[w.severity]}</span>
          <small>{w.message}</small>
        </span>
      ))}
    </>
  );
}

export function CheckoutCell({
  queue,
  checkout,
  checkedOutBy,
  role,
  onCheckout,
}: {
  queue: string;
  checkout: CheckoutAvailability;
  checkedOutBy: Queue['checkedOutBy'];
  role: Role | undefined;
  onCheckout(queue: string): void;
}) {
  if (checkedOutBy) {
    return (
      <span className="unavailable">
        Checked out
        <small>
          by {checkedOutBy.operator} since {new Date(checkedOutBy.since).toLocaleTimeString()}
        </small>
      </span>
    );
  }
  if (!mayCheckOut(role)) {
    return (
      <span className="unavailable">
        Needs the role <code>operator</code>
        <small>your role here is {role ?? 'none'}</small>
      </span>
    );
  }
  if (checkout.available) return <button onClick={() => onCheckout(queue)}>Check out</button>;
  return (
    <span className="unavailable" title={checkout.reason}>
      Not available
      <small>{checkout.reason}</small>
    </span>
  );
}
