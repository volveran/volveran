// The metrics listener: GET /metrics on a port of its own, only when
// VOLVERAN_METRICS_PORT is set. It has no session and no other routes, and
// shares nothing with the web app's port, so an HTTPRoute or Ingress to that
// port can never reach it. A scrape only reads what `families` gives from
// this process: it never contacts a broker.
import http from 'node:http';
import { renderMetrics, type MetricFamily } from './exposition.js';

export interface MetricsListenerOptions {
  host: string;
  /** 0 picks a free port. */
  port: number;
  /** Asked once per scrape. */
  families(): MetricFamily[];
  /** A scrape broke; it is answered 500. */
  onError(err: unknown): void;
}

export interface MetricsListener {
  port: number;
  close(): Promise<void>;
}

const CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

export async function startMetricsListener(options: MetricsListenerOptions): Promise<MetricsListener> {
  const server = http.createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== '/metrics' || (req.method !== 'GET' && req.method !== 'HEAD')) {
      res.writeHead(404).end();
      return;
    }
    try {
      const body = renderMetrics(options.families());
      res.writeHead(200, { 'content-type': CONTENT_TYPE });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (err) {
      options.onError(err);
      res.writeHead(500).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  return {
    port: typeof address === 'object' && address ? address.port : options.port,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        // A scraper keeps its connection open between scrapes.
        server.closeAllConnections();
      }),
  };
}
