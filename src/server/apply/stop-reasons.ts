// Why an Apply attempts no further step: the reason recorded for every step
// it did not reach (`not-attempted`), one per thing that can stop it. Each
// says the Message is back in the queue, which the Checkout's end sees to.

export const STOP_REASONS = {
  /** The Checkout stopped being active (a Lost Checkout: the broker has put its Messages back). */
  checkoutNotActive: 'The Checkout stopped being active before this Message; it is back in the queue.',
  /** The Checkout reached its time limit. */
  timeLimit: 'The Checkout reached its time limit before this Message; it is back in the queue.',
  /** An Operator (the owner, or the approver of an approved Apply) stopped it; `name` is their display name. */
  stoppedBy: (name: string) => `Stopped by ${name} before this Message; it is back in the queue.`,
  /** The Replica running it is shutting down. */
  replicaShutDown: 'The Replica shut down before this Message; it is back in the queue.',
  /** The audit store failed a write, so no further Message can have its Audit Entry first (ADR 0001). */
  auditStoreFailed: 'The audit store could not be written before this Message; it is back in the queue.',
  /** The Checkout ended (no heartbeat, the owner, shutdown) while the Apply waited after its Canary. */
  checkoutEndedWhileWaiting: 'The Checkout ended while the Apply waited after its Canary; this Message is back in the queue.',
} as const;
