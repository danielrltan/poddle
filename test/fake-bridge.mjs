// Fake "AirPod": synthesises {t,q,r,a} at 50Hz from first principles and serves it like bridge/bridge.js.
//   node test/fake-bridge.mjs [port=8788] [headingDeg=137]
// Also exports the synthesiser for test/motion.test.mjs. Ground truth is built with rotation MATRICES
// (v_ref = M v_dev), independent of the quaternion code in web/motion.js.
const DEG = Math.PI / 180, G = 9.81;

// ---------- matrix kit (row-major 3x3) ----------
const mm = (A, B) => A.map((r, i) => [0, 1, 2].map(j => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
const mv = (A, v) => A.map(r => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
const mt = A => [0, 1, 2].map(i => [0, 1, 2].map(j => A[j][i]));
const I3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
export function rotM(axis, ang) {                  // Rodrigues, right-handed, active
  const n = Math.hypot(...axis) || 1, [x, y, z] = axis.map(v => v / n), c = Math.cos(ang), s = Math.sin(ang), C = 1 - c;
  return [[c + x * x * C, x * y * C - z * s, x * z * C + y * s],
          [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
          [z * x * C - y * s, z * y * C + x * s, c + z * z * C]];
}
export function quatFromM(m) {                     // [x,y,z,w] with q v q* = M v (Hamilton). No sign continuity, like a real sensor.
  const tr = m[0][0] + m[1][1] + m[2][2]; let q;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; q = [(m[2][1] - m[1][2]) / s, (m[0][2] - m[2][0]) / s, (m[1][0] - m[0][1]) / s, s / 4]; }
  else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) { const s = Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]) * 2; q = [s / 4, (m[0][1] + m[1][0]) / s, (m[0][2] + m[2][0]) / s, (m[2][1] - m[1][2]) / s]; }
  else if (m[1][1] > m[2][2]) { const s = Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]) * 2; q = [(m[0][1] + m[1][0]) / s, s / 4, (m[1][2] + m[2][1]) / s, (m[0][2] - m[2][0]) / s]; }
  else { const s = Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]) * 2; q = [(m[0][2] + m[2][0]) / s, (m[1][2] + m[2][1]) / s, s / 4, (m[1][0] - m[0][1]) / s]; }
  return q;
}
export function rng(seed) {                        // mulberry32 + Box-Muller
  let a = seed >>> 0;
  const u = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { u, n: () => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u()) };
}

// ---------- motion profiles: s(u) goes 0 -> 1, ds = ds/du ----------
export const PROFILE = {
  cos: { s: u => u - Math.sin(2 * Math.PI * u) / (2 * Math.PI), ds: u => 1 - Math.cos(2 * Math.PI * u), peak: 2 },   // peak rate = 2*angle/T
  // hard stop: ramps up over the first 40%, holds speed, then stops dead over the last 25% (40 ms of a 0.16 s swing)
  abrupt: (() => {
    const a = 0.4, b = 0.75, vmax = 1 / (a / 2 + (b - a) + (1 - b) / 2);
    const ds = u => u < a ? vmax * u / a : u < b ? vmax : vmax * (1 - u) / (1 - b);
    const s = u => u < a ? vmax * u * u / (2 * a) : u < b ? vmax * (a / 2 + u - a) : 1 - vmax * (1 - u) * (1 - u) / (2 * (1 - b));
    return { s, ds, peak: vmax };
  })(),
};

// A segment: { T, axis:[right,up,forward] in PLAYER terms, deg, profile } or { T } to hold still.
// Positive rotation about right = tip up. Positive about up = CCW seen from above = sweeping/pointing LEFT.
export function makeSynth({ heading = 0, grip = [0.3, -0.5, 0.8, 1.1], script = [], loop = null, accSign = -1,
                            gyroNoise = 0, accNoise = 0, seed = 1, t0 = 3580.12, rateHz = 50, arm = [0.08, -0.10, 0.45] } = {}) {
  const h = heading * DEG;
  const F = [Math.cos(h), Math.sin(h), 0], U = [0, 0, 1], R = [Math.sin(h), -Math.cos(h), 0];   // R x F = U, F = U x R
  const M0 = mm(rotM(U, h), rotM(grip.slice(0, 3), grip[3]));                                  // how the bud sits in the hand
  const world = a => [0, 1, 2].map(i => a[0] * R[i] + a[1] * U[i] + a[2] * F[i]);
  const armW = world(arm);                                                                      // pivot -> bud, at rest
  const compile = (segs, Dstart) => { let t = 0, D = Dstart; const out = [];
    for (const sg of segs) { const n0 = sg.axis ? world(sg.axis) : [0, 0, 1], n = n0.map(v => v / Math.hypot(...n0)), ang = (sg.deg || 0) * DEG, p = PROFILE[sg.profile || 'cos'];
      out.push({ t0: t, T: sg.T, n, ang, p, D0: D, tag: sg.tag }); D = mm(rotM(n, ang), D); t += sg.T; }
    return { segs: out, dur: t, Dend: D }; };
  const pre = compile(script, I3), lp = loop ? compile(loop, pre.Dend) : null;
  const find = t => {
    let c = pre, tt = t;
    if (t >= pre.dur && lp) { c = lp; tt = (t - pre.dur) % lp.dur; }
    for (const sg of c.segs) if (tt < sg.t0 + sg.T) return { sg, u: clamp01((tt - sg.t0) / sg.T) };
    return { sg: null, D: c.Dend };
  };
  const D = t => { const f = find(Math.max(t, 0)); return f.sg ? mm(rotM(f.sg.n, f.sg.ang * f.sg.p.s(f.u)), f.sg.D0) : f.D; };
  const omega = t => { const f = find(Math.max(t, 0)); return f.sg && f.sg.ang ? f.sg.n.map(v => v * f.sg.ang * f.sg.p.ds(f.u) / f.sg.T) : [0, 0, 0]; };
  const pos = t => mv(D(t), armW);
  const rnd = rng(seed); let N = I3, k = 0;
  const truth = t => ({ D: D(t), M: mm(D(t), M0), omega: omega(t), R, U, F });
  const next = () => {
    const t = k / rateHz, e = 1e-3, Mt = mm(mm(D(t), M0), N);
    const w = omega(t), acc = [0, 1, 2].map(i => (pos(t + e)[i] - 2 * pos(t)[i] + pos(t - e)[i]) / (e * e));
    const noise = [0, 1, 2].map(() => rnd.n() * gyroNoise);
    const r = mv(mt(Mt), w).map((v, i) => v + noise[i]);
    const a = mv(mt(Mt), acc).map(v => accSign * v / G + rnd.n() * accNoise);
    if (gyroNoise) N = mm(N, rotM(noise, Math.hypot(...noise) / rateHz));     // attitude integrates the same gyro noise
    k++;
    return { t: t0 + t, q: quatFromM(Mt), r, a, _t: t };
  };
  const tagTime = tag => { for (const c of [pre, lp]) if (c) for (const sg of c.segs) if (sg.tag === tag) return { t0: sg.t0 + (c === lp ? pre.dur : 0), T: sg.T, peak: Math.abs(sg.ang) * sg.p.peak / sg.T }; return null; };
  return { next, truth, tagTime, dur: pre.dur, loopDur: lp ? lp.dur : 0, t0, R, U, F };
}
const clamp01 = v => Math.max(0, Math.min(1, v));

// ---------- reusable script pieces ----------
export const CALIBRATE = [{ T: 0.5, axis: [0.3, 1, 0.2], deg: 4 }, { T: 0.5, axis: [0.3, 1, 0.2], deg: -4 },   // 1 s settle
  { T: 6 }, { T: 0.7, axis: [1, 0, 0], deg: 35 }, { T: 1.4 }];   // hold, tip up, then REST there: that resting pose becomes neutral
export const SESSION_LOOP = [
  { T: 0.35, axis: [0, 1, 0], deg: 18, tag: 'left' }, { T: 0.8 }, { T: 0.35, axis: [0, 1, 0], deg: -18 },
  { T: 0.45, axis: [0, 1, 0], deg: -18, tag: 'right' }, { T: 0.7 }, { T: 0.45, axis: [0, 1, 0], deg: 18 }, { T: 0.3 },
  { T: 0.4, axis: [0, 1, 0], deg: -45 }, { T: 0.18, axis: [0.15, 1, 0], deg: 120, tag: 'forehand' }, { T: 0.12 },
  { T: 0.6, axis: [0.15, 1, 0], deg: -120 }, { T: 0.6, axis: [0, 1, 0], deg: 45 }, { T: 0.3 },
  { T: 0.4, axis: [0, 1, 0], deg: 45 }, { T: 0.18, axis: [0.1, -1, 0], deg: 120, tag: 'backhand' }, { T: 0.12 },
  { T: 0.6, axis: [0.1, -1, 0], deg: -120 }, { T: 0.6, axis: [0, 1, 0], deg: -45 }, { T: 0.3 },
  { T: 0.4, axis: [1, 0, 0], deg: -40 }, { T: 0.2, axis: [1, 0.25, 0], deg: 100, tag: 'lob' }, { T: 0.12 },
  { T: 0.6, axis: [1, 0.25, 0], deg: -100 }, { T: 0.6, axis: [1, 0, 0], deg: 40 }, { T: 0.4 },
];

// ---------- ws server (only when run directly) ----------
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { WebSocketServer } = await import('ws');
  const port = +process.argv[2] || 8788, heading = process.argv[3] === undefined ? 137 : +process.argv[3];
  const wss = new WebSocketServer({ port });
  wss.on('connection', ws => {                     // every client gets its own session, from the settle onwards
    const syn = makeSynth({ heading, script: CALIBRATE, loop: SESSION_LOOP, gyroNoise: 0.02, accNoise: 0.005, seed: 7 });
    const start = performance.now(); let sent = 0;
    const tick = setInterval(() => {
      const due = Math.floor((performance.now() - start) / 20);
      while (sent <= due && ws.readyState === 1) { const s = syn.next(); delete s._t; ws.send(JSON.stringify(s)); sent++; }
    }, 5);
    ws.on('close', () => clearInterval(tick)); ws.on('error', () => clearInterval(tick));
  });
  console.log(`fake bridge on ws://localhost:${port} (heading ${heading} deg)`);
}
