// Pure (no I/O): which confirmation an Apply needs, and whether a request carries it.
//
// Every Apply needs the Operator's single confirmation. On a Protected Profile,
// an Apply with any Decision other than Keep also needs the queue name typed.

export interface ApplyConfirmation {
  /** The operator must type the queue name (`confirmQueueName`) to Apply. */
  typeQueueName: boolean;
}

export function applyConfirmationFor(input: { protectedProfile: boolean; actionCount: number }): ApplyConfirmation {
  return { typeQueueName: input.protectedProfile && input.actionCount > 0 };
}

export type ConfirmationProblem = 'confirmation_required' | 'queue_name_confirmation_required';

/** Returns what is missing from the request, or null when it confirms the Apply. */
export function confirmationProblem(
  needed: ApplyConfirmation,
  queue: string,
  body: { confirm?: unknown; confirmQueueName?: unknown } | undefined,
): ConfirmationProblem | null {
  if (body?.confirm !== true) return 'confirmation_required';
  if (needed.typeQueueName && body.confirmQueueName !== queue) return 'queue_name_confirmation_required';
  return null;
}
