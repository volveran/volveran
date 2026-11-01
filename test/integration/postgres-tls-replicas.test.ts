// Several Replicas on PostgreSQL over TLS, the chart's default (#121): forwarding, the shared
// session and a crash work as they do without it, on verified connections through each Replica's proxy.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, purgeQueues, seedMessages, testProfile, tlsFixtures, withChannel } from './harness.js';
import { startTwoReplicas, type TwoReplicas } from './two-replicas.js';

const QUEUE = 'postgres-tls-replicas.dlq';
const startPath = `/api/profiles/dev/vhosts/%2F/queues/${QUEUE}/checkouts`;

describe('several Replicas on PostgreSQL over TLS', () => {
  let replicas: TwoReplicas;

  beforeAll(async () => {
    await withChannel('/', (ch) => ch.assertQueue(QUEUE, { durable: true }));
    replicas = await startTwoReplicas({
      profiles: [testProfile({ name: 'dev', roles: { operator: ['ops'] } })],
      replicaLeaseTiming: { renewEveryMs: 100, holdsForMs: 1_000 },
      env: { VOLVERAN_POSTGRES_REQUIRE_TLS: 'true', VOLVERAN_POSTGRES_CA_FILE: tlsFixtures.caFile },
    });
  });
  afterAll(async () => {
    await replicas?.close();
    await purgeQueues('/', [QUEUE]);
    await withChannel('/', (ch) => ch.deleteQueue(QUEUE));
  });

  it('serves a Checkout through either Replica, and reports it lost when its owner crashes', async () => {
    const encrypted = await replicas.database.query(
      "SELECT bool_and(ssl) AS encrypted FROM pg_stat_ssl JOIN pg_stat_activity USING (pid) WHERE datname = current_database() AND application_name <> 'psql' AND pid <> pg_backend_pid()",
    );
    expect(encrypted.rows[0]?.encrypted).toBe(true);

    const browser = replicas.browser();
    await browser.signIn({ sub: 'tls-ana', email: 'ana@example.com', groups: ['ops'] });
    await seedMessages('/', QUEUE, 1);
    const started = await browser.to(replicas.a).post(startPath, {});
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const { id } = started.body.checkout as { id: string };
    expect((await browser.to(replicas.b).get(`/api/checkouts/${id}`)).body.checkout.status).toBe('active');

    await replicas.a.crash();
    await eventually(async () => expect((await browser.to(replicas.b).get(`/api/checkouts/${id}`)).body.checkout?.status).toBe('lost'));
  });
});
