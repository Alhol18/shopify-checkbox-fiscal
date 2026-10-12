import { test } from "node:test";
import assert from "node:assert/strict";
import { deliver, makeEnv, mockFetch, order, receiptTotal } from "./helpers.js";

// Runs an order through the Worker and returns the receipt body it sent to
// the register.
async function receiptFor(t, o, overrides) {
  const calls = mockFetch(t, overrides);
  const env = makeEnv();
  const res = await deliver(o, env);
  const sells = calls.of("sell");
  return { res, env, sells, receipt: sells.at(-1)?.body };
}

const GIFT = {
  id: 12, variant_id: 102, sku: "GIFT-01", title: "Massage ball", price: "490.00", quantity: 1,
  discount_allocations: [{ amount: "490.00" }],
};
const PAID = { id: 11, variant_id: 101, sku: "KIT-01", title: "Movement kit", price: "1590.00", quantity: 1 };

test("amounts go out in kopecks and quantities in thousandths", async (t) => {
  const { receipt } = await receiptFor(t, order({
    total_price: "1350.00",
    line_items: [
      { id: 1, sku: "A", title: "Band", price: "450.00", quantity: 2 },
      { id: 2, sku: "B", title: "Ball", price: "450.00", quantity: 1 },
    ],
  }));

  assert.deepEqual(receipt.goods, [
    { good: { code: "A", name: "Band", price: 45000 }, quantity: 2000 },
    { good: { code: "B", name: "Ball", price: 45000 }, quantity: 1000 },
  ]);
  assert.deepEqual(receipt.payments, [{ type: "CASHLESS", value: 135000, label: "Оплата карткою" }]);
});

test("internal bookkeeping fields never reach the register", async (t) => {
  const { receipt } = await receiptFor(t, order({ total_price: "1590.00", line_items: [PAID, GIFT] }));
  for (const g of receipt.goods) {
    assert.ok(!("net" in g) && !("free" in g));
  }
});

test("a line discount lowers the unit price", async (t) => {
  const { receipt } = await receiptFor(t, order({
    total_price: "1431.00",
    line_items: [{ ...PAID, discount_allocations: [{ amount: "100.00" }, { amount: "59.00" }] }],
  }));
  assert.equal(receipt.goods[0].good.price, 143100);
  assert.equal(receiptTotal(receipt), 143100);
});

test("a rounding gap that divides evenly is absorbed by the unit price", async (t) => {
  const { receipt } = await receiptFor(t, order({
    total_price: "99.98",
    line_items: [{ id: 1, sku: "A", title: "Band", price: "50.00", quantity: 2 }],
  }));
  assert.deepEqual(receipt.goods, [{ good: { code: "A", name: "Band", price: 4999 }, quantity: 2000 }]);
  assert.equal(receiptTotal(receipt), 9998);
});

test("a gap that does not divide evenly splits one unit into its own line", async (t) => {
  // 3 × 100.00 with 10.00 off: 290.00 / 3 is not a whole number of kopecks.
  const { receipt } = await receiptFor(t, order({
    total_price: "290.00",
    line_items: [{
      id: 1, sku: "A", title: "Band", price: "100.00", quantity: 3,
      discount_allocations: [{ amount: "10.00" }],
    }],
  }));

  assert.deepEqual(receipt.goods, [
    { good: { code: "A", name: "Band", price: 9667 }, quantity: 2000 },
    { good: { code: "A", name: "Band", price: 9666 }, quantity: 1000 },
  ]);
  assert.equal(receiptTotal(receipt), 29000);
  assert.equal(receipt.payments[0].value, 29000);
});

test("paid shipping is its own line", async (t) => {
  const { receipt } = await receiptFor(t, order({
    total_price: "1670.00",
    line_items: [PAID],
    shipping_lines: [{ price: "80.00" }],
  }));
  assert.deepEqual(receipt.goods[1], {
    good: { code: "SHIPPING", name: "Доставка", price: 8000 }, quantity: 1000,
  });
  assert.equal(receiptTotal(receipt), 167000);
});

test("free and fully discounted shipping adds no line", async (t) => {
  const { receipt } = await receiptFor(t, order({
    line_items: [PAID],
    shipping_lines: [{ price: "80.00", discounted_price: "0.00" }],
  }));
  assert.equal(receipt.goods.length, 1);
});

test("the receipt is emailed to the buyer", async (t) => {
  const { receipt } = await receiptFor(t, order());
  assert.deepEqual(receipt.delivery, { email: "buyer@example.com" });
});

test("the customer email is used when the order has none", async (t) => {
  const { receipt } = await receiptFor(t, order({ email: null, customer: { email: "c@example.com" } }));
  assert.deepEqual(receipt.delivery, { email: "c@example.com" });
});

test("no email, no delivery block", async (t) => {
  const { receipt } = await receiptFor(t, order({ email: null }));
  assert.ok(!("delivery" in receipt));
});

test("the product code falls back from SKU to variant id to line id", async (t) => {
  const { receipt } = await receiptFor(t, order({
    total_price: "30.00",
    line_items: [
      { id: 1, variant_id: 101, sku: "SKU-1", title: "a", price: "10.00", quantity: 1 },
      { id: 2, variant_id: 202, sku: "", title: "b", price: "10.00", quantity: 1 },
      { id: 3, variant_id: null, sku: null, title: "c", price: "10.00", quantity: 1 },
    ],
  }));
  assert.deepEqual(receipt.goods.map((g) => g.good.code), ["SKU-1", "202", "3"]);
});

test("long product names are cut to the 128 characters the register accepts", async (t) => {
  const { receipt } = await receiptFor(t, order({ line_items: [{ ...PAID, title: "x".repeat(200) }] }));
  assert.equal(receipt.goods[0].good.name.length, 128);
});

// ----- Free lines: a gift added by an automatic 100 % discount -----
// CheckBox rejects price = 0, so the Worker tries three shapes in order and
// records which one the register accepted.

test("a gift is first sent at its real price with a 100 % discount", async (t) => {
  const { res, env, receipt } = await receiptFor(t, order({ line_items: [PAID, GIFT] }));

  assert.equal(res.status, 200);
  assert.deepEqual(receipt.goods[1], {
    good: { code: "GIFT-01", name: "Massage ball", price: 49000 },
    quantity: 1000,
    discounts: [{ type: "DISCOUNT", mode: "PERCENT", value: 100, name: "Подарунок" }],
  });
  assert.equal(receiptTotal(receipt), 159000);
  assert.equal(env.PROCESSED.json("5550001").free_line_mode, "discount");
});

test("if the register rejects the discount, the gift goes out at one kopeck", async (t) => {
  const { res, env, sells, receipt } = await receiptFor(t, order({ line_items: [PAID, GIFT] }), {
    sell: (call) => (call.body.goods.some((g) => g.discounts)
      ? [422, { message: "Validation error" }]
      : [200, { id: call.body.id }]),
  });

  assert.equal(res.status, 200);
  assert.equal(sells.length, 2);
  assert.equal(sells[1].body.id, sells[0].body.id);

  // The kopeck comes off the paid line, so the total still equals the payment
  // even though the gift is the last line of the order.
  assert.deepEqual(receipt.goods.map((g) => g.good.price), [158999, 1]);
  assert.ok(!receipt.goods.some((g) => g.discounts));
  assert.equal(receiptTotal(receipt), 159000);
  assert.equal(env.PROCESSED.json("5550001").free_line_mode, "kopeck");
});

test("if the kopeck is rejected too, the gift is left off the receipt", async (t) => {
  const { res, env, sells, receipt } = await receiptFor(t, order({ line_items: [PAID, GIFT] }), {
    sell: (call) => (call.body.goods.length > 1
      ? [422, { message: "Validation error" }]
      : [200, { id: call.body.id }]),
  });

  assert.equal(res.status, 200);
  assert.equal(sells.length, 3);
  assert.deepEqual(receipt.goods, [{ good: { code: "KIT-01", name: "Movement kit", price: 159000 }, quantity: 1000 }]);
  assert.equal(env.PROCESSED.json("5550001").free_line_mode, "drop");
});

test("other shapes are tried only when the register rejects the receipt body", async (t) => {
  // 500 says nothing about the gift line: retrying it reshaped would be noise.
  const { res, sells } = await receiptFor(t, order({ line_items: [PAID, GIFT] }), {
    sell: () => [500, { message: "Internal error" }],
  });
  assert.equal(res.status, 500);
  assert.equal(sells.length, 1);
});

test("an order without free lines is tried in one shape only", async (t) => {
  const { res, sells } = await receiptFor(t, order(), {
    sell: () => [422, { message: "Validation error" }],
  });
  assert.equal(res.status, 500);
  assert.equal(sells.length, 1);
});

test("a product that costs 0.00 in the store goes out at one kopeck straight away", async (t) => {
  const { receipt, sells } = await receiptFor(t, order({
    line_items: [PAID, { id: 13, sku: "LEAFLET", title: "Leaflet", price: "0.00", quantity: 1 }],
  }));
  assert.equal(sells.length, 1);
  assert.deepEqual(receipt.goods.map((g) => g.good.price), [158999, 1]);
  assert.equal(receiptTotal(receipt), 159000);
});

test("two gift units at one kopeck each still balance", async (t) => {
  const { receipt } = await receiptFor(t, order({
    line_items: [PAID, { ...GIFT, quantity: 2, discount_allocations: [{ amount: "980.00" }] }],
  }), {
    sell: (call) => (call.body.goods.some((g) => g.discounts)
      ? [422, { message: "Validation error" }]
      : [200, { id: call.body.id }]),
  });
  assert.deepEqual(receipt.goods.map((g) => [g.good.price, g.quantity]), [[158998, 1000], [1, 2000]]);
  assert.equal(receiptTotal(receipt), 159000);
});

test("a receipt that cannot balance is never sent, and the reason is stored", async (t) => {
  // Only a gift, yet money was paid: there is no paid line to carry the gap.
  const { res, env, sells } = await receiptFor(t, order({ total_price: "10.00", line_items: [GIFT] }));

  assert.equal(res.status, 500);
  assert.equal(sells.length, 0);
  assert.match(res.text, /unbalanced receipt: goods 0 != payment 1000 \(mode=drop\)/);
  const failure = env.PROCESSED.json("err:5550001");
  assert.match(failure.receipt, /^unbalanced receipt/);
});
