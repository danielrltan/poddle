// What the player SEES: the local paddle's rendered world pose, rebuilt frame by frame, and how smooth it is.
//   pos = base (webcam x,y -> one-euro -> damp; tilt-walk z -> 20 Hz -> server 60 Hz -> scene lerp) + pose().offset,  rot = pose().P
// A MotionModel is fed synthetic hand motion through the REAL paired arrival timing (data/live2.jsonl), rendered at 60 and 120 Hz.
// Per scenario: wobble (what a 67 ms quadratic fit can't explain), jerk, step outliers vs the local median, angular-velocity jumps,
// and which part is to blame (base / offset / buffer delay / armW fade / clamp / tanh / punch). Findings: docs/jitter-diagnosis.md
//   node test/smooth.mjs [--brief] [--only still,slow,zigzag,stir,gentle,forehand,backhand,overhead,walk] [--hz 60,120] [--phases 4]
//                        [--module copy/of/motion.js] [--opts '{"ARC_LO":5}'] [--trace] [--sweep] [--ztau 0.12 | --zlocal] [--json out.json]
import fs from 'fs';
import { pathToFileURL } from 'url';
import path from 'path';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : process.argv[i + 1]; };
const has = k => process.argv.includes('--' + k);
const MOD = arg('module', new URL('../web/motion.js', import.meta.url).pathname);
const { MotionModel, qmul, qconj, qrot, qexp, qaxis, qslerp, qangle, qnorm, DEFAULTS } = await import(pathToFileURL(path.resolve(MOD)).href);
const PH = +arg('phases', 4), OPTS = JSON.parse(arg('opts', '{}')), HZ = arg('hz', '60,120').split(',').map(Number), ONLY = arg('only', '') ? arg('only', '').split(',') : null;

const DEG = Math.PI / 180, clamp = (v, a, b) => Math.max(a, Math.min(b, v)), lerp = (a, b, u) => a + (b - a) * u;
const add = (a, b) => a.map((v, i) => v + b[i]), sub = (a, b) => a.map((v, i) => v - b[i]), mul = (a, k) => a.map(v => v * k), len = v => Math.hypot(...v);
function rng(seed) { let a = seed >>> 0; const u = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { u, n: () => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u()) }; }

// ---------- real arrival timing ----------
let lat;
try { const live = fs.readFileSync(new URL('../data/live2.jsonl', import.meta.url), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const l = live.map(r => r.at / 1000 - r.t), b = Math.min(...l); lat = l.map(v => v - b);
} catch { const r = rng(3); lat = Array.from({ length: 750 }, (_, i) => (i % 2 ? 0.004 : 0.024) + (r.u() < 0.06 ? 0.03 + r.u() * 0.03 : 0) + r.u() * 0.004); }   // no capture: pairs + the odd long gap

// ---------- hand motion: yaw (about up, + = left), pitch (about right, + = up), roll (about forward), min-jerk between keys ----------
const mj = u => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * u * (10 - 15 * u + 6 * u * u));
function keys(K) {                                            // K: [[t, yaw, pitch, roll], ...] degrees, t ascending
  return t => { if (t <= K[0][0]) return K[0].slice(1).map(v => v * DEG); for (let i = 1; i < K.length; i++) if (t < K[i][0]) { const u = mj((t - K[i - 1][0]) / (K[i][0] - K[i - 1][0])); return [1, 2, 3].map(j => lerp(K[i - 1][j], K[i][j], u) * DEG); } return K[K.length - 1].slice(1).map(v => v * DEG); };
}
const tremor = t => [0.004 * Math.sin(57.2 * t + 1) + 0.003 * Math.sin(33.3 * t), 0.004 * Math.sin(61.1 * t + 2) + 0.003 * Math.sin(29.5 * t + 0.5), 0.003 * Math.sin(49 * t + 3)];   // ~0.3-0.5 rad/s, an idle hand
const T0 = 17;                                                // scenarios start here: hold 0-6, tilt 6-7, then idle until the clock offset has seen a whole cycle of real lateness
function swings(wind, hit, n = 3, per = 3.0) {                // wind-up, pause, swing, held follow-through, back to ready
  const K = [[0, 0, 0, 0]];
  for (let i = 0; i < n; i++) { const t = i * per + 0.6; K.push([t, 0, 0, 0], [t + wind.T, ...wind.a], [t + wind.T + 0.1, ...wind.a], [t + wind.T + 0.1 + hit.T, ...hit.a], [t + wind.T + 0.6 + hit.T, ...hit.a], [t + wind.T + 1.15 + hit.T, 0, 0, 0]); }
  return { f: keys(K), dur: n * per, hitAt: Array.from({ length: n }, (_, i) => i * per + 0.6 + wind.T + 0.1) };
}
const lurch = hitAt => t => { let x = 0, y = 0; for (const h of hitAt) { const u = mj((t - h + 0.1) / 0.3) - mj((t - h - 0.5) / 0.6); x += 0.015 * u; y += 0.008 * u; } return [x, y]; };   // the body goes with the swing
const sway = t => [0.004 * Math.sin(1.6 * t), 0.002 * Math.sin(2.3 * t + 1)];
const gt = swings({ T: 0.4, a: [-20, -5, 0] }, { T: 0.2, a: [40, 5, 10] });                  // 62deg in 0.2 s: peaks ~10 rad/s, the dink the game asks for
const fh = swings({ T: 0.45, a: [-45, -10, 0] }, { T: 0.16, a: [80, 5, 30] }), bh = swings({ T: 0.45, a: [50, -5, 0] }, { T: 0.17, a: [-80, 5, -40] }), oh = swings({ T: 0.5, a: [-10, 65, 0] }, { T: 0.16, a: [20, -45, 10] });
let stirPh = t => 14 * t - 4 / 4.4 * Math.cos(4.4 * t);       // d/dt = 14 + 4 sin(4.4 t): rate hovers 5..9 rad/s
const SCN = {
  still:    { dur: 8, f: () => [0, 0, 0], head: sway, note: 'hand held still (tremor only)' },
  slow:     { dur: 8, f: t => mul([0.45 * Math.sin(3.46 * t), 0.3 * Math.sin(5.03 * t + 1), 0.2 * Math.sin(2.5 * t)], mj(t / 0.6)), head: t => [0.1 * Math.sin(1.9 * t), 0.01 * Math.sin(2.3 * t)], note: 'slow repositioning 1-3 rad/s, walking side to side' },
  zigzag:   { dur: 8, f: t => [0.6 * Math.sin(13.8 * t) * mj(t / 0.5), 0, 0], head: sway, note: 'medium: 2.2 Hz yaw zigzag, rate 0..8.3 rad/s across ARC_LO' },
  stir:     { dur: 8, f: t => { const a = 0.5 * mj(t / 0.6); return [a * Math.cos(stirPh(t)), a * Math.sin(stirPh(t)), 0]; }, head: sway, note: 'medium: circular stir, rate hovering 5-9 rad/s' },
  gentle:   { dur: gt.dur, f: gt.f, head: sway, note: '3 gentle forehands (dinks): 62deg in 0.2 s, peak ~10 rad/s' },
  forehand: { dur: fh.dur, f: fh.f, head: t => add(sway(t), lurch(fh.hitAt)(t)), note: '3 forehands: 45deg wind-up, 125deg in 0.16 s, held follow-through' },
  backhand: { dur: bh.dur, f: bh.f, head: t => add(sway(t), lurch(bh.hitAt)(t)), note: '3 backhands: across the body, 130deg + 40deg roll' },
  overhead: { dur: oh.dur, f: oh.f, head: t => add(sway(t), lurch(oh.hitAt)(t)), note: '3 overheads: 65deg up, 110deg down in 0.16 s' },
  walk:     { dur: 9, f: keys([[0, 0, 0, 0], [0.5, 0, 0, 0], [1.1, 0, -30, 0], [3.1, 0, -30, 0], [3.6, 0, 0, 0], [4.6, 0, 0, 0], [5.2, 0, 30, 0], [7.2, 0, 30, 0], [7.8, 0, 0, 0]]), head: sway, note: 'tilt-to-walk: 30deg forward 2 s, level, 30deg back 2 s' },
};

const grip = qaxis([1, 2, 3], 0.7), ARMW = [0.08, 0.45, -0.10];   // world: R = +X, F = +Y, U = +Z. pivot -> bud, as test/fake-bridge.mjs
function handD(scn, t) {                                       // world-frame rotation of the hand since the hold
  let a = t < 6 ? [0, 0, 0] : t < 7 ? [0, 0.6 * Math.sin((t - 6) * Math.PI), 0] : t < T0 ? [0, 0, 0] : scn.f(t - T0);
  a = add(a, tremor(t));
  return qmul(qmul(qaxis([0, 0, 1], a[0]), qaxis([1, 0, 0], a[1])), qaxis([0, 1, 0], a[2]));
}
function sample(scn, t, R) {
  const q = ti => qmul(handD(scn, ti), grip), h = 1e-3, e = 2e-3;
  const dq = qmul(qconj(q(t - h)), q(t + h)), s = dq[3] < 0 ? -1 : 1, vn = Math.hypot(dq[0], dq[1], dq[2]), ang = 2 * Math.atan2(vn, Math.abs(dq[3]));
  const r = vn > 1e-12 ? [0, 1, 2].map(i => s * dq[i] / vn * ang / (2 * h) + R.n() * 0.005) : [0, 0, 0];
  const pos = ti => qrot(handD(scn, ti), ARMW), acc = [0, 1, 2].map(i => (pos(t + e)[i] - 2 * pos(t)[i] + pos(t - e)[i]) / (e * e));
  const a = qrot(qconj(q(t)), acc).map(v => clamp(-v / 9.81, -16, 16) + R.n() * 0.003);      // CoreMotion sign, sensor range
  return { t, q: q(t), r, a };
}

// ---------- the webcam path, as web/bodytrack.js + web/main.js ----------
function oneEuro(minCut, beta) { let x = null, dx = 0, t0 = 0; const al = (cut, dt) => 1 / (1 + 1 / (2 * Math.PI * cut * dt));
  return (v, t) => { if (x == null) { x = v; t0 = t; return x; } const dt = Math.max(1e-3, (t - t0) / 1000); t0 = t; dx += ((v - x) / dt - dx) * al(1.0, dt); x += (v - x) * al(minCut + beta * Math.abs(dx), dt); return x; }; }
function damp(cur, target, vel, smooth, dt) { const o = 2 / smooth, x = o * dt, e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x), ch = cur - target, tmp = (vel + o * ch) * dt; return [target + (ch + tmp) * e, (vel - o * tmp) * e]; }
const CAM = { fps: 30, noise: 0.002, reach: 0.3, reachY: 0.14, smooth: +arg('damp', 0.085), minCut: +arg('mincut', 0.7), beta: +arg('beta', 9), zTau: +arg('ztau', 0.03), zLocal: has('zlocal') };   // noise: frame fraction (~1.3 px of 640)

// ---------- one run: returns per-frame series ----------
function run(name, hz, o = {}) {
  const scn = SCN[name], R = rng(11), end = T0 + scn.dur, m = new MotionModel({ ...OPTS, ...(o.opts || {}) });
  const ev = []; for (let i = 0; i * 0.02 < end; i++) { const t = i * 0.02; ev.push({ at: t + lat[(i + (o.shift || 0)) % lat.length], s: sample(scn, t, R) }); } ev.sort((a, b) => a.at - b.at);
  const camR = rng(5), fx = oneEuro(CAM.minCut, CAM.beta), fy = oneEuro(CAM.minCut, CAM.beta); let camNext = 0, cx = 0.5, cy = 0.5;
  let bodyX = 0, bodyY = 1, vX = 0, vY = 0, bodyZ = 6.5, walkV = 0, walkHold = 0, ownZ = 6.5, srvZ = 6.5, srvNext = 0, tgtZ = 6.5, posZ = 6.5, next20 = 0;
  const S = { t: [], pos: [], base: [], off: [], P: [], D: [], tau: [], under: [], w: [], A: [], var: { noclamp: [], notanh: [], w1: [], nopunch: [] }, swings: [], replica: true, maxRep: 0 };
  let k = 0;
  for (let f = 0; f / hz < end; f++) {
    const now = f / hz, dt = Math.min(0.05, 1 / hz);
    while (k < ev.length && ev[k].at <= now) { for (const e of m.feed(ev[k].s, ev[k].at * 1000)) if (e.type === 'swing') S.swings.push(+(ev[k].s.t - T0).toFixed(2)); k++; }
    while (camNext <= now) { const hd = camNext < T0 ? [0, 0] : scn.head(camNext - T0); cx = fx(0.5 + hd[0] + camR.n() * CAM.noise, camNext * 1000); cy = fy(0.5 + hd[1] + camR.n() * CAM.noise * 0.8, camNext * 1000); camNext += 1 / CAM.fps + (camR.u() - 0.5) * 0.004; }
    while (srvNext <= now) { srvZ += clamp(ownZ - srvZ, -7 / 60, 7 / 60); tgtZ = srvZ; srvNext += 1 / 60; }      // server tick, echoed in 'state'
    if (next20 <= now) { next20 += 0.05; const p = m.pose(now * 1000); if (p.calibrated) ownZ = clamp(bodyZ, 2.6, 7.4); }   // main.js 20 Hz 'paddle' message also calls pose()
    const p = m.pose(now * 1000); if (!p.calibrated) continue;
    [bodyX, vX] = damp(bodyX, clamp(-(cx - 0.5) / CAM.reach * 3.0, -3.5, 3.5), vX, CAM.smooth, dt);
    [bodyY, vY] = damp(bodyY, clamp(1.0 - (cy - 0.5) / CAM.reachY * 0.8, 0.3, 2.3), vY, CAM.smooth, dt);
    if (p.swinging || p.rate > 3.5) walkHold = now + 0.45;
    const dead = 14 * DEG, full = 38 * DEG, tl = p.tilt || 0, push = now < walkHold || Math.abs(tl) < dead ? 0 : Math.sign(tl) * Math.min(1, (Math.abs(tl) - dead) / (full - dead));
    [walkV] = damp(walkV, push * 3.2, 0, 0.12, dt); bodyZ = clamp(bodyZ + walkV * dt, 2.6, 7.2);
    posZ = CAM.zLocal ? bodyZ : lerp(posZ, tgtZ, 1 - Math.exp(-dt / CAM.zTau));                                                     // scene.js, local z
    if (now < T0 + 0.3) continue;
    const base = [bodyX, bodyY, posZ];
    S.t.push(now); S.base.push(base); S.off.push(p.offset); S.pos.push(add(base, p.offset)); S.P.push(p.P); S.D.push(m.D);
    // replica of pose()'s buffer read, for the counterfactuals. Checked against the real offset every frame.
    const N = m.snap, n = N.length, c = m.c;
    if (n >= 2 && N[0].ref) {
      const ts = now - m.off, raw = ts - m.D, tau = clamp(raw, N[0].t, N[n - 1].t); let i = n - 2; while (i > 0 && N[i].t > tau) i--;
      const a = N[i], b = N[i + 1], u = clamp((tau - a.t) / (b.t - a.t || 1), 0, 1), P = qslerp(a.P, b.P, u), ref = qslerp(a.ref, b.ref, u), pu = add(mul(a.pu, 1 - u), mul(b.pu, u)), w = lerp(a.w, b.w, u);
      const rel = qmul(P, qconj(ref)), ang = qangle(rel), lim = c.ARC_MAX * DEG, relp = rel[3] < 0 ? mul(rel, -1) : rel;
      const relC = ang > 1e-6 ? qslerp([0, 0, 0, 1], relp, lim * Math.tanh(ang / lim) / ang) : rel;
      const arcC = sub(qrot(qmul(relC, ref), c.ARM), qrot(ref, c.ARM)), arc = sub(qrot(P, c.ARM), qrot(ref, c.ARM));
      const hc = v => [clamp(v[0], -0.75, 0.75), clamp(v[1], -0.5, 0.6), clamp(v[2], -0.6, 0.2)];
      const A = add(arcC, pu), rep = hc(mul(A, w)), err = len(sub(rep, p.offset)); S.maxRep = Math.max(S.maxRep, err); if (err > 1e-6) S.replica = false;
      S.tau.push(tau); S.under.push(raw > N[n - 1].t + 1e-9); S.w.push(w); S.A.push(A);
      S.var.noclamp.push(mul(A, w)); S.var.notanh.push(hc(mul(add(arc, pu), w))); S.var.w1.push(hc(A)); S.var.nopunch.push(hc(mul(arcC, w)));
    } else S.replica = false;
  }
  // floor: a plain kinematic arm on the TRUE hand, 90 ms late, no sampling at all
  S.truth = S.t.map(t => { const d = handD(scn, t - 0.09), P = [d[0], d[2], -d[1], d[3]]; return sub(qrot(P, DEFAULTS.ARM), DEFAULTS.ARM); });
  S.truthP = S.t.map(t => { const d = handD(scn, t - 0.09); return [d[0], d[2], -d[1], d[3]]; });
  return S;
}

// ---------- metrics ----------
const SG = { 5: [-3, 12, 17, 12, -3].map(v => v / 35), 9: [-21, 14, 39, 54, 59, 54, 39, 14, -21].map(v => v / 231) };
const rms = a => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / (a.length || 1)), max = a => a.reduce((s, v) => Math.max(s, v), 0);
const med = a => [...a].sort((x, y) => x - y)[a.length >> 1];
function posMetrics(V, hz) {                                   // V: array of 3-vectors, one per frame
  const dt = 1 / hz, n = V.length, jerk = [], wob = [], K = SG[hz >= 100 ? 9 : 5], h = K.length >> 1, steps = [];
  for (let i = 3; i < n; i++) jerk.push(len(add(sub(V[i], mul(V[i - 1], 3)), sub(mul(V[i - 2], 3), V[i - 3]))) / dt ** 3);
  for (let i = h; i < n - h; i++) { let s = [0, 0, 0]; for (let j = -h; j <= h; j++) s = add(s, mul(V[i + j], K[j + h])); wob.push(len(sub(V[i], s)) * 1000); }   // what a 67 ms quadratic fit can't explain
  for (let i = 1; i < n; i++) steps.push(len(sub(V[i], V[i - 1])));
  let moving = 0, out = 0, stall = 0, worst = 1; const floor = 0.05 * dt;
  for (let i = 3; i < steps.length - 3; i++) { const loc = med(steps.slice(i - 3, i + 4)); if (loc < floor) continue; moving++; const r = steps[i] / loc;
    if (r > 1.5 || r < 0.5) out++; if (r < 0.15) stall++; worst = Math.max(worst, r, r > 0 ? Math.min(1 / r, 99) : 99); }
  return { jerkRms: rms(jerk), jerkMax: max(jerk), wobRms: rms(wob), wobMax: max(wob), maxStep: max(steps) * 1000, moving, out, outPct: moving ? 100 * out / moving : 0, stall, worst, path: steps.reduce((a, b) => a + b, 0) };
}
function rotMetrics(Q, hz) {
  const dt = 1 / hz, w = [], fwd = Q.map(q => qrot(q, [0, 0, -1]));
  for (let i = 1; i < Q.length; i++) w.push(qangle(qmul(Q[i], qconj(Q[i - 1]))) / dt);
  const dw = []; for (let i = 1; i < w.length; i++) dw.push(Math.abs(w[i] - w[i - 1]));
  let moving = 0, out = 0, stall = 0;
  for (let i = 3; i < w.length - 3; i++) { const loc = med(w.slice(i - 3, i + 4)); if (loc < 0.5) continue; moving++; const r = w[i] / loc; if (r > 1.5 || r < 0.5) out++; if (r < 0.15) stall++; }
  const pm = posMetrics(fwd, hz);
  return { dwRms: rms(dw), dwMax: max(dw), wobRmsDeg: pm.wobRms / 1000 / DEG, wobMaxDeg: pm.wobMax / 1000 / DEG, moving, out, outPct: moving ? 100 * out / moving : 0, stall, wMax: max(w) };
}
function analyse(S, hz) {
  const M = { total: posMetrics(S.pos, hz), base: posMetrics(S.base, hz), baseXY: posMetrics(S.base.map(b => [b[0], b[1], 0]), hz), baseZ: posMetrics(S.base.map(b => [0, 0, b[2]]), hz),
    offset: posMetrics(S.off, hz), rot: rotMetrics(S.P, hz), truthArm: posMetrics(S.truth, hz), truthRot: rotMetrics(S.truthP, hz), swings: S.swings, replica: S.replica, offMax: max(S.off.map(len)) };
  const dD = []; for (let i = 1; i < S.D.length; i++) dD.push(S.D[i] - S.D[i - 1]);
  const speed = dD.map(d => 1 - d * hz);                          // playback speed of the buffered hand: 1 = real time
  M.delay = { mean: S.D.reduce((a, b) => a + b, 0) / S.D.length * 1000, min: Math.min(...S.D) * 1000, max: Math.max(...S.D) * 1000, slowFrames: speed.filter(v => v < 0.9).length, minSpeed: Math.min(...speed), maxSpeed: Math.max(...speed) };
  if (S.replica) {
    for (const k in S.var) M[k] = posMetrics(S.var[k], hz);
    M.delay.underruns = S.under.filter(Boolean).length; M.delay.hitches = S.under.filter((v, i) => v && !S.under[i - 1]).length;
    { let r = 0, best = 0; for (const v of S.under) { r = v ? r + 1 : 0; best = Math.max(best, r); } M.delay.longestMax = best * 1000 / hz; }
    const wT = [], aT = []; let clampF = 0;
    for (let i = 1; i < S.w.length; i++) { const Am = mul(add(S.A[i], S.A[i - 1]), 0.5), wm = (S.w[i] + S.w[i - 1]) / 2; wT.push(len(mul(Am, S.w[i] - S.w[i - 1]))); aT.push(len(mul(sub(S.A[i], S.A[i - 1]), wm))); }
    for (let i = 0; i < S.off.length; i++) if (len(sub(S.off[i], S.var.noclamp[i])) > 1e-9) clampF++;
    const sw = wT.reduce((a, b) => a + b, 0), sa = aT.reduce((a, b) => a + b, 0);
    M.armW = { fadeShare: 100 * sw / (sw + sa || 1), fadeMaxStep: max(wT) * 1000, arcMaxStep: max(aT) * 1000, wMax: max(S.w), wFlips: S.w.reduce((c, v, i) => c + (i && (v > 0.05) !== (S.w[i - 1] > 0.05) ? 1 : 0), 0) };
    M.clamp = { frames: clampF, pct: 100 * clampF / S.off.length };
  }
  return M;
}

// several arrival phases per scenario, so one unlucky late packet landing (or not) inside a swing doesn't decide the result
function merge(list) {                                           // *Max / worst / max -> max, counts -> sum, the rest -> mean
  const a = list[0]; if (typeof a === 'number') { return null; }
  const o = {};
  for (const k in a) { const v = list.map(m => m[k]);
    if (typeof a[k] === 'boolean') o[k] = v.every(Boolean);
    else if (Array.isArray(a[k])) o[k] = a[k];
    else if (typeof a[k] === 'object') o[k] = merge(v);
    else if (/Max|^max|worst|wMax|offMax|^longest/.test(k)) o[k] = Math.max(...v);
    else if (/^min/.test(k)) o[k] = Math.min(...v);
    else if (/^(out|moving|stall|frames|slowFrames|underruns|hitches|wFlips)$/.test(k)) o[k] = v.reduce((x, y) => x + y, 0);
    else o[k] = v.reduce((x, y) => x + y, 0) / v.length; }
  for (const k of ['outPct', 'pct']) if (k in o) o[k] = k === 'pct' ? o[k] : (o.moving ? 100 * o.out / o.moving : 0);
  return o;
}
function trace(S, hz, n = 6) {                                   // the worst frames and what was going on in them
  const K = SG[hz >= 100 ? 9 : 5], h = K.length >> 1, rows = [];
  for (let i = h; i < S.pos.length - h; i++) { let s = [0, 0, 0]; for (let j = -h; j <= h; j++) s = add(s, mul(S.off[i + j], K[j + h])); rows.push({ i, wob: len(sub(S.off[i], s)) * 1000 }); }
  rows.sort((a, b) => b.wob - a.wob); const seen = [];
  for (const r of rows) { if (seen.some(j => Math.abs(j - r.i) < hz * 0.15)) continue; seen.push(r.i); const i = r.i;
    console.log(`    t=${(S.t[i] - T0).toFixed(3)}  offset wobble ${r.wob.toFixed(1)} mm  w ${S.w[i - 1]?.toFixed(2)}>${S.w[i]?.toFixed(2)}  |A| ${len(S.A[i] || [0]).toFixed(2)} m  D ${(S.D[i - 1] * 1000).toFixed(1)}>${(S.D[i] * 1000).toFixed(1)} ms  underrun ${S.under[i] ? 'YES' : 'no'}  step ${(len(sub(S.off[i], S.off[i - 1])) * 1000).toFixed(1)} mm (prev ${(len(sub(S.off[i - 1], S.off[i - 2])) * 1000).toFixed(1)}, next ${(len(sub(S.off[i + 1], S.off[i])) * 1000).toFixed(1)})`);
    if (seen.length >= n) break; }
}

// ---------- report ----------
const f = (v, d = 1, w = 8) => (Number.isFinite(v) ? v.toFixed(d) : '-').padStart(w);
const out = {};
for (const name of Object.keys(SCN)) {
  if (ONLY && !ONLY.includes(name)) continue;
  out[name] = {};
  if (!has('brief')) console.log(`\n=== ${name}: ${SCN[name].note}   (${PH} arrival phases pooled)`);
  for (const hz of HZ) {
    const Ms = [], Fs = [];
    for (let ph = 0; ph < PH; ph++) { const shift = Math.floor(ph * lat.length / PH), S = run(name, hz, { shift }); Ms.push(analyse(S, hz));
      const F = analyse(run(name, hz, { shift, opts: { BUFFER_MIN: 0.09, BUFFER_MAX: 0.09 } }), hz); Fs.push({ total: F.total, rot: F.rot, offset: F.offset });
      if (has('trace') && S.replica) { console.log(`  [trace ${hz} Hz, phase ${ph}]`); trace(S, hz); } }
    const M = merge(Ms); M.fixedD = merge(Fs); out[name][hz] = M;
    if (has('brief')) { console.log(`${name.padEnd(9)}${String(hz).padStart(4)}Hz  pos wobble ${f(M.total.wobRms, 2, 6)}/${f(M.total.wobMax, 1, 5)} mm  jerk ${f(M.total.jerkRms, 0, 6)}/${f(M.total.jerkMax, 0, 7)} m/s3  outliers ${f(M.total.outPct, 1, 5)}% stalls ${String(M.total.stall).padStart(3)}  maxstep ${f(M.total.maxStep, 1, 6)} mm | rot wobble ${f(M.rot.wobRmsDeg, 3, 6)}/${f(M.rot.wobMaxDeg, 2, 5)} deg  dw ${f(M.rot.dwRms, 2, 5)}/${f(M.rot.dwMax, 1, 5)} rad/s  outliers ${f(M.rot.outPct, 1, 5)}% stalls ${String(M.rot.stall).padStart(3)} | hitches ${M.delay.hitches ?? '-'}  fade ${M.armW ? f(M.armW.fadeShare, 0, 3) : '  -'}%  swings ${M.swings.length}`); continue; }
    console.log(`--- ${hz} Hz render   swings fired at ${JSON.stringify(M.swings)}   offset peak ${M.offMax.toFixed(2)} m${M.replica ? '' : '   (pose() internals differ from the shipped formula: no counterfactual rows)'}`);
    console.log('  position            wobble mm rms/max      jerk m/s3 rms/max   max step mm   step outliers (of moving)  stalls  worst ratio');
    const row = (lbl, m) => console.log(`  ${lbl.padEnd(18)}${f(m.wobRms, 2)}${f(m.wobMax, 1)}   ${f(m.jerkRms, 0, 9)}${f(m.jerkMax, 0, 9)}   ${f(m.maxStep, 1, 9)}   ${String(m.out).padStart(6)} /${String(m.moving).padStart(5)} =${f(m.outPct, 1, 5)}%  ${String(m.stall).padStart(5)}  ${f(m.worst, 1, 8)}`);
    row('TOTAL (seen)', M.total); row('  base x,y (cam)', M.baseXY); row('  base z (walk)', M.baseZ); row('  offset (arc)', M.offset);
    if (M.replica) { row('   no axis clamp', M.noclamp); row('   no tanh', M.notanh); row('   armW = 1', M.w1); row('   no punch', M.nopunch); }
    row('  offset, fixed D', M.fixedD.offset); row('TOTAL, fixed D', M.fixedD.total); row('floor: true arm', M.truthArm);
    const rr = (lbl, r) => console.log(`  ${lbl.padEnd(18)} wobble deg rms/max ${f(r.wobRmsDeg, 3)}${f(r.wobMaxDeg, 2)}   ang-vel jump rad/s per frame rms/max ${f(r.dwRms, 2)}${f(r.dwMax, 1)}   outliers ${r.out}/${r.moving} = ${r.outPct.toFixed(1)}%  stalls ${r.stall}  peak ${r.wMax.toFixed(1)} rad/s`);
    rr('orientation', M.rot); rr(' ...with fixed D', M.fixedD.rot); rr(' floor: true hand', M.truthRot);
    const d = M.delay; console.log(`  buffer delay D     mean ${d.mean.toFixed(0)} ms (${d.min.toFixed(0)}..${d.max.toFixed(0)})   playback speed ${d.minSpeed.toFixed(2)}..${d.maxSpeed.toFixed(2)}x   frames slower than 0.9x: ${d.slowFrames}   buffer underruns (paddle frozen): ${d.hitches ?? '-'} hitches, ${d.underruns ?? '-'} frames, longest ${d.longestMax?.toFixed(0) ?? '-'} ms`);
    if (M.armW) console.log(`  armW               ${M.armW.fadeShare.toFixed(0)}% of the offset's travel is the FADE (dw * arc), not the arc moving   biggest fade step ${M.armW.fadeMaxStep.toFixed(1)} mm/frame vs arc step ${M.armW.arcMaxStep.toFixed(1)}   w peak ${M.armW.wMax.toFixed(2)}, crosses 0.05 ${M.armW.wFlips}x   clamp active ${M.clamp.frames} frames (${M.clamp.pct.toFixed(1)}%)`);
  }
}
if (has('sweep')) {                                              // how much arc does a forehand of each speed get? (consistency)
  console.log('\n=== arc drawn vs swing speed: same 100deg forehand, different durations (120 Hz)');
  for (const T of [0.5, 0.4, 0.32, 0.26, 0.2, 0.16, 0.13, 0.1]) { const g = swings({ T: 0.45, a: [-40, -5, 0] }, { T, a: [60, 5, 20] }, 1);
    SCN._sw = { dur: g.dur, f: g.f, head: sway }; const S = run('_sw', 120), i0 = S.t.findIndex(t => t - T0 > g.hitAt[0] - 0.05), seg = S.off.slice(i0, i0 + Math.round((T + 0.35) * 120));
    const pathLen = seg.slice(1).reduce((a, v, i) => a + len(sub(v, seg[i])), 0), truthSeg = S.truth.slice(i0, i0 + seg.length), tp = truthSeg.slice(1).reduce((a, v, i) => a + len(sub(v, truthSeg[i])), 0);
    console.log(`  peak ${(1.875 * 1.8 / T).toFixed(1).padStart(5)} rad/s   offset peak ${max(seg.map(len)).toFixed(2)} m   arc travel ${pathLen.toFixed(2)} m  (a plain arm would travel ${tp.toFixed(2)} m: ${(100 * pathLen / tp).toFixed(0)}%)   w peak ${max(S.w.slice(i0, i0 + seg.length)).toFixed(2)}   swing events ${S.swings.length}`); }
  delete SCN._sw;
}
if (arg('json')) fs.writeFileSync(arg('json'), JSON.stringify(out));
