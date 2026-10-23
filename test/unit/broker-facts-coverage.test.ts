// Every fact in docs/rabbitmq-behaviour.md (each bullet, and each row of the
// delivery-counting table) is named, word for word, by a test in
// test/broker-facts/, so a new fact cannot be added without a test.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const doc = readFileSync(path.join(root, 'docs/rabbitmq-behaviour.md'), 'utf8');
const factsDir = path.join(root, 'test/broker-facts');
const tests = readdirSync(factsDir)
  .filter((f) => f.endsWith('.test.ts'))
  .map((f) => readFileSync(path.join(factsDir, f), 'utf8'))
  .join('\n')
  // Test names are single-quoted TypeScript strings.
  .replace(/\\'/g, "'");

/** `## Section` → its facts: bullets, and the first cell of table rows. */
function factsBySection(markdown: string): Array<{ section: string; fact: string }> {
  const out: Array<{ section: string; fact: string }> = [];
  let section = '';
  for (const line of markdown.split('\n')) {
    const heading = /^## (.+)$/.exec(line);
    if (heading) section = heading[1]!.trim();
    if (!section) continue;
    const bullet = /^- (.+)$/.exec(line);
    if (bullet) out.push({ section, fact: bullet[1]!.trim() });
    const row = /^\| (.+?) \| .+ \|$/.exec(line);
    if (row && !/^-+$/.test(row[1]!) && !row[1]!.startsWith('How the Message')) out.push({ section, fact: row[1]!.trim() });
  }
  return out;
}

describe('broker-facts coverage of docs/rabbitmq-behaviour.md', () => {
  const facts = factsBySection(doc);

  it('finds the facts in the document', () => {
    expect(facts.length).toBeGreaterThan(20);
  });

  it.each(facts)('$section: "$fact" is named by a broker-facts test', ({ section, fact }) => {
    expect(tests).toContain(`'${section}'`);
    expect(tests).toContain(fact);
  });
});
