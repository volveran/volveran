// A check by hand, in real headless Firefox, of what the suites cannot show: Approvals, Compare,
// Canary and Restore in the built web app under its CSP, and that a browser's request from a
// foreign Origin or Host is refused. No browser runner is part of the test suites (#92), so run
// this on a release candidate:
//
//   npm run build
//   node scripts/test-broker.mjs run -- node scripts/screenshots/browser-check.mjs <outdir>
//
// Needs Firefox on PATH. It prints a line per step, and exits 1 if any failed. SHOT_SLOW=3
// stretches every wait.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const outDir = process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), 'volveran-browser-check-'));
fs.mkdirSync(outDir, { recursive: true });
const here = path.dirname(new URL(import.meta.url).pathname);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'volveran-browser-check-'));
const slow = Number(process.env.SHOT_SLOW ?? 1);
const wait = (ms) => new Promise((r) => setTimeout(r, ms * slow));
const REBOUND = 'rebound.example';
const FIRST_PORT = Number(process.env.SHOT_PORT ?? 18190);
const [TEAM, SOLO, SOLO_PUBLIC, FOREIGN] = [0, 1, 2, 3].map((n) => FIRST_PORT + n);
const teamBase = `http://127.0.0.1:${TEAM}/`;
const soloBase = `http://127.0.0.1:${SOLO}/`;
const ORDERS = `api/v1/profiles/staging/vhosts/%2F/queues/orders.dlq/checkouts`;

const results = [];
const seen = { violations: [], errors: [], failedRequests: [], refusedAnswers: [] };
const record = (ok, step, detail = '') => {
  results.push({ ok, step });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${step}${detail ? `: ${detail}` : ''}`);
};

// ---------------------------------------------------------------- the servers
const profiles = fs
  .readFileSync(path.join(here, 'profiles.yaml'), 'utf8')
  .replaceAll('MGMT_PORT', process.env.VOLVERAN_TEST_MGMT_PORT)
  .replaceAll('AMQP_PORT', process.env.VOLVERAN_TEST_AMQP_PORT);
fs.writeFileSync(path.join(tmp, 'profiles.yaml'), profiles);

const servers = [];
async function startServer(name, port, env) {
  const log = fs.openSync(path.join(outDir, `server-${name}.log`), 'w');
  const server = spawn('node', ['dist/server/main.js'], {
    stdio: ['ignore', log, log],
    env: {
      ...process.env,
      VOLVERAN_PROFILES_FILE: path.join(tmp, 'profiles.yaml'),
      VOLVERAN_DATA_DIR: path.join(tmp, `data-${name}`),
      VOLVERAN_PORT: String(port),
      VOLVERAN_SHOT_WEBHOOK_URL: `http://127.0.0.1:${FOREIGN}/hook`,
      VOLVERAN_TEST_PASSWORD: 'volveran-admin-pass',
      ...env,
    },
  });
  servers.push(server);
  for (let i = 0; ; i++) {
    const ready = await fetch(`http://127.0.0.1:${port}/readyz`).then((r) => r.ok, () => false);
    if (ready) return;
    if (i === 60 || server.exitCode !== null) throw new Error(`the ${name} server did not start; see server-${name}.log`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// A page of another site, on another port: for cookies, 127.0.0.1 on another port is the same
// site, so SameSite=Lax lets the session through, as for a sibling subdomain.
const foreignSite = http.createServer((req, res) => {
  req.resume();
  res.setHeader('content-type', 'text/html');
  res.end('<!doctype html><title>A foreign site</title><p>A foreign site</p>');
});

// ---------------------------------------------------------------- a page and its watch
function watched(page, name) {
  page.setDefaultNavigationTimeout(120000);
  page.setDefaultTimeout(60000);
  page.on('console', (m) => {
    if (/content.security.policy/i.test(m.text())) seen.errors.push(`${name} console: ${m.text()}`);
  });
  // A font cut off by leaving the page is reported like this too; a font the CSP refused is a violation.
  page.on('pageerror', (e) => (/downloadable font: download failed/.test(e.message) ? seen.failedRequests : seen.errors).push(`${name} pageerror: ${e.message}`));
  page.on('requestfailed', (r) => seen.failedRequests.push(`${name} ${r.method()} ${r.url()}`));
  page.on('response', (r) => {
    if (r.status() >= 400) seen.refusedAnswers.push(`${name} ${r.status()} ${r.request().method()} ${r.url()}`);
  });
  return page.evaluateOnNewDocument(() => {
    window.__violations = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__violations.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
}
const drainViolations = async (page, name) => {
  const found = await page.evaluate(() => (window.__violations ?? []).splice(0));
  seen.violations.push(...found.map((v) => `${name}: ${v}`));
  return found;
};
const clickText = async (page, selector, text) => {
  const clicked = await page.evaluate(
    (selector, text) => {
      const el = [...document.querySelectorAll(selector)].find((e) => e.textContent.trim().startsWith(text) && !e.disabled);
      el?.click();
      return Boolean(el);
    },
    selector,
    text,
  );
  if (!clicked) throw new Error(`no ${selector} "${text}"`);
  await wait(500);
};
const waitForText = (page, text, timeout = 60000) =>
  page.waitForFunction((text) => document.body.innerText.includes(text), { timeout }, text);
const pressShift = async (page, key) => {
  await page.keyboard.down('Shift');
  await page.keyboard.press(key);
  await page.keyboard.up('Shift');
};
const pickProfile = async (page, name) => {
  await page.evaluate((name) => {
    const select = document.querySelector('.topbar select');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, name);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }, name);
  await wait(1200);
};
const startCheckout = async (page, queue) => {
  for (let attempt = 0; ; attempt++) {
    const clicked = await page.evaluate((queue) => {
      const row = [...document.querySelectorAll('table.queues tr')].find((r) => r.querySelector('.name')?.firstChild?.textContent.trim() === queue);
      const button = row && [...row.querySelectorAll('button')].find((b) => /check ?out/i.test(b.textContent) && !b.disabled);
      button?.click();
      return Boolean(button);
    }, queue);
    if (clicked) break;
    if (attempt === 12) throw new Error(`cannot check out ${queue}`);
    await wait(5000);
    await clickText(page, '.controls button', 'Refresh');
  }
  await page.waitForSelector('.message-list tbody tr td.name');
  await wait(1000);
  await page.click('.message-list tbody tr td.name');
  await wait(500);
};
async function signIn(page, sub, name) {
  await page.goto(teamBase, { waitUntil: 'load' });
  await page.waitForSelector('input[name=username]');
  await page.evaluate(
    (sub, name) => {
      document.querySelector('input[name=username]').value = sub;
      document.querySelector('textarea[name=claims]').value = JSON.stringify({ name, email: `${sub}@example.com` });
      document.querySelector('form').submit();
    },
    sub,
    name,
  );
  await page.waitForSelector('.topbar select');
  await waitForText(page, `${sub}@example.com`);
  await wait(1000);
}
async function step(name, page, run) {
  try {
    const detail = await run();
    record(true, name, typeof detail === 'string' ? detail : '');
  } catch (err) {
    record(false, name, err.message);
    await page.screenshot({ path: path.join(outDir, `FAIL-${name.replace(/\W+/g, '-')}.png`) }).catch(() => {});
  }
}

/** A form POST from the foreign site to `url`: the status and whether the answer names `code`. */
async function formFromForeignSite(page, url, code) {
  await page.goto(`http://127.0.0.1:${FOREIGN}/`, { waitUntil: 'load' });
  const [response] = await Promise.all([
    page.waitForNavigation({ waitUntil: 'load' }),
    page.evaluate((url) => {
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = url;
      document.body.append(form);
      form.submit();
    }, url),
  ]);
  const status = response?.status();
  const text = await page.content();
  if (status !== 403 || !text.includes(code)) throw new Error(`answered ${status}: ${text.slice(0, 300)}`);
  return `403 ${code}`;
}

// ---------------------------------------------------------------- the check
const browser = await puppeteer.launch({
  browser: 'firefox',
  executablePath: process.env.FIREFOX ?? spawnSync('sh', ['-c', 'command -v firefox'], { encoding: 'utf8' }).stdout.trim(),
  headless: true,
  // Firefox resolves this name to a loopback address: the Host a DNS-rebinding page sends.
  extraPrefsFirefox: { 'network.dns.localDomains': REBOUND },
});
let exitCode = 1;
try {
  console.log(`Firefox: ${await browser.version()}`);
  foreignSite.listen(FOREIGN, '127.0.0.1');
  const issuer = `http://127.0.0.1:${process.env.VOLVERAN_TEST_OIDC_PORT}/default`;
  await startServer('team', TEAM, {
    VOLVERAN_AUTH: 'oidc',
    VOLVERAN_OIDC_ISSUER: issuer,
    VOLVERAN_OIDC_CLIENT_ID: 'volveran-test',
    VOLVERAN_OIDC_CLIENT_SECRET: 'volveran-test-secret',
    VOLVERAN_OIDC_REDIRECT_URL: `${teamBase}auth/callback`,
    VOLVERAN_SESSION_SECRET: 'browser-check-session-secret-0123456789',
  });
  await startServer('solo', SOLO, { VOLVERAN_OPERATOR: 'ana' });
  await startServer('solo-public', SOLO_PUBLIC, { VOLVERAN_OPERATOR: 'ana', VOLVERAN_PUBLIC_URL: `http://${REBOUND}:${SOLO_PUBLIC}` });
  const seeded = spawnSync('node', [path.join(here, 'seed.mjs')], { stdio: 'inherit' });
  if (seeded.status !== 0) throw new Error('seeding failed');

  const rita = await (await browser.createBrowserContext()).newPage();
  const abel = await (await browser.createBrowserContext()).newPage();
  await watched(rita, 'rita');
  await watched(abel, 'abel');
  await rita.setViewport({ width: 1440, height: 900 });
  await abel.setViewport({ width: 1440, height: 900 });

  await step('Team Mode: two Operators sign in through the provider', rita, async () => {
    await signIn(rita, 'rita', 'Rita Requester');
    await signIn(abel, 'abel', 'Abel Approver');
  });

  await step('Request Approval of an Apply on a Protected Profile', rita, async () => {
    await pickProfile(rita, 'production');
    await startCheckout(rita, 'payments.dlq');
    await pressShift(rita, 'D');
    await wait(500);
    await rita.type('dialog.prompt input[type=text]', 'Browser check: Discard');
    await clickText(rita, 'dialog button[type=submit]', 'Discard');
    await rita.keyboard.press('j');
    for (let i = 0; i < 4; i++) {
      await rita.keyboard.press(' ');
      await rita.keyboard.press('j');
    }
    await pressShift(rita, 'R');
    await wait(600);
    await rita.keyboard.press('Escape');
    await clickText(rita, 'button', 'Request Approval…');
    await rita.type('dialog .type-queue-name input', 'payments.dlq');
    await wait(300);
    await clickText(rita, 'dialog button', 'Request Approval');
    await waitForText(rita, 'Approval');
    await rita.screenshot({ path: path.join(outDir, 'approval-requested.png') });
  });

  await step('Approvals: the approver opens it and sees the Decisions', abel, async () => {
    await clickText(abel, '.view-switch button', 'Approvals');
    await waitForText(abel, 'payments.dlq');
    await clickText(abel, 'button', 'Open');
    await waitForText(abel, 'Decisions:');
    await abel.screenshot({ path: path.join(outDir, 'approvals.png') });
  });

  await step('Compare: two Messages side by side, from the waiting Approval', abel, async () => {
    const boxes = await abel.$$('.message-list td.select input[type=checkbox]');
    await boxes[0].click();
    await boxes[2].click();
    await clickText(abel, '.decision-bar button', 'Compare');
    await abel.waitForSelector('.comparison, [class*=compar]');
    await wait(1200);
    await abel.screenshot({ path: path.join(outDir, 'compare-approval.png') });
    await clickText(abel, 'button', 'Close comparison');
  });

  await step('Approve and Apply: the Canary runs and waits', abel, async () => {
    await clickText(abel, 'button', 'Approve…');
    await abel.type('.confirm .type-queue-name input', 'payments.dlq');
    await wait(300);
    await clickText(abel, 'button', 'Approve and Apply');
    await abel.waitForSelector('.canary-panel');
    await waitForText(abel, 'Continue with the rest');
    await abel.screenshot({ path: path.join(outDir, 'canary.png') });
  });

  await step('Canary: continuing carries out the rest', abel, async () => {
    await clickText(abel, 'button', 'Continue with the rest');
    await waitForText(rita, 'Outcome', 120000).catch(() => {});
    for (let i = 0; ; i++) {
      const [done] = await rita.evaluate(async () => {
        const res = await fetch('/api/v1/audit-entries?queue=payments.dlq&action=replay');
        const { entries } = await res.json();
        return [entries.filter((e) => e.outcome === 'done').length];
      });
      if (done >= 4) return `${done} Replays done`;
      if (i === 60) throw new Error(`${done} Replays done`);
      await wait(2000);
    }
  });

  await step('Restore: the Discarded Message goes back, with the queue name typed', rita, async () => {
    await rita.goto(teamBase, { waitUntil: 'load' });
    await rita.waitForSelector('.view-switch');
    await clickText(rita, '.view-switch button', 'Audit');
    await waitForText(rita, 'Browser check: Discard');
    await clickText(rita, 'button', 'Restore…');
    await rita.type('.confirm .type-queue-name input', 'payments.dlq');
    await wait(300);
    await clickText(rita, 'button', 'Confirm Restore');
    await waitForText(rita, 'Restored to payments.dlq');
    await rita.screenshot({ path: path.join(outDir, 'restore.png') });
  });

  await step('Team Mode: a form POST from a foreign Origin is refused, with the session cookie sent', rita, async () => {
    const detail = await formFromForeignSite(rita, `${teamBase}${ORDERS}`, 'foreign_origin');
    await rita.goto(teamBase, { waitUntil: 'load' });
    return detail;
  });

  await step('Team Mode: a bodyless fetch from a foreign Origin starts no Checkout', rita, async () => {
    await rita.goto(`http://127.0.0.1:${FOREIGN}/`, { waitUntil: 'load' });
    await rita.evaluate((url) => fetch(url, { method: 'POST', mode: 'no-cors', credentials: 'include' }).then(() => {}, () => {}), `${teamBase}${ORDERS}`);
    await wait(1500);
    await rita.goto(teamBase, { waitUntil: 'load' });
    await rita.waitForSelector('.topbar select');
    await wait(1000);
    // The Operator may hold one Checkout: had that fetch started one, the next step's start would
    // be refused, and it would hold this queue.
    const held = await rita.evaluate(async () => {
      const res = await fetch('/api/v1/profiles/staging/vhosts/%2F/queues');
      const { queues } = await res.json();
      return queues.find((q) => q.name === 'orders.dlq');
    });
    if (held === undefined) throw new Error('orders.dlq is not in the queue list');
    if (held.checkedOutBy) throw new Error(`the queue is held: ${JSON.stringify(held.checkedOutBy)}`);
  });

  await step('Compare: from a Checkout, in the app still working after the refusals', rita, async () => {
    await pickProfile(rita, 'staging');
    await startCheckout(rita, 'orders.dlq');
    const boxes = await rita.$$('.message-list td.select input[type=checkbox]');
    await boxes[0].click();
    await boxes[2].click();
    await clickText(rita, 'button', 'Compare');
    await rita.waitForSelector('.comparison, [class*=compar]');
    await wait(1200);
    await rita.screenshot({ path: path.join(outDir, 'compare-checkout.png') });
    await clickText(rita, 'button', 'Close comparison');
    await clickText(rita, 'button', 'End Checkout');
    await wait(1500);
  });

  await step('Leaving the page ends the Checkout, under the Origin check and no-referrer', rita, async () => {
    await rita.goto(teamBase, { waitUntil: 'load' });
    await rita.waitForSelector('.topbar select');
    await wait(1000);
    await pickProfile(rita, 'staging');
    await startCheckout(rita, 'orders.dlq');
    await rita.goto(teamBase, { waitUntil: 'load' });
    await rita.waitForSelector('.topbar select');
    for (let i = 0; ; i++) {
      const held = await rita.evaluate(async () => {
        const res = await fetch('/api/v1/profiles/staging/vhosts/%2F/queues');
        return (await res.json()).queues.find((q) => q.name === 'orders.dlq').checkedOutBy;
      });
      if (!held) return `free after about ${i} s`;
      // The heartbeat would free it at 120 s: this must be the page's own end.
      if (i === 30) throw new Error(`still held: ${JSON.stringify(held)}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  });

  await step('The web app runs under the CSP, with its fonts', rita, async () => {
    const { csp, fonts } = await rita.evaluate(async () => {
      await document.fonts.ready;
      return { csp: (await fetch('/')).headers.get('content-security-policy'), fonts: [...document.fonts].filter((f) => f.status === 'loaded').length };
    });
    if (!csp?.includes("default-src 'self'") && !csp?.includes("script-src 'self'")) throw new Error(`policy: ${csp}`);
    if (fonts === 0) throw new Error('no font loaded');
    return `${fonts} fonts loaded; ${csp}`;
  });

  await drainViolations(rita, 'rita');
  await drainViolations(abel, 'abel');

  await step('Control: an inline script added by hand is refused and reported, so the watch would see a breach', rita, async () => {
    const reportedBefore = seen.errors.length;
    await rita.evaluate(() => {
      const script = document.createElement('script');
      script.textContent = 'window.__ranInline = true';
      document.head.append(script);
    });
    await wait(800);
    const found = await rita.evaluate(() => (window.__violations ?? []).splice(0));
    const ran = await rita.evaluate(() => window.__ranInline === true);
    seen.errors.length = reportedBefore;
    if (ran || found.length === 0) throw new Error(`ran: ${ran}, reported: ${found.length}`);
    return found.join(', ');
  });

  const solo = await (await browser.createBrowserContext()).newPage();
  await watched(solo, 'solo');

  await step('Solo Mode: the web app works at a loopback address', solo, async () => {
    await solo.goto(soloBase, { waitUntil: 'load' });
    await solo.waitForSelector('table.queues');
  });

  await step('Solo Mode: a page reached under a name that is not loopback is refused', solo, async () => {
    const response = await solo.goto(`http://${REBOUND}:${SOLO}/`, { waitUntil: 'load' });
    const text = await solo.content();
    if (response.status() !== 403 || !text.includes('foreign_host')) throw new Error(`answered ${response.status()}: ${text.slice(0, 300)}`);
    return '403 foreign_host';
  });

  await step('Solo Mode: a form POST from a foreign Origin is refused', solo, () =>
    formFromForeignSite(solo, `${soloBase}${ORDERS}`, 'foreign_origin'),
  );

  await step('Solo Mode: with VOLVERAN_PUBLIC_URL, that name works', solo, async () => {
    const response = await solo.goto(`http://${REBOUND}:${SOLO_PUBLIC}/`, { waitUntil: 'load' });
    if (response.status() !== 200) throw new Error(`answered ${response.status()}`);
    await solo.waitForSelector('table.queues');
  });

  await drainViolations(solo, 'solo').catch(() => {});

  record(seen.violations.length === 0 && seen.errors.length === 0, 'No CSP violation, console report of one, or page error', [...seen.violations, ...seen.errors].join('; '));
  const expected = [/ 401 GET .*\/api\/v1\/(session|profiles)$/, new RegExp(` 403 POST .*/${ORDERS}$`), new RegExp(` 403 GET http://${REBOUND}:${SOLO}/`)];
  const unexpected = seen.refusedAnswers.filter((line) => !expected.some((pattern) => pattern.test(line)));
  record(unexpected.length === 0, 'No answer of 400 or above but the refusals asked for and the 401 before sign-in', unexpected.join('; '));
  console.log(`Failed requests (${seen.failedRequests.length}):`);
  for (const line of seen.failedRequests) console.log(`  ${line}`);
  console.log(`Answers of 400 and above (${seen.refusedAnswers.length}):`);
  for (const line of seen.refusedAnswers) console.log(`  ${line}`);
  exitCode = results.every((r) => r.ok) ? 0 : 1;
  console.log(`${results.filter((r) => r.ok).length} of ${results.length} passed. Screenshots and server logs: ${outDir}`);
} finally {
  await browser.close().catch(() => {});
  foreignSite.close();
  for (const server of servers) server.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 1500));
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(exitCode);
