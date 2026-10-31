// The parts of the store that do not live on PostgreSQL yet (#101). What only reads
// finds nothing and what must be written is refused, so nothing believes it was saved:
// a sampling run or an Alert logs its failure, and a Replay Rule refuses startup.
import type { AlertMemory } from '../alerts/evaluation.js';
import type { AlertStore, HistoryStore, NotificationStore, RuleStateStore } from './audit-store.js';

const notYet = async (what: string): Promise<never> => {
  throw new Error(`${what} are not available on PostgreSQL yet`);
};
const RULES = 'Replay Rules';
const HISTORY = 'Depth history and its sampling runs';

export const unfinishedRuleState: RuleStateStore = {
  ensure: () => notYet(RULES),
  state: async () => null,
  setPaused: () => notYet(RULES),
  recordPass: () => notYet(RULES),
  passes: async () => [],
  firstSeen: () => notYet(RULES),
  countDiedAgain: () => notYet(RULES),
  clearDiedAgain: () => notYet(RULES),
  firstSeenAt: async () => null,
};

export const unfinishedHistory: HistoryStore = {
  recordRun: () => notYet(HISTORY),
  latestSample: async () => null,
  samples: async () => [],
  runsAround: async () => [],
  lastRuns: async () => ({ last: null, lastOk: null }),
  lastGoodRunBefore: async () => null,
  takenOut: async () => 0,
  takeOuts: async () => [],
  removeOlderThan: async () => ({ samples: 0, runs: 0 }),
};

export const unfinishedNotifications: NotificationStore = {
  record: () => notYet('Notification outcomes'),
  recent: async () => [],
  removeOlderThan: async () => 0,
};

const NOTHING: AlertMemory = { alerts: [], arrivals: [] };

export const unfinishedAlerts: AlertStore = {
  load: async () => NOTHING,
  save: () => notYet('Alerts'),
  keepOnly: async () => {},
};
