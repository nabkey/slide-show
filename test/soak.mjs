// Accelerated "six-hour show" soak test.
//
//   node test/soak.mjs [--transitions 3100] [--scale 2] [--src <dir with server.ts+index.html>]
//                      [--every 30] [--out result.json] [--label name]
//
// Six hours at the default 7 s per slide is ~3,100 transitions. This boots the
// real server on a temp folder of generated media, runs the real page at the
// minimum slide duration (3 s) with the clock sped up `--scale`x, rotates the
// transition style and photo/video mode, and samples (after a forced GC) the
// JS heap, DOM node count, listeners, live/detached <video>/<img> elements,
// pending timers and object URLs. It exits non-zero if memory trends upward,
// any uncaught error happens, or anything visibly breaks on screen.

import fs from 'node:fs';
import { launchBrowser, startServer, openShow, sample, slope, post, sleep } from './harness.mjs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const TARGET = +arg('transitions', 3100);
const SCALE = +arg('scale', 2);
const EVERY = +arg('every', 30) * 1000;
const SRC = arg('src', undefined);
const LABEL = arg('label', SRC ? 'baseline' : 'current');
const OUT = arg('out', null);

const server = await startServer({ srcDir: SRC });
console.log(`[${LABEL}] server ${server.url} root=${server.root}`);
await post(server.url, '/api/settings', { patch: { duration: 3, transition: 'fade', media: 'video', caption: 'date' } });
// a few per-slide overrides so trim/speed/media paths run too
await post(server.url, '/api/override', { id: 'IMG_20200702_100000.jpg', patch: { media: 'photo' } });
await post(server.url, '/api/override', { id: 'IMG_20200704_100000.jpg', patch: { speed: 'fit' } });
await post(server.url, '/api/override', { id: 'VID_20210802_090000.mp4', patch: { trim: [0.5, 2.0], speed: '2' } });

const browser = await launchBrowser();
const show = await openShow(browser, server.url, { timeScale: SCALE });
const phases = [['fade', 'video'], ['slide', 'video'], ['kenburns', 'video'], ['none', 'video'], ['fade', 'photo']];
const PHASE_LEN = 400;
let phase = -1;

const samples = [];
const t0 = Date.now();
let lastSample = 0;
let stalledSince = null;
while (true) {
  const p = await show.probe();
  const want = Math.floor(p.transitions / PHASE_LEN) % phases.length;
  if (want !== phase) {
    phase = want;
    const [tr, media] = phases[phase];
    await show.page.evaluate(([tr, media]) => {
      document.querySelector(`#segTr [data-v="${tr}"]`).click();
      document.querySelector(`#segMedia [data-v="${media}"]`).click();
    }, [tr, media]);
  }
  if (Date.now() - lastSample >= EVERY || p.transitions >= TARGET) {
    lastSample = Date.now();
    const s = { t: Math.round((Date.now() - t0) / 1000), ...(await sample(show)) };
    samples.push(s);
    console.log(`[${LABEL}] t=${s.t}s tr=${s.transitions} heap=${s.heapMB}MB rss=${s.rendererRssMB}MB nodes=${s.nodes} listeners=${s.listeners} ` +
      `video=${s.videos}(${s.videosDetached} detached) img=${s.images}(${s.imagesDetached} detached) ` +
      `intervals=${s.intervals} timeouts=${s.timeouts} urls=${s.objectURLs} fail=${s.failures} err=${s.errors + show.pageErrors.length}`);
    if (p.transitions >= TARGET) break;
  }
  if (!server.alive()) {
    console.log(`[${LABEL}] SERVER DIED: ${JSON.stringify(server.unexpectedExits)}\n${server.log.join('').slice(-2000)}`);
    break;
  }
  // a frozen show is itself a failure: give up after 60 s without a transition
  if (Date.now() - (p.lastTransitionAt || t0) > 60000) {
    stalledSince = p.lastTransitionAt;
    console.log(`[${LABEL}] STALLED: no transition for 60 s at ${p.transitions}`);
    break;
  }
  await sleep(500);
}

const final = await show.probe();
const warm = Math.max(3, Math.floor(samples.length * 0.1));
const post_ = samples.slice(warm);
const xs = post_.map(s => s.transitions / 1000);
const third = Math.max(1, Math.floor(post_.length / 3));
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const firstThird = post_.slice(0, third), lastThird = post_.slice(-third);
const summary = {
  label: LABEL, transitions: final.transitions, wallSeconds: Math.round((Date.now() - t0) / 1000),
  simulatedHours: +((final.transitions * 7) / 3600).toFixed(2), stalled: stalledSince != null,
  heapMB: {
    afterWarmup: post_[0]?.heapMB, end: samples.at(-1).heapMB,
    min: Math.min(...post_.map(s => s.heapMB)), max: Math.max(...post_.map(s => s.heapMB)),
    firstThirdMean: +mean(firstThird.map(s => s.heapMB)).toFixed(2), lastThirdMean: +mean(lastThird.map(s => s.heapMB)).toFixed(2),
    slopePer1000Transitions: +slope(xs, post_.map(s => s.heapMB)).toFixed(3),
  },
  rendererRssMB: {
    afterWarmup: post_[0]?.rendererRssMB, end: samples.at(-1).rendererRssMB,
    firstThirdMean: +mean(firstThird.map(s => s.rendererRssMB)).toFixed(1), lastThirdMean: +mean(lastThird.map(s => s.rendererRssMB)).toFixed(1),
    slopePer1000Transitions: +slope(xs, post_.map(s => s.rendererRssMB)).toFixed(2),
  },
  // a <video> brings ~150 shadow-DOM nodes, so compare the peak of each third
  nodes: {
    afterWarmup: post_[0]?.nodes, end: samples.at(-1).nodes, max: Math.max(...post_.map(s => s.nodes)),
    firstThirdMax: Math.max(...firstThird.map(s => s.nodes)), lastThirdMax: Math.max(...lastThird.map(s => s.nodes)),
    slopePer1000Transitions: +slope(xs, post_.map(s => s.nodes)).toFixed(2),
  },
  listeners: { afterWarmup: post_[0]?.listeners, end: samples.at(-1).listeners, max: Math.max(...post_.map(s => s.listeners)) },
  videoElementsMax: Math.max(...samples.map(s => s.videos)), videosDetachedMax: Math.max(...samples.map(s => s.videosDetached)),
  imageElementsMax: Math.max(...samples.map(s => s.images)),
  intervalsMax: Math.max(...samples.map(s => s.intervals)), timeoutsMax: Math.max(...samples.map(s => s.timeouts)),
  objectURLsEnd: samples.at(-1).objectURLs,
  uncaughtErrors: [...new Set([...final.errors, ...show.pageErrors])],
  visibleFailures: final.failureCount, failureExamples: final.failures.slice(0, 10),
};
// verdicts
const heapGrowth = (summary.heapMB.lastThirdMean - summary.heapMB.firstThirdMean) / summary.heapMB.firstThirdMean;
summary.verdict = {
  heapFlat: heapGrowth < 0.10 && summary.heapMB.slopePer1000Transitions < 0.5,
  nodesFlat: summary.nodes.slopePer1000Transitions < 20 && summary.nodes.lastThirdMax <= summary.nodes.firstThirdMax + 50,
  rssFlat: (summary.rendererRssMB.lastThirdMean - summary.rendererRssMB.firstThirdMean) / summary.rendererRssMB.firstThirdMean < 0.15,
  noUncaughtErrors: summary.uncaughtErrors.length === 0,
  noVisibleFailures: summary.visibleFailures === 0,
  reachedTarget: final.transitions >= TARGET,
  serverStayedUp: server.unexpectedExits.length === 0,
};
summary.pass = Object.values(summary.verdict).every(Boolean);
console.log(JSON.stringify(summary, null, 2));
if (OUT) fs.writeFileSync(OUT, JSON.stringify({ summary, samples, console: show.consoleLog.slice(-100), serverLog: server.log.join('').slice(-4000) }, null, 2));
await show.close();
await browser.close();
await server.cleanup();
process.exit(summary.pass ? 0 : 1);
