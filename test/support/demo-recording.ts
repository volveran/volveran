// The committed demo recording (docs/demo/recording.json), read from disk: the
// demo page fetches it, so the demo's API takes it as a parameter.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRecording, type Recording } from '../../site/demo/api/recording.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const committedRecording: Recording = parseRecording(readFileSync(path.join(root, 'docs/demo/recording.json'), 'utf8'));
