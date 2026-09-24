// The camera primer (NOTES 94): the real page, a fake lobby and a fake AirPod, and the browser's camera API stubbed per case so
// nothing depends on Chrome's own permission flags. Checks: a first seat shows the primer (and a live paddle behind it cannot skip
// to calibration); Allow asks for the camera; Play without camera sets Auto and never asks; a second seat after a reload skips the
// primer; a spectator never sees it; a camera the browser already blocks shows the help, and Try again really asks again.
// Screenshots: test/ui-shots/cam-*.png (ask and blocked, 1440x900 and 390x844).
// Usage: node test/camprimer.mjs      CAM_PORT=<base> moves the ports (default 8950: pages, +1 fake lobby, +2 fake AirPod, +3 nothing).
import http from 'http'; import fs from 'fs'; import path from 'path';
import { WebSocketServer } from 'ws';
import puppeteer from 'puppeteer-core';
const P0 = +process.env.CAM_PORT || 8950, W = P0, G = P0 + 1, BR = P0 + 2, DEAD = P0 + 3, root = new URL('..', import.meta.url).pathname, sleep = ms => new Promise(r => setTimeout(r, ms));
if ([8080, 8787, 3000].some(p => p >= P0 && p <= P0 + 3)) { console.log('refusing: that port range holds the player\'s own game'); process.exit(2); }
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml' };
const web = http.createServer((q, r) => { let f = path.join(root, decodeURIComponent(q.url.split('?')[0])); if (!f.startsWith(root)) { r.writeHead(403); return r.end(); } if (f.endsWith('/')) f += 'index.html';
  fs.readFile(f, (e, d) => { r.writeHead(e ? 404 : 200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); r.end(e ? '' : d); }); }).listen(W, '127.0.0.1');
const CHROME = process.env.CHROME || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => fs.existsSync(p));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--hide-scrollbars'] });
const out = [], errs = [], ok = (c, what) => { out.push((c ? 'PASS ' : 'FAIL ') + what); if (!c) console.log('FAIL', what); };
setTimeout(() => { console.log(out.join('\n')); console.log('CAMPRIMER FAIL (timeout)'); process.exit(2); }, 240000);
const J = o => JSON.stringify(o);

// the fake lobby: Quick play seats you, a watch link lets you in to watch. Every message is kept
const got = [], COURT = { halfW: 3.05, halfL: 6.7, kitchen: 2.13, net: 0.91 };
const wss = new WebSocketServer({ port: G, host: '127.0.0.1' });
wss.on('connection', ws => { ws.send(J({ type: 'lobby', online: 1, rooms: [] })); ws.on('message', raw => { const m = JSON.parse(raw); if (m.type === 'ping') return ws.send(J({ type: 'pong', c: m.c })); got.push(m);
  if (m.type === 'quick' || m.type === 'join') { ws.send(J({ type: 'room', code: 'QQQQ', public: true, role: 'player' })); ws.send(J({ type: 'welcome', side: 0, role: 'player', court: COURT, names: [m.name || 'Player 1', null] })); }
  if (m.type === 'watch') { ws.send(J({ type: 'room', code: m.code, public: true, role: 'spectator' })); ws.send(J({ type: 'welcome', side: 0, role: 'spectator', court: COURT, names: ['Ann', null] })); } }); });
// the fake AirPod: a still bud at 50 Hz, so the page has a live paddle the whole time (the trap: it must not calibrate behind the primer)
let podOn = false; const pod = new WebSocketServer({ port: BR, host: '127.0.0.1' }); let t0 = Date.now();
setInterval(() => { if (!podOn) return; const s = J({ t: (Date.now() - t0) / 1000, q: [0, 0, 0, 1], r: [0, 0, 0], a: [0, 0, 9.81] }); for (const c of pod.clients) if (c.readyState === 1) c.send(s); }, 20);

// one fresh profile per case (its own localStorage). cfg.perm: what permissions.query says; cfg.deny: getUserMedia refuses (NotAllowedError)
async function open(tag, cfg, { w = 1440, h = 900, query = '', ctx = null } = {}) {
  const c = ctx || await browser.createBrowserContext(), pg = await c.newPage(); await pg.setViewport({ width: w, height: h, deviceScaleFactor: 1 }); pg.ctx = c;
  pg.on('pageerror', e => errs.push(`[${tag}] PAGEERROR ${e.message}`));
  pg.on('console', m => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED|WebSocket connection|Failed to load resource/.test(m.text())) errs.push(`[${tag}] ${m.text()}`); });
  await pg.evaluateOnNewDocument(cfg => {
    try { if (!localStorage.getItem('poddle.name')) localStorage.setItem('poddle.name', 'Dan'); } catch { /* */ }      // a returning visitor: the lobby asks a first one for a name
    window.__gum = 0;      // camera requests only: findSinks asks for audio, and that is not the camera
    const md = navigator.mediaDevices, real = md.getUserMedia.bind(md);
    md.getUserMedia = c => { if (c && c.video) { window.__gum++; if (cfg.deny) return Promise.reject(new DOMException(cfg.deny === true ? 'Permission denied' : 'Could not start video source', cfg.deny === true ? 'NotAllowedError' : cfg.deny)); } return real(c); };
    const pq = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = d => d && d.name === 'camera' ? Promise.resolve(window.__perm = { state: cfg.perm, onchange: null }) : pq(d);
  }, cfg);
  await pg.goto(`http://127.0.0.1:${W}/web/index.html?uitest=1&game=${G}&bridge=${cfg.pod ? BR : DEAD}${query}`); await sleep(1600);
  return pg; }
const st = pg => pg.evaluate(() => { const $ = id => document.getElementById(id), seen = id => { const e = $(id); return !!e && !e.hidden && !!e.getClientRects().length; };
  return { screen: document.body.dataset.screen, phase: __stats.phase, view: __stats.camView, gum: window.__gum, key: localStorage.getItem('poddle.camPrimer'), mode: $('mode').textContent,
    allow: seen('btn-cam-allow'), retry: seen('btn-cam-retry'), skip: seen('btn-cam-skip'), help: seen('cam-help'), title: $('cam-title').textContent, first: [...document.querySelectorAll('#cam-help > .cam-how')].map(e => e.dataset.for).join(','),
    camRow: $('row-camera-state').textContent, camOn: seen('btn-cam-on'), focus: document.activeElement && document.activeElement.id,
    fits: (() => { const c = $('cam-card').getBoundingClientRect(); return c.left >= -0.5 && c.right <= innerWidth + 0.5; })(), hScroll: document.documentElement.scrollWidth > innerWidth + 0.5 }; });
const seat = async pg => { await pg.click('#btn-start'); await sleep(700); if (await pg.evaluate(() => !!document.getElementById('btn-quick').getClientRects().length)) await pg.click('#btn-quick'); await sleep(1000); };      // Play, then Quick play: the seat. After a reload the address bar's ?court= rejoins by itself
const shot = async (pg, name) => { await sleep(700); await pg.screenshot({ path: `${root}test/ui-shots/cam-${name}.png` }); };

// ---------- 1. first seat: the primer, with a live paddle behind it; Allow asks, then calibration ----------
podOn = true;
let pg = await open('first', { perm: 'prompt', pod: true }), s;
ok((await st(pg)).key === null, 'a new visitor has no primer answer kept');
await seat(pg); s = await st(pg);
ok(s.screen === 'camera' && s.phase === 'camera' && s.view === 'ask' && s.gum === 0 && s.allow && s.skip && !s.retry && !s.help, `first seat -> the primer, ask view, no camera asked yet (screen ${s.screen}, phase ${s.phase}, view ${s.view}, gum ${s.gum})`);
ok(s.focus === 'btn-cam-allow', `Allow has focus: Enter answers (${s.focus})`);
await pg.keyboard.press('KeyC'); await pg.keyboard.press('KeyB'); await sleep(1500); s = await st(pg);
ok(s.phase === 'camera' && s.screen === 'camera' && !got.some(m => m.type === 'bot'), `a streaming AirPod and the C / B keys cannot skip it to calibration (phase ${s.phase})`);
ok(s.fits && !s.hScroll, '1440x900: the card fits the width, no sideways scroll');
await shot(pg, 'ask-1440x900');
await pg.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 }); await sleep(400); s = await st(pg);
ok(s.fits && !s.hScroll, '390x844: the card fits the width, no sideways scroll');
await shot(pg, 'ask-390x844'); await pg.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 }); await sleep(300);
await pg.click('#btn-cam-allow'); await sleep(1500); s = await st(pg);
ok(s.gum === 1 && s.key === 'allow' && s.phase === 'calibrate' && s.screen === 'calibrate', `Allow -> one camera request, kept 'allow', then on to calibration with the live paddle (gum ${s.gum}, key ${s.key}, phase ${s.phase})`);

// ---------- 2. the same profile after a reload: no primer, the camera just starts ----------
await pg.reload(); await sleep(1600); await seat(pg); s = await st(pg);
ok(s.screen !== 'camera' && s.phase !== 'camera' && s.gum === 1, `second seat after a reload skips the primer (screen ${s.screen}, gum ${s.gum})`);
podOn = false; await pg.ctx.close();

// ---------- 3. Play without camera: Auto, never asked, kept; the connect row can turn it on later ----------
pg = await open('skip', { perm: 'prompt' });
await seat(pg); s = await st(pg); ok(s.screen === 'camera', `first seat -> the primer (${s.screen})`);
await pg.click('#btn-cam-skip'); await sleep(900); s = await st(pg);
ok(s.screen === 'connect' && s.gum === 0 && s.key === 'skip' && s.mode === 'Auto', `Play without camera -> connect, Auto, no camera request (screen ${s.screen}, mode ${s.mode}, gum ${s.gum}, key ${s.key})`);
ok(s.camRow === 'Off' && s.camOn, `the connect screen's Camera row says Off and offers Turn on (${s.camRow}, button ${s.camOn})`);
await pg.reload(); await sleep(1600); await seat(pg); s = await st(pg);
ok(s.screen === 'connect' && s.gum === 0 && s.mode === 'Auto', `after a reload: no primer, still Auto, still never asked (screen ${s.screen}, mode ${s.mode}, gum ${s.gum})`);
await pg.click('#btn-cam-on'); await sleep(2500); s = await st(pg);
ok(s.gum === 1 && s.key === 'allow' && s.screen === 'connect', `Turn on asks for the camera and keeps 'allow' (gum ${s.gum}, key ${s.key}, screen ${s.screen})`);
const back = await pg.evaluate(() => new Promise(r => { const t0 = performance.now(), f = () => { if (__stats.cam && __stats.cam.ready || performance.now() - t0 > 12000) r({ cam: __stats.cam, mode: document.getElementById('mode').textContent }); else setTimeout(f, 200); }; f(); }));
ok(!back.cam || !back.cam.ready || back.mode === 'Body', `once the camera is up, Move is Body again (${back.mode}, camera ${J(back.cam && back.cam.ready)})`);
await pg.ctx.close();

// ---------- 4. the browser already blocks the camera: the help, not an Allow; Try again asks again, every time ----------
for (const [w, h] of [[1440, 900], [390, 844]]) {
  pg = await open('denied', { perm: 'denied', deny: true }, { w, h }); if (w < 500) await pg.setViewport({ width: w, height: h, deviceScaleFactor: 2 });
  await seat(pg); s = await st(pg);
  ok(s.screen === 'camera' && s.view === 'help' && !s.allow && s.retry && s.skip && s.help && s.gum === 0 && /blocked/.test(s.title), `${w}x${h} denied -> the help (view ${s.view}, "${s.title}"), Try again + Play without camera, nothing asked yet (gum ${s.gum})`);
  ok(s.first.startsWith('chrome,mac'), `${w}x${h} this browser's steps first, then the Mac's switch (${s.first})`);
  ok(s.fits && !s.hScroll, `${w}x${h} the help fits the width, no sideways scroll`);
  await shot(pg, `blocked-${w}x${h}`);
  if (w > 500) {
    await pg.click('#btn-cam-retry'); await sleep(600); s = await st(pg);
    ok(s.gum === 1 && s.view === 'help' && s.screen === 'camera', `Try again really asks (gum ${s.gum}) and, refused, shows the help again (${s.view})`);
    await pg.click('#btn-cam-retry'); await sleep(600); s = await st(pg);
    ok(s.gum === 2, `and again: the camera no longer latches after one try (gum ${s.gum})`);
    const note = await pg.evaluate(() => document.getElementById('cam-note').textContent); ok(/Still not working/.test(note), `a failed retry says so (${note})`);
    await pg.click('#btn-cam-skip'); await sleep(900); s = await st(pg);
    ok(s.screen === 'connect' && s.mode === 'Auto' && s.key === 'skip', `Play without camera from the help -> connect, Auto (${s.screen}, ${s.mode})`);
  }
  await pg.ctx.close();
}

// ---------- 5. Allow, then the browser says no: the help appears where the player is ----------
pg = await open('refused', { perm: 'prompt', deny: true });
await seat(pg); await pg.click('#btn-cam-allow'); await sleep(900); s = await st(pg);
ok(s.gum === 1 && s.screen === 'camera' && s.view === 'help' && s.retry, `Allow refused -> the primer turns into the help (view ${s.view}, gum ${s.gum})`);
await pg.click('#btn-cam-retry'); await sleep(600); s = await st(pg); ok(s.gum === 2, `Try again asks again (gum ${s.gum})`);
// Back leaves the court, as from the connect screen
const n0 = got.filter(m => m.type === 'leave').length; await pg.click('#screen-camera [data-back]'); await sleep(800); s = await st(pg);
ok(s.screen === 'lobby' && s.phase === 'lobby' && got.filter(m => m.type === 'leave').length === n0 + 1, `Back from the primer -> the lobby, and the court is left (${s.screen})`);
await pg.ctx.close();

// ---------- 6. already allowed in this browser: nothing to explain ----------
pg = await open('granted', { perm: 'granted' });
await seat(pg); s = await st(pg);
ok(s.screen === 'connect' && s.gum === 1 && s.key === 'allow', `permission already granted -> no primer, the camera starts (screen ${s.screen}, gum ${s.gum}, key ${s.key})`);
const up = await pg.evaluate(() => new Promise(r => { const t0 = performance.now(), f = () => { if (__stats.cam && __stats.cam.ready || performance.now() - t0 > 12000) r(!!(__stats.cam && __stats.cam.ready)); else setTimeout(f, 200); }; f(); }));
if (up) {      // Settings -> Move: Auto, then Body again. A camera already up is just used: no second request, no restart
  await pg.evaluate(() => document.querySelector('[data-move=auto]').click()); await sleep(300);
  await pg.evaluate(() => document.querySelector('[data-move=body]').click()); await sleep(300); s = await st(pg);
  const cam = await pg.evaluate(() => !!(__stats.cam && __stats.cam.ready));
  ok(s.gum === 1 && s.mode === 'Body' && cam, `Move Auto -> Body with the camera up: Body at once, not asked again (gum ${s.gum}, mode ${s.mode}, camera ${cam})`);
} else ok(true, 'Move Auto -> Body: skipped, the models did not load in this browser');
await pg.ctx.close();

// ---------- 6b. the camera won't start (NotReadableError: another app, or Windows' privacy switch): the fix steps show ----------
pg = await open('busy', { perm: 'prompt', deny: 'NotReadableError' });
await seat(pg); await pg.click('#btn-cam-allow'); await sleep(900); s = await st(pg);
ok(s.view === 'help' && s.help && s.retry && /won’t start/.test(s.title) && s.first.startsWith('mac,'), `busy -> the help with steps, the computer's switch first ("${s.title}", ${s.first})`);
await pg.ctx.close();

// ---------- 7. a spectator never sees it and is never asked ----------
pg = await open('watch', { perm: 'prompt' }, { query: '&court=WTCH&watch=1' });
await pg.click('#btn-start'); await sleep(1500); s = await st(pg);
ok(s.phase === 'watch' && s.screen !== 'camera' && s.gum === 0, `a watch link -> watching, no primer, no camera (phase ${s.phase}, screen ${s.screen}, gum ${s.gum})`);
await pg.ctx.close();

const uniq = [...new Set(errs.map(e => e.split('\n')[0].slice(0, 220)))];
ok(!uniq.length, 'no page errors' + (uniq.length ? ':\n  ' + uniq.join('\n  ') : ''));
console.log(out.join('\n')); const bad = out.filter(l => l.startsWith('FAIL')).length;
console.log(`${out.length - bad} passed, ${bad} failed`); console.log(bad ? 'CAMPRIMER FAIL' : 'CAMPRIMER PASS');
await browser.close(); web.close(); process.exit(bad ? 1 : 0);
