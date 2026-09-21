// The phone paddle's sensor maths (web/padmotion.js): a simulated phone turned about known axes must come out as the
// sample CONTRACT.md describes, whichever way the browser names rotationRate, and MotionModel must calibrate and swing on it.
import { PadMotion, eulerToQuat } from '../web/padmotion.js';
import { MotionModel, qmul, qrot, qexp } from '../web/motion.js';
let fails = 0; const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++; };
const DEG = Math.PI / 180, near = (a, b, e = 1e-6) => Math.abs(a - b) < e;

// --- Euler -> quaternion: the spec's own examples
{ const up = qrot(eulerToQuat(0, 90, 0), [0, 1, 0]);      // beta 90: the top of the phone points at the sky
  ok(near(up[2], 1), 'beta 90 stands the phone up (device y -> world up)');
  const rt = qrot(eulerToQuat(0, 0, 90), [0, 0, 1]);      // gamma 90: screen faces east (+x)
  ok(near(rt[0], 1), 'gamma 90 turns the screen to world +x');
  const n = qrot(eulerToQuat(90, 0, 0), [0, 1, 0]);       // alpha 90: the top turns from north to west
  ok(near(n[0], -1), 'alpha 90 turns the top from +y to -x'); }

// --- a phone simulated from a body-rate script; events carry Euler angles and a rotationRate named either way
function toEuler(q) {                              // inverse of eulerToQuat (Z X' Y''), degrees
  const R = [qrot(q, [1, 0, 0]), qrot(q, [0, 1, 0]), qrot(q, [0, 0, 1])];      // columns
  const m = (r, c) => R[c][r];
  const beta = Math.asin(Math.max(-1, Math.min(1, m(2, 1)))), alpha = Math.atan2(-m(0, 1), m(1, 1)), gamma = Math.atan2(-m(2, 0), m(2, 2));
  return [alpha / DEG, beta / DEG, gamma / DEG];
}
function run(naming, script, feed) {
  const pad = new PadMotion(); let q = eulerToQuat(20, 30, 5), t = 0; const out = [];
  for (const [dur, w] of script) for (let k = 0; k < dur * 60; k++) {
    q = qmul(q, qexp(w.map(v => v / 60))); t += 1 / 60;
    const [alpha, beta, gamma] = toEuler(q), d = w.map(v => v / DEG);
    pad.orientation({ alpha, beta, gamma }, t);
    const rr = naming === 'xyz' ? { alpha: d[0], beta: d[1], gamma: d[2] } : { alpha: d[2], beta: d[0], gamma: d[1] };
    const s = pad.motion({ rotationRate: rr, acceleration: { x: 0, y: 0, z: 0 } }, t); if (s) { out.push(s); feed && feed(s, t); }
  }
  return { pad, out };
}
const wiggle = [[0.4, [2, 0, 0]], [0.4, [0, -2.5, 0]], [0.4, [0, 0, 3]], [0.4, [-2, 1, -1]]];
const unwiggle = [...wiggle].reverse().map(([d, w]) => [d, w.map(v => -v)]);      // back to the starting pose, where device x is level
for (const naming of ['xyz', 'zxy']) {
  const { pad, out } = run(naming, [...wiggle, [0.3, [0, 0, 4]]]);
  ok(pad.locked && pad.naming === naming && pad.sign === 1, `browser names the rates ${naming}: found (${pad.naming}, locked ${pad.locked})`);
  const last = out[out.length - 1];
  ok(near(last.r[0], 0, 1e-9) && near(last.r[1], 0, 1e-9) && near(last.r[2], 4, 1e-9), `${naming}: a 4 rad/s turn about device z reads r = [0,0,4]`);
  // r must agree with how q moves: world rate = q r, and q(t+dt) ~ q(t) exp(r dt)
  const a = out[out.length - 2], pred = qmul(a.q, qexp(last.r.map(v => v / 60))), dotp = Math.abs(pred[0] * last.q[0] + pred[1] * last.q[1] + pred[2] * last.q[2] + pred[3] * last.q[3]);
  ok(dotp > 0.999999, `${naming}: q and r describe the same turn`);
}
{ const pad = new PadMotion(); ok(pad.motion({ rotationRate: { alpha: 1, beta: 1, gamma: 1 } }, 0) === null, 'no orientation yet: nothing is sent');
  pad.orientation({ alpha: 0, beta: 0, gamma: 0 }, 0); ok(pad.motion({ rotationRate: null }, 0) === null, 'no gyro: nothing is sent');
  const s = pad.motion({ rotationRate: { alpha: 0, beta: 0, gamma: 0 }, acceleration: null }, 0.016); ok(s && s.a.every(v => v === 0), 'no accelerometer reading: a is zero'); }

// --- the whole way: MotionModel calibrates on the phone's samples and calls a swing
for (const naming of ['xyz', 'zxy']) {
  const model = new MotionModel(); model.startCalibration(); const ev = []; let ms = 0;
  // wiggle (the naming is learned), hold 5.5 s, tip the top up 40 deg about device x, settle, then a 1-handed forehand about device z
  const script = [...wiggle, ...unwiggle, [6.0, [0, 0, 0]], [0.5, [80 * DEG, 0, 0]], [1.5, [0, 0, 0]], [0.5, [-80 * DEG, 0, 0]], [1.0, [0, 0, 0]], [0.12, [0, 0, 6]], [0.16, [0, 0, 20]], [0.1, [0, 0, 5]], [1, [0, 0, 0]]];
  run(naming, script, (s, t) => { ms = t * 1000; for (const e of model.feed(s, ms)) ev.push(e); });
  if (process.env.DBG) { let l = ''; for (const e of ev) { const m = e.type + ':' + (e.msg || '') + (e.ok === false ? ' !' : ''); if (m !== l) console.log(m); l = m; } }
  ok(ev.some(e => e.type === 'calibrated'), `${naming}: MotionModel calibrates on phone samples`);
  const sw = ev.filter(e => e.type === 'swing');
  ok(sw.length >= 1 && sw[0].power > 5, `${naming}: a swing is called (${sw.length}, power ${sw[0] ? sw[0].power.toFixed(1) : '-'})`);
}
console.log(fails ? `\nFAIL: ${fails}` : '\nPASS'); process.exit(fails ? 1 : 0);
