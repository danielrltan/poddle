// Serve feel: the ball hangs and follows late, only a real swing that meets it serves, twitches and the other player never do,
// and the wind-up before a serve is not the serve (docs/NEXT.md 4).   TEST_PORT=<port> moves it.
import { spawn } from 'child_process';
import WebSocket from 'ws';
const PORT = +process.env.TEST_PORT || 8151, root = new URL('..', import.meta.url).pathname;
const proc = spawn('node', ['server/game.js'], { cwd: root, env: { ...process.env, PORT, AUTOBOT: '0', SWING_SERVE: '1', BLOCK: '0', WIN_AT: '0' } });
const wait = ms => new Promise(r => setTimeout(r, ms));
await wait(700);
let fails = 0, bad = 0, states = 0;
const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
const log = [], T0 = Date.now(), t = () => (Date.now() - T0) / 1000;      // every non-state event, timestamped
let st = null;                                                           // latest state
const onState = [];
function client(name) {
  const ws = new WebSocket('ws://localhost:' + PORT), c = { ws, name, side: null, whiffs: 0 };
  ws.on('message', raw => { const m = JSON.parse(raw);
    if (m.type === 'welcome') c.side = m.side;
    if (m.type === 'whiff') c.whiffs++;
    if (m.type === 'state') { if (name !== 'A') return; st = m; states++;
      const nums = [...m.p, ...m.v, ...m.score, ...m.paddles.flatMap(p => (p ? [p.x, p.y, p.z, ...p.q] : []))];
      if (!nums.every(Number.isFinite) || typeof m.reach !== 'boolean') bad++;
      for (const f of onState) f(m, t());
    } else if (name === 'A' && m.type !== 'welcome' && m.type !== 'botinfo') log.push({ at: t(), ...m }); });
  c.send = m => ws.send(typeof m === 'string' ? m : JSON.stringify(m));
  return c;
}
const A = client('A'); await wait(200); const B = client('B');
const until = async (f, ms, what) => { const end = Date.now() + ms; while (Date.now() < end) { if (f()) return true; await wait(10); } ok(false, 'timed out waiting for ' + what); return false; };
const since = (at, type) => log.filter(e => e.at >= at && (!type || e.type === type));
const swings = (c, powers, ms) => { let i = 0; const id = setInterval(() => c.send({ type: 'swing', power: powers[i++ % powers.length], dir: 0.5, lob: 0.1 }), ms); return () => clearInterval(id); };

await until(() => st && st.serving === 0, 4000, "side 0's first serve");
ok(A.side === 0 && B.side === 1, 'A is side 0, B is side 1');
const tServe = t(); let onOwnHalf = true;
onState.push(m => { if (m.serving === 0 && !(m.p[2] > 0.9)) onOwnHalf = false; if (m.serving === 1 && !(m.p[2] < -0.9)) onOwnHalf = false; });
const stopB = swings(B, [30, 22, 34], 90);                                // the receiver swings hard the whole time
await wait(400);
const p0 = [...st.p];
ok(st.reach === true && Math.abs(p0[0] - st.paddles[0].x) < 0.2 && p0[2] < st.paddles[0].z, `ball spawns in front of the server, in reach: p=${p0.map(v => v.toFixed(2))} paddle z=${st.paddles[0].z.toFixed(2)}`);

// 1. inside the slack: the ball does not move at all (y only bobs)
A.send({ type: 'paddle', x: 0.3, y: 1.15, q: [0, 0, 0, 1] });
let drift = 0, bobMax = 0; const f1 = m => { drift = Math.max(drift, Math.abs(m.p[0] - p0[0]), Math.abs(m.p[2] - p0[2])); bobMax = Math.max(bobMax, Math.abs(m.p[1] - 1.1)); };
onState.push(f1); await wait(900); onState.splice(onState.indexOf(f1), 1);
ok(drift < 0.005, `server moved 0.30 m sideways + 0.15 m up (inside the slack): ball drifted ${(drift * 1000).toFixed(1)} mm`);
ok(bobMax > 0.02 && bobMax < 0.06, `it bobs gently: +-${bobMax.toFixed(3)} m`);

// 2. jump 2 m sideways: the ball follows late. Twitches (power 6-10) while moving never serve; a real swing at air does nothing.
const x0 = st.p[0], tJump = t(), track = [];
const f2 = (m, at) => track.push([at - tJump, m.p[0], m.v[0], m.reach]); onState.push(f2);
A.send({ type: 'paddle', x: 2.3, y: 1.15, q: [0, 0, 0, 1] });
const stopWeak = swings(A, [6, 8, 10, 9.5, 7, 10.9, 'x', null, -50], 50);
await wait(150);
const farReach = st.reach, farDx = st.paddles[0].x - st.p[0];
A.send({ type: 'swing', power: 24, dir: 0, lob: 0 }); await wait(60); A.send({ type: 'swing', power: 1e308, dir: 0, lob: 0 }); A.send('{"type":"swing","power":1e999}'); A.send('nonsense');
await wait(2600); stopWeak(); onState.splice(onState.indexOf(f2), 1);
const xEnd = track[track.length - 1][1], span = xEnd - x0, when = f => (track.find(r => (r[1] - x0) / span >= f) || [NaN])[0];
const at100 = (track.find(r => r[0] >= 0.1)[1] - x0) / span, t63 = when(0.63), t90 = when(0.9);
const vPeak = Math.max(...track.map(r => r[2])), lagMax = Math.max(...track.map(r => 2.35 - r[1]));
let vErr = 0; for (let i = 5; i < track.length; i++) { const dt = track[i][0] - track[i - 5][0]; if (dt > 0.05) vErr = Math.max(vErr, Math.abs((track[i][1] - track[i - 5][1]) / dt - (track[i][2] + track[i - 5][2]) / 2)); }
ok(farReach === false && farDx > 1.5, `0.15 s after the jump the ball is ${farDx.toFixed(2)} m from the paddle and state.reach=false`);
ok(at100 < 0.1, `not 1:1: 0.1 s after a 2 m jump the ball has covered ${(at100 * 100).toFixed(1)} % (paddle: 100 %)`);
ok(t63 > 0.4 && t63 < 1.0 && t90 > 0.8 && t90 < 1.5, `follow lag: 63 % at ${t63.toFixed(2)} s, 90 % at ${t90.toFixed(2)} s (want 0.4-1.0 / 0.8-1.5)`);
ok(span > 1.6 && span < 2.31 && lagMax > 1.5, `it ends up back in front of the server: moved ${span.toFixed(2)} m of 2.30, max lag ${lagMax.toFixed(2)} m, no overshoot`);
ok(vPeak > 0.8 && vPeak < 3.5 && vErr < 0.6, `state.v is the real drift: peak ${vPeak.toFixed(2)} m/s, worst mismatch vs measured ${vErr.toFixed(2)} m/s`);
ok(st.serving === 0 && st.reach === true, 'still serving after all that, and back in reach');
ok(since(tServe, 'hit').length === 0 && since(tServe, 'launch').length === 0 && since(tServe, 'point').length === 0 && A.whiffs + B.whiffs === 0,
  `~${Math.round((t() - tJump) * 20)} twitch swings (power 6-10.9, junk) + 2 real swings at air + ${Math.round((t() - tServe) / 0.09)} receiver swings: hits ${since(tServe, 'hit').length}, launches ${since(tServe, 'launch').length}, points ${since(tServe, 'point').length}, whiffs ${A.whiffs + B.whiffs}`);
ok(since(tServe, 'swung').filter(e => e.side === 0).length === 2, `only the 2 real swings animate (swung x${since(tServe, 'swung').filter(e => e.side === 0).length}); the twitches were dropped silently`);

// 3. a relaxed real swing (power 14) with the ball in reach serves it: over the net, lands in.
// NEW RULE (NEXT 4): a lone middling swing might be a wind-up, so it is held 0.7 s first; and a serve never carries less than n 0.35 (was: struck at once, n = 8/28)
stopB(); await wait(1500);                                               // let the receiver's last swing window run out, and side 0's last twitch be more than 1.2 s ago
let tHit = t(), netY = null, prev = null; const f3 = m => { if (prev && prev.p[2] > 0 && m.p[2] <= 0 && m.live) netY = m.p[1]; prev = m; }; onState.push(f3);
A.send({ type: 'swing', power: 14, dir: 0.4, lob: 0 });
await until(() => since(tHit, 'bounce').length, 5000, 'the serve to land');
let hit = since(tHit, 'hit')[0], launch = since(tHit, 'launch')[0], b = since(tHit, 'bounce')[0];
ok(hit && hit.side === 0 && Math.abs(hit.n - 0.35) < 1e-6 && hit.kind === 'drive', `served by the swing, at the serve floor: ${JSON.stringify(hit)}`);
ok(hit && hit.at - tHit > 0.6 && hit.at - tHit < 0.9 && since(tHit, 'swung')[0].at - tHit < 0.1, `held in case it was a wind-up: swung at once, struck ${hit && (hit.at - tHit).toFixed(2)} s later`);
ok(launch && launch.by === 0 && launch.land[1] < 0 && launch.land[0] > 0.5, `launch uses the swing's dir: land=${launch && launch.land.map(v => v.toFixed(2))}`);
ok(netY > 0.91 + 0.11, `clears the net: y=${netY && netY.toFixed(2)} at z=0`);
ok(b && b.p[2] < -0.5 && b.p[2] > -6.8 && Math.abs(b.p[0]) < 3.15, `lands in: ${b && b.p.map(v => v.toFixed(2))}`);
await until(() => since(tHit, 'point').length, 6000, 'the point'); onState.splice(onState.indexOf(f3), 1);
ok(since(tHit, 'point')[0].winner === 0, 'unreturned serve wins the point: ' + JSON.stringify(since(tHit, 'point')[0]));

// 4. side 1 never swings properly: side 0 hammering away changes nothing, and the timeout serve still comes
await until(() => st.serving === 1, 4000, "side 1's serve");
const tS1 = t(), stopA = swings(A, [30, 20], 80), stopW = swings(B, [6, 9, 10], 70);
B.send({ type: 'paddle', x: -1.5, y: 1.0, q: [0, 0, 0, 1] });
await wait(7000); stopA();
ok(st.serving === 1 && since(tS1, 'hit').length === 0 && since(tS1, 'launch').length === 0, `7 s of the other player swinging at power 30 + the server twitching: still waiting, hits ${since(tS1, 'hit').length}`);
ok(Math.abs(st.p[0] - -1.55) < 0.45 && st.reach, `ball drifted over to the server at x=-1.5: ball x=${st.p[0].toFixed(2)}`);
await until(() => since(tS1, 'launch').length, 4000, 'the timeout serve'); stopW();
const tl = since(tS1, 'launch')[0];
ok(tl && tl.by === 1 && tl.at - tS1 > 8.5 && tl.at - tS1 < 9.8 && tl.land[1] > 0, `timeout serve after ${(tl.at - tS1).toFixed(2)} s, lands on side 0 at ${tl.land.map(v => v.toFixed(2))}`);
await until(() => since(tS1, 'point').length, 8000, 'the point');

// side 0's serve, the ball in reach, and side 0 quiet for longer than a wind-up reaches back (1.2 s). Side 1's serves in between go unreturned.
async function myServe() {
  await until(() => st.serving != null, 6000, 'next serve');
  if (st.serving === 1) { const t1 = t(); await wait(300); B.send({ type: 'swing', power: 30, dir: 0, lob: 0 }); await until(() => since(t1, 'point').length, 9000, 'side 1 point'); await until(() => st.serving === 0, 4000, 'side 0 serve'); }
  await until(() => st.reach, 3000, 'the ball in reach'); await wait(1400); return t();
}
const hitsSince = at => since(at, 'hit').filter(e => e.side === 0), done = at => until(() => since(at, 'point').length, 9000, 'the point');

// 5. serves go through the normal shot maths: an underhand scoop is a lob.
// NEW RULE (NEXT 4, serve floor): the soft underhand serve (power 11.2) used to be a dink that dropped IN the kitchen; a serve now carries n >= 0.35, so it is a short lob that lands past it
for (const [power, lob, kind] of [[30, 0.8, 'lob'], [11.2, 0.8, 'lob']]) {
  tHit = await myServe(); A.send({ type: 'swing', power, dir: -0.3, lob });
  await until(() => since(tHit, 'bounce').length, 6000, kind + ' serve to land');
  hit = since(tHit, 'hit')[0]; b = since(tHit, 'bounce')[0];
  ok(hit && hit.kind === kind && hit.n >= 0.35 && b && b.p[2] < -2.13 && b.p[2] > -6.8 && Math.abs(b.p[0]) < 3.15, `power ${power} underhand serve: kind=${hit && hit.kind} n=${hit && hit.n.toFixed(2)}, lands past the kitchen at ${b && b.p.map(v => v.toFixed(2))}`);
  await done(tHit);
}

// 6. the wind-up is not the serve (NEXT 4). Recorded: wind-up then stroke 0.4-0.9 s apart, 27 of 30 the other way, wind-up power up to 21.
let t6 = await myServe(); A.send({ type: 'swing', power: 8, dir: 0.5, lob: 0 }); await wait(1500);
ok(hitsSince(t6).length === 0 && since(t6, 'swung').length === 0 && st.serving === 0, 'twitch 8: nothing at all, still serving');
t6 = t(); A.send({ type: 'swing', power: 28, dir: 0.5, lob: 0 }); await until(() => hitsSince(t6).length, 1000, 'a lone 28');
ok(hitsSince(t6).length === 1 && hitsSince(t6)[0].at - t6 < 0.1 && Math.abs(hitsSince(t6)[0].n - 22 / 28) < 1e-6, `lone stroke 28: struck at once (${hitsSince(t6)[0] && (hitsSince(t6)[0].at - t6).toFixed(3)} s), n ${hitsSince(t6)[0] && hitsSince(t6)[0].n.toFixed(3)}`);
await done(t6);

t6 = await myServe(); A.send({ type: 'swing', power: 15, dir: 1, lob: 0 }); await wait(600);
const none = hitsSince(t6).length, tStroke = t(); A.send({ type: 'swing', power: 28, dir: -1, lob: 0 }); await wait(1200);
let h6 = hitsSince(t6), l6 = since(t6, 'launch');
ok(none === 0 && h6.length === 1 && Math.abs(h6[0].n - 22 / 28) < 1e-6 && h6[0].at - tStroke < 0.1, `wind-up 15 (dir +1), stroke 28 (dir -1) 0.6 s later: ONE hit, n ${h6[0] && h6[0].n.toFixed(3)} is the stroke's, ${h6[0] && (h6[0].at - tStroke).toFixed(3)} s after it (hits ${h6.length}, ${none} before the stroke)`);
ok(l6.length === 1 && l6[0].land[0] < -0.5 && since(t6, 'swung').filter(e => e.side === 0).length === 2, `and it goes where the stroke aimed: land x ${l6[0] && l6[0].land[0].toFixed(2)} (dir -1 from side 0), both swings animate`);
await done(t6);

t6 = await myServe(); A.send({ type: 'swing', power: 15, dir: 0.5, lob: 0 }); await until(() => hitsSince(t6).length, 1500, 'a lone 15');
h6 = hitsSince(t6); ok(h6.length === 1 && h6[0].at - t6 > 0.6 && h6[0].at - t6 < 0.9 && Math.abs(h6[0].n - 0.35) < 1e-6, `lone stroke 15: struck ${h6[0] && (h6[0].at - t6).toFixed(2)} s later (want ~0.7), n ${h6[0] && h6[0].n.toFixed(3)} (9/28 lifted to the serve floor)`);
await done(t6);

t6 = await myServe(); A.send({ type: 'swing', power: 20, dir: 0.5, lob: 0 }); await wait(300); A.send({ type: 'swing', power: 12, dir: 0.4, lob: 0 }); await until(() => hitsSince(t6).length, 1500, 'the held 20');
h6 = hitsSince(t6); ok(h6.length === 1 && h6[0].at - t6 > 0.6 && h6[0].at - t6 < 0.9 && Math.abs(h6[0].n - 0.5) < 1e-6, `20, then a weaker 12 the same way: the 12 changes nothing, the 20 serves at ${h6[0] && (h6[0].at - t6).toFixed(2)} s with n ${h6[0] && h6[0].n.toFixed(2)}`);
await done(t6);

// the client reports a swing early and corrects it (fix): a correction belongs to its own swing, it is never "the stroke after the wind-up"
t6 = await myServe(); A.send({ type: 'swing', power: 12, dir: 0.5, lob: 0 }); await wait(80); A.send({ type: 'swing', power: 13, dir: 0.5, lob: 0, fix: true }); await until(() => hitsSince(t6).length, 1500, 'the corrected 12');
h6 = hitsSince(t6); ok(h6.length === 1 && h6[0].at - t6 > 0.6 && h6[0].at - t6 < 0.9, `early call 12 corrected to 13: still held, struck ${h6[0] && (h6[0].at - t6).toFixed(2)} s after the swing`);
await done(t6);
t6 = await myServe(); A.send({ type: 'swing', power: 13, dir: 0.5, lob: 0 }); await wait(80); const tFix = t(); A.send({ type: 'swing', power: 28, dir: 0.5, lob: 0, fix: true }); await until(() => hitsSince(t6).length, 1500, 'the corrected 13');
h6 = hitsSince(t6); ok(h6.length === 1 && h6[0].at - tFix < 0.1 && Math.abs(h6[0].n - 22 / 28) < 1e-6 && since(t6, 'swung').length === 1, `early call 13 corrected to 28: that is no wind-up, struck at once with n ${h6[0] && h6[0].n.toFixed(3)}, one swing animated`);
await done(t6);
ok(onOwnHalf, "a hanging ball never left the server's half");
ok(bad === 0 && states > 1000, `${states} state packets, ${bad} with NaN/missing fields`);
ok(A.whiffs + B.whiffs === 0, `nobody was ever told they missed: whiffs A ${A.whiffs}, B ${B.whiffs}`);
A.ws.close(); B.ws.close(); proc.kill();
console.log(fails ? fails + ' FAILURES' : 'SERVE TESTS PASSED'); process.exit(fails ? 1 : 0);
