// Screenshot driver: node shot.mjs <outdir> <theme light|dark> <scenario...>
// Drives Firefox (headless, $FIREFOX) through puppeteer-core over WebDriver BiDi.
// See capture.sh. SHOT_SLOW multiplies every wait, for a busy machine.
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const [outDir, theme, ...scenarios] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const BASE = process.env.BASE ?? 'http://127.0.0.1:8080/';

const browser = await puppeteer.launch({
  browser: 'firefox',
  executablePath: process.env.FIREFOX,
  headless: true,
  extraPrefsFirefox: { 'layout.css.prefers-color-scheme.content-override': theme === 'dark' ? 0 : 1 },
});
const page = await browser.newPage();
page.setDefaultNavigationTimeout(300000);
page.setDefaultTimeout(180000);
await page.setViewport({ width: 1440, height: 900 });
const shiftKey = async (k) => { await page.keyboard.down('Shift'); await page.keyboard.press(k); await page.keyboard.up('Shift'); };
const slow = Number(process.env.SHOT_SLOW ?? 1);
const wait = (ms) => new Promise((r) => setTimeout(r, ms * slow));
const shot = async (name, full = false) => {
  await wait(400);
  await page.screenshot({ path: `${outDir}/${name}-${theme}.png`, fullPage: full });
  console.log('shot', name);
};
const clickText = async (sel, text) => {
  const ok = await page.evaluate(
    (sel, text) => {
      const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.trim().startsWith(text) && !e.disabled);
      if (!el) return false;
      el.click();
      return true;
    },
    sel,
    text,
  );
  if (!ok) throw new Error(`no ${sel} "${text}"`);
  await wait(500);
};
const pickProfile = async (name) => {
  await page.evaluate((name) => {
    const s = document.querySelector('.topbar select');
    const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    set.call(s, name);
    s.dispatchEvent(new Event('change', { bubbles: true }));
  }, name);
  await wait(1200);
};
// Discard the Selection, or else the focused Message, with a reason.
const discard = async (reason) => {
  await shiftKey('D');
  await wait(500);
  await page.type('dialog.prompt input[type=text]', reason);
  await clickText('dialog button[type=submit]', 'Discard');
};
const startCheckout = async (queue) => {
  // A Rule Pass may hold the queue for a moment: retry until Check out is offered.
  for (let attempt = 0; ; attempt++) {
    const clicked = await page.evaluate((queue) => {
      const row = [...document.querySelectorAll('table.queues tr')].find((r) => r.querySelector('.name')?.firstChild?.textContent.trim() === queue);
      const b = row && [...row.querySelectorAll('button')].find((b) => /check ?out/i.test(b.textContent) && !b.disabled);
      b?.click();
      return Boolean(b);
    }, queue);
    if (clicked) break;
    if (attempt === 12) throw new Error(`cannot check out ${queue}`);
    await wait(5000);
    await clickText('.controls button', 'Refresh');
  }
  await wait(2500);
  // Focus the first Message (and give the list the keyboard focus).
  await page.click('.message-list tbody tr td.name');
  await wait(500);
};
const endCheckout = async () => {
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((e) => e.textContent.trim() === 'End Checkout' && !e.disabled);
    b?.click();
  });
  await wait(1500);
};

const scenariosImpl = {
  // The stills of docs/images/flow.gif: Checkout, Decisions, Apply, outcome.
  async flow() {
    await pickProfile('staging');
    await shot('flow-1-queues');
    await startCheckout('orders.dlq');
    await shot('flow-2-checkout');
    await discard('Malformed currency, rejected upstream');
    await shot('flow-3-discard');
    await page.keyboard.press('j');
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press(' ');
      await page.keyboard.press('j');
    }
    await shiftKey('R');
    await page.keyboard.press('Escape');
    await wait(400);
    await shot('flow-4-replay');
    await clickText('button', 'Apply');
    await wait(800);
    await shot('flow-5-apply');
    await clickText('dialog button', 'Confirm Apply');
    await wait(5000);
    await shot('flow-6-outcome');
  },
  // The queue list of the unprotected profile, with set-up warnings.
  async queues() {
    await pickProfile('staging');
    await shot('queues');
  },
  async 'queues-protected'() {
    await pickProfile('production');
    await shot('queues-protected');
  },
  // History for the Audit view and Died Again: Discard one Message, Replay two
  // and Apply (die-again.mjs then dead-letters the Replayed ones again).
  async prep() {
    await pickProfile('staging');
    await startCheckout('orders.dlq');
    await discard('Duplicate of order 880210, already fulfilled');
    await page.keyboard.press('j');
    await page.keyboard.press(' ');
    await page.keyboard.press('j');
    await page.keyboard.press(' ');
    await shiftKey('R');
    await wait(600);
    await clickText('button', 'Apply');
    await clickText('dialog button', 'Confirm Apply');
    await wait(5000);
    await shot('prep');
  },
  // A Checkout with Decisions on the rail and a Died Again Message open, on staging.
  async checkout() {
    await pickProfile('staging');
    await startCheckout('orders.dlq');
    await discard('Malformed currency, rejected upstream');
    await page.keyboard.press('j');
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press(' ');
      await page.keyboard.press('j');
    }
    await shiftKey('R');
    await page.keyboard.press('Escape');
    await wait(400);
    await shiftKey('M');
    await wait(1200);
    await page.select('dialog select[aria-label="Destination queue"]', 'orders.parked');
    await clickText('dialog button[type=submit]', 'Move');
    for (let i = 0; i < 8; i++) await page.keyboard.press('j');
    await wait(1000);
    await shot('checkout');
  },
  async compare() {
    await pickProfile('staging');
    await startCheckout('orders.dlq');
    const boxes = await page.$$('.message-list td.select input[type=checkbox]');
    await boxes[0].click();
    await boxes[2].click();
    await clickText('button', 'Compare');
    await wait(1200);
    await shot('compare');
  },
  // The Apply confirmation on the Protected Profile, with Replays and a Discard.
  async 'apply-protected'() {
    await pickProfile('production');
    await startCheckout('payments.dlq');
    await discard('Amount over the capture limit');
    await page.keyboard.press('j');
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press(' ');
      await page.keyboard.press('j');
    }
    await shiftKey('R');
    await wait(600);
    await clickText('button', 'Apply');
    await wait(800);
    await shot('apply-protected');
  },
  // Confirm that Apply (typing the queue name) and wait at the Canary.
  async canary() {
    await scenariosImpl['apply-protected']();
    await page.type('dialog .type-queue-name input', 'payments.dlq');
    await wait(300);
    await clickText('dialog button', 'Confirm');
    await wait(3500);
    await shot('canary');
  },
  async audit() {
    await clickText('.view-switch button', 'Audit');
    await wait(1500);
    await shot('audit');
  },
  async rules() {
    await pickProfile('staging');
    await clickText('.view-switch button', 'Replay rules');
    await wait(1500);
    await shot('rules');
  },
  async shortcuts() {
    await pickProfile('staging');
    await page.keyboard.press('?');
    await shot('shortcuts');
  },
};

for (const s of scenarios) {
  await page.goto(BASE, { waitUntil: 'load' });
  await wait(1800);
  try {
    await scenariosImpl[s]();
  } catch (e) {
    console.log('FAIL', s, e.message);
    await page.screenshot({ path: `${outDir}/FAIL-${s}-${theme}.png` });
  }
  // End any Checkout this scenario left open.
  if (process.env.KEEP !== '1') await endCheckout();
  await page.goto('about:blank');
  await wait(1000);
}
await browser.close();
