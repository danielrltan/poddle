# Paddle jitter: diagnosis and proposed fixes

Complaint: "with the most recent change the movement of the racket feels jittery, not smooth anymore. and it's not
consistent all the time."

Everything below is measured by `node test/smooth.mjs` (new; plain node, ~1 s per scenario). It rebuilds what the player
sees, frame by frame: **world pose = base** (webcam x,y through the same one-euro + `damp()` maths as `bodytrack.js` /
`main.js`; tilt-walk z through 20 Hz `paddle` messages -> the server's 60 Hz rate-limited follow -> `scene.js`'s 30 ms
lerp) **+ `pose().offset`**, orientation `pose().P`, at 60 and 120 Hz, while a `MotionModel` is fed synthetic hand motion
through the **real paired arrival timing** in `data/live2.jsonl` (4 arrival phases pooled per scenario). The 20 Hz
`setInterval` in `main.js` that also calls `pose()` is simulated, because `pose()` is not pure.

Numbers are against `web/motion.js` md5 `6cd3a176509de25e47db3aefa9ec985a` (it was being edited by another agent; re-run before trusting
line numbers). Nothing in `web/` or `server/` was modified.

Metrics: **wobble** = what a 67 ms quadratic fit of the path cannot explain (mm, or degrees of the paddle's pointing
direction), i.e. shake rather than motion. **ang-vel jump** = change of rendered angular velocity from one frame to the next.
**stalls** = frames moving at < 15 % of the local median speed. "floor" rows are the same metrics on the true,
continuous hand, so they show what the motion itself costs.

## Findings, ranked

### 1. The jitter buffer runs dry about twice a second (top offender, every scenario)
`pose()` sizes the delay as `jmax + 8 ms`, but to interpolate up to time tau the sample AFTER tau must have arrived, so
the depth needed is **lateness + one 20 ms sample period**. On the real link that is p50 44 ms, p90 64, p95 70, p98 84,
p99 87, max 101 ms. `jmax` also decays 5 ms/s, so between the rare 80 ms packets the delay sinks to ~51-66 ms, into the
body of the distribution. When it runs dry `tau` clamps to the newest snapshot: **the paddle freezes (up to 50 ms), then
snaps forward when the pair lands.**

| | shipped | fixed D = 90 ms |
|---|---|---|
| dry-buffer episodes, 31 s of play | **70 (2.3 per second)**, 112 frozen frames, longest 50 ms | 2 |
| zigzag (true peak 8.6 rad/s): peak RENDERED rate | **47.9 rad/s** | 17.1 (the rest is the time-base snap, below) |
| zigzag orientation wobble rms / max | **0.381 / 8.52 deg** (floor 0.022 / 0.03) | 0.095 / 1.85 |
| stir position wobble rms / max | **1.11 / 26.7 mm** | 0.35 / 4.7 |
| forehand worst frames | step 0.0 mm then 104-197 mm (2x the neighbours) | - |

Hitch rate vs a fixed delay (zigzag, 120 Hz, episodes per 31 s): 50 ms 199, 60 ms 69, 70 ms 41, 80 ms 4, 90 ms 2, 100 ms 0.

Two smaller defects in the same block:
- The delay is eased **per `pose()` call** (+3 ms / -0.4 ms), and `pose()` is called by both the rAF loop and the 20 Hz
  sender, so on frames where both run the buffered hand plays at **0.28x speed at 120 Hz** (0.64x at 60 Hz). Measured:
  49-53 frames slower than 0.9x per 31 s.
- **The time base snaps.** The real capture's lateness floor creeps up ~1 ms/s for 10 s, then drops 19 ms at once
  (`data/live2.jsonl`: floor 9, 11, 12 ... 19 ms, then 0). `feed()` follows the creep (`+2e-5`/sample) and takes the drop
  in one step, so rendered time jumps ~10-19 ms forward: forehand peak rendered rate 40-50 rad/s against a true 26.5,
  orientation wobble max 5.8 deg, even with the buffer depth fixed. 6 snaps > 3 ms per 45 s of replay.

### 2. Forward/back walking is a 20 Hz staircase (worst RMS of any scenario)
`bodyZ` moves up to 3.2 m/s, is sent at 20 Hz (0.16 m steps), the server follows at 7 m/s (2 ticks moving, 1 stalled),
and `scene.js` only filters the echo with a 30 ms lerp. Walk scenario: **base z wobble 3.1 mm rms (120 Hz) / 4.5 mm
(60 Hz), 33-50 % of moving frames are step outliers**. Rendering the client's own `bodyZ`: 0.05 / 0.12 mm, 0 % outliers.
Tilt-walk shipped in the same commit as the complaint ("most recent change"), and any grip drift past the 14 deg dead
zone walks you, so this is on screen a lot. (Also seen: a held overhead follow-through outlasts the 450 ms `walkHold`
and walks the player forward a few cm per swing.)

### 3. Chord interpolation between 50 Hz snapshots
`P = qslerp(a.P, b.P, u)` is a straight chord; at swing accelerations (~490 rad/s^2 on a 0.72 m arm) the chord error is
`a h^2 / 8` = ~17 mm, and the angular velocity steps at every sample. With the buffer fixed this is what is left:
zigzag orientation wobble 0.115 deg rms / 4.06 max -> 0.044 / 0.34 with a rate-aware (C1) interpolation.

### 4. "Not consistent": how much arc a swing draws depends steeply on its speed
`armW` fades in between 6 and 14 rad/s with a 40 ms attack, but swings register from 9 rad/s. Same 100 deg forehand:

```
  peak   6.8 rad/s   offset peak 0.01 m   arc travel 0.01 m  (a plain arm would travel 1.35 m: 1%)   w peak 0.01   swing events 0
  peak   8.4 rad/s   offset peak 0.08 m   arc travel 0.18 m  (a plain arm would travel 1.35 m: 13%)   w peak 0.17   swing events 0
  peak  10.5 rad/s   offset peak 0.27 m   arc travel 0.53 m  (a plain arm would travel 1.35 m: 40%)   w peak 0.48   swing events 1
  peak  13.0 rad/s   offset peak 0.45 m   arc travel 0.88 m  (a plain arm would travel 1.34 m: 66%)   w peak 0.76   swing events 1
  peak  16.9 rad/s   offset peak 0.55 m   arc travel 1.04 m  (a plain arm would travel 1.34 m: 78%)   w peak 0.88   swing events 1
  peak  21.1 rad/s   offset peak 0.54 m   arc travel 1.02 m  (a plain arm would travel 1.34 m: 76%)   w peak 0.86   swing events 1
  peak  26.0 rad/s   offset peak 0.54 m   arc travel 1.04 m  (a plain arm would travel 1.34 m: 78%)   w peak 0.85   swing events 1
  peak  33.8 rad/s   offset peak 0.50 m   arc travel 0.94 m  (a plain arm would travel 1.34 m: 70%)   w peak 0.77   swing events 1
```
A 10.5 rad/s swing (the dink the game now asks for) sweeps 40 % of a plain arm's path, a 17 rad/s one 78 %: the paddle
pivots in place on one swing and sweeps on the next. In the swing scenarios **42-54 % of the offset's travel is the
weight fading, not the arc moving** (biggest fade step 47 mm/frame at 120 Hz vs 106 for the arc itself).

### 5. Per-axis hard clamp corners (minor)
Active on 270 of ~4200 backhand frames and 45 overhead frames at 120 Hz (the `z <= 0.2` and `y` limits); never on
forehands. Overhead offset wobble 2.44 / 55.0 mm with the clamp, 2.32 / 51.6 without. Real, small.

### Not offenders
- **Webcam base x,y**: 0.02-0.04 mm rms wobble in every scenario (one-euro + 85 ms damp is smooth; it costs lag, not jitter).
- **tanh compression**: removing it makes every metric worse (forehand offset wobble 2.16 -> 3.02 mm). Keep it.
- **Hand held still**: 0.03 mm / 0.02 deg. Nothing to fix.
- **Punch**: 5-15 % of swing jerk; but the synthetic accelerometer is the least trustworthy input here. Left alone.

## Proposed patches (NOT applied), ranked by impact / risk

Before/after, all scenarios (cells: position wobble mm rms/max · orientation wobble deg rms/max · biggest ang-vel jump
rad/s per frame · stalled orientation frames). P12 = P1+P2, etc.

```
@ 60 Hz  (cells: position wobble mm rms/max | orientation wobble deg rms/max | biggest ang-vel jump rad/s per frame | frozen-or-stalled orientation frames)
| scenario | base | P1 | P12 | P124 | P1245 |
|---|---|---|---|---|---|
| still | 0.03/0.1 · 0.022/0.11 · 0.5 · 0 | 0.03/0.1 · 0.018/0.07 · 0.3 · 0 | 0.03/0.1 · 0.020/0.07 · 0.4 · 0 | 0.03/0.1 · 0.020/0.07 · 0.4 · 0 | 0.03/0.1 · 0.020/0.07 · 0.4 · 0 |
| slow | 0.22/0.6 · 0.090/1.16 · 5.9 · 7 | 0.22/0.6 · 0.028/0.68 · 2.9 · 0 | 0.22/0.6 · 0.021/0.11 · 0.7 · 0 | 0.22/0.6 · 0.021/0.11 · 0.7 · 0 | 0.22/0.6 · 0.021/0.11 · 0.7 · 0 |
| zigzag | 0.54/8.1 · 0.314/4.95 · 22.5 · 77 | 0.28/2.5 · 0.083/1.45 · 6.5 · 60 | 0.29/3.2 · 0.044/0.27 · 2.9 · 62 | 0.29/3.2 · 0.044/0.27 · 2.9 · 62 | 0.60/9.6 · 0.044/0.27 · 2.9 · 62 |
| stir | 1.04/19.8 · 0.408/6.17 · 27.1 · 7 | 0.40/10.4 · 0.118/3.31 · 12.8 · 0 | 0.39/8.3 · 0.081/0.82 · 2.1 · 0 | 0.39/8.3 · 0.081/0.82 · 2.1 · 0 | 0.79/18.6 · 0.081/0.82 · 2.1 · 0 |
| gentle | 0.41/5.4 · 0.064/1.08 · 4.8 · 1 | 0.40/5.3 · 0.031/0.53 · 4.3 · 0 | 0.41/5.4 · 0.029/0.26 · 3.4 · 0 | 0.41/5.4 · 0.029/0.26 · 3.4 · 0 | 0.51/6.4 · 0.029/0.26 · 3.4 · 0 |
| forehand | 2.33/26.8 · 0.205/3.60 · 17.2 · 1 | 2.00/25.7 · 0.126/1.60 · 10.7 · 0 | 1.99/18.4 · 0.128/2.14 · 12.9 · 0 | 2.01/17.9 · 0.128/2.14 · 12.9 · 0 | 1.65/14.7 · 0.128/2.14 · 12.9 · 0 |
| backhand | 2.23/28.7 · 0.212/3.49 · 19.0 · 1 | 1.96/26.0 · 0.119/1.46 · 11.6 · 0 | 1.95/16.8 · 0.125/2.36 · 12.8 · 0 | 1.90/17.2 · 0.125/2.36 · 12.8 · 0 | 1.54/14.9 · 0.125/2.36 · 12.8 · 0 |
| overhead | 3.07/44.2 · 0.199/3.77 · 17.5 · 1 | 2.74/18.4 · 0.106/1.52 · 11.5 · 0 | 2.83/20.8 · 0.118/1.59 · 11.7 · 0 | 2.69/18.3 · 0.118/1.59 · 11.7 · 0 | 2.39/12.7 · 0.118/1.59 · 11.7 · 0 |
| walk | 4.50/9.5 · 0.036/0.78 · 3.2 · 1 | 4.50/9.5 · 0.017/0.08 · 0.4 · 0 | 4.50/9.5 · 0.020/0.08 · 0.6 · 0 | 4.50/9.5 · 0.020/0.08 · 0.6 · 0 | 4.50/9.5 · 0.020/0.08 · 0.6 · 0 |

@ 120 Hz  (cells: position wobble mm rms/max | orientation wobble deg rms/max | biggest ang-vel jump rad/s per frame | frozen-or-stalled orientation frames)
| scenario | base | P1 | P12 | P124 | P1245 |
|---|---|---|---|---|---|
| still | 0.03/0.1 · 0.023/0.17 · 1.1 · 0 | 0.03/0.1 · 0.019/0.13 · 0.7 · 0 | 0.03/0.1 · 0.021/0.10 · 0.3 · 0 | 0.03/0.1 · 0.021/0.10 · 0.3 · 0 | 0.03/0.1 · 0.021/0.10 · 0.3 · 0 |
| slow | 0.21/0.7 · 0.101/1.59 · 10.2 · 35 | 0.21/0.7 · 0.030/0.87 · 5.0 · 3 | 0.21/0.7 · 0.022/0.14 · 0.8 · 0 | 0.21/0.7 · 0.022/0.14 · 0.8 · 0 | 0.21/0.7 · 0.022/0.14 · 0.8 · 0 |
| zigzag | 0.63/13.8 · 0.381/8.52 · 47.9 · 101 | 0.30/5.5 · 0.115/4.06 · 20.8 · 73 | 0.28/4.1 · 0.044/0.34 · 2.0 · 62 | 0.28/4.1 · 0.044/0.34 · 2.0 · 62 | 0.59/12.3 · 0.044/0.34 · 2.0 · 62 |
| stir | 1.11/26.7 · 0.449/8.33 · 46.8 · 36 | 0.41/13.3 · 0.142/4.22 · 21.6 · 3 | 0.45/10.8 · 0.120/0.72 · 2.1 · 0 | 0.45/10.8 · 0.120/0.72 · 2.1 · 0 | 0.99/24.3 · 0.120/0.72 · 2.1 · 0 |
| gentle | 0.44/6.5 · 0.067/1.53 · 8.2 · 8 | 0.41/7.4 · 0.037/0.56 · 3.2 · 0 | 0.41/7.2 · 0.029/0.31 · 2.1 · 0 | 0.41/7.2 · 0.029/0.31 · 2.1 · 0 | 0.49/7.4 · 0.029/0.31 · 2.1 · 0 |
| forehand | 2.16/35.5 · 0.223/5.83 · 32.1 · 12 | 1.92/27.1 · 0.133/1.70 · 9.5 · 0 | 1.92/21.3 · 0.132/3.15 · 14.7 · 0 | 1.93/20.7 · 0.132/3.15 · 14.7 · 0 | 1.59/16.5 · 0.132/3.15 · 14.7 · 0 |
| backhand | 2.12/37.6 · 0.235/6.79 · 38.1 · 12 | 1.85/27.3 · 0.128/1.75 · 10.2 · 0 | 1.86/18.1 · 0.128/2.65 · 12.1 · 3 | 1.80/18.1 · 0.128/2.65 · 12.1 · 3 | 1.47/15.7 · 0.128/2.65 · 12.1 · 3 |
| overhead | 2.66/54.9 · 0.234/8.32 · 45.9 · 13 | 2.23/19.5 · 0.112/1.81 · 10.9 · 0 | 2.33/19.7 · 0.115/1.71 · 8.8 · 1 | 2.20/19.7 · 0.115/1.71 · 8.8 · 1 | 1.84/12.9 · 0.115/1.71 · 8.8 · 1 |
| walk | 3.14/10.0 · 0.033/0.87 · 4.6 · 7 | 3.14/10.0 · 0.019/0.12 · 0.6 · 0 | 3.14/10.0 · 0.020/0.10 · 0.4 · 0 | 3.14/10.0 · 0.020/0.10 · 0.4 · 0 | 3.14/10.0 · 0.020/0.10 · 0.4 · 0 |

buffer delay (zigzag, 120 Hz): base: mean 66 ms (51..86), playback 0.28..1.04x, dry-buffer episodes 70
  P1: mean 86 ms (80..105), playback 0.85..1.02x, dry-buffer episodes 2
  P12: mean 86 ms (80..105), playback 0.85..1.02x, dry-buffer episodes n/a (coasts)
  P124: mean 86 ms (80..105), playback 0.85..1.02x, dry-buffer episodes n/a (coasts)
  P1245: mean 86 ms (80..105), playback 0.85..1.02x, dry-buffer episodes n/a (coasts)
```
(zigzag's ~60 "stalls" after the fixes are the true reversals of the zigzag: the true-hand floor has 44-62.)

### P1. Size the buffer for interpolation, slew it per second, slew the time base (high impact, low risk)
Costs ~20 ms of visual latency on the real link (mean delay 66 -> 86 ms); swing detection/hit timing is not touched
(`feed()` events do not depend on `D`). On a jitter-free link the 80 ms floor costs more (25 -> 80 ms); drop the
`BUFFER_MIN` hunk if that matters, the `+ 0.02` does most of the work (without the floor: mean 85 ms, 4 episodes).
Alone: episodes 70 -> 2, zigzag orientation wobble 0.381 -> 0.115 deg rms, peak rendered rate 47.9 -> 20.8 rad/s,
forehand wobble max 5.83 -> 1.70 deg. `test/jitter.mjs`: stalled frames 19 -> 2, roughness 9.2 % -> 2.9 %.
```diff
--- a/web/motion.js
+++ b/web/motion.js
@@ -3,7 +3,7 @@
 const DEG = Math.PI / 180;
 
 export const DEFAULTS = {
-  BUFFER_PAD: 0.008, BUFFER_MIN: 0.025, BUFFER_MAX: 0.12,   // jitter buffer: render this far behind the newest sample (s)
+  BUFFER_PAD: 0.008, BUFFER_MIN: 0.08, BUFFER_MAX: 0.12,   // jitter buffer: render this far behind the newest sample (s)
   HOLD_MS: 5000, HOLD_DEG: 10,              // step 1: still within HOLD_DEG for HOLD_MS
   TILT_DEG: 25, TILT_MIN_HORIZ: 0.75,       // step 2: tip up; axis must be mostly horizontal
   TILT_REARM_DEG: 12,                       // after a rejected twist, come back inside this before retrying
@@ -119,8 +119,8 @@
 
     // sample clock -> local clock. Arrival jitters, the sample clock does not: track the smallest offset.
     const o = (nowMs == null ? s.t * 1000 : nowMs) / 1000 - s.t;
-    if (this.off == null || o < this.off || o - this.off > 0.5) this.off = o;
-    else this.off += Math.min(o - this.off, 2e-5);
+    if (this.off == null || Math.abs(o - this.off) > 0.5) this.off = o;
+    else this.off += clamp(o - this.off, -5e-4, 2e-5);                // the real link's lateness floor creeps up ~1 ms/s then drops ~20 ms at once: slew down (25 ms/s), never snap the time base
     this.jit += (Math.min(o - this.off, 0.1) - this.jit) * 0.05;
     this.jmax = Math.max(o - this.off, this.jmax - 1e-4);              // worst recent arrival lateness (decays 5 ms/s)
     s.arr = s.t + (o - this.off);                                     // arrival, on the sample clock
@@ -402,8 +402,9 @@
     const N = this.snap, n = N.length;
     let P, S, punch, ref, w = this.armW || 0;
     if (nowMs != null && n >= 2 && N[n - 1].t === this.last.t) {
-      const want = clamp(this.jmax + c.BUFFER_PAD, c.BUFFER_MIN, c.BUFFER_MAX);
-      this.D += clamp(want - this.D, -0.0004, 0.003);                  // ease the delay, never jump it
+      const want = clamp(this.jmax + 0.02 + c.BUFFER_PAD, c.BUFFER_MIN, c.BUFFER_MAX);   // + one sample period: interpolating up to tau needs the sample AFTER tau
+      const dT = clamp(ts - (this.tD == null ? ts : this.tD), 0, 0.05); this.tD = ts;
+      this.D += clamp(want - this.D, -0.02 * dT, 0.15 * dT);           // ease the delay per SECOND (0.85x..1.02x playback), however often pose() is called
       const tau = clamp(ts - this.D, N[0].t, N[n - 1].t);
       let i = n - 2; while (i > 0 && N[i].t > tau) i--;
       const a = N[i], b = N[i + 1], u = clamp((tau - a.t) / (b.t - a.t || 1), 0, 1);
```

### P2. C1 interpolation, and coast instead of freezing when the buffer is dry (high impact, low-medium risk)
The diff below is against the file WITH P1 applied (they touch neighbouring lines); on the untouched file the
second hunk is the same three replaced lines, under the old `want`/`this.D` lines. Reuses the existing `_curve()` (rate + angular acceleration, "never past the stop", 45 ms / 0.6 rad caps). With P1:
zigzag wobble 0.115 -> 0.044 deg rms, max 4.06 -> 0.34 deg, biggest ang-vel jump 20.8 -> 2.0 rad/s; stir max 4.22 -> 0.72
deg; slow max 0.87 -> 0.14 deg. Caveat: in the hardest swings the worst single frame gets slightly worse (forehand max
1.70 -> 3.15 deg at 25 rad/s, where nobody can see it). Do not ship P2 without P1: coasting through 2 dry
spells a second still snaps on arrival (P2 alone: forehand position wobble max 31.6 mm against P1's 27.1, and gyro noise
shows while still: orientation wobble max 0.17 -> 0.54 deg).
```diff
--- a/web/motion.js
+++ b/web/motion.js
@@ -344,7 +344,7 @@
       this.armW = w0 + (on - w0) * (1 - Math.exp(-dt / (on > w0 ? 0.04 : 0.3))); }
     // Jitter buffer. Real AirPods deliver samples in PAIRS every ~40 ms (gaps up to ~80 ms), so rendering "now" means
     // extrapolate-stall-snap. Instead pose() replays these snapshots a little in the past and only ever interpolates.
-    this.snap.push({ t, P, ref: this.hpRef, x: this.xy.to.x, y: this.xy.to.y, pu, w: this.armW });
+    this.snap.push({ t, P, rP, aPar, rate, ref: this.hpRef, x: this.xy.to.x, y: this.xy.to.y, pu, w: this.armW });
     while (this.snap.length > 2 && this.snap[1].t < t - 0.4) this.snap.shift();
     this.prev = L; this.last = cur;
   }
@@ -405,10 +405,12 @@
       const want = clamp(this.jmax + 0.02 + c.BUFFER_PAD, c.BUFFER_MIN, c.BUFFER_MAX);   // + one sample period: interpolating up to tau needs the sample AFTER tau
       const dT = clamp(ts - (this.tD == null ? ts : this.tD), 0, 0.05); this.tD = ts;
       this.D += clamp(want - this.D, -0.02 * dT, 0.15 * dT);           // ease the delay per SECOND (0.85x..1.02x playback), however often pose() is called
-      const tau = clamp(ts - this.D, N[0].t, N[n - 1].t);
+      const tr = ts - this.D, tau = clamp(tr, N[0].t, N[n - 1].t);
       let i = n - 2; while (i > 0 && N[i].t > tau) i--;
       const a = N[i], b = N[i + 1], u = clamp((tau - a.t) / (b.t - a.t || 1), 0, 1);
-      P = qslerp(a.P, b.P, u); ref = qslerp(a.ref, b.ref, u);
+      // C1, not a chord: each end predicts along its own measured rate, cross-faded. Buffer dry (late packet): coast on the last sample, never freeze.
+      P = tr > b.t ? this._curve(b, tr) : qslerp(this._curve(a, tau), this._curve(b, tau), smooth(u));
+      ref = qslerp(a.ref, b.ref, u);
       S = { x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u) }; punch = add(mul(a.pu, 1 - u), mul(b.pu, u)); w = lerp(a.w, b.w, u);
     } else { P = this._Pat(ts); S = this._xyAt(ts); punch = this._punchAt(ts); ref = this._refAt(ts); }
     // Arc from a COMPRESSED rotation: a real hand stays in front of the body, so however far the bud turns (a backhand
```

### P3. Render your own forward/back position (high impact while walking, low risk) — `web/main.js`, owned by the serve agent
Walk scenario base-z wobble 3.14 -> 0.05 mm rms at 120 Hz (4.50 -> 0.12 at 60 Hz), step outliers 50 % -> 0 %.
```diff
--- a/web/main.js
+++ b/web/main.js
@@ render loop
-    const z = mine ? mine.z : s() * 6.5;
+    const z = usingBody() && !autoNow() ? s() * bodyZ : mine ? mine.z : s() * 6.5;   // your own walk is rendered locally: the server echo is a 20 Hz staircase
```
(`bodyZ` is updated a few lines further down, so this shows last frame's value: 8-16 ms late, invisible. The server
clamps to the same 2.6..7.4 range. The scene's hit lunge is separate and unaffected.) If `main.js` cannot be touched,
the one-constant alternative in `web/scene.js` `updatePads`: `damp(dt, local ? 0.03 : 0.06)` -> `damp(dt, local ? 0.12 : 0.06)`
gives 0.81 mm rms / 0 % outliers at 120 Hz (1.16 mm at 60 Hz) for ~90 ms more lag on z only.

### P4. Soft limits with a knee instead of per-axis hard clamps (small impact, low risk)
Identity below 60 % of each limit, tanh above, same asymptotes. Backhand position wobble 1.86 -> 1.80 mm rms, overhead
2.33 -> 2.20 (on top of P1+P2). Peak offsets shrink by a few cm only near the limits.
```diff
--- a/web/motion.js
+++ b/web/motion.js
@@ -415,7 +415,8 @@
     const rel = qmul(P, qconj(ref)), ang = qangle(rel), lim = c.ARC_MAX * DEG;
     const relC = ang > 1e-6 ? qslerp([0, 0, 0, 1], rel[3] < 0 ? mul4(rel, -1) : rel, lim * Math.tanh(ang / lim) / ang) : rel;
     const o = mul(add(sub(qrot(qmul(relC, ref), c.ARM), qrot(ref, c.ARM)), punch), w);
-    const offset = [clamp(o[0], -0.75, 0.75), clamp(o[1], -0.5, 0.6), clamp(o[2], -0.6, 0.2)];                        // +z is toward the camera
+    const soft = (v, lo, hi) => { const L = v > 0 ? hi : -lo, k = 0.6 * L, m = Math.abs(v); return m <= k ? v : Math.sign(v) * (k + (L - k) * Math.tanh((m - k) / (L - k))); };   // same limits, no corner
+    const offset = [soft(o[0], -0.75, 0.75), soft(o[1], -0.5, 0.6), soft(o[2], -0.6, 0.2)];                        // +z is toward the camera
     return { calibrated: true, x: S.x, y: S.y, P, offset, power: this.sw ? this.sw.peak : 0, swinging: !!this.sw, rate: this.last.rate, tilt: this.tilt || 0, punch, locked: !!this.lock };
   }
 }
```

### P5. Every registered swing draws its arc (consistency; judgement call, medium risk)
Fade in over 5..11 rad/s instead of 6..14, attack 60 ms instead of 40. Arc travel across registered swings 55-71 % of a
plain arm (was 40-78 %); swing position wobble drops 15-20 % (forehand 1.93 -> 1.59 mm rms) because less of the travel is
the fade. Price: medium-speed repositioning (5-9 rad/s) now draws some arc, so its position wobble doubles (zigzag
0.28 -> 0.59 mm rms, stir 0.45 -> 0.99), still below shipped (0.63 / 1.11).
```
  peak   6.8 rad/s   offset peak 0.07 m   arc travel 0.14 m  (a plain arm would travel 1.35 m: 11%)   w peak 0.14   swing events 0
  peak   8.4 rad/s   offset peak 0.22 m   arc travel 0.46 m  (a plain arm would travel 1.35 m: 34%)   w peak 0.42   swing events 0
  peak  10.5 rad/s   offset peak 0.42 m   arc travel 0.83 m  (a plain arm would travel 1.35 m: 62%)   w peak 0.75   swing events 1
  peak  13.0 rad/s   offset peak 0.50 m   arc travel 0.95 m  (a plain arm would travel 1.34 m: 71%)   w peak 0.83   swing events 1
  peak  16.9 rad/s   offset peak 0.50 m   arc travel 0.94 m  (a plain arm would travel 1.34 m: 70%)   w peak 0.81   swing events 1
  peak  21.1 rad/s   offset peak 0.48 m   arc travel 0.89 m  (a plain arm would travel 1.34 m: 67%)   w peak 0.76   swing events 1
  peak  26.0 rad/s   offset peak 0.46 m   arc travel 0.88 m  (a plain arm would travel 1.34 m: 65%)   w peak 0.73   swing events 1
  peak  33.8 rad/s   offset peak 0.40 m   arc travel 0.74 m  (a plain arm would travel 1.34 m: 55%)   w peak 0.62   swing events 1
```
```diff
--- a/web/motion.js
+++ b/web/motion.js
@@ -22,7 +22,7 @@
   COMMIT_T: 0.036,                          // report a swing this long after the hand started moving (s): a flick has peaked by then, an arm swing is still speeding up and its peak is predicted
   ONSET: 75,                                // rad/s^2: a rise gentler than this has not taken off yet
   FIX_ABS: 1.5, FIX_REL: 0.08,              // once the real peak is in, a 'swingFix' follows if the early power was off by more than this
-  ARC_TAU: 0.35, ARC_LO: 6, ARC_HI: 14, ARC_MAX: 65,     // swing arc: reference lag (s), and the rotation rates (rad/s) over which it fades in
+  ARC_TAU: 0.35, ARC_LO: 5, ARC_HI: 11, ARC_MAX: 65,     // swing arc: reference lag (s), and the rotation rates (rad/s) over which it fades in
   ROM_IDLE: 4, ROM_MIN: 16, ROM_FULL: 26, ROM_T_MIN: 0.032, ROM_T_FULL: 0.046,   // deg swept, and s taken, from the start of the movement to its peak: below MIN a swing scores nothing, at FULL its whole peak rate
   LOB_GAIN: 0.8,
   ARM: [0.10, -0.12, -0.70],                // virtual forearm, player frame (x right, y up, z toward player)
@@ -341,7 +341,7 @@
     // get stuck, nothing to jump. The arc fades in with rotation speed so slowly turning the bud just pivots the paddle.
     this.hpRef = this.hpRef ? qslerp(this.hpRef, P, 1 - Math.exp(-dt / c.ARC_TAU)) : P;
     { const u = clamp((rate - c.ARC_LO) / (c.ARC_HI - c.ARC_LO), 0, 1), on = u * u * (3 - 2 * u), w0 = this.armW || 0;
-      this.armW = w0 + (on - w0) * (1 - Math.exp(-dt / (on > w0 ? 0.04 : 0.3))); }
+      this.armW = w0 + (on - w0) * (1 - Math.exp(-dt / (on > w0 ? 0.06 : 0.3))); }
     // Jitter buffer. Real AirPods deliver samples in PAIRS every ~40 ms (gaps up to ~80 ms), so rendering "now" means
     // extrapolate-stall-snap. Instead pose() replays these snapshots a little in the past and only ever interpolates.
     this.snap.push({ t, P, ref: this.hpRef, x: this.xy.to.x, y: this.xy.to.y, pu, w: this.armW });
```

## Not verified
- No real swing recording exists (`data/*.jsonl` are a bud at rest), so the motion is synthetic (min-jerk strokes,
  0.3-0.5 rad/s tremor, accelerometer from a 0.47 m arm clipped at 16 g). Only the arrival timing is real, and it is one
  15 s capture replayed cyclically: the hitch RATE on another day or Bluetooth environment will differ; the mechanism will not.
- Webcam noise is assumed (0.002 of the frame width, white, 30 fps). Real MediaPipe noise is more correlated.
- Main-thread stalls from the face detector (it runs on the rAF thread) and dropped frames are not modelled; frame
  pacing in the test is perfect.
- Nothing was run in a browser; the patches were only exercised as copies of `web/motion.js` under `test/_tmp/` (deleted).
- `test/motion.test.mjs` already fails on the current file (120 FAIL lines) and fails more with P1 (153): it samples
  poses at fixed times with jitter-free arrival, where the 80 ms floor adds 55 ms. `test/bigswing.mjs` and `test/zigzag.mjs`
  report the same arc and amplitude with P1-P4 (zigzag base lag 90 -> 140 ms, same jitter-free artefact; aim mode only).
