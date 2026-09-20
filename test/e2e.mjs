// End-to-end: own game server + fake AirPod + static server + headless Chrome. Usage: node test/e2e.mjs [two]
import { spawn } from 'child_process';
import puppeteer from 'puppeteer-core';
import fs from 'fs';
const TWO = process.argv[2] === 'two';
const G = 8161, B = 8162, W = 8163, root = new URL('..', import.meta.url).pathname;
const procs = [
  spawn('node', ['server/game.js'], { cwd: root, env: { ...process.env, PORT: G } }),
  spawn('node', ['test/fake-bridge.mjs', B], { cwd: root }),
  spawn('python3', ['-m', 'http.server', W, '-d', 'web'], { cwd: root }),
];
const done = code => { for (const p of procs) p.kill(); process.exit(code); };
await new Promise(r => setTimeout(r, 1500));
fs.mkdirSync(root + 'test/shots', { recursive: true });
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new',
  args: ['--window-size=1440,900', '--use-gl=angle', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'], defaultViewport: { width: 1440, height: 900 } });
const errs = [];
async function open(name, query) {
  const page = await browser.newPage();
  page.on('console', m => { if (m.type() === 'error') errs.push(`[${name}] ${m.text()}`); });
  page.on('pageerror', e => errs.push(`[${name}] PAGEERROR ${e.message}`));
  await page.goto(`http://localhost:${W}/?bridge=${B}&game=${G}${query}`);
  return page;
}
const a = await open('p0', TWO ? '' : '&autobot=1');
const b = TWO ? await open('p1', '') : null;
await new Promise(r => setTimeout(r, 3000)); await a.screenshot({ path: root + 'test/shots/1-cal-hold.png' });
let ok = false;
for (let i = 0; i < 60; i++) {
  await new Promise(r => setTimeout(r, 1000));
  const st = await a.evaluate(() => window.__stats);
  if (i === 7) await a.screenshot({ path: root + 'test/shots/2-cal-tilt.png' });
  if (st.calibrated && !ok) { ok = true; console.log('calibrated at', i + 3, 's'); }
  if (st.myHits >= 3) break;
}
await a.screenshot({ path: root + 'test/shots/3-rally.png' });
for (let i = 0; i < 25; i++) { await new Promise(r => setTimeout(r, 120)); const sw = await a.evaluate(() => document.getElementById('pw').textContent); if (+sw > 12) { await a.screenshot({ path: root + 'test/shots/4-midswing.png' }); break; } }
if (b) await b.screenshot({ path: root + 'test/shots/5-side1.png' });
const st = await a.evaluate(() => window.__stats), st1 = b ? await b.evaluate(() => window.__stats) : null;
console.log('p0', JSON.stringify(st)); console.log('camera', JSON.stringify(await a.evaluate(() => window.__stats.cam))); if (st1) console.log('p1', JSON.stringify(st1));
console.log(errs.length ? 'CONSOLE ERRORS:\n' + errs.join('\n') : 'no console errors');
await browser.close();
// two-player mode uses blind scripted players in a throttled background tab, so only require a clean session there
const pass = TWO ? (st.calibrated && st1.calibrated && st1.events.state > 100 && !errs.length)
                 : (st.calibrated && st.hits >= 3 && st.myHits + st.whiffs >= 3 && st.paddlePath > 1 && !errs.length)  // the scripted player swings blind, so its swings mostly whiff;
console.log(pass ? 'E2E PASS' : 'E2E FAIL'); done(pass ? 0 : 1);
