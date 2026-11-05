// Payments. Two interchangeable providers:
//  - "stripe": real card payments (Stripe test or live keys). The card is authorized when the order
//    is placed (capture_method=manual) and only charged when the cook marks the order ready.
//    Money goes straight to the cook's Stripe Connect account; Chefy keeps commission + fee as the
//    application fee.
//  - "demo": no keys set. Same flow, simulated, so the whole app can be tried without Stripe.
const crypto = require('node:crypto');
const { one, all, run } = require('./db');
const { HttpError } = require('./auth');

const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || '';
const MODE = STRIPE_KEY ? 'stripe' : 'demo';
const PUBLIC_URL = (process.env.PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, '');
const INSTANT_FEE_RATE = 0.015;

let stripe = null;
if (MODE === 'stripe') stripe = require('stripe')(STRIPE_KEY);

const rid = p => p + crypto.randomBytes(9).toString('base64url');

// ---------- Orders ----------

async function createHold(order, chef, eater) {
  if (MODE === 'demo') return { intentId: rid('demo_pi_'), clientSecret: null };
  if (!chef.stripe_account_id || !chef.charges_enabled) {
    throw new HttpError(409, 'This cook has not finished payout setup, so they cannot take card orders yet.');
  }
  const pi = await stripe.paymentIntents.create({
    amount: order.total_cents,
    currency: 'usd',
    capture_method: 'manual',
    automatic_payment_methods: { enabled: true },
    application_fee_amount: order.commission_cents + order.fee_cents,
    transfer_data: { destination: chef.stripe_account_id },
    receipt_email: eater.email,
    description: `Chefy order ${order.code} from ${chef.kitchen_name}`,
    metadata: { order_code: order.code, chef_id: String(chef.user_id), eater_id: String(eater.id) }
  }, { idempotencyKey: `hold-${order.code}` });
  return { intentId: pi.id, clientSecret: pi.client_secret };
}

// Returns { authorized: true, cardLabel } when the hold is in place.
async function checkHold(order, demoCard) {
  if (MODE === 'demo') {
    if (!demoCard || !/^\d{4}$/.test(demoCard.last4 || '')) throw new HttpError(400, 'Card details missing.');
    const brand = String(demoCard.brand || 'Card').slice(0, 20);
    return { authorized: true, cardLabel: `${brand} •••• ${demoCard.last4}` };
  }
  const pi = await stripe.paymentIntents.retrieve(order.payment_intent_id, { expand: ['latest_charge'] });
  if (pi.status !== 'requires_capture') return { authorized: false, status: pi.status };
  const pm = pi.latest_charge?.payment_method_details;
  let label = 'Card';
  if (pm?.card) {
    const wallet = pm.card.wallet?.type ? pm.card.wallet.type.replace('_', ' ') + ' · ' : '';
    label = `${wallet}${cap(pm.card.brand)} •••• ${pm.card.last4}`;
  } else if (pm?.type) label = cap(pm.type.replace('_', ' '));
  return { authorized: true, cardLabel: label };
}

async function capture(order) {
  if (MODE === 'demo') return;
  await stripe.paymentIntents.capture(order.payment_intent_id, {}, { idempotencyKey: `capture-${order.code}` });
}

async function releaseHold(order) {
  if (MODE === 'demo' || !order.payment_intent_id) return;
  const pi = await stripe.paymentIntents.retrieve(order.payment_intent_id);
  if (['requires_capture', 'requires_payment_method', 'requires_confirmation', 'requires_action'].includes(pi.status)) {
    await stripe.paymentIntents.cancel(order.payment_intent_id);
  }
}

// Full refund. The cook's share is pulled back from their account and Chefy returns its fee.
async function refund(order) {
  if (MODE === 'demo') return;
  await stripe.refunds.create({
    payment_intent: order.payment_intent_id,
    reverse_transfer: true,
    refund_application_fee: true,
    metadata: { order_code: order.code }
  }, { idempotencyKey: `refund-${order.code}` });
}

// ---------- Cook payouts ----------

async function startOnboarding(chef, user) {
  if (MODE === 'demo') throw new HttpError(400, 'Stripe is not configured; use the demo bank form.');
  let accountId = chef.stripe_account_id;
  if (!accountId) {
    const acct = await stripe.accounts.create({
      type: 'express',
      country: 'US',
      email: user.email,
      business_type: 'individual',
      capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
      business_profile: { name: chef.kitchen_name, product_description: 'Home-cooked food sold through Chefy', mcc: '5812' },
      settings: { payouts: { schedule: { interval: 'manual' } } },
      metadata: { chef_id: String(chef.user_id) }
    });
    accountId = acct.id;
    run('UPDATE chefs SET stripe_account_id = ? WHERE user_id = ?', accountId, chef.user_id);
  }
  const link = await stripe.accountLinks.create({
    account: accountId,
    type: 'account_onboarding',
    refresh_url: `${PUBLIC_URL}/app#/kitchen/setup?stripe=refresh`,
    return_url: `${PUBLIC_URL}/app#/kitchen/setup?stripe=return`
  });
  return link.url;
}

async function refreshAccount(chef) {
  if (MODE === 'demo' || !chef.stripe_account_id) return chef;
  const acct = await stripe.accounts.retrieve(chef.stripe_account_id);
  const ext = acct.external_accounts?.data?.[0];
  const label = ext ? `${ext.bank_name || (ext.object === 'card' ? cap(ext.brand) : 'Bank')} •••• ${ext.last4}` : null;
  run('UPDATE chefs SET charges_enabled = ?, payout_bank_label = ? WHERE user_id = ?',
    acct.charges_enabled && acct.payouts_enabled ? 1 : 0, label, chef.user_id);
  return one('SELECT * FROM chefs WHERE user_id = ?', chef.user_id);
}

async function dashboardLink(chef) {
  if (MODE === 'demo' || !chef.stripe_account_id) throw new HttpError(400, 'No Stripe account yet.');
  return (await stripe.accounts.createLoginLink(chef.stripe_account_id)).url;
}

// Demo balance comes from Chefy's own ledger; Stripe balance from the cook's connected account.
async function balance(chef) {
  const pending = one(`SELECT COALESCE(SUM(chef_payout_cents),0) AS c FROM orders
                       WHERE chef_id = ? AND payment_status = 'authorized'`, chef.user_id).c;
  if (MODE === 'demo') {
    const earned = one(`SELECT COALESCE(SUM(chef_payout_cents),0) AS c FROM orders
                        WHERE chef_id = ? AND payment_status = 'captured'`, chef.user_id).c;
    const paid = one(`SELECT COALESCE(SUM(amount_cents),0) AS c FROM payouts WHERE chef_id = ?`, chef.user_id).c;
    return { available: earned - paid, pending, held: pending, inTransit: 0 };
  }
  if (!chef.stripe_account_id) return { available: 0, pending: 0, held: pending, inTransit: 0 };
  const b = await stripe.balance.retrieve({}, { stripeAccount: chef.stripe_account_id });
  const usd = arr => (arr || []).filter(x => x.currency === 'usd').reduce((s, x) => s + x.amount, 0);
  return { available: usd(b.available), pending: usd(b.pending), held: pending, inTransit: 0, instantAvailable: usd(b.instant_available) };
}

async function payout(chef, instant) {
  const bal = await balance(chef);
  const amount = instant && MODE === 'stripe' ? (bal.instantAvailable || 0) : bal.available;
  if (amount <= 0) throw new HttpError(400, 'Nothing available to cash out yet.');
  const now = Date.now();
  if (MODE === 'demo') {
    const fee = instant ? Math.round(amount * INSTANT_FEE_RATE) : 0;
    const arrives = instant ? now : addBusinessDays(now, 2);
    run(`INSERT INTO payouts (chef_id, amount_cents, fee_cents, instant, status, destination, arrives_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, chef.user_id, amount, fee, instant ? 1 : 0,
      instant ? 'paid' : 'in_transit', chef.payout_bank_label || 'Bank account', arrives, now);
    return { amount, fee };
  }
  const po = await stripe.payouts.create(
    { amount, currency: 'usd', method: instant ? 'instant' : 'standard' },
    { stripeAccount: chef.stripe_account_id }
  );
  run(`INSERT INTO payouts (chef_id, amount_cents, fee_cents, instant, status, provider_id, destination, arrives_at, created_at)
       VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?)`, chef.user_id, amount, instant ? 1 : 0, po.status,
    po.id, chef.payout_bank_label || 'Bank account', (po.arrival_date || 0) * 1000, now);
  return { amount, fee: 0 };
}

function addBusinessDays(ts, n) {
  const d = new Date(ts);
  let added = 0;
  while (added < n) { d.setDate(d.getDate() + 1); if (d.getDay() % 6 !== 0) added++; }
  return d.getTime();
}

function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

// ---------- Webhooks (optional but recommended in production) ----------

function constructEvent(rawBody, signature) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (MODE !== 'stripe' || !secret) throw new HttpError(400, 'Webhooks are not configured.');
  return stripe.webhooks.constructEvent(rawBody, signature, secret);
}

function publicConfig() {
  return {
    mode: MODE,
    publishableKey: MODE === 'stripe' ? (process.env.STRIPE_PUBLISHABLE_KEY || '') : null,
    instantFeeRate: MODE === 'demo' ? INSTANT_FEE_RATE : null
  };
}

module.exports = {
  MODE, createHold, checkHold, capture, releaseHold, refund,
  startOnboarding, refreshAccount, dashboardLink, balance, payout, constructEvent, publicConfig
};
