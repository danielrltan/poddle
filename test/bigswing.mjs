// A big forehand: slow 70deg wind-up to the right, 140deg swing to the left, hold the follow-through 0.6 s, return to ready.
// The rendered swing-arc offset must never jump, and must relax to ~0 while the follow-through is simply held.
import { MotionModel, qaxis, qmul } from '../web/motion.js';
const grip = qaxis([1, 2, 3], 0.7), D = Math.PI / 180, m = new MotionModel();
const ease = u => (u <= 0 ? 0 : u >= 1 ? 1 : u - Math.sin(2 * Math.PI * u) / (2 * Math.PI));
const yawAt = t => { t -= 8; return t < 0 ? 0 : t < 0.5 ? -70 * D * ease(t / 0.5) : t < 0.66 ? -70 * D + 140 * D * ease((t - 0.5) / 0.16) : t < 1.26 ? 70 * D : 70 * D * (1 - ease((t - 1.26) / 0.5)); };
const ori = t => (t < 6 ? [0, 0, 0, 1] : t < 7 ? qaxis([1, 0, 0], 0.6 * Math.sin((t - 6) * Math.PI)) : qaxis([0, 0, 1], yawAt(t)));
let k = 0, prev = null, maxJump = 0, maxOff = 0, held = null, end = null, evs = [];
for (let f = 0; f < 10.5 * 120; f++) { const now = f / 120;
  while (k * 0.02 <= now + 1e-9) { const t = k * 0.02, r = (yawAt(t + 0.001) - yawAt(t - 0.001)) / 0.002; k++;
    for (const e of m.feed({ t, q: qmul(ori(t), grip), r: [0, 0, r], a: [0, 0, 0] }, t * 1000)) if (e.type === 'swing' || e.type === 'flick') evs.push(`${e.type} ${(e.power || e.raw).toFixed(0)} rom ${e.rom.toFixed(0)}deg`); }
  if (now < 7.9) continue;
  const p = m.pose(now * 1000), o = p.offset, mag = Math.hypot(...o);
  if (prev) maxJump = Math.max(maxJump, Math.hypot(o[0] - prev[0], o[1] - prev[1], o[2] - prev[2])); prev = o; maxOff = Math.max(maxOff, mag);
  if (Math.abs(now - 9.2) < 0.005) held = mag; if (Math.abs(now - 10.4) < 0.005) end = mag; }
console.log('events:', evs.join(' | ') || 'none');
console.log(`arc peak ${maxOff.toFixed(2)} m | biggest frame-to-frame jump ${(maxJump * 100).toFixed(1)} cm @120Hz | offset while holding the follow-through ${(held * 100).toFixed(0)} cm | after returning ${(end * 100).toFixed(0)} cm`);
