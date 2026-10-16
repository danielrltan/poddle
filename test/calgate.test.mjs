// No serve goes out while a seated human is calibrating (NOTES 258). The serve that waits for a calibrating seat (NOTES 59, 241) only
// covered the moment BEFORE a serve: once the ball hung in front of the server it was live, so a seat that went back to calibrating
// (C, the phone's button, a paddle swap) left it up, the server could strike it, and 9 s later it was served for them anyway.
//  1. Ann and Ben ready, a serve hangs. The receiver calibrates: the ball comes down (no serve hanging), the server's swing and the
//     9 s serve-for-you strike nothing, and the receiver shows 'calibrating'. Back on the court, the serve hangs again.
//  2. The SERVER calibrates while their own serve hangs: nothing is served for them either.
//  3. One human against Matt, before the first strike: calibrating stops Matt's serve too.
//  4. A swing from a seat that is calibrating strikes nothing.
//  TEST_PORT=<port> node test/calgate.test.mjs     (uses TEST_PORT only)
// AUTOBOT stays ON, as in countdown.test.mjs: with it off every seat counts as ready whatever it says (server/game.js ready()).
import { spawn } from 'child_process';
import WebSocket from 'ws';
const PORT = +process.env.TEST_PORT || 8297, root = new URL('..', import.meta.url).pathname;
const proc = spawn('node', ['server/game.js'], { cwd: root, env: { ...process.env, PORT, AUTOBOT: '1', SWING_SERVE: '1', WIN_AT: '0', READY_S: '1' }, stdio: ['ignore', 'ignore', 'inherit'] });
const wait = ms => new Promise(r => setTimeout(r, ms)); await wait(700);
let fails = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
const until = async (f, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (f()) return true; await wait(50); } return false; };

function player(name) {
  const ws = new WebSocket('ws://localhost:' + PORT), P = { ws, name, side: null, held: false, serves: [], hits: [], st: null };
  P.send = o => ws.send(JSON.stringify(o));
  ws.on('message', raw => { const m = JSON.parse(raw);
    if (m.type === 'welcome') { P.side = m.side; P.send({ type: 'name', name }); }
    if (m.type === 'serve') P.serves.push({ by: m.by, at: Date.now() });
    if (m.type === 'hit') P.hits.push({ side: m.side, at: Date.now() });
    if (m.type !== 'state' || P.side == null) return;
    P.st = m;
    if (!P.held) P.send({ type: 'paddle', x: 0, y: 1, z: 6.5, q: [0, 0, 0, 1], r: 0 });   // a paddle message IS "this seat is ready"
  });
  return P;
}
const calib = (P, on) => { P.held = on; P.send({ type: 'status', cal: on }); };
const swing = P => P.send({ type: 'swing', power: 30, dir: 0.2, lob: 0, final: true, off: 1, back: 1 });
const statusOf = (P, side) => P.st && P.st.paddles && P.st.paddles[side] && P.st.paddles[side].status;
const hitsSince = (P, t) => P.hits.filter(h => h.at >= t).length;

// ---- 1: the receiver calibrates while a serve hangs ----
const A = player('Ann'), B = player('Ben');
ok(await until(() => A.serves.length > 0 && A.st && A.st.serving != null), `a serve hangs once both seats are ready (by side ${A.st && A.st.serving})`);
const S = [A, B].find(p => p.side === A.st.serving), R = S === A ? B : A;
const t1 = Date.now(); calib(R, true);
ok(await until(() => S.st.serving == null, 1500), `the receiver calibrates: the hanging serve comes down (serving ${S.st.serving})`);
ok(await until(() => statusOf(S, R.side) === 'calibrating', 1500), `and the server sees them as calibrating (${statusOf(S, R.side)})`);
swing(S); await wait(1500); swing(S);
ok(hitsSince(S, t1) === 0, `the server's swing strikes nothing while the receiver calibrates (${hitsSince(S, t1)} hits)`);
await wait(9000);
ok(hitsSince(S, t1) === 0 && S.st.serving == null, `nor is it served for them after 9 s (${hitsSince(S, t1)} hits, serving ${S.st.serving})`);
const back1 = Date.now(); calib(R, false);
ok(await until(() => S.serves.some(s => s.at >= back1) && S.st.serving != null, 5000), `back on the court, the serve hangs again`);
const Sb = [A, B].find(p => p.side === S.st.serving); swing(Sb);
ok(await until(() => hitsSince(S, back1) > 0, 4000), `and the server's swing serves it (${Sb === S ? 'the same server' : 'the other side'}, ${hitsSince(S, back1)} hits)`);

// ---- 2: the server calibrates while their own serve hangs ----
ok(await until(() => A.st && A.st.serving != null && A.serves.some(s => s.at > back1 + 1000), 25000), `the next serve hangs (side ${A.st && A.st.serving})`);
const S2 = [A, B].find(p => p.side === A.st.serving), R2 = S2 === A ? B : A, t2 = Date.now();
calib(S2, true);
ok(await until(() => R2.st.serving == null, 1500), `the server calibrates: their own serve comes down`);
swing(S2);      // a seat that is calibrating: its swings strike nothing (4)
await wait(10000);
ok(hitsSince(R2, t2) === 0, `nothing is served for a calibrating server, by swing or after 9 s (${hitsSince(R2, t2)} hits)`);
calib(S2, false);
for (const p of [A, B]) p.ws.close(); await wait(500);

// ---- 3: one human against Matt, before the first strike ----
const C = player('Cat');
ok(await until(() => C.st && C.st.serving != null, 12000), `Matt sits down and a serve hangs (by ${C.st && C.st.serving === C.side ? 'Cat' : 'Matt'})`);
const t3 = Date.now(); calib(C, true);
ok(await until(() => C.st.serving == null, 1500), `Cat calibrates: the serve comes down`);
await wait(10500);
ok(hitsSince(C, t3) === 0, `neither Matt nor the 9 s serve-for-you serves while Cat calibrates (${hitsSince(C, t3)} hits)`);
calib(C, false);
ok(await until(() => C.st.serving != null || hitsSince(C, t3) > 0, 6000), `back on the court, play goes on`);

C.ws.close(); proc.kill();
console.log(fails ? fails + ' FAILURES' : 'CALGATE TESTS PASSED'); process.exit(fails ? 1 : 0);
