// The court's sounds, synthesised once into buffers (NOTES 259). Pure functions: (sample rate, options) -> Float32Array, mono, peak 1, no
// Web Audio and no DOM, so test/sfx-ab.mjs renders exactly these in Node to WAV files to listen to. scene.js imports this at the first
// gesture and fills its bank a job per idle slot (bankJobs); a voice played before its buffers exist falls back to the old oscillators.
//   whoosh  a paddle cutting the air: broadband noise through two resonances that ride the paddle's speed (a fast rise to the swing's peak,
//           a slower fall), loudness ~ speed^1.6, a flutter from the edge's vortex shedding, the pitch dropping a little past the peak
//   pock    the pickleball pop: the old oscillator voice (a pitched knock dropping into place, the hollow ball an octave under, the felt
//           thump, a bright click) rebuilt as a buffer, with per-variant variation
//   bounce  the same ball on a hard court: a duller, shorter 'tok' (lower shell modes, the ground's thud), no paddle
//   squeak  a shoe sole's stick-slip: a steady, harsh 1.3-1.8 kHz slip train ringing the sole and floor (~2.4, ~4.6 kHz), flickering grip, scuff
//   room    a short stereo impulse response for an outdoor court with walls (two channels): early slaps, then a quick dull tail
const TAU = Math.PI * 2;
export const rng = seed => { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };

// A state-variable band-pass whose centre and Q may change every sample (Chamberlin, oversampled twice so a high centre stays stable).
function svf() {
  let lo = 0, bp = 0;
  return (x, fc, q, sr) => { const f = 2 * Math.sin(Math.PI * Math.min(fc, sr / 6) / (2 * sr)), d = 1 / q;
    for (let k = 0; k < 2; k++) { lo += f * bp; const hi = x - lo - d * bp; bp += f * hi; } return bp; };
}
const norm = (d, peak = 1) => { let m = 0; for (let i = 0; i < d.length; i++) m = Math.max(m, Math.abs(d[i])); if (m > 0) { const k = peak / m; for (let i = 0; i < d.length; i++) d[i] *= k; } return d; };
const fadeOut = (d, sr, ms = 4) => { const n = Math.min(d.length, Math.round(sr * ms / 1000)); for (let i = 0; i < n; i++) d[d.length - 1 - i] *= i / n; return d; };

export function whoosh(sr, { p = 0.6, seed = 1 } = {}) {
  const r = rng(seed * 7919 + 13), T = 0.34 - 0.08 * p + 0.03 * r(), n = Math.round(sr * T), d = new Float32Array(n);
  const tp = T * (0.4 + 0.06 * r()), up = T * 0.17, down = T * 0.27, f1 = svf(), f2 = svf(), fl = 26 + 18 * p + 8 * r();
  let pink = 0, flPh = r() * TAU;
  for (let i = 0; i < n; i++) {
    const t = i / sr, x = (t - tp) / (t < tp ? up : down), v = Math.exp(-x * x);       // the paddle's speed past the ear, 0..1
    const w = r() * 2 - 1; pink = 0.86 * pink + 0.14 * w;                               // a darker noise for the body, white for the edge
    const drop = t < tp ? 1 : 0.86 + 0.14 * Math.exp(-(t - tp) / 0.05);                 // past the peak the paddle is going away: a little lower
    const body = f1(pink * 3, (220 + 680 * v * (0.75 + 0.5 * p)) * drop, 1.1, sr);
    const edge = f2(w, (700 + 2000 * v * (0.6 + 0.6 * p)) * drop, 2.2, sr);
    flPh += TAU * fl * (1 + 0.6 * v) / sr;
    const flutter = 1 + 0.22 * v * Math.sin(flPh) * (0.7 + 0.3 * r());
    d[i] = (body + edge * (0.25 + 0.3 * p)) * Math.pow(v, 1.6) * flutter;
  }
  return fadeOut(norm(d), sr);
}

export function pock(sr, { n = 0.5, seed = 1 } = {}) {
  // The pop the owner preferred (scene.js's oscillator voice before NOTES 259), rebuilt sample for sample as a buffer: the same four layers,
  // gains, glides and exponential envelopes (2 ms rise, down to -80 dB at each layer's end), with a few % of pitch and noise variation per
  // variant. NOTES 259's first pop rang high shell modes (1.25-5.2 kHz sines) and sounded like glass (NOTES 260).
  const r = rng(seed * 104729 + 7), T = 0.18, len = Math.round(sr * T), d = new Float32Array(len), det = 1 + (r() - 0.5) * 0.06;
  const f = (880 + 520 * n) * det, g = 0.6 + 0.7 * n, E = 0.0001;
  const env = (t, peak, end, rise = 0.002) => t >= end ? 0 : t < rise ? E * Math.pow(peak / E, t / rise) : peak * Math.pow(E / peak, (t - rise) / (end - rise));
  const glide = (f0, f1, tg) => { let ph = r() * TAU; return t => { const fr = t < tg ? f0 * Math.pow(f1 / f0, t / tg) : f1; ph += TAU * fr / sr; return ph; }; };
  const thump = glide(170 + 60 * n, 70, 0.004), knock = glide(f * 1.6, f, 0.018), hollow = glide(f * 0.5, f * 0.46, 0.05), bp = svf();
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    let x = Math.sin(thump(t)) * env(t, 0.35 + 0.5 * n, 0.16);                    // the thump you feel: heavier with power
    x += Math.sin(knock(t)) * env(t, g, 0.085);                                     // the pitched knock, dropping into place
    x += (2 / Math.PI) * Math.asin(Math.sin(hollow(t))) * env(t, g * 0.5, 0.13);    // the hollow ball under it
    if (t < 0.03) { const fc = t < 0.0135 ? 3200 * Math.pow(0.75, t / 0.0135) : 2400 * Math.pow(0.75, (t - 0.0135) / 0.0165); x += bp(r() * 2 - 1, fc, 0.8, sr) * env(t, g * 0.5, 0.03, 0.001); }      // the click
    d[i] = x;
  }
  return fadeOut(norm(d), sr);
}

export function bounce(sr, { h = 0.6, seed = 1 } = {}) {
  const r = rng(seed * 15485863 + 3), T = 0.09, len = Math.round(sr * T), d = new Float32Array(len), det = 1 + (r() - 0.5) * 0.06, nc = Math.round(sr * 0.0012);
  for (const [f0, a, tau] of [[960, 1, 0.013], [1480, 0.5, 0.009], [2250, 0.3 * (0.6 + h), 0.006], [3300, 0.14 * h, 0.004]]) {
    const f = f0 * det, ph = r() * TAU; for (let i = 0; i < len; i++) { const t = i / sr; d[i] += a * Math.min(1, i / nc) * Math.exp(-t / tau) * Math.sin(TAU * f * t + ph); } }
  for (let i = 0; i < len; i++) { const t = i / sr; d[i] += 0.15 * Math.min(1, i / nc) * Math.exp(-t / 0.014) * Math.sin(TAU * 105 * t); }      // the court under it
  const bp = svf(); for (let i = 0; i < nc * 3; i++) d[i] += bp(r() * 2 - 1, 2600, 0.9, sr) * Math.sin(Math.PI * Math.min(1, i / (nc * 2))) * (0.5 + 0.5 * h);
  return fadeOut(norm(d), sr);
}

export function squeak(sr, { seed = 1 } = {}) {
  // A rubber sole skidding on a hard court: stick-slip. The sole grabs and lets go 1.3-1.8 kHz, a little unevenly (a pulse train with +-6 %
  // jitter: harsh and steady, not a smooth tone), and each release rings the sole and the floor (two resonances, ~2.4 and ~4.6 kHz), under a
  // hiss of scuff. The rate creeps up 5 % as the foot loads and the grip flickers: no vibrato and no rise-and-fall arc (those made NOTES 259's
  // first squeak sound like an animal, NOTES 260).
  const r = rng(seed * 2654435761 + 5), T = 0.07 + 0.06 * r(), len = Math.round(sr * T), d = new Float32Array(len);
  const rate0 = 1300 + 500 * r(), res1 = 2200 + 600 * r(), res2 = 4300 + 800 * r(), a = svf(), b = svf(), sc = svf();
  let next = 0, grip = 1, lp = 0; const kLp = 1 - Math.exp(-TAU * 3400 / sr);
  for (let i = 0; i < len; i++) {
    const t = i / sr, u = t / T;
    let e = 0;
    if (i >= next) { e = 0.6 + 0.8 * r(); next = i + Math.max(2, Math.round(sr / (rate0 * (1 + 0.05 * u)) * (0.94 + 0.12 * r()))); }      // a slip
    if ((i & 63) === 0) grip = 0.55 + 0.45 * r();                                // the grip flickers every ~1.3 ms
    const env = Math.min(1, t / 0.004) * Math.min(1, (T - t) / 0.012) * grip;
    lp += kLp * ((a(e, res1, 7, sr) * 0.8 + b(e, res2, 6, sr) * 0.22) * env + sc(r() * 2 - 1, 4800, 0.9, sr) * 0.1 * env - lp); d[i] = lp;      // the sole's rubber softens the top
  }
  return fadeOut(norm(d), sr);
}

export function room(sr, { seed = 1 } = {}) {        // -> [left, right]
  const T = 0.55, len = Math.round(sr * T), out = [new Float32Array(len), new Float32Array(len)];
  for (let c = 0; c < 2; c++) {
    const r = rng(seed * 31 + c * 977), d = out[c];
    for (const [ms, a] of [[9, 0.5], [17, 0.34], [26, 0.28], [41, 0.2], [58, 0.14]]) { const i = Math.round(sr * (ms + (r() - 0.5) * 4) / 1000); if (i < len) d[i] += a * (r() < 0.5 ? -1 : 1); }      // the back walls and the fence
    let dark = 0; for (let i = Math.round(sr * 0.02); i < len; i++) { const t = i / sr; dark = 0.7 * dark + 0.3 * (r() * 2 - 1); d[i] += dark * 0.22 * Math.exp(-t / 0.11) * Math.min(1, (t - 0.02) / 0.02); }      // a dull, quick tail: open air
  }
  const m = Math.max(...out.map(d => d.reduce((a, x) => a + x * x, 0))); for (const d of out) for (let i = 0; i < len; i++) d[i] /= Math.sqrt(m) * 1.4;
  return out;
}

// What scene.js builds, one job per idle slot: [bank key, () => Float32Array]. Variants are picked at random per play, so no two hits are
// the same buffer twice running, and a played buffer is also nudged in rate (+-3 %).
export function bankJobs(sr) {
  const j = [];
  for (const p of [0.3, 0.65, 1]) for (const s of [1, 2, 3]) j.push(['whoosh' + p, () => whoosh(sr, { p, seed: s })]);
  for (const n of [0, 0.25, 0.5, 0.75, 1]) for (const s of [1, 2]) j.push(['pock' + n, () => pock(sr, { n, seed: s })]);
  for (const h of [0.35, 0.9]) for (const s of [1, 2, 3]) j.push(['bounce' + h, () => bounce(sr, { h, seed: s })]);
  for (const s of [1, 2, 3, 4, 5]) j.push(['squeak', () => squeak(sr, { seed: s })]);
  return j;
}
