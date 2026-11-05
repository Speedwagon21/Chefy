// Accounts and sessions: scrypt password hashes, random session tokens stored hashed.
const crypto = require('node:crypto');
const { one, run } = require('./db');

const SESSION_DAYS = 30;
const COOKIE = 'chefy_sid';
const SECURE_COOKIES = process.env.NODE_ENV === 'production' || /^https:/.test(process.env.PUBLIC_URL || '');

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltB64, keyB64] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const key = Buffer.from(keyB64, 'base64');
  const test = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), key.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(key, test);
}

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = Date.now() + SESSION_DAYS * 86400000;
  run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', sha256(token), userId, expires);
  res.cookie(COOKIE, token, {
    httpOnly: true, sameSite: 'lax', secure: SECURE_COOKIES, maxAge: SESSION_DAYS * 86400000, path: '/'
  });
}

function destroySession(req, res) {
  const token = req.cookies[COOKIE];
  if (token) run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
  res.clearCookie(COOKIE, { path: '/' });
}

// Minimal cookie parser (avoids another dependency)
function parseCookies(req, _res, next) {
  req.cookies = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) req.cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  next();
}

function loadUser(req, _res, next) {
  req.user = null;
  const token = req.cookies[COOKIE];
  if (token) {
    const row = one(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
                     WHERE s.token_hash = ? AND s.expires_at > ?`, sha256(token), Date.now());
    if (row) {
      req.user = row;
      req.chef = one('SELECT * FROM chefs WHERE user_id = ?', row.id) || null;
    }
  }
  next();
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const requireUser = (req, _res, next) => req.user ? next() : next(new HttpError(401, 'Please sign in first.'));
const requireChef = (req, _res, next) => req.chef ? next() : next(new HttpError(403, 'Set up your kitchen first.'));
const requireAdmin = (req, _res, next) => req.user?.is_admin ? next() : next(new HttpError(403, 'Admins only.'));

// Simple in-memory limiter for sign-in / sign-up attempts
const attempts = new Map();
function rateLimit(key, max = 10, windowMs = 15 * 60000) {
  const now = Date.now();
  const rec = attempts.get(key) || { n: 0, reset: now + windowMs };
  if (now > rec.reset) { rec.n = 0; rec.reset = now + windowMs; }
  rec.n += 1;
  attempts.set(key, rec);
  if (rec.n > max) throw new HttpError(429, 'Too many attempts. Wait a few minutes and try again.');
}


module.exports = {
  hashPassword, verifyPassword, createSession, destroySession, parseCookies, loadUser,
  requireUser, requireChef, requireAdmin, rateLimit, HttpError
};
