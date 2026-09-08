/**
 * Фіскалізація Shopify-замовлень через CheckBox ПРРО.
 *
 * Потік: Shopify webhook orders/paid → цей Worker → CheckBox API (чек)
 *        → CheckBox сам шле фіскальний чек на email покупця.
 *
 * Ідемпотентність: KV PROCESSED зберігає order_id → чек не дублюється
 * при повторній доставці webhook.
 *
 * Секрети (wrangler secret put):
 *   SHOPIFY_WEBHOOK_SECRET — підпис webhook (Shopify Admin → Notifications → Webhooks)
 *   CHECKBOX_LICENSE_KEY   — ключ ліцензії каси
 *   CHECKBOX_CASHIER_PIN   — пін-код касира
 */

const CHECKBOX_BASE = "https://api.checkbox.ua/api/v1";

// WAF CheckBox пропускає тільки браузерний User-Agent (див. cbFetch).
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export default {
  async fetch(request, env, ctx) {
    // Самоперевірка зв'язку з CheckBox. ТІЛЬКИ читання: signin + стан каси
    // + стан ключа підпису. Жодного POST, жодного фіскального документа.
    if (request.method === "GET" && new URL(request.url).pathname === "/selftest") {
      const license = env.CHECKBOX_LICENSE_KEY;
      try {
        const auth = await cbFetch("/cashier/signinPinCode", {
          method: "POST", license, body: { pin_code: env.CHECKBOX_CASHIER_PIN },
        });
        const token = auth.access_token;
        const [info, sig, shift] = await Promise.all([
          cbFetch("/cash-registers/info", { token, license }),
          cbFetch("/cashier/check-signature", { token, license }),
          currentShiftStatus(token, license),
        ]);
        return Response.json({
          ok: true,
          fiscal_number: info.fiscal_number,
          shift,
          signature: sig,
        });
      } catch (e) {
        return Response.json({ ok: false, error: e.message }, { status: 500 });
      }
    }

    if (request.method !== "POST") {
      return new Response("checkbox-fiscal: ok", { status: 200 });
    }

    const rawBody = await request.text();

    // 1. Перевірка підпису Shopify (HMAC-SHA256, base64)
    const hmacHeader = request.headers.get("X-Shopify-Hmac-Sha256") || "";
    if (!(await verifyShopifyHmac(rawBody, hmacHeader, env.SHOPIFY_WEBHOOK_SECRET))) {
      return new Response("invalid hmac", { status: 401 });
    }

    const order = JSON.parse(rawBody);
    const orderId = String(order.id);

    // 2. Ідемпотентність
    if (await env.PROCESSED.get(orderId)) {
      return new Response("already fiscalized", { status: 200 });
    }

    // 3. Тестові замовлення (Bogus gateway, "Send test notification") не фіскалізуємо
    if (order.test === true) {
      return new Response("skip: test order", { status: 200 });
    }

    // 4. Тільки повністю оплачені замовлення
    if (order.financial_status !== "paid") {
      return new Response(`skip: financial_status=${order.financial_status}`, { status: 200 });
    }

    // 5. Аналітика. Свідомо ДО фіскалізації і в окремому ключі KV.
    // Причина: поки ключ касира прострочений, fiscalize() кидає на кожному
    // замовленні. Якби трекінг стояв після нього, він не спрацював би жодного
    // разу. Своя ідемпотентність, бо Shopify ретраїть 500 до 19 разів —
    // без окремого ключа кожен ретрай слав би дубль покупки.
    if (!(await env.PROCESSED.get(`track:${orderId}`))) {
      ctx.waitUntil(track(order, env).then((result) => {
        if (result.ga4 || result.meta) {
          return env.PROCESSED.put(`track:${orderId}`, JSON.stringify({
            ...result, at: new Date().toISOString(),
          }));
        }
      }));
    }

    try {
      const { receipt, mode } = await fiscalize(order, env);
      await env.PROCESSED.put(orderId, JSON.stringify({
        receipt_id: receipt.id,
        fiscal_code: receipt.fiscal_code || null,
        free_line_mode: mode,
        at: new Date().toISOString(),
      }));
      return new Response(`fiscalized: ${receipt.id} (${mode})`, { status: 200 });
    } catch (e) {
      // 500 → Shopify ретраїть webhook сам (до 19 разів / 48 год)
      console.error(`fiscalization failed order=${orderId}: ${e.message}`);
      // Логи Worker'а читаються тільки живим tail — заднім числом помилка
      // фіскалізації нечитна. Кладемо її в KV окремим ключем (не блокує
      // ідемпотентність: ключ orderId лишається вільним під успішний чек).
      // Без expirationTtl: помилка, яка сама зникає через тиждень, це помилка,
      // якої ніхто не побачить. Три чеки з подарунком загубились саме так.
      // buildReceipt сам може кинути (unbalanced) — тоді запис помилки впав би
      // разом із нею і причина зникла б зовсім.
      let attempted = null;
      try { attempted = buildReceipt(order, "discount"); } catch (be) { attempted = be.message; }
      ctx.waitUntil(env.PROCESSED.put(`err:${orderId}`, JSON.stringify({
        error: e.message,
        receipt: attempted,
        at: new Date().toISOString(),
      })));
      return new Response(`fiscalization failed: ${e.message}`, { status: 500 });
    }
  },
};

// ===== Shopify HMAC =====
async function verifyShopifyHmac(body, hmacHeader, secret) {
  if (!secret || !hmacHeader) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const digest = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return timingSafeEqual(digest, hmacHeader);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

// ===== Аналітика: GA4 Measurement Protocol + Meta CAPI =====
// Чекаут живе на домені Chekly, браузерні події purchase туди не долітають.
// Ідентифікатори візиту приїжджають у note_attributes — їх кладе
// сніпет у темі магазину, ще до переходу на сторонній чекаут.

// Chekly затирає атрибути кошика Shopify своїми, тому власний місток у темі
// не доїжджає. Але Chekly сам збирає ідентифікатори і складає їх в ОДИН
// атрибут "UTM" у форматі "ключ: значення; ключ: значення".
// Звірено на 30 замовленнях: _fbp у 28, _fbc/fbclid у 13, utm_* у 5.
// Чого там НЕМА — кукі _ga, тому GA4 клеїти сесію поки нічим (див. README).
function bridgeAttrs(order) {
  const out = {};
  for (const a of order.note_attributes || []) {
    if (a.name !== "UTM") { out[a.name] = a.value; continue; }
    for (const part of String(a.value || "").split(";")) {
      const i = part.indexOf(":");
      if (i === -1) continue;
      const k = part.slice(0, i).trim();
      const v = part.slice(i + 1).trim();
      if (k && v) out[k] = v;
    }
  }
  // Meta приймає fbc у вигляді fb.1.<час>.<fbclid>. Chekly інколи віддає
  // голий fbclid — добудовуємо самі, інакше втрачаємо привʼязку до креативу.
  if (!out._fbc && out.fbclid) {
    const ts = Math.floor(new Date(order.created_at || Date.now()).getTime());
    out._fbc = `fb.1.${ts}.${out.fbclid}`;
  }
  return out;
}

async function sha256(value) {
  if (!value) return null;
  const data = new TextEncoder().encode(String(value).trim().toLowerCase());
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sendGa4(order, attrs, env) {
  if (!env.GA4_MEASUREMENT_ID || !env.GA4_MP_API_SECRET) return false;

  // Без client_id GA4 подію не прийме. Фолбек рахує виручку, але не покаже
  // джерело — це буває, коли людина вимкнула кукі або прийшла в приватному вікні.
  const clientId = attrs._ga_client_id || `${order.id}.${Math.floor(Date.now() / 1000)}`;

  const params = {
    transaction_id: String(order.order_number || order.id),
    value: parseFloat(order.total_price || "0"),
    currency: order.currency || "UAH",
    shipping: parseFloat(order.total_shipping_price_set?.shop_money?.amount || "0"),
    tax: parseFloat(order.total_tax || "0"),
    engagement_time_msec: 1,
    items: (order.line_items || []).map((li) => ({
      item_id: String(li.sku || li.variant_id),
      item_name: li.title,
      price: parseFloat(li.price || "0"),
      quantity: li.quantity || 1,
    })),
  };
  if (attrs._ga_session_id) params.session_id = attrs._ga_session_id;
  const coupon = (order.discount_codes || [])[0];
  if (coupon) params.coupon = coupon.code;

  // Chekly віддає utm-мітки, з якими людина зайшла. Без client_id сесію не
  // склеїти, але канал GA4 хоча б покаже правильно, а не як "(direct)".
  if (attrs.utm_source) params.source = attrs.utm_source;
  if (attrs.utm_medium) params.medium = attrs.utm_medium;
  if (attrs.utm_campaign) params.campaign = attrs.utm_campaign;
  if (attrs.utm_content) params.content = attrs.utm_content;

  const url = `https://www.google-analytics.com/mp/collect`
    + `?measurement_id=${encodeURIComponent(env.GA4_MEASUREMENT_ID)}`
    + `&api_secret=${encodeURIComponent(env.GA4_MP_API_SECRET)}`;

  const resp = await fetch(url, {
    method: "POST",
    body: JSON.stringify({ client_id: clientId, events: [{ name: "purchase", params }] }),
  });
  // MP віддає 204 і мовчить про помилки валідації — це нормально, не баг.
  return resp.status === 204 || resp.ok;
}

async function sendMeta(order, attrs, env) {
  if (!env.META_PIXEL_ID || !env.META_CAPI_TOKEN) return false;

  const phone = order.phone || order.shipping_address?.phone || order.customer?.phone;
  const userData = {
    em: [await sha256(order.email || order.customer?.email)].filter(Boolean),
    ph: [await sha256((phone || "").replace(/\D/g, ""))].filter(Boolean),
  };
  // fbc несе fbclid з кліку по рекламі — саме по ньому Meta знаходить креатив.
  if (attrs._fbc) userData.fbc = attrs._fbc;
  if (attrs._fbp) userData.fbp = attrs._fbp;
  if (order.browser_ip) userData.client_ip_address = order.browser_ip;
  if (order.client_details?.user_agent) userData.client_user_agent = order.client_details.user_agent;

  const body = {
    data: [{
      event_name: "Purchase",
      event_time: Math.floor(new Date(order.created_at || Date.now()).getTime() / 1000),
      event_id: String(order.id),          // дедуплікація, якщо колись додамо піксель
      action_source: "website",
      event_source_url: `https://${env.STORE_DOMAIN || "example.com"}/`,
      user_data: userData,
      custom_data: {
        currency: order.currency || "UAH",
        value: parseFloat(order.total_price || "0"),
        content_type: "product",
        contents: (order.line_items || []).map((li) => ({
          id: String(li.sku || li.variant_id),
          quantity: li.quantity || 1,
          item_price: parseFloat(li.price || "0"),
        })),
      },
    }],
  };

  const resp = await fetch(
    `https://graph.facebook.com/v21.0/${env.META_PIXEL_ID}/events?access_token=${encodeURIComponent(env.META_CAPI_TOKEN)}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );
  return resp.ok;
}

async function track(order, env) {
  const attrs = bridgeAttrs(order);
  // Падіння аналітики ніколи не має чіпати чек. Тому кожен канал у своєму catch.
  const [ga4, meta] = await Promise.all([
    sendGa4(order, attrs, env).catch(() => false),
    sendMeta(order, attrs, env).catch(() => false),
  ]);
  return { ga4, meta, had_ga_client: Boolean(attrs._ga_client_id), had_fbc: Boolean(attrs._fbc) };
}

// ===== CheckBox =====
async function cbFetch(path, { method = "GET", token, license, body } = {}) {
  const headers = {
    "Content-Type": "application/json",
    "X-Client-Name": "shopify-checkbox-fiscal",
    "X-Client-Version": "1.0",
    // ОБОВ'ЯЗКОВО. CheckBox стоїть за Cloudflare і віддає 403 "error code: 1010"
    // на запит без браузерного User-Agent. Workers своїм fetch UA не шлють,
    // тому без цього рядка падав ще signin — до чека справа не доходила.
    "User-Agent": UA,
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (license) headers["X-License-Key"] = license;
  const resp = await fetch(CHECKBOX_BASE + path, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const raw = await resp.text();
  let data = {};
  try { data = JSON.parse(raw); } catch { /* HTML від WAF, не JSON */ }
  if (!resp.ok) {
    // detail несе, ЩО саме не пройшло валідацію. Без нього 422 читається як
    // «Помилка валідації» і не каже нічого.
    const detail = data.detail ? ` ${JSON.stringify(data.detail).slice(0, 400)}` : "";
    throw new Error(`CheckBox ${path} → ${resp.status}: ${data.message || raw.slice(0, 200)}${detail}`);
  }
  return data;
}

async function fiscalize(order, env) {
  const license = env.CHECKBOX_LICENSE_KEY;

  // 1. Логін касира
  const auth = await cbFetch("/cashier/signinPinCode", {
    method: "POST", license, body: { pin_code: env.CHECKBOX_CASHIER_PIN },
  });
  const token = auth.access_token;
  console.log("cb: signin ok");

  // 2. Зміна: відкрити якщо закрита.
  // Стан зміни беремо з /cashier/shift, а НЕ з /cash-registers/info: у цієї
  // каси info.shift завжди null, навіть коли зміна відкрита (звірено
  // 2026-08-13 — обидва ендпоінти поруч). Через це кожен вебхук відкривав
  // нову зміну, ловив таймаут очікування і падав у 500.
  const shiftStatus = await currentShiftStatus(token, license);
  console.log(`cb: shift status=${shiftStatus}`);
  if (shiftStatus !== "OPENED") {
    await cbFetch("/shifts", { method: "POST", token, license, body: {} });
    await waitShiftOpened(token, license);
    console.log("cb: shift opened");
  }

  // 3. Чек
  return sell(order, token, license);
}

// Позиція, віддана безкоштовно (автознижка 100% на подарунок від суми),
// приходить із Shopify як price 490 + discount_allocations 490. CheckBox не
// приймає price = 0 — у схемі GoodDetailsPayload стоїть exclusiveMinimum 0,
// і чек падає в 422. Через це не проходило жодне замовлення з подарунком,
// поки решта фіскалізувалась нормально.
//
// Три способи показати таку позицію, від найчеснішого до найгрубішого:
//   discount — реальна ціна + знижка 100% (чек показує подарунок як подарунок)
//   kopeck   — 1 копійка за одиницю (копійка віднімається з платної позиції)
//   drop     — позиції в чеку нема взагалі
// Чи приймає каса позицію з нульовою сумою — не звірено: тестового
// середовища CheckBox у нас нема. Тому не одна ставка, а ланцюжок: перший
// режим, що пройшов, і є відповідь. Він лягає в KV полем free_line_mode.
const FREE_LINE_MODES = ["discount", "kopeck", "drop"];

async function sell(order, token, license) {
  const modes = hasFreeLine(order) ? FREE_LINE_MODES : ["discount"];
  // UUID чека рахуємо з id замовлення, а не випадковий. Тоді повторна спроба
  // (таймаут, ретрай Shopify, наш власний наступний режим) приходить у касу
  // під тим самим ідентифікатором і другого фіскального чека не виникає.
  const receiptId = await receiptUuid(order.id);
  let lastErr;
  for (const mode of modes) {
    try {
      const receipt = await cbFetch("/receipts/sell", {
        method: "POST", token, license,
        // order_id НЕ передаємо: каса вимагає там uuid, а id замовлення
        // Shopify — число (422 type_error.uuid). Звʼязок із замовленням
        // тримає сам receiptId, який з цього числа й порахований.
        body: { ...buildReceipt(order, mode), id: receiptId },
      });
      return { receipt, mode };
    } catch (e) {
      // Каса могла створити чек і не встигнути відповісти — мережа рветься
      // після запису. Перевіряємо, чи чек під нашим UUID уже існує, перш ніж
      // пробувати ще раз: інакше на одне замовлення вийшло б два чеки.
      const existing = await cbFetch(`/receipts/${receiptId}`, { token, license })
        .catch(() => null);
      if (existing && existing.id) {
        console.log(`cb: receipt ${receiptId} already exists, reusing`);
        return { receipt: existing, mode: `${mode}:recovered` };
      }
      // 422 = каса не прийняла саме тіло чека; unbalanced = ми самі не змогли
      // зібрати це тіло. В обох випадках є сенс пробувати наступний режим.
      // Будь-що інше (401, 403, 5xx) — не про форму чека, далі не йдемо.
      const retryable = e.message.includes("\u2192 422")
        || e.message.startsWith("unbalanced receipt");
      if (!retryable) throw e;
      console.error(`cb: mode=${mode} rejected: ${e.message}`);
      lastErr = e;
    }
  }
  throw lastErr;
}

// UUID v4-формату, детермінований від id замовлення: те саме замовлення
// завжди дає той самий ідентифікатор чека.
// Змінюй сіль лише до першого бойового чека: від неї залежить UUID.
const RECEIPT_SALT = "shopify-order";

async function receiptUuid(orderId) {
  const buf = await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(`${RECEIPT_SALT}-${orderId}`));
  const b = new Uint8Array(buf).slice(0, 16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

function hasFreeLine(order) {
  return (order.line_items || []).some((li) => freeLineInfo(li).isFree);
}

function freeLineInfo(li) {
  const toKop = (s) => Math.round(parseFloat(s || "0") * 100);
  const qty = li.quantity || 1;
  const gross = toKop(li.price) * qty;
  const discount = (li.discount_allocations || []).reduce((s, d) => s + toKop(d.amount), 0);
  const net = gross - discount;
  // net <= 0 — позиція нічого не додає до суми. Це і подарунок зі знижкою
  // 100% (gross 490, discount 490), і товар, який у Shopify від початку
  // коштує 0.00. CheckBox не приймає price = 0 в обох випадках.
  return { qty, gross, discount, net, isFree: net <= 0 };
}

// Зміна на цій касі видна тільки через касира. /cash-registers/info віддає
// shift: null завжди — не використовувати для перевірки стану.
async function currentShiftStatus(token, license) {
  try {
    const shift = await cbFetch("/cashier/shift", { token, license });
    return shift && shift.status;
  } catch (e) {
    // 404 = відкритої зміни нема. Будь-яка інша помилка — вгору.
    if (e.message.includes("→ 404")) return null;
    throw e;
  }
}

async function waitShiftOpened(token, license, tries = 10) {
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    if (await currentShiftStatus(token, license) === "OPENED") return;
  }
  throw new Error("shift did not open in time");
}

// ===== Побудова чека з Shopify order =====
// Суми в копійках; quantity у тисячних (1 шт = 1000).
// Ціни по позиціях беруться зі знижками; останню позицію коригуємо так,
// щоб сума чека 1-в-1 дорівнювала сплаченому total_price (фіскальна вимога).
function buildReceipt(order, mode = "discount") {
  const toKop = (s) => Math.round(parseFloat(s || "0") * 100);
  const totalKop = toKop(order.total_price);

  // net — скільки ця позиція реально додає до суми чека. Тримаємо його
  // окремо від price, бо в режимі discount ціна в чеку більша за net.
  const goods = [];
  for (const li of order.line_items || []) {
    const { qty, gross, net, isFree } = freeLineInfo(li);
    const good = {
      code: String(li.sku || li.variant_id || li.id),
      name: li.title.slice(0, 128),
      price: 0,
    };

    if (isFree) {
      if (mode === "drop") continue;
      // Знижку 100% нема від чого рахувати, якщо ціни не було зовсім
      // (товар у Shopify коштує 0.00) — таку позицію тільки копійкою.
      if (mode === "kopeck" || gross === 0) {
        good.price = 1;
        goods.push({ good, quantity: qty * 1000, net: qty, free: true });
        continue;
      }
      // Ціна як у Shopify, а знижка окремим полем. PERCENT, а не VALUE:
      // відсоток каса рахує від усієї позиції, тож питання «за штуку чи за
      // позицію» не виникає взагалі.
      good.price = toKop(li.price);
      goods.push({
        good,
        quantity: qty * 1000,
        discounts: [{ type: "DISCOUNT", mode: "PERCENT", value: 100, name: "Подарунок" }],
        net: 0,
        free: true,
      });
      continue;
    }

    good.price = Math.round(net / qty);
    goods.push({ good, quantity: qty * 1000, net: good.price * qty });
  }

  // Доставка як окрема позиція (якщо платна)
  const shipKop = (order.shipping_lines || [])
    .reduce((s, l) => s + toKop(l.discounted_price ?? l.price), 0);
  if (shipKop > 0) {
    goods.push({
      good: { code: "SHIPPING", name: "Доставка", price: shipKop },
      quantity: 1000,
      net: shipKop,
    });
  }

  // Коригування копійок: сума позицій має зійтись зі сплаченим total.
  // Правимо останню ПЛАТНУ позицію — у безкоштовної ціна або декоративна
  // (знижка 100%), або копійчана, і зсув там зламав би її зміст.
  const sum = goods.reduce((s, g) => s + g.net, 0);
  const diff = totalKop - sum;
  if (diff !== 0) {
    // !g.free — інакше в режимі kopeck зсув на -1 обнулив би копійчану ціну
    // подарунка (price 0 → 422), якби подарунок стояв у замовленні останнім.
    const idx = goods.map((g, i) => [g, i]).filter(([g]) => g.net > 0 && !g.free)
      .map(([, i]) => i).pop();
    const target = idx === undefined ? null : goods[idx];
    const units = target ? target.quantity / 1000 : 0;
    if (target && diff % units === 0) {
      target.good.price += diff / units;
      target.net += diff;
    } else if (target) {
      // Зсув не ділиться націло на кількість (позиція на 2-3 штуки при
      // відсотковій знижці). Відщеплюємо одну штуку окремим рядком і кладемо
      // весь зсув туди — так роблять і звичайні каси, коли копійка не
      // розкладається рівно.
      target.quantity -= 1000;
      target.net -= target.good.price;
      goods.splice(idx + 1, 0, {
        good: { ...target.good, price: target.good.price + diff },
        quantity: 1000,
        net: target.good.price + diff,
      });
    }
  }

  // Каса відхилить чек, у якому сума позицій не дорівнює оплаті, і поверне
  // 500 → ретрай → тиша. Краще впасти тут із читабельною причиною: у режимі
  // kopeck зсув на копійку не завжди ділиться націло на кількість (позиція
  // на 2-3 штуки), і тоді цей режим просто непридатний — sell() візьме
  // наступний.
  const finalSum = goods.reduce((s, g) => s + g.net, 0);
  if (finalSum !== totalKop) {
    throw new Error(`unbalanced receipt: goods ${finalSum} != payment ${totalKop} (mode=${mode})`);
  }

  const receipt = {
    goods: goods.map(({ net, free, ...g }) => g),
    payments: [{ type: "CASHLESS", value: totalKop, label: "Оплата карткою" }],
  };

  const email = order.email || (order.customer && order.customer.email);
  if (email) receipt.delivery = { email };

  return receipt;
}
