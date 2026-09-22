// How a PHONE paddle behaves on the way to the model (NOTES 35): the browser's two sensor events, the relay's network, and
// what the player then sees. The truth is fake-bridge's synthesiser at 1 kHz. The "browser" fires deviceorientation and
// devicemotion at 60 Hz each on their OWN clocks (they come from different sensors, so they are never in step), names
// rotationRate the way Chrome (z,x,y) or Safari (x,y,z) does, and rounds like Chrome (0.1 deg, 0.1 deg/s). Samples then
// cross a network: a quiet one, or phone wifi (power save holds packets and lets them go in a burst).
// It reports, for the calm part of play (slow repositioning, then holding still):
//   flips      how often the rotationRate naming or sign changed after calibration (must be 0)
//   rough      paddle roughness at 120 Hz, % of the median frame step (test/jitter.mjs's measure; the AirPod gets ~9 %)
//   tiltSD     wobble of p.tilt while holding still, degrees (it drives walking forward/back; the dead zone is 14)
//   walks      frames spent walking while holding still (should be 0)
//   resets     times the model threw its state away over a gap (each one snaps the paddle)
// Usage: node test/phone-jitter.mjs        (exit 1 if a scenario is out of bounds)
import { makeSynth, CALIBRATE } from './fake-bridge.mjs';
import { PadMotion } from '../web/padmotion.js';
import { MotionModel, qrot } from '../web/motion.js';
const DEG = Math.PI / 180, G = 9.80665;
function toEuler(q) { const R = [qrot(q, [1, 0, 0]), qrot(q, [0, 1, 0]), qrot(q, [0, 0, 1])], m = (r, c) => R[c][r];
  return [Math.atan2(-m(0, 1), m(1, 1)) / DEG, Math.asin(Math.max(-1, Math.min(1, m(2, 1)))) / DEG, Math.atan2(-m(2, 0), m(2, 2)) / DEG]; }
const q1 = v => Math.round(v * 10) / 10;
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// picked up with hardly a turn (the realistic case), calibrated, then 8 s of slow repositioning sweeps, then 4 s held still
const PICKUP = [{ T: 0.6, axis: [0.2, 1, 0.1], deg: 6 }, { T: 0.6, axis: [0.2, 1, 0.1], deg: -6 }];
const SWEEP = []; for (let i = 0; i < 4; i++) SWEEP.push({ T: 1.0, axis: [0, 1, 0], deg: 28 }, { T: 1.0, axis: [0, 1, 0], deg: -28 });
const SCRIPT = [...PICKUP, ...CALIBRATE, { T: 1.0 }, ...SWEEP, { T: 4.0 }];
const T_END = SCRIPT.reduce((a, s) => a + s.T, 0), T_SWEEP = T_END - 4.0 - 8.0, T_HOLD = T_END - 4.0;

export function run({ naming = 'zxy', net = 'quiet', seed = 3, pad = new PadMotion(naming) } = {}) {
  const syn = makeSynth({ heading: 70, grip: [0.9, 0.2, -0.3, 1.2], script: SCRIPT, rateHz: 1000, gyroNoise: 0.004, seed, t0: 0 });
  const truth = []; for (let i = 0; i <= T_END * 1000; i++) truth.push(syn.next());
  const at = t => truth[Math.min(truth.length - 1, Math.max(0, Math.round(t * 1000)))];
  const rnd = rng(seed * 7 + 1), ev = [];
  const phO = rnd() / 60, phM = rnd() / 60;                      // the two sensors tick out of step
  for (let t = phO; t < T_END; t += 1 / 60) ev.push({ kind: 'o', t: t + (rnd() - 0.5) * 0.002 });
  for (let t = phM; t < T_END; t += 1 / 60) ev.push({ kind: 'm', t: t + (rnd() - 0.5) * 0.002 });
  ev.sort((a, b) => a.t - b.t);
  const sent = [];
  for (const e of ev) { const s = at(e.t);
    if (e.kind === 'o') { const [al, be, ga] = toEuler(s.q); pad.orientation({ alpha: q1(al), beta: q1(be), gamma: q1(ga) }, e.t); continue; }
    const d = s.r.map(v => q1(v / DEG)), rr = naming === 'xyz' ? { alpha: d[0], beta: d[1], gamma: d[2] } : { alpha: d[2], beta: d[0], gamma: d[1] };
    const out = pad.motion({ rotationRate: rr, acceleration: { x: q1(s.a[0] * G), y: q1(s.a[1] * G), z: q1(s.a[2] * G) } }, e.t);
    if (out) sent.push({ s: JSON.parse(JSON.stringify(out)), t: e.t, n: pad.naming + pad.sign });
    if (pad.flush) for (const x of pad.flush()) sent.push({ s: x, t: e.t, n: pad.naming + pad.sign });
  }
  // the model gets what main.js gives a phone (PHONE_BUFFER 0.2 s). The network: base 25 ms. wifi: power save holds packets for 40-220 ms every 150-500 ms, then lets them all through
  let holdUntil = -1, nextHold = 0.3; const arr = [];
  for (const x of sent) { let a = x.t + 0.025 + rnd() * 0.004;
    if (net === 'wifi') { if (x.t > nextHold) { holdUntil = x.t + 0.04 + rnd() * 0.18; nextHold = holdUntil + 0.15 + rnd() * 0.35; } if (x.t < holdUntil) a = holdUntil + 0.025 + rnd() * 0.004; }
    arr.push({ a, s: x.s, n: x.n }); }
  for (let i = 1; i < arr.length; i++) arr[i].a = Math.max(arr[i].a, arr[i - 1].a);   // one TCP stream: in order
  const m = new MotionModel({ BUFFER_MAX: 0.2 }); m.startCalibration(); let resets = 0; const st = m._start.bind(m); m._start = s => { if (m.calibrated && calAt != null) resets++; return st(s); };
  let k = 0, calAt = null, nAtCal = null, flips = 0, lastN = null, prev = null; const steps = [], tilts = []; let walks = 0;
  for (let f = 0; f < (T_END + 0.3) * 120; f++) {
    const now = f / 120;
    while (k < arr.length && arr[k].a <= now) { for (const e of m.feed(arr[k].s, arr[k].a * 1000)) if (e.type === 'calibrated') { calAt = arr[k].s.t; nAtCal = arr[k].n; }
      if (calAt != null) { if (lastN != null && arr[k].n !== lastN) flips++; lastN = arr[k].n; } k++; }
    const p = m.pose(now * 1000); if (!p.calibrated) continue;
    const tRender = now - 0.03;
    if (tRender > T_SWEEP + 0.5 && tRender < T_HOLD) { const v = [p.x + p.offset[0], p.y + p.offset[1], p.offset[2], p.P[0], p.P[1], p.P[2]];
      if (prev) steps.push(Math.hypot(v[0] - prev[0], v[1] - prev[1], v[2] - prev[2]) + Math.hypot(v[3] - prev[3], v[4] - prev[4], v[5] - prev[5])); prev = v; }
    if (tRender > T_HOLD + 0.8 && tRender < T_END - 0.2) { tilts.push(p.tilt / DEG); if (Math.abs(p.tilt) > 14 * DEG && !p.swinging && p.rate <= 3.5) walks++; }
  }
  const med = [...steps].sort((a, b) => a - b)[steps.length >> 1] || 1;
  const rough = steps.length > 2 ? steps.slice(1).reduce((a, d, i) => a + Math.abs(d - steps[i]), 0) / steps.length / med * 100 : NaN;
  const mean = tilts.reduce((a, b) => a + b, 0) / (tilts.length || 1), tiltSD = Math.sqrt(tilts.reduce((a, b) => a + (b - mean) ** 2, 0) / (tilts.length || 1));
  return { calibrated: calAt != null, flips, lock: pad.locked, naming: pad.naming + (pad.sign < 0 ? '-' : '+'), rough, tiltSD, tiltMean: mean, walks, resets, D: m.D };
}

import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let bad = 0;
  for (const naming of ['zxy', 'xyz']) for (const net of ['quiet', 'wifi']) for (const seed of [3, 4, 5, 6, 7]) {
    const r = run({ naming, net, seed });
    const ok = r.calibrated && r.flips === 0 && r.naming.startsWith(naming) && r.naming.endsWith('+') && r.rough < 15 && r.walks === 0 && r.resets === 0;
    if (!ok) bad++;
    console.log(`${ok ? 'ok  ' : 'BAD '} ${naming === 'zxy' ? 'Chrome' : 'Safari'} ${net.padEnd(5)} seed ${seed}: calibrated ${r.calibrated ? 'y' : 'N'}  flips ${r.flips}  naming ${r.naming}${r.lock ? '' : '?'}  rough ${r.rough.toFixed(0)}%  tiltSD ${r.tiltSD.toFixed(2)}°  walks ${r.walks}  resets ${r.resets}  delay ${(r.D * 1000).toFixed(0)} ms`);
  }
  console.log(bad ? `\nPHONE JITTER: ${bad} bad` : '\nPHONE JITTER PASS'); process.exit(bad ? 1 : 0);
}
