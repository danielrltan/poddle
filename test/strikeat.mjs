// Strike at the paddle, measured on the real captures (NOTES 265; ported from the evaluation's counterfactual harness, which built patched
// copies of the server: the real server now does it, STRIKE_WAIT). Every scored movement of data/live-play-1..3 and live-swings goes through the
// REAL web/motion.js on its real arrival times (web/main.js's own lob/spin maths), and is played at the REAL server against Matt, timed like a
// player: the hand's rate PEAK lands ALIGN ms (+ a seeded human jitter) after the ball reaches the contact plane, and every report reaches the
// server OWD ms after the tab sent it. Per combo: re-aim share and size, when the remaining re-aims come, where the ball is struck, the server's
// wait, onset -> drawn turn, the drawn turn against the drawn paddle's peak, kinds and smashes, whiffs (PADX: wide balls), Matt's return rate.
//
// Usage: [STATS_KEY=k: also print each server's /api/swingtime] TEST_PORT=9520 COMBOS="wait:align:level,..." [PER=2] [REPS=1] [SECS=200] [OWD=6.5] [JITTER_MS=30] [SEED=0] [PADX=0] [OUT=file.json]
//          wait 0 = STRIKE_WAIT=0 (today's model), 1 = STRIKE_WAIT=1; align ms; level wire value (0 Rookie, 1 Club, 3 Tour, 2 Pro);
//          a 4th field sets REPLAN_HUMAN for that combo (1:-60:1:0.45). Matt's rubber band is pinned (BAND1) and Math.random is seeded
//          (test/seedrand.cjs; SEED + the server's index), so the levels are measured, not the score.
//        ONLY=smash: only the movements whose settled report is a smash (Matt's return rate on smashes per level, NOTES 265).
//        MODE=report IN=a.json,b.json   re-reads saved runs.
// Ports: TEST_PORT .. TEST_PORT + combos x PER - 1 (the servers), + 1 for the in-process copy this file requires for solve().
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import { createRequire } from 'module';
import WebSocket from 'ws';
import { MotionModel, qaxis, qmul } from '../web/motion.js';
const root = new URL('..', import.meta.url).pathname, env = process.env, MODE = env.MODE || 'live';
const BASE = +env.TEST_PORT || 9520, OWD = env.OWD != null ? +env.OWD : 6.5, JIT = env.JITTER_MS != null ? +env.JITTER_MS : 30;
const OUT = env.OUT || os.tmpdir() + '/strikeat.json';
const COMBOS = (env.COMBOS || '').split(',').filter(Boolean).map(s => { const [w, align, level, replan] = s.split(':'); return { wait: w === '1', align: +align, level: +level, replan, tag: s }; });
const PER = +env.PER || 2;
const wait = ms => new Promise(r => setTimeout(r, ms)), DEG = Math.PI / 180;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

// ---- the server's own maths (the in-process copy listens: keep it on its own port) ----
process.env.PORT = String(BASE + Math.max(1, COMBOS.length * PER));
const S = createRequire(import.meta.url)('../server/game.js');
const gsrc = fs.readFileSync(root + 'server/game.js', 'utf8'), line = re => { const m = gsrc.match(re); if (!m) throw new Error('server/game.js moved: ' + re); return m[0]; };
const SV = new Function('clamp', [/const SMASH = [^;]+;/, /const SMASH_IN = [^;]+;/, /const effort = [^\n]+;/].map(line).join('\n') + '\nreturn { SMASH, effort };')(clamp);
const nOf = (power, final) => { const n = SV.effort(clamp((power - 6) / 28, 0, 1)); return final ? n : Math.min(n, SV.SMASH); };

// ---- every scored movement of the captures, as web/motion.js reports it ----
const main = fs.readFileSync(root + 'web/main.js', 'utf8');
const a0 = main.indexOf('const roll = Math.max('), a1 = main.indexOf("game.send({ type: 'swing'", a0);
if (a0 < 0 || a1 < 0) throw new Error('web/main.js: the swing maths moved');
const clientOf = new Function('e', main.slice(a0, a1) + '; return { slice, lob };');
const fadeOf = r => { const k = clamp((r - 0.45) / 0.3, 0, 1); return 1 - k * k * (3 - 2 * k); };
const FILES = (env.FILES || 'live-play-1,live-play-2,live-play-3,live-swings').split(',');
function extract(file) {
  const rows = fs.readFileSync(root + 'data/' + file + '.jsonl', 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(r => r && r.q && r.r && Number.isFinite(r.at));
  const off = rows.map(r => r.at - r.t * 1000), minOff = off.map((_, i) => { let m = Infinity; for (let j = Math.max(0, i - 250); j < Math.min(off.length, i + 250); j++) m = Math.min(m, off[j]); return m; });
  const mm = new MotionModel({}), q0 = rows[0].q, T0 = rows[0].t - 8;
  for (let i = 0; i < 400; i++) { const t = T0 + i * 0.02, k = i * 0.02, tip = k < 5.4 ? 0 : k < 6 ? 0.6 * (k - 5.4) / 0.6 : 0.6; mm.feed({ t, q: qmul(qaxis([1, 0, 0], tip), q0), r: [0, 0, 0], a: [0, 0, 0] }, t * 1000 + off[0]); }
  if (!mm.calibrated) throw new Error(file + ': calibration failed');
  const movs = []; let cur = null, lastE = null;
  const IDLE = mm.c.ROM_IDLE, rate = rows.map(r => Math.hypot(...r.r));
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i], evs = mm.feed(r, r.at); let ended = null; mm.pose(r.at);      // pose(): the drawn paddle's delay D moves as the page draws it (main.js calls it every frame)
    for (const e of evs) {
      if (e.type === 'swing') {
        let k = i; while (k > 0 && rate[k] >= IDLE && (!movs.length || k > movs[movs.length - 1].i + 1)) k--;      // gyro onset: |r| last under ROM_IDLE (swinglat.mjs)
        const on4 = rate[k] < IDLE && k < i ? rows[k].t + (rows[k + 1].t - rows[k].t) * (IDLE - rate[k]) / (rate[k + 1] - rate[k]) : NaN, sw = mm.sw;
        movs.push(cur = { file, i, key: file + '@' + r.at, at0: r.at, t0: r.t, reps: [], on4, mv0: sw ? sw.mv0 : r.t - (e.age || 0) / 1000, late: r.at - (r.t * 1000 + minOff[i]),
          D: (mm.D || 0) * 1000, peakMax: 0, tPkMax: r.t, swRef: sw });   // D: the drawn paddle's delay behind the hand at the bet (NOTES 237)
      }
      if (!cur) continue;
      if (e.type === 'swing' || e.type === 'swingFix') { const c = clientOf(e); lastE = e;
        cur.reps.push({ dt: r.at - cur.at0, power: e.power, raw: e.raw || 0, rom: e.rom || 0, back: e.back || 0, off: e.off || 0, dir: e.dir, lob: c.lob, chop: e.chop || 0, age: e.age || 0, slice: c.slice, fix: e.type === 'swingFix', final: !!e.final }); }
      if (e.type === 'swingEnd') ended = e;
    }
    if (cur && rate[i] > cur.peakMax) { cur.peakMax = rate[i]; cur.tPkMax = r.t; }
    if (ended && cur) {
      if (!cur.reps.some(x => x.final)) { const c = clientOf(lastE);
        cur.reps.push({ ...cur.reps[cur.reps.length - 1], dt: r.at - cur.at0, power: ended.peak, lob: (lastE.lobRaw != null ? lastE.lobRaw : lastE.lob) * fadeOf(Math.abs(lastE.roll || 0)), slice: c.slice, fix: true, final: true, synth: true }); }
      const sw = cur.swRef; cur.tPk = sw ? sw.tPk : cur.tPkMax;                       // the hand's real peak, on the arrival clock (least-delayed mapping)
      cur.pkAt = cur.tPk * 1000 + minOff[i]; cur.delta = cur.at0 - cur.pkAt;
      delete cur.swRef; cur = null; }
  }
  return movs.filter(m => m.reps.some(r => r.final) && m.reps.some(r => r.power > 7));
}

// ---- stats helpers ----
const q = (a, p) => { const b = a.filter(Number.isFinite).sort((x, y) => x - y); return b.length ? b[Math.min(b.length - 1, Math.floor(p * (b.length - 1) + 1e-9))] : NaN; };
const mean = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '-');
const pc = (a, b) => (b ? Math.round(100 * a / b) + '%' : '-');
const dist = (a, d = 2) => `p50 ${f(q(a, 0.5), d)} p90 ${f(q(a, 0.9), d)} max ${f(q(a, 1), d)}`;
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const hash = s => [...s].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261);
const gauss = u => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u());
const kinds = ['drive', 'lob', 'dink', 'smash', 'slice', 'tap'];
const mix = xs => kinds.map(k => `${k} ${pc(xs.filter(x => x === k).length, xs.length)}`).join(', ');
const settledOf = m => { for (let i = m.reps.length - 1; i >= 0; i--) if (m.reps[i].final) return m.reps[i]; return null; };

// ---- live: the probe swings each movement at the ball ----
function probe(port, queue, deadline, level) {
  return new Promise(done => {
    const ws = new WebSocket('ws://localhost:' + port), out = []; let side = null, cool = 0, att = null, qi = 0, st = null, over = false;
    const close = why => { if (att) { att.end = why; out.push(att); att = null; } };
    const finish = () => { if (over) return; over = true; close('timeout'); try { ws.close(); } catch { /* gone */ } done(out); };
    const timer = setInterval(() => { if (performance.now() > deadline || (qi >= queue.length && !att)) { clearInterval(timer); finish(); } }, 100);
    ws.on('error', () => finish());
    ws.on('message', raw => { const m = JSON.parse(raw), now = performance.now();
      if (m.type === 'welcome') { side = m.side; ws.send(JSON.stringify({ type: 'name', name: 'Probe' })); }
      if (m.type === 'botinfo' && m.active && m.level !== level) ws.send(JSON.stringify({ type: 'bot', level }));
      if (m.type === 'hit') {
        if (att && m.side === side && att.sent.length && !att.hit) att.side = side, att.hit = { at: now, n: m.n, kind: m.kind, bet: !!m.bet, p: m.p, v: m.v, c: m.c || 0, spin: m.spin || 0, t: m.t, padZ: st && st.paddles[side] ? st.paddles[side].z : null,
          tcLeft: att.tcLast != null ? att.tcLast - now : null };
        else if (att && att.hit && m.side !== side) { att.returned = true; close('returned'); }
      }
      if (m.type === 'launch' && att && att.hit && m.by === side) att.launches.push({ at: now, n: m.n, land: m.land, kind: m.kind, p: m.p, v: m.v, w: m.w, t: m.t, c: m.c || 0 });
      if (m.type === 'whiff' && att && !att.hit) att.whiff = m.why || 'whiff';
      if (m.type === 'point') { if (att) att.point = { winner: m.winner === side ? 'me' : 'matt', why: m.why }; close('point'); }
      if (m.type !== 'state' || side == null) return;
      st = m;
      const s = side === 0 ? 1 : -1, mine = m.live && m.v[2] * s > 0, me = m.paddles[side];
      ws.send(JSON.stringify({ type: 'paddle', x: mine ? m.p[0] + (+env.PADX || 0) * (qi % 2 ? 1 : -1) : 0, y: mine ? Math.max(0.4, Math.min(1.4, m.p[1])) : 1, z: 6.5, q: [0, 0, 0, 1], r: 0 }));
      if (att && now - att.armAt > 4000) close('stale');
      if (att && !att.hit && mine && me) { const ahead = -(m.p[2] - me.z) * s; att.tcLast = now + (ahead - 0.25) / Math.abs(m.v[2]) * 1000; }
      if (att || !mine || !me || now < cool || qi >= queue.length || m.serving != null) return;
      const ahead = -(m.p[2] - me.z) * s, tc = (ahead - 0.25) / Math.abs(m.v[2]) * 1000;
      const job = queue[qi], lead = tc + job.m.delta + job.align + job.jit;    // when the bet leaves the tab so that the hand's peak lands align + jit after the plane
      if (lead > 17) return;
      qi++; cool = now + 900;
      att = { key: job.m.key, rep: job.rep, armAt: now, betAt: now + Math.max(0, lead), sent: [], launches: [] };
      const a = att, t0 = now + Math.max(0, lead);
      for (const r of job.m.reps) setTimeout(() => { if (ws.readyState !== 1) return;
        const o = { type: 'swing', power: r.power, raw: r.raw, rom: r.rom, back: r.back, off: r.off, dir: r.dir, lob: r.lob, chop: r.chop, age: r.age, net: Math.round(2 * OWD), slice: r.slice, fix: r.fix, final: r.final, src: 'airpod' };
        setTimeout(() => { if (ws.readyState !== 1) return; a.sent.push({ at: performance.now(), dt: r.dt, final: r.final, fix: r.fix }); ws.send(JSON.stringify(o)); }, OWD); }, Math.max(0, t0 + r.dt - performance.now()));
    });
  });
}
const swingtimes = {};
async function live(movs) {
  if (!COMBOS.length) throw new Error('live: COMBOS="wait:align:level[:replan],..."');
  const REPS = +env.REPS || 1, SECS = +env.SECS || 200, procs = [], jobs = [];
  try {
    COMBOS.forEach((cb, ci) => {
      const plan = []; for (let rep = 0; rep < REPS; rep++) for (const m of movs) { const u = rng(hash(m.key) + (rep + (+env.SEED || 0)) * 7919); plan.push({ m, rep, jit: gauss(u) * JIT, align: cb.align }); }
      for (let k = 0; k < PER; k++) { const port = BASE + ci * PER + k;
        const e = { ...process.env, PORT: String(port), AUTOBOT: '1', WIN_AT: '0', SWING_SERVE: '0', PODDLE_DB: ':memory:', BAND1: '1', SEED: String((+env.SEED || 0) * 100 + k + 1), STRIKE_WAIT: cb.wait ? '1' : '0' };
        if (cb.replan != null) e.REPLAN_HUMAN = cb.replan; else delete e.REPLAN_HUMAN;
        procs.push(spawn('node', ['-r', './test/seedrand.cjs', 'server/game.js'], { cwd: root, env: e, stdio: ['ignore', 'ignore', 'inherit'] }));
        jobs.push({ cb, port, queue: plan.filter((_, i) => i % PER === k) }); }
    });
    await wait(1500);
    const deadline = performance.now() + SECS * 1000;
    const res = await Promise.all(jobs.map(j => probe(j.port, j.queue, deadline, j.cb.level).then(r => r.map(a => ({ ...a, combo: j.cb.tag })))));
    if (env.STATS_KEY) for (const j of jobs) { try { const r = await fetch(`http://localhost:${j.port}/api/swingtime`, { headers: { Authorization: 'Bearer ' + env.STATS_KEY } }); (swingtimes[j.cb.tag] ||= []).push(await r.json()); } catch { /* the server went */ } }   // the live counts each server kept (server/swingtime.js)
    return res.flat();
  } finally { for (const p of procs) p.kill(); }
}

function report(movs, hits) {
  const lines = [], say = s => { lines.push(s); console.log(s); }, byKey = new Map(movs.map(m => [m.key, m])), rows = {};
  say(`\n=== strike at the paddle, live at the real server (each report reaches it ${OWD} ms after it is sent; jitter sd ${JIT} ms; Matt's band pinned, Math.random seeded)`);
  for (const cb of [...new Set(hits.map(a => a.combo))]) {
    const [w, align, level, replan] = cb.split(':'), A = hits.filter(a => a.combo === cb), H = A.filter(a => a.hit);
    for (const a of H) { const m = byKey.get(a.key), h = a.hit, s0 = a.sent[0]; if (!m || !s0) continue;
      a.m = m; a.wait = h.at - s0.at;                                             // bet in at the server -> strike (loopback)
      const sent = a.sent.filter(s => s.at <= h.at), last = sent[sent.length - 1];
      a.struckBy = last.final ? 'settled' : last.fix ? 'mid fix' : 'bet';
      a.ahead = h.padZ != null ? -(h.p[2] - h.padZ) * (a.side === 0 ? 1 : -1) : null;
      const re = a.launches.find(l => l.n != null);
      const T = S.fallLeft(h.p[1], h.v[1], S.gOf(h.spin || 0)), land0 = [h.p[0] + h.v[0] * T + 0.5 * h.c * T * T, h.p[2] + h.v[2] * T];
      a.reaim = re ? { dtHit: re.at - h.at, shift: Math.hypot(re.land[0] - land0[0], re.land[1] - land0[1]), gone: Math.hypot(re.p[0] - h.p[0], re.p[2] - h.p[2]) } : null;
      if (re) { const nb = []; for (let k = 0; re.w && k < re.w.length; k += 4) if (Math.abs(re.w[k + 3] - re.t) < 1e-9) nb.push([re.w[k], re.w[k + 1]]);
        const v1 = [re.v[0] + nb.reduce((s, b) => s + b[0], 0), re.v[2] + nb.reduce((s, b) => s + b[1], 0)]; let d = (Math.atan2(v1[0], v1[1]) - Math.atan2(re.v[0], re.v[2])) / DEG; while (d > 180) d -= 360; while (d < -180) d += 360; a.reaim.head = Math.abs(d); }
      a.kindFinal = (a.launches.find(l => l.kind) || {}).kind || h.kind;
      a.curled = Math.abs(h.c) > 1e-6 ? 'contact' : a.launches.some(l => l.w && l.w.filter((_, k) => k % 4 === 3 && Math.abs(l.w[k] - l.t) < 1e-9).length >= 2) ? 'reaim' : null;
      a.nFinal = re ? re.n : h.n;
      // onset (|r| crosses 4 rad/s) -> bet [sensor] + the bet sample's lateness + OWD + server wait + OWD + 11 (a 60 fps frame, swinglat 3b p50)
      a.lat = (m.t0 - (Number.isFinite(m.on4) ? m.on4 : m.mv0)) * 1000 + m.late + OWD + a.wait + OWD + 11;
      const pkTab = a.betAt - m.delta;
      a.turnVsDrawnPeak = h.at + OWD + 11 - pkTab - m.D;                          // the drawn ball turns vs the DRAWN paddle's peak (hand + D)
      a.strikeVsPlane = h.tcLeft != null ? -h.tcLeft : NaN;
    }
    const R = H.filter(a => a.reaim), ok = H.filter(a => a.m), ended = H.filter(a => a.returned || a.point);
    const row = rows[cb] = { swings: A.length, hits: H.length, whiffs: A.filter(a => a.whiff).length, reaimed: R.length / (H.length || 1), smash: ok.filter(a => a.kindFinal === 'smash').length / (ok.length || 1),
      returned: ended.filter(a => a.returned).length, ended: ended.length };
    say(`\n-- STRIKE_WAIT=${w}${replan != null ? ' REPLAN_HUMAN ' + replan : ''}, ALIGN ${align}, Matt ${['Rookie', 'Club', 'Pro', 'Tour'][+level]}: ${A.length} swings, ${H.length} hits, ${row.whiffs} whiffs (${[...new Set(A.filter(a => a.whiff).map(a => a.whiff))].join('/')}), ${A.filter(a => !a.hit && !a.whiff).length} no contact`);
    say(`   re-aimed ${R.length}/${H.length} (${pc(R.length, H.length)}); shift ${dist(R.map(a => a.reaim.shift))} m; heading ${dist(R.map(a => a.reaim.head), 1)} deg; re-aim ${dist(R.map(a => a.reaim.dtHit), 0)} ms after the hit, ball gone ${dist(R.map(a => a.reaim.gone))} m`);
    say(`   at contact: bet ${H.filter(a => a.struckBy === 'bet').length}, mid fix ${H.filter(a => a.struckBy === 'mid fix').length}, settled ${H.filter(a => a.struckBy === 'settled').length}; struck on a bet (hit.bet) ${H.filter(a => a.hit.bet).length}`);
    say(`   strike: ball ${dist(ok.filter(a => a.ahead != null).map(a => a.ahead))} m in front of the paddle (CONTACT 0.25); strike - ball at plane ${dist(ok.map(a => a.strikeVsPlane), 0)} ms; server wait after the bet arrived ${dist(ok.map(a => a.wait), 0)} ms`);
    say(`   onset -> drawn turn ${dist(ok.map(a => a.lat), 0)} ms; drawn turn - DRAWN paddle peak (D ${dist(ok.map(a => a.m.D), 0)} ms) ${dist(ok.map(a => a.turnVsDrawnPeak), 0)} ms`);
    say(`   kinds (final): ${mix(ok.map(a => a.kindFinal))}; smash ${pc(ok.filter(a => a.kindFinal === 'smash').length, ok.length)}; curl from contact ${ok.filter(a => a.curled === 'contact').length}, swoop at re-aim ${ok.filter(a => a.curled === 'reaim').length}; mean flown n ${f(mean(ok.map(a => a.nFinal)))} (settled ${f(mean(ok.map(a => nOf(settledOf(a.m).power, true))))})`);
    say(`   first bounce |x| ${dist(ok.map(a => { const L = [...a.launches].reverse().find(l => l.land) ; return L ? Math.abs(L.land[0]) : NaN; }))} m (the last landing told)`);
    say(`   Matt returned ${row.returned}/${row.ended} (${pc(row.returned, row.ended)}); my point outright ${ended.filter(a => a.point && a.point.winner === 'me').length}; my error ${ended.filter(a => a.point && a.point.winner === 'matt').length}`);
  }
  return { lines, rows };
}

const ONLY = env.ONLY || '';                                     // ONLY=smash: just the movements whose settled report is a smash (n > SMASH), for a per-level smash check
const movs = FILES.flatMap(extract).filter(m => ONLY !== 'smash' || nOf(settledOf(m).power, true) > SV.SMASH);
console.log(`${movs.length} scored movements from ${FILES.join(', ')}; D at the bet ${dist(movs.map(m => m.D), 0)} ms`);
const data = { at: new Date().toISOString(), cfg: { OWD, JIT, FILES, COMBOS: env.COMBOS || '', SEED: env.SEED || 0, PADX: env.PADX || 0, ONLY } };
if (MODE === 'live') { data.hits = await live(movs); for (const a of data.hits) delete a.m; data.report = report(movs, data.hits);
  for (const [tag, rs] of Object.entries(swingtimes)) { const h = k => rs.map(r => r.src.airpod.hist[k]), sh = rs.map(r => r.src.airpod.share);      // with STATS_KEY set: what /api/swingtime said, per server
    console.log(`swingtime ${tag}: settledMs p50 ${h('settledMs').map(x => x.p50)} (under 0: ${h('settledMs').map(x => x.under0)}), betMs p50 ${h('betMs').map(x => x.p50)}, waitMs p50/p90 ${h('waitMs').map(x => x.p50 + '/' + x.p90)}, re-aimed ${sh.map(x => x.reaimed)}`); }
  data.swingtime = swingtimes; }
if (MODE === 'report') { const all = env.IN.split(',').flatMap(fl => JSON.parse(fs.readFileSync(fl, 'utf8')).hits); data.report = report(movs, all); }
fs.writeFileSync(OUT, JSON.stringify(data)); console.log('-> ' + OUT);
process.exit(0);
