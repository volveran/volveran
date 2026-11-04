// The demo's state: what a visitor can change, in memory, per page load.
import { fixture, type DemoProfile, type DemoVhost } from './fixture.js';
import { DemoApiError } from './router.js';

export const OPERATOR = 'demo';

export interface DemoState {
  operator: string;
  profiles: DemoProfile[];
  /** The Operator's active Checkout, if any (the triage simulator sets it). */
  checkoutId: string | null;
}

export function startingState(): DemoState {
  return { operator: OPERATOR, profiles: structuredClone(fixture.profiles), checkoutId: null };
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
