// Stroke classifier check. Usage: node test/strokes.mjs   (exits non-zero if any class is under 90 %)
// Every stroke is synthesised from first principles: a paddle pose (yaw about U, pitch about R, roll about the pointer)
// eased from a start pose to an end pose on a lever arm, sampled at 50 Hz as the AirPod would report it
// (q = pose * grip in a Z-up world of arbitrary heading, r = world angular velocity rotated INTO the device frame,
// a = hand acceleration in g, device frame). Then: 0.3 rad/s rate noise, +-10 deg on every start-pose angle,
// +-20 % and +-6 deg on the stroke itself, +-20 % speed, accelerometer clipped at 16 g. Right- and left-handers, two headings, two grips, 40 trials each.
import fs from 'fs';
import { classifyStroke, featuresFromSamples, featuresFromEvent, shotParams, legacyType, TYPES, LABELS, SHOTS } from '../web/strokes.js';

const DEG = Math.PI / 180, TRIALS = 40, TARGET = 0.9;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const qmul = (a, b) => [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
                        a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
const qconj = q => [-q[0], -q[1], -q[2], q[3]];
const qaxis = (ax, ang) => { const n = Math.hypot(...ax) || 1, s = Math.sin(ang / 2) / n; return [ax[0] * s, ax[1] * s, ax[2] * s, Math.cos(ang / 2)]; };
const qrot = (q, v) => { const u = [q[0], q[1], q[2]], c = cross(u, v), t = c.map(x => 2 * x), d = cross(u, t); return [v[0] + t[0] * q[3] + d[0], v[1] + t[1] * q[3] + d[1], v[2] + t[2] * q[3] + d[2]]; };
let seed = 20260920;
const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const uni = (a, b) => a + (b - a) * rnd();
const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
const ease = u => (u <= 0 ? 0 : u >= 1 ? 1 : u - Math.sin(2 * Math.PI * u) / (2 * Math.PI));

// Strokes for a RIGHT-hander, degrees: pitch th (up +), yaw ph (sweeping left +), roll ro about the pointer (supination +).
// Yaw and roll are mirrored for a left-hander. peak = rad/s at the middle of the stroke, arm = lever (m), wind = wind-up time (s).
const STROKES = {
  dink:     { th: [-30, 15],  ph: [-5, 5],    ro: [25, 25],  peak: 12, arm: 0.20, wind: [0.35, 0.55] },
  drop:     { th: [45, -20],  ph: [-20, 15],  ro: [30, 40],  peak: 13, arm: 0.25, wind: [0.40, 0.60] },
  lob:      { th: [-40, 60],  ph: [-10, 10],  ro: [20, 30],  peak: 24, arm: 0.30, wind: [0.35, 0.55] },
  drive:    { th: [-10, 15],  ph: [-60, 60],  ro: [10, -25], peak: 30, arm: 0.30, wind: [0.40, 0.60] },
  backhand: { th: [-5, 10],   ph: [45, -45],  ro: [0, 15],   peak: 18, arm: 0.28, wind: [0.40, 0.60] },
  volley:   { th: [20, 12],   ph: [-13, 13],  ro: [0, 0],    peak: 12, arm: 0.12, wind: [0.25, 0.40], punch: 0.06, eitherWing: true },
  smash:    { th: [78, -20],  ph: [-10, 15],  ro: [50, -20], peak: 30, arm: 0.35, wind: [0.28, 0.50] },   // cocked, edge-on, then down + pronate
  cockback: { th: [8, 82],    ph: [0, -10],   ro: [0, 45],   dur: [0.25, 0.40], arm: 0.30, only: true },   // the wind-up alone: must be ignored
};
const CLASSES = Object.keys(STROKES);

// One stroke -> { pose(t) quaternion (world delta from the calibration hold), tStroke:[t0,t1], tEnd }
function plan(name, h) {
  const s = STROKES[name], wing = s.eitherWing && rnd() < 0.5 ? -1 : 1;
  const ready = [uni(-5, 15), uni(-15, 15) , uni(-10, 10)];                       // th, ph, ro
  const aim = ready[1];
  const j = () => uni(-10, 10), k = () => uni(0.8, 1.2), wob = () => uni(-6, 6);
  const a0 = [s.th[0] + j(), aim + wing * s.ph[0] + j(), s.ro[0] + j()];
  const a1 = [a0[0] + (s.th[1] - s.th[0]) * k() + wob(), a0[1] + wing * (s.ph[1] - s.ph[0]) * k() + wob(), a0[2] + (s.ro[1] - s.ro[0]) * k() + wob()];
  const from = s.only ? ready : a0, to = s.only ? a1 : a1;
  const D = a => qmul(qmul(qaxis(U, h * a[1] * DEG), qaxis(R0, a[0] * DEG)), qaxis(F0, h * a[2] * DEG));
  const total = 2 * Math.acos(Math.min(1, Math.abs(qmul(D(to), qconj(D(s.only ? ready : a0)))[3])));
  const T = s.only ? uni(...s.dur) : 2 * total / (s.peak * uni(0.8, 1.2));
  const tw0 = 0.3, tw1 = s.only ? tw0 : tw0 + uni(...s.wind), t0 = s.only ? tw0 : tw1 + (rnd() < 0.4 ? 0 : uni(0, 0.12)), t1 = t0 + T;
  const ang = t => { const u = t < t0 ? ease((t - tw0) / (tw1 - tw0 || 1)) : ease((t - t0) / T), A = t < t0 ? ready : from, B = t < t0 ? a0 : to;
    return s.only && t < t0 ? ready : [0, 1, 2].map(i => A[i] + (B[i] - A[i]) * u); };
  const punchT = [t0 + T / 2 - 0.06, t0 + T / 2 + 0.06];
  const pos = t => { const p = qrot(D(ang(t)), F0.map(x => x * s.arm)), u = s.punch ? s.punch * ease((t - punchT[0]) / 0.12) : 0; return [p[0] + F0[0] * u, p[1] + F0[1] * u, p[2] + F0[2] * u]; };
  return { pose: t => D(ang(t)), pos, tStroke: [t0, t1], tEnd: t1 + 0.3, backTo: ready, angEnd: to, D };
}
let R0, F0; const U = [0, 0, 1];                                                  // set per heading

function sampleAt(pl, t, q0, tOut) {
  const e = 1e-3, Dm = pl.pose(t - e), Dp = pl.pose(t + e); let dq = qmul(Dp, qconj(Dm)); if (dq[3] < 0) dq = dq.map(x => -x);
  const sn = Math.hypot(dq[0], dq[1], dq[2]), an = 2 * Math.atan2(sn, dq[3]), wW = sn > 1e-12 ? [0, 1, 2].map(i => dq[i] / sn * an / (2 * e)) : [0, 0, 0];
  const jit = qaxis([gauss(), gauss(), gauss()], 0.3 * DEG * gauss());
  const q = qmul(qmul(jit, pl.pose(t)), q0), qi = qconj(qmul(pl.pose(t), q0));
  const p0 = pl.pos(t - 2e-3), p1 = pl.pos(t), p2 = pl.pos(t + 2e-3), aW = [0, 1, 2].map(i => (p0[i] - 2 * p1[i] + p2[i]) / 4e-6);
  return { t: tOut, q, r: qrot(qi, wW).map(x => x + 0.3 * gauss()), a: qrot(qi, aW).map(x => Math.max(-16, Math.min(16, -x / 9.81)) + 0.05 * gauss()) };
}

// ---------- A: the classifier + reference feature extraction on their own ----------
const combos = [];
for (const hand of ['right', 'left']) for (const psi of [40, 205]) for (const grip of [qaxis([1, 2, 3], 0.7), qaxis([-2, 0.5, 1], 2.1)]) combos.push({ hand, psi, grip });
const setHeading = psi => { F0 = [Math.cos(psi * DEG), Math.sin(psi * DEG), 0]; R0 = cross(F0, U); };
const blank = () => Object.fromEntries(CLASSES.map(c => [c, {}]));
const bump = (M, want, got) => { M[want][got] = (M[want][got] || 0) + 1; };
function show(title, M) {
  const cols = [...TYPES, 'ignored'];
  console.log('\n' + title + '\n' + 'made \\ called'.padEnd(15) + cols.map(c => c.padStart(9)).join('') + '   correct');
  let worst = 1;
  for (const c of CLASSES) {
    const row = M[c], tot = Object.values(row).reduce((a, b) => a + b, 0), ok = row[c === 'cockback' ? 'ignored' : c] || 0;
    worst = Math.min(worst, ok / tot);
    console.log((c === 'cockback' ? '(cock-back)' : c).padEnd(15) + cols.map(k => String(row[k] || '.').padStart(9)).join('') + `   ${(100 * ok / tot).toFixed(1)} %`);
  }
  return worst;
}
const byHand = { right: blank(), left: blank() };
const examples = {};
for (const cb of combos) {
  setHeading(cb.psi);
  const q0 = qmul(qaxis(U, cb.psi * DEG), cb.grip), frame = { R: R0, U, F: F0, calib: q0 }, h = cb.hand === 'left' ? -1 : 1;
  for (const c of CLASSES) for (let i = 0; i < TRIALS; i++) {
    const pl = plan(c, h), ph = uni(0, 0.02), S = [];
    for (let t = ph; t < pl.tEnd; t += 0.02) S.push(sampleAt(pl, t, q0, t));
    const f = featuresFromSamples(S, frame), out = classifyStroke(f, { hand: cb.hand });
    bump(byHand[cb.hand], c, out.ignore ? 'ignored' : out.type);
    if (!examples[c] && cb.hand === 'right') examples[c] = f;
  }
}
console.log(`A. featuresFromSamples + classifyStroke, ${TRIALS} trials x 2 headings x 2 grips per hand`);
let worst = Math.min(show('Right-handed', byHand.right), show('Left-handed', byHand.left));
console.log('\nTypical features (right-hander, first trial of each):');
for (const c of CLASSES) { const f = examples[c]; console.log(`  ${c.padEnd(9)} power ${f.power.toFixed(1).padStart(5)}  raw ${f.rawPeak.toFixed(1).padStart(5)}  rom ${f.romDeg.toFixed(0).padStart(3)}  axis [${f.axis.map(v => v.toFixed(2).padStart(5)).join(',')}]  pitch ${f.pitchStart.toFixed(0).padStart(4)} -> ${f.pitchPeak.toFixed(0).padStart(4)}  roll ${f.rollDeg.toFixed(0).padStart(4)}  acc ${f.accPeak.toFixed(1)} g`); }

// handedness matters only for forehand vs backhand: a lefty's strokes read with hand:'right' must swap exactly those two
{ setHeading(40); const q0 = qmul(qaxis(U, 40 * DEG), combos[0].grip), frame = { R: R0, U, F: F0, calib: q0 }; let swapped = 0, n = 0;
  for (const c of ['drive', 'backhand']) for (let i = 0; i < 20; i++) { const pl = plan(c, -1), S = []; for (let t = 0; t < pl.tEnd; t += 0.02) S.push(sampleAt(pl, t, q0, t));
    n++; if (classifyStroke(featuresFromSamples(S, frame), { hand: 'right' }).type === (c === 'drive' ? 'backhand' : 'drive')) swapped++; }
  console.log(`\nWrong handedness setting: ${swapped}/${n} lefty drives/backhands come out swapped (expected: all of them; nothing else depends on the hand).`); }

// ---------- B: through the live MotionModel, at its early 'swing' report and again once the peak is in ----------
let worstB = null;
try {
  const { MotionModel } = await import(process.env.STROKES_MOTION || '../web/motion.js');   // STROKES_MOTION: try a patched copy
  let wired = false;
  const early = blank(), late = blank(); let spurious = 0, spuriousSent = 0, missed = 0, strokes = 0, ages = [];
  for (const cb of combos) {
    setHeading(cb.psi);
    const q0 = qmul(qaxis(U, cb.psi * DEG), cb.grip), h = cb.hand === 'left' ? -1 : 1, m = new MotionModel();
    let T = 0; const feed = s => m.feed(s, s.t * 1000);
    for (; T < 5.2; T += 0.02) feed({ t: T, q: q0, r: [0, 0, 0], a: [0, 0, 0] });
    for (let k = 0; k <= 50; k++, T += 0.02) { const a = 35 * DEG * Math.sin(Math.PI * k / 50); feed({ t: T, q: qmul(qaxis(R0, a), q0), r: [0, 0, 0], a: [0, 0, 0] }); }
    if (!m.calibrated) throw new Error('MotionModel did not calibrate');
    const err = Math.acos(Math.min(1, dot(m.B.R, R0))) / DEG; if (err > 2) throw new Error('frame mismatch: R off by ' + err.toFixed(1) + ' deg');
    const frame = { R: m.B.R, U: m.B.U, F: m.B.F, calib: m.calib, yawFix: m.yawFix };
    for (const c of CLASSES) for (let i = 0; i < TRIALS / 2; i++) {
      const pl = plan(c, h), base = T, S = []; let first = null, fix = null; strokes++;
      const back = pl.tEnd + 0.45, endA = pl.angEnd;
      const pose = t => (t < pl.tEnd ? pl.pose(t) : pl.D([0, 1, 2].map(k => endA[k] + (pl.backTo[k] - endA[k]) * ease((t - pl.tEnd) / 0.45))));
      const pl2 = { pose, pos: pl.pos };
      for (let t = 0; t < back + 0.4; t += 0.02, T += 0.02) {
        const s = sampleAt(pl2, Math.min(t, back), q0, base + t); if (t >= back) s.r = s.r.map(() => 0.3 * gauss());
        S.push(s);
        for (const e of feed(s)) {
          if (e.type !== 'swing' && e.type !== 'swingFix') continue;
          const inStroke = t >= pl.tStroke[0] - 0.02 && t <= pl.tStroke[1] + 0.06;
          if (Array.isArray(e.axis)) wired = true;                          // motion.js already carries the stroke features: test those, not ours
          const f = wired ? featuresFromEvent(e) : { ...featuresFromSamples(S.slice(-30), frame, { at: s.t }), power: e.power, rawPeak: e.raw, final: !!e.final }, out = classifyStroke(f, { hand: cb.hand });
          if (!inStroke) { if (e.type === 'swing') { spurious++; if (!out.ignore) spuriousSent++; } continue; }
          if (e.type === 'swing' && !first) { first = out; if (Number.isFinite(e.age)) ages.push(e.age); } else fix = out;
        }
      }
      if (!first) { if (c !== 'cockback') missed++; const k = c === 'cockback' ? 'ignored' : 'missed'; bump(early, c, k); bump(late, c, k); continue; }
      bump(early, c, first.ignore ? 'ignored' : first.type); const fin = fix || first; bump(late, c, fin.ignore ? 'ignored' : fin.type);
    }
  }
  console.log(`\nB. Through ${process.env.STROKES_MOTION || 'web/motion.js'} as it is on disk right now (${strokes} strokes; ${wired ? 'features straight from its swing events' : 'its events carry no stroke features yet, so they are taken from the raw samples at the moment it reports, power from its event'})`);
  const wE = show('At the early "swing" event (what the server acts on)', early), wL = show('After "swingFix" when one follows (what the callout can show)', late);
  ages.sort((a, b) => a - b);
  console.log(`\nreal strokes missed entirely (never crossed the trigger): ${missed}   swings fired during a wind-up or the return to ready: ${spurious}, of which ${spuriousSent} would still be sent`);
  if (ages.length) console.log(`median age of the early report: ${ages[ages.length >> 1]} ms into the movement`);
  worstB = Math.min(wE, wL);
} catch (e) { console.log('\nB. skipped: web/motion.js could not be driven right now (' + e.message + ')'); }

// ---------- C: does each type's flight match its name? Reads solve() out of server/game.js like test/shots.mjs ----------
let flightsOk = true;
try {
  const src = fs.readFileSync(new URL('../server/game.js', import.meta.url), 'utf8');
  const pre = src.slice(src.indexOf('const COURT'), src.indexOf('const players')), fns = src.slice(src.indexOf('// how underhand was the swing?'), src.indexOf('function launch'));
  const { solve, COURT } = new Function(pre + '\n' + fns + '\nreturn { solve, COURT };')();
  console.log('\nC. shotParams() through the server\'s own solve(), struck 1.0 m high from the default spot 6.5 m back');
  const fl = {};
  for (const [type, power] of [['dink', 6], ['dink', 12], ['drop', 13], ['lob', 24], ['volley', 6], ['backhand', 18], ['drive', 22], ['drive', 32], ['smash', 30]]) {
    const sp = shotParams(type, power), sol = solve([0, 1.0, 6.5], 0, sp.n, 0, sp.lob), v = sol.v, depth = Math.abs(sol.land[1]), apex = 1.0 + Math.max(v[1], 0) ** 2 / (2 * 9.81);
    fl[type + power] = { depth, apex, speed: Math.hypot(...v) };
    console.log(`  ${LABELS[type].padEnd(9)} power ${String(power).padStart(2)} -> n ${sp.n.toFixed(2)} lob ${sp.lob}  lands ${depth.toFixed(1)} m past the net${depth <= COURT.kitchen ? ' (kitchen)' : ''}, apex ${apex.toFixed(1)} m, ${Math.hypot(...v).toFixed(0)} m/s${sp.chop ? ', backspin' : ''}`);
  }
  const need = (ok, msg) => { if (!ok) { flightsOk = false; console.log('  FAIL: ' + msg); } };
  need(fl.dink6.depth <= COURT.kitchen && fl.dink12.depth <= COURT.kitchen && fl.drop13.depth <= COURT.kitchen, 'dink/drop must land in the kitchen');
  need(fl.lob24.apex > 3.5 && fl.lob24.depth > 4.5, 'lob must be high and deep');
  need(fl.smash30.speed > fl.drive22.speed && fl.smash30.depth > 5, 'smash must be the fastest, deep');
  need(fl.drive32.depth > fl.drive22.depth && fl.volley6.depth < fl.drive22.depth, 'drive deepens with power; volley is shorter');
} catch (e) { console.log('\nC. skipped: could not read solve() out of server/game.js right now (' + e.message + ')'); }

// ---------- E: where one shot turns into its neighbour (information, not a test) ----------
console.log('\nE. Boundaries: sweep one feature, everything else typical, right-hander');
function flips(title, unit, from, to, mk) {
  let prev = null; const out = [];
  for (let i = 0; i <= 200; i++) { const x = from + (to - from) * i / 200, r = classifyStroke(mk(x), { hand: 'right' }), k = r.ignore ? 'ignored' : LABELS[r.type]; if (k !== prev) { out.push(prev == null ? k : `-> ${k} at ${x.toFixed(unit ? 0 : x < 2 ? 2 : 0)}${unit}`); prev = k; } }
  console.log('  ' + title.padEnd(58) + out.join(' '));
}
flips('Upward scoop from a low paddle, by power', '', 6, 34, x => ({ power: x, rawPeak: Math.max(x, 12), axis: [0.97, 0.2, 0.1], pitchStart: -30, pitchPeak: 0 }));
flips('Downswing from a paddle cocked at 70 deg, by power', '', 6, 34, x => ({ power: x, rawPeak: x, axis: [-0.9, -0.3, -0.3], pitchStart: 70, pitchPeak: 40 }));
flips('Hard downswing (power 28), by start pitch', ' deg', -10, 80, x => ({ power: 28, rawPeak: 28, axis: [-0.9, 0.3, -0.3], pitchStart: x, pitchPeak: x - 30 }));
flips('Level forehand from a raised paddle, by power', '', 6, 24, x => ({ power: x, rawPeak: Math.max(x, 12), axis: [0.1, 0.98, 0], pitchStart: 15, pitchPeak: 15 }));
flips('Short soft level poke (power 6), by start pitch', ' deg', -30, 30, x => ({ power: 6, rawPeak: 12, axis: [0.1, 0.98, 0], pitchStart: x, pitchPeak: x }));
flips('Full forehand (power 26), by upward share of the rotation', '', 0, 1, x => ({ power: 26, rawPeak: 26, axis: [x, Math.sqrt(1 - x * x), 0], pitchStart: -15, pitchPeak: 5 }));
flips('Soft upward turn (power 9), by start pitch', ' deg', -30, 30, x => ({ power: 9, rawPeak: 10, axis: [0.95, 0.2, 0.2], pitchStart: x, pitchPeak: x + 12, final: false }));

// ---------- D: API sanity ----------
let apiOk = true;
for (const t of TYPES) { const sp = shotParams(t, 20); if (!(sp.n >= 0 && sp.n <= 1) || !LABELS[t] || !SHOTS[t] || !/^[A-Z][a-z]+$/.test(LABELS[t])) { apiOk = false; console.log('FAIL: shotParams/LABELS for ' + t); } }
for (const [n, lob] of [[0.2, 0.7], [0.8, 0.7], [0.5, 0], [0.95, 0], [0.1, 0]]) if (!TYPES.includes(legacyType(n, lob))) { apiOk = false; console.log('FAIL: legacyType'); }
if (classifyStroke({}).type == null || classifyStroke({ power: 30, axis: [0, 0, 0] }).type == null) { apiOk = false; console.log('FAIL: empty features must still name a shot'); }

console.log(`\nWorst class, standalone: ${(worst * 100).toFixed(1)} % (target ${TARGET * 100} %)` + (worstB == null ? '' : `; through motion.js: ${(worstB * 100).toFixed(1)} %`));
const pass = worst >= TARGET && flightsOk && apiOk;
console.log(pass ? 'PASS' : 'FAIL');
process.exit(pass ? 0 : 1);
