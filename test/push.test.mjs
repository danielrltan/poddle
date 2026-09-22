// Up at the net there is one curve, not a step and a cliff: a paddle held up blocks, and the harder you push the deeper the
// ball lands, until it meets the ordinary drive. A push that arrives just after the paddle already blocked the ball counts as
// that block's push, and an early report (a bet) never fires a deep ball the player did not hit.   TEST_PORT=<port> node test/push.test.mjs
import { spawn } from 'child_process';
import WebSocket from 'ws';
const PORT = +process.env.TEST_PORT || 8191, root = new URL('..', import.meta.url).pathname;
const proc = spawn('node', ['server/game.js'], { cwd: root, env: { ...process.env, PORT, AUTOBOT: '0', SWING_SERVE: '0', WIN_AT: '0' } });
const wait = ms => new Promise(r => setTimeout(r, ms)); await wait(700);
let fails = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };

// A: feeds the ball. B: stands at the net (lean z), and either holds the paddle up or pushes at a set power.
function player(o) {
  const ws = new WebSocket('ws://localhost:' + PORT), P = { ws, side: null, shots: [], ws0: null, ...o }; let cool = 0;
  ws.on('message', raw => { const m = JSON.parse(raw);
    if (m.type === 'welcome') P.side = m.side;
    if (m.type === 'hit' && m.side === P.side) P.shots.push({ kind: m.kind, n: m.n, hitN: m.n, land: null, at: Date.now() });
    if (m.type === 'launch' && m.by === P.side) { const s = P.shots[P.shots.length - 1]; if (s) { s.land = -m.land[1] * (P.side === 0 ? 1 : -1); if (m.kind) s.kind = m.kind; if (m.n != null) s.n = m.n; } }
    if (m.type !== 'state' || P.side == null) return;
    const me = m.paddles[P.side], s = P.side === 0 ? 1 : -1, mine = m.live && m.v[2] * s > 0;
    // paddle tracks the ball (a player holding it in the ball's path); z = how far from the net this player stands
    ws.send(JSON.stringify({ type: 'paddle', x: mine ? m.p[0] : 0, y: mine ? Math.max(0.4, Math.min(1.6, m.p[1])) : 1, z: P.lean || 6.5, q: [0, 0, 0, 1], r: P.rate || 0 }));
    if (mine && me && P.swing && Date.now() > cool && Math.abs(m.p[2] - me.z) < (P.at || 1.0)) { cool = Date.now() + 600; P.swing(ws, m); }
  });
  return P;
}
// the feeder dinks: short balls are what draw a player up to the kitchen in the first place
const feed = () => player({ lean: 6.5, at: 1.2, swing: ws => ws.send(JSON.stringify({ type: 'swing', power: 9, dir: 0, lob: 0.7, final: true })) });
const land = P => P.shots.filter(s => s.land != null).map(s => s.land);
const avg = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const BLOCK_WITHIN = 5.0;                                // server BLOCK.within: past this a held-up paddle no longer reaches

// ---- 1. a push scales: the same player at the net, pushing harder each run, sends the ball further back ----
const runs = [];
for (const power of [6, 10, 14, 18, 24]) {
  const A = feed(), B = player({ lean: 2.8, at: 1.2, swing: ws => ws.send(JSON.stringify({ type: 'swing', power, dir: 0, lob: 0.1, final: true })) });
  await wait(9000);
  runs.push({ power, land: avg(land(B)), kinds: [...new Set(B.shots.map(s => s.kind))], n: B.shots.length });
  A.ws.close(); B.ws.close(); await wait(400);
}
for (const r of runs) console.log(`       power ${String(r.power).padStart(2)} rad/s -> lands ${r.land.toFixed(2)} m past the net (${r.n} shots, ${r.kinds.join('/')})`);
const depths = runs.map(r => r.land);
ok(runs.every(r => r.n > 0), `every push at the net returned the ball (${runs.map(r => r.n).join(', ')} shots)`);
ok(depths.every((d, i) => i === 0 || d > depths[i - 1] + 0.15), `each harder push lands deeper: ${depths.map(d => d.toFixed(2)).join(' < ')}`);
ok(depths[depths.length - 1] - depths[0] > 1.2, `the range is worth having: ${(depths[depths.length - 1] - depths[0]).toFixed(2)} m from softest to hardest`);
ok(runs.some(r => r.kinds.includes('block')) && runs.some(r => r.kinds.includes('punch')), `the player is told which they played: ${[...new Set(runs.flatMap(r => r.kinds))].join(', ')}`);

// ---- 2. a paddle simply held up blocks, and a shove into it (no swing at all) sends the ball deeper ----
const held = [];
for (const rate of [0, 7.5]) {
  const A = feed(), B = player({ lean: 2.8 });                 // no swing function at all: the paddle is just there
  B.rate = rate;
  await wait(16000);                                           // long enough for a few rallies: the feeder has to run in for every block
  held.push({ rate, land: avg(land(B)), n: B.shots.length, kinds: [...new Set(B.shots.map(s => s.kind))] });
  A.ws.close(); B.ws.close(); await wait(400);
}
for (const h of held) console.log(`       held paddle, hand at ${h.rate} rad/s -> lands ${h.land.toFixed(2)} m (${h.n} blocks)`);
ok(held[0].n >= 2, `a paddle held up with no swing blocks the ball back (${held[0].n} blocks, ${held[0].kinds.join('/')})`);
ok(held[1].land > held[0].land + 0.2, `a shove into it, still under the swing trigger, sends it deeper: ${held[0].land.toFixed(2)} -> ${held[1].land.toFixed(2)} m`);

// ---- 3. the swing NEVER waits: the ball leaves at the power of the swing that struck it, and the settled report bends
// it afterwards. A first report that overshoots used to be struck soft and raised later, which read as lag on every swing.
for (const [bet, settled, deeper] of [[33, 30, true], [33, 8, false]]) {
  const A = feed(), B = player({ lean: 2.8, at: 1.2, swing: ws => {
    ws.send(JSON.stringify({ type: 'swing', power: bet, dir: 0, lob: 0.1, age: 80, final: false }));
    setTimeout(() => ws.send(JSON.stringify({ type: 'swing', power: settled, dir: 0, lob: 0.1, fix: true, final: true })), 150);
  } });
  await wait(9000);
  const hit = B.shots.filter(s => s.land != null);
  const struckAt = avg(B.shots.map(s => s.hitN).filter(n => n != null));      // the power the ball actually LEFT at
  ok(hit.length > 0 && struckAt > 0.6, `a first report of ${bet} strikes at once and at its own power: n ${struckAt.toFixed(2)} on the hit (never held back)`);
  const landed = avg(hit.map(s => s.land));
  ok(deeper ? landed > 3.2 : landed < 4.6, `settling at ${settled}: the landing follows, ${landed.toFixed(2)} m`);
  A.ws.close(); B.ws.close(); await wait(400);
}

// ---- 4. the push gets you out: a hard push sends the opponent back past the net zone, a block keeps them in ----
for (const [power, out] of [[8, false], [24, true]]) {
  const A = feed(), B = player({ lean: 2.8, at: 1.2, swing: ws => ws.send(JSON.stringify({ type: 'swing', power, dir: 0, lob: 0.1, final: true })) });
  const met = [];                                    // where the opponent stood when they met the ball
  A.ws.on('message', raw => { const m = JSON.parse(raw); if (m.type === 'hit' && m.side === A.side && A.z != null) met.push(A.z);
    if (m.type === 'state' && A.side != null && m.paddles[A.side]) A.z = Math.abs(m.paddles[A.side].z); });
  await wait(9000);
  const where = met.length ? met.reduce((x, y) => x + y, 0) / met.length : 0;
  ok(met.length > 0 && (out ? where > BLOCK_WITHIN : where <= BLOCK_WITHIN), `push at ${power} rad/s: the opponent meets it ${where.toFixed(1)} m from the net (${out ? 'out of the net zone' : 'still in it'})`);
  A.ws.close(); B.ws.close(); await wait(400);
}

// ---- 5. a player who has walked in is not stuck there: a deep ball pulls them back out, a short one leaves them in ----
// (every point opens with a deep serve, so the serve return is dropped: what is being measured is the rally.)
const stand = {};
for (const [name, power, lob] of [['deep drive', 24, 0.1], ['dink', 9, 0.7]]) {
  const A = player({ lean: 6.5, at: 1.2, swing: ws => ws.send(JSON.stringify({ type: 'swing', power, dir: 0, lob, final: true })) });
  const B = player({ lean: 2.8, at: 1.4, swing: ws => ws.send(JSON.stringify({ type: 'swing', power: 9, dir: 0, lob: 0.7, final: true })) });
  const met = [];                                    // where B stood when they met the ball, though they leaned right in
  let served = false;
  B.ws.on('message', raw => { const m = JSON.parse(raw);
    if (m.type === 'point') served = false;
    if (m.type === 'hit' && m.side === B.side && B.z != null) { if (served) met.push(B.z); served = true; }
    if (m.type === 'state' && B.side != null && m.paddles[B.side]) B.z = Math.abs(m.paddles[B.side].z); });
  await wait(14000);
  stand[name] = { where: avg(met), n: met.length };
  console.log(`       leaning right in at 2.8 m, against a ${name}: meets the ball ${stand[name].where.toFixed(1)} m from the net (${met.length} rally shots)`);
  A.ws.close(); B.ws.close(); await wait(400);
}
ok(stand['dink'].n > 0 && stand['dink'].where <= BLOCK_WITHIN, `a dink leaves a leaned-in player in the kitchen: ${stand['dink'].where.toFixed(1)} m from the net`);
ok(stand['deep drive'].where > stand['dink'].where + 1.0, `a deep ball pulls them back out of it: ${stand['dink'].where.toFixed(1)} m against a dink, ${stand['deep drive'].where.toFixed(1)} m against a drive`);

proc.kill(); console.log(fails ? fails + ' FAILURES' : 'PUSH TESTS PASSED'); process.exit(fails ? 1 : 0);
