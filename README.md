# AgentGuard — IntentLock
# AgentGuard — IntentLock

**Security and transaction-bound authorization for AI-powered commerce.**

AgentGuard is a local-first prototype that makes a user approve a specific catalog item before a PayPal Sandbox order can be created. The server stores the approved product, merchant, amount, currency, expiry, policy version, and order state in SQLite. Before capture, it fetches the order from PayPal and compares the order and capture against that saved record.

## Current prototype scope

- React + TypeScript + Vite dashboard for catalog search, editable rules, approval, and audit events.
- Express + TypeScript API with Zod request validation and deterministic policy enforcement.
- SQLite persistence for rules, authorizations, and audit events.
- Optional OpenAI-compatible Chat Completions tool-calling integration limited to catalog search. This supports OpenAI and compatible endpoints such as Groq, OpenRouter, Together, and local Ollama models that implement tool calling. Without a configured endpoint/key, local catalog matching is used and clearly identified in the UI.
- PayPal Orders v2 Sandbox integration using server-side OAuth, order creation, order retrieval, and capture. The server always uses PayPal's Sandbox host.
- Idempotent approval keys, one order per authorization, atomic state transitions, amount/currency/transaction verification, and capture reconciliation without blindly repeating an ambiguous capture.

The demo uses a single fixed `demo-user`, a small static USD catalog, and a browser redirect to PayPal's approval URL. It is not production authentication, a multi-user service, a live-payment integration, or a general-purpose shopping agent. External product image URLs require internet access.

## Requirements

- Node.js 20 or newer and npm.
- PayPal Developer Sandbox REST app credentials to complete a sandbox checkout.
- Optional API key for a real model tool-calling recommendation. OpenAI-compatible providers such as Groq, OpenRouter, Together, or a local Ollama model with tool support can be configured.

## Run locally

1. If `server/.env` does not exist, copy `server/.env.example` to `server/.env`. Otherwise, add or change only the needed variables in your existing file; do not overwrite existing credentials. Leave model credentials unset to use local catalog matching and browse the approval flow up to the PayPal configuration check.
2. In one terminal:

   ```powershell
   cd server
   npm install
   npm run dev
   ```

3. In another terminal:

   ```powershell
   cd client
   npm install
   npm run dev
   ```

4. Open the Vite URL shown in the client terminal (normally `http://localhost:5173`).

The template selects Groq's OpenAI-compatible endpoint and `openai/gpt-oss-20b` as a tool-calling model. Create a key at [Groq Console API Keys](https://console.groq.com/keys), paste it into `LLM_API_KEY` in `server/.env`, and restart the backend. Groq documents OpenAI-compatible Chat Completions and function calling; its free-tier limits and model availability may change, so check the current [model list](https://console.groq.com/docs/models) and [rate limits](https://console.groq.com/docs/rate-limits). Until a hosted provider key is set, AgentGuard identifies itself as using local catalog matching. OpenAI legacy variables (`OPENAI_API_KEY` / `OPENAI_MODEL`) and other compatible providers are also supported. Configure PayPal Sandbox credentials to enable checkout. Never put provider secrets in browser variables or commit `.env` files.

## Tests and production build

```powershell
cd server
npm test
npm run build
```

```powershell
cd client
npm run build
```

The payment tests use an injected fake provider and do not contact PayPal. They verify server-derived prices, policy rejections, approval replay handling, transaction-bound order creation, tamper rejection, single-use capture, and ambiguous-capture handling.

## API outline

- `GET /api/status`, `/api/catalog`, `/api/policy`, `/api/audit`
- `PUT /api/policy`
- `POST /api/agent/propose` — AI/local catalog search only; it cannot authorize or purchase
- `POST /api/authorizations` — explicit user approval of a catalog `productId`, with a client-generated idempotency key; price and merchant are resolved by the server
- `POST /api/authorizations/:id/order` — creates an order only for the saved authorization
- `POST /api/authorizations/:id/capture` — fetches and verifies the PayPal order before attempting capture

Error responses use `{ "error": { "code": "...", "message": "..." } }`.

## Security boundaries and limitations

- Browser and model inputs never determine the saved price, merchant, currency, authorization status, or capture amount.
- Policy checks are deterministic and server-side. The AI tool is deliberately limited to catalog search.
- Approval records expire after ten minutes and cannot be edited. A changed purchase requires a new explicit approval.
- The capture request ID is stable per authorization. If a capture result is ambiguous, the authorization is held in `capture_pending`; a subsequent request checks the remote order for a completed, matching capture and does not automatically reissue capture.
- The demo uses one shared policy and a fixed demo identity. Add real authentication, per-user isolation, deployment secrets, rate limits, stronger operational monitoring, and a reviewed migration strategy before any real use.
- Webhooks and remote event verification are not implemented.

## Deploying on Render

Deploy the API as a **Web Service** and the UI as a **Static Site**:

1. Create the API Web Service from this repository with root directory `server`, build command `npm ci && npm run build`, and start command `npm start`.
2. Attach a persistent disk to the API service and mount it at `/var/data`. Set `DATABASE_PATH=/var/data/agentguard.sqlite`. SQLite data on an ephemeral filesystem will be lost when the service is replaced.
3. Set the API environment variables `FRONTEND_URL` to the deployed Static Site origin and add `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, and either `OPENAI_API_KEY` / `OPENAI_MODEL` or the compatible `LLM_PROVIDER`, `LLM_BASE_URL`, `LLM_API_KEY`, and `LLM_MODEL` settings.
4. Create a Static Site with root directory `client`, build command `npm ci && npm run build`, and publish directory `dist`. Set `VITE_API_URL` to the API origin followed by `/api` (for example, `https://agentguard-api.onrender.com/api`), then redeploy the site.
5. After both URLs are known, verify `FRONTEND_URL` matches the Static Site origin exactly; the API's CORS policy allows only that origin.

Persistent disks require a compatible paid Render service plan and are not available on all free plans. See Render's [Blueprint and service configuration](https://render.com/docs/blueprint-spec) and [persistent disk documentation](https://render.com/docs/disks). This deployment is a demo configuration, not production hardening.

## PayPal documentation

- [Orders v2 API reference](https://developer.paypal.com/api/orders/v2/)
- [PayPal REST authentication](https://developer.paypal.com/api/rest/authentication/)

## License

MIT — see [LICENSE](./LICENSE).
