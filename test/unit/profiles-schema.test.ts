// The published JSON Schema of the profiles file against the parser, on the
// shared fixtures in test/fixtures/profiles-schema/. The parser is the authority:
// the schema must never refuse a file the parser reads, and may accept a file the
// parser refuses only for what a schema cannot see (parser-only/).
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { parseProfilesFile, PROFILE_KEYS, TOP_LEVEL_KEYS } from '../../src/server/profiles.js';
import { upgradeFixtures } from '../support/upgrade-fixtures.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixtures = path.join(root, 'test/fixtures/profiles-schema');
const schema = JSON.parse(readFileSync(path.join(root, 'profiles.schema.json'), 'utf8')) as Record<string, unknown>;
const validate = new Ajv2020({ allErrors: true, strictTypes: false }).compile(schema);

const env = {
  DESTINATION_URL: 'https://example.com/hook',
  DESTINATION_SECRET: 'secret',
  VOLVERAN_FIXTURE_WEBHOOK_URL: 'https://example.com/hook',
};

const parserRefusal = (text: string, variables: Record<string, string> = env): string | null => {
  try {
    parseProfilesFile(text, variables, 'file');
    return null;
  } catch (err) {
    return (err as Error).message;
  }
};
const schemaAccepts = (text: string) => validate(parse(text));
const schemaErrors = () => JSON.stringify(validate.errors);

const dirFixtures = (dir: string): Array<[string, string]> =>
  readdirSync(path.join(fixtures, dir))
    .sort()
    .map((name) => [name, readFileSync(path.join(fixtures, dir, name), 'utf8')]);

describe('the schema and the parser agree', () => {
  it.each(dirFixtures('accepted'))('both accept accepted/%s', (_name, text) => {
    expect(parserRefusal(text)).toBeNull();
    expect(schemaAccepts(text), schemaErrors()).toBe(true);
  });

  it.each(dirFixtures('refused'))('both refuse refused/%s', (_name, text) => {
    expect(parserRefusal(text)).not.toBeNull();
    expect(schemaAccepts(text)).toBe(false);
  });

  it.each(upgradeFixtures.map((f) => f.version))('both accept the profiles file of release %s', (version) => {
    const text = readFileSync(path.join(root, 'test/fixtures/upgrade', version, 'profiles.yaml'), 'utf8');
    expect(parserRefusal(text)).toBeNull();
    expect(schemaAccepts(text), schemaErrors()).toBe(true);
  });

  it('both accept profiles.example.yaml', () => {
    const text = readFileSync(path.join(root, 'profiles.example.yaml'), 'utf8');
    const variables = Object.fromEntries([...text.matchAll(/\b\w+Env: (\w+)/g)].map((m) => [m[1]!, 'https://example.com/hook']));
    expect(parserRefusal(text, variables)).toBeNull();
    expect(schemaAccepts(text), schemaErrors()).toBe(true);
  });
});

describe('the parser stays the authority', () => {
  it.each(dirFixtures('parser-only'))('the parser alone refuses parser-only/%s', (_name, text) => {
    expect(parserRefusal(text)).not.toBeNull();
    expect(schemaAccepts(text), schemaErrors()).toBe(true);
  });
});

/** Every mapping in a YAML document, with the path the parser's refusals use. */
function mappings(value: unknown, at: string): Array<{ mapping: Record<string, unknown>; at: string }> {
  if (Array.isArray(value)) return value.flatMap((item, i) => mappings(item, `${at}[${i}]`));
  if (typeof value !== 'object' || value === null) return [];
  const mapping = value as Record<string, unknown>;
  return [
    { mapping, at },
    ...Object.entries(mapping).flatMap(([key, child]) => mappings(child, at === '' ? key : `${at}.${key}`)),
  ];
}

describe('unknown keys at every level', () => {
  const text = readFileSync(path.join(fixtures, 'accepted/every-key.yaml'), 'utf8');
  const paths = mappings(parse(text), '').map((m) => m.at);

  it('reaches the deep levels', () => {
    expect(paths).toContain('');
    expect(paths).toContain('profiles[0].replayRules[1].filter[5]');
    expect(paths).toContain('profiles[0].replayRules[0].whenAttemptsUsedUp.moveTo');
    expect(paths).toContain('profiles[0].alerts[1].when.arrivalsAbove');
    expect(paths).toContain('alertDestinations[1]');
  });

  it.each(paths)('both refuse one in the mapping at "%s", and the parser names its path', (at) => {
    const doc = parse(text) as unknown;
    mappings(doc, '').find((m) => m.at === at)!.mapping.notAKey = true;
    const withKey = stringify(doc);
    const refusal = parserRefusal(withKey);
    // Refusals name a list item by position and by name: profiles[0] ("shared").
    expect(refusal?.replace(/ \("[^"]*"\)/g, '')).toContain(at === '' ? 'file: notAKey' : `${at}.notAKey`);
    expect(schemaAccepts(withKey)).toBe(false);
  });

  it('every-key.yaml uses every key the parser takes at the top and on a Broker Profile, so one added to the parser alone fails', () => {
    const doc = parse(text) as { profiles: Array<Record<string, unknown>> } & Record<string, unknown>;
    expect(TOP_LEVEL_KEYS.filter((key) => !(key in doc))).toEqual([]);
    const used = new Set(doc.profiles.flatMap((profile) => Object.keys(profile)));
    expect(PROFILE_KEYS.filter((key) => !used.has(key))).toEqual([]);
  });

  it('every-key.yaml uses every key the schema names, so all of them are tried', () => {
    const named = new Set<string>();
    const collect = (node: unknown): void => {
      if (Array.isArray(node)) node.forEach(collect);
      else if (typeof node === 'object' && node !== null) {
        for (const [key, child] of Object.entries(node)) {
          if (key === 'properties') Object.keys(child as object).forEach((k) => named.add(k));
          collect(child);
        }
      }
    };
    collect(schema);
    const used = new Set(mappings(parse(text), '').flatMap((m) => Object.keys(m.mapping)));
    expect([...named].filter((key) => !used.has(key))).toEqual([]);
  });
});
