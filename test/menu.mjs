// Main menu, lobby and room flow against a fake lobby server that speaks docs/ROOMS.md + docs/SPECTATE.md (no server/game.js needed).
// Part A drives the real page. Part B (docs/API-NEXT.md 6, MAIN) loads the real main.js against RECORDING STUBS of ui.js and
// scene.js and a scripted fake, and checks main.js's own wiring: the no-room guard, every message of 4.3 / 4.4, attract and
// menu mode, watching, views, pause, hold, rematch, names, settings and what is kept across a reload. ONLY=a | b runs one part.
// Usage: node test/menu.mjs      MENU_PORT=<base> moves the ports (default 8330: page, 8331: fake game, 8332: nothing = no AirPod, 8333: fake AirPod)
import http from 'http'; import fs from 'fs'; import path from 'path';
import { WebSocketServer } from 'ws';
import puppeteer from 'puppeteer-core';
import { makeSynth, CALIBRATE, SESSION_LOOP } from './fake-bridge.mjs';
const P0 = +process.env.MENU_PORT || 8330, W = P0, G = P0 + 1, DEAD = P0 + 2, POD = P0 + 3, ONLY = (process.env.ONLY || 'ab').toLowerCase(), root = new URL('..', import.meta.url).pathname, sleep = ms => new Promise(r => setTimeout(r, ms));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml' };
const web = http.createServer((q, r) => { let f = path.join(root, 'web', decodeURIComponent(q.url.split('?')[0])); if (f.endsWith('/')) f += 'index.html';
  fs.readFile(f, (e, d) => { r.writeHead(e ? 404 : 200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); r.end(e ? '' : d); }); }).listen(W);

// ---- the fake: a lobby with two listed rooms. WXYZ and KXQ7 exist, FVVV is full, FWWW is full but can be watched, anything else is not found. MUTE=1 answers nothing (an old server).
// EVIL=1 is the old server of docs/NEXT.md 11: it seats a lobby socket by itself and plays a whole match at it. The test scripts the rest: push(msg) speaks to the newest socket, ws.st is its state packet.
const got = [], urls = [], J = o => JSON.stringify(o), COURT = { halfW: 3.05, halfL: 6.7, kitchen: 2.13, net: 0.91 }, LIST = { type: 'lobby', online: 3, rooms: [{ code: 'KXQ7', players: 1, open: true }, { code: 'M3PD', players: 0, open: true }] };
const ME = { x: 0, y: 1, z: 6.5, q: [0, 0, 0, 1], bot: false }, MATT = { x: 0, y: 1, z: -6.5, q: [0, 0, 0, 1], bot: true }, HUMAN = { x: 0, y: 1, z: -6.5, q: [0, 0, 0, 1], bot: false };
let mute = false, gone = false, evil = false, wss = null, last = null;
const push = (m, ws = last) => ws && ws.readyState === 1 && ws.send(J(m));
function seat(ws, code, pub, role = 'player', names = [ws.name || 'Player 1', null]) { ws.room = code; ws.role = role; ws.st = { type: 'state', t: 0, p: [0, 1, 5], v: [0, 0, 0], spin: 0, b: 0, k: 0, live: false, serving: 0, reach: false, score: [0, 0], paddles: [ME, role === 'spectator' ? HUMAN : null] };
  ws.send(J({ type: 'room', code, public: pub, role })); ws.send(J({ type: 'welcome', side: role === 'spectator' ? null : 0, role, court: COURT, names }));
  clearInterval(ws.tick); ws.tick = setInterval(() => { if (ws.readyState !== 1) return; if (!ws.st.paused) ws.st.t = Date.now(); ws.send(J(ws.st)); }, 50); }
function join(ws, code) { code = String(code || '').trim().toUpperCase(); if (gone) ws.send(J({ type: 'joinfail', reason: 'notfound' })); else if (code === 'FVVV') ws.send(J({ type: 'joinfail', reason: 'full' })); else if (code === 'FWWW') ws.send(J({ type: 'joinfail', reason: 'full', watch: true, code }));
  else if (!['WXYZ', 'KXQ7', 'M3PD', 'CRTD', 'QQQQ'].includes(code)) ws.send(J({ type: 'joinfail', reason: 'notfound' })); else seat(ws, code, true); }
function watch(ws, code) { code = String(code || '').trim().toUpperCase(); if (code === 'BUSY') ws.send(J({ type: 'joinfail', reason: 'busy' })); else if (gone || !['FWWW', 'KXQ7'].includes(code)) ws.send(J({ type: 'joinfail', reason: 'notfound' })); else seat(ws, code, true, 'spectator', ['Ann', 'Bo']); }
const JUNK = [{ type: 'welcome', side: 1, court: COURT, names: ['Old', 'Server'] }, { type: 'state', t: 1, p: [0, 1, 0], v: [0, 0, 9], spin: 0, live: true, serving: 0, score: [3, 10], watchers: 2, paused: true, paddles: [ME, MATT] }, { type: 'names', names: ['Old', 'Server'] }, { type: 'botinfo', active: true, level: 2, name: 'Pro' },
  { type: 'serve', by: 1, wait: true }, { type: 'hit', side: 1, n: 0.9, spin: 0.8, kind: 'smash' }, { type: 'bounce' }, { type: 'point', winner: 1 }, { type: 'hold', side: 0, left: 9 }, { type: 'paused', on: true, by: 1 }, { type: 'left' },
  { type: 'match', winner: 1, score: [3, 11] }, { type: 'matchover', winner: 1, score: [3, 11], forfeit: false, rematchBy: 20 }, { type: 'rematch', votes: [null, true], left: 12 }, { type: 'nonsense', x: [[[]]] }];
// A legacy socket (no lobby=1) gets a 'room' too here. The contract does not say it will: the client must show no room UI either way.
function startFake() { wss = new WebSocketServer({ port: G }); wss.on('connection', (ws, req) => { const q = new URL(req.url, 'http://x').searchParams; urls.push(req.url); last = ws;
  if (q.get('lobby') !== '1') { seat(ws, 'LOCAL', false); return; } ws.send(J(LIST)); if (evil) for (const m of JUNK) ws.send(J(m));
  if (q.get('room')) { ws.name = q.get('name'); if (q.get('watch') === '1') watch(ws, q.get('room')); else join(ws, q.get('room')); }
  ws.on('message', raw => { const m = JSON.parse(raw); if (m.type === 'ping') return ws.send(J({ type: 'pong', c: m.c })); got.push(m); if (mute) return;
    if (m.type === 'leave') { clearInterval(ws.tick); ws.room = null; ws.send(J(LIST)); }
    else if (ws.room) { if (m.type === 'pause' && ws.role === 'player') { const human = ws.st.paddles[1] && !ws.st.paddles[1].bot; if (human) push({ type: 'paused', on: false, refused: true }, ws); else { ws.st.paused = m.on ? true : undefined; push({ type: 'paused', on: !!m.on, by: 0 }, ws); } } }
    else if (typeof m.name === 'string') { ws.name = m.name; if (m.type === 'quick') seat(ws, 'QQQQ', true); else if (m.type === 'create') seat(ws, 'CRTD', !!m.public); else if (m.type === 'join') join(ws, m.code); else if (m.type === 'watch') watch(ws, m.code); } });
  ws.on('close', () => clearInterval(ws.tick)); }); }
const stopFake = () => new Promise(r => { for (const c of wss.clients) c.terminate(); wss.close(r); });
startFake();

const CHROME = process.env.CHROME || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => fs.existsSync(p));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
fs.mkdirSync(root + 'test/ui-shots', { recursive: true });
const out = [], errs = [], ok = (c, what) => { out.push((c ? 'PASS ' : 'FAIL ') + what); if (!c) console.log('FAIL', what); };
setTimeout(() => { console.log(out.join('\n')); console.log('MENU FAIL (timeout)'); process.exit(2); }, 240000);
const st = pg => pg.evaluate(() => { const t = id => document.getElementById(id), seen = el => !!el && !el.hidden && getComputedStyle(el).visibility !== 'hidden';
  return { screen: document.body.dataset.screen, view: [...document.querySelectorAll('#screen-lobby .lobby-view')].find(v => !v.hidden)?.dataset.view, title: t('lobby-title').textContent, focus: document.activeElement?.id || document.activeElement?.className || '',
    search: location.search, err: t('code-err').textContent, typed: [...document.querySelectorAll('#code-boxes input')].map(b => b.value).join(''), share: t('share-code').textContent.replace(/\s/g, ''), pill: t('room-pill').hidden ? null : t('room-code').textContent,
    toast: t('toast').classList.contains('on') ? t('toast').textContent : null, busy: t('screen-lobby').getAttribute('aria-busy') === 'true', down: seen(t('lobby-down')), chip: t('title-room').hidden ? null : t('title-room').textContent,
    rooms: [...document.querySelectorAll('#room-list .room-row')].map(b => b.textContent), online: t('lobby-online').textContent, fs: !!document.fullscreenElement, backs: [...document.querySelectorAll('.screen.is-active [data-back]')].filter(seen).length,
    clipped: [...document.querySelectorAll('.screen.is-active [data-fit]')].filter(e => { const b = e.getBoundingClientRect(); return b.width && (b.left < -.5 || b.top < -.5 || b.right > innerWidth + .5 || b.bottom > innerHeight + .5); }).map(e => e.id || e.className) }; });
const sent = type => got.filter(m => m.type === type);
const NAME = 'Dan';
async function open(tag, query = '', w = 1280, h = 720, name = NAME, bridge = DEAD) { const pg = await browser.newPage(); await pg.setViewport({ width: w, height: h });
  await pg.evaluateOnNewDocument(n => { try { if (n) localStorage.setItem('poddle.name', n); else localStorage.removeItem('poddle.name'); } catch { /* no storage */ } }, name);      // the name was typed on an earlier visit (a name is required before any seat: docs/API-NEXT.md 3.3)
  pg.on('pageerror', e => errs.push(`[${tag}] PAGEERROR ${e.message}`)); pg.on('response', r => { if (r.status() >= 400) errs.push(`[${tag}] ${r.status()} ${r.url()}`); });
  pg.on('console', m => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED|WebSocket connection|Failed to load resource/.test(m.text())) errs.push(`[${tag}] ${m.text()}`); });   // the AirPod bridge is absent on purpose; a real 404 is caught by the response hook
  await pg.goto(`http://localhost:${W}/?bridge=${bridge}&game=${G}&cam=0${query}`); await sleep(1600); return pg; }
const type = async (pg, text) => { for (const c of text) await pg.keyboard.type(c, { delay: 25 }); await sleep(120); };
const waitFor = async (what, test, ms = 4000) => { const end = Date.now() + ms; do { if (await test()) return true; await sleep(100); } while (Date.now() < end); ok(false, `${what} (gave up after ${ms / 1000} s)`); return false; };

// one fake AirPod, at rest until go(): the calibration script must start when the calibrate screen asks for it
const pod = { t: 3580, socks: new Set() }, podOpts = { heading: 137, gyroNoise: 0.02, accNoise: 0.005, seed: 7 };
const rest = () => { pod.syn = makeSynth({ ...podOpts, script: [], t0: pod.t + 0.02 }); }, go = () => { pod.syn = makeSynth({ ...podOpts, script: CALIBRATE, loop: SESSION_LOOP, t0: pod.t + 0.02 }); }; rest();
const podWss = new WebSocketServer({ port: POD }); podWss.on('connection', ws => { pod.socks.add(ws); ws.on('close', () => pod.socks.delete(ws)); ws.on('error', () => pod.socks.delete(ws)); });
{ const start = performance.now(); let n = 0; setInterval(() => { const due = Math.floor((performance.now() - start) / 20); for (; n <= due; n++) { const m = pod.syn.next(); delete m._t; pod.t = m.t; const j = JSON.stringify(m); for (const ws of pod.socks) if (ws.readyState === 1) ws.send(j); } }, 5).unref(); }


if (ONLY.includes('a')) {
for (const [w, h] of [[1280, 720], [600, 900]]) {
  const tag = `${w}x${h}`, pg = await open(tag, '', w, h); let s;
  const shot = async n => { await sleep(450); await pg.screenshot({ path: `${root}test/ui-shots/menu-${n}-${tag}.png` }); const c = (await st(pg)).clipped; ok(!c.length, `${tag} ${n}: nothing clipped ${c}`); };
  got.length = 0;
  // title
  s = await st(pg); const btn = await pg.evaluate(() => { const b = document.getElementById('btn-start'); return { text: b.textContent.trim(), seen: b.getBoundingClientRect().width > 0 }; });
  ok(s.screen === 'title' && btn.text === 'Play' && btn.seen, `${tag} title shows Play (screen=${s.screen}, button="${btn.text}")`);
  const glass = await pg.evaluate(() => { const g = document.getElementById('glass'), c = getComputedStyle(g); return { blur: c.backdropFilter || c.webkitBackdropFilter || '', vis: c.visibility, canvas: !!document.querySelector('#stage canvas') }; });
  ok(glass.vis === 'visible' && /blur\(/.test(glass.blur) && glass.canvas, `${tag} blurred glass over the live court (backdrop-filter: ${glass.blur}, ${glass.vis}, canvas=${glass.canvas})`);
  ok(!/[—–…!]/.test(await pg.evaluate(() => [...document.querySelectorAll('#screen-title, #screen-lobby')].map(e => e.textContent).join(' '))), `${tag} no dashes, ellipses or exclamation marks in the menu copy`);
  await shot('1-title');
  ok(!urls.some(u => /room=/.test(u)) && urls.every(u => /cid=\w+&lobby=1$/.test(u)), `${tag} game socket opened with cid and lobby=1 (${urls[urls.length - 1]})`);
  // Play -> lobby
  await pg.click('#btn-start'); await sleep(700); s = await st(pg);
  ok(s.screen === 'lobby' && s.view === 'home' && s.title === 'Play' && s.focus === 'btn-quick', `${tag} Play -> lobby home, Quick play focused (${s.screen}/${s.view}/${s.focus})`);
  const tiles = await pg.evaluate(() => [...document.querySelectorAll('#lobby-home .tile')].map(b => b.textContent.trim())); ok(/^Quick play\|Create court\|Enter code\|Play a bot$/.test(tiles.join('|')), `${tag} the choices: ${tiles.join(' | ')}`);
  ok(s.rooms.length === 2 && s.rooms[0].startsWith('KXQ7') && s.rooms[1].startsWith('M3PD') && s.online === '3 online', `${tag} room list from the server: ${s.rooms.join(' | ')}, "${s.online}"`);
  ok((await pg.evaluate(() => getComputedStyle(document.getElementById('glass')).visibility)) === 'visible', `${tag} glass stays under the lobby`);
  if (s.fs) await pg.evaluate(() => document.exitFullscreen()); await shot('2-lobby');
  // back to the title and in again, with the keyboard
  await pg.keyboard.press('Escape'); await sleep(500); ok((await st(pg)).screen === 'title', `${tag} Esc on lobby home -> title`);
  await pg.keyboard.press('Space'); await sleep(700); ok((await st(pg)).screen === 'lobby', `${tag} Space on the title -> lobby`);
  await pg.keyboard.press('ArrowRight'); await pg.keyboard.press('ArrowRight'); ok((await st(pg)).focus === 'btn-code', `${tag} arrows walk the tiles`);
  // Enter code
  await pg.keyboard.press('Enter'); await sleep(350); s = await st(pg); ok(s.view === 'code' && s.title === 'Enter code', `${tag} Enter code view (${s.view}, "${s.title}")`);
  const fs0 = (await st(pg)).fs; await type(pg, 'fo1'); s = await st(pg); ok(s.typed === 'F' && s.screen === 'lobby' && s.fs === fs0, `${tag} F types a letter (no full screen), O and 1 are dropped: "${s.typed}"`);
  await pg.keyboard.press('Backspace'); await pg.keyboard.press('Backspace'); await sleep(80); await type(pg, 'ab2k'); s = await st(pg); ok(s.typed === 'AB2K', `${tag} typed "ab2k" reads ${s.typed}`);
  await pg.keyboard.press('Enter'); await sleep(500); s = await st(pg);
  ok(J(sent('join').at(-1)) === J({ type: 'join', code: 'AB2K', name: NAME }), `${tag} join sent upper case, with the name: ${J(sent('join').at(-1))}`);
  ok(s.err === 'Court not found' && s.screen === 'lobby' && s.view === 'code' && s.typed === 'AB2K' && !s.busy && !/(court|room)=/.test(s.search), `${tag} joinfail notfound: inline "${s.err}", stays on the code view`); await shot('5-code-error');
  await pg.evaluate(() => { const dt = new DataTransfer(); dt.setData('text', 'https://poddleball.com/?room=fvvv'); document.querySelector('#code-boxes input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); });
  await sleep(100); s = await st(pg); ok(s.typed === 'FVVV' && s.err === '', `${tag} pasting a link fills the code and clears the error (${s.typed})`);
  await pg.keyboard.press('Enter'); await sleep(450); ok((await st(pg)).err === 'Court is full', `${tag} joinfail full, nowhere to watch: inline "${(await st(pg)).err}"`);
  await pg.click('#screen-lobby [data-back]'); await sleep(350); s = await st(pg); ok(s.view === 'home' && s.screen === 'lobby', `${tag} Back button -> lobby home`);
  // Create room
  await pg.click('#btn-create'); await sleep(350); s = await st(pg); ok(s.view === 'create' && s.title === 'Create court', `${tag} Create room view`); await shot('3-create');
  await pg.click('#btn-create-go'); await sleep(500); s = await st(pg);
  ok(J(sent('create').at(-1)) === J({ type: 'create', public: true, name: NAME }), `${tag} create sent: ${J(sent('create').at(-1))}`);
  ok(s.view === 'share' && s.title === 'Your court' && s.share === 'CRTD' && /court=CRTD/.test(s.search) && s.screen === 'lobby', `${tag} 'room' -> share view shows ${s.share}, url ${s.search}`); await shot('4-share');
  await pg.keyboard.press('Escape'); await sleep(450); s = await st(pg); ok(s.view === 'home' && sent('leave').length === 1 && !/(court|room)=/.test(s.search), `${tag} Esc on the share view leaves the room (${sent('leave').length} leave, url "${s.search}")`);
  await pg.click('#btn-create'); await sleep(300); await pg.keyboard.press('ArrowRight'); await sleep(80); ok(await pg.evaluate(() => document.getElementById('seg-note').textContent) === 'Join by code only', `${tag} Right selects Private`);
  await pg.keyboard.press('Enter'); await sleep(500); ok(J(sent('create').at(-1)) === J({ type: 'create', public: false, name: NAME }), `${tag} private create sent: ${J(sent('create').at(-1))}`);
  await pg.click('#btn-share-go'); await sleep(800); s = await st(pg); ok(s.screen === 'connect' && s.backs === 1, `${tag} Start -> connect screen with a Back button (${s.screen}, backs=${s.backs})`); await shot('6-connect');
  await pg.keyboard.press('KeyC'); await sleep(600); s = await st(pg); ok(s.screen === 'calibrate' && s.backs === 1, `${tag} C -> calibrate (${s.screen})`);
  await pg.click('#cal [data-back]'); await sleep(600); s = await st(pg); ok(s.screen === 'lobby' && s.view === 'home' && sent('leave').length === 2 && !/(court|room)=/.test(s.search), `${tag} Back on calibrate -> lobby, leave sent, url cleared`);
  // Quick play, then a room from the list
  await pg.click('#btn-quick'); await sleep(800); s = await st(pg); ok(J(sent('quick').at(-1)) === J({ type: 'quick', name: NAME }) && s.screen === 'connect' && /court=QQQQ/.test(s.search), `${tag} Quick play sent ${J(sent('quick').at(-1))} -> ${s.screen}, url ${s.search}`);
  await pg.keyboard.press('Escape'); await sleep(600); await pg.click('.room-row[data-code="KXQ7"]'); await sleep(800); s = await st(pg);
  ok(J(sent('join').at(-1)) === J({ type: 'join', code: 'KXQ7', name: NAME }) && s.screen === 'connect', `${tag} room row joins KXQ7 -> ${s.screen}`);
  // reload: the URL carries the room, the title says so, Play rejoins
  await pg.reload(); await sleep(1600); s = await st(pg); ok(s.screen === 'title' && s.chip === 'Joining court KXQ7', `${tag} reload: title chip "${s.chip}"`); await shot('7-title-room');
  await pg.keyboard.press('Enter'); await sleep(900); s = await st(pg); ok(s.screen === 'connect' && J(sent('join').at(-1)) === J({ type: 'join', code: 'KXQ7', name: NAME }), `${tag} Play rejoins KXQ7 -> ${s.screen}`);
  await pg.close();
}

// ?room=WXYZ: nothing joins until Play, then it joins at once and moves on
{ got.length = 0; urls.length = 0; const pg = await open('link', '&room=wxyz'); let s = await st(pg);
  ok(s.chip === 'Joining court WXYZ' && !got.length && !urls.some(u => /room=/.test(u)), `?room=WXYZ: chip "${s.chip}", nothing sent before Play`);
  await pg.click('#btn-start'); await sleep(900); s = await st(pg); ok(J(got[0]) === J({ type: 'join', code: 'WXYZ', name: NAME }) && s.screen === 'connect', `?room=WXYZ: Play sent ${J(got[0])} -> ${s.screen}`);
  // seated, then the socket drops: the reconnect must ask for the seat back
  urls.length = 0; await stopFake(); await sleep(700); startFake(); await sleep(2500); s = await st(pg);
  ok(urls.length && urls.every(u => /cid=\w+&lobby=1&room=WXYZ&name=Dan&back=1&pub=[01]&side=[01](&score=\d+-\d+)?(&bot=\d)?$/.test(u)) && s.screen === 'connect', `reconnect while seated: ${urls[0]} (screen ${s.screen})`);
  urls.length = 0; gone = true; await stopFake(); await sleep(700); startFake(); await sleep(2500); s = await st(pg); gone = false;      // and once more, but the room expired meanwhile
  ok(/room=WXYZ/.test(urls[0] || '') && s.screen === 'lobby' && s.view === 'home' && s.toast === 'Court closed' && !/(court|room)=/.test(s.search) && s.pill === null, `reconnect to a room that is gone: ${s.screen}/${s.view}, toast "${s.toast}", url "${s.search}"`);
  await pg.close(); }
// a shared link to a room that is gone
{ const pg = await open('gone', '&room=ZZZZ'); await pg.click('#btn-start'); await sleep(900); const s = await st(pg);
  ok(s.screen === 'lobby' && s.view === 'code' && s.typed === 'ZZZZ' && s.err === 'Court not found' && !/(court|room)=/.test(s.search), `dead link: code view, "${s.err}", url "${s.search}"`); await pg.close(); }
// server down in the lobby, then back; and a server that never answers
{ const pg = await open('down'); await pg.click('#btn-start'); await sleep(600); await stopFake(); await sleep(1500); let s = await st(pg);
  ok(s.down && !s.rooms.length && s.screen === 'lobby', `server down: the lobby says so (down=${s.down})`); await sleep(300); await pg.screenshot({ path: `${root}test/ui-shots/menu-8-lobby-down-1280x720.png` });
  startFake(); await sleep(3500); s = await st(pg); ok(!s.down && s.rooms.length === 2, `server back: notice gone, ${s.rooms.length} rooms listed`);
  mute = true; await pg.click('#btn-quick'); await sleep(900); s = await st(pg); ok(s.busy && s.screen === 'lobby', `no answer yet: lobby busy`);
  await sleep(4700); s = await st(pg); ok(!s.busy && s.toast === 'No answer. Try again.', `no answer after 5 s: busy cleared, toast "${s.toast}"`); mute = false; await pg.close(); }
// legacy ?skiptitle=1: byte-identical socket URL, no lobby, no room UI
{ urls.length = 0; got.length = 0; const pg = await open('legacy', '&skiptitle=1&room=WXYZ'); let s = await st(pg);
  ok(urls.length && urls.every(u => /^\/\?cid=\w+$/.test(u)), `legacy socket URL: ${urls[0]}`); ok(s.screen === 'connect' && s.backs === 0 && s.pill === null, `legacy: connect screen, no Back, no room pill (${s.screen}, backs=${s.backs})`);
  await pg.keyboard.press('Escape'); await pg.keyboard.press('KeyQ'); await sleep(300); s = await st(pg); ok(s.screen === 'connect' && !got.length, `legacy: Esc and Q do nothing`); await pg.close(); }

// the new flows on the REAL page (docs/NEXT.md 6, 7, 9, 10), once ui.js and scene.js carry them: Play a bot, the name gate, the watch prompt, watching, views, the panel, the result, closed
{ got.length = 0; const pg = await open('next', '&uitest=1'); await pg.click('#btn-start'); await sleep(700); if ((await st(pg)).fs) await pg.evaluate(() => document.exitFullscreen());
  const ready = await pg.evaluate(() => !!(document.getElementById('btn-bot-2') && document.getElementById('ask-watch') && document.getElementById('settings') && window.__ui.askWatch && window.__ui.settings && window.__scene.getView && window.__scene._dbg.view));
  if (!ready) out.push('SKIP  the real ui.js / scene.js do not carry docs/API-NEXT.md yet: Play a bot, watch, views, panel and result on the real page not run');
  else { let s; const view = () => pg.evaluate(() => window.__scene._dbg.view()), body = () => pg.evaluate(() => ({ ...document.body.dataset })), vis = id => pg.evaluate(id => { const e = document.getElementById(id); return !!e && !e.hidden && getComputedStyle(e).visibility !== 'hidden' && e.getBoundingClientRect().width > 0; }, id), snap = async n => { await sleep(500); await pg.screenshot({ path: `${root}test/ui-shots/menu-${n}-1280x720.png` }); };
    let v = await view(); ok(v.menu && v.attract && !v.spectator, `real scene in the lobby: menu camera ${v.menu}, attract rally ${v.attract}, pixel ratio ${v.pixelRatio}`);
    await pg.click('#btn-bot'); await sleep(400); s = await st(pg); ok(s.view === 'bot' && s.title === 'Play a bot', `Play a bot view ("${s.title}")`); await snap('9-bot');
    await pg.click('#btn-bot-2'); await sleep(900); s = await st(pg); v = await view();
    ok(J(sent('create').at(-1)) === J({ type: 'create', public: false, name: NAME }) && J(sent('bot').at(-1)) === J({ type: 'bot', level: 2 }) && s.screen === 'connect' && s.pill === 'CRTD' && !v.attract && v.menu, `Pro: ${J(sent('create').at(-1))} + ${J(sent('bot').at(-1))} -> ${s.screen}, no share view, rally stopped`);
    await pg.keyboard.press('Escape'); await sleep(600); v = await view(); ok((await st(pg)).screen === 'lobby' && v.attract, 'Back: lobby again, the rally too');
    // no name, no seat
    got.length = 0; await pg.click('#name-input', { clickCount: 3 }); await pg.keyboard.press('Backspace'); await sleep(100); await pg.click('#btn-quick'); await sleep(500); ok(!got.length && (await st(pg)).screen === 'lobby', `empty name: Quick play sends nothing (${J(got)})`);
    await pg.click('#name-input'); await type(pg, 'Dan'); await pg.click('#btn-code'); await sleep(350); await type(pg, 'fwww'); await pg.keyboard.press('Enter'); await sleep(600);
    ok(await vis('ask-watch') && await pg.evaluate(() => window.__ui.asking()), 'join a full court -> the watch prompt'); await snap('10-ask-watch');
    await pg.click('#btn-watch-yes'); await sleep(1500); s = await st(pg); v = await view(); let b = await body();
    ok(J(sent('watch').at(-1)) === J({ type: 'watch', code: 'FWWW', name: NAME }) && s.screen === 'hud' && b.role === 'spectator' && v.spectator && !v.menu && !v.attract && v.name === 'broadcast' && /court=FWWW&watch=1/.test(s.search), `Yes -> ${J(sent('watch').at(-1))} -> the court, ${v.name} view, url ${s.search}`);
    ok(await pg.evaluate(() => document.getElementById('name-me').textContent + '/' + document.getElementById('name-them').textContent) === 'Ann/Bo' && !(await vis('keys')) && !(await vis('podwrap')) && await vis('views') && !(await pg.$('#watch-tag')), 'spectator HUD: Ann / Bo, no Watching tag, view chips, no key hints, no AirPod inset'); await snap('11-watch-broadcast');
    const seenViews = []; for (const k of ['Digit2', 'Digit3', 'Digit3', 'Digit4']) { await pg.keyboard.press(k); await sleep(250); v = await view(); seenViews.push(v.name + (v.name === 'pov' ? v.side : '')); if (k === 'Digit2') await snap('12-watch-split'); }
    ok(seenViews.join(' ') === 'split pov0 pov1 free' && (await body()).view === 'free', `keys 2 3 3 4: ${seenViews.join(' ')}`); await pg.click('.view-chip[data-view="broadcast"]'); await sleep(250); ok((await view()).name === 'broadcast', 'a chip does what its key does');
    got.length = 0; await pg.keyboard.press('Escape'); await sleep(500); ok(await vis('settings') && !(await vis('btn-recenter')) && await vis('btn-leave-room') && !got.length, 'Esc: the panel, spectator rows only, Leave room shown, nothing sent'); await snap('13-watch-settings'); await pg.keyboard.press('Escape'); await sleep(300); ok(!(await vis('settings')), 'Esc again closes it');
    push({ type: 'point', winner: 1 }); await sleep(400); ok(await pg.evaluate(() => document.getElementById('banner-text').textContent) === 'Bo scores', 'point banner: "Bo scores"');
    push({ type: 'hold', side: 0, left: 12 }); await sleep(400); ok(await vis('hold') && /Waiting for Ann/.test(await pg.evaluate(() => document.getElementById('hold').textContent)), 'hold card: "Waiting for Ann"'); await snap('14-watch-hold'); push({ type: 'holdoff' }); await sleep(300); ok(!(await vis('hold')), 'holdoff hides it');
    push({ type: 'matchover', winner: 0, score: [11, 8], forfeit: false, rematchBy: 20 }); await sleep(900); ok((await body()).overlay === 'match' && await pg.evaluate(() => document.getElementById('result-title').textContent) === 'Ann wins' && !(await vis('btn-rematch')), 'result for a spectator: "Ann wins", no buttons'); await snap('15-watch-result');
    clearInterval(last.tick); last.room = null; push({ type: 'closed', reason: 'norematch' }); push(LIST); await sleep(900); s = await st(pg); v = await view(); b = await body();
    ok(s.screen === 'lobby' && s.toast === 'No rematch' && !b.role && !b.overlay && v.attract && v.menu && !/court=|room=|watch=/.test(s.search), `closed: lobby, toast "${s.toast}", player HUD again, rally back, url "${s.search}"`); }
  await pg.close(); }
// and a player on the REAL page, with a (fake) AirPod: Play a bot -> calibrate -> court; the hamburger pauses against Matt; result with Rematch / Leave
{ got.length = 0; rest(); const pg = await open('next-player', '&uitest=1', 1280, 720, NAME, POD); await pg.click('#btn-start'); await sleep(700); if ((await st(pg)).fs) await pg.evaluate(() => document.exitFullscreen());
  if (!await pg.evaluate(() => !!(document.getElementById('btn-bot-1') && document.getElementById('btn-menu') && window.__ui.settings && window.__ui.rematch && window.__scene._dbg.view))) out.push('SKIP  the real ui.js / scene.js do not carry docs/API-NEXT.md yet: pause and rematch on the real page not run');
  else { const view = () => pg.evaluate(() => window.__scene._dbg.view()), body = () => pg.evaluate(() => ({ ...document.body.dataset })), text = id => pg.evaluate(id => document.getElementById(id).textContent.trim(), id), snap = async n => { await sleep(500); await pg.screenshot({ path: `${root}test/ui-shots/menu-${n}-1280x720.png` }); };
    await pg.click('#btn-bot'); await sleep(400); await pg.click('#btn-bot-1'); await waitFor('calibrate screen (real page)', async () => (await st(pg)).screen === 'calibrate', 6000); go();
    last.st.paddles = [ME, MATT]; push({ type: 'names', names: [NAME, 'Matt'] }); push({ type: 'botinfo', active: true, level: 1, name: 'Club' });
    await waitFor('calibrated, court open (real page)', async () => (await st(pg)).screen === 'hud' && await pg.evaluate(() => window.__stats.phase === 'play'), 30000); await sleep(1200); let v = await view();
    ok(J(sent('bot')[0]) === J({ type: 'bot', level: 1 }) && !v.menu && !v.attract && !v.spectator && v.pixelRatio >= 1 && await text('name-them') === 'Matt' && await text('sub-them') === 'Club', `on the court against ${await text('name-them')} · ${await text('sub-them')}: menu mode off, pixel ratio ${v.pixelRatio}`); await snap('16-play-matt');
    got.length = 0; await pg.click('#btn-menu'); await sleep(900); v = await view(); let b = await body();
    ok(J(sent('pause')) === J([{ type: 'pause', on: true }]) && b.paused && b.settings === 'open' && v.frozen && await text('set-title') === 'Paused', `hamburger against Matt: ${J(sent('pause'))}, "${await text('set-title')}", ball frozen`); await snap('17-paused');
    const p0 = await pg.evaluate(() => window.__scene._dbg.ballMesh ? window.__scene._dbg.ballMesh.position.toArray() : null); await sleep(1000); const p1 = await pg.evaluate(() => window.__scene._dbg.ballMesh ? window.__scene._dbg.ballMesh.position.toArray() : null); ok(J(p0) === J(p1) && !sent('swing').length, `paused for 1 s: ball ${J(p0 && p0.map(x => +x.toFixed(2)))} did not move, ${sent('swing').length} swings sent`);
    got.length = 0; await pg.click('#btn-sens-more'); await sleep(200); ok(await text('set-sens-val') === '5' && /"sideDeg":70/.test(await pg.evaluate(() => localStorage.getItem('poddle.settings'))), `Sensitivity +: ${await text('set-sens-val')}, kept`);
    await pg.keyboard.press('Escape'); await sleep(700); v = await view(); b = await body(); ok(J(sent('pause')) === J([{ type: 'pause', on: false }]) && !b.paused && !b.settings && !v.frozen, `Esc: ${J(sent('pause'))}, playing again`);
    last.st.paddles = [ME, HUMAN]; push({ type: 'names', names: [NAME, 'Eve'] }); await sleep(500); got.length = 0; await pg.keyboard.press('Escape'); await sleep(700); b = await body();
    ok(!sent('pause').length && b.settings === 'open' && !b.paused && await pg.evaluate(() => { const n = document.getElementById('set-note'); return !n.hidden && n.textContent.trim(); }) === 'Online games can’t pause', 'against a human: the panel opens over a live game, nothing sent, the note shows'); await snap('18-settings-online'); await pg.keyboard.press('Escape'); await sleep(400);
    push({ type: 'serve', by: 0 }); push({ type: 'matchover', winner: 1, score: [9, 11], forfeit: false, rematchBy: 20 }); await sleep(900); push({ type: 'rematch', votes: [null, true], left: 18 }); await sleep(400);
    ok((await body()).overlay === 'match' && await text('result-title') === 'Eve wins' && await text('rematch-note') === 'Eve wants a rematch', `result: "${await text('result-title')}", "${await text('rematch-note')}"`); await snap('19-result-votes');
    got.length = 0; await pg.click('#btn-rematch'); await sleep(300); push({ type: 'rematch', votes: [true, true], left: 17 }); push({ type: 'rematchon' }); await sleep(700);
    ok(J(sent('rematch')) === J([{ type: 'rematch', yes: true }]) && !(await body()).overlay && (await st(pg)).screen === 'hud', `Rematch: ${J(sent('rematch'))}, rematchon -> the court again`); }
  await pg.evaluate(() => { localStorage.removeItem('poddle.settings'); localStorage.removeItem('poddle.view'); }); rest(); await pg.close(); }      // part B starts from the defaults
}

// =====================================================================================================================
// Part B: main.js alone, against recording stubs of ui.js and scene.js that export exactly the names of docs/API-NEXT.md
// sections 2 and 3 (the real ones are being written by other owners). Every call lands in window.__calls as
// ['ui.name' | 'scene.name', ...args]; a call identical to the last one of the same name is dropped (state arrives 20 x a second),
// the per-frame ones are only counted (window.__n). The stubs keep just enough state for main.js to find its way.
if (ONLY.includes('b')) {
const UI_NAMES = 'showScreen showOverlay currentScreen currentOverlay setNames setScore setServe setRally callout toast toastOff confetti confettiOff setStatus setLink setServerAddress calibrationReset calibration setMode toggle setCamera isVisible setStat fullscreen wake onStart onRetry cleanCode onLobby lobbyView lobbyRooms lobbyBusy lobbyLink codeError setRoom titleRoom pointBanner matchResult show playerName askWatch asking onSettings settings setSettings setPaused setSpectator setWatchers onView setView onRematch rematch hold setBot'.split(' ');
const SCENE_NAMES = 'setCourt setSide setViewer setView getView setMenu startAttract stopAttract setFrozen setDim updatePaddle updateBall hideBall onEvent unlockAudio render resize'.split(' ');
const REC = `const C = window.__calls = window.__calls || [], N = window.__n = window.__n || {}, lastOf = {}, QUIET = ['ui.setStat', 'ui.setStatus', 'ui.setLink', 'ui.lobbyLink', 'ui.isVisible', 'ui.currentScreen', 'ui.currentOverlay', 'ui.wake', 'ui.asking', 'ui.playerName', 'ui.cleanCode', 'ui.calibration', 'scene.render', 'scene.updateBall', 'scene.updatePaddle', 'scene.setViewer', 'scene.getView'];
  const rec = (n, a) => { N[n] = (N[n] || 0) + 1; if (QUIET.includes(n)) return; const j = JSON.stringify(a, (k, v) => typeof v === 'function' ? 'fn' : v === undefined ? null : v); if (lastOf[n] === j && !/settings|askWatch|toast|rematch|onEvent|pointBanner|setView|Attract|setSide|setMenu|setRoom/.test(n)) return; lastOf[n] = j; C.push([n, ...JSON.parse(j)]); };`;
const UI_STUB = `${REC}
  const S = window.__uistub = { screen: null, overlay: null, view: 'home', open: false, asking: null, vis: { podwrap: true, dev: false }, h: {} };
  const setOpen = o => { if (o === S.open) return; S.open = o; const h = S.h.settings || {}; (o ? h.open : h.close)?.(); };
  const impl = { showScreen: n => { S.screen = n || null; document.body.dataset.screen = n || 'hud'; if (n) setOpen(false); }, showOverlay: n => { S.overlay = n || null; if (n === 'match') setOpen(false); }, currentScreen: () => S.screen, currentOverlay: () => S.overlay,
    lobbyView: n => { if (!n) return S.view; S.view = n; }, cleanCode: t => { t = String(t || '').toUpperCase(); const m = /ROOM=([A-Z0-9]{4})/.exec(t); return ((m ? m[1] : t).match(/[ABCDEFGHJKMNPQRSTUVWXYZ23456789]/g) || []).slice(0, 4).join(''); },
    isVisible: id => !!S.vis[id], show: (id, on) => (S.vis[id] = !!on), toggle: id => (S.vis[id] = !S.vis[id]), settings: o => { if (o === undefined) return S.open; setOpen(!!o); }, askWatch: c => { S.asking = c || null; }, asking: () => !!S.asking,
    playerName: () => window.__name !== undefined ? window.__name : (localStorage.getItem('poddle.name') || ''), matchResult: () => { S.overlay = 'match'; setOpen(false); },
    onLobby: h => { S.h.lobby = h; }, onSettings: h => { S.h.settings = h; }, onView: f => { S.h.view = f; }, onRematch: f => { S.h.rematch = f; }, onStart: f => { S.h.start = f; }, onRetry: f => { S.h.retry = f; } };
  const call = n => (...a) => { rec('ui.' + n, a); return impl[n] ? impl[n](...a) : undefined; };
  export const SHOTS = {}, shotName = k => String(k || '');
  ${UI_NAMES.map(n => `export const ${n} = call('${n}');`).join('\n  ')}`;
const SCENE_STUB = `${REC}
  export const coast = () => {}, coastTo = () => {}, hover = () => {}, serverClock = () => ({ reset() {} });
  export function createScene() { const V = { name: 'play', side: 0, spectator: false, menu: false, attract: false, frozen: false }, VIEWS = ['broadcast', 'split', 'pov', 'free'], o = { _dbg: { view: () => ({ ...V }) } };
    const impl = { setSide: s => { V.spectator = s === null; if (!V.spectator) { V.name = 'play'; V.side = s === 1 ? 1 : 0; } else if (V.name === 'play') { V.name = 'broadcast'; V.side = 0; } }, getView: () => ({ name: V.name, side: V.side }),
      setView: (n, s = 0) => { if (V.spectator && VIEWS.includes(n)) { V.name = n; V.side = n === 'pov' ? (s === 1 ? 1 : 0) : 0; } return { name: V.name, side: V.side }; }, setMenu: on => { V.menu = !!on; }, startAttract: () => { V.attract = true; }, stopAttract: () => { V.attract = false; }, setFrozen: on => { V.frozen = !!on; }, render: () => true };
    for (const n of ${JSON.stringify(SCENE_NAMES)}) o[n] = (...a) => { rec('scene.' + n, a); return impl[n] ? impl[n](...a) : undefined; };
    return o; }`;
async function openB(tag, query = '', { name = NAME, airpod = false } = {}) { const pg = await browser.newPage(); await pg.setViewport({ width: 1280, height: 720 });
  await pg.evaluateOnNewDocument(n => { try { if (n) localStorage.setItem('poddle.name', n); else localStorage.removeItem('poddle.name'); } catch { /* no storage */ } }, name);
  await pg.setRequestInterception(true); pg.on('request', r => { const f = new URL(r.url()).pathname; if (f === '/ui.js' || f === '/scene.js') r.respond({ status: 200, contentType: 'text/javascript', body: f === '/ui.js' ? UI_STUB : SCENE_STUB }); else r.continue(); });
  pg.on('pageerror', e => errs.push(`[${tag}] PAGEERROR ${e.message}`)); pg.on('console', m => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED|WebSocket connection|Failed to load resource/.test(m.text())) errs.push(`[${tag}] ${m.text()}`); });
  await pg.goto(`http://localhost:${W}/?bridge=${airpod ? POD : DEAD}&game=${G}&cam=0&uitest=1${query}`); await sleep(1500); return pg; }
const mark = pg => pg.evaluate(() => window.__calls.length), since = (pg, n) => pg.evaluate(n => window.__calls.slice(n), n), counts = pg => pg.evaluate(() => ({ ...window.__n }));
const has = (cs, name, test = () => true) => cs.some(c => c[0] === name && test(...c.slice(1))), names = cs => [...new Set(cs.map(c => c[0]))];
const info = pg => pg.evaluate(() => ({ phase: window.__stats.phase, role: window.__stats.role, room: window.__stats.room, errors: window.__stats.errors, screen: window.__uistub.screen, overlay: window.__uistub.overlay, open: window.__uistub.open, asking: window.__uistub.asking, view: window.__scene._dbg.view(), search: location.search }));
const h = (pg, path, ...args) => pg.evaluate((path, args) => { const [a, b] = path.split('.'), o = window.__uistub.h[a]; return b ? o[b](...args) : o(...args); }, path, args);      // press what the real ui.js would: h(pg, 'lobby.quick')
const GAME_UI = ['ui.setNames', 'ui.setScore', 'ui.setServe', 'ui.setRally', 'ui.pointBanner', 'ui.matchResult', 'ui.rematch', 'ui.toast', 'ui.confetti', 'ui.hold', 'ui.setPaused', 'ui.setWatchers', 'ui.setSpectator', 'ui.callout', 'ui.showOverlay', 'ui.setRoom'],
  GAME_SCENE = ['scene.setCourt', 'scene.setSide', 'scene.updateBall', 'scene.updatePaddle', 'scene.onEvent', 'scene.setFrozen', 'scene.hideBall', 'scene.stopAttract', 'scene.setView'];

// B1. the guard: an old server seats the lobby socket by itself and plays a match at it. Nothing of it may reach the UI or the scene.
{ evil = true; got.length = 0; const pg = await openB('guard'); let cs = await since(pg, 0), n = await counts(pg), i = await info(pg);
  ok(has(cs, 'scene.setMenu', on => on === true) && has(cs, 'scene.startAttract') && i.view.attract && i.view.menu, `page load: menu mode on, attract rally started (${names(cs).filter(c => c.startsWith('scene.')).join(' ')})`);
  ok(has(cs, 'ui.lobbyRooms', (r, o) => r.length === 2 && o === 3), 'guard: the lobby list still gets through');
  const leak = () => [...GAME_UI, ...GAME_SCENE].filter(c => n[c] || has(cs, c));
  ok(!leak().length && i.phase === 'title' && i.errors === 0, `guard on the title: welcome / state / names / botinfo / serve / hit / point / hold / paused / left / match / matchover / rematch from a lobby socket -> 0 game calls (${leak()}), errors ${i.errors}`);
  await h(pg, 'start'); await sleep(400); push({ type: 'matchover', winner: 1, score: [0, 11], rematchBy: 20 }); push({ type: 'state', t: 2, p: [0, 1, 0], v: [0, 0, 0], live: true, serving: 0, score: [9, 9], paddles: [ME, MATT] }); push({ type: 'point', winner: 0 }); push({ type: 'closed', reason: 'norematch' }); await sleep(500);
  cs = await since(pg, 0); n = await counts(pg); i = await info(pg);
  ok(!leak().length && i.phase === 'lobby' && i.screen === 'lobby' && i.overlay === null && i.view.attract, `guard in the lobby: still 0 game calls (${leak()}), screen ${i.screen}, no result card, rally still running`);
  ok(!got.some(m => ['paddle', 'swing', 'bot', 'pause'].includes(m.type)), `guard: nothing but lobby talk goes out (${[...new Set(got.map(m => m.type))]})`); evil = false; await pg.close(); }

// B2. a shared link with no name yet: the code is filled in, nothing is sent until there is a name
{ got.length = 0; const pg = await openB('noname', '&room=wxyz', { name: '' }); await h(pg, 'start'); await sleep(600); const cs = await since(pg, 0), i = await info(pg);
  ok(has(cs, 'ui.lobbyView', (v, o) => v === 'code' && o && o.code === 'WXYZ') && !got.length && i.phase === 'lobby', `?room=WXYZ with no name: code view prefilled, nothing sent (${J(got)})`);
  await pg.evaluate(() => { window.__name = '  <b>Zed</b>   the \u0007 Great!! '; }); await h(pg, 'lobby.join', 'WXYZ'); await sleep(600);
  ok(J(got[0]) === J({ type: 'join', code: 'WXYZ', name: 'bZed/b the G' }), `a name typed then Join: sent cleaned and cut to 12 (${J(got[0])})`);
  ok(await pg.evaluate(() => localStorage.getItem('poddle.name')) === 'bZed/b the G', 'the name is kept in localStorage poddle.name'); await pg.close(); }

// B3. Play a bot, then a whole player's evening against the script: names, pause, hold, points, result, rematch, settings, keys, leave
{ got.length = 0; rest(); const pg = await openB('player', '', { airpod: true }); let m0 = await mark(pg), cs, i;
  await h(pg, 'start'); await sleep(400); await h(pg, 'lobby.bot', 2); await waitFor('bot level sent', () => sent('bot').length > 0); await sleep(300); cs = await since(pg, m0); i = await info(pg);
  ok(J(sent('create').at(-1)) === J({ type: 'create', public: false, name: NAME }) && J(sent('bot')[0]) === J({ type: 'bot', level: 2 }) && got.findIndex(m => m.type === 'bot') > got.findIndex(m => m.type === 'create'), `Play a bot: ${J(sent('create').at(-1))} then, after the welcome, ${J(sent('bot')[0])}`);
  ok(!has(cs, 'ui.lobbyView', v => v === 'share') && has(cs, 'scene.stopAttract') && has(cs, 'ui.setRoom', c => c === 'CRTD') && has(cs, 'scene.setSide', s => s === 0) && has(cs, 'scene.setCourt') && has(cs, 'ui.setSpectator', on => on === false) && has(cs, 'ui.setSettings', o => o.inRoom === true && o.spectator === false) && /court=CRTD/.test(i.search) && !/watch/.test(i.search),
    `Play a bot: no share view, rally stopped, room pill, side 0, settings told inRoom (${i.search})`);
  ok(i.view.menu && ['connect', 'calibrate'].includes(i.screen), `set-up screens keep menu mode on (screen ${i.screen}, menu ${i.view.menu})`);
  ok(!sent('paddle').length && !sent('swing').length, 'not calibrated: no paddle, no swing');
  await waitFor('calibrate screen', async () => (await info(pg)).screen === 'calibrate', 6000); go(); last.st.paddles = [ME, MATT]; push({ type: 'names', names: [NAME, 'Matt'] }); push({ type: 'botinfo', active: true, level: 2, name: 'Pro' });
  push({ type: 'matchover', winner: 0, score: [11, 2], forfeit: false, rematchBy: 20 }); await sleep(400); ok((await info(pg)).overlay === null && !has(await since(pg, m0), 'ui.matchResult'), 'a matchover during calibration is not drawn over the set-up screen');
  push({ type: 'rematchon' }); m0 = await mark(pg);
  await waitFor('calibrated and on the court', async () => { const i = await info(pg); return i.phase === 'play' && i.screen === null; }, 30000); await sleep(300); cs = await since(pg, m0); i = await info(pg);
  ok(has(cs, 'ui.showScreen', n => n === null) && has(cs, 'scene.setMenu', on => on === false) && !i.view.menu && !has(cs, 'ui.matchResult'), 'the court opens: menu mode off, and the matchover that rematchon overtook is never shown');
  ok(has(await since(pg, 0), 'ui.setNames', o => o.me === 'You' && o.them === 'Matt' && o.themSub === 'Pro'), 'scoreboard: You / Matt, his level underneath');
  await waitFor('paddle + swing flowing', () => sent('paddle').length > 5 && sent('swing').length > 0, 12000); const sw = sent('swing')[0];
  ok(sw && ['power', 'dir', 'lob', 'chop', 'age', 'net', 'slice'].every(k => typeof sw[k] === 'number' && isFinite(sw[k])) && typeof sw.fix === 'boolean' && Math.abs(sw.slice) <= 1 && sw.lob >= 0, `swing carries ${sw && Object.keys(sw).join(' ')} (slice ${sw && sw.slice.toFixed(2)}, lob ${sw && sw.lob.toFixed(2)})`);
  { const src = fs.readFileSync(root + 'web/main.js', 'utf8'), a = src.indexOf('const roll = Math.max('), b = src.indexOf('game.send({ type: \'swing\'', a), shot = new Function('e', src.slice(a, b) + '; return { slice, lob };'), r2 = v => +v.toFixed(2);      // the very lines main.js runs (test/kinds.mjs reads the same anchor)
    const spins = [[0.1, 0], [0.3, 0], [0.535, 0], [0.95, 0], [0, 1.45], [-0.5, 0.2]].map(([roll, turn]) => r2(shot({ roll, turn, curl: 1, dir: 1, lob: 0.8 }).slice)), lobs = [0, 0.6, 0.8, 1.0, 1.4].map(turn => r2(shot({ roll: 0, turn, curl: 0, dir: 1, lob: 0.8 }).lob));
    ok(J(spins) === J([0, -0.22, -0.5, -1, 0.44, 0.46]), `spin is continuous (docs/NEXT.md 3b; the turn range is 0.3..2.9 since every swing ends in its settled report): roll .1 .3 .535 .95, turn 1.45, roll -.5 -> ${spins}`); ok(J(lobs) === J([0.8, 0.8, 0.4, 0, 0]), `lob gate (docs/NEXT.md 2): lob 0.8 at turn 0 .6 .8 1 1.4 -> ${lobs}`); }
  // a toast when a human takes the other seat, none for Matt or a renamed player
  m0 = await mark(pg); last.st.paddles = [ME, HUMAN]; push({ type: 'names', names: [NAME, '<i>Eve</i>'] }); await sleep(300); push({ type: 'names', names: [NAME, 'Evie'] }); await sleep(300); cs = await since(pg, m0);
  ok(cs.filter(c => c[0] === 'ui.toast').map(c => c[1]).join('|') === '<i>Eve</i> joined' && has(cs, 'ui.setNames', o => o.them === 'Evie' && o.themSub === 'Far side' && o.meSub === 'Near side'), `names: one toast "${cs.filter(c => c[0] === 'ui.toast').map(c => c[1])}", scoreboard follows (raw text: ui.js renders it with textContent)`);
  // settings against a human: no pause, the note
  m0 = await mark(pg); got.length = 0; await pg.keyboard.press('Escape'); await sleep(400); cs = await since(pg, m0); i = await info(pg);
  ok(i.open && !sent('pause').length && has(cs, 'ui.setSettings', o => o.canPause === false), 'Esc opens the panel; against a human nothing is sent and the panel is told canPause:false');
  await pg.keyboard.press('Escape'); await sleep(300); ok(!(await info(pg)).open && !sent('pause').length, 'Esc closes it again, still nothing sent');
  // a point each
  m0 = await mark(pg); push({ type: 'point', winner: 0 }); await sleep(150); push({ type: 'point', winner: 1 }); await sleep(150); push({ type: 'point', winner: 1, final: true }); await sleep(200); cs = (await since(pg, m0)).filter(c => c[0] === 'ui.pointBanner');
  ok(J(cs.map(c => c.slice(1, 3))) === J([[true, NAME], [false, 'Evie']]), `point banners: ${J(cs.map(c => c.slice(1)))} (none for the final point)`);
  // seat hold
  m0 = await mark(pg); got.length = 0; last.st.paused = true; push({ type: 'hold', side: 1, left: 15 }); await sleep(1300); push({ type: 'hold', side: 1, left: 14 }); await sleep(1300); cs = await since(pg, m0); i = await info(pg);
  ok(J(cs.filter(c => c[0] === 'ui.hold').map(c => c.slice(1))) === J([['Evie', 15], ['Evie', 14]]) && i.view.frozen && !has(cs, 'ui.setPaused', on => on === true), `hold: card "Waiting for Evie" 15, 14; ball frozen; no Paused tag`);
  ok(!sent('swing').length && !sent('pause').length, `hold: ${sent('swing').length} swings and ${sent('pause').length} pause messages sent in 2.6 s (the AirPod kept swinging)`);
  m0 = await mark(pg); last.st.paused = undefined; push({ type: 'holdoff' }); await sleep(400); cs = await since(pg, m0); i = await info(pg); ok(has(cs, 'ui.hold', n => n === null) && !i.view.frozen, 'holdoff: card gone, ball released by the next state');
  // the other player goes before a match: plain 'left', then Matt again. Pause works now.
  m0 = await mark(pg); push({ type: 'left' }); last.st.paddles = [ME, MATT]; push({ type: 'names', names: [NAME, 'Matt'] }); push({ type: 'botinfo', active: true, level: 1, name: 'Club' }); await sleep(400); cs = await since(pg, m0);
  ok(J(cs.filter(c => c[0] === 'ui.toast').map(c => c[1])) === J(['Evie left', 'Matt · Club']), `toasts: ${J(cs.filter(c => c[0] === 'ui.toast').map(c => c[1]))}`);
  m0 = await mark(pg); got.length = 0; await pg.keyboard.press('Escape'); await sleep(2600); cs = await since(pg, m0); i = await info(pg);
  ok(J(sent('pause')) === J([{ type: 'pause', on: true }]) && has(cs, 'ui.setPaused', on => on === true) && has(cs, 'scene.setFrozen', on => on === true) && i.view.frozen && i.open, `panel open against Matt: ${J(sent('pause'))}, Paused, ball frozen`);
  ok(!sent('swing').length, `paused: ${sent('swing').length} swings sent in 2.6 s`);
  m0 = await mark(pg); got.length = 0; await h(pg, 'settings.sens', 1); await h(pg, 'settings.sens', 1); await h(pg, 'settings.sens', -1); await h(pg, 'settings.airpod', false); await h(pg, 'settings.stats', true); await h(pg, 'settings.recenter'); cs = await since(pg, m0);
  ok(J(cs.filter(c => c[0] === 'ui.setSettings' && c[1].sens != null).map(c => c[1].sens).slice(0, 3)) === J([5, 6, 5]) && has(cs, 'ui.show', (id, on) => id === 'podwrap' && on === false) && has(cs, 'ui.show', (id, on) => id === 'dev' && on === true) && has(cs, 'ui.toast', t => t === 'Re-centered') && !cs.some(c => c[0] === 'ui.toast' && /Range/.test(c[1])),
    `panel rows: sensitivity 4 -> ${cs.filter(c => c[0] === 'ui.setSettings' && c[1].sens != null).map(c => c[1].sens)}, Show AirPod off, Show stats on, Re-center; the steps say nothing`);
  ok(J(JSON.parse(await pg.evaluate(() => localStorage.getItem('poddle.settings')))) === J({ airpod: false, stats: true, sideDeg: 70 }), `kept: poddle.settings = ${await pg.evaluate(() => localStorage.getItem('poddle.settings'))}`);
  // docs/NEXT.md 14d: how you move and Matt's level are rows in the panel; the hint and the row only exist against Matt (ui.setBot)
  m0 = await mark(pg); got.length = 0; await h(pg, 'settings.move', 'auto'); await h(pg, 'settings.move', 'body'); await h(pg, 'settings.move', 'fly'); await h(pg, 'settings.bot', 2); await h(pg, 'settings.bot', 7); await sleep(200); cs = await since(pg, m0);
  ok(J(cs.filter(c => c[0] === 'ui.setMode').map(c => c[1])) === J(['Auto']) && J(sent('bot')) === J([{ type: 'bot', level: 2 }]) && has(await since(pg, 0), 'ui.setSettings', o => o.bodyOk === false), `panel rows: Move -> ${J(cs.filter(c => c[0] === 'ui.setMode').map(c => c[1]))} (Body needs a camera, 'fly' is nothing), Difficulty -> ${J(sent('bot'))}`);
  ok(await pg.evaluate(() => window.__calls.filter(c => c[0] === 'ui.setBot').map(c => c[1])).then(v => v.includes('Club') && v.includes(null) && v.at(-1) === 'Club'), 'ui.setBot: null against Evie, Club against Matt');
  await h(pg, 'settings.name', 'Danny'); await sleep(200); ok(J(sent('name')) === J([{ type: 'name', name: 'Danny' }]) && await pg.evaluate(() => localStorage.getItem('poddle.name')) === 'Danny', `Name row in a room: ${J(sent('name'))}, kept`);
  got.length = 0; await pg.keyboard.press('Escape'); await sleep(500); i = await info(pg); ok(J(sent('pause')) === J([{ type: 'pause', on: false }]) && !i.open && !i.view.frozen, `Esc closes and resumes: ${J(sent('pause'))}`);
  got.length = 0; last.st.paused = true; await sleep(2300); const heals = sent('pause'); last.st.paused = undefined; ok(heals.length >= 1 && heals.length <= 3 && heals.every(m => m.on === false), `self-heal: paused with the panel shut -> ${heals.length} x pause off in 2.3 s`);
  // the silent keys
  await sleep(400); m0 = await mark(pg); got.length = 0; for (const k of ['KeyV', 'KeyH', 'BracketRight', 'BracketLeft', 'KeyR', 'KeyM', 'KeyB', 'Digit3', 'KeyP']) { await pg.keyboard.press(k); await sleep(80); } await sleep(200); cs = await since(pg, m0);
  ok(has(cs, 'ui.show', (id, on) => id === 'podwrap' && on === true) && has(cs, 'ui.setSettings', o => o.airpod === true) && has(cs, 'ui.show', (id, on) => id === 'dev' && on === false) && cs.filter(c => c[0] === 'ui.toast' && /^Range/.test(c[1])).length === 2 && has(cs, 'ui.toast', t => t === 'Re-centered') && !has(cs, 'ui.setMode') && J(sent('bot')) === J([{ type: 'bot' }, { type: 'bot', level: 2 }]),
    `V H ] [ R B 3 P still work, M does nothing on the court now: docs/NEXT.md 14d (${names(cs).join(' ')}; bot: ${J(sent('bot'))})`);
  // result, votes, rematch
  m0 = await mark(pg); got.length = 0; push({ type: 'serve', by: 0 }); push({ type: 'matchover', winner: 0, score: [11, 7], forfeit: false, rematchBy: 20 }); await sleep(500); cs = await since(pg, m0); i = await info(pg);
  ok(has(cs, 'ui.matchResult', o => o.won === true && o.me === 11 && o.them === 7 && o.nameMe === 'You' && o.nameThem === 'Matt' && o.forfeit === false && o.role === 'player' && o.vote === true) && has(cs, 'ui.rematch', o => o.left === 20 && o.name === 'Matt') && has(cs, 'ui.confetti') && has(cs, 'ui.setServe', w => w === null) && i.overlay === 'match', `matchover: ${J(cs.find(c => c[0] === 'ui.matchResult'))}`);
  await pg.keyboard.press('Escape'); await sleep(200); ok(!(await info(pg)).open, 'Esc on the result card opens nothing');
  await h(pg, 'rematch', true); push({ type: 'rematch', votes: [true, null], left: 17 }); await sleep(300); cs = await since(pg, m0);
  ok(J(sent('rematch')) === J([{ type: 'rematch', yes: true }]) && has(cs, 'ui.rematch', o => o.mine === true && o.theirs === null && o.left === 17 && o.name === 'Matt'), `Rematch: ${J(sent('rematch'))}, votes passed on`);
  m0 = await mark(pg); push({ type: 'rematchon' }); await sleep(300); cs = await since(pg, m0); i = await info(pg); ok(has(cs, 'ui.showOverlay', n => n === null) && i.overlay === null && i.phase === 'play', 'rematchon: the card goes, same room, same court');
  m0 = await mark(pg); got.length = 0; push({ type: 'matchover', winner: 1, score: [4, 11], forfeit: true, rematchBy: 20 }); await sleep(300); await h(pg, 'rematch', false); await sleep(300);
  ok(J(sent('rematch')) === J([{ type: 'rematch', yes: false }]) && !sent('leave').length && (await info(pg)).phase === 'play', `Leave: ${J(sent('rematch'))}, no 'leave' on top, waits for the server`);
  clearInterval(last.tick); last.room = null; push({ type: 'closed', reason: 'norematch' }); push(LIST); await sleep(500); cs = await since(pg, m0); i = await info(pg);
  ok(has(cs, 'ui.matchResult', o => o.won === false && o.forfeit === true) && i.phase === 'lobby' && i.screen === 'lobby' && i.room === null && !/court=|room=/.test(i.search) && !has(cs, 'ui.toast', t => t === 'No rematch'), `closed: back in the lobby (${i.screen}), url "${i.search}", no toast for the one who pressed Leave`);
  ok(has(cs, 'scene.startAttract') && has(cs, 'scene.setMenu', on => on === true) && has(cs, 'scene.setSide', s => s === 0) && has(cs, 'ui.setRoom', c => c === null) && has(cs, 'ui.setSettings', o => o.inRoom === false) && i.view.attract && i.view.menu && !i.view.frozen, 'back in the lobby: rally and menu mode on again, room pill gone');
  // calibration is kept: Quick play goes straight to the court. Then the room closes under us, then Leave room from the panel.
  m0 = await mark(pg); await h(pg, 'lobby.quick'); await sleep(700); i = await info(pg); ok(i.phase === 'play' && i.screen === null && !i.view.menu && !i.view.attract, `calibrated already: Quick play -> court at once (${i.phase})`);
  clearInterval(last.tick); last.room = null; push({ type: 'closed', reason: 'norematch' }); push(LIST); await sleep(400); cs = await since(pg, m0); ok(has(cs, 'ui.toast', t => t === 'No rematch') && (await info(pg)).phase === 'lobby', 'closed norematch for someone who did not press Leave: toast "No rematch"');
  await h(pg, 'lobby.quick'); await sleep(700); got.length = 0; await h(pg, 'settings.leave'); await sleep(400); i = await info(pg); ok(J(sent('leave')) === J([{ type: 'leave' }]) && i.phase === 'lobby', `Leave room row: ${J(sent('leave'))} -> ${i.phase}`);
  // kept across a reload
  await pg.reload(); await sleep(1500); cs = await since(pg, 0);
  ok(has(cs, 'ui.show', (id, on) => id === 'podwrap' && on === true) && has(cs, 'ui.show', (id, on) => id === 'dev' && on === false) && has(cs, 'ui.setSettings', o => o.sens === 5 && o.airpod === true && o.stats === false), `after a reload the settings come back: ${J(cs.find(c => c[0] === 'ui.setSettings'))}`);
  rest(); await pg.close(); }

// B4. watching: full court -> prompt -> watch -> straight onto the court; views; no AirPod anything; reload and reconnect keep the role
{ got.length = 0; urls.length = 0; const pg = await openB('watch'); let m0 = await mark(pg), cs, i;
  await h(pg, 'start'); await sleep(400); await h(pg, 'lobby.join', 'FWWW'); await sleep(500); cs = await since(pg, m0); i = await info(pg);
  ok(has(cs, 'ui.askWatch', c => c === 'FWWW') && i.asking === 'FWWW' && i.phase === 'lobby' && !has(cs, 'ui.toast'), 'joinfail full + watch -> "Court is full. Watch instead?"');
  await pg.keyboard.press('Escape'); await sleep(200); i = await info(pg); ok(!i.asking && i.screen === 'lobby', 'Esc answers No, the lobby stays');
  await h(pg, 'lobby.watch', 'BUSY'); await sleep(500); cs = await since(pg, m0); ok(has(cs, 'ui.toast', t => t === 'Too many watching'), 'watch refused (8 already): "Too many watching"');
  m0 = await mark(pg); await h(pg, 'lobby.watch', 'FWWW'); await sleep(700); cs = await since(pg, m0); i = await info(pg);
  ok(J(sent('watch').at(-1)) === J({ type: 'watch', code: 'FWWW', name: NAME }) && i.phase === 'watch' && i.role === 'spectator' && i.screen === null && /court=FWWW/.test(i.search) && /watch=1/.test(i.search), `Watch: ${J(sent('watch').at(-1))} -> phase ${i.phase}, url ${i.search}`);
  ok(!has(cs, 'ui.showScreen', n => n === 'connect' || n === 'calibrate') && has(cs, 'scene.setSide', s => s === null) && has(cs, 'scene.setView', n => n === 'broadcast') && has(cs, 'ui.setView', n => n === 'broadcast') && has(cs, 'ui.setSpectator', on => on === true) && has(cs, 'ui.setSettings', o => o.spectator === true && o.inRoom === true) && has(cs, 'scene.stopAttract') && has(cs, 'scene.setMenu', on => on === false),
    `no connect, no calibration: spectator scene, Broadcast, spectator HUD (${names(cs).join(' ')})`);
  ok(has(cs, 'ui.setNames', o => o.me === 'Ann' && o.them === 'Bo') && (await counts(pg))['scene.updatePaddle'] > 0, 'scoreboard: side 0 left, side 1 right, never "You"; both paddles go to the scene');
  m0 = await mark(pg); last.st.watchers = 3; last.st.score = [4, 9]; push({ type: 'serve', by: 0 }); push({ type: 'point', winner: 1 }); await sleep(300); cs = await since(pg, m0);
  ok(has(cs, 'ui.setWatchers', n => n === 3) && has(cs, 'ui.setScore', (a, b) => a === 4 && b === 9) && has(cs, 'ui.setServe', w => w === 'me') && has(cs, 'ui.pointBanner', (w, n, s) => w === null && n === 'Bo' && s === 1) && !has(cs, 'ui.confetti'), 'spectator: watchers 3, score 4-9 by side, serve dot, "Bo scores" in orange');
  // views
  m0 = await mark(pg); for (const k of ['Digit2', 'Digit3', 'Digit3', 'Digit4', 'Digit3']) { await pg.keyboard.press(k); await sleep(80); } await h(pg, 'view', 'pov'); await sleep(100); cs = await since(pg, m0);
  ok(J(cs.filter(c => c[0] === 'scene.setView').map(c => c.slice(1))) === J([['split', 0], ['pov', 0], ['pov', 1], ['free', 0], ['pov', 0], ['pov', 1]]) && J(cs.filter(c => c[0] === 'ui.setView').map(c => c.slice(1))) === J([['split', ''], ['pov', 'Ann'], ['pov', 'Bo'], ['free', ''], ['pov', 'Ann'], ['pov', 'Bo']]),
    `keys 2 3 3 4 3 + the Player chip: ${J(cs.filter(c => c[0] === 'ui.setView').map(c => c.slice(1)))}`);
  m0 = await mark(pg); push({ type: 'names', names: ['Ann', 'Bob'] }); await sleep(200); ok(has(await since(pg, m0), 'ui.setView', (n, w) => n === 'pov' && w === 'Bob'), 'a new name while in Player view refreshes the chip');
  ok(await pg.evaluate(() => localStorage.getItem('poddle.view')) === 'pov', 'the view is remembered (poddle.view = pov)');
  // keys that are not a spectator's, the panel, the result
  m0 = await mark(pg); got.length = 0; for (const k of ['KeyC', 'KeyB', 'KeyM', 'KeyR', 'KeyV', 'BracketLeft']) { await pg.keyboard.press(k); await sleep(60); } await pg.keyboard.press('Escape'); await sleep(300); cs = await since(pg, m0); i = await info(pg);
  ok(i.open && i.phase === 'watch' && i.screen === null && !got.length && !has(cs, 'ui.toast'), `C B M R V [ do nothing, Esc opens the panel, nothing sent (${J(got)})`); await pg.keyboard.press('Escape');
  m0 = await mark(pg); push({ type: 'matchover', winner: 1, score: [6, 11], forfeit: false, rematchBy: 20 }); push({ type: 'rematch', votes: [true, null], left: 15 }); await sleep(300); cs = await since(pg, m0);
  ok(has(cs, 'ui.matchResult', o => o.won === false && o.me === 6 && o.them === 11 && o.nameMe === 'Ann' && o.nameThem === 'Bob' && o.role === 'spectator') && has(cs, 'ui.rematch', o => o.left === 15 && o.mine === undefined) && !has(cs, 'ui.confetti'), `spectator result: ${J(cs.find(c => c[0] === 'ui.matchResult'))}`);
  await h(pg, 'rematch', true); push({ type: 'rematchon' }); await sleep(300); i = await info(pg); ok(!sent('rematch').length && i.overlay === null && i.phase === 'watch', 'a spectator has no vote and is carried into the next match');
  ok(!got.some(m => !['net'].includes(m.type)), `a spectator sent nothing but ping / net (${[...new Set(got.map(m => m.type))]})`);
  // the socket drops: the reconnect asks for the same place to watch
  urls.length = 0; await stopFake(); await sleep(700); startFake(); await sleep(2500); i = await info(pg);
  ok(urls.length && urls.every(u => /cid=\w+&lobby=1&room=FWWW&watch=1&name=Dan&back=1&pub=[01](&score=\d+-\d+)?$/.test(u)) && i.phase === 'watch' && i.view.name === 'pov' && i.view.side === 1, `reconnect while watching: ${urls[0]} (still ${i.phase}, view ${i.view.name} ${i.view.side}: a restore does not flip it)`);
  // reload: the link carries the role; Play watches at once, in the remembered view
  got.length = 0; await pg.reload(); await sleep(1500); await h(pg, 'start'); await sleep(800); cs = await since(pg, 0); i = await info(pg);
  ok(J(got.filter(m => m.type !== 'net')[0]) === J({ type: 'watch', code: 'FWWW', name: NAME }) && i.phase === 'watch' && has(cs, 'scene.setView', n => n === 'pov'), `?room=FWWW&watch=1 after Play: ${J(got[0])}, view ${i.view.name}`);
  got.length = 0; await pg.keyboard.press('KeyQ'); await sleep(150); await pg.keyboard.press('KeyQ'); await sleep(400); cs = await since(pg, 0); i = await info(pg);
  ok(J(sent('leave')) === J([{ type: 'leave' }]) && i.phase === 'lobby' && !/court=|room=|watch=/.test(i.search) && has(cs, 'ui.setSpectator', on => on === false) && i.view.attract && !i.view.spectator, `Q Q leaves: ${i.phase}, url "${i.search}", player again`);
  await pg.close(); }

// B5. the legacy page: no lobby, no attract, no votes, 'closed' is harmless; a matchover that lands mid-calibration waits for the court
{ rest(); const pg = await openB('legacy', '&skiptitle=1', { airpod: true }); let cs, i; await waitFor('legacy calibrate screen', async () => (await info(pg)).screen === 'calibrate', 6000); go();
  push({ type: 'matchover', winner: 0, score: [11, 3], forfeit: false, rematchBy: 5 }); push({ type: 'closed', reason: 'empty' }); await sleep(400); cs = await since(pg, 0); i = await info(pg);
  ok(i.phase === 'calibrate' && i.view.menu && !i.view.attract && !has(cs, 'scene.startAttract') && has(cs, 'scene.setSide', s => s === 0) && !has(cs, 'ui.matchResult') && i.errors === 0, `legacy: seated at once, menu mode on, no attract rally, the result waits (${i.phase})`);
  await waitFor('legacy on the court', async () => { const i = await info(pg); return i.phase === 'play' && i.screen === null; }, 30000); await sleep(300); cs = await since(pg, 0); i = await info(pg);
  ok(has(cs, 'ui.matchResult', o => o.won === true && o.vote === false && o.role === 'player' && o.me === 11 && o.them === 3) && !has(cs, 'ui.rematch') && i.overlay === 'match', `on entering play the kept matchover is drawn, without votes on the legacy page: ${J(cs.find(c => c[0] === 'ui.matchResult'))}`);
  push({ type: 'rematchon' }); await sleep(300); ok((await info(pg)).overlay === null, 'rematchon closes it'); rest(); await pg.close(); }
}
podWss.close();

const uniq = [...new Set(errs.map(e => e.split('\n')[0].slice(0, 200)))];                // a shader error is a page of text, once per page load
ok(!uniq.length, 'no console errors' + (uniq.length ? ':\n  ' + uniq.join('\n  ') : ''));
console.log(out.join('\n')); const bad = out.filter(l => l.startsWith('FAIL')).length;
console.log(`${out.length - bad} passed, ${bad} failed`); console.log(bad ? 'MENU FAIL' : 'MENU PASS');
await browser.close(); await stopFake(); web.close(); process.exit(bad ? 1 : 0);
