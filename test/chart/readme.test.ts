// The chart's README documents every value the values schema accepts, in its
// "Values" table, so a new value cannot ship undocumented.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chartDir } from './render.js';

interface SchemaNode {
  properties?: Record<string, SchemaNode>;
}

const readme = readFileSync(path.join(chartDir, 'README.md'), 'utf8');
const schema = JSON.parse(readFileSync(path.join(chartDir, 'values.schema.json'), 'utf8')) as SchemaNode;

/** Dotted paths of the schema's leaf values (an object without listed properties counts as one value). */
function valuePaths(node: SchemaNode, prefix = ''): string[] {
  return Object.entries(node.properties ?? {}).flatMap(([key, child]) =>
    child.properties ? valuePaths(child, `${prefix}${key}.`) : [`${prefix}${key}`],
  );
}

/** The first column of each row of the README's values table. */
const documented = [...readme.matchAll(/^\| `([\w.]+)` \|/gm)].map((m) => m[1]);

describe('chart README', () => {
  it.each(valuePaths(schema).filter((p) => p !== 'global'))('documents %s', (value) => {
    expect(documented).toContain(value);
  });

  it('documents no value the schema does not accept', () => {
    expect(documented.filter((value) => !valuePaths(schema).includes(value!))).toEqual([]);
  });
});
