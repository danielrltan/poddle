// Strike at the paddle (NOTES 265, STRIKE_WAIT): a human's rally swing whose ball is in the box but still coming meets it at the contact plane
// (CONTACT 0.25 m in front of the paddle) instead of up to 1.6 m out, and a settled report that arrives meanwhile folds into the swing, so the
// strike is final: a smash is struck (and curls) at contact, a tap is a tap, and nothing is re-aimed after. A later settled report still re-aims,
// with the same smooth bend (NOTES 154). Two servers side by side, the same scripted swings: STRIKE_WAIT=1 (production) and STRIKE_WAIT=0 (today's
// model, the rollback). Also: reach is judged when the swing came and kept (a wide ball the settled report's smaller n would no longer reach), an
// early swing waits past the window it came with and never whiffs for it, and /api/swingtime counts it all per paddle type. And the ways a wait
// could go wrong (round 1 of the review): a paddle that backs off a slow ball is struck where the ball is, inside the box, never pulled back
// in time; a paddle that leaves the ball sideways is not struck beside it; a ball falling to its second bounce before the plane is struck on
// the last tick above the floor, so the wait never loses the point to a double bounce.
// NOTES 266: only a BET is held, for its settled report, and at most WAIT_CAP (0.06 s) from when it first had its ball; a settled report
// strikes at once. Server A runs WAIT_CAP=0.5 (a bet whose report is late still waits for the plane: 265's mechanics stay tested), server C
// the default cap. SW_PLANS=a,b runs only those plans.
//   TEST_PORT=<port> node test/strikewait.test.mjs        (ports TEST_PORT .. TEST_PORT + 2)
import { spawn } from 'child_process';
import WebSocket from 'ws';
const PORT = +process.env.TEST_PORT || 9560, root = new URL('..', import.meta.url).pathname, KEY = 'strikewait-test-key', SECS = +process.env.SW_S || 120;
const wait = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
const f2 = x => (Number.isFinite(x) ? x.toFixed(2) : '-'), f0 = x => (Number.isFinite(x) ? x.toFixed(0) : '-');
const q = (a, p) => { const b = a.filter(Number.isFinite).sort((x, y) => x - y); return b.length ? b[Math.min(b.length - 1, Math.floor(p * (b.length - 1) + 1e-9))] : NaN; };
const CAP = 60;                                                              // ms: server/game.js WAIT_CAP's default
const procs = [0, 1, 2].map(k => spawn('node', ['server/game.js'], { cwd: root, env: { ...process.env, PORT: String(PORT + k), AUTOBOT: '0', SWING_SERVE: '0', WIN_AT: '0', BLOCK: '0', STATS_KEY: KEY, STRIKE_WAIT: k === 1 ? '0' : '1', WAIT_CAP: k === 0 ? '0.5' : '' }, stdio: ['ignore', 'ignore', 'inherit'] }));
await wait(800);
// What A does with each ball, in turn. at: when it swings (m in front of its paddle, the ball coming). settled: the settled report, `after` ms
// after the swing (real clients: 60-250 ms, p50 ~100). dx: the paddle held this far to the side of the ball once it swings.
const PLANS0 = [
  { name: 'fold smash', at: [1.15, 1.45], bet: { power: 33, dir: 0.5 }, settled: { power: 34, dir: 0.6 }, after: 30 },
  { name: 'fold tap', at: [1.15, 1.45], bet: { power: 33, dir: 0 }, settled: { power: 8, dir: 0.1 }, after: 30 },
  { name: 'settled after contact', at: [0.9, 1.1], bet: { power: 22, dir: 0.2 }, settled: { power: 18, dir: -0.5 }, after: 230 },
  { name: 'wide ball', at: [1.15, 1.45], dx: 1.6, bet: { power: 33, dir: 0 }, settled: { power: 10, dir: 0 }, after: 30 },
  { name: 'early swing', at: [2.9, 3.3], bet: { power: 33, dir: -0.3 }, settled: { power: 30, dir: -0.3 }, after: 60 },
  // B lobs (5-6 m/s along the court) and A leans back to z 8.8 as it swings: its paddle backs off (FOOT_SPEED 7) faster than the ball comes
  { name: 'retreat', at: [1.3, 1.6], feed: { power: 18, lob: 0.75, dir: 0 }, leanAfter: 8.8, bet: { power: 22, dir: 0.2 }, settled: { power: 20, dir: 0.2 }, after: 100 },
  // the paddle goes 2.5 m off the ball once it swings: past the reach it had (ZONE.x 1.15 + REACH_X 1.0 * n ~ 1.6)
  { name: 'drift off', at: [1.15, 1.45], dx: 2.5, bet: { power: 22, dir: 0 }, settled: { power: 22, dir: 0 }, after: 400 },
  // A stands back (lean z 8.8) and swings at a hard slice (it skids: a low bounce) already past its bounce and falling: it reaches the floor
  // before the plane (the review's probe lost 5 of 31 such swings to a double bounce, all on this feed)
  { name: 'falling', at: [1.1, 1.5], z: 8.8, falling: true, feed: { power: 16, slice: 0.9, dir: -0.2 }, bet: { power: 16, dir: 0 }, settled: { power: 16, dir: 0 }, after: 100 },
];
const PLANS = process.env.SW_PLANS ? PLANS0.filter(p => process.env.SW_PLANS.split(',').includes(p.name)) : PLANS0;
const ORIG = ['fold smash', 'fold tap', 'settled after contact', 'wide ball', 'early swing'];
function court(port) {
  const shots = [], log = { port }; let k = 0, skip = 0;          // k: A's next plan (B feeds for it)
  function player(me) {
    const ws = new WebSocket('ws://localhost:' + port), P = { ws, side: null }; let cool = 0, cur = null, padZ = 6.5, fk = 0, last = null, passed = false;
    const send = o => ws.readyState === 1 && ws.send(JSON.stringify(o));
    const live = () => cur && !cur.hit && !cur.whiff && !cur.lost;
    ws.on('message', raw => { const m = JSON.parse(raw), now = performance.now();
      if (m.type === 'welcome') P.side = m.side;
      if (P.side == null) return;
      const s = P.side === 0 ? 1 : -1;
      if (me && cur && m.type === 'hit' && m.side === P.side && !cur.hit) { cur.hit = m; cur.lat = now - cur.sentAt; cur.ahead = -(m.p[2] - padZ) * s; cur.back = last ? (last.p[2] - m.p[2]) * s : 0; cur.padX = cur.lastPadX; }
      if (me && cur && m.type === 'launch' && m.by === P.side && cur.hit) cur.launches.push({ ...m, dt: now - cur.sentAt - cur.lat });
      if (me && cur && m.type === 'whiff' && !cur.hit) cur.whiff = m.why || 'whiff';
      if (me && m.type === 'point' && cur && !cur.hit && now - cur.sentAt < 1500) { cur.point = m.why; if (m.winner !== P.side) cur.lost = m.why; }
      if (me && m.type === 'launch' && m.by !== P.side) passed = false;
      if (m.type !== 'state') return;
      const pd = m.paddles[P.side], mine = m.live && m.serving == null && m.v[2] * s > 0; if (pd) padZ = pd.z; if (me) last = m;
      const next = PLANS[k % PLANS.length], plan = me && live() ? cur.plan : null;
      const x = mine ? m.p[0] + (plan && plan.dx ? plan.dx : 0) : 0, z = !me ? 6.5 : plan ? plan.leanAfter || plan.z || 6.5 : next.z || 6.5;
      if (plan) cur.lastPadX = x;
      send({ type: 'paddle', x, y: mine ? Math.max(0.4, Math.min(1.4, m.p[1])) : 1, z, q: [0, 0, 0, 1] });
      if (!mine || !pd || now < cool) return;
      const ahead = -(m.p[2] - pd.z) * s;
      if (!me) { if (ahead < 1.0) { cool = now + 500; const f = next.feed; send({ type: 'swing', power: f ? f.power : [16, 10, 22][fk++ % 3], dir: f ? f.dir : -0.2, lob: f ? f.lob || 0 : 0, slice: f ? f.slice || 0 : 0, final: true, src: 'airpod' }); } return; }   // B feeds: drives of three speeds, or what A's next plan needs
      if (ahead < next.at[0] && !passed) { passed = true; if (++skip >= 4) { skip = 0; k++; log.skipped = (log.skipped || 0) + 1; } }   // this ball never gave the plan its swing: after 4 such, move on
      if (ahead > next.at[1] || ahead < next.at[0]) return;
      if (next.falling && !(m.b >= 1 && m.v[1] < 0)) return;
      k++; skip = 0; cool = now + 600;
      cur = { plan: next, sentAt: now, eta: (ahead - 0.25) / Math.abs(m.v[2]) * 1000, vz: Math.abs(m.v[2]), launches: [] }; shots.push(cur);
      send({ type: 'swing', lob: 0, age: 60, net: 1, src: 'airpod', ...next.bet, final: false });
      setTimeout(() => send({ type: 'swing', lob: 0, src: 'airpod', ...next.settled, fix: true, final: true }), next.after); });
    return P;
  }
  log.A = player(true);
  return wait(300).then(() => { log.B = player(false); return { shots, log }; });
}
const [ON, OFF, CAPPED] = await Promise.all([court(PORT), court(PORT + 1), court(PORT + 2)]);
await wait(SECS * 1000);
const report = async port => { try { const r = await fetch(`http://localhost:${port}/api/swingtime`, { headers: { Authorization: 'Bearer ' + KEY } }); return r.ok ? r.json() : { status: r.status }; } catch (e) { return { err: String(e) }; } };
const [RON, ROFF, RCAP] = await Promise.all([report(PORT), report(PORT + 1), report(PORT + 2)]);
const noKey = await fetch(`http://localhost:${PORT}/api/swingtime`).then(r => r.status).catch(() => 0);
for (const c of [ON, OFF, CAPPED]) { c.log.A.ws.close(); c.log.B.ws.close(); }
procs.forEach(p => p.kill());

const by = (c, name) => c.shots.filter(s => s.plan.name === name && (s.hit || s.whiff || s.lost));
const reaims = s => s.launches.filter(l => l.n != null);
const told = s => s.launches.filter(l => l.land);
for (const [c, tag] of [[ON, 'STRIKE_WAIT=1 WAIT_CAP=0.5'], [OFF, 'STRIKE_WAIT=0'], [CAPPED, 'STRIKE_WAIT=1 (WAIT_CAP default)']]) console.log(`  ${tag}: ${c.shots.length} swings: ` + PLANS.map(p => `${p.name} ${by(c, p.name).filter(s => s.hit).length} hit / ${by(c, p.name).filter(s => s.whiff).length} whiff`).join(', ') + (c.log.skipped ? `; ${c.log.skipped} plans skipped` : ''));
ok(PLANS.every(p => by(ON, p.name).length >= 2 && by(OFF, p.name).length >= 2), 'every plan came round at least twice on both servers');

// ---- with the wait (production) ----
const atPlane = s => s.hit && Math.abs(s.ahead - 0.25) <= s.vz / 60 / 2 + 0.06;      // within half a tick's travel of CONTACT (+ the paddle's own step)
const waitable = [ON, CAPPED].flatMap(c => c.shots.filter(s => s.hit && ['fold smash', 'fold tap', 'wide ball'].includes(s.plan.name)));
const inReach = waitable.filter(s => s.plan.name !== 'wide ball');          // the wide ball is out of reach until the ball comes to it (as with STRIKE_WAIT=0)
ok(inReach.length >= 8 && inReach.every(s => s.lat >= s.plan.after - 2 && s.lat < s.plan.after + 14 && s.ahead > 0.25), `a bet whose settled report comes 30 ms later is struck on that report, before the plane (NOTES 266): swing -> hit ${inReach.map(s => f0(s.lat)).join(', ')} ms, ${inReach.map(s => f2(s.ahead)).join(', ')} m out; the wide ball ${waitable.filter(s => s.plan.name === 'wide ball').map(s => f0(s.lat)).join(', ')} ms`);
const LA = by(ON, 'settled after contact').filter(s => s.hit);
ok(LA.length >= 2 && LA.every(atPlane), `...one whose report is late waits for the plane under a long cap (WAIT_CAP 0.5): ${LA.map(s => f2(s.ahead)).join(', ')} m out (CONTACT 0.25)`);
const S1 = by(ON, 'fold smash').filter(s => s.hit), T1 = by(ON, 'fold tap').filter(s => s.hit);
ok(S1.length >= 2 && S1.every(s => !s.hit.bet && s.hit.kind === 'smash' && s.hit.n > 0.9 && Math.abs(+s.hit.c || 0) > 0), `a settled report in before contact strikes at its own power: a smash at contact (${S1.map(s => s.hit.kind + ' n ' + f2(s.hit.n) + ' c ' + f2(+s.hit.c || 0)).join(', ')}), curling from contact, never flagged a bet`);
ok(T1.length >= 2 && T1.every(s => !s.hit.bet && s.hit.kind === 'tap' && s.hit.n < 0.1), `...a bet of 33 that settles at 8 is a tap at contact (${T1.map(s => s.hit.kind + ' n ' + f2(s.hit.n)).join(', ')})`);
ok(S1.concat(T1).every(s => reaims(s).length === 0 && told(s).length === 1 && told(s)[0].dt < 30), `...nothing to re-aim: one landing, told with the hit (re-aims ${S1.concat(T1).map(s => reaims(s).length).join('')}, landing ${S1.concat(T1).map(s => f0(told(s)[0] && told(s)[0].dt)).join(', ')} ms after it)`);
const L1 = by(ON, 'settled after contact').filter(s => s.hit);
ok(L1.length >= 2 && L1.every(s => s.hit.bet && reaims(s).length === 1 && reaims(s)[0].w && told(s).length === 1), `a settled report that comes after contact still re-aims, once, with its bend (w) and one landing (${L1.map(s => f0(reaims(s)[0] && reaims(s)[0].dt) + ' ms').join(', ')} after the hit)`);
const W1 = by(ON, 'wide ball');
ok(W1.length >= 2 && W1.every(s => s.hit), `a wide ball the swing reached when it came is still met at the plane after its settled report shrank the reach (${W1.filter(s => s.hit).length} hits, ${W1.filter(s => s.whiff).length} whiffs; paddle 1.6 m off the ball, reach 1.29 m at the settled n)`);
const E1 = by(ON, 'early swing');
ok(E1.length >= 2 && E1.every(s => s.hit), `an early swing (ball ~3 m out, settled before the ball is in the box) never whiffs for its window and is struck when its ball comes: swing -> hit ${E1.map(s => f0(s.lat)).join(', ')} ms (the window it came with: 387 ms), met ${E1.map(s => f2(s.ahead)).join(', ')} m out`);

// ---- where a wait could go wrong ----
const R1 = by(ON, 'retreat'), R0 = by(OFF, 'retreat').filter(s => s.hit);
ok(R1.length >= 2 && R1.every(s => s.hit && s.ahead < 1.6 && s.back < 0.02 && s.lat < 150), `a paddle that backs off a slow ball is struck where the ball is, inside the box and never pulled back: ${R1.map(s => s.hit ? f2(s.ahead) + ' m out, back ' + f2(s.back) + ', ' + f0(s.lat) + ' ms' : 'whiff').join('; ')} (was 2.16 m out, pulled back 0.57 m)`);
ok(R0.length >= 2 && R0.every(s => s.back < 0.02), `...as with STRIKE_WAIT=0, struck on arrival (${R0.map(s => f2(s.ahead)).join(', ')} m out)`);
const D1 = by(ON, 'drift off'), D0 = by(OFF, 'drift off');
ok(D1.length >= 2 && D1.every(s => !s.hit || Math.abs(s.hit.p[0] - s.padX) < 1.7), `a paddle that leaves its ball (2.5 m to the side once it swings) is not struck beside it: ${D1.map(s => s.hit ? 'hit ' + f2(s.hit.p[0] - s.padX) + ' m off' : s.whiff || s.lost).join(', ')}`);
ok(D0.length >= 2 && D0.every(s => s.hit && s.lat < 12), `...STRIKE_WAIT=0 strikes it on arrival, before the paddle moves (${D0.filter(s => s.hit).length} hits)`);
const F1 = by(ON, 'falling'), F0 = by(OFF, 'falling'), early = F1.filter(s => s.hit && s.ahead > 0.45);
ok(F1.length >= 3 && F1.every(s => s.hit && !s.lost), `a swing at a ball falling to its second bounce never loses the point waiting: ${F1.filter(s => s.hit).length} hit, ${F1.filter(s => s.lost).length} lost (${F1.filter(s => s.lost).map(s => s.lost).join(', ')}), met ${F1.filter(s => s.hit).map(s => f2(s.ahead)).join(', ')} m out; ${early.length} struck before the plane because the floor came first`);
ok(F0.every(s => s.hit), `...STRIKE_WAIT=0 too (${F0.filter(s => s.hit).length} of ${F0.length})`);

// ---- the cap (NOTES 266): an in-box swing is held at most WAIT_CAP after it arrives ----
const inBox = CAPPED.shots.filter(s => s.hit && ['fold smash', 'fold tap', 'settled after contact'].includes(s.plan.name));
ok(inBox.length >= 6 && inBox.every(s => s.lat <= CAP + 2 * 1000 / 60 + 8), `with the cap, a swing at a ball in the box strikes within ${CAP} ms (+ two ticks) of arriving: ${inBox.map(s => s.plan.name + ' ' + f0(s.lat)).join(', ')} ms`);
const SC = by(CAPPED, 'fold smash').filter(s => s.hit);
ok(SC.length >= 2 && SC.every(s => !s.hit.bet && s.hit.kind === 'smash'), `...a settled report 30 ms after the swing still folds in before contact (${SC.map(s => s.hit.kind + (s.hit.bet ? ' bet' : '')).join(', ')})`);
const EC = by(CAPPED, 'early swing');
ok(EC.length >= 2 && EC.every(s => s.hit), `...an early swing (ball ~3 m out) is struck when its ball comes into the box, as with STRIKE_WAIT=0 (${EC.map(s => s.hit ? f2(s.ahead) + ' m out' : s.whiff).join(', ')})`);
ok(RCAP.mode && RCAP.mode.waitCap === CAP / 1000 && RON.mode && RON.mode.waitCap === 0.5, `/api/swingtime says which cap runs (${RCAP.mode && RCAP.mode.waitCap} / ${RON.mode && RON.mode.waitCap})`);

// ---- today's model (the rollback) ----
const S0 = by(OFF, 'fold smash').filter(s => s.hit), T0 = by(OFF, 'fold tap').filter(s => s.hit);
ok(S0.concat(T0).length >= 4 && S0.concat(T0).every(s => s.hit.bet && s.lat < 12 && s.ahead > 0.8), `STRIKE_WAIT=0: the same swings strike at once on the bet (${S0.concat(T0).map(s => f0(s.lat) + ' ms, ' + f2(s.ahead) + ' m out').join('; ')})`);
ok(S0.every(s => reaims(s).length === 1 && reaims(s)[0].kind === 'smash') && T0.every(s => reaims(s).length === 1 && reaims(s)[0].kind === 'tap'), '...and their settled reports re-aim them (the smash announced on the re-aim, the tap too)');
const share = c => { const h = c.shots.filter(s => s.hit && ORIG.includes(s.plan.name)); return h.filter(s => reaims(s).length).length / (h.length || 1); };
const reDt = c => q(by(c, 'settled after contact').filter(s => s.hit && reaims(s).length).map(s => reaims(s)[0].dt), 0.5);     // the same report, sent 230 ms after the swing
ok(share(ON) < share(OFF) - 0.3 && reDt(ON) < reDt(OFF) - 40, `fewer and earlier re-aims with the wait: ${f2(share(ON))} of hits re-aimed against ${f2(share(OFF))}; a settled report sent 230 ms after the swing re-aims p50 ${f0(reDt(ON))} ms after the hit, against ${f0(reDt(OFF))} ms`);

// ---- the counts (/api/swingtime): per paddle type, nothing about anyone ----
const a = RON.src && RON.src.airpod, b = ROFF.src && ROFF.src.airpod;
ok(noKey === 401 && RON.mode && RON.mode.strikeWait === true && ROFF.mode && ROFF.mode.strikeWait === false, `GET /api/swingtime answers the stats key only (no key: ${noKey}) and says which model runs (${RON.mode && RON.mode.strikeWait} / ${ROFF.mode && ROFF.mode.strikeWait})`);
ok(a && a.strikes >= ON.shots.filter(s => s.hit).length && a.waited >= 1 && a.folded > 0 && a.reaimed >= L1.length && a.windowEnd <= by(ON, 'retreat').length, `with the wait: ${a && a.strikes} strikes (B's included), ${a && a.waited} waited, ${a && a.folded} settled before contact, ${a && a.reaimed} re-aimed, ${a && a.windowEnd} window ends (the retreats', struck where the ball is), ${a && a.whiffs} whiffs`);
ok(a && a.hist.waitMs.n > 0 && a.hist.aheadCm.n > 0 && a.hist.settledMs.n > 0 && a.hist.betMs.p50 < 0, `...wait p50 ${a && a.hist.waitMs.p50} ms, struck p50 ${a && a.hist.aheadCm.p50} cm out, the bet p50 ${a && a.hist.betMs.p50} ms and the settled report p50 ${a && a.hist.settledMs.p50} ms after the ball at the plane`);
ok(a && a.lostWaiting === 0, `no swing lost its point while waiting (lostWaiting ${a && a.lostWaiting}; lost in all ${a && a.lost})`);
ok(b && b.waited === 0 && b.reaimed > 0 && b.hist.settledMs.under0 > 0, `without it: ${b && b.waited} waited, ${b && b.reaimed} re-aimed, and the settled reports that would have folded in at the plane are counted (${b && b.hist.settledMs.under0} of them)`);
ok(!JSON.stringify(RON).match(/"(name|cid|side|code|ip|user)"/i), 'the counts carry no name, seat, court or id');
console.log(fails ? fails + ' FAILURES' : 'STRIKEWAIT TESTS PASSED'); process.exit(fails ? 1 : 0);
