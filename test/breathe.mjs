// The avatars breathe (NOTES 169): a calm in-and-out at rest, faster and deeper once winded, back to calm after a rest.
// Drives test/scene-preview.html in headless Chrome like stance.mjs, the fake rally held still, and reads the breath off
// the live scene graph. Screenshots (out and in, calm and winded) land in test/ui-shots/breathe/: look at them.
//   node test/breathe.mjs [port]      (8744 by default)
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url)), port = +process.argv[2] || 8744, shots = root + 'test/ui-shots/breathe/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(shots, { recursive: true });
const http = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
let browser = null; const bye = async c => { if (browser) await browser.close().catch(() => {}); http.kill(); process.exit(c); };
setTimeout(() => { console.log('BREATHE FAIL (timeout)'); bye(2); }, 120000);
for (const ev of ['uncaughtException', 'unhandledRejection']) process.on(ev, e => { console.log('BREATHE FAIL', e); bye(2); });
await sleep(700);
browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new',
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
let fail = 0; const errs = [];
const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fail++; return c; };
const page = await browser.newPage(); await page.setViewport({ width: 700, height: 620 });
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); }); page.on('pageerror', e => errs.push(String(e)));
await page.goto(`http://127.0.0.1:${port}/test/scene-preview.html?spectate=1&opp=human&clean=1&t=2&game=${port}&bridge=${port}`, { waitUntil: 'load' });
await page.waitForFunction(() => document.title.startsWith('ready'), { timeout: 60000 });

// Hold side 0 standing at x0 (or running at vx) for `frames` frames; returns the head's world height and the chest's swell
// every frame, and the puff at the end. `shoot`: stop on the frame the breath is fullest ('in') or emptiest ('out').
const run = o => page.evaluate(({ vx = 0, frames, stop }) => {
  const f = window.__fake, sc = window.__scene, pd = sc._dbg.pads[0], pl = f.players[0], u = pd.avatar.userData, v = u.head.position.clone();
  f.ball.live = false; let ms = (window.__ms = (window.__ms || 1e6) + 1000), x = 0, prev = null; const head = [], chest = [];
  for (let i = 0; i < frames; i++) {
    x += vx / 60; if (Math.abs(x) > 1.5) vx = -vx;
    pl.y = 1.0; pl.x = x; pl.z = 6.5; pl.swingT = -1; ms += 1000 / 60; f.push(ms); sc.render(ms);
    u.head.getWorldPosition(v); head.push(v.y); chest.push(u.body.scale.z);
    if (stop && i > frames / 2 && prev !== null && (stop === 'in' ? chest.at(-1) < prev : chest.at(-1) > prev)) break;      // just past the turn
    prev = chest.at(-1);
  }
  return { head, chest, puff: pd.stance.puff };
}, o);
const shoot = async name => { await page.evaluate(() => { const d = window.__scene._dbg;      // a close look at side 0's chest and head
    d.camera.position.set(1.2, 1.9, 9.2); d.camera.lookAt(-0.5, 1.55, 6.8); d.camera.updateProjectionMatrix(); d.renderer.render(d.scene, d.camera); });
  await page.screenshot({ path: shots + name + '.png' }); };
const range = a => Math.max(...a) - Math.min(...a);
const turns = a => { let n = 0; for (let i = 2; i < a.length; i++) if ((a[i] - a[i - 1]) * (a[i - 1] - a[i - 2]) < 0) n++; return n; };

const calm = await run({ frames: 600 });                     // 10 s standing
ok(range(calm.head) > 0.025 && range(calm.head) < 0.06, `standing, the head rides the breath up and down (${(range(calm.head) * 100).toFixed(1)} cm)`);
ok(range(calm.chest) > 0.03, `and the chest swells (${(range(calm.chest) * 100).toFixed(1)}%)`);
const calmTurns = turns(calm.chest);
ok(calmTurns >= 4 && calmTurns <= 8, `a calm breath, about one every 3 s (${calmTurns / 2} breaths in 10 s)`);
ok(calm.puff === 0, 'not winded after standing (' + calm.puff + ')');
await run({ frames: 300, stop: 'out' }); await shoot('1-calm-out');
await run({ frames: 300, stop: 'in' }); await shoot('2-calm-in');

await run({ vx: 3.2, frames: 240 });                         // 4 s of sprinting side to side
const puffed = await run({ frames: 300 });                   // the first 5 s after it
ok(puffed.puff > 0.2, `a sprint winds it (puff ${puffed.puff.toFixed(2)})`);
ok(range(puffed.head) > range(calm.head) * 1.4, `winded, it breathes deeper (${(range(puffed.head) * 100).toFixed(1)} vs ${(range(calm.head) * 100).toFixed(1)} cm)`);
ok(turns(puffed.chest) / 300 > calmTurns / 600 * 1.3, `and faster (${turns(puffed.chest) / 2} breaths in 5 s vs ${calmTurns / 2} in 10 s)`);
await run({ vx: 3.2, frames: 240 }); await run({ frames: 120, stop: 'in' }); await shoot('3-winded-in');
const rested = await run({ frames: 720 });                   // 12 s of standing
ok(rested.puff < 0.02, `and it gets its wind back after a rest (puff ${rested.puff.toFixed(3)})`);

ok(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''));
console.log(fail ? `BREATHE FAIL ${fail}` : 'BREATHE OK'); bye(fail ? 1 : 0);
