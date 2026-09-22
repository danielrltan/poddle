// Slice shots: the same swing with and without `slice`, measured from the state packets; and can a receiver who only
// places the paddle and times the swing (footwork by the server) still return them?   node test/slice.test.mjs
// Spin is CONTINUOUS (docs/NEXT.md 3b): the ball carries exactly the amount the client sent, so a third of the swings
// here send 0.4 and must land BETWEEN flat and sliced (the old curve had a dead zone below 0.3 and made 0.4 into 0.16).
import { spawn } from 'child_process';
import WebSocket from 'ws';
const PORT = +process.env.TEST_PORT || 8172, root = new URL('..', import.meta.url).pathname;
const proc = spawn('node', ['server/game.js'], { cwd: root, env: { ...process.env, PORT, AUTOBOT: '0', SWING_SERVE: '0', WIN_AT: '0', BLOCK: '0' } });
await new Promise(r => setTimeout(r, 700));
const wait = ms => new Promise(r => setTimeout(r, ms)), NET = 0.91;
let fails = 0, nan = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
const shots = [];                                       // every ball A hits: what it did, from the packets
function player(o) {
  const ws = new WebSocket('ws://localhost:' + PORT), P = { ws, side: null, hits: 0, ...o }; let cool = 0, cur = null, prev = null;
  ws.on('message', raw => { const m = JSON.parse(raw);
    if (m.type === 'welcome') P.side = m.side;
    if (m.type === 'hit' && m.side === P.side) { P.hits++; if (P.track) { cur = { kind: m.kind, sliced: P.last, spinHit: m.spin, t0: null, net: null, apex: 0, returned: false }; shots.push(cur); } }
    if (m.type === 'hit' && m.side !== P.side && P.track && cur) { cur.returned = true; cur = null; }
    if (m.type === 'point' && P.track) cur = null;
    if (m.type === 'launch' && P.track && cur && m.by === P.side) cur.land = m.land;
    if (m.type === 'bounce' && P.track && cur && !cur.bounce) cur.bounce = m.p;
    if (m.type !== 'state' || P.side == null) return;
    if (![...m.p, ...m.v, m.spin, m.t].every(Number.isFinite)) nan++;
    const me = m.paddles[P.side], s = P.side === 0 ? 1 : -1, mine = m.live && m.v[2] * s > 0;
    if (P.track && cur && m.live) {                      // A's shot in flight
      if (cur.t0 == null) { cur.t0 = m.t; cur.spin = m.spin; }
      if (prev && prev.p[2] * s > 0 && m.p[2] * s <= 0) cur.net = m.p[1];              // height as it crosses the net
      if (cur.bounce && !cur.T) { cur.T = m.t - cur.t0; cur.vAfter = Math.abs(m.v[2]); cur.vBefore = Math.abs(prev.v[2]); }
      if (cur.T && m.v[2] * s < 0) cur.apex = Math.max(cur.apex, m.p[1]);
    }
    prev = m;
    ws.send(JSON.stringify({ type: 'paddle', x: mine ? m.p[0] : 0, y: mine ? Math.max(0.4, Math.min(1.4, m.p[1])) : 1, z: 6.5, q: [0, 0, 0, 1] }));   // places the paddle, never leans: depth is the server's footwork
    if (mine && me && Date.now() > cool && Math.abs(m.p[2] - me.z) < 1.0) { cool = Date.now() + 500; P.last = P.slice(); ws.send(JSON.stringify({ type: 'swing', power: P.power, dir: 0.3, lob: 0, slice: P.last, age: 80 })); } });
  return P;
}
let i = 0;
const A = player({ track: true, power: 22, slice: () => [0.9, 0, 0.4][i++ % 3] });     // same swing: sliced, flat, half sliced
const B = player({ power: 16, slice: () => 0 });                                        // (B sends slice: 0; A's flat ones send 0 too)
await wait(66000);
const done = shots.filter(s => s.T && s.land && s.net != null), S = done.filter(s => s.sliced > 0.5), F = done.filter(s => !s.sliced), M = done.filter(s => s.sliced === 0.4);
const avg = (xs, k) => xs.reduce((p, c) => p + k(c), 0) / (xs.length || 1), f = v => v.toFixed(2);
const row = (name, xs) => console.log(`${name} n=${xs.length}  kind ${[...new Set(xs.map(s => s.kind))]}  spin ${f(avg(xs, s => s.spin))}  depth ${f(avg(xs, s => Math.abs(s.bounce[2])))} m  flight ${f(avg(xs, s => s.T))} s  over the net at ${f(avg(xs, s => s.net))} m (min ${f(Math.min(...xs.map(s => s.net)))})` +
  `  bounce apex ${f(avg(xs, s => s.apex))} m  forward speed ${f(avg(xs, s => s.vBefore))} -> ${f(avg(xs, s => s.vAfter))} m/s  returned ${xs.filter(s => s.returned).length}/${xs.length}`);
row('flat  ', F); row('half  ', M); row('sliced', S);
ok(S.length >= 5 && F.length >= 5 && M.length >= 5, `enough rallies measured (${S.length} sliced, ${M.length} half, ${F.length} flat)`);
ok(S.every(s => s.kind === 'slice' && Math.abs(s.spinHit - 0.9) < 1e-9) && F.every(s => s.kind !== 'slice' && !s.spinHit), "hit event: spin is the amount sent (0.9, not rounded up to 1), kind === 'slice' only for the sliced swings");
ok(M.every(s => s.kind !== 'slice' && Math.abs(s.spinHit - 0.4) < 1e-9), `continuous: slice 0.4 flies with spin 0.4 and is not called a slice (that label starts above SLICE.at 0.45): ${[...new Set(M.map(s => s.kind + ' ' + s.spinHit))]}`);
ok(avg(M, s => s.net) < avg(F, s => s.net) && avg(M, s => s.net) > avg(S, s => s.net) && avg(M, s => s.apex) < avg(F, s => s.apex) && avg(M, s => s.apex) > avg(S, s => s.apex) && avg(M, s => s.vAfter) < avg(F, s => s.vAfter) && avg(M, s => s.vAfter) > avg(S, s => s.vAfter),
  'and the ball shows it: height over the net, bounce height and check-up all sit between flat and sliced');
ok(Math.abs(avg(S, s => Math.abs(s.bounce[2])) - avg(F, s => Math.abs(s.bounce[2]))) < 0.5, 'same landing depth within 0.5 m (power still sets depth)');
ok(done.every(s => s.net > NET + 0.05), 'every one clears the net');
ok(done.every(s => Math.abs(s.bounce[0]) <= 3.05 && Math.abs(s.bounce[2]) <= 6.7 && Math.abs(s.bounce[2]) > 0.1), 'every one lands in');
ok(avg(S, s => s.net) < avg(F, s => s.net) - 0.08 && avg(S, s => s.T) < avg(F, s => s.T) * 1.1, 'sliced flight skids LOWER over the net and is no floatier (it used to float: T x1.3, and read as a lob)');
ok(avg(S, s => s.apex) < avg(F, s => s.apex) * 0.7, 'first bounce stays clearly lower');
ok(avg(S, s => s.vAfter) < avg(F, s => s.vAfter) * 0.65, 'and checks up: clearly slower after the bounce');
ok(S.filter(s => s.returned).length >= S.length * 0.7, `receiver with server footwork returns most slices (${S.filter(s => s.returned).length}/${S.length})`);
ok(nan === 0, 'nothing NaN in any state packet');
A.ws.close(); B.ws.close(); proc.kill(); console.log(fails ? fails + ' FAILURES' : 'SLICE TESTS PASSED'); process.exit(fails ? 1 : 0);
