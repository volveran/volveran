// Replicas on PostgreSQL: their leases and Live Checkout records, read by every Replica. A
// record can outlive its owner's lease: that is how a Checkout's loss can be noticed.
import type pg from 'pg';
import type { EndReason, CheckoutQueueType } from '../../shared/checkout.js';
import type { LiveCheckoutRecord, LiveCheckoutRoute, LiveCheckoutUpdate, NewLiveCheckout, OperatorHolding, ReplicaLeaseRow, ReplicaStore } from './audit-store.js';
import { transaction } from './postgres-connection.js';

interface RecordRow {
  id: string;
  owner_replica: string;
  operator_id: string;
  operator_name: string;
  profile: string;
  vhost: string;
  queue: string;
  status: LiveCheckoutRecord['status'];
  approval: string | null;
  queue_type: CheckoutQueueType;
  delivery_limit: number | null;
  ready_at_start: number;
  // pg reads BIGINT as text.
  started_at: string;
  ends_at: string;
  end_reason: EndReason | null;
  lost_reason: string | null;
}

function recordOf(row: RecordRow): LiveCheckoutRecord {
  return {
    id: row.id,
    ownerReplica: row.owner_replica,
    operator: { id: row.operator_id, displayName: row.operator_name },
    profile: row.profile,
    vhost: row.vhost,
    queue: row.queue,
    status: row.status,
    approval: row.approval === null ? null : (JSON.parse(row.approval) as LiveCheckoutRecord['approval']),
    queueType: row.queue_type,
    deliveryLimit: row.delivery_limit,
    readyAtStart: row.ready_at_start,
    startedAt: Number(row.started_at),
    endsAt: Number(row.ends_at),
    endReason: row.end_reason,
    lostReason: row.lost_reason,
  };
}

export class PostgresReplicaStore implements ReplicaStore {
  constructor(private readonly pool: pg.Pool) {}

  async renewLease({ replicaId, forwardingAddress, expiresAt }: ReplicaLeaseRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO replicas (id, forwarding_address, lease_expires_at) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET forwarding_address = EXCLUDED.forwarding_address, lease_expires_at = EXCLUDED.lease_expires_at`,
      [replicaId, forwardingAddress, expiresAt],
    );
  }

  async removeReplica(replicaId: string): Promise<void> {
    await transaction(this.pool, async (client) => {
      await client.query('DELETE FROM live_checkouts WHERE owner_replica = $1', [replicaId]);
      await client.query('DELETE FROM replicas WHERE id = $1', [replicaId]);
    });
  }

  async claimCheckout(c: NewLiveCheckout, now: number): Promise<OperatorHolding | null> {
    // The unique index decides between claims at once. A claim that finds a holder which then
    // goes before it can be read (ended, or never started) has nothing to answer, so tries again.
    for (;;) {
      const answer = await transaction(this.pool, async (client): Promise<{ holding: OperatorHolding | null } | null> => {
        await client.query(
          `UPDATE live_checkouts c SET status = 'lost', approval = NULL
           WHERE c.operator_id = $1 AND c.status IN ('starting', 'active')
             AND NOT EXISTS (SELECT 1 FROM replicas r WHERE r.id = c.owner_replica AND r.lease_expires_at > $2)`,
          [c.operator.id, now],
        );
        const added = await client.query(
          `INSERT INTO live_checkouts (id, owner_replica, operator_id, operator_name, profile, vhost, queue, status, approval, queue_type, delivery_limit, ready_at_start, started_at, ends_at, end_reason, lost_reason)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
           ON CONFLICT (operator_id) WHERE status IN ('starting', 'active') DO NOTHING`,
          [c.id, c.ownerReplica, c.operator.id, c.operator.displayName, c.profile, c.vhost, c.queue, c.status, c.approval && JSON.stringify(c.approval), c.queueType, c.deliveryLimit, c.readyAtStart, c.startedAt, c.endsAt, c.endReason ?? null, c.lostReason ?? null],
        );
        if (added.rowCount === 1) return { holding: null };
        const { rows } = await client.query<OperatorHolding>(
          `SELECT id, vhost, queue FROM live_checkouts WHERE operator_id = $1 AND status IN ('starting', 'active')`,
          [c.operator.id],
        );
        return rows[0] ? { holding: rows[0] } : null;
      });
      if (answer) return answer.holding;
    }
  }

  async updateCheckout(id: string, { status, approval, endReason, lostReason, queueType, deliveryLimit, readyAtStart }: LiveCheckoutUpdate): Promise<void> {
    await this.pool.query(
      `UPDATE live_checkouts SET
         status = CASE WHEN status = 'lost' AND $2 = 'active' THEN status ELSE $2 END,
         approval = $3,
         end_reason = $4,
         lost_reason = CASE WHEN status = 'lost' AND $2 = 'active' THEN lost_reason ELSE $5 END,
         queue_type = COALESCE($6, queue_type),
         delivery_limit = CASE WHEN $6::text IS NULL THEN delivery_limit ELSE $7::integer END,
         ready_at_start = COALESCE($8, ready_at_start)
       WHERE id = $1`,
      [id, status, approval && JSON.stringify(approval), endReason ?? null, lostReason ?? null, queueType ?? null, deliveryLimit ?? null, readyAtStart ?? null],
    );
  }

  async removeCheckout(id: string): Promise<void> {
    await this.pool.query('DELETE FROM live_checkouts WHERE id = $1', [id]);
  }

  async checkoutRoute(id: string, now: number): Promise<LiveCheckoutRoute | null> {
    const { rows } = await this.pool.query<{ owner_replica: string; forwarding_address: string | null; lease_expires_at: number | null }>(
      `SELECT c.owner_replica, r.forwarding_address, r.lease_expires_at
       FROM live_checkouts c LEFT JOIN replicas r ON r.id = c.owner_replica WHERE c.id = $1`,
      [id],
    );
    const row = rows[0];
    if (!row) return null;
    return { ownerReplica: row.owner_replica, forwardingAddress: row.forwarding_address, ownerLeaseLive: row.lease_expires_at !== null && row.lease_expires_at > now };
  }

  async checkoutRecord(id: string): Promise<LiveCheckoutRecord | null> {
    const { rows } = await this.pool.query<RecordRow>('SELECT * FROM live_checkouts WHERE id = $1', [id]);
    return rows[0] ? recordOf(rows[0]) : null;
  }

  async checkoutsOfGoneReplicas(now: number): Promise<LiveCheckoutRecord[]> {
    const { rows } = await this.pool.query<RecordRow>(
      'SELECT c.* FROM live_checkouts c JOIN replicas r ON r.id = c.owner_replica WHERE r.lease_expires_at <= $1',
      [now],
    );
    return rows.map(recordOf);
  }

  async removeGoneReplicas(before: number): Promise<number> {
    return transaction(this.pool, async (client) => {
      await client.query('DELETE FROM live_checkouts WHERE owner_replica IN (SELECT id FROM replicas WHERE lease_expires_at <= $1)', [before]);
      const { rowCount } = await client.query('DELETE FROM replicas WHERE lease_expires_at <= $1', [before]);
      return rowCount ?? 0;
    });
  }

  async activeCheckoutOf(operatorId: string, now: number): Promise<string | null> {
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT c.id FROM live_checkouts c JOIN replicas r ON r.id = c.owner_replica
       WHERE c.operator_id = $1 AND c.status = 'active' AND r.lease_expires_at > $2 LIMIT 1`,
      [operatorId, now],
    );
    return rows[0]?.id ?? null;
  }

  async runningOwner(id: string, now: number): Promise<string | null> {
    const { rows } = await this.pool.query<{ owner_replica: string }>(
      `SELECT c.owner_replica FROM live_checkouts c JOIN replicas r ON r.id = c.owner_replica
       WHERE c.id = $1 AND c.status IN ('active', 'applying') AND r.lease_expires_at > $2`,
      [id, now],
    );
    return rows[0]?.owner_replica ?? null;
  }
}
