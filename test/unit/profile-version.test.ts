// The profiles file's format version, and what the parser reports for
// check-config: the keys 1.0 will refuse, which 0.6 still ignores.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { parseProfilesFile, ProfilesConfigError } from '../../src/server/profiles.js';
import { startServer } from '../../src/server/server.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const profile = [
  'profiles:',
  '  - name: prod',
  '    managementUrl: http://127.0.0.1:1',
  '    amqpUrl: amqp://127.0.0.1:1',
  '    username: volveran',
  '    passwordEnv: PROD_PW',
].join('\n');

vi.setConfig({ testTimeout: 60_000 });

const parse = (text: string) => parseProfilesFile(text, {}, 'profiles.yaml');

describe('the version of the profiles file', () => {
  it('reads version 1', () => {
    expect(parse(`version: 1\n${profile}`).versionDeclared).toBe(true);
  });

  it('reads a file without a version as version 1, and says it had none', () => {
    const file = parse(profile);
    expect(file.versionDeclared).toBe(false);
    expect(file.profiles[0]!.name).toBe('prod');
  });

  it.each(['2', '0', '"1"', '1.5', 'null', '[1]'])('refuses version: %s', (version) => {
    expect(() => parse(`version: ${version}\n${profile}`)).toThrow(ProfilesConfigError);
    expect(() => parse(`version: ${version}\n${profile}`)).toThrow(/profiles\.yaml: version must be 1/);
  });

  it('reports the unsupported version before anything a newer format may have changed', () => {
    expect(() => parse('version: 2\nbrokers: []')).toThrow(/version must be 1/);
  });
});

describe('the keys 1.0 will refuse', () => {
  it('reports none in a file that uses only known keys', () => {
    const file = parse(
      [
        'version: 1',
        'alertDestinations: []',
        'profiles:',
        '  - name: a',
        '    managementUrl: http://127.0.0.1:1',
        '    amqpUrl: amqp://127.0.0.1:1',
        '    caFile: ca.pem',
        '    username: volveran',
        '    passwordEnv: PW',
        '    credentials: shared',
        '    vhosts: all',
        '    defaultQueueFilter: "*.dlq"',
        '    protected: true',
        '    requireApproval: true',
        '    roles: { admin: [ops] }',
        '    replayRate: { default: 1, max: 2 }',
        '    replayRules: []',
        '    alerts: []',
        '    canary: { watchWindow: 30s }',
        '  - name: b',
        '    managementUrl: http://127.0.0.1:1',
        '    amqpUrl: amqp://127.0.0.1:1',
        '    credentials: operatorToken',
        '    tokenUsernameClaim: preferred_username',
      ].join('\n'),
    );
    expect(file.unknownKeys).toEqual([]);
  });

  it('reports unknown keys at the top level and at profile level, each with its place', () => {
    const file = parse(`version: 1\nalertDestination: []\n${profile}\n    requireAproval: false\n    Protected: true`);
    expect(file.unknownKeys).toEqual([
      'alertDestination',
      'profiles[0] ("prod").requireAproval',
      'profiles[0] ("prod").Protected',
    ]);
  });

  it('reports none in profiles.example.yaml, which declares its version', () => {
    const text = readFileSync(new URL('../../profiles.example.yaml', import.meta.url), 'utf8');
    const env = Object.fromEntries([...text.matchAll(/\b\w+Env: (\w+)/g)].map((m) => [m[1]!, 'https://example.com/hook']));
    const file = parseProfilesFile(text, env, 'profiles.example.yaml');
    expect(file.versionDeclared).toBe(true);
    expect(file.unknownKeys).toEqual([]);
  });

  it('still ignores them when reading the file, in 0.6', () => {
    const file = parse(`${profile}\n    requireAproval: false`);
    expect(file.profiles[0]!.requireApproval).toBe(false);
    expect(file.profiles[0]!.protected).toBe(false);
  });
});

describe('startup', () => {
  async function startupLog(text: string): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'volveran-profile-version-'));
    const profilesFile = path.join(dir, 'profiles.yaml');
    await writeFile(profilesFile, text);
    let log = '';
    try {
      const server = await startServer({
        profilesFile,
        env: { VOLVERAN_OPERATOR: 'ana' },
        host: '127.0.0.1',
        port: 0,
        logger: { stream: { write: (line) => (log += line) } },
      });
      await server.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    return log;
  }

  it('warns about a file without a version', async () => {
    const warning = (await startupLog(profile)).split('\n').find((line) => line.includes('has no version'));
    expect(warning).toBeDefined();
    expect(JSON.parse(warning!)).toMatchObject({ level: 40 });
  });

  it('says nothing of it when the file has one', async () => {
    expect(await startupLog(`version: 1\n${profile}`)).not.toContain('has no version');
  });

  it('refuses an unsupported version', async () => {
    await expect(startupLog(`version: 2\n${profile}`)).rejects.toThrow(/version must be 1/);
  });
});
