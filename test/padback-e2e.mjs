// The phone back (NOTES 243): the real game page against Matt, the real phone page (pad.html), the real server. The phone's page closes
// mid-game: the set-up screen comes back with the same QR and code, the court pauses, and a new phone page on that code goes straight
// back to the court. Back on that screen is the court, never out of it. Settings > Reconnect phone opens the same screen while the phone
// is still awake, and its samples do not bounce it straight back.   Usage: node test/padback-e2e.mjs   (PADBACK_PORT moves the port)
import { spawn } from 'child_process'; import fs from 'fs';
import puppeteer from 'puppeteer-core';
import { makeSynth, CALIBRATE, SESSION_LOOP } from './fake-bridge.mjs';
import { qrot } from '../web/motion.js';
const G = +process.env.PADBACK_PORT || 8640, root = new URL('..', import.meta.url).pathname, sleep = ms => new Promise(r => setTimeout(r, ms)), DEG = Math.PI / 180;
const server = spawn('node', ['server/game.js'], { cwd: root, env: { ...process.env, PORT: G }, stdio: ['ignore', 'ignore', 'inherit'] });
const CHROME = process.env.CHROME || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => fs.existsSync(p));
const browsers = [], launch = async () => { const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] }); browsers.push(b); return b; };
fs.mkdirSync(root + 'test/ui-shots', { recursive: true });
const errs = []; let fails = 0; const ok = (c, what) => { console.log(c ? 'PASS' : 'FAIL', what); if (!c) fails++; return c; };
const done = async code => { for (const b of browsers) await b.close().catch(() => {}); server.kill(); process.exit(code); };
setTimeout(() => { console.log('PADBACK E2E FAIL (timeout)'); done(2); }, 240000);
for (const ev of ['uncaughtException', 'unhandledRejection']) process.on(ev, e => { console.log('PADBACK E2E FAIL', e); done(2); });
async function until(f, ms, what) { const end = Date.now() + ms; let s; do { s = await f(); if (s) return s; await sleep(150); } while (Date.now() < end); ok(false, `${what} (gave up after ${ms / 1000} s)`); return null; }
const watch = (pg, tag) => { pg.on('pageerror', e => errs.push(`[${tag}] PAGEERROR ${e.message}`)); pg.on('console', m => { if (m.type() === 'error') errs.push(`[${tag}] ${m.text()}`); }); };

// the swung phone, as test/pad-e2e.mjs: angles and rates a browser would report
function toEuler(q) { const R = [qrot(q, [1, 0, 0]), qrot(q, [0, 1, 0]), qrot(q, [0, 0, 1])], m = (r, c) => R[c][r];
  return [Math.atan2(-m(0, 1), m(1, 1)) / DEG, Math.asin(Math.max(-1, Math.min(1, m(2, 1)))) / DEG, Math.atan2(-m(2, 0), m(2, 2)) / DEG]; }
function phoneTrack(seconds) { const syn = makeSynth({ heading: 40, grip: [0.2, 0.9, -0.3, 0.7], script: CALIBRATE, loop: SESSION_LOOP, rateHz: 60, gyroNoise: 0.01, accNoise: 0.004, seed: 11, t0: 0 }), out = [];
  for (let i = 0; i < seconds * 60; i++) { const s = syn.next(), e = toEuler(s.q); out.push([s._t, ...e.map(v => +v.toFixed(4)), ...s.r.map(v => +(v / DEG).toFixed(3)), ...s.a.map(v => +(v * 9.80665).toFixed(3))]); }
  return out; }
const playPhone = track => { const t0 = performance.now(); let k = 0;
  window.__player = setInterval(() => { const t = (performance.now() - t0) / 1000;
    for (; k < track.length && track[k][0] <= t; k++) { const [, al, be, ga, rx, ry, rz, ax, ay, az] = track[k];
      window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: al, beta: be, gamma: ga }));
      window.dispatchEvent(new DeviceMotionEvent('devicemotion', { rotationRate: { alpha: rz, beta: rx, gamma: ry }, acceleration: { x: ax, y: ay, z: az }, interval: 16 })); } }, 4); };
const game = pg => pg.evaluate(() => { const t = id => document.getElementById(id), s = window.__stats, vis = el => !!el && !el.hidden && el.getClientRects().length > 0;
  return { screen: document.body.dataset.screen, phase: s.phase, calibrated: s.calibrated, pad: !!s.pad, paused: document.body.dataset.paused === '1', pair: vis(t('pad-pair')), qr: !!t('pad-qr').querySelector('svg path, svg rect'),
    code: t('pad-code').textContent, back: (b => b && !b.hidden ? b.textContent.trim() : null)(document.querySelector('#screen-connect [data-back]')), toast: t('toast').classList.contains('on') ? t('toast').textContent.trim() : null }; });
async function newPhone(code, seconds = 60) { const pg = (await (await launch()).pages())[0]; await pg.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true }); watch(pg, 'phone');
  await pg.goto(`http://localhost:${G}/pad.html?k=${code}`); await sleep(600); await pg.evaluate(playPhone, phoneTrack(seconds)); await pg.click('#go'); return pg; }
const onCourt = (ms, what) => until(async () => { const v = await game(desk); return v.screen === 'hud' && v.calibrated && v.phase === 'play' ? v : null; }, ms, what);

await sleep(700);
const desk = (await (await launch()).pages())[0]; await desk.setViewport({ width: 1280, height: 720 }); watch(desk, 'desk');
await desk.evaluateOnNewDocument(() => { try { localStorage.setItem('poddle.name', 'Ada'); localStorage.setItem('poddle.camPrimer', 'allow'); } catch { /* */ }
  const WS = window.WebSocket; window.__wl = [];      // what the seat says about itself and hears about pauses
  window.WebSocket = class extends WS { constructor(u, p) { super(u, p); this.addEventListener('message', e => { if (/"type":"paused"/.test(e.data)) window.__wl.push('<' + e.data); }); }
    send(d) { if (/"type":"(status|pause)"/.test(d)) window.__wl.push(">" + d); return super.send(d); } }; });
await desk.goto(`http://localhost:${G}/?game=${G}&bridge=${G + 1}&cam=0&padtest=1`); await sleep(1500);
await desk.evaluate(() => document.getElementById('btn-start').click()); await sleep(400);      // a script's click: the menu's pointer layer can take puppeteer's await desk.evaluate(() => document.fullscreenElement && document.exitFullscreen());
await until(() => desk.evaluate(() => { const b = document.getElementById('btn-bot'); return !!b && b.getClientRects().length > 0; }), 5000, 'the lobby');
await desk.click('#btn-bot'); await until(() => desk.evaluate(() => { const b = document.getElementById('btn-bot-1'); return !!b && b.getClientRects().length > 0 && !b.disabled; }), 5000, 'the Play a bot view');
await sleep(400); await desk.screenshot({ path: `${root}test/ui-shots/padback-0-bot-1280x720.png` }); await desk.click('#btn-bot-1');
let s = await until(async () => { const v = await game(desk); return v.screen === 'connect' && v.qr ? v : null; }, 5000, 'Play a bot -> the set-up screen with a QR code');
const CODE = s.code.slice(2);

// 1. play, then the phone's page closes
let ph = await newPhone(CODE);
s = await onCourt(40000, 'calibrated on the phone and on the court'); ok(!!s, 'on the court against Matt with the phone');
s = await until(async () => (await desk.evaluate(() => window.__stats.hits)) >= 2 ? 1 : null, 60000, 'a rally is under way'); ok(!!s, 'the ball is in play (the pause is for a match under way, NOTES 241)');
await ph.close();
s = await until(async () => { const v = await game(desk); return v.screen === 'connect' ? v : null; }, 4000, 'the phone page closed -> the set-up screen');
ok(!!s && s.pair && s.qr && s.code === 'P-' + CODE, `the same QR and code come back (${s && s.code})`);
ok(!!s && s.back === 'Back' && !/signal lost/i.test(s.toast || ''), `its Back reads Back, no 'signal lost' toast (${s && s.back}, ${s && s.toast})`);
s = await until(async () => { const v = await game(desk); return v.paused ? v : null; }, 3000, 'Matt waits: the court is paused'); ok(!!s, 'against Matt the court pauses');
if (!s) console.log('NOTE ws:', await desk.evaluate(() => window.__wl.slice(-12).join(' ')));
await sleep(1200); await desk.screenshot({ path: `${root}test/ui-shots/padback-1-connect-1280x720.png` });

// 2. a new phone page on the same code: straight back to the court
ph = await newPhone(CODE);
s = await onCourt(30000, 'a new phone page on the same code -> the court'); ok(!!s, 'rescanned: back on the court');
s = await until(async () => { const v = await game(desk); return !v.paused ? v : null; }, 3000, 'the court plays on'); ok(!!s, 'and the pause is over');

// 3. Back on that screen is the court
await sleep(1200); await ph.close();
s = await until(async () => { const v = await game(desk); return v.screen === 'connect' ? v : null; }, 4000, 'gone again -> the set-up screen'); ok(!!s, 'the phone gone again: the set-up screen');
await desk.click('#screen-connect [data-back]');
s = await onCourt(3000, 'Back -> the court'); ok(!!s, 'Back returns to the court, still calibrated, not to the lobby');
await sleep(2500); s = await game(desk); ok(s.screen === 'hud', `and it does not come back by itself while the phone stays gone (${s.screen})`);

// 4. Settings > Reconnect phone, with the phone awake
ph = await newPhone(CODE); await sleep(2500);
s = await onCourt(20000, 'the phone back before the settings test'); 
const openSettings = async () => { for (let i = 0; i < 5; i++) { await desk.click('#btn-menu').catch(() => {}); for (let t = 0; t < 6; t++) { await sleep(150); if (await desk.evaluate(() => !document.getElementById('settings').hidden)) return true; } } return ok(false, 'settings open'); };
await openSettings();
const vis = await desk.evaluate(() => { const b = document.getElementById('btn-pair'); return !b.hidden && b.getClientRects().length > 0 ? b.textContent.trim() : null; });
ok(vis === 'Reconnect phone', `Settings has Reconnect phone (${vis})`);
await desk.screenshot({ path: `${root}test/ui-shots/padback-2-settings-1280x720.png` });
await desk.click('#btn-pair');
s = await until(async () => { const v = await game(desk); return v.screen === 'connect' && v.pair ? v : null; }, 3000, 'Reconnect phone -> the set-up screen'); ok(!!s, 'Reconnect phone opens the set-up screen with the QR');
await sleep(2000); s = await game(desk); ok(s.screen === 'connect', `the awake phone's samples do not bounce it back (${s.screen})`);
await newPhone(CODE);
s = await onCourt(30000, 'a phone page opened from the QR -> the court'); ok(!!s, 'a page opened from the QR takes the seat and the court is back');

const real = errs.filter(e => !/favicon/.test(e) && !e.includes(`localhost:${G + 1}`) && !/WebSocket/.test(e));
ok(!real.length, `no page errors ${real.join(' | ')}`);
console.log(fails ? `\nPADBACK E2E FAIL: ${fails}` : '\nPADBACK E2E PASS'); await done(fails ? 1 : 0);
