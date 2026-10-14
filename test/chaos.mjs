// Chaos / fault-injection suite. Every fault has a defined graceful behaviour
// and a check that it holds against the real server + real page.
//
//   node test/chaos.mjs [scenario ...] [--src <dir with server.ts+index.html>] [--out result.json]
//
// With no scenario names, runs them all. Prints a results table and exits
// non-zero if any scenario fails.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { launchBrowser, startServer, prepareRoot, waitUp, openShow, post, sleep } from './harness.mjs';

const argv = process.argv.slice(2);
const opt = k => { const i = argv.indexOf('--' + k); if (i < 0) return undefined; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const SRC = opt('src');
const OUT = opt('out');
const SCALE = 2; // 3 s slides run at 1.5 s
const ONLY = argv;

const browser = await launchBrowser();

// ---------- helpers ----------

async function waitFor(fn, ms, step = 100) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await sleep(step);
  }
  return null;
}

async function waitTransitions(show, n, ms) {
  const start = (await show.probe()).transitions;
  return !!(await waitFor(async () => (await show.probe()).transitions >= start + n, ms));
}

// time (ms) from `since` until the next counter change
async function timeToNextTransition(show, since, ms) {
  const start = (await show.probe()).transitions;
  const ok = await waitFor(async () => (await show.probe()).transitions > start, ms);
  return ok ? Date.now() - since : null;
}

async function boot({ sets = ['good'], settings = {}, timeScale = SCALE, patch } = {}) {
  const server = await startServer({ srcDir: SRC, sets });
  await post(server.url, '/api/settings', { patch: { duration: 3, transition: 'fade', media: 'video', ...settings } });
  const show = await openShow(browser, server.url, { timeScale, patch });
  return { server, show };
}

// state every scenario must end in: no uncaught errors (minus expected ones),
// nothing broken on screen, no page reload
async function healthy(show, marker, { allowErrors = 0 } = {}) {
  const p = await show.probe();
  // the probe and Playwright both see each uncaught error; count it once
  const errors = p.errors.length >= show.pageErrors.length ? p.errors : show.pageErrors;
  const problems = [];
  if (errors.length > allowErrors) problems.push(`uncaught errors: ${errors.slice(0, 3).join(' | ')}`);
  if (p.failureCount) problems.push(`visible failures: ${p.failureCount} (${p.failures.slice(0, 3).map(f => f.kind + ' ' + f.src.split('/').pop()).join(', ')})`);
  if (marker != null && p.marker !== marker) problems.push('page was reloaded');
  return { ok: !problems.length, problems, errors, p };
}

const frontSrc = show => show.page.evaluate(() => {
  const top = ['layerA', 'layerB'].map(id => document.getElementById(id)).find(l => l.style.zIndex === '2');
  const el = top && top.firstElementChild;
  return el ? decodeURIComponent((el.currentSrc || el.src || '').split('/').pop().split('?')[0]) : null;
});

function rawRequest(port, { method = 'GET', path: p, headers = {}, body } = {}) {
  return new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, res => {
      let data = '';
      res.on('data', d => { if (data.length < 2000) data += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', e => resolve({ status: 0, body: String(e) }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
    if (body) req.write(body);
    req.end();
  });
}

// ---------- scenarios ----------

const scenarios = {};

scenarios['server-kill-restart'] = {
  fault: 'Server SIGKILLed mid-show, restarted 4 s later',
  expect: 'Last good slide stays up (no broken images); show resumes by itself <10 s after restart; no reload',
  async run() {
    const { server, show } = await boot();
    try {
      await waitTransitions(show, 4, 20000);
      const marker = (await show.probe()).marker;
      await server.kill('SIGKILL');
      await sleep(4000);
      await server.start();
      const restartedAt = Date.now();
      const resumeMs = await timeToNextTransition(show, restartedAt, 15000);
      const more = await waitTransitions(show, 3, 15000);
      const h = await healthy(show, marker);
      const ok = h.ok && resumeMs != null && resumeMs <= 10000 && more;
      return { ok, detail: `resumed ${resumeMs == null ? 'never' : (resumeMs / 1000).toFixed(1) + ' s'} after restart; ${h.problems.join('; ') || 'clean'}` };
    } finally { await show.close(); await server.cleanup(); }
  },
};

scenarios['launcher-supervisor'] = {
  fault: 'Launcher running; its bun server is SIGKILLed (and again a 2nd time)',
  expect: 'Launcher restarts the server within a few seconds each time; page resumes <10 s with no reload',
  async run() {
    const env = prepareRoot({ srcDir: SRC });
    // Linux stand-ins for the macOS tools the launcher calls
    const shim = fs.mkdtempSync(path.join(os.tmpdir(), 'slideshow-shim-'));
    fs.writeFileSync(path.join(shim, 'open'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(shim, 'caffeinate'), '#!/bin/sh\nexec sleep 100000\n', { mode: 0o755 });
    const launcher = spawn('bash', [path.join(env.root, 'Start Slideshow.command')], {
      cwd: env.root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: `${shim}:${process.env.PATH}` },
    });
    let out = '';
    launcher.stdout.on('data', d => out += d); launcher.stderr.on('data', d => out += d);
    let show;
    const bunPid = () => {
      try {
        const pids = execFileSync('pgrep', ['-f', 'bun server.ts'], { encoding: 'utf8' }).trim().split('\n').map(Number);
        return pids.find(pid => { try { return fs.readlinkSync(`/proc/${pid}/cwd`) === env.root; } catch { return false; } }) ?? null;
      } catch { return null; }
    };
    try {
      await waitUp(env.url, 30000);
      await post(env.url, '/api/settings', { patch: { duration: 3, media: 'video' } });
      show = await openShow(browser, env.url, { timeScale: SCALE });
      await waitTransitions(show, 3, 20000);
      const marker = (await show.probe()).marker;
      const resumes = [];
      for (let round = 0; round < 2; round++) {
        const pid = bunPid();
        if (!pid) return { ok: false, detail: 'could not find the server process' };
        const killedAt = Date.now();
        process.kill(pid, 'SIGKILL');
        const back = await waitFor(async () => { const p = bunPid(); return p && p !== pid ? p : null; }, 10000);
        if (!back) return { ok: false, detail: `round ${round + 1}: server was not restarted by the launcher (launcher ${launcher.exitCode != null ? 'exited ' + launcher.exitCode : 'still running'})` };
        await waitUp(env.url, 15000);
        const ms = await timeToNextTransition(show, killedAt, 20000);
        resumes.push(ms);
        await waitTransitions(show, 2, 15000);
      }
      const h = await healthy(show, marker);
      const ok = h.ok && resumes.every(ms => ms != null && ms <= 10000);
      return { ok, detail: `kill→resume ${resumes.map(ms => ms == null ? 'never' : (ms / 1000).toFixed(1) + ' s').join(', ')}; ${h.problems.join('; ') || 'clean'}` };
    } finally {
      if (show) await show.close();
      try { process.kill(-launcher.pid, 'SIGKILL'); } catch {}
      const pid = bunPid(); if (pid) try { process.kill(pid, 'SIGKILL'); } catch {}
      fs.rmSync(env.root, { recursive: true, force: true });
      fs.rmSync(shim, { recursive: true, force: true });
    }
  },
};

scenarios['api-500'] = {
  fault: 'Every /api/* call returns HTTP 500 for 12 s; host clicks Rescan and changes a setting meanwhile',
  expect: 'No uncaught errors; show keeps advancing; UI reports the failure',
  async run() {
    const { server, show } = await boot();
    try {
      await waitTransitions(show, 2, 20000);
      const marker = (await show.probe()).marker;
      const isApi = u => new URL(u).pathname.startsWith('/api/');
      await show.page.route(isApi, r => r.fulfill({ status: 500, body: 'Internal Server Error', contentType: 'text/plain' }));
      await show.page.evaluate(() => {
        document.getElementById('rescanBtn').click();
        document.querySelector('#segCap [data-v="age"]').click();
      });
      const kept = await waitTransitions(show, 4, 12000);
      await sleep(1000);
      const status = await show.page.evaluate(() => document.getElementById('upStatus').textContent);
      await show.page.unroute(isApi);
      const h = await healthy(show, marker);
      return { ok: h.ok && kept, detail: `kept advancing: ${kept}; status line: "${status}"; ${h.problems.join('; ') || 'clean'}` };
    } finally { await show.close(); await server.cleanup(); }
  },
};

scenarios['media-500'] = {
  fault: 'Every photo/video request returns HTTP 500 for 10 s (API still fine)',
  expect: 'Current slide stays up, nothing broken is shown; show resumes <10 s after the fault clears',
  async run() {
    const { server, show } = await boot();
    try {
      await waitTransitions(show, 3, 20000);
      const marker = (await show.probe()).marker;
      const isMedia = u => { const p = new URL(u).pathname; return p !== '/' && !p.startsWith('/api/'); };
      await show.page.route(isMedia, r => r.fulfill({ status: 500, body: 'nope' }));
      await sleep(10000);
      await show.page.unroute(isMedia);
      const clearedAt = Date.now();
      const resumeMs = await timeToNextTransition(show, clearedAt, 15000);
      const more = await waitTransitions(show, 2, 10000);
      const h = await healthy(show, marker);
      return { ok: h.ok && resumeMs != null && resumeMs <= 10000 && more, detail: `resumed ${resumeMs == null ? 'never' : (resumeMs / 1000).toFixed(1) + ' s'} after the fault cleared; ${h.problems.join('; ') || 'clean'}` };
    } finally { await show.close(); await server.cleanup(); }
  },
};

scenarios['corrupt-files'] = {
  fault: 'Folder contains garbage .jpg, empty .png, garbage .mp4, truncated .mp4, Live Photo with a broken clip',
  expect: 'Server boots; each bad file is skipped silently in both video and photo mode; no errors',
  async run() {
    const { server, show } = await boot({ sets: ['good', 'bad'] });
    try {
      const n = await show.page.evaluate(() => +document.getElementById('barCounter').textContent.split('/')[1]);
      const marker = (await show.probe()).marker;
      const a = await waitTransitions(show, n + 3, n * 4000);
      await show.page.evaluate(() => document.querySelector('#segMedia [data-v="photo"]').click());
      const b = await waitTransitions(show, n + 3, n * 4000);
      const h = await healthy(show, marker);
      return { ok: h.ok && a && b && server.alive(), detail: `${n} slides, two full cycles (video, photo): ${a && b ? 'completed' : 'STALLED'}; ${h.problems.join('; ') || 'clean'}` };
    } finally { await show.close(); await server.cleanup(); }
  },
};

scenarios['delete-while-displayed'] = {
  fault: 'The photo on screen and the next three files are deleted from disk mid-show',
  expect: 'On-screen photo stays; deleted files are skipped; a rescan drops them; no errors',
  async run() {
    const { server, show } = await boot({ settings: { media: 'photo' } });
    try {
      await waitTransitions(show, 2, 20000);
      const marker = (await show.probe()).marker;
      const n = await show.page.evaluate(() => +document.getElementById('barCounter').textContent.split('/')[1]);
      const onScreen = await frontSrc(show);
      const all = fs.readdirSync(server.root).filter(f => /\.(jpg|png)$/i.test(f)).sort();
      const i = all.indexOf(onScreen);
      const victims = [onScreen, ...all.slice(i + 1, i + 4)].filter(Boolean);
      for (const v of victims) fs.rmSync(path.join(server.root, v), { force: true });
      await sleep(800);
      const stillThere = await show.page.evaluate(() => {
        const top = ['layerA', 'layerB'].map(id => document.getElementById(id)).find(l => l.style.zIndex === '2');
        const el = top && top.firstElementChild;
        return !!el && (el.tagName !== 'IMG' || el.naturalWidth > 0);
      });
      const cycled = await waitTransitions(show, n, n * 4000);
      const r = await post(server.url, '/api/rescan', {});
      const more = await waitTransitions(show, 3, 15000);
      const h = await healthy(show, marker);
      return { ok: h.ok && stillThere && cycled && more && r.status === 200, detail: `deleted ${victims.length} (incl. on-screen ${onScreen}); on-screen intact: ${stillThere}; full cycle: ${cycled}; rescan ${r.status} → ${r.json?.count} slides; ${h.problems.join('; ') || 'clean'}` };
    } finally { await show.close(); await server.cleanup(); }
  },
};

scenarios['disk-full-upload'] = {
  fault: 'uploads/ is on a full disk (1 MB tmpfs) when a 3 MB photo and a 3 MB video are uploaded',
  expect: 'Clean JSON error; no partial/corrupt file left in uploads/; server stays up; a later small upload works',
  async run() {
    const server = await startServer({ srcDir: SRC });
    const up = path.join(server.root, 'uploads');
    fs.mkdirSync(up, { recursive: true });
    try {
      try { execFileSync('mount', ['-t', 'tmpfs', '-o', 'size=1m', 'tmpfs', up], { stdio: 'pipe' }); }
      catch (e) { return { ok: null, detail: 'SKIPPED: cannot mount a tmpfs here (needs root)' }; }
      const big = Buffer.alloc(3 * 1024 * 1024, 7);
      const r1 = await fetch(`${server.url}/api/upload?name=big.jpg`, { method: 'POST', body: big }).then(async r => ({ s: r.status, j: await r.json().catch(() => null) })).catch(e => ({ s: 0, j: String(e) }));
      const vid = fs.readFileSync(path.join(server.root, 'VID_20210801_090000.mp4'));
      const bigVid = Buffer.concat([vid, Buffer.alloc(3 * 1024 * 1024)]);
      const r2 = await fetch(`${server.url}/api/upload?name=big.mp4`, { method: 'POST', body: bigVid }).then(async r => ({ s: r.status, j: await r.json().catch(() => null) })).catch(e => ({ s: 0, j: String(e) }));
      const left = fs.readdirSync(up);
      const slides = (await (await fetch(server.url + '/api/slides')).json()).slides;
      const corrupt = slides.filter(s => s.id.startsWith('uploads/'));
      const small = fs.readFileSync(path.join(server.root, 'IMG_20190601_120000.jpg'));
      const r3 = await fetch(`${server.url}/api/upload?name=small.jpg`, { method: 'POST', body: small }).then(async r => ({ s: r.status, j: await r.json().catch(() => null) }));
      const cleanErr = r => r.s >= 400 && r.j && r.j.ok === false && typeof r.j.error === 'string';
      const ok = cleanErr(r1) && cleanErr(r2) && left.length === 0 && corrupt.length === 0 && r3.s === 200 && r3.j?.ok && server.alive();
      return { ok, detail: `photo → ${r1.s} "${r1.j?.error ?? r1.j}"; video → ${r2.s} "${r2.j?.error ?? r2.j}"; left in uploads/: [${left.join(', ')}]; corrupt slides: ${corrupt.length}; small upload after → ${r3.s}` };
    } finally {
      try { execFileSync('umount', ['-l', up], { stdio: 'pipe' }); } catch {}
      await server.cleanup();
    }
  },
};

scenarios['db-locked'] = {
  fault: 'Another process holds an EXCLUSIVE lock on slideshow.db for 8 s',
  expect: 'Show keeps going; reads still work; writes wait then succeed, or fail with clean JSON (never hang/crash)',
  async run() {
    const { server, show } = await boot();
    const locker = path.join(server.root, '_lock.ts');
    fs.writeFileSync(locker, `import { Database } from 'bun:sqlite';
      const db = new Database(process.argv[2]);
      db.run('BEGIN EXCLUSIVE');
      db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('zzlock', '1')");
      console.log('locked');
      await Bun.sleep(8000);
      db.run('COMMIT');
      console.log('released');`);
    try {
      await waitTransitions(show, 2, 20000);
      const marker = (await show.probe()).marker;
      const lk = spawn('bun', [locker, path.join(server.root, 'slideshow.db')], { stdio: ['ignore', 'pipe', 'pipe'] });
      let lockOut = '';
      lk.stdout.on('data', d => lockOut += d); lk.stderr.on('data', d => lockOut += d);
      await waitFor(() => lockOut.includes('locked') || lk.exitCode != null, 5000);
      const t0 = Date.now();
      const read = await rawRequest(server.port, { path: '/api/slides' });
      const readMs = Date.now() - t0;
      const t1 = Date.now();
      const write = await post(server.url, '/api/settings', { patch: { caption: 'off' } });
      const writeMs = Date.now() - t1;
      const kept = await waitTransitions(show, 3, 15000);
      await new Promise(r => lk.exitCode != null ? r() : lk.once('exit', r));
      const after = await post(server.url, '/api/settings', { patch: { caption: 'date' } });
      const h = await healthy(show, marker);
      const writeOk = write.status === 200 || (write.status >= 500 && write.json && write.json.ok === false);
      const ok = h.ok && kept && read.status === 200 && writeOk && writeMs < 9000 && after.status === 200 && server.alive();
      return { ok, detail: `locker: ${lockOut.trim().replace(/\n/g, '/') || 'n/a'}; read ${read.status} in ${readMs} ms; write ${write.status} in ${writeMs} ms; write after release ${after.status}; show kept going: ${kept}; ${h.problems.join('; ') || 'clean'}` };
    } finally { await show.close(); await server.cleanup(); }
  },
};

scenarios['server-frozen'] = {
  fault: 'Server process SIGSTOPped for 12 s (requests hang, nothing errors), then SIGCONT',
  expect: 'No broken/black slide; show resumes <10 s after the server thaws',
  async run() {
    const { server, show } = await boot();
    try {
      await waitTransitions(show, 3, 20000);
      const marker = (await show.probe()).marker;
      server.proc.kill('SIGSTOP');
      await sleep(12000);
      server.proc.kill('SIGCONT');
      const thawed = Date.now();
      const resumeMs = await timeToNextTransition(show, thawed, 15000);
      const more = await waitTransitions(show, 3, 15000);
      const h = await healthy(show, marker);
      return { ok: h.ok && resumeMs != null && resumeMs <= 10000 && more, detail: `resumed ${resumeMs == null ? 'never' : (resumeMs / 1000).toFixed(1) + ' s'} after thaw; ${h.problems.join('; ') || 'clean'}` };
    } finally { await show.close(); await server.cleanup(); }
  },
};

scenarios['exception-in-loop'] = {
  fault: 'A JS exception is thrown inside the slide-advance path (injected once)',
  expect: 'Error is logged; watchdog notices the stalled timer and the show self-heals without a reload',
  async run() {
    const anchor = /(\n\s*)maybeRenderSlideTab\(\);(\s*\n\s*preload\()/;
    const patch = body => {
      if (!anchor.test(body)) throw new Error('exception-in-loop: anchor not found in index.html');
      return body.replace(anchor, `$1if (window.__boom) { window.__boom = false; throw new Error('injected fault'); }$1maybeRenderSlideTab();$2`);
    };
    const { server, show } = await boot({ patch });
    try {
      await waitTransitions(show, 2, 20000);
      const marker = (await show.probe()).marker;
      await show.page.evaluate(() => { window.__boom = true; });
      await waitFor(async () => (await show.probe()).errors.length > 0 || show.pageErrors.length > 0, 10000);
      const at = Date.now();
      const resumeMs = await timeToNextTransition(show, at, 30000);
      const more = await waitTransitions(show, 3, 15000);
      const h = await healthy(show, marker, { allowErrors: 1 });
      return { ok: h.ok && resumeMs != null && more, detail: `recovered ${resumeMs == null ? 'never' : (resumeMs / 1000).toFixed(1) + ' s'} after the exception; ${h.problems.join('; ') || 'clean'}` };
    } finally { await show.close(); await server.cleanup(); }
  },
};

scenarios['wake-lock'] = {
  fault: 'Screen wake lock is dropped by the browser (as when the tab is hidden), then the tab is visible again',
  expect: 'Wake lock is held during the show and re-acquired within seconds of being lost',
  async run() {
    // new-headless Chromium grants wake locks (the headless shell always refuses)
    const b2 = await launchBrowser({ channel: 'chromium' });
    const server = await startServer({ srcDir: SRC });
    await post(server.url, '/api/settings', { patch: { duration: 3, media: 'video' } });
    const ctx = await b2.newContext();
    // keep a handle on each sentinel so the test can drop it the way the browser does
    await ctx.addInitScript(() => {
      window.__sentinels = [];
      const wl = navigator.wakeLock;
      if (!wl) return;
      const orig = wl.request.bind(wl);
      wl.request = async (...a) => { const s = await orig(...a); window.__sentinels.push(s); return s; };
    });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(String(e)));
    try {
      await page.goto(server.url + '/');
      const state = () => page.evaluate(() => window.__slideshow && window.__slideshow.wakeLock);
      const first = await waitFor(async () => (await state()) === 'held' && 'held', 6000) || await state();
      const rounds = [];
      for (let i = 0; i < 2; i++) {
        await page.evaluate(async () => { const s = window.__sentinels.at(-1); if (s && !s.released) await s.release(); });
        const dropped = await state();
        if (i === 1) await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
        const t0 = Date.now();
        const back = await waitFor(async () => (await page.evaluate(() => window.__sentinels.length && !window.__sentinels.at(-1).released)) && (await state()) === 'held', 6000);
        rounds.push(`${dropped} → ${back ? 'held again in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s' : 'NOT re-acquired'}`);
      }
      const ok = first === 'held' && rounds.every(r => r.includes('held again')) && !errs.length;
      return { ok, detail: `initial: ${first}; ${rounds.join('; ')}${errs.length ? '; errors: ' + errs[0] : ''}` };
    } finally { await ctx.close(); await b2.close(); await server.cleanup(); }
  },
};

scenarios['rapid-skip'] = {
  fault: 'A guest double-taps → repeatedly while videos are slow to load (1.2 s), then mashes keys',
  expect: 'Never a blank or broken stage; media elements are released (no <video> build-up)',
  async run() {
    const { server, show } = await boot();
    try {
      await waitTransitions(show, 2, 20000);
      const marker = (await show.probe()).marker;
      // slow videos stretch the window between building a slide and revealing it
      await show.page.route(u => new URL(u).pathname.endsWith('.mp4'), async r => { await sleep(1200); r.continue().catch(() => {}); });
      for (let i = 0; i < 24; i++) {
        await show.page.keyboard.press('ArrowRight');
        await sleep(300);
        await show.page.keyboard.press('ArrowRight');
        await sleep(1800);
      }
      for (let i = 0; i < 30; i++) {
        await show.page.keyboard.press(i % 7 === 6 ? 'ArrowLeft' : 'ArrowRight');
        await sleep([120, 300, 700, 1050, 1150][i % 5]);
      }
      await show.page.unroute(u => new URL(u).pathname.endsWith('.mp4'));
      await sleep(3000);
      const more = await waitTransitions(show, 2, 10000);
      await show.cdp.send('HeapProfiler.collectGarbage');
      const vids = await show.page.evaluate(() => document.querySelectorAll('video').length);
      const h = await healthy(show, marker);
      return { ok: h.ok && more && vids <= 2, detail: `<video> in DOM afterwards: ${vids}; show still advancing: ${more}; ${h.problems.join('; ') || 'clean'}` };
    } finally { await show.close(); await server.cleanup(); }
  },
};

scenarios['security'] = {
  fault: 'Path traversal, DNS rebinding (foreign Host), CSRF from another origin (incl. a real browser page), bad JSON, malformed URLs',
  expect: 'Nothing outside the folder is served; foreign Host/Origin get 403; no state changes; server stays up',
  async run() {
    const server = await startServer({ srcDir: SRC });
    const evil = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<script>
        const T = 'http://127.0.0.1:${server.port}';
        const opts = b => ({ method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(b) });
        Promise.allSettled([
          fetch(T + '/api/settings', opts({ patch: { caption: 'off', birthday: '1999-09-09' } })),
          fetch(T + '/api/override', opts({ id: 'IMG_20190601_120000.jpg', patch: { hidden: true } })),
          fetch(T + '/api/upload?name=pwned.jpg', { method: 'POST', mode: 'no-cors', body: 'x'.repeat(1000) }),
        ]).then(() => { document.title = 'done'; });
      </script>`);
    });
    await new Promise(r => evil.listen(0, '127.0.0.1', r));
    const evilPort = evil.address().port;
    fs.mkdirSync(path.join(server.root, '.git'), { recursive: true });
    fs.writeFileSync(path.join(server.root, '.git', 'config'), '[secret]');
    const results = [];
    const check = (name, cond, info) => results.push({ name, ok: !!cond, info });
    try {
      const P = server.port;
      for (const p of ['/../server.ts', '/..%2fserver.ts', '/%2e%2e/%2e%2e/etc/passwd', '/../../../../etc/passwd', '/server.ts', '/slideshow.db', '/.git/config', '/%2e%2e%2f%2e%2e%2fetc%2fpasswd']) {
        const r = await rawRequest(P, { path: p });
        check(`GET ${p}`, r.status >= 400 && !/root:|\[secret\]|bun:sqlite|SQLite format/.test(r.body), r.status);
      }
      const bad = await rawRequest(P, { path: '/%E0%A4%A' });
      check('malformed %-encoding', bad.status === 400, bad.status);
      const nul = await rawRequest(P, { path: '/index.html%00.jpg' });
      check('NUL byte in path', nul.status >= 400 && nul.status < 500, nul.status);
      for (const p of ['/', '/api/slides']) {
        const r = await rawRequest(P, { path: p, headers: { Host: `attacker.example:${P}` } });
        check(`DNS rebinding Host on ${p}`, r.status === 403, r.status);
      }
      const ok1 = await rawRequest(P, { path: '/api/slides', headers: { Host: `localhost:${P}` } });
      check('Host localhost still allowed', ok1.status === 200, ok1.status);
      const before = (await (await fetch(server.url + '/api/slides')).json());
      const csrf = await rawRequest(P, { method: 'POST', path: '/api/settings', headers: { Origin: 'http://evil.example', 'Content-Type': 'text/plain' }, body: JSON.stringify({ patch: { caption: 'off' } }) });
      check('CSRF POST with foreign Origin', csrf.status === 403, csrf.status);
      const sfs = await rawRequest(P, { method: 'POST', path: '/api/override', headers: { 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'text/plain' }, body: JSON.stringify({ id: 'IMG_20190601_120000.jpg', patch: { hidden: true } }) });
      check('CSRF POST with Sec-Fetch-Site: cross-site', sfs.status === 403, sfs.status);
      const same = await rawRequest(P, { method: 'POST', path: '/api/settings', headers: { Origin: `http://127.0.0.1:${P}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ patch: { transition: 'fade' } }) });
      check('same-origin POST allowed', same.status === 200, same.status);
      const badJson = await rawRequest(P, { method: 'POST', path: '/api/settings', headers: { 'Content-Type': 'application/json' }, body: '{nope' });
      check('invalid JSON → 400', badJson.status === 400, badJson.status);
      const badOv = await rawRequest(P, { method: 'POST', path: '/api/override', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ patch: { hidden: true } }) });
      check('override without id → 400', badOv.status === 400, badOv.status);
      const trav = await fetch(`${server.url}/api/upload?name=${encodeURIComponent('../../escape.jpg')}`, { method: 'POST', body: fs.readFileSync(path.join(server.root, 'IMG_20190601_120000.jpg')) });
      check('upload name traversal stays in uploads/', trav.status === 200 && fs.existsSync(path.join(server.root, 'uploads', 'escape.jpg')) && !fs.existsSync(path.join(path.dirname(server.root), 'escape.jpg')), trav.status);
      // a real browser on another origin trying to drive the local API
      const ctx = await browser.newContext();
      const pg = await ctx.newPage();
      await pg.goto(`http://localhost:${evilPort}/`);
      await pg.waitForFunction(() => document.title === 'done', null, { timeout: 10000 }).catch(() => {});
      await ctx.close();
      const after = (await (await fetch(server.url + '/api/slides')).json());
      check('browser CSRF: settings unchanged', after.settings.caption === before.settings.caption && after.settings.birthday === before.settings.birthday, `${before.settings.caption}→${after.settings.caption}`);
      check('browser CSRF: nothing hidden', !after.overrides['IMG_20190601_120000.jpg']?.hidden, JSON.stringify(after.overrides['IMG_20190601_120000.jpg'] || {}));
      check('browser CSRF: nothing uploaded', !fs.existsSync(path.join(server.root, 'uploads', 'pwned.jpg')), '');
      check('server still alive', server.alive(), '');
      const failed = results.filter(r => !r.ok);
      return { ok: !failed.length, detail: `${results.length - failed.length}/${results.length} checks passed` + (failed.length ? `; FAILED: ${failed.map(f => `${f.name} (${f.info})`).join(', ')}` : '') };
    } finally { evil.close(); await server.cleanup(); }
  },
};

scenarios['boot-retry'] = {
  fault: 'Page loads but /api/slides is unreachable for its first 8 s (server mid-restart)',
  expect: 'Page keeps retrying and starts the show by itself, no manual reload',
  async run() {
    const server = await startServer({ srcDir: SRC });
    await post(server.url, '/api/settings', { patch: { duration: 3, media: 'video' } });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(String(e)));
    const until = Date.now() + 8000;
    await page.route(u => new URL(u).pathname === '/api/slides', r => Date.now() < until ? r.abort('connectionrefused') : r.continue());
    try {
      await page.goto(server.url + '/');
      const started = await waitFor(() => page.evaluate(() => {
        const t = document.getElementById('barCounter').textContent;
        return /\d+ \/ \d+/.test(t) && document.getElementById('empty').style.display !== 'grid' && t;
      }).catch(() => null), 20000);
      return { ok: !!started && !errs.length, detail: started ? `show started (${started}) ${((Date.now() - until) / 1000 + 0).toFixed(1)} s after the API came back` : `still showing "${await page.evaluate(() => document.getElementById('emptyTitle').textContent)}"` + (errs.length ? `; errors: ${errs[0]}` : '') };
    } finally { await ctx.close(); await server.cleanup(); }
  },
};

// ---------- run ----------

const names = ONLY.length ? ONLY : Object.keys(scenarios);
const results = [];
for (const name of names) {
  const sc = scenarios[name];
  if (!sc) { console.log(`unknown scenario ${name}`); continue; }
  const t0 = Date.now();
  let r;
  try { r = await sc.run(); } catch (e) { r = { ok: false, detail: 'harness error: ' + (e.stack || e) }; }
  r = { name, fault: sc.fault, expect: sc.expect, ...r, secs: Math.round((Date.now() - t0) / 1000) };
  results.push(r);
  console.log(`${r.ok === null ? 'SKIP' : r.ok ? 'PASS' : 'FAIL'}  ${name} (${r.secs}s) — ${r.detail}`);
}
await browser.close();
console.log('\n| Scenario | Fault | Result | Detail |\n|---|---|---|---|');
for (const r of results) console.log(`| ${r.name} | ${r.fault} | ${r.ok === null ? 'SKIP' : r.ok ? 'PASS' : 'FAIL'} | ${r.detail.replace(/\|/g, '/')} |`);
if (OUT) fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
process.exit(results.every(r => r.ok !== false) ? 0 : 1);
