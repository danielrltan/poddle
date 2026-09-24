// The fixer's browser checks (NOTES.md 17-18): real server/game.js, fake AirPods, real Chromes. Three short sessions:
//  1. Ann + Ben play to 3, Cat watches: no ping pill for a spectator, split stacks in a tall window, the free camera's leash and slide, 'forfeit' wording,
//     Leave stays open after Rematch, no confetti over the lobby.
//  2. Ann against Matt, Cat watches: the paused picture is the cheap one, the HUD at phone width, a reload keeps the stands full.
//  3. Ann + Ben: a seat that calibrates for ever is counted down and forfeits, the forfeit card has no clock.
// FIX_E2E_PORT=<base> moves the block (base .. base+2). Screenshots: test/ui-shots/fix-*.png. LOOK at them.
import { spawn } from 'child_process'; import fs from 'fs';
import { WebSocketServer } from 'ws';
import puppeteer from 'puppeteer-core';
import { makeSynth, CALIBRATE, SESSION_LOOP } from './fake-bridge.mjs';
const root = new URL('..', import.meta.url).pathname, SHOTS = root + 'test/ui-shots/', sleep = ms => new Promise(r => setTimeout(r, ms)), P0 = +process.env.FIX_E2E_PORT || 8450;
if ([8080, 8787, 3000].some(p => p >= P0 && p <= P0 + 2)) { console.log("refusing: that port range holds the player's own game"); process.exit(2); }
const out = [], errs = [];                                  // one tally across the three sessions
function rig(env = {}) {
  const G = P0, B = P0 + 1, DEAD = P0 + 2;
  const server = spawn('node', ['server/game.js'], { cwd: root, env: { ...process.env, PORT: G, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }), slog = []; server.stdout.on('data', d => slog.push(String(d))); server.stderr.on('data', d => slog.push('ERR ' + d));
  const pods = {}, podOpts = { heading: 137, gyroNoise: 0.02, accNoise: 0.005, seed: 7 };
  const rest = tag => { const p = pods[tag] ??= { t: 3580, socks: new Set() }; p.syn = makeSynth({ ...podOpts, script: [], t0: p.t + 0.02 }); return p; };
  const go = tag => { const p = pods[tag] || rest(tag); p.syn = makeSynth({ ...podOpts, script: CALIBRATE, loop: SESSION_LOOP, t0: p.t + 0.02 }); };
  const swing = tag => { const p = pods[tag] || rest(tag); p.syn = makeSynth({ ...podOpts, script: [{ T: 0.4 }], loop: SESSION_LOOP, t0: p.t + 0.02 }); };
  const wss = new WebSocketServer({ port: B }); wss.on('connection', (ws, req) => { const tag = req.url.slice(1), p = pods[tag] || rest(tag); p.socks.add(ws); ws.on('close', () => p.socks.delete(ws)); ws.on('error', () => p.socks.delete(ws)); });
  const start = performance.now(); let sent = 0;
  const iv = setInterval(() => { const due = Math.floor((performance.now() - start) / 20);
    for (; sent <= due; sent++) for (const p of Object.values(pods)) { const m = p.syn.next(); delete m._t; p.t = m.t; const j = JSON.stringify(m); for (const ws of p.socks) if (ws.readyState === 1) ws.send(j); } }, 5);
  const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const browsers = [];
  const launch = async () => { const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] }); browsers.push(b); return b; };
  const ok = (c, what) => { out.push((c ? 'PASS ' : 'FAIL ') + what); console.log(c ? 'PASS' : 'FAIL', what); return c; };
  const note = what => { out.push('NOTE ' + what); console.log('NOTE', what); };
  const close = async () => { clearInterval(iv); for (const b of browsers.splice(0)) await b.close().catch(() => {}); server.kill(); wss.close(); await sleep(400); };
  const done = async code => { clearInterval(iv); for (const b of browsers) await b.close().catch(() => {}); server.kill(); wss.close(); const f = out.filter(l => l.startsWith('FAIL')); console.log(`${out.filter(l => l.startsWith('PASS')).length} passed, ${f.length} failed`); if (errs.length) console.log('console/page errors:\n  ' + errs.join('\n  ')); if (f.length) console.log('server log tail:\n' + slog.join('').split('\n').slice(-15).join('\n')); process.exit(code ?? (f.length ? 1 : 0)); };
  for (const ev of ['uncaughtException', 'unhandledRejection']) process.on(ev, e => { console.log('CRASH', e); done(2); });
  const st = pg => pg.evaluate(() => { const t = id => document.getElementById(id), vis = id => { const e = t(id); if (!e || e.hidden) return false; const c = getComputedStyle(e), b = e.getBoundingClientRect(); return c.display !== 'none' && c.visibility !== 'hidden' && +c.opacity > 0.05 && b.width > 0; },
      tx = id => t(id) ? t(id).textContent.trim() : null, s = window.__stats, d = document.body.dataset, sc = window.__scene, v = sc ? sc._dbg.view() : {}, bm = sc ? sc._dbg.ballMesh : null;
    return { screen: d.screen, overlay: d.overlay || null, role: d.role || null, dview: d.view || null, paused: d.paused === '1', settings: d.settings === 'open', phase: s.phase, srole: s.role, room: s.room,
      lview: [...document.querySelectorAll('#screen-lobby .lobby-view')].find(e => !e.hidden)?.dataset.view, share: (tx('share-code') || '').replace(/\s/g, ''), pill: t('room-pill').hidden ? null : tx('room-code'), chip: t('title-room').hidden ? null : tx('title-room'),
      err: tx('code-err'), toast: t('toast').classList.contains('on') ? tx('toast') : null, ask: vis('ask-watch') ? tx('ask-title') : null, gated: [...document.querySelectorAll('#lobby-home .tile')].every(e => e.getAttribute('aria-disabled') === 'true'), nameVal: t('name-input') ? t('name-input').value : null,
      rows: [...document.querySelectorAll('#room-list li')].map(li => li.textContent.trim()), me: tx('name-me'), meSub: tx('sub-me'), them: tx('name-them'), themSub: tx('sub-them'), scMe: +tx('sc-me'), scThem: +tx('sc-them'),
      svMe: t('sv-me').classList.contains('on'), svThem: t('sv-them').classList.contains('on'), banner: tx('banner-text'), keys: vis('keys') ? [...document.querySelectorAll('#keys li')].filter(e => !e.hidden).map(e => e.textContent.trim()).join(' | ') : null, menuBtn: vis('btn-menu'), views: vis('views'), watchTag: vis('watch-tag'), pausedTag: vis('paused-tag'),
      watchers: vis('watchers') ? +tx('watch-n') : 0, pov: tx('view-pov'), glass: +getComputedStyle(t('glass')).opacity, setTitle: tx('set-title'), note: vis('set-note') ? tx('set-note') : null,
      hold: vis('hold') ? tx('hold-text') + '|' + tx('hold-left') : null, result: d.overlay === 'match' && vis('result') ? { title: tx('result-title'), note: tx('result-note'), me: tx('tally-name-me'), them: tx('tally-name-them'), sc: tx('tally-sc-me') + '-' + tx('tally-sc-them'), btns: vis('rematch-btns'), rnote: tx('rematch-note'), left: tx('rematch-left') } : null,
      search: location.search, calibrated: s.calibrated, hits: s.hits, myHits: s.myHits, swings: s.swings, ev: { ...s.events }, errors: s.errors,
      tags: sc ? sc._dbg.pads.map(p => p.tag.visible ? p.status : null) : [], ghost: sc ? sc._dbg.pads.map(p => +p.ghost.toFixed(2)) : [],
      scene: { name: v.name, side: v.side, menu: v.menu, attract: v.attract, frozen: v.frozen, spectator: v.spectator, pr: v.pixelRatio, drawn: v.drawn }, ball: bm ? [bm.position.x, bm.position.y, bm.position.z, bm.visible ? 1 : 0] : null }; });
  async function until(pg, test, ms, what) { const end = Date.now() + ms; let s; do { s = await st(pg); if (test(s)) return s; await sleep(120); } while (Date.now() < end); const { ev, scene, ...brief } = s; ok(false, `${what} (gave up after ${ms / 1000} s: ${JSON.stringify(brief)})`); return s; }
  const url = (tag, query = '') => `http://localhost:${G}/?bridge=${B}/${tag}&game=${G}&uitest=1${query}`;
  async function open(tag, name, query = '', w = 1280, h = 720) { const pg = (await (await launch()).pages())[0]; await pg.setViewport({ width: w, height: h }); pg.tag = tag;
    pg.on('pageerror', e => errs.push(`[${tag}] PAGEERROR ${e.message}`)); pg.on('response', r => { if (r.status() >= 400) errs.push(`[${tag}] ${r.status()} ${r.url()}`); });
    pg.on('console', m => { if (m.type() === 'error' && !(pg.cutting && /WebSocket|ERR_CONNECTION/.test(m.text()))) errs.push(`[${tag}] ${m.text()}`); });
    await pg.evaluateOnNewDocument((name, dead) => { try { if (name && !localStorage.getItem('poddle.name')) localStorage.setItem('poddle.name', name); localStorage.setItem('poddle.camPrimer', 'allow'); } catch { /* */ }
      const WS = window.WebSocket, socks = []; let cut = false;
      window.WebSocket = class extends WS { constructor(u, p) { const game = /[?&]cid=/.test(u); super(game && cut ? `ws://localhost:${dead}` : u, p); if (game) socks.push(this); } };
      window.__cut = on => { cut = on; if (on) for (const s of socks.splice(0)) s.close(); }; }, name, DEAD);
    await pg.goto(url(tag, query)); await sleep(1500); return pg; }
  const shot = async (pg, n, sizes = [[1280, 720]]) => { const was = pg.viewport();
    for (const [w, h] of sizes) { if (pg.viewport().width !== w || pg.viewport().height !== h) { await pg.setViewport({ width: w, height: h }); await sleep(500); } await pg.mouse.move(w / 2, h / 2 + 3); await sleep(450);
      await pg.screenshot({ path: `${SHOTS}fix-${n}-${w}x${h}.png` }); }
    if (pg.viewport().width !== was.width || pg.viewport().height !== was.height) { await pg.setViewport(was); await sleep(400); } };
  const BOTH = [[1280, 720], [600, 900]];
  const type = async (pg, text) => { for (const c of text) await pg.keyboard.type(c, { delay: 25 }); await sleep(150); };
  const play = async pg => { if ((await st(pg)).screen !== 'title') { note(pg.tag + ': Play not pressed, already at ' + (await st(pg)).screen); return; } await pg.click('#btn-start'); await sleep(300); await pg.evaluate(() => document.fullscreenElement && document.exitFullscreen()); };
  const toLobby = async pg => { await play(pg); return until(pg, s => s.screen === 'lobby', 3000, `${pg.tag} Play -> lobby`); };
  async function toCourt(pg, ms = 30000) { const s = await until(pg, s => s.screen === 'calibrate' || s.calibrated && s.screen === 'hud', 8000, `${pg.tag} reaches calibration`);
    if (s.screen === 'calibrate') go(pg.tag); else swing(pg.tag); return until(pg, s => s.calibrated && s.screen === 'hud', ms, `${pg.tag} is on the court`); }
  const reload = async pg => { await pg.reload(); await sleep(1500); };
  // rectangles of everything visible in the HUD corners, to find overlaps
  const boxes = (pg, ids) => pg.evaluate(ids => Object.fromEntries(ids.map(id => { const e = document.getElementById(id) || document.querySelector(id); if (!e) return [id, null]; const c = getComputedStyle(e), b = e.getBoundingClientRect(); return [id, e.hidden || c.display === 'none' || c.visibility === 'hidden' || +c.opacity < 0.05 || !b.width ? null : [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)]]; })), ids);
  const overlaps = bx => { const k = Object.keys(bx).filter(i => bx[i]), hit = []; for (let i = 0; i < k.length; i++) for (let j = i + 1; j < k.length; j++) { const a = bx[k[i]], b = bx[k[j]]; if (a[0] < b[2] - 1 && b[0] < a[2] - 1 && a[1] < b[3] - 1 && b[1] < a[3] - 1) hit.push(`${k[i]} x ${k[j]}`); } return hit; };
  return { G, B, DEAD, server, slog, pods, rest, go, swing, ok, note, done, close, st, until, open, shot, BOTH, type, play, toLobby, toCourt, reload, url, errs, out, boxes, overlaps };
}

setTimeout(() => { console.log('FIXES E2E FAIL (timeout)'); process.exit(2); }, 25 * 60000);
fs.mkdirSync(SHOTS, { recursive: true });

// ---------- 1. Ann + Ben play to 3, Cat watches ----------
{ const R = rig({ WIN_AT: '3', WIN_BY: '1' }), { ok, note, st, until, open, shot, BOTH, type, play, toLobby, toCourt, rest, go, reload, boxes, overlaps } = R; let s, t, u;
const a = await open('a', 'Ann'), b = await open('b', 'Ben');
await toLobby(a); await a.click('#btn-courts'); await sleep(300); await a.click('#btn-create'); await sleep(300); await a.click('#seg [data-public="0"]'); await a.click('#btn-create-go'); s = await until(a, s => s.lview === 'share' && s.share.length === 4, 3000, 'share view'); const CODE = s.share;
s = await a.evaluate(() => document.querySelector('label[for=name-input]').textContent); ok(s === 'Name', `lobby name label: "${s}"`);
await toLobby(b); await b.click('#btn-courts'); await sleep(300); await b.click('#code-boxes input'); await type(b, CODE); await b.keyboard.press('Enter'); await a.click('#btn-share-go');
await Promise.all([toCourt(a), toCourt(b)]);
const c = await open('c', 'Cat', `&court=${CODE}&watch=1`); await play(c); s = await until(c, s => s.phase === 'watch', 6000, 'c watches');
await sleep(1500); let bx = await boxes(c, ['ping-pill', 'room-pill', 'watchers']); ok(bx['ping-pill'] === null && bx['room-pill'], `spectator: no ping pill (${JSON.stringify(bx)})`);
bx = await boxes(a, ['ping-pill']); ok(bx['ping-pill'], 'player: ping pill shown');
// split, wide and tall
await c.keyboard.press('Digit2'); await sleep(1000); await shot(c, 'F-split', BOTH);
await c.setViewport({ width: 600, height: 900 }); await sleep(700); s = await c.evaluate(() => { const l = document.getElementById('split-line').getBoundingClientRect(); return { stacked: window.__scene._dbg.view().stacked, line: [l.left, l.top, l.width, l.height].map(Math.round) }; });
ok(s.stacked && s.line[2] === 600 && s.line[3] === 2 && s.line[1] === 449, `600x900: stacked, the line lies across the middle: ${JSON.stringify(s)}`); await c.setViewport({ width: 1280, height: 720 }); await sleep(500);
// free cam
await c.keyboard.press('Digit4'); await sleep(800);
await c.mouse.move(640, 300); await c.mouse.down(); await c.mouse.move(640, 0, { steps: 12 }); await c.mouse.up(); for (let i = 0; i < 25; i++) { await c.mouse.wheel({ deltaY: 400 }); await sleep(30); } await sleep(600);
let f = await c.evaluate(() => ({ ...window.__scene._dbg.free, cam: window.__scene._dbg.camera.position.toArray() })); ok(f.pitch === 6 && f.dist <= 16.01, `free cam lowest + farthest: pitch ${f.pitch}, dist ${f.dist.toFixed(1)}, camera ${f.cam.map(v => v.toFixed(1))}`); await shot(c, 'F-free-low-far');
for (let i = 0; i < 25; i++) { await c.mouse.wheel({ deltaY: -400 }); await sleep(30); } await c.mouse.move(640, 300); await c.mouse.down(); await c.mouse.move(640, 340, { steps: 4 }); await c.mouse.up(); await sleep(400); await shot(c, 'F-free-near-centre');
await c.mouse.move(640, 400); await c.mouse.down({ button: 'right' }); await c.mouse.move(1240, 400, { steps: 12 }); await c.mouse.up({ button: 'right' }); await sleep(500);
f = await c.evaluate(() => ({ ...window.__scene._dbg.free })); ok(Math.abs(f.tz) > 3, `right-drag slides the target along the court: tz ${f.tz.toFixed(2)}`); await shot(c, 'F-free-near-slid');
for (let i = 0; i < 40; i++) await c.keyboard.press('ArrowRight'); await sleep(300); const tz2 = (await c.evaluate(() => window.__scene._dbg.free.tz)); ok(Math.abs(tz2 - f.tz) > 3, `the arrow keys slide it too (Right looks right: back the other way): tz ${tz2.toFixed(2)}`); await shot(c, 'F-free-near-other-end');
await c.keyboard.press('Digit1');
// forfeit wording
await until(a, s => s.hits > 0, 30000, 'a ball is struck'); await a.keyboard.press('KeyQ'); s = await until(a, s => s.toast, 2000, 'a first Q'); ok(s.toast === 'Press Q again to forfeit', `mid-match against a person, first Q: "${s.toast}"`);
await sleep(2700); await a.click('#btn-menu'); await sleep(600); s = await a.evaluate(() => document.getElementById('btn-leave-room').textContent); ok(s === 'Forfeit', `settings Leave button mid-match: "${s}"`); await shot(a, 'F-settings-forfeit'); await a.keyboard.press('Escape');
// match end
[s, t] = await Promise.all([until(a, s => s.result, 240000, 'a result'), until(b, s => s.result, 240000, 'b result')]); const W = /You win/.test(s.result.title) ? a : b, L = W === a ? b : a; note(`result: a "${s.result.title}" b "${t.result.title}"`);
await W.click('#btn-rematch'); await sleep(500); s = await W.evaluate(() => ({ r: document.getElementById('btn-rematch').disabled, l: document.getElementById('btn-leave').disabled, note: document.getElementById('rematch-note').textContent })); ok(s.r && !s.l, `voted Rematch: Rematch locked, Leave still open (${JSON.stringify(s)})`); await shot(W, 'F-result-voted');
await W.click('#btn-leave'); s = await until(W, s => s.screen === 'lobby', 1500, 'winner in the lobby at once'); await sleep(950);
u = await W.evaluate(() => document.querySelectorAll('.confetti').length); ok(u === 0, `1 s after Leave: ${u} confetti pieces over the lobby`); await shot(W, 'F-lobby-after-leave');
t = await until(L, s => s.screen === 'lobby', 3000, 'loser in the lobby'); ok(t.toast === 'No rematch', `the other player: "${t.toast}"`);
await R.close(); }

// ---------- 2. Ann against Matt, Cat watches ----------
{ const R = rig({}), { ok, note, st, until, open, shot, BOTH, type, play, toLobby, toCourt, rest, go, reload, boxes, overlaps } = R; let s, t, u;
const a = await open('a', 'Ann'); await toLobby(a); await a.click('#btn-bot'); await sleep(300); await a.click('#btn-bot-1'); await toCourt(a); s = await until(a, s => s.them === 'Matt' && s.hits >= 1, 40000, 'a rally against Matt'); const CODE = s.room;
const c = await open('c', 'Cat', `&court=${CODE}&watch=1`); await play(c); await until(c, s => s.phase === 'watch', 6000, 'c watches');
const pr0 = (await st(a)).scene.pr; await a.click('#btn-menu'); s = await until(a, s => s.paused && s.glass > 0.9, 3000, 'paused'); await sleep(500);
u = await a.evaluate(() => { const v = window.__scene._dbg.view(), r = window.__scene._dbg.renderer, d0 = v.drawn; return new Promise(res => setTimeout(() => res({ dim: v.dim, pr: r.getPixelRatio(), fps: (window.__scene._dbg.view().drawn - d0) / 2, shadow: r.shadowMap.autoUpdate, buf: [r.domElement.width, r.domElement.height] }), 2000)); });
ok(u.dim && u.pr === pr0 / 2 && u.fps <= 31 && !u.shadow, `paused behind the blur: dim ${u.dim}, pixel ratio ${pr0} -> ${u.pr}, ${u.fps} fps, buffer ${u.buf}, shadow map held ${!u.shadow}`); await shot(a, 'G-paused');
await a.keyboard.press('Escape'); await until(a, s => !s.paused, 3000, 'resumed'); await sleep(400); u = await a.evaluate(() => { const v = window.__scene._dbg.view(), r = window.__scene._dbg.renderer; return { dim: v.dim, pr: r.getPixelRatio(), shadow: r.shadowMap.autoUpdate }; });
ok(!u.dim && u.pr === pr0 && u.shadow, `resumed: full picture again (${JSON.stringify(u)})`); await sleep(600); await shot(a, 'G-resumed');
// phone width, player
await a.setViewport({ width: 420, height: 900, deviceScaleFactor: 2 }); await sleep(900); await a.mouse.move(200, 500); await sleep(400);
const HUD = ['btn-menu', 'ping-pill', 'room-pill', 'watchers', 'board', 'keys', 'camwrap', 'podwrap'];
bxp: { const bx = await boxes(a, HUD), hit = overlaps(bx), w = await a.evaluate(() => ['name-me', 'name-them'].map(id => { const e = document.getElementById(id); return [e.textContent, e.scrollWidth <= e.clientWidth]; })); ok(!hit.length && w.every(x => x[1]), `420x900 player HUD: no overlap (${hit}), names fit: ${JSON.stringify(w)}`); }
await shot(a, 'G-phone-player', [[420, 900]]); await a.setViewport({ width: 1280, height: 720 }); await sleep(500);
await c.setViewport({ width: 420, height: 900, deviceScaleFactor: 2 }); await sleep(900); { const bx = await boxes(c, [...HUD, 'views']), hit = overlaps(bx); ok(!hit.length, `420x900 spectator HUD: no overlap (${hit})`); } await shot(c, 'G-phone-spectator', [[420, 900]]); await c.setViewport({ width: 1280, height: 720 }); await sleep(500);
// a reload in a bot court with someone watching
const sc = (await st(c)); rest('a'); await a.reload(); s = await until(c, s => s.hold, 4000, 'c sees the hold card'); ok(s.phase === 'watch' && /^Waiting for Ann\|\d+$/.test(s.hold) && s.toast !== 'Court closed', `Ann reloads: Cat stays, "${s.hold}"`); await shot(c, 'G-reload-hold');
await sleep(800); await a.click('#btn-start'); await toCourt(a); s = await until(c, s => !s.hold && s.them === 'Matt' && !s.scene.frozen, 8000, 'the hold ends'); ok(s.phase === 'watch' && s.room === CODE, `Ann is back in ${CODE}, Cat never left (${s.me} ${s.scMe}-${s.scThem} ${s.them})`);
await a.keyboard.press('KeyQ'); s = await until(a, s => s.toast, 2000, 'Q'); ok(s.toast === 'Press Q again to leave', `against Matt, first Q: "${s.toast}"`); await a.keyboard.press('KeyQ'); await until(c, s => s.screen === 'lobby', 3000, 'Cat is sent home when Ann really leaves');
await R.close(); }

// ---------- 3. Ann + Ben: a seat that calibrates for ever ----------
{ const R = rig({ CAL_S: '12' }), { ok, note, st, until, open, shot, BOTH, type, play, toLobby, toCourt, rest, go, reload, boxes, overlaps } = R; let s, t, u;
// Ann + Ben: Ben recalibrates and never finishes
const a = await open('a', 'Ann'), b = await open('b', 'Ben'); await toLobby(a); await a.click('#btn-courts'); await sleep(300); await a.click('#btn-create'); await sleep(300); await a.click('#seg [data-public="0"]'); await a.click('#btn-create-go'); s = await until(a, s => s.lview === 'share' && s.share.length === 4, 3000, 'share'); const C2 = s.share;
await toLobby(b); await b.click('#btn-courts'); await sleep(300); await b.click('#code-boxes input'); await type(b, C2); await b.keyboard.press('Enter'); await a.click('#btn-share-go'); await Promise.all([toCourt(a), toCourt(b)]);
await until(a, s => s.hits > 0, 30000, 'a ball is struck'); rest('b'); await b.keyboard.press('KeyC'); s = await until(a, s => s.themSub === 'Calibrating', 4000, 'a is told'); 
s = await until(a, s => s.hold, 20000, 'the wait is counted down'); ok(/^Waiting for Ben\|\d+$/.test(s.hold), `the serve waits for Ben, counted down: "${s.hold}"`); await shot(a, 'G-wait-card', BOTH);
s = await until(a, s => s.result, 20000, 'the staller forfeits'); await sleep(700); u = await boxes(a, ['rematch-count', 'rematch-bar', 'btn-leave', 'btn-rematch']); t = await a.evaluate(() => ({ r: document.getElementById('btn-rematch').disabled, l: document.getElementById('btn-leave').disabled }));
ok(s.result.title === 'You win!' && s.result.note === 'Ben left' && u['rematch-count'] === null && t.r && !t.l, `forfeit card: "${s.result.title} / ${s.result.note}", no countdown bar (${JSON.stringify(u['rematch-count'])}), only Leave`); await shot(a, 'G-forfeit-card', BOTH);
t = await until(b, s => s.screen === 'lobby', 3000, 'Ben is in the lobby'); ok(t.toast === 'Court closed' || t.toast === null, `Ben: "${t.toast}"`);
await R.close(); }

const fails = out.filter(l => l.startsWith('FAIL')); if (errs.length) console.log('console/page errors:\n  ' + errs.join('\n  '));
console.log(fails.length || errs.length ? `FIXES E2E FAIL (${fails.length} failed, ${errs.length} page errors)` : `FIXES E2E PASSED (${out.filter(l => l.startsWith('PASS')).length} checks)`); process.exit(fails.length || errs.length ? 1 : 0);
