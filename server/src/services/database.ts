import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Product } from "../domain/catalog.js";

export type Policy = {
  allowedMerchantIds: string[];
  allowedProductIds: string[];
  maxAmountMinor: number;
  currency: string;
  version: number;
};

export type AuthorizationStatus =
  | "authorized"
  | "order_created"
  | "capturing"
  | "capture_pending"
  | "consumed"
  | "failed"
  | "cancelled"
  | "expired";

export type Authorization = {
  id: string;
  userId: string;
  transactionId: string;
  productId: string;
  merchantId: string;
  amountMinor: number;
  currency: string;
  createdAt: string;
  expiresAt: string;
  status: AuthorizationStatus;
  policyVersion: number;
  orderId: string | null;
};

export type AuditEvent = {
  id: number;
  eventType: string;
  authorizationId: string | null;
  detail: string;
  createdAt: string;
};

const initialPolicy: Policy = {
  allowedMerchantIds: ["soundhouse", "dailybrew", "formandfunction", "trailgoods"],
  allowedProductIds: ["headphones-001", "kettle-002", "lamp-003", "backpack-004"],
  maxAmountMinor: 20000,
  currency: "USD",
  version: 1,
};

export class Store {
  private readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS policy (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS authorizations (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        transaction_id TEXT NOT NULL UNIQUE,
        approval_key TEXT NOT NULL UNIQUE,
        product_id TEXT NOT NULL,
        merchant_id TEXT NOT NULL,
        amount_minor INTEGER NOT NULL,
        currency TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        status TEXT NOT NULL,
        policy_version INTEGER NOT NULL,
        order_id TEXT UNIQUE
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        authorization_id TEXT,
        detail TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    this.db.prepare("INSERT OR IGNORE INTO policy (id, data) VALUES (1, ?)").run(
      JSON.stringify(initialPolicy),
    );
  }

  getPolicy(): Policy {
    const row = this.db.prepare("SELECT data FROM policy WHERE id = 1").get() as
      | { data: string }
      | undefined;
    if (!row) throw new Error("Policy record is missing from the database");
    return JSON.parse(row.data) as Policy;
  }

  updatePolicy(policy: Omit<Policy, "version">): Policy {
    const updated = { ...policy, version: this.getPolicy().version + 1 };
    this.db.prepare("UPDATE policy SET data = ? WHERE id = 1").run(JSON.stringify(updated));
    this.addAudit("policy.updated", null, `Policy updated to version ${updated.version}`);
    return updated;
  }

  createAuthorization(input: {
    id: string;
    transactionId: string;
    approvalKey: string;
    userId: string;
    product: Product;
    expiresAt: string;
    policyVersion: number;
  }): { authorization: Authorization; created: boolean } {
    const create = this.db.transaction(() => {
      const createdAt = new Date().toISOString();
      const result = this.db.prepare(`
        INSERT INTO authorizations
          (id, user_id, transaction_id, approval_key, product_id, merchant_id, amount_minor, currency,
           created_at, expires_at, status, policy_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'authorized', ?)
        ON CONFLICT(approval_key) DO NOTHING
      `).run(
        input.id,
        input.userId,
        input.transactionId,
        input.approvalKey,
        input.product.id,
        input.product.merchantId,
        input.product.amountMinor,
        input.product.currency,
        createdAt,
        input.expiresAt,
        input.policyVersion,
      );
      if (result.changes === 0) {
        const existing = this.getAuthorizationByApprovalKey(input.approvalKey);
        if (!existing) throw new Error("Approval key conflicted with an unrelated transaction identifier");
        return { authorization: existing, created: false };
      }
      this.addAudit("authorization.created", input.id, "User approved an exact transaction");
      const authorization = this.getAuthorization(input.id);
      if (!authorization) throw new Error("New authorization could not be read back from the database");
      return { authorization, created: true };
    });
    return create();
  }

  getAuthorization(id: string): Authorization | undefined {
    const row = this.db.prepare("SELECT * FROM authorizations WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id as string,
      userId: row.user_id as string,
      transactionId: row.transaction_id as string,
      productId: row.product_id as string,
      merchantId: row.merchant_id as string,
      amountMinor: row.amount_minor as number,
      currency: row.currency as string,
      createdAt: row.created_at as string,
      expiresAt: row.expires_at as string,
      status: row.status as AuthorizationStatus,
      policyVersion: row.policy_version as number,
      orderId: (row.order_id as string | null) ?? null,
    };
  }

  getAuthorizationByApprovalKey(key: string): Authorization | undefined {
    const row = this.db.prepare("SELECT id FROM authorizations WHERE approval_key = ?").get(key) as
      | { id: string }
      | undefined;
    return row ? this.getAuthorization(row.id) : undefined;
  }

  setOrder(id: string, orderId: string): boolean {
    const result = this.db.prepare(`
      UPDATE authorizations SET order_id = ?, status = 'order_created'
      WHERE id = ? AND status = 'authorized' AND order_id IS NULL
    `).run(orderId, id);
    return result.changes === 1;
  }

  transition(id: string, from: AuthorizationStatus[], to: AuthorizationStatus): boolean {
    if (from.length === 0) return false;
    const placeholders = from.map(() => "?").join(", ");
    const result = this.db.prepare(
      `UPDATE authorizations SET status = ? WHERE id = ? AND status IN (${placeholders})`,
    ).run(to, id, ...from);
    return result.changes === 1;
  }

  addAudit(eventType: string, authorizationId: string | null, detail: string): void {
    this.db.prepare(`
      INSERT INTO audit_events (event_type, authorization_id, detail, created_at)
      VALUES (?, ?, ?, ?)
    `).run(eventType, authorizationId, detail, new Date().toISOString());
  }

  listAudit(limit = 50): AuditEvent[] {
    return this.db.prepare(`
      SELECT id, event_type AS eventType, authorization_id AS authorizationId,
             detail, created_at AS createdAt
      FROM audit_events ORDER BY id DESC LIMIT ?
    `).all(limit) as AuditEvent[];
  }

  close(): void {
    this.db.close();
  }
}
