// The audit store interface on SQLite (ADR 0013). node:sqlite is synchronous,
// so each call does all its work, transaction included, before it answers: no
// other call can land inside one. `async` turns a failure into a rejection.
import type { AuditStore, HistoryStore, NotificationStore, AlertStore, RuleStateStore } from './audit-store.js';
import type { AuditStore as SyncAuditStore } from './store.js';

export class SqliteAuditStore implements AuditStore {
  readonly ruleState: RuleStateStore;
  readonly history: HistoryStore;
  readonly notifications: NotificationStore;
  readonly alerts: AlertStore;

  constructor(private readonly sync: SyncAuditStore) {
    this.ruleState = asyncRuleState(sync.ruleState);
    this.history = asyncHistory(sync.history);
    this.notifications = asyncNotifications(sync.notifications);
    this.alerts = asyncAlerts(sync.alerts);
  }

  async record(...args: Parameters<AuditStore['record']>) {
    return this.sync.record(...args);
  }
  async setOutcome(...args: Parameters<AuditStore['setOutcome']>) {
    this.sync.setOutcome(...args);
  }
  async setCanaryOutcome(...args: Parameters<AuditStore['setCanaryOutcome']>) {
    this.sync.setCanaryOutcome(...args);
  }
  async list(...args: Parameters<AuditStore['list']>) {
    return this.sync.list(...args);
  }
  async get(...args: Parameters<AuditStore['get']>) {
    return this.sync.get(...args);
  }
  async body(...args: Parameters<AuditStore['body']>) {
    return this.sync.body(...args);
  }
  async evictBodies(...args: Parameters<AuditStore['evictBodies']>) {
    return this.sync.evictBodies(...args);
  }
  async storedBodyBytes() {
    return this.sync.storedBodyBytes();
  }
  async close() {
    this.sync.close();
  }
}

function asyncRuleState(sync: SyncAuditStore['ruleState']): RuleStateStore {
  return {
    ensure: async (...args) => sync.ensure(...args),
    state: async (...args) => sync.state(...args),
    setPaused: async (...args) => sync.setPaused(...args),
    recordPass: async (...args) => sync.recordPass(...args),
    passes: async (...args) => sync.passes(...args),
    firstSeen: async (...args) => sync.firstSeen(...args),
    countDiedAgain: async (...args) => sync.countDiedAgain(...args),
    clearDiedAgain: async (...args) => sync.clearDiedAgain(...args),
    firstSeenAt: async (...args) => sync.firstSeenAt(...args),
  };
}

function asyncHistory(sync: SyncAuditStore['history']): HistoryStore {
  return {
    recordRun: async (...args) => sync.recordRun(...args),
    latestSample: async (...args) => sync.latestSample(...args),
    samples: async (...args) => sync.samples(...args),
    runsAround: async (...args) => sync.runsAround(...args),
    lastRuns: async (...args) => sync.lastRuns(...args),
    lastGoodRunBefore: async (...args) => sync.lastGoodRunBefore(...args),
    takenOut: async (...args) => sync.takenOut(...args),
    takeOuts: async (...args) => sync.takeOuts(...args),
    removeOlderThan: async (...args) => sync.removeOlderThan(...args),
  };
}

function asyncNotifications(sync: SyncAuditStore['notifications']): NotificationStore {
  return {
    record: async (...args) => sync.record(...args),
    recent: async (...args) => sync.recent(...args),
    removeOlderThan: async (...args) => sync.removeOlderThan(...args),
  };
}

function asyncAlerts(sync: SyncAuditStore['alerts']): AlertStore {
  return {
    load: async (...args) => sync.load(...args),
    save: async (...args) => sync.save(...args),
    keepOnly: async (...args) => sync.keepOnly(...args),
  };
}
