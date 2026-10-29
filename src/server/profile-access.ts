// The one access check: every /api/ route that acts on a Broker Profile, or
// on a Checkout or Audit Entry that belongs to one, resolves the profile
// here, with the requesting Operator and the capability the route needs. It
// answers with the Broker Profile, the Operator's Role on it, a management
// API client for it and the credentials for its AMQP connections, so no
// route builds a client or picks credentials on its own. On a profile with
// `credentials: operatorToken` both use the Operator's own token (ADR 0008).
//
// Each route names its capability where it resolves the profile. Who holds
// which capability is decided in one place (`denial`), from the Operator's
// Role on the profile (`roleOn`) and the role each capability needs
// (`REQUIRED_ROLE`). Roles (Team Mode) come from the Operator's groups and
// the profile's `roles` mapping; the highest matching role wins, and no
// match means no role. A profile without `roles` gives everyone `admin` (ADR
// 0007). On a profile no longer configured (only its Audit Entries are
// left) the Operator holds the highest Role they hold on any configured
// profile, and no role when they hold none. In Solo Mode the Operator is
// `admin` everywhere.
//
// Errors: 404 `profile_not_found` for an unknown profile name, 404
// `vhost_not_in_profile` for a vhost the profile is not configured for, 403
// `no_role_on_profile` without a role on it, 403 `role_required` (with
// `required` and `held`) for too low a role. Each is thrown before the route
// touches the broker or the audit store.
import { brokerCredentials, type BrokerCredentials } from './broker-credentials.js';
import { HttpError } from './http-error.js';
import { ManagementClient } from './management.js';
import type { Operator } from './operator.js';
import type { ProfileScope } from './audit/store.js';
import { profileHasVhost, type BrokerProfile, type QueueRef } from './profiles.js';
import type { RunMode } from './run-mode.js';
import { highestRole, roleIncludes, ROLES, type Role } from '../shared/roles.js';

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
  /** Run a pass of one of the profile's Replay Rules now. */
  'run_replay_rule',
  /** Pause one of the profile's Replay Rules. */
  'pause_replay_rule',
  /** Resume one of the profile's paused Replay Rules. */
  'resume_replay_rule',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** The lowest Role that holds each capability. */
export const REQUIRED_ROLE: Record<Capability, Role> = {
  see_profile: 'viewer',
  read_audit_entries: 'viewer',
  read_discarded_bodies: 'operator',
  checkout: 'operator',
  approve: 'operator',
  restore: 'admin',
  run_replay_rule: 'admin',
  pause_replay_rule: 'operator',
  resume_replay_rule: 'admin',
};

/**
 * A Broker Profile the Operator may act on, with their Role on it, its
 * management API client and the credentials to open AMQP connections with
 * (the profile's shared account, or this Operator's own token).
 */
export interface ProfileAccess {
  profile: BrokerProfile;
  role: Role;
  management: ManagementClient;
  /** Resolved when called: throws 401 `broker_token_expired` once the Operator's token has expired. */
  credentials(): BrokerCredentials;
}

/** One queue the Operator may act on, with the management API client of its profile. */
export type QueueAccess = QueueRef & ProfileAccess;

export class ProfileAccessCheck {
  constructor(
    private readonly profiles: BrokerProfile[],
    private readonly mode: RunMode['kind'],
  ) {}

  /**
   * The Operator's Role on the Broker Profile named `profileName`, or null
   * when they have none.
   */
  roleOn(operator: Operator, profileName: string): Role | null {
    const found = this.profiles.find((p) => p.name === profileName);
    if (!found) return this.highestConfiguredRole(operator);
    return this.roleOnConfigured(operator, found);
  }

  private roleOnConfigured(operator: Operator, profile: BrokerProfile): Role | null {
    if (this.mode === 'solo') return 'admin';
    const mapping = profile.roles;
    if (!mapping) return 'admin';
    const groups = new Set(operator.groups ?? []);
    return highestRole(ROLES.filter((role) => mapping[role]?.some((g) => groups.has(g))));
  }

  /**
   * The Operator's Role on a profile no longer configured (only its Audit
   * Entries are left): the highest Role they hold on any configured profile,
   * so a Discarded body is never readable to someone who could read none.
   */
  private highestConfiguredRole(operator: Operator): Role | null {
    if (this.mode === 'solo') return 'admin';
    return highestRole(this.profiles.map((p) => this.roleOnConfigured(operator, p)).filter((r): r is Role => r !== null));
  }

  /** The Operator's Role on each configured Broker Profile where they have one, in file order. */
  roles(operator: Operator): Record<string, Role> {
    const roles: Record<string, Role> = {};
    for (const p of this.profiles) {
      const role = this.roleOn(operator, p.name);
      if (role) roles[p.name] = role;
    }
    return roles;
  }

  /**
   * The check itself: why `operator` may not use `capability` on the
   * Broker Profile named `profileName`, or null when they may.
   */
  private denial(operator: Operator, capability: Capability, profileName: string): HttpError | null {
    const held = this.roleOn(operator, profileName);
    if (!held) {
      return new HttpError(
        403,
        'no_role_on_profile',
        `You have no role on Broker Profile "${profileName}". Ask whoever runs Volverán to map one of your groups to a role on it.`,
        { profile: profileName },
      );
    }
    const required = REQUIRED_ROLE[capability];
    if (!roleIncludes(held, required)) {
      return new HttpError(
        403,
        'role_required',
        `This needs the role "${required}" on Broker Profile "${profileName}"; you have "${held}".`,
        { profile: profileName, required, held },
      );
    }
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

  /**
   * The Broker Profiles whose Audit Entries `operator` may see with
   * `capability`, for an audit store query: every profile but the configured
   * ones withheld, or, when profiles no longer configured are withheld too
   * (no role anywhere), only the configured ones held.
   */
  auditScope(operator: Operator, capability: Capability): ProfileScope {
    const unconfigured = this.highestConfiguredRole(operator);
    if (!unconfigured || !roleIncludes(unconfigured, REQUIRED_ROLE[capability])) {
      return { only: this.list(operator, capability).map((p) => p.name) };
    }
    return { except: this.profiles.filter((p) => !this.holds(operator, capability, p.name)).map((p) => p.name) };
  }

  /** Throws 403 `no_role` unless `operator` has a Role on at least one Broker Profile. */
  assertSomeRole(operator: Operator): void {
    if (this.highestConfiguredRole(operator)) return;
    throw new HttpError(
      403,
      'no_role',
      'You have no role on any Broker Profile. Ask whoever runs Volverán to map one of your groups to a role.',
    );
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
   * when that profile is no longer configured: the entry stays readable to
   * those with a role somewhere, but nothing can be done on its broker.
   */
  ofAuditEntry(operator: Operator, capability: Capability, entry: { profile: string }): ProfileAccess | null {
    const denied = this.denial(operator, capability, entry.profile);
    if (denied) throw denied;
    const found = this.profiles.find((p) => p.name === entry.profile);
    return found ? this.grant(operator, capability, found) : null;
  }

  private grant(operator: Operator, capability: Capability, profile: BrokerProfile): ProfileAccess {
    const denied = this.denial(operator, capability, profile.name);
    if (denied) throw denied;
    const credentials = () => brokerCredentials(profile, operator);
    return {
      profile,
      role: this.roleOn(operator, profile.name)!,
      management: new ManagementClient(profile, credentials),
      credentials,
    };
  }
}
