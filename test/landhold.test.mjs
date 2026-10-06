// The landing marker of a shot struck on a bet is told ONCE, where the ball really lands (NOTES 222). A human's swing goes out on an early
// bet and its settled report re-aims it ~100 ms later: the landing used to be broadcast at once and then moved, and the receiver ran to the
// first one. Now the receiver gets one launch per shot, after the settled report re-aimed it, or said nothing changed, or never came
// (FIX_WINDOW); a settled swing (B's) still tells it on the hit itself.   TEST_PORT=<port> node test/landhold.test.mjs
import { spawn } from 'child_process';
import WebSocket from 'ws';
const PORT = +process.env.TEST_PORT || 8177, root = new URL('..', import.meta.url).pathname;
const proc = spawn('node', ['server/game.js'], { cwd: root, env: { ...process.env, PORT, AUTOBOT: '0', SWING_SERVE: '0', WIN_AT: '0', BLOCK: '0' } });
const wait = ms => new Promise(r => setTimeout(r, ms)); await wait(700);
let fails = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
const shots = { 0: [], 1: [] };                         // every hit, as the RECEIVER sees it: { hit, at, plan, lands: [{ land, at, n }], bounce }
let i = 0;
const PLANS = [{ bet: 33, fix: 33 }, { bet: 33, fix: 8 }, { bet: 20, fix: 20 }, { bet: 20, fix: null }];   // re-aimed to a smash, to a tap; settled the same (no re-aim); no settled report at all
function player(o) {
  const ws = new WebSocket('ws://localhost:' + PORT), P = { ws, side: null, ...o }; let cool = 0, cur = null;
  ws.on('message', raw => { const m = JSON.parse(raw), at = Date.now();
    if (m.type === 'welcome') P.side = m.side;
    if (P.side == null) return;
    const other = 1 - P.side;
    if (m.type === 'hit' && m.side === other) { cur = { hit: m, at, plan: P.peer.plan, lands: [], bounce: null }; shots[other].push(cur); }
    if (m.type === 'hit' && m.side === P.side && P.bets) { const pl = P.plan; if (pl.fix != null) setTimeout(() => ws.send(JSON.stringify({ type: 'swing', power: pl.fix, dir: 0.3, lob: 0, fix: true, final: true })), 80); }
    if (m.type === 'launch' && m.by === other && cur && m.land) cur.lands.push({ land: m.land, at, n: m.n });
    if (m.type === 'bounce' && cur && !cur.bounce) cur.bounce = m.p;
    if (m.type !== 'state') return;
    const me = m.paddles[P.side], s = P.side === 0 ? 1 : -1, mine = m.live && m.v[2] * s > 0;
    ws.send(JSON.stringify({ type: 'paddle', x: mine ? m.p[0] : 0, y: mine ? Math.max(0.4, Math.min(1.4, m.p[1])) : 1, z: 6.5 * s, q: [0, 0, 0, 1] }));
    if (mine && me && Date.now() > cool && Math.abs(m.p[2] - me.z) < 1.0) { cool = Date.now() + 500;
      if (P.bets) { P.plan = PLANS[i++ % PLANS.length]; ws.send(JSON.stringify({ type: 'swing', power: P.plan.bet, dir: 0.3, lob: 0, age: 80, final: false })); }
      else ws.send(JSON.stringify({ type: 'swing', power: 16, dir: 0.3, lob: 0, age: 80, final: true })); } });
  return P;
}
const A = player({ bets: true }), B = player({});
A.peer = B; B.peer = A;
await wait(40000);
const seen = arr => arr.filter(s => s.bounce);            // shots that came down (a volley never does)
const a = seen(shots[A.side]), b = seen(shots[B.side]);
const by = k => a.filter(s => s.plan && s.plan === PLANS[k]);
ok(PLANS.every((_, k) => by(k).length >= 2) && b.length >= 4, `enough rallies: A's bets ${PLANS.map((_, k) => by(k).length).join('/')} (smash/tap/same/silent), B's settled ${b.length}`);
ok(a.every(s => s.lands.length === 1), `every bet shot: ONE landing told to the receiver (counts ${[...new Set(a.map(s => s.lands.length))]})`);
const off = s => s.lands[0] && Math.hypot(s.lands[0].land[0] - s.bounce[0], s.lands[0].land[1] - s.bounce[2]);
ok(a.every(s => off(s) < 0.05) && b.every(s => off(s) < 0.05), `and it is where the ball comes down: worst ${Math.max(...a.concat(b).map(off)).toFixed(3)} m off the bounce`);
const late = s => s.lands[0] ? s.lands[0].at - s.at : NaN;
ok(by(0).concat(by(1)).every(s => late(s) >= 50 && s.lands[0].n != null), `re-aimed bets: told with the re-aim, ${Math.min(...by(0).concat(by(1)).map(late))}+ ms after the hit, never before`);
ok(by(2).every(s => late(s) >= 50 && late(s) < 200), `settled the same: told when the settled report says so (${by(2).map(late).join(', ')} ms)`);
ok(by(3).every(s => late(s) >= 200 && late(s) < 400), `no settled report: told when the re-aim window closes (${by(3).map(late).join(', ')} ms)`);
ok(b.every(s => late(s) < 30), `a settled swing: told with the hit itself (${Math.max(...b.map(late))} ms at most)`);
A.ws.close(); B.ws.close(); proc.kill(); console.log(fails ? fails + ' FAILURES' : 'LANDHOLD TESTS PASSED'); process.exit(fails ? 1 : 0);
