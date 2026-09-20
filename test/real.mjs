// Replays a REAL capture through the motion model and prints, per movement, what it was scored as and WHEN the swing was
// reported. data/live-swings.jsonl (default) is the labelled set: the player alternating snappy flicks and wide arm swings.
// Usage: node test/real.mjs [file] [--model path/to/motion.js] [--quiet]     (captures: node test/record.mjs)
import fs from 'fs';
const args = process.argv.slice(2), mi = args.indexOf('--model'), quiet = args.includes('--quiet');
const modelPath = mi >= 0 ? args.splice(mi, 2)[1] : null, file = args.find(a => !a.startsWith('--')) || 'data/live-swings.jsonl';
const { MotionModel, qaxis, qmul } = await import(modelPath ? new URL(modelPath, 'file://' + process.cwd() + '/').href : '../web/motion.js');
const rows = fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(r => r.q && r.r);
const labelled = file.includes('live-swings');                      // the one capture where every movement is a deliberate flick or a deliberate wide swing
const timed = rows.every(r => r.at), off = timed ? Math.min(...rows.map(r => r.at - r.t * 1000)) : 0;   // sensor clock -> wall clock, from the least-delayed sample
const at = r => (timed ? r.at - off : r.t * 1000);                  // real arrival, ms on the sensor clock
const m = new MotionModel(), q0 = rows[0].q, T0 = rows[0].t - 8;
// calibrate on the capture's first pose: hold, tip up about a horizontal world axis, rest
for (let i = 0; i < 400; i++) { const t = T0 + i * 0.02, k = i * 0.02, tip = k < 5.4 ? 0 : k < 6 ? 0.6 * (k - 5.4) / 0.6 : 0.6; m.feed({ t, q: qmul(qaxis([1, 0, 0], tip), q0), r: [0, 0, 0], a: [0, 0, 0] }, t * 1000 + (timed ? 0 : 0)); }
if (!m.calibrated) { console.log('calibration failed'); process.exit(1); }
// a movement = a stretch at >= 4 rad/s that peaks at >= 9. Take-off = where the rate crossed 4 (interpolated).
let cur = null, prev = null; const out = [];
for (const r of rows) { const w = Math.hypot(...r.r);
  if (w >= 4) { if (!cur) { const w0 = prev ? Math.hypot(...prev.r) : 0; cur = { t0: prev && w > w0 ? r.t - (r.t - prev.t) * (w - 4) / (w - w0) : r.t, peak: 0, tp: r.t, ev: [], ang: 0, amax: 0 }; }
    cur.ang += w * (r.t - prev.t) / Math.PI * 180; cur.amax = Math.max(cur.amax, Math.hypot(...r.a)); cur.t1 = r.t;
    if (w > cur.peak) { cur.peak = w; cur.tp = r.t; cur.angPk = cur.ang; } }
  for (const e of m.feed(r, timed ? r.at : r.t * 1000)) if ((e.type === 'swing' || e.type === 'swingFix') && cur) cur.ev.push({ ...e, t: r.t, at: at(r) });
  if (w < 4 && cur) { if (cur.peak >= 9) out.push(cur); cur = null; }   // after the feed: the last fix often lands on the sample that ends the movement
  prev = r; }
const N = p => Math.max(0, Math.min(1, (p - 6) / 28)), pad = (v, n, d = 0) => v.toFixed(d).padStart(n);
const med = a => (a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : NaN), S = { FLICK: [], WIDE: [] };
for (const c of out) { const rise = (c.tp - c.t0) * 1000, kind = c.peak > 20 && rise <= 125 ? 'FLICK' : 'WIDE', first = c.ev[0], last = c.ev[c.ev.length - 1];
  const okN = n => (kind === 'FLICK' ? n <= 0.25 : n >= 0.55), o = { kind, c, first, last, small: !labelled && kind === 'WIDE' && (c.angPk < 80 || rise < 160) };
  if (first) Object.assign(o, { sens: (first.t - c.t0) * 1000, real: first.at - c.t0 * 1000, n1: N(first.power), n2: N(last.power), lastFix: (last.t - first.t) * 1000 });
  S[kind].push(o);
  if (!quiet) console.log(`${kind.padEnd(5)} peak ${pad(c.peak, 3)} rad/s rise ${pad(rise, 4)} ms ${pad(c.angPk, 3)} deg to peak, ${pad((c.t1 - c.t0) * 1000, 3)} ms long, ${pad(c.amax, 4, 1)} g -> ` + (first
    ? `swing at ${pad(o.sens, 4)} ms (real ${pad(o.real, 4)}) n ${o.n1.toFixed(2)}${okN(o.n1) ? '  ' : ' x'} -> final ${o.n2.toFixed(2)}${okN(o.n2) ? '  ' : ' x'} ${c.ev.length - 1} fix${c.ev.length > 1 ? ` (last +${pad(o.lastFix, 3)} ms)` : ''}  dir ${first.dir.toFixed(2)}>${last.dir.toFixed(2)} lob ${first.lob.toFixed(2)}>${last.lob.toFixed(2)}`
    : 'no swing')); }
// WIDE is everything that is not a flick: in free play that includes small repositioning moves, so outside the labelled
// capture the soft/strong line is only judged on the "big" ones (>= 80 deg and >= 160 ms to the peak).
for (const k of ['FLICK', 'WIDE']) { if (!S[k].some(o => o.first)) { console.log(`${k.padEnd(5)} ${S[k].length} movements, none reported`); continue; } const all = S[k], a = all.filter(o => o.first), judged = k === 'WIDE' ? a.filter(o => !o.small) : a, ok = n => (k === 'FLICK' ? n <= 0.25 : n >= 0.55);
  console.log(`${k.padEnd(5)} ${all.length} movements, ${all.length - a.length} with no swing | reported after take-off: median ${pad(med(a.map(o => o.sens)), 3)} ms, worst ${pad(Math.max(...a.map(o => o.sens)), 3)} ms on the sensor clock; median ${pad(med(a.map(o => o.real)), 3)} / worst ${pad(Math.max(...a.map(o => o.real)), 3)} ms real arrival`
    + ` | ${k === 'FLICK' ? 'soft (n<=0.25)' : `strong (n>=0.55${labelled ? '' : ', big ones only'})`}: first call ${judged.filter(o => ok(o.n1)).length}/${judged.length}, final ${judged.filter(o => ok(o.n2)).length}/${judged.length}`
    + ` | first call within 0.1 of final: ${a.filter(o => Math.abs(o.n1 - o.n2) <= 0.1).length}/${a.length}, dir within 0.3: ${a.filter(o => Math.abs(o.first.dir - o.last.dir) <= 0.3).length}/${a.length}`); }
