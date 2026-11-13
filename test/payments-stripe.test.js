// Stripe mode, with Stripe's client replaced by a recorder: checks what Chefy would send for cooks in different countries.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chefy-stripe-'));
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.PLATFORM_COUNTRY = 'GB';

const calls = [];
const fakeStripe = () => ({
  paymentIntents: { create: async (p, o) => { calls.push(['pi.create', p, o]); return { id: 'pi_1', client_secret: 'cs_1' }; } },
  accounts: { create: async p => { calls.push(['acct.create', p]); return { id: 'acct_new' }; } },
  accountLinks: { create: async () => ({ url: 'https://connect.stripe.test/onboard' }) },
  balance: { retrieve: async () => ({ available: [{ currency: 'usd', amount: 500 }, { currency: 'eur', amount: 900 }], pending: [], instant_available: [] }) },
  payouts: { create: async (p, o) => { calls.push(['payout.create', p, o]); return { id: 'po_1', status: 'pending', arrival_date: 0 }; } }
});
const load = Module._load;
Module._load = function (req, ...rest) { return req === 'stripe' ? fakeStripe : load.call(this, req, ...rest); };

const pay = require('../src/payments');
const { run, one } = require('../src/db');

function makeChef(id, country, currency) {
  run('INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, 0)', id, `c${id}@t.dev`, 'Cook', 'x');
  run(`INSERT INTO chefs (user_id, kitchen_name, country, currency, stripe_account_id, charges_enabled, created_at)
       VALUES (?, 'K', ?, ?, ?, 1, 0)`, id, country, currency, `acct_${id}`);
  return one('SELECT * FROM chefs WHERE user_id = ?', id);
}
const order = { code: 'CH-X', currency: 'eur', total_cents: 2779, commission_cents: 240, fee_cents: 139 };
const eater = { id: 9, email: 'e@t.dev' };

test('stripe mode charges in the cook\'s currency and flags cross-border charges', async () => {
  assert.equal(pay.MODE, 'stripe');
  const de = makeChef(1, 'DE', 'eur'), gb = makeChef(2, 'GB', 'gbp');

  await pay.createHold(order, de, eater);
  let [, p] = calls.at(-1);
  assert.equal(p.currency, 'eur');
  assert.equal(p.on_behalf_of, 'acct_1', 'cook in another country than the platform');
  assert.equal(p.application_fee_amount, 379);
  assert.equal(p.transfer_data.destination, 'acct_1');

  await pay.createHold({ ...order, code: 'CH-Y', currency: 'gbp' }, gb, eater);
  [, p] = calls.at(-1);
  assert.equal(p.currency, 'gbp');
  assert.equal(p.on_behalf_of, undefined, 'same country as the platform');

  // onboarding creates the Stripe account in the cook's country
  run('UPDATE chefs SET stripe_account_id = NULL WHERE user_id = 1');
  await pay.startOnboarding(one('SELECT * FROM chefs WHERE user_id = 1'), { email: 'c1@t.dev' });
  const acct = calls.find(c => c[0] === 'acct.create')[1];
  assert.equal(acct.country, 'DE');
  assert.equal(acct.default_currency, 'eur');

  // balance and payouts only count the cook's currency
  const b = await pay.balance(gb);
  assert.equal(b.available, 0, 'gbp cook ignores usd/eur balances');
  const deAgain = { ...de, stripe_account_id: 'acct_1' };
  assert.equal((await pay.balance(deAgain)).available, 900);
  const r = await pay.payout(deAgain, false);
  assert.equal(r.currency, 'eur');
  assert.equal(calls.at(-1)[1].currency, 'eur');
});
