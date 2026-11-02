// Links into the web app's depth history and Audit view: they travel in the
// URL fragment, which survives sign-in (returnTo keeps it).
import { describe, expect, it } from 'vitest';
import { auditSearchIn, auditViewPath, deadLetterMapPath, deadLetterMapTargetIn, historyPath, historyTargetIn } from '../../src/shared/history-link.js';

describe('historyPath', () => {
  it('is a root-relative link to the queue history, with each part escaped', () => {
    expect(historyPath({ profile: 'prod', vhost: '/', queue: 'orders.dlq' })).toBe('/#/history/prod/%2F/orders.dlq');
    expect(historyPath({ profile: 'a b', vhost: 'x/y', queue: 'q#1' })).toBe('/#/history/a%20b/x%2Fy/q%231');
  });

  it('is read back from the fragment', () => {
    const target = { profile: 'a b', vhost: '/', queue: 'orders/dlq?#' };
    const hash = historyPath(target).slice(1);
    expect(historyTargetIn(hash)).toEqual(target);
  });

  it('reads nothing from another fragment', () => {
    for (const hash of ['', '#/approvals/abc', '#/history/', '#/history/prod/%2F', '#/history/prod/%2F/q/extra', '#/history/prod/%2F/%E0%A4%A']) {
      expect(historyTargetIn(hash)).toBeNull();
    }
  });
});

describe('auditViewPath', () => {
  const auditUrl = '/api/v1/audit-entries?profile=prod&queue=orders.dlq&checkoutId=abc-1';

  it('turns the API search of a mark into a link to the Audit view', () => {
    expect(auditViewPath(auditUrl)).toBe('/#/audit?profile=prod&queue=orders.dlq&checkoutId=abc-1');
  });

  it('is read back as the search the Audit view fills in', () => {
    expect(auditSearchIn(auditViewPath(auditUrl).slice(1))).toEqual({ profile: 'prod', queue: 'orders.dlq', checkoutId: 'abc-1' });
  });

  it('reads back escaped values', () => {
    const escaped = `/api/v1/audit-entries?${new URLSearchParams({ profile: 'a b', queue: 'q&1' })}`;
    expect(auditSearchIn(auditViewPath(escaped).slice(1))).toEqual({ profile: 'a b', queue: 'q&1' });
  });

  it('ignores fields the Audit view does not search on, and other fragments', () => {
    expect(auditSearchIn('#/audit?queue=q&nonsense=1')).toEqual({ queue: 'q' });
    expect(auditSearchIn('#/approvals/abc')).toBeNull();
    expect(auditSearchIn('')).toBeNull();
  });
});

describe('the Dead-letter Map link', () => {
  it('survives names with slashes and spaces, and the default vhost', () => {
    const target = { profile: 'staging eu', vhost: '/' };
    const path = deadLetterMapPath(target);
    expect(path).toBe('/#/dead-letter-map/staging%20eu/%2F');
    expect(deadLetterMapTargetIn(path.slice(1))).toEqual(target);
  });

  it('is not any other fragment', () => {
    expect(deadLetterMapTargetIn('#/history/a/b/c')).toBeNull();
    expect(deadLetterMapTargetIn('#/dead-letter-map/only-profile')).toBeNull();
    expect(deadLetterMapTargetIn('#/dead-letter-map/%E0%A4%A/x')).toBeNull();
  });
});
