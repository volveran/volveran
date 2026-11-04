// Builds the demo (site/demo) around the web app of the latest release tag,
// unchanged: the tag's src/web and src/shared are unpacked into
// dist/demo-release/<tag>/ and the demo page imports them as `@release/...`.
// The demo itself (simulator, banner) comes from this checkout.
//
//   npm run demo                          # dev server on http://localhost:5174/
//   npm run demo:build                    # dist/demo, for Pages at /demo/
//   node scripts/demo.mjs build <outDir> [<tag>]
//   node scripts/demo.mjs dev [<tag>]
//
// The release's openapi.json lands next to it, for the contract check.
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { build, createServer } from 'vite';
import { findLatestRelease, repoRoot, unpackRelease } from './release-tag.mjs';

/**
 * Unpacks what the demo needs of `tag` and returns where.
 * @param {string} tag
 * @returns {string}
 */
export function unpackDemoRelease(tag) {
  const dir = path.join(repoRoot, 'dist/demo-release', tag);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // Inside the checkout, so the web app's imports (react, fonts) resolve to its node_modules.
  unpackRelease(tag, dir, ['src/web', 'src/shared', 'openapi.json']);
  return dir;
}

/**
 * The Vite configuration of the demo page around the release unpacked in `releaseDir`.
 * @param {string} tag
 * @param {string} releaseDir
 * @returns {import('vite').InlineConfig}
 */
function demoConfig(tag, releaseDir) {
  return {
    configFile: false,
    root: path.join(repoRoot, 'site/demo'),
    // Relative, so the same build works at /volveran/demo/ on Pages and anywhere else.
    base: './',
    plugins: [react()],
    define: { __VOLVERAN_RELEASE__: JSON.stringify(tag.replace(/^v/, '')) },
    resolve: { alias: { '@release': path.join(releaseDir, 'src') } },
    server: { port: 5174, strictPort: true },
  };
}

/**
 * Builds the demo around the web app of `tag` into `outDir`; returns where the release was unpacked.
 * @param {string} outDir
 * @param {string} tag
 * @returns {Promise<string>}
 */
export async function buildDemo(outDir, tag) {
  const releaseDir = unpackDemoRelease(tag);
  console.log(`Demo around the web app of ${tag}`);
  await build({ ...demoConfig(tag, releaseDir), build: { outDir: path.resolve(outDir), emptyOutDir: true } });
  return releaseDir;
}

/** @returns {string} */
export function latestReleaseTag() {
  const tag = findLatestRelease();
  if (tag === undefined) throw new Error('No release tag to build the demo from.');
  return tag;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const tagArg = command === 'build' ? args[1] : args[0];
  const tag = tagArg ?? latestReleaseTag();
  if (command === 'build') {
    await buildDemo(args[0] ?? path.join(repoRoot, 'dist/demo'), tag);
  } else if (command === 'dev') {
    const releaseDir = unpackDemoRelease(tag);
    console.log(`Demo around the web app of ${tag}`);
    const server = await createServer(demoConfig(tag, releaseDir));
    await server.listen();
    server.printUrls();
  } else {
    throw new Error('Usage: node scripts/demo.mjs build [<outDir>] [<tag>] | dev [<tag>]');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.join(repoRoot, 'scripts/demo.mjs')) await main();
