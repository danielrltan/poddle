// node test/motion.test.mjs   -- exits non-zero on failure. Motion is synthesised from first principles (fake-bridge.mjs).
import { MotionModel, DEFAULTS, armOffset, qrot } from '../web/motion.js';
import { makeSynth, CALIBRATE, SESSION_LOOP, rotM, quatFromM } from './fake-bridge.mjs';
import fs from 'node:fs';

const DEG = Math.PI / 180;
let fails = 0, checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) { fails++; console.log('  FAIL ' + msg); } else if (process.env.V) console.log('  ok   ' + msg); };
const f = (v, n = 3) => (+v).toFixed(n);
const median = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

const HEADINGS = [0, 137, 251, -63];
const GRIPS = [[0.3, -0.5, 0.8, 1.1], [1, 0.2, -0.4, 2.6], [-0.7, 0.7, 0.1, -1.9]];       // axis + angle (rad): how the bud sits in the hand
const NEUTRAL = [{ T: 0.4 }];

// Drive a model on a real timeline: samples arrive LAT ms after their timestamp, pose() is polled at poseHz in between.
function run(syn, seconds, { model = new MotionModel(), poseHz = 120, lat = 7, onPose, onEvent, onSample } = {}) {
  const n = Math.round(seconds * 50), t0ms = syn.t0 * 1000 + 123456;       // arbitrary local-clock offset
  let pk = 0;
  for (let k = 0; k < n; k++) {
    const s = syn.next(), arrive = t0ms + s._t * 1000 + lat;
    while (onPose && pk / poseHz * 1000 + t0ms + lat < arrive) { const now = pk / poseHz * 1000 + t0ms + lat; onPose(model.pose(now), pk / poseHz, now); pk++; }
    const evs = model.feed({ t: s.t, q: s.q, r: s.r, a: s.a }, arrive);
    if (onSample) onSample(s, model);
    for (const e of evs) if (onEvent) onEvent(e, s._t, model);
  }
  return model;
}
const calibrated = (opts, script, more = {}) => makeSynth({ ...opts, script: [...CALIBRATE, ...script], ...more });
const CAL_T = CALIBRATE.reduce((a, s) => a + s.T, 0);

// ---------- 0. the synthesiser itself: q, r consistent, conventions as CONTRACT says ----------
console.log('0. synthesiser self-check');
{
  const syn = makeSynth({ heading: 137, script: [{ T: 0.5, axis: [0.2, 1, 0.3], deg: 80 }] });
  const a = syn.next(), b = syn.next(); let s = a, s2 = b; for (let i = 0; i < 10; i++) { s = s2; s2 = syn.next(); }
  const M = syn.truth(s._t).M, v = [0.3, -0.8, 0.5];
  const viaQ = qrot(s.q, v), viaM = M.map(r => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
  ok(Math.hypot(...viaQ.map((x, i) => x - viaM[i])) < 1e-9, 'q rotates device->reference exactly like the ground-truth matrix');
  // body rate vs finite difference of the q sequence: q1 ~ q0 * exp(r dt/2)  =>  r ~ 2 * (q0^-1 q1).xyz / dt
  const q0 = s.q, q1 = s2.q, c = [-q0[0], -q0[1], -q0[2], q0[3]];
  const dq = [c[3] * q1[0] + c[0] * q1[3] + c[1] * q1[2] - c[2] * q1[1], c[3] * q1[1] - c[0] * q1[2] + c[1] * q1[3] + c[2] * q1[0], c[3] * q1[2] + c[0] * q1[1] - c[1] * q1[0] + c[2] * q1[3], c[3] * q1[3] - c[0] * q1[0] - c[1] * q1[1] - c[2] * q1[2]];
  const sg = dq[3] < 0 ? -1 : 1, fd = [0, 1, 2].map(i => 2 * sg * dq[i] / 0.02), rm = [0, 1, 2].map(i => (s.r[i] + s2.r[i]) / 2);
  ok(Math.hypot(...fd.map((x, i) => x - rm[i])) < 0.03 * Math.hypot(...rm), `body rate r matches the q sequence (fd ${fd.map(x => f(x, 2))} vs r ${rm.map(x => f(x, 2))})`);
}

// ---------- 1. calibration ----------
console.log('1. calibration');
for (const heading of HEADINGS) for (const grip of GRIPS) {
  const evs = []; const m = run(calibrated({ heading, grip }, NEUTRAL), CAL_T + 0.4, { onEvent: (e, t) => evs.push({ ...e, t }) });
  const cal = evs.find(e => e.type === 'calibrated');
  ok(!!cal && m.pose().calibrated, `h${heading} completes`);
  const holds = evs.filter(e => e.type === 'cal' && e.stage === 'hold');
  ok(holds.length > 200 && holds.every((e, i) => i === 0 || e.progress >= holds[i - 1].progress || !e.ok), `h${heading} hold progress is monotonic except on wobble`);
  if (cal) {
    const tr = makeSynth({ heading, grip }).truth(0);
    ok(Math.hypot(...m.B.R.map((v, i) => v - tr.R[i])) < 0.03, `h${heading} right axis recovered (${m.B.R.map(v => f(v, 2))} vs ${tr.R.map(v => f(v, 2))})`);
    ok(Math.hypot(...m.B.F.map((v, i) => v - tr.F[i])) < 0.03, `h${heading} forward axis recovered`);
  }
}
{ // wobble > 10 deg in the middle of the hold resets it
  const script = [{ T: 1 }, { T: 2.5 }, { T: 0.3, axis: [0, 1, 0.5], deg: 14 }, { T: 0.3, axis: [0, 1, 0.5], deg: -14 }, { T: 5.5 }, { T: 0.7, axis: [1, 0, 0], deg: 35 }, { T: 0.5 }];
  const evs = []; run(makeSynth({ heading: 40, script }), 11, { onEvent: (e, t) => evs.push({ ...e, t }) });
  const bad = evs.find(e => e.type === 'cal' && e.stage === 'hold' && !e.ok);
  ok(!!bad && bad.t > 3.4 && bad.t < 4.2, `wobble of 14 deg flags ok:false (t=${bad && f(bad.t, 2)})`);
  const after = evs.find(e => e.type === 'cal' && e.t > (bad ? bad.t : 0) + 0.05);
  ok(after && after.progress < 0.1, 'progress went back to ~0 after the wobble');
  const firstTilt = evs.find(e => e.stage === 'tilt');
  ok(firstTilt && firstTilt.t > 8.5, `hold finished 5 s after the wobble, not before (tilt stage began t=${firstTilt && f(firstTilt.t, 2)})`);
  ok(evs.some(e => e.type === 'calibrated'), 'still calibrates afterwards');
}
{ // a twist (yaw about vertical) and a 60-deg-off-horizontal axis are rejected; a proper tilt afterwards is accepted
  for (const axis of [[0, 1, 0], [0.5, 0.866, 0]]) {
    const script = [{ T: 1 }, { T: 5.5 }, { T: 0.6, axis, deg: 35 }, { T: 0.4 }, { T: 0.6, axis, deg: -35 }, { T: 0.4 }, { T: 0.7, axis: [1, 0, 0], deg: 35 }, { T: 0.5 }];
    const evs = []; run(makeSynth({ heading: 251, script }), 10, { onEvent: (e, t) => evs.push({ ...e, t }) });
    const rej = evs.find(e => e.stage === 'tilt' && !e.ok), done = evs.find(e => e.type === 'calibrated');
    ok(!!rej && rej.t < 7.5, `twist about [${axis}] rejected`);
    ok(!!done && done.t > 8.5, `...and not accepted until the real tilt (t=${done && f(done.t, 2)})`);
  }
}

// ---------- 2. pointing, for every heading x grip ----------
console.log('2. pointer -> x,y and player-frame rotation P');
for (const heading of HEADINGS) for (const grip of GRIPS) {
  const tag = `h${heading} g${GRIPS.indexOf(grip)}`;
  const script = [...NEUTRAL, { T: 0.4, axis: [0, 1, 0], deg: -20 }, { T: 0.6, tag: 'R' }, { T: 0.4, axis: [0, 1, 0], deg: 20 },
    { T: 0.4, axis: [1, 0, 0], deg: 20 }, { T: 0.6, tag: 'U' }, { T: 0.4, axis: [1, 0, 0], deg: -20 }, { T: 0.6, tag: 'N' }, { T: 0.4, axis: [0, 1, 0], deg: 25 }, { T: 0.6, tag: 'L' }];
  const syn = calibrated({ heading, grip }, script); const at = {};
  const want = {}; for (const k of 'RUNL') { const g = syn.tagTime(k); want[k] = g.t0 + g.T - 0.05; }
  run(syn, CAL_T + 5, { onPose: (p, t) => { for (const k of 'RUNL') if (!at[k] && t >= want[k]) at[k] = p; } });
  const fwd = p => qrot(p.P, [0, 0, -1]);
  ok(at.R.x > 0 && Math.abs(at.R.x - 20 / 35 * 3) < 0.15, `${tag} pointing right 20deg -> x=${f(at.R.x)} (want +1.714)`);
  ok(Math.abs(at.R.y - 1) < 0.1, `${tag} ...y stays ${f(at.R.y)}`);
  ok(fwd(at.R)[0] > 0.3 && Math.abs(fwd(at.R)[1]) < 0.05, `${tag} P turns the paddle's nose right (${fwd(at.R).map(v => f(v, 2))})`);
  ok(at.U.y > 1.0 && Math.abs(at.U.y - (1 + 20 / 30 * 0.9)) < 0.1, `${tag} pointing up 20deg -> y=${f(at.U.y)} (want 1.6)`);
  ok(Math.abs(at.U.x) < 0.15, `${tag} ...x stays ${f(at.U.x)}`);
  ok(fwd(at.U)[1] > 0.3 && Math.abs(fwd(at.U)[0]) < 0.05, `${tag} P tips the paddle's nose up (${fwd(at.U).map(v => f(v, 2))})`);
  ok(Math.abs(at.N.x) < 0.1 && Math.abs(at.N.y - 1) < 0.1 && fwd(at.N)[2] < -0.99, `${tag} neutral -> x=${f(at.N.x)} y=${f(at.N.y)}`);
  ok(at.L.x < -1.9, `${tag} pointing left 25deg -> x=${f(at.L.x)}`);
  ok(Math.hypot(...at.N.offset) < 0.03 && Math.hypot(...at.R.offset) < 0.03, `${tag} no arc offset while just pointing (${f(Math.hypot(...at.R.offset))})`);
}

// ---------- 3. swing events: dir, lob, power ----------
console.log('3. swing detection');
for (const heading of HEADINGS) for (const grip of GRIPS.slice(0, 2)) {
  const cases = [
    { name: 'forehand R->L (CCW)', axis: [0, 1, 0], deg: 120, T: 0.2, chk: e => e.dir < -0.7 && e.lob < 0.15 },
    { name: 'mirror L->R (CW)', axis: [0, -1, 0], deg: 120, T: 0.2, chk: e => e.dir > 0.7 && e.lob < 0.15 },
    { name: 'upward scoop', axis: [1, 0, 0], deg: 100, T: 0.2, chk: e => e.lob > 0.3 && Math.abs(e.dir) < 0.3 },
    { name: 'downward chop', axis: [-1, 0, 0], deg: 80, T: 0.2, chk: e => e.lob === 0 },
    { name: 'fast flat drive 35 rad/s', axis: [0.1, 1, 0], deg: 120, T: 0.12, chk: e => e.dir < -0.7 },
    { name: 'slow push 14 rad/s', axis: [0, 1, 0], deg: 120, T: 0.3, chk: e => e.dir < -0.7 },
    { name: 'topspin forehand', axis: [0.6, 1, 0], deg: 110, T: 0.18, chk: e => e.dir < -0.5 && e.lob > 0.3 },
  ];
  for (const cs of cases) {
    const script = [...NEUTRAL, { T: cs.T, axis: cs.axis, deg: cs.deg, tag: 'S' }, { T: 0.8 }];
    const syn = calibrated({ heading, grip }, script), g = syn.tagTime('S'); const evs = []; let trigT = null;
    run(syn, CAL_T + 0.4 + cs.T + 0.8, { onEvent: (e, t) => { if (e.type.startsWith('swing')) evs.push({ ...e, t }); }, onSample: s => { if (trigT == null && Math.hypot(...s.r) > 9) trigT = s._t; } });
    const sw = evs.filter(e => e.type === 'swing'), end = evs.filter(e => e.type === 'swingEnd'), tag = `h${heading} g${GRIPS.indexOf(grip)} ${cs.name}`;
    ok(sw.length === 1 && end.length === 1, `${tag}: exactly one swing + one swingEnd (${sw.length}, ${end.length})`);
    if (!sw.length) continue;
    ok(cs.chk(sw[0]), `${tag}: dir=${f(sw[0].dir, 2)} lob=${f(sw[0].lob, 2)}`);
    ok(Math.abs(sw[0].power - g.peak) / g.peak < 0.10, `${tag}: power ${f(sw[0].power, 1)} vs true peak ${f(g.peak, 1)}`);
    ok(end.length && Math.abs(end[0].peak - g.peak) / g.peak < 0.05, `${tag}: swingEnd peak ${end.length && f(end[0].peak, 1)}`);
    const delay = sw[0].t - trigT;
    ok(delay >= 0 && delay <= 0.045, `${tag}: fired ${f(delay * 1000, 0)} ms after the trigger sample`);   // swings are reported early, on a predicted peak (was: 59-85 ms)
  }
}

// ---------- 4/5/6. the arc: path length, settle, smoothness, base freeze ----------
console.log('4-6. kinematic arm, smoothness at 120Hz, base freeze');
function swingTrace(opts, script, secs, poseHz = 120, lat = 7) {
  const syn = calibrated(opts, script, opts.more || {}); const tr = [];
  const model = run(syn, CAL_T + secs, { poseHz, lat, onPose: (p, t) => { if (p.calibrated) tr.push({ t, x: p.x, y: p.y, o: p.offset, P: p.P, punch: p.punch, pt: [p.x + p.offset[0], p.y + p.offset[1], p.offset[2]] }); } });
  return { syn, tr, model };
}
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
for (const heading of HEADINGS) for (const grip of GRIPS.slice(0, 2)) for (const poseHz of [120, 60]) {
  const tag = `h${heading} g${GRIPS.indexOf(grip)} @${poseHz}Hz`;
  const script = [...NEUTRAL, { T: 0.2, axis: [0, 1, 0], deg: 120, tag: 'S' }, { T: 1.2 }];
  const { syn, tr } = swingTrace({ heading, grip }, script, 1.8, poseHz), g = syn.tagTime('S'), a = g.t0, b = g.t0 + g.T;
  const lat = 0.007, seg = tr.filter(p => p.t >= a && p.t <= b + 0.1);
  let path = 0; for (let i = 1; i < seg.length; i++) path += dist(seg[i].pt, seg[i - 1].pt);
  ok(path > 1.0, `${tag} (4) paddle point sweeps ${f(path, 2)} m during a 120deg swing`);
  const far = Math.max(...seg.map(p => Math.hypot(...p.o)));
  ok(far > 0.9 && far < 1.8, `${tag} (4) furthest from base ${f(far, 2)} m`);
  const mid = seg.reduce((m, p) => (Math.abs(p.t - (a + b) / 2 - lat) < Math.abs(m.t - (a + b) / 2 - lat) ? p : m));
  ok(mid.o[0] < -0.3 && mid.o[2] > 0, `${tag} (4) CCW forehand carries the paddle LEFT and back toward the player (${mid.o.map(v => f(v, 2))})`);
  const late = tr.filter(p => p.t >= b + 0.6);
  ok(late.length && Math.max(...late.map(p => Math.hypot(...p.o))) < 0.03, `${tag} (4) back within 3 cm of base 0.6 s after (${f(Math.max(...late.map(p => Math.hypot(...p.o))) * 100, 1)} cm)`);
  // (5) smoothness: every step vs the median step, globally over the fast part and locally everywhere in the swing
  const steps = []; for (let i = 1; i < tr.length; i++) steps.push({ t: tr[i].t, d: dist(tr[i].pt, tr[i - 1].pt) });
  const core = steps.filter(s => s.t >= a + 0.25 * g.T && s.t <= b - 0.25 * g.T + lat), med = median(core.map(s => s.d));
  const whole = steps.filter(s => s.t >= a - 0.05 && s.t <= b + 0.3);
  const worst = Math.max(...whole.map(s => s.d));
  ok(worst < 2.5 * med, `${tag} (5) largest frame step ${f(worst * 100, 1)} cm < 2.5 x median swing step ${f(med * 100, 1)} cm`);
  let worstLocal = 0;
  for (let i = 3; i < whole.length - 3; i++) { const lm = median(whole.slice(i - 3, i + 4).map(s => s.d)); if (lm > 0.01) worstLocal = Math.max(worstLocal, whole[i].d / lm, lm / Math.max(whole[i].d, 1e-9) > 4 ? 9 : 0); }
  ok(worstLocal < 2.5, `${tag} (5) no stall/jump vs the local 7-frame median (worst ratio ${f(worstLocal, 2)})`);
  // (6) base freeze
  const xs = tr.filter(p => p.t >= a - 0.02 && p.t <= b + 0.15).map(p => p.x);
  ok(Math.max(...xs) - Math.min(...xs) < 0.35 && Math.abs(xs[xs.length - 1]) < 0.35, `${tag} (6) base x moved ${f(Math.max(...xs) - Math.min(...xs), 3)} m during the swing`);
}
{ // accuracy of pose() between samples vs ground truth, incl. mid-swing (proves the rate sign used for extrapolation)
  for (const heading of [0, 137]) {
    const script = [...NEUTRAL, { T: 0.6, axis: [0.3, 1, 0.4], deg: 100, tag: 'M' }, { T: 0.3 }, { T: 0.2, axis: [0, 1, 0.2], deg: -120, tag: 'S' }, { T: 0.5 }];
    const syn = calibrated({ heading }, script), gm = syn.tagTime('M'), gs = syn.tagTime('S'), ref = makeSynth({ heading, script: [...CALIBRATE, ...script] });
    let errM = 0, errS = 0;
    run(syn, CAL_T + 2.2, { lat: 0, onPose: (p, t) => {
      if (!p.calibrated) return;
      const tr = ref.truth(t), D = tr.D, toP = v => [v[0] * tr.R[0] + v[1] * tr.R[1] + v[2] * tr.R[2], v[2], -(v[0] * tr.F[0] + v[1] * tr.F[1] + v[2] * tr.F[2])];
      // ground-truth P as a matrix: columns are D applied to the player axes, re-expressed in player axes
      const v = [0.2, -0.5, -0.8], vw = [0, 1, 2].map(i => v[0] * tr.R[i] + v[1] * tr.U[i] - v[2] * tr.F[i]);
      const want = toP(D.map(r => r[0] * vw[0] + r[1] * vw[1] + r[2] * vw[2])), got = qrot(p.P, v), e = dist(want, got);
      if (t > gm.t0 && t < gm.t0 + gm.T) errM = Math.max(errM, e);
      if (t > gs.t0 && t < gs.t0 + gs.T) errS = Math.max(errS, e);
    } });
    ok(errM < 0.02, `h${heading} pose().P tracks truth between samples at 5 rad/s (max err ${f(errM, 4)})`);
    ok(errS < 0.12, `h${heading} ...and mid-swing at 21 rad/s (max err ${f(errS, 4)}; un-extrapolated would be ~0.4)`);
  }
}
{ // abrupt stop: no overshoot past where the hand actually stopped
  for (const heading of [0, 137]) {
    const script = [...NEUTRAL, { T: 0.16, axis: [0, 1, 0], deg: 110, profile: 'abrupt', tag: 'S' }, { T: 0.6 }];
    const { syn, tr } = swingTrace({ heading }, script, 1.2), g = syn.tagTime('S');
    const yaw = p => { const v = qrot(p.P, [0, 0, -1]); return Math.atan2(-v[0], -v[2]); };   // CCW about up
    const mx = Math.max(...tr.filter(p => p.t > g.t0).map(yaw));
    ok(mx < 110 * DEG + 0.05, `h${heading} abrupt stop from ${f(g.peak, 0)} rad/s: rendered swing angle peaks ${f(mx / DEG, 1)} deg vs true 110 (overshoot < 3 deg)`);
    const steps = []; for (let i = 1; i < tr.length; i++) if (tr[i].t > g.t0 + g.T && tr[i].t < g.t0 + g.T + 0.1) steps.push(dist(tr[i].pt, tr[i - 1].pt));
    ok(Math.max(...steps) < 0.12, `h${heading} ...and no snap-back after it (largest step after the stop ${f(Math.max(...steps) * 100, 1)} cm)`);
  }
}
{ // rest jitter with gyro noise
  for (const heading of [0, 137]) {
    const { tr } = swingTrace({ heading, more: { gyroNoise: 0.02, accNoise: 0.005, seed: 11 } }, [{ T: 3 }], 3);
    const o = tr.filter(p => p.t > CAL_T + 0.5).map(p => p.o), mean = [0, 1, 2].map(i => o.reduce((a, v) => a + v[i], 0) / o.length);
    const jit = Math.max(...o.map(v => dist(v, mean))), mag = Math.max(...o.map(v => Math.hypot(...v)));
    ok(jit < 0.005 && mag < 0.005, `h${heading} (4) offset jitter at rest with 0.02 rad/s noise: ${f(jit * 1000, 2)} mm (max |offset| ${f(mag * 1000, 2)} mm)`);
  }
}
{ // slow backswing then forehand: base goes back to where the player was aiming, arc passes through it
  const script = [...NEUTRAL, { T: 0.4, axis: [0, 1, 0], deg: -15 }, { T: 0.5, tag: 'aim' }, { T: 0.45, axis: [0, 1, 0], deg: -50, tag: 'back' }, { T: 0.2, axis: [0, 1, 0], deg: 120, tag: 'S' }, { T: 1 }];
  const { syn, tr } = swingTrace({ heading: 137 }, script, 3), g = syn.tagTime('S'), aim = syn.tagTime('aim');
  const xAim = tr.filter(p => p.t < aim.t0 + aim.T).pop().x, during = tr.filter(p => p.t > g.t0 + 0.1 && p.t < g.t0 + g.T + 0.1);
  ok(Math.max(...during.map(p => Math.abs(p.x - xAim))) < 0.35, `(6b) after a 50deg backswing the base is back at the aim point x=${f(xAim, 2)} (swing-time x ${f(during[0].x, 2)}..${f(during[during.length - 1].x, 2)})`);
  const ox = during.map(p => p.o[0]); ok(Math.max(...ox) > 0.15 && Math.min(...ox) < -0.3, `(6b) arc runs from right of the aim point (${f(Math.max(...ox), 2)}) to left of it (${f(Math.min(...ox), 2)})`);
}

// ---------- punch ----------
console.log('punch (leaky acceleration)');
{
  const script = [...NEUTRAL, { T: 0.2, axis: [0, 1, 0], deg: 120, tag: 'S' }, { T: 1.5 }];
  const { syn, tr, model } = swingTrace({ heading: 137 }, script, 2.1), g = syn.tagTime('S');
  const pm = tr.map(p => Math.hypot(...p.punch)), peak = Math.max(...pm);
  ok(peak > 0.05 && peak <= DEFAULTS.PUNCH_CAP + 1e-9, `punch peaks at ${f(peak, 3)} m (cap ${DEFAULTS.PUNCH_CAP})`);
  ok(Math.max(...tr.filter(p => p.t > g.t0 + g.T + 0.8).map(p => Math.hypot(...p.punch))) < 0.005, 'punch is back to zero 0.8 s after');
  ok(Math.max(...tr.filter(p => p.t < g.t0 - 0.05).map(p => Math.hypot(...p.punch))) < 0.002, 'punch is zero at rest before');
  const early = tr.find(p => p.t > g.t0 + 0.07); ok(early.punch[0] < -0.02, `punch leads the motion (CCW swing -> leftward, x=${f(early.punch[0], 3)})`);
  ok(model.accSign === -1, 'accSign stays -1 when the data really is CoreMotion-signed');
  // same motion but the sensor reports +accel: the centripetal check must flip the sign within a few swings
  const many = []; for (let i = 0; i < 4; i++) many.push({ T: 0.2, axis: [0, 1, 0], deg: 120 }, { T: 0.3 }, { T: 0.7, axis: [0, 1, 0], deg: -120 }, { T: 0.3 });
  const m2 = swingTrace({ heading: 137, more: { accSign: +1 } }, [...NEUTRAL, ...many], 6.5).model;
  ok(m2.accSign === +1, 'accSign self-corrects to +1 when the sensor sign is the other way');
}

// ---------- 7. recenter ----------
console.log('7. recenter');
for (const heading of HEADINGS) {
  const script = [...NEUTRAL, { T: 0.4, axis: [0.2, 1, 0], deg: -22 }, { T: 2 }];
  const syn = calibrated({ heading }, script); let did = false, before = null, right = null, later = null;
  const model = new MotionModel();
  run(syn, CAL_T + 2.4, { model, onPose: (p, t, now) => {
    if (!did && t > CAL_T + 1.5) { before = p; model.recenter(); did = true; right = model.pose(now); }
    if (did && t > CAL_T + 2.2) later = p;
  } });
  ok(before.x > 1.5, `h${heading} before: x=${f(before.x)}`);
  ok(Math.abs(right.x) < 1e-6 && Math.abs(right.y - before.y) < 0.02, `h${heading} recenter() zeros x immediately (x=${f(right.x, 4)}, y ${f(before.y, 2)} -> ${f(right.y, 2)})`);
  ok(Math.abs(later.x) < 0.05 && Math.hypot(...later.offset) < 0.02, `h${heading} ...and it stays there (x=${f(later.x)})`);
  ok(Math.abs(qrot(later.P, [0, 0, -1])[0]) < 0.03, `h${heading} ...and P faces forward again`);
}

// ---------- extras: armOffset, latency jitter, the scripted session, the real capture ----------
console.log('extras');
{
  ok(Math.hypot(...armOffset([0, 0, 0, 1])) < 1e-12, 'armOffset(identity) = 0');
  const o = armOffset(quatFromM(rotM([0, 1, 0], 60 * DEG))); ok(o[0] < -0.4 && o[2] > 0.2, `armOffset(60deg CCW about up) goes left and back (${o.map(v => f(v, 2))})`);
  const u = armOffset(quatFromM(rotM([1, 0, 0], 45 * DEG))); ok(u[1] > 0.4, `armOffset(45deg tip up) goes up (${u.map(v => f(v, 2))})`);
}
{ // bursty websocket arrival (0-25 ms random lateness) must not wreck smoothness
  const script = [...NEUTRAL, { T: 0.2, axis: [0, 1, 0], deg: 120, tag: 'S' }, { T: 1 }];
  const syn = calibrated({ heading: 137 }, script), g = syn.tagTime('S'), model = new MotionModel(), rnd = (() => { let s = 5; return () => (s = (s * 16807) % 2147483647) / 2147483647; })();
  const evq = []; const base = 5e6; for (let k = 0; k < (CAL_T + 1.6) * 50; k++) { const s = syn.next(); evq.push({ at: base + s._t * 1000 + 5 + rnd() * 25, s }); }
  const pts = []; let i = 0, lastAt = 0;
  for (let pk = 0; pk < (CAL_T + 1.6) * 120; pk++) { const now = base + pk / 120 * 1000;
    while (i < evq.length && Math.max(evq[i].at, lastAt) <= now) { lastAt = Math.max(evq[i].at, lastAt); model.feed(evq[i].s, lastAt); i++; }
    const p = model.pose(now); if (p.calibrated) pts.push({ t: pk / 120, pt: [p.x + p.offset[0], p.y + p.offset[1], p.offset[2]] }); }
  const steps = []; for (let j = 1; j < pts.length; j++) steps.push({ t: pts[j].t, d: dist(pts[j].pt, pts[j - 1].pt) });
  const core = steps.filter(s => s.t >= g.t0 + 0.05 && s.t <= g.t0 + g.T - 0.03), med = median(core.map(s => s.d)), worst = Math.max(...steps.filter(s => s.t > g.t0 - 0.05 && s.t < g.t0 + g.T + 0.3).map(s => s.d));
  ok(worst < 2.5 * med, `jittery arrival: largest step ${f(worst * 100, 1)} cm < 2.5 x median ${f(med * 100, 1)} cm`);
}
{ // the fake-bridge session: calibrates, then forehand / backhand / lob come out with the right signs, forever
  const syn = makeSynth({ heading: 137, script: CALIBRATE, loop: SESSION_LOOP, gyroNoise: 0.02, accNoise: 0.005, seed: 7 }); const sw = []; let xmin = 0, xmax = 0, bad = 0;
  run(syn, CAL_T + 2 * syn.loopDur, { onEvent: (e, t) => { if (e.type === 'swing') sw.push({ ...e, t }); }, onPose: p => { xmin = Math.min(xmin, p.x); xmax = Math.max(xmax, p.x); if (![p.x, p.y, ...p.P, ...p.offset].every(Number.isFinite)) bad++; } });
  ok(sw.length === 6, `scripted session: 6 swings in two loops (${sw.length})`);
  ok(sw.length === 6 && sw[0].dir < -0.5 && sw[1].dir > 0.5 && sw[2].lob > 0.3 && sw[3].dir < -0.5 && sw[4].dir > 0.5 && sw[5].lob > 0.3, `forehand/backhand/lob signs: ${sw.map(e => `${f(e.dir, 1)}/${f(e.lob, 1)}`).join(' ')}`);
  ok(xmin < -1.2 && xmax > 1.2 && bad === 0, `pointing left/right reaches x ${f(xmin, 2)}..${f(xmax, 2)}, all finite`);
}
{ // real capture: never NaN, never a phantom swing from an idle hand
  const lines = fs.readFileSync(new URL('../data/live-capture.jsonl', import.meta.url), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const m = new MotionModel({ HOLD_MS: 1500 }); let swings = 0, bad = 0;
  for (const s of lines) { for (const e of m.feed(s, s.t * 1000 + 40)) if (e.type === 'swing') swings++; const p = m.pose(s.t * 1000 + 50); if (![p.x, p.y, ...p.P, ...p.offset].every(Number.isFinite)) bad++; }
  ok(bad === 0 && swings === 0, `data/live-capture.jsonl (${lines.length} samples): all finite, ${swings} phantom swings`);
}

console.log(`\n${checks - fails}/${checks} checks passed`);
console.log('DEFAULTS ' + JSON.stringify(DEFAULTS));
process.exit(fails ? 1 : 0);
