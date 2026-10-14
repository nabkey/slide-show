#!/usr/bin/env node
// Playout harness for the slideshow: boots the real server on a temp folder of
// generated media, lets the real page auto-advance (nobody touching it), and
// measures what the room would see.
//
//   node test/playout.mjs [options]
//     --slides N        transitions to record (default 200 = one full lap)
//     --duration S      seconds per slide (default 3, the UI minimum)
//     --transition T    fade | slide | kenburns | none (default fade)
//     --media M         video | photo (default video: clips play)
//     --html FILE       index.html to test (default ../index.html) — e.g. a
//                       `git show <rev>:index.html` copy for a baseline
//     --shots DIR       save a mid-slide screenshot of the first slide of each
//                       interesting category (portrait, pano, tiny, ...)
//     --out FILE        write the full JSON report here
//     --fixtures DIR    fixture cache (default $TMPDIR/slideshow-fixtures)
//     --keep            keep the temp show folder
//     --headed          run a visible browser
//     --pass P          both | timing | screen (default both)
//     --no-cover        skip the in-page coverage probe (it reads computed style)
//     --priority N      nice value for the run and its children (default -10)
//     --inject-css CSS  add a stylesheet (A/B experiments on rendering cost)
//
// It runs the show twice: a TIMING pass (rAF only — the screencast's per-frame
// PNG encoding steals enough CPU to drop frames on its own) and a SCREEN pass
// (screencast + screenshots). Frame stats come from the first, pixels from the
// second.
//
// Instruments (all from outside the app's code):
//   * rAF timestamps in the page -> frame deltas, split into transition windows
//     (counter change -50 ms .. +1250 ms) and steady state
//   * CDP screencast of every composited frame (320x180 PNG) -> per-frame mean
//     luminance and fraction of non-dark pixels. A frame with <2 % non-dark
//     pixels is BLANK. A transition whose darkest frame is <85 % of the dimmer
//     of its two endpoints is a DIP (a visible dark flash).
//   * per-frame "ready coverage": opacity-weighted, on-screen area of <img>/<video>
//     in #stage that actually have pixels (img complete, video readyState >= 2)
//   * long-animation-frame entries
//
// Requires: bun, ffmpeg, and Playwright with Chromium (PLAYWRIGHT_BROWSERS_PATH).
// Set PLAYWRIGHT_MODULE to point at a playwright install if it isn't resolvable.

import { spawn } from 'node:child_process';
import { copyFileSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureFixtures } from './playout-fixtures.mjs';
import { pngStats } from './png.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

// ---------- options ----------
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i < 0 ? def : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true);
};
const SLIDES = parseInt(opt('slides', '200'), 10);
const DURATION = parseFloat(opt('duration', '3'));
const TRANSITION = opt('transition', 'fade');
const MEDIA = opt('media', 'video');
const HTML = path.resolve(opt('html', path.join(REPO, 'index.html')));
const SHOTS_DIR = opt('shots', null);
const OUT = opt('out', null);
const FIXTURES = path.resolve(opt('fixtures', path.join(tmpdir(), 'slideshow-fixtures')));
const KEEP = !!opt('keep', false);
const HEADED = !!opt('headed', false);
const NO_COVER = !!opt('no-cover', false);
const PRIORITY = parseInt(opt('priority', '-10'), 10);
const INJECT_CSS = opt('inject-css', null); // A/B experiments, e.g. #grain{display:none}
const VW = 1280, VH = 720;

// Other work on the machine (builds, other test runs) preempts the renderer and
// shows up as dropped frames that have nothing to do with the page. Raise our
// priority (inherited by bun and Chromium) so the numbers measure the page.
try { os.setPriority(PRIORITY); } catch { console.log(`(could not set priority ${PRIORITY}; numbers may include machine noise)`); }

async function loadPlaywright() {
  const tries = [process.env.PLAYWRIGHT_MODULE, 'playwright', '/opt/node-tools/node_modules/playwright/index.mjs'].filter(Boolean);
  for (const t of tries) {
    try { return await import(t); } catch {}
  }
  throw new Error('playwright not found; set PLAYWRIGHT_MODULE');
}

// ---------- stats helpers ----------
const pct = (arr, q) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const r1 = v => (v == null ? null : Math.round(v * 10) / 10);
const median = a => pct(a, 0.5);

// ---------- in-page instrumentation ----------
const INSTRUMENT = (noCover) => {
  const H = (window.__H = { raf: [], counter: [], cover: [], loaf: [], origin: performance.timeOrigin });
  let last = null;
  const vw = innerWidth, vh = innerHeight;
  const chain = el => {
    let o = 1;
    for (let e = el; e && e.id !== 'stage'; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden') return 0;
      o *= +cs.opacity;
    }
    return o;
  };
  const tick = t => {
    H.raf.push(t);
    const c = document.getElementById('barCounter');
    const txt = c ? c.textContent : '';
    if (txt !== last) { last = txt; H.counter.push([t, txt]); }
    let score = 0;
    if (!noCover) for (const el of document.querySelectorAll('#stage img, #stage video, #stage canvas')) {
      const ready = el.tagName === 'IMG' ? el.complete && el.naturalWidth > 0
        : el.tagName === 'VIDEO' ? el.readyState >= 2 : true;
      if (!ready) continue;
      const r = el.getBoundingClientRect();
      const ix = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
      const iy = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
      const frac = (ix * iy) / (vw * vh);
      if (frac > 0) score += chain(el) * Math.min(1, frac);
    }
    H.cover.push(Math.min(1, score));
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  try {
    new PerformanceObserver(l => {
      for (const e of l.getEntries()) {
        H.loaf.push([e.startTime, e.duration, e.blockingDuration || 0,
          (e.scripts || []).map(s => `${s.invoker}${s.sourceFunctionName ? ' ' + s.sourceFunctionName : ''} ${Math.round(s.duration)}ms`).join('; '),
          Math.round((e.renderStart || 0) - e.startTime), Math.round((e.styleAndLayoutStart || 0) - e.startTime)]);
      }
    }).observe({ type: 'long-animation-frame', buffered: true });
  } catch {}
};

// ---------- main ----------
const { items } = await ensureFixtures(FIXTURES);
const byId = new Map(items.map(it => [it.id, it]));

// Resident memory of the whole browser (renderer + GPU/compositor + ...), in
// MB, from /proc (Linux). With software compositing, textures live in RAM, so
// this is where a 190 MB decoded photo would show up.
function browserRssMB(rootPid) {
  try {
    const kids = new Map();
    for (const d of readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue;
      try {
        const st = readFileSync(`/proc/${d}/stat`, 'utf8');
        const ppid = +st.slice(st.lastIndexOf(')') + 2).split(' ')[1];
        if (!kids.has(ppid)) kids.set(ppid, []);
        kids.get(ppid).push(+d);
      } catch {}
    }
    let kb = 0;
    const walk = pid => {
      try { kb += +(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8')) || [0, 0])[1]; } catch {}
      for (const k of kids.get(pid) || []) walk(k);
    };
    walk(rootPid);
    return kb / 1024;
  } catch { return null; }
}

async function pass(screencast) {
  const showDir = mkdtempSync(path.join(tmpdir(), 'slideshow-show-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  writeFileSync(path.join(showDir, 'server.ts'),
    readFileSync(path.join(REPO, 'server.ts'), 'utf8').replace(/const PORT = \d+;/, `const PORT = ${port};`));
  copyFileSync(HTML, path.join(showDir, 'index.html'));
  for (const it of items) {
    for (const f of [it.id, it.live].filter(Boolean)) {
      try { linkSync(path.join(FIXTURES, f), path.join(showDir, f)); }
      catch { copyFileSync(path.join(FIXTURES, f), path.join(showDir, f)); }
    }
  }

  const server = spawn('bun', ['server.ts'], { cwd: showDir, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverLog = '';
  server.stderr.on('data', d => (serverLog += d));
  await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('server did not start:\n' + serverLog)), 180000);
    server.stdout.on('data', d => {
      serverLog += d;
      if (/Slideshow ready/.test(serverLog)) { clearTimeout(to); res(); }
    });
    server.on('exit', c => rej(new Error(`server exited ${c}:\n${serverLog}`)));
  });
  const base = `http://127.0.0.1:${port}`;
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());

  // the "missing" file disappears after the scan (an unplugged drive, a renamed file)
  for (const it of items) if (it.cat === 'bad-missing') unlinkSync(path.join(showDir, it.id));

  await post('/api/settings', { patch: {
    duration: String(DURATION), transition: TRANSITION, media: MEDIA, caption: 'age', birthday: '2004-01-15',
  } });
  // exercise per-slide overrides: fit-to-slide, trim, 2x, photo-only
  const firstOf = cat => items.find(it => it.cat === cat);
  const vids = items.filter(it => it.cat === 'video');
  const ovr = (it, patch) => it && post('/api/override', { id: it.id, patch });
  await ovr(vids[0], { speed: 'fit' });
  await ovr(vids[1], { trim: [0.5, 2.5] });
  await ovr(firstOf('videoPortrait'), { speed: '2' });
  await ovr(firstOf('live'), { media: 'photo' });

  const order = (await (await fetch(base + '/api/slides')).json()).slides.map(s => s.id);
  const stalls = new Set(items.filter(it => it.cat === 'bad-stall' || it.cat === 'bad-stallVideo').map(it => it.id));

  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({
    headless: !HEADED,
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--autoplay-policy=no-user-gesture-required', `--slideshow-harness=${port}`], // marker to find our browser pid
  });
  const rss = [];
  const bpid = (() => {
    try {
      for (const d of readdirSync('/proc')) {
        if (/^\d+$/.test(d) && readFileSync(`/proc/${d}/cmdline`, 'utf8').includes(`--slideshow-harness=${port}`) &&
            !readFileSync(`/proc/${d}/cmdline`, 'utf8').includes('--type=')) return +d;
      }
    } catch {}
    return null;
  })();
  const rssTimer = bpid ? setInterval(() => { const v = browserRssMB(bpid); if (v) rss.push(v); }, 1000) : null;
  const ctx = await browser.newContext({ viewport: { width: VW, height: VH }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.route('**/*', route => {
    const p = decodeURIComponent(new URL(route.request().url()).pathname).slice(1);
    if (stalls.has(p)) return; // never answer: a hung network share / dying disk
    return route.continue();
  });
  await page.addInitScript(INSTRUMENT, NO_COVER);
  if (INJECT_CSS) await page.addInitScript(css => {
    addEventListener('DOMContentLoaded', () => {
      const st = document.createElement('style');
      st.textContent = css;
      document.head.appendChild(st);
    });
  }, INJECT_CSS);

  const cdp = await ctx.newCDPSession(page);
  const shots = [];
  cdp.on('Page.screencastFrame', ev => {
    cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => {});
    const ts = ev.metadata.timestamp ? ev.metadata.timestamp * 1000 : Date.now();
    try { shots.push({ ts, ...pngStats(Buffer.from(ev.data, 'base64')) }); } catch {}
  });

  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));

  await page.goto(base + '/');
  if (screencast) await cdp.send('Page.startScreencast', { format: 'png', maxWidth: 320, maxHeight: 180, everyNthFrame: 1 });

  const SHOTS = screencast ? SHOTS_DIR : null; // screenshots perturb timing: screen pass only
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  const SHOT_CATS = new Set(['portrait', 'portrait916', 'pano', 'panoV', 'tiny', 'tinyPortrait', 'square', 'videoPortrait', 'live', 'landscape', 'landscape48', 'video']);
  const shotTaken = new Set();

  const t0 = Date.now();
  const interventions = [];
  let seen = 0, lastChangeWall = Date.now(), lastIdx = null, done = false;
  const STALL_MS = Math.max(15000, DURATION * 1000 + 12000);
  console.log(`${screencast ? 'screen' : 'timing'} pass: ${SLIDES} transitions, ${DURATION}s, ${TRANSITION}, media=${MEDIA}, html=${path.relative(process.cwd(), HTML)}`);

  while (!done) {
    await page.waitForTimeout(200);
    const c = await page.evaluate(() => {
      const H = window.__H;
      return H ? { n: H.counter.length, last: H.counter[H.counter.length - 1] } : null;
    });
    if (!c || !c.last) continue;
    if (c.n !== seen) {
      seen = c.n;
      lastChangeWall = Date.now();
      const m = /^(\d+)\s*\/\s*(\d+)/.exec(c.last[1]);
      if (m) {
        const i = +m[1] - 1;
        if (lastIdx != null && i < lastIdx && seen > 3) done = true; // wrapped: full lap
        lastIdx = i;
        const it = byId.get(order[i]);
        if (SHOTS && it && SHOT_CATS.has(it.cat) && !shotTaken.has(it.cat)) {
          shotTaken.add(it.cat);
          await page.waitForTimeout(Math.min(1800, DURATION * 1000 * 0.6));
          await page.screenshot({ path: path.join(SHOTS, `${it.cat}.png`) });
        }
      }
      if (seen - 1 >= SLIDES) done = true;
      if (seen % 20 === 0) process.stdout.write(`  ${seen} reveals, ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
    } else if (Date.now() - lastChangeWall > STALL_MS) {
      interventions.push({ at: lastIdx, slide: order[lastIdx + 1] ?? null });
      console.log(`  STALL after slide ${lastIdx + 1} (${order[lastIdx + 1]}): pressing ArrowRight (a human had to step in)`);
      await page.mouse.move(VW / 2, VH / 2); // keyboard needs no focus target; keep idle state
      await page.keyboard.press('ArrowRight');
      lastChangeWall = Date.now();
    }
    if (Date.now() - t0 > (SLIDES * (DURATION + 4) + 120) * 1000) { console.log('  timeout'); done = true; }
  }

  await cdp.send('Page.stopScreencast').catch(() => {});
  const H = await page.evaluate(() => window.__H);
  const wallSeconds = Math.round((Date.now() - t0) / 1000);
  clearInterval(rssTimer);
  await browser.close();
  server.kill();
  if (!KEEP) rmSync(showDir, { recursive: true, force: true });
  return { H, shots, interventions, errors, order, wallSeconds, rss };
}

const PASS = opt('pass', 'both');
const timing = PASS === 'screen' ? null : await pass(false);
const screen = PASS === 'timing' ? null : await pass(true);
const T = timing || screen, S = screen || timing;
const order = T.order, interventions = T.interventions, errors = [...T.errors, ...(timing && screen ? screen.errors : [])];

// ---------- analysis ----------
function parse(P) {
  const H = P.H;
  const counter = H.counter.map(([t, txt]) => {
    const m = /^(\d+)/.exec(txt);
    return { t, i: m ? +m[1] - 1 : -1 };
  }).filter(c => c.i >= 0);
  const startT = counter.length ? counter[0].t : 0;
  return {
    H, raf: H.raf, counter,
    reveals: counter.slice(1), // the first is the initial paint, not a transition
    shotT: P.shots.map(s => ({ ...s, t: s.ts - H.origin })),
    startT,
    openT: startT + 1200, // the opening fade-in from black on page load is not "between slides"
    endT: H.raf[H.raf.length - 1],
  };
}
const A = parse(T), B = parse(S);
const durMs = DURATION * 1000;

// --- frame timing (timing pass) ---
const inWin = new Uint8Array(A.raf.length);
const transDeltas = [], steadyDeltas = [];
const perTrans = [];
for (const rv of A.reveals) {
  const a = rv.t - 50, b = rv.t + 1250;
  const deltas = [], slowAt = [];
  for (let k = 1; k < A.raf.length; k++) if (A.raf[k] > a && A.raf[k] <= b) {
    const d = A.raf[k] - A.raf[k - 1];
    deltas.push(d); inWin[k] = 1;
    if (d > 20) slowAt.push(Math.round(A.raf[k - 1] - rv.t)); // when (vs. the reveal) the slow frame began
  }
  transDeltas.push(...deltas);
  const it = byId.get(order[rv.i]);
  perTrans.push({
    i: rv.i, id: order[rv.i], cat: it?.cat, t: r1(rv.t - A.startT),
    maxDelta: r1(deltas.length ? Math.max(...deltas) : null),
    over20: deltas.filter(d => d > 20).length, slowAt,
    blankFrames: 0, dip: null,
  });
}
for (let k = 1; k < A.raf.length; k++) if (!inWin[k] && A.raf[k] > A.startT) steadyDeltas.push(A.raf[k] - A.raf[k - 1]);

// --- what the screen showed (screen pass) ---
const isBlank = s => s.nd < 0.02;
// a dissolve whose darkest frame is under 85% of its dimmer endpoint reads as
// a dip toward black (a plain A/B mix of two equally bright slides stays ~100%)
const DIP = 0.85;
const transShotGaps = [];
for (const rv of B.reveals) {
  const win = B.shotT.filter(s => s.t >= rv.t - 200 && s.t <= rv.t + 1400);
  const pre = B.shotT.filter(s => s.t >= rv.t - 900 && s.t < rv.t - 150).map(s => s.lum);
  const post = B.shotT.filter(s => s.t > rv.t + 1300 && s.t <= rv.t + 2000).map(s => s.lum);
  const minL = win.length ? Math.min(...win.map(s => s.lum)) : null;
  const ref = pre.length && post.length ? Math.min(median(pre), median(post)) : null;
  for (let k = 1; k < win.length; k++) transShotGaps.push(win[k].t - win[k - 1].t);
  const p = perTrans.find(x => x.i === rv.i);
  const rec = p || { i: rv.i, id: order[rv.i], cat: byId.get(order[rv.i])?.cat, maxDelta: null, over20: 0 };
  rec.blankFrames = win.filter(isBlank).length;
  rec.dip = ref && minL != null ? Math.round((minL / ref) * 100) / 100 : null;
  if (!p) perTrans.push(rec);
}
const runShots = B.shotT.filter(s => s.t >= B.openT && s.t <= B.endT);
let blankMs = 0, blankN = 0;
for (let k = 0; k < runShots.length - 1; k++) if (isBlank(runShots[k])) { blankN++; blankMs += runShots[k + 1].t - runShots[k].t; }

// in-page ready coverage (timing pass)
let lowCover = 0, zeroCover = 0;
for (let k = 0; k < A.raf.length; k++) if (A.raf[k] > A.openT) { if (A.H.cover[k] < 0.5) lowCover++; if (A.H.cover[k] < 0.05) zeroCover++; }

// --- bad files: on screen at all? how long did the show lose getting past it? ---
function badInfo(P, it) {
  const bi = order.indexOf(it.id);
  const c = P.counter;
  const k = c.findIndex(x => x.i === bi);
  const prevI = (bi - 1 + order.length) % order.length;
  const before = c.find(x => x.i === prevI);
  const after = before && c.find(x => x.t > before.t && x.i !== bi && x.i !== prevI);
  const shownMs = k >= 0 ? (c[k + 1]?.t ?? P.endT) - c[k].t : 0;
  return {
    bi, shown: k >= 0, shownMs: Math.round(shownMs),
    blank: k >= 0 ? P.shotT.filter(s => s.t >= c[k].t && s.t < c[k].t + shownMs && isBlank(s)).length : 0,
    // time beyond one normal slide between the slide before it and the next good one
    // (includes any time the broken slide sat on screen)
    skipDelayMs: before && after ? Math.round(after.t - before.t - durMs) : null,
  };
}
const badReport = items.filter(it => it.bad).map(it => {
  const a = badInfo(A, it), b = badInfo(B, it);
  return {
    cat: it.cat, index: a.bi, shown: a.shown, shownMs: a.shownMs, skipDelayMs: a.skipDelayMs,
    blankFramesWhileShown: b.blank,
    humanIntervention: interventions.some(x => x.slide === it.id || x.at === a.bi),
  };
});

const byCat = {};
for (const p of perTrans) {
  const c = (byCat[p.cat] ??= { n: 0, maxDelta: 0, over20: 0, blank: 0, dips: 0 });
  c.n++; c.maxDelta = Math.max(c.maxDelta, p.maxDelta ?? 0); c.over20 += p.over20; c.blank += p.blankFrames;
  if (p.dip != null && p.dip < DIP) c.dips++;
}
const dips = perTrans.filter(p => p.dip != null);
const report = {
  config: { loadavg: os.loadavg().map(v => Math.round(v * 100) / 100), priority: PRIORITY, slides: SLIDES, duration: DURATION, transition: TRANSITION, media: MEDIA, html: HTML, viewport: `${VW}x${VH}`, passes: PASS },
  transitions: A.reveals.length,
  wallSeconds: (timing?.wallSeconds ?? 0) + (screen?.wallSeconds ?? 0),
  frames: timing ? {
    transition: { n: transDeltas.length, p50: r1(pct(transDeltas, 0.5)), p95: r1(pct(transDeltas, 0.95)), p99: r1(pct(transDeltas, 0.99)), max: r1(Math.max(...transDeltas)), over20: transDeltas.filter(d => d > 20).length, over33: transDeltas.filter(d => d > 33.4).length },
    steady: { n: steadyDeltas.length, p50: r1(pct(steadyDeltas, 0.5)), p99: r1(pct(steadyDeltas, 0.99)), max: r1(Math.max(...steadyDeltas)), over33: steadyDeltas.filter(d => d > 33.4).length },
    longAnimationFrames: A.H.loaf.filter(l => l[0] > A.startT).length,
  } : null,
  memoryMB: T.rss && T.rss.length ? { peak: Math.round(Math.max(...T.rss)), median: Math.round(median(T.rss)) } : null,
  screen: screen ? {
    screencastFrames: runShots.length,
    transitionFrameGapP99: r1(pct(transShotGaps, 0.99)),
    blankFrames: blankN,
    blankMs: Math.round(blankMs),
    blankFramesInTransitions: perTrans.reduce((s, p) => s + p.blankFrames, 0),
    transitionsWithBlank: perTrans.filter(p => p.blankFrames > 0).length,
    dipTransitions: dips.filter(p => p.dip < DIP).length,
    dipMeasured: dips.length,
    dipMedian: median(dips.map(p => p.dip)),
    dipWorst: dips.length ? Math.min(...dips.map(p => p.dip)) : null,
  } : null,
  coverage: { framesBelowHalf: lowCover, framesEmpty: zeroCover },
  interventions: interventions.length + (timing && screen ? screen.interventions.length : 0),
  bad: badReport,
  byCategory: byCat,
  longAnimationFrames: A.H.loaf.filter(l => l[0] > A.startT).map(l => {
    const near = A.reveals.reduce((b, rv) => (Math.abs(l[0] - rv.t) < Math.abs(l[0] - b.t) ? rv : b), { t: Infinity });
    return { atMs: r1(l[0] - A.startT), sinceReveal: r1(l[0] - near.t), duration: r1(l[1]), renderStart: l[4], styleStart: l[5], scripts: l[3] };
  }),
  worstTransitions: [...perTrans].sort((a, b) => (b.maxDelta ?? 0) - (a.maxDelta ?? 0)).slice(0, 8),
  pageErrors: errors.slice(0, 10),
};
if (OUT) writeFileSync(OUT, JSON.stringify({ ...report, perTransition: perTrans }, null, 1));

const f = report.frames, s = report.screen;
console.log(`\n== ${report.transitions} transitions (${TRANSITION}, ${DURATION}s, media=${MEDIA}) — ${report.wallSeconds}s, machine load ${report.config.loadavg.join(' ')} ==`);
if (f) console.log(`transition frames  n=${f.transition.n}  p50=${f.transition.p50}  p95=${f.transition.p95}  p99=${f.transition.p99}  max=${f.transition.max} ms  >20ms=${f.transition.over20}  >33ms=${f.transition.over33}
steady frames      p50=${f.steady.p50}  p99=${f.steady.p99}  max=${f.steady.max} ms  >33ms=${f.steady.over33}   long-animation-frames=${f.longAnimationFrames}`);
if (s) console.log(`screen             ${s.screencastFrames} frames  BLANK=${s.blankFrames} (${s.blankMs} ms; ${s.blankFramesInTransitions} in ${s.transitionsWithBlank} transitions)
dips               ${s.dipTransitions}/${s.dipMeasured} transitions dip <${DIP * 100}%  median=${s.dipMedian}  worst=${s.dipWorst}`);
if (report.memoryMB) console.log(`browser memory     peak ${report.memoryMB.peak} MB, median ${report.memoryMB.median} MB (RSS, all processes)`);
console.log(`coverage           frames <50% ready=${report.coverage.framesBelowHalf}  empty=${report.coverage.framesEmpty}
interventions      ${report.interventions}   page errors=${errors.length}${errors.length ? '\n  ' + errors.slice(0, 3).join('\n  ') : ''}
bad files:`);
for (const b of badReport) console.log(`  ${b.cat.padEnd(18)} shown=${b.shown ? `yes ${b.shownMs}ms blank=${b.blankFramesWhileShown}` : 'no'}  skipDelay=${b.skipDelayMs}ms${b.humanIntervention ? '  HUMAN' : ''}`);
console.log('by category (transitions INTO):');
for (const [k, v] of Object.entries(byCat).sort()) console.log(`  ${k.padEnd(18)} n=${String(v.n).padStart(3)} maxFrame=${r1(v.maxDelta)}ms >20ms=${v.over20} blank=${v.blank} dips=${v.dips}`);
process.exit(0);
