// Alert Rules in the profiles file (ADR 0012): a Broker Profile's `alerts`, read
// and checked at startup with the rest of the profile. A refusal names the
// profile, the rule and the key. Queue conditions, setupWarning and samplingFailing
// need Samples, so a profile with `credentials: operatorToken`, which is not
// sampled, cannot have one. It cannot have Replay Rules either, so replayRulePaused
// is refused there too, as on any profile with none.
import { ProfilesConfigError } from '../config-error.js';
import { durationWithin } from '../duration.js';
import { isRecord } from '../is-record.js';
import type { SetupWarningSeverity } from '../../shared/queues.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const WEEK = 7 * 24 * 60 * MINUTE;

const RULE_KEYS = ['name', 'destinations', 'when', 'for', 'repeatEvery'];
const NAME = /^[A-Za-z0-9_-]+$/;
const QUEUE_CONDITIONS = ['depthAbove', 'arrivalsAbove', 'anyArrival'];
const VOLVERAN_CONDITIONS = ['replayRulePaused', 'setupWarning', 'samplingFailing'];
const CONDITIONS = [...QUEUE_CONDITIONS, ...VOLVERAN_CONDITIONS];
const SELECTION_KEYS = ['vhost', 'queue', 'queuePattern'];
const WHEN_KEYS = [...SELECTION_KEYS, 'rule', ...CONDITIONS];
const SEVERITIES: readonly SetupWarningSeverity[] = ['loses_messages', 'may_lose_messages'];

/** Which dead-letter queues a queue condition is about: one by name, or each one matching a glob. */
export interface QueueSelection {
  vhost: string;
  queue: string | null;
  queuePattern: string | null;
}

export type QueueCondition =
  | (QueueSelection & { kind: 'depthAbove'; threshold: number })
  | (QueueSelection & { kind: 'arrivalsAbove'; count: number; withinMs: number })
  | (QueueSelection & { kind: 'anyArrival' });

export type AlertCondition =
  | QueueCondition
  /** A Replay Rule paused; `rule` null: any Replay Rule of the profile, each its own Alert. */
  | { kind: 'replayRulePaused'; rule: string | null }
  /** A dead-letter queue has a set-up warning at least this bad; each queue is its own Alert. */
  | { kind: 'setupWarning'; severity: SetupWarningSeverity }
  /** The profile has not been sampled well for this long. */
  | { kind: 'samplingFailing'; forMs: number };

export interface AlertRule {
  /** Unique within the profile. */
  name: string;
  /** Names of Alert Destinations the profiles file declares. */
  destinations: string[];
  when: AlertCondition;
  /** How long the condition must hold before the Alert fires; 0 fires at once. */
  forMs: number;
  /** How often a firing Alert is sent again; null: never. */
  repeatEveryMs: number | null;
}

/** What a rule's checks need to know of the rest of the file. */
export interface AlertRuleContext {
  credentials: 'shared' | 'operatorToken';
  vhosts: 'all' | string[];
  destinations: readonly string[];
  /** The names of the profile's Replay Rules. */
  replayRules: readonly string[];
}

/** Reads a Broker Profile's `alerts`; `where` names the profile in refusals. */
export function parseAlertRules(value: unknown, context: AlertRuleContext, where: string): AlertRule[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ProfilesConfigError(`${where}.alerts must be a list of Alert Rules`);
  const names = new Set<string>();
  return value.map((raw, i) => {
    const at = `${where}.alerts[${i}]`;
    if (!isRecord(raw)) throw new ProfilesConfigError(`${at} must be a mapping`);
    const { name } = raw;
    if (typeof name !== 'string' || name === '') throw new ProfilesConfigError(`${at}.name is required: letters, digits, - and _`);
    if (!NAME.test(name)) throw new ProfilesConfigError(`${at}.name "${name}" may only contain letters, digits, - and _`);
    const named = `${at} ("${name}")`;
    if (names.has(name)) throw new ProfilesConfigError(`${named}.name is used by another Alert Rule of this profile`);
    names.add(name);
    return parseRule(raw, name, context, named);
  });
}

function parseRule(raw: Record<string, unknown>, name: string, context: AlertRuleContext, at: string): AlertRule {
  const fail = (message: string): never => {
    throw new ProfilesConfigError(`${at}${message}`);
  };
  for (const key of Object.keys(raw)) {
    if (!RULE_KEYS.includes(key)) fail(`.${key} is not a key of an Alert Rule`);
  }
  const when = parseCondition(raw.when, context, fail);
  if (when.kind === 'samplingFailing' && raw.for !== undefined) fail('.for does not apply to samplingFailing; give its own: samplingFailing: { for }');
  return {
    name,
    destinations: parseDestinations(raw.destinations, context.destinations, fail),
    when,
    forMs: raw.for === undefined ? 0 : durationWithin(raw.for, SECOND, WEEK) ?? fail('.for must be a duration from 1s to 7d'),
    repeatEveryMs: raw.repeatEvery === undefined ? null : durationWithin(raw.repeatEvery, MINUTE, WEEK) ?? fail('.repeatEvery must be a duration from 1m to 7d'),
  };
}

function parseDestinations(value: unknown, declared: readonly string[], fail: (message: string) => never): string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((d) => typeof d === 'string' && d !== '')) {
    return fail('.destinations must be a non-empty list of Alert Destination names');
  }
  const names = value as string[];
  for (const name of names) {
    if (!declared.includes(name)) fail(`.destinations names "${name}", which alertDestinations does not declare`);
  }
  if (new Set(names).size !== names.length) fail('.destinations names a destination twice');
  return names;
}

function parseCondition(value: unknown, context: AlertRuleContext, fail: (message: string) => never): AlertCondition {
  if (!isRecord(value)) return fail(`.when must be a mapping with one of ${CONDITIONS.join(', ')}`);
  for (const key of Object.keys(value)) {
    if (!WHEN_KEYS.includes(key)) fail(`.when.${key} is not a key of a condition`);
  }
  const given = CONDITIONS.filter((key) => value[key] !== undefined);
  if (given.length !== 1) fail(`.when must have exactly one of ${CONDITIONS.join(', ')}`);
  const condition = given[0]!;
  const own = QUEUE_CONDITIONS.includes(condition) ? SELECTION_KEYS : condition === 'replayRulePaused' ? ['rule'] : [];
  for (const key of [...SELECTION_KEYS, 'rule']) {
    if (value[key] !== undefined && !own.includes(key)) fail(`.when.${key} does not apply to ${condition}`);
  }
  if (condition === 'replayRulePaused') return parseReplayRulePaused(value, context, fail);
  if (context.credentials === 'operatorToken') {
    const what = QUEUE_CONDITIONS.includes(condition) ? 'a queue condition' : condition;
    fail(`.when is ${what} on a profile with credentials: operatorToken, which is not sampled; its profile needs username and passwordEnv`);
  }
  if (condition === 'setupWarning') {
    return SEVERITIES.includes(value.setupWarning as SetupWarningSeverity)
      ? { kind: 'setupWarning', severity: value.setupWarning as SetupWarningSeverity }
      : fail(`.when.setupWarning must be ${SEVERITIES.join(' or ')}`);
  }
  if (condition === 'samplingFailing') return parseSamplingFailing(value.samplingFailing, fail);
  const selection = parseSelection(value, context, fail);
  const whole = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);

  if (value.depthAbove !== undefined) {
    return { kind: 'depthAbove', ...selection, threshold: whole(value.depthAbove) ?? fail('.when.depthAbove must be a whole number, 0 or more') };
  }
  if (value.anyArrival !== undefined) {
    return value.anyArrival === true ? { kind: 'anyArrival', ...selection } : fail('.when.anyArrival must be true');
  }
  const arrivals = value.arrivalsAbove;
  if (!isRecord(arrivals)) return fail('.when.arrivalsAbove must be a mapping with count and within');
  for (const key of Object.keys(arrivals)) {
    if (key !== 'count' && key !== 'within') fail(`.when.arrivalsAbove.${key} is not a key of arrivalsAbove; it takes count and within`);
  }
  return {
    kind: 'arrivalsAbove',
    ...selection,
    count: whole(arrivals.count) ?? fail('.when.arrivalsAbove.count must be a whole number, 0 or more'),
    withinMs: durationWithin(arrivals.within, SECOND, WEEK) ?? fail('.when.arrivalsAbove.within must be a duration from 1s to 7d'),
  };
}

function parseReplayRulePaused(value: Record<string, unknown>, context: AlertRuleContext, fail: (message: string) => never): AlertCondition {
  if (value.replayRulePaused !== true) return fail('.when.replayRulePaused must be true');
  if (context.replayRules.length === 0) return fail('.when.replayRulePaused is on a profile with no Replay Rules');
  const { rule } = value;
  if (rule === undefined) return { kind: 'replayRulePaused', rule: null };
  if (typeof rule !== 'string' || !context.replayRules.includes(rule)) return fail(`.when.rule names "${String(rule)}", which is not a Replay Rule of this profile`);
  return { kind: 'replayRulePaused', rule };
}

function parseSamplingFailing(value: unknown, fail: (message: string) => never): AlertCondition {
  if (!isRecord(value)) return fail('.when.samplingFailing must be a mapping with for');
  for (const key of Object.keys(value)) {
    if (key !== 'for') fail(`.when.samplingFailing.${key} is not a key of samplingFailing; it takes for`);
  }
  return { kind: 'samplingFailing', forMs: durationWithin(value.for, SECOND, WEEK) ?? fail('.when.samplingFailing.for must be a duration from 1s to 7d') };
}

/** The glob has only `*` and `?`; these would match themselves, which is never what such a pattern means. */
const REGEX_LOOKING = /[\^$\\()+|[\]]/;

function parseSelection(value: Record<string, unknown>, context: AlertRuleContext, fail: (message: string) => never): QueueSelection {
  const { vhost, queue, queuePattern } = value;
  if (typeof vhost !== 'string' || vhost === '') return fail('.when.vhost is required and must be a non-empty string');
  if (context.vhosts !== 'all' && !context.vhosts.includes(vhost)) fail(`.when.vhost "${vhost}" is not one of the profile's vhosts`);
  if ((queue === undefined) === (queuePattern === undefined)) fail('.when must have exactly one of queue and queuePattern');
  if (queue !== undefined && (typeof queue !== 'string' || queue === '')) fail('.when.queue must be a non-empty string');
  if (queuePattern !== undefined && (typeof queuePattern !== 'string' || queuePattern.trim() === '')) {
    fail('.when.queuePattern must be a non-empty glob (`*` and `?` wildcards)');
  }
  if (typeof queuePattern === 'string' && REGEX_LOOKING.test(queuePattern)) {
    fail(`.when.queuePattern "${queuePattern}" looks like a regular expression; it is a glob: \`*\` and \`?\` are its only wildcards`);
  }
  return { vhost, queue: (queue as string | undefined) ?? null, queuePattern: (queuePattern as string | undefined) ?? null };
}
