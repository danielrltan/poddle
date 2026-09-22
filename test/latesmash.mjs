// How late is a smash called, and where is the ball by then? (NOTES 58)
// A bet never smashes, so a swing struck on its early report is called a drive or a slice at the impact and only becomes a
// 'smash' when the settled report re-aims it. This replays the REAL captures - data/live-play-1.jsonl through the real
// web/motion.js, every report at its real spacing - at the real server, and prints for each of my shots how it was called
// at the impact, how it was called after, and how far the ball had travelled in between. web/scene.js must never play the
// whole smash flourish out there: that is a second impact (it was seen as "the hit effect twice").
// Usage: TEST_PORT=<port> node test/latesmash.mjs
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
const n_ = p => Math.max(0, Math.min(1, (p - 6) / 28));
const hard = movs.filter(v => { const f = v.reps.filter(r => r.final).pop(); return f && (f.chop > 0.45 && n_(f.power) > 0.55 ? Math.min(1, n_(f.power) + 0.2) : n_(f.power)) > 0.7; });
console.log(`${movs.length} real movements, ${hard.length} hard enough to smash (${hard.map(v => v.reps.length).join(', ')} reports each)`);

// ---- play them at the real server, against Matt ----
const proc = spawn('node', ['server/game.js'], { cwd: root, env: { ...process.env, PORT, AUTOBOT: '1', WIN_AT: '0', SWING_SERVE: '0' }, stdio: ['ignore', 'ignore', 'inherit'] });
await wait(800);
const ws = new WebSocket('ws://localhost:' + PORT);
let side = null, cool = 0, swings = 0; const shots = [];
ws.on('message', raw => { const m = JSON.parse(raw);
  if (m.type === 'welcome') { side = m.side; ws.send(JSON.stringify({ type: 'name', name: 'Probe' })); }
  if (m.type === 'hit' && m.side === side) shots.push(cur = { at: Date.now(), spd: Math.hypot(...m.v), kind: m.kind, spin: m.spin, late: null });
  if (m.type === 'launch' && m.by === side && m.kind === 'smash' && cur) { cur.late = Date.now() - cur.at; cur.spin = m.spin; cur = null; }
  if (m.type !== 'state' || side == null) return;
  const s = side === 0 ? 1 : -1, mine = m.live && m.v[2] * s > 0, me = m.paddles[side];
  ws.send(JSON.stringify({ type: 'paddle', x: mine ? m.p[0] : 0, y: mine ? Math.max(0.4, Math.min(1.4, m.p[1])) : 1, z: 6.5, q: [0, 0, 0, 1], r: 0 }));
  if (mine && me && Date.now() > cool && Math.abs(m.p[2] - me.z) < 1.2) { cool = Date.now() + 700;
    const v = hard[swings++ % hard.length];
    for (const r of v.reps) setTimeout(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'swing', power: r.power, raw: r.raw, rom: r.rom, back: r.back, off: r.off, dir: r.dir, lob: r.lob, chop: r.chop, age: r.age, net: 0, slice: r.slice, fix: r.fix, final: r.final })); }, r.dt); } });
await wait(60000);
const late = shots.filter(s => s.late != null), atOnce = shots.filter(s => s.kind === 'smash');
console.log(`\n${shots.length} of my shots: ${atOnce.length} were called a smash at the impact, ${late.length} only after it`);
for (const s of late) console.log(`  struck as a ${s.kind}, called a smash ${s.late} ms later - the ball was ${(s.spd * s.late / 1000).toFixed(1)} m on by then (spin ${(s.spin || 0).toFixed(2)}${s.spin > 0.3 ? ', purple' : ''})`);
console.log(late.length ? `\nlate by ${Math.min(...late.map(s => s.late))}-${Math.max(...late.map(s => s.late))} ms: too far away, and too long after, to be shown as another impact (web/scene.js igniteFx)` : '\nno late calls in this run');
ws.close(); proc.kill(); process.exit(0);
