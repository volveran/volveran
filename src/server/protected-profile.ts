// The typed confirmation a Protected Profile asks for: the Operator types the
// queue name, and the server checks it, not only the UI. Apply calls it when
// the Checkout's applyConfirmation asks for it (any Decision other than Keep);
// Restore (#10) calls it for every Restore on a Protected Profile.
import { HttpError } from './http-error.js';

export type TypedConfirmationErrorCode = 'queue_name_confirmation_required';

/** 400: the request is missing the queue name typed exactly, on a Protected Profile. */
export class TypedConfirmationError extends HttpError<TypedConfirmationErrorCode> {
  constructor(message: string) {
    super(400, 'queue_name_confirmation_required', message);
    this.name = 'TypedConfirmationError';
  }
}

/** The change being confirmed, as named in the error message. */
export type ConfirmedAction = 'Apply' | 'Restore';

/**
 * Throws TypedConfirmationError unless `body.confirmQueueName` is exactly
 * `queue` (no trimming, case-sensitive). Does nothing on a profile that is not
 * protected. Call it before touching the broker.
 */
export function requireTypedQueueName(
  profile: { name: string; protected: boolean },
  queue: string,
  body: { confirmQueueName?: unknown } | undefined,
  action: ConfirmedAction,
): void {
  if (!profile.protected || body?.confirmQueueName === queue) return;
  throw new TypedConfirmationError(
    `${profile.name} is a Protected Profile: ${action} needs the queue name typed exactly. ` +
      `Send { "confirmQueueName": ${JSON.stringify(queue)} } along with the confirmation.`,
  );
}
