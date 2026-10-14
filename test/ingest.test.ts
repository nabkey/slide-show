// The outside judge for the ingest pipeline. Generates media with known
// capture dates, boots the real server on a temp folder, and checks what the
// HTTP API says against ground truth — dates, ordering, pairing, skips — plus
// warm-restart timing on a 3,000-file library.
//
//   bun test            (needs ffmpeg; uses exiftool / heif-enc when present)

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { cpSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TEST_TZ, generateFixtures, generateLibrary, tools, type Fixture } from './fixtures';

process.env.TZ = TEST_TZ; // bun test defaults to UTC; fixtures are written in this zone

const SERVER = path.join(import.meta.dir, '..', 'server.ts');
const TMP = mkdtempSync(path.join(os.tmpdir(), 'slideshow-test-'));
let nextPort = 18765 + Math.floor(Math.random() * 1000);

type Booted = { proc: ReturnType<typeof Bun.spawn>; port: number; ms: number; log: () => string; base: string };

async function boot(dir: string, env: Record<string, string> = {}): Promise<Booted> {
  const port = nextPort++;
  const t0 = performance.now();
  const proc = Bun.spawn(['bun', SERVER, '--dir', dir, '--port', String(port)], {
    env: { ...process.env, TZ: TEST_TZ, ...env }, stdout: 'pipe', stderr: 'pipe',
  });
  let out = '';
  const drain = async (s: ReadableStream<Uint8Array>) => { for await (const c of s) out += new TextDecoder().decode(c); };
  drain(proc.stdout as ReadableStream<Uint8Array>); drain(proc.stderr as ReadableStream<Uint8Array>);
  const base = `http://127.0.0.1:${port}`;
  for (;;) {
    try {
      const r = await fetch(`${base}/api/slides`);
      if (r.ok) { await r.arrayBuffer(); break; }
    } catch {}
    if (proc.exitCode != null) throw new Error(`server exited (${proc.exitCode}):\n${out}`);
    if (performance.now() - t0 > 300_000) throw new Error(`server did not come up:\n${out}`);
    await Bun.sleep(2);
  }
  return { proc, port, ms: performance.now() - t0, log: () => out, base };
}
async function stop(b: Booted) { b.proc.kill(); await b.proc.exited; }
const getJSON = async (b: Booted, p: string) => (await fetch(b.base + p)).json() as Promise<any>;
async function idle(b: Booted) {
  for (let i = 0; i < 6000; i++) {
    const s = await getJSON(b, '/api/ingest');
    if (s.pending === 0) return s;
    await Bun.sleep(50);
  }
  throw new Error('background conversions never finished');
}
const urlOf = (rel: string) => '/' + rel.split('/').map(encodeURIComponent).join('/');

// Compare at the precision the ground truth carries.
function check(f: Fixture, s: any): string | null {
  if (!s) return 'missing from slides';
  const got: string = s.d;
  const want = f.expect!;
  const g = want.length === 16 ? got.slice(0, 16) : want.length === 10 ? got.slice(0, 10) : got.slice(0, 4);
  if (g !== want) return `got ${got} (${s.dateSource}, ${s.dateConfidence}), want ${want}`;
  if (f.conf && !f.conf.includes(s.dateConfidence)) return `confidence ${s.dateConfidence} (${s.dateSource}), want ${f.conf.join('|')}`;
  return null;
}

afterAll(() => rmSync(TMP, { recursive: true, force: true }));

describe('ground-truth fixtures (primary path)', () => {
  const dir = path.join(TMP, 'fixtures');
  let fixtures: Fixture[] = [];
  let srv: Booted;
  let data: any;
  const slideOf = (id: string) => data.slides.find((s: any) => s.id === id);

  beforeAll(async () => {
    fixtures = generateFixtures(dir);
    srv = await boot(dir);
    await idle(srv);
    data = await getJSON(srv, '/api/slides');
  }, 300_000);
  afterAll(async () => { if (srv) await stop(srv); });

  test('generator prerequisites', () => {
    console.log(`tools: ${JSON.stringify(tools)} — ${fixtures.length} fixtures`);
    expect(tools.ffmpeg).toBe(true);
  });

  test('every dated fixture resolves to its ground-truth date', () => {
    // Without exiftool (not the primary target) HEIC/XMP dates can't be read off macOS.
    if (!tools.exiftool) console.log('exiftool missing: HEIC/XMP-only fixtures are not date-checked');
    const dated = fixtures.filter(f => f.expect && (tools.exiftool || !f.exiftoolOnly));
    const rows = dated.map(f => ({ f, err: check(f, slideOf(f.file)) }));
    for (const { f, err } of rows) {
      const s = slideOf(f.file);
      console.log(`${err ? 'FAIL' : ' ok '}  ${(s?.d ?? '-').padEnd(19)} ${(s?.dateConfidence ?? '').padEnd(6)} ${f.file}  [${f.category}]${err ? '  <- ' + err : ''}`);
    }
    const ok = rows.filter(r => !r.err).length;
    console.log(`${ok}/${dated.length} fixtures correct`);
    expect(rows.filter(r => r.err).map(r => `${r.f.file}: ${r.err}`)).toEqual([]);
  });

  test('broken files are skipped with a reason (and nothing crashed)', () => {
    for (const f of fixtures.filter(f => f.skip)) {
      const sk = data.skipped.find((s: any) => s.id === f.file);
      expect(sk ? `${f.file}: ${sk.reason}` : `${f.file}: NOT SKIPPED`).toMatch(f.skip!);
      expect(slideOf(f.file)).toBeUndefined();
    }
    console.log(data.skipped.map((s: any) => `  skipped ${s.id}: ${s.reason}`).join('\n'));
    // nothing else gets skipped, and every slide/skip is accounted for by a fixture
    expect(data.skipped.map((s: any) => s.id).sort()).toEqual(fixtures.filter(f => f.skip).map(f => f.file).sort());
    for (const f of fixtures.filter(f => f.absent)) {
      expect(slideOf(f.file)).toBeUndefined();
      expect(data.skipped.some((s: any) => s.id === f.file)).toBe(false);
    }
    expect(srv.proc.exitCode).toBeNull();
  });

  test('Live Photos are paired; companions are not separate slides; clips are solo', () => {
    for (const f of fixtures) {
      if (f.pairedWith) expect(slideOf(f.file)?.vid).toBe(f.pairedWith);
      if (f.companion) expect(slideOf(f.file)).toBeUndefined();
      if (f.solo) expect(slideOf(f.file)?.solo).toBe(true);
    }
  });

  test('slides come back in chronological order', () => {
    const ds = data.slides.map((s: any) => s.d);
    expect(ds).toEqual([...ds].sort());
    // and the ground truth agrees with that order wherever it is minute-precise
    const timed = fixtures.filter(f => f.expect?.length === 16 && (tools.exiftool || !f.exiftoolOnly)).sort((a, b) => (a.expect! < b.expect! ? -1 : 1));
    const idx = timed.map(f => data.slides.findIndex((s: any) => s.id === f.file));
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
  });

  test('every slide image is served (converted HEIC, awkward filenames)', async () => {
    for (const s of data.slides) {
      const r = await fetch(srv.base + urlOf(s.img));
      expect(`${s.img} ${r.status}`).toBe(`${s.img} 200`);
      const head = new Uint8Array(await r.arrayBuffer()).subarray(0, 4);
      const isImg = (head[0] === 0xff && head[1] === 0xd8) || (head[0] === 0x89 && head[1] === 0x50);
      expect(`${s.img} image=${isImg}`).toBe(`${s.img} image=true`);
    }
    for (const f of fixtures.filter(f => f.converted)) expect(slideOf(f.file)?.img).toStartWith('_converted/');
    const thumb = await fetch(`${srv.base}/api/thumb?id=${encodeURIComponent('Grand-mère\'s "80th" party 🎂 #1.jpg')}`);
    expect(thumb.status).toBe(200);
  });

  test('API is backwards compatible (old fields intact, new ones additive)', () => {
    for (const s of data.slides) {
      expect(typeof s.id).toBe('string');
      expect(typeof s.img).toBe('string');
      expect(s.d).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
      expect(['high', 'medium', 'low']).toContain(s.dateConfidence);
      expect(typeof s.dateSource).toBe('string');
    }
    expect(data.overrides).toBeDefined();
    expect(data.settings.duration).toBe('7');
  });

  test('uploaded HEVC video keeps its capture date through transcoding', async () => {
    const src = path.join(TMP, 'IMG_0500.MOV');
    const r = Bun.spawnSync(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=1',
      '-c:v', 'libx265', '-tag:v', 'hvc1', '-pix_fmt', 'yuv420p',
      '-metadata', 'creation_time=2016-06-06T11:06:06Z', '-metadata', 'com.apple.quicktime.creationdate=2016-06-06T06:06:06-0500',
      '-movflags', 'use_metadata_tags', '-f', 'mov', src]);
    if (r.exitCode !== 0) { console.log('libx265 unavailable — skipping upload transcode check'); return; }
    const res = await fetch(`${srv.base}/api/upload?name=IMG_0500.MOV`, { method: 'POST', body: readFileSync(src) });
    const j = await res.json() as any;
    expect(j.ok).toBe(true);
    expect(j.slide.id).toBe('uploads/IMG_0500.mp4');
    expect(j.slide.d.slice(0, 16)).toBe('2016-06-06 06:06');
    const bad = await fetch(`${srv.base}/api/upload?name=${encodeURIComponent('oops "1".jpg')}`, { method: 'POST', body: 'not a jpeg' });
    expect(bad.status).toBe(415);
    expect(((await bad.json()) as any).error).toMatch(/too small to be media/);
    const after = await getJSON(srv, '/api/slides');
    expect(after.skipped.some((s: any) => s.id.startsWith('uploads/oops'))).toBe(false);
    expect(srv.proc.exitCode).toBeNull();
  }, 120_000);
});

describe('fallbacks when tools are missing', () => {
  let fixtures: Fixture[] = [];
  const dir = path.join(TMP, 'fallback');
  beforeAll(() => { fixtures = generateFixtures(dir); }, 300_000);

  test('without exiftool: built-in EXIF reader + ffprobe + filenames stay correct', async () => {
    const srv = await boot(dir, { SLIDESHOW_DISABLE_TOOLS: 'exiftool' });
    try {
      await idle(srv);
      const data = await getJSON(srv, '/api/slides');
      expect(srv.log()).toContain('exiftool not found');
      const errs = fixtures.filter(f => f.expect && !f.exiftoolOnly)
        .map(f => [f.file, check(f, data.slides.find((s: any) => s.id === f.file))])
        .filter(([, e]) => e);
      expect(errs).toEqual([]);
      for (const f of fixtures.filter(f => f.skip)) expect(data.skipped.some((s: any) => s.id === f.file)).toBe(true);
    } finally { await stop(srv); }
  }, 300_000);

  test('with no external tools at all: boots, explains, never crashes', async () => {
    rmSync(path.join(dir, 'slideshow.db'), { force: true });
    rmSync(path.join(dir, '_converted'), { recursive: true, force: true });
    const srv = await boot(dir, { SLIDESHOW_DISABLE_TOOLS: 'exiftool,ffmpeg,ffprobe,heif-convert,sips' });
    try {
      const data = await getJSON(srv, '/api/slides');
      const log = srv.log();
      expect(log).toContain('exiftool not found');
      expect(log).toContain('No HEIC converter');
      expect(log).toContain('ffmpeg/ffprobe not found');
      expect(data.slides.length).toBeGreaterThan(30);
      expect(data.skipped.find((s: any) => s.id === 'gopro/GX010042.MP4')?.reason).toMatch(/ffmpeg/);
      expect(data.ingest.spawns).toBe(0);
      const r = await fetch(`${srv.base}/api/rescan`, { method: 'POST' });
      expect(r.status).toBe(200);
      expect(srv.proc.exitCode).toBeNull();
    } finally { await stop(srv); }
  }, 120_000);
});

describe('existing slideshow.db migrates cleanly', () => {
  test('old schema rows are re-read, overrides and settings survive', async () => {
    const dir = path.join(TMP, 'migrate');
    const fixtures = generateFixtures(dir).filter(f => f.expect && !f.exiftoolOnly);
    // a v1 database, exactly as the previous server.ts created it
    const db = new Database(path.join(dir, 'slideshow.db'));
    db.run('CREATE TABLE exif_cache (path TEXT PRIMARY KEY, sig TEXT NOT NULL, d TEXT NOT NULL)');
    db.run('CREATE TABLE overrides (id TEXT PRIMARY KEY, hidden INTEGER NOT NULL DEFAULT 0, date TEXT, media TEXT, trim_start REAL, trim_end REAL)');
    db.run('ALTER TABLE overrides ADD COLUMN poster REAL');
    db.run('ALTER TABLE overrides ADD COLUMN speed TEXT');
    db.run('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
    db.run(`INSERT INTO exif_cache VALUES ('android/MOV_0042.mp4', 'stale', '2020-01-01 03:15:00')`);
    db.run(`INSERT INTO overrides (id, hidden, date) VALUES ('party.jpg', 1, '2015-06-06 10:00:00')`);
    db.run(`INSERT INTO settings VALUES ('duration', '11')`);
    db.close();
    const srv = await boot(dir);
    try {
      const data = await getJSON(srv, '/api/slides');
      expect(data.overrides['party.jpg']).toEqual({ hidden: true, date: '2015-06-06 10:00:00' });
      expect(data.settings.duration).toBe('11');
      expect(data.slides.find((s: any) => s.id === 'android/MOV_0042.mp4').d).toBe('2019-12-31 22:15:00');
      const errs = fixtures.map(f => [f.file, check(f, data.slides.find((s: any) => s.id === f.file))]).filter(([, e]) => e);
      expect(errs).toEqual([]);
    } finally { await stop(srv); }
  }, 300_000);
});

describe('3,000-file library', () => {
  const dir = path.join(TMP, 'library');
  let lib: ReturnType<typeof generateLibrary>;
  beforeAll(() => { lib = generateLibrary(dir); }, 300_000);

  test('cold scan, then warm restart under 300 ms with no per-file spawns', async () => {
    const t0 = performance.now();
    const cold = await boot(dir);
    const s0 = await getJSON(cold, '/api/ingest');
    const done = await idle(cold);
    const coldTotal = performance.now() - t0;
    const coldData = await getJSON(cold, '/api/slides');
    await stop(cold);
    console.log(`cold: first /api/slides after ${cold.ms.toFixed(0)} ms (scan ${s0.scanMs} ms, ${s0.probed} files read, ${s0.spawns} processes); `
      + `all background conversions done after ${coldTotal.toFixed(0)} ms (${done.done} jobs, ${done.spawns} processes total)`);
    expect(coldData.slides.length).toBe(lib.total - lib.nPairs);
    expect(coldData.skipped).toEqual([]);

    const runs: number[] = [];
    for (let i = 0; i < 3; i++) {
      const warm = await boot(dir);
      const st = await getJSON(warm, '/api/ingest');
      const data = await getJSON(warm, '/api/slides');
      await stop(warm);
      runs.push(warm.ms);
      console.log(`warm #${i + 1}: first /api/slides after ${warm.ms.toFixed(0)} ms (scan ${st.scanMs} ms, ${st.probed} files read, ${st.spawns} processes, ${st.pending} pending)`);
      expect(st.spawns).toBe(0);
      expect(st.probed).toBe(0);
      expect(st.pending).toBe(0);
      expect(data.slides.length).toBe(lib.total - lib.nPairs);
    }
    expect(Math.min(...runs)).toBeLessThan(300);
    expect(runs.sort((a, b) => a - b)[1]).toBeLessThan(300); // median
  }, 600_000);
});
