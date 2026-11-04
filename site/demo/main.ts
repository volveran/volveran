// The demo page: install the demo, then load the release's web app unchanged.
// `@release/web` is the release tag's src/web (scripts/demo.mjs unpacks it).
// Order matters: ES modules run in import order, so nothing the web app does
// on load reaches the network or storage.
import './browser/install.js';
import './browser/banner.js';
import '@release/web/main.tsx';
