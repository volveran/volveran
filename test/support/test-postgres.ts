// This checkout's test PostgreSQL (test/broker/docker-compose.yml): each caller gets a
// database of its own in it, so nothing leaks between tests. The port comes from
// VOLVERAN_TEST_POSTGRES_PORT (set by scripts/test-broker.mjs run), or is asked from
// docker compose when a test runner is started by hand against `npm run broker:up`.
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { publishedPorts, repoRoot, testBrokerSettings } from '../../scripts/test-broker-env.mjs';

function postgresPort(): string {
  const settings = testBrokerSettings(repoRoot, process.env);
  return settings.postgresPort ?? publishedPorts(settings.project).postgresPort;
}

const urlOf = (database: string) => `postgres://volveran:volveran-test-pass@127.0.0.1:${postgresPort()}/${database}`;

async function withClient<T>(database: string, work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: urlOf(database) });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

export interface TestDatabase {
  url: string;
  /** Runs one statement in the database, as what a test cannot do through the store. */
  query(sql: string, values?: unknown[]): Promise<pg.QueryResult>;
  drop(): Promise<void>;
}

/** An empty database of its own. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `test_${randomBytes(8).toString('hex')}`;
  await withClient('postgres', (client) => client.query(`CREATE DATABASE ${name}`));
  return {
    url: urlOf(name),
    query: (sql, values) => withClient(name, (client) => client.query(sql, values as unknown[])),
    drop: async () => {
      await withClient('postgres', (client) => client.query(`DROP DATABASE ${name} WITH (FORCE)`));
    },
  };
}
