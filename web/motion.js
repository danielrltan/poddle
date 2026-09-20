// Pure motion logic: AirPod IMU samples -> player frame, paddle pose, swing events. No DOM, no three.js.
// Quaternions are [x,y,z,w], Hamilton product, q maps device -> reference (Z up). See CONTRACT.md.
const DEG = Math.PI / 180;

export const DEFAULTS = {
  HOLD_MS: 5000, HOLD_DEG: 10,              // step 1: still within HOLD_DEG for HOLD_MS
  TILT_DEG: 25, TILT_MIN_HORIZ: 0.75,       // step 2: tip up; axis must be mostly horizontal
  TILT_REARM_DEG: 12,                       // after a rejected twist, come back inside this before retrying
  X_PER_RAD: 3.0 / (35 * DEG), X_MAX: 3.8,  // pointer yaw -> lateral metres
  Y_MID: 1.0, Y_PER_RAD: 0.9 / (30 * DEG), Y_MIN: 0.3, Y_MAX: 2.3,
  BASE_TAU: 0.06,                           // base smoothing, s
  GATE_LO: 3.0,                             // base follows fully below this rate, not at all at FREEZE_RATE
  FREEZE_RATE: 5.5, RELEASE_RATE: 3.0, RELEASE_HOLD: 0.06,
  ROLLBACK: 0.13,                           // on lock, base + arm reference go back this far
  RELEASE_DEG: 20, RELEASE_TIMEOUT: 1.2,    // a swing's lock lets go when the pointer is back near the locked aim, or this long after the hand settled
  BASE_SPEED: 5.0,                          // m/s, hard limit on rendered base x and y: never a jump
  WINDUP_MAX: 0.6, WINDUP_SPEED: 5, STILL_RATE: 1.2, STILL_MAX: 0.3,   // ...or further, to before a slow backswing
  FREEZE_BLEND: 0.08,                       // ease the arm reference into the rolled-back state, s
  RECOVER_TAU: 0.3, RECOVER_RAMP: 0.5,      // after a lock, let the base go softly
  TRIGGER: 9, PEAK_WINDOW: 0.07, REARM: 3,  // swing detection, rad/s and s
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
export function armOffset(P, arm = DEFAULTS.ARM) { return sub(qrot(P, arm), arm); }

export class MotionModel {
  constructor(opts = {}) {
    this.c = { ...DEFAULTS, ...opts };
    this.accSign = this.c.ACC_SIGN;
    this.off = null;                         // local clock (s) - sample clock (s), min-tracked
    this.jit = 0;                            // mean arrival lateness, s
    this.last = null;                        // last sample + derived state
    this.startCalibration();
  }

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
    if (cal.stage === 'hold') {
      let ok = true;
      if (!cal.anchor || qangle(qmul(s.q, qconj(cal.anchor))) > c.HOLD_DEG * DEG) {
        ok = !cal.anchor; cal.anchor = s.q; cal.sum = [0, 0, 0, 0]; cal.t0 = s.t;
      }
      const sg = dot4(s.q, cal.anchor) < 0 ? -1 : 1;
      for (let i = 0; i < 4; i++) cal.sum[i] += sg * s.q[i];
      const progress = clamp((s.t - cal.t0) * 1000 / c.HOLD_MS, 0, 1);
      if (progress >= 1) { this.calib = qnorm(cal.sum); cal.stage = 'tilt'; }
      ev.push({ type: 'cal', stage: 'hold', progress, ok, msg: ok ? 'Hold it like a paddle, pointed at the screen. Keep still.' : 'Wobbled. Hold still.' });
      return;
    }
    let d = qmul(s.q, qconj(this.calib)); if (d[3] < 0) d = d.map(v => -v);
    const ang = qangle(d), progress = clamp(ang / (c.TILT_DEG * DEG), 0, 1);
    if (cal.blocked) {
      if (ang < c.TILT_REARM_DEG * DEG) cal.blocked = false;
      ev.push({ type: 'cal', stage: 'tilt', progress: 0, ok: false, msg: 'That was a twist. Level out, then tip the front UP.' });
      return;
    }
    if (ang < c.TILT_DEG * DEG) { ev.push({ type: 'cal', stage: 'tilt', progress, ok: true, msg: 'Now tip the front UP.' }); return; }
    const ax = mul([d[0], d[1], d[2]], 1 / len([d[0], d[1], d[2]])), h = Math.hypot(ax[0], ax[1]);
    if (h < c.TILT_MIN_HORIZ) {
      cal.blocked = true;
      ev.push({ type: 'cal', stage: 'tilt', progress: 0, ok: false, msg: 'That was a twist. Level out, then tip the front UP.' });
      return;
    }
    const R = [ax[0] / h, ax[1] / h, 0], U = [0, 0, 1];
    this.B = { R, U, F: cross(U, R) };
    this.yawFix = IDENT;
    this.calibrated = true;
    this._start(s);
    ev.push({ type: 'cal', stage: 'tilt', progress: 1, ok: true, msg: 'Calibrated.' });
    ev.push({ type: 'calibrated' });
  }

  // ---------- frames ----------
  _vecP(v) { const B = this.B; return [dot(v, B.R), dot(v, B.U), -dot(v, B.F)]; }     // world vector -> player/three.js axes
  _d(q) { return qmul(qmul(this.yawFix, q), qconj(this.calib)); }                    // world-frame delta since the hold
  _P(q) { const d = this._d(q), v = this._vecP(d); return [v[0], v[1], v[2], d[3]]; }  // same angle, axis re-expressed
  _target(q) {
    const c = this.c, B = this.B, p = qrot(this._d(q), B.F);
    const yaw = Math.atan2(dot(p, B.R), dot(p, B.F)), pitch = Math.asin(clamp(dot(p, B.U), -1, 1));
    return { p, yaw, pitch, ux: yaw * c.X_PER_RAD, uy: c.Y_MID + pitch * c.Y_PER_RAD, x: clamp(yaw * c.X_PER_RAD, -c.X_MAX, c.X_MAX), y: clamp(c.Y_MID + pitch * c.Y_PER_RAD, c.Y_MIN, c.Y_MAX) };
  }

  _reset(t, P, x, y) {
    this.bx = x; this.by = y; this.ref1 = P; this.ref2 = P;
    this.xy = { from: { x, y }, to: { x, y }, t0: t, dur: 0.02 };
    this.refSeg = { from: P, to: P, t0: t, dur: 0.02, ease: false };
    this.lock = null; this.refFrozen = false; this.tRamp = -1e9;
    this.hist = [];
  }
  _start(s) {
    const P = this._P(s.q), tg = this._target(s.q);
    const was = this.xy ? this._xyAt(s.t) : null;                     // after a stream gap the base slews, it never jumps
    this._reset(s.t, P, tg.x, tg.y);
    if (was) this.xy.from = this.xy.to = was;
    this.vel = [0, 0, 0]; this.abias = [0, 0, 0]; this.corrSum = 0;
    this.punch = { from: [0, 0, 0], to: [0, 0, 0], t0: s.t, dur: 0.02 };
    this.sw = null; this.prevRate = 0;
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
    const tg = this._target(s.q);

    // Hand over from the old prediction to this sample's curve, starting from exactly what pose() shows right now.
    const aPar = rate > 1e-6 ? dot(mul(sub(rP, L.rP), 1 / dt), mul(rP, 1 / rate)) : 0;
    const tA = s.arr - this._delay();
    let fix = qmul(this._Ptau(tA), qconj(this._curve(L, tA))); if (qangle(fix) > 0.35) fix = IDENT;
    const cur = { t, q: s.q, P, rP, aPar, rate, tA, B: Math.max(t - tA, c.BLEND_MIN), fix };

    // swing detection: trigger, 70 ms peak window, send, keep the peak until re-arm
    let sw = this.sw;
    if (!sw) {
      if (rate > c.TRIGGER) sw = this.sw = { t0: t, peak: rate, sum: [...wP], sent: false, r0: this.prevRate, r1: rate };
    } else {
      if (!sw.sent) sw.sum = add(sw.sum, wP);
      if (sw.r1 >= sw.r0 && sw.r1 > rate) {                           // r1 was a local max: parabolic true peak
        const den = sw.r0 - 2 * sw.r1 + rate, p = den < 0 ? 0.5 * (sw.r0 - rate) / den : 0;
        sw.peak = Math.max(sw.peak, Math.min(sw.r1 - 0.25 * (sw.r0 - rate) * p, sw.r1 * 1.08));
      }
      sw.peak = Math.max(sw.peak, rate); sw.r0 = sw.r1; sw.r1 = rate;
      const done = rate < c.REARM;
      if (!sw.sent && (done || t - sw.t0 >= c.PEAK_WINDOW - 1e-4)) {
        const n = len(sw.sum) || 1;
        sw.sent = true;
        ev.push({ type: 'swing', power: sw.peak, dir: clamp(-sw.sum[1] / n, -1, 1), lob: clamp(sw.sum[0] / n, 0, 1) * c.LOB_GAIN });
      }
      if (done) { ev.push({ type: 'swingEnd', peak: sw.peak }); this.sw = null; }
    }
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
    if (!this.calibrated || !this.last) return { calibrated: false, x: 0, y: c.Y_MID, P: [0, 0, 0, 1], offset: [0, 0, 0], power: 0, swinging: false, rate: 0 };
    const ts = nowMs == null ? this.last.t : nowMs / 1000 - this.off;
    const P = this._Pat(ts), S = this._xyAt(ts), punch = this._punchAt(ts);
    const offset = add(sub(qrot(P, c.ARM), qrot(this._refAt(ts), c.ARM)), punch);
    return { calibrated: true, x: S.x, y: S.y, P, offset, power: this.sw ? this.sw.peak : 0, swinging: !!this.sw, rate: this.last.rate, punch, locked: !!this.lock };
  }
}

function dot4(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]; }
