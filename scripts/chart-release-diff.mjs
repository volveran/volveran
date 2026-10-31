// Renders charts/volveran from the latest release tag and from the working
// tree, with each values fixture in test/chart/fixtures, and fails on any
// difference an upgrade would bring unasked. Version strings (the chart label
// and the image tag) do not count, and neither does a difference listed with
// its reason in test/chart/release-diff-allow.yaml. Templates for a new
// optional value render nothing by default, so they pass. A fixture the release
// does not have is for a value the release does not have, so it is left out.
//
//   npm run test:chart:release               # needs Helm and git; finds the tag on origin
//   npm run test:chart:release -- v0.5.1     # against this tag
//
// Exits 0 when the renders match, or when origin has no release yet; otherwise 1.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = path.join(repoRoot, 'test/chart/fixtures');
const allowFile = path.join(repoRoot, 'test/chart/release-diff-allow.yaml');
const version = '\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?';

/**
 * @typedef {object} AllowedChange
 * @property {string} change one changed line of the render without its indentation: `+ ` or `- `, then the line
 * @property {string} reason why an Operator upgrading is meant to get it
 * @property {string} [fixture] only with this fixture's file name; otherwise with every fixture
 */

/**
 * @typedef {object} Changed
 * @property {string} fixture
 * @property {string} change
 */

/**
 * The newest release among `tags`: no pre-releases, highest version first by number.
 * @param {string[]} tags
 * @returns {string | undefined}
 */
export function latestRelease(tags) {
  return tags
    .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag))
    .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))[0];
}

/**
 * `rendered` with the version strings of a release replaced, and nothing else.
 * @param {string} rendered
 * @returns {string}
 */
export function withoutVersions(rendered) {
  return rendered
    .replace(new RegExp(`(app\\.kubernetes\\.io/version: )"?${version}"?$`, 'gm'), '$1<version>')
    .replace(new RegExp(`(helm\\.sh/chart: volveran-)${version}$`, 'gm'), '$1<version>')
    .replace(new RegExp(`(image: \\S*/volveran:)${version}"?$`, 'gm'), '$1<version>');
}

/**
 * The lines only `before` has (`- `) and only `after` has (`+ `), without indentation.
 * @param {string} before
 * @param {string} after
 * @returns {string[]}
 */
export function changedLines(before, after) {
  const dir = mkdtempSync(path.join(tmpdir(), 'volveran-render-diff-'));
  try {
    writeFileSync(path.join(dir, 'before'), before);
    writeFileSync(path.join(dir, 'after'), after);
    const { status, stdout, stderr } = spawnSync('diff', ['-U0', 'before', 'after'], { cwd: dir, encoding: 'utf8' });
    if (status !== 0 && status !== 1) throw new Error(`diff failed: ${stderr}`);
    return stdout
      .split('\n')
      .filter((line) => /^[-+]/.test(line) && !/^(---|\+\+\+) (before|after)\t/.test(line))
      .map((line) => `${line[0]} ${line.slice(1).trim()}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Reads the allow-list, refusing an entry without a reason.
 * @param {string} text
 * @returns {AllowedChange[]}
 */
export function parseAllowList(text) {
  /** @type {{ allowed?: AllowedChange[] | null } | null} */
  const parsed = parse(text);
  const allowed = parsed?.allowed ?? [];
  for (const entry of allowed) {
    if (!entry.change?.trim() || !entry.reason?.trim()) {
      throw new Error(`An allowed chart difference needs a change and a reason: ${JSON.stringify(entry)}`);
    }
  }
  return allowed;
}

/**
 * Whether an allow-list entry covers this change.
 * @param {AllowedChange} entry
 * @param {Changed} changed
 * @returns {boolean}
 */
function covers(entry, changed) {
  return entry.change === changed.change && (entry.fixture === undefined || entry.fixture === changed.fixture);
}

/**
 * What differs between two chart directories, past the version strings and the allow-list.
 * @param {string} releaseChart
 * @param {string} currentChart
 * @param {{ fixtures: string[], releaseFixtures: string[], allowed: AllowedChange[] }} options
 *   `fixtures` are paths; `releaseFixtures` the file names the release has.
 * @returns {{ differences: Changed[], unused: AllowedChange[], skipped: string[] }}
 */
export function compareCharts(releaseChart, currentChart, { fixtures, releaseFixtures, allowed }) {
  /** @type {Changed[]} */
  const differences = [];
  /** @type {string[]} */
  const skipped = [];
  const used = new Set();
  for (const fixture of fixtures) {
    const name = path.basename(fixture);
    if (!releaseFixtures.includes(name)) {
      skipped.push(name);
      continue;
    }
    const before = withoutVersions(render(releaseChart, fixture));
    const after = withoutVersions(render(currentChart, fixture));
    for (const change of changedLines(before, after)) {
      const changed = { fixture: name, change };
      const entry = allowed.find((e) => covers(e, changed));
      if (entry) used.add(entry);
      else differences.push(changed);
    }
  }
  return { differences, unused: allowed.filter((e) => !used.has(e)), skipped };
}

/**
 * @param {string} chart
 * @param {string} fixture
 * @returns {string}
 */
function render(chart, fixture) {
  const args = ['template', 'volveran', chart, '--namespace', 'volveran', '-f', fixture];
  return execFileSync('helm', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * @param {string[]} args
 * @returns {string}
 */
function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/**
 * Asks origin first: CI's checkout fetches no tags, and a local clone may be behind.
 * Local tags are the answer only when origin cannot be reached.
 * @returns {string | undefined}
 */
function findLatestRelease() {
  /** @type {string[]} */
  let tags;
  try {
    tags = git(['ls-remote', '--tags', '--refs', 'origin', 'v*'])
      .split('\n')
      .map((line) => line.split('refs/tags/')[1] ?? '');
  } catch (err) {
    tags = git(['tag', '--list', 'v*']).split('\n');
    if (latestRelease(tags) === undefined) throw err;
    console.error('Could not ask origin for its tags; using the local ones.');
  }
  return latestRelease(tags);
}

/**
 * Unpacks the chart and fixtures of `tag` into `dir`, fetching the tag if it is not here.
 * @param {string} tag
 * @param {string} dir
 */
function unpackRelease(tag, dir) {
  let ref = `refs/tags/${tag}`;
  if (spawnSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: repoRoot }).status !== 0) {
    // Depth only in a shallow checkout: it would turn a full clone shallow.
    const depth = git(['rev-parse', '--is-shallow-repository']) === 'true' ? ['--depth=1'] : [];
    git(['fetch', '--quiet', '--no-tags', ...depth, 'origin', ref]);
    ref = 'FETCH_HEAD';
  }
  const archive = path.join(dir, 'release.tar');
  git(['archive', '--output', archive, ref, 'charts/volveran', 'test/chart/fixtures']);
  execFileSync('tar', ['-xf', archive, '-C', dir]);
}

function main() {
  const tag = process.argv[2] ?? findLatestRelease();
  if (tag === undefined) {
    console.log('Chart against the last release: origin has no release yet, nothing to compare.');
    return 0;
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'volveran-chart-release-'));
  try {
    unpackRelease(tag, dir);
    const releaseFixtures = readdirSync(path.join(dir, 'test/chart/fixtures'));
    const fixtures = readdirSync(fixturesDir)
      .filter((f) => f.endsWith('.yaml'))
      .map((f) => path.join(fixturesDir, f));
    const allowed = existsSync(allowFile) ? parseAllowList(readFileSync(allowFile, 'utf8')) : [];
    const { differences, unused, skipped } = compareCharts(path.join(dir, 'charts/volveran'), path.join(repoRoot, 'charts/volveran'), {
      fixtures,
      releaseFixtures,
      allowed,
    });
    for (const name of skipped) console.log(`${name}: not in ${tag}, left out`);
    for (const entry of unused) console.log(`Allowed but no longer different, remove it: ${entry.change}`);
    if (differences.length === 0) {
      console.log(`Chart against ${tag}: no differences with ${fixtures.length - skipped.length} fixtures.`);
      return 0;
    }
    console.error(`The chart renders differently from ${tag}. List a difference an upgrade should bring, with its reason, in test/chart/release-diff-allow.yaml.`);
    for (const { fixture, change } of differences) console.error(`  ${fixture}: ${change}`);
    return 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main());
