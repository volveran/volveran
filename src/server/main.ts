// Process entry point of the Volverán server. Configuration comes from the
// environment:
//   VOLVERAN_PROFILES_FILE  Broker Profiles YAML (default ./profiles.yaml)
//   VOLVERAN_HOST           listen address (default 127.0.0.1; Solo Mode refuses
//                           anything but loopback, see run-mode.ts)
//   VOLVERAN_PORT           listen port (default 8080)
//   VOLVERAN_AUTH           none (Solo Mode, default); oidc (Team Mode) arrives in #11
//   VOLVERAN_OPERATOR       the Operator's name in Solo Mode (default $USER)
//   VOLVERAN_WEB_ROOT       built web app (default dist/web next to this file)
//   VOLVERAN_CHECKOUT_MAX_MESSAGES, VOLVERAN_CHECKOUT_MAX_MB
//                           Checkout limits (default 1000 Messages, 100 MB)
// plus each Broker Profile's password variable (its `passwordEnv`).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { product } from '../shared/product.js';
import { ConfigError } from './config-error.js';
import { startServer } from './server.js';

const here = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const server = await startServer({
    profilesFile: path.resolve(process.env.VOLVERAN_PROFILES_FILE ?? 'profiles.yaml'),
    env: process.env,
    host: process.env.VOLVERAN_HOST ?? '127.0.0.1',
    port: Number(process.env.VOLVERAN_PORT ?? 8080),
    webRoot: process.env.VOLVERAN_WEB_ROOT ?? path.resolve(here, '../web'),
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
