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

## 12. Day two: tuning on the real player instead of on assumptions
- **Power was backwards.** Tests built from idealised swing shapes said a fast swing is a strong swing. On the real
  player it was the opposite: a snappy wrist flick peaks at 28-38 rad/s and gets there in 80-100 ms, while a wide arm
  swing only reaches 9-14 rad/s, takes 240-340 ms and sweeps 100-190 degrees. Rotation speed says almost nothing about
  effort. Power is now effort: how far and how long the hand travelled before the peak. `data/live-swings.jsonl` is the
  labelled recording that settled it and `node test/real.mjs` replays it.
- **Fixing power made everything late.** Waiting for the peak meant reporting 130 ms (flick) to 265 ms (wide) after the
  hand moved. The two movements already differ in the first 40-60 ms (angular acceleration, g-force), so the swing is
  now reported early with a provisional power (flick ~50 ms, wide ~105 ms) and refined with follow-up messages. Found
  on the way: a swing that started out of another swing's follow-through was swallowed entirely.
- **The server added its own delay.** A swing waited for the next 60 Hz tick; now it is checked the instant it arrives
  (11.7 ms -> 0.8 ms). A hit granted slightly late used to launch the ball from behind the player; now it launches from
  where the ball crossed the paddle, the drawn ball blends onto the new path, and a power refinement is eased in over
  100 ms instead of kinking the flight.
- **Jitter, properly diagnosed.** The replay buffer ran dry about twice a second (the delay sank below what the
  Bluetooth link needs), freezing the paddle for up to 50 ms and then snapping it. Measured with `node test/smooth.mjs`;
  the write-up with patches is in `docs/jitter-diagnosis.md`.
- **Short balls were unreachable.** When forward/back became the player's job, the automatic footwork was switched off
  and a ball dying in the kitchen left them stranded. Forward/back is now shared: the game does 90 % of the run, a lean
  on the AirPod adds the rest. Deep balls get the same help backwards, and a serve can no longer be left hanging out of
  the server's reach.
- **Serving felt glued to the paddle, and twitches served.** The ball now hangs and follows loosely (dead zone, ~0.6 s
  lag), and only a deliberate swing that actually meets it serves.
- **Calibration neutral was the wrong pose.** People keep the AirPod tipped up after the tilt step because that is how a
  paddle is held; the on-screen paddle leaned back by that angle. The resting pose after the tilt is now neutral, and
  the paddle shows the bud's real attitude (flat toward the screen = flat toward the net).
- **Shots that match the stroke.** Underhand = lob (a very gentle one is a kitchen dink), a downward overhead = smash,
  a paddle simply held in the ball's path near the net = block, and a soft volley out of the air near the net is a
  block too. Spin comes from a level paddle, a rolling wrist or a curved "C" shaped swing; thresholds were set from the
  distribution of real swings so a plain swing stays flat. A spinning ball floats, stays low, loses half its pace on the
  bounce and breaks sideways.
- **Spin you could not see.** Backspin drawn at 60 rad/s strobes at 60 fps and reads as not spinning. It is drawn at
  about three turns a second with streaks around the ball.
- **Head-coupled camera.** The screen behaves like a window pinned to the net (off-axis projection), so the court stays
  framed and the paddle stays on screen however far to the side the player stands.
- **Feel.** Hit effects were doubled, the ball trail is a continuous power scale (white -> yellow -> orange -> red, icy
  blue for spin), and the paddle leaves a motion blur only during a real swing.
- **UI.** Rebuilt by a design -> critique -> implement -> verify pipeline in the glossy, rounded visual language of
  mid-2000s console sports games, using only original assets and an open-licence typeface stored with the game.
- **Working with parallel agents.** Several agents edited the project at once. What kept that safe: each owned named
  files, used its own port range, never touched the live servers, and had to prove its change with a numeric test.
  What went wrong: a long multi-agent run stalled twice when the laptop slept, and a page reload while the UI agent was
  mid-rewrite looked like "the hit effects are gone".
- **Tests that age.** Several older scripted scenarios encode geometry, latency bounds or synthetic swing shapes that
  were changed on purpose (`test/motion.test.mjs`, `test/latency.mjs`, `test/rom.mjs`, parts of
  `test/server.test.mjs`). The tests that reflect the current game are: real, serve, kitchen, deep, slice, lagcomp,
  feel, hitblend, bot, parallax, strokes and e2e.
