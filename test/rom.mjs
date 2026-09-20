// Range of motion: a fast wrist flick must NOT count; arm swings score their peak. Usage: node test/rom.mjs
import { MotionModel, qaxis, qmul } from '../web/motion.js';
const grip = qaxis([1, 2, 3], 0.7);
function run(name, totalDeg, peak) {
  const m = new MotionModel(), A = totalDeg * Math.PI / 180, T = 2 * A / peak;       // raised-cosine sweep: peak rate = 2A/T... (A = peak*T/2)
  const ang = u => (u <= 0 ? 0 : u >= 1 ? A : A * (u - Math.sin(2 * Math.PI * u) / (2 * Math.PI)));
  const rate = u => (u <= 0 || u >= 1 ? 0 : (A / T) * (1 - Math.cos(2 * Math.PI * u)));
  const ori = t => (t < 6 ? [0, 0, 0, 1] : t < 7 ? qaxis([1, 0, 0], 0.6 * Math.sin((t - 6) * Math.PI)) : qaxis([0, 0, 1], ang((t - 8) / T) - A / 2));
  const out = []; let fireAt = null;
  for (let i = 0; i < 500; i++) { const t = i * 0.02;
    for (const e of m.feed({ t, q: qmul(ori(t), grip), r: [0, 0, t < 8 ? 0 : rate((t - 8) / T)], a: [0, 0, 0] }, t * 1000)) if (e.type !== 'cal' && e.type !== 'calibrated') { out.push(e); if (e.type === 'swing') fireAt = t - 8; } }
  const sw = out.find(e => e.type === 'swing'), fl = out.find(e => e.type === 'flick'), end = out.find(e => e.type === 'swingEnd');
  console.log(`${name.padEnd(34)} ${sw ? 'SWING power ' + sw.power.toFixed(1) + ' fired ' + (fireAt * 1000).toFixed(0) + 'ms in (swing lasts ' + (T * 1000).toFixed(0) + 'ms)' : fl ? 'flick, ignored (rom ' + fl.rom.toFixed(0) + '°)' : 'nothing'}${end ? '  total rom ' + end.rom.toFixed(0) + '°' : ''}`);
}
run('wrist flick 40° @ 20 rad/s', 40, 20);
run('hard wrist flick 50° @ 30 rad/s', 50, 30);
run('lazy half swing 70° @ 16', 70, 16);
run('short backhand 70° @ 14', 70, 14);
run('backhand 85° @ 16', 85, 16);
run('backhand 100° @ 18', 100, 18);
run('solid forehand 130° @ 30', 130, 30);
run('huge forehand 160° @ 38', 160, 38);
