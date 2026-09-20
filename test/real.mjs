// Replays a REAL capture of the player alternating snappy flicks and wide arm swings (data/live-swings.jsonl) through
// the motion model and prints what each movement was scored as. Usage: node test/real.mjs [file]
import { MotionModel, qaxis, qmul } from '../web/motion.js';
import fs from 'fs';
const rows = fs.readFileSync(new URL('../' + (process.argv[2] || 'data/live-swings.jsonl'), import.meta.url), 'utf8').trim().split('\n').map(l => JSON.parse(l));
const m = new MotionModel(), q0 = rows[0].q, T0 = rows[0].t - 8;
// calibrate on the capture's first pose: hold, tip up about a horizontal world axis, rest
for (let i = 0; i < 400; i++) { const t = T0 + i * 0.02, k = i * 0.02, tip = k < 5.4 ? 0 : k < 6 ? 0.6 * (k - 5.4) / 0.6 : 0.6; m.feed({ t, q: qmul(qaxis([1, 0, 0], tip), q0), r: [0, 0, 0], a: [0, 0, 0] }, t * 1000); }
if (!m.calibrated) { console.log('calibration failed'); process.exit(1); }
let cur = null; const out = [];
for (const r of rows) { const w = Math.hypot(...r.r);
  if (w >= 4) { cur = cur || { t0: r.t, peak: 0, tp: r.t, ev: [] }; if (w > cur.peak) { cur.peak = w; cur.tp = r.t; } } else if (cur) { if (cur.peak >= 9) out.push(cur); cur = null; }
  for (const e of m.feed(r, r.t * 1000)) if ((e.type === 'swing' || e.type === 'swingFix') && cur) cur.ev.push(e); }
let bad = 0;
for (const c of out) { const rise = (c.tp - c.t0) * 1000, kind = c.peak > 20 && rise <= 120 ? 'FLICK' : 'WIDE ', last = c.ev[c.ev.length - 1], first = c.ev[0];
  const n = last ? Math.max(0, Math.min(1, (last.power - 6) / 28)) : null;
  if (last && ((kind === 'FLICK' && n > 0.3) || (kind === 'WIDE ' && n < 0.35))) bad++;
  console.log(`${kind} peak ${c.peak.toFixed(0).padStart(3)} rad/s rise ${rise.toFixed(0).padStart(4)} ms -> ${last ? `power ${last.power.toFixed(0).padStart(3)} (n ${n.toFixed(2)})${c.ev.length > 1 ? `, first call ${first.power.toFixed(0)}` : ''}, reported ${first.age} ms in` : 'no swing'}`); }
console.log(bad ? bad + ' movements scored the wrong way round' : 'flicks are soft, wide swings are strong');
