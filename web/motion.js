// Pure motion logic: AirPod IMU samples -> player frame, paddle pose, swing events. No DOM, no three.js.
// Quaternions are [x,y,z,w], Hamilton product, q maps device -> reference (Z up). See CONTRACT.md.
const DEG = Math.PI / 180;

export const DEFAULTS = {
  SETTLE_MS: 800, SETTLE_DEG: 7,             // after the tilt: rest this long within this wobble and that pose becomes neutral
  BUFFER_PAD: 0.008, BUFFER_MIN: 0.025, BUFFER_MAX: 0.12,   // jitter buffer: render this far behind the newest sample (s)
  HOLD_MS: 5000, HOLD_DEG: 10,              // step 1: still within HOLD_DEG for HOLD_MS
  TILT_DEG: 25, TILT_MIN_HORIZ: 0.75,       // step 2: tip up; axis must be mostly horizontal
  TILT_REARM_DEG: 12,                       // after a rejected twist, come back inside this before retrying
  X_SIN: 3.0 / Math.sin(75 * DEG), X_MAX: 3.5,   // lateral metres = X_SIN * sin(yaw): follows the sideways travel of a hand on an arm; sideline at ~75 deg (setSidelineDeg changes it live)
  Y_MID: 1.0, Y_PER_RAD: 0.9 / (45 * DEG), Y_MIN: 0.3, Y_MAX: 2.3,
  BASE_TAU: 0.03,                           // base smoothing, s
  GATE_LO: 9.0,                             // base follows fully below this rate, not at all at FREEZE_RATE
  FREEZE_RATE: 12.0, RELEASE_RATE: 3.0, RELEASE_HOLD: 0.06,
  ROLLBACK: 0.13,                           // on lock, base + arm reference go back this far
  RELEASE_DEG: 20, RELEASE_TIMEOUT: 0.15,    // a swing's lock lets go when the pointer is back near the locked aim, or this long after the hand settled
  BASE_SPEED: 8.0,                         // m/s, hard limit on rendered base x and y: never a jump
  WINDUP_MAX: 0, WINDUP_SPEED: 5, STILL_RATE: 1.2, STILL_MAX: 0.3,   // ...or further, to before a slow backswing
  FREEZE_BLEND: 0.08,                       // ease the arm reference into the rolled-back state, s
  RECOVER_TAU: 0.3, RECOVER_RAMP: 0.5,      // after a lock, let the base go softly
  TRIGGER: 7.5, REARM: 3, TAP: 6,               // swing detection, rad/s
  EARLY_T: 0.08, EARLY_H: 0.14,             // a movement that has not taken off hard is called this long after the hand started moving (s), as if it kept going for this long (s)
  ARM_R_LO: 0.06, ARM_R_HI: 0.16,           // m: a hand on an arm travels on a radius; a wrist turning in place does not, and gets no bet
  SNAP_LO: 130, SNAP_HI: 230,               // rad/s^2 over two samples: below LO an arm is building up, above HI a wrist is snapping (called soft at once)
  REARM_HOT: 5.5, REARM_RISE: 3.5,          // rad/s: a finished swing lets go below this without coming to rest; the next one must rise this far off the bottom
  ONSET: 75,                                // rad/s^2: a rise gentler than this has not taken off yet
  FIX_ABS: 1.5, FIX_REL: 0.08, FIX_STEP: 3, FIX_GAP: 0.06,   // once the real peak is in, a 'swingFix' follows if the call was off by more than this; on the way there, when it has moved by STEP, at most every GAP s
  ARC_TAU: 0.35, ARC_LO: 6, ARC_HI: 14, ARC_MAX: 65,     // swing arc: reference lag (s), and the rotation rates (rad/s) over which it fades in
  POWER_MAX: 34,
  ROM_IDLE: 4, ROM_MIN: 35, ROM_FULL: 110, ROM_T_MIN: 0.10, ROM_T_FULL: 0.18,   // deg swept, and s taken, from the start of the movement to its peak: below MIN a swing scores nothing, at FULL its whole peak rate
  LOB_GAIN: 0.8,
  ARM: [0.10, -0.12, -0.70],                // virtual forearm, player frame (x right, y up, z toward player)
  REF_TAU: 0.08,                            // arm reference follows the hand: 2 cascaded stages of this
  PUNCH_TAU: 0.2, PUNCH_GAIN: 0.03, PUNCH_CAP: 0.3, BIAS_TAU: 1.5,
  ACC_SIGN: -1,                             // CoreMotion userAcceleration = -(true accel); self-corrects, see ACC_LEARN
  ACC_LEARN: 15,                            // m/s of centripetal evidence needed to flip ACC_SIGN (0 = never)
  RENDER_DELAY: 0.010,                      // pose() shows the hand this long ago: halves how far we must extrapolate
  JITTER_GAIN: 1.5, JITTER_MAX: 0.03,       // ...plus this x the mean arrival lateness, for bursty links
  EXTRAP_MAX: 0.045, EXTRAP_ANGLE: 0.6,     // extrapolation limits, s and rad
  ACC_EXTRAP: 1.0,                          // how much of a speeding-up angular accel to trust
  BLEND_MIN: 0.012,                         // a new sample takes over from the old prediction over at least this, s
};

// ---------- tiny quaternion / vector kit ----------
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = v => Math.hypot(v[0], v[1], v[2]);
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const lerp = (a, b, u) => a + (b - a) * u;
const smooth = u => u * u * (3 - 2 * u);
const IDENT = [0, 0, 0, 1];

export function qmul(a, b) {
  return [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
          a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
          a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
          a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
}
export const qconj = q => [-q[0], -q[1], -q[2], q[3]];
export function qnorm(q) { const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1; return [q[0] / n, q[1] / n, q[2] / n, q[3] / n]; }
export function qrot(q, v) {                       // v' = q v q*
  const u = [q[0], q[1], q[2]], t = mul(cross(u, v), 2);
  return add(add(v, mul(t, q[3])), cross(u, t));
}
export function qexp(rv) {                         // rotation vector (axis * angle) -> quaternion
  const a = len(rv); if (a < 1e-12) return [rv[0] / 2, rv[1] / 2, rv[2] / 2, 1];
  const s = Math.sin(a / 2) / a; return [rv[0] * s, rv[1] * s, rv[2] * s, Math.cos(a / 2)];
}
export const qaxis = (axis, angle) => qexp(mul(axis, angle / (len(axis) || 1)));
export const qangle = q => 2 * Math.atan2(Math.hypot(q[0], q[1], q[2]), Math.abs(q[3]));
export function qslerp(a, b, u) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const s = d < 0 ? -1 : 1; d = Math.abs(d);
  let ka = 1 - u, kb = u;
  if (d < 0.9995) { const th = Math.acos(d), sn = Math.sin(th); ka = Math.sin((1 - u) * th) / sn; kb = Math.sin(u * th) / sn; }
  kb *= s;
  return qnorm([a[0] * ka + b[0] * kb, a[1] * ka + b[1] * kb, a[2] * ka + b[2] * kb, a[3] * ka + b[3] * kb]);
}

// The pure kinematic arm: where the end of the forearm goes for a player-frame rotation P, relative to rest.
export const xOf = (yaw, c = DEFAULTS) => c.X_SIN * Math.sin(clamp(yaw, -Math.PI / 2, Math.PI / 2));
export function armOffset(P, arm = DEFAULTS.ARM) { return sub(qrot(P, arm), arm); }

export class MotionModel {
  constructor(opts = {}) {
    this.c = { ...DEFAULTS, ...opts };
    this.accSign = this.c.ACC_SIGN;
    this.off = null;                         // local clock (s) - sample clock (s), min-tracked
    this.jit = 0;                            // mean arrival lateness, s
    this.last = null;                        // last sample + derived state
    this.snap = []; this.jmax = 0; this.D = 0.04;   // jitter buffer: per-sample snapshots, worst recent lateness, render delay
    this.startCalibration();
  }

  setSidelineDeg(deg) { this.c.X_SIN = 3.0 / Math.sin(clamp(deg, 25, 90) * DEG); }

  startCalibration() {
    this.calibrated = false;
    this.cal = { stage: 'hold', anchor: null, sum: null, t0: 0, blocked: false };
    this.sw = null;
  }

  // Re-zero heading only (yaw drifts over minutes). Grip and pitch are kept.
  recenter() {
    if (!this.calibrated || !this.last) return;
    const { U, F } = this.B;
    const p = qrot(qmul(this.last.q, qconj(this.calib)), F);
    const psi = Math.atan2(dot(p, cross(U, F)), dot(p, F));          // CCW heading of the pointer
    this.yawFix = qaxis(U, -psi);
    const P = this._P(this.last.q);
    const y = this._xyAt(this.last.t).y;
    this._reset(this.last.t, P, 0, y);
    this.last.P = P; this.prev = null;
  }

  feed(sample, nowMs) {
    const ev = [];
    if (!sample || !Array.isArray(sample.q) || !(sample.t >= 0) || sample.q.some(v => !Number.isFinite(v))) return ev;
    const s = { t: sample.t, q: qnorm(sample.q), r: sample.r || [0, 0, 0], a: sample.a || [0, 0, 0] };

    // sample clock -> local clock. Arrival jitters, the sample clock does not: track the smallest offset.
    const o = (nowMs == null ? s.t * 1000 : nowMs) / 1000 - s.t;
    if (this.off == null || o < this.off || o - this.off > 0.5) this.off = o;
    else this.off += Math.min(o - this.off, 2e-5);
    this.jit += (Math.min(o - this.off, 0.1) - this.jit) * 0.05;
    this.jmax = Math.max(o - this.off, this.jmax - 1e-4);              // worst recent arrival lateness (decays 5 ms/s)
    s.arr = s.t + (o - this.off);                                     // arrival, on the sample clock

    if (!this.calibrated) { this._calibrate(s, ev); return ev; }
    let dt = s.t - this.last.t;
    if (dt <= 0) return ev;                                           // duplicate / out of order
    if (dt > 0.25) { this._start(s); return ev; }                     // stream gap: start clean
    this._track(s, dt, ev);
    return ev;
  }

  // ---------- calibration ----------
  _calibrate(s, ev) {
    const c = this.c, cal = this.cal;
    if (cal.stage === 'settle') return this._settle(s, ev);
    if (cal.stage === 'hold') {
      let ok = true;
      if (!cal.anchor || qangle(qmul(s.q, qconj(cal.anchor))) > c.HOLD_DEG * DEG) {
        ok = !cal.anchor; cal.anchor = s.q; cal.sum = [0, 0, 0, 0]; cal.t0 = s.t;
      }
      const sg = dot4(s.q, cal.anchor) < 0 ? -1 : 1;
      for (let i = 0; i < 4; i++) cal.sum[i] += sg * s.q[i];
      const progress = clamp((s.t - cal.t0) * 1000 / c.HOLD_MS, 0, 1);
      if (progress >= 1) { this.calib = qnorm(cal.sum); this.holdQ = this.calib; cal.stage = 'tilt'; }
      ev.push({ type: 'cal', stage: 'hold', progress, ok, msg: ok ? 'Hold it like a paddle, pointed at the screen. Keep still…' : 'You moved — hold still and we’ll start again.' });
      return;
    }
    let d = qmul(s.q, qconj(this.calib)); if (d[3] < 0) d = d.map(v => -v);
    const ang = qangle(d), progress = clamp(ang / (c.TILT_DEG * DEG), 0, 1);
    if (cal.blocked) {
      if (ang < c.TILT_REARM_DEG * DEG) cal.blocked = false;
      ev.push({ type: 'cal', stage: 'tilt', progress: 0, ok: false, msg: 'That was a twist — level out, then tip it straight up.' });
      return;
    }
    if (ang < c.TILT_DEG * DEG) { ev.push({ type: 'cal', stage: 'tilt', progress, ok: true, msg: 'Now tip the front of the AirPod up.' }); return; }
    const ax = mul([d[0], d[1], d[2]], 1 / len([d[0], d[1], d[2]])), h = Math.hypot(ax[0], ax[1]);
    if (h < c.TILT_MIN_HORIZ) {
      cal.blocked = true;
      ev.push({ type: 'cal', stage: 'tilt', progress: 0, ok: false, msg: 'That was a twist — level out, then tip it straight up.' });
      return;
    }
    const R = [ax[0] / h, ax[1] / h, 0], U = [0, 0, 1];
    this.B = { R, U, F: cross(U, R) };
    // The tilt only teaches the axes. Neutral is wherever the hand comes to rest AFTER it: people keep the bud tipped
    // up because that is how a paddle is held, and the on-screen paddle must stand upright in exactly that pose.
    cal.stage = 'settle'; cal.anchor = null;
    ev.push({ type: 'cal', stage: 'tilt', progress: 0, ok: true, msg: 'Good — now hold it how you’ll play.' });
  }

  _settle(s, ev) {
    const c = this.c, cal = this.cal;
    if (!cal.anchor || qangle(qmul(s.q, qconj(cal.anchor))) > c.SETTLE_DEG * DEG) { cal.anchor = s.q; cal.sum = [0, 0, 0, 0]; cal.t0 = s.t; }
    const sg = dot4(s.q, cal.anchor) < 0 ? -1 : 1;
    for (let i = 0; i < 4; i++) cal.sum[i] += sg * s.q[i];
    const progress = clamp((s.t - cal.t0) * 1000 / c.SETTLE_MS, 0, 1);
    if (progress < 1) { ev.push({ type: 'cal', stage: 'tilt', progress, ok: true, msg: 'Good — now hold it how you’ll play.' }); return; }
    this.calib = qnorm(cal.sum);                               // axes R,U,F are world vectors, so they stay valid
    // What the screen shows is the bud's REAL attitude, not "neutral = upright": in step 1 it lay flat, pointed at the
    // screen, so there the paddle points flat at the net; tipped up 60 deg it stands 60 deg up; straight up is upright.
    // K carries the hold pose into the resting pose and lays the upright model forward. Everything else (aim, tilt-walk,
    // swing arc) keeps measuring from the resting pose.
    { const d = qmul(this.calib, qconj(this.holdQ || this.calib)), v = this._vecP(d), h = Math.SQRT1_2;
      this.K = qmul([v[0], v[1], v[2], d[3]], [-h, 0, 0, h]); }
    this.yawFix = IDENT;
    this.calibrated = true;
    this._start(s);
    ev.push({ type: 'cal', stage: 'tilt', progress: 1, ok: true, msg: 'All set!' });
    ev.push({ type: 'calibrated' });
  }

  // ---------- frames ----------
  _vecP(v) { const B = this.B; return [dot(v, B.R), dot(v, B.U), -dot(v, B.F)]; }     // world vector -> player/three.js axes
  _d(q) { return qmul(qmul(this.yawFix, q), qconj(this.calib)); }                    // world-frame delta since the hold
  _P(q) { const d = this._d(q), v = this._vecP(d); return [v[0], v[1], v[2], d[3]]; }  // same angle, axis re-expressed
  _target(q) {
    const c = this.c, B = this.B, p = qrot(this._d(q), B.F);
    const yaw = Math.atan2(dot(p, B.R), dot(p, B.F)), pitch = Math.asin(clamp(dot(p, B.U), -1, 1));
    return { p, yaw, pitch, ux: xOf(yaw, c), uy: c.Y_MID + pitch * c.Y_PER_RAD, x: clamp(xOf(yaw, c), -c.X_MAX, c.X_MAX), y: clamp(c.Y_MID + pitch * c.Y_PER_RAD, c.Y_MIN, c.Y_MAX) };
  }

  _reset(t, P, x, y) {
    this.bx = x; this.by = y; this.ref1 = P; this.ref2 = P;
    this.xy = { from: { x, y }, to: { x, y }, t0: t, dur: 0.02 };
    this.refSeg = { from: P, to: P, t0: t, dur: 0.02, ease: false };
    this.lock = null; this.refFrozen = false; this.tRamp = -1e9;
    this.hist = []; this.snap = []; this.hpRef = null; this.armW = 0;
  }
  _start(s) {
    const P = this._P(s.q), tg = this._target(s.q);
    const was = this.xy ? this._xyAt(s.t) : null;                     // after a stream gap the base slews, it never jumps
    this._reset(s.t, P, tg.x, tg.y);
    if (was) this.xy.from = this.xy.to = was;
    this.vel = [0, 0, 0]; this.abias = [0, 0, 0]; this.corrSum = 0;
    this.punch = { from: [0, 0, 0], to: [0, 0, 0], t0: s.t, dur: 0.02 };
    this.sw = null; this.prevRate = this.prevRate2 = 0; this.lo = this.mvI = this.mvR = this.wB = this.w1 = this.w2 = null; this.rom = this.ang = this.accM = this.aS = this.wS = 0;
    this.prev = null;
    this.last = { t: s.t, q: s.q, P, rP: [0, 0, 0], aPar: 0, rate: 0 };
  }

  // ---------- per-sample tracking ----------
  _track(s, dt, ev) {
    const c = this.c, L = this.last, t = s.t;
    const rate = len(s.r);
    const P = this._P(s.q);
    const rP = this._vecP(qrot(this.calib, s.r));                     // body-frame rate of P (P' = P * exp(rP dt / 2))
    const wP = this._vecP(qrot(qmul(this.yawFix, s.q), s.r));         // world angular velocity, player axes
    const tg = this._target(s.q); this.tilt = tg.pitch;

    // Hand over from the old prediction to this sample's curve, starting from exactly what pose() shows right now.
    const aPar = rate > 1e-6 ? dot(mul(sub(rP, L.rP), 1 / dt), mul(rP, 1 / rate)) : 0;
    const tA = s.arr - this._delay();
    let fix = qmul(this._Ptau(tA), qconj(this._curve(L, tA))); if (qangle(fix) > 0.35) fix = IDENT;
    const cur = { t, q: s.q, P, rP, aPar, rate, tA, B: Math.max(t - tA, c.BLEND_MIN), fix };

    // swing detection: trigger, make a first call at once, refine it while the movement unfolds, keep the peak until re-arm
    let sw = this.sw;
    // Where a movement took off = where the rate left idle (mvI) or, when the hand was already moving (a wind-up that
    // loops into the swing), where the angular velocity had changed by ROM_IDLE since it last stopped accelerating (mvR).
    // Interpolated between samples. Out of a follow-through that never came to rest: where the rate bottomed out (lo).
    const r1 = this.prevRate, r0 = this.prevRate2 || 0, w1 = this.w1 || wP, w2 = this.w2 || w1;
    this.ang = (this.ang || 0) + 0.5 * (rate + r1) * dt;              // total angle turned, trapezoid
    const cross = (a, b) => {                                         // a movement starts ~quadratically: interpolate in sqrt()
      const u = clamp((Math.sqrt(b) - Math.sqrt(c.ROM_IDLE)) / Math.max(Math.sqrt(b) - Math.sqrt(a), 1e-6), 0, 1);
      return { t: t - dt * u, ang: this.ang - (rate - 0.5 * (rate - r1) * u) * dt * u };
    };
    const acc = (rate - r0) / (dt + (this.pdt || dt)); this.pdt = dt;   // rad/s^2 over two samples: how hard the hand is taking off
    if (rate < c.ROM_IDLE) { this.rom = 0; this.mvI = null; this.lo = null; if (!sw) this.accM = this.aS = this.wS = 0; }
    else { if (!this.mvI) this.mvI = cross(r1, rate); this.rom = (this.rom || 0) + rate * dt; }   // rom: what the events report
    this.accM = Math.max(this.accM || 0, acc);
    this.aS = (this.aS || 0) + len(s.a) * 9.81; this.wS = (this.wS || 0) + rate * rate;   // centripetal: sum|a| / sum w^2 = the radius the sensor is travelling on, m
    if (!sw) {
      if (this.lo != null && rate < this.lo) { this.lo = rate; this.mvI = { t, ang: this.ang }; this.accM = this.aS = this.wS = 0; }
      if (!this.wB || len(sub(wP, w2)) < c.ONSET * 2 * dt) { this.wB = wP; this.mvR = null; }   // over two samples: gyro noise must not pass for a take-off
      else if (!this.mvR && len(sub(wP, this.wB)) >= c.ROM_IDLE) this.mvR = cross(len(sub(w1, this.wB)), len(sub(wP, this.wB)));
    }
    this.w2 = w1; this.w1 = wP;
    if (!sw && rate > c.TRIGGER && rate >= (this.lo == null ? 0 : this.lo + c.REARM_RISE)) { const m = (this.mvR && len(this.wB) >= c.ROM_IDLE ? this.mvR : this.mvI || this.mvR) || { t, ang: this.ang };   // mvR only when the hand really was moving before
      sw = this.sw = { t0: t, tI: Math.min(m.t, this.mvI ? this.mvI.t : t), mv0: m.t, ang0: m.ang, peak: 0, tPk: t, romPk: 0, sum: add(mul(w1, r1), mul(w2, r0)), sent: false, fixed: false, eff: 0, sweep: 0, k: 1 }; }
    if (sw) {
      if (!sw.fixed) sw.sum = add(sw.sum, mul(wP, rate));             // sweep direction, weighted by rate: the slow first samples are mostly noise
      // Curl: a straight swing keeps turning about one axis; a "C" shaped swing (or a rolling wrist) swings that axis
      // round as it goes. turn = how far the axis has wandered (rad), curl = which way (+ = curling to the player's right).
      if (!sw.fixed && rate > 5) { const u = mul(wP, 1 / rate);
        if (sw.u0) { const d = clamp(dot(u, sw.u0), -1, 1); sw.turn = (sw.turn || 0) + Math.acos(d); sw.curl = (sw.curl || 0) + (sw.u0[1] - u[1]) + 0.6 * (u[2] - sw.u0[2]); }
        sw.u0 = u; }
      if (rate > sw.peak) { sw.peak = rate; sw.tPk = t; sw.romPk = this.ang - sw.ang0; }
      if (r1 >= r0 && r1 > rate && r1 > c.TRIGGER) {                  // r1 was a local max: parabolic true peak
        const den = r0 - 2 * r1 + rate, p = den < 0 ? clamp(0.5 * (r0 - rate) / den, -0.5, 0.5) : 0;
        const pk = Math.min(r1 - 0.25 * (r0 - rate) * p, r1 * 1.08);
        if (pk >= sw.peak) { sw.peak = pk; sw.tPk = t - dt + p * dt; sw.romPk = this.ang - sw.ang0 - 0.5 * (rate + r1) * dt + r1 * p * dt; }
      }
      sw.sweep = Math.max(sw.sweep, this.rom);
      const el = t - sw.mv0;
      // a slow wide swing is bumpy: a small dip is not its peak. Only a fast movement, a long one, or a real collapse is "past".
      const past = rate < c.REARM || rate < sw.peak * 0.6 || (rate < sw.peak * 0.92 && (sw.peak > 18 || el > 0.2));
      // over once the hand is quiet, or once it has clearly let go: the next movement often starts out of the follow-through
      const done = rate < c.REARM || ((sw.fixed || past) && rate < Math.min(c.REARM_HOT, sw.peak * 0.6));
      // Power is EFFORT, not snap. Measured on the real player: a snappy flick peaks at ~30 rad/s but gets there in
      // 80-100 ms; a wide arm swing only reaches 9-14 rad/s, takes 240-340 ms to get there and sweeps 100-190 deg on the
      // way. So rotation speed says almost nothing; how far and how long the hand travelled before the peak says it all.
      const credit = (rom, rise) => clamp((rom / DEG - c.ROM_MIN) / (c.ROM_FULL - c.ROM_MIN), 0, 1) * clamp((rise - c.ROM_T_MIN) / (c.ROM_T_FULL - c.ROM_T_MIN), 0, 1);
      const powerOf = (pk, rom, rise) => c.TAP + (c.POWER_MAX - c.TAP) * credit(rom, rise) * (0.8 + 0.2 * clamp(pk / 14, 0, 1));
      const shot = () => { const n = len(sw.sum) || 1; return { dir: clamp(-sw.sum[1] / n, -1, 1), lob: clamp(sw.sum[0] / n, 0, 1) * c.LOB_GAIN, chop: clamp(-sw.sum[0] / n, 0, 1),
        roll: sw.sum[2] / n, turn: sw.turn || 0, curl: sw.curl || 0 }; };   // chop: downward share (an overhead)
      const age = Math.round((s.arr - sw.mv0) * 1000);   // ms since the hand started moving, incl. how late this sample arrived
      // The real score needs the peak, and waiting for it is 150-300 ms of dead air. But the two movements part ways in
      // the first 40-60 ms: a flick takes off at 250-500 rad/s^2, an arm swing at 25-125. So a hard take-off is called
      // at once, as the tap it has earned so far; anything else is called EARLY_T in, on the bet that a hand building up
      // gently keeps going at this rate for another EARLY_H. The bet is off as soon as it stops speeding up. Until the
      // peak is in, the call is the larger of the bet and what the movement has earned; 'swingFix' follows whenever the
      // call has moved, and once more with the real score.
      const up = rate > r1 && !past, snap = clamp((this.accM - c.SNAP_LO) / (c.SNAP_HI - c.SNAP_LO), 0, 1);
      if (rate < sw.peak * 0.92 || (!sw.sent && (!up || (r1 > r0 && rate - r1 < 0.5 * (r1 - r0))))) sw.k = 0;   // ...or, at the call, if the rise is already flattening out: the top of a quick reposition
      const call = () => { if (past) return powerOf(sw.peak, sw.romPk, sw.tPk - sw.mv0);
        const arm = this.aS ? clamp((this.aS / Math.max(this.wS, 1) - c.ARM_R_LO) / (c.ARM_R_HI - c.ARM_R_LO), 0, 1) : 1;   // no accelerometer in the stream: no veto
        const H = c.EARLY_H * (1 - snap) * arm * sw.k, lead = up ? dt : 0;
        return Math.max(powerOf(sw.peak, sw.romPk + rate * lead, sw.tPk - sw.mv0 + lead), H ? powerOf(sw.peak, this.ang - sw.ang0 + rate * H, el + H) : 0); };
      if (!sw.sent && (past || this.accM >= c.SNAP_HI || t - sw.tI >= c.EARLY_T - 1e-4)) {
        sw.sent = true; sw.fixed = past; sw.tFix = t;
        // every swing counts; how much ARM went into it decides the power. A quick wrist flick is a soft tap (a dink),
        // never a smash, however fast it was.
        sw.eff = call(); Object.assign(sw, shot());
        ev.push({ type: 'swing', power: sw.eff, raw: sw.peak, rom: sw.sweep / DEG, dir: sw.dir, lob: sw.lob, chop: sw.chop || 0, roll: sw.roll || 0, turn: sw.turn || 0, curl: sw.curl || 0, age, final: past });
      } else if (sw.sent && !sw.fixed) {                              // the call moved, or the real peak is in and the call was off
        const eff = call(), sh = shot();
        if ((past || t - sw.tFix >= c.FIX_GAP - 1e-4) && (Math.abs(eff - sw.eff) > (past ? Math.max(c.FIX_ABS, c.FIX_REL * sw.eff) : c.FIX_STEP) || Math.abs(sh.lob - sw.lob) > 0.15 || Math.abs(sh.dir - sw.dir) > 0.3)) {
          ev.push({ type: 'swingFix', power: eff, raw: sw.peak, rom: sw.sweep / DEG, ...sh, age, final: past }); sw.eff = eff; sw.tFix = t; Object.assign(sw, sh); }
        if (past) { sw.fixed = true; sw.eff = eff; }
      }
      if (done) { ev.push({ type: 'swingEnd', peak: sw.eff, raw: sw.peak, rom: sw.sweep / DEG, counted: true }); this.sw = null;
        if (rate >= c.ROM_IDLE) { this.lo = rate; this.mvI = { t, ang: this.ang }; } this.mvR = null; this.wB = wP; this.accM = this.aS = this.wS = 0; }   // the next take-off is measured from here
    }
    this.prevRate2 = this.prevRate;
    this.prevRate = rate;

    // Base lock. Yaw both aims the base and is what a swing rotates, so from the wind-up on the base is pinned to the
    // aim of ~130 ms earlier, THROUGH the follow-through. It lets go once the hand is quiet and either no swing fired
    // (a fast reposition), the pointer is back near the locked aim, or the hand has been settled for RELEASE_TIMEOUT.
    let lk = this.lock;
    if (!lk) {
      if (rate >= c.FREEZE_RATE) {
        const h = this._rollback(t, tg) || { bx: this.bx, by: this.by, p: tg.p, P: this.ref2 };
        lk = this.lock = { x: h.bx, y: h.by, p: h.p, low: 0, settle: null, swung: !!this.sw };
        this._freezeRef(t, h.P);
      }
    } else {
      if (this.sw) lk.swung = true;
      lk.low = rate < c.RELEASE_RATE ? lk.low + dt : 0;
      if (rate >= c.FREEZE_RATE) lk.settle = null;
      else if (lk.settle == null && lk.low >= c.RELEASE_HOLD) lk.settle = t;
      if (this.refFrozen) {
        if (lk.low >= c.RELEASE_HOLD && !this.sw) { this.refFrozen = false; this.ref1 = this.ref2 = this.refSeg.to; }
      } else if (this.sw && this.sw.t0 === t) this._freezeRef(t, this.ref2);      // a second swing out of the follow-through
      if (lk.settle != null && !this.sw && (!lk.swung || t - lk.settle >= c.RELEASE_TIMEOUT
          || Math.acos(clamp(dot(tg.p, lk.p), -1, 1)) < c.RELEASE_DEG * DEG)) { lk = this.lock = null; this.tRamp = t; }
    }
    if (lk) { this.bx = lk.x; this.by = lk.y; }
    else {
      const tau = c.BASE_TAU + c.RECOVER_TAU * clamp(1 - (t - this.tRamp) / c.RECOVER_RAMP, 0, 1);
      const k = (1 - Math.exp(-dt / tau)) * clamp((c.FREEZE_RATE - rate) / (c.FREEZE_RATE - c.GATE_LO), 0, 1);
      this.bx += (tg.x - this.bx) * k; this.by += (tg.y - this.by) * k;
    }
    { // rendered base: straight from what pose() shows now toward bx,by, never faster than BASE_SPEED
      const from = this._xyAt(t), dur = clamp(dt, 0.01, 0.04), m = c.BASE_SPEED * dur;
      this.xy = { from, to: { x: from.x + clamp(this.bx - from.x, -m, m), y: from.y + clamp(this.by - from.y, -m, m) }, t0: t, dur };
    }
    // Arm reference: what the arc offset is measured from. Held through the swing, then it relaxes onto the hand.
    // While the base is locked the offset angle may only shrink, so returning to ready doesn't draw a second arc.
    if (!this.refFrozen) {
      const a0 = lk ? qangle(qmul(L.P, qconj(this.ref2))) : 0;
      const k = 1 - Math.exp(-dt / c.REF_TAU);
      this.ref1 = qslerp(this.ref1, P, k); this.ref2 = qslerp(this.ref2, this.ref1, k);
      if (lk) {
        const a1 = qangle(qmul(P, qconj(this.ref2)));
        if (a1 > a0 && a1 > 1e-6) { const u = 1 - a0 / a1; this.ref2 = qslerp(this.ref2, P, u); this.ref1 = qslerp(this.ref1, P, u); }
      }
      this.refSeg = { from: this._refAt(t), to: this.ref2, t0: t, dur: clamp(dt, 0.01, 0.04), ease: false };
    }

    // punch: leaky-integrated user acceleration (a velocity), scaled to a short lead. Bias learned while quiet.
    const aP = mul(this._vecP(qrot(qmul(this.yawFix, s.q), s.a)), 9.81);
    if (rate < c.STILL_RATE && len(aP) < 1.0) this.abias = add(this.abias, mul(sub(aP, this.abias), 1 - Math.exp(-dt / c.BIAS_TAU)));
    const ah = sub(aP, this.abias);
    if (rate > c.TRIGGER && c.ACC_LEARN > 0) {                        // centripetal accel must point back down the arm
      const l = qrot(P, c.ARM);
      this.corrSum = Math.min(this.corrSum + this.accSign * dot(ah, mul(l, -1 / len(l))) * dt, 2 * c.ACC_LEARN);
      if (this.corrSum < -c.ACC_LEARN) { this.accSign = -this.accSign; this.corrSum = 0; this.vel = [0, 0, 0]; }
    }
    this.vel = add(mul(this.vel, Math.exp(-dt / c.PUNCH_TAU)), mul(ah, this.accSign * dt));
    let pu = mul(this.vel, c.PUNCH_GAIN); const m = len(pu);
    if (m > 1e-9) pu = mul(pu, c.PUNCH_CAP * Math.tanh(m / c.PUNCH_CAP) / m);
    this.punch = { from: this._punchAt(t), to: pu, t0: t, dur: clamp(dt, 0.01, 0.04) };

    this.hist.push({ t, bx: this.bx, by: this.by, ux: tg.ux, uy: tg.uy, p: tg.p, P, rate, frozen: !!lk });
    while (this.hist.length && this.hist[0].t < t - 1.0) this.hist.shift();
    // Swing arc, kept deliberately simple: the arm reference is a slow low-pass of the hand (a high-pass on the motion),
    // so a fast swing or wind-up sweeps an arc and ANY held pose relaxes back to centre in ~0.5 s. No locks, nothing to
    // get stuck, nothing to jump. The arc fades in with rotation speed so slowly turning the bud just pivots the paddle.
    this.hpRef = this.hpRef ? qslerp(this.hpRef, P, 1 - Math.exp(-dt / c.ARC_TAU)) : P;
    { const u = clamp((rate - c.ARC_LO) / (c.ARC_HI - c.ARC_LO), 0, 1), on = u * u * (3 - 2 * u), w0 = this.armW || 0;
      this.armW = w0 + (on - w0) * (1 - Math.exp(-dt / (on > w0 ? 0.04 : 0.3))); }
    // Jitter buffer. Real AirPods deliver samples in PAIRS every ~40 ms (gaps up to ~80 ms), so rendering "now" means
    // extrapolate-stall-snap. Instead pose() replays these snapshots a little in the past and only ever interpolates.
    this.snap.push({ t, P, ref: this.hpRef, x: this.xy.to.x, y: this.xy.to.y, pu, w: this.armW });
    while (this.snap.length > 2 && this.snap[1].t < t - 0.4) this.snap.shift();
    this.prev = L; this.last = cur;
  }

  _freezeRef(t, P) { this.refFrozen = true; this.refSeg = { from: this._refAt(t), to: P, t0: t, dur: this.c.FREEZE_BLEND, ease: true }; }

  // Which past moment should the locked base / arm reference go back to?
  // Default 120 ms. If a slow backswing (motion against the swing) led up to it, go to before that backswing.
  _rollback(t, tg) {
    const c = this.c, H = this.hist; if (!H.length) return null;
    let i = H.length - 1; while (i > 0 && H[i].t > t - c.ROLLBACK) i--;
    let j = H.length - 1; while (j > 0 && H[j].t > t - 0.06) j--;
    const sx = tg.ux - H[j].ux, sy = tg.uy - H[j].uy, sn = Math.hypot(sx, sy);         // which way the swing sweeps (unclamped)
    let best = i;
    if (sn > 0.05 && c.WINDUP_MAX > 0) {
      let found = false, still = 0;
      for (let k = i; k > 0 && t - H[k - 1].t <= c.WINDUP_MAX && !H[k].frozen && !H[k - 1].frozen; k--) {
        const dtk = H[k].t - H[k - 1].t || 0.02;
        const along = ((H[k].ux - H[k - 1].ux) * sx + (H[k].uy - H[k - 1].uy) * sy) / sn / dtk;
        if (along < -c.WINDUP_SPEED) { best = k - 1; found = true; }
        else if (H[k].rate < c.STILL_RATE) { if (found) break; still += dtk; if (still > c.STILL_MAX) break; }
        else break;
      }
    }
    return H[best];
  }

  // ---------- render-rate evaluation (pure in ts, sample-clock seconds) ----------
  _delay() { const c = this.c; return c.RENDER_DELAY + Math.min(this.jit * c.JITTER_GAIN, c.JITTER_MAX); }
  // One sample's view of the rotation at time tau: constant angular accel along its rate, either side of the sample.
  _curve(K, tau) {
    const c = this.c, h = clamp(tau - K.t, -0.04, c.EXTRAP_MAX), w = K.rate;
    if (w < 1e-6 || h === 0) return K.P;
    let ang;
    if (h > 0 && K.aPar < 0) { const he = Math.min(h, w / -K.aPar); ang = w * he + 0.5 * K.aPar * he * he; }   // never past the stop
    else ang = w * h + 0.5 * (h > 0 ? c.ACC_EXTRAP : 1) * K.aPar * h * h;
    return qmul(K.P, qexp(mul(K.rP, clamp(ang, -c.EXTRAP_ANGLE, c.EXTRAP_ANGLE) / w)));
  }
  _Ptau(tau) {
    const L = this.last, Pv = this.prev;
    if (!Pv || !L.B) return this._curve(L, tau);
    const u = clamp((tau - L.tA) / L.B, 0, 1);
    if (u >= 1) return this._curve(L, tau);
    return qslerp(qmul(L.fix, this._curve(Pv, tau)), this._curve(L, tau), smooth(u));
  }
  _Pat(ts) { return this._Ptau(ts - this._delay()); }
  _xyAt(ts) { const s = this.xy, u = clamp((ts - s.t0) / s.dur, 0, 1); return { x: lerp(s.from.x, s.to.x, u), y: lerp(s.from.y, s.to.y, u) }; }
  _refAt(ts) { const s = this.refSeg; let u = clamp((ts - s.t0) / s.dur, 0, 1); if (s.ease) u = smooth(u); return qslerp(s.from, s.to, u); }
  _punchAt(ts) { const p = this.punch, u = clamp((ts - p.t0) / p.dur, 0, 1); return add(mul(p.from, 1 - u), mul(p.to, u)); }

  pose(nowMs) {
    const c = this.c;
    if (!this.calibrated || !this.last) return { calibrated: false, x: 0, y: c.Y_MID, P: [0, 0, 0, 1], Pd: [0, 0, 0, 1], offset: [0, 0, 0], power: 0, swinging: false, rate: 0 };
    const ts = nowMs == null ? this.last.t : nowMs / 1000 - this.off;
    const N = this.snap, n = N.length;
    let P, S, punch, ref, w = this.armW || 0;
    if (nowMs != null && n >= 2 && N[n - 1].t === this.last.t) {
      const want = clamp(this.jmax + c.BUFFER_PAD, c.BUFFER_MIN, c.BUFFER_MAX);
      this.D += clamp(want - this.D, -0.0004, 0.003);                  // ease the delay, never jump it
      const tau = clamp(ts - this.D, N[0].t, N[n - 1].t);
      let i = n - 2; while (i > 0 && N[i].t > tau) i--;
      const a = N[i], b = N[i + 1], u = clamp((tau - a.t) / (b.t - a.t || 1), 0, 1);
      P = qslerp(a.P, b.P, u); ref = qslerp(a.ref, b.ref, u);
      S = { x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u) }; punch = add(mul(a.pu, 1 - u), mul(b.pu, u)); w = lerp(a.w, b.w, u);
    } else { P = this._Pat(ts); S = this._xyAt(ts); punch = this._punchAt(ts); ref = this._refAt(ts); }
    // Arc from a COMPRESSED rotation: a real hand stays in front of the body, so however far the bud turns (a backhand
    // turns it 120deg+ across you, plus a roll) the arc angle saturates at ARC_MAX and the paddle never comes back at the camera.
    const rel = qmul(P, qconj(ref)), ang = qangle(rel), lim = c.ARC_MAX * DEG;
    const relC = ang > 1e-6 ? qslerp([0, 0, 0, 1], rel[3] < 0 ? mul4(rel, -1) : rel, lim * Math.tanh(ang / lim) / ang) : rel;
    const o = mul(add(sub(qrot(qmul(relC, ref), c.ARM), qrot(ref, c.ARM)), punch), w);
    const offset = [clamp(o[0], -0.75, 0.75), clamp(o[1], -0.5, 0.6), clamp(o[2], -0.6, 0.2)];                        // +z is toward the camera
    return { calibrated: true, x: S.x, y: S.y, P, Pd: qmul(P, this.K || IDENT), offset, power: this.sw ? this.sw.peak : 0, swinging: !!this.sw, rate: this.last.rate, tilt: this.tilt || 0, punch, locked: !!this.lock };
  }
}

const mul4 = (q, k) => [q[0] * k, q[1] * k, q[2] * k, q[3] * k];
function dot4(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]; }
