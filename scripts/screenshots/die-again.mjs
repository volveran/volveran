// Rejects every Message in the work queues, so Messages Volverán Replayed there
// are dead-lettered again (they carry x-volveran-replay-id: Died Again).
import amqp from 'amqplib';
const conn = await amqp.connect(`amqp://volveran-admin:volveran-admin-pass@127.0.0.1:${process.env.VOLVERAN_TEST_AMQP_PORT}`);
const ch = await conn.createChannel();
let n = 0;
for (const q of ['orders.work', 'payments.work']) {
  let m;
  while ((m = await ch.get(q, { noAck: false }))) {
    ch.nack(m, false, false);
    n++;
  }
}
await new Promise((r) => setTimeout(r, 800));
await conn.close();
console.log('dead-lettered again', n);
