// Replay Rules in the profiles file (ADR 0011): a Broker Profile's
// `replayRules`, read and checked at startup with the rest of the profile.
// Every key is checked, including those only a scheduled pass uses, and a
// refusal names the profile, the rule and the key. A rule needs credentials
// of its own (no Operator is signed in when it runs), so a profile with
// `credentials: operatorToken` cannot have one. Durations use duration.ts.
import { ProfilesConfigError } from '../config-error.js';
import { durationWithin } from '../duration.js';
import { isRecord } from '../is-record.js';
import { FILTER_CLAUSE_KEYS, parseFilter, type FilterKind } from '../triage/filters.js';
import { MAX_PREFETCH } from '../triage/checkout-collection.js';
import { isReplayRate, MAX_REPLAY_RATE, MIN_REPLAY_RATE } from '../../shared/replay-rate.js';
import type { Filter } from '../../shared/filters.js';
import type { ReplayRule, WhenAttemptsUsedUp } from '../../shared/replay-rules.js';

export type { ReplayRule };

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const DEFAULT_MAX_PER_PASS = 100;
export const DEFAULT_RULE_RATE = 10;
const DEFAULT_MULTIPLIER = 2;

const KEYS = [
  'name',
  'vhost',
  'queue',
  'filter',
  'every',
  'maxPerPass',
  'rate',
  'backoff',
  'maxAttempts',
  'whenAttemptsUsedUp',
  'stopWhen',
  'startPaused',
];
const NAME = /^[A-Za-z0-9_-]+$/;

/** What a rule's checks need to know of its Broker Profile. */
export interface RuleProfileFacts {
  credentials: 'shared' | 'operatorToken';
  vhosts: 'all' | string[];
  /** The profile's `replayRate.max`; null when it sets none. */
  maxRate: number | null;
}

/** Reads a Broker Profile's `replayRules`; `where` names the profile in refusals. */
export function parseReplayRules(value: unknown, profile: RuleProfileFacts, where: string): ReplayRule[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ProfilesConfigError(`${where}.replayRules must be a list of rules`);
  const names = new Set<string>();
  return value.map((raw, i) => {
    const at = `${where}.replayRules[${i}]`;
    if (!isRecord(raw)) throw new ProfilesConfigError(`${at} must be a mapping`);
    const name = raw.name;
    if (typeof name !== 'string' || name === '') throw new ProfilesConfigError(`${at}.name is required: letters, digits, - and _`);
    if (!NAME.test(name)) throw new ProfilesConfigError(`${at}.name "${name}" may only contain letters, digits, - and _`);
    const rule = parseRule(raw, profile, `${at} ("${name}")`);
    if (names.has(name)) throw new ProfilesConfigError(`${at} ("${name}").name is used by another rule of this profile`);
    names.add(name);
    return rule;
  });
}

function parseRule(raw: Record<string, unknown>, profile: RuleProfileFacts, at: string): ReplayRule {
  const fail = (message: string): never => {
    throw new ProfilesConfigError(`${at}${message}`);
  };
  if (profile.credentials === 'operatorToken') {
    fail(
      ' is on a profile with credentials: operatorToken; a rule runs with no Operator signed in, so its profile needs username and passwordEnv',
    );
  }
  for (const key of Object.keys(raw)) {
    if (!KEYS.includes(key)) fail(`.${key} is not a key of a Replay rule`);
  }
  const text = (key: string): string => {
    const v = raw[key];
    return typeof v === 'string' && v.trim() !== '' ? v : fail(`.${key} is required and must be a non-empty string`);
  };
  const vhost = text('vhost');
  if (profile.vhosts !== 'all' && !profile.vhosts.includes(vhost)) fail(`.vhost "${vhost}" is not one of the profile's vhosts`);
  const queue = text('queue');

  const everyMs = durationWithin(raw.every, 30 * SECOND, DAY) ?? fail('.every must be a duration from 30s to 24h');
  const maxPerPass =
    raw.maxPerPass === undefined
      ? DEFAULT_MAX_PER_PASS
      : wholeNumber(raw.maxPerPass, 1, MAX_PREFETCH) ?? fail(`.maxPerPass must be a whole number from 1 to ${MAX_PREFETCH}`);
  const maxAttempts = wholeNumber(raw.maxAttempts, 1, 100) ?? fail('.maxAttempts must be a whole number from 1 to 100');

  return {
    name: raw.name as string,
    vhost,
    queue,
    filter: parseRuleFilter(raw.filter, fail),
    everyMs,
    maxPerPass,
    rate: parseRate(raw.rate, profile.maxRate, fail),
    backoff: parseBackoff(raw.backoff, fail),
    maxAttempts,
    whenAttemptsUsedUp: parseWhenUsedUp(raw.whenAttemptsUsedUp, queue, fail),
    stopWhen: parseStopWhen(raw.stopWhen, fail),
    startPaused:
      raw.startPaused === undefined ? false : typeof raw.startPaused === 'boolean' ? raw.startPaused : fail('.startPaused must be true or false'),
  };
}

type Fail = (message: string) => never;

/** One clause as a mapping, or a list of clauses as the API takes them; left out, every Message. */
function parseRuleFilter(value: unknown, fail: Fail): Filter | null {
  if (value === undefined || value === null) return null;
  // Before parsing: a misspelt `value` is reported as the key it is, not as a missing one.
  if (Array.isArray(value)) value.forEach((clause, i) => refuseUnknownClauseKeys(clause, `.filter[${i}]`, fail));
  else refuseUnknownClauseKeys(value, '.filter', fail);
  const parsed = parseFilter(Array.isArray(value) ? value : [value]);
  return parsed.ok ? parsed.filter : fail(`.filter: ${parsed.error}`);
}

function refuseUnknownClauseKeys(clause: unknown, at: string, fail: Fail): void {
  if (!isRecord(clause)) return;
  // An unknown kind has no keys to compare with; parseFilter refuses it.
  const keys = Object.hasOwn(FILTER_CLAUSE_KEYS, String(clause.kind)) ? FILTER_CLAUSE_KEYS[clause.kind as FilterKind] : null;
  for (const key of Object.keys(clause)) {
    if (keys !== null && !keys.includes(key)) fail(`${at}.${key} is not a key of this filter clause; ${String(clause.kind)} takes ${keys.join(', ')}`);
  }
}

function parseRate(value: unknown, maxRate: number | null, fail: Fail): number {
  if (value === undefined || value === null) return maxRate === null ? DEFAULT_RULE_RATE : Math.min(DEFAULT_RULE_RATE, maxRate);
  if (!isReplayRate(value)) return fail(`.rate must be a number of Messages per second from ${MIN_REPLAY_RATE} to ${MAX_REPLAY_RATE}`);
  if (maxRate !== null && value > maxRate) return fail(`.rate (${value}) is above the profile's replayRate.max (${maxRate})`);
  return value;
}

function parseBackoff(value: unknown, fail: Fail): ReplayRule['backoff'] {
  if (!isRecord(value)) return fail('.backoff is required: { initial, multiplier, max }');
  for (const key of Object.keys(value)) {
    if (!['initial', 'multiplier', 'max'].includes(key)) fail(`.backoff.${key} is not a key of backoff; it takes initial, multiplier and max`);
  }
  const initialMs = durationWithin(value.initial, SECOND, 7 * DAY) ?? fail('.backoff.initial must be a duration from 1s to 7d');
  const maxMs = durationWithin(value.max, SECOND, 7 * DAY) ?? fail('.backoff.max must be a duration from 1s to 7d');
  const m = value.multiplier ?? DEFAULT_MULTIPLIER;
  const multiplier =
    typeof m === 'number' && Number.isFinite(m) && m >= 1 && m <= 100 ? m : fail('.backoff.multiplier must be a number from 1 to 100');
  if (maxMs < initialMs) fail(`.backoff.max (${String(value.max)}) is below backoff.initial (${String(value.initial)})`);
  return { initialMs, multiplier, maxMs };
}

function parseWhenUsedUp(value: unknown, queue: string, fail: Fail): WhenAttemptsUsedUp {
  if (value === undefined || value === null || value === 'keep') return 'keep';
  const shape = '.whenAttemptsUsedUp must be keep or { moveTo: { queue: <name> } }';
  if (!isRecord(value)) return fail(shape);
  for (const key of Object.keys(value)) {
    if (key !== 'moveTo') fail(`.whenAttemptsUsedUp.${key} is not a key of whenAttemptsUsedUp; it takes moveTo`);
  }
  const { moveTo } = value;
  if (!isRecord(moveTo)) return fail(shape);
  for (const key of Object.keys(moveTo)) {
    if (key !== 'queue') fail(`.whenAttemptsUsedUp.moveTo.${key} is not a key of moveTo; it takes queue`);
  }
  if (typeof moveTo.queue !== 'string' || moveTo.queue === '') return fail(shape);
  if (moveTo.queue === queue) fail(`.whenAttemptsUsedUp.moveTo.queue must differ from the rule's queue "${queue}"`);
  return { moveTo: { queue: moveTo.queue } };
}

function parseStopWhen(value: unknown, fail: Fail): ReplayRule['stopWhen'] {
  if (!isRecord(value)) {
    return fail('.stopWhen is required: { diedAgain, within }, so the rule stops itself when its Replayed Messages die again');
  }
  for (const key of Object.keys(value)) {
    if (key !== 'diedAgain' && key !== 'within') fail(`.stopWhen.${key} is not a key of stopWhen; it takes diedAgain and within`);
  }
  const diedAgain = wholeNumber(value.diedAgain, 1, 100_000) ?? fail('.stopWhen.diedAgain must be a whole number from 1 to 100000');
  const withinMs = durationWithin(value.within, MINUTE, 7 * DAY) ?? fail('.stopWhen.within must be a duration from 1m to 7d');
  return { diedAgain, withinMs };
}

function wholeNumber(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}

/**
 * Startup check against the Checkout limits (set in the environment, not
 * the profiles file): a pass's Checkout must be able to hold `maxPerPass`
 * Messages.
 */
export function checkReplayRules(
  profiles: Array<{ name: string; replayRules: ReplayRule[] }>,
  limits: { maxMessages: number },
): void {
  for (const profile of profiles) {
    for (const rule of profile.replayRules) {
      if (rule.maxPerPass > limits.maxMessages) {
        throw new ProfilesConfigError(
          `Broker Profile "${profile.name}", Replay rule "${rule.name}": maxPerPass (${rule.maxPerPass}) is above the Checkout Message limit (${limits.maxMessages}, VOLVERAN_CHECKOUT_MAX_MESSAGES)`,
        );
      }
    }
  }
}
