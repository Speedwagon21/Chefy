const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { one, all, run, tx, DATA_DIR, CATEGORIES } = require('./db');
const auth = require('./auth');
const pay = require('./payments');
const { HttpError, requireUser, requireChef, requireAdmin } = auth;

const router = express.Router();

// ---------- business rules ----------
const COMMISSION_RATE = 0.10;
const FEES = { pickup: 149, delivery: 399 };
const TIP_OPTIONS = [0, 10, 15, 20, 25];
const DIETARY = ['', 'Authentic Recipe', 'Vegetarian', 'Vegan', 'Gluten-Free', 'Halal', 'Organic'];
const PERMIT_STATES = ['CA', 'TX', 'NY', 'FL', 'Other'];
const ISSUE_WINDOW_MS = 48 * 3600000;

// ---------- input helpers ----------
function str(v, { max = 200, min = 0, field = 'Field', required = false } = {}) {
  const s = typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim());
  if (required && !s) throw new HttpError(400, `${field} is required.`);
  if (s.length < min) throw new HttpError(400, `${field} must be at least ${min} characters.`);
  if (s.length > max) throw new HttpError(400, `${field} must be ${max} characters or fewer.`);
  return s;
}
function oneOf(v, list, field) {
  if (!list.includes(v)) throw new HttpError(400, `${field} is not valid.`);
  return v;
}
function cents(v, field = 'Price') {
  const n = Math.round(Number(v) * 100);
  if (!Number.isFinite(n) || n < 100 || n > 50000) throw new HttpError(400, `${field} must be between $1 and $500.`);
  return n;
}
function url(v) {
  const s = str(v, { max: 500 });
  if (!s) return null;
  if (s.startsWith('/uploads/') || /^https:\/\//.test(s)) return s;
  throw new HttpError(400, 'Images must be an uploaded photo or an https:// link.');
}
const now = () => Date.now();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- serializers ----------
function chefRating(chefId) {
  const r = one('SELECT COUNT(*) AS n, AVG(rating) AS avg FROM reviews WHERE chef_id = ?', chefId);
  return { count: r.n, average: r.n ? Math.round(r.avg * 10) / 10 : null };
}
function chefIsLive(c) {
  return c.permit_status === 'verified' && c.accepting_orders && (pay.MODE === 'demo' || c.charges_enabled);
}
function publicChef(c) {
  return {
    id: c.user_id, kitchenName: c.kitchen_name, bio: c.bio, cuisine: c.cuisine, neighborhood: c.neighborhood,
    avatarUrl: c.avatar_url, coverUrl: c.cover_url, offersDelivery: !!c.offers_delivery,
    verified: c.permit_status === 'verified', permitLabel: c.permit_status === 'verified' ? permitLabel(c) : null,
    live: chefIsLive(c), rating: chefRating(c.user_id)
  };
}
function permitLabel(c) {
  return `${c.permit_state === 'Other' ? '' : c.permit_state + ' '}food handler permit${c.permit_expiry ? ' · valid thru ' + c.permit_expiry.slice(0, 7) : ''}`;
}
function ownChef(c) {
  return {
    ...publicChef(c), pickupAddress: c.pickup_address, pickupNotes: c.pickup_notes,
    acceptingOrders: !!c.accepting_orders, permit: {
      status: c.permit_status, state: c.permit_state, number: c.permit_number, expiry: c.permit_expiry,
      hasFile: !!c.permit_file, note: c.permit_note
    },
    payouts: { mode: pay.MODE, ready: pay.MODE === 'demo' ? !!c.payout_bank_label : !!c.charges_enabled, bankLabel: c.payout_bank_label, stripeStarted: !!c.stripe_account_id }
  };
}
function dishOut(d) {
  return {
    id: d.id, chefId: d.chef_id, title: d.title, category: d.category, categories: splitCats(d), price: d.price_cents, prepTime: d.prep_time,
    dietary: d.dietary, description: d.description, imageUrl: d.image_url, available: !!d.available
  };
}
function meOut(req) {
  if (!req.user) return { user: null, chef: null };
  const u = req.user;
  return {
    user: { id: u.id, name: u.name, email: u.email, neighborhood: u.neighborhood, phone: u.phone, isAdmin: !!u.is_admin },
    chef: req.chef ? ownChef(req.chef) : null
  };
}
function orderOut(o, viewer) {
  const items = all('SELECT dish_id, title, price_cents, qty FROM order_items WHERE order_id = ?', o.id)
    .map(i => ({ dishId: i.dish_id, title: i.title, price: i.price_cents, qty: i.qty }));
  const chef = one('SELECT * FROM chefs WHERE user_id = ?', o.chef_id);
  const eater = one('SELECT name, phone FROM users WHERE id = ?', o.eater_id);
  const review = one('SELECT rating, text FROM reviews WHERE order_id = ?', o.id);
  // Pickup address only for orders whose payment was actually authorized and that are still active.
  const paid = !!o.authorized_at && !['canceled', 'declined'].includes(o.status);
  const out = {
    code: o.code, status: o.status, fulfillment: o.fulfillment, notes: o.notes, deliveryAddress: o.delivery_address,
    subtotal: o.subtotal_cents, fee: o.fee_cents, tip: o.tip_cents, total: o.total_cents,
    payment: { status: o.payment_status, label: o.card_label, refunded: o.refund_cents },
    issue: o.issue_status ? { status: o.issue_status, reason: o.issue_reason } : null,
    review: review || null, items,
    times: { created: o.created_at, accepted: o.accepted_at, ready: o.ready_at, completed: o.completed_at, closed: o.closed_at },
    chef: { id: chef.user_id, kitchenName: chef.kitchen_name, avatarUrl: chef.avatar_url,
      pickupAddress: paid ? chef.pickup_address : null, pickupNotes: paid ? chef.pickup_notes : null }
  };
  if (viewer === 'chef' || viewer === 'admin') {
    out.eater = { name: eater.name, phone: eater.phone };
    out.commission = o.commission_cents;
    out.chefPayout = o.chef_payout_cents;
  }
  if (viewer === 'eater') {
    out.canCancel = ['awaiting_payment', 'received'].includes(o.status);
    out.canReview = !review && ['ready', 'completed'].includes(o.status) && o.payment_status === 'captured';
    out.canReport = !o.issue_status && ['ready', 'completed'].includes(o.status) && o.payment_status === 'captured'
      && o.ready_at && now() - o.ready_at < ISSUE_WINDOW_MS;
  }
  return out;
}
const orderByCode = code => one('SELECT * FROM orders WHERE code = ?', String(code));
function newCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (const b of crypto.randomBytes(6)) s += alphabet[b % alphabet.length];
  return 'CH-' + s;
}

// ---------- config ----------
router.get('/config', (_req, res) => {
  res.json({
    payments: pay.publicConfig(), commissionRate: COMMISSION_RATE, fees: FEES, tipOptions: TIP_OPTIONS,
    categories: CATEGORIES, dietary: DIETARY.filter(Boolean), permitStates: PERMIT_STATES
  });
});

// ---------- accounts ----------
router.get('/me', (req, res) => res.json(meOut(req)));

router.post('/auth/signup', wrap(async (req, res) => {
  auth.rateLimit('signup:' + req.ip, 20);
  const name = str(req.body.name, { field: 'Name', required: true, max: 80 });
  const email = str(req.body.email, { field: 'Email', required: true, max: 160 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address.');
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (password.length < 8) throw new HttpError(400, 'Use a password of at least 8 characters.');
  if (password.length > 200) throw new HttpError(400, 'That password is too long.');
  const neighborhood = str(req.body.neighborhood, { max: 80 });
  if (one('SELECT 1 FROM users WHERE email = ?', email)) throw new HttpError(409, 'An account with that email already exists. Sign in instead.');
  const r = run('INSERT INTO users (email, name, password_hash, neighborhood, created_at) VALUES (?, ?, ?, ?, ?)',
    email, name, auth.hashPassword(password), neighborhood || null, now());
  auth.createSession(res, Number(r.lastInsertRowid));
  req.user = one('SELECT * FROM users WHERE id = ?', r.lastInsertRowid);
  req.chef = null;
  res.status(201).json(meOut(req));
}));

router.post('/auth/login', wrap(async (req, res) => {
  const email = str(req.body.email, { field: 'Email', required: true, max: 160 }).toLowerCase();
  auth.rateLimit('login:' + req.ip + ':' + email, 10);
  const u = one('SELECT * FROM users WHERE email = ?', email);
  if (!u || !auth.verifyPassword(String(req.body.password || ''), u.password_hash)) {
    throw new HttpError(401, 'That email and password don\'t match. Check them and try again.');
  }
  auth.createSession(res, u.id);
  req.user = u;
  req.chef = one('SELECT * FROM chefs WHERE user_id = ?', u.id) || null;
  res.json(meOut(req));
}));

router.post('/auth/logout', (req, res) => { auth.destroySession(req, res); res.json({ ok: true }); });

router.patch('/me', requireUser, (req, res) => {
  const name = str(req.body.name ?? req.user.name, { field: 'Name', required: true, max: 80 });
  const neighborhood = str(req.body.neighborhood ?? req.user.neighborhood, { max: 80 });
  const phone = str(req.body.phone ?? req.user.phone, { max: 30 });
  run('UPDATE users SET name = ?, neighborhood = ?, phone = ? WHERE id = ?', name, neighborhood || null, phone || null, req.user.id);
  req.user = one('SELECT * FROM users WHERE id = ?', req.user.id);
  res.json(meOut(req));
});

// ---------- browsing ----------
// How many of each dish were ordered and paid for in the last 30 days (drives "Trending" and "Popular").
function popularity() {
  return Object.fromEntries(all(`SELECT oi.dish_id, SUM(oi.qty) AS n FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE o.payment_status IN ('authorized', 'captured') AND o.created_at > ? GROUP BY oi.dish_id`, now() - 30 * 86400000)
    .map(r => [r.dish_id, r.n]));
}
function savedSet(req) {
  return new Set(req.user ? all('SELECT dish_id FROM saved_dishes WHERE user_id = ?', req.user.id).map(r => r.dish_id) : []);
}

router.get('/dishes', (req, res) => {
  const chefs = all('SELECT * FROM chefs').filter(chefIsLive);
  const byId = Object.fromEntries(chefs.map(c => [c.user_id, publicChef(c)]));
  const ids = chefs.map(c => c.user_id);
  const dishes = ids.length
    ? all(`SELECT * FROM dishes WHERE deleted = 0 AND chef_id IN (${ids.map(() => '?').join(',')})
           ORDER BY available DESC, created_at DESC`, ...ids)
    : [];
  const pop = popularity(), saved = savedSet(req);
  res.json({ dishes: dishes.map(d => ({ ...dishOut(d), chef: byId[d.chef_id], popularity: pop[d.id] || 0, saved: saved.has(d.id) })) });
});

router.get('/saved', requireUser, (req, res) => {
  const rows = all(`SELECT d.* FROM saved_dishes s JOIN dishes d ON d.id = s.dish_id
                    WHERE s.user_id = ? AND d.deleted = 0 ORDER BY s.created_at DESC`, req.user.id);
  const chefs = {};
  const pop = popularity();
  const dishes = [];
  for (const d of rows) {
    const c = chefs[d.chef_id] ??= one('SELECT * FROM chefs WHERE user_id = ?', d.chef_id);
    if (!c || c.permit_status !== 'verified') continue;
    const out = { ...dishOut(d), chef: publicChef(c), popularity: pop[d.id] || 0, saved: true };
    if (!chefIsLive(c)) out.available = false;
    dishes.push(out);
  }
  res.json({ dishes });
});
router.post('/saved/:dishId', requireUser, (req, res) => {
  const dishId = Number(req.params.dishId);
  if (!one('SELECT 1 FROM dishes WHERE id = ? AND deleted = 0', dishId)) throw new HttpError(404, 'That dish is no longer listed.');
  if (req.body.saved === false) run('DELETE FROM saved_dishes WHERE user_id = ? AND dish_id = ?', req.user.id, dishId);
  else run('INSERT OR IGNORE INTO saved_dishes (user_id, dish_id, created_at) VALUES (?, ?, ?)', req.user.id, dishId, now());
  res.json({ ok: true, saved: req.body.saved !== false });
});

router.get('/chefs/:id', (req, res) => {
  const c = one('SELECT * FROM chefs WHERE user_id = ?', Number(req.params.id));
  if (!c || c.permit_status !== 'verified') throw new HttpError(404, 'That kitchen isn\'t on Chefy.');
  const dishes = all('SELECT * FROM dishes WHERE chef_id = ? AND deleted = 0 ORDER BY available DESC, created_at DESC', c.user_id);
  const reviews = all(`SELECT r.rating, r.text, r.created_at, u.name FROM reviews r JOIN users u ON u.id = r.eater_id
                       WHERE r.chef_id = ? ORDER BY r.created_at DESC LIMIT 20`, c.user_id)
    .map(r => ({ rating: r.rating, text: r.text, at: r.created_at, name: r.name.split(' ')[0] }));
  const pop = popularity(), saved = savedSet(req);
  res.json({ chef: publicChef(c), dishes: dishes.map(d => ({ ...dishOut(d), popularity: pop[d.id] || 0, saved: saved.has(d.id) })), reviews });
});

// ---------- uploads ----------
const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
router.post('/uploads', requireUser, (req, res) => {
  const kind = req.body.kind === 'permit' ? 'permit' : 'image';
  const m = /^data:([\w/+.-]+);base64,(.+)$/.exec(String(req.body.dataUrl || ''));
  if (!m) throw new HttpError(400, 'Upload a photo or PDF.');
  const types = kind === 'permit' ? { ...IMAGE_TYPES, 'application/pdf': 'pdf' } : IMAGE_TYPES;
  const ext = types[m[1]];
  if (!ext) throw new HttpError(400, kind === 'permit' ? 'Use a JPG, PNG, WebP or PDF file.' : 'Use a JPG, PNG or WebP photo.');
  const buf = Buffer.from(m[2], 'base64');
  const max = kind === 'permit' ? 8 : 4;
  if (buf.length > max * 1024 * 1024) throw new HttpError(400, `That file is over ${max} MB.`);
  const name = `${req.user.id}-${crypto.randomBytes(12).toString('hex')}.${ext}`;
  const dir = kind === 'permit' ? 'private' : 'public';
  fs.writeFileSync(path.join(DATA_DIR, 'uploads', dir, name), buf);
  res.status(201).json(kind === 'permit' ? { file: name } : { url: `/uploads/${name}` });
});

router.get('/files/:name', requireUser, (req, res) => {
  const name = path.basename(req.params.name);
  const owner = Number(name.split('-')[0]);
  if (owner !== req.user.id && !req.user.is_admin) throw new HttpError(403, 'Not allowed.');
  const file = path.join(DATA_DIR, 'uploads', 'private', name);
  if (!fs.existsSync(file)) throw new HttpError(404, 'File not found.');
  res.sendFile(file);
});

// ---------- kitchen (cook) ----------
router.post('/chef', requireUser, (req, res) => {
  const c = req.chef || {};
  const b = req.body;
  const fields = {
    kitchen_name: str(b.kitchenName ?? c.kitchen_name, { field: 'Kitchen name', required: true, max: 60 }),
    bio: str(b.bio ?? c.bio, { max: 600 }),
    cuisine: str(b.cuisine ?? c.cuisine, { max: 60 }),
    neighborhood: str(b.neighborhood ?? c.neighborhood, { max: 60 }),
    pickup_address: str(b.pickupAddress ?? c.pickup_address, { max: 200 }),
    pickup_notes: str(b.pickupNotes ?? c.pickup_notes, { max: 300 }),
    avatar_url: b.avatarUrl !== undefined ? url(b.avatarUrl) : (c.avatar_url ?? null),
    cover_url: b.coverUrl !== undefined ? url(b.coverUrl) : (c.cover_url ?? null),
    offers_delivery: (b.offersDelivery ?? c.offers_delivery) ? 1 : 0,
    accepting_orders: (b.acceptingOrders ?? c.accepting_orders ?? 1) ? 1 : 0
  };
  if (req.chef) {
    run(`UPDATE chefs SET ${Object.keys(fields).map(k => k + ' = ?').join(', ')} WHERE user_id = ?`, ...Object.values(fields), req.user.id);
  } else {
    run(`INSERT INTO chefs (user_id, ${Object.keys(fields).join(', ')}, created_at) VALUES (?, ${Object.keys(fields).map(() => '?').join(', ')}, ?)`,
      req.user.id, ...Object.values(fields), now());
  }
  req.chef = one('SELECT * FROM chefs WHERE user_id = ?', req.user.id);
  res.json(meOut(req));
});

router.post('/chef/permit', requireUser, requireChef, (req, res) => {
  const state = oneOf(req.body.state, PERMIT_STATES, 'Issuing state');
  const number = str(req.body.number, { field: 'Permit number', required: true, min: 3, max: 60 });
  const expiry = str(req.body.expiry, { field: 'Expiration date', required: true, max: 10 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry) || new Date(expiry + 'T23:59:59') < new Date()) {
    throw new HttpError(400, 'Enter an expiration date in the future.');
  }
  const file = path.basename(str(req.body.file, { field: 'Permit photo', required: true, max: 120 }));
  if (Number(file.split('-')[0]) !== req.user.id || !fs.existsSync(path.join(DATA_DIR, 'uploads', 'private', file))) {
    throw new HttpError(400, 'Upload a photo or PDF of your permit.');
  }
  run(`UPDATE chefs SET permit_state = ?, permit_number = ?, permit_expiry = ?, permit_file = ?, permit_status = 'pending', permit_note = NULL
       WHERE user_id = ?`, state, number, expiry, file, req.user.id);
  req.chef = one('SELECT * FROM chefs WHERE user_id = ?', req.user.id);
  res.json(meOut(req));
});

const splitCats = d => (d.categories || d.category || 'Other').split('|').filter(Boolean);
// Accepts categories: [...] (1-3), or the older single category field.
function categoryList(b, existing) {
  let list = Array.isArray(b.categories) ? b.categories : (b.category !== undefined ? [b.category] : (existing.id ? splitCats(existing) : []));
  list = [...new Set(list.map(String))];
  if (!list.length) throw new HttpError(400, 'Pick at least one category.');
  if (list.length > 3) throw new HttpError(400, 'Pick up to 3 categories.');
  list.forEach(c => oneOf(c, CATEGORIES, 'Category'));
  return list;
}
function dishFields(b, existing = {}) {
  const cats = categoryList(b, existing);
  return {
    title: str(b.title ?? existing.title, { field: 'Dish name', required: true, max: 80 }),
    category: cats[0],
    categories: cats.join('|'),
    price_cents: b.price !== undefined ? cents(b.price) : existing.price_cents,
    prep_time: str(b.prepTime ?? existing.prep_time, { max: 30 }),
    dietary: oneOf(b.dietary ?? existing.dietary ?? '', DIETARY, 'Dietary tag'),
    description: str(b.description ?? existing.description, { field: 'Description', required: true, max: 500 }),
    image_url: b.imageUrl !== undefined ? url(b.imageUrl) : (existing.image_url ?? null),
    available: (b.available ?? existing.available ?? 1) ? 1 : 0
  };
}
const ownDish = (req) => {
  const d = one('SELECT * FROM dishes WHERE id = ? AND chef_id = ? AND deleted = 0', Number(req.params.id), req.user.id);
  if (!d) throw new HttpError(404, 'Dish not found.');
  return d;
};

router.get('/chef/dishes', requireUser, requireChef, (req, res) => {
  res.json({ dishes: all('SELECT * FROM dishes WHERE chef_id = ? AND deleted = 0 ORDER BY created_at DESC', req.user.id).map(dishOut) });
});
router.post('/chef/dishes', requireUser, requireChef, (req, res) => {
  const f = dishFields(req.body);
  if (f.price_cents === undefined) throw new HttpError(400, 'Price is required.');
  const r = run(`INSERT INTO dishes (chef_id, ${Object.keys(f).join(', ')}, created_at) VALUES (?, ${Object.keys(f).map(() => '?').join(', ')}, ?)`,
    req.user.id, ...Object.values(f), now());
  res.status(201).json({ dish: dishOut(one('SELECT * FROM dishes WHERE id = ?', r.lastInsertRowid)) });
});
router.patch('/chef/dishes/:id', requireUser, requireChef, (req, res) => {
  const d = ownDish(req);
  const f = dishFields(req.body, d);
  run(`UPDATE dishes SET ${Object.keys(f).map(k => k + ' = ?').join(', ')} WHERE id = ?`, ...Object.values(f), d.id);
  res.json({ dish: dishOut(one('SELECT * FROM dishes WHERE id = ?', d.id)) });
});
router.delete('/chef/dishes/:id', requireUser, requireChef, (req, res) => {
  const d = ownDish(req);
  run('UPDATE dishes SET deleted = 1, available = 0 WHERE id = ?', d.id);
  res.json({ ok: true });
});

router.get('/chef/orders', requireUser, requireChef, (req, res) => {
  const rows = all(`SELECT * FROM orders WHERE chef_id = ? AND status != 'awaiting_payment'
                    ORDER BY CASE WHEN status IN ('received','preparing','ready') THEN 0 ELSE 1 END, created_at DESC LIMIT 100`, req.user.id);
  res.json({ orders: rows.map(o => orderOut(o, 'chef')) });
});

const chefOrder = req => {
  const o = orderByCode(req.params.code);
  if (!o || o.chef_id !== req.user.id || o.status === 'awaiting_payment') throw new HttpError(404, 'Order not found.');
  return o;
};
function transition(o, from, to, extra = {}) {
  const sets = Object.entries({ status: to, ...extra });
  const r = run(`UPDATE orders SET ${sets.map(([k]) => k + ' = ?').join(', ')} WHERE id = ? AND status IN (${from.map(() => '?').join(',')})`,
    ...sets.map(([, v]) => v), o.id, ...from);
  if (r.changes !== 1) throw new HttpError(409, 'This order was just updated. Refresh and try again.');
  return one('SELECT * FROM orders WHERE id = ?', o.id);
}

router.post('/chef/orders/:code/:action', requireUser, requireChef, wrap(async (req, res) => {
  let o = chefOrder(req);
  switch (req.params.action) {
    case 'accept':
      o = transition(o, ['received'], 'preparing', { accepted_at: now() });
      break;
    case 'ready':
      if (o.status !== 'preparing') throw new HttpError(409, 'Start preparing the order first.');
      try { await pay.capture(o); }
      catch (e) { throw new HttpError(402, 'We couldn\'t charge the customer\'s card (the hold may have expired). Contact support before handing over the food.'); }
      o = transition(o, ['preparing'], 'ready', { ready_at: now(), payment_status: 'captured', captured_at: now() });
      break;
    case 'complete':
      o = transition(o, ['ready'], 'completed', { completed_at: now() });
      break;
    case 'decline':
      if (!['received', 'preparing'].includes(o.status)) throw new HttpError(409, 'Only new or in-progress orders can be declined.');
      await pay.releaseHold(o);
      o = transition(o, ['received', 'preparing'], 'declined', { closed_at: now(), payment_status: 'canceled' });
      break;
    case 'refund':
      if (o.payment_status !== 'captured') throw new HttpError(409, 'Only charged orders can be refunded.');
      await pay.refund(o);
      run(`UPDATE orders SET payment_status = 'refunded', refund_cents = total_cents, refunded_at = ?,
           issue_status = CASE WHEN issue_status = 'open' THEN 'refunded' ELSE issue_status END WHERE id = ?`, now(), o.id);
      o = one('SELECT * FROM orders WHERE id = ?', o.id);
      break;
    default: throw new HttpError(404, 'Unknown action.');
  }
  res.json({ order: orderOut(o, 'chef') });
}));

router.get('/chef/summary', requireUser, requireChef, wrap(async (req, res) => {
  let chef = req.chef;
  if (pay.MODE === 'stripe' && chef.stripe_account_id) chef = await pay.refreshAccount(chef).catch(() => chef);
  const id = chef.user_id;
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const today = one(`SELECT COALESCE(SUM(chef_payout_cents),0) AS c, COUNT(*) AS n FROM orders
                     WHERE chef_id = ? AND payment_status = 'captured' AND captured_at >= ?`, id, dayStart.getTime());
  const active = one(`SELECT COUNT(*) AS n FROM orders WHERE chef_id = ? AND status IN ('received','preparing','ready')`, id).n;
  const dishes = one('SELECT COUNT(*) AS n, COALESCE(SUM(available),0) AS live FROM dishes WHERE chef_id = ? AND deleted = 0', id);
  let bal;
  try { bal = await pay.balance(chef); } catch { bal = null; }
  const ledger = [
    ...all(`SELECT code, chef_payout_cents, subtotal_cents, commission_cents, tip_cents, captured_at, card_label FROM orders
            WHERE chef_id = ? AND captured_at IS NOT NULL ORDER BY captured_at DESC LIMIT 50`, id)
      .map(o => ({ kind: 'sale', title: `${o.code} · Sale`, detail: `${money(o.subtotal_cents)} food − ${money(o.commission_cents)} fee + ${money(o.tip_cents)} tip`, amount: o.chef_payout_cents, at: o.captured_at })),
    ...all(`SELECT code, chef_payout_cents, refunded_at FROM orders WHERE chef_id = ? AND refunded_at IS NOT NULL ORDER BY refunded_at DESC LIMIT 50`, id)
      .map(o => ({ kind: 'refund', title: `${o.code} · Refunded`, detail: 'Customer refunded in full', amount: -o.chef_payout_cents, at: o.refunded_at })),
    ...all('SELECT * FROM payouts WHERE chef_id = ? ORDER BY created_at DESC LIMIT 50', id)
      .map(p => ({ kind: 'payout', title: p.instant ? 'Instant payout' : 'Standard payout',
        detail: `To ${p.destination}${p.fee_cents ? ` · ${money(p.fee_cents)} fee` : ''} · ${p.status === 'paid' || (p.arrives_at && p.arrives_at < now()) ? 'Paid' : 'Arrives ' + new Date(p.arrives_at).toDateString().slice(0, 10)}`,
        amount: -p.amount_cents, at: p.created_at }))
  ].sort((a, b) => b.at - a.at).slice(0, 60);
  res.json({
    chef: ownChef(chef), stats: { todayEarned: today.c, todayOrders: today.n, activeOrders: active, dishes: dishes.n, liveDishes: dishes.live },
    balance: bal, ledger, rating: chefRating(id)
  });
}));

function money(c) { return (c < 0 ? '−$' : '$') + (Math.abs(c) / 100).toFixed(2); }

router.post('/chef/bank', requireUser, requireChef, (req, res) => {
  if (pay.MODE !== 'demo') throw new HttpError(400, 'Bank details are managed securely by Stripe. Use "Set up payouts".');
  const bank = str(req.body.bank, { field: 'Bank name', required: true, max: 40 });
  const routing = String(req.body.routing || '').replace(/\D/g, '');
  const account = String(req.body.account || '').replace(/\D/g, '');
  if (routing.length !== 9) throw new HttpError(400, 'Routing number must be 9 digits.');
  if (account.length < 4 || account.length > 17) throw new HttpError(400, 'Account number must be 4–17 digits.');
  run('UPDATE chefs SET payout_bank_label = ? WHERE user_id = ?', `${bank} •••• ${account.slice(-4)}`, req.user.id);
  req.chef = one('SELECT * FROM chefs WHERE user_id = ?', req.user.id);
  res.json(meOut(req));
});

router.post('/chef/stripe/onboard', requireUser, requireChef, wrap(async (req, res) => {
  res.json({ url: await pay.startOnboarding(req.chef, req.user) });
}));
router.post('/chef/stripe/refresh', requireUser, requireChef, wrap(async (req, res) => {
  req.chef = await pay.refreshAccount(req.chef);
  res.json(meOut(req));
}));
router.post('/chef/stripe/dashboard', requireUser, requireChef, wrap(async (req, res) => {
  res.json({ url: await pay.dashboardLink(req.chef) });
}));
router.post('/chef/payouts', requireUser, requireChef, wrap(async (req, res) => {
  if (pay.MODE === 'demo' && !req.chef.payout_bank_label) throw new HttpError(400, 'Add a bank account first.');
  if (pay.MODE === 'stripe' && !req.chef.charges_enabled) throw new HttpError(400, 'Finish payout setup with Stripe first.');
  const r = await pay.payout(req.chef, !!req.body.instant);
  res.json({ ok: true, ...r });
}));

// ---------- ordering (eater) ----------
router.post('/orders', requireUser, wrap(async (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length || items.length > 30) throw new HttpError(400, 'Your basket is empty.');
  const fulfillment = oneOf(req.body.fulfillment, ['pickup', 'delivery'], 'Pickup or delivery');
  const tipPercent = Number(req.body.tipPercent);
  if (!TIP_OPTIONS.includes(tipPercent)) throw new HttpError(400, 'Choose a tip option.');
  const notes = str(req.body.notes, { max: 300 });

  const lines = items.map(i => {
    const qty = Math.floor(Number(i.qty));
    if (!(qty >= 1 && qty <= 20)) throw new HttpError(400, 'Quantities must be between 1 and 20.');
    const d = one('SELECT * FROM dishes WHERE id = ? AND deleted = 0', Number(i.dishId));
    if (!d) throw new HttpError(409, 'A dish in your basket is no longer listed. Remove it and try again.');
    if (!d.available) throw new HttpError(409, `${d.title} just sold out. Remove it and try again.`);
    return { d, qty };
  });
  const chefIds = [...new Set(lines.map(l => l.d.chef_id))];
  if (chefIds.length !== 1) throw new HttpError(400, 'Order from one kitchen at a time.');
  const chef = one('SELECT * FROM chefs WHERE user_id = ?', chefIds[0]);
  if (!chefIsLive(chef)) throw new HttpError(409, `${chef.kitchen_name} isn't taking orders right now.`);
  if (chef.user_id === req.user.id) throw new HttpError(400, 'You can\'t order from your own kitchen.');
  let deliveryAddress = null;
  if (fulfillment === 'delivery') {
    if (!chef.offers_delivery) throw new HttpError(400, `${chef.kitchen_name} offers pickup only.`);
    deliveryAddress = str(req.body.deliveryAddress, { field: 'Delivery address', required: true, min: 5, max: 200 });
  }

  const subtotal = lines.reduce((s, l) => s + l.d.price_cents * l.qty, 0);
  const fee = FEES[fulfillment];
  const tip = Math.round(subtotal * tipPercent / 100);
  const commission = Math.round(subtotal * COMMISSION_RATE);
  const order = {
    code: newCode(), subtotal_cents: subtotal, fee_cents: fee, tip_cents: tip, total_cents: subtotal + fee + tip,
    commission_cents: commission, chef_payout_cents: subtotal - commission + tip
  };
  const hold = await pay.createHold(order, chef, req.user);
  const id = tx(() => {
    const r = run(`INSERT INTO orders (code, eater_id, chef_id, status, fulfillment, delivery_address, notes, subtotal_cents, fee_cents,
                   tip_cents, total_cents, commission_cents, chef_payout_cents, payment_provider, payment_intent_id, created_at)
                   VALUES (?, ?, ?, 'awaiting_payment', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      order.code, req.user.id, chef.user_id, fulfillment, deliveryAddress, notes || null, subtotal, fee, tip, order.total_cents,
      commission, order.chef_payout_cents, pay.MODE, hold.intentId, now());
    for (const l of lines) {
      run('INSERT INTO order_items (order_id, dish_id, title, price_cents, qty) VALUES (?, ?, ?, ?, ?)',
        r.lastInsertRowid, l.d.id, l.d.title, l.d.price_cents, l.qty);
    }
    return r.lastInsertRowid;
  });
  res.status(201).json({ order: orderOut(one('SELECT * FROM orders WHERE id = ?', id), 'eater'), clientSecret: hold.clientSecret });
}));

const myOrder = req => {
  const o = orderByCode(req.params.code);
  if (!o || o.eater_id !== req.user.id) throw new HttpError(404, 'Order not found.');
  return o;
};

router.post('/orders/:code/confirm', requireUser, wrap(async (req, res) => {
  let o = myOrder(req);
  if (o.status === 'awaiting_payment') {
    const r = await pay.checkHold(o, req.body.demoCard);
    if (!r.authorized) {
      throw new HttpError(402, r.status === 'requires_payment_method'
        ? 'Your card was declined. No charge was made — try another card.'
        : 'Payment isn\'t complete yet. Finish the card check and try again.');
    }
    o = transition(o, ['awaiting_payment'], 'received', { payment_status: 'authorized', card_label: r.cardLabel, authorized_at: now() });
  }
  res.json({ order: orderOut(o, 'eater') });
}));

router.post('/orders/:code/cancel', requireUser, wrap(async (req, res) => {
  let o = myOrder(req);
  if (!['awaiting_payment', 'received'].includes(o.status)) throw new HttpError(409, 'The cook has already started this order, so it can\'t be cancelled here. Message them or report a problem after pickup.');
  await pay.releaseHold(o);
  o = transition(o, ['awaiting_payment', 'received'], 'canceled', { closed_at: now(), payment_status: 'canceled' });
  res.json({ order: orderOut(o, 'eater') });
}));

router.get('/orders', requireUser, (req, res) => {
  const rows = all(`SELECT * FROM orders WHERE eater_id = ? AND status != 'awaiting_payment' ORDER BY created_at DESC LIMIT 100`, req.user.id);
  res.json({ orders: rows.map(o => orderOut(o, 'eater')) });
});
router.get('/orders/:code', requireUser, (req, res) => res.json({ order: orderOut(myOrder(req), 'eater') }));

router.post('/orders/:code/review', requireUser, (req, res) => {
  const o = myOrder(req);
  const out = orderOut(o, 'eater');
  if (!out.canReview) throw new HttpError(409, 'You can review an order once it\'s ready, and only once.');
  const rating = Number(req.body.rating);
  if (![1, 2, 3, 4, 5].includes(rating)) throw new HttpError(400, 'Pick 1 to 5 stars.');
  const text = str(req.body.text, { max: 500 });
  run('INSERT INTO reviews (order_id, eater_id, chef_id, rating, text, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    o.id, req.user.id, o.chef_id, rating, text, now());
  res.json({ order: orderOut(o, 'eater') });
});

router.post('/orders/:code/issue', requireUser, (req, res) => {
  const o = myOrder(req);
  if (!orderOut(o, 'eater').canReport) throw new HttpError(409, 'Problems can be reported within 48 hours of the order being ready.');
  const reason = str(req.body.reason, { field: 'What went wrong', required: true, min: 5, max: 500 });
  run(`UPDATE orders SET issue_status = 'open', issue_reason = ? WHERE id = ?`, reason, o.id);
  res.json({ order: orderOut(one('SELECT * FROM orders WHERE id = ?', o.id), 'eater') });
});

// ---------- admin ----------
router.get('/admin/queue', requireUser, requireAdmin, (_req, res) => {
  const permits = all(`SELECT c.*, u.email, u.name FROM chefs c JOIN users u ON u.id = c.user_id
                       WHERE c.permit_status = 'pending' ORDER BY c.created_at`)
    .map(c => ({ chefId: c.user_id, kitchenName: c.kitchen_name, name: c.name, email: c.email,
      state: c.permit_state, number: c.permit_number, expiry: c.permit_expiry, file: c.permit_file }));
  const issues = all(`SELECT * FROM orders WHERE issue_status = 'open' ORDER BY created_at`).map(o => orderOut(o, 'admin'));
  const totals = one(`SELECT COUNT(*) AS orders, COALESCE(SUM(CASE WHEN payment_status='captured' THEN commission_cents + fee_cents END),0) AS revenue
                      FROM orders WHERE status != 'awaiting_payment'`);
  res.json({ permits, issues, totals });
});
router.post('/admin/permits/:chefId', requireUser, requireAdmin, (req, res) => {
  const decision = oneOf(req.body.decision, ['verified', 'rejected'], 'Decision');
  const note = str(req.body.note, { max: 300 });
  const r = run(`UPDATE chefs SET permit_status = ?, permit_note = ? WHERE user_id = ? AND permit_status = 'pending'`,
    decision, note || null, Number(req.params.chefId));
  if (r.changes !== 1) throw new HttpError(409, 'That permit was already reviewed.');
  res.json({ ok: true });
});
router.post('/admin/issues/:code', requireUser, requireAdmin, wrap(async (req, res) => {
  const o = orderByCode(req.params.code);
  if (!o || o.issue_status !== 'open') throw new HttpError(404, 'Open issue not found.');
  const decision = oneOf(req.body.decision, ['refund', 'dismiss'], 'Decision');
  if (decision === 'refund') {
    if (o.payment_status === 'captured') await pay.refund(o);
    run(`UPDATE orders SET payment_status = 'refunded', refund_cents = total_cents, refunded_at = ?, issue_status = 'refunded' WHERE id = ?`, now(), o.id);
  } else {
    run(`UPDATE orders SET issue_status = 'dismissed' WHERE id = ?`, o.id);
  }
  res.json({ ok: true });
}));

// ---------- Stripe webhook (raw body; mounted separately in server.js) ----------
async function stripeWebhook(req, res) {
  let event;
  try { event = pay.constructEvent(req.body, req.headers['stripe-signature']); }
  catch (e) { return res.status(400).send(`Webhook error: ${e.message}`); }
  const obj = event.data.object;
  if (event.type === 'payment_intent.amount_capturable_updated') {
    const o = one('SELECT * FROM orders WHERE payment_intent_id = ?', obj.id);
    if (o && o.status === 'awaiting_payment') {
      const r = await pay.checkHold(o).catch(() => null);
      if (r?.authorized) {
        run(`UPDATE orders SET status = 'received', payment_status = 'authorized', card_label = ?, authorized_at = ?
             WHERE id = ? AND status = 'awaiting_payment'`, r.cardLabel, now(), o.id);
      }
    }
  } else if (event.type === 'payment_intent.canceled') {
    run(`UPDATE orders SET status = CASE WHEN status IN ('awaiting_payment','received') THEN 'canceled' ELSE status END,
         payment_status = 'canceled', closed_at = COALESCE(closed_at, ?) WHERE payment_intent_id = ? AND payment_status != 'captured'`, now(), obj.id);
  } else if (event.type === 'account.updated') {
    const c = one('SELECT * FROM chefs WHERE stripe_account_id = ?', obj.id);
    if (c) await pay.refreshAccount(c).catch(() => {});
  }
  res.json({ received: true });
}

// Unpaid checkouts are dropped after an hour.
function sweepAbandoned() {
  const stale = all(`SELECT * FROM orders WHERE status = 'awaiting_payment' AND created_at < ?`, now() - 3600000);
  for (const o of stale) {
    pay.releaseHold(o).catch(() => {});
    run(`UPDATE orders SET status = 'canceled', payment_status = 'canceled', closed_at = ? WHERE id = ? AND status = 'awaiting_payment'`, now(), o.id);
  }
}

module.exports = { router, stripeWebhook, sweepAbandoned };
