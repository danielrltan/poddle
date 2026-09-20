// Server side of early swing reports: lag compensation by `age`, and power corrections (`fix`). Usage: node test/lagcomp.mjs
import { spawn } from 'child_process';
import WebSocket from 'ws';
const PORT = 8181, proc = spawn('node', ['server/game.js'], { env: { ...process.env, PORT, AUTOBOT: '0' } });
await new Promise(r => setTimeout(r, 700));
let fails = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
const ZONE = { x: 1.15, y: 0.95, front: 1.6, behind: 0.9 }, wait = ms => new Promise(r => setTimeout(r, ms));
// plan: what this player does with each ball that comes to them, in order
function player(plans) {
  const ws = new WebSocket('ws://localhost:' + PORT), h = { ws, side: null, log: [], wasIn: false, acted: false, ball: 0 };
  ws.on('message', raw => { const m = JSON.parse(raw);
    if (m.type === 'welcome') h.side = m.side;
    if (m.type === 'hit' || m.type === 'launch' || m.type === 'whiff' || m.type === 'point') h.log.push({ ...m, at: Date.now(), ball: h.ball });
    if (m.type === 'launch' && m.by !== h.side && Date.now() - (h.lastLaunch || 0) > 300) { h.ball++; h.wasIn = h.acted = false; }   // a re-launch is the same ball
    if (m.type === 'launch') h.lastLaunch = Date.now();
    if (m.type !== 'state' || h.side == null) return;
    ws.send(JSON.stringify({ type: 'paddle', auto: true, q: [0, 0, 0, 1] }));
    const me = m.paddles[h.side], s = h.side === 0 ? 1 : -1, plan = plans[h.ball - 1];
    if (!me || !m.live || h.acted || !plan || m.v[2] * s <= 0) return;
    const ahead = -(m.p[2] - me.z) * s, inside = ahead > -ZONE.behind && ahead < ZONE.front && Math.abs(m.p[0] - me.x) < ZONE.x && Math.abs(m.p[1] - me.y) < ZONE.y;
    const swing = o => ws.send(JSON.stringify({ type: 'swing', dir: 0, lob: 0, ...o }));
    if (inside) h.wasIn = true;
    if (plan === 'late+age' && h.wasIn && !inside) { h.acted = true; swing({ power: 20, age: 140 }); }
    if (plan === 'late' && h.wasIn && !inside) { h.acted = true; swing({ power: 20 }); }
    if (plan === 'fix after hit' && inside) { h.acted = true; swing({ power: 8, age: 60 }); setTimeout(() => swing({ power: 30, age: 100, fix: true }), 50); }
    if (plan === 'fix before hit' && !h.wasIn && ahead > ZONE.front + 0.3 && ahead < ZONE.front + 2.5) { h.acted = true; swing({ power: 8, age: 60 }); setTimeout(() => swing({ power: 30, age: 80, fix: true }), 20); }
  });
  return h;
}
const a = player(['fix after hit', 'late']), b = player(['late+age', 'fix before hit']);      // a = side 0 serves first, b receives
await wait(9000);
const mine = (h, ball, type) => h.log.filter(e => e.ball === ball && e.type === type && (type === 'whiff' || (e.side ?? e.by) === h.side));
ok(mine(b, 1, 'hit').length === 1, `ball already ~1 tick past the box + age 140 ms: still a hit (${mine(b, 1, 'hit').length})`);
const ah = mine(a, 1, 'hit'), al = mine(a, 1, 'launch');
ok(ah.length === 1 && Math.abs(ah[0].n - 2 / 28) < 0.01, `early report in the box: struck at once on the early power (n=${ah[0] && ah[0].n.toFixed(2)})`);
ok(al.length === 2 && al[1].at - al[0].at < 150, `...and the fix 50 ms later re-launched it (${al.length} launches, ${al.length > 1 ? al[1].at - al[0].at : '-'} ms apart), still one hit`);
const bh = mine(b, 2, 'hit');
ok(bh.length === 1 && Math.abs(bh[0].n - 24 / 28) < 0.01 && mine(b, 2, 'launch').filter(e => e.at - bh[0].at < 400).length === 1, `fix before contact: one hit, one launch, on the corrected power (n=${bh[0] && bh[0].n.toFixed(2)})`);
ok(mine(a, 2, 'hit').length === 0 && mine(a, 2, 'whiff').length === 1, `late swing with no age: still a whiff (${mine(a, 2, 'whiff').map(e => e.why)})`);
a.ws.close(); b.ws.close(); proc.kill(); console.log(fails ? fails + ' FAILURES' : 'LAG COMPENSATION TESTS PASSED'); process.exit(fails ? 1 : 0);
