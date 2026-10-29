// Broker Profiles: loaded once at startup from a YAML file (mounted into the
// container). Passwords are never in the file: each profile names the
// environment variable that holds its password. A missing variable does not
// stop startup; using that profile reports `password_not_set`. A profile
// with `credentials: operatorToken` has no password at all: it connects with
// the signed-in Operator's own access token (Team Mode, ADR 0008).
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { ProfilesConfigError } from './config-error.js';
import { isRecord } from './is-record.js';
import type { RunMode } from './run-mode.js';
import { parseReplayRules, type ReplayRule } from './replay-rules/config.js';
import { isReplayRate, MAX_REPLAY_RATE, MIN_REPLAY_RATE } from '../shared/replay-rate.js';
import { ROLES, type Role } from '../shared/roles.js';

/**
 * Which OIDC groups hold which Role on a Broker Profile (Team Mode). An
 * Operator in groups of several roles holds the highest of them.
 */
export type RoleMapping = Partial<Record<Role, string[]>>;

/**
 * How Volverán authenticates to the broker of a profile: one shared service
 * account, or each signed-in Operator's own OAuth 2.0 access token (ADR
 * 0008). Resolved per request in broker-credentials.ts.
 */
export type ProfileCredentials =
  | {
      kind: 'shared';
      username: string;
      /** Name of the environment variable holding the password. */
      passwordEnv: string;
      /** Resolved from `passwordEnv`; undefined when the variable is not set. */
      password: string | undefined;
    }
  | {
      kind: 'operatorToken';
      /** The access token claim the broker takes as the user name (its `preferred_username_claims`); default `sub`. */
      tokenUsernameClaim: string;
    };

export interface BrokerProfile {
  name: string;
  /** http(s) base URL of the management API, without a trailing slash. */
  managementUrl: string;
  /** amqp(s) URL of the broker, without credentials or vhost. */
  amqpUrl: string;
  /** PEM CA bundle trusted for amqps and https, on top of Node's default CAs. */
  ca: Buffer | undefined;
  /** Where `ca` was read from, for messages. */
  caFile: string | undefined;
  credentials: ProfileCredentials;
  vhosts: 'all' | string[];
  /** Glob on queue names (`*`, `?`); matching queues are dead-letter queues. */
  defaultQueueFilter: string | undefined;
  protected: boolean;
  /**
   * Team Mode: an Apply with any Decision other than Keep waits for a second
   * Operator's Approval. Only allowed on a Protected Profile, where it
   * defaults to true; always false on any other. Solo Mode ignores it.
   */
  requireApproval: boolean;
  /**
   * Team Mode: the Role each group holds on this profile. Undefined when the
   * profile has no `roles`: every Operator is `admin` on it (ADR 0007).
   * Solo Mode ignores it.
   */
  roles: RoleMapping | undefined;
  /**
   * The Replay Rate an Apply runs at when the Operator gives none
   * (`default`), and the most an Operator may choose (`max`), in Messages
   * per second; null when not set.
   */
  replayRate: ReplayRateLimits;
  /** The profile's Replay Rules (replay-rules/config.ts); empty when it declares none. */
  replayRules: ReplayRule[];
}

/** A Broker Profile's `replayRate`; `default` is never above `max`. */
export interface ReplayRateLimits {
  default: number | null;
  max: number | null;
}

/** Whether the profile is configured for `vhost` (all vhosts, or it is listed). */
export function profileHasVhost(profile: BrokerProfile, vhost: string): boolean {
  return profile.vhosts === 'all' || profile.vhosts.includes(vhost);
}

/** One queue as seen through a Broker Profile. */
export interface QueueRef {
  profile: BrokerProfile;
  vhost: string;
  queue: string;
}

/** Just the queue reference of something that carries one (a Checkout, an Apply target). */
export function queueRefOf({ profile, vhost, queue }: QueueRef): QueueRef {
  return { profile, vhost, queue };
}

export { ProfilesConfigError };
export { checkReplayRules } from './replay-rules/config.js';

/** Loads and checks the profiles file; a relative `caFile` is relative to the file's directory. */
export async function loadProfilesFile(file: string, env: Record<string, string | undefined>): Promise<BrokerProfile[]> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    throw new ProfilesConfigError(`Cannot read the Broker Profiles file ${file}: ${(err as Error).message}`);
  }
  const profiles = parseProfiles(text, env, file);
  for (const p of profiles) {
    if (p.caFile === undefined) continue;
    p.caFile = path.resolve(path.dirname(file), p.caFile);
    try {
      p.ca = await readFile(p.caFile);
    } catch (err) {
      throw new ProfilesConfigError(
        `Broker Profile "${p.name}": cannot read caFile ${p.caFile}: ${(err as Error).message}`,
      );
    }
  }
  return profiles;
}

/** Parses the YAML text; `caFile` is kept as written and not read. */
export function parseProfiles(
  text: string,
  env: Record<string, string | undefined>,
  source = 'profiles file',
): BrokerProfile[] {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (err) {
    throw new ProfilesConfigError(`${source} is not valid YAML: ${(err as Error).message}`);
  }
  const list = isRecord(doc) ? doc.profiles : undefined;
  if (!Array.isArray(list) || list.length === 0) {
    throw new ProfilesConfigError(`${source} must contain a non-empty "profiles" list`);
  }

  const seen = new Set<string>();
  return list.map((raw, i) => {
    const where = `${source}: profiles[${i}]`;
    if (!isRecord(raw)) throw new ProfilesConfigError(`${where} must be a mapping`);
    if ('password' in raw) {
      throw new ProfilesConfigError(
        `${where} contains "password"; passwords must come from an environment variable named by "passwordEnv"`,
      );
    }
    const name = requireString(raw, 'name', where);
    if (seen.has(name)) throw new ProfilesConfigError(`${where}: duplicate profile name "${name}"`);
    seen.add(name);
    const isProtected = parseProtected(raw.protected, where);
    const credentials = parseCredentials(raw, env, where, `${where} ("${name}")`);
    const vhosts = parseVhosts(raw.vhosts, where);
    const replayRate = parseReplayRate(raw.replayRate, `${where} ("${name}").replayRate`);
    return {
      name,
      managementUrl: requireUrl(raw, 'managementUrl', ['http:', 'https:'], where).replace(/\/+$/, ''),
      amqpUrl: requireUrl(raw, 'amqpUrl', ['amqp:', 'amqps:'], where),
      ca: undefined,
      caFile: optionalString(raw, 'caFile', where),
      credentials,
      vhosts,
      defaultQueueFilter: optionalString(raw, 'defaultQueueFilter', where),
      protected: isProtected,
      requireApproval: parseRequireApproval(raw.requireApproval, isProtected, `${where} ("${name}").requireApproval`),
      roles: parseRoles(raw.roles, `${where} ("${name}").roles`),
      replayRate,
      replayRules: parseReplayRules(
        raw.replayRules,
        { credentials: credentials.kind, vhosts, maxRate: replayRate.max },
        `${where} ("${name}")`,
      ),
    };
  });
}

function parseCredentials(
  raw: Record<string, unknown>,
  env: Record<string, string | undefined>,
  where: string,
  named: string,
): ProfileCredentials {
  const kind = raw.credentials ?? 'shared';
  if (kind === 'operatorToken') {
    for (const key of ['username', 'passwordEnv']) {
      if (raw[key] !== undefined) throw new ProfilesConfigError(`${named}.${key} is not allowed with credentials: operatorToken`);
    }
    const claim = raw.tokenUsernameClaim ?? 'sub';
    if (typeof claim !== 'string' || claim.trim() === '') {
      throw new ProfilesConfigError(`${named}.tokenUsernameClaim must be a non-empty string`);
    }
    return { kind, tokenUsernameClaim: claim };
  }
  if (kind !== 'shared') {
    throw new ProfilesConfigError(`${named}.credentials must be "shared" or "operatorToken", not "${String(kind)}"`);
  }
  if (raw.tokenUsernameClaim !== undefined) {
    throw new ProfilesConfigError(`${named}.tokenUsernameClaim is only allowed with credentials: operatorToken`);
  }
  const passwordEnv = requireString(raw, 'passwordEnv', where);
  return { kind, username: requireString(raw, 'username', where), passwordEnv, password: env[passwordEnv] };
}

/**
 * Startup check of the profiles against the run mode: Solo Mode has no
 * signed-in Operator, so no token to connect with.
 */
export function checkProfilesForRunMode(profiles: BrokerProfile[], mode: RunMode['kind']): void {
  if (mode === 'team') return;
  const tokenProfile = profiles.find((p) => p.credentials.kind === 'operatorToken');
  if (tokenProfile) {
    throw new ProfilesConfigError(
      `Broker Profile "${tokenProfile.name}" has credentials: operatorToken, which needs Team Mode (VOLVERAN_AUTH=oidc): ` +
        'Solo Mode has no signed-in Operator whose token it could connect with. Give it username and passwordEnv instead.',
    );
  }
}

function parseVhosts(value: unknown, where: string): 'all' | string[] {
  if (value === undefined || value === 'all') return 'all';
  if (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string' && v !== '')) {
    return value as string[];
  }
  throw new ProfilesConfigError(`${where}.vhosts must be "all" or a non-empty list of vhost names`);
}

function parseRoles(value: unknown, where: string): RoleMapping | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value) || Object.keys(value).length === 0) {
    throw new ProfilesConfigError(`${where} must be a mapping of viewer, operator or admin to lists of group names`);
  }
  const roles: RoleMapping = {};
  for (const [key, groups] of Object.entries(value)) {
    if (!(ROLES as readonly string[]).includes(key)) {
      throw new ProfilesConfigError(`${where}.${key} is not a role; the roles are viewer, operator and admin`);
    }
    if (!Array.isArray(groups) || groups.length === 0 || !groups.every((g) => typeof g === 'string' && g !== '')) {
      throw new ProfilesConfigError(`${where}.${key} must be a non-empty list of group names`);
    }
    roles[key as Role] = groups as string[];
  }
  return roles;
}

function parseReplayRate(value: unknown, where: string): ReplayRateLimits {
  if (value === undefined || value === null) return { default: null, max: null };
  if (!isRecord(value)) throw new ProfilesConfigError(`${where} must be a mapping with default and/or max`);
  for (const key of Object.keys(value)) {
    if (key !== 'default' && key !== 'max') {
      throw new ProfilesConfigError(`${where}.${key} is not a key of replayRate; it takes default and max`);
    }
  }
  const rate = (key: 'default' | 'max'): number | null => {
    const v = value[key];
    if (v === undefined || v === null) return null;
    if (!isReplayRate(v)) {
      throw new ProfilesConfigError(
        `${where}.${key} must be a number of Messages per second from ${MIN_REPLAY_RATE} to ${MAX_REPLAY_RATE}`,
      );
    }
    return v;
  };
  const limits = { default: rate('default'), max: rate('max') };
  if (limits.default !== null && limits.max !== null && limits.default > limits.max) {
    throw new ProfilesConfigError(`${where}.default (${limits.default}) is above replayRate.max (${limits.max})`);
  }
  return limits;
}

function parseProtected(value: unknown, where: string): boolean {
  if (value === undefined) return false;
  if (typeof value === 'boolean') return value;
  throw new ProfilesConfigError(`${where}.protected must be true or false`);
}

function parseRequireApproval(value: unknown, isProtected: boolean, where: string): boolean {
  if (value === undefined || value === null) return isProtected;
  if (!isProtected) throw new ProfilesConfigError(`${where} is only allowed with protected: true`);
  if (typeof value === 'boolean') return value;
  throw new ProfilesConfigError(`${where} must be true or false`);
}

function requireUrl(raw: Record<string, unknown>, key: string, schemes: string[], where: string): string {
  const value = requireString(raw, key, where);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProfilesConfigError(`${where}.${key} is not a URL: "${value}"`);
  }
  if (!schemes.includes(url.protocol)) {
    throw new ProfilesConfigError(`${where}.${key} must start with ${schemes.map((s) => `${s}//`).join(' or ')}`);
  }
  if (url.username || url.password) {
    throw new ProfilesConfigError(`${where}.${key} must not contain credentials; use "username" and "passwordEnv"`);
  }
  return value;
}

function requireString(raw: Record<string, unknown>, key: string, where: string): string {
  const v = raw[key];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new ProfilesConfigError(`${where}.${key} is required and must be a non-empty string`);
  }
  return v;
}

function optionalString(raw: Record<string, unknown>, key: string, where: string): string | undefined {
  const v = raw[key];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw new ProfilesConfigError(`${where}.${key} must be a string`);
  return v;
}
