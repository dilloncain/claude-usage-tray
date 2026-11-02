'use strict';
// Claude Usage Tray — shows your Claude plan's session and weekly limits in the
// Windows system tray and in a small always-on-top widget.
//
// How it gets the numbers: you sign in to claude.ai inside the app's own
// browser window (your password never touches this code). The app then reads
// the same JSON the claude.ai Settings > Usage page reads:
//   GET https://claude.ai/api/organizations            -> your org id
//   GET https://claude.ai/api/organizations/{id}/usage -> five_hour, seven_day, ...
// Everything stays on this PC. The app talks to nothing but claude.ai.

const {
  app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, Notification,
  session, shell, screen, powerMonitor,
} = require('electron');
const path = require('path');
const fs = require('fs');
const lib = require('./lib');

const APP_ID = 'com.dcain.claudeusagetray';
const PARTITION = 'persist:claude';
const ORIGIN = 'https://claude.ai';
const API = `${ORIGIN}/api`;
const REQUEST_TIMEOUT_MS = 20000;
const DEMO = process.env.CLAUDE_USAGE_DEMO === '1';
const AUTOSTART_ARG = '--autostart';


// Chromium's UA minus "Electron/x" so Google's sign-in doesn't refuse the window.
const browserUA = () => session.defaultSession.getUserAgent().replace(/\s(?:Electron|claude-usage-tray)\/\S+/gi, '');

// ---------------------------------------------------------------- settings
const DEFAULTS = Object.freeze({
  pollSeconds: 60,
  iconStyle: 'number',          // 'number' | 'ring'
  iconSource: 'session',        // 'session' | 'highest'
  alerts: true,
  alertThresholds: [80, 95],
  notifyOnReset: false,
  widgetVisible: true,
  widgetBounds: null,
  widgetOpacity: 1,
  startWithWindows: false,
  autoUpdate: true,             // installed (setup.exe) copies only
  notified: {},                 // "<bucket>|<window minute>|<threshold>" -> true
});
const THRESHOLD_CHOICES = [50, 75, 80, 90, 95, 100];
let settingsPath;
let settings = { ...DEFAULTS };

// Coerce whatever is on disk into valid values, so a hand-edited or corrupted
// file can't crash the app.
function sanitizeSettings(raw) {
  const s = { ...DEFAULTS };
  if (!raw || typeof raw !== 'object') return s;
  if ([30, 60, 120, 300].includes(raw.pollSeconds)) s.pollSeconds = raw.pollSeconds;
  if (['number', 'ring'].includes(raw.iconStyle)) s.iconStyle = raw.iconStyle;
  if (['session', 'highest'].includes(raw.iconSource)) s.iconSource = raw.iconSource;
  if (typeof raw.alerts === 'boolean') s.alerts = raw.alerts;
  if (Array.isArray(raw.alertThresholds)) s.alertThresholds = [...new Set(raw.alertThresholds.filter(t => THRESHOLD_CHOICES.includes(t)))].sort((a, b) => a - b);
  if (typeof raw.notifyOnReset === 'boolean') s.notifyOnReset = raw.notifyOnReset;
  if (typeof raw.widgetVisible === 'boolean') s.widgetVisible = raw.widgetVisible;
  const b = raw.widgetBounds;
  if (b && [b.x, b.y].every(Number.isFinite)) s.widgetBounds = { x: Math.round(b.x), y: Math.round(b.y) };
  if ([1, 0.9, 0.75, 0.6].includes(raw.widgetOpacity)) s.widgetOpacity = raw.widgetOpacity;
  if (typeof raw.startWithWindows === 'boolean') s.startWithWindows = raw.startWithWindows;
  if (typeof raw.autoUpdate === 'boolean') s.autoUpdate = raw.autoUpdate;
  if (raw.notified && typeof raw.notified === 'object' && !Array.isArray(raw.notified)) {
    for (const [k, v] of Object.entries(raw.notified).slice(0, 200)) if (v === true) s.notified[k] = true;
  }
  return s;
}

function loadSettings() {
  settingsPath = path.join(app.getPath('userData'), 'settings.json');
  try { settings = sanitizeSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8'))); }
  catch { settings = sanitizeSettings(null); }
  settings.notified = { ...settings.notified };
}

// Write to a temp file and rename, so a crash mid-write never leaves a broken file.
function saveSettings() {
  try {
    const tmp = `${settingsPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
    fs.renameSync(tmp, settingsPath);
  } catch { /* best effort */ }
}

// ---------------------------------------------------------------- state
let tray = null;
let widget = null;
let loginWin = null;
let fetchWin = null;          // hidden claude.ai page, used only if direct requests get a browser check
let fetchWinReady = null;
let pollTimer = null;
let resetTimer = null;
let orgId = null;
let quitting = false;
let promptedLogin = false;    // open the sign-in window once, on the first signed-out reading
let generation = 0;           // bumped on sign-in/out so a stale in-flight poll can't overwrite state
let polling = false;
let pollQueued = false;
let pageMode = false;         // currently using the hidden page instead of direct requests
let pageModePolls = 0;
const samples = Object.create(null); // pace history per bucket

const state = {
  status: 'loading',          // 'loading' | 'ok' | 'signed-out' | 'error'
  error: null,
  plan: null,
  buckets: [],                // [{ key, label, percent, resetsAt }]
  credits: [],                // [{ key, label, used, limit, remaining, percent, expiresAt, currency }]
  extra: null,                // { used, limit, currency, enabled }
  updatedAt: null,
  pace: {},                   // bucket key -> ms until 100% at the current rate, or null
};
const LOCKED_PREFS = () => ({ partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, devTools: !app.isPackaged, spellcheck: false });

// ---------------------------------------------------------------- fetching
const claudeSession = () => session.fromPartition(PARTITION);

class HttpError extends Error {
  constructor(status, isJson) { super(`HTTP ${status}`); this.status = status; this.isJson = isJson; }
}
const isAuthError = (e) => e instanceof HttpError && e.isJson && (e.status === 401 || e.status === 403);
// A browser check / HTML page where JSON was expected.
const isChallenge = (e) => e instanceof HttpError && !e.isJson;

function withTimeout(promise, ms = REQUEST_TIMEOUT_MS) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, reject) => { t = setTimeout(() => reject(new Error('claude.ai took too long to answer.')), ms); }),
  ]).finally(() => clearTimeout(t));
}

// Only ever called with URLs built from the API constant above.
function assertApiUrl(url) {
  if (!url.startsWith(`${API}/`)) throw new Error('Refusing to request a non-claude.ai URL.');
}

async function directFetchJson(url) {
  assertApiUrl(url);
  const res = await claudeSession().fetch(url, {
    method: 'GET',
    credentials: 'include',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const isJson = (res.headers.get('content-type') || '').includes('json');
  if (!res.ok) throw new HttpError(res.status, isJson);
  if (!isJson) throw new HttpError(599, false);
  return res.json();
}

function ensureFetchWin() {
  if (fetchWin && !fetchWin.isDestroyed()) return fetchWinReady;
  fetchWin = new BrowserWindow({
    show: false,
    webPreferences: LOCKED_PREFS(),
  });
  fetchWin.webContents.setAudioMuted(true);
  fetchWin.on('closed', () => { fetchWin = null; fetchWinReady = null; });
  fetchWinReady = withTimeout(fetchWin.loadURL(`${ORIGIN}/settings/usage`), 30000)
    .catch(() => {})
    .then(() => fetchWin);
  return fetchWinReady;
}

function destroyFetchWin() {
  if (fetchWin && !fetchWin.isDestroyed()) fetchWin.destroy();
  fetchWin = null;
  fetchWinReady = null;
}

// Fallback: run fetch() inside a real claude.ai page, exactly like the site does.
async function pageFetchJson(url) {
  assertApiUrl(url);
  const win = await ensureFetchWin();
  if (!win || win.isDestroyed()) throw new Error('Could not open claude.ai.');
  if (!win.webContents.getURL().startsWith(`${ORIGIN}/`)) throw new HttpError(599, false);
  // The URL is passed through JSON.stringify, so nothing from the network is
  // ever interpolated into the script.
  // Runs in an isolated world (page scripts can't swap out fetch) and without
  // a simulated user gesture (so the page gets no pop-up privileges).
  const result = await withTimeout(win.webContents.executeJavaScriptInIsolatedWorld(1000, [{ code: `
    fetch(${JSON.stringify(url)}, { credentials: 'include', headers: { Accept: 'application/json' } })
      .then(async r => ({ status: r.status, type: r.headers.get('content-type') || '', body: await r.text() }))
      .catch(e => ({ status: 0, type: '', body: String(e) }))
  ` }], false));
  const isJson = String(result && result.type).includes('json');
  if (!result || result.status < 200 || result.status >= 300) throw new HttpError(result ? result.status : 0, isJson);
  if (!isJson) throw new HttpError(599, false);
  return JSON.parse(result.body);
}

// Direct requests are light; the hidden page is only for when claude.ai
// answers with a browser check. Every 10 polls in page mode, try direct again
// and close the page as soon as it works.
async function fetchJson(url) {
  if (!pageMode || ++pageModePolls % 10 === 0) {
    try {
      const data = await directFetchJson(url);
      if (pageMode) { pageMode = false; destroyFetchWin(); }
      return data;
    } catch (e) {
      if (!isChallenge(e)) throw e; // signed out, offline, server error: the page won't help
      pageMode = true;
    }
  }
  return pageFetchJson(url);
}

function demoUsage() {
  const iso = (ms) => new Date(Date.now() + ms).toISOString();
  return {
    five_hour: { utilization: 83, resets_at: iso(2 * 3600e3 + 14 * 60e3) },
    seven_day: { utilization: 41, resets_at: iso(3 * 86400e3 + 5 * 3600e3) },
    seven_day_opus: { utilization: 22, resets_at: iso(3 * 86400e3 + 5 * 3600e3) },
    iguana_necktie: { utilization: 0, resets_at: iso(3 * 86400e3 + 6 * 3600e3), limit_dollars: 250, used_dollars: 38.5, remaining_dollars: 211.5 },
    extra_usage: { is_enabled: true, used_credits: 1234, monthly_limit: 5000, currency: 'USD' },
  };
}

function friendlyError(e) {
  if (e instanceof HttpError) {
    if (e.status === 599) return 'claude.ai sent a page instead of data. Try Sign in again.';
    if (e.status === 429) return 'claude.ai is rate-limiting requests. Retrying shortly.';
    if (e.status >= 500) return 'claude.ai is having trouble. Retrying shortly.';
    return `claude.ai answered ${e.status}.`;
  }
  if (e && /fetch failed|net::|ENOTFOUND|ECONN|aborted|timed? ?out|too long/i.test(e.message)) return 'Can\'t reach claude.ai. Check your connection.';
  return (e && e.message) || String(e);
}

async function poll() {
  if (polling) { pollQueued = true; return; }
  polling = true;
  const gen = generation;
  try {
    if (DEMO) {
      const { buckets, credits, extra } = lib.normalizeUsage(demoUsage());
      Object.assign(state, { status: 'ok', error: null, plan: 'Max 5x', buckets, credits, extra, updatedAt: Date.now(), pace: { five_hour: 47 * 60e3 } });
      return;
    }
    let plan = state.plan;
    if (!orgId) {
      let orgs;
      try { orgs = await fetchJson(`${API}/organizations`); }
      catch (e) {
        if (isAuthError(e) && gen === generation) {
          Object.assign(state, { status: 'signed-out', error: null, buckets: [], credits: [], extra: null, plan: null, pace: {} });
          for (const k of Object.keys(samples)) delete samples[k];
          if (!promptedLogin && !process.argv.includes(AUTOSTART_ARG)) { promptedLogin = true; setTimeout(openLogin, 300); }
          return;
        }
        throw e;
      }
      const org = lib.pickOrg(orgs);
      if (!lib.orgIdOf(org)) throw new Error('No Claude organization found for this account.');
      if (gen !== generation) return;
      orgId = lib.orgIdOf(org);
      plan = lib.planLabel(org);
    }
    let usage;
    try {
      usage = await fetchJson(`${API}/organizations/${encodeURIComponent(orgId)}/usage`);
    } catch (e) {
      // 401/403 here usually means the session expired or the org changed:
      // look the org up again next time (which decides signed-in or not).
      if (e instanceof HttpError && [401, 403, 404].includes(e.status)) orgId = null;
      throw e;
    }
    if (gen !== generation) return; // signed out / in while this was running
    const { buckets, credits, extra } = lib.normalizeUsage(usage);
    notifyResets(buckets);
    Object.assign(state, { status: 'ok', error: null, plan, buckets, credits, extra, updatedAt: Date.now() });
    state.pace = lib.updatePace(samples, buckets);
    checkAlerts();
  } catch (e) {
    if (gen === generation) {
      state.status = state.buckets.length ? 'ok' : 'error';
      state.error = friendlyError(e);
    }
  } finally {
    polling = false;
    render();
    scheduleResetRefresh();
    if (pollQueued) { pollQueued = false; setImmediate(poll); }
  }
}

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(poll, settings.pollSeconds * 1000);
  poll();
}

// Refresh a few seconds after the soonest reset so the bars drop right away.
function scheduleResetRefresh() {
  clearTimeout(resetTimer);
  const next = state.buckets.map(b => b.resetsAt).filter(t => t && t > Date.now()).sort((a, b) => a - b)[0];
  if (!next) return;
  const wait = next - Date.now() + 5000;
  if (wait < 2 ** 31 - 1) resetTimer = setTimeout(poll, wait); // setTimeout overflows past ~24.8 days
}

// ---------------------------------------------------------------- alerts
const liveNotifications = new Set(); // keep references so Windows click handlers aren't garbage-collected

function notify(title, body) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: appIcon() });
  liveNotifications.add(n);
  const done = () => liveNotifications.delete(n);
  n.on('click', () => { done(); showWidget(); });
  n.on('close', done);
  n.on('failed', done);
  n.show();
  setTimeout(done, 60000);
}

function checkAlerts() {
  if (!settings.alerts || !settings.alertThresholds.length) return;
  const thresholds = [...settings.alertThresholds].sort((a, b) => b - a);
  let changed = false;
  for (const b of state.buckets) {
    const hit = thresholds.find(t => b.percent >= t);
    if (hit == null) continue;
    const k = `${lib.windowKey(b)}|${hit}`;
    if (settings.notified[k]) continue;
    // Also mark every lower threshold, so 95% doesn't fire right after 80%
    // on the same reading.
    for (const t of thresholds) if (t <= hit) settings.notified[`${lib.windowKey(b)}|${t}`] = true;
    changed = true;
    notify(
      `Claude: ${b.label} at ${Math.round(b.percent)}%`,
      b.resetsAt ? `Resets ${lib.formatReset(b.resetsAt)} (in ${lib.formatCountdown(b.resetsAt - Date.now())}).` : 'Limit almost reached.',
    );
  }
  if (!changed) return;
  // Forget keys for windows that are over, so the file doesn't grow forever.
  const live = new Set(state.buckets.map(lib.windowKey));
  for (const k of Object.keys(settings.notified)) {
    if (!live.has(k.split('|').slice(0, 2).join('|'))) delete settings.notified[k];
  }
  saveSettings();
}

function notifyResets(newBuckets) {
  if (!settings.notifyOnReset) return;
  const before = state.buckets.find(b => b.key === 'five_hour');
  const after = newBuckets.find(b => b.key === 'five_hour');
  if (before && after && before.percent >= 5 && after.percent < before.percent && !lib.sameWindow(before.resetsAt, after.resetsAt)) {
    notify('Claude session limit reset', `You're back to ${Math.round(after.percent)}% for this session.`);
  }
}

// ---------------------------------------------------------------- tray
const iconCache = new Map();
function trayImage(pct) {
  const key = `${pct == null ? 'x' : Math.round(pct)}|${settings.iconStyle}`;
  if (iconCache.has(key)) return iconCache.get(key);
  const img = nativeImage.createEmpty();
  for (const [size, scaleFactor] of [[16, 1], [24, 1.5], [32, 2]]) {
    img.addRepresentation({ scaleFactor, width: size, height: size, buffer: lib.makeIcon(pct, settings.iconStyle, size) });
  }
  if (iconCache.size > 64) iconCache.clear();
  iconCache.set(key, img);
  return img;
}

let appIconImg = null;
function appIcon() {
  if (!appIconImg) {
    appIconImg = nativeImage.createEmpty();
    appIconImg.addRepresentation({ scaleFactor: 1, width: 64, height: 64, buffer: lib.makeIcon(35, 'ring', 64) });
  }
  return appIconImg;
}

function iconPercent() {
  if (state.status !== 'ok' || !state.buckets.length) return null;
  if (settings.iconSource === 'highest') return Math.max(...state.buckets.map(b => b.percent));
  const s = state.buckets.find(b => b.key === 'five_hour');
  return (s || state.buckets[0]).percent;
}

function tooltipText() {
  if (state.status === 'signed-out') return 'Claude Usage: sign in to see your limits';
  if (state.status === 'loading') return 'Claude Usage: loading…';
  if (!state.buckets.length) return `Claude Usage: ${state.error || 'no data'}`;
  const lines = state.buckets.slice(0, 4).map(b =>
    `${b.label}: ${Math.round(b.percent)}%${b.resetsAt ? ` · ${lib.formatCountdown(b.resetsAt - Date.now())}` : ''}`);
  return ['Claude Usage' + (state.plan ? ` (${state.plan})` : ''), ...lines].join('\n').slice(0, 127); // Windows limit
}

function buildMenu() {
  const radio = (label, key, value, after) => ({
    label, type: 'radio', checked: settings[key] === value,
    click: () => { settings[key] = value; saveSettings(); if (after) after(); render(true); },
  });
  return Menu.buildFromTemplate([
    { label: widget && widget.isVisible() ? 'Hide widget' : 'Show widget', click: toggleWidget },
    { label: 'Refresh now', click: poll },
    { label: 'Open Claude usage page', click: () => shell.openExternal(`${ORIGIN}/settings/usage`) },
    { type: 'separator' },
    {
      label: 'Settings', submenu: [
        { label: 'Tray icon shows', submenu: [radio('Current session', 'iconSource', 'session'), radio('Highest limit', 'iconSource', 'highest')] },
        { label: 'Tray icon style', submenu: [radio('Number', 'iconStyle', 'number'), radio('Ring', 'iconStyle', 'ring')] },
        { label: 'Refresh every', submenu: [[30, '30 seconds'], [60, '1 minute'], [120, '2 minutes'], [300, '5 minutes']].map(([v, l]) => radio(l, 'pollSeconds', v, startPolling)) },
        { label: 'Widget opacity', submenu: [1, 0.9, 0.75, 0.6].map(v => radio(`${Math.round(v * 100)}%`, 'widgetOpacity', v, () => widget && widget.setOpacity(v))) },
        {
          label: 'Alerts', submenu: [
            { label: 'Alerts on', type: 'checkbox', checked: settings.alerts, click: (i) => { settings.alerts = i.checked; saveSettings(); render(true); } },
            { type: 'separator' },
            ...THRESHOLD_CHOICES.map(t => ({
              label: `Alert at ${t}%`, type: 'checkbox', enabled: settings.alerts,
              checked: settings.alertThresholds.includes(t),
              click: (i) => {
                const set = new Set(settings.alertThresholds);
                if (i.checked) set.add(t); else set.delete(t);
                settings.alertThresholds = [...set].sort((a, b) => a - b);
                saveSettings(); render(true);
              },
            })),
            { type: 'separator' },
            { label: 'Notify when my session resets', type: 'checkbox', checked: settings.notifyOnReset, click: (i) => { settings.notifyOnReset = i.checked; saveSettings(); } },
            { label: 'Send a test alert', click: () => notify('Claude Usage Tray', 'Alerts are working.') },
          ],
        },
        { label: 'Start with Windows', type: 'checkbox', checked: settings.startWithWindows, click: (i) => setAutoStart(i.checked) },
        ...(updater ? [{ label: 'Install updates automatically', type: 'checkbox', checked: settings.autoUpdate, click: (i) => { settings.autoUpdate = i.checked; saveSettings(); } }] : []),
      ],
    },
    ...(updater ? [updateReady
      ? { label: `Restart to update (v${updateReady})`, click: restartToUpdate }
      : { label: 'Check for updates', click: checkForUpdatesNow }] : []),
    { label: `About (version ${app.getVersion()})`, click: () => shell.openExternal('https://github.com/dilloncain/claude-usage-tray#readme') },
    { type: 'separator' },
    ...(DEMO ? [] : state.status === 'signed-out'
      ? [{ label: 'Sign in to Claude…', click: openLogin }]
      : state.status === 'ok'
        ? [{ label: 'Sign out of Claude', click: signOut }]
        : [{ label: 'Sign in to Claude…', click: openLogin }, { label: 'Sign out of Claude', click: signOut }]),
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]);
}

let lastTray = { img: null, tip: null, menuKey: null };
function render(menuChanged = false) {
  if (tray && !tray.isDestroyed()) {
    const img = trayImage(iconPercent());
    if (img !== lastTray.img) { tray.setImage(img); lastTray.img = img; }
    const tip = tooltipText();
    if (tip !== lastTray.tip) { tray.setToolTip(tip); lastTray.tip = tip; }
    // Rebuilding the context menu while it's open closes it on Windows, so
    // only do it when something in the menu actually changed.
    const menuKey = `${state.status}|${widget && widget.isVisible()}`;
    if (menuChanged || menuKey !== lastTray.menuKey) { tray.setContextMenu(buildMenu()); lastTray.menuKey = menuKey; }
  }
  if (widget && !widget.isDestroyed()) {
    try { widget.webContents.send('state', state); } catch { /* never let a bad value stop polling */ }
  }
}

// ---------------------------------------------------------------- widget
function createWidget() {
  const work = screen.getPrimaryDisplay().workArea;
  const b = settings.widgetBounds;
  widget = new BrowserWindow({
    width: 300, height: 220,
    x: b ? b.x : work.x + work.width - 320,
    y: b ? b.y : work.y + work.height - 240,
    frame: false, transparent: true, resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
    alwaysOnTop: true, skipTaskbar: true, show: false, hasShadow: false,
    icon: appIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
      spellcheck: false, devTools: !app.isPackaged,
    },
  });
  widget.setAlwaysOnTop(true, 'screen-saver');
  widget.setOpacity(settings.widgetOpacity);
  widget.loadFile(path.join(__dirname, 'widget.html'));
  widget.once('ready-to-show', () => {
    keepOnScreen();
    if (settings.widgetVisible) widget.showInactive();
    render(true);
  });
  widget.on('moved', () => { const { x, y } = widget.getBounds(); settings.widgetBounds = { x, y }; saveSettings(); });
  widget.on('show', () => render(true));
  widget.on('hide', () => render(true));
  widget.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    hideWidget();
  });
}

function keepOnScreen() {
  if (!widget || widget.isDestroyed()) return;
  const bounds = widget.getBounds();
  const area = screen.getDisplayMatching(bounds).workArea;
  const x = Math.min(Math.max(bounds.x, area.x), area.x + area.width - bounds.width);
  const y = Math.min(Math.max(bounds.y, area.y), area.y + area.height - bounds.height);
  if (x !== bounds.x || y !== bounds.y) widget.setPosition(x, y);
}

function showWidget() {
  if (!widget || widget.isDestroyed()) createWidget();
  widget.showInactive();
  settings.widgetVisible = true;
  saveSettings();
}
function hideWidget() {
  if (!widget || widget.isDestroyed()) return;
  widget.hide();
  settings.widgetVisible = false;
  saveSettings();
}
function toggleWidget() {
  if (widget && !widget.isDestroyed() && widget.isVisible()) hideWidget(); else showWidget();
}

// Messages from the widget page. Each is accepted only from the widget's own
// page, and none carries data the main process acts on except a clamped height.
const fromWidget = (e) => widget && !widget.isDestroyed() && e.sender === widget.webContents && e.senderFrame === widget.webContents.mainFrame;
ipcMain.on('widget:resize', (e, h) => {
  if (!fromWidget(e)) return;
  const height = Math.max(80, Math.min(600, Math.round(Number(h) || 0)));
  const [w, current] = widget.getSize();
  if (height === current) return;
  widget.setSize(w, height);
  keepOnScreen();
});
ipcMain.on('widget:refresh', (e) => { if (fromWidget(e)) poll(); });
ipcMain.on('widget:hide', (e) => { if (fromWidget(e)) hideWidget(); });
ipcMain.on('widget:signin', (e) => { if (fromWidget(e)) openLogin(); });
ipcMain.on('widget:menu', (e) => { if (fromWidget(e)) buildMenu().popup({ window: widget }); });

// ---------------------------------------------------------------- sign-in
let loginCheckBusy = false;

function openLogin() {
  if (DEMO) return;
  if (loginWin && !loginWin.isDestroyed()) { loginWin.show(); loginWin.focus(); return; }
  loginWin = new BrowserWindow({
    width: 480, height: 720, title: 'Sign in to Claude', icon: appIcon(), autoHideMenuBar: true,
    webPreferences: LOCKED_PREFS(),
  });
  loginWin.loadURL(`${ORIGIN}/login`);

  // Watch for a working session, then close the window and start reading usage.
  const check = setInterval(async () => {
    if (!loginWin || loginWin.isDestroyed()) { clearInterval(check); return; }
    if (loginCheckBusy) return;
    loginCheckBusy = true;
    try {
      await directFetchJson(`${API}/organizations`).catch((e) => {
        if (!isChallenge(e)) throw e; // signed out: don't spin up the hidden page for nothing
        return pageFetchJson(`${API}/organizations`);
      });
      clearInterval(check);
      generation++;
      orgId = null;
      for (const k of Object.keys(samples)) delete samples[k];
      Object.assign(state, { buckets: [], credits: [], extra: null, plan: null, pace: {} });
      pageMode = false;
      destroyFetchWin();
      closeAuthWindows();
      await dropNonClaudeCookies();
      poll();
      showWidget();
    } catch { /* not signed in yet */ }
    finally { loginCheckBusy = false; }
  }, 3000);
  loginWin.on('closed', () => { clearInterval(check); loginWin = null; });
}

// Close the sign-in window and any Google/Apple pop-ups.
function closeAuthWindows() {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w !== widget && w !== fetchWin && !w.isDestroyed()) w.destroy();
  }
}

// After signing in with Google or Apple, their account cookies would otherwise
// stay in this app's profile. Keep only claude.ai's own session.
async function dropNonClaudeCookies() {
  const ses = claudeSession();
  try {
    for (const c of await ses.cookies.get({})) {
      if (lib.isClaudeCookieDomain(c.domain)) continue;
      const host = c.domain.replace(/^\./, '');
      await ses.cookies.remove(`https://${host}${c.path || '/'}`, c.name).catch(() => {});
    }
    await ses.cookies.flushStore();
  } catch { /* best effort */ }
}

async function signOut() {
  generation++;
  closeAuthWindows();
  orgId = null;
  pageMode = false;
  destroyFetchWin();
  for (const k of Object.keys(samples)) delete samples[k];
  // Wipe everything this app stored. (To end the session on claude.ai's side
  // as well, use "Log out of all devices" in claude.ai settings.)
  await claudeSession().clearStorageData();
  await claudeSession().clearCache();
  await claudeSession().clearAuthCache();
  Object.assign(state, { status: 'signed-out', buckets: [], credits: [], extra: null, plan: null, error: null, pace: {} });
  render(true);
}

// ---------------------------------------------------------------- security
// Applies to every window and pop-up the app ever creates.
const isSignInUrl = lib.isSignInUrl;
// Only plain web links ever leave the app (never file:, ms-*, or other
// handlers), and at most one every 2 seconds so a page can't flood the browser.
let lastExternal = 0;
function openExternalSafe(u) {
  if (Date.now() - lastExternal < 2000) return;
  try {
    const url = new URL(u);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return;
    lastExternal = Date.now();
    shell.openExternal(url.href);
  } catch { /* ignore malformed */ }
}

function hardenSession(ses) {
  ses.setUserAgent(browserUA());
  // claude.ai doesn't need the camera, mic, location, notifications, etc. here.
  const fromClaude = (u) => { try { return new URL(u).origin === ORIGIN; } catch { return false; } };
  ses.setPermissionRequestHandler((_wc, permission, cb, details) => cb(permission === 'clipboard-sanitized-write' && fromClaude(details && details.requestingUrl)));
  ses.setPermissionCheckHandler((_wc, permission, origin) => permission === 'clipboard-sanitized-write' && fromClaude(origin));
  ses.setDevicePermissionHandler(() => false);
  // Nothing is ever downloaded through the app.
  ses.on('will-download', (e) => e.preventDefault());
}

app.on('web-contents-created', (_e, wc) => {
  const isWidget = () => widget && !widget.isDestroyed() && wc === widget.webContents;
  // The hidden data page never navigates elsewhere, opens pop-ups, or opens the browser.
  const isFetch = () => fetchWin && !fetchWin.isDestroyed() && wc === fetchWin.webContents;
  wc.on('select-bluetooth-device', (e, _list, cb) => { e.preventDefault(); cb(''); });
  wc.on('select-hid-device', (e, _d, cb) => { e.preventDefault(); cb(''); });
  wc.on('select-serial-port', (e, _l, _w, cb) => { e.preventDefault(); cb(''); });
  wc.on('select-usb-device', (e, _d, cb) => { e.preventDefault(); cb(''); });
  // The widget never navigates (e.g. a dropped file or link). Other windows
  // may only move between claude.ai and its sign-in providers.
  const guard = (e, url) => {
    if (isWidget() || !isSignInUrl(url)) {
      e.preventDefault();
      if (!isWidget() && !isFetch()) openExternalSafe(url);
    }
  };
  wc.on('will-navigate', guard);
  wc.on('will-redirect', (e, url) => { if (!isSignInUrl(url) && !isWidget()) e.preventDefault(); });
  wc.on('will-attach-webview', (e) => e.preventDefault());
  // Pop-ups: only the sign-in flow may open one (Google/Apple), and it gets the
  // same locked-down settings. Everything else goes to the real browser.
  wc.setWindowOpenHandler(({ url }) => {
    if (isFetch()) return { action: 'deny' };
    if (!isWidget() && isSignInUrl(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: { autoHideMenuBar: true, icon: appIcon(), webPreferences: LOCKED_PREFS() },
      };
    }
    if (!isWidget()) openExternalSafe(url);
    return { action: 'deny' };
  });
});

// ---------------------------------------------------------------- updates
// Only the installed copy (from ClaudeUsageTray-Setup-x.y.z.exe) updates itself;
// a copy unzipped by hand can't replace its own files safely. Updates come from
// this project's GitHub Releases, and each download is checked against the
// SHA-512 published with the release before it's installed.
const UPDATE_EVERY_MS = 6 * 3600e3;
let updater = null;
let updateReady = null;      // version string once downloaded
let updateManual = false;    // the person clicked "Check for updates"
let updateBusy = false;

function isInstalledCopy() {
  if (!app.isPackaged || process.platform !== 'win32') return false;
  try { return fs.readdirSync(path.dirname(process.execPath)).some(f => /^Uninstall .*\.exe$/i.test(f)); }
  catch { return false; }
}

function setupUpdater() {
  if (!isInstalledCopy()) return;
  try { ({ autoUpdater: updater } = require('electron-updater')); } catch { return; }
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.logger = null;
  updater.on('update-not-available', () => {
    if (updateManual) notify('Claude Usage Tray is up to date', `You have the latest version (${app.getVersion()}).`);
    updateManual = false;
  });
  updater.on('update-downloaded', (info) => {
    updateReady = String((info && info.version) || '').slice(0, 20) || 'new';
    updateManual = false;
    notify(`Update ready: version ${updateReady}`, 'It installs when you quit, or choose "Restart to update" in the tray menu.');
    render(true);
  });
  updater.on('error', () => {
    if (updateManual) notify('Couldn\'t check for updates', 'Check your connection and try again later.');
    updateManual = false;
  });
  const check = () => {
    if (!settings.autoUpdate || updateReady || updateBusy) return;
    updateBusy = true;
    updater.checkForUpdates().catch(() => {}).finally(() => { updateBusy = false; });
  };
  setTimeout(check, 15000);
  setInterval(check, UPDATE_EVERY_MS);
}

function checkForUpdatesNow() {
  if (!updater || updateBusy) return;
  updateManual = true;
  updateBusy = true;
  updater.checkForUpdates().catch(() => {}).finally(() => { updateBusy = false; });
}

function restartToUpdate() {
  if (!updater || !updateReady) return;
  quitting = true;
  updater.quitAndInstall(true, true); // silent install, then reopen the app
}

// ---------------------------------------------------------------- Windows integration
function autoStartOptions() {
  return { path: process.execPath, args: app.isPackaged ? [AUTOSTART_ARG] : [app.getAppPath(), AUTOSTART_ARG] };
}
function setAutoStart(on) {
  app.setLoginItemSettings({ ...autoStartOptions(), openAtLogin: on });
  settings.startWithWindows = app.getLoginItemSettings(autoStartOptions()).openAtLogin;
  saveSettings();
  render(true);
}

// Windows only shows toasts for apps with a Start Menu shortcut carrying their
// AppUserModelID. The installer creates one; for the zip copy, create it here.
function ensureStartMenuShortcut() {
  if (process.platform !== 'win32' || !app.isPackaged || isInstalledCopy()) return;
  try {
    const lnk = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Claude Usage Tray.lnk');
    let ok = false;
    try { const s = shell.readShortcutLink(lnk); ok = s.target === process.execPath && s.appUserModelId === APP_ID; } catch { /* missing */ }
    if (!ok) shell.writeShortcutLink(lnk, fs.existsSync(lnk) ? 'replace' : 'create', { target: process.execPath, appUserModelId: APP_ID, description: 'Claude Usage Tray' });
  } catch { /* toasts may not show; everything else still works */ }
}

// ---------------------------------------------------------------- app
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId(app.isPackaged ? APP_ID : process.execPath);
  app.on('second-instance', showWidget);

  app.whenReady().then(() => {
    // No app menu: removes Electron's default Reload / DevTools shortcuts.
    Menu.setApplicationMenu(null);
    loadSettings();
    hardenSession(claudeSession());
    hardenSession(session.defaultSession);
    ensureStartMenuShortcut();
    settings.startWithWindows = app.getLoginItemSettings(autoStartOptions()).openAtLogin;

    tray = new Tray(trayImage(null));
    tray.on('click', toggleWidget);
    createWidget();
    render(true);
    startPolling();
    setupUpdater();

    // Keep the tooltip countdown fresh between polls.
    setInterval(() => render(), 30000);
    // Timers drift or stall across sleep; refresh on wake and when the network returns.
    powerMonitor.on('resume', () => setTimeout(poll, 3000));
    powerMonitor.on('unlock-screen', () => poll());
    screen.on('display-removed', keepOnScreen);
    screen.on('display-metrics-changed', keepOnScreen);
  });

  // A tray app keeps running with no windows open.
  app.on('window-all-closed', () => {});
  app.on('before-quit', () => {
    quitting = true;
    if (tray && !tray.isDestroyed()) tray.destroy();
  });
}
