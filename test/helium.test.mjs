// No helium (NOTES 86). A scoop meets the ball on its bet, when the upward share is still low (a drive), and the settled report
// says lob 60-280 ms later. The re-aim used to ease vy up onto the lob over 0.45 s: the ball climbed faster and faster, +6 to +14
// m/s^2 against gravity. Now height is never eased: one step up at the re-aim if the shot needs it, then vy only falls, and an
// ordinary correction never climbs (a drive or a smash never steps; a tap gets only what the net asks).   TEST_PORT=<port> node test/helium.test.mjs
import { spawn } from 'child_process';
import WebSocket from 'ws';
const PORT = +process.env.TEST_PORT || 8187, root = new URL('..', import.meta.url).pathname;
const proc = spawn('node', ['server/game.js'], { cwd: root, env: { ...process.env, PORT, AUTOBOT: '0', SWING_SERVE: '0', WIN_AT: '0', BLOCK: '0' } });
const wait = ms => new Promise(r => setTimeout(r, ms)); await wait(700);
let fails = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
// bet: what the first report says. settled: what follows `after` ms later. clean: struck on a settled report, no re-aim at all
const PLAN = [
  { name: 'lob', bet: { power: 22, lob: 0.3 }, settled: { power: 22, lob: 0.75 }, after: 60 },
  { name: 'lob', bet: { power: 22, lob: 0.3 }, settled: { power: 22, lob: 0.75 }, after: 150 },
  { name: 'lob', bet: { power: 26, lob: 0.2 }, settled: { power: 26, lob: 0.78 }, after: 220 },
  { name: 'drive', bet: { power: 22, lob: 0.1 }, settled: { power: 20, lob: 0.25 }, after: 120 },
  { name: 'tap', bet: { power: 30, lob: 0 }, settled: { power: 8, lob: 0 }, after: 150 },
  { name: 'smash', bet: { power: 33, lob: 0 }, settled: { power: 33, lob: 0 }, after: 100 },
  { name: 'clean lob', clean: { power: 22, lob: 0.75 } },
];
const shots = []; let cur = null, k = 0;
function player(bets) {
  const ws = new WebSocket('ws://localhost:' + PORT), P = { ws, side: null }; let cool = 0;
  ws.on('message', raw => { const m = JSON.parse(raw);
    if (m.type === 'welcome') P.side = m.side;
    if (bets && m.type === 'hit' && m.side === P.side) { const plan = P.plan; cur = { plan, hit: m, vy: [[m.t, m.v[1], m.p[1]]], re: null, land: null, bounce: null }; shots.push(cur);
      if (plan.settled) setTimeout(() => ws.send(JSON.stringify({ type: 'swing', power: plan.settled.power, lob: plan.settled.lob, dir: 0.2, fix: true, final: true })), plan.after); }
    if (bets && m.type === 'launch' && m.by === P.side && cur) { cur.land = m.land; if (m.n != null) cur.re = m; }
    if (bets && m.type === 'bounce' && cur && !cur.bounce) { cur.bounce = m.p; cur = null; }
    if (m.type !== 'state' || P.side == null) return;
    if (bets && cur && m.b === 0 && m.live) cur.vy.push([m.t, m.v[1], m.p[1]]);
    const me = m.paddles[P.side], s = P.side === 0 ? 1 : -1, mine = m.live && m.v[2] * s > 0;
    ws.send(JSON.stringify({ type: 'paddle', x: mine ? m.p[0] : 0, y: mine ? Math.max(0.4, Math.min(1.4, m.p[1])) : 1, z: 6.5, q: [0, 0, 0, 1] }));
    if (mine && me && Date.now() > cool && Math.abs(m.p[2] - me.z) < 1.0) { cool = Date.now() + 500;
      if (!bets) return ws.send(JSON.stringify({ type: 'swing', power: 16, dir: -0.2, lob: 0, final: true }));
      const plan = P.plan = PLAN[k++ % PLAN.length], b = plan.clean || plan.bet;
      ws.send(JSON.stringify({ type: 'swing', power: b.power, lob: b.lob, dir: 0.2, age: 60, final: !!plan.clean })); } });
  return P;
}
const A = player(true), B = player(false);
await wait(+process.env.HELIUM_S * 1000 || 70000);
const done = shots.filter(s => s.bounce && (s.plan.clean || s.re));
const stat = s => { let ups = 0, step = 0, worst = 0, apex = 0;         // ups: ticks where vy went UP; step: the biggest; worst: vy up on any tick after the first rise
  for (let i = 1; i < s.vy.length; i++) { const d = s.vy[i][1] - s.vy[i - 1][1]; if (d > 1e-6) { if (ups) worst = Math.max(worst, d); ups++; step = Math.max(step, d); } }
  for (const r of s.vy) apex = Math.max(apex, r[2]);
  return { ups, step, worst, apex, miss: s.land ? Math.hypot(s.bounce[0] - s.land[0], s.bounce[2] - s.land[1]) : NaN }; };
const by = name => done.filter(s => s.plan.name === name).map(s => ({ ...stat(s), after: s.plan.after, kind: (s.re && s.re.kind) || s.hit.kind }));
const L = by('lob'), C = by('clean lob'), D = [...by('drive'), ...by('tap'), ...by('smash')];
for (const [n, r] of [['lob (bet, settled)', L], ['clean lob', C], ['drive/tap/smash re-aims', D]]) console.log(`  ${n}: ` + r.map(x => `[${x.after ?? '-'}ms ${x.kind} ups ${x.ups} step ${x.step.toFixed(2)} apex ${x.apex.toFixed(2)} miss ${x.miss.toFixed(2)}]`).join(' '));
ok(L.length >= 3 && C.length >= 1 && D.length >= 3, `enough shots: ${L.length} re-aimed lobs, ${C.length} clean lobs, ${D.length} other re-aims`);
ok(L.every(x => x.ups <= 1 && x.worst === 0), `a lob struck on its bet goes up ONCE, at the re-aim, and vy only falls after (ups ${L.map(x => x.ups)})`);
ok(L.every(x => x.kind === 'lob' && x.apex > 3.3), `...and it is still a lob, high: apex ${L.map(x => x.apex.toFixed(2))} (clean ${C.map(x => x.apex.toFixed(2))})`);
ok(D.every(x => x.ups <= 1 && x.worst === 0 && x.step < 0.75), `an ordinary correction never climbs: at most one small step (only what the net asks of a ball that slows, a tap), biggest ${Math.max(0, ...D.map(x => x.step)).toFixed(3)} m/s`);
ok(by('drive').every(x => x.ups === 0) && by('smash').every(x => x.ups === 0), 'a drive re-aimed to a drive, or into a smash, never steps up at all');
ok(C.every(x => x.ups === 0), 'a lob struck on a settled report is a plain parabola: vy never rises');
ok([...L, ...D].every(x => x.miss < 0.15), `every re-aimed ball lands on its marker: worst ${Math.max(...[...L, ...D].map(x => x.miss)).toFixed(3)} m`);
A.ws.close(); B.ws.close(); proc.kill(); console.log(fails ? fails + ' FAILURES' : 'HELIUM TESTS PASSED'); process.exit(fails ? 1 : 0);
