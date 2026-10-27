// The release workflow's version check (.github/workflows/release.yml): a
// version tag publishes the image and the chart only when the tag is
// `v<version>` for the version in package.json, and the chart's `version`
// and `appVersion` (charts/volveran/Chart.yaml) are that same version. It
// runs before anything is pushed, so a mismatched image or chart is never
// published.
//
//   node scripts/check-release-version.mjs v0.2.0
//   node scripts/check-release-version.mjs v0.2.0-rc.1   # needs package.json and Chart.yaml at 0.2.0-rc.1
//
// Prints the version (without the `v`) and exits 0 when everything matches;
// otherwise prints one GitHub Actions `::error::` line per mismatch and exits 1.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const chartFile = 'charts/volveran/Chart.yaml';

// `v` + a Semantic Versioning 2.0.0 version (https://semver.org), the form
// Helm requires for a chart version, without build metadata: Helm turns `+`
// into `_` in the chart's OCI tag, which would then differ from the version.
// A pre-release part (`-rc.1`) makes Flux semver ranges skip the release
// unless they ask for pre-releases.
const identifier = '(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)';
const semverTag = new RegExp(
  `^v(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)` +
    `(?:-${identifier}(?:\\.${identifier})*)?$`,
);

/**
 * @typedef {object} ReleaseVersions
 * @property {string} packageVersion `version` in package.json
 * @property {string} chartVersion `version` in Chart.yaml
 * @property {string} chartAppVersion `appVersion` in Chart.yaml
 */

/**
 * Why `tag` must not be released with these versions; empty when it may.
 * @param {string} tag the pushed git tag, e.g. `v0.2.0` or `v0.2.0-rc.1`
 * @param {ReleaseVersions} versions
 * @returns {string[]}
 */
export function releaseVersionErrors(tag, versions) {
  const errors = [];
  const { packageVersion, chartVersion, chartAppVersion } = versions;
  const version = tag.replace(/^v/, '');
  if (!semverTag.test(tag)) {
    errors.push(`Tag ${tag} is not v<major>.<minor>.<patch>[-<pre-release>], e.g. v0.2.0 or v0.2.0-rc.1`);
  }
  if (tag !== `v${packageVersion}`) {
    errors.push(`Tag ${tag} does not match package.json version ${packageVersion} (expected v${packageVersion})`);
  }
  for (const [field, value] of [
    ['version', chartVersion],
    ['appVersion', chartAppVersion],
  ]) {
    if (value !== version) {
      errors.push(`${chartFile} ${field} ${value} does not match tag ${tag} (expected ${version})`);
    }
  }
  return errors;
}

/**
 * The versions in package.json and Chart.yaml of the checkout at `root`.
 * @param {string} root
 * @returns {ReleaseVersions}
 */
function readReleaseVersions(root) {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const chart = parse(readFileSync(path.join(root, chartFile), 'utf8'));
  // String(): an unquoted `appVersion: 1.0` parses as a number.
  return {
    packageVersion: String(pkg.version),
    chartVersion: String(chart?.version),
    chartAppVersion: String(chart?.appVersion),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tag = process.argv[2];
  if (!tag) {
    console.error('::error::Usage: node scripts/check-release-version.mjs <tag>, e.g. v0.2.0');
    process.exit(1);
  }
  const errors = releaseVersionErrors(tag, readReleaseVersions(repoRoot));
  for (const error of errors) console.error(`::error::${error}`);
  if (errors.length > 0) process.exit(1);
  console.log(tag.slice(1));
}
