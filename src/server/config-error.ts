// Configuration problems found at startup (profiles file, Solo Mode settings).
// main.ts prints them as "Configuration error: ..." and exits; they never
// reach the HTTP API.
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}
