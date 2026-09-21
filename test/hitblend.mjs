// What the hitter SEES around a back-dated hit: drives web/scene.js in headless Chrome with a scripted ball, 60 fps, and
// reads the drawn ball back.  node test/hitblend.mjs [old-scene.js]   (a second file = also measure that build)
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url)), port = +process.env.PORT || 8176, OLD = process.argv[2];
const http = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
const bye = c => { http.kill(); process.exit(c); }; setTimeout(() => { console.log('TIMEOUT'); bye(2); }, 90000);
await new Promise(r => setTimeout(r, 700));
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new',
  args: ['--window-size=1280,720', '--use-gl=angle', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'], defaultViewport: { width: 1280, height: 720 } });
let fail = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fail++; };

// rewind: the server launches from where the ball met the paddle (hit carries p + v). Otherwise: from where the ball is now (old server).
async function run(sceneFile, rewind, behind = 1.5) {
  const page = await browser.newPage(), errs = [];
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); }); page.on('pageerror', e => errs.push(String(e)));
  if (sceneFile) { await page.setRequestInterception(true);
    page.on('request', r => (r.url().endsWith('/web/scene.js') ? r.respond({ contentType: 'text/javascript', body: fs.readFileSync(sceneFile) }) : r.continue())); }
  await page.goto(`http://127.0.0.1:${port}/test/scene-preview.html?side=0&t=0.1`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.title.startsWith('ready'), { timeout: 30000 });
  const r = await page.evaluate((rewind, behind) => {
    const sc = __scene, d = sc._dbg, G = 9.81, DT = 1 / 60, PZ = 6.5, ballMesh = d.scene.children.find(o => o.isMesh && o.geometry.type === 'SphereGeometry' && Math.abs(o.geometry.parameters.radius - 0.11) < 1e-6);
    sc.unlockAudio();
    let ms = 1000, p = [0.3, 1.0, 0.5], v = [0, 1.2, 9], hitF = -1, inst = null; const path = [], hist = [];
    sc.updatePaddle(0, { x: 0, y: 1, z: PZ, q: [0, 0, 0, 1], offset: [0, 0, 0], bot: false });
    sc.onEvent({ type: 'launch', by: 1, land: [0, 5] });
    for (let f = 0; f < 140; f++) {
      ms += DT * 1000; v[1] -= G * DT; for (let i = 0; i < 3; i++) p[i] += v[i] * DT; hist.push([...p]);
      if (hitF < 0 && p[2] > PZ + behind) {                 // the swing report arrives now, back-dated: the ball is already `behind` m past the paddle
        hitF = f;
        if (rewind) p = [...hist.reduce((b, h) => (Math.abs(PZ - h[2] - 0.25) < Math.abs(PZ - b[2] - 0.25) ? h : b))];
        const T = 0.8; v = [(0 - p[0]) / T, (0.11 - p[1]) / T + 0.5 * G * T, (-5 - p[2]) / T];
        sc.onEvent({ type: 'swung', side: 0 });
        sc.onEvent(rewind ? { type: 'hit', side: 0, n: 0.6, kind: 'drive', p: [...p], v: [...v] } : { type: 'hit', side: 0, n: 0.6, kind: 'drive', p: [...p] });
        inst = { shake: d.cam ? d.cam.shake : null, lunge: d.pads[0].lunge };      // set synchronously by the event = on this frame
        sc.onEvent({ type: 'launch', by: 0, land: [0, -5] });
      }
      sc.updateBall([...p], [...v], true, ms); sc.render(ms);
      path.push([ballMesh.position.x, ballMesh.position.y, ballMesh.position.z]);
    }
    let slice = null;
    if (d.ball) {                                            // a sliced return: backspin + icy trail, reset by the next flat hit
      const spinAt = k => { sc.onEvent({ type: 'hit', side: 1, n: 0.5, kind: k ? 'slice' : 'drive', p: [0, 1, -6], v: [0, 3, 9], spin: k }); const q0 = ballMesh.quaternion.clone();
        for (let f = 0; f < 20; f++) { ms += DT * 1000; sc.updateBall([0, 1 + f * 0.02, -6 + f * 0.15], [0, 3, 9], true, ms); sc.render(ms); }
        const c = d.scene.children.find(o => o.isMesh && o.geometry.attributes.color && o.geometry.index).geometry.attributes.color.array;
        return { spin: d.ball.spin, cool: d.ball.cool, red: c[0], blue: c[2], turned: q0.angleTo(ballMesh.quaternion) }; };
      slice = { on: spinAt(1), off: spinAt(0) };
    }
    const step = i => Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1], path[i][2] - path[i - 1][2]);
    let maxStep = 0, turn = -1; for (let i = hitF; i < hitF + 20; i++) { maxStep = Math.max(maxStep, step(i)); if (turn < 0 && path[i][2] < path[i - 1][2]) turn = i; }
    const free = Math.hypot(...v) * DT;                      // an honest frame of flight at the outgoing speed
    return { slice, hitF, maxStep, free, turnFrames: turn - hitF, zAtTurn: path[Math.max(turn - 1, 0)][2] - PZ, inst, around: path.slice(hitF - 2, hitF + 10).map(q => +(q[2] - PZ).toFixed(2)) };
  }, rewind, behind);
  await page.close(); return { ...r, errs };
}
const show = (name, r) => console.log(`${name}\n    largest single-frame move of the drawn ball: ${r.maxStep.toFixed(2)} m (free flight = ${r.free.toFixed(2)} m/frame)   ball turns ${r.turnFrames} frame(s) after the event` +
  `\n    drawn ball z - paddle z, from 2 frames before the hit: ${r.around.join(' ')}`);
if (OLD) { show('old server + old scene (launch from behind the player, snap)', await run(OLD, false)); show('NEW server + old scene (rewound launch, snap = teleport)', await run(OLD, true)); }
const n = await run(null, true); show('NEW server + NEW scene (rewound launch, blended)', n);
const c = await run(null, false); show('old server + NEW scene (no v on the hit: falls back to blending onto the next packet)', c);
ok(n.errs.length === 0 && c.errs.length === 0, 'no console errors' + (n.errs.length ? ': ' + n.errs.join(' | ') : ''));
ok(n.maxStep < 0.6, `a 1.5 m correction never shows as a jump (largest frame move ${n.maxStep.toFixed(2)} m, free flight ${n.free.toFixed(2)})`);
ok(n.turnFrames <= 1, 'the drawn ball turns around on the frame the hit arrives');
ok(n.inst && n.inst.lunge === 1 && n.inst.shake > 0, `shake + paddle follow-through are armed by the event itself, no timer (shake ${n.inst && n.inst.shake}, lunge ${n.inst && n.inst.lunge})`);
ok(n.slice && n.slice.on.spin === 1 && n.slice.on.cool > 0.8 && n.slice.on.blue > n.slice.on.red * 2 && n.slice.off.spin === 0 && n.slice.off.red > n.slice.off.blue, `sliced ball: spin shown, trail goes icy (r ${n.slice && n.slice.on.red.toFixed(2)} b ${n.slice && n.slice.on.blue.toFixed(2)}), and back to warm on the next flat hit (r ${n.slice && n.slice.off.red.toFixed(2)} b ${n.slice && n.slice.off.blue.toFixed(2)})`);
await browser.close(); console.log(fail ? fail + ' FAILURES' : 'HIT BLEND TESTS PASSED'); bye(fail ? 1 : 0);
