// How well does the base follow a fast left-right zigzag of the wrist? Reports lag and amplitude kept, per speed.
import { MotionModel, qaxis, qmul, xOf } from '../web/motion.js';
const grip = qaxis([1, 2, 3], 0.7), A = 25 * Math.PI / 180;
for (const hz of [0.5, 1, 2, 3, 4]) {
  const m = new MotionModel(), w = 2 * Math.PI * hz;
  const yaw = t => (t < 8 ? 0 : A * Math.sin(w * (t - 8)));
  const ori = t => (t < 6 ? [0, 0, 0, 1] : t < 7 ? qaxis([1, 0, 0], 0.6 * Math.sin((t - 6) * Math.PI)) : qaxis([0, 0, 1], -yaw(t)));
  let swings = 0; const xs = [];
  for (let i = 0; i < 700; i++) { const t = i * 0.02;
    const r = t < 8 ? [0, 0, 0] : [0, 0, -A * w * Math.cos(w * (t - 8))];
    for (const e of m.feed({ t, q: qmul(ori(t), grip), r, a: [0, 0, 0] }, t * 1000)) if (e.type === 'swing') swings++;
    if (t > 9) { const p = m.pose(t * 1000); xs.push([t, p.x]); } }
  const ideal = t => xOf(yaw(t));
  let best = [1e9, 0]; for (let lag = 0; lag <= 0.4; lag += 0.005) { const e = xs.reduce((a, [t, x]) => a + (x - ideal(t - lag)) ** 2, 0); if (e < best[0]) best = [e, lag]; }
  const amp = (Math.max(...xs.map(v => v[1])) - Math.min(...xs.map(v => v[1]))) / 2, want = xOf(A);
  console.log(`${hz} Hz zigzag (peak ${(A * w).toFixed(1)} rad/s): lag ${(best[1] * 1000).toFixed(0)} ms, amplitude kept ${(amp / want * 100).toFixed(0)}%, false swings ${swings}`);
}
