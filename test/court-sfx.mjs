// The court's sounds in the real scene (NOTES 259): test/scene-preview.html in headless Chrome, audio unlocked as a click would.
// Checks: the bank fills (every voice of web/courtsfx.js and the room) after the gesture; the shoe squeak fires on a hard plant or a cut out
// of a fast run and never on slow or jogging moves; a played rally (the fake server's own, both sides moving, hits, bounces, swings) runs
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
await page.evaluateOnNewDocument(() => { window.__sfxLog = []; window.__sfxVx = []; });
await page.goto(`http://127.0.0.1:${port}/test/scene-preview.html?side=0&opp=human&clean=1&t=2`, { waitUntil: 'load' });
await page.waitForFunction(() => document.title.startsWith('ready'), { timeout: 60000 });
await page.evaluate(() => window.__scene.unlockAudio());
await page.waitForFunction(() => { const s = window.__scene._dbg.sfx(); return s.bank && s.room && Object.values(s.bank).reduce((a, b) => a + b, 0) >= 30; }, { timeout: 20000 }).catch(() => {});
const st = await page.evaluate(() => window.__scene._dbg.sfx());
ok(st.ac === 'running', `the AudioContext runs after the gesture (${st.ac})`);
ok(st.room && st.bank && Object.values(st.bank).reduce((a, b) => a + b, 0) === 30, `the bank filled in idle: ${JSON.stringify(st.bank)}, room ${st.room}`);

// Drive side 0 (me) by hand: a list of [frames, vx m/s] legs; returns the squeaks fired and the drawn body's peak |vx|
const drive = legs => page.evaluate(legs => {
  const f = window.__fake, sc = window.__scene, pl = f.players[0], opp = f.players[1]; f.ball.live = false; window.__sfxLog.length = 0; window.__sfxVx.length = 0;
  let ms = (window.__ms = (window.__ms || 1e6) + 2000);
  for (let i = 0; i < 90; i++) { pl.y = 1; pl.z = 6.5; opp.x = 0; ms += 1000 / 60; f.push(ms); sc.render(ms); }      // settle: no squeak from the reset
  window.__sfxLog.length = 0; window.__sfxVx.length = 0;
  for (const [n, vx] of legs) for (let i = 0; i < n; i++) { pl.x = Math.max(-2.9, Math.min(2.9, pl.x + vx / 60)); pl.y = 1; pl.z = 6.5; pl.swingT = -1; ms += 1000 / 60; f.push(ms); sc.render(ms); }
  const mine = window.__sfxVx.filter(r => r[0] === 0);
  return { squeaks: window.__sfxLog.filter(r => r[1] === 0).length, peak: Math.max(...mine.map(r => Math.abs(r[1]))), log: window.__sfxLog.filter(r => r[1] === 0) };
}, legs);
const rep = (n, legs) => Array.from({ length: n }, () => legs).flat();
await page.evaluate(() => { window.__fake.players[0].x = -1.5; });
const slow = await drive(rep(3, [[180, 1.0], [180, -1.0]]));
ok(slow.squeaks === 0, `slow sweeps (1 m/s, 6 reversals; drawn peak ${slow.peak.toFixed(2)} m/s): no squeak (${slow.squeaks})`);
const jog = await drive(rep(4, [[80, 1.9], [80, -1.9]]));
ok(jog.squeaks === 0, `a jog (1.9 m/s, 8 reversals; drawn peak ${jog.peak.toFixed(2)} m/s): no squeak (${jog.squeaks})`);
await page.evaluate(() => { window.__fake.players[0].x = -2.5; });
const plant = await drive(rep(3, [[18, 5.5], [60, 0], [18, -5.5], [60, 0]]));
ok(plant.squeaks >= 5 && plant.squeaks <= 6, `sprint then plant (5.5 m/s for 1.65 m, 6 stops; drawn peak ${plant.peak.toFixed(2)} m/s): a squeak per plant (${plant.squeaks}: ${plant.log.map(r => r[2] + '@' + r[3]).join(' ')})`);
const cut = await drive(rep(4, [[30, 5], [30, -5]]));
ok(cut.squeaks >= 5 && cut.squeaks <= 8, `cuts (5 m/s, 8 reversals every 0.5 s; peak ${cut.peak.toFixed(2)}): one squeak per cut at most (${cut.squeaks})`);
const shuffle = await drive(rep(10, [[6, 4], [6, -4]]));
ok(shuffle.squeaks <= 3, `a jittery shuffle (4 m/s target flipping every 0.1 s: the drawn body barely moves, peak ${shuffle.peak.toFixed(2)}): rate-limited (${shuffle.squeaks})`);

// The fake server's rally, real time, both sides moving, hits/bounces/swings with the bank playing
await page.goto(`http://127.0.0.1:${port}/test/scene-preview.html?side=0&opp=bot&clean=1`, { waitUntil: 'load' });
await page.evaluate(() => { window.__scene.unlockAudio(); }); await sleep(12000);
const r = await page.evaluate(() => ({ s: window.__scene._dbg.sfx(), log: window.__sfxLog.slice(), t: document.title }));
const by = [0, 1].map(s => r.log.filter(x => x[1] === s).length);
console.log(`  rally 12 s: ${r.t}; squeaks me ${by[0]}, Matt ${by[1]}`);
ok(by[0] + by[1] <= 24, `the rally's squeaks stay occasional (${by[0] + by[1]} in 12 s, <= 2 a second)`);
ok(!errs.length, `no page errors (${errs.slice(0, 3).join(' | ') || 'none'})`);
console.log(fail ? `COURT SFX FAIL (${fail})` : 'COURT SFX PASS');
bye(fail ? 1 : 0);
