// The Prometheus text exposition format, as a scraper reads it.
import { describe, expect, it } from 'vitest';
import { MetricCounter, renderMetrics } from '../../src/server/metrics/exposition.js';

describe('renderMetrics', () => {
  it('writes HELP and TYPE once, then one line per series', () => {
    const text = renderMetrics([
      {
        name: 'volveran_replay_rule_paused',
        help: 'Whether a Replay rule is paused.',
        type: 'gauge',
        series: [
          { labels: { profile: 'prod', rule: 'a' }, value: 1 },
          { labels: { profile: 'prod', rule: 'b' }, value: 0 },
        ],
      },
      { name: 'volveran_checkouts_active', help: 'Active Checkouts.', type: 'gauge', series: [{ value: 3 }] },
    ]);
    expect(text).toBe(
      [
        '# HELP volveran_replay_rule_paused Whether a Replay rule is paused.',
        '# TYPE volveran_replay_rule_paused gauge',
        'volveran_replay_rule_paused{profile="prod",rule="a"} 1',
        'volveran_replay_rule_paused{profile="prod",rule="b"} 0',
        '# HELP volveran_checkouts_active Active Checkouts.',
        '# TYPE volveran_checkouts_active gauge',
        'volveran_checkouts_active 3',
        '',
      ].join('\n'),
    );
  });

  it('escapes backslashes, double quotes and line feeds in label values', () => {
    const text = renderMetrics([
      { name: 'm', help: 'h', type: 'gauge', series: [{ labels: { reason: 'a\\b "c"\nd' }, value: 1 }] },
    ]);
    expect(text).toContain('m{reason="a\\\\b \\"c\\"\\nd"} 1\n');
  });

  it('escapes backslashes and line feeds in HELP, and leaves its double quotes alone', () => {
    expect(renderMetrics([{ name: 'm', help: 'a\\b "c"\nd', type: 'gauge', series: [] }])).toContain('# HELP m a\\\\b "c"\\nd\n');
  });

  it('leaves out a series with no value, and keeps the family\'s HELP and TYPE', () => {
    const text = renderMetrics([
      {
        name: 'm_total',
        help: 'h',
        type: 'counter',
        series: [
          { labels: { queue: 'unknown' }, value: null },
          { labels: { queue: 'not-a-number' }, value: Number.NaN },
          { labels: { queue: 'known' }, value: 0 },
        ],
      },
    ]);
    expect(text).toBe('# HELP m_total h\n# TYPE m_total counter\nm_total{queue="known"} 0\n');
  });
});

describe('MetricCounter', () => {
  it('has no series until counted, then adds up per label set whatever the labels\' order', () => {
    const counter = new MetricCounter('m_total', 'h');
    expect(counter.family()).toEqual({ name: 'm_total', help: 'h', type: 'counter', series: [] });

    counter.inc({ profile: 'p', outcome: 'done' });
    counter.inc({ outcome: 'done', profile: 'p' }, 2);
    counter.inc({ profile: 'p', outcome: 'failed' });

    expect(renderMetrics([counter.family()])).toBe(
      '# HELP m_total h\n# TYPE m_total counter\nm_total{outcome="done",profile="p"} 3\nm_total{outcome="failed",profile="p"} 1\n',
    );
  });
});
