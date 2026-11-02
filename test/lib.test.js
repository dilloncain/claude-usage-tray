'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../lib');

const iso = (ms) => new Date(Date.now() + ms).toISOString();

// Shape copied from a real Max account's /usage response (identifiers removed).
const REAL = () => ({
  five_hour: { utilization: 8, resets_at: iso(4 * 3600e3), limit_dollars: null, used_dollars: null, remaining_dollars: null, locked_reason: null },
  seven_day: { utilization: 59, resets_at: iso(5 * 3600e3), limit_dollars: null, used_dollars: null, remaining_dollars: null, locked_reason: null },
  seven_day_oauth_apps: null, seven_day_opus: null, seven_day_sonnet: null, seven_day_cowork: null, seven_day_omelette: null,
  tangelo: null, omelette_promotional: null, nimbus_quill: null, promo_credits: null,
  iguana_necktie: { utilization: 0, resets_at: iso(3 * 86400e3), limit_dollars: 250, used_dollars: 0, remaining_dollars: 250, locked_reason: null },
  extra_usage: { is_enabled: false, monthly_limit: 2000, used_credits: 0, utilization: 0, currency: 'USD', disabled_reason: 'out_of_credits' },
  spend: { percent: 0, enabled: false }, member_dashboard_available: true,
  seven_day_breakdown: { as_of: iso(0), rows: [] }, weekly_scoped_shares: [{ limit_index: 2 }],
  limits: [
    { kind: 'session', group: 'session', percent: 8, resets_at: iso(4 * 3600e3), scope: null },
    { kind: 'weekly_all', group: 'weekly', percent: 59, resets_at: iso(5 * 3600e3), scope: null },
    { kind: 'weekly_scoped', group: 'weekly', percent: 0, resets_at: iso(5 * 3600e3), scope: { model: { display_name: 'Fable' }, surface: null } },
  ],
});

test('normalizeUsage: real response shows exactly what claude.ai shows', () => {
  const { buckets, credits, extra } = lib.normalizeUsage(REAL());
  assert.deepEqual(buckets.map(b => [b.key, b.label, b.percent]), [['five_hour', 'Current session', 8], ['seven_day', 'Weekly · all models', 59]]);
  assert.equal(credits.length, 1);
  assert.equal(credits[0].label, 'Cloud session credits');
  assert.deepEqual([credits[0].remaining, credits[0].limit, credits[0].percentLeft], [250, 250, 100]);
  assert.ok(credits[0].expiresAt > Date.now());
  assert.equal(extra.enabled, false); // usage credits off -> widget hides the row
  // No code names, no duplicates, no "Session · Session".
  const labels = [...buckets, ...credits].map(b => b.label).join('|');
  assert.ok(!/Iguana|Necktie|Session · Session|Weekly · Weekly|Extra Usage/.test(labels), labels);
});

test('normalizeUsage: per-model weekly limits appear once in use; limits list wins over flat buckets', () => {
  const u = REAL();
  u.limits[2].percent = 37;
  u.limits[1].percent = 61;            // list says 61, flat says 59 -> list wins
  u.limits.push({ kind: 'weekly_scoped', percent: 12, resets_at: iso(5 * 3600e3), scope: { model: { display_name: 'Opus 4.5' }, surface: { display_name: 'Claude Code' } } });
  u.seven_day_opus = { utilization: 12, resets_at: iso(5 * 3600e3) }; // same limit, legacy field -> not shown twice
  const { buckets } = lib.normalizeUsage(u);
  assert.deepEqual(buckets.map(b => [b.label, b.percent]), [['Current session', 8], ['Weekly · all models', 61], ['Weekly · Fable', 37], ['Weekly · Opus 4.5 · Claude Code', 12]]);
});

test('normalizeUsage: older accounts without a limits list use flat buckets', () => {
  const { buckets } = lib.normalizeUsage({
    five_hour: { utilization: 42.4, resets_at: iso(3 * 3600e3) },
    seven_day: { utilization: 18, resets_at: iso(4 * 86400e3) },
    seven_day_sonnet: { utilization: 0, resets_at: null },         // unused -> hidden
    seven_day_omelette: { utilization: 7, resets_at: iso(2 * 86400e3) },
    some_new_codename: { utilization: 50, resets_at: null },       // unknown -> never shown
  });
  assert.deepEqual(buckets.map(b => [b.key, b.label]), [['five_hour', 'Current session'], ['seven_day', 'Weekly · all models'], ['seven_day_omelette', 'Weekly · Claude Design']]);
});

test('normalizeUsage: clamps percentages, survives junk input', () => {
  const { buckets } = lib.normalizeUsage({ five_hour: { utilization: 140, resets_at: 'not a date' }, limits: 'x' });
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].percent, 100);
  assert.equal(buckets[0].resetsAt, null);
  for (const bad of [null, undefined, 5, 'x', [], {}]) assert.deepEqual(lib.normalizeUsage(bad), { buckets: [], credits: [], extra: null });
  const odd = lib.normalizeUsage({ limits: [null, 3, { kind: 'weekly_scoped', percent: 5, scope: null }, { kind: 'session', percent: 'NaN' }] });
  assert.deepEqual(odd.buckets, []);
});

test('normalizeUsage: unknown credit allowances get a generic label; extra usage cents', () => {
  const { credits, extra } = lib.normalizeUsage({
    brass_thimble: { utilization: 0, resets_at: null, limit_dollars: 50, used_dollars: 10 },
    extra_usage: { is_enabled: true, used_credits: 1234, monthly_limit: 5000, currency: 'USD' },
  });
  assert.deepEqual(credits.map(c => [c.label, c.remaining, c.percentLeft]), [['Included credit', 40, 80]]);
  assert.deepEqual(extra, { enabled: true, used: 12.34, limit: 50, currency: 'USD' });
  assert.equal(lib.normalizeUsage({ extra_usage: { used_credits: 10, monthly_limit: 0 } }).extra, null);
});

test('pickOrg / planLabel', () => {
  const orgs = [{ uuid: 'api', capabilities: ['api'] }, { uuid: 'chat', capabilities: ['chat', 'claude_max'], rate_limit_tier: 'default_claude_max_20x' }];
  assert.equal(lib.orgIdOf(lib.pickOrg(orgs)), 'chat');
  assert.equal(lib.orgIdOf(lib.pickOrg({ organizations: [{ id: 'only' }] })), 'only');
  assert.equal(lib.pickOrg(null), null);
  assert.equal(lib.planLabel(orgs[1]), 'Max 20x');
  assert.equal(lib.planLabel({ capabilities: ['chat', 'claude_max'], rate_limit_tier: 'default_claude_max_5x' }), 'Max 5x');
  assert.equal(lib.planLabel({ capabilities: ['chat', 'claude_pro'] }), 'Pro');
  assert.equal(lib.planLabel({ rate_limit_tier: 'default_claude_ai' }), 'Free');
  assert.equal(lib.planLabel({}), null);
});

test('sameWindow / windowKey tolerate reset-time jitter', () => {
  const t = Date.UTC(2026, 10, 1, 20, 0, 0);
  assert.ok(lib.sameWindow(t, t + 900));
  assert.ok(!lib.sameWindow(t, t + 5 * 3600e3));
  assert.equal(lib.windowKey({ key: 'five_hour', resetsAt: t }), lib.windowKey({ key: 'five_hour', resetsAt: t + 400 }));
});

test('updatePace: needs 10 minutes of history, projects fill time, resets on new window', () => {
  const samples = {};
  const t0 = Date.UTC(2026, 10, 1, 18, 0, 0);
  const reset = t0 + 4 * 3600e3;
  const b = (pct, resetsAt = reset) => [{ key: 'five_hour', percent: pct, resetsAt }];
  assert.equal(lib.updatePace(samples, b(20), t0).five_hour, null);
  assert.equal(lib.updatePace(samples, b(25), t0 + 5 * 60e3).five_hour, null); // < 10 min
  const eta = lib.updatePace(samples, b(40), t0 + 20 * 60e3).five_hour;      // +20 pts / 20 min
  assert.equal(Math.round(eta / 60e3), 60);                                    // 60 pts left -> 60 min
  // won't fill before reset -> null
  const s2 = {};
  lib.updatePace(s2, b(10, t0 + 30 * 60e3), t0);
  assert.equal(lib.updatePace(s2, b(12, t0 + 30 * 60e3), t0 + 15 * 60e3).five_hour, null);
  // new window clears history
  lib.updatePace(samples, b(2, reset + 5 * 3600e3), t0 + 21 * 60e3);
  assert.equal(samples.five_hour.length, 1);
  // vanished buckets are pruned
  lib.updatePace(samples, [], t0 + 22 * 60e3);
  assert.deepEqual(Object.keys(samples), []);
});

test('formatCountdown', () => {
  assert.equal(lib.formatCountdown(0), 'now');
  assert.equal(lib.formatCountdown(30e3), '1m');
  assert.equal(lib.formatCountdown(3 * 3600e3 + 5 * 60e3), '3h 5m');
  assert.equal(lib.formatCountdown(2 * 86400e3 + 3 * 3600e3), '2d 3h');
});

test('makeIcon: correct buffer size, never draws outside, 100% fits at 16px', () => {
  for (const style of ['number', 'ring']) {
    for (const pct of [null, 0, 7, 42, 85, 97, 100]) {
      for (const size of [16, 24, 32]) {
        const buf = lib.makeIcon(pct, style, size);
        assert.equal(buf.length, size * size * 4);
      }
    }
  }
  // 100% renders a single "!" glyph, so the 16px tile keeps a 1px margin of color on both sides.
  const S = 16, buf = lib.makeIcon(100, 'number', S);
  const whiteCols = new Set();
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    if (buf[i] === 255 && buf[i + 1] === 255 && buf[i + 2] === 255) whiteCols.add(x);
  }
  assert.ok(Math.min(...whiteCols) > 0 && Math.max(...whiteCols) < S - 1);
});

test('makeIco: valid ICO header and directory', () => {
  const ico = lib.makeIco();
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  const n = ico.readUInt16LE(4);
  assert.equal(n, 7);
  for (let i = 0; i < n; i++) {
    const off = ico.readUInt32LE(6 + i * 16 + 12), len = ico.readUInt32LE(6 + i * 16 + 8);
    assert.ok(off + len <= ico.length);
    assert.equal(ico.readUInt32LE(off), 40); // BITMAPINFOHEADER
  }
});

test('isSignInUrl: exact hosts only, https, default port, no userinfo', () => {
  const ok = ['https://claude.ai/login', 'https://accounts.google.com/o/oauth2/auth?x=1', 'https://appleid.apple.com/auth'];
  const bad = [
    'http://claude.ai/', 'https://claude.ai:8443/', 'https://claude.ai.evil.com/', 'https://evilclaude.ai/',
    'https://claude.ai@evil.com/', 'https://user:pw@claude.ai/', 'https://sites.google.com/view/x',
    'https://script.google.com/x', 'https://foo.googleusercontent.com/', 'https://www.apple.com/',
    'https://docs.anthropic.com/', 'javascript:alert(1)', 'file:///C:/x', 'ms-msdt:/id', 'not a url', '',
  ];
  for (const u of ok) assert.ok(lib.isSignInUrl(u), u);
  for (const u of bad) assert.ok(!lib.isSignInUrl(u), u);
});

test('isClaudeCookieDomain', () => {
  for (const d of ['claude.ai', '.claude.ai', 'api.claude.ai']) assert.ok(lib.isClaudeCookieDomain(d), d);
  for (const d of ['.google.com', 'accounts.google.com', 'evilclaude.ai', 'claude.ai.evil.com', '', null]) assert.ok(!lib.isClaudeCookieDomain(d), String(d));
});

test('normalizeUsage / updatePace ignore prototype-polluting keys', () => {
  const payload = JSON.parse('{"__proto__":{"utilization":50,"limit_dollars":5},"constructor":{"utilization":50},"prototype":{"utilization":5},' +
    '"five_hour":{"utilization":10},"limits":[{"kind":"__proto__","percent":9},{"kind":"weekly_scoped","percent":4,"scope":{"model":{"display_name":"__proto__"}}}]}');
  const { buckets } = lib.normalizeUsage(payload);
  assert.deepEqual(buckets.map(b => b.key), ['five_hour', 'weekly_proto']);
  assert.ok(buckets.every(b => typeof b.label === 'string'));
  const samples = Object.create(null);
  lib.updatePace(samples, buckets);
  assert.equal(Object.getPrototypeOf({}).utilization, undefined);
});

test('credits: null/odd dollar fields, overage, expiry, non-credit objects, row cap', () => {
  const later = iso(86400e3);
  const { credits } = lib.normalizeUsage({
    a: { limit_dollars: 250, used_dollars: 40, remaining_dollars: null, resets_at: later },  // remaining computed
    b: { limit_dollars: 100, used_dollars: 150, resets_at: later },                         // overage -> 0 left
    c: { limit_dollars: 100, used_dollars: -5, resets_at: later },                          // negative used -> full
    d: { limit_dollars: 100, used_dollars: 0, resets_at: iso(-3600e3) },                     // expired -> hidden
    spend: { limit_dollars: 20, used_dollars: 0 },                                           // not an allowance
    e: { limit_dollars: 50 },                                                                // no used/remaining keys
    f: { limit_dollars: 1, used_dollars: 0 }, g: { limit_dollars: 1, used_dollars: 0 },      // over the 4-row cap
  });
  assert.deepEqual(credits.map(c => [c.key, c.remaining]), [['a', 210], ['b', 0], ['c', 100], ['f', 1]]);
});

test('usage credits: junk numbers and currency are rejected', () => {
  assert.equal(lib.normalizeUsage({ extra_usage: { is_enabled: true, used_credits: 'abc', monthly_limit: 100 } }).extra, null);
  assert.equal(lib.normalizeUsage({ extra_usage: { is_enabled: true, used_credits: 5, monthly_limit: 100, currency: '<b>' } }).extra.currency, 'USD');
});
