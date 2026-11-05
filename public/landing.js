'use strict';
// Old links (/#/orders/..., Stripe return links) belong to the app, which now lives at /app.
if (location.hash.startsWith('#/')) location.replace('/app' + location.hash);
document.documentElement.classList.add('js');

// "How an order works": the order ticket follows the panel being read. Without script it shows step 1
// and every panel stays readable; with reduced motion the swap still happens, just without a fade.
document.addEventListener('DOMContentLoaded', () => {
  // Rail: previous / next for mouse and keyboard users (touch can swipe)
  const rail = document.querySelector('.rail');
  if (rail) {
    const btns = document.querySelectorAll('[data-rail]');
    const step = () => Math.max(rail.clientWidth * 0.8, 280);
    const sync = () => btns.forEach(b => { b.hidden = rail.scrollWidth <= rail.clientWidth + 4; b.disabled = Number(b.dataset.rail) < 0 ? rail.scrollLeft < 4 : rail.scrollLeft + rail.clientWidth >= rail.scrollWidth - 4; });
    btns.forEach(b => b.addEventListener('click', () => rail.scrollBy({ left: Number(b.dataset.rail) * step(), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })));
    rail.addEventListener('scroll', sync, { passive: true });
    addEventListener('resize', sync);
    sync();
  }

  const ticket = document.querySelector('.ticket');
  const panels = document.querySelectorAll('.panel');
  if (!ticket || !panels.length) return;
  // Stacked layout: the ticket sits above the steps, so it shows the moment that matters, charged when ready.
  if (matchMedia('(max-width: 60rem)').matches || !('IntersectionObserver' in window)) { ticket.dataset.step = '3'; return; }
  const io = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (e.isIntersecting) {
        ticket.dataset.step = e.target.dataset.step;
        panels.forEach(p => p.classList.toggle('is-current', p === e.target));
      }
    }
  }, { rootMargin: '-45% 0px -45% 0px' });
  panels.forEach(p => io.observe(p));
});
