import { test } from "node:test";
import assert from "node:assert/strict";
import { deliver, makeEnv, mockFetch, order, sha256hex } from "./helpers.js";

const ANALYTICS = {
  GA4_MEASUREMENT_ID: "G-TEST123",
  GA4_MP_API_SECRET: "ga-secret",
  META_PIXEL_ID: "1234567890",
  META_CAPI_TOKEN: "meta-token",
  STORE_DOMAIN: "shop.example",
};

// The third-party checkout packs visit identifiers into one "UTM" attribute.
const VISIT = [{
  name: "UTM",
  value: "utm_source: instagram; utm_medium: paid; utm_campaign: autumn; fbclid: AbC123; _fbp: fb.1.111.222",
}];

test("without analytics settings nothing is sent anywhere but the register", async (t) => {
  const calls = mockFetch(t);
  const env = makeEnv();
  await deliver(order(), env);
  assert.equal(calls.of("ga4").length + calls.of("meta").length, 0);
  assert.equal(env.PROCESSED.json("track:5550001"), null);
});

test("GA4 gets a purchase with the order, its items and the traffic source", async (t) => {
  const calls = mockFetch(t);
  await deliver(order({
    note_attributes: VISIT,
    total_tax: "0.00",
    discount_codes: [{ code: "TRAINER10" }],
    total_shipping_price_set: { shop_money: { amount: "80.00" } },
  }), makeEnv(ANALYTICS));

  const [call] = calls.of("ga4");
  assert.equal(call.url.searchParams.get("measurement_id"), "G-TEST123");
  assert.equal(call.url.searchParams.get("api_secret"), "ga-secret");

  const [event] = call.body.events;
  assert.equal(event.name, "purchase");
  assert.deepEqual(event.params, {
    transaction_id: "1042",
    value: 1590,
    currency: "UAH",
    shipping: 80,
    tax: 0,
    engagement_time_msec: 1,
    items: [{ item_id: "KIT-01", item_name: "Movement kit", price: 1590, quantity: 1 }],
    coupon: "TRAINER10",
    source: "instagram",
    medium: "paid",
    campaign: "autumn",
  });
  // No GA cookie reaches the Worker: a synthetic client id keeps revenue counted.
  assert.match(call.body.client_id, /^5550001\.\d+$/);
});

test("GA4 uses the visitor's own client and session ids when they arrive", async (t) => {
  const calls = mockFetch(t);
  await deliver(order({
    note_attributes: [
      { name: "_ga_client_id", value: "111.222" },
      { name: "_ga_session_id", value: "1700000000" },
    ],
  }), makeEnv(ANALYTICS));

  const body = calls.of("ga4")[0].body;
  assert.equal(body.client_id, "111.222");
  assert.equal(body.events[0].params.session_id, "1700000000");
});

test("Meta gets a Purchase with hashed contacts and the ad click id", async (t) => {
  const calls = mockFetch(t);
  await deliver(order({
    email: "  Buyer@Example.com ",
    phone: "+38 (050) 123-45-67",
    browser_ip: "203.0.113.7",
    client_details: { user_agent: "TestBrowser/1.0" },
    note_attributes: VISIT,
  }), makeEnv(ANALYTICS));

  const [call] = calls.of("meta");
  assert.equal(call.url.pathname, "/v21.0/1234567890/events");
  assert.equal(call.url.searchParams.get("access_token"), "meta-token");

  const [event] = call.body.data;
  assert.equal(event.event_name, "Purchase");
  assert.equal(event.event_id, "5550001");
  assert.equal(event.event_time, Date.parse("2026-08-13T10:00:00Z") / 1000);
  assert.equal(event.event_source_url, "https://shop.example/");
  assert.deepEqual(event.user_data, {
    em: [sha256hex("buyer@example.com")],
    ph: [sha256hex("380501234567")],
    // A bare fbclid is wrapped into the fbc format Meta matches on.
    fbc: `fb.1.${Date.parse("2026-08-13T10:00:00Z")}.AbC123`,
    fbp: "fb.1.111.222",
    client_ip_address: "203.0.113.7",
    client_user_agent: "TestBrowser/1.0",
  });
  assert.deepEqual(event.custom_data, {
    currency: "UAH",
    value: 1590,
    content_type: "product",
    contents: [{ id: "KIT-01", quantity: 1, item_price: 1590 }],
  });
});

test("raw email and phone never leave the Worker towards Meta", async (t) => {
  const calls = mockFetch(t);
  await deliver(order({ phone: "+380501234567" }), makeEnv(ANALYTICS));
  const sent = JSON.stringify(calls.of("meta")[0].body);
  assert.ok(!sent.includes("buyer@example.com"));
  assert.ok(!sent.includes("380501234567"));
});

test("an fbc that is already complete is passed through untouched", async (t) => {
  const calls = mockFetch(t);
  await deliver(order({
    note_attributes: [{ name: "UTM", value: "_fbc: fb.1.999.XyZ; fbclid: AbC123" }],
  }), makeEnv(ANALYTICS));
  assert.equal(calls.of("meta")[0].body.data[0].user_data.fbc, "fb.1.999.XyZ");
});

test("a missing email or phone is left out instead of hashing an empty string", async (t) => {
  const calls = mockFetch(t);
  await deliver(order({ email: null }), makeEnv(ANALYTICS));
  const userData = calls.of("meta")[0].body.data[0].user_data;
  assert.deepEqual(userData.em, []);
  assert.deepEqual(userData.ph, []);
});

test("a sent purchase is remembered so Shopify retries cannot double-count it", async (t) => {
  const calls = mockFetch(t, { sell: () => [500, { message: "Internal error" }] });
  const env = makeEnv(ANALYTICS);

  // The register is down: each delivery ends in 500 and Shopify retries.
  assert.equal((await deliver(order({ note_attributes: VISIT }), env)).status, 500);
  assert.equal((await deliver(order({ note_attributes: VISIT }), env)).status, 500);

  assert.equal(calls.of("ga4").length, 1);
  assert.equal(calls.of("meta").length, 1);
  const tracked = env.PROCESSED.json("track:5550001");
  assert.equal(tracked.ga4, true);
  assert.equal(tracked.meta, true);
  assert.equal(tracked.had_fbc, true);
  assert.equal(tracked.had_ga_client, false);
});

test("the purchase is tracked even when the receipt fails", async (t) => {
  const calls = mockFetch(t, { signin: () => [401, { message: "Invalid pin" }] });
  const res = await deliver(order(), makeEnv(ANALYTICS));
  assert.equal(res.status, 500);
  assert.equal(calls.of("ga4").length, 1);
  assert.equal(calls.of("meta").length, 1);
});

test("an analytics outage never blocks the receipt", async (t) => {
  mockFetch(t, {
    ga4: () => { throw new TypeError("network connection lost"); },
    meta: () => [500, { error: { message: "down" } }],
  });
  const env = makeEnv(ANALYTICS);

  const res = await deliver(order(), env);

  assert.equal(res.status, 200);
  assert.match(res.text, /^fiscalized:/);
  // Nothing got through, so nothing is marked as sent: the next delivery may retry.
  assert.equal(env.PROCESSED.json("track:5550001"), null);
});

test("one channel failing does not stop the other", async (t) => {
  const calls = mockFetch(t, { ga4: () => [500, ""] });
  const env = makeEnv(ANALYTICS);
  await deliver(order(), env);
  assert.equal(calls.of("meta").length, 1);
  assert.deepEqual(
    [env.PROCESSED.json("track:5550001").ga4, env.PROCESSED.json("track:5550001").meta],
    [false, true],
  );
});

test("skipped orders are not tracked", async (t) => {
  const calls = mockFetch(t);
  await deliver(order({ test: true }), makeEnv(ANALYTICS));
  await deliver(order({ financial_status: "pending" }), makeEnv(ANALYTICS));
  assert.equal(calls.length, 0);
});
