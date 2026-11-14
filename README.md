# Chefy

Homemade food from verified home cooks in your neighborhood. A phone-first web app (installable on the home screen) with a real server, database, accounts and card payments.

## What's in it

**Customers**
- Landing page, browse and search dishes, cook pages with menus and reviews
- Basket (one kitchen per order), pickup or delivery, tip, note to the cook
- Pay by card or phone wallet. The card is **held** at checkout and only **charged when the cook marks the order ready**; the hold is released if the cook declines or the customer cancels before the cook starts
- Live order tracking, pickup address revealed after payment, reviews, "report a problem" (48 hours) for a refund

**Cooks**
- 4-step kitchen setup: profile and pickup address, food handler permit upload, payouts, first dish
- Kitchen is only listed after Chefy approves the permit
- Orders board (accept, mark ready, picked up, decline, refund), new-order badge and alerts
- Menu editor with photos and sold-out toggle, pause/open kitchen
- Payouts: balance, held money, standard or instant cash-out, activity log

**Chefy staff** (accounts promoted with `npm run make-admin`)
- Approve or reject permits (permit files are private), review problem reports and refund

**Money rules** (in `src/api.js` and `src/regions.js`): Chefy keeps 10% of the food subtotal plus a pickup or delivery fee ($1.49 / $3.99 in the US; each currency has its own amounts in `src/regions.js`). Tips go 100% to the cook. Prices are always computed on the server.

**Countries and currencies**: each cook picks their country in kitchen setup (about 40 countries in `src/regions.js`). Their menu, orders, Stripe account and payouts all use that country's currency, so a cook in Germany sells in EUR and one in Australia in AUD. Customers can pay from anywhere. The country locks once the cook has a Stripe account or orders.

## Run it on your computer

Needs Node.js 22.13 or newer.

```bash
npm install
npm run seed
npm start
```

Open http://localhost:3000. With no Stripe keys the app runs in **demo payments mode**: the full flow works, nothing is charged, and the card `4242 4242 4242 4242` succeeds while `4000 0000 0000 0002` is declined.

Demo accounts (password `chefy-demo-2026`): customer `alex@chefy.test`, cooks `maria@chefy.test`, `marco@chefy.test`, `sarah@chefy.test`, admin `admin@chefy.test`. Don't run `npm run seed` on a real deployment.

Tests: `npm test`. After changing styles in `public/app.js` or `public/index.html`, rebuild the CSS with `npm run build`.

## Turn on real payments (Stripe)

1. Create a Stripe account and stay in **test mode**.
2. In the dashboard, open **Connect** and finish its setup (Chefy uses Express accounts so cooks get paid directly).
3. Copy your test keys into `STRIPE_SECRET_KEY` and `STRIPE_PUBLISHABLE_KEY`, set `PUBLIC_URL` and `PLATFORM_COUNTRY` (the country your Stripe account is registered in, e.g. `US` or `GB`), restart.
4. Add a webhook endpoint `https://<your-domain>/api/stripe/webhook` with the events `payment_intent.amount_capturable_updated`, `payment_intent.canceled`, `account.updated`, and put its signing secret in `STRIPE_WEBHOOK_SECRET`.
5. Each cook finishes "Set up payouts with Stripe" in their kitchen setup before they can take orders.

How it maps to Stripe: each order is a PaymentIntent in the cook's currency with `capture_method: manual`, a destination charge to the cook's connected account, and an application fee of commission + service fee. When the cook is in a different country from `PLATFORM_COUNTRY`, the charge is made `on_behalf_of` the cook (Stripe requires this for cross-border charges), so it settles in the cook's country and shows their details on the customer's statement. "Mark ready" captures it; decline/cancel cancels it; refunds reverse the transfer and return Chefy's fee.

## Put it online

Any host that runs Node or Docker works (Render, Railway, Fly.io, a VPS). Two requirements:
- a **persistent disk** mounted at `DATA_DIR` (the SQLite database and uploaded photos live there)
- HTTPS, with `PUBLIC_URL` set to the public address

After the first deploy, sign up in the app with your own email, then make that account an admin from the server's shell (same `DATA_DIR` as the app):

```bash
npm run make-admin -- you@example.com
```

Admin access is only ever granted this way, never by signing up with a particular email.

Docker: `docker build -t chefy . && docker run -p 3000:3000 -v chefy-data:/data --env-file .env chefy`

## Known limits and next steps

- **Cross-border cooks need Stripe's go-ahead.** Whether your Stripe account can take cooks in a given country depends on where your account is registered; test-mode onboarding of a cook in that country shows quickly whether it works. South Africa, Nigeria, Kenya and Ghana aren't in the list: they need Paystack.
- The permit step still lists US states; outside the US cooks choose "Other", and staff check the document by hand.

- **Stripe mode is written but not yet run against Stripe.** It was built against Stripe's documented API; demo mode is fully tested. Run a few test-mode orders end to end before going live.
- Card holds expire after about 7 days, so orders should be accepted and finished within that window.
- Instant payouts: the 1.5% fee applies in demo mode only. With Stripe, instant payouts use Stripe's own fee and need an eligible debit card.
- Cash payments were removed: they bypass the payment hold, and the board review flagged them as the easiest way for orders to leave the platform.
- Not built yet: password reset emails, push/SMS notifications, pickup time slots, a maps-based distance filter, Terms and Privacy pages.
- Before launch, get a written answer on which foods a home kitchen in San Francisco can legally sell, and on insurance.
