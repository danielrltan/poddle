// Replays the real captures and prints which shot each swing would be called, plus the raw ingredients, so the
// classification can be balanced on real swings instead of guesses. Usage: node test/kinds.mjs [--raw]
import { MotionModel, qaxis, qmul, qrot } from '../web/motion.js';
import fs from 'fs';
const src = fs.readFileSync(new URL('../server/game.js', import.meta.url), 'utf8');
const grab = name => { const i = src.indexOf('const ' + name + ' = '); return src.slice(i, src.indexOf('\n', i)); };
const { underhand, sliced, shotKind } = new Function('const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));' + grab('underhand') + '\n' + grab('sliced') + '\n' + grab('shotKind') + '\nreturn { underhand, sliced, shotKind };')();
const main = fs.readFileSync(new URL('../web/main.js', import.meta.url), 'utf8');
const spinSrc = main.slice(main.indexOf('const roll = Math.max('), main.indexOf('const slice = amount'));           // the client's own spin maths
const spinOf = new Function('e', 'top', spinSrc + '; return { level: 0, roll, curve, amount, way };');
const pct = (a, p) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
const total = {};
for (const f of ['data/live-swings.jsonl', 'data/live-play-1.jsonl', 'data/live-play-3.jsonl']) {
  const rows = fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const m = new MotionModel(), q0 = rows[0].q, T0 = rows[0].t - 8;
  for (let i = 0; i < 400; i++) { const t = T0 + i * 0.02, k = i * 0.02, tip = k < 5.4 ? 0 : k < 6 ? 0.6 * (k - 5.4) / 0.6 : 0.6; m.feed({ t, q: qmul(qaxis([1, 0, 0], tip), q0), r: [0, 0, 0], a: [0, 0, 0] }, t * 1000); }
  const last = new Map(); let id = 0;
  for (const r of rows) for (const e of m.feed(r, r.t * 1000)) { if (e.type === 'swing') id++; if (e.type === 'swing' || e.type === 'swingFix') last.set(id, { e, top: qrot(m.pose(r.t * 1000).Pd, [0, 1, 0]) }); }
  const kinds = {}, L = [], C = [], LV = [], RO = [], TU = [];
  for (const { e, top } of last.values()) { const sp = spinOf(e, top), n = Math.max(0, Math.min(1, (e.power - 6) / 28)), pw = e.chop > 0.45 && n > 0.25 ? Math.max(n, 0.86) : n;
    const k = shotKind(pw, e.lob, sp.amount * (sp.way || 1)); kinds[k] = (kinds[k] || 0) + 1; total[k] = (total[k] || 0) + 1;
    L.push(e.lob / 0.8); C.push(e.chop); LV.push(sp.level); RO.push(Math.abs(e.roll)); TU.push(e.turn); }
  console.log(`${f}: ${last.size} swings ->`, Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', '));
  if (process.argv.includes('--raw')) for (const [nm, a] of [['upward share', L], ['downward share', C], ['paddle level', LV], ['|roll|', RO], ['turn rad', TU]]) console.log(`   ${nm.padEnd(15)} p10 ${pct(a, .1).toFixed(2)}  p25 ${pct(a, .25).toFixed(2)}  p50 ${pct(a, .5).toFixed(2)}  p75 ${pct(a, .75).toFixed(2)}  p90 ${pct(a, .9).toFixed(2)}`);
}
const N = Object.values(total).reduce((a, b) => a + b, 0);
console.log('ALL:', Object.entries(total).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${(v / N * 100).toFixed(0)}%`).join(', '));
