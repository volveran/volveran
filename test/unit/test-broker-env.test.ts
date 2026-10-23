// The test broker's compose project name and host ports, so brokers of
// several worktrees run side by side without clashing.
import { describe, expect, it } from 'vitest';
import { testBrokerSettings } from '../../scripts/test-broker-env.mjs';

describe('test broker settings', () => {
  it('names the compose project after the checkout, so two worktrees get different brokers', () => {
    const a = testBrokerSettings('/home/me/volveran/.claude/worktrees/ticket-1', {});
    const b = testBrokerSettings('/home/me/volveran/.claude/worktrees/ticket-2', {});
    expect(a.project).toMatch(/^volveran-test-ticket-1-[0-9a-f]{8}$/);
    expect(b.project).toMatch(/^volveran-test-ticket-2-[0-9a-f]{8}$/);
  });

  it('gives the same checkout the same project name every time', () => {
    const root = '/home/me/volveran';
    expect(testBrokerSettings(root, {}).project).toBe(testBrokerSettings(root, {}).project);
  });

  it('gives same-named checkouts in different places different project names', () => {
    expect(testBrokerSettings('/a/volveran', {}).project).not.toBe(testBrokerSettings('/b/volveran', {}).project);
  });

  it('keeps project names valid for docker compose', () => {
    expect(testBrokerSettings('/tmp/My Checkout.v2', {}).project).toMatch(/^volveran-test-my-checkout-v2-[0-9a-f]{8}$/);
  });

  it('leaves host ports to Docker (random free ports) unless they are set', () => {
    expect(testBrokerSettings('/x', {})).toMatchObject({ amqpPort: undefined, mgmtPort: undefined });
  });

  it('honours VOLVERAN_TEST_* overrides', () => {
    const settings = testBrokerSettings('/x', {
      VOLVERAN_TEST_PROJECT: 'mine',
      VOLVERAN_TEST_AMQP_PORT: '5673',
      VOLVERAN_TEST_MGMT_PORT: '15673',
    });
    expect(settings).toEqual({ project: 'mine', amqpPort: '5673', mgmtPort: '15673' });
  });
});
