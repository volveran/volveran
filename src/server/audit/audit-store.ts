// The audit store's interface (ADR 0013): everything the rest of the server asks
// of the audit store, with no SQL in it and no sign of which database answers.
// Each call is one atomic unit of work: when its promise resolves the work is
// committed and durable, and when it rejects none of it happened. A Discard's copy
// of its Message is on disk once `record` resolves (ADR 0001), so await it before
// the ack. Limits and orderings stated here hold on every implementation.
import type { AlertMemory } from '../alerts/evaluation.js';
import type { ApprovalSummary } from '../checkout/view.js';
import type { Operator } from '../operator.js';
import type { NotificationDelivery } from '../../shared/alerts.js';
import type { CheckoutQueueType, CheckoutStatus, EndReason } from '../../shared/checkout.js';
import type { AuditAction, AuditCanaryOutcome, AuditDestination, AuditOutcome } from '../../shared/audit.js';
import type { Filter } from '../../shared/filters.js';
import type { RulePass, RuleState } from '../../shared/replay-rules.js';
import type { Role } from '../../shared/roles.js';

/**
 * A copy of a Message as amqplib decoded it. Discard keeps the body (so it can
 * be Restored); Replay and Move keep only the original properties and headers
 * (ADR 0005), with `body: null`.
 */
export interface MessageCopy {
  body: Buffer | null;
  /** AMQP properties except headers (amqplib names: contentType, messageId, ...). */
  properties: Record<string, unknown>;
  headers: Record<string, unknown>;
}

export interface NewAuditEntry {
  at: Date;
  /** Who acted: `id` is the stable identity, `displayName` what people see. */
  operator: Pick<Operator, 'id' | 'displayName'>;
  /** The Operator's Role on the Broker Profile when they acted (`admin` in Solo Mode). */
  role?: Role | null;
  /** The second Operator who approved the Apply (Protected Profile, Team Mode); null or left out otherwise. */
  approver?: Pick<Operator, 'id' | 'displayName'> | null;
  /** The Broker Profile's RabbitMQ user, often a shared service account. */
  brokerUser: string;
  profile: string;
  vhost: string;
  /** The queue the Message was taken from. */
  queue: string;
  messageId: string | null;
  action: AuditAction;
  /** Why (required for a Discard); null when the action takes none. */
  reason: string | null;
  destination: AuditDestination | null;
  checkoutId: string | null;
  message: MessageCopy | null;
  /**
   * The `x-volveran-replay-id` header a Replay, Move or Restore published the
   * Message with, so a Message that dies again can be traced back here; null
   * (or left out) for the other actions.
   */
  replayId?: string | null;
  /** A Restore: the Audit Entry of the Discard whose Message it republished. */
  restoreOf?: number | null;
  /** An export: the filter its Messages matched; null (or left out) when it exported every held Message. */
  filter?: Filter | null;
  /** An export: how many Messages it holds. */
  messageCount?: number | null;
  /** An Apply: its Replay Rate in Messages per second; null (or left out) when there is none, and for the other actions. */
  rate?: number | null;
  /** A Rule Pass: the Replay Rule acting (its name; the Operator is the rule) and the pass; null (or left out) otherwise. */
  rule?: string | null;
  rulePassId?: string | null;
  /** The Replay an Apply carried out alone as its Canary (its watch outcome is set later, setCanaryOutcome). */
  canary?: boolean;
}

/** An Audit Entry as listed: the Message's properties and headers, but not its body (see AuditStore.body). */
export interface AuditEntry
  extends Omit<
    NewAuditEntry,
    | 'operator'
    | 'role'
    | 'approver'
    | 'message'
    | 'replayId'
    | 'restoreOf'
    | 'filter'
    | 'messageCount'
    | 'rate'
    | 'rule'
    | 'rulePassId'
    | 'canary'
  > {
  id: number;
  /** The Operator's Role when they acted; null on entries written before v0.3. */
  role: Role | null;
  /** Who approved the Apply that wrote the entry; null when it needed no Approval (and on entries before v0.3). */
  approverId: string | null;
  approverName: string | null;
  replayId: string | null;
  restoreOf: number | null;
  filter: Filter | null;
  messageCount: number | null;
  /** The Replay Rate of the Apply that wrote the entry; null when there is none (and on entries before v0.4). */
  rate: number | null;
  /** The Replay Rule whose pass wrote the entry (its name), and the pass's id; null for an Operator's actions (and before v0.4). */
  rule: string | null;
  rulePassId: string | null;
  /** Whether the entry is an Apply's Canary (false before v0.4). */
  canary: boolean;
  /** The Canary's watch outcome; null for other entries, and while it is watched. */
  canaryOutcome: AuditCanaryOutcome | null;
  /** When retention evicted the stored body ("body expired"); null while it is kept (or none was stored). */
  bodyExpiredAt: Date | null;
  operatorId: string;
  operatorName: string;
  outcome: AuditOutcome;
  outcomeReason: string | null;
  message: {
    properties: Record<string, unknown>;
    headers: Record<string, unknown>;
    /** Size of the stored body; null when none was stored. */
    bodyBytes: number | null;
  } | null;
}

/** A Restore's Audit Entry, before it publishes: it names the Discard and stores no Message. */
export type NewRestoreEntry = NewAuditEntry & { restoreOf: number; message: null };

/** Whether a Restore may publish: its entry's id, or the earlier Restore that stops it. */
export type RestoreClaim = { claimed: true; id: number } | { claimed: false; earlier: AuditEntry };

/** Broker Profiles by name: only the ones listed, or every one except those listed. */
export type ProfileScope = { only: string[] } | { except: string[] };

/** A search over Audit Entries; every given field must match. */
export interface AuditQuery {
  /** The queue a Message was taken from or sent to. */
  queue?: string;
  messageId?: string;
  action?: AuditAction;
  checkoutId?: string;
  /** The replay id a Replay, Move or Restore published the Message with (its x-volveran-replay-id header). */
  replayId?: string;
  /** The Broker Profile. */
  profile?: string;
  /** The Operator: their stable id or their display name. */
  operator?: string;
  /** Keeps only the entries of these Broker Profiles (see ProfileScope). */
  profiles?: ProfileScope;
  /** Restores of this Audit Entry. */
  restoreOf?: number;
  /** The entries a Replay Rule of this name wrote (combine with `profile` for one profile's rule). */
  rule?: string;
  /** Entries at or after this time. */
  from?: Date;
  /** Entries at or before this time. */
  to?: Date;
  /** At most this many entries (the newest). */
  limit?: number;
}

/** The limits retention applies to stored bodies (see audit/body-retention.ts). */
export interface BodyEviction {
  now: Date;
  /** Bodies of entries older than this are evicted. */
  maxAgeMs: number;
  /** Once the stored bodies add up to more than this, the oldest are evicted until they fit. */
  maxBodyBytes: number;
}

export interface StoredSample {
  /** Epoch milliseconds. */
  at: number;
  depth: number;
  estimatedArrivals: number | null;
}

export interface StoredSamplingRun {
  /** Epoch milliseconds. */
  at: number;
  ok: boolean;
  /** Why it failed; null on a good run. */
  errorCode: string | null;
  /** The sampling interval it ran at; null on a run from before migration v16. */
  intervalMs: number | null;
}

export interface QueueSample extends StoredSample {
  vhost: string;
  queue: string;
}

export interface SampledQueue {
  profile: string;
  vhost: string;
  queue: string;
}

/** One Apply or Rule Pass's Messages taken out of a queue, by Decision. */
export interface TakeOut {
  checkoutId: string;
  at: number;
  operator: string;
  rule: string | null;
  counts: { discard: number; replay: number; move: number };
}

/** How many passes a rule keeps. */
export const PASS_HISTORY = 20;
/** How many first-seen times a rule keeps (the oldest go). */
export const FIRST_SEEN_LIMIT = 10_000;

export type NewNotificationDelivery = Omit<NotificationDelivery, 'id' | 'at'> & { at: Date };

/** Which outcomes to keep: those of these Broker Profiles and, or not, test notifications (which belong to none). */
export interface NotificationScope {
  profiles: ProfileScope;
  tests: boolean;
}

export interface AuditStore {
  /** The state of the Replay Rules. */
  readonly ruleState: RuleStateStore;
  /** Depth history. */
  readonly history: HistoryStore;
  /** The outcomes of notifications. */
  readonly notifications: NotificationStore;
  /** Alerts. */
  readonly alerts: AlertStore;
  /** Who is signed in, and who is signing in (Team Mode). */
  readonly sessions: SessionStore;
  /** Who is the Background Leader. */
  readonly leaderLease: LeaderLeaseStore;
  /** Which Replicas are alive and which Checkouts they own. */
  readonly replicas: ReplicaStore;

  /** Writes a `pending` entry (and its body, if any) in one durable commit; answers its id. */
  record(entry: NewAuditEntry): Promise<number>;
  /**
   * Writes a Restore's `pending` entry unless an earlier Restore of the same Discard
   * is anything but `failed`, however many Replicas ask at once. So a Restore that
   * failed frees the body, and one that never reported back keeps it.
   */
  claimRestore(entry: NewRestoreEntry): Promise<RestoreClaim>;
  setOutcome(id: number, outcome: Exclude<AuditOutcome, 'pending'>, reason?: string | null): Promise<void>;
  /** The Replica carrying out Checkout `checkoutId` has gone: its entries still `pending` become `uncertain`, with `reason`. Answers how many. */
  settleInterrupted(checkoutId: string, reason: string): Promise<number>;
  /** Records how the watch of a Canary's entry ended. */
  setCanaryOutcome(id: number, outcome: AuditCanaryOutcome): Promise<void>;
  /** The entries matching `query` (every entry by default), newest first. */
  list(query?: AuditQuery): Promise<AuditEntry[]>;
  /** One entry, or null. */
  get(id: number): Promise<AuditEntry | null>;
  /** The stored body of entry `id`'s Message, byte for byte; null when none is stored. */
  body(id: number): Promise<Buffer | null>;
  /**
   * Evicts stored bodies, oldest first: those older than `maxAgeMs`, then as
   * many more as needed for the rest to fit in `maxBodyBytes`. Each evicted
   * entry keeps everything else and is marked body expired at `now`.
   */
  evictBodies(eviction: BodyEviction, fence?: LeaseFence): Promise<{ evicted: number }>;
  /** The total size of the bodies stored now (what the size limit applies to). */
  storedBodyBytes(): Promise<number>;
  /** Resolves if the store can be reached now, and rejects soon if not, for a readiness probe. Never waits long. */
  ping(): Promise<void>;
  /** Closes the store. Closing it again does nothing. */
  close(): Promise<void>;
}

/**
 * What a write by the Background Leader names so the store can check the lease as part
 * of it. A write given a fence rejects with LeaderLeaseLost, having done nothing, once
 * the lease is no longer held in that term, however long ago the caller last looked.
 */
export interface LeaseFence {
  holder: string;
  term: number;
}

/** A write named a fence whose lease has been given up or taken by another. */
export class LeaderLeaseLost extends Error {
  constructor() {
    super('The leader lease is no longer held');
    this.name = 'LeaderLeaseLost';
  }
}

export interface LeaderLeaseGrant extends LeaseFence {
  /** Epoch milliseconds, by the clock of whoever claimed it. */
  expiresAt: number;
}

/**
 * The one lease that says which Replica is the Background Leader (ADR 0014). On SQLite
 * it is in memory, as one Replica needs no more, so a restart is its own leader at
 * once; on PostgreSQL it is a row every Replica shares.
 */
export interface LeaderLeaseStore {
  /**
   * Takes the lease for `holder` until `now + durationMs`, or renews it. Answers null
   * when another holds it past `now`. The term goes up each time the lease changes
   * hands or comes back after being given up.
   */
  claim(holder: string, now: number, durationMs: number): Promise<LeaderLeaseGrant | null>;
  /** Gives the lease up, free for the next claim; does nothing unless `holder` has it. */
  release(holder: string): Promise<void>;
}

/** The Audit Entry of a pause or resume of a Replay Rule, which has no Message. */
export type RulePauseEntry = NewAuditEntry & { message: null };

/** Replay Rule state, by rule key `<profile>/<rule>`. */
export interface RuleStateStore {
  /** The rule's state; creates it (paused when `startPaused`) the first time the rule is seen, after which the stored state wins. */
  ensure(ruleKey: string, startPaused: boolean): Promise<RuleState>;
  /** The rule's state; null when it has never started. */
  state(ruleKey: string): Promise<RuleState | null>;
  /** Pauses the rule (`reason`, `by`, `at`) and writes its Audit Entry, done, as one unit of work. */
  pause(ruleKey: string, pause: { reason: string; by: string; at: Date }, entry: RulePauseEntry): Promise<void>;
  /** Lets the rule run again, forgets the Died Again Messages counted for its automatic stop, and writes its Audit Entry, done, as one unit of work. */
  resume(ruleKey: string, entry: RulePauseEntry): Promise<void>;
  /** Keeps `pass` in the rule's history, dropping the oldest beyond PASS_HISTORY. */
  recordPass(ruleKey: string, pass: RulePass): Promise<void>;
  /** The rule's kept passes, newest first. */
  passes(ruleKey: string): Promise<RulePass[]>;
  /**
   * When a pass of the rule first saw each of `messageIds`: the stored time, or
   * `now` for an id not seen before (which is stored, dropping the oldest beyond
   * FIRST_SEEN_LIMIT).
   */
  firstSeen(ruleKey: string, messageIds: readonly string[], now: Date): Promise<Map<string, Date>>;
  /**
   * Notes the Died Again Messages a pass of the rule saw at `now`, by the Audit
   * Entry each last came from; only entries of this rule (`profile`, `rule`)
   * count, and each counts once. Forgets those seen before `since` and answers
   * how many are left: the count of the automatic stop.
   */
  countDiedAgain(ruleKey: string, rule: { profile: string; name: string }, auditEntryIds: readonly number[], now: Date, since: Date): Promise<number>;
  /** When a pass of the rule first saw each of `messageIds`, without storing anything; an id none has seen is left out. */
  firstSeenAt(ruleKey: string, messageIds: readonly string[]): Promise<Map<string, Date>>;
}

/** Depth history: one Sample per dead-letter queue per sampling run, one run per Broker Profile. */
export interface HistoryStore {
  /** Records a sampling run and its Samples in one commit. */
  recordRun(profile: string, run: StoredSamplingRun, samples: readonly QueueSample[]): Promise<void>;
  /** The queue's latest Sample before `before` (default: of all), or null. */
  latestSample(queue: SampledQueue, before?: number): Promise<StoredSample | null>;
  /** The queue's Samples from `from` to `to` (inclusive), oldest first. */
  samples(queue: SampledQueue, from: number, to: number): Promise<StoredSample[]>;
  /** The profile's runs in the range, oldest first, from its last good run before the range to its first good run after. */
  runsAround(profile: string, from: number, to: number): Promise<StoredSamplingRun[]>;
  /** The profile's latest run and latest good run, for the latest snapshot after a restart. */
  lastRuns(profile: string): Promise<{ last: StoredSamplingRun | null; lastOk: StoredSamplingRun | null }>;
  /** When the profile's latest good run before `before` ran, or null. */
  lastGoodRunBefore(profile: string, before: number): Promise<number | null>;
  /** How many Messages Volverán took out of the queue after `after`, up to and including `until`. */
  takenOut(queue: SampledQueue, after: number, until: number): Promise<number>;
  /** The Applies and Rule Passes that took Messages out of the queue in the range, oldest first. */
  takeOuts(queue: SampledQueue, from: number, to: number): Promise<TakeOut[]>;
  /** Removes the Samples and sampling runs older than `before`. */
  removeOlderThan(before: number, fence?: LeaseFence): Promise<{ samples: number; runs: number }>;
}

/** The outcome of each notification, kept as long as the depth history. */
export interface NotificationStore {
  record(delivery: NewNotificationDelivery): Promise<NotificationDelivery>;
  /** The latest outcomes (100 by default), newest first; `visible` narrows them first, so the limit counts only what is kept. */
  recent(limit?: number, visible?: NotificationScope): Promise<NotificationDelivery[]>;
  /** Removes the outcomes from before `cutoff`; answers how many. */
  removeOlderThan(cutoff: Date, fence?: LeaseFence): Promise<number>;
}

/** A signed-in Operator's session. Tokens reach the store already sealed (token-seal.ts); it only holds them. */
export interface StoredSession {
  operator: Pick<Operator, 'id' | 'displayName' | 'email' | 'name' | 'groups'>;
  /** Sealed. */
  tokens: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

/** A sign-in between /auth/login and /auth/callback. */
export interface StoredSignIn {
  sealed: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

/**
 * Sessions and sign-ins in progress. In memory on SQLite, so a restart signs everyone
 * out, and shared in the database on PostgreSQL. `now` is epoch milliseconds: what
 * expires at or before it is gone. Adding may remove what has expired.
 */
export interface SessionStore {
  addSession(id: string, session: StoredSession, now: number): Promise<void>;
  /** The session, or null. */
  session(id: string, now: number): Promise<StoredSession | null>;
  /**
   * Refreshes the session's sealed tokens, one caller at a time on any Replica: `refresh`
   * runs holding the session's lock, given the tokens as they are now, and what it answers
   * replaces them (null leaves them). When it throws nothing changes, and this throws the
   * same. False, without calling it, when the session has gone. It may wait for the
   * provider, so it never holds up the store's other calls: `refresh` must not call the store.
   */
  refreshTokens(id: string, now: number, refresh: (tokens: string) => Promise<string | null>): Promise<boolean>;
  removeSession(id: string): Promise<void>;
  addSignIn(id: string, signIn: StoredSignIn, now: number): Promise<void>;
  /** The sealed sign-in, removing it, so that of any callers only one gets it; else null. */
  takeSignIn(id: string, now: number): Promise<string | null>;
}

/** A Replica's lease, as stored. */
export interface ReplicaLeaseRow {
  replicaId: string;
  /** `host:port` of its internal port. */
  forwardingAddress: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

/** What a Live Checkout record says that changes as the Checkout goes on. */
export interface LiveCheckoutUpdate {
  /** `starting`: claimed, and not yet a Checkout anyone can use. */
  status: Exclude<CheckoutStatus, 'awaiting_approval'> | 'starting';
  /** The Approval the Checkout waits for, as the approvers' list shows it; null when it waits for none. */
  approval: ApprovalSummary | null;
  /** Why it ended; left out or null unless it has. */
  endReason?: EndReason | null;
  /** Why it was lost; left out or null unless it was. */
  lostReason?: string | null;
  /** Learned from the broker after the claim. Left out, the record keeps what it has; `deliveryLimit` goes with `queueType`. */
  queueType?: CheckoutQueueType;
  deliveryLimit?: number | null;
  readyAtStart?: number;
}

/** A Live Checkout record: where a Checkout is, and enough to list it. */
export interface NewLiveCheckout extends LiveCheckoutUpdate {
  id: string;
  /** The Owner Replica. */
  ownerReplica: string;
  operator: Pick<Operator, 'id' | 'displayName'>;
  profile: string;
  vhost: string;
  queue: string;
  queueType: CheckoutQueueType;
  deliveryLimit: number | null;
  readyAtStart: number;
  /** Epoch milliseconds. */
  startedAt: number;
  /** Epoch milliseconds. */
  endsAt: number;
}

/** A Live Checkout record as read: what another Replica can say of the Checkout once its owner has gone. */
export interface LiveCheckoutRecord extends NewLiveCheckout {
  endReason: EndReason | null;
  lostReason: string | null;
}

/** The Checkout that holds an Operator's one place. */
export interface OperatorHolding {
  id: string;
  vhost: string;
  queue: string;
}

/** Where a request about a Checkout goes. */
export interface LiveCheckoutRoute {
  ownerReplica: string;
  /** Null when the owner has no lease left at all. */
  forwardingAddress: string | null;
  ownerLeaseLive: boolean;
}

/**
 * Replicas' leases and Live Checkout records. `now` is epoch milliseconds: a lease expiring
 * at or before it is over. A record stays when its owner's lease ends, until it is removed.
 */
export interface ReplicaStore {
  /** Takes or extends the Replica's lease. */
  renewLease(lease: ReplicaLeaseRow): Promise<void>;
  /** The Replica has gone for good: removes its lease and every record it owns, as one unit of work. */
  removeReplica(replicaId: string): Promise<void>;

  /**
   * Adds the record unless the Operator already has a `starting` or `active` Checkout on a
   * Replica whose lease is live: then adds nothing and answers that one. One whose owner's
   * lease is over no longer counts, and becomes `lost` in the same unit of work.
   */
  claimCheckout(checkout: NewLiveCheckout, now: number): Promise<OperatorHolding | null>;
  /** Does nothing if the record has gone. A `lost` record does not become `active` again: its Operator may hold another by now. */
  updateCheckout(id: string, update: LiveCheckoutUpdate): Promise<void>;
  removeCheckout(id: string): Promise<void>;
  /** The record's route, or null when there is no record. */
  checkoutRoute(id: string, now: number): Promise<LiveCheckoutRoute | null>;
  /** The record, or null when there is none. */
  checkoutRecord(id: string): Promise<LiveCheckoutRecord | null>;
  /** Every record whose owner's lease is over at `now`. */
  checkoutsOfGoneReplicas(now: number): Promise<LiveCheckoutRecord[]>;
  /** Removes each lease over by `before` and the records of its Replica, as one unit of work. Answers how many leases. */
  removeGoneReplicas(before: number): Promise<number>;
  /** The id of the Operator's `active` Checkout whose owner's lease is live, or null. */
  activeCheckoutOf(operatorId: string, now: number): Promise<string | null>;
  /** The Owner Replica of Checkout `id` while it is `active` or `applying` and its owner's lease is live, or null. */
  runningOwner(id: string, now: number): Promise<string | null>;
}

/** Alerts and what arrival conditions remember of each queue, so a restart neither forgets nor re-sends a firing one. */
export interface AlertStore {
  /** What is remembered of the profile. */
  load(profile: string): Promise<AlertMemory>;
  /** Replaces what is remembered of the profile, in one commit. */
  save(profile: string, memory: AlertMemory): Promise<void>;
  /** Quietly forgets the Alerts of rules no longer in the file, and all of profiles no longer in it. */
  keepOnly(rulesByProfile: ReadonlyMap<string, readonly string[]>): Promise<void>;
}
