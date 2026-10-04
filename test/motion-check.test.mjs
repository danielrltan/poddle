// R19 (NOTES 198): server/stats.js checks every swing against the paddle stream the client sends at 20 Hz. Real play must never trip it:
// every capture in data/ is replayed through web/motion.js, sampled at 20 Hz the way web/main.js sends paddle messages, with swings and
// fixes sent as main.js sends them, over a link with jitter (in order, like TCP). Scripted clients must trip it: swings with a still
// paddle, a forged turn rate with no turn, a big claimed peak over a small hand, no paddle stream at all. Pure: no server, no network.
// Usage: node test/motion-check.test.mjs  [MOTION_DATA=dir/]   Last line: MOTION CHECK PASSED or n FAILURES.
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const stats = require('../server/stats.js');
const { MotionModel, qaxis, qmul } = await import('../web/motion.js');
let fails = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
const root = new URL('..', import.meta.url).pathname, DATA = process.env.MOTION_DATA || root + 'data/';   // MOTION_DATA: another folder of captures (untracked ones)

stats.init({ env: { STATS_MOTION: '1' } });
const fresh = () => { const pl = { side: 0 }, m = stats.newMatch({ seats: [pl, null] }); return { pl, m, seat: () => m.seats[0] }; };
let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

console.log('real play: no capture trips R19');
const caps = fs.readdirSync(DATA).filter(f => f.endsWith('.jsonl'));
let total = 0;
// [phase ms, link jitter ms, motion burst ms (phone samples relayed through the server arrive in clumps), share of 20 Hz ticks dropped (a long frame)]
const RUNS = [[0, 0, 0, 0], [17, 40, 0, 0], [33, 90, 0, 0], [9, 40, 120, 0], [21, 40, 150, 0.12], [41, 90, 100, 0.2]];
for (const file of caps) for (const [phase, jit, burst, drop] of RUNS) {
  const rows = fs.readFileSync(DATA + file, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(r => r.q && r.r);
  const timed = rows.every(r => r.at), off = timed ? Math.min(...rows.map(r => r.at - r.t * 1000)) : 0, at = r => (timed ? r.at - off : r.t * 1000);
  const mm = new MotionModel(), q0 = rows[0].q, T0 = rows[0].t - 8;
  for (let i = 0; i < 400; i++) { const t = T0 + i * 0.02, k = i * 0.02, tip = k < 5.4 ? 0 : k < 6 ? 0.6 * (k - 5.4) / 0.6 : 0.6; mm.feed({ t, q: qmul(qaxis([1, 0, 0], tip), q0), r: [0, 0, 0], a: [0, 0, 0] }, T0 * 1000 + off + i * 20); }
  const { pl, m, seat } = fresh(); let next = at(rows[0]) + phase, last = 0, swings = 0, dropRun = 0;
  const arrive = t => (last = Math.max(last, t + rnd() * jit));      // one socket: in order, each message a little late
  for (const r of rows) {
    const now = at(r);
    const got = burst ? Math.ceil(now / burst) * burst : now;     // when the tab really has this sample
    while (next <= got) { const p = mm.pose(next), skip = drop && (rnd() < drop || (dropRun > 0 && dropRun--)); if (skip && !dropRun && rnd() < 0.3) dropRun = 2;
      if (p.calibrated && !skip) stats.motion(m, pl, Math.round((p.rate || 0) * 10) / 10, p.Pd, arrive(next)); next += 50; }
    for (const e of mm.feed({ ...r }, got)) if (e.type === 'swing' || e.type === 'swingFix') { if (e.type === 'swing') swings++; stats.swingSeen(m, pl, e.type === 'swingFix', e.raw || 0, !!e.final, arrive(got)); }
  }
  stats.motion(m, pl, 0, null, last + 2000);                         // the last swings' windows close
  total += seat().mo.n;
  ok(!seat().motionBad && seat().mo.bad <= 0.1 * seat().mo.n, `${file} (phase ${phase} ms, jitter ${jit} ms, bursts ${burst} ms, ${Math.round(drop * 100)}% ticks dropped): ${seat().mo.n} swings judged, ${seat().mo.bad} unbacked ${JSON.stringify(seat().mo.why)}, not flagged, at most 10% unbacked`);
}
ok(total >= 300, `${total} real swings judged in all`);

console.log('scripted clients: R19 trips');
const Q = [0, 0, 0, 1], spin = a => [0, Math.sin(a / 2), 0, Math.cos(a / 2)];
function bot(paddle, swingsAt, pk = 30) {                            // paddle(t, i) -> [r, q] | null (no message); a swing at each time in swingsAt, settled at once
  const { pl, m, seat } = fresh(), end = Math.max(...swingsAt) + 2000; let k = 0;
  for (let t = 0, i = 0; t <= end; t += 50, i++) {
    while (k < swingsAt.length && swingsAt[k] <= t) { stats.swingSeen(m, pl, false, pk, true, swingsAt[k]); k++; }
    const p = paddle(t, i); if (p) stats.motion(m, pl, p[0], p[1], t);
  }
  stats.motion(m, pl, 0, Q, end + 3000);
  return seat();
}
const every = (n, gap, from = 1000) => Array.from({ length: n }, (_, i) => from + i * gap);
let s = bot(() => [0, Q], every(20, 900)); ok(s.motionBad && s.mo.bad === 20, `a still paddle that swings: flagged (${s.mo.bad}/${s.mo.n})`);
s = bot(() => [25, Q], every(20, 900)); ok(s.motionBad, `a forged turn rate of 25 rad/s with no turn: flagged (${s.mo.bad}/${s.mo.n})`);
s = bot(t => [every(20, 900).some(x => Math.abs(x - t) < 120) ? 25 : 0, Q], every(20, 900)); ok(s.motionBad, `forged rate spikes at each swing, paddle still: flagged (${s.mo.bad}/${s.mo.n})`);
let ang = 0; s = bot(t => { const hot = every(20, 900).some(x => Math.abs(x - t) < 120), r = hot ? 5 : 0; ang += r * 0.05; return [r, spin(ang)]; }, every(20, 900), 40);
ok(s.motionBad, `a real-looking turn of 5 rad/s claiming a 40 rad/s peak: flagged (${s.mo.bad}/${s.mo.n})`);
s = bot(() => null, every(20, 900)); ok(s.motionBad, `swings with no paddle stream at all: flagged (${s.mo.bad}/${s.mo.n})`);
s = bot(() => [0, Q], every(40, 50)); ok(s.motionBad, `a swing every tick: flagged (${s.mo.bad}/${s.mo.n})`);
ang = 0; s = bot(t => { const hot = every(20, 900).some(x => Math.abs(x - t) < 150), r = hot ? 20 : 0; ang += r * 0.05; return [r, spin(ang)]; }, every(20, 900), 30);
ok(!s.motionBad, `a consistent stream (20 rad/s turned for real, peak 30): not flagged (${s.mo.bad}/${s.mo.n})`);
s = bot(() => [0, Q], every(4, 900)); ok(!s.motionBad && s.mo.bad === 4, `four unbacked swings alone: not yet (needs ${5})`);

console.log('off unless asked');
stats.init({ env: {} });
s = bot(() => [0, Q], every(20, 900)); ok(!s.motionBad && s.mo.n === 0, 'without STATS_MOTION nothing is judged');

console.log(fails ? `${fails} FAILURES` : 'MOTION CHECK PASSED');
process.exit(fails ? 1 : 0);
