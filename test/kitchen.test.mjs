// Short balls must be reachable for a player who walks themselves (body mode), and a paddle held up at the net blocks.
import { spawn } from 'child_process';
import WebSocket from 'ws';
const PORT = +process.env.TEST_PORT || 8147, proc = spawn('node', ['server/game.js'], { env: { ...process.env, PORT, AUTOBOT: '0', SWING_SERVE: '0', WIN_AT: '0' } });
await new Promise(r => setTimeout(r, 700));
let fails = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
const wait = ms => new Promise(r => setTimeout(r, ms));
function player(o) {
  const ws = new WebSocket('ws://localhost:' + PORT), P = { ws, side: null, hits: 0, kinds: [], minZ: 99, state: null, ...o }; let cool = 0;
  ws.on('message', raw => { const m = JSON.parse(raw);
    if (m.type === 'welcome') P.side = m.side;
    if (m.type === 'hit' && m.side === P.side) { P.hits++; P.kinds.push(m.kind); }
    if (m.type === 'state' && P.side != null) { P.state = m; const me = m.paddles[P.side], s = P.side === 0 ? 1 : -1;
      if (me) P.minZ = Math.min(P.minZ, Math.abs(me.z));
      const mine = m.live && m.v[2] * s > 0;
      // walks themselves: x,y track the ball like a player following it with the camera; z is NEUTRAL (never leans)
      ws.send(JSON.stringify({ type: 'paddle', x: mine ? m.p[0] : 0, y: mine ? Math.max(0.3, Math.min(2.3, m.p[1])) : 1, z: 6.5, q: [0, 0, 0, 1] }));
      if (P.swing && mine && me && Date.now() > cool && Math.abs(m.p[2] - me.z) < 1.2) { cool = Date.now() + 500; ws.send(JSON.stringify({ type: 'swing', power: P.swing(), dir: 0, lob: P.lob || 0 })); }
    } });
  return P;
}
// A dinks everything short (gentle underhand); B never leans forward. Can B still reach and return them?
const A = player({ swing: () => 8, lob: 0.75 }), B = player({ swing: () => 8, lob: 0.75 });
await wait(14000);
ok(A.hits >= 3 && B.hits >= 3, `dink rally with neither player leaning: A ${A.hits} hits, B ${B.hits} hits`);
ok(Math.min(A.minZ, B.minZ) < 4.6, `the game walked them up for the short balls: closest to the net ${Math.min(A.minZ, B.minZ).toFixed(1)} m`);
// now B stops swinging entirely: a paddle held in the ball's path up at the net should block it back
B.swing = null; const before = B.hits; await wait(12000);
ok(B.hits > before && B.kinds.includes('block'), `no swing at the net: ${B.hits - before} balls blocked back (kinds: ${[...new Set(B.kinds)].join(', ')})`);
A.ws.close(); B.ws.close(); proc.kill(); console.log(fails ? fails + ' FAILURES' : 'KITCHEN TESTS PASSED'); process.exit(fails ? 1 : 0);
