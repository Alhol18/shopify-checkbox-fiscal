import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deliver, deliverSkippingWaits, expectedReceiptId, makeEnv, mockFetch, order, sign,
} from "./helpers.js";

test("GET / answers without touching the cash register", async (t) => {
  const calls = mockFetch(t);
  const res = await deliver("", makeEnv(), { method: "GET" });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 0);
});

test("a webhook with a wrong signature is rejected before anything else", async (t) => {
  const calls = mockFetch(t);
  const env = makeEnv();
  const res = await deliver(order(), env, { hmac: "bm90LXRoZS1zaWduYXR1cmU=" });
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0);
  assert.equal(env.PROCESSED.store.size, 0);
});

test("a webhook without a signature header is rejected", async (t) => {
  const calls = mockFetch(t);
  const res = await deliver(order(), makeEnv(), { hmac: null });
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0);
});

test("a body changed after signing is rejected", async (t) => {
  const calls = mockFetch(t);
  const signed = JSON.stringify(order());
  const tampered = JSON.stringify(order({ total_price: "1.00" }));
  const res = await deliver(tampered, makeEnv(), { hmac: sign(signed) });
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0);
});

test("a missing webhook secret fails closed", async (t) => {
  mockFetch(t);
  const res = await deliver(order(), makeEnv({ SHOPIFY_WEBHOOK_SECRET: undefined }));
  assert.equal(res.status, 401);
});

test("test orders are skipped", async (t) => {
  const calls = mockFetch(t);
  const res = await deliver(order({ test: true }), makeEnv());
  assert.equal(res.status, 200);
  assert.match(res.text, /skip: test order/);
  assert.equal(calls.length, 0);
});

test("orders that are not fully paid are skipped", async (t) => {
  const calls = mockFetch(t);
  const res = await deliver(order({ financial_status: "pending" }), makeEnv());
  assert.equal(res.status, 200);
  assert.match(res.text, /financial_status=pending/);
  assert.equal(calls.length, 0);
});

test("a paid order gets one receipt and is remembered in KV", async (t) => {
  const calls = mockFetch(t);
  const env = makeEnv();
  const o = order();

  const res = await deliver(o, env);

  assert.equal(res.status, 200);
  assert.equal(res.text, `fiscalized: ${expectedReceiptId(o.id)} (discount)`);
  assert.deepEqual(calls.map((c) => c.route), ["signin", "shift", "sell"]);

  const saved = env.PROCESSED.json(String(o.id));
  assert.equal(saved.receipt_id, expectedReceiptId(o.id));
  assert.equal(saved.fiscal_code, "TEST-0001");
  assert.equal(saved.free_line_mode, "discount");
  assert.ok(!Number.isNaN(Date.parse(saved.at)));
});

test("a repeated delivery of the same order issues no second receipt", async (t) => {
  const calls = mockFetch(t);
  const env = makeEnv();

  await deliver(order(), env);
  const again = await deliver(order(), env);

  assert.equal(again.status, 200);
  assert.equal(again.text, "already fiscalized");
  assert.equal(calls.of("sell").length, 1);
});

test("the receipt id is derived from the order id, not random", async (t) => {
  const calls = mockFetch(t);

  // Two deliveries into empty KV: the worst case, where idempotency storage
  // was lost. The register still sees the same receipt id twice.
  await deliver(order({ id: 7001 }), makeEnv());
  await deliver(order({ id: 7001 }), makeEnv());
  await deliver(order({ id: 7002 }), makeEnv());

  const ids = calls.of("sell").map((c) => c.body.id);
  assert.equal(ids[0], expectedReceiptId(7001));
  assert.equal(ids[1], ids[0]);
  assert.notEqual(ids[2], ids[0]);
  assert.match(ids[0], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("the Shopify order id is never sent as CheckBox order_id", async (t) => {
  const calls = mockFetch(t);
  await deliver(order(), makeEnv());
  assert.ok(!("order_id" in calls.of("sell")[0].body));
});

test("every CheckBox call carries the headers the API insists on", async (t) => {
  const calls = mockFetch(t);
  await deliver(order(), makeEnv());

  for (const call of calls) {
    assert.match(call.headers["User-Agent"], /^Mozilla\/5\.0/, call.path);
    assert.equal(call.headers["X-License-Key"], "license-key", call.path);
  }
  assert.equal(calls.of("signin")[0].headers.Authorization, undefined);
  assert.deepEqual(calls.of("signin")[0].body, { pin_code: "1234" });
  assert.equal(calls.of("sell")[0].headers.Authorization, "Bearer cashier-token");
});

test("a closed shift is opened and awaited before selling", async (t) => {
  const calls = mockFetch(t, {
    // No open shift → 404, then still opening, then ready.
    shift: (_call, n) => {
      if (n === 1) return [404, { message: "Shift not found" }];
      if (n === 2) return [200, { status: "CREATED" }];
      return [200, { status: "OPENED" }];
    },
  });

  const res = await deliverSkippingWaits(t, order(), makeEnv());

  assert.equal(res.status, 200);
  assert.deepEqual(calls.map((c) => c.route),
    ["signin", "shift", "openShift", "shift", "shift", "sell"]);
});

test("an open shift is not opened again", async (t) => {
  const calls = mockFetch(t);
  await deliver(order(), makeEnv());
  assert.equal(calls.of("openShift").length, 0);
});

test("a shift that never opens fails the delivery so Shopify retries", async (t) => {
  const calls = mockFetch(t, { shift: () => [404, { message: "Shift not found" }] });
  const env = makeEnv();

  const res = await deliverSkippingWaits(t, order(), env);

  assert.equal(res.status, 500);
  assert.match(res.text, /shift did not open in time/);
  assert.equal(calls.of("sell").length, 0);
  assert.equal(env.PROCESSED.json("5550001"), null);
});

test("a shift check that fails for another reason is not read as 'closed'", async (t) => {
  const calls = mockFetch(t, { shift: () => [500, { message: "Internal error" }] });
  const res = await deliver(order(), makeEnv());
  assert.equal(res.status, 500);
  assert.equal(calls.of("openShift").length, 0);
});

test("a register failure returns 500, records the reason and keeps the order retryable", async (t) => {
  const calls = mockFetch(t, { sell: () => [500, { message: "Internal error" }] });
  const env = makeEnv();
  const o = order();

  const res = await deliver(o, env);

  assert.equal(res.status, 500);
  assert.match(res.text, /\/receipts\/sell → 500: Internal error/);
  // Not a problem with the receipt body: no point trying other shapes.
  assert.equal(calls.of("sell").length, 1);

  const failure = env.PROCESSED.json(`err:${o.id}`);
  assert.match(failure.error, /→ 500/);
  assert.equal(failure.receipt.payments[0].value, 159000);
  // The idempotency key stays free, so the retry can still succeed.
  assert.equal(env.PROCESSED.json(String(o.id)), null);
});

test("the order goes through on a later retry once the register recovers", async (t) => {
  let down = true;
  const calls = mockFetch(t, {
    sell: (call) => (down ? [503, "upstream unavailable"] : [200, { id: call.body.id }]),
  });
  const env = makeEnv();

  assert.equal((await deliver(order(), env)).status, 500);
  down = false;
  const res = await deliver(order(), env);

  assert.equal(res.status, 200);
  assert.equal(calls.of("sell")[1].body.id, calls.of("sell")[0].body.id);
  assert.equal(env.PROCESSED.json("5550001").fiscal_code, null);
});

test("a receipt created before the connection dropped is reused, not issued twice", async (t) => {
  const calls = mockFetch(t, {
    sell: () => { throw new TypeError("network connection lost"); },
    receipt: (call) => [200, { id: call.path.split("/").pop(), fiscal_code: "TEST-0042" }],
  });
  const env = makeEnv();
  const o = order();

  const res = await deliver(o, env);

  assert.equal(res.status, 200);
  assert.equal(res.text, `fiscalized: ${expectedReceiptId(o.id)} (discount:recovered)`);
  assert.equal(calls.of("sell").length, 1);
  assert.equal(calls.of("receipt")[0].path, `/receipts/${expectedReceiptId(o.id)}`);
  assert.equal(env.PROCESSED.json(String(o.id)).fiscal_code, "TEST-0042");
});

test("a rejected cashier sign-in stops before any fiscal call", async (t) => {
  const calls = mockFetch(t, { signin: () => [401, { message: "Invalid pin" }] });
  const res = await deliver(order(), makeEnv());
  assert.equal(res.status, 500);
  assert.match(res.text, /signinPinCode → 401: Invalid pin/);
  assert.deepEqual(calls.map((c) => c.route), ["signin"]);
});

test("a WAF block (plain text, not JSON) surfaces in the error as is", async (t) => {
  mockFetch(t, { signin: () => [403, "error code: 1010"] });
  const res = await deliver(order(), makeEnv());
  assert.equal(res.status, 500);
  assert.match(res.text, /→ 403: error code: 1010/);
});

test("validation details from the register end up in the stored error", async (t) => {
  mockFetch(t, {
    sell: () => [422, { message: "Validation error", detail: [{ loc: ["goods", 0, "good", "price"] }] }],
  });
  const env = makeEnv();
  await deliver(order(), env);
  assert.match(env.PROCESSED.json("err:5550001").error, /"price"/);
});
