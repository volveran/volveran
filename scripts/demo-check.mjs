// The demo's guard before Pages publishes it: against the web app of the
// latest release tag,
//   1. the contract check: every route of the tag's openapi.json has a demo
//      handler or is listed as not in the demo (scripts/demo-contract.mjs);
//   2. the smoke run in headless Firefox along the suggested path
//      (scripts/demo-smoke.mjs), against the built demo at /volveran/demo/.
// Exits 1 naming each unhandled route, or the smoke step that failed.
//
//   npm run demo:check                 # builds into dist/demo-check, then checks
//   npm run demo:check -- <builtDir>   # checks a demo already built (Pages: _site/demo)
//   npm run demo:check -- <builtDir> <tag>
//
// Runs under tsx (the demo's API is TypeScript). Needs Firefox (FIREFOX, or
// firefox on PATH); SMOKE_SHOTS=<dir> keeps a screenshot of a failed step.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createDemoApi } from '../site/demo/api/demo-api.ts';
import { contractProblems } from './demo-contract.mjs';
import { buildDemo, latestReleaseTag, unpackDemoRelease } from './demo.mjs';
import { runSmoke } from './demo-smoke.mjs';
import { repoRoot } from './release-tag.mjs';

const [builtDir, tagArg] = process.argv.slice(2);
const tag = tagArg ?? latestReleaseTag();
const dir = builtDir ?? path.join(repoRoot, 'dist/demo-check');
const started = Date.now();

if (builtDir === undefined) await buildDemo(dir, tag);
else if (!existsSync(path.join(dir, 'index.html'))) throw new Error(`No built demo in ${dir}: run node scripts/demo.mjs build ${builtDir}.`);

let openapiFile = path.join(repoRoot, 'dist/demo-release', tag, 'openapi.json');
if (!existsSync(openapiFile)) openapiFile = path.join(unpackDemoRelease(tag), 'openapi.json');
const routes = createDemoApi().routes();
const contract = contractProblems(JSON.parse(readFileSync(openapiFile, 'utf8')), routes);
console.log(`Contract with the openapi.json of ${tag}: ${routes.handled.length} routes handled, ${routes.notInDemo.length} not in the demo.`);
for (const problem of contract) console.log(`FAIL contract: ${problem}`);
if (contract.length === 0) console.log('PASS contract: every route is handled or listed as not in the demo');

console.log(`Smoke run in headless Firefox against ${path.relative(repoRoot, dir) || dir}:`);
const smoke = await runSmoke({ dir, version: tag.replace(/^v/, '') });

const failures = [...contract, ...smoke];
console.log(`${failures.length ? 'Demo check failed' : 'Demo check passed'} in ${Math.round((Date.now() - started) / 1000)} s.`);
process.exit(failures.length ? 1 : 0);
