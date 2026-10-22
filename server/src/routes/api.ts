import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { catalog } from "../domain/catalog.js";
import { Store, type Authorization, type Policy } from "../services/database.js";
import { configuredLlmProvider, proposePurchase } from "../services/agent.js";
import {
  PayPalSandbox,
  verifyCapturedPayment,
  verifyPayPalOrder,
  type PaymentProvider,
} from "../services/paypal.js";

const demoUserId = "demo-user";

class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const proposalSchema = z.object({ prompt: z.string().trim().min(1).max(500) });
const authorizationSchema = z.object({
  productId: z.string().min(1),
  approvalKey: z.string().uuid(),
});
const policySchema = z.object({
  allowedMerchantIds: z.array(z.string()).max(50),
  allowedProductIds: z.array(z.string()).max(100),
  maxAmountMinor: z.number().int().positive().max(100000000),
  currency: z.string().regex(/^[A-Z]{3}$/),
});

function policyRejection(product: (typeof catalog)[number], policy: Policy): string | null {
  if (!policy.allowedProductIds.includes(product.id)) return "PRODUCT_NOT_ALLOWED";
  if (!policy.allowedMerchantIds.includes(product.merchantId)) return "MERCHANT_NOT_ALLOWED";
  if (product.amountMinor > policy.maxAmountMinor) return "AMOUNT_EXCEEDS_LIMIT";
  if (product.currency !== policy.currency) return "CURRENCY_NOT_ALLOWED";
  return null;
}

function assertUsableAuthorization(authorization: Authorization, store: Store): void {
  if (Date.parse(authorization.expiresAt) <= Date.now()) {
    if (store.transition(authorization.id, ["authorized", "order_created"], "expired")) {
      store.addAudit("authorization.expired", authorization.id, "Expired approval was blocked before payment processing");
    }
    throw new ApiError(409, "AUTHORIZATION_EXPIRED", "This approval has expired. Approve the purchase again.");
  }
  const product = catalog.find(({ id }) => id === authorization.productId);
  if (
    !product
    || product.merchantId !== authorization.merchantId
    || product.amountMinor !== authorization.amountMinor
    || product.currency !== authorization.currency
  ) {
    store.addAudit(
      "authorization.rejected.transaction_mismatch",
      authorization.id,
      "Saved transaction no longer matches the trusted catalog record",
    );
    throw new ApiError(409, "TRANSACTION_MISMATCH", "The approved transaction no longer matches the catalog.");
  }
  const reason = policyRejection(product, store.getPolicy());
  if (reason) {
    store.addAudit(`authorization.rejected.${reason.toLowerCase()}`, authorization.id, "Current purchase rules blocked this transaction");
    throw new ApiError(403, reason, "Current purchase rules do not permit this transaction.");
  }
}

function publicAuthorization(authorization: Authorization) {
  const product = catalog.find(({ id }) => id === authorization.productId);
  return { ...authorization, product: product ?? null };
}

export function createApiRouter(
  store: Store,
  payments: PaymentProvider = new PayPalSandbox(),
): Router {
  const router = Router();

  router.get("/status", (_request, response) => {
    response.json({
      aiProvider: configuredLlmProvider()?.name ?? "local-catalog",
      paypalSandboxConfigured: Boolean(
        process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET,
      ),
      persistence: "sqlite",
    });
  });

  router.get("/catalog", (_request, response) => response.json(catalog));
  router.get("/policy", (_request, response) => response.json(store.getPolicy()));
  router.get("/audit", (_request, response) => response.json(store.listAudit()));

  router.put("/policy", (request, response) => {
    const parsed = policySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError(400, "INVALID_POLICY", parsed.error.message);
    }
    const unknownMerchants = parsed.data.allowedMerchantIds.filter(
      (id) => !catalog.some((product) => product.merchantId === id),
    );
    const unknownProducts = parsed.data.allowedProductIds.filter(
      (id) => !catalog.some((product) => product.id === id),
    );
    if (unknownMerchants.length || unknownProducts.length) {
      throw new ApiError(400, "UNKNOWN_POLICY_TARGET", "Rules may only reference catalog merchants and products.");
    }
    response.json(store.updatePolicy(parsed.data));
  });

  router.post("/agent/propose", async (request, response) => {
    const parsed = proposalSchema.safeParse(request.body);
    if (!parsed.success) throw new ApiError(400, "INVALID_PROMPT", parsed.error.message);
    response.json(await proposePurchase(parsed.data.prompt));
  });

  router.post("/authorizations", (request, response) => {
    const parsed = authorizationSchema.safeParse(request.body);
    if (!parsed.success) throw new ApiError(400, "INVALID_APPROVAL", parsed.error.message);
    const existing = store.getAuthorizationByApprovalKey(parsed.data.approvalKey);
    if (existing) {
      if (existing.productId !== parsed.data.productId) {
        throw new ApiError(409, "IDEMPOTENCY_KEY_REUSED", "This approval request was already used for another product.");
      }
      response.status(200).json(publicAuthorization(existing));
      return;
    }
    const product = catalog.find(({ id }) => id === parsed.data.productId);
    if (!product) throw new ApiError(404, "PRODUCT_NOT_FOUND", "The requested product is not in the catalog.");
    const policy = store.getPolicy();
    const rejection = policyRejection(product, policy);
    if (rejection) {
      store.addAudit(
        `authorization.rejected.${rejection.toLowerCase()}`,
        null,
        `Policy blocked ${product.name} from ${product.merchantName}`,
      );
      throw new ApiError(403, rejection, "Purchase rules do not permit this transaction.");
    }
    const result = store.createAuthorization({
      id: randomUUID(),
      transactionId: randomUUID(),
      approvalKey: parsed.data.approvalKey,
      userId: demoUserId,
      product,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      policyVersion: policy.version,
    });
    if (result.authorization.productId !== parsed.data.productId) {
      throw new ApiError(409, "IDEMPOTENCY_KEY_REUSED", "This approval request was already used for another product.");
    }
    response.status(result.created ? 201 : 200).json(publicAuthorization(result.authorization));
  });

  router.get("/authorizations/:id", (request, response) => {
    const authorization = store.getAuthorization(request.params.id);
    if (!authorization) throw new ApiError(404, "AUTHORIZATION_NOT_FOUND", "Authorization not found.");
    response.json(publicAuthorization(authorization));
  });

  router.post("/authorizations/:id/order", async (request, response) => {
    const authorization = store.getAuthorization(request.params.id);
    if (!authorization) throw new ApiError(404, "AUTHORIZATION_NOT_FOUND", "Authorization not found.");
    assertUsableAuthorization(authorization, store);
    if (authorization.status !== "authorized" || authorization.orderId) {
      throw new ApiError(409, "AUTHORIZATION_NOT_READY", "This authorization cannot create another PayPal order.");
    }
    const order = await payments.createOrder({
      authorizationId: authorization.id,
      transactionId: authorization.transactionId,
      amountMinor: authorization.amountMinor,
      currency: authorization.currency,
    });
    if (!store.setOrder(authorization.id, order.id)) {
      throw new ApiError(409, "DUPLICATE_ORDER_REQUEST", "An order was already created for this authorization.");
    }
    store.addAudit("payment.order_created", authorization.id, `PayPal Sandbox order ${order.id} created`);
    response.status(201).json({ orderId: order.id, approveUrl: order.approveUrl });
  });

  router.post("/authorizations/:id/capture", async (request, response) => {
    const orderId = z.string().min(1).safeParse(request.body?.orderId);
    if (!orderId.success) throw new ApiError(400, "INVALID_ORDER_ID", "A PayPal order ID is required.");
    const authorization = store.getAuthorization(request.params.id);
    if (!authorization) throw new ApiError(404, "AUTHORIZATION_NOT_FOUND", "Authorization not found.");
    assertUsableAuthorization(authorization, store);
    if (!authorization.orderId || authorization.orderId !== orderId.data) {
      store.addAudit("payment.rejected.order_mismatch", authorization.id, "Capture request referenced an order not bound to this authorization");
      throw new ApiError(409, "ORDER_MISMATCH", "This PayPal order does not belong to the approved transaction.");
    }
    if (authorization.status === "consumed") {
      throw new ApiError(409, "AUTHORIZATION_ALREADY_CONSUMED", "This authorization has already been used.");
    }
    if (!["order_created", "capturing", "capture_pending"].includes(authorization.status)) {
      throw new ApiError(409, "AUTHORIZATION_NOT_READY", "This authorization is not ready for capture.");
    }

    const expected = {
      authorizationId: authorization.id,
      transactionId: authorization.transactionId,
      amountMinor: authorization.amountMinor,
      currency: authorization.currency,
    };
    const order = await payments.getOrder(orderId.data);
    if (["VOIDED", "CANCELLED"].includes(order.status)) {
      store.transition(authorization.id, ["order_created", "capture_pending"], "cancelled");
      store.addAudit("payment.cancelled", authorization.id, `PayPal order ${orderId.data} was cancelled`);
      throw new ApiError(409, "PAYPAL_ORDER_CANCELLED", "The PayPal order was cancelled.");
    }
    if (order.status === "COMPLETED") {
      const captureStatus = order.purchase_units?.[0]?.payments?.captures?.[0]?.status;
      if (captureStatus === "PENDING") {
        store.transition(authorization.id, ["order_created", "capture_pending"], "capture_pending");
        store.addAudit("payment.pending", authorization.id, "PayPal reports a pending capture; authorization remains unused");
        response.status(202).json({ status: "PENDING", authorization: publicAuthorization(store.getAuthorization(authorization.id)!) });
        return;
      }
      if (!verifyCapturedPayment(order, expected)) {
        store.addAudit("payment.rejected.capture_mismatch", authorization.id, "Completed PayPal payment did not match the authorized transaction");
        throw new ApiError(409, "CAPTURE_MISMATCH", "The completed PayPal payment does not match the approved transaction.");
      }
      if (!store.transition(authorization.id, ["order_created", "capturing", "capture_pending"], "consumed")) {
        throw new ApiError(409, "AUTHORIZATION_STATE_CHANGED", "Authorization state changed during payment verification.");
      }
      store.addAudit("payment.verified", authorization.id, "Existing completed PayPal payment verified and reconciled");
      response.json({ status: "COMPLETED", authorization: publicAuthorization(store.getAuthorization(authorization.id)!) });
      return;
    }
    if (order.status !== "APPROVED" || !verifyPayPalOrder(order, expected)) {
      store.addAudit("payment.rejected.order_mismatch", authorization.id, "PayPal order failed authorization, amount, currency, or transaction verification");
      throw new ApiError(409, "PAYPAL_ORDER_MISMATCH", "PayPal order is not approved or does not match the authorized transaction.");
    }
    if (!store.transition(authorization.id, ["order_created"], "capturing")) {
      throw new ApiError(409, "CAPTURE_IN_PROGRESS", "A capture is already in progress or this authorization is no longer usable.");
    }
    store.addAudit("payment.capture_started", authorization.id, "Approved PayPal order passed server-side verification");
    let payment;
    try {
      payment = await payments.captureOrder(orderId.data, authorization.transactionId);
    } catch (error) {
      store.transition(authorization.id, ["capturing"], "capture_pending");
      store.addAudit("payment.capture_pending", authorization.id, "Capture response was unavailable; reconcile before retrying");
      throw error;
    }
    if (!verifyCapturedPayment(payment, expected)) {
      const captureStatus = payment.purchase_units?.[0]?.payments?.captures?.[0]?.status;
      if (captureStatus === "PENDING" || payment.status === "PENDING") {
        store.transition(authorization.id, ["capturing"], "capture_pending");
        store.addAudit("payment.pending", authorization.id, "PayPal accepted the capture but reports it as pending");
        response.status(202).json({ status: "PENDING", authorization: publicAuthorization(store.getAuthorization(authorization.id)!) });
        return;
      }
      if (captureStatus === "DECLINED" || captureStatus === "FAILED") {
        store.transition(authorization.id, ["capturing"], "failed");
        store.addAudit("payment.failed", authorization.id, `PayPal capture returned ${captureStatus}`);
        throw new ApiError(409, "PAYPAL_CAPTURE_FAILED", "PayPal did not complete the capture.");
      }
      store.transition(authorization.id, ["capturing"], "capture_pending");
      store.addAudit("payment.capture_pending", authorization.id, "PayPal capture result requires reconciliation");
      throw new ApiError(502, "CAPTURE_RESULT_UNVERIFIED", "PayPal did not return a verified completed capture.");
    }
    if (!store.transition(authorization.id, ["capturing"], "consumed")) {
      throw new ApiError(409, "AUTHORIZATION_STATE_CHANGED", "Authorization state changed before capture could be finalized.");
    }
    store.addAudit("payment.verified", authorization.id, "PayPal capture verified against the approved transaction");
    response.json({ status: payment.status, authorization: publicAuthorization(store.getAuthorization(authorization.id)!) });
  });

  router.post("/authorizations/:id/cancel", async (request, response) => {
    const orderId = z.string().min(1).safeParse(request.body?.orderId);
    if (!orderId.success) throw new ApiError(400, "INVALID_ORDER_ID", "A PayPal order ID is required.");
    const authorization = store.getAuthorization(request.params.id);
    if (!authorization) throw new ApiError(404, "AUTHORIZATION_NOT_FOUND", "Authorization not found.");
    if (authorization.orderId !== orderId.data || authorization.status !== "order_created") {
      throw new ApiError(409, "AUTHORIZATION_NOT_CANCELLABLE", "This PayPal order cannot be cancelled in its current state.");
    }
    const order = await payments.getOrder(orderId.data);
    if (order.status === "APPROVED" || order.status === "COMPLETED") {
      throw new ApiError(409, "PAYPAL_ORDER_ALREADY_APPROVED", "This PayPal order has already been approved.");
    }
    if (!store.transition(authorization.id, ["order_created"], "cancelled")) {
      throw new ApiError(409, "AUTHORIZATION_STATE_CHANGED", "Authorization state changed before cancellation.");
    }
    store.addAudit("payment.cancelled", authorization.id, `PayPal order ${orderId.data} approval was cancelled`);
    response.json({ status: "CANCELLED", authorization: publicAuthorization(store.getAuthorization(authorization.id)!) });
  });

  return router;
}

export function errorHandler(
  error: unknown,
  _request: import("express").Request,
  response: import("express").Response,
  next: import("express").NextFunction,
): void {
  if (response.headersSent) {
    next(error);
    return;
  }
  if (error instanceof ApiError) {
    response.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  const message = error instanceof Error ? error.message : "An unexpected server error occurred";
  console.error(error);
  response.status(502).json({ error: { code: "UPSTREAM_OR_SERVER_ERROR", message } });
}
