// Kinematic stroke synthesiser + end-to-end shot check: synthetic arm strokes -> {t,q,r,a} -> web/motion.js MotionModel ->
// web/main.js client maths (spin, lob gate) -> server/game.js underhand()/sliced()/shotKind()/solve(). Nothing is copied by
// hand: the client and server maths are read out of their files, like test/kinds.mjs and test/shots.mjs do.
//   node test/lobsynth.mjs              summary table, one row per stroke x grip (median over seeds, kinds tallied)
//   node test/lobsynth.mjs --rows       ...plus one row per seed
//   node test/lobsynth.mjs --seeds 8    number of seeds (default 5)
//   node test/lobsynth.mjs --only wide_lob,bh_slice --rows
// Reuse (another script): import { STROKES, GRIPS, synthStroke, runStroke, derive, clientOf, server } from './lobsynth.mjs'
//   runStroke({ stroke, grip, seed, modelOpts, client, srv }) -> { swings: [{ tEmit, first, last }], hit (the swing live at
//     contact; hit.last = its settled event), before (swings that fired earlier, e.g. the take-back), row = derive(hit.last) }
//   derive(e, grip, { client, srv, chopRule }) re-scores one settled event, so a candidate client gate (a function e -> { slice,
//     lob, g }) or server maths ({ underhand, sliced, shotKind, solve, gOf }) can be tried without re-synthesising.
//   modelOpts go to new MotionModel(opts) for motion.js-side candidates (e.g. { LOB_GAIN: 0.8 }).
//
// THE ARM MODEL (right-handed player, player frame x = R right, y = F toward the net, z = U up):
//   hand orientation H(t) = Rz(psi) * Rx(phi) * Ry(rho)   (intrinsic: yaw about U, then pitch about the turned R, then roll
//   about the pointer). The pointer (forearm + paddle, what calibration aims "at the screen") is H * F.
//   psi  + = pointer swings LEFT (CCW from above; a righty forehand's forward swing is +psi)
//   phi  + = pointer tips UP
//   rho  + = supination of the right forearm about its distal axis (thumb left -> up -> right with the forearm pointing forward)
//   Face opening: forehand face (palm side) opens with +rho; the BACKHAND face (back-of-hand side) opens with -rho, i.e. with
//   the forearm pointing across the body (distal = -R) the opening roll is a rotation about +R. (The brief called it
//   "supinating to open the face"; anatomically, turning the back of the hand to the sky is pronation. What matters for
//   motion.js is the world axis, +R, so bh_slice uses the face-OPENING sign and bh_slice_rev the other one for contrast.)
//   Device q = W(heading) * H(t) * G(grip); r = body rate from the exact derivative of that matrix; a = 0 (settled power
//   never reads accel; aS only vetoes the early bet, and with no accel there is no veto).
//   Each channel moves by smooth bell-shaped velocity pulses v ~ u^a (1-u)^b whose peak sits at pk of the move (real arm
//   swings accelerate long and stop short: motion.js measured 240-340 ms to the peak for arm swings, 80-100 ms for flicks).
import { MotionModel, qmul, qrot, qconj } from '../web/motion.js';
import { PadMotion } from '../web/padmotion.js';
import { rotM, quatFromM, rng } from './fake-bridge.mjs';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const DEG = Math.PI / 180;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---------- client + server maths, read out of their own files ----------
const SRC = fs.readFileSync(new URL('../server/game.js', import.meta.url), 'utf8');
const F0 = SRC.indexOf('const COURT'), F1 = SRC.indexOf('// how underhand was the swing?'), F2 = SRC.indexOf('// ---------- a room: one match');
if (F0 < 0 || F1 < F0 || F2 < F1) throw new Error('server/game.js: the solver moved (anchors: "const COURT", "// how underhand was the swing?", "// ---------- a room: one match")');
const pre = SRC.slice(F0, F1).replace(/^const httpServer[\s\S]*?^\}\);$/m, ''), fns = SRC.slice(F1, F2);   // (constants .. helpers .. solve/fly; no sockets)
export const server = new Function(pre + '\n' + fns + '\nreturn { underhand, lofted, sliced, shotKind, solve, gOf, COURT, SMASH };')();
const chopRule = /m\.chop, 0\), 0, 1\) > ([\d.]+) && pw > ([\d.]+)\) pw = Math\.min\(1, pw \+ ([\d.]+)\)/.exec(SRC);
export const [CHOP, CHOP_N, CHOP_ADD] = chopRule ? chopRule.slice(1).map(Number) : [0.45, 0.55, 0];   // the server's overhead bonus, if it has one (gone since NOTES 79: + 0)
const MAIN = fs.readFileSync(new URL('../web/main.js', import.meta.url), 'utf8');
const a0 = MAIN.indexOf('const roll = Math.max('), a1 = MAIN.indexOf("game.send({ type: 'swing'", a0);
if (a0 < 0 || a1 < 0) throw new Error('web/main.js: the swing maths moved');
export const clientOf = new Function('e', MAIN.slice(a0, a1) + '; return { roll, curve, amount, way, slice, lob, g };');
const gainM = /PHONE_GAIN = Math\.max\(0\.5, Math\.min\(3, \+qs\.get\('padgain'\) \|\| ([\d.]+)\)\)/.exec(MAIN);
export const PHONE_GAIN = gainM ? +gainM[1] : 1.5;

// ---------- grips: device -> hand (hand axes at H = I: x = R, y = F (pointer), z = U) ----------
const colsM = (cx, cy, cz) => [0, 1, 2].map(i => [cx[i], cy[i], cz[i]]);      // matrix whose columns are where device x,y,z go
export const GRIPS = {
  // AirPod lying flat in the palm, stem toward the fingers and a little skewed (its real axes are not the paddle's)
  airpod: { label: 'AirPod flat', hz: 50, gain: 1, phone: false, G: rotM([0.3, -0.5, 0.8], 1.1) },
  // phone edge-up: screen faces LEFT (-R), top toward the net (+F), so device x = U
  phone: { label: 'phone edge-up', hz: 60, gain: PHONE_GAIN, phone: true, G: colsM([0, 0, 1], [0, 1, 0], [-1, 0, 0]) },
};

// ---------- strokes ----------
// moves: [channel, t0 ms, T ms, delta deg, pk (where the speed peaks, 0..1; default 0.5)]; channels start at READY.
// contact: ms (the moment the paddle meets the ball). expect: what the player means.
export const READY = { psi: 0, phi: -15, rho: 0 };
export const STROKES = {
  fh_drive: { label: 'forehand drive', expect: 'drive', contact: 800, moves: [
    ['psi', 0, 450, -90], ['phi', 0, 450, -10],                                     // unit turn back to the right, a little low
    ['psi', 520, 420, 190, 0.65], ['phi', 520, 420, 35, 0.65], ['rho', 520, 420, -20, 0.65],   // low-to-high, slight roll over
    ['psi', 1150, 700, -100], ['phi', 1150, 700, -10], ['rho', 1150, 700, 20]] },
  bh_drive: { label: 'backhand drive', expect: 'drive', contact: 800, moves: [
    ['psi', 0, 450, 100], ['phi', 0, 450, -10],
    ['psi', 520, 420, -190, 0.65], ['phi', 520, 420, 30, 0.65], ['rho', 520, 420, 10, 0.65],
    ['psi', 1150, 700, 90], ['phi', 1150, 700, -5], ['rho', 1150, 700, -10]] },
  // the brief's backhand slice: arm pointing across the body to the LEFT the whole time, high to low, forearm rolling the
  // backhand face open (with the forearm along -R that roll is a rotation about +R)
  bh_slice: { label: 'BACKHAND SLICE (arm left, face opens)', expect: 'slice', contact: 810, moves: [
    ['psi', 0, 500, 110], ['phi', 0, 500, 60], ['rho', 0, 500, 25],                // take it up high by the left shoulder, face a bit closed
    ['psi', 600, 360, -55, 0.6], ['phi', 600, 360, -65, 0.6], ['rho', 600, 360, -75, 0.6],   // high to low, still pointing left, face opening
    ['psi', 1150, 700, -55], ['phi', 1150, 700, 20], ['rho', 1150, 700, 50]] },
  bh_slice_rev: { label: 'backhand slice, arm left, roll -R', expect: 'slice', contact: 810, moves: [
    ['psi', 0, 500, 110], ['phi', 0, 500, 60], ['rho', 0, 500, -25],
    ['psi', 600, 360, -55, 0.6], ['phi', 600, 360, -65, 0.6], ['rho', 600, 360, 75, 0.6],
    ['psi', 1150, 700, -55], ['phi', 1150, 700, 20], ['rho', 1150, 700, -50]] },
  // a longer backhand slice that sweeps on across to the right (yaw-dominated)
  bh_slice_wide: { label: 'backhand slice, sweeping across', expect: 'slice', contact: 830, moves: [
    ['psi', 0, 500, 100], ['phi', 0, 500, 55], ['rho', 0, 500, 20],
    ['psi', 600, 380, -130, 0.6], ['phi', 600, 380, -65, 0.6], ['rho', 600, 380, -70, 0.6],
    ['psi', 1150, 700, 30], ['phi', 1150, 700, 25], ['rho', 1150, 700, 50]] },
  // a compact backhand chip: little arm, the forearm rolls the backhand face open (-> +R) while the paddle points left
  bh_chip: { label: 'backhand chip (forearm roll)', expect: 'slice', contact: 800, moves: [
    ['psi', 0, 450, 90], ['phi', 0, 450, 35], ['rho', 0, 450, 30],
    ['psi', 550, 380, -30, 0.65], ['phi', 550, 380, -40, 0.65], ['rho', 550, 380, -115, 0.65],
    ['psi', 1000, 700, -65], ['phi', 1000, 700, 0], ['rho', 1000, 700, 65]] },
  fh_slice: { label: 'forehand slice', expect: 'slice', contact: 830, moves: [
    ['psi', 0, 500, -80], ['phi', 0, 500, 45], ['rho', 0, 500, -15],
    ['psi', 600, 380, 110, 0.6], ['phi', 600, 380, -60, 0.6], ['rho', 600, 380, 55, 0.6],
    ['psi', 1150, 700, -30], ['phi', 1150, 700, 15], ['rho', 1150, 700, -40]] },
  wide_lob: { label: 'WIDE UNDERHAND LOB', expect: 'lob', contact: 830, moves: [
    ['phi', 0, 450, -95], ['psi', 0, 450, -35],                                    // arm swings down and back, out to the right
    ['phi', 550, 450, 150, 0.6], ['psi', 650, 420, 75, 0.55], ['rho', 550, 450, 15, 0.6],   // pendulum up through the ball, sweeping across: a curve
    ['phi', 1200, 700, -40], ['psi', 1200, 700, -40], ['rho', 1200, 700, -15]] },
  // the same pendulum with no sideways sweep: the control for wide_lob
  straight_lob: { label: 'straight underhand lob (control)', expect: 'lob', contact: 830, moves: [
    ['phi', 0, 450, -95],
    ['phi', 550, 450, 150, 0.6], ['rho', 550, 450, 15, 0.6],
    ['phi', 1200, 700, -55], ['rho', 1200, 700, -15]] },
  dink: { label: 'compact underhand dink', expect: 'dink', contact: 560, moves: [
    ['phi', 0, 300, -30],
    ['phi', 380, 280, 80, 0.55], ['psi', 380, 280, 8, 0.55],
    ['phi', 900, 500, -35], ['psi', 900, 500, -8]] },
  smash: { label: 'overhead smash', expect: 'smash', contact: 900, moves: [
    ['phi', 0, 550, 125], ['psi', 0, 550, 15],                                     // cock it up and back behind the head
    ['phi', 650, 380, -175, 0.65], ['psi', 650, 380, 35, 0.65], ['rho', 650, 380, -40, 0.65],   // down through the ball, pronating
    ['phi', 1200, 700, 50], ['psi', 1200, 700, -50], ['rho', 1200, 700, 40]] },
  // the same two pendulums a third quicker: their bet comes 30-55 ms before contact, while the hand is still going forward
  fast_wide_lob: { label: 'FAST wide lob', expect: 'lob', contact: 736, moves: [
    ['phi', 0, 450, -95], ['psi', 0, 450, -35],
    ['phi', 550, 300, 150, 0.6], ['psi', 617, 280, 75, 0.55], ['rho', 550, 300, 15, 0.6],
    ['phi', 1200, 700, -40], ['psi', 1200, 700, -40], ['rho', 1200, 700, -15]] },
  fast_straight_lob: { label: 'FAST straight lob', expect: 'lob', contact: 736, moves: [
    ['phi', 0, 450, -95],
    ['phi', 550, 300, 150, 0.6], ['rho', 550, 300, 15, 0.6],
    ['phi', 1200, 700, -55], ['rho', 1200, 700, -15]] },
  // a deep take-back: the paddle 60 deg behind vertical, so at the bet (15-40 deg behind) the hand is still coming DOWN (NOTES 91)
  deep_lob: { label: 'DEEP take-back lob', expect: 'lob', contact: 830, moves: [
    ['phi', 0, 450, -135],
    ['phi', 550, 450, 150, 0.6], ['rho', 550, 450, 15, 0.6],
    ['phi', 1200, 700, -15], ['rho', 1200, 700, -15]] },
  flick: { label: 'wrist flick', expect: 'tap', contact: 50, moves: [
    ['psi', 0, 100, 40, 0.5], ['phi', 0, 100, 12, 0.5], ['psi', 200, 300, -40], ['phi', 200, 300, -12]] },
};

// smooth velocity pulse with its peak at pk: v ~ u^a (1-u)^b, a = 2; s(u) tabulated once per pk
const PULSE = new Map();
function pulse(pk = 0.5) {
  const key = pk.toFixed(3); if (PULSE.has(key)) return PULSE.get(key);
  const a = 2, b = a * (1 - pk) / pk, N = 4000, S = new Float64Array(N + 1);
  for (let i = 1; i <= N; i++) { const u = (i - 0.5) / N; S[i] = S[i - 1] + u ** a * (1 - u) ** b; }
  for (let i = 1; i <= N; i++) S[i] /= S[N];
  const f = u => { if (u <= 0) return 0; if (u >= 1) return 1; const x = u * N, i = Math.floor(x); return S[i] + (S[Math.min(N, i + 1)] - S[i]) * (x - i); };
  PULSE.set(key, f); return f;
}

// one stroke, randomised by seed: amplitudes x N(1, 0.1), tempo x N(1, 0.08), the gap before the forward swing -80..+100 ms
// (negative = the forward swing starts before the take-back has stopped: a loop), heading anywhere, a little gyro noise.
export function strokePlan(name, seed = 1) {
  const S = STROKES[name]; if (!S) throw new Error('no stroke ' + name);
  const R = rng(seed * 7919 + name.length), n = () => R.n();
  const tempo = seed === 0 ? 1 : clamp(1 + 0.08 * n(), 0.85, 1.15), gap = seed === 0 ? 0 : -80 + 180 * R.u();
  // the forward swing = the moves that start after the first group; shifting it by gap shifts contact and the return too
  const firstEnd = Math.max(...S.moves.filter(m => m[1] === 0).map(m => m[2]));
  const moves = S.moves.map(([ch, t0, T, d, pk]) => {
    const late = t0 >= firstEnd - 1 ? gap : 0;
    return { ch, t0: ((t0 + late) * tempo) / 1000, T: (T * tempo) / 1000, d: d * DEG * (seed === 0 ? 1 : clamp(1 + 0.1 * n(), 0.75, 1.25)), f: pulse(pk || 0.5) };
  });
  return { name, moves, contact: ((S.contact + (S.contact >= firstEnd ? gap : 0)) * tempo) / 1000, end: Math.max(...moves.map(m => m.t0 + m.T)), heading: seed === 0 ? 0 : 360 * R.u(), seed };
}

const Rz = a => rotM([0, 0, 1], a), Rx = a => rotM([1, 0, 0], a), Ry = a => rotM([0, 1, 0], a);
const mm = (A, B) => A.map((r, i) => [0, 1, 2].map(j => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
const mt = A => [0, 1, 2].map(i => [0, 1, 2].map(j => A[j][i]));
const handM = ({ psi, phi, rho }) => mm(mm(Rz(psi), Rx(phi)), Ry(rho));

// Full timeline: settle, calibration (hold pointed at the screen, tip up 35 deg about R, rest in READY), idle, the stroke, idle.
// Returns samples { t, q, r, a } in the grip's own stream format (the phone's go through web/padmotion.js like pad.js does).
export function synthStroke(name, { grip = 'airpod', seed = 1, noise = 0.03, tail = 1.5 } = {}) {
  const gp = GRIPS[grip], plan = strokePlan(name, seed), h = plan.heading * DEG;
  const W = colsM([Math.sin(h), -Math.cos(h), 0], [Math.cos(h), Math.sin(h), 0], [0, 0, 1]);   // player (R,F,U) -> world, R x F = U
  const T_HOLD = 6.5, T_TIP = 0.7, T_READY = 0.6, T_REST = 1.6, T_IDLE = 1.0;
  const sTip = pulse(0.5), t1 = T_HOLD, t2 = t1 + T_TIP, t3 = t2 + T_READY, tS = t3 + T_REST + T_IDLE;
  const angles = t => {
    if (t < t1) return { psi: 0, phi: 0, rho: 0 };
    if (t < t2) return { psi: 0, phi: 35 * DEG * sTip((t - t1) / T_TIP), rho: 0 };
    if (t < t3) { const u = sTip((t - t2) / T_READY); return { psi: READY.psi * DEG * u, phi: (35 + (READY.phi - 35) * u) * DEG, rho: READY.rho * DEG * u }; }
    const a = { psi: READY.psi * DEG, phi: READY.phi * DEG, rho: READY.rho * DEG }, ts = t - tS;
    for (const m of plan.moves) a[m.ch] += m.d * m.f((ts - m.t0) / m.T);
    return a;
  };
  const M = t => mm(mm(W, handM(angles(t))), gp.G);
  const rate = t => { const e = 1e-5, A = M(t), dM = mt(M(t + e)).map((r, i) => r.map((v, j) => (v - mt(M(t - e))[i][j]) / (2 * e)));
    const S = mm(mt(A), mt(dM));                                                  // M^T dM/dt = skew(body rate)
    return [S[2][1], S[0][2], S[1][0]]; };
  const R = rng(seed * 31 + 5), dur = tS + plan.end + tail, t0 = 1000 + seed, out = [];
  const pad = gp.phone ? new PadMotion('zxy') : null;
  for (let k = 0; k * (1 / gp.hz) <= dur; k++) {
    const t = k / gp.hz, q = quatFromM(M(t)), r = rate(t).map(v => v + R.n() * noise);
    if (!pad) { out.push({ t: t0 + t, q, r, a: [0, 0, 0], _t: t }); continue; }
    const [alpha, beta, gamma] = toEuler(q), d = r.map(v => v / DEG);             // Chrome names rotationRate z,x,y (NAMINGS.zxy)
    pad.orientation({ alpha, beta, gamma }, t0 + t);
    const s = pad.motion({ rotationRate: { alpha: d[2], beta: d[0], gamma: d[1] }, acceleration: { x: 0, y: 0, z: 0 } }, t0 + t);
    if (s) out.push({ ...s, _t: t });
  }
  return { samples: out, plan, tStroke: tS, t0, truth: { M, rate } };
}
function toEuler(q) {                              // inverse of padmotion's eulerToQuat (Z X' Y''), degrees (as test/padmotion.test.mjs)
  const C = [qrot(q, [1, 0, 0]), qrot(q, [0, 1, 0]), qrot(q, [0, 0, 1])], m = (r, c) => C[c][r];
  return [Math.atan2(-m(0, 1), m(1, 1)) / DEG, Math.asin(clamp(m(2, 1), -1, 1)) / DEG, Math.atan2(-m(2, 0), m(2, 2)) / DEG];
}

// ---------- one settled swing event -> what the server does with it ----------
export function derive(e, grip = 'airpod', { client = clientOf, srv = server, chopRule = [CHOP, CHOP_N, CHOP_ADD] } = {}) {
  const power = e.power, sp = client(e);                                        // the phone's gain is applied inside motion.js (RATE_GAIN, NOTES 79), not to the power
  const n0 = clamp((power - 6) / 28, 0, 1), n = clamp(e.chop || 0, 0, 1) > chopRule[0] && n0 > chopRule[1] ? Math.min(1, n0 + chopRule[2]) : n0;
  const lob = sp.lob, slice = sp.slice, u = srv.underhand(lob), spin = srv.sliced(slice, lob), kind = srv.shotKind(n, lob, slice);
  const py = 1.0, sol = srv.solve([0, py, 6.5], 0, n, clamp(e.dir || 0, -1, 1), lob, slice), g = srv.gOf(sol.spin);
  const apex = py + Math.max(sol.v[1], 0) ** 2 / (2 * g);
  return { power, n, up: (e.lob || 0) / 0.8, chop: e.chop || 0, roll: e.roll || 0, turn: e.turn || 0, curl: e.curl || 0, dir: e.dir || 0,
    lob, gate: sp.g, underhand: u, slice, spin, kind, apex, T: sol.T, depth: Math.abs(sol.land[1]) };
}

// ---------- run a stroke through MotionModel ----------
export function runStroke({ stroke, grip = 'airpod', seed = 1, modelOpts = {}, client, srv, noise } = {}) {
  const syn = synthStroke(stroke, { grip, seed, noise }), m = new MotionModel({ RATE_GAIN: GRIPS[grip].gain, ...modelOpts });
  const swings = []; let cur = null, calAt = null;
  for (const s of syn.samples) {
    for (const e of m.feed({ t: s.t, q: s.q, r: s.r, a: s.a }, s.t * 1000 + 7)) {
      if (e.type === 'calibrated') calAt = s._t;
      if (e.type === 'swing') { cur = { tEmit: s._t - syn.tStroke, first: e, last: e }; swings.push(cur); }
      else if (e.type === 'swingFix' && cur) cur.last = e;
    }
  }
  if (calAt == null) throw new Error(`${stroke}/${grip}/seed ${seed}: calibration never finished`);
  if (calAt > syn.tStroke - 0.3) throw new Error(`${stroke}/${grip}/seed ${seed}: calibrated too late (${calAt.toFixed(2)} s)`);
  // B.R must be the synthetic player's right: the invariant that makes every shot ingredient grip-independent
  const h = syn.plan.heading * DEG, Rtrue = [Math.sin(h), -Math.cos(h), 0], err = Math.hypot(...m.B.R.map((v, i) => v - Rtrue[i]));
  if (err > 0.05) throw new Error(`${stroke}/${grip}/seed ${seed}: calibration found the wrong right axis (err ${err.toFixed(3)})`);
  // the swing live at contact: the last one reported by then (+80 ms: the first report of a swing that starts at contact)
  const c = syn.plan.contact; let hit = null;
  for (const sw of swings) if (sw.tEmit <= c + 0.08) hit = sw;
  if (!hit && swings.length) hit = swings[0];
  const row = hit ? derive(hit.last, grip, { client, srv }) : null;
  return { syn, swings, hit, row, before: swings.filter(sw => sw !== hit && sw.tEmit < (hit ? hit.tEmit : 0)) };
}

// peak body rate and the time from take-off (4 rad/s) to the peak, of the forward swing, from the synthesiser's own truth
export function strokeTruth(stroke, seed = 1) {
  const syn = synthStroke(stroke, { grip: 'airpod', seed, noise: 0 }), c = syn.plan.contact;
  let pk = 0, tp = 0; const rs = [];
  for (let t = -0.2; t <= syn.plan.end + 0.2; t += 0.002) { const w = Math.hypot(...syn.truth.rate(syn.tStroke + t)); rs.push([t, w]); if (Math.abs(t - c) < 0.25 && w > pk) { pk = w; tp = t; } }
  let t0 = tp; for (const [t, w] of rs) if (t < tp && w < 4) t0 = t;
  return { peak: pk, rise: tp - t0 };
}

// ---------- the report ----------
const median = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const fx = (v, d = 2) => (v == null || !Number.isFinite(v) ? '-' : v.toFixed(d));
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2), SEEDS = +(argv[argv.indexOf('--seeds') + 1] || 5) || 5, ROWS = argv.includes('--rows');
  const seeds = [0, ...Array.from({ length: SEEDS - 1 }, (_, i) => i + 1)];     // seed 0 = the nominal stroke, no variation

  // self-check: r agrees with the q sequence (r ~ 2 (q_k^-1 q_k+1).xyz / dt) on the fastest part of a stroke
  { const syn = synthStroke('smash', { grip: 'airpod', seed: 0, noise: 0 }), S = syn.samples; let worst = 0;
    for (let i = 1; i < S.length; i++) { const q0 = S[i - 1].q, q1 = S[i].q, dt = S[i].t - S[i - 1].t; let d = qmul(qconj(q0), q1); if (d[3] < 0) d = d.map(v => -v);
      const fd = [0, 1, 2].map(k => 2 * d[k] / dt), rm = [0, 1, 2].map(k => (S[i - 1].r[k] + S[i].r[k]) / 2), n = Math.hypot(...rm);
      if (n > 5) worst = Math.max(worst, Math.hypot(...fd.map((v, k) => v - rm[k])) / n); }
    console.log(`self-check: gyro r vs the q sequence, worst relative error above 5 rad/s = ${(worst * 100).toFixed(1)} %${worst > 0.05 ? '  <-- SYNTH BROKEN' : ''}`); }

  console.log(`\nforward-swing kinematics (nominal): motion.js measured arm swings peak 9-14 rad/s after 240-340 ms, flicks ~30 rad/s after 80-100 ms`);
  for (const k of Object.keys(STROKES)) { const t = strokeTruth(k, 0); console.log(`  ${STROKES[k].label.padEnd(40)} peak ${fx(t.peak, 1).padStart(5)} rad/s, rise ${Math.round(t.rise * 1000)} ms`); }

  const H = ['stroke', 'grip', 'expect', 'kinds (seeds)', 'sw#', 'power', 'n', 'up', 'turn', 'gate', 'lob', 'under', 'chop', 'roll', 'slice', 'spin', 'apex', 'T'];
  const W = [40, 13, 6, 22, 4, 5, 4, 5, 4, 4, 4, 5, 4, 5, 5, 4, 4, 4];
  const line = cells => cells.map((c, i) => String(c).padStart(i < 4 ? 0 : W[i]).padEnd(i < 4 ? W[i] : 0)).join(' ');
  console.log('\n' + line(H));
  console.log('  (medians over seeds. up = raw upward share of the hand path (e.lob / 0.8); gate = main.js roll veto 0..1; lob = what is sent; under = underhand(lob);');
  console.log('   slice = client signed spin; spin = sliced(); apex m / T s from solve() struck at 1.0 m from 6.5 m back; sw# = swings detected, * = an earlier one fired)');
  const bad = [];
  const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1].split(',') : Object.keys(STROKES);
  for (const k of only) for (const g of Object.keys(GRIPS)) {
    const res = seeds.map(seed => ({ seed, ...runStroke({ stroke: k, grip: g, seed }) })), rows = res.filter(r => r.row);
    const kinds = {}; for (const r of res) { const kd = r.row ? r.row.kind : 'none'; kinds[kd] = (kinds[kd] || 0) + 1; }
    const med = f => rows.length ? median(rows.map(r => r.row[f])) : NaN;
    const kstr = Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([a, b]) => `${a} ${b}`).join(', ');
    const sw = median(res.map(r => r.swings.length)) + (res.some(r => r.before.length) ? '*' : '');
    console.log(line([STROKES[k].label, GRIPS[g].label, STROKES[k].expect, kstr, sw, fx(med('power'), 1), fx(med('n')), fx(med('up')), fx(med('turn')), fx(med('gate')), fx(med('lob')), fx(med('underhand')), fx(med('chop')), fx(med('roll')), fx(med('slice')), fx(med('spin')), fx(med('apex'), 1), fx(med('T'))]));
    if (ROWS) for (const r of res) {
      const x = r.row, pre = r.before.map(b => { const d = derive(b.last, g); return `${d.kind}@${Math.round(b.tEmit * 1000)}ms(up ${fx(d.up)} chop ${fx(d.chop)} n ${fx(d.n)} apex ${fx(d.apex, 1)})`; }).join(' ');
      console.log(`      seed ${r.seed} heading ${Math.round(r.syn.plan.heading)}: ` + (x ? `${x.kind.padEnd(6)} power ${fx(x.power, 1)} n ${fx(x.n)} dir ${fx(x.dir)} up ${fx(x.up)} turn ${fx(x.turn)} gate ${fx(x.gate)} lob ${fx(x.lob)} under ${fx(x.underhand)} chop ${fx(x.chop)} roll ${fx(x.roll)} curl ${fx(x.curl)} slice ${fx(x.slice)} spin ${fx(x.spin)} apex ${fx(x.apex, 1)} T ${fx(x.T)}` : 'NO SWING') + (pre ? `   earlier: ${pre}` : ''));
    }
    const wrong = res.filter(r => !r.row || r.row.kind !== STROKES[k].expect && !(STROKES[k].expect === 'drive' && r.row.kind === 'smash'));
    if (wrong.length) bad.push(`${STROKES[k].label} / ${GRIPS[g].label}: ${wrong.length}/${res.length} not '${STROKES[k].expect}' (${kstr})`);
  }
  console.log('\nMISCLASSIFIED (a drive called smash counts as fine):'); for (const b of bad) console.log('  ' + b); if (!bad.length) console.log('  none');
}
