type PayPalLink = { rel: string; href: string };

type PayPalOrder = {
  id: string;
  status: string;
  purchase_units?: Array<{
    reference_id?: string;
    custom_id?: string;
    invoice_id?: string;
    amount?: { currency_code?: string; value?: string };
    payments?: {
      captures?: Array<{
        id: string;
        status: string;
        amount?: { currency_code?: string; value?: string };
      }>;
    };
  }>;
  links?: PayPalLink[];
};

export type PaymentRecord = {
  id: string;
  status: string;
  purchase_units?: PayPalOrder["purchase_units"];
};

export interface PaymentProvider {
  createOrder(input: {
    authorizationId: string;
    transactionId: string;
    amountMinor: number;
    currency: string;
  }): Promise<{ id: string; approveUrl: string }>;
  getOrder(orderId: string): Promise<PayPalOrder>;
  captureOrder(orderId: string, requestId: string): Promise<PaymentRecord>;
}

function amountValue(amountMinor: number): string {
  return (amountMinor / 100).toFixed(2);
}

export class PayPalSandbox implements PaymentProvider {
  private readonly baseUrl = "https://api-m.sandbox.paypal.com";

  private get configured(): boolean {
    return Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
  }

  private async accessToken(): Promise<string> {
    if (!this.configured) throw new Error("PayPal Sandbox credentials are not configured");
    const credentials = Buffer.from(
      `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`,
    ).toString("base64");
    const response = await fetch(`${this.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (!response.ok) {
      throw new Error(`PayPal OAuth returned HTTP ${response.status}: ${await response.text()}`);
    }
    const data = (await response.json()) as { access_token?: string };
    if (!data.access_token) throw new Error("PayPal OAuth response did not contain an access token");
    return data.access_token;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await this.accessToken();
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
    if (!response.ok) {
      throw new Error(`PayPal API returned HTTP ${response.status}: ${await response.text()}`);
    }
    return await response.json() as T;
  }

  async createOrder(input: {
    authorizationId: string;
    transactionId: string;
    amountMinor: number;
    currency: string;
  }): Promise<{ id: string; approveUrl: string }> {
    const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:5173";
    const order = await this.request<PayPalOrder>("/v2/checkout/orders", {
      method: "POST",
      headers: { "PayPal-Request-Id": input.transactionId },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [{
          reference_id: input.transactionId,
          custom_id: input.authorizationId,
          invoice_id: input.transactionId,
          amount: { currency_code: input.currency, value: amountValue(input.amountMinor) },
        }],
        application_context: {
          user_action: "PAY_NOW",
          return_url: `${frontendUrl}/?authorizationId=${encodeURIComponent(input.authorizationId)}`,
          cancel_url: `${frontendUrl}/?authorizationId=${encodeURIComponent(input.authorizationId)}&cancelled=1`,
        },
      }),
    });
    const approveUrl = order.links?.find((link) => link.rel === "approve")?.href;
    if (!order.id || !approveUrl) throw new Error("PayPal create-order response is missing the order ID or approval link");
    return { id: order.id, approveUrl };
  }

  getOrder(orderId: string): Promise<PayPalOrder> {
    return this.request<PayPalOrder>(`/v2/checkout/orders/${encodeURIComponent(orderId)}`);
  }

  captureOrder(orderId: string, requestId: string): Promise<PaymentRecord> {
    return this.request<PaymentRecord>(
      `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
      {
        method: "POST",
        headers: { "PayPal-Request-Id": requestId },
        body: "{}",
      },
    );
  }
}

export function verifyPayPalOrder(
  order: PayPalOrder,
  expected: { authorizationId: string; transactionId: string; amountMinor: number; currency: string },
): boolean {
  const unit = order.purchase_units?.[0];
  return order.status === "APPROVED"
    && order.purchase_units?.length === 1
    && unit?.custom_id === expected.authorizationId
    && unit.invoice_id === expected.transactionId
    && unit.reference_id === expected.transactionId
    && unit.amount?.currency_code === expected.currency
    && unit.amount.value === amountValue(expected.amountMinor);
}

export function verifyCapturedPayment(
  payment: PaymentRecord,
  expected: { authorizationId: string; transactionId: string; amountMinor: number; currency: string },
): boolean {
  const unit = payment.purchase_units?.[0];
  const capture = unit?.payments?.captures?.[0];
  return payment.status === "COMPLETED"
    && payment.purchase_units?.length === 1
    && unit?.custom_id === expected.authorizationId
    && unit.invoice_id === expected.transactionId
    && unit.reference_id === expected.transactionId
    && unit.amount?.currency_code === expected.currency
    && unit.amount.value === amountValue(expected.amountMinor)
    && capture?.status === "COMPLETED"
    && capture.amount?.currency_code === expected.currency
    && capture.amount.value === amountValue(expected.amountMinor);
}
