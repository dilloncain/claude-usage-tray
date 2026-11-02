'use strict';
// End-to-end test: runs the real app with claude.ai replaced by a local mock
// (intercepted at the network layer), and checks the main flows plus the
// navigation/popup lockdown.
//   npx electron test/e2e.js      (on Linux CI: xvfb-run -a npx electron --no-sandbox test/e2e.js)
const { app, session, BrowserWindow, shell, Notification, webContents } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'cut-e2e-')));

const mock = { signedIn: false, challenge: false, usagePct: 50, hits: [] };
const opened = [];
shell.openExternal = async (u) => { opened.push(u); };
const shown = [];
// CI machines often have no notification service; record toasts instead of showing them.
Notification.isSupported = () => true;
Notification.prototype.show = function () { shown.push(this.title); };

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const html = (status, body) => new Response(body, { status, headers: { 'content-type': 'text/html' } });

function handler(req) {
  const url = new URL(req.url);
  mock.hits.push(url.pathname);
  if (url.hostname === 'evil.example') return html(200, '<h1>evil</h1>');
  if (url.hostname !== 'claude.ai') return html(404, 'nope');
  if (url.pathname.startsWith('/api/')) {
    // Direct requests (no page) get the browser check when challenge mode is on.
    const fromPage = !!(req.headers.get('referer') || req.referrer);
    if (mock.challenge && !fromPage) return html(403, '<html>Just a moment...</html>');
    if (!mock.signedIn) return json(403, { type: 'error', error: { type: 'permission_error' } });
    if (url.pathname === '/api/organizations') return json(200, [{ uuid: 'org-1', name: 'Me', capabilities: ['chat', 'claude_max'], rate_limit_tier: 'default_claude_max_5x' }]);
    if (url.pathname === '/api/organizations/org-1/usage') {
      // Same shape as a real Max account's response.
      const r1 = new Date(Date.now() + 3600e3).toISOString(), r7 = new Date(Date.now() + 3 * 86400e3).toISOString();
      return json(200, {
        five_hour: { utilization: mock.usagePct, resets_at: r1, limit_dollars: null },
        seven_day: { utilization: 12, resets_at: r7, limit_dollars: null },
        seven_day_opus: null, seven_day_sonnet: null, tangelo: null, nimbus_quill: null,
        iguana_necktie: { utilization: 0, resets_at: r7, limit_dollars: 250, used_dollars: 0, remaining_dollars: 250 },
        extra_usage: { is_enabled: false, monthly_limit: 2000, used_credits: 0, utilization: 0, currency: 'USD' },
        member_dashboard_available: true, weekly_scoped_shares: [{ limit_index: 2 }],
        limits: [
          { kind: 'session', group: 'session', percent: mock.usagePct, resets_at: r1, scope: null },
          { kind: 'weekly_all', group: 'weekly', percent: 12, resets_at: r7, scope: null },
          { kind: 'weekly_scoped', group: 'weekly', percent: 0, resets_at: r7, scope: { model: { display_name: 'Fable' }, surface: null } },
        ],
      });
    }
    return json(404, {});
  }
  // Pages: tag fetches made from inside a page so the mock can tell them apart.
  return html(200, `<!doctype html><title>claude mock</title><a id="ext" href="https://evil.example/">x</a>`);
}

app.whenReady().then(() => {
  session.fromPartition('persist:claude').protocol.handle('https', handler);
});
require('../main.js');

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const wins = () => BrowserWindow.getAllWindows().filter(w => !w.isDestroyed());
const findWin = (re) => wins().find(w => re.test(w.webContents.getURL()));
async function until(fn, ms = 15000) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(200); } return false; }
const widgetText = async () => {
  const w = findWin(/widget\.html/);
  return w ? w.webContents.executeJavaScript('document.body.innerText') : '';
};

app.whenReady().then(async () => {
  try {
    // 1. Signed out -> widget says so and the sign-in window opens.
    check('signed-out shows in widget', await until(async () => /Sign in with your Claude account/.test(await widgetText())));
    check('sign-in window opens automatically', await until(() => !!findWin(/claude\.ai\/login/)));
    check('no hidden page while signed out', !wins().some(w => /settings\/usage/.test(w.webContents.getURL())));

    // 2. Navigation lockdown in the sign-in window.
    const login = findWin(/claude\.ai\/login/);
    await login.webContents.executeJavaScript(`location.href = 'https://evil.example/phish'`).catch(() => {});
    await sleep(800);
    check('sign-in window cannot navigate off claude.ai', /claude\.ai/.test(login.webContents.getURL()), login.webContents.getURL());
    check('off-site link is handed to the real browser', opened.includes('https://evil.example/phish'));
    opened.length = 0;
    await login.webContents.executeJavaScript(`window.open('file:///C:/Windows/System32/calc.exe'); window.open('ms-msdt:/id'); window.open('https://evil.example/pop')`).catch(() => {});
    await sleep(800);
    check('file:/protocol pop-ups never reach the OS', !opened.some(u => /^(file|ms-)/i.test(u)), JSON.stringify(opened));
    check('no extra windows from pop-ups', !findWin(/evil\.example/));
    const perm = await login.webContents.executeJavaScript(`navigator.permissions.query({name:'geolocation'}).then(p=>p.state).catch(e=>'err')`);
    check('geolocation permission not granted', perm !== 'granted', perm);

    // 3. Widget can't be navigated.
    const widget = findWin(/widget\.html/);
    await widget.webContents.executeJavaScript(`location.href='https://evil.example/'`).catch(() => {});
    await sleep(500);
    check('widget cannot navigate away', /widget\.html/.test(widget.webContents.getURL()));
    check('widget has no Node access', await widget.webContents.executeJavaScript(`typeof require === 'undefined' && typeof process === 'undefined'`));

    // Plant a Google cookie as if the person used Google sign-in.
    await session.fromPartition('persist:claude').cookies.set({ url: 'https://accounts.google.com/', name: 'SID', value: 'secret', expirationDate: Date.now() / 1000 + 3600 });
    await session.fromPartition('persist:claude').cookies.set({ url: 'https://claude.ai/', name: 'sessionKey', value: 'k', expirationDate: Date.now() / 1000 + 3600 });

    // Pop-up flood is rate-limited.
    opened.length = 0;
    await login.webContents.executeJavaScript(`for (let i = 0; i < 20; i++) window.open('https://evil.example/' + i)`).catch(() => {});
    await sleep(500);
    check('pop-up flood is rate-limited', opened.length <= 1, String(opened.length));

    // 4. Sign in -> login closes, data appears.
    mock.signedIn = true;
    check('sign-in window closes after sign-in', await until(() => !findWin(/claude\.ai\/login/)));
    check('usage shows in widget', await until(async () => /Current session[\s\S]*50%[\s\S]*Weekly · all models[\s\S]*12%/.test(await widgetText())), (await widgetText()).replace(/\s+/g, ' ').slice(0, 120));
    check('plan badge shown', /Max 5x/.test(await widgetText()));
    const cookies = await session.fromPartition('persist:claude').cookies.get({});
    check('Google cookies removed after sign-in', !cookies.some(c => /google/.test(c.domain)), cookies.map(c => c.domain).join(','));
    check('claude.ai cookie kept', cookies.some(c => c.name === 'sessionKey'));
    const txt = await widgetText();
    check('cloud session credits shown with dollars', /Cloud session credits[\s\S]*\$250\.00 of \$250\.00 left/.test(txt));
    check('no code names, duplicates, or unused rows', !/Iguana|Necktie|Session · Session|Weekly · Weekly|Fable|Opus|Extra Usage|Usage credits/.test(txt), txt.replace(/\s+/g, ' ').slice(0, 200));

    // 5. Alerts: crossing 80% fires once.
    shown.length = 0;
    mock.usagePct = 86;
    widget.webContents.executeJavaScript(`document.getElementById('refresh').click()`);
    await until(() => shown.length > 0, 8000);
    widget.webContents.executeJavaScript(`document.getElementById('refresh').click()`);
    await sleep(1500);
    check('80% alert fires exactly once', shown.filter(t => /Current session at 86%/.test(t)).length === 1, JSON.stringify(shown));

    // 6. Browser-check -> falls back to the hidden page and still gets data.
    mock.challenge = true;
    mock.usagePct = 61;
    widget.webContents.executeJavaScript(`document.getElementById('refresh').click()`);
    check('falls back to hidden page on browser check', await until(async () => /61%/.test(await widgetText()), 20000));
    const hidden = wins().find(w => /settings\/usage/.test(w.webContents.getURL()));
    check('hidden page is not visible', !!hidden && !hidden.isVisible());
    if (hidden) {
      opened.length = 0;
      const before = wins().length;
      await hidden.webContents.executeJavaScript(`window.open('https://accounts.google.com/x'); location.href='https://evil.example/'`).catch(() => {});
      await sleep(800);
      check('hidden page cannot open windows, navigate, or launch the browser', wins().length === before && opened.length === 0 && /claude\.ai/.test(hidden.webContents.getURL()));
    }

    // 7. Signed out remotely -> widget flips to sign-in.
    mock.challenge = false;
    mock.signedIn = false;
    for (let i = 0; i < 11; i++) { widget.webContents.executeJavaScript(`document.getElementById('refresh').click()`); await sleep(250); }
    check('expired session shows Sign in', await until(async () => /Sign in with your Claude account/.test(await widgetText()), 20000));

    // 8. Resource sanity.
    check('webContents count stays small', webContents.getAllWebContents().length <= 4, String(webContents.getAllWebContents().length));
  } catch (e) {
    check('no exceptions', false, e.stack);
  }
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  app.exit(failed ? 1 : 0);
});
