// `check-config`: tries the configuration as startup would and reports, for CI.
// Exit status: 0, it would start; 1, startup would refuse it; 2, it would start,
// but 1.0 will refuse keys in the file. Findings name keys and variables, never
// their values.
import { ConfigError } from './config-error.js';
import { NO_VERSION_WARNING } from './profiles.js';
import { readStartupConfig, type StartupSettings } from './startup-config.js';

export interface CheckConfigResult {
  exitCode: 0 | 1 | 2;
  lines: string[];
}

export async function checkConfig(settings: StartupSettings): Promise<CheckConfigResult> {
  let file;
  try {
    ({ file } = await readStartupConfig(settings));
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    return { exitCode: 1, lines: [`error: ${err.message}`, 'FAILED: Volverán would refuse to start with this configuration'] };
  }
  const warnings = file.versionDeclared ? [] : [NO_VERSION_WARNING];
  for (const p of file.profiles) {
    if (p.credentials.kind === 'shared' && p.credentials.password === undefined) {
      warnings.push(`Broker Profile "${p.name}": ${p.credentials.passwordEnv} is not set; using this profile reports password_not_set`);
    }
  }
  const lines = [
    ...file.unknownKeys.map((key) => `refused in 1.0: ${key} is not a known key; this release ignores it`),
    ...warnings.map((warning) => `warning: ${warning}`),
  ];
  if (file.unknownKeys.length > 0) {
    return { exitCode: 2, lines: [...lines, `FAILED: ${file.unknownKeys.length} unknown key(s) that 1.0 will refuse`] };
  }
  return { exitCode: 0, lines: [...lines, 'OK'] };
}
