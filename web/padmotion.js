// A phone as the paddle: the browser's deviceorientation + devicemotion events -> the same sample the AirPod bridge
// sends ({ t, q, r, a }, CONTRACT.md), so MotionModel cannot tell the two apart. Pure logic, runs in node (test/padmotion.test.mjs).
//   q  device -> reference, Z up: the spec's intrinsic Z(alpha) X'(beta) Y''(gamma), as one quaternion
//   r  rad/s in the device frame. Browsers disagree about which of rotationRate's alpha/beta/gamma is which axis (the
//      spec and the engines say x,y,z; MDN and some old builds say z,x,y), so it is not assumed: the turn between two
//      orientations says what the rate must have been, and the naming (and sign) that agrees with it is kept.
//   a  acceleration without gravity, in g
const DEG = Math.PI / 180, G = 9.80665;
const qmul = (a, b) => [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
const fin = v => Number.isFinite(v);

export function eulerToQuat(alpha, beta, gamma) {   // degrees, as the event gives them
  const z = alpha * DEG / 2, x = beta * DEG / 2, y = gamma * DEG / 2;
  return qmul(qmul([0, 0, Math.sin(z), Math.cos(z)], [Math.sin(x), 0, 0, Math.cos(x)]), [0, Math.sin(y), 0, Math.cos(y)]);
}

// the ways a browser may name the three rates: [index of alpha/beta/gamma used for x, y, z]
export const NAMINGS = { xyz: [0, 1, 2], zxy: [1, 2, 0] };
const LOCK = 6;                                    // rad^2/s of agreement before a naming is trusted (a second of turning the phone over)

export class PadMotion {
  constructor() { this.q = null; this.qAt = 0; this.prevQ = null; this.prevT = 0; this.naming = 'xyz'; this.sign = 1; this.locked = false; this.score = { xyz: 0, zxy: 0 }; this.n = 0; }
  orientation(e, t) {                              // a deviceorientation event (or anything with alpha, beta, gamma); t in s
    if (!fin(e.alpha) || !fin(e.beta) || !fin(e.gamma)) return;
    this.q = eulerToQuat(e.alpha, e.beta, e.gamma); this.qAt = t;
  }
  // a devicemotion event -> one sample, or null while there is nothing to send (no orientation yet, no gyro)
  motion(e, t) {
    const rr = e.rotationRate; if (!this.q || !rr || !fin(rr.alpha) || !fin(rr.beta) || !fin(rr.gamma)) return null;
    const raw = [rr.alpha * DEG, rr.beta * DEG, rr.gamma * DEG];
    if (!this.locked) this.learn(raw, t);
    const m = NAMINGS[this.naming], r = [raw[m[0]] * this.sign, raw[m[1]] * this.sign, raw[m[2]] * this.sign];
    const ac = e.acceleration, a = ac && fin(ac.x) && fin(ac.y) && fin(ac.z) ? [ac.x / G, ac.y / G, ac.z / G] : [0, 0, 0];
    this.n++;
    return { t, q: this.q, r, a };
  }
  learn(raw, t) {                                  // body rate from the last two orientations, against each naming
    const q = this.q, p = this.prevQ;
    if (p && q !== p) { const dt = this.qAt - this.prevT;
      if (dt > 0.004 && dt < 0.1) {
        let d = qmul([-p[0], -p[1], -p[2], p[3]], q); if (d[3] < 0) d = d.map(v => -v);
        const w = [2 * d[0] / dt, 2 * d[1] / dt, 2 * d[2] / dt];                     // small-angle: fine at 60 Hz for a phone being turned over in the hand
        for (const k in NAMINGS) { const m = NAMINGS[k]; this.score[k] += (w[0] * raw[m[0]] + w[1] * raw[m[1]] + w[2] * raw[m[2]]) * dt; }
        const best = Math.abs(this.score.zxy) > Math.abs(this.score.xyz) ? 'zxy' : 'xyz', other = best === 'xyz' ? 'zxy' : 'xyz';
        this.naming = best; this.sign = this.score[best] < 0 ? -1 : 1;
        if (Math.abs(this.score[best]) > LOCK && Math.abs(this.score[best]) > 2 * Math.abs(this.score[other])) this.locked = true;
      } }
    if (q !== p) { this.prevQ = q; this.prevT = this.qAt; }
  }
}
