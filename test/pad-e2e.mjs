// A phone as the paddle, end to end (NOTES 34): the real game page in one Chrome, the real phone page (pad.html) in another,
// the real server between them. The "phone" has no sensors, so a script in its page fires the deviceorientation and
// devicemotion events a swung phone would, from fake-bridge's synthesiser, with rotationRate named the unusual way (z,x,y)
// so the naming has to be found. Nothing else is faked: the code is read off the set-up screen, the phone page is opened
// with it, and the player calibrates and rallies with Matt.   Usage: node test/pad-e2e.mjs   (PAD_E2E_PORT moves the port)
import { spawn } from 'child_process'; import fs from 'fs';
import puppeteer from 'puppeteer-core';
import { makeSynth, CALIBRATE, SESSION_LOOP } from './fake-bridge.mjs';
import { qrot } from '../web/motion.js';
const G = +process.env.PAD_E2E_PORT || 8470, root = new URL('..', import.meta.url).pathname, sleep = ms => new Promise(r => setTimeout(r, ms)), DEG = Math.PI / 180;
const server = spawn('node', ['server/game.js'], { cwd: root, env: { ...process.env, PORT: G }, stdio: ['ignore', 'ignore', 'inherit'] });
const CHROME = process.env.CHROME || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => fs.existsSync(p));
const browsers = [], launch = async () => { const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] }); browsers.push(b); return b; };
fs.mkdirSync(root + 'test/ui-shots', { recursive: true });
const errs = []; let fails = 0; const ok = (c, what) => { console.log(c ? 'PASS' : 'FAIL', what); if (!c) fails++; return c; };
const done = async code => { for (const b of browsers) await b.close().catch(() => {}); server.kill(); process.exit(code); };
setTimeout(() => { console.log('PAD E2E FAIL (timeout)'); done(2); }, 240000);
for (const ev of ['uncaughtException', 'unhandledRejection']) process.on(ev, e => { console.log('PAD E2E FAIL', e); done(2); });
async function until(f, ms, what) { const end = Date.now() + ms; let s; do { s = await f(); if (s) return s; await sleep(150); } while (Date.now() < end); ok(false, `${what} (gave up after ${ms / 1000} s)`); return null; }
const watch = (pg, tag) => { pg.on('pageerror', e => errs.push(`[${tag}] PAGEERROR ${e.message}`)); pg.on('response', r => { if (r.status() >= 400) errs.push(`[${tag}] ${r.status()} ${r.url()}`); }); pg.on('console', m => { if (m.type() === 'error') errs.push(`[${tag}] ${m.text()}`); }); };

// ---- the swung phone: 75 s of samples at 60 Hz, as the angles and rates a browser would report
function toEuler(q) { const R = [qrot(q, [1, 0, 0]), qrot(q, [0, 1, 0]), qrot(q, [0, 0, 1])], m = (r, c) => R[c][r];
  return [Math.atan2(-m(0, 1), m(1, 1)) / DEG, Math.asin(Math.max(-1, Math.min(1, m(2, 1)))) / DEG, Math.atan2(-m(2, 0), m(2, 2)) / DEG]; }
const PICKUP = [{ T: 0.4, axis: [1, 0, 0], deg: 50 }, { T: 0.4, axis: [0, 1, 0], deg: -60 }, { T: 0.4, axis: [0, 0, 1], deg: 70 }, { T: 0.4, axis: [0, 0, 1], deg: -70 }, { T: 0.4, axis: [0, 1, 0], deg: 60 }, { T: 0.4, axis: [1, 0, 0], deg: -50 }];   // picked up and turned over on the way to the grip
function phoneTrack(seconds) { const syn = makeSynth({ heading: 40, grip: [0.2, 0.9, -0.3, 0.7], script: [...PICKUP, ...CALIBRATE], loop: SESSION_LOOP, rateHz: 60, gyroNoise: 0.01, accNoise: 0.004, seed: 11, t0: 0 }), out = [];
  for (let i = 0; i < seconds * 60; i++) { const s = syn.next(), e = toEuler(s.q); out.push([s._t, ...e.map(v => +v.toFixed(4)), ...s.r.map(v => +(v / DEG).toFixed(3)), ...s.a.map(v => +(v * 9.80665).toFixed(3))]); }
  return out; }
const playPhone = track => {                        // runs in the phone page: fire each sample's two events when its time comes
  const t0 = performance.now(); let k = 0; window.__played = 0;
  window.__player = setInterval(() => { const t = (performance.now() - t0) / 1000;
    for (; k < track.length && track[k][0] <= t; k++) { const [, al, be, ga, rx, ry, rz, ax, ay, az] = track[k];
      window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: al, beta: be, gamma: ga }));
      window.dispatchEvent(new DeviceMotionEvent('devicemotion', { rotationRate: { alpha: rz, beta: rx, gamma: ry }, acceleration: { x: ax, y: ay, z: az }, interval: 16 })); window.__played++; } }, 4); };
const game = pg => pg.evaluate(() => { const t = id => document.getElementById(id), s = window.__stats, vis = el => !!el && !el.hidden && el.getClientRects().length > 0;
  return { screen: document.body.dataset.screen, phase: s.phase, calibrated: s.calibrated, swings: s.swings, myHits: s.myHits, hits: s.hits, pad: !!s.pad, errors: s.errors, note: t('title-note').textContent, title: t('connect-title').textContent,
    pair: vis(t('pad-pair')), qr: !!t('pad-qr').querySelector('svg path, svg rect'), code: t('pad-code').textContent, foot: t('connect-foot-text').textContent, swap: vis(t('btn-paddle-swap')) ? t('btn-paddle-swap').textContent : null,
    row: t('row-airpod-name').textContent + ': ' + t('row-airpod-text').textContent, lamp: t('set-airpod').className, lead: t('calp').textContent, toast: t('toast').classList.contains('on') ? t('toast').textContent.trim() : null }; });
const phone = pg => pg.evaluate(() => { const p = window.__pad, t = id => document.getElementById(id); return { view: p.view, host: p.host, open: p.open, sent: p.sent, naming: p.naming, head: t('live-h').textContent, link: document.body.dataset.link, played: window.__played || 0 }; });

await sleep(700);
// ---- 0. a first-time visitor's page never reaches for the AirPod helper (that is Chrome's local-network prompt)
{ const fresh = (await (await launch()).pages())[0]; const tries = []; fresh.on('console', m => { if (m.text().includes(`localhost:${G + 1}`)) tries.push(m.text()); });
  await fresh.goto(`http://localhost:${G}/?game=${G}&bridge=${G + 1}&cam=0&padtest=1`); await sleep(2500);
  ok(!tries.length, `a first-time visitor's page does not try the helper (${tries.length} tries)`); }
// ---- 1. the game page (a returning player: a name is saved): no helper answers; it offers the phone
const desk = (await (await launch()).pages())[0]; await desk.setViewport({ width: 1280, height: 720 }); watch(desk, 'desk');
await desk.evaluateOnNewDocument(() => { try { localStorage.setItem('poddle.name', 'Ada'); } catch { /* */ } });
await desk.goto(`http://localhost:${G}/?game=${G}&bridge=${G + 1}&cam=0&padtest=1`); await sleep(1500);
let s = await game(desk); ok(/Nothing to install/.test(s.note), `title says so: "${s.note}"`);
await desk.click('#btn-start'); await sleep(400); await desk.evaluate(() => document.fullscreenElement && document.exitFullscreen());
await desk.click('#btn-bot'); await sleep(300); await desk.click('#btn-bot-0');
s = await until(async () => { const v = await game(desk); return v.screen === 'connect' && v.qr ? v : null; }, 5000, 'Play a bot -> the set-up screen with a QR code');
ok(s && s.pair && s.title === 'Grab your paddle' && /^[A-HJ-NP-Z2-9]{6}$/.test(s.code), `set-up screen: "${s && s.title}", code ${s && s.code}`);
ok(s && /^Phone: Scan the code/.test(s.row) && s.foot === 'Nothing to install.' && s.swap === 'Playing with an AirPod?', `row "${s && s.row}", footer "${s && s.foot}" + "${s && s.swap}"`);
await sleep(400); await desk.screenshot({ path: `${root}test/ui-shots/pad-1-setup-1280x720.png` });
const CODE = s.code;
await desk.click('#btn-paddle-swap'); await sleep(200); s = await game(desk);
ok(!s.pair && s.title === 'Connect your AirPod' && /^AirPod: Take one AirPod/.test(s.row) && s.swap === 'Use your phone instead', `the AirPod way is one press away: "${s.title}", "${s.row}", "${s.swap}"`);
await desk.screenshot({ path: `${root}test/ui-shots/pad-1b-setup-airpod-1280x720.png` });
await desk.click('#btn-paddle-swap'); await sleep(200); s = await game(desk); ok(s.pair && s.title === 'Grab your paddle', 'and back to the phone');

// ---- 2. the phone: opens the link in the QR, taps Start
const ph = (await (await launch()).pages())[0]; await ph.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }); watch(ph, 'phone');
await ph.goto(`http://localhost:${G}/pad?k=${CODE}`); await sleep(800);
let p = await phone(ph); ok(p.view === 'start' && /pad\.html\?k=/.test(ph.url()), `poddleball.com/pad?k=CODE lands on the start view (${p.view}, ${ph.url().replace(/.*\//, '')})`);
await ph.screenshot({ path: `${root}test/ui-shots/pad-2-phone-start-390x844.png` });
await ph.evaluate(playPhone, phoneTrack(75)); await ph.click('#go');
p = await until(async () => { const v = await phone(ph); return v.view === 'live' && v.host && v.sent > 30 ? v : null; }, 5000, 'phone goes live and is sending');
ok(p && p.link === 'on', `phone: ${JSON.stringify(p)}`);

// ---- 3. the game calibrates on the phone's motion and plays
s = await until(async () => { const v = await game(desk); return v.screen === 'calibrate' ? v : null; }, 5000, 'the game starts calibrating by itself');
ok(s && /Hold the phone/.test(s.lead), `calibration speaks of the phone: "${s && s.lead}"`);
p = await phone(ph); ok(/Follow the steps/.test(p.head), `the phone says "${p.head}"`);
await sleep(1500); await desk.screenshot({ path: `${root}test/ui-shots/pad-3-calibrate-1280x720.png` });
s = await until(async () => { const v = await game(desk); return v.calibrated && v.phase === 'play' ? v : null; }, 25000, 'calibrated on phone samples');
s = await until(async () => { const v = await game(desk); return v.swings >= 3 && v.myHits >= 1 ? v : null; }, 60000, 'swings are called and one connects');
ok(s, `playing: ${s && s.swings} swings, ${s && s.myHits} of my hits, ${s && s.hits} hits in all`);
p = await phone(ph); ok(p.naming === 'zxy' && p.head === 'Swing!', `phone found the z,x,y naming (${p.naming}) and says "${p.head}"`);
await ph.screenshot({ path: `${root}test/ui-shots/pad-4-phone-live-390x844.png` }); await desk.screenshot({ path: `${root}test/ui-shots/pad-4-court-1280x720.png` });

// ---- 4. the phone's buttons, and the phone going away and coming back
await ph.click('#btn-cal'); await sleep(500); ok((await game(desk)).screen !== 'calibrate', 'a brush against the button does nothing'); await ph.click('#btn-cal', { delay: 900 }); s = await until(async () => { const v = await game(desk); return v.screen === 'calibrate' ? v : null; }, 3000, 'Calibrate again on the phone restarts calibration');
ok(!!s, 'Calibrate again, pressed and held on the phone, works');
await ph.close(); s = await until(async () => { const v = await game(desk); return !v.pad && /is-bad/.test(v.lamp) ? v : null; }, 5000, 'phone page closed -> the game knows');
ok(!!s, 'a closed phone page shows as a lost paddle');
const ph2 = (await (await launch()).pages())[0]; await ph2.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true }); watch(ph2, 'phone2');
await ph2.goto(`http://localhost:${G}/pad.html?k=${CODE}`); await sleep(600); await ph2.evaluate(playPhone, phoneTrack(40)); await ph2.click('#go');
s = await until(async () => { const v = await game(desk); return v.calibrated && v.phase === 'play' ? v : null; }, 30000, 'the phone comes back on a fresh page (its clock starts over) and calibrates again');
ok(!!s, 'a reopened phone page calibrates and plays again');

// ---- 5. a wrong code, and no sensors
const ph3 = (await (await launch()).pages())[0]; await ph3.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true }); watch(ph3, 'phone3');
await ph3.goto(`http://localhost:${G}/pad.html`); await sleep(500); p = await phone(ph3); ok(p.view === 'code', 'no code in the link: the phone asks for it');
await ph3.screenshot({ path: `${root}test/ui-shots/pad-5-phone-code-390x844.png` });
await ph3.type('#code-in', 'zz22zz'); await ph3.click('#code-go'); await sleep(300); p = await phone(ph3); ok(p.view === 'start', 'a typed code moves on to Start');
await ph3.click('#go'); p = await until(async () => { const v = await phone(ph3); return v.view === 'nomotion' ? v : null; }, 5000, 'a device with no motion sensors is told so');
ok(!!p, 'no sensors: says so instead of waiting for ever');
await ph3.screenshot({ path: `${root}test/ui-shots/pad-5-phone-nomotion-390x844.png` });

const real = errs.filter(e => !/favicon/.test(e) && !e.includes(`localhost:${G + 1}`));      // the AirPod way was tried on purpose, and no helper answers there ok(!real.length, `no page errors ${real.join(' | ')}`);
console.log(fails ? `\nPAD E2E FAIL: ${fails}` : '\nPAD E2E PASS'); await done(fails ? 1 : 0);
