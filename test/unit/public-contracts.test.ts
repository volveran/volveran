// A public contract cannot change without being recorded (docs/compatibility.md, ADR 0015). The
// record is written by hand: seeing it change in a diff is the point. A failure here asks a
// question, not for the record to be updated: within 1.x a contract may only gain optional things.
// Anything else needs a major version, after a deprecation.
import { beforeAll, describe, expect, it } from 'vitest';
import { nonAdditive } from '../support/additive-migrations.js';
import { currentContracts, fieldPaths, metricNamesInSource, readRecordedContracts, schemaKeys, storeMigrations, xVolveranHeadersInSource } from '../support/public-contracts.js';

const ASK = 'A public contract changed. If it only gains something optional, record it in test/fixtures/public-contracts.json and the changelog. If it loses or changes something, that needs a major version (docs/compatibility.md).';

describe('The public contracts', () => {
  const recorded = readRecordedContracts();
  let current: Awaited<ReturnType<typeof currentContracts>>;

  beforeAll(async () => {
    current = await currentContracts(recorded);
  });

  it.each(['metrics', 'environmentVariables', 'chartValues', 'httpApi', 'profilesFile', 'webhook', 'ndjsonExport'] as const)('%s are as recorded', (contract) => {
    expect(current[contract], ASK).toEqual(recorded[contract]);
  });

  it('name every metric the metrics modules write', () => {
    expect(Object.keys(current.metrics as object).sort(), ASK).toEqual(metricNamesInSource());
  });

  it('name every x-volveran header the product writes, by who it is for', () => {
    expect(Object.values(recorded.xVolveranHeaders as Record<string, string[]>).flat().sort(), ASK).toEqual(xVolveranHeadersInSource());
  });
});

describe('The audit store migrations', () => {
  const recorded = readRecordedContracts();

  it.each(['sqlite', 'postgres'] as const)('of %s up to the 1.0 baseline are as recorded', async (store) => {
    const { auditSchemaBaseline } = await currentContracts(recorded);
    expect(auditSchemaBaseline[store], 'Migrations are append-only: add a new one, never change one that has shipped.').toEqual(recorded.auditSchemaBaseline[store]);
  });

  it.each(['sqlite', 'postgres'] as const)('of %s after the 1.0 baseline only add', (store) => {
    expect(nonAdditive(storeMigrations[store], recorded.auditSchemaBaseline[store].version)).toEqual([]);
  });

  it.each(['sqlite', 'postgres'] as const)('of %s are checked from a baseline they have reached', (store) => {
    expect(storeMigrations[store].length).toBeGreaterThanOrEqual(recorded.auditSchemaBaseline[store].version);
    expect(recorded.auditSchemaBaseline[store].version).toBeGreaterThan(0);
  });
});

describe('Reading a contract', () => {
  it('lists the fields of a value as paths', () => {
    expect(fieldPaths({ a: 1, b: { c: null, d: [] }, e: [{ f: 1 }, { g: 2 }], h: {} })).toEqual(['a', 'b.c', 'b.d', 'e[].f', 'e[].g', 'h']);
  });

  it('lists the keys of a schema through references, without going round for ever', () => {
    const schema = {
      properties: {
        a: { type: 'string' },
        b: { $ref: '#/$defs/node' },
        c: { type: 'array', items: { properties: { d: {} } } },
        e: { type: 'object', additionalProperties: { properties: { f: {} } } },
      },
      $defs: { node: { properties: { g: {}, self: { $ref: '#/$defs/node' } } } },
    };
    expect(schemaKeys(schema).sort()).toEqual(['a', 'b.g', 'b.self', 'c[].d', 'e.*.f']);
  });
});
