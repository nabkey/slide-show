// Reproducible media fixtures with known ground-truth capture dates.
//
//   bun test/fixtures.ts <dir>     # generate into <dir> and print the manifest
//
// Everything is synthesised: JPEG/PNG pixels and videos with ffmpeg, EXIF
// written byte-by-byte by the tiny TIFF writer below (so no exiftool is needed
// to make the fixtures), HEIC via heif-enc (Linux) or sips (macOS), XMP via
// exiftool when present. Expected dates assume the server runs with
// TZ=America/New_York (TEST_TZ), which matters for the UTC-stored cases.
// Nothing here is committed media: .gitignore blocks it and it lives in a temp dir.

import { mkdirSync, utimesSync, writeFileSync, readFileSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';

export const TEST_TZ = 'America/New_York';

export type Fixture = {
  file: string;                 // path relative to the media root
  expect?: string;              // 'YYYY-MM-DD HH:MM' | 'YYYY-MM-DD' | 'YYYY' (local wall time)
  conf?: Array<'high' | 'medium' | 'low'>;
  pairedWith?: string;          // Live Photo video that must be attached to this still
  companion?: boolean;          // a Live Photo video: must NOT appear as its own slide
  solo?: boolean;               // standalone video slide
  skip?: RegExp;                // must be skipped with a reason matching this
  absent?: boolean;             // must be ignored entirely (inside a library bundle / thumbnail dir)
  converted?: boolean;          // served image must be a generated JPEG (HEIC)
  needs?: Array<'exiftool' | 'heic'>;  // generator prerequisites
  exiftoolOnly?: boolean;       // the date needs exiftool to read (HEIC/XMP); not checked in fallback mode
  category: string;
};

export const tools = {
  ffmpeg: !!Bun.which('ffmpeg'),
  exiftool: !!Bun.which('exiftool'),
  heifEnc: !!Bun.which('heif-enc'),
  sips: !!Bun.which('sips'),
};
const canHeic = () => tools.heifEnc || tools.sips;

// ---------- process helpers ----------

function sh(cmd: string[]) {
  const r = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(' ')}\n${r.stderr.toString()}`);
  return r.stdout.toString();
}
const ff = (...args: string[]) => sh(['ffmpeg', '-v', 'error', '-y', ...args]);

// ---------- a minimal EXIF (TIFF) writer ----------

export type ExifSpec = {
  make?: string; model?: string; software?: string; modify?: string; orientation?: number;
  dto?: string; dig?: string; offset?: string; subsec?: string;
  gps?: string; // 'YYYY:MM:DD HH:MM:SS' UTC
};
type Ent = { tag: number; type: number; count: number; data: Buffer };
const ascii = (tag: number, s: string): Ent => ({ tag, type: 2, count: s.length + 1, data: Buffer.from(s + '\0', 'latin1') });
const short = (tag: number, v: number): Ent => { const b = Buffer.alloc(2); b.writeUInt16BE(v); return { tag, type: 3, count: 1, data: b }; };
const long = (tag: number, v: number): Ent => { const b = Buffer.alloc(4); b.writeUInt32BE(v); return { tag, type: 4, count: 1, data: b }; };
const rationals = (tag: number, v: number[]): Ent => {
  const b = Buffer.alloc(8 * v.length);
  v.forEach((x, i) => { b.writeUInt32BE(x, i * 8); b.writeUInt32BE(1, i * 8 + 4); });
  return { tag, type: 5, count: v.length, data: b };
};
const ifdSize = (ents: Ent[]) => 2 + ents.length * 12 + 4 + ents.reduce((n, e) => n + (e.data.length > 4 ? e.data.length + (e.data.length & 1) : 0), 0);
function ifdBytes(ents: Ent[], at: number): Buffer {
  ents.sort((a, b) => a.tag - b.tag);
  const out = Buffer.alloc(ifdSize(ents));
  out.writeUInt16BE(ents.length, 0);
  let data = 2 + ents.length * 12 + 4;
  ents.forEach((e, i) => {
    const p = 2 + i * 12;
    out.writeUInt16BE(e.tag, p); out.writeUInt16BE(e.type, p + 2); out.writeUInt32BE(e.count, p + 4);
    if (e.data.length <= 4) e.data.copy(out, p + 8);
    else { out.writeUInt32BE(at + data, p + 8); e.data.copy(out, data); data += e.data.length + (e.data.length & 1); }
  });
  return out;
}
export function exifTiff(s: ExifSpec): Buffer {
  const ifd0: Ent[] = [];
  if (s.make) ifd0.push(ascii(0x010f, s.make));
  if (s.model) ifd0.push(ascii(0x0110, s.model));
  if (s.software) ifd0.push(ascii(0x0131, s.software));
  if (s.modify) ifd0.push(ascii(0x0132, s.modify));
  if (s.orientation) ifd0.push(short(0x0112, s.orientation));
  const exif: Ent[] = [];
  if (s.dto) exif.push(ascii(0x9003, s.dto));
  if (s.dig) exif.push(ascii(0x9004, s.dig));
  if (s.offset) exif.push(ascii(0x9011, s.offset), ascii(0x9010, s.offset));
  if (s.subsec) exif.push(ascii(0x9291, s.subsec));
  const gps: Ent[] = [];
  if (s.gps) {
    const [d, t] = s.gps.split(' ');
    gps.push(ascii(0x001d, d), rationals(0x0007, t.split(':').map(Number)));
  }
  // pointer entries are inline LONGs, so sizes are known before offsets
  if (exif.length) ifd0.push(long(0x8769, 0));
  if (gps.length) ifd0.push(long(0x8825, 0));
  const off0 = 8, offExif = off0 + ifdSize(ifd0), offGps = offExif + (exif.length ? ifdSize(exif) : 0);
  if (exif.length) ifd0.find(e => e.tag === 0x8769)!.data.writeUInt32BE(offExif);
  if (gps.length) ifd0.find(e => e.tag === 0x8825)!.data.writeUInt32BE(offGps);
  const head = Buffer.from([0x4d, 0x4d, 0, 42, 0, 0, 0, 8]);
  return Buffer.concat([head, ifdBytes(ifd0, off0), exif.length ? ifdBytes(exif, offExif) : Buffer.alloc(0), gps.length ? ifdBytes(gps, offGps) : Buffer.alloc(0)]);
}
// Insert an APP1/Exif segment right after SOI.
export function withExif(jpeg: Buffer, tiffOrRaw: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiffOrRaw]);
  const hdr = Buffer.from([0xff, 0xe1, 0, 0]);
  hdr.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), hdr, body, jpeg.subarray(2)]);
}

// ---------- base media ----------

export type Bases = { jpeg: Buffer; png: Buffer; work: string };
export function makeBases(work: string): Bases {
  mkdirSync(work, { recursive: true });
  const j = path.join(work, 'base.jpg'), p = path.join(work, 'base.png');
  ff('-f', 'lavfi', '-i', 'testsrc=size=640x480', '-frames:v', '1', '-q:v', '4', j);
  ff('-f', 'lavfi', '-i', 'testsrc2=size=320x240', '-frames:v', '1', p);
  // base video: H.264, 2 s, moov at the end (like a camera writes it)
  ff('-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '15', path.join(work, 'base.mp4'));
  return { jpeg: readFileSync(j), png: readFileSync(p), work };
}

function heicFrom(jpegPath: string, out: string) {
  if (tools.heifEnc) sh(['heif-enc', '-q', '40', jpegPath, '-o', out]);
  else sh(['sips', '-s', 'format', 'heic', jpegPath, '--out', out]);
}

// Remux the base video with container metadata (fast, no re-encode).
function video(b: Bases, out: string, meta: Record<string, string>, opts: { streamHandler?: string; mov?: boolean; faststart?: boolean } = {}) {
  const args = ['-i', path.join(b.work, 'base.mp4'), '-c', 'copy', '-map_metadata', '-1'];
  for (const [k, v] of Object.entries(meta)) args.push('-metadata', `${k}=${v}`);
  if (opts.streamHandler) args.push('-metadata:s:v', `handler_name=${opts.streamHandler}`);
  const flags = ['use_metadata_tags', ...(opts.faststart ? ['faststart'] : [])];
  args.push('-movflags', '+' + flags.join('+'));
  if (opts.mov) args.push('-f', 'mov');
  args.push(out);
  ff(...args);
}

const localMs = (s: string) => new Date(s).getTime(); // parsed in the generator's TZ (set to TEST_TZ)
const GARBAGE_MTIME = '2025-09-30T23:15:00'; // "copied the night before": misleading on purpose

// ---------- the fixture set ----------

export function generateFixtures(root: string, opts: { only?: string[] } = {}): Fixture[] {
  if (process.env.TZ !== TEST_TZ) throw new Error(`run with TZ=${TEST_TZ}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const work = path.join(root, '..', path.basename(root) + '-work');
  const b = makeBases(work);
  const list: Fixture[] = [];
  const abs = (rel: string) => { const p = path.join(root, rel); mkdirSync(path.dirname(p), { recursive: true }); return p; };
  const touch = (rel: string, when = GARBAGE_MTIME) => { const t = localMs(when) / 1000; utimesSync(abs(rel), t, t); };
  const add = (f: Fixture, mtime?: string) => {
    if (f.needs?.includes('exiftool') && !tools.exiftool) return false;
    if (f.needs?.includes('heic') && !canHeic()) return false;
    list.push(f);
    return true;
  };
  const jpg = (rel: string, exif: ExifSpec | null, f: Omit<Fixture, 'file'>, mtime = GARBAGE_MTIME) => {
    if (!add({ ...f, file: rel })) return;
    writeFileSync(abs(rel), exif ? withExif(b.jpeg, exifTiff(exif)) : b.jpeg);
    touch(rel, mtime);
  };
  const png = (rel: string, f: Omit<Fixture, 'file'>, mtime = GARBAGE_MTIME) => {
    if (!add({ ...f, file: rel })) return;
    writeFileSync(abs(rel), b.png);
    touch(rel, mtime);
  };
  const heic = (rel: string, exif: ExifSpec, f: Omit<Fixture, 'file'>) => {
    if (!add({ ...f, file: rel, needs: [...(f.needs ?? []), 'heic'], exiftoolOnly: true, converted: true })) return;
    const tmp = path.join(work, 'h-' + path.basename(rel) + '.jpg');
    writeFileSync(tmp, withExif(b.jpeg, exifTiff(exif)));
    heicFrom(tmp, abs(rel));
    touch(rel);
  };
  const vid = (rel: string, meta: Record<string, string>, f: Omit<Fixture, 'file'>, o: Parameters<typeof video>[3] = {}) => {
    if (!add({ ...f, file: rel })) return;
    video(b, abs(rel), meta, { mov: /\.mov$/i.test(rel), ...o });
    touch(rel);
  };
  const raw = (rel: string, bytes: Buffer | string, f: Omit<Fixture, 'file'>) => {
    if (!add({ ...f, file: rel })) return;
    writeFileSync(abs(rel), bytes);
    touch(rel);
  };

  // --- iPhone: HEIC, Live Photos, standalone MOV ---
  heic('iphone/IMG_0001.HEIC', { make: 'Apple', model: 'iPhone 13', dto: '2021:12:31 23:59:10', offset: '+09:00', subsec: '512' },
    { category: 'iphone heic (Tokyo, +09:00)', expect: '2021-12-31 23:59', conf: ['high'] });
  heic('iphone/IMG_0002.HEIC', { make: 'Apple', model: 'iPhone XS', dto: '2019:06:15 14:05:33', offset: '-07:00' },
    { category: 'live photo still', expect: '2019-06-15 14:05', pairedWith: 'iphone/IMG_0002.MOV', conf: ['high'] });
  vid('iphone/IMG_0002.MOV', {
    creation_time: '2019-06-15T21:05:33Z', 'com.apple.quicktime.creationdate': '2019-06-15T14:05:33-0700',
    'com.apple.quicktime.make': 'Apple', 'com.apple.quicktime.content.identifier': 'A1B2-0002',
  }, { category: 'live photo video', companion: true, needs: canHeic() ? [] : ['heic'] });
  // stripped photo (shared via a messenger) still next to its untouched video; the
  // video only carries QuickTime UTC time — on the night US clocks spring forward
  jpg('iphone/IMG_0003.JPG', null, { category: 'live photo, stripped still + QuickTime UTC video (DST night)', expect: '2018-03-11 01:30', pairedWith: 'iphone/IMG_0003.MOV' });
  vid('iphone/IMG_0003.MOV', { creation_time: '2018-03-11T06:30:00Z', 'com.apple.quicktime.make': 'Apple' }, { category: 'live photo video', companion: true });
  vid('iphone/IMG_0004.MOV', {
    creation_time: '2017-08-20T07:12:00Z', 'com.apple.quicktime.creationdate': '2017-08-20T09:12:00+0200', 'com.apple.quicktime.make': 'Apple',
  }, { category: 'iphone video abroad (Keys CreationDate +02:00)', expect: '2017-08-20 09:12', solo: true, conf: ['high'] });
  // Google Takeout style pair: .jpg + .mp4
  jpg('takeout/IMG_0006.jpg', { make: 'Apple', dto: '2015:12:25 08:00:00' }, { category: 'live photo jpg+mp4 (Takeout)', expect: '2015-12-25 08:00', pairedWith: 'takeout/IMG_0006.mp4' });
  vid('takeout/IMG_0006.mp4', { creation_time: '2015-12-25T13:00:00Z' }, { category: 'live photo video', companion: true });
  // iPhone "Most Compatible" off + renamed: HEIC bytes with a .jpg name
  heic('IMG_5000.jpg', { make: 'Apple', dto: '2022:02:22 22:22:22', offset: '-05:00' }, { category: 'HEIC content with .jpg extension', expect: '2022-02-22 22:22' });

  // --- Android / Pixel / Samsung ---
  jpg('android/PXL_20200704_013000123.jpg', { make: 'Google', model: 'Pixel 4a', dto: '2020:07:03 21:30:00', offset: '-04:00' },
    { category: 'pixel photo (UTC filename, EXIF local)', expect: '2020-07-03 21:30', conf: ['high'] });
  jpg('android/PXL_20200801_160000456.jpg', null, { category: 'pixel photo, EXIF stripped (UTC filename)', expect: '2020-08-01 12:00' });
  vid('android/PXL_20200704_020000789.mp4', { creation_time: '2020-07-04T02:00:00Z', 'com.android.version': '11' },
    { category: 'pixel video (QuickTime UTC)', expect: '2020-07-03 22:00', solo: true });
  jpg('android/IMG_20160501_101500.jpg', null, { category: 'android filename, no EXIF', expect: '2016-05-01 10:15', conf: ['high'] });
  vid('android/VID_20160501_103000.mp4', { creation_time: '2016-05-01T14:30:00Z', 'com.android.version': '6.0' },
    { category: 'android VID_ filename vs QuickTime UTC', expect: '2016-05-01 10:30', solo: true });
  jpg('android/20170910_153045.jpg', { make: 'samsung', model: 'SM-G950F', dto: '2017:09:10 15:30:45' }, { category: 'samsung photo', expect: '2017-09-10 15:30' });
  vid('android/MOV_0042.mp4', { creation_time: '2020-01-01T03:15:00Z', 'com.android.version': '10' },
    { category: 'android video, QuickTime UTC crosses midnight (NYE)', expect: '2019-12-31 22:15', solo: true });

  // --- messaging apps ---
  jpg('whatsapp/IMG-20190601-WA0003.jpg', null, { category: 'whatsapp (date only, garbage mtime)', expect: '2019-06-01' });
  jpg('whatsapp/IMG-20190601-WA0004.jpg', null, { category: 'whatsapp (date + same-day mtime)', expect: '2019-06-01 18:22' }, '2019-06-01T18:22:00');
  vid('whatsapp/VID-20190602-WA0001.mp4', {}, { category: 'whatsapp video, zero QuickTime date', expect: '2019-06-02', solo: true });
  vid('whatsapp/VID-20190602-WA0002.mp4', { creation_time: '1970-01-01T00:00:00Z' }, { category: 'whatsapp video, 1970 epoch date', expect: '2019-06-02', solo: true });
  jpg('whatsapp/WhatsApp Image 2020-02-14 at 19.45.12.jpeg', null, { category: 'whatsapp desktop export', expect: '2020-02-14 19:45' });
  jpg('signal-2022-02-03-221530.jpg', null, { category: 'signal (old)', expect: '2022-02-03 22:15' });
  jpg('signal-2023-04-05-10-11-12-123.jpg', null, { category: 'signal (new)', expect: '2023-04-05 10:11' });
  jpg('photo_2021-09-10_08-30-00.jpg', null, { category: 'telegram', expect: '2021-09-10 08:30' });
  jpg('FB_IMG_1559389636123.jpg', null, { category: 'facebook save (unix ms)', expect: '2019-06-01 07:47', conf: ['low'] });

  // --- screenshots ---
  png('screens/Screenshot 2019-03-05 at 14.22.01.png', { category: 'macOS screenshot', expect: '2019-03-05 14:22' });
  png('screens/Screen Shot 2015-11-20 at 9.05.33 PM.png', { category: 'old macOS screenshot (12h)', expect: '2015-11-20 21:05' });
  png('screens/Screenshot 2023-10-01 at 8.15.30 PM.png', { category: 'macOS 14 screenshot (U+202F before PM)', expect: '2023-10-01 20:15' });
  png('screens/Screenshot_20180101-000501.png', { category: 'android screenshot', expect: '2018-01-01 00:05' });
  png('screens/Screenshot from 2021-05-06 07-08-09.png', { category: 'GNOME screenshot', expect: '2021-05-06 07:08' });
  vid('screens/Screen Recording 2020-06-01 at 10.00.00.mov', {}, { category: 'macOS screen recording, no metadata', expect: '2020-06-01 10:00', solo: true });

  // --- scanned prints: EXIF holds the scan date ---
  const scan = { make: 'EPSON', model: 'FastFoto FF-680W', dto: '2021:03:01 10:00:00', dig: '2021:03:01 10:00:00', modify: '2021:03:01 10:00:00' };
  jpg('scans/1987-07-04 Grandma picnic.jpg', scan, { category: 'scan, date in filename', expect: '1987-07-04' });
  jpg('scans/1992 Christmas/scan_0042.jpg', { ...scan, dto: '2021:03:01 10:02:00', dig: '2021:03:01 10:02:00', modify: '2021:03:01 10:02:00' }, { category: 'scan, year in folder name', expect: '1992', conf: ['low'] });
  jpg('scans/scan_0043.jpg', { ...scan, dto: '1995:08:12 12:00:00', dig: '2021:03:01 10:05:00', modify: '2021:03:01 10:05:00' }, { category: 'scan, date entered in scanner app', expect: '1995-08-12 12:00' });
  jpg('scans/scan_0099.jpg', { ...scan, dto: '2021:03:01 10:09:00', dig: '2021:03:01 10:09:00', modify: '2021:03:01 10:09:00' }, { category: 'scan, no clue (flagged low)', expect: '2021-03-01 10:09', conf: ['low'] });
  jpg('Christmas 1998.jpg', null, { category: 'year in filename', expect: '1998', conf: ['low'] });
  jpg('Party_2003_042.jpg', null, { category: 'year in a numbered filename', expect: '2003', conf: ['low'] });
  // derivatives inside a Photos library bundle / Synology thumbnail folder are not photos to show
  jpg('Old Library.photoslibrary/resources/derivatives/A1B2C3.jpg', { dto: '2012:01:01 10:00:00' }, { category: 'inside a .photoslibrary bundle', absent: true });
  jpg('@eaDir/IMG_0001.JPG/SYNOPHOTO_THUMB_XL.jpg', { dto: '2012:01:01 10:00:00' }, { category: 'Synology thumbnail dir', absent: true });

  // --- dedicated cameras ---
  jpg('dslr/DSC_0042.JPG', { make: 'NIKON CORPORATION', model: 'NIKON D90', dto: '2010:10:10 10:10:10', subsec: '50' }, { category: 'DSLR photo', expect: '2010-10-10 10:10', conf: ['high'] });
  vid('dslr/MVI_1234.MOV', { creation_time: '2012-05-05T17:45:00Z', make: 'Canon', model: 'Canon EOS 5D Mark II' },
    { category: 'Canon MOV (local time in QuickTime CreateDate)', expect: '2012-05-05 17:45', solo: true });
  vid('gopro/GX010042.MP4', { creation_time: '2019-08-15T16:20:00Z' }, { category: 'GoPro (local time in QuickTime CreateDate)', expect: '2019-08-15 16:20', solo: true }, { streamHandler: 'GoPro AVC' });
  jpg('dslr/DSCN0001.JPG', { make: 'NIKON', model: 'COOLPIX AW120', dto: '2000:01:01 00:03:12', gps: '2014:06:01 16:00:00' },
    { category: 'camera clock reset to 2000-01-01, GPS knows better', expect: '2014-06-01 12:00' });

  // --- timezones / GPS ---
  jpg('trip/IMG_0100.JPG', { make: 'Apple', dto: '2018:08:01 03:00:00', offset: '+10:00', gps: '2018:07:31 17:00:00' },
    { category: 'travel photo +10:00 (stay in local wall time)', expect: '2018-08-01 03:00', conf: ['high'] });
  jpg('gps_only.jpg', { make: 'Apple', gps: '2016:02:29 23:59:00' }, { category: 'GPS timestamp only (UTC)', expect: '2016-02-29 18:59' });

  // --- XMP-only (written with exiftool) ---
  if (add({ file: 'lightroom export.jpg', category: 'XMP DateCreated only', expect: '2014-02-14 20:00', needs: ['exiftool'], exiftoolOnly: true })) {
    writeFileSync(abs('lightroom export.jpg'), b.jpeg);
    sh(['exiftool', '-q', '-overwrite_original', '-XMP-photoshop:DateCreated=2014:02:14 20:00:00', abs('lightroom export.jpg')]);
    touch('lightroom export.jpg');
  }

  // --- no metadata at all ---
  jpg('party.jpg', null, { category: 'no metadata: file time', expect: '2015-05-05 12:00', conf: ['low'] }, '2015-05-05T12:00:00');
  jpg('2005/beach.jpg', null, { category: 'year in folder name', expect: '2005', conf: ['low'] });
  jpg('IMG_1998.JPG', null, { category: 'camera counter is not a year', expect: '2011-01-01 09:00', conf: ['low'] }, '2011-01-01T09:00:00');

  // --- awkward filenames ---
  jpg('Grand-mère\'s "80th" party 🎂 #1.jpg', { dto: '2009:09:09 09:09:09' }, { category: 'unicode, quotes, #', expect: '2009-09-09 09:09' });
  jpg('-rf.jpg', { dto: '2008:08:08 08:08:08' }, { category: 'leading dash', expect: '2008-08-08 08:08' });
  jpg('100% & more?.jpg', { dto: '2007:07:07 07:07:07' }, { category: '% & ?', expect: '2007-07-07 07:07' });

  // --- broken files: skipped with a reason, never a crash ---
  const full = withExif(b.jpeg, exifTiff({ dto: '2013:01:01 00:00:00' }));
  raw('broken/empty.jpg', '', { category: 'zero bytes', skip: /empty/ });
  raw('broken/fake.jpg', '<!doctype html><html><body>404 Not Found</body></html>\n', { category: 'HTML saved as .jpg', skip: /not a real JPG/ });
  raw('broken/fake.mp4', 'just some notes\n', { category: 'text saved as .mp4', skip: /not a real MP4/ });
  raw('broken/random.mov', Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7919 + 13) & 0xff)), { category: 'random bytes .mov', skip: /not a real MOV|corrupt/ });
  raw('broken/truncated.jpg', full.subarray(0, Math.floor(full.length * 0.6)), { category: 'truncated JPEG', skip: /truncated/i });
  png('broken/truncated.png', { category: 'truncated PNG', skip: /truncated/i });
  if (list.at(-1)?.file === 'broken/truncated.png') writeFileSync(abs('broken/truncated.png'), b.png.subarray(0, Math.floor(b.png.length / 2)));
  const baseVid = readFileSync(path.join(work, 'base.mp4'));
  raw('broken/truncated.mp4', baseVid.subarray(0, Math.floor(baseVid.length * 0.7)), { category: 'truncated MP4 (moov lost)', skip: /incomplete|truncated/ });
  if (add({ file: 'broken/truncated_faststart.mp4', category: 'truncated MP4 (faststart, mdat cut)', skip: /truncated/ })) {
    const fs = path.join(work, 'fast.mp4');
    video(b, fs, {}, { faststart: true });
    const bytes = readFileSync(fs);
    writeFileSync(abs('broken/truncated_faststart.mp4'), bytes.subarray(0, Math.floor(bytes.length * 0.6)));
  }
  if (add({ file: 'broken/truncated.heic', category: 'truncated HEIC', skip: /truncated|corrupt/, needs: ['heic'] })) {
    const h = path.join(work, 't.heic');
    writeFileSync(path.join(work, 't.jpg'), b.jpeg);
    heicFrom(path.join(work, 't.jpg'), h);
    const bytes = readFileSync(h);
    writeFileSync(abs('broken/truncated.heic'), bytes.subarray(0, Math.floor(bytes.length * 0.5)));
  }
  raw('broken/scan.tif', 'II*\0', { category: 'unsupported format', skip: /unsupported/ });
  // A valid image with a garbage EXIF block (bad offsets): shown, falls back to file time.
  if (add({ file: 'broken/garbage_exif.jpg', category: 'garbage EXIF offsets', expect: '2013-03-03 13:13', conf: ['low'] })) {
    const junk = Buffer.concat([Buffer.from([0x4d, 0x4d, 0, 42, 0xff, 0xff, 0xff, 0x00]), Buffer.alloc(64, 0xee)]);
    writeFileSync(abs('broken/garbage_exif.jpg'), withExif(b.jpeg, junk));
    touch('broken/garbage_exif.jpg', '2013-03-03T13:13:00');
  }

  rmSync(work, { recursive: true, force: true });
  return opts.only ? list.filter(f => opts.only!.includes(f.file)) : list;
}

// ---------- a large library for timing ----------

// 3,000 files: JPEGs with distinct EXIF dates, HEICs, Live Photo pairs and
// standalone clips, in a few sub-folders. Generated in-process (fast).
export function generateLibrary(root: string, total = 3000, flat = false) {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const work = path.join(root, '..', path.basename(root) + '-work');
  const b = makeBases(work);
  const heicOk = canHeic();
  let heicBytes: Buffer | null = null;
  if (heicOk) {
    const t = path.join(work, 'l.jpg');
    writeFileSync(t, withExif(b.jpeg, exifTiff({ make: 'Apple', dto: '2020:01:01 10:00:00' })));
    heicFrom(t, path.join(work, 'l.heic'));
    heicBytes = readFileSync(path.join(work, 'l.heic'));
  }
  const mp4 = readFileSync(path.join(work, 'base.mp4'));
  const nHeic = heicOk ? 200 : 0, nPairs = 100, nSolo = 100;
  const nJpeg = total - nHeic - nPairs * 2 - nSolo;
  const t0 = Date.UTC(2004, 0, 1);
  const stamp = (i: number) => {
    const d = new Date(t0 + i * 2.1e8);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}:${p(d.getUTCMonth() + 1)}:${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  };
  for (let i = 0; i < nJpeg; i++) {
    const dir = flat ? root : path.join(root, `year-${2004 + (i % 20)}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `IMG_${String(i).padStart(5, '0')}.JPG`), withExif(b.jpeg, exifTiff({ make: 'Canon', dto: stamp(i) })));
  }
  const phone = flat ? root : path.join(root, 'phone'), clips = flat ? root : path.join(root, 'clips');
  mkdirSync(phone, { recursive: true });
  mkdirSync(clips, { recursive: true });
  for (let i = 0; i < nHeic; i++) writeFileSync(path.join(phone, `IMG_H${String(i).padStart(4, '0')}.HEIC`), heicBytes!);
  for (let i = 0; i < nPairs; i++) {
    const still = heicBytes ?? withExif(b.jpeg, exifTiff({ make: 'Apple', dto: stamp(i * 3) }));
    writeFileSync(path.join(phone, `IMG_L${String(i).padStart(4, '0')}.${heicBytes ? 'HEIC' : 'JPG'}`), still);
    writeFileSync(path.join(phone, `IMG_L${String(i).padStart(4, '0')}.MOV`), mp4);
  }
  for (let i = 0; i < nSolo; i++) writeFileSync(path.join(clips, `VID_2019${String(1 + (i % 12)).padStart(2, '0')}10_12${String(Math.floor(i / 60)).padStart(2, '0')}${String(i % 60).padStart(2, '0')}.mp4`), mp4);
  rmSync(work, { recursive: true, force: true });
  return { total, nJpeg, nHeic, nPairs, nSolo };
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: TZ=America/New_York bun test/fixtures.ts <dir> [--library]'); process.exit(2); }
  if (process.argv.includes('--library')) console.log(generateLibrary(path.resolve(dir)));
  else {
    process.env.TZ ??= TEST_TZ;
    for (const f of generateFixtures(path.resolve(dir))) console.log(`${(f.expect ?? 'SKIP ' + f.skip).padEnd(18)} ${f.file}  — ${f.category}`);
  }
}
