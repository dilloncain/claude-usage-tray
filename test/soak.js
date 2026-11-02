'use strict';
// Memory soak test: runs the real app against a mock claude.ai and polls
// ~100x faster than normal, sampling every process's memory. A leak shows up
// as steady growth after the warm-up period.
//   npx electron test/soak.js [minutes]    (Linux CI: xvfb-run -a npx electron --no-sandbox test/soak.js 3)
const { app, session, BrowserWindow } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'cut-soak-')));
const MINUTES = Number(process.argv.find(a => /^\d+(\.\d+)?$/.test(a)) || 3);
const POLL_MS = 600; // normal is 60 000

let n = 0;
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
function handler(req) {
  const url = new URL(req.url);
  if (url.pathname === '/api/organizations') return json([{ uuid: 'org-1', capabilities: ['chat', 'claude_max'], rate_limit_tier: 'default_claude_max_5x' }]);
  if (url.pathname === '/api/organizations/org-1/usage') {
    n++;
    const r1 = new Date(Date.now() + 3600e3).toISOString(), r7 = new Date(Date.now() + 3 * 86400e3).toISOString();
    const pct = process.env.SOAK_CONST ? 37 : (n % 100); // varies every poll unless SOAK_CONST
    return json({
      five_hour: { utilization: pct, resets_at: r1 }, seven_day: { utilization: 40, resets_at: r7 },
      iguana_necktie: { utilization: 0, resets_at: r7, limit_dollars: 250, used_dollars: pct, remaining_dollars: 250 - pct },
      limits: [{ kind: 'session', percent: pct, resets_at: r1 }, { kind: 'weekly_all', percent: 40, resets_at: r7 }],
    });
  }
  return new Response('<!doctype html><title>mock</title>', { headers: { 'content-type': 'text/html' } });
}
app.whenReady().then(() => session.fromPartition('persist:claude').protocol.handle('https', handler));
require('../main.js');

const mb = (kb) => Math.round(kb / 1024);
app.whenReady().then(async () => {
  await new Promise(r => setTimeout(r, 4000));
  const widget = BrowserWindow.getAllWindows().find(w => /widget\.html/.test(w.webContents.getURL()));
  const poke = setInterval(() => widget.webContents.executeJavaScript(`document.getElementById('refresh').click()`).catch(() => {}), POLL_MS);
  const rows = [];
  const t0 = Date.now();
  const sample = () => {
    const m = app.getAppMetrics();
    const byType = {};
    for (const p of m) byType[p.type] = (byType[p.type] || 0) + p.memory.workingSetSize;
    const total = m.reduce((s, p) => s + p.memory.workingSetSize, 0);
    if (global.gc) global.gc();
    byType.mainHeap = process.memoryUsage().heapUsed / 1024;
    rows.push({ t: Math.round((Date.now() - t0) / 1000), polls: n, total: mb(total), ...Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, mb(v)])), procs: m.length });
    console.log(JSON.stringify(rows[rows.length - 1]));
  };
  sample();
  const s = setInterval(sample, 15000);
  // Optional heap snapshots of the main process for leak hunting.
  if (process.env.SNAP_DIR) {
    const v8 = require('v8');
    setTimeout(() => { global.gc && global.gc(); v8.writeHeapSnapshot(path.join(process.env.SNAP_DIR, 'a.heapsnapshot')); }, 60000);
    setTimeout(() => { global.gc && global.gc(); v8.writeHeapSnapshot(path.join(process.env.SNAP_DIR, 'b.heapsnapshot')); }, MINUTES * 60000 - 5000);
  }
  setTimeout(() => {
    clearInterval(poke); clearInterval(s); sample();
    // Compare the second half against the first half (after warm-up).
    const warm = rows.filter(r => r.t >= 45);
    const half = Math.floor(warm.length / 2);
    const avg = (a, k) => a.reduce((x, r) => x + r[k], 0) / Math.max(1, a.length);
    const growth = avg(warm.slice(half), 'total') - avg(warm.slice(0, half), 'total');
    console.log(`polls: ${n}  (≈ ${Math.round(n / 60)} h of normal use)  growth after warm-up: ${growth.toFixed(1)} MB  windows: ${BrowserWindow.getAllWindows().length}`);
    app.exit(0);
  }, MINUTES * 60000);
});
