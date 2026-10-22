import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.js";
import { Store, type Authorization } from "../src/services/database.js";
import type { PaymentProvider, PaymentRecord } from "../src/services/paypal.js";

type AuthorizationResponse = Authorization & {
  product: { merchantId: string } | null;
  error?: { code: string };
};

class FakePayments implements PaymentProvider {
  orderStatus = "APPROVED";
  capturedStatus = "COMPLETED";
  captureCalls = 0;
  failCapture = false;
  lastCreateInput: {
    authorizationId: string;
    transactionId: string;
    amountMinor: number;
    currency: string;
  } | undefined;
  authorizationId = "";
  transactionId = "";
  amountMinor = 0;
  currency = "";

  async createOrder(input: NonNullable<FakePayments["lastCreateInput"]>) {
    this.lastCreateInput = input;
    this.authorizationId = input.authorizationId;
    this.transactionId = input.transactionId;
    this.amountMinor = input.amountMinor;
    this.currency = input.currency;
    return { id: "sandbox-order-1", approveUrl: "https://sandbox.paypal.test/approve" };
  }

  async getOrder(orderId: string) {
    if (orderId !== "sandbox-order-1") throw new Error("unexpected order");
    return {
      id: orderId,
      status: this.orderStatus,
      purchase_units: [{
        custom_id: this.authorizationId,
        invoice_id: this.transactionId,
        reference_id: this.transactionId,
        amount: { currency_code: this.currency, value: (this.amountMinor / 100).toFixed(2) },
        ...(this.orderStatus !== "APPROVED" ? {
          payments: {
            captures: [{
              id: "capture-1",
              status: this.orderStatus,
              amount: { currency_code: this.currency, value: (this.amountMinor / 100).toFixed(2) },
            }],
          },
        } : {}),
      }],
    };
  }

  async captureOrder(): Promise<PaymentRecord> {
    this.captureCalls += 1;
    if (this.failCapture) throw new Error("PayPal timed out");
    this.orderStatus = this.capturedStatus;
    return await this.getOrder("sandbox-order-1");
  }
}

describe("transaction-bound purchase authorization", () => {
  let store: Store;
  let payments: FakePayments;
  let server: ReturnType<ReturnType<typeof createApp>["app"]["listen"]>;
  let baseUrl: string;

  beforeEach(async () => {
    store = new Store(":memory:");
    payments = new FakePayments();
    const { app } = createApp(store, payments);
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}/api`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    store.close();
  });

  async function authorize(
    productId = "headphones-001",
    approvalKey = crypto.randomUUID(),
  ): Promise<{ response: Response; body: AuthorizationResponse }> {
    const response = await fetch(`${baseUrl}/authorizations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productId, approvalKey, amountMinor: 1, merchantId: "attacker" }),
    });
    return { response, body: await response.json() as AuthorizationResponse };
  }

  async function createOrder(authorization: Authorization) {
    return fetch(`${baseUrl}/authorizations/${authorization.id}/order`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
  }

  async function capture(authorization: Authorization) {
    return fetch(`${baseUrl}/authorizations/${authorization.id}/capture`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId: "sandbox-order-1" }),
    });
  }

  async function cancel(authorization: Authorization) {
    return fetch(`${baseUrl}/authorizations/${authorization.id}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId: "sandbox-order-1" }),
    });
  }

  async function updatePolicy(input: {
    allowedMerchantIds?: string[];
    allowedProductIds?: string[];
    maxAmountMinor?: number;
    currency?: string;
  }) {
    const current = store.getPolicy();
    return fetch(`${baseUrl}/policy`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        allowedMerchantIds: input.allowedMerchantIds ?? current.allowedMerchantIds,
        allowedProductIds: input.allowedProductIds ?? current.allowedProductIds,
        maxAmountMinor: input.maxAmountMinor ?? current.maxAmountMinor,
        currency: input.currency ?? current.currency,
      }),
    });
  }

  it("derives immutable amount and merchant from the server catalog", async () => {
    const { response, body } = await authorize();
    expect(response.status).toBe(201);
    expect(body.amountMinor).toBe(12999);
    expect(body.product.merchantId).toBe("soundhouse");
    expect(payments.lastCreateInput).toBeUndefined();
  });

  it("blocks products outside the server-side spending policy", async () => {
    await updatePolicy({ maxAmountMinor: 10000 });
    const response = await fetch(`${baseUrl}/authorizations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productId: "headphones-001", approvalKey: crypto.randomUUID() }),
    });
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("AMOUNT_EXCEEDS_LIMIT");
    expect(store.listAudit().some((event) => event.eventType === "authorization.rejected.amount_exceeds_limit")).toBe(true);
  });

  it("rejects a product excluded from the allowed product list", async () => {
    await updatePolicy({ allowedProductIds: ["headphones-001"] });
    const { response, body } = await authorize("lamp-003");
    expect(response.status).toBe(403);
    expect(body.error?.code).toBe("PRODUCT_NOT_ALLOWED");
    expect(body.id).toBeUndefined();
    expect(store.listAudit().some((event) => event.eventType === "authorization.rejected.product_not_allowed")).toBe(true);
  });

  it("rejects a product from a merchant excluded by policy", async () => {
    await updatePolicy({ allowedMerchantIds: ["dailybrew", "formandfunction", "trailgoods"] });
    const { response, body } = await authorize("headphones-001");
    expect(response.status).toBe(403);
    expect(body.error?.code).toBe("MERCHANT_NOT_ALLOWED");
    expect(store.listAudit().some((event) => event.eventType === "authorization.rejected.merchant_not_allowed")).toBe(true);
  });

  it("rejects a purchase above the configured amount limit", async () => {
    await updatePolicy({ maxAmountMinor: 12998 });
    const { response, body } = await authorize("headphones-001");
    expect(response.status).toBe(403);
    expect(body.error?.code).toBe("AMOUNT_EXCEEDS_LIMIT");
    expect(store.listAudit().some((event) => event.eventType === "authorization.rejected.amount_exceeds_limit")).toBe(true);
  });

  it("rejects a catalog product whose currency differs from policy", async () => {
    const policyResponse = await updatePolicy({ currency: "EUR" });
    expect(policyResponse.status).toBe(200);
    const { response, body } = await authorize("headphones-001");
    expect(response.status).toBe(403);
    expect(body.error?.code).toBe("CURRENCY_NOT_ALLOWED");
    expect(store.listAudit().some((event) => event.eventType === "authorization.rejected.currency_not_allowed")).toBe(true);
  });

  it("returns the same authorization for a replayed approval key", async () => {
    const key = crypto.randomUUID();
    const first = await authorize("headphones-001", key);
    const second = await authorize("headphones-001", key);
    expect(first.body.id).toBe(second.body.id);
    expect(second.response.status).toBe(200);
    expect(store.listAudit().filter((event) => event.eventType === "authorization.created")).toHaveLength(1);
  });

  it("creates PayPal orders using only the approved transaction record", async () => {
    const { body } = await authorize();
    const response = await createOrder(body);
    expect(response.status).toBe(201);
    expect(payments.lastCreateInput).toEqual({
      authorizationId: body.id,
      transactionId: body.transactionId,
      amountMinor: 12999,
      currency: "USD",
    });
  });

  it("expires an authorization before a PayPal order can be created", async () => {
    const { body } = await authorize();
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.parse(body.expiresAt) + 1);
    try {
      const response = await createOrder(body);
      expect(response.status).toBe(409);
      expect((await response.json()).error.code).toBe("AUTHORIZATION_EXPIRED");
    } finally {
      now.mockRestore();
    }
    expect(store.getAuthorization(body.id)?.status).toBe("expired");
    expect(payments.lastCreateInput).toBeUndefined();
    expect(store.listAudit().some((event) => event.eventType === "authorization.expired" && event.authorizationId === body.id)).toBe(true);
  });

  it("expires an authorization before PayPal capture", async () => {
    const { body } = await authorize();
    await createOrder(body);
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.parse(body.expiresAt) + 1);
    try {
      const response = await capture(body);
      expect(response.status).toBe(409);
      expect((await response.json()).error.code).toBe("AUTHORIZATION_EXPIRED");
    } finally {
      now.mockRestore();
    }
    expect(store.getAuthorization(body.id)?.status).toBe("expired");
    expect(payments.captureCalls).toBe(0);
    expect(store.listAudit().some((event) => event.eventType === "authorization.expired" && event.authorizationId === body.id)).toBe(true);
  });

  it("does not capture an order whose PayPal amount has changed", async () => {
    const { body } = await authorize();
    await createOrder(body);
    payments.amountMinor = 1;
    const response = await capture(body);
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("PAYPAL_ORDER_MISMATCH");
    expect(payments.captureCalls).toBe(0);
    expect(store.getAuthorization(body.id)?.status).toBe("order_created");
    expect(store.listAudit().some((event) => event.eventType === "payment.rejected.order_mismatch" && event.authorizationId === body.id)).toBe(true);
  });

  it("does not capture an order associated with another authorization", async () => {
    const { body } = await authorize();
    await createOrder(body);
    payments.authorizationId = crypto.randomUUID();
    const response = await capture(body);
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("PAYPAL_ORDER_MISMATCH");
    expect(payments.captureCalls).toBe(0);
  });

  it("captures and consumes a verified order exactly once", async () => {
    const { body } = await authorize();
    await createOrder(body);
    const response = await capture(body);
    expect(response.status).toBe(200);
    expect(store.getAuthorization(body.id)?.status).toBe("consumed");
    expect(payments.captureCalls).toBe(1);
    expect((await capture(body)).status).toBe(409);
    expect(payments.captureCalls).toBe(1);
  });

  it("does not retry an ambiguous capture", async () => {
    const { body } = await authorize();
    await createOrder(body);
    payments.failCapture = true;
    expect((await capture(body)).status).toBe(502);
    expect(store.getAuthorization(body.id)?.status).toBe("capture_pending");
    expect((await capture(body)).status).toBe(409);
    expect(payments.captureCalls).toBe(1);
  });

  it("keeps a pending capture unused and reconciles it when PayPal completes", async () => {
    const { body } = await authorize();
    await createOrder(body);
    payments.capturedStatus = "PENDING";
    const first = await capture(body);
    expect(first.status).toBe(202);
    expect(store.getAuthorization(body.id)?.status).toBe("capture_pending");

    payments.orderStatus = "COMPLETED";
    expect((await capture(body)).status).toBe(200);
    expect(store.getAuthorization(body.id)?.status).toBe("consumed");
    expect(payments.captureCalls).toBe(1);
  });

  it("records a PayPal cancellation and prevents later capture", async () => {
    const { body } = await authorize();
    await createOrder(body);
    payments.orderStatus = "CREATED";
    expect((await cancel(body)).status).toBe(200);
    expect(store.getAuthorization(body.id)?.status).toBe("cancelled");
    expect((await capture(body)).status).toBe(409);
    expect(payments.captureCalls).toBe(0);
  });

  it("marks a declined PayPal capture as failed", async () => {
    const { body } = await authorize();
    await createOrder(body);
    payments.capturedStatus = "DECLINED";
    expect((await capture(body)).status).toBe(409);
    expect(store.getAuthorization(body.id)?.status).toBe("failed");
  });
});
