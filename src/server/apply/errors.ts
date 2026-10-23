// Errors from asking for an Apply the server will not carry out as asked.
import { HttpError } from '../http-error.js';

/** A missing typed queue name on a Protected Profile is a TypedConfirmationError (protected-profile.ts), shared with Restore. */
export type ApplyErrorCode = 'confirmation_required';

const STATUS: Record<ApplyErrorCode, number> = {
  confirmation_required: 400,
};

export class ApplyError extends HttpError<ApplyErrorCode> {
  constructor(code: ApplyErrorCode, message: string) {
    super(STATUS[code], code, message);
    this.name = 'ApplyError';
  }
}
