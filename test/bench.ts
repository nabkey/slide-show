// Cold-scan / warm-restart benchmark on a synthetic 3,000-file library.
//
//   bun test/bench.ts                         # this server.ts
//   bun test/bench.ts --legacy old-server.ts  # a pre-refactor server.ts (it scans its own folder, port 8765)
//
// --legacy implies --flat (the old server didn't look in sub-folders). Off macOS a tiny `sips` stand-in (heif-convert + ffmpeg) is put on PATH for
// --legacy, since the old server hard-required sips.

import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateLibrary } from './fixtures';

const argOf = (f: string) => { const i = process.argv.indexOf(f); return i > 0 ? process.argv[i + 1] : undefined; };
const legacy = argOf('--legacy');
const total = Number(argOf('--files') ?? 3000);
const tmp = mkdtempSync(path.join(os.tmpdir(), 'slideshow-bench-'));
const lib = path.join(tmp, 'lib');
console.log('generating library…', generateLibrary(lib, total, process.argv.includes('--flat') || !!legacy));

const env: Record<string, string> = { ...process.env as Record<string, string> };
let cmd: string[];
let port = 18000 + Math.floor(Math.random() * 1000);
if (legacy) {
  copyFileSync(legacy, path.join(lib, 'server.ts'));
  copyFileSync(path.join(import.meta.dir, '..', 'index.html'), path.join(lib, 'index.html'));
  cmd = ['bun', path.join(lib, 'server.ts')];
  port = 8765;
  if (!Bun.which('sips')) {
    const shim = path.join(tmp, 'bin');
    mkdirSync(shim);
    writeFileSync(path.join(shim, 'sips'), `#!/bin/sh
if [ "$1" = "-s" ]; then exec heif-convert -q 85 "$7" "$9" >/dev/null 2>&1; fi
if [ "$1" = "-Z" ]; then exec ffmpeg -v error -y -i "$3" -vf "scale=$2:$2:force_original_aspect_ratio=decrease" "$5"; fi
exit 1
`);
    chmodSync(path.join(shim, 'sips'), 0o755);
    env.PATH = `${shim}:${env.PATH}`;
  }
} else {
  cmd = ['bun', path.join(import.meta.dir, '..', 'server.ts'), '--dir', lib, '--port', String(port)];
}

async function boot() {
  const t0 = performance.now();
  const proc = Bun.spawn(cmd, { env, stdout: 'ignore', stderr: 'ignore' });
  for (;;) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/slides`); if (r.ok) { await r.arrayBuffer(); break; } } catch {}
    if (proc.exitCode != null) throw new Error('server exited ' + proc.exitCode);
    await Bun.sleep(2);
  }
  return { proc, ms: performance.now() - t0, t0 };
}

const cold = await boot();
let coldDone = cold.ms;
if (!legacy) {
  for (;;) {
    const s = await (await fetch(`http://127.0.0.1:${port}/api/ingest`)).json() as any;
    if (s.pending === 0) break;
    await Bun.sleep(20);
  }
  coldDone = performance.now() - cold.t0;
}
cold.proc.kill(); await cold.proc.exited;
console.log(`cold: first /api/slides ${cold.ms.toFixed(0)} ms; all conversions done ${coldDone.toFixed(0)} ms`);
const warm: number[] = [];
for (let i = 0; i < 5; i++) {
  const w = await boot();
  w.proc.kill(); await w.proc.exited;
  warm.push(w.ms);
}
warm.sort((a, b) => a - b);
console.log(`warm: ${warm.map(x => x.toFixed(0)).join(', ')} ms (median ${warm[2].toFixed(0)})`);
rmSync(tmp, { recursive: true, force: true });
