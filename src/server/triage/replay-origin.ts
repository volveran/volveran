// Pure (no I/O): where Replay sends a Message (ADR 0005, amended by ADR
// 0010): through the default exchange to the queue that dead-lettered it.
// That is the queue of its most recent x-death entry; without x-death, the
// MassTransit input queue its Failure Details name, unless MassTransit
// skipped it (no consumer handled its type). Anything else has nowhere to be
// Replayed to. A Spring AMQP Message names only the exchange and routing key
// it was first published with: the reason says so, and those are suggested
// as an explicit Move instead (a Move to the queue, when it was sent through
// the default exchange).
import type { MoveDestination } from '../../shared/decisions.js';
import { failureDetails } from './failure-details.js';
import { parseXDeath } from './message-view.js';

export type ReplayOrigin =
  | { ok: true; queue: string; via: 'x-death' | 'masstransit' }
  | { ok: false; reason: string; suggestedMove?: MoveDestination };

export function replayOrigin(headers: Record<string, unknown> | undefined): ReplayOrigin {
  const latest = parseXDeath(headers)[0];
  if (latest) {
    if (latest.queue === null || latest.queue === '') {
      return {
        ok: false,
        reason: 'The most recent x-death entry of this Message names no queue, so there is nowhere to Replay it to. Move it instead.',
      };
    }
    return { ok: true, queue: latest.queue, via: 'x-death' };
  }
  const details = failureDetails(headers);
  if (details?.framework === 'masstransit') {
    if (details.reason === 'skip') {
      return {
        ok: false,
        reason: 'MassTransit skipped this Message: no consumer handled this Message type, so Replaying it would only skip it again. Move it instead.',
      };
    }
    if (details.inputQueue === null) {
      return {
        ok: false,
        reason: 'The MassTransit input address of this Message is missing or names no queue, so there is nowhere to Replay it to. Move it instead.',
      };
    }
    return { ok: true, queue: details.inputQueue, via: 'masstransit' };
  }
  if (details?.framework === 'spring') {
    const { originalExchange: exchange, originalRoutingKey: routingKey } = details;
    if (exchange === null) {
      return {
        ok: false,
        reason: 'Spring AMQP does not record the queue that failed this Message, so there is no queue to Replay it to. Move it instead.',
      };
    }
    const key = routingKey ?? '';
    if (exchange === '') {
      return {
        ok: false,
        reason: `Spring AMQP does not record the queue that failed this Message, only that it was first published through the default exchange with the routing key "${key}". Move it to that queue if it is the one to send it back to.`,
        ...(key !== '' && { suggestedMove: { queue: key } }),
      };
    }
    return {
      ok: false,
      reason: `Spring AMQP does not record the queue that failed this Message, only that it was first published to the exchange "${exchange}" with the routing key "${key}". Replay never re-routes through an exchange: Move it there if every queue bound to it should get it again.`,
      suggestedMove: { exchange, routingKey: key },
    };
  }
  return {
    ok: false,
    reason: 'This Message has no x-death history, so there is no queue it was dead-lettered from to Replay it to. Move it instead.',
  };
}
