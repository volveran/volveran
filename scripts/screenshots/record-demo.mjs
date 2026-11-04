// Records the server's answers for the demo's read-only views into
// docs/demo/recording.json (see demo-recording.mjs). capture.sh runs it right
// before taking docs/images, in the same state.
//
//   node scripts/screenshots/record-demo.mjs <out.json> <webhook url> <temp dir>
//
// Needs BASE, VOLVERAN_TEST_MGMT_PORT and VOLVERAN_TEST_AMQP_PORT as capture.sh sets them.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { hostValuesIn, recordDemo } from './demo-recording.mjs';

const [out, webhook, tmp] = process.argv.slice(2);
if (!out || !webhook || !tmp) throw new Error('Usage: node record-demo.mjs <out.json> <webhook url> <temp dir>');
const base = new URL('api/v1', process.env.BASE);

/** @param {string} p */
async function get(p) {
  const res = await fetch(`${base}${p}`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET ${p} answered ${res.status}: ${await res.text()}`);
  return res.json();
}

const recording = await recordDemo(get, {
  recordedAt: new Date().toISOString(),
  operator: process.env.VOLVERAN_OPERATOR ?? 'ana',
  replace: [
    [`http://127.0.0.1:${process.env.VOLVERAN_TEST_MGMT_PORT}`, 'http://rabbitmq.example:15672'],
    [`amqp://127.0.0.1:${process.env.VOLVERAN_TEST_AMQP_PORT}`, 'amqp://rabbitmq.example:5672'],
    [webhook, 'https://hooks.example.com/ops-slack'],
    [webhook.replace(/\/$/, ''), 'https://hooks.example.com/ops-slack'],
    [tmp, '/data'],
    ['VOLVERAN_TEST_PASSWORD', 'VOLVERAN_RABBITMQ_PASSWORD'],
  ],
});
const left = hostValuesIn(recording);
if (left.length > 0) throw new Error(`The recording still holds host-specific values: ${left.join(', ')}. Add them to the replacements.`);
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(recording, null, 2)}\n`);
console.log(`recorded the demo's read-only views in ${out}`);
