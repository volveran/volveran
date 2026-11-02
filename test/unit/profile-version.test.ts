// The profiles file's format version, and its refusal of unknown keys.
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

describe('YAML that a file from before 1.0 may use', () => {
  it('refuses a top-level key that holds anchors, and names it', () => {
    expect(() => parse(`x-common: &common\n  username: volveran\n${profile}`)).toThrow(/x-common is not a key of the profiles file/);
  });

  it('refuses a merge key, and names it', () => {
    expect(() => parse(`${profile}\n    <<: { defaultQueueFilter: "*" }`)).toThrow(/prod"\)\.<< is not a key of a Broker Profile/);
  });

  it('reads an alias of a value under a key the file has', () => {
    const file = parse(`${profile}\n    roles:\n      viewer: &people [support]\n      operator: *people`);
    expect(file.profiles[0]?.roles).toMatchObject({ operator: ['support'] });
  });
});

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

describe('unknown keys', () => {
  it('reads a file that uses every top-level and profile-level key', () => {
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
    expect(file.profiles.map((p) => p.name)).toEqual(['a', 'b']);
  });

  it('refuses one at the top level, naming it', () => {
    expect(() => parse(`version: 1\nalertDestination: []\n${profile}`)).toThrow(ProfilesConfigError);
    expect(() => parse(`version: 1\nalertDestination: []\n${profile}`)).toThrow('profiles.yaml: alertDestination is not a key');
  });

  it('refuses a misspelt "profiles" as the misspelt key, not as a file with no profiles', () => {
    expect(() => parse('profile: []')).toThrow('profiles.yaml: profile is not a key');
  });

  it('refuses a misspelt safety setting on a profile, naming its path', () => {
    expect(() => parse(`${profile}\n    requireAproval: false`)).toThrow('profiles.yaml: profiles[0] ("prod").requireAproval is not a key');
    expect(() => parse(`${profile}\n    Protected: true`)).toThrow('profiles[0] ("prod").Protected is not a key');
  });

  it('reads profiles.example.yaml, which declares its version', () => {
    const text = readFileSync(new URL('../../profiles.example.yaml', import.meta.url), 'utf8');
    const env = Object.fromEntries([...text.matchAll(/\b\w+Env: (\w+)/g)].map((m) => [m[1]!, 'https://example.com/hook']));
    expect(parseProfilesFile(text, env, 'profiles.example.yaml').versionDeclared).toBe(true);
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

  it('refuses an unknown key, naming its path', async () => {
    await expect(startupLog(`${profile}\n    protekted: true`)).rejects.toThrow('profiles[0] ("prod").protekted is not a key');
  });
});
