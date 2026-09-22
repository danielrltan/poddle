# Poddle — working notes

Build log. What we tried, what broke, and how each problem was solved.

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

## 13. Balancing the shot types
- **"Everything is a slice or a lob."** Spin had been allowed from three sources, one of them "the paddle is held level".
  This player rests the AirPod flat in the hand, so the paddle read level nearly all the time and 55 % of real swings
  came out as slices. The level-paddle input was removed; spin now comes only from a rolling wrist or a curved "C"
  shaped swing, with thresholds set above what ordinary swings do (the rotation axis of a plain swing wanders about
  0.4 rad, p75 about 1.1; roll about 0.2, p75 about 0.5).
- **Lobs from normal swings.** A low-to-high forehand has a real upward component, so a loose underhand rule turned
  drives into lobs. A lob now needs more than half the stroke to be going up.
- **Smashes labelled as slices.** A hard hit that also carried spin was called a slice. Power now wins the label: a hard
  hit is a smash, and it keeps its spin (drawn purple).
- **How it was measured.** `node test/kinds.mjs` replays the three real recordings (140 swings) through the client's and
  server's own classification code and prints the mix. Slices went from 55 % to about 17-20 %, drives from 6 % to over
  20 %, smashes from 4 % to 16 %. Caveat: a replay cannot know the player's real calibration, so the underhand and
  overhead shares are only roughly right; the curve ("turn") measure is calibration-independent.
- **The on-screen shot names were removed.** Even when right they were more confusing than helpful. Classification still
  runs underneath and drives the ball trail and the impact effects.
- **Smash effects.** The trail fattens and flickers like a flame, sheds embers, and the impact adds a large ring, a
  bigger flash and a harder shake; with spin the whole thing turns purple.
- **Calibration nagged too early.** The hold step flagged movement the instant the screen appeared and at only 10 degrees
  of wobble. It now allows 17 degrees and stays quiet for the first 2.5 s while the player gets into position.
- **A blur that never switched off.** The paddle's motion blur was first triggered by how fast the paddle tip moved
  through the court, which also happens when the camera-tracked body moves or the footwork carries the player. It is
  now tied to the swing event itself and its brightness follows how hard the swing is.

## 14. Hosting, and playing over a bad connection
- **Hosted on fly.io** at `https://poddleball.com` (the fly app is `poddle`; `poddle.fly.dev` and `www.` redirect to it; `fly deploy --ha=false`). `server/game.js` now also serves `web/` on
  its own port, so the hosted game is one process behind one address; a page that did not come from localhost takes its
  game socket from the address it was loaded from. `bridge/` and `motion/` still run on each player's Mac. There must be
  exactly one machine: the match lives in that process's memory.
- **"Why is it so laggy?" It was the wifi, not the host.** Measured on the fly machine itself the server ticks at 60.4/s
  with a worst gap of 21 ms. From the laptop, pings to its *own router* took 10-250 ms (at one point 700-2100 ms) with
  packets lost, while the laptop moved 0.1 Mbps. A WebSocket is TCP: one lost packet holds up everything behind it, then
  the backlog lands in a burst. The old client treated each packet as fresh on arrival and only carried the ball 100 ms
  past the last one, so the ball froze, jumped back, then leapt forward.
- **The ball now rides out gaps.** The server still owns the ball, every hit and every point. Between hits a ball is pure
  physics, so the client carries it forward itself (`coast()` in `web/scene.js`: spin-lightened gravity, the first bounce
  with its spin and kick) for up to 0.6 s without news. `node test/coast.test.mjs`: 42,432 predictions against the
  server's own stepping, worst error 5 cm.
- **Packets are aged by the server's clock, not by arrival.** The least-delayed packet of the last couple of seconds sets
  the offset between the two clocks; a packet that sat 80 ms in a retry is drawn as 80 ms old instead of pulling a fast
  ball a metre backwards.
- **It will not fly through the other player.** With no news and the ball arriving at the far paddle, the likeliest truth
  is that they are hitting it, so the ball waits there for the packet (`coastTo()`).
- **Swings are back-dated by the round trip** as well as by the sensor's lateness (the client pings the server twice a
  second and sends its quietest recent round trip with each swing; still capped by `LAG_MAX`).
- **A struggling link gets 30 state packets a second instead of 60** (the client asks; fewer packets, fewer stalls; with
  the ball coasting there is nothing to see), state is never queued behind a stalled socket, and the player gets one
  "Weak connection" toast. **H** shows ping, connection quality and the packet rate.
- **Reconnecting.** Each tab carries an id. A tab that reconnects while its old socket is still half-open gets its seat
  back instead of being matched against its own ghost, and behind the proxy the player's real address comes from the
  `Fly-Client-IP` header (before, every hosted player looked like the same machine).
- **How it was measured.** `node test/badwifi.mjs` plays the same 180 s rally through a modelled lossy link into the old
  and the new client logic. On a link like the one measured (4 % loss, 100-350 ms stalls), for the ball coming at the
  player: p95 error 223 cm -> 15 cm (6 cm at 30 Hz), frames frozen 2649 -> 0, backward jumps 322 -> 0. What is left is a
  hit by the other player that has not been heard about yet; nothing can predict that.

## 15. Rooms, a main menu, and a copy pass
- **Rooms** (`docs/ROOMS.md`). One process now hosts many matches. Everything that was one global game (players, ball,
  score, bot, serve state, ball history) lives in a `createRoom()` closure; a thin lobby layer seats sockets (quick play,
  create public or private, join by 4-character code, shareable `?room=CODE`), one 60 Hz loop steps every room, empty
  rooms close after 30 s, 40 rooms at most. A socket without `lobby=1` still lands in the old single game (`LOCAL`), so
  every older test runs unchanged.
- **Menu.** Title with one Play button (a swing still starts it), then the lobby: Quick play, Create room, Enter code and
  the list of open rooms, over the live court blurred behind glass.
- **Attacked before it shipped.** A second agent was told to break the server and found three ways for ONE client to kill
  the process, and with it every room: a deeply nested array as a join code, a deeply nested `ping` value (both blow the
  stack in JSON), and `GET /%00`. Two of those were already live in the single-game server. Fixed: strings only, numbers
  only, a 4 KB message cap, the whole message handler in a try/catch, 400 for a bad path, an error handler on the file
  stream. `test/rooms.test.mjs` has a hostile-input section.
- **Points scored against someone still calibrating.** A match started the moment the second human was seated. The serve
  now waits until every human has sent a paddle; the other player sees "Setting up".
- **Copy.** One pass over everything a player reads: no em dashes, one word per thing (AirPod, never bud or pod), nothing
  said twice, online players are told to start the bridge, the server-down card gives hosted and LAN players different advice.
- **Tests.** `test/rooms.test.mjs` (protocol, isolation between rooms, 60 packets/s in each of 10 rooms), `test/menu.mjs`
  (91 UI checks against a fake lobby), `test/rooms-e2e.mjs` (two real browsers, create, join by code, calibrate, rally, leave).

## 16. Scenery: everything beyond the fences (`web/scenery/`, `docs/SCENERY.md`)
- **Brief:** "a more authentic LA scene, palm trees, some wind breeze lines, nice sky". Westside rec park at 3:30 pm: hills and
  downtown north, a palm-lined stucco street east, lawn, sand, Pacific and a pier wheel west. All geometry and canvas, no assets.
- **Gotcha:** the play camera's top of frame is 8.8 degrees up, so a 16 m palm crown only enters the shot beyond ~120 m. Near
  rows read as trunks. What the player sees is a hazed skyline row 150-185 m out and the corner date palms; near crowns are
  for the menu.
- The ball shows a different face to each end: lit looking north, shaded looking south. One sky colour measured 1.04 : 1
  against it. Fix: deep blue low sky everywhere except within 40 degrees of due south, which is milky. Now 1.3-1.4 north, 2.1-2.2 south.
- Clouds lift 86 m over the play axis; a 40 m lift left cream cloud bases in the ball band 31-41 % of the time. Now 0 %.
- Breeze lines may not enter 22 degrees either side of the play axis, so they fly 55-105 m out, across the view,
  streak-curl-streak; the loop drifts downwind or it reads as a loading spinner.
- Ground overlay z-fought with itself (layers 1.5 cm apart in one mesh). Fix: write no depth, order the index buffer by layer.
- Arrival hitched 125 ms. Fix: one module per task, hidden, `compileAsync`, then swap old look for new in a single frame.
- Budget: 21 draws / 62k triangles / 1 MB (low: 14 / 32k / 0.5 MB), +0.3 ms GPU at 2560x1440 on an M4. `?q=low|high` overrides.
- Still open: the play view shows ~6 degrees of sky. A menu camera (eye 3.4 m, level gaze, fov 60) is where this pays off.

## 17. Spectators, rematch, seat hold, pause, names, Matt, and a menu that plays itself (`docs/NEXT.md`, `docs/SPECTATE.md`, `docs/API-NEXT.md`)
- **How it was built.** A contract first (`docs/API-NEXT.md`: every function name, id, string and message), then four owners in
  parallel who never saw each other's code (server, scene, UI, main), then one integrator who ran it together. The contract held:
  in the first merged run of three real browsers every flow worked; what failed first was the new test itself.
- **What the merge did find.** (1) On resume from a pause the ball flicked 3 m forward and back for ONE frame. Every paused packet is
  dated by the server clock to when the pause began, so the frame drawn between "un-freeze" and the next packet coasted the ball
  by the length of the pause (capped). The scene's own test could not see it: there a packet arrives with every frame. Fix:
  `setFrozen(false)` restarts the ball's stamp as well as the clock. Found by sampling the drawn ball every frame for 0.5 s after
  Esc in `test/spectate-e2e.mjs`. (2) A result card left after a forfeit offered Rematch to nobody: it is disabled now, focus goes to
  Leave. (3) The hold card sat on the very character it was about; it moved below the net so the pale player and the tag show.
- **Shots (from 143 recorded swings, `node test/kinds.mjs`).** A smash is earned (overhead bonus only on a real stroke, threshold
  0.76) and rewarded (up to 0.07 s less flight): 16 % -> 11 %. Lobs are meant (a curved swing is not an underhand): powered lobs
  3 -> 1. Spin is continuous, every hit carries its own amount: 76 % of real strokes used to get exactly zero, now 5 %, and 27 %
  read as a slice (> 0.5), the player's number. The serve ignores the wind-up (a lone middling swing is held 0.7 s for the real stroke).
- **Spectators.** Up to 8 a court, never seated, never counted. A full court asks "Court is full. Watch instead?"; public courts in
  play are listed with their score and a Watch button. Four views: broadcast (default, side 0 on the left like the scoreboard),
  split (one scene, two scissored viewports, each dressed as that player sees it), either player's view, a free orbit camera.
- **Match end.** No more auto-restart: `matchover`, both vote, yes + yes = a new match with the spectators still there, anything else
  = `closed` and everyone (spectators too) lands in the lobby. **Seat hold:** a socket that closes without `leave` mid-match keeps
  its seat 15 s, room time stops, the point is replayed on return, a forfeit otherwise. `leave` mid-match is a forfeit at once.
- **Pause.** The hamburger (or Esc) opens Settings; against Matt that pauses the room (room time is per room now, the ball hangs,
  the court blurs), against a person it cannot ("Online games can’t pause") and the rally goes on behind the card.
- **Names.** Asked once, kept in `poddle.name`, cleaned by the server, used wherever the game says who did something. The bot is Matt
  (bald, orange shirt) at every level; his level is the line under his name.
- **Seat status (14a).** `state.paddles[n].status` = calibrating | paused | away. That character and its paddle ease to a pale ghost
  (the same materials lerped to white and half see-through, one tween value per pad) under a billboard tag: one sprite per pad,
  `sizeAttenuation` off, so its size is set in pixels through the projection's own terms and each split half faces its own camera.
  While someone calibrates mid-match the rally in flight plays on and the NEXT serve waits.
- **The menu.** An endless client-side rally (Matt and a generic player, every shot solved to land in) behind the glass, at half
  pixel ratio and 30 fps with the shadow map frozen; nothing of a real game can reach a menu (`seated()` / `live()` in main.js).
- **Say court, not room (14c).** Everything a person reads or types. The page link is `?court=CODE`; `?room=` still works and is
  rewritten. The wire protocol keeps `room`. **Movement style left the court (14d):** M is gone, Move is a row in Settings; the second
  key hint is `1 2 3 Difficulty: Club`, only against Matt.
- **Tests.** `test/spectate-e2e.mjs` (three Chromes, 113 checks: every flow above end to end, screenshots `test/ui-shots/next-*`),
  `test/rooms.test.mjs` (protocol: 155 checks, seat status and hostile input among them), `test/menu.mjs` (real page + main.js against
  recording stubs), `test/ui-next.mjs`, `test/scene-next.mjs`. `test/rooms-e2e.mjs` and `test/e2e.mjs` were moved to the new rules
  (a reload mid-match is a hold, a leave is a forfeit, a full court stays listed).
- **Known rough edges.** The shaded ball against the milky south sky from side 1 is 1.55 : 1 (target 1.6). The free camera can
  still fly into a palm or a lamp head. Pinch zoom is not implemented. `test/server.test.mjs` still fails its stale scripted
  scenarios (sections 11-12); its solve() sweep is clean. The movement-mode bug of `docs/NEXT.md` 14f is not fixed here, only
  narrowed: every mode switch now restarts that mode's state in one place (`setMode`).


## 19. Being found: the share card, the words for crawlers, a How to play page
- **The problem.** The site is a canvas. A crawler that does not run scripts saw an empty page with the title "Poddle", a link
  pasted in a chat unfurled as nothing, and the tab had no icon.
- **The share card** (`web/og.jpg`, 1200x630, 106 KB) is rendered from the real game, not drawn: `node test/make-og.mjs` opens the
  real scene, composes the wordmark, a player mid-swing, Matt, the ball in flight, the AirPod tile and the tagline, and writes the
  card plus every icon (favicon.svg/.ico/32, apple-touch 180, 192, 512). A reviewer mocked it in iMessage, Discord, X, Slack and
  WhatsApp: the first card had no AirPod in it and the X title label covered the tagline. Both fixed by the layout.
- **The words.** Title "Poddle: pickleball you play with an AirPod"; a description that says friends, AirPod, Matt, watching, and
  Mac + Chrome; Open Graph and Twitter tags with absolute URLs; VideoGame/WebApplication JSON-LD; a `<noscript>` block that says
  what the game is; one `<h1>` (the static HTML had four, one of them "You win!").
- **A page with real text**, `web/how-to-play.html`: what you need, set up for someone who has never opened Terminal, friends, Matt,
  watching, an FAQ with matching FAQPage data. Works with JavaScript off, and tells a phone or Windows visitor early that they can
  watch but need a Mac to play. The title screen links to it.
- **Compatibility, checked against Apple:** CMHeadphoneMotionManager is macOS 14.0+; Safari blocks an https page from reaching
  `ws://localhost`, Chrome allows it (and since Chrome 147 asks for local network access: the set-up steps say to press Allow).
- **Crawl files and server:** robots.txt, sitemap.xml, site.webmanifest, a real 404 page and status, clean `/how-to-play`, content
  types and cache lifetimes for the new files, invitation links (`?court=CODE`) kept out of indexes. `node test/seo.test.mjs` checks
  all of it over plain HTTP, including the JPEG's real dimensions.
- **Only the owner can do:** verify in Google Search Console (HTML tag method, fly.dev has no DNS to edit) and submit the sitemap,
  import into Bing Webmaster Tools, re-scrape in the Facebook/LinkedIn debuggers.

## 20. "Sometimes the court just closes and dies, kicking everyone out"
- **It was not fly being flaky.** Three causes, found in the machine events and logs:
  1. **Every deploy killed every court.** Courts live in one process's memory. A deploy replaces the process; each open tab
     reconnected within a second and asked for its court by code; the new process had never heard of it and answered
     `notfound`; the client showed "Court closed" and sent everyone to the lobby. There were 17 deploys in 18 hours.
  2. **A second machine.** One had been added in Dallas "in case of US players". Two machines cannot see each other's courts,
     so friends could land on different servers ("Court not found"), a reconnect could land on the other one, and fly's proxy
     autostopped whichever looked idle (`App poddle has excess capacity, autostopping machine`), taking its courts with it.
  3. By design: a player gone for more than 15 s forfeits, and with no rematch the court closes for everyone.
- **Courts now survive a restart.** On SIGINT/SIGTERM the server tells every tab `restart` ("Updating. Back in a moment.",
  and the server-down card is held back for 15 s). A reconnecting tab reports what it was in: `back=1`, its seat, the
  score, public or private, Matt's level. For its first 120 s a new process takes that word: the first tab back rebuilds the
  court under the same code with that score, the rest find it standing and take their own seats; spectators too. Only
  the point in play is lost. A typed code that does not exist is still `notfound`; a finished score is not restored; the
  court cap still applies. `test/revive.test.mjs` (protocol) and `test/revive-e2e.mjs` (two real tabs, server killed under them).
- **One machine, enforced.** `./deploy.sh` tests, shows who is online (`/status.json`), deploys, and removes any machine
  beyond the one in `yyz`. Serving US players from Toronto costs ~40 ms; a second region would need shared court state first.
- **Courts say why they closed** in the server log (`[CODE] court closed: norematch ...`), so the next report can be answered
  from `fly logs`.
- A test race I introduced and removed: the shutdown notice waited 250 ms before exiting, and a test that restarts a server
  on the same port found it taken. 50 ms is enough (the kernel sends what was queued).

## 21. "The ball spin indicator is perpendicular to the player"
- The three spin streaks whipped around the ball's true spin axis (horizontal, across the flight), so their ring lay in the
  plane of flight: from behind the baseline, where every player stands, it was edge-on and read as a thin line or nothing.
- Turned 90 degrees: the ring's normal is now the line of flight, so it faces the player the ball is coming to (and the one
  it left). Same streaks, same speed and colour. Checked with a before/after render of a full-spin ball from the player's camera.

## 22. "The score card's inner corners are sharp; make it hug the rally box"
- The tabs asked for 1rem corners beside the rally, but their round ends were `--r-pill` (999px). When two radii on one edge
  add up to more than the box, CSS shrinks every radius on it by the same factor, so the 1rem corners came out at ~1px: square.
- The ends are now half the tab's height (2.125rem, the same semicircle), so the inner corners keep their full 1rem and follow
  the rally lozenge's own curve across the .375rem gap. Checked by rendering the board at 1440 and 800 px wide.

## 23. Spin streaks are a billboard (supersedes 21)
- Facing the line of flight (21) only worked for a camera looking down that line: side-on (broadcast, free cam, a cross-court
  ball) the ring went thin again. Each arc now faces whichever camera is drawing it, set in its `onBeforeRender` (split view
  draws the frame from two cameras, so one shared rotation would be wrong for one of them). Checked from the player's view,
  broadcast and both halves of split.

## 24. "Your serve!"
- The serve prompt was "Your serve. Swing to hit it." Everyone knows how to serve. The hints after a missed serve
  ("Line up with the ball, then swing", "Swing through the ball to serve") stay: they only show when it went wrong.

## 25. Spectator emotes
- "Can we add a spectator emote system? Apple emojis 🤣🥵😡🤯💀🥀😢🫡, happy to sad, pop up from the side, 5 s cooldown."
- Spectators get a row of eight bottom-right (where a player's key hints sit; above the view chips on a phone), ordered
  🤣 🫡 🥵 🤯 😡 💀 🥀 😢. The images are Apple's, 160 px PNGs from iamcal/emoji-data in `web/emoji/`, so a Windows or
  Android spectator sees the same faces. The list is `EMOTES` in ui.js; its index is the wire value.
- `{type:'emote', e}` from a spectator only; the server checks the index and a 5 s gap per socket (4.8 s, slack for the
  wire) and broadcasts `{type:'emote', e, name}` to the whole court, sender included. Players can't send one.
- Each one slides in from the right edge at a random height in the middle band with the sender's name, drifts up and
  fades (3.2 s, six on screen at most). After a pick the row greys out and a bar under it runs down the 5 s.
- `node test/emote.test.mjs`: relay, names, cooldown per spectator, bad indexes, players ignored, courts kept apart.

## 26. Emotes stream up like a live stream (supersedes the pop in 25)
- "Make the emojis stream in from the bottom right corner and float up, like TikTok / Facebook / Instagram lives."
- Each reaction is born just above the emote row, swells in, then floats up about half the screen height, swaying side to
  side, and fades. ui.js gives each its own start offset, sway and duration (3.2-4.4 s) so a burst spreads into a stream
  instead of a stack. Eight on screen at most. Reduced motion: no rise or sway, just a fade in the corner.

## 27. A watch link says so before you join
- "If you're joining as a spectator, it will say that in the menu screen before u actually join. 'Joining as spectator'"
- A `?court=CODE&watch=1` link: the title chip reads "Joining court CODE as spectator". With no name yet the link stops
  on the code screen, which is now titled "Joining as spectator" with a Watch button, and pressing it watches. Before,
  that button sent a plain join and could seat the spectator as a player.

## 28. A serve cue of its own: gold chevrons round the hanging ball
- "The serve indicator on the ball is the same as the spin indicator, which is confusing. Maybe an array of chevron arrows
  pointing around the ball?"
- There was no serve indicator: the server never cleared the last rally's spin when it reset for a serve, so the hanging
  ball (which drifts after the server's hand) wore the spin streaks. reset() now zeroes `ball.spin`, and the client ignores
  spin while the ball is held.
- The hanging ball now gets eight gold chevrons chasing round it, billboarded like the streaks, fading in over 0.25 s and
  out almost at once when it is struck. They grow up to 1.8x with distance so the opponent's serve reads from the far
  baseline. Checked by rendering my serve, their serve and a close-up.

## 29. Copy link drops down: player link or viewer link
- "Make the copy link button have two options when you hover over it and it drops down: copy the player link / viewer link"
- On the court-code screen, hovering Copy link (or tapping it, or tabbing to it) drops a small card: **Player link**
  (`?court=CODE`, joins to play) and **Viewer link** (`&watch=1`, opens as a spectator, see 27). Picking one copies it
  and the button says Copied for 1.5 s. Arrow keys move between the two, Esc closes. The HUD room pill still copies the
  player link. Checked by rendering at 1280 and 600 px wide and reading the clipboard after each pick.

## 30. No salute emote
- "Get rid of the salute emoji in the spectators." Seven now: 🤣 🥵 🤯 😡 💀 🥀 😢. The wire index shifts down by one
  after 🤣 (server EMOTES = 7); `web/emoji/1fae1.png` is gone.

## 31. The logo is all one dark
- "Change the Poddle logo to not be light blue, it doesn't work on the sky blue background; make it all the dark blue
  of 'Pod'." The "dle" is now #39434d like "P" and "d", on the title and on how-to-play. Checked with a render of the title.

## 32. Serve chevrons point in and breathe (supersedes the look in 28)
- "Make the arrows pulse in and out, and they should be pointing in, not spinning in a circle. Also a nicer colour."
- The eight chevrons now sit on spokes with their tips toward the ball and do not turn. They slide in toward it and back
  out 1.2 times a second (radius 3.1 to 2.2 ball radii, brightest when closest); the vertices move along the spokes, so the
  chevrons keep their size. Coral pink (#ff5c8a) instead of gold: no court colour, the yellow ball or the icy spin streaks
  share it. Checked with renders of my serve, their serve and a close-up.

## 33. Aim is gone: Body or Auto
- "Completely remove the move-wrist-to-aim system, it's broken and useless; we only use Body and Auto."
- The Move row is Body / Auto. No camera (or `?cam=0`, or the camera failing) now falls back to Auto, not Aim, and the
  camera card says "No camera. The game moves you." The paddle's position only ever comes from Body (the camera) or the
  server running you (Auto); the wrist's yaw never moves you. Range ([ ] and the panel's - / +) is Body's step reach
  only; the old sideline-angle range (`sideDeg`) is dropped from the saved settings. motion.js still works out its yaw
  point internally: the swing's base lock needs it.

## 34. Your phone is the paddle: nothing to install
- "Find a way to make this webapp game a visit-and-play. I don't want users having to open up their terminal to install
  shit before they play. Destroys UX."
- The AirPod needed a Swift helper and a Node bridge on every player's Mac, because a web page cannot read AirPod motion.
  A phone's browser CAN read its own motion sensors (deviceorientation + devicemotion) over https, so the phone is the
  paddle now and the helper is optional.
- Flow: the set-up screen ("Grab your paddle") shows a QR code for `poddleball.com/pad.html?k=CODE`. Scan it, tap Start
  (iPhone asks to allow motion), and the game starts calibrating by itself. No camera? `poddleball.com/pad` and type the
  6 characters. The code is made by the tab (sessionStorage), so a reload or a deploy pairs the two up again unaided.
- `web/padmotion.js` turns the events into the exact `{t, q, r, a}` sample the AirPod bridge sends, so MotionModel,
  swing detection and calibration are untouched. Browsers disagree on which of rotationRate's alpha/beta/gamma is which
  axis; it is not guessed: the naming whose rates agree with how the orientation actually turned wins (and locks).
- The game server relays: the phone's socket (`?padfor=CODE`) is in no lobby and no room and is not counted online; each
  valid sample is rebuilt and passed to the tab that named the code (`?pad=CODE`). The tab sends back `padfx` so the phone
  buzzes on your hits (Android) and says which step you are on. Calibrate again / Re-center on the phone are press-and-hold,
  because a gripped phone gets its screen touched all rally.
- Phones are heavier and swung slower than an AirPod, so their swing power is scaled by 1.5 (`?padgain=` to try others).
  This number is a first guess, not measured on a real phone yet.
- AirPods still work: "Playing with an AirPod?" at the bottom of the set-up screen (remembered). Hosted, the page no longer
  opens `ws://localhost:8787` for a first-time visitor, so Chrome's "devices on your local network" prompt only appears for
  AirPod players. Someone who played before this (a name saved, no choice made) sees the QR too, but their helper is tried
  quietly behind it: the first AirPod sample makes the AirPod the paddle, with no click.
- Copy: title, meta, share card text, noscript and how-to-play are phone-first; the AirPod set-up is its own section.
- Tests: `test/padmotion.test.mjs` (maths, both namings, MotionModel calibrates and swings on phone samples),
  `test/pad.test.mjs` (relay, isolation, hostile input, reconnects either order, 60 Hz within the budget),
  `test/pad-e2e.mjs` (a first visit never touches localhost; game in one Chrome, pad.html in another fed synthetic sensor events: QR, calibrate, rally, the
  phone page closing and coming back, a typed code, a device with no sensors).

## 35. The phone paddle stops jittering
- "The movement is very buggy with the phone, it jitters u around."
- Measured with `test/phone-jitter.mjs`, which plays a phone the way a browser really reports one: deviceorientation and
  devicemotion at 60 Hz each on their own clocks (different sensors, never in step), Chrome's 0.1 deg rounding, a quiet
  network and phone wifi (power save holds packets for 40-220 ms and lets them go in a burst). Roughness at 120 Hz is
  test/jitter.mjs's measure; the AirPod gets about 9 %.
- Cause 1, the sensors out of step: each sample paired the newest rate with whatever orientation came last, 0 to 16 ms
  older, by a different amount every time, so the pose wobbled whenever the phone moved (4 to 21 % depending on how the two
  clocks happened to line up). `padmotion.js` now carries the orientation forward to the rate's own moment with that rate
  (at most 50 ms). Quiet network: 4 % on every phase.
- Cause 2, the network: samples now cross the internet twice (phone -> fly -> tab), and phone wifi arrives in bursts longer
  than the replay's 120 ms buffer, so the paddle froze and then jumped (13 to 39 %). A phone's buffer may now grow to 200 ms
  (`PHONE_BUFFER` in main.js; the AirPod keeps 120). It only grows when late packets are actually seen, so a good connection
  still renders 25 ms behind. Only the picture waits: swings are still called the moment a sample arrives. Bursty wifi: 5 to 11 %.
- Cause 3, a risk rather than a measurement: before its rotationRate naming was locked, `PadMotion` re-picked naming and sign
  on every sample from near-zero evidence, which could turn the rate inside out from one sample to the next. It now starts
  from what the browser is known to say (the spec's z,x,y on Chrome and Firefox, x,y,z on Safari) and changes only once, on
  strong evidence (one real swing is plenty).
- The wifi model is a guess at real phone wifi. If it still stutters on a real phone, record what arrives and tune from that.

## 36. Poddle Helper: the AirPod without Terminal
- "could you add a quick setup? like something that you can just install to get everything going, instead of opening
  terminal as that's incredibly sus ... make a public repo separate from the entire poddle repo with this package for users
  to download so we can keep it public and open source for them to see, and mention that as well."
- The AirPod used to mean Terminal: Xcode tools, Node, clone this repo, `npm install && bash motion/build.sh`, then
  `node bridge/bridge.js` left running. That is replaced by **Poddle Helper**, a native Mac menu-bar app in its own public
  repo, `github.com/danielrltan/poddle-helper`. It speaks to the page the same way the bridge did (127.0.0.1:8787), so
  nothing in the game changed.
- The download is ours: `/download/Poddle-Helper.zip` on poddleball.com (the built zip is dropped into `web/download/`).
  `server/game.js` serves `.zip` as `application/zip`, and anything under `/download/` as an attachment with
  `Cache-Control: no-cache`, so a new build reaches people at once. The GitHub link sits next to every download button as
  "open source, see what it does", not as the place to get it.
- Set-up screen, AirPod mode: where the phone's QR would be, a card "Get Poddle Helper" with three steps (Download and open
  Poddle Helper, Connect your AirPods to this Mac, Take one AirPod out and hold it), a Download for Mac button, and one line:
  "Open source. Reads only your AirPod's motion and sends it only to this page, on this Mac." with "See what it does".
  It hides once the AirPod answers, and it never shows in phone mode. `ui.padPair` shows it from the paddle kind that
  `setPaddle` was just given; main.js only changed the footer's words to "Still waiting? Open Poddle Helper on this Mac." The AirPod row now says "Open Poddle Helper, then take one AirPod
  out and hold it." and, when the signal drops, to check Poddle Helper is open.
- How to play: the AirPod section is the download, the first-open warning (Privacy & Security, Open Anyway; right-click,
  Open on macOS 14), Motion & Fitness, AirPods as the sound output, Automatic Ear Detection off, then Playing with an
  AirPod?. A "What Poddle Helper does" part says what it reads, where it sends it, that it is open source, and how to quit
  and remove it. The Terminal steps are gone; one line points to GitHub for anyone who wants to build it. The FAQ (page and
  JSON-LD, same words) says Poddle Helper, and gains "Is Poddle Helper safe?". The home page's `browserRequirements` says
  "the free Poddle Helper app". README leads with the app; the Node bridge stays, marked for development.
- Tests: `test/seo.test.mjs` checks the download's headers once the zip exists, and waits (not fails) on it until then.
  `test/pad-e2e.mjs` checks the card and its download link show after "Playing with an AirPod?" and hide in phone mode,
  and screenshots AirPod mode at 1280x720 and 600x900.

## 37. Phone or AirPod is a choice you can see, and the phone gets its own drawings
- "Make the phone mode more accessible. In the connecting screen, have that as a visible mode to select from instead of
  hiding it as a hyperlink at the bottom. And if you're using a phone, make the connection diagrams different and display
  that rather than an AirPod in the hand."
- The set-up screen opens with a big **Phone | AirPod** switch (icons, the same `.seg` as elsewhere) where the title was;
  the footer link is gone. It only shows where a phone can pair (the https site). Picking one is remembered, as before.
  Arrow keys move between the two. Taking the title's place keeps the AirPod card inside 1280x720 with room to spare.
- With a phone: calibration draws the fist round a phone, top end toward the screen, in both poses (the drawing's
  parts pick themselves through `--pod` / `--phone` custom properties, which reach inside the SVG `<use>` copies); the
  corner 3D view is a phone (rounded slab, dark glass, camera bump; `podview.setKind`); the settings row says Show phone.
- The words and drawings follow the choice; a phone page that is still open and sends motion makes the phone the choice.
- Also fixed: a comment in 35's main.js change had swallowed the rest of its line, so a returning AirPod player's choice
  was not saved and the screen did not refresh when the paddle changed hands.
- `test/pad-e2e.mjs` presses the switch (and an arrow key), checks the drawing, the Show phone label and the helper card.

## 38. Hold the phone edge up
- "It makes most sense to hold your phone with the edges up rather than screen up. Can you adjust the calibration for
  that? Tell users to hold side up."
- The calibration itself needed no change: the hold and the tip teach the game whatever grip you use (test/phone-jitter.mjs
  now also plays an edge-up grip, top end toward the screen, and it calibrates and tracks like any other: 4 % rough on a
  quiet network, 8 % on bursty wifi, and 5 % tipped to 88 deg, so the browser's angle rounding near vertical costs little).
  (An exactly vertical synthetic phone looked bad, 47 %: that was the test's own angle extraction at precisely 90.000 deg,
  which a real sensor never reports; 0.1 deg off it is exact.)
- What changed is what we tell people: "edge up" in the calibration lead, the QR card, the phone's Start screen (with its
  own side-view drawing and an "edge up" arrow), the calibration drawing (an EDGE UP label, phone mode only) and how to
  play. The corner 3D phone is turned so its screen faces sideways, as it does in an edge-up hand.

## 39. The phone page is dark
- "Can you make the Poddle phone webapp dark mode? So that it's not distracting when you're swinging."
- pad.html is always dark (not only when the phone is set to dark): near-black background, dim text, dark buttons, the
  swing ring and link colours toned down, the drawing recoloured, theme-color and color-scheme dark so the browser bars
  match. The flash on a hit is a dim olive instead of a bright yellow. The game on the computer is unchanged.

## 40. Serving is forgiving: a light swing serves, and a real stroke serves at once
- "Serving needs to be more forgiving; sometimes I am swinging lightly at the ball and nothing happens, this 'swing through'
  thing is annoying. Make it responsive but not stubborn."
- Why nothing happened: a serve needed a settled power of 11, and power is scored by arm travel (nothing below 35 deg, full
  at 110), so a gentle 60 deg underhand swing peaking at 10 rad/s scored about 6, the floor every swing gets. Why it lagged:
  anything under 17 was held 0.7 s in case it was the wind-up.
- A serve now has its own, gentler measure: the larger of the rally power and the swing's raw peak rate, with full credit
  from 45 deg of travel (none below 15). It needs 7. A 12 deg flick still does nothing.
- motion.js now reports, with every swing, how far from the resting aim the hand was when the movement began (`off`, deg)
  and whether the swing is heading back toward it (`back`, -1..1). A wind-up leaves the resting aim; the stroke comes back
  through the ball. A swing that started 20+ deg off and heads back (0.3+) serves on its FIRST report; its settled report
  re-aims the ball like any hit. So wind-up then stroke is instant, however lightly the stroke is swung.
- A swing from rest may still be the wind-up, so it waits: 0.7 s if it is weak (under 10), 0.4 s if firmer, and 15+ goes at
  once (was 17). The stroke after a wind-up usually comes back through the ball and replaces the held one immediately.
- The hint after a while without a serve says "Swing at the ball to serve" (was "Swing through the ball to serve").
- `test/serve.test.mjs` follows the new rules and checks a gentle serve from rest, a gentle swing back through the ball
  (instant), and wind-up away then a light stroke back through (one serve, at once, where the stroke aimed). Its myServe()
  now makes sure the serve is really there: an instant serve could leave a stale 'serving' state and start the next check early.

## 41. Swap the phone for an AirPod at any time; the court pill drops down to an invite
- "Once you choose to use phone as paddle, there doesn't seem to be any way to change to an AirPod after... add that. Also
  for the copy court link button, make it so when you hover over it, it drops down, and then you can copy the spectator link
  or playing link. When you copy it it'll come with a message like play against me in Poddle using an AirPod or watch me play."
- Settings has a **Paddle: Phone | AirPod** row wherever a phone can be the paddle (hidden for spectators). Picking the other
  one mid-game goes back to the set-up screen (the QR, or the Poddle Helper card) and calibrates the new paddle once it
  answers; the other player sees you calibrating, as usual. The set-up screen's switch does the same (main.js pickPaddle).
- A picked AirPod stays the paddle: a phone page left open used to take over again with its next sample; now it only does
  that when nobody chose on purpose this visit. The phone's page is told to stand down (idle) when the AirPod takes over.
- The HUD's **Court XXXX** pill is a drop-down like the share screen's Copy link: hover (or tap) for Player link / Viewer
  link. Where there is no shareable link (localhost) it stays a plain label. Below 900 px wide it loses its caret so it
  keeps its width beside the board.
- Both copy menus put a line in front of the link: "Play against me in Poddle! Pickleball you swing with your phone or an
  AirPod: <link>" and "Watch me play Poddle, pickleball with a phone or an AirPod as the paddle: <link>&watch=1". The toast
  says Invite copied / Viewer link copied.
- `test/pad-e2e.mjs` step 4b: mid-game, Settings -> AirPod goes to the set-up screen with the helper card and stays there
  while the phone keeps swinging; Phone on the switch calibrates on the phone again.
