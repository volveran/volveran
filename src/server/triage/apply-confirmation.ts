// Pure (no I/O): which confirmation an Apply needs, and whether a request carries it.
//
// Every Apply needs the Operator's single confirmation. On a Protected Profile,
// an Apply with any Decision other than Keep also needs the queue name typed,
// and, when the profile requires Approval (Team Mode), a second Operator's
// Approval.
import type { ApplyConfirmation } from '../../shared/checkout.js';

/** What an Apply needs confirmed, beyond its Replay Rate (checkout/view.ts adds that). */
export type ConfirmationNeeded = Pick<ApplyConfirmation, 'typeQueueName' | 'approvalRequired'>;

export function applyConfirmationFor(input: {
  protectedProfile: boolean;
  /** Team Mode and the profile's `requireApproval`. */
  requireApproval: boolean;
  actionCount: number;
}): ConfirmationNeeded {
  const changes = input.actionCount > 0;
  return {
    typeQueueName: input.protectedProfile && changes,
    approvalRequired: input.protectedProfile && input.requireApproval && changes,
  };
}

export type ConfirmationProblem = 'confirmation_required' | 'queue_name_confirmation_required';

/** Returns what is missing from the request, or null when it confirms the Apply. */
export function confirmationProblem(
  needed: ConfirmationNeeded,
  queue: string,
  body: { confirm?: unknown; confirmQueueName?: unknown } | undefined,
): ConfirmationProblem | null {
  if (body?.confirm !== true) return 'confirmation_required';
  if (needed.typeQueueName && body.confirmQueueName !== queue) return 'queue_name_confirmation_required';
  return null;
}
