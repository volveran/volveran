// Errors from asking for an Apply the server will not carry out as asked.
import { HttpError } from '../http-error.js';

/** #9 adds 'queue_name_confirmation_required' (Protected Profiles). */
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
