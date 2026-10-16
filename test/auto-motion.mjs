// Auto move (Settings > Move = Auto) drawn as smoothly as Matt (NOTES 257). Drives test/scene-preview.html in headless Chrome: side 0
// is the local player in Auto, side 1 is Matt. A fake server steps both the way server/game.js does (runAuto: straight to the contact
// point at 5.5 m/s, y at 4 m/s, home at 2.5 m/s; runBot: a 0.3 s read, then at Auto's own 5.5 m/s, so the two compare at one speed:
// faster running is bigger accelerations however it is drawn), sends a state packet every 1/60 s, and
// the packets arrive late and bunched like a real websocket (40 ms + up to 30 ms, in order). Each display frame does what main.js
// does: the local paddle from the LATEST packet (updatePaddle every frame), Matt's on each packet as it arrives. Then it reads both
// players as drawn (the paddle and the body) frame by frame and scores how smooth they move:
//   acc    RMS frame-to-frame acceleration of the drawn x (m/s²): a step to a new packet and a dead stop are both spikes here
//   p95    95th percentile |acceleration|
//   stall  frames that did not move while the player was running (a repeated position: a packet that had not come yet)
//   face   how far the drawn paddle is from the server's paddle at contact (the hit happens on the server's: it must be on it by then)
// Screenshots of a frame mid-run land in test/ui-shots/auto-motion/. LOOK at them.
//   node test/auto-motion.mjs [port]      (8760 by default)   HZ=60|120: display rate (both are run when unset)
//   AUTO_MOTION_ROOT=<a checkout>: serve that tree's web/ instead (a before/after on one instrument)
// Last line: AUTOMOTION PASS or AUTOMOTION FAIL.
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const here = fileURLToPath(new URL('..', import.meta.url)), root = process.env.AUTO_MOTION_ROOT || here, port = +process.argv[2] || 8760, shots = here + 'test/ui-shots/auto-motion/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(shots, { recursive: true });
const http = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
let browser = null; const bye = async c => { if (browser) await browser.close().catch(() => {}); http.kill(); process.exit(c); };
setTimeout(() => { console.log('AUTOMOTION FAIL (timeout)'); bye(2); }, 150000);
for (const ev of ['uncaughtException', 'unhandledRejection']) process.on(ev, e => { console.log('AUTOMOTION FAIL', e); bye(2); });
await sleep(700);
browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new',
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
let fail = 0; const errs = [];
const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fail++; return c; };
const page = await browser.newPage(); await page.setViewport({ width: 760, height: 620 });
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); }); page.on('pageerror', e => errs.push(String(e)));
await page.goto(`http://127.0.0.1:${port}/test/scene-preview.html?side=0&clean=1&t=0.05`, { waitUntil: 'load' });
await page.waitForFunction(() => document.title.startsWith('ready'), { timeout: 60000 });

const run = (hz, until = 14) => page.evaluate(async (hz, until) => {
  const sc = window.__scene, D = sc._dbg, f = window.__fake, P = D.pads;
  f.pause(false); f.ball.live = false; f.players.forEach(p => { p.swingT = -1; });
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v)), G = 9.81;
  let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  // ---- the fake server, 60 Hz ----
  const me = { x: 0, y: 1, z: 6.5 }, matt = { x: 0, y: 1, z: -6.5, react: 0 };
  const balls = [[1.9, 1.0], [-1.6, 0.55], [2.3, 2.05], [-0.4, 1.0], [-2.2, 1.2], [1.2, 0.5]];      // the player's contact points, in turn with Matt's
  const FLIGHT = 1.15; let t = 0, bi = 0, toMe = true, b0 = 0, from = [0, 1, -6.5], to = [0, 1, 6.5], packets = [], contact = [];
  const startBall = () => { b0 = t; const c = toMe ? balls[bi % balls.length] : [balls[bi % balls.length][0] * -0.6, 1.0];
    from = toMe ? [matt.x, 1.0, -6.4] : [me.x, 1.0, 6.4]; to = toMe ? [c[0], c[1], 6.5] : [c[0], c[1], -6.5]; matt.react = t + 0.3; };
  const ballAt = tt => { const k = clamp((tt - b0) / FLIGHT, 0, 1), y = from[1] + (to[1] - from[1]) * k + 4 * 1.6 * k * (1 - k);
    return { p: [from[0] + (to[0] - from[0]) * k, y, from[2] + (to[2] - from[2]) * k], v: [(to[0] - from[0]) / FLIGHT, (to[1] - from[1]) / FLIGHT + 6.4 * (1 - 2 * k) / FLIGHT, (to[2] - from[2]) / FLIGHT] }; };
  const server = () => {
    t += 1 / 60;
    const incoming = toMe, home = !toMe;
    const tx = incoming ? to[0] : 0, ty = incoming ? to[1] : 1.0, vx = incoming ? 5.5 : 2.5;      // runAuto
    me.x = clamp(me.x + clamp(tx - me.x, -vx / 60, vx / 60), -3.6, 3.6); me.y += clamp(clamp(ty, 0.3, 2.3) - me.y, -4 / 60, 4 / 60);
    if (!toMe && t >= matt.react) { matt.x += clamp(to[0] - matt.x, -5.5 / 60, 5.5 / 60); matt.y += clamp(to[1] - matt.y, -4 / 60, 4 / 60); }      // runBot (at Auto's speed)
    else if (toMe) { matt.x += (0 - matt.x) * 2 / 60; matt.y += (1.0 - matt.y) * 2 / 60; }
    let ev = null;
    if (t - b0 >= FLIGHT) { const side = toMe ? 0 : 1; ev = { type: 'hit', side, n: 0.5, p: [...to] }; if (toMe) contact.push({ t, x: me.x, y: me.y }); toMe = !toMe; if (toMe) bi++; startBall(); }
    const B = ballAt(t);
    packets.push({ sent: t, at: Math.max(packets.length ? packets.at(-1).at : 0, t + 0.04 + Math.pow(rnd(), 3) * 0.03), me: { ...me }, matt: { x: matt.x, y: matt.y, z: matt.z }, ball: B, ev, by: toMe ? 1 : 0 });
  };
  startBall();
  // ---- the page: main.js's per-frame and per-packet work ----
  let last = null, clockMs = (window.__ms = (window.__ms || 1e6) + 5000), shown = 0;
  const samples = [], q = [0, 0, 0, 1], hv = new THREE.Vector3();
  const N = Math.round(until * hz);
  for (let i = 0; i < N; i++) {
    const ft = i / hz;
    while (t < ft + 0.2) server();                                           // the server runs ahead of what has arrived
    while (shown < packets.length && packets[shown].at <= ft) { last = packets[shown++];      // a state packet arrives
      if (last.ev) { sc.onEvent({ type: 'launch', by: last.ev.side, land: [0, 0] }); sc.onEvent(last.ev); }
      sc.updateBall(last.ball.p, last.ball.v, true, clockMs + last.sent * 1000);
      sc.updatePaddle(1, { x: last.matt.x, y: last.matt.y, z: last.matt.z, q: [0, 0, 0, 1], offset: null, bot: true }); }
    if (last) sc.updatePaddle(0, { x: last.me.x, y: last.me.y, z: last.me.z, q, offset: [0, 0, 0], bot: false, auto: true, autoY: true });      // main.js: auto = autoNow(), autoY = mode === 'auto'
    sc.render(clockMs + ft * 1000);
    const a = P[0], b = P[1];
    a.avatar.userData.head.getWorldPosition(hv);
    samples.push([ft, a.group.position.x, a.avatar.position.x, b.group.position.x, b.avatar.position.x, last ? last.me.x : 0, hv.y, last ? last.me.y : 1]);
  }
  const shot = samples.length;
  return { samples, contact, hz };
}, hz, until);

// ---- score it ----
const score = (r, col, from = 2) => {
  const s = r.samples.filter(x => x[0] >= from), dt = 1 / r.hz, acc = [];
  let stall = 0, moving = 0;
  for (let i = 2; i < s.length; i++) {
    const v1 = (s[i - 1][col] - s[i - 2][col]) / dt, v2 = (s[i][col] - s[i - 1][col]) / dt; acc.push(Math.abs(v2 - v1) / dt);
    const vs = (s[i][col] - s[Math.max(0, i - 6)][col]) / (Math.min(6, i) * dt);
    if (Math.abs(vs) > 1) { moving++; if (Math.abs(s[i][col] - s[i - 1][col]) < 1e-5) stall++; }
  }
  const rms = Math.sqrt(acc.reduce((a, x) => a + x * x, 0) / acc.length), p95 = [...acc].sort((a, b) => a - b)[Math.floor(acc.length * 0.95)];
  return { rms, p95, stall: moving ? stall / moving : 0 };
};
const results = {};
for (const hz of (process.env.HZ ? [+process.env.HZ] : [60, 120])) {
  const r = await run(hz);
  const me = score(r, 1), meBody = score(r, 2), matt = score(r, 3), mattBody = score(r, 4);
  const face = r.contact.filter(c => c.t > 2).map(c => { const i = r.samples.findIndex(x => x[0] >= c.t + 0.07); return i < 0 ? 0 : Math.abs(r.samples[i][1] - r.samples[i][5]); });
  const stand = r.samples.filter(x => x[0] > 1 && x[0] < 1.5).map(x => x[6]), standH = stand.reduce((a, b) => a + b, 0) / stand.length;
  const lobs = r.samples.filter(x => x[7] > 1.9), headUp = lobs.length ? Math.max(...lobs.map(x => x[6])) - standH : 0;
  const fmt = o => `acc ${o.rms.toFixed(0).padStart(5)} m/s²  p95 ${o.p95.toFixed(0).padStart(5)}  stall ${(o.stall * 100).toFixed(0).padStart(3)}%`;
  console.log(`${hz} Hz display`);
  console.log(`  Auto paddle  ${fmt(me)}   face at contact max ${Math.max(...face).toFixed(3)} m`);
  console.log(`  Auto body    ${fmt(meBody)}`);
  console.log(`  Matt paddle  ${fmt(matt)}`);
  console.log(`  Matt body    ${fmt(mattBody)}`);
  console.log(`  head under a 2.05 m lob: +${(headUp * 100).toFixed(1)} cm over standing`);
  results[hz] = { me, meBody, matt, mattBody, face, headUp };
  ok(headUp < 0.2, `${hz} Hz: meeting a lob, the Auto player stays their own height, like Matt (+${(headUp * 100).toFixed(1)} cm)`);
  ok(me.stall < 0.05, `${hz} Hz: the Auto paddle moves on every frame while running (stalled ${(me.stall * 100).toFixed(0)}%)`);
  ok(me.p95 < 40, `${hz} Hz: the Auto paddle has no packet steps (p95 ${me.p95.toFixed(0)} m/s²; Matt's swings his canned arc, so his is not comparable)`);
  ok(meBody.rms < mattBody.rms * 1.5, `${hz} Hz: the Auto body is about as smooth as Matt's (${meBody.rms.toFixed(0)} vs ${mattBody.rms.toFixed(0)} m/s² RMS)`);
  ok(Math.max(...face) < 0.12, `${hz} Hz: the drawn paddle is on the server's paddle at contact (max ${Math.max(...face).toFixed(3)} m off)`);
}
// frames mid-run (the second ball: 1.9 m right to 1.6 m left), from behind and from the side
for (const [name, at] of [['run-a', 2.62], ['run-b', 2.7], ['lob', 5.7]]) {
  await run(60, at);
  for (const [k, c] of [['back', [0.5, 2.4, 11.5, 0, 1, 4]], ['side', [5.5, 1.4, 6.5, 0, 0.9, 6.5]]]) {
    await page.evaluate(c => { const d = window.__scene._dbg; d.camera.position.set(c[0], c[1], c[2]); d.camera.lookAt(c[3], c[4], c[5]); d.camera.updateProjectionMatrix(); d.renderer.render(d.scene, d.camera); }, c);
    await page.screenshot({ path: `${shots}${process.env.SHOT_TAG || ''}${name}-${k}.png` });
  }
}
if (process.env.AUTO_MOTION_OUT) fs.writeFileSync(process.env.AUTO_MOTION_OUT, JSON.stringify(results));
ok(!errs.length, `no page errors${errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''}`);
console.log(fail ? `AUTOMOTION FAIL (${fail})` : 'AUTOMOTION PASS');
bye(fail ? 1 : 0);
