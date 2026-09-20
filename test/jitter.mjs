// Replays REAL AirPod arrival timing (pairs every ~40ms, gaps to ~80ms) over a synthetic smooth sweep and measures
// how smooth pose() is at 120Hz. Usage: node test/jitter.mjs
import { MotionModel, qaxis, qmul } from '../web/motion.js';
import fs from 'fs';
const live = fs.readFileSync(new URL('../data/live2.jsonl', import.meta.url), 'utf8').trim().split('\n').map(l => JSON.parse(l));
const lateness = live.map(r => r.at / 1000 - r.t); const base = Math.min(...lateness);
const lat = lateness.map(l => l - base);                      // real per-sample arrival lateness, seconds
const m = new MotionModel();
const grip = qaxis([1, 2, 3], 0.7);
const ori = t => {                                            // hold 6s, tilt up, then smooth sinusoidal yaw sweep (repositioning speed)
  if (t < 6) return [0, 0, 0, 1];
  if (t < 7) return qaxis([1, 0, 0], 0.6 * Math.sin((t - 6) * Math.PI));
  return qaxis([0, 0, 1], 0.5 * Math.sin((t - 7) * 2.2));
};
const events = [];
for (let i = 0; i < 1400; i++) { const t = i * 0.02; events.push({ at: t + lat[i % lat.length], s: { t, q: qmul(ori(t), grip), r: [0, 0, t > 7 ? 1.1 * Math.cos((t - 7) * 2.2) : 0], a: [0, 0, 0] } }); }
events.sort((a, b) => a.at - b.at);
let k = 0; const steps = []; let prev = null, stalls = 0;
for (let f = 0; f < 28 * 120; f++) {
  const now = f / 120;
  while (k < events.length && events[k].at <= now) { m.feed(events[k].s, events[k].at * 1000); k++; }
  if (now < 9) continue;
  const p = m.pose(now * 1000); if (!p.calibrated) continue;
  const v = [p.x + p.offset[0], p.y + p.offset[1], p.offset[2], p.P[2]];
  if (prev) { const d = Math.hypot(v[0] - prev[0], v[1] - prev[1], v[2] - prev[2]) + Math.abs(v[3] - prev[3]); steps.push(d); }
  prev = v;
}
const med = [...steps].sort((a, b) => a - b)[steps.length >> 1];
for (let i = 3; i < steps.length - 3; i++) { const loc = [...steps.slice(i - 3, i + 4)].sort((a, b) => a - b)[3]; if (loc > med * 0.3 && steps[i] < loc * 0.15) stalls++; }
const rough = steps.slice(1).reduce((a, d, i) => a + Math.abs(d - steps[i]), 0) / steps.length / med;
console.log(`frames ${steps.length}  stalled frames ${stalls}  roughness ${(rough * 100).toFixed(1)}% of median step  render delay ${(m.D * 1000).toFixed(0)} ms`);
