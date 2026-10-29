// Errors from asking for an Apply the server will not carry out as asked.
import { HttpError } from '../http-error.js';

/** A missing typed queue name on a Protected Profile is a TypedConfirmationError (protected-profile.ts), shared with Restore. */
export type ApplyErrorCode = 'confirmation_required' | 'rate_above_maximum';

const STATUS: Record<ApplyErrorCode, number> = {
  confirmation_required: 400,
  rate_above_maximum: 400,
};

export class ApplyError extends HttpError<ApplyErrorCode> {
  constructor(code: ApplyErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(STATUS[code], code, message, details);
    this.name = 'ApplyError';
  }
}

/** The Replay Rate asked for (or none, unthrottled) is above the Broker Profile's `replayRate.max`. */
export function rateAboveMaximum(profile: string, max: number, requested: number | null): ApplyError {
  const asked = requested === null ? 'Without a rate the Apply would run unthrottled, which is' : `${requested} Messages per second is`;
  return new ApplyError(
    'rate_above_maximum',
    `${asked} above the maximum Replay Rate of Broker Profile "${profile}": ${max} Messages per second. Choose a rate of at most ${max}.`,
    { max },
  );
}
