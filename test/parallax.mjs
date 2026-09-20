// Head-coupled camera check: screenshots test/scene-preview.html at viewer = -1/0/1 for both sides and measures where
// the court and the local paddle land on screen.  node test/parallax.mjs [port]   (serves the repo itself, 8110 by default)
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url)), port = +process.argv[2] || 8110, T = process.argv[3] || '3.2';
const http = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
const kill = setTimeout(() => { console.log('TIMEOUT'); http.kill(); process.exit(2); }, 55000);
process.on('uncaughtException', e => { console.log(e); http.kill(); process.exit(2); });
await new Promise(r => setTimeout(r, 700));
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new',
  args: ['--window-size=1440,900', '--use-gl=angle', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1440, height: 900 } });
let fail = 0; const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fail++; };
const f = v => (v >= 0 ? ' ' : '') + v.toFixed(3);
async function shot(side, viewer, extra = '', name = null, t = T, vp = null) {
  const page = await browser.newPage(); if (vp) await page.setViewport(vp); page.on('console', m => { if (m.text().startsWith('HARNESS-ERROR')) console.log(m.text()); });
  await page.goto(`http://127.0.0.1:${port}/test/scene-preview.html?side=${side}&t=${t}&viewer=${viewer}${extra}`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.title.startsWith('ready'), { timeout: 30000 });
  const file = root + `test/shots/${name || `parallax-s${side}-v${viewer}`}.png`; await page.screenshot({ path: file });
  const r = await page.evaluate(side => {                  // NDC (-1..1, + = right / up on screen) of the landmarks
    const d = __scene._dbg, s = side === 0 ? 1 : -1, P = (x, y, z) => { const v = new THREE.Vector3(x, y, z).project(d.camera); return [v.x, v.y]; };
    const pad = d.pads[side].group;
    return { errors: __errors.length, eye: d.camera.position.toArray(), centre: P(0, 0.455, 0), postR: P(s * 3.05, 0.91, 0), postL: P(-s * 3.05, 0.91, 0),
      nearR: P(s * 3.05, 0, s * 6.7), nearL: P(-s * 3.05, 0, s * 6.7), farR: P(s * 3.05, 0, -s * 6.7), farL: P(-s * 3.05, 0, -s * 6.7), paddle: pad ? P(pad.position.x, pad.position.y, pad.position.z) : null };
  }, side);
  await page.close(); return { ...r, file };
}
const res = {};
for (const side of [0, 1]) for (const v of [-1, 0, 1]) {
  const r = res[side + ':' + v] = await shot(side, v);
  console.log(`side ${side} viewer ${f(v)}  eye ${r.eye.map(f).join(',')}  paddle ${r.paddle.map(f)}  nearL ${r.nearL.map(f)}  nearR ${r.nearR.map(f)}  postL ${r.postL.map(f)}  postR ${r.postR.map(f)}  farL ${r.farL.map(f)}  centre ${r.centre.map(f)}`);
  ok(r.errors === 0, 'no page errors');
  ok(Math.abs(r.centre[0]) < 0.01 && Math.abs(r.centre[1] - res[side + ':-1'].centre[1]) < 0.01, 'window centre (middle of the net) pinned on screen');
  ok([r.nearL, r.nearR, r.postL, r.postR, r.farL, r.farR].every(p => Math.abs(p[0]) < 0.97 && Math.abs(p[1]) < 0.97), 'both near corners, the net posts and the far corners are in frame');
  ok(Math.abs(r.paddle[0]) < 0.72 && Math.abs(r.paddle[1]) < 0.8, 'paddle comfortably on screen (|x| < 0.72)');
}
for (const side of [0, 1]) {
  const a = res[side + ':-1'], b = res[side + ':1'], c = res[side + ':0'];
  ok(Math.abs(a.postR[0] - b.postR[0]) < 0.03, `side ${side}: net posts hold still (${f(a.postR[0])} vs ${f(b.postR[0])})`);
  ok(a.nearR[0] - b.nearR[0] > 0.15, `side ${side}: near baseline slides against the eye (${f(a.nearR[0])} -> ${f(b.nearR[0])})`);
  ok(b.paddle[0] > 0.2 && a.paddle[0] < -0.2, `side ${side}: viewer +1 (player's right) puts the paddle on the right of the screen`);
  ok(Math.abs(a.paddle[0] + b.paddle[0]) < 0.05, `side ${side}: left/right symmetric`);
}
{ const a = await shot(0, 1, '', 'parallax-home-s0', '0.45'), b = await shot(1, 1, '', 'parallax-home-s1', '0.45');   // before the first serve: both players at home, same camera depth
  for (const r of [a, b]) console.log(`home viewer +1  eye ${r.eye.map(f).join(',')}  paddle ${r.paddle.map(f)}  nearL ${r.nearL.map(f)}  nearR ${r.nearR.map(f)}  postL ${r.postL.map(f)}  postR ${r.postR.map(f)}`);
  ok([a.nearL, a.nearR].every(p => Math.abs(p[0]) < 0.97 && Math.abs(p[1]) < 0.97), 'near corners in frame at home depth');
  ok(Math.abs(a.paddle[0] - b.paddle[0]) < 0.02 && Math.abs(a.nearL[0] - b.nearL[0]) < 0.02 && Math.abs(a.eye[0] + b.eye[0]) < 0.02, `side 1 sees the same picture as side 0 (paddle ${f(a.paddle[0])} vs ${f(b.paddle[0])}, eye x ${f(a.eye[0])} vs ${f(b.eye[0])})`); }
{ const r = await shot(0, 1, '&fallback=1', 'parallax-fallback'), b = res['0:1'];
  ok(Math.abs(r.eye[0] - b.eye[0]) < 0.05 && Math.abs(r.paddle[0] - b.paddle[0]) < 0.02, `fallback from the paddle position matches setViewer (eye x ${f(r.eye[0])} vs ${f(b.eye[0])})`); }
{ const hi = await shot(0, 1, '&vy=1', 'parallax-high'), lo = await shot(0, -1, '&vy=-0.54', 'parallax-low');
  ok(Math.abs(hi.paddle[1]) < 0.85 && Math.abs(lo.paddle[1]) < 0.85, `paddle on screen at full stretch / full duck (y ${f(hi.paddle[1])} / ${f(lo.paddle[1])})`); }
{ const r = await shot(0, 1, '', 'parallax-narrow', T, { width: 640, height: 900 });   // tall window: resize() widens the fov, the window model must follow
  ok(Math.abs(r.paddle[0]) < 0.8 && [r.nearL, r.nearR, r.postL, r.postR].every(p => Math.abs(p[0]) < 0.99), `640x900: paddle ${f(r.paddle[0])}, near corners ${f(r.nearL[0])} / ${f(r.nearR[0])}`); }
// smoothness: noisy head data in, how rough is the eye?  (sum |second difference| relative to the travel)
{ const page = await browser.newPage(); await page.goto(`http://127.0.0.1:${port}/test/scene-preview.html?side=0&t=0.1`, { waitUntil: 'load' }); await page.waitForFunction(() => document.title.startsWith('ready'));
  const m = await page.evaluate(() => { const sc = __scene, cam = sc._dbg.camera, xs = []; let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) - 0.5;
    for (let i = 0; i < 240; i++) { const clean = i < 60 ? 0 : 1; sc.setViewer({ x: clean + rnd() * 0.08, y: 0 }); sc.render(200 + i * 1000 / 60); xs.push(cam.position.x); }
    let worst = 0, over = 0, settle = -1; for (let i = 180; i < xs.length; i++) worst = Math.max(worst, Math.abs(xs[i] - 2 * xs[i - 1] + xs[i - 2])); const end = xs[xs.length - 1];
    for (let i = 60; i < xs.length; i++) { over = Math.max(over, xs[i] - end); if (settle < 0 && xs[i] > 0.9 * end) settle = (i - 60) / 60; }
    return { worst, over, settle, end }; });
  console.log(`noisy step 0 -> 1 (+-4 % noise): eye ends at ${f(m.end)} m, 90 % in ${m.settle.toFixed(2)} s, overshoot ${(m.over * 1000).toFixed(1)} mm, worst settled frame-to-frame jerk ${(m.worst * 1000).toFixed(2)} mm (input noise +-52 mm)`);
  ok(m.worst < 0.004 && m.over < 0.02 && m.settle < 0.7, 'smooth: no jitter, no overshoot, settles inside 0.7 s'); await page.close(); }
await browser.close(); http.kill(); clearTimeout(kill);
console.log(fail ? `${fail} FAILED` : 'ALL OK'); process.exit(fail ? 1 : 0);
