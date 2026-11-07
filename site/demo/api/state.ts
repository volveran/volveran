// The demo's state: what a visitor can change, in memory, per page load. It
// starts from the recording of the screenshot run (./recording.ts), which the
// caller passes in: the demo page fetches it, tests read it from disk.
import type { AlertsOverview } from '../../../src/shared/alerts.js';
import { rebased, type RecordedProfile, type RecordedVhost, type Recording } from './recording.js';
import { HttpError } from '../../../src/server/http-error.js';
import { AuditLog } from './simulator/audit-log.js';
import { scenarioBroker, type DemoBroker } from './simulator/broker.js';
import { Checkouts } from './simulator/checkouts.js';
import { applyScreenshotPrep, type PrepApply } from './simulator/screenshot-prep.js';

export const OPERATOR = 'demo';

export type DemoProfile = RecordedProfile;
export type DemoVhost = RecordedVhost;

export interface DemoState {
  operator: string;
  profiles: DemoProfile[];
  alerts: AlertsOverview;
  /** The Operator's active Checkout, if any (the triage simulator sets it). */
  checkoutId: string | null;
  /** The triage simulator: the broker every Broker Profile points at, the audit store and the Checkouts. */
  broker: DemoBroker;
  audit: AuditLog;
  checkouts: Checkouts;
}

/** How long before the page loaded the scenario's Messages were dead-lettered. */
const DEAD_LETTERED_AGO_MS = 8 * 60_000;

/**
 * What a visitor starts from: the read-only views as recorded, their times moved to `now`, and the
 * simulator's broker and audit store as the screenshot run left them when it recorded, after its
 * prep Apply and die-again.mjs (./simulator/screenshot-prep.ts).
 */
export function startingState(recorded: Recording, now: Date = new Date()): DemoState {
  const state = seededState(recorded, now);
  applyScreenshotPrep(state.broker, state.audit, prepApply(state.profiles));
  return state;
}

/**
 * The scenario as seed.mjs leaves the broker, before the screenshot run's prep: every Message
 * dead-lettered, an empty audit store. The read-only views are the recording's all the same.
 */
export function seededState(recorded: Recording, now: Date = new Date()): DemoState {
  const { profiles, alerts } = rebased(recorded, now.getTime());
  const broker = scenarioBroker(new Date(now.getTime() - DEAD_LETTERED_AGO_MS));
  const audit = new AuditLog();
  const state: Omit<DemoState, 'checkouts'> & { checkouts?: Checkouts } = {
    operator: OPERATOR,
    profiles,
    alerts,
    checkoutId: null,
    broker,
    audit,
  };
  state.checkouts = new Checkouts({ broker, audit, operator: OPERATOR, activeChanged: (id) => (state.checkoutId = id) });
  return state as DemoState;
}

/** The screenshot run's prep Apply, from the mark it left in the recorded History of orders.dlq on staging. */
function prepApply(profiles: DemoProfile[]): PrepApply {
  const staging = profiles.find((p) => p.summary.name === 'staging');
  const history = staging?.vhosts.find((v) => v.name === '/')?.histories['orders.dlq']?.['1h'];
  const mark = history?.marks.find((m) => m.kind === 'apply');
  if (!staging || !mark?.checkoutId || !mark.operator) throw new Error('The recording has no Apply mark on orders.dlq of staging: re-record it with capture.sh.');
  return { checkoutId: mark.checkoutId, at: new Date(mark.at), operator: mark.operator, brokerUser: staging.summary.username ?? '' };
}

/** The named Broker Profile; throws 404 `profile_not_found` as the server does. */
export function profileNamed(state: DemoState, name: string): DemoProfile {
  const found = state.profiles.find((p) => p.summary.name === name);
  if (!found) throw new HttpError(404, 'profile_not_found', `No Broker Profile named "${name}".`);
  return found;
}

/** The vhost of the named Broker Profile; throws 404 as the server does. */
export function vhostOf(state: DemoState, profileName: string, vhost: string): DemoVhost {
  const profile = profileNamed(state, profileName);
  const found = profile.vhosts.find((v) => v.name === vhost);
  if (!found) throw new HttpError(404, 'vhost_not_in_profile', `Vhost "${vhost}" is not configured for Broker Profile "${profileName}".`);
  return found;
}
