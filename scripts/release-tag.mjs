// The latest release tag, and unpacking files from a tag, for the scripts that
// compare with or build from the last release (chart-release-diff.mjs, demo.mjs).
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
export function findLatestRelease() {
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
 * Unpacks `paths` of `tag` into `dir`, fetching the tag if it is not here.
 * @param {string} tag
 * @param {string} dir
 * @param {string[]} paths
 */
export function unpackRelease(tag, dir, paths) {
  let ref = `refs/tags/${tag}`;
  if (spawnSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: repoRoot }).status !== 0) {
    // Depth only in a shallow checkout: it would turn a full clone shallow.
    const depth = git(['rev-parse', '--is-shallow-repository']) === 'true' ? ['--depth=1'] : [];
    git(['fetch', '--quiet', '--no-tags', ...depth, 'origin', ref]);
    ref = 'FETCH_HEAD';
  }
  const archive = path.join(dir, 'release.tar');
  git(['archive', '--output', archive, ref, ...paths]);
  execFileSync('tar', ['-xf', archive, '-C', dir]);
}
