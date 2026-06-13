// Offline slideshow server — Bun + bun:sqlite, no dependencies.
//
//   bun server.ts [--open]
//
// Scans this folder (and uploads/) for photos, converts HEICs to JPEG copies
// in _converted/ via sips, reads EXIF dates via exiftool (cached in
// slideshow.db), and serves the slideshow UI plus a small JSON API:
//
//   GET  /api/slides                  -> { slides, overrides, settings }
//   POST /api/settings                -> { patch: {media?, duration?, transition?, caption?, birthday?, accent?, bg?, captionColor?, captionFont?} }
//   POST /api/override                -> { id, patch: {hidden?, date?, media?, trim?} }
//   POST /api/upload?name=<filename>  -> raw file body; saved to uploads/
//   POST /api/remove-upload           -> { id }; moved to uploads/_removed/
//   POST /api/rescan                  -> re-scan the folder

import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';

const ROOT = import.meta.dir;
const PORT = 8765;
const UPLOADS = path.join(ROOT, 'uploads');
const CONVERTED = path.join(ROOT, '_converted');
const IMG_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const HEIC_EXT = new Set(['.heic', '.heif']);
const VID_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm']);
const MAX_UPLOAD = 2 * 1024 * 1024 * 1024;

type Slide = { id: string; img: string; vid: string | null; d: string; solo?: boolean };
type Patch = {
  hidden?: boolean | null; date?: string | null; media?: string | null;
  trim?: [number, number] | null; poster?: number | null; speed?: string | null;
};

const db = new Database(path.join(ROOT, 'slideshow.db'));
db.run(`CREATE TABLE IF NOT EXISTS exif_cache (
  path TEXT PRIMARY KEY,
  sig  TEXT NOT NULL,
  d    TEXT NOT NULL
)`);
db.run(`CREATE TABLE IF NOT EXISTS overrides (
  id         TEXT PRIMARY KEY,
  hidden     INTEGER NOT NULL DEFAULT 0,
  date       TEXT,
  media      TEXT,
  trim_start REAL,
  trim_end   REAL
)`);
try { db.run('ALTER TABLE overrides ADD COLUMN poster REAL'); } catch {}
try { db.run('ALTER TABLE overrides ADD COLUMN speed TEXT'); } catch {}

// Global show settings: key/value, travels with slideshow.db. These define the
// show itself (playback defaults, the birthday used for "age" captions) and are
// shared across any browser pointed at this server — unlike per-device prefs.
db.run(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
const SETTING_DEFAULTS: Record<string, string> = {
  media: 'photo', duration: '7', transition: 'fade', caption: 'date', birthday: '',
  // appearance
  accent: '#d9b98a', bg: '#0e0c0a', captionColor: '#ece5d8', captionFont: 'Baskerville',
};

let slides: Slide[] = [];

// ---------- scanning ----------

const fmt = (t: Date) =>
  `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')} ` +
  `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`;

const fileSig = (p: string) => {
  const st = statSync(p);
  return `${st.size}-${Math.floor(st.mtimeMs)}`;
};

function collect(dir: string, prefix: string, stills: Array<[string, string]>, mp4s: Map<string, string>) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith('.')) continue;
    const p = path.join(dir, name);
    if (!statSync(p).isFile()) continue;
    const ext = path.extname(name).toLowerCase();
    const rel = prefix + name;
    if (IMG_EXT.has(ext) || HEIC_EXT.has(ext)) stills.push([rel, p]);
    else if (ext === '.mp4') mp4s.set(rel.slice(0, -4).toLowerCase(), rel);
  }
}

// Timestamp embedded in the filename: FB_IMG_<unix ts>, or the
// VID_/IMG_/PXL_-style YYYYMMDD[_-]HHMMSS used by Android/Pixel cameras.
// Filename timestamps are local time, so they beat QuickTime dates (UTC).
function filenameDate(name: string): string | null {
  const fb = /^FB_IMG_(\d{10})/.exec(name);
  if (fb) return fmt(new Date(Number(fb[1]) * 1000));
  const m = /(20\d{2})(\d{2})(\d{2})[_-]?(\d{2})(\d{2})(\d{2})/.exec(name);
  if (m) {
    const [, y, mo, da, h, mi, s] = m;
    if (+mo >= 1 && +mo <= 12 && +da >= 1 && +da <= 31 && +h < 24 && +mi < 60 && +s < 60) {
      return `${y}-${mo}-${da} ${h}:${mi}:${s}`;
    }
  }
  return null;
}

// Batch-read dates for files not in the cache. Priority:
// EXIF DateTimeOriginal -> filename timestamp -> CreateDate -> file mtime.
async function exifDates(paths: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < paths.length; i += 400) {
    const chunk = paths.slice(i, i + 400);
    try {
      const proc = Bun.spawn(
        ['exiftool', '-json', '-DateTimeOriginal', '-CreateDate', '-FileModifyDate',
         '-d', '%Y-%m-%d %H:%M:%S', ...chunk],
        { stdout: 'pipe', stderr: 'ignore' },
      );
      const text = await new Response(proc.stdout).text();
      await proc.exited;
      const ok = (v: unknown) => v && !String(v).startsWith('0000');
      for (const e of JSON.parse(text || '[]')) {
        const d =
          (ok(e.DateTimeOriginal) && String(e.DateTimeOriginal).slice(0, 19)) ||
          filenameDate(path.basename(e.SourceFile)) ||
          (ok(e.CreateDate) && String(e.CreateDate).slice(0, 19)) ||
          String(e.FileModifyDate ?? '').slice(0, 19) ||
          fmt(new Date(statSync(e.SourceFile).mtimeMs));
        out.set(path.resolve(e.SourceFile), d);
      }
    } catch {
      for (const p of chunk) {
        out.set(path.resolve(p), filenameDate(path.basename(p)) ?? fmt(new Date(statSync(p).mtimeMs)));
      }
    }
  }
  return out;
}

async function convertHeic(src: string, dst: string) {
  if (existsSync(dst)) return;
  const proc = Bun.spawn(
    ['sips', '-s', 'format', 'jpeg', '-s', 'formatOptions', '85', src, '--out', dst],
    { stdout: 'ignore', stderr: 'ignore' },
  );
  await proc.exited;
}

// ---------- video helpers (standalone clips) ----------

async function ffprobe(args: string[]): Promise<string> {
  try {
    const proc = Bun.spawn(['ffprobe', '-v', 'quiet', ...args], { stdout: 'pipe', stderr: 'ignore' });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out.trim();
  } catch {
    return '';
  }
}

const probeDuration = async (p: string) =>
  parseFloat(await ffprobe(['-show_entries', 'format=duration', '-of', 'csv=p=0', p])) || 0;

const probeVideoCodec = (p: string) =>
  ffprobe(['-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', p]);

function posterFor(vidRel: string) {
  const stem = vidRel.slice(0, -path.extname(vidRel).length);
  const safe = 'poster__' + stem.replaceAll('/', '__') + '.jpg';
  return { rel: `_converted/${safe}`, abs: path.join(CONVERTED, safe) };
}

async function extractPoster(vidAbs: string, dstAbs: string, time: number): Promise<boolean> {
  const proc = Bun.spawn(
    ['ffmpeg', '-y', '-ss', String(Math.max(0, time)), '-i', vidAbs, '-frames:v', '1', '-q:v', '3', dstAbs],
    { stdout: 'ignore', stderr: 'ignore' },
  );
  return (await proc.exited) === 0 && existsSync(dstAbs);
}

async function scan(): Promise<Slide[]> {
  mkdirSync(CONVERTED, { recursive: true });
  const stills: Array<[string, string]> = [];
  const mp4s = new Map<string, string>();
  collect(ROOT, '', stills, mp4s);
  collect(UPLOADS, 'uploads/', stills, mp4s);

  // MP4s with no same-name still are standalone video slides
  const stillBases = new Set(stills.map(([rel]) => rel.slice(0, -path.extname(rel).length).toLowerCase()));
  const solos: Array<[string, string]> = [];
  for (const [base, rel] of mp4s) {
    if (!stillBases.has(base)) solos.push([rel, path.join(ROOT, rel)]);
  }
  const items = [...stills, ...solos];

  const getCached = db.query('SELECT sig, d FROM exif_cache WHERE path = ?');
  const upsert = db.query(
    `INSERT INTO exif_cache (path, sig, d) VALUES (?1, ?2, ?3)
     ON CONFLICT(path) DO UPDATE SET sig = ?2, d = ?3`,
  );

  const sigs = new Map<string, string>();
  const stale: string[] = [];
  for (const [rel, p] of items) {
    const sig = fileSig(p);
    sigs.set(rel, sig);
    const row = getCached.get(rel) as { sig: string; d: string } | null;
    if (!row || row.sig !== sig) stale.push(p);
  }
  const fresh = await exifDates(stale);

  const dateOf = (rel: string, p: string) => {
    const abs = path.resolve(p);
    if (fresh.has(abs)) {
      const d = fresh.get(abs)!;
      upsert.run(rel, sigs.get(rel)!, d);
      return d;
    }
    return (getCached.get(rel) as { d: string }).d;
  };

  const result: Slide[] = [];
  for (const [rel, p] of stills) {
    const ext = path.extname(rel).toLowerCase();
    let img = rel;
    if (HEIC_EXT.has(ext)) {
      const safe = rel.slice(0, -ext.length).replaceAll('/', '__');
      await convertHeic(p, path.join(CONVERTED, safe + '.jpg'));
      img = `_converted/${safe}.jpg`;
    }
    result.push({
      id: rel, img,
      vid: mp4s.get(rel.slice(0, -ext.length).toLowerCase()) ?? null,
      d: dateOf(rel, p),
    });
  }

  for (const [rel, p] of solos) {
    const poster = posterFor(rel);
    if (!existsSync(poster.abs)) {
      const row = db.query('SELECT poster FROM overrides WHERE id = ?').get(rel) as { poster: number | null } | null;
      let t = row?.poster;
      if (t == null) t = Math.round(((await probeDuration(p)) / 2) * 10) / 10; // default: middle frame
      await extractPoster(p, poster.abs, t);
    }
    result.push({ id: rel, img: poster.rel, vid: rel, d: dateOf(rel, p), solo: true });
  }

  // prune cache rows for files that no longer exist
  const live = new Set(items.map(([rel]) => rel));
  for (const r of db.query('SELECT path FROM exif_cache').all() as Array<{ path: string }>) {
    if (!live.has(r.path)) db.run('DELETE FROM exif_cache WHERE path = ?', [r.path]);
  }

  result.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : a.id < b.id ? -1 : 1));
  return result;
}

// ---------- global settings ----------

function allSettings(): Record<string, string> {
  const out = { ...SETTING_DEFAULTS };
  for (const r of db.query('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>) {
    out[r.key] = r.value;
  }
  return out;
}

function applySettings(patch: Record<string, unknown>) {
  const upsert = db.query(
    `INSERT INTO settings (key, value) VALUES (?1, ?2)
     ON CONFLICT(key) DO UPDATE SET value = ?2`,
  );
  for (const [k, v] of Object.entries(patch)) {
    if (k in SETTING_DEFAULTS) upsert.run(k, v == null ? '' : String(v));
  }
}

// ---------- overrides ----------

function allOverrides() {
  const out: Record<string, object> = {};
  for (const r of db.query('SELECT * FROM overrides').all() as any[]) {
    const o: any = {};
    if (r.hidden) o.hidden = true;
    if (r.date) o.date = r.date;
    if (r.media) o.media = r.media;
    if (r.trim_start != null && r.trim_end != null) o.trim = [r.trim_start, r.trim_end];
    if (r.poster != null) o.poster = r.poster;
    if (r.speed != null) o.speed = r.speed;
    if (Object.keys(o).length) out[r.id] = o;
  }
  return out;
}

function applyPatch(id: string, patch: Patch) {
  const cur = (db.query('SELECT * FROM overrides WHERE id = ?').get(id) as any) ?? {};
  const hidden = 'hidden' in patch ? (patch.hidden ? 1 : 0) : (cur.hidden ?? 0);
  const date = 'date' in patch ? (patch.date || null) : (cur.date ?? null);
  const media = 'media' in patch ? (patch.media || null) : (cur.media ?? null);
  const ts = 'trim' in patch ? (patch.trim?.[0] ?? null) : (cur.trim_start ?? null);
  const te = 'trim' in patch ? (patch.trim?.[1] ?? null) : (cur.trim_end ?? null);
  const poster = 'poster' in patch ? (patch.poster ?? null) : (cur.poster ?? null);
  const speed = 'speed' in patch ? (patch.speed || null) : (cur.speed ?? null);

  if (!hidden && date == null && media == null && ts == null && poster == null && speed == null) {
    db.run('DELETE FROM overrides WHERE id = ?', [id]);
  } else {
    db.run(
      `INSERT INTO overrides (id, hidden, date, media, trim_start, trim_end, poster, speed) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT(id) DO UPDATE SET hidden = ?2, date = ?3, media = ?4, trim_start = ?5, trim_end = ?6, poster = ?7, speed = ?8`,
      [id, hidden, date, media, ts, te, poster, speed],
    );
  }
}

// ---------- http ----------

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

async function serveStatic(urlPath: string, req: Request): Promise<Response> {
  const full = path.normalize(path.join(ROOT, urlPath));
  if (!full.startsWith(ROOT + path.sep)) return new Response('Forbidden', { status: 403 });
  if (/\.(db|db-wal|db-shm|ts)$/.test(full)) return new Response('Forbidden', { status: 403 });
  const file = Bun.file(full);
  if (!(await file.exists())) return new Response('Not found', { status: 404 });

  const range = req.headers.get('range');
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      const size = file.size;
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1;
      if (start <= end && start < size) {
        return new Response(file.slice(start, end + 1), {
          status: 206,
          headers: {
            'Content-Range': `bytes ${start}-${end}/${size}`,
            'Accept-Ranges': 'bytes',
            'Content-Type': file.type,
          },
        });
      }
    }
  }
  return new Response(file, { headers: { 'Accept-Ranges': 'bytes' } });
}

function freeDest(stem: string, ext: string): string {
  let dest = path.join(UPLOADS, stem + ext);
  for (let n = 2; existsSync(dest); n++) dest = path.join(UPLOADS, `${stem}-${n}${ext}`);
  return dest;
}

async function handleUpload(req: Request, url: URL): Promise<Response> {
  const raw = url.searchParams.get('name') ?? 'upload.jpg';
  const name = path.basename(raw).replace(/[^\w .()\[\]-]+/g, '_');
  const ext = path.extname(name).toLowerCase();
  const isVideo = VID_EXT.has(ext);
  if (!IMG_EXT.has(ext) && !HEIC_EXT.has(ext) && !isVideo) {
    return json({ ok: false, error: `Unsupported type "${ext}" — use JPG, PNG, GIF, WebP, HEIC, MP4, or MOV.` }, 415);
  }
  const len = Number(req.headers.get('content-length') ?? 0);
  if (len > MAX_UPLOAD) return json({ ok: false, error: 'File too large.' }, 413);

  mkdirSync(UPLOADS, { recursive: true });
  const stem = name.slice(0, -ext.length);
  let dest: string;

  if (isVideo) {
    // land the raw bytes, then keep as-is only if it's already browser-friendly
    // (H.264 in MP4); everything else is transcoded via ffmpeg
    const tmp = path.join(UPLOADS, `.incoming-${Date.now()}${ext}`);
    await Bun.write(tmp, await req.arrayBuffer());
    const codec = await probeVideoCodec(tmp);
    if (!codec) {
      unlinkSync(tmp);
      return json({ ok: false, error: 'Not a readable video file.' }, 415);
    }
    if (ext === '.mp4' && codec === 'h264') {
      dest = freeDest(stem, '.mp4');
      renameSync(tmp, dest);
    } else {
      dest = freeDest(stem, '.mp4');
      const proc = Bun.spawn(
        ['ffmpeg', '-y', '-i', tmp, '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
         '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', dest],
        { stdout: 'ignore', stderr: 'ignore' },
      );
      const code = await proc.exited;
      unlinkSync(tmp);
      if (code !== 0) {
        if (existsSync(dest)) unlinkSync(dest);
        return json({ ok: false, error: `Couldn't convert ${name} (codec: ${codec}).` }, 415);
      }
    }
  } else {
    dest = freeDest(stem, ext);
    await Bun.write(dest, await req.arrayBuffer());
  }

  slides = await scan();
  const id = `uploads/${path.basename(dest)}`;
  return json({ ok: true, slide: slides.find(s => s.id === id) ?? null });
}

function removeUpload(id: string): Response {
  if (!/^uploads\/[^/]+$/.test(id)) return json({ ok: false, error: 'Only uploaded files can be removed.' }, 400);
  const src = path.join(UPLOADS, path.basename(id));
  if (!existsSync(src)) return json({ ok: false, error: 'File not found.' }, 404);
  const trash = path.join(UPLOADS, '_removed');
  mkdirSync(trash, { recursive: true });
  renameSync(src, path.join(trash, path.basename(id)));
  db.run('DELETE FROM overrides WHERE id = ?', [id]);
  const poster = posterFor(id);
  if (existsSync(poster.abs)) unlinkSync(poster.abs);
  return json({ ok: true });
}

// ---------- main ----------

slides = await scan();

let server;
try {
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: PORT,
    maxRequestBodySize: MAX_UPLOAD, // Bun's default is 128 MB — too small for phone videos
    idleTimeout: 120,
    async fetch(req) {
      const url = new URL(req.url);
      const p = decodeURIComponent(url.pathname);

      if (req.method === 'GET') {
        if (p === '/' || p === '/index.html') return new Response(Bun.file(path.join(ROOT, 'index.html')));
        if (p === '/api/slides') return json({ slides, overrides: allOverrides(), settings: allSettings() });
        if (p === '/api/thumb') {
          const slide = slides.find(s => s.id === url.searchParams.get('id'));
          if (!slide) return new Response('Not found', { status: 404 });
          const srcAbs = path.join(ROOT, slide.img);
          if (!existsSync(srcAbs)) return new Response('Not found', { status: 404 });
          const thumbsDir = path.join(CONVERTED, '_thumbs');
          mkdirSync(thumbsDir, { recursive: true });
          const thumbAbs = path.join(thumbsDir, 'thumb__' + slide.img.replaceAll('/', '__'));
          const stale = !existsSync(thumbAbs) || statSync(thumbAbs).mtimeMs < statSync(srcAbs).mtimeMs;
          if (stale) {
            const proc = Bun.spawn(['sips', '-Z', '400', srcAbs, '--out', thumbAbs], { stdout: 'ignore', stderr: 'ignore' });
            if ((await proc.exited) !== 0 || !existsSync(thumbAbs)) return serveStatic('/' + slide.img, req);
          }
          return new Response(Bun.file(thumbAbs), { headers: { 'Cache-Control': 'no-cache' } });
        }
        return serveStatic(p, req);
      }
      if (req.method === 'POST') {
        if (p === '/api/upload') {
          const name = url.searchParams.get('name') ?? '?';
          const mb = (Number(req.headers.get('content-length') ?? 0) / 1048576).toFixed(1);
          console.log(`upload: ${name} (${mb} MB)`);
          try {
            return await handleUpload(req, url);
          } catch (err) {
            console.error('upload failed:', err);
            return json({ ok: false, error: String(err) }, 500);
          }
        }
        if (p === '/api/settings') {
          const { patch } = await req.json();
          applySettings(patch ?? {});
          return json({ ok: true, settings: allSettings() });
        }
        if (p === '/api/override') {
          const { id, patch } = await req.json();
          applyPatch(id, patch ?? {});
          return json({ ok: true });
        }
        if (p === '/api/poster') {
          const { id, time } = await req.json();
          const slide = slides.find(s => s.id === id);
          if (!slide?.solo || !slide.vid) return json({ ok: false, error: 'Not a standalone video slide.' }, 400);
          const poster = posterFor(slide.vid);
          const okExtract = await extractPoster(path.join(ROOT, slide.vid), poster.abs, Number(time) || 0);
          if (!okExtract) return json({ ok: false, error: 'Frame extraction failed.' }, 500);
          applyPatch(id, { poster: Math.round((Number(time) || 0) * 100) / 100 });
          return json({ ok: true });
        }
        if (p === '/api/remove-upload') {
          const { id } = await req.json();
          const res = removeUpload(id);
          if (res.status === 200) slides = await scan();
          return res;
        }
        if (p === '/api/rescan') {
          slides = await scan();
          return json({ ok: true, count: slides.length });
        }
      }
      return new Response('Not found', { status: 404 });
    },
  });
} catch (err: any) {
  if (err?.code === 'EADDRINUSE') {
    console.log(`Already running at http://127.0.0.1:${PORT}`);
    if (process.argv.includes('--open')) Bun.spawn(['open', `http://127.0.0.1:${PORT}`]);
    process.exit(0);
  }
  throw err;
}

const paired = slides.filter(s => s.vid).length;
console.log(`Slideshow ready: http://127.0.0.1:${PORT} — ${slides.length} slides (${paired} with Live Photo video)`);
if (process.argv.includes('--open')) Bun.spawn(['open', `http://127.0.0.1:${PORT}`]);
