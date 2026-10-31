// What the metrics show from the audit store. A scrape must not wait on the store,
// so these values are read in the background and a scrape takes the last reading:
// every interval, and when something that changes them has just happened. A failed
// reading is reported and the last one stays.
export interface StoreReadingsOptions<T> {
  read(): Promise<T>;
  intervalMs: number;
  onError(err: unknown): void;
}

export class StoreReadings<T> {
  private last: T | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  /** The reading that starts when the one running ends, for those who asked during it. */
  private next: Promise<void> | null = null;
  private started = false;

  constructor(private readonly options: StoreReadingsOptions<T>) {}

  /** The last reading; null until one has succeeded. Touches nothing but memory. */
  current(): T | null {
    return this.last;
  }

  /** Takes the first reading, then keeps reading. Until this is called nobody scrapes, so nothing is read. */
  async start(): Promise<void> {
    this.started = true;
    await this.refresh();
    if (!this.started) return;
    this.timer = setInterval(() => void this.refresh(), this.options.intervalMs);
    this.timer.unref();
  }

  /** Resolves after a reading that began after this call has ended; never rejects. Does nothing unless started. */
  refresh(): Promise<void> {
    if (!this.started) return Promise.resolve();
    if (!this.running) return this.begin();
    // The one running may have read too early for this caller.
    this.next ??= this.running.then(() => {
      this.next = null;
      return this.started ? this.begin() : undefined;
    });
    return this.next;
  }

  /** No reading starts after this, and the one in progress has ended when it resolves. Call before the audit store closes. */
  async stop(): Promise<void> {
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.next;
    await this.running;
  }

  private begin(): Promise<void> {
    const running = this.options
      .read()
      .then((value) => {
        this.last = value;
      })
      .catch((err) => {
        this.options.onError(err);
      })
      .finally(() => {
        this.running = null;
      });
    this.running = running;
    return running;
  }
}
