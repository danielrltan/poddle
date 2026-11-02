// The home banner (NOTES 280, web/ads.js + server ADSENSE_*). Off by default: no slot, no space, no request to Google, /ads.txt and /ads.json 404. On: one fixed banner on the lobby's
// home view only, gone on every other view and overlay, never on the title, a return inside a minute shows nothing, blocked or unfilled it closes, the glove gives way to the native
// cursor over it, and it stays clear of every button. Runs the pages against a fake game like test/mobile-ui.mjs, and the real server for the routes.
// Usage: node test/ads.mjs      ADS_PORT=<base> moves the ports (default 9960..9966). Screenshots: test/ui-shots/ads-*.png. Last line: ADS PASSED or ADS FAIL.
import http from 'http'; import fs from 'fs'; import path from 'path'; import { spawn } from 'child_process';
import { WebSocketServer } from 'ws';
import puppeteer from 'puppeteer-core';
const P0 = +process.env.ADS_PORT || 9960, W = P0, G = P0 + 1, DEAD = P0 + 2, root = new URL('..', import.meta.url).pathname, sleep = ms => new Promise(r => setTimeout(r, ms));
const J = o => JSON.stringify(o), SHOTS = path.join(root, 'test', 'ui-shots'); fs.mkdirSync(SHOTS, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4' };
let adsOn = false;
// ---------- the fake /api: stats and sign-in on, a guest ----------
const apiAnswer = (q, r) => { const u = q.url.split('?')[0], send = (s, o) => { r.writeHead(s, { 'content-type': 'application/json' }); r.end(J(o)); };
  if (u === '/api/me') return send(200, { db: true, signin: { enabled: true, clientId: 'test-client.apps.googleusercontent.com' }, account: null, places: null });
  if (u === '/api/stats') return send(200, { profile: { guest: true, played: 0 } });
  if (u === '/api/leaderboard') return send(200, { board: 'rally', total: 0, rows: [] });
  return send(404, { error: 'nope' }); };
const web = http.createServer((q, r) => {
  if (q.url.startsWith('/ads.json')) { r.writeHead(adsOn ? 200 : 404, { 'content-type': 'application/json' }); return r.end(adsOn ? J({ client: 'ca-pub-1234567890123456', slot: '1234567890' }) : ''); }
  if (q.url.startsWith('/api/')) { q.resume(); q.on('end', () => apiAnswer(q, r)); return; }
  let f = path.join(root, decodeURIComponent(q.url.split('?')[0])); if (!f.startsWith(root)) { r.writeHead(403); return r.end(); } if (f.endsWith('/')) f += 'index.html';
  const serve = (g, next) => fs.readFile(g, (e, d) => { if (e && next) return next(); r.writeHead(e ? 404 : 200, { 'content-type': MIME[path.extname(g)] || 'application/octet-stream' }); r.end(e ? '' : d); });
  serve(f, () => serve(path.join(root, 'web', decodeURIComponent(q.url.split('?')[0])), null)); }).listen(W, '127.0.0.1');

// ---------- the fake game: a court list with one of each kind; every frame a page sends is kept ----------
const ROOMS = [
  { code: 'WXYZ', players: 1, open: true, watch: 8, watchers: 0, names: ['Kiko', null], score: [0, 0] },      // someone waiting: a phone watches it
  { code: 'EMPT', players: 0, open: true, watch: 8, watchers: 0, names: [null, null], score: [0, 0] },         // nobody there: left out on a phone
  { code: 'MATT', players: 1, open: false, ask: true, watch: 8, watchers: 1, names: ['Mo', 'Matt'], score: [3, 2], bot: true },      // a player vs Matt: Watch, never Ask to play
  { code: 'BUSY', players: 2, open: false, watch: 8, watchers: 2, names: ['Ana', 'Zed'], score: [5, 4], live: true } ];
const TOURS = [{ code: 'TRNY', host: 'Juno', n: 3, max: 16 }];
const LIST = { type: 'lobby', online: 5, rooms: ROOMS, tours: TOURS }, frames = [];
const wss = new WebSocketServer({ port: G, host: '127.0.0.1' });
wss.on('connection', ws => { ws.send(J(LIST)); ws.on('message', raw => { let m; try { m = JSON.parse(raw); } catch { return; } if (m.type === 'ping') { ws.send(J({ type: 'pong', c: m.c })); return; } frames.push(m); }); });
const SEAT = ['quick', 'create', 'join', 'tcreate', 'ask', 'bot', 'twarm', 'tstart'];
const seats = () => frames.filter(m => SEAT.includes(m.type)).map(m => m.type + (m.code ? ':' + m.code : ''));
const watches = () => frames.filter(m => m.type === 'watch').map(m => m.code);

const CHROME = process.env.CHROME || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => fs.existsSync(p));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
const out = [], errs = [], ok = (c, what) => { out.push((c ? 'PASS ' : 'FAIL ') + what); if (!c) console.log('FAIL', what); };
setTimeout(() => { console.log(out.join('\n')); console.log('ADS FAIL (timeout)'); process.exit(2); }, 200000);
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const url = (q = '') => `http://127.0.0.1:${W}/web/index.html?uitest=1&acctest=1&cam=0&game=${G}&bridge=${DEAD}${q}`;
// loader: 'fill' stubs Google's script and marks each <ins> filled, 'unfilled' marks it unfilled, 'block' aborts it as an ad blocker would
async function page(tag, { w = 1440, h = 900, phone = false, loader = 'fill' } = {}) {
  const pg = await browser.newPage(); await pg.emulate({ viewport: { width: w, height: h, deviceScaleFactor: 1, isMobile: phone, hasTouch: phone }, userAgent: phone ? IPHONE : await browser.userAgent() });
  pg.google = []; await pg.setRequestInterception(true);
  pg.on('request', q => { const u = q.url();
    if (/pagead2\.googlesyndication\.com/.test(u)) { pg.google.push(u); if (loader === 'block') return q.abort();
      return q.respond({ status: 200, contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: `(function(){const f=()=>document.querySelectorAll('ins.adsbygoogle:not([data-ad-status])').forEach(i=>i.setAttribute('data-ad-status','${loader === 'unfilled' ? 'unfilled' : 'filled'}'));const a=window.adsbygoogle;a.push=()=>{setTimeout(f);return 0};f()})()` }); }
    if (/google\.com|gstatic\.com/.test(u)) return q.abort(); q.continue(); });
  pg.on('pageerror', e => errs.push(`[${tag}] PAGEERROR ${e.message}`));
  await pg.evaluateOnNewDocument(() => { try { localStorage.setItem('poddle.name', 'Tester'); localStorage.setItem('poddle.camPrimer', 'allow'); localStorage.setItem('poddle.lbSeen', '3'); } catch { /* */ } });
  return pg; }
const st = pg => pg.evaluate(() => { const b = document.querySelector('.ad-home .ad-unit'), r = b?.getBoundingClientRect(), a = document.querySelector('.screen.is-active');
  const btns = [...document.querySelectorAll('#screen-lobby .tile, #screen-lobby #m-pad-go')].filter(e => e.getClientRects().length).map(e => e.getBoundingClientRect());
  return { n: document.querySelectorAll('.ad-unit').length, ins: document.querySelectorAll('ins.adsbygoogle').length, screen: a?.id, view: window.__ui?.lobbyView(), r: r && [r.left, r.top, r.right, r.bottom].map(Math.round), w: r && Math.round(r.width), h: r && Math.round(r.height), gap: r && btns.length ? Math.round(Math.min(...btns.map(t => r.top - t.bottom))) : null, wide: document.documentElement.scrollWidth > innerWidth + 1, vh: innerHeight, foot: Math.round(document.querySelector('#screen-lobby .menu-foot')?.getBoundingClientRect().top || 0) }; });
const toLobby = async pg => { await pg.evaluate(() => document.getElementById('btn-start')?.click()); await sleep(1400); };
const bodyHas = (pg, sel) => pg.evaluate(s => !!document.querySelector(s), sel);

// ---------- 1. dormant: the state of the live site until the owner sets the two values ----------
let pg = await page('off'); await pg.goto(url(), { waitUntil: 'domcontentloaded' }); await sleep(1800); await toLobby(pg);
let s = await st(pg);
ok(s.screen === 'screen-lobby' && s.view === 'home', `reached the lobby's home (${s.screen} ${s.view})`);
ok(s.n === 0 && pg.google.length === 0 && await pg.evaluate(() => document.getElementById('tog-ads').hidden), `no config: no slot, no Settings row, nothing fetched from Google (${s.n} ${pg.google.length})`);
await pg.close();

// ---------- 2. on: desktop ----------
adsOn = true; pg = await page('on'); await pg.goto(url(), { waitUntil: 'domcontentloaded' }); await sleep(1800);
s = await st(pg); ok(s.screen === 'screen-title' && s.n === 0 && pg.google.length === 0, `the title has no ad and nothing is fetched yet (${s.screen} ${s.n} ${pg.google.length})`);
await toLobby(pg); await sleep(2500); s = await st(pg);
ok(s.n === 3 && s.ins === 3, `the home shows the bottom banner and both side ads (${s.n} ${s.ins})`);
{ const g = await pg.evaluate(() => { const R = e => e.getBoundingClientRect(), t = R(document.querySelector('#lobby-home .tiles')), [a, b] = [...document.querySelectorAll('.ad-side')].map(R), p = R(document.querySelector('#screen-lobby .ph-badge')), h = R(document.querySelector('#screen-lobby .menu-head')), ins = [...document.querySelectorAll('.ad-side ins')].map(i => [i.offsetWidth, i.offsetHeight]); return { l: t.left - a.right, r: b.left - t.right, left: a.left, right: innerWidth - b.right, badge: p.top - b.bottom, head: a.top - h.bottom, ins }; });
  ok(g.l >= 16 && g.r >= 16 && g.left >= 0 && g.right >= 0, `the side ads stay in the margins, clear of the tiles (${J(g)})`); ok(g.badge >= 12 && g.head >= 12, 'clear of the Product Hunt badge and the header'); ok(J(g.ins[0]) === '[160,600]', 'a fixed 160x600 unit'); }
ok(pg.google.length === 1 && pg.google[0].includes('client=ca-pub-1234567890123456'), `Google's script loads once, with the client (${pg.google.length})`);
ok(await pg.evaluate(() => { const i = document.querySelector('.ad-home ins.adsbygoogle'); return i.offsetWidth === 728 && i.offsetHeight === 90 && i.dataset.adSlot === '1234567890'; }), 'a fixed 728x90 unit with the slot, no responsive format');
ok(s.gap >= 24, `at least 24 px clear of the nearest tile (${s.gap})`);
ok(s.r[3] <= s.foot, `above the footer (${s.r[3]} <= ${s.foot})`);
ok(!s.wide, 'no sideways scroll');
await pg.screenshot({ path: path.join(SHOTS, 'ads-desktop.png') });
await pg.evaluate(() => document.getElementById('btn-leaderboard')?.click() ?? document.getElementById('btn-courts').click()); await sleep(700); s = await st(pg);
ok(s.view !== 'home' && s.n === 0 && s.ins === 0, `another view removes the slot from the page, not just from sight (${s.view} ${s.n} ${s.ins})`);
await pg.evaluate(() => window.__ui.lobbyView('home')); await sleep(500); s = await st(pg);
ok(s.view === 'home' && s.n === 0, `back at home inside a minute: no new ad request (${s.view} ${s.n})`);
await pg.evaluate(() => { const real = performance.now.bind(performance); performance.now = () => real() + 61e3; window.__ui.lobbyView('courts'); }); await sleep(300);
await pg.evaluate(() => window.__ui.lobbyView('home')); await sleep(500); s = await st(pg);
ok(s.n === 3 && s.ins === 3 && pg.google.length === 1, `after a minute, a fresh unit and the script not fetched again (${s.n} ${s.ins} ${pg.google.length})`);
await pg.evaluate(() => { document.body.dataset.overlay = 'x'; }); await sleep(200); s = await st(pg); ok(s.n === 0, `an overlay over the menu closes it (${s.n})`);
await pg.evaluate(() => { delete document.body.dataset.overlay; }); await sleep(100);
await pg.evaluate(() => window.__ui.showScreen(null)); await sleep(300); s = await st(pg); ok(s.n === 0, `a court (no menu screen) has no slot (${s.n})`);
await pg.close();

// ---------- Turn off? ----------
pg = await page('turnoff'); await pg.goto(url(), { waitUntil: 'domcontentloaded' }); await sleep(1800); await toLobby(pg); await sleep(1500);
await pg.evaluate(() => document.querySelector('.ad-toggle').click()); await sleep(200);
{ const a = await pg.evaluate(() => { const c = document.querySelector('.ad-ask'), r = c?.getBoundingClientRect(); return { text: c?.textContent, box: r && [r.left, r.top, r.right, r.bottom].map(Math.round), vw: innerWidth }; });
  ok(/break even/.test(a.text || '') && /Turn off ads/.test(a.text) && /Keep ads/.test(a.text), `Turn off? opens the card with the reason and the choice`);
  ok(a.box[0] >= 0 && a.box[1] >= 0 && a.box[2] <= a.vw, `the card is fully on screen (${J(a.box)})`); }
await pg.screenshot({ path: path.join(SHOTS, 'ads-turnoff.png') });
await pg.evaluate(() => document.querySelector('[data-keep]').click()); await sleep(150);
s = await st(pg); ok(s.n === 3 && !(await bodyHas(pg, '.ad-ask')), 'Keep ads closes the card and the banners stay');
await pg.evaluate(() => document.querySelector('.ad-toggle').click()); await sleep(150); await pg.evaluate(() => document.querySelector('[data-off]').click()); await sleep(200);
s = await st(pg); ok(s.n === 0 && await pg.evaluate(() => localStorage.getItem('poddle.adsOff') === '1' && document.getElementById('tog-ads').getAttribute('aria-checked') === 'false'), `Turn off ads: the banner goes, the choice is kept, the Settings row says off (${s.n})`);
await pg.reload({ waitUntil: 'domcontentloaded' }); pg.google.length = 0; await sleep(1800); await toLobby(pg); await sleep(2500); s = await st(pg);
ok(s.n === 0 && pg.google.length === 0, `after a reload: no banner and nothing fetched from Google (${s.n} ${pg.google.length})`);
await pg.evaluate(() => document.getElementById('tog-ads').click()); await sleep(600); s = await st(pg);
ok(s.n === 3 && await pg.evaluate(() => localStorage.getItem('poddle.adsOff') === null), `Settings puts them back at once (${s.n})`);
await pg.close();

// ---------- 3. the glove ----------
pg = await page('cursor'); await pg.goto(url(), { waitUntil: 'domcontentloaded' }); await sleep(1800); await toLobby(pg); await sleep(1500); s = await st(pg);
await pg.mouse.move(300, 300); await sleep(100); await pg.mouse.move((s.r[0] + s.r[2]) / 2, (s.r[1] + s.r[3]) / 2, { steps: 4 }); await sleep(200);
ok(await pg.evaluate(() => { const c = document.getElementById('cur'); return !c || c.classList.contains('is-off') || !c.classList.contains('is-on'); }), 'over the banner the glove gives way to the native cursor');
await pg.close();

// ---------- 4. blocked, unfilled ----------
pg = await page('block', { loader: 'block' }); await pg.goto(url(), { waitUntil: 'domcontentloaded' }); await sleep(1800); await toLobby(pg); await sleep(2800); s = await st(pg);
ok(pg.google.length === 1 && s.n === 0, `an ad blocker: the slot closes and leaves no gap (${pg.google.length} ${s.n})`); await pg.close();
pg = await page('unfilled', { loader: 'unfilled' }); await pg.goto(url(), { waitUntil: 'domcontentloaded' }); await sleep(1800); await toLobby(pg); await sleep(2800); s = await st(pg);
ok(pg.google.length === 1 && s.n === 0, `no ad to show: the slot closes (${pg.google.length} ${s.n})`); await pg.close();

// ---------- 4b. narrow, short and resized windows: the side ads only where they fit ----------
for (const [w, h, want] of [[1100, 900, null], [1280, 720, 1], [1920, 1080, 3]]) { pg = await page(`size${w}`, { w, h }); await pg.goto(url(), { waitUntil: 'domcontentloaded' }); await sleep(1800); await toLobby(pg); await sleep(1500); s = await st(pg);
  const c = await pg.evaluate(() => { const t = document.querySelector('#lobby-home .tiles').getBoundingClientRect(); return [...document.querySelectorAll('.ad-side')].every(e => { const r = e.getBoundingClientRect(); return r.right <= t.left || r.left >= t.right; }); });
  ok(c && s.n >= 1 && !s.wide && (want == null || s.n === want), `${w}x${h}: ${s.n} ad(s), none over the tiles`);
  if (w === 1920) { await pg.setViewport({ width: 800, height: 1000 }); await sleep(500); s = await st(pg); ok(await pg.evaluate(() => { const t = document.querySelector('#lobby-home .tiles').getBoundingClientRect(); return [...document.querySelectorAll('.ad-side')].every(e => { const r = e.getBoundingClientRect(); return r.right <= t.left || r.left >= t.right; }); }), `shrinking the window keeps the side ads off the tiles (${s.n})`); await pg.setViewport({ width: 700, height: 1000 }); await sleep(500); s = await st(pg); ok(s.n === 0 && !s.wide, `too narrow for the bottom unit: every ad closes, no sideways scroll (${s.n})`); }
  await pg.close(); }

// ---------- 5. a phone, a short window, the paddle page ----------
pg = await page('phone', { w: 390, h: 844, phone: true }); await pg.goto(url(), { waitUntil: 'domcontentloaded' }); await sleep(3800); s = await st(pg);
{ const i = await pg.evaluate(() => { const e = document.querySelector('ins.adsbygoogle'); return e ? [e.offsetWidth, e.offsetHeight] : null; }); ok(s.n === 1 && J(i) === '[320,50]', `a phone gets a 320x50 banner (${s.n} ${J(i)})`); }
ok(s.gap >= 24 && !s.wide, `clear of the last tile and Go, no sideways scroll (${s.gap} ${s.wide})`);
await pg.screenshot({ path: path.join(SHOTS, 'ads-phone.png') }); await pg.close();
pg = await page('short', { w: 1280, h: 520 }); await pg.goto(url(), { waitUntil: 'domcontentloaded' }); await sleep(1800); await toLobby(pg); await sleep(1200); s = await st(pg);
ok(s.n === 0, `a short window keeps its menu (${s.n})`); await pg.close();
pg = await page('pad', { w: 390, h: 844, phone: true }); await pg.goto(`http://127.0.0.1:${W}/web/pad.html?k=ABCD`, { waitUntil: 'domcontentloaded' }); await sleep(1800);
ok(pg.google.length === 0 && !(await bodyHas(pg, '.ad-home')), 'the paddle page has no ad and loads nothing from Google'); await pg.close();
ok(!/ads\.js/.test(fs.readFileSync(path.join(root, 'web', 'pad.js'), 'utf8')), 'pad.js never imports it');

// ---------- 6. ?adtest=1: a grey box, and nobody is contacted ----------
adsOn = false; pg = await page('test'); await pg.goto(url('&adtest=1'), { waitUntil: 'domcontentloaded' }); await sleep(1800); await toLobby(pg); await sleep(600); s = await st(pg);
ok(s.n === 3 && s.ins === 0 && pg.google.length === 0, `?adtest=1 draws the boxes and fetches nothing (${s.n} ${s.ins} ${pg.google.length})`); await pg.close();
await browser.close();

// ---------- 7. the real server's two routes ----------
const serve = (port, env) => new Promise(res => { const c = spawn(process.execPath, ['server/game.js'], { cwd: root, env: { ...process.env, PORT: String(port), PODDLE_DB: '', ...env }, stdio: 'pipe' }); c.stdout.on('data', d => /on port/.test(d) && res(c)); });
const get = async (port, p) => { const r = await fetch(`http://127.0.0.1:${port}${p}`); return [r.status, await r.text()]; };
let c = await serve(P0 + 3, { ADSENSE_CLIENT: '', ADSENSE_SLOT: '' }); let a = await get(P0 + 3, '/ads.txt'), b = await get(P0 + 3, '/ads.json');
ok(a[0] === 404 && b[0] === 404, `unset: /ads.txt and /ads.json are 404 (${a[0]} ${b[0]})`); c.kill();
c = await serve(P0 + 4, { ADSENSE_CLIENT: 'ca-pub-1234567890123456', ADSENSE_SLOT: '' }); a = await get(P0 + 4, '/ads.txt'); b = await get(P0 + 4, '/ads.json');
ok(a[0] === 200 && a[1] === 'google.com, pub-1234567890123456, DIRECT, f08c47fec0942fa0\n' && b[0] === 404, `client only (Google's site check): ads.txt on, no banner yet (${a[0]} ${b[0]})`); c.kill();
c = await serve(P0 + 5, { ADSENSE_CLIENT: 'ca-pub-1234567890123456', ADSENSE_SLOT: '1234567890' }); b = await get(P0 + 5, '/ads.json');
ok(b[0] === 200 && J(JSON.parse(b[1])) === J({ client: 'ca-pub-1234567890123456', slot: '1234567890' }), `both: /ads.json answers (${b[0]})`); c.kill();
c = await serve(P0 + 6, { ADSENSE_CLIENT: 'nonsense"><script>', ADSENSE_SLOT: 'x' }); a = await get(P0 + 6, '/ads.txt'); ok(a[0] === 404, `a malformed value is refused (${a[0]})`); c.kill();

ok(!errs.length, `no page errors ${errs.slice(0, 3).join(' | ')}`);
console.log(out.join('\n')); const bad = out.filter(l => l.startsWith('FAIL')).length;
console.log(bad ? `ADS FAIL (${bad})` : 'ADS PASSED'); process.exit(bad ? 1 : 0);
