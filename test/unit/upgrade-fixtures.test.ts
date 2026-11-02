// What the upgrade suite needs of a version's form, at a major version and a pre-release.
import { describe, expect, it } from 'vitest';
import { atLeast, releasesWithoutFixture, RELEASED_VERSIONS } from '../support/upgrade-fixtures.js';

const changelog = ['## [Unreleased]', '## [1.0.0] - 2026-12-01', '## [1.0.0-rc.1] - 2026-11-02', '## [0.6.1] - 2026-10-31', '## [0.6.0] - 2026-10-31'].join('\n');

describe('which release needs a fixture', () => {
  it('is none, when every release up to the version being prepared has one', () => {
    expect(releasesWithoutFixture(changelog.replace('## [1.0.0] - 2026-12-01\n', ''), '1.0.0-rc.1')).toEqual([]);
  });

  it('is not the version being prepared, whose image does not exist yet', () => {
    expect(releasesWithoutFixture(changelog, '1.0.0')).toEqual([]);
  });

  it('is not a pre-release, at the next version bump', () => {
    expect(releasesWithoutFixture('## [1.0.0-rc.2] - 2026-11-09\n## [1.0.0-rc.1] - 2026-11-02', '1.0.0-rc.2', [])).toEqual([]);
  });

  it('is a release that has none, once the next version is prepared', () => {
    expect(releasesWithoutFixture(changelog, '1.0.1', ['0.6.0', '0.6.1'])).toEqual(['1.0.0']);
  });

  it('holds what the released versions say', () => {
    expect(releasesWithoutFixture(RELEASED_VERSIONS.map((v) => `## [${v}] - 2026-01-01`).join('\n'), 'none')).toEqual([]);
  });
});

describe('what a version has', () => {
  it.each([
    ['0.2.0', 3, false],
    ['0.3.0', 3, true],
    ['1.0.0', 4, true],
    ['1.0.0-rc.1', 5, true],
  ])('%s at 0.%i: %s', (version, minor, expected) => {
    expect(atLeast(version, minor)).toBe(expected);
  });
});
