// The FIRST report of a swing (the bet, which strikes the ball when it is already there: NOTES 66) must carry the lob the stroke
// means, and the later reports must not change their mind, or the server re-aims a ball that has left (the helium lob). Real
// web/motion.js, web/main.js's own lob gate, server/game.js's own lofted(); synthetic strokes from test/lobsynth.mjs, AirPod (50 Hz)
// and phone (60 Hz, through web/padmotion.js) grips; then the real captures in data/.   node test/lobbet.mjs [--seeds 12] [--rows]
//   (a) every underhand lob (wide, straight, and a third quicker) is lofted on its bet
//   (b) no slice, chip, drive or smash report is ever lofted; dinks stay lofted
//   (d) no report of a lob stroke disagrees with its bet about lob-or-not
//   (e) real captures: no bet is lofted by the look-ahead alone unless the stroke settles lofted (none of them is a scoop)
import { MotionModel, qaxis, qmul } from '../web/motion.js';
import { STROKES, GRIPS, synthStroke, clientOf, server } from './lobsynth.mjs';
import fs from 'node:fs';
const argv = process.argv.slice(2), SEEDS = +(argv[argv.indexOf('--seeds') + 1] || 12) || 12, ROWS = argv.includes('--rows');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v)), f2 = v => v.toFixed(2);
const judge = e => { const sp = clientOf(e), lf = server.lofted(sp.lob); return { up: sp.lob / 0.8, lf, on: lf > 0.5, kind: server.shotKind(clamp((e.power - 6) / 28, 0, 1), sp.lob, sp.slice) }; };
let fails = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };

// the swing live at contact (as lobsynth), with every report it sent
function reports(stroke, grip, seed) {
  const syn = synthStroke(stroke, { grip, seed }), m = new MotionModel({ RATE_GAIN: GRIPS[grip].gain }), sws = [];
  for (const s of syn.samples) for (const e of m.feed({ t: s.t, q: s.q, r: s.r, a: s.a }, s.t * 1000 + 7)) {
    if (e.type === 'swing') sws.push({ t: s._t - syn.tStroke, evs: [] });
    if ((e.type === 'swing' || e.type === 'swingFix') && sws.length) sws[sws.length - 1].evs.push(e);
  }
  let hit = null; for (const sw of sws) if (sw.t <= syn.plan.contact + 0.08) hit = sw;
  return (hit || sws[0] || { evs: [] }).evs;
}
const LOBS = ['wide_lob', 'straight_lob', 'fast_wide_lob', 'fast_straight_lob'], NEVER = ['bh_slice', 'bh_slice_rev', 'bh_slice_wide', 'bh_chip', 'fh_slice', 'fh_drive', 'bh_drive', 'smash'];
for (const grip of Object.keys(GRIPS)) {
  console.log(`\n${GRIPS[grip].label} (${GRIPS[grip].hz} Hz), ${SEEDS} seeds each`);
  for (const k of [...LOBS, ...NEVER, 'dink']) {
    const bad = [], ups = [], S = STROKES[k];
    for (let seed = 0; seed < SEEDS; seed++) {
      const J = reports(k, grip, seed).map(judge); if (!J.length) continue;                 // (a couple of seeds are too slow to trigger at all, as before)
      ups.push(J[0].up); const row = `seed ${seed}: ${J.map(j => `${f2(j.up)}${j.on ? 'L' : '-'} ${j.kind}`).join(' | ')}`;
      if (ROWS) console.log('       ' + k + ' ' + row);
      if (LOBS.includes(k) && (!J[0].on || J.some(j => j.on !== J[0].on))) bad.push(row);
      if (NEVER.includes(k) && J.some(j => j.lf > 0.05)) bad.push(row);
      if (k === 'dink' && J.some(j => !j.on)) bad.push(row);
    }
    const what = LOBS.includes(k) ? 'lofted on the bet and on every report after it' : NEVER.includes(k) ? 'never lofted, on any report' : 'lofted on every report';
    ok(!bad.length && ups.length >= SEEDS - 2, `${S.label}: ${what} (bet up ${f2(Math.min(...ups))}-${f2(Math.max(...ups))}, ${ups.length} swings)${bad.length ? '\n         ' + bad.join('\n         ') : ''}`);
  }
}

console.log('\nreal captures');
let n = 0, lofted = 0; const ahead = [];
for (const f of fs.readdirSync(new URL('../data/', import.meta.url)).filter(f => f.endsWith('.jsonl'))) {
  const R = fs.readFileSync(new URL('../data/' + f, import.meta.url), 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(r => r && r.q && r.r);
  const m = new MotionModel(), q0 = R[0].q, T0 = R[0].t - 8;
  for (let i = 0; i < 400; i++) { const t = T0 + i * 0.02, k = i * 0.02, tip = k < 5.4 ? 0 : k < 6 ? 0.6 * (k - 5.4) / 0.6 : 0.6; m.feed({ t, q: qmul(qaxis([1, 0, 0], tip), q0), r: [0, 0, 0], a: [0, 0, 0] }, t * 1000); }
  const sws = [];
  for (const r of R) for (const e of m.feed(r, r.t * 1000)) { if (e.type === 'swing') sws.push({ t: r.t, evs: [] }); if ((e.type === 'swing' || e.type === 'swingFix') && sws.length) sws[sws.length - 1].evs.push(e); }
  for (const sw of sws) { n++; const b = sw.evs[0], J = judge(b), L = judge(sw.evs[sw.evs.length - 1]), raw = judge({ ...b, lob: b.lobRaw });
    if (J.on) lofted++;
    if (J.on && !raw.on && !L.on) ahead.push(`${f} t ${sw.t.toFixed(2)}: bet up ${f2(J.up)} (path so far ${f2(raw.up)}), settled ${f2(L.up)} ${L.kind}`); }
}
ok(!ahead.length, `${n} real swings, ${lofted} lofted on the bet: none of them by the look-ahead alone while the stroke settles unlofted${ahead.length ? '\n         ' + ahead.join('\n         ') : ''}`);
console.log(fails ? `\n${fails} FAILURES` : '\nLOB BET TESTS PASSED'); process.exit(fails ? 1 : 0);
