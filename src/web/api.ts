// Thin typed client over Volverán's HTTP JSON API. The response shapes are
// the server's own, from src/shared/.
import type { AuditAction, AuditEntryJson, BodyStoreUsage } from '../shared/audit.js';
import type { ApprovalSummary, CheckoutView, MessageDetail } from '../shared/checkout.js';
import type { Decision } from '../shared/decisions.js';
import type { FilterClause } from '../shared/filters.js';
import { product } from '../shared/product.js';
import type { MoveDestinations, ProfileSummary, QueueList, QueueRow, Session } from '../shared/queues.js';

export type { Decision, DecisionSummaryLine, MoveDestination } from '../shared/decisions.js';
export type { AuditAction, AuditOutcome } from '../shared/audit.js';
export type {
  ApplyProgress,
  ApprovalSummary,
  CheckoutHolder,
  DeliveryBudget,
  DiedAgain,
  FailureDetails,
  MessageDetail,
  MessageOutcome,
  MessageRow,
  MessageSummary,
  RenderedBody,
  XDeathEntry,
} from '../shared/checkout.js';
export type { FilterClause } from '../shared/filters.js';
export type {
  CheckoutAvailability,
  MoveDestinations,
  QueueList,
  Session,
  SetupWarning,
  SetupWarningCounts,
  SetupWarningSeverity,
} from '../shared/queues.js';
export type Checkout = CheckoutView;
export type Profile = ProfileSummary;
export type Queue = QueueRow;
export type AuditEntry = AuditEntryJson;
export type AuditStoreUsage = BodyStoreUsage;

export interface Rejection {
  handle: number;
  reason: string;
}

/** The Audit Entry search form; empty fields are ignored. */
export interface AuditSearch {
  profile?: string;
  queue?: string;
  messageId?: string;
  action?: AuditAction | '';
  operator?: string;
  /** The `x-volveran-replay-id` header of a Message that came back. */
  replayId?: string;
  from?: string;
  to?: string;
}

export interface RestoreOptions {
  /** Another existing queue; the source queue when omitted. */
  queue?: string;
  /** Accept a possible duplicate (the Discard's outcome is pending or uncertain). */
  confirmUncertain?: boolean;
  /** On a Protected Profile: the destination queue name as typed. */
  confirmQueueName?: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function getJson<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new ApiError(0, 'app_unreachable', `Cannot reach ${product.name}: ${(err as Error).message}`);
  }
  const json = await res.json().catch(() => undefined);
  if (!res.ok) {
    const { code, message, ...details } = (json?.error ?? {}) as { code?: string; message?: string };
    // Team Mode without a session (none yet, expired, or ended elsewhere): sign in and come back here.
    if (res.status === 401 && code === 'not_signed_in') signIn();
    throw new ApiError(res.status, code ?? 'http_error', message ?? `Request failed with ${res.status}`, details);
  }
  return json as T;
}

const segment = encodeURIComponent;

/** Team Mode: go to the provider's sign-in, then back to this page. */
export function signIn(): void {
  const here = window.location.pathname + window.location.search + window.location.hash;
  window.location.assign(`/auth/login?returnTo=${encodeURIComponent(here)}`);
}

/** Team Mode: end the session, then show the sign-in again. */
export async function signOut(): Promise<void> {
  await fetch('/auth/logout', { method: 'POST' }).catch(() => undefined);
  signIn();
}

export const api = {
  session: () => getJson<Session>('/api/session'),
  profiles: () => getJson<{ profiles: Profile[] }>('/api/profiles').then((b) => b.profiles),
  vhosts: (profile: string) =>
    getJson<{ vhosts: Array<{ name: string }> }>(`/api/profiles/${segment(profile)}/vhosts`).then((b) =>
      b.vhosts.map((v) => v.name),
    ),
  queues: (profile: string, vhost: string, opts: { search: string; onlyDeadLetterQueues: boolean }) => {
    const params = new URLSearchParams();
    if (opts.search.trim()) params.set('search', opts.search.trim());
    if (opts.onlyDeadLetterQueues) params.set('onlyDeadLetterQueues', 'true');
    const qs = params.size > 0 ? `?${params}` : '';
    return getJson<QueueList>(`/api/profiles/${segment(profile)}/vhosts/${segment(vhost)}/queues${qs}`);
  },
  moveDestinations: (profile: string, vhost: string) =>
    getJson<MoveDestinations>(`/api/profiles/${segment(profile)}/vhosts/${segment(vhost)}/move-destinations`),
  /** `overrideConsumers` starts it even though other consumers read the queue (error `queue_has_consumers` otherwise). */
  startCheckout: (profile: string, vhost: string, queue: string, opts: { overrideConsumers?: boolean } = {}) =>
    getJson<{ checkout: Checkout }>(
      `/api/profiles/${segment(profile)}/vhosts/${segment(vhost)}/queues/${segment(queue)}/checkouts`,
      'POST',
      { overrideConsumers: opts.overrideConsumers === true },
    ).then((b) => b.checkout),
  /** Keeps the Checkout alive (the page still shows it) and returns its state. */
  heartbeat: (id: string) =>
    getJson<{ checkout: Checkout }>(`/api/checkouts/${segment(id)}/heartbeat`, 'POST').then((b) => b.checkout),
  checkout: (id: string) => getJson<{ checkout: Checkout }>(`/api/checkouts/${segment(id)}`).then((b) => b.checkout),
  message: (id: string, handle: number) =>
    getJson<{ message: MessageDetail }>(`/api/checkouts/${segment(id)}/messages/${handle}`).then((b) => b.message),
  endCheckout: (id: string) =>
    getJson<{ checkout: Checkout }>(`/api/checkouts/${segment(id)}`, 'DELETE').then((b) => b.checkout),
  /** The handles of the held Messages matching `filter`. */
  matching: (id: string, filter: FilterClause[]) =>
    getJson<{ handles: number[]; count: number }>(`/api/checkouts/${segment(id)}/matching`, 'POST', { filter }),
  /** Gives the Messages `handles` a Decision (Keep clears it); nothing reaches the broker until Apply. */
  setDecisions: (id: string, handles: number[], decision: Decision) =>
    getJson<{ checkout: Checkout; rejected: Rejection[] }>(`/api/checkouts/${segment(id)}/decisions`, 'POST', {
      handles,
      decision,
    }),

  auditEntries: (search: AuditSearch) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(search)) if (value?.trim()) params.set(key, value.trim());
    const qs = params.size > 0 ? `?${params}` : '';
    return getJson<{ entries: AuditEntry[] }>(`/api/audit-entries${qs}`).then((b) => b.entries);
  },
  auditStore: () => getJson<AuditStoreUsage>('/api/audit-store'),
  /** Republishes the Discarded Message of Audit Entry `id`; returns the Restore's own Audit Entry. */
  restore: (id: number, options: RestoreOptions) =>
    getJson<{ entry: AuditEntry }>(`/api/audit-entries/${id}/restore`, 'POST', { confirm: true, ...options }).then(
      (b) => b.entry,
    ),
  /**
   * Downloads the held Messages as NDJSON (those matching `filter`, or every
   * one) and hands the file to the browser. Recorded as an Audit Entry.
   */
  exportMessages: async (id: string, filter?: FilterClause[]) => {
    const res = await fetch(`/api/checkouts/${segment(id)}/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(filter ? { filter } : {}),
    }).catch((err: Error) => {
      throw new ApiError(0, 'app_unreachable', `Cannot reach ${product.name}: ${err.message}`);
    });
    if (!res.ok) {
      const json = await res.json().catch(() => undefined);
      const { code, message, ...details } = (json?.error ?? {}) as { code?: string; message?: string };
      throw new ApiError(res.status, code ?? 'http_error', message ?? `Export failed with ${res.status}`, details);
    }
    const filename = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'volveran-export.ndjson';
    const url = URL.createObjectURL(await res.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  },
  /**
   * Starts carrying out every Decision in the background; returns the
   * Checkout `applying`. Its `applyProgress` shows how far it has got, and
   * its `lastApply` the outcome per Message once it has ended the Checkout.
   * On a Protected Profile `confirmQueueName` is the queue name as the Operator typed it.
   */
  apply: (id: string, confirmQueueName?: string) =>
    getJson<{ checkout: Checkout }>(`/api/checkouts/${segment(id)}/apply`, 'POST', {
      confirm: true,
      ...(confirmQueueName !== undefined && { confirmQueueName }),
    }).then((b) => b.checkout),
  /** Asks another Operator to approve the Apply (it needs Approval); freezes the Decisions. */
  requestApproval: (id: string, confirmQueueName?: string) =>
    getJson<{ checkout: Checkout }>(`/api/checkouts/${segment(id)}/approval-request`, 'POST', {
      confirm: true,
      ...(confirmQueueName !== undefined && { confirmQueueName }),
    }).then((b) => b.checkout),
  withdrawApproval: (id: string) =>
    getJson<{ checkout: Checkout }>(`/api/checkouts/${segment(id)}/approval-request`, 'DELETE').then((b) => b.checkout),
  /** Other Operators' Checkouts waiting for an Approval this Operator may give. */
  approvals: () => getJson<{ approvals: ApprovalSummary[] }>('/api/approvals').then((b) => b.approvals),
  /** A waiting Checkout, read-only. */
  approvalCheckout: (id: string) =>
    getJson<{ checkout: Checkout }>(`/api/approvals/${segment(id)}`).then((b) => b.checkout),
  approvalMessage: (id: string, handle: number) =>
    getJson<{ message: MessageDetail }>(`/api/approvals/${segment(id)}/messages/${handle}`).then((b) => b.message),
  /** Rejects the Apply of a waiting Checkout: it goes back to its requester's staging with `reason`. */
  reject: (id: string, reason: string) =>
    getJson<{ checkout: Checkout }>(`/api/approvals/${segment(id)}/reject`, 'POST', { reason }).then((b) => b.checkout),
  /**
   * Approves the Apply of a waiting Checkout, which starts it in the
   * background on the requester's Checkout; returns that Checkout
   * `applying`. `confirmQueueName` is the queue name as typed.
   */
  approve: (id: string, confirmQueueName: string) =>
    getJson<{ checkout: Checkout }>(`/api/approvals/${segment(id)}/approve`, 'POST', {
      confirmQueueName,
    }).then((b) => b.checkout),
};
