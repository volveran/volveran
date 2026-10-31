// A TCP proxy a test can cut, as a database failover or a network partition would. `cut`
// drops every connection and refuses new ones; `silence` keeps them all open and answers
// nothing, as a host that has vanished; `restore` lets connections through again.
import net from 'node:net';

export interface TcpProxy {
  port: number;
  cut(): void;
  silence(): void;
  restore(): void;
  close(): Promise<void>;
}

export async function startTcpProxy(targetPort: number): Promise<TcpProxy> {
  let mode: 'open' | 'cut' | 'silent' = 'open';
  const sockets = new Set<net.Socket>();
  const pairs = new Set<[net.Socket, net.Socket]>();
  const track = (socket: net.Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  };
  const server = net.createServer((client) => {
    track(client);
    if (mode === 'cut') return void client.destroy();
    if (mode === 'silent') return;
    const upstream = net.connect(targetPort, '127.0.0.1');
    track(upstream);
    client.pipe(upstream).pipe(client);
    const pair: [net.Socket, net.Socket] = [client, upstream];
    pairs.add(pair);
    for (const socket of pair) {
      socket.on('close', () => {
        pairs.delete(pair);
        client.destroy();
        upstream.destroy();
      });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const destroyAll = () => {
    for (const socket of sockets) socket.destroy();
  };
  return {
    port: (server.address() as net.AddressInfo).port,
    cut() {
      mode = 'cut';
      destroyAll();
    },
    silence() {
      mode = 'silent';
      for (const [client, upstream] of pairs) {
        client.unpipe(upstream);
        upstream.unpipe(client);
      }
    },
    restore() {
      mode = 'open';
      destroyAll();
    },
    close: () =>
      new Promise<void>((resolve) => {
        destroyAll();
        server.close(() => resolve());
      }),
  };
}
