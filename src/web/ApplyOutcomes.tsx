// What happened to each Message in an Apply.
import type { MessageOutcome } from './api.js';
import { DecisionBadge, OUTCOME_LABEL } from './decisions.js';

export function ApplyOutcomes({ outcomes }: { outcomes: MessageOutcome[] }) {
  const count = (status: MessageOutcome['status']) => outcomes.filter((o) => o.status === status).length;
  return (
    <div className="outcomes">
      <h3>Apply result</h3>
      <p>
        {count('done')} done, {count('failed')} failed and kept, {count('not-attempted')} not attempted,{' '}
        {count('kept')} kept. Every Message not done is back in the queue.
      </p>
      <table className="queues messages">
        <thead>
          <tr>
            <th>message_id</th>
            <th>Decision</th>
            <th>Outcome</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {outcomes.map((o) => (
            <tr key={o.handle} className={`outcome-${o.status}`}>
              <td className="name">{o.messageId ?? <em>none</em>}</td>
              <td>
                <DecisionBadge decision={o.decision} />
              </td>
              <td>{OUTCOME_LABEL[o.status]}</td>
              <td>{o.reason ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
