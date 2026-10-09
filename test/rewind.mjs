// The lag-compensation rewind slide. A swing that reaches the server after the ball has passed the contact plane is struck where the ball
// WAS (server/game.js tryHit: the hist entry nearest CONTACT, looking back up to LAG_MAX) but at room time NOW, so the hit event says "the
// ball is at p (behind where it really got to) from now on". Every screen has drawn the ball on to where it really got: the hitter's past
// their paddle, the opponent's too. scene.js drawBall then takes that error out over 0.08-0.18 s: the ball visibly slides back.
// How often, how far, on whose screen, and what the alternatives would cost.
//
// A. The real captures (data/live-play-1..3, live-swings) through the REAL web/motion.js on their real arrival times, with web/main.js's own
//    lob/spin maths (test/reaimgap.mjs's extraction): every scored movement's reports and when its bet arrived relative to the hand's peak.
// B. Played at the REAL server (SERVERS in parallel, against Matt), each server at its own ALIGN: the hand's peak lands ALIGN ms (+ a seeded
//    human jitter JITTER_MS) after the ball reaches the contact plane (early / natural / late). Every message the probe gets is logged.
// C. Per hit, from the log: struck from the past? (hit.p matched exactly to the state packet it was remembered from) how long ago, how far
//    back; then the hitter's and the opponent's screens: the same message stream (the broadcasts are identical) into scene.js's own ballTake /
//    ballState / drawBall at 60 fps, each a one-way OWD away, random frame phase. Then the options, on the same logs (offline rewrites of the
//    stream): stamp the launch at the contact time (alpha 1) or halfway (0.5); launch from where the ball is now (no rewind); the hitter's
//    drawn ball held at their own contact plane while their swing is out.
// Usage: TEST_PORT=<base> [SERVERS=6] [ALIGNS=-50,30,100] [JITTER_MS=30] [NET_MS=13] [SECS=150] [OWD=6.5] [OWD_OPP=6.5] [OUT=file.json]
//        [MODE=all|live|analyse] node test/rewind.mjs          (MODE=analyse re-reads OUT)
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import WebSocket from 'ws';
import { MotionModel, qaxis, qmul } from '../web/motion.js';
const { drawBall, serverClock, ballTake, ballState, coast } = await import('../web/scene.js');
const root = new URL('..', import.meta.url).pathname, env = process.env, MODE = env.MODE || 'all';
const OUT = env.OUT || os.tmpdir() + '/rewind.json', BASE = +env.TEST_PORT || 8710, K = +env.SERVERS || 6, SECS = +env.SECS || 150;
const ALIGNS = (env.ALIGNS || '-50,30,100').split(',').map(Number), JIT = env.JITTER_MS != null ? +env.JITTER_MS : 30, NET = env.NET_MS != null ? +env.NET_MS : 13;
const OWD = env.OWD != null ? +env.OWD : 6.5, OWD_OPP = env.OWD_OPP != null ? +env.OWD_OPP : 6.5;
const DT = 1 / 60, CONTACT = 0.25, LAG_MAX = 0.3, F = 1000 / 60, wait = ms => new Promise(r => setTimeout(r, ms));
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

// ---------------------------------------------------------------- A. the captures ----------------------------------------------
const main = fs.readFileSync(root + 'web/main.js', 'utf8');
const a0 = main.indexOf('const roll = Math.max('), a1 = main.indexOf("game.send({ type: 'swing'", a0);
if (a0 < 0 || a1 < 0) throw new Error('web/main.js: the swing maths moved');
const clientOf = new Function('e', main.slice(a0, a1) + '; return { slice, lob };');
const FILES = (env.FILES || 'live-play-1,live-play-2,live-play-3,live-swings').split(',');
function extract(file) {
  const rows = fs.readFileSync(root + 'data/' + file + '.jsonl', 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(r => r && r.q && r.r && Number.isFinite(r.at));
  const off = rows.map(r => r.at - r.t * 1000), minOff = off.map((_, i) => { let m = Infinity; for (let j = Math.max(0, i - 250); j < Math.min(off.length, i + 250); j++) m = Math.min(m, off[j]); return m; });
  const mm = new MotionModel(), q0 = rows[0].q, T0 = rows[0].t - 8;
  for (let i = 0; i < 400; i++) { const t = T0 + i * 0.02, k = i * 0.02, tip = k < 5.4 ? 0 : k < 6 ? 0.6 * (k - 5.4) / 0.6 : 0.6; mm.feed({ t, q: qmul(qaxis([1, 0, 0], tip), q0), r: [0, 0, 0], a: [0, 0, 0] }, t * 1000 + off[0]); }
  if (!mm.calibrated) throw new Error(file + ': calibration failed');
  const movs = []; let cur = null, trigAt = null;
  rows.forEach((r, i) => {
    let fin = false, end = false; const sw0 = mm.sw, evs = mm.feed(r, r.at);
    if (mm.sw && mm.sw !== sw0) trigAt = r.at;                    // motion.js opens a swing (sw) on the sample that crosses TRIGGER: the first moment the page knows one is coming (its take-off mv0 is dated back from here)
    for (const e of evs) {
      if (e.type === 'swing') movs.push(cur = { file, key: file + '#' + movs.length, at0: r.at, reps: [], pkAt: null, lastPk: null, trig: trigAt != null ? r.at - trigAt : 0 });
      if (!cur) continue;
      if (e.type === 'swing' || e.type === 'swingFix') { const c = clientOf(e);
        cur.reps.push({ dt: r.at - cur.at0, power: e.power, raw: e.raw || 0, rom: e.rom || 0, back: e.back || 0, off: e.off || 0, dir: e.dir, lob: c.lob, chop: e.chop || 0, age: e.age || 0, slice: c.slice, fix: e.type === 'swingFix', final: !!e.final });
        if (e.final) fin = true; }
      if (e.type === 'swingEnd') end = true;
    }
    if (cur && mm.sw) cur.lastPk = mm.sw.tPk * 1000 + minOff[i];
    if (cur && fin && cur.pkAt == null) cur.pkAt = cur.lastPk;
    if (cur && end) { if (cur.pkAt == null) cur.pkAt = cur.lastPk; cur.delta = cur.at0 - cur.pkAt; delete cur.lastPk; cur = null; }
  });
  return movs.filter(m => Number.isFinite(m.delta));
}

// ---------------------------------------------------------------- B. live ------------------------------------------------------
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const hash = s => [...s].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261);
function probe(port, queue, align, deadline) {
  return new Promise(done => {
    const ws = new WebSocket('ws://localhost:' + port), log = [], atts = []; let side = null, cool = 0, att = null, qi = 0, over = false;
    const close = () => { if (att) { att.endI = log.length; atts.push(att); att = null; } };
    const finish = () => { if (over) return; over = true; close(); try { ws.close(); } catch { /* gone */ } done({ port, align, side, log, atts }); };
    const timer = setInterval(() => { if (performance.now() > deadline || (qi >= queue.length && !att)) { clearInterval(timer); finish(); } }, 100);
    ws.on('error', () => finish());
    ws.on('message', raw => { const m = JSON.parse(raw), now = performance.now(); m.ta = now; log.push(m);
      if (m.type === 'welcome') { side = m.side; ws.send(JSON.stringify({ type: 'name', name: 'Probe' })); }
      if (m.type === 'hit') { if (att && m.side === side && att.sent.length && att.hitI == null) att.hitI = log.length - 1; else if (att && att.hitI != null && m.side !== side) close(); }
      if (m.type === 'whiff' && att && att.hitI == null) { att.whiffI = log.length - 1; att.whiff = m.why || 'whiff'; }
      if (m.type === 'point') close();
      if (m.type !== 'state' || side == null) return;
      const s = side === 0 ? 1 : -1, mine = m.live && m.v[2] * s > 0, me = m.paddles[side];
      ws.send(JSON.stringify({ type: 'paddle', x: mine ? m.p[0] : 0, y: mine ? Math.max(0.4, Math.min(1.4, m.p[1])) : 1, z: 6.5, q: [0, 0, 0, 1], r: 0 }));
      if (att && now - att.armAt > 2500) close();
      if (att || !mine || !me || now < cool || qi >= queue.length || m.serving != null) return;
      const ahead = -(m.p[2] - me.z) * s, tc = (ahead - CONTACT) / Math.abs(m.v[2]) * 1000;   // ms until the ball is at the contact plane
      const job = queue[qi], lead = tc + job.m.delta + align + job.jit;                        // the bet goes out so that the hand's peak lands align + jit after it
      if (lead > 17) return;
      qi++; cool = now + 900;
      att = { key: job.m.key, jit: job.jit, align, armAt: now, armI: log.length - 1, tcAt: now + tc, sent: [], age0: job.m.reps[0].age };
      const a = att, t0 = now + Math.max(0, lead);
      for (const r of job.m.reps) setTimeout(() => { if (ws.readyState !== 1) return; a.sent.push({ at: performance.now(), i: log.length, final: r.final, fix: r.fix });
        ws.send(JSON.stringify({ type: 'swing', power: r.power, raw: r.raw, rom: r.rom, back: r.back, off: r.off, dir: r.dir, lob: r.lob, chop: r.chop, age: r.age, net: NET, slice: r.slice, fix: r.fix, final: r.final })); }, Math.max(0, t0 + r.dt - performance.now()));
    });
  });
}
async function live(movs) {
  const plan = [];
  for (let rep = 0; rep < 40; rep++) for (const m of movs) { const u = rng(hash(m.key) + rep * 7919); const g = Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u()); plan.push({ m, jit: g * JIT, o: u() }); }
  plan.sort((a, b) => a.o - b.o);
  const queues = Array.from({ length: K }, () => []); plan.forEach((j, i) => queues[i % K].push(j));
  const procs = []; for (let k = 0; k < K; k++) procs.push(spawn('node', ['server/game.js'], { cwd: root, env: { ...env, PORT: String(BASE + k), AUTOBOT: '1', WIN_AT: '0', SWING_SERVE: '0', PODDLE_DB: ':memory:' }, stdio: ['ignore', 'ignore', 'inherit'] }));
  await wait(1200);
  const deadline = performance.now() + SECS * 1000;
  const res = await Promise.all(queues.map((q, k) => probe(BASE + k, q, ALIGNS[k % ALIGNS.length], deadline)));
  for (const p of procs) p.kill();
  return res;
}

// ---------------------------------------------------------------- C. analysis --------------------------------------------------
class V3 { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } copy(o) { this.x = o.x; this.y = o.y; this.z = o.z; return this; }
  length() { return Math.hypot(this.x, this.y, this.z); } addScaledVector(o, s) { this.x += o.x * s; this.y += o.y * s; this.z += o.z * s; return this; }
  lerp(o, a) { this.x += (o.x - this.x) * a; this.y += (o.y - this.y) * a; this.z += (o.z - this.z) * a; return this; }
  distanceToSquared(o) { return (this.x - o.x) ** 2 + (this.y - o.y) ** 2 + (this.z - o.z) ** 2; } }
const newBall = () => ({ p: [0, 1, 0], v: [0, 0, 0], live: false, stamp: 0, seen: false, snap: true, pos: new V3(0, 1, 0), vel: new V3(), core: new V3(0, 1, 0), err: new V3(), errT: 1, errDur: 0.1, blend: false, bounces: 0, kick: 0, curl: 0, held: false, spin: 0, arc: null, w: null, tS: NaN });
const VIEW_TYPES = new Set(['state', 'hit', 'launch', 'serve']);
const tkey = t => Math.round(t * 600);              // ticks are 1/60 s: a tenth of a tick resolves them

// one screen: msgs (already rewritten for an option) seen `owd` ms after the probe got them; frames at 60 fps from a random phase.
// hold: { from (local ms), max, zcp, s } the hitter's drawn ball may not pass zcp (along s) from `from` until the hit is taken or max ms
function screen(msgs, hitTa, { owd, farZ, phase, hold, plane, until = 300 }) {
  const clock = serverClock(), b = newBall(), vA = new V3(), madeAt = (t, now) => clock.madeAt(t, now);
  const on = (m, now) => (m.type === 'state' ? ballState(b, m.p, m.v, m.live, madeAt(+m.t, now), m.spin, m, +m.t) : ballTake(b, m, t => madeAt(t, now)));
  let qi = 0, last = null, now = msgs[0].ta + owd + phase * F, took = null, prev = null, preHit = null, maxSpd = 0, held = 0, heldMax = 0, release = null;
  const out = {};
  for (; now < hitTa + owd + until; now += F) {
    let gotHit = false;
    while (qi < msgs.length && msgs[qi].ta + owd <= now) { const m = msgs[qi++]; on(m, m.ta + owd); if (m.type === 'hit' && m.isHit) gotHit = true; }
    const dt = last == null ? 1 / 60 : clamp((now - last) / 1000, 0, 0.05); last = now;
    if (!b.live) continue;
    if (gotHit && took == null) preHit = prev ? { ...prev } : null;
    const sn = drawBall(b, vA, now, dt, farZ);
    if (hold && took == null && !gotHit && now >= hold.from && now < hold.from + hold.max) {      // the hold: the drawn ball waits at the contact plane
      if (hold.ok == null) hold.ok = (b.pos.z - hold.zcp) * hold.s <= 0;                          // only a ball still in front of it when the swing went out
      if (hold.ok && (b.pos.z - hold.zcp) * hold.s > 0) { const d = (b.pos.z - hold.zcp) * hold.s; b.pos.z = hold.zcp; held += dt; heldMax = Math.max(heldMax, d); }
    } else if (hold && hold.ok && took == null && !gotHit && now >= hold.from + hold.max && release == null) release = Math.abs(b.pos.z - (prev ? prev.z : b.pos.z));
    if (gotHit && took == null) { took = now; out.err = b.err.length(); out.errZ = b.err.z; out.errDur = b.errDur; out.snapped = sn; out.past = preHit && plane ? (preHit.z - plane.zcp) * plane.s : NaN; out.pos = [b.pos.x, b.pos.y, b.pos.z]; out.ev = [b.err.x, b.err.y, b.err.z]; }
    if (took != null && prev && now - took <= 250) maxSpd = Math.max(maxSpd, Math.hypot(b.pos.x - prev.x, b.pos.y - prev.y, b.pos.z - prev.z) / dt);
    prev = { x: b.pos.x, y: b.pos.y, z: b.pos.z };
  }
  out.maxSpd = maxSpd; out.held = held * 1000; out.heldMax = heldMax; out.release = release; out.took = took;
  return out;
}

function analyse(runs) {
  const rows = [];
  for (const run of runs) {
    const { log, side, align } = run, s = side === 0 ? 1 : -1;
    const states = log.filter(m => m.type === 'state'), byT = new Map(); for (const m of states) if (!byT.has(tkey(m.t))) byT.set(tkey(m.t), m);
    for (const at of run.atts) {
      const row = { align, jit: at.jit, whiff: at.whiff || null, hit: at.hitI != null };
      const lastI = at.hitI != null ? at.hitI : at.whiffI != null ? at.whiffI : null;
      if (lastI == null) { rows.push(row); continue; }
      const H = log[lastI], i0 = Math.max(0, lastI - 150), win = log.slice(i0, Math.min(log.length, lastI + 60)).filter(m => VIEW_TYPES.has(m.type));
      let st = null; for (let i = lastI - 1; i >= 0; i--) if (log[i].type === 'state') { st = log[i]; break; }
      const padZ = st ? st.paddles[side].z : 6.5 * s, oppZ = st && st.paddles[1 - side] ? st.paddles[1 - side].z : -6.5 * s, zcp = padZ - CONTACT * s;
      const betAt = at.sent.length ? at.sent[0].at : null;
      if (at.hitI == null) {                                                              // a whiff: only the hold's cost
        const msgs = win.map(m => ({ ...m })), ph = Math.random();
        if (betAt != null) { const hold = { from: betAt - OWD, max: 150, zcp, s }, r = screen(msgs, H.ta, { owd: OWD, farZ: oppZ, phase: ph, hold, until: 200 }); row.whiffOk = !!hold.ok; row.whiffHeld = r.held; row.whiffSnap = r.release; }
        rows.push(row); continue;
      }
      // ---- struck from the past? hit.p was remembered from a tick: find that state packet (x and z exactly; y is clamped at R by launch)
      let match = null; for (let i = at.hitI - 1; i >= i0; i--) { const m = log[i]; if (m.type === 'state' && m.p[0] === H.p[0] && m.p[2] === H.p[2]) { match = m; break; } }
      if (!match) for (let i = at.hitI + 1; i < Math.min(log.length, at.hitI + 6); i++) { const m = log[i]; if (m.type === 'state' && tkey(m.t) === tkey(H.t) && m.p[0] === H.p[0] && m.p[2] === H.p[2]) { match = m; break; } }   // struck inside a tick, from where it was: this tick's packet follows the hit
      let pre = null; for (let i = at.hitI - 1; i >= i0; i--) { const m = log[i]; if (m.type === 'state' && tkey(m.t) === tkey(H.t)) { pre = { p: m.p, v: m.v }; break; } }   // the strike came on a swing's arrival: this tick's packet already went, it shows the ball unstruck
      if (!pre) { const m = byT.get(tkey(H.t - DT)); if (m) { const P = new V3(), Vv = new V3(); coast(P, Vv, m.p, m.v, DT, m.spin || 0, m.b | 0, +m.k || 0, +m.c || 0); pre = { p: [P.x, P.y, P.z], v: m.v }; } }
      row.matched = !!match; row.age = match ? (H.t - match.t) * 1000 : NaN;
      row.back = pre ? Math.hypot(pre.p[0] - H.p[0], pre.p[1] - H.p[1], pre.p[2] - H.p[2]) : NaN; row.backZ = pre ? (pre.p[2] - H.p[2]) * s : NaN;
      row.aheadHit = -(H.p[2] - padZ) * s; row.aheadNow = pre ? -(pre.p[2] - padZ) * s : NaN;         // m in front of the paddle: where it is struck from, where it really was
      row.s = s; row.vIn = pre ? Math.hypot(...pre.v) : NaN; row.vOut = Math.hypot(...H.v); row.bet = !!H.bet;
      row.sendToHit = betAt != null ? H.ta - betAt : NaN;
      const ph = Math.random(), base = win.map(m => ({ ...m, isHit: m === H }));
      const both = msgs => ({ me: screen(msgs, H.ta, { owd: OWD, farZ: oppZ, phase: ph, plane: { zcp, s } }), opp: screen(msgs, H.ta, { owd: OWD_OPP, farZ: padZ, phase: ph }) });
      row.now = both(base);
      // ---- options, as rewrites of the same stream ----
      const ageS = Number.isFinite(row.age) ? row.age / 1000 : 0;
      const shifted = alpha => { const k = Math.round(alpha * ageS / DT), sh = k * DT; let after = false;
        return win.map(m => { const o = { ...m, isHit: m === H }; if (m === H) { after = true; o.t = m.t - sh; return o; }
          if (!after || !k || !(m.type === 'state' || m.type === 'launch')) return o;
          const src = byT.get(tkey(m.t + sh)); if (!src) return o;
          Object.assign(o, { p: src.p, v: src.v, b: src.b, k: src.k, c: src.c, spin: src.spin, w: src.w ? src.w.map((x, j) => (j % 4 === 3 ? x - sh : x)) : undefined });
          if (m.type === 'launch' && m.w) o.w = src.w ? src.w.map((x, j) => (j % 4 === 3 ? x - sh : x)) : m.w; return o; }); };
      row.stamp1 = row.age > 0 ? both(shifted(1)) : row.now; row.stamp5 = row.age > 0 ? both(shifted(0.5)) : row.now;
      if (pre) { const d = [pre.p[0] - H.p[0], pre.p[1] - H.p[1], pre.p[2] - H.p[2]]; let after = false;                // launched from where the ball is now
        const msgs = win.map(m => { const o = { ...m, isHit: m === H }; if (m === H) after = true; if (after && (m.type === 'state' || m.type === 'launch' || m === H) && m.p) o.p = [m.p[0] + d[0], Math.max(0.11, m.p[1] + d[1]), m.p[2] + d[2]]; return o; });
        row.nowLaunch = row.age > 0 ? both(msgs) : row.now;
        // rewound only as far as the paddle plane (never from behind the paddle, 0.25 m less rewind): the launch point slides along the path in
        for (const [k, A] of [['plane', 0], ['plane25', -0.25], ['plane50', -0.5]]) {
          const fr = row.aheadNow >= A ? 1 : clamp((CONTACT - A) / (CONTACT - row.aheadNow), 0, 1), d2 = d.map(x => x * fr); after = false;
          const msgs2 = win.map(m => { const o = { ...m, isHit: m === H }; if (m === H) after = true; if (after && (m.type === 'state' || m.type === 'launch' || m === H) && m.p) o.p = [m.p[0] + d2[0], Math.max(0.11, m.p[1] + d2[1]), m.p[2] + d2[2]]; return o; });
          row[k] = row.age > 0 ? both(msgs2) : row.now; row[k + 'From'] = Math.max(A, row.aheadNow); } }
      const trig = TRIG.get(at.key) || 0; row.trig = trig;
      if (betAt != null) for (const [nm, from, max] of [['holdBet', betAt - OWD, 2 * OWD + 50], ['holdTrig', betAt - OWD - trig, trig + 2 * OWD + 50], ['holdReply', betAt - OWD - (at.age0 || 0), (at.age0 || 0) + 2 * OWD + 50]]) {   // from the bet going out, or from the hand's take-off (motion.js knows it then); max: how long it may wait
        const hold = { from, max, zcp, s }; const r = screen(base, H.ta, { owd: OWD, farZ: oppZ, phase: ph, hold, plane: { zcp, s } }); r.ok = !!hold.ok; row[nm] = r; }
      rows.push(row);
    }
  }
  return rows;
}

// ---------------------------------------------------------------- report -------------------------------------------------------
const q = (a, p) => { const b = a.filter(Number.isFinite).sort((x, y) => x - y); return b.length ? b[Math.min(b.length - 1, Math.floor(p * (b.length - 1) + 0.5))] : NaN; };
const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '-');
const D = (a, d = 2) => `p50 ${f(q(a, 0.5), d).padStart(6)} p90 ${f(q(a, 0.9), d).padStart(6)} max ${f(q(a, 1), d).padStart(6)}  (n ${a.filter(Number.isFinite).length})`;
const pc = (a, b) => (b ? (100 * a / b).toFixed(0) + '%' : '-');
// the angle (deg) the slide spans at a player's eye: scene.js playPose puts it at (0, 3.1, +-12.1), 5.6 m behind its own baseline, vertical fov 44
const EYE = [0, 3.1, 12.1], FOV = 44;
const angle = (o, own) => { if (!o || !o.pos) return NaN; const e = [EYE[0], EYE[1], EYE[2] * own], a = o.pos.map((x, i) => x - e[i]), b = o.pos.map((x, i) => x - o.ev[i] - e[i]);
  const c = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (Math.hypot(...a) * Math.hypot(...b)); return Math.acos(Math.min(1, c)) * 180 / Math.PI; };
function report(rows) {
  const lines = [], L = s => { lines.push(s); console.log(s); };
  const groups = [...ALIGNS.map(a => [`ALIGN ${a} ms`, rows.filter(r => r.align === a)]), ['all', rows]];
  for (const [name, R] of groups) {
    const H = R.filter(r => r.hit), P = H.filter(r => r.age > 0), U = H.filter(r => !r.matched);
    L(`\n== ${name}: ${R.length} swings, ${H.length} hits, ${R.filter(r => r.whiff).length} whiffs`);
    L(`  struck from the past (rewound):        ${P.length}/${H.length} = ${pc(P.length, H.length)}   (hit.p unmatched to a state packet: ${U.length})`);
    L(`  rewind age ms (rewound hits)            ${D(P.map(r => r.age), 0)}`);
    L(`  rewind distance m (rewound)             ${D(P.map(r => r.back))}`);
    L(`  ball really was, m in front of paddle   ${D(P.map(r => r.aheadNow))}   behind the paddle: ${P.filter(r => r.aheadNow < 0).length}`);
    L(`  struck from, m in front (all hits)      ${D(H.map(r => r.aheadHit))}   > 0.6 m (early: turns in mid-air): ${pc(H.filter(r => r.aheadHit > 0.6).length, H.length)}`);
    for (const [who, k] of [['hitter', 'me'], ['opponent', 'opp']]) {
      L(`  ${who.padEnd(8)} slide at the hit, m: rewound ${D(P.map(r => r.now[k].err))}`);
      L(`  ${''.padEnd(8)}                   not rewound ${D(H.filter(r => !(r.age > 0)).map(r => r.now[k].err))}`);
      L(`  ${''.padEnd(8)} over (errDur ms)  rewound ${D(P.map(r => 1000 * r.now[k].errDur), 0)};  peak drawn speed / truth's, 250 ms ${D(P.map(r => r.now[k].maxSpd / r.vOut))}`);
    }
    L(`  as seen: hitter's eye, deg ${D(P.map(r => angle(r.now.me, r.s)), 1)} (= ${f(100 * q(P.map(r => angle(r.now.me, r.s)), 0.5) / FOV, 0)}% / ${f(100 * q(P.map(r => angle(r.now.me, r.s)), 0.9) / FOV, 0)}% of the screen height, p50/p90)`);
    L(`           opponent's eye, deg ${D(P.map(r => angle(r.now.opp, -r.s)), 1)} (= ${f(100 * q(P.map(r => angle(r.now.opp, -r.s)), 0.5) / FOV, 0)}% / ${f(100 * q(P.map(r => angle(r.now.opp, -r.s)), 0.9) / FOV, 0)}%)`);
    L(`  hitter: drawn ball past the contact plane on the frame before the hit is taken, m: rewound ${D(P.map(r => r.now.me.past))}; snapped (> 5 m) ${P.filter(r => r.now.me.snapped || r.now.opp.snapped).length}`);
    L('  options (rewound hits): slide on the hit frame, m');
    for (const [nm, k, cost] of [['today', 'now', null], ['stamp at contact (alpha 1)', 'stamp1', 1], ['stamp halfway (alpha 0.5)', 'stamp5', 0.5], ['launch from where it is now', 'nowLaunch', null], ['rewind only to the paddle plane', 'plane', null], ['rewind to 0.25 m behind the paddle', 'plane25', null], ['rewind to 0.5 m behind the paddle', 'plane50', null]]) {
      const A = P.filter(r => r[k]); L(`   ${nm.padEnd(30)} hitter ${D(A.map(r => r[k].me.err))}  seen ${D(A.map(r => angle(r[k].me, r.s)), 1)} deg\n   ${''.padEnd(30)} opp    ${D(A.map(r => r[k].opp.err))}` + (cost ? `\n   ${''.padEnd(30)} opponent's reaction time lost, ms ${D(A.map(r => cost * r.age), 0)}` : ''));
    }
    { const A = P.filter(r => Number.isFinite(r.aheadNow)); L(`   launch from now: leaves this far past the contact plane, m ${D(A.map(r => CONTACT - r.aheadNow))}; behind the paddle itself ${pc(A.filter(r => r.aheadNow < 0).length, A.length)}`);
      for (const k of ['plane25', 'plane50']) L(`   ${k}: leaves from behind the paddle on ${pc(A.filter(r => r[k + 'From'] < 0).length, A.length)}, by ${D(A.filter(r => r[k + 'From'] < 0).map(r => -r[k + 'From']))} m`); }
    for (const [nm, k] of [['hold from the bet', 'holdBet'], ['hold from the TRIGGER crossing', 'holdTrig'], ['hold from take-off (not knowable)', 'holdReply']]) {
      const A = P.filter(r => r[k]), ok = A.filter(r => r[k].ok), B = H.filter(r => r[k] && r[k].ok);
      L(`   ${nm.padEnd(30)} applies ${pc(ok.length, A.length)} of rewound; their hitter slide ${D(ok.map(r => r[k].err))}\n   ${''.padEnd(30)} (today ${D(ok.map(r => r.now.me.err))}); ball stopped at the plane ${D(B.map(r => r[k].held), 0)} ms (hits it applied to)`);
    }
    { const A = H.filter(r => r.holdTrig && r.holdTrig.ok), w = r => r.trig + 2 * OWD + 50; L(`   holdTrig on a whiff (ANALYTIC bound, no whiffs were played): the ball may wait up to TRIGGER->bet + RTT + 50 ms = ${D(A.map(w), 0)} ms, then catch up ~ v_in x that: ${D(A.map(r => r.vIn * w(r) / 1000))} m`); }
    const W = R.filter(r => r.whiff && r.whiffOk);
    if (W.length) L(`   on whiffs (${W.length} held of ${R.filter(r => r.whiff).length}), hold from the bet: held ${D(W.map(r => r.whiffHeld), 0)} ms, then the ball jumps on ${D(W.map(r => r.whiffSnap))} m`);
  }
  return lines;
}

// ---------------------------------------------------------------- run ----------------------------------------------------------
const MOVS = FILES.flatMap(extract).filter(m => m.reps.some(r => r.final) && m.reps.some(r => r.power > 7)), TRIG = new Map(MOVS.map(m => [m.key, m.trig]));
let rows;
if (MODE === 'analyse') rows = analyse(JSON.parse(fs.readFileSync(OUT, 'utf8')).runs);
else {
  const movs = MOVS;
  console.log(`${movs.length} scored movements from ${FILES.join(', ')}; delta (bet arrival - hand peak) p50 ${f(q(movs.map(m => m.delta), 0.5), 0)} ms`);
  const runs = await live(movs);
  fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), cfg: { ALIGNS, JIT, NET, SECS, K, OWD, OWD_OPP }, runs })); console.log('raw logs -> ' + OUT);
  rows = MODE === 'live' ? null : analyse(runs);
}
if (rows) { report(rows); fs.writeFileSync(OUT.replace(/\.json$/, '') + '-rows.json', JSON.stringify(rows)); }
process.exit(0);
