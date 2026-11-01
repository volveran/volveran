// Replicas on PostgreSQL: their leases and Live Checkout records, read by every Replica. A
// record can outlive its owner's lease: that is how a Checkout's loss can be noticed.
import type pg from 'pg';
import type { LiveCheckoutRoute, LiveCheckoutUpdate, NewLiveCheckout, ReplicaLeaseRow, ReplicaStore } from './audit-store.js';
import { transaction } from './postgres-connection.js';

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

  async addCheckout(c: NewLiveCheckout): Promise<void> {
    await this.pool.query(
      `INSERT INTO live_checkouts (id, owner_replica, operator_id, operator_name, profile, vhost, queue, status, approval)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [c.id, c.ownerReplica, c.operator.id, c.operator.displayName, c.profile, c.vhost, c.queue, c.status, c.approval && JSON.stringify(c.approval)],
    );
  }

  async updateCheckout(id: string, { status, approval }: LiveCheckoutUpdate): Promise<void> {
    await this.pool.query('UPDATE live_checkouts SET status = $2, approval = $3 WHERE id = $1', [id, status, approval && JSON.stringify(approval)]);
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

  async activeCheckoutOf(operatorId: string, now: number): Promise<string | null> {
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT c.id FROM live_checkouts c JOIN replicas r ON r.id = c.owner_replica
       WHERE c.operator_id = $1 AND c.status = 'active' AND r.lease_expires_at > $2 LIMIT 1`,
      [operatorId, now],
    );
    return rows[0]?.id ?? null;
  }
}
