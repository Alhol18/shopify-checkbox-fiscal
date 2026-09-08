# shopify-checkbox-fiscal

Cloudflare Worker that fiscalises paid Shopify orders through
[CheckBox](https://checkbox.ua) — the Ukrainian software cash register (ПРРО).
An order gets paid, Shopify fires a webhook, the Worker issues a fiscal receipt
and CheckBox emails it to the customer. No middleware app, no monthly fee per
order, no plugin sitting inside the store.

```
Shopify  ──orders/paid──▶  Worker  ──▶  CheckBox API  ──▶  fiscal receipt → customer
                             │
                             └──▶ KV (order id → receipt)   idempotency
                             └──▶ GA4 Measurement Protocol + Meta CAPI (optional)
```

## Why it exists

Ukrainian online stores must issue a fiscal receipt for every paid order.
The ready-made integrations either charge per receipt, or require an always-on
server, or break silently when a shift is closed. This is ~500 lines with no
dependencies, running on the free Workers tier.

## What it handles

- **HMAC verification** of the Shopify webhook before anything else.
- **Idempotency.** The receipt UUID is derived from the order id
  (SHA-256 → UUID v4 shape), and processed orders are stored in KV. A repeated
  webhook delivery — Shopify retries for 48 hours — cannot produce a second receipt.
- **Shift management.** The cash register refuses to sell when the shift is
  closed, so the Worker checks the shift, opens it, and waits for it to actually
  reach `OPENED` before selling.
- **Test orders** (Bogus gateway, "Send test notification") are skipped.
- **`GET /selftest`** — read-only health check: sign in, cash register state,
  signature key state, current shift. Issues no fiscal document.
- **Analytics, optional.** Server-side `purchase` to GA4 and Meta CAPI from the
  same event, so the conversion survives ad blockers and Safari.

## Gotchas found the hard way

| Symptom | Cause |
|---|---|
| `422 type_error.uuid` | `order_id` in the CheckBox payload must be a UUID. A Shopify order id is a number — pass it in `related_receipt_id` / goods instead. |
| Requests hang or return HTML | The CheckBox WAF drops non-browser user agents. Send a browser `User-Agent`. |
| `403` on every call | The API expects Ukrainian-locale headers; see `cbFetch`. |
| Receipt state says `active` | `active` is not `paid`. Poll the receipt until it is fiscalised. |
| Shift looks open, sale fails | `/cash-registers/info` lags behind. Read `/cashier/shift`. |

## Setup

```bash
npm i -g wrangler
npx wrangler kv namespace create PROCESSED     # put the id in wrangler.toml
npx wrangler secret put SHOPIFY_WEBHOOK_SECRET # Shopify Admin → Notifications → Webhooks
npx wrangler secret put CHECKBOX_LICENSE_KEY
npx wrangler secret put CHECKBOX_CASHIER_PIN
npx wrangler deploy
```

Optional analytics vars: `GA4_MEASUREMENT_ID`, `GA4_MP_API_SECRET`,
`META_PIXEL_ID`, `META_CAPI_TOKEN`, `STORE_DOMAIN`.

Then point a Shopify webhook (`orders/paid`, JSON) at the Worker URL and call
`/selftest` once to confirm the register answers.

Comments in the source are in Ukrainian — that is where the CheckBox API
behaviour is documented, and that is who runs into it.

## License

MIT.
