// kind smoke test helpers: port-forwards into the cluster, the Volverán pod
// and seeding a dead-letter queue through RabbitMQ's management API.
import { spawn, type ChildProcess } from 'node:child_process';
import { appNamespace, brokerAdmin, clusterName, image, kubectl, kubectlFlags, ports, releaseName, run } from './kind-env.mjs';

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
  /** Empty until the pod has one. */
  ip: string;
  /** Empty until its container has started. */
  containerId: string;
}

/** The release's pods that are not being deleted. */
export function volveranPods(): VolveranPod[] {
  const list = JSON.parse(
    kubectl(['-n', appNamespace, 'get', 'pods', '-l', `app.kubernetes.io/instance=${releaseName}`, '-o', 'json']),
  );
  return list.items
    .filter((p: any) => !p.metadata.deletionTimestamp)
    .map((p: any) => ({
      name: p.metadata.name,
      uid: p.metadata.uid,
      ready: (p.status.conditions ?? []).some((c: any) => c.type === 'Ready' && c.status === 'True'),
      ip: p.status.podIP ?? '',
      containerId: (p.status.containerStatuses?.[0]?.containerID ?? '').replace(/^[a-z]+:\/\//, ''),
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

/** Waits for exactly `count` Ready Volverán pods, and returns them. */
export function readyPods(count: number): Promise<VolveranPod[]> {
  return eventually(() => {
    const pods = volveranPods();
    if (pods.length !== count || pods.some((p) => !p.ready)) throw new Error(`expected ${count} Ready Volverán pods, got ${JSON.stringify(pods)}`);
    return pods;
  });
}

/**
 * Kills the process abruptly, from the node, as a crash does: no SIGTERM, so it ends no
 * Checkout. A signal sent inside the container could not do it, since the process is its
 * PID 1. The pod object is then removed, so that the process does not come back in it.
 */
export function crash(pod: VolveranPod): void {
  const node = `${clusterName}-control-plane`;
  const pid = run('docker', ['exec', node, 'crictl', 'inspect', '--output', 'go-template', '--template', '{{.info.pid}}', pod.containerId]).trim();
  run('docker', ['exec', node, 'kill', '-9', pid]);
  kubectl(['-n', appNamespace, 'delete', 'pod', pod.name, '--grace-period=0', '--force']);
}

/** Node code that prints whether a TCP connection opens: refused, or dropped by a policy, is "closed". */
const connectCode = (ip: string, port: number) =>
  `const s=require('net').connect(${port},'${ip}');const done=(r)=>{console.log(r);process.exit(0)};s.on('connect',()=>done('open'));s.on('error',()=>done('closed'));setTimeout(()=>done('closed'),3000)`;

/** What a Volverán pod is answered when it asks another's forwarding port for the session, saying this forwarding protocol version. */
export function askForwardingPort(pod: VolveranPod, ip: string, port: number, secret: string, protocol: string): { status: number; protocol: string | null } {
  const operator = Buffer.from(JSON.stringify({ id: 'smoke-operator', displayName: 'Smoke Operator', groups: [] })).toString('base64url');
  const headers = { authorization: `Bearer ${secret}`, 'x-volveran-forwarded-operator': operator, 'x-volveran-forwarding-protocol': protocol };
  const code = `fetch('http://${ip}:${port}/api/session',{headers:${JSON.stringify(headers)}}).then((r)=>console.log(JSON.stringify({status:r.status,protocol:r.headers.get('x-volveran-forwarding-protocol')})))`;
  return JSON.parse(kubectl(['-n', appNamespace, 'exec', pod.name, '-c', 'volveran', '--', 'node', '-e', code]));
}

/** Whether a Volverán pod can open a connection to this address. */
export function connectFromPod(pod: VolveranPod, ip: string, port: number): string {
  return kubectl(['-n', appNamespace, 'exec', pod.name, '-c', 'volveran', '--', 'node', '-e', connectCode(ip, port)]).trim();
}

/** A pod with no label of the release, to try connections from. It runs the Volverán image only because that is loaded and has node. */
export function startProbe(namespace: string): void {
  const manifest = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: 'probe', namespace, labels: { app: 'smoke-probe' } },
    spec: {
      terminationGracePeriodSeconds: 0,
      securityContext: { runAsNonRoot: true, runAsUser: 1000, seccompProfile: { type: 'RuntimeDefault' } },
      containers: [
        {
          name: 'probe',
          image: `${image.repository}:${image.tag}`,
          imagePullPolicy: 'Never',
          command: ['node', '-e', 'setInterval(() => {}, 1e6)'],
          securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } },
        },
      ],
    },
  };
  kubectl(['apply', '-f', '-'], { input: JSON.stringify(manifest) });
  kubectl(['-n', namespace, 'wait', '--for=condition=Ready', 'pod/probe', '--timeout=120s']);
}

export function connectFromProbe(namespace: string, ip: string, port: number): string {
  return kubectl(['-n', namespace, 'exec', 'probe', '--', 'node', '-e', connectCode(ip, port)]).trim();
}

export function stopProbe(namespace: string): void {
  kubectl(['-n', namespace, 'delete', 'pod', 'probe', '--ignore-not-found', '--wait=false']);
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
