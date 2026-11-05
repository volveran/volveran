// What the simulator needs of a Broker Profile beyond its summary: its
// Replay Rate and Canary settings, as scripts/screenshots/profiles.yaml sets
// them, except `production`'s Watch Window, honestly short for a demo (15 s
// instead of 10 minutes). Profiles not named here have the server's defaults.
import type { ProfileSummary } from '../../../../src/shared/queues.js';

export interface ProfileSettings {
  name: string;
  protected: boolean;
  /** The profile's RabbitMQ user, recorded in every Audit Entry. */
  brokerUser: string;
  replayRate: { default: number | null; max: number | null };
  canary: { watchWindowMs: number; requiredAbove: number | null };
}

/** The server's defaults (src/server/profiles.ts): no Replay Rate, a 30 s Watch Window, no Canary required. */
const DEFAULTS: Pick<ProfileSettings, 'replayRate' | 'canary'> = {
  replayRate: { default: null, max: null },
  canary: { watchWindowMs: 30_000, requiredAbove: null },
};

const SETTINGS: Record<string, Pick<ProfileSettings, 'replayRate' | 'canary'>> = {
  production: { replayRate: { default: 5, max: 50 }, canary: { watchWindowMs: 15_000, requiredAbove: 3 } },
};

export function profileSettings(summary: ProfileSummary): ProfileSettings {
  const settings = SETTINGS[summary.name] ?? DEFAULTS;
  return { name: summary.name, protected: summary.protected, brokerUser: summary.username ?? '', ...structuredClone(settings) };
}
