// Decision presentation shared by the Checkout components.
import { decisionLabel } from '../shared/decisions.js';
import type { Decision, MessageOutcome } from './api.js';

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

export const OUTCOME_LABEL: Record<MessageOutcome['status'], string> = {
  done: 'Done',
  failed: 'Failed, kept',
  'not-attempted': 'Not attempted',
  kept: 'Kept',
};
