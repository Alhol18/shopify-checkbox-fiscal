// Test harness: the Worker is driven through its real entry point. Nothing is
// imported from src/ except the default export, so the tests exercise exactly
// what Shopify and CheckBox would.

import { createHash, createHmac } from "node:crypto";
import worker from "../src/index.js";

export const SECRET = "test-webhook-secret";

export const sha256hex = (s) => createHash("sha256").update(s).digest("hex");

// Shopify signs the raw body. Computed with node:crypto on purpose: the Worker
// uses WebCrypto, so a shared bug cannot make both sides agree.
export const sign = (body, secret = SECRET) =>
  createHmac("sha256", secret).update(body).digest("base64");

// Same derivation the Worker documents: SHA-256 of "shopify-order-<id>",
// first 16 bytes, v4 version and variant bits.
export function expectedReceiptId(orderId) {
  const b = createHash("sha256").update(`shopify-order-${orderId}`).digest().subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function order(overrides = {}) {
  return {
    id: 5550001,
    order_number: 1042,
    test: false,
    financial_status: "paid",
    currency: "UAH",
    total_price: "1590.00",
    email: "buyer@example.com",
    created_at: "2026-08-13T10:00:00Z",
    line_items: [
      { id: 11, variant_id: 101, sku: "KIT-01", title: "Movement kit", price: "1590.00", quantity: 1 },
    ],
    shipping_lines: [],
    ...overrides,
  };
}

export function fakeKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { store.set(key, value); },
    json(key) { return store.has(key) ? JSON.parse(store.get(key)) : null; },
  };
}

export function makeEnv(overrides = {}) {
  return {
    SHOPIFY_WEBHOOK_SECRET: SECRET,
    CHECKBOX_LICENSE_KEY: "license-key",
    CHECKBOX_CASHIER_PIN: "1234",
    PROCESSED: fakeKV(),
    ...overrides,
  };
}

const ok = (body) => [200, body];
const notFound = () => [404, { message: "Not found" }];

// A cash register that is signed in, has an open shift and accepts every
// receipt. Each handler gets the recorded call and returns [status, body];
// a string body is sent as-is (the WAF answers in plain text, not JSON).
const DEFAULT_ROUTES = {
  signin: () => ok({ access_token: "cashier-token" }),
  shift: () => ok({ status: "OPENED" }),
  openShift: () => ok({ status: "CREATED" }),
  sell: (call) => ok({ id: call.body.id, fiscal_code: "TEST-0001" }),
  receipt: notFound,
  info: () => ok({ fiscal_number: "4000000001", shift: null }),
  signature: () => ok({ online: true }),
  ga4: () => [204, ""],
  meta: () => ok({ events_received: 1 }),
};

function routeOf(method, host, path) {
  if (host === "www.google-analytics.com") return "ga4";
  if (host === "graph.facebook.com") return "meta";
  if (host !== "api.checkbox.ua") return null;
  if (method === "POST" && path === "/cashier/signinPinCode") return "signin";
  if (method === "GET" && path === "/cashier/shift") return "shift";
  if (method === "POST" && path === "/shifts") return "openShift";
  if (method === "POST" && path === "/receipts/sell") return "sell";
  if (method === "GET" && path.startsWith("/receipts/")) return "receipt";
  if (method === "GET" && path === "/cash-registers/info") return "info";
  if (method === "GET" && path === "/cashier/check-signature") return "signature";
  return null;
}

// Replaces global fetch with the fake register. Returns the list of calls the
// Worker made, plus `of(route)` to pick the ones for a single endpoint.
export function mockFetch(t, overrides = {}) {
  const routes = { ...DEFAULT_ROUTES, ...overrides };
  const calls = [];
  calls.of = (route) => calls.filter((c) => c.route === route);

  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || "GET";
    const path = u.pathname.replace(/^\/api\/v1/, "");
    const route = routeOf(method, u.host, path);
    const call = {
      route, method, path, url: u,
      headers: init.headers || {},
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    if (!route) throw new Error(`unexpected request: ${method} ${url}`);
    const [status, body] = await routes[route](call, calls.of(route).length);
    return new Response(typeof body === "string" ? (body || null) : JSON.stringify(body), { status });
  });

  // The Worker logs every step; keep the test report readable.
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", () => {});
  return calls;
}

// Delivers a webhook the way Shopify does and waits for background work
// (ctx.waitUntil) to settle, so KV can be asserted right after.
export async function deliver(payload, env, { hmac, method = "POST", path = "/" } = {}) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const headers = { "Content-Type": "application/json" };
  const signature = hmac === undefined ? sign(body) : hmac;
  if (signature !== null) headers["X-Shopify-Hmac-Sha256"] = signature;

  const background = [];
  const ctx = { waitUntil: (p) => background.push(p) };
  const request = new Request(`https://worker.test${path}`, {
    method, headers, body: method === "POST" ? body : undefined,
  });
  const response = await worker.fetch(request, env, ctx);
  await Promise.all(background);
  return { status: response.status, text: await response.text() };
}

// waitShiftOpened sleeps 1.5 s between polls. Run the delivery on mocked
// timers so shift tests take milliseconds instead of up to 15 seconds.
export async function deliverSkippingWaits(t, payload, env) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let settled = false;
  const pending = deliver(payload, env).finally(() => { settled = true; });
  while (!settled) {
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(1500);
  }
  t.mock.timers.reset();
  return pending;
}

// What the receipt adds up to, in kopecks: price × quantity (thousandths),
// minus lines carrying a 100 % discount.
export function receiptTotal(receipt) {
  return receipt.goods.reduce((sum, g) => {
    const gift = (g.discounts || []).some((d) => d.mode === "PERCENT" && d.value === 100);
    return gift ? sum : sum + (g.good.price * g.quantity) / 1000;
  }, 0);
}
