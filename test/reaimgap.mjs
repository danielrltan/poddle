// The re-aim gap: how far is a bet from the settled swing, what does the server really have at the contact tick, and could the
// settled report be FORECAST from what has arrived by then? (NOTES 63, 66, 154, 155, 222; the owner: "I'm still seeing the hit
// recalculation", "high latency between swings even with low ping")
//
// A. Offline: every real capture (data/live-play-1..3, live-swings) through the REAL web/motion.js on the samples' REAL arrival
//    times, with web/main.js's own lob/spin maths (clientOf, as test/reaim.mjs). Per movement: every report (bet, swingFix, settled)
//    with its arrival, and the model's own state after every sample (mm.sw: peak, sweep, rise...). A shadow MotionModel with
//    FIX_STEP -1 / FIX_GAP 0 reports its call on EVERY sample: "what motion.js would say right now".
// B. Live: every scored movement played at the REAL server (several in parallel, against Matt), timed like a player: its rate
//    PEAK (sensor clock, mapped to the arrival clock by the least-delayed sample) lands ALIGN_MS (+ a seeded human jitter) after
//    the ball reaches the contact plane (CONTACT m in front of the paddle). The server picks the strike tick. Logged: which
//    reports had been sent before the 'hit' came back (localhost: = had arrived at the strike), the struck n, the re-aim launch,
//    its landing shift and heading change.
// C. Stats + forecast: bet / latest-at-contact / settled in server units (n = effort(), dir, lob as sent), landing shift through
//    the server's own solve(); ridge fits from what is known at contact, cross-validated leave-one-capture-file-out.
//
// Usage: TEST_PORT=<base port> [SERVERS=6] [REPS=2] [SECS=200] [ALIGN_MS=30] [JITTER_MS=30] [NET_MS=13] [OUT=file.json]
//        [MODE=all|live|model] node test/reaimgap.mjs        (MODE=model re-reads OUT and only runs C)
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import { createRequire } from 'module';
import WebSocket from 'ws';
import { MotionModel, qaxis, qmul } from '../web/motion.js';
const root = new URL('..', import.meta.url).pathname, env = process.env, MODE = env.MODE || 'all';
const OUT = env.OUT || os.tmpdir() + '/reaim-baseline.json', BASE = +env.TEST_PORT || 8741;
const ALIGN = env.ALIGN_MS != null ? +env.ALIGN_MS : 30, JIT = env.JITTER_MS != null ? +env.JITTER_MS : 30, NET = env.NET_MS != null ? +env.NET_MS : 13;
const wait = ms => new Promise(r => setTimeout(r, ms)), DEG = Math.PI / 180;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

// ---- the server's own maths: solve() etc. are exported; effort/SMASH/sliced are lifted from its source, never copied by hand ----
process.env.PORT = String(BASE + 90);                          // the in-process copy listens too: keep it off the live ones
const S = createRequire(import.meta.url)('../server/game.js');
const gsrc = fs.readFileSync(root + 'server/game.js', 'utf8'), line = re => { const m = gsrc.match(re); if (!m) throw new Error('server/game.js moved: ' + re); return m[0]; };
const SV = new Function('clamp', [/const SMASH = [^;]+;/, /const SMASH_IN = [^;]+;/, /const effort = [^\n]+;/, /const underhand = lob => \{[^\n]+?\};/, /const sliced = [^;]+;/].map(line).join('\n') + '\nreturn { SMASH, effort, underhand, sliced };')(clamp);
const nOf = (power, final) => { const n = SV.effort(clamp((power - 6) / 28, 0, 1)); return final ? n : Math.min(n, SV.SMASH); };   // what the server strikes at (a bet never smashes)
const nRaw = power => SV.effort(clamp((power - 6) / 28, 0, 1));
// would the server re-aim a ball struck on h when settled report s arrives? (game.js, the m.fix branch: its thresholds)
const reaims = (h, s) => Math.abs(s.n - h.n) > 0.04 || (s.n > SV.SMASH) !== (h.n > SV.SMASH) || Math.abs(s.dir - h.dir) > 0.1 || Math.abs(s.lob - h.lob) > 0.1
  || Math.abs(SV.sliced(s.slice, s.lob) - SV.sliced(h.slice, h.lob)) > 0.2 || ((s.slice < 0) !== (h.slice < 0) && SV.sliced(s.slice, s.lob) > 0.3);
const P0 = [0, 1.0, 6.25];               // canonical contact: CONTACT (0.25 m) in front of a baseline paddle at 6.5, side 0
const landOf = (p, side, x) => S.solve(p, side, x.n, x.dir, x.lob, x.slice || 0, null, 0).land;   // curl 0: a bet never curls; a settled swoop is left out (says so)
const shiftOf = (p, side, a, b) => { const A = landOf(p, side, a), B = landOf(p, side, b); return Math.hypot(A[0] - B[0], A[1] - B[1]); };
const headOf = (p, side, a, b) => { const A = landOf(p, side, a), B = landOf(p, side, b), h = L => Math.atan2(L[0] - p[0], L[1] - p[2]); let d = (h(B) - h(A)) / DEG; while (d > 180) d -= 360; while (d < -180) d += 360; return Math.abs(d); };

// ---------------------------------------------------------------- A. offline extraction ----------------------------------------
const main = fs.readFileSync(root + 'web/main.js', 'utf8');
const a0 = main.indexOf('const roll = Math.max('), a1 = main.indexOf("game.send({ type: 'swing'", a0);
if (a0 < 0 || a1 < 0) throw new Error('web/main.js: the swing maths moved (anchors: "const roll = Math.max(" .. "game.send({ type: \'swing\'")');
const clientOf = new Function('e', main.slice(a0, a1) + '; return { slice, lob };');      // its OWN spin and lob maths
const fadeOf = r => { const k = clamp((r - 0.45) / 0.3, 0, 1); return 1 - k * k * (3 - 2 * k); };   // main.js fade(), for its swingEnd fallback report
const FILES = (env.FILES || 'live-play-1,live-play-2,live-play-3,live-swings').split(',');

function extract(file) {
  const rows = fs.readFileSync(root + 'data/' + file + '.jsonl', 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(r => r && r.q && r.r && Number.isFinite(r.at));
  // sensor clock -> arrival clock: the least-delayed sample within +-5 s (the two clocks drift up to ~50 ms over a capture)
  const off = rows.map(r => r.at - r.t * 1000), minOff = off.map((_, i) => { let m = Infinity; for (let j = Math.max(0, i - 250); j < Math.min(off.length, i + 250); j++) m = Math.min(m, off[j]); return m; });
  const mm = new MotionModel(), sh = new MotionModel({ FIX_STEP: -1, FIX_GAP: 0 }), q0 = rows[0].q, T0 = rows[0].t - 8;
  for (let i = 0; i < 400; i++) { const t = T0 + i * 0.02, k = i * 0.02, tip = k < 5.4 ? 0 : k < 6 ? 0.6 * (k - 5.4) / 0.6 : 0.6, s = { t, q: qmul(qaxis([1, 0, 0], tip), q0), r: [0, 0, 0], a: [0, 0, 0] };
    mm.feed(s, t * 1000 + off[0]); sh.feed({ ...s }, t * 1000 + off[0]); }
  if (!mm.calibrated) throw new Error(file + ': calibration failed');
  const movs = []; let cur = null, call = null, lastE = null, pr = null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i], evs = mm.feed(r, r.at), sevs = sh.feed({ ...r }, r.at);
    for (const e of sevs) { if (e.type === 'swing' || e.type === 'swingFix') { const c = clientOf(e); call = { at: r.at, power: e.power, dir: e.dir, lob: c.lob, slice: c.slice, final: !!e.final, bet: e.type === 'swing' }; } if (e.type === 'swingEnd') call = null; }
    let ended = null;
    for (const e of evs) {
      if (e.type === 'swing') { movs.push(cur = { file, key: file + '#' + movs.length, at0: r.at, t0: r.t, reps: [], snaps: [], sw: mm.sw || { peak: e.raw || 0, romPk: (e.rom || 0) * DEG, sweep: (e.rom || 0) * DEG, mv0: r.t - (e.age || 0) / 1000, tPk: r.t, ang0: mm.ang || 0 }, gap: 0, shadowBet: call && call.bet && call.at === r.at ? Math.abs(call.power - e.power) + Math.abs(call.dir - e.dir) : null }); }
      if (!cur) continue;
      if (e.type === 'swing' || e.type === 'swingFix') { const c = clientOf(e); lastE = e;
        cur.reps.push({ dt: r.at - cur.at0, power: e.power, raw: e.raw || 0, rom: e.rom || 0, back: e.back || 0, off: e.off || 0, dir: e.dir, lob: c.lob, chop: e.chop || 0, age: e.age || 0, slice: c.slice, fix: e.type === 'swingFix', final: !!e.final }); }
      if (e.type === 'swingEnd') ended = e;
    }
    const rate = Math.hypot(...r.r);
    if (cur) { const sw = cur.sw, prev = cur.snaps[cur.snaps.length - 1];
      if (prev) cur.gap = Math.max(cur.gap, r.at - cur.at0 - prev.dt);
      cur.snaps.push({ dt: r.at - cur.at0, rate, trend: pr ? (rate - pr.rate) / Math.max(1e-3, r.t - pr.t) * 0.02 : 0, t: r.t, peak: sw.peak, romPk: sw.romPk / DEG, sweep: sw.sweep / DEG, el: (r.t - sw.mv0) * 1000, rise: (sw.tPk - sw.mv0) * 1000, accM: mm.accM || 0, ang: ((mm.ang || 0) - sw.ang0) / DEG,
        pkAt: sw.tPk * 1000 + minOff[i], late: r.at - (r.t * 1000 + minOff[i]), tPk: sw.tPk, call: call ? { power: call.power, dir: call.dir, lob: call.lob, slice: call.slice, final: call.final } : null }); }
    if (ended && cur) {
      if (!cur.reps.some(x => x.final)) { const c = clientOf(lastE);    // main.js swingEnd fallback: the server still hears that it is over
        cur.reps.push({ ...cur.reps[cur.reps.length - 1], dt: r.at - cur.at0, power: ended.peak, lob: (lastE.lobRaw != null ? lastE.lobRaw : lastE.lob) * fadeOf(Math.abs(lastE.roll || 0)), slice: c.slice, fix: true, final: true, synth: true }); }
      const fin = cur.snaps.find(s => s.dt >= cur.reps.find(x => x.final).dt) || cur.snaps[cur.snaps.length - 1];
      cur.pkAt = fin.pkAt; cur.delta = cur.at0 - cur.pkAt;          // ms: the bet's arrival relative to the hand's real peak (< 0: before it)
      cur.sw = null; cur = null; }
    pr = { rate, t: r.t };
  }
  for (const m of movs) delete m.sw;
  return movs;
}

// ---------------------------------------------------------------- B. live replay ------------------------------------------------
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const hash = s => [...s].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261);
function probe(port, queue, deadline) {
  return new Promise(done => {
    const ws = new WebSocket('ws://localhost:' + port), out = []; let side = null, cool = 0, att = null, qi = 0, st = null, over = false;
    const close = () => { if (att) { out.push(att); att = null; } };
    const finish = () => { if (over) return; over = true; close(); try { ws.close(); } catch { /* gone */ } done(out); };
    const timer = setInterval(() => { if (performance.now() > deadline || (qi >= queue.length && !att)) { clearInterval(timer); finish(); } }, 100);
    ws.on('error', () => finish());
    ws.on('message', raw => { const m = JSON.parse(raw), now = performance.now();
      if (m.type === 'welcome') { side = m.side; ws.send(JSON.stringify({ type: 'name', name: 'Probe' })); }
      if (m.type === 'hit') {
        if (att && m.side === side && att.sent.length && !att.hit) att.hit = { at: now, n: m.n, kind: m.kind, bet: !!m.bet, p: m.p, v: m.v, spin: m.spin || 0, c: m.c || 0, t: m.t, side, padZ: st && st.paddles[side] ? st.paddles[side].z : null,
          sentBefore: att.sent.filter(s => s.at <= now).length, tcLeft: att.tcLast != null ? att.tcLast - now : null };
        else if (att && att.hit && m.side !== side) close();          // the reply: this shot is over
      }
      if (m.type === 'launch' && att && att.hit && m.by === side) att.launches.push({ at: now, n: m.n, land: m.land, kind: m.kind, p: m.p, v: m.v, w: m.w, t: m.t, c: m.c });
      if (m.type === 'whiff' && att && !att.hit) att.whiff = m.why || 'whiff';
      if (m.type === 'bounce' && att && att.hit && !att.bounce) att.bounce = m.p;
      if (m.type === 'point') close();
      if (m.type !== 'state' || side == null) return;
      st = m;
      const s = side === 0 ? 1 : -1, mine = m.live && m.v[2] * s > 0, me = m.paddles[side];
      ws.send(JSON.stringify({ type: 'paddle', x: mine ? m.p[0] : 0, y: mine ? Math.max(0.4, Math.min(1.4, m.p[1])) : 1, z: 6.5, q: [0, 0, 0, 1], r: 0 }));
      if (att && now - att.armAt > 2500) close();
      if (att && !att.hit && mine && me) { const ahead = -(m.p[2] - me.z) * s; att.tcLast = now + (ahead - 0.25) / Math.abs(m.v[2]) * 1000; }   // the ball's predicted arrival at the contact plane, latest packet before the hit
      if (att || !mine || !me || now < cool || qi >= queue.length || m.serving != null) return;
      const ahead = -(m.p[2] - me.z) * s, tc = (ahead - 0.25) / Math.abs(m.v[2]) * 1000;   // ms until the ball is at the contact plane (re-read every packet: a bounce slows it)
      const job = queue[qi], lead = tc + job.m.delta + ALIGN + job.jit;                     // when the bet must be sent so that the hand's peak meets it
      if (lead > 17) return;
      qi++; cool = now + 900;
      att = { key: job.m.key, file: job.m.file, rep: job.rep, jit: job.jit, armAt: now, tcAt: now + tc, sent: [], launches: [] };
      const a = att, t0 = now + Math.max(0, lead);
      for (const r of job.m.reps) setTimeout(() => { if (ws.readyState !== 1) return; a.sent.push({ at: performance.now(), dt: r.dt, final: r.final, fix: r.fix });
        ws.send(JSON.stringify({ type: 'swing', power: r.power, raw: r.raw, rom: r.rom, back: r.back, off: r.off, dir: r.dir, lob: r.lob, chop: r.chop, age: r.age, net: NET, slice: r.slice, fix: r.fix, final: r.final })); }, Math.max(0, t0 + r.dt - performance.now()));
    });
  });
}
async function live(movs) {
  const K = +env.SERVERS || 6, REPS = +env.REPS || 2, SECS = +env.SECS || 200, plan = [];
  for (let rep = 0; rep < REPS; rep++) for (const m of movs) { const u = rng(hash(m.key) + rep * 7919); const g = Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u()); plan.push({ m, rep, jit: g * JIT }); }
  const procs = [], queues = Array.from({ length: K }, () => []);
  plan.forEach((j, i) => queues[i % K].push(j));
  for (let k = 0; k < K; k++) procs.push(spawn('node', ['server/game.js'], { cwd: root, env: { ...process.env, PORT: String(BASE + k), AUTOBOT: '1', WIN_AT: '0', SWING_SERVE: '0' }, stdio: ['ignore', 'ignore', 'inherit'] }));
  await wait(1200);
  const deadline = performance.now() + SECS * 1000;
  const res = (await Promise.all(queues.map((q, k) => probe(BASE + k, q, deadline)))).flat();
  for (const p of procs) p.kill();
  console.log(`live: ${plan.length} planned (${movs.length} movements x ${REPS}), ${res.length} played on ${K} servers, ${res.filter(a => a.hit).length} hit, ${res.filter(a => a.whiff).length} whiffed`);
  return res;
}

// ---------------------------------------------------------------- C. analysis ---------------------------------------------------
const q = (a, p) => { const b = a.filter(Number.isFinite).sort((x, y) => x - y); return b.length ? b[Math.min(b.length - 1, Math.floor(p * (b.length - 1) + 1e-9))] : NaN; };
const mean = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '-');
const pc = (a, b) => (b ? Math.round(100 * a / b) + '%' : '-');
const dist = (a, d = 2) => `p50 ${f(q(a, 0.5), d)} p90 ${f(q(a, 0.9), d)} max ${f(q(a, 1), d)}`;
const rep2x = (r, final) => ({ n: nOf(r.power, final), dir: r.dir, lob: r.lob, slice: r.slice });
const settledOf = m => m.reps.find(r => r.final);
const latestBy = (m, dt) => { let L = m.reps[0]; for (const r of m.reps) if (r.dt <= dt + 1e-6) L = r; return L; };
const snapBy = (m, dt) => { let L = m.snaps[0]; for (const s of m.snaps) if (s.dt <= dt + 1e-6) L = s; return L; };

// features known at contact (dt ms after the bet's arrival, arrival clock)
const FEATS = ['nBet', 'dirBet', 'lobBet', 'nLat', 'dirLat', 'lobLat', 'nCall', 'dirCall', 'lobCall', 'peak', 'sweep', 'el', 'rise', 'rateRel', 'trend', 'accM', 'nfix'];
const SMALL = ['nCall', 'dirCall', 'lobCall', 'peak', 'sweep', 'el', 'rateRel', 'trend'];
function featsAt(m, dt) {
  const b = m.reps[0], L = latestBy(m, dt), s = snapBy(m, dt), c = s.call || { power: L.power, dir: L.dir, lob: L.lob };
  return { nBet: nRaw(b.power), dirBet: b.dir, lobBet: b.lob, nLat: nRaw(L.power), dirLat: L.dir, lobLat: L.lob, nCall: nRaw(c.power), dirCall: c.dir, lobCall: c.lob,
    peak: s.peak, sweep: s.sweep, el: s.el, rise: s.rise, rateRel: s.rate / Math.max(1, s.peak), trend: s.trend, accM: s.accM / 100, nfix: m.reps.filter(r => r.dt <= dt + 1e-6).length - 1 };
}
const TGT = { n: m => nRaw(settledOf(m).power), dir: m => settledOf(m).dir, lob: m => settledOf(m).lob };
// ridge with an unpenalised intercept, standardised on the training rows
function ridgeFit(X, y, lam) {
  const d = X[0].length, mu = Array(d).fill(0), sd = Array(d).fill(0), my = mean(y);
  for (const x of X) x.forEach((v, j) => (mu[j] += v / X.length)); for (const x of X) x.forEach((v, j) => (sd[j] += (v - mu[j]) ** 2 / X.length)); for (let j = 0; j < d; j++) sd[j] = Math.sqrt(sd[j]) || 1;
  const Z = X.map(x => x.map((v, j) => (v - mu[j]) / sd[j])), A = Array.from({ length: d }, (_, i) => Array.from({ length: d + 1 }, (_, j) => (j === d ? 0 : i === j ? lam : 0)));
  Z.forEach((z, k) => { for (let i = 0; i < d; i++) { for (let j = 0; j < d; j++) A[i][j] += z[i] * z[j]; A[i][d] += z[i] * (y[k] - my); } });
  for (let i = 0; i < d; i++) { let p = i; for (let k = i + 1; k < d; k++) if (Math.abs(A[k][i]) > Math.abs(A[p][i])) p = k; [A[i], A[p]] = [A[p], A[i]];
    for (let k = 0; k < d; k++) if (k !== i) { const r = A[k][i] / A[i][i]; for (let j = i; j <= d; j++) A[k][j] -= r * A[i][j]; } }
  const beta = A.map((row, i) => row[d] / row[i]);
  return x => my + x.reduce((s, v, j) => s + beta[j] * (v - mu[j]) / sd[j], 0);
}
const LAMS = [0.1, 1, 3, 10, 30, 100];
// a depth-2 regression tree (min 6 a leaf): the nonlinear check
function treeFit(X, y, depth = 2, minLeaf = 6) {
  const m = y.reduce((a, b) => a + b, 0) / y.length; if (depth === 0 || y.length < 2 * minLeaf) return () => m;
  let best = null; const sse = a => { const u = mean(a); return a.reduce((s, v) => s + (v - u) ** 2, 0); };
  for (let j = 0; j < X[0].length; j++) { const idx = X.map((_, i) => i).sort((a, b) => X[a][j] - X[b][j]);
    for (let k = minLeaf; k <= idx.length - minLeaf; k++) { if (X[idx[k - 1]][j] === X[idx[k]][j]) continue; const L = idx.slice(0, k).map(i => y[i]), Rr = idx.slice(k).map(i => y[i]), e = sse(L) + sse(Rr);
      if (!best || e < best.e) best = { e, j, th: (X[idx[k - 1]][j] + X[idx[k]][j]) / 2, li: idx.slice(0, k), ri: idx.slice(k) }; } }
  if (!best) return () => m;
  const l = treeFit(best.li.map(i => X[i]), best.li.map(i => y[i]), depth - 1, minLeaf), r = treeFit(best.ri.map(i => X[i]), best.ri.map(i => y[i]), depth - 1, minLeaf);
  return x => (x[best.j] < best.th ? l(x) : r(x));
}
function cvTree(rows, cols, tgt) { const files = [...new Set(rows.map(r => r.file))], pred = new Map();
  for (const fl of files) { const tr = rows.filter(r => r.file !== fl), te = rows.filter(r => r.file === fl); if (!tr.length) continue; const g = treeFit(tr.map(r => cols.map(c => r.x[c])), tr.map(r => r.y[tgt])); for (const r of te) pred.set(r, g(cols.map(c => r.x[c]))); }
  return pred; }
// leave-one-capture-file-out; lambda picked by an inner leave-one-file-out on the training files (or 5-fold when only one is left)
function cvPredict(rows, cols, tgt) {
  const files = [...new Set(rows.map(r => r.file))], pred = new Map(), lamOf = {};
  const fitBest = tr => { const fs2 = [...new Set(tr.map(r => r.file))], inner = fs2.length > 1 ? fs2.map(fl => [tr.filter(r => r.file !== fl), tr.filter(r => r.file === fl)]) : [0, 1, 2, 3, 4].map(k => [tr.filter((_, i) => i % 5 !== k), tr.filter((_, i) => i % 5 === k)]);
    let best = LAMS[0], be = Infinity; for (const lam of LAMS) { let e = 0, n = 0; for (const [a, b] of inner) { if (!a.length || !b.length) continue; const g = ridgeFit(a.map(r => cols.map(c => r.x[c])), a.map(r => r.y[tgt]), lam); for (const r of b) { e += Math.abs(g(cols.map(c => r.x[c])) - r.y[tgt]); n++; } } if (n && e / n < be) { be = e / n; best = lam; } }
    return { g: ridgeFit(tr.map(r => cols.map(c => r.x[c])), tr.map(r => r.y[tgt]), best), lam: best }; };
  for (const fl of files) { const tr = rows.filter(r => r.file !== fl), te = rows.filter(r => r.file === fl); if (!tr.length || !te.length) continue; const { g, lam } = fitBest(tr); lamOf[fl] = lam; for (const r of te) pred.set(r, g(cols.map(c => r.x[c]))); }
  return { pred, lamOf };
}
// one-feature shrink: settled ~ a + b * latest, fitted per fold
function cvShrink(rows, col, tgt) { const files = [...new Set(rows.map(r => r.file))], pred = new Map();
  for (const fl of files) { const tr = rows.filter(r => r.file !== fl), te = rows.filter(r => r.file === fl); if (!tr.length) continue; const g = ridgeFit(tr.map(r => [r.x[col]]), tr.map(r => r.y[tgt]), 1e-6); for (const r of te) pred.set(r, g([r.x[col]])); }
  return pred; }

function analyse(data) {
  const { movs, hits: atts } = data, lines = [], say = s => { lines.push(s); console.log(s); };
  const all = movs, scored = movs.filter(m => m.reps.some(r => r.final) && m.reps.some(r => r.power > 7));
  const perFile = FILES.map(fl => `${fl} ${all.filter(m => m.file === fl).length}/${scored.filter(m => m.file === fl).length}`).join(', ');
  say(`\n=== data: ${all.length} movements reported by motion.js, ${scored.length} scored (some report > 7, settled) — per file movements/scored: ${perFile}`);
  say(`    ${scored.filter(m => m.reps.some(r => r.synth)).length} settled only by main.js's swingEnd fallback; ${scored.filter(m => m.reps[0].final).length} called settled on the first report; shadow bet == real bet: ${scored.filter(m => m.shadowBet != null && m.shadowBet < 1e-9).length}/${scored.length}`);
  say(`    arrival stalls inside a movement (> 100 ms between samples): ${scored.filter(m => m.gap > 100).length} (worst ${f(Math.max(...scored.map(m => m.gap)), 0)} ms)`);
  say(`    NOTE: ${scored.length} swings, not hundreds. live-play-2 holds no swings; live-swings is the labelled flick / wide drill (a style shift, not free play): 3 real folds.`);

  // --- 1. the gap, per movement (offline) ---
  const bet = m => rep2x(m.reps[0], m.reps[0].final), set = m => rep2x(settledOf(m), true);
  const bs = scored.filter(m => !m.reps[0].final);
  say(`\n=== 1. bet -> settled, per movement (offline, arrival clock; n in server units = effort(), the bet capped at SMASH as the server does)`);
  say(`  bet->settled arrival: ${dist(bs.map(m => settledOf(m).dt), 0)} ms;  bet arrival vs the hand's real peak: ${dist(bs.map(m => m.delta), 0)} ms (< 0 = before it)`);
  { const fs1 = bs.map(m => { const st = settledOf(m), sn = snapBy(m, st.dt); return { wait: (sn.t - sn.tPk) * 1000, late: sn.late, after: m.at0 + st.dt - m.pkAt }; });
    say(`  settled arrival after the hand's real peak: ${dist(fs1.map(x => x.after), 0)} ms = motion.js waiting to call the peak "past" (sensor clock) ${dist(fs1.map(x => x.wait), 0)} ms + that sample's arrival lateness ${dist(fs1.map(x => x.late), 0)} ms`); }
  say(`  in-between swingFix reports before the settled one: ${bs.filter(m => m.reps.some(r => r.fix && !r.final)).length}/${bs.length} movements (${dist(bs.map(m => m.reps.filter(r => r.fix && !r.final).length), 0)})`);
  say(`  |n bet - settled| ${dist(bs.map(m => Math.abs(bet(m).n - set(m).n)))};  |dir| ${dist(bs.map(m => Math.abs(bet(m).dir - set(m).dir)))};  |lob| ${dist(bs.map(m => Math.abs(bet(m).lob - set(m).lob)))}`);
  say(`  re-aim due (server thresholds) for ${bs.filter(m => reaims(bet(m), set(m))).length}/${bs.length};  landing shift (solve() at a canonical contact, curl left out) ${dist(bs.map(m => shiftOf(P0, 0, bet(m), set(m))))} m, heading ${dist(bs.map(m => headOf(P0, 0, bet(m), set(m))), 1)} deg`);

  // --- 2. live: what the server really did ---
  const H = atts.filter(a => a.hit), mk = new Map(scored.map(m => [m.key, m]));
  for (const a of H) { const m = mk.get(a.key), h = a.hit, sent0 = a.sent[0] ? a.sent[0].at : h.at;
    a.cdt = h.at - sent0;                                         // contact, ms after the bet reached the server (localhost)
    a.path = a.cdt < 4 ? 'on arrival' : 'later tick';
    const sent = a.sent.filter(s => s.at <= h.at), last = sent[sent.length - 1];
    a.struckBy = !last ? 'none' : last.final ? 'settled' : last.fix ? 'mid fix' : 'bet';
    a.setAfter = (() => { const s = a.sent.find(x => x.final); return s ? s.at - h.at : null; })();     // contact -> settled report, ms
    const re = a.launches.find(l => l.n != null);
    const g = S.gOf(h.spin), T = S.fallLeft(h.p[1], h.v[1], g), land0 = [h.p[0] + h.v[0] * T + 0.5 * h.c * T * T, h.p[2] + h.v[2] * T];
    a.land0 = land0; a.reaim = re ? { dtHit: re.at - h.at, shift: Math.hypot(re.land[0] - land0[0], re.land[1] - land0[1]), gone: Math.hypot(re.p[0] - h.p[0], re.p[2] - h.p[2]) } : null;
    if (re) { const nb = []; for (let k = 0; re.w && k < re.w.length; k += 4) if (Math.abs(re.w[k + 3] - re.t) < 1e-9) nb.push([re.w[k], re.w[k + 1]]);
      const v1 = [re.v[0] + nb.reduce((s, b) => s + b[0], 0), re.v[2] + nb.reduce((s, b) => s + b[1], 0)]; let d = (Math.atan2(v1[0], v1[1]) - Math.atan2(re.v[0], re.v[2])) / DEG; while (d > 180) d -= 360; while (d < -180) d += 360;
      a.reaim.head = Math.abs(d); a.reaim.speed = Math.hypot(...v1) / Math.hypot(re.v[0], re.v[2]); }
    if (a.bounce && !re) a.bounceOff = Math.hypot(a.bounce[0] - land0[0], a.bounce[2] - land0[1]);
    if (m) { const S1 = set(m), struck = { n: h.n, dir: (latestBy(m, a.cdt) || m.reps[0]).dir, lob: latestBy(m, a.cdt).lob, slice: latestBy(m, a.cdt).slice }, B = bet(m);
      a.proxy = { shift: shiftOf(h.p, h.side, struck, S1), betShift: shiftOf(h.p, h.side, B, S1), due: reaims(struck, S1), betDue: reaims(B, S1) }; }
  }
  const R = H.filter(a => a.reaim);
  { const only = (m, k) => { const B = bet(m), S1 = set(m); return { ...B, [k]: S1[k] }; };
    say(`  landing shift left if ONLY power were right ${dist(bs.map(m => shiftOf(P0, 0, only(m, 'n'), set(m))))} m; only dir ${dist(bs.map(m => shiftOf(P0, 0, only(m, 'dir'), set(m))))}; only lob ${dist(bs.map(m => shiftOf(P0, 0, only(m, 'lob'), set(m))))}`); }
  say(`\n=== 2. live, at the real server (${H.length} struck hits of ${atts.length} swings played; ${atts.filter(a => a.whiff).length} whiffs; peak timed ALIGN ${ALIGN} ms after the ball reaches the contact plane, jitter sd ${JIT} ms, net ${NET} ms)`);
  say(`  re-aimed after contact: ${R.length}/${H.length} (${pc(R.length, H.length)});  landing shift ${dist(R.map(a => a.reaim.shift))} m;  heading change ${dist(R.map(a => a.reaim.head), 1)} deg;  speed x${dist(R.map(a => a.reaim.speed))}`);
  say(`  re-aim launch came ${dist(R.map(a => a.reaim.dtHit), 0)} ms after the hit, the ball had gone ${dist(R.map(a => a.reaim.gone))} m`);
  say(`  contact -> settled report: ${dist(H.filter(a => a.setAfter != null).map(a => a.setAfter), 0)} ms (< 0: settled before contact); settled before contact on ${H.filter(a => a.setAfter != null && a.setAfter <= 0).length}/${H.length}`);
  say(`  strike tick: on the bet's arrival ${H.filter(a => a.path === 'on arrival').length}, on a later tick ${H.filter(a => a.path === 'later tick').length} (contact ${dist(H.map(a => a.cdt), 0)} ms after the bet)`);
  say(`  what had arrived at contact: bet only ${H.filter(a => a.struckBy === 'bet').length}, a mid swingFix ${H.filter(a => a.struckBy === 'mid fix').length}, the settled report ${H.filter(a => a.struckBy === 'settled').length}`);
  say(`  where it was struck: ball ${dist(H.filter(a => a.hit.padZ != null).map(a => -(a.hit.p[2] - a.hit.padZ) * (a.hit.side === 0 ? 1 : -1)))} m in front of the paddle (CONTACT 0.25, box front 1.6); ${dist(H.filter(a => a.hit.tcLeft != null).map(a => a.hit.tcLeft), 0)} ms before the ball would have reached the contact plane`);
  const due = H.filter(a => a.proxy && a.proxy.due);
  say(`  settled differs past the re-aim thresholds on ${due.length}; of those NOT re-aimed (too late: window/gate/bounce): ${due.filter(a => !a.reaim).length}`);
  const val = R.filter(a => a.proxy);
  say(`  proxy check (solve() landing delta vs the live re-aim shift, same hits): median |diff| ${f(q(val.map(a => Math.abs(a.proxy.shift - a.reaim.shift)), 0.5))} m, p90 ${f(q(val.map(a => Math.abs(a.proxy.shift - a.reaim.shift)), 0.9))} m (live p50 ${f(q(val.map(a => a.reaim.shift), 0.5))} vs proxy ${f(q(val.map(a => a.proxy.shift), 0.5))})`);
  say(`  un-re-aimed balls bounced ${dist(H.filter(a => a.bounceOff != null).map(a => a.bounceOff))} m from the struck landing (sanity of land0)`);

  // --- 3. latest-at-contact vs bet ---
  say(`\n=== 3. strike with the LATEST report at contact (the server already folds a pre-contact fix into the swing) vs the bet alone`);
  const P = H.filter(a => a.proxy);
  say(`  live contact: re-aim due ${P.filter(a => a.proxy.due).length}/${P.length} (latest) vs ${P.filter(a => a.proxy.betDue).length}/${P.length} (bet only); landing shift latest ${dist(P.map(a => a.proxy.shift))} vs bet ${dist(P.map(a => a.proxy.betShift))} m`);
  say(`  COUNTERFACTUAL server that WAITS to strike until the hand's peak + d (contact = max(bet arrival, peak + d), arrival clock; the live server strikes on the bet's arrival, section 2); shift = solve() landing delta at a canonical contact:`);
  say(`     d ms | latest is: bet / mid fix / settled | re-aim due latest / bet | shift latest p50 p90  | shift bet p50 p90`);
  for (const d of [-80, -40, -20, 0, 20, 40]) { const rs = bs.map(m => { const dt = Math.max(0, m.pkAt + d - m.at0), L = latestBy(m, dt), Lx = rep2x(L, L.final), S1 = set(m); return { kind: L.final ? 's' : L.fix ? 'f' : 'b', due: reaims(Lx, S1), bdue: reaims(bet(m), S1), sh: shiftOf(P0, 0, Lx, S1), bsh: shiftOf(P0, 0, bet(m), S1) }; });
    say(`     ${String(d).padStart(4)} | ${rs.filter(r => r.kind === 'b').length} / ${rs.filter(r => r.kind === 'f').length} / ${rs.filter(r => r.kind === 's').length}`.padEnd(48) + `| ${rs.filter(r => r.due).length} / ${rs.filter(r => r.bdue).length}`.padEnd(26) + `| ${f(q(rs.map(r => r.sh), 0.5))} ${f(q(rs.map(r => r.sh), 0.9))}`.padEnd(22) + `| ${f(q(rs.map(r => r.bsh), 0.5))} ${f(q(rs.map(r => r.bsh), 0.9))}`); }

  // --- 4. forecast the settled report from what is known at contact ---
  say(`\n=== 4. forecast the settled report from what has arrived by contact (ridge, leave-one-capture-file-out; ${bs.length} swings, ${[...new Set(bs.map(m => m.file))].length} folds: small, read as indicative)`);
  say(`  +0 = the real contact (the bet's arrival). +20/+40/+60/peak arrival = a COUNTERFACTUAL server that waits that long before striking.`);
  const horizons = [['bet arrival (+0)', () => 0], ['+20 ms', () => 20], ['+40 ms', () => 40], ['+60 ms', () => 60], ['peak arrival', m => Math.max(0, -m.delta)]];
  const fc = { horizons: {} };
  for (const [name, hz] of horizons) {
    const rows = bs.map(m => { const dt = hz(m), L = latestBy(m, dt); return { m, file: m.file, dt, settledIn: L.final, x: featsAt(m, dt), y: { n: TGT.n(m), dir: TGT.dir(m), lob: TGT.lob(m) }, L }; });
    const model = {}; for (const t of ['n', 'dir', 'lob']) { model[t] = { big: cvPredict(rows, FEATS, t), small: cvPredict(rows, SMALL, t), shrink: cvShrink(rows, t === 'n' ? 'nLat' : t + 'Lat', t), tree: cvTree(rows, SMALL, t) }; }
    const est = (r, how) => { if (r.settledIn) return { n: r.y.n, dir: r.y.dir, lob: r.y.lob };     // settled before contact: nothing to forecast
      if (how === 'bet') return { n: r.x.nBet, dir: r.x.dirBet, lob: r.x.lobBet }; if (how === 'latest') return { n: r.x.nLat, dir: r.x.dirLat, lob: r.x.lobLat }; if (how === 'call') return { n: r.x.nCall, dir: r.x.dirCall, lob: r.x.lobCall };
      const o = {}; for (const t of ['n', 'dir', 'lob']) { const v = how === 'shrink' || how === 'tree' ? model[t][how].get(r) : model[t][how].pred.get(r); o[t] = v == null ? r.x[t === 'n' ? 'nLat' : t + 'Lat'] : v; } return o; };
    say(`  -- contact at ${name}: settled already in for ${rows.filter(r => r.settledIn).length}/${rows.length}; lambda (n) per held-out file: ${JSON.stringify(model.n.big.lamOf)}`);
    say(`     model           |n err| p50/p90   |dir| p50/p90   |lob| p50/p90   re-aim due   shift p50/p90 max (m)   per-file mean shift`);
    fc.horizons[name] = {};
    for (const how of ['bet', 'latest', 'call', 'shrink', 'small', 'big', 'tree']) {
      const e = rows.map(r => { const o = est(r, how), struck = { n: r.settledIn ? o.n : Math.min(clamp(o.n, 0, 1), SV.SMASH), dir: clamp(o.dir, -1, 1), lob: clamp(o.lob, 0, 1), slice: r.L.slice }, S1 = { n: r.y.n, dir: r.y.dir, lob: r.y.lob, slice: settledOf(r.m).slice };
        return { file: r.file, en: Math.abs(o.n - r.y.n), ed: Math.abs(o.dir - r.y.dir), el: Math.abs(o.lob - r.y.lob), due: reaims(struck, S1), sh: shiftOf(P0, 0, struck, S1) }; });
      fc.horizons[name][how] = e;
      const pf = [...new Set(e.map(x => x.file))].map(fl => `${fl.replace('live-', '')} ${f(mean(e.filter(x => x.file === fl).map(x => x.sh)))}`).join(', ');
      say(`     ${(how === 'tree' ? 'tree depth 2' : how === 'big' ? 'ridge (all ' + FEATS.length + ')' : how === 'small' ? 'ridge (' + SMALL.length + ')' : how === 'shrink' ? 'a + b * latest' : how === 'call' ? 'motion.js now' : how === 'latest' ? 'latest report' : 'bet as-is').padEnd(16)}  ${f(q(e.map(x => x.en), 0.5))}/${f(q(e.map(x => x.en), 0.9))}`.padEnd(37) + `${f(q(e.map(x => x.ed), 0.5))}/${f(q(e.map(x => x.ed), 0.9))}`.padEnd(16) + `${f(q(e.map(x => x.el), 0.5))}/${f(q(e.map(x => x.el), 0.9))}`.padEnd(16) + `${e.filter(x => x.due).length}/${e.length}`.padEnd(13) + `${f(q(e.map(x => x.sh), 0.5))}/${f(q(e.map(x => x.sh), 0.9))} ${f(q(e.map(x => x.sh), 1))}`.padEnd(24) + pf);
    }
  }
  // the same, at the LIVE contact of every played hit (each hit a row; folds by file)
  {
    const rows = P.map(a => { const m = mk.get(a.key), L = latestBy(m, a.cdt); return { a, m, file: m.file, settledIn: L.final, x: featsAt(m, a.cdt), y: { n: TGT.n(m), dir: TGT.dir(m), lob: TGT.lob(m) }, L }; }).filter(r => !r.m.reps[0].final);
    const model = {}; for (const t of ['n', 'dir', 'lob']) model[t] = cvPredict(rows, SMALL, t);
    const e = rows.map(r => { const o = r.settledIn ? r.y : { n: model.n.pred.get(r), dir: model.dir.pred.get(r), lob: model.lob.pred.get(r) }, S1 = { ...r.y, slice: settledOf(r.m).slice };
      const struck = { n: r.settledIn ? o.n : Math.min(clamp(o.n, 0, 1), SV.SMASH), dir: clamp(o.dir, -1, 1), lob: clamp(o.lob, 0, 1), slice: r.L.slice };
      return { due: reaims(struck, S1), sh: shiftOf(r.a.hit.p, r.a.hit.side, struck, S1), lat: r.a.proxy.shift, betSh: r.a.proxy.betShift }; });
    say(`  -- at each hit's LIVE contact (${rows.length} hits): forecast ridge(${SMALL.length}) shift ${dist(e.map(x => x.sh))} m, re-aim due ${e.filter(x => x.due).length}; latest report ${dist(e.map(x => x.lat))}; bet ${dist(e.map(x => x.betSh))}`);
    fc.live = e;
  }
  return { lines, fc };
}

// ---------------------------------------------------------------- run -----------------------------------------------------------
let data;
if (MODE === 'model') data = JSON.parse(fs.readFileSync(OUT, 'utf8'));
else {
  const movs = FILES.flatMap(extract);
  const scored = movs.filter(m => m.reps.some(r => r.final) && m.reps.some(r => r.power > 7));
  console.log(`${movs.length} movements, ${scored.length} scored, from ${FILES.join(', ')}`);
  const hits = await live(scored);
  data = { at: new Date().toISOString(), config: { ALIGN, JIT, NET, SERVERS: +env.SERVERS || 6, REPS: +env.REPS || 2, FILES }, movs, hits };
  fs.writeFileSync(OUT, JSON.stringify(data)); console.log('raw rows -> ' + OUT);
}
if (MODE !== 'live') { const { lines, fc } = analyse(data); data.analysis = { lines, live: fc.live, horizons: fc.horizons }; fs.writeFileSync(OUT, JSON.stringify(data)); }
process.exit(0);
