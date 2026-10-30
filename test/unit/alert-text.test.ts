// How the web app words an Alert, an Alert Rule's condition and a delivery.
import { describe, expect, it } from 'vitest';
import { alertPlaceText, alertValueText, deliveryText, ruleConditionText } from '../../src/shared/alerts.js';

const delivery = { outcome: 'delivered', httpStatus: 200, error: null, attempts: 1 } as const;

describe('alertPlaceText', () => {
  it('names the queue and vhost', () => {
    expect(alertPlaceText({ vhost: '/', queue: 'orders.dlq' })).toBe('orders.dlq (vhost /)');
  });
  it('says when an Alert is about no queue', () => {
    expect(alertPlaceText({ vhost: null, queue: null })).toBe('The whole Broker Profile');
    expect(alertPlaceText({ vhost: '/', queue: null })).toBe('Vhost /');
  });
});

describe('alertValueText', () => {
  it('shows the value against the threshold', () => {
    expect(alertValueText({ value: 500, threshold: 100 })).toBe('500 (threshold 100)');
    expect(alertValueText({ value: 3, threshold: null })).toBe('3');
  });
  it('shows nothing made up for an Alert with no value', () => {
    expect(alertValueText({ value: null, threshold: null })).toBe('—');
    expect(alertValueText({ value: null, threshold: 4 })).toBe('threshold 4');
  });
});

describe('ruleConditionText', () => {
  it('words the queue conditions', () => {
    expect(ruleConditionText({ kind: 'depthAbove', vhost: '/', queue: 'orders.dlq', queuePattern: null, threshold: 100 })).toBe('Depth above 100 on orders.dlq (vhost /)');
    expect(ruleConditionText({ kind: 'anyArrival', vhost: '/', queue: null, queuePattern: '*.dlq' })).toBe('Any Message arrives on queues matching *.dlq (vhost /)');
    expect(ruleConditionText({ kind: 'arrivalsAbove', vhost: 'a', queue: 'q', queuePattern: null, count: 10, withinMs: 300_000 })).toBe('More than 10 estimated arrivals within 5m on q (vhost a)');
  });
  it('still names a condition it has no words for', () => {
    expect(ruleConditionText({ kind: 'somethingNew' })).toBe('somethingNew');
  });
});

describe('deliveryText', () => {
  it('says a delivery got through', () => {
    expect(deliveryText(delivery)).toBe('Delivered');
    expect(deliveryText({ ...delivery, attempts: 2 })).toBe('Delivered on attempt 2');
  });
  it('says why a delivery failed', () => {
    expect(deliveryText({ outcome: 'failed', httpStatus: 500, error: null, attempts: 3 })).toBe('Failed after 3 attempts: HTTP 500');
    expect(deliveryText({ outcome: 'failed', httpStatus: null, error: 'timeout', attempts: 1 })).toBe('Failed after 1 attempt: timeout');
    expect(deliveryText({ outcome: 'failed', httpStatus: null, error: null, attempts: 0 })).toBe('Failed: no attempt was made');
  });
});
