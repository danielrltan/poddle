// Deep drives and lobs must be returnable by a player who never leans back and whose paddle height comes from their head.
import { spawn } from 'child_process';
import WebSocket from 'ws';
const PORT = +process.env.TEST_PORT || 8148, proc = spawn('node', ['server/game.js'], { env: { ...process.env, PORT, AUTOBOT: '0', SWING_SERVE: '0', WIN_AT: '0' } });
await new Promise(r => setTimeout(r, 700));
const wait = ms => new Promise(r => setTimeout(r, ms));
function player(o) {
  const ws = new WebSocket('ws://localhost:' + PORT), P = { ws, side: null, hits: 0, maxZ: 0, ...o }; let cool = 0;
  ws.on('message', raw => { const m = JSON.parse(raw);
    if (m.type === 'welcome') P.side = m.side;
    if (m.type === 'hit' && m.side === P.side) P.hits++;
    if (m.type === 'state' && P.side != null) { const me = m.paddles[P.side], s = P.side === 0 ? 1 : -1, mine = m.live && m.v[2] * s > 0;
      if (me) P.maxZ = Math.max(P.maxZ, Math.abs(me.z));
      ws.send(JSON.stringify({ type: 'paddle', x: mine ? m.p[0] : 0, y: mine ? Math.max(0.5, Math.min(1.4, m.p[1])) : 1, z: 6.5, q: [0, 0, 0, 1] }));   // head-height paddle, never leans
      if (mine && me && Date.now() > cool && Math.abs(m.p[2] - me.z) < 1.2) { cool = Date.now() + 500; ws.send(JSON.stringify({ type: 'swing', power: P.power(), dir: (Math.random() - 0.5), lob: P.lob() })); } } });
  return P;
}
let i = 0;
const A = player({ power: () => (i++ % 2 ? 36 : 30), lob: () => (i % 2 ? 0 : 0.75) });   // alternates smashes and big deep lobs
const B = player({ power: () => 16, lob: () => 0 });
await wait(25000);
console.log(`A sent ${A.hits} deep balls (smashes + lobs); B returned ${B.hits}; B went back as far as ${B.maxZ.toFixed(1)} m from the net`);
const ok = B.hits >= A.hits * 0.7 && A.hits >= 5;
A.ws.close(); B.ws.close(); proc.kill(); console.log(ok ? 'DEEP TESTS PASSED' : 'DEEP TESTS FAILED'); process.exit(ok ? 0 : 1);
