'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../lib');

const iso = (ms) => new Date(Date.now() + ms).toISOString();

test('normalizeUsage: known buckets, order, labels, null buckets skipped', () => {
  const { buckets, extra } = lib.normalizeUsage({
    seven_day: { utilization: 18, resets_at: iso(4 * 86400e3) },
    five_hour: { utilization: 42.4, resets_at: iso(3 * 3600e3) },
    seven_day_opus: null,
    seven_day_sonnet: { utilization: null, resets_at: null },
    seven_day_omelette: { utilization: 7, resets_at: iso(2 * 86400e3) },
    extra_usage: { is_enabled: true, used_credits: 1234, monthly_limit: 5000, currency: 'USD' },
  });
  assert.deepEqual(buckets.map(b => b.key), ['five_hour', 'seven_day', 'seven_day_omelette']);
  assert.equal(buckets[0].label, 'Current session');
  assert.equal(buckets[2].label, 'Weekly · Claude Design');
  assert.equal(buckets[0].percent, 42.4);
  assert.ok(buckets[0].resetsAt > Date.now());
  assert.deepEqual(extra, { enabled: true, used: 12.34, limit: 50, currency: 'USD' });
});

test('normalizeUsage: clamps percentages, survives junk input', () => {
  const { buckets } = lib.normalizeUsage({ five_hour: { utilization: 140, resets_at: 'not a date' }, x: 'str', y: [1, 2], z: { utilization: 'NaN' } });
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].percent, 100);
  assert.equal(buckets[0].resetsAt, null);
  for (const bad of [null, undefined, 5, 'x', [], {}]) assert.deepEqual(lib.normalizeUsage(bad), { buckets: [], extra: null });
});

test('normalizeUsage: generic limits array, unknown keys get readable labels', () => {
  const { buckets } = lib.normalizeUsage({
    seven_day_new_model: { utilization: 3, resets_at: null },
    limits: [{ kind: 'weekly', group: 'fable', percent: 55, resets_at: null }, { kind: 'weekly', percent: null }],
  });
  const labels = buckets.map(b => b.label).sort();
  assert.deepEqual(labels, ['Weekly · Fable', 'Weekly · New Model']);
});

test('normalizeUsage: extra usage ignored when limit is zero or missing', () => {
  assert.equal(lib.normalizeUsage({ extra_usage: { used_credits: 10, monthly_limit: 0 } }).extra, null);
  assert.equal(lib.normalizeUsage({ extra_usage: { used_credits: null, monthly_limit: 100 } }).extra, null);
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
