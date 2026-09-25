// Player stats client (docs/ACCOUNTS.md 9, test plan 12.4): web/profile.js + main.js + index.html against a fake game and a fake /api.
// The real page runs with ?acctest=1 (profile.js is off on localhost otherwise). Google is never reached: every request to
// accounts.google.com or gstatic.com is intercepted, recorded and aborted.
// Usage: node test/profile-ui.mjs      PROFILE_UI_PORT=<base> moves the ports (default 9420: pages + /api, 9421: fake game, 9422: nothing = no AirPod).
import http from 'http'; import fs from 'fs'; import path from 'path'; import os from 'os';
import { WebSocketServer } from 'ws';
import puppeteer from 'puppeteer-core';
const P0 = +process.env.PROFILE_UI_PORT || 9420, W = P0, G = P0 + 1, DEAD = P0 + 2, root = new URL('..', import.meta.url).pathname, sleep = ms => new Promise(r => setTimeout(r, ms));
if ([8080, 8787, 3000].some(p => p >= P0 && p <= P0 + 2)) { console.log('refusing: that port range holds the player\'s own game'); process.exit(2); }
const J = o => JSON.stringify(o), UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml' };

// ---------- the fake /api (same origin as the page, as on poddleball.com) ----------
const day = Date.UTC(2026, 8, 20), rung = (level, name, wins, losses, streak, bestStreak, firstWinAt) => ({ level, name, wins, losses, abandons: 0, streak, bestStreak, firstWinAt, bestMargin: 0 });
const FIXTURE = { guest: true, since: day - 864e5, expiresAt: day + 90 * 864e5, played: 9,
  human: { wins: 3, losses: 2, streak: 1, bestStreak: 2, pointsWon: 50, pointsLost: 41 }, titles: 1,
  matt: [rung(0, 'Rookie', 3, 0, 3, 3, day), rung(1, 'Club', 1, 1, 0, 1, day + 3600e3), rung(3, 'Tour', 0, 2, 0, 0, null), rung(2, 'Pro', 0, 0, 0, 0, null)],   // BOT_ORDER [0, 1, 3, 2]
  bests: { rally: { v: 14, at: day }, hit: { v: 22, at: day }, speed: { v: 9.4, at: day } } };
const API = { signin: false, profile: FIXTURE, delClears: false, acct: null, stale: false, signoutFail: false, log: [] };      // log: [method, path, body] in arrival order. delClears: DELETE /api/account empties the fake store (section D)
const apiAnswer = (q, body, r) => { const u = q.url.split('?')[0], send = (s, o) => { r.writeHead(s, { 'content-type': 'application/json' }); r.end(o === undefined ? '' : J(o)); };
  let b = null; try { b = body ? JSON.parse(body) : null; } catch { b = null; } API.log.push([q.method, u, b]);
  if (u === '/api/me') return send(200, { db: true, signin: { enabled: API.signin, clientId: API.signin ? 'test-client.apps.googleusercontent.com' : null }, account: API.acct });
  if (u === '/api/stats') return send(200, { profile: b && b.dev ? API.profile : null });
  if (u === '/api/signin/nonce') return send(200, { nonce: 'n'.repeat(32) });
  if (u === '/api/account' && q.method === 'DELETE') { if (API.delClears) API.profile = null; return send(200, { deleted: { account: !!API.acct && !API.stale, device: !!(b && b.dev) } }); }      // the real route's shape: what it deleted
  if (u === '/api/signout' && q.method === 'POST') { if (API.signoutFail) return send(500, { error: 'internal' }); r.writeHead(204); return r.end(); }
  if (u === '/api/export' && q.method === 'POST') { if (!b || !b.dev || !API.profile) return send(404, { error: 'nothing' });      // the real route's shape: JSON attachment named poddle-data-<day>.json
    r.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': 'attachment; filename="poddle-data-2026-09-24.json"' }); return r.end(J({ exportedAt: day, profile: API.profile })); }
  return send(404, { error: 'nope' }); };
const web = http.createServer((q, r) => {
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
setTimeout(() => { console.log(out.join('\n')); console.log('PROFILE UI FAIL (timeout)'); process.exit(2); }, 240000);
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
  const r = await ev(pg, () => { const ids = ['btn-profile', 'lobby-profile', 'result-save', 'signin-card', 'tog-save-stats'], ui = window.__ui; let threw = '';
    for (const id of ids) document.getElementById(id)?.remove();
    try { ui.showScreen('lobby'); ui.setNames({ me: 'You', them: 'Bob', reg: [false, true] }); ui.settings(true); ui.settings(false); ui.showScreen('title'); } catch (e) { threw = e.message; }
    return { left: ids.filter(i => document.getElementById(i)), threw, ui: typeof ui }; });
  ok(r.ui === 'object' && !r.left.length && !r.threw, `ui-mock: no #btn-profile/#lobby-profile/#result-save/#signin-card/#tog-save-stats and ui.js still runs (${r.threw || 'no throw'})`);
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
// the four tiles lay out as one row, 2x2 or a single column: never three and a lone fourth
const SIZES = [[1920, 1080], [1280, 720], [1024, 768], [900, 700], [760, 600], [1366, 500], [700, 900], [600, 900], [390, 844]];
const rows = () => ev(pg, () => { const t = [...document.querySelectorAll('#lobby-home .tile')].filter(e => !e.hidden).map(e => e.offsetTop), m = new Map();      // offsetTop: the focused or hovered tile is lifted by a transform
  for (const y of t) m.set(y, (m.get(y) || 0) + 1); return { n: t.length, rows: [...m.values()], over: document.querySelector('#lobby-home .tiles').scrollWidth > innerWidth }; });
{ const bad = []; for (const [w, h] of SIZES) { await pg.setViewport({ width: w, height: h }); await sleep(250); const r = await rows();
    if (r.n !== 4 || !['4', '2,2', '1,1,1,1'].includes(r.rows.join()) || r.over) bad.push(`${w}x${h}: ${J(r)}`); }
  ok(!bad.length, `home tiles: 4 in one row, 2x2 or one column at ${SIZES.length} window sizes${bad.length ? ' (' + bad.join('; ') + ')' : ''}`); }
await pg.setViewport({ width: 1280, height: 720 }); await sleep(250);
await ev(pg, () => document.getElementById('btn-profile').click()); await sleep(1500);
r = await ev(pg, () => ({ view: !document.getElementById('lobby-profile').hidden, rungs: [...document.querySelectorAll('#pf-rungs > li')].map(l => [l.querySelector('.pf-level b')?.textContent, l.querySelector('.st-tag')?.textContent, l.className]),
  next: document.getElementById('btn-pf-next').textContent, nextIn: document.getElementById('btn-pf-next').closest('li')?.dataset.level, lvl: document.getElementById('btn-pf-next').dataset.level, bests: document.getElementById('pf-bests').textContent, human: document.getElementById('pf-human').textContent,
  w: document.getElementById('st-w').textContent, l: document.getElementById('st-l').textContent, rank: document.getElementById('st-rank').textContent, streak: document.getElementById('st-streak').textContent.replace(/\s+/g, ' ').trim(), crest: document.getElementById('st-crest').className}));
ok(r.view && J(r.rungs.map(x => x[0])) === J(['Rookie Matt', 'Club Matt', 'Tour Matt', 'Pro Matt']), `Your stats: four rungs, Rookie, Club, Tour, Pro (${J(r.rungs.map(x => x[0]))})`);
ok(/^Beaten /.test(r.rungs[0]?.[1]) && /^Beaten /.test(r.rungs[1]?.[1]) && r.rungs[2]?.[1] === 'Up next' && r.rungs[3]?.[1] === 'The final boss' && r.next === 'Next: beat Tour Matt' && r.nextIn === '3' && r.lvl === '3', `road tags: beaten, beaten, up next, the final boss; the Next button sits in the Tour node with data-level 3 (${J(r.rungs.map(x => x[1]))}, ${r.next} in level ${r.nextIn}, data-level ${r.lvl})`);
ok(r.rungs[0][2].includes('is-won') && r.rungs[1][2].includes('is-won') && r.rungs[2][2].includes('is-next') && r.rungs[3][2].includes('is-locked'), `road nodes: won, won, next, locked (${J(r.rungs.map(x => x[2]))})`);
ok(r.rank === 'Club player' && r.crest === 'st-crest' && /^3 win streak vs Rookie Matt · best 3$/.test(r.streak), `hero: Club player, gold crest, the hottest streak is 3 vs Rookie Matt (${r.rank}, ${r.stars}, ${r.crest}, "${r.streak}")`);
ok(r.bests.includes('14 hits') && r.bests.includes('540°/s') && !r.bests.includes('Hardest') && r.w === '3' && r.l === '2' && r.human.includes('60% won') && r.human.includes('50-41') && r.human.includes('Streak 1') && r.human.includes('Best 2'), `bests and the human record drawn (${r.bests.slice(0, 80)} | ${r.human.slice(0, 80)})`);
ok(API.log.some(l => l[1] === '/api/stats' && l[2] && l[2].dev === id0), 'Your stats asks /api/stats with the device id in the body');
{ // the panel fits every window: inside the viewport's width, and no rung line or chip cut short with an ellipsis
  const bad = []; for (const [w, h] of SIZES) { await pg.setViewport({ width: w, height: h }); await sleep(250);
    const r = await ev(pg, () => { const v = document.getElementById('lobby-profile'), b = v.getBoundingClientRect(), cut = [...v.querySelectorAll('.pf-level b, .pf-level small, .st-tag, .st-cap > span, .st-rank-name, .st-ribbon, .st-chip, .st-bar-l, .st-bar-r')].filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.textContent.slice(0, 30));
      const wide = [...v.querySelectorAll('*')].filter(e => { const q = e.getBoundingClientRect(); return q.width && (q.left < b.left - 1 || q.right > b.right + 1); }).map(e => (e.id || e.className || e.tagName).toString().slice(0, 30));      // nothing pokes out of the panel (the crest's rays are masked, they may)
      return { left: Math.round(b.left), right: Math.round(b.right), w: innerWidth, cut, wide: wide.filter(c => !/st-rays/.test(c)) }; });
    if (r.left < 0 || r.right > r.w || r.cut.length || r.wide.length) bad.push(`${w}x${h}: ${J(r)}`); }
  ok(!bad.length, `Your stats fits at ${SIZES.length} window sizes, nothing clipped${bad.length ? ' (' + bad.join('; ') + ')' : ''}`);
  await pg.setViewport({ width: 1280, height: 720 }); await sleep(250); }

// ---------- Save my stats OFF with a saved profile: the choice, then Delete: DELETE /api/account carries the id, then the id is gone ----------
await ev(pg, () => window.__ui.settings(true)); await sleep(500);
await ev(pg, () => document.getElementById('tog-save-stats').click()); await sleep(400);
r = await ev(pg, () => ({ ask: !document.getElementById('stats-off-ask').hidden, dev: localStorage.getItem('poddle.device') }));
ok(r.ask && r.dev === id0, `stats off with a saved profile asks Delete or Keep first (ask ${r.ask}, id kept for now ${r.dev === id0})`);
const n0 = API.log.length; await ev(pg, () => document.getElementById('btn-stats-del').click()); await sleep(900);
{ const del = API.log.slice(n0).find(l => l[0] === 'DELETE' && l[1] === '/api/account'), d = await dev(pg), on = await ev(pg, () => localStorage.getItem('poddle.stats.on'));
  ok(!!del && del[2] && del[2].dev === id0 && d === null && on === '0', `Delete: DELETE /api/account with the old id (${J(del && del[2])}), then no poddle.device (${d}), stats.on '${on}'`); }
await ev(pg, () => window.__ui.settings(false)); await sleep(300);
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
    rungs: [...document.querySelectorAll('#pf-rungs > li')].map(l => [l.querySelector('.pf-level b')?.textContent, l.querySelector('.pf-level small')?.textContent]) }));
  await openStats(); let r = await panel();
  ok(r.view && J(r.rungs.map(x => x[0])) === J(['Rookie Matt', 'Club Matt', 'Tour Matt', 'Pro Matt']) && /^3-0/.test(r.rungs[0][1]) && /^1-1/.test(r.rungs[1][1]) && /^0-2/.test(r.rungs[2][1]), `saved profile: four rungs in order with their records (${J(r.rungs)})`);
  { // out of order (every level is free to pick): Rookie and Pro beaten, Club not. The rank is the hardest beaten, the Next button and the caption point at the gap, and the gold track stops at Rookie
    const reopen = async () => { await ev(pg, () => window.__ui.lobbyView('home')); await sleep(200); await openStats(); };
    API.profile = { ...FIXTURE, matt: [rung(0, 'Rookie', 3, 0, 3, 3, day), rung(1, 'Club', 0, 1, 0, 0, null), rung(3, 'Tour', 0, 0, 0, 0, null), rung(2, 'Pro', 1, 0, 1, 1, day + 7200e3)] }; await reopen();
    const o = await ev(pg, () => ({ rank: document.getElementById('st-rank').textContent, cap: document.getElementById('st-rank-cap').textContent, p: document.getElementById('pf-rungs').style.getPropertyValue('--p'), crest: document.getElementById('st-crest').className,
      nodes: [...document.querySelectorAll('#pf-rungs > li')].map(l => l.className.replace('st-node ', '')), lvl: document.getElementById('btn-pf-next').dataset.level, nextIn: document.getElementById('btn-pf-next').closest('li')?.dataset.level }));
    ok(o.rank === 'Pro player' && o.cap === '2 of 4 Matts beaten · beat Club Matt to fill the road' && o.p === '0' && o.crest === 'st-crest' && J(o.nodes) === J(['is-won', 'is-next', 'is-locked', 'is-won']) && o.lvl === '1' && o.nextIn === '1',
      `Rookie + Pro beaten: Pro player, no crown, the caption points at Club without promising a rank, --p 0, Next on Club (${J(o)})`);
    API.profile = FIXTURE; await reopen(); }
  for (const [w, h] of [[1280, 800], [390, 844]]) { await pg.setViewport({ width: w, height: h }); await sleep(400); await openStats(); await pg.screenshot({ path: path.join(SHOTS, `stats-${w}x${h}.png`) }); }
  await pg.setViewport({ width: 1280, height: 800 }); await sleep(300); await openStats();
  { // the Next button plays Matt at its own level: a private court, then 'bot' with the level right after the welcome (main.js playBot)
    const s = last(), k = s ? s.frames.length : 0, n = socks.length; await pg.click('#btn-pf-next'); await sleep(1500);
    const f = [...(s ? s.frames.slice(k) : []), ...socks.slice(n).flatMap(x => x.frames)].filter(x => x.type !== 'ping');
    ok(f.some(x => x.type === 'create' && x.public === false) && f.some(x => x.type === 'bot' && x.level === 3), `the Next button: a private create, then bot level 3 (${J(f.map(x => x.type + (x.level != null ? ':' + x.level : '')))})`); }
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
    tags: [...document.querySelectorAll('#pf-rungs .st-tag')].map(e => e.textContent), next: document.getElementById('btn-pf-next').textContent, nextIn: document.getElementById('btn-pf-next').closest('li')?.dataset.level, lvl: document.getElementById('btn-pf-next').dataset.level, hint: !document.getElementById('st-people-hint').hidden, chips: document.getElementById('st-chips').hidden,
    tiles: [...document.querySelectorAll('.st-tile')].map(t => [t.querySelector('.st-num b').textContent, t.querySelector('.st-cap').textContent, t.querySelector('.st-cap').classList.contains('is-hint'), t.querySelector('.st-chip').hidden]) }));
  ok(r.crest === 'st-crest is-none' && r.rank === 'Unranked' && r.cap === 'Beat Rookie Matt to start your road' && r.streak === 'st-streak' && r.n === '0' && J(r.tags) === J(['Start here', 'Beat Rookie first', 'Beat Club first', 'The final boss']) && r.next === 'Next: beat Rookie Matt' && r.nextIn === '0' && r.lvl === '0' && r.hint && r.chips && r.tiles.every(t => t[0] === '0' && t[2] && t[3]),
    `empty state: the ? crest, Unranked, Start here on Rookie with the Next button, the people hint, blue zeros with coaching captions (${J(r)})`);
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

const uniq = [...new Set(errs.map(e => e.split('\n')[0].slice(0, 220)))];
ok(!uniq.length, 'no page errors' + (uniq.length ? ':\n  ' + uniq.join('\n  ') : ''));
console.log(out.join('\n')); const bad = out.filter(l => l.startsWith('FAIL')).length;
console.log(`${out.length - bad} passed, ${bad} failed`); console.log(bad ? 'PROFILE UI FAIL' : 'PROFILE UI PASSED');
await browser.close(); web.close(); for (const c of wss.clients) c.terminate(); wss.close(); process.exit(bad ? 1 : 0);
