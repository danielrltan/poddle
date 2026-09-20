# Poddle 🏓

**Wii-Sports-style pickleball where the controller is an AirPod.** Built at Hack the North 2026.

Hold one AirPod in your hand, swing it like a paddle, and play a friend on another laptop (or the built-in bot).
No extra hardware: AirPods Pro/3/Max expose a 50 Hz IMU (orientation, rotation rate, acceleration) through
`CMHeadphoneMotionManager`, and Poddle turns that into a motion controller.

![screenshot](docs/screenshot.png)

## How it works

```
AirPod ──BLE──▶ motion/ (Swift, CoreMotion) ──stdout JSON──▶ bridge/ (ws :8787) ──▶ browser
                                                                                   │  web/motion.js  calibration, aim, swing detection, arm model
                                                                                   │  web/scene.js   three.js court, paddles, ball, audio
browser ◀──────────────── ws :8080 ────────────────▶ server/game.js  authoritative ball, contact, scoring, bot
```

- **There is no position sensor.** An IMU can't tell where your hand is (double-integrated acceleration drifts in
  about a second), so Poddle is built on what the sensor is good at: *orientation* and *rotation rate*.
- **Two-step calibration** makes it grip-independent: hold still for 5 s, then tip the bud up. The tilt axis tells the
  game which way is "right" and "up" for however you're holding it and whichever way you're facing.
- **Footwork is automatic, like Wii Sports tennis** (which never tracked where you stood either). The game runs you
  to the ball at a finite speed; you own the timing, direction, power and lob of the swing. Press **M** for the
  experimental aim-move mode, where turning the bud left/right moves the paddle across the court instead.
- **Swings** fire when rotation rate passes 9 rad/s (real swings peak around 35). Sweep direction aims the shot, an
  upward scoop lobs it, peak speed sets power. The aim is locked from just before the wind-up until your hand comes
  back, so a follow-through doesn't drag you across the court.
- **Kinematic arm:** the on-screen paddle sits at the end of a virtual arm, so a swing sweeps through a real arc
  instead of spinning in place.
- **Fair hit registration:** a swing opens a ~0.3 s window and the hit lands on the server tick where the ball is
  actually inside the contact box around your paddle. Misses tell you why (early / late / left / right / high / low).

## Run it

Requires macOS 14+, Node 18+, and AirPods with motion sensors connected to the Mac **as the audio output**.
Turn **off** *Automatic Ear Detection* (Settings → Bluetooth → AirPods ⓘ) so motion keeps streaming out of your ear.
Put the other bud in the case.

```bash
npm install
./motion/build.sh                          # builds the Swift motion reader

node server/game.js                        # ONE machine only (the host)
node bridge/bridge.js                      # every player's Mac
python3 -m http.server 3000 -d web         # every player's Mac
```

- Host opens `http://localhost:3000`
- Player 2 opens `http://localhost:3000/#<host-LAN-IP>`
- Alone? Press **B** for a bot.

Keys: **M** move mode · **C** calibrate · **R** re-center (yaw drifts over minutes) · **B** bot · **P** reset the swing-peak logger.

## Tests

```bash
node test/motion.test.mjs     # synthetic swings at arbitrary headings/grips (585/600 checks; the rest are strict smoothness bounds)
node test/server.test.mjs     # rallies, contact box, whiff reasons, scoring, bot, 26k launch solves
node test/e2e.mjs             # headless Chrome + simulated AirPod + bot   (needs Google Chrome)
```
