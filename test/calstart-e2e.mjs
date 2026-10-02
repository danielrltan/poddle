// No match starts on a player who is not on the court (NOTES 170). Real server/game.js, fake AirPods, two real Chromes.
// A calibration is kept between courts, and the tab used to send 'paddle' (= "this seat is ready") from any screen once it had one:
// the share screen, the camera primer, the connect screen, the 'All set' card. The match was counted in and served behind them.
//  1. Ann plays a court (calibrates), leaves, makes a second court and stays on its share screen. Ben joins, calibrates, is on the court:
//     nothing is counted or served, and Ben sees 'Calibrating' on Ann.
//  2. Ann presses Start: the count runs, then the serve.
//  3. Mid-match Ann calibrates again (C): she is 'Calibrating' until her court is back on screen, not from the 'All set' card.
// CALSTART_PORT=<base> moves the block (base, base+1).
import { spawn } from 'child_process';
import { WebSocketServer } from 'ws';
import puppeteer from 'puppeteer-core';
import { makeSynth, CALIBRATE, SESSION_LOOP } from './fake-bridge.mjs';
const root = new URL('..', import.meta.url).pathname, sleep = ms => new Promise(r => setTimeout(r, ms)), G = +process.env.CALSTART_PORT || 8480, B = G + 1;
if ([8080, 8787, 3000].some(p => p >= G && p <= B)) { console.log("refusing: that port range holds the player's own game"); process.exit(2); }
const server = spawn('node', ['server/game.js'], { cwd: root, env: { ...process.env, PORT: G, PODDLE_DB: ':memory:' }, stdio: ['ignore', 'ignore', 'inherit'] });
const pods = {}, podOpts = { heading: 137, gyroNoise: 0.02, accNoise: 0.005, seed: 7 };
const rest = tag => { const p = pods[tag] ??= { t: 3580, socks: new Set() }; p.syn = makeSynth({ ...podOpts, script: [], t0: p.t + 0.02 }); return p; };
const go = tag => { const p = pods[tag] || rest(tag); p.syn = makeSynth({ ...podOpts, script: CALIBRATE, loop: SESSION_LOOP, t0: p.t + 0.02 }); };
const wss = new WebSocketServer({ port: B }); wss.on('connection', (ws, req) => { const p = pods[req.url.slice(1)] || rest(req.url.slice(1)); p.socks.add(ws); ws.on('close', () => p.socks.delete(ws)); ws.on('error', () => p.socks.delete(ws)); });
const start = performance.now(); let sent = 0;
const iv = setInterval(() => { const due = Math.floor((performance.now() - start) / 20);
  for (; sent <= due; sent++) for (const p of Object.values(pods)) { const m = p.syn.next(); delete m._t; p.t = m.t; const j = JSON.stringify(m); for (const ws of p.socks) if (ws.readyState === 1) ws.send(j); } }, 5);
const browsers = [], out = [], errs = [];
const ok = (c, what) => { out.push(c); console.log(c ? 'PASS' : 'FAIL', what); return c; };
const done = async () => { clearInterval(iv); for (const b of browsers) await b.close().catch(() => {}); server.kill(); wss.close(); const f = out.filter(c => !c).length;
  if (errs.length) console.log('page errors:\n  ' + errs.join('\n  ')); console.log(f || errs.length ? `CALSTART E2E FAIL (${f} failed, ${errs.length} page errors)` : `CALSTART E2E PASSED (${out.length} checks)`); process.exit(f || errs.length ? 1 : 0); };
for (const ev of ['uncaughtException', 'unhandledRejection']) process.on(ev, e => { console.log('CRASH', e); out.push(false); done(); });
const st = pg => pg.evaluate(() => { const t = id => document.getElementById(id), tx = id => t(id) ? t(id).textContent.trim() : null, s = window.__stats, d = document.body.dataset;
  return { screen: d.screen === 'hud' ? null : d.screen,      // null = the court itself
    phase: s.phase, room: s.room, calibrated: s.calibrated, hits: s.hits, ev: { ...s.events }, themSub: tx('sub-them'), toast: t('toast').classList.contains('on') ? tx('toast') : null,
    lview: [...document.querySelectorAll('#screen-lobby .lobby-view')].find(e => !e.hidden)?.dataset.view, share: (tx('share-code') || '').replace(/\s/g, '') }; });
async function until(pg, test, ms, what) { const end = Date.now() + ms; let s; do { s = await st(pg); if (test(s)) return s; await sleep(100); } while (Date.now() < end); const { ev, ...brief } = s; ok(false, `${what} (gave up after ${ms / 1000} s: ${JSON.stringify(brief)})`); return s; }
async function open(tag, name) { const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] }); browsers.push(b);
  const pg = (await b.pages())[0]; await pg.setViewport({ width: 1280, height: 720 }); pg.tag = tag; pg.on('pageerror', e => errs.push(`[${tag}] PAGEERROR ${e.message}`));
  await pg.evaluateOnNewDocument(name => { try { localStorage.setItem('poddle.name', name); localStorage.setItem('poddle.camPrimer', 'allow'); } catch { /* */ } }, name);
  await pg.goto(`http://localhost:${G}/?bridge=${B}/${tag}&game=${G}&uitest=1`); await sleep(1500);
  await pg.click('#btn-start'); await sleep(300); await pg.evaluate(() => document.fullscreenElement && document.exitFullscreen()); await until(pg, s => s.screen === 'lobby', 3000, `${tag} Play -> lobby`); return pg; }
const type = async (pg, text) => { for (const c of text) await pg.keyboard.type(c, { delay: 25 }); await sleep(150); };
const create = async pg => { await pg.click('#btn-courts'); await sleep(300); await pg.click('#btn-create'); await sleep(300); await pg.click('#seg [data-public="0"]'); await pg.click('#btn-create-go'); return (await until(pg, s => s.lview === 'share' && s.share.length === 4, 3000, 'share screen')).share; };
const onCourt = (pg, ms = 25000) => until(pg, s => s.phase === 'play' && !s.screen && s.calibrated, ms, `${pg.tag} on the court`);
await sleep(700);

// ---- 0. Ann plays a court of her own, so she has a calibration to keep ----
const a = await open('a', 'Ann'); await create(a); await a.click('#btn-share-go'); go('a'); await onCourt(a);
await a.keyboard.press('KeyQ'); await sleep(300); await a.keyboard.press('KeyQ'); let s = await until(a, s => s.screen === 'lobby' && !s.room, 4000, 'Ann leaves her first court');
ok(s.calibrated, 'Ann is back in the lobby with her calibration kept');

// ---- 1. her second court: she stays on the share screen while Ben comes in ready ----
const code = await create(a);
const b = await open('b', 'Ben'); await b.click('#btn-courts'); await sleep(300); await b.click('#code-boxes input'); await type(b, code); await b.keyboard.press('Enter'); go('b'); await onCourt(b);
await sleep(5000);                                               // the old count (3 s) and serve had long gone out by now
s = await st(b); const sa = await st(a);
ok(sa.lview === 'share' && sa.screen === 'lobby', `Ann is still on the share screen (${sa.screen} / ${sa.lview})`);
ok(!s.ev.countdown && !s.ev.serve, `nothing is counted or served while Ann is not on the court (countdown ${s.ev.countdown | 0}, serve ${s.ev.serve | 0})`);
ok(s.themSub === 'Calibrating', `Ben sees Ann as "${s.themSub}"`);

// ---- 2. Start: now the count, then the serve ----
await a.click('#btn-share-go'); await until(a, s => s.phase === 'play' && !s.screen, 4000, 'Ann goes straight to the court (calibration kept)');
s = await until(b, s => s.ev.serve, 8000, 'the serve after Ann is in'); ok(s.ev.countdown >= 3 && s.ev.serve, `counted in once both are on the court (countdown ${s.ev.countdown | 0}, serve ${s.ev.serve | 0})`);

// ---- 3. C mid-match: 'Calibrating' holds until her court is back, not until the 'All set' card ----
rest('a'); await a.keyboard.press('KeyC'); await until(b, s => s.themSub === 'Calibrating', 4000, 'Ben is told Ann calibrates again'); go('a');
let early = false; const end = Date.now() + 25000;
for (;;) { const [x, y] = await Promise.all([st(a), st(b)]); if (x.screen && y.themSub !== 'Calibrating') early = true; if (!x.screen && x.phase === 'play' && x.calibrated) break; if (Date.now() > end) { ok(false, 'Ann never got back to the court'); break; } await sleep(60); }
ok(!early, 'Ann stays "Calibrating" to Ben for as long as a set-up screen covers her court');
s = await until(b, s => s.themSub !== 'Calibrating', 3000, 'Ann is ready again once the court shows'); ok(s.themSub !== 'Calibrating', `and is ready again once it shows ("${s.themSub}")`);
await done();
