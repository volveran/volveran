// The default web root: dist/web next to the compiled server, none from source.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { defaultWebRoot } from '../../src/server/web-root.js';

describe('defaultWebRoot', () => {
  it('is dist/web next to the compiled server', () => {
    const main = path.resolve('/app/dist/server/main.js');
    expect(defaultWebRoot(pathToFileURL(main).href)).toBe(path.resolve('/app/dist/web'));
  });

  it('is undefined when the server runs from source, where ../web is the Vite source', () => {
    const main = path.resolve('/repo/src/server/main.ts');
    expect(defaultWebRoot(pathToFileURL(main).href)).toBeUndefined();
  });
});
