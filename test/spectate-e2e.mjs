// Spectators, rematch, seat hold, pause and names end to end: the real client against the real server/game.js (which serves
// web/ itself), fake AirPods, THREE headless Chromes (Ann and Ben play, Cat watches). Usage: node test/spectate-e2e.mjs
// SPEC_E2E_PORT=<base> moves the ports (default 8440: game + page, 8441: AirPods, 8442: nothing, where a "wifi drop" sends the game socket).
// Screenshots land in test/ui-shots/next-*.png (1280x720, and 600x900 for the UI screens).
import { spawn } from 'child_process'; import fs from 'fs';
import { WebSocketServer } from 'ws';
import puppeteer from 'puppeteer-core';
import { makeSynth, CALIBRATE, SESSION_LOOP } from './fake-bridge.mjs';
const P0 = +process.env.SPEC_E2E_PORT || 8440, G = P0, B = P0 + 1, DEAD = P0 + 2, root = new URL('..', import.meta.url).pathname, sleep = ms => new Promise(r => setTimeout(r, ms));
const LINK = 'court=', WORD = 'court', HINTS = (keys, level) => keys === (level ? `CCalibrate | 1234Difficulty: ${level}` : 'CCalibrate');      // what the page says, in one place
const WIN = 5, HOLD = 15;                           // first to 5, no win-by-2, so a match is SURE to end inside a test (Ben stops swinging, but Ann swings blind: at deuce they could trade points for ever). The seat hold keeps its real 15 s
const server = spawn('node', ['server/game.js'], { cwd: root, env: { ...process.env, PORT: G, WIN_AT: WIN, WIN_BY: 1, HOLD_S: HOLD }, stdio: ['ignore', 'pipe', 'inherit'] }), slog = []; server.stdout.on('data', d => slog.push(String(d)));

// ---- AirPods: one per tab, told apart by the path (as test/rooms-e2e.mjs). rest = lying still, go = calibrate then swing, swing = swing at once
const pods = {}, podOpts = { heading: 137, gyroNoise: 0.02, accNoise: 0.005, seed: 7 };
const rest = tag => { const p = pods[tag] ??= { t: 3580, socks: new Set() }; p.syn = makeSynth({ ...podOpts, script: [], t0: p.t + 0.02 }); return p; };
const go = tag => { const p = pods[tag]; p.syn = makeSynth({ ...podOpts, script: CALIBRATE, loop: SESSION_LOOP, t0: p.t + 0.02 }); };
const swing = tag => { const p = pods[tag]; p.syn = makeSynth({ ...podOpts, script: [{ T: 0.4 }], loop: SESSION_LOOP, t0: p.t + 0.02 }); };
const bridgeLinks = [];
new WebSocketServer({ port: B }).on('connection', (ws, req) => { const tag = req.url.slice(1), p = pods[tag] || rest(tag); p.socks.add(ws); bridgeLinks.push(tag); ws.on('close', () => p.socks.delete(ws)); ws.on('error', () => p.socks.delete(ws)); });
{ const start = performance.now(); let sent = 0;
  setInterval(() => { const due = Math.floor((performance.now() - start) / 20);
    for (; sent <= due; sent++) for (const p of Object.values(pods)) { const m = p.syn.next(); delete m._t; p.t = m.t; const j = JSON.stringify(m); for (const ws of p.socks) if (ws.readyState === 1) ws.send(j); } }, 5); }

const CHROME = process.env.CHROME || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => fs.existsSync(p));
const browsers = [], launch = async () => { const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] }); browsers.push(b); return b; };
fs.mkdirSync(root + 'test/ui-shots', { recursive: true });
const out = [], errs = [], ok = (c, what) => { out.push((c ? 'PASS ' : 'FAIL ') + what); console.log(c ? 'PASS' : 'FAIL', what); return c; };
const done = async code => { for (const b of browsers) await b.close().catch(() => {}); server.kill(); process.exit(code); };
setTimeout(() => { console.log('SPECTATE E2E FAIL (timeout)'); done(2); }, 900000);
for (const ev of ['uncaughtException', 'unhandledRejection']) process.on(ev, e => { console.log('SPECTATE E2E FAIL', e); done(2); });      // never leave the server or a Chrome behind
server.on('exit', c => { console.log(`SPECTATE E2E FAIL: server/game.js stopped (${c}). Is port ${G} taken?`); done(2); });

// everything a check reads, in one round trip
const st = pg => pg.evaluate(() => { const t = id => document.getElementById(id), vis = id => { const e = t(id); if (!e || e.hidden) return false; const c = getComputedStyle(e), b = e.getBoundingClientRect(); return c.display !== 'none' && c.visibility !== 'hidden' && +c.opacity > 0.05 && b.width > 0; },
    tx = id => t(id) ? t(id).textContent.trim() : null, s = window.__stats, d = document.body.dataset, sc = window.__scene, v = sc ? sc._dbg.view() : {}, bm = sc ? sc._dbg.ballMesh : null;
  return { screen: d.screen, overlay: d.overlay || null, role: d.role || null, dview: d.view || null, paused: d.paused === '1', settings: d.settings === 'open', phase: s.phase, srole: s.role, room: s.room,
    lview: [...document.querySelectorAll('#screen-lobby .lobby-view')].find(e => !e.hidden)?.dataset.view, share: tx('share-code').replace(/\s/g, ''), pill: t('room-pill').hidden ? null : tx('room-code'), chip: t('title-room').hidden ? null : tx('title-room'),
    err: tx('code-err'), toast: t('toast').classList.contains('on') ? tx('toast') : null, ask: vis('ask-watch') ? tx('ask-title') : null, gated: [...document.querySelectorAll('#lobby-home .tile')].every(e => e.getAttribute('aria-disabled') === 'true'),
    rows: [...document.querySelectorAll('#room-list li')].map(li => li.textContent.trim()), me: tx('name-me'), meSub: tx('sub-me'), them: tx('name-them'), themSub: tx('sub-them'), scMe: +tx('sc-me'), scThem: +tx('sc-them'),
    svMe: t('sv-me').classList.contains('on'), svThem: t('sv-them').classList.contains('on'), banner: tx('banner-text'), keys: vis('keys') ? [...document.querySelectorAll('#keys li')].filter(e => !e.hidden).map(e => e.textContent.trim()).join(' | ') : null, menuBtn: vis('btn-menu'), views: vis('views'), watchTag: vis('watch-tag'), pausedTag: vis('paused-tag'),
    watchers: vis('watchers') ? +tx('watch-n') : 0, pov: tx('view-pov'), pills: ['lights', 'st-airpod', 'st-game', 'st-camera'].filter(id => t(id)), glass: +getComputedStyle(t('glass')).opacity, setTitle: tx('set-title'), note: vis('set-note') ? tx('set-note') : null,
    hold: vis('hold') ? tx('hold-text') + '|' + tx('hold-left') : null, result: d.overlay === 'match' && vis('result') ? { title: tx('result-title'), note: tx('result-note'), me: tx('tally-name-me'), them: tx('tally-name-them'), sc: tx('tally-sc-me') + '-' + tx('tally-sc-them'), btns: vis('rematch-btns'), rnote: tx('rematch-note'), left: tx('rematch-left') } : null,
    cam: s.cam, camwrap: vis('camwrap'), podwrap: vis('podwrap'), search: location.search, calibrated: s.calibrated, hits: s.hits, myHits: s.myHits, swings: s.swings, ev: { ...s.events }, errors: s.errors,
    tags: sc ? sc._dbg.pads.map(p => p.tag.visible ? p.status : null) : [], ghost: sc ? sc._dbg.pads.map(p => +p.ghost.toFixed(2)) : [], moveSeg: [...document.querySelectorAll('#move-seg [aria-checked="true"]')].map(e => e.textContent).join(), botRow: vis('set-bot') ? [...document.querySelectorAll('#bot-seg [aria-checked="true"]')].map(e => e.textContent).join() : null,
    scene: { name: v.name, side: v.side, menu: v.menu, attract: v.attract, frozen: v.frozen, spectator: v.spectator, pr: v.pixelRatio, drawn: v.drawn }, ball: bm ? [bm.position.x, bm.position.y, bm.position.z, bm.visible ? 1 : 0] : null,
    clipped: [...document.querySelectorAll('.screen.is-active [data-fit], #hud [data-fit], #settings')].filter(e => { const b = e.getBoundingClientRect(), c = getComputedStyle(e); return b.width && !e.hidden && c.visibility !== 'hidden' && c.display !== 'none' && (b.left < -.5 || b.top < -.5 || b.right > innerWidth + .5 || b.bottom > innerHeight + .5); }).map(e => e.id || e.className) }; });
async function until(pg, test, ms, what) { const end = Date.now() + ms; let s; do { s = await st(pg); if (test(s)) return s; await sleep(120); } while (Date.now() < end); const { ev, scene, ...brief } = s; ok(false, `${what} (gave up after ${ms / 1000} s: ${JSON.stringify(brief)})`); return s; }
// A page. name: what poddle.name holds before the first script runs ('' = a first visit). The game socket is wrapped so the test can cut it the way bad wifi does:
// __cut(true) closes it without a 'leave' and sends every reconnect to a dead port until __cut(false).
async function open(tag, name, query = '', w = 1280, h = 720) { const pg = (await (await launch()).pages())[0]; await pg.setViewport({ width: w, height: h }); pg.tag = tag;
  pg.on('pageerror', e => errs.push(`[${tag}] PAGEERROR ${e.message}`)); pg.on('response', r => { if (r.status() >= 400) errs.push(`[${tag}] ${r.status()} ${r.url()}`); });
  pg.on('console', m => { if (m.type() === 'error' && !(pg.cutting && /WebSocket|ERR_CONNECTION/.test(m.text()))) errs.push(`[${tag}] ${m.text()}`); });
  await pg.evaluateOnNewDocument((name, dead) => { try { if (name && !localStorage.getItem('poddle.name')) localStorage.setItem('poddle.name', name); } catch { /* */ }
    const WS = window.WebSocket, socks = []; let cut = false;
    window.WebSocket = class extends WS { constructor(u, p) { const game = /[?&]cid=/.test(u); super(game && cut ? `ws://localhost:${dead}` : u, p); if (game) socks.push(this); } };
    window.__cut = on => { cut = on; if (on) for (const s of socks.splice(0)) s.close(); }; }, name, DEAD);
  await pg.goto(`http://localhost:${G}/?bridge=${B}/${tag}&game=${G}&uitest=1${query}`); await sleep(1500); return pg; }
const shot = async (pg, n, sizes = [[1280, 720]]) => { const was = pg.viewport();
  for (const [w, h] of sizes) { if (pg.viewport().width !== w || pg.viewport().height !== h) { await pg.setViewport({ width: w, height: h }); await sleep(500); } await pg.mouse.move(w / 2, h / 2 + 3); await sleep(450);      // the move wakes the hints and chips
    await pg.screenshot({ path: `${root}test/ui-shots/next-${n}-${w}x${h}.png` }); const c = (await st(pg)).clipped; ok(!c.length, `${pg.tag} ${n} ${w}x${h}: nothing off screen ${c}`); }
  if (pg.viewport().width !== was.width || pg.viewport().height !== was.height) { await pg.setViewport(was); await sleep(400); } };
const BOTH = [[1280, 720], [600, 900]], wake = async pg => { let s; for (let i = 0; i < 30; i++) { await pg.mouse.move(300 + i * 3, 400); await sleep(300); s = await st(pg); if (s.keys || s.role) break; } return s; };      // (they also step aside for a toast)      // the hints fade after 6 s: a move of the mouse brings them back
const type = async (pg, text) => { for (const c of text) await pg.keyboard.type(c, { delay: 25 }); await sleep(150); };
const toLobby = async pg => { await pg.click('#btn-start'); await sleep(300); await pg.evaluate(() => document.fullscreenElement && document.exitFullscreen());      // Play goes full screen, which headless Chrome photographs at the wrong size
  return until(pg, s => s.screen === 'lobby', 3000, `${pg.tag} Play -> lobby`); };
async function toCourt(pg) { const s = await until(pg, s => s.screen === 'calibrate' || s.calibrated && s.screen === 'hud', 6000, `${pg.tag} reaches calibration`);       // a calibration is kept from room to room
  if (s.screen === 'calibrate') go(pg.tag); else swing(pg.tag); return until(pg, s => s.calibrated && s.screen === 'hud', 30000, `${pg.tag} is on the court`); }
const ballPath = (pg, ms) => pg.evaluate(ms => new Promise(res => { const bm = window.__scene._dbg.ballMesh, pts = [], t0 = performance.now(); (function f() { pts.push([bm.position.x, bm.position.y, bm.position.z]); if (performance.now() - t0 < ms) requestAnimationFrame(f); else res(pts); })(); }), ms);
const steps = pts => pts.slice(1).map((p, i) => Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1], p[2] - pts[i][2]));

// =====================================================================================================================
// 1. Title: the menu's own rally behind the glass. No score, no result, nothing of a game; the cheap render mode is on
// =====================================================================================================================
const a = await open('a', ''); let s, t, u;
s = await st(a); const path0 = await ballPath(a, 1200), moved = Math.max(...steps(path0));
ok(s.screen === 'title' && s.phase === 'title' && !s.overlay && !s.result && !s.hold && s.banner === '' && !s.toast, `title: screen ${s.screen}, overlay ${s.overlay}, result ${JSON.stringify(s.result)}, banner "${s.banner}"`);
ok(s.scene.attract && s.scene.menu && s.ball[3] === 1 && moved > 0.01, `title: the rally plays behind the glass (attract ${s.scene.attract}, menu ${s.scene.menu}, ball moves ${moved.toFixed(2)} m a frame)`);
ok(!Object.keys(s.ev).some(k => !['lobby', 'pong'].includes(k)), `title: only lobby messages arrived (${Object.keys(s.ev)})`);
t = await st(a); await sleep(2000); u = await st(a); const fps = (u.scene.drawn - t.scene.drawn) / 2;
ok(u.scene.pr <= 0.5 && fps > 20 && fps < 36 && s.glass > 0.9, `title: cheap menu mode (pixel ratio ${u.scene.pr}, ${fps.toFixed(0)} frames a second, glass ${s.glass})`);
ok(!s.pills.length, `the status pills are gone (${s.pills})`);
await shot(a, '01-title', BOTH);

// ---- the name is asked for once: nothing can be chosen without it
await toLobby(a); s = await st(a); ok(s.gated && s.lview === 'home', `first visit: the tiles wait for a name (gated ${s.gated})`); await shot(a, '02-lobby-first', BOTH);
await a.click('#btn-quick'); await sleep(600); s = await st(a); ok(s.screen === 'lobby' && !s.pill && !s.room, `Quick play with no name: nothing happens (room ${s.room})`);
await a.click('#name-input'); await type(a, 'Ann'); s = await st(a); ok(!s.gated, 'a name opens the tiles'); await shot(a, '03-lobby-named', BOTH);

// =====================================================================================================================
// 2. Play a bot: Matt at the level picked, the two hints, the hamburger pauses, the ball waits, resumes clean
// =====================================================================================================================
await a.click('#btn-bot'); s = await until(a, s => s.lview === 'bot', 2000, 'a opens Play a bot'); await shot(a, '04-lobby-bot', BOTH);
await a.click('#btn-bot-2'); s = await toCourt(a);
s = await until(a, s => s.them === 'Matt' && s.themSub === 'Pro', 6000, 'Matt sits down at the level picked'); ok(s.them === 'Matt' && s.themSub === 'Pro' && s.me === 'You', `Play a bot: "${s.them}" / "${s.themSub}"`);
ok(!s.scene.menu && !s.scene.attract && s.scene.pr >= 1 && s.scene.name === 'play', `court open: full quality (menu ${s.scene.menu}, attract ${s.scene.attract}, pixel ratio ${s.scene.pr})`);
ok(s.menuBtn && s.pill && !s.pills.length && !s.views && !s.watchTag, `HUD: hamburger, court code ${s.pill}, no pills, no spectator bits`);
s = await wake(a); ok(HINTS(s.keys, 'Pro'), `key hints against Matt: "${s.keys}"`); await shot(a, '05-hud-matt', BOTH);
await until(a, s => s.hits >= 2, 40000, 'a rally against Matt');
// pause with the ball in the air
for (let i = 0; i < 3; i++) { await until(a, s => s.ball[3] === 1 && s.ball[1] > 0.5 && Math.abs(s.ball[2]) < 5, 20000, 'a ball in flight'); await a.click('#btn-menu'); s = await until(a, s => s.paused, 2000, 'the hamburger pauses against Matt'); if (s.ball[3] && s.ball[1] > 0.3) break; await a.keyboard.press('Escape'); await sleep(800); }
const evBefore = s.ev, p1 = await ballPath(a, 1000), sw0 = (await st(a)).ev.swung || 0; s = await st(a);
ok(s.paused && s.settings && s.setTitle === 'Paused' && s.glass > 0.9 && s.scene.frozen, `paused: title "${s.setTitle}", glass ${s.glass}, scene frozen ${s.scene.frozen}`);
ok(Math.max(...steps(p1)) < 1e-6, `paused: the ball does not move for 1 s (${Math.max(...steps(p1)).toExponential(1)} m)`); await shot(a, '06-settings-paused', BOTH);
const resumed = a.evaluate(() => new Promise(res => { const bm = window.__scene._dbg.ballMesh, pts = [], t0 = performance.now(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); (function f() { pts.push([bm.position.x, bm.position.y, bm.position.z, performance.now() - t0]); if (performance.now() - t0 < 500) requestAnimationFrame(f); else res(pts); })(); }));
const p2 = await resumed, big = Math.max(...steps(p2)); if (big >= 2) console.log('   resume path:', p2.map(p => `${p[3].toFixed(0)}ms ${p[0].toFixed(2)},${p[1].toFixed(2)},${p[2].toFixed(2)}`).join(' | '));      // a leap is the ball coasting ahead in ONE frame: 3 m and more. A smash at 31 m/s in a slow 50 ms frame is 1.5 m
s = await until(a, s => !s.paused && !s.settings, 2000, 'Esc resumes');
const quiet = ['serve', 'point', 'hit'].every(k => (s.ev[k] || 0) === (evBefore[k] || 0));      // a hit or a new serve in that half second moves the ball for real
ok(!s.paused && !s.scene.frozen && (big < 2 || !quiet), `resume: paused ${s.paused}, frozen ${s.scene.frozen}, no leap (largest step ${big.toFixed(2)} m over ${p2.length} frames${quiet ? '' : ', a hit or serve fell in the window'})`);
ok(((await st(a)).ev.swung || 0) >= sw0, 'play goes on after the pause'); await until(a, s => s.hits > 2 || s.ev.point > (evBefore.point || 0), 25000, 'the rally goes on after resume');
// settings, live look (closed again at once so the pause is short)
await a.keyboard.press('KeyQ'); await sleep(200); await a.keyboard.press('KeyQ'); s = await until(a, s => s.screen === 'lobby' && s.lview === 'home', 3000, 'a leaves Matt (Q Q)'); rest('a');
await sleep(1200); s = await st(a); ok(!s.pill && !s.room && s.scene.attract && s.scene.menu && !s.overlay && !s.hold && s.scMe === 0 && s.scThem === 0 && !s.paused, `back in the lobby: the menu rally is back, nothing of the game is left (attract ${s.scene.attract}, score ${s.scMe}-${s.scThem}, overlay ${s.overlay})`);

// =====================================================================================================================
// 3. Create + Enter code: Ann and Ben. A third page finds the court full and watches instead
// =====================================================================================================================
const b = await open('b', 'Ben', '', 600, 900);
await a.click('#btn-courts'); await sleep(300); await a.click('#btn-create'); await sleep(300); await a.click('#seg [data-public="0"]'); await a.click('#btn-create-go'); s = await until(a, s => s.lview === 'share' && s.share.length === 4, 3000, 'a create -> share view');
const CODE = s.share; ok(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/.test(CODE) && s.search.includes(LINK + CODE), `Ann made private court ${CODE}, address bar ${s.search}`);
await toLobby(b); await b.click('#btn-courts'); await sleep(300); await b.click('#code-boxes input'); await type(b, CODE.toLowerCase()); await b.keyboard.press('Enter');
await a.click('#btn-share-go'); [s, t] = await Promise.all([toCourt(a), toCourt(b)]);
[s, t] = await Promise.all([until(a, s => s.them === 'Ben', 5000, 'a sees Ben'), until(b, s => s.them === 'Ann', 5000, 'b sees Ann')]);
ok(s.them === 'Ben' && t.them === 'Ann' && s.me === 'You' && t.me === 'You', `names on the scoreboards: Ann sees "${s.them}", Ben sees "${t.them}"`);
s = await wake(a); ok(HINTS(s.keys, null), `against a person the hints are: "${s.keys}"`);

const c = await open('c', 'Cat', `&room=${CODE.toLowerCase()}`);                // a link from before 'court': still works, and the address bar is rewritten
s = await st(c); ok(s.chip === `Joining ${WORD} ${CODE}` && s.search.includes(LINK + CODE) && !/room=/.test(s.search), `c title chip: "${s.chip}", address bar ${s.search}`);
await c.click('#btn-start'); await sleep(300); await c.evaluate(() => document.fullscreenElement && document.exitFullscreen());
s = await until(c, s => s.ask, 4000, 'c is asked to watch'); ok(s.ask === 'Court is full. Watch instead?' && s.screen === 'lobby' && !s.room, `third page: "${s.ask}"`); await shot(c, '07-ask-watch', BOTH);
await c.click('#btn-watch-yes'); s = await until(c, s => s.phase === 'watch' && s.screen === 'hud' && s.scene.name === 'broadcast', 5000, 'c lands in the broadcast view');
ok(s.srole === 'spectator' && s.role === 'spectator' && s.dview === 'broadcast' && s.scene.spectator && !s.scene.menu && s.search.includes('watch=1'), `spectator: view ${s.scene.name}, address bar ${s.search}`);
ok(s.cam === null && !s.camwrap && !s.podwrap && !s.keys && s.views && !s.watchTag && s.menuBtn, `spectator HUD: chips, no WATCHING tag (docs/NEXT.md 14g: removed), no AirPod, no camera, no key hints (cam ${JSON.stringify(s.cam)})`);
s = await until(c, s => s.me === 'Ann' && s.them === 'Ben', 4000, 'c sees both names'); ok(s.me === 'Ann' && s.them === 'Ben', `spectator scoreboard: "${s.me}" left, "${s.them}" right, never You`);
[s, t] = await Promise.all([until(a, s => s.watchers === 1, 4000, 'a sees the watcher count'), until(c, s => s.watchers === 1, 4000, 'c sees the watcher count')]); ok(s.watchers === 1 && t.watchers === 1, `watchers: Ann sees ${s.watchers}, Cat sees ${t.watchers}`);
await sleep(1500); await shot(c, '08-view-broadcast', BOTH);
await c.keyboard.press('Digit2'); s = await until(c, s => s.scene.name === 'split' && s.dview === 'split', 2000, 'key 2 = split'); await sleep(900); await shot(c, '09-view-split', BOTH);
await c.keyboard.press('Digit3'); s = await until(c, s => s.scene.name === 'pov', 2000, 'key 3 = player view'); ok(s.pov === 'Player: Ann' && s.scene.side === 0, `player view: "${s.pov}"`); await sleep(900); await shot(c, '10-view-pov-ann');
await c.keyboard.press('Digit3'); s = await until(c, s => s.scene.name === 'pov' && s.scene.side === 1, 2000, '3 again = the other player'); ok(s.pov === 'Player: Ben', `player view flipped: "${s.pov}"`); await sleep(900); await shot(c, '10-view-pov-ben', BOTH);
await c.click('#views [data-view="free"]'); s = await until(c, s => s.scene.name === 'free' && s.dview === 'free', 2000, 'the Free chip'); const f0 = await c.evaluate(() => ({ ...window.__scene._dbg.free }));
await c.mouse.move(640, 300); await c.mouse.down(); await c.mouse.move(760, 340, { steps: 6 }); await c.mouse.up(); const f1 = await c.evaluate(() => ({ ...window.__scene._dbg.free }));
ok(Math.abs(f1.yaw - f0.yaw) > 0.2, `free cam: a drag on the court orbits (yaw ${f0.yaw.toFixed(2)} -> ${f1.yaw.toFixed(2)})`); await sleep(600); await shot(c, '11-view-free', BOTH);
await c.click('#views [data-view="broadcast"]'); await until(c, s => s.scene.name === 'broadcast', 2000, 'back to broadcast');

// ---- a rally both scoreboards and the spectator agree on; names in the banner and on the serve dot
let agree = 0, last = null;
for (let i = 0; i < 900 && !(agree >= 3 && last.s.hits >= 2 && last.s.ev.point >= 1); i++) { await sleep(100); [s, t, u] = await Promise.all([st(a), st(b), st(c)]); last = { s, t, u }; if (s.scMe === t.scThem && s.scThem === t.scMe && u.scMe === s.scMe && u.scThem === s.scThem) agree++; else agree = 0; }
ok(agree >= 3 && last.s.hits >= 2 && last.s.ev.point >= 1, `a rally, and three screens agree: Ann ${last.s.scMe}-${last.s.scThem}, Ben ${last.t.scMe}-${last.t.scThem}, Cat ${last.u.scMe}-${last.u.scThem} (${last.s.hits} hits)`);
ok(/^(Ann|Ben) scores$/.test(last.u.banner) && /^(Your point|Ben scores)$/.test(last.s.banner) && /^(Your point|Ann scores)$/.test(last.t.banner), `point banner: Cat "${last.u.banner}", Ann "${last.s.banner}", Ben "${last.t.banner}"`);
[s, u] = await Promise.all([st(a), st(c)]); s = await until(a, s => s.svMe !== s.svThem, 8000, 'a serve dot'); u = await st(c); t = await st(b);
ok(u.svMe === s.svMe && t.svThem === s.svMe, `serve dot: beside ${s.svMe ? 'Ann' : 'Ben'} on all three (Ann me:${s.svMe}, Ben them:${t.svThem}, Cat left:${u.svMe})`);

// ---- the hamburger against a person: no pause, a note, the rally goes on
await a.click('#btn-menu'); await sleep(1200); s = await st(a); t = await st(b);
ok(s.settings && !s.paused && !t.paused && s.note === 'Online games can’t pause' && !s.scene.frozen && !(s.ev.paused > (last.s.ev.paused || 0)) && s.glass < 0.1, `against Ben the panel does not pause: note "${s.note}", paused ${s.paused}, glass ${s.glass}`);
await shot(a, '12-settings-live', BOTH); await a.keyboard.press('Escape'); await until(a, s => !s.settings, 2000, 'Esc closes the panel');
await c.click('#btn-menu'); s = await until(c, s => s.settings, 2000, 'spectator settings'); await shot(c, '13-settings-spectator'); await c.keyboard.press('Escape');

// ---- Ben calibrates again mid-match: his character goes pale with a tag, his sub line says so, the next serve waits
await b.keyboard.press('KeyC'); [s, u] = await Promise.all([until(a, s => s.tags[1] === 'calibrating' && s.ghost[1] > 0.95, 4000, 'a sees Ben calibrating'), until(c, s => s.tags[1] === 'calibrating' && s.ghost[1] > 0.95, 4000, 'c sees Ben calibrating')]);
ok(s.themSub === 'Calibrating' && u.themSub === 'Calibrating' && s.tags[0] == null, `calibrating: Ann reads "${s.them} / ${s.themSub}", Cat reads "${u.themSub}", tags ${JSON.stringify(u.tags)}`);
await shot(a, '19-tag-calibrating-opponent'); await shot(c, '19-tag-calibrating-broadcast'); await c.keyboard.press('Digit2'); await sleep(700); await shot(c, '19-tag-calibrating-split'); await c.keyboard.press('Digit1');
go('b'); await until(b, s => s.calibrated && s.screen === 'hud', 30000, 'b calibrates again'); s = await until(a, s => s.tags[1] == null && s.ghost[1] === 0 && s.themSub === 'Far side', 4000, 'the tag goes when Ben is back'); ok(s.ghost[1] === 0, 'calibrated: the character is itself again');

// =====================================================================================================================
// 4. Wifi drop: the socket closes with no 'leave'. Hold banner, back within 15 s, the point is replayed
// =====================================================================================================================
await until(a, s => s.ev.hit > 0, 20000, 'a ball has been struck'); const before = await st(a);
b.cutting = true; await b.evaluate(() => window.__cut(true));
[s, u] = await Promise.all([until(a, s => s.hold, 4000, 'a sees the hold card'), until(c, s => s.hold, 4000, 'c sees the hold card')]);
[s, u] = await Promise.all([until(a, s => s.tags[1] === 'away' && s.ghost[1] > 0.95, 3000, 'a sees the away tag'), until(c, s => s.tags[1] === 'away' && s.ghost[1] > 0.95, 3000, 'c sees the away tag')]); ok(s.themSub === 'Reconnecting' && u.themSub === 'Reconnecting', `away: sub line "${s.themSub}" / "${u.themSub}", tags ${JSON.stringify(u.tags)}`);
ok(/^Waiting for Ben\|1[0-5]$/.test(s.hold) && /^Waiting for Ben\|1[0-5]$/.test(u.hold) && s.scene.frozen && !s.pausedTag, `hold: Ann reads "${s.hold}", Cat reads "${u.hold}", ball frozen ${s.scene.frozen}`);
const ph = await ballPath(a, 800); ok(Math.max(...steps(ph)) < 1e-6, 'hold: the ball waits where it is'); await shot(a, '14-hold', BOTH); await shot(c, '14-hold-spectator');
await sleep(1500); s = await st(a); ok(s.scMe === before.scMe && s.scThem === before.scThem, `hold: the score stands still (${s.scMe}-${s.scThem})`);
await b.evaluate(() => window.__cut(false)); [s, t] = await Promise.all([until(a, s => !s.hold && !s.scene.frozen, 8000, 'the hold ends when Ben is back'), until(b, s => s.ev.welcome >= 2 && !s.overlay && s.screen === 'hud', 8000, 'b has its seat back')]); b.cutting = false;
ok(t.pill === CODE && t.them === 'Ann' && t.phase === 'play', `Ben is back in ${t.pill} against "${t.them}", on the court`);
s = await until(a, s => s.ev.serve > before.ev.serve, 8000, 'the point is replayed'); ok(s.scMe === before.scMe && s.scThem === before.scThem || s.ev.point > before.ev.point, `replayed: a new serve, score kept at ${before.scMe}-${before.scThem}`);
u = await st(c); ok(u.phase === 'watch' && u.room === CODE && !u.hold, 'Cat is still watching');

// =====================================================================================================================
// 5. Match end: Rematch yes / yes -> a new match, Cat still there. Then yes / no -> everyone in the lobby
// =====================================================================================================================
rest('b');                                         // Ben stops swinging: Ann wins the points
[s, t, u] = await Promise.all([until(a, s => s.result, 200000, 'the match ends for Ann'), until(b, s => s.result, 200000, 'for Ben'), until(c, s => s.result, 200000, 'for Cat')]);
const annWon = s.result.title === 'You win!', W = annWon ? 'Ann' : 'Ben';
ok((annWon ? t.result.title === 'Ann wins' : t.result.title === 'You win!' && s.result.title === 'Ben wins') && u.result.title === `${W} wins`, `result: Ann "${s.result.title}", Ben "${t.result.title}", Cat "${u.result.title}"`);
ok(s.result.btns && t.result.btns && !u.result.btns && u.result.rnote === 'Waiting for a rematch' && u.result.me === 'Ann' && u.result.them === 'Ben' && s.result.them === 'Ben' && /^\d+$/.test(s.result.left), `result: players vote, Cat reads "${u.result.rnote}", ${s.result.left} s left`);
await shot(a, '15-result', BOTH); await shot(c, '15-result-spectator', BOTH);
await a.click('#btn-rematch'); [s, t] = await Promise.all([until(a, s => s.result && s.result.rnote, 3000, 'a voted'), until(b, s => s.result && s.result.rnote, 3000, 'b hears of it')]);
ok(s.result.rnote === 'Waiting for Ben' && t.result.rnote === 'Ann wants a rematch', `votes: Ann reads "${s.result.rnote}", Ben reads "${t.result.rnote}"`); await shot(b, '16-result-asked', BOTH); await shot(a, '16-result-voted');
await b.click('#btn-rematch'); [s, t, u] = await Promise.all([a, b, c].map(pg => until(pg, s => !s.overlay && s.scMe === 0 && s.scThem === 0, 5000, `${pg.tag}: rematch on`)));
ok(u.phase === 'watch' && u.room === CODE && u.watchers === 1 && s.watchers === 1 && s.room === CODE && t.room === CODE, `yes / yes: a new match in ${CODE}, 0-0, Cat still watching (${s.watchers} watching)`);
[s, t, u] = await Promise.all([until(a, s => s.result, 200000, 'match 2 ends for Ann'), until(b, s => s.result, 200000, 'for Ben'), until(c, s => s.result, 200000, 'for Cat')]);
await a.click('#btn-rematch'); await sleep(400); await b.click('#btn-leave');
[s, t, u] = await Promise.all([a, b, c].map(pg => until(pg, s => s.screen === 'lobby' && s.lview === 'home' && !s.room, 6000, `${pg.tag}: back in the lobby`)));
ok(s.toast === 'No rematch' && u.toast === 'No rematch' && t.toast === null && !s.overlay && !t.overlay && !u.overlay && !s.pill && !u.role, `yes / no: everyone in the lobby. Ann "${s.toast}", Cat "${u.toast}", Ben (who left) "${t.toast}"`);
await sleep(1000); u = await st(c); ok(u.scene.attract && u.scene.menu && !u.scene.spectator && !u.views && !/watch=|room=|court=/.test(u.search), `Cat's lobby: menu rally back, no spectator bits, clean address bar "${u.search}"`);

// =====================================================================================================================
// 6. Quick play, watched from the lobby list. Ben's wifi goes for good: hold, then forfeit, then everyone to the lobby
// =====================================================================================================================
swing('b'); await a.click('#btn-quick'); s = await until(a, s => s.pill, 4000, 'a quick play'); const PUB = s.pill; await b.click('#btn-quick'); t = await until(b, s => s.pill, 4000, 'b quick play'); ok(t.pill === PUB, `quick play: Ann and Ben share ${PUB}`);
await c.click('#btn-courts'); await sleep(300); await c.click('#court-seg [data-filter="full"]');      // two humans: under Full, the row itself is Watch (docs/COURTS-TOURNEY.md 2.7)
u = await until(c, s => s.rows.some(r => new RegExp(`^${PUB}.* vs .*(\\d+-\\d+|Starting).*Watch$`).test(r)), 5000, 'c lists the full court to watch'); ok(u.rows.some(r => new RegExp(`^${PUB}.* vs .*(\\d+-\\d+|Starting).*Watch$`).test(r)), `lobby list: ${JSON.stringify(u.rows)}`); await shot(c, '17-lobby-watch', BOTH);
await c.click(`#room-list .room-row[data-code="${PUB}"]`); u = await until(c, s => s.phase === 'watch' && s.room === PUB, 5000, 'c watches from the list'); ok(u.scene.name === 'broadcast' && u.dview === 'broadcast', `the view chosen last is remembered (${u.scene.name})`);
[s, t] = await Promise.all([toCourt(a), toCourt(b)]); const h0 = (await st(a)).ev.hit || 0; await until(a, s => s.ev.hit > h0, 40000, 'a ball is struck in the new match');
const tDrop = Date.now(); b.cutting = true; await b.evaluate(() => window.__cut(true));
s = await until(a, s => s.hold, 4000, 'hold again'); ok(/^Waiting for Ben/.test(s.hold), `hold: "${s.hold}"`);
[s, u] = await Promise.all([until(a, s => s.result, (HOLD + 6) * 1000, 'the forfeit'), until(c, s => s.result, (HOLD + 6) * 1000, 'the forfeit, for Cat')]); const took = (Date.now() - tDrop) / 1000;
ok(s.result.title === 'You win!' && s.result.note === 'Ben left' && u.result.title === 'Ann wins' && u.result.note === 'Ben left' && took > HOLD - 1.5 && !s.hold, `not back in ${HOLD} s: forfeit after ${took.toFixed(1)} s. Ann "${s.result.title}" / "${s.result.note}", Cat "${u.result.title}" / "${u.result.note}"`);
await sleep(300); /* focus lands 60 ms after the card opens */ u = await a.evaluate(() => ({ re: document.getElementById('btn-rematch').disabled, focus: document.activeElement.id })); ok(s.result.rnote === '' && u.re && u.focus === 'btn-leave', `after a forfeit: said once (second note "${s.result.rnote}"), Rematch off (${u.re}), focus on ${u.focus}`); await shot(a, '18-result-forfeit', BOTH);
await a.click('#btn-leave'); [s, u] = await Promise.all([a, c].map(pg => until(pg, s => s.screen === 'lobby' && !s.room, 6000, `${pg.tag}: lobby after the forfeit`))); ok(u.toast === 'No rematch' && !s.overlay && !u.overlay, `after the forfeit: lobby for both (Cat "${u.toast}")`);

// =====================================================================================================================
// 7. Against Matt with Cat watching: the Paused tag, the Difficulty and Move rows, no M key
// =====================================================================================================================
await a.click('#btn-bot'); await sleep(300); await a.click('#btn-bot-1'); s = await toCourt(a); s = await until(a, s => s.them === 'Matt' && s.themSub === 'Club', 6000, 'Matt, Club'); const BOT = s.pill;
await c.goto(`http://localhost:${G}/?bridge=${B}/c&game=${G}&uitest=1&${LINK}${BOT}&watch=1`); await sleep(1500); await c.click('#btn-start'); await sleep(300); await c.evaluate(() => document.fullscreenElement && document.exitFullscreen());
u = await until(c, s => s.phase === 'watch' && s.room === BOT && s.them === 'Matt', 6000, 'c watches the private court by link'); ok(u.me === 'Ann' && u.themSub === 'Club', `Cat watches Ann against "${u.them} / ${u.themSub}"`);
await a.keyboard.press('KeyM'); await sleep(300); s = await st(a); ok(s.moveSeg === 'Body' && !/^(Body|Auto|Aim):/.test(s.toast || ''), `M does nothing on the court any more (move ${s.moveSeg}, toast ${s.toast})`);
await a.click('#btn-menu'); [s, u] = await Promise.all([until(a, s => s.paused && s.botRow === 'Club', 3000, 'a paused, Difficulty row'), until(c, s => s.tags[0] === 'paused' && s.ghost[0] > 0.95 && s.pausedTag, 4000, 'c sees Ann paused')]);
ok(u.meSub === 'Paused' && u.tags[1] == null && u.scene.frozen, `paused: Cat reads "${u.me} / ${u.meSub}", tag over Ann only ${JSON.stringify(u.tags)}, HUD tag ${u.pausedTag}`); await shot(c, '20-tag-paused-broadcast', BOTH); await shot(a, '21-settings-matt', BOTH);
await a.click('#bot-seg [data-level="0"]'); s = await until(a, s => s.botRow === 'Rookie' && s.themSub === 'Rookie', 3000, 'Difficulty row -> Rookie'); await a.click('#move-seg [data-move="auto"]'); s = await until(a, s => s.moveSeg === 'Auto', 2000, 'Move row -> Auto');
await a.keyboard.press('Escape'); s = await until(a, s => !s.paused && !s.settings, 3000, 'resume'); s = await wake(a); ok(HINTS(s.keys, 'Rookie') && s.moveSeg === 'Auto', `the hint follows the level: "${s.keys}"`);
await a.keyboard.press('Digit3'); s = await until(a, s => s.themSub === 'Tour', 3000, 'key 3 = Tour'); await a.keyboard.press('Digit4'); s = await until(a, s => s.themSub === 'Pro', 3000, 'key 4 = Pro'); s = await wake(a); ok(HINTS(s.keys, 'Pro'), `1 2 3 4 still change the level (3 = Tour, 4 = Pro): "${s.keys}"`); await shot(a, '22-hud-difficulty', BOTH);


// =====================================================================================================================
// 8. Ask to play (docs/COURTS-TOURNEY.md 2.11): Cat, watching Ann play Matt, asks for Matt's seat. N first, then Y. The card never takes focus
// =====================================================================================================================
const askUI = pg => pg.evaluate(() => { const bt = document.getElementById('btn-ask'), cd = document.getElementById('ask-card'), ae = document.activeElement;
  return { btn: bt && !bt.hidden && getComputedStyle(bt).display !== 'none' ? document.getElementById('ask-label').textContent : null, card: !!cd && !cd.hidden && cd.classList.contains('is-on'), focus: ae ? ae.id || ae.tagName : null }; });
const askUntil = async (pg, test, ms, what) => { const end = Date.now() + ms; let v; do { v = await askUI(pg); if (test(v)) return v; await sleep(120); } while (Date.now() < end); ok(false, `${what} (gave up: ${JSON.stringify(v)})`); return v; };
await until(a, s => s.hits >= 1, 30000, 'Ann has struck a ball against Matt: the match is under way');
let q = await askUntil(c, v => v.btn === 'Ask to play', 8000, 'c sees Ask to play'); ok(q.btn === 'Ask to play', `Cat, watching Ann against Matt: "${q.btn}"`); await shot(c, '22-ask-button', BOTH);
await a.evaluate(() => document.activeElement && document.activeElement.blur()); const focus0 = (await askUI(a)).focus; await c.keyboard.press('KeyA');      // nothing focused on Ann's page: Space and Enter below reach the game, not a button
q = await askUntil(c, v => /^Waiting · \d+s$/.test(v.btn || ''), 3000, 'c: Waiting'); ok(/^Waiting · \d+s$/.test(q.btn), `A asks: "${q.btn}"`);
let r = await askUntil(a, v => v.card, 3000, 'a gets the card'); ok(r.card && r.focus === focus0, `Ann’s card shows and takes no focus (${focus0} -> ${r.focus})`); await shot(a, '23-ask-card', BOTH);
const hits0 = (await st(a)).hits; await a.keyboard.press('Space'); await a.keyboard.press('Enter'); await sleep(300); r = await askUI(a); u = await st(c); t = await st(a); ok(r.card && u.srole === 'spectator' && !t.paused && !t.settings, `Space and Enter answer nothing: the card is still up, Cat is still watching (${u.srole}), Ann is still playing (paused ${t.paused})`);
t = await until(a, s => s.hits > hits0, 6000, 'the ball is struck while the card shows'); r = await askUI(a); ok(t.hits > hits0 && r.card, `the card blocks no play: the ball is struck while it shows (hits ${hits0} -> ${t.hits}, card up ${r.card})`);      // the game has no Space serve (a swing serves): what the card must never stop is the paddle
await a.keyboard.press('KeyN'); q = await askUntil(c, v => /^Again in \d+s$/.test(v.btn || ''), 3000, 'c: Again in'); r = await askUntil(a, v => !v.card, 2000, 'the card goes on N'); u = await st(c);
ok(/^Again in \d+s$/.test(q.btn) && !r.card && u.toast === 'Ann said no', `N declines: Cat reads "${q.btn}" and the toast "${u.toast}", Ann's card is gone`); await shot(c, '24-ask-no');
q = await askUntil(c, v => v.btn === 'Ask again', 15000, 'c: Ask again after the cooldown'); ok(q.btn === 'Ask again', `after the cooldown: "${q.btn}"`);
await c.keyboard.press('KeyQ'); await sleep(200); await c.keyboard.press('KeyQ'); await until(c, s => s.screen === 'lobby' && !s.room, 4000, 'c leaves the stands (Q Q)');      // the Y round comes in the way a stranger would: Courts, search, the row, Enter
await a.keyboard.press('KeyQ'); await sleep(200); await a.keyboard.press('KeyQ'); await until(a, s => s.screen === 'lobby' && !s.room, 4000, 'a leaves Matt (Q Q)');      // a public court this time, so it is listed
await a.click('#btn-courts'); await sleep(300); await a.click('#btn-create'); await sleep(300); await a.click('#seg [data-public="1"]'); await a.click('#btn-create-go'); s = await until(a, s => s.lview === 'share' && s.share.length === 4, 3000, 'a creates a public court'); const OPEN = s.share;
await a.click('#btn-share-go'); s = await toCourt(a); s = await until(a, s => s.them === 'Matt', 8000, 'Matt walks in'); await a.keyboard.press('Digit1');      // Rookie: a match against him lasts past this round (first to 5)
await c.click('#btn-courts'); await sleep(300); await c.click('#court-seg [data-filter="open"]'); await c.click('#court-search'); await type(c, OPEN.slice(0, 2).toLowerCase());      // Cat's last visit left the Full tab on (it is remembered)
const askRow = code => c.evaluate(code => { const li = [...document.querySelectorAll('#room-list > li.court[data-kind="ask"]')].filter(l => l.firstElementChild.dataset.code === code); return { n: li.length, go: li[0]?.querySelector('.court-go')?.textContent, who: li[0]?.querySelector('.court-who')?.textContent }; }, code);
for (let i = 0; i < 150 && !(q = await askRow(OPEN)).n; i++) await sleep(200);      // listed as Join until Ann's first strike, then as Ask to play (the list arrives every second)
ok(q.n === 1 && q.go === 'Ask to play' && /^Ann vs Matt$/.test(q.who), `Cat types "${OPEN.slice(0, 2)}": one ask row for ${OPEN}, "${q.who}", "${q.go}"`);
for (let i = 0; i < 8 && await c.evaluate(() => document.activeElement.dataset.code) !== OPEN; i++) await c.keyboard.press('ArrowDown');      // Down from search walks the list to it
await c.evaluate(() => { window.__toasts = []; new MutationObserver(() => { const t = document.getElementById('toast'); if (t.classList.contains('on')) window.__toasts.push(t.textContent); }).observe(document.getElementById('toast'), { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['class'] }); });      // every toast Cat is shown from here on
ok(await c.evaluate(() => document.activeElement.dataset.code) === OPEN, `the arrows reach ${OPEN}'s row`); await c.keyboard.press('Enter');
u = await until(c, s => s.phase === 'watch' && s.room === OPEN, 6000, 'c presses Enter on the row: in the stands');
q = await askUntil(c, v => /^Waiting · \d+s$/.test(v.btn || ''), 3000, 'c: Waiting after a join'); const toasts = await c.evaluate(() => [...new Set(window.__toasts)]);
ok(u.srole === 'spectator' && /^Waiting · \d+s$/.test(q.btn) && toasts.length === 1 && /We asked (if you|the player if you) can play\./.test(toasts[0]), `Enter on an Ask to play row is watch + ask: button "${q.btn}", toasts ${JSON.stringify(toasts)}`);
await askUntil(a, v => v.card, 3000, 'a gets the card again'); await a.keyboard.press('KeyY');
u = await until(c, s => s.srole === 'player' && (s.screen === 'calibrate' || s.screen === 'connect' || s.screen === 'hud'), 6000, 'Y: Cat goes to her paddle as a player'); ok(u.srole === 'player' && u.role !== 'spectator', `Y accepts: Cat is a player now (${u.screen})`);
u = await toCourt(c); s = await until(a, s => s.them === 'Cat', 6000, 'Ann plays Cat'); ok(s.them === 'Cat' && s.scMe === 0 && s.scThem === 0, `Matt's seat is Cat's: Ann plays "${s.them}" from ${s.scMe}-${s.scThem}`);
for (const pg of [a, b, c]) ok((await st(pg)).errors === 0, `${pg.tag}: no script errors counted`);
ok(!errs.length, 'no console errors, page errors or failed requests' + (errs.length ? ':\n  ' + errs.join('\n  ') : ''));
const fails = out.filter(l => l.startsWith('FAIL')); console.log(`${out.length - fails.length} passed, ${fails.length} failed`);
if (fails.length) console.log('server log:\n' + slog.join('').split('\n').slice(-25).join('\n'));
console.log(fails.length ? 'SPECTATE E2E FAIL' : 'SPECTATE E2E PASS'); done(fails.length ? 1 : 0);
