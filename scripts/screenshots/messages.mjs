// The Messages of the screenshot scenario, as their publishers send them,
// before the broker dead-letters them: 14 orders (every third with Spring
// AMQP Failure Details naming SQLTimeoutException), one protobuf order and 6
// payments. seed.mjs publishes them to a real broker; the demo's simulator
// (site/demo/api) starts from the same list, so screenshots and demo tell one
// story. Plain JavaScript with no Node APIs: node and the browser both run it.

const customers = ['c-10482', 'c-22017', 'c-31155', 'c-40998', 'c-51230'];
const skus = ['SKU-AX-114', 'SKU-BR-220', 'SKU-CT-007', 'SKU-DL-981'];
const orderRoutingKeys = ['orders.created.eu', 'orders.created.us', 'orders.updated.eu', 'orders.cancelled.eu'];
const protobufOrder = [
  0x0a, 0x08, 0xd2, 0x09, 0x10, 0x01, 0x1a, 0x05, 0x45, 0x55, 0x52, 0xff, 0x00, 0x7f, 0x22, 0x0c, 0x53, 0x4b, 0x55, 0x2d, 0x41, 0x58, 0x2d, 0x31,
  0x31, 0x34,
];

const utf8 = (text) => new TextEncoder().encode(text);

/** Every Message of the scenario, in publish order: `{ exchange, routingKey, content, properties }`. */
export function scenarioMessages() {
  const messages = [];
  let n = 0;
  const id = (p) => `${p}-${(0x5e1a + n * 7919).toString(16)}-${String(n).padStart(4, '0')}`;
  for (let i = 0; i < 14; i++) {
    n++;
    const rk = orderRoutingKeys[i % 4];
    const body = {
      orderId: 880210 + i,
      customerId: customers[i % 5],
      currency: i % 3 ? 'EUR' : 'USD',
      lines: [{ sku: skus[i % 4], qty: 1 + (i % 3), unitPrice: 19.9 + i }],
      placedAt: `2026-10-29T06:${String(10 + i).padStart(2, '0')}:41.118Z`,
      ...(i % 5 === 2 ? { coupon: null } : {}),
    };
    const headers = { 'x-tenant': i % 2 ? 'north' : 'south', traceparent: `00-4bf92f3577b34da6a3ce929d0e0e${4736 + i}-00f067aa0ba902b7-01` };
    if (i % 3 === 0)
      Object.assign(headers, {
        'x-exception-message': 'Could not acquire JDBC connection; SQLTimeoutException: Connection is not available, request timed out after 30000ms.',
        'x-exception-stacktrace':
          'org.springframework.jdbc.CannotGetJdbcConnectionException: Failed to obtain JDBC Connection\n\tat org.springframework.jdbc.datasource.DataSourceUtils.getConnection(DataSourceUtils.java:84)\n\tat org.example.orders.OrderRepository.save(OrderRepository.java:57)\nCaused by: java.sql.SQLTimeoutException: Connection is not available, request timed out after 30000ms.',
        'x-original-exchange': 'orders',
        'x-original-routingKey': rk,
      });
    messages.push({
      exchange: 'orders',
      routingKey: rk,
      content: utf8(JSON.stringify(body, null, i % 2 ? 2 : 0)),
      properties: {
        messageId: id('ord'), contentType: 'application/json', correlationId: `corr-${4410 + i}`, timestamp: 1793255000 + i * 37,
        type: 'OrderPlaced', appId: 'orders-api', deliveryMode: 2, headers,
      },
    });
  }
  n++;
  messages.push({
    exchange: 'orders',
    routingKey: 'orders.created.eu',
    content: Uint8Array.from(protobufOrder),
    properties: { messageId: id('ord'), contentType: 'application/x-protobuf', type: 'OrderPlaced', deliveryMode: 2 },
  });
  for (let i = 0; i < 6; i++) {
    n++;
    messages.push({
      exchange: 'payments',
      routingKey: `payments.capture.${i % 2 ? 'card' : 'sepa'}`,
      content: utf8(JSON.stringify({ paymentId: `pay_${9100 + i}`, amount: { value: 4990 + i * 250, currency: 'EUR' }, attempt: 1 + (i % 3), gatewayStatus: 503 })),
      properties: { messageId: id('pay'), contentType: 'application/json', deliveryMode: 2, headers: { 'x-tenant': 'north' } },
    });
  }
  return messages;
}
