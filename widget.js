'use strict';
// Widget page. Runs sandboxed with no Node access; the only bridge is
// window.usage from preload.js. All text is set with textContent, never HTML.

const $ = (id) => document.getElementById(id);
let current = null;
let tickers = [];        // { el, resetsAt } for the per-second countdowns
let paceTickers = [];    // { el, eta, from }
let lastHeight = 0;

const level = (p) => (p >= 95 ? 'bad' : p >= 80 ? 'warn' : p >= 50 ? 'mid' : 'ok');

function countdown(ms) {
  if (ms <= 0) return 'now';
  const totalMin = Math.floor(ms / 60000);
  const d = Math.floor(totalMin / 1440), h = Math.floor((totalMin % 1440) / 60), m = totalMin % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (totalMin >= 1) return `${m}m`;
  return `${Math.max(0, Math.floor(ms / 1000))}s`;
}

function resetWhen(t) {
  const d = new Date(t);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

function money(n, cur) {
  try { return new Intl.NumberFormat([], { style: 'currency', currency: cur }).format(n); }
  catch { return `$${n.toFixed(2)}`; }
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function bar(label, pct, subText) {
  const row = el('div', 'row');
  const head = el('div', 'top');
  head.append(el('span', 'label', label), el('span', 'pct', `${Math.round(pct)}%`));
  const track = el('div', 'track');
  track.setAttribute('role', 'progressbar');
  track.setAttribute('aria-label', label);
  track.setAttribute('aria-valuenow', String(Math.round(pct)));
  track.setAttribute('aria-valuemin', '0');
  track.setAttribute('aria-valuemax', '100');
  const fill = el('div', `fill lvl-${level(pct)}`);
  fill.style.width = `${Math.max(1.5, pct)}%`;
  track.append(fill);
  const sub = el('div', 'sub');
  const left = el('span', null, subText);
  sub.append(left);
  row.append(head, track, sub);
  return { row, sub, left };
}

// Builds the DOM. Called only when new state arrives (each poll), not every second.
function build() {
  const s = current;
  const body = $('body');
  tickers = [];
  paceTickers = [];
  body.replaceChildren();
  if (!s) return;

  $('plan').textContent = s.plan || '';
  const top = s.buckets.find(b => b.key === 'five_hour') || s.buckets[0];
  $('dot').className = 'dot' + (s.status === 'ok' && top ? ` lvl-${level(top.percent)}` : '');

  if (s.status === 'signed-out') {
    body.append(el('p', 'muted', 'Sign in with your Claude account to see your session and weekly limits.'));
    const btn = el('button', 'signin', 'Sign in to Claude');
    btn.type = 'button';
    btn.addEventListener('click', () => window.usage.signIn());
    body.append(btn);
  } else if (s.status === 'loading' && !s.buckets.length) {
    body.append(el('p', 'muted', 'Loading…'));
  } else {
    if (s.error) body.append(el('p', 'error', s.error));
    if (!s.buckets.length && s.status !== 'error') body.append(el('p', 'muted', 'No limits reported for this account.'));
    for (const b of s.buckets) {
      const { row, sub, left } = bar(b.label, b.percent, '');
      if (b.resetsAt) tickers.push({ el: left, resetsAt: b.resetsAt }); else left.textContent = 'No active window';
      const eta = s.pace && s.pace[b.key];
      if (b.percent >= 100) {
        sub.append(el('span', 'pace bad', 'Limit reached'));
      } else if (eta != null && eta > 0) {
        const p = el('span', 'pace warn');
        sub.append(p);
        paceTickers.push({ el: p, eta, from: s.updatedAt });
      }
      body.append(row);
    }
    // Included credit allowances, e.g. cloud session credits: "$250 of $250 left".
    for (const c of s.credits || []) {
      const { row, sub } = bar(c.label, c.percent, `${money(c.remaining, c.currency)} of ${money(c.limit, c.currency)} left`);
      body.append(row);
      if (c.expiresAt) {
        sub.append(el('span', 'muted-right', `Expires ${resetWhen(c.expiresAt)}`));
      }
    }
    if (s.extra && s.extra.enabled) {
      const pct = Math.min(100, (s.extra.used / s.extra.limit) * 100);
      body.append(bar('Usage credits this month', pct, `${money(s.extra.used, s.extra.currency)} of ${money(s.extra.limit, s.extra.currency)}`).row);
    }
  }
  tick();
  requestAnimationFrame(sendHeight);
}

// Per-second update: only text changes, so nothing is recreated.
function tick() {
  const now = Date.now();
  for (const t of tickers) {
    const text = `Resets in ${countdown(t.resetsAt - now)} · ${resetWhen(t.resetsAt)}`;
    if (t.el.textContent !== text) t.el.textContent = text;
  }
  // Hide the pace estimate if the data is stale (several missed polls).
  const stale = current && current.updatedAt && now - current.updatedAt > 10 * 60000;
  for (const p of paceTickers) {
    const left = p.eta - (now - p.from);
    p.el.hidden = stale || left <= 0;
    p.el.className = left < 30 * 60000 ? 'pace bad' : 'pace warn';
    const text = `Full in ~${countdown(left)}`;
    if (p.el.textContent !== text) p.el.textContent = text;
  }
  if (current && current.updatedAt) {
    const text = `Updated ${new Date(current.updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    if ($('updated').textContent !== text) $('updated').textContent = text;
  }
}

function sendHeight() {
  const h = $('card').offsetHeight + 16;
  if (h !== lastHeight) { lastHeight = h; window.usage.resize(h); }
}

window.usage.onState((s) => {
  current = s;
  $('refresh').classList.remove('spin');
  build();
});

$('refresh').addEventListener('click', () => { $('refresh').classList.add('spin'); window.usage.refresh(); });
$('hide').addEventListener('click', () => window.usage.hide());
$('menu').addEventListener('click', () => window.usage.menu());
document.addEventListener('contextmenu', (e) => { e.preventDefault(); window.usage.menu(); });
// Block dropped files/links from doing anything.
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

// Countdowns tick every second, but not while the widget is hidden.
setInterval(() => { if (!document.hidden) tick(); }, 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
