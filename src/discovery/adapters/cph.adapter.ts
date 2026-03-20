import { db } from "@/discovery/db.js";

export type SubscriptionStep = "interests" | "groupId" | "price" | "confirm";

export interface CphConversationState {
  sender_inbox_id: string;
  step: SubscriptionStep;
  interests: string[] | null;
  group_id: string | null;
  price: number | null;
  sender_wallet: string | null;
  created_at: Date;
  updated_at: Date;
}

export class CphConversationStateAdapter {
  static async createTable(): Promise<void> {
    const client = await db.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS cph_conversation_state (
          sender_inbox_id VARCHAR(255) PRIMARY KEY,
          step VARCHAR(20) NOT NULL,
          interests TEXT[],
          group_id VARCHAR(255),
          price DECIMAL(10,2),
          sender_wallet VARCHAR(255),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);
    } finally {
      client.release();
    }
  }

  static async get(senderInboxId: string): Promise<CphConversationState | null> {
    const client = await db.connect();
    try {
      const result = await client.query<CphConversationState>(
        `SELECT * FROM cph_conversation_state WHERE sender_inbox_id = $1`,
        [senderInboxId],
      );
      return result.rows[0] ?? null;
    } finally {
      client.release();
    }
  }

  static async upsert(senderInboxId: string, state: {
    step: SubscriptionStep;
    interests?: string[] | null;
    groupId?: string | null;
    price?: number | null;
    senderWallet?: string | null;
  }): Promise<void> {
    const client = await db.connect();
    try {
      await client.query(`
        INSERT INTO cph_conversation_state (sender_inbox_id, step, interests, group_id, price, sender_wallet)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (sender_inbox_id) DO UPDATE SET
          step = EXCLUDED.step,
          interests = COALESCE(EXCLUDED.interests, cph_conversation_state.interests),
          group_id = COALESCE(EXCLUDED.group_id, cph_conversation_state.group_id),
          price = COALESCE(EXCLUDED.price, cph_conversation_state.price),
          sender_wallet = COALESCE(EXCLUDED.sender_wallet, cph_conversation_state.sender_wallet),
          updated_at = CURRENT_TIMESTAMP
      `, [
        senderInboxId,
        state.step,
        state.interests ?? null,
        state.groupId ?? null,
        state.price ?? null,
        state.senderWallet ?? null,
      ]);
    } finally {
      client.release();
    }
  }

  static async delete(senderInboxId: string): Promise<void> {
    const client = await db.connect();
    try {
      await client.query(
        `DELETE FROM cph_conversation_state WHERE sender_inbox_id = $1`,
        [senderInboxId],
      );
    } finally {
      client.release();
    }
  }

  static async exists(senderInboxId: string): Promise<boolean> {
    const client = await db.connect();
    try {
      const result = await client.query(
        `SELECT 1 FROM cph_conversation_state WHERE sender_inbox_id = $1 LIMIT 1`,
        [senderInboxId],
      );
      return (result.rowCount ?? 0) > 0;
    } finally {
      client.release();
    }
  }
}

export interface CphSubscription {
  id: number;
  agent_inbox_id: string;
  agent_wallet: string | null;
  xmtp_group_id: string;
  interests: string[];
  price_per_human: number;
  max_humans: number;
  cph_delivered: number;
  active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface CphDelivery {
  id: number;
  subscription_id: number;
  user_inbox_id: string;
  source_group_id: string | null;
  trigger_message: string | null;
  matched_interests: string[];
  payment_status: string;
  delivered_at: Date;
}

export interface PendingCphDelivery {
  id: number;
  subscription_id: number;
  user_inbox_id: string;
  user_wallet_address: string | null;
  source_group_id: string;
  trigger_message: string | null;
  matched_interests: string[];
  status: "pending" | "sent" | "failed";
  created_at: Date;
}

export class CphSubscriptionAdapter {
  static async createTable(): Promise<void> {
    const client = await db.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS cph_subscriptions (
          id SERIAL PRIMARY KEY,
          agent_inbox_id VARCHAR(255) NOT NULL,
          agent_wallet VARCHAR(255),
          xmtp_group_id VARCHAR(255) NOT NULL,
          interests TEXT[] NOT NULL DEFAULT '{}',
          price_per_human DECIMAL(10,2) DEFAULT 0.50,
          max_humans INTEGER DEFAULT 0,
          cph_delivered INTEGER DEFAULT 0,
          active BOOLEAN DEFAULT true,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_cph_subscriptions_active ON cph_subscriptions(active);
        CREATE INDEX IF NOT EXISTS idx_cph_subscriptions_agent ON cph_subscriptions(agent_inbox_id);
      `);
    } finally {
      client.release();
    }
  }

  static async insert(sub: {
    agentInboxId: string;
    agentWallet: string | null;
    xmtpGroupId: string;
    interests: string[];
    pricePerHuman: number;
    maxHumans?: number;
  }): Promise<CphSubscription> {
    const client = await db.connect();
    try {
      const result = await client.query<CphSubscription>(`
        INSERT INTO cph_subscriptions (agent_inbox_id, agent_wallet, xmtp_group_id, interests, price_per_human, max_humans)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *
      `, [sub.agentInboxId, sub.agentWallet, sub.xmtpGroupId, sub.interests, sub.pricePerHuman, sub.maxHumans ?? 0]);
      return result.rows[0];
    } finally {
      client.release();
    }
  }

  static async getActive(): Promise<CphSubscription[]> {
    const client = await db.connect();
    try {
      const result = await client.query<CphSubscription>(`
        SELECT * FROM cph_subscriptions
        WHERE active = true
        ORDER BY created_at DESC
      `);
      return result.rows;
    } finally {
      client.release();
    }
  }

  static async getByAgentInbox(agentInboxId: string): Promise<CphSubscription[]> {
    const client = await db.connect();
    try {
      const result = await client.query<CphSubscription>(`
        SELECT * FROM cph_subscriptions
        WHERE agent_inbox_id = $1 AND active = true
        ORDER BY created_at DESC
      `, [agentInboxId]);
      return result.rows;
    } finally {
      client.release();
    }
  }

  static async incrementDelivered(id: number): Promise<void> {
    const client = await db.connect();
    try {
      await client.query(`
        UPDATE cph_subscriptions
        SET cph_delivered = cph_delivered + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
      `, [id]);
    } finally {
      client.release();
    }
  }
}

export class CphDeliveryAdapter {
  static async createTable(): Promise<void> {
    const client = await db.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS cph_deliveries (
          id SERIAL PRIMARY KEY,
          subscription_id INTEGER REFERENCES cph_subscriptions(id),
          user_inbox_id VARCHAR(255) NOT NULL,
          source_group_id VARCHAR(255),
          trigger_message TEXT,
          matched_interests TEXT[],
          payment_status VARCHAR(50) DEFAULT 'pending',
          delivered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_cph_deliveries_sub ON cph_deliveries(subscription_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_cph_deliveries_unique ON cph_deliveries(subscription_id, user_inbox_id);
      `);
    } finally {
      client.release();
    }
  }

  static async insert(delivery: {
    subscriptionId: number;
    userInboxId: string;
    sourceGroupId: string | null;
    triggerMessage: string | null;
    matchedInterests: string[];
  }): Promise<void> {
    const client = await db.connect();
    try {
      await client.query(`
        INSERT INTO cph_deliveries (subscription_id, user_inbox_id, source_group_id, trigger_message, matched_interests)
        VALUES ($1, $2, $3, $4, $5)
      `, [delivery.subscriptionId, delivery.userInboxId, delivery.sourceGroupId, delivery.triggerMessage, delivery.matchedInterests]);
    } finally {
      client.release();
    }
  }

  static async wasDelivered(subscriptionId: number, userInboxId: string): Promise<boolean> {
    const client = await db.connect();
    try {
      const result = await client.query(`
        SELECT 1 FROM cph_deliveries
        WHERE subscription_id = $1 AND user_inbox_id = $2
        LIMIT 1
      `, [subscriptionId, userInboxId]);
      return (result.rowCount ?? 0) > 0;
    } finally {
      client.release();
    }
  }

  static async markPaymentReceived(id: number): Promise<void> {
    const client = await db.connect();
    try {
      await client.query(`
        UPDATE cph_deliveries
        SET payment_status = 'paid'
        WHERE id = $1
      `, [id]);
    } finally {
      client.release();
    }
  }
}

export class PendingCphDeliveryAdapter {
  static async createTable(): Promise<void> {
    const client = await db.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS pending_cph_deliveries (
          id SERIAL PRIMARY KEY,
          subscription_id INTEGER NOT NULL REFERENCES cph_subscriptions(id),
          user_inbox_id TEXT NOT NULL,
          user_wallet_address TEXT,
          source_group_id TEXT NOT NULL,
          trigger_message TEXT,
          matched_interests TEXT[],
          status TEXT NOT NULL DEFAULT 'pending',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          sent_at TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_pending_cph_status ON pending_cph_deliveries(status);
      `);
    } finally {
      client.release();
    }
  }

  static async insert(delivery: {
    subscriptionId: number;
    userInboxId: string;
    userWalletAddress: string | null;
    sourceGroupId: string;
    triggerMessage: string | null;
    matchedInterests: string[];
  }): Promise<boolean> {
    const client = await db.connect();
    try {
      const result = await client.query(`
        INSERT INTO pending_cph_deliveries (subscription_id, user_inbox_id, user_wallet_address, source_group_id, trigger_message, matched_interests)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [delivery.subscriptionId, delivery.userInboxId, delivery.userWalletAddress, delivery.sourceGroupId, delivery.triggerMessage, delivery.matchedInterests]);
      return (result.rowCount ?? 0) > 0;
    } finally {
      client.release();
    }
  }

  static async getNextPending(): Promise<{
    id: number;
    subscription_id: number;
    user_inbox_id: string;
    user_wallet_address: string | null;
    source_group_id: string;
    trigger_message: string | null;
    matched_interests: string[];
    subscription: CphSubscription;
  } | null> {
    const client = await db.connect();
    try {
      const result = await client.query(`
        SELECT p.id, p.subscription_id, p.user_inbox_id, p.user_wallet_address, p.source_group_id,
               p.trigger_message, p.matched_interests, p.status, p.created_at,
               s.agent_inbox_id, s.agent_wallet, s.xmtp_group_id, s.interests, s.price_per_human,
               s.max_humans, s.cph_delivered, s.created_at as s_created, s.updated_at as s_updated
        FROM pending_cph_deliveries p
        JOIN cph_subscriptions s ON s.id = p.subscription_id
        WHERE p.status = 'pending' AND s.active = true
        ORDER BY p.created_at ASC
        LIMIT 1
      `);
      const row = result.rows[0];
      if (!row) return null;
      return {
        id: row.id,
        subscription_id: row.subscription_id,
        user_inbox_id: row.user_inbox_id,
        user_wallet_address: row.user_wallet_address,
        source_group_id: row.source_group_id,
        trigger_message: row.trigger_message,
        matched_interests: row.matched_interests || [],
        subscription: {
          id: row.subscription_id,
          agent_inbox_id: row.agent_inbox_id,
          agent_wallet: row.agent_wallet,
          xmtp_group_id: row.xmtp_group_id,
          interests: row.interests || [],
          price_per_human: parseFloat(row.price_per_human),
          max_humans: row.max_humans,
          cph_delivered: row.cph_delivered,
          active: true,
          created_at: row.s_created,
          updated_at: row.s_updated,
        },
      };
    } finally {
      client.release();
    }
  }

  static async markSent(id: number): Promise<void> {
    const client = await db.connect();
    try {
      await client.query(`
        UPDATE pending_cph_deliveries
        SET status = 'sent', sent_at = CURRENT_TIMESTAMP
        WHERE id = $1
      `, [id]);
    } finally {
      client.release();
    }
  }

  static async markFailed(id: number): Promise<void> {
    const client = await db.connect();
    try {
      await client.query(`
        UPDATE pending_cph_deliveries
        SET status = 'failed'
        WHERE id = $1
      `, [id]);
    } finally {
      client.release();
    }
  }

  static async markAwaitingPayment(id: number): Promise<void> {
    const client = await db.connect();
    try {
      await client.query(`
        UPDATE pending_cph_deliveries
        SET status = 'awaiting_payment'
        WHERE id = $1
      `, [id]);
    } finally {
      client.release();
    }
  }

  static async markPaid(id: number): Promise<void> {
    const client = await db.connect();
    try {
      await client.query(`
        UPDATE pending_cph_deliveries
        SET status = 'paid'
        WHERE id = $1
      `, [id]);
    } finally {
      client.release();
    }
  }

  static async getById(id: number): Promise<{
    id: number;
    subscription_id: number;
    user_inbox_id: string;
    user_wallet_address: string | null;
    source_group_id: string;
    trigger_message: string | null;
    matched_interests: string[];
    status: string;
    subscription: CphSubscription;
  } | null> {
    const client = await db.connect();
    try {
      const result = await client.query(`
        SELECT p.id, p.subscription_id, p.user_inbox_id, p.user_wallet_address, p.source_group_id,
               p.trigger_message, p.matched_interests, p.status, p.created_at,
               s.agent_inbox_id, s.agent_wallet, s.xmtp_group_id, s.interests, s.price_per_human,
               s.max_humans, s.cph_delivered, s.created_at as s_created, s.updated_at as s_updated
        FROM pending_cph_deliveries p
        JOIN cph_subscriptions s ON s.id = p.subscription_id
        WHERE p.id = $1
      `, [id]);
      const row = result.rows[0];
      if (!row) return null;
      return {
        id: row.id,
        subscription_id: row.subscription_id,
        user_inbox_id: row.user_inbox_id,
        user_wallet_address: row.user_wallet_address,
        source_group_id: row.source_group_id,
        trigger_message: row.trigger_message,
        matched_interests: row.matched_interests || [],
        status: row.status,
        subscription: {
          id: row.subscription_id,
          agent_inbox_id: row.agent_inbox_id,
          agent_wallet: row.agent_wallet,
          xmtp_group_id: row.xmtp_group_id,
          interests: row.interests || [],
          price_per_human: parseFloat(row.price_per_human),
          max_humans: row.max_humans,
          cph_delivered: row.cph_delivered,
          active: true,
          created_at: row.s_created,
          updated_at: row.s_updated,
        },
      };
    } finally {
      client.release();
    }
  }

  static async getNextPaid(): Promise<{
    id: number;
    subscription_id: number;
    user_inbox_id: string;
    user_wallet_address: string | null;
    source_group_id: string;
    trigger_message: string | null;
    matched_interests: string[];
    subscription: CphSubscription;
  } | null> {
    const client = await db.connect();
    try {
      const result = await client.query(`
        SELECT p.id, p.subscription_id, p.user_inbox_id, p.user_wallet_address, p.source_group_id,
               p.trigger_message, p.matched_interests, p.status, p.created_at,
               s.agent_inbox_id, s.agent_wallet, s.xmtp_group_id, s.interests, s.price_per_human,
               s.max_humans, s.cph_delivered, s.created_at as s_created, s.updated_at as s_updated
        FROM pending_cph_deliveries p
        JOIN cph_subscriptions s ON s.id = p.subscription_id
        WHERE p.status = 'paid' AND s.active = true
        ORDER BY p.created_at ASC
        LIMIT 1
      `);
      const row = result.rows[0];
      if (!row) return null;
      return {
        id: row.id,
        subscription_id: row.subscription_id,
        user_inbox_id: row.user_inbox_id,
        user_wallet_address: row.user_wallet_address,
        source_group_id: row.source_group_id,
        trigger_message: row.trigger_message,
        matched_interests: row.matched_interests || [],
        subscription: {
          id: row.subscription_id,
          agent_inbox_id: row.agent_inbox_id,
          agent_wallet: row.agent_wallet,
          xmtp_group_id: row.xmtp_group_id,
          interests: row.interests || [],
          price_per_human: parseFloat(row.price_per_human),
          max_humans: row.max_humans,
          cph_delivered: row.cph_delivered,
          active: true,
          created_at: row.s_created,
          updated_at: row.s_updated,
        },
      };
    } finally {
      client.release();
    }
  }
}
