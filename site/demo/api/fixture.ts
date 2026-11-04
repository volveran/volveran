// A minimal hand-written fixture of what the read-only routes answer: the
// Broker Profiles `staging` and `production` (Protected) on one broker, their
// vhosts and queue lists. #148 replaces it with responses recorded from the
// real server by scripts/screenshots/capture.sh. Shapes are the API's own, so
// a recording can drop in.
import type { ProfileSummary, QueueList, QueueRow, SetupWarning } from '../../../src/shared/queues.js';

export interface DemoVhost {
  name: string;
  /** The vhost's whole queue list, as GET .../queues answers it with no search. */
  queueList: QueueList;
}

export interface DemoProfile {
  summary: ProfileSummary;
  vhosts: DemoVhost[];
}

const checkoutable = { available: true } as const;

function row(name: string, type: string, approximateMessages: number, extra: Partial<QueueRow> = {}): QueueRow {
  const deadLetterQueue = name.endsWith('.dlq');
  return {
    name,
    type,
    approximateMessages,
    consumers: 0,
    deadLetterQueue,
    matchesDefaultFilter: deadLetterQueue,
    deadLetteredFrom: [],
    checkout: checkoutable,
    setupWarnings: [],
    checkedOutBy: null,
    ...extra,
  };
}

const billingDlxMissing: SetupWarning = {
  code: 'dead_letter_exchange_missing',
  severity: 'loses_messages',
  deadLetterExchange: 'billing.dlx',
  message:
    'This queue dead-letters to the exchange "billing.dlx", which does not exist in this vhost: every Message it dead-letters (rejected, expired, over a length or delivery limit) is dropped for good. ' +
    'Declare the exchange "billing.dlx" and bind a dead-letter queue to it, or point the queue\'s dead-letter-exchange at one that exists.',
};

const rootQueues: QueueRow[] = [
  row('orders.dlq', 'classic', 15, { deadLetteredFrom: ['orders.work'] }),
  row('payments.dlq', 'quorum', 6, { deadLetteredFrom: ['payments.work'] }),
  row('billing.work', 'classic', 0, { consumers: 1, setupWarnings: [billingDlxMissing] }),
  row('events.stream', 'stream', 0, {
    checkout: {
      available: false,
      reason:
        'Stream queues cannot be checked out: a stream keeps its Messages after they are read, so there is nothing to hold and settle one by one. Only classic and quorum queues can be triaged.',
    },
  }),
  row('orders.parked', 'classic', 0),
  row('orders.work', 'classic', 0, { consumers: 2 }),
  row('payments.work', 'quorum', 0, { consumers: 2 }),
];

const otherQueues: QueueRow[] = [row('other.dlq', 'classic', 0)];

function vhosts(): DemoVhost[] {
  return [
    { name: '/', queueList: { defaultQueueFilter: '*.dlq', queues: rootQueues, setupWarningCounts: { loses_messages: 1, may_lose_messages: 0 } } },
    { name: 'other', queueList: { defaultQueueFilter: '*.dlq', queues: otherQueues, setupWarningCounts: { loses_messages: 0, may_lose_messages: 0 } } },
  ];
}

function profile(name: string, isProtected: boolean): DemoProfile {
  return {
    summary: {
      name,
      credentials: 'shared',
      username: 'volveran',
      managementUrl: 'http://rabbitmq.demo:15672',
      amqpUrl: 'amqp://rabbitmq.demo:5672',
      passwordEnv: 'VOLVERAN_RABBITMQ_PASSWORD',
      passwordSet: true,
      vhosts: 'all',
      defaultQueueFilter: '*.dlq',
      protected: isProtected,
    },
    vhosts: vhosts(),
  };
}

export const fixture: { profiles: DemoProfile[] } = {
  profiles: [profile('staging', false), profile('production', true)],
};
