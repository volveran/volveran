// Errors from asking for a Replay Rule, or a change to one, the server cannot carry out.
import { HttpError } from '../http-error.js';

export type ReplayRuleErrorCode = 'replay_rule_not_found' | 'replay_rule_paused' | 'replay_rule_running';

const STATUS: Record<ReplayRuleErrorCode, number> = {
  replay_rule_not_found: 404,
  replay_rule_paused: 409,
  replay_rule_running: 409,
};

export class ReplayRuleError extends HttpError<ReplayRuleErrorCode> {
  constructor(code: ReplayRuleErrorCode, message: string) {
    super(STATUS[code], code, message);
    this.name = 'ReplayRuleError';
  }
}

/** The Broker Profile declares no Replay Rule of this name. */
export function replayRuleNotFound(profile: string, name: string): ReplayRuleError {
  return new ReplayRuleError('replay_rule_not_found', `Broker Profile "${profile}" has no Replay rule named "${name}".`);
}

/** A pause of a rule that is paused already. */
export function replayRulePaused(profile: string, name: string): ReplayRuleError {
  return new ReplayRuleError('replay_rule_paused', `Replay rule "${name}" of Broker Profile "${profile}" is paused already.`);
}

/** A resume of a rule that is not paused. */
export function replayRuleRunning(profile: string, name: string): ReplayRuleError {
  return new ReplayRuleError('replay_rule_running', `Replay rule "${name}" of Broker Profile "${profile}" is not paused.`);
}
