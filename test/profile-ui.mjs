// Player stats client (docs/ACCOUNTS.md 9, test plan 12.4): web/profile.js + main.js + index.html against a fake game and a fake /api.
// The real page runs with ?acctest=1 (profile.js is off on localhost otherwise). Google is never reached: every request to
// accounts.google.com or gstatic.com is intercepted, recorded and aborted.
// Section F (docs/SHARE.md 3): the play row from profile.play and the Share card sheet against a fake /api/share. The fake's card picture at /c/<slug>.png is a committed render (CARD below).
// Usage: node test/profile-ui.mjs      PROFILE_UI_PORT=<base> moves the ports (default 9420: pages + /api, 9421: fake game, 9422: nothing = no AirPod).
import http from 'http'; import fs from 'fs'; import path from 'path'; import os from 'os';
import { WebSocketServer } from 'ws';
import puppeteer from 'puppeteer-core';
const P0 = +process.env.PROFILE_UI_PORT || 9420, W = P0, G = P0 + 1, DEAD = P0 + 2, root = new URL('..', import.meta.url).pathname, sleep = ms => new Promise(r => setTimeout(r, ms));
if ([8080, 8787, 3000].some(p => p >= P0 && p <= P0 + 2)) { console.log('refusing: that port range holds the player\'s own game'); process.exit(2); }
const J = o => JSON.stringify(o), UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };

// ---------- the fake /api (same origin as the page, as on poddleball.com) ----------
const day = Date.UTC(2026, 8, 20), rung = (level, name, wins, losses, streak, bestStreak, firstWinAt) => ({ level, name, wins, losses, abandons: 0, streak, bestStreak, firstWinAt, bestMargin: 0 });
const FIXTURE = { guest: true, since: day - 864e5, expiresAt: day + 90 * 864e5, played: 9,
  human: { wins: 3, losses: 2, streak: 1, bestStreak: 2, pointsWon: 50, pointsLost: 41 }, titles: 1,
  matt: [rung(0, 'Rookie', 3, 0, 3, 3, day), rung(1, 'Club', 1, 1, 0, 1, day + 3600e3), rung(3, 'Tour', 0, 2, 0, 0, null), rung(2, 'Pro', 0, 0, 0, 0, null)],   // BOT_ORDER [0, 1, 3, 2]
  bests: { rally: { v: 14, at: day }, hit: { v: 22, at: day }, speed: { v: 9.4, at: day } },
  play: { hits: 412, returns: 187, chances: 256, winners: 38, aces: 9, smashes: 21, pointsWon: 214, pointsLost: 173, secs: 4980 },      // play: docs/SHARE.md 1
  ladder: { trophies: 240, tier: 2, div: 2, floor: 150, next: 250, bestTrophies: 240, bestTier: 2, bestDiv: 2, bestTierAt: day, wins: 3, losses: 1, streak: 1, botWins: 9, botLosses: 4, mattDayLeft: 32 },      // the Ranked ladder (docs/RANKED.md 10.1 profileOf)
  share: null };      // share: the fake answers the live link in its place (API.slug)
const API = { signin: false, profile: FIXTURE, delClears: false, acct: null, stale: false, signoutFail: false, slug: null, slugs: 0, shareFail: false, log: [] };      // log: [method, path, body] in arrival order. delClears: DELETE /api/account empties the fake store (section D)
const apiAnswer = (q, body, r) => { const u = q.url.split('?')[0], send = (s, o) => { r.writeHead(s, { 'content-type': 'application/json' }); r.end(o === undefined ? '' : J(o)); };
  let b = null; try { b = body ? JSON.parse(body) : null; } catch { b = null; } API.log.push([q.method, u, b]);
  if (u === '/api/me') return send(200, { db: true, signin: { enabled: API.signin, clientId: API.signin ? 'test-client.apps.googleusercontent.com' : null }, account: API.acct });
  const link = () => { const url = `http://127.0.0.1:${W}/c/${API.slug}`; return { url, image: `${url}.png?v=${API.slugs}` }; };      // the real shape (server/share.js): <url>.png?v=<hash>; the fake's hash is the slug count
  if (u === '/api/stats') { const p = b && b.dev ? API.profile : null; return send(200, { profile: p && 'share' in p ? { ...p, share: API.slug ? link() : null } : p }); }      // no share key in the profile: an older server, left as it is
  if (u === '/api/share' && q.method === 'POST') { if (API.shareFail) return send(503, { error: 'unavailable' }); if (!b || !b.dev || !API.profile) return send(404, { error: 'nothing' });
    if (!API.slug) API.slug = 'Ab3' + String(++API.slugs).padStart(7, 'x'); return send(200, link()); }      // one live link: the same answer until DELETE, then a new slug
  if (u === '/api/share' && q.method === 'DELETE') { API.slug = null; r.writeHead(204); return r.end(); }
  if (u === '/api/signin/nonce') return send(200, { nonce: 'n'.repeat(32) });
  if (u === '/api/account' && q.method === 'DELETE') { if (API.delClears) API.profile = null; return send(200, { deleted: { account: !!API.acct && !API.stale, device: !!(b && b.dev) } }); }      // the real route's shape: what it deleted
  if (u === '/api/signout' && q.method === 'POST') { if (API.signoutFail) return send(500, { error: 'internal' }); r.writeHead(204); return r.end(); }
  if (u === '/api/export' && q.method === 'POST') { if (!b || !b.dev || !API.profile) return send(404, { error: 'nothing' });      // the real route's shape: JSON attachment named poddle-data-<day>.json
    r.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': 'attachment; filename="poddle-data-2026-09-24.json"' }); return r.end(J({ exportedAt: day, profile: API.profile })); }
  return send(404, { error: 'nope' }); };
const CARD = path.join(root, 'test/ui-shots/share/veteran.png');      // a card server/card.js drew (test/share-shots.mjs), served for every live /c/<slug>.png
const web = http.createServer((q, r) => {
  if (/^\/c\/[A-Za-z0-9]{10}\.png(\?|$)/.test(q.url)) { const live = API.slug && q.url.startsWith(`/c/${API.slug}.png`); r.writeHead(live ? 200 : 404, { 'content-type': 'image/png' }); return r.end(live ? fs.readFileSync(CARD) : ''); }      // a dead link's picture is gone, as on the real server
  if (q.url.startsWith('/api/')) { let body = ''; q.on('data', c => { body += c; }); q.on('end', () => apiAnswer(q, body, r)); return; }
  let f = path.join(root, decodeURIComponent(q.url.split('?')[0])); if (!f.startsWith(root)) { r.writeHead(403); return r.end(); } if (f.endsWith('/')) f += 'index.html';
  const serve = (g, next) => fs.readFile(g, (e, d) => { if (e && next) return next(); r.writeHead(e ? 404 : 200, { 'content-type': MIME[path.extname(g)] || 'application/octet-stream' }); r.end(e ? '' : d); });
  serve(f, () => serve(path.join(root, 'web', decodeURIComponent(q.url.split('?')[0])), null)); }).listen(W, '127.0.0.1');      // a page under /web/ asks for /site.webmanifest, /how-to-play.css, /data-tools.js at the root, as the real server serves them

// ---------- the fake game: a lobby list, Quick play seats you at side 0. socks[] keeps every socket's URL and frames ----------
const COURT = { halfW: 3.05, halfL: 6.7, kitchen: 2.13, net: 0.91 }, LIST = { type: 'lobby', online: 2, rooms: [] }, socks = [];
const wss = new WebSocketServer({ port: G, host: '127.0.0.1' });
wss.on('connection', (ws, req) => { const s = { ws, url: req.url, frames: [] }; socks.push(s); ws.send(J(LIST));
  ws.on('message', raw => { let m; try { m = JSON.parse(raw); } catch { return; } if (m.type === 'ping') return ws.send(J({ type: 'pong', c: m.c })); s.frames.push(m);
    if (m.type === 'quick' || m.type === 'join' || m.type === 'create') { ws.send(J({ type: 'room', code: 'QQQQ', public: m.type !== 'create', role: 'player' })); ws.send(J({ type: 'welcome', side: 0, role: 'player', court: COURT, names: [m.name || 'Player 1', null], reg: [false, false] })); } }); });      // create: Play a bot's private court (the Next button); the page sends 'bot' with the level right after the welcome });
const last = () => socks[socks.length - 1], push = m => { const s = last(); if (s && s.ws.readyState === 1) s.ws.send(J(m)); };

const CHROME = process.env.CHROME || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => fs.existsSync(p));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const out = [], errs = [], ok = (c, what) => { out.push((c ? 'PASS ' : 'FAIL ') + what); if (!c) console.log('FAIL', what); };
setTimeout(() => { console.log(out.join('\n')); console.log('PROFILE UI FAIL (timeout)'); process.exit(2); }, 420000);
const google = [];      // every request to Google, in order
async function page(tag) { const pg = await browser.newPage(); await pg.setViewport({ width: 1280, height: 720 }); await pg.setRequestInterception(true);
  pg.on('request', q => { const u = q.url(); if (/^https:\/\/([a-z0-9-]+\.)*(accounts\.google\.com|gstatic\.com)\//.test(u)) { google.push(u); return q.abort(); } q.continue(); });
  pg.on('pageerror', e => errs.push(`[${tag}] PAGEERROR ${e.message}`));
  pg.on('console', m => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED|ERR_FAILED|WebSocket connection|Failed to load resource/.test(m.text())) errs.push(`[${tag}] ${m.text()}`); });
  return pg; }
const URL0 = `http://127.0.0.1:${W}/web/index.html?uitest=1&acctest=1&cam=0&game=${G}&bridge=${DEAD}`;
const ev = (pg, fn, ...a) => pg.evaluate(fn, ...a), dev = pg => ev(pg, () => localStorage.getItem('poddle.device'));
const seen = (pg, id) => ev(pg, i => { const e = document.getElementById(i); if (!e) return false; const r = e.getBoundingClientRect(), c = getComputedStyle(e); return !e.closest('[hidden]') && r.width > 0 && c.visibility !== 'hidden' && c.display !== 'none'; }, id);

// ---------- A. ui-mock: the markup without any of the stats elements. ui.js must not care (they are optional) ----------
{ const pg = await page('mock'); await pg.goto(`http://127.0.0.1:${W}/test/ui-mock.html?screen=lobby`); await pg.waitForFunction(() => document.title.startsWith('ready'), { timeout: 15000 }).catch(() => {});
  const r = await ev(pg, () => { const ids = ['btn-profile', 'lobby-profile', 'result-save', 'signin-card', 'btn-ranked', 'lobby-ranked', 'rk-pill'], ui = window.__ui; let threw = '';
    for (const id of ids) document.getElementById(id)?.remove();
    try { ui.showScreen('lobby'); ui.setNames({ me: 'You', them: 'Bob', reg: [false, true], rank: [2, 3] }); ui.settings(true); ui.settings(false); ui.tilesFit(); ui.rkTile({ tier: 2, trophies: 240, queued: 1 }); ui.rkView({ tier: 2, trophies: 240 }); ui.rkNote('x'); ui.rkSearch(true); ui.rkPill({ on: true }); ui.rkCourt('warm'); ui.rkCourt(null); ui.lobbyView('ranked'); ui.showScreen('title'); } catch (e) { threw = e.message; }
    return { left: ids.filter(i => document.getElementById(i)), threw, ui: typeof ui }; });
  ok(r.ui === 'object' && !r.left.length && !r.threw, `ui-mock: no #btn-profile/#lobby-profile/#result-save/#signin-card/#btn-ranked/#lobby-ranked/#rk-pill and ui.js still runs (${r.threw || 'no throw'})`);
  await pg.close(); }

// ---------- B. sign-in OFF: first load, lobby, first seat, the result card, names ----------
let pg = await page('off'), id0 = '';
await pg.evaluateOnNewDocument(() => { try { if (!sessionStorage.getItem('t.init')) { sessionStorage.setItem('t.init', '1'); localStorage.clear(); } localStorage.setItem('poddle.name', 'Daniel'); localStorage.setItem('poddle.camPrimer', 'allow'); } catch {} });
await pg.goto(URL0); await sleep(2200);
let r = await ev(pg, () => ({ screen: document.body.dataset.screen, dev: localStorage.getItem('poddle.device') }));
ok(r.screen === 'title' && r.dev === null, `load: title screen, no poddle.device (${r.screen}, ${r.dev})`);
ok(!google.length, `load: nothing requested from Google (${google})`);
r = []; for (const id of ['btn-set-signin', 'btn-pf-signin', 'btn-save-signin', 'signin-card', 'acct-layer']) if (await seen(pg, id)) r.push(id);
ok(!r.length, `sign-in off: no sign-in control visible (${r})`);
await pg.click('#btn-start'); await sleep(900);
r = await ev(pg, () => ({ screen: document.body.dataset.screen, dev: localStorage.getItem('poddle.device') }));
ok(r.screen === 'lobby' && r.dev === null, `lobby: still no poddle.device (${r.screen}, ${r.dev})`);
ok(API.log.some(l => l[1] === '/api/me') && !API.log.some(l => l[1] === '/api/stats'), `load: /api/me asked, /api/stats not (no id yet): ${J(API.log.map(l => l[1]))}`);
await pg.click('#btn-quick'); await sleep(400); if (!last().frames.some(f => f.type === 'quick')) { await pg.keyboard.press('Enter'); await sleep(300); await pg.keyboard.press('Enter'); } await sleep(1200);
id0 = await dev(pg); { const f = last().frames.filter(x => x.type !== 'ping'), q = f.findIndex(x => x.type === 'quick');
  ok(UUID4.test(id0 || ''), `first seat (welcome): poddle.device is a v4 UUID (${id0})`);
  ok(q >= 0 && f[q + 1] && f[q + 1].type === 'hello' && f[q + 1].dev === id0 && f[q + 1].v === 1, `a hello with the id follows the seat at once (${J(f.map(x => x.type))})`); }
ok(socks.every(s => !id0 || !s.url.includes(id0)), `the id is never in a WebSocket URL (${socks.map(s => s.url).join(' ')})`);

// the result card: matchover, then my 'profile' line. created:true shows the one-time notice; the nudge needs sign-in on
const card = () => ev(pg, () => { const h = id => { const e = document.getElementById(id); return !e || e.hidden; }; return { box: !h('result-save'), text: document.getElementById('result-save-text')?.textContent || '', notice: !h('result-notice'), nudge: !h('btn-save-signin') }; });
push({ type: 'matchover', winner: 0, score: [11, 5], forfeit: false, rematchBy: 20, reg: [false, false] }); await sleep(150);
push({ type: 'profile', saved: true, guest: true, ranked: true, first: true, level: 3, created: true, nudge: true, streak: 1, bests: [], why: [] }); await sleep(400);
r = await card(); ok(r.box && r.text === 'First win against Tour Matt!' && r.notice && !r.nudge, `profile after matchover: "${r.text}", notice ${r.notice}, no nudge with sign-in off (${r.nudge})`);
push({ type: 'matchover', winner: 0, score: [11, 9], forfeit: false, rematchBy: 20, reg: [false, false] }); await sleep(150);
push({ type: 'profile', saved: true, guest: true, ranked: true, first: false, level: 3, streak: 2, bests: [], why: [] }); await sleep(400);
r = await card(); ok(r.box && r.text === '2 wins in a row' && !r.notice, `a later profile without created: "${r.text}", no notice (${r.notice})`);
push({ type: 'matchover', winner: 1, score: [4, 11], forfeit: false, rematchBy: 20, reg: [false, false] }); await sleep(150);
push({ type: 'profile', saved: true, guest: true, ranked: false, why: ['self'] }); await sleep(400);
r = await card(); ok(r.text === 'Matches against yourself don’t count', `unranked: the reason (${r.text})`);
push({ type: 'matchover', winner: 1, score: [4, 11], forfeit: false, rematchBy: 20, reg: [false, false] }); await sleep(150);
push({ type: 'profile', saved: false }); await sleep(400); r = await card(); ok(!r.box, `saved:false says nothing (${J(r)})`);

// names: a guest's ✓ is text the server would strip anyway; the badge is only ever the .reg-badge element, beside the name
const P = z => ({ x: 0, y: 1, z, q: [0, 0, 0, 1], bot: false });      // a human on each side: the scoreboard names the opponent
push({ type: 'state', t: 1, p: [0, 1, 0], v: [0, 0, 0], live: false, serving: 0, score: [0, 0], paddles: [P(6.5), P(-6.5)] }); await sleep(150);
push({ type: 'names', names: ['Daniel', 'Ann✓'], reg: [false, false] }); await sleep(400);
r = await ev(pg, () => ({ them: document.getElementById('name-them').textContent, badges: document.querySelectorAll('.reg-badge').length }));
ok(!r.them.includes('✓') && r.them.startsWith('Ann') && r.badges === 0, `guest "Ann✓": shown as "${r.them}", ${r.badges} .reg-badge`);
push({ type: 'names', names: ['Daniel', 'Bobby'], reg: [false, true] }); await sleep(400);
r = await ev(pg, () => ({ text: document.getElementById('name-them').textContent, all: document.querySelectorAll('.reg-badge').length, dev: document.getElementById('name-them').classList.contains('is-dev') }));
ok(r.text === 'Bobby' && r.all === 0 && !r.dev, `a registered seat gets no mark on its own ("${r.text}", ${J(r)})`);
push({ type: 'names', names: ['Daniel', 'Dan'], reg: [false, true] }); await sleep(400);      // the developer's username (ui.js DEV_NAMES): a DEV pill beside the name, the name in orange
r = await ev(pg, () => { const n = document.getElementById('name-them'), b = n.nextElementSibling; return { text: n.textContent, badge: !!b && b.classList.contains('reg-badge') && b.textContent === 'DEV', inName: !!n.querySelector('.reg-badge'), all: document.querySelectorAll('.reg-badge').length, dev: n.classList.contains('is-dev'), color: getComputedStyle(n).color }; });
ok(r.text === 'Dan' && r.badge && !r.inName && r.all === 1 && r.dev, `the developer's seat: a DEV pill beside the name, not in its text, the name in orange ("${r.text}", ${J(r)})`);
push({ type: 'names', names: ['Daniel', 'Dan'], reg: [false, false] }); await sleep(300);      // a guest typing Dan: nothing (the server would show Player 2 for look-alikes of staff anyway)
ok(await ev(pg, () => document.querySelectorAll('.reg-badge').length === 0 && !document.getElementById('name-them').classList.contains('is-dev')), 'a guest named Dan gets no pill and no orange');
push({ type: 'names', names: ['Daniel', 'Dan'], reg: [false, true] }); await sleep(300);
// the court list, the tournament chips and the bracket draw it too, from the server's reg fields (room info reg:[a,b], tour players/sides reg:bool)
r = await ev(pg, () => { const ui = window.__ui, q = (s, sel) => { const e = document.querySelector(s); return e ? e.querySelectorAll(sel).length : -1; };
  ui.lobbyRooms([{ code: 'RRRR', players: 1, open: true, watch: 5, watchers: 0, score: [0, 0], live: false, names: ['Dan', null], reg: [true, false] }, { code: 'GGGG', players: 1, open: true, watch: 5, watchers: 0, score: [0, 0], live: false, names: ['Gus', null], reg: [false, false] }], 3, []);
  const side = (id, name, reg) => ({ id, name, bot: false, reg });
  ui.setTour({ code: 'TTTT', phase: 'play', min: 4, max: 16, n: 2, win: 7, final: 11, host: 'Daniel', you: { id: 1, host: true, out: false, viewer: false, warm: 'off' },
    players: [{ id: 1, name: 'Daniel', reg: false, host: true, on: true }, { id: 2, name: 'Dan', reg: true, on: true }],
    rounds: [{ name: 'Final', target: 11, matches: [{ n: 1, a: side(1, 'Daniel', false), b: side(2, 'Dan', true), room: null, score: [0, 0], live: false, w: null, forfeit: false, watchers: 0 }] }], next: null, champ: null });
  const o = { courts: q('#room-list', '.reg-badge'), courtText: [...document.querySelectorAll('#room-list .court-who')].map(e => { const c = e.cloneNode(true); c.querySelectorAll('.reg-badge').forEach(x => x.remove()); return c.textContent; }), chips: q('#tour-names', '.reg-badge'), bracket: q('#bracket', '.reg-badge'),
    brNext: document.querySelector('#bracket .br-name + .reg-badge') ? document.querySelector('#bracket .br-name + .reg-badge').previousElementSibling.textContent : '' };
  ui.setTour(null); ui.lobbyRooms([], 2, []); return o; });
ok(r.courts === 1 && r.chips === 1 && r.bracket === 1 && r.brNext === 'Dan' && r.courtText.some(t => t === 'Dan is waiting'), `court list, chips, bracket: one .reg-badge each, beside the developer's name only (${J(r)})`);
// a username locks both name fields; Settings > You gets its own Change (9.5), gone again for a guest
r = await ev(pg, () => { const ui = window.__ui, g = id => document.getElementById(id); ui.lockName('Bobby'); const on = { ro: g('set-name-input').readOnly, btn: !g('btn-set-name-change').hidden, lobbyBtn: !g('btn-name-change').hidden };
  ui.lockName(null); return { on, off: { ro: g('set-name-input').readOnly, btn: !g('btn-set-name-change').hidden } }; });
ok(r.on.ro && r.on.btn && r.on.lobbyBtn && !r.off.ro && !r.off.btn, `username: Settings name read-only with its own Change, a guest's editable with none (${J(r)})`);

// a reload: the id is kept and is the FIRST frame of the new socket
{ const n = socks.length; await pg.reload(); await sleep(2500); const s = socks.slice(n).find(x => x.frames.length), f = s ? s.frames.filter(x => x.type !== 'ping') : [];
  ok(await dev(pg) === id0 && f[0] && f[0].type === 'hello' && f[0].dev === id0, `after a reload the first frame is the hello with the same id (${J(f.slice(0, 2).map(x => x.type))})`);
  ok(socks.every(s => !s.url.includes(id0)), 'the id is in no WebSocket URL after the reload either'); }

// ---------- Your stats: the fixture drawn (four rungs in BOT_ORDER, chips, bests) ----------
await pg.close(); pg = await page('stats');      // a new tab: same browser storage (the id), no court to rejoin
await pg.evaluateOnNewDocument(() => { try { localStorage.setItem('poddle.name', 'Daniel'); localStorage.setItem('poddle.camPrimer', 'allow'); } catch {} });
await pg.goto(URL0); await sleep(2200); await pg.click('#btn-start'); await sleep(900);
// the five tiles (docs/RANKED.md 1.1) lay out as a hero row of two over a utility row of three, as 2 / 1 / 1 / 1 in portrait, or a single column: never a lone straggler
const SIZES = [[1920, 1080], [1280, 720], [1024, 768], [900, 700], [760, 600], [1366, 500], [700, 900], [600, 900], [390, 844]];
const rows = () => ev(pg, () => { const t = [...document.querySelectorAll('#lobby-home .tile')].filter(e => !e.hidden).map(e => e.offsetTop), m = new Map();      // offsetTop: the focused or hovered tile is lifted by a transform
  for (const y of t) m.set(y, (m.get(y) || 0) + 1); return { n: t.length, rows: [...m.values()], over: document.querySelector('#lobby-home .tiles').scrollWidth > innerWidth, dn: document.querySelector('#lobby-home .tiles').dataset.n }; });
{ const bad = []; for (const [w, h] of SIZES) { await pg.setViewport({ width: w, height: h }); await sleep(250); const r = await rows();
    if (r.n !== 5 || r.dn !== '5' || !['2,3', '2,1,1,1', '1,1,1,1,1'].includes(r.rows.join()) || r.over) bad.push(`${w}x${h}: ${J(r)}`); }
  ok(!bad.length, `home tiles: 5 as 2 over 3, 2 / 1 / 1 / 1 or one column at ${SIZES.length} window sizes${bad.length ? ' (' + bad.join('; ') + ')' : ''}`); }
await pg.setViewport({ width: 1280, height: 720 }); await sleep(250);
r = await ev(pg, () => ({ tile: !document.getElementById('btn-ranked').hidden, line: document.getElementById('ranked-line-text').textContent, noRow: !document.getElementById('btn-set-ranked') }));
ok(r.tile && r.noRow, `with a database the Ranked tile shows; Settings has no Ranked row (NOTES 109: stats rows left Settings) (tile ${r.tile}, no row ${r.noRow})`);
// the Ranked view (docs/RANKED.md 2): from the tile, from Settings > You; the head and the road from /api/stats; it fits every size
await ev(pg, () => document.getElementById('btn-ranked').click()); await sleep(1500);
r = await ev(pg, () => ({ view: !document.getElementById('lobby-ranked').hidden, title: document.getElementById('lobby-title').textContent, tier: document.getElementById('rk-tier').textContent, n: document.getElementById('rk-trophies').textContent, next: document.getElementById('rk-next').textContent,
  road: [...document.querySelectorAll('#rk-road .rk-step')].map(l => l.querySelector('b').textContent + (l.classList.contains('is-now') ? '*' : l.classList.contains('is-done') ? '+' : '')), now: [...document.querySelectorAll('#rk-road .rk-step')].findIndex(l => l.classList.contains('is-now')), reached: document.querySelector('#rk-road .rk-step.is-now')?.title || '', pips: [...document.querySelectorAll('#rk-road .rk-step')].map(l => l.querySelectorAll('.rk-pips .is-lit').length).join(), line: document.getElementById('ranked-line-text').textContent, venue: document.body.dataset.venue, go: document.getElementById('btn-ranked-go').disabled }));
ok(r.view && r.title === 'Ranked' && r.tier === 'Silver II' && r.n === '240' && r.next === '10 to Silver III' && r.road.length === 7 && r.now === 1 && r.road[0] === 'Bronze+' && r.road[6] === 'Pro' && !r.go && r.pips === '3,2,0,0,0,0,0', `the Ranked view from the fixture: ${r.tier} ${r.n}, "${r.next}", the road ${J(r.road)}, pips ${r.pips}`);
ok(/^Reached on /.test(r.reached) && r.line === 'Silver II · 240' && r.venue === 'stadium', `the current step says when it was reached ("${r.reached}"), the tile's line "${r.line}", the stadium behind the glass (${r.venue})`);
ok(API.log.some(l => l[1] === '/api/stats' && l[2] && l[2].dev === id0), 'the Ranked view asks /api/stats with the device id in the body');
{ const bad = []; for (const [w, h] of SIZES) { await pg.setViewport({ width: w, height: h }); await sleep(250);
    const r = await ev(pg, () => { const v = document.getElementById('lobby-ranked'), b = v.getBoundingClientRect(), cut = [...v.querySelectorAll('.rk-step b, .rk-step small, #rk-next, #rk-status')].filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.textContent.slice(0, 30)), rg = document.createRange(); rg.selectNodeContents(document.getElementById('btn-ranked-go'));
      return { left: Math.round(b.left), right: Math.round(b.right), top: Math.round(b.top), bottom: Math.round(b.bottom), w: innerWidth, h: innerHeight, cut, goLines: new Set([...rg.getClientRects()].map(r => Math.round(r.top))).size }; });      // goLines: how many rows the button's words take
    if (r.left < 0 || r.right > r.w || r.top < 0 || r.bottom > r.h || r.cut.length || r.goLines > 1) bad.push(`${w}x${h}: ${J(r)}`); }
  ok(!bad.length, `the Ranked view fits at ${SIZES.length} window sizes, nothing clipped, Find a match on one line${bad.length ? ' (' + bad.join('; ') + ')' : ''}`);
  await pg.setViewport({ width: 1280, height: 720 }); await sleep(250); }
await ev(pg, () => document.querySelector('#screen-lobby [data-back]').click()); await sleep(600);
r = await ev(pg, () => ({ view: !document.getElementById('lobby-home').hidden, venue: document.body.dataset.venue })); ok(r.view && r.venue === 'park', `Back from the view: home, the park again (${r.venue})`);
await ev(pg, () => document.getElementById('btn-profile').click()); await sleep(1500);
r = await ev(pg, () => ({ view: !document.getElementById('lobby-profile').hidden, rungs: [...document.querySelectorAll('#pf-rungs > li')].map(l => [l.querySelector('b')?.textContent, l.querySelector('small')?.textContent, l.className, l.dataset.level]),
  badge: document.getElementById('st-mbadge').className, best: document.getElementById('st-mbest').textContent, mcap: document.getElementById('st-mcap').textContent, road: !!document.querySelector('.st-road, #btn-pf-next'), bests: document.getElementById('pf-bests').textContent, human: document.getElementById('pf-human').textContent,
  w: document.getElementById('st-w').textContent, l: document.getElementById('st-l').textContent, rank: document.getElementById('st-rank').textContent, trophies: document.getElementById('st-trophies').textContent, em: document.querySelector('#st-crest .st-em')?.dataset.div, cap: document.getElementById('st-rank-cap').textContent, streak: document.getElementById('st-streak').textContent.replace(/\s+/g, ' ').trim(), crest: document.getElementById('st-crest').className}));
ok(r.view && J(r.rungs.map(x => x[0])) === J(['Rookie', 'Club', 'Tour', 'Pro']) && J(r.rungs.map(x => x[3])) === J(['0', '1', '3', '2']), `Your stats: a Matt chip a level in difficulty order, Rookie, Club, Tour, Pro (${J(r.rungs.map(x => x[0] + ':' + x[3]))})`);
ok(r.best === 'Club Matt' && r.badge === 'st-mbadge is-lv1' && /^Beaten /.test(r.mcap) && !r.road, `the Matt badge: the toughest beaten is Club, no road and no Next button ("${r.best}", ${r.badge}, "${r.mcap}", road ${r.road})`);
ok(J(r.rungs.map(x => x[2])) === J(['st-mlv is-won', 'st-mlv is-won is-top', 'st-mlv', 'st-mlv']) && /^3-0 · streak 3$/.test(r.rungs[0][1]) && r.rungs[2][1] === '0-2', `Matt chips: Rookie and Club ticked, Club outlined as the badge, records drawn (${J(r.rungs)})`);
ok(r.rank === 'Silver II' && r.crest === 'st-crest is-rk is-silver' && r.trophies === '240' && /· 10 to Silver III$/.test(r.cap) && /^3 win streak vs Rookie Matt · best 3$/.test(r.streak) && r.em === '2', `hero: the Ranked ladder (one rank per player): Silver II with 240 trophies, 10 to Silver III, the crest wears the Silver emblem with the II tag; the hottest streak is 3 vs Rookie Matt (${r.rank}, ${r.crest}, ${r.em}, "${r.cap}", "${r.streak}")`);
{ // the crest is a link to the Ranks page (every medal), and Back comes home to Your stats
  await ev(pg, () => document.getElementById('st-crest').click()); await sleep(700);
  const k = await ev(pg, () => ({ view: window.__ui.lobbyView(), cards: document.querySelectorAll('#rkx-grid .rkx-card').length, now: document.querySelector('#rkx-grid .rkx-card.is-now')?.dataset.tier, tag: document.querySelector('#rkx-grid .rkx-tag.is-now')?.textContent, done: document.querySelectorAll('#rkx-grid .rkx-card.is-done').length, venue: document.body.dataset.venue, role: document.getElementById('st-crest').getAttribute('role') }));
  ok(k.view === 'ranks' && k.cards === 7 && k.now === '2' && k.tag === 'You · Silver II' && k.done === 1 && k.venue === 'stadium' && k.role === 'button', `the crest opens Ranks: seven medals, Silver II ringed, Bronze reached, in the stadium (${J(k)})`);
  await ev(pg, () => document.querySelector('#screen-lobby [data-back]').click()); await sleep(700);
  const b = await ev(pg, () => ({ view: window.__ui.lobbyView(), venue: document.body.dataset.venue }));
  ok(b.view === 'profile' && b.venue === 'park', `Back from Ranks: Your stats again, in the park (${J(b)})`); }
ok(r.bests.includes('14 hits') && r.bests.includes('540°/s') && !r.bests.includes('Hardest') && r.w === '3' && r.l === '2' && r.human.includes('60% won') && r.human.includes('50-41') && r.human.includes('Streak 1') && r.human.includes('Best 2'), `bests and the human record drawn (${r.bests.slice(0, 80)} | ${r.human.slice(0, 80)})`);
ok(API.log.some(l => l[1] === '/api/stats' && l[2] && l[2].dev === id0), 'Your stats asks /api/stats with the device id in the body');
{ // the panel fits every window: inside the viewport's width, and no rung line or chip cut short with an ellipsis
  const bad = []; for (const [w, h] of SIZES) { await pg.setViewport({ width: w, height: h }); await sleep(250);
    const r = await ev(pg, () => { const v = document.getElementById('lobby-profile'), b = v.getBoundingClientRect(), cut = [...v.querySelectorAll('.st-mlv b, .st-mlv small, .st-mbest, .st-cap > span, .st-rank-name, .st-ribbon, .st-chip, .st-bar-l, .st-bar-r, .st-fig dt, .st-fig dd, .st-ret-n, .pf-share span')].filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.textContent.slice(0, 30));
      const wide = [...v.querySelectorAll('*')].filter(e => { const q = e.getBoundingClientRect(); return q.width && (q.left < b.left - 1 || q.right > b.right + 1); }).map(e => (e.id || e.className || e.tagName).toString().slice(0, 30));      // nothing pokes out of the panel (the crest's rays are masked, they may)
      return { left: Math.round(b.left), right: Math.round(b.right), w: innerWidth, cut, wide: wide.filter(c => !/st-rays/.test(c)) }; });
    if (r.left < 0 || r.right > r.w || r.cut.length || r.wide.length) bad.push(`${w}x${h}: ${J(r)}`); }
  ok(!bad.length, `Your stats fits at ${SIZES.length} window sizes, nothing clipped${bad.length ? ' (' + bad.join('; ') + ')' : ''}`);
  await pg.setViewport({ width: 1280, height: 720 }); await sleep(250); }

// ---------- Save my stats lives on the privacy page: Delete my data there carries the id, then the switch off drops the id and sets the key ----------
{ const s = await ev(pg, () => ({ tog: !!document.getElementById('tog-save-stats'), row: !!document.getElementById('btn-set-stats') })); ok(!s.tog && !s.row, 'Settings has no Save my stats switch and no Your stats row'); }
await pg.goto(`http://127.0.0.1:${W}/web/privacy.html#your-data`); await sleep(900);
const n0 = API.log.length; await ev(pg, () => document.getElementById('btn-delete').click()); await sleep(200); await ev(pg, () => document.getElementById('btn-delete-yes').click()); await sleep(900);
{ const del = API.log.slice(n0).find(l => l[0] === 'DELETE' && l[1] === '/api/account'), d = await dev(pg);
  ok(!!del && del[2] && del[2].dev === id0 && d === null, `privacy page Delete: DELETE /api/account with the old id (${J(del && del[2])}), then no poddle.device (${d})`); }
await ev(pg, () => { const t = document.getElementById('tog-stats'); t.checked = false; t.dispatchEvent(new Event('change')); }); await sleep(200);
{ const on = await ev(pg, () => localStorage.getItem('poddle.stats.on')), st = await ev(pg, () => document.getElementById('data-status').textContent); ok(on === '0' && /Stats are off/.test(st), `the switch off: stats.on '${on}', "${st.slice(0, 40)}"`); }
await pg.goto(URL0); await sleep(2200);
{ // stats off: a new seat makes no id and sends no hello, not even on a new socket
  await ev(pg, () => window.__ui.showScreen('title')); await sleep(200); await pg.click('#btn-start').catch(() => {}); await sleep(800); const n = socks.length; await pg.reload(); await sleep(2400); await pg.click('#btn-start').catch(() => {}); await sleep(800);
  await pg.click('#btn-quick').catch(() => {}); await sleep(1400); const f = socks.slice(n).flatMap(s => s.frames);
  ok(f.some(x => x.type === 'quick' || x.type === 'join') && !f.some(x => x.type === 'hello') && await dev(pg) === null, `stats off: a seat after a reload sends no hello and makes no id (${J(f.map(x => x.type))})`);
  ok(socks.slice(n).every(s => s.frames[0] && s.frames[0].type === 'nostats'), `stats off: every new socket says nostats first, so a signed-in socket records nothing either (${J(socks.slice(n).map(s => s.frames[0] && s.frames[0].type))})`); }
await pg.close();

// ---------- C. sign-in ON: nothing goes to Google until the age box is ticked; then gsi/client (aborted here) and the failure text ----------
API.signin = true; google.length = 0; pg = await page('on');
await pg.evaluateOnNewDocument(() => { try { localStorage.setItem('poddle.name', 'Daniel'); localStorage.setItem('poddle.camPrimer', 'allow'); } catch {} });
await pg.goto(URL0); await sleep(2200);
ok(!google.length, `sign-in on, load: nothing requested from Google (${google})`);
await ev(pg, () => window.__ui.settings(true)); await sleep(500);
ok(await ev(pg, () => !document.getElementById('btn-set-signin').hidden), 'sign-in on: Settings has the Sign in with Google row');
await ev(pg, () => document.getElementById('btn-set-signin').click()); await sleep(900);
await sleep(1500);
r = await ev(pg, () => ({ card: !document.getElementById('acct-layer').hidden && !document.getElementById('signin-card').hidden, err: document.getElementById('signin-err').textContent, age: !!document.getElementById('signin-age') }));
ok(r.card && !r.age && google.some(u => u.startsWith('https://accounts.google.com/gsi/client')) && /could not load/.test(r.err), `the sign-in card opens (no age box) and only then is gsi/client requested (${google[0]}), aborted -> "${r.err}"`);
// the nudge shows only with sign-in on, for a guest, after a win outside a tournament
await ev(pg, () => document.getElementById('btn-signin-close').click()); await sleep(300); await ev(pg, () => window.__ui.settings(false)); await sleep(200);
await pg.click('#btn-start').catch(() => {}); await sleep(800); await pg.click('#btn-quick').catch(() => {}); await sleep(1400);
push({ type: 'matchover', winner: 0, score: [11, 5], forfeit: false, rematchBy: 20, reg: [false, false] }); await sleep(150);
push({ type: 'profile', saved: true, guest: true, ranked: true, first: true, level: 0, nudge: true, bests: [], why: [] }); await sleep(400);
r = await ev(pg, () => { const b = document.getElementById('btn-save-signin'); return { shown: !b.hidden, text: b.textContent, focus: document.activeElement?.id || '' }; });
ok(r.shown && r.text === 'Sign in to keep this win' && r.focus !== 'btn-save-signin', `nudge: "${r.text}" shown, focus not taken (${r.focus || 'body'})`);
await pg.close();

// ---------- D. Your stats with a saved profile: screenshots, Download my data (a JSON file), Delete my data (the panel empties) ----------
{ const SHOTS = path.join(root, 'test/ui-shots/accounts'), DL = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-dl-')), ID = '0b1e7c52-4d1a-4f3e-9a6b-2c8d5e7f9a10';
  fs.mkdirSync(SHOTS, { recursive: true }); API.signin = false; API.profile = FIXTURE; API.delClears = true;
  const pg = await page('saved'); const cdp = await pg.createCDPSession(); await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });
  await pg.evaluateOnNewDocument(id => { try { if (!sessionStorage.getItem('t.d')) { sessionStorage.setItem('t.d', '1'); localStorage.clear(); localStorage.setItem('poddle.device', id); localStorage.setItem('poddle.stats.on', '1'); } localStorage.setItem('poddle.name', 'Daniel'); localStorage.setItem('poddle.camPrimer', 'allow'); } catch {} }, ID);
  await pg.goto(URL0); await sleep(2200); await pg.click('#btn-start').catch(() => {}); await sleep(900);
  const openStats = async () => { await ev(pg, () => document.getElementById('btn-profile').click()); await sleep(1500); };
  const panel = () => ev(pg, () => ({ view: !document.getElementById('lobby-profile').hidden, msg: document.getElementById('pf-msg').hidden ? '' : document.getElementById('pf-msg').textContent,
    rungs: [...document.querySelectorAll('#pf-rungs > li')].map(l => [l.querySelector('b')?.textContent, l.querySelector('small')?.textContent]) }));
  await openStats(); let r = await panel();
  ok(r.view && J(r.rungs.map(x => x[0])) === J(['Rookie', 'Club', 'Tour', 'Pro']) && /^3-0/.test(r.rungs[0][1]) && /^1-1/.test(r.rungs[1][1]) && /^0-2/.test(r.rungs[2][1]), `saved profile: four Matt chips in order with their records (${J(r.rungs)})`);
  { // out of order (every level is free to pick): Rookie and Pro beaten, Club not. The badge is Pro (the hardest beaten, by difficulty: Pro is 2 on the wire, Tour 3), nothing is locked
    const reopen = async () => { await ev(pg, () => window.__ui.lobbyView('home')); await sleep(200); await openStats(); };
    API.profile = { ...FIXTURE, matt: [rung(0, 'Rookie', 3, 0, 3, 3, day), rung(1, 'Club', 0, 1, 0, 0, null), rung(3, 'Tour', 0, 0, 0, 0, null), rung(2, 'Pro', 1, 0, 1, 1, day + 7200e3)] }; await reopen();
    const o = await ev(pg, () => ({ rank: document.getElementById('st-rank').textContent, cap: document.getElementById('st-rank-cap').textContent, crest: document.getElementById('st-crest').className,
      nodes: [...document.querySelectorAll('#pf-rungs > li')].map(l => l.className.replace('st-mlv', '').trim()), best: document.getElementById('st-mbest').textContent, badge: document.getElementById('st-mbadge').className, mcap: document.getElementById('st-mcap').textContent }));
    ok(o.rank === 'Silver II' && /^(trophy|trophies) · \d+ to /.test(o.cap) && o.crest === 'st-crest is-rk is-silver' && J(o.nodes) === J(['is-won', '', '', 'is-won is-top']) && o.best === 'Pro Matt' && o.badge === 'st-mbadge is-lv3' && /^The top level · beaten /.test(o.mcap),
      `Rookie + Pro beaten: the rank is still the ladder's, the Pro Matt badge, Club and Tour simply not ticked (${J(o)})`);
    API.profile = FIXTURE; await reopen(); }
  for (const [w, h] of [[1280, 800], [390, 844]]) { await pg.setViewport({ width: w, height: h }); await sleep(400); await openStats(); await pg.screenshot({ path: path.join(SHOTS, `stats-${w}x${h}.png`) }); }
  await pg.setViewport({ width: 1280, height: 800 }); await sleep(300); await openStats();
  // Download and delete live on the privacy page (web/data-tools.js), same origin as the game: the device id comes from localStorage
  const PRIV = `http://127.0.0.1:${W}/web/privacy.html#your-data`; await pg.goto(PRIV); await sleep(900);
  const n0 = API.log.length; await ev(pg, () => document.getElementById('btn-export').click());
  let file = ''; for (let k = 0; k < 30 && !file; k++) { await sleep(200); file = fs.readdirSync(DL).find(f => f.endsWith('.json')) || ''; }
  let parsed = null; try { parsed = JSON.parse(fs.readFileSync(path.join(DL, file), 'utf8')); } catch { parsed = null; }
  const ex = API.log.slice(n0).find(l => l[0] === 'POST' && l[1] === '/api/export');
  ok(!!ex && ex[2]?.dev === ID && file === 'poddle-data-2026-09-24.json' && parsed?.profile?.matt?.length === 4, `privacy page: Download a copy POSTs /api/export with the id (${J(ex && ex[2])}), downloaded "${file}", JSON with ${parsed?.profile?.matt?.length} rungs`);
  // Delete my data: an inline confirm (Cancel focused), Delete: DELETE /api/account with the id and confirm, the id goes, the status says so
  await ev(pg, () => document.getElementById('btn-delete').click()); await sleep(300);
  r = await ev(pg, () => ({ card: !document.getElementById('data-confirm').hidden, focus: document.activeElement?.id || '' }));
  ok(r.card && r.focus === 'btn-delete-no', `Delete my data: the confirm line, Cancel focused (${J(r)})`);
  const n1 = API.log.length; await ev(pg, () => document.getElementById('btn-delete-yes').click()); await sleep(1500);
  const del = API.log.slice(n1).find(l => l[0] === 'DELETE' && l[1] === '/api/account'); const st = await ev(pg, () => document.getElementById('data-status').textContent);
  ok(!!del && del[2]?.dev === ID && del[2]?.confirm === 'delete' && await dev(pg) === null && /have been deleted/.test(st), `delete: DELETE /api/account with the id and confirm (${J(del && del[2])}), poddle.device gone (${await dev(pg)}), "${st}"`);
  await pg.goto(URL0); await sleep(2200); await pg.click('#btn-start').catch(() => {}); await sleep(900); await openStats(); r = await panel();
  ok(r.view && r.msg === '' && r.rungs.every(x => /^0-0/.test(x[1] || '')), `delete: Your stats is empty again, and no #pf-msg bar over the card's own lines ("${r.msg}", ${J(r.rungs.map(x => x[1]))})`);
  r = await ev(pg, () => ({ crest: document.getElementById('st-crest').className, rank: document.getElementById('st-rank').textContent, cap: document.getElementById('st-rank-cap').textContent, streak: document.getElementById('st-streak').className, n: document.getElementById('st-streak-n').textContent,
    won: document.querySelectorAll('#pf-rungs .is-won').length, best: document.getElementById('st-mbest').textContent, badge: document.getElementById('st-mbadge').className, mcap: document.getElementById('st-mcap').textContent, hint: !document.getElementById('st-people-hint').hidden, chips: document.getElementById('st-chips').hidden,
    tiles: [...document.querySelectorAll('.st-tile')].map(t => [t.querySelector('.st-num b').textContent, t.querySelector('.st-cap').textContent, t.querySelector('.st-cap').classList.contains('is-hint'), t.querySelector('.st-chip').hidden]) }));
  ok(r.crest === 'st-crest is-rk is-bronze' && r.rank === 'Bronze I' && r.cap === 'Play Ranked for your first trophies' && r.streak === 'st-streak' && r.n === '0' && r.won === 0 && r.best === 'None yet' && r.badge === 'st-mbadge is-none' && r.mcap === 'Beat Matt at any level to earn a badge' && r.hint && r.chips && r.tiles.every(t => t[0] === '0' && t[2] && t[3]),
    `empty state: a Bronze crest with no trophies, an empty Matt badge with its coaching line, the people hint, blue zeros with coaching captions (${J(r)})`);
  for (const [w, h] of [[1280, 800], [390, 844]]) { await pg.setViewport({ width: w, height: h }); await sleep(400); await openStats(); await pg.screenshot({ path: path.join(SHOTS, `stats-empty-${w}x${h}.png`) }); }
  await pg.setViewport({ width: 1280, height: 800 }); await sleep(300); await openStats();
  // the result card with its stats line, forced on screen (the fake game never plays a point), at both sizes
  await ev(pg, () => window.__ui.lobbyView('home')); await sleep(400); const s0 = last(); await pg.click('#btn-quick').catch(() => {}); await sleep(400);
  if (last() === s0 && !s0.frames.some(f => f.type === 'quick')) { await pg.keyboard.press('Enter'); await sleep(300); await pg.keyboard.press('Enter'); } await sleep(1200);
  ok(last().frames.some(f => f.type === 'hello' && UUID4.test(f.dev) && f.dev !== ID), `after the delete a new seat makes a fresh id and sends its hello (${J(last().frames.map(f => f.type))})`);
  push({ type: 'matchover', winner: 0, score: [11, 5], forfeit: false, rematchBy: 20, reg: [false, false] }); await sleep(150);
  await ev(pg, () => { window.__ui.showScreen(null); window.__ui.matchResult({ won: true, me: 11, them: 5, nameMe: 'You', nameThem: 'Tour Matt', vote: true }); });      // no menu screen over it: the court's result card as a player sees it
  push({ type: 'profile', saved: true, guest: true, ranked: true, first: true, level: 3, created: true, nudge: true, streak: 1, bests: [], why: [] }); await sleep(600);
  ok(await ev(pg, () => document.body.dataset.screen !== 'connect' && !document.getElementById('screen-match').hidden) && await seen(pg, 'result-save') && await seen(pg, 'result-notice'), `result card: the stats line and the notice are on screen (${await ev(pg, () => document.getElementById('result-save-text').textContent)})`);
  for (const [w, h] of [[1280, 800], [390, 844]]) { await pg.setViewport({ width: w, height: h }); await sleep(500); await pg.screenshot({ path: path.join(SHOTS, `result-${w}x${h}.png`) }); }
  await pg.close(); fs.rmSync(DL, { recursive: true, force: true }); }

{ // the swing messages carry pk and src (docs/ACCOUNTS.md 4.5): without them Fastest swing never records. A source check: the fake game plays no stroke
  const src = fs.readFileSync(path.join(root, 'web/main.js'), 'utf8'), main = /game\.send\(\{ type: 'swing', power: e\.power[^\n]*\}\);/.exec(src), uns = /unsettled = e\.final \? null : \{[^\n]*\};/.exec(src), end = /game\.send\(\{ type: 'swing', \.\.\.unsettled[^\n]*\}\);/.exec(src);
  const both = x => !!x && /\bpk: e\.raw\b/.test(x[0]) && /\bsrc: src === 'phone' \? 'phone' : 'airpod'/.test(x[0]);
  ok(both(main) && both(uns) && !!end && /\bpk: e\.raw\b/.test(end[0]), 'every swing message carries pk (the ungained peak) and src; the swingEnd fallback carries them too'); }

// ---------- E. signed in, but the sign-out fails / the session ended elsewhere: no false 'Signed out', no false 'Your data is deleted' ----------
{ API.signin = true; API.profile = FIXTURE; API.acct = { username: 'Tester', renameAt: null }; API.stale = true; API.signoutFail = true;
  const pg = await page('stale'); await pg.evaluateOnNewDocument(() => { try { localStorage.setItem('poddle.name', 'Daniel'); localStorage.setItem('poddle.camPrimer', 'allow'); } catch {} });
  await pg.goto(URL0); await sleep(2200); await pg.click('#btn-start').catch(() => {}); await sleep(900);
  await ev(pg, () => window.__ui.settings(true)); await sleep(400);
  await ev(pg, () => document.getElementById('btn-set-signout').click()); await sleep(700);
  let r = await ev(pg, () => ({ signed: !document.getElementById('set-account').hidden, toast: document.getElementById('toast').textContent }));
  ok(r.signed && /Couldn’t sign you out/.test(r.toast), `sign-out answered 500: still signed in, and told so (${J(r)})`);
  await ev(pg, () => window.__ui.settings(false)); await sleep(300);
  await pg.goto(`http://127.0.0.1:${W}/web/privacy.html#your-data`); await sleep(900);
  await ev(pg, () => document.getElementById('btn-delete').click()); await sleep(200); await ev(pg, () => document.getElementById('btn-delete-yes').click()); await sleep(900);
  r = await ev(pg, () => document.getElementById('data-status').textContent);
  ok(/sign in to Poddle first/.test(r) && !/account and your statistics/.test(r), `delete with a session that had ended: deleted.account false -> "${r}", never the account deleted`);
  API.acct = null; API.stale = false; API.signoutFail = false; await pg.close(); }

// ---------- F. the play row and Share card (docs/SHARE.md 3): the numbers, the fit, the copy, the sheet, Copy, Download, Share..., Esc, Stop sharing, the coaching line, an older server ----------
{ API.signin = false; API.acct = null; API.profile = FIXTURE; API.slug = null; API.delClears = false;
  const SHOTS = path.join(root, 'test/ui-shots/accounts'), DL = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-share-')), ID = '5c2f0a3e-8b1d-4c6e-9f7a-1d2e3f4a5b6c';
  fs.mkdirSync(SHOTS, { recursive: true });
  await browser.defaultBrowserContext().overridePermissions(`http://127.0.0.1:${W}`, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
  const pg = await page('share'); const cdp = await pg.createCDPSession(); await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });
  await pg.evaluateOnNewDocument(id => { try { localStorage.clear(); localStorage.setItem('poddle.device', id); localStorage.setItem('poddle.name', 'Daniel'); localStorage.setItem('poddle.camPrimer', 'allow'); } catch {}
    window.__clip = []; window.__shared = []; const c = navigator.clipboard;      // a spy that calls through (headless readText is not always there): what the page handed the clipboard
    if (c) { const w = c.write.bind(c), wt = c.writeText.bind(c); c.writeText = t => { window.__clip.push(String(t)); return wt(t); };
      c.write = items => { Promise.all(items.map(i => i.getType('text/plain').then(b => b.text()))).then(t => window.__clip.push(t.join('')), () => window.__clip.push('(rejected)')); return w(items); }; }
    navigator.share = d => { window.__shared.push({ url: d.url, title: d.title }); return Promise.resolve(); }; }, ID);      // never the real sheet: it can hang a headless run
  await pg.setViewport({ width: 1280, height: 800 }); await pg.goto(URL0); await sleep(2200); await pg.click('#btn-start').catch(() => {}); await sleep(900);
  const openStats = async () => { await ev(pg, () => window.__ui.lobbyView('home')); await sleep(200); await ev(pg, () => document.getElementById('btn-profile').click()); await sleep(1500); };
  const sheet = () => ev(pg, () => { const g = id => document.getElementById(id); return { open: !g('acct-layer').hidden && !g('share-card').hidden, url: g('share-url').value, img: g('share-img').getAttribute('src') || '', prev: g('share-prev').className, clip: window.__clip.slice(),
    toast: g('toast').textContent, name: g('share-name').hidden ? '' : g('btn-share-name').textContent, native: !g('btn-share-native').hidden, focus: document.activeElement?.id || '' }; });
  const shares = n => API.log.slice(n).filter(l => l[1] === '/api/share'), linkNow = () => `http://127.0.0.1:${W}/c/${API.slug}`;
  await openStats();
  let r = await ev(pg, () => { const g = id => document.getElementById(id), f = id => g(id).querySelector('dd').textContent;
    return { row: !g('pf-play').hidden, pct: g('st-ret-pct').hidden ? '' : g('st-ret-pct').textContent, cap: g('st-ret-cap').textContent, p: g('st-ring').style.getPropertyValue('--p'), hint: g('st-ret').classList.contains('is-hint'), zero: g('st-ring').classList.contains('is-zero'),
      figs: ['winners', 'aces', 'smashes', 'hits', 'points', 'time'].map(k => f('st-f-' + k)), btn: !!g('btn-pf-share').offsetParent && !g('btn-pf-share').closest('[hidden]'), label: g('btn-pf-share').textContent.trim() }; });
  ok(r.row && r.pct === '73%' && r.cap === '187 of 256 returned' && r.p === '0.730' && !r.hint && !r.zero && J(r.figs) === J(['38', '9', '21', '412', '55%', '1h 23m']) && r.btn && r.label === 'Share card',
    `play row: return rate 73% (187 of 256 returned, the ring at 0.730), winners 38, aces 9, smashes 21, hits 412, points won 55%, 1h 23m on court; the Share card button shows (${J(r)})`);
  r = await ev(pg, () => { const b = document.querySelector('#screen-lobby .menu-body'), v = document.getElementById('lobby-profile').getBoundingClientRect(), m = b.getBoundingClientRect(); return { sh: b.scrollHeight, ch: b.clientHeight, top: Math.round(v.top), bot: Math.round(v.bottom), mtop: Math.round(m.top), mbot: Math.round(m.bottom) }; });
  ok(r.sh <= r.ch + 1 && r.top >= r.mtop && r.bot <= r.mbot, `1280x800: Your stats fits without a scroll, the play row and Share card included (${J(r)})`);
  for (const [w, h] of [[1920, 1080], [1366, 500], [1024, 768], [900, 700], [760, 600]]) { await pg.setViewport({ width: w, height: h }); await sleep(400); await pg.screenshot({ path: path.join(SHOTS, `stats-play-${w}x${h}.png`) }); }      // for review: the play row at the in-between sizes
  await pg.setViewport({ width: 1366, height: 500 }); await sleep(400);
  r = await ev(pg, () => { const f = document.getElementById('st-figs'), d = [...f.children].map(e => e.getBoundingClientRect().top), cut = [...f.querySelectorAll('dt')].filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.textContent); return { oneRow: Math.max(...d) - Math.min(...d) < 2, cut }; });
  ok(r.oneRow && !r.cut.length, `1366x500 (a short landscape window): the six play figures stay one row, no label cut (${J(r)}); the card scrolls there by design`);
  await pg.setViewport({ width: 1280, height: 800 }); await sleep(300);
  // the first click: no link yet -> POST /api/share, the url goes to the clipboard through a ClipboardItem promise, then the sheet
  let n0 = API.log.length; await pg.bringToFront(); await pg.click('#btn-pf-share'); await sleep(400); await pg.screenshot({ path: path.join(SHOTS, 'share-copied-1280x800.png') }); await sleep(1100);
  r = await sheet(); const url1 = linkNow(); let p = shares(n0);
  ok(p.length === 1 && p[0][0] === 'POST' && p[0][2]?.dev === ID && r.open && r.url === url1 && r.img === url1 + '.png?v=1' && r.clip.includes(url1) && r.toast === 'Link copied' && r.focus === 'btn-share-copy',
    `Share card, no link yet: one POST /api/share with the id, the link copied (${J(r.clip)}), the sheet with it and the picture, toast "${r.toast}", Copy focused (${r.focus})`);
  ok(r.prev === 'share-prev' && r.name === '' && r.native, `the sheet: the picture loaded (no skeleton: "${r.prev}"), no name line with sign-in off ("${r.name}"), Share... where navigator.share exists (${r.native})`);
  { let cb = ''; try { cb = await ev(pg, () => navigator.clipboard.readText()); } catch { cb = ''; } if (cb) ok(cb === url1, `the clipboard itself holds the link ("${cb}")`); }
  for (const [w, h] of [[1280, 800], [390, 844]]) { await pg.setViewport({ width: w, height: h }); await sleep(500); await pg.screenshot({ path: path.join(SHOTS, `share-${w}x${h}.png`) }); }
  await pg.setViewport({ width: 1280, height: 800 }); await sleep(300);
  await ev(pg, () => { window.__clip.length = 0; }); await pg.click('#btn-share-copy'); await sleep(400);
  r = await ev(pg, () => ({ b: document.getElementById('btn-share-copy').textContent, clip: window.__clip.slice() }));
  ok(r.b === 'Copied!' && J(r.clip) === J([url1]), `Copy: the link again, the button says "${r.b}" (${J(r.clip)})`);
  await pg.click('#btn-share-dl'); let file = ''; for (let k = 0; k < 30 && !file; k++) { await sleep(200); file = fs.readdirSync(DL).find(f => f === 'poddle-card.png') || ''; }
  { const got = file ? fs.statSync(path.join(DL, file)).size : 0, want = fs.statSync(CARD).size; ok(!!file && got === want, `Download image: poddle-card.png with the picture's bytes (${got} of ${want})`); }
  await pg.click('#btn-share-native'); await sleep(300); r = await ev(pg, () => window.__shared.slice());
  ok(r.length === 1 && r[0].url === url1 && r[0].title === 'My Poddle card', `Share...: navigator.share({ url, title }) (${J(r)})`);
  r = []; for (let k = 0; k < 9; k++) { await pg.keyboard.press('Tab'); await sleep(60); r.push(await ev(pg, () => !!document.activeElement?.closest('#share-card'))); }
  ok(r.every(Boolean), `Tab stays inside the sheet (${J(r)})`);
  await pg.keyboard.press('Escape'); await sleep(300); r = await ev(pg, () => ({ open: !document.getElementById('acct-layer').hidden, focus: document.activeElement?.id || '' }));
  ok(!r.open && r.focus === 'btn-pf-share', `Esc closes the sheet and focus goes back to Share card (${J(r)})`);
  // a known link: copied at once, no request
  n0 = API.log.length; await ev(pg, () => { window.__clip.length = 0; }); await pg.click('#btn-pf-share'); await sleep(800); r = await sheet();
  ok(!shares(n0).length && r.open && J(r.clip) === J([url1]) && r.url === url1, `Share card again: the known link copied straight away, no request (${J(r.clip)}, ${shares(n0).length} requests)`);
  // Stop sharing: an inline confirm (Keep it focused), then DELETE /api/share; the next click makes a NEW link
  await pg.click('#btn-share-stop'); await sleep(250);
  r = await ev(pg, () => ({ confirm: !document.getElementById('share-confirm').hidden, stop: !document.getElementById('share-stop').hidden, focus: document.activeElement?.id || '' }));
  ok(r.confirm && !r.stop && r.focus === 'btn-share-stop-no', `Stop sharing asks first, Keep it focused (${J(r)})`);
  n0 = API.log.length; await pg.click('#btn-share-stop-yes'); await sleep(700); r = await sheet(); p = shares(n0);
  ok(p.length === 1 && p[0][0] === 'DELETE' && p[0][2]?.dev === ID && !r.open && /^Sharing stopped/.test(r.toast), `Stop sharing: DELETE /api/share with the id, the sheet closes, "${r.toast}"`);
  API.shareFail = true; n0 = API.log.length; await pg.click('#btn-pf-share'); await sleep(900); r = await sheet();
  ok(shares(n0).length === 1 && !r.open && /Couldn’t make a link/.test(r.toast), `POST /api/share fails: no sheet, "${r.toast}"`);
  API.shareFail = false; n0 = API.log.length; await ev(pg, () => { window.__clip.length = 0; }); await pg.click('#btn-pf-share'); await sleep(1500); r = await sheet(); const url2 = linkNow();
  ok(url2 !== url1 && shares(n0).length === 1 && r.open && r.url === url2 && r.clip.includes(url2) && r.img === url2 + '.png?v=2', `after Stop sharing a new link: ${url2.split('/').pop()} (was ${url1.split('/').pop()}), copied (${J(r.clip)})`);
  await pg.keyboard.press('Escape'); await sleep(300);
  // Your stats again: /api/stats now carries the link, so the first click needs no request
  await openStats(); n0 = API.log.length; await ev(pg, () => { window.__clip.length = 0; }); await pg.click('#btn-pf-share'); await sleep(800); r = await sheet();
  ok(!shares(n0).length && r.open && r.url === url2 && J(r.clip) === J([url2]), `profile.share known from /api/stats: copied with no request (${J(r.clip)})`);
  await pg.keyboard.press('Escape'); await sleep(300);
  // under 10 chances: no percentage, the coaching line, an empty ring
  API.profile = { ...FIXTURE, play: { ...FIXTURE.play, returns: 4, chances: 6 } }; await openStats();
  r = await ev(pg, () => ({ pct: !document.getElementById('st-ret-pct').hidden, cap: document.getElementById('st-ret-cap').textContent, hint: document.getElementById('st-ret').classList.contains('is-hint'), zero: document.getElementById('st-ring').classList.contains('is-zero') }));
  ok(!r.pct && r.cap === 'Return 10 balls to see it' && r.hint && r.zero, `6 chances: no percentage, "${r.cap}", an empty ring (${J(r)})`);
  await pg.screenshot({ path: path.join(SHOTS, 'stats-coach-1280x800.png') });
  // an older server: no play, no share -> no play row, no Share card, the rest as before (the Ranked hero from the fixture's ladder: Silver II)
  { const OLD = { ...FIXTURE }; delete OLD.play; delete OLD.share; API.profile = OLD; } await openStats();
  r = await ev(pg, () => ({ row: !document.getElementById('pf-play').hidden, btn: !document.getElementById('btn-pf-share').hidden, acct: !document.getElementById('pf-acct').hidden, rungs: document.querySelectorAll('#pf-rungs > li').length, rank: document.getElementById('st-rank').textContent }));
  ok(!r.row && !r.btn && !r.acct && r.rungs === 4 && r.rank === 'Silver II', `older server (no play, no share): no play row, no Share card, the card as before (${J(r)})`);
  // sign-in on, a guest: the widest header (Google's button and Share card), and the name line in the sheet opens sign-in. No navigator.share: no Share...
  API.profile = FIXTURE; API.signin = true; await pg.reload(); await sleep(2200); await pg.click('#btn-start').catch(() => {}); await sleep(900); await openStats();
  await pg.screenshot({ path: path.join(SHOTS, 'stats-signin-1280x800.png') });
  r = await ev(pg, () => { const a = document.getElementById('btn-pf-signin').getBoundingClientRect(), b = document.getElementById('btn-pf-share').getBoundingClientRect(); return { both: a.width > 0 && b.width > 0, row: Math.abs(a.top + a.height / 2 - (b.top + b.height / 2)) < 2 }; });
  ok(r.both && r.row, `sign-in on: Sign in with Google and Share card side by side in the header (${J(r)})`);
  r = await ev(pg, () => { const b = document.querySelector('#screen-lobby .menu-body'), h = document.querySelector('#lobby-profile .pf-head'), w = document.getElementById('pf-who') || h.firstElementChild, a = document.getElementById('pf-acct');
    return { sh: b.scrollHeight, ch: b.clientHeight, oneRow: Math.abs(w.getBoundingClientRect().top - a.getBoundingClientRect().top) < a.getBoundingClientRect().height, label: document.getElementById('btn-pf-share').textContent.trim(), w: Math.round(document.getElementById('btn-pf-share').getBoundingClientRect().width) }; });
  ok(r.sh <= r.ch + 1 && r.oneRow && r.label === 'Share card', `sign-in on, 1280x800: the header stays one row (Google's button and a labelled Share card) and the card fits without a scroll (${J(r)})`);
  { const bad = []; for (const [w, h] of SIZES) { await pg.setViewport({ width: w, height: h }); await sleep(250);      // the widest header at every size: nothing pokes out of the card
      const q = await ev(pg, () => { const v = document.getElementById('lobby-profile'), b = v.getBoundingClientRect(); return [...v.querySelectorAll('*')].filter(e => { const r = e.getBoundingClientRect(); return r.width && (r.left < b.left - 1 || r.right > b.right + 1); }).map(e => (e.id || e.className || e.tagName).toString().slice(0, 30)).filter(c => !/st-rays/.test(c)); });
      if (q.length) bad.push(`${w}x${h}: ${J(q)}`); if (w === 390) await pg.screenshot({ path: path.join(SHOTS, 'stats-signin-390x844.png') }); }
    ok(!bad.length, `sign-in on: the header with Google's button and Share card stays inside the card at ${SIZES.length} sizes${bad.length ? ' (' + bad.join('; ') + ')' : ''}`);
    await pg.setViewport({ width: 1280, height: 800 }); await sleep(300); }
  await ev(pg, () => { delete navigator.share; delete Navigator.prototype.share; }); await pg.click('#btn-pf-share'); await sleep(800); r = await sheet();
  ok(r.open && r.name === 'Sign in to put your name on your card' && !r.native, `a guest's sheet: "${r.name}", no Share... without navigator.share (${r.native})`);
  await pg.click('#btn-share-name'); await sleep(600);
  r = await ev(pg, () => ({ signin: !document.getElementById('signin-card').hidden, share: !document.getElementById('share-card').hidden }));
  ok(r.signin && !r.share, `the name line opens the sign-in card (${J(r)})`);
  await pg.keyboard.press('Escape'); await sleep(300);
  await pg.close(); fs.rmSync(DL, { recursive: true, force: true }); API.signin = false; API.profile = FIXTURE; API.slug = null; }

const uniq = [...new Set(errs.map(e => e.split('\n')[0].slice(0, 220)))];
ok(!uniq.length, 'no page errors' + (uniq.length ? ':\n  ' + uniq.join('\n  ') : ''));
console.log(out.join('\n')); const bad = out.filter(l => l.startsWith('FAIL')).length;
console.log(`${out.length - bad} passed, ${bad} failed`); console.log(bad ? 'PROFILE UI FAIL' : 'PROFILE UI PASSED');
await browser.close(); web.close(); for (const c of wss.clients) c.terminate(); wss.close(); process.exit(bad ? 1 : 0);
