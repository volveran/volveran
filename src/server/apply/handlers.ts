// One handler per Decision kind (Keep needs none: Apply leaves the Message
// held and ending the Checkout returns it).
//
// A kind missing here cannot be carried out by this version: the executor
// reports its Messages as not attempted (they go back to the queue) and
// Applies the rest. #8 plugs in `move`.
import type { ActionDecision } from '../triage/decisions.js';
import { discard } from './discard.js';
import { replay } from './replay.js';
import type { DecisionHandler } from './types.js';

type Handlers = { [K in ActionDecision['kind']]?: DecisionHandler<Extract<ActionDecision, { kind: K }>> };

const handlers: Handlers = {
  discard,
  replay,
};

/** The handler of `decision`'s kind, or null when this version cannot carry it out. */
export function handlerFor<D extends ActionDecision>(decision: D): DecisionHandler<D> | null {
  return (handlers[decision.kind] as DecisionHandler<D> | undefined) ?? null;
}
