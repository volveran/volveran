// The store's schema version against the migrations this binary knows. A store newer
// than the binary is refused at startup, on every store: downgrades are not supported.
import { ConfigError } from '../config-error.js';

export function refuseNewerStore(storeVersion: number, knownVersion: number): void {
  if (storeVersion > knownVersion) {
    throw new ConfigError(
      `The audit store is at schema version ${storeVersion}, newer than this version of Volverán understands (${knownVersion}). Downgrades are not supported: run the version that wrote the store, or a later one.`,
    );
  }
}
