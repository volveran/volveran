// Installs the demo in this page before the release's web app loads: main.ts
// imports it first, and ES modules run in import order.
import { createDemoApi } from '../api/demo-api.js';
import { inDemoUrl, installMemoryStorage, interceptFetch } from './adapters.js';

installMemoryStorage(window);

// One API per page load: a reload, or Reset demo, starts the scenario over.
const api = createDemoApi();
interceptFetch(window, api);

// The map rewrites the address with a root-relative link (replaceState).
for (const method of ['pushState', 'replaceState'] as const) {
  const original = history[method].bind(history);
  history[method] = (data: unknown, unused: string, url?: string | URL | null) =>
    original(data, unused, typeof url === 'string' ? (inDemoUrl(url, location.pathname) ?? url) : url);
}

// Links to the web app's views are rewritten where they appear, so a click, a
// middle-click or a copied link all stay in the demo.
function keepLinksInDemo(root: ParentNode) {
  for (const link of root.querySelectorAll<HTMLAnchorElement>('a[href^="/#"]')) {
    const inDemo = inDemoUrl(link.getAttribute('href')!, location.pathname);
    if (inDemo) link.setAttribute('href', inDemo);
  }
}
new MutationObserver(() => keepLinksInDemo(document)).observe(document, {
  subtree: true,
  childList: true,
  attributes: true,
  attributeFilter: ['href'],
});

// A link to the API (an Audit Entry's JSON) opens what the demo answers.
document.addEventListener(
  'click',
  (event) => {
    const link = event.target instanceof Element ? event.target.closest('a[href^="/api/"]') : null;
    if (!link) return;
    event.preventDefault();
    void window
      .fetch(link.getAttribute('href')!)
      .then((res) => res.text())
      .then((text) => window.open(URL.createObjectURL(new Blob([text], { type: 'application/json' })), '_blank'));
  },
  true,
);
