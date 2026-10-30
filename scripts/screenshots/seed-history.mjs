// Gives two dead-letter queues 24 hours of Samples: an incident that builds up
// and is triaged away. The sampler only adds Samples from now on, one at a time.
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(process.argv[2]);
const minute = 60_000;
const now = Date.now();
const sample = db.prepare('INSERT OR IGNORE INTO history_samples (profile, vhost, queue, at, depth, estimated_arrivals) VALUES (?, ?, ?, ?, ?, ?)');
const run = db.prepare('INSERT OR IGNORE INTO sampling_runs (profile, at, ok, error_code, interval_ms) VALUES (?, ?, 1, NULL, ?)');

// Depth at a share of the day, by straight lines between these points.
const curves = {
  'orders.dlq': [[0, 3], [0.45, 4], [0.55, 140], [0.62, 210], [0.7, 215], [0.72, 60], [0.8, 58], [0.82, 14], [1, 14]],
  'payments.dlq': [[0, 0], [0.3, 1], [0.58, 2], [0.66, 48], [0.74, 52], [0.76, 6], [1, 6]],
};
const depthAt = (points, share) => {
  const i = points.findIndex(([x]) => x >= share);
  const [x0, y0] = points[Math.max(i - 1, 0)];
  const [x1, y1] = points[i];
  return Math.round(x1 === x0 ? y1 : y0 + ((y1 - y0) * (share - x0)) / (x1 - x0));
};

db.exec('BEGIN');
for (let m = 1440; m > 1; m--) {
  const at = now - m * minute;
  run.run('staging', at, minute);
  for (const [queue, points] of Object.entries(curves)) {
    const depth = depthAt(points, 1 - m / 1440);
    const before = depthAt(points, 1 - (m + 1) / 1440);
    sample.run('staging', '/', queue, at, depth, Math.max(depth - before, 0));
  }
}
db.exec('COMMIT');
db.close();
