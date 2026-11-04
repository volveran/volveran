// Empties the checkout's test broker, then seeds it with dead-lettered Messages
// (messages.mjs, which the demo also starts from) and set-ups the queue list
// warns about.
import amqp from 'amqplib';
import { scenarioMessages } from './messages.mjs';
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
for (const { exchange, routingKey, content, properties } of scenarioMessages()) ch.publish(exchange, routingKey, Buffer.from(content), properties);
await ch.waitForConfirms();
await new Promise((r) => setTimeout(r, 500));
for (const q of ['orders.work', 'payments.work']) {
  let m;
  while ((m = await ch.get(q, { noAck: false }))) ch.nack(m, false, false);
}
await new Promise((r) => setTimeout(r, 800));
await conn.close();
console.log('seeded', scenarioMessages().length);
