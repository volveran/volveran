// Wire types (no code) of a Message filter on a Checkout: the server parses
// and evaluates it (src/server/triage/filters.ts), the web app builds it.

export type FilterClause =
  /** The routing key matches this glob (`*` and `?` wildcards). */
  | { kind: 'routing-key'; value: string }
  /** The header is present; with `value`, its scalar value as text matches this glob (equal when it has no wildcards). */
  | { kind: 'header'; name: string; value?: string | undefined }
  /** Any `x-death` entry has exactly this reason. */
  | { kind: 'x-death-reason'; value: string }
  /** The original queue (the most recent `x-death` entry's, as the list shows it) matches this glob. */
  | { kind: 'original-queue'; value: string }
  /** Case-insensitive substring of the body as sent (UTF-8, not compressed). */
  | { kind: 'body-text'; value: string }
  /**
   * The body parses as JSON and the path reaches a value: any value when
   * `value` is left out, otherwise a scalar whose text is exactly `value`.
   */
  | { kind: 'json-path'; path: string; value?: string | undefined }
  /** The Message is Died Again: it carries an `x-volveran-replay-id`. */
  | { kind: 'died-again' };

/** Every clause must match (AND). An empty filter matches every Message. */
export type Filter = FilterClause[];
