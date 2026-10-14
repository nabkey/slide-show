// End-to-end library benchmark + regression run against the REAL server and UI.
//
//   node test/library-bench.mjs [--label after] [--regen] [--headed] [--keep]
//
// 1. builds ~3,000 fixture images (test/fixtures.mjs; cached in $TMPDIR/slideshow-library-bench)
// 2. copies the current server.ts + index.html next to them and boots `bun server.ts`
//    on a free port with a fresh slideshow.db
// 3. drives Chromium through Playwright: times opening the library, scrolling it,
//    toggling hide; runs a keyboard-only triage pass (when the UI supports it);
//    checks filters / edit modal / play-from-here / uploads / hidden tab / stage keys
// 4. verifies every override through the HTTP API, and writes screenshots plus a
//    JSON report to test/out/ (gitignored).
//
// Playwright is resolved from a local test/node_modules if present, else the
// global install; it is never a runtime dependency of the app.

import { execSync, spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureFixtures } from './fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const OUT = path.join(HERE, 'out');
const argv = process.argv.slice(2);
const flag = n => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const LABEL = opt('--label', 'run');
mkdirSync(OUT, { recursive: true });

// ---------- playwright ----------
async function loadPlaywright() {
  try { return await import('playwright'); } catch {}
  const req = createRequire(import.meta.url);
  const globalRoot = execSync('npm root -g').toString().trim();
  return req(req.resolve('playwright', { paths: [globalRoot] }));
}
const { chromium } = await loadPlaywright();

async function launch() {
  const opts = { headless: !flag('--headed'), args: ['--disable-renderer-backgrounding', '--disable-background-timer-throttling'] };
  try { return await chromium.launch(opts); }
  catch (e) { return chromium.launch({ ...opts, executablePath: '/opt/pw-browsers/chromium' }); }
}

// ---------- server ----------
async function bootServer(dir) {
  const port = 8800 + Math.floor(Math.random() * 900);
  for (const f of ['slideshow.db', 'slideshow.db-wal', 'slideshow.db-shm']) rmSync(path.join(dir, f), { force: true });
  rmSync(path.join(dir, '_converted'), { recursive: true, force: true });
  rmSync(path.join(dir, 'uploads'), { recursive: true, force: true });
  copyFileSync(path.join(REPO, 'index.html'), path.join(dir, 'index.html'));
  const srv = readFileSync(path.join(REPO, 'server.ts'), 'utf8').replace(/const PORT = [^;]+;/, `const PORT = ${port};`);
  writeFileSync(path.join(dir, 'server.ts'), srv);

  // macOS-only tools the server shells out to: shim sips (thumbnails) when absent.
  const shim = path.join(dir, '.bin');
  mkdirSync(shim, { recursive: true });
  let PATH = process.env.PATH;
  try { execSync('command -v sips', { stdio: 'ignore' }); } catch {
    // `sips -Z 400 src --out dst` → ffmpeg downscale (fixtures are already small)
    writeFileSync(path.join(shim, 'sips'),
      '#!/bin/sh\nsrc=""; dst=""\nwhile [ $# -gt 0 ]; do case "$1" in --out) dst="$2"; shift 2;; -Z|-s) shift 2;; formatOptions) shift 2;; *) src="$1"; shift;; esac; done\n' +
      'exec ffmpeg -v error -y -i "$src" -vf "scale=\'min(400,iw)\':-2" "$dst"\n');
    chmodSync(path.join(shim, 'sips'), 0o755);
    PATH = `${shim}:${PATH}`;
  }
  const t0 = Date.now();
  const proc = spawn('bun', ['server.ts'], { cwd: dir, env: { ...process.env, PORT: String(port), TZ: 'UTC', PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stdout.on('data', d => { log += d; });
  proc.stderr.on('data', d => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 600; i++) {
    if (/Slideshow ready/.test(log)) break;
    if (proc.exitCode != null) throw new Error('server exited:\n' + log);
    await new Promise(r => setTimeout(r, 100));
  }
  if (!/Slideshow ready/.test(log)) throw new Error('server did not start:\n' + log);
  console.log(`server: ${log.trim().split('\n').pop()} (boot ${Date.now() - t0} ms)`);
  return { proc, base, log: () => log };
}

// ---------- helpers ----------
const stats = arr => {
  const s = [...arr].sort((a, b) => a - b);
  const q = p => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, median: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), max: +s[s.length - 1].toFixed(1), mean: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(1) };
};
const results = { label: LABEL, date: new Date().toISOString(), checks: [], metrics: {} };
function check(name, ok, detail = '') {
  results.checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ' — ' + detail : ''}`);
}
const metric = (k, v) => { results.metrics[k] = v; console.log(`  ${k}: ${JSON.stringify(v)}`); };
const shot = async (page, name) => page.screenshot({ path: path.join(OUT, `${LABEL}-${name}.png`) });

// same ordering rule as the client: effective date, then id
const effDate = (s, ov) => (ov[s.id] && ov[s.id].date) || s.d;
async function apiState(base) {
  const data = await (await fetch(base + '/api/slides')).json();
  const order = [...data.slides].sort((a, b) => {
    const da = effDate(a, data.overrides), db = effDate(b, data.overrides);
    return da < db ? -1 : da > db ? 1 : a.id < b.id ? -1 : 1;
  });
  return { ...data, order };
}

// poll the API until pred(state) holds (writes may queue behind thumbnail loads)
async function eventually(base, pred, ms = 10000) {
  const t0 = Date.now();
  let st;
  do {
    st = await apiState(base);
    if (pred(st)) return st;
    await new Promise(r => setTimeout(r, 150));
  } while (Date.now() - t0 < ms);
  return st;
}

// in-page measurements wait on frames; never let a stalled page hang the run
const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out: ${label}`)), ms))]);

// time from a keydown (dispatched in-page) until the next frame is produced
const KEY_TO_PAINT = async (page, key, extra = {}) => withTimeout(page.evaluate(async ({ key, extra }) => {
  const t0 = performance.now();
  document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }));
  const sync = performance.now() - t0;
  await new Promise(r => requestAnimationFrame(() => { const c = new MessageChannel(); c.port1.onmessage = r; c.port2.postMessage(0); }));
  return { sync, paint: performance.now() - t0 };
}, { key, extra }), 20000, `key ${key}`);

const waitIdle = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => setTimeout(r, 50))));

// ---------- main ----------
const manifest = await ensureFixtures(opt('--dir'), { regen: flag('--regen') });
const server = await bootServer(manifest.dir);
const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'UTC' });
const page = await ctx.newPage();
page.setDefaultTimeout(30000);
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') pageErrors.push(m.text()); });

try {
  const tLoad = Date.now();
  await page.goto(server.base + '/');
  await page.waitForFunction(() => /\d+ \/ \d+/.test(document.getElementById('barCounter').textContent));
  metric('page_ready_ms', Date.now() - tLoad);
  const initial = await apiState(server.base);
  check('server lists all fixture items', initial.slides.length === manifest.count, `${initial.slides.length}/${manifest.count}`);

  // ===== 1. library open time =====
  console.log('\n[open] library with', initial.slides.length, 'items');
  const opens = [];
  for (let i = 0; i < 6; i++) {
    const r = await KEY_TO_PAINT(page, 'l');
    opens.push(r.paint);
    await page.waitForSelector('#library.open');
    await waitIdle(page);
    if (i === 0) { await page.waitForTimeout(800); await shot(page, 'library'); }
    await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await page.waitForTimeout(150);
  }
  metric('open_first_ms', +opens[0].toFixed(1));
  metric('open_ms', stats(opens.slice(1)));

  // ===== 2. scroll smoothness =====
  await page.keyboard.press('l');
  await page.waitForSelector('#library.open');
  await page.waitForTimeout(400);
  const domNodes = await page.evaluate(() => document.querySelectorAll('#libGrid *').length);
  metric('grid_dom_nodes', domNodes);
  const scrollRun = (pxPerFrame, frames) => withTimeout(page.evaluate(async ({ pxPerFrame, frames }) => {
    const g = document.getElementById('libGrid');
    g.scrollTop = 0;
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const d = [];
    let last = performance.now();
    for (let i = 0; i < frames; i++) {
      g.scrollTop += pxPerFrame;
      await new Promise(r => requestAnimationFrame(r));
      const now = performance.now();
      d.push(now - last);
      last = now;
    }
    return { d, reached: g.scrollTop, max: g.scrollHeight - g.clientHeight };
  }, { pxPerFrame, frames }), 60000, 'scroll');
  for (const [name, px, frames] of [['scroll_read', 40, 240], ['scroll_fling', 320, 220]]) {
    const r = await scrollRun(px, frames);
    const s = stats(r.d);
    const total = r.d.reduce((a, b) => a + b, 0);
    metric(name, { fps: +(1000 * r.d.length / total).toFixed(1), frame_ms: s, janky_over_25ms: r.d.filter(x => x > 25).length, of: r.d.length });
  }
  await page.evaluate(() => { document.getElementById('libGrid').scrollTop = 2400; });
  await page.waitForTimeout(600);
  await shot(page, 'library-scrolled');
  await page.evaluate(() => { document.getElementById('libGrid').scrollTop = 0; });
  await waitIdle(page);

  // ===== 3. hide-toggle latency with the mouse (exists in every version) =====
  const hideLat = [];
  for (let i = 0; i < 6; i++) {
    hideLat.push(await page.evaluate(async i => {
      const b = document.querySelectorAll('#libGrid .libHide')[i % 3];
      const t0 = performance.now();
      b.click();
      await new Promise(r => requestAnimationFrame(() => { const c = new MessageChannel(); c.port1.onmessage = r; c.port2.postMessage(0); }));
      return performance.now() - t0;
    }, i));
  }
  metric('hide_click_to_paint_ms', stats(hideLat));
  let st = await eventually(server.base, s => Object.values(s.overrides).every(o => !o.hidden));
  // each of the first 3 cards was toggled twice -> net nothing hidden
  check('mouse hide toggles round-trip through the API', Object.values(st.overrides).every(o => !o.hidden), `${Object.values(st.overrides).filter(o => o.hidden).length} hidden`);

  // ===== 4. keyboard-only triage (new library only) =====
  const hasTriage = await page.evaluate(() => typeof window.__lib === 'object');
  results.hasTriage = hasTriage;
  if (!hasTriage) {
    console.log('\n[triage] skipped: this build has no keyboard triage');
  } else {
    console.log('\n[triage] keyboard only');
    const tTriage = Date.now();
    await page.evaluate(() => {
      window.__evt = [];
      try {
        new PerformanceObserver(l => { for (const e of l.getEntries()) if (e.name === 'keydown') window.__evt.push(e.duration); })
          .observe({ type: 'event', durationThreshold: 16, buffered: false });
      } catch (e) {}
    });
    const cursor = () => page.evaluate(() => window.__lib.cursor());
    const press = async (k, n = 1) => { for (let i = 0; i < n; i++) await page.keyboard.press(k); };
    const settle = async () => { await page.evaluate(() => window.__lib.flush()); };

    // (a) 25 decisions from the top: X x4 then P, five times -> 20 hidden
    await press('Home');
    const startOrder = (await apiState(server.base)).order.map(s => s.id);
    check('Home puts the cursor on the first item', (await cursor()) === startOrder[0], await cursor());
    const keyTimes = [];
    const tKeys = Date.now();
    for (let i = 0; i < 25; i++) {
      const k0 = Date.now();
      await page.keyboard.press(i % 5 === 4 ? 'p' : 'x');
      keyTimes.push(Date.now() - k0);
    }
    metric('triage_25_keys_wall_ms', Date.now() - tKeys);
    check('cursor auto-advanced 25 items', (await cursor()) === startOrder[25], `${await cursor()} vs ${startOrder[25]}`);
    await settle();
    st = await apiState(server.base);
    const expectHidden = startOrder.slice(0, 25).filter((_, i) => i % 5 !== 4);
    const hiddenNow = Object.keys(st.overrides).filter(id => st.overrides[id].hidden);
    check('20 hides persisted via API, keeps did not hide', expectHidden.every(id => st.overrides[id]?.hidden) && hiddenNow.length === 20, `${hiddenNow.length} hidden`);
    // fast arrow navigation timing (in-page, key->paint)
    const nav = [];
    for (let i = 0; i < 30; i++) nav.push((await KEY_TO_PAINT(page, i % 6 < 3 ? 'ArrowDown' : 'ArrowRight')).paint);
    metric('arrow_key_to_paint_ms', stats(nav));
    const hk = [];
    for (let i = 0; i < 10; i++) hk.push((await KEY_TO_PAINT(page, 'x')).paint);
    metric('hide_key_to_paint_ms', stats(hk));
    for (let i = 0; i < 10; i++) await KEY_TO_PAINT(page, 'z', { ctrlKey: true });
    await settle();
    st = await apiState(server.base);
    check('Ctrl+Z x10 undid the last 10 hides', Object.keys(st.overrides).filter(id => st.overrides[id].hidden).length === 20);

    // (b) look-alike groups
    const tHash = Date.now();
    // cold: includes the server generating all 3,000 thumbnails for the first time
    await page.waitForFunction(() => window.__lib.stats().hashDone, null, { timeout: 400000, polling: 250 });
    metric('lookalike_scan_cold_ms', Date.now() - tHash);
    metric('lookalike_regroup_ms', await page.evaluate(() => window.__lib.stats().regroupMs));
    const groups = await page.evaluate(() => window.__lib.groups());
    const truth = manifest.groups;
    let full = 0, partial = 0, bestOk = 0, bestN = 0;
    const matched = new Set();
    for (const g of truth) {
      const det = groups.find(d => d.ids.some(id => g.members.includes(id)));
      if (!det) continue;
      matched.add(det);
      const inter = det.ids.filter(id => g.members.includes(id)).length;
      if (inter === g.members.length && det.ids.length === g.members.length) full++; else partial++;
      if (g.best) { bestN++; if (det.best === g.best) bestOk++; }
    }
    const falseGroups = groups.filter(d => !matched.has(d));
    metric('lookalikes', { truth_groups: truth.length, found_exact: full, found_partial: partial, missed: truth.length - full - partial, false_groups: falseGroups.length, best_pick_correct: `${bestOk}/${bestN}` });
    check('look-alike recall >= 90% of planted groups', full + partial >= truth.length * 0.9);
    check('look-alike false groups <= 5', falseGroups.length <= 5, falseGroups.slice(0, 3).map(g => g.ids.join('+')).join(' | '));

    await press('7'); // Look-alikes filter
    await page.waitForTimeout(300);
    await press('Home');
    await shot(page, 'lookalikes');
    const g0 = await page.evaluate(() => window.__lib.groupOf(window.__lib.cursor()));
    const keep = await cursor();
    await press('g');
    await settle();
    st = await apiState(server.base);
    const othersHidden = g0.ids.filter(id => id !== keep).every(id => st.overrides[id]?.hidden);
    check('G keeps the cursor photo and hides the rest of its group', othersHidden && !st.overrides[keep]?.hidden, `${g0.ids.length} in group`);
    const g1 = await page.evaluate(() => window.__lib.groupOf(window.__lib.cursor()));
    check('G jumps to the next group, on its suggested best', g1 && g1.ids[0] !== g0.ids[0] && (await cursor()) === g1.best);

    // (c) suspicious dates
    await press('8');
    await page.waitForTimeout(300);
    await shot(page, 'dates');
    const flags = await page.evaluate(() => window.__lib.flags());
    const planted = manifest.items.filter(i => i.flag);
    const caught = planted.filter(i => flags[i.name]);
    const extra = Object.keys(flags).filter(id => !planted.some(p => p.name === id));
    metric('suspicious_dates', { planted: planted.length, caught: caught.length, extra_flagged: extra.length, by_reason: Object.values(flags).flat().reduce((a, r) => (a[r] = (a[r] || 0) + 1, a), {}) });
    check('every planted bad date is flagged', caught.length === planted.length, planted.filter(i => !flags[i.name]).map(i => i.name).slice(0, 5).join(','));
    check('few false date flags (<= 10)', extra.length <= 10, extra.slice(0, 5).join(','));

    // (d) bulk: set the scanned batch to "summer 1994"
    await press('Home');
    for (let i = 0; i < 12 && !(await cursor()).startsWith('scan_'); i++) await press(']');
    check(']' + ' reaches the shared-timestamp section', (await cursor()).startsWith('scan_'), await cursor());
    await press('s');
    const nSel = await page.evaluate(() => window.__lib.selected().length);
    check('S selects the whole section', nSel === 40, `${nSel} selected`);
    await press('d');
    await page.keyboard.type('summer 1994');
    await shot(page, 'bulk-date');
    await press('Enter');
    await settle();
    st = await apiState(server.base);
    const scans = manifest.items.filter(i => i.kind === 'scan').map(i => i.name).sort();
    const scanDates = scans.map(id => st.overrides[id]?.date || '');
    check('summer 1994 persisted for all 40 scans', scanDates.every(d => d.startsWith('1994-07')), scanDates[0] + ' … ' + scanDates[39]);
    check('…keeping their scan order', scanDates.every((d, i) => i === 0 || d > scanDates[i - 1]));

    // (e) bulk shift: jump to July 2012 and push that run +1 year
    await press('Escape'); // clear selection
    await press('1');
    await press('j');
    await page.keyboard.type('2012-07');
    await press('Enter');
    check('J jumps to a date', (await cursor()).startsWith('PXL_2012'), await cursor());
    await press('s');
    await press('t');
    await page.keyboard.type('+1y');
    await press('Enter');
    await settle();
    st = await apiState(server.base);
    const pxl = manifest.items.filter(i => i.kind === 'pxl');
    const shiftedOk = pxl.every(i => st.overrides[i.name]?.date === '2013' + i.date.slice(4));
    check('+1y shift persisted for the 60-photo run (times preserved)', shiftedOk, st.overrides[pxl[0].name]?.date);
    await press('Escape');

    // (f) edit modal keeps your place, and ←/→ walk items inside it
    const before = await cursor();
    const scrollBefore = await page.evaluate(() => document.getElementById('libGrid').scrollTop);
    await press('Enter');
    await page.waitForSelector('#editModal.open');
    const nameA = await page.textContent('#emBody .fileName');
    await press('ArrowRight');
    await page.waitForTimeout(100);
    const nameB = await page.textContent('#emBody .fileName');
    await shot(page, 'edit-modal');
    await press('Escape');
    const after = await cursor();
    const scrollAfter = await page.evaluate(() => document.getElementById('libGrid').scrollTop);
    check('edit modal opens on the cursor and → moves to the next item', nameA.includes(before) && !nameB.includes(before), `${nameA.trim()} → ${nameB.trim()}`);
    check('closing the modal keeps the cursor and scroll position', after !== before && Math.abs(scrollAfter - scrollBefore) < 400, `${before} → ${after}, scroll ${scrollBefore}→${scrollAfter}`);

    // (g) loupe
    await press(' ');
    await page.waitForSelector('#libLoupe.open');
    await page.waitForTimeout(250);
    await shot(page, 'loupe');
    const lc = await cursor();
    await press('x');
    await settle();
    st = await apiState(server.base);
    check('X in the loupe hides and advances', st.overrides[lc]?.hidden && (await cursor()) !== lc);
    await page.keyboard.press('Control+z');
    await press('Escape');
    check('Esc closes the loupe, library stays', await page.evaluate(() => !document.querySelector('#libLoupe.open') && document.querySelector('#library.open') != null));

    // (h) play from here
    const target = await cursor();
    await settle();
    st = await apiState(server.base);
    const visible = st.order.filter(s => !st.overrides[s.id]?.hidden).map(s => s.id);
    await press('Shift+Enter');
    const wantC = `${visible.indexOf(target) + 1} /`;
    await page.waitForFunction(w => document.getElementById('barCounter').textContent.trim().startsWith(w), wantC, { timeout: 10000 }).catch(() => {});
    const counter = await page.textContent('#barCounter');
    check('Shift+Enter plays from the cursor', counter.trim().startsWith(wantC), `${counter} for ${target}`);
    metric('triage_script_wall_ms', Date.now() - tTriage);
    metric('triage_keydowns_over_16ms', await page.evaluate(() => (window.__evt || []).map(x => Math.round(x))));
  }

  // ===== 5. regressions (every version) =====
  console.log('\n[regressions]');
  await page.evaluate(() => { if (document.querySelector('#library.open')) document.getElementById('libClose').click(); });
  const c0 = await page.textContent('#barCounter');
  const tAdv = Date.now();
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(c0 => document.getElementById('barCounter').textContent !== c0, c0, { timeout: 15000 }).catch(() => {});
  metric('stage_advance_after_library_ms', Date.now() - tAdv); // starved if thumbnail loads pile up
  const c1 = await page.textContent('#barCounter');
  check('stage → advances', parseInt(c1) === parseInt(c0) % parseInt(c0.split('/')[1]) + 1, `${c0} → ${c1}`);
  await page.keyboard.press(' ');
  check('stage Space pauses', await page.evaluate(() => document.getElementById('pauseBadge').classList.contains('show')));
  await page.keyboard.press(' ');

  await page.keyboard.press('l');
  await page.waitForSelector('#library.open');
  const counts = {};
  for (const f of ['photos', 'live', 'videos', 'hidden', 'all']) {
    await page.click(`#libFilters [data-f="${f}"]`);
    await page.waitForTimeout(80);
    counts[f] = parseInt((await page.textContent('#libCount')).replace(/,/g, ''));
  }
  st = await apiState(server.base);
  const nHidden = Object.values(st.overrides).filter(o => o.hidden).length;
  check('filter counts', counts.videos === 4 && counts.live === 2 && counts.photos === manifest.count - 6 && counts.all === manifest.count && counts.hidden === nHidden, JSON.stringify(counts));

  // click a card -> edit modal -> type a date -> persisted
  await page.evaluate(() => { document.getElementById('libGrid').scrollTop = 0; });
  await waitIdle(page);
  // recycled cards: DOM order isn't visual order, so pin the card by its id
  const cardId = await page.locator('#libGrid .libCard:visible').nth(4).getAttribute('data-id');
  const card = page.locator(`#libGrid .libCard[data-id="${cardId}"]`);
  await card.click({ position: { x: 40, y: 40 } });
  await page.waitForSelector('#editModal.open');
  await page.fill('#emBody .dfText', '1999-12-31');
  await page.press('#emBody .dfText', 'Enter');
  st = await eventually(server.base, s => s.overrides[cardId]?.date === '1999-12-31 12:00:00');
  check('edit modal date persisted', st.overrides[cardId]?.date === '1999-12-31 12:00:00', `${cardId}: ${st.overrides[cardId]?.date}`);
  const wasHidden = !!st.overrides[cardId]?.hidden; // the triage pass may already have hidden it
  await page.click('#emBody [data-e="hideBtn"]');
  st = await eventually(server.base, s => !!s.overrides[cardId]?.hidden !== wasHidden);
  check('edit modal hide/restore toggle persisted', !!st.overrides[cardId]?.hidden !== wasHidden, wasHidden ? 'restored' : 'hidden');
  await page.click('#emClose');
  check('edit modal closes back to the library', await page.evaluate(() => !document.querySelector('#editModal.open') && !!document.querySelector('#library.open')));

  // play-from-here button
  const pid = await page.locator('#libGrid .libCard:visible').nth(10).getAttribute('data-id');
  const pc = page.locator(`#libGrid .libCard[data-id="${pid}"]`);
  st = await apiState(server.base);
  const vis = st.order.filter(s => !st.overrides[s.id]?.hidden).map(s => s.id);
  await pc.hover();
  await pc.locator('.libPlay').click();
  // the stage waits for the full image before updating the counter
  const want = `${vis.indexOf(pid) + 1} /`;
  await page.waitForFunction(w => document.getElementById('barCounter').textContent.trim().startsWith(w), want, { timeout: 10000 }).catch(() => {});
  check('play-from-here button', !(await page.$('#library.open')) && (await page.textContent('#barCounter')).trim().startsWith(want), `${pid}: ${await page.textContent('#barCounter')} want ${want}`);

  // hidden tab: lists hidden, click restores
  await page.mouse.move(700, 400);
  await page.click('#gear');
  await page.click('#tabs [data-t="hidden"]');
  await page.waitForTimeout(150);
  st = await apiState(server.base);
  const hidIds = Object.keys(st.overrides).filter(id => st.overrides[id].hidden);
  const thumbs = await page.locator('#hiddenGrid .thumb').count();
  check('hidden tab lists every hidden item', thumbs === hidIds.length, `${thumbs} vs ${hidIds.length}`);
  await shot(page, 'hidden-tab');
  await page.locator('#hiddenGrid .thumb').first().click();
  const st2 = await eventually(server.base, s => Object.values(s.overrides).filter(o => o.hidden).length === hidIds.length - 1);
  check('hidden tab click restores', Object.values(st2.overrides).filter(o => o.hidden).length === hidIds.length - 1);

  // upload
  await page.click('#tabs [data-t="global"]');
  const upFile = path.join(OUT, 'upload-test.jpg');
  execSync(`ffmpeg -v error -y -f lavfi -i testsrc=s=320x240 -frames:v 1 "${upFile}"`);
  await page.setInputFiles('#upInput', upFile);
  await page.waitForFunction(() => /Added 1 file/.test(document.getElementById('upStatus').textContent), null, { timeout: 20000 });
  await page.click('#libBtn');
  await page.click('#libFilters [data-f="uploads"]');
  await page.waitForTimeout(150);
  check('upload appears in the Uploads filter', (await page.textContent('#libCount')).startsWith('1 '), await page.textContent('#libCount'));
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  // persisted across a reload
  await page.reload();
  await page.waitForFunction(() => /\d+ \/ \d+/.test(document.getElementById('barCounter').textContent));
  const st3 = await apiState(server.base);
  const vis3 = st3.slides.length - Object.values(st3.overrides).filter(o => o.hidden).length;
  check('after reload the show has exactly the non-hidden items', (await page.textContent('#barCounter')).trim().endsWith(`/ ${vis3}`), await page.textContent('#barCounter'));
  if (results.hasTriage) {
    // warm: thumbnails cached on disk, hash cache cleared
    await page.evaluate(() => localStorage.removeItem('slideshow.lookalike.v1'));
    await page.reload();
    await page.waitForFunction(() => /\d+ \/ \d+/.test(document.getElementById('barCounter').textContent));
    const tw = Date.now();
    await page.keyboard.press('l');
    await page.waitForFunction(() => window.__lib.stats().hashDone, null, { timeout: 300000, polling: 100 });
    metric('lookalike_scan_warm_ms', Date.now() - tw);
    await page.waitForTimeout(600); // hash cache is saved debounced
    await page.reload();
    await page.waitForFunction(() => /\d+ \/ \d+/.test(document.getElementById('barCounter').textContent));
    const tc = Date.now();
    await page.keyboard.press('l');
    await page.waitForFunction(() => window.__lib.stats().hashDone, null, { timeout: 60000, polling: 20 });
    metric('lookalike_scan_cached_ms', Date.now() - tc);
    await page.keyboard.press('Escape');
  }
  check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
} catch (e) {
  console.error(e);
  check('harness completed', false, String(e).split('\n')[0]);
  await shot(page, 'failure').catch(() => {});
} finally {
  await browser.close();
  if (!flag('--keep')) server.proc.kill();
  const failed = results.checks.filter(c => !c.ok).length;
  results.summary = `${results.checks.length - failed}/${results.checks.length} checks passed`;
  writeFileSync(path.join(OUT, `results-${LABEL}.json`), JSON.stringify(results, null, 2));
  console.log(`\n${results.summary} → test/out/results-${LABEL}.json`);
  process.exit(failed ? 1 : 0);
}
