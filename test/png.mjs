// Minimal PNG decoder (8-bit, non-interlaced — what Chromium's screenshots
// and screencast emit) so the harness needs no dependencies.
import { inflateSync } from 'node:zlib';

// -> { w, h, rowLum(y) -> Float32Array of per-pixel luminance for row y }
export function decodePng(buf) {
  let off = 8, w = 0, h = 0, ct = 6;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct] ?? 4;
  const stride = w * bpp;
  const lum = new Float32Array(w * h);
  let prev = new Uint8Array(stride), cur = new Uint8Array(stride), p = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[p++];
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let v = raw[p++];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      const i = x * bpp;
      lum[y * w + x] = bpp >= 3 ? 0.2126 * cur[i] + 0.7152 * cur[i + 1] + 0.0722 * cur[i + 2] : cur[i];
    }
    [prev, cur] = [cur, prev];
  }
  return { w, h, lum };
}

// mean luminance and the fraction of pixels brighter than `dark`
export function pngStats(buf, dark = 40) {
  const { w, h, lum } = decodePng(buf);
  let sum = 0, nd = 0;
  for (let i = 0; i < lum.length; i++) { sum += lum[i]; if (lum[i] > dark) nd++; }
  return { lum: sum / (w * h), nd: nd / (w * h) };
}
