'use strict';
/* Chefy phone app. Talks to the Chefy API; every piece of user-entered text is escaped with esc(). */

// ============ utilities ============
const $ = (s, r = document) => r.querySelector(s);
const view = $('#view');
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = c => (c < 0 ? '−$' : '$') + (Math.abs(c || 0) / 100).toFixed(2);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } }
};

class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method, credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch { throw new ApiError(0, 'You seem to be offline. Check your connection and try again.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || 'Something went wrong. Try again.');
  return data;
}

function toast(msg) {
  const t = $('#toast');
  $('#toastText').textContent = msg;
  t.classList.remove('hidden'); t.classList.add('flex');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.classList.add('hidden'); t.classList.remove('flex'); }, 2800);
}

function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
const clock = ts => new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const initials = n => esc(String(n || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase());

function avatar(url, name, cls = 'w-10 h-10 rounded-xl') {
  return url
    ? `<img src="${esc(url)}" alt="" class="${cls} object-cover bg-slate-100 shrink-0">`
    : `<span class="${cls} shrink-0 bg-brand-100 text-brand-700 font-black text-sm flex items-center justify-center" aria-hidden="true">${initials(name)}</span>`;
}
function dishImg(url, cls) {
  return url
    ? `<img src="${esc(url)}" alt="" loading="lazy" class="${cls} object-cover bg-slate-100">`
    : `<div class="${cls} bg-gradient-to-br from-slate-100 to-brand-100 flex items-center justify-center text-brand-500 text-2xl" aria-hidden="true"><i class="fa-solid fa-bowl-food"></i></div>`;
}
function stars(avg, count) {
  if (!count) return '<span class="text-slate-500">New</span>';
  return `<i class="fa-solid fa-star text-amber-400" aria-hidden="true"></i> ${avg.toFixed(1)} <span class="text-slate-500">(${count})</span>`;
}
function setBusy(btn, busy, label) {
  if (!btn) return;
  if (busy) { btn.dataset.label = btn.innerHTML; btn.disabled = true; btn.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin" aria-hidden="true"></i> ${esc(label || 'Working…')}`; }
  else { btn.disabled = false; if (btn.dataset.label) btn.innerHTML = btn.dataset.label; }
}
function showError(form, msg) {
  const box = form?.querySelector('[data-error]');
  if (!box) { toast(msg); return; }
  box.innerHTML = `<i class="fa-solid fa-circle-exclamation mt-0.5" aria-hidden="true"></i><span>${esc(msg)}</span>`;
  box.classList.remove('hidden');
}
const meta = (parts, cls = '') => `<span class="inline-flex flex-wrap items-baseline gap-x-3 gap-y-0.5 ${cls}">${parts.filter(Boolean).map(p => `<span>${p}</span>`).join('')}</span>`;
const errorBox = () => `<div data-error role="alert" class="hidden p-3 bg-rose-50 border border-rose-200 text-rose-700 rounded-xl text-xs font-semibold flex items-start gap-2"></div>`;
const formValues = f => Object.fromEntries(new FormData(f).entries());

// ============ state ============
const S = {
  config: null,
  me: { user: null, chef: null },
  dishes: null,
  basket: store.get('chefy_basket', null) || emptyBasket(),
  afterAuth: null,
  pendingOrder: null,
  stripe: null,
  kitchenSeen: new Set(store.get('chefy_kitchen_seen', []))
};
function emptyBasket() { return { chefId: null, chefName: '', offersDelivery: false, items: {}, fulfillment: 'pickup', tip: 15, address: '', notes: '' }; }
function saveBasket() { store.set('chefy_basket', S.basket); updateBasketBar(); }
const basketLines = () => Object.entries(S.basket.items).map(([id, it]) => ({ dishId: Number(id), ...it }));
const basketCount = () => basketLines().reduce((s, l) => s + l.qty, 0);
function basketTotals() {
  const subtotal = basketLines().reduce((s, l) => s + l.price * l.qty, 0);
  const fee = S.config?.fees?.[S.basket.fulfillment] ?? 149;
  const tip = Math.round(subtotal * S.basket.tip / 100);
  return { subtotal, fee, tip, total: subtotal + fee + tip };
}

// ============ routing ============
function route() {
  const h = location.hash.slice(1) || '/';
  const [p, q] = h.split('?');
  return { parts: p.split('/').filter(Boolean), query: new URLSearchParams(q || '') };
}
const go = hash => { if (location.hash === hash) render(); else location.hash = hash; };

let renderSeq = 0;
async function render() {
  const seq = ++renderSeq;
  closeSheet(true);
  const { parts, query } = route();
  const top = parts[0] || '';
  const navKey = { '': 'eat', chef: 'eat', welcome: 'eat', orders: 'orders', saved: 'saved', kitchen: 'kitchen', account: 'account', admin: 'account' }[top] || 'eat';
  document.querySelectorAll('[data-nav]').forEach(a => a.setAttribute('aria-current', a.dataset.nav === navKey ? 'page' : 'false'));
  setHeader();
  try {
    if (!top && !S.me.user && !store.get('chefy_seen_welcome', false)) return go('#/welcome');
    const views = {
      '': () => eatView(query), welcome: welcomeView, chef: () => chefView(parts[1]),
      orders: () => parts[1] ? orderView(parts[1], query) : ordersView(),
      kitchen: () => parts[1] === 'setup' ? setupView(query) : kitchenView(query),
      saved: savedView, account: accountView, admin: adminView
    };
    await (views[top] || notFoundView)();
  } catch (e) {
    if (seq !== renderSeq) return;
    view.innerHTML = stateCard('fa-plug-circle-xmark', 'We couldn\'t load this', esc(e.message), `<button data-act="reload" class="btn-dark mt-4">Try again</button>`);
  }
  if (seq === renderSeq) updateBasketBar();
}

function setHeader() {
  const n = basketCount(), u = S.me.user;
  $('#headerRight').innerHTML = `
    ${n ? `<button data-act="open-basket" class="relative w-12 h-12 rounded-full bg-slate-100 hover:bg-slate-200 text-slate-900 flex items-center justify-center" aria-label="Basket, ${n} item${n === 1 ? '' : 's'}">
      <i class="fa-solid fa-basket-shopping text-lg" aria-hidden="true"></i>
      <span class="absolute -top-0.5 -right-0.5 min-w-[1.3rem] h-[1.3rem] px-1 bg-brand-600 text-white text-xs font-bold rounded-full flex items-center justify-center ring-2 ring-white">${n}</span></button>` : ''}
    <a href="#/account" class="w-12 h-12 lg:w-14 lg:h-14 rounded-full flex items-center justify-center ${u ? 'bg-slate-900 text-white' : 'bg-slate-100 hover:bg-slate-200 text-slate-900'}" aria-label="${u ? 'Your account' : 'Sign in'}">
      ${u ? `<span class="text-sm font-black">${initials(u.name)}</span>` : '<i class="fa-solid fa-user text-xl" aria-hidden="true"></i>'}</a>`;
  const fab = $('#fab');
  const chef = !!S.me.chef;
  fab.setAttribute('aria-label', chef ? 'Add a dish to your menu' : `Basket, ${n} item${n === 1 ? '' : 's'}`);
  const badge = $('#fabBadge');
  badge.textContent = n;
  badge.classList.toggle('hidden', chef || !n); badge.classList.toggle('flex', !chef && !!n);
}

function updateBasketBar() {
  const { parts } = route();
  const onShop = !parts[0] || parts[0] === 'chef' || parts[0] === 'saved';
  const n = basketCount();
  const bar = $('#basketBar');
  bar.classList.toggle('hidden', !(onShop && n > 0) || !!$('#sheetRoot').firstChild);
  $('#basketBarCount').textContent = n;
  $('#basketBarTotal').textContent = money(basketTotals().subtotal);
  setHeader();
}

const stateCard = (icon, title, body, extra = '') => `
  <div class="card p-6 text-center space-y-2 mt-2 lg:max-w-lg lg:mx-auto lg:p-10">
    <div class="w-14 h-14 mx-auto rounded-2xl bg-brand-50 text-brand-600 flex items-center justify-center text-2xl"><i class="fa-solid ${icon}" aria-hidden="true"></i></div>
    <h2 class="text-base font-bold text-slate-900">${title}</h2>
    <p class="text-sm text-slate-500">${body}</p>${extra}
  </div>`;
const skeletonList = n => Array.from({ length: n }, () => `<div class="card p-3 flex gap-3 lg:min-h-[8.5rem]"><div class="skeleton w-28 h-28"></div><div class="flex-1 space-y-2 py-1"><div class="skeleton h-3 w-1/2"></div><div class="skeleton h-4 w-5/6"></div><div class="skeleton h-3 w-2/3"></div></div></div>`).join('');

// ============ sheets ============
let lastFocus = null;
function openSheet(html, label, onClose) {
  lastFocus = document.activeElement;
  $('#sheetRoot').innerHTML = `<div class="sheet-backdrop" data-act="close-sheet"></div>
    <div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(label)}">${html}</div>`;
  S.onSheetClose = onClose || null;
  document.body.style.overflow = 'hidden';
  $('#basketBar').classList.add('hidden');
  const first = $('.sheet [autofocus]') || $('.sheet button, .sheet input');
  if (first && matchMedia('(pointer: fine)').matches) first.focus();
}
function closeSheet(silent) {
  if (!$('#sheetRoot').firstChild) return;
  $('#sheetRoot').innerHTML = '';
  document.body.style.overflow = '';
  const cb = S.onSheetClose; S.onSheetClose = null;
  if (cb) cb();
  if (!silent) { updateBasketBar(); lastFocus?.focus?.(); }
}
const sheetHeader = (title, sub = '') => `
  <div class="px-5 pt-4 pb-3 flex items-start justify-between gap-3 border-b border-slate-100">
    <div><h2 class="text-lg font-bold text-slate-900">${title}</h2>${sub ? `<p class="text-xs text-slate-500 mt-0.5">${sub}</p>` : ''}</div>
    <button data-act="close-sheet" class="w-11 h-11 -mr-2 -mt-1 rounded-xl text-slate-500 flex items-center justify-center" aria-label="Close"><i class="fa-solid fa-xmark text-lg" aria-hidden="true"></i></button>
  </div>`;
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });

// ============ auth ============
function requireAuth(then, reason) {
  if (S.me.user) return then();
  S.afterAuth = then;
  openAuthSheet(reason);
}
function authForms(mode = 'signup', reason = '') {
  const signup = mode === 'signup';
  return `
    ${reason ? `<p class="text-sm text-slate-600 mb-3">${esc(reason)}</p>` : ''}
    <div class="grid grid-cols-2 p-1 bg-slate-100 rounded-xl text-sm font-bold mb-4" role="tablist">
      <button role="tab" aria-selected="${signup}" data-act="auth-mode" data-mode="signup" class="py-2.5 rounded-lg ${signup ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500'}">Create account</button>
      <button role="tab" aria-selected="${!signup}" data-act="auth-mode" data-mode="login" class="py-2.5 rounded-lg ${!signup ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500'}">Sign in</button>
    </div>
    <form data-form="${signup ? 'signup' : 'login'}" class="space-y-3" novalidate>
      ${signup ? `<div><label class="label" for="aName">Your name</label><input id="aName" name="name" autocomplete="name" required class="field" placeholder="First and last name"></div>` : ''}
      <div><label class="label" for="aEmail">Email</label><input id="aEmail" name="email" type="email" autocomplete="email" inputmode="email" required class="field" placeholder="you@example.com"></div>
      <div><label class="label" for="aPass">Password</label><input id="aPass" name="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" required minlength="8" class="field" placeholder="${signup ? 'At least 8 characters' : 'Your password'}"></div>
      ${signup ? `<div><label class="label" for="aHood">Neighborhood <span class="font-normal text-slate-500">(optional)</span></label><input id="aHood" name="neighborhood" autocomplete="address-level3" class="field" placeholder="e.g. Mission District"></div>` : ''}
      ${errorBox()}
      <button class="btn-primary" type="submit">${signup ? 'Create account' : 'Sign in'}</button>
      ${signup ? `<p class="text-xs text-slate-500 text-center">By creating an account you agree to Chefy's terms and privacy policy.</p>` : ''}
    </form>`;
}
function openAuthSheet(reason, mode = 'signup') {
  openSheet(`${sheetHeader(mode === 'signup' ? 'Join Chefy' : 'Welcome back')}<div class="p-5" id="authBody">${authForms(mode, reason)}</div>`, 'Sign in or create an account', () => { S.afterAuth = null; });
  S.authReason = reason;
}
async function afterSignedIn(me, isNew) {
  S.me = me;
  const then = S.afterAuth; S.afterAuth = null;
  S.onSheetClose = null;
  closeSheet(true);
  if (then) then(); else render();
}

// ============ landing ============
async function welcomeView() {
  view.innerHTML = `
  <section class="space-y-6">
    <div class="relative -mx-4 -mt-4 px-5 pt-8 pb-10 md:mx-0 md:mt-0 md:rounded-3xl md:px-10 md:py-14 lg:px-14 lg:py-20 bg-slate-950 text-white overflow-hidden">
      <img src="https://images.unsplash.com/photo-1565299585323-38d6b0865b47?w=1400&auto=format&fit=crop&q=75" alt="" class="absolute inset-y-0 right-0 w-full lg:w-3/5 h-full object-cover opacity-35 lg:opacity-100">
      <div class="absolute inset-0 bg-gradient-to-r from-slate-950 from-30% via-slate-950/85 to-slate-950/30" aria-hidden="true"></div>
      <div class="relative space-y-4 lg:space-y-6 lg:max-w-2xl">
        <h1 class="text-[2rem] lg:text-6xl leading-[1.1] font-black tracking-tight">Dinner from the kitchen<br> down the street.</h1>
        <p class="text-sm lg:text-lg text-slate-200 leading-relaxed lg:max-w-xl">Tamales, birria, fresh bread and cookies made by home cooks in your neighborhood. Order ahead, pick up warm.</p>
        <div class="flex flex-col lg:flex-row gap-2.5 lg:gap-3 pt-1">
          <button data-act="welcome-browse" class="py-3.5 lg:px-8 bg-brand-600 hover:bg-brand-700 rounded-full font-bold text-sm shadow-lg">See what's cooking nearby</button>
          <button data-act="welcome-signup" class="py-3.5 lg:px-8 hover:bg-white/20 bg-white/10 border border-white/25 rounded-full font-bold text-sm">Create a free account</button>
        </div>
        <p class="text-sm text-slate-200"><i class="fa-solid fa-shield-halved text-emerald-300" aria-hidden="true"></i> Every cook's food handler permit is checked by Chefy.</p>
      </div>
    </div>

    <div>
      <h2 class="text-lg lg:text-2xl font-black text-slate-900">How ordering works</h2>
      <ol class="mt-3 lg:mt-5 space-y-3 lg:space-y-0 lg:grid lg:grid-cols-3 lg:gap-5">
        ${[['fa-magnifying-glass', 'Pick a dish', 'Browse today\'s menus from verified cooks near you. Every listing shows the cook, the price and how long it takes.'],
           ['fa-lock', 'Pay safely', 'Your card is only held when you order. You\'re charged when the cook marks your food ready, and released if they can\'t make it.'],
           ['fa-person-walking', 'Pick it up warm', 'You get the pickup address and instructions once you\'ve paid. Some cooks also deliver.']]
          .map(([icon, t, b], i) => `<li class="card p-4 lg:p-6 flex gap-3 lg:flex-col"><span class="w-10 h-10 rounded-xl bg-brand-50 text-brand-600 flex items-center justify-center shrink-0"><i class="fa-solid ${icon}" aria-hidden="true"></i></span>
            <div><p class="text-sm font-bold text-slate-900">${i + 1}. ${t}</p><p class="text-xs text-slate-600 mt-0.5 leading-relaxed">${b}</p></div></li>`).join('')}
      </ol>
    </div>

    <div class="space-y-6 lg:space-y-0 lg:grid lg:grid-cols-2 lg:gap-6">
    <div class="card p-5 lg:p-8 space-y-3 border-emerald-200 bg-emerald-50/60">
      <h2 class="text-base font-black text-emerald-950"><i class="fa-solid fa-hand-holding-heart text-emerald-600 mr-1" aria-hidden="true"></i> If something's wrong, you get your money back</h2>
      <p class="text-xs text-emerald-900 leading-relaxed">Report a problem within 48 hours of your order being ready. Chefy reviews it and refunds you in full when the food was wrong, missing or not safe to eat.</p>
    </div>

    <div class="rounded-3xl p-5 lg:p-8 bg-slate-900 text-white space-y-3">
      <p class="chip bg-white/10 text-brand-200">For home cooks</p>
      <h2 class="text-xl font-black leading-tight">Sell your cooking to neighbors, legally.</h2>
      <ul class="text-xs text-slate-300 space-y-1.5">
        <li><i class="fa-solid fa-check text-emerald-400 mr-1.5" aria-hidden="true"></i> You set the menu, the prices and when you're open</li>
        <li><i class="fa-solid fa-check text-emerald-400 mr-1.5" aria-hidden="true"></i> Customers pay upfront; the money's held before you start cooking</li>
        <li><i class="fa-solid fa-check text-emerald-400 mr-1.5" aria-hidden="true"></i> Chefy keeps 10% of food sales. Tips are 100% yours</li>
      </ul>
      <button data-act="start-cooking" class="w-full lg:w-auto lg:px-8 py-3.5 bg-white hover:bg-slate-100 text-slate-900 rounded-xl font-bold text-sm">Open your kitchen</button>
    </div>
    </div>
    <p class="text-center text-sm text-slate-500 pb-2">Homemade food from your neighbors.</p>
  </section>`;
}

// ============ eat ============
const CAT_ICONS = { All: 'fa-border-all', 'Quick Meals': 'fa-bolt', Healthy: 'fa-heart', 'High Protein': 'fa-dumbbell', Desserts: 'fa-ice-cream', 'Comfort Food': 'fa-bell-concierge', Breakfast: 'fa-mug-hot', 'Street Food': 'fa-pepper-hot', 'Baked Goods': 'fa-bread-slice', Other: 'fa-utensils' };
const dishCats = d => d.categories || [d.category];
const SORTS = { popular: 'Most popular', rating: 'Top rated', price: 'Lowest price', quick: 'Quickest' };
const DEFAULT_FILTERS = { sort: 'popular', dietary: '', availableOnly: false };
S.filters = { ...DEFAULT_FILTERS, ...store.get('chefy_filters', {}) };
const filtersActive = () => S.filters.sort !== 'popular' || !!S.filters.dietary || S.filters.availableOnly;
const prepMinutes = d => { const m = /\d+/.exec(d.prepTime || ''); return m ? Number(m[0]) : 999; };
const seeAll = id => `<button ${id ? `id="${id}"` : ''} data-act="${id === 'seeAllBtn' ? 'see-all' : 'filters'}" class="text-sm font-bold text-brand-600 hover:text-brand-700 h-11 flex items-center">See all</button>`;
const skeletonCards = n => Array.from({ length: n }, () => `<div class="card overflow-hidden"><div class="skeleton aspect-[4/3] rounded-none"></div><div class="p-3 space-y-2"><div class="skeleton h-4 w-5/6"></div><div class="skeleton h-3 w-2/3"></div><div class="skeleton h-6 w-12"></div></div></div>`).join('');
const cardGrid = 'grid grid-cols-2 gap-3 md:grid-cols-3 md:gap-4 xl:grid-cols-4 lg:gap-5';

async function loadDishes(force) {
  if (!S.dishes || force) S.dishes = (await api('/api/dishes')).dishes;
  return S.dishes;
}
async function eatView(query) {
  const cat = query.get('cat') || 'All';
  view.innerHTML = `
    <section class="space-y-7 lg:space-y-10">
      <div class="flex items-center gap-3">
        <div class="relative flex-1">
          <label for="search" class="sr-only">Search dishes, cooks or ingredients</label>
          <i class="fa-solid fa-magnifying-glass absolute left-5 top-1/2 -translate-y-1/2 text-slate-600 text-lg" aria-hidden="true"></i>
          <input id="search" data-input="search" type="search" enterkeyhint="search" value="${esc(S.searchQ || '')}" placeholder="Search dishes or cooks…"
            class="w-full h-14 pl-14 pr-5 bg-slate-100 rounded-full text-slate-900 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:bg-white">
        </div>
        <button data-act="filters" class="relative w-14 h-14 rounded-full bg-slate-900 hover:bg-slate-800 text-white flex items-center justify-center shrink-0" aria-label="Filters and sorting">
          <i class="fa-solid fa-sliders text-lg" aria-hidden="true"></i>
          <span id="filterDot" class="${filtersActive() ? '' : 'hidden'} absolute top-3 right-3 w-2.5 h-2.5 rounded-full bg-brand-500 ring-2 ring-slate-900"></span>
        </button>
      </div>
      <div id="trending"></div>
      <div>
        <div class="flex items-center justify-between mb-3"><h2 class="text-xl lg:text-2xl font-black text-slate-900 tracking-tight">Browse categories</h2>${seeAll()}</div>
        <div class="-mx-4 px-4 md:-mx-6 md:px-6 lg:mx-0 lg:px-0 flex gap-3 overflow-x-auto hide-scrollbar lg:flex-wrap lg:gap-2 lg:overflow-visible" role="tablist" aria-label="Categories">
          ${['All', ...(S.config.categories || [])].map(c => `<a role="tab" aria-selected="${c === cat}" href="#/${c === 'All' ? '' : '?cat=' + encodeURIComponent(c)}"
            class="shrink-0 w-[5.5rem] md:w-24 h-24 md:h-[6.5rem] lg:w-auto lg:h-11 lg:px-4 rounded-2xl lg:rounded-full flex flex-col lg:flex-row items-center justify-center gap-2 text-center transition-colors ${c === cat ? 'bg-brand-600 text-white shadow-md' : 'bg-slate-100 hover:bg-slate-200 text-slate-900'}">
            <i class="fa-solid ${CAT_ICONS[c] || 'fa-utensils'} text-2xl" aria-hidden="true"></i><span class="text-xs font-bold leading-tight px-1">${esc(c)}</span></a>`).join('')}
        </div>
      </div>
      <div>
        <div class="flex items-center justify-between mb-3"><h2 id="listTitle" class="text-xl lg:text-2xl font-black text-slate-900 tracking-tight">Popular dishes</h2>${seeAll('seeAllBtn')}</div>
        <div id="dishList" class="${cardGrid}">${skeletonCards(4)}</div>
      </div>
    </section>`;
  await loadDishes();
  renderTrending();
  renderDishList(cat);
}

function renderTrending() {
  const box = $('#trending'); if (!box) return;
  const top = [...S.dishes].filter(d => d.available)
    .sort((a, b) => (b.popularity - a.popularity) || ((b.chef.rating.average || 0) - (a.chef.rating.average || 0)) || (!!b.imageUrl - !!a.imageUrl))
    .slice(0, 3);
  if (!top.length) { box.innerHTML = ''; return; }
  box.innerHTML = `
    <h2 class="text-xl lg:text-2xl font-black text-slate-900 tracking-tight mb-3">Trending this week</h2>
    <div class="relative" aria-roledescription="carousel" aria-label="Trending dishes">
      <div id="trendTrack" class="-mx-4 px-4 md:mx-0 md:px-0 flex gap-3 overflow-x-auto snap-x snap-mandatory hide-scrollbar scroll-px-4 md:scroll-px-0">
        ${top.map((d, i) => `
        <article class="snap-center shrink-0 w-full relative h-60 md:h-72 lg:h-80 rounded-2xl overflow-hidden bg-slate-950 text-white" aria-roledescription="slide" aria-label="${i + 1} of ${top.length}">
          ${d.imageUrl ? `<img src="${esc(d.imageUrl)}" alt="" class="absolute inset-y-0 right-0 w-[62%] h-full object-cover">`
            : `<div class="absolute inset-y-0 right-0 w-[62%] bg-gradient-to-br from-brand-700 to-slate-900 flex items-center justify-center text-7xl text-white/20" aria-hidden="true"><i class="fa-solid fa-bowl-food"></i></div>`}
          <div class="absolute inset-0 bg-gradient-to-r from-slate-950 from-35% via-slate-950/80 to-transparent" aria-hidden="true"></div>
          <div class="relative h-full flex flex-col justify-center gap-3 p-5 lg:p-12 max-w-[68%] lg:max-w-[50%]">
            <h2 class="text-[1.65rem] lg:text-5xl font-black leading-[1.1] tracking-tight line-clamp-2">${esc(d.title)}</h2>
            <p class="text-sm lg:text-base text-slate-200 flex items-center gap-2 min-w-0">
              ${d.prepTime ? `<span class="shrink-0"><i class="fa-regular fa-clock" aria-hidden="true"></i> ${esc(d.prepTime)}</span>` : ''}
              <span class="truncate"><i class="fa-solid fa-kitchen-set" aria-hidden="true"></i> ${esc(d.chef.kitchenName)}</span></p>
            <button data-act="dish" data-id="${d.id}" class="self-start h-12 px-6 rounded-full bg-brand-600 hover:bg-brand-700 text-white font-bold text-sm flex items-center gap-2 shadow-lg">View dish</button>
          </div>
        </article>`).join('')}
      </div>
      ${top.length > 1 ? `
      <div class="absolute bottom-0.5 left-1/2 -translate-x-1/2 flex" role="group" aria-label="Choose slide">${top.map((_, i) => `
        <button data-act="trend-go" data-i="${i}" class="w-10 h-10 flex items-center justify-center" aria-label="Show slide ${i + 1}"><span data-dot="${i}" class="w-2.5 h-2.5 rounded-full transition-colors ${i ? 'bg-white/35' : 'bg-brand-500'}"></span></button>`).join('')}</div>
      <div class="hidden md:flex absolute bottom-4 right-4 gap-2">
        <button data-act="trend-step" data-d="-1" class="w-12 h-12 rounded-full bg-white/90 hover:bg-white text-slate-900 shadow-lg flex items-center justify-center" aria-label="Previous slide"><i class="fa-solid fa-chevron-left" aria-hidden="true"></i></button>
        <button data-act="trend-step" data-d="1" class="w-12 h-12 rounded-full bg-white/90 hover:bg-white text-slate-900 shadow-lg flex items-center justify-center" aria-label="Next slide"><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></button>
      </div>` : ''}
    </div>`;
  const track = $('#trendTrack');
  track.addEventListener('scroll', () => {
    const slide = track.firstElementChild;
    const i = Math.round(track.scrollLeft / (slide.offsetWidth + 12));
    document.querySelectorAll('[data-dot]').forEach(dot => { dot.className = `w-2.5 h-2.5 rounded-full transition-colors ${Number(dot.dataset.dot) === i ? 'bg-brand-500' : 'bg-white/35'}`; });
  }, { passive: true });
}

function trendIndex() {
  const t = $('#trendTrack');
  return t ? Math.round(t.scrollLeft / (t.firstElementChild.offsetWidth + 12)) : 0;
}
function trendScroll(i) {
  const t = $('#trendTrack'); if (!t) return;
  const n = t.children.length;
  const next = (i + n) % n;
  t.scrollTo({ left: next * (t.firstElementChild.offsetWidth + 12), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}
function filteredDishes(cat) {
  const q = (S.searchQ || '').trim().toLowerCase(), f = S.filters;
  const list = S.dishes.filter(d => (cat === 'All' || dishCats(d).includes(cat)) &&
    (!q || [d.title, d.description, d.chef.kitchenName, ...dishCats(d), d.dietary, d.chef.cuisine].join(' ').toLowerCase().includes(q)) &&
    (!f.dietary || d.dietary === f.dietary) && (!f.availableOnly || d.available));
  const rating = d => d.chef.rating.average || 0;
  const by = {
    popular: (a, b) => (b.available - a.available) || (b.popularity - a.popularity) || (rating(b) - rating(a)),
    rating: (a, b) => (rating(b) - rating(a)) || (b.chef.rating.count - a.chef.rating.count),
    price: (a, b) => a.price - b.price,
    quick: (a, b) => prepMinutes(a) - prepMinutes(b)
  };
  return list.sort(by[f.sort] || by.popular);
}
function renderDishList(cat = route().query.get('cat') || 'All') {
  const list = $('#dishList'); if (!list) return;
  const narrowed = !!(S.searchQ || '').trim() || cat !== 'All' || filtersActive();
  const shown = filteredDishes(cat);
  const limit = narrowed || S.showAll ? Infinity : 6;
  $('#listTitle').textContent = (S.searchQ || '').trim() ? `Results for “${S.searchQ.trim()}”` : cat !== 'All' ? cat : narrowed ? 'Matching dishes' : 'Popular dishes';
  $('#seeAllBtn').classList.toggle('hidden', limit === Infinity || shown.length <= 6);
  $('#trending')?.classList.toggle('hidden', narrowed);
  $('#filterDot')?.classList.toggle('hidden', !filtersActive());
  if (!S.dishes.length) {
    list.innerHTML = `<div class="col-span-full">${stateCard('fa-kitchen-set', 'No kitchens open yet', 'Cooks in your area are getting set up. Know someone who makes the best tamales on the block? Invite them to cook on Chefy.',
      `<button data-act="start-cooking" class="btn-dark mt-4">Cook on Chefy</button>`)}</div>`;
    return;
  }
  if (!shown.length) {
    list.innerHTML = `<div class="col-span-full">${stateCard('fa-magnifying-glass', 'Nothing matches that', 'Try another word, category or filter.', filtersActive() ? `<button data-act="filter-reset" class="btn-ghost mt-4">Clear filters</button>` : '')}</div>`;
    return;
  }
  list.innerHTML = shown.slice(0, limit).map(dishCard).join('');
}

function heartBtn(d, cls) {
  return `<button data-act="save" data-id="${d.id}" aria-pressed="${!!d.saved}" aria-label="${d.saved ? 'Remove from saved' : 'Save'}: ${esc(d.title)}" class="${cls} rounded-full flex items-center justify-center">
    <i class="${d.saved ? 'fa-solid text-rose-500' : 'fa-regular'} fa-heart" aria-hidden="true"></i></button>`;
}
function dishCard(d) {
  const inBasket = S.basket.items[d.id]?.qty || 0;
  const r = d.chef.rating;
  return `
  <article class="card overflow-hidden flex flex-col transition-shadow ${d.available ? '' : 'opacity-70'}">
    <div class="relative aspect-[4/3] bg-slate-100">
      <button data-act="dish" data-id="${d.id}" class="absolute inset-0 w-full h-full" aria-label="View ${esc(d.title)}">${dishImg(d.imageUrl, 'w-full h-full')}</button>
      ${heartBtn(d, 'absolute top-2 right-2 w-10 h-10 bg-black/30 hover:bg-black/45 backdrop-blur-sm text-white text-lg')}
      ${!d.available ? `<span class="absolute bottom-2 left-2 chip bg-white/95 text-slate-700">Sold out today</span>` : ''}
    </div>
    <div class="p-3 lg:p-4 flex-1 flex flex-col gap-1.5">
      <h3 class="font-bold text-slate-900 text-[15px] lg:text-base leading-snug line-clamp-2"><button data-act="dish" data-id="${d.id}" class="block w-full text-left py-2.5 -my-2.5 hover:text-brand-700">${esc(d.title)}</button></h3>
      <a href="#/chef/${d.chefId}" class="block text-sm text-slate-600 truncate hover:text-brand-700 py-3 -my-3">${esc(d.chef.kitchenName)}</a>
      <p class="text-xs text-slate-500 flex items-center gap-2 flex-wrap">
        <span class="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-slate-100 font-semibold text-slate-800">${r.count ? `<i class="fa-solid fa-star text-amber-400" aria-hidden="true"></i> ${r.average.toFixed(1)}<span class="sr-only"> stars</span>` : 'New cook'}</span>
        ${d.prepTime ? `<span><i class="fa-regular fa-clock" aria-hidden="true"></i> ${esc(d.prepTime)}</span>` : ''}</p>
      <div class="mt-auto pt-1.5 flex items-center justify-between gap-2">
        <span class="text-base lg:text-lg font-black text-slate-900 tabular-nums">${money(d.price)}</span>
        ${!d.available ? '' : inBasket ? stepperSm(d.id, inBasket) :
          `<button data-act="add" data-id="${d.id}" class="w-11 h-11 rounded-full bg-brand-600 hover:bg-brand-700 text-white flex items-center justify-center shadow-md" aria-label="Add ${esc(d.title)} to basket"><i class="fa-solid fa-plus" aria-hidden="true"></i></button>`}
      </div>
    </div>
  </article>`;
}
const stepper = (id, qty) => `
  <div class="flex items-center gap-1 bg-brand-50 border border-brand-200 rounded-xl p-0.5">
    <button data-act="qty" data-id="${id}" data-d="-1" class="w-10 h-10 rounded-lg text-brand-700 font-black" aria-label="Remove one">−</button>
    <span class="text-sm font-black text-brand-700 w-5 text-center" aria-live="polite">${qty}</span>
    <button data-act="qty" data-id="${id}" data-d="1" class="w-10 h-10 rounded-lg text-brand-700 font-black" aria-label="Add one">+</button>
  </div>`;
const stepperSm = (id, qty) => `
  <div class="flex items-center bg-brand-600 text-white rounded-full h-11 px-0.5">
    <button data-act="qty" data-id="${id}" data-d="-1" class="w-9 h-10 rounded-full font-black" aria-label="Remove one">−</button>
    <span class="text-sm font-black w-4 text-center" aria-live="polite">${qty}</span>
    <button data-act="qty" data-id="${id}" data-d="1" class="w-9 h-10 rounded-full font-black" aria-label="Add one">+</button>
  </div>`;

function findDish(id) {
  return (S.dishes || []).find(d => d.id === id) || (S.chefPage?.dishes || []).find(d => d.id === id) || (S.savedList || []).find(d => d.id === id);
}

// Dish details panel ("View dish")
async function openDish(id) {
  let d = findDish(id);
  if (!d) { await loadDishes(); d = findDish(id); }
  if (!d) return toast('That dish is no longer listed.');
  const c = d.chef, r = c.rating;
  openSheet(`
    <div class="relative">
      ${dishImg(d.imageUrl, 'w-full aspect-[4/3] lg:aspect-[16/10]')}
      <button data-act="close-sheet" class="absolute top-3 right-3 w-11 h-11 rounded-full bg-white/95 text-slate-900 shadow flex items-center justify-center" aria-label="Close"><i class="fa-solid fa-xmark text-lg" aria-hidden="true"></i></button>
      ${heartBtn(d, 'absolute top-3 left-3 w-11 h-11 bg-white/95 text-slate-900 shadow text-lg')}
    </div>
    <div class="p-5 space-y-4">
      <div>
        <h2 class="text-2xl font-black text-slate-900 leading-tight">${esc(d.title)}</h2>
        <p class="text-sm text-slate-500 mt-2 flex items-center gap-2 flex-wrap">
          ${d.prepTime ? `<span><i class="fa-regular fa-clock" aria-hidden="true"></i> Ready in ${esc(d.prepTime)}</span>` : ''}
          <span>${r.count ? `<i class="fa-solid fa-star text-amber-400" aria-hidden="true"></i> ${r.average.toFixed(1)} (${r.count} review${r.count === 1 ? '' : 's'})` : 'New cook'}</span></p>
        <ul class="flex flex-wrap gap-2 mt-3" aria-label="Categories">${[...dishCats(d), d.dietary].filter(Boolean).map(t => `<li class="chip bg-slate-100 text-slate-700">${esc(t)}</li>`).join('')}</ul>
      </div>
      <a href="#/chef/${d.chefId}" class="flex items-center gap-3 p-3 rounded-2xl bg-slate-50 border border-slate-100 hover:border-slate-200">
        ${avatar(c.avatarUrl, c.kitchenName, 'w-12 h-12 rounded-xl')}
        <span class="flex-1 min-w-0"><span class="block text-sm font-bold text-slate-900 truncate">${esc(c.kitchenName)}</span>
          <span class="block text-sm text-slate-500 truncate">${meta(['<i class="fa-solid fa-shield-halved text-emerald-600" aria-hidden="true"></i> Permit checked', c.neighborhood ? esc(c.neighborhood) : ''])}</span></span>
        <i class="fa-solid fa-chevron-right text-slate-500" aria-hidden="true"></i></a>
      ${d.description ? `<p class="text-[15px] text-slate-700 leading-relaxed">${esc(d.description)}</p>` : ''}
      <p class="text-sm text-slate-500">Pickup${c.offersDelivery ? ' or local delivery' : ' only'}. The address is shown after you order.</p>
      ${d.available ? `<button data-act="add-close" data-id="${d.id}" class="btn-primary !justify-between"><span>Add to basket</span><span class="tabular-nums">${money(d.price)}</span></button>`
        : `<p class="p-3 rounded-xl bg-slate-100 text-sm font-semibold text-slate-600 text-center">Sold out today. Save it and check back tomorrow.</p>`}
    </div>`, d.title);
}

async function toggleSave(id) {
  requireAuth(async () => {
    const d = findDish(id);
    const next = !(d && d.saved);
    try {
      await api(`/api/saved/${id}`, { method: 'POST', body: { saved: next } });
      for (const list of [S.dishes, S.chefPage?.dishes, S.savedList]) (list || []).forEach(x => { if (x.id === id) x.saved = next; });
      document.querySelectorAll(`[data-act="save"][data-id="${id}"]`).forEach(b => {
        b.setAttribute('aria-pressed', String(next));
        b.innerHTML = `<i class="${next ? 'fa-solid text-rose-500' : 'fa-regular'} fa-heart" aria-hidden="true"></i>`;
      });
      toast(next ? 'Saved' : 'Removed from saved');
      if (route().parts[0] === 'saved' && !$('#sheetRoot').firstChild) render();
    } catch (e) { toast(e.message); }
  }, 'Sign in to save dishes you love.');
}

function openFilters() {
  openSheet(`<div id="filterSheet"></div>`, 'Filters and sorting');
  renderFilterSheet();
}
function renderFilterSheet() {
  const box = $('#filterSheet'); if (!box) return;
  const f = S.filters, cat = route().query.get('cat') || 'All';
  const chip = (on, attrs, label) => `<button ${attrs} aria-pressed="${on}" class="h-11 px-4 rounded-full text-sm font-bold ${on ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-800 hover:bg-slate-200'}">${label}</button>`;
  const count = S.dishes ? filteredDishes(cat).length : 0;
  box.innerHTML = sheetHeader('Filters & sorting') + `
    <div class="p-5 space-y-6">
      <fieldset><legend class="label mb-2">Category</legend><div class="flex flex-wrap gap-2">
        ${['All', ...S.config.categories].map(c => `<a href="#/${c === 'All' ? '' : '?cat=' + encodeURIComponent(c)}" aria-current="${c === cat}" class="h-11 px-4 rounded-full text-sm font-bold flex items-center gap-2 ${c === cat ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-800 hover:bg-slate-200'}"><i class="fa-solid ${CAT_ICONS[c] || 'fa-utensils'}" aria-hidden="true"></i>${esc(c)}</a>`).join('')}</div></fieldset>
      <fieldset><legend class="label mb-2">Sort by</legend><div class="flex flex-wrap gap-2">
        ${Object.entries(SORTS).map(([k, l]) => chip(f.sort === k, `data-act="filter-sort" data-v="${k}"`, l)).join('')}</div></fieldset>
      <fieldset><legend class="label mb-2">Dietary</legend><div class="flex flex-wrap gap-2">
        ${['', ...S.config.dietary].map(v => chip(f.dietary === v, `data-act="filter-diet" data-v="${esc(v)}"`, v ? esc(v) : 'Any')).join('')}</div></fieldset>
      <label class="flex items-center justify-between gap-3 p-4 rounded-2xl bg-slate-50 border border-slate-100">
        <span><span class="block text-sm font-bold text-slate-900">Available today only</span><span class="block text-xs text-slate-500">Hide dishes that are sold out</span></span>
        <input type="checkbox" data-change="filter-avail" ${f.availableOnly ? 'checked' : ''} class="w-6 h-6 accent-blue-600"></label>
      <div class="grid grid-cols-2 gap-3">
        <button data-act="filter-reset" class="btn-ghost">Reset</button>
        <button data-act="close-sheet" class="btn-primary">Show ${count} dish${count === 1 ? '' : 'es'}</button>
      </div>
    </div>`;
}
function setFilters(patch) {
  S.filters = { ...S.filters, ...patch };
  store.set('chefy_filters', S.filters);
  renderFilterSheet();
  renderDishList();
}

// ============ saved ============
const SAVED_HEAD = `<div class="flex items-end justify-between mb-4"><h1 class="text-2xl lg:text-3xl font-black text-slate-900 tracking-tight">Saved</h1></div>`;
async function savedView() {
  const head = SAVED_HEAD;
  if (!S.me.user) { view.innerHTML = head + signInPrompt('Keep the dishes you love', 'Tap the heart on any dish to save it here, so you can order it again in two taps.'); return; }
  view.innerHTML = head + `<div class="${cardGrid}">${skeletonCards(4)}</div>`;
  S.savedList = (await api('/api/saved')).dishes;
  renderSaved(head);
}
function renderSaved(head = SAVED_HEAD) {
  if (route().parts[0] !== 'saved') return;
  view.innerHTML = head + (S.savedList.length
    ? `<div id="savedGrid" class="${cardGrid}">${S.savedList.map(dishCard).join('')}</div>`
    : stateCard('fa-heart', 'Nothing saved yet', 'Tap the heart on a dish and it lands here, so you can order it again in two taps.', `<a href="#/" class="btn-dark mt-4">Find something to eat</a>`));
}

function addToBasket(id) {
  const d = findDish(id);
  if (!d) return;
  const chef = d.chef || S.chefPage?.chef;
  if (S.basket.chefId && S.basket.chefId !== d.chefId && basketCount() > 0) {
    if (!confirm(`Start a new basket? Your basket has food from ${S.basket.chefName}. Orders come from one kitchen at a time.`)) return false;
    S.basket = emptyBasket();
  }
  S.basket.chefId = d.chefId;
  S.basket.chefName = chef.kitchenName;
  S.basket.offersDelivery = chef.offersDelivery;
  const cur = S.basket.items[id];
  S.basket.items[id] = { qty: (cur?.qty || 0) + 1, title: d.title, price: d.price, imageUrl: d.imageUrl };
  saveBasket();
  if (navigator.vibrate) navigator.vibrate(10);
  refreshShopLists();
  return true;
}
function changeQty(id, delta) {
  const it = S.basket.items[id]; if (!it) return;
  it.qty += delta;
  if (it.qty <= 0) delete S.basket.items[id];
  if (!basketCount()) S.basket = { ...emptyBasket(), fulfillment: S.basket.fulfillment, tip: S.basket.tip };
  saveBasket();
  refreshShopLists();
  if ($('#basketSheet')) renderBasketSheet();
}
function refreshShopLists() {
  if ($('#dishList')) renderDishList();
  if ($('#chefMenu')) renderChefMenu();
  if ($('#savedGrid')) renderSaved();
}

// ============ cook page ============
async function chefView(id) {
  view.innerHTML = `<div class="skeleton h-40 md:h-56 lg:h-64 -mx-4 -mt-4 md:mx-0 md:mt-0 rounded-none md:rounded-3xl"></div><div class="space-y-3 mt-4">${skeletonList(2)}</div>`;
  S.chefPage = await api(`/api/chefs/${encodeURIComponent(id)}`);
  const { chef, reviews } = S.chefPage;
  S.chefPage.dishes.forEach(d => { d.chef = chef; });
  view.innerHTML = `
    <div class="relative -mx-4 -mt-4 h-40 md:mx-0 md:mt-0 md:h-56 lg:h-64 md:rounded-3xl overflow-hidden bg-gradient-to-br from-brand-100 to-brand-300">
      ${chef.coverUrl ? `<img src="${esc(chef.coverUrl)}" alt="" class="w-full h-full object-cover">` : ''}
      <a href="#/" class="absolute top-3 left-3 w-11 h-11 rounded-full bg-white/90 flex items-center justify-center text-slate-800 shadow" aria-label="Back"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i></a>
    </div>
    <section class="relative -mt-8 md:-mt-12 md:px-6 lg:-mt-16 space-y-4 lg:space-y-0 lg:grid lg:grid-cols-[22rem_1fr] lg:gap-8 lg:items-start">
      <div class="card p-4 lg:p-5 lg:sticky lg:top-24">
        <div class="flex items-center gap-3">
          ${avatar(chef.avatarUrl, chef.kitchenName, 'w-16 h-16 rounded-2xl ring-4 ring-white')}
          <div class="min-w-0">
            <h1 class="text-lg font-black text-slate-900 leading-tight">${esc(chef.kitchenName)}</h1>
            <p class="text-sm text-slate-500">${meta([esc(chef.cuisine || 'Home cooking'), chef.neighborhood ? esc(chef.neighborhood) : ''])}</p>
            <p class="text-xs mt-0.5">${stars(chef.rating.average, chef.rating.count)}</p>
          </div>
        </div>
        ${chef.bio ? `<p class="text-sm text-slate-600 leading-relaxed mt-3">${esc(chef.bio)}</p>` : ''}
        <div class="mt-3 pt-3 border-t border-slate-200 flex items-center gap-2.5 text-sm">
          <i class="fa-solid fa-shield-halved text-emerald-700 text-base" aria-hidden="true"></i>
          <span class="text-emerald-900"><strong>Permit checked by Chefy.</strong> ${esc(chef.permitLabel || '')}</span>
        </div>
        <p class="text-sm text-slate-500 mt-3">Pickup${chef.offersDelivery ? ' or local delivery' : ' only'}. The exact address is shown after you order.</p>
        ${!chef.live ? `<p class="mt-2 text-xs font-bold text-amber-700"><i class="fa-solid fa-moon mr-1" aria-hidden="true"></i>Not taking orders right now.</p>` : ''}
      </div>
      <div class="space-y-4 lg:pt-20">
      <h2 class="text-base lg:text-xl font-bold text-slate-900">Menu</h2>
      <div id="chefMenu" class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-2 xl:grid-cols-3 gap-3 md:gap-4 lg:gap-5"></div>
      <h2 class="text-base font-bold text-slate-900 pt-2">Reviews</h2>
      ${reviews.length ? reviews.map(r => `
        <div class="card p-3.5">
          <div class="flex items-center justify-between text-xs"><span class="font-bold text-slate-800">${esc(r.name)}</span>
            <span class="text-amber-500" aria-label="${r.rating} out of 5 stars">${'★'.repeat(r.rating)}<span class="text-slate-300">${'★'.repeat(5 - r.rating)}</span></span></div>
          ${r.text ? `<p class="text-sm text-slate-600 mt-1">${esc(r.text)}</p>` : ''}
          <p class="text-xs text-slate-500 mt-1">${timeAgo(r.at)}</p>
        </div>`).join('') : `<p class="text-sm text-slate-500">No reviews yet. Be the first to order.</p>`}
      </div>
    </section>`;
  renderChefMenu();
}
function renderChefMenu() {
  const box = $('#chefMenu'); if (!box || !S.chefPage) return;
  const ds = S.chefPage.dishes;
  box.innerHTML = ds.length ? ds.map(d => S.chefPage.chef.live ? dishCard(d) : dishCard({ ...d, available: false })).join('')
    : `<p class="col-span-full text-sm text-slate-500">This kitchen hasn't listed any dishes yet.</p>`;
}

// ============ basket & checkout ============
function openBasket() {
  openSheet(`<div id="basketSheet"></div>`, 'Your basket');
  renderBasketSheet();
}
function renderBasketSheet() {
  const box = $('#basketSheet'); if (!box) return;
  const lines = basketLines();
  if (!lines.length) {
    box.innerHTML = sheetHeader('Your basket') + `<div class="p-6">${stateCard('fa-bowl-food', 'Your basket is empty', 'Add a dish from a cook near you to get started.', `<button data-act="close-sheet" class="btn-dark mt-4">Browse dishes</button>`)}</div>`;
    return;
  }
  const b = S.basket, t = basketTotals();
  if (b.fulfillment === 'delivery' && !b.offersDelivery) b.fulfillment = 'pickup';
  box.innerHTML = sheetHeader('Your basket', `From <strong>${esc(b.chefName)}</strong>`) + `
    <div class="p-5 space-y-5">
      <div class="divide-y divide-slate-100">
        ${lines.map(l => `<div class="flex items-center gap-3 py-2.5">
            ${dishImg(l.imageUrl, 'w-12 h-12 rounded-xl shrink-0')}
            <div class="flex-1 min-w-0"><p class="text-sm font-bold text-slate-900 line-clamp-1">${esc(l.title)}</p><p class="text-xs font-semibold text-brand-700">${money(l.price)}</p></div>
            ${stepper(l.dishId, l.qty)}</div>`).join('')}
      </div>
      <fieldset>
        <legend class="label">How do you want it?</legend>
        <div class="grid grid-cols-2 p-1 bg-slate-100 rounded-xl text-sm font-bold">
          <button data-act="fulfill" data-v="pickup" aria-pressed="${b.fulfillment === 'pickup'}" class="py-2.5 rounded-lg ${b.fulfillment === 'pickup' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500'}"><i class="fa-solid fa-person-walking mr-1" aria-hidden="true"></i> Pickup</button>
          <button data-act="fulfill" data-v="delivery" ${b.offersDelivery ? '' : 'disabled'} aria-pressed="${b.fulfillment === 'delivery'}" class="py-2.5 rounded-lg ${b.fulfillment === 'delivery' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500'} disabled:text-slate-300"><i class="fa-solid fa-motorcycle mr-1" aria-hidden="true"></i> Delivery</button>
        </div>
        ${!b.offersDelivery ? `<p class="text-xs text-slate-500 mt-1.5">This cook offers pickup only.</p>` : ''}
      </fieldset>
      ${b.fulfillment === 'delivery' ? `<div><label class="label" for="bAddr">Delivery address</label>
        <input id="bAddr" data-input="basket-address" autocomplete="street-address" value="${esc(b.address)}" class="field" placeholder="Street, apartment, buzzer"></div>` : ''}
      <div><label class="label" for="bNotes">Note for the cook <span class="font-normal text-slate-500">(optional)</span></label>
        <textarea id="bNotes" data-input="basket-notes" rows="2" maxlength="300" class="field" placeholder="Allergies, extra salsa, pickup time…">${esc(b.notes)}</textarea></div>
      <fieldset>
        <legend class="label">Tip for the cook <span class="font-normal text-slate-500">(100% goes to them)</span></legend>
        <div class="grid grid-cols-5 gap-2">
          ${(S.config.tipOptions || [0, 10, 15, 20, 25]).map(p => `<button data-act="tip" data-v="${p}" aria-pressed="${b.tip === p}" class="h-11 rounded-xl text-xs font-bold border ${b.tip === p ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-slate-200 text-slate-600'}">${p ? p + '%' : 'None'}</button>`).join('')}
        </div>
      </fieldset>
      <dl class="text-sm space-y-1.5 pt-3 border-t border-slate-100">
        <div class="flex justify-between text-slate-600"><dt>Food</dt><dd>${money(t.subtotal)}</dd></div>
        <div class="flex justify-between text-slate-600"><dt>${b.fulfillment === 'delivery' ? 'Delivery fee' : 'Service fee'}</dt><dd>${money(t.fee)}</dd></div>
        <div class="flex justify-between text-slate-600"><dt>Tip</dt><dd>${money(t.tip)}</dd></div>
        <div class="flex justify-between font-black text-slate-900 text-base pt-1.5 border-t border-slate-100"><dt>Total</dt><dd>${money(t.total)}</dd></div>
      </dl>
      <form data-form="checkout">${errorBox()}<button class="btn-primary mt-3 !justify-between" type="submit"><span>Checkout</span><span class="tabular-nums">${money(t.total)}</span></button></form>
      <p class="text-xs text-center text-slate-500"><i class="fa-solid fa-shield-halved mr-1" aria-hidden="true"></i>Your card is held, not charged, until the cook marks your food ready.</p>
    </div>`;
}

async function startCheckout(form) {
  const b = S.basket;
  if (b.fulfillment === 'delivery' && b.address.trim().length < 5) return showError(form, 'Add your delivery address.');
  const btn = form.querySelector('button');
  setBusy(btn, true, 'Preparing checkout…');
  try {
    const r = await api('/api/orders', { method: 'POST', body: {
      items: basketLines().map(l => ({ dishId: l.dishId, qty: l.qty })), fulfillment: b.fulfillment,
      tipPercent: b.tip, deliveryAddress: b.address, notes: b.notes
    } });
    S.pendingOrder = r.order;
    await openPaymentSheet(r.order, r.clientSecret);
  } catch (e) {
    setBusy(btn, false);
    if (e.status === 409) { S.dishes = null; }
    showError(form, e.message);
  }
}

async function openPaymentSheet(order, clientSecret) {
  const stripeMode = S.config.payments.mode === 'stripe';
  openSheet(sheetHeader('Pay securely', `${esc(order.chef.kitchenName)}, order ${esc(order.code)}`) + `
    <form data-form="pay" class="p-5 space-y-4" novalidate>
      <div class="p-4 rounded-2xl bg-brand-50 border border-brand-100">
        <div class="flex items-center justify-between"><span class="text-xs font-semibold text-slate-600">Amount held today</span><span class="text-2xl font-black text-slate-900">${money(order.total)}</span></div>
        <p class="text-xs text-slate-600 mt-1">Charged only when the cook marks your order ready. Released if they decline.</p>
      </div>
      ${stripeMode ? `<div id="payment-element" class="min-h-[160px]"><div class="skeleton h-40"></div></div>` : `
        <div class="space-y-3">
          <div><label class="label" for="ccName">Name on card</label><input id="ccName" name="name" autocomplete="cc-name" class="field" placeholder="Full name"></div>
          <div><label class="label" for="ccNumber">Card number</label>
            <div class="relative"><input id="ccNumber" name="number" data-input="cc-number" autocomplete="cc-number" inputmode="numeric" class="field pr-12 tracking-wider" placeholder="1234 5678 9012 3456">
            <i id="ccBrand" class="fa-regular fa-credit-card absolute right-4 top-1/2 -translate-y-1/2 text-xl text-slate-500" aria-hidden="true"></i></div></div>
          <div class="grid grid-cols-3 gap-3">
            <div><label class="label" for="ccExp">Expiry</label><input id="ccExp" name="exp" data-input="cc-exp" autocomplete="cc-exp" inputmode="numeric" class="field" placeholder="MM/YY"></div>
            <div><label class="label" for="ccCvc">CVC</label><input id="ccCvc" name="cvc" data-input="digits" autocomplete="cc-csc" inputmode="numeric" maxlength="4" class="field" placeholder="123"></div>
            <div><label class="label" for="ccZip">ZIP</label><input id="ccZip" name="zip" data-input="digits" autocomplete="postal-code" inputmode="numeric" maxlength="5" class="field" placeholder="94110"></div>
          </div>
          <p class="p-3 bg-sky-50 border border-sky-100 rounded-xl text-xs text-sky-900"><strong>Demo payments. No real charge.</strong> Use 4242 4242 4242 4242 with any future date. 4000 0000 0000 0002 is declined.</p>
        </div>`}
      ${errorBox()}
      <button class="btn-dark" type="submit" ${stripeMode ? 'disabled' : ''}><i class="fa-solid fa-lock text-xs" aria-hidden="true"></i> Pay ${money(order.total)}</button>
    </form>`, 'Payment', () => {
    // Closed without paying: release the pending checkout so nothing is left on hold.
    if (S.pendingOrder && S.pendingOrder.code === order.code) {
      api(`/api/orders/${order.code}/cancel`, { method: 'POST', body: {} }).catch(() => {});
      S.pendingOrder = null;
    }
  });
  if (stripeMode) {
    try {
      await loadStripe();
      S.elements = S.stripe.elements({ clientSecret, appearance: { theme: 'stripe', variables: { colorPrimary: getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim() || 'rgb(0 107 230)', borderRadius: '10px', fontFamily: 'Inter, system-ui, sans-serif' } } });
      const pe = S.elements.create('payment', { layout: 'tabs' });
      pe.mount('#payment-element');
      pe.on('ready', () => { const b = $('form[data-form="pay"] button[type="submit"]'); if (b) b.disabled = false; });
    } catch (e) { showError($('form[data-form="pay"]'), 'Card form failed to load. Check your connection and try again.'); }
  }
}
function loadStripe() {
  if (S.stripe) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://js.stripe.com/v3/';
    s.onload = () => { S.stripe = window.Stripe(S.config.payments.publishableKey); resolve(); };
    s.onerror = reject;
    document.head.appendChild(s);
  });
}
const BRANDS = { visa: ['Visa', 'fa-brands fa-cc-visa text-blue-700'], mastercard: ['Mastercard', 'fa-brands fa-cc-mastercard text-orange-600'], amex: ['Amex', 'fa-brands fa-cc-amex text-sky-600'], discover: ['Discover', 'fa-brands fa-cc-discover text-amber-600'], card: ['Card', 'fa-regular fa-credit-card text-slate-500'] };
function cardBrand(d) {
  if (/^4/.test(d)) return 'visa';
  if (/^(5[1-5]|2[2-7])/.test(d)) return 'mastercard';
  if (/^3[47]/.test(d)) return 'amex';
  if (/^6(011|5)/.test(d)) return 'discover';
  return 'card';
}
function luhn(d) { let s = 0, dbl = false; for (let i = d.length - 1; i >= 0; i--) { let n = +d[i]; if (dbl) { n *= 2; if (n > 9) n -= 9; } s += n; dbl = !dbl; } return s % 10 === 0; }

async function submitPayment(form) {
  const order = S.pendingOrder;
  if (!order) return;
  const btn = form.querySelector('button[type="submit"]');
  let demoCard;
  if (S.config.payments.mode === 'stripe') {
    setBusy(btn, true, 'Checking your card…');
    const { error } = await S.stripe.confirmPayment({
      elements: S.elements, redirect: 'if_required',
      confirmParams: { return_url: `${location.origin}/#/orders/${order.code}?paid=1` }
    });
    if (error) { setBusy(btn, false); return showError(form, error.message || 'Your card couldn\'t be authorized.'); }
  } else {
    const v = formValues(form);
    const digits = (v.number || '').replace(/\D/g, '');
    const brand = cardBrand(digits);
    const m = /^(\d{2})\/(\d{2})$/.exec(v.exp || '');
    if (!v.name?.trim()) return showError(form, 'Enter the name on your card.');
    if (digits.length < 13 || !luhn(digits)) return showError(form, 'That card number doesn\'t look right. Check it and try again.');
    if (!m || +m[1] < 1 || +m[1] > 12 || new Date(2000 + +m[2], +m[1], 1) <= new Date()) return showError(form, 'Enter a future expiry as MM/YY.');
    if ((v.cvc || '').length !== (brand === 'amex' ? 4 : 3)) return showError(form, 'Enter the security code from the back of the card.');
    if ((v.zip || '').length !== 5) return showError(form, 'Enter your 5-digit billing ZIP.');
    setBusy(btn, true, 'Checking your card…');
    await new Promise(r => setTimeout(r, 900));
    if (digits === '4000000000000002') { setBusy(btn, false); return showError(form, 'Your card was declined. No charge was made. Try another card.'); }
    demoCard = { brand: BRANDS[brand][0], last4: digits.slice(-4) };
  }
  try {
    const r = await api(`/api/orders/${order.code}/confirm`, { method: 'POST', body: { demoCard } });
    S.pendingOrder = null;
    S.basket = { ...emptyBasket(), tip: S.basket.tip };
    saveBasket();
    closeSheet(true);
    toast('Order sent to the cook');
    go(`#/orders/${r.order.code}`);
  } catch (e) { setBusy(btn, false); showError(form, e.message); }
}

// ============ orders (eater) ============
const EATER_STATUS = {
  received: ['Waiting for the cook', 'bg-amber-100 text-amber-800', 'fa-hourglass-half'],
  preparing: ['Cooking now', 'bg-amber-100 text-amber-800', 'fa-fire-burner'],
  ready: ['Ready', 'bg-emerald-100 text-emerald-800', 'fa-bell'],
  completed: ['Done', 'bg-slate-100 text-slate-700', 'fa-check'],
  declined: ['Declined by cook', 'bg-rose-100 text-rose-700', 'fa-ban'],
  canceled: ['Cancelled', 'bg-rose-100 text-rose-700', 'fa-xmark']
};
const PAY_STATUS = {
  authorized: ['Card held', 'bg-sky-100 text-sky-800'], captured: ['Charged', 'bg-emerald-100 text-emerald-800'],
  refunded: ['Refunded', 'bg-rose-100 text-rose-700'], canceled: ['Hold released', 'bg-slate-100 text-slate-600'], pending: ['Not paid', 'bg-slate-100 text-slate-600']
};
const statusChip = (o, map = EATER_STATUS) => {
  const [label, cls, icon] = map[o.status] || [o.status, 'bg-slate-100 text-slate-600', 'fa-circle'];
  const text = o.status === 'ready' ? (o.fulfillment === 'delivery' ? 'On the way' : 'Ready for pickup') : o.status === 'completed' ? (o.fulfillment === 'delivery' ? 'Delivered' : 'Picked up') : label;
  return `<span class="chip ${cls}"><i class="fa-solid ${icon}" aria-hidden="true"></i> ${text}</span>`;
};
const payChip = p => { const [l, c] = PAY_STATUS[p.status] || [p.status, 'bg-slate-100']; return `<span class="chip ${c}">${l}</span>`; };
const signInPrompt = (title, body) => stateCard('fa-circle-user', title, body, `<button data-act="auth" data-mode="signup" class="btn-primary mt-4">Create account</button><button data-act="auth" data-mode="login" class="btn-ghost mt-2">Sign in</button>`);

async function ordersView() {
  if (!S.me.user) { view.innerHTML = signInPrompt('Your orders live here', 'Sign in to place orders and follow them from the kitchen to your door.'); return; }
  view.innerHTML = `<div class="space-y-3">${skeletonList(2)}</div>`;
  const { orders } = await api('/api/orders');
  const active = orders.filter(o => ['received', 'preparing', 'ready'].includes(o.status));
  const past = orders.filter(o => !active.includes(o));
  $('#ordersDot').classList.toggle('hidden', !active.length);
  $('#ordersDotD').classList.toggle('hidden', !active.length);
  if (!orders.length) { view.innerHTML = stateCard('fa-receipt', 'No orders yet', 'When you order, you can follow it here: cooking, ready, picked up.', `<a href="#/" class="btn-dark mt-4">Find something to eat</a>`); return; }
  const card = o => `
    <a href="#/orders/${esc(o.code)}" class="card p-4 block space-y-2 transition-shadow">
      <div class="flex items-center gap-3">
        ${avatar(o.chef.avatarUrl, o.chef.kitchenName)}
        <div class="flex-1 min-w-0"><p class="text-sm font-bold text-slate-900 truncate">${esc(o.chef.kitchenName)}</p><p class="text-xs text-slate-500">${meta([esc(o.code), timeAgo(o.times.created)])}</p></div>
        <span class="text-sm font-black text-slate-900">${money(o.total)}</span>
      </div>
      <p class="text-xs text-slate-600 line-clamp-1">${o.items.map(i => `${i.qty}× ${esc(i.title)}`).join(', ')}</p>
      <div class="flex gap-1.5 flex-wrap">${statusChip(o)} ${payChip(o.payment)}${o.issue ? ` <span class="chip bg-rose-50 text-rose-700">Problem ${esc(o.issue.status)}</span>` : ''}</div>
    </a>`;
  view.innerHTML = `
    ${active.length ? `<h1 class="text-base lg:text-xl font-bold text-slate-900 mb-2 lg:mb-3">In progress</h1><div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3 lg:gap-4 mb-6 lg:mb-10">${active.map(card).join('')}</div>` : ''}
    ${past.length ? `<h2 class="text-base lg:text-xl font-bold text-slate-900 mb-2 lg:mb-3">Past orders</h2><div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3 lg:gap-4">${past.map(card).join('')}</div>` : ''}`;
}

async function orderView(code, query) {
  if (!S.me.user) { view.innerHTML = signInPrompt('Sign in to see this order', ''); return; }
  let { order: o } = await api(`/api/orders/${encodeURIComponent(code)}`);
  if (o.status === 'awaiting_payment' && query.get('paid')) {
    o = (await api(`/api/orders/${o.code}/confirm`, { method: 'POST', body: {} }).catch(() => ({ order: o }))).order;
    if (o.status !== 'awaiting_payment') { S.basket = { ...emptyBasket(), tip: S.basket.tip }; saveBasket(); history.replaceState(null, '', `#/orders/${o.code}`); }
  }
  const steps = [['Placed', o.times.created], ['Cooking', o.times.accepted], [o.fulfillment === 'delivery' ? 'On the way' : 'Ready', o.times.ready], [o.fulfillment === 'delivery' ? 'Delivered' : 'Picked up', o.times.completed]];
  const reached = { received: 1, preparing: 2, ready: 3, completed: 4 }[o.status] || 0;
  const closed = ['declined', 'canceled'].includes(o.status);
  view.innerHTML = `
    <div class="lg:max-w-2xl lg:mx-auto">
    <a href="#/orders" class="inline-flex items-center gap-1.5 text-xs font-bold text-slate-600 mb-3 h-11">Back to orders</a>
    <section class="space-y-4">
      <div class="card p-4">
        <div class="flex items-center gap-3">
          ${avatar(o.chef.avatarUrl, o.chef.kitchenName, 'w-12 h-12 rounded-xl')}
          <div class="flex-1 min-w-0"><h1 class="text-base font-black text-slate-900 truncate">${esc(o.chef.kitchenName)}</h1><p class="text-xs text-slate-500">${meta(['Order ' + esc(o.code), new Date(o.times.created).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })])}</p></div>
          ${statusChip(o)}
        </div>
        ${closed ? `<p class="mt-3 pl-3 border-l-2 border-rose-400 text-rose-800 text-sm font-semibold">${o.status === 'declined' ? 'The cook couldn\'t take this order.' : 'This order was cancelled.'} The hold on your card was released, so you weren't charged.</p>` : `
        <ol class="mt-4 grid grid-cols-4 gap-1" aria-label="Order progress">
          ${steps.map(([label, ts], i) => `<li class="text-center">
            <div class="h-1.5 rounded-full ${i < reached ? 'bg-emerald-500' : 'bg-slate-200'}"></div>
            <p class="text-xs font-bold mt-1.5 ${i < reached ? 'text-slate-900' : 'text-slate-500'}">${label}</p>
            <p class="text-xs text-slate-500">${ts ? clock(ts) : ''}</p></li>`).join('')}
        </ol>`}
      </div>

      ${!closed && o.fulfillment === 'pickup' && o.chef.pickupAddress ? `
      <div class="card p-4 space-y-1.5">
        <p class="text-sm font-semibold text-slate-500">Pickup</p>
        <p class="text-sm font-bold text-slate-900">${esc(o.chef.pickupAddress)}</p>
        ${o.chef.pickupNotes ? `<p class="text-xs text-slate-600">${esc(o.chef.pickupNotes)}</p>` : ''}
        <a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(o.chef.pickupAddress)}" target="_blank" rel="noopener" class="inline-flex items-center gap-1.5 text-xs font-bold text-brand-700 h-11"><i class="fa-solid fa-map-location-dot" aria-hidden="true"></i> Open in Maps</a>
      </div>` : ''}
      ${o.fulfillment === 'delivery' ? `<div class="card p-4"><p class="text-xs font-bold text-slate-500">Delivering to</p><p class="text-sm font-bold text-slate-900 mt-1">${esc(o.deliveryAddress)}</p></div>` : ''}

      <div class="card p-4 space-y-2">
        ${o.items.map(i => `<div class="flex justify-between text-sm"><span class="text-slate-700">${i.qty}× ${esc(i.title)}</span><span class="font-semibold">${money(i.price * i.qty)}</span></div>`).join('')}
        ${o.notes ? `<p class="text-xs text-slate-500 italic">“${esc(o.notes)}”</p>` : ''}
        <dl class="text-xs space-y-1 pt-2 border-t border-slate-100 text-slate-600">
          <div class="flex justify-between"><dt>${o.fulfillment === 'delivery' ? 'Delivery fee' : 'Service fee'}</dt><dd>${money(o.fee)}</dd></div>
          <div class="flex justify-between"><dt>Tip</dt><dd>${money(o.tip)}</dd></div>
          <div class="flex justify-between text-sm font-black text-slate-900"><dt>Total</dt><dd>${money(o.total)}</dd></div>
        </dl>
        <div class="flex items-center justify-between pt-2 border-t border-slate-100 text-xs">
          <span class="text-slate-600"><i class="fa-regular fa-credit-card mr-1" aria-hidden="true"></i>${esc(o.payment.label || 'Card')}</span>${payChip(o.payment)}
        </div>
        ${o.payment.status === 'authorized' ? `<p class="text-xs text-slate-500">${money(o.total)} is held on your card. You're charged when the cook marks it ready.</p>` : ''}
      </div>

      ${o.issue ? `<div class="card p-4 border-rose-200 bg-rose-50/50 text-xs space-y-1"><p class="font-bold text-rose-900">Problem reported: ${esc({ open: 'under review', refunded: 'refunded in full', dismissed: 'closed' }[o.issue.status] || o.issue.status)}</p><p class="text-rose-800">“${esc(o.issue.reason)}”</p></div>` : ''}

      ${o.canReview ? `
      <form data-form="review" data-code="${esc(o.code)}" class="card p-4 space-y-3">
        <p class="text-sm font-bold text-slate-900">How was it?</p>
        <fieldset class="flex gap-1" aria-label="Rating">
          ${[1, 2, 3, 4, 5].map(n => `<label class="cursor-pointer"><input type="radio" name="rating" value="${n}" class="peer sr-only" ${n === 5 ? 'checked' : ''}>
            <span class="w-11 h-11 rounded-xl border border-slate-200 flex items-center justify-center text-lg text-slate-300 peer-checked:text-amber-500 peer-checked:border-amber-300 peer-checked:bg-amber-50" aria-label="${n} star${n > 1 ? 's' : ''}">★<span class="sr-only">${n}</span></span></label>`).join('')}
        </fieldset>
        <textarea name="text" rows="2" maxlength="500" class="field" placeholder="Tell neighbors what you loved (optional)"></textarea>
        ${errorBox()}<button class="btn-dark" type="submit">Post review</button>
      </form>` : ''}
      ${o.review ? `<div class="card p-4 text-xs"><p class="font-bold text-slate-900">Your review <span class="text-amber-500 ml-1">${'★'.repeat(o.review.rating)}</span></p>${o.review.text ? `<p class="text-slate-600 mt-1">${esc(o.review.text)}</p>` : ''}</div>` : ''}

      <div class="space-y-2">
        ${o.canCancel ? `<button data-act="cancel-order" data-code="${esc(o.code)}" class="btn-ghost text-rose-700 border-rose-200">Cancel order</button>` : ''}
        ${o.canReport ? `<button data-act="report" data-code="${esc(o.code)}" class="btn-ghost"><i class="fa-solid fa-flag text-rose-600" aria-hidden="true"></i> Report a problem</button>` : ''}
      </div>
    </section>
    </div>`;
}

// ============ kitchen (cook) ============
const COOK_STATUS = {
  received: ['New order', 'bg-brand-100 text-brand-800', 'fa-bell'], preparing: ['Preparing', 'bg-amber-100 text-amber-800', 'fa-fire-burner'],
  ready: ['Ready', 'bg-emerald-100 text-emerald-800', 'fa-box'], completed: ['Done', 'bg-slate-100 text-slate-700', 'fa-check'],
  declined: ['Declined', 'bg-rose-100 text-rose-700', 'fa-ban'], canceled: ['Cancelled by customer', 'bg-rose-100 text-rose-700', 'fa-xmark']
};

async function kitchenView(query) {
  if (!S.me.user) {
    view.innerHTML = stateCard('fa-kitchen-set', 'Sell your cooking to neighbors', 'Set your own menu and prices. Customers pay upfront, and the money is held before you start cooking.',
      `<button data-act="start-cooking" class="btn-primary mt-4">Open your kitchen</button><button data-act="auth" data-mode="login" class="btn-ghost mt-2">I already have an account</button>`);
    return;
  }
  if (!S.me.chef) {
    view.innerHTML = stateCard('fa-kitchen-set', 'Open your kitchen on Chefy', 'Four quick steps: your kitchen profile, your food handler permit, where to send your money, and your first dish.',
      `<a href="#/kitchen/setup?step=1" class="btn-primary mt-4">Start setup</a>`);
    return;
  }
  const tab = query.get('tab') || 'orders';
  view.innerHTML = `<div class="space-y-3"><div class="skeleton h-24"></div>${skeletonList(2)}</div>`;
  const [sum, ords, dishes] = await Promise.all([api('/api/chef/summary'), api('/api/chef/orders'), api('/api/chef/dishes')]);
  S.me.chef = sum.chef;
  const c = sum.chef;
  const steps = [
    ['Kitchen profile', !!c.pickupAddress, '1'],
    ['Permit checked', c.permit.status === 'verified', '2', { none: 'Not sent', pending: 'Being reviewed', rejected: 'Needs a fix', verified: 'Checked' }[c.permit.status]],
    ['Payouts set up', c.payouts.ready, '3'],
    ['First dish listed', dishes.dishes.length > 0, '4']
  ];
  const setupDone = steps.every(s => s[1]);
  const newCount = ords.orders.filter(o => o.status === 'received').length;
  updateKitchenBadge(newCount);
  ords.orders.forEach(o => S.kitchenSeen.add(o.code)); store.set('chefy_kitchen_seen', [...S.kitchenSeen].slice(-300));

  view.innerHTML = `
    <section class="space-y-4">
      <div class="card p-4 space-y-3">
        <div class="flex items-center gap-3">
          ${avatar(c.avatarUrl, c.kitchenName, 'w-14 h-14 rounded-2xl')}
          <div class="flex-1 min-w-0">
            <h1 class="text-lg font-black text-slate-900 leading-tight truncate">${esc(c.kitchenName)}</h1>
            <p class="text-sm text-slate-500">${meta([stars(sum.rating.average, sum.rating.count), c.neighborhood ? esc(c.neighborhood) : ''])}</p>
          </div>
          <a href="#/kitchen/setup?step=1" class="w-11 h-11 rounded-xl border border-slate-200 flex items-center justify-center text-slate-600" aria-label="Edit kitchen profile"><i class="fa-solid fa-pen" aria-hidden="true"></i></a>
        </div>
        ${setupDone ? `
        <label class="flex items-center justify-between gap-3 pt-3 border-t border-slate-200">
          <span class="text-xs"><strong class="block text-sm ${c.acceptingOrders ? 'text-emerald-900' : 'text-slate-700'}">${c.acceptingOrders ? 'Open for orders' : 'Kitchen paused'}</strong>
            <span class="${c.acceptingOrders ? 'text-emerald-800' : 'text-slate-500'}">${c.acceptingOrders ? 'Your dishes are visible to customers.' : 'Customers can see your menu but can\'t order.'}</span></span>
          <input type="checkbox" data-change="accepting" ${c.acceptingOrders ? 'checked' : ''} class="w-6 h-6 accent-emerald-600" aria-label="Accepting orders">
        </label>` : `
        <div class="pt-3 border-t border-slate-200 space-y-1">
          <p class="text-sm font-bold text-amber-950">Finish setup to go live</p>
          ${steps.map(([label, ok, step, note]) => `<a href="#/kitchen/setup?step=${step}" class="flex items-center gap-2.5 text-xs h-9">
            <i class="fa-solid ${ok ? 'fa-circle-check text-emerald-600' : 'fa-circle text-amber-300'} text-base" aria-hidden="true"></i>
            <span class="flex-1 ${ok ? 'text-slate-500 line-through' : 'font-bold text-slate-900'}">${label}</span>
            ${note && !ok ? `<span class="text-amber-800">${note}</span>` : ''}${ok ? '' : '<i class="fa-solid fa-chevron-right text-slate-500" aria-hidden="true"></i>'}</a>`).join('')}
        </div>`}
      </div>

      <div class="-mx-4 px-4 md:mx-0 md:px-0 flex gap-3 overflow-x-auto hide-scrollbar snap-x md:grid md:grid-cols-4 md:gap-4 md:overflow-visible">
        ${[["Today's earnings", money(sum.stats.todayEarned), `${sum.stats.todayOrders} order${sum.stats.todayOrders === 1 ? '' : 's'} charged`],
           ['Active orders', sum.stats.activeOrders, newCount ? `${newCount} new` : 'All handled'],
           ['Dishes', sum.stats.dishes, `${sum.stats.liveDishes} available`],
           ['Balance', sum.balance ? money(sum.balance.available) : '—', 'Ready to cash out']]
          .map(([l, v, s]) => `<div class="snap-start shrink-0 w-36 md:w-auto card p-3.5 md:p-4 lg:p-5"><p class="text-xs font-semibold text-slate-500">${l}</p><p class="text-xl font-black text-slate-900 mt-0.5">${v}</p><p class="text-xs text-slate-500">${s}</p></div>`).join('')}
      </div>

      <div class="grid grid-cols-3 p-1 bg-slate-100 rounded-xl text-xs lg:text-sm font-bold sticky z-20 md:max-w-md lg:top-20" style="top: calc(3.5rem + env(safe-area-inset-top) + .5rem)" role="tablist">
        ${[['orders', `Orders${newCount ? ` (${newCount})` : ''}`], ['menu', 'Menu'], ['payouts', 'Payouts']].map(([k, l]) =>
          `<a role="tab" aria-selected="${tab === k}" href="#/kitchen?tab=${k}" class="py-2.5 text-center rounded-lg ${tab === k ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500'}">${l}</a>`).join('')}
      </div>
      <div id="kitchenTab">${tab === 'menu' ? menuTab(dishes.dishes) : tab === 'payouts' ? payoutsTab(sum) : ordersTab(ords.orders)}</div>
    </section>`;
}

function ordersTab(orders) {
  if (!orders.length) return stateCard('fa-bell-concierge', 'No orders yet', 'New orders show up here, with a badge on the Kitchen tab. Share your kitchen page with neighbors to get your first one.');
  return `<div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3 lg:gap-4 items-start">${orders.map(o => {
    const [label, cls, icon] = COOK_STATUS[o.status] || [o.status, 'bg-slate-100', 'fa-circle'];
    const act = (a, text, style) => `<button data-act="cook-order" data-a="${a}" data-code="${esc(o.code)}" class="flex-1 h-11 px-3 rounded-xl text-xs font-bold ${style}">${text}</button>`;
    return `
    <article class="card p-4 space-y-3 ${o.status === 'received' ? 'ring-2 ring-brand-500' : ''}">
      <div class="flex items-start justify-between gap-2">
        <div><p class="text-sm font-black text-slate-900">${esc(o.eater.name)}</p>
          <p class="text-xs text-slate-500">${meta([esc(o.code), timeAgo(o.times.created), o.fulfillment === 'delivery' ? 'Delivery' : 'Pickup'])}</p></div>
        <span class="chip ${cls}"><i class="fa-solid ${icon}" aria-hidden="true"></i> ${label}</span>
      </div>
      <div class="space-y-1">${o.items.map(i => `<div class="flex justify-between text-sm"><span>${i.qty}× ${esc(i.title)}</span><span class="font-semibold">${money(i.price * i.qty)}</span></div>`).join('')}</div>
      ${o.notes ? `<p class="text-sm pl-3 border-l-2 border-amber-400 text-amber-900"><i class="fa-solid fa-note-sticky mr-1" aria-hidden="true"></i>${esc(o.notes)}</p>` : ''}
      ${o.fulfillment === 'delivery' ? `<p class="text-xs text-slate-700"><i class="fa-solid fa-location-dot text-brand-600 mr-1" aria-hidden="true"></i>${esc(o.deliveryAddress)}</p>` : ''}
      ${o.eater.phone ? `<a href="tel:${esc(o.eater.phone)}" class="text-xs font-bold text-brand-700 inline-flex items-center gap-1 h-9"><i class="fa-solid fa-phone" aria-hidden="true"></i> ${esc(o.eater.phone)}</a>` : ''}
      ${o.issue && o.issue.status === 'open' ? `<p class="text-sm pl-3 border-l-2 border-rose-400 text-rose-800"><strong>Customer reported a problem:</strong> ${esc(o.issue.reason)}</p>` : ''}
      <div class="flex items-center justify-between text-xs pt-2 border-t border-slate-100">
        <span class="text-slate-600">You earn <strong class="text-emerald-700">${money(o.chefPayout)}</strong> <span class="text-slate-500">(${money(o.total)} total)</span></span>${payChip(o.payment)}
      </div>
      <div class="flex gap-2">
        ${o.status === 'received' ? act('decline', 'Decline', 'border border-rose-200 text-rose-700') + act('accept', 'Accept &amp; start', 'bg-brand-600 text-white') : ''}
        ${o.status === 'preparing' ? act('decline', 'Decline', 'border border-rose-200 text-rose-700') + act('ready', 'Mark ready', 'bg-emerald-600 text-white') : ''}
        ${o.status === 'ready' ? act('complete', o.fulfillment === 'delivery' ? 'Delivered' : 'Picked up', 'bg-slate-900 text-white') : ''}
        ${['ready', 'completed'].includes(o.status) && o.payment.status === 'captured' ? act('refund', 'Refund', 'border border-slate-200 text-slate-700') : ''}
      </div>
      ${o.status === 'preparing' ? `<p class="text-xs text-slate-500">Marking ready charges the customer's card.</p>` : ''}
    </article>`; }).join('')}</div>`;
}

function menuTab(dishes) {
  return `
    <button data-act="dish-new" class="btn-primary mb-3 lg:mb-4 lg:w-auto lg:px-6"><i class="fa-solid fa-plus" aria-hidden="true"></i> Add a dish</button>
    ${dishes.length ? `<div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3 lg:gap-4">${dishes.map(d => `
      <div class="card p-3 flex gap-3 items-center">
        ${dishImg(d.imageUrl, 'w-16 h-16 rounded-xl shrink-0')}
        <div class="flex-1 min-w-0"><p class="text-sm font-bold text-slate-900 line-clamp-1">${esc(d.title)}</p><p class="text-xs text-brand-700 font-bold">${money(d.price)} <span class="text-slate-500 font-normal ml-2">${dishCats(d).map(esc).join(', ')}</span></p>
          <label class="mt-1 inline-flex items-center gap-2 text-xs font-bold ${d.available ? 'text-emerald-700' : 'text-slate-500'}">
            <input type="checkbox" data-change="dish-available" data-id="${d.id}" ${d.available ? 'checked' : ''} class="w-5 h-5 accent-emerald-600"> ${d.available ? 'Available' : 'Sold out'}</label></div>
        <button data-act="dish-edit" data-id="${d.id}" class="w-11 h-11 rounded-xl border border-slate-200 text-slate-600" aria-label="Edit ${esc(d.title)}"><i class="fa-solid fa-pen" aria-hidden="true"></i></button>
      </div>`).join('')}</div>` : stateCard('fa-utensils', 'Your menu is empty', 'Add the dish you\'re known for. A good photo and a clear price sell the most.')}`;
}

function payoutsTab(sum) {
  const c = sum.chef, b = sum.balance || { available: 0, held: 0 };
  const demo = c.payouts.mode === 'demo';
  return `
    <div class="space-y-4 lg:space-y-0 lg:grid lg:grid-cols-[24rem_1fr] lg:gap-6 lg:items-start">
      <div class="space-y-4">
      <div class="rounded-2xl p-5 lg:p-6 bg-gradient-to-br from-slate-900 to-brand-950 text-white">
        <p class="text-xs font-semibold text-slate-300">Available to cash out</p>
        <p class="text-3xl font-black mt-1">${money(b.available)}</p>
        <p class="text-xs text-brand-200 mt-1">${money(b.held)} more is held on customers' cards for orders in progress.</p>
      </div>
      ${c.payouts.ready ? `
      <div class="grid grid-cols-2 gap-2">
        <button data-act="payout" data-instant="0" ${b.available > 0 ? '' : 'disabled'} class="card p-3 text-left">
          <p class="text-xs font-bold text-slate-900"><i class="fa-solid fa-building-columns text-brand-600 mr-1" aria-hidden="true"></i>Standard</p>
          <p class="text-xs text-slate-500 mt-0.5">Free, arrives in 1–2 business days</p></button>
        <button data-act="payout" data-instant="1" ${b.available > 0 ? '' : 'disabled'} class="card p-3 text-left">
          <p class="text-xs font-bold text-slate-900"><i class="fa-solid fa-bolt text-amber-500 mr-1" aria-hidden="true"></i>Instant</p>
          <p class="text-xs text-slate-500 mt-0.5">${demo ? '1.5% fee, arrives in minutes' : 'To a debit card, in minutes'}</p></button>
      </div>
      <div class="card p-4 flex items-center gap-3">
        <span class="w-10 h-10 rounded-xl bg-slate-100 flex items-center justify-center text-slate-600"><i class="fa-solid fa-building-columns" aria-hidden="true"></i></span>
        <div class="flex-1 text-xs"><p class="font-bold text-slate-900">${esc(c.payouts.bankLabel || 'Bank account on file')}</p><p class="text-slate-500">Where your money goes</p></div>
        ${demo ? `<a href="#/kitchen/setup?step=3" class="text-xs font-bold text-brand-700 h-11 flex items-center">Change</a>` : `<button data-act="stripe-dashboard" class="text-xs font-bold text-brand-700 h-11">Manage</button>`}
      </div>` : `
      <div class="card p-4 space-y-2"><p class="text-sm font-bold text-slate-900">Set up payouts to get paid</p>
        <p class="text-xs text-slate-600">${demo ? 'Add the bank account your earnings go to.' : 'Chefy uses Stripe to verify your identity and send money to your bank. It takes about 5 minutes.'}</p>
        <a href="#/kitchen/setup?step=3" class="btn-dark">Set up payouts</a></div>`}
      </div>
      <div class="card p-4 lg:p-5">
        <p class="text-sm font-bold text-slate-900 mb-1">Activity</p>
        <p class="text-xs text-slate-500 mb-2">Chefy keeps 10% of food sales. Tips are 100% yours.</p>
        ${sum.ledger.length ? `<div class="divide-y divide-slate-100">${sum.ledger.map(e => `
          <div class="flex items-center gap-3 py-2.5">
            <span class="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${e.kind === 'sale' ? 'bg-emerald-50 text-emerald-700' : e.kind === 'refund' ? 'bg-rose-50 text-rose-600' : 'bg-brand-50 text-brand-700'}">
              <i class="fa-solid ${e.kind === 'sale' ? 'fa-arrow-down' : e.kind === 'refund' ? 'fa-rotate-left' : 'fa-building-columns'} text-xs" aria-hidden="true"></i></span>
            <div class="flex-1 min-w-0"><p class="text-xs font-bold text-slate-900 truncate">${esc(e.title)}</p><p class="text-xs text-slate-500 truncate">${esc(e.detail)}</p></div>
            <div class="text-right"><p class="text-xs font-black ${e.amount > 0 ? 'text-emerald-700' : 'text-slate-900'}">${e.amount > 0 ? '+' : ''}${money(e.amount)}</p><p class="text-xs text-slate-500">${timeAgo(e.at)}</p></div>
          </div>`).join('')}</div>` : `<p class="text-xs text-slate-500 py-3">Charged orders, refunds and payouts will show up here.</p>`}
      </div>
    </div>`;
}

function updateKitchenBadge(n) {
  for (const el of [$('#kitchenBadge'), $('#kitchenBadgeD')]) {
    el.textContent = n;
    el.classList.toggle('hidden', !n); el.classList.toggle('flex', !!n);
  }
}

// ============ dish editor ============
function dishForm(d = {}, { submitLabel = 'Save dish', formName = 'dish' } = {}) {
  const cats = S.config.categories, diets = S.config.dietary;
  return `
    <form data-form="${formName}" data-id="${d.id || ''}" class="space-y-3" novalidate>
      <div class="flex items-center gap-3">
        <div id="dishPhotoPreview">${dishImg(d.imageUrl, 'w-20 h-20 rounded-xl')}</div>
        <div class="flex-1">
          <label class="btn-ghost cursor-pointer"><i class="fa-solid fa-camera" aria-hidden="true"></i> ${d.imageUrl ? 'Change photo' : 'Add a photo'}
            <input type="file" accept="image/*" data-change="upload-image" data-target="dishImage" data-preview="dishPhotoPreview" class="sr-only"></label>
          <input type="hidden" name="imageUrl" id="dishImage" value="${esc(d.imageUrl || '')}">
        </div>
      </div>
      <div><label class="label" for="dTitle">Dish name</label><input id="dTitle" name="title" required maxlength="80" value="${esc(d.title || '')}" class="field" placeholder="e.g. Pork red chile tamales (3 pack)"></div>
      <fieldset>
        <legend class="label">Categories <span class="font-normal text-slate-500">(up to 3)</span></legend>
        <div class="flex flex-wrap gap-2">${cats.map(c => `<label class="cursor-pointer">
          <input type="checkbox" name="categories" value="${esc(c)}" data-change="cat-limit" class="peer sr-only" ${(d.id ? dishCats(d) : []).includes(c) ? 'checked' : ''}>
          <span class="h-10 px-3.5 rounded-full text-sm font-bold flex items-center gap-1.5 bg-slate-100 text-slate-800 peer-checked:bg-brand-600 peer-checked:text-white peer-focus-visible:ring-2 peer-focus-visible:ring-brand-500"><i class="fa-solid ${CAT_ICONS[c] || 'fa-utensils'}" aria-hidden="true"></i>${esc(c)}</span></label>`).join('')}</div>
      </fieldset>
      <div><label class="label" for="dPrice">Price ($)</label><input id="dPrice" name="price" type="number" step="0.01" min="1" max="500" inputmode="decimal" required value="${d.price ? (d.price / 100).toFixed(2) : ''}" class="field" placeholder="14.50"></div>
      <div class="grid grid-cols-2 gap-3">
        <div><label class="label" for="dPrep">Ready in</label><input id="dPrep" name="prepTime" maxlength="30" value="${esc(d.prepTime || '')}" class="field" placeholder="25 min"></div>
        <div><label class="label" for="dDiet">Dietary</label><select id="dDiet" name="dietary" class="field"><option value="">None</option>${diets.map(c => `<option ${d.dietary === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div>
      </div>
      <div><label class="label" for="dDesc">Description</label><textarea id="dDesc" name="description" rows="3" maxlength="500" required class="field" placeholder="What's in it, how it's made, what comes with it">${esc(d.description || '')}</textarea></div>
      ${errorBox()}
      <button class="btn-primary" type="submit">${submitLabel}</button>
      ${d.id ? `<button type="button" data-act="dish-delete" data-id="${d.id}" class="btn-ghost text-rose-700 border-rose-200">Remove from menu</button>` : ''}
    </form>`;
}
async function openDishSheet(id) {
  let d = {};
  if (id) d = (await api('/api/chef/dishes')).dishes.find(x => x.id === Number(id)) || {};
  openSheet(sheetHeader(id ? 'Edit dish' : 'Add a dish') + `<div class="p-5">${dishForm(d)}</div>`, id ? 'Edit dish' : 'Add a dish');
}
async function saveDish(form, after) {
  const v = formValues(form);
  v.categories = new FormData(form).getAll('categories');
  if (!v.title.trim() || !v.price || !v.description.trim()) return showError(form, 'Add a name, a price and a short description.');
  if (!v.categories.length) return showError(form, 'Pick at least one category.');
  const btn = form.querySelector('button[type="submit"]');
  setBusy(btn, true, 'Saving…');
  try {
    const id = form.dataset.id;
    await api(id ? `/api/chef/dishes/${id}` : '/api/chef/dishes', { method: id ? 'PATCH' : 'POST', body: { ...v, price: Number(v.price) } });
    S.dishes = null;
    after ? after() : (closeSheet(true), toast(id ? 'Dish updated' : 'Dish added to your menu'), render());
  } catch (e) { setBusy(btn, false); showError(form, e.message); }
}

// ============ uploads ============
function readDataUrl(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
}
async function resizeImage(file, max) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const cv = document.createElement('canvas');
    cv.width = Math.round(bmp.width * scale); cv.height = Math.round(bmp.height * scale);
    cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
    return cv.toDataURL('image/jpeg', 0.85);
  } catch { return readDataUrl(file); }
}
async function upload(file, kind) {
  const dataUrl = file.type.startsWith('image/') ? await resizeImage(file, kind === 'permit' ? 2200 : 1400) : await readDataUrl(file);
  return api('/api/uploads', { method: 'POST', body: { dataUrl, kind } });
}

// ============ kitchen setup wizard ============
async function setupView(query) {
  if (!S.me.user) { view.innerHTML = signInPrompt('Open your kitchen', 'Create an account first, then set up your kitchen in four steps.'); return; }
  let step = Number(query.get('step') || 1);
  if (!S.me.chef && step > 1) step = 1;
  if (query.get('stripe') === 'return' || query.get('stripe') === 'refresh') {
    try { S.me = await api('/api/chef/stripe/refresh', { method: 'POST', body: {} }); } catch { /* shown below */ }
    step = 3;
  }
  const c = S.me.chef;
  const titles = ['Your kitchen', 'Food handler permit', 'Get paid', 'First dish'];
  const head = `
    <div class="mb-4">
      <a href="#/kitchen" class="inline-flex items-center gap-1.5 text-xs font-bold text-slate-600 h-11">Back to kitchen</a>
      <p class="text-xs font-bold text-brand-700">Step ${step} of 4</p>
      <h1 class="text-xl font-black text-slate-900">${titles[step - 1]}</h1>
      <div class="grid grid-cols-4 gap-1 mt-2" aria-hidden="true">${[1, 2, 3, 4].map(i => `<div class="h-1.5 rounded-full ${i <= step ? 'bg-brand-600' : 'bg-slate-200'}"></div>`).join('')}</div>
    </div>`;
  let body = '';
  if (step === 1) {
    body = `
      <p class="text-sm text-slate-600 mb-4">This is what customers see on your page. Your pickup address is only shown to people who have paid for an order.</p>
      <form data-form="setup-profile" class="space-y-3" novalidate>
        <div class="flex items-center gap-3">
          <div id="avatarPreview">${avatar(c?.avatarUrl, c?.kitchenName || S.me.user.name, 'w-16 h-16 rounded-2xl')}</div>
          <label class="btn-ghost flex-1 cursor-pointer"><i class="fa-solid fa-camera" aria-hidden="true"></i> Kitchen photo
            <input type="file" accept="image/*" data-change="upload-image" data-target="avatarUrl" data-preview="avatarPreview" class="sr-only"></label>
          <input type="hidden" name="avatarUrl" id="avatarUrl" value="${esc(c?.avatarUrl || '')}">
        </div>
        <div><label class="label" for="kName">Kitchen name</label><input id="kName" name="kitchenName" required maxlength="60" value="${esc(c?.kitchenName || '')}" class="field" placeholder="e.g. Abuela's Kitchen"></div>
        <div><label class="label" for="kCuisine">What you cook</label><input id="kCuisine" name="cuisine" maxlength="60" value="${esc(c?.cuisine || '')}" class="field" placeholder="e.g. Michoacán tamales"></div>
        <div><label class="label" for="kBio">Your story</label><textarea id="kBio" name="bio" rows="3" maxlength="600" class="field" placeholder="Where your recipes come from and what makes them yours">${esc(c?.bio || '')}</textarea></div>
        <div><label class="label" for="kHood">Neighborhood</label><input id="kHood" name="neighborhood" maxlength="60" value="${esc(c?.neighborhood || S.me.user.neighborhood || '')}" class="field" placeholder="e.g. Mission District"></div>
        <div><label class="label" for="kAddr">Pickup address</label><input id="kAddr" name="pickupAddress" required autocomplete="street-address" maxlength="200" value="${esc(c?.pickupAddress || '')}" class="field" placeholder="Street and number"></div>
        <div><label class="label" for="kNotes">Pickup instructions <span class="font-normal text-slate-500">(optional)</span></label><input id="kNotes" name="pickupNotes" maxlength="300" value="${esc(c?.pickupNotes || '')}" class="field" placeholder="e.g. Ring #2, I'll come down. Pickup 4–7pm."></div>
        <label class="flex items-center gap-3 p-3 rounded-xl border border-slate-200 text-sm"><input type="checkbox" name="offersDelivery" ${c?.offersDelivery ? 'checked' : ''} class="w-5 h-5 accent-blue-600"> I can deliver nearby myself</label>
        ${errorBox()}
        <button class="btn-primary" type="submit">${c ? 'Save' : 'Save and continue'}</button>
      </form>`;
  } else if (step === 2) {
    const p = c.permit;
    const banner = {
      pending: ['bg-sky-50 border-sky-200 text-sky-900', 'fa-hourglass-half', 'We\'re checking your permit. This usually takes 1 business day. You can keep setting up meanwhile.'],
      verified: ['bg-emerald-50 border-emerald-200 text-emerald-900', 'fa-circle-check', 'Your permit is checked. Customers see the verified badge on your page.'],
      rejected: ['bg-rose-50 border-rose-200 text-rose-900', 'fa-circle-exclamation', `We couldn't verify your permit${p.note ? ': ' + p.note : '.'} Upload a clearer photo or the right document.`]
    }[p.status];
    body = `
      <p class="text-sm text-slate-600 mb-4">Every Chefy cook needs a valid food handler card or cottage food permit. We check it by hand before your kitchen goes live.</p>
      ${banner ? `<div class="p-3 rounded-xl border text-xs mb-4 flex gap-2 ${banner[0]}"><i class="fa-solid ${banner[1]} mt-0.5" aria-hidden="true"></i><span>${esc(banner[2])}</span></div>` : ''}
      <form data-form="setup-permit" class="space-y-3" novalidate>
        <div><label class="label" for="pState">Issued in</label><select id="pState" name="state" class="field">${S.config.permitStates.map(s => `<option value="${s}" ${p.state === s ? 'selected' : ''}>${s === 'CA' ? 'California' : s === 'TX' ? 'Texas' : s === 'NY' ? 'New York' : s === 'FL' ? 'Florida' : 'Other'}</option>`).join('')}</select></div>
        <div><label class="label" for="pNum">Permit or card number</label><input id="pNum" name="number" required maxlength="60" value="${esc(p.number || '')}" class="field" placeholder="e.g. FHC-9823411"></div>
        <div><label class="label" for="pExp">Expires</label><input id="pExp" name="expiry" type="date" required value="${esc(p.expiry || '')}" class="field"></div>
        <div><span class="label">Photo or PDF of the permit</span>
          <label class="block border-2 border-dashed border-slate-300 rounded-2xl p-5 text-center cursor-pointer bg-slate-50">
            <i class="fa-solid fa-cloud-arrow-up text-2xl text-slate-500" aria-hidden="true"></i>
            <p id="permitFileLabel" class="text-sm font-bold text-slate-700 mt-1">${p.hasFile ? 'File on record. Tap to replace it.' : 'Take a photo or choose a file'}</p>
            <p class="text-xs text-slate-500">JPG, PNG or PDF up to 8 MB. Only Chefy staff can see it.</p>
            <input type="file" accept="image/*,application/pdf" data-change="upload-permit" class="sr-only"></label>
          <input type="hidden" name="file" id="permitFile" value=""></div>
        ${errorBox()}
        <button class="btn-primary" type="submit">${p.status === 'none' ? 'Send for review' : 'Send again'}</button>
        ${p.status !== 'none' ? `<a href="#/kitchen/setup?step=3" class="btn-ghost">Next: get paid</a>` : ''}
      </form>`;
  } else if (step === 3) {
    const demo = S.config.payments.mode === 'demo';
    body = demo ? `
      <p class="text-sm text-slate-600 mb-4">Where should your earnings go? You'll be able to cash out as soon as an order is charged.</p>
      ${c.payouts.ready ? `<div class="p-3 rounded-xl border bg-emerald-50 border-emerald-200 text-emerald-900 text-xs mb-4"><i class="fa-solid fa-circle-check mr-1" aria-hidden="true"></i>Payouts go to <strong>${esc(c.payouts.bankLabel)}</strong>.</div>` : ''}
      <form data-form="setup-bank" class="space-y-3" novalidate>
        <div><label class="label" for="bName">Bank</label><input id="bName" name="bank" required maxlength="40" class="field" placeholder="e.g. Checking at your bank"></div>
        <div class="grid grid-cols-2 gap-3">
          <div><label class="label" for="bRouting">Routing number</label><input id="bRouting" name="routing" inputmode="numeric" maxlength="9" required class="field" placeholder="9 digits"></div>
          <div><label class="label" for="bAccount">Account number</label><input id="bAccount" name="account" inputmode="numeric" maxlength="17" required class="field" placeholder="Account"></div>
        </div>
        <p class="text-xs text-slate-500">Demo payments mode: only the last 4 digits are stored. With Stripe connected, bank details are collected by Stripe and never touch Chefy.</p>
        ${errorBox()}
        <button class="btn-primary" type="submit">${c.payouts.ready ? 'Update bank account' : 'Save and continue'}</button>
        ${c.payouts.ready ? `<a href="#/kitchen/setup?step=4" class="btn-ghost">Next: first dish</a>` : ''}
      </form>` : `
      <p class="text-sm text-slate-600 mb-4">Chefy uses Stripe, the payments company, to verify your identity and send your earnings to your bank. You'll leave Chefy for about 5 minutes and come back here.</p>
      ${c.payouts.ready ? `<div class="p-3 rounded-xl border bg-emerald-50 border-emerald-200 text-emerald-900 text-xs mb-4"><i class="fa-solid fa-circle-check mr-1" aria-hidden="true"></i>Payouts are set up${c.payouts.bankLabel ? ` to <strong>${esc(c.payouts.bankLabel)}</strong>` : ''}.</div>`
        : c.payouts.stripeStarted ? `<div class="p-3 rounded-xl border bg-amber-50 border-amber-200 text-amber-900 text-xs mb-4">Stripe still needs a few details from you before you can take orders.</div>` : ''}
      <div class="space-y-2">
        ${c.payouts.ready ? `<button data-act="stripe-dashboard" class="btn-ghost">Manage bank account on Stripe</button><a href="#/kitchen/setup?step=4" class="btn-primary">Next: first dish</a>`
          : `<button data-act="stripe-onboard" class="btn-primary">${c.payouts.stripeStarted ? 'Continue with Stripe' : 'Set up payouts with Stripe'}</button>`}
      </div>`;
  } else {
    body = `<p class="text-sm text-slate-600 mb-4">Start with the dish people already ask you for. You can add more any time from the Menu tab.</p>${dishForm({}, { submitLabel: 'Add dish and finish', formName: 'setup-dish' })}
      <a href="#/kitchen" class="btn-ghost mt-2">Skip for now</a>`;
  }
  view.innerHTML = `<div class="lg:max-w-xl lg:mx-auto">${head}${body}</div>`;
}

// ============ account ============
async function accountView() {
  if (!S.me.user) {
    view.innerHTML = `<div class="card p-5 lg:p-8 lg:max-w-md lg:mx-auto lg:mt-6">${authForms(S.accountMode || 'signup')}</div>
      <a href="#/welcome" class="block text-center text-xs font-bold text-slate-500 mt-4 h-11">What is Chefy?</a>`;
    return;
  }
  const u = S.me.user;
  view.innerHTML = `
    <section class="space-y-4 lg:max-w-xl lg:mx-auto">
      <div class="card p-4 flex items-center gap-3">
        ${avatar(null, u.name, 'w-14 h-14 rounded-2xl')}
        <div class="min-w-0"><h1 class="text-lg font-black text-slate-900 truncate">${esc(u.name)}</h1><p class="text-xs text-slate-500 truncate">${esc(u.email)}</p></div>
      </div>
      <form data-form="profile" class="card p-4 space-y-3" novalidate>
        <div><label class="label" for="uName">Name</label><input id="uName" name="name" required maxlength="80" autocomplete="name" value="${esc(u.name)}" class="field"></div>
        <div><label class="label" for="uHood">Neighborhood</label><input id="uHood" name="neighborhood" maxlength="80" value="${esc(u.neighborhood || '')}" class="field" placeholder="e.g. Mission District"></div>
        <div><label class="label" for="uPhone">Phone <span class="font-normal text-slate-500">(shared with cooks you order from)</span></label><input id="uPhone" name="phone" type="tel" autocomplete="tel" maxlength="30" value="${esc(u.phone || '')}" class="field"></div>
        ${errorBox()}<button class="btn-dark" type="submit">Save changes</button>
      </form>
      <div class="card divide-y divide-slate-100">
        <a href="#/kitchen" class="flex items-center gap-3 p-4 text-sm font-bold text-slate-900"><i class="fa-solid fa-kitchen-set text-brand-600 w-5" aria-hidden="true"></i><span class="flex-1">${S.me.chef ? 'My kitchen' : 'Cook on Chefy'}</span><i class="fa-solid fa-chevron-right text-slate-500" aria-hidden="true"></i></a>
        ${u.isAdmin ? `<a href="#/admin" class="flex items-center gap-3 p-4 text-sm font-bold text-slate-900"><i class="fa-solid fa-user-shield text-brand-600 w-5" aria-hidden="true"></i><span class="flex-1">Admin: permits and refunds</span><i class="fa-solid fa-chevron-right text-slate-500" aria-hidden="true"></i></a>` : ''}
        <a href="#/welcome" class="flex items-center gap-3 p-4 text-sm font-bold text-slate-900"><i class="fa-solid fa-circle-info text-brand-600 w-5" aria-hidden="true"></i><span class="flex-1">How Chefy works</span><i class="fa-solid fa-chevron-right text-slate-500" aria-hidden="true"></i></a>
        <button data-act="logout" class="w-full flex items-center gap-3 p-4 text-sm font-bold text-rose-700"><i class="fa-solid fa-arrow-right-from-bracket w-5" aria-hidden="true"></i> Sign out</button>
      </div>
      ${S.config.payments.mode === 'demo' ? `<p class="text-xs text-center text-slate-500">This Chefy server is in demo payments mode: no real cards are charged.</p>` : ''}
    </section>`;
}

// ============ admin ============
async function adminView() {
  if (!S.me.user?.isAdmin) { view.innerHTML = stateCard('fa-lock', 'Admins only', 'This page is for Chefy staff.'); return; }
  view.innerHTML = `<div class="skeleton h-24"></div>`;
  const q = await api('/api/admin/queue');
  view.innerHTML = `
    <section class="space-y-4">
      <div class="grid grid-cols-2 gap-3 lg:max-w-xl">
        <div class="card p-3.5 lg:p-5"><p class="text-xs font-semibold text-slate-500">Paid orders</p><p class="text-xl font-black">${q.totals.orders}</p></div>
        <div class="card p-3.5"><p class="text-xs font-semibold text-slate-500">Chefy revenue</p><p class="text-xl font-black">${money(q.totals.revenue)}</p></div>
      </div>
      <div class="space-y-4 lg:space-y-0 lg:grid lg:grid-cols-2 lg:gap-6 lg:items-start"><div class="space-y-3">
      <h1 class="text-base font-bold text-slate-900">Permits to check (${q.permits.length})</h1>
      ${q.permits.length ? q.permits.map(p => `
        <div class="card p-4 space-y-2 text-xs">
          <p class="text-sm font-bold text-slate-900">${esc(p.kitchenName)}</p><p class="text-slate-600">${esc(p.name)}</p>
          <p class="text-slate-600">${esc(p.email)}</p>
          <p class="text-slate-700">${meta([esc(p.state), '#' + esc(p.number), 'expires ' + esc(p.expiry)])}</p>
          <a href="/api/files/${encodeURIComponent(p.file)}" target="_blank" rel="noopener" class="inline-flex items-center gap-1 font-bold text-brand-700 h-9"><i class="fa-solid fa-file-image" aria-hidden="true"></i> Open permit file</a>
          <div class="flex gap-2"><button data-act="permit" data-id="${p.chefId}" data-d="rejected" class="flex-1 h-11 rounded-xl border border-rose-200 text-rose-700 font-bold">Reject</button>
            <button data-act="permit" data-id="${p.chefId}" data-d="verified" class="flex-1 h-11 rounded-xl bg-emerald-600 text-white font-bold">Approve</button></div>
        </div>`).join('') : `<p class="text-sm text-slate-500">Nothing waiting.</p>`}
      </div><div class="space-y-3">
      <h2 class="text-base font-bold text-slate-900 pt-2 lg:pt-0">Problems reported (${q.issues.length})</h2>
      ${q.issues.length ? q.issues.map(o => `
        <div class="card p-4 space-y-2 text-xs">
          <p class="text-sm font-bold text-slate-900">${meta([esc(o.code), esc(o.chef.kitchenName), `<span class="font-normal text-slate-500 tabular-nums">${money(o.total)}</span>`])}</p>
          <p class="text-slate-600">Customer: ${esc(o.eater.name)}</p><p class="text-slate-600">${o.items.map(i => `${i.qty}× ${esc(i.title)}`).join(', ')}</p>
          <p class="pl-3 border-l-2 border-rose-400 text-rose-800">“${esc(o.issue.reason)}”</p>
          <div class="flex gap-2"><button data-act="issue" data-code="${esc(o.code)}" data-d="dismiss" class="flex-1 h-11 rounded-xl border border-slate-200 font-bold">Dismiss</button>
            <button data-act="issue" data-code="${esc(o.code)}" data-d="refund" class="flex-1 h-11 rounded-xl bg-rose-600 text-white font-bold">Refund ${money(o.total)}</button></div>
        </div>`).join('') : `<p class="text-sm text-slate-500">No open problems.</p>`}
      </div></div>
    </section>`;
}

function notFoundView() { view.innerHTML = stateCard('fa-map-signs', 'Page not found', 'That link doesn\'t go anywhere.', `<a href="#/" class="btn-dark mt-4">Go home</a>`); }

// ============ actions (event delegation) ============
const ACT = {
  'reload': () => render(),
  'close-sheet': () => closeSheet(),
  'open-basket': () => openBasket(),
  'add': el => addToBasket(Number(el.dataset.id)),
  'add-close': el => { if (addToBasket(Number(el.dataset.id)) !== false) closeSheet(); },
  'dish': el => openDish(Number(el.dataset.id)),
  'save': el => toggleSave(Number(el.dataset.id)),
  'fab': () => (S.me.chef ? openDishSheet() : openBasket()),
  'filters': () => openFilters(),
  'trend-go': el => trendScroll(Number(el.dataset.i)),
  'trend-step': el => trendScroll(trendIndex() + Number(el.dataset.d)),
  'see-all': () => { S.showAll = true; renderDishList(); },
  'filter-sort': el => setFilters({ sort: el.dataset.v }),
  'filter-diet': el => setFilters({ dietary: el.dataset.v }),
  'filter-reset': () => setFilters({ ...DEFAULT_FILTERS }),
  'qty': el => changeQty(Number(el.dataset.id), Number(el.dataset.d)),
  'fulfill': el => { S.basket.fulfillment = el.dataset.v; saveBasket(); renderBasketSheet(); },
  'tip': el => { S.basket.tip = Number(el.dataset.v); saveBasket(); renderBasketSheet(); },
  'auth': el => openAuthSheet('', el.dataset.mode),
  'auth-mode': el => {
    const body = $('#authBody');
    if (body) body.innerHTML = authForms(el.dataset.mode, S.authReason);
    else { S.accountMode = el.dataset.mode; accountView(); }
  },
  'welcome-browse': () => { store.set('chefy_seen_welcome', true); go('#/'); },
  'welcome-signup': () => { store.set('chefy_seen_welcome', true); requireAuth(() => go('#/'), ''); },
  'start-cooking': () => { store.set('chefy_seen_welcome', true); requireAuth(() => go('#/kitchen/setup?step=1'), 'Create an account to open your kitchen.'); },
  'logout': async () => { await api('/api/auth/logout', { method: 'POST', body: {} }); S.me = { user: null, chef: null }; updateKitchenBadge(0); toast('Signed out'); go('#/'); },
  'cancel-order': async el => {
    if (!confirm('Cancel this order? The hold on your card will be released.')) return;
    try { await api(`/api/orders/${el.dataset.code}/cancel`, { method: 'POST', body: {} }); toast('Order cancelled'); render(); } catch (e) { toast(e.message); render(); }
  },
  'report': el => openSheet(sheetHeader('Report a problem', 'Chefy reviews every report, usually within a day.') + `
    <form data-form="issue" data-code="${esc(el.dataset.code)}" class="p-5 space-y-3" novalidate>
      <label class="label" for="iReason">What went wrong?</label>
      <textarea id="iReason" name="reason" rows="4" maxlength="500" required class="field" placeholder="e.g. One of the three tamales was missing, and the order was cold."></textarea>
      <p class="text-xs text-slate-500">If the food was wrong, missing or not safe to eat, you'll get a full refund to your card.</p>
      ${errorBox()}<button class="btn-dark" type="submit">Send report</button>
    </form>`, 'Report a problem'),
  'cook-order': async el => {
    const a = el.dataset.a;
    const ask = { decline: 'Decline this order? The customer\'s card hold is released and they aren\'t charged.', refund: 'Refund this order in full? Your earnings for it are taken back.' }[a];
    if (ask && !confirm(ask)) return;
    el.disabled = true;
    try {
      await api(`/api/chef/orders/${el.dataset.code}/${a}`, { method: 'POST', body: {} });
      toast({ accept: 'Order accepted. Start cooking!', ready: 'Marked ready. The card was charged.', complete: 'Order done', decline: 'Order declined', refund: 'Customer refunded' }[a]);
    } catch (e) { toast(e.message); }
    render();
  },
  'dish-new': () => openDishSheet(),
  'dish-edit': el => openDishSheet(el.dataset.id),
  'dish-delete': async el => {
    if (!confirm('Remove this dish from your menu?')) return;
    try { await api(`/api/chef/dishes/${el.dataset.id}`, { method: 'DELETE', body: {} }); S.dishes = null; closeSheet(true); toast('Dish removed'); render(); } catch (e) { toast(e.message); }
  },
  'payout': async el => {
    const instant = el.dataset.instant === '1';
    if (!confirm(instant ? 'Send your balance now with an instant payout?' : 'Send your balance to your bank? It arrives in 1–2 business days.')) return;
    el.disabled = true;
    try { const r = await api('/api/chef/payouts', { method: 'POST', body: { instant } }); toast(`${money(r.amount - (r.fee || 0))} on its way`); } catch (e) { toast(e.message); }
    render();
  },
  'stripe-onboard': async el => { setBusy(el, true, 'Opening Stripe…'); try { location.href = (await api('/api/chef/stripe/onboard', { method: 'POST', body: {} })).url; } catch (e) { setBusy(el, false); toast(e.message); } },
  'stripe-dashboard': async el => { try { window.open((await api('/api/chef/stripe/dashboard', { method: 'POST', body: {} })).url, '_blank', 'noopener'); } catch (e) { toast(e.message); } },
  'permit': async el => {
    let note = '';
    if (el.dataset.d === 'rejected') { note = prompt('Why? The cook will see this.') || ''; if (!note) return; }
    try { await api(`/api/admin/permits/${el.dataset.id}`, { method: 'POST', body: { decision: el.dataset.d, note } }); toast(el.dataset.d === 'verified' ? 'Permit approved' : 'Permit rejected'); } catch (e) { toast(e.message); }
    render();
  },
  'issue': async el => {
    if (el.dataset.d === 'refund' && !confirm('Refund this order in full?')) return;
    try { await api(`/api/admin/issues/${el.dataset.code}`, { method: 'POST', body: { decision: el.dataset.d } }); toast(el.dataset.d === 'refund' ? 'Refunded' : 'Dismissed'); } catch (e) { toast(e.message); }
    render();
  }
};

const FORMS = {
  async signup(f) {
    const v = formValues(f), btn = f.querySelector('button[type="submit"]');
    setBusy(btn, true, 'Creating account…');
    try { await afterSignedIn(await api('/api/auth/signup', { method: 'POST', body: v }), true); } catch (e) { setBusy(btn, false); showError(f, e.message); }
  },
  async login(f) {
    const v = formValues(f), btn = f.querySelector('button[type="submit"]');
    setBusy(btn, true, 'Signing in…');
    try { await afterSignedIn(await api('/api/auth/login', { method: 'POST', body: v }), false); } catch (e) { setBusy(btn, false); showError(f, e.message); }
  },
  checkout(f) {
    if (S.me.user) return startCheckout(f);
    requireAuth(() => { openBasket(); startCheckout($('form[data-form="checkout"]')); }, 'Create an account or sign in to place your order.');
  },
  pay: submitPayment,
  async review(f) {
    const v = formValues(f), btn = f.querySelector('button[type="submit"]');
    setBusy(btn, true, 'Posting…');
    try { await api(`/api/orders/${f.dataset.code}/review`, { method: 'POST', body: { rating: Number(v.rating), text: v.text } }); toast('Thanks for the review!'); render(); } catch (e) { setBusy(btn, false); showError(f, e.message); }
  },
  async issue(f) {
    const v = formValues(f), btn = f.querySelector('button[type="submit"]');
    setBusy(btn, true, 'Sending…');
    try { await api(`/api/orders/${f.dataset.code}/issue`, { method: 'POST', body: v }); closeSheet(true); toast('Report sent. We\'ll review it shortly.'); render(); } catch (e) { setBusy(btn, false); showError(f, e.message); }
  },
  async profile(f) {
    const btn = f.querySelector('button[type="submit"]');
    setBusy(btn, true, 'Saving…');
    try { S.me = await api('/api/me', { method: 'PATCH', body: formValues(f) }); toast('Saved'); render(); } catch (e) { setBusy(btn, false); showError(f, e.message); }
  },
  dish: f => saveDish(f),
  'setup-dish': f => saveDish(f, () => { toast('Dish added. Your kitchen is set up!'); go('#/kitchen?tab=menu'); }),
  async 'setup-profile'(f) {
    const v = formValues(f), btn = f.querySelector('button[type="submit"]');
    if (!v.kitchenName.trim() || !v.pickupAddress.trim()) return showError(f, 'Add your kitchen name and pickup address.');
    const isNew = !S.me.chef;
    setBusy(btn, true, 'Saving…');
    try {
      S.me = await api('/api/chef', { method: 'POST', body: { ...v, offersDelivery: !!v.offersDelivery } });
      toast('Kitchen saved');
      go(isNew ? '#/kitchen/setup?step=2' : '#/kitchen');
    } catch (e) { setBusy(btn, false); showError(f, e.message); }
  },
  async 'setup-permit'(f) {
    const v = formValues(f), btn = f.querySelector('button[type="submit"]');
    if (!v.number.trim() || !v.expiry) return showError(f, 'Add the permit number and expiry date.');
    if (!v.file) return showError(f, 'Add a photo or PDF of your permit.');
    setBusy(btn, true, 'Sending…');
    try { S.me = await api('/api/chef/permit', { method: 'POST', body: v }); toast('Permit sent for review'); go('#/kitchen/setup?step=3'); } catch (e) { setBusy(btn, false); showError(f, e.message); }
  },
  async 'setup-bank'(f) {
    const btn = f.querySelector('button[type="submit"]');
    setBusy(btn, true, 'Saving…');
    try { S.me = await api('/api/chef/bank', { method: 'POST', body: formValues(f) }); toast('Bank account saved'); go('#/kitchen/setup?step=4'); } catch (e) { setBusy(btn, false); showError(f, e.message); }
  }
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = ACT[el.dataset.act];
  if (fn) { e.preventDefault(); fn(el, e); }
});
document.addEventListener('submit', e => {
  const f = e.target.closest('form[data-form]');
  if (!f) return;
  e.preventDefault();
  f.querySelector('[data-error]')?.classList.add('hidden');
  FORMS[f.dataset.form]?.(f);
});
let searchT;
document.addEventListener('input', e => {
  const el = e.target, k = el.dataset.input;
  if (k === 'search') { S.searchQ = el.value; clearTimeout(searchT); searchT = setTimeout(() => renderDishList(), 120); }
  else if (k === 'basket-address') { S.basket.address = el.value; saveBasket(); }
  else if (k === 'basket-notes') { S.basket.notes = el.value; saveBasket(); }
  else if (k === 'digits') el.value = el.value.replace(/\D/g, '');
  else if (k === 'cc-exp') { let d = el.value.replace(/\D/g, '').slice(0, 4); if (d.length === 1 && +d > 1) d = '0' + d; el.value = d.length > 2 ? d.slice(0, 2) + '/' + d.slice(2) : d; }
  else if (k === 'cc-number') {
    const d = el.value.replace(/\D/g, '').slice(0, 19), b = cardBrand(d);
    const groups = b === 'amex' ? [4, 6, 5] : [4, 4, 4, 4, 3]; const out = []; let p = 0;
    for (const g of groups) { if (p >= d.length) break; out.push(d.slice(p, p + g)); p += g; }
    el.value = out.join(' ');
    $('#ccBrand').className = `${BRANDS[b][1]} absolute right-4 top-1/2 -translate-y-1/2 text-xl`;
  }
});
document.addEventListener('change', async e => {
  const el = e.target, k = el.dataset.change;
  if (!k) return;
  if (k === 'upload-image' && el.files[0]) {
    const prev = $('#' + el.dataset.preview);
    prev.innerHTML = `<div class="w-16 h-16 rounded-xl skeleton"></div>`;
    try { const r = await upload(el.files[0], 'image'); $('#' + el.dataset.target).value = r.url; prev.innerHTML = `<img src="${esc(r.url)}" alt="" class="w-20 h-20 rounded-xl object-cover">`; }
    catch (err) { prev.innerHTML = ''; toast(err.message); }
  } else if (k === 'upload-permit' && el.files[0]) {
    const label = $('#permitFileLabel'); label.textContent = 'Uploading…';
    try { const r = await upload(el.files[0], 'permit'); $('#permitFile').value = r.file; label.textContent = `Attached: ${el.files[0].name}`; }
    catch (err) { label.textContent = 'Take a photo or choose a file'; toast(err.message); }
  } else if (k === 'cat-limit') {
    const picked = el.form.querySelectorAll('input[name="categories"]:checked');
    if (picked.length > 3) { el.checked = false; toast('Pick up to 3 categories'); }
  } else if (k === 'filter-avail') {
    setFilters({ availableOnly: el.checked });
  } else if (k === 'dish-available') {
    try { await api(`/api/chef/dishes/${el.dataset.id}`, { method: 'PATCH', body: { available: el.checked } }); S.dishes = null; toast(el.checked ? 'Dish available' : 'Marked sold out'); render(); }
    catch (err) { el.checked = !el.checked; toast(err.message); }
  } else if (k === 'accepting') {
    try { S.me = await api('/api/chef', { method: 'POST', body: { acceptingOrders: el.checked } }); S.dishes = null; toast(el.checked ? 'Kitchen open for orders' : 'Kitchen paused'); render(); }
    catch (err) { el.checked = !el.checked; toast(err.message); }
  }
});

// ============ live updates ============
// Refresh order screens every few seconds while the app is open (only when nobody is typing).
setInterval(async () => {
  if (document.hidden || !S.me.user) return;
  const busy = $('#sheetRoot').firstChild || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
  const { parts, query } = route();
  if (S.me.chef) {
    try {
      const { orders } = await api('/api/chef/orders');
      const fresh = orders.filter(o => o.status === 'received');
      updateKitchenBadge(fresh.length);
      const unseen = fresh.filter(o => !S.kitchenSeen.has(o.code));
      if (unseen.length) {
        unseen.forEach(o => S.kitchenSeen.add(o.code));
        store.set('chefy_kitchen_seen', [...S.kitchenSeen].slice(-300));
        toast(`New order from ${unseen[0].eater.name}`);
        if (navigator.vibrate) navigator.vibrate([20, 60, 20]);
        if (parts[0] === 'kitchen' && !parts[1] && (query.get('tab') || 'orders') === 'orders' && !busy) render();
      }
    } catch { /* offline: try next tick */ }
  }
  if (!busy && parts[0] === 'orders') render();
}, 8000);

// ============ boot ============
window.addEventListener('hashchange', render);
(async function boot() {
  try {
    [S.config, S.me] = await Promise.all([api('/api/config'), api('/api/me')]);
  } catch (e) {
    view.innerHTML = stateCard('fa-plug-circle-xmark', 'Chefy can\'t connect', esc(e.message), `<button data-act="reload" class="btn-dark mt-4">Try again</button>`);
    ACT.reload = () => location.reload();
    return;
  }
  render();
})();
