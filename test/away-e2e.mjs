// Away (NOTES 220), in real Chromes on a real server: a player whose tab goes hidden, or whose window loses focus, shows Away over their
// character and under their name to the opponent and the stands; back, it goes. Against Matt it is a pause instead: Paused, the court
// frozen, and coming back plays on. A blur that comes straight back (under 0.4 s) says nothing.
// AWAY_PORT=<base> moves the block (base .. base+2). Screenshots: test/ui-shots/away-*.png
import { spawn } from 'child_process'; import fs from 'fs';
import { WebSocketServer } from 'ws';
import puppeteer from 'puppeteer-core';
import { makeSynth, CALIBRATE, SESSION_LOOP } from './fake-bridge.mjs';
const root = new URL('..', import.meta.url).pathname, SHOTS = root + 'test/ui-shots/', sleep = ms => new Promise(r => setTimeout(r, ms)), P0 = +process.env.AWAY_PORT || 8940;
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
      await pg.screenshot({ path: `${SHOTS}emotes-${n}-${w}x${h}.png` }); }
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

setTimeout(() => { console.log('EMOTEBAR E2E FAIL (timeout)'); process.exit(2); }, 6 * 60000);
setTimeout(() => { console.log('AWAY E2E FAIL (timeout)'); process.exit(2); }, 5 * 60000);
fs.mkdirSync(SHOTS, { recursive: true });
const R = rig({ WIN_AT: '11' }), { ok, done, until, open, type, toLobby, toCourt, play, st } = R; let s;
// hide / show the tab, or blur / focus the window, as the browser would say it
const hide = (pg, on) => pg.evaluate(on => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => on }); Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => on ? 'hidden' : 'visible' }); document.dispatchEvent(new Event('visibilitychange', { bubbles: true })); }, on);
const blur = (pg, on) => pg.evaluate(on => { document.hasFocus = () => !on; dispatchEvent(new Event(on ? 'blur' : 'focus')); }, on);
const a = await open('a', 'Ann'), b = await open('b', 'Ben');
await toLobby(a); await a.click('#btn-courts'); await sleep(300); await a.click('#btn-create'); await sleep(300); await a.click('#seg [data-public="0"]'); await a.click('#btn-create-go'); s = await until(a, s => s.lview === 'share' && s.share.length === 4, 3000, 'share view'); const CODE = s.share;
await toLobby(b); await b.click('#btn-courts'); await sleep(300); await b.click('#code-boxes input'); await type(b, CODE); await b.keyboard.press('Enter'); await a.click('#btn-share-go');
await Promise.all([toCourt(a), toCourt(b)]);
const c = await open('c', 'Cat', `&court=${CODE}&watch=1`); await play(c); await until(c, s => s.phase === 'watch', 6000, 'c watches');
await sleep(800);
// ---- two people: Away over Ann, the rally plays on ----
await hide(a, true);
s = await until(b, s => s.themSub === 'Away' && s.tags.includes('afk'), 3000, 'Ben sees Away over Ann');
ok(s.themSub === 'Away' && !s.scene.frozen, `Ann hides her tab: Ben sees Away under her name and over her character, nothing stops (${s.themSub}, tags ${s.tags}, frozen ${s.scene.frozen})`);
s = await until(c, s => s.meSub === 'Away', 3000, 'Cat sees Away on Ann'); ok(s.meSub === 'Away' && s.tags.includes('afk'), `the stands see it too (${s.meSub}, ${s.tags})`);
await b.screenshot({ path: `${SHOTS}away-ben-sees-ann.png` });
await hide(a, false); s = await until(b, s => s.themSub !== 'Away', 3000, 'Ann back'); ok(s.themSub !== 'Away', `back: the tag goes (${s.themSub})`);
await blur(a, true); await sleep(150); await blur(a, false); await sleep(900); s = await st(b); ok(s.themSub !== 'Away', `a blur that comes straight back says nothing (${s.themSub})`);
await blur(a, true); s = await until(b, s => s.themSub === 'Away', 3000, 'blur -> Away'); ok(s.themSub === 'Away', `the window loses focus: Away (${s.themSub})`);
await blur(a, false); s = await until(b, s => s.themSub !== 'Away', 3000, 'focus -> back'); ok(s.themSub !== 'Away', 'focus again: back');
// ---- against Matt: a pause ----
const d = await open('d', 'Dot'); await toLobby(d); await d.click('#btn-bot'); await sleep(300); await d.click('#btn-bot-1'); await toCourt(d); await until(d, s => s.them === 'Matt', 6000, 'Matt sits down'); await sleep(1500);
await hide(d, true); await sleep(600); s = await st(d);
ok(s.paused && s.scene.frozen, `against Matt, a hidden tab pauses the court (paused ${s.paused}, frozen ${s.scene.frozen})`);
await sleep(2200); s = await st(d); ok(s.paused && s.scene.frozen, `and stays paused while hidden: no heal resumes it behind her back (paused ${s.paused})`);
await hide(d, false); s = await until(d, s => !s.paused && !s.scene.frozen, 3000, 'Dot back: Matt plays on'); ok(!s.paused && !s.scene.frozen, 'back: it plays on');
await blur(d, true); await sleep(900); s = await st(d); ok(s.paused && s.pausedTag, `the window loses focus: paused too, the Paused tag up (${s.paused}, ${s.pausedTag})`);
await d.screenshot({ path: `${SHOTS}away-matt-paused.png` });
await blur(d, false); s = await until(d, s => !s.paused, 3000, 'focus -> plays on'); ok(!s.paused, 'focus again: plays on');
await done();
