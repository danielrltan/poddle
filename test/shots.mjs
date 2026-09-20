// What each stroke produces. Usage: node test/shots.mjs   (reads the solver out of server/game.js)
import fs from 'fs';
const src = fs.readFileSync(new URL('../server/game.js', import.meta.url), 'utf8');
const pre = src.slice(src.indexOf('const COURT'), src.indexOf('const players'));
const fns = src.slice(src.indexOf('// how underhand was the swing?'), src.indexOf('function launch'));
const { solve, shotKind, COURT } = new Function(pre + '\n' + fns + '\nreturn { solve, shotKind, COURT };')();
const rows = [['gentle underhand (dink)', 9, 0.75], ['medium underhand', 16, 0.75], ['big underhand (lob)', 30, 0.75], ['light level tap', 8, 0.05], ['backhand drive', 17, 0.05], ['solid forehand', 30, 0.05], ['smash', 37, 0]];
for (const [name, power, lob] of rows) {
  const n = Math.max(0, Math.min(1, (power - 6) / 28)), sol = solve([0, 1.0, 6.5], 0, n, 0, lob), v = sol.v;
  const T = (v[1] + Math.sqrt(v[1] * v[1] + 2 * 9.81 * (1.0 - 0.11))) / 9.81, apex = 1.0 + v[1] * v[1] / (2 * 9.81), depth = Math.abs(sol.land[1]);
  console.log(`${name.padEnd(26)} ${shotKind(n, lob).padEnd(6)} lands ${depth.toFixed(1)} m past the net${depth <= COURT.kitchen ? ' (IN the kitchen)' : ''}, peak height ${apex.toFixed(1)} m, ${Math.hypot(...v).toFixed(0)} m/s, ${T.toFixed(2)} s in the air`);
}
