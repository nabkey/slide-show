// Offline slideshow server — Bun + bun:sqlite, no dependencies.
//
//   bun server.ts [--open] [--dir <media folder>] [--port <n>]
//
// Scans the media folder (default: this folder, including sub-folders and
// uploads/) for photos and videos, works out when each one was taken, converts
// HEICs to JPEG copies in _converted/ (sips, or heif-convert off macOS), makes
// poster frames for standalone videos (ffmpeg), and serves the slideshow UI
// plus a small JSON API:
//
//   GET  /api/slides                  -> { slides, overrides, settings, skipped, ingest }
//   GET  /api/ingest                  -> background-work status (pending conversions, timings)
//   POST /api/settings                -> { patch: {media?, duration?, transition?, caption?, birthday?, accent?, bg?, captionColor?, captionFont?} }
//   POST /api/override                -> { id, patch: {hidden?, date?, media?, trim?} }
//   POST /api/upload?name=<filename>  -> raw file body; saved to uploads/
//   POST /api/remove-upload           -> { id }; moved to uploads/_removed/
//   POST /api/rescan                  -> re-scan the folder
//
// Every slide carries `d` (local wall-clock "YYYY-MM-DD HH:MM:SS" at the place
// the photo was taken) plus `dateSource` (which piece of evidence won) and
// `dateConfidence` ("high" | "medium" | "low") so the UI can flag dates the host
// should double-check. Metadata is read once per file and cached in
// slideshow.db, keyed by size+mtime, so warm restarts spawn no processes.

import { Database } from 'bun:sqlite';
import {
  closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, renameSync, statSync, unlinkSync,
  type Stats,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------- config ----------

const APP_DIR = import.meta.dir;
const argOf = (flag: string) => {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const ROOT = path.resolve(argOf('--dir') ?? process.env.SLIDESHOW_DIR ?? APP_DIR);
const PORT = Number(argOf('--port') ?? process.env.SLIDESHOW_PORT ?? 8765);
const UPLOADS = path.join(ROOT, 'uploads');
const CONVERTED = path.join(ROOT, '_converted');
const IMG_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif']);
const HEIC_EXT = new Set(['.heic', '.heif']);
const VID_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm']);
// Recognised but not shown; listed in `skipped` so the host knows why.
const UNSUPPORTED_EXT: Record<string, string> = {
  '.tif': 'TIFF', '.tiff': 'TIFF', '.bmp': 'BMP', '.avi': 'AVI', '.mts': 'AVCHD (.mts)', '.m2ts': 'AVCHD (.m2ts)',
  '.3gp': '3GP', '.mkv': 'MKV', '.wmv': 'WMV', '.mpg': 'MPEG', '.mpeg': 'MPEG',
};
const MAX_UPLOAD = 2 * 1024 * 1024 * 1024;
const CORES = Math.max(1, navigator.hardwareConcurrency || os.cpus().length || 2);
// Bump when the metadata we extract changes; older cache rows get re-read once.
const META_VER = 2;
// A Live Photo clip is ~3 s. A same-named video much longer than this is its own clip.
const LIVE_MAX_SECONDS = 15;

type Conf = 'high' | 'medium' | 'low';
type Slide = {
  id: string; img: string; vid: string | null; d: string; solo?: boolean;
  dateSource: string; dateConfidence: Conf;
};
type Skip = { id: string; reason: string };
type Patch = {
  hidden?: boolean | null; date?: string | null; media?: string | null;
  trim?: [number, number] | null; poster?: number | null; speed?: string | null;
};

// ---------- external tools ----------
// Looked up once. SLIDESHOW_DISABLE_TOOLS=exiftool,sips lets tests exercise the
// fallbacks. A missing tool degrades with one log line; it never crashes.

const disabledTools = new Set((process.env.SLIDESHOW_DISABLE_TOOLS ?? '').split(',').map(s => s.trim()).filter(Boolean));
const findTool = (name: string) => (disabledTools.has(name) ? null : Bun.which(name));
const TOOLS = {
  exiftool: findTool('exiftool'),
  sips: findTool('sips'),
  heifConvert: findTool('heif-convert'),
  ffmpeg: findTool('ffmpeg'),
  ffprobe: findTool('ffprobe'),
};
const HEIC_CONVERTER = TOOLS.sips ? 'sips' : TOOLS.heifConvert ? 'heif-convert' : null;

function logMissingTools() {
  if (!TOOLS.exiftool) {
    console.log('exiftool not found: dates come from the built-in JPEG EXIF reader, ffprobe (videos), '
      + `${TOOLS.sips ? 'sips (HEIC), ' : ''}filenames and file times. Install it for best results: brew install exiftool`);
  }
  if (!HEIC_CONVERTER) {
    console.log('No HEIC converter found (sips / heif-convert): HEIC photos are served as-is and only display in Safari.');
  }
  if (!TOOLS.ffmpeg || !TOOLS.ffprobe) {
    console.log('ffmpeg/ffprobe not found: standalone videos are skipped (no poster frame) and uploaded videos '
      + 'cannot be transcoded. Install it: brew install ffmpeg');
  }
}

let spawnCount = 0;
async function run(cmd: string[], opts: { stdout?: boolean; timeoutMs?: number } = {}): Promise<{ code: number; out: string }> {
  spawnCount++;
  try {
    const proc = Bun.spawn(cmd, { stdin: 'ignore', stdout: opts.stdout ? 'pipe' : 'ignore', stderr: 'ignore' });
    const timer = opts.timeoutMs ? setTimeout(() => proc.kill(), opts.timeoutMs) : null;
    const out = opts.stdout ? await new Response(proc.stdout as ReadableStream).text() : '';
    const code = await proc.exited;
    if (timer) clearTimeout(timer);
    return { code, out };
  } catch {
    return { code: -1, out: '' }; // e.g. the binary vanished
  }
}

// Run fn over items with at most `n` in flight.
async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

// Simple semaphore for on-demand work (thumbnails) so a library grid of
// thousands of images can't fork thousands of processes at once.
function limiter(n: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= n) await new Promise<void>(r => waiting.push(r));
    active++;
    try { return await fn(); } finally { active--; waiting.shift()?.(); }
  };
}
const thumbLimit = limiter(CORES);

// ---------- database ----------

const db = new Database(path.join(ROOT, 'slideshow.db'));
try { db.run('PRAGMA journal_mode = WAL'); db.run('PRAGMA synchronous = NORMAL'); } catch {}
db.run(`CREATE TABLE IF NOT EXISTS exif_cache (
  path TEXT PRIMARY KEY,
  sig  TEXT NOT NULL,
  d    TEXT NOT NULL
)`);
// v2 columns: rows written by older versions have ver = NULL and are re-read once.
try { db.run('ALTER TABLE exif_cache ADD COLUMN ver INTEGER'); } catch {}
try { db.run('ALTER TABLE exif_cache ADD COLUMN meta TEXT'); } catch {}
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
let skipped: Skip[] = [];
let lastScan = { ms: 0, files: 0, probed: 0 };

// ---------- date primitives ----------
// A "wall" time is local clock time as a sortable string: "YYYY-MM-DD HH:MM:SS".

const pad = (n: number) => String(n).padStart(2, '0');
const fmtLocal = (t: Date) =>
  `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;
const fmtUTC = (t: Date) =>
  `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}`;
// Wall string -> ms as if it were UTC; only for differences and shifting.
const wallMs = (w: string) =>
  Date.UTC(+w.slice(0, 4), +w.slice(5, 7) - 1, +w.slice(8, 10), +w.slice(11, 13), +w.slice(14, 16), +w.slice(17, 19));
// A UTC instant (as a wall string) -> local wall time: at the given UTC offset
// when known (e.g. the photo's OffsetTimeOriginal), else this machine's zone.
const utcToLocal = (w: string, offMin?: number | null) =>
  offMin != null ? fmtUTC(new Date(wallMs(w) + offMin * 60_000)) : fmtLocal(new Date(wallMs(w)));

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MAX_YEAR = new Date().getFullYear() + 1;

function validYMD(y: number, mo: number, d: number) {
  return y >= 1826 && y <= MAX_YEAR && mo >= 1 && mo <= 12 && d >= 1 && d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
}
const validHMS = (h: number, mi: number, s: number) => h < 24 && mi < 60 && s < 61;

function parseOffset(v: unknown): number | null {
  const m = /^([+-])(\d{2}):?(\d{2})?$/.exec(String(v ?? '').trim());
  if (!m) return null;
  const mins = (+m[2] * 60 + +(m[3] ?? 0)) * (m[1] === '-' ? -1 : 1);
  return Math.abs(mins) <= 14 * 60 ? mins : null;
}

type DT = { w: string; off?: number; z?: boolean; dateOnly?: boolean };
const DT_RE = /^(\d{4})[:\-.](\d{2})[:\-.](\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?(?:[.,]\d+)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

// Parse an EXIF/XMP/QuickTime date string. Rejects blanks, all-zero dates and
// the QuickTime (1904) / Unix (1970) epoch zero values that mean "not set".
function parseDT(v: unknown): DT | null {
  if (v == null) return null;
  const m = DT_RE.exec(String(v).trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, tz] = m;
  if (!validYMD(+y, +mo, +d)) return null;
  const hh = h == null ? 12 : +h, mm = mi == null ? 0 : +mi, ss = Math.min(59, s == null ? 0 : +s);
  if (!validHMS(hh, mm, ss)) return null;
  const w = `${y}-${mo}-${d} ${pad(hh)}:${pad(mm)}:${pad(ss)}`;
  if (w.startsWith('1904-01-01') || w.startsWith('1970-01-01')) return null;
  const out: DT = { w };
  if (h == null) out.dateOnly = true;
  if (tz) {
    if (tz.toUpperCase() === 'Z') { out.off = 0; out.z = true; } else {
      const off = parseOffset(tz.length === 3 ? tz + ':00' : tz);
      if (off != null) out.off = off;
    }
  }
  return out;
}

// ---------- filename / folder evidence ----------

type FnDate = { w: string; prec: 'time' | 'day' | 'month' | 'year'; utc?: boolean; kind: string };

function mkTime(y: string, mo: string, d: string, h: string, mi: string, s: string, kind: string, utc = false): FnDate | null {
  if (!validYMD(+y, +mo, +d) || !validHMS(+h, +mi, +s)) return null;
  return { w: `${y}-${mo}-${d} ${pad(+h)}:${mi}:${pad(Math.min(59, +s))}`, prec: 'time', kind, utc };
}
const mkDay = (y: string, mo: string, d: string, kind: string): FnDate | null =>
  validYMD(+y, +mo, +d) ? { w: `${y}-${mo}-${d} 12:00:00`, prec: 'day', kind } : null;

// Camera counters like IMG_1998 / DSC01987 / P1020345 are not years.
const COUNTER_RE = /^(?:IMG|IMAG|IMAGE|DSC[NF_]?|_DSC|DSCI|DCP|P|PICT|PIC|PHOTO|CIMG|SAM|SDC|HPIM|KIF|MVI|MOV|VID|GOPR|GX\d\d|DJI|PANO|PXL|SCAN|EX|R|S)[_-]?\d{3,8}(?:[_-]\d{1,3})?(?:[ _-]?\(\d+\)| copy(?: \d+)?)?$/i;

// Timestamps embedded in names by cameras, phones and messaging apps. All of
// these are local wall time except Pixel's PXL_ (UTC) and FB_IMG_ (Unix time).
function filenameDate(raw: string, allowYearOnly = true): FnDate | null {
  const name = raw.normalize('NFC');
  let m: RegExpExecArray | null;

  if ((m = /^FB_IMG_(\d{13}|\d{10})(?!\d)/i.exec(name))) {
    const ms = m[1].length === 13 ? +m[1] : +m[1] * 1000;
    const w = fmtUTC(new Date(ms));
    return validYMD(+w.slice(0, 4), 1, 1) ? { w, prec: 'time', utc: true, kind: 'unix time' } : null;
  }
  // macOS screenshots / recordings, WhatsApp desktop exports, iOS "Photo ... at":
  // "Screenshot 2019-03-05 at 14.22.01", "Screen Shot 2015-11-20 at 9.05.33 PM"
  if ((m = /(\d{4})-(\d{2})-(\d{2}),? at (\d{1,2})[.:](\d{2})[.:](\d{2})(?:[\s  ]*([AaPp])\.?[Mm]\.?)?/.exec(name))) {
    let h = +m[4];
    if (m[7]) h = (h % 12) + (m[7].toLowerCase() === 'p' ? 12 : 0);
    const r = mkTime(m[1], m[2], m[3], String(h), m[5], m[6], /whatsapp/i.test(name) ? 'whatsapp' : 'screenshot');
    if (r) return r;
  }
  // WhatsApp on the phone: IMG-20190601-WA0003 (date only)
  if ((m = /^(?:IMG|VID|AUD|PTT|STK|DOC)-(\d{4})(\d{2})(\d{2})-WA\d+/i.exec(name))) {
    const r = mkDay(m[1], m[2], m[3], 'whatsapp');
    if (r) return r;
  }
  // Pixel: PXL_20200704_013000123 — UTC
  if ((m = /^PXL_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/i.exec(name))) {
    const r = mkTime(m[1], m[2], m[3], m[4], m[5], m[6], 'pixel', true);
    if (r) return r;
  }
  // Generic date + time: IMG_20190601_114716, VID_…, MVIMG_…, Screenshot_20190601-114716,
  // 20190601_114716 (Samsung), signal-2019-06-01-114716, photo_2019-06-01_11-47-16
  // (Telegram), "2019-06-01 11.47.16" (Dropbox), "Screenshot from 2019-06-01 11-47-16".
  if ((m = /(?<!\d)((?:19|20)\d{2})[-_.]?(\d{2})[-_.]?(\d{2})(?:[ _T.,-]|at)*(\d{2})[-_.:h ]?(\d{2})[-_.:m ]?(\d{2})(?!\d)/i.exec(name))) {
    const r = mkTime(m[1], m[2], m[3], m[4], m[5], m[6], 'filename');
    if (r) return r;
  }
  // Date only (consistent separator): 20190601, 2019-06-01, 1987_07_04
  if ((m = /(?<!\d)((?:19|20)\d{2})([-_.]?)(\d{2})\2(\d{2})(?!\d)/.exec(name))) {
    const r = mkDay(m[1], m[3], m[4], 'filename');
    if (r) return r;
  }
  if ((m = /(?<!\d)((?:19|20)\d{2})[-_.](0[1-9]|1[0-2])(?![\d])/.exec(name))) {
    if (+m[1] <= MAX_YEAR) return { w: `${m[1]}-${m[2]}-15 12:00:00`, prec: 'month', kind: 'filename' };
  }
  if (allowYearOnly && !COUNTER_RE.test(name) && (m = /(?<![\d])((?:19|20)\d{2})(?![\dx×])/i.exec(name))) {
    if (+m[1] <= MAX_YEAR - 1 || +m[1] === new Date().getFullYear()) {
      return { w: `${m[1]}-07-01 12:00:00`, prec: 'year', kind: 'filename' };
    }
  }
  return null;
}

// ---------- metadata signals ----------

type Signals = {
  dto?: DT; off?: number; dig?: DT; mod?: DT; xmp?: DT; qtLocal?: DT; qtUtc?: DT; gps?: DT; png?: DT;
  make?: string; model?: string; software?: string; handler?: string; android?: boolean;
  cid?: string; dur?: number; orient?: number;
};
type Kind = 'jpeg' | 'png' | 'gif' | 'webp' | 'avif' | 'heic' | 'video';
type Meta = { v: number; kind: Kind | null; skip?: string; fail?: string; s: Signals };

const IMAGE_KINDS = new Set<Kind | null>(['jpeg', 'png', 'gif', 'webp', 'avif', 'heic']);

// Normalise exiftool -G1 JSON (or our own readers, which emit the same keys).
function toSignals(r: Record<string, unknown>): Signals {
  const s: Signals = {};
  const keys = Object.keys(r);
  const bySuffix = (suffix: string, skip: RegExp = /^Composite:/) => {
    const k = keys.find(k => k.endsWith(':' + suffix) && !skip.test(k));
    return k ? r[k] : undefined;
  };
  const str = (v: unknown) => (v == null || String(v).trim() === '' ? undefined : String(v).trim());

  const dto = parseDT(r['ExifIFD:DateTimeOriginal'] ?? r['XMP-exif:DateTimeOriginal'] ?? bySuffix('DateTimeOriginal'));
  if (dto && !dto.dateOnly) s.dto = dto;
  const off = parseOffset(r['ExifIFD:OffsetTimeOriginal']) ?? parseOffset(r['ExifIFD:OffsetTime']) ?? s.dto?.off ?? null;
  if (off != null) s.off = off;
  const dig = parseDT(r['ExifIFD:CreateDate'] ?? r['XMP-exif:DateTimeDigitized']);
  if (dig && !dig.dateOnly) s.dig = dig;
  const mod = parseDT(r['IFD0:ModifyDate']);
  if (mod) s.mod = mod;
  const xmp = parseDT(r['XMP-photoshop:DateCreated'] ?? r['Composite:DateTimeCreated'] ?? r['XMP-xmp:CreateDate'] ?? r['IPTC:DateCreated']);
  if (xmp) s.xmp = xmp;

  // Videos. Apple's Keys:CreationDate carries local time + offset. QuickTime
  // CreateDate is UTC per spec (but some cameras write local time there).
  for (const k of ['Keys:CreationDate', 'ItemList:CreationDate', 'UserData:CreationDate']) {
    const v = parseDT(r[k]);
    if (!v || v.dateOnly) continue;
    if (v.z) s.qtUtc ??= v; else { s.qtLocal = v; break; }
  }
  const qt = parseDT(r['QuickTime:CreateDate'] ?? r['Track1:MediaCreateDate']);
  if (qt && !qt.dateOnly) s.qtUtc = qt;
  else if (!s.qtUtc) {
    const ct = parseDT(r['Keys:CreationTime']);
    if (ct?.z) s.qtUtc = ct;
  }

  let gps = parseDT(r['Composite:GPSDateTime']);
  if (!gps && r['GPS:GPSDateStamp'] && r['GPS:GPSTimeStamp'] != null) {
    const t = String(r['GPS:GPSTimeStamp']).split(':').map(x => pad(Math.floor(+x || 0)));
    gps = parseDT(`${r['GPS:GPSDateStamp']} ${t.join(':')}Z`);
  }
  if (gps && !gps.dateOnly) s.gps = { ...gps, z: true, off: 0 };
  const png = parseDT(r['PNG:CreationTime']);
  if (png && !png.dateOnly) s.png = png;

  s.make = str(bySuffix('Make'));
  s.model = str(bySuffix('Model'));
  s.software = str(bySuffix('Software'));
  const handlers = keys.filter(k => /:(HandlerDescription|CompressorName|Encoder)$/.test(k)).map(k => String(r[k]));
  if (handlers.length) s.handler = handlers.join(' | ');
  if (keys.some(k => k.endsWith(':AndroidVersion'))) s.android = true;
  s.cid = str(bySuffix('ContentIdentifier'));
  const dur = Number(r['QuickTime:Duration'] ?? bySuffix('Duration'));
  if (Number.isFinite(dur) && dur > 0) s.dur = dur;
  const orient = Number(r['IFD0:Orientation']);
  if (orient >= 1 && orient <= 8) s.orient = orient;
  for (const k of Object.keys(s) as Array<keyof Signals>) if (s[k] === undefined) delete s[k];
  return s;
}

// ---------- date resolution: weigh the evidence ----------

type Res = { d: string; src: string; conf: Conf };
type FileTimes = { mtimeMs: number; birthMs: number };

const SCANNER_RE = /scan|fastfoto|\bFF-\d|perfection|canoscan|photomyne|vuescan|silverfast|flatbed|doxie|plustek|opticfilm|reflecta|scanza|wolverine/i;
// Makers whose cameras commonly write *local* time into QuickTime CreateDate.
const LOCAL_QT_RE = /gopro|canon|nikon|panasonic|olympus|om digital|fujifilm|pentax|ricoh|kodak|casio|sanyo|jvc|leica|sigma|hasselblad/i;
const PHONE_RE = /apple|iphone|ipad|google|pixel|samsung|huawei|honor|xiaomi|redmi|oneplus|motorola|\blge?\b|oppo|vivo|realme|nokia|htc|asus|zte/i;
const GOPRO_NAME_RE = /^(GOPR|GP\d\d|GX\d\d|GH\d\d|GS\d\d|GL\d\d)\d{4}$/i;

const isScanner = (s: Signals) => SCANNER_RE.test([s.make, s.model, s.software].filter(Boolean).join(' '));
const diffMin = (a: string, b: string) => (wallMs(a) - wallMs(b)) / 60_000;
// Two wall times that differ by a plausible UTC offset (<= 14 h, quarter-hour multiple).
const tzShift = (dm: number) => {
  const a = Math.abs(dm);
  return a <= 14 * 60 + 2 && (a % 15 <= 2 || a % 15 >= 13);
};
const stemOf = (rel: string) => path.basename(rel, path.extname(rel));

function fileTimeRes(t: FileTimes): Res {
  const ms = t.birthMs > 0 && t.birthMs < t.mtimeMs ? t.birthMs : t.mtimeMs;
  return { d: fmtLocal(new Date(ms)), src: 'file time (no date metadata)', conf: 'low' };
}

function fnRes(fn: FnDate, t: FileTimes, where = 'filename'): Res {
  if (fn.utc) {
    return { d: utcToLocal(fn.w), src: `${where} (${fn.kind}, UTC→local)`, conf: fn.kind === 'unix time' ? 'low' : 'medium' };
  }
  if (fn.prec === 'time') return { d: fn.w, src: `${where} (${fn.kind})`, conf: where === 'filename' ? 'high' : 'medium' };
  if (fn.prec === 'day') {
    // The name gives the day; borrow the time of day from the file if it agrees.
    const mt = fmtLocal(new Date(t.mtimeMs));
    if (mt.slice(0, 10) === fn.w.slice(0, 10)) return { d: mt, src: `${where} date (${fn.kind}) + file time`, conf: 'medium' };
    return { d: fn.w, src: `${where} date (${fn.kind})`, conf: where === 'filename' ? 'medium' : 'low' };
  }
  return { d: fn.w, src: `${where} ${fn.prec} only`, conf: 'low' };
}

function folderDate(rel: string): FnDate | null {
  const dirs = path.dirname(rel).split('/').filter(p => p && p !== '.' && p !== 'uploads');
  for (let i = dirs.length - 1; i >= 0; i--) {
    const fn = filenameDate(dirs[i]);
    if (fn && !fn.utc) return fn;
  }
  return null;
}

// QuickTime CreateDate: UTC by spec, local time on many dedicated cameras.
function resolveQuickTime(s: Signals, stem: string, fn: FnDate | null, offHint: number | null): Res {
  const qt = s.qtUtc!;
  if (fn && fn.prec === 'time' && !qt.z) {
    const dm = diffMin(qt.w, fn.w);
    if (fn.utc && Math.abs(dm) <= 2) return { d: utcToLocal(qt.w, s.off ?? offHint), src: 'quicktime:CreateDate (UTC, matches filename)', conf: 'medium' };
    if (!fn.utc && Math.abs(dm) <= 2) return { d: fn.w, src: 'filename + quicktime:CreateDate (camera local time)', conf: 'high' };
    if (!fn.utc && tzShift(dm)) return { d: fn.w, src: 'filename (QuickTime UTC time agrees)', conf: 'high' };
  }
  const tags = [s.make, s.model, s.handler].filter(Boolean).join(' ');
  const phone = s.android || PHONE_RE.test(s.make ?? '') || PHONE_RE.test(s.model ?? '');
  if (!qt.z && !phone && (LOCAL_QT_RE.test(tags) || GOPRO_NAME_RE.test(stem))) {
    return { d: qt.w, src: 'quicktime:CreateDate (camera local time)', conf: 'medium' };
  }
  const off = s.off ?? offHint;
  return { d: utcToLocal(qt.w, off), src: `quicktime:CreateDate (UTC→local${off != null ? ' via offset' : ''})`, conf: 'medium' };
}

// Own capture-time evidence only (no filename/file-time guesses); used to let a
// Live Photo's photo and video vouch for each other.
function captureDate(m: Meta, rel: string, offHint: number | null): Res | null {
  const s = m.s;
  if (s.dto && !isScanner(s)) return { d: s.dto.w, src: 'exif:DateTimeOriginal', conf: 'high' };
  if (s.qtLocal) return { d: s.qtLocal.w, src: 'quicktime:CreationDate', conf: 'high' };
  if (s.qtUtc) return resolveQuickTime(s, stemOf(rel), filenameDate(stemOf(rel), false), offHint);
  return null;
}

function resolveDate(rel: string, m: Meta, t: FileTimes, pair?: { rel: string; m: Meta }): Res {
  const s = m.s;
  const stem = stemOf(rel);
  const fn = filenameDate(stem);
  const notes: string[] = [];
  const done = (r: Res): Res => (notes.length ? { ...r, src: `${r.src}; ${notes.join('; ')}` } : r);
  const demote = (r: Res, to: Conf, note: string) => {
    notes.push(note);
    if (r.conf === 'high' || (r.conf === 'medium' && to === 'low')) r.conf = to;
  };

  // 1. Scanned prints: the scanner stamps EXIF with the *scan* date.
  if (isScanner(s)) {
    const stamp = s.dto ?? s.dig ?? s.mod;
    const scanTimes = [s.dig, s.mod].filter(Boolean) as DT[];
    const userSet = s.dto && scanTimes.some(x => Math.abs(wallMs(x.w) - wallMs(s.dto!.w)) > DAY);
    if (s.dto && userSet) return { d: s.dto.w, src: 'exif:DateTimeOriginal (set on a scanned print)', conf: 'high' };
    const named = fn ?? folderDate(rel);
    if (named) {
      const r = fnRes(named, t, fn ? 'filename' : 'folder name');
      return { ...r, src: `${r.src} (scanner EXIF holds the scan date)`, conf: named.prec === 'time' || named.prec === 'day' ? 'medium' : 'low' };
    }
    if (stamp) return { d: stamp.w, src: 'exif date of a scanner (probably the scan date, not the photo)', conf: 'low' };
  }

  // 2. EXIF DateTimeOriginal: the camera's own local clock at capture.
  if (s.dto) {
    const r: Res = { d: s.dto.w, src: 'exif:DateTimeOriginal', conf: 'high' };
    if (s.gps) {
      // GPS time is UTC from satellites. Beyond any timezone, the two must agree.
      const gap = s.off != null
        ? Math.abs(wallMs(s.dto.w) - s.off * 60_000 - wallMs(s.gps.w))
        : Math.abs(wallMs(s.dto.w) - wallMs(s.gps.w)) - 14 * HOUR;
      // A camera clock that was never set (reset to its factory 1 Jan date) or is
      // off by more than a month is far likelier than a GPS fix that stale.
      const resetClock = /^(19[789]\d|200\d|2010)-01-01 0[0-2]:/.test(s.dto.w);
      if (gap > 3 * HOUR && (resetClock || gap > 30 * DAY)) {
        return { d: utcToLocal(s.gps.w, s.off ?? null), src: `gps time (camera clock wrong: it said ${s.dto.w})`, conf: 'medium' };
      }
      if (gap > 3 * HOUR) demote(r, 'low', `GPS time ${s.gps.w} UTC disagrees`);
    }
    if (fn && fn.prec === 'time' && !fn.utc && fn.kind !== 'unix time') {
      const dm = diffMin(r.d, fn.w);
      if (Math.abs(dm) > 26 * 60) demote(r, 'medium', `filename says ${fn.w}`);
    }
    if (pair) {
      const p = captureDate(pair.m, pair.rel, s.off ?? null);
      if (p && p.conf === 'high' && Math.abs(diffMin(r.d, p.d)) > 10) demote(r, 'medium', `Live Photo video says ${p.d}`);
    }
    return done(r);
  }

  // 3. Video: Apple's local CreationDate, then QuickTime CreateDate.
  if (s.qtLocal) return { d: s.qtLocal.w, src: 'quicktime:CreationDate', conf: 'high' };
  // 4. XMP / IPTC "date created" (Lightroom, Photos exports, some screenshots).
  if (s.xmp) return { d: s.xmp.w, src: 'xmp:DateCreated', conf: s.xmp.dateOnly ? 'medium' : 'high' };
  // 5. EXIF CreateDate (digitised) — same instant as DateTimeOriginal on cameras.
  if (s.dig) return { d: s.dig.w, src: 'exif:CreateDate', conf: 'high' };
  if (s.qtUtc) return resolveQuickTime(s, stem, fn, null);
  // 6. Live Photo partner: a stripped photo inherits its video's capture time.
  if (pair) {
    const p = captureDate(pair.m, pair.rel, s.off ?? null);
    if (p) return { ...p, src: `Live Photo video: ${p.src}` };
  }
  // 7. A timestamp in the filename written by the camera / app.
  if (fn && fn.prec === 'time') return fnRes(fn, t);
  // 8. GPS (UTC) or PNG creation time.
  if (s.gps) return { d: utcToLocal(s.gps.w, s.off ?? null), src: 'gps time (UTC→local)', conf: 'medium' };
  if (s.png) return { d: s.png.w, src: 'png:CreationTime', conf: 'medium' };
  // 9. Partial dates in the name, then the folder name.
  if (fn) return fnRes(fn, t);
  const folder = folderDate(rel);
  if (folder) return fnRes(folder, t, 'folder name');
  // 10. Last resorts: editor's ModifyDate, then the file's own timestamps.
  if (s.mod) return { d: s.mod.w, src: 'exif:ModifyDate (last edit)', conf: 'low' };
  return fileTimeRes(t);
}

// ---------- reading files: sniff, integrity, metadata ----------

type Entry = { rel: string; abs: string; ext: string; size: number; mtimeMs: number; birthMs: number; sig: string };

function readAt(fd: number, pos: number, len: number): Buffer {
  const b = Buffer.alloc(Math.max(0, len));
  const n = len > 0 ? readSync(fd, b, 0, len, pos) : 0;
  return n === len ? b : b.subarray(0, n);
}

const BMFF_IMAGE_BRANDS = /^(heic|heix|hevc|hevx|heim|heis|hevm|hevs|mif1|msf1)$/;
const printable = (b: Buffer) => b.length > 0 && [...b.subarray(0, 64)].every(c => c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127));

// Walk the top-level ISO-BMFF boxes (MP4/MOV/HEIC). Truncation shows up as a box
// that runs past the end of the file or a missing moov/meta box.
function bmffBoxes(fd: number, size: number): { types: Set<string>; bad?: string } {
  const types = new Set<string>();
  let pos = 0;
  for (let i = 0; i < 1000 && pos + 8 <= size; i++) {
    const h = readAt(fd, pos, 16);
    let len = h.readUInt32BE(0);
    const type = h.toString('latin1', 4, 8);
    if (!/^[\x20-\x7e]{4}$/.test(type)) return { types, bad: `corrupt container (garbage at byte ${pos})` };
    if (len === 1) len = h.length >= 16 ? Number(h.readBigUInt64BE(8)) : 0;
    else if (len === 0) len = size - pos;
    if (len < 8) return { types, bad: `corrupt container (bad box size at byte ${pos})` };
    types.add(type);
    if (pos + len > size) return { types, bad: `truncated (the '${type}' box needs ${pos + len - size} more bytes)` };
    pos += len;
  }
  return { types };
}

// Find the end-of-image marker after the first start-of-scan. Entropy-coded
// data can't contain FF D9, so its absence means the download/copy was cut short.
function jpegCheck(fd: number, size: number, head: Buffer): { bad?: string; exif?: Buffer } {
  let pos = 2, exif: Buffer | undefined;
  let sos = -1;
  while (pos + 4 <= size) {
    const seg = pos + 4 <= head.length ? head.subarray(pos, pos + 4) : readAt(fd, pos, 4);
    if (seg[0] !== 0xff) return { bad: 'corrupt JPEG (bad segment marker)' };
    const marker = seg[1];
    if (marker === 0xff) { pos++; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { pos += 2; continue; }
    if (marker === 0xd9) return { bad: 'corrupt JPEG (no image data)' };
    const len = seg.readUInt16BE(2);
    if (len < 2) return { bad: 'corrupt JPEG (bad segment length)' };
    if (marker === 0xe1 && !exif) {
      const body = readAt(fd, pos + 4, len - 2);
      if (body.toString('latin1', 0, 6) === 'Exif\0\0') exif = body.subarray(6);
    }
    if (marker === 0xda) { sos = pos + 2 + len; break; }
    pos += 2 + len;
  }
  if (sos < 0 || sos >= size) return { bad: 'truncated JPEG (no image data)', exif };
  const EOI = Buffer.from([0xff, 0xd9]);
  const tailStart = Math.max(sos, size - 65536);
  if (readAt(fd, tailStart, size - tailStart).includes(EOI)) return { exif };
  // Not near the end: maybe a trailer (Motion Photo video, Samsung data). Scan forward.
  for (let p = sos; p < size; p += 1 << 20) {
    if (readAt(fd, p, Math.min((1 << 20) + 1, size - p)).includes(EOI)) return { exif };
  }
  return { bad: 'truncated JPEG (image data cut off, no end marker)', exif };
}

// Identify a file by its bytes (not its extension) and check it is complete.
function probeFile(e: Entry): { kind: Kind | null; skip?: string; raw?: Record<string, unknown> } {
  if (UNSUPPORTED_EXT[e.ext]) return { kind: null, skip: `unsupported format (${UNSUPPORTED_EXT[e.ext]}) — convert to JPEG/MP4 to include it` };
  if (e.size === 0) return { kind: null, skip: 'empty file (0 bytes)' };
  let fd = -1;
  try {
    fd = openSync(e.abs, 'r');
    const head = readAt(fd, 0, Math.min(e.size, 262144));
    if (head.length < 12) return { kind: null, skip: `too small to be media (${e.size} bytes)` };
    const tag4 = head.toString('latin1', 4, 8);
    if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
      const { bad, exif } = jpegCheck(fd, e.size, head);
      if (bad) return { kind: 'jpeg', skip: bad };
      return { kind: 'jpeg', raw: exif ? readExifTiff(exif) : {} };
    }
    if (head.readUInt32BE(0) === 0x89504e47) {
      const tail = readAt(fd, Math.max(0, e.size - 32), Math.min(32, e.size));
      return tail.includes(Buffer.from('IEND')) ? { kind: 'png' } : { kind: 'png', skip: 'truncated PNG (no IEND chunk)' };
    }
    if (head.toString('latin1', 0, 4) === 'GIF8') {
      const tail = readAt(fd, Math.max(0, e.size - 16), Math.min(16, e.size));
      return tail.includes(0x3b) ? { kind: 'gif' } : { kind: 'gif', skip: 'truncated GIF' };
    }
    if (head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') {
      return head.readUInt32LE(4) + 8 <= e.size ? { kind: 'webp' } : { kind: 'webp', skip: 'truncated WebP' };
    }
    if (head.readUInt32BE(0) === 0x1a45dfa3) return { kind: 'video' }; // WebM / Matroska
    if (tag4 === 'ftyp' || /^(moov|mdat|wide|free|skip|pnot)$/.test(tag4)) {
      let kind: Kind = 'video';
      if (tag4 === 'ftyp') {
        const boxLen = Math.min(head.readUInt32BE(0), head.length);
        const brands = [head.toString('latin1', 8, 12)];
        for (let p = 16; p + 4 <= boxLen; p += 4) brands.push(head.toString('latin1', p, p + 4));
        if (brands.includes('avif') || brands.includes('avis')) kind = 'avif';
        else if (BMFF_IMAGE_BRANDS.test(brands[0]) || (brands.some(b => BMFF_IMAGE_BRANDS.test(b)) && !brands.includes('qt  '))) kind = 'heic';
      }
      const { types, bad } = bmffBoxes(fd, e.size);
      if (bad) return { kind, skip: bad };
      if (kind === 'video' && !types.has('moov')) return { kind, skip: 'incomplete video (no moov index — truncated or still copying?)' };
      if (kind !== 'video' && !types.has('meta')) return { kind, skip: 'corrupt image (no meta box)' };
      return { kind };
    }
    const what = printable(head) ? (/<(html|!doctype|\?xml|svg)/i.test(head.toString('latin1', 0, 256)) ? 'HTML/XML text' : 'text') : 'unrecognised data';
    return { kind: null, skip: `not a real ${e.ext.slice(1).toUpperCase()} (contains ${what})` };
  } catch (err: any) {
    return { kind: null, skip: `unreadable (${err?.code ?? err?.message ?? err})` };
  } finally {
    if (fd >= 0) try { closeSync(fd); } catch {}
  }
}

// Minimal TIFF/EXIF reader for JPEG APP1 — the fallback when exiftool is absent.
function readExifTiff(t: Buffer): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  try {
    const le = t.toString('latin1', 0, 2) === 'II';
    const u16 = (o: number) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
    const u32 = (o: number) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
    if (u16(2) !== 42) return out;
    const SIZES = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];
    type E = { type: number; count: number; at: number };
    const ifd = (off: number) => {
      const tags = new Map<number, E>();
      if (!off || off + 2 > t.length) return tags;
      const n = Math.min(u16(off), 512);
      for (let i = 0; i < n; i++) {
        const e = off + 2 + i * 12;
        if (e + 12 > t.length) break;
        const type = u16(e + 2), count = u32(e + 4);
        const size = (SIZES[type] ?? 1) * count;
        const at = size <= 4 ? e + 8 : u32(e + 8);
        if (at + size <= t.length) tags.set(u16(e), { type, count, at });
      }
      return tags;
    };
    const str = (m: Map<number, E>, id: number) => {
      const v = m.get(id);
      return v && v.type === 2 ? t.toString('latin1', v.at, v.at + v.count).replace(/\0[\s\S]*$/, '').trim() || undefined : undefined;
    };
    const int = (m: Map<number, E>, id: number) => {
      const v = m.get(id);
      return !v ? undefined : v.type === 3 ? u16(v.at) : v.type === 4 ? u32(v.at) : undefined;
    };
    const ifd0 = ifd(u32(4));
    Object.assign(out, {
      'IFD0:Make': str(ifd0, 0x010f), 'IFD0:Model': str(ifd0, 0x0110), 'IFD0:Software': str(ifd0, 0x0131),
      'IFD0:ModifyDate': str(ifd0, 0x0132), 'IFD0:Orientation': int(ifd0, 0x0112),
    });
    const ex = ifd(int(ifd0, 0x8769) ?? 0);
    Object.assign(out, {
      'ExifIFD:DateTimeOriginal': str(ex, 0x9003), 'ExifIFD:CreateDate': str(ex, 0x9004),
      'ExifIFD:OffsetTime': str(ex, 0x9010), 'ExifIFD:OffsetTimeOriginal': str(ex, 0x9011),
    });
    const gps = ifd(int(ifd0, 0x8825) ?? 0);
    const ts = gps.get(0x0007);
    if (ts && ts.type === 5 && ts.count === 3) {
      const r = [0, 1, 2].map(i => u32(ts.at + i * 8) / (u32(ts.at + i * 8 + 4) || 1));
      out['GPS:GPSTimeStamp'] = r.map(x => pad(Math.floor(x))).join(':');
      out['GPS:GPSDateStamp'] = str(gps, 0x001d);
    }
  } catch {}
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

const EXIF_TAGS = [
  'DateTimeOriginal', 'CreateDate', 'ModifyDate', 'OffsetTimeOriginal', 'OffsetTime', 'DateCreated', 'DateTimeCreated',
  'CreationDate', 'CreationTime', 'MediaCreateDate', 'GPSDateTime', 'GPSDateStamp', 'GPSTimeStamp', 'Make', 'Model',
  'Software', 'HandlerDescription', 'AndroidVersion', 'ContentIdentifier', 'Duration', 'Orientation',
].map(t => '-' + t);

// One exiftool process per chunk of files; returns SourceFile -> tags.
async function exiftoolChunk(files: string[]): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  const { out: text } = await run(
    [TOOLS.exiftool!, '-j', '-G1', '-a', '-n', '-fast', '-charset', 'filename=utf8', ...EXIF_TAGS, ...files],
    { stdout: true, timeoutMs: 300_000 },
  );
  try {
    for (const rec of JSON.parse(text || '[]')) {
      out.set(String(rec.SourceFile).normalize('NFC'), rec);
    }
  } catch {
    console.log(`exiftool returned unreadable output for ${files.length} files; using fallbacks for them`);
  }
  return out;
}

// ffprobe fallback for videos when exiftool is missing.
async function ffprobeMeta(abs: string): Promise<Record<string, unknown>> {
  if (!TOOLS.ffprobe) return {};
  const { out } = await run(
    [TOOLS.ffprobe, '-v', 'quiet', '-print_format', 'json', '-show_entries', 'format=duration:format_tags:stream_tags=handler_name', abs],
    { stdout: true, timeoutMs: 60_000 },
  );
  try {
    const j = JSON.parse(out || '{}');
    const tags: Record<string, string> = j.format?.tags ?? {};
    const r: Record<string, unknown> = {};
    const ct = tags.creation_time;
    if (ct) r['QuickTime:CreateDate'] = ct.replace('T', ' ').replace(/\.\d+/, '').replace(/Z$/, '');
    if (tags['com.apple.quicktime.creationdate']) r['Keys:CreationDate'] = tags['com.apple.quicktime.creationdate'];
    const make = tags['com.apple.quicktime.make'] ?? tags.make;
    if (make) r['Keys:Make'] = make;
    const model = tags['com.apple.quicktime.model'] ?? tags.model;
    if (model) r['Keys:Model'] = model;
    if (tags['com.android.version']) r['Keys:AndroidVersion'] = tags['com.android.version'];
    if (tags['com.apple.quicktime.content.identifier']) r['Keys:ContentIdentifier'] = tags['com.apple.quicktime.content.identifier'];
    const handlers = (j.streams ?? []).map((s: any) => s.tags?.handler_name).filter(Boolean);
    if (handlers.length) r['Track1:HandlerDescription'] = handlers.join(' | ');
    if (j.format?.duration) r['QuickTime:Duration'] = Number(j.format.duration);
    return r;
  } catch {
    return {};
  }
}

// macOS fallback for HEIC dates when exiftool is missing: `sips -g creation`
// prints DateTimeOriginal ("creation: 2021:12:31 23:59:10") per file.
async function sipsCreation(files: string[]): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  if (!TOOLS.sips || !files.length) return out;
  const { out: text } = await run([TOOLS.sips, '-g', 'creation', ...files], { stdout: true, timeoutMs: 300_000 });
  let cur: string | null = null;
  for (const line of text.split('\n')) {
    if (!line.startsWith(' ') && line.trim()) cur = line.trim().normalize('NFC');
    const m = /^\s+creation:\s*(.+)$/.exec(line);
    if (cur && m) out.set(cur, { 'ExifIFD:DateTimeOriginal': m[1].trim() });
  }
  return out;
}

// Read metadata for files not in the cache, in parallel batches.
async function readMetadata(entries: Entry[]): Promise<Map<string, Meta>> {
  const metas = new Map<string, Meta>();
  const toRead: Array<{ e: Entry; kind: Kind; raw?: Record<string, unknown> }> = [];
  for (const e of entries) {
    const p = probeFile(e);
    if (p.skip || !p.kind) metas.set(e.rel, { v: META_VER, kind: p.kind, skip: p.skip ?? 'not media', s: {} });
    // A JPEG whose own EXIF block already holds DateTimeOriginal needs nothing
    // more from exiftool (XMP/IPTC dates never outrank it), so skip the spawn.
    else if (p.kind === 'jpeg' && p.raw && parseDT(p.raw['ExifIFD:DateTimeOriginal'])) {
      metas.set(e.rel, { v: META_VER, kind: p.kind, s: toSignals(p.raw) });
    } else toRead.push({ e, kind: p.kind, raw: p.raw });
  }

  const raws = new Map<string, Record<string, unknown>>();
  if (TOOLS.exiftool && toRead.length) {
    // Spread across cores; small enough chunks that the tail balances out.
    const size = Math.max(8, Math.min(200, Math.ceil(toRead.length / (CORES * 3))));
    const chunks: string[][] = [];
    for (let i = 0; i < toRead.length; i += size) chunks.push(toRead.slice(i, i + size).map(x => x.e.abs));
    await pool(chunks, CORES, async chunk => {
      for (const [k, v] of await exiftoolChunk(chunk)) raws.set(k, v);
    });
  } else if (toRead.length) {
    await pool(toRead.filter(x => x.kind === 'video'), CORES, async x => { raws.set(x.e.abs.normalize('NFC'), await ffprobeMeta(x.e.abs)); });
    const heics = toRead.filter(x => x.kind === 'heic').map(x => x.e.abs);
    for (let i = 0; i < heics.length; i += 200) {
      for (const [k, v] of await sipsCreation(heics.slice(i, i + 200))) raws.set(k, v);
    }
  }
  for (const { e, kind, raw } of toRead) {
    const r = raws.get(e.abs.normalize('NFC')) ?? raw ?? {};
    metas.set(e.rel, { v: META_VER, kind, s: toSignals(r) });
  }
  return metas;
}

// ---------- derived files (HEIC -> JPEG, video posters) ----------
// Generated in the background, earliest slides first. A request for a file that
// isn't ready yet jumps the queue and waits for it.

type Job = { dst: string; rel: string; work: () => Promise<string | null>; started?: Promise<boolean> };
const jobs = new Map<string, Job>();
let queue: Job[] = [];
let activeJobs = 0;
let jobsDone = 0;

function enqueue(job: Job) {
  if (jobs.has(job.dst)) return;
  jobs.set(job.dst, job);
  queue.push(job);
  pump();
}
function pump() {
  while (activeJobs < CORES && queue.length) startJob(queue.shift()!);
}
function startJob(j: Job): Promise<boolean> {
  if (!j.started) {
    activeJobs++;
    j.started = (async () => {
      let err: string | null;
      try { err = await j.work(); } catch (e) { err = String(e); }
      activeJobs--;
      jobsDone++;
      jobs.delete(j.dst);
      if (err) markFailed(j.rel, err);
      pump();
      return !err;
    })();
  }
  return j.started;
}
async function awaitDerived(abs: string) {
  const j = jobs.get(abs);
  if (!j) return;
  queue = queue.filter(q => q !== j);
  await startJob(j);
}

function markFailed(rel: string, reason: string) {
  console.log(`skipped ${rel}: ${reason}`);
  slides = slides.filter(s => s.id !== rel);
  skipped = [...skipped.filter(s => s.id !== rel), { id: rel, reason }];
  try {
    const row = db.query('SELECT meta FROM exif_cache WHERE path = ?').get(rel) as { meta: string | null } | null;
    if (row?.meta) {
      const m = JSON.parse(row.meta) as Meta;
      m.fail = reason;
      db.run('UPDATE exif_cache SET meta = ? WHERE path = ?', [JSON.stringify(m), rel]);
    }
  } catch {}
}

const partPath = (dst: string) => dst.slice(0, -path.extname(dst).length) + '.part.jpg';

async function convertHeic(src: string, dst: string): Promise<string | null> {
  const tmp = partPath(dst);
  const cmd = HEIC_CONVERTER === 'sips'
    ? [TOOLS.sips!, '-s', 'format', 'jpeg', '-s', 'formatOptions', '85', src, '--out', tmp]
    : [TOOLS.heifConvert!, '-q', '85', src, tmp];
  const { code } = await run(cmd, { timeoutMs: 120_000 });
  const multi = tmp.slice(0, -4) + '-1.jpg'; // heif-convert numbers multi-image files
  if (!existsSync(tmp) && existsSync(multi)) renameSync(multi, tmp);
  if (code !== 0 || !existsSync(tmp) || statSync(tmp).size === 0) {
    try { unlinkSync(tmp); } catch {}
    return `HEIC conversion failed (${HEIC_CONVERTER} exit ${code}) — file may be corrupt`;
  }
  renameSync(tmp, dst);
  return null;
}

function posterFor(vidRel: string) {
  const stem = vidRel.slice(0, -path.extname(vidRel).length);
  const safe = 'poster__' + stem.replaceAll('/', '__') + '.jpg';
  return { rel: `_converted/${safe}`, abs: path.join(CONVERTED, safe) };
}

async function extractPoster(vidAbs: string, dstAbs: string, time: number): Promise<boolean> {
  if (!TOOLS.ffmpeg) return false;
  const tmp = partPath(dstAbs);
  for (const t of time > 0 ? [time, 0] : [0]) {
    const { code } = await run(
      [TOOLS.ffmpeg, '-v', 'error', '-y', '-ss', String(Math.max(0, t)), '-i', vidAbs, '-frames:v', '1', '-q:v', '3', tmp],
      { timeoutMs: 120_000 },
    );
    if (code === 0 && existsSync(tmp) && statSync(tmp).size > 0) {
      renameSync(tmp, dstAbs);
      return true;
    }
  }
  try { unlinkSync(tmp); } catch {}
  return false;
}

async function ffprobe(args: string[]): Promise<string> {
  if (!TOOLS.ffprobe) return '';
  return (await run([TOOLS.ffprobe, '-v', 'quiet', ...args], { stdout: true, timeoutMs: 60_000 })).out.trim();
}
const probeDuration = async (p: string) =>
  parseFloat(await ffprobe(['-show_entries', 'format=duration', '-of', 'csv=p=0', p])) || 0;
const probeVideoCodec = (p: string) =>
  ffprobe(['-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', p]);

// ---------- scanning ----------

// Library bundles and NAS/OS thumbnail folders hold derivatives of photos that
// are already elsewhere; walking into them would duplicate every picture.
const SKIP_DIR_RE = /^(node_modules|@eaDir|#recycle|\$RECYCLE\.BIN|System Volume Information|\.?thumbnails)$|\.(photoslibrary|migratedphotolibrary|aplibrary|lrdata|lrlibrary|fcpbundle|imovielibrary|app|bundle)$/i;

function listMedia(): Entry[] {
  const out: Entry[] = [];
  const walk = (dir: string, prefix: string, depth: number) => {
    let names;
    try { names = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const de of names) {
      const name = de.name;
      if (name.startsWith('.')) continue;
      const rel = prefix + name;
      const abs = path.join(dir, name);
      let st: Stats | null = null;
      if (de.isSymbolicLink()) { try { st = statSync(abs); } catch { continue; } }
      if (de.isDirectory() || st?.isDirectory()) {
        if (depth < 8 && rel !== '_converted' && rel !== 'uploads/_removed' && !SKIP_DIR_RE.test(name)) walk(abs, rel + '/', depth + 1);
        continue;
      }
      const ext = path.extname(name).toLowerCase();
      if (!IMG_EXT.has(ext) && !HEIC_EXT.has(ext) && !VID_EXT.has(ext) && !UNSUPPORTED_EXT[ext]) continue;
      try { st ??= statSync(abs); } catch { continue; }
      if (!st.isFile()) continue;
      out.push({
        rel, abs, ext, size: st.size, mtimeMs: st.mtimeMs, birthMs: st.birthtimeMs,
        sig: `${st.size}-${Math.floor(st.mtimeMs)}`,
      });
    }
  };
  walk(ROOT, '', 0);
  return out;
}

async function scan() {
  const t0 = performance.now();
  mkdirSync(CONVERTED, { recursive: true });
  const entries = listMedia();

  // 1. Metadata: from the cache, reading only new or changed files.
  const cache = new Map<string, { sig: string; ver: number | null; meta: string | null }>();
  for (const r of db.query('SELECT path, sig, ver, meta FROM exif_cache').all() as any[]) cache.set(r.path, r);
  const metas = new Map<string, Meta>();
  const stale: Entry[] = [];
  for (const e of entries) {
    const c = cache.get(e.rel);
    if (c && c.sig === e.sig && c.ver === META_VER && c.meta) {
      try { metas.set(e.rel, JSON.parse(c.meta)); continue; } catch {}
    }
    stale.push(e);
  }
  if (stale.length) {
    const t1 = performance.now();
    const fresh = await readMetadata(stale);
    for (const [k, v] of fresh) metas.set(k, v);
    if (stale.length > 20) console.log(`read metadata for ${stale.length} files in ${Math.round(performance.now() - t1)} ms`);
  }

  // 2. Pair Live Photos (same folder + stem) and resolve dates.
  const byRel = new Map(entries.map(e => [e.rel, e]));
  const stillsByKey = new Map<string, string[]>();
  const keyOf = (rel: string) => rel.slice(0, rel.length - path.extname(rel).length).toLowerCase();
  const newSkipped: Skip[] = [];
  const stills: string[] = [], videos: string[] = [];
  for (const e of entries) {
    const m = metas.get(e.rel)!;
    if (m.skip || m.fail || !m.kind) { newSkipped.push({ id: e.rel, reason: m.skip ?? m.fail ?? 'not media' }); continue; }
    if (IMAGE_KINDS.has(m.kind)) {
      stills.push(e.rel);
      const k = keyOf(e.rel);
      stillsByKey.set(k, [...(stillsByKey.get(k) ?? []), e.rel]);
    } else videos.push(e.rel);
  }
  const pairOf = new Map<string, string>(); // still rel -> video rel
  const solos: string[] = [];
  for (const v of videos) {
    const vm = metas.get(v)!;
    const partners = (stillsByKey.get(keyOf(v)) ?? []).filter(s => {
      const cid = metas.get(s)!.s.cid;
      return !(cid && vm.s.cid && cid !== vm.s.cid);
    });
    if (partners.length && !(vm.s.dur && vm.s.dur > LIVE_MAX_SECONDS)) {
      for (const s of partners) if (!pairOf.has(s)) pairOf.set(s, v);
    } else solos.push(v);
  }

  const convertedFiles = new Set(readdirSync(CONVERTED));
  const derivedFresh = (name: string, srcMtime: number) => {
    if (!convertedFiles.has(name)) return false;
    // (a source mtime in the future — a bad camera clock — must not force a redo every launch)
    try { return srcMtime > Date.now() || statSync(path.join(CONVERTED, name)).mtimeMs >= srcMtime; } catch { return false; }
  };
  const posterOverrides = new Map<string, number>();
  for (const r of db.query('SELECT id, poster FROM overrides WHERE poster IS NOT NULL').all() as any[]) posterOverrides.set(r.id, r.poster);

  const result: Slide[] = [];
  const pending: Job[] = [];
  const resolved = new Map<string, Res>();
  for (const rel of stills) {
    const e = byRel.get(rel)!, m = metas.get(rel)!;
    const vid = pairOf.get(rel) ?? null;
    const r = resolveDate(rel, m, e, vid ? { rel: vid, m: metas.get(vid)! } : undefined);
    resolved.set(rel, r);
    let img = rel;
    if (m.kind === 'heic' && HEIC_CONVERTER) {
      const safe = rel.slice(0, -e.ext.length).replaceAll('/', '__') + '.jpg';
      img = `_converted/${safe}`;
      const dst = path.join(CONVERTED, safe);
      if (!derivedFresh(safe, e.mtimeMs)) pending.push({ dst, rel, work: () => convertHeic(e.abs, dst) });
    }
    result.push({ id: rel, img, vid, d: r.d, dateSource: r.src, dateConfidence: r.conf });
  }
  for (const rel of solos) {
    const e = byRel.get(rel)!, m = metas.get(rel)!;
    if (!TOOLS.ffmpeg) { newSkipped.push({ id: rel, reason: 'ffmpeg is not installed, so no poster frame can be made' }); continue; }
    const r = resolveDate(rel, m, e);
    resolved.set(rel, r);
    const poster = posterFor(rel);
    if (!derivedFresh(path.basename(poster.abs), 0)) {
      pending.push({
        dst: poster.abs, rel,
        work: async () => {
          let t = posterOverrides.get(rel);
          if (t == null) t = Math.round(((m.s.dur ?? (await probeDuration(e.abs))) / 2) * 10) / 10; // middle frame
          return (await extractPoster(e.abs, poster.abs, t)) ? null : "couldn't decode a frame from this video (corrupt?)";
        },
      });
    }
    result.push({ id: rel, img: poster.rel, vid: rel, d: r.d, solo: true, dateSource: r.src, dateConfidence: r.conf });
  }

  // 3. Persist new metadata and prune rows for files that are gone.
  const live = new Set(entries.map(e => e.rel));
  db.transaction(() => {
    const upsert = db.query(
      `INSERT INTO exif_cache (path, sig, d, ver, meta) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(path) DO UPDATE SET sig = ?2, d = ?3, ver = ?4, meta = ?5`,
    );
    for (const e of stale) upsert.run(e.rel, e.sig, resolved.get(e.rel)?.d ?? '', META_VER, JSON.stringify(metas.get(e.rel)));
    const del = db.query('DELETE FROM exif_cache WHERE path = ?');
    for (const p of cache.keys()) if (!live.has(p)) del.run(p);
  })();

  result.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : a.id < b.id ? -1 : 1));
  slides = result;
  skipped = newSkipped;
  // Queue conversions in show order so the first slides are ready first.
  const order = new Map(result.map((s, i) => [s.id, i]));
  pending.sort((a, b) => (order.get(a.rel) ?? 0) - (order.get(b.rel) ?? 0));
  for (const j of pending) enqueue(j);

  lastScan = { ms: Math.round(performance.now() - t0), files: entries.length, probed: stale.length };
  if (newSkipped.length) {
    console.log(`Skipped ${newSkipped.length} file${newSkipped.length === 1 ? '' : 's'}:`);
    for (const s of newSkipped.slice(0, 25)) console.log(`  ${s.id}: ${s.reason}`);
    if (newSkipped.length > 25) console.log(`  …and ${newSkipped.length - 25} more (see /api/slides "skipped")`);
  }
  const unsure = result.filter(s => s.dateConfidence === 'low').length;
  if (unsure) console.log(`${unsure} slide${unsure === 1 ? ' has' : 's have'} a low-confidence date — check them in the Library.`);
  if (pending.length) console.log(`Converting ${pending.length} HEIC/video poster${pending.length === 1 ? '' : 's'} in the background…`);
}

// Scans are serialised; a failure keeps the previous slide list.
let scanChain: Promise<void> = Promise.resolve();
function rescan(): Promise<void> {
  const p = scanChain.then(scan).catch(err => { console.error('scan failed:', err); });
  scanChain = p;
  return p;
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

const ingestStatus = () => ({
  pending: jobs.size, done: jobsDone, spawns: spawnCount, scanMs: lastScan.ms, files: lastScan.files, probed: lastScan.probed,
});

async function serveStatic(urlPath: string, req: Request): Promise<Response> {
  const full = path.normalize(path.join(ROOT, urlPath));
  if (!full.startsWith(ROOT + path.sep)) return new Response('Forbidden', { status: 403 });
  if (/\.(db|db-wal|db-shm|ts)$/.test(full)) return new Response('Forbidden', { status: 403 });
  await awaitDerived(full); // a HEIC copy / poster still being generated
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

// 400px thumbnail: sips on macOS, ffmpeg elsewhere (honouring EXIF rotation).
async function makeThumb(srcAbs: string, thumbAbs: string, orient?: number): Promise<boolean> {
  const tmp = partPath(thumbAbs);
  let cmd: string[] | null = null;
  if (TOOLS.sips) cmd = [TOOLS.sips, '-Z', '400', srcAbs, '--out', tmp];
  else if (TOOLS.ffmpeg && !/\.hei[cf]$/i.test(srcAbs)) {
    const rot: Record<number, string> = { 2: 'hflip,', 3: 'hflip,vflip,', 4: 'vflip,', 5: 'transpose=0,', 6: 'transpose=1,', 7: 'transpose=3,', 8: 'transpose=2,' };
    const vf = `${rot[orient ?? 1] ?? ''}scale=400:400:force_original_aspect_ratio=decrease`;
    cmd = [TOOLS.ffmpeg, '-v', 'error', '-y', '-noautorotate', '-i', srcAbs, '-frames:v', '1', '-vf', vf, '-q:v', '4', tmp];
  }
  if (!cmd) return false;
  const { code } = await run(cmd, { timeoutMs: 60_000 });
  if (code !== 0 || !existsSync(tmp)) { try { unlinkSync(tmp); } catch {} return false; }
  renameSync(tmp, thumbAbs);
  return true;
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
  const stem = name.slice(0, -ext.length) || 'upload';
  let dest: string;

  if (isVideo) {
    // land the raw bytes, then keep as-is only if it's already browser-friendly
    // (H.264 in MP4); everything else is transcoded via ffmpeg
    const tmp = path.join(UPLOADS, `.incoming-${Date.now()}${ext}`);
    await Bun.write(tmp, await req.arrayBuffer());
    const codec = await probeVideoCodec(tmp);
    if (!codec) {
      unlinkSync(tmp);
      return json({ ok: false, error: TOOLS.ffprobe ? 'Not a readable video file.' : 'ffmpeg is not installed, so videos can’t be added.' }, 415);
    }
    if (ext === '.mp4' && codec === 'h264') {
      dest = freeDest(stem, '.mp4');
      renameSync(tmp, dest);
    } else {
      dest = freeDest(stem, '.mp4');
      // Keep the capture date: copy container metadata, including Apple's
      // com.apple.quicktime.creationdate (needs use_metadata_tags).
      const { code } = await run(
        [TOOLS.ffmpeg ?? 'ffmpeg', '-y', '-i', tmp, '-map_metadata', '0', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
         '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart+use_metadata_tags', dest],
      );
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

  await rescan();
  const id = `uploads/${path.basename(dest)}`;
  const skip = skipped.find(s => s.id === id);
  if (skip) {
    try { unlinkSync(dest); } catch {} // our own copy of a bad upload; nothing to keep
    await rescan();
    return json({ ok: false, error: `${name}: ${skip.reason}` }, 415);
  }
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

logMissingTools();
await rescan();

let server;
try {
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: PORT,
    maxRequestBodySize: MAX_UPLOAD, // Bun's default is 128 MB — too small for phone videos
    idleTimeout: 120,
    async fetch(req) {
      const url = new URL(req.url);
      let p: string;
      try { p = decodeURIComponent(url.pathname); } catch { return new Response('Bad request', { status: 400 }); }

      if (req.method === 'GET') {
        if (p === '/' || p === '/index.html') return new Response(Bun.file(path.join(APP_DIR, 'index.html')));
        if (p === '/api/slides') {
          return json({ slides, overrides: allOverrides(), settings: allSettings(), skipped, ingest: ingestStatus() });
        }
        if (p === '/api/ingest') return json(ingestStatus());
        if (p === '/api/thumb') {
          const slide = slides.find(s => s.id === url.searchParams.get('id'));
          if (!slide) return new Response('Not found', { status: 404 });
          const srcAbs = path.join(ROOT, slide.img);
          await awaitDerived(srcAbs);
          if (!existsSync(srcAbs)) return new Response('Not found', { status: 404 });
          const thumbsDir = path.join(CONVERTED, '_thumbs');
          mkdirSync(thumbsDir, { recursive: true });
          const thumbAbs = path.join(thumbsDir, 'thumb__' + slide.img.replaceAll('/', '__').replace(/\.[^.]+$/, '') + '.jpg');
          const stale = !existsSync(thumbAbs) || statSync(thumbAbs).mtimeMs < statSync(srcAbs).mtimeMs;
          if (stale) {
            const row = slide.img === slide.id
              ? db.query('SELECT meta FROM exif_cache WHERE path = ?').get(slide.id) as { meta: string } | null : null;
            let orient: number | undefined;
            try { orient = row ? (JSON.parse(row.meta) as Meta).s.orient : undefined; } catch {}
            const ok = await thumbLimit(() => makeThumb(srcAbs, thumbAbs, orient));
            if (!ok) return serveStatic('/' + slide.img, req);
          }
          return new Response(Bun.file(thumbAbs), { headers: { 'Cache-Control': 'no-cache' } });
        }
        return serveStatic(p, req);
      }
      if (req.method === 'POST') {
        try {
          if (p === '/api/upload') {
            const name = url.searchParams.get('name') ?? '?';
            const mb = (Number(req.headers.get('content-length') ?? 0) / 1048576).toFixed(1);
            console.log(`upload: ${name} (${mb} MB)`);
            return await handleUpload(req, url);
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
            await awaitDerived(poster.abs);
            const okExtract = await extractPoster(path.join(ROOT, slide.vid), poster.abs, Number(time) || 0);
            if (!okExtract) return json({ ok: false, error: 'Frame extraction failed.' }, 500);
            applyPatch(id, { poster: Math.round((Number(time) || 0) * 100) / 100 });
            return json({ ok: true });
          }
          if (p === '/api/remove-upload') {
            const { id } = await req.json();
            const res = removeUpload(id);
            if (res.status === 200) await rescan();
            return res;
          }
          if (p === '/api/rescan') {
            await rescan();
            return json({ ok: true, count: slides.length, skipped: skipped.length });
          }
        } catch (err) {
          console.error(`${p} failed:`, err);
          return json({ ok: false, error: String(err) }, 500);
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

const paired = slides.filter(s => s.vid && !s.solo).length;
console.log(`Slideshow ready: http://127.0.0.1:${PORT} — ${slides.length} slides (${paired} with Live Photo video)`);
if (process.argv.includes('--open')) Bun.spawn(['open', `http://127.0.0.1:${PORT}`]);
