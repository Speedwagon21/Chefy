// End-to-end API test in demo payments mode, against a throwaway database.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chefy-test-'));
process.env.DATA_DIR = dir;
process.env.ADMIN_EMAILS = 'boss@test.dev';
delete process.env.STRIPE_SECRET_KEY;
const app = require('../server');

let server, base;
before(() => new Promise(r => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); }));
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

// Tiny client that keeps its own session cookie.
function client() {
  let cookie = '';
  return async function call(method, p, body, headers = {}) {
    const res = await fetch(base + p, {
      method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('full order lifecycle with held payment, review, refund and payout', async () => {
  const cook = client(), eater = client(), admin = client(), stranger = client();

  // accounts
  assert.equal((await cook('POST', '/api/auth/signup', { name: 'Maria G', email: 'maria@test.dev', password: 'short' })).status, 400);
  assert.equal((await cook('POST', '/api/auth/signup', { name: 'Maria G', email: 'maria@test.dev', password: 'tamales-2026' })).status, 201);
  assert.equal((await stranger('POST', '/api/auth/signup', { name: 'Dup', email: 'MARIA@test.dev', password: 'whatever-123' })).status, 409);
  assert.equal((await eater('POST', '/api/auth/signup', { name: 'Alex R', email: 'alex@test.dev', password: 'birria-2026' })).status, 201);
  assert.equal((await admin('POST', '/api/auth/signup', { name: 'Boss', email: 'boss@test.dev', password: 'admin-pass-1' })).status, 201);
  assert.equal((await stranger('POST', '/api/auth/signup', { name: 'Sam', email: 'sam@test.dev', password: 'sam-pass-123' })).status, 201);
  assert.equal((await eater('POST', '/api/auth/login', { email: 'alex@test.dev', password: 'wrong-pass' })).status, 401);
  assert.equal((await eater('POST', '/api/auth/login', { email: 'alex@test.dev', password: 'birria-2026' })).status, 200);
  assert.equal((await admin('GET', '/api/me')).body.user.isAdmin, true);

  // CSRF guard: form-encoded posts are refused
  assert.equal((await eater('POST', '/api/orders', 'a=1', { 'Content-Type': 'application/x-www-form-urlencoded' })).status, 415);

  // kitchen setup
  const avatar = await cook('POST', '/api/uploads', { kind: 'image', dataUrl: PNG });
  assert.equal(avatar.status, 201);
  let r = await cook('POST', '/api/chef', { kitchenName: "Abuela's <Kitchen>", pickupAddress: '24th & Folsom', pickupNotes: 'Ring #2', avatarUrl: avatar.body.url });
  assert.equal(r.status, 200);
  assert.equal(r.body.chef.kitchenName, "Abuela's <Kitchen>"); // stored as typed; the app escapes on display
  assert.equal((await cook('POST', '/api/chef', { kitchenName: 'x', avatarUrl: 'javascript:alert(1)' })).status, 400);
  const permitFile = await cook('POST', '/api/uploads', { kind: 'permit', dataUrl: PNG });
  assert.equal((await cook('POST', '/api/chef/permit', { state: 'CA', number: 'CFO-123', expiry: '2020-01-01', file: permitFile.body.file })).status, 400);
  r = await cook('POST', '/api/chef/permit', { state: 'CA', number: 'CFO-123', expiry: '2030-01-01', file: permitFile.body.file });
  assert.equal(r.body.chef.permit.status, 'pending');
  assert.equal((await stranger('GET', `/api/files/${permitFile.body.file}`)).status, 403);
  assert.equal((await cook('POST', '/api/chef/bank', { bank: 'Checking', routing: '123456789', account: '000123456789' })).body.chef.payouts.bankLabel, 'Checking •••• 6789');
  const dish = await cook('POST', '/api/chef/dishes', { title: 'Pork tamales (3)', category: 'Tamales', price: 14.5, description: 'Hand-wrapped', prepTime: '20 min' });
  assert.equal(dish.status, 201);
  assert.equal(dish.body.dish.price, 1450);

  // not visible until the permit is approved
  assert.equal((await eater('GET', '/api/dishes')).body.dishes.length, 0);
  assert.equal((await cook('GET', '/api/admin/queue')).status, 403);
  const q = await admin('GET', '/api/admin/queue');
  assert.equal(q.body.permits.length, 1);
  assert.equal((await admin('POST', `/api/admin/permits/${q.body.permits[0].chefId}`, { decision: 'verified' })).status, 200);
  assert.equal((await eater('GET', '/api/dishes')).body.dishes.length, 1);

  // order: the server prices it, ignoring anything the client sends
  r = await eater('POST', '/api/orders', { items: [{ dishId: dish.body.dish.id, qty: 2, price: 1 }], fulfillment: 'pickup', tipPercent: 15, total: 1 });
  assert.equal(r.status, 201);
  let o = r.body.order;
  assert.equal(o.subtotal, 2900); assert.equal(o.fee, 149); assert.equal(o.tip, 435); assert.equal(o.total, 3484);
  assert.equal(o.chef.pickupAddress, null, 'address hidden until paid');
  assert.equal((await cook('POST', '/api/orders', { items: [{ dishId: dish.body.dish.id, qty: 1 }], fulfillment: 'pickup', tipPercent: 0 })).status, 400, 'no self-orders');
  assert.equal((await eater('POST', '/api/orders', { items: [{ dishId: dish.body.dish.id, qty: 1 }], fulfillment: 'delivery', tipPercent: 0, deliveryAddress: '1 Main St' })).status, 400, 'pickup-only cook');

  r = await eater('POST', `/api/orders/${o.code}/confirm`, { demoCard: { brand: 'Visa', last4: '4242' } });
  o = r.body.order;
  assert.equal(o.status, 'received'); assert.equal(o.payment.status, 'authorized'); assert.equal(o.chef.pickupAddress, '24th & Folsom');
  assert.equal((await stranger('GET', `/api/orders/${o.code}`)).status, 404, 'other users cannot see the order');
  assert.equal((await stranger('POST', `/api/chef/orders/${o.code}/accept`, {})).status, 403);

  // cook flow: accept -> ready (captures) -> complete
  assert.equal((await cook('POST', `/api/chef/orders/${o.code}/ready`, {})).status, 409, 'must accept first');
  assert.equal((await cook('POST', `/api/chef/orders/${o.code}/accept`, {})).body.order.status, 'preparing');
  assert.equal((await eater('POST', `/api/orders/${o.code}/cancel`, {})).status, 409, 'no cancel after accept');
  let sum = (await cook('GET', '/api/chef/summary')).body;
  assert.equal(sum.balance.held, 2900 - 290 + 435);
  r = await cook('POST', `/api/chef/orders/${o.code}/ready`, {});
  assert.equal(r.body.order.payment.status, 'captured');
  assert.equal((await cook('POST', `/api/chef/orders/${o.code}/complete`, {})).body.order.status, 'completed');
  sum = (await cook('GET', '/api/chef/summary')).body;
  assert.equal(sum.balance.available, 3045);
  assert.equal(sum.stats.todayEarned, 3045);

  // review once
  assert.equal((await eater('POST', `/api/orders/${o.code}/review`, { rating: 5, text: 'So good' })).status, 200);
  assert.equal((await eater('POST', `/api/orders/${o.code}/review`, { rating: 1 })).status, 409);
  const page = (await stranger('GET', `/api/chefs/${sum.chef.id}`)).body;
  assert.equal(page.chef.rating.count, 1);
  assert.equal(page.reviews[0].name, 'Alex');

  // payout
  r = await cook('POST', '/api/chef/payouts', { instant: true });
  assert.equal(r.body.amount, 3045); assert.equal(r.body.fee, 46);
  assert.equal((await cook('GET', '/api/chef/summary')).body.balance.available, 0);

  // problem report -> admin refund
  assert.equal((await eater('POST', `/api/orders/${o.code}/issue`, { reason: 'One tamal was missing' })).status, 200);
  assert.equal((await admin('GET', '/api/admin/queue')).body.issues.length, 1);
  assert.equal((await admin('POST', `/api/admin/issues/${o.code}`, { decision: 'refund' })).status, 200);
  o = (await eater('GET', `/api/orders/${o.code}`)).body.order;
  assert.equal(o.payment.status, 'refunded'); assert.equal(o.issue.status, 'refunded');
  assert.equal((await cook('GET', '/api/chef/summary')).body.balance.available, -3045, 'refund after payout leaves the cook owing');

  // second order: cook declines -> hold released
  r = await eater('POST', '/api/orders', { items: [{ dishId: dish.body.dish.id, qty: 1 }], fulfillment: 'pickup', tipPercent: 0 });
  await eater('POST', `/api/orders/${r.body.order.code}/confirm`, { demoCard: { brand: 'Visa', last4: '4242' } });
  r = await cook('POST', `/api/chef/orders/${r.body.order.code}/decline`, {});
  assert.equal(r.body.order.status, 'declined'); assert.equal(r.body.order.payment.status, 'canceled');

  // sold out dishes can't be ordered
  await cook('PATCH', `/api/chef/dishes/${dish.body.dish.id}`, { available: false });
  assert.equal((await eater('POST', '/api/orders', { items: [{ dishId: dish.body.dish.id, qty: 1 }], fulfillment: 'pickup', tipPercent: 0 })).status, 409);

  // sign out ends the session
  await eater('POST', '/api/auth/logout', {});
  assert.equal((await eater('GET', '/api/orders')).status, 401);
});
