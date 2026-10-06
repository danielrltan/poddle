// Away (NOTES 220): a player whose tab is hidden or unfocused says {type:'status', away}.
//  1. Against Matt (one human): away IS a pause (paused, by that seat; the tag says Paused), and coming back resumes it.
//  2. A pause a card made is kept: away and back over it, or a card opened over an away pause, still paused after coming back.
//  3. Two humans: no pause, the rally plays on; the others see 'afk' over that seat until it is back. Only booleans count.
//  TEST_PORT=<port> node test/away.test.mjs
import { spawn } from 'child_process';
import WebSocket from 'ws';
const PORT = +process.env.TEST_PORT || 8297, root = new URL('..', import.meta.url).pathname;
const proc = spawn('node', ['server/game.js'], { cwd: root, env: { ...process.env, PORT, AUTOBOT: '1', WIN_AT: '0' }, stdio: ['ignore', 'ignore', 'inherit'] });
const wait = ms => new Promise(r => setTimeout(r, ms)); await wait(700);
let fails = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
setTimeout(() => { console.log('FAIL (timeout)'); proc.kill(); process.exit(1); }, 60000);

function player(name) {
  const ws = new WebSocket('ws://localhost:' + PORT), P = { ws, name, side: null, paused: null, pd: null };
  ws.on('message', raw => { const m = JSON.parse(raw);
    if (m.type === 'welcome') { P.side = m.side; ws.send(JSON.stringify({ type: 'name', name })); }
    if (m.type === 'paused' && !m.refused) P.paused = m.on;
    if (m.type !== 'state' || P.side == null) return;
    P.pd = m.paddles; P.frozen = !!m.paused;
    ws.send(JSON.stringify({ type: 'paddle', x: 0, y: 1, z: P.side ? -6.5 : 6.5, q: [0, 0, 0, 1], r: 0 }));
  });
  P.send = m => ws.send(JSON.stringify(m));
  P.statusOf = side => P.pd && P.pd[side] ? P.pd[side].status || null : null;
  return P;
}
const A = player('Ann');
for (let i = 0; i < 40 && !(A.pd && A.pd[1 - A.side] && A.pd[1 - A.side].bot); i++) await wait(200);
ok(A.pd && A.pd[1 - A.side] && A.pd[1 - A.side].bot, 'Matt sits down opposite a lonely player');

// ---- 1 ----
A.send({ type: 'status', away: true }); await wait(300);
ok(A.paused === true && A.frozen && A.statusOf(A.side) === 'paused', `against Matt, away pauses the room, Paused over her (paused ${A.paused}, frozen ${A.frozen}, tag ${A.statusOf(A.side)})`);
A.send({ type: 'status', away: false }); await wait(300);
ok(A.paused === false && !A.frozen && A.statusOf(A.side) === null, `back: it resumes, no tag (paused ${A.paused}, tag ${A.statusOf(A.side)})`);

// ---- 2 ----
A.send({ type: 'pause', on: true }); await wait(200); A.send({ type: 'status', away: true }); await wait(200); A.send({ type: 'status', away: false }); await wait(300);
ok(A.paused === true && A.frozen, `a card's pause outlives an away and back (paused ${A.paused})`);
A.send({ type: 'pause', on: false }); await wait(200);
A.send({ type: 'status', away: true }); await wait(200); A.send({ type: 'pause', on: true }); await wait(200); A.send({ type: 'status', away: false }); await wait(300);
ok(A.paused === true && A.frozen, `a card opened over an away pause keeps it after coming back (paused ${A.paused})`);
A.send({ type: 'pause', on: false }); await wait(300);
ok(A.paused === false && !A.frozen, 'closing the card resumes');

// ---- 3 ----
const B = player('Ben');
for (let i = 0; i < 40 && !(A.pd && A.pd[1 - A.side] && !A.pd[1 - A.side].bot && B.pd); i++) await wait(200);
ok(A.pd && A.pd[1 - A.side] && !A.pd[1 - A.side].bot, 'Ben takes Matt\'s seat');
A.send({ type: 'status', away: true }); await wait(400);
ok(!B.frozen && B.statusOf(A.side) === 'afk', `two humans: no pause, Ben sees Away over Ann (frozen ${B.frozen}, tag ${B.statusOf(A.side)})`);
A.send({ type: 'status', away: 'yes' }); A.send({ type: 'status', away: 1 }); await wait(300);
ok(B.statusOf(A.side) === 'afk', 'only a boolean changes it');
A.send({ type: 'status', away: false }); await wait(400);
ok(B.statusOf(A.side) === null && !B.frozen, `back: the tag goes (${B.statusOf(A.side)})`);
B.send({ type: 'status', away: true }); await wait(400);
ok(A.statusOf(B.side) === 'afk' && A.statusOf(A.side) === null, 'Ben away: his seat only');

proc.kill(); console.log(fails ? `${fails} FAILED` : 'PASS'); process.exit(fails ? 1 : 0);
