// The X on the phone (NOTES 59): held, it hangs the paddle up for good. The real pad.html in a real Chrome, the real
// server, and a plain socket standing in for the computer's tab (?pad=CODE). What is checked: the phone reaches the live
// view and is sending; a TAP does nothing; a HELD X stops the samples, closes the socket (the computer is told its paddle has
// gone), says 'Closing tab…' and closes the tab (NOTES 240). Twice: a tab with history behind it, which the browser will not let
// a page close (it goes back instead), and a tab opened by a script, as the phone home's Go opens it, which really closes.
// Usage: node test/padquit.test.mjs
import { spawn } from 'child_process'; import fs from 'fs';
import WebSocket from 'ws';
import puppeteer from 'puppeteer-core';
const G = +process.env.PADQUIT_PORT || 8482, root = new URL('..', import.meta.url).pathname, sleep = ms => new Promise(r => setTimeout(r, ms));
const CODE = 'QPAD24';
const server = spawn('node', ['server/game.js'], { cwd: root, env: { ...process.env, PORT: G, AUTOBOT: '0' }, stdio: ['ignore', 'ignore', 'inherit'] });
const CHROME = process.env.CHROME || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => fs.existsSync(p));
let fails = 0; const ok = (c, what) => { console.log((c ? '  ok   ' : '  FAIL ') + what); if (!c) fails++; return c; };
const errs = [];
let browser = null;
const done = async code => { if (browser) await browser.close().catch(() => {}); server.kill(); process.exit(code); };
setTimeout(() => { console.log('PAD QUIT FAIL (timeout)'); done(2); }, 120000);
for (const ev of ['uncaughtException', 'unhandledRejection']) process.on(ev, e => { console.log('PAD QUIT FAIL', e); done(2); });
await sleep(900);

// ---- the computer's tab: it only has to hold the code and listen for its phone coming and going
const host = new WebSocket(`ws://localhost:${G}/?pad=${CODE}`);
const padOn = [];                                   // every { type:'pad', on } the tab hears, in order
let samples = 0;
host.on('message', raw => { let m; try { m = JSON.parse(raw); } catch { return; }
  if (m.type === 'pad') padOn.push(m.on); if (m.type === 'm') samples++; });
await new Promise(r => host.on('open', r));

// ---- the phone
browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
const watch = pg => { pg.on('pageerror', e => errs.push('pageerror: ' + e.message)); pg.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); }); return pg; };
const phone = async pg => { await pg.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 }); return watch(pg); };

async function play(pg, how) {
console.log(`-- ${how}`);

// the phone has no sensors here: fire the two events a held phone would, at 60 Hz, until told to stop
await pg.evaluate(() => {
  window.__feed = true; let t = 0;
  window.__timer = setInterval(() => {
    t += 1 / 60;
    const a = 40 + Math.sin(t) * 3, b = 70 + Math.cos(t) * 2, c = 10 + Math.sin(t * 0.7) * 2;
    window.dispatchEvent(Object.assign(new Event('deviceorientation'), { alpha: a, beta: b, gamma: c }));
    if (window.__feed) window.dispatchEvent(Object.assign(new Event('devicemotion'), {
      rotationRate: { alpha: 2 + Math.sin(t * 3), beta: 1.5, gamma: 0.5 }, acceleration: { x: 0.01, y: 0.02, z: 0.01 }, interval: 16 }));
  }, 16);
});
await pg.click('#go');                              // Start
const view = () => pg.evaluate(() => document.body.dataset.view);
for (let i = 0; i < 40 && await view() !== 'live'; i++) await sleep(150);
ok(await view() === 'live', `the phone is the paddle: view ${await view()}`);
await sleep(700);
ok(padOn[padOn.length - 1] === true, `the computer sees a paddle: ${JSON.stringify(padOn)}`);
const sent1 = samples; await sleep(500);
ok(samples > sent1, `motion is reaching the computer (${samples - sent1} samples in half a second)`);

// ---- a TAP must not end the session: a gripped phone gets its screen pressed all rally long
const xy = await pg.evaluate(() => { const r = document.getElementById('btn-quit').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
await pg.mouse.move(xy.x, xy.y); await pg.mouse.down(); await sleep(200); await pg.mouse.up();
await sleep(300);
ok(await view() === 'live', `a tap on the X is ignored: view ${await view()}`);

// ---- HOLD it: the paddle hangs up, says so, and the tab goes
const before = samples, closed = new Promise(r => pg.once('close', () => r(true)));
await pg.mouse.down(); await sleep(1000); await pg.mouse.up();
for (let i = 0; i < 20 && await view() !== 'done'; i++) await sleep(50);
ok(await view() === 'done', `held: the phone shows the closing view (view ${await view()})`);
ok((await pg.$eval('[data-name="done"] h2', e => e.textContent)) === 'Closing tab…', 'it says "Closing tab…"');
ok(await pg.evaluate(() => !document.querySelector('[data-name="live"]').checkVisibility?.()), 'the paddle screen is gone');
const gone = await Promise.race([closed, sleep(2500).then(() => false)]);
ok(padOn[padOn.length - 1] === false, `the computer is told the paddle has gone: ${JSON.stringify(padOn)}`);
const after = samples; await sleep(600);
ok(samples === after, `nothing is sent any more (${samples - after} samples after the X, ${samples - before} in all since)`);
return gone;
}

// 1. A tab with a page behind it (puppeteer's about:blank): the browser refuses window.close(), so the page goes back instead
const pg1 = await phone(await browser.newPage());
await pg1.goto(`http://localhost:${G}/pad.html?k=${CODE}`, { waitUntil: 'networkidle2' });
const closed1 = await play(pg1, 'a tab with history: close refused');
ok(!closed1 && !pg1.url().includes('pad.html'), `refused: the tab leaves the paddle page instead (closed ${closed1}, now ${pg1.url()})`);
await pg1.close();

// 2. Opened by a script, as the phone home's Go does (ui.js): window.close() is allowed and the tab really closes
const home = watch(await browser.newPage());
await home.goto(`http://localhost:${G}/how-to-play.html`, { waitUntil: 'domcontentloaded' });
const opened = new Promise(r => browser.once('targetcreated', t => r(t.page())));
await home.evaluate(u => { window.open(u, '_blank'); }, `/pad.html?k=${CODE}`);
const pg2 = await phone(await opened); await pg2.waitForSelector('#go', { visible: true });
const closed2 = await play(pg2, 'a tab a script opened: it closes');
ok(closed2, 'the tab closed itself');

ok(errs.length === 0, `no page errors${errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''}`);
console.log(fails ? fails + ' FAILURES' : 'PAD QUIT TESTS PASSED');
done(fails ? 1 : 0);
