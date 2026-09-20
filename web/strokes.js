// Stroke classifier: what kind of pickleball shot was that swing? Pure ES module, no DOM, no three.js, runs in node.
// Everything is in the PLAYER FRAME of CONTRACT.md: R = player's right, U = up, F = toward the net. Pitching the
// paddle up is a positive rotation about R; sweeping right-to-left (a righty forehand) is positive about U;
// supinating a right forearm (thumb up -> thumb right) is positive about F. See docs/strokes.md for the reasoning.
const DEG = Math.PI / 180;

export const TYPES = ['dink', 'drop', 'lob', 'drive', 'backhand', 'volley', 'smash'];
export const LABELS = { dink: 'Dink', drop: 'Drop', lob: 'Lob', drive: 'Drive', backhand: 'Backhand', volley: 'Volley', smash: 'Smash', serve: 'Serve' };

export const TUNING = {
  UP: [0.30, 0.55],        // share of the rotation that must be about +R (less a quarter of the sideways share) to count as a scoop
  DOWN: [0.30, 0.55],      // ...and about -R to count as high-to-low
  HARD: [16, 22],          // power: below = a carved drop, above = a smash (or a chopped drive from a low paddle)
  HARD_RAW: [24, 30],      // raw peak rad/s that makes a downswing from a high paddle a smash whatever its power credit
  BIG: [12.5, 17.5],       // power: an upward scoop below this is a dink, above it a lob
  SHORT: [7, 10],          // power: motion.js scores a stroke with no range of motion as TAP (6) - that is a punch or a flick
  SHORT_ROM: [22, 34],     // deg swept to the peak; only used when no power is given
  HIGH: [22, 40],          // start pitch, deg: a smash starts with the paddle cocked well above the hand
  PADDLE_UP: [-8, 8],      // start pitch, deg: at or above level = volley territory, below = dink territory
  SIDE: [-0.2, 0.2],       // hand-signed share about U: + forehand, - backhand
  WIND_P0: [0, 15], WIND_P1: [25, 40], WIND_PACE: [13, 18],   // a soft upward turn that starts above level, or is already far above it, is the cock-back for an overhead, not a shot
  ACC: [0.8, 1.8],         // peak user acceleration, g: a punch volley shoves the hand forward
  ROM_IDLE: 4, REARM: 3, TAP: 6, ROM_MIN: 24, ROM_FULL: 32,   // mirrors motion.js, for featuresFromSamples
};

// ---------- tiny kit (kept local so this file never depends on motion.js) ----------
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const sstep = (x, [lo, hi]) => { const u = clamp((x - lo) / (hi - lo), 0, 1); return u * u * (3 - 2 * u); };
const fin = (v, d) => (Number.isFinite(v) ? v : d);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = v => Math.hypot(v[0], v[1], v[2]);
const qmul = (a, b) => [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
                        a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
const qconj = q => [-q[0], -q[1], -q[2], q[3]];
function qrot(q, v) { const u = [q[0], q[1], q[2]], c = cross(u, v), t = [2 * c[0], 2 * c[1], 2 * c[2]], d = cross(u, t); return [v[0] + t[0] * q[3] + d[0], v[1] + t[1] * q[3] + d[1], v[2] + t[2] * q[3] + d[2]]; }
const handSign = h => (h === 'left' || h === -1 || h === 'L' ? -1 : 1);

// features: { power, rawPeak, romDeg, durationMs, axis:[aboutR, aboutU, aboutF] (any length), pitchStart, pitchPeak (deg above
//   horizontal), rollDeg, accPeak (g), final (false = taken early in the swing, before its peak), handedness }
// opts:     { hand:'right'|'left', depth: metres from the net (a soft lift from deep is a Drop, not a Dink), windup:false to never ignore, tuning:{} }
// returns   { type, label, confidence, side:'forehand'|'backhand'|null, ignore, scores }
//   type is null (and ignore true) for the cock-back before an overhead: do not send that one to the server.
export function classifyStroke(f = {}, opts = {}) {
  const T = { ...TUNING, ...(opts.tuning || {}) }, h = handSign(opts.hand ?? f.handedness);
  const a = Array.isArray(f.axis) ? f.axis : [0, 1, 0], n = len(a) || 1;
  const up = a[0] / n, side = h * a[1] / n;
  const pace = fin(f.power, fin(f.rawPeak, 14)), p0 = fin(f.pitchStart, 0), p1 = fin(f.pitchPeak, p0);
  const upS = sstep(up - Math.abs(side) / 4, T.UP), down = sstep(-up - Math.abs(side) / 4, T.DOWN), lvl = 1 - Math.max(upS, down);
  const high0 = sstep(p0, T.HIGH), padUp = sstep(p0, T.PADDLE_UP);
  // from a cocked-high paddle the raw rate counts too: a snapped overhead is a smash even when it earns little arm credit
  const hard = Math.max(sstep(pace, T.HARD), high0 * sstep(fin(f.rawPeak, 0), T.HARD_RAW)), big = sstep(pace, T.BIG);
  const short = Number.isFinite(f.power) ? 1 - sstep(pace, T.SHORT) : Number.isFinite(f.romDeg) ? 1 - sstep(f.romDeg, T.SHORT_ROM) : 0;
  const fh = sstep(side, T.SIDE);
  const wind = opts.windup === false ? 0 : upS * Math.max(sstep(p0, T.WIND_P0), sstep(p1, T.WIND_P1)) * (1 - sstep(pace, T.WIND_PACE));
  const punch = Number.isFinite(f.accPeak) ? 0.8 + 0.2 * sstep(f.accPeak, T.ACC) : 0.9;
  const long = lvl * (1 - short) + down * hard * (1 - high0);           // a full level swing, or a hard chop from a low paddle
  const scores = {
    smash: down * hard * high0,
    drop: down * (1 - hard),
    volley: lvl * short * padUp * punch,
    dink: (1 - big) * (1 - wind) * Math.max(upS, lvl * short * (1 - padUp)),
    lob: upS * big * (1 - wind),
    drive: long * fh,
    backhand: long * (1 - fh),
  };
  let type = null, best = 0, second = 0;
  for (const k of TYPES) { const s = scores[k]; if (s > best) { second = best; best = s; type = k; } else if (s > second) second = s; }
  const sideName = Math.abs(side) < 0.3 ? null : side > 0 ? 'forehand' : 'backhand';      // null: an up-and-down stroke, no wing to speak of
  if (wind > Math.max(best, 0.5)) return { type: null, label: '', confidence: wind, side: sideName, ignore: true, scores: { ...scores, windup: wind } };
  if (best < 0.12) { type = legacyType(clamp((pace - 6) / 28, 0, 1), Math.max(up, 0) * 0.8); if (type === 'drive' && side < 0) type = 'backhand'; }
  if (type === 'dink' && opts.depth > 4.5) type = 'drop';                // same stroke from the back of the court: a third-shot drop
  const confidence = best > 0 ? clamp((best - second) / best, 0, 1) * Math.min(1, best / 0.5) : 0;
  return { type, label: LABELS[type], confidence, side: sideName, ignore: false, scores };
}

// For swings that carry no features (bots, old clients): the same names from the {n, lob} the server already has.
export function legacyType(n, lob) {
  const t = clamp((lob / 0.8 - 0.3) / 0.45, 0, 1), u = t * t * (3 - 2 * t);
  return u > 0.5 ? (n < 0.45 ? 'dink' : 'lob') : n > 0.9 ? 'smash' : 'drive';
}

// Type -> ball flight, in the units server/game.js solve(p, side, n, dir, lob) already takes, so the callout and the
// flight can never disagree. n: 0..1 pace, lob: 0 = level solver branch, 0.8 = high soft arc branch.
// depth/apex/secs are what solve() gives from the default hitting spot (see test/strokes.mjs); chop = backspin, skid low.
export const SHOTS = {
  //          n range        lob   chop   what the player expects
  dink:     { n: [0.10, 0.30], lob: 0.8, chop: false, feel: 'Soft lift that drops in the kitchen' },
  drop:     { n: [0.22, 0.32], lob: 0.8, chop: true,  feel: 'Carved high-to-low: a soft arc into the kitchen that stays low' },
  lob:      { n: [0.85, 1.00], lob: 0.8, chop: false, feel: 'High and deep, over the opponent' },
  drive:    { n: [0.40, 0.85], lob: 0,   chop: false, feel: 'Flat and deep; more swing = deeper and faster' },
  backhand: { n: [0.35, 0.80], lob: 0,   chop: false, feel: 'A drive off the other wing, a touch less pace' },
  volley:   { n: [0.30, 0.50], lob: 0,   chop: false, feel: 'Short punch: quick, mid-court, no arc' },
  smash:    { n: [0.95, 1.00], lob: 0,   chop: false, feel: 'Steep and fast, lands deep' },
  serve:    { n: [0.30, 0.70], lob: 0,   chop: false, feel: 'Underhand, deep' },
};
export function shotParams(type, power = 14) {
  const s = SHOTS[type] || SHOTS.drive, n0 = clamp((power - 6) / 28, 0, 1);
  return { n: clamp(n0, s.n[0], s.n[1]), lob: s.lob, chop: s.chop, steep: type === 'smash' };
}

// Reference feature extraction from a short window of raw samples {t, q, r, a} (oldest first, ~0.6 s is plenty).
// frame = { R, U, F, calib, yawFix? }  (MotionModel: m.B.R, m.B.U, m.B.F, m.calib, m.yawFix)
// opts.at: sample time the swing was reported at (early commit). Omitted = use the fastest sample in the window.
// The stroke is the run of samples BEFORE that point turning the same way and above ROM_IDLE, so a wind-up that flows
// straight into the swing (it turns the other way) is left out.
export function featuresFromSamples(samples, frame, opts = {}) {
  const T = { ...TUNING, ...(opts.tuning || {}) }, { R, U, F, calib } = frame, yf = frame.yawFix;
  const S = (opts.at == null ? samples : samples.filter(s => s.t <= opts.at + 1e-6)).filter(s => s && s.q && s.r);
  if (!S.length) return null;
  const Q = s => (yf ? qmul(yf, s.q) : s.q);
  const w = S.map(s => { const v = qrot(Q(s), s.r); return [dot(v, R), dot(v, U), dot(v, F)]; });
  const rate = S.map(s => len(s.r));
  const pitch = s => Math.asin(clamp(dot(qrot(qmul(Q(s), qconj(calib)), F), U), -1, 1)) / DEG;
  let e = S.length - 1;
  if (opts.at == null) for (let i = 0; i < S.length; i++) if (rate[i] > rate[e]) e = i;
  let b = e; while (b > 0 && rate[b - 1] > T.ROM_IDLE && dot(w[b - 1], w[e]) > 0) b--;
  let pk = e; for (let i = b; i <= e; i++) if (rate[i] > rate[pk]) pk = i;
  // movement start, interpolated to where the rate crossed ROM_IDLE (as motion.js does)
  const rb = b > 0 ? rate[b - 1] : 0, dt0 = b > 0 ? S[b].t - S[b - 1].t : 0.02;
  const u0 = b > 0 && dot(w[b - 1], w[e]) > 0 ? clamp((rate[b] - T.ROM_IDLE) / Math.max(rate[b] - rb, 1e-6), 0, 1) : 0.5;
  const t0 = S[b].t - dt0 * u0;
  const sum = [0, 0, 0]; let rom = 0.5 * (rate[b] + T.ROM_IDLE) * dt0 * u0, romPk = rom, acc = 0;
  for (let i = b; i <= e; i++) {
    for (let k = 0; k < 3; k++) sum[k] += w[i][k];
    if (i > b) rom += 0.5 * (rate[i] + rate[i - 1]) * (S[i].t - S[i - 1].t);
    if (i === pk) romPk = rom;
    if (S[i].a) acc = Math.max(acc, len(S[i].a));
  }
  const n = len(sum) || 1, rawPeak = rate[pk];
  // power here is a stand-in for motion.js's own (peak x range-of-motion credit); its time credit is left out because
  // this window starts at the turn-around, not at the start of the wind-up. Prefer the event's power when there is one.
  const credit = clamp((romPk / DEG - T.ROM_MIN) / (T.ROM_FULL - T.ROM_MIN), 0, 1);
  const d = qmul(Q(S[e]), qconj(calib)), roll = 2 * Math.atan2(dot([d[0], d[1], d[2]], F), d[3]) / DEG;   // twist about the pointer
  return {
    power: Math.max(T.TAP, rawPeak * credit), rawPeak, romDeg: rom / DEG, durationMs: (S[e].t - t0) * 1000,
    axis: [sum[0] / n, sum[1] / n, sum[2] / n], pitchStart: pitch(S[b]), pitchPeak: pitch(S[e]),
    rollDeg: ((roll + 540) % 360) - 180, accPeak: acc, final: e < S.length - 1 || (e > 0 && rate[e] < rate[e - 1]),
  };
}

// A motion.js 'swing' / 'swingFix' event (once it carries axis, pitch0, pitch, acc, dur) -> classifyStroke features.
export const featuresFromEvent = e => ({ power: e.power, rawPeak: e.raw, romDeg: e.rom, durationMs: e.dur, axis: e.axis,
  pitchStart: e.pitch0, pitchPeak: e.pitch, accPeak: e.acc, final: e.final });
