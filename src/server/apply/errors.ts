// Errors from asking for an Apply the server will not carry out as asked.
import { HttpError } from '../http-error.js';

/** A missing typed queue name on a Protected Profile is a TypedConfirmationError (protected-profile.ts), shared with Restore. */
export type ApplyErrorCode = 'confirmation_required' | 'rate_above_maximum' | 'canary_needs_replay' | 'canary_required';

const STATUS: Record<ApplyErrorCode, number> = {
  confirmation_required: 400,
  rate_above_maximum: 400,
  canary_needs_replay: 400,
  canary_required: 400,
};

export class ApplyError extends HttpError<ApplyErrorCode> {
  constructor(code: ApplyErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(STATUS[code], code, message, details);
    this.name = 'ApplyError';
  }
}

/** The Replay Rate asked for (or none: as fast as the broker confirms) is above the Broker Profile's `replayRate.max`. */
export function rateAboveMaximum(profile: string, max: number, requested: number | null): ApplyError {
  const asked = requested === null ? 'With no Replay Rate the Apply would run as fast as the broker confirms, which is' : `${requested} Messages per second is`;
  return new ApplyError(
    'rate_above_maximum',
    `${asked} above the maximum Replay Rate of Broker Profile "${profile}": ${max} Messages per second. Choose a rate of at most ${max}.`,
    { max },
  );
}

/** A Canary was asked for, but no Message of the Apply has the Decision Replay. */
export function canaryNeedsReplay(): ApplyError {
  return new ApplyError(
    'canary_needs_replay',
    'A Canary is one Replay carried out alone before the rest, but this Apply has no Message with the Decision Replay. Leave out "canary", or give a Message the Decision Replay.',
  );
}

/** The Apply has more Replays than the Broker Profile's `canary.requiredAbove` allows without a Canary. */
export function canaryRequired(profile: string, requiredAbove: number, replays: number): ApplyError {
  return new ApplyError(
    'canary_required',
    `Broker Profile "${profile}" requires a Canary for an Apply with more than ${requiredAbove} Replays, and this one has ${replays}. Start it with a Canary ("canary": true or { "handle": <Message handle> }).`,
    { requiredAbove },
  );
}
