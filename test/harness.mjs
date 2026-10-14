// Shared plumbing for the soak and chaos tests.
//
//  - makeFixtures(): generates throwaway media with ffmpeg (cached in the OS temp
//    dir, never inside the repo).
//  - startServer(): copies the REAL server.ts + index.html into a temp folder with
//    the fixtures and boots it with bun, exactly as a user would.
//  - openShow(): drives the real page in Playwright's Chromium with an observer
//    that counts transitions, uncaught errors and *visible* failures (a broken
//    image, an empty stage, or a dead/black video on the front layer).
//
// Dev-only: nothing here is loaded by the app.

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const sleep = ms => new Promise(r => setTimeout(r, ms));

export function loadPlaywright() {
  for (const c of ['playwright', '/opt/node22/lib/node_modules/playwright']) {
    try { return require(c); } catch {}
  }
  throw new Error('playwright not found (npm i -D playwright in test/, or a global install)');
}

export async function launchBrowser(opts = {}) {
  const { chromium } = loadPlaywright();
  const args = ['--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];
  try {
    return await chromium.launch({ args, ...opts });
  } catch (e) {
    // version mismatch between the npm package and the pre-installed browser
    return await chromium.launch({ args, executablePath: '/opt/pw-browsers/chromium', ...opts });
  }
}

// ---------- fixtures ----------

const FIX_VERSION = 'v2';
export const FIXTURES = path.join(os.tmpdir(), `slideshow-fixtures-${FIX_VERSION}`);

function ff(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
}

// Chromium as shipped by Playwright has no H.264, so test clips are VP9 in MP4
// (the server only looks at the .mp4 extension). Real Chrome on the Mac plays both.
function vp9(out, src, secs) {
  ff(['-f', 'lavfi', '-i', `${src}:d=${secs}`, '-c:v', 'libvpx-vp9', '-b:v', '400k',
      '-deadline', 'realtime', '-cpu-used', '8', '-pix_fmt', 'yuv420p', '-an', out]);
}

export function makeFixtures() {
  const done = path.join(FIXTURES, '.done');
  if (fs.existsSync(done)) return FIXTURES;
  fs.rmSync(FIXTURES, { recursive: true, force: true });
  const good = path.join(FIXTURES, 'good');
  const bad = path.join(FIXTURES, 'bad');
  fs.mkdirSync(good, { recursive: true });
  fs.mkdirSync(bad, { recursive: true });
  const srcs = ['testsrc2', 'smptebars', 'testsrc', 'rgbtestsrc', 'smptehdbars', 'pal75bars'];
  // 24 stills (alternating jpg/png), dated by filename so the order is stable
  for (let i = 0; i < 24; i++) {
    const ext = i % 6 === 5 ? 'png' : 'jpg';
    const name = `IMG_201906${String(1 + i).padStart(2, '0')}_120000.${ext}`;
    ff(['-f', 'lavfi', '-i', `${srcs[i % srcs.length]}=s=1920x1080:d=1`, '-vf', `hue=h=${i * 15}`,
        '-frames:v', '1', path.join(good, name)]);
  }
  // 6 Live Photo pairs (still + same-stem clip)
  for (let i = 0; i < 6; i++) {
    const stem = `IMG_202007${String(1 + i).padStart(2, '0')}_100000`;
    ff(['-f', 'lavfi', '-i', `testsrc2=s=1280x720:d=1`, '-vf', `hue=h=${i * 50}`, '-frames:v', '1',
        path.join(good, stem + '.jpg')]);
    vp9(path.join(good, stem + '.mp4'), `testsrc2=s=640x360:r=24`, 3);
  }
  // 6 standalone clips
  for (let i = 0; i < 6; i++) {
    vp9(path.join(good, `VID_202108${String(1 + i).padStart(2, '0')}_090000.mp4`),
        `${['testsrc', 'smptebars', 'testsrc2'][i % 3]}=s=640x360:r=24`, 2 + (i % 3));
  }
  // the weird files people actually have
  const rnd = n => Buffer.from(Array.from({ length: n }, (_, k) => (k * 7919 + 13) & 255));
  fs.writeFileSync(path.join(bad, 'IMG_20190615_000001.jpg'), rnd(50_000));       // garbage bytes
  fs.writeFileSync(path.join(bad, 'IMG_20190616_000001.png'), Buffer.alloc(0));    // empty file
  fs.writeFileSync(path.join(bad, 'VID_20210803_000001.mp4'), rnd(200_000));       // garbage "video"
  const clip = fs.readFileSync(path.join(good, 'VID_20210801_090000.mp4'));
  fs.writeFileSync(path.join(bad, 'VID_20210804_000001.mp4'), clip.subarray(0, 600)); // truncated video
  const live = fs.readFileSync(path.join(good, 'IMG_20200701_100000.jpg'));
  fs.writeFileSync(path.join(bad, 'IMG_20200703_000001.jpg'), live);               // live pair with broken clip
  fs.writeFileSync(path.join(bad, 'IMG_20200703_000001.mp4'), rnd(10_000));
  fs.writeFileSync(done, new Date().toISOString());
  return FIXTURES;
}

// ---------- server ----------

let nextPort = 18800 + Math.floor(Math.random() * 500);

// Copies the app into a fresh temp folder. `srcDir` lets the baseline run point
// at an older checkout. The port is the only thing patched (the app hardcodes it).
export function prepareRoot({ srcDir = REPO, sets = ['good'], port = nextPort++ } = {}) {
  makeFixtures();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slideshow-run-'));
  fs.copyFileSync(path.join(srcDir, 'index.html'), path.join(root, 'index.html'));
  const srv = fs.readFileSync(path.join(srcDir, 'server.ts'), 'utf8');
  const patched = srv.replace(/const PORT = [^\n]*;/, `const PORT = ${port};`);
  if (patched === srv) throw new Error('could not patch PORT in server.ts');
  fs.writeFileSync(path.join(root, 'server.ts'), patched);
  const launcher = path.join(srcDir, 'Start Slideshow.command');
  if (fs.existsSync(launcher)) fs.copyFileSync(launcher, path.join(root, 'Start Slideshow.command'));
  for (const set of sets) {
    for (const f of fs.readdirSync(path.join(FIXTURES, set))) {
      fs.copyFileSync(path.join(FIXTURES, set, f), path.join(root, f));
    }
  }
  return { root, port, url: `http://127.0.0.1:${port}` };
}

export async function waitUp(url, ms = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url + '/api/slides', { signal: AbortSignal.timeout(1000) });
      if (r.ok) return Date.now() - t0;
    } catch {}
    await sleep(100);
  }
  throw new Error(`server at ${url} did not come up`);
}

export async function startServer(opts = {}) {
  const env = opts.root ? opts : prepareRoot(opts);
  const s = { ...env, proc: null, log: [], unexpectedExits: [], expectExit: false };
  s.start = async () => {
    // "./server.ts" so a stray `pkill -f "bun server.ts"` elsewhere on the box can't hit us
    s.proc = spawn('bun', ['./server.ts'], { cwd: s.root, stdio: ['ignore', 'pipe', 'pipe'] });
    const me = s.proc;
    me.once('exit', (code, sig) => { if (!s.expectExit) s.unexpectedExits.push({ t: new Date().toISOString(), code, sig }); });
    s.expectExit = false;
    const tag = d => s.log.push(String(d));
    s.proc.stdout.on('data', tag);
    s.proc.stderr.on('data', tag);
    await waitUp(s.url);
    return s;
  };
  s.kill = (sig = 'SIGKILL') => new Promise(res => {
    if (!s.proc || s.proc.exitCode != null || s.proc.signalCode) return res();
    s.expectExit = true;
    s.proc.once('exit', () => res());
    s.proc.kill(sig);
  });
  s.alive = () => !!s.proc && s.proc.exitCode == null && !s.proc.signalCode;
  s.stop = async () => { await s.kill('SIGKILL'); };
  s.cleanup = async () => { await s.stop(); fs.rmSync(s.root, { recursive: true, force: true }); };
  await s.start();
  return s;
}

// POST from Node: same-origin as far as the server is concerned (no Origin header).
export async function post(url, p, body) {
  const r = await fetch(url + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let j = null;
  try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
}

// ---------- page ----------

// Injected before any page script runs. Uses the original timer functions so the
// probe itself doesn't show up in the timer counts it reports.
const PROBE = () => {
  const oSetInterval = window.setInterval, oClearInterval = window.clearInterval;
  const oSetTimeout = window.setTimeout, oClearTimeout = window.clearTimeout;
  const intervals = new Set(), timeouts = new Set();
  window.setInterval = function (fn, ms, ...a) { const id = oSetInterval.call(window, fn, ms, ...a); intervals.add(id); return id; };
  window.clearInterval = function (id) { intervals.delete(id); return oClearInterval.call(window, id); };
  window.setTimeout = function (fn, ms, ...a) {
    const id = oSetTimeout.call(window, (...b) => { timeouts.delete(id); return typeof fn === 'function' ? fn(...b) : undefined; }, ms, ...a);
    timeouts.add(id); return id;
  };
  window.clearTimeout = function (id) { timeouts.delete(id); return oClearTimeout.call(window, id); };
  let urls = 0;
  const oC = URL.createObjectURL, oR = URL.revokeObjectURL;
  URL.createObjectURL = function (o) { urls++; return oC.call(URL, o); };
  URL.revokeObjectURL = function (u) { urls--; return oR.call(URL, u); };

  const P = window.__probe = {
    marker: Math.random(), errors: [], transitions: 0, lastTransitionAt: 0,
    failures: [], failureCount: 0,
    get timers() { return { intervals: intervals.size, timeouts: timeouts.size, objectURLs: urls }; },
  };
  window.addEventListener('error', e => { if (e instanceof ErrorEvent) P.errors.push('error: ' + e.message); });
  window.addEventListener('unhandledrejection', e => P.errors.push('rejection: ' + (e.reason && (e.reason.stack || e.reason.message) || e.reason)));

  const start = () => {
    const counter = document.getElementById('barCounter');
    let lastText = counter.textContent;
    new MutationObserver(() => {
      if (counter.textContent !== lastText) { lastText = counter.textContent; P.transitions++; P.lastTransitionAt = Date.now(); }
    }).observe(counter, { childList: true, characterData: true, subtree: true });

    // visible-failure detector
    const seen = new WeakMap();
    let lastKey = null;
    oSetInterval.call(window, () => {
      const layers = [document.getElementById('layerA'), document.getElementById('layerB')];
      const top = layers.find(l => l.style.zIndex === '2');
      if (!top || document.getElementById('empty').style.display === 'grid') { lastKey = null; return; }
      const el = top.firstElementChild;
      let kind = null;
      if (!el) kind = 'blank stage';
      else {
        if (!seen.has(el)) seen.set(el, Date.now());
        const age = Date.now() - seen.get(el);
        if (el.tagName === 'IMG' && el.complete && el.naturalWidth === 0) kind = 'broken image';
        else if (el.tagName === 'IMG' && !el.complete && age > 2000) kind = 'image never loaded';
        else if (el.tagName === 'VIDEO' && el.error) kind = 'video error';
        else if (el.tagName === 'VIDEO' && el.readyState < 2 && age > 2000) kind = 'black video';
      }
      if (!kind) { lastKey = null; return; }
      const key = el || top;
      if (key === lastKey) return;
      lastKey = key;
      P.failureCount++;
      if (P.failures.length < 50) P.failures.push({ t: Date.now(), kind, src: el ? (el.currentSrc || el.src || '') : '' });
    }, 150);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
};

// timeScale > 1 speeds up the slide clock for soak runs by rewriting the one
// timing expression (`settings.duration * 1000`) in the served index.html.
export async function openShow(browser, url, { timeScale = 1, viewport = { width: 1280, height: 720 }, patch } = {}) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript(PROBE);
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e && e.stack || e)));
  const consoleLog = [];
  page.on('console', m => { if (consoleLog.length < 400) consoleLog.push(`[${m.type()}] ${m.text()}`); });
  let patched = 0;
  if (timeScale !== 1 || patch) {
    await page.route(u => { const x = new URL(u); return x.origin === url && (x.pathname === '/' || x.pathname === '/index.html'); }, async route => {
      let res;
      try { res = await route.fetch(); } catch { return route.abort(); }
      let body = await res.text();
      if (timeScale !== 1) {
        body = body.replace(/settings\.duration \* 1000/g, () => { patched++; return `settings.duration * ${1000 / timeScale}`; });
        if (!patched) throw new Error('timeScale: no `settings.duration * 1000` found to patch');
      }
      if (patch) body = patch(body);
      await route.fulfill({ response: res, body, headers: { ...res.headers(), 'content-length': String(Buffer.byteLength(body)) } });
    });
  }
  await page.goto(url + '/');
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Performance.enable');
  const probe = () => page.evaluate(() => ({
    marker: __probe.marker, errors: [...__probe.errors], transitions: __probe.transitions,
    lastTransitionAt: __probe.lastTransitionAt, failures: [...__probe.failures],
    failureCount: __probe.failureCount, timers: __probe.timers, now: Date.now(),
  }));
  return { browser, ctx, page, cdp, pageErrors, consoleLog, probe, close: () => ctx.close() };
}

async function countInstances(cdp, ctor) {
  const { result } = await cdp.send('Runtime.evaluate', { expression: `${ctor}.prototype` });
  const { objects } = await cdp.send('Runtime.queryObjects', { prototypeObjectId: result.objectId });
  const { result: r } = await cdp.send('Runtime.callFunctionOn', {
    objectId: objects.objectId, returnByValue: true,
    functionDeclaration: 'function(){return {total:this.length, detached:this.filter(e=>!e.isConnected).length}}',
  });
  await cdp.send('Runtime.releaseObject', { objectId: objects.objectId });
  await cdp.send('Runtime.releaseObject', { objectId: result.objectId });
  return r.value;
}

// One memory sample: forced GC, then CDP Performance metrics + live media elements.
export async function sample(show) {
  await show.cdp.send('HeapProfiler.collectGarbage');
  const { metrics } = await show.cdp.send('Performance.getMetrics');
  const m = Object.fromEntries(metrics.map(x => [x.name, x.value]));
  const videos = await countInstances(show.cdp, 'HTMLVideoElement');
  const images = await countInstances(show.cdp, 'HTMLImageElement');
  const p = await show.probe();
  // native memory too (decoded images, media players live outside the JS heap)
  let rssMB = null;
  try {
    show.bcdp ??= await show.browser.newBrowserCDPSession();
    const { processInfo } = await show.bcdp.send('SystemInfo.getProcessInfo');
    let kb = 0;
    for (const pr of processInfo.filter(x => x.type === 'renderer')) {
      const st = fs.readFileSync(`/proc/${pr.id}/status`, 'utf8');
      kb += +(/VmRSS:\s+(\d+)/.exec(st)?.[1] ?? 0);
    }
    rssMB = +(kb / 1024).toFixed(1);
  } catch {}
  return {
    rendererRssMB: rssMB,
    heapMB: +(m.JSHeapUsedSize / 1048576).toFixed(2),
    nodes: m.Nodes, listeners: m.JSEventListeners, layoutObjects: m.LayoutObjects, documents: m.Documents,
    videos: videos.total, videosDetached: videos.detached, images: images.total, imagesDetached: images.detached,
    ...p.timers, transitions: p.transitions, failures: p.failureCount, errors: p.errors.length,
  };
}

// least-squares slope of y over x
export function slope(xs, ys) {
  const n = xs.length;
  if (n < 2) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  return den ? num / den : 0;
}
