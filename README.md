# Poddle 🏓

**Wii-Sports-style pickleball where the controller is an AirPod.** Built at Hack the North 2026.

Hold one AirPod in your hand, swing it like a paddle, and play a friend online or the built-in bot.
No extra hardware: AirPods Pro/3/Max have motion sensors (orientation, rotation rate, acceleration at 50 Hz) that macOS
exposes through `CMHeadphoneMotionManager`, and Poddle turns that into a motion controller.

![screenshot](docs/screenshot.png)

## How it works

```
AirPod ──BLE──▶ motion/ (Swift, CoreMotion) ──stdout JSON──▶ bridge/ (ws :8787) ──▶ browser
                                                                                   │  web/motion.js  calibration, aim, swing detection, arm model
                                                                                   │  web/scene.js   three.js court, paddles, ball, audio
browser ◀──────────────── ws :8080 ────────────────▶ server/game.js  serves web/, rooms, authoritative ball, contact, scoring, bot
```

- **There is no position sensor.** A motion sensor can't tell where your hand is (double-integrated acceleration drifts in
  about a second), so Poddle is built on what the sensor is good at: *orientation* and *rotation rate*.
- **Jitter buffer:** real AirPods deliver samples in pairs every ~40 ms with gaps to ~80 ms, so the paddle is rendered
  ~65 ms in the past and only ever interpolates between real samples (roughness 565% -> 9% of a frame step).
- **Two-step calibration** makes it grip-independent: hold still for 5 s, then tip the AirPod up. The tilt axis tells the
  game which way is "right" and "up" for however you're holding it and whichever way you're facing.
- **Real sideways movement comes from the webcam** (`web/bodytrack.js`): a face detector, with a body-pose fallback,
  tracks where you stand and maps the camera's view onto the court, at any distance.
- **Or footwork can be automatic, like Wii Sports tennis** (which never tracked where you stood either). The game runs you
  to the ball at a finite speed; you own the timing, direction, power and lob of the swing. Without a camera the game
  starts in aim-move (press **M** to switch), where turning the AirPod left/right moves the paddle across the court instead.
- **Swings need range of motion, not a wrist flick.** Power = peak rotation rate x credit for the angle swept and how
  long the motion lasted, so a 50° flick scores nothing while a 130° forehand scores ~30 and a backhand ~16-20. Sweep
  direction aims the shot, an upward scoop lobs it, peak speed sets power. The aim is locked from just before the
  wind-up until your hand comes back, so a follow-through doesn't drag you across the court.
- **Kinematic arm:** the on-screen paddle sits at the end of a virtual arm, so a swing sweeps through a real arc
  instead of spinning in place.
- **Fair hit registration:** a swing opens a ~0.3 s window and the hit lands on the server tick where the ball is
  actually inside the contact box around your paddle. The server reports why each swing missed (early / late / left /
  right / high / low).

## Set up

Requires macOS 14+, Node 18+, and AirPods with motion sensors connected to the Mac **as the audio output**.
Turn **off** *Automatic Ear Detection* (Settings → Bluetooth → AirPods ⓘ) so motion keeps streaming out of your ear.
Leave the other AirPod in its case.

## Play online

Open https://poddle.fly.dev in Chrome. The game runs there, but your AirPod talks to your own Mac, so each player
clones this repo and starts the AirPod bridge first:

```bash
npm install && ./motion/build.sh
node bridge/bridge.js
```

Press Play, then Quick play, Create room, or Enter code. Rooms have a 4-character code to share. Alone in a room? A bot
joins after 2.5 s. With two players the first serve waits until both have calibrated.

## Run it locally

```bash
npm install
./motion/build.sh                          # builds the Swift motion reader
node server/game.js                        # the game and the page, on :8080 (the host only)
node bridge/bridge.js                      # every player's Mac
```

- Open `http://localhost:8080`
- Second player on the same network: run `node server/game.js` and `node bridge/bridge.js` too, then open `http://localhost:8080/#<host-LAN-IP>`
  (opening `http://<host-LAN-IP>:8080` directly also works, but Chrome blocks the camera on a non-localhost http page, so you get aim-move)

Keys: **M** move mode (body / auto / aim) · **[ ]** range · **C** calibrate · **R** re-center (aim drifts over minutes) · **B** bot (press again for Rookie / Club / Pro) · **1 2 3** bot level · **V** AirPod view · **H** stats · **F** full screen · **P** reset swing stats · **Q** twice leaves a room.

## Tests

```bash
node test/motion.test.mjs     # synthetic swings at arbitrary headings/grips (written before the jitter buffer; its latency bounds now fail)
node test/jitter.mjs          # paddle smoothness replaying REAL AirPod arrival timing
node test/zigzag.mjs          # how well fast left-right movement is tracked
node test/rom.mjs             # flicks ignored, arm swings scored
node test/bot.test.mjs        # bot auto-join, levels, comes back when player 2 leaves
node test/server.test.mjs     # rallies, contact box, whiff reasons, scoring, bot, 26k launch solves
node test/rooms.test.mjs      # rooms: quick play, codes, full, leave, reconnect, hostile input
node test/menu.mjs            # title, lobby and room flow in headless Chrome   (needs Google Chrome)
node test/rooms-e2e.mjs       # two players through the lobby into one room, one Chrome each   (needs Google Chrome)
node test/e2e.mjs             # headless Chrome + simulated AirPod + bot   (needs Google Chrome)
```
