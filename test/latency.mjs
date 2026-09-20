// How long after a swing really starts does the 'swing' event fire, and is its power / dir / lob still right?
// Synthesises raised-cosine strokes at 10 sample phases, fed (a) on time and (b) with REAL AirPod arrival timing
// (data/live2.jsonl: pairs every ~40 ms, gaps to ~80 ms). "before" = web/motion.js as of commit 7b0b37a, if git has it.
// Usage: node test/latency.mjs [gyroNoiseRadPerS=0.3]
import { MotionModel, qaxis, qmul, qconj, qrot } from '../web/motion.js';
import { execSync } from 'child_process';
import fs from 'fs'; import os from 'os'; import path from 'path';
const NOISE = process.argv[2] != null ? +process.argv[2] : 0.3, D = Math.PI / 180, grip = qaxis([1, 2, 3], 0.7);
let Before = null;
try { const p = path.join(os.tmpdir(), `poddle-motion-before-${process.pid}.mjs`);
  fs.writeFileSync(p, execSync('git show 7b0b37a:web/motion.js', { cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'ignore'] }));
  Before = (await import(p)).MotionModel; fs.unlinkSync(p); } catch { console.log('(no git baseline: "before" columns skipped)'); }
let lat = [0];
try { const live = fs.readFileSync(new URL('../data/live2.jsonl', import.meta.url), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const l = live.map(r => r.at / 1000 - r.t), b = Math.min(...l); lat = l.map(v => v - b); } catch { console.log('(no data/live2.jsonl: paired timing = on time)'); }

// player frame after the scripted calibration: right = +x, toward the net = +y, up = +z. axis = [right, up] share of the stroke:
// +up = sweeps to the LEFT (righty forehand, dir < 0), -up = to the right (backhand), +right = scoops upward (lob > 0).
const U = [0, 1], B = [0, -1], UNDER_F = [0.85, 0.53], UNDER_B = [0.85, -0.53];
const STROKES = [
  { name: 'forehand 130°@30', deg: 130, peak: 30, axis: U, want: 30, dir: -1, lob: 0 },
  { name: 'huge forehand 160°@38', deg: 160, peak: 38, axis: U, want: 38, dir: -1, lob: 0 },
  { name: 'looped wind-up → 130°@30', deg: 130, peak: 30, axis: U, want: 30, dir: -1, lob: 0, loop: true },
  { name: 'backhand 100°@18', deg: 100, peak: 18, axis: B, want: 18, dir: 1, lob: 0 },
  { name: 'short backhand 70°@14', deg: 70, peak: 14, axis: B, want: 14, dir: 1, lob: 0 },
  { name: 'dink: underhand 80°@11', deg: 80, peak: 11, axis: UNDER_F, want: 11, dir: -1, lob: 1 },
  { name: 'lob: underhand 120°@26', deg: 120, peak: 26, axis: UNDER_B, want: 26, dir: 1, lob: 1 },
  { name: 'wrist flick 50°@30', deg: 50, peak: 30, axis: U, want: 6, dir: -1, lob: 0, tap: true },
  { name: 'wrist flick 40°@20', deg: 40, peak: 20, axis: B, want: 6, dir: 1, lob: 0, tap: true },
  { name: 'slow flick 50°@20', deg: 50, peak: 20, axis: U, want: 6, dir: -1, lob: 0, tap: true },
];
let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648, gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
const ease = u => (u <= 0 ? 0 : u >= 1 ? 1 : u - Math.sin(2 * Math.PI * u) / (2 * Math.PI));

// yaw/pitch script -> samples. motion(t) returns { ang, rate } about a fixed world axis, after the 8 s calibration.
function session(Model, axisRU, motion, phaseMs, paired, latShift) {
  const m = new Model(), ax = [axisRU[0], 0, axisRU[1]], n = Math.hypot(...ax), aW = ax.map(v => v / n), evs = [], samples = [];
  let free = [0, 0, 0, 1];                                            // strokes given as a world angular velocity are integrated at 1 kHz
  for (let i = 0; i < 500; i++) { const t = i * 0.02, mo = t < 7 ? { ang: 0, rate: 0 } : motion(t - 8 - phaseMs / 1000);
    if (mo.w && i) for (let k = 0; k < 20; k++) { const w = motion(t - 0.02 + k * 0.001 + 0.0005 - 8 - phaseMs / 1000).w; free = qmul(qaxis(w, Math.hypot(...w) * 0.001), free); }
    const o = t < 6 ? [0, 0, 0, 1] : t < 7 ? qaxis([1, 0, 0], 0.6 * Math.sin((t - 6) * Math.PI)) : mo.w ? free : qaxis(aW, mo.ang), q = qmul(o, grip);
    const r = qrot(qconj(q), mo.w || aW.map(v => v * mo.rate)).map(v => v + (t > 7.5 ? NOISE * gauss() : 0));
    samples.push({ at: t + (paired ? lat[(i + latShift) % lat.length] : 0), s: { t, q, r, a: [0, 0, 0] } }); }
  samples.sort((a, b) => a.at - b.at);
  for (const x of samples) for (const e of m.feed(x.s, x.at * 1000)) if (e.type === 'swing' || e.type === 'swingFix') evs.push({ ...e, ts: x.s.t - 8 - phaseMs / 1000, ta: x.at - 8 - phaseMs / 1000 });
  return evs;
}
const bell = u => (u > 0 && u < 1 ? 1 - Math.cos(2 * Math.PI * u) : 0);
function stroke(k) {
  const A = k.deg * D, T = 2 * A / k.peak;
  // a wind-up that loops into the swing without the hand ever going quiet: back (8 rad/s), up and over (5), then the forehand
  if (k.loop) return t => ({ w: [2.5 * bell((t + 0.12) / 0.24), 0, -4 * bell((t + 0.3) / 0.3) + k.peak / 2 * bell(t / T)] });
  return t => ({ ang: -A / 2 * ease((t + 1) / 0.8) + A * ease(t / T),                 // slow wind-up to -A/2, then the stroke
    rate: (t > -1 && t < -0.2 ? -A / 2 / 0.8 * (1 - Math.cos(2 * Math.PI * (t + 1) / 0.8)) : 0) + (t > 0 && t < T ? A / T * (1 - Math.cos(2 * Math.PI * t / T)) : 0) });
}
const stat = a => (a.length ? `${(a.reduce((x, y) => x + y, 0) / a.length).toFixed(0).padStart(3)} [${Math.min(...a).toFixed(0)}..${Math.max(...a).toFixed(0)}]`.padEnd(14) : '—'.padEnd(14));
function measure(Model, k, paired) {
  const out = { ms: [], arr: [], pw: [], fin: [], age: [], fixes: 0, none: 0, extra: 0, bad: 0 };
  for (let ph = 0; ph < 20; ph += 2) {
    const evs = session(Model, k.axis, stroke(k), ph, paired, ph * 37), sw = evs.filter(e => e.type === 'swing' && e.ts > -0.1), fx = evs.filter(e => e.type === 'swingFix');
    if (process.env.LAT_DEBUG && k.name.includes(process.env.LAT_DEBUG)) console.log(`   ${paired ? 'paired' : 'ontime'} ph ${ph}: ` + evs.map(e => `${e.type}@${(e.ts * 1000).toFixed(0)} p=${e.power.toFixed(1)} raw=${e.raw.toFixed(1)} age=${e.age}`).join('  '));
    if (!sw.length) { out.none++; continue; }
    const e = sw[0], f = fx.length ? fx[fx.length - 1] : e;
    out.extra += sw.length - 1 + evs.filter(e => e.type === 'swing' && e.ts <= -0.1).length; out.fixes += fx.length;
    out.ms.push(e.ts * 1000); out.arr.push(e.ta * 1000); out.pw.push(e.power); out.fin.push(f.power); if (e.age != null) out.age.push(e.age - e.ta * 1000);
    const under = f.lob / 0.8 > 0.525;                                // the server's dink/lob test
    if (Math.sign(f.dir) !== k.dir || under !== !!k.lob) out.bad++;
  }
  return out;
}
let fails = 0; const ok = (c, msg) => { if (!c) { fails++; console.log('  FAIL ' + msg); } };
for (const paired of [false, true]) {
  console.log(`\n=== ${paired ? 'REAL paired arrival timing (ms from true swing start to the event ARRIVING in the page)' : 'samples on time (ms from true swing start to the event, sensor clock)'}, gyro noise ${NOISE} rad/s, 10 phases each ===`);
  console.log('stroke'.padEnd(26) + (Before ? 'BEFORE ms'.padEnd(15) + 'power'.padEnd(15) : '') + 'AFTER ms'.padEnd(15) + 'power'.padEnd(15) + 'after fix'.padEnd(15) + 'fixes  dir/lob  age err ms');
  for (const k of STROKES) {
    const b = Before ? measure(Before, k, paired) : null, a = measure(MotionModel, k, paired), key = paired ? 'arr' : 'ms';
    console.log(k.name.padEnd(26) + (b ? stat(b[key]) + ' ' + stat(b.pw) + ' ' : '') + stat(a[key]) + ' ' + stat(a.pw) + ' ' + stat(a.fin) + ' ' + String(a.fixes).padEnd(6) + (a.bad ? a.bad + ' WRONG' : 'ok').padEnd(9) + stat(a.age));
    ok(!a.none && !a.extra, `${k.name}: ${a.none} missed, ${a.extra} extra swing events`);
    ok(!a.bad, `${k.name}: dir/lob wrong in ${a.bad} runs`);
    if (k.tap) ok(Math.max(...a.pw, ...a.fin) < 11.6, `${k.name}: a flick must stay a tap (server: n < 0.2 = power < 11.6), got ${Math.max(...a.pw, ...a.fin).toFixed(1)}`);
    else { ok(Math.max(...a.fin.map(p => Math.abs(p - k.want))) <= 0.12 * k.want + 1, `${k.name}: final power off by more than 12%`);
      ok(Math.max(...a.pw.map(p => Math.abs(p - k.want))) <= 0.2 * k.want + 1, `${k.name}: early power off by more than 20%`); }
  }
}
// casual repositioning: nothing strong may come out of it
console.log('\n=== repositioning (on time / paired): swing events and their strongest power ===');
for (const [name, mk] of [['2 Hz zigzag ±25°', t => ({ ang: 25 * D * Math.sin(4 * Math.PI * t), rate: 25 * D * 4 * Math.PI * Math.cos(4 * Math.PI * t) })],
  ['4 Hz zigzag ±25°', t => ({ ang: 25 * D * Math.sin(8 * Math.PI * t), rate: 25 * D * 8 * Math.PI * Math.cos(8 * Math.PI * t) })],
  ['quick 45° re-aim @10', t => { const A = 45 * D, T = 2 * A / 10; return { ang: A * ease(t / T), rate: t > 0 && t < T ? A / T * (1 - Math.cos(2 * Math.PI * t / T)) : 0 }; }]]) {
  const row = [];
  for (const M of [Before, MotionModel]) { if (!M) continue; let n = 0, fx = 0, top = 0;
    for (const paired of [false, true]) for (let ph = 0; ph < 20; ph += 5) for (const e of session(M, U, t => (t < 0 ? { ang: 0, rate: 0 } : mk(t)), ph, paired, ph * 37)) { if (e.type === 'swing') n++; else fx++; top = Math.max(top, e.power); }
    row.push(`${M === Before ? 'before' : 'after'}: ${n} swings${fx ? ' + ' + fx + ' fixes' : ''}, strongest ${top.toFixed(1)}`); if (M !== Before) ok(top < 14, `${name}: repositioning produced a ${top.toFixed(1)} swing`); }
  console.log(name.padEnd(26) + row.join('   |   '));
}
console.log(fails ? `\n${fails} FAILURES` : '\nLATENCY CHECKS PASSED'); process.exit(fails ? 1 : 0);
