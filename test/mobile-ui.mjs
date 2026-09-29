// The phone home (NOTES 149): web/main.js MOBILE + ui.js + index.html against a fake game and a fake /api. A phone (touch, under 600 px on its short side) skips the
// title for the lobby's home: the paddle-code card (P- and 4 -> /pad.html?k=CODE), Watch a match, Your stats, Leaderboard, Friends; Quick play, Ranked and Play a bot are
// gone and the tile count follows. It never sends a seat: court rows, the code boxes and a ?court= link all WATCH, empty courts are left out, a hidden button pressed by
// script still sends nothing (the request() gate), Back at home stays home. A tablet, a desktop and ?mobile=0 keep the title. Portrait and landscape fit with no sideways scroll.
// Usage: node test/mobile-ui.mjs      MOBILE_UI_PORT=<base> moves the ports (default 9880: pages + /api, 9881: fake game, 9882: nothing = no AirPod). Screenshots: test/ui-shots/mobile-*.png.
// Last line: MOBILE UI PASSED or MOBILE UI FAIL.
import http from 'http'; import fs from 'fs'; import path from 'path';
import { WebSocketServer } from 'ws';
import puppeteer from 'puppeteer-core';
const P0 = +process.env.MOBILE_UI_PORT || 9880, W = P0, G = P0 + 1, DEAD = P0 + 2, root = new URL('..', import.meta.url).pathname, sleep = ms => new Promise(r => setTimeout(r, ms));
if ([8080, 8787, 3000].some(p => p >= P0 && p <= P0 + 2)) { console.log('refusing: that port range holds the player\'s own game'); process.exit(2); }
const J = o => JSON.stringify(o), SHOTS = path.join(root, 'test', 'ui-shots'); fs.mkdirSync(SHOTS, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };

// ---------- the fake /api: stats and sign-in on, a guest ----------
const apiAnswer = (q, r) => { const u = q.url.split('?')[0], send = (s, o) => { r.writeHead(s, { 'content-type': 'application/json' }); r.end(J(o)); };
  if (u === '/api/me') return send(200, { db: true, rkSignin: false, signin: { enabled: true, clientId: 'test-client.apps.googleusercontent.com' }, account: null, places: null });
  if (u === '/api/stats') return send(200, { profile: { guest: true, played: 0 } });
  if (u === '/api/leaderboard') return send(200, { board: 'rally', total: 0, rows: [] });
  return send(404, { error: 'nope' }); };
const web = http.createServer((q, r) => {
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
const SEAT = ['quick', 'create', 'join', 'rk', 'rkwarm', 'tcreate', 'ask', 'bot', 'twarm', 'tstart'];
const seats = () => frames.filter(m => SEAT.includes(m.type)).map(m => m.type + (m.code ? ':' + m.code : ''));
const watches = () => frames.filter(m => m.type === 'watch').map(m => m.code);

const CHROME = process.env.CHROME || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => fs.existsSync(p));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
const out = [], errs = [], ok = (c, what) => { out.push((c ? 'PASS ' : 'FAIL ') + what); if (!c) console.log('FAIL', what); };
setTimeout(() => { console.log(out.join('\n')); console.log('MOBILE UI FAIL (timeout)'); process.exit(2); }, 240000);
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const IPAD = 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const url = (q = '') => `http://127.0.0.1:${W}/web/index.html?uitest=1&acctest=1&cam=0&game=${G}&bridge=${DEAD}${q}`;
async function page(tag, { w = 390, h = 844, touch = true, ua = IPHONE, name = 'Tester' } = {}) {
  const pg = await browser.newPage(); await pg.emulate({ viewport: { width: w, height: h, deviceScaleFactor: 2, isMobile: touch, hasTouch: touch }, userAgent: ua || (await browser.userAgent()) });
  await pg.setRequestInterception(true); pg.on('request', q => (/google\.com|gstatic\.com/.test(q.url()) ? q.abort() : q.continue()));
  pg.on('pageerror', e => errs.push(`[${tag}] PAGEERROR ${e.message}`));
  pg.on('console', m => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED|ERR_FAILED|WebSocket connection|Failed to load resource/.test(m.text())) errs.push(`[${tag}] ${m.text()}`); });
  await pg.evaluateOnNewDocument(n => { try { if (n) localStorage.setItem('poddle.name', n); else localStorage.removeItem('poddle.name'); localStorage.setItem('poddle.camPrimer', 'allow'); localStorage.setItem('poddle.lbSeen', '2'); } catch {} }, name);
  return pg;
}
const ev = (pg, fn, ...a) => pg.evaluate(fn, ...a);
const state = pg => ev(pg, () => { const g = id => document.getElementById(id), shown = e => !!e && !e.closest('[hidden]') && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
  const tiles = [...document.querySelectorAll('#lobby-home .tile')].filter(shown).map(t => t.id);
  return { mobile: document.documentElement.hasAttribute('data-mobile'), screen: document.querySelector('.screen.is-active')?.id || null, view: window.__ui.lobbyView(), tiles, n: document.querySelector('#lobby-home .tiles')?.dataset.n,
    card: shown(g('m-pad')), back: shown(document.querySelector('#screen-lobby [data-back]')), title: g('lobby-title')?.textContent, nameRow: shown(g('name-row')), path: location.pathname + location.search,
    sideways: document.documentElement.scrollWidth > innerWidth + 1, join: shown(g('btn-join')), make: shown(g('btn-create')) || shown(g('btn-tour')), watchCode: shown(g('btn-watch-code')),
    rows: [...document.querySelectorAll('#room-list .court-row')].map(b => [b.dataset.code, b.querySelector('.court-go')?.textContent, b.dataset.act || '', b.getAttribute('aria-disabled') || ''].join(':')),
    rowWatch: document.querySelectorAll('#room-list .room-watch').length, ask: shown(g('btn-ask')) }; });

// ---------- 1. a phone lands on its home ----------
let pg = await page('phone');
await pg.goto(url(), { waitUntil: 'domcontentloaded' }); await sleep(2200);
let s = await state(pg);
ok(s.mobile && s.screen === 'screen-lobby' && s.view === 'home', `a phone skips the title for the lobby's home (${J({ mobile: s.mobile, screen: s.screen, view: s.view })})`);
ok(s.card && !s.back && s.title === 'Poddle' && !s.nameRow, `the paddle-code card shows; no Back, the header says Poddle, no name row (${J({ card: s.card, back: s.back, title: s.title, nameRow: s.nameRow })})`);
ok(J(s.tiles) === J(['btn-friends', 'btn-courts', 'btn-profile', 'btn-leaderboard']) && s.n === '4', `tiles: Friends, Watch a match, Your stats, Leaderboard; no Quick play, Ranked or Play a bot; data-n counts them (${J(s.tiles)} n=${s.n})`);
ok(!s.sideways, 'portrait: no sideways scroll');
await pg.screenshot({ path: path.join(SHOTS, 'mobile-home.png') });
{ const b = await ev(pg, () => { const r = document.getElementById('m-pad').getBoundingClientRect(), t = document.getElementById('btn-leaderboard').getBoundingClientRect(); return { l: r.left, r: innerWidth - r.right, bottom: t.bottom, h: innerHeight }; });
  ok(b.l >= 12 && b.r >= 12 && b.bottom <= b.h, `the card keeps a side gutter and the last tile is on screen without scrolling (${J(b)})`); }

// ---------- 2. Back at home stays home; a seat pressed by script sends nothing ----------
await pg.keyboard.press('Escape'); await sleep(400); await ev(pg, () => document.querySelector('#screen-lobby [data-back]').click()); await sleep(400);
s = await state(pg); ok(s.screen === 'screen-lobby' && s.view === 'home', `Esc and Back at home stay on the phone home (${s.screen} ${s.view})`);
await ev(pg, () => { for (const id of ['btn-quick', 'btn-bot']) document.getElementById(id).click(); }); await sleep(300);
await ev(pg, () => window.__ui.lobbyView('bot')); await sleep(200); await ev(pg, () => document.getElementById('btn-bot-1').click()); await sleep(300);
await ev(pg, () => window.__ui.lobbyView('ranked')); await sleep(200); await ev(pg, () => document.getElementById('btn-ranked-go')?.click()); await sleep(300);
await ev(pg, () => window.__ui.lobbyView('courts')); await sleep(200); await ev(pg, () => document.getElementById('btn-create').click()); await sleep(200); await ev(pg, () => document.getElementById('btn-create-go')?.click()); await sleep(300);
ok(seats().length === 0, `hidden Quick play, Play a bot, Ranked, Create court pressed by script: no seat frame reaches the game (${J(seats())})`);
{ const t = await ev(pg, () => [...document.querySelectorAll('#toast, .notices .notice')].map(e => e.textContent).join(' | ')); ok(/Play on a computer/.test(t), `and it says why ("${t.slice(0, 120)}")`); }
await ev(pg, () => window.__ui.lobbyView('home')); await sleep(300);

// ---------- 3. Courts: every row watches ----------
await pg.tap('#btn-courts'); await sleep(900);
s = await state(pg);
ok(s.view === 'courts' && !s.join && !s.make && s.watchCode && s.nameRow, `Courts on a phone: no Join, no Create court or tournament; Watch by code and the name row stay (${J({ view: s.view, join: s.join, make: s.make, watchCode: s.watchCode })})`);
ok(J(s.rows) === J(['TRNY:Watch:watch:', 'WXYZ:Watch:watch:', 'MATT:Watch:watch:']) && s.rowWatch === 0, `Open: the tournament, the waiting player and the Matt match all say Watch; the empty court is left out; no separate Watch pills (${J(s.rows)})`);
await pg.screenshot({ path: path.join(SHOTS, 'mobile-courts.png') });
frames.length = 0; await pg.tap('#room-list .court-row[data-code="WXYZ"]'); await sleep(500);
ok(J(watches()) === J(['WXYZ']) && !seats().length, `tapping the waiting player's row sends watch, never join (${J(frames.map(m => m.type + ':' + m.code))})`);
await pg.close();

// ---------- 4. the code boxes and a ?court= link watch ----------
pg = await page('phone-code'); frames.length = 0;
await pg.goto(url(), { waitUntil: 'domcontentloaded' }); await sleep(2000); await pg.tap('#btn-courts'); await sleep(700);
await pg.focus('#code-boxes .code-box'); await pg.keyboard.type('BUSY'); await pg.keyboard.press('Enter'); await sleep(500);
ok(J(watches()) === J(['BUSY']) && !seats().length, `a code typed in the boxes + Enter watches (${J(frames.map(m => m.type + ':' + m.code))})`);
await pg.close();
pg = await page('phone-link'); frames.length = 0;
await pg.goto(url('&court=WXYZ'), { waitUntil: 'domcontentloaded' }); await sleep(2200);
s = await state(pg);
ok(J(watches()) === J(['WXYZ']) && !seats().length, `a join link (?court=WXYZ) on a phone watches (${J(frames.map(m => m.type + ':' + m.code))})`);
await pg.close();
pg = await page('phone-noname', { name: '' }); frames.length = 0;
await pg.goto(url(), { waitUntil: 'domcontentloaded' }); await sleep(2000);
s = await state(pg); { const o = await ev(pg, () => ['btn-courts', 'btn-profile', 'btn-leaderboard'].map(id => getComputedStyle(document.getElementById(id)).opacity).join());
  ok(!s.nameRow && s.view === 'home' && o === '1,1,1', `no name yet: the phone home asks for none and dims nothing (${o})`); }
await pg.tap('#btn-courts'); await sleep(700); s = await state(pg);
ok(s.view === 'courts' && s.nameRow && await ev(pg, () => document.getElementById('screen-lobby').classList.contains('needs-name')), `Watch a match opens Courts without a name; the name row is there and the rows are dimmed until it has one (${s.view})`);
await pg.tap('#room-list .court-row[data-code="MATT"]'); await sleep(400);
ok(!frames.some(m => m.type === 'watch'), 'a row tapped with no name sends nothing (the name row asks)');
await pg.close();

// ---------- 5. the paddle code ----------
pg = await page('phone-pad');
await pg.goto(url(), { waitUntil: 'domcontentloaded' }); await sleep(2000);
await pg.tap('#m-pad-in'); await pg.keyboard.type('ab2');
let p = await ev(pg, () => ({ v: document.getElementById('m-pad-in').value, go: !document.getElementById('m-pad-go').disabled })); ok(p.v === 'AB2' && !p.go, `three characters: upper-cased, Go stays off (${J(p)})`);
await ev(pg, () => { const i = document.getElementById('m-pad-in'); i.value = 'p-ab2c'; i.dispatchEvent(new Event('input', { bubbles: true })); });
p = await ev(pg, () => ({ v: document.getElementById('m-pad-in').value, go: !document.getElementById('m-pad-go').disabled })); ok(p.v === 'AB2C' && p.go, `a pasted "p-ab2c" becomes AB2C (the P- is built in) and Go wakes (${J(p)})`);
await ev(pg, () => { const i = document.getElementById('m-pad-in'); i.value = 'IO01'; i.dispatchEvent(new Event('input', { bubbles: true })); });
p = await ev(pg, () => document.getElementById('m-pad-in').value); ok(p === '', `letters no code uses (I, O, 0, 1) are dropped ("${p}")`);
await ev(pg, () => { const i = document.getElementById('m-pad-in'); i.value = 'AB2C'; i.dispatchEvent(new Event('input', { bubbles: true })); });
await Promise.all([pg.waitForNavigation({ timeout: 5000 }).catch(() => {}), pg.tap('#m-pad-go')]); await sleep(600);
p = await ev(pg, () => ({ path: location.pathname + location.search, view: document.body.dataset.view, code: document.getElementById('start-code')?.textContent }));
ok(p.path === '/pad.html?k=AB2C' && p.view === 'start' && p.code === 'P-AB2C', `Go opens the paddle page on its Start screen with the code (${J(p)})`);
await pg.close();

// ---------- 6. landscape ----------
pg = await page('phone-land', { w: 844, h: 390 });
await pg.goto(url(), { waitUntil: 'domcontentloaded' }); await sleep(2200);
s = await state(pg);
{ const b = await ev(pg, () => { const c = document.getElementById('m-pad').getBoundingClientRect(), t = document.querySelector('#lobby-home .tiles').getBoundingClientRect(); return { side: c.right <= t.left + 1, keys: getComputedStyle(document.querySelector('#screen-lobby .keyhints-inline')).display }; });
  ok(s.mobile && s.view === 'home' && !s.sideways && b.side && b.keys === 'none', `a phone on its side: still the phone home, card beside the tiles, no sideways scroll, no Esc/F key hints (${J({ ...b, sideways: s.sideways })})`); }
await pg.screenshot({ path: path.join(SHOTS, 'mobile-land.png') });
await pg.close();

// ---------- 7. not a phone: the full game ----------
for (const [tag, o, q] of [['ipad', { w: 820, h: 1180, ua: IPAD }, ''], ['desktop', { w: 1280, h: 800, touch: false, ua: null }, ''], ['phone-full', {}, '&mobile=0']]) {
  pg = await page(tag, o); await pg.goto(url(q), { waitUntil: 'domcontentloaded' }); await sleep(1800);
  s = await state(pg);
  ok(!s.mobile && s.screen === 'screen-title', `${tag}: the title and Play as before, no phone home (${J({ mobile: s.mobile, screen: s.screen })})`);
  if (tag === 'desktop') { await pg.click('#btn-start'); await sleep(900); s = await state(pg);
    ok(J(s.tiles) === J(['btn-friends', 'btn-quick', 'btn-ranked', 'btn-courts', 'btn-bot', 'btn-profile', 'btn-leaderboard']) && !s.card && s.title === 'Play', `desktop lobby: Friends | Quick play | Ranked (NOTES 150), Play a bot, no paddle card, "Play" (${J(s.tiles)} ${s.title})`); }
  await pg.close();
}

ok(!errs.length, `no page errors (${errs.slice(0, 4).join(' / ')})`);
const bad = out.filter(l => l.startsWith('FAIL')).length;
console.log(out.join('\n'));
console.log(`${out.length - bad} passed, ${bad} failed`); console.log(bad ? 'MOBILE UI FAIL' : 'MOBILE UI PASSED');
await browser.close(); web.close(); for (const c of wss.clients) c.terminate(); wss.close(); process.exit(bad ? 1 : 0);
