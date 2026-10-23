// Decision presentation shared by the Checkout components.
import { decisionLabel } from '../shared/decisions.js';
import type { Decision } from './api.js';

export function DecisionBadge({ decision }: { decision: Decision }) {
  return (
    <span
      className={`decision decision-${decision.kind}`}
      title={decision.kind === 'discard' ? `Reason: ${decision.reason}` : undefined}
    >
      {decisionLabel(decision)}
    </span>
  );
}
