// Fixture generator for the library benchmark. Produces ~3,000 small JPEGs (plus a
// few videos) with ffmpeg, including deliberate near-duplicate bursts, exact
// re-saves, and the kinds of bad dates a real family archive has. Dates are
// planted through filenames (IMG_YYYYMMDD_HHMMSS) and file mtimes, which is what
// the server falls back to when exiftool isn't installed.
//
// Nothing here is committed media: output goes to a temp folder (default
// $TMPDIR/slideshow-library-bench) and .gitignore blocks image/video files anyway.
//
//   node test/fixtures.mjs [dir] [--regen]

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FIXTURE_VERSION = 3;
export const TARGET = 3000;

// deterministic PRNG so every run builds the same library
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
const stamp = d =>
  `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}_${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
const iso = d =>
  `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => { err += d; });
    p.on('close', code => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')}\n${err}`))));
  });
}

async function pool(tasks, n = os.cpus().length) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < tasks.length) await tasks[i++]();
  }));
}

// Smooth, colourful, frame-number-dependent patterns + a big frame label, so
// distinct frames hash differently and screenshots are readable.
const GEQ =
  "lum='128+70*sin(X*(0.01+0.06*abs(sin(N*12.9898)))+N*1.7)*cos(Y*(0.01+0.06*abs(sin(N*78.233)))+N*2.3)" +
  "+45*sin((X*abs(sin(N*3.1))+Y)*(0.005+0.04*abs(sin(N*37.719)))+N*0.37)'" +
  ":cb='128+70*sin(N*0.91+X*0.012*abs(sin(N*5.3)))':cr='128+70*cos(N*1.37+Y*0.015*abs(sin(N*7.7)))'";

export async function ensureFixtures(dir = path.join(os.tmpdir(), 'slideshow-library-bench'), { regen = false } = {}) {
  const manifestPath = path.join(dir, 'manifest.json');
  if (!regen && existsSync(manifestPath)) {
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (m.version === FIXTURE_VERSION) return m;
  }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const baseDir = path.join(dir, '.base'); // dot-dir: the server skips it
  mkdirSync(baseDir, { recursive: true });

  const r = rng(1994);
  const items = []; // { name, date, kind, group?, best?, flag? }
  const usedMonths = new Set(['2012-07']); // July 2012 is reserved for the PXL run
  const randDate = (y0, y1) => {
    for (;;) {
      const t = Date.UTC(y0, 0, 1) + r() * (Date.UTC(y1, 0, 1) - Date.UTC(y0, 0, 1));
      const d = new Date(Math.floor(t / 1000) * 1000);
      if (!usedMonths.has(iso(d).slice(0, 7))) return d;
    }
  };
  const names = new Set();
  const uniq = name => {
    let n = name, k = 2;
    while (names.has(n)) n = name.replace(/(\.\w+)$/, `-${k++}$1`);
    names.add(n);
    return n;
  };

  let baseNo = 0;
  const plan = []; // { name, base, mtime?, variant? }
  const addPhoto = (name, { mtime = null, date, kind, ...rest }) => {
    name = uniq(name);
    const base = ++baseNo;
    plan.push({ name, base, mtime });
    items.push({ name, date, kind, base, ...rest });
    return name;
  };

  // --- deliberate problems -------------------------------------------------
  // 1) a scanned-prints batch: 40 files that all share the scanner's timestamp
  const scanTime = new Date(Date.UTC(2024, 2, 5, 10, 0, 0));
  for (let i = 1; i <= 40; i++) addPhoto(`scan_${pad(i, 4)}.jpg`, { mtime: scanTime, date: iso(scanTime), kind: 'scan', flag: 'shared' });
  // 2) camera-default dates (reset clock): 2000-01-01 and the unix epoch
  const y2k = new Date(Date.UTC(2000, 0, 1, 0, 0, 0));
  for (let i = 1; i <= 12; i++) addPhoto(`photo_${pad(i, 4)}.jpg`, { mtime: y2k, date: iso(y2k), kind: 'default', flag: 'default' });
  const epoch = new Date(0);
  for (let i = 1; i <= 3; i++) addPhoto(`image${i}.jpg`, { mtime: epoch, date: iso(epoch), kind: 'default', flag: 'default' });
  // 3) future dates (clock set wrong)
  for (let i = 0; i < 5; i++) {
    const d = new Date(Date.UTC(2029 + (i % 3), i, 10 + i, 12, 0, i));
    addPhoto(`IMG_${stamp(d)}.jpg`, { date: iso(d), kind: 'future', flag: 'future' });
  }
  // 4) a numbered camera roll with four frames whose dates jump out of sequence
  const dscStart = Date.UTC(2009, 4, 1, 9, 0, 0);
  const dscOutliers = new Set([30, 61, 90, 110]);
  for (let i = 1; i <= 120; i++) {
    let d = new Date(dscStart + i * 3 * 3600 * 1000);
    let flag;
    if (dscOutliers.has(i)) { d = new Date(Date.UTC(2016, 8, 3 + (i % 20), 15, 30, 0)); flag = 'sequence'; }
    addPhoto(`DSC_${pad(i, 4)}.jpg`, { mtime: d, date: iso(d), kind: 'dsc', flag });
  }
  // 5) a run shot on a phone whose year was wrong — the harness bulk-shifts it +1y.
  //    It is the only thing in July 2012, so "select this month" grabs exactly it.
  for (let i = 0; i < 60; i++) {
    const d = new Date(Date.UTC(2012, 6, 4, 10, 0, 0) + i * 97 * 1000);
    addPhoto(`PXL_${stamp(d)}.jpg`, { date: iso(d), kind: 'pxl' });
  }
  // 6) old prints, dated by mtime, 1985–1999 (legit)
  for (let i = 0; i < 150; i++) {
    const d = randDate(1985, 2000);
    addPhoto(`old_${d.getUTCFullYear()}_${pad(i, 4)}.jpg`, { mtime: d, date: iso(d), kind: 'old' });
  }

  // --- near-duplicate bursts: 50 bursts of 3–8 frames ------------------------
  const bursts = [];
  for (let b = 0; b < 50; b++) {
    const size = 3 + Math.floor(r() * 6);
    const t0 = randDate(2003, 2026);
    const base = ++baseNo;
    const members = [];
    for (let k = 0; k < size; k++) {
      const d = new Date(t0.getTime() + k * 1000);
      const name = uniq(`IMG_${stamp(d)}.jpg`);
      plan.push({ name, base, variant: k });
      items.push({ name, date: iso(d), kind: 'burst', base, group: `b${b}`, best: k === 0 });
      members.push(name);
    }
    bursts.push({ id: `b${b}`, members, best: members[0] });
  }

  // --- video items: 4 standalone clips + 2 live-photo pairs ------------------
  const videos = [];
  for (let i = 0; i < 4; i++) {
    const d = randDate(2014, 2020);
    const name = uniq(`VID_${stamp(d)}.mp4`);
    videos.push({ name, solo: true });
    items.push({ name, date: iso(d), kind: 'video' });
  }
  for (let i = 0; i < 2; i++) {
    const d = randDate(2017, 2020);
    const name = addPhoto(`IMG_${stamp(d)}.jpg`, { date: iso(d), kind: 'live' });
    videos.push({ name: name.replace(/\.jpg$/, '.mp4'), solo: false });
  }

  // --- exact re-saves of 10 ordinary photos, with a different (later) date ---
  const resaveCount = 10;
  // --- the ordinary bulk: fill up to TARGET ----------------------------------
  const normalCount = TARGET - items.length - resaveCount;
  const normals = [];
  for (let i = 0; i < normalCount; i++) {
    const d = randDate(2001, 2026);
    normals.push(addPhoto(`IMG_${stamp(d)}.jpg`, { date: iso(d), kind: 'normal' }));
  }
  const resaves = [];
  for (let i = 0; i < resaveCount; i++) {
    const src = items.find(it => it.name === normals[i * 37]);
    const d = new Date(Date.UTC(2021, 1, 1 + i, 20, 0, 0));
    const name = uniq(`copy_${pad(i + 1, 4)}.jpg`);
    plan.push({ name, base: src.base, mtime: d, resave: true });
    items.push({ name, date: iso(d), kind: 'resave', base: src.base, group: `r${i}` });
    src.group = `r${i}`;
    bursts.push({ id: `r${i}`, members: [src.name, name], best: null });
  }

  // --- render ----------------------------------------------------------------
  console.log(`fixtures: rendering ${baseNo} base frames…`);
  const t0 = Date.now();
  const perJob = Math.ceil(baseNo / os.cpus().length);
  const jobs = [];
  for (let start = 0; start < baseNo; start += perJob) {
    const count = Math.min(perJob, baseNo - start);
    jobs.push(() => run('ffmpeg', [
      '-v', 'error', '-y', '-f', 'lavfi',
      '-i', `nullsrc=s=320x240:r=25,format=yuv444p,geq=${GEQ.replaceAll('N', `(N+${start})`)},` +
            `drawtext=text='%{eif\\:n+${start + 1}\\:d}':x=12:y=h-th-12:fontsize=34:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=6,format=yuvj420p`,
      '-frames:v', String(count), '-q:v', '4', '-start_number', String(start + 1),
      path.join(baseDir, 'b_%05d.jpg'),
    ]));
  }
  await pool(jobs);
  console.log(`fixtures: base frames in ${((Date.now() - t0) / 1000).toFixed(1)}s; writing ${plan.length} photos…`);

  const baseFile = n => path.join(baseDir, `b_${pad(n, 5)}.jpg`);
  const tasks = plan.map(p => async () => {
    const out = path.join(dir, p.name);
    if (p.variant) {
      // burst neighbour: slight reframing, exposure drift and camera-shake blur
      const k = p.variant;
      const c = 1 - 0.015 * k;
      const blur = (0.6 + 0.35 * k).toFixed(2);
      const vf = `crop=iw*${c}:ih*${c}:iw*${(0.006 * k).toFixed(3)}:ih*${(0.004 * k).toFixed(3)},scale=320:240,eq=brightness=${(0.012 * (k % 3) - 0.01).toFixed(3)},gblur=sigma=${blur}`;
      await run('ffmpeg', ['-v', 'error', '-y', '-i', baseFile(p.base), '-vf', vf, '-q:v', '4', out]);
    } else if (p.resave) {
      await run('ffmpeg', ['-v', 'error', '-y', '-i', baseFile(p.base), '-vf', 'scale=300:225', '-q:v', '9', out]);
    } else {
      await run('cp', [baseFile(p.base), out]);
    }
    if (p.mtime) utimesSync(out, p.mtime, p.mtime);
  });
  for (const v of videos) {
    tasks.push(() => run('ffmpeg', [
      '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=320x240:d=2:r=15',
      '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', path.join(dir, v.name),
    ]));
  }
  await pool(tasks);
  rmSync(baseDir, { recursive: true, force: true });

  const manifest = { version: FIXTURE_VERSION, dir, count: items.length, items, groups: bursts };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
  const media = readdirSync(dir).filter(n => /\.(jpg|mp4)$/.test(n)).length;
  console.log(`fixtures: ${items.length} items (${media} files) in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${dir}`);
  return manifest;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv.slice(2).find(a => !a.startsWith('--'));
  await ensureFixtures(dir, { regen: process.argv.includes('--regen') });
}
