// The demo's state: what a visitor can change, in memory, per page load. It
// starts from the recording of the screenshot run (./recording.ts).
import type { AlertsOverview } from '../../../src/shared/alerts.js';
import { recording, type RecordedProfile, type RecordedVhost } from './recording.js';
import { DemoApiError } from './router.js';

export const OPERATOR = 'demo';

export type DemoProfile = RecordedProfile;
export type DemoVhost = RecordedVhost;

export interface DemoState {
  operator: string;
  profiles: DemoProfile[];
  alerts: AlertsOverview;
  /** The Operator's active Checkout, if any (the triage simulator sets it). */
  checkoutId: string | null;
}

/** The scenario as recorded, its times moved to `now`. */
export function startingState(now: number = Date.now()): DemoState {
  const { profiles, alerts } = recording(now);
  return { operator: OPERATOR, profiles, alerts, checkoutId: null };
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
