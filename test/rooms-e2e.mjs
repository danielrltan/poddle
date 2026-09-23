// Rooms end to end: the real client against the real server/game.js (which serves web/ itself), fake AirPods, headless Chrome.
// Two tabs make and join a private room and play; leave, full room, quick play and reload follow. Usage: node test/rooms-e2e.mjs
// ROOMS_E2E_PORT=<base> moves the ports (default 8430: game + page, 8431: AirPods). Screenshots land in test/ui-shots/rooms-*.png.
import { spawn } from 'child_process'; import fs from 'fs';
import { WebSocketServer } from 'ws';
import puppeteer from 'puppeteer-core';
import { makeSynth, CALIBRATE, SESSION_LOOP } from './fake-bridge.mjs';
const P0 = +process.env.ROOMS_E2E_PORT || 8430, G = P0, B = P0 + 1, root = new URL('..', import.meta.url).pathname, sleep = ms => new Promise(r => setTimeout(r, ms));
const server = spawn('node', ['server/game.js'], { cwd: root, env: { ...process.env, PORT: G }, stdio: ['ignore', 'pipe', 'inherit'] }), slog = []; server.stdout.on('data', d => slog.push(String(d)));

// ---- AirPods: one per tab, told apart by the path (?bridge=8431/a -> ws://localhost:8431/a). A real player holds the AirPod
// through the menus and only then calibrates, so each one lies still until go(tag) starts fake-bridge's calibrate-then-swing script.
// The AirPod belongs to the tag, not to the socket: a tab that reconnects to its bridge finds the same hand in the same pose.
const pods = {}, podOpts = { heading: 137, gyroNoise: 0.02, accNoise: 0.005, seed: 7 }, links = [];
const rest = tag => { const p = pods[tag] ??= { t: 3580, socks: new Set() }; p.syn = makeSynth({ ...podOpts, script: [], t0: p.t + 0.02 }); return p; };
const go = tag => { const p = pods[tag]; p.syn = makeSynth({ ...podOpts, script: CALIBRATE, loop: SESSION_LOOP, t0: p.t + 0.02 }); };
new WebSocketServer({ port: B }).on('connection', (ws, req) => { const tag = req.url.slice(1), p = pods[tag] || rest(tag); p.socks.add(ws); links.push(`${tag}@${(performance.now() / 1000).toFixed(1)}s`);
  ws.on('close', () => { p.socks.delete(ws); links.push(`${tag}-closed@${(performance.now() / 1000).toFixed(1)}s`); }); ws.on('error', () => p.socks.delete(ws)); });
{ const start = performance.now(); let sent = 0;
  setInterval(() => { const due = Math.floor((performance.now() - start) / 20);
    for (; sent <= due; sent++) for (const p of Object.values(pods)) { const m = p.syn.next(); delete m._t; p.t = m.t; const j = JSON.stringify(m); for (const ws of p.socks) if (ws.readyState === 1) ws.send(j); } }, 5); }

const CHROME = process.env.CHROME || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => fs.existsSync(p));
// One Chrome per player: a background tab gets no frames (so no clicks and no picture), and two players never share a window anyway.
const browsers = [], launch = async () => { const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] }); browsers.push(b); return b; };
fs.mkdirSync(root + 'test/ui-shots', { recursive: true });
const out = [], errs = [], ok = (c, what) => { out.push((c ? 'PASS ' : 'FAIL ') + what); console.log(c ? 'PASS' : 'FAIL', what); return c; };
const done = async code => { for (const b of browsers) await b.close().catch(() => {}); server.kill(); process.exit(code); };
setTimeout(() => { console.log('ROOMS E2E FAIL (timeout)'); done(2); }, 420000);
for (const ev of ['uncaughtException', 'unhandledRejection']) process.on(ev, e => { console.log('ROOMS E2E FAIL', e); done(2); });      // never leave the server or a Chrome behind
server.on('exit', c => { console.log(`ROOMS E2E FAIL: server/game.js stopped (${c}). Is port ${G} taken?`); done(2); });

const st = pg => pg.evaluate(() => { const t = id => document.getElementById(id), tx = id => t(id).textContent.trim(), s = window.__stats;
  return { screen: document.body.dataset.screen, view: [...document.querySelectorAll('#screen-lobby .lobby-view')].find(v => !v.hidden)?.dataset.view, share: tx('share-code').replace(/\s/g, ''),
    pill: t('room-pill').hidden ? null : tx('room-code'), chip: t('title-room').hidden ? null : tx('title-room'), err: tx('code-err'), toast: t('toast').classList.contains('on') ? tx('toast') : null, banner: t('banner').classList.contains('show') ? tx('banner-text') : null,
    rooms: [...document.querySelectorAll('#room-list .room-row')].map(b => b.textContent.trim()), them: tx('name-them'), themSub: tx('sub-them'), meSub: tx('sub-me'), me: +tx('sc-me'), op: +tx('sc-them'), menuBtn: !!t('btn-menu') && !t('hud').hidden, ask: t('ask-watch').hidden ? null : tx('ask-title'), hold: t('hold').hidden ? null : tx('hold-text'), result: document.body.dataset.overlay === 'match' ? tx('result-title') + ' / ' + tx('result-note') : null,
    search: location.search, calibrated: s.calibrated, hits: s.hits, myHits: s.myHits, serves: s.events.serve || 0, points: s.events.point || 0, errors: s.errors,
    clipped: [...document.querySelectorAll('.screen.is-active [data-fit], #hud [data-fit]')].filter(e => { const b = e.getBoundingClientRect(), c = getComputedStyle(e); return b.width && c.visibility !== 'hidden' && (b.left < -.5 || b.top < -.5 || b.right > innerWidth + .5 || b.bottom > innerHeight + .5); }).map(e => e.id || e.className) }; });
async function until(pg, test, ms, what) { const end = Date.now() + ms; let s; do { s = await st(pg); if (test(s)) return s; await sleep(150); } while (Date.now() < end); ok(false, `${what} (gave up after ${ms / 1000} s: ${JSON.stringify(s)})`); return s; }
const NAME = { a: 'Ada', b: 'Bo', c: 'Cy', d: 'Dee', e: 'Eve', f: 'Fay' };
async function open(tag, query = '', w = 1280, h = 720) { const pg = (await (await launch()).pages())[0]; await pg.setViewport({ width: w, height: h }); pg.tag = tag;
  pg.on('pageerror', e => errs.push(`[${tag}] PAGEERROR ${e.message}`)); pg.on('response', r => { if (r.status() >= 400) errs.push(`[${tag}] ${r.status()} ${r.url()}`); });
  pg.on('console', m => { if (m.type() === 'error') errs.push(`[${tag}] ${m.text()}`); });
  await pg.evaluateOnNewDocument(n => { try { if (!localStorage.getItem('poddle.name')) localStorage.setItem('poddle.name', n); } catch { /* */ } }, NAME[tag]);      // the lobby asks a first-time visitor for a name (test/spectate-e2e.mjs walks that); these tabs have played before
  await pg.goto(`http://localhost:${G}/?bridge=${B}/${tag}&game=${G}${query}`); await sleep(1500); return pg; }
const shot = async (pg, n) => { await sleep(450); const [w, h] = [pg.viewport().width, pg.viewport().height]; await pg.screenshot({ path: `${root}test/ui-shots/rooms-${n}-${w}x${h}.png` });
  const c = (await st(pg)).clipped; ok(!c.length, `${pg.tag} ${n} ${w}x${h}: nothing off screen ${c}`); };
const type = async (pg, text) => { for (const c of text) await pg.keyboard.type(c, { delay: 25 }); await sleep(150); };
const toLobby = async pg => { await pg.click('#btn-start'); await sleep(300); await pg.evaluate(() => document.fullscreenElement && document.exitFullscreen());      // Play goes full screen, which headless Chrome photographs at the wrong size
  return until(pg, s => s.screen === 'lobby', 3000, `${pg.tag} Play -> lobby`); };
async function toCourt(pg) {                       // seated -> connect/calibrate -> the court. The AirPod starts its calibration script when the screen asks for it
  await until(pg, s => s.screen === 'calibrate', 6000, `${pg.tag} reaches calibration`); go(pg.tag);
  return until(pg, s => s.calibrated && s.screen === 'hud', 30000, `${pg.tag} calibrates and sees the court`); }

// ---- 1. A makes a private room, B joins by code, both calibrate and play ----
const a = await open('a'), b = await open('b', '', 600, 900); let s, t;
await shot(a, '1-title'); await shot(b, '1-title');
await toLobby(a); await shot(a, '2-lobby-empty');
await a.click('#btn-create'); await sleep(300); await a.click('#seg [data-public="0"]'); await shot(a, '3-create');
await a.click('#btn-create-go'); s = await until(a, s => s.view === 'share' && s.share.length === 4, 3000, 'a create -> share view with a code');
const CODE = s.share; ok(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/.test(CODE) && s.search.includes('court=' + CODE), `a made private room ${CODE}, address bar ${s.search}`); await shot(a, '4-share');
await toLobby(b); s = await st(b); ok(!s.rooms.some(r => r.startsWith(CODE)), `b: private room is not in the open list (${s.rooms})`);
await b.click('#btn-code'); await sleep(300); await shot(b, '5-code-empty'); await type(b, 'zz' + 'zz'); await shot(b, '5-code-filled');
await b.keyboard.press('Enter'); s = await until(b, s => s.err, 3000, 'b wrong code -> inline error'); ok(s.err === 'Court not found' && s.view === 'code', `b wrong code: "${s.err}"`); await shot(b, '5-code-error');
for (let i = 0; i < 4; i++) await b.keyboard.press('Backspace'); await type(b, CODE.toLowerCase()); await b.keyboard.press('Enter');
await a.click('#btn-share-go'); [s, t] = await Promise.all([toCourt(a), toCourt(b)]);
ok(s.pill === CODE && t.pill === CODE && s.menuBtn && t.menuBtn, `both on the court in room ${CODE} (pills ${s.pill}/${t.pill})`);
[s, t] = await Promise.all([until(a, s => s.them === 'Bo', 4000, 'a sees Bo'), until(b, s => s.them === 'Ada', 4000, 'b sees Ada')]);
ok(s.them === 'Bo' && s.meSub === 'Near side' && t.them === 'Ada' && t.meSub === 'Far side', `two humans, no bot: a sees "${s.them}" from the ${s.meSub}, b sees "${t.them}" from the ${t.meSub}`);
await shot(a, '6-hud'); await shot(b, '6-hud');
let agree = 0, last = null;                          // a serve, a rally, a point; both scoreboards must tell the same story
for (let i = 0; i < 900 && !(agree >= 3 && last.s.hits >= 2 && last.s.points >= 1); i++) { await sleep(100); [s, t] = await Promise.all([st(a), st(b)]); last = { s, t }; if (s.me === t.op && s.op === t.me) agree++; else agree = 0; }
ok(last.s.serves >= 1 && last.t.serves >= 1, `a serve happened (a saw ${last.s.serves}, b saw ${last.t.serves})`);
ok(last.s.hits >= 2 && last.t.hits >= 2 && Math.abs(last.s.hits - last.t.hits) <= 1, `a rally: ${last.s.hits} hits on a (${last.s.myHits} mine), ${last.t.hits} on b (${last.t.myHits} mine)`);
ok(agree >= 3 && last.s.points >= 1, `scores agree: a ${last.s.me}-${last.s.op}, b ${last.t.me}-${last.t.op} after ${last.s.points} points`);
ok(!/Matt/.test(last.s.them + last.t.them), `still no bot (${last.s.them} / ${last.t.them})`); await shot(a, '7-hud-rally'); await shot(b, '7-hud-rally');

// ---- 2. a third tab with the link finds the court full: it is asked to watch, and says no (NEW RULE, docs/SPECTATE.md; watching is test/spectate-e2e.mjs) ----
const c = await open('c', '&court=' + CODE.toLowerCase()); s = await st(c); ok(s.chip === 'Joining court ' + CODE, `c title chip: "${s.chip}"`); await shot(c, '8-title-link');
await c.click('#btn-start'); s = await until(c, s => s.ask, 3000, 'c gets an answer'); ok(s.ask === 'Court is full. Watch instead?' && s.screen === 'lobby' && !/(court|room)=/.test(s.search), `c full court: "${s.ask}" on ${s.screen}, address bar "${s.search}"`); await shot(c, '8-full');
await c.click('#btn-watch-no'); s = await until(c, s => !s.ask, 2000, 'No closes the question'); ok(s.screen === 'lobby' && s.view === 'code' && s.pill === null, `c said no: still in the lobby, ${s.view} view`);

// ---- 3. reload mid-game: the seat is HELD (NEW RULE), then the same court, the same side, the same score (b is on the far side, so a seat handed out afresh would not do) ----
const sc0 = await st(a);
rest('b'); [, s] = await Promise.all([b.reload(), until(a, s => s.hold, 4000, 'a sees the hold card')]); ok(s.hold === 'Waiting for Bo' && s.toast !== 'Bo left', `a while b reloads: "${s.hold}"`);
await sleep(1500); s = await st(b); ok(s.screen === 'title' && s.chip === 'Joining court ' + CODE, `b reloaded: title with "${s.chip}"`);
await b.click('#btn-start'); await until(b, s => s.screen === 'calibrate', 6000, 'b reaches calibration again');
s = await until(a, s => s.themSub === 'Calibrating' && !s.hold, 4000, 'a is told b is calibrating'); const sv0 = s.serves; await sleep(2000); s = await st(a);      // the serve waits for whoever is still calibrating
ok(s.them === 'Bo' && s.themSub === 'Calibrating' && s.serves <= sv0 + 1 && s.me >= sc0.me && s.op >= sc0.op && s.me + s.op <= sc0.me + sc0.op + 1, `while b calibrates: a sees "${s.them} / ${s.themSub}", ${s.serves - sv0} serves, the score is kept (${sc0.me}-${sc0.op} -> ${s.me}-${s.op})`);
t = await toCourt(b); [s, t] = await Promise.all([until(a, s => s.them === 'Bo' && s.themSub === 'Far side', 5000, 'a sees b again'), until(b, s => s.them === 'Ada', 5000, 'b sees a again')]);
ok(t.pill === CODE && t.meSub === 'Far side' && s.meSub === 'Near side', `b is back in ${t.pill} on the ${t.meSub}`);
rest('a'); await a.reload(); await sleep(1500); await a.click('#btn-start'); await toCourt(a); s = await until(a, s => s.them === 'Bo', 5000, 'a sees b after its own reload');
ok(s.pill === CODE && s.meSub === 'Near side', `a is back in ${s.pill} on the ${s.meSub}`);

// ---- 4. b leaves mid-match: a forfeit (NEW RULE). a wins, the court closes, nobody can join it any more ----
await until(a, s => s.hits > 0, 30000, 'a ball is struck after the reloads');
await b.keyboard.press('KeyQ'); s = await until(b, s => s.toast, 2000, 'b first Q'); ok(s.toast === 'Press Q again to forfeit' && s.screen === 'hud', `b first Q only asks, and says what leaving costs mid-match: "${s.toast}"`); await shot(b, '9-leave-ask');
await b.keyboard.press('KeyQ');
s = await until(a, s => s.result, 3000, 'a gets the result'); ok(s.result === 'You win! / Bo left', `a after b left: "${s.result}"`); await shot(a, '9-opponent-left');
s = await until(b, s => s.screen === 'lobby' && s.view === 'home', 2000, 'b back in the lobby'); ok(s.pill === null && !/(court|room)=/.test(s.search) && s.toast === null, `b is in the lobby, no court pill, clean address bar, no stale toast`);
await a.click('#btn-leave'); s = await until(a, s => s.screen === 'lobby' && s.pill === null, 4000, 'a leaves the result for the lobby'); ok(!s.result, 'a is in the lobby');
await c.click('#btn-join'); s = await until(c, s => s.err, 4000, 'c tries the code again'); ok(s.err === 'Court not found' && s.screen === 'lobby', `the court is gone: "${s.err}"`);
await c.browser().close(); await a.browser().close();

// ---- 5. quick play: d waits on the court (Matt walks in), f is seated with it and leaves BEFORE a ball is struck: a plain leave, Matt comes back. Then they play ----
const e = await open('e'), d = await open('d'), f = await open('f');
await toLobby(e); await toLobby(d); await d.click('#btn-quick'); s = await until(d, s => s.pill, 4000, 'd quick play seats it'); const PUB = s.pill;
s = await until(e, s => s.rooms.some(r => r.startsWith(PUB)), 3000, 'e sees the waiting court'); ok(s.rooms.some(r => r === PUB + '1 player'), `e lists ${PUB}: ${s.rooms}`); await shot(e, '2-lobby-rooms'); await until(b, s => s.rooms.length, 3000, 'b sees it too'); await shot(b, '2-lobby-rooms');
await toCourt(d); s = await until(d, s => s.them === 'Matt', 8000, 'alone on the court: Matt walks in'); ok(s.them === 'Matt' && /Rookie|Club|Pro/.test(s.themSub), `d plays "${s.them}" / "${s.themSub}" while it waits`);
await toLobby(f); await f.click('#btn-quick'); s = await until(f, s => s.pill, 4000, 'f quick play seats it'); ok(s.pill === PUB && PUB !== CODE, `d and f share public court ${PUB} (f got ${s.pill})`);
s = await until(e, s => s.rooms.some(r => /^\w{4}\d+-\d+/.test(r) && r.startsWith(PUB)), 3000, 'the full court stays on e’s list, with its score'); ok(s.rooms.some(r => r.startsWith(PUB + '0-0')), `e lists the full court by its score (NEW RULE: it can be watched): [${s.rooms}]`);
s = await until(d, s => s.banner === 'Fay joined to play' || (s.them === 'Fay' && s.themSub === 'Calibrating'), 4000, 'd sees Fay arrive'); ok(s.banner === 'Fay joined to play' || s.them === 'Fay', `d: "${s.them} / ${s.themSub}", centre banner "${s.banner}"`);
await f.keyboard.press('KeyQ'); await sleep(200); await f.keyboard.press('KeyQ'); const leftAt = Date.now();
s = await until(d, s => s.toast === 'Fay left', 3000, 'd gets the toast'); ok(s.toast === 'Fay left' && !s.result && !s.hold, `before a ball is struck a leaver just leaves: "${s.toast}"`);
s = await until(d, s => s.them === 'Matt', 8000, 'the bot comes back for d'); ok(s.them === 'Matt', `d plays "${s.them}" again ${((Date.now() - leftAt) / 1000).toFixed(1)} s after f left`);
await until(f, s => s.screen === 'lobby' && s.view === 'home', 3000, 'f back in the lobby'); await f.click('#btn-quick'); s = await until(f, s => s.pill, 4000, 'f quick play again'); ok(s.pill === PUB, `f is back in ${s.pill}`);
t = await toCourt(f); [s, t] = await Promise.all([until(d, s => s.them === 'Fay', 4000, 'd sees a human'), until(f, s => s.them === 'Dee', 4000, 'f sees a human')]);
ok(s.them === 'Fay' && t.them === 'Dee', `quick play pair: d sees "${s.them}", f sees "${t.them}"`);

for (const pg of [b, d, e, f]) ok((await st(pg)).errors === 0, `${pg.tag}: no script errors counted`);
ok(!errs.length, 'no console errors, page errors or failed requests' + (errs.length ? ':\n  ' + errs.join('\n  ') : ''));
console.log('AirPod links opened:', links.join(' '));
const fails = out.filter(l => l.startsWith('FAIL')); console.log(`${out.length - fails.length} passed, ${fails.length} failed`);
if (fails.length) console.log('server log:\n' + slog.join('').split('\n').slice(-25).join('\n'));
console.log(fails.length ? 'ROOMS E2E FAIL' : 'ROOMS E2E PASS'); done(fails.length ? 1 : 0);
