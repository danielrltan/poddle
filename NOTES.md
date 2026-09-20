# Poddle — working notes

Build log for Hack the North 2026. What we tried, what broke, and how each problem was solved.

## 1. Can an AirPod be a controller at all?
- **Question:** `CMHeadphoneMotionManager` normally only streams while the AirPods are worn.
- **Finding:** with *Automatic Ear Detection* turned off, one bud held in the hand (the other in the case) keeps
  streaming at 50 Hz. Real paddle swings peak around 35 rad/s.
- **Gotcha:** a command-line Swift binary gets silently denied motion access unless an `Info.plist` with
  `NSMotionUsageDescription` is embedded in the binary (`-sectcreate __TEXT __info_plist`). The first build printed
  nothing at all, so the reader now logs authorisation state, connect/disconnect events and a 4-second watchdog.

## 2. No position sensor
- An IMU gives orientation, rotation rate and acceleration. Double-integrating acceleration drifts by metres within a
  second or two, so the hand's position cannot be measured.
- First attempt: map the wrist's turn angle to court position. It felt like the game was "adding movement" rather than
  tracking it, and a wide wind-up dragged the paddle across the court.
- Second attempt: automatic footwork, the way Wii Sports tennis does it.
- What stuck: **the laptop webcam tracks the player.** A face detector (with a body-pose fallback for distance or a
  turned head) gives left/right and up/down. The court is mapped onto the camera's field of view rather than onto
  metres, so it works at any distance as long as the player is in frame.
- Forward/back: face size was too noisy a depth signal, so it became a **tilt**: tip the AirPod forward to walk to the
  kitchen, back to retreat. Tilt is measured against gravity, which is the most drift-free signal the sensor has.

## 3. Grip-independent calibration
- Nobody holds an AirPod the same way, and the sensor's heading is arbitrary.
- Two steps: hold still for 5 seconds (within 10°), then tip the bud up. The axis of that tilt, projected onto the
  horizontal plane, is the player's "right"; gravity gives "up"; their cross product gives "toward the net".
  Everything downstream is expressed in that frame, so grip and compass heading stop mattering.

## 4. Jitter
- Measured on the real stream: samples arrive in **pairs every ~40 ms**, with gaps up to 78 ms, even though the sensor
  clock ticks evenly at 20 ms.
- Rendering "now" meant extrapolate, stall, snap. Fix: a jitter buffer. The paddle is drawn ~65 ms in the past and only
  ever interpolates between real samples. Replaying the real arrival timing, roughness fell from 565 % to 9 % of a
  frame step.
- Camera tracking had its own jitter (detector noise multiplied up to court scale). Fix: a one-euro filter on the face
  keypoints plus a critically damped follow at render rate.

## 5. The paddle "rotated in place"
- A 1:1 orientation copy looks like a paddle spinning on a pin. Fix: a kinematic arm, so a swing sweeps an arc.
- That created new problems: a lock that held the aim through the follow-through made the paddle freeze, the wind-up
  looked like a teleport, and on backhands (the bud turns 120°+ across the body) the virtual arm swung the paddle back
  toward the camera.
- Final version has no locks: the arm reference is a slow low-pass of the hand, so fast motion draws an arc and any held
  pose relaxes to centre in about half a second. The arc fades in with rotation speed (slow turns just pivot the paddle)
  and its angle saturates at 65°.

## 6. Fast left/right movement lagged
- Cause: a 5 m/s speed cap plus treating anything over 5.5 rad/s as a swing wind-up. A quick zigzag hit both.
- After retuning, a 2-per-second zigzag keeps 94 % of its amplitude at ~50 ms lag (was 38 % at 205 ms).

## 7. Hit registration
- Version one reversed the ball the instant a swing arrived, wherever the ball was. It looked janky.
- Now a swing opens a window and the hit lands on the server tick where the ball is actually inside a contact box around
  the paddle. Gentle swings get a longer window than hard ones. Every launch is solved ballistically so it clears the
  net and lands in.

## 8. Swings, flicks and power
- A wrist flick can be as fast as an arm swing, so peak speed alone is a bad measure of effort.
- Power = peak rotation rate × credit for the angle swept and how long the motion lasted. A flick scores as a soft tap;
  a 130° forehand scores about 30; a backhand 14–20.
- The stroke shape picks the shot: level swing = drive (more power, deeper and flatter); underhand scoop = the ball goes
  up and loses pace — gentle is a dink that drops in the kitchen, big is a lob. `node test/shots.mjs` prints the table.
- Serving: the ball floats in front of the server until they swing at it.

## 9. The opponent
- The first bot request was silently ignored in some states and any reconnect removed it for good.
- Now it joins by itself when a player is alone, has three levels (Rookie / Club / Pro), places the ball away from the
  player, eases off when well ahead, leaves when a second human connects and returns when they go.

## 10. Things that cost time
- **A stale address in the URL.** `#<old-LAN-IP>` from earlier in the night meant the page never reached the game
  server: no opponent, no footwork, and confusing symptoms. The client now gives up on a dead address after 1.5 s,
  falls back to the local server and removes the stale part from the address bar.
- **The laptop went to sleep** mid-build and stalled a long-running job for three hours. `caffeinate` keeps it awake;
  closing the lid still sleeps it.
- **Camera framing.** The server moved the player behind the baseline for deep balls and the paddle dropped off the
  bottom of the screen exactly when the ball arrived. The camera now follows the player back, and the footwork range
  was capped.

## 11. Testing without hardware in the loop
- `test/fake-bridge.mjs` plays a scripted AirPod session; `test/e2e.mjs` drives headless Chrome through calibration and
  a rally against the bot and saves screenshots.
- `test/jitter.mjs` replays real arrival timing; `test/zigzag.mjs`, `test/rom.mjs`, `test/bigswing.mjs` and
  `test/shots.mjs` each measure one feel problem with numbers, so tuning was not guesswork.
- Known: several scripted scenarios in `test/server.test.mjs` and `test/motion.test.mjs` encode earlier geometry and
  latency bounds and now fail; the behaviours they cover were changed on purpose.
- Not verified by tests: face detection on a real face, and the feel of tilt-to-walk. Those were checked by hand.
