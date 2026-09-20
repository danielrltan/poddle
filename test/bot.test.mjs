// Bot system: auto-join when alone, levels, B cycles, rallies vs a decent human, comes back after a 2nd human leaves.
import { spawn } from 'child_process';
import WebSocket from 'ws';
const PORT = 8145, proc = spawn('node', ['server/game.js'], { env: { ...process.env, PORT } });
await new Promise(r => setTimeout(r, 700));
let fails = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
function human(skill = 1) {
  const ws = new WebSocket('ws://localhost:' + PORT), h = { ws, side: null, info: null, hits: [0, 0], points: null, msgs: {} };
  let cool = 0;
  ws.on('message', raw => { const m = JSON.parse(raw); h.msgs[m.type] = (h.msgs[m.type] || 0) + 1;
    if (m.type === 'welcome') h.side = m.side;
    if (m.type === 'botinfo') h.info = m;
    if (m.type === 'hit') h.hits[m.side === h.side ? 0 : 1]++;
    if (m.type === 'point') h.points = m.score;
    if (m.type === 'state' && h.side != null) {
      ws.send(JSON.stringify({ type: 'paddle', auto: true, q: [0, 0, 0, 1] }));
      const me = m.paddles[h.side], s = h.side === 0 ? 1 : -1;
      if (m.serving === h.side && Date.now() > cool) { cool = Date.now() + 600; h.served = (h.served || 0) + 1; ws.send(JSON.stringify({ type: 'swing', power: 20, dir: 0.3, lob: 0 })); return; }
      if (m.live && me && Date.now() > cool && Math.abs(m.p[0] - me.x) < 0.9 && Math.abs(m.p[1] - me.y) < 0.8 && -(m.p[2] - me.z) * s < 1.0 && -(m.p[2] - me.z) * s > -0.5 && m.v[2] * s > 0) {
        cool = Date.now() + 400; if (Math.random() < skill) ws.send(JSON.stringify({ type: 'swing', power: 14 + Math.random() * 16, dir: (Math.random() - 0.5) * 1.6, lob: 0 })); }
    } });
  return h;
}
const wait = ms => new Promise(r => setTimeout(r, ms));
const a = human();
await wait(1500); ok(a.info && !a.info.active, 'alone for 1.5s: no bot yet');
await wait(2000); ok(a.info && a.info.active && a.info.name === 'Club', 'bot auto-joined by itself at Club: ' + JSON.stringify(a.info));
await wait(12000); ok(a.served >= 1, `swing-to-serve: the ball waited and the human served it by swinging (${a.served}x)`);
ok(a.hits[0] >= 2 && a.hits[1] >= 2, `rally vs Club in 12s: human hits ${a.hits[0]}, bot hits ${a.hits[1]}, score ${a.points}`);
a.ws.send(JSON.stringify({ type: 'bot' })); await wait(300); ok(a.info.name === 'Pro', 'B cycles to ' + a.info.name);
a.ws.send(JSON.stringify({ type: 'bot', level: 0 })); await wait(300); ok(a.info.name === 'Rookie', 'key 1 sets ' + a.info.name);
const h0 = [...a.hits]; await wait(10000); ok(a.hits[1] > h0[1], `Rookie still returns balls (${a.hits[1] - h0[1]} in 10s)`);
const b = human(); await wait(1500); ok(a.info && !a.info.active, 'second human replaced the bot');
a.ws.send(JSON.stringify({ type: 'bot' })); await wait(300); ok(a.info.reason, 'B with two humans explains itself: ' + a.info.reason);
b.ws.close(); await wait(3500); ok(a.info.active, 'bot came back after the second human left');
const h1 = [...a.hits]; await wait(8000); ok(a.hits[1] > h1[1], 'and it is playing again');
ok(a.msgs.serve >= 3, `serves kept coming from both sides (${a.msgs.serve} total, bot serves itself after a beat)`);
a.ws.close(); proc.kill(); console.log(fails ? fails + ' FAILURES' : 'BOT TESTS PASSED'); process.exit(fails ? 1 : 0);
