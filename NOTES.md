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

## 42. Cancel a paddle swap; the court pill's menu opens over the scoreboard
- "Part of the copy link menu clips into the score banner at the top. And also, there is no cancel button to cancel changing
  your remote type, only a back button which just kicks you. Fix that."
- While the HUD's court menu is hovered, open or focused, the corner is raised above the scoreboard (z-hud + 4), so its
  Player link / Viewer link card is drawn on top of the board instead of under it.
- A swap made mid-game (Settings -> Paddle) can be undone until the new paddle has calibrated: the set-up and calibration
  screens' Back reads **Cancel**, and it (or Esc, or pressing the old paddle on the set-up switch) puts the old paddle back.
  If the new paddle never started calibrating, the old calibration is untouched and it is straight back to the court;
  otherwise the old paddle calibrates again. Back never leaves the court during a swap. Once the new paddle is calibrated,
  or you leave the court, Back is Back again (main.js undo / cancelSwap, ui.backLabel).
- `test/pad-e2e.mjs` 4b: Cancel reads Cancel, returns to the court still calibrated on the phone, then Back is Back; the
  set-up switch back to Phone does the same.

## 43. The calibration drawing shows the phone's back, not a thin bar
- "Can you make the phone diagram calibration better? Why is it so compressed? Make it so the back of the phone is facing
  the diagram, so you can see like an iPhone 17 camera pointing towards it, the entire back of the phone since you're
  supposed to hold it sides up."
- Held edge up, the side view looks straight at the phone's broad face, so the drawing now shows the whole back (202 x 92,
  about a real phone's proportions) instead of the edge-on 206 x 46 slab. The camera bar runs across the top end, the one
  pointing at the screen: three lenses in a triangle, a flash and a sensor dot, like an iPhone 17 Pro. The fist grips the
  bottom end; the "Edge up" arrow moved above the taller phone. Both poses (hold, tip up) use it; the AirPod drawing is unchanged.

## 44. The phone's own Start screen gets the new drawing; the lenses sit where an iPhone 17 Pro's do
- "The diagram is not updated on the phone itself. Also the lenses on the phone are arranged wrong: the two circles should
  be at the end of the back plate of the camera."
- The camera bar now runs the phone's full width across the top end. Held edge up and seen from the side, the three lenses
  make their triangle at one end of it (two side by side along the phone, the third below between them) and the flash and
  the sensor dot sit together at the far end, as on the real phone.
- pad.html's Start screen draws the same back of the phone (camera bar, lenses, flash) instead of the old edge-on slab,
  in its dark colours (pad.css .cam-*); the "edge up" arrow moved above the taller phone.

## 45. The words say any computer and any phone; the AirPod is an extra, not the point
- "Can you update the copy writing to reflect that this can work on non-iOS devices, phone is required if so? Remove any
  text that implies exclusivity for Mac and AirPod / iOS devices."
- Title, meta and share-card text lead with the phone: "Poddle | Pickleball You Swing With Your Phone", "Poddle: Pickleball
  You Play With Your Phone", "Any computer, any phone, nothing to install". The title screen's tag is "Phone pickleball"
  (was AirPod pickleball); its footer "Any computer, any phone, nothing to install: scan a code and your phone is the paddle"
  (the "AirPods work too, on a Mac" line is gone from it). JSON-LD, noscript, manifest and README say Windows, macOS,
  ChromeOS or Linux, with an iPhone or an Android phone; the AirPod stays, clearly as the Mac-only option.
- How to play: What you need names Windows, Mac, Chromebook, Linux or iPad and iPhone or Android; the platform FAQ adds
  Linux and says only the AirPod option needs a Mac. The AirPod section itself still says it needs a Mac, because it does.
- The share image's line is now "Play pickleball with your phone!" (og.jpg regenerated, ?v=4). The copied invites say
  "on any computer" instead of "or an AirPod". The non-https fallback no longer says "Poddle plays on a Mac".
- `test/seo.test.mjs` now checks for the phone (and no AirPod in the titles) where it used to require AirPod.

## 46. Spectator emotes have no cooldown; the share card says phone or AirPod
- "For the emotes as spectator, remove the cool down." The 5 s wait, the disabled buttons and the bar that ran it down are
  gone: tap as fast as you like. The server keeps only a 60 ms per-socket floor (EMOTE_GAP), faster than anyone taps, so a
  script cannot flood a court; the pops on screen were already capped at eight. `test/emote.test.mjs` checks a second emote
  a moment later arrives and a burst of 30 at once is dropped.
- "For the share image you can make it say play pickleball with your phone or AirPod." og.jpg regenerated with
  "Play pickleball with your phone or AirPod!" (alt text to match, ?v=5).

## 47. The phone's edges flare on a hit, in the ball trail's colour
- "On the phone, when a hit is registered, make the screen edges glow / flash briefly, responsive and flashy, in the colour
  of the ball trail for the strength of the hit."
- pad.html has a full-screen `#glow` layer: a thick inset edge ring, a wide soft inner glow and a vignette, added as light
  (`mix-blend-mode: plus-lighter`, like the trail's additive ribbon) so colours stay clean on the dark page. Its colour is
  the trail's own ramp for the hit's power (scene.js drawTrail without the slice/smash-spin tints): near-white tap, yellow,
  orange, red smash. Harder hits are wider and last longer (380-700 ms); a smash (n >= 0.76) flares twice over 800 ms.
  It lights in about 25 ms (Web Animations, no class toggles), together with the buzz. The old whole-page olive flash is gone.
- A hit goes out on the early guess and the settled swing can re-aim it within 0.25 s: the tab then sends `tint` (a new
  padfx, allowed by the server) and the glow still on screen changes to the settled power's colour, with no second buzz.
- `test/pad-e2e.mjs` checks my hit set the glow's colour.

## 48. The court pill's menu is short enough to stay off the scoreboard
- "The copy drop-down for the court code still clips into the left side scoreboard. You need to shorten the dropdown."
- The HUD's court menu shows the two names only (Player link, Viewer link; the share screen's menu keeps its second lines)
  and is only as wide as they are (at most 9.5rem). Measured at 1280, 1100, 1000, 901, 900, 700, 600 and 481 px wide, it
  never reaches the scoreboard (at 1000 px it ends 46 px short). Below 480 px the board spans
  the full width under the corner, so the open menu covers its top edge, drawn above it.

## 49. The settings card is grouped like a phone's settings
- "The hamburger menu dropdown is a bit of a mess with all the new features. Develop a nicer UX and UI for it."
- Before: eleven look-alike pills in one column, full-width buttons (Re-center, Leave court) between them, the status
  lights at the very bottom, and "Select difficulty" squeezing Pro off the card's edge.
- Now: the head has the title and the three status lights as small chips (the state word is read out and shows on
  hover; a bad one turns red). Then groups, each a small caps label over one white card of rows split by hairlines:
  (unlabelled) Name; **Paddle**: the Phone | AirPod switch across the full width, Sensitivity, Show phone/AirPod,
  Re-center (a row with an icon, not a floating button); **Match**: Move, Difficulty (Rookie | Club | Pro, on one line);
  **Screen**: Full screen, Show stats. Leave court sits at the foot in red. It fits a 1280x720 window without scrolling.
- Spectators see Game only in the head and the Screen group (and Leave). Every id, handler and keyboard walk is as before;
  the Tab order follows the groups. `test/ui-next.mjs` expects the new row and Tab order.

## 50. The ball trail's colour reads, and varies, with the hit's power; the slice's blue is gone
- "Ball trail colours weren't really that visible / variable as I thought. It helps players visualize ball strength. I'm also
  thinking of getting rid of the blue trail since we already have the spinning indicator on the ball itself."
- Measured, not guessed (`node test/trail-shots.mjs <tag>`: the real scene at n 0.15 / 0.35 / 0.55 / 0.75 / 0.95, from the
  player's end and the broadcast camera; it prints the colour the trail leaves on its pixels and how far it moved from the
  power before). Four causes:
  - The ramp was never entered. White -> yellow took n 0 - 0.33, orange 0.67, red 1.0; the swings in the live captures (every
    detected movement, `test/real.mjs` on data/live-play-*.jsonl, 94 of them, twitches and wind-ups included) settle at median
    n 0.06, p75 0.27, p90 0.61. Nearly everything drew white to pale yellow.
  - Vertex colours are linear and the renderer writes sRGB, so the ramp was lifted on the way out: its orange (1, 0.5, 0.12)
    drew as rgb(255 188 97), its red as a salmon rgb(255 97 79). (The phone's edge glow, NOTES 47, used the ramp as sRGB: it
    never matched the screen.)
  - Additive light can only whiten a bright court or sky. From the broadcast camera the trail's pixels were rgb(136 202 148)
    at n 0.15 and rgb(173 203 125) at 0.75: 7-10 units apart per step of 0.2, green flat at 202-212 the whole way. From the
    player's end the green channel sat at 181-192 from 0.15 to 0.95, and the smash's x1.9 boost drew it LIGHTER than a drive.
  - Thin and faint: half-width 0.7 ball radii at every power (only the smash flame was wider), alpha f^2 x glow, and glow
    settled to 0.16 + 0.6 x power a quarter second after the hit.
- The fix (scene.js, trail setup and drawTrail):
  - `trailHeat(n)`: the ramp is stretched over n 0.03 - 0.76 (SMASH_N) with a 0.7 gamma. 0.15 is yellow, 0.35 amber, 0.55
    deep orange, a smash red. Red now means smash; the flame, embers and extra width above 0.76 are unchanged.
  - Two ribbons: the old additive one is the soft halo (0.85 - 1.45 ball radii, wider for harder hits), and a core on top
    (0.42 - 0.72) with normal blending carries the colour itself, so orange and red survive on the court and the sky. The
    colours are converted to linear first.
  - The colour is the shot's own at once: a hit sets the heat outright (it used to ease up from the last shot's over 50 ms,
    a fifth of the 0.24 s ribbon); only a re-aim still glides. The hit lights the trail at 0.8 - 1.0 and it settles at
    0.55 - 0.9 by heat while live, not 0.16 (so the flash at the hit is a smaller step than before: the trail stays lit instead).
  - After: broadcast green 217 -> 187 -> 151 -> 117 -> 119 (tap to smash), the player's end 207 -> 178 -> 137 -> 98 -> 98;
    the 0.75 and 0.95 shots are both red and differ by the flame (the trail covers 761 vs 1240 px).
- No spin in the trail any more: the icy blue a slice pulled it to, the purple of a smash with spin and the purple embers are
  gone; the trail and its embers follow power only. The spin streaks on the ball show the slice (checked: `SPIN=0.8 node
  test/trail-shots.mjs spin`, the white arcs still read around the ball over the new core). (The smash's own ring and
  burst still turn purple with spin; that is the impact, not the trail.)
- pad.js `trailRGB` is the same heat and ramp, so the phone's edges flare in the colour the screen draws (pad-e2e's hit went
  from rgb(255 224 74) to rgb(255 160 45)).

## 51. Spin is a swirl of wind turning the way the bounce will go; the serve cue is the old arcs in white (supersedes 28 and 32)
- "Instead of the lines around the ball for spin, make it look like wind swirling around the ball. Remove the chevron ring for
  the serve and put the existing spin indicator there instead", then: the serve cue plain white, and the swirl should show the
  spin's DIRECTION, turning the way the ball will bounce, and how hard: a stronger kick is a wilder, faster swirl.
- The swirl (scene.js spinFx) is one mesh: three tapered wisps spiralling out from the ball, pointed heads leading, tails fading
  (per-vertex alpha), each with a thin companion further out. The shape is rewritten into the same buffer every frame
  (updateSpinFx), nothing allocated. Icy white. Scaled up with distance (1.2 x the serve cue's clamp) so it reads at game size.
- It comes from the same numbers the bounce does (coast / bounceV): a spun first bounce differs from a plain one by
  D = (vx * cut + kick, vz * cut), cut = (SPUN.along - FLOOR.along) * spin, the extra change in ground speed. Friction does that
  to a ball whose underside slides against D, so the swirl turns about up x D, like a wheel that will roll the ball along D when
  it lands: backspin = the underside rolling forward, so it checks up; kick right = a wheel rolling right. |D| / 4 m/s is how
  wild it is (0..1): fatter, the companions join from 0.25, more wobble, more opaque, 5 -> 18 rad/s. It is gone once the ball
  has bounced (the spin only bites on the first bounce); attract has no bounce count, so it watches the floor.
- Each camera sets it just before drawing (split view draws twice): the ring about the true axis, leaning at most 52 deg off
  facing that camera, so never edge-on. Split view moves its one camera between the two draws, so each draw of a frame keeps its
  own state (which end of the axis faces it); the roll itself advances once a frame and stops with a frozen ball. Seen along the axis (broadcast, a backspin ball) it turns
  clockwise or anticlockwise as the real ball does; seen across it (receiving pure backspin) it is an ellipse whose near side
  sweeps up and away, the way the ball's face turns. A real slice always kicks (at least 0.55 of SLICE.kick), so receiving it
  is also a clear turn: clockwise = kicks right, anticlockwise = left. From the other end of the axis it turns the other way,
  mirrored so the heads still lead; which end faces a camera has hysteresis (0.15), so a pure backspin seen from behind cannot flicker.
- Serve cue (serveFx): the old spin streaks, three short arcs, now white, turning slowly and breathing (1.2 Hz) while the ball
  hangs. The coral chevrons are gone. The swirl waits until the cue is fully gone (0.12 s after the serve is struck), so the
  two are never on screen together.
- `test/swirl-shots.mjs [tag]`: player, opponent, broadcast and split shots of weak and strong spin, a kick, the serve cue and
  the serve -> hit switch, each with a 3x crop, into test/ui-shots/swirl/. For every spin shot it prints which way the swirl
  turned on screen, next to D and which end of the axis faces the camera.

## 52. No Show stats switch; the copy menus have icons
- "Can you get rid of show stats? Genuinely I don't know if anyone would want to use that." The row is gone from the
  settings card (the Screen group is Full screen alone). The stats panel starts hidden on every load, even for someone who
  had it on (they would have had no switch left to turn it off); H still toggles it, unadvertised, for whoever is tuning.
- "For the copy link drop down, add icons next to the player link and viewer link." Both copy menus (the share screen's
  and the HUD court pill's) lead each choice with an icon in the outline blue: a paddle for Player link, the watchers
  pill's eye for Viewer link. The pill's menu keeps names on one line and still ends before the "You" tab (measured
  1440 to 700 px wide: 19 px clear at 901 px, the tightest).

## 53. The spin swirl is a true billboard; the serve cue has five arcs (supersedes the tilt in 51)
- "You made the mistake of making it not a billboard, so it's hard to see the spin orientation as its edge is facing the
  player." The swirl now lies flat in the screen of every camera and every draw (split view too). It still shows the real
  spin w = up x D from the bounce (51), split into what can be seen from that camera:
  - the part of w along the view is the TURN: anticlockwise or clockwise, as the ball really turns on this screen. Which way
    has hysteresis (0.15) and is kept per draw, so a pure backspin seen from behind cannot flicker;
  - the part across the view is how the ball's FACE moves on screen (w x toward-camera). The half of the ring that runs that
    way stays bright and the other half fades to 10 % (a uniform set per draw, in a shader patch on the swirl's material),
    so the wisps visibly sweep that way up one side of the ball. There is no sweep seen along the axis, and a full one across
    it (from 35 % to 80 % across).
- What each view shows (test/swirl-shots.mjs): receiving backspin, the wisps sweep UP the side of the ball (its face rolls up
  and away, so it checks up); hitting it away, they sweep DOWN. From broadcast a backspin ball is a plain clockwise or
  anticlockwise ring, the way it really turns. A real slice's kick adds the turn for the receiver: clockwise = kicks right,
  anticlockwise = left, with the sweep up as well. Wildness and speed still scale with |D|.
- Serve cue: five of the old white arcs (0.8 rad each, evenly spaced) instead of three.

## 54. A hit floods the whole phone screen with the trail's colour
- "Make the phone screen flash intensity more dramatic, like let's do entire screen colour actually." The `#glow` layer (47)
  now fills the whole screen with the hit's trail colour (72-90 % in the middle by power, full at the edges, plus a thicker
  edge ring), still added as light over the page. It peaks at 90-100 % in ~25 ms, holds at 55-85 % to a third of the way,
  then fades: 420-800 ms by power (a smash still flares twice, now over 900 ms). Colours and the `tint` recolour are unchanged.

## 55. Lobs are lobs: a wide underhand lobs, a backhand slice never does
- "Lobs aren't consistent. Sometimes I do a backhand slice and it lobs it super high. But when I actually lob it up with a
  wide underhand, it sends a low arc smash." Both paddles, so the cause was shared.
- Cause 1, wide underhand -> smash: main.js faded the lob out as the swing's axis turned 0.6 -> 1.0 rad (the "curved drive"
  gate of docs/NEXT.md 2). A wide underhand curves (turn ~0.9), so its lob went to ~0.2, and full arm power made it a smash.
- Cause 2, backhand slice -> lob: motion.js called a turn about the player's right axis "upward". Only true for a paddle
  pointing ahead: in a backhand the arm points left, and the forearm roll that opens the face is a turn about that same
  axis, so a roll-heavy chip read up 0.80 and flew 3-4 m high.
- Fix, client: `lob` is now the upward share of the HAND's path (angular velocity x the paddle's pointer from calibration),
  so a roll moves nothing and a pendulum reads ~0.9 however wide. The turn gate is gone; a roll-heavy stroke (|roll|
  0.45 -> 0.75) is faded out instead, for a pointer that sits a little off the forearm.
- Fix, server: a slice skids LOW (`SLICE.skid`, a touch quicker, instead of `slow` which floated soft spun shots to 2.4-2.65 m)
  and never flies the lob's arc; a swing going clearly up is never a smash (`flat`, SMASH_UP); a clearly underhand swing
  gets all of the lob's flight (`lofted`, LOB_ARC) instead of a 50/50 blend; the slice label is at 0.45 (27 % of real strokes).
- Measured: `test/lobsynth.mjs` (synthetic strokes, AirPod and phone grips): wide underhand lob 5/5 lobs at 4.7-5.2 m (was
  smash at 1.2 m); no backhand slice or chip lobs (a chip was up to 3/5). `test/lobdata.mjs` / kinds.mjs on the 143 real
  swings: drive 48 %, slice 27 %, smash 24 %, lob 2 % (the same one deliberate lob); slice apex p50 1.97 -> 1.41 m.
- slice.test's two "a slice floats" checks now ask the opposite: it crosses the net lower than a flat shot.

## 56. The kitchen is forgiving: hold the paddle up to block, push to send it back deeper
- "I need to make kitchen gameplay more forgiving... if you want to block balls lightly, when closer to the kitchen, the game
  should let users just hold up their paddle and let balls bounce off of it to block it. Then, if they add a bit of a push
  to it, it should scale accordingly. I find kitchen gameplay is a bit tricky right now as it's hard to get out of it."
- Cause: near the net every swing under n 0.4 was clamped to exactly n 0.12 and a fixed pop (lands 3.00 m), then jumped to a
  full drive at 0.40 (3.92 m). A push of 7 rad/s and one of 17 did the same thing, so no amount of pushing got you out of the
  kitchen and the rally sat in a block/dink loop. The held-paddle block was a fixed n 0.06 whatever the ball was doing.
- Fix: one continuous curve (`blockShot`, PUSH). A paddle held still returns 1.6 m of a dead ball and 1.9 m of a fast one
  (pace you give back, like a real reset block); push and the landing walks smoothly out to the drive's own depth, meeting
  it exactly at n 0.45 (measured seam gap 1 mm, largest step 3 cm per 0.005 of n, never backwards: /private/tmp curve.mjs).
  `solve()` takes an optional `blk` that moves only where the ball lands; the arc stays the ordinary one for that power.
- The curve fades out over the last 1.2 m before BLOCK.volley and for a real scoop, so dinks, lobs and baseline play are
  untouched. After the bounce it only applies within 3.6 m of the net, where a volley would have been.
- Held-paddle block: the box grows the closer you stand (the full swing box at the kitchen line, never smaller than before)
  and the ball is met AT the paddle, not 1.2 m in front of it — firing early used to steal the swing already on its way.
  A push that lands within 0.2 s of a held block now counts as that block's push instead of being lost.
- Static movement counts: the phone reports the hand's rate (`r`) with every paddle update at 20 Hz, so a shove under the
  swing trigger (7.5 rad/s) still pushes the ball back. Measured: held still 1.60 m, shoved 2.43 m, no swing either time.
- A block may now be corrected like any other shot, but only by a SETTLED report (its own window, 0.35 s and 0.3 m from the
  net): an early report overshoots badly (called 30, settled 8), so at the net it strikes soft and the settled one raises it.
  Without that, ramping the power would have fired deep balls nobody hit.
- Getting out: your own lean is no longer a place you are stuck in. A ball that lands well behind where you stand takes most
  of the lean back off (Z_PUSHED), so a deep return pulls you out of the kitchen; a short one leaves you there.
- `test/push.test.mjs`: pushes at 6/10/14/18/24 rad/s land 1.95 / 2.51 / 3.21 / 3.97 / 4.72 m (block, punch, drive); a held
  paddle blocks with no swing at all; a bet of 33 settling at 8 stays short and one settling at 30 still lands deep; a push
  at 8 keeps the opponent 4.1 m from the net and one at 24 drives them to 7.1 m, out of reach of a held-up paddle. A player
  leaning right in at 2.8 m meets a dink 2.6 m from the net and a deep drive 7.1 m out: walked in, but not stuck there.

## 57. The set-up screen says what the camera is for
- "Can you also add a camera disclaimer? It doesn't say why camera is necessary, it just asks for perms." The browser's
  permission prompt was the first and only mention of it.
- The Camera status row now reads "Allow the camera so stepping moves you on court" instead of "Allow the camera when the
  browser asks", and a line under the three status rows (the same `pad-alt` note the AirPod card uses for Poddle Helper)
  says what it is for and what happens to the video: the game sees where you stand so you move by stepping, it watches for
  you in the frame and nothing else, the video is read on this Mac and never recorded, saved or sent anywhere, and saying
  no just means the game runs you to the ball. All true: bodytrack.js reads the frames with the bundled MediaPipe wasm in
  the page, there is no upload of any kind, and a refused camera falls back to Auto (main.js setMode on !t.ready).
- It sits on the connect screen, which is where the camera is asked for (main.js startCam on taking a seat), so it shows
  for both paddles: the phone and the AirPod cards differ above it, the status rows and this note are shared.

## 58. A smash is shown once: when the call comes late, the ball catches fire instead of being struck again
- "With the power swing that's purple, I sometimes see the hit effect twice." Two impacts, a beat apart, for one hit.
- A bet never smashes (server/game.js, `test/bet.test.mjs`): the server calls a smash only on a SETTLED swing, and most
  swings are struck on their early bet, so the call lands *after* the ball has gone. web/scene.js replayed the whole
  flourish at the ball's position then — a ring opening, a bloom, a camera shake, 1-3 m down court, where nothing had been
  struck. That is a second hit, and it was read as one. "Sometimes": a swing that settles BEFORE contact is called a smash
  at the impact itself, and shows once.
- Measured, not guessed. The real captures replayed through web/motion.js at the real server (`test/latesmash.mjs`): 13 of
  13 smashes were struck as a drive or a slice and only called a smash 60-200 ms later, with the ball already 0.9-2.8 m
  away. Watched in the real renderer through test/scene-preview.html, that late call opened a fifth ring, relit the bloom
  from 0 to 0.78 and pushed the camera shake from 0.05 back up to 0.30 — brighter and harder than the impact it followed.
- The late call now rides the ball: the same purple (or fire), 26 sparks off the ball and the trail at full flame, with no
  ring, no bloom and no shake. It reads as the shot catching fire in flight, not as a second contact. This is the answer the
  phone already gave — 'tint' recolours its glow for the settled swing and never buzzes or flashes a second time (NOTES 54).
- A smash whose swing settled before contact still gets the full flourish at the impact, where it belongs, and a 0.3 s
  guard in scene.js keeps the two from both playing for one shot inside the server's 0.25 s re-aim window.
- The sparks take hitLook's scale, the one the ring used to take, so the other end's smash still reads from across the
  court (it throws them as wide as its ring was) while mine stays close to the ball, 5 m from the lens.

## 59. An X on the phone: held, it hangs the paddle up
- "Can you make an X button on the phone, so when you're done playing per se you could just press and hold it to close the
  tab." There was no way out of the paddle page: it held the screen awake and kept streaming until the tab was closed by hand.
- A round X sits in the top corner of the paddle screen, out of the way of a hand gripping the phone and a 2.75 rem target.
  It answers only to a press held for 0.7 s, filling as it goes, exactly like Calibrate again and Re-center (34): a gripped
  phone has its screen pressed all rally long, so a tap must never end the session.
- Held, it hangs up properly: the motion listeners come off, the wake lock is released (the screen may sleep again) and the
  socket is closed for good — `started` is false first, so the reconnect in onclose does not fire. The computer is told its
  paddle has gone (server padGone -> `pad: off`) exactly as if the tab had been closed.
- Then it asks the tab to close itself. A page may only close a tab that a SCRIPT opened, and this one was opened by hand or
  by scanning the code, so window.close() is very likely refused: the Paddle off screen is shown first and says "You can
  close this tab now", with Be the paddle again to come straight back (start() over, sensors and socket and all).
- `test/padquit.test.mjs`: the real pad.html in Chrome, the real server, a plain socket standing in for the computer's tab.
  A tap is ignored; a hold reaches the Paddle off screen, the computer hears `pad: off`, and not one sample follows; Be the
  paddle again brings the view, the samples and `pad: on` back. Note for whoever tests this by hand: a screenshot taken
  mid-hold cancels the press, so a hold that spans one never completes — that is puppeteer, not the page.
## 60. The game's sound can leave the AirPod: a Sound group in Settings with an Output row
- "In settings can you make it so that if users wanna hear audio but are using AirPods they can change audio output? So
  they could have the game's audio streaming out of speakers." An AirPod in one ear is a *paddle* here, not a speaker, so
  macOS still routes system audio to it and the game arrives in the ear that is busy being swung around.
- New `Sound` group between Match and Screen: a `Sound` switch (mutes `master`, the gain that was hard-coded at 0.7) and
  an `Output` row, a plain `<select>` of the player's audio outputs. Choosing one calls `AudioContext.setSinkId`.
- What was measured, on Chrome 153, before any of this was written (the first attempt got all three wrong):
  - `navigator.mediaDevices.selectAudioOutput` is **undefined** — even with `--enable-experimental-web-platform-features`.
    A native device picker is not available, so the list has to be ours.
  - `AudioContext.prototype.setSinkId` **is** there, so the sound can genuinely be moved per page.
  - `enumerateDevices()` blanks BOTH the id and the label of every audio output until the page holds a media grant.
    A **camera** grant is enough — a microphone is NOT needed, which matters because asking for a mic so someone can
    change speakers would be absurd. Poddle already asks for the camera for Body mode, so for anyone playing in Body
    there is no new permission prompt at all.
- So the Output row appears only when `canSwitch()` (setSinkId exists) AND the browser will name the devices. Otherwise a
  hint says which of the two is missing — "this browser can't move the game's sound" vs "allow the camera and your
  speakers will be listed here" — rather than leaving a dead control on screen. Gated on capability, never on the paddle
  being an AirPod: a phone-paddle player can have AirPods in just as easily.
- The list is re-read every time the card opens, when the body tracker gets the camera, and on `devicechange`, so an
  AirPod connecting mid-match shows up. It is rebuilt only when it really changed, never under an open list.
- The AudioContext only exists from the first gesture on, so a kept device is applied in `unlock()`, not at load. A device
  that has since been unplugged rejects `setSinkId` (verified: a bogus id resolves false) and `forgetSink()` drops it with
  a toast, rather than leaving the row naming a speaker nothing is playing out of.
- Kept in `poddle.settings` as `sound` / `sink`, both left out while they are the default, so a player who never opens
  these rows saves the same object as before.
- ui.js's arrow-key walk now includes `select`, but yields the arrows to a focused one: on the Output row Up/Down belong
  to the list and Tab leaves it.
- Device names are the system's text and go in with `textContent` only; test/ui-next.mjs checks a hostile one stays text.
  The tests pin the group with `setSettings({ sinkWhy: 'browser' })` so the panel's shape never depends on whether the
  test browser happens to expose the devices.

## 61. The landing marker is white on both sides
- "Can you make the ball drop signal on my side white instead of yellow?"
- The marker was `0xffd23a` when the ball was coming to YOU and white when it was going to the other side (a spectator, on
  nobody's side, always got white). It is now white wherever it lands.
- So the marker no longer says whose side the ball is heading for. That was the one thing the colour carried, and it is
  redundant: the marker is already drawn at the spot, on one side of the net or the other, in a 3-D view from your end.
- One line in scene.js's `launch` handler. Nothing reads the marker's colour, in the game or in the tests.

## 62. The X moves off the corner, to the bottom of the middle (supersedes the placement in 59)
- "Can you put it in 3/4 middle of the screen to bottom? Shouldn't be corner in case you press it when holding phone." Right:
  a hand wrapped round a phone rests on the corners, so the one button that ends the session was under a palm all rally.
- It is now pinned to the middle of the screen near the bottom (1.25 rem above the home bar, `env(safe-area-inset-bottom)`),
  the same place on every phone. Nothing else is down there: the live view carries 5.5 rem of bottom padding to keep clear of it.
- Two placements were measured and thrown away first. Fixed at 75% of the height sat ON the "Press and hold a button" line
  at 390x844 and on the Calibrate again / Re-center row at 360x640. Last in the flow instead put it at y 667 on a 640-tall
  screen: off the bottom of the page.
- Short screens (`max-height:760px`) tighten the live view — smaller ring, smaller gaps — so the whole thing including the X
  fits with no scrolling. Measured after: 390x844 has the X at 780-824, 360x640 at 576-620, scrollHeight equals the window
  on both, no overlaps either side.
- Sideways (`max-height:520px`) there is no room to keep a strip clear at the bottom, and pinning the X there dropped it
  straight onto the Calibrate again / Re-center row (measured at 844x390 and 740x360). Below that height it goes back into
  the flow as the last thing in the view: no overlap, but it is under the fold and reached by scrolling. This page already
  overflowed when turned sideways (587 px of content in 390), so that is not new — it is just not fixed here either.

## 63. A hit bends the ball once, gently: only the settled swing re-aims it, over half the rest of the flight
- "It'll sometimes register two hits, causing the ball to literally change trajectory mid air." Not a second contact: the
  re-aim. Every swing is struck on its early report (the bet, web/motion.js), and the reports after it re-aim the ball
  (`reaim`, server/game.js). NOTES 58 took away the second *flourish* a late smash call played; the ball's own bend stayed.
- Two things made the bend read as another hit. Every report after contact re-aimed, not just the settled one: motion.js
  sends up to three `swingFix`es per swing (a bet, a moved call or two, then the settled one), so one shot could bend two or
  three times. And each bend took 0.1 s (`FIX_EASE`), so a ball that left at drive pace and settled as a tap braked like it
  had been struck again.
- Now only the SETTLED report re-aims a struck ball, the way a blocked ball already worked. The in-between reports still correct
  a swing that has not met the ball yet. The bend runs over half of what is left of the flight (`FIX_SHARE`, 0.1 - 0.45 s),
  so it curves onto the new line instead of kinking. The landing is still exact: easeAim re-solves every tick.
- A gentler bet was tried on paper first and thrown out: in the real captures (live-play-1 and -3, 74 scored swings, every one
  struck on a bet) the bet misses the settled power by 0.22 - 0.26 of n at the median whatever it is capped at (0.3 - 0.76),
  and in both directions (38 over, 30 under). There is no conservative bet; only the bend itself can be tamed.
- Measured (`test/reaim.mjs`: the real captures through the real motion.js at the real server, 90 s each):
  before, 7 of 27 hits bent more than once and the sharpest kink per hit was 0.39 m/s between two packets (p50, p90 0.89);
  after, 0 of 24 bent more than once and the kink is 0.13 (p90 0.37). Every hit is still re-aimed once, and the landing
  still moves as far (p50 0.8 m): that is the settled swing being honoured, not a bug.
- bet, serve, push, kitchen, slice and deep tests pass; server.test.mjs fails the same way on main (teleport timing under load).

## 64. The Sound output list needs MICROPHONE permission, not the camera; and a comment that ate six handlers
- "It says to enable the camera so I did, but no sound devices were detected anyway and so I couldn't change sound output."
- Cause 1, the wrong permission. 60 claimed a camera grant was enough to make the browser name audio devices. It is not.
  That claim came from a probe run with `--use-fake-device-for-media-stream`, and the fake devices are not subject to the
  real gating, so the probe passed while real hardware never would. Measured again on real devices, Chrome 153:
  - no grant: one audiooutput with a blank id AND a blank label;
  - camera granted and the camera actually opened: still blank;
  - microphone granted: real ids and real names ("Default - MacBook Pro Speakers (Built-in)").
  So the Output row could never populate for anybody. Shipped and deployed that way.
- Fix: the list is opt-in behind a `Find my speakers` row that calls `getUserMedia({ audio: true })`, stops the track the
  instant the permission lands, then re-reads the devices. We want the permission, never the audio; nothing is recorded.
  The hint above it says exactly that, and a refusal gets its own `denied` wording pointing at the browser's site settings.
- A throw from getUserMedia is NOT taken as refusal: with no microphone, or a busy one, the permission can still have
  landed, and the permission is all the list needs. The device list is the judge — `sinkDenied = !sinks.length`.
- `Find my speakers` shows only where asking can still help: not without setSinkId, not after a refusal, not once listed.
- Cause 2, unrelated and worse. The end-of-line comment added to `ui.onSettings({ ... })` in 60 swallowed the rest of that
  line, which held `sens`, `airpod`, `stats`, `recenter`, `leave` and `name`. Sensitivity, Show AirPod, Re-center, Leave
  court and the Name field were dead on the live site from that deploy until now. `node --check` cannot see this, and the
  menu.mjs checks that would have caught it were already red for other reasons, so nothing flagged it.
  The handler object is now one key per line, with a comment saying why it must stay that way.
- Lesson recorded: a probe that stubs the very thing being measured proves nothing. Both of 60's central claims were wrong
  in the same way, and both looked verified.

## 65. A match is counted in, and a leaver takes the score with them
- "Can you also add a countdown when a user joins so that the game doesn't insta start" — and, straight after, "whenever
  someone leaves and joins, the scores need to get reset."
- The insta-start was worse than it looked. `startMatch` set the serve 0.8 s out, but the serve itself waits for every seat
  to be ready (a seat is ready once it has sent a paddle message), and by the time the second player finished calibrating
  that 0.8 s was long gone — so the ball went out on the very tick they became ready, before they had the paddle up.
- So the count runs from when the room is WHOLE, not from when someone sat down: `countdown()` holds the first serve of a
  match for READY_S (3 s), and starts over if the room comes apart while it runs (a seat leaves, goes back to calibrating,
  pauses or is held). `{type:'countdown', left}` goes out once a second, 3 · 2 · 1 · 0, and the HUD shows it big over the
  far court (`.countdown`, docs/ui-spec.md). A seat that stalls for good is still handled by slowSeat, whose window runs
  from serveAt as it always did: the count sits after it, not instead of it.
- `Math.ceil(until - now)` counted "4" into a count of three about one run in three: `(now + 3) - now` comes back an ulp
  over 3. It is clamped and nudged by 1e-9 now (test/countdown.test.mjs caught it, four runs in a row).
- Off in tests by default (`AUTOBOT ? 3 : 0`, the same shape as SWING_SERVE): the measuring tests drive rallies and would
  only wait. test/push.test.mjs proved why — it averages where the opponent stands over every hit in a 9 s window, and
  three seconds of counting cut the rally sample enough to move the answer from 4.4 m to 5.5 m and fail. Nothing about the
  push had changed. test/countdown.test.mjs and test/rooms.test.mjs keep it on and own the behaviour.
- The score: a board only ever cleared when the NEXT match started, so whoever was left sat looking at the old one (and,
  with the bot 2.5 s away, brought it to Matt). Now a real leave clears it at once — score, `started` and any revived score
  go with the leaver. A seat that only DROPPED is not a leaver: it is held for 15 s and keeps its score for the reconnect,
  as it always has (the point in play is replayed). Reconnecting inside that window is coming back, not joining.

## 66. A swing never waits: the ball leaves at the power of the swing that struck it (fixes the lag 56 introduced)
- "Holy shit there's such a delay now to each swing. Surely you can come up with a solution that doesn't impose any delay on
  the swing. You can't compromise a key mechanic like that."
- Cause, mine, from 56: a swing struck near the net on the client's FIRST report (a bet, which overshoots: called 30, settles
  8) was clamped to n 0.2 and only raised to its real power when the settled report arrived. 63 then stretched that bend from
  0.1 s to half the remaining flight. Measured on the live rules: a real 30 rad/s swing at the net left at 6.4 m/s and took
  750-780 ms to reach full speed. Every near-net swing felt like mush, and after 56 that is where the rally lives.
- Fix: strike() no longer caps anything. The ball leaves at the power of the swing that struck it, first report or settled,
  exactly as everywhere else in the game. Measured after: it leaves at full speed within 15-18 ms, one tick.
- The correction still happens, because it is the only part allowed to be late: a SETTLED report that disagrees bends the
  ball afterwards (63's gentle bend). A near-net hit now uses the near gate (PUSH.gate 0.3 m, PUSH.fix 0.35 s) instead of the
  rally gate of 1 m, which from 2.8 m out the ball passes before any report can land — without that the over-read ones could
  never be pulled back. Measured: a bet of 33 settling at 30 lands 5.43 m, the same bet settling at 8 lands 2.20 m.
- The lesson, which is worth keeping: a swing is the one thing that may never wait for a better answer. Correct it after.

## 67. A phone in the pairing QR, and a ring that fills while you hold the X
- "Can you make the phone QR code have a phone in it?" and "when you're pressing and holding the X, have a bigger circle
  with a circling completion animation around it, so you know it's working and you just have to keep holding."
- QR: the same phone as the paddle picker's chip sits on a white rounded tile in the middle of the code. There is only ONE
  QR in the game (the phone's pairing code); the AirPod side has a Download button, not a code, so there was nothing to
  put an AirPod in.
- A glyph covers modules, so the error correction went from `M` (15 %) to `H` (30 %). That costs density: the same URL goes
  from 29 modules to 37, so each module is ~22 % smaller on screen. The tile is 28 % of the width — about 8 % of the area,
  well inside H's budget — and is sized from the REAL module count, because the URL's length changes it (localhost, a LAN
  IP and poddleball.com all differ).
- Verified by DECODING, not by looking: rendered through the real ui.js and read back with jsQR at the desktop size and at
  the narrow breakpoint's smaller box, for four URL lengths — localhost, a LAN IP, poddle.fly.dev and poddleball.com.
  8/8 decoded back to the exact URL. (jsQR and pngjs were installed with --no-save; they are not dependencies.)
- X button: `.btn-hold`'s indicator is a left-to-right bar, which on a round button reads as a smudge rather than progress.
  The X now opts out of it and draws an SVG ring instead, inset -.4rem so it is visibly wider than the button (53 px round
  a 44 px button), turning over the same 700 ms via stroke-dashoffset. Measured mid-hold: 138 -> 102 -> 33 -> 0.
- Let go and it snaps back rather than unwinding: the transition lives only on `.is-held`, so removing the class has none.
  Completing turns the ring green (`is-done`), which matters because `window.close()` is usually refused and the button is
  still on screen behind the 'done' view.
## 68. A whole body inferred from one number: the avatar crouches, lunges and goes up on its toes

- Before this, the only thing a head did to a remote avatar was turn it: the Mii stood at exactly one height whatever the
  player was doing, and every duck for a low ball or stretch for an overhead was invisible to the person opposite. The
  paddle moved; the body it was attached to did not. All of the work is in `web/scene.js`'s `updatePads`, on the `!local`
  branch, so it only ever dresses a remote seat, a bot, a spectated seat or the attract rally — never your own hands.
- There is nothing new on the wire. `pd.pos.y` IS the head: in Body mode it is `bodytrack.js`'s `T.y()`, which returns
  exactly 1.0 at the spot the player calibrated on, and every other source of y agrees with that baseline — `newPlayer`
  starts at 1.0, and `runAuto`, `runBot` and the attract striker all recover to 1.0 between shots. So `STANCE.base = 1.0`
  is the standing height for humans, bots and the title screen alike, with no per-seat calibration to carry and nothing
  to drift. A slow-tracking baseline was the other candidate and is wrong: it fades a held ready crouch back to standing
  after a few seconds, which is the one thing this is supposed to show.
- Below the baseline the knees bend: the body sinks and squashes, leans forward at the waist, the stance widens and the
  free arm drops out to balance it. Above it the heels come up. Past the top of a tiptoe it stops being a tiptoe, so the
  rest of the height comes out of the body lengthening and the off hand reaching — otherwise everything above y = 1.28
  looked identical, and an overhead is exactly when you want to see someone stretching.
- A lunge is the crouch plus `pd.vx`: the foot in the direction of travel takes the step, the other trails, and the body
  leans into it. The stagger is what reads, not the sink — the sink runs out of room almost immediately, because the
  torso would be through the shoes long before a 0.7 m duck read as a squat on a legless Mii.
- The bob is a spring driven by how FAST the head is moving, not by where it ended up, so a quick duck overshoots and
  bounces back while a slow one of the same depth does not. That is what makes rapid crouching funny, and it needs
  nothing to recognise a crouch first. Three dips inside a second each is then named as a taunt and played up with a
  shoulder shimmy, because somebody was always going to do it.
- Deliberately NOT filtered here, because there is already plenty upstream and none of it is ours to undo: bodytrack's
  one-euro filter on the raw face y, main.js's 0.085 s smooth-damp before the 20 Hz send, and scene.js's own 55 ms lerp
  on arrival. The 55 ms lerp alone passes a three-a-second bob at about 70 %; the END-TO-END figure, from a real head in
  front of a real camera to a drawn avatar, has NOT been measured — `stance.mjs` drives `pd.pos.y` directly and so skips
  the first two entirely. If a fast bob turns out mushy on a real camera, the slack is in one of those two, not here.
  What is certain is only that adding another filter at this end would have made it worse.
- Two things had to move to make it work, and both are worth knowing about:
  - The avatar's feet were direct children of its root, so sinking the root sank the shoes into the paint. Everything
    above the ankles now hangs off an inner `upper` group, and the whole stance — the sink, the squash, the waist lean,
    the extra roll into a lunge — is applied there. The root keeps its original small lean and roll untouched, so a
    standing avatar is within a few mm of what it always was — not identical, though: the ground clamp lifts the feet
    4.5 mm out of the paint, and aiming the gaze from the real head height instead of a hardcoded 1.6 m tips a standing
    head a couple of degrees further down when the ball is close.
  - The shoes are then put back on the court analytically: an ellipsoid long in z, on a body that leans and rolls, has a
    lowest point that moves with all three, and a lunging foot is far enough out from the root that the roll alone
    scuffed it several cm under. Solving for that point is also the only reason a tiptoe pivots on the toes instead of
    the whole foot floating — lifting by the pitch angle's sine looked like a small jump. Measured: 4.6 mm of shoe under
    the paint at the baseline and about 4.6 cm at full roll, both pre-existing and both now zero.
- The head is held up through a crouch: `upper` leans at the waist, and the neck gives 80 % of that lean straight back.
  The ball-tracking gaze is worked out in world terms (it now aims from where the crouch has actually left the head, not
  from a fixed 1.6 m) but was being applied under a leaning parent, so a deep crouch had the avatar looking a good 20 deg
  below the ball. The gaze is smoothed in its own field so the lean can be taken off it every frame without compounding.
- The attract rally behind the menus IS affected, and this was checked rather than assumed. Its receiver runs to
  `clamp(contactY - 0.28, 0.35, 1.7)`, which for the low balls after a bounce is the 0.35 floor, so over 30 s one of the
  two is past a half-crouch about half the time and often all the way down. Nothing there changed — the paddle has always
  waited at that height — but until now the body above it did not show it. Looked at: it reads as a low ready position
  reaching for a ball that really is at ankle height, and it is consistent with where the paddle is drawn, which is the
  thing that would look broken if the body and the paddle disagreed. The one frame worth a second opinion is a high lob,
  where the receiver is already crouched at the contact height it is heading for while the ball is still up in the sky.
- `node test/stance.mjs [port]` (8742) drives the real scene through `test/scene-preview.html` with the fake rally's
  footwork switched off, so head height is the only thing moving, and measures what the avatar actually became off the
  live scene graph in world metres: monotonic head height over y = 0.4 .. 2.2, no shoe or torso through the court at any
  of them, the lunge mirrored correctly on both seats, and the spring and the taunt read at their PEAK rather than on the
  last frame. Screenshots land in `test/ui-shots/stance/`; look at them, because none of those asserts can tell a crouch
  from a collapse. Two of the first round's failures were the harness's fault, not the feature's: `page.evaluate`
  serialises its arguments as JSON, so a waveform passed as a function arrived as `undefined` and every spring test
  silently drove a still head. They cross as source text now.

## 69. Who just arrived: "Sam is watching" top-right, "Sam is here to play" at the bottom

Asked for: a small notice in the top-right corner when someone starts watching you, and the standard bottom banner when someone joins to play against you.

- Server (`watch()` in server/game.js): a spectator sitting down sends `{ type: 'watcher', name }` to the room's players only (not to the stands, not to other courts). Each room keeps a set of cids it has announced, so a reload or a reconnect of the same tab is not announced twice. A nameless spectator comes through with `name: ''`.
- Page: `ui.watcherNote(name)` puts a small white card with the eye icon (the watchers pill's) in the top-right corner, over the camera inset, for ~3.6 s; three at most stack, and `ui.notesOff()` clears them on the way back to the lobby. It says "Sam is watching", or "Someone is watching" with no name. Spectators never see these cards.
- A player sitting down already raised the bottom toast; its copy changes from "Sam joined" to "Sam is here to play" (2.6 s instead of 2.2), so it reads differently from the watching card.
- test/watcher.test.mjs (WATCHER_PORT, default 8355) covers the server side. test/menu.mjs and test/rooms-e2e.mjs expect the new copy; menu.mjs was already crashing at line 244 on main before this change.

## 70. A lob burns white, only a smash burns red, and a bet no longer flashes red
- "Big lobs report a red streak ... lobs should be plain white ... a lot of shots being classified as red." The trail's colour
  was a function of n alone, and `kind` (sent on every hit) was only used for the smash flourish. A hard scoop is a lob at high n
  (live-play-3: 27 rad/s, n 0.75, kind 'lob'), so it burned red and, past 0.76, wore the embers, the fat flame and the phone's
  double flare too.
- Why so much red, measured on data/*.jsonl (63 real strokes at >= 9 rad/s, through motion.js and the client gate):
  - The BET. Every swing is struck on its first report, capped at SMASH (game.js), and trailHeat(0.76) was pure red: 60% of real
    hits flashed full red at impact, on screen and on the phone. The phone's `n >= SMASH_N` also gave every one of them the
    smash's double flare.
  - The ramp reached red at n 0.59, below the smash line: settled strokes were 37% red, 8 of those 23 not smashes.
- Now the colour is the SHOT's, not the swing's: `shownN(n, kind)` (scene.js, used by main.js for the phone) is 0 for a lob or
  dink (rgb 255,255,255), n for a smash, and min(n, SMASH_N) for everything else. Only a smash can pass SMASH_N, and the red,
  the embers and the flame all key on that line. Bots and the title demo's lob-ish arc follow the same rule.
- New ramp (scene.js trailHeat = pad.js trailRGB, checked equal for n 0..1): below SMASH_N it stops at orange, `0.70 *
  ((n - 0.06) / 0.70)^0.8`: 0.18 cream, 0.30 pale yellow, 0.52 amber, 0.76 deep orange (u 2.1, 255,118,30). A smash steps up
  past it so the line is visible (graded to red: see below). Every red is a real smash (was: 37% red, 0 pale).
- The bet: the hit now says `bet: 1`, and the client shows it at min(n, 0.3), pale yellow. The settled re-aim's launch sets
  the real colour (it carries n and kind); if none comes in 0.3 s the ball really flies at the bet, so the display falls back
  to the bet's own shown n. The phone does the same with a 300 ms timer in main.js and a 'tint'. Its tint gate was a fixed
  300 ms after the flash, which dropped every late tint (0.3 s + two hops); it now recolours while the flash is still running.
- The phone's double flare is strict `n > SMASH_N` now. The buzz keeps the stroke's force: the padfx relay carries `b`, the raw
  n, beside the shown n, so a hard lob buzzes hard and glows white. A human's smash only ever reaches the phone as a 'tint' (the
  flash went out on the bet, pale), and a tint used to just recolour: no human smash ever double-flared. Now a tint past SMASH_N
  cancels the running flash and starts the smash flare, once (`glowAnim.smash`), with no second buzz.
- Red graded inside the smash band. Stepping every smash straight to u 2.6 (255,68,24) left 24% of strokes red, because every
  smash was red. SMASH stays 0.76 (pace, labels, flourish unchanged); the colour runs `0.8 + 0.2 f^2`, f = (n - 0.76) / 0.19:
  orange-red 255,89,27 just over the line (the capped drive is 255,118,30), 255,57,23 at n 0.9, pure red 255,31,20 from
  SMASH_RED 0.95 (scene.js and pad.js). Replayed data/*.jsonl (63 settled strokes >= 9 rad/s, client lob/slice maths, chop
  bonus, shotKind, shownN), by u: white/pale 42%, yellow-amber 29%, orange 6%, orange-red 10%, red (u >= 2.85) 14%. Most
  smashes really are at full power (chop adds 0.2: 11 of 15 at n >= 0.9), so fewer reds than this means raising SMASH itself.
- test/trail-shots.mjs gained three rows: a lob at n 0.9 (white), a bet re-aimed to 0.2 (pale), a bet left alone (falls back
  to orange). bet, reaim, kitchen and pad tests pass; server.test.mjs fails the same way on an untouched HEAD copy (teleport
  timing and scoring under load).

## 71. The hardest flat drives curl in the air, on purpose
- "For the hardest shots possible, they need to curve in the air. I know there's a bug like that right now, but I want you to
  try to make it intentional, only for the harder shots." The "bug" is 63's re-aim bend: a hit struck on the bet and bent onto
  the settled swing. It is kept exactly as 63 tamed it (FIX_SHARE 0.5, 0.1-0.45 s, settled report only): it is still what
  honours the real power (landing moved p50 0.8 m). The curl is a separate thing, and from above it is a smooth bow, never a kink.
- What it is: a constant sideways pull c (m/s^2) until the first bounce, a second gravity lying on its side (CURVE in game.js).
  Everything stays closed form: solve() starts the ball `c T / 2` wide of its line (`v[0] = (tx - px) / T - c T / 2`), and the
  pull brings it back onto the same marker at T. The bow is `c T^2 / 8` at mid-flight. sim() adds it exactly per tick
  (`v += c dt; p += v dt - c dt^2 / 2`), planFootwork the same at 120 Hz, and web/scene.js coast() adds `c t^2 / 2`. c rides on
  the hit, launch and state packets (`c`, only while it is non-zero and before the bounce), so the client has no copy of CURVE.
- Who curls: `w = smooth(n, 0.8, 0.97) * flat(lob) * (1 - lofted) * curl`, c = w * min(24, 8 * 0.6 / T^2): a bow of 0.6 m at
  full power, nothing at n 0.8, 0.13 / 0.38 / 0.58 m at n 0.85 / 0.9 / 0.95. About the top 10% of real settled swings (captures:
  p90 0.79). Never: a lob or scoop, a serve (sw.floor, and every auto-serve / reset launch passes curl 0), a bet (it is capped
  at SMASH and passes curl 0 anyway: CURVE.from is its own number so moving SMASH for the colours can never make a bet curl),
  a block or punch (n < PUSH.full). Every prediction (tests, badwifi) calls solve() with curl 0 unless it asks for it.
- Which way: in toward the middle, a banana (it leaves wide and hooks back). A real slice curls the way its bounce will kick,
  a ball aimed at the middle bends away from the hitter's side, else the forehand way. Deterministic: the server's c is the
  only one. Hooking in also slows it sideways at the bounce, and the REACH clamp in solve() counts the extra c T / 2.
- A human curls LATE. Every real swing is struck on its bet and the settled report comes ~100 ms after, so a hard human drive
  starts curling at the re-aim, and easeAim() eases onto the curled path over 63's same share (its target just carries the
  `c T / 2` offset from where the ball is). Sized like a struck ball (bow 0.6 over the flight LEFT) the ease ate most of it:
  0.26 m from contact at full power, one ball-width, less than half a bot's and weaker than the accidental re-aim bend. So
  reaim() asks solve() for CURVE.late (2) x the bow, capped at CURVE.lateMax (30 m/s^2, inside solve's min so the REACH clamp
  sees it). An x-only model of the ease (bet straight for 100 ms, then easeAim's equal shares) picked it: late 2 gives about 0.40-0.57
  m from contact over 0.6-1.1 s flights. Holding the pull off until the ease ends gave a bigger bow for the same c but a 45-80
  m/s^2 spike on the last ease tick. Measured live (test/curve.test.mjs): bot-style final full-power drive bow 0.58-0.60 m; a bet
  settled at full power bow 0.50 m from the baseline, 0.47-0.63 m from 3 m, lands within 0.09 m. The shape is the physics of
  bending a ball into a C from its current velocity and still landing on the spot: the ease swings it out, the pull hooks it in.
- Kink on the real captures (test/reaim.mjs, live-play-1, now subtracting the curl's own steady pull): straight hits p50
  0.13 / p90 0.37 m/s, curled hits p50 0.79, max 1.05 (4 of 16 hits; bow p50 0.46, max 0.65 m). That is the price of the late
  bow: at late 1 the curled hits were p50 0.43, max 0.92 with bow p50 0.24.
- The client: coast()'s prediction between every pair of live packets is within 1.3 cm on curled shots (the ease is not in
  coast), and no packet steps over 0.3 m. test/coast.test.mjs flies curled launches too; badwifi's rally uses them.
- Bots: always final, so they curl from contact. Only Pro can (power 0.45-0.95): about 30% of its drives, bows 0-0.58 m on
  the ramp above (never the full 0.6, which needs n 0.97). Club (0.25-0.65) and Rookie (0.10-0.40) never curl.
- Knobs: CURVE.bow (0.6) for everything, CURVE.late (2) / lateMax (30) for a human's re-aimed curl only. Lower late for a
  softer flick (1.5 is about 0.37 m from contact).
- test/curve.test.mjs: in process, 750 full-power launches from everywhere curl (bow >= 0.6 m), land within 0.08 m sideways,
  keep the top of the bounce inside 3.25 (the late curl too, c <= lateMax); no curl for n 0.79, a lob, a serve, a block; it
  hooks inward and grows with n. Live: the above (a bet settled at full power bows >= 0.45 m from contact), plus a full-power
  lob and a power-20 drive never carry c. "On the marker" live is sideways < 0.12 m and < 0.3 m in all: the 60 Hz sim sees the
  landing a tick late, up to ~0.25 m along a fast drive whether it curls or not, and a 0.2 m limit failed ~5% of finals.

## 72. A curled shot swoops once instead of zig-zagging (supersedes CURVE.late in 71)
- "The spin curve isn't like a normal mid air curve to-point. It's like a zig zag, which just seems finicky and janky." A human's
  shot only starts curling at the settled re-aim (~100 ms after contact). reaim() solved a banana for the flight that was left (start
  c T / 2 wide of the line, hook back) and easeAim() eased the sideways speed OUT onto it over half the flight while the pull was
  already hooking it IN: straight, jerk out, curve back. test/curve.test.mjs measured it: the sideways speed stepped 0.30 m/s per
  packet against the curl, on every re-aimed curl.
- Now the re-aim never touches the ball's sideways speed. The pull alone carries it from where it is, on the heading it has, to
  the marker: c = 2 (land - x - vx T) / T^2, re-sized every ease tick as the height/depth ease moves T, so it still lands exactly.
  It bends at least CURVE.swoop (0.4 m) of bow over the rest of the flight, the way solve() hooks it (in toward the middle), or more
  if the settled aim needs more bend that same way. The marker moves to where that lands (clamped to |x| <= 2.5). A ball struck
  already curling (a final swing, the bot) is unchanged: that banana is one bow from contact, no zig.
- CURVE.late / lateMax are gone; solve() takes curl 0 or 1 again.
- Measured: curve.test's new check (sideways speed never steps against the curl after the re-aim) is 0.00 m/s, and fails at
  0.30 on 71's code. Bow from contact 0.46 - 0.48 m (was 0.45 - 0.5), landing 0.01 m off the moved marker. reaim.mjs: curled
  hits' sharpest kink p50 0.19 m/s (71: 0.79), straight hits unchanged (p50 0.13). coast, badwifi, bet, kitchen pass.

## 73. The X's hold ring stands clear of the button, so it turns around your thumb
- "The outline around the X needs to be separated from it — that way you can see it circle around your thumb."
- 67 put the ring .4rem outside the button: 53 px round a 44 px button, about 4 px of daylight. A thumb held on the button
  covers all of it, so the one moment the ring exists is the one moment you cannot see it. The gap has to beat a thumb's
  width, not merely exist.
- Now 112 px round the 44 px button — 34 px clear the whole way round — with a faint track under the arc so the groove it
  runs in is visible too. Track and arc both appear only while held; nothing rings the button at rest.
- The button moved up to 2.75rem so the ring's bottom clears the screen edge by 10 px, and the live view reserves 8rem
  (7.75rem on a short phone) so the ring's top half never lands on the notes above. Measured at 844, 740 and 667 px tall:
  ring 112 px, gap 34 px, 10 px clear of the bottom, zero overlaps with anything in the view.
- Fixed while measuring: at the sideways breakpoint (max-height 520) the X is `position:static`, which stopped it being
  the ring's containing block — the ring sized itself against a far ancestor instead and came out 438 px wide, straight
  over the content. `position:relative` sits in the flow identically and keeps the ring anchored. 112 px there too now.
- The whole thing is inside the button, `pointer-events:none`, so a bigger ring never grows the tap target.

## 74. Your own avatar is on the court, barely there
- "Make it so that the court avatar on the player's side is visible, just very very transparent." Your own body used to be
  hidden in your view (only the ghost forearm showed). Now dress() draws it at SELF_A (0.12) opacity: no depth write, so the
  ball, its trail and your paddle show through it, and no shadow (a solid shadow under a ghost read as a bug; the menu's
  shadow hold turns it back off after re-enabling every caster). Its materials stay `transparent` for good, so the split view
  flipping one body between solid (the other half) and see-through (its own half) each frame never recompiles a shader.
- It only had a pose for the remote player; the body block in updatePads() now runs for both, so your ghost stands beside your
  paddle (BODY offset), crouches and runs with it. The Calibrating/Paused tag stays off your own body.
- test/scene-next.mjs now expects your own avatar see-through (not hidden) in pov and split, and passes.

## 75. The server holds the ball: a serve animation, looks only
- "Make an animation when serving... the avatar will hold the ball. Do not change any serving mechanics." Nothing on the server
  changed, and the ball is still drawn exactly where it hangs (SERVE_AHEAD in front of the paddle). Only the body moves to it.
- While a side is serving (the state packet's `serving`, now kept as ball.heldBy), that avatar eases (0.12 s) into a hold: the
  body steps SERVE_STEP (0.35 m) toward the ball, a little in toward the paddle, turns 0.4 rad to it, and the free hand goes to
  just under the ball, palm up. The Mii's hand floats, so it reaches without an arm. The moment the serve is struck the hold lets
  go faster (0.05 s) and the hand goes back to its idle sway. It works the same for you (on your see-through body, 74), the
  other player and Matt.
- The body pose block (updatePads) is the only place it lives; scene-next passes.
