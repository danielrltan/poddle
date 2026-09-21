// A swing is reported EARLY, on a bet that overshoots, and its settled power follows 60-280 ms later (final:true). A bet never smashes:
// the hit on a bet is a drive at most, and the smash (label, ring, flame: web/scene.js) goes out with the re-aim when the settled report confirms it.
// 38 of 140 recorded swings were first called at smash pace, 14 settled there, 12 settled as taps.   TEST_PORT=<port> node test/bet.test.mjs
import { spawn } from 'child_process';
import WebSocket from 'ws';
const PORT = +process.env.TEST_PORT || 8173, root = new URL('..', import.meta.url).pathname;
const proc = spawn('node', ['server/game.js'], { cwd: root, env: { ...process.env, PORT, AUTOBOT: '0', SWING_SERVE: '0', WIN_AT: '0', BLOCK: '0' } });
const wait = ms => new Promise(r => setTimeout(r, ms)); await wait(700);
let fails = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
const shots = [];                                        // every ball A hits on a bet: the hit, and the re-aim that followed
function player(o) {
  const ws = new WebSocket('ws://localhost:' + PORT), P = { ws, side: null, ...o }; let cool = 0, cur = null;
  ws.on('message', raw => { const m = JSON.parse(raw);
    if (m.type === 'welcome') P.side = m.side;
    if (m.type === 'hit' && m.side === P.side && P.bets) { cur = { hit: m, settled: P.last, re: null }; shots.push(cur); const s = P.last; setTimeout(() => ws.send(JSON.stringify({ type: 'swing', power: s, dir: 0.3, lob: 0, fix: true, final: true })), 80); }
    if (m.type === 'launch' && m.by === P.side && P.bets && cur && m.n != null) cur.re = m;
    if (m.type !== 'state' || P.side == null) return;
    const me = m.paddles[P.side], s = P.side === 0 ? 1 : -1, mine = m.live && m.v[2] * s > 0;
    ws.send(JSON.stringify({ type: 'paddle', x: mine ? m.p[0] : 0, y: mine ? Math.max(0.4, Math.min(1.4, m.p[1])) : 1, z: 6.5, q: [0, 0, 0, 1] }));
    if (mine && me && Date.now() > cool && Math.abs(m.p[2] - me.z) < 1.0) { cool = Date.now() + 500; P.last = P.settle(); ws.send(JSON.stringify({ type: 'swing', power: P.bets ? 33 : 16, dir: 0.3, lob: 0, age: 80, final: !P.bets })); } });
  return P;
}
let i = 0;
const A = player({ bets: true, settle: () => [33, 8, 20][i++ % 3] }), B = player({ settle: () => 16 });      // A is always first called at 33 rad/s; it settles as a smash, a tap, a drive
await wait(45000);
const done = shots.filter(s => s.re), S = done.filter(s => s.settled === 33), T = done.filter(s => s.settled === 8), D = done.filter(s => s.settled === 20);
ok(S.length >= 3 && T.length >= 3 && D.length >= 3, `enough rallies: ${S.length} settle as smashes, ${T.length} as taps, ${D.length} as drives (${shots.length - done.length} hits were past re-aiming)`);
ok(shots.every(s => s.hit.kind !== 'smash' && s.hit.n <= 0.76 + 1e-9), `no hit on a bet is called a smash, or flies like one: kinds ${[...new Set(shots.map(s => s.hit.kind))]}, max n ${Math.max(...shots.map(s => s.hit.n)).toFixed(2)}`);
ok(S.every(s => s.re.kind === 'smash' && s.re.n > 0.9), `settled at 33: the re-aim announces the smash and carries its power (${[...new Set(S.map(s => s.re.kind + ' ' + s.re.n.toFixed(2)))]})`);
ok(T.every(s => s.re.kind === 'tap' && s.re.n < 0.1) && D.every(s => s.re.kind == null && Math.abs(s.re.n - 0.5) < 1e-9), `settled at 8: re-aimed as a tap, n ${T[0] && T[0].re.n.toFixed(2)} (the flame goes out); settled at 20: still a drive, n ${D[0] && D[0].re.n.toFixed(2)}, no new kind`);
A.ws.close(); B.ws.close(); proc.kill(); console.log(fails ? fails + ' FAILURES' : 'BET TESTS PASSED'); process.exit(fails ? 1 : 0);
