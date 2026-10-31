// Process entry point of the Volverán server. Configuration comes from the
// environment:
//   VOLVERAN_PROFILES_FILE  Broker Profiles YAML (default ./profiles.yaml)
//   VOLVERAN_HOST           listen address (default 127.0.0.1; Solo Mode refuses
//                           anything but loopback, see run-mode.ts)
//   VOLVERAN_PORT           listen port (default 8080)
//   VOLVERAN_AUTH           none (Solo Mode, default) or oidc (Team Mode)
//   VOLVERAN_OPERATOR       the Operator's name in Solo Mode (default $USER)
//   VOLVERAN_OIDC_ISSUER, VOLVERAN_OIDC_CLIENT_ID, VOLVERAN_OIDC_CLIENT_SECRET,
//   VOLVERAN_OIDC_REDIRECT_URL, VOLVERAN_OIDC_SCOPES, VOLVERAN_SESSION_SECRET
//                           Team Mode sign-in (see run-mode.ts, auth.ts)
//   VOLVERAN_OIDC_GROUPS_CLAIM
//                           the claim (name or dotted path) holding the
//                           Operator's groups, for Roles (default groups; see
//                           groups-claim.ts)
//   VOLVERAN_WEB_ROOT       built web app (default dist/web next to the compiled
//                           server; none when run from source, see web-root.ts)
//   VOLVERAN_DATA_DIR       the audit store (Audit Entries, Discarded Messages);
//                           default ./data, /data in the Docker image
//   VOLVERAN_POSTGRES_URL   keeps the audit store in this PostgreSQL database
//                           instead (postgres://...); unset means SQLite
//   VOLVERAN_POSTGRES_REQUIRE_TLS, VOLVERAN_POSTGRES_CA_FILE
//                           require TLS to it with a verified certificate, with
//                           the system's CAs or those in the file
//   VOLVERAN_CHECKOUT_MAX_MESSAGES, VOLVERAN_CHECKOUT_MAX_MB
//                           Checkout limits (default 1000 Messages, 100 MB)
//   VOLVERAN_CHECKOUT_TIME_LIMIT_MINUTES
//                           how long a Checkout may hold Messages (default 30)
//   VOLVERAN_CHECKOUT_HEARTBEAT_SECONDS
//                           a Checkout without a browser heartbeat for this
//                           long ends (default 120)
//   VOLVERAN_BODY_RETENTION_DAYS, VOLVERAN_BODY_RETENTION_MAX_BYTES,
//   VOLVERAN_BODY_RETENTION_INTERVAL_MINUTES
//                           retention of Discarded Message bodies (default
//                           30 days or 1 GiB in total, checked hourly; see
//                           audit/body-retention.ts)
//   VOLVERAN_HISTORY_INTERVAL_SECONDS
//                           how often the sampler reads the dead-letter queues
//                           (default 60, 15 to 3600)
//   VOLVERAN_HISTORY_RETENTION_DAYS
//                           how long Samples and notification outcomes are kept
//                           (default 14, 1 to 90)
//   VOLVERAN_PUBLIC_URL     the base of the links in notifications (default in
//                           Team Mode: the origin of VOLVERAN_OIDC_REDIRECT_URL;
//                           otherwise notifications carry no link)
//   VOLVERAN_METRICS_PORT   serves Prometheus metrics at /metrics on this port,
//                           at VOLVERAN_HOST's address (default off; see
//                           metrics/listener.ts)
// plus each Broker Profile's password variable (its `passwordEnv`) and each
// Alert Destination's variables (its `urlEnv` and `signingSecretEnv`).
//
// `main.js check-config` checks all of this and exits, without listening (see
// check-config.ts). `main.js copy-audit-store` copies the SQLite store in
// VOLVERAN_DATA_DIR into the empty database at VOLVERAN_POSTGRES_URL and exits (see
// audit/copy-audit-store.ts).
import path from 'node:path';
import { product } from '../shared/product.js';
import { copyAuditStoreCommand } from './audit/copy-audit-store.js';
import { checkConfig } from './check-config.js';
import { ConfigError } from './config-error.js';
import { startServer } from './server.js';
import { defaultWebRoot } from './web-root.js';

async function main() {
  const settings = {
    profilesFile: path.resolve(process.env.VOLVERAN_PROFILES_FILE ?? 'profiles.yaml'),
    env: process.env,
    host: process.env.VOLVERAN_HOST ?? '127.0.0.1',
    port: Number(process.env.VOLVERAN_PORT ?? 8080),
  };
  const [command, ...args] = process.argv.slice(2);
  if (command === 'check-config') {
    if (args.length > 0) {
      throw new ConfigError('check-config takes no arguments: it checks the file named by VOLVERAN_PROFILES_FILE');
    }
    const { exitCode, lines } = await checkConfig(settings);
    for (const line of lines) console.log(line);
    process.exitCode = exitCode;
    return;
  }
  if (command === 'copy-audit-store') {
    if (args.length > 0) {
      throw new ConfigError('copy-audit-store takes no arguments: it copies VOLVERAN_DATA_DIR into VOLVERAN_POSTGRES_URL');
    }
    const lines = await copyAuditStoreCommand(process.env, path.resolve(process.env.VOLVERAN_DATA_DIR ?? 'data'));
    for (const line of lines) console.log(line);
    return;
  }
  const server = await startServer({
    ...settings,
    webRoot: process.env.VOLVERAN_WEB_ROOT ?? defaultWebRoot(import.meta.url),
    dataDir: path.resolve(process.env.VOLVERAN_DATA_DIR ?? 'data'),
    logger: true,
  });
  console.log(`${product.name} ${product.version} listening on ${server.url}`);

  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  if (err instanceof ConfigError) {
    console.error(`Configuration error: ${err.message}`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
