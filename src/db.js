// SQLite database (Node's built-in driver). One file, no server to run.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
fs.mkdirSync(path.join(DATA_DIR, 'uploads', 'public'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'uploads', 'private'), { recursive: true });

const db = new DatabaseSync(process.env.DB_FILE || path.join(DATA_DIR, 'chefy.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  neighborhood TEXT,
  phone TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chefs (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  kitchen_name TEXT NOT NULL,
  bio TEXT NOT NULL DEFAULT '',
  cuisine TEXT NOT NULL DEFAULT '',
  neighborhood TEXT NOT NULL DEFAULT '',
  pickup_address TEXT NOT NULL DEFAULT '',
  pickup_notes TEXT NOT NULL DEFAULT '',
  avatar_url TEXT,
  cover_url TEXT,
  offers_delivery INTEGER NOT NULL DEFAULT 0,
  accepting_orders INTEGER NOT NULL DEFAULT 1,
  permit_state TEXT,
  permit_number TEXT,
  permit_expiry TEXT,
  permit_file TEXT,
  permit_status TEXT NOT NULL DEFAULT 'none',
  permit_note TEXT,
  stripe_account_id TEXT,
  charges_enabled INTEGER NOT NULL DEFAULT 0,
  payout_bank_label TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS dishes (
  id INTEGER PRIMARY KEY,
  chef_id INTEGER NOT NULL REFERENCES chefs(user_id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  prep_time TEXT NOT NULL DEFAULT '',
  dietary TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  image_url TEXT,
  available INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  eater_id INTEGER NOT NULL REFERENCES users(id),
  chef_id INTEGER NOT NULL REFERENCES chefs(user_id),
  status TEXT NOT NULL,
  fulfillment TEXT NOT NULL,
  delivery_address TEXT,
  notes TEXT,
  subtotal_cents INTEGER NOT NULL,
  fee_cents INTEGER NOT NULL,
  tip_cents INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  commission_cents INTEGER NOT NULL,
  chef_payout_cents INTEGER NOT NULL,
  payment_provider TEXT NOT NULL,
  payment_intent_id TEXT,
  payment_status TEXT NOT NULL DEFAULT 'pending',
  card_label TEXT,
  refund_cents INTEGER NOT NULL DEFAULT 0,
  issue_reason TEXT,
  issue_status TEXT,
  created_at INTEGER NOT NULL,
  authorized_at INTEGER,
  accepted_at INTEGER,
  ready_at INTEGER,
  completed_at INTEGER,
  closed_at INTEGER,
  captured_at INTEGER,
  refunded_at INTEGER
);
CREATE INDEX IF NOT EXISTS orders_eater ON orders(eater_id, created_at);
CREATE INDEX IF NOT EXISTS orders_chef ON orders(chef_id, created_at);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  dish_id INTEGER NOT NULL REFERENCES dishes(id),
  title TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  qty INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id),
  eater_id INTEGER NOT NULL REFERENCES users(id),
  chef_id INTEGER NOT NULL REFERENCES chefs(user_id),
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  text TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS payouts (
  id INTEGER PRIMARY KEY,
  chef_id INTEGER NOT NULL REFERENCES chefs(user_id),
  amount_cents INTEGER NOT NULL,
  fee_cents INTEGER NOT NULL DEFAULT 0,
  instant INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  provider_id TEXT,
  destination TEXT,
  arrives_at INTEGER,
  created_at INTEGER NOT NULL
);
`);

// Small helpers so route code stays readable
const one = (sql, ...p) => db.prepare(sql).get(...p);
const all = (sql, ...p) => db.prepare(sql).all(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = { db, one, all, run, tx, DATA_DIR };
