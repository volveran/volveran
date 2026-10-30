// Alert Destinations in the profiles file (ADR 0012): the top-level
// `alertDestinations`, read and checked at startup. A destination's URL is a
// credential, as is its signing secret: both come from environment variables,
// and no refusal ever repeats their values.
import { ProfilesConfigError } from '../config-error.js';
import { isRecord } from '../is-record.js';
import { ALERT_DESTINATION_TYPES, type AlertDestinationType } from '../../shared/alerts.js';

export interface AlertDestination {
  name: string;
  type: AlertDestinationType;
  /** Resolved from `urlEnv`. Never sent to the browser, logged or recorded. */
  url: string;
  /** Resolved from `signingSecretEnv` (webhook only); null without one. */
  signingSecret: string | null;
}

const KEYS = ['name', 'type', 'urlEnv', 'signingSecretEnv'];
/** Goes in the test endpoint's path. */
const NAME = /^[A-Za-z0-9_-]+$/;

export function parseAlertDestinations(
  value: unknown,
  env: Record<string, string | undefined>,
  source: string,
): AlertDestination[] {
  if (value === undefined || value === null) return [];
  const where = `${source}: alertDestinations`;
  if (!Array.isArray(value)) throw new ProfilesConfigError(`${where} must be a list`);
  const names = new Set<string>();
  return value.map((raw, i) => {
    const at = `${where}[${i}]`;
    if (!isRecord(raw)) throw new ProfilesConfigError(`${at} must be a mapping`);
    const { name } = raw;
    if (typeof name !== 'string' || name === '') throw new ProfilesConfigError(`${at}.name is required: letters, digits, - and _`);
    if (!NAME.test(name)) throw new ProfilesConfigError(`${at}.name "${name}" may only contain letters, digits, - and _`);
    const named = `${at} ("${name}")`;
    if (names.has(name)) throw new ProfilesConfigError(`${named}.name is used by another Alert Destination`);
    names.add(name);
    return parseDestination(raw, name, env, named);
  });
}

function parseDestination(
  raw: Record<string, unknown>,
  name: string,
  env: Record<string, string | undefined>,
  at: string,
): AlertDestination {
  for (const key of Object.keys(raw)) {
    if (!KEYS.includes(key)) {
      throw new ProfilesConfigError(`${at}.${key} is not a key of an Alert Destination; it takes ${KEYS.join(', ')}`);
    }
  }
  const type = raw.type;
  if (!(ALERT_DESTINATION_TYPES as readonly unknown[]).includes(type)) {
    throw new ProfilesConfigError(`${at}.type must be slack, teams or webhook`);
  }
  if (raw.signingSecretEnv !== undefined && type !== 'webhook') {
    throw new ProfilesConfigError(`${at}.signingSecretEnv is only allowed with type: webhook`);
  }
  const urlEnv = raw.urlEnv;
  if (typeof urlEnv !== 'string' || urlEnv === '') {
    throw new ProfilesConfigError(`${at}.urlEnv is required: the environment variable holding the URL`);
  }
  const url = readVariable(urlEnv, env, `${at}.urlEnv`);
  if (!isHttpUrl(url)) throw new ProfilesConfigError(`${at}.urlEnv: ${urlEnv} must hold an http or https URL`);
  return {
    name,
    type: type as AlertDestinationType,
    url,
    signingSecret: raw.signingSecretEnv === undefined ? null : readSecret(raw.signingSecretEnv, env, `${at}.signingSecretEnv`),
  };
}

function readSecret(variable: unknown, env: Record<string, string | undefined>, at: string): string {
  if (typeof variable !== 'string' || variable === '') {
    throw new ProfilesConfigError(`${at} must name the environment variable holding the signing secret`);
  }
  return readVariable(variable, env, at);
}

function readVariable(variable: string, env: Record<string, string | undefined>, at: string): string {
  const value = env[variable]?.trim();
  if (!value) throw new ProfilesConfigError(`${at} names ${variable}, which is not set`);
  return value;
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}
