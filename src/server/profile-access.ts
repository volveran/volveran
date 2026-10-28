// The one access check: every /api/ route that acts on a Broker Profile, or
// on a Checkout or Audit Entry that belongs to one, resolves the profile
// here, with the requesting Operator and the capability the route needs. It
// answers with the Broker Profile and a management API client for it, so no
// route builds a client on its own.
//
// Each route names its capability where it resolves the profile. Who holds
// which capability is decided in one place (`denial`): today every Operator
// holds every capability on every profile, in both modes. Roles per profile
// (and the Operator's own broker token, for the client) change only this
// module, not the routes.
//
// Errors: 404 `profile_not_found` for an unknown profile name, 404
// `vhost_not_in_profile` for a vhost the profile is not configured for.
import { HttpError } from './http-error.js';
import { ManagementClient } from './management.js';
import type { Operator } from './operator.js';
import { profileHasVhost, type BrokerProfile, type QueueRef } from './profiles.js';

/** What an Operator may do on one Broker Profile: a closed list. */
export const CAPABILITIES = [
  /** See the profile, its vhosts, its queue list and set-up warnings. */
  'see_profile',
  /** Search and read Audit Entries, without the Discarded Message bodies. */
  'read_audit_entries',
  /** Read the Discarded Message bodies kept in Audit Entries. */
  'read_discarded_bodies',
  /** Start a Checkout and use it: assign Decisions, Apply, export. */
  'checkout',
  /** See, approve and reject other Operators' waiting Applies. */
  'approve',
  /** Restore a Discarded Message. */
  'restore',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** A Broker Profile the Operator may act on, with its management API client. */
export interface ProfileAccess {
  profile: BrokerProfile;
  management: ManagementClient;
}

/** One queue the Operator may act on, with the management API client of its profile. */
export type QueueAccess = QueueRef & ProfileAccess;

export class ProfileAccessCheck {
  constructor(private readonly profiles: BrokerProfile[]) {}

  /**
   * The check itself: why `operator` may not use `capability` on the
   * Broker Profile named `profileName`, or null when they may. Every
   * Operator holds every capability on every profile for now.
   */
  private denial(_operator: Operator, _capability: Capability, _profileName: string): HttpError | null {
    return null;
  }

  /** Whether `operator` holds `capability` on the profile named `profileName` (configured or not). */
  holds(operator: Operator, capability: Capability, profileName: string): boolean {
    return this.denial(operator, capability, profileName) === null;
  }

  /** The configured Broker Profiles on which `operator` holds `capability`, in file order. */
  list(operator: Operator, capability: Capability): BrokerProfile[] {
    return this.profiles.filter((p) => this.holds(operator, capability, p.name));
  }

  /** The named Broker Profile; throws 404 `profile_not_found`, or the denial. */
  profile(operator: Operator, capability: Capability, name: string): ProfileAccess {
    const found = this.profiles.find((p) => p.name === name);
    if (!found) throw new HttpError(404, 'profile_not_found', `No Broker Profile named "${name}".`);
    return this.grant(operator, capability, found);
  }

  /** The named Broker Profile, checked to be configured for `vhost`; throws 404, or the denial. */
  vhost(operator: Operator, capability: Capability, profileName: string, vhost: string): ProfileAccess {
    const access = this.profile(operator, capability, profileName);
    if (!profileHasVhost(access.profile, vhost)) {
      throw new HttpError(
        404,
        'vhost_not_in_profile',
        `Vhost "${vhost}" is not configured for Broker Profile "${access.profile.name}".`,
      );
    }
    return access;
  }

  /** The queue an API path names, after checking its profile and vhost; throws 404, or the denial. */
  queue(operator: Operator, capability: Capability, profileName: string, vhost: string, queue: string): QueueAccess {
    return { ...this.vhost(operator, capability, profileName, vhost), vhost, queue };
  }

  /** The Broker Profile of a Checkout (or anything else holding a configured profile); throws the denial. */
  of(operator: Operator, capability: Capability, { profile }: { profile: BrokerProfile }): ProfileAccess {
    return this.grant(operator, capability, profile);
  }

  /**
   * The Broker Profile an Audit Entry belongs to; throws the denial. Null
   * when that profile is no longer configured: the entry stays readable,
   * but nothing can be done on its broker.
   */
  ofAuditEntry(operator: Operator, capability: Capability, entry: { profile: string }): ProfileAccess | null {
    const denied = this.denial(operator, capability, entry.profile);
    if (denied) throw denied;
    const found = this.profiles.find((p) => p.name === entry.profile);
    return found ? { profile: found, management: new ManagementClient(found) } : null;
  }

  private grant(operator: Operator, capability: Capability, profile: BrokerProfile): ProfileAccess {
    const denied = this.denial(operator, capability, profile.name);
    if (denied) throw denied;
    return { profile, management: new ManagementClient(profile) };
  }
}
