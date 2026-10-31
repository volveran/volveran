// Everything startup checks before it touches anything: the environment, the
// profiles file and the checks across them. startServer and check-config both
// read the configuration here, so the two cannot disagree. It contacts nothing,
// and reads only files the configuration names.
import { readFile } from 'node:fs/promises';
import type { PostgresTls } from './audit/postgres-connection.js';
import { ConfigError } from './config-error.js';
import { loadConfig, type Config } from './config.js';
import { checkProfilesForRunMode, checkReplayRules, loadProfilesFile, type ProfilesFile } from './profiles.js';
import type { CheckoutLimits } from './triage/checkout-collection.js';

export interface StartupSettings {
  profilesFile: string;
  env: Record<string, string | undefined>;
  host: string;
  port: number;
  /** Overrides the Checkout limits from the environment. */
  checkoutLimits?: Partial<CheckoutLimits>;
}

export interface StartupConfig {
  config: Config;
  limits: CheckoutLimits;
  file: ProfilesFile;
  /** TLS to PostgreSQL, with the CA file's certificates read. */
  postgresTls: PostgresTls | null;
}

async function readPostgresTls({ postgresTls }: Config): Promise<PostgresTls | null> {
  if (!postgresTls?.caFile) return postgresTls && {};
  try {
    return { ca: await readFile(postgresTls.caFile, 'utf8') };
  } catch (err) {
    throw new ConfigError(`VOLVERAN_POSTGRES_CA_FILE could not be read: ${(err as Error).message}`);
  }
}

/** Reads and checks the configuration; throws a ConfigError on the first problem. */
export async function readStartupConfig(settings: StartupSettings): Promise<StartupConfig> {
  const loaded = loadConfig(settings.env, settings.host);
  if (!loaded.ok) throw new ConfigError(loaded.error);
  const { config } = loaded;
  const file = await loadProfilesFile(settings.profilesFile, settings.env);
  checkProfilesForRunMode(file.profiles, config.mode.kind);
  const limits = { ...config.checkoutLimits, ...settings.checkoutLimits };
  checkReplayRules(file.profiles, limits);
  if (config.metricsPort !== null && config.metricsPort === settings.port) {
    throw new ConfigError(`VOLVERAN_METRICS_PORT must differ from the web app's port (${settings.port}): metrics are never served on it.`);
  }
  return { config, limits, file, postgresTls: await readPostgresTls(config) };
}
