// The court's sounds, synthesised once into buffers (NOTES 259). Pure functions: (sample rate, options) -> Float32Array, mono, peak 1, no
// Web Audio and no DOM, so test/sfx-ab.mjs renders exactly these in Node to WAV files to listen to. scene.js imports this at the first
// gesture and fills its bank a job per idle slot (bankJobs); a voice played before its buffers exist falls back to the old oscillators.
//   whoosh  a paddle pushing air aside: dark noise through two broad resonances that ride the paddle's speed (rise, peak, fall), softened
//           above ~2.4 kHz; each variant its own length, shape, pitch and depth
//   pock    the pickleball pop: the old oscillator voice (a pitched knock dropping into place, the hollow ball an octave under, the felt
//           thump, a bright click) rebuilt as a buffer, with per-variant variation
//   bounce  the same ball on a hard court: a duller, shorter 'tok' (lower shell modes, the ground's thud), no paddle
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
  // Air pushed aside, not a scrape (NOTES 263): only dark noise (no white "edge" layer, no per-sample grain), through two broad resonances that
  // ride the paddle's speed past the ear, softened above ~2.4 kHz. Each variant draws its own length, peak, rise/fall, pitch and depth, so
  // swings in a row never sound the same; play() also nudges each one's rate +-3 %.
  const r = rng(seed * 7919 + 13), T = (0.3 - 0.07 * p) * (0.85 + 0.35 * r()), n = Math.round(sr * T), d = new Float32Array(n);
  const tp = T * (0.36 + 0.14 * r()), up = T * (0.13 + 0.08 * r()), down = T * (0.22 + 0.12 * r());
  const pitch = 0.82 + 0.36 * r(), deep = 0.35 + 0.4 * r(), wob = 7 + 9 * r(), wobD = 0.05 + 0.07 * r(), f1 = svf(), f2 = svf(), kLp = 1 - Math.exp(-TAU * (2000 + 900 * p) / sr);
  let brown = 0, pink = 0, lp = 0, wPh = r() * TAU;
  for (let i = 0; i < n; i++) {
    const t = i / sr, x = (t - tp) / (t < tp ? up : down), v = Math.exp(-x * x);       // the paddle's speed past the ear, 0..1
    const w = r() * 2 - 1; pink = 0.9 * pink + 0.1 * w; brown = 0.985 * brown + 0.06 * w;  // dark noise only
    const drop = t < tp ? 1 : 0.84 + 0.16 * Math.exp(-(t - tp) / 0.05);                 // going away past the peak: a little lower
    const fc = (150 + 520 * v * (0.7 + 0.5 * p)) * pitch * drop;
    const body = f1(brown * 2.2, fc, 0.8, sr), air = f2(pink * 2, fc * 2.1, 1.1, sr);
    wPh += TAU * wob / sr;
    lp += kLp * ((body * (0.6 + deep) + air * (0.55 + 0.35 * p - 0.3 * deep)) * Math.pow(v, 1.5) * (1 + wobD * v * Math.sin(wPh)) - lp);
    d[i] = lp;
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

// The result card's jingles (NOTES 262) as scores scene.js plays through its tone() / noise() into the jingle bus, which also feeds the hall
// below: ['t', type, f0, f1, glide s, gain, decay s, at s] and ['n', f0, f1, f2, Q, gain, dur s, attack s, at s]. Pure data, so test/jingle-ab.mjs
// renders exactly what the game plays. The title slams in at ~110 ms (ui.css ov-victory): every kind lands something on it.
//   win / watch / champ  a noise riser into the slam; on it a deep boom, a snap and a long crash; the G-C-E pickup as bells, a top G with a
//                        shimmer, then a wide C major (sub to C6) and a sparkle run up over it; champ adds a second sparkle and crash
//   lose                 a soft, heavy thud on DEFEAT, the A-G sigh doubled an octave down, onto a warm C major that rings out (never minor)
//   forfeit              the pickup and the top G, a little sparkle (nobody was beaten)
// Voices stay <= .12 (the chord's) so the DynamicsCompressor on master does not pump.
export function jingleScore(kind) {
  const S = [], t = (type, f0, f1, gl, g, dec, at) => S.push(['t', type, f0, f1, gl, g, dec, at]), nz = (f0, f1, f2, q, g, dur, att, at) => S.push(['n', f0, f1, f2, q, g, dur, att, at]);
  const bell = (f, at, dur, g, type = 'triangle') => { t(type, f * 0.97, f, 0.025, g, dur, at); t('sine', 2 * f, 2 * f, 0.01, g * 0.22, dur * 0.6, at); t('triangle', 2 * f, 2 * f, 0.01, g * 0.08, 0.03, at); };
  const pickup = g => { bell(392, 0.14, 0.2, g); bell(523.25, 0.23, 0.2, g); bell(659.25, 0.32, 0.22, g); };
  if (kind === 'forfeit') { pickup(0.12); bell(783.99, 0.44, 0.5, 0.12); [1567.98, 2093].forEach((f, i) => t('sine', f, f, 0.01, 0.03, 0.5, 0.5 + i * 0.05)); return S; }
  if (kind === 'lose') {
    t('sine', 110, 38, 0.3, 0.32, 0.6, 0.11); t('triangle', 82, 70, 0.1, 0.12, 0.5, 0.11); nz(900, 520, 300, 0.7, 0.09, 0.32, 0.003, 0.11);      // the thud under DEFEAT
    bell(440, 0.44, 0.5, 0.12); bell(220, 0.44, 0.5, 0.05); bell(392, 0.62, 0.6, 0.12); bell(196, 0.62, 0.6, 0.05);                        // the sigh, A -> G
    t('sine', 130.81, 130.81, 0.01, 0.11, 2.0, 0.86); for (const f of [329.63, 392, 523.25]) bell(f, 0.86, 1.8, 0.085);                    // onto a warm C major
    t('sine', 659.25, 659.25, 0.01, 0.03, 1.4, 0.95); return S;
  }
  nz(900, 2600, 6500, 1.1, 0.07, 0.13, 0.1, 0);                                                                                           // the riser into the slam
  t('sine', 150, 42, 0.22, 0.42, 0.55, 0.11); t('sine', 120, 50, 0.12, 0.3, 0.3, 0.11);                                                   // the boom on it
  nz(2400, 1600, 1000, 0.9, 0.14, 0.14, 0.002, 0.11); nz(7000, 5200, 3800, 0.6, 0.12, 1.1, 0.002, 0.11);                                // the snap, the crash
  pickup(0.15); bell(783.99, 0.44, 0.7, 0.18); t('square', 783.99, 783.99, 0.01, 0.05, 0.5, 0.44);
  t('sine', 130.81, 130.81, 0.01, 0.12, 1.9, 0.62); for (const f of [261.63, 329.63, 392, 523.25, 659.25, 783.99]) bell(f, 0.62, 1.7, f < 300 ? 0.09 : 0.075);
  bell(1046.5, 0.62, 1.2, 0.05);
  [1318.5, 1567.98, 2093, 2637, 3136].forEach((f, i) => t('sine', f, f, 0.01, 0.035, 0.7, 0.66 + i * 0.05));                             // the sparkle run
  t('sine', 2093, 2093, 0.01, 0.02, 1.6, 0.7); t('sine', 2096.5, 2096.5, 0.01, 0.02, 1.6, 0.7);                                           // a slow shimmer (two beating sines)
  if (kind === 'champ') { [[1318.5, 0.95], [1568, 1.02], [2093, 1.09], [2637, 1.16]].forEach(([f, at]) => t('sine', f, f, 0.01, 0.07, 0.6, at)); nz(7000, 5200, 3800, 0.6, 0.10, 0.9, 0.002, 0.95); }
  return S;
}
// The hall the jingles ring in (the start sound's, web/menuaudio.js hallTail, NOTES 185): 2.6 s of stereo noise falling as (1 - t)^2.2, here
// with a 15 ms pre-delay so the slam stays crisp, and darkening as it fades (a one-pole low-pass closing from ~9 kHz to ~2 kHz). -> [left, right]
export function hall(sr, { seed = 1 } = {}) {
  const n = Math.round(sr * 2.6), pre = Math.round(sr * 0.015), ch = [];
  for (let c = 0; c < 2; c++) { const r = rng(seed * 911 + c * 313), d = new Float32Array(n); let lp = 0;
    let k = 0, g = 0;
    for (let i = pre; i < n; i++) { const u = (i - pre) / (n - pre);
      if (((i - pre) & 63) === 0) { k = 1 - Math.exp(-TAU * 9000 * Math.pow(2000 / 9000, u) / sr); g = Math.pow(1 - u, 2.2); }      // per 64 samples: ~4k pow/exp, not 250k
      lp += k * ((r() * 2 - 1) - lp); d[i] = lp * g; }
    ch.push(norm(d, 0.5)); }
  return ch;
}

// What scene.js builds, one job per idle slot: [bank key, () => Float32Array]. Variants are picked at random per play, so no two hits are
// the same buffer twice running, and a played buffer is also nudged in rate (+-3 %).
export function bankJobs(sr) {
  const j = [];
  for (const p of [0.3, 0.65, 1]) for (const s of [1, 2, 3, 4, 5]) j.push(['whoosh' + p, () => whoosh(sr, { p, seed: s })]);
  for (const n of [0, 0.25, 0.5, 0.75, 1]) for (const s of [1, 2]) j.push(['pock' + n, () => pock(sr, { n, seed: s })]);
  for (const h of [0.35, 0.9]) for (const s of [1, 2, 3]) j.push(['bounce' + h, () => bounce(sr, { h, seed: s })]);
  return j;
}
