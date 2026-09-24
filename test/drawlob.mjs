// What the screen draws after a hit (NOTES 90). Records the real server's stream around lobs and re-aims, replays it with latency and
// jitter into web/scene.js's own drawBall() at 60 and 120 fps, and reads the drawn height back: from the frame after contact to the first
// bounce (while it is over 0.3 m) the drawn vy may never rise from one frame to the next. It did: the hit's smoothstep put it 2-4 m/s over
// the path for a few frames, and re-stamped packets on a bad link bobbed it up by up to 0.9 m/s a frame.
//   TEST_PORT=<port> node test/drawlob.mjs
import { spawn } from 'child_process';
import WebSocket from 'ws';
const { drawBall, serverClock } = await import('../web/scene.js');
const PORT = +process.env.TEST_PORT || 8189, root = new URL('..', import.meta.url).pathname;
const proc = spawn('node', ['server/game.js'], { cwd: root, env: { ...process.env, PORT, AUTOBOT: '0', SWING_SERVE: '0', WIN_AT: '0', BLOCK: '0' } });
const wait = ms => new Promise(r => setTimeout(r, ms)); await wait(700);
let fails = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
const PLAN = [
  { name: 'clean lob', clean: { power: 22, lob: 0.75 } },
  { name: 'lob bet, settled lob', bet: { power: 20, lob: 0.78 }, settled: { power: 26, lob: 0.76, dir: -0.3 }, after: 120 },
  { name: 'low-lob bet, settled lob', bet: { power: 22, lob: 0.3 }, settled: { power: 22, lob: 0.75 }, after: 150 },
  { name: 'drive re-aimed', bet: { power: 22, lob: 0.1 }, settled: { power: 18, lob: 0.2, dir: -0.4 }, after: 100 },
];
// ---- record: every message the hitter's tab receives, with when it came
const log = [], shots = []; let cur = null, k = 0;
function player(me) {
  const ws = new WebSocket('ws://localhost:' + PORT), P = { ws, side: null }; let cool = 0;
  const send = o => ws.readyState === 1 && ws.send(JSON.stringify(o));
  ws.on('message', raw => { const m = JSON.parse(raw);
    if (m.type === 'welcome') P.side = m.side;
    if (me) log.push(m);
    if (me && m.type === 'hit' && m.side === P.side) { const plan = P.plan; cur = { plan, i0: log.length - 1 }; shots.push(cur);
      if (plan.settled) setTimeout(() => send({ type: 'swing', power: plan.settled.power, lob: plan.settled.lob, dir: plan.settled.dir ?? 0.2, fix: true, final: true }), plan.after); }
    if (me && m.type === 'bounce' && cur && cur.i1 == null) { cur.i1 = log.length - 1; cur = null; }
    if (m.type !== 'state' || P.side == null) return;
    const pd = m.paddles[P.side], s = P.side === 0 ? 1 : -1, mine = m.live && m.v[2] * s > 0;
    send({ type: 'paddle', x: mine ? m.p[0] : 0, y: mine ? Math.max(0.4, Math.min(1.4, m.p[1])) : 1, z: 6.5, q: [0, 0, 0, 1] });
    if (mine && pd && Date.now() > cool && Math.abs(m.p[2] - pd.z) < 1.0) { cool = Date.now() + 500;
      if (!me) return send({ type: 'swing', power: 16, dir: -0.2, lob: 0, final: true });
      const plan = P.plan = PLAN[k++ % PLAN.length], b = plan.clean || plan.bet;
      send({ type: 'swing', power: b.power, lob: b.lob, dir: 0.2, age: 60, final: !!plan.clean }); } });
  return P;
}
const A = player(true), B = player(false);
await wait(+process.env.DRAW_S * 1000 || 30000);
A.ws.close(); B.ws.close(); proc.kill();
const streams = shots.filter(s => s.i1 != null).map(s => ({ name: s.plan.name, msgs: log.slice(Math.max(0, s.i0 - 40), s.i1 + 30) }));

// ---- replay: scene.js's onEvent / updateBall for the ball (what they store), then its drawBall() every frame
class V3 { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } copy(o) { this.x = o.x; this.y = o.y; this.z = o.z; return this; }
  sub(o) { this.x -= o.x; this.y -= o.y; this.z -= o.z; return this; } length() { return Math.hypot(this.x, this.y, this.z); }
  addScaledVector(o, s) { this.x += o.x * s; this.y += o.y * s; this.z += o.z * s; return this; }
  lerp(o, a) { this.x += (o.x - this.x) * a; this.y += (o.y - this.y) * a; this.z += (o.z - this.z) * a; return this; }
  distanceToSquared(o) { return (this.x - o.x) ** 2 + (this.y - o.y) ** 2 + (this.z - o.z) ** 2; } }
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
function replay(msgs, hit, { base, jit, fps, seed }) {
  let rs = seed; const rnd = () => ((rs = (rs * 16807) % 2147483647) / 2147483647);
  const madeAt = serverClock().madeAt, vA = new V3();
  const b = { p: [0, 1, 0], v: [0, 0, 0], live: false, stamp: 0, seen: false, snap: true, pos: new V3(0, 1, 0), vel: new V3(), core: new V3(0, 1, 0), err: new V3(), errT: 1, errDur: 0.1, blend: false, bounces: 0, kick: 0, curl: 0, held: false, spin: 0, arc: null };
  let prevA = 0, lastT = null; const q = [];                  // arrival (local ms): made + base + jitter, in order (one TCP stream)
  for (const m of msgs) { const t = m.t != null ? m.t : lastT; if (t == null) continue; lastT = t; prevA = Math.max(prevA, 10000 + t * 1000 + base + rnd() * jit); q.push({ a: prevA, m }); }
  const on = (m, now) => {
    if (m.type === 'launch') { if (isFinite(m.spin)) b.spin = clamp(+m.spin, 0, 1); if (isFinite(m.k)) b.kick = +m.k; if (isFinite(m.c)) b.curl = +m.c;
      if (m.v && m.p && b.seen) { b.p = [...m.p]; b.v = [...m.v]; b.stamp = madeAt(+m.t, now); b.blend = true; } }
    else if (m.type === 'hit') { const p = m.p || b.p; b.blend = b.seen; b.snap = !b.seen; b.arc = m.v ? { t0: null } : null; b.spin = clamp(+m.spin || 0, 0, 1);
      if (m.v) { b.p = [...p]; b.v = [...m.v]; b.stamp = madeAt(+m.t, now); b.bounces = 0; b.kick = +m.k || 0; b.curl = +m.c || 0; b.held = false; } }
    else if (m.type === 'serve') { b.snap = true; b.arc = null; }
    else if (m.type === 'state') { if (isFinite(m.spin)) b.spin = clamp(+m.spin, 0, 1); if (m.live && !b.live) b.snap = true; if (!m.live) b.arc = null;
      b.bounces = m.b | 0; b.kick = +m.k || 0; b.curl = +m.c || 0; b.held = m.serving != null;
      b.p = m.p; b.v = m.v; b.live = !!m.live; b.stamp = madeAt(+m.t, now); if (m.live) b.seen = true; } };
  const out = []; let qi = 0, last = q[0].a, hitAt = null;
  for (let now = q[0].a; now < q[q.length - 1].a + 50; now += 1000 / fps) {
    while (qi < q.length && q[qi].a <= now) { const e = q[qi++]; on(e.m, e.a); if (e.m === hit) hitAt = now; }
    const dt = clamp((now - last) / 1000, 0, 0.05) || 1 / fps; last = now;
    if (!b.live) continue;
    drawBall(b, vA, now, dt, -6.5);
    out.push({ now, y: b.pos.y, bounces: b.bounces, path: vA.y, contact: hitAt === now, st: (now - 10000 - base) / 1000 });
  }
  return out;
}
function truth(msgs, t) {                                    // y of the server's ball at server time t, between two state packets (null after the bounce)
  let a = null; for (const m of msgs) { if (m.type !== 'state' || !m.live) continue; if (m.t <= t) a = m; else { if (!a || a.b || m.b) return null; const w = (t - a.t) / (m.t - a.t); return a.p[1] + (m.p[1] - a.p[1]) * w; } }
  return null;
}
const CFG = [{ base: 40, jit: 0, fps: 60 }, { base: 40, jit: 30, fps: 60 }, { base: 80, jit: 60, fps: 60 }, { base: 80, jit: 60, fps: 120 }];
const res = {};
for (const st of streams) {
  const hit = st.msgs.find(m => m.type === 'hit' && m.side === 0), key = st.name; res[key] ||= { n: 0, rise: 0, apex: 0, off: 0, offPath: 0 };
  for (const c of CFG) for (let seed = 1; seed <= 10; seed++) {
    const f = replay(st.msgs, hit, { ...c, seed }), i0 = f.findIndex(o => o.contact); if (i0 < 0) continue;
    let prevVy = null; res[key].n++;
    for (let i = i0 + 1; i < f.length && !f[i].bounces && f[i].y > 0.3 && f[i - 1].y > 0.3; i++) {
      const vy = (f[i].y - f[i - 1].y) / ((f[i].now - f[i - 1].now) / 1000);
      if (prevVy != null) res[key].rise = Math.max(res[key].rise, vy - prevVy);
      prevVy = vy; res[key].apex = Math.max(res[key].apex, f[i].y);
      const tru = truth(st.msgs, f[i].st);                                     // the server's own ball at the moment this frame means to show
      if (tru != null && f[i].now - f[i0].now > 250) { res[key].off = Math.max(res[key].off, Math.abs(f[i].y - tru)); res[key].offPath = Math.max(res[key].offPath, Math.abs(f[i].path - tru)); }   // path: the packets' own coast, which the drawn height used to track
    }
  }
}
for (const [name, r] of Object.entries(res)) console.log(`  ${name.padEnd(26)} ${r.n} replays, drawn apex ${r.apex.toFixed(2)} m, biggest frame-to-frame rise in drawn vy ${r.rise.toFixed(3)} m/s, off the server's height by ${r.off.toFixed(2)} m at most (the packets' own coast: ${r.offPath.toFixed(2)})`);
ok(PLAN.every(p => res[p.name] && res[p.name].n >= 20), `every shot recorded and replayed (${Object.entries(res).map(([n, r]) => n + ' ' + r.n).join(', ')})`);
ok(Object.values(res).every(r => r.rise <= 0.05), 'after the contact frame the drawn ball never rises faster than it did the frame before (40+0, 40+30, 80+60 ms, 60 and 120 fps)');
ok(Object.values(res).every(r => r.off <= r.offPath + 0.05), "and it is drawn where the server has it, as closely as the packets' own coast from 0.25 s after contact (the clock guess on a jittery link is the rest)");
ok(res['clean lob'] && res['clean lob'].apex > 3.3 && res['lob bet, settled lob'] && res['lob bet, settled lob'].apex > 3.3, 'lobs are still drawn high');
console.log(fails ? fails + ' FAILURES' : 'DRAWLOB TESTS PASSED'); process.exit(fails ? 1 : 0);
