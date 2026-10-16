// The court's sounds in the real scene (NOTES 259): test/scene-preview.html in headless Chrome, audio unlocked as a click would.
// Checks: the bank fills (every voice of web/courtsfx.js and the jingles' hall; the court itself is dry, NOTES 263) after the gesture; no shoe squeak any more (NOTES 263), not even on a hard
// plant; a played rally (the fake server's own, both sides moving, hits, bounces, swings) runs
// with no page errors.   node test/court-sfx.mjs [port]  (8752 by default). Last line: COURT SFX PASS or COURT SFX FAIL.
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url)), port = +process.argv[2] || 8752, sleep = ms => new Promise(r => setTimeout(r, ms));
const http = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
let browser = null; const bye = async c => { if (browser) await browser.close().catch(() => {}); http.kill(); process.exit(c); };
setTimeout(() => { console.log('COURT SFX FAIL (timeout)'); bye(2); }, 150000);
await sleep(700);
browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new',
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
let fail = 0; const errs = [], ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fail++; return c; };
const page = await browser.newPage(); await page.setViewport({ width: 700, height: 620 });
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); }); page.on('pageerror', e => errs.push(String(e)));
await page.evaluateOnNewDocument(() => { window.__sfxLog = []; });
await page.goto(`http://127.0.0.1:${port}/test/scene-preview.html?side=0&opp=human&clean=1&t=2`, { waitUntil: 'load' });
await page.waitForFunction(() => document.title.startsWith('ready'), { timeout: 60000 });
await page.evaluate(() => window.__scene.unlockAudio());
await page.waitForFunction(() => { const s = window.__scene._dbg.sfx(); return s.bank && s.hall && Object.values(s.bank).reduce((a, b) => a + b, 0) >= 31; }, { timeout: 20000 }).catch(() => {});
const st = await page.evaluate(() => window.__scene._dbg.sfx());
ok(st.ac === 'running', `the AudioContext runs after the gesture (${st.ac})`);
ok(st.bank && Object.values(st.bank).reduce((a, b) => a + b, 0) === 31 && !('room' in st) && !('squeak' in st.bank), `the bank filled in idle, and no room on the court (NOTES 263): ${JSON.stringify(st.bank)}`);
ok(st.hall && st.jingles, `the jingles' hall IR and scores are in (NOTES 262): hall ${st.hall}, scores ${st.jingles}`);

// A sprint and a hard plant, by hand: no squeak voice plays (the bank has none, and nothing asks for one)
const plant = await page.evaluate(() => {
  const f = window.__fake, sc = window.__scene, pl = f.players[0]; f.ball.live = false; window.__sfxLog.length = 0; let ms = 1e6; pl.x = -2.5;
  for (const [n, vx] of [[18, 5.5], [60, 0], [18, -5.5], [60, 0], [30, 5], [30, -5]]) for (let i = 0; i < n; i++) { pl.x = Math.max(-2.9, Math.min(2.9, pl.x + vx / 60)); pl.y = 1; pl.z = 6.5; pl.swingT = -1; ms += 1000 / 60; f.push(ms); sc.render(ms); }
  return window.__sfxLog.filter(r => r[0] === 'squeak').length;
});
ok(plant === 0, `sprints, plants and cuts play no squeak (${plant})`);

// The fake server's rally, real time, both sides moving, hits/bounces/swings with the bank playing
await page.goto(`http://127.0.0.1:${port}/test/scene-preview.html?side=0&opp=bot&clean=1`, { waitUntil: 'load' });
await page.evaluate(() => { window.__scene.unlockAudio(); }); await sleep(12000);
const r = await page.evaluate(() => ({ s: window.__scene._dbg.sfx(), log: window.__sfxLog.slice(), t: document.title }));
console.log(`  rally 12 s: ${r.t}`);
ok(!r.log.some(x => x[0] === 'squeak'), 'the rally plays no squeak');
ok(!errs.length, `no page errors (${errs.slice(0, 3).join(' | ') || 'none'})`);
console.log(fail ? `COURT SFX FAIL (${fail})` : 'COURT SFX PASS');
bye(fail ? 1 : 0);
