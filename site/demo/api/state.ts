// The demo's state: what a visitor can change, in memory, per page load. It
// starts from the recording of the screenshot run (./recording.ts).
import type { AlertsOverview } from '../../../src/shared/alerts.js';
import { recording, type RecordedProfile, type RecordedVhost } from './recording.js';
import { DemoApiError } from './router.js';
import { AuditLog } from './simulator/audit-log.js';
import { scenarioBroker, type DemoBroker } from './simulator/broker.js';
import { Checkouts } from './simulator/checkouts.js';

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

/** The scenario: the read-only views as recorded, their times moved to `now`, and the simulator's broker. */
export function startingState(now: Date = new Date()): DemoState {
  const { profiles, alerts } = recording(now.getTime());
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

/** The named Broker Profile; throws 404 `profile_not_found` as the server does. */
export function profileNamed(state: DemoState, name: string): DemoProfile {
  const found = state.profiles.find((p) => p.summary.name === name);
  if (!found) throw new DemoApiError(404, 'profile_not_found', `No Broker Profile named "${name}".`);
  return found;
}

/** The vhost of the named Broker Profile; throws 404 as the server does. */
export function vhostOf(state: DemoState, profileName: string, vhost: string): DemoVhost {
  const profile = profileNamed(state, profileName);
  const found = profile.vhosts.find((v) => v.name === vhost);
  if (!found) throw new DemoApiError(404, 'vhost_not_in_profile', `Vhost "${vhost}" is not configured for Broker Profile "${profileName}".`);
  return found;
}
