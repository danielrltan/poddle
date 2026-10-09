// How far behind the hand is the drawn paddle, and what does the jitter buffer buy? Replays the REAL AirPod captures
// (data/live2.jsonl, live-play-1/2/3, live-swings: real motion AND real arrival times) through MotionModel the way main.js
// drives it: feed() on arrival, pose() every rendered frame (60 / 120 Hz) plus the 20 Hz paddle sender's pose().
// The truth is the model's own per-sample snapshots, interpolated offline at the time each frame meant to show (NOTES 237).
// Per capture and buffer cap (AirPod 0.12 s; 0.2 = the same timing given what main.js gives a phone, a proxy: no phone capture exists):
//   D            render delay behind the newest sample time, ms: p50 / p90, share of frames AT the cap, p50 while swinging (|r| > 7.5)
//   underrun     frames that wanted a time later than the newest sample: episodes a minute, % of frames, longest (ms);
//                'need>cap' = would have underrun even at the cap; 'frozen' = beyond what coasting covers (the paddle stands still)
//   err          rendered paddle vs the truth at the wanted time: orientation deg p99 / max (0 while interpolating)
//   warp         % of frames whose playback speed is outside 0.9..1.1x (the delay sliding), and the extreme speeds
//   rough        test/jitter.mjs's measure on the rendered paddle (orientation step, % of the median), next to the same on the
//                truth drawn at a constant delay ('floor': what the real hand's own motion costs; real IMU noise makes both large)
//   jump         biggest frame-to-frame change of rendered angular velocity, rad/s (p99.9 / max), and the floor's
//   stall/snap   frames a minute, while the hand turns > 2 rad/s, drawn < 0.3x / > 2x the truth's step over the same wanted times
//   stale        how stale the newest sample is at each frame (ms): the depth a buffer needs to never run dry
//   SWINGS       the same over frames while swinging, plus the 'seen lag': which moment of the real hand the drawn paddle matches best
// Usage: node test/buflag.mjs [--hz 60,120] [--caps 0.12,0.2] [--only live-play-1,...] [--module copy/of/motion.js]
//                             [--opts '{"BUFFER_DRY":0.03}'] [--json out.json]
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : process.argv[i + 1]; };
const has = k => process.argv.includes('--' + k);
const MOD = arg('module', new URL('../web/motion.js', import.meta.url).pathname);
const { MotionModel, qmul, qconj, qrot, qslerp, qangle } = await import(pathToFileURL(path.resolve(MOD)).href);
const OPTS = JSON.parse(arg('opts', '{}')), HZ = arg('hz', '60,120').split(',').map(Number), CAPS = arg('caps', '0.12,0.2').split(',').map(Number);
const FILES = ['live2', 'live-play-1', 'live-play-2', 'live-play-3', 'live-swings'].filter(f => !arg('only') || arg('only').split(',').includes(f));
const DEG = Math.PI / 180, clamp = (v, a, b) => Math.max(a, Math.min(b, v)), lerp = (a, b, u) => a + (b - a) * u;
const pct = (a, p) => { if (!a.length) return NaN; const s = Float64Array.from(a).sort(); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const mul4 = (q, k) => q.map(v => v * k);

// the arc offset exactly as pose() builds it (kept in step with web/motion.js by hand)
function offsetOf(c, P, ref, punch, w) {
  const rel = qmul(P, qconj(ref)), ang = qangle(rel), lim = c.ARC_MAX * DEG;
  const relC = ang > 1e-6 ? qslerp([0, 0, 0, 1], rel[3] < 0 ? mul4(rel, -1) : rel, lim * Math.tanh(ang / lim) / ang) : rel;
  const a = qrot(qmul(relC, ref), c.ARM), b = qrot(ref, c.ARM), o = [0, 1, 2].map(i => (a[i] - b[i] + punch[i]) * w);
  return [clamp(o[0], -0.75, 0.75), clamp(o[1], -0.5, 0.6), clamp(o[2], -0.6, 0.2)];
}
function truthAt(H, c, tau) {                       // the model's own snapshots, interpolated at tau (null across a stream gap)
  let lo = 0, hi = H.length - 1; if (tau <= H[0].t || tau >= H[hi].t) return null;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (H[m].t <= tau) lo = m; else hi = m; }
  const a = H[lo], b = H[hi]; if (b.t - a.t > 0.1) return null;
  const u = (tau - a.t) / (b.t - a.t), P = qslerp(a.P, b.P, u), ref = qslerp(a.ref, b.ref, u), pu = [0, 1, 2].map(i => lerp(a.pu[i], b.pu[i], u));
  const o = offsetOf(c, P, ref, pu, lerp(a.w, b.w, u));
  return { P, pos: [lerp(a.x, b.x, u) + o[0], lerp(a.y, b.y, u) + o[1], o[2]] };
}

function replay(rows, cap, hz) {
  const m = new MotionModel({ ...(cap > 0.15 ? { BUFFER_DRY: 0.01 } : {}), BUFFER_MAX: cap, ...OPTS });      // the phone proxy gets what main.js gives a phone
  m.restore({ calib: [0, 0, 0, 1], holdQ: [0, 0, 0, 1], K: [0, 0, 0, 1], B: { R: [1, 0, 0], U: [0, 0, 1], F: [0, 1, 0] } });
  const at0 = rows[0].at, ev = rows.map(r => ({ a: (r.at - at0) / 1000 + 1, s: { t: r.t, q: r.q, r: r.r, a: r.a } })).sort((x, y) => x.a - y.a);
  const H = [], F = [];
  let k = 0, next20 = 1.007;
  const feedTo = now => { while (k < ev.length && ev[k].a <= now) { m.feed(ev[k].s, ev[k].a * 1000); k++;
    const S = m.snap, s = S[S.length - 1]; if (s && (!H.length || s.t > H[H.length - 1].t)) H.push(s); } };
  const end = ev[ev.length - 1].a;
  for (let f = Math.ceil(1.5 * hz); f / hz < end; f++) {
    const now = f / hz;
    while (next20 < now) { feedTo(next20); m.pose(next20 * 1000); next20 += 0.05; }      // main.js's 20 Hz sender calls pose() too
    feedTo(now);
    const p = m.pose(now * 1000); if (!p.calibrated || !m.snap.length) continue;
    const ts = now - m.off, newest = m.snap[m.snap.length - 1].t, D = m.D;
    F.push({ now, ts, D, want: ts - D, newest, P: p.P, pos: [p.x + p.offset[0], p.y + p.offset[1], p.offset[2]], rate: m.last ? m.last.rate : 0 });
  }
  return { F, H, c: m.c };
}

function metrics({ F, H, c }, cap, hz) {
  const dt = 1 / hz, Ds = [], swingD = [];
  let atCap = 0, under = 0, frozen = 0, eps = 0, longest = 0, run = 0, unav = 0, n = 0;
  const errA = [], warp = [], stepR = [], stepT = [], wR = [], wT = [], stale = [];
  let stalls = 0, snaps = 0, moving = 0, swStalls = 0, swSnaps = 0; const errS = [], jS = [], jSF = [], swLag = [], pj = [], pjF = []; let pv = null; let pw = null;
  let prev = null, prevT = null, prevTW = null, Dc = null;
  const coastMax = !H.length || !H[0].rP ? 0 : c.EXTRAP_MAX;      // a model that coasts through a dry buffer keeps its snapshots' rates
  for (const fr of F) {
    const T = truthAt(H, c, fr.want); if (!T) { prev = prevT = null; continue; }
    n++; Ds.push(fr.D); if (fr.D >= cap - 0.001) atCap++; if (fr.rate > 7.5) swingD.push(fr.D);
    const dry = fr.want > fr.newest + 1e-6;
    if (dry && (fr.want - fr.newest > coastMax + 1e-6)) frozen++;      // beyond what coasting covers: the paddle stands still
    if (dry) { under++; run++; if (run === 1) eps++; longest = Math.max(longest, run); if (fr.ts - cap > fr.newest + 1e-6) unav++; } else run = 0;
    const e = qangle(qmul(fr.P, qconj(T.P))) / DEG; errA.push(e); stale.push(fr.ts - fr.newest); const sw = fr.rate > 7.5; if (sw) errS.push(e);
    if (sw) {                                           // the lag the eye sees: which moment of the real hand does the drawn paddle match best?
      let best = 1e9, bl = NaN; for (let L = 0; L <= 0.25; L += 0.002) { const X = truthAt(H, c, fr.ts - L); if (!X) continue; const d = qangle(qmul(fr.P, qconj(X.P))); if (d < best) { best = d; bl = L; } }
      swLag.push(bl); }
    if (Dc == null) Dc = 0.1;
    const TC = truthAt(H, c, fr.ts - Dc);               // the floor: the truth drawn at a constant delay
    if (prev && TC && prevT) {
      warp.push((fr.want - prev.want) / dt);
      const sr = qangle(qmul(fr.P, qconj(prev.P))), st = qangle(qmul(TC.P, qconj(prevT.P))); stepR.push(sr); stepT.push(st);
      const vR = fr.pos.map((v, j) => (v - prev.pos[j]) / dt), vT = TC.pos.map((v, j) => (v - prevT.pos[j]) / dt);      // paddle velocity, m/s
      if (pv) { pj.push(Math.hypot(...vR.map((v, j) => v - pv[0][j]))); pjF.push(Math.hypot(...vT.map((v, j) => v - pv[1][j]))); } pv = [vR, vT];
      const sw0 = qangle(qmul(T.P, qconj(prevTW.P)));       // the truth over the same wanted interval: a slide of the delay is 'warp', not a stall or a snap
      if (sw0 / dt > 2) { moving++; if (sr < 0.3 * sw0) { stalls++; if (sw) swStalls++; } else if (sr > 2 * sw0 + 1 * dt) { snaps++; if (sw) swSnaps++; } }      // the hand moves (> 2 rad/s): drawn nearly still, or leaping
      if (pw && sw) { jS.push(Math.abs(sr - pw[0]) / dt); jSF.push(Math.abs(st - pw[1]) / dt); } pw = [sr, st];
    } else pw = pv = null;
    prev = fr; prevT = TC; prevTW = T;
  }
  for (let i = 0; i < stepR.length; i++) { wR.push(stepR[i] / dt); wT.push(stepT[i] / dt); }
  const rough = s => { const moving = s.filter(v => v > 1e-5); const med = pct(moving, 0.5) || 1; let a = 0; for (let i = 1; i < s.length; i++) a += Math.abs(s[i] - s[i - 1]); return a / s.length / med * 100; };
  const jumps = w => { const j = []; for (let i = 1; i < w.length; i++) j.push(Math.abs(w[i] - w[i - 1])); return j; };
  const jR = jumps(wR), jT = jumps(wT), mins = n * dt / 60;
  return {
    n, Dp50: pct(Ds, 0.5), Dp90: pct(Ds, 0.9), Dmean: Ds.reduce((a, b) => a + b, 0) / (Ds.length || 1), atCap: atCap / n, swingD: pct(swingD, 0.5), swingD90: pct(swingD, 0.9), swingN: swingD.length, swLag50: pct(swLag, 0.5), swLag90: pct(swLag, 0.9),
    errSw99: pct(errS, 0.99), errSwMax: errS.length ? Math.max(...errS) : NaN, jumpSw99: pct(jS, 0.99), jumpSwMax: jS.length ? Math.max(...jS) : NaN, jumpSwF99: pct(jSF, 0.99), swStallPm: swStalls / mins, swSnapPm: swSnaps / mins,
    staleP90: pct(stale, 0.9), staleP99: pct(stale, 0.99), stallPm: stalls / mins, snapPm: snaps / mins, movingPct: moving / n * 100,
    underEpm: eps / mins, underPct: under / n * 100, frozenPct: frozen / n * 100, longestMs: longest * dt * 1000, unavoidPct: unav / n * 100,
    err99: pct(errA, 0.99), errMax: Math.max(...errA), warpPct: warp.filter(v => v < 0.9 || v > 1.1).length / (warp.length || 1) * 100, warpMin: Math.min(...warp), warpMax: Math.max(...warp),
    posJump999: pct(pj, 0.999), posJumpMax: Math.max(...pj), posJumpF999: pct(pjF, 0.999), posJumpFMax: Math.max(...pjF),
    rough: rough(stepR), roughFloor: rough(stepT), jump999: pct(jR, 0.999), jumpMax: Math.max(...jR), jumpFloor999: pct(jT, 0.999), jumpFloorMax: Math.max(...jT),
  };
}

const out = {};
const f0 = (v, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : '-');
console.log(`module ${path.relative(process.cwd(), MOD)}  opts ${JSON.stringify(OPTS)}`);
console.log('capture        cap  Hz |  D p50  p90  @cap swingD |  underrun /min  %frm  long need>cap |  err p99   max | warp%   min..max | rough (floor) | jump p99.9  max (floor) | stall snap /min | stale p90 p99 | swing frames: D p50/p90, seen lag p50/p90, err p99');
for (const f of FILES) {
  let rows; try { rows = fs.readFileSync(new URL(`../data/${f}.jsonl`, import.meta.url), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(r => r.at != null); } catch { console.log(`${f}: missing, skipped`); continue; }
  for (const cap of CAPS) for (const hz of HZ) {
    const r = metrics(replay(rows, cap, hz), cap, hz); out[`${f}|${cap}|${hz}`] = r;
    console.log(`${f.padEnd(13)} ${cap.toFixed(2)} ${String(hz).padStart(3)} | ${f0(r.Dp50 * 1000).padStart(5)} ${f0(r.Dp90 * 1000).padStart(4)} ${f0(r.atCap * 100).padStart(4)}% ${f0(r.swingD * 1000).padStart(5)}  | ${f0(r.underEpm, 1).padStart(8)} ${f0(r.underPct, 2).padStart(5)} ${f0(r.longestMs).padStart(5)} ${f0(r.unavoidPct, 2).padStart(5)}% | ${f0(r.err99, 2).padStart(7)} ${f0(r.errMax, 1).padStart(5)} | ${f0(r.warpPct, 1).padStart(5)} ${f0(r.warpMin, 2)}..${f0(r.warpMax, 2)} | ${f0(r.rough, 1).padStart(5)} (${f0(r.roughFloor, 1)}) | ${f0(r.jump999, 1).padStart(6)} ${f0(r.jumpMax, 1).padStart(5)} (${f0(r.jumpFloor999, 1)} ${f0(r.jumpFloorMax, 1)}) | ${f0(r.stallPm, 1).padStart(5)} ${f0(r.snapPm, 1).padStart(5)} | ${f0(r.staleP90 * 1000).padStart(4)} ${f0(r.staleP99 * 1000).padStart(4)} | swings ${r.swingN}: D ${f0(r.swingD * 1000)}/${f0(r.swingD90 * 1000)} seen ${f0(r.swLag50 * 1000)}/${f0(r.swLag90 * 1000)} err ${f0(r.errSw99, 2)}`);
  }
}
// summary across the play captures: what a player sees most of the time
const keys = Object.keys(out);
for (const cap of CAPS) for (const hz of HZ) {
  const ks = keys.filter(k => k.endsWith(`|${cap}|${hz}`)); if (!ks.length) continue;
  const wm = q => { let a = 0, W = 0; for (const k of ks) if (Number.isFinite(out[k][q])) { a += out[k][q] * out[k].n; W += out[k].n; } return a / W; }, mx = q => Math.max(...ks.map(k => out[k][q]).filter(Number.isFinite));
  console.log(`ALL           ${cap.toFixed(2)} ${String(hz).padStart(3)} | D mean ${f0(wm('Dmean') * 1000)} ms, p50 ${f0(wm('Dp50') * 1000)}, p90 ${f0(wm('Dp90') * 1000)}, @cap ${f0(wm('atCap') * 100)}%, swing ${f0(wm('swingD') * 1000)} | underrun ${f0(wm('underEpm'), 1)}/min ${f0(wm('underPct'), 2)}% (need>cap ${f0(wm('unavoidPct'), 2)}%), frozen ${f0(wm('frozenPct'), 2)}%, longest ${f0(mx('longestMs'))} | err p99 ${f0(wm('err99'), 2)} max ${f0(mx('errMax'), 1)} | warp ${f0(wm('warpPct'), 1)}% | rough ${f0(wm('rough'), 1)} (${f0(wm('roughFloor'), 1)}) | jump p99.9 ${f0(wm('jump999'), 1)} max ${f0(mx('jumpMax'), 1)} | stall ${f0(wm('stallPm'), 1)} snap ${f0(wm('snapPm'), 1)} /min | paddle velocity jump p99.9 ${f0(wm('posJump999'), 2)} max ${f0(mx('posJumpMax'), 2)} m/s (floor ${f0(wm('posJumpF999'), 2)} ${f0(mx('posJumpFMax'), 2)})\n                       SWINGS: D p50 ${f0(wm('swingD') * 1000)} p90 ${f0(wm('swingD90') * 1000)} ms, seen lag p50 ${f0(wm('swLag50') * 1000)} p90 ${f0(wm('swLag90') * 1000)} ms | err p99 ${f0(wm('errSw99'), 2)} max ${f0(mx('errSwMax'), 1)} deg | jump p99 ${f0(wm('jumpSw99'), 1)} max ${f0(mx('jumpSwMax'), 1)} (floor p99 ${f0(wm('jumpSwF99'), 1)}) | stall ${f0(wm('swStallPm'), 2)} snap ${f0(wm('swSnapPm'), 2)} /min`);
}
if (arg('json')) fs.writeFileSync(arg('json'), JSON.stringify(out, null, 1));
