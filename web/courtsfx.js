// The court's sounds, synthesised once into buffers (NOTES 259). Pure functions: (sample rate, options) -> Float32Array, mono, peak 1, no
// Web Audio and no DOM, so test/sfx-ab.mjs renders exactly these in Node to WAV files to listen to. scene.js imports this at the first
// gesture and fills its bank a job per idle slot (bankJobs); a voice played before its buffers exist falls back to the old oscillators.
//   whoosh  a paddle cutting the air: broadband noise through two resonances that ride the paddle's speed (a fast rise to the swing's peak,
//           a slower fall), loudness ~ speed^1.6, a flutter from the edge's vortex shedding, the pitch dropping a little past the peak
//   pock    the pickleball pop: a contact click whose brightness is the contact time (a hard hit is a shorter, brighter impulse), the hollow
//           ball's shell modes (~1.25 kHz and up) and the paddle face's lower, quicker modes; a heavy hit adds a felt low thump
//   bounce  the same ball on a hard court: a duller, shorter 'tok' (lower shell modes, the ground's thud), no paddle
//   squeak  a shoe sole's stick-slip: a buzzy pitched chirp (1.7-2.6 kHz, harmonics), a fast wobble and a rough grip, plus a little scuff
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

const MODES_BALL = [[1250, 1, 0.034], [1890, 0.55, 0.022], [2710, 0.42, 0.015], [3650, 0.26, 0.010], [5200, 0.16, 0.006]];
const MODES_FACE = [[420, 0.22, 0.016], [690, 0.3, 0.013], [1030, 0.32, 0.020]];
export function pock(sr, { n = 0.5, seed = 1 } = {}) {
  const r = rng(seed * 104729 + 7), T = 0.13, len = Math.round(sr * T), d = new Float32Array(len), det = 1 + (r() - 0.5) * 0.05;
  const tc = (1.5 - 0.75 * n) / 1000, nc = Math.max(2, Math.round(tc * sr));          // contact time: a dink sits on the face, a smash leaves at once
  const bright = 0.6 + 1.0 * n, damp = 1 - 0.08 * n + (n < 0.2 ? -0.25 : 0);          // a soft touch is muted (the ball held on the face), a hard one bright
  const add = (modes, amp) => { for (const [f0, a0, tau0] of modes) { const f = f0 * det * (1 + (r() - 0.5) * 0.02), hi = f > 2000 ? bright : 1, a = a0 * amp * hi, tau = tau0 * damp, ph = r() * TAU;
    for (let i = 0; i < len; i++) { const t = i / sr, att = Math.min(1, i / nc); d[i] += a * att * Math.exp(-t / tau) * Math.sin(TAU * f * t + ph); } } };
  add(MODES_BALL, 1); add(MODES_FACE, 0.45 + 0.35 * (1 - n));
  const hp = svf(); for (let i = 0; i < nc * 3; i++) { const e = Math.sin(Math.PI * Math.min(1, i / (nc * 2))); d[i] += hp(r() * 2 - 1, 3800 + 2600 * n, 0.8, sr) * e * (1.2 + 1.4 * n); }      // the crack of contact
  if (n > 0.45) { const a = 0.17 * (n - 0.45) / 0.55; for (let i = 0; i < len; i++) { const t = i / sr; d[i] += a * Math.exp(-t / 0.028) * Math.sin(TAU * 135 * t) * Math.min(1, i / nc); } }      // a drive or a smash: felt as much as heard
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
  const r = rng(seed * 2654435761 + 5), T = 0.08 + 0.07 * r(), len = Math.round(sr * T), d = new Float32Array(len);
  const f0 = 1700 + 900 * r(), rise = 0.08 + 0.1 * r(), wob = 38 + 20 * r(), bp = svf(), sc = svf();
  let ph = 0, grip = 1, wph = r() * TAU;
  for (let i = 0; i < len; i++) {
    const t = i / sr, u = t / T;
    wph += TAU * wob / sr; grip = 0.92 * grip + 0.08 * (0.55 + 0.9 * r());                // stick-slip: the sole grabs and lets go unevenly
    const f = f0 * (1 + rise * Math.sin(Math.PI * Math.min(1, u * 1.3)) - 0.06 * u) * (1 + 0.035 * Math.sin(wph));
    ph += TAU * f / sr; let s = 0; for (let k = 1; k <= 6; k++) s += Math.sin(k * ph) / Math.pow(k, 1.15);      // a buzzy, rubbery tone
    const env = Math.min(1, t / 0.006) * Math.min(1, (T - t) / 0.03);
    d[i] = (bp(s, f * 1.15, 2.2, sr) * 0.6 + s * 0.25) * grip * env + sc(r() * 2 - 1, 4200, 1.2, sr) * 0.18 * env;
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
