// The hardest flat drives curl in the air (NOTES 71): a constant sideways pull until the first bounce, so the ball leaves wide of
// its line, bows, and comes back onto its landing marker. Nothing else curls: a lob, a serve, a bet, a block, a soft drive.
// Part 1 (in process): solve() + the server's own integrator. Part 2 (live): real swings at a real server, and the client's
// coast() (web/scene.js) run between every pair of state packets, so a curled ball never snaps on screen.
//   TEST_PORT=<port> node test/curve.test.mjs
import { spawn } from 'child_process';
import { createRequire } from 'module';
import WebSocket from 'ws';
const PORT = +process.env.TEST_PORT || 8573, root = new URL('..', import.meta.url).pathname;
process.env.PORT = String(PORT + 2);                               // the in-process copy listens too: keep it off the live one
const require = createRequire(import.meta.url);
const S = require('../server/game.js');
const { coast } = await import('../web/scene.js');
const wait = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
const DT = 1 / 60, V = () => ({ x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } }), cP = V(), cV = V();

// ---------- part 1: solve() flown by the sim's own step ----------
function flyOut(p0, side, n, dir, lob, slice, curl) {
  const sol = S.solve(p0, side, n, dir, lob, slice, null, curl), p = [p0[0], Math.max(p0[1], S.R), p0[2]], v = [...sol.v], a = [...p];
  let bow = 0;
  for (let i = 0; i < 400; i++) {                                  // server/game.js sim(), flight part
    const c = sol.curl; v[0] += c * DT; v[1] -= S.gOf(sol.spin) * DT;
    for (let k = 0; k < 3; k++) p[k] += v[k] * DT; p[0] -= 0.5 * c * DT * DT;
    const f = (p[2] - a[2]) / (sol.land[1] - a[2]); bow = Math.max(bow, Math.abs(p[0] - (a[0] + (sol.land[0] - a[0]) * f)));
    if (p[1] < S.R) {
      const al = S.BOUNCE.along + (S.SLICE.along - S.BOUNCE.along) * sol.spin, up = S.BOUNCE.up + (S.SLICE.up - S.BOUNCE.up) * sol.spin;
      const ta = -v[1] * up / S.G, xc = p[0] + (v[0] * al + sol.kick) * ta;
      return { sol, err: Math.hypot(p[0] - sol.land[0], p[2] - sol.land[1]), ex: Math.abs(p[0] - sol.land[0]), bow, xc };
    }
  }
  return { sol, err: Infinity, ex: Infinity, bow, xc: Infinity };
}
{
  let worstX = 0, worstE = 0, minBow = Infinity, maxXc = 0, count = 0;
  for (const side of [0, 1]) for (const d of [1.7, 3, 4.5, 6.5, 8]) for (const x of [-3, -1, 0, 1, 3]) for (const dir of [-1, -0.4, 0, 0.6, 1]) for (const y of [0.4, 1, 1.8]) {
    const s = side ? -1 : 1, r = flyOut([x, y, s * d], side, 1, dir, 0, 0, 1), st = flyOut([x, y, s * d], side, 1, dir, 0, 0, 0); count++;
    worstX = Math.max(worstX, r.ex); worstE = Math.max(worstE, r.err - st.err); minBow = Math.min(minBow, r.bow); maxXc = Math.max(maxXc, Math.abs(r.xc));
    // lands: sideways within 0.1 m of the marker, and no further off in all than the same shot flown straight (a fast low ball lands up to
    // a tick, ~0.2 m, past its closed-form spot along the court whether it curls or not)
    if (!r.sol.curl || r.ex > 0.1 || r.err > st.err + 0.03 || r.bow < 0.3 || Math.abs(r.xc) > 3.25) { ok(false, `n 1 from ${[x, y, s * d]} side ${side} dir ${dir}: c ${r.sol.curl.toFixed(1)} bow ${r.bow.toFixed(2)} lands ${r.ex.toFixed(2)} m off sideways, ${r.err.toFixed(2)} in all (straight ${st.err.toFixed(2)}), top of bounce x ${r.xc.toFixed(2)}`); }
  }
  ok(true, `${count} full-power flat drives all curl: bow at least ${minBow.toFixed(2)} m, land within ${worstX.toFixed(3)} m of the marker sideways and at most ${(worstE * 100).toFixed(1)} cm further off than the same shot flown straight, top of bounce |x| <= ${maxXc.toFixed(2)} (reach 3.25)`);
  const zero = [['n 0.79 drive', [0, 1, 6.5], 0, 0.79, 0.6, 0, 0, 1], ['n 1 lob', [0, 1, 6.5], 0, 1, 0.6, 1, 0, 1], ['n 1 serve (curl 0)', [0, 1, 6.5], 0, 1, 0.6, 0, 0, 0],
    ['n 0.4 block', [0, 1, 2.5], 0, 0.4, 0.3, 0, 0, 1], ['n 0.5 drive', [1, 1, -6.5], 1, 0.5, -1, 0, 0, 1]];
  ok(zero.every(z => S.solve(z[1], z[2], z[3], z[4], z[5], z[6], null, z[7]).curl === 0), `no curl: ${zero.map(z => z[0]).join(', ')}`);
  const soft = flyOut([0.5, 1, 6.5], 0, 0.6, 0.8, 0, 0, 1);
  ok(soft.bow < 0.01, `a soft drive (n 0.6) flies straight from above: bow ${soft.bow.toFixed(3)} m`);
  const wide = S.solve([0, 1, 6.5], 0, 1, 1, 0, 0, null, 1), wide1 = S.solve([0, 1, -6.5], 1, 1, 1, 0, 0, null, 1);
  ok(wide.land[0] > 0.4 && wide.curl < 0 && wide1.land[0] < -0.4 && wide1.curl > 0, `it hooks in toward the middle: aimed at x ${wide.land[0].toFixed(1)} curls ${wide.curl.toFixed(1)} m/s^2, at x ${wide1.land[0].toFixed(1)} curls ${wide1.curl.toFixed(1)}`);
  let lateXc = 0, lateC = 0;                                        // reaim()'s late curl (CURVE.late x the bow): same REACH clamp, its own cap
  for (const d of [1.7, 3, 4.5, 6.5]) for (const x of [-3, 0, 3]) for (const dir of [-1, 0, 1]) { const r = flyOut([x, 1, d], 0, 1, dir, 0, 0, S.CURVE.late); lateXc = Math.max(lateXc, Math.abs(r.xc)); lateC = Math.max(lateC, Math.abs(r.sol.curl)); }
  ok(lateXc <= 3.25 && lateC <= S.CURVE.lateMax + 1e-9, `the late (re-aim) curl keeps the top of the bounce inside reach too: |x| <= ${lateXc.toFixed(2)}, c <= ${lateC.toFixed(1)} m/s^2 (cap ${S.CURVE.lateMax})`);
  const ramp = [0.8, 0.85, 0.9, 0.95, 1].map(n => flyOut([0, 1, 6.5], 0, n, 0.6, 0, 0, 1).bow);
  ok(ramp.every((b, i) => !i || b >= ramp[i - 1]), `it grows with power, from nothing at n 0.8: bow ${ramp.map(b => b.toFixed(2)).join(' / ')} m at n 0.8 / 0.85 / 0.9 / 0.95 / 1`);
}

// ---------- part 2: live ----------
const proc = spawn('node', ['server/game.js'], { cwd: root, env: { ...process.env, PORT: String(PORT), AUTOBOT: '0', SWING_SERVE: '0', WIN_AT: '0', BLOCK: '0' }, stdio: ['ignore', 'ignore', 'inherit'] });
await wait(800);
const shots = [];                                                  // A's hits: { mode, hit, launches, states (to the first bounce), bounce }
const MODES = ['final', 'bet', 'lob', 'soft'];
let phase = 'far', modeI = 0;
function player(o) {
  const ws = new WebSocket('ws://localhost:' + PORT), P = { ws, side: null, ...o }; let cool = 0, swungAt = 0, mode = null, cur = null, prev = null;
  ws.on('message', raw => { const m = JSON.parse(raw);
    if (m.type === 'welcome') P.side = m.side;
    if (m.type === 'hit') { cur = null; prev = null;
      if (m.side === P.side && P.a && Date.now() - swungAt < 600) { cur = { mode, phase, hit: m, launches: [], states: [], bounce: null }; shots.push(cur);
        if (mode === 'bet' || mode === 'nearbet') setTimeout(() => ws.send(JSON.stringify({ type: 'swing', power: 34, dir: 0.6, lob: 0, fix: true, final: true })), 100); } }
    if (m.type === 'launch' && cur && m.by === P.side) cur.launches.push(m);
    if (m.type === 'bounce' && cur && !cur.bounce) cur.bounce = m.p;
    if (m.type !== 'state' || P.side == null) return;
    if (cur && !cur.bounce && m.live && m.b === 0) cur.states.push({ t: m.t, p: m.p, v: m.v, c: +m.c || 0, spin: m.spin, k: m.k });
    const me = m.paddles[P.side], s = P.side === 0 ? 1 : -1, mine = m.live && m.v[2] * s > 0, z = P.a && phase === 'near' ? 3 : 6.5;
    ws.send(JSON.stringify({ type: 'paddle', x: mine ? m.p[0] : 0, y: mine ? Math.max(0.4, Math.min(1.4, m.p[1])) : 1, z, q: [0, 0, 0, 1] }));
    if (mine && me && Date.now() > cool && Math.abs(m.p[2] - me.z) < 1.0) { cool = Date.now() + 500; swungAt = Date.now();
      if (!P.a) return void ws.send(JSON.stringify({ type: 'swing', power: 16, dir: -0.3, lob: 0, final: true }));
      mode = phase === 'near' ? 'nearbet' : MODES[modeI++ % MODES.length];
      const sw = { final: { power: 34, lob: 0, final: true }, bet: { power: 34, lob: 0, final: false }, nearbet: { power: 34, lob: 0, final: false }, lob: { power: 34, lob: 1, final: true }, soft: { power: 20, lob: 0, final: true } }[mode];
      ws.send(JSON.stringify({ type: 'swing', dir: 0.6, age: 60, ...sw })); } });
  return P;
}
const A = player({ a: true }), B = player({});
await wait(30000); phase = 'near'; await wait(14000);
A.ws.close(); B.ws.close(); proc.kill();

const done = shots.filter(s => s.bounce && s.states.length > 5), by = md => done.filter(s => s.mode === md);
const last = s => s.launches[s.launches.length - 1], cOf = s => s.launches.reduce((c, l) => l.c || c, s.hit.c || 0);
const bowOf = s => { const a = s.hit.p, b = s.bounce, L = Math.hypot(b[0] - a[0], b[2] - a[2]) || 1; return Math.max(...s.states.map(q => Math.abs((q.p[0] - a[0]) * (b[2] - a[2]) - (q.p[2] - a[2]) * (b[0] - a[0])) / L)); };
const offOf = s => Math.hypot(s.bounce[0] - last(s).land[0], s.bounce[2] - last(s).land[1]), exOf = s => Math.abs(s.bounce[0] - last(s).land[0]);
// on the marker: sideways within 0.12 m (the curl's own error, part 1: < 0.09), and within 0.3 m in all. The 60 Hz sim only sees the ball
// land on the tick after it passes R, up to ~0.25 m further along a fast drive whether it curls or not: 0.2 in all failed ~5% of finals.
const onMark = s => exOf(s) < 0.12 && offOf(s) < 0.3;
function smooth(s) {                                               // the client's own prediction from each packet to the next, and the plain packet-to-packet step
  let pred = 0, jump = 0; const st = [{ t: s.hit.t, p: s.hit.p, v: s.hit.v, c: +s.hit.c || 0, spin: s.hit.spin, k: s.hit.k }, ...s.states];
  for (let i = 1; i < st.length; i++) { const a = st[i - 1], b = st[i]; if (!(b.t > a.t)) continue;
    coast(cP, cV, a.p, a.v, b.t - a.t, a.spin || 0, 0, a.k || 0, a.c); pred = Math.max(pred, Math.hypot(cP.x - b.p[0], cP.y - b.p[1], cP.z - b.p[2]));
    jump = Math.max(jump, Math.hypot(b.p[0] - a.p[0], b.p[1] - a.p[1], b.p[2] - a.p[2])); }
  return { pred, jump };
}
const f2 = x => x.toFixed(2), q = (a, p) => a.length ? f2([...a].sort((x, y) => x - y)[Math.floor(p * (a.length - 1))]) : '-';
const F = by('final'), Bt = by('bet'), L = by('lob'), So = by('soft'), N = by('nearbet');
console.log(`live: ${shots.length} of A's hits, ${done.length} flown to a bounce (final ${F.length}, bet ${Bt.length}, lob ${L.length}, soft ${So.length}, near bet ${N.length})`);
ok(F.length >= 3 && Bt.length >= 3 && L.length >= 2 && So.length >= 2 && N.length >= 2, 'enough of every kind of shot');
ok(F.every(s => s.hit.c && s.states.some(q => q.c === s.hit.c)), `a settled full-power drive curls from contact: c ${[...new Set(F.map(s => f2(s.hit.c || 0)))].join(', ')} m/s^2, on the hit and on every state packet`);
ok(F.every(s => bowOf(s) >= 0.3), `...and bends visibly: bow ${F.map(s => f2(bowOf(s))).join(', ')} m off the straight line`);
ok(F.every(onMark), `...and still lands on its marker: ${F.map(s => f2(exOf(s)) + '/' + f2(offOf(s))).join(', ')} m off (sideways/in all)`);
ok(Bt.every(s => !s.hit.c && s.hit.bet), `a bet never curls: the hit on it carries c ${[...new Set(Bt.map(s => s.hit.c || 0))]}`);
const BtR = Bt.filter(s => s.launches.some(l => l.n != null));
ok(BtR.length >= 3 && BtR.every(s => { const r = s.launches.find(l => l.n != null); return r.c && r.n > 0.8; }), `its settled report (full power) curls it from the re-aim: ${BtR.map(s => { const r = s.launches.find(l => l.n != null); return `n ${f2(r.n)} c ${f2(r.c || 0)}`; }).join(', ')}`);
ok(BtR.every(s => bowOf(s) >= 0.45 && onMark(s)), `...bends like one (bow from contact ${BtR.map(s => f2(bowOf(s))).join(', ')} m, at least 0.45: it was 0.26 sized to the flight left) and lands on the moved marker (${BtR.map(s => f2(exOf(s)) + '/' + f2(offOf(s))).join(', ')} m off)`);
const NR = N.filter(s => s.launches.some(l => l.n != null));
ok(NR.length >= 2 && NR.every(s => cOf(s) && onMark(s)), `near the net (z 3), a bet settled at full power curls too: c ${NR.map(s => f2(cOf(s))).join(', ')}, lands ${NR.map(s => f2(exOf(s)) + '/' + f2(offOf(s))).join(', ')} m off, bow ${NR.map(s => f2(bowOf(s))).join(', ')} m`);
ok(L.every(s => !cOf(s) && s.states.every(q => !q.c)), `a full-power lob never curls (c on no packet), bow ${L.map(s => f2(bowOf(s))).join(', ')} m`);
ok(So.every(s => !cOf(s) && bowOf(s) < 0.05), `a soft drive (power 20) flies straight: bow ${So.map(s => f2(bowOf(s))).join(', ')} m`);
const sm = done.map(s => ({ mode: s.mode, ...smooth(s) })), cur = sm.filter(s => s.mode !== 'lob' && s.mode !== 'soft');
ok(sm.every(s => s.pred < 0.05), `the client's coast() puts every packet where the next one says: worst ${f2(Math.max(...sm.map(s => s.pred)) * 100)} cm (curled shots p50 ${q(cur.map(s => s.pred * 100), 0.5)} cm)`);
ok(sm.every(s => s.jump < 0.6), `no packet jumps more than 0.6 m: worst step ${f2(Math.max(...sm.map(s => s.jump)))} m`);
console.log(fails ? fails + ' FAILURES' : 'CURVE TESTS PASSED'); process.exit(fails ? 1 : 0);
