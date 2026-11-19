// The public home page, rendered on the server from the live menu, so it works with scripting off
// and never shows a dish, price or count that isn't real.
const { all } = require('./db');

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = c => '$' + (c / 100).toFixed(2);
const prep = t => String(t || '').replace(/(\d)\s*[\u2013\u2014-]\s*(\d)/g, '$1 to $2');

// Live dishes from cooks whose permit is checked and who are taking orders; most ordered first.
function liveDishes(paymentsMode) {
  const rows = all(`
    SELECT d.id, d.title, d.price_cents, d.prep_time, d.description, d.image_url, d.categories, d.category,
           c.user_id AS chef_id, c.kitchen_name, c.neighborhood, c.charges_enabled,
           (SELECT COALESCE(SUM(oi.qty), 0) FROM order_items oi JOIN orders o ON o.id = oi.order_id
             WHERE oi.dish_id = d.id AND o.payment_status IN ('authorized', 'captured')) AS sold
    FROM dishes d JOIN chefs c ON c.user_id = d.chef_id
    WHERE d.deleted = 0 AND d.available = 1 AND c.permit_status = 'verified' AND c.accepting_orders = 1
    ORDER BY sold DESC, (d.image_url IS NOT NULL) DESC, d.created_at DESC`);
  return rows.filter(r => paymentsMode === 'demo' || r.charges_enabled);
}

function img(d, cls, { eager = false, sizes = '100vw' } = {}) {
  if (!d.image_url) return `<div class="${cls} photo-empty" role="img" aria-label="${esc(d.title)}"></div>`;
  const src = d.image_url.replace(/w=\d+/, 'w=1200');
  return `<img class="${cls}" src="${esc(src)}" alt="${esc(d.title)}" width="1200" height="900" sizes="${sizes}" ${eager ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async">`;
}

function render({ paymentsMode }) {
  const dishes = liveDishes(paymentsMode);
  const lead = dishes[0];
  const kitchens = new Set(dishes.map(d => d.chef_id)).size;
  const usesStock = dishes.some(d => /images\.unsplash\.com/.test(d.image_url || ''));
  const appLink = (hash, text, cls) => `<a class="${cls}" href="/app#/${hash}">${text}</a>`;

  const offer = lead ? `
        <figure class="offer">
          <a class="offer-photo" href="/app#/chef/${lead.chef_id}" aria-label="${esc(lead.title)} from ${esc(lead.kitchen_name)}">${img(lead, 'photo', { eager: true, sizes: '(min-width: 60rem) 56vw, 100vw' })}</a>
          <figcaption class="offer-card">
            <div class="offer-text">
              <p class="offer-title">${esc(lead.title)}</p>
              <p class="offer-meta"><span>${esc(lead.kitchen_name)}</span>${lead.neighborhood ? `<span>${esc(lead.neighborhood)}</span>` : ''}${lead.prep_time ? `<span>Ready in ${esc(prep(lead.prep_time))}</span>` : ''}</p>
            </div>
            <p class="offer-price">${money(lead.price_cents)}</p>
            ${appLink(`chef/${lead.chef_id}`, 'Order this dish', 'btn btn-primary offer-action')}
          </figcaption>
        </figure>` : `
        <div class="offer offer-none">
          <p class="offer-title">The first kitchens are opening.</p>
          <p>Cooks are sending their permits for review. Check back this week, or open a kitchen of your own.</p>
        </div>`;

  const rail = dishes.length ? `
  <section class="section rail-section" aria-labelledby="menu-head">
    <div class="container head-row">
      <h2 id="menu-head">On the stove today</h2>
      <div class="rail-side">
        <p class="lead">${dishes.length} dish${dishes.length === 1 ? '' : 'es'} from ${kitchens} kitchen${kitchens === 1 ? '' : 's'}, ready to order now.</p>
        <div class="rail-controls">
          <a class="btn btn-text" href="/app#/">See every dish</a>
          <button type="button" class="rail-btn" data-rail="-1" aria-label="Previous dishes" hidden><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
          <button type="button" class="rail-btn" data-rail="1" aria-label="Next dishes" hidden><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        </div>
      </div>
    </div>
    <div class="rail" role="region" aria-label="Today's dishes, scroll sideways" tabindex="0">
      <ul class="rail-track">
        ${dishes.map(d => `
        <li class="dish">
          <a href="/app#/chef/${d.chef_id}" class="dish-link">
            ${img(d, 'photo dish-photo', { sizes: '(min-width: 60rem) 22rem, 70vw' })}
            <span class="dish-title">${esc(d.title)}</span>
            <span class="dish-meta"><span>${esc(d.kitchen_name)}</span></span>
            <span class="dish-price">${money(d.price_cents)}</span>
          </a>
        </li>`).join('')}
      </ul>
    </div>
  </section>` : '';

  const closeup = dishes[1] || lead;
  const showcase = closeup ? `
  <section class="section showcase" aria-labelledby="close-head">
    <div class="container">
      <div class="head-row">
        <h2 id="close-head">From a checked home kitchen</h2>
        <p class="lead">Small batches from home kitchens, cooked when the order comes in.</p>
      </div>
      <figure class="showcase-figure">
        ${img(closeup, 'photo showcase-photo', { sizes: '(min-width: 90rem) 1312px, 100vw' })}
        <figcaption>${esc(closeup.title)}, from ${esc(closeup.kitchen_name)}</figcaption>
      </figure>
    </div>
  </section>` : '';

  const close = lead ? `
  <section class="section closer" aria-labelledby="closer-head">
    <div class="container closer-grid">
      <div>
        <h2 id="closer-head" class="closer-head">If it's wrong, you get your money back.</h2>
        <p class="lead">Report a problem within 48 hours of your order being ready. Chefy reviews every report and refunds in full.</p>
      </div>
      <div class="closer-actions">
        ${appLink('', 'See what\'s cooking', 'btn btn-primary')}
      </div>
    </div>
  </section>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>Chefy: homemade food from your neighbors</title>
  <meta name="description" content="Order homemade food from cooks in your neighborhood. Every cook's food handler permit is checked, and your card is only charged when the food is ready.">
  <meta name="theme-color" content="#fcfdff">
  <link rel="manifest" href="/manifest.webmanifest">
  <link rel="icon" href="/icon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/icon.svg">
  <link rel="stylesheet" href="/vendor/fonts/inter/latin-400.css">
  <link rel="stylesheet" href="/vendor/fonts/inter/latin-600.css">
  <link rel="stylesheet" href="/vendor/fonts/inter/latin-900.css">
  <link rel="stylesheet" href="/vendor/fonts/bricolage-grotesque/latin-700.css">
  <link rel="stylesheet" href="/landing.css">
  ${lead && lead.image_url ? `<link rel="preload" as="image" href="${esc(lead.image_url.replace(/w=\d+/, 'w=1200'))}">` : ''}
  <script src="/landing.js" defer></script>
</head>
<body>
  <a class="skip" href="#main">Skip to content</a>
  <header class="nav">
    <div class="container nav-row">
      <a class="brand" href="/" aria-label="Chefy home"><img src="/logo.svg" alt="" width="46" height="40"><span class="wordmark">Chefy</span></a>
      <nav aria-label="Main">
        <a class="nav-link" href="#cooks">For cooks</a>
        <a class="nav-link" href="/app#/account">Sign in</a>
        <a class="btn btn-quiet btn-sm" href="/app#/">Order food</a>
      </nav>
    </div>
  </header>

  <main id="main">
  <section class="hero" aria-labelledby="hero-head">
    <div class="container hero-grid">
      <div class="hero-text">
        <h1 id="hero-head">Dinner from<br> the kitchen<br> down the street.</h1>
        <p class="lead">Neighbors cook, Chefy checks permits, you pay when it's ready.</p>
        <div class="actions">
          <a class="btn btn-quiet" href="/app#/">See what's cooking</a>
          <a class="btn btn-text" href="/app#/kitchen/setup?step=1">Open your kitchen</a>
        </div>
      </div>
      ${offer}
    </div>
  </section>

  <section class="section how" id="how" aria-labelledby="how-head">
    <div class="container how-grid">
      <h2 id="how-head" class="how-head">How an order works</h2>
      <div class="how-visual" aria-hidden="true">
        <div class="ticket" data-step="1">
          <div class="ticket-head">
            <p class="ticket-kitchen">${esc(lead ? lead.kitchen_name : 'Your cook')}</p>
            <p class="ticket-status">
              <span class="s s1">Waiting for the cook</span><span class="s s2">Cooking now</span><span class="s s3">Ready for pickup</span><span class="s s4">Picked up</span>
            </p>
          </div>
          <ol class="ticket-steps"><li>Placed</li><li>Cooking</li><li>Ready</li><li>Picked up</li></ol>
          <div class="ticket-pay">
            <p>${esc(lead ? lead.title : 'Your order')}</p>
            <p class="ticket-amount">${lead ? money(lead.price_cents) : ''}</p>
            <p class="ticket-card"><span class="c c1">Card held, not charged</span><span class="c c2">Card held, not charged</span><span class="c c3">Charged now it's ready</span><span class="c c4">Charged</span></p>
          </div>
        </div>
      </div>
        <ol class="panels">
          <li class="panel" data-step="1"><h3>Order ahead</h3><p>Pick a dish from a cook near you. Your card is held, not charged.</p></li>
          <li class="panel" data-step="2"><h3>The cook says yes</h3><p>They start cooking and you can follow along. If they can't make it, the hold is released.</p></li>
          <li class="panel" data-step="3"><h3>Charged when it's ready</h3><p>You pay only once the cook marks your food ready. The pickup address appears after you've paid.</p></li>
          <li class="panel" data-step="4"><h3>Pick it up warm</h3><p>Collect it at the cook's door at the time they set, or have it delivered where they offer it.</p></li>
        </ol>
    </div>
  </section>
${showcase}
  <section class="section cooks" id="cooks" aria-labelledby="cooks-head">
    <div class="container">
      <div class="head-row">
        <h2 id="cooks-head">Get your permit checked, then cook.</h2>
        <p class="lead">Sell what you already make, nearby.</p>
      </div>
      <ol class="setup" aria-label="Four steps to open a kitchen">
        <li><h3>Your kitchen</h3><p>Name, story, pickup address.</p></li>
        <li><h3>Food handler permit</h3><p>Checked by hand.</p></li>
        <li><h3>Get paid</h3><p>Your bank, in 1 to 2 days.</p></li>
        <li><h3>First dish</h3><p>A photo, a price, a few words.</p></li>
      </ol>
      <div class="cooks-foot">
        <dl class="facts">
          <div><dt>Your menu</dt><dd>You set the prices.</dd></div>
          <div><dt>Card held first</dt><dd>Before you cook.</dd></div>
          <div><dt>10% to Chefy</dt><dd>Tips go to you.</dd></div>
        </dl>
        <a class="btn btn-primary" href="/app#/kitchen/setup?step=1">Open your kitchen</a>
      </div>
    </div>
  </section>
${rail}
${close}
  </main>

  <footer class="footer">
    <div class="container">
      <p class="footer-mark"><img src="/logo.svg" alt="" width="92" height="80"><span class="wordmark">Chefy</span></p>
      <nav class="footer-links" aria-label="Footer">
        <a href="/app#/">Order food</a>
        <a href="/app#/kitchen/setup?step=1">Open your kitchen</a>
        <a href="#how">How an order works</a>
        <a href="/app#/account">Sign in</a>
      </nav>
      ${usesStock ? '<p class="footer-legal">Some dish photos are demo images from Unsplash.</p>' : ''}
    </div>
  </footer>
</body>
</html>`;
}

module.exports = { renderLanding: render };
