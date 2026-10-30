// Empties the checkout's test broker, then seeds it with dead-lettered Messages
// and set-ups the queue list warns about.
import amqp from 'amqplib';
const MGMT = `http://127.0.0.1:${process.env.VOLVERAN_TEST_MGMT_PORT}/api`;
const AUTH = 'Basic ' + Buffer.from('volveran-admin:volveran-admin-pass').toString('base64');
const api = (m, p, b) =>
  fetch(MGMT + p, { method: m, headers: { authorization: AUTH, 'content-type': 'application/json' }, body: b && JSON.stringify(b) }).then((r) => {
    if (!r.ok) console.log(m, p, r.status);
  });
const v = '%2F';
const queues = await fetch(`${MGMT}/queues/${v}?columns=name,type`, { headers: { authorization: AUTH } }).then((r) => r.json());
for (const q of queues) if (q.type !== 'stream') await api('DELETE', `/queues/${v}/${q.name}/contents`);
await api('PUT', `/queues/${v}/billing.work`, { durable: true, arguments: { 'x-queue-type': 'classic', 'x-dead-letter-exchange': 'billing.dlx' } });
await api('PUT', `/queues/${v}/shipping.dlq`, { durable: true, arguments: { 'x-queue-type': 'classic', 'x-message-ttl': 86400000 } });
await api('PUT', `/queues/${v}/notifications.dlq`, { durable: true, arguments: { 'x-queue-type': 'classic', 'x-max-length': 1000 } });
await api('PUT', `/exchanges/${v}/inventory.dlx`, { type: 'fanout', durable: true });
await api('PUT', `/queues/${v}/inventory.work`, { durable: true, arguments: { 'x-queue-type': 'quorum', 'x-dead-letter-exchange': 'inventory.dlx' } });

const conn = await amqp.connect(`amqp://volveran-admin:volveran-admin-pass@127.0.0.1:${process.env.VOLVERAN_TEST_AMQP_PORT}`);
const ch = await conn.createConfirmChannel();
const customers = ['c-10482', 'c-22017', 'c-31155', 'c-40998', 'c-51230'];
const skus = ['SKU-AX-114', 'SKU-BR-220', 'SKU-CT-007', 'SKU-DL-981'];
let n = 0;
const id = (p) => `${p}-${(0x5e1a + n * 7919).toString(16)}-${String(n).padStart(4, '0')}`;
for (let i = 0; i < 14; i++) {
  n++;
  const rk = ['orders.created.eu', 'orders.created.us', 'orders.updated.eu', 'orders.cancelled.eu'][i % 4];
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
  ch.publish('orders', rk, Buffer.from(JSON.stringify(body, null, i % 2 ? 2 : 0)), {
    messageId: id('ord'), contentType: 'application/json', correlationId: `corr-${4410 + i}`, timestamp: 1793255000 + i * 37,
    type: 'OrderPlaced', appId: 'orders-api', deliveryMode: 2, headers,
  });
}
n++;
ch.publish('orders', 'orders.created.eu', Buffer.from([0x0a, 0x08, 0xd2, 0x09, 0x10, 0x01, 0x1a, 0x05, 0x45, 0x55, 0x52, 0xff, 0x00, 0x7f, 0x22, 0x0c, 0x53, 0x4b, 0x55, 0x2d, 0x41, 0x58, 0x2d, 0x31, 0x31, 0x34]), {
  messageId: id('ord'), contentType: 'application/x-protobuf', type: 'OrderPlaced', deliveryMode: 2,
});
for (let i = 0; i < 6; i++) {
  n++;
  ch.publish('payments', `payments.capture.${i % 2 ? 'card' : 'sepa'}`, Buffer.from(JSON.stringify({ paymentId: `pay_${9100 + i}`, amount: { value: 4990 + i * 250, currency: 'EUR' }, attempt: 1 + (i % 3), gatewayStatus: 503 })), {
    messageId: id('pay'), contentType: 'application/json', deliveryMode: 2, headers: { 'x-tenant': 'north' },
  });
}
await ch.waitForConfirms();
await new Promise((r) => setTimeout(r, 500));
for (const q of ['orders.work', 'payments.work']) {
  let m;
  while ((m = await ch.get(q, { noAck: false }))) ch.nack(m, false, false);
}
await new Promise((r) => setTimeout(r, 800));
await conn.close();
console.log('seeded', n);
