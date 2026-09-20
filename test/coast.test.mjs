// The client's coast() (web/scene.js) must put the ball where the server's own sim puts it, for as long as a bad
// connection can leave it without news (COAST_MAX = 0.6 s), through the first bounce, with and without spin.
//   node test/coast.test.mjs
import { createRequire } from 'module';
process.env.PORT = process.env.PORT || '8177';
const require = createRequire(import.meta.url);
const S = require('../server/game.js');
const { coast } = await import('../web/scene.js');

const V = () => ({ x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } });
const DT = 1 / 60, outP = V(), outV = V();
let worst = 0, worstAt = '', n = 0, fails = 0;
for (const side of [0, 1]) for (const power of [0.05, 0.3, 0.6, 1]) for (const dir of [-1, -0.3, 0.4, 1]) for (const lob of [0, 0.5, 1]) for (const slice of [-1, 0, 0.7])
  for (const from of [0, 0.15, 0.4, 0.8]) {                                       // seconds into the flight when the last packet was made
    const s = side === 0 ? 1 : -1, sol = S.solve([s * 1.2, 1.0, s * 6.2], side, power, dir, lob, slice);
    const p = [s * 1.2, 1.0, s * 6.2], v = [...sol.v]; let bounces = 0, t = 0, snap = null; const truth = [];
    while (t < from + 0.6 + 1e-9 && bounces < 2) {                                // the server's step(), flight part only
      if (!snap && t >= from - 1e-9) snap = { p: [...p], v: [...v], b: bounces, t };
      if (snap) truth.push({ t: t - snap.t, p: [...p] });
      v[1] -= (bounces ? S.G : S.gOf(sol.spin)) * DT; for (let i = 0; i < 3; i++) p[i] += v[i] * DT;
      if (p[1] < S.R) { p[1] = S.R; if (bounces) S.bounceV(v, 0, 0); else S.bounceV(v, sol.spin, sol.kick); bounces++; }
      t += DT;
    }
    if (!snap) continue;
    for (const q of truth) {
      coast(outP, outV, snap.p, snap.v, q.t, sol.spin, snap.b, sol.kick);
      const e = Math.hypot(outP.x - q.p[0], outP.y - q.p[1], outP.z - q.p[2]); n++;
      if (e > worst) { worst = e; worstAt = `side ${side} power ${power} dir ${dir} lob ${lob} slice ${slice} from ${from}s, ${q.t.toFixed(2)}s ahead`; }
      if (e > 0.25) fails++;
    }
  }
console.log(`${n} predictions up to 0.6 s ahead; worst error ${(worst * 100).toFixed(1)} cm (${worstAt})`);
console.log(fails ? `FAIL: ${fails} predictions more than 25 cm from the server's ball` : 'COAST TEST PASSED');
process.exit(fails ? 1 : 0);
