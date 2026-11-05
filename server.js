const path = require('node:path');
const express = require('express');
const { DATA_DIR } = require('./src/db');
const auth = require('./src/auth');
const { router, stripeWebhook, sweepAbandoned } = require('./src/api');
const pay = require('./src/payments');
const { renderLanding } = require('./src/landing');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// Security headers
app.use((_req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(self), geolocation=(self), microphone=()',
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self' https://js.stripe.com",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self'",
      "img-src 'self' data: https:",
      "connect-src 'self' https://api.stripe.com",
      "frame-src https://js.stripe.com https://hooks.stripe.com",
      "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'"
    ].join('; ')
  });
  next();
});

// Stripe webhooks need the raw body for signature checks, so this comes before the JSON parser.
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), (req, res, next) => {
  stripeWebhook(req, res).catch(next);
});

app.use('/api', express.json({ limit: '12mb' }));

// Mutating API calls must be JSON: blocks cross-site form posts (CSRF) alongside SameSite cookies.
app.use('/api', (req, _res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !req.is('application/json')) {
    return next(new auth.HttpError(415, 'Send JSON.'));
  }
  next();
});

app.use(auth.parseCookies, auth.loadUser);
app.use('/api', router);
app.use('/api', (_req, _res, next) => next(new auth.HttpError(404, 'Not found.')));

app.use('/uploads', express.static(path.join(DATA_DIR, 'uploads', 'public'), { maxAge: '30d', immutable: true }));
app.use('/vendor/fonts', express.static(path.join(__dirname, 'node_modules', '@fontsource'), { maxAge: '30d' }));
app.use('/vendor/fa', express.static(path.join(__dirname, 'node_modules', '@fortawesome', 'fontawesome-free'), { maxAge: '30d' }));
// The home page is rendered from the live menu; the app lives at /app.
app.get('/', (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.type('html').send(renderLanding({ paymentsMode: pay.MODE }));
});
const sendApp = (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html'));
app.get(['/app', '/app/'], sendApp);
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', index: false }));
app.get('/{*splat}', (_req, res) => res.redirect(302, '/'));

// Errors: friendly message for expected ones, generic for the rest.
app.use((err, _req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  const message = status >= 500 && !(err instanceof auth.HttpError)
    ? 'Something went wrong on our side. Try again in a moment.'
    : (err.type === 'entity.too.large' ? 'That file is too big.' : err.message);
  res.status(status).json({ error: message });
});

setInterval(sweepAbandoned, 10 * 60000).unref();

const port = Number(process.env.PORT || 3000);
if (require.main === module) {
  app.listen(port, () => {
    console.log(`Chefy running on http://localhost:${port}  (payments: ${pay.MODE}${pay.MODE === 'demo' ? ', no real charges' : ''})`);
  });
}

module.exports = app;
