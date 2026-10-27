// kind smoke test helpers: port-forwards into the cluster, the Volverán pod
// and seeding a dead-letter queue through RabbitMQ's management API.
import { spawn, type ChildProcess } from 'node:child_process';
import { appNamespace, brokerAdmin, kubectl, kubectlFlags, ports, releaseName } from './kind-env.mjs';

export interface PortForward {
  close(): Promise<void>;
}

/**
 * `kubectl port-forward` from 127.0.0.1:`localPort` to `target` (e.g.
 * `service/volveran`); resolves once it listens. A Service port-forward sticks
 * to the pod it picked, so open a new one after the pod is replaced.
 */
export async function portForward(namespace: string, target: string, localPort: number, remotePort: number): Promise<PortForward> {
  const child = spawn(
    'kubectl',
    [...kubectlFlags, '-n', namespace, 'port-forward', '--address', '127.0.0.1', target, `${localPort}:${remotePort}`],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`port-forward to ${target} did not start within 30 s: ${output}`));
    }, 30_000);
    child.stdout!.on('data', (chunk: Buffer) => {
      output += chunk;
      if (output.includes('Forwarding from')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr!.on('data', (chunk: Buffer) => (output += chunk));
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`port-forward to ${target} exited (${code}): ${output}`));
    });
  });
  return { close: () => stop(child) };
}

function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
    child.kill();
  });
}

/** Retries `check` until it stops throwing, for up to `timeoutMs`. */
export async function eventually<T>(check: () => Promise<T> | T, timeoutMs = 180_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await check();
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

export interface VolveranPod {
  name: string;
  uid: string;
  ready: boolean;
}

/** The release's pods that are not being deleted. */
export function volveranPods(): VolveranPod[] {
  const list = JSON.parse(
    kubectl('-n', appNamespace, 'get', 'pods', '-l', `app.kubernetes.io/instance=${releaseName}`, '-o', 'json'),
  );
  return list.items
    .filter((p: any) => !p.metadata.deletionTimestamp)
    .map((p: any) => ({
      name: p.metadata.name,
      uid: p.metadata.uid,
      ready: (p.status.conditions ?? []).some((c: any) => c.type === 'Ready' && c.status === 'True'),
    }));
}

/** The one Ready Volverán pod; throws while there is none or more than one. */
export function readyPod(): VolveranPod {
  const pods = volveranPods();
  if (pods.length !== 1 || !pods[0]!.ready) throw new Error(`expected one Ready Volverán pod, got ${JSON.stringify(pods)}`);
  return pods[0]!;
}

/** Waits for a Ready Volverán pod other than `previous`. */
export function replacementOf(previous: VolveranPod): Promise<VolveranPod> {
  return eventually(() => {
    const pod = readyPod();
    if (pod.uid === previous.uid) throw new Error(`${pod.name} has not been replaced yet`);
    return pod;
  });
}

/** RabbitMQ's management API through its port-forward, as volveran-admin. */
export async function management(method: string, path: string, body?: unknown): Promise<any> {
  const auth = Buffer.from(`${brokerAdmin.username}:${brokerAdmin.password}`).toString('base64');
  const res = await fetch(`http://127.0.0.1:${ports.management}/api${path}`, {
    method,
    headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`management ${method} ${path} answered ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : undefined;
}

/**
 * Dead-letters one Message into orders.dlq the way production does: published
 * to `orders`, routed to orders.work, then rejected without requeue.
 */
export async function deadLetterOrder(messageId: string, payload: string): Promise<void> {
  const published = await management('POST', '/exchanges/%2F/orders/publish', {
    properties: { message_id: messageId, content_type: 'application/json' },
    routing_key: 'orders.created',
    payload,
    payload_encoding: 'string',
  });
  if (!published.routed) throw new Error('the Message was not routed to orders.work');
  await management('POST', '/queues/%2F/orders.work/get', { count: 1, ackmode: 'reject_requeue_false', encoding: 'auto' });
}
