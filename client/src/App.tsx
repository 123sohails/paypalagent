import { useCallback, useEffect, useMemo, useState } from "react";

type Product = {
  id: string;
  name: string;
  description: string;
  merchantId: string;
  merchantName: string;
  amountMinor: number;
  currency: string;
  imageUrl: string;
};
type Policy = {
  allowedMerchantIds: string[];
  allowedProductIds: string[];
  maxAmountMinor: number;
  currency: string;
  version: number;
};
type Authorization = {
  id: string;
  productId: string;
  amountMinor: number;
  currency: string;
  expiresAt: string;
  status: string;
  product: Product | null;
};
type AuditEvent = {
  id: number;
  eventType: string;
  detail: string;
  createdAt: string;
};
type AppStatus = {
  aiProvider: string;
  paypalSandboxConfigured: boolean;
  persistence: string;
};
type Proposal = {
  product: Product | null;
  alternatives: Product[];
  explanation: string;
  provider: string;
};
type SecurityRejection = {
  code: string;
  message: string;
  product: Product | null;
};

class ApiError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
  }
}

const apiBase = import.meta.env.VITE_API_URL ?? "/api";

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  const body = await response.json();
  if (!response.ok) {
    const message = body?.error?.message ?? `Request failed (${response.status})`;
    throw new ApiError(message, body?.error?.code ?? "REQUEST_FAILED");
  }
  return body as T;
}

function money(amountMinor: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amountMinor / 100);
}

function policyReason(product: Product, policy: Policy | null): string | null {
  if (!policy) return "Purchase rules are still loading.";
  if (!policy.allowedProductIds.includes(product.id)) return "Product is not on the allowed-products list.";
  if (!policy.allowedMerchantIds.includes(product.merchantId)) return "Merchant is not on the allowed-merchants list.";
  if (product.amountMinor > policy.maxAmountMinor) return `Exceeds your ${money(policy.maxAmountMinor, policy.currency)} per-purchase limit.`;
  if (product.currency !== policy.currency) return `Product is ${product.currency}; your policy requires ${policy.currency}.`;
  return null;
}

function authorizationLabel(status: string): string {
  const labels: Record<string, string> = {
    authorized: "Approval recorded",
    order_created: "Awaiting PayPal approval",
    capturing: "Verifying payment",
    capture_pending: "Capture pending reconciliation",
    consumed: "Payment captured & verified",
    failed: "Payment failed",
    cancelled: "Checkout cancelled",
    expired: "Approval expired",
  };
  return labels[status] ?? "Transaction status unavailable";
}

function auditLabel(eventType: string): string {
  const labels: Record<string, string> = {
    "authorization.created": "Authorization created",
    "authorization.expired": "Authorization expired",
    "policy.updated": "Purchase rules updated",
    "payment.order_created": "PayPal order created",
    "payment.capture_started": "Capture verification started",
    "payment.verified": "Capture verified",
    "payment.capture_pending": "Capture pending reconciliation",
    "payment.pending": "Payment pending",
    "payment.failed": "Payment failed",
    "payment.cancelled": "Checkout cancelled",
    "payment.rejected.order_mismatch": "PayPal order rejected",
    "payment.rejected.capture_mismatch": "Completed payment rejected",
    "authorization.rejected.product_not_allowed": "Product blocked by policy",
    "authorization.rejected.merchant_not_allowed": "Merchant blocked by policy",
    "authorization.rejected.amount_exceeds_limit": "Purchase blocked by budget",
    "authorization.rejected.currency_not_allowed": "Currency blocked by policy",
    "authorization.rejected.transaction_mismatch": "Transaction integrity check failed",
  };
  return labels[eventType] ?? eventType.replaceAll(".", " ").replaceAll("_", " ");
}

function rejectionLabel(code: string): string {
  const labels: Record<string, string> = {
    PRODUCT_NOT_ALLOWED: "Product is not allowed by your policy.",
    MERCHANT_NOT_ALLOWED: "Merchant is not allowed by your policy.",
    AMOUNT_EXCEEDS_LIMIT: "Purchase exceeds your spending limit.",
    CURRENCY_NOT_ALLOWED: "Product currency does not match your policy.",
    AUTHORIZATION_EXPIRED: "This approval expired before payment processing.",
    ORDER_MISMATCH: "PayPal order is not bound to this approved transaction.",
    PAYPAL_ORDER_MISMATCH: "PayPal order did not match the transaction you approved.",
    CAPTURE_MISMATCH: "Completed payment did not match the saved authorization.",
    IDEMPOTENCY_KEY_REUSED: "This approval key was already used for a different transaction.",
  };
  return labels[code] ?? "The server rejected this transaction.";
}

function App() {
  const [catalog, setCatalog] = useState<Product[]>([]);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [savedPolicy, setSavedPolicy] = useState<Policy | null>(null);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [prompt, setPrompt] = useState("");
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [activeAuthorization, setActiveAuthorization] = useState<Authorization | null>(null);
  const [reviewProduct, setReviewProduct] = useState<Product | null>(null);
  const [securityRejection, setSecurityRejection] = useState<SecurityRejection | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [policyDirty, setPolicyDirty] = useState(false);

  const refresh = useCallback(async () => {
    const [products, rules, events, appStatus] = await Promise.all([
      api<Product[]>("/catalog"),
      api<Policy>("/policy"),
      api<AuditEvent[]>("/audit"),
      api<AppStatus>("/status"),
    ]);
    setCatalog(products);
    setPolicy(rules);
    setSavedPolicy(rules);
    setAudit(events);
    setStatus(appStatus);
  }, []);

  useEffect(() => {
    refresh().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Could not connect to AgentGuard."));
  }, [refresh]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const authorizationId = params.get("authorizationId");
    const orderId = params.get("token");
    if (params.get("cancelled")) {
      window.history.replaceState({}, "", "/");
      if (!authorizationId || !orderId) {
        setNotice("PayPal approval was cancelled. Your authorization remains unused.");
        return;
      }
      setBusy(true);
      api<{ authorization: Authorization }>(
        `/authorizations/${encodeURIComponent(authorizationId)}/cancel`,
        { method: "POST", body: JSON.stringify({ orderId }) },
      )
        .then(({ authorization }) => {
          setActiveAuthorization(authorization);
          setNotice("PayPal approval was cancelled. The authorization is now unusable.");
          return refresh();
        })
        .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Could not verify PayPal cancellation."))
        .finally(() => setBusy(false));
      return;
    }
    if (!authorizationId || !orderId) return;
    setBusy(true);
    api<{ status: string; authorization: Authorization }>(
      `/authorizations/${encodeURIComponent(authorizationId)}/capture`,
      { method: "POST", body: JSON.stringify({ orderId }) },
    )
      .then(({ authorization }) => {
        setActiveAuthorization(authorization);
        setNotice("Payment verified. PayPal capture matches the transaction you approved.");
        return refresh();
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : "Could not verify the PayPal payment.");
        if (reason instanceof ApiError) {
          setSecurityRejection({ code: reason.code, message: reason.message, product: null });
        }
      })
      .finally(() => {
        setBusy(false);
        window.history.replaceState({}, "", "/");
      });
  }, [refresh]);

  const merchants = useMemo(
    () => [...new Map(catalog.map(({ merchantId, merchantName }) => [merchantId, merchantName])).entries()],
    [catalog],
  );

  async function findItem(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api<Proposal>("/agent/propose", {
        method: "POST",
        body: JSON.stringify({ prompt }),
      });
      setProposal(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The shopping assistant could not respond.");
    } finally {
      setBusy(false);
    }
  }

  async function approve(item: Product) {
    setBusy(true);
    setError("");
    setNotice("");
    setSecurityRejection(null);
    setReviewProduct(null);
    try {
      const approvalKey = crypto.randomUUID();
      const authorization = await api<Authorization>("/authorizations", {
        method: "POST",
        body: JSON.stringify({ productId: item.id, approvalKey }),
      });
      setActiveAuthorization(authorization);
      await refresh();
      if (!status?.paypalSandboxConfigured) {
        setNotice("Exact transaction approved and recorded. Add PayPal Sandbox credentials to continue to checkout.");
        return;
      }
      const order = await api<{ orderId: string; approveUrl: string }>(
        `/authorizations/${encodeURIComponent(authorization.id)}/order`,
        { method: "POST", body: "{}" },
      );
      setActiveAuthorization({ ...authorization, status: "order_created" });
      window.location.assign(order.approveUrl);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not authorize this purchase.");
      if (reason instanceof ApiError) {
        setSecurityRejection({ code: reason.code, message: reason.message, product: item });
      }
      await refresh().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  async function savePolicy(event: React.FormEvent) {
    event.preventDefault();
    if (!policy) return;
    setBusy(true);
    setError("");
    try {
      const updated = await api<Policy>("/policy", {
        method: "PUT",
        body: JSON.stringify({
          allowedMerchantIds: policy.allowedMerchantIds,
          allowedProductIds: policy.allowedProductIds,
          maxAmountMinor: policy.maxAmountMinor,
          currency: policy.currency,
        }),
      });
      setPolicy(updated);
      setSavedPolicy(updated);
      setPolicyDirty(false);
      setNotice(`Purchase rules saved as policy version ${updated.version}.`);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save purchase rules.");
    } finally {
      setBusy(false);
    }
  }

  function toggleMerchant(id: string) {
    if (!policy) return;
    setPolicyDirty(true);
    const enabled = policy.allowedMerchantIds.includes(id);
    setPolicy({
      ...policy,
      allowedMerchantIds: enabled
        ? policy.allowedMerchantIds.filter((entry) => entry !== id)
        : [...policy.allowedMerchantIds, id],
    });
  }

  function toggleProduct(id: string) {
    if (!policy) return;
    setPolicyDirty(true);
    const enabled = policy.allowedProductIds.includes(id);
    setPolicy({
      ...policy,
      allowedProductIds: enabled
        ? policy.allowedProductIds.filter((entry) => entry !== id)
        : [...policy.allowedProductIds, id],
    });
  }

  const shownProducts = proposal?.product
    ? [proposal.product, ...proposal.alternatives]
    : catalog;

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="AgentGuard home">
          <span className="brand-mark"><span /></span>
          <span>agentguard<span className="brand-dot">.</span></span>
        </a>
        <div className="topbar-right">
          <nav className="top-nav" aria-label="Main navigation"><a href="#dashboard">Dashboard</a><a href="#activity">Activity</a></nav>
          <span className="environment"><i /> Sandbox</span>
          <div className="avatar">S</div>
        </div>
      </header>

      <main className="page" id="dashboard">
        <section className="hero">
          <div>
            <div className="eyebrow"><span className="eyebrow-line" /> INTENTLOCK PROTECTION</div>
            <h1>Shop with an agent.<br /><em>Stay in control.</em></h1>
            <p className="hero-copy">Your agent finds the right thing. You approve the exact transaction.<br className="desktop-break" /> We make sure that’s what gets paid.</p>
          </div>
          <div className="hero-shield" aria-hidden="true">
            <div className="shield-orbit orbit-one" />
            <div className="shield-orbit orbit-two" />
            <div className="shield"><span>✓</span></div>
            <span className="orbit-dot dot-one" /><span className="orbit-dot dot-two" />
          </div>
        </section>

        <section className="status-row" aria-label="Service status">
          <div className="status-item"><span className="status-icon">✦</span><span>AI agent</span><strong>{status?.aiProvider && status.aiProvider !== "local-catalog" ? `${status.aiProvider} configured` : "Catalog mode"}</strong><span className="status-dot" /></div>
          <div className="status-item"><span className="paypal-mark">P</span><span>PayPal</span><strong>{status?.paypalSandboxConfigured ? "Sandbox configured" : "Not configured"}</strong><span className={`status-dot ${status?.paypalSandboxConfigured ? "active" : ""}`} /></div>
          <div className="status-item"><span className="status-icon">▤</span><span>Persistence</span><strong>{status?.persistence ?? "Checking…"}</strong><span className={`status-dot ${status?.persistence ? "active" : ""}`} /></div>
        </section>

        {(error || notice) && (
          <div className={`banner ${error ? "banner-error" : "banner-success"}`} role="status">
            <span>{error ? "!" : "✓"}</span>{error || notice}
            <button onClick={() => { setError(""); setNotice(""); }} aria-label="Dismiss">×</button>
          </div>
        )}

        <div className="workspace-grid">
          <div className="main-column">
            <section className="panel shopping-panel">
              <div className="panel-heading">
                <div><span className="step-label">01 / DISCOVER</span><h2>What are you looking for?</h2></div>
                <span className="agent-badge"><span>✦</span> AI SHOPPING AGENT</span>
              </div>
              <form className="search-form" onSubmit={findItem}>
                <span className="search-icon">⌕</span>
                <input
                  aria-label="Shopping request"
                  placeholder="Try “noise-cancelling headphones under $150”"
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  maxLength={500}
                />
                <button className="button button-dark" disabled={busy || !prompt.trim()}>{busy ? "Working…" : "Find a product"} <span>↗</span></button>
              </form>
              <div className="quick-prompts">
                <span>TRY</span>
                {["Headphones for travel", "Coffee gear", "A desk lamp"].map((suggestion) => (
                  <button key={suggestion} onClick={() => setPrompt(suggestion)}>{suggestion}</button>
                ))}
              </div>
              {proposal && (
                <div className="agent-response">
                  <div className="agent-response-icon">✦</div>
                  <div><strong>Agent recommendation</strong><p>{proposal.explanation}</p><small>{proposal.provider === "local-catalog" ? "via local catalog search" : `via ${proposal.provider} tool calling`}</small></div>
                </div>
              )}
            </section>

            <section className="catalog-section">
              <div className="section-heading">
                <div><span className="step-label">02 / REVIEW</span><h2>{proposal ? "Review the match" : "The demo catalog"}</h2></div>
                <span className="catalog-count">{shownProducts.length} ITEMS</span>
              </div>
              {proposal && !proposal.product ? (
                <div className="empty-state">No matching products were found. Try another request or browse the full catalog.</div>
              ) : (
                <div className="product-grid">
                  {shownProducts.map((product, index) => {
                    const blockReason = policyReason(product, savedPolicy);
                    const allowed = blockReason === null;
                    return (
                      <article className={`product-card ${proposal?.product?.id === product.id ? "featured-card" : ""}`} key={product.id}>
                        <div className="product-image">
                          <img src={product.imageUrl} alt="" />
                          {proposal?.product?.id === product.id && <span className="match-pill">BEST MATCH</span>}
                          <span className="product-index">0{index + 1}</span>
                        </div>
                        <div className="product-info">
                          <div className="product-merchant">{product.merchantName}</div>
                          <h3>{product.name}</h3>
                          <p>{product.description}</p>
                          <div className={`policy-result ${allowed ? "policy-allowed" : "policy-blocked"}`}>
                            <span>{allowed ? "✓" : "!"}</span>
                            <span>{allowed ? "Within current server policy" : blockReason}</span>
                          </div>
                          <div className="product-footer">
                            <strong>{money(product.amountMinor, product.currency)}</strong>
                            <button className="button button-outline" disabled={busy || !allowed} onClick={() => setReviewProduct(product)}>
                              {allowed ? "Review purchase" : "Not permitted"} <span>→</span>
                            </button>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </section>

            {activeAuthorization && (
              <section className={`authorization-card status-${activeAuthorization.status}`}>
                <div className="authorization-check">{activeAuthorization.status === "consumed" ? "✓" : activeAuthorization.status === "failed" || activeAuthorization.status === "expired" ? "!" : "·"}</div>
                <div><span className="step-label">TRANSACTION-BOUND APPROVAL</span><h3>{activeAuthorization.product?.name ?? "Purchase approval"}</h3>
                  <p>{money(activeAuthorization.amountMinor, activeAuthorization.currency)} · Expires {new Date(activeAuthorization.expiresAt).toLocaleTimeString()}</p>
                  <code>AUTH {activeAuthorization.id.slice(0, 8).toUpperCase()} · {authorizationLabel(activeAuthorization.status)}</code>
                </div>
              </section>
            )}
            {securityRejection && (
              <section className="security-rejection" role="alert">
                <div className="rejection-mark">!</div>
                <div>
                  <span className="step-label">SERVER SECURITY DECISION · {securityRejection.code}</span>
                  <h3>Transaction rejected</h3>
                  <p>{rejectionLabel(securityRejection.code)} {securityRejection.message}</p>
                  {securityRejection.product && <small>Attempted item: {securityRejection.product.name} · {securityRejection.product.merchantName} · {money(securityRejection.product.amountMinor, securityRejection.product.currency)}.</small>}
                </div>
                <button onClick={() => setSecurityRejection(null)} aria-label="Dismiss rejection">×</button>
              </section>
            )}
          </div>

          <aside className="side-column">
            <section className="panel rules-panel">
              <div className="panel-heading compact">
                <div><span className="step-label">YOUR GUARDRAILS</span><h2>Purchase rules</h2></div>
                <span className="version-pill">V{savedPolicy?.version ?? "—"}</span>
              </div>
              {policy && (
                <form onSubmit={savePolicy}>
                  <label className="field-label" htmlFor="limit">MAX PER PURCHASE</label>
                  <div className="money-input"><span>{policy.currency === "USD" ? "$" : policy.currency}</span><input id="limit" type="number" min="1" max="1000000" step="1" value={policy.maxAmountMinor / 100} onChange={(event) => { setPolicy({ ...policy, maxAmountMinor: Math.round(Number(event.target.value || 0) * 100) }); setPolicyDirty(true); }} /><select aria-label="Policy currency" value={policy.currency} onChange={(event) => { setPolicy({ ...policy, currency: event.target.value }); setPolicyDirty(true); }}><option value="USD">USD</option><option value="EUR">EUR</option><option value="GBP">GBP</option></select></div>
                  <div className="policy-summary"><span>{policyDirty ? "Saved server-enforced cap" : "Current server-enforced cap"}</span><strong>{savedPolicy ? money(savedPolicy.maxAmountMinor, savedPolicy.currency) : "Loading…"}</strong></div>
                  {policyDirty && <p className="unsaved-policy-note">Draft edits are not enforced until saved.</p>}
                  <div className="rule-divider" />
                  <div className="field-label">ALLOWED MERCHANTS</div>
                  <div className="check-list">
                    {merchants.map(([id, name]) => <label className="check-row" key={id}><input type="checkbox" checked={policy.allowedMerchantIds.includes(id)} onChange={() => toggleMerchant(id)} /><span className="custom-check">✓</span><span>{name}</span></label>)}
                  </div>
                  <div className="rule-divider" />
                  <div className="field-label">ALLOWED PRODUCTS</div>
                  <div className="check-list">
                    {catalog.map(({ id, name }) => <label className="check-row" key={id}><input type="checkbox" checked={policy.allowedProductIds.includes(id)} onChange={() => toggleProduct(id)} /><span className="custom-check">✓</span><span>{name}</span></label>)}
                  </div>
                  <button className="button button-dark save-button" disabled={busy || !policyDirty}>{policyDirty ? "Save purchase rules" : "Rules are up to date"} <span>→</span></button>
                  <p className="rule-footnote"><span>⛨</span> Rules are enforced by the server, not the shopping agent.</p>
                </form>
              )}
            </section>

            <section className="panel audit-panel" id="activity">
              <div className="panel-heading compact">
                <div><span className="step-label">LIVE ACTIVITY</span><h2>Audit trail</h2></div>
                <span className="live-indicator"><i /> RECENT</span>
              </div>
              <div className="audit-list">
                {audit.slice(0, 5).map((event) => (
                  <div className="audit-event" key={event.id}>
                    <span className={`audit-icon ${event.eventType.includes("rejected") ? "audit-warn" : ""}`}>{event.eventType.includes("verified") ? "✓" : event.eventType.includes("rejected") ? "!" : "·"}</span>
                    <div><strong>{auditLabel(event.eventType)}</strong><p>{event.detail}</p><time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time></div>
                  </div>
                ))}
                {audit.length === 0 && <p className="audit-empty">Your security events will appear here.</p>}
              </div>
              <div className="audit-footer"><span>SQLite-backed · retention depends on host storage</span><span>●</span></div>
            </section>
          </aside>
        </div>

        <footer className="page-footer"><span>AGENTGUARD <b>·</b> INTENTLOCK</span><span>AI proposes. You approve. The server verifies.</span><span>DEMO ENVIRONMENT</span></footer>
      </main>

      {reviewProduct && (
        <div className="review-overlay" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setReviewProduct(null);
        }}>
          <section
            className="review-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="review-title"
            onKeyDown={(event) => { if (event.key === "Escape") setReviewProduct(null); }}
          >
            <div className="dialog-topline"><span className="step-label">FINAL CHECK · USER APPROVAL REQUIRED</span><button onClick={() => setReviewProduct(null)} aria-label="Close transaction review">×</button></div>
            <h2 id="review-title">Review your purchase</h2>
            <p className="dialog-intro">Only approve if these exact transaction details are what you intend to buy.</p>
            <div className="review-item">
              <img src={reviewProduct.imageUrl} alt="" />
              <div><span className="product-merchant">{reviewProduct.merchantName}</span><h3>{reviewProduct.name}</h3><p>{reviewProduct.description}</p></div>
            </div>
            <div className="review-total"><span>Total · {reviewProduct.currency}</span><strong>{money(reviewProduct.amountMinor, reviewProduct.currency)}</strong></div>
            <div className="review-checks">
              <div><span>✓</span><p><strong>Current policy</strong><small>The server checks product, merchant, currency, and amount again when you approve.</small></p></div>
              <div><span>✓</span><p><strong>Transaction-bound authorization</strong><small>A new approval is tied to this exact item and expires in 10 minutes.</small></p></div>
              <div><span>✓</span><p><strong>PayPal verification</strong><small>The Sandbox order must match the saved authorization before capture.</small></p></div>
            </div>
            <div className="dialog-actions">
              <button className="button button-outline dialog-cancel" onClick={() => setReviewProduct(null)}>Go back</button>
              <button className="button button-dark dialog-approve" autoFocus disabled={busy} onClick={() => approve(reviewProduct)}>{busy ? "Checking rules…" : "Approve this exact transaction"} <span>→</span></button>
            </div>
            <p className="dialog-disclaimer">Sandbox environment. Once issued, this authorization cannot be edited.</p>
          </section>
        </div>
      )}
    </div>
  );
}

export default App;
