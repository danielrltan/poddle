# Strokes: what the AirPod can and cannot tell about a pickleball shot

Code: `web/strokes.js` (pure ES module). Check: `node test/strokes.mjs`.

## How the paddle is held
- **Continental grip** is the default in pickleball: shake hands with the paddle, so the edge points at the net and
  the face is roughly vertical. One grip covers forehand, backhand, volley and overhead, which is why it is taught
  first: at the kitchen line there is no time to change grips. **Eastern** turns the palm a little behind the handle
  (flatter forehand drives); **western** turns it further under (heavy topspin, awkward backhands, rare).
- **Ready position:** paddle out in front, tip slightly up, about chest height, between forehand and backhand.
  That is the pose the calibration hold captures, so "pitch 0" means "pointing at the screen, level".
- **The user's hunch about smashes is right.** With a continental grip the overhead starts like a hammer throw:
  paddle cocked up and back behind the head, *edge* leading (the face looks sideways), then the arm comes down and
  forward while the forearm pronates ~60-90 deg to square the face at contact, high and in front. In sensor terms:
  start pitch far above level, a large roll offset, then a strong rotation about -R with a share about U/F from the
  pronation. While the paddle points up, pronation IS a rotation about the vertical axis, and for a right-hander it
  has the same sign as a backhand sweep. So a smash must be recognised from "starts high, goes down, fast" before
  anyone looks at left/right, or it reads as a backhand.

## What each stroke looks like to this IMU
Player frame: R = right, U = up, F = toward the net. axis = direction of the summed angular velocity over the stroke,
`[aboutR, aboutU, aboutF]`. h = +1 right-handed, -1 left-handed.

| Shot | Body | axis | Start pitch | Pace |
|---|---|---|---|---|
| Drive (forehand) | Shoulder turn, sweep across, slightly low-to-high, forearm pronates | mostly `+h` about U, a little +R, `-h` about F | about level | power 20-36, 90-140 deg |
| Backhand | Same off the other wing, shorter lever | mostly `-h` about U | about level | power 14-24, 70-100 deg |
| Smash | Cocked high and edge-on, down and forward, pronate | mostly -R, plus `-h` about U/F | +55 to +90 deg | raw peak 25-40 rad/s |
| Volley | Short punch from a raised paddle, arm moves more than it turns | any, small | at or above level | under ~35 deg, power credit ~0 |
| Dink | Low paddle, open face, gentle lift from the shoulder | +R | below level | soft |
| Lob | Same lift, bigger and faster, finishing high | +R | below level | power 18+ |
| Drop | Carved high-to-low with the face held open, unhurried | -R, face stays open (no pronation) | +25 to +55 deg | power under ~16 |
| Topspin roll | Low-to-high with a closing face, fast | +U with 30-50 % +R, `-h` about F | below level | fast |

## What the classifier actually uses
Robust: the rotation axis (up / down / sideways share), the **start pitch** (pitch does not drift and is grip-free
after calibration), and pace (`power`, plus the raw peak for an overhead snapped from a cocked paddle). Handedness
flips the sign of the U share and nothing else. Output: `dink | drop | lob | drive | backhand | volley | smash`, a
`side`, a confidence, and `ignore` for the cock-back before an overhead (soft upward turn that starts above level).

Every threshold is in `TUNING`; `node test/strokes.mjs` section E prints where each shot turns into its neighbour:
dink/lob at power 15, drop/smash at power 19, hard downswing drive/smash at 31 deg start pitch, volley/drive at
power 9, dink/volley at a level paddle, drive/lob when 63 % of the rotation is upward.

## Honest limits: one IMU in the hand, no position
- **Contact height is invisible.** "Overhead" is inferred from paddle pitch, not from where the hand is. A smash made
  with a level paddle reads as a chopped drive; pointing the bud at the ceiling and chopping reads as a smash from
  waist height. The webcam could supply hand height later; the head position it tracks now cannot.
- **Volley vs groundstroke** is really "did it bounce" - the server knows that, the IMU does not. Here a volley is a
  short stroke from a raised paddle. The accelerometer was meant to catch the punch, but centripetal acceleration
  of any swing (w^2 r: 4-7 g for a dink-speed wrist turn, 15 g+ for a drive, and the sensor clips) swamps the 2-3 g of
  a punch, and the sign convention is uncertain. It carries 20 % of the volley score and no more.
- **Dink vs third-shot drop** are the same stroke from different places. Pass `opts.depth` (metres from the net) and a
  soft lift from behind 4.5 m is called a Drop. High-to-low carved shots are Drops regardless.
- **Topspin roll vs flat drive vs slice drive:** face angle would separate them, and roll about the pointer is
  measurable (`rollDeg`), but it is relative to however the bud sat in the hand at calibration, and two players'
  "neutral" differ by more than the effect. Reported, not used. A roll is called a Drive.
- **Cock-back vs dink from a level paddle:** identical for the first 50 ms. About one cock-back in five that starts
  from a level paddle still goes out as a Dink at the early report. It only matters if the ball is already in reach.
- **Aim.** `dir` is still the sweep direction, so a right-hander's forehand always goes left and the backhand right.
  Nothing here changes that.
- **Early reports.** motion.js now reports ~45 ms into the movement on a predicted peak. The axis and start pitch are
  already reliable then; power is not, so dink/lob and drop/smash can change at `swingFix`. Classify both.
- All pitches are relative to the calibration hold. Calibrating with the bud tipped 20 deg up shifts every
  pitch threshold by 20 deg.

## Type -> ball flight (`shotParams`, table `SHOTS`)
Expressed in the `{n, lob}` the server's `solve()` already takes, so the callout and the flight cannot disagree.
From the default spot: Dink 1.4-1.7 m past the net, Drop 1.9 m (both in the kitchen, apex ~2.6 m), Lob 4.8 m deep with
a 4.4 m apex, Volley 3.6 m, Backhand ~4 m, Drive 4.5-5.4 m, Smash 5.7 m at 16 m/s. `chop` (Drop) and `steep` (Smash)
are hints the solver does not use yet.

## Wiring (none of this is done: motion.js, main.js and game.js belong to other people right now)
Validated on a patched scratch copy of motion.js: `STROKES_MOTION=/path/to/copy node test/strokes.mjs`. Section B of
the test switches to the event's own features as soon as `swing` events carry `axis`.

1. **web/motion.js, `_track`**, right after `const tg = this._target(s.q); this.tilt = tg.pitch;`:
   ```js
   // stroke features for strokes.js: the run of samples turning the same way (a wind-up turns the other way, so it is left out)
   if (rate < c.ROM_IDLE || !this.run || dot(wP, this.run.sum) < 0) this.run = { sum: [...wP], pitch0: tg.pitch / DEG, acc: len(s.a), t0: t };
   else { this.run.sum = add(this.run.sum, wP); this.run.acc = Math.max(this.run.acc, len(s.a)); }
   ```
   and in `shot()` (feeds both `swing` and `swingFix`) add, with `a = this.run.sum, k = len(a) || 1`:
   `axis: [a[0] / k, a[1] / k, -a[2] / k], pitch0: this.run.pitch0, pitch: tg.pitch / DEG, acc: this.run.acc, dur: (t - this.run.t0) * 1000`
   (`_vecP` has z toward the player, hence the minus: axis is `[aboutR, aboutU, aboutF]`).
   Recommended as well: a swing that has been sent only re-arms below 3 rad/s, so a quick cock-back that flows into
   the smash without the rate dipping is ONE swing, reported on the cock-back. Start a new swing when
   `sw.sent && rate > c.TRIGGER && dot(wP, sw.sum) < 0`.
2. **web/main.js**: `import { classifyStroke, featuresFromEvent, LABELS } from './strokes.js';`, a handedness
   setting (`?hand=left`, default right), and in the `swing` / `swingFix` branch:
   `const st = classifyStroke(featuresFromEvent(e), { hand, depth });` with `depth = Math.abs(my paddle z)` from the
   last `state`. If `st.ignore`, send nothing and remember it; otherwise send the existing message plus
   `kind: st.type`. If the early swing was ignored and its `swingFix` is not, send the fix with `fix: false`
   (the server's fix branch would otherwise patch a swing it never got).
   `hitFx`: `w.textContent = LABELS[kind] || 'Drive'` - no "Great", "Nice", "Got it". Delete the `#meter` lines there
   and `<div id="meter">` in index.html (the power bar under the callout).
3. **server/game.js** (CommonJS): `let strokes; import('../web/strokes.js').then(m => { strokes = m; });`
   In the `swing` handler: `const kind = strokes && strokes.TYPES.includes(m.kind) ? m.kind : null, sp = kind && strokes.shotParams(kind, num(m.power, 6));`
   then use `sp ? sp.n : pw` and `sp ? sp.lob : lob` for the flight (keep raw `pw` for the window length and the
   serve gate), store `kind` on `me.swing`, and patch it in the `m.fix` branch too.
   `strike()`: `kind: sw.kind || strokes.legacyType(sw.n, sw.lob)` replaces `shotKind()` (whose `'tap'` is what fell
   through to "Got it"); bots get real names the same way. The two serve `hit` broadcasts carry `kind: 'serve'`.
   Optional: shorten `T` by ~15 % in `solve()` when `steep`, halve the bounce when `chop`.
