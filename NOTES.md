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

## 76. Settings > Screen > Show player model
- "Add a setting: show player model... off, where it will just be the legacy / original arm and paddle. When it is ON, the arm
  connecting to the hand shouldn't be visible since these guys don't have arms." A switch under Screen, on by default, kept in
  poddle.settings as `body` (stored only when off, like `sound`).
- On: your own see-through body (74) and NO ghost forearm: a Mii's hands float. Off: the original look, your body hidden and the
  ghost forearm from the hand back toward the elbow for context. Only your own seat changes; the other player's model is always
  there. dress() reads scene.setSelfBody()'s flag every frame, so a spectator looking through a player's eyes gets their own
  setting for that view.
- test/scene-next.mjs now expects no forearm with the model on (the default), and passes. Rendered both ways in the preview.

## 77. The settings card scrolls instead of squashing, and Leave court is pinned to its foot
- "The leave court button gets squished with all the settings." The card is a flex column capped at the window's height, and
  flex items shrink by default: once the list (Name, Paddle, Match, Sound, Screen) outgrew a 720 px window, the browser squeezed
  every row to fit and Leave court came out 18 px tall (13 px at 900x560).
- Now nothing in the card shrinks (`.settings > * { flex-shrink: 0 }`): the list scrolls, with `overscroll-behavior: contain` so it
  never scrolls the page. Leave court and the "Online games can't pause" note sit in `.set-foot`, sticky at the bottom of the card
  with a soft fade where the rows pass under it: always visible, always full size (39 px at 1280x720, 30 at 900x560). With neither
  showing the foot takes no room at all.
- On a menu screen (anything but the HUD) the card stops above the screen's footer bar instead of running under it. On a phone
  (<= 520 px wide) the card takes the whole width; it was a 230 px strip. The speaker hint is one sentence now ("Allow audio once so
  the browser can list your speakers. Nothing is recorded.").
- fixes-e2e (the mid-match Forfeit / Leave button) passes; menu.mjs fails exactly as on main.

## 78. Who just arrived: the centre banner for a player, a card on the left for a watcher
- The arrivals from 68 were in the wrong two places: "Sam is watching" sat top-right, under the camera inset, and a player
  sitting down was a bottom toast — the quietest thing on the page. Both moved to where they were asked for.
- A watcher is now a card on the **left edge, half way down** (`.notices`): clear of the HUD corner above it and of the key
  hints / view chips below, sliding in from the left instead of the right. The settings panel takes exactly that space, so
  `body[data-settings]` hides the stack the same way `body[data-overlay]` already did. The server side is untouched (68):
  only the two players hear `{type:'watcher'}`, once per tab, and a reload is not news.
- A player sitting down now drops out of the **centre banner** — the same `.banner-tag` the points use — as
  "<name> joined to play" (`ui.joinBanner`), in the joiner's colour: always orange for a player (it can only be your
  opponent), by side for a spectator. It replaces the `say()` toast at that call site; "<name> left" is still a toast.
- The banner had only ever held "Your point" / "<name> scores". A 12-character name makes it ~2.5x longer, so the pill got
  `max-width:calc(100vw - 2 * var(--edge))` and the inner span ellipses. Shot at 600x900 with the longest name a
  `maxlength=12` field allows: nothing clipped (test/ui-shots, new `hud-arrivals` mock state).
- Found while testing, not caused by this change: **test/menu.mjs part B could not run at all**. main.js has grown imports
  the stubs never gained — `scene.js`'s `shownN`, `scene.audio.*`, and `ui.onEmote / emote / emotesOff / countdown /
  setPing / backLabel`. A missing *named* export fails the whole module graph at link time, so `window.__calls` never
  existed and the run died on its first assertion. Stubs added; part B runs again and 5 older failures in it are now
  visible (settings panel rows, sensitivity keys, the lob gate in 2) — those are somebody else's to chase.

## 79. Nothing is selectable except the codes (and what you type)
- "Make everything EXCEPT codes across the website and phone paddle website unselectable." `user-select: none` (and no iOS
  long-press callout) on the whole of index.html, pad.html, how-to-play.html and 404.html. Inputs, selects and textareas stay
  `text`, or you could not type a name or a code (iOS will not focus an input that inherits `none`).
- The codes are `user-select: all`, so one click or tap selects the whole code for copying: the court code (#room-code in the
  room pill, #title-room-code on the title chip, the share boxes), the share link, the phone's pairing code on the computer
  (#pad-code) and on the phone (#start-code).
- Checked in headless Chrome: computed user-select is none for body text and headings on all four pages, all on every code,
  text on every input.

## 80. "Recentre camera", and the phone and camera sit in front of the pause blur
- Two small asks. The settings row now reads **Recentre camera** (it was "Re-center"), and its toast is "Recentred" — the
  phone's own button keeps the short word "Recentre" because it shares a row with "Calibrate again" and the long label
  wrapped on a narrow phone. docs/ui-spec.md's key-hint and toast lists follow.
- The pause blur is the one shared `.glass` layer (`z-screen - 1`), raised for `[data-settings][data-paused]`. The camera
  and AirPod insets sit at `z-hud`, far below it, so both went milky the moment you paused — exactly the two things you
  look at to line yourself back up. `body[data-settings] .inset` now lifts them to `z-screen`, in front of the blur.
- The settings card is lifted with them. It is `z-screen - 1` like the glass and wins on DOM order alone, so leaving it
  there would have put the insets over it; being later in the DOM it now stays over both where a full-width card and the
  insets meet on a narrow phone. Checked at 1440x900 and 600x900: court blurred, both insets sharp, card on top.
- ui-next fails 9 the same way with these changes stashed and without them (settings rows, Sound, Tab order, hostile name)
  — that is 77's restructure: "Leave court" left `#settings > .btn` for `.set-foot` and a "Show player model" row arrived,
  so the expected row list and the tab order in test/ui-next.mjs are stale, and two tab stops come back empty. Not mine to
  renumber blind: the empty stops look like a real regression rather than a stale string.

## 81. Paddle codes read P-XXXX, and the phone's box has the P- built in
- "Make the paddle codes start with P- then 4 chars of numbers / letters, just so players all know. And if you wanted to enter it
  on the enter screen, the P- is built in before the field." A tab's code is now 4 characters from the same alphabet (no I, O, 0,
  1), shown everywhere as P-XXXX: the set-up screen ("...and type P-ZM8D") and the phone's start view ("Code P-ZM8D"). The QR
  link still carries the four alone (pad.html?k=ZM8D); the phone page also takes ?k=P-ZM8D.
- The phone's code box prints a faded P- inside it and you type the four after it. Whatever arrives comes down to the four:
  typed, pasted as "P-ABCD", or a P typed out of habit before the four (5 characters starting with P). A 6-character code from
  before the switch is still accepted by the page and the server, so a phone paired across this deploy keeps its tab.
- Four characters is a million codes, not a billion, so two live tabs can draw the same one. The server now refuses a code
  another live tab holds ({ type: 'padtaken' }) unless it is the same tab back (same cid); the tab draws a new one, sends it
  ({ type: 'padcode' }) and redraws its QR. test/pad.test.mjs covers pairing on 4, the clash, the re-pick and the same tab
  reconnecting; pad-e2e checks the P-XXXX on screen (its one FAIL, AirPod mode at 1280x720, was there on main). The code never
  breaks at its hyphen.

## 82. A smash takes speed: no swing shape is a smash on its own
- "It is way too easy to pull off smashes just by swinging normally." Then: "smashes are grouped into a very specific arm
  swing, so as long as you keep doing that but with no effort, you get a smash. You need to make that kind of swing variable
  with strength, not just an instant smash."
- The shape was the slow wide sweep, more than the overhead. motion.js scored credit(ROM, rise) x (0.8 + 0.2 x peak/14):
  credit was full from 110 deg and 0.18 s to the peak, and the rate factor stopped at 14 rad/s, so peak rate was at most a
  fifth of the score. A full-credit swing at 8 rad/s was power 32.8, n 0.96. In the recordings (test/effort.mjs, 62 real
  strokes, old power >= 9) every such sweep was a smash, 8 of 8, from 8.9 to 17 rad/s, and across all strokes n and raw rate
  ranked -0.24. The server's overhead bonus (chop > 0.45 and n > 0.55: +0.2) was the second way in: 4 of 12 overheads became
  smashes through it, one at 8.9 rad/s. §8/§12's "rotation speed says almost nothing" was right for telling a flick from an
  arm stroke, and wrong as the whole of power.
- Now power = TAP + 28 x (effortless part + speed part), web/motion.js powerOf:
  - effortless: EASY 0.62 (n 0.62, a drive; SMASH is 0.76) x (0.8 -> 1 as the peak goes 6 -> 15 rad/s) x ease(ROM credit)
    x (time to peak 0.105 -> 0.145 s). A relaxed stroke of any shape tops out here.
  - speed: 0.38 x ROM credit x (time to peak 0.11 -> 0.125 s) x ((peak - 10) / 22)^2. Only a fast peak on a real arm stroke
    adds it. The rise gates are what keep a flick (85-115 ms to its peak, 22-38 rad/s) a tap: FLICK in test/real.mjs is
    still 8/8 soft on first call and final (worst 0.17).
  - The server's overhead bonus is gone. An overhead smashes the way everything does, by its speed.
- The same shape now scales with speed (n; * = smash; before -> after):

  | shape (deg / s to the peak, chop) | 8 | 12 | 16 | 20 | 24 | 28 | 32 rad/s |
  |---|---|---|---|---|---|---|---|
  | slow wide 178 / 0.338 | .91* -> .52 | .97* -> .58 | 1* -> .65 | 1* -> .70 | 1* -> .77* | 1* -> .87* | 1* -> 1* |
  | overhead 127 / 0.359, .73 | 1* -> .52 | 1* -> .58 | 1* -> .65 | 1* -> .70 | 1* -> .77* | 1* -> .87* | 1* -> 1* |
  | overhead 100 / 0.198, .49 | .99* -> .51 | 1* -> .57 | 1* -> .63 | 1* -> .68 | 1* -> .74 | 1* -> .83* | 1* -> .94* |
  | overhead 92 / 0.311, .82 | .89* -> .49 | .94* -> .55 | .96* -> .61 | .96* -> .64 | .96* -> .70 | .96* -> .78* | .96* -> .87* |
  | overhead 82 / 0.157, .72 | .41 -> .45 | .43 -> .50 | .45 -> .55 | .45 -> .58 | .45 -> .63 | .45 -> .69 | .45 -> .77* |

- Recordings, before -> after (node test/effort.mjs): smashes 15 (24 %) -> 5 (8 %) of 62 real strokes; smashes slower than
  the median stroke (12.9 rad/s) 9 -> 0, slower than p75 (23.5) 13 -> 0; slowest smash 7.7 -> 26.8 rad/s; slow wide sweeps
  8/8 -> 0/8 smashes, n now 0.54 -> 0.66 as raw goes 8 -> 17 (rank 1.00); rank(n, raw) -0.24 -> +0.21 overall, -0.19 -> +0.04
  among overheads. Flicks promoted to shots: 0 -> 0. Real-stroke n p25/p50/p75/p90 .25/.44/.79/.97 -> .36/.48/.55/.60: a
  normal stroke is a drive. test/kinds.mjs (its own replay, 67 strokes of new power >= 9): smash 7 %, was 11-24 % in §§ 1-70.
- Phone: PHONE_GAIN (1.5) used to multiply the SCORED power, so a phone smashed from AirPod-equivalent power 18.2, 32 of 62
  strokes (52 %), and its TAP floor reached the server as 9 (n 0.11: every twitch a drive). Now main.js sets motion.js
  RATE_GAIN = PHONE_GAIN, which scales the rate only the effortless part reads: a relaxed phone stroke is a drive a little
  sooner (n .58 vs .52 at 8 rad/s), and the speed part reads rate x sqrt(RATE_GAIN), so a phone smashes from ~19 rad/s
  (an AirPod ~23.4): still a hard swing, never a relaxed one (5 of 62 on both paths, slowest 26.8). pw() now scales only 'raw', which the serve's raw x travel term reads. Phone rates are still unmeasured.
- test/real.mjs re-specified: FLICK n <= 0.25; WIDE (< 16 rad/s, >= 100 deg) a drive, 0.45 <= n < 0.76 (was n >= 0.55): 6/6
  first call and final; FAST wide (>= 16 rad/s) a smash: 1/2 (29 rad/s settles 0.91; the 33 rad/s one settles 0.39, its peak
  is timed wrong, below).
- test/reaim.mjs (my hits bent after contact): 17 -> 14 re-aimed, 0 twice; landing moved p50 1.06 -> 0.51 m; sharpest kink
  p50 0.19 -> 0.15, p90 0.44 -> 0.36 m/s. test/latesmash.mjs: 8 -> 6 movements hard enough to smash, all called on the settled report.
- Tests that read the chop rule out of game.js (kinds, lobdata, effort, lobsynth) fall back to no bonus. test/effort.mjs stays as
  the tool for this: it snapshots each settled swing, reproduces motion.js's power exactly (or throws), and keeps the OLD
  formula (oldPower/oldCredit) only to fix who counts as a real stroke. lobsynth's phone grip now goes through RATE_GAIN.
- Known limits: strokes that reach their peak in 112-122 ms, like a flick, get little of either part even at 32 rad/s (n
  0.13-0.55), and several of the hardest recorded swings are among them; the data cannot tell them from flicks. The knob is
  PACE_T's start ([0.105, 0.03] lifts them, and labelled flicks to 0.32-0.46). Early bets on wide swings now come out ~0.51, so
  settled re-aims go up more often. pad.js's ring word now says "Smash" from 20 rad/s of the phone's own rate (it said so from 18;
  nothing under ~19 phone rad/s can smash). It is still a speed meter, not the game's call.
- Phone: the speed part takes only sqrt(1.5) = 1.22 of the gain, a guess between "a smash is the same physical rate" (the phone
  might never get there: "nobody whips a phone round at 30 rad/s") and the full gain (relaxed phone strokes smashing again). Unmeasured: record a phone session.

## 83. Spin is deliberate: a real wrist cut, scaled by how fast you swing
- "It's super easy to effortlessly put spin on things even when I'm not trying to slice at all... dial back that spin
  distribution, hone in on a SLIGHTLY more slicing motion, and that can also variably ramp up in strength by motion strength /
  speed." Measured before (test/spin.mjs, 63 real strokes of the four recordings): the median stroke left with spin 0.26, 92 %
  drew the swirl, 27 % flew as a slice, 51 % kicked more than 0.8 m/s sideways off the bounce, and the no-slice set
  (live-swings: flicks and wide arm swings only) had 50 % over 0.3. Spin did NOT follow speed (median 0.24 under 9 rad/s, 0.33
  over 27). Two leaks: `turn` is a path integral of axis wander, so any long or fast swing built it up (0.77 rank correlation with
  raw rad/s); and a plain wrist roll of 0.3-0.5 already earned 0.2-0.45. A smash's pronation read as spin too (synthetic 0.67).
- web/main.js only. Intent first: |roll| through a soft knee 0.40 -> 0.58 (ordinary strokes sit at 0-0.46, a real slice
  0.50-0.62), or |curl| PER RADIAN swept (knee 0.35 -> 0.60) in place of `turn`. Roll that comes with a downward chop
  (0.5 -> 0.8) is overhead pronation and is faded out, so a smash leaves clean. Then speed scales what the intent earns:
  x0.85 at 8 rad/s up to x1.40 at 20 (e.raw, the raw peak; not power, which the smash work owns). The 0.85 floor is for the
  phone: e.raw is unscaled for it and a phone is swung slower; a forehand slice at raw/1.5 still reads 0.48, a slice 3/5.
  Still CONTINUOUS (18/19): no gate, the knee plus the speed scale spread it p75 0.13 -> p90 0.91.
- After, same 63 strokes: p25/p50/p75/p90 0/0/0.13/0.91 (was 0.13/0.26/0.55/0.80); exactly 0: 71 % (was 5 %); swirl 29 %
  (was 92 %); labelled slice 17 % (was 27 %); kick > 0.8 m/s 22 % (was 51 %). No-slice set: over 0.3 0 % (was 50 %), labelled
  slice 0 % (was 10 %), swirl 20 % (was 100 %). Synthetic drives 0.00; synthetic smash 0.17-0.20 (was 0.67); forehand slice
  0.54/0.55 AirPod/phone (was 0.45/0.46), slice 3/5; backhand slice 0.96; a light 60 % slice is now 0 (intended). At a fixed roll
  of 0.52 the spin ramps 0.63 at 8 rad/s, 0.78 at 12.5, 1.0 at 27; across all strokes the rank correlation with speed stays ~0,
  because the roll share falls as speed rises: the ramp shows only at fixed intent.
- Unchanged: server sliced()/SLICE/CURVE, scene.js SPUN, the bots' 0.9, the roll lob veto below the block (55 holds: a backhand
  slice still never lobs). test/slice.test.mjs passes as is.
- Costs: the purple smash ring (spin > 0.3) will rarely fire now (13 and 50-53 said a smash keeps its spin). Re-aims on the
  settled report rise, about 12 -> 16 of 63 in the audit that picked this rule (bet vs settled spin differing by > 0.2, game.js re-aim): early bets see the roll share still building. The rule reads e.chop and e.rom, so re-check
  with `node test/spin.mjs` if motion.js changes how chop is measured. The hard-drive AIR curl (71/72) is gated on power, not
  spin, and still bends 22 % of real strokes (60 % of the no-slice set); players may read it as spin.
- Early bets (review fix): the hit launches on the EARLY report (e.final false, 20-80 deg swept), whose roll share is mostly
  wind-up pronation. Ungated, the new rule gave 0.6-0.9 spin to 10 of 63 real strokes that settle at 0 (the old rule: 0), so
  the ball left spinning and was un-spun by the re-aim, or kept it past FIX_WINDOW. A bet now earns spin only as it sweeps
  60 -> 100 deg (`bet`); settled reports are untouched. Spurious bet spin 10 -> 0, bet-vs-settled differences > 0.2 16 -> 14;
  the cost is that 12 real slices leave flat on the bet and gain their spin from the settled re-aim (inside 0.25 s).
- test/spin.mjs is the audit: it replays the recordings with the client's and server's own maths (sliced out of their files),
  prints ingredients, correlations, what the player sees, and the synthetic lobsynth anchors; `--candidate x.mjs` scores a
  rival rule side by side.

## 84. Courts: one list with search and Open | Full, a code to Join or Watch, asking to play against Matt, and a Tour Matt
- "Consolidate the court button and enter code area into one button... a proper court list that is searchable by code name,
  but also filterable by a simple switch between open / full courts (for those who would like to watch)... spectators should
  also be able to join as players if they're spectating a bot match, by sending a request to the current player." The home had
  two ways in (Enter code, Create court) and a strip of at most 12 rows; a court past the twelfth could not be found at all.
  Spec: docs/COURTS-TOURNEY.md (Feature 1 and the Tour bot: BUILT; Tournaments: NEXT).
- Home is three tiles: Quick play, Courts ("{n} open" in a corner badge), Play a bot. Courts: search by code (upper-cased,
  substring, prefix matches first), Open | Full (Open = open courts, tournaments and Ask to play rows; Full = two humans, the
  row itself is Watch, "Stands full" when nobody else fits), counts that follow the search, every row (no cap; the list box has
  ONE height in every state so nothing below it ever moves), the four code boxes with Join and Watch side by side, Create court,
  and Create tournament shown but aria-disabled with "Needs at least 4 players. Up to 16. Tournaments are coming soon." so the
  layout does not shift when it arrives. Back from Create court or Your court goes to Courts. `/`, Esc-clears-first, arrows.
- Asking to play (docs/SPECTATE.md): the rule is "a ball has been struck", not "Matt is seated". The server seats Matt within
  2.5 s of nearly every lone human, so with the naive rule a friend's code during the share screen would become a request and
  Quick play would never pair two people again (test/joinreq.test.mjs case 1 guards that). One request per court, 10 s, silence
  is a no, a 10 s cooldown counted from the END of the request (so an expiry still shows its cooldown), 3 s between two
  requests, 60 s for the new player to get a paddle ready or Matt comes back at the level he had. The cooldown is keyed on the
  cid AND the address (loopback skipped): on the cid alone a new cid, or none, got round it. It is charged for a no, an expiry,
  walking out mid-request and a demotion, never for a `gone` the court caused (the player dropped or reloaded, the match ended):
  a clean reload closes the old socket first, so the seat goes into a hold and the request ends, and the requester was being
  fined for it. If the one who said yes leaves before the new player is ready, `promo` is dropped: the court's only human is
  never demoted (it used to be, leaving Matt alone in a court that then closed). After a restart a revived Matt match with points
  on the board is under way at once (`resumed`), or a stranger could sit in Matt's seat and wipe a 7-5 while the host recalibrated;
  when a spectator's tab rebuilds the court first, the player arriving with `back=1&bot=` gets Matt back at that level and the same
  flag (`mattBack`; before, Matt came back at Club after 2.5 s). The address key is global: a neighbour behind the same NAT who
  asks within 10 s of a no waits too, a small price against a requester rotating cids. A demotion counts as under way too
  (`resumed` set after Matt is back): addBot restarts the match with nothing struck, so the court used to list as open, and the
  demoted spectator (or anyone) could press Join and sit straight in Matt's seat with no request, again and again, while the
  serve waited for the host's swing.
  The player's card is bottom-left, outside #hud, one row (question beside Accept / Decline, about 5.5rem tall, below the near
  baseline), beside the settings card when that is open, stacked narrow in the margin left of the result card, up under the
  Court pill in portrait and in a short landscape window (1280x720: bottom-left covered the near baseline there), just above
  the key strip at phone width; never takes focus, Y / N only while it shows, Accept is the blue primary. The requester's button
  (16rem) sits on the bottom row left of the emotes (above them it sat on the near baseline and corner), takes the emotes'
  corner while a toast hides them, and counts down in place with two words for two clocks: "Waiting · 8s" (the player's time
  to answer), "Again in 7s" (until you may ask), then "Ask again". The why, with the player's name, is a toast: "Lu said no",
  "No answer from Lu", "Someone else asked first" (the same "· 7s" used to mean both clocks, and a name would not fit at 390 px).
  While it cannot be pressed it looks it.
- Tour: a fourth Matt between Club and Pro on every stat, APPENDED at BOTS[3] so revive's `bot=0..2` keep their meaning; listed
  Rookie, Club, Tour, Pro everywhere (keys 1-4 send 0, 1, 3, 2; B walks the same order; `botinfo.order`). Tournaments will use it.
- Courts QA pass: Open lists tournaments, then courts with someone waiting (Join is instant and never refused), then ask rows,
  then empty courts (ask-first buried every waiting human below the fold with a busy list), and the list fades at the
  bottom (with room to scroll the last row clear of it); every Join sits in one column (a row with no Watch keeps its slot); the counts read "–" while loading or down; "Can't
  reach the game" hangs on the header edge and moves nothing; an error hides the code hint instead of sitting on it; Open empty
  with courts to watch offers "{n} to watch in Full"; a row with Watch says "Right arrow to watch"; the Ask to play pill (#b23f0a)
  and .court-meta (--ink) pass AA; nothing on Courts, the card, the button or the Courts tile under 12 px at the 10px root
  (Accept / Decline, Open / Full, "8 open" and "Court not found" had slipped under it; verify.mjs now measures it at 600x900
  and 390x844); Matt's four levels on one baseline.
  The mock's emotes load (ui.js resolves emoji/ from its own URL).
- A spectator's first botinfo no longer toasts "Matt · Pro": it landed in the same breath as "Ann is playing Matt. We asked if
  you can play." and wiped it (the e2e caught it with a toast recorder); the scoreboard already shows the level.
- Tests: test/joinreq.test.mjs (every row of the race matrix a socket can drive, plus: the match ending mid-request, the gap
  between requests, the host leaving before the new player is ready, a demotion's cooldown, no cooldown for a host drop, the
  cooldown on the address with a new cid or none (fly-client-ip), and a demoted court staying Ask to play until the next strike),
  revive.test (a stranger joining a revived Matt match watches and asks), bot.test (Tour, the order, every Tour stat between
  Club's and Pro's; a return-rate run was left out: a scripted rally with the rubber band is too noisy to rank three levels),
  rooms.test, ui-next (the Open order, 42 rows and search finds the 42nd, down and loading each with their own copy and skeletons,
  a watch link focuses Watch), menu (End / Home / Right / Left; part B runs again: its scene stub lacked setSelfBody, so main.js
  threw on load and B stopped at B1; ?court=&watch=1 with no name lands on Courts), verify.mjs (a gate
  now: one list height in every state, the card takes no focus or key, Y / N only while shown, the bar reaches 0 under reduced
  motion, #btn-ask one width and nothing cut at 1440, 600 and 390, the card off the court at 1280x720, AA contrast, 44 px
  targets and the 12 px floor, no-match and Full-empty in the one-height loop), shoot.mjs (the OVERLAP check also against
  settings, board, corner, watchers, the insets, the result card and the notices, and the button against the toast; also shot at
  820x1180 and 390x844), spectate-e2e (Cat asks Ann with A, Ann's Space and Enter answer nothing and the ball is still struck
  while the card shows, N, "Again in" and the "Ann said no" toast, the cooldown, Ask again; then Ann moves to a public court,
  Cat types two letters in Courts, finds its one Ask to play row, walks to it and presses Enter: watch + ask with its toast; Y,
  she calibrates and plays Ann), fixes-e2e and revive-e2e run and pass.

## 85. Pickers slide: one thumb glides between options, and the switches spring

Every segmented picker (Phone | AirPod, Open | Full, Public | Private, Body | Auto, the bot difficulty) used to jump: the highlight was painted by
the checked option itself, so a change of pick redrew it on the other side. Now each `.seg` draws its pick once, as `.seg::before`, and ui.js
measures the checked option into `--tx --ty --tw --th`. The options differ in width (Rookie and Club, 'Open 12'), so the thumb is sized
from the option, not a fixed offset. One MutationObserver per seg (attribute `aria-checked`) catches every place ui.js sets a pick, and a
ResizeObserver re-measures when a hidden seg shows (settings closed measures 0: the first placement never animates, so it does not fly in from
the left). The move uses `--ease-bounce` for a small overshoot; the option only fades its ink. Until ui.js has placed the thumb, the option
paints its own pick as before. Pressing an option dips it to 95 %.

The on/off switches already slid (160 ms); the knob now springs (360 ms, overshoot) and stretches while pressed. Under macOS Reduce Motion
the global rule in ui.css still cuts every transition to 1 ms, on purpose.

## 86. No helium lob: height is never eased, a lob goes up once and then falls like a ball

"Sometimes the ball still floats up like it's filled with helium ... like a bell curve rather than a normal parabola." Cause, found by
four independent investigations and confirmed by four verifiers with the real `solve()`: a scoop meets the ball on its **bet**, and at that
point the upward share of the stroke is still low (synthetic lobs bet lob 0.12-0.47, so `lofted()` is 0 and it flies as a drive). The
settled report arrives 60-280 ms later with lob 0.65-0.78, and `reaim()` handed `easeAim()` a lob solution with vy ~8 m/s against the
ball's ~1-3. The ease blended ball.v onto it in equal shares over 27 ticks (0.45 s), so vy **rose** the whole time: net +6 to +14 m/s^2
against gravity, height flat, then climbing faster and faster, then a rounded top. That is the bell. It hit every lob that met the ball
before its settled report (10 of 10 synthetic lobs); a lob that settled before contact launched clean, hence "sometimes". Smaller copies of
it: re-aims took a fresh full T from where the ball was (every corrected drive floated at under half gravity for 0.45 s, 30 of 75
recorded bet hits), and `fly()`'s net loop could hop T by 0.05 mid-ease (a one-tick +29 m/s^2 spike on a few hard drives).

Now (server/game.js):
- `launch()` remembers where and when the ball left the paddle (`ball.from`).
- `reaim()` flies what is LEFT of the settled shot struck from there (`remaining()`): a lob gets the clean lob's apex from where the ball
  is (`vy = sqrt(2 g (H - y))`), anything else keeps the height it has (`min(clean T - elapsed, when it lands as it flies)`), and only the
  net may ask for more, checked at the slower of the pace it has and the pace it eases to. If that needs more vy than the ball has, it
  gets it in ONE step, now.
- `easeAim()` never touches vy: it reads the landing time off the ball's own ballistic height every tick and eases only x and z onto the
  marker (the swoop's curl as before). After the re-aim tick vy only ever falls at g.
- The re-aim's `launch` packet carries `p v t`; web/scene.js takes them at once (as it does for `hit`), so the step is drawn on that
  frame, not pulled in over the next state packets.

The trade: a lob struck on its bet shows one upward kink 60-250 ms after contact (vy +5 to +7.7 m/s), then a true parabola to a 4.1-4.5 m
apex. A drive re-aimed to a drive or into a smash never steps; a hard bet that settles as a tap steps +0.5 m/s, only what the slower ball
needs over the net. `test/helium.test.mjs` (real server): lobs rise once and never again, still lobs (apex > 3.3), drives and smashes never
step, a clean lob never rises, every re-aim lands within 0.15 m of its marker. The real cure for the kink is upstream: the bet
under-reports lob (motion.js: the upward share of a scoop is still low when the peak is predicted) — not touched here.

## 87. Tournaments: a code on the host's screen, people stream in and warm up against Matt, a knockout bracket to a champion
- "In the courts area you can create a tournament. Put a disclosure that it will require a minimum of 4 players. Basically you
  have a code up on your screen like Kahoot... then you let people just stream in. In the meantime, you get put against Matt...
  notify the players that they are waiting for the tournament to begin; and show a number count... even number of people not
  required; a bot will autofill in. The Tour bot is the one used in tournaments. Anything not mentioned, take from existing sports
  tournament games like Wii Sports." Spec: docs/COURTS-TOURNEY.md 4 (4.9 server as built, 4.10 client as built).
- Server (server/game.js, a section after `quick()`): 4-16 players, single elimination; an odd count gets one Tour Matt, paired with
  a person first (Matt v Matt only where Matts outnumber people, settled at once by a coin flip); round names Final / Semifinal /
  Quarterfinal / Round N; first to 7, the final to 11, win by 2, a golden point at 15; Matt at Tour with no rubber band; no rematch
  vote. `TOUR_CAP` 2 tournaments standing, one per address. Courts and tournaments share one code space. Every tournament court is
  private with no owner address (never counted by `ADDR_ROOMS`); a match court is never swept idle; warm-ups are best effort under
  `ROOM_CAP - 4`, and `tourKeep()` holds back the courts the next round is owed, so `ROOM_CAP` stays hard between rounds. A drop in a
  match is held `HOLD_S`, a `leave` is a forfeit at once, a no-show loses after `TOUR_VS_S + TOUR_ARRIVE_S`, and a seated player who
  never gets a paddle ready loses at `+ CAL_S` (without that the round hung). Nothing of a tournament survives a restart: a reconnect
  with `&tour=` gets `tourend restart` (then `gone`), and no court of one is revived. Cids never leave the server (the test greps every
  payload). Protocol: docs/ROOMS.md, docs/SPECTATE.md Tournaments, docs/API-NEXT.md 9.
- Client. Courts: Create tournament is live, the disclosure "Needs at least 4 players. Up to 16." stays under it ("Your tournament" once
  in one); the list shows sign-ups with a gold Tournament badge. The host's screen (lobby view `tour`): "Join at poddleball.com with code" ("Join in Courts" on localhost), then the code in four huge boxes
  (click copies it: "Code copied"), Copy invite ("Join my Poddle tournament! Code K24M: link", "Copied" for 1.5 s; "Copy code" on
  localhost), the count in big numbers that pops once per join (not under reduced motion), name chips that pop in (Host, You,
  Reconnecting dimmed, dashed places up to 4, "+N more"), the reason ("Needs at least 4 players · 1 more", then "Ready when you are.",
  "Full: 16 players"; the rules line names Matt's odd spot), Warm up with Matt, and Start: disabled with its reason below 4, then the big gold
  "Start with 5 players". Joiners come by the row, the code or the link, get "You're in. Warm up with Matt while people join." and a
  warm-up court against Tour Matt; the corner pill says "Waiting for the tournament to begin · 5 joined" ("Waiting" over "5 joined" under 900 px; T opens a card with the code,
  the invite, the names and the host's Start; it pauses the warm-up), "Ben joined the tournament" slides in, and the host gets a gold
  Start beside the pill from 4 (it opens the card on the card's own Start: never one tap mid-rally). Then Wii Sports: a VS card ("Semifinal · Match 1 of 2", You VS Ben, "First to 7, win by 2") for
  `TOUR_VS_S`, the match (pill "Semifinal · vs Ben", Leave reads Forfeit, no pause, no 1 2 3 4), a result with no vote ("On to the
  Final", "Out in the Quarterfinal", "Through: Ben left") and See bracket; the bracket between rounds (a column per round to the Final,
  your path lit, Matt with a Tour tag, winners with a gold keyline, "(left)" on forfeits, live scores with Live and Watch, "Final in 4"
  with a draining bar, one round per tab under 700 px); the eliminated watch the rest (T or Esc back to the bracket); the champion
  card for everyone (gold ribbons, a trophy medal, "You're the champion!" or "Di is the champion!", the road to the title as chips,
  confetti twice, Back to courts and See bracket). "The tournament ended: the server restarted" (or everyone left, it never started,
  this tournament has ended) is a notice above the lobby's choices.
- Glue that mattered: `tour`, `tmove`, `tourfail` and `tourend` are heard ABOVE the no-room guard (between rounds nobody is in a court);
  `closed round|tourstart|tourend|empty` is quiet and `toLobby()` lands on the code screen or the bracket with the tournament's code back in
  the address bar (a reload rejoins by cid); a tournament court shows and copies the TOURNAMENT's code, while `room` keeps the private
  court's code for the reconnect URL (`&tour=CODE`, never `back=1`); a `room {kind:'match'}` that arrives while watching is my match;
  the champion card leaves the final's court first, or its `closed round` would take the card down; the pause-heal loop counts the
  tournament card, or it unpaused the warm-up within a second. An end-of-line comment in the botinfo handler swallowed its `else if`
  (the NOTES 64 trap again): menu.mjs caught it ("Matt · Club" never toasted).
- The lobby's first focus now tries again (up to 4 times, 100 ms apart) when the element refuses it: under reduced motion the lobby
  screen turns visible a frame late, and the host's Copy invite never got focus in the verify run.
- A tournament never reaches into an ordinary court: a member off playing Quick play between rounds gets the champion and a
  `tourend` as toasts (they were pulled off their court), a finished tournament stops steering the lobby, the address bar and the
  reconnect (`&tour=` of a deleted one answered `tourend gone` and kicked them out), and Back from a finished bracket lets it go. On
  the server, `tourRebind` now gives an ordinary court's seat back on a reconnect that carries `&tour=` (it returned before reading `&room=`).
- Tests: test/tourney.test.mjs (143 checks, eight servers on 8614-8621; the ordinary-court reconnect added), test/tourney-e2e.mjs (new, 8622-8624: four Chromes through
  create, three ways to join, the banner to 4, Start, VS, a round, the bracket, a loser watching the final, the champion with confetti,
  Back to courts), menu.mjs B6 (the glue above), verify.mjs (44 px, the 12 px floor at 600x900 and 390x844, AA contrast on every new
  screen, a join's count, chip and first focus), shoot.mjs (21 tournament states, OVERLAP of the pill, the Start button and the card
  against the scoreboard and the insets). The gates found: text under 12 px on the card, the tabs, the ended OK and the road chips;
  targets under 44 px on the tabs and the result buttons; ink-soft and warn-deep at 4.2-4.4:1 on the panel's lower half and the gold
  card; the Paused tag showing under the tournament card; the corner pill running under the scoreboard at 600 px.
- Review round. Server: a stall against Matt froze the bracket (slowSeat only ran with two humans; now a tournament match too: CAL_S,
  `closed away`, Matt through). A held seat locked out the late opponent for good (`free()` is false while a seat is held; a drawn
  member now sits in their own empty seat regardless: `drawnFree`). `&room=` of a court that has closed (a warm-up closes with its
  socket) was taken as an ordinary court: `joinfail` and a false "Court closed"; now it is the tournament's own (`closed round`, then a
  new warm-up). A Watch on your own drawn match seats you (from the stands you lost by no-show). Both finalists leaving in the gap
  crowned a member who had quit: Matt takes it. A member on an ordinary court after a restart got `tourend` and a frozen court: the
  client now reconnects without `&tour=` (back=1) and the court comes back like any other (`tourend` still revives nothing itself).
  Client: the phone pill says "Waiting" over the count; the bracket's first focus and arrow moves scroll the card clear of the sticky
  header (focus was clipped at 1440 and 1280); the tournament card gave focus back to nobody on close (it hid before asking where
  focus was): the pill gets it now; one glow at a time on the host screen (Copy invite alone, then Warm up, then Start); "Bracket in 6";
  "First to 11, win by 2" on the final's VS card; "Tap the code" on touch; 12 px on the code label, the Tournament badge (its row takes
  the empty Watch slot on a phone), the VS lines, the join notices (which sit above the key hints on a phone, not across the net); the
  card's Start and Leave one 44 px height; a deep red live dot; Leave right-aligned; the ended notice and the champion title no longer
  break badly. Tests: tourney.test adds the warm-up blip, the held seat, twatch of your own match, both finalists gone, a stall
  against Matt, a whole win-by-2 match and the 7/11 defaults (P_GOLD, P_DEF); verify.mjs runs 44 px at 1280x720 too, the small caps
  have an 11 px floor (no longer exempt), adds the courts, banner, VS, win and in-match states, first focus inside the bracket's
  scroller, the narrow pill's words, Esc/T on the card, the ended words, and a reduced-motion check that can fail (it ran frozen, so
  the pop was over before it looked); shoot.mjs keeps the query key in the file name (tourney-intro-bot-1, tourney-intro-final-1) and
  adds the in-match mocks.
- Second review round. Server: a viewer of a sign-up was signed up (and put in a warm-up) by any reconnect, and at 16 the `tfull`
  answer tripped the client's hang guard into "the server restarted": a viewer now reconnects with `&watch=1` (no `&room=`) and
  `tourRebind` keeps them a viewer. A full match could hang before its first ball (readyBy fires once a round, slowSeat only ran once
  `started`): C in the 3-2-1, a reload or `cal:true` after readyBy held the bracket for ever; slowSeat now runs before the first ball
  too when both seats are filled (never for a lone seat waiting on a no-show). Its CAL_S runs from both seated, so it usually fires before
  readyBy; with both unready it puts out the first one it finds (readyBy gave side a the win). Client: a player who is through lands on their OWN card
  (focused, ringed, clear of the sticky header), not the first live Watch, which pushed their card under the header at 1440 and 1280;
  a viewer and a player who is out still land on Watch. The bracket's cards sit in equal rows (grid, as tall as the column's live card;
  one round per tab stacks them at their own heights), so the connector lines meet the next round; "Live · (eye) 3" instead of "Live · 3 wat…" (the Watch label says "3 watching"). The
  bracket's leave reads "Stop watching" / "Press again to stop watching" for a viewer. Keyboard focus on the code screen and the card
  is an outline, the halo is only the one button to press next (Copy invite's focus halo plus Start's glow made two). The HUD Start is
  labelled "Start tournament with 5 players", opens the card on its Start, hides while the card is open, and Tab stays in the card.
  The code screen says where to type the code ("Join at poddleball.com with code", --t-xl). Tests: tourney.test adds the viewer
  reconnect and the unready-before-the-first-ball forfeit; verify (k) checks your own card is first focus and clear of the headers,
  (o) the Stop watching labels. Not done: the 12 px floor at 1280 (--t-xs is 11.1 px there by design everywhere), the global Back / menu
  button sizes (pre-existing chrome), and Esc on the host screen in the mock (main.js's `back()`; the mock has no main.js), and a real server restart in tourney-e2e (tourney.test covers `tourend restart` on the wire, menu.mjs B6 the call, verify.mjs the words).
## 88. Motion everywhere: menus settle, tiles play, lists glide, the HUD pops, the phone page springs

A sweep for anything that snapped. Rules kept throughout: playful hover only under `@media (hover:hover)` (no sticky hover on phones);
hover uses the individual `scale`/`translate`/`rotate` properties so it composes with the `.is-focus` breathe animation on `transform`;
transition lists are extended, never replaced; anything on screen during a rally animates transform and opacity only, no new blur;
the global reduced-motion rule still wins.

- Menus: screens settle in from 1.015 as they fade; headers drop in; deeper lobby views slide in from the right, Back from the left.
- Buttons grow a little on hover, squash on press, fade when disabled. The Back chevron leans back.
- Home tiles deal in left to right; hover lifts and tips them with a sheen, and each icon plays (Quick play's arrow nudges, the Courts
  magnifier swings, the bot tilts and blinks). Keyboard/gamepad focus plays it once. Title letters pop in, the ball drops and hops.
- Courts: new rows rise in, rows below glide up when a court closes, counts hop, code letters pop, errors drop in; copy menus unfold;
  bot cards each move their own way.
- Settings card grows out of its button and back; switch colour fades; HUD labels, toasts, seat-hold and ask cards spring; the scoring
  side sweeps, the serve ball hops sides; spectator view chips get a sliding highlight; the result card lands in steps.
- pad.html: views rise, buttons spring, hold bars drain instead of snapping, a bad code shakes. How to play: cards rise in on scroll.
  404: the headline flies in.

test/ui-next.mjs waits a little longer at four places for the new fades (lobby-first, the Watch prompt close, hold(null), Quick play's
opacity); the checks themselves are unchanged. `#courts-n` hides with an `is-off` class and keeps its last text.

## 89. The bet knows a lob: a pendulum's first report looks ahead

The upstream cure NOTES 86 left open. Bisected: the kink is d6c958a (NOTES 55), where lob moved from the rotation axis (the bet read a
scoop 0.80) onto the hand's path. At the bet, 30-100 ms before contact, a pendulum's hanging hand is near the bottom of the arc and still
travels mostly FORWARD, so its path so far reads up 0.12-0.47: the ball left as a drive and the settled report (0.65-0.78) re-aimed it up.

Now (web/motion.js): until the peak, a stroke that turns about +R (>= 0.6 of the rate) with little turn about the forearm itself
(|twist| <= 0.45) and a hand that is no longer coming down (upward share of its travel >= -0.3) is a pendulum, and its hand is carried
on round the same axis at the same rate for 2.4 rad (a scoop's arc from the bottom). The lob is the upward share of the path so far plus
that, never less than the path alone. A fixed angle, not a fixed time: 0.2 s looked too little ahead for a slow scoop (a wide lob bet
0.73 on the phone) and wrapped a fast one over the top (0.3 s: fast lobs bet 0.53-0.70). The look-ahead weighs as many samples as it
lasts at the stream's usual step (a running mean of dt), so the phone (60 Hz, also tried at 30 and 100) and the AirPod read alike.
Later reports keep that lob while the whole stroke still reads as a pendulum: a quick scoop whose settled report comes after contact
counts the dip through the bottom too (0.53-0.66 up, a drive), and the lob must not be taken back once the ball has left.
Not pendulums: a backhand slice or chip also turns about +R, by rolling the forearm (twist 0.75-0.95, hand going down); a waggle down
from behind (two real captures, hand falling at -0.65 and -0.85: without the third gate they bet lob 0.76 and 0.93).

web/main.js: an early report on a pendulum is faded by the smaller of |roll| and |twist|, not |roll| alone: a wide underhand swings its
hanging arm across as it comes up, which is roll about the forward axis (0.5-0.7 at the bet), not a wrist. The swingEnd stand-in (never
fired: 0 of 443 synthetic and 142 real swings end without a settled report) sends the path as it was (lobRaw), not the look-ahead.

Measured (`test/lobbet.mjs`, new: 12 seeds x both grips, plus the real captures): wide, straight and a-third-quicker lobs (new
`fast_wide_lob` / `fast_straight_lob` in test/lobsynth.mjs) are lofted on the bet (up 0.86-1.00, was 0.00-0.61) and on every report
after it; slices, chips, drives and smashes are never lofted on any report; dinks stay lofted. Real captures (143 swings: data/ and one more
AirPod session): no bet newly lofted, none lost. Later reports of a lob raise underhand() by at most 0.023 (the bets sit at >= 0.88, where
it is saturated). The trade: a pendulum that stops at or below level (a flat underhand push or serve, synthetic only) is bet a lob too
(4-5 of 9 wide ones swept 90 deg); nothing at the bet tells it from a scoop (same speed, 7.5-8.6 vs 7.7-10.6 rad/s, same place in the arc).
FAST straight lob settles as a dink 5/8 in lobsynth: its power, not its lob.

## 90. The ball is sealed at contact: after the paddle, until the first bounce, it only ever falls (server and screen)

"Lobs get a boost upwards after contact, helium." NOTES 86 took the ease out of the height but kept one step: a scoop struck on its bet
(the upward share is still low then, a drive) and settled 60-250 ms later as a lob was handed the lob's apex in one go, vy +5 to +7.7 m/s
in mid-air. Smaller copies: the re-aim's net loop gave a hard bet that settled as a tap up to +1.2 m/s, and the settled spin was swapped
in mid-flight, so gravity got lighter. The cause upstream is the bet (motion.js reads the upward share at bet time; another branch), but
nothing in the air may lift the ball whatever the reports say.

Now (server/game.js):
- `reaim()` is the one choke point (the rally fix, `fixBlock()`, the late push, the serve's settled swing and the legacy no-`final`
  client all come through it). The ball's vy, its spin and so its gravity are the paddle's. A re-aim moves only the landing: x and z are
  eased onto it in the hang the ball has left (`fallLeft()`), so the time is the ball's own. `remaining()`, `ball.from` and the step are gone.
- The net is never cleared by adding height. The pace eases from the one it has to the new one, so it crosses between the two and both
  must clear; a settled landing the sealed ball cannot reach over the net is moved deeper (the only way a fixed hang crosses sooner, so
  higher), and if none works it flies as struck. Either way the marker goes where it really lands (`ball.land`).
- The kick (the first bounce's sideways throw) follows the settled swing's way, sized by the spin the ball really carries: it never
  touches the flight.
- A lob carries no lift: `solve()` fades the in-air spin out as the shot turns into a lob (lofted 0.3 -> 0.5 of the way), so a lob is a
  plain parabola at G. `sliced()` is untouched, so a scoop cut hard enough is still CALLED a slice and never lobs.

Client (web/scene.js): measured on the real server's stream, with a CLEAN lob the drawn vy still rose after contact: the hit's smoothstep
put it 2-4 m/s over the path for a few frames (7.7 m/s frame to frame on a re-aimed lob), and state packets re-stamped on a jittery link
(80+60 ms) bobbed it up by up to 0.9 m/s a frame. `drawBall()` (exported, the frame's live-ball step) now draws the height from a hit to
its first bounce as the path the contact frame sees, on the local clock, with what was off taken out as e (1 - t/tau)^2: a curve that only
ever pulls down, tau long enough that pulling a ball drawn too high never outruns gravity. The anchor follows the server's steps (v then p:
g dt t / 2 under the closed form), so it stays within 1 cm of the server's ball, closer than the packets' own coast. Across and along keep
the smoothstep. The re-aim's `launch` still carries p v t (its curl bends the ball from where it really is); its vy is the struck one.

Tests: `test/helium.test.mjs` is rewritten on the wire (SWING_SERVE on): low-lob bet -> lob, lob bet -> drive, lob bet -> lob, hard bet ->
tap, smash, near-net fixBlock, a serve struck on its first report, a legacy client. After the contact packet vy never rises, gravity never
lightens, the marker is within 0.15 m, every ball clears the net, and lobs (clean or bet-and-settled) still top 3.3 m. The low-lob bet is
now flown as struck (1.2-1.5 m): that is the bet's to fix. `test/drawlob.mjs` records the real server and replays it into `drawBall()`
at 40+0, 40+30, 80+60 ms and 60/120 fps: the drawn vy never rises frame to frame from contact to the bounce.

## 91. Lobs from a deep take-back lob on the bet; a late hit is drawn falling too

Found by attacking NOTES 89/90. Two real holes, two that were not.

The bet (web/motion.js). A lob taken back past ~40 deg behind vertical still has the hand coming DOWN at its first report (the paddle
15-40 deg behind vertical, upward share -0.3 to -0.75): the third pendulum gate turned it away, lob 0, and the sealed ball flew a flat
drive (1.3-1.5 m) under a settled 'lob' label. Where it did pass, 2.4 rad on from there ended below level (bet 0.50-0.56, under the lofted
cliff at ~0.6). Now the look-ahead runs to a place in the arc, not a fixed angle: until the paddle points LOB_TOP (60 deg) over level, or
tops out on a tilted axis, 3 rad at most; and while the hand is still coming down, the path so far and the look-ahead's own descent are
dropped, so the share is taken from the bottom of the arc. A hand still coming down passes only when it hangs near the bottom (pointer at
most -0.6 up) on a clean +R turn (>= 0.75) with no forearm roll now (<= 0.3) or so far (|swept twist| <= 0.2): a real waggle down from
behind (live-play-1 @22317.6: +R 0.68, swept twist 0.37) bet lob 0.73 without the last two. Measured (sweep of perturbed lob strokes, 12
seeds x AirPod/phone, 720 strokes): settled lobs flying low 15.9% -> 3.1% (phone at 30/100 Hz: 17.0% -> 3.8%); what is left is mostly the
old power call betting a dink (p 6) under sensor noise. back 135: 5-7/12 low -> 0/12; real server, back 135 and back 125 wide, both grips:
24/24 lob on the bet, apex 3.9-4.35, ay -9.8 throughout. 394 random plausible lob strokes: flies a lob on the bet 71.3% -> 82.5% (clean
sensors 80.2% -> 93.7%; pre-NOTES-55 74.1% / 85.0%). Slices, chips, drives, smashes, flicks and 143 real swings: unchanged. What moved: a
cross-body underhand serve (80 deg sweep, ending 10 deg over level) now settles lofted 11-12/12 (was 8-9) and 1/12 per grip is bet a lob,
where it flew a drive; ul_wide90 settles lofted 1/11 on the AirPod (was 0). `deep_lob` in test/lobsynth.mjs, in test/lobbet.mjs's lobs.

Not changed: (1) the real deliberate lob (live-play-3 @610.7) looked fragile, a gyro noise of 0.05 flying it a drive 3/20: that is the
replay's calibration, the capture's FIRST sample (mid-rally) standing in for step 1, which leaves the paddle's pointer along the lob's own
turn axis (twist 0.99). Calibrated from any pose the player rested in that minute (606.97, 609.61, 610.33) it is 20/20 full lobs at noise
0.05 and 0.1, on this and on the NOTES 90 tree. test/lobbet.mjs (f) now holds it at >= 19/20. (2) A pendulum push that stops below level
is bet a lob when it is quick enough (25 of 988 synthetic pushes at p ~20, 3.9-4 m, as on the NOTES 89 tree; the rest are taps that become
dinks at the same height). The new look-ahead lofts a few more of their bets than NOTES 89's: 128 -> 133 of 249 at 30 deg under level, 138
-> 147 of 215 at 20, 147 -> 154 of 208 at 10. At the bet it is the first half of a lob (same axis, same pointer, same rate): the base's
own settled report calls many of them lofted too (200 of the 423 that top out 10-20 deg under level). Dropping the carried look-ahead from
a settled report whose paddle never rose over level was tried: it un-lofts the settled report of 9 of the 96 lob swings in test/lobbet.mjs
(a lob's rate peaks near the bottom, before the paddle is up). None of the 143 real swings changes.

The screen (web/scene.js drawBall). A hit that lands late (150 ms or more: the measured wifi stalls) finds the path already 1 m or more
above the drawn ball; the arc's 1 m guard compared the DRAWN height (path + e) with the packets, so it fired on the contact frame itself,
dropped the arc, and the old smoothstep drew the ball climbing at up to 16 m/s (10% of lob flights on the measured link at 30 Hz, 37% at
60 Hz). The guard now compares the path (what the packets must agree with), not e. A ball drawn too low only ever adds to its fall (e (1 -
t/tau)^2 with e < 0 pulls down at 2e/tau^2), so tau there is capped at 0.25 s: it leaves once at 2|e|/tau over the path's vy and is on the
server's ball within 0.25 s. test/drawlob.mjs replays a hit held 150 and 300 ms (the old drawBall rises 10.4 m/s there).

The label (server/game.js reaim). The arc is chosen at contact, so a re-aim's `kind` is only announced when it agrees with it:
`launch()` remembers `ball.lofted`, and a settled 'lob' or 'dink' on a flat ball (or a 'drive'/'smash' on a lofted one) is dropped. A
bet that flew a drive and settled as a lob no longer burns the lob's white trail on a 1.3 m ball.

## 92. The share card's wordmark is all dark
- "The 'poddle' text is partly blue and isn't good with contrast against the blue sky. Make it black / dark."
- test/og-card.html draws the whole wordmark in the logo's dark (#39434d, the `P` and `d`), not the site's line blue for `dle`;
  the white haze behind it stays. `node test/make-og.mjs` re-rendered web/og.jpg; og:image is `?v=6` so the unfurlers fetch it
  again. The in-game logo (web/ui.css) is unchanged. A 3:2 version (1800x1200) went to the Devpost gallery as the thumbnail.

## 93. No iPhone haptics (tried and reverted)
- Tried the iOS 18 `<input type="checkbox" switch>` label-click tick as an iPhone stand-in for `navigator.vibrate` on hits
  and points. It did not buzz in play (iOS seems to want a real tap, and mid-rally you swing), so it was reverted.
  Android keeps `navigator.vibrate`; real iPhone haptics would need a native app or App Clip.

## 94. Terms of Use and Privacy Policy
- "Make a Terms of Use and Privacy Policy ... and remember, these should be kept in mind with each update / push. like if
  i wanted to add google account sign in later on, claude should know to update these docs accordingly."
- web/terms.html and web/privacy.html (effective September 24, 2026; operator Daniel Tan, Ontario; 13+, under 18 with a
  parent's permission; hello@danielrltan.com). Plain words, styled with how-to-play.css. Privacy has a short version, a
  "For teens and parents" box, what we use and why, webcam, what others see, storage table, recipients, retention,
  rights, and a GDPR legal-basis table in 13. Terms: safety (you swing toward the screen), names and fair play,
  spectators and tournaments (no prizes from us), Helper (MIT, Open Anyway only for our copy), ownership, as-is,
  CAD $50 cap with consumer carve-outs, Ontario law, Quebec 30-day change notice.
- Code made to match the pages: MediaPipe's built-in usage logging to Google (odml.pa.googleapis.com/v1/log, every
  60 s) is patched off in web/vendor/mp/vision_bundle.js (search "Poddle:"; notice in web/vendor/mp/LICENSE.txt, which
  also carries the Apache-2.0 text). Checked with a headless Chrome probe and a fake camera: before, OPTIONS to
  odml.pa.googleapis.com; after, no outside request in 75 s. Tournament log lines count matches and say
  "champion: Matt | a player" instead of display names. package.json is "UNLICENSED", private; LICENSE says all rights
  reserved (Helper stays MIT).
- Links: title footer (How to play · Privacy · Terms, same stopPropagation as How to play so a click does not start the
  game), lobby footer ("By playing you agree to the Terms and Privacy Policy. Under 18? Ask a parent first."; on a phone
  it replaces the key hints), pad.html start view under Start (before the motion prompt), how-to-play footer and a line
  under Download Poddle Helper, 404.html. Both pages are in sitemap.xml. seo.test checks all of it, plus "Last updated"
  = dateModified and that the MediaPipe patch is still in.
- Keep-current rule: CLAUDE.md "Legal pages" (trigger list + current data-flow inventory), the comment at the top of
  both pages, and the memory note poddle-legal-docs. Any change that touches data, logging, storage, permissions, third
  parties, accounts/sign-in (Google), public features or the age policy updates the pages in the same commit.
- Known limits, for Daniel: Fly.io's DPA may need signing at fly.io/documents before the SCC sentence is true; the
  mailbox behind Cloudflare Email Routing is not named; no French version (Quebec Bill 96 risk); choosing Auto does not
  stop the camera (the page says so; main.js could stop the tracks and close the MediaPipe tasks instead); Helper's
  README and About box don't link the Terms yet.

## 95. The camera is explained before it is asked for
- "There is not any good UX pertaining to disclaiming why camera will be needed … a whole screen as part of the very first
  initial calibration process (cached so it doesn't show you it again), explaining what you need to do to enable camera on
  browsers and why it's needed. Otherwise it just seems invasive."
- Before: taking a seat called `startCam()` straight away, so the browser's camera question popped up over the connect screen with
  no click and no reason given. The only explanation was a small line under the status rows, and it said "read on this Mac".
- Now the first seat opens a new screen, `camera` (web/index.html `#screen-camera`, ui.js `camPrimer()`). It is its own phase in
  main.js, so a paddle that is already live behind it cannot jump to calibration: `onSample` returns for it, and the keys stop at
  it the way they do in the lobby. It says why the camera is needed (this computer's webcam, not the phone, sees where you stand
  so that stepping moves you; without it the game runs you to the ball), what stays private (read in this browser, never
  recorded, saved or sent, only your position is used) and what happens next (the browser will ask: press Allow). **Allow camera**
  is a click, so the browser's question follows a user gesture. **Play without camera** sets Auto and asks for nothing. Either
  way the rest of `begin()` carries on (calibrated and live -> court, live -> calibration, else connect). Back leaves the court,
  as it does from the connect screen. Spectators and `?cam=0` never reach it.
- The answer is kept under its own key, `poddle.camPrimer` = `allow` | `skip`. It is not in `poddle.settings`, because
  `savePrefs` rebuilds that from a fixed list and would drop it. `skip` loads as Auto and is never asked again. Settings -> Move ->
  Body can now be picked with the camera off: it asks for the camera and switches to Body once it is up. The connect screen's
  Camera row says Off (not "Waiting") and has a **Turn on** button.
- `navigator.permissions.query({name:'camera'})`, in a try (Firefox and older Safari throw): `granted` skips the primer and just
  starts the camera; `denied` opens the primer straight in its help state instead of offering an Allow that cannot work. If the
  permission changes while the help is up, it moves on by itself.
- Help when the camera fails: bodytrack.js now keeps `e.name` (`T.errorName`) as well as the message. NotAllowed/Security means
  blocked ("denied by system" means the computer's switch, "dismissed" means the question was closed). NotFound/Overconstrained
  means no camera. NotReadable means another app has it. No `mediaDevices` means not https. The steps for the browser in use come
  first (Chrome, Edge, Safari's "Settings for <host>", Firefox), then macOS or Windows privacy settings (left out for Safari, which
  macOS does not list). The rest are folded under "Using something else?". There are **Try again** and **Play without camera**
  buttons. It shows on the primer, and on the connect screen when a request made there fails.
- Try again really asks again. Before, `camOn` stayed true for good after the first request. Now `stopCam()` stops the old
  tracker's tracks and loop (`T.stop()`), bumps a generation counter so a late answer to an old request is handed back, and
  clears `camOn`. A stream that arrived but whose models failed to load is stopped too; before, it kept the camera light on.
- The connect screen's camera line is now one sentence and says "this computer". test/camprimer.mjs covers the new flow: first seat,
  a live AirPod behind the primer, Allow, Play without camera, reload, denied, Try again, Back, granted, spectator. It also saves
  test/ui-shots/cam-*.png. The e2e harnesses set `poddle.camPrimer=allow`, as they already set a name, so they run as before.
- Review fixes. Settings -> Move -> Body with the camera already working (Move was Auto) now just switches to Body. Before, it
  restarted the camera: a second request, the light blinking, the models built again. `T.stop()` now closes the MediaPipe face
  and pose graphs (they hold WASM/GPU memory), and it clears the shared `<video>` only if it still shows this tracker's stream, so
  a stale tracker stopped late cannot blank a newer one. `stopCam()` keeps the range (`prefs.reach`) for the next tracker.
  NotReadableError ('busy') shows the fix steps with the computer's switch first, because Chrome and Edge on Windows report the
  privacy switch that way. 'dismissed' has its own text (press Try again, then Allow); after about three closes Chrome blocks it
  and still says 'dismissed', so the steps stay. iPads (iPadOS says 'MacIntel') and Chrome/Edge/Firefox on iOS get the Settings
  app steps instead of Mac menus. The primer says the position goes to the game, and that Auto in Settings is the way to play
  without it later (Auto does not turn the camera off, so the copy doesn't promise that). On a phone-width window "Play without camera" is a link
  under the one big Allow pill, the primer's buttons do not grow on hover (they clipped in its scroll box), and the connect
  screen's Turn on gets its own line.
- Play without camera says what replaces it: a line under the buttons ("Without the camera, Poddle plays in Auto: the game runs you to the ball and you just swing.") and a toast when it is picked, so saying no never feels like breaking the game.
- Privacy updated with it: the primer before the browser asks (section 3), Play without camera remembered, and the `poddle.camPrimer` row in the storage table; CLAUDE.md inventory too.

## 96. The tab just says Poddle
- "I just want Poddle" in the tab, not "Poddle | Pickleball You Swing With Your Phone". The home page's <title> is now
  `Poddle`; seo.test checks for exactly that. og:title and the meta description still describe the game for share cards
  and search results. The other pages (How to play, paddle, privacy, terms, 404) keep their own titles.

## 97. The result card is a moment: GAME!, a medal with rays, crown and claps, match stats, a jingle
The win/lose card was a static panel. It now plays a short Smash / Wii Sports style sequence, and the title, score and buttons are all readable by about 1.2 s, because no-vote rooms and tournaments close the card after about 6 s:
- A "GAME!" stamp slams in (blue for a win, grey for a loss, gold in a tournament) and is gone by about 380 ms, before the title pops.
- The medal lands with rays behind it: gold for a win, silver for a loss.
- The winner's chip gets a crown that bobs. The loser's chip claps (Smash's loser applauds).
- The scores count up visually. `#tally-sc-*` text holds the final numbers from the first frame.
- Stat pills show the match's longest rally, smashes and best point run, and the best one is starred. main.js counts them in memory from 'hit', 'launch' and 'point'. Nothing is saved or sent. The stats are left out after a forfeit, a reconnect or revive, a late spectator, or any gap where the counted points don't add up to the score.
- Sound: `scene.jingle(kind)` plays a synthesised fanfare. There is a win fanfare, a warm consolation for a loss, a neutral one for spectators, a forfeit one, and a champion one. Each new jingle cuts the one still ringing, which matters when the champion card follows the final's result straight away. It goes through the normal mute and output-sink path.
- Spectators get one confetti burst in the winner's colours.
- Reduced motion shows the finished card with no animation.

## 98. Your stats: a private record of every match, the Matt ladder, fair-play checks and optional Google sign-in
- Spec: docs/ACCOUNTS.md (the OPERATOR CORRECTION at its top wins: four Matt rungs). Server: server/db.js (`node:sqlite`,
  no new dependency, file `PODDLE_DB=/data/poddle.db` on the Fly volume `poddle_data`), stats.js (per-match accumulator,
  one transaction at match end), abuse.js (the rules, pure), api.js (`/api/me`, `/api/stats`, sign-in, sign-out,
  username, export, delete), auth.js (Google ID token checked with `node:crypto`; sessions; Origin allowlist), usernames.js
  + words.js, hooks in game.js. Client: web/profile.js, the result-card line, Your stats, Settings > You. Sign-in never
  gates play: with the database missing, broken or full, the game plays exactly as before.
- What is kept: matches played, human W/L, streaks, points, tournament titles, best rally, hardest hit and fastest swing
  (with dates), and the Matt ladder: Rookie, Club, Tour, Pro (wire levels 0, 1, 3, 2; `matt` is a four-entry array in
  that order), each with W/L, first win date, current streak and best streak. Every Tour-level result (Play a bot at
  Tour, tournament matches and warm-ups against Matt) lands on the Tour rung; there is no separate Tournament Matt line.
- Identity: guests hang off `poddle.device` (random, made at the first seat with Save my stats on, never on load, never in
  a URL; the server keeps only its SHA-256). Signing in merges that guest record into the account. Accounts keep the
  Google `sub` only: the token's email, name and picture are discarded, never stored or logged. Session cookie
  `__Host-poddle_s` (HttpOnly, 180 days, at most 10 per account; the database holds its hash), nonce `__Host-poddle_n`
  (10 min). An age checkbox (13+, under 18 with a parent's permission) comes before Google's script is even loaded.
- Fair play (abuse.js, rules R0-R18): a result counts ("ranked") unless the two seats look like one person (same
  computer by IP or /64 widened by a 24 h in-memory link map, same device, account or tab), the match was revived, too
  fast, idle, an early forfeit or a leader's hand-over, the pair or the winner hit a daily cap, the loser is a feeder,
  a one-way farm or brand new, or a paddle teleported. Unranked matches still count as played; both players are told
  when a match did not count. The IP is compared in memory and never written; keyed hashes (key replaced daily) live
  at most 24 h. Swing bests are client-reported, capped and personal-only. Stats are private: no leaderboards.
- Retention (db.sweep at boot and every 24 h, 500-row batches): guests 90 days after the last recorded match (7 if only
  one), accounts after 24 months with no sign-in and no match, match log 30 days (R11b looks back 30 days and the export
  lists recent matches), sessions at expiry, sign-out or deletion, name holds 30 days (rename) / 90 (deleted account).
  `secure_delete` plus a WAL checkpoint after deletes. Fly snapshots kept 5 days (`--snapshot-retention 5`); an
  `admin.js backup` goes to /tmp and any copy taken off the volume is deleted within 5 days. Export (JSON) and delete are
  self-serve in Your stats.
- Infra: fly.toml `[mounts]` + `PODDLE_DB`; the operator creates the volume once (command in fly.toml); deploy.sh keeps
  the machine that owns the volume and runs accounts-unit, stats and auth tests. Dockerfile pins node:24.11-alpine and
  silences node:sqlite's one ExperimentalWarning. `*.db`, `*.db-wal`, `*.db-shm` are git- and docker-ignored.
  test/auth.test.mjs runs offline: its production server gets test/no-network.cjs preloaded, which refuses non-loopback
  fetches and logs the URL, so the test proves production goes to Google's real key set and never trusts GOOGLE_JWKS_FILE.
- Open before deploy: Q1 (the 14.3 client-address probe) not run; Q6 (snapshot retention and location) not confirmed with
  Fly, so the privacy page uses the spec's "Canada or the United States"; Q5 (EU/UK/Quebec opt-in) and Q18 (EU/UK
  representative) await counsel, so privacy 13 keeps its current representative sentence. Stats and sign-in launch
  together: set `GOOGLE_CLIENT_ID` in fly.toml in the same deploy, or the pages describe a sign-in that is not there.
- Privacy and Terms updated with it (spec 10.1 and 10.2, statistics and sign-in text together): accounts, the two
  cookies and `poddle.device` / `poddle.stats.on` in section 5, Google as a recipient (token contents discarded, its own
  cookies and FedCM, deleting here does not disconnect there), usernames shown to others, the automated counted/not
  counted decision, retention as implemented, 13+ and the age checkbox, lawful bases; Terms gains 5 "Statistics,
  accounts and usernames" (later sections renumbered; survival clause 3, 9 and 11 to 16). "Last updated", dateModified
  and sitemap lastmod 2026-09-24. CLAUDE.md "Current data flows" and the new docs/ropa.md (record of processing) match.

## 99. The Your stats tile plays like the others, and signing in shows Google's G

- **Tile icon.** Quick play, Courts and Play a bot each animate their icon on hover (a loop) and on keyboard focus (once);
  Your stats sat still. Its three bars now dip and spring up left to right from the floor (`ic-bar`, 110 ms apart) and the
  tick above them pops as the last bar lands (`ic-tick`), on the same 1.6 s beat. A dimmed tile stays still as before.
- **Google's G.** The three sign-in buttons (Your stats, Settings > You, the result card's "Sign in to keep this win")
  carry Google's four-colour G (`.g-logo`, colours unchanged per Google's branding rules; the Settings row's outline-icon
  rule is overridden so it is not drawn as a stroke). The Your stats button is now a call to action: "Sign in with
  Google" over "Save your stats and keep them on every device!". Nothing new is loaded: the G is inline SVG, and Google's
  own script still loads only after the age box is ticked.

## 100. Stats, looked at again: fewer words, one hierarchy, no unitless numbers

A pass over every screen the stats feature added, at desktop and phone size, judged against the rest of the game.
- **The result card tells one story.** The record line ("First win against Tour Matt!") was small link-blue text under
  the match-stat chips and read as a link. A first win is now the same gold pill as the chips and the ladder's medal
  chip; every other line is plain ink. The sign-in nudge showed after EVERY win for a guest: now once a visit, and on
  every first win.
- **No "Hardest hit".** Its number is the game's internal power scale (a smash is ~27): nobody can read "22". It is
  still stored and exported (the privacy page's list is unchanged); it is just not shown. Longest rally says "hits".
- **Your stats greets you by name.** The header said "Guest" while the lobby said Daniel: it now shows the typed name
  (or the username), with "Stats saved on this device" under it.
- **"Save my stats"** (was "... on this device"): since 98's review fix the switch also stops recording to an account.
- **Links the size of their sentence.** `.foot-link` has a 14px floor for the footer; inside the home notice and the
  sign-in card it made the Privacy Policy link the biggest thing on a phone. Those inherit now.
- **Shorter copy** on the home notice and the sign-in card. The home notice stays: the privacy page promises one for
  important changes (remove it around late November 2026).
- Kept on purpose: the fourth home tile (a page among actions, as on a console menu), Google's G in the Settings row
  (the only colour icon there; it is what the owner asked for), and the age box unticked on every open.

## 101. The name row stays put, and What's new is a page, not a card

- **Name row.** The lobby body centred the name row and the view together, so the row rode up and down with each
  panel's height: y 98 on Play, 118 on Courts, 239 on Create court, 265 on Play a bot (1280x800). The body now starts
  at the top and a panel centres in the space under the row, so the row sits at one spot on every view that has it.
- **No more home notice.** The owner's call: the title screen is back to one card. The privacy page's promise of "a
  notice on the Poddle home page" for important changes is kept by a **What's new** link in the title footer to
  web/changelog.html (a dated, player-facing changelog on the help page's stylesheet; `/changelog` redirects like
  `/how-to-play`; in the sitemap). Changes to how Poddle handles information go there on the day they take effect,
  with a link to the updated page. NOTES 100 said the notice stays: superseded.

## 102. Sign-in is one card, your data lives on the privacy page, and the stats header has real controls

- **Sign-in card.** Title, one line, Google's button, one line of fine print (the footer's own "By signing in you
  agree to the Terms and Privacy Policy. Under 18? Ask a parent first."), and an × in the title row. The age
  checkbox is gone: the card states the condition and signing in confirms it (privacy 8, terms 4 reworded, no dates
  bumped: the pages are already dated today). Google's script loads when the card opens, still never on page load.
  A failed load hides the button's room instead of leaving a gap. The username pick after sign-in stays (Skip for now
  is there).
- **Download and delete moved to the privacy page** (web/privacy.html "Your data, from this browser", web/data-tools.js,
  a classic script on the same origin: the device id from localStorage and the session cookie are both at hand). Your
  stats keeps one line, "Only you can see this page. Download or delete your data", linking there. The game's confirm
  card is gone; the privacy page has an inline confirm with Cancel focused. Terms 12 says where deletion lives now.
  Settings' "Also delete the stats saved so far?" on switching stats off is unchanged.
- **Your stats header.** Signed in: the username with its badge and a pen icon beside it (pick or change the
  username), and a real Sign out button with an exit icon on the right, where the Google button sits for a guest.
  The old "Signed in · Change name · Sign out" text row is gone.

## 103. Your stats is a player card: a rank crest, the Trophy Road, the people bar and three number tiles

- **The view is a card, not a table.** A hero well on top: the crest (a gold medal with a star, a crown once all four
  Matts are beaten, a dashed silver ? before the first win) with a one-shot halo, the rank name in the player's blue
  ("Club player" = the hardest Matt beaten, in difficulty order Rookie, Club, Tour, Pro), four stars beside the Rank
  label (on the caption's line they and the caption need two lines at 1280, and the card scrolls), and the streak ribbon: the hottest live streak against anyone, gold from two wins up, never for one. Then the
  Trophy Road: the four Matts as nodes on a sky track, gold up to the last one beaten in a run from Rookie, a gold
  star for a beaten one ("Beaten Sep 19"), Matt's face pulsing on the next one with the Next button inside that node,
  a padlock on the rest ("Beat Club first", "The final boss"). The W-L record is each node's big number, its streak
  the small print. Under it, Against people: W-L, a blue-orange tug-of-war bar ("60% won" / "Points 50-41") and the
  Streak / Best chips; and three tiles: Titles, Longest rally, Fastest swing, each with its date and a gold chip.
  Hardest hit is gone from the page (a unitless number). Empty: a coaching line per block ("Start here", "Play a
  person to start your record", "Win a tournament to lift a cup", "Keep the ball in play", "Swing hard, it counts")
  and no "Play a match to start your record" bar over them; the bar stays for "Stats aren't available right now".
- **Out-of-order wins.** Every level is free to pick, so Pro can fall before Club. The rank is still the hardest Matt
  beaten, the Next button still points at the easiest one not beaten, and the caption then says "beat Club Matt to
  fill the road" (no promotion promised); the gold track never runs past a gap.
- **Motion** is the deal-in only: the crest drops, the halo grows once, the ribbon swings in, the track fills, the
  stars and numbers pop, the nodes and tiles stagger in; the next node's pulse is the one loop. Reduced motion turns
  all of it off. On a phone the hero stacks, the road runs down the left in one column (its track a segment per
  node, disc to disc) and the tiles become rows that keep their gold chips.
- **Sizes are chosen for 1280×800 without a scroll** (the lobby's head and foot leave the panel about 42rem): the
  crest is the biggest thing on the card, the halo fades out inside the well.
- Header, footer, ids and the data mapping are unchanged (docs/ACCOUNTS.md 9.4 rewritten to the card). No new data
  flow, storage key or third party: the legal pages need no change.
- test/profile-ui.mjs reads the new markup, adds the out-of-order case (Rookie + Pro beaten), clicks the Next button
  (a private create, then bot level 3 against the fake game) and screenshots the empty state at both sizes too
  (test/ui-shots/accounts/stats-empty-*.png).

## 104. No GAME! stamp on the result card
The owner found the "GAME!" / "CHAMPION!" stamp from section 97 cheesy and asked for something more neutral. The stamp element (#result-slam) and the screen shake that came with it are gone. In their place, one soft band of light crosses the card from left to right as it lands (#result-flash, 900 ms, starting at 260 ms). It can't be clicked, and reduced motion hides it. The medal and rays, crown and claps, count-up, stats and jingles are unchanged. The ui-next checks now assert that no stamp exists.

## 105. Your stats has no footer line

"Only you can see this page. Download or delete your data" is gone from the panel: the owner's call, and the privacy
page already says both (statistics are shown only to you, section 4; the Your data box, section 9). Privacy 4 no
longer points at Your stats for downloading or deleting.
Also: the rank stars are gone (nobody could say what four stars meant; the caption "2 of 4 Matts beaten" says it), Matt's
disc and the Trophy Road heading use the Play a bot tile's head (the previous face read as an egg with a crown), and
the tiles' icons are a pickleball paddle with a ball (Longest rally) and a speed gauge (Fastest swing): the old ones
looked like a badminton racket and a leaf.

## 106. The check badge is gone; the developer's username wears a DEV pill and orange

The blue tick beside every registered username said nothing a player cared about (the owner: "feels useless"). Now
nothing marks a registered name, except the developer's: the username Dan (ui.js DEV_NAMES, matched on the name the
server sends, which only that account can carry) gets an orange DEV pill beside it and the name itself in the pill's
orange (`.is-dev`), on the scoreboard, the result card, the court list, tournament chips, the bracket, the VS card
and Your stats. The claim card no longer promises a badge; the changelog and CLAUDE.md follow.
The ladder's heading is "Matt difficulties beaten" (was "Trophy Road · beat Matt": trophies belong to a rank system, not to Matt).

## 107. Rank is a trophy tier; the Matt row has no track

- **Trophies and tiers.** The rank used to be the hardest Matt beaten, which the Matt row already says. Now trophies are
  counted from the stored record (nothing new is kept): 10 a counted win against people, a first-win bounty per Matt
  (Rookie 25, Club 50, Tour 75, Pro 100) and 50 a tournament title. Tiers: Bronze 0, Silver 50, Gold 150, Platinum 300,
  Diamond 600, Legend 1000. The crest wears the tier's metal (the top tier a crown), the rank row shows the count with a
  cup and "145 to Platinum", and a bar fills across the current tier. Everyone starts Bronze: no "Unranked" and no "?".
  Bot wins beyond the first do not earn trophies (they are uncapped and scriptable, docs/ACCOUNTS.md 5.2).
- **No track under the Matt row** (the owner: a bar is not a difficulty). The four discs stand on their own; the gold
  medals, the pulsing next one and the padlocks say the state. Phone: the same, in a column.

## 108. Menu views have addresses: a reload stays where you were
Refreshing on Your stats, or any other lobby view, used to drop you back on the title screen. Each view now has its own path:
- /play: the Play home
- /courts: Courts. The Your court, Tournament and bracket views also show /courts.
- /create: Create court
- /bot: Play a bot
- /stats: Your stats

server/game.js serves index.html for these paths (MENU_PATHS), and redirects each one's trailing-slash form to it with a 301.

main.js route() keeps the address bar in step using replaceState, so the browser's Back button behaves exactly as before:
- It runs only after boot has restored the view. Otherwise the title screen would wipe /stats first.
- It only ever swaps '/' or one of these paths, so a copy served from /web/index.html (the tests) keeps its path.
- A seated court goes back to '/' with its ?court=CODE, and the invite always links the root.

On load, a menu path with no ?court= skips the title and opens that view.

test/menu.mjs's static server knows the same paths, because it reloads the page after the lobby has set /play.

The stats page's "Against people" heading now reads "Online multiplayer", as the owner asked.

## 109. Even padding on Your stats; Settings loses its stats rows

- **Padding.** The card had .5rem on top and .25rem at the bottom against 1.5rem at the sides: the header sat on the rim
  and the tiles on the border. Now var(--s-4) top and bottom, var(--s-6) at the sides, the section gap var(--s-2) (1.5rem top and bottom
  with a .75rem gap put the tiles under the footer at 1280x800 once the header has its three lines).
- **Settings.** "Save my stats" and "Your stats" are gone from the pause menu (the owner: not a thing for a pause menu).
  Your stats is a home tile. The switch lives in the privacy page's Your data box (web/data-tools.js, same origin, same
  key); an open game tab hears the change through the storage event and does what the switch did (nostats, drop the id,
  redial). Turning it off no longer asks Delete or Keep: Delete my data is right there. The privacy page, terms, ROPA,
  changelog and the two in-game notices now point at the privacy page.

## 111. Your stats: the Matt road becomes a badge

The owner: a road does not fit, because any Matt level can be picked at any time. The "Matt difficulties beaten" strip
(four boss nodes on a gold track, padlocks, "Up next", "The final boss", the Next button) is replaced by one compact row:

- **The badge** (`#st-mbadge`, web/profile.js drawMatt): the toughest level beaten on a disc in that level's colour (Rookie
  green, Club blue, Tour purple, Pro gold), a gold star on its rim, the name ("Pro Matt") and the date it was first beaten.
  Toughest means difficulty order (Rookie, Club, Tour, Pro), never the wire number: Pro is 2 and Tour 3 on the wire, so
  `rungs().top` picks it, as the rank did. Nothing beaten: a grey disc, "None yet" and a coaching line in the player's blue.
- **A chip a level** (`#pf-rungs`, now a `ul`): each level's W-L (and its streak), ticked once beaten, the badge's level
  outlined in its colour. Nothing is locked or ordered like a climb, and there is no Next button.
- The hero (rank crest, trophies, streak) is untouched; the first-win trophy bounty per Matt still counts. test/profile-ui.mjs
  checks the badge, the chips, the out-of-order case (Rookie + Pro beaten: the badge is Pro) and the empty state.
- No data, storage or visibility change: the legal pages are unchanged.

## 112. Ranked: a queue with Matt as the warm-up, best-of-3 series in a night stadium, seven ranks with three divisions
- The owner: "a menu reorganization / overhaul, as I want to now add another button there: for ranked … a quickplay
  thing, where u play against matt until someone also queues and then they get match made with u … a trophy road that
  you climb … 6-7 [ranks] … custom rank emblems … pickleball related … next to names in ranked mode … a different court,
  a more serious stadium like one … brawlstars multi round games to win and the tv show like win transitions and counts".
  Then: the ranks are the familiar ladder (Bronze, Silver, Gold, Platinum, Diamond, Champion, Pro; no Olympic wording),
  each with divisions I, II, III. The spec is docs/RANKED.md (the protocol in 9, the data in 10, the rules in 5 and 13).
- **Menu.** Five entries: a hero row (Quick play, Ranked) over a utility row (Courts, Play a bot, Your stats). The layout
  keys on `.tiles[data-n]` written by `ui.tilesFit()` from the visible count, never on `:has(nth-child)` (Ranked and Your
  stats show only with a stats database). 2 over 3 in landscape, 2 / 1 / 1 / 1 in portrait, one column under 480 px.
  The Ranked tile's line is the player's emblem, rank and trophies. /ranked is a menu path (NOTES 108).
- **The Ranked view:** the emblem, "Gold II", trophies, a bar across the division, "28 to Gold III", the trophy road of
  seven ranks with three division pips each, Find a match, and the rules line (best of 3, first to 7, win by 2; Matt
  while you wait; leaving is a loss; your emblem is shown to your opponent and anyone watching). Opening it builds the
  stadium behind the glass.
- **Queue and matchmaking** (server/game.js `rk*`): being queued is being seated on a private warm-up court against Matt
  (Rookie at Bronze up to Pro at Champion), in the stadium, with a queue pill ("Finding an opponent · 0:42"). A second
  player pairs by trophies (a window that widens every 15 s); the same computer, device or account is never paired, and a
  pair already at the daily cap plays a "Friendly match, no trophies", said on the VS card before it starts. Pairing takes
  both players off their warm-ups at once (no Matt loss is recorded for it), shows MATCH FOUND for 5 s, then seats them.
  Caps: 12 queued, 2 per computer, the room cap; a 2 s cooldown on re-queueing.
- **The series:** best of 3, each game first to 7, win by 2, golden point at 11, alternating first serve. Between games a
  6 s game card over the darkened stadium ("You take game 1", the score, two rows of pips, "Game 2 in 6", "Deciding game"
  at 1-1, who serves first); GAME POINT / MATCH POINT in the rally lozenge with a pressure ring and one floor-tom hit;
  pips beside the rally count. The series card: "You win the match", the games and each game's score, emblems beside the
  names, Play again / Leave. Leaving, a drop past the hold, or a calibration stall is a forfeit of the whole series.
- **Trophies and ranks** (server/ladder.js, web/emblems.js mirrors it; test/ladder.test.mjs checks they agree): ranks start
  at 0, 150, 300, 450, 600, 750, 900, each split into three divisions of 50 (Pro III is 1000+). A series win is about
  +30 and a loss about −20, moved by the trophy gap (18 to 45 / −8 to −32, +3 for a 2-0). Bronze to Platinum are yours
  to keep once reached (trophies never fall below that rank's floor); Diamond and up can drop, never below 450. A counted
  Matt win while queued pays +10 at Bronze down to +4 at Champion, 40 a day, never past 899: Pro needs people. The trophy
  row counts up on the card; a division up pops the emblem to the new numeral, a rank up swaps the emblem with rays,
  confetti and a sting, a drop shrinks it. Everyone starts at Bronze I.
- **One rank per player.** NOTES 107 had given Your stats a rank of its own (tiers derived from wins, Matt first wins and
  titles). With a real ladder that would be two ranks with the same names and different numbers, so the crest on Your
  stats now wears the Ranked emblem and shows the ladder's "Silver II", trophies and bar (`ui.rankCrest`); the derived
  tiers are gone. A player who has not played Ranked shows Bronze I, 0: "Play Ranked for your first trophies".
- **The Ranks page** (/ranks, the owner: "when u click on the rank medal / icon, it pulls up a page showing all the rank
  medals that u can get"): the crest on Your stats, the emblem on the Ranked view and See all ranks open it. Seven cards,
  each medal large with where it starts and its I / II / III thresholds; the player's own rank ringed ("You · Silver II"),
  the ranks reached marked, Bronze to Platinum tagged Yours to keep; Play Ranked at the foot. It stands in the stadium,
  and Back returns to where it was opened from (`ui.viewParent`).
- **Emblems** (web/emblems.js, one SVG sprite): bronze shield, silver shield, gold hexagon, platinum octagon, diamond gem,
  winged champion star, the Pro crest with laurels and a crown; the pickleball is the centre of every one. They show beside
  names only on Ranked courts (scoreboard, VS card, result card, spectator chip); the division tag shows at the larger sizes.
- **The stadium** (web/scenery/stadium.js, `scene.setVenue('stadium'|'park')`): a night arena, tiered stands with a
  swaying crowd, four floodlight masts with light cones, an LED hoarding ring, a darker blue court, stars. Fewer draw calls
  than the park. The park is unchanged. `body[data-venue]` tints the lobby for it.
- **No stamps** (NOTES 104): the series card uses the light sweep, not a MATCH! slam, and the game card has no GAME 1
  stamp; the rank-up is the emblem's moment, with a caps "Rank up" (or "Division up") pill in the new rank's colour beside the
  trophy delta, so the moment has words. The owner can ask for slams back.
- **Fair play** (docs/ACCOUNTS.md rule table RK1-RK5, R10 and R11b by series). Every game is judged by abuse.js as
  before. Ladder rules: the leaver always takes the full loss; the stayer wins the delta only if a played game counted
  (the forfeited game's own cut-short flags never deny the stayer); a no-show before the first ball voids the series and
  the stayer goes back to the front of the queue; `new_opponent` halves only a win over a new player; settlement writes
  through the identities frozen at pairing, so turning stats off mid-series is that seat's forfeit and cannot void the
  opponent. R10 counts series, not games, and leaves the series in progress out (R11b too). Series ids are stamped from
  boot time so a restart never rewrites an older series' deltas. A Ranked seat may be held twice (or 2 x 15 s) and
  stall 2 x CAL_S in all before its next drop or stall is the forfeit (tournaments keep today's rules). A restart voids
  the series in flight ("Updating. The Ranked match is void, no trophies changed."); nothing of Ranked is revived.
- **Data** (legal pages in this commit): a `ladder` table per owner (trophies, rank and division, best and when, Ranked
  W/L and streaks, Matt queue W/L, Matt trophies awarded today; migration 2) and `match_log.mode`, `series`,
  `delta_a/b`. It folds into the account on sign-in (max trophies, sums of counts), goes with the owner on delete, and is
  in the export (poddle-export-2). Newly shown to others: the rank emblem and division beside a name on Ranked courts.
  Never sent: the opponent's trophies, any id or address.
- Small fixes on the way: MATCH FOUND clears the warm-up's confetti and any toast; "New best" leaves out "(was …)" when the
  old value rounds to the same number.
- Tests: test/ranked.test.mjs (6 servers, ~5 min: queue, warm-up, pairing, series, settlement, every forfeit path,
  refusals, restart, leak scan), test/ranked-e2e.mjs (two Chromes through a whole series), test/ladder.test.mjs; menu,
  profile-ui, ui-next, verify and shoot gained the new views. deploy.sh runs ladder.test and ranked.test.

## 113. Ranked client review fixes: late results, the leaver's line, spectators, a queued sign-in, contrast and live regions

- **A result heard on reconnect** (the rkLate replay). A seat held while its socket was down, whose series settled
  meanwhile, got back only its `rkres`. The client drew it into a result card that was not showing and 5 s later its
  watchdog said "Updating. The Ranked match is void, no trophies changed." although the trophies were written. An `rkres`
  that answers a `&rk=1` reconnect now ends the watchdog like `rkend` does: off the dead court, onto the Ranked view with
  the line (`+33 trophies`, `Forfeit: 20 trophies`). The restart toast now writes Ranked with a capital (both toasts).
- **The Ranked view's line** puts the change as applied first: `Void`, then `Forfeit: 20 trophies` (my own leave, Q Q,
  stats off, a held seat that ran out) or `−20 trophies`, `+33 trophies`, the floor (`You keep Silver`, `Forfeit: you
  keep Silver`), and "No trophies: that match didn’t count" only when nothing moved and I did not leave. The card's trophy
  row follows the same order, and a win by forfeit shows its Walkover (from the series card's `matchover.forfeit`: rkres
  has no such field, the server is unchanged). The line is held over the view's own redraws (showRanked draws it twice),
  so it is also shown when a parked result's court closes behind a set-up screen, and after a refusal.
- **Off dead courts.** An `rkfail` on a Ranked court (Play again refused, stats off, no hello) comes after the server took
  the seat, with no `closed`: the client leaves the court at once, then says why. The VS card's fallback does the same
  from a warm-up, and an `rk { phase:'off' }` under a warm-up leaves it too. Leave on the series card works after Play again.
- **Spectators** of a Ranked court never send `&rk=1` (they reconnect to watch like anyone) and never get the queue state
  or pill. Q, C, B and 1-4 do nothing under a VS card (the seat is already drawn).
- **A sign-in, sign-out or stats switch while queued** no longer drops the queue: the socket reopens once Ranked is left
  (a warm-up has no hold). A forfeit's rkres is waited for before a held redial goes.
- Smaller: the queue pill starts from its own entry's clock and its 30 s hop re-bases; the rank-down shrink stays shrunk;
  Find a match stops saying Searching when a request times out; /api/me's ladder and Your stats feed the home tile;
  with stats off the Ranked view focuses See all ranks; the '1 waiting' badge breathes on a halo so its bump plays.
- **Accessibility.** The stadium footer and the NAME pill reach 12:1 and 5:1; rank ink is the rim colour 15% darker as
  text (Gold 5.1:1, Silver 5.4:1) and the VS card's label is lifted toward white (Champion 5.2:1); the division tag has
  an 11 px floor and empty alt text (no "Silver II II"); the queue pill's timer and the GAME card's countdown are
  aria-hidden, so the live regions announce changes, not ticks. A series court reserves the lozenge's width for MATCH
  POINT (8.6em; 7.3em with tighter tracking at 900 px and under), so the tabs never jump; at 600x900 the tabs are 19 px
  narrower than before for the whole series.
- **Legal pages** (dates stay 2026-09-27): Ranked needs Save my stats on, and turning it off during a started Ranked match
  is that match's forfeit, its loss still saved (and counting for the deletion schedule); the controls are named where
  they now are (the privacy page's section 9; Delete my data for the account); the section 2 Ranked row lists every
  ladder column (best trophies, best streak, Matt queue wins and losses, Matt trophies today, the series id); the IP row
  lists the Ranked queue's cap (two per network) and its no-same-network pairing. docs/ropa.md, docs/RANKED.md (a client
  DEVIATION list) and docs/ui-spec.md follow. changelog dateModified and the '/' lastmod are 2026-09-27.
- Tests: test/menu.mjs B7 gains the rkLate replay (rkres on rk=1, no void toast after the watchdog), the leaver's lines and
  a Ranked warm-up spectator's reconnect; test/ui-shots/verify.mjs reads the tag's alt-text form and no longer stops at
  the stamp NOTES 104 removed.

## 114. More stats (return rate) and a share card

The owner (2026-09-27): more stats on Your stats, "like return rate (amount of balls you actually are able to hit back)",
and a **Share card** button that copies a poddleball.com link which unfurls as a stylised picture wherever it is pasted
(iMessage, Discord, X, WhatsApp, Slack, LinkedIn): a word-of-mouth feature, so the card has to look great. The contract is
docs/SHARE.md; it was built in three parts (A counting, B link/page/picture, C Your stats) and merged here.

**Counting (server/stats.js, game.js point(), db.js).** Nine running totals per profile over every match kind (Matt,
people, tournament): hits, returns, chances, winners, aces, smashes, points won / lost, seconds played (`PLAY_COLS`, added
idempotently after the numbered migrations: the Ranked branch owns migration 2). The rules:
- a contact while `m.rally === 0` is the seat's own serve (a hit, not a return); every other contact, held blocks and
  volleys of a ball going out included, is a return and a chance;
- point() now passes `(winner, why)` to `stats.pointEnd`; on 'double bounce' / 'passed' (won by `ball.lastHit`) the loser
  gets a chance it missed and the winner an ace (rally 1: only the serve was struck) or a winner; 'out' moves points only;
- smashes are read when the kind can no longer change (the seat's next contact, the point's end or onEnd), not from
  strike(): a bet's power is capped at SMASH there, and the settled report rewrites `pl.hit.kind` in place later;
- points are counted per point (not from the final score), so a revived match is not counted twice;
- the totals are added in recordMatch by their own statement (`playAdd`, not a wider profSet) only when the seat's
  `record && bests`, clamped 0..1e6 a match; one owner in both seats adds the seconds once; fold() adds a guest's totals
  into the account (clamped 1e9: lifetime seconds pass 1e6); profileOf returns them as `play`, so the export has them.
- Known edge: the 9 s auto-serve and Matt's serve call launch() with no contact, so an unreturned auto-serve is an ace
  with no hit; the idle rule usually turns that match's bests off anyway.

**Share link, page and picture (server/share.js, server/card.js, api.js, game.js).** Table `share(owner_id PK, slug
UNIQUE, created_at)`, one link per owner; the slug is 10 reject-sampled `[A-Za-z0-9]` from `crypto.randomBytes`, never
derived from an id. `POST /api/share` (session wins, else the guest's device id) answers `{ url, image }`
(`https://poddleball.com/c/<slug>` hosted, `http://<host>` locally; `image` = `<url>.png?v=<hash>`), `DELETE` is 204 and
idempotent; `/api/stats` and `/api/signin` profiles carry `share: { url, image } | null` so the click can copy
synchronously (Safari). `/c/<slug>` is a small page on the site's look (the card big, "Play Poddle free", "Make your own
card") with absolute og/twitter tags, `noindex` (meta and header) and `max-age=300`; `/c/<slug>.png` is the 1200x630
card with a strong ETag = the hash (304 on a match). The hash is a 12-hex sha256 of exactly what is drawn plus `CARD_V`
(bump it on any visual change so unfurlers fetch the new picture). Unknown or malformed slugs are a 404 (the site's
404 page, an empty 404 for .png) and never render.
- What the card draws (card.dataOf, read at request time, nothing from the query): the username or "Poddle player"
  (guest display names are never stored), the rank from trophies (`rankOf`, exactly web/profile.js drawRoad), the
  toughest Matt beaten in difficulty order in its level colour, up to three big figures (return rate from 20 chances at 50%+ since the review fixes below,
  longest rally, fastest swing, then W-L vs people, streak, titles, winners/aces from 10, matches) and up to three
  chips; zeros are left off. The call to action is "Think you can return my serve? Play free at poddleball.com".
- Rendering: SVG -> PNG with `@resvg/resvg-js` (package-lock carries `@resvg/resvg-js-linux-x64-musl` for the alpine
  image), M PLUS Rounded 1c 500/800/900 converted from the site's woff2 subsets to TTF under server/fonts/ (OFL.txt);
  text is measured from the fonts' advance widths so a 12-character name fits. Safety, since the server is one process:
  resvg is required lazily inside try/catch; rendering and PNG encoding run in one long-lived, unref'd worker thread,
  one card at a time, a 16-deep queue (503 beyond), a 15 s job timeout; an LRU of the last 64 PNGs keyed slug+hash; a
  per-computer budget of cache-miss renders (keyed hash of `abuse.computerKey`, own daily salt, 30 a minute,
  `SHARE_RENDERS`) answering 429; any failure serves web/og.jpg (max-age 60) and logs one fixed line an hour. No slug,
  name or id is ever logged. A render takes about 80 ms off-thread; PNGs are 190-240 KB (under WhatsApp's ~300 KB).
- Merge (db.mergeDevice) deletes the guest's share row before the owner goes: the link dies, it never moves to the
  account. deleteOwner and the sweeps take it through the cascade. exportOf has `share: { url, created } | null`.

**Your stats (web/profile.js, index.html, ui.css).** A play row under the people strip: the return-rate ring with a big %
and "N of M returned" (under 10 chances: "Return 10 balls to see it"), then winners, aces, smashes, total hits, points won %
and time on court. No `play` in the profile (an older server, the Ranked branch before its merge): the row stays hidden.
**Share card** sits in the card header after Sign in / Sign out (a labelled gold button since the review fixes below; it was a round gold icon beside Google's, so the header
stays one row at 1280x800) and shows only when the profile carries a `share` key. The click copies the known link at
once, or POSTs and hands the clipboard a `ClipboardItem` promise inside the click (writeText, then a selected field, as
fallbacks), toasts "Link copied" and opens the share sheet (openCard pattern, Escape, focus trap and return): the picture
with a skeleton, the link with Copy ("Copied!"), Download image (`poddle-card.png`), Share... where `navigator.share`
exists, a name line ("Sign in to put your name on your card", or pick a username), and Stop sharing with an inline
confirm. No new browser storage keys.

**Integration.** The three branches merged cleanly. Reconciled: part B's `db.playOf` fallback (a card drawn before
profileOf had `play`) is gone now that it does; test/profile-ui.mjs's fake answers the real image shape
`<url>.png?v=N` and serves a committed card render there instead of og.jpg; `og:image:alt` reads "A Poddle player card"
for a guest and says "degrees a second". Checked end to end against a real server on a scratch database seeded through
recordMatch: `/api/stats` play totals, POST /api/share, the page's absolute og tags, a real 1200x630 PNG with 304 on its
ETag, Your stats in Chrome (77%, the six figures), Share card (one POST, the link on the clipboard, the sheet showing the
rendered card), Download image (a real PNG) and Stop sharing (the old page and picture 404).
Kept deviations from docs/SHARE.md: `og:title` is "A player on Poddle" for a guest (not "Poddle player on Poddle"); the
page's h1 is "Think you can return <Name>'s serve?" plus one explainer line; `CARD_V` is in the hash; `/api/signin` also
carries `share`; fold clamps at 1e9; smashes read at settle time (above).

**Legal.** Privacy (Last updated 2026-09-27): the play totals in the statistics row; a share-link row; the IP purpose
covers share requests and the render budget; section 4 "Shared cards" says exactly what anyone with the link sees and
that the page asks not to be indexed; section 6 names the apps a link is pasted into as recipients that fetch it and may
keep previews; section 7 retention (until Stop sharing or the profile goes; a merge deletes the guest's link; a browser
may reuse a loaded card for five minutes; other apps' previews are theirs; a guest who turns stats off without deleting,
or clears storage, can no longer reach Stop sharing, so the link lives until the guest sweep or an emailed request); section 9 (Stop sharing, the export and
Delete my data include the link); section 11 (random code, 404s never render); section 13 a contract basis for sharing;
section 15 dated. Terms: a Shared cards paragraph in section 5 (public to anyone with the link, personal non-commercial
use, we may disable a link) and resvg (MPL-2.0) in section 9's list. CLAUDE.md "Current data flows" (memory, database,
Public), docs/ropa.md 3a, docs/ACCOUNTS.md (profile `share`, export `share`), the changelog and sitemap lastmod follow.
No home-page notice: sharing is opt-in and the changelog carries the change.

**For the Ranked session** (done: see "Merged with Ranked" below): when ranked merges, `rankOf(profile)` in server/card.js must switch to the ladder rank
(RANK_NAME + divisions); it is the one function to change, and bump `CARD_V` with it so every card URL changes. The
play counters use their own `playAdd` statement and `PLAY_COLS` columns (no MIGRATIONS entry), and stats.js's seatAcc,
onEnd seats map and `pointEnd(m, winner, why)` are the lines to merge with care.

**Review fixes (before launch).**
- Memory (critical): each render left ~3.5 MB of native memory (resvg's pixmap, tree and PNG) that is freed only when the
  worker's V8 collects, and its JS heap stays near 4 MB, so it rarely did: 100 renders in a row took RSS from 45 to 361 MB
  (the Fly VM has 256 MB; an out-of-memory kill ends every match). The worker now turns on `--expose-gc` for itself and
  collects after every job: 45 -> 122 MB with the cache full. test/share.test.mjs asserts under 100 MB of growth.
- Smashes: reaim() now says whether the ball flew as the settled kind; when it did not (a lofted bet, or a settled
  landing that cannot clear the net, which flies as struck) `pl.hit.kind` goes back to what it was struck as, so a smash
  is counted only if it flew as one.
- Stop sharing while signed in on a browser whose guest stats did not merge (the caps) now stops that guest's link too,
  as Delete my data deletes both (the privacy page, section 7, says so).
- A 503 (render queue full) refunds its charge on the per-computer render budget: the retry Retry-After asks for is no
  longer a 429.
- Operator: `node server/admin.js unshare <link or code>` and `unshare-user <username>` (docs/ACCOUNTS.md 11.7), which the
  privacy page's "ask us to delete it" and the Terms' "we may disable any link" needed. Sending the link is enough (it
  grants nothing more than itself), and privacy section 9 now says that proof of ownership is not asked for it.
- Card pictures in memory: Stop sharing, Delete my data and a merge drop that link's cached PNGs (`card.forget`); the
  sweeps and the admin CLI cannot reach the server's memory, so privacy section 7 now says pictures stay in memory until
  replaced or a restart and are never shown through a deleted link.
- The changelog no longer says every signed-in card carries a username (only one that has picked one).
- The card, legible where it is seen (a chat thumbnail ~300-400 px wide shows 1200 px at a quarter to a third): tile
  labels are short (RETURNS, RALLY, SWING, RECORD, STREAK...) and drawn at 32 px (was 24), captions at 32 px ("°/s" as on
  Your stats, not "degrees a second"), chips 30 px (52 tall; one that does not fit is skipped, not the rest), the call to
  action's second line 30 px in white (the pale gold was ~3.5:1 on the blue). `CARD_V` 2. `label` keeps the long names
  that share.js words the og tags from; the tile draws `tag`.
- The card flatters or stays quiet: the return rate is a tile only from 20 chances at 50% or better, the rally from 5
  hits (Your stats still shows both); the next figures move up and the tiles widen. Kept deviation from docs/SHARE.md
  ("shown only from 10 chances up"). A guest's "Poddle player" is 56 px in grey, not the 86 px headline (the words stay
  exactly "Poddle player", as the privacy page and terms quote them). No chips: taller tiles with the call to action
  right under them, centred in the panel (the fresh card had a 90 px blank band).
- /c/<slug>: the "Think you can return ...?" line is navy with a white lift (white on the pale sky was ~1.7:1).
- Your stats: Share card is a labelled gold button at every size (it used to shrink to an unlabelled gold circle
  whenever Sign in with Google showed, which is every guest). Google's subtitle is now "Keep your stats on every device"
  so both fit one header row at 1280x800; on a phone Share card has its own full-width row. A short landscape window
  (under 561 px tall, e.g. 1366x500) keeps the six play figures in one row ("N of M returned" under the %), ~30 px
  shorter than the 2x3 block; the card still scrolls there by ~24 px, as short windows do by design (profile-ui asserts
  the one row and no cut label, not no-scroll).
- Design polish round 1 (a judge scored the card 6/10), `CARD_V` 3: the record vs people is on the card only from 3 wins
  with more wins than losses (a 1-14 was a hero tile and in og:description), matches played is a chip, never a tile, and
  1-4 winners / aces / smashes are no chip. The swing (a deg/s figure a stranger cannot judge) now ranks after the
  record, streak and titles, and a lone tile puts its caption beside the figure. What the game is, on the picture: a
  PICKLEBALL tagline under the wordmark, the call to action's second line "Your phone is the paddle · poddleball.com",
  and the badge "Beat the Tour bot" (nobody outside knows Matt is the AI; the og text says "Matt (the bot)"). The call to
  action always sits on the panel floor; with no chips the tiles grow down to it (no blank band). og:description ends
  "Pickleball with your phone as the paddle. Play free at poddleball.com"; og:title stays "<Name> on Poddle" (the spec).
  /c/<slug>: the card picture is a link to / (its alt names it), the h1 no longer repeats the card's question ("<Name>
  plays pickleball with a phone for a paddle."), then "Free in your browser, with your phone or AirPod. Your turn."
  The card shows less than before, so the privacy page and terms need no change.

**Merged with Ranked** (NOTES 112-113 were deployed while this was built; merge commit on share-int, then this):
- The card's rank is the Ranked ladder's, exactly what Your stats' hero now shows (one rank per player): `rankOf` in
  server/card.js reads `profile.ladder` ("Gold II", its trophies); no ladder (never played Ranked) is Bronze I with 0
  trophies, as drawRoad reads it. The NOTES 103/107 trophy tiers (Bronze..Legend, 10 a win and first-win bounties) and
  the metal medal are gone from the card.
- The emblem is the real artwork, not a lookalike: web/emblems.js now exports its sprite (`SPRITE`; the browser's
  `installSprite` is unchanged) and card.js loads the module through Node's require(esm) (Node 24 here and in the
  Dockerfile), lazily and inside try/catch (if it ever fails the card keeps the rank's name and loses only the emblem).
  Every sprite id is prefixed `em-` on the card (the sprite's sheen is `sh`, as is the card's drop-shadow filter) and
  the tier's symbol is inlined at 222 px in the left column, over a soft glow, rays from Platinum up (clipped under
  the PICKLEBALL tagline), a drop shadow, and the division on a white pill over the emblem's lower edge in the rank's
  ink (`.st-em[data-div]`). "PLAYER CARD" takes the same ink (the rim colour 15% darker). Crisp at 1200x630 and at
  400 px (test/ui-shots/share/*-400.png).
- Trophies: the gold pill says "240 trophies"; at 0 it is left off (the card's rule since round 1: zeros are never
  drawn), a kept difference from Your stats, which prints 0 with "Play Ranked for your first trophies".
- og:description leads with "Silver II rank"; og:image:alt, twitter:image:alt and the page's img alt say "Silver II
  rank, 240 trophies, ...". `CARD_V` 4, and an 8-hex digest of the sprite and RANKS is in the hashed data (`em`), so
  every card URL changed now and a redrawn emblem changes them again without a bump.
- test/share.test.mjs: the rank from profile.ladder (Silver II, Pro III, Bronze I without one), CARD_V and the emblem
  digest in the hash, each tier's symbol inlined verbatim from the sprite, prefixed ids, the numeral, name and trophies
  in the SVG, and the served page's og:description and alts for a player seeded through db.ladderApply (and Bronze I
  for one who never played Ranked). test/share-shots.mjs fixtures carry `ladder` across every rank, plus champion-3
  (the longest name, CHAMPION III) and pro-top (Pro III, 1046). test/profile-ui.mjs's fake answers `ladder`, `play`
  and `share` together.
- Merge: db.js keeps migration 2 (ladder) with `extra()` after the migrations loop, profileOf returns `play` and
  `ladder`, the export is poddle-export-2 with `share`, `counts()` lists ladder and share (accounts-unit updated);
  stats.js/game.js auto-merged (Ranked's mode/series beside the counters and `pointEnd(m, winner, why)`). Legal pages,
  ropa 3/3a and CLAUDE.md carry both features; the shared card now names the Ranked rank, its emblem and trophies
  (privacy 4 and 15, terms 5), dates stay 2026-09-27.

## 115. Ranked touch-ups: tone-matched medals, an info circle, no You group in Settings, an even logo ball, a floodlit stadium, reset-stats
- **Medals.** The owner: "i dont like the neon yellow pickleball on the ranked medals. can u make them tone matched". Each medal's
  ball is now drawn in its own rank's tones (web/emblems.js `BALLS`, one `#pb1..#pb7` per rank instead of the shared neon `#pb`):
  pale bronze on Bronze, silver on Silver, soft gold on Gold, icy blue on Platinum, cyan on Diamond, lilac on Champion, cream gold
  on Pro. The share card inlines the same symbols (server/card.js); its emblem digest changes, so card links get a new `?v`.
  test/share.test.mjs checks each card uses its own rank's ball.
- **Ranked view.** "get rid of the see all ranks button … just make it the i circle icon next to it small": a small info circle
  (`#btn-rk-all`, same id, `aria-label="See all ranks"`) at the end of the keep line opens the Ranks page; it keeps a 44 px target.
- **Settings has no You group** (the name field, Sign in, Sign out): "that would prob break some things if u signed out mid game".
  Renaming, signing in or out redials the socket, which mid-series is a Ranked forfeit. The name is set on the lobby's name row and
  the account is managed on Your stats, where no match is running. profile-ui and ui-next follow.
- **The logo ball** has seven even holes, one centred and six on a ring 60 degrees apart ("7 holes aligned evenly … with one hole in
  the centre"): the title (ui.css), the phone page (pad.css), How to play, favicon.svg, favicon.ico / favicon-32 / icon-192 /
  icon-512 / apple-touch-icon (re-rendered from favicon.svg with the same ground and ball size) and the share card's CTA ball.
  The holes are sized in em, not %, so every hole is the same size (a % stop scales with each gradient's distance to the far corner).
  og.jpg still shows the old ball until it is re-rendered.
- **The stadium is floodlit** ("really hard to see your opponent because of how dark it is"): sun 1.75 -> 3.4 and a lighter fill
  (hemi 1.15 -> 1.9, sky #b4c6ea / ground #4a5468), the park's brightness; the court, kitchen, apron and stands a shade lighter, fog
  pushed back. The sky stays night. test/venue-shots.mjs checks the floodlit sun.
- **Operator reset:** `node server/admin.js reset-stats <username>` (db.resetStats): the account's profile back to fresh, its Matt
  record and Ranked ladder removed, the owner unlinked from match_log (R10/R11 history starts again); the account, username, devices,
  sessions and share link stay. Run on the machine as the other admin commands, after `backup`.

## 116. Save my stats removed: stats are always recorded

The owner (2026-09-28): "remove the save stats option, thats stupid." Stats are now recorded for every player who plays
(a guest by the random device id in `poddle.device`, a signed-in player by the account). There is no switch anywhere.
Download a copy and Delete my data stay exactly as they were in the privacy page's Your data box.

**Client.** `web/profile.js`: `statsOn()` is gone; `hello()` always sends the device hello and `seated()` always makes the
id; `init()` deletes a leftover `poddle.stats.on` on every load (a player who had turned it off would otherwise keep a
dead key); the storage listener for that key and `statsChanged()` are gone. The `key === null` case (site storage cleared
in another tab) keeps what it did: `drawAcct()` and a redial so the next match's hello is a new socket's first. The
'Stats are off' line and the statsOn gates on the result-card notice and `pf-notice` are gone; both notices now read "Delete
them any time on the Privacy Policy page" (was "You can turn this off on the Privacy Policy page"; kept as short, since a
longer line pushed Your stats' Sign in / Share card row under the name at 1280x800, which profile-ui caught). `web/data-tools.js` loses the
`tog-stats` handler, `web/privacy.html` the switch paragraph, `web/how-to-play.css` its `.data-switch` rule. Ranked:
`main.js` no longer gates Find a match on stats, no longer calls `rkQuit` on `rkfail nostats`, and drops the view note;
`ui.js` rkView loses `statsOff` (Find a match is never disabled; `go.disabled = false` so an old state cannot stick).
`RK_FAIL.nostats` stays with new copy, "Ranked couldn’t save your trophies. Reload and try again": the server's
`rkTick` still sends it to an entry that never said hello within `RK_ARRIVE_S` (storage refused the device id, a bad
Origin), which a current client can still reach.

**Server: kept, as compatibility.** `game.js` still accepts `{type:'nostats'}` (`noStats`, `rkOptOut`, the `ws.statsOff`
refusal in `rkQueue` and `rkSeat`, `stats.optOut` / `identOf`), commented as for a tab loaded before this change only.
Such a tab keeps doing what it promised its player (records nothing) until it reloads; after the reload the key is
deleted and it records. Removing the path would have been no simpler and would let an old stats-off tab start recording a
signed-in account silently. The server tests of that path (auth 9c, ranked's nostats refusals and forfeit,
accounts-unit optOut) stay, relabelled as old-tab compatibility.

**Legal (same commit).** Privacy: Summary ("Statistics are recorded for every player and are private ... There is no
setting to turn statistics off. You may download them or delete them, and your account, at any time in section 9 of
this page, and you may object to them by emailing us."), section 2 (the device-id row no longer says "while statistics
are switched on"; the statistics paragraph now says they are recorded for every player, no off switch, nothing saved if
storage is refused and not signed in, download/delete any time, object by email, and that a match played after a
deletion is saved again under a new id; statistics leave the "optional" list), section 5 (`poddle.device` rotates on
sign-out and delete only; `poddle.stats.on` row: "No longer used ... The game deletes it if it finds it"; the "feature
that you may switch off" and "switch it off with Save my stats" sentences replaced by Delete my data), section 7 (share
links: the stats-off clause removed), section 9 (take action yourself: "download or delete your statistics in the box
below"; the switch paragraph removed from Your data), section 13 (PIPEDA: implied consent by playing, withdrawal by
deleting, signing out or writing to us, and that play afterward is recorded again; GDPR row: legitimate interests Art.
6(1)(f), "You may object at any time by emailing hello@danielrltan.com, and you may delete these statistics yourself at
any time with Delete my data"; no consent is claimed), section 15 (a dated line for September 28, 2026). Terms 5: "for
every player who plays ... There is no setting to turn this off; you may download or delete your statistics at any
time", and the "Ranked can be played only with Save my stats on" sentence removed. Both pages, their ld+json and the
sitemap (and changelog.html, which gains a September 28 entry, "Your stats are always saved; delete them any time on
the privacy page") are dated 2026-09-28. CLAUDE.md's data flows, docs/ropa.md (basis, share links, Ranked leavers),
docs/ACCOUNTS.md (3.1, 9.6, the test plan, Q5, the section 10 drafts), docs/RANKED.md and docs/ui-spec.md mark the switch
REMOVED 2026-09-28. The Sept 25 changelog entry ("you can turn this off") is left as history. Not done: a home-page
notice (privacy 15 promises one for important changes); the changelog entry and the new result-card / Your stats notice
copy are what ships. Risk carried (ACCOUNTS.md Q5): the strict EU/Quebec reading of ePrivacy 5(3) / Law 25 privacy by
default is no longer mitigated by any switch.

**Tests.** `test/profile-ui.mjs`: the switch test becomes a regression for a player who had it off: the privacy page has
no `#tog-stats` / `.data-switch` and Download / Delete are still there, Delete still carries the id, a stored
`poddle.stats.on='0'` is gone after the next load, the seat after it makes a new id and sends its hello, and no socket
says `nostats`; section D no longer seeds the key. `test/ui-mock.html` rkView loses `statsOff`.

## 117. Ranked polish: the trophy moment is the hero, MATCH FOUND is a bumper, the GAME card reads sooner

The owner wanted "lots of emphasis on the ranked match experience" (Brawl Stars / TV-show style), then "do the visual polish pass". The drama comes from the emblem, light, motion and layout. There are no text slams (NOTES 104). Presentation only: web/ui.css, the render functions in web/ui.js, the trophy row's markup in web/index.html, and one freeze line in test/ui-mock.html. No data, protocol or copy changes, so the legal pages are untouched.
- **Series card (and the Matt warm-up card, which shares the row).** The trophy row is one centred block:
  - the rank's emblem card at 5rem (emblemCard: the emblem, its name "Silver III" and the division tag);
  - the total in 5rem tally digits in trophy gold, over a small caps "TROPHIES";
  - the change as a pill, with the Rank up / Division up pill hanging under it (absolutely placed, so the row never shifts).

  The count-up contract is unchanged: the final textContent from the first frame, the @property roll from 1100 ms, static under reduced motion. The ceremony (ui.rankUp) re-points the same card:
  - **Rank up:** the emblem swaps to the new rank, pops and stays 12% larger with a halo in its colour, and the rays open behind it (now centred on the emblem, not on the card with its label). One transform band of light crosses the card (`#result-flash.is-sweep`, its own `rk-sweep` keyframes so it replays after the win's). "Bronze to Platinum are yours to keep" goes on the line under the row.
  - **Division up:** a pop, and the numeral flips on its tag (`.rank-card-em.is-flip::after`).
  - **Down:** the gentle shrink as before, with "Down to Platinum III" on the line under the row (or "Forfeit · down to …").
  - The kicker's fill is the rim colour 15% darker (white on Silver's rim was about 4.2:1).
- **Paying for it (1440x900 and 1280x720 share one 52.9rem budget).** On the series card, NOTES 115 does five things:
  - It shrinks the medal to scale 1 (from 1.2), with 1rem less room above the card and 1rem less inside it, and .75rem less at the bottom.
  - It shows the games in 5rem digits.
  - It makes `#result-note` `.is-quiet` (visually hidden, still read out). "2-1" was drawn three times (the note, the pips, the tally).
  - It also makes the rank name quiet after a ceremony, since the emblem card's label now shows it.
  - "Priyanka left" on a forfeit stays in sight.

  The textContent is unchanged, so ranked-e2e's `^\d-\d$` note and verify's "Gold I…" still read it. The rank-up card at 1280x720 now spans 82..706 (was -4..715 with the medal clipped at the top).
- **Emblems beside the tally names at .is-md** with their division tags; they hang into the row's padding.
  - Fixed on the way: every `.rank-badge` at .is-xs (score tabs, and the tally before this) drew its division as bare text under the emblem, because the generic `[data-div]::after{content}` rule had no size guard. It showed as one to three thin sticks.
  - The xs badge now shows the emblem alone.
- **MATCH FOUND** is a broadcast bumper:
  - A thin cyan-white band sweeps once across the navy card (a skewed `::after`, translateX, 1.1 s from 120 ms; the card clips it).
  - The VS is 7.5rem in landscape (it stays 5rem in portrait, where the names need the width).
  - Each emblem card sits on a soft glow of its rank's colour, with its tag clear of the name.
  - The opponent's count is still never shown.
- **GAME card:**
  - "Game 2 in 6", its bar and "Priyanka serves first" are fully in sight by about 680 ms (they were at 1100 ms; checked live at +700 ms). The title, score roll (ov-ink kept equal to the counter's end, 760 ms) and pips moved earlier with them.
  - The winner's pip row is gold, lifted and 4% larger.
  - The deciding game glows amber behind a warm card, and "Deciding game" is a pill.
  - The score line already sits under the title for spectators ("Daniel takes game 1", 7-4), so it is unchanged.
- **HUD:**
  - Series pips are a size up (.8125rem) in the deep colours on a more opaque lozenge. The game in play breathes by scale instead of fading to a quarter.
  - GAME POINT / MATCH POINT is a filled pill (white on the side's ink, 4.9:1). It keeps inside the width the lozenge already reserves, so the tabs never move. That was measured at 1440, 1280, 600 and 390. It needed a stronger selector than the narrow lozenge's .04em tracking.
  - The queue pill's dot breathes (a swell plus a ring rising off it; static under reduced motion).
- **Views:**
  - The home tile's emblem is 2.5rem. It had been picking up the tile icon's 5rem through `.tiles .tile svg`, beside a 9 px line; the line is now at least 12 px, weight 800.
  - Your own rank's card on the Ranks page is tinted in its colour.
  - The Ranked view is unchanged: See all ranks and its keep row belong to another branch.
- Mock: the two new sweeps freeze past their end in stills (`--freeze-at`), so no bright band crosses the names.
- Checks:
  - `shoot.mjs` covered all 29 Ranked screens at 1440x900, 1280x720, 600x900 and 390x844: nothing clipped, no console errors.
  - `verify.mjs` has only the 3 known main failures (lobby-courts 44 px, tourney-banner 12 px x2). All Ranked checks pass, including the contrast of the warm deciding card (5.72:1) and the gold row (7.25:1).
  - `ranked-e2e`: 30/30 PASS.
  - Before and after stills are in test/ui-shots/rk-before/ and rk-after/ (not committed).

## 118. Share card: no taunt line, the same six stats on every card

The owner: "Think you can return my serve?" was corny, and the card should not pick flattering stats, so cards compare.
- **Call to action** (server/card.js): "Play free at poddleball.com" over "Pickleball in your browser · your phone is the paddle".
- **Fixed figures**: every card draws the same six tiles in two rows, in one order: return rate (with its bar), longest
  rally (hits), fastest swing (°/s), record vs people, best streak, winners. Zeros are drawn; '-' only where there is no
  data at all (no ball to return yet, no measured swing). No chips, no thresholds (NOTES 114's 20-chance / 50% / winning-record
  rules are gone). One figure size for all six. The trophies pill (0 too) and the bot badge ("No bot beaten yet") always show,
  so the left column is laid out the same on every card. The name moved up so its descenders clear the tiles.
- og:description names the same figures (return rate, rally, record vs people), leaving out a '-'.
- CARD_V 5: every card URL changes, so chat apps fetch the new picture. Privacy (the six stats, zeros included), terms,
  changelog, ropa and CLAUDE.md say "the same six stats"; the pages were already dated 2026-09-28. test/share.test.mjs checks
  the fixed six on weak, fresh and losing profiles and the '-' rule.

## 120. Ranked: the Matt warm-up is optional (queue in the lobby, a search bar at the top)

The owner: "make matt warm ups optional before queueing ... queue -> dropdown to warm up appears -> stays there until match is found / player
decides to warm up" (the Overwatch search pill). docs/RANKED.md 3.1, 3.3-3.6, 3.10, 8.1, 8.2 and 9 are marked OPTIONAL WARM-UP 2026-09-28.

**Server (server/game.js)**
- `rk` queues the socket where it is, in the lobby: no court, it stays in the lobby set (lobby pushes keep coming) and hears
  `rk { phase:'queue', warm:false }`. The court-capacity `busy` at entry is gone (waiting needs no court; `rkPick` still checks there is a
  court for the series). `full`, `addr`, `nostats`, `intour`, `nocid` and the `RK_COOL_S` cooldown are unchanged; the `addr` count skips
  the socket's own cid and entries whose socket closed (a reload is not a second player).
- New `rkwarm {}` (in `RK_MSGS`): only while queued, in the lobby, not in a series and not already warming up; anything else is ignored.
  It seats the player on the private warm-up court exactly as before (Matt at the rank's level, the bounty, pause, the Beat Matt ladder)
  and the snapshot says `warm:true`. No court free, or within `RK_WARM_COOL_S` (1 s) of the last warm-up closing: `rkfail { why:'busy',
  warm:true }` and the entry stays (the same court churn `RK_COOL_S` stops for `rk` / `rkleave`).
- The warm-up court's `onClose` no longer ends the entry. `leave` from it (Back, Q Q, Stop warm-up) is `quit` + `enterLobby` + a fresh
  `rk { queue, warm:false }`; a `closed away` lands the same way. Only `rkleave`, stats off, no hello in `RK_ARRIVE_S`, or the socket
  closing end an entry.
- A closed socket's entry is kept `RK_BACK_S` (default `HOLD_S`, 15 s) for its `&rk=1` return, never counted or paired meanwhile. A return
  with `&room=` (it was warming up; that court closed with the drop) gets a new warm-up; one without is re-queued in the lobby; both keep
  `since`. An open socket's entry is never swept, however long it waits (tested past ROOM_TTL, RK_ARRIVE_S and HOLD_S).
- While queued in the lobby, `quick | create | join | watch | tcreate` answer `joinfail { reason:'inrk' }`: the VS card's seat would
  `quit()` whatever court they were on (a forfeit or a Matt loss in someone else's room).
- Pairing is unchanged: a warming player is pulled off Matt with nothing recorded, a lobby player goes straight to MATCH FOUND. The
  no-show's stayer is re-queued in the lobby (`rk { queue, warm:false }` after `closed round`) instead of a new warm-up; Play again on
  the series card queues in the lobby too.

**Client (web/main.js, web/ui.js, web/index.html, web/ui.css)**
- Find a match stays on the Ranked view: nothing is seated, no camera / connect / calibrate. It first calls `profile.seated()`: a first
  visit has no device id until a seat, and without a hello the entry could never be paired (the server drops it after `RK_ARRIVE_S`).
- `#rk-search` (`ui.rkBanner({ on, since, tier, div, busy })`), outside `#hud`, fixed top-centre above the screens: while queued and off
  court it hangs from the top edge of the title and of every lobby view (over the header's title; Back and the online count stay clear),
  dropping in (420 ms, none under reduced motion): the rank emblem, `Finding a match` and the wait (m:ss, textContent once a second,
  aria-hidden), `Ranked · Silver II`, then `Warm up with Matt` (rkwarm through `request()`, disabled while it is out; the normal set-up
  screens to the warm-up court, where the bar gives way to the pill) and `Cancel` (rkleave). At 560 px and under it sits below the header
  on two rows (one text line) and the lobby's content moves down 44 px + 3.25rem. Focus goes to Warm up with Matt when Find a match turns
  grey under it, and back to the view on Cancel. 44 px targets, the 12 px text floor, no backdrop-filter.
- Leaving the warm-up (Back, Esc on the set-up screens, Q Q, Stop warm-up, `closed away`) keeps `rkQueued` in `toLobby` and lands on the
  Ranked view with the bar. MATCH FOUND can come from any lobby view or the title (the title's phase becomes lobby so the seat's set-up
  screens follow the VS card). Play again's snapshot on the series card takes the player off it to the Ranked view, queued.
- While queued the client never asks for another court: `You’re in the Ranked queue. Cancel it to play something else` (also the
  `joinfail inrk` toast). The lobby's and the snapshot's `queued` include my own entry: the tile, the pill and the view now count only
  someone ELSE, and the view never says `Someone is waiting to play` while I am queued.
- Copy: the view's line is `You can warm up with Matt while it searches` (queued: `In the queue. Warm up with Matt or cancel from the bar
  at the top`); the rules line says `The warm-up with Matt is optional`; the warm-up's Leave button is `Stop warm-up`; the pill's small
  line is `You stay queued if you leave`. Gone: `You play Matt while it looks for someone`, `Matt warms you up while you wait`, `Matt
  keeps you warm`, `Leave queue`.

**Legal**: the device id is now also made when a first visit joins the Ranked queue (before, only at a first seat): privacy.html's
statistics table and the section 5 `poddle.device` row say so; Last updated / dateModified 2026-09-28, sitemap lastmod. CLAUDE.md's
data-flow line ("made at first seat") is left for the lead to update with the merge. Nothing new is sent, stored or shown.

**Tests**: test/ranked.test.mjs (section 1 rewritten: the lobby entry, the refusals while queued, the idle case, rkwarm, leave keeps the
place, the warm cooldown, rkwarm ignored when not queued and in a series; section 3: two lobby entries pair; section 17: reconnect in the
lobby and on the warm-up, a warming player pulled into MATCH FOUND, the RK_BACK_S grace; every other section warms up explicitly or
checks the lobby state), test/ranked-e2e.mjs (Ann queues, sees the bar, presses Warm up with Matt and plays; Ben queues from the lobby;
MATCH FOUND for both; Play again queues the winner in the lobby, the bar over the title, Cancel), test/menu.mjs (the fake knows rkwarm and
the lobby-queued state; Part A and B7 walk the new flow; a first visit's hello goes before rk), test/ui-mock.html + shoot.mjs
(`rk-search`, `&over=home|courts|title`, `&busy=1`; overlap pairs against Back, the online count, the name row, the title's Play and
logo), verify.mjs (the bar at 1440, 600 and 390 wide).
- A press on the bar over the title is not a press of Play (main.js's pointerdown skips `#rk-search`): Cancel stays on the title, Warm up
  with Matt goes to the lobby itself. A paddle swing on the title still means Play.

Results (this worktree, run one at a time): ranked.test PASS; ranked-e2e PASS 40/40; menu: only the 7 known failures (kept, lob gate, panel
rows x2, Sensitivity +, spin, V H keys; one run also saw a flaky Part A "Esc: pause twice", clean on the rerun); profile-ui 82/83, the one
failure ("nudge ... focus not taken") is the same on a clean HEAD; ui-next the known 8; seo STRICT=1 PASS; verify the known 3 plus 9 new
ok checks for the bar. Shots: test/ui-shots/rk-search*-{1440x900,1280x720,600x900,390x844}.png, ranked-e2e-00-queued-*.png,
ranked-e2e-08-title-bar-*.png.
- The refused Warm up toast (no court free, or the 1 s cooldown after a warm-up closed, which Back then Enter can hit since focus lands on
  the button) says `Can’t start a warm-up right now. Try again in a moment. You’re still in the queue`: true in both cases.

## 121. Plainer copy across the site
- The owner: "'matt keeps u warm' wtf is this copy writing, i need u to do an ultracode sweep across the entire website and get rid of bs
  like this". Six readers went through every player-facing string (the game page, ui.js, main.js, profile.js, How to play, What's new,
  404, the phone page, the share card and page, and the legal pages for fluff only); an editor merged them into one list under one
  glossary, then the list was applied to the current tree (edits written before the stats switch, the polish and the optional warm-up
  landed were applied by intent, or skipped where the copy no longer exists). Legal meaning is unchanged.
- Glossary:
  - The bot is Matt everywhere in the game and site (never 'the bot', 'Matt the bot' in UI, 'a bot', 'Tour Matt'). A level is written '<Level> Matt' (Club Matt). One exception: the share card image, og description and alt text say 'the <Level> bot', because strangers don't know Matt.
  - Matt's levels are Rookie, Club, Tour, Pro. Level descriptions follow a pace-plus-accuracy pattern: Slow and forgiving / Medium pace, some mistakes / Quick, few mistakes / Fast and accurate.
  - The Ranked warm-up is 'You play Matt while you wait for an opponent'; the pill says 'Playing Matt while you wait'.
  - A place to play is a court, never a room or a game ('This court is full').
  - Ranked is always capitalized. A rank is a rank, never a tier. There is no 'trophy road' and no 'placing'.
  - The floor rule is always 'Ranks up to Platinum are never lost once reached. Diamond and above can drop'. The Ranks page tag is 'Never lost'.
  - First trophies: 'Play Ranked for your first trophies'.
  - Matches that don't count are 'Not counted' on the pill and 'don’t count' in notes. There is no 'Void' and no 'Walkover' ('Opponent forfeited').
  - Server restarts: 'Poddle is updating' / 'Poddle was updated'. 'Matches resumed after a Poddle update don’t count'.
  - Auto movement: 'the game moves you to the ball'. The setting is 'Move: Body / Auto'.
  - The browser permission dialog is the 'camera prompt'. You 'choose Allow'.
  - Sound devices are 'speakers', never 'output'.
  - The set-up screen is 'Connect your phone' / 'Connect your AirPod', with a Phone / AirPod switch at the top.
  - Paddle code: 'P- and 4 letters or numbers', shown as P-ABCD.
  - Tournament: 'start' (not 'begin'), 'create' (not 'make'), 'With an odd number of players, Matt fills the empty spot'. Champion: 'You’re the champion' / 'You won the tournament'.
  - Stats tile hints are instructions: 'Win a match to start a streak', 'Win a tournament to earn a title', 'Keep the ball in play', 'Swing hard to set a record'.
  - US English: recenter, color, license.
  - No exclamation marks, em or en dashes, or ellipsis characters in UI strings (lobby rule applied site-wide).
  - Keep the existing curly apostrophe (’) in JS files that use it; how-to-play, legal pages and JSON-LD use straight quotes.
  - Safety line: 'Check behind you before you swing' (used on title, how-to-play and pad).
- Examples: "Matt keeps you warm" / "Matt warms you up while you wait" -> the search bar and "You can warm up with Matt while you wait";
  "Bronze to Platinum are yours to keep" -> "Ranks up to Platinum are never lost once reached"; "Win one match to light the flame" ->
  "Win a match to start a streak"; "Win a tournament to lift a cup" -> "Win a tournament to earn a title"; "Grab your paddle" ->
  "Connect your phone"; "This game is full" -> "This court is full"; "B adds a bot" -> "Press B to play Matt"; "No answer. Try again." ->
  "The game didn't respond. Try again."; "Recentre" -> "Recenter" (US English); level blurbs Club "Medium pace, some mistakes", Tour
  "Quick, few mistakes"; "Toughest Matt beaten" -> "Hardest level beaten".
- The tests that pin strings follow (menu, ui-next, profile-ui, ranked-e2e, verify, the e2e harnesses, ui-mock).

## 122. The VICTORY! stamp is back on a win

The owner wanted the old stamp that slammed onto the win screen back, reading VICTORY! (the reverted "Victory!" title, commit
2d8dfc5, was not it). NOTES 104 removed the GAME! stamp (#result-slam, commit 1b590e3); it returns with the owner's word:
- **VICTORY!** slams onto the result card (big italic blue, white stroke, ov-slam: in at 2.4x, settles, gone by 380 ms, before
  the title pops) on a win of your own only: a match against Matt or a person, a Ranked series. Never on a loss, a forfeit win,
  while watching, or on the champion card. aria-hidden; reduced motion hides it. The screen shake and the white flash of
  section 97 stay gone; the light sweep of NOTES 104 still crosses the card.
- The result title is unchanged ("You win", "You beat Matt", "You win the match" as NOTES 121's plainer copy has them).
- test/ui-next.mjs checks the stamp's text on a win (it asserted no stamp since NOTES 104).

## 123. Platinum is tinted aqua

The owner asked for the Platinum rank to read more aqua. web/emblems.js RANKS[3].colour is deep #1f7a86 / mid #a8ece8 (was
#3f6f8f / #cfe3ef, a silver-blue close to Silver), and the octagon's gradient g8, inner ring and pickleball use the same aqua
family. It stays greener and paler than Diamond's sky blue. Everything that reads RANKS (the Ranks page cards, the rank pills
and emblems, Your stats, the RANK UP beat, the share card's emblem and ink) follows; the share card's emblem digest changes, so
card URLs refresh.

## 124. An eighth rank, Master, and medals that evolve by division

The owner asked for one more rank between Diamond and Champion, then for medals that change with each division ("i wanted
division evolutions"), and for Pro to have no divisions but a number on a leaderboard. The last part shipped first from a
parallel session (NOTES 126, the global leaderboard and "Pro #N"); this section keeps that and adds the rest. Spec: docs/RANK8.md.

- **Eight ranks** (server/ladder.js TIERS, web/emblems.js RANKS; test/ladder.test.mjs asserts they agree): Bronze 0, Silver 150,
  Gold 300, Platinum 450, Diamond 600, **Master 750** (new, tier 6), Champion 900, Pro 1050 (tier 8, no divisions). A rank stays 150
  wide. The name Master is Claude's pick (the owner did not name it): rename it in those two tables only. The Matt ceiling stays
  899, now defined as the Champion floor - 1: Matt carries a player to Master III at most (mattWin 4 in Master, 0 from Champion).
  ladder.js divFloorOf now returns Pro's floor whatever division is asked.
- **Existing players**: trophies never change. db.js extra() re-derives tier/div from trophies and best_tier/best_div from
  best_trophies on every open, in one UPDATE inside the extra() transaction, built from the frozen rank table and rewriting only
  rows that disagree (a second open changes 0 rows; a row an older build writes is healed on the next open). 750-899 was Champion
  and is now Master, 900-1049 was Pro and is now Champion, 1050+ is Pro. No MIGRATIONS entry. test/accounts-unit.test.mjs checks
  every count 0..1200 against ladder.js and the boundaries 749/750/899/900/1049/1050, and that re-opening changes nothing.
- **Medals evolve by division** (web/emblems.js: 22 sprite symbols, `rank-<tier>-<div>` for tiers 1..7 and `rank-8` for Pro,
  `emblemId(tier, div)`, `hasDivs(tier)`; every drawing helper takes the division): I is the medal as before; II adds a second rim
  in the rank's metal with four studs; III adds a soft glow with rays and gems in the NEXT rank's colour, so III reads one step from
  ranking up. Master is a 12-point ruby rosette. Pro keeps one medal, the most ornate. ui.js passes the division everywhere a
  medal is drawn (Your stats crest, rank badges beside names, the result and trophy cards, the Ranked tile and view, the search
  bar); on the Ranks page your rank shows your division's medal, ranks passed their III, ranks ahead their I. The Ranks grid is
  4 + 4 (2 a row under 900 px). Sheets: test/ui-shots/emblems.png (150 px) and emblems-xs.png (24 and 20 px); gallery
  test/emblems.html. About 10.5 KB added to emblems.js.
- **Share card**: the division's own medal, Master, and "PRO #N" on the pill from the owner's trophies place on the global
  leaderboard (share.js reads db.leaderPlaces only for a Pro owner; plain "Pro" when not listed), CARD_V 7; renders for
  Master I-III, Champion III, Pro #1 and #27 in test/ui-shots/share/.
- test/leaderboard.test.mjs (NOTES 126): its Pro fixture moved from 960 (now Champion II) to 1100 trophies.
- Legal and docs: privacy (eight ranks in the rank emblem item, a dated line in section 15), how-to-play (eight ranks, growing
  medals, Pro #N, and the leaderboard: it had still said every rank has three divisions and trophies are never shown), the
  changelog (September 28), CLAUDE.md data flows, docs/ropa.md, docs/RANKED.md (override note, rank table). No new data is
  stored or shown: Master is a new name for trophy counts already kept.
- The Ranks page line "Pro is won only against people" stays removed (NOTES 125).

## 125. The Ranks page drops "Pro is won only against people"

The owner: the line reads as if the other ranks were not won against people. The Ranks page note now ends at "Diamond and
above can drop." (The rule behind it, that queue wins against Matt stop paying at 899 trophies, is unchanged.) Numbered 125
because 124 is taken by the eighth-rank work in progress (docs/RANK8.md).
## 126. A global leaderboard, and Pro has no divisions
- The owner: "add a poddle leaderboard page to the main menu ... most interesting kind of stats e.g. longest rally ... one for the
  trophy count ... on ur stats, you will have a leaderboard number (Champion #301) ... 3 tabs ... ensure that players know that
  they're looking at global leaderboard". Then, mid-build: "pro wont have divisions, you just go right on the leaderboard ... think
  about like valorant immortal rank".
- A sixth home tile, Leaderboard (a podium), shown where the server has its database (like Ranked). The page (/leaderboard, title
  "Global leaderboard", a GLOBAL "All signed-in players, every country" pill) has three tabs: Trophies (Ranked `ladder.trophies`),
  Longest rally (`profile.best_rally`, counted by the server, 3 and up) and Win streak (`profile.h_best_streak`, counted matches
  against people). Fastest swing and hardest hit are left off: the phone reports them (docs/ACCOUNTS.md Q14). Top 100 per board, a
  tie shares its number (1 + everyone above), gold / silver / bronze numbers for the top three, the DEV pill and the rank emblem
  beside each name, my own row outlined, and a You bar under the list ("#6 Your global rank", or why not: sign in, pick a username,
  hidden, or the board's first step).
- Who is on a board: accounts WITH a username only (guests have no stored name and never appear), minus anyone who turned off
  "Show me on the global leaderboard" (new `accounts.lb_hidden`, added in db.js extra(); on by default). The switch sits on the page
  for a signed-in player with a username; hiding, renaming and deleting clear the 30 s list cache so a name leaves at once.
- Server: `db.leaderboard(board)`, `db.leaderPlaces(owner)` (the same population and order, so "#N" on Your stats is the row's number),
  `db.leaderHide`; indexes on ladder(trophies), profile(best_rally), profile(h_best_streak). Routes: GET /api/leaderboard?b=trophies|rally|streak
  (public, 60 a minute, rows are rank/name/value/tier/div, never an owner id), POST /api/leaderboard/hide {hidden} (signed in).
  /api/stats and /api/me carry `places`. The export says `globalLeaderboard: shown|hidden`.
- Your stats: a globe pill beside the rank name with the trophy place ("Champion II #6"), a button to the leaderboard; hidden for a
  guest, a player without a username, a hidden one, or 0 trophies.
- Pro has no divisions (the owner, like Valorant's top ranks): ladder.js / emblems.js `divOf` is 1 at Pro, `hasDivs(7)` false,
  `rankName` / `rankLabel` say plain "Pro", `nextDivFloorOf` is null in Pro; old rows with div 2/3 read as Pro through `proDiv` in db.js.
  A Pro player's own rank reads "Pro #12" (the trophy place) on the Ranked tile, the Ranked view head and the Ranks page; Your stats
  says "Pro" with the #12 pill. No numeral pill on the Pro emblem (ui.css data-div is removed for Pro), no pips on its road step, and
  the Ranks page's Pro card says "By leaderboard place". The share card draws Pro with no pill (CARD_V 6). Other players still see
  only the Pro emblem in a court (the place is not on the wire).
- Legal (same commit): privacy sections 1 (summary), teens, 3 (table: the switch; Ranked purpose), 4 (Statistics no longer says "We
  do not publish leaderboards"; a Global leaderboard item; Usernames), 5 (new `poddle.lbSeen`), the legal-basis table (legitimate
  interests with the switch and objection), 15 (a dated paragraph); terms 5; changelog; docs/ropa.md; CLAUDE.md data flows. Home
  notice: a one-time toast for a signed-in player with a username ("Your username can now appear on the global leaderboard. You can
  turn this off on the Leaderboard page"), shown once the lobby is up (opening the lobby clears toasts) and only then remembered in `poddle.lbSeen`. Pages were already dated 2026-09-28.
- Tests: test/leaderboard.test.mjs (new: population, minimums, order, ties, places equal rows, hiding, export, the routes, no ids);
  ladder.test (Pro), share.test (CARD_V 6, PRO with no pill), menu and profile-ui (six tiles: 2 over 4, 2 / 2 / 2, one column).
- Decisions made without the owner (reversible): the three boards; on by default with a switch (existing accounts signed up under "no
  leaderboards"); accounts only; top 100; a guest sees "Sign in to get on the global leaderboard", no number.

## 127. The Leaderboard tile animates like the others

The owner asked for the Leaderboard home tile (NOTES 126) to get its own icon animation; every other tile had one (Quick
play's play button, Courts' lens, Play a bot's head, Your stats' bars, Ranked's trophy). On hover (looping) and on keyboard
focus (once), the podium rises in finishing order, third then second then first (ic-step, each step from the floor, 120 ms
apart), then the star spins up over the top step and lands on it (ic-crown). web/ui.css only; the global reduced-motion rule
clamps it like the rest.

## 128. Matt's level is free in the Ranked warm-up

The owner: "why is matt's level locked during the rank warm up??? users should be able to change freely". It was locked on
both sides: main.js hid the Difficulty row and the 1-4 hint on any Ranked court, and game.js botRequest refused `bot` there
(reason 'ranked'). Now a warm-up court (opts.kind 'warm') takes `bot` like any Matt court; a series court still refuses. The
warm-up still starts at the rank's level (ladder.js mattLevel).
- The bounty stays fair: rkMatt pays mattDelta only when the level the game counted at (stats' easiest level used, rec.level)
  is the rank's level or harder (BOT_ORDER). An easier Matt is practice: delta 0, rkres `easy: true, need: <wire level>`, and the
  trophy card says "Practice · Trophies need Club Matt or harder". Without the gate a Master could farm Rookie Matt.
- test/ranked.test.mjs: the warm-up accepts a level change (it asserted the refusal), and a Gold player who drops Matt to
  Rookie and wins gets no trophies (easy, need Club). how-to-play and the changelog say so.

## 129. Wins over new players count again (R11c off)
- The owner: "i dont think any of my stats are being saved. can you look into that and why??" The production log showed a Ranked
  series settle "(+17/0)" while both of its games logged "match recorded: human unranked". +17 is half of a 2-0 sweep's 33: R11c
  (docs/ACCOUNTS.md 5.2, abuse.js) had flagged the loser as not yet established (an owner under 24 h old with fewer than 3 recorded
  matches). R11c withholds the WINNER's whole record for that game (win, streak, rally best, play counters; the card says "didn't
  count") and Ranked halves the trophies. With a handful of players nearly every opponent is new, so the owner's wins never saved.
  His two Matt courts saved nothing either: one he left after 12 s, the other (a Ranked warm-up, 5-0) was closed by the match found.
- Asked what the winner should keep against a new opponent, the owner chose "Count everything": R11c is now OFF everywhere unless
  STATS_ESTABLISHED=1 (it used to be forced on in production). No new_opponent flag, no halving. The rule's code stays for that switch.
- Tests: accounts-unit checks the default is off (dev and production), keeps its R11c cases with the switch on, and adds "a new loser
  is an ordinary loser". ranked.test sets STATS_ESTABLISHED explicitly on every server, so it is unchanged. docs/ropa.md follows.
  The privacy page and terms never described R11c, so they do not change.

## 130. VICTORY! is paced: its own beat, then the card

The owner: the VICTORY screen goes way too fast; use the timing of the old GAME! pop-up. That update (8cd58f1, NOTES 97)
slammed GAME! in and out within 380 ms, while the card's whole entrance played underneath from the same moment, and NOTES 122
restored exactly that for VICTORY!. So the fix is pacing, not a copy of the old numbers:
- VICTORY! has its own animation (ov-victory, 950 ms): in by 114 ms (the win sting's impact, scene.js), held, gone by 950 ms.
- The card waits for it: ui.js matchResult sets #screen-match.is-stamp, which pauses every animation in the card (and the light
  sweep) at its first frame, so the card is unseen; at 780 ms the class drops and the medal, rays, title, score count-up, crown,
  claps and stats play their usual entrance. The buttons are still keyboard-focused and clickable at once.
- Only on a win of your own (as before); reduced motion skips the stamp and the wait. RANK UP keeps its short slam.
- test/ui-next.mjs reads the counted-up scores at ~2.1 s instead of ~1.3 s.

## 131. Longest rally is the Leaderboard's first tab

The owner asked for Longest rally to be the first tab on the global leaderboard (NOTES 126). The tabs read Longest rally,
Trophies, Win streak, and the page opens on Longest rally (web/profile.js `board`). The #N place pill beside the rank on Your
stats still opens the Trophies board, since that number is a trophy place (ui.js sets lb-tabs data-want, showBoard reads it).
The API's own default board (?b omitted) stays trophies; the page always asks for a board by name.

## 132. A small notice when you set a new personal best mid-match
- The owner: "when a new record is set mid game, throw up a small notification that's non invasive. use existing notification
  component like the one we have for watcher joined".
- The server decides (stats.records, called in game.js point() right after stats.pointEnd): a seat's best of THIS match (the same
  bestRally / bestSpeed that are saved at the end, so the swing is a settled phone or AirPod peak, capped, never swingBad) is compared
  with the best already saved on its profile (read once per seat and match). Past it, that seat alone gets { type: 'record', what:
  'rally' | 'speed', v } at the end of the point, never mid-rally and never to spectators. A higher best later in the match is told
  again; the swing only when it changes in the tens of deg/s that Your stats shows.
- Only a player with a best to beat is told (saved rally 3+, saved swing above 0): a first match does not announce every point.
  Matt and anonymous seats never. Whether the match counts is still decided at its end; the card says when it did not.
- The client: ui.recordNote(what, v) on the watcher pill (notePill, shared with ui.watcherNote): a gold star, "New best rally: 14
  hits" / "New fastest swing: 1,570°/s", 3.6 s, at most three pills. test/records.test.mjs covers records(); test/menu.mjs stubs recordNote.

## 133. Ranked is for signed-in players with a username
- The owner: "rank should be disabled for guest accounts... so many small considerations like this were not thought about, be sure to do that".
- Server (game.js): rkWho(ws) -> null | 'signin' | 'username', from a FRESH db.accountById (a username claimed after the socket opened counts at
  once, no reload; the socket's acct.username is updated too). rkQueue refuses with rkfail signin | username (also reached by Play again on a
  series card). rkTick drops a waiting or warming-up entry whose socket lost its account (signed out in another tab: stats.forget; Delete my
  data) with rkfail signin and takes it off the warm-up court. rkRebind (&rk=1) drops an entry that came back signed out, unless it is in a
  live series, which always finishes on its frozen identity (the result still lands on the account). rkPick never pairs an identity without an
  account (backstop). RK_GUESTS=1 lets guests queue for the tests (ranked.test, ranked-e2e, stats.test set it); production ignores it.
- /api/me carries rkSignin (the same rule). The client: profile.rkGate() -> '' | 'signin' | 'username' (only when the server says rkSignin, so
  an older server and the fake /api/me in menu / profile-ui behave as before). The Ranked tile's line says "Sign in to play" / "Pick a username
  to play" with the emblem dimmed; the tile is hidden where Ranked needs a sign-in but sign-in is off. The Ranked view's button becomes "Sign in
  to play Ranked" (opens the sign-in card) or "Pick a username" (the username form), with a line saying why; Find a match never reaches the
  queue for them. Sign-in, sign-out and a new username redraw the open view (Your stats, Leaderboard, Ranked, Ranks) and the tile. A reload on
  /ranked re-reads the gate after /api/me (it used to be computed before). Your stats' rank caption for a guest: "Sign in to play Ranked".
  A refusal on a socket that opened before the sign-in cookie (the race) says "Connecting your account. Press Find a match again" and reconnects.
- Guest trophies earned before: kept on the guest profile, merged into the account on sign-in on that browser (db.mergeDevice already merges
  the ladder row). Spectating Ranked courts stays open to everyone.
- Legal: privacy 2 (the Ranked row) and 15 (a dated paragraph), terms 5, How to play (section and FAQ), changelog (Sept 29, with NOTES 129 and
  132), sitemap lastmod, docs/RANKED.md 3.4, CLAUDE.md.
- Tests: test/rksignin.test.mjs (new, a real server with the gate on: guest refused, no username refused, a claim then queues on the same
  socket, a named account queues, signing out while queued ends the entry, production ignores RK_GUESTS).
- Decisions made without the owner: a username is required too (Ranked names go on the leaderboard; the username form follows sign-in anyway);
  a guest's share card still shows Bronze I, 0 trophies.

## 134. The leaderboard's You card gets its own padding; the developer's DEV pill becomes a hammer
- The You card under the global leaderboard (web/index.html #lb-you) used a list row's padding (.25rem top and bottom,
  .5rem on the left), which only works beside a rank badge. When you are not on the board (guest, no username, hidden,
  no result yet) the badge is hidden and "You" and its line sat half a rem from the border. It now has its own padding
  from the spacing tokens (--s-3 top and bottom, --s-5 on the left with no badge, --s-4 on a phone), a 4rem minimum
  height, and the same width as the list's rows (the list pads them .25rem in); the Show me switch row matches.
- The developer's badge beside the username Dan (ui.js regBadge, NOTES 106) is a white hammer in an orange disc instead
  of the letters DEV. Same element, class, aria-label and title ("Developer"); test/profile-ui.mjs checks for the svg.
- test/ui-shots/sweep.mjs: the real index.html (?acctest=1) against a fake game socket and a fake /api, every lobby
  view, the You card in all six states (guest, nouser, hidden, none, outside, listed), Settings and the static pages,
  at 1440x900, 1280x720 and 390x844, with a data-fit / sideways-scroll check. `node test/ui-shots/sweep.mjs <out> [filter]`,
  SWEEP_PORT (default 9460), SWEEP_SIZES, SWEEP_DPR. Screenshots go to the out dir (default test/ui-shots/sweep, not committed).

## 135. The developer's hammer badge has a tooltip; the name is no longer orange
- Hovering the hammer beside the username Dan (NOTES 134) shows a small dark "Developer" label above it (below when
  there is no room), and a tap shows it for 1.6 s. One floating element fixed to the window (ui.js badgeTip), so a
  scrolling list such as the leaderboard never clips it; it hides on scroll. The text is the badge's aria-label, and the
  native title tooltip is gone so the two never show together.
- The developer's name is shown in the normal name colour (the owner's ask); the .is-dev class stays as a marker only.

## 136. Custom tooltips everywhere; a gold trophy icon in place of the word "trophies"
- No browser tooltips anywhere on the page. ui.js turns every title attribute, in index.html or set later by code (rank
  emblems, Matt chips, the stats figures, the pen, emotes, ping, See all ranks), into data-tip the moment it appears (a
  MutationObserver), and one floating label (.tip, fixed to the window, so no scrolling list clips it) shows it: 80 ms
  after the pointer rests on it, at once when Tab focuses it (not when a menu focuses its first control by itself), and
  for 1.6 s after a tap. Above the element, below when there is no room; wraps at 18rem; hidden on scroll, click and Esc.
  A title that was an element's only name moves to aria-label, one that adds to it to aria-description, so screen
  readers keep it. The developer's badge (NOTES 135) and the rank emblems write data-tip directly. Replaces badgeTip.
- A filled gold trophy (svg .cup-ic, aria-label "trophies") stands for the word: after the number on the leaderboard's
  Trophies board (rows and the You card) and on Your stats' rank line ("240 [cup] · 10 to Silver III", was an outline
  cup before the number and the word). The Ranked view's big count and the match-end trophy roll still say "trophies".
## 137. The username Dan plays as its own character: plain white, glowing orange eyes, an orange headband
- The owner's ask: the developer's account (registered username Dan) always plays as a fixed character, overriding the
  side's shirt, skin and hair: an all-white figure (body, head, hands, shorts, shoes: 0xf0f0f0, off-white so the park sun
  does not clip it), no hair, the default eye shape lit from inside in orange (a near-black base with an orange emissive,
  so it glows the same in sun and floodlight and never washes to yellow), and an orange headband around the forehead
  (an open cone cut to the head sphere, above the eyes) tied at the back with a knot and two short tails.
- TEMPORARY, until cosmetics exist. Everything lives in web/scene.js `LOOKS` / `LOOK_NAMES` / `lookFor(name, reg)` under a
  "named looks" comment. To remove it: empty LOOKS (or drop the `dan` entry). To turn it into cosmetics: have the server
  send each seat's look id beside `names` / `reg`, and feed that to `scene.setLooks` in main.js `dressSeats()` instead of
  `lookFor`; buildAvatar's `danFace` parts are the pattern for more.
- How it works: main.js `dressSeats()` runs whenever names or regs change (welcome, `names`, leaving a court) and calls
  `scene.setLooks([look0, look1])`; `paint(pd, matt)` composes Matt, the named look and the default and resets every
  part both ways. Shorts and shoes got their own material (`kit`, was the eyes' `dark`). `ghostify` now lerps each
  material's own emissive toward the paused grey instead of setting every emissive to 0.3 k (the old code zeroed any
  glow; every existing pad material has a black emissive, so nothing else changes).
- Edge cases, decided without asking:
  - Only a REGISTERED username counts (`reg === true`, any case). A guest who types "Dan" gets the normal look. Usernames
    are unique and confusable-folded on the server, so only the owner's account can carry it (the same rule as ui.js
    DEV_NAMES and the hammer badge).
  - Matt's seat never takes a named look; the menu's attract rally is nobody's (it comes back when the rally stops).
  - Everyone sees it: the opponent, spectators, every view (broadcast, split, pov, free), both venues, Ranked and
    tournament courts. Dan's own POV shows it at the usual see-through SELF_A, and Show player model off hides it as before.
  - Paused / calibrating / reconnecting: the usual pale ghost; the eyes' glow fades to the same grey as everything else.
  - Signing in mid-court: the seat's name becomes the username at the next join, so the look appears then (as the badge
    does). Renaming the username away from Dan drops the look.
  - Legal: nothing new is sent, stored or shown beyond the already public username; the look is computed on each
    client. No change to privacy.html / terms.html; CLAUDE.md's data-flow line notes it.
- Tests: test/scene-next.mjs "named look: Dan" (colours, hair and eyes hidden, glow intact after ghostify, Matt unchanged,
  setLooks([null, null]) restores, attract rally, lookFor cases) and a front / back / Matt render
  (test/ui-shots/scene-next/dan-front-back-and-matt-1280x720.png). scene-preview.html takes `&dan=0|1`.
- Follow-up after a verification workflow (a visual judge with 72 renders, a code review and a regression run, each
  finding re-checked by a skeptic): (1) the headband's tails were rotated INTO the back of the head (rx +0.38 swings a
  hanging end forward); now rx -0.12 and a little longer, so they hang clear down the back. (2) The band read brown on
  its shaded side (the side a spectator mostly sees): a small emissive (0x4d2408, intensity 1, so ghostify fades it with the
  rest). (3) The eyes are pure emission now (black base, roughness 1): no white sun highlight. (4) An older bug that
  setLooks made common: paint() ran rebase(), which saved the current, possibly faded colours of EVERY pad material as its
  base, so a look changing while the seat was paused / away left the next player with white eyes and a white paddle rim until
  reload. paint() now updates only the bases of the materials it sets; rebase() runs once at build. scene-next checks it.
  (5) test/menu.mjs's scene.js stub lacked the new `lookFor` export, so main.js failed to link and Part B crashed.
  Pre-existing failures seen on 76d87fe and unchanged: ui-next 8, spectate-e2e 1, ranked-e2e 5 (one flaky), revive-e2e 1,
  pad-e2e 1, menu 8 (plus 4 Ranked text checks that still expect the word "trophies", from 32c5549 on main).

## 138. The gold trophy replaces the word "trophies" everywhere in the game
- NOTES 136 put the icon on the leaderboard and Your stats; now every place the game says trophy / trophies shows it:
  the Ranked view's count, the Ranks page (its lead line and every "From 300 [cup]"), the Ranked tile's line
  ("Silver II · 240 [cup]"), the VS card ("Friendly match, no [cup]"), the match-end trophy roll (under the number) and
  its pill and note, the Ranked status line under Find a match (settlements, the sign-in gate), the two Ranked toasts,
  the leaderboard's Trophies tab (icon only, its accessible name "trophies"), its caption and empty-state lines, and any
  tooltip. ui.js cupify(el) swaps the words for the icon (aria-label keeps the word) in elements marked data-cup only,
  so a player's name is never touched (a username "Trophy" stays a name); setText / swapText / profile.js text() on a
  data-cup element remember the words they set. Toasts only when the caller says the words are its own (ui.toast cup).
- The share card PNG (server/card.js) draws the number and a gold trophy in its pill instead of "815 trophies";
  CARD_V 7 -> 8 so link previews fetch the new picture. The og tags, aria-labels and the static pages (How to play,
  changelog, Terms, Privacy) keep the word: they are text for other apps, screen readers and legal reading.

## 139. Site-wide spacing sweep: one padding standard
Five area audits (lobby menus, Stats / Ranked / Leaderboard, in-game, static pages, phone), one standard, then
fit / consistency / regression checks at 1440x900, 1280x720, 600x900, 390x844 and 375-wide phones. Spacing only.
- Standard: the page gutter is one inset for header, body and footer (desktop --s-7: Back now matches the online
  count; phones <=480 --s-5, was 10px); lobby panels --s-6 on desktop and --s-5 --s-4 on phones; a card inside a panel
  --s-3 --s-4 (the NOTES 134 You card); list / settings rows start their text --s-4 from the card edge, and group
  labels and the sheet heading line up with it; --s-3 between sibling cards; sheets --s-4 with --s-3 between groups.
- Lobby: phone gutters on body, footer, Back and online count; at 481-700px and <=480 every wide panel fills the body
  (Courts, Bot, Your stats, Ranks, Leaderboard all share one edge instead of three); Courts / bracket / ranked /
  ranks / bot / create / share panels get the phone panel padding; the courts list trims 1rem on phones so the panel
  keeps its gap above the footer; the tile counters ("2 open") clear the tile icons; Play a bot is 68rem wide so
  Club's subline no longer runs through its card padding, and on phones the sublines wrap; the key-hint items never
  break mid-label; the footer notes get even top/bottom padding.
- Settings sheet: heading, group labels and row text on one edge; --s-4 padding (short windows keep .875rem so it
  does not scroll at 1280x720); rows are at least 40px tall below 700px (tap targets).
- Your stats: the cards' side inset is --s-4 everywhere; on phones Sign out and Share card share a row, so the view
  now fits at 390x844. Ranked search bar, leaderboard scope pill, the You card's value column (it lines up with the
  rows when it has no button), the Show me row and the phone leaderboard tabs.
- In game: the watch-request card no longer stretches to the full phone height (.ask.notice), the ask card's inset,
  bracket headline / round strip / names / Leave on one column edge, the round card on phones, the Ranked queue pill
  lifted clear of the key strip on narrow screens, the camera card's phone gutter.
- Static pages: 24px between cards (was 16), changelog days further apart and 24px above the footer, the footer's
  own padding restored from 40rem up (a shorthand was zeroing it), notes and the data-tools box get even padding,
  Privacy / Terms: space under "Last updated", a wider table-of-contents column gap, table text flush with the
  paragraphs; 404 button centred in its space; the phone paddle page gets 1.5rem on all four sides and no reserved
  empty note line.
- Not changed (deliberate): button shapes, HUD score tabs and rally chips (sized for the game), the Ranked series
  card's height budget, the Ranks page's own scroll. Known and left for the owner: the "Getting ready" (connect)
  panel is taller than the window at 1440x900 and 1280x720 and on phones covers the header title; fixing it needs a
  layout change, not padding.
## 140. Leaderboard names open a profile card
- The owner: "make it so u can view profiles on the leaderboard just by clicking them". Every row of the global leaderboard
  (NOTES 126) is now a button (li.lb-item > button.lb-row, like the court list: type=button, aria-haspopup=dialog, an
  aria-label "3. Kiko, Champion II, 56 hits. Open profile" with ", Developer" on Dan's and ", you" on mine, a chevron,
  a hover lift with a tight pale ring, and a solid deep-blue focus outline of its own, so a focused row never looks like
  my own row at rest; both fit in the list's .25rem padding, which the scroll box would otherwise clip). A click, Enter or Space opens that
  player's profile card (#lbp-card) in #acct-layer over the list: the name (with the hammer on Dan's), the Ranked
  emblem (ui.rankEmblem, a new export: the crest's medal and numeral without touching lastRank) with the rank
  ("Gold II", "Pro #3") and trophies, the toughest Matt beaten on Your stats' Matt disc, and the six share-card
  stats as Your stats' figure tiles. Loading draws the row's emblem at once with six skeleton tiles; 404 says "This
  player isn't on the leaderboard any more"; anything else says "Couldn't load this player" with Try again. Esc, the
  close button and a press on the backdrop close it and hand focus back to the row (found again by data-name when the
  list redrew under the sheet: showBoard draws twice). MATCH FOUND (main.js rkMove), a tournament VS card (tourMove)
  and a seat of my own (seated) close it, so no veil sits over the court.
- Server: GET /api/leaderboard/player?u=<name> (server/api.js playerRoute), public, no sign-in, 60 a minute in its
  own limiter bucket (browsing profiles never starves the list). The name is folded as usernames validate() folds it
  (NFKC, skeleton), so "ACE" and "D1no" find Ace and Dino and the answer carries the stored spelling. The body is
  exactly share.dataOf (card.dataOf, the share card's own subset, now exported, so the card and the profile never
  drift apart): { name, rank: { tier, div, label, pro } | null, trophies, matt, stats: six { label, value, unit? } }.
  rank is null when the account has no ladder row (the same LEFT JOIN test that leaves a row without an emblem). Never
  an owner id, a date, the match log, the slug or the card's internals. Unknown, guest, no username, hidden, renamed
  away, deleted, outside every top 100 and a malformed u all answer the same 404 {"error":"not_found"}; the name is
  never logged. 503 when the database is closed (db.leaderOwnerByKey answers undefined, not null, on a failure).
- Who has a profile (a decision): only an account inside the top-100 ROWS of at least one board (db.leaderOwnerByKey:
  lbBefore_<board> counts the rows lbTop_ puts ahead of it with the same WHERE and ORDER BY, so a tie at place 100 only
  opens for the name inside the LIMIT). Usernames also show in court lists and brackets; a lookup for every listed
  account would publish the stats of people nobody can click, and the privacy page promises "from the leaderboard".
- Cache: 30 s in memory per folded key, 404s too (at most 500 keys). Hide, unhide, a rename and an account delete clear
  it with the board cache (api.js boardsChanged), so a hidden or renamed name 404s at once. Known limit: admin.js
  (rename, reset-stats, unshare-user) is another process, so its changes wait out the 30 s TTL, as the board does.
- Public by default now, for listed players: return rate, record vs people, winners, fastest swing, the Matt badge, and
  the rank label with trophies. docs/ACCOUNTS.md Q14 said swing values and bot wins would never be public because
  both are forgeable; they were public only on an opt-in share card until now. Kept (the orchestrator's decision,
  the owner may overrule): the profile IS the share card, and no board sorts on them. Q14 is annotated. The other
  way, if the owner objects: send '-' for Fastest swing from the API only, and word the privacy page "five statistics".
- My own row opens the same public view (not Your stats): every row behaves the same, and it shows me exactly what
  others see, which is the point of the privacy promise. Its footer says "This is what other players see." with a
  Your stats link.
- No URL: the address stays /leaderboard while the sheet is open. A /leaderboard/<name> path would need server routing,
  a reload-restores-the-sheet flow and would make shareable, indexable profile pages, a new public surface.
- Notice (NOTES 126's mechanism): poddle.lbSeen gains '2'. A browser that never saw the leaderboard notice is told both
  at once; one that saw '1' is told "Anyone can now open your profile card from the global leaderboard. You can turn
  this off on the Leaderboard page" if the player is listed (/api/me places); a hidden player is not told on load, but
  turning Show me on (toggleShow) says "You're on the global leaderboard. Anyone can open your profile card from it"
  and sets '2' at once, unless the browser already holds '2'. No new storage key.
- Also fixed on the way: a press on the veil around any account card (share, sign-in, profile) left focus on <body>,
  because the mousedown that follows the pointerdown blurred what closeCard had just focused: the veil's pointerdown
  now calls preventDefault, and the veil closes on the click, not the pointerdown: closed on pointerdown, a touch
  tap's click was hit-tested after the veil had gone and landed on the leaderboard row under it, opening that player
  instead (a mouse click was fine: Chrome sends it to the common ancestor). The veil ignores presses in the first 350 ms after a card opens (the second click of a
  double click on a row landed on it and closed the sheet it had just opened). The sheet's state is a data-state
  attribute, not a class: .panel.is-error is the red form nudge.
- Legal (same change): privacy.html Summary, For teens and parents, section 2 (IP purpose; match results and Ranked
  purposes), 4 (Statistics, Global leaderboard: what the card shows, who has one, Show me off and rename/delete remove
  it; Usernames), 5 (poddle.lbSeen 1 / 2), 13 (the legitimate-interests row lists the card's contents), 15 (a dated
  line); terms.html section 5; the header comment. Dates already read September 29, 2026 (dateModified, sitemap
  lastmod). CLAUDE.md "Current data flows" (Public, Storage), docs/ropa.md, docs/SHARE.md, the changelog.
- Tests: test/leaderboard.test.mjs (the route's shape and equality with share.dataOf, no leak, case and look-alikes,
  identical 404s, hide/rename/delete clearing at once, the TTL, leaderOwnerByKey, the tie at the LIMIT, the rate
  limit's own bucket, 503 closed). New test/lb-profile-ui.mjs (LB_PROFILE_UI_PORT, default 9740): rows as buttons,
  keyboard, focus trap and return, Esc/close/backdrop, own row, 404, 500 + Try again, a stale answer, a double click,
  the list redrawn under the sheet, a guest's plain GET, fit at 1440x900 / 1280x720 / 390x844, reduced motion, the
  notice, MATCH FOUND. test/ui-shots/sweep.mjs answers /api/leaderboard/player and shoots lbp-* and lb-hover/lb-focus.

## 141. Everyone on the leaderboard is clickable; the trophy icon only beside a number; the Ranked tile's trophy fixed
- The leaderboard profile card (NOTES 140) is for every player on a board, at any place, not only the top 100 (the
  owner's ask). db.leaderOwnerByKey drops the in-the-LIMIT check (and its lbBefore_ statements); still 404 for
  unknown, guest, no username, hidden, on no board, renamed away, deleted. The You card, when I am on the board,
  opens my own card like my row (role=button, Enter / Space, the rows' hover / focus / press). Privacy (the leaderboard
  bullet and the September 29 notice), CLAUDE.md data flows and docs/ropa.md say "on the leaderboard" instead of top 100.
- The word "trophies" is back where it reads as a word (the owner: the Trophies tab, "Ranked Trophies" under the tabs,
  "Win Ranked matches to earn trophies", "No trophies", "Friendly match, no trophies"...). ui.js cupify now swaps it for
  the icon only right after a number ("240 [cup]", "From 300 [cup]", "+12 [cup]"); data-cup="all" marks the unit labels
  that sit beside a number in their own element (the Ranked view's count, the match-end roll, the profile card).
- The Ranked tile's line ("Silver II · 240 [cup]") showed the cup at the tile icon's size (.tiles[data-n] .tile svg,
  up to 6.5rem): #ranked-line .cup .cup-ic sizes it to the line and keeps the tile's press squash off it.
- A long toast wraps (max 46rem, balanced lines, a rounded box) instead of running off the screen: the one-time
  leaderboard / profile-card notice was cut off at 1440 px.

## 142. The Ranks page loses its Play Ranked button
- The owner: unnecessary. The Ranks page (all eight medals, opened from Ranked's info button or the crest on Your
  stats) ended with a Play Ranked button that only went to the Ranked view; Back already returns to wherever the page
  was opened from (ui.js viewParent / ranksFrom). The page's keyboard focus on open is now the Back button.

## 143. The Ranked tile shows the trophy bar
- The owner's ask: the home screen's Ranked tile draws the Ranked view's progress bar (rk-bar, slimmer: .rk-tile-bar)
  under its "Silver II · 240 [cup]" line: the same fill, through the rank's three divisions (Pro stays full), set in
  ui.rkTile from the same tier / trophies. Hidden before a first Ranked match and behind the sign-in / username gate.

## 144. The username Mae plays as a white lop-eared bunny with pink accents and a bow
- The owner's ask: a second named look (NOTES 137), for the registered username Mae: a white lop-eared bunny with pink
  on the ears and nose, and a bow on the head. Built as: white fur everywhere (0xf3f1ef, the skin material, so the body,
  head, hands, shorts and shoes all go white), the default dark eyes kept, no hair; two lop ears hung from the top of the
  head by their tips, broad face forward and swung out (MAE_EAR), each with a pink lining on its front; a pink nose; two
  pale pink blush discs on the cheeks; a deeper pink bow on top between the ears; and a white cotton tail on the back of the
  body (on `upper`, so it crouches with her). Decided without asking: the bow is pink (no colour was given), and the
  cheeks and tail are the "etc.".
- Same machinery and rules as Dan's look: `LOOKS.mae` + `LOOK_NAMES.mae` in web/scene.js; buildAvatar's parts per look now
  sit in `userData.looks` ({ dan, mae }), and paint() shows only the seated look's parts (a seat handed from Dan to Mae
  keeps nothing of his). `eyes: true` in a look keeps the default eyes. Only a REGISTERED username counts; a guest typing
  "Mae" gets the normal look. TEMPORARY like Dan's: remove the `mae` entries to take it away.
- Note: "Mae" was not on the public leaderboard when this shipped (not listed, or not registered yet). The look goes to
  whoever holds the username Mae, so the intended player should claim it if she has not.
- Tests: test/scene-next.mjs checks Mae's parts, eyes, hair and colours, that nothing of Dan's stays, and lookFor for Mae /
  MAE / a guest Mae / Maeve; render test/ui-shots/scene-next/mae-front-and-back-1280x720.png. scene-preview.html takes
  `&mae=0|1`. No legal change (derived from the public username on the client; CLAUDE.md's data-flow line updated).
## 145. The share card shows win rate, time on court and best win streak, and eleven figures in all
- The owner's ask: "for the share card: please put on it your winrate, time on court, etc. top win streak, etc.". The
  card (server/card.js, CARD_V 8 -> 9) keeps its left column (wordmark, emblem, rank, the trophy pill with the count and
  the cup icon, no word; the Matt badge) and the CTA. The right panel now has three white headline tiles over one
  detail well of eight, four across. Every card still draws the SAME figures in the same places, zeros included (the
  owner's earlier rule); `-` (a grey en dash) only where there is nothing to divide or measure.
  - WIN RATE: human.wins / (wins + losses), people only (kinds human + tour, db.js HUMAN; tournament games against Matt
    are tourbot), with the record under it: "31-12 vs people" (en-US commas).
  - ON COURT: play.secs as Your stats' clock() ("11h 6m"; past 100 h the minutes stay), note "all modes": counted
    matches of every kind (not "all matches": uncounted ones add no time).
  - BEST STREAK: human.bestStreak, people only. BEHAVIOUR CHANGE: until now the card took the best of people and every
    Matt rung; now it is the global leaderboard's Win streak board's figure, so a card and the board agree. A Matt-only
    player shows 0 (and a `-` win rate, "0-0 vs people"). Your stats' own streak display is unchanged.
  - The eight: RETURNS, POINTS WON (every kind, Your stats' st-f-points), RALLY (hits), SWING (°/s), WINNERS, ACES,
    SMASHES, TITLES. The return-rate bar is gone. Digits full size, % h m and units smaller (runs of text).
  - Not taken: "N matches played" (`played` also counts uncounted matches, so it would not match the time's basis, and
    it would make a new figure public).
  - Sizes at 1200 px: headline figures up to 66 px (one shared size per tier), their labels 24 and notes 22; the
    detail's labels 22 and figures 36; the smallest typical text is 22 px (7.3 px in a 400 px chat preview, as before).
    A 4,321-1,234 record shrinks only its own note.
- server/share.js: og:description is now "Gold II rank · 72% win rate vs people (31-12) · 11h 6m on court · best win
  streak 7 vs people · 24-hit rally · 86% return rate · beat Tour Matt (the bot)" and the play line; a `-` figure is left
  out (the old blurb looked up 'Record vs people', which is gone). The alt texts read all eleven as words ("time on
  court 11 hours 6 minutes in all modes", a `-` is "none yet") and keep "240 trophies" as a word: spoken text has no icon.
- The leaderboard profile (api.js publicCard) sends the eleven as { label, tag, value, unit?, note?, hero? } ("note",
  not "sub": the leak check keeps "sub" for Google's id). The sheet (web/profile.js drawPlayer, ui.css .lbp-*) draws
  three white headline tiles (figure, the card's short tag, the note) over the eight, four across (two at 480 px and
  under); one dl on a 12-column grid, each tile a div of dt + dd (+ the note's dd). The dt is the card's tag, the long
  name its title (ui.js turns it into the tooltip and aria-description). Figures fit their tile with cqi units ("277h 46m" at 390 px). The trophies line keeps the number and
  the cup (data-cup). STAT_LABELS and the guard are eleven (at six every sheet would stay on skeletons).
- Legal (same change): privacy.html 4 (Global leaderboard and Shared cards list the eleven), 13 (the leaderboard row),
  15 (a dated September 29 line: the new figures, time counts counted matches only, the streak is people-only), the
  header comment; terms.html 5 (eleven, not six). Dates already read September 29, 2026. CLAUDE.md data flows
  (Public), docs/ropa.md, docs/SHARE.md 2, docs/ACCOUNTS.md Q14, the index.html comment, the changelog.
- Tests: share.test.mjs (the eleven labels and values for weak / fresh / losing, the hero notes, no bar, the people-only
  streak against a 9-win Matt streak, commas and 999h 59m, CARD_V 9, the new og:description and alt), leaderboard.test.mjs
  (the new stat shape, the hero three first), lb-profile-ui.mjs (eleven skeletons under the tags, three hero tiles with
  notes, the widest values on Pickle_Rick uncut at 1440 / 1280 / 390), sweep.mjs (eleven for the lbp shots).
  test/share-shots.mjs gives every sample time and points and adds huge, maxed, matt-only and brand-new.

## 146. Friends: search, requests, a friends list with online status, and the profile card's friend row
- The owner (docs/SOCIAL.md): "you should be able to search and add friends. u can add from looking at a profile, or search them and add them from the
  results list. then you should be able to see your friends in a list, and it will show who's online or not. then you can invite them to games / duels /
  invite to watch from inside a game. this means the social menu should be in the game in the pause menu somewhere. think of edge cases and implement
  slowly and carefully." This is slice A of docs/SOCIAL.md 9 (friends, requests, search, presence, the card); invites (play / duel / watch) are slice B.
- Server (db.js EXTRA, no numbered migration): friends(a < b, since) and friend_reqs(from_id, to_id, created_at = the sender's clock, declined_at,
  asked_at = the receiver's, sent), both ON DELETE CASCADE with both FK columns indexed; db.friendOp / friendsOf / friendIds / friendPeers / friendRel /
  friendSearch / accountFresh / playerByKey; exportOf lists friends and requests by username (never ids); the sweep step `friendreqs` (30 d after created).
  api.js: GET/POST /api/friends ({op, name}: add | accept | decline | cancel | remove -> {r, rel, snap}), GET /api/friends/search?q= (2..12 chars,
  prefix or confusable key, top 20, never self), GET /api/player?name= (handler playerCard: rank + places {rank} + rel + st, SOCIAL.md 8). Every name is
  found by its skeleton key. game.js: presence (menu | matt | playing | watching | queue | ranked | tour, the most engaged across an account's lobby
  sockets), a 2 s tick that diffs it and pushes {type:'social'} snapshots to online friends, {type:'socialoff'} when a socket loses its account,
  socialget for a tab that never says hello. MENU_PATHS gains /friends. Social log lines carry no names and no ids.
- Merged with NOTES 140 (the peer's leaderboard profile card, same day): there is ONE card, the peer's #lbp-card. web/profile.js openPlayer(name,
  { from, rank, via, back }) is exported and every opener goes through it: leaderboard rows (unchanged behaviour), friend search results, friends
  and request rows, On this court. The card asks GET /api/leaderboard/player?u= (the eleven stats since NOTES 145, any account on a board since NOTES 141) and, when I am signed in
  with a username, GET /api/player?name= at once (Promise.all; a stale pair is dropped by lbpGen). Board answer: the peer's card as before, plus the
  place pills from /api/player. Board 404 + /api/player: data-state "part": the emblem and rank name from /api/player, no Matt half, no stats, a quiet
  "Stats show for players on the global leaderboard" (a board error instead: "Couldn't load the stats" + Try again); a hidden stranger (places null)
  gets no hero at all, never a false "Not ranked yet". Both 404 (or the only one asked): the peer's gone state ("No player with that username any
  more" when not opened from the board). My own card: the peer's footer, no friend row. The friend row (#lbp-friend) is web/social.js cardRow,
  called through a new profile hook (friend) and redrawn on every push (profile.friendRow): Add friend / Requested + Cancel / Accept + Decline /
  Friends + the live status dot and words + Remove behind a Remove Bea? / Keep confirm. It is rebuilt only when what it shows changes (a
  signature), and a rebuild under the focus puts the focus back on its first button (never <body>: the layer's Esc and Tab trap live there). Our
  own #player-card (markup, pc-* CSS, social.player / drawCard) is gone; the leaderboard's name buttons from the WIP gave way to the peer's row buttons.
- Client, the rest: web/social.js (one panel mounted twice: the lobby view /friends and the in-game friends card from Settings > Friends, the tourCard
  pattern), the home tile (a seventh tile: 3 over 4, 3 / 2 / 2, one column), toasts for new requests only (a socket's first snapshot is silent),
  poddle.friendsSeen (one notice; it waits for the leaderboard notice when both are due). The More button's tooltip is data-tip, never title: ui.js
  (NOTES 136) turns a title into data-tip on the live node, so a freshly drawn row never equalled it and every push swapped the buttons.
- Edge cases and decisions:
  - Guests: no Friends (the tile, view and card say "Sign in to add friends"); on the profile card a quiet link, which starts sign-in only in the
    lobby (profile.inLobby: h.view()), plain words in a court (a sign-in there redials: a forfeit). Guests never ask /api/player.
  - Signed in, no username: "Pick a username to add friends" (the username form in the lobby, words in a court). Nobody can befriend a nameless account.
  - Sign-out / delete: stats.forget takes the socket's account, socialoff clears the lists, friends see the account go at once (socialSoon). Delete
    cascades both tables; the delete path reads peersOf BEFORE the cascade and pushes fresh snapshots to former friends and requests' other sides,
    then boardsChanged() clears the board and profile caches (both kept in api.js del, username and hide).
  - Rename: boardsChanged() and social.changed(peersOf(...)) both run in the username route: boards, profile cards and every list naming the account
    change at once. Admin renames / deletes (admin.js, another process): the presence tick reads accounts fresh by id every 2 s, never trusts
    ws.acct.username; the profile cache waits out its 30 s TTL (NOTES 140's known limit).
  - Id reuse: an account id that no longer resolves to the socket's owner drops the socket's account like a sign-out.
  - Reload: a reload on /friends waits for /api/me ('wait' gate: Loading, never "not available"); an open card is not restored (no URL, as NOTES 140).
  - Silent declines: the sender keeps seeing Requested until expiry; re-adding a decliner answers requested and restarts the sender's clock only.
    Removal: silent; it writes a block row so the removed player's re-adds are swallowed for 30 d; the remover can still add them back.
  - Caps: 100 friends (full), 20 pending out (limit), the newest 50 incoming listed. Rate limits: adds 30/h and searches 60/10 min per account in
    memory, on top of 60 a minute per address per route.
  - Hidden accounts (Show me off) are searchable (the username is already public on courts); their card shows strangers only the username; friends
    still see rank + places. Decision to confirm with the owner.
  - Duel's meaning (a fresh private court, first to 11) is pending for slice B, with the owner.
- Legal: one vocabulary: "profile card" = the card a name opens (NOTES 140 + the friend row), "share card" = the /c/<slug> link. privacy.html Summary,
  For teens and parents, 2 (friends, requests, search rows; IP purpose), 4 (Statistics, Rank emblem, Global leaderboard, Usernames, Shared cards, Friends,
  Profile cards: the eleven stats for any account on a board (NOTES 141); rank + places for every non-hidden account from /api/player, to anyone who knows the username, shown
  in the game to signed-in players with a username; to friends even when hidden; status to friends only), 5 (poddle.friendsSeen), 7, 9, 11, 13, 15
  (two dated paragraphs: the peer's and ours); terms.html 4 and 5 (Friends and profile cards); changelog (Sept 29: "Tap a name on the leaderboard"
  and "Friends"); CLAUDE.md data flows; docs/ropa.md; docs/SOCIAL.md 3 and 6 now name the merged card. Dates stay September 29, 2026 everywhere.
- Tests: test/friends.test.mjs (new, in-process: every op, caps, silent declines, the removal block, expiry, search escaping, the player
  card's hidden rule, no ids on the wire, the export), test/social.test.mjs (new, live on SOCIAL_PORT 9510: the snapshot after hello, presence
  menu -> matt -> watching -> off at a friend, socialoff on sign-out, an admin delete), test/social-ui.mjs (new, SOCIAL_UI_PORT 9520: the tile, the
  /friends view, search, requests, the in-game card, the merged profile card's friend row, guest and no-username gates, screenshots
  test/ui-shots/social-*.png); accounts-unit (table list), leaderboard, lb-profile-ui, rksignin, auth, seo pass. profile-ui times out on
  origin/main too (pre-existing).
- Decisions made without the owner: one card (the peer's), not two; /api/player is asked only by a viewer who can have friends (its rel and st are
  for them), although the endpoint itself stays public; place pills from /api/player on the card (one short line, the numbers only); a hidden
  stranger's card shows no rank at all rather than "Not ranked yet"; "Stats show for players on the global leaderboard" instead of an error when
  only the board says 404; the friend row lives on the card, not in a second modal; hidden accounts are searchable; Duel waits for slice B.

## 147. No feature-announcement notices: the "New: add friends and see who's online" toast is gone, and a rule keeps them out
- The owner's ask: remove the one-time Friends toast ("New: add friends and see who's online", profile.js frNotice, NOTES
  146) and make sure no session adds that kind of notice again. frNotice and its calls are removed; the `poddle.friendsSeen`
  key it set is deleted at load (like poddle.stats.on, NOTES 116), and its row is gone from the privacy page's storage table
  (Privacy 5), CLAUDE.md's storage line and docs/ropa.md. The page was already dated September 29, 2026.
- The rule, in CLAUDE.md "No announcement notices": no "New: ..." toasts, what's-new popups, one-time hints, NEW badges or
  dots, banners or modals announcing a feature or change. The changelog (footer "What's new") lists changes. docs/SOCIAL.md
  no longer plans "a home notice" for the next Friends slice.
- Kept, decided without asking: the two one-time LEADERBOARD toasts (profile.js lbNotice: "Your username can now appear on
  the global leaderboard ..." and the profile-card one, NOTES 126 / 140). They are the privacy notice the privacy page
  promises for an important change to how data is shown ("we will also post a notice"), not an announcement; the rule
  names them as its only kind of exception, and says to ask the owner before adding another. Toasts answering something
  the player did (a friend request arrived, copied, errors) are not announcements and stay.
- Tests: test/social-ui.mjs A now checks that no announcement toast shows on the home screen and no poddle.friendsSeen key
  is left.

## 148. A small pink bow on the corner of the username Mae, everywhere it shows
- The owner's ask: a small pink bow on the top right corner of the "e" of the registered username Mae, only for that
  username, everywhere, games included. ui.js regBadge (the one hook every name display already calls for the developer's
  hammer: in-game scoreboard, result/tally card, VS card, court list, tournament chips and bracket, leaderboard rows, the
  profile card, friends lists, the account row) now also puts a `.name-bow` INSIDE the name element, after its text, for
  BOW_NAMES = { mae }, and marks the name `.has-bow` (overflow visible, so an ellipsis box never clips it). Inside rather
  than beside (the hammer's way) so it sits on the last letter in every layout, including the VS card where a sibling
  would drop under the name. The svg has no text, so textContent (the name, which regBadge and callers read) is unchanged;
  aria-hidden, no tooltip. Pink #ff6f9f with a darker #c93f74 edge so it reads on white cards and the dark VS card alike.
- Decided without asking: only a REGISTERED Mae (a guest typing Mae gets nothing, as with the hammer). A player's own
  scoreboard side reads "You", which never carries a mark, so Mae sees her bow on her name everywhere except there.
  TEMPORARY like her bunny (NOTES 144): remove 'mae' from BOW_NAMES to take it away. No legal change (derived from the
  public username on the client).
- Checked in renders (scoreboard both sides and beside a rank emblem, VS card, leaderboard row, profile card) and in
  test/profile-ui.mjs (bow inside the name, text unchanged, no hammer; a guest Mae gets none).
## 149. A phone gets its own home: the paddle code, Watch a match, Your stats, Leaderboard, Friends
- "can you build a poddle mobile version, where, you are greeted with only the essential things like courts button to watch, view your stats,
  leaderboards, etc. since playing is not possible but only as a racket (so maybe have like a code enter area instead of a play button)."
- Before: a phone that opened poddleball.com got the computer's game: the title's Play, then Quick play, Ranked and Play a bot. Each of those took
  a seat, and a phone can't use one, because it can't be the screen and the paddle at the same time.
- A phone is `MOBILE` in web/main.js: a coarse pointer, under 600 px on its short side (`window.screen`, either way up), and the lobby. `?mobile=1` or
  `?mobile=0` forces it either way (tests; nothing is stored). ui.setMobile puts `data-mobile` on <html>. A tablet stays the full game, because it can be the
  screen with a phone as its paddle, and so does a phone with a short side of 600 px or more (a foldable, unfolded).
- The phone skips the title for the lobby's home, which becomes the phone home. The header says Poddle, there's no Back and no name row (Esc and Back
  at home stay home). At the top is the **Be the paddle** card: P- and a box for the 4 characters, using pad.js's rules (upper-cased; I, O, 0 and 1
  dropped; a pasted "P-ABCD" or a stray leading P works). Go opens `/pad.html?k=CODE` on its Start screen: the tap there is what iOS needs to ask for
  motion, and pad.html already says when a code is wrong. Under the card, **On this phone**: Watch a match (the Courts tile), Your stats, Leaderboard and
  Friends, each shown where it was before (stats and the leaderboard where the server keeps stats, Friends where sign-in is on). Quick play, Ranked and
  Play a bot are `.desk-only`. `tilesFit` skips them, so `data-n` counts only what shows. The layout is 2 across, with Watch a match taking the whole row
  when the count is odd. On its side: the card on the left, the tiles on the right, with no Esc or F key hints.
- A phone never takes a seat. It's enforced in one place, `request()`: quick, create, join, rk, rkwarm and tcreate are refused with "Play on a computer.
  This phone can be its paddle.", so a hidden button pressed some other way still seats nobody. On top of that:
  - Courts has no Join, Create court or Create tournament, and Watch sits alone under the code boxes. Enter in the boxes watches (`join` becomes `watch`).
  - Court rows: a waiting player, a player against Matt ("Ask to play" before) and a tournament all say Watch and watch on a tap. An empty court has
    nothing to see and is left out. The empty list offers no Create court.
  - A `?court=` join link opens as a spectator: `play()` sets wantWatch. A tournament code watches, which opens its bracket or sign-up screen as a viewer,
    where Warm up and Start are hidden.
  - A spectator gets no Ask to play (`askSync`, `askPlay`). The in-court settings card has no Paddle or Match group, no AirPod or Camera light, and no
    speaker picker.
  - The Ranked view's Play Ranked and Warm up are hidden, and the handler returns before its search bar shows.
- Edge cases, and the decisions made without asking:
  - Guest or signed in: the same home. A phone's guest stats belong to the phone's own device id (poddle.device), not the computer's, so a guest sees
    empty stats there. Signing in (Your stats) shows the account's. Nothing merges on its own.
  - No name yet: the phone home asks for none, and `nameGate` leaves `needs-name` off there, so nothing is dimmed at half opacity with no name row to
    say why. Watch a match opens Courts, whose name row asks at the first Watch and dims the rows until then, as before. A username replaces it.
  - Reload: /courts, /stats and /leaderboard come back to their view. / and /play come back to the phone home. Leaving a watched court lands on the phone home.
  - Friends invites (slice B, being built in another session): docs/SOCIAL.md 10 now says an invite to play or duel that is accepted on a phone must
    become a watch, or say "Play on a computer", because the gate would refuse its join.
  - No announcement toast (NOTES 147). The changelog has an entry.
- Found on the way: `PHONE_SIZED` read `screen.width`, which in main.js is its own `screen()` function (the menu switcher), so it was false everywhere
  and the title's "this phone becomes your paddle" note never showed. It now reads `window.screen`. The note only shows on a phone with `?mobile=0` now.
- Legal: nothing changed. No new data is sent or stored, no new storage key, no new permission (pad.html asks for motion as before), nothing new
  is shown to others, and no third party. Privacy and Terms stay as they are.
- test/mobile-ui.mjs (MOBILE_UI_PORT, default 9880; fake game + fake /api), 26 checks: the phone home and its tiles; Back and Esc; hidden seat buttons
  pressed by script send nothing and say why; Courts rows, the code boxes and a ?court= link send watch and never join; no name; the paddle code (Go
  lands on pad.html's Start with P-CODE); landscape; and an iPad, a desktop and ?mobile=0 keep the title and the full lobby. Screenshots:
  test/ui-shots/mobile-home.png, mobile-courts.png, mobile-land.png.

## 150. One card, opened whole; the Getting ready panel fits; Friends | Quick play | Ranked; Add friend moves; places on the name line
- The owner: "I'm seeing the normal stats card appear, but then the friend card pops up after ... delete the shittier, less full
  stats card". There was only one card (#lbp-card), but it opened at once on its loading face (dashes for all eleven stats, no
  places, no Matt level, no friend row) and ~400 ms later grew 85 px into the full card with the friend row, which read as a second,
  lesser card. profile.js openPlayer now waits: the pressed name breathes (.is-opening, aria-busy) and the card opens once, loaded
  (8 s cap: its error face). Esc while it waits cancels it (and is not the lobby's Back); another name, a closed view or another
  card open drops it. openCard(id, back, from) keeps the pressed element for Close's focus. Try again inside an open card still
  shows the loading face. test/lb-profile-ui.mjs checks no card while loading, then a loaded card, and the Esc race. CLAUDE.md
  gets "One card per thing, and it opens whole" so no session builds a second card for the same thing or opens a card half-drawn.
- The Getting ready (connect) panel was taller than its body at 1440x900, 1280x720 and small phones and slid under the header and
  footer: shorter status rows there, a smaller QR under 960 px tall, tighter body padding, and the body scrolls from the top
  (safe center) if it still does not fit. Measured with the phone-pairing variant (?padtest=1) at 1920x1080 down to 375x667.
- Home: the three big tiles read Friends | Quick play | Ranked (the owner's order; Friends moved first in the markup, so Tab follows
  it); on a phone, where the tiles stack, Quick play stays on top (order:-1 at <=480 px).
- Add friend (the Friends list's and the profile card's): a person-plus icon that waves every few seconds, a shine across the pill,
  a lift and a spinning + on hover, a squash on press, and the Requested line that replaces it pops in. Reduced motion: none of it.
- The profile card's leaderboard places (#12 Trophies, #3 Longest rally) sit on the name's line beside the hammer, not in a row of
  their own between the rank and the stats.

## 151. A Sign in button in the menu header
- The owner: "add a sign in button on the main menu area ... in the header, as you'd normally see in any other game website".
  The lobby header's right end (.head-end: the online count, then #btn-head-acct) shows, wherever accounts exist (sign-in AND
  the database, the same gate as the Friends tile): "Sign in" for a guest (opens the sign-in card, like Your stats' button),
  "Pick a username" when signed in without one (the username card), or my username with a person icon when signed in (opens
  Your stats). profile.js drawAcct keeps it in step with every sign-in / sign-out / rename. On a phone (<= 480 px) it is a round
  icon (its name in the aria-label and tooltip) and the online count gives way; the title keeps its room at 360 px.
- Nothing new is sent or stored: it calls the same signIn / claimCard / Your stats as the existing buttons (no legal change).

## 152. The Friends tile's icon plays, like the other home tiles
- "add the friend button css animation". Every home tile's icon plays on hover (looping) and on keyboard or pad focus (once): Quick play's arrow, Courts'
  magnifier, the bot's head, the stats bars, the trophy, the podium. The Friends tile was the only one that stood still.
- Now the two friends hop hello: the front friend first, the one behind 160 ms later, each from their own feet (`ic-greet`). Then the plus pops with a
  quarter turn (`ic-add`; a plus turned 90 degrees looks the same, so the jump back at the start of each loop can't be seen). 1.7 s, the same easing as the
  others. It goes where the other tiles' rules are in web/ui.css, so the rules they already have apply: a dimmed tile (no name yet, server down) stays still,
  and reduced motion cuts it to one frame.
- Checked in headless Chrome at 1280x720: while hovered, all four parts of the two friends run `ic-greet` and the plus runs `ic-add`, and the captured frames show the hop and the pop.
  CSS only; nothing for the legal pages.

## 153. Two people on one network: their matches count (R5 retired); one browser is still one person
- "i noticed that matches dont count if u and someone is on the same network. fix that, it's fine, just as long as its not same browser"
- Before: R5 `same_computer` (server/abuse.js judge) unranked any human match whose two seats' computer groups met. A computer key is the public IPv4,
  or the IPv6 /64, and a home router gives the whole house one. So a household, a school lab or an office never had a counted match against each
  other, and the Ranked matchmaker (game.js rkSame) never even paired them. This was docs/ACCOUNTS.md's "accepted false positive" (Q4); the owner has now
  answered Q4.
- Now R5 is gone: the `same_computer` flag is no longer raised (it is off MATCH_WIDE; old match_log rows may still carry it). One browser is still one
  person, through the rules that were already there: `same_device` (the browser's poddle.device id, shared by every tab and window of one browser
  profile), `same_cid` (one tab, including a tab that reconnected through a VPN) and `same_account` (one account or one owner). All three still unrank,
  and the card still says "self".
- The other places that treated "one network" as "one person" follow:
  - rkSame (Ranked matchmaker): two entries on one network may be paired. One device, account or owner still never pairs.
  - titleCounts (R16, a tournament title needs 3+ people): people are counted by device and account, not network. A tournament among three people in
    one house can give a title.
  - The link map's per-network caps: `pair()` (R10 cpuPair24h, also rkFriendly) returns 0 for two keys in ONE group, and `loser()` (R11 cpuLoser24h)
    skips losses to a winner on the same network. Without that, every match in a house would count toward one shared cap of 3 a day, and a sibling who
    keeps losing to another would soon look like a feeder. The owner-keyed R10 (3 counted series a day per pair of players, then a Ranked friendly),
    R11, R11b, R11c and R12 still apply to them. Across two networks, the computer-keyed rules work as before.
  - Removed as dead: the `STATS_SAME_IP` knob (`config().sameIp`) and `loopKey`, which only existed to switch R5 off for loopback e2e runs (ranked-e2e
    no longer sets it).
- Where "not the same browser" cannot be enforced (told to the owner): the server knows a browser only by its device id, its tab ids and its account.
  These all count as two people now:
  - two different browsers on one computer (Chrome and Safari);
  - a private window of the same browser (its own storage, so a new device id and a new guest);
  - a tab that stays seated while another tab of that browser signs out (sign-out rotates poddle.device, and the two tabs never shared a cid).
  Casual farming by one person this way is bounded only by NEW_GUEST_DAY (30 new guests per network a day, 5.5) and R12 (30 counted wins a day per winner).
  The owner pair caps don't bite, because every private window is a new owner, and R11c is off in production. It can feed the win rate and the
  "best win streak vs people" board. Ranked is safer: each seat needs a signed-in account with a username, so it takes two Google accounts, and R10 by
  owners makes a pair's 4th series of the day a friendly.
- Legal: Terms' fair-play line now says matches where both players share the same browser or account may not count (before: "the same network or the
  same browser"). In the Privacy IP-address row, the Ranked "avoid pairing ... the same computer or network" is gone. The match-end address comparison is
  now said to be for the daily limits on repeated matches between networks, with a sentence that two players on one network count. No new data, no new
  storage. The dates were already September 29, 2026. No home-page notice: this relaxes a rule and hands over no new data (NOTES 147 rule). Changelog
  entry added. docs/ACCOUNTS.md (R5 row, the false-positive note, the knob table), docs/RANKED.md (never-paired row) and CLAUDE.md's data flows are updated.
- Tests: accounts-unit covers one network ranked (production config too), one network plus one device id unranked as same_device, one network plus one
  tab unranked as same_cid, a title with two members on one network, and pair()/loser() skipping one network while still counting across two.
  stats.test 5 and 18 now expect ranked. ranked.test 7: two people on one address are paired (not as a friendly), play a series, and it counts (+33
  trophies, no reasons). One device id on two computers still never pairs.
  All pass solo: accounts-unit, stats, ranked, ladder, seo.

## 154. A re-aim bends the ball smoothly onto the flight it always had; the screen no longer stalls on a correction; the ball lands on its marker
- "The mechanics for the swings are messed up. They get recalculated post hit, causing the ball to swerve like every time. That millisecond of changed
  trajectory makes the game feel janky and inconsistent. Find a way to preserve game mechanics while cleaning up ball trajectories and calculations."
- Measured first (3 real captures x 300 s through the real web/motion.js into the real server, 235 of my hits): every one is struck on its bet (66) and
  the settled report re-aims 87% of them ~100 ms later (p90 133, max 250), moving the landing p50 0.57, p90 2.28, max 4.09 m (63). That rule stays. What
  made it read as a swerve was how the move was flown and drawn:
  - Server: easeAim() moved vx / vz in equal shares over 0.1-0.45 s, re-aiming every tick. The pull switched on in ONE tick (the first tick after the
    re-aim: p50 1.6, p90 7.1, max 13.7 m/s^2), grew ~2x (per hit p50 1.9x, p90 4x) and cut to nothing; its biggest one-tick change p50 3.4, p90 11.2, max 23.8 m/s^2. A settled
    hard swing's swoop switched a steady pull on mid-flight, another step.
  - Screen: the re-aim's `launch` carried the server's CURRENT p v t (nothing jumped), yet set blend. drawBall() measured the correction from where the
    ball was drawn LAST frame against the truth NOW, so a frame of real travel counted as error and was eased out on a smoothstep: the ball stood still
    for a frame (0.09x its speed, 0.17-0.27 m behind), then surged 1.3-1.4x for 5-10 frames. Drawn peak 775-995 m/s^2 against 72-117 for the same hit
    without the re-aim. The same freeze on EVERY hit at contact and whenever the height arc ended (131 of 235 in mid-air). The marker teleported and
    popped again on every re-aim, even when it barely moved. coast() knew nothing of the ease, so the drawn ball learned the bend packet by packet.
  - The sim stepped y v-then-p, so the server's ball ran g dt t / 2 under the closed form solve(), fallLeft() and coast() all use (0.14 m by a lob's
    bounce), and it found the floor up to a tick late, up to 0.25 m past the marker.
- Now (server/game.js):
  - reaim(): the move is one bend (`bent()`, `ball.bend`): the new velocity comes in on a smoothstep over the old ease's own window (BEND: half the hang
    the ball has left, 0.1-0.45 s, whole ticks), then the ball flies straight on. Its pull is 0 at the re-aim (it fades in, no step) and 0 again when
    the window ends; the ball lands exactly on the marker, and reaches it with the heading and pace the ease gave it. easeAim, `ball.aim`, FIX_EASE,
    FIX_SHARE and FIX_EASE_MAX are gone.
  - Tried first and dropped: one bend over the whole hang (d phi(tau), phi = 2 tau^3 - tau^4), the gentlest pull there is. A pull that fades in over the
    whole hang has to end harder: the ball reached the bounce with 2 d / T of extra velocity where the ease gave ~1.33 d / T, so it came off the bounce
    somewhere else. Replaying the captured hits through both servers (below), same marker: the receiver's meeting point moved p90 0.43, max 0.91 m; 37
    re-aims asked the receiver to go wider than REACH against 27; Matt returned 57 more of 2360 at Club and 67 fewer at Tour. Where the receiver has to go
    on 87% of human shots is a mechanic, so the window is the ease's. With it: meeting point p90 0.02, max 0.05 m off main's; heading off the bounce p90
    0.2 deg off; 27 wider than REACH, as on main; Matt's returns identical at Rookie (448), Club (1217) and Pro (2305), 1846 against 1838 at Tour. The
    cost: the pull peaks where the ease's did (real hits p50 / p90 / max 3.4 / 11.7 / 23.6 m/s^2, ease 2.9 / 11.0 / 22.7; the whole hang 2.5 / 10.1 /
    19.7). What is gone is the step: the biggest change in one tick is 0.50 / 1.92 / 3.63 m/s^2 (ease 2.9 / 11.0 / 22.7).
  - The swoop (a settled full-power drive, NOTES 72) keeps its landing rule exactly (cReq against cMin the hook way, |x| <= 2.5). Its sideways part is bent
    in over the whole hang left, as its steady pull ran (and it ends at 2 d / T, as that pull did), but fading in: a pull switched on mid-flight was a
    step. Along it takes the window like any re-aim. `ball.curl` stays what the ball was struck with (0 for a bet); a ball struck curling keeps its curl.
  - A second re-aim of one ball (a legacy client with no `final`, or fixBlock twice) adds its own bend and the first one's pull runs on. Replacing it
    dropped that pull to nothing in one tick (the ease did the same: ~21 m/s^2 to 0.7 in a legacy client's two fixes 7 ticks apart).
  - The net: the crossing is found on the bent flight itself (halving) and the sealed height there must clear; a landing the sealed ball cannot reach
    over the net is walked deeper 0.1 m at a time to 6.2 m as before, none: it flies as struck. The ease's check took the crossing at the average pace
    (and the as-struck pace had to clear too), too slow for a ball slowing onto a shorter landing, so it walked on further than it had to. So some
    landings change, all nearer the settled aim: 33 of 208 re-aims of the real captures land 0.10-0.40 m shorter (p50 0.20); 484 of 5549 sampled
    re-aims; 12 sampled late re-aims the ease gave up on (its walk ran out) now fly, and 7 of 6000 sampled shots end as another kind (such a late
    re-aim can be announced, a smash included). Every one clears net + clear (lowest margin 0.000 m, on the real and the sampled hits).
  - FIX_ALONG 0.1, a guard: a re-aim never stops the ball or turns it back along the court (`alongFloor()`: the landing moves deeper to where it keeps
    exactly 0.1 of its pace, the marker with it), so z runs one way and the net has one crossing. It fired on 0 of 208 real re-aims, 0 of 5549 sampled,
    0 of 1164 sampled late near-net pushes; the slowest kept 0.64 / 0.14 / 0.14 of its pace (the ease 0.63 / 0.13 / 0.11). A floor of 0.3 (tried with
    the whole-hang bend) fired on 13% of near-net pushes and landed a settled soft push up to 1.7 m deeper than its push curve (push.test's bet 33 ->
    settled 8: 1.91 -> 2.93 m); now 1.91, as on main.
  - flight(): every step of the sim is the closed form (y too: + g h^2 / 2), and a tick that reaches the floor stops the ball ON the landing, bounces it
    there and flies the rest of the tick up (`ball.rest`). The server's ball is now exactly what solve(), fallLeft() and coast() compute. solve()'s REACH
    margin for the old late tick is kept.
  - planFootwork(side, tb) flies the same flight(), the bends and the exact bounce included, from the time the ball's p v are at: the receiver and Matt
    go where the ball really goes. The receiver is planned again when the bend's window ends, as the ease's end did (every plan restarts Matt's reaction
    clock, so Matt is no quicker on a re-aimed human shot than he was); sim() plans before its step, where the ball is still a tick back (flown a tick
    ahead, the whole-hang bend's replan was up to 0.13 m off on the real hits). The last plan against where the ball is really met: max 0.04 m (main 0.03, 120 Hz steps).
  - The wire: `launch` and `state` carry the bends while one is still bending the ball before the bounce, `w: [vx, vz, W, t0, ...]` (four numbers a
    bend, t0 in the packets' own t). The hit never carries one: a bend starts at a re-aim. An old tab ignores it and learns the bend from the state
    packets, as it did the ease; until it reloads it also keeps the old re-aim freeze and marker pop, and its height arc (anchored for the old
    v-then-p sim) sits up to 0.14 m under a lob near the bounce until the arc's end corrects it. Cosmetic, and gone on reload.
  - At most BEND.most (6) bends at once: a client flooding settled reports (MSG_DROP lets through ~50 in a FIX_WINDOW) piled up one or two a report,
    18-75 of them (12x the state packet, ~10x the CPU for that hit); past 6 a re-aim is refused and the ball flies as it is aimed. A legacy
    client's few fixes never get near it.
- Client (web/scene.js):
  - `ballTake()` / `ballState()` (exported) are what a message does to the ball record; onEvent / updateBall call them, and so do test/drawlob.mjs,
    test/bend.test.mjs and the swerve harness, so no hand copy can drift.
  - A re-aim `launch` takes p v t and w as they stand: no blend.
  - drawBall(): a correction is measured from where the drawn ball would be THIS frame had it flown on as the truth did, and the smoothstep that takes it
    out starts flat, so the drawn ball moves as the truth moves on that very frame. The truth a frame ago:
    - a hit that brought its flight: the truth turned at the hit's OWN time (`b.turn`), even when the next tick came in the same frame (a TCP burst; at
      30 fps every other hit). Taken from the newest record, it flew on the old way through the whole frame, 0.10-0.35 m on toward the hitter, then
      surged 1.4-1.6x; now 0.000 m.
    - anything else: the record's own flight, coasted on when it is older than a frame, else run back along it, at the velocity it had before a bounce
      it has not reached, and back to the floor it just came off and then at last frame's velocity (the one it came down at). Run back at the
      velocity from past the bounce, the ball was drawn rising before the floor on the frame the arc ended (up to 0.17 m above the server's ball, p50
      0.06); now 0.003 m at most.
    - an old server's hit (no flight on it): last frame's velocity until the news, as before.
    - a link silent past COAST_MAX: measured from the unclamped age, the truth did not move and the ball no longer lurches 11 cm on when the arc ends.
  - coast() / coastTo() fly the bends (the share of W gone read off the packet's own server t, so no other clock), and with the server's exact steps
    coast() IS the server's ball, bounce included. The height arc anchors on the truth's own vy (the SIM_DT offset is gone).
  - The landing marker glides 0.2 s (eased) to a re-aim's new landing, no second pop; a fresh shot's landing still pops.
- Measured after, live, this change alone (before 155; the same 3 captures x 300 s, the same analysis on main's client for before; different
  rallies, so landings are "the same rule"): p50 / p90 / max over the re-aimed hits.
  - Server: first tick after the re-aim 1.6 / 7.1 / 13.7 -> 0.26 / 1.05 / 2.06 m/s^2; biggest one-tick change 3.4 / 11.2 / 23.8 -> 0.50 / 1.98 / 3.88;
    peak 3.5 / 12.6 / 23.8 -> 3.4 / 12.0 / 25.4; heading change 1.8 / 14.4 / 41.2 -> 1.8 / 15.7 / 40.0 deg; landing moved 0.57 / 2.28 / 4.09 -> 0.59 /
    2.33 / 4.17 m.
  - Drawn (40 ms, 60 fps): peak accel 775 / 893 / 995 -> 3.4 / 11.9 / 25.3 m/s^2, the server ball's own; the same hit without a re-aim 72.5 -> 0.0. The
    re-aim frame 0.09x -> 1.00x its speed (the catch-up 1.28 / 1.43 max -> 1.00 / 1.20); contact 0.09x -> 1.00x; the arc's end 0.09x -> 0.92x p50 (the
    bounce's own 0.78 along is in it). 120 fps: 1446 / 1953 -> 3.4 / 25.3 m/s^2, freeze 0.03x -> 1.00x. 30 fps: 336 / 503 -> 3.4 / 25.0, freeze 0.26x ->
    1.00x. 80+60 ms jitter: 832 / 1498 -> 223 / 286, the same as the hit drawn without its re-aim (the jitter's own).
  - coast() against the server's own steps: worst 13.4 cm -> 0.0 cm over 0.6 s (test/coast.test.mjs, now held to 1 cm). The marker against where the
    ball really bounces: worst 0.15 -> 0.00 m live (p90 0.11; 469 hits on main, 731 after; 0.13 in helium.test). Lobs top out where solve() designed them: drawn apex 4.07 -> 4.16 m.
- Measured the same input on both servers (the review's replay, kept for the next one): each captured hit (contact point, bet, every later report at its
  own tick) and 6000 sampled bet -> settled pairs run through the real createRoom() of main with only the exact flight added, of the whole-hang bend,
  and of this; Matt receiving at each level with 10 seeds. The figures above come from it.
- Kept: the re-aim's triggers (only the settled report, once; FIX_WINDOW, PUSH.fix / gate, the late push, fixBlock, the serve's settled swing, legacy
  no-final clients), the sealed height (vy never rises after the paddle: helium, drawlob), the kick rescale, the kind / n announcements (the late
  smash ignites the trail, no second impact), stats.fixRecords, the swoop's landing rule, the push curve's landings, Matt's timing. Bots are never
  bets and never re-aimed. No data flow changed: nothing for the legal pages. No notice; a changelog line.
- Tests: new test/bend.test.mjs. In process: sim()'s own flight() + bent() stay on the closed form and land on the marker; the pull starts from nothing
  and changes by at most its own slope a tick; coast() flies the bend to 0.00 mm; two bends at once never step and land on the second marker;
  alongFloor() keeps exactly 0.1 of the pace and leaves a reachable landing alone. Live: every kind of re-aim (a legacy client's two included) fades in
  and never steps, lands on its marker, never stops along the court, coast() from the re-aim packet alone follows it to the bounce, and the real
  drawBall() (60 / 120 / 30 fps, the hit's tick held back into the next one's frame too) draws the re-aim frame and the arc's end at 0.6-1.6x the server
  ball's own step, the contact frame at 0.6x or more (a late contact's slide, or a hit that came in late, may add speed after) and never on past the
  server's ball toward the hitter. Against main's server it fails the fade-in, the step, the marker (0.02-0.12 m off) and the prediction (2.38 m).
  test/drawlob.mjs replays through the exported ballTake / ballState. The sim copies in coast, curve, badwifi and server.test fly sim()'s own flight();
  coast.test's tolerance goes from 25 cm to 1 cm. curve.test: the swoop is the re-aim's bend, measured as how far its bends carry the ball sideways by
  the bounce (at least 0.3 m; 1.7-1.9 m here), the near-net swoop now needs a 0.3 m bow too (it had no bow check), and a ball lands within 3 cm of its
  marker (was 0.12 / 0.3 m, for the old late tick). helium.test: the marker within 2 cm (was 0.15); a hard bet settled as a tap still lands deeper than
  3.5 m (4.14; main walked on to 4.91), and now crosses within 1 cm of net + clear, which pins the exact crossing (the average-pace check gave 1.8
  cm). lagcomp's line says bent, not eased. A swoop switched off, or the net crossing taken at the average pace, now fails curve.test / helium.test.
  Pass: coast, badwifi, lobbet, curve, helium, drawlob, bet, bend, lagcomp, feel, push, kitchen, deep, slice, serve, real; reaim and latesmash measure
  (bent once, 0 twice; the late smash still ignites 98-121 ms on). Also pass: bot, countdown, watcher, joinreq, stats, ranked, rooms, ladder, records,
  seo, kinds, strokes, emote, revive, spin, smooth. server.test (54 failures, main 49 on the same run): the same teleport and scoring failures; new,
  its scripted 'high' whiff (a dink, paddle at 0.3 m) is met by the receiver's exact footwork at dy 1.00, inside the server's reach box (0.95 + 0.5 n)
  but outside the test's own ZONE-only check, where on main that case ended with no point at all. Browser, with a local headless Chromium:
  test/hitblend.mjs turns the ball on the frame the hit arrives (drawn z 1.35 -> 1.30 -> 0.94; an old server's hit without v now keeps flying at last frame's velocity on the event frame, where it stood still,
  largest step unchanged at 0.27 m); its
  sliced-trail check fails here on main's client too. test/scene-next.mjs timed out here waiting for its page (not run).

## 155. The bet aims on its own: a first report no longer carries the wind-up's direction
- The other half of "the ball swerves after the hit" (154). The bend is now smooth, but its size is the gap between the bet and the settled report,
  and the widest ones were sideways: 63 of 205 re-aims in 154's captures turned the ball more than 0.1 of dir: heading p50 4.6, p90 30 deg, up to 4.0 m across.
- Cause (web/motion.js): the bet read its aim off sw.sum, the settled report's rate-weighted turn, which is seeded with the two samples before the
  trigger. When the stroke loops out of a wind-up (the `mvR` start) the seed and the first samples still turn the wind-up's way: bets of 0.34, 0.45
  and 0.77 settled at -0.96. 22 of 89 scored real bets fire within 50 ms of the movement's start (sensor clock).
- Now the bet computes its own aim: the turn since the trigger (no seed), measured from the wind-up's own angular velocity when the hand was already
  moving (`wB`, the same "wound" test that picks mvR), plus BET_AHEAD (2) samples of where it is heading (this sample carried on by its last change).
  Only the bet's `dir` changes. sw.sum, sw.dir and every later report are untouched: over 3527 swings (the 3 real captures, AirPod and phone gain,
  lobsynth x 12 seeds, strokes.mjs-style strokes) every settled report is bit-identical, every in-between fix and swingEnd too, and every bet fires on
  the same sample. Power, lob, roll and spin of the bet are unchanged, so a bet still never smashes and a flick stays soft.
- Measured, |bet dir - settled dir| on the real captures (132 bets): p90 0.26 -> 0.14, mean 0.13 -> 0.07, worst 1.71 -> 1.11, off by more than 0.3:
  12 -> 6. Leave one capture out (fitted on two, tested on the third), the same setting sits on a flat optimum (held-out means 0.089 -> 0.055, 0.199 ->
  0.102, 0.153 -> 0.099). Gyro noise up to 0.3 rad/s keeps the gain (p90 0.25 -> 0.17). lobsynth strokes: p90 0.22 -> 0.14 (AirPod), 0.23 -> 0.15 (phone).
- End to end (the real motion.js into the real server and the real client, 3 captures x 300 s; before, main and 154 alone: 5 runs; after, this tree: 3 runs, 634 re-aims):
  sideways landing move p90 1.19-1.43 -> 0.93 m (0.81-0.97 a run); heading change p90 11.4-16.1 -> 7.1 deg; landing moved p90 2.28 -> 1.69 m. The
  worst move a bet's direction causes 4.1 -> 2.7 m (a settled full-power swoop can still move a landing 3.4 m, as on main, 41 -> 33 deg). With 154
  as well: the pull's first tick 1.7 / 7.1 / 13.7 -> 0.27 / 0.85 / 1.43 m/s^2, its biggest one-tick change 3.5 / 11.2 / 24.4 -> 0.50 / 1.59 / 2.69,
  its peak 3.6 / 12.5 / 24.4 -> 3.1 / 10.5 / 19.4, the drawn ball's 761 / 895 / 995 -> 3.0 / 10.5 / 19.3; the marker 0.00 m from the bounce. How often a hit is re-aimed does not change (87%): power still decides that, and no bet-only power
  estimator beat the current one on a held-out capture (look-ahead scaling, blends with the earned power, shrinking to a prior, time-to-peak): 63's
  "there is no conservative bet" still holds, so power is left alone.
- Limits: 132 real bets from one player; the worst reversal bets are about six swings. Some are still far off (a reversal that has not started by the
  bet sample cannot be seen), and 38 of 132 real bets get a little worse, 2 by more than 0.1 (at most 0.15), none newly past 0.3. Tuned on the
  50 Hz AirPod captures: resampled to 60 Hz (a phone on iOS) the mean goes 0.156 -> 0.090, to 100 Hz 0.160 -> 0.116 (upsampled data is smoother
  than a real stream; BET_AHEAD counts samples, not time). An in-between fix ~60 ms after the bet still carries sw.dir to a swing that has not
  met the ball yet (worse in 3 of 59 real cases, better in 19). A serve struck on its first report uses the new aim; the serve's decisions read the
  settled dir, as before.
- Tests: lobbet, lobsynth, spin, strokes, kinds, effort, onset, bigswing, zigzag, zigzag-power, smooth, rom, padmotion, phone-jitter and real.mjs
  print the same as before (real.mjs "dir within 0.3": FLICK 26 -> 27 of 27, FAST 10 -> 13 of 17 on live-play-1).
## 156. Your own name on the left instead of "You"
- The owner's ask: the scoreboard's left slot read "You"; it now shows the player's own name, since the left is always
  yours. main.js meName(): the server's name for your seat (what everyone else reads: your username if signed in with
  one, else your typed name), before a seat your username, then your typed name, and "You" only if there is none at all.
  meReg(): whether that is a registered username, so the developer's hammer and Mae's bow (NOTES 148) now show on your own
  name too (they never did on "You"). The rank emblem beside it is unchanged.
- Same change everywhere "You" stood for the player's name: the in-game scoreboard, the result card's tally, the Ranked
  game card, and the Match found / tournament VS cards (ui.js vsMe). Kept, decided without asking: headlines that talk to
  the player ("You win", "You lose"), the leaderboard's "You" card, and the tournament list's "You" tag beside your name.
  A spectator's scoreboard already showed both names.
- Tests: menu.mjs and spectate-e2e.mjs expect the player's name where they expected "You" (spectate-e2e: "Play a bot" and "names on the scoreboards" pass). menu.mjs Part B crashes on
  main before this change too (a ui stub gap from a later peer commit), so it could not confirm this; spectate-e2e did.

## 157. Ranked mode removed; trophies in every counted game (docs/TROPHIES.md)
- The owner (2026-09-30): "get rid of the ranked mode. i think it's pointless; we can keep the ranked medals as like trophy tiers / ranges,
  like in brawlstars, just for fun and achievements, but the main mode should just be a ladder mode where you just get trophies and such.
  so no more ranked mode, as that'll just confuse things ... the ranked gamemode itself should be removed and folded in to normal stream
  of games to make things simpler." docs/TROPHIES.md is the spec; docs/RANKED.md and docs/RANK8.md carry superseded banners.
- What changed. The MODE is gone: the Ranked tile and view, the queue (and the two-per-network queue cap), the Matt warm-up, the best-of-3
  series and its VS / game / series cards, the stadium venue (scene.js VENUE.stadium, scenery/stadium.js, venue-shots), the `rk*` wire
  messages, `/status.json.rk`, the presence strings `queue` and `ranked`, the pad FX `found`/`game`/`series`, `RK_*` env knobs (`MATT_DAY`
  replaces `RK_MATT_DAY`), test/ranked.test.mjs, test/ranked-e2e.mjs and test/rksignin.test.mjs. `/ranked` 301s to `/ranks`. The ladder
  STAYS: server/ladder.js untouched (eight ranks, three divisions below Pro, floors, humanDelta, mattDelta, the 899 Matt ceiling), the
  `ladder` table and `ladderApply` (`series_id` always null now; `delta_a` / `delta_b` on the game's own match_log row), the emblems, the
  Ranks page, the trophies board, the share card and the profile card's rank + trophies. Vocabulary: `ranked` in match_log / abuse / stats /
  the `profile` message still means "counted toward stats"; the trophies are "trophies", the rank index is "tier".
- How trophies are earned now: one hook in game.js `record()` after `stats.onEnd`, for every kind of game (bot, human, tour, tourbot) on every
  path that records, once per match. The result rides the seat's `profile` message as `trophies: { delta, trophies, tier, div, tierWas,
  divWas, floorHeld, counted, saved, why, matt, limit }` (or `{ none: 'signin' | 'username' }`); no new message type. The result card draws
  the same trophy row the series card drew. `stats.newMatch` mode is `'ladder'` when a seat was eligible at start, else `'casual'`.
- Decisions made without the owner (from the spec, to be confirmed):
  - Eligibility = signed in with a username (the owner's 2026-09-29 rule for Ranked, NOTES 133, carried over). A guest or a username-less
    account earns nothing; the result card says `Sign in to earn trophies` / `Pick a username to earn trophies` in the trophy row's place.
  - Per-game humanDelta: every counted game against a person moves trophies (about +30 / -20 at a gap of 0), from both seats' trophies
    frozen at match start; an ineligible or trophy-less opponent counts as the same rank. `new_opponent` halves the winner's gain.
  - Matt pays in every game (Quick play alone, Play a bot, a tournament's Matt filler): a played-out counted WIN pays `mattDelta` only at
    your rank's level or harder, through the day cap (`MATT_DAY`, default 40) and the 899 ceiling; the card names the limit that stopped a
    win from paying (`easy`, `day`, `ceiling`). A loss, a leave or a drop against Matt: 0.
  - The leaver rule: leaving a person game after the first strike costs the leaver the full loss whatever the verdict; the stayer takes the
    win only when the game's flags hold nothing beyond the forfeit's own (`early_forfeit`, `leaver_ahead`, `afk`, `too_fast`), else +0 with
    `left_early`. Before the first strike: void, no message.
  - Emblems on every court: `ranks()` / `seatTier` are set for every seat with a ladder row, so opponents and watchers see the rank emblem
    (tier and division only) on the scoreboard, result card, tournament VS card and bracket, in every kind of court.
  - The stadium is removed rather than kept as a look; the park is the only venue.
  - `/ranked` redirects to `/ranks` (old links and bookmarks).
  - Home tiles: Quick play (+ Friends) as heroes, then Courts, Play a bot, Your stats, Leaderboard; 5 tiles without the Friends tile, 6
    with it. The spec says "signed out: 5 tiles", but the Friends tile shows to guests too wherever sign-in is enabled (Sign in to add
    friends, NOTES 146), so on poddleball.com a guest sees 6 tiles and the 5-tile home appears only where sign-in is off (a local copy,
    the `?acctest` fixtures). Owner call: gate the Friends tile on an account (then guests need another way to the friends gate), or
    accept 6 for guests (the code as shipped; docs/ui-spec.md describes it so). Your stats is the one trophy view (crest, rank, place, trophies, bar to the next division, the eight-medal road, the keep
    line, Best when higher).
- Edge cases (docs/TROPHIES.md 3): guest vs guest (nothing); guest vs account (only the account moves, gap 0); an account without a username
  (`none: 'username'`); a sign-in mid-match (the identity frozen at hello decides; a sign-in after the first strike does not earn); a
  reload mid-match (`revived`: not counted, 0); a server restart mid-match (revive, same); two tabs of one person (`same_*`: not counted);
  a tournament's Matt filler games (Matt rules, day cap and ceiling apply); a phone paddle (no seat, nothing); watchers (see emblems only);
  the day cap and the ceiling on Matt; a deleted account mid-match (`saved: false`); the db off (`saved: false`, "Couldn't save trophies
  right now"); old clients after the deploy (`rk`, `rkleave`, `rkwarm`, `?rk=1` are ignored without a reply or a log line).
- Tests: test/trophies.test.mjs (new, server: two accounts +30 / -20 and the ladder rows and export, a guest `none: 'signin'`, a
  username-less account `none: 'username'`, a Matt win at the right level with the day cap and ceiling, an easy Matt win `limit: 'easy'`,
  the leaver rule both sides of the first strike, the emblem on a plain court, old-client `rk` ignored); stats.test §21 points at it;
  ladder.test unchanged; the client tests (menu, ui-next, profile-ui, lb-profile-ui, mobile-ui, social-ui, ui-mock, ui-shots) lose the Ranked
  assertions and gain the 5- and 6-tile home, the Your stats road and the result card trophy row; deploy.sh swaps ranked.test for
  trophies.test. seo.test.mjs checks the legal pages and sitemap below.
- Legal pages updated (same commit): privacy.html and terms.html now say trophies are earned in every counted match by signed-in players
  with a username; the rank emblem (tier and division only) is shown beside your name to your opponent and anyone watching any court you
  play on, on the scoreboard, result card, tournament match card and bracket; the ladder row lists its fields without a series or "while
  you wait"; the device id is created at the first seat; the two-per-network queue limit and the two Ranked presence strings are gone; the
  emblem's legal basis stays contract, worded as part of playing on a court. Last updated / dateModified September 30, 2026 in both,
  sitemap lastmod for the home page, how-to-play, privacy and terms, a dated line in privacy section 13. how-to-play's "Play Ranked"
  section, FAQ and FAQ ld+json are "Trophies and ranks" (h2 id `trophies`). changelog.html: one entry at the top of September 30 and the
  four meta descriptions ("trophies and ranks" instead of "Ranked mode"). No home-page notice (no new data is handled; NOTES 147 rule):
  ask the owner if one is wanted. CLAUDE.md data flows, README, docs/ACCOUNTS.md (the RK rows), SOCIAL.md, SHARE.md, SCENERY.md and
  ui-spec.md follow.
- Copy fixes from the verify pass (same commit). docs/ropa.md (the GDPR record) reworded to the trophies world (no queue, the ladder row's
  fields, the Trophies board, the emblem on every court under contract, the five presence strings, the per-game leaver rule) and its Last
  reviewed line bumped. Three sentences made exact: the ladder row's W/L and streaks count every person game played for trophies
  (db.ladderApply adds a win or a loss on every non-Matt call: a loss held at a floor and a leaver's loss count too), so privacy 2 and
  CLAUDE.md say "played for trophies", not "that changed your trophies"; the emblem shows for any seat with a ladder row (readTier), and a
  row is created by the first person game written even when it floors to 0, so privacy 4 says "once you have played a match against
  another player for trophies, or have earned trophies from Matt" (a first Matt loss or a Matt win at a limit creates no row); the leaver
  rule starts at the first strike (a forfeit before it is void), so terms 6, how-to-play (the section, the FAQ and its ld+json) and the
  changelog say "once the first ball has been struck", not "once it has started". docs/SOCIAL.md's phone line lists SEATS as
  quick/create/join/tcreate. Not changed here (other files): web/profile.js signedIn() is a boolean, so an account without a username reads
  "Win a game for your first trophies" on the Your stats hero and the Ranks page though the server answers none:'username' (the result card
  says "Pick a username to earn trophies"); wanted: a third state passed to ui.rankCrest and pinned in profile-ui.mjs. Stale comments in
  test/social.test.mjs:1 (rksignin.test), test/share.test.mjs, leaderboard.test.mjs, share-shots.mjs, ladder.test.mjs and web/emblems.html
  ("Ranked", "series", "stadium") are labels only.
- From the review and fix rounds (same commit). A paid forfeit win (the stayer's +30) now counts toward R10 pair_cap, R11b one_way and R12
  daily_cap (db.js pairs / winsOf / winsOver count a row that is `ranked = 1` OR whose winner was paid), so one pair cannot farm forfeits:
  the fourth forfeit of a day is +0 `left_early` while the leaver still pays. A leaver on a court flagged `revived` or `same_*` pays nothing
  (those games are 0 for everyone). An opponent without a ladder row is a gap of 0 even when eligible. The tournament VS card (`tmove`
  `vs` / `you`), the `tour` snapshot's sides and the bracket carry `tier` / `div`, and the bracket draws the emblem. The Your stats hero
  draws from /api/me's ladder first (`meLadder`), so the card opens whole (NOTES 150) and never on the empty hero; the road sits under the
  streak so the panel still fits 1280x800 without a scroll (NOTES 145). A tournament final's champion card waits for the result card's
  trophy row and rank-up (12 s fallback). `db.ladderOf` and `ladderTier` carry `row` (a ladder row exists); an account without a username
  reads "Pick a username to earn trophies" on the hero (`signedIn()` is false | 'username' | true). test/menu.mjs's bail-out is 420 s (the
  two trophies passes made the full run longer than its old 330 s). Pre-existing on main, not touched: ui-next.mjs 8 (settings rows, Sound
  output row, Tab order, hostile name, at two sizes), menu.mjs 7 (Part B3 settings and swing), share.test.mjs 5 PNG checks where
  @resvg is not installed, ui-shots/verify.mjs 5 (court list box heights).

## 158. Your stats without the filler text

The owner's ask (2026-09-30): "thoroughly clean up the stats page ... of any useless stupid text", naming the streak caption ("vs people ·
win again to extend it"), words beside an icon that already says it (the flame and "Streak 1"), and the rank info under the bar ("find a
better place ... consider adding an info page"). The rule for this page from now on: a number, its label and an icon; no coaching lines,
no caption that repeats its label, no sentence explaining how something works.

- Removed from web/index.html / profile.js / ui.js: the "Rank" label over the rank name; the keep line under the bar ("Bronze to Platinum
  are yours to keep..."); "win streak" beside the hero flame and the caption under it (all three variants); "Beat Matt at any level to earn
  a badge", "The top level ·" and "Beaten" (the day alone stays); "· streak N" on a Matt chip (a small flame and the number); "Play a
  person to start your record"; "Streak" inside the people chip (flame and number; "Best N" stays beside it); "Shows after 10 balls are
  hit to you" (the empty ring alone: the menu copy has no dashes, test/menu.mjs); the tile captions "Tournament win(s)", "Win a tournament to earn a title", "Keep the
  ball in play", "Swing hard to set a record", "Set on" (the day alone) and the Champion / Personal best chips; "Win a game for your first
  trophies" under "No trophies yet"; "Stats saved to your account" under a signed-in name. The Titles tile is labelled "Tournaments won".
- The info page is the Ranks page that already existed (one page per thing, NOTES 150): its lead and note already say what a win pays,
  which ranks are kept and which can drop. A small (i) button beside the rank name (#btn-st-info) opens it, as the crest does; Back
  returns to Your stats. profileFocus skips the (i), so an empty card still opens with nothing lit.
- What a removed line carried that is data rides in a tooltip: the hero streak's "Win streak vs Rookie Matt · best 3" (data-tip and
  aria-label on #st-streak).
- Kept on purpose: "Sign in to earn trophies" / "Pick a username to earn trophies" (the one thing a player cannot guess), "10 to Silver
  III", "60% won", "Points 50-41", "187 of 256 returned", "Best: Platinum I", and a guest's two header lines ("Stats saved on this device
  until ..." and "Delete them any time on the Privacy Policy page": the retention and deletion notice, ask the owner before cutting).
- Legal pages: nothing changes in what is collected, stored or shown to others, so privacy.html and terms.html are untouched.
  changelog.html has an October 1 entry.
- Tests: profile-ui.mjs, ui-next.mjs and menu.mjs pin the absence (no #st-keep, no #st-people-hint, no chips or captions on empty tiles,
  the streak ribbon's text is the number alone, the tooltip carries who and best). profile-ui 85/85; ui-next keeps its 8 pre-existing
  fails (settings rows, Sound output, Tab order, hostile name, at two sizes); mobile-ui passes.

## 159. The main menu is one panel: Quick play on top, five flat rows (docs/MENU.md)
- The owner (2026-10-01): "do a main menu ui / ux rework? i dont think the big buttons / the layout of them works very nice anymore.
  would like to see something cleaner." Four prototypes were built from different angles and scored by three judges (a 34rem panel of
  rows 77, a hero pill over a row of small pills 71, a left-aligned launcher list 69, a two-pane Play / You split 54; the prototypes and
  their shots live in the session's scratchpad, menu/protos); the rows design won on every lens, with grafts from the others.
- What changed (web/index.html #lobby-home, web/ui.css, web/ui.js). The six glossy tiles (two hero cards over four squat utilities,
  `.tiles[data-n]` grids) are gone. The home is ONE 34rem panel (`.hm-list`, the `.panel-narrow` width) centred over the court on the
  same axis as the title's Play: for a guest the name as the panel's flat top cap (caps NAME, a borderless field; `.is-acct` set in
  `lockName()` hides it for an account, whose username is already the header's button, NOTES 151); Quick play as a full-width 5rem
  `.btn` pill in the title's Play material, the one blue-bordered thing on the page; then five flat rows (`.hm-row`: a 2.5rem icon, the
  label, a quiet grey status at the right end, 1px hairlines between, no chevrons, no gloss, no corner badges): Friends (the friends
  line, the request count as the one orange chip), Courts (8 open as grey text), Play a bot, Your stats, Leaderboard. Hover: a sky
  tint and the row's contents step .25rem right; focus adds the inset ring; the deal-in is translate/opacity, off under reduced
  motion. Panel and cap are white at .9 so the court no longer bands through. Order change: Quick play now leads and Friends is the
  first row under it (NOTES 150 had Friends | Quick play as equal heroes). The phone home keeps its paddle card and lists the same
  rows under it. Every id, data-nav, the `tile` marker class (ui.tilesFit, nameGate, the dim rules), the arrow ring (DOM order =
  visual order) and Enter = Quick play on entry are kept, so main.js, profile.js and social.js are untouched.
- Fit: 1366x600 with ~80 px to spare, 1280x720, 1440x900, 600x900 centred, 390x844; the ended-tournament notice now shares the
  panel's width and radius. Review fixes in the same commit: the NAME cap label never below 12 px; the empty request chip takes no
  width; the field keeps a fill and a focus ring so it reads as editable; the typed name sits on the rows' label column; the status
  text transitions with the row; a downed lobby keeps its focus ring for keyboard users; `.is-bad` still colours the field.
- Tests: menu.mjs, ui-next.mjs, profile-ui.mjs, mobile-ui.mjs, social-ui.mjs updated from the tile grids (row shapes, data-n) to the
  panel (one column, order, the cap, the `lobby-acct` mock state); e2e's Enter = Quick play unchanged; test/ui-mock.html gained
  `lobby-acct`. Pre-existing reds unchanged: ui-next 8 (settings rows, Sound output row, Tab order, hostile name x2), menu.mjs 7
  (Part B3), ui-shots/verify.mjs 5 (court list heights).
- Not in this change (owner's call): a one-line rank + trophies under Your stats for an account (the two-pane idea); the title
  screen is untouched. No legal-page change: nothing new is stored, sent or shown.

## 160. The home is big blocks again, rearranged (the rows menu of 159 is gone)

The owner on the rows menu of NOTES 159 (2026-10-01): "the main menu is really ugly, i actually like the big blocks buttons before as it
was more playful. surely you can think of something nicer? if not, revert it." So 2281abd's web and test changes are reverted (docs/MENU.md
stays with a superseded banner) and the tiles come back in a new arrangement that answers his first complaint (the old 2-over-4 grid with
two equal white heroes did not "work very nice anymore"):

- Two rows on a 12-column grid (`.tiles:is([data-n="5"],[data-n="6"])`, ui.css). Row one is how you play: Quick play (the only `.is-hero`,
  half the row, 13rem tall) beside Courts and Play a bot (`.is-play`, icon over label). Row two is the rest as three equal bars: Friends,
  Your stats, Leaderboard (two bars when Friends does not show). DOM order = reading order = arrow order: Quick play, Courts, Play a bot,
  Friends, Your stats, Leaderboard. Friends is no longer a hero (NOTES 150 had Friends | Quick play).
- Quick play is the one filled block: the player's blue with white art. Every other block is white with its own accent (a local `--line`:
  Courts green, Play a bot pink (orange until 2026-10-02: too close to the Leaderboard gold), Friends purple, Your stats the blue, Leaderboard gold) on the icon detail, the hover ring and the glow
  (`.tile{--glow}` is built from `--line`).
- Upright windows: Quick play the full width, then bars two by two, Friends the full width between them. Under 480px: one column, Quick
  play first. A phone (html[data-mobile], data-n 1..4) is untouched apart from the order: Watch a match, Friends, Your stats, Leaderboard.
- The name pill sits over the blocks again, as before 159. Nothing in main.js, profile.js or social.js changed; no data flow changed, so
  the legal pages are untouched.
- Tests: ui-next, menu, profile-ui, social-ui and mobile-ui pin the new order and row shapes (3,3 / 3,2 landscape; 1,2,1,2 / 1,2,2 upright;
  one column on a phone-width window). Pre-existing reds unchanged: ui-next 8, menu.mjs 7.

## 161. The player card in the corner of the menu

The owner (2026-10-02): "add player stats bar / card in the corner of the menu screen so u dont have to go to stats to see your like trophy
count and stuff? think brawlstars ui". One card per thing (NOTES 150): the header's account button (NOTES 151, #btn-head-acct) already sat
in that corner and already opened Your stats, so it grows into the card instead of a second thing beside it.

- Signed in with a username the button is `.is-card`: the rank emblem (ui.rankEmblem at 2.75rem, no numeral: the division is the medal's
  shape), the username, and the trophy count with the gold cup under it, and under that the trophy bar (ui.rankProgress: the hero bar, across the current division; added the same day at the owner's ask). It shows on every lobby view and opens Your stats. profile.js
  drawChip draws it from `meLadder`, so it is right from /api/me alone (before Your stats is ever opened) and follows every /api/stats
  answer and each game's trophies; drawAcct calls it on sign-in, sign-out and rename.
- No trophies yet: the person icon, the name and 0. A guest keeps "Sign in", an account without a username "Pick a username".
- Under 480px (fixed 2026-10-02: the owner found the emblem-only circle broken on his phone) the card is the emblem and the count over the bar,
  no name and no cup, clear of Back and the title on every view (profile-ui section G checks 390x844, 844x390 and 320x568 under an iPhone
  user agent); under 350px the emblem alone. Its aria-label carries the name and count.
- Same day, Your stats: the streak pill no longer floats over the middle of the road. Desktop: in the hero's corner, on the road's right
  edge. Phone: under the bar, on the rank column's left edge.
- Nothing new is sent, stored or shown to anyone else: the legal pages are untouched.
- Tests: profile-ui.mjs section G (the card on the home screen, its click, phone width, no trophies, a guest).

## 162. The pickleball logo is shaded by hue, not by darkening
The owner's ask: better colour theory on the ball, shading that shifts the hue to a deeper neon yellow instead of a darker
lime (the old shade went olive: #c5d124 edge, #5a6e00 bottom wash, #a9b912 holes).
- Body #e8fb2a (`--ball`, a touch more neon than #e6f03c), highlight #fbffd6, edge #ffe01a, bottom wash #ffcc00 at .42, holes
  #cfae00 (`--ball-deep`), rim #dcbc00. Every shade sits at hue 50..56, warmer than the body (~68) and clear of the medal golds
  (`--gold-2` 45, `--gold-3` 39), so it reads yellow, not gold or orange.
- Holes vs body is 1.88:1 (WCAG ratio), above the old 1.75:1, so they still read at 16 px (favicon-check.png on light and dark).
- Everywhere the ball is drawn: ui.css (tokens, .logo-ball and its inset shade, .serve-ind), how-to-play.css, pad.css,
  server/share.js and server/card.js (the /c/ share card), test/og-card.html, test/make-og.mjs. Regenerated with
  `node test/make-og.mjs`: favicon.svg, favicon-32.png, favicon.ico, apple-touch-icon.png, icon-192/512.png and og.jpg;
  og:image is now ?v=7. The in-game 3D ball (scene.js ballTex) is gameplay art and unchanged.
- The Poddle Helper's Resources/icon-512.png got the new icon; the released zip still carries the old one until the next build.
- Changelog: October 2, "A brighter Poddle ball". Nothing is sent, stored or shown differently: the legal pages are untouched.

## 163. The in-game ball matches the logo; Poddle Helper 1.0.1 with the new icon
Follow-up to 162 at the owner's yes.
- scene.js ballTex: body #e3f23a -> #e8fb2a (`--ball`), holes olive #6f7d12 -> #a88e00, the same hue-shifted deep yellow
  (hue 51) as the logo's holes but darker: the ball is emissive (emissiveIntensity 1.6) and the logo's #cfae00 washed out in a
  render at play size. The trail keeps its speed ramp (gameplay information, not branding). og.jpg regenerated (the ball is in
  the shot), og:image ?v=8.
- Poddle Helper 1.0.1 (danielrltan/poddle-helper c49b557 icon, then the version bump; tag v1.0.1, GitHub release "Poddle Helper
  1.0.1"): only the app icon changed since 1.0.0. web/download/Poddle-Helper.zip is the same file as the release asset (sha256
  19670dba84d6...). releases/latest now points at 1.0.1.
- Changelog: the October 2 entry names the game ball and the Mac Helper too. Nothing sent, stored or shown changes: legal pages untouched.

## 164. The profile card wears Your stats' layout, shows the current streak, and leads with the friend button

The owner (2026-10-02): "you need to show streak on public player stat cards", "also include total time on court", "can u make public
player cards nicer? like why dont u just use player cards on the stats page and have that? and then also add a friend add button on them".
Time on court and the friend row were already on the card (NOTES 145, 146); what changed:

- #lbp-card's body is Your stats' own pieces (.st-hero, .st-matt, .st-people, .st-play, .st-tiles; card width 46rem): the hero with the
  emblem, rank, trophies and the flame; Hardest level beaten; the people strip (W-L, the bar, Best flame N); the play row (the return rate
  ring, winners, aces, smashes, points won, on court); three tiles (tournaments won, longest rally, fastest swing). The eleven public
  figures keep server/card.js dataOf's order and land in `[data-stat="0..10"]`; W and L are read from the first figure's note
  ("31-12 vs people"). Not public, so not on the card: total hits, the per-level Matt records, the dates, the trophy road.
- The flame is new public data: `/api/leaderboard/player` answers `streak`, the current win streak as Your stats' hero shows it (the
  highest of the streak vs people and the streak at each Matt level; server/share.js streakOf). Profile card only: card.dataOf, the share
  page and its PNG are untouched. An older server sends none: no pill.
- The friend row (#lbp-friend, web/social.js) moved from the bottom to right under the name. A stranger's row is the Add friend button
  alone (the "Friends see when you're online" line went, NOTES 158); a guest's "Sign in to add friends" is a real button, not a link.
- Legal (same commit): privacy.html section 4 Profile cards, the legal-basis table and a dated line in 13 name the current winning
  streak; Last updated / dateModified October 2, 2026, sitemap lastmod; docs/ropa.md and CLAUDE.md data flows follow; changelog.html has
  an October 2 entry linking the policy. No home-page notice was added (ask the owner if he wants one; NOTES 147).
- Tests: lb-profile-ui.mjs and social-ui.mjs read the eleven by [data-stat], the record, the flame and the friend row's place.
## 165. The winner's shot: VICTORY! holds, then the winner with a trophy on the court and the result as a panel on the right
- The owner: VICTORY is "incredibly brief"; lengthen it, "and then, instead of the boring white rematch / end screen, it should cut to a zoom in of
  the winning player on the left side of the screen on the court (about 3/5s). The player should be holding a trophy in their hand, in which they
  can move their phone around to move it in game accordingly. Then on the 2/5 right side, you have the rematch buttons, leave, etc." And, while it
  was being built: "camera tracking should still be enabled at that winner screen, so players can move up / down for fun".
- VICTORY! (ui.js STAMP_MS 2600, ui.css ov-victory 2800 ms; it was 950 / 780, NOTES 130): over the LIVE court (dimmed a little so the word reads),
  bigger (11rem), in by 110 ms on the win sting, held and slowly growing, fading as the panel arrives. Still only on a win of your own (NOTES 122):
  a loss, a forfeit win and watching cut to the winner at once. Reduced motion: no stamp, no wait.
- The result is the same #result card (one card per thing), restyled by ui.css's last section for `#screen-match:not([data-beat="champ"])`: no white
  ground, the card is a full-height panel down the right 40vw (slides in, 560 ms), every row of it kept (medal, title, tally, trophy row and its
  ceremony, stats, the save line, Rematch / Leave, the countdown, See bracket). RANK UP stamps over the court pane, the light sweep crosses the
  panel only. A tall or narrow window (max-aspect-ratio 1/1 or max-width 760px: phones watching, a portrait window) lays the panel along the bottom
  (max 58dvh, no medal). The champion card is off the court (the lobby is behind it) and keeps the old centred card and ground.
- The shot (scene.js setVictory(side, pane), victoryPose): a cut to a camera 4.2 m in front of the winner, a little to the trophy's side, that
  pushes in over 1.5 s and then drifts; it follows the winner's body. The lens is off-axis so the winner sits in the middle of the pane the panel
  leaves free (ui.resultPane() measures it from the card each frame: {fw, fh, px, py}). 3.2 m of height is framed, so there is room to stretch and
  duck. Near the net the camera stays on the winner's side of it and widens instead. Every fence stands, the winner is solid even when it is me
  (dress(-1)), looks into the lens, hops now and then, and a fill light from the lens (always in the scene at intensity 0, so no recompile) lifts
  the face: side 0 faces away from the sun. A spectator in split gets the one shot too.
- The trophy (scene.js buildTrophy): a lathe-turned gold cup with two handles on a dark plinth, origin at the grip like the paddle. While the shot
  is on, the winner's paddle is hidden and the trophy takes its position and attitude (pd.group's), lifted 0.34 m to the shoulder: so the phone /
  AirPod turns it 1:1 for the winner, and the other player and spectators see it through the same relayed q as ever. Matt has no q: he turns and
  tips his cup on a canned sway. A puff of gold sparks when it appears.
- Body tracking needed nothing: main.js's loop keeps feeding my paddle from the camera behind the result, the 20 Hz 'paddle' send never stopped,
  and the server keeps stepping and broadcasting 'state' while `over` is set. So stepping, ducking and stretching show on both screens.
- main.js: showOver keeps the winner's seat (vicSide) and when the panel is due (vicAt = now + the ms ui.matchResult now returns). The render loop
  calls scene.setVictory(seat) exactly while the match overlay is up over the court, not the champion card, and past vicAt, else null: nothing else
  has to remember to end it (rematchon, serve, closed, Leave, Q Q all just close the overlay). The trophy row and its ticks / rank-up jingle wait
  for the panel (trophiesIn parks until vicAt, reveal() draws), so the roll is seen; the second confetti burst moved there too.
- Edge cases. Nothing on the panel takes focus or a click behind VICTORY! (pointer-events none, focus at 60 ms + the wait; an early Enter votes
  nothing). The rematch clock is the server's 20 s from match point, so the panel opens at about 17. The winner left (a tournament no-show, a
  forfeit seen by a spectator whose winner is gone): the same shot of where they stood, no trophy. A set-up screen up at match point: showOver runs
  when the court opens, as before. Guests, signed-in, phones watching: the same. Legacy no-vote rooms close the card 6 s after it is in.
- No data, storage, permission or third-party change: the legal pages are untouched. The changelog page has the entry.
- Decisions made without asking: no DEFEAT stamp (NOTES 122's rule kept; the owner wrote "when you win / lose" but only VICTORY! exists); the
  gold medal stays at the top of the panel; the champion card is unchanged.
- test/victory-e2e.mjs (new, VICTORY_PORT, ~2 min): a real match to 3 with a spectator; the stamp's 2.8 s and the panel's wait, the cut on the
  three screens, the panel's box, the winner's head and the trophy inside the free pane (also 600x900), the trophy turning with the hand on the
  loser's screen, the rematch putting paddles back. Shots: test/ui-shots/victory-*.png. test/ui-next.mjs waits for the panel where it measured
  the card at once; its 8 old reds are unchanged.
