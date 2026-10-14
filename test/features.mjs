#!/usr/bin/env node
// Feature checks for the stage: drives the real page (real server, generated
// media) through the controls and asserts the show still does what it did.
//
//   node test/features.mjs [--html FILE] [--fixtures DIR]
//
// Covers: auto-advance, arrows, rapid skips, pause, every transition, caption
// modes, video mode + Fit-to-slide rate, trim start, library "play from here",
// a viewport resize (as when going fullscreen), and skipping a broken file.

import { spawn } from 'node:child_process';
import { copyFileSync, linkSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureFixtures } from './playout-fixtures.mjs';
import { decodePng } from './png.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : argv[i + 1]; };
const HTML = path.resolve(opt('html', path.join(REPO, 'index.html')));
const FIXTURES = path.resolve(opt('fixtures', path.join(tmpdir(), 'slideshow-fixtures')));

const { items: all } = await ensureFixtures(FIXTURES);
const items = all.slice(0, 40); // has photos of every shape, clips, a Live Photo and a broken file

const dir = mkdtempSync(path.join(tmpdir(), 'slideshow-feat-'));
const port = 20000 + Math.floor(Math.random() * 20000);
writeFileSync(path.join(dir, 'server.ts'),
  readFileSync(path.join(REPO, 'server.ts'), 'utf8').replace(/const PORT = [^\n]*;/, `const PORT = ${port};`));
copyFileSync(HTML, path.join(dir, 'index.html'));
for (const it of items) for (const f of [it.id, it.live].filter(Boolean)) {
  try { linkSync(path.join(FIXTURES, f), path.join(dir, f)); } catch { copyFileSync(path.join(FIXTURES, f), path.join(dir, f)); }
}
// a quarter-turn phone photo: landscape pixels + EXIF Orientation 6, so it
// must show as a portrait (sorted first by its date)
const ROTATED = 'IMG_20040101_120000.jpg';
{
  const jpg = readFileSync(path.join(FIXTURES, items.find(it => it.cat === 'landscape').id));
  const tiff = Buffer.from([0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0]);
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 255]), body]);
  writeFileSync(path.join(dir, ROTATED), Buffer.concat([jpg.subarray(0, 2), app1, jpg.subarray(2)]));
}
// an animated GIF (second by date): it should keep animating on the stage
const GIF = 'IMG_20040102_120000.gif';
await new Promise((res, rej) => spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=10', '-t', '2',
  path.join(dir, GIF)], { stdio: 'ignore' }).on('exit', c => (c ? rej(new Error('ffmpeg gif')) : res())));
const server = spawn('bun', ['server.ts'], { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] });
await new Promise(res => server.stdout.on('data', d => /Slideshow ready/.test(d) && res()));
const base = `http://127.0.0.1:${port}`;
const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
await post('/api/settings', { patch: { duration: '3', transition: 'fade', media: 'photo', caption: 'date', birthday: '2004-01-15' } });
const order = (await (await fetch(base + '/api/slides')).json()).slides.map(s => s.id);
const cat = id => items.find(it => it.id === id)?.cat;
const vidIdx = order.findIndex(id => cat(id) === 'video');
await post('/api/override', { id: order[vidIdx], patch: { speed: 'fit', trim: [1, 3] } });

let pw;
for (const t of [process.env.PLAYWRIGHT_MODULE, 'playwright', '/opt/node-tools/node_modules/playwright/index.mjs'].filter(Boolean)) {
  try { pw = await import(t); break; } catch {}
}
const browser = await pw.chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.goto(base + '/');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? ' ok  ' : ' FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};
const counter = () => page.$eval('#barCounter', e => e.textContent.trim());
const idxNow = async () => parseInt(await counter(), 10) - 1;
const waitIdx = async (want, ms = 6000) => {
  const t = Date.now();
  while (Date.now() - t < ms) { if ((await idxNow()) === want) return true; await page.waitForTimeout(50); }
  return false;
};
// what is actually on screen: the top layer, its opacity, and what it holds
const stage = () => page.evaluate(() => {
  const ls = [...document.querySelectorAll('#stage .layer')];
  const top = ls.sort((a, b) => (+getComputedStyle(b).zIndex || 0) - (+getComputedStyle(a).zIndex || 0))[0];
  const c = top.querySelector('canvas'), v = top.querySelector('video'), im = top.querySelector('img');
  return {
    opacity: +getComputedStyle(top).opacity,
    canvas: c ? { w: c.width, h: c.height } : null,
    video: v ? { t: v.currentTime, rate: v.playbackRate, paused: v.paused, vis: getComputedStyle(v).visibility, ready: v.readyState } : null,
    img: im ? { ok: im.complete && im.naturalWidth > 0 } : null,
    caption: document.getElementById('caption').textContent,
    captionShown: document.getElementById('caption').classList.contains('show'),
  };
});
// the chrome hides when the mouse holds still: move it first, like a person would
const wake = async () => { await page.mouse.move(640 + Math.random() * 20, 300); await page.waitForTimeout(450); };
const openPanel = async () => { if (!(await page.$eval('#panel', p => p.classList.contains('open')))) { await wake(); await page.click('#gear'); } };
const closePanel = async () => { if (await page.$eval('#panel', p => p.classList.contains('open'))) { await wake(); await page.click('#gear'); } };

check('first slide appears', await waitIdx(0));
await page.waitForTimeout(1200);
let st = await stage();
check('first slide is a painted canvas', st.opacity === 1 && st.canvas && st.canvas.w > 0, JSON.stringify(st.canvas));
{
  // the photo is the bright band over its darkened fill: measure its width
  const { w, h, lum } = decodePng(await page.screenshot());
  let bright = 0;
  for (let x = 0; x < w; x++) {
    let m = 0;
    for (let y = h * 0.3 | 0; y < h * 0.7; y++) m += lum[y * w + x];
    if (m / (h * 0.4) > 75) bright++;
  }
  check('EXIF-rotated photo shows upright (portrait)', order[0] === ROTATED && bright > 450 && bright < 650, `photo ${bright}px wide`);
}
check('date caption', /^[A-Z][a-z]+ \d{4}$/.test(st.caption) && st.captionShown, st.caption);

check('auto-advances', await waitIdx(1, 5000));
await page.waitForTimeout(1200);
st = await stage();
{
  const a = decodePng(await page.screenshot({ clip: { x: 400, y: 200, width: 480, height: 320 } }));
  await page.waitForTimeout(350);
  const b = decodePng(await page.screenshot({ clip: { x: 400, y: 200, width: 480, height: 320 } }));
  let d = 0;
  for (let i = 0; i < a.lum.length; i++) d += Math.abs(a.lum[i] - b.lum[i]);
  check('animated GIF is a live, decoded <img> and keeps animating', order[1] === GIF && st.img && st.img.ok && d / a.lum.length > 2,
    `mean frame change ${(d / a.lum.length).toFixed(1)}`);
}
await page.keyboard.press('ArrowRight');
check('→ goes forward', await waitIdx(2, 2000));
await page.keyboard.press('ArrowLeft');
check('← goes back', await waitIdx(1, 2000));

for (let k = 0; k < 5; k++) { await page.keyboard.press('ArrowRight'); await page.waitForTimeout(60); }
check('rapid skips compound (5 × →)', await waitIdx(6, 4000), await counter());
await page.waitForTimeout(1500);
st = await stage();
check('after rapid skips the picture is whole', st.opacity === 1 && !!(st.canvas || st.video));
const layersWithContent = await page.$$eval('#stage .layer', ls => ls.filter(l => l.children.length).length);
check('retired layer was released', layersWithContent === 1, `${layersWithContent} layers hold content`);

await page.keyboard.press(' ');
const pausedAt = await idxNow();
await page.waitForTimeout(4200);
check('space pauses', (await idxNow()) === pausedAt && await page.$eval('#pauseBadge', b => b.classList.contains('show')));
await page.keyboard.press(' ');
check('space resumes', await waitIdx(pausedAt + 1, 5000));

for (const tr of ['slide', 'kenburns', 'none', 'fade']) {
  await openPanel();
  await page.click(`#segTr button[data-v="${tr}"]`);
  await closePanel(); // (the click that closes the panel doesn't advance)
  const before = await idxNow();
  await page.keyboard.press('ArrowRight');
  const ok = await waitIdx(before + 1, 4000);
  await page.waitForTimeout(1300);
  st = await stage();
  check(`transition ${tr}`, ok && st.opacity === 1 && !!(st.canvas || st.video));
}

await openPanel();
await page.click('#segCap button[data-v="age"]');
await page.waitForTimeout(1000);
st = await stage();
check('age caption', /old|born/.test(st.caption), st.caption);
await page.click('#segCap button[data-v="off"]');
await page.waitForTimeout(700);
st = await stage();
check('caption off', !st.captionShown);
await page.click('#segCap button[data-v="date"]');

// video mode: jump to the clip with the Fit + trim override
await page.click('#segMedia button[data-v="video"]');
await closePanel();
await page.keyboard.press('l');
// the library grid is virtualized: narrow it to videos so the clip's card is mounted
await page.click('#libFilters [data-f="videos"]');
await page.hover(`.libCard[data-id="${order[vidIdx]}"]`);
await page.click(`.libCard[data-id="${order[vidIdx]}"] .libPlay`);
check('library play-from-here', await waitIdx(vidIdx, 4000), await counter());
await page.waitForTimeout(400);
st = await stage();
check('clip is cued, hidden behind its still during the dissolve', st.video && st.video.paused && st.video.vis === 'hidden' && st.canvas, JSON.stringify(st.video));
await page.waitForTimeout(1200);
st = await stage();
check('clip rolls after the dissolve', st.video && !st.video.paused && st.video.vis === 'visible', JSON.stringify(st.video));
check('Fit to slide rate = trimmed length / duration', st.video && Math.abs(st.video.rate - 2 / 3) < 0.01, `rate ${st.video && st.video.rate}`);
check('clip starts at its trim start', st.video && st.video.t >= 0.95 && st.video.t < 3.05, `t=${st.video && st.video.t.toFixed(2)}`);

// a broken file in the middle: the show passes it without showing it
// (the server already drops files that are broken at scan time, so break one
// after the scan: the stage has to cope with it on its own)
const badIdx = order.findIndex((id, i) => i > vidIdx + 2 && i < order.length - 2 && /\.jpe?g$/i.test(id));
unlinkSync(path.join(dir, order[badIdx])); // it may be a hard link into the shared fixtures
writeFileSync(path.join(dir, order[badIdx]), 'this is not a jpeg');
await page.keyboard.press('l');
await page.click('#libFilters [data-f="all"]');
await page.evaluate(id => document.querySelector(`.libCard[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'center' }), order[badIdx - 1]);
await page.hover(`.libCard[data-id="${order[badIdx - 1]}"]`);
await page.click(`.libCard[data-id="${order[badIdx - 1]}"] .libPlay`);
await waitIdx(badIdx - 1, 4000);
const t0 = Date.now();
const passed = await waitIdx(badIdx + 1, 9000);
check('broken file is skipped', passed, `${cat(order[badIdx])} at ${badIdx + 1}`);
check('…within a normal slot (+3 s)', Date.now() - t0 < 3000 + 3000, `${Date.now() - t0} ms`);

// going fullscreen = a resize: later slides are composed for the new size
await page.setViewportSize({ width: 1600, height: 900 });
await page.waitForTimeout(500);
const b4 = await idxNow();
await page.keyboard.press('ArrowRight');
await waitIdx(b4 + 1, 4000);
await page.waitForTimeout(1200);
st = await stage();
check('resize: next slide composed at the new size', st.canvas && Math.abs(st.canvas.w / st.canvas.h - 16 / 9) < 0.02 && st.canvas.w >= 1600, JSON.stringify(st.canvas));

check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
server.kill();
rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
