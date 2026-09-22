// Spin swirl + serve cue shots (NOTES.md 48). node test/swirl-shots.mjs [tag] [port]  -> test/ui-shots/swirl/<tag>-*.png (full 1280x720 + a 4x crop round the ball)
// LOOK at them. Drives test/scene-preview.html: a frozen rally at t, then either more rally with the ball's spin forced, or the ball hanging for a serve.
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url)), tag = process.argv[2] || 'now', port = +process.argv[3] || 8741, dir = root + 'test/ui-shots/swirl/', sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(dir, { recursive: true });
const http = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
await sleep(700);
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
const errs = [];
// what: ['spin', s] = keep the rally running with the ball's spin at s; ['serve', side] = the ball hangs for side's serve; ['hit', side] = hangs, then is struck
async function shot(name, query, what, frames = 40) {
  const page = await browser.newPage(); await page.setViewport({ width: 1280, height: 720 });
  page.on('pageerror', e => errs.push(name + ': ' + e)); page.on('console', m => { if (m.type() === 'error') errs.push(name + ': ' + m.text()); });
  await page.goto(`http://127.0.0.1:${port}/test/scene-preview.html?${query}&clean=1&game=${port}&bridge=${port}`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.title.startsWith('ready'), { timeout: 60000 });
  await page.waitForFunction(() => window.__scenery, { timeout: 20000 }).catch(() => {});
  const xy = await page.evaluate((what, frames, t) => { const sc = __scene, d = sc._dbg, F = __fake; let ms = t * 1000;
    for (let i = 0; i < frames; i++) { ms += 1000 / 60;
      if (what[0] === 'spin') { F.step(1 / 60); F.push(ms); d.ball.spin = what[1]; d.ball.kick = what[2] || 0; d.ball.bounces = F.ball.bounces; }
      else if (what[0] === 'none') {}
      else { const s = what[1] ? -1 : 1, hit = what[0] === 'hit' && i >= frames - what[2];
        sc.updateBall(what[3] || [0.9 * s, 1.1, 6.5 * s], hit ? [0, 4, -9 * s] : [0, 0, 0], true, hit ? ms - (i - frames + what[2]) * 1000 / 60 : ms, hit ? 0.9 : 0, hit ? { b: 0, k: 0 } : { serving: what[1], b: 0, k: 0 }); }
      sc.render(ms); }
    const v = d.ball.pos.clone().project(d.camera), out = [(v.x + 1) * 640, (1 - v.y) * 360];
    // which way does the swirl turn on screen? Follow a wisp head over one more frame (screen y up), and set that against the bounce: the swirl
    // should turn like a wheel rolling the ball along D, the extra change the spin makes to its ground speed (D = up x axis ... axis = up x D)
    const fx = d.scene.children.find(o => o.isMesh && o.geometry.attributes.color && o.geometry.attributes.color.itemSize === 4);
    if (what[0] === 'spin' && fx && fx.visible) {            // each draw of the frame (split view draws two, moving the one camera between them): the head's angle round the ball on that draw's screen
      const R = d.renderer, real = R.render.bind(R), P = fx.geometry.attributes.position, head = new THREE.Vector3(P.getX(1), P.getY(1), 0); let angs = [];
      R.render = (scn, cam) => { real(scn, cam); const w = head.clone().applyMatrix4(fx.matrixWorld).project(cam), c = fx.position.clone().project(cam), toCam = cam.position.clone().sub(d.ball.pos).normalize(); angs.push([Math.atan2(w.y - c.y, (w.x - c.x) * cam.aspect), toCam]); };
      const frame = () => { angs = []; ms += 1000 / 60; F.step(1 / 60); F.push(ms); d.ball.spin = what[1]; d.ball.kick = what[2] || 0; d.ball.bounces = F.ball.bounces; sc.render(ms); return angs; };
      const A = frame(), B = frame(); R.render = real;
      const b = d.ball, cut = (0.45 - 0.78) * b.spin, D = new THREE.Vector3(b.vel.x * cut + b.kick, 0, b.vel.z * cut), axis = new THREE.Vector3(0, 1, 0).cross(D).normalize();
      out.push({ D: D.toArray().map(x => +x.toFixed(2)), draws: A.map(([a0, toCam], i) => { let da = B[i][0] - a0; if (da > Math.PI) da -= 2 * Math.PI; if (da < -Math.PI) da += 2 * Math.PI;
        return { screenTurn: da > 0 ? 'anticlockwise' : 'clockwise', deg: +(da * 180 / Math.PI).toFixed(1), axisDotCam: +axis.dot(toCam).toFixed(2) }; }) }); }
    if (what[0] === 'none') out.push({ swirl: !!(fx && fx.visible), spin: d.attract.spin, kick: d.attract.kick });
    return out; }, what, frames, +/t=([\d.]+)/.exec(query)[1]);
  await page.screenshot({ path: `${dir}${tag}-${name}.png` });
  const C = 160, cx = Math.round(Math.min(1280 - C, Math.max(0, xy[0] - C / 2))), cy = Math.round(Math.min(720 - C, Math.max(0, xy[1] - C / 2)));
  const buf = await page.screenshot({ clip: { x: cx, y: cy, width: C, height: C } });
  const p2 = await browser.newPage(); await p2.setViewport({ width: 480, height: 480 });
  await p2.setContent(`<body style="margin:0"><img src="data:image/png;base64,${buf.toString('base64')}" style="width:480px;height:480px;image-rendering:pixelated">`);
  await p2.screenshot({ path: `${dir}${tag}-${name}-zoom.png` }); await p2.close(); await page.close();
  console.log(name, JSON.stringify(xy.map(x => typeof x === 'number' ? Math.round(x) : x)));
}
const only = process.argv[4] ? new RegExp(process.argv[4]) : null, S = (n, ...a) => (!only || only.test(n)) && shot(n, ...a);
// t 2.3: side 1's drive coming at side 0 (before its bounce); t 3.3 side 0's reply going away
await S('play-hispin', 'side=0&t=2.3', ['spin', 1]);                       // pure backspin, coming at me: the near side of the swirl sweeps UP (the ball's face turns back up)
await S('play-lospin', 'side=0&t=2.3', ['spin', 0.2]);
await S('play-kick', 'side=0&t=2.3', ['spin', 0.8, 2.7]);                  // kick +x (right on my screen): turns clockwise for me
await S('play-hispin-away', 'side=0&t=3.3', ['spin', 1]);
await S('opp-hispin', 'side=1&t=3.3', ['spin', 1]);                          // side 1's own view of the same kind of ball
await S('play-serve-mine', 'side=0&t=1', ['serve', 0]);
await S('play-serve-theirs', 'side=0&t=1', ['serve', 1]);
await S('play-serve-hit', 'side=0&t=1', ['hit', 0, 4]);                   // 4 frames after the serve is struck: the arcs going, no swirl yet
await S('play-serve-hit-late', 'side=0&t=1', ['hit', 0, 16]);            // 16 frames on: arcs gone, the swirl in
await S('bc-hispin', 'spectate=1&view=broadcast&t=2.3', ['spin', 1]);
await S('bc-lospin', 'spectate=1&view=broadcast&t=2.3', ['spin', 0.2]);
await S('bc-kick', 'spectate=1&view=broadcast&t=2.3', ['spin', 0.8, 2.7]);
await S('bc-serve', 'spectate=1&view=broadcast&t=1', ['serve', 0]);
await S('play-serve-line', 'side=0&t=1', ['serve', 0, 0, [0.3, 1.1, 6.7]]);   // hanging over the baseline's white
for (const f of [60, 120, 180, 240, 300, 360]) await S('attract-' + f, 'attract=1&t=1', ['none'], f);
await S('split-hispin', 'spectate=1&view=split&t=2.3', ['spin', 1]);
for (const f of [30, 33, 36]) await S('seq-bc-' + f, 'spectate=1&view=broadcast&t=2.3', ['spin', 1], f);
for (const f of [30, 33, 36]) await S('seq-play-' + f, 'side=0&t=2.3', ['spin', 1], f);
console.log(errs.length ? 'ERRORS\n' + errs.join('\n') : 'no errors');
await browser.close(); http.kill();
