// Effort vs smash: replays the real AirPod captures through MotionModel, snapshots every SETTLED swing's ingredients
// (peak rad/s, deg swept to the peak, rise time, peak |a|, shape) and prints how power, n and the called kind follow them,
// on the AirPod path and on the phone path (motion.js RATE_GAIN = PHONE_GAIN on the rate the effortless part reads, main.js pw(): raw x
// PHONE_GAIN for the serve). NOTES 82 is what this was built for. Candidates plug in as a module:
//   node test/effort.mjs [--cand path/to/cand.mjs] [--gain 1.5] [--all] [--json] [--list]
// cand.mjs may export  power(f, c)  -> motion power (replaces motion.js powerOf for the settled call; c = DEFAULTS with RATE_GAIN = the path's gain)
//                      n(power, f)  -> server n incl. any overhead bonus (f.raw is phone-scaled on the phone path, as main.js sends it)
// 'real' strokes (old power >= 9) and the 'saturated' shape (old credit >= 0.95) are fixed per swing by the OLD formula (oldPower,
// oldCredit: motion.js before NOTES 82), so every candidate and path shares one denominator.
// Either may be left out (the live one is used). The !final cap and shotKind are applied here, after n(), always.
// Also importable: import { features, score, report, livePower, oldPower, oldCredit, liveN } from './effort.mjs'.
import { MotionModel, DEFAULTS, qaxis, qmul } from '../web/motion.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const DEG = Math.PI / 180, clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const src = fs.readFileSync(new URL('../server/game.js', import.meta.url), 'utf8');
const grab = name => { const i = src.indexOf('const ' + name + ' = '); return src.slice(i, src.indexOf('\n', i)); };
const { shotKind, SMASH } = new Function('const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));' + ['SLICE', 'SMASH', 'SMASH_UP', 'LOB_ARC', 'underhand', 'sliced', 'smooth', 'lofted', 'flat', 'hard', 'shotKind'].map(grab).join('\n') + '\nreturn { shotKind, SMASH };')();
const main = fs.readFileSync(new URL('../web/main.js', import.meta.url), 'utf8');
const a0 = main.indexOf('const roll = Math.max('), a1 = main.indexOf("game.send({ type: 'swing'", a0); if (a0 < 0 || a1 < 0) throw new Error('web/main.js: the swing maths moved');
const clientOf = new Function('e', main.slice(a0, a1) + '; return { level: 0, roll, curve, amount, way, slice, lob };');
const chopRule = /m\.chop, 0\), 0, 1\) > ([\d.]+) && pw > ([\d.]+)\) pw = Math\.min\(1, pw \+ ([\d.]+)\)/.exec(src);
const [CHOP, CHOP_N, CHOP_ADD] = chopRule ? chopRule.slice(1).map(Number) : [0.45, 0.55, 0];   // the server's overhead bonus, if it has one (gone since NOTES 82: + 0)
const gainM = /PHONE_GAIN = Math\.max\(0\.5, Math\.min\(3, \+qs\.get\('padgain'\) \|\| ([\d.]+)\)\)/.exec(main);
export const PHONE_GAIN = gainM ? +gainM[1] : 1.5;

// ---- the live formulas (motion.js powerOf, server swing handler) as pure functions of the snapshot ----
// livePower mirrors motion.js powerOf (NOTES 82): an effortless part (<= EASY, leaning a little on the GAINED rate) + a speed part (physical rate).
export function livePower(f, c = DEFAULTS) {
  const g = f.raw * c.RATE_GAIN, romC = clamp((f.romPk - c.ROM_MIN) / (c.ROM_FULL - c.ROM_MIN), 0, 1);
  const easy = c.EASY * (c.EASY_F0 + (1 - c.EASY_F0) * clamp((g - c.EASY_R[0]) / (c.EASY_R[1] - c.EASY_R[0]), 0, 1)) * (1 - (1 - romC) ** 2) * clamp((f.rise - c.EASY_T[0]) / c.EASY_T[1], 0, 1);
  const e = clamp((f.raw * Math.sqrt(c.RATE_GAIN) - c.PACE_R[0]) / (c.PACE_R[1] - c.PACE_R[0]), 0, 1), pace = (1 - c.EASY) * romC * clamp((f.rise - c.PACE_T[0]) / c.PACE_T[1], 0, 1) * e * e;
  return c.TAP + (c.POWER_MAX - c.TAP) * (easy + pace);
}
// the old one (before NOTES 82): ROM x rise credit, x a rate factor that stopped at 14 rad/s. Kept for the fixed baselines.
export function oldPower(f, c = DEFAULTS) { return c.TAP + (c.POWER_MAX - c.TAP) * oldCredit(f, c) * (0.8 + 0.2 * clamp(f.raw / 14, 0, 1)); }
export const oldCredit = (f, c = DEFAULTS) => clamp((f.romPk - c.ROM_MIN) / (c.ROM_FULL - c.ROM_MIN), 0, 1) * clamp((f.rise - c.ROM_T_MIN) / (c.ROM_T_FULL - c.ROM_T_MIN), 0, 1);
export function liveN(power, f) { let n = clamp((power - 6) / 28, 0, 1); if (clamp(f.chop, 0, 1) > CHOP && n > CHOP_N) n = Math.min(1, n + CHOP_ADD); return n; }

// ---- recordings ----
const LIVE = '/Users/danieltan/airpod-pickleball/data/';
const FILES = ['live-swings.jsonl', 'live-play-1.jsonl', 'live-play-2.jsonl', 'live-play-3.jsonl'];
const EXTRA = ['live-capture.jsonl', 'live2.jsonl'];
function load(name) {
  const repo = fileURLToPath(new URL('../data/' + name, import.meta.url));
  const p = fs.existsSync(LIVE + name) ? LIVE + name : fs.existsSync(repo) ? repo : null;
  if (!p) return null;
  return fs.readFileSync(p, 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(r => r && r.q && r.r);
}

// features(): one row per detected swing, with the snapshot taken at its settled (final: true) report.
// Row: { file, settled, e (the event), power (motion.js's own), f: { raw, romPk deg, rise s, sweep deg, chop, lob, dir, slice,
//   accM rad/s^2 (approx: motion.js resets it when the swing ends in the settling sample, so that sample's own take-off is lost),
//   aPk g (peak |a| of the samples from the trigger up to the peak, + 1 sample; samples between movement start and trigger are not seen), aMax g (to settle), mean rad/s = romPk/rise, turn, off, back, pitch0 deg } }
const cache = new Map();
export function features(files = FILES) {
  const key = files.join(','); if (cache.has(key)) return cache.get(key);
  const out = [];
  for (const name of files) {
    const rows = load(name); if (!rows) { console.error(`${name}: not here, skipped`); continue; }
    const m = new MotionModel(), q0 = rows[0].q, T0 = rows[0].t - 8;       // warm-up + calibration, as test/kinds.mjs
    for (let i = 0; i < 400; i++) { const t = T0 + i * 0.02, k = i * 0.02, tip = k < 5.4 ? 0 : k < 6 ? 0.6 * (k - 5.4) / 0.6 : 0.6; m.feed({ t, q: qmul(qaxis([1, 0, 0], tip), q0), r: [0, 0, 0], a: [0, 0, 0] }, t * 1000); }
    const acc = new WeakMap(), swings = []; let cur = null;
    for (const r of rows) {
      const before = m.sw, acc0 = m.accM || 0, evs = m.feed(r, r.t * 1000), sw = m.sw || before;
      if (sw) { let A = acc.get(sw); if (!A) acc.set(sw, A = []); A.push([r.t, Math.hypot(...(r.a || [0, 0, 0]))]); }
      for (const e of evs) {
        if (e.type === 'swing') { cur = { file: name, settled: false, e, sw, bet: e }; swings.push(cur); }
        if ((e.type === 'swing' || e.type === 'swingFix') && cur) { cur.e = e;
          if (e.final && !cur.settled) { const A = acc.get(sw) || [], rise = sw.tPk - sw.mv0;
            cur.settled = true; const sp = clientOf(e);
            cur.f = { raw: sw.peak, romPk: sw.romPk / DEG, rise, sweep: e.rom, chop: e.chop || 0, lob: sp.lob, slice: sp.slice, dir: e.dir,
              accM: Math.max(acc0, m.accM || 0), aPk: Math.max(0, ...A.filter(([t]) => t >= sw.mv0 - 0.021 && t <= sw.tPk + 0.021).map(x => x[1])), aMax: Math.max(0, ...A.map(x => x[1])),
              mean: sw.romPk / Math.max(rise, 1e-3), turn: e.turn || 0, off: e.off || 0, back: e.back || 0, pitch0: sw.from ? sw.from.pitch / DEG : 0 };
            cur.power = e.power; } }
        if (e.type === 'swingEnd' && cur && !cur.settled) cur.endPeak = e.peak;
      }
    }
    out.push(...swings);
  }
  // the gate: the snapshot must reproduce motion.js's own settled power exactly, or no candidate scored from it means anything
  let bad = 0; for (const s of out) if (s.settled && Math.abs(livePower(s.f) - s.power) > 1e-9) bad++;
  if (bad) throw new Error(`feature snapshot does not reproduce motion.js power on ${bad} swings: the capture is wrong`);
  cache.set(key, out); return out;
}

// ---- scoring ----
const pctl = (a, p) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const rank = a => { const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]), r = new Array(a.length); for (let i = 0; i < idx.length;) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2; i = j + 1; } return r; };
export const spearman = (x, y) => { if (x.length < 3) return NaN; const a = rank(x), b = rank(y), n = a.length, ma = (n - 1) / 2; let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - ma); saa += (a[i] - ma) ** 2; sbb += (b[i] - ma) ** 2; } return sab / Math.sqrt(saa * sbb || 1); };

// apply(): baseline 'real' (OLD unscaled power >= 9) is fixed per swing, whatever the candidate or path, so every view shares a denominator.
export function apply(swings, cand = {}, gain = 1) {
  const P = cand.power || livePower, N = cand.n || liveN, c = { ...DEFAULTS, RATE_GAIN: gain };
  return swings.filter(s => s.settled).map(s => {
    const f = { ...s.f, raw: s.f.raw * gain };                                // what the server hears as raw (main.js pw())
    const power = P(s.f, c);                                                  // scores the MOTION (physical rate); the gain goes in as c.RATE_GAIN
    const n = clamp(N(power, f), 0, 1), kind = shotKind(n, f.lob, f.slice);   // settled: final true, no bet cap
    return { file: s.file, real: oldPower(s.f) >= 9, f: s.f, credit: oldCredit(s.f), power, n, kind, smash: kind === 'smash' };
  });
}

export function score(swings, cand = {}, gain = 1) {
  const R = apply(swings, cand, gain), real = R.filter(r => r.real), raw50 = pctl(real.map(r => r.f.raw), 0.5), raw75 = pctl(real.map(r => r.f.raw), 0.75);
  const base = apply(swings, {}, 1).filter(r => r.real), b50 = pctl(base.map(r => r.f.raw), 0.5), b75 = pctl(base.map(r => r.f.raw), 0.75);
  const sm = real.filter(r => r.smash), chop = real.filter(r => r.f.chop > CHOP), sat = real.filter(r => r.credit >= 0.95);
  return {
    real: real.length, smash: sm.length, smashShare: sm.length / real.length,
    smashRawBelowP50: sm.filter(r => r.f.raw < b50).length, smashRawBelowP75: sm.filter(r => r.f.raw < b75).length, rawP50: b50, rawP75: b75,
    rhoNraw: spearman(real.map(r => r.f.raw), real.map(r => r.n)), rhoNrawChop: spearman(chop.map(r => r.f.raw), chop.map(r => r.n)),
    chopReal: chop.length, chopSmash: chop.filter(r => r.smash).length, minRawSmash: Math.min(...sm.map(r => r.f.raw)),
    // the saturated shape: ROM and rise credit both maxed on the OLD credit (fixed per swing). Before NOTES 82: every one a smash at any raw.
    satReal: sat.length, satSmash: sat.filter(r => r.smash).length, rhoNrawSat: spearman(sat.map(r => r.f.raw), sat.map(r => r.n)),
    // 'twitches' (old power < 9) the candidate/path now calls a shot: a wrist flick (romPk < 45 deg) promoted is a leak,
    // a wide one (>= 45 deg) promoted is a fast arm stroke the live rise credit had zeroed, rescued
    twitchLeak: R.filter(r => !r.real && r.kind !== 'tap' && r.n >= 0.1).length,
    leakSmallRom: R.filter(r => !r.real && r.kind !== 'tap' && r.n >= 0.1 && r.f.romPk < 45).length,
    leakWideRom: R.filter(r => !r.real && r.kind !== 'tap' && r.n >= 0.1 && r.f.romPk >= 45).length,
    nonRealArm: R.filter(r => !r.real && r.f.raw >= 20 && r.f.romPk >= 60).length,     // fast, wide, and still scored as a twitch
  };
}

// ---- report ----
const F = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '  -  ');
const dist = (name, a, d = 2) => `   ${name.padEnd(12)} p10 ${F(pctl(a, .1), d).padStart(6)}  p25 ${F(pctl(a, .25), d).padStart(6)}  p50 ${F(pctl(a, .5), d).padStart(6)}  p75 ${F(pctl(a, .75), d).padStart(6)}  p90 ${F(pctl(a, .9), d).padStart(6)}  p95 ${F(pctl(a, .95), d).padStart(6)}`;
const kinds = R => { const k = {}; for (const r of R) k[r.kind] = (k[r.kind] || 0) + 1; return Object.entries(k).sort((a, b) => b[1] - a[1]).map(([a, b]) => `${a} ${b}`).join(', '); };

export function report(swings, cand = {}, gain = 1, label = 'AirPod') {
  const log = console.log, R = apply(swings, cand, gain), real = R.filter(r => r.real);
  log(`\n======== ${label} path (gain ${gain}) ========`);
  const files = [...new Set(R.map(r => r.file))];
  for (const f of [...files, 'ALL']) {
    const S = f === 'ALL' ? real : real.filter(r => r.file === f), all = f === 'ALL' ? R : R.filter(r => r.file === f);
    log(`${f}: ${all.length} settled swings, ${S.length} real (old power >= 9); smash ${S.filter(r => r.smash).length} = ${F(100 * S.filter(r => r.smash).length / S.length, 0)}% of real;  kinds (real): ${kinds(S)}`);
    for (const [nm, k, d] of [['raw rad/s', r => r.f.raw, 1], ['romPk deg', r => r.f.romPk, 0], ['rise s', r => r.f.rise, 3], ['credit', r => r.credit, 2], ['power', r => r.power, 1], ['n', r => r.n, 2]]) log(dist(nm, S.map(k), d));
    if (f === 'ALL') for (const [nm, k, d] of [['sweep deg', r => r.f.sweep, 0], ['mean rad/s', r => r.f.mean, 1], ['aPk g', r => r.f.aPk, 2], ['accM', r => r.f.accM, 0], ['chop', r => r.f.chop, 2], ['lob', r => r.f.lob, 2], ['pitch0 deg', r => r.f.pitch0, 0]]) log(dist(nm, S.map(k), d));
  }
  const s = score(swings, cand, gain), sm = real.filter(r => r.smash);
  log(`\nJOINT: ${s.smash} smashes of ${s.real} real strokes (${F(100 * s.smashShare, 0)}%). raw (base) p50 ${F(s.rawP50, 1)}, p75 ${F(s.rawP75, 1)} rad/s.`);
  log(`   smashes with raw < p50: ${s.smashRawBelowP50}   < p75: ${s.smashRawBelowP75}   (relaxed-swing smashes)   min raw of a smash ${F(s.minRawSmash, 1)}`);
  log(dist('smash raw', sm.map(r => r.f.raw), 1)); log(dist('other raw', real.filter(r => !r.smash).map(r => r.f.raw), 1));
  log(dist('smash cred', sm.map(r => r.credit), 2)); log(dist('smash aPk', sm.map(r => r.f.aPk), 2));
  log(`   twitch leak (old power < 9 but called a shot, n >= 0.1): ${s.twitchLeak}  = small-ROM (<45 deg, a flick: bad) ${s.leakSmallRom} + wide-ROM (a stroke rescued) ${s.leakWideRom}`);
  log(`   saturated shape (old credit >= 0.95): ${s.satReal} real, ${s.satSmash} smash; spearman(n, raw) there = ${F(s.rhoNrawSat)}`);
  const nr = R.filter(r => !r.real);
  log(`   NON-real (old power < 9, ${nr.length}): ${s.nonRealArm} are fast (raw >= 20) AND wide (romPk >= 60): arm strokes the rise credit zeroed`);
  for (const [nm, k, d] of [['raw rad/s', r => r.f.raw, 1], ['romPk deg', r => r.f.romPk, 0], ['rise s', r => r.f.rise, 3], ['n', r => r.n, 2]]) log(dist(nm, nr.map(k), d));
  // the shape x strength table
  log(`\nSHAPE x STRENGTH (real strokes): count / mean credit / mean n / smash%`);
  const chopB = [['chop<0.2', r => r.f.chop < 0.2], ['0.2-0.45', r => r.f.chop >= 0.2 && r.f.chop <= CHOP], [`chop>${CHOP}`, r => r.f.chop > CHOP]];
  const rawB = [[0, 10], [10, 14], [14, 20], [20, 27], [27, 1e9]];
  log('   ' + 'shape'.padEnd(10) + rawB.map(([a, b]) => (b > 1e8 ? `raw>${a}` : `raw ${a}-${b}`).padStart(22)).join(''));
  for (const [nm, g] of chopB) log('   ' + nm.padEnd(10) + rawB.map(([a, b]) => { const c = real.filter(r => g(r) && r.f.raw >= a && r.f.raw < b); return (c.length ? `${c.length} / ${F(c.reduce((x, r) => x + r.credit, 0) / c.length)} / ${F(c.reduce((x, r) => x + r.n, 0) / c.length)} / ${F(100 * c.filter(r => r.smash).length / c.length, 0)}%` : '-').padStart(22); }).join(''));
  const ch = real.filter(r => r.f.chop > CHOP), chs = ch.filter(r => r.smash);
  log(`   chop>${CHOP}: ${ch.length} real, ${chs.length} smash; spearman(n, raw) = ${F(s.rhoNrawChop)}; smashes' min credit ${F(Math.min(...chs.map(r => r.credit)))}, min raw ${F(Math.min(...chs.map(r => r.f.raw)), 1)}, min romPk ${F(Math.min(...chs.map(r => r.f.romPk)), 0)}`);
  log(`   all real: spearman(n, raw) = ${F(s.rhoNraw)}, spearman(n, romPk) = ${F(spearman(real.map(r => r.f.romPk), real.map(r => r.n)))}, spearman(n, rise) = ${F(spearman(real.map(r => r.f.rise), real.map(r => r.n)))}, spearman(n, aPk) = ${F(spearman(real.map(r => r.f.aPk), real.map(r => r.n)))}`);
  return s;
}

function effortView(swings) {           // unlabeled: where do the candidate effort signals spread, among strokes the credit already maxes out?
  const log = console.log, R = apply(swings).filter(r => r.real), sat = R.filter(r => r.credit >= 0.95);
  log(`\n======== EFFORT SIGNALS (unlabeled data: spread and agreement, not accuracy) ========`);
  log(`credit >= 0.95 (ROM and rise both saturated): ${sat.length} of ${R.length} real strokes (${F(100 * sat.length / R.length, 0)}%), ${sat.filter(r => r.smash).length} of them smashes`);
  for (const [nm, k, d] of [['raw rad/s', r => r.f.raw, 1], ['mean rad/s', r => r.f.mean, 1], ['aPk g', r => r.f.aPk, 2], ['aMax g', r => r.f.aMax, 2], ['accM', r => r.f.accM, 0], ['romPk deg', r => r.f.romPk, 0], ['rise s', r => r.f.rise, 3]]) log(dist(nm, sat.map(k), d));
  const hist = (a, lo, w, nb) => { const h = new Array(nb).fill(0); for (const v of a) h[clamp(Math.floor((v - lo) / w), 0, nb - 1)]++; return h.map((c, i) => `${lo + i * w}:${c}`).join(' '); };
  log(`   raw histogram (saturated), 3 rad/s bins: ${hist(sat.map(r => r.f.raw), 6, 3, 10)}`);
  log(`   raw histogram (all real),  3 rad/s bins: ${hist(R.map(r => r.f.raw), 6, 3, 10)}`);
  const V = [['raw', r => r.f.raw], ['mean', r => r.f.mean], ['aPk', r => r.f.aPk], ['accM', r => r.f.accM], ['romPk', r => r.f.romPk], ['rise', r => r.f.rise]];
  log(`   spearman among real strokes:`); for (const [a, fa] of V) log('     ' + a.padEnd(6) + V.map(([b, fb]) => `${b} ${F(spearman(R.map(fa), R.map(fb)))}`.padStart(12)).join(''));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
  const cand = arg('--cand') ? await import(pathToFileURL(path.resolve(arg('--cand'))).href) : {};
  const gain = +(arg('--gain') || PHONE_GAIN), files = process.argv.includes('--all') ? [...FILES, ...EXTRA] : FILES;
  const S = features(files), unsettled = S.filter(s => !s.settled).length;
  console.log(`${S.length} swings detected, ${S.length - unsettled} settled (${unsettled} ended without a settled report: excluded). Snapshot reproduces motion.js power on every settled swing.`);
  console.log(`live rules: n = (power-6)/28; chop > ${CHOP} && n > ${CHOP_N} -> +${CHOP_ADD}; SMASH ${SMASH}; phone rate gain ${gain}.  candidate: ${arg('--cand') || '(live)'}`);
  const a = report(S, cand, 1, 'AirPod'), p = report(S, cand, gain, 'PHONE');
  effortView(S);
  if (process.argv.includes('--list')) {
    const row = r => `${r.file.padEnd(18)}${(r.real ? '' : '*').padEnd(2)}${F(r.f.raw, 1).padStart(5)} ${F(r.f.romPk, 0).padStart(5)} ${F(r.f.rise, 3)} ${F(r.credit)} ${F(r.f.chop)} ${F(r.f.lob)} ${F(r.f.pitch0, 0).padStart(5)} ${F(r.f.aPk, 1).padStart(5)} ${F(r.power, 1).padStart(5)} ${F(r.n)} ${r.kind}`;
    const R = apply(S, cand, 1), hdr = 'file                 raw romPk  rise  cred chop  lob  pitch0  aPk  power  n    kind   (* = old power < 9)';
    console.log(`\n--- top 24 by n (AirPod path, candidate) ---\n${hdr}`); for (const r of [...R].filter(r => r.real).sort((a, b) => b.n - a.n).slice(0, 24)) console.log(row(r));
    console.log(`--- fastest 15 by raw, all settled ---\n${hdr}`); for (const r of [...R].sort((a, b) => b.f.raw - a.f.raw).slice(0, 15)) console.log(row(r));
  }
  if (process.argv.includes('--json')) console.log(JSON.stringify({ airpod: a, phone: p }));
}
