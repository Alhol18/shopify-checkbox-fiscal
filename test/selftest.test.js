import { test } from "node:test";
import assert from "node:assert/strict";
import { deliver, makeEnv, mockFetch } from "./helpers.js";

const selftest = (env) => deliver("", env, { method: "GET", path: "/selftest" });

test("/selftest reports the register, the signature key and the shift", async (t) => {
  mockFetch(t);
  const res = await selftest(makeEnv());
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.text), {
    ok: true,
    fiscal_number: "4000000001",
    shift: "OPENED",
    signature: { online: true },
  });
});

test("/selftest is read-only: it signs in and issues no fiscal document", async (t) => {
  const calls = mockFetch(t);
  const env = makeEnv();
  await selftest(env);

  assert.deepEqual(calls.filter((c) => c.method === "POST").map((c) => c.route), ["signin"]);
  assert.equal(calls.of("sell").length + calls.of("openShift").length, 0);
  assert.equal(env.PROCESSED.store.size, 0);
});

test("/selftest reads the shift from the cashier, where a closed one shows as null", async (t) => {
  mockFetch(t, { shift: () => [404, { message: "Shift not found" }] });
  const body = JSON.parse((await selftest(makeEnv())).text);
  assert.equal(body.ok, true);
  assert.equal(body.shift, null);
});

test("/selftest turns a register failure into a readable 500", async (t) => {
  mockFetch(t, { signin: () => [403, "error code: 1010"] });
  const res = await selftest(makeEnv());
  assert.equal(res.status, 500);
  const body = JSON.parse(res.text);
  assert.equal(body.ok, false);
  assert.match(body.error, /signinPinCode → 403: error code: 1010/);
});
