'use strict';
// Pure helpers with no Electron dependency, so they can be unit-tested and
// reused by the build script.

// ---------------------------------------------------------------- organizations
function orgIdOf(o) { return (o && (o.uuid || o.organization_uuid || o.id)) || null; }

// Prefer the org that hosts the chat product; fall back to the first one.
function pickOrg(payload) {
  const orgs = (Array.isArray(payload) ? payload
    : Array.isArray(payload && payload.organizations) ? payload.organizations : [])
    .filter(o => o && typeof o === 'object');
  const chat = orgs.filter(o => Array.isArray(o.capabilities) && o.capabilities.includes('chat'));
  return (chat.length ? chat : orgs)[0] || null;
}

function planLabel(org) {
  const caps = Array.isArray(org && org.capabilities) ? org.capabilities : [];
  const tier = String((org && org.rate_limit_tier) || '').toLowerCase();
  if (tier.includes('20x')) return 'Max 20x';
  if (tier.includes('5x')) return 'Max 5x';
  if (caps.includes('claude_max')) return 'Max';
  if (tier.includes('enterprise') || caps.includes('enterprise')) return 'Enterprise';
  if (tier.includes('team') || caps.includes('raven')) return 'Team';
  if (caps.includes('claude_pro') || tier.includes('pro')) return 'Pro';
  if (tier.includes('free') || tier === 'default_claude_ai') return 'Free';
  return null;
}

// ---------------------------------------------------------------- usage
// The usage endpoint returns two shapes side by side:
//  - "limits": [{ kind: 'session' | 'weekly_all' | 'weekly_scoped', percent, resets_at, scope }]
//    This is what claude.ai's own usage page shows, so it's preferred.
//  - flat buckets (five_hour, seven_day, seven_day_opus, ...) for older accounts,
//    plus many internal code-named entries (e.g. "iguana_necktie") that are null
//    or are credit allowances. Unknown code names are never shown as limits.
const FLAT = Object.assign(Object.create(null), {
  five_hour: 'Current session',
  seven_day: 'Weekly · all models',
  seven_day_opus: 'Weekly · Opus',
  seven_day_sonnet: 'Weekly · Sonnet',
  seven_day_omelette: 'Weekly · Claude Design',
});
// Credit allowances whose code name we know (claude.ai's own label).
const CREDIT_LABELS = Object.assign(Object.create(null), {
  iguana_necktie: 'Cloud session credits',
});
// Keys that must never be used as plain-object property names.
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const ORDER = ['five_hour', 'seven_day'];

const clampPct = (n) => Math.max(0, Math.min(100, n));
const parseTime = (t) => (t ? Date.parse(t) || null : null);
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

function normalizeUsage(usage) {
  const u = isObj(usage) ? usage : {};
  const byKey = new Map();
  const add = (key, label, pct, resetsAt) => {
    const n = Number(pct);
    if (pct == null || !Number.isFinite(n) || UNSAFE_KEYS.has(key) || byKey.has(key)) return;
    byKey.set(key, { key, label, percent: clampPct(n), resetsAt: parseTime(resetsAt) });
  };

  // 1. The limits list (what claude.ai shows).
  for (const l of Array.isArray(u.limits) ? u.limits : []) {
    if (!isObj(l)) continue;
    if (l.kind === 'session') add('five_hour', FLAT.five_hour, l.percent, l.resets_at);
    else if (l.kind === 'weekly_all') add('seven_day', FLAT.seven_day, l.percent, l.resets_at);
    else if (l.kind === 'weekly_scoped') {
      const scope = isObj(l.scope) ? l.scope : {};
      const name = String((isObj(scope.model) && scope.model.display_name) || (isObj(scope.surface) && scope.surface.display_name) || '').trim().slice(0, 40);
      if (!name) continue;
      // claude.ai hides per-model weekly limits until they're in use; so do we.
      if (!(Number(l.percent) > 0)) continue;
      add(`weekly_${slug(name)}`, `Weekly · ${name}`, l.percent, l.resets_at);
    }
  }
  // 2. Flat buckets, only for known names the list didn't already cover.
  for (const [key, label] of Object.entries(FLAT)) {
    const b = u[key];
    if (!isObj(b)) continue;
    const scopedKey = key === 'seven_day_opus' ? 'weekly_opus' : key === 'seven_day_sonnet' ? 'weekly_sonnet' : key;
    if (byKey.has(scopedKey)) continue;
    if (key.startsWith('seven_day_') && !(Number(b.utilization) > 0)) continue;
    add(key, label, b.utilization, b.resets_at);
  }
  const rank = (k) => { const i = ORDER.indexOf(k); return i < 0 ? 99 : i; };
  const buckets = [...byKey.values()].sort((a, b) => rank(a.key) - rank(b.key) || a.label.localeCompare(b.label));

  // 3. Included credit allowances (dollar amounts, e.g. cloud session credits).
  const credits = [];
  for (const [key, b] of Object.entries(u)) {
    if (UNSAFE_KEYS.has(key) || !isObj(b) || key in FLAT) continue;
    const limit = Number(b.limit_dollars);
    if (b.limit_dollars == null || !Number.isFinite(limit) || limit <= 0) continue;
    const used = Number.isFinite(Number(b.used_dollars)) ? Number(b.used_dollars) : 0;
    const remaining = Number.isFinite(Number(b.remaining_dollars)) ? Number(b.remaining_dollars) : Math.max(0, limit - used);
    credits.push({
      key,
      label: typeof CREDIT_LABELS[key] === 'string' ? CREDIT_LABELS[key] : 'Included credit',
      used, limit, remaining,
      percent: clampPct((used / limit) * 100),
      expiresAt: parseTime(b.resets_at),
      currency: 'USD',
    });
  }

  // 4. Usage credits (pay-as-you-go), shown only when turned on.
  let extra = null;
  const ex = u.extra_usage;
  if (isObj(ex) && ex.used_credits != null && ex.monthly_limit != null && Number(ex.monthly_limit) > 0) {
    extra = {
      enabled: Boolean(ex.is_enabled),
      used: Number(ex.used_credits) / 100,   // API reports cents
      limit: Number(ex.monthly_limit) / 100,
      currency: typeof ex.currency === 'string' ? ex.currency.slice(0, 3) : 'USD',
    };
  }
  return { buckets, credits, extra };
}

// The API's resets_at jitters by a second or so between reads.
function sameWindow(a, b) { return a === b || (a != null && b != null && Math.abs(a - b) < 60000); }
const windowKey = (b) => `${b.key}|${b.resetsAt ? Math.round(b.resetsAt / 60000) : 'none'}`;

// ---------------------------------------------------------------- pace
// Projects when a limit hits 100% from how fast it rose over the last hour of
// this window. Needs ~10 minutes of readings. Returns ms, or null when it
// won't fill before it resets.
function updatePace(samples, buckets, now = Date.now()) {
  const out = Object.create(null);
  const live = new Set(buckets.map(b => b.key));
  for (const k of Object.keys(samples)) if (!live.has(k)) delete samples[k];
  for (const b of buckets) {
    let list = samples[b.key] || [];
    if (list.length && !sameWindow(list[list.length - 1].resetsAt, b.resetsAt)) list = [];
    list.push({ t: now, pct: b.percent, resetsAt: b.resetsAt });
    list = list.filter(s => now - s.t <= 60 * 60000);
    samples[b.key] = list;
    const first = list[0];
    const dt = now - first.t, dp = b.percent - first.pct;
    if (dt < 10 * 60000 || dp <= 0 || b.percent >= 100) { out[b.key] = null; continue; }
    const eta = (100 - b.percent) / (dp / dt);
    out[b.key] = b.resetsAt && now + eta > b.resetsAt ? null : eta;
  }
  return out;
}

// ---------------------------------------------------------------- formatting
function formatCountdown(ms) {
  if (ms <= 0) return 'now';
  const m = Math.floor(ms / 60000);
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${mm}m`;
  return `${Math.max(1, mm)}m`;
}

function formatReset(t) {
  const d = new Date(t);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? `at ${time}` : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

// ---------------------------------------------------------------- icons
// Drawn pixel-by-pixel (BGRA) so the app ships no image files.
const FONT = { // 5x7 glyphs
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  '!': ['00100', '00100', '00100', '00100', '00100', '00000', '00100'],
  '?': ['01110', '10001', '00001', '00110', '00100', '00000', '00100'],
};

function levelColor(pct) {
  if (pct == null) return [140, 140, 140];
  if (pct >= 95) return [220, 53, 53];
  if (pct >= 80) return [232, 140, 30];
  if (pct >= 50) return [214, 180, 30];
  return [46, 170, 98];
}

function makeIcon(pct, style, size) {
  const S = size, buf = Buffer.alloc(S * S * 4);
  const [r, g, b] = levelColor(pct);
  const put = (x, y, R, G, B, A) => { // alpha-over blend
    if (x < 0 || y < 0 || x >= S || y >= S) return;
    const i = (y * S + x) * 4;
    const a = A / 255, ia = buf[i + 3] / 255, oa = a + ia * (1 - a);
    if (oa <= 0) return;
    buf[i + 2] = Math.round((R * a + buf[i + 2] * ia * (1 - a)) / oa);
    buf[i + 1] = Math.round((G * a + buf[i + 1] * ia * (1 - a)) / oa);
    buf[i] = Math.round((B * a + buf[i] * ia * (1 - a)) / oa);
    buf[i + 3] = Math.round(oa * 255);
  };
  const SS = 4; // supersampling for smooth edges
  if (style === 'ring') {
    const c = S / 2, ro = S / 2 - 0.5, ri = ro - S * 0.22;
    const frac = pct == null ? 0 : pct / 100;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      let track = 0, fill = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const px = x + (sx + 0.5) / SS - c, py = y + (sy + 0.5) / SS - c;
        const d = Math.hypot(px, py);
        if (d > ro || d < ri) continue;
        let ang = Math.atan2(px, -py) / (2 * Math.PI); if (ang < 0) ang += 1;
        if (ang <= frac) fill++; else track++;
      }
      if (track) put(x, y, 128, 128, 128, Math.round(150 * track / (SS * SS)));
      if (fill) put(x, y, r, g, b, Math.round(255 * fill / (SS * SS)));
    }
    return buf;
  }
  // 'number': rounded colored tile with white digits
  const rad = S * 0.22;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let cov = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const px = x + (sx + 0.5) / SS, py = y + (sy + 0.5) / SS;
      const qx = Math.max(rad - px, 0, px - (S - rad)), qy = Math.max(rad - py, 0, py - (S - rad));
      if (Math.hypot(qx, qy) <= rad) cov++;
    }
    if (cov) put(x, y, r, g, b, Math.round(255 * cov / (SS * SS)));
  }
  const glyphs = pct == null ? ['?'] : pct >= 100 ? ['!'] : String(Math.round(pct)).split('');
  const scale = glyphs.length >= 3 ? Math.max(1, Math.floor(S / 22)) : Math.max(1, Math.floor(S / 14));
  const gw = 5 * scale, gh = 7 * scale, gap = scale;
  const tw = glyphs.length * gw + (glyphs.length - 1) * gap;
  let ox = Math.floor((S - tw) / 2);
  const oy = Math.floor((S - gh) / 2);
  for (const ch of glyphs) {
    const rows = FONT[ch] || FONT['?'];
    for (let ry = 0; ry < 7; ry++) for (let rx = 0; rx < 5; rx++) {
      if (rows[ry][rx] !== '1') continue;
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) put(ox + rx * scale + dx, oy + ry * scale + dy, 255, 255, 255, 255);
    }
    ox += gw + gap;
  }
  return buf;
}

// Multi-size .ico from makeIcon (32-bit BMP entries), for the exe icon.
function makeIco(pct = 35, style = 'ring', sizes = [16, 24, 32, 48, 64, 128, 256]) {
  const imgs = sizes.map((S) => {
    const bgra = makeIcon(pct, style, S);
    const hdr = Buffer.alloc(40);
    hdr.writeUInt32LE(40, 0); hdr.writeInt32LE(S, 4); hdr.writeInt32LE(S * 2, 8);
    hdr.writeUInt16LE(1, 12); hdr.writeUInt16LE(32, 14);
    const px = Buffer.alloc(S * S * 4);
    for (let y = 0; y < S; y++) bgra.copy(px, (S - 1 - y) * S * 4, y * S * 4, (y + 1) * S * 4); // bottom-up
    return Buffer.concat([hdr, px, Buffer.alloc(Math.ceil(S / 32) * 4 * S)]);
  });
  const head = Buffer.alloc(6); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
  let off = 6 + 16 * sizes.length;
  const dir = sizes.map((S, i) => {
    const e = Buffer.alloc(16);
    e[0] = S >= 256 ? 0 : S; e[1] = S >= 256 ? 0 : S;
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(imgs[i].length, 8); e.writeUInt32LE(off, 12);
    off += imgs[i].length;
    return e;
  });
  return Buffer.concat([head, ...dir, ...imgs]);
}

// Exact sign-in hosts (no wildcards: Google/Apple/Anthropic also host
// user-made pages on other subdomains). https only, default port only.
const SIGNIN_HOSTS = new Set([
  'claude.ai',
  'accounts.google.com', 'accounts.youtube.com', // Google sign-in (sets cookies via youtube during login)
  'appleid.apple.com', 'idmsa.apple.com',       // Sign in with Apple
]);
function isSignInUrl(u) {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' && x.port === '' && x.username === '' && x.password === '' && SIGNIN_HOSTS.has(x.hostname);
  } catch { return false; }
}
const isClaudeCookieDomain = (domain) => {
  const d = String(domain || '').replace(/^\./, '').toLowerCase();
  return d === 'claude.ai' || d.endsWith('.claude.ai');
};

module.exports = {
  isSignInUrl, isClaudeCookieDomain, SIGNIN_HOSTS,
  orgIdOf, pickOrg, planLabel, normalizeUsage, sameWindow, windowKey, updatePace,
  formatCountdown, formatReset, levelColor, makeIcon, makeIco,
};
