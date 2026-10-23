// Publishing for Apply (Replay, Move) and Restore: a confirm channel on the
// Checkout's (or Restore's) connection, kept separate from the Checkout channel so a publish error
// (e.g. a missing exchange closes the channel) never releases the held
// Messages. Recreated after an error. Publishes are `mandatory`; one at a
// time, so a `return` seen before the confirm belongs to that publish.
import type * as amqp from 'amqplib';
import type { PublishResult } from './types.js';

export class ConfirmPublisher {
  private channel: Promise<amqp.ConfirmChannel> | undefined;
  private returned = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly connection: amqp.ChannelModel) {}

  publish(exchange: string, routingKey: string, content: Buffer, options: amqp.Options.Publish): Promise<PublishResult> {
    const next = this.queue.then(() => this.publishNow(exchange, routingKey, content, options));
    this.queue = next.catch(() => {});
    return next;
  }

  private async publishNow(
    exchange: string,
    routingKey: string,
    content: Buffer,
    options: amqp.Options.Publish,
  ): Promise<PublishResult> {
    let ch: amqp.ConfirmChannel;
    try {
      ch = await this.open();
    } catch (err) {
      return { ok: false, reason: `Cannot open a publish channel: ${(err as Error).message}` };
    }
    this.returned = false;
    const error = await new Promise<Error | null>((resolve) => {
      try {
        ch.publish(exchange, routingKey, content, { ...options, mandatory: true }, (err) => resolve(err ?? null));
      } catch (err) {
        resolve(err as Error);
      }
    });
    if (error) {
      return { ok: false, reason: `The broker did not confirm the publish: ${error.message}` };
    }
    if (this.returned) {
      return {
        ok: false,
        reason: `The broker could not route the Message (exchange "${exchange}", routing key "${routingKey}").`,
      };
    }
    return { ok: true };
  }

  private open(): Promise<amqp.ConfirmChannel> {
    if (!this.channel) {
      const opening = this.connection.createConfirmChannel().then((ch) => {
        ch.on('error', () => {});
        ch.on('close', () => {
          if (this.channel === opening) this.channel = undefined;
        });
        ch.on('return', () => {
          this.returned = true;
        });
        return ch;
      });
      opening.catch(() => {
        if (this.channel === opening) this.channel = undefined;
      });
      this.channel = opening;
    }
    return this.channel;
  }
}
