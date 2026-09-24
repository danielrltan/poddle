// No helium, sealed (NOTES 86, 90). A swing is struck on its first report (the bet) and the settled report re-aims it 60-250 ms later.
// Whatever the settled report says, the ball's height and gravity are the paddle's: after the contact packet vy only ever falls, at the
// gravity it was struck with, until the first bounce. A re-aim moves only where it comes down, and the marker says where that really is.
// Every re-aim path: the rally fix (low-lob bet -> lob, lob bet -> drive, lob bet -> lob, hard bet -> tap, smash), fixBlock (struck
// from up at the net), a serve struck on its first report, and the legacy client that sends no `final` at all.
//   TEST_PORT=<port> node test/helium.test.mjs            (ROOT=<another checkout> runs the same plan against that server)
import { spawn } from 'child_process';
import WebSocket from 'ws';
const PORT = +process.env.TEST_PORT || 8187, root = process.env.ROOT || new URL('..', import.meta.url).pathname;
const proc = spawn('node', ['server/game.js'], { cwd: root, env: { ...process.env, PORT, AUTOBOT: '0', SWING_SERVE: '1', WIN_AT: '0', BLOCK: '0' } });
const wait = ms => new Promise(r => setTimeout(r, ms)); await wait(700);
let fails = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
const G = 9.81, R = 0.11, NET = 0.91, LIFT = 0.3;
// bet: the first report. settled: the one `after` ms later (none: struck settled, no re-aim). near: stand up at the net (fixBlock).
// legacy: a client from before `final` (every report taken at its word; the fix still re-aims)
const PLAN = [
  { name: 'low-lob bet, settled lob', bet: { power: 22, lob: 0.3 }, settled: { power: 22, lob: 0.75 }, after: 60 },
  { name: 'low-lob bet, settled lob', bet: { power: 26, lob: 0.2 }, settled: { power: 26, lob: 0.78 }, after: 220 },
  { name: 'lob bet, settled drive', bet: { power: 22, lob: 0.78 }, settled: { power: 21, lob: 0.1 }, after: 150 },
  { name: 'lob bet, settled lob', bet: { power: 20, lob: 0.78 }, settled: { power: 26, lob: 0.76, dir: -0.3 }, after: 120 },
  { name: 'hard bet, settled tap', bet: { power: 30, lob: 0 }, settled: { power: 8, lob: 0 }, after: 150 },
  { name: 'smash', bet: { power: 33, lob: 0 }, settled: { power: 33, lob: 0 }, after: 100 },
  { name: 'near net (fixBlock)', near: true, bet: { power: 10, lob: 0 }, settled: { power: 24, lob: 0.1 }, after: 80 },
  { name: 'near net (fixBlock)', near: true, bet: { power: 20, lob: 0 }, settled: { power: 9, lob: 0 }, after: 80 },
  { name: 'legacy (no final)', legacy: true, bet: { power: 22, lob: 0.3 }, settled: { power: 22, lob: 0.75 }, after: 100 },
  { name: 'clean lob', clean: { power: 22, lob: 0.75 } },
];
const SERVE = { name: 'serve, re-aimed', bet: { power: 20, lob: 0.1 }, settled: { power: 14, lob: 0.5, dir: -0.4 }, after: 120 };
const shots = []; let cur = null, k = 0, nextPlan = PLAN[0], served = 0;
function player(me) {
  const ws = new WebSocket('ws://localhost:' + PORT), P = { ws, side: null, returns: 0 }; let cool = 0, lastServe = 0;
  const send = o => ws.readyState === 1 && ws.send(JSON.stringify(o));
  ws.on('message', raw => { const m = JSON.parse(raw);
    if (m.type === 'welcome') P.side = m.side;
    if (me && m.type === 'hit' && m.side === P.side) { const plan = P.plan || SERVE; P.plan = null;
      cur = { plan, hit: m, g: G * (1 - LIFT * (m.spin || 0)), vy: [[m.t, m.v[1], m.p[1], m.p[2]]], spin: [], re: null, land: null, bounce: null, z: P.z }; shots.push(cur);
      nextPlan = PLAN[++k % PLAN.length];
      if (plan.settled) setTimeout(() => send({ type: 'swing', power: plan.settled.power, lob: plan.settled.lob, dir: plan.settled.dir ?? 0.2, fix: true, final: plan.legacy ? undefined : true }), plan.after); }
    if (me && m.type === 'launch' && m.by === P.side && cur) { cur.land = m.land; if (m.n != null) cur.re = m; }
    if (me && m.type === 'bounce' && cur && !cur.bounce) { cur.bounce = m.p; cur = null; }
    if (me && m.type === 'point') cur = null;
    if (m.type !== 'state' || P.side == null) return;
    if (me && cur && m.b === 0 && m.live && m.serving == null) { cur.vy.push([m.t, m.v[1], m.p[1], m.p[2]]); cur.spin.push(m.spin); }
    const pd = m.paddles[P.side], s = P.side === 0 ? 1 : -1, mine = m.live && m.serving == null && m.v[2] * s > 0;
    P.z = pd && pd.z;
    const near = me && nextPlan.near;
    send({ type: 'paddle', x: mine || m.serving === P.side ? m.p[0] : 0, y: mine || m.serving === P.side ? Math.max(0.4, Math.min(1.4, m.p[1])) : 1, z: near ? 2.6 : 6.5, q: [0, 0, 0, 1] });
    if (m.serving === P.side && m.reach && Date.now() > lastServe) { lastServe = Date.now() + 1500;
      if (!me) return send({ type: 'swing', power: 16, dir: -0.2, lob: 0, final: true });
      P.plan = SERVE; served++;                                   // came back through the ball: struck on its first report, the settled one re-aims it
      return send({ type: 'swing', power: SERVE.bet.power, lob: SERVE.bet.lob, dir: 0.2, off: 25, back: 0.4, final: false }); }
    if (mine && pd && Date.now() > cool && Math.abs(m.p[2] - pd.z) < 1.0) { cool = Date.now() + 500;
      if (!me) { if (++P.returns % 7 === 0) return; return send({ type: 'swing', power: nextPlan.near ? 8 : 16, dir: -0.2, lob: nextPlan.near ? 0.8 : 0, final: true }); }   // every 7th: let it go, so points end and the serve comes round. A dink when the next shot is played up at the net
      const plan = P.plan = nextPlan, b = plan.clean || plan.bet;
      send({ type: 'swing', power: b.power, lob: b.lob, dir: 0.2, age: 60, final: plan.clean ? true : plan.legacy ? undefined : false }); } });
  return P;
}
const A = player(true), B = player(false);
await wait(+process.env.HELIUM_S * 1000 || 80000);
const done = shots.filter(s => s.bounce);
const stat = s => { let rise = 0, light = 0, apex = 0, net = Infinity, spin = 0;
  for (let i = 1; i < s.vy.length; i++) { const [t0, v0, y0, z0] = s.vy[i - 1], [t1, v1, y1, z1] = s.vy[i];
    rise = Math.max(rise, v1 - v0); if (t1 > t0) light = Math.max(light, s.g - (v0 - v1) / (t1 - t0));   // light: how much gravity fell short of what it was struck with
    if (z0 * z1 <= 0 && z0 !== z1) net = Math.min(net, y0 + (y1 - y0) * z0 / (z0 - z1)); }
  for (const r of s.vy) apex = Math.max(apex, r[2]);
  for (const sp of s.spin) spin = Math.max(spin, Math.abs(sp - (s.hit.spin || 0)));
  return { bz: s.bounce[2], z: s.z, name: s.plan.name, kind: (s.re && s.re.kind) || s.hit.kind, re: !!s.re, rise, light, spin, apex, net, near: s.z != null && Math.abs(s.z) < 3.6,
    miss: s.land ? Math.hypot(s.bounce[0] - s.land[0], s.bounce[2] - s.land[1]) : NaN }; };
const all = done.map(stat), by = name => all.filter(x => x.name === name);
const f2 = x => x.toFixed(2);
for (const name of [...new Set(all.map(x => x.name))]) console.log(`  ${name}: ` + by(name).map(x => `[${x.kind}${x.re ? '' : ' (no re-aim)'} rise ${f2(x.rise)} light ${f2(x.light)} apex ${f2(x.apex)} net ${f2(x.net)} miss ${f2(x.miss)} z ${x.z == null ? '-' : f2(x.z)}]`).join(' '));
const reaimed = all.filter(x => x.re);
ok(PLAN.concat(SERVE).every(p => by(p.name).length > 0) && reaimed.length >= 10, `every kind of shot came round (${all.length} shots, ${reaimed.length} re-aimed, ${served} serves)`);
ok(all.every(x => x.rise <= 0.05), `after the contact packet vy never rises: worst ${f2(Math.max(...all.map(x => x.rise)))} m/s`);
ok(all.every(x => x.light <= 0.05 && x.spin < 1e-9), `...and gravity never lightens (spin is the paddle's): worst ${f2(Math.max(...all.map(x => x.light)))} m/s^2 short, spin moved ${Math.max(...all.map(x => x.spin))}`);
ok(all.every(x => x.miss < 0.15), `the marker is where it really lands: worst ${f2(Math.max(...all.map(x => x.miss)))} m`);
ok(all.every(x => x.net >= NET + R), `every ball clears the net (centre over the tape by a radius): lowest ${f2(Math.min(...all.map(x => x.net)))} m`);
ok(by('hard bet, settled tap').length && by('hard bet, settled tap').every(x => Math.abs(x.bz) > 3.5), `a hard bet that settles as a tap is not given height for the net: its landing moves deeper instead (tap depth ~2.8 m, landed ${by('hard bet, settled tap').map(x => f2(Math.abs(x.bz)))} m)`);
ok(by('near net (fixBlock)').some(x => x.near && x.re), 'the near-net path (fixBlock) was re-aimed from up at the net');
ok(by('serve, re-aimed').some(x => x.re), 'a serve struck on its first report was re-aimed by its settled one');
const clean = by('clean lob'), both = by('lob bet, settled lob').filter(x => x.re);
ok(clean.length && clean.every(x => x.kind === 'lob' && x.apex > 3.3), `a lob struck on a settled report is a high lob: apex ${clean.map(x => f2(x.apex))}`);
ok(both.length && both.every(x => x.apex > 3.3), `a lob bet that settles as a lob stays a high lob when re-aimed: apex ${both.map(x => f2(x.apex))}`);
A.ws.close(); B.ws.close(); proc.kill(); console.log(fails ? fails + ' FAILURES' : 'HELIUM TESTS PASSED'); process.exit(fails ? 1 : 0);
