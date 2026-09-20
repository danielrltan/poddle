// Prints the first samples of every movement in a capture: rate, |a| and angle swept since take-off. Usage: node test/onset.mjs [file]
import fs from 'fs';
const rows = fs.readFileSync(new URL('../' + (process.argv[2] || 'data/live-swings.jsonl'), import.meta.url), 'utf8').trim().split('\n').map(l => JSON.parse(l));
let cur = null; const out = [];
rows.forEach((r, i) => { const w = Math.hypot(...r.r);
  if (w >= 4) { cur = cur || { i0: i, peak: 0, ip: i }; if (w > cur.peak) { cur.peak = w; cur.ip = i; } cur.i1 = i; } else if (cur) { if (cur.peak >= 9) out.push(cur); cur = null; } });
for (const c of out) { const rise = (rows[c.ip].t - rows[c.i0].t) * 1000, kind = c.peak > 20 && rise <= 120 ? 'FLICK' : 'WIDE ';
  let ang = 0; const cells = [];
  for (let i = c.i0 - 2; i <= Math.min(c.i1, c.i0 + 14); i++) { const r = rows[i], w = Math.hypot(...r.r); if (i > c.i0) ang += w * (r.t - rows[i - 1].t) * 57.3;
    cells.push(`${w.toFixed(0).padStart(2)}/${Math.hypot(...r.a).toFixed(1)}/${ang.toFixed(0)}`); }
  console.log(`${kind} pk ${c.peak.toFixed(0).padStart(2)} rise ${rise.toFixed(0).padStart(3)} dur ${((rows[c.i1].t - rows[c.i0].t) * 1000).toFixed(0).padStart(3)} | ${cells.join(' ')}`); }
