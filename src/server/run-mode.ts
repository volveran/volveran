// Pure startup check (no I/O) of how Volverán runs (ADR 0002). Solo Mode
// (`VOLVERAN_AUTH=none`, the default) has no sign-in, so it refuses any listen
// address but loopback and takes the Operator's name from the configuration.
// Team Mode (`oidc`, #11) is the only way to listen on the network.
import { isLoopback } from './is-loopback.js';

export type RunMode = { kind: 'solo'; operator: string };

export type RunModeResult = { ok: true; mode: RunMode } | { ok: false; error: string };

export function resolveRunMode(env: Record<string, string | undefined>, host: string): RunModeResult {
  const auth = env.VOLVERAN_AUTH?.trim() || 'none';
  if (auth === 'oidc') {
    return { ok: false, error: 'VOLVERAN_AUTH=oidc (Team Mode) is not available in this version yet. Use VOLVERAN_AUTH=none (Solo Mode).' };
  }
  if (auth !== 'none') {
    return { ok: false, error: `VOLVERAN_AUTH must be "none" (Solo Mode) or "oidc" (Team Mode), not "${auth}".` };
  }

  if (!isLoopback(host)) {
    return {
      ok: false,
      error:
        `Solo Mode has no sign-in, so it only listens on a loopback address (127.0.0.1, ::1 or localhost), ` +
        `not on "${host}": anyone who could reach it would act on your brokers with your Broker Profiles. ` +
        `Set VOLVERAN_HOST=127.0.0.1. In Docker, run the container with --network host so the browser on this ` +
        `machine reaches it; to share Volverán with a team, run it in Team Mode (VOLVERAN_AUTH=oidc).`,
    };
  }

  const operator = env.VOLVERAN_OPERATOR?.trim() || env.USER?.trim();
  if (!operator) {
    return {
      ok: false,
      error:
        'Solo Mode records your name as the Operator of every action, but neither VOLVERAN_OPERATOR nor USER is set. ' +
        'Set VOLVERAN_OPERATOR to your name (in Docker: -e VOLVERAN_OPERATOR=$USER).',
    };
  }
  return { ok: true, mode: { kind: 'solo', operator } };
}
