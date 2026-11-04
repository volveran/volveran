// What the demo answers its read-only views with: the real server's answers,
// recorded by the screenshot run (capture.sh, through record-demo.mjs) from the
// same seeded broker and at the same moment as docs/images, so the demo shows
// what the screenshots show. Written to docs/demo/recording.json.
//
// Times stay as the server answered them, next to `recordedAt`; the demo moves
// them all forward to the moment it loads (site/demo/api/recording.ts).
// Nothing host-specific is kept: the broker's addresses and the webhook's URL
// are replaced, and the Operator of the run is renamed to the demo's.

/** The history ranges the web app offers, and how long each is; the whole retention uses the longest. */
export const HISTORY_RANGES = { '1h': 3_600_000, '24h': 86_400_000, '7d': 604_800_000 };

/** The Operator the demo signs in as. */
export const DEMO_OPERATOR = 'demo';

/** Fields that name an Operator, renamed from the run's to the demo's. */
const OPERATOR_FIELDS = new Set(['operator', 'operatorId', 'operatorName']);

/** What must never be in a recording: loopback addresses, temporary paths, the test broker's password. */
const HOST_SPECIFIC = ['127.0.0.1', 'localhost', '/tmp/', '/var/folders/', '/private/', '/Users/', '/home/', 'volveran-admin-pass'];

/**
 * Asks the server every read-only view the demo shows, on every Broker Profile and vhost, and
 * returns them as the demo serves them.
 * @param {(path: string) => Promise<any>} get answers a GET of a path under /api/v1, or throws
 * @param {{ recordedAt: string; operator: string; replace: Array<[string, string]> }} options
 *   `replace`: host-specific strings and what to put in their place
 */
export async function recordDemo(get, { recordedAt, operator, replace }) {
  const to = Date.parse(recordedAt);
  const seg = encodeURIComponent;
  const { profiles } = await get('/profiles');
  const alerts = await get('/alerts');
  const recorded = [];
  for (const summary of profiles) {
    const p = `/profiles/${seg(summary.name)}`;
    const { vhosts } = await get(`${p}/vhosts`);
    const { rules: alertRules } = await get(`${p}/alert-rules`);
    const { rules: replayRules } = await get(`${p}/replay-rules`);
    const recordedVhosts = [];
    for (const { name } of vhosts) {
      const v = `${p}/vhosts/${seg(name)}`;
      const queueList = await get(`${v}/queues?search=&onlyDeadLetterQueues=false`);
      const deadLetterMap = await get(`${v}/dead-letter-map`);
      const moveDestinations = await get(`${v}/move-destinations`);
      /** @type {Record<string, Record<string, unknown>>} */
      const histories = {};
      for (const queue of queueList.queues) {
        /** @type {Record<string, unknown>} */
        const byRange = {};
        for (const [range, length] of Object.entries(HISTORY_RANGES)) {
          const window = new URLSearchParams({ from: new Date(to - length).toISOString(), to: recordedAt });
          byRange[range] = await get(`${v}/queues/${seg(queue.name)}/history?${window}`);
        }
        histories[queue.name] = byRange;
      }
      recordedVhosts.push({ name, queueList, deadLetterMap, moveDestinations, histories });
    }
    recorded.push({ summary, alertRules, replayRules, vhosts: recordedVhosts });
  }
  return scrub({ recordedAt, profiles: recorded, alerts }, operator, replace);
}

/**
 * The host-specific values still in `value`, each named once, in the order of the list above.
 * @param {unknown} value
 * @returns {string[]}
 */
export function hostValuesIn(value) {
  const text = JSON.stringify(value);
  return HOST_SPECIFIC.filter((s) => text.includes(s));
}

/**
 * @param {any} recording
 * @param {string} operator
 * @param {Array<[string, string]>} replace
 */
function scrub(recording, operator, replace) {
  let text = JSON.stringify(recording);
  for (const [from, to] of replace) text = text.split(from).join(to);
  return JSON.parse(text, (key, value) => (OPERATOR_FIELDS.has(key) && value === operator ? DEMO_OPERATOR : value));
}
