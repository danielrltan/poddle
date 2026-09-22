// Replays the real captures and prints which shot each swing would be called, plus the raw ingredients, so the
// classification can be balanced on real swings instead of guesses. Usage: node test/kinds.mjs [--raw]
import { MotionModel, qaxis, qmul, qrot } from '../web/motion.js';
import fs from 'fs';
const src = fs.readFileSync(new URL('../server/game.js', import.meta.url), 'utf8');
const grab = name => { const i = src.indexOf('const ' + name + ' = '); return src.slice(i, src.indexOf('\n', i)); };
const { underhand, sliced, shotKind } = new Function('const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));' + ['SLICE', 'SMASH', 'SMASH_UP', 'LOB_ARC', 'underhand', 'sliced', 'smooth', 'lofted', 'flat', 'hard', 'shotKind'].map(grab).join('\n') + '\nreturn { underhand, sliced, shotKind };')();
const main = fs.readFileSync(new URL('../web/main.js', import.meta.url), 'utf8');
const a0 = main.indexOf('const roll = Math.max('), a1 = main.indexOf("game.send({ type: 'swing'", a0); if (a0 < 0 || a1 < 0) throw new Error('web/main.js: the swing maths moved (anchors: "const roll = Math.max(" .. "game.send({ type: \'swing\'")');
const clientOf = new Function('e', main.slice(a0, a1) + '; return { level: 0, roll, curve, amount, way, slice, lob };');   // the client's OWN spin maths and lob gate, as it sends them: nothing here is copied by hand
const chopRule = /m\.chop, 0\), 0, 1\) > ([\d.]+) && pw > ([\d.]+)\) pw = Math\.min\(1, pw \+ ([\d.]+)\)/.exec(src); if (!chopRule) throw new Error('server/game.js: the overhead bonus moved');
const [CHOP, CHOP_N, CHOP_ADD] = chopRule.slice(1).map(Number);                       // the server's overhead bonus, read from its swing handler
const pct = (a, p) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
const total = {}, real = {}, SP = [];                          // real / SP: the kinds and the spin of the real strokes (power >= 9): more than half of all detected swings are twitches, and they dilute every share
for (const f of ['data/live-swings.jsonl', 'data/live-play-1.jsonl', 'data/live-play-2.jsonl', 'data/live-play-3.jsonl']) {
  if (!fs.existsSync(new URL('../' + f, import.meta.url))) { console.log(`${f}: not here, skipped`); continue; }      // (live-play-2 was never committed)
  const rows = fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(r => r && r.q && r.r);   // (live-play-2 has a torn line)
  const m = new MotionModel(), q0 = rows[0].q, T0 = rows[0].t - 8;
  for (let i = 0; i < 400; i++) { const t = T0 + i * 0.02, k = i * 0.02, tip = k < 5.4 ? 0 : k < 6 ? 0.6 * (k - 5.4) / 0.6 : 0.6; m.feed({ t, q: qmul(qaxis([1, 0, 0], tip), q0), r: [0, 0, 0], a: [0, 0, 0] }, t * 1000); }
  const last = new Map(); let id = 0;
  for (const r of rows) for (const e of m.feed(r, r.t * 1000)) { if (e.type === 'swing') id++; if (e.type === 'swing' || e.type === 'swingFix') last.set(id, { e, top: qrot(m.pose(r.t * 1000).Pd, [0, 1, 0]) }); }
  const kinds = {}, L = [], C = [], LV = [], RO = [], TU = [];
  for (const { e } of last.values()) { const sp = clientOf(e), lob = sp.lob, n = Math.max(0, Math.min(1, (e.power - 6) / 28)), pw = e.chop > CHOP && n > CHOP_N ? Math.min(1, n + CHOP_ADD) : n;
    const spin = sliced(sp.slice, lob); if (e.power >= 9) SP.push(spin);
    const k = shotKind(pw, lob, sp.slice); kinds[k] = (kinds[k] || 0) + 1; total[k] = (total[k] || 0) + 1; if (e.power >= 9) real[k] = (real[k] || 0) + 1;
    L.push(lob / 0.8); C.push(e.chop); LV.push(sp.level); RO.push(Math.abs(e.roll)); TU.push(e.turn); }
  console.log(`${f}: ${last.size} swings ->`, Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', '));
  if (process.argv.includes('--raw')) for (const [nm, a] of [['upward share', L], ['downward share', C], ['paddle level', LV], ['|roll|', RO], ['turn rad', TU]]) console.log(`   ${nm.padEnd(15)} p10 ${pct(a, .1).toFixed(2)}  p25 ${pct(a, .25).toFixed(2)}  p50 ${pct(a, .5).toFixed(2)}  p75 ${pct(a, .75).toFixed(2)}  p90 ${pct(a, .9).toFixed(2)}`);
}
const N = Object.values(total).reduce((a, b) => a + b, 0);
console.log(`ALL ${N} swings:`, Object.entries(total).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${(v / N * 100).toFixed(0)}%`).join(', '));
console.log(`REAL STROKES (the ${SP.length} of power >= 9; the other ${N - SP.length} are twitches):`, Object.entries(real).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${(v / SP.length * 100).toFixed(0)}%`).join(', '), ' <- tune on this line');
console.log(`spin on the ${SP.length} strokes of power >= 9: p25 ${pct(SP, .25).toFixed(2)}  p50 ${pct(SP, .5).toFixed(2)}  p75 ${pct(SP, .75).toFixed(2)}  p90 ${pct(SP, .9).toFixed(2)}   > 0.5: ${(SP.filter(s => s > 0.5).length / SP.length * 100).toFixed(0)}%   >= 0.8: ${(SP.filter(s => s >= 0.8).length / SP.length * 100).toFixed(0)}%   exactly 0: ${(SP.filter(s => !s).length / SP.length * 100).toFixed(0)}%`);
