// Work that must not interleave, one key at a time (ADR 0013: a store call is an
// interleave point). Each key's work runs in the order asked for, whether the
// work before it succeeded or failed; different keys do not wait for each other.
export class OneAtATime {
  private readonly lasts = new Map<string, Promise<void>>();

  /** Runs `work` once everything asked for `key` before it has settled, and answers as `work` does. Do not ask for the same key from inside `work`. */
  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const result = (this.lasts.get(key) ?? Promise.resolve()).then(work);
    const last = result.then(
      () => {},
      () => {},
    );
    this.lasts.set(key, last);
    // `last` never rejects, and nobody waits for this tidying up.
    void last.then(() => {
      if (this.lasts.get(key) === last) this.lasts.delete(key);
    });
    return result;
  }

  /** Resolves when nothing is left to run. */
  async settled(): Promise<void> {
    while (this.lasts.size > 0) await Promise.all(this.lasts.values());
  }
}
