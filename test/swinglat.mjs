// Swing -> visible hit: where the time goes. Replays the REAL captures (data/live-play-1/2/3.jsonl, data/live-swings.jsonl: an
// AirPod through the Mac helper, `at` = when each sample reached the page) through the REAL web/motion.js, then plays every scored
// swing at the REAL server (node server/game.js, against Matt, over a WebSocket the way test/reaim.mjs does: createRoom() is not
// exported and requiring game.js starts its listener and loop), then feeds the hitter's own message stream into web/scene.js's own
// ballTake / ballState / drawBall at 60 fps (the test/drawlob.mjs plumbing) to find the frame the drawn ball turns.
//
// Stages, per real hit (ms):
//   1a onset -> bet        sensor clock. Onset = the gyro rate |r| last crossing ROM_IDLE (4 rad/s, motion.js's own "idle" line) on the
//                          way up to the swing, interpolated; also motion.js's own take-off (sw.mv0, = what `age` counts from)
//   1b bet sample late     how much later than the least-delayed sample the bet's sample reached the page (Bluetooth + helper jitter).
//                          The constant floor under it (CoreMotion -> helper -> page) is not in the captures: BT_FLOOR (default 0)
//   2a relay legs          a phone's samples go phone -> server -> tab: 2 x OWD more on every sample (RELAY=1 adds it to the totals)
//   2b tab -> server       OWD (default 6.5 ms = a 13 ms ping)
//   2c server: swing -> strike   measured on loopback: the server strikes on arrival if the ball is in the box, else on the first 60 Hz
//                          tick the ball is in it (this harness swings with the ball already in the box: MODE=inbox; MODE=natural
//                          times the bet so the ball reaches the contact plane at the recorded paddle peak)
//   3a server -> tab 'hit' OWD
//   3b 'hit' -> drawn turn first 60 fps frame on which scene.js's drawn ball moves away (random frame phase per hit). Not modelled:
//                          the compositor / display scan-out (another ~1 frame on most screens)
//   3c strike -> state     first 60 Hz state packet carrying the new velocity (the path the screen would wait for without the hit's v)
// And (b) second-swing readiness, from the captures and from splicing real swings into each other's follow-through.
//
// Usage: [SERVER=0] [SECS=120] [OWD=6.5] [RELAY=0] [BT_FLOOR=0] [MODE=inbox|natural|both] [TEST_PORT=8391] [OUT=rows.json] node test/swinglat.mjs
import { spawn } from 'child_process';
import fs from 'fs';
import WebSocket from 'ws';
import { MotionModel, DEFAULTS, qaxis, qmul, qconj } from '../web/motion.js';
const { drawBall, serverClock, ballTake, ballState } = await import('../web/scene.js');
const root = new URL('..', import.meta.url).pathname, E = process.env;
const PORT = +E.TEST_PORT || 8391, OWD = E.OWD != null ? +E.OWD : 6.5, RELAY = E.RELAY === '1', BT_FLOOR = +E.BT_FLOOR || 0, SECS = +E.SECS || 120;
const MODE = E.MODE || 'both', OUT = E.OUT || null, FILES = (E.FILES || 'data/live-play-1.jsonl,data/live-play-2.jsonl,data/live-play-3.jsonl,data/live-swings.jsonl').split(',');
const IDLE = DEFAULTS.ROM_IDLE, wait = ms => new Promise(r => setTimeout(r, ms));
const q = (a, p) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))] : NaN; };
const f1 = v => (Number.isFinite(v) ? v.toFixed(1) : '-').padStart(7);
const row = (name, a, note = '') => console.log(name.padEnd(46) + f1(q(a, 0.5)) + f1(q(a, 0.9)) + f1(q(a, 1)) + `  n=${String(a.filter(Number.isFinite).length).padEnd(4)} ${note}`);
const head = t => console.log(`\n${t}\n${''.padEnd(46)}${'p50'.padStart(7)}${'p90'.padStart(7)}${'max'.padStart(7)}`);

// ---- the reports web/main.js would send (its OWN spin and lob maths, as test/reaim.mjs takes it) ----
const main = fs.readFileSync(root + 'web/main.js', 'utf8');
const a0 = main.indexOf('const roll = Math.max('), a1 = main.indexOf("game.send({ type: 'swing'", a0);
if (a0 < 0 || a1 < 0) throw new Error('web/main.js: the swing maths moved');
const clientOf = new Function('e', main.slice(a0, a1) + '; return { slice, lob };');

// ================= A. motion.js over the real captures =================
function calibrated(rows) {                                     // real.mjs: hold the capture's first pose, tip up, rest
  const mm = new MotionModel(), q0 = rows[0].q, T0 = rows[0].t - 8;
  for (let i = 0; i < 400; i++) { const t = T0 + i * 0.02, k = i * 0.02, tip = k < 5.4 ? 0 : k < 6 ? 0.6 * (k - 5.4) / 0.6 : 0.6; mm.feed({ t, q: qmul(qaxis([1, 0, 0], tip), q0), r: [0, 0, 0], a: [0, 0, 0] }, t * 1000); }
  if (!mm.calibrated) throw new Error('calibration failed');
  return mm;
}
const swings = [], moves = [], cals = {};
for (const file of FILES) {
  const rows = fs.readFileSync(root + file, 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(r => r && r.q && r.r && r.at);
  const mm = calibrated(rows); cals[file] = { save: mm.save(), rows };
  const rate = rows.map(r => Math.hypot(...r.r)), T = rows.map(r => r.t);
  let cur = null, lastBetI = -1;
  rows.forEach((r, i) => {
    for (const e of mm.feed(r, r.at)) {
      const late = (r.at / 1000 - r.t - mm.off) * 1000;            // this sample's lateness over the least-delayed one (motion.js's own off)
      if (e.type === 'swing') {
        // gyro onset: walk back from the bet to where |r| was last under IDLE; interpolate. Never past the previous bet (a looped stroke)
        let k = i; while (k > lastBetI + 1 && rate[k] >= IDLE) k--;
        const on4 = rate[k] < IDLE && k < i ? T[k] + (T[k + 1] - T[k]) * (IDLE - rate[k]) / (rate[k + 1] - rate[k]) : NaN;
        const mv0 = r.t + late / 1000 - e.age / 1000;                // motion.js's take-off on the sensor clock (age = arrival - mv0)
        cur = { file, i, tBet: r.t, betAt: r.at, late, age: e.age, on4, mv0, reps: [], final: null, end: null, peak: 0, tPeak: r.t };
        swings.push(cur); lastBetI = i;
      }
      if (!cur) continue;
      if (e.type === 'swing' || e.type === 'swingFix') { const sp = clientOf(e);
        cur.reps.push({ dtArr: r.at - cur.betAt, dtSen: (r.t - cur.tBet) * 1000, power: e.power, raw: e.raw || 0, rom: e.rom || 0, back: e.back || 0, off: e.off || 0, dir: e.dir, lob: sp.lob, chop: e.chop || 0, age: e.age || 0, slice: sp.slice, fix: e.type === 'swingFix', final: !!e.final });
        if (e.final && !cur.final) cur.final = { t: r.t, at: r.at }; }
      if (e.type === 'swingEnd') { cur.end = { t: r.t, at: r.at, i }; cur = null; }
    }
  });
  // rest-separated gyro movements (test/real.mjs): a stretch at >= IDLE that peaks >= 9 rad/s
  let mv = null;
  rows.forEach((r, i) => { const w = rate[i];
    if (w >= IDLE) { if (!mv) mv = { file, t0: i ? T[i] - (T[i] - T[i - 1]) * (w - IDLE) / Math.max(w - rate[i - 1], 1e-6) : T[i], peak: 0, tPeak: T[i] }; mv.t1 = T[i]; if (w > mv.peak) { mv.peak = w; mv.tPeak = T[i]; } }
    else if (mv) { if (mv.peak >= 9) moves.push(mv); mv = null; } });
}
for (const s of swings) { s.scored = s.reps.some(r => r.final) && s.reps.some(r => r.power > 7); s.on = Number.isFinite(s.on4) ? s.on4 : s.mv0;
  const rows = cals[s.file].rows, R = j => Math.hypot(...rows[j].r), j1 = s.end ? s.end.i : s.i;
  let j = s.i; while (j > 0 && rows[j - 1].t >= s.on - 1e-9) j--;
  s.peak = 0; for (let k = j; k <= j1; k++) if (R(k) > s.peak) { s.peak = R(k); s.tPeak = rows[k].t; }   // the paddle's peak rate, take-off to swingEnd
  let k = s.i; while (k > j && R(k) >= DEFAULTS.TRIGGER) k--;                                            // where the rate last crossed TRIGGER on the way up
  s.on75 = R(k) < DEFAULTS.TRIGGER && k < s.i ? rows[k].t + (rows[k + 1].t - rows[k].t) * (DEFAULTS.TRIGGER - R(k)) / (R(k + 1) - R(k)) : NaN; }
const scored = swings.filter(s => s.scored && s.end);
const ms = x => x * 1000;
head(`A. motion.js on ${FILES.length} real captures: ${swings.length} swings, ${scored.length} scored (settled, power > 7). Sensor clock unless said`);
row('onset (|r| crosses 4 rad/s) -> bet', scored.map(s => ms(s.tBet - s.on4)), `(${scored.filter(s => !Number.isFinite(s.on4)).length} looped: no rest before)`);
row('onset (motion.js mv0) -> bet', scored.map(s => ms(s.tBet - s.mv0)));
row('  split: onset (4) -> |r| crosses TRIGGER 7.5', scored.map(s => ms(s.on75 - s.on4)), 'the slow part of the rise');
row('  split: TRIGGER crossing -> bet', scored.map(s => ms(s.tBet - s.on75)), `EARLY_T ${DEFAULTS.EARLY_T * 1000} ms from motion.js's take-off, or at once on a snap`);
row('bet sample arrival lateness (page)', scored.map(s => s.late), '+ BT_FLOOR ' + BT_FLOOR);
row('onset (4 rad/s) -> paddle peak rate', scored.map(s => ms(s.tPeak - s.on)));
row('bet -> paddle peak rate', scored.map(s => ms(s.tPeak - s.tBet)), 'negative = bet after the peak');
row('bet -> settled report (final), arrival', scored.map(s => s.final ? s.final.at - s.betAt : NaN), '(the re-aim trigger)');
row('bet already settled (final on the bet) %', [100 * scored.filter(s => s.reps[0].final).length / scored.length]);

// ---- (b) second-swing readiness ----
head('B. second-swing readiness (captures)');
row('bet -> swingEnd (swing open)', scored.map(s => s.end.at - s.betAt), 'arrival clock');
row('onset -> swingEnd (busy)', scored.map(s => ms(s.end.t - s.on)));
const byFile = f => swings.filter(s => s.file === f && s.end);
const gaps = [], restGaps = [];
for (const f of FILES) { const L = byFile(f); for (let i = 1; i < L.length; i++) { gaps.push(ms(L[i].on - L[i - 1].on)); restGaps.push(ms(L[i].on - L[i - 1].end.t)); } }
row('consecutive swings: onset -> next onset', gaps, `min ${Math.min(...gaps).toFixed(0)} ms (any pair, twitches too)`);
{ const g2 = []; for (const f of FILES) { const L = byFile(f).filter(s => s.scored); for (let i = 1; i < L.length; i++) g2.push(ms(L[i].on - L[i - 1].on)); }
  row('  both scored: onset -> next onset', g2, `min ${Math.min(...g2).toFixed(0)} ms`); }
row('consecutive swings: swingEnd -> next onset', restGaps, `min ${Math.min(...restGaps).toFixed(0)} ms (negative: next take-off measured from inside the last)`);
let lost = 0, ignored = 0; const lostGap = [];
for (const m of moves) {
  const own = swings.find(s => s.file === m.file && s.tBet >= m.t0 - 0.05 && s.tBet <= m.t1 + 0.02);
  if (own) continue;
  const open = swings.find(s => s.file === m.file && s.end && s.tBet <= m.t0 && s.end.t >= m.t0);
  if (open) { lost++; lostGap.push(ms(m.t0 - open.on)); } else ignored++;
}
console.log(`gyro movements (rest-separated, peak >= 9 rad/s): ${moves.length}; with no swing of their own: ${lost} began while a swing was still open (lost/merged), ${ignored} never triggered`);
if (lostGap.length) row('  ...lost ones: onset of open swing -> their onset', lostGap);

// splice: a second real stroke B starts out of A's follow-through without the hand ever getting slower than Tr: A runs until its rate
// has come down to Tr after its peak, B takes over from the sample where its own rise passes Tr (q re-rooted so the pose is continuous).
// Tr >= motion.js's let-go line (REARM_HOT 5.5 rad/s, or 0.6 x the peak) is a stroke chained straight out of the last one.
const pool = scored.filter(s => s.peak >= 9 && Number.isFinite(s.on4));
let seed = 11; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pairs = []; for (let k = 0; k < 60 && pool.length > 1; k++) { const A = pool[Math.floor(rnd() * pool.length)], B = pool[Math.floor(rnd() * pool.length)]; if (A !== B) pairs.push([A, B]); }
const spliceRes = [];
for (const Tr of [12, 9, 7, 6, 5.5, 5, 4.5, 4, 3]) {
  let two = 0, n = 0; const gapA = [], betB = [];
  for (const [A, B] of pairs) {
    const ra = cals[A.file].rows, rb = cals[B.file].rows, R = r => Math.hypot(...r.r);
    const iA0 = ra.findIndex(r => r.t >= A.on4 - 0.5), iPk = ra.findIndex(r => r.t >= A.tPeak);
    let iS = iPk; while (iS < ra.length && R(ra[iS]) > Tr) iS++;
    const iBo = rb.findIndex(r => r.t >= B.on4), iBp = rb.findIndex(r => r.t >= B.tPeak);
    let iB0 = iBo; while (iB0 < iBp && R(rb[iB0]) < Tr) iB0++;
    const iB1 = rb.findIndex(r => r.t >= (B.end ? B.end.t : B.tBet) + 0.4);
    if (iA0 < 0 || iS >= ra.length || ra[iS].t - A.tPeak > 1 || iBo < 0 || iB0 >= iBp || iB1 < 0) continue;
    const pre = ra.slice(iA0, iS + 1), D = qmul(pre[pre.length - 1].q, qconj(rb[iB0].q)), tS = pre[pre.length - 1].t + 0.02;
    const post = rb.slice(iB0, iB1).map((r, j) => ({ t: tS + j * 0.02, q: qmul(D, r.q), r: r.r, a: r.a }));
    const onB = tS - (rb[iB0].t - B.on4), pkB = tS + (B.tPeak - rb[iB0].t);                       // where B's own take-off would have been, re-timed (its slow start is under A's tail)
    const m = new MotionModel(); m.restore(cals[A.file].save); const ev = [];
    for (const s of [...pre, ...post]) for (const e of m.feed({ t: s.t, q: s.q, r: s.r, a: s.a }, s.t * 1000)) if (e.type === 'swing') ev.push(s.t);
    n++; gapA.push(ms(tS - A.on4));
    const bB = ev.find(t => t >= tS); if (ev.length >= 2 && bB != null && bB <= pkB + 0.06) { two++; betB.push(ms(bB - tS)); }   // B's own: at the latest just past B's peak (a later one is a trigger off its tail)
  }
  spliceRes.push({ Tr, n, two, gap: q(gapA, 0.5), gapMin: Math.min(...gapA), betB: q(betB, 0.5) });
}
console.log(`splice (${pairs.length} random pairs of real scored swings): B chained out of A's follow-through, the hand never slower than Tr; B counts only if its bet comes by B's peak + 60 ms`);
for (const s of spliceRes) console.log(`  Tr ${String(s.Tr).padStart(4)} rad/s: A onset -> B takes over p50 ${f1(s.gap)} ms (min ${s.gapMin.toFixed(0)}), second swing reported ${String(s.two).padStart(2)}/${s.n}` + (s.two ? `, its bet ${s.betB.toFixed(0)} ms after the hand-over (p50)` : ''));
{ const L = []; for (const f of FILES) { const S = byFile(f); for (let i = 1; i < S.length; i++) L.push({ gap: ms(S[i].on - S[i - 1].on), end: ms(S[i].on - S[i - 1].end.t), pk: S[i - 1].peak, pk2: S[i].peak, f, sc: (S[i - 1].scored ? 'S' : 't') + (S[i].scored ? 'S' : 't') }); }
  console.log('closest real pairs (onset gap / prev swingEnd -> next onset, peaks rad/s, S = scored t = twitch): ' + L.sort((a, b) => a.gap - b.gap).slice(0, 6).map(o => `${o.gap.toFixed(0)}/${o.end.toFixed(0)} ms (${o.pk.toFixed(0)}, ${o.pk2.toFixed(0)} ${o.sc})`).join('  ')); }

// ================= C. the real server =================
const hits = [];
if (E.SERVER !== '0') {
  const pick = scored.filter(s => s.reps.some(r => r.final));
  const proc = spawn('node', ['server/game.js'], { cwd: root, env: { ...E, PORT, AUTOBOT: '1', WIN_AT: '0', SWING_SERVE: '0', PODDLE_DB: ':memory:' }, stdio: ['ignore', 'ignore', 'inherit'] });
  await wait(900);
  const ws = new WebSocket('ws://localhost:' + PORT), log = [];
  const send = o => ws.readyState === 1 && ws.send(JSON.stringify(o));
  let side = null, armed = true, k = 0, pend = null, stateN = 0;
  ws.on('message', raw => { const ta = performance.now(), m = JSON.parse(raw); m.ta = ta; log.push(m);
    if (m.type === 'welcome') { side = m.side; send({ type: 'name', name: 'Probe' }); }
    if (m.type === 'hit' && m.side === side && pend) { pend.hitTa = ta; pend.hitI = log.length - 1; pend.hitT = m.t; pend.bet = m.bet; pend.hitP = m.p; hits.push(pend); pend.cur = true; pend = null; }   // one hit per swing sent (my auto-serve's 'hit' must not claim it again)
    if (m.type === 'hit' && m.side !== side) { armed = true; for (const h of hits) h.cur = false; }
    if (m.type === 'whiff' && pend && !pend.hitTa) { pend.whiff = m.why || true; hits.push(pend); pend = null; }
    if (m.type === 'launch' && m.by === side) for (const h of hits) if (h.cur && h.hitTa && ta - h.hitTa < 700 && m.w) (h.reaim ||= []).push(ta - h.hitTa);
    if (m.type !== 'state' || side == null) return;
    stateN++;
    const s = side === 0 ? 1 : -1, me = m.paddles[side], mine = m.live && m.v[2] * s > 0;
    for (const h of hits) if (h.hitTa && h.stateTa == null && m.t >= h.hitT - 1e-6 && m.v[2] * s < 0) { h.stateTa = ta; h.stateLag = (m.t - h.hitT) * 1000; }
    send({ type: 'paddle', x: mine ? m.p[0] : 0, y: mine ? Math.max(0.4, Math.min(1.4, m.p[1])) : 1, z: 6.5, q: [0, 0, 0, 1], r: 0 });
    if (!mine || !me || !armed || m.serving != null) return;
    const ahead = -(m.p[2] - me.z) * s, vz = Math.abs(m.v[2]) || 1;
    const sw = pick[k % pick.length], mode = MODE === 'both' ? (k % 2 ? 'natural' : 'inbox') : MODE;
    const lead = Math.max(0, sw.tPeak - sw.tBet - sw.late / 1000);    // natural: the bet goes out this long before the ball reaches the contact plane
    const go = mode === 'inbox' ? ahead <= 0.7 && ahead > -0.4 : (ahead - 0.25) / vz <= lead + 1 / 120;
    if (!go) return;
    armed = false; k++;
    if (pend && !pend.hitTa && !pend.whiff) hits.push(Object.assign(pend, { lost: true }));
    pend = { sw, mode, k, ahead, sentTa: performance.now(), sentI: log.length - 1 };
    for (const r of sw.reps) { const o = { type: 'swing', power: r.power, raw: r.raw, rom: r.rom, back: r.back, off: r.off, dir: r.dir, lob: r.lob, chop: r.chop, age: r.age, net: Math.round(2 * OWD), slice: r.slice, fix: r.fix, final: r.final };
      if (r.dtArr <= 0) send(o); else setTimeout(() => send(o), r.dtArr); }
  });
  const t0 = Date.now(); while (Date.now() - t0 < SECS * 1000) await wait(500);
  ws.close(); proc.kill();
  console.log(`\nC. server: ${Math.round(SECS)} s against Matt, ${stateN} state packets (${(stateN / SECS).toFixed(1)}/s), ${k} swings sent, ${hits.filter(h => h.hitTa).length} hits, ${hits.filter(h => h.whiff).length} whiffs, ${hits.filter(h => h.lost).length} no answer`);

  // ---- the hitter's screen: scene.js's own ball record + drawBall at 60 fps, messages arriving OWD after the server sent them ----
  class V3 { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } copy(o) { this.x = o.x; this.y = o.y; this.z = o.z; return this; }
    sub(o) { this.x -= o.x; this.y -= o.y; this.z -= o.z; return this; } length() { return Math.hypot(this.x, this.y, this.z); }
    addScaledVector(o, s) { this.x += o.x * s; this.y += o.y * s; this.z += o.z * s; return this; }
    lerp(o, a) { this.x += (o.x - this.x) * a; this.y += (o.y - this.y) * a; this.z += (o.z - this.z) * a; return this; }
    distanceToSquared(o) { return (this.x - o.x) ** 2 + (this.y - o.y) ** 2 + (this.z - o.z) ** 2; } }
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  function turnFrame(h, phase) {                                // ms from the 'hit' reaching the page to the first frame the drawn ball moves away
    const msgs = log.slice(Math.max(0, h.hitI - 90), h.hitI + 40).filter(m => m.type === 'state' || m.type === 'hit' || m.type === 'launch' || m.type === 'serve');
    const madeAt = serverClock().madeAt, vA = new V3(), s = side === 0 ? 1 : -1;
    const b = { p: [0, 1, 0], v: [0, 0, 0], live: false, stamp: 0, seen: false, snap: true, pos: new V3(0, 1, 0), vel: new V3(), core: new V3(0, 1, 0), err: new V3(), errT: 1, errDur: 0.1, blend: false, bounces: 0, kick: 0, curl: 0, held: false, spin: 0, arc: null, w: null, tS: NaN };
    const on = (m, now) => (m.type === 'state' ? ballState(b, m.p, m.v, m.live, madeAt(+m.t, now), m.spin, m, +m.t) : ballTake(b, m, t => madeAt(t, now)));
    const hitA = h.hitTa + OWD; let qi = 0, last = null, prevZ = null, F = 1000 / 60;
    let now = msgs[0].ta + OWD + phase * F;
    for (; now < hitA + 200; now += F) {
      while (qi < msgs.length && msgs[qi].ta + OWD <= now) { const m = msgs[qi++]; on(m, m.ta + OWD); }
      const dt = last == null ? 1 / 60 : clamp((now - last) / 1000, 0, 0.05); last = now;
      if (!b.live) continue;
      drawBall(b, vA, now, dt, -6.5);
      if (now >= hitA && prevZ != null && (b.pos.z - prevZ) * s < 0) return now - hitA;
      prevZ = b.pos.z;
    }
    return NaN;
  }
  for (const h of hits) if (h.hitTa) {
    h.proc = h.hitTa - h.sentTa;                                // loopback: socket -> server handler -> strike -> 'hit' back (includes any tick wait)
    h.tick = h.stateTa != null ? h.stateTa - h.hitTa : NaN;     // strike -> first state packet showing the new v
    h.frame = turnFrame(h, rnd());
    const s = h.sw, stage1 = ms(s.tBet - s.on) + s.late + BT_FLOOR;
    h.total = stage1 + OWD + h.proc + OWD + h.frame;
    h.totalRelay = h.total + 2 * OWD;
    h.totalMv0 = ms(s.tBet - s.mv0) + s.late + BT_FLOOR + OWD + h.proc + OWD + h.frame;
    h.viaState = stage1 + OWD + h.proc + h.tick + OWD + 8.3;    // had the screen waited for a state packet (mean frame wait)
  }
}

// ================= output =================
const H = hits.filter(h => h.hitTa && Number.isFinite(h.frame));
if (H.length) for (const mode of ['inbox', 'natural']) {
  const A = H.filter(h => h.mode === mode); if (!A.length) continue;
  head(`STAGES, swing -> visible hit, MODE=${mode} (${A.length} real hits; OWD ${OWD} ms${RELAY ? ', phone relay' : ''}; BT_FLOOR ${BT_FLOOR} ms)`);
  row('1a onset (4 rad/s) -> bet [sensor]', A.map(h => ms(h.sw.tBet - h.sw.on)));
  row('   (onset = motion.js mv0 -> bet)', A.map(h => ms(h.sw.tBet - h.sw.mv0)));
  row('1b bet sample arrival lateness [page]', A.map(h => h.sw.late + BT_FLOOR));
  if (RELAY) row('2a phone -> server -> tab relay (2 x OWD)', A.map(() => 2 * OWD));
  row('2b tab -> server (OWD)', A.map(() => OWD));
  row('2c server: swing in -> strike -> hit out', A.map(h => h.proc), `struck on arrival (<3 ms): ${A.filter(h => h.proc < 3).length}/${A.length}`);
  row('3a server -> tab hit event (OWD)', A.map(() => OWD));
  row('3b hit event -> drawn ball turns (60 fps)', A.map(h => h.frame));
  row('   (3c strike -> 1st state w/ new v, 60 Hz)', A.map(h => h.tick));
  row('TOTAL onset(4) -> drawn turn', A.map(h => RELAY ? h.totalRelay : h.total));
  if (!RELAY) row('   same with phone relay (+2 x OWD)', A.map(h => h.totalRelay));
  row('   onset(mv0) -> drawn turn', A.map(h => h.totalMv0 + (RELAY ? 2 * OWD : 0)));
  row('   had it waited for a state packet', A.map(h => h.viaState + (RELAY ? 2 * OWD : 0)));
  row('strike vs paddle peak (+ = after the peak)', A.map(h => ms(h.sw.tBet - h.sw.tPeak) + h.sw.late + BT_FLOOR + OWD + h.proc + (RELAY ? 2 * OWD : 0)));
  row('drawn turn vs paddle peak (+ = after)', A.map(h => ms(h.sw.tBet - h.sw.tPeak) + h.sw.late + BT_FLOOR + OWD + h.proc + OWD + h.frame + (RELAY ? 2 * OWD : 0)));
  row('hit -> re-aim launch at the hitter', A.flatMap(h => h.reaim || []), `${A.filter(h => h.reaim).length}/${A.length} hits re-aimed`);
}
const outPath = OUT || '/private/tmp/claude-501/-Users-danieltan/31d0d0a5-bb36-4fa4-9a15-70b8e3d89a32/scratchpad/lat/swinglat-baseline.json';
try { fs.mkdirSync(outPath.replace(/\/[^/]+$/, ''), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ cfg: { OWD, RELAY, BT_FLOOR, MODE, SECS, FILES }, splice: spliceRes,
    swings: swings.map(s => ({ file: s.file, scored: s.scored, on4: s.on4, mv0: s.mv0, tBet: s.tBet, late: s.late, age: s.age, tPeak: s.tPeak, peak: s.peak, final: s.final, end: s.end && { t: s.end.t, at: s.end.at }, betAt: s.betAt, reps: s.reps.length })),
    hits: hits.map(h => ({ file: h.sw.file, i: h.sw.i, mode: h.mode, whiff: h.whiff || null, lost: !!h.lost, bet: h.bet || 0, ahead: h.ahead, onsetToBet: ms(h.sw.tBet - h.sw.on), mv0ToBet: ms(h.sw.tBet - h.sw.mv0), late: h.sw.late,
      proc: h.proc, tick: h.tick, frame: h.frame, total: h.total, totalRelay: h.totalRelay, totalMv0: h.totalMv0, viaState: h.viaState, reaim: h.reaim || [], betToFinal: h.sw.final ? h.sw.final.at - h.sw.betAt : null, betToEnd: h.sw.end ? h.sw.end.at - h.sw.betAt : null })) }, null, 1));
  console.log('\nrows -> ' + outPath); } catch (e) { console.log('could not write rows: ' + e.message); }
process.exit(0);
