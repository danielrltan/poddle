// How often is one of my hits bent in flight after contact, how far, and how many times? (NOTES 63)
// Every swing is struck on its early report (a bet) and later reports re-aim the ball. This replays the REAL captures -
// data/live-play-1.jsonl through the real web/motion.js, every report at its real spacing - at the real server, and counts
// for each of my hits the re-aims that follow it (a 'launch' carrying n), how far each moved the landing, and how far the ball
// had travelled by then. A ball bent twice was seen as "two hits": "the ball changes trajectory mid air".
// Usage: TEST_PORT=<port> [SECS=60] node test/reaim.mjs
import { spawn } from 'child_process';
import fs from 'fs';
import WebSocket from 'ws';
import { MotionModel, qaxis, qmul } from '../web/motion.js';
const root = new URL('..', import.meta.url).pathname, PORT = +process.env.TEST_PORT || 8291;
const wait = ms => new Promise(r => setTimeout(r, ms));

// ---- the reports web/main.js would send, for every movement in the capture ----
const main = fs.readFileSync(root + 'web/main.js', 'utf8');
const a0 = main.indexOf('const roll = Math.max('), a1 = main.indexOf("game.send({ type: 'swing'", a0);
if (a0 < 0 || a1 < 0) throw new Error('web/main.js: the swing maths moved (anchors: "const roll = Math.max(" .. "game.send({ type: \'swing\'")');
const clientOf = new Function('e', main.slice(a0, a1) + '; return { slice, lob };');      // its OWN spin and lob maths, never copied by hand
const rows = fs.readFileSync(root + 'data/live-play-1.jsonl', 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(r => r && r.q && r.r);
const mm = new MotionModel(), q0 = rows[0].q, T0 = rows[0].t - 8;
for (let i = 0; i < 400; i++) { const t = T0 + i * 0.02, k = i * 0.02, tip = k < 5.4 ? 0 : k < 6 ? 0.6 * (k - 5.4) / 0.6 : 0.6; mm.feed({ t, q: qmul(qaxis([1, 0, 0], tip), q0), r: [0, 0, 0], a: [0, 0, 0] }, t * 1000); }
let cur = null; const movs = [];
for (const r of rows) for (const e of mm.feed(r, r.t * 1000)) {
  if (e.type === 'swing') movs.push(cur = { t0: r.t, reps: [] });
  if (!cur) continue;
  if (e.type === 'swing' || e.type === 'swingFix') { const sp = clientOf(e);
    cur.reps.push({ dt: Math.round((r.t - cur.t0) * 1000), power: e.power, raw: e.raw || 0, rom: e.rom || 0, back: e.back || 0, off: e.off || 0, dir: e.dir, lob: sp.lob, chop: e.chop || 0, age: e.age || 0, slice: sp.slice, fix: e.type === 'swingFix', final: !!e.final }); }
  if (e.type === 'swingEnd') cur = null;
}
const scored = movs.filter(v => v.reps.some(r => r.final) && v.reps.some(r => r.power > 7));
console.log(`${movs.length} real movements, ${scored.length} scored (${scored.filter(v => !v.reps[0].final).length} called first on a bet)`);

// ---- play every one of them at the real server, against Matt ----
const proc = spawn('node', ['server/game.js'], { cwd: root, env: { ...process.env, PORT, AUTOBOT: '1', WIN_AT: '0', SWING_SERVE: '0' }, stdio: ['ignore', 'ignore', 'inherit'] });
await wait(800);
const ws = new WebSocket('ws://localhost:' + PORT);
let side = null, cool = 0, swings = 0, hit = null, ballP = [0, 0, 0], ballV = null, bnc = 0, ballC = 0, ballT = 0; const hits = [];
ws.on('message', raw => { const m = JSON.parse(raw);
  if (m.type === 'welcome') { side = m.side; ws.send(JSON.stringify({ type: 'name', name: 'Probe' })); }
  if (m.type === 'point' || m.type === 'serve') hit = null;                                   // a serve's own correction is not the last rally shot's
  if (m.type === 'hit') hit = m.side === side ? (hits.push({ at: Date.now(), p: m.p.slice(), land: null, bends: [], kink: 0, c: +m.c || 0, pts: [], bow: 0 }), hits[hits.length - 1]) : null;
  if (m.type === 'launch' && m.by === side && hit) {
    if (hit.land == null && m.n == null) hit.land = m.land;                                   // the hit's own launch
    else if (hit.land) hit.bends.push({ ms: Date.now() - hit.at, shift: Math.hypot(m.land[0] - hit.land[0], m.land[1] - hit.land[1]), gone: Math.hypot(ballP[0] - hit.p[0], ballP[2] - hit.p[2]) }), hit.land = m.land;
  }
  if (m.type === 'launch' && m.by === side && hit && m.c) hit.c = m.c;                     // curled (NOTES 71): at contact (a bot-style final swing) or from the settled re-aim
  if (m.type === 'bounce' && hit && hit.pts.length && !hit.bow) { const a = hit.p, b = m.p, L = Math.hypot(b[0] - a[0], b[2] - a[2]) || 1;   // bow: the farthest the flight strayed from the straight line contact -> bounce, seen from above
    hit.bow = Math.max(1e-9, ...hit.pts.map(q => Math.abs((q[0] - a[0]) * (b[2] - a[2]) - (q[2] - a[2]) * (b[0] - a[0])) / L)); }
  if (m.type !== 'state' || side == null) return;
  if (hit && m.live && m.b === 0) hit.pts.push(m.p);
  if (hit && ballV && m.live && m.b === bnc && Date.now() - hit.at < 600) hit.kink = Math.max(hit.kink, Math.hypot(m.v[0] - ballV[0] - ballC * (m.t - ballT), m.v[2] - ballV[2]));   // sideways/along change in velocity between two packets: gravity never shows here, nor does the curl's own steady pull (the last packet's c)
  ballP = m.p; ballV = m.v; bnc = m.b; ballC = +m.c || 0; ballT = m.t;
  const s = side === 0 ? 1 : -1, mine = m.live && m.v[2] * s > 0, me = m.paddles[side];
  ws.send(JSON.stringify({ type: 'paddle', x: mine ? m.p[0] : 0, y: mine ? Math.max(0.4, Math.min(1.4, m.p[1])) : 1, z: 6.5, q: [0, 0, 0, 1], r: 0 }));
  if (mine && me && Date.now() > cool && Math.abs(m.p[2] - me.z) < +(process.env.REACH || 1.2)) { cool = Date.now() + 700;
    const v = scored[swings++ % scored.length];
    for (const r of v.reps) setTimeout(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'swing', power: r.power, raw: r.raw, rom: r.rom, back: r.back, off: r.off, dir: r.dir, lob: r.lob, chop: r.chop, age: r.age, net: 0, slice: r.slice, fix: r.fix, final: r.final })); }, r.dt); } });
await wait(+(process.env.SECS || 60) * 1000);
const bent = hits.filter(h => h.bends.length), twice = hits.filter(h => h.bends.length > 1), all = hits.flatMap(h => h.bends);
const q = (a, p) => a.length ? [...a].sort((x, y) => x - y)[Math.floor(p * (a.length - 1))].toFixed(2) : '-';
console.log(`\n${hits.length} of my hits: ${bent.length} re-aimed after contact, ${twice.length} of them more than once (${all.length} bends in all)`);
console.log(`landing moved by: p50 ${q(all.map(b => b.shift), .5)} m, p90 ${q(all.map(b => b.shift), .9)} m, max ${q(all.map(b => b.shift), 1)} m`);
console.log(`the ball had gone: p50 ${q(all.map(b => b.gone), .5)} m, p90 ${q(all.map(b => b.gone), .9)} m, ${q(all.map(b => b.ms), .5)} ms after contact (p50)`);
if (process.env.DEBUG) for (const h of hits) if (h.bends.length > 1 || h.bends.some(b => b.gone > 4)) console.log(JSON.stringify(h.bends));
const k = hits.filter(h => h.kink > 0).map(h => h.kink);
console.log(`sharpest kink per hit (m/s between two packets): p50 ${q(k, .5)}, p90 ${q(k, .9)}, max ${q(k, 1)}`);
const cu = hits.filter(h => h.c), st = hits.filter(h => !h.c);
console.log(`curled hits: ${cu.length} of ${hits.length}; bow p50 ${q(cu.filter(h => h.bow).map(h => h.bow), .5)} m, max ${q(cu.filter(h => h.bow).map(h => h.bow), 1)} m; kink p50 ${q(cu.map(h => h.kink).filter(x => x), .5)}, max ${q(cu.map(h => h.kink).filter(x => x), 1)} m/s`);
console.log(`straight hits: bow p50 ${q(st.filter(h => h.bow).map(h => h.bow), .5)} m; kink p50 ${q(st.map(h => h.kink).filter(x => x), .5)}, p90 ${q(st.map(h => h.kink).filter(x => x), .9)} m/s`);
ws.close(); proc.kill(); process.exit(0);
