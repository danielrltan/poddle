// Casual repositioning must never be CALLED a strong swing, not even for the 60 ms before a swingFix takes it back.
// Replays the zigzag of test/zigzag.mjs and prints the strongest first call and final power, per speed: once with no
// accelerometer (the arm-radius veto is off) and once with the centripetal pull of a hand on a 0.25 m forearm.
import { MotionModel, qaxis, qmul } from '../web/motion.js';
const grip = qaxis([1, 2, 3], 0.7); let bad = 0;
for (const R of [0, 0.25]) for (const [hz, deg] of [[2, 25], [2.2, 34], [2.5, 25], [3, 25], [3.5, 25], [4, 25]]) { const w = 2 * Math.PI * hz, A = deg * Math.PI / 180;
  let n = 0, first = 0, fin = 0, fixes = 0, high = 0;
  for (const ph of [0, 0.005, 0.01, 0.015]) { const m = new MotionModel();   // where the 20 ms sample grid falls on the wave decides what the model sees
  const yaw = t => (t < 8 ? 0 : A * Math.sin(w * (t - 8 + ph)));
  const ori = t => (t < 6 ? [0, 0, 0, 1] : t < 7 ? qaxis([1, 0, 0], 0.6 * Math.sin((t - 6) * Math.PI)) : qaxis([0, 0, 1], -yaw(t)));
  for (let i = 0; i < 700; i++) { const t = i * 0.02, r = t < 8 ? 0 : -A * w * Math.cos(w * (t - 8 + ph));
    for (const e of m.feed({ t, q: qmul(ori(t), grip), r: [0, 0, r], a: [r * r * R / 9.81, 0, 0] }, t * 1000)) {
      if (e.type === 'swing') { n++; first = Math.max(first, e.power); if (e.power > 14) high++; } else if (e.type === 'swingFix') fixes++; else if (e.type === 'swingEnd') fin = Math.max(fin, e.peak); } } }
  if (fin > 14 || high > 0.1 * n) bad++;
  console.log(`${hz} Hz +-${deg} deg zigzag${R ? `, ${R} m arm` : ', no accel  '}: ${String(n).padStart(3)} swing events, ${high} first called a real stroke (strongest ${first.toFixed(1)}), strongest final ${fin.toFixed(1)}, ${fixes} fixes`); }
console.log(bad ? bad + ' zigzags produced real strokes (power > 14: final, or > 10% of first calls)' : 'repositioning stays a tap (6 = TAP, 14+ = a real stroke)');
