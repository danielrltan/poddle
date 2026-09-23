// Spin audit: how much spin do real strokes carry, where does it come from, and does it scale with how hard the swing was?
// Replays the AirPod recordings through web/motion.js exactly as test/kinds.mjs does, scores every SETTLED swing with the
// client's own spin maths (sliced out of web/main.js) and the server's own sliced()/shotKind() (sliced out of
// server/game.js), and prints the ingredients of the REAL strokes (power >= 9; the rest are twitches).
// It also runs the synthetic strokes of test/lobsynth.mjs (AirPod and phone grips) as intent anchors: a drive means NO
// spin, a slice/chip means spin. The recordings have no intent labels; live-swings.jsonl is the one labelled set (flicks
// and wide arm swings, nobody trying to slice), so every bit of spin in it is unintended.
//
//   node test/spin.mjs                           the four recordings test/kinds.mjs reads (live2 / live-capture are still-hand
//                                                jitter captures: no swing reaches 1 rad/s, so they are left out)
//   node test/spin.mjs --files a.jsonl,b.jsonl   just these (names resolve in the shared data dir, then ./data)
//   node test/spin.mjs --candidate cand.mjs      score a candidate spin function next to the current one
//   node test/spin.mjs --rows                    one line per real stroke
//   node test/spin.mjs --seeds 6                 synthetic seeds per stroke x grip (default 5)
//
// A candidate module exports:
//   slice(e, ctx) -> signed spin, -1..1 (e = the settled motion.js event, the same object main.js sees: raw, power, roll, turn,
//                    curl, dir, lob, chop, rom...; ctx = { gain, lob }: gain = 1 for the AirPod, PHONE_GAIN for the phone, lob =
//                    the client's lob as main.js computes it). The client computes spin; power/smash code is not touched.
//   sliced(slice, lob) -> 0..1   optional; the server's sliced() when absent
//   name                          optional label
import { MotionModel, qaxis, qmul } from '../web/motion.js';
import { STROKES, runStroke, GRIPS, PHONE_GAIN } from './lobsynth.mjs';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const argv = process.argv.slice(2), opt = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const ROWS = argv.includes('--rows'), SEEDS = +(opt('--seeds') || 5);

// ---------- server + client maths, read out of their own files (nothing copied by hand) ----------
const src = fs.readFileSync(new URL('../server/game.js', import.meta.url), 'utf8');
const grab = name => { const i = src.indexOf('const ' + name + ' = '); if (i < 0) throw new Error('server/game.js: no const ' + name); return src.slice(i, src.indexOf('\n', i)); };
const S = new Function('const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));' + ['SLICE', 'SMASH', 'SMASH_UP', 'LOB_ARC', 'CURVE', 'BOUNCE', 'underhand', 'sliced', 'smooth', 'lofted', 'flat', 'hard', 'shotKind'].map(grab).join('\n') +
  '\nreturn { SLICE, SMASH, CURVE, BOUNCE, underhand, sliced, smooth, lofted, flat, shotKind };')();
const main = fs.readFileSync(new URL('../web/main.js', import.meta.url), 'utf8');
const a0 = main.indexOf('const roll = Math.max('), a1 = main.indexOf("game.send({ type: 'swing'", a0);
if (a0 < 0 || a1 < 0) throw new Error('web/main.js: the swing maths moved (anchors: "const roll = Math.max(" .. "game.send({ type: \'swing\'")');
const clientOf = new Function('e', main.slice(a0, a1) + '; return { roll: typeof rollI === "undefined" ? roll : rollI, curve, amount, way, slice, lob };');
const chopRule = /m\.chop, 0\), 0, 1\) > ([\d.]+) && pw > ([\d.]+)\) pw = Math\.min\(1, pw \+ ([\d.]+)\)/.exec(src);   // gone since NOTES 82 (no overhead bonus): read as none
const [CHOP, CHOP_N, CHOP_ADD] = chopRule ? chopRule.slice(1).map(Number) : [0.45, 0.55, 0];
const nOf = (e, gain = 1) => { const n = Math.max(0, Math.min(1, (e.power - 6) / 28)); return e.chop > CHOP && n > CHOP_N ? Math.min(1, n + CHOP_ADD) : n; };   // = kinds.mjs / lobsynth derive(). The phone's gain is inside motion.js (RATE_GAIN) since NOTES 82, not on the power
const CUT = S.BOUNCE.along - S.SLICE.along;                   // the forward speed a spun bounce loses, per unit spin (scene.js: (SPUN.along - FLOOR.along) * spin)

const current = { name: 'current', slice: e => clientOf(e).slice, sliced: S.sliced };
const models = [current];
if (opt('--candidate')) { const c = await import(pathToFileURL(path.resolve(opt('--candidate'))).href);
  models.push({ name: c.name || path.basename(opt('--candidate')), slice: c.slice, sliced: c.sliced || S.sliced }); }

// ---------- one settled swing -> everything about its spin ----------
function score(e, model, gain = 1) {
  const cl = clientOf(e), lob = cl.lob, n = nOf(e, gain), slice = model.slice(e, { gain, lob }), spin = model.sliced(slice, lob), kind = S.shotKind(n, lob, slice);
  const kick = S.SLICE.kick * spin * (0.55 + 0.45 * Math.min(1, Math.abs(e.dir || 0)));          // = solve(): sideways m/s thrown at the first bounce
  // ground speed at the bounce (ASSUMED, for the swirl's cut term only): a drive from the baseline, 6.5 m + depth over T (solve()'s own depth and T)
  const depth = 2.6 + 3.3 * n, T = 1.2 - 0.62 * Math.pow(n, 0.85), vg = (6.5 + depth) / T;
  const D = Math.hypot(vg * CUT * spin + 0, kick);                                              // scene.js swirl: |ground-speed change| (kick is sideways, the cut is along)
  const swirl = spin > 0.02 && D / 4 > 0.05;                                                    // scene.js: spinFx.visible = spinW > 0.05, spinW -> clamp(D / 4)
  const air = S.smooth(n, S.CURVE.from, S.CURVE.full) * S.flat(lob) * (1 - S.lofted(lob) * (1 - S.smooth(spin, S.SLICE.at - 0.05, S.SLICE.at)));   // solve()'s w: the hard-drive air curl (power, not spin)
  return { slice, spin, kind, kick, D, swirl, air, lob, n };
}
function ingredients(e) {
  const cl = clientOf(e);
  return { raw: e.raw || 0, power: e.power, rom: e.rom || 0, roll: Math.abs(e.roll || 0), turn: e.turn || 0, curl: e.curl || 0, dir: e.dir || 0,
    rollT: cl.roll, curveT: cl.curve, amount: cl.amount, driver: cl.amount < 1e-9 ? 'none' : cl.curve >= cl.roll ? 'curve' : 'roll', tpr: (e.turn || 0) / Math.max(0.2, (e.rom || 0) * Math.PI / 180) };
}

// ---------- the recordings ----------
const SHARED = '/Users/danieltan/airpod-pickleball/data', LOCAL = new URL('../data/', import.meta.url).pathname;
const HEAD = ['live-swings.jsonl', 'live-play-1.jsonl', 'live-play-2.jsonl', 'live-play-3.jsonl'];
const where = f => { if (path.isAbsolute(f)) return fs.existsSync(f) ? f : null; for (const d of [SHARED, LOCAL]) { const p = path.join(d, path.basename(f)); if (fs.existsSync(p)) return p; } return null; };
function replay(file) {
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(r => r && r.q && r.r);   // (live-play-2 has a torn line)
  const m = new MotionModel(), q0 = rows[0].q, T0 = rows[0].t - 8;
  for (let i = 0; i < 400; i++) { const t = T0 + i * 0.02, k = i * 0.02, tip = k < 5.4 ? 0 : k < 6 ? 0.6 * (k - 5.4) / 0.6 : 0.6; m.feed({ t, q: qmul(qaxis([1, 0, 0], tip), q0), r: [0, 0, 0], a: [0, 0, 0] }, t * 1000); }
  const last = new Map(); let id = 0;
  for (const r of rows) for (const e of m.feed(r, r.t * 1000)) {
    if (e.type === 'swing') { id++; last.set(id, { e, t0: r.t, t1: null }); }
    else if (e.type === 'swingFix' && last.has(id)) last.get(id).e = e;
    else if (e.type === 'swingEnd' && last.has(id)) last.get(id).t1 = r.t;
  }
  return [...last.values()].map(({ e, t0, t1 }) => ({ e, file: path.basename(file), dur: t1 != null ? t1 - t0 : NaN }));
}

// ---------- stats ----------
const pct = (a, p) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : NaN; };
const share = (a, f) => (a.length ? (a.filter(f).length / a.length * 100).toFixed(0).padStart(3) + '%' : '  - ');
const f2 = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '-');
const rank = a => { const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]), r = new Array(a.length); for (let i = 0; i < idx.length;) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2; i = j + 1; } return r; };
const pearson = (x, y) => { const n = x.length, mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n; let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; } return sxy / Math.sqrt(sxx * syy || 1); };
const spear = (x, y) => { const ok = x.map((v, i) => Number.isFinite(v) && Number.isFinite(y[i])); const X = x.filter((_, i) => ok[i]), Y = y.filter((_, i) => ok[i]); return X.length > 2 ? pearson(rank(X), rank(Y)) : NaN; };
const P = [0.1, 0.25, 0.5, 0.75, 0.9];
const prow = (name, a, d = 2) => console.log(`   ${name.padEnd(20)} ${P.map(p => `p${String(p * 100).padStart(2, '0')} ${f2(pct(a, p), d).padStart(6)}`).join('  ')}   max ${f2(Math.max(...a.filter(Number.isFinite)), d)}`);
const hist = (name, a, w, max) => { const b = Math.round(max / w), c = new Array(b + 1).fill(0); for (const v of a) c[Math.min(b, Math.max(0, Math.floor(v / w)))]++; const top = Math.max(...c);
  console.log(`   ${name} (bins of ${w}; last bin = ${max}+):`); c.forEach((k, i) => console.log(`     ${f2(i * w).padStart(5)}${i === b ? '+    ' : '-' + f2((i + 1) * w).padEnd(5)} ${String(k).padStart(3)} ${'#'.repeat(Math.round(k / top * 40))}`)); };

function audit(title, swings) {
  const real = swings.filter(s => s.e.power >= 9);
  console.log(`\n=============== ${title}: ${swings.length} settled swings, ${real.length} real strokes (power >= 9) ===============`);
  const I = real.map(s => ({ ...ingredients(s.e), dur: s.dur, file: s.file })), col = k => I.map(r => r[k]);
  const sc = models.map(m => real.map(s => score(s.e, m)));
  console.log('INGREDIENTS (real strokes)   [rollT / curveT = the main.js roll and curl-per-radian intent terms (after their knees), amount = the larger x the speed scale]');
  for (const [nm, k, d] of [['raw peak rad/s', 'raw', 1], ['power', 'power', 1], ['rom deg', 'rom', 0], ['|roll| (share)', 'roll', 2], ['turn rad', 'turn', 2], ['turn / rom rad', 'tpr', 2], ['|curl|', null, 2], ['swing dur s', 'dur', 2], ['rollT', 'rollT', 2], ['curveT', 'curveT', 2], ['amount', 'amount', 2]])
    prow(nm, k ? col(k) : I.map(r => Math.abs(r.curl)), d);
  prow('n (server power)', sc[0].map(r => r.n), 2);
  hist('|roll|', col('roll'), 0.05, 0.8); hist('turn rad', col('turn'), 0.2, 3.6);
  const dr = { roll: 0, curve: 0, none: 0 }; for (const r of I) dr[r.driver]++;
  console.log(`   WHICH TERM SETS THE AMOUNT: curve ${dr.curve} (${(dr.curve / I.length * 100).toFixed(0)}%), roll ${dr.roll} (${(dr.roll / I.length * 100).toFixed(0)}%), neither ${dr.none}`);
  const B = [[0, 1e-9, '0'], [1e-9, 0.2, '<.2'], [0.2, 0.5, '.2-.5'], [0.5, 2, '>.5']], bin = v => B.findIndex(([a, b]) => v >= a && v < b);
  const X = B.map(() => B.map(() => 0)); for (const r of I) X[bin(r.rollT)][bin(r.curveT)]++;
  console.log('   crosstab rows = rollT, cols = curveT:    ' + B.map(b => b[2].padStart(6)).join('')); X.forEach((row, i) => console.log(`     ${B[i][2].padEnd(6)}${' '.repeat(29)}${row.map(v => String(v).padStart(6)).join('')}`));
  console.log('SPEARMAN RANK CORRELATION (real strokes)');
  const sp = sc[0].map(r => r.spin);
  for (const [nm, a] of [['|roll|', col('roll')], ['turn', col('turn')], ['rollT', col('rollT')], ['curveT', col('curveT')], ['amount', col('amount')], ['sliced (spin)', sp]])
    console.log(`   ${nm.padEnd(14)} vs raw ${f2(spear(a, col('raw'))).padStart(5)}   vs power ${f2(spear(a, col('power'))).padStart(5)}   vs rom ${f2(spear(a, col('rom'))).padStart(5)}   vs dur ${f2(spear(a, col('dur'))).padStart(5)}`);
  console.log(`   (pearson spin vs raw ${f2(pearson(sp, col('raw')))};  turn vs |roll| spearman ${f2(spear(col('turn'), col('roll')))})`);
  console.log('WHAT THE PLAYER GETS (real strokes)'.padEnd(52) + models.map(m => (" " + m.name).padStart(20)).join(''));
  const line = (nm, f) => console.log('   ' + nm.padEnd(49) + sc.map(a => (" " + f(a)).padStart(20)).join(''));
  line('spin p25 / p50 / p75 / p90', a => [0.25, 0.5, 0.75, 0.9].map(p => f2(pct(a.map(r => r.spin), p))).join('/'));
  line('spin exactly 0', a => share(a, r => r.spin === 0));
  line('spin > 0.02 (the ball is drawn spinning)', a => share(a, r => r.spin > 0.02));
  line('swirl visible (scene.js: D > 0.2 m/s)', a => share(a, r => r.swirl));
  line('sliced > 0.1', a => share(a, r => r.spin > 0.1));
  line('sliced > 0.3', a => share(a, r => r.spin > 0.3));
  line(`labelled 'slice' (> SLICE.at ${S.SLICE.at})`, a => share(a, r => r.kind === 'slice'));
  line('bounce kick > 0.3 m/s (a visible break)', a => share(a, r => r.kick > 0.3));
  line('bounce kick > 0.8 m/s (a big break)', a => share(a, r => r.kick > 0.8));
  line('kick p50 / p90 m/s', a => f2(pct(a.map(r => r.kick), 0.5)) + '/' + f2(pct(a.map(r => r.kick), 0.9)));
  line('spearman spin vs raw rad/s', a => f2(spear(a.map(r => r.spin), col('raw'))));
  line('spearman spin vs power', a => f2(spear(a.map(r => r.spin), col('power'))));
  line('air curl (hard flat drive: power only, NOT spin)', a => share(a, r => r.air > 0.01));
  console.log('   kinds');
  sc.forEach((a, i) => { const k = {}; for (const r of a) k[r.kind] = (k[r.kind] || 0) + 1; console.log(`     ${models[i].name}: ` + Object.entries(k).sort((x, y) => y[1] - x[1]).map(([n, v]) => `${n} ${(v / a.length * 100).toFixed(0)}%`).join(', ')); });
  if (ROWS) { console.log('   rows: file  raw  power  rom  |roll|  turn  curl  rollT curveT amount -> ' + models.map(m => m.name + ' spin/kind').join('  '));
    I.forEach((r, i) => console.log(`   ${r.file.padEnd(18)} ${f2(r.raw, 1).padStart(5)} ${f2(r.power, 1).padStart(5)} ${f2(r.rom, 0).padStart(4)} ${f2(r.roll).padStart(5)} ${f2(r.turn).padStart(5)} ${f2(r.curl).padStart(6)} ${f2(r.rollT).padStart(5)} ${f2(r.curveT).padStart(5)} ${f2(r.amount).padStart(5)} -> ` + sc.map(a => `${f2(a[i].spin)} ${a[i].kind}`.padEnd(14)).join(''))); }
  return { real, I, sc };
}

const pick = opt('--files') ? opt('--files').split(',') : HEAD;
const load = list => list.flatMap(f => { const p = where(f); if (!p) { console.log(`${f}: not found (looked in ${SHARED} and ${LOCAL}), skipped`); return []; } const s = replay(p); console.log(`${p}: ${s.length} settled swings, ${s.filter(x => x.e.power >= 9).length} real`); return s; });
const head = load(pick);
audit(opt('--files') ? 'THESE FILES' : 'HEADLINE (the four recordings test/kinds.mjs reads)', head);
const flicks = head.filter(s => s.file === 'live-swings.jsonl');
if (flicks.length) audit('NO SLICE INTENDED (live-swings.jsonl: deliberate flicks and wide arm swings only)', flicks);

// ---------- synthetic intent anchors (test/lobsynth.mjs): what a stroke MEANS is known ----------
// extra variants of its strokes: a flat forehand (no roll at all), a heavy natural roll-over, and a light (60 %) forehand slice
const scale = (name, k, ch) => ({ ...STROKES[name], moves: STROKES[name].moves.map(m => (ch.includes(m[0]) && m[1] > 400 ? [m[0], m[1], m[2], m[3] * k, m[4]] : m)) });   // the forward swing and its recovery, not the take-back
STROKES.fh_drive_flat = { ...scale('fh_drive', 0, ['rho']), label: 'forehand drive, no roll at all', expect: 'drive' };
STROKES.fh_drive_roll = { ...scale('fh_drive', 1.75, ['rho']), label: 'forehand drive, heavy roll-over (-35)', expect: 'drive' };
STROKES.fh_slice_light = { ...scale('fh_slice', 0.6, ['rho', 'phi']), label: 'forehand slice, light (60 %)', expect: 'slice' };
const ANCH = ['fh_drive_flat', 'fh_drive', 'fh_drive_roll', 'bh_drive', 'smash', 'wide_lob', 'straight_lob', 'fh_slice_light', 'fh_slice', 'bh_slice', 'bh_slice_rev', 'bh_slice_wide', 'bh_chip'];
console.log(`\n=============== SYNTHETIC INTENT ANCHORS (test/lobsynth.mjs, ${SEEDS} seeds each; median ingredients, spin per model) ===============`);
console.log('   stroke                                   grip    expect  raw   |roll| turn  rollT curveT | ' + models.map(m => (m.name + ' spin p50 [min-max] kinds').padEnd(44)).join(''));
const med = a => pct(a, 0.5);
const anchorScore = models.map(() => ({ noIntent: [], intent: [] }));
for (const k of ANCH) for (const grip of Object.keys(GRIPS)) {
  const rs = []; for (let s = 0; s < SEEDS; s++) { try { const r = runStroke({ stroke: k, grip, seed: s }); if (r.hit) rs.push(r.hit.last); } catch (err) { /* a seed that fails to calibrate is skipped */ } }
  if (!rs.length) { console.log(`   ${k}: no swing`); continue; }
  const gain = GRIPS[grip].gain, I = rs.map(ingredients);
  const cells = models.map((m, mi) => { const a = rs.map(e => score(e, m, gain)), sp = a.map(r => r.spin), kd = {}; for (const r of a) kd[r.kind] = (kd[r.kind] || 0) + 1;
    (STROKES[k].expect === 'slice' ? anchorScore[mi].intent : ['drive', 'smash'].includes(STROKES[k].expect) ? anchorScore[mi].noIntent : []).push(...a);
    return `${f2(med(sp))} [${f2(Math.min(...sp))}-${f2(Math.max(...sp))}] ${Object.entries(kd).map(([n, v]) => n + ' ' + v).join(', ')}`.padEnd(44); });
  console.log(`   ${STROKES[k].label.slice(0, 40).padEnd(40)} ${grip.padEnd(7)} ${STROKES[k].expect.padEnd(6)} ${f2(med(I.map(r => r.raw)), 1).padStart(5)} ${f2(med(I.map(r => r.roll))).padStart(5)} ${f2(med(I.map(r => r.turn))).padStart(5)} ${f2(med(I.map(r => r.rollT))).padStart(5)} ${f2(med(I.map(r => r.curveT))).padStart(5)}  | ${cells.join('')}`);
}
console.log('   ANCHOR SUMMARY'.padEnd(52) + models.map(m => (" " + m.name).padStart(20)).join(''));
const al = (nm, f) => console.log('   ' + nm.padEnd(49) + anchorScore.map(f).map(v => (" " + v).padStart(20)).join(''));
al('drives/smashes (no intent): spin p50', a => f2(med(a.noIntent.map(r => r.spin))));
al(`drives/smashes: spin > SLICE.at ${S.SLICE.at}`, a => share(a.noIntent, r => r.spin > S.SLICE.at));
al('drives/smashes: labelled slice', a => share(a.noIntent, r => r.kind === 'slice'));
al('drives/smashes: kick > 0.3 m/s', a => share(a.noIntent, r => r.kick > 0.3));
al('slices/chips (intent): spin p50', a => f2(med(a.intent.map(r => r.spin))));
al(`slices/chips: spin > SLICE.at ${S.SLICE.at} (power-free)`, a => share(a.intent, r => r.spin > S.SLICE.at));
al('slices/chips: labelled slice (tap if n < 0.1)', a => share(a.intent, r => r.kind === 'slice'));
al('slices/chips: kick > 0.3 m/s', a => share(a.intent, r => r.kick > 0.3));
console.log(`   (PHONE_GAIN ${PHONE_GAIN}; the phone grip is the DEFAULT paddle and has no recordings: these rows are its only data)`);
