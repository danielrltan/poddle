// How far is the drawn ball's target from the real ball on a bad connection? Old client logic vs new, same packets.
// The link is modelled the way TCP over lossy wifi behaves: packets arrive in order, a lost one holds up everything behind
// it until the retransmit lands, then the backlog arrives in a burst.
//   node test/badwifi.mjs
import { createRequire } from 'module';
process.env.PORT = process.env.PORT || '8178';
const require = createRequire(import.meta.url);
const S = require('../server/game.js');
const { coast, coastTo, hover, serverClock } = await import('../web/scene.js');

let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const DT = 1 / 60, V = () => ({ x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } });

// ---- the server: one continuous rally, one packet per tick. Whoever the ball reaches hits it back from where it is. ----
const packets = []; let t = 0;
{ let side = 0, p = [1, 0.9, 6.2], sol = S.solve(p, side, 0.5, 0.2, 0.1, 0), v = [...sol.v], b = 0, shot = 0;
  while (packets.length < 60 * 180) {
    packets.push({ t, p: [...p], v: [...v], b, spin: sol.spin, kick: sol.kick, shot, to: 1 - side });
    v[1] -= (b ? S.G : S.gOf(sol.spin)) * DT; for (let i = 0; i < 3; i++) p[i] += v[i] * DT;
    if (p[1] < S.R) { p[1] = S.R; if (b) S.bounceV(v, 0, 0); else S.bounceV(v, sol.spin, sol.kick); b++; }
    t += DT;
    const rs = side === 0 ? -1 : 1;                                                 // the receiver's end
    if (p[2] * rs >= 6.2 || b >= 2) {                                               // it got there: hit it back
      side = 1 - side; shot++; b = 0; p[0] = Math.max(-3, Math.min(3, p[0])); p[1] = Math.max(0.5, Math.min(1.6, p[1]));
      sol = S.solve(p, side, 0.2 + rnd() * 0.8, rnd() * 2 - 1, rnd() < 0.2 ? 0.8 : 0.1, rnd() < 0.3 ? rnd() * 2 - 1 : 0); v = [...sol.v];
    }
  }
}
const _P = { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } }, _V = { set() {} };
const truthAt = ts => { const i = Math.max(0, Math.min(packets.length - 1, Math.floor(ts / DT + 1e-9))), q = packets[i];     // between ticks: the same flight, continued
  coast(_P, _V, q.p, q.v, Math.max(0, ts - q.t), q.spin, q.b, q.kick); return { p: [_P.x, _P.y, _P.z], v: q.v, to: q.to, shot: q.shot }; };

function run(name, loss, stallMin, stallMax, jitter, every = 1) {
  const BASE = 30, FAR = -6.2; seed = 777;                          // the viewer is side 0 (z > 0); the other player stands at z = -6.2
  let prev = 0; const arr = [];                                     // arrival time (local ms) of every packet that is sent
  packets.forEach((pk, i) => { if (i % every && pk.shot === packets[i - 1].shot) return;        // a hit is an event: it is always sent
    let a = pk.t * 1000 + BASE + rnd() * jitter; if (rnd() < loss) a += stallMin + rnd() * (stallMax - stallMin); a = Math.max(a, prev); prev = a; arr.push({ at: a, pk }); });
  const clock = serverClock(), P = V(), Vv = V(), K = ['old', 'neu'], err = { old: [], neu: [] }, inc = { old: [], neu: [] }, back = { old: 0, neu: 0 }, frozen = { old: 0, neu: 0 };
  let i = 0, latest = null, stampOld = 0, stampNew = 0; const last = { old: null, neu: null };
  for (let T = 200; T < packets[packets.length - 1].t * 1000; T += 1000 / 60) {
    while (i < arr.length && arr[i].at <= T) { latest = arr[i].pk; stampOld = arr[i].at; stampNew = clock.madeAt(latest.t, arr[i].at); i++; }
    if (!latest) continue;
    const tr = truthAt((T - BASE) / 1000), q = latest, dir = Math.sign(q.v[2]) || 1, draw = {};
    { const age = Math.min(0.1, Math.max(0, (T - stampOld) / 1000));                                   // OLD: fresh on arrival, 100 ms of straight line plus gravity, then stop
      draw.old = [q.p[0] + q.v[0] * age, Math.max(0.11, q.p[1] + q.v[1] * age - 0.5 * 9.81 * age * age), q.p[2] + q.v[2] * age]; if (T - stampOld > 100) frozen.old++; }
    { const age = Math.min(0.6, Math.max(0, (T - stampNew) / 1000)); coastTo(P, Vv, q.p, q.v, age, q.spin, q.b, q.kick, FAR); draw.neu = [P.x, P.y, P.z]; if (T - stampNew > 600) frozen.neu++; }
    for (const k of K) {
      const d = draw[k], e = Math.hypot(d[0] - tr.p[0], d[1] - tr.p[1], d[2] - tr.p[2]); err[k].push(e);
      if (tr.to === 0 && tr.p[2] > 0) inc[k].push(e);                                                   // coming at me, on my half: what I time my swing on
      if (last[k] && last[k].shot === q.shot && (d[2] - last[k].d[2]) * dir < -0.05) back[k]++;          // the ball visibly went BACKWARDS along its flight
      last[k] = { d, shot: q.shot };
    }
  }
  const st = a => { a = [...a].sort((x, y) => x - y); return { mean: a.reduce((x, y) => x + y, 0) / a.length, p95: a[Math.floor(a.length * .95)], max: a[a.length - 1] }; };
  const cm = x => (x * 100).toFixed(0).padStart(4) + ' cm', out = {};
  console.log(`\n${name}`);
  for (const k of K) { const a = st(err[k]), b = st(inc[k]); out[k] = { all: a, inc: b, back: back[k] };
    console.log(`  ${k === 'old' ? 'old' : 'new'}   all frames: mean ${cm(a.mean)} p95 ${cm(a.p95)} worst ${cm(a.max)}   |  ball coming at me: mean ${cm(b.mean)} p95 ${cm(b.p95)} worst ${cm(b.max)}   |  frozen ${String(frozen[k]).padStart(4)}  backward jumps ${back[k]}`); }
  return out;
}
console.log(`${packets.length} server ticks (${(packets.length / 60).toFixed(0)} s of rally). Error = distance between the drawn ball's target and the true ball.`);
run('good link (no loss, 5 ms jitter)', 0, 0, 0, 5);
run('home wifi, a bit busy (1% loss -> 60-150 ms stalls, 20 ms jitter)', 0.01, 60, 150, 20);
const bad = run('the wifi measured today (4% loss -> 100-350 ms stalls, 60 ms jitter)', 0.04, 100, 350, 60);
const bad30 = run('  ... same link at 30 Hz, which the client now asks for', 0.04, 100, 350, 60, 2);
// ---- the ball hanging for the serve: drifting after a hand that moves now and then, bobbing 4 cm. It must not shake. ----
function held(name, loss, stallMin, stallMax, jitter, every = 1) {
  const BASE = 30, w = 3, bob = 0.04; seed = 4242;
  const at = ts => { const k = 0.6 * Math.sin(ts * 0.9), kv = 0.6 * 0.9 * Math.cos(ts * 0.9);                        // slow sideways drift + the server's bob
    return { p: [k, 1.1 + Math.sin(ts * w) * bob, 6], v: [kv, Math.cos(ts * w) * w * bob, 0] }; };
  let prev = 0; const arr = [];
  for (let i = 0; i < 60 * 60; i++) { if (i % every) continue; const ts = i * DT; let a = ts * 1000 + BASE + rnd() * jitter; if (rnd() < loss) a += stallMin + rnd() * (stallMax - stallMin); a = Math.max(a, prev); prev = a; arr.push({ at: a, t: ts, ...at(ts) }); }
  const clock = serverClock(), P = V(), Vv = V(), shake = { old: [], mid: [], neu: [] }, err = { old: [], mid: [], neu: [] }, last = {};
  let i = 0, q = null, sOld = 0, sNew = 0;
  for (let T = 200; T < 59000; T += 1000 / 60) {
    while (i < arr.length && arr[i].at <= T) { q = arr[i]; sOld = q.at; sNew = clock.madeAt(q.t, q.at); i++; }
    const tr = at((T - BASE) / 1000), trPrev = at((T - BASE) / 1000 - DT), y = {};
    { const a = Math.min(0.1, Math.max(0, (T - sOld) / 1000)); y.old = q.p[1] + q.v[1] * a - 0.5 * 9.81 * a * a; }           // before today: gravity, aged from arrival
    { const a = Math.min(0.1, Math.max(0, (T - sNew) / 1000)); y.mid = q.p[1] + q.v[1] * a - 0.5 * 9.81 * a * a; }           // this morning: gravity, aged by the server's clock
    { const a = Math.min(0.25, Math.max(0, (T - sNew) / 1000)); hover(P, Vv, q.p, q.v, a); y.neu = P.y; }
    for (const k in y) { err[k].push(Math.abs(y[k] - tr.p[1])); if (last[k] != null) shake[k].push(Math.abs((y[k] - last[k]) - (tr.p[1] - trPrev.p[1]))); last[k] = y[k]; }   // movement the real ball did not make
  }
  const st = a => { a = [...a].sort((x, y) => x - y); return { mean: a.reduce((x, y) => x + y, 0) / a.length, p95: a[Math.floor(a.length * .95)], max: a[a.length - 1] }; };
  const mm = x => (x * 1000).toFixed(1).padStart(6) + ' mm', out = {};
  console.log(`\nserve ball, ${name}`);
  for (const [k, label] of [['old', 'before today     '], ['mid', 'this morning     '], ['neu', 'now              ']]) { const a = st(shake[k]), e = st(err[k]); out[k] = a;
    console.log(`  ${label} false up/down movement per frame: mean ${mm(a.mean)} p95 ${mm(a.p95)} worst ${mm(a.max)}   |  height error p95 ${mm(e.p95)}`); }
  return out;
}
held('good link', 0, 0, 0, 5);
const hb = held('the wifi measured today', 0.04, 100, 350, 60), hb30 = held('the wifi measured today, at 30 Hz', 0.04, 100, 350, 60, 2);
const heldOk = hb.neu.p95 < 0.002 && hb30.neu.p95 < 0.002 && hb.neu.p95 < hb.old.p95 / 5;
if (!heldOk) { console.log('\nFAIL: the serve ball still shakes on the bad link'); process.exit(1); }
const okk = bad.neu.inc.p95 < bad.old.inc.p95 / 2 && bad30.neu.inc.p95 < bad.old.inc.p95 / 2 && bad.neu.all.mean < bad.old.all.mean;
console.log('\n' + (okk ? 'BAD WIFI TEST PASSED (incoming ball: new p95 error under half the old one)' : 'FAIL: the new client is not clearly better on the bad link')); process.exit(okk ? 0 : 1);
