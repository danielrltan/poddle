// Server side of early swing reports: lag compensation by `age` (the ball is struck where it WAS, never from behind the
// player), power corrections (`fix`, eased in), and no added latency. Usage: node test/lagcomp.mjs
import { spawn } from 'child_process';
import WebSocket from 'ws';
const PORT = +process.env.TEST_PORT || 8171, proc = spawn('node', ['server/game.js'], { env: { ...process.env, PORT, AUTOBOT: '0', SWING_SERVE: '0', WIN_AT: '0', BLOCK: '0' } });
await new Promise(r => setTimeout(r, 700));
let fails = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
const ZONE = { x: 1.15, y: 0.95, front: 1.6, behind: 1.25 }, G = 9.81, wait = ms => new Promise(r => setTimeout(r, ms));
// plan: what this player does with each ball that comes to them, in order
function player(plans) {
  const ws = new WebSocket('ws://localhost:' + PORT), h = { ws, side: null, log: [], st: [], wasIn: false, acted: false, ball: 0, sent: {} };
  ws.on('message', raw => { const m = JSON.parse(raw);
    if (m.type === 'welcome') h.side = m.side;
    if (m.type === 'hit' || m.type === 'launch' || m.type === 'whiff' || m.type === 'point' || m.type === 'bounce') h.log.push({ ...m, at: Date.now(), ball: h.ball, i: h.st.length });
    if (m.type === 'launch' && m.by !== h.side && Date.now() - (h.lastLaunch || 0) > 300) { h.ball++; h.wasIn = h.acted = false; }   // a re-launch is the same ball
    if (m.type === 'launch') h.lastLaunch = Date.now();
    if (m.type !== 'state' || h.side == null) return;
    h.st.push({ at: Date.now(), t: m.t, p: m.p, v: m.v, z: m.paddles[h.side] && m.paddles[h.side].z });
    ws.send(JSON.stringify({ type: 'paddle', auto: true, q: [0, 0, 0, 1] }));
    const me = m.paddles[h.side], s = h.side === 0 ? 1 : -1, plan = plans[h.ball - 1];
    if (!me || !m.live || h.acted || !plan || m.v[2] * s <= 0) return;
    const ahead = -(m.p[2] - me.z) * s, inside = ahead > -ZONE.behind && ahead < ZONE.front && Math.abs(m.p[0] - me.x) < ZONE.x && Math.abs(m.p[1] - me.y) < ZONE.y;
    const swing = o => { if (!o.fix) h.sent[h.ball] = performance.now(); ws.send(JSON.stringify({ type: 'swing', dir: 0, lob: 0, ...o })); };
    if (inside) h.wasIn = true;
    if (plan === 'late+age' && h.wasIn && !inside) { h.acted = true; swing({ power: 20, age: 250 }); }
    if (plan === 'late' && h.wasIn && !inside) { h.acted = true; swing({ power: 20 }); }
    if (plan === 'behind' && h.wasIn && ahead < -0.6) { h.acted = true; swing({ power: 20 }); }
    if (plan === 'fix after hit' && inside && ahead < 1) { h.acted = true; swing({ power: 8, age: 60 }); setTimeout(() => swing({ power: 30, age: 160, fix: true }), 100); }
    if (plan === 'fix before hit' && !h.wasIn && ahead > ZONE.front + 0.3 && ahead < ZONE.front + 2.5) { h.acted = true; swing({ power: 8, age: 60 }); setTimeout(() => swing({ power: 30, age: 80, fix: true }), 20); }
  });
  ws.on('message', raw => { const m = JSON.parse(raw); if (m.type === 'hit' && m.side === h.side && h.sent[h.ball] != null) (h.lat ||= {})[h.ball] ??= performance.now() - h.sent[h.ball]; });
  return h;
}
const a = player(['fix after hit', 'late', 'behind']), b = player(['late+age', 'fix before hit', 'behind']);      // a = side 0 serves first, b receives
const t0 = Date.now(); await wait(13000);
const mine = (h, ball, type) => h.log.filter(e => e.ball === ball && e.type === type && (type === 'whiff' || (e.side ?? e.by) === h.side));
const aheadOf = (h, e) => -(e.p[2] - h.st[e.i - 1].z) * (h.side === 0 ? 1 : -1);        // where the launch happened, relative to my paddle

const b1 = mine(b, 1, 'hit');
ok(b1.length === 1, `ball already past the box + age 250 ms: still a hit (${b1.length})`);
ok(b1.length && aheadOf(b, b1[0]) > -0.15 && aheadOf(b, b1[0]) < 0.6, `...struck where it met the paddle, not from behind the player (launched ${b1.length ? aheadOf(b, b1[0]).toFixed(2) : '-'} m in front of the paddle; the ball itself was > ${ZONE.behind} m behind)`);
ok(b1.length && Array.isArray(b1[0].v) && b1[0].v.length === 3 && b1[0].v.every(Number.isFinite), 'the hit event carries the launch velocity (the hitter need not wait for a state packet)');

const ah = mine(a, 1, 'hit'), al = mine(a, 1, 'launch');
ok(ah.length === 1 && Math.abs(ah[0].n - 2 / 28) < 0.01, `early report in the box: struck at once on the early power (n=${ah[0] && ah[0].n.toFixed(2)})`);
ok(a.lat && a.lat[1] < 12, `...on arrival, not on the next tick (swing -> hit ${a.lat && a.lat[1] != null ? a.lat[1].toFixed(1) : '-'} ms)`);
ok(al.length === 2 && al[1].at - al[0].at < 200, `...and the fix 100 ms later re-aimed it (${al.length} launches, ${al.length > 1 ? al[1].at - al[0].at : '-'} ms apart), still one hit`);
ok(al.length === 2 && Math.abs(Math.abs(al[1].land[1]) - 5.43) < 0.05 && Math.abs(Math.abs(al[0].land[1]) - 2.84) < 0.05, `landing marker: provisional ${al[0] && Math.abs(al[0].land[1]).toFixed(2)} m -> refined ${al[1] && Math.abs(al[1].land[1]).toFixed(2)} m deep`);
if (ah.length && al.length === 2) {
  const bn = a.log.find(e => e.type === 'bounce' && e.at > ah[0].at), off = bn ? Math.hypot(bn.p[0] - al[1].land[0], bn.p[2] - al[1].land[1]) : NaN;
  ok(off < 0.25, `provisional-then-fix ends on the refined target (bounced ${off.toFixed(2)} m from it)`);
  let kink = 0, steps = 0;                                // velocity change between packets after the hit packet, gravity removed
  for (let i = ah[0].i + 1; i < a.st.length && a.st[i].at - ah[0].at < 450; i++) { const A = a.st[i - 1], B = a.st[i], d = B.t - A.t;
    const k = Math.hypot(B.v[0] - A.v[0], B.v[1] - A.v[1] + G * d, B.v[2] - A.v[2]); kink = Math.max(kink, k); if (k > 0.05) steps++; }
  ok(kink < 3 && steps >= 5, `the fix is eased in: largest velocity step ${kink.toFixed(2)} m/s, spread over ${steps} packets (was one ~7 m/s step)`);
}
const bh = mine(b, 2, 'hit');
ok(bh.length === 1 && Math.abs(bh[0].n - 24 / 28) < 0.01 && mine(b, 2, 'launch').filter(e => e.at - bh[0].at < 400).length === 1, `fix before contact: one hit, one launch, on the corrected power (n=${bh[0] && bh[0].n.toFixed(2)})`);
ok(mine(a, 2, 'hit').length === 0 && mine(a, 2, 'whiff').length === 1, `swing with no age after the ball has left the box: a whiff (${mine(a, 2, 'whiff').map(e => e.why)})`);
const a3 = mine(a, 3, 'hit'), b3 = mine(b, 3, 'hit'), h3 = a3.length ? [a, a3[0]] : b3.length ? [b, b3[0]] : null;
ok(!!h3, 'swing with no age, ball 0.6 m behind the paddle but inside the (widened) box: connects');
ok(h3 && aheadOf(...h3) > -0.15, `...and it still leaves from the paddle, not from behind it (${h3 ? aheadOf(...h3).toFixed(2) : '-'} m)`);
const hz = a.st.length / ((Date.now() - t0) / 1000);
ok(hz > 58 && hz < 62, `state packets still arrive at 60 Hz (${hz.toFixed(1)}/s)`);
a.ws.close(); b.ws.close(); proc.kill(); console.log(fails ? fails + ' FAILURES' : 'LAG COMPENSATION TESTS PASSED'); process.exit(fails ? 1 : 0);
