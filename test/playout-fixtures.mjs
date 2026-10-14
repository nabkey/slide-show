// Generates the slideshow test library with ffmpeg: a deterministic, mixed
// sequence of landscape / portrait / panorama / tiny / square photos, standalone
// videos, Live Photo pairs, and deliberately broken files. Nothing here is
// committed — media lands in a cache dir outside the repo (and .gitignore blocks
// media extensions anyway).
//
//   import { ensureFixtures } from './playout-fixtures.mjs';
//   const { dir, items } = await ensureFixtures(cacheDir);

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomFillSync as fill } from 'node:crypto';
import path from 'node:path';

const VERSION = 3;

// [category, count, spec]
const PLAN = [
  ['landscape', 53, i => ({ w: 4032, h: 3024 })],
  ['landscape48', 6, i => ({ w: 8000, h: 6000 })],          // 48 MP phone shots
  ['landscapeHD', 6, i => ({ w: 1920, h: 1080 })],
  ['portrait', 49, i => ({ w: 3024, h: 4032 })],
  ['portrait916', 12, i => ({ w: 1080, h: 1920 })],          // screenshots / 9:16
  ['pano', 9, i => ({ w: 9000, h: 2000 })],
  ['panoV', 2, i => ({ w: 1500, h: 6000 })],
  ['tiny', 8, i => ({ w: 160, h: 120 })],
  ['tinyPortrait', 4, i => ({ w: 90, h: 120 })],
  ['square', 10, i => ({ w: 2048, h: 2048 })],
  ['video', 10, i => ({ w: 1280, h: 720, t: 4 })],
  ['videoPortrait', 10, i => ({ w: 720, h: 1280, t: 4 })],
  ['video1080', 4, i => ({ w: 1920, h: 1080, t: 6 })],
  ['live', 6, i => ({ w: 3024, h: 4032, vw: 720, vh: 960, t: 3 })],
  ['liveLandscape', 4, i => ({ w: 4032, h: 3024, vw: 960, vh: 720, t: 3 })],
  ['bad-corrupt', 1, () => ({})],      // random bytes with a .jpg name
  ['bad-empty', 1, () => ({})],        // zero-byte .jpg
  ['bad-missing', 1, () => ({})],      // valid at scan time, deleted before the show
  ['bad-stall', 1, () => ({})],        // the harness makes the request never answer
  ['bad-h264', 1, () => ({ w: 1280, h: 720, t: 3 })], // a codec this Chromium can't decode
  ['bad-corruptVideo', 1, () => ({})], // random bytes with a .mp4 name
  ['bad-stallVideo', 1, () => ({ w: 1280, h: 720, t: 3 })],
];

// deterministic PRNG so every run builds the same order
function rng(seed) {
  return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
}

function run(args) {
  return new Promise((res, rej) => {
    const p = spawn('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => (err += d));
    p.on('exit', code => (code === 0 ? res() : rej(new Error(`ffmpeg ${args.join(' ')}\n${err}`))));
  });
}

async function pool(tasks, n) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < tasks.length) await tasks[i++]();
  }));
}

const pad = n => String(n).padStart(2, '0');
function stamp(k) {
  // one item every ~5 days starting 2004-03-01, so dates (and age captions) vary
  const d = new Date(Date.UTC(2004, 2, 1, 12, 0, 0) + k * 5 * 86400000 + k * 3600000);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}_${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

function still(file, w, h, hue) {
  // a bright test pattern (never near-black, so blank frames are unambiguous)
  // with a light noise texture so files have realistic sizes
  return run([
    '-f', 'lavfi', '-i', `testsrc2=s=${w}x${h}:r=1`,
    '-vf', `hue=h=${hue},eq=brightness=0.06:saturation=1.2`,
    '-frames:v', '1', '-q:v', '3', file,
  ]);
}

function clip(file, w, h, t, hue, codec = 'vp9') {
  const enc = codec === 'vp9'
    ? ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '2M', '-row-mt', '1']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p'];
  return run([
    '-f', 'lavfi', '-i', `testsrc2=s=${w}x${h}:r=30`, '-t', String(t),
    '-vf', `hue=h=${hue}`, ...enc, '-movflags', '+faststart', '-an', file,
  ]);
}

export async function ensureFixtures(dir) {
  const manifestPath = path.join(dir, 'manifest.json');
  if (existsSync(manifestPath)) {
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (m.version === VERSION) return { dir, items: m.items };
  }
  mkdirSync(dir, { recursive: true });

  // expand + shuffle so every kind of transition pair occurs
  const entries = [];
  for (const [cat, count, spec] of PLAN) for (let i = 0; i < count; i++) entries.push({ cat, ...spec(i) });
  const r = rng(42);
  for (let i = entries.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [entries[i], entries[j]] = [entries[j], entries[i]];
  }

  const items = [];
  const tasks = [];
  entries.forEach((e, k) => {
    const hue = (k * 47) % 360;
    const isVid = e.cat.startsWith('video') || e.cat === 'bad-h264' || e.cat === 'bad-corruptVideo' || e.cat === 'bad-stallVideo';
    const stem = (isVid ? 'VID_' : 'IMG_') + stamp(k);
    const file = stem + (isVid ? '.mp4' : '.jpg');
    const abs = path.join(dir, file);
    const item = { id: file, cat: e.cat, w: e.w, h: e.h, bad: e.cat.startsWith('bad-') };
    items.push(item);
    switch (e.cat) {
      case 'bad-corrupt': case 'bad-corruptVideo': {
        const b = Buffer.alloc(60000); fill(b);
        tasks.push(async () => writeFileSync(abs, b));
        break;
      }
      case 'bad-empty': tasks.push(async () => writeFileSync(abs, '')); break;
      case 'bad-h264': tasks.push(() => clip(abs, e.w, e.h, e.t, hue, 'h264')); break;
      case 'bad-stallVideo': tasks.push(() => clip(abs, e.w, e.h, e.t, hue)); break;
      case 'bad-missing': case 'bad-stall': tasks.push(() => still(abs, 4032, 3024, hue)); break;
      default:
        if (isVid) tasks.push(() => clip(abs, e.w, e.h, e.t, hue));
        else tasks.push(() => still(abs, e.w, e.h, hue));
        if (e.cat.startsWith('live')) {
          item.live = stem + '.mp4';
          tasks.push(() => clip(path.join(dir, item.live), e.vw, e.vh, e.t, hue));
        }
    }
  });
  const t0 = Date.now();
  await pool(tasks, 4);
  writeFileSync(manifestPath, JSON.stringify({ version: VERSION, items }, null, 1));
  console.log(`fixtures: generated ${items.length} items in ${((Date.now() - t0) / 1000).toFixed(0)}s -> ${dir}`);
  return { dir, items };
}
