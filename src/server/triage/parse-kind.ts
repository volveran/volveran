// Pure input parsing (no I/O): the `kind` of a tagged value read from an API
// request body (a Decision, a filter clause).

/**
 * Reads `input.kind` as one of `kinds`; `noun` names the value in the error
 * ("Decision", "filter clause").
 */
export function parseKind<K extends string>(
  input: unknown,
  kinds: readonly K[],
  noun: string,
): { ok: true; kind: K } | { ok: false; error: string } {
  const kind = typeof input === 'object' && input !== null ? (input as { kind?: unknown }).kind : undefined;
  const choices = `use one of ${kinds.join(', ')}.`;
  if (typeof kind !== 'string') return { ok: false, error: `A ${noun} needs a "kind"; ${choices}` };
  if (!(kinds as readonly string[]).includes(kind)) return { ok: false, error: `"${kind}" is not a ${noun}; ${choices}` };
  return { ok: true, kind: kind as K };
}
