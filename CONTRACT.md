# Poddle — architecture contract (read fully before writing code)

Two-player Wii-Sports-style pickleball. Each player holds ONE AirPod in their hand as the paddle.
The only sensor is the AirPod IMU at ~50Hz: attitude quaternion, rotation rate, user acceleration.
THERE IS NO POSITION SENSOR. Never double-integrate acceleration for absolute position (drifts in ~1s).

## Processes (already running on the user's machine — DO NOT kill or restart anything on ports 8080, 8787, 3000)
- `motion/motion`  Swift binary, AirPods -> JSON lines. DONE, do not touch.
- `bridge/bridge.js` ws://localhost:8787, relays each JSON line to the browser. DONE, do not touch.
- `server/game.js`  authoritative game server (PORT env, default 8080). Newly rewritten, NOT yet battle-tested.
- `web/`            static client served by `python3 -m http.server 3000`. No bundler. three.js r160 UMD global
                    `THREE` from https://cdnjs.cloudflare.com/ajax/libs/three.js/0.160.0/three.min.js
- For tests, start your OWN server copy on another port:  `PORT=8123 node server/game.js`

## Motion sample (bridge -> browser), one JSON object per ws message
  { t: seconds, q: [x,y,z,w], r: [x,y,z], a: [x,y,z] }
- q: CoreMotion attitude, device frame -> reference frame. Reference frame has **Z = up (gravity-aligned)**,
  X/Y horizontal but arbitrary heading. Yaw drifts slowly (minutes). Pitch/roll do not drift.
- r: rotation rate rad/s in the **device body frame**. World-frame angular velocity = rotate r by q.
- a: user acceleration in g, gravity removed, device body frame.
- Measured on the real hardware: real paddle swings peak at ~35 rad/s. Idle hand < 1 rad/s. Repositioning 3-6 rad/s.
- `data/live-capture.jsonl` is a real 20s capture (may or may not contain swings). `data/index.old.html` is the
  previous single-file client, for reference only.

## Player frame (how to make everything independent of how the bud sits in the hand)
Two-step calibration:
 1. HOLD: player holds the bud how they'd hold a paddle, pointed at the screen, still within 10 deg for 5 s
    (progress ring, resets on wobble). Result: `calib` quaternion.
 2. TILT UP: player tips it up >25 deg. World-frame delta d = q * calib^-1. Its rotation axis, projected onto the
    horizontal plane and normalised, is the player's RIGHT axis **R** (pitching up = positive rotation about R).
    Reject (ask again) if the horizontal part of the axis is < 0.75 (that was a twist, not a tilt).
    U = (0,0,1).  F = U x R  (forward, toward the net).
Then at any time, with d = q * calib^-1 (world-frame delta):
 - pointer p = d applied to F.  yawRight = atan2(p.R, p.F) - yawZero;  pitchUp = asin(p.U)
 - player-frame rotation P: same angle as d, axis re-expressed as (v.R, v.U, -v.F)  -> three.js axes
   (x = player's right, y = up, z = toward the player / away from the net).
 - key R re-zeros yaw only (yawZero), key C restarts calibration.

## Paddle placement
 - base position from the pointer: x = yawRight / 35deg * 3.0 m (clamp +-3.8), y = 1.0 + pitchUp / 30deg * 0.9 (clamp 0.3..2.3).
   Smooth it. FREEZE the base while a swing is in progress (rotation rate > ~5.5 rad/s) and on swing start roll the
   base back to its value ~120 ms earlier, so the wind-up doesn't drag the paddle off the ball.
 - z (forward/back) is owned by the SERVER (auto-footwork, like Wii Sports). Client only renders it.
 - **THE CURRENT COMPLAINT, MUST FIX:** "when I swing, the paddle doesn't go through a range of motion, it just
   rotates in the spot it's in, nothing feels fluid." The paddle must visibly SWEEP THROUGH SPACE during a swing.
   Approach: kinematic arm. The paddle is at the end of a virtual arm pivoting near the shoulder/elbow:
   rendered position = base + (P applied to armVec) - armVec, armVec ~ 0.65-0.8 m pointing forward (-z, slightly down/right),
   so a 120 deg swing carries the paddle through a ~1.3 m arc, plus a small leaky-integrated (tau ~0.2 s, capped
   ~0.3 m) translation from user acceleration for punch. It must settle back with no drift, must not jitter at rest,
   must be smooth at 50Hz input / 60-120Hz render (interpolate/extrapolate between samples using rotation rate).
   The arc offset is VISUAL ONLY — the server does contact against the base x,y.

## Swing detection (client)
 - trigger when |r| rises above 9 rad/s; then watch 70 ms for the true peak; then send `swing`.
   Re-arm when |r| < 3. Keep tracking the peak until re-arm for the on-screen peak logger.
 - dir  in [-1,1]: which way the swing sweeps. w = r rotated into world by q. dir = -(w.U)/|w|  (CCW seen from above = sweeping left = negative).
 - lob  in [0,1]: upward scoop. lob = clamp((w.R)/|w|, 0, 1) * 0.8

## Client -> server messages
  { type:'paddle', x, y, q:[x,y,z,w] }   ~20Hz. x is WORLD x (= localX * s, s=+1 for side 0, -1 for side 1). q is the PLAYER-FRAME rotation P.
  { type:'swing', power, dir, lob }      power = peak rad/s
  { type:'bot' }                         ask for an AI opponent when alone (key B)
## Server -> client
  welcome {side, court:{halfW,halfL,kitchen,net}}     side 0 defends +z, side 1 defends -z, net at z=0
  state   {p:[x,y,z], v:[x,y,z], live, score:[s0,s1], paddles:[{x,y,z,q,bot}|null, ...]}   60Hz. Extrapolate the ball with v between packets.
  launch  {by, land:[x,z]}     ball was just struck/served; show a landing marker
  hit     {side, n, p}         n = 0..1 power.  pop sound, burst, paddle lunge
  swung   {side}               someone started a swing (animate bots/opponent)
  bounce  {p}    serve {by}    point {winner, why, score}
  whiff   {why: 'early'|'late'|'left'|'right'|'high'|'low'}   only to the player who missed
Rendering rule: a paddle belonging to side k with player-frame rotation P has world rotation P for side 0 and
T*P*T^-1 for side 1, where T = 180 deg about Y. Camera sits behind the local player's baseline looking at the net.

## Hit registration (server) — the previous version was "very very janky"
A swing opens a 320 ms window. The hit happens on the tick where the ball is inside the contact box around that
player's paddle (|dx|<1.15, |dy|<0.95, 1.6 m in front to 0.9 m behind). Ball is snapped to the paddle face and
relaunched ballistically to a landing target that always clears the net. Window expires -> whiff with a reason.

## Files and owners
  web/motion.js   pure logic ES module, NO three.js / DOM, own small quaternion+vector math, runs in node. (`web/package.json` = {"type":"module"})
  web/scene.js    ES module, uses global THREE. All visuals + WebAudio. No networking, no motion maths.
  web/main.js     ES module. websockets, HUD, calibration overlay, keys, render loop. Glues motion.js + scene.js.
  web/index.html  markup + css + script tags only.
  test/           node tests (.mjs). Run with plain `node`. No test framework, no new npm deps unless unavoidable.

## CONFIRMED BUG FROM THE REAL USER (right-handed) — the design above is NOT enough, this section overrides it
"When I swing, it teleports my paddle to the left." Cause: yaw does double duty — it aims the base position AND it
is what a swing rotates. A righty forehand follows through ~90-120 deg to the LEFT. Freezing the base only while
rotation rate is high is wrong: the moment the follow-through decelerates, tracking resumes with the pointer far
left, and 35 deg = full court, so the base slams into the left sideline. Required behaviour in MotionModel:
 - On wind-up/swing start (|r| >= ~5.5): lock the base to the aim from ~120-150 ms earlier (yaw AND pitch).
 - HOLD that base through the swing AND the follow-through. Release only when |r| < 3 AND (pointer is back within
   ~20 deg of the locked aim OR ~1.2 s have passed since the hand settled).
 - Base x,y are always rate-limited (~5 m/s): a jump is never allowed, even on release-by-timeout.
 - The follow-through must still be VISIBLE — that is the arm-arc offset's job, not the base's.
 - test/motion.test.mjs must include: righty forehand with 110 deg follow-through held for 0.5 s then returned to
   ready -> base x changes < 0.35 m at every instant; same for lefty/backhand mirrored; and max |dx/dt| <= 5.5 m/s always.
