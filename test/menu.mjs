// Main menu, lobby and room flow against a fake lobby server that speaks docs/ROOMS.md (no server/game.js needed).
// Usage: node test/menu.mjs      MENU_PORT=<base> moves the ports (default 8330: page, 8331: fake game, 8332: nothing = no AirPod)
import http from 'http'; import fs from 'fs'; import path from 'path';
import { WebSocketServer } from 'ws';
import puppeteer from 'puppeteer-core';
const P0 = +process.env.MENU_PORT || 8330, W = P0, G = P0 + 1, DEAD = P0 + 2, root = new URL('..', import.meta.url).pathname, sleep = ms => new Promise(r => setTimeout(r, ms));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml' };
const web = http.createServer((q, r) => { let f = path.join(root, 'web', decodeURIComponent(q.url.split('?')[0])); if (f.endsWith('/')) f += 'index.html';
  fs.readFile(f, (e, d) => { r.writeHead(e ? 404 : 200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); r.end(e ? '' : d); }); }).listen(W);

// ---- the fake: a lobby with two listed rooms. WXYZ and KXQ7 exist, FVVV is full, anything else is not found. MUTE=1 answers nothing (an old server).
const got = [], urls = [], J = o => JSON.stringify(o), COURT = { halfW: 3.05, halfL: 6.7, kitchen: 2.13, net: 0.91 }, LIST = { type: 'lobby', online: 3, rooms: [{ code: 'KXQ7', players: 1, open: true }, { code: 'M3PD', players: 0, open: true }] };
let mute = false, gone = false, wss = null;
function seat(ws, code, pub) { ws.room = code; ws.send(J({ type: 'room', code, public: pub })); ws.send(J({ type: 'welcome', side: 0, court: COURT }));
  ws.tick = setInterval(() => ws.readyState === 1 && ws.send(J({ type: 'state', t: Date.now(), p: [0, 1, 5], v: [0, 0, 0], spin: 0, b: 0, k: 0, live: false, serving: 0, reach: false, score: [0, 0], paddles: [{ x: 0, y: 1, z: 6.5, q: [0, 0, 0, 1], bot: false }, null] })), 50); }
function join(ws, code) { code = String(code || '').trim().toUpperCase(); if (gone) ws.send(J({ type: 'joinfail', reason: 'notfound' })); else if (code === 'FVVV') ws.send(J({ type: 'joinfail', reason: 'full' })); else if (!['WXYZ', 'KXQ7', 'M3PD', 'CRTD', 'QQQQ'].includes(code)) ws.send(J({ type: 'joinfail', reason: 'notfound' })); else seat(ws, code, true); }
// A legacy socket (no lobby=1) gets a 'room' too here. The contract does not say it will: the client must show no room UI either way.
function startFake() { wss = new WebSocketServer({ port: G }); wss.on('connection', (ws, req) => { const q = new URL(req.url, 'http://x').searchParams; urls.push(req.url);
  if (q.get('lobby') !== '1') { seat(ws, 'LOCAL', false); return; } ws.send(J(LIST)); if (q.get('room')) join(ws, q.get('room'));
  ws.on('message', raw => { const m = JSON.parse(raw); if (m.type === 'ping') return ws.send(J({ type: 'pong', c: m.c })); got.push(m); if (mute) return;
    if (m.type === 'leave') { clearInterval(ws.tick); ws.room = null; ws.send(J(LIST)); } else if (ws.room) return;
    else if (m.type === 'quick') seat(ws, 'QQQQ', true); else if (m.type === 'create') seat(ws, 'CRTD', !!m.public); else if (m.type === 'join') join(ws, m.code); });
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
async function open(tag, query = '', w = 1280, h = 720) { const pg = await browser.newPage(); await pg.setViewport({ width: w, height: h });
  pg.on('pageerror', e => errs.push(`[${tag}] PAGEERROR ${e.message}`)); pg.on('response', r => { if (r.status() >= 400) errs.push(`[${tag}] ${r.status()} ${r.url()}`); });
  pg.on('console', m => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED|WebSocket connection|Failed to load resource/.test(m.text())) errs.push(`[${tag}] ${m.text()}`); });   // the AirPod bridge is absent on purpose; a real 404 is caught by the response hook
  await pg.goto(`http://localhost:${W}/?bridge=${DEAD}&game=${G}&cam=0${query}`); await sleep(1600); return pg; }
const type = async (pg, text) => { for (const c of text) await pg.keyboard.type(c, { delay: 25 }); await sleep(120); };

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
  const tiles = await pg.evaluate(() => [...document.querySelectorAll('#lobby-home .tile')].map(b => b.textContent.trim())); ok(tiles.join('|') === 'Quick play|Create room|Enter code', `${tag} three choices: ${tiles.join(' | ')}`);
  ok(s.rooms.join('|') === 'KXQ71 player|M3PDEmpty' && s.online === '3 online', `${tag} room list from the server: ${s.rooms.join(' | ')}, "${s.online}"`);
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
  ok(J(sent('join').at(-1)) === J({ type: 'join', code: 'AB2K' }), `${tag} join sent upper case: ${J(sent('join').at(-1))}`);
  ok(s.err === 'Room not found' && s.screen === 'lobby' && s.view === 'code' && s.typed === 'AB2K' && !s.busy && !/room=/.test(s.search), `${tag} joinfail notfound: inline "${s.err}", stays on the code view`); await shot('5-code-error');
  await pg.evaluate(() => { const dt = new DataTransfer(); dt.setData('text', 'https://poddle.fly.dev/?room=fvvv'); document.querySelector('#code-boxes input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); });
  await sleep(100); s = await st(pg); ok(s.typed === 'FVVV' && s.err === '', `${tag} pasting a link fills the code and clears the error (${s.typed})`);
  await pg.keyboard.press('Enter'); await sleep(450); ok((await st(pg)).err === 'Room is full', `${tag} joinfail full: inline "${(await st(pg)).err}"`);
  await pg.click('#screen-lobby [data-back]'); await sleep(350); s = await st(pg); ok(s.view === 'home' && s.screen === 'lobby', `${tag} Back button -> lobby home`);
  // Create room
  await pg.click('#btn-create'); await sleep(350); s = await st(pg); ok(s.view === 'create' && s.title === 'Create room', `${tag} Create room view`); await shot('3-create');
  await pg.click('#btn-create-go'); await sleep(500); s = await st(pg);
  ok(J(sent('create').at(-1)) === J({ type: 'create', public: true }), `${tag} create sent: ${J(sent('create').at(-1))}`);
  ok(s.view === 'share' && s.title === 'Your room' && s.share === 'CRTD' && /room=CRTD/.test(s.search) && s.screen === 'lobby', `${tag} 'room' -> share view shows ${s.share}, url ${s.search}`); await shot('4-share');
  await pg.keyboard.press('Escape'); await sleep(450); s = await st(pg); ok(s.view === 'home' && sent('leave').length === 1 && !/room=/.test(s.search), `${tag} Esc on the share view leaves the room (${sent('leave').length} leave, url "${s.search}")`);
  await pg.click('#btn-create'); await sleep(300); await pg.keyboard.press('ArrowRight'); await sleep(80); ok(await pg.evaluate(() => document.getElementById('seg-note').textContent) === 'Join by code only', `${tag} Right selects Private`);
  await pg.keyboard.press('Enter'); await sleep(500); ok(J(sent('create').at(-1)) === J({ type: 'create', public: false }), `${tag} private create sent: ${J(sent('create').at(-1))}`);
  await pg.click('#btn-share-go'); await sleep(800); s = await st(pg); ok(s.screen === 'connect' && s.backs === 1, `${tag} Start -> connect screen with a Back button (${s.screen}, backs=${s.backs})`); await shot('6-connect');
  await pg.keyboard.press('KeyC'); await sleep(600); s = await st(pg); ok(s.screen === 'calibrate' && s.backs === 1, `${tag} C -> calibrate (${s.screen})`);
  await pg.click('#cal [data-back]'); await sleep(600); s = await st(pg); ok(s.screen === 'lobby' && s.view === 'home' && sent('leave').length === 2 && !/room=/.test(s.search), `${tag} Back on calibrate -> lobby, leave sent, url cleared`);
  // Quick play, then a room from the list
  await pg.click('#btn-quick'); await sleep(800); s = await st(pg); ok(J(sent('quick').at(-1)) === J({ type: 'quick' }) && s.screen === 'connect' && /room=QQQQ/.test(s.search), `${tag} Quick play sent ${J(sent('quick').at(-1))} -> ${s.screen}, url ${s.search}`);
  await pg.keyboard.press('Escape'); await sleep(600); await pg.click('.room-row[data-code="KXQ7"]'); await sleep(800); s = await st(pg);
  ok(J(sent('join').at(-1)) === J({ type: 'join', code: 'KXQ7' }) && s.screen === 'connect', `${tag} room row joins KXQ7 -> ${s.screen}`);
  // reload: the URL carries the room, the title says so, Play rejoins
  await pg.reload(); await sleep(1600); s = await st(pg); ok(s.screen === 'title' && s.chip === 'Joining room KXQ7', `${tag} reload: title chip "${s.chip}"`); await shot('7-title-room');
  await pg.keyboard.press('Enter'); await sleep(900); s = await st(pg); ok(s.screen === 'connect' && J(sent('join').at(-1)) === J({ type: 'join', code: 'KXQ7' }), `${tag} Play rejoins KXQ7 -> ${s.screen}`);
  await pg.close();
}

// ?room=WXYZ: nothing joins until Play, then it joins at once and moves on
{ got.length = 0; urls.length = 0; const pg = await open('link', '&room=wxyz'); let s = await st(pg);
  ok(s.chip === 'Joining room WXYZ' && !got.length && !urls.some(u => /room=/.test(u)), `?room=WXYZ: chip "${s.chip}", nothing sent before Play`);
  await pg.click('#btn-start'); await sleep(900); s = await st(pg); ok(J(got[0]) === J({ type: 'join', code: 'WXYZ' }) && s.screen === 'connect', `?room=WXYZ: Play sent ${J(got[0])} -> ${s.screen}`);
  // seated, then the socket drops: the reconnect must ask for the seat back
  urls.length = 0; await stopFake(); await sleep(700); startFake(); await sleep(2500); s = await st(pg);
  ok(urls.length && urls.every(u => /cid=\w+&lobby=1&room=WXYZ$/.test(u)) && s.screen === 'connect', `reconnect while seated: ${urls[0]} (screen ${s.screen})`);
  urls.length = 0; gone = true; await stopFake(); await sleep(700); startFake(); await sleep(2500); s = await st(pg); gone = false;      // and once more, but the room expired meanwhile
  ok(/room=WXYZ/.test(urls[0] || '') && s.screen === 'lobby' && s.view === 'home' && s.toast === 'Room closed' && !/room=/.test(s.search) && s.pill === null, `reconnect to a room that is gone: ${s.screen}/${s.view}, toast "${s.toast}", url "${s.search}"`);
  await pg.close(); }
// a shared link to a room that is gone
{ const pg = await open('gone', '&room=ZZZZ'); await pg.click('#btn-start'); await sleep(900); const s = await st(pg);
  ok(s.screen === 'lobby' && s.view === 'code' && s.typed === 'ZZZZ' && s.err === 'Room not found' && !/room=/.test(s.search), `dead link: code view, "${s.err}", url "${s.search}"`); await pg.close(); }
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

const uniq = [...new Set(errs.map(e => e.split('\n')[0].slice(0, 200)))];                // a shader error is a page of text, once per page load
ok(!uniq.length, 'no console errors' + (uniq.length ? ':\n  ' + uniq.join('\n  ') : ''));
console.log(out.join('\n')); const bad = out.filter(l => l.startsWith('FAIL')).length;
console.log(`${out.length - bad} passed, ${bad} failed`); console.log(bad ? 'MENU FAIL' : 'MENU PASS');
await browser.close(); await stopFake(); web.close(); process.exit(bad ? 1 : 0);
