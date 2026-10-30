// A fake HTTP receiver for notifications, started by a test as the test OIDC
// provider is: it records each request and answers with the statuses it is told.
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ReceivedRequest {
  path: string;
  headers: http.IncomingHttpHeaders;
  /** The raw body, as a signature covers it. */
  text: string;
  json: any;
}

export interface FakeReceiver {
  url: string;
  received: ReceivedRequest[];
  /** The statuses of the next requests, in order; after them, 200. */
  answerWith(...statuses: number[]): void;
  close(): Promise<void>;
}

export async function startFakeReceiver(): Promise<FakeReceiver> {
  const received: ReceivedRequest[] = [];
  let statuses: number[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString();
      received.push({ path: req.url ?? '', headers: req.headers, text, json: JSON.parse(text) });
      res.statusCode = statuses.shift() ?? 200;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook/secret-token`,
    received,
    answerWith: (...next) => void (statuses = next),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
