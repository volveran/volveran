// Broker Profiles: loaded once at startup from a YAML file (mounted into the
// container). Passwords are never in the file: each profile names the
// environment variable that holds its password. A missing variable does not
// stop startup; using that profile reports `password_not_set`.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { ConfigError } from './config-error.js';
import { isRecord } from './is-record.js';
import { ROLES, type Role } from '../shared/roles.js';

/**
 * Which OIDC groups hold which Role on a Broker Profile (Team Mode). An
 * Operator in groups of several roles holds the highest of them.
 */
export type RoleMapping = Partial<Record<Role, string[]>>;

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
  username: string;
  /** Name of the environment variable holding the password. */
  passwordEnv: string;
  /** Resolved from `passwordEnv`; undefined when the variable is not set. */
  password: string | undefined;
  vhosts: 'all' | string[];
  /** Glob on queue names (`*`, `?`); matching queues are dead-letter queues. */
  defaultQueueFilter: string | undefined;
  protected: boolean;
  /**
   * Team Mode: the Role each group holds on this profile. Undefined when the
   * profile has no `roles`: every Operator is `admin` on it (ADR 0007).
   * Solo Mode ignores it.
   */
  roles: RoleMapping | undefined;
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

export class ProfilesConfigError extends ConfigError {
  constructor(message: string) {
    super(message);
    this.name = 'ProfilesConfigError';
  }
}

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
    const passwordEnv = requireString(raw, 'passwordEnv', where);
    return {
      name,
      managementUrl: requireUrl(raw, 'managementUrl', ['http:', 'https:'], where).replace(/\/+$/, ''),
      amqpUrl: requireUrl(raw, 'amqpUrl', ['amqp:', 'amqps:'], where),
      ca: undefined,
      caFile: optionalString(raw, 'caFile', where),
      username: requireString(raw, 'username', where),
      passwordEnv,
      password: env[passwordEnv],
      vhosts: parseVhosts(raw.vhosts, where),
      defaultQueueFilter: optionalString(raw, 'defaultQueueFilter', where),
      protected: parseProtected(raw.protected, where),
      roles: parseRoles(raw.roles, `${where} ("${name}").roles`),
    };
  });
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

function parseProtected(value: unknown, where: string): boolean {
  if (value === undefined) return false;
  if (typeof value === 'boolean') return value;
  throw new ProfilesConfigError(`${where}.protected must be true or false`);
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
