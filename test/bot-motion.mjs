// Matt moves like a player, not a paddle on a rail (NOTES 174-176). Drives test/scene-preview.html (spectate: side 1 is the bot) in
// headless Chrome with the fake rally held still, and replays runBot's own motion by hand: a 0.3 s read, then x at Matt's foot
// speed and y at 4 m/s straight to the contact point, the canned swing timed onto it, then the drift home. Reads the body off the
// live scene graph. Screenshots land in test/ui-shots/bot-motion/ (close and from the far baseline): LOOK at them.
//   node test/bot-motion.mjs [port]      (8750 by default)
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url)), port = +process.argv[2] || 8750, shots = root + 'test/ui-shots/bot-motion/';
const tag = process.env.SHOT_TAG || '';
const sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(shots, { recursive: true });
const http = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
let browser = null; const bye = async c => { if (browser) await browser.close().catch(() => {}); http.kill(); process.exit(c); };
setTimeout(() => { console.log('BOTMOTION FAIL (timeout)'); bye(2); }, 150000);
for (const ev of ['uncaughtException', 'unhandledRejection']) process.on(ev, e => { console.log('BOTMOTION FAIL', e); bye(2); });
await sleep(700);
browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new',
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
let fail = 0; const errs = [];
const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fail++; return c; };
const page = await browser.newPage(); await page.setViewport({ width: 760, height: 620 });
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); }); page.on('pageerror', e => errs.push(String(e)));
await page.goto(`http://127.0.0.1:${port}/test/scene-preview.html?spectate=1&clean=1&t=2&game=${port}&bridge=${port}`, { waitUntil: 'load' });
await page.waitForFunction(() => document.title.startsWith('ready'), { timeout: 60000 });

// One incoming ball for side 1 (z = -6.5), as runBot plays it. ys: a fixed contact height, or a JS waveform of t (frames at 60 Hz).
// Returns the head's world height at contact and over the move, the feet's heights while running, and the stance it ended in.
const play = o => page.evaluate(({ cy = 1.0, dx = 0, foot = 3.3, ys = null, frames = 150, swingAt = 0.9, stopAt = null, mirror = 1 }) => {
  const f = window.__fake, sc = window.__scene, pd = sc._dbg.pads[1], pl = f.players[1], u = pd.avatar.userData;
  f.ball.live = false; const v = u.head.position.clone(), wave = ys ? new Function('t', 'return ' + ys) : null;
  let ms = (window.__ms = (window.__ms || 1e6) + 1000), x = 0, y = 1.0;
  const step = () => { pl.z = -6.5; ms += 1000 / 60; f.push(ms); sc.render(ms); };
  for (let i = 0; i < 120; i++) { pl.x = 0; pl.y = 1.0; pl.swingT = -1; step(); }       // 2 s at the ready: everything settles
  const head = [], feet = [[], []], taunt = [], twist = []; let atContact = null, waiting = null;
  for (let i = 0; i < frames; i++) {
    const t = i / 60;
    if (wave) y = wave(t);
    else if (t >= 0.3 && t < swingAt + 0.2) { x += Math.max(-foot / 60, Math.min(foot / 60, dx - x)); y += Math.max(-4 / 60, Math.min(4 / 60, cy - y)); }   // runBot: read, then straight there
    else if (t >= swingAt + 0.2) { x += (0 - x) * 2 / 60; y += (1.0 - y) * 2 / 60; }      // the ball is gone: drift home
    pl.x = x; pl.y = y;
    if (!wave && Math.abs(t - swingAt) < 1e-6 + 0.5 / 60) { pd.swingT = 0; pd.mirror = mirror; pd.over = Math.max(0, Math.min(1, (Math.max(pd.pos.y, pd.tgt.y) - 1.55) / 0.45)); }      // as startSwing() sets them
    step(); u.head.getWorldPosition(v); head.push(v.y); taunt.push(pd.stance.taunt); twist.push(u.upper.rotation.y);
    for (let k = 0; k < 2; k++) { const w = u.feet[k].position.clone(); u.feet[k].getWorldPosition(w); feet[k].push(w.y); }
    if (!wave && waiting === null && t >= swingAt - 0.1) waiting = { drawn: pd.group.position.y, paddleY: pd.pos.y };      // the paddle as drawn while he waits for the ball (NOTES 175)
    if (!wave && atContact === null && t >= swingAt + 0.2) atContact = { head: v.y, paddleY: pd.pos.y, drawn: pd.group.position.y };
    if (stopAt !== null && t >= stopAt) break;
  }
  return { head, feet, atContact, waiting, twist, headYaw: u.head.rotation.y + u.upper.rotation.y, peakTaunt: Math.max(...taunt), posY: pd.pos.y };
}, o);
const shoot = async name => {
  for (const [k, c] of [['close', [4.6, 1.7, -3.2, 1.2, 1.35, -7.2]], ['far', [1.0, 2.3, 7.6, 0.8, 1.3, -7]]]) {
    await page.evaluate(c => { const d = window.__scene._dbg; d.camera.position.set(c[0], c[1], c[2]); d.camera.lookAt(c[3], c[4], c[5]); d.camera.updateProjectionMatrix(); d.renderer.render(d.scene, d.camera); }, c);
    await page.screenshot({ path: `${shots}${tag}${name}-${k}.png` });
  }
};

const stand = await play({ cy: 1.0, frames: 60 }); const standHead = stand.head.at(-1);
console.log(`standing head ${standHead.toFixed(3)}`);
// ---------- 1. a lob: the paddle goes up to 2.2 m, the body does not ----------
const lob = await play({ cy: 2.2, dx: 1.2, stopAt: 1.1 }); await shoot('1-lob-contact');
console.log(`lob: paddle ${lob.atContact.paddleY.toFixed(2)} m, head ${lob.atContact.head.toFixed(3)}`);
ok(lob.atContact.paddleY > 1.9, `the paddle really is up for the lob (${lob.atContact.paddleY.toFixed(2)} m)`);
ok(lob.waiting.drawn < 1.4, `waiting for the lob, his paddle stays down at his side (drawn at ${lob.waiting.drawn.toFixed(2)} m while the server's is at ${lob.waiting.paddleY.toFixed(2)})`);
ok(lob.atContact.drawn > lob.atContact.paddleY - 0.15, `and it is up where the ball is by the hit (drawn ${lob.atContact.drawn.toFixed(2)} m, server ${lob.atContact.paddleY.toFixed(2)})`);
ok(lob.atContact.head - standHead < 0.15, `meeting a lob, Matt stays his own height: no stretching tall (head +${((lob.atContact.head - standHead) * 100).toFixed(1)} cm)`);
// ---------- 1b. he swings from the waist: a forehand coils one way, a backhand the other ----------
const fh = await play({ cy: 1.0, dx: 0.4, swingAt: 0.6, stopAt: 1.5 }), bh = await play({ cy: 1.0, dx: -0.4, swingAt: 0.6, stopAt: 1.5, mirror: -1 });
const coil = a => a.slice(36, 50).reduce((m, x) => Math.abs(x) > Math.abs(m) ? x : m, 0), thru = a => a.slice(50, 60).reduce((m, x) => Math.abs(x) > Math.abs(m) ? x : m, 0);
ok(Math.abs(coil(fh.twist)) > 0.25 && Math.sign(coil(fh.twist)) !== Math.sign(thru(fh.twist)), `forehand: the shoulders coil (${coil(fh.twist).toFixed(2)} rad) and come through the other way (${thru(fh.twist).toFixed(2)})`);
ok(Math.sign(coil(bh.twist)) === -Math.sign(coil(fh.twist)), `backhand: the coil is mirrored (${coil(bh.twist).toFixed(2)} vs ${coil(fh.twist).toFixed(2)})`);
ok(Math.abs(fh.twist.at(-1)) < 0.05, `square again after the swing (${fh.twist.at(-1).toFixed(3)})`);
// ---------- 2. a low ball still bends the knees ----------
const low = await play({ cy: 0.45, dx: -1.0, stopAt: 1.1 }); await shoot('2-low-contact');
ok(standHead - low.atContact.head > 0.2, `a low ball: he bends down to it (head -${((standHead - low.atContact.head) * 100).toFixed(1)} cm)`);
// ---------- 3. Matt never taunts, however his paddle bobs ----------
const bob = await play({ ys: '1.0 - 0.6 * (0.5 - 0.5 * Math.cos(t * 2 * Math.PI * 2.6))', frames: 110 });
ok(bob.peakTaunt === 0, `three quick low balls in a row are not a taunt (peak ${bob.peakTaunt})`);
// ---------- 4. running, the feet step in turn instead of sliding ----------
const run = await play({ cy: 1.0, dx: 3.0, foot: 3.3, swingAt: 1.6, frames: 130, stopAt: 1.2 }); await shoot('3-running');
const lifts = run.feet.map(a => a.slice(25, 72)), up = lifts.map(a => a.filter(y => y > Math.min(...a) + 0.025).length);
let alt = 0; for (let i = 0; i < lifts[0].length; i++) if ((lifts[0][i] - lifts[1][i]) * ((lifts[0][i - 1] ?? 0) - (lifts[1][i - 1] ?? 0)) < 0) alt++;
ok(up[0] > 3 && up[1] > 3, `both feet leave the court while he runs (${up[0]} / ${up[1]} frames up)`);
ok(alt >= 2, `and in turn, left then right (${alt} handovers in 0.8 s)`);

// ---------- 5. his paddle gets going and pulls up like a hand, and is on the ball by contact ----------
const hand = ({ dx, swingAt }) => page.evaluate(({ dx, swingAt }) => {
  const f = window.__fake, sc = window.__scene, pd = sc._dbg.pads[1], pl = f.players[1]; f.ball.live = false;
  let ms = (window.__ms = (window.__ms || 1e6) + 1000), x = 0;
  for (let i = 0; i < 120; i++) { pl.x = 0; pl.y = 1; pl.z = -6.5; pl.swingT = -1; ms += 1000 / 60; f.push(ms); sc.render(ms); }
  let px = pd.dr ? pd.dr.x : 0, pv = 0, gap = null, amax = 0;
  for (let i = 0; i < 100; i++) { const t = i / 60; if (t >= 0.3 && t < swingAt + 0.2) x = Math.min(dx, x + 3.3 / 60); pl.x = x; pl.y = 1; pl.z = -6.5;
    if (Math.abs(t - swingAt) < 0.5 / 60) { pd.swingT = 0; pd.mirror = 1; pd.over = 0; }
    ms += 1000 / 60; f.push(ms); sc.render(ms);
    const gx = pd.dr ? pd.dr.x : pd.pos.x, v = (gx - px) * 60; if (t > 0.25 && t < swingAt) amax = Math.max(amax, Math.abs((v - pv) * 60)); px = gx; pv = v;
    if (gap === null && t >= swingAt + 0.2) gap = Math.abs(gx - pd.pos.x); }
  return { gap, amax };
}, { dx, swingAt });
const early = await hand({ dx: 1.6, swingAt: 1.2 }), late = await hand({ dx: 3.0, swingAt: 0.9 });
ok(early.amax < 20, `setting off, the paddle speeds up like a hand, not a block on a rail (peak ${early.amax.toFixed(0)} m/s^2; it was ~52)`);
ok(early.gap < 0.02, `arriving in time, it is on the server's paddle at contact (${(early.gap * 100).toFixed(1)} cm)`);
ok(late.gap < 0.15, `still running at contact, it is within 15 cm (${(late.gap * 100).toFixed(1)} cm; the hit's reach covers 40)`);

ok(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''));
console.log(fail ? `BOTMOTION FAIL ${fail}` : 'BOTMOTION OK'); bye(fail ? 1 : 0);
