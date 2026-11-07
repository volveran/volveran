// The demo page: load the recording, install the demo, then load the release's
// web app unchanged. `@release/web` is the release tag's src/web (scripts/demo.mjs
// unpacks it). The recording is its own file next to the page, fetched before
// the demo's fetch is installed, and the web app is imported only once the demo
// answers its API: nothing it does on load reaches the network or storage.
import recordingUrl from '../../docs/demo/recording.json?url';
import { fetchRecording } from './browser/adapters.js';
import { showStartFailure } from './browser/banner.js';
import { installDemo } from './browser/install.js';

void fetchRecording(window.fetch.bind(window), recordingUrl).then(
  (recorded) => {
    installDemo(recorded);
    return import('@release/web/main.tsx');
  },
  showStartFailure,
);
