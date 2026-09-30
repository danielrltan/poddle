// A re-aim bends the ball once, smoothly (NOTES 154). Every human swing is struck on its bet and the settled report re-aims it ~100 ms later.
// That re-aim used to ease the velocity in equal shares over 0.1-0.45 s: the pull switched on in one tick, grew ~2.7x and cut off, and the
// drawn ball froze for a frame on every re-aim (and at every contact and arc end) then surged to catch up. Now the server brings the new
// velocity in on a smoothstep over that same window (bent(), RAMP), the client's coast() flies that same bend, and a correction on screen is
// measured from where the ball would be this frame.
// Part 1 (in process): the server's own step and bent() against the closed form and coast(), two bends at once, the along-court guard.
// Part 2 (live): real bets and settled reports at a real server (a legacy client re-aiming twice too), the server's per-tick pull, coast()
// from the re-aim packet, and the real drawBall() replayed from the recorded stream (a bundled hit and 30 fps included).
//   TEST_PORT=<port> node test/bend.test.mjs            (ROOT=<another checkout> runs the live part against that server)
import { spawn } from 'child_process';
import { createRequire } from 'module';
import WebSocket from 'ws';
const PORT = +process.env.TEST_PORT || 8581, root = process.env.ROOT || new URL('..', import.meta.url).pathname;
process.env.PORT = String(PORT + 2);                               // the in-process copy listens too: keep it off the live one
const require = createRequire(import.meta.url);
const S = require('../server/game.js');
const { coast, drawBall, serverClock, ballTake, ballState } = await import('../web/scene.js');
const wait = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
const DT = 1 / 60, V = () => ({ x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } }), cP = V(), cV = V();
const f2 = x => x.toFixed(2), f3 = x => x.toFixed(3), mx = a => Math.max(0, ...a), clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const wire = ws => ws.flatMap(w => [w.v[0], w.v[1], w.W, w.t0]);   // server/game.js bendW()
const slopeOf = w => { let s = 0; for (let k = 0; w && k < w.length; k += 4) s += 6 * Math.hypot(w[k], w[k + 1]) / w[k + 2] ** 2 * DT; return s; };   // the most the bends' pull may change in one tick

// ---------- part 1: sim()'s flight step with a bend, against the closed form and coast() ----------
{
  let worstPath = 0, worstCoast = 0, worstFirst = 0, worstStep = 0, count = 0;
  for (const side of [0, 1]) for (const n of [0.2, 0.5, 0.76]) for (const lob of [0, 0.7]) for (const d of [[0.8, -1.5], [-2, 1.2], [0.3, 2.4]]) for (const at of [0.08, 0.2, 0.45]) for (const whole of [false, true]) {
    const s = side ? -1 : 1, sol = S.solve([s * 0.8, 1, s * 6.2], side, n, 0.3, lob, 0, null, 0), p = [s * 0.8, 1, s * 6.2], v = [...sol.v], g = S.gOf(sol.spin);
    const step = (ws, t) => S.flight(p, v, DT, 0, g, ws, t - DT);     // sim()'s own step, before the bounce
    let t = 0; while (t < at - 1e-9) { t += DT; step(null, t); }
    // reaim()'s window: the old ease's (whole ticks), or the whole hang left (the swoop's sideways part)
    const T = S.fallLeft(p[1], v[1], g), W = whole ? T : Math.min(T, Math.max(1, Math.round(clamp(S.BEND.share * T, S.BEND.min, S.BEND.max) / DT)) * DT), K = T - W / 2;
    const D = [d[0] * -s, d[1] * -s], ws = [{ v: [D[0] / K, D[1] / K], W, t0: t }], p0 = [...p], v0 = [...v], peak = 1.5 * Math.hypot(...ws[0].v) / W, slope = slopeOf(wire(ws));
    const packets = [{ t, p: [...p], v: [...v] }]; let a0 = [0, 0], first = null; count++;
    while (true) { const pv = [...v], h = Math.min(DT, S.fallLeft(p[1], v[1], g)); S.flight(p, v, h, 0, g, ws, t); t += h;
      const tau = t - ws[0].t0, a = [(v[0] - pv[0]) / h, (v[2] - pv[2]) / h];     // the closed form: ballistic, plus v W RAMP(tau / W); at T that is v0 T + D: the marker
      worstPath = Math.max(worstPath, Math.hypot(p[0] - (p0[0] + v0[0] * tau + D[0] / K * W * S.RAMP(tau / W)), p[1] - (p0[1] + v0[1] * tau - 0.5 * g * tau * tau), p[2] - (p0[2] + v0[2] * tau + D[1] / K * W * S.RAMP(tau / W))));
      if (h < DT) break;
      packets.push({ t, p: [...p], v: [...v] });
      if (first == null) first = Math.hypot(...a) / peak;
      worstStep = Math.max(worstStep, Math.hypot(a[0] - a0[0], a[1] - a0[1]) / slope); a0 = a; }
    worstPath = Math.max(worstPath, Math.hypot(p[0] - (p0[0] + v0[0] * T + D[0]), p[2] - (p0[2] + v0[2] * T + D[1])));
    worstFirst = Math.max(worstFirst, first);
    for (const a of packets) for (const b of packets) if (b.t > a.t) {
      coast(cP, cV, a.p, a.v, b.t - a.t, sol.spin, 0, sol.kick, 0, wire(ws), a.t);
      worstCoast = Math.max(worstCoast, Math.hypot(cP.x - b.p[0], cP.y - b.p[1], cP.z - b.p[2]));
    }
  }
  ok(worstPath < 1e-6, `${count} bends flown by sim()'s own step stay on the closed form (x, y and z) and land exactly on the marker: worst ${(worstPath * 1000).toFixed(4)} mm`);
  ok(worstFirst < 0.3 && worstStep < 1.05, `...their pull starts from nothing (first tick at most ${f3(worstFirst)} of the peak; the old ease: all of it at once) and changes by at most the curve's own slope a tick (${f3(worstStep)} of it)`);
  ok(worstCoast < 0.001, `coast() flies the same bend from any packet to any later one before the bounce: worst ${f2(worstCoast * 1000)} mm`);
}
{ // a second re-aim (a legacy client's) adds its bend to the first, whose pull runs on: no step in the pull, and it lands on the second marker
  const sol = S.solve([0.5, 1, 6.2], 0, 0.5, 0.3, 0, 0, null, 0), p = [0.5, 1, 6.2], v = [...sol.v], g = S.gOf(sol.spin), ws = [];
  let t = 0, a0 = [0, 0], worst = 0, land = null;
  for (let k = 0; ; k++) {
    if (k === 5 || k === 12) { const T = S.fallLeft(p[1], v[1], g), W = Math.min(T, Math.round(clamp(0.5 * T, 0.1, 0.45) / DT) * DT), q = [...p], qv = [...v];
      S.flight(q, qv, T, 0, g, ws, t); land = k === 5 ? [q[0] + 1.2, q[2] + 1.5] : [q[0] - 2, q[2] - 1];       // the first moves it one way, the second back past where it was
      ws.push({ v: [(land[0] - q[0]) / (T - W / 2), (land[1] - q[2]) / (T - W / 2)], W, t0: t }); }
    const pv = [...v], h = Math.min(DT, S.fallLeft(p[1], v[1], g)); S.flight(p, v, h, 0, g, ws, t); t += h; if (h < DT) break;
    const a = [(v[0] - pv[0]) / h, (v[2] - pv[2]) / h]; if (ws.length) worst = Math.max(worst, Math.hypot(a[0] - a0[0], a[1] - a0[1]) / slopeOf(wire(ws))); a0 = a; }
  const off = Math.hypot(p[0] - land[0], p[2] - land[1]);
  ok(worst < 1.05 && off < 1e-6, `two re-aims of one ball: the pull never steps (at most ${f3(worst)} of the bends' own slope a tick; the second used to drop the first's pull), and it lands on the second marker (${(off * 1000).toFixed(4)} mm)`);
}
{ // the along-court guard (reaim(): FIX_ALONG). Never reached in play (no sampled re-aim, old ease or new, went under 0.11 of its pace)
  const T = 0.6, W = 0.3, K = T - W / 2, vz = -12, qz = 5 + vz * T, short = 5 + 0.2 * vz * T, lz = S.alongFloor(short, qz, vz, vz, K);
  const ws = [{ v: [0, (lz - qz) / K], W, t0: 0 }], p = [0, 1.5, 5], v = [0, 0, vz]; let slow = Infinity, back = false;
  for (let t = 0; t < T - 1e-9; t += DT) { const z0 = p[2]; S.flight(p, v, Math.min(DT, T - t), 0, 0, ws, t); slow = Math.min(slow, v[2] / vz); if ((p[2] - z0) * vz < 0) back = true; }
  ok(Math.abs(slow - S.FIX_ALONG) < 1e-9 && !back && S.alongFloor(qz + 2, qz, vz, vz, K) === qz + 2, `a settled landing that would stop the ball along the court moves deeper (${f2(Math.abs(short - 5))} -> ${f2(Math.abs(lz - 5))} m): it reaches the bounce at exactly ${f2(slow)} of its pace, never turning back; one it can reach is left alone`);
}

// ---------- part 2: live ----------
const proc = spawn('node', ['server/game.js'], { cwd: root, env: { ...process.env, PORT: String(PORT), AUTOBOT: '0', SWING_SERVE: '0', WIN_AT: '0', BLOCK: '0' }, stdio: ['ignore', 'ignore', 'inherit'] });
await wait(800);
// bet: the first report (final false). settled: the report `after` ms later. Real spacing is 60-250 ms (p50 100). legacy: a client from before
// `final` (its swing strikes as it stands, and every fix after it re-aims): two fixes, the second while the first one's bend still pulls.
const PLAN = [
  { name: 'drive, settled wide', bet: { power: 22, dir: 0.2 }, settled: { power: 18, dir: -0.5 }, after: 100 },
  { name: 'hard bet, settled tap', bet: { power: 30, dir: 0 }, settled: { power: 8, dir: 0.1 }, after: 120 },
  { name: 'settled at full power (swoop)', bet: { power: 34, dir: 0.6 }, settled: { power: 34, dir: 0.6 }, after: 100 },
  { name: 'soft bet, settled deep', bet: { power: 14, dir: -0.3 }, settled: { power: 26, dir: 0.5 }, after: 150 },
  { name: 'lob re-aimed', bet: { power: 20, lob: 0.78, dir: 0 }, settled: { power: 26, lob: 0.76, dir: -0.3 }, after: 120 },
  { name: 'legacy client, re-aimed twice', legacy: true, bet: { power: 30, dir: 0.5 }, fixes: [{ power: 20, dir: -0.5, after: 70 }, { power: 27, dir: 0.4, after: 150 }] },
  { name: 'flooding client', legacy: true, bet: { power: 30, dir: 0.5 }, fixes: Array.from({ length: 10 }, (_, i) => ({ power: i % 2 ? 30 : 12, dir: i % 2 ? 0.8 : -0.8, after: 20 + 20 * i })) },   // every fix differs from the last, so each asks to re-aim: BEND.most caps what one ball carries
];
const log = [], shots = []; let k = 0, cur = null;
function player(me) {
  const ws = new WebSocket('ws://localhost:' + PORT), P = { ws, side: null }; let cool = 0;
  const send = o => ws.readyState === 1 && ws.send(JSON.stringify(o));
  ws.on('message', raw => { const m = JSON.parse(raw);
    if (m.type === 'welcome') P.side = m.side;
    if (me) log.push(m);
    if (me && m.type === 'hit' && m.side === P.side && P.plan) { const plan = P.plan; P.plan = null; cur = { plan, i0: log.length - 1 }; shots.push(cur);
      if (plan.legacy) for (const f of plan.fixes) setTimeout(() => send({ type: 'swing', lob: 0, power: f.power, dir: f.dir, fix: true }), f.after);   // no final at all
      else setTimeout(() => send({ type: 'swing', lob: 0, ...plan.settled, fix: true, final: true }), plan.after); }
    if (me && m.type === 'bounce' && cur && cur.i1 == null) { cur.i1 = log.length - 1; cur = null; }
    if (me && (m.type === 'point' || m.type === 'serve')) cur = null;
    if (m.type !== 'state' || P.side == null) return;
    const pd = m.paddles[P.side], s = P.side === 0 ? 1 : -1, mine = m.live && m.v[2] * s > 0;
    send({ type: 'paddle', x: mine ? m.p[0] : 0, y: mine ? Math.max(0.4, Math.min(1.4, m.p[1])) : 1, z: 6.5, q: [0, 0, 0, 1] });
    if (mine && pd && Date.now() > cool && Math.abs(m.p[2] - pd.z) < 1.0) { cool = Date.now() + 500;
      if (!me) return send({ type: 'swing', power: 16, dir: -0.2, lob: 0, final: true });
      const plan = P.plan = PLAN[k++ % PLAN.length];
      send({ type: 'swing', lob: 0, age: 60, ...plan.bet, ...(plan.legacy ? {} : { final: false }) }); } });
  return P;
}
const A = player(true), B = player(false);
await wait(+process.env.BEND_S * 1000 || 40000);
A.ws.close(); B.ws.close(); proc.kill();

const done = shots.filter(s => s.i1 != null).map(s => { const msgs = log.slice(s.i0, s.i1 + 1), hit = msgs[0];
  const res = msgs.filter(m => m.type === 'launch' && m.n != null), re = res[0], reL = res[res.length - 1], bounce = msgs[msgs.length - 1];   // reL: the last re-aim (a legacy client's second)
  const st = msgs.filter(m => m.type === 'state' && m.live && m.b === 0 && m.serving == null);
  return { ...s, msgs, hit, re, reL, twice: res.length > 1, bounce, st }; });
const re = done.filter(s => s.re), two = re.filter(s => s.twice);
console.log(`live: ${shots.length} hits, ${done.length} flown to a bounce, ${re.length} re-aimed (${PLAN.map(p => p.name + ' ' + re.filter(s => s.plan === p).length).join(', ')}), ${re.filter(s => s.re.w).length} of them carrying their bend, ${two.length} re-aimed twice`);
ok(PLAN.every(p => re.filter(s => s.plan === p).length >= 2) && two.length >= 2, 'every kind of re-aim came round at least twice, and a legacy client re-aimed one ball twice at least twice');

// (a) the server's own ball: its horizontal pull, per tick, from the re-aim to the bounce. The old ease switched on a full pull in one tick
// (p50 3.5, p90 11 m/s^2 on the real captures), grew ~2x and cut it to nothing 0.1-0.45 s later. A legacy ball's second re-aim adds its
// bend to the first one, whose pull runs on (it used to be dropped in one tick).
const pulls = re.map(s => { const pts = [s.re, ...s.st.filter(m => m.t > s.re.t)], a = [];
  for (let i = 1; i < pts.length; i++) { const d = pts[i].t - pts[i - 1].t; if (d <= 0) continue; const c = +pts[i - 1].c || 0;
    a.push([(pts[i].v[0] - pts[i - 1].v[0]) / d - c, (pts[i].v[2] - pts[i - 1].v[2]) / d]); }
  const peak = mx(a.map(q => Math.hypot(...q))), step = mx(a.map((q, i) => Math.hypot(q[0] - (i ? a[i - 1][0] : 0), q[1] - (i ? a[i - 1][1] : 0))));
  const slope = mx(pts.map(m => slopeOf(m.w)));                  // the bends' own change of pull in one tick at their steepest
  return { name: s.plan.name, peak, first: a.length ? Math.hypot(...a[0]) : 0, step, slope, n: a.length }; }).filter(r => r.n > 5);
// the first tick: at most 0.3 of the peak (a smoothstep over the shortest window, 6 ticks, sampled; longer windows fade in slower)
ok(pulls.length >= 6 && pulls.every(r => r.first <= 0.3 * r.peak + 0.05), `the bend fades in: the first tick after the re-aim pulls ${pulls.map(r => f2(r.first)).join(', ')} m/s^2 (peaks ${pulls.map(r => f2(r.peak)).join(', ')})`);
ok(pulls.every(r => r.step <= 1.2 * r.slope + 0.05), `...and the pull never steps, a second re-aim included: its biggest change in one tick ${f2(mx(pulls.map(r => r.step)))} m/s^2 (at most the bends' own slope, ${f2(mx(pulls.map(r => r.slope)))})`);

// (b) the ball lands on its marker, never turns back along the court, and the client's coast() predicts it from the re-aim packet alone
const offOf = s => Math.hypot(s.bounce.p[0] - s.reL.land[0], s.bounce.p[2] - s.reL.land[1]);
const most = mx(done.flatMap(s => s.st.map(m => (m.w ? m.w.length / 4 : 0))));
ok(most <= S.BEND.most && re.some(s => s.plan.name === 'flooding client' && s.twice), `a client flooding settled reports piles up no more than BEND.most bends on one ball: at most ${most} at once (cap ${S.BEND.most})`);
ok(re.every(s => offOf(s) < 0.02), `it lands on the moved marker: ${re.map(s => f2(offOf(s))).join(', ')} m off (the sim meets the floor where it is, not up to a tick late)`);
const along = s => Math.min(...s.st.filter(m => m.t >= s.re.t).map(m => m.v[2] / s.re.v[2]));      // its along speed against the one it had at the re-aim
ok(re.every(s => along(s) >= S.FIX_ALONG - 1e-6), `...and never stops or turns back along the court: slowest along speed ${f2(Math.min(...re.map(along)))} of what it had at the re-aim (at least ${S.FIX_ALONG})`);
const pred = re.map(s => { let e = 0; const r = s.reL;
  for (const m of s.st) if (m.t > r.t) { coast(cP, cV, r.p, r.v, m.t - r.t, r.spin, 0, r.k || 0, +r.c || 0, r.w, r.t); e = Math.max(e, Math.hypot(cP.x - m.p[0], cP.y - m.p[1], cP.z - m.p[2])); }
  return e; });
ok(pred.every(e => e < 0.02), `coast() from the (last) re-aim packet alone follows the server's ball to the bounce: worst ${f2(mx(pred) * 100)} cm (p50 ${f2([...pred].sort((x, y) => x - y)[pred.length >> 1] * 100)})`);

// (c) the drawn ball: scene.js's own ballTake / ballState / drawBall replayed from the stream (no jitter: each frame shows a known server time).
// Its horizontal step each frame against the server ball's own step over that frame, on the re-aim frame, the contact frame and the frame the
// height arc ends, and the two after each. The contact frame's truth turns at the hit (in at the old velocity, out at the new one); where the
// hit was struck from where the ball WAS (lag compensation) that jump back is not travel: the drawn ball slides it out after, on top.
// hold: the hit's tick held back one tick, so it comes in the same frame as the next tick's state (a TCP burst; at 30 fps every other hit).
class V3 { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } copy(o) { this.x = o.x; this.y = o.y; this.z = o.z; return this; }
  sub(o) { this.x -= o.x; this.y -= o.y; this.z -= o.z; return this; } length() { return Math.hypot(this.x, this.y, this.z); }
  addScaledVector(o, s) { this.x += o.x * s; this.y += o.y * s; this.z += o.z * s; return this; }
  lerp(o, a) { this.x += (o.x - this.x) * a; this.y += (o.y - this.y) * a; this.z += (o.z - this.z) * a; return this; }
  distanceToSquared(o) { return (this.x - o.x) ** 2 + (this.y - o.y) ** 2 + (this.z - o.z) ** 2; } }
function replay(s, { base, fps, hold = 0 }) {
  const msgs = log.slice(Math.max(0, s.i0 - 40), s.i1 + 30), madeAt = serverClock().madeAt, vA = new V3(), h = s.hit;
  const b = { p: [0, 1, 0], v: [0, 0, 0], live: false, stamp: 0, seen: false, snap: true, pos: new V3(0, 1, 0), vel: new V3(), core: new V3(0, 1, 0), err: new V3(), errT: 1, errDur: 0.1, blend: false, bounces: 0, kick: 0, curl: 0, held: false, spin: 0, arc: null, w: null, tS: NaN };
  let lastT = null, prevA = 0; const q = []; for (const m of msgs) { const t = m.t != null ? m.t : lastT; if (t == null) continue; lastT = t; prevA = Math.max(prevA, 10000 + t * 1000 + base + (m === h ? hold : 0)); q.push({ a: prevA, m }); }   // in order: one TCP stream
  const on = (m, now) => (m.type === 'state' ? ballState(b, m.p, m.v, m.live, madeAt(+m.t, now), m.spin, m, +m.t) : ballTake(b, m, t => madeAt(t, now)));
  const old = msgs.filter(m => m.type === 'state' && m.live && m.t <= h.t), nu = [{ ...h, b: 0, live: true }, ...msgs.filter(m => m.type === 'state' && m.live && m.t > h.t)];
  const at = (src, ts) => { let a = null; for (const m of src) { if (m.t <= ts + 1e-9) a = m; else break; } if (!a) return null;      // the server's ball at server time ts, from its packets
    coast(cP, cV, a.p, a.v, ts - a.t, a.spin || 0, a.b, a.k || 0, +a.c || 0, a.w, a.t); return [cP.x, cP.z, Math.hypot(cV.x, cV.z)]; };
  const truth = ts => (ts >= h.t ? at(nu, ts) : at(old, ts));
  const out = []; let qi = 0, last = q[0].a;
  for (let now = q[0].a; now < q[q.length - 1].a + 50; now += 1000 / fps) {
    const ev = [];
    while (qi < q.length && q[qi].a <= now) { const e = q[qi++]; on(e.m, e.a); if (e.m === h) ev.push('hit'); if (e.m === s.re) ev.push('re'); }
    const dt = clamp((now - last) / 1000, 0, 0.05) || 1 / fps; last = now;
    if (!b.live) continue;
    const had = !!(b.arc && b.arc.t0 != null), px = b.pos.x, pz = b.pos.z;
    drawBall(b, vA, now, dt, -6.5);
    if (had && !b.arc) ev.push('arc');
    const ts = (now - 10000 - base) / 1000, A = truth(ts - dt), B = truth(ts); if (!A || !B) { out.push({ ev, r: null }); continue; }
    let step = Math.hypot(B[0] - A[0], B[1] - A[1]), along = B[1] - A[1];
    if (ts - dt < h.t && ts >= h.t) { const X = at(old, h.t); step = Math.hypot(X[0] - A[0] + B[0] - h.p[0], X[1] - A[1] + B[1] - h.p[2]); along = X[1] - A[1] + B[1] - h.p[2]; }   // turned at the hit; the jump back to the contact point is not travel
    // over: how much further than the truth it moved toward the hitter this frame (a contact frame that flew on the old way before turning)
    out.push({ ev, r: step > 0.3 * B[2] * dt && B[2] > 1 ? Math.hypot(b.pos.x - px, b.pos.z - pz) / step : null, over: (b.pos.z - pz - along) * -Math.sign(h.v[2]) });   // a ball turning round mid-frame barely moves: no ratio
  }
  return out;
}
const R = { hit: [], re: [], arc: [] }, over = [];
for (const s of re) for (const c of [{ base: 40, fps: 60 }, { base: 80, fps: 60 }, { base: 40, fps: 120 }, { base: 41, fps: 30 }, { base: 40, fps: 60, hold: 17 }, { base: 41, fps: 30, hold: 17 }]) {
  const f = replay(s, c), i = f.findIndex(o => o.ev.includes('hit')); if (i >= 1 && f[i].over != null) over.push(f[i].over);
  for (const ev of ['hit', 're', 'arc']) { const i = f.findIndex(o => o.ev.includes(ev)); if (i < 1) continue;
    const rs = f.slice(i, i + 3).map(o => o.r).filter(r => r != null); if (rs.length) R[ev].push({ min: Math.min(...rs), max: Math.max(...rs) });
    if (process.env.DEBUG) console.log(ev, c.base, c.fps, f.slice(i - 2, i + 6).map(o => o.r && +o.r.toFixed(2)).join(' ')); }
}
const span = a => `${f2(Math.min(...a.map(r => r.min)))}-${f2(Math.max(...a.map(r => r.max)))}x`;
ok(R.re.length >= 10 && R.re.every(r => r.min >= 0.6 && r.max <= 1.6), `the re-aim frame and the two after are drawn at ${span(R.re)} the server ball's own step (${R.re.length} replays; it froze at 0.09x and surged 1.3-1.4x)`);
ok(R.hit.length >= 10 && R.hit.every(r => r.min >= 0.6), `the contact frame and the two after: ${span(R.hit)} (${R.hit.length} replays; never under 0.6x: a late contact's slide onto its path, or a hit that came in late, may add speed after)`);
ok(over.length >= 10 && mx(over) < 0.02, `...and the contact frame turns at the hit's own time, even when the next tick came in with it: at most ${f3(mx(over))} m further toward the hitter than the server ball (it flew on the old way up to 0.35 m)`);
ok(R.arc.length >= 10 && R.arc.every(r => r.min >= 0.6 && r.max <= 1.6), `the frame the height arc ends and the two after: ${span(R.arc)} (${R.arc.length} replays)`);
console.log(fails ? fails + ' FAILURES' : 'BEND TESTS PASSED'); process.exit(fails ? 1 : 0);
