// A swing is reported EARLY, on a bet that overshoots, and its settled power follows 60-280 ms later (final:true). A bet never smashes:
// the hit on a bet is a drive at most, and the smash (label, ring, flame: web/scene.js) goes out with the re-aim when the settled report confirms it.
// 38 of 140 recorded swings were first called at smash pace, 14 settled there, 12 settled as taps.   TEST_PORT=<port> node test/bet.test.mjs
// A second court (TEST_PORT + 1, STRIKE_WAIT=1, NOTES 265): A swings while the ball is still well out and its settled report comes 30 ms later,
// before the ball reaches the paddle. It folds into the waiting swing, so the strike itself is the settled shot: a smash at contact.
import { spawn } from 'child_process';
import WebSocket from 'ws';
const PORT = +process.env.TEST_PORT || 8173, root = new URL('..', import.meta.url).pathname;
const proc = spawn('node', ['server/game.js'], { cwd: root, env: { ...process.env, PORT, AUTOBOT: '0', SWING_SERVE: '0', WIN_AT: '0', BLOCK: '0' } });
const proc2 = spawn('node', ['server/game.js'], { cwd: root, env: { ...process.env, PORT: PORT + 1, AUTOBOT: '0', SWING_SERVE: '0', WIN_AT: '0', BLOCK: '0', STRIKE_WAIT: '1' } });
const wait = ms => new Promise(r => setTimeout(r, ms)); await wait(700);
let fails = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
const shots = [], early = [];                           // every ball A hits on a bet: the hit, and the re-aim that followed (early: the second court's)
function player(o) {
  const ws = new WebSocket('ws://localhost:' + (o.port || PORT)), P = { ws, side: null, ...o }; let cool = 0, cur = null;
  ws.on('message', raw => { const m = JSON.parse(raw);
    if (m.type === 'welcome') P.side = m.side;
    if (m.type === 'hit' && m.side === P.side && P.early) { cur = { hit: m, settled: P.last, re: null }; early.push(cur); }
    if (m.type === 'hit' && m.side === P.side && P.bets && !P.early) { cur = { hit: m, settled: P.last, re: null }; shots.push(cur); const s = P.last; setTimeout(() => ws.send(JSON.stringify({ type: 'swing', power: s, dir: 0.3, lob: 0, fix: true, final: true })), 80); }
    if (m.type === 'launch' && m.by === P.side && P.bets && cur && m.n != null) cur.re = m;
    if (m.type !== 'state' || P.side == null) return;
    const me = m.paddles[P.side], s = P.side === 0 ? 1 : -1, mine = m.live && m.v[2] * s > 0;
    ws.send(JSON.stringify({ type: 'paddle', x: mine ? m.p[0] : 0, y: mine ? Math.max(0.4, Math.min(1.4, m.p[1])) : 1, z: 6.5, q: [0, 0, 0, 1] }));
    if (P.early && mine && me && Date.now() > cool && Math.abs(m.p[2] - me.z) < 1.45 && Math.abs(m.p[2] - me.z) > 1.15) { cool = Date.now() + 500; const s = P.last = P.settle();
      ws.send(JSON.stringify({ type: 'swing', power: 33, dir: 0.3, lob: 0, age: 80, final: false })); setTimeout(() => ws.send(JSON.stringify({ type: 'swing', power: s, dir: 0.3, lob: 0, fix: true, final: true })), 30); return; }
    if (mine && me && Date.now() > cool && Math.abs(m.p[2] - me.z) < 1.0) { cool = Date.now() + 500; P.last = P.settle(); ws.send(JSON.stringify({ type: 'swing', power: P.bets ? 33 : 16, dir: 0.3, lob: 0, age: 80, final: !P.bets })); } });
  return P;
}
let i = 0;
const A = player({ bets: true, settle: () => [33, 8, 20][i++ % 3] }), B = player({ settle: () => 16 });      // A is always first called at 33 rad/s; it settles as a smash, a tap, a drive
let j = 0; await wait(200);
const A2 = player({ port: PORT + 1, bets: true, early: true, settle: () => [33, 8, 20][j++ % 3] }), B2 = player({ port: PORT + 1, settle: () => 16 });
await wait(45000);
const done = shots.filter(s => s.re), S = done.filter(s => s.settled === 33), T = done.filter(s => s.settled === 8), D = done.filter(s => s.settled === 20);
ok(S.length >= 3 && T.length >= 3 && D.length >= 3, `enough rallies: ${S.length} settle as smashes, ${T.length} as taps, ${D.length} as drives (${shots.length - done.length} hits were past re-aiming)`);
ok(shots.every(s => s.hit.kind !== 'smash' && s.hit.n <= 0.76 + 1e-9), `no hit on a bet is called a smash, or flies like one: kinds ${[...new Set(shots.map(s => s.hit.kind))]}, max n ${Math.max(...shots.map(s => s.hit.n)).toFixed(2)}`);
ok(S.every(s => s.re.kind === 'smash' && s.re.n > 0.9), `settled at 33: the re-aim announces the smash and carries its power (${[...new Set(S.map(s => s.re.kind + ' ' + s.re.n.toFixed(2)))]})`);
ok(T.every(s => s.re.kind === 'tap' && s.re.n < 0.1) && D.every(s => s.re.kind == null && Math.abs(s.re.n - 0.5) < 1e-9), `settled at 8: re-aimed as a tap, n ${T[0] && T[0].re.n.toFixed(2)} (the flame goes out); settled at 20: still a drive, n ${D[0] && D[0].re.n.toFixed(2)}, no new kind`);
const eS = early.filter(s => s.settled === 33), eT = early.filter(s => s.settled === 8), eD = early.filter(s => s.settled === 20);
ok(eS.length >= 2 && eT.length >= 2 && eD.length >= 2, `STRIKE_WAIT=1, settled before contact: ${eS.length} smashes, ${eT.length} taps, ${eD.length} drives struck`);
ok(eS.every(s => !s.hit.bet && s.hit.kind === 'smash' && s.hit.n > 0.9) && eT.every(s => !s.hit.bet && s.hit.kind === 'tap' && s.hit.n < 0.1) && eD.every(s => !s.hit.bet && Math.abs(s.hit.n - 0.5) < 1e-9),
  `...the settled report folds into the swing waiting for its ball: the strike itself is a smash (n ${eS.map(s => s.hit.n.toFixed(2))}), a tap, a drive, never a bet`);
ok(early.every(s => !s.re), `...and nothing is re-aimed after it (${early.filter(s => s.re).length} re-aims)`);
A.ws.close(); B.ws.close(); A2.ws.close(); B2.ws.close(); proc.kill(); proc2.kill(); console.log(fails ? fails + ' FAILURES' : 'BET TESTS PASSED'); process.exit(fails ? 1 : 0);
