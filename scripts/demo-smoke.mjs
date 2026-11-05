// The demo's smoke run: the built demo (scripts/demo.mjs build) served at
// /volveran/demo/, as Pages serves it, walked in headless Firefox along the
// banner's suggested path: on production, a Checkout of orders.dlq, Replay
// of the timeouts with a Canary, the Canary dies again, Stop, Died Again in
// the next Checkout, a Discard Applied with the typed queue name, and its
// Restore from the audit log. No server and no broker: the demo answers the
// API in the page. scripts/demo-check.mjs runs it; on its own:
//
//   node scripts/demo-smoke.mjs <builtDir> <version>
//
// Needs Firefox (FIREFOX, or firefox on PATH). Prints a line per step and
// stops at the first that fails; SMOKE_SHOTS=<dir> keeps a screenshot of it.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const BASE_PATH = '/volveran/demo/';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png' };
/** How long a step may wait for what it expects; the Canary's watch is 15 s on production. */
const STEP_TIMEOUT_MS = 20_000;

/** @returns {string} */
export function firefoxPath() {
  if (process.env.FIREFOX) return process.env.FIREFOX;
  try {
    return execFileSync('which', ['firefox'], { encoding: 'utf8' }).trim();
  } catch {
    const mac = '/Applications/Firefox.app/Contents/MacOS/firefox';
    if (fs.existsSync(mac)) return mac;
    throw new Error('No Firefox: set FIREFOX or put firefox on PATH.');
  }
}

/**
 * Serves `dir` at /volveran/demo/; records every request for anything else, which the demo should never make.
 * @param {string} dir
 * @param {string[]} outside
 * @returns {Promise<{ url: string, close: () => void }>}
 */
function serve(dir, outside) {
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    if (!pathname.startsWith(BASE_PATH) || pathname.includes('/api/')) {
      // The browser asks the origin for its icon by itself; on Pages that is the landing page's.
      if (pathname !== '/favicon.ico') outside.push(pathname);
      res.writeHead(404).end();
      return;
    }
    let file = path.join(dir, decodeURIComponent(pathname.slice(BASE_PATH.length)) || 'index.html');
    if (!file.startsWith(path.resolve(dir)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dir, 'index.html');
    res.writeHead(200, { 'content-type': TYPES[/** @type {keyof typeof TYPES} */ (path.extname(file))] ?? 'application/octet-stream' }).end(fs.readFileSync(file));
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const address = /** @type {import('node:net').AddressInfo} */ (server.address());
      resolve({ url: `http://127.0.0.1:${address.port}${BASE_PATH}`, close: () => server.close() });
    }),
  );
}

/**
 * Walks the suggested path; returns the failures, empty when every step passed.
 * @param {{ dir: string, version: string, firefox?: string, shots?: string, log?: (line: string) => void }} options
 * @returns {Promise<string[]>}
 */
export async function runSmoke({ dir, version, firefox = firefoxPath(), shots = process.env.SMOKE_SHOTS, log = console.log }) {
  /** @type {string[]} */
  const outside = [];
  /** @type {string[]} */
  const pageErrors = [];
  const site = await serve(path.resolve(dir), outside);
  const browser = await puppeteer.launch({ browser: 'firefox', executablePath: firefox, headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on('pageerror', (e) => pageErrors.push(String(/** @type {Error} */ (e).message ?? e)));
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(m.text());
  });

  const text = () => page.evaluate(() => document.body.innerText);
  /**
   * Waits until `fn` (run in the page) answers truthy.
   * @template T
   * @param {string} what
   * @param {(...args: any[]) => T} fn
   * @param {...any} args
   */
  const until = async (what, fn, ...args) => {
    try {
      return await page.waitForFunction(fn, { timeout: STEP_TIMEOUT_MS, polling: 200 }, ...args);
    } catch {
      throw new Error(`timed out waiting for ${what}`);
    }
  };
  /** Clicks the element `fn` (run in the page) finds, once it does. */
  const clickFound = async (/** @type {string} */ what, /** @type {(...args: any[]) => Element | undefined | null} */ fn, /** @type {any[]} */ ...args) => {
    const found = await until(what, fn, ...args);
    await found.evaluate((el) => /** @type {HTMLElement} */ (/** @type {unknown} */ (el)).click());
  };
  const untilText = (/** @type {RegExp} */ pattern) => until(`the page to show ${pattern}`, (source, flags) => new RegExp(source, flags).test(document.body.innerText), pattern.source, pattern.flags);
  /** Clicks the first enabled element matching `selector` whose text starts with `label`, once there is one. */
  const click = (/** @type {string} */ selector, /** @type {string} */ label) =>
    clickFound(
      `${selector} "${label}"`,
      (s, l) => [...document.querySelectorAll(s)].find((e) => e.textContent?.trim().startsWith(l) && !(/** @type {HTMLButtonElement} */ (e).disabled)),
      selector,
      label,
    );
  const shift = async (/** @type {import('puppeteer-core').KeyInput} */ key) => {
    await page.keyboard.down('Shift');
    await page.keyboard.press(key);
    await page.keyboard.up('Shift');
  };
  const checkOut = async (/** @type {string} */ queue) => {
    await clickFound(
      `the Check out button of ${queue}`,
      (q) => {
        const row = [...document.querySelectorAll('table.queues tr')].find((r) => r.querySelector('.name')?.firstChild?.textContent?.trim() === q);
        return [...(row?.querySelectorAll('button') ?? [])].find((b) => /check ?out/i.test(b.textContent ?? '') && !(/** @type {HTMLButtonElement} */ (b).disabled));
      },
      queue,
    );
    await until('the Checkout to hold Messages', () => document.querySelectorAll('.message-list tbody tr').length > 0);
  };
  /** Types the queue name a Protected Profile asks for, then confirms. */
  const confirmTyped = async (/** @type {string} */ dialog, /** @type {string} */ confirm) => {
    await until('the queue name field', (d) => document.querySelector(`${d} input[aria-label="Queue name"]`), dialog);
    const disabled = await page.evaluate((d) => [...document.querySelectorAll(`${d} button.danger`)].every((b) => /** @type {HTMLButtonElement} */ (b).disabled), dialog);
    if (!disabled) throw new Error('the confirmation is enabled before the queue name is typed');
    await page.type(`${dialog} input[aria-label="Queue name"]`, 'orders.dlq');
    await click(`${dialog} button.danger`, confirm);
  };

  /** @type {Array<[string, () => Promise<void>]>} */
  const steps = [
    [
      `the demo loads with the banner naming Volverán ${version}`,
      async () => {
        await page.goto(site.url);
        await until('the queue list', () => document.querySelector('table.queues'));
        const banner = await page.evaluate(() => document.getElementById('demo-banner')?.innerText ?? '');
        if (!banner.includes(`Volverán ${version}`)) throw new Error(`the banner says "${banner}"`);
        if (!/nothing here touches a real broker/i.test(banner)) throw new Error('the banner does not say nothing touches a real broker');
      },
    ],
    [
      'Check out orders.dlq on production',
      async () => {
        // The demo opens on production (adapters.ts seeds the remembered Broker Profile).
        const profile = await page.evaluate(() => {
          const select = [...document.querySelectorAll('label')].find((l) => l.textContent?.startsWith('Broker Profile'))?.querySelector('select');
          if (!select) throw new Error('no Broker Profile select');
          return select.value;
        });
        if (profile !== 'production') throw new Error(`the demo opens on ${profile}, not production`);
        await checkOut('orders.dlq');
        await untilText(/production/);
      },
    ],
    [
      'give the SQLTimeoutException timeouts Replay',
      async () => {
        await page.select('select[aria-label="Filter by"]', 'failure');
        await page.type('input[aria-label$="value"]', 'SQLTimeoutException');
        await page.keyboard.press('Enter');
        await click('button', 'Select all');
        await page.click('.message-list tbody tr td.name');
        await shift('R');
        await page.keyboard.press('Escape');
        await untilText(/4 Replay/);
      },
    ],
    [
      'Apply asks for the typed queue name and a Canary',
      async () => {
        await click('.apply-panel button', 'Apply');
        await until('the Apply confirmation', () => document.querySelector('dialog[open]'));
        const prompt = await page.evaluate(() => /** @type {HTMLElement} */ (document.querySelector('dialog[open]')).innerText);
        if (!/type orders\.dlq to confirm/i.test(prompt)) throw new Error('production does not ask for the queue name');
        if (!/requires a Canary/i.test(prompt)) throw new Error('no Canary required above 3 Replays');
        await confirmTyped('dialog[open]', '');
      },
    ],
    ['the Canary dies again within the Watch Window', () => untilText(/dead-lettered again/i)],
    [
      'Stop leaves the rest as Keep',
      async () => {
        await click('.canary-panel button', 'Stop');
        await untilText(/not attempted/i);
        await click('button', 'Back to queues');
      },
    ],
    [
      'the next Checkout shows the Canary Died Again',
      async () => {
        await checkOut('orders.dlq');
        await until('the Canary Message flagged Died Again', () =>
          [...document.querySelectorAll('.message-list tbody tr')].some((r) => r.textContent?.includes('ord-d9d6-0004') && r.querySelector('.badge.died-again')),
        );
      },
    ],
    [
      'Discard a Message and Apply with the typed queue name',
      async () => {
        await page.click('.message-list tbody tr td.name');
        await shift('D');
        await until('the Discard reason', () => document.querySelector('dialog.prompt input[type=text]'));
        await page.type('dialog.prompt input[type=text]', 'Smoke run: duplicate order');
        await click('dialog button[type=submit]', 'Discard');
        await untilText(/1 Discard/);
        await click('.apply-panel button', 'Apply');
        await until('the Apply confirmation', () => document.querySelector('dialog[open]'));
        await confirmTyped('dialog[open]', '');
        await click('button', 'Back to queues');
      },
    ],
    [
      'Restore the Discard from the audit log',
      async () => {
        await click('.view-switch button', 'Audit');
        await untilText(/Smoke run: duplicate order/);
        await click('button', 'Restore…');
        const dialog = '[role=alertdialog][aria-label="Confirm Restore"]';
        await until('the Restore confirmation', (d) => document.querySelector(d), dialog);
        await confirmTyped(dialog, 'Confirm Restore');
        await untilText(/Restored to orders\.dlq/);
      },
    ],
    [
      'no page errors, and no request left the demo',
      async () => {
        if (pageErrors.length) throw new Error(`page errors: ${pageErrors.join(' | ')}`);
        if (outside.length) throw new Error(`requests outside the demo: ${outside.join(', ')}`);
      },
    ],
  ];

  /** @type {string[]} */
  const failures = [];
  try {
    for (const [name, run] of steps) {
      const started = Date.now();
      try {
        await run();
        log(`PASS ${name} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
      } catch (err) {
        failures.push(`smoke step "${name}": ${/** @type {Error} */ (err).message}`);
        log(`FAIL ${name}: ${/** @type {Error} */ (err).message}`);
        if (shots) {
          fs.mkdirSync(shots, { recursive: true });
          await page.screenshot({ path: path.join(shots, 'smoke-failed.png') });
          fs.writeFileSync(path.join(shots, 'smoke-failed.txt'), await text());
        }
        break;
      }
    }
  } finally {
    await browser.close();
    site.close();
  }
  return failures;
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const [dir, version] = process.argv.slice(2);
  if (!dir || !version) throw new Error('Usage: node scripts/demo-smoke.mjs <builtDir> <version>');
  const failures = await runSmoke({ dir, version });
  process.exit(failures.length ? 1 : 0);
}
