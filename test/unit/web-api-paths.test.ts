// The web app calls the versioned API: /api is an alias for scripts from 0.x, and goes away in a
// major version. A request is written out where it is made, so this reads every one.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const webFiles = readdirSync(path.join(root, 'src/web'), { recursive: true, encoding: 'utf8' }).filter((file) => /\.tsx?$/.test(file));
const callsIn = (text: string) => text.match(/['"`]\/api\/[^'"`\s]*/g) ?? [];

describe('The web app', () => {
  const calls = webFiles.flatMap((file) => callsIn(readFileSync(path.join(root, 'src/web', file), 'utf8')).map((call) => ({ file, call })));

  it('makes its calls, its beacon and its links too, under /api/v1', () => {
    expect(calls.map(({ file }) => file)).toEqual(expect.arrayContaining(['api.ts', 'CheckoutView.tsx', 'MessageList.tsx']));
    expect(calls.filter(({ call }) => !call.slice(1).startsWith('/api/v1/'))).toEqual([]);
  });
});
