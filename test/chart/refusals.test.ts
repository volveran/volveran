// Values the chart cannot run with are refused at render time, with a message
// naming the value, so the mistake shows up in CI or in Flux's status rather
// than in a crash-looping pod. Each refusal holds with and without the values
// schema, because --skip-schema-validation bypasses the schema.
import { describe, expect, it } from 'vitest';
import { fixtureValues, render, renderRefusal, type Values } from './render.js';

const withAndWithoutSchema = [
  { schema: 'with the values schema', skipSchemaValidation: false },
  { schema: 'with --skip-schema-validation', skipSchemaValidation: true },
];

describe.each(withAndWithoutSchema)('refusals $schema', ({ skipSchemaValidation }) => {
  it.each([0, 2, 3])('refuses replicaCount: %i, citing ADR 0003', (replicaCount) => {
    const message = renderRefusal({ replicaCount }, { skipSchemaValidation });
    expect(message).toContain('replicaCount must be 1');
    expect(message).toContain('docs/adr/0003-single-replica-on-kubernetes.md');
  });

  it.each(['issuer', 'clientId', 'redirectUrl', 'existingSecret'])('refuses a missing oidc.%s', (key) => {
    const values = fixtureValues();
    delete (values['oidc'] as Values)[key];
    expect(renderRefusal(values, { fixture: null, skipSchemaValidation })).toContain(`oidc.${key} is required`);
  });

  it.each(['issuer', 'clientId', 'redirectUrl', 'existingSecret'])('refuses an empty oidc.%s', (key) => {
    expect(renderRefusal({ oidc: { [key]: '' } }, { skipSchemaValidation })).toContain(`oidc.${key} is required`);
  });

  it('refuses an install without any Broker Profile', () => {
    expect(renderRefusal({ brokerProfiles: { profiles: [] } }, { skipSchemaValidation })).toContain(
      'brokerProfiles.profiles must list at least one Broker Profile',
    );
  });
});

describe('refusals', () => {
  it('refuses the chart defaults alone, which have no OIDC settings', () => {
    expect(renderRefusal({}, { fixture: null })).toContain('oidc.issuer is required');
  });

  it('accepts replicaCount: 1', () => {
    expect(render({ replicaCount: 1 }).one('Deployment').spec.replicas).toBe(1);
  });

  it('has no Solo Mode value', () => {
    expect(renderRefusal({ auth: 'none' })).toMatch(/auth/);
    expect(renderRefusal({ oidc: { enabled: false } })).toMatch(/enabled/);
  });
});
