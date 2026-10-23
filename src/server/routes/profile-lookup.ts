// Finding what an API path names: its Broker Profile (404 `profile_not_found`)
// and vhost (404 `vhost_not_in_profile` unless the profile is configured for
// it), with a management API client for that profile.
import { HttpError } from '../http-error.js';
import { ManagementClient } from '../management.js';
import { profileHasVhost, type BrokerProfile, type QueueRef } from '../profiles.js';

export interface ProfileAccess {
  profile: BrokerProfile;
  management: ManagementClient;
}

export interface ProfileLookup {
  /** The named Broker Profile; throws 404 `profile_not_found`. */
  profile(name: string): ProfileAccess;
  /** The named Broker Profile, checked to be configured for `vhost`; throws 404. */
  vhost(profileName: string, vhost: string): ProfileAccess;
  /** The queue an API path names, after checking its profile and vhost; throws 404. */
  queueRef(profileName: string, vhost: string, queue: string): QueueRef;
}

export function profileLookup(profiles: BrokerProfile[]): ProfileLookup {
  const profile = (name: string): ProfileAccess => {
    const found = profiles.find((p) => p.name === name);
    if (!found) throw new HttpError(404, 'profile_not_found', `No Broker Profile named "${name}".`);
    return { profile: found, management: new ManagementClient(found) };
  };
  const vhost = (profileName: string, vhostName: string): ProfileAccess => {
    const access = profile(profileName);
    if (!profileHasVhost(access.profile, vhostName)) {
      throw new HttpError(
        404,
        'vhost_not_in_profile',
        `Vhost "${vhostName}" is not configured for Broker Profile "${access.profile.name}".`,
      );
    }
    return access;
  };
  return {
    profile,
    vhost,
    queueRef: (profileName, vhostName, queue) => ({ profile: vhost(profileName, vhostName).profile, vhost: vhostName, queue }),
  };
}
