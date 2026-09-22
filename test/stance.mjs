// The avatar's stance, inferred from head height alone (NOTES 68). Drives test/scene-preview.html in headless Chrome with
// the fake server's footwork switched off, so the only thing moving is the number this feature reads: pd.pos.y.
// Screenshots land in test/ui-shots/stance/. LOOK at them: the asserts below cannot tell a crouch from a collapse.
//   node test/stance.mjs [port]      (8742 by default)
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url)), port = +process.argv[2] || 8742, shots = root + 'test/ui-shots/stance/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(shots, { recursive: true });
const http = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
let browser = null; const bye = async c => { if (browser) await browser.close().catch(() => {}); http.kill(); process.exit(c); };
setTimeout(() => { console.log('STANCE FAIL (timeout)'); bye(2); }, 180000);
for (const ev of ['uncaughtException', 'unhandledRejection']) process.on(ev, e => { console.log('STANCE FAIL', e); bye(2); });
await sleep(700);
browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new',
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
let fail = 0; const errs = [];
const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fail++; return c; };

const page = await browser.newPage(); await page.setViewport({ width: 900, height: 620 });
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); }); page.on('pageerror', e => errs.push(String(e)));
// spectate: BOTH seats are remote, so both wear an avatar. t=2: the rally has settled and the scenery is in.
await page.goto(`http://127.0.0.1:${port}/test/scene-preview.html?spectate=1&opp=human&clean=1&t=2&game=${port}&bridge=${port}`, { waitUntil: 'load' });
await page.waitForFunction(() => document.title.startsWith('ready'), { timeout: 60000 });

// Hold the fake rally still and hand-drive side 0's head: y over `frames` frames, x sliding at `vx` m/s. Returns what the
// avatar actually became, measured off the live scene graph in world metres.
const drive = await page.evaluateHandle(() => (window.STANCE_BASE = 1.0, window.__drive = ({ side = 0, ys, vx = 0, frames = 40, x0 = 0 }) => {
  const f = window.__fake, sc = window.__scene, pd = sc._dbg.pads[side], pl = f.players[side], sg = side ? -1 : 1;
  f.ball.live = false;                                   // no flight, no swings: the head is the only thing moving
  const wave = typeof ys === 'string' ? new Function('t', 'return ' + ys) : () => ys;      // arguments cross as JSON, so a waveform arrives as its own source
  let ms = (window.__ms = (window.__ms || 1e6) + 1000), peakSpring = 0, peakTaunt = 0;
  for (let i = 0; i < 100; i++) { pl.y = STANCE_BASE; pl.x = x0; pl.z = sg * 6.5; pl.swingT = -1; ms += 1000 / 60; f.push(ms); sc.render(ms); }   // 1.7 s standing: long enough for the head to settle, the spring to stop and any earlier taunt to expire
  for (let i = 0; i < frames; i++) {
    pl.y = wave(i / 60); pl.x = x0 + vx * (i / 60); pl.z = sg * 6.5; pl.swingT = -1;
    ms += 1000 / 60; f.push(ms); sc.render(ms);
    peakSpring = Math.max(peakSpring, Math.abs(pd.stance.spring)); peakTaunt = Math.max(peakTaunt, pd.stance.taunt);
  }
  const a = pd.avatar, u = a.userData, S = a.scale.x, w = o => { const v = new THREE.Vector3(); o.getWorldPosition(v); return v; };
  const head = w(u.head), body = w(u.body), f0 = w(u.feet[0]), f1 = w(u.feet[1]);
  return { headY: +head.y.toFixed(4), rootY: +a.position.y.toFixed(4), upperY: +u.upper.position.y.toFixed(4), upperS: +u.upper.scale.y.toFixed(4),
    // the torso capsule's underside and the shoes' undersides, in world metres above the court
    bodyBottom: +(body.y - 0.46 * u.upper.scale.y * S).toFixed(4),
    footBottom: +Math.min(...[f0, f1].map((p, i) => p.y - Math.hypot(0.066 * Math.cos(u.feet[i].rotation.x), 0.165 * Math.sin(u.feet[i].rotation.x)) * S)).toFixed(4),
    // feet in the PLAYER's frame (side 0: local x is world x), relative to the body centre
    footX: [+u.feet[0].position.x.toFixed(4), +u.feet[1].position.x.toFixed(4)],
    footZ: [+u.feet[0].position.z.toFixed(4), +u.feet[1].position.z.toFixed(4)],
    footPitch: +u.feet[0].rotation.x.toFixed(4),
    // How far the body is off vertical, in the PLAYER's own frame, measured from where the head actually ended up over the
    // feet. Reading a.rotation back is no good: at rotation.y = PI the Euler re-decomposes and side 1's roll changes sign.
    leanSide: +(((head.x - (f0.x + f1.x) / 2) / Math.max(0.3, head.y - (f0.y + f1.y) / 2)) * sg).toFixed(4),
    leanFwd: +(((f0.z + f1.z) / 2 - head.z) / Math.max(0.3, head.y - (f0.y + f1.y) / 2) * sg).toFixed(4),
    duck: +pd.stance.duck.toFixed(3), tip: +pd.stance.tip.toFixed(3), spring: +pd.stance.spring.toFixed(4), taunt: +pd.stance.taunt.toFixed(3),
    peakSpring: +peakSpring.toFixed(4), peakTaunt: +peakTaunt.toFixed(3), bodyX: +pd.bodyX.toFixed(3), posY: +pd.pos.y.toFixed(3) };
}));
const run = o => page.evaluate((h, a) => h(a), drive, o);
const shoot = async name => { await page.evaluate(() => { const d = window.__scene._dbg;      // a close three-quarter look at side 0's avatar
    d.camera.position.set(1.9, 1.7, 12.2); d.camera.lookAt(-0.5, 0.95, 7.2); d.camera.updateProjectionMatrix(); d.renderer.render(d.scene, d.camera); });
  await page.screenshot({ path: shots + name + '.png' }); };

// ---------- 1. the baseline pose: calibrated height, standing still ----------
console.log('baseline');
const base = await run({ ys: 1.0, frames: 90 });
ok(Math.abs(base.upperY) < 0.012, `y=1.0 rests at the baseline (upper.y ${base.upperY}, duck ${base.duck}, tip ${base.tip})`);
ok(base.duck === 0 && base.tip === 0, 'y=1.0 is neither a duck nor a stretch');
ok(Math.abs(base.upperS - 1) < 0.02, `no squash at rest (${base.upperS})`);
ok(Math.abs(base.footX[0] + 0.15) < 0.005 && Math.abs(base.footX[1] - 0.15) < 0.005, `feet at their rest spread (${base.footX})`);
await shoot('1-baseline');

// ---------- 2. head height moves the body, monotonically, and nothing leaves the court ----------
console.log('head height -> body');
const by = {};
for (const y of [0.4, 0.7, 1.0, 1.3, 1.6, 2.2]) { by[y] = await run({ ys: y, frames: 90 }); await shoot(`2-y${String(y).replace('.', '_')}`); }
const ys = [0.4, 0.7, 1.0, 1.3, 1.6, 2.2];
let mono = true; for (let i = 1; i < ys.length; i++) if (by[ys[i]].headY <= by[ys[i - 1]].headY + 0.01) mono = false;
ok(mono, 'the avatar head rises with the tracked head at every step: ' + ys.map(y => `${y}->${by[y].headY}`).join(' '));
ok(by[0.4].headY < by[1.0].headY - 0.3, `a deep duck drops the head a long way (${by[0.4].headY} vs ${by[1.0].headY})`);
ok(by[2.2].headY > by[1.0].headY + 0.15, `a stretch lifts it (${by[2.2].headY} vs ${by[1.0].headY})`);
for (const y of ys) {
  ok(by[y].footBottom > -0.005, `y=${y}: the shoes stay on the court (sole at ${by[y].footBottom})`);
  ok(by[y].bodyBottom > 0.03, `y=${y}: the torso stays above the court (underside at ${by[y].bodyBottom})`);
}
ok(by[0.4].leanFwd > by[1.0].leanFwd + 0.15, `a duck leans the torso forward into a ready position (${by[0.4].leanFwd} vs ${by[1.0].leanFwd})`);
ok(by[0.4].footX[1] - by[0.4].footX[0] > (base.footX[1] - base.footX[0]) + 0.1, `the stance widens as the knees bend (${by[0.4].footX})`);
ok(by[2.2].footPitch < -0.4, `on the toes the heels come up (foot pitch ${by[2.2].footPitch})`);
ok(Math.abs(by[1.0].footPitch) < 0.01, `flat-footed at the baseline (${by[1.0].footPitch})`);
ok(by[2.2].footBottom < 0.02, `a tiptoe pivots on the toes rather than lifting off (sole still at ${by[2.2].footBottom})`);

// ---------- 3. a low head plus sideways travel is a lunge, and it leans the right way ----------
console.log('lunge');
const right = await run({ ys: 0.65, vx: 2.6, frames: 60, x0: -1.3 }); await shoot('3-lunge-right');
const left = await run({ ys: 0.65, vx: -2.6, frames: 60, x0: 1.3 }); await shoot('3-lunge-left');
const still = await run({ ys: 0.65, vx: 0, frames: 90 }); await shoot('3-squat-still');
ok(right.footX[1] > still.footX[1] + 0.07, `running right, the right foot steps out (${right.footX[1]} vs ${still.footX[1]})`);
ok(left.footX[0] < still.footX[0] - 0.07, `running left, the left foot steps out (${left.footX[0]} vs ${still.footX[0]})`);
ok(right.footZ[1] < right.footZ[0] - 0.03, `the lead foot is ahead of the trailing one (${right.footZ})`);
ok(left.footZ[0] < left.footZ[1] - 0.03, 'mirrored going the other way: ' + left.footZ);
ok(right.leanSide > 0.05 && left.leanSide < -0.05, `the body leans into the run, both ways (${right.leanSide} / ${left.leanSide})`);
ok(Math.abs(still.leanSide) < 0.02 && Math.abs(still.footX[0] + still.footX[1]) < 0.02, `standing still it is a square squat, not a lunge (lean ${still.leanSide})`);

// ---------- 4. a fast bob overshoots, and three of them in a row are named ----------
// The spring and the taunt are both transients, so these read the PEAK over the run, not the last frame.
console.log('bob');
const slow = await run({ ys: '1.0 - 0.45 * Math.min(1, t / 2)', frames: 160 });             // all the way to the same depth, taken slowly
ok(slow.peakSpring < 0.025, `a slow duck of the same depth barely touches the spring (peak ${slow.peakSpring})`);
ok(slow.duck > 0.9, `...and still ends up all the way down (duck ${slow.duck})`);
const drop = await run({ ys: 't < 0.05 ? 1.0 : 0.55', frames: 20 });                        // the same move, dropped into
ok(drop.peakSpring > 0.06, `dropping fast squashes past the resting crouch (peak ${drop.peakSpring})`);
ok(drop.peakSpring > slow.peakSpring * 3, 'how fast the head moves, not how far, is what bounces the body');
const teabag = await run({ ys: '1.0 - 0.45 * (0.5 - 0.5 * Math.cos(t * 2 * Math.PI * 2.6))', frames: 110 });
await shoot('4-teabag');
ok(teabag.peakTaunt > 0.5, `three quick dips register as a taunt (peak ${teabag.peakTaunt})`);
ok(teabag.peakSpring > 0.05, `and the body bounces the whole way through it (peak ${teabag.peakSpring})`);
const once = await run({ ys: '1.0 - 0.45 * (0.5 - 0.5 * Math.cos(t * 2 * Math.PI * 2.6))', frames: 55 });
ok(once.peakTaunt === 0, `two dips is just footwork, not a taunt (peak ${once.peakTaunt})`);
const settle = await run({ ys: 1.0, frames: 150 });                                         // it lets go again
ok(settle.taunt === 0 && Math.abs(settle.spring) < 0.01 && Math.abs(settle.upperY) < 0.012, `the taunt, the bounce and the crouch all settle back to standing (${settle.taunt} / ${settle.spring} / ${settle.upperY})`);

// ---------- 5. the far seat reads the same number the same way, in its own mirrored frame ----------
console.log('side 1');
const farStill = await run({ side: 1, ys: 0.65, vx: 0, frames: 90 });
ok(farStill.duck > 0.5, `side 1 ducks on the same number (${farStill.duck})`);
ok(Math.abs(farStill.headY - still.headY) < 0.01, `to exactly the same height as side 0 (${farStill.headY} vs ${still.headY})`);
const far = await run({ side: 1, ys: 0.65, vx: 2.6, frames: 60, x0: -1.3 }); await shoot('5-side1-lunge');
// Side 1's avatar is turned through PI, so the SAME world velocity is a step to that player's own LEFT.
ok(far.footX[0] < still.footX[0] - 0.07, `its lunge is mirrored into its own frame (${far.footX} vs still ${still.footX})`);
ok(far.leanSide < -0.05, `and it leans into its own direction of travel (${far.leanSide})`);
ok(far.footBottom > -0.005, `its shoes stay on the court through the lunge too (${far.footBottom})`);
ok(right.footBottom > -0.005, `so do side 0's (${right.footBottom})`);

ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.slice(0, 4).join(' | ') : ''));
console.log(fail ? `STANCE FAIL (${fail})` : 'STANCE PASS');
console.log('shots in test/ui-shots/stance/ — look at them');
bye(fail ? 1 : 0);
