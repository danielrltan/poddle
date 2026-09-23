// Lob / slice diagnosis on the real captures (based on test/kinds.mjs). For every settled swing: duration, rom, raw upward
// share, lob after the client's turn gate, underhand(), chop, |roll|, turn (path integral of axis wander) vs disp (net angle
// between the first and last swing axis: duration-independent), early-swing chop/roll, spin, kind, and from the server's
// OWN solve()/fly() (string-grabbed): flight T, apex height, landing depth -- plus the same shot with spin forced to 0.
// Usage: node test/lobdata.mjs [--rows]
import { MotionModel, qaxis, qmul, qrot } from '../web/motion.js';
import fs from 'fs';
const src = fs.readFileSync(new URL('../server/game.js', import.meta.url), 'utf8');
const grab = name => { const i = src.indexOf('const ' + name + ' = '); if (i < 0) throw new Error('game.js: no ' + name); return src.slice(i, src.indexOf('\n', i)); };
const grabFn = name => { const i = src.indexOf('function ' + name + '('); if (i < 0) throw new Error('game.js: no fn ' + name); return src.slice(i, src.indexOf('\n}\n', i) + 2); };
const S = new Function([grab('COURT'), grab('G'), grab('SLICE'), grab('BOUNCE'), grab('REACH'), grab('sgn'), grab('clamp'), grab('lerp'), grab('DT'),
  grab('SMASH'), grab('SMASH_UP'), grab('LOB_ARC'), grab('underhand'), grab('sliced'), grab('smooth'), grab('lofted'), grab('flat'), grab('hard'), grab('shotKind'), grab('gOf'), grabFn('solve'), grabFn('fly'),
  'return { underhand, sliced, shotKind, solve, G, R, SLICE };'].join('\n'))();
const main = fs.readFileSync(new URL('../web/main.js', import.meta.url), 'utf8');
const a0 = main.indexOf('const roll = Math.max('), a1 = main.indexOf("game.send({ type: 'swing'", a0); if (a0 < 0 || a1 < 0) throw new Error('main.js anchors moved');
const clientOf = new Function('e', main.slice(a0, a1) + '; return { roll, curve, amount, way, slice, lob };');
const chopRule = /m\.chop, 0\), 0, 1\) > ([\d.]+) && pw > ([\d.]+)\) pw = Math\.min\(1, pw \+ ([\d.]+)\)/.exec(src);
const [CHOP, CHOP_N, CHOP_ADD] = chopRule ? chopRule.slice(1).map(Number) : [0.45, 0.55, 0];   // the server's overhead bonus, if it has one (gone since NOTES 79: + 0)
const P0 = [0, 1.0, 6.5];                          // contact: baseline (HIT_LINE 6.5), paddle 1 m up, side 0
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], nrm = a => Math.hypot(...a);

// Wrap _track: per swing object, record every (rate-weighted) player-axis angular velocity while it is still measuring,
// the first and last unit axis (rate > 5, as motion.js does), mv0 / tPk / tFix.
const extra = new WeakMap();
class Probe extends MotionModel {
  _track(s, dt, ev) {
    const before = this.sw; super._track(s, dt, ev); const sw = this.sw || before; if (!sw) return;
    let x = extra.get(sw); if (!x) extra.set(sw, x = { W: [], u1: null });
    const rate = nrm(s.r);
    if (!sw.fixed || ev.some(e => e.type === 'swing' || e.type === 'swingFix')) {
      const wP = this._vecP(qrot(qmul(this.yawFix, s.q), s.r)); x.W.push({ t: s.t, w: wP, rate });
      if (rate > 5 && !x.u1) x.u1 = wP.map(v => v / rate);
    }
    for (const e of ev) if (e.type === 'swing' || e.type === 'swingFix') { e._sw = sw; e._x = x; }
  }
}
const rows = [];
for (const f of ['data/live-swings.jsonl', 'data/live-play-1.jsonl', 'data/live-play-2.jsonl', 'data/live-play-3.jsonl']) {
  if (!fs.existsSync(new URL('../' + f, import.meta.url))) continue;
  const R = fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(r => r && r.q && r.r);
  const m = new Probe(), q0 = R[0].q, T0 = R[0].t - 8;
  for (let i = 0; i < 400; i++) { const t = T0 + i * 0.02, k = i * 0.02, tip = k < 5.4 ? 0 : k < 6 ? 0.6 * (k - 5.4) / 0.6 : 0.6; m.feed({ t, q: qmul(qaxis([1, 0, 0], tip), q0), r: [0, 0, 0], a: [0, 0, 0] }, t * 1000); }
  const last = new Map(); let id = 0;
  for (const r of R) for (const e of m.feed(r, r.t * 1000)) { if (e.type === 'swing') id++; if (e.type === 'swing' || e.type === 'swingFix') last.set(id, e); }
  for (const e of last.values()) {
    const sw = e._sw, x = e._x, sp = clientOf(e);
    const n0 = Math.max(0, Math.min(1, (e.power - 6) / 28)), n = e.chop > CHOP && n0 > CHOP_N ? Math.min(1, n0 + CHOP_ADD) : n0;
    const u = S.underhand(sp.lob), spin = S.sliced(sp.slice, sp.lob), kind = S.shotKind(n, sp.lob, sp.slice);
    const sol = S.solve(P0, 0, n, e.dir, sp.lob, sp.slice), g = S.G * (1 - S.SLICE.lift * sol.spin);
    const apex = sol.v[1] > 0 ? P0[1] + sol.v[1] ** 2 / (2 * g) : P0[1];
    const sol0 = S.solve(P0, 0, n, e.dir, sp.lob, 0), apex0 = sol0.v[1] > 0 ? P0[1] + sol0.v[1] ** 2 / (2 * S.G) : P0[1];
    // net axis displacement: first vs last unit axis while rate > 5 (sw.u0 is motion.js's own last axis)
    const disp = x.u1 && sw.u0 ? Math.acos(Math.max(-1, Math.min(1, dot(x.u1, sw.u0)))) : 0;
    // early half of the measured window: its own upward / downward / roll shares
    const W = x.W, tEnd = sw.tFix ?? W[W.length - 1].t, k3 = Math.max(1, Math.ceil(W.length / 3)), eS = [0, 0, 0], lS = [0, 0, 0];   // early = first third of the samples since the trigger, late = the rest
    W.forEach((s, i) => { const tgt = i < k3 ? eS : lS; for (let j = 0; j < 3; j++) tgt[j] += s.w[j] * s.rate; });
    const minUp = Math.min(...W.filter(s => s.rate > 5).map(s => s.w[0] / s.rate), 1);   // most downward single sample (-1 = pure chop)
    const lobNG = e.lob, uNG = S.underhand(lobNG), kindNG = S.shotKind(n, lobNG, sp.slice);   // what it would have been WITHOUT the client's turn gate
    const en = nrm(eS) || 1, ln = nrm(lS) || 1;
    rows.push({ f: f.slice(5, -6), power: e.power, n, dur: sw.tPk - sw.mv0, win: tEnd - sw.mv0, age: e.age, rom: e.rom, up: e.lob / 0.8, lob: sp.lob, u, chop: e.chop,
      roll: Math.abs(e.roll), turn: e.turn, disp, eUp: eS[0] / en, eChop: Math.max(0, -eS[0] / en), minUp, uNG, kindNG, eRoll: Math.abs(eS[2]) / en, lUp: lS[0] / ln,
      spin, kind, T: sol.T, apex, depth: -sol.land[1], apex0, T0: sol0.T });
  }
}
const f2 = v => (typeof v === 'number' ? v.toFixed(2) : String(v));
const corr = (a, b) => { const n = a.length, ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n; let c = 0, va = 0, vb = 0; for (let i = 0; i < n; i++) { c += (a[i] - ma) * (b[i] - mb); va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2; } return c / Math.sqrt(va * vb); };
const med = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const cols = ['f', 'power', 'dur', 'win', 'age', 'rom', 'up', 'lob', 'u', 'chop', 'roll', 'turn', 'disp', 'eUp', 'eChop', 'eRoll', 'lUp', 'minUp', 'uNG', 'kindNG', 'spin', 'kind', 'T', 'apex', 'apex0', 'depth'];
if (process.argv.includes('--rows')) { console.log(cols.join('\t')); for (const r of rows) console.log(cols.map(c => f2(r[c])).join('\t')); }
const real = rows.filter(r => r.power >= 9);
console.log(`\n${rows.length} settled swings, ${real.length} with power >= 9`);
for (const [nm, set] of [['all', rows], ['power>=9', real]]) {
  const g = k => set.map(r => r[k]);
  console.log(`\nH1 [${nm}] corr(turn, dur=tPk-mv0) ${f2(corr(g('turn'), g('dur')))}  corr(turn, win=tFix-mv0) ${f2(corr(g('turn'), g('win')))}  corr(turn, rom) ${f2(corr(g('turn'), g('rom')))}  corr(turn, power) ${f2(corr(g('turn'), g('power')))}`);
  console.log(`         corr(disp, dur) ${f2(corr(g('disp'), g('dur')))}  corr(disp, win) ${f2(corr(g('disp'), g('win')))}  corr(disp, rom) ${f2(corr(g('disp'), g('rom')))}  corr(turn, disp) ${f2(corr(g('turn'), g('disp')))}`);
}
console.log('\nturn / disp by rom bucket (power>=9):   rom       n  med turn  med disp  med win(s)');
for (const [lo, hi] of [[0, 60], [60, 100], [100, 140], [140, 200], [200, 1e9]]) { const b = real.filter(r => r.rom >= lo && r.rom < hi); if (b.length) console.log(`   ${String(lo).padStart(4)}-${hi > 1e8 ? '   ' : String(hi).padEnd(3)}  ${String(b.length).padStart(4)}  ${f2(med(b.map(r => r.turn))).padStart(8)}  ${f2(med(b.map(r => r.disp))).padStart(8)}  ${f2(med(b.map(r => r.win))).padStart(8)}`); }
const hi = rows.filter(r => r.up > 0.62);
console.log(`\nraw upward share > 0.62: ${hi.length} swings`);
for (const r of hi) console.log(`   ${r.f.padEnd(12)} pw ${f2(r.power).padStart(5)} up ${f2(r.up)} lob ${f2(r.lob)} u ${f2(r.u)} turn ${f2(r.turn)} disp ${f2(r.disp)} rom ${r.rom.toFixed(0).padStart(3)} win ${f2(r.win)} roll ${f2(r.roll)} spin ${f2(r.spin)} -> ${r.kind.padEnd(5)} (no gate: u ${f2(r.uNG)} ${r.kindNG.padEnd(5)}) apex ${f2(r.apex)} T ${f2(r.T)} depth ${f2(r.depth)}`);
console.log('\nH2b apex by kind (contact [0,1.0,6.5]):  kind   n   apex p25/p50/max   apex(spin=0) p50   T p50  T(spin=0) p50  depth p50  spin p50');
const pct = (a, p) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
for (const k of ['drive', 'smash', 'slice', 'lob', 'dink', 'tap']) { const b = rows.filter(r => r.kind === k); if (!b.length) continue; const A = b.map(r => r.apex);
  console.log(`   ${k.padEnd(6)} ${String(b.length).padStart(3)}   ${f2(pct(A, .25))}/${f2(med(A))}/${f2(Math.max(...A))}        ${f2(med(b.map(r => r.apex0)))}        ${f2(med(b.map(r => r.T)))}   ${f2(med(b.map(r => r.T0)))}       ${f2(med(b.map(r => r.depth)))}     ${f2(med(b.map(r => r.spin)))}`); }
console.log('\ntop 10 apex among non-lob/dink swings:');
for (const r of rows.filter(r => r.kind !== 'lob' && r.kind !== 'dink').sort((a, b) => b.apex - a.apex).slice(0, 10)) console.log(`   ${r.kind.padEnd(5)} pw ${f2(r.power).padStart(5)} spin ${f2(r.spin)} up ${f2(r.up)} turn ${f2(r.turn)} roll ${f2(r.roll)} apex ${f2(r.apex)} (spin 0: ${f2(r.apex0)}) T ${f2(r.T)} (${f2(r.T0)}) depth ${f2(r.depth)}`);
const H2a = rows.filter(r => r.up > 0.5 && (r.roll > 0.4 || r.eChop > 0.2 || r.minUp < -0.5));
console.log(`\nH2a: upward share > 0.5 AND (|roll| > 0.4 OR first-third downward share > 0.2 OR a sample < -0.5 up): ${H2a.length} (${H2a.filter(r => r.power >= 9).length} with power >= 9)`);
console.log(`   corr(up, |roll|) all ${f2(corr(rows.map(r => r.up), rows.map(r => r.roll)))}, power>=9 ${f2(corr(real.map(r => r.up), real.map(r => r.roll)))};  power>=9 with up > 0.5: ${real.filter(r => r.up > 0.5).length}, of them |roll| > 0.4: ${real.filter(r => r.up > 0.5 && r.roll > 0.4).length}`);
for (const r of H2a) console.log(`   pw ${f2(r.power).padStart(5)} up ${f2(r.up)} lob ${f2(r.lob)} roll ${f2(r.roll)} eChop ${f2(r.eChop)} minUp ${f2(r.minUp)} eUp ${f2(r.eUp)} lUp ${f2(r.lUp)} turn ${f2(r.turn)} spin ${f2(r.spin)} -> ${r.kind} apex ${f2(r.apex)}`);
