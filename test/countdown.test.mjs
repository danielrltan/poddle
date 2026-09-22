// A match is counted in, and a leaver takes the score with them (NOTES 59).
//  1. Two seats, both ready: the first serve waits for a count of three (3, 2, 1 broadcast), it never arrives at once.
//  2. The count starts from when the LAST seat is ready, not from when the second player sat down: a seat that is still
//     calibrating holds it, and the full count runs once they are in.
//  3. Somebody leaves: the score is 0-0 from that moment, and whoever joins next starts at 0-0 - no inherited scoreboard.
//  TEST_PORT=<port> node test/countdown.test.mjs
// AUTOBOT stays ON: with it off every seat counts as ready whatever it says (server/game.js ready()), and the
// calibrating gate - the thing that used to serve the instant the last seat came in - cannot be exercised at all.
// Both seats therefore take theirs within botJoinAt (2.5 s), before Matt would come looking for a lonely player.
import { spawn } from 'child_process';
import WebSocket from 'ws';
const PORT = +process.env.TEST_PORT || 8296, root = new URL('..', import.meta.url).pathname;
const READY_S = 3;
const proc = spawn('node', ['server/game.js'], { cwd: root, env: { ...process.env, PORT, AUTOBOT: '1', SWING_SERVE: '0', WIN_AT: '0', READY_S: String(READY_S) }, stdio: ['ignore', 'ignore', 'inherit'] });
const wait = ms => new Promise(r => setTimeout(r, ms)); await wait(700);
let fails = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };

function player(name, { cal = false } = {}) {
  const ws = new WebSocket('ws://localhost:' + PORT), P = { ws, name, side: null, counts: [], serveAt: 0, score: null, readyAt: 0 };
  ws.on('message', raw => { const m = JSON.parse(raw);
    if (m.type === 'welcome') { P.side = m.side; ws.send(JSON.stringify({ type: 'name', name })); if (cal) ws.send(JSON.stringify({ type: 'status', cal: true })); }
    if (m.type === 'countdown') P.counts.push({ left: m.left, at: Date.now() });
    if (m.type === 'serve' && !P.serveAt) P.serveAt = Date.now();
    if (m.type !== 'state' || P.side == null) return;
    P.score = [m.score[0], m.score[1]];
    if (!P.held) { if (!P.readyAt) P.readyAt = Date.now(); ws.send(JSON.stringify({ type: 'paddle', x: 0, y: 1, z: 6.5, q: [0, 0, 0, 1], r: 0 })); }   // a paddle message IS "this seat is ready"
  });
  return P;
}
// ---- 1 + 2: the count, and that it waits for a seat that is still calibrating ----
const A = player('Ann'), B = player('Ben', { cal: true });
B.held = true;                                                   // Ben sends no paddle yet: still calibrating
await wait(2500);
ok(!A.serveAt && !A.counts.length, `nothing is counted or served while a seat is still calibrating (${A.counts.length} counts, served: ${!!A.serveAt})`);
B.held = false; B.ws.send(JSON.stringify({ type: 'status', cal: false }));
const inAt = Date.now();
await wait((READY_S + 2) * 1000);
const lefts = A.counts.map(c => c.left);
ok(lefts.join(',') === '3,2,1,0', `counted in from the moment both seats were ready: ${lefts.join(' - ') || 'nothing'}`);
const waited = (A.serveAt - inAt) / 1000;
ok(A.serveAt && waited > READY_S - 0.6 && waited < READY_S + 1.2, `the first serve waited ${waited.toFixed(1)} s (the count), not the old ~0.8 s`);
ok(B.counts.length === A.counts.length, `both seats are counted in together (${B.counts.length} and ${A.counts.length})`);

// ---- 3: a leaver takes the score with them ----
await wait(9000);                                                 // nobody swings: points fall in
const had = A.score;
ok(had && had[0] + had[1] > 0, `a score to lose first: ${had ? had.join('-') : 'none'}`);
B.ws.close(); await wait(1500);
ok(A.score && A.score[0] === 0 && A.score[1] === 0, `the board is clear the moment Ben leaves: ${A.score ? A.score.join('-') : 'no state'}`);
const C = player('Cat'); await wait(2000);
ok(C.score && C.score[0] === 0 && C.score[1] === 0, `Cat sits down to 0-0, not to Ben's score: ${C.score ? C.score.join('-') : 'no state'}`);
ok(C.counts.length > 0, `and the new match is counted in too (${C.counts.map(c => c.left).join(' - ') || 'nothing'})`);
for (const p of [A, B, C]) p.ws.close(); proc.kill();
console.log(fails ? fails + ' FAILURES' : 'COUNTDOWN TESTS PASSED'); process.exit(fails ? 1 : 0);
