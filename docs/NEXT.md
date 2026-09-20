# NEXT: the work queue for the file-owner workflow (the player's requests, with the data behind each decision)

Everything here was asked for by the player in his own words, or decided by him when asked. Protocol details for
spectators, rematch, seat hold, pause and names are in docs/SPECTATE.md (binding). Room basics: docs/ROOMS.md. Scenery: docs/SCENERY.md.
The numbers in sections 1-4 come from replaying 143 real recorded swings (data/live-*.jsonl); `node test/kinds.mjs` is the
repo's own replay tool and must be kept working and updated to the new rules. The analysis scripts used are in
SCRATCH (tune.mjs, lobs.mjs, windup.mjs) if you want to re-run them; they read copies of the PRE-rooms sources, so use them for
the maths, not for line numbers.
SCRATCH = /private/tmp/claude-501/-Users-danieltan/b8483342-59c3-4c3b-b01a-256a7ca3754f/scratchpad

## 0. (historic header) shot tuning, controls, pause, names, attract rally
Analysis scripts: scratchpad/tune.mjs, lobs.mjs, windup.mjs (run against HEAD copies: game.head.js, main.head.js, motion.head.mjs). 143 real swings.

## 1. Smash must be earned (server/game.js, swing handler + shotKind) and rewarded (solve)
- NOW: `if (chop > 0.45 && pw > 0.25) pw = Math.max(pw, 0.86)` -> any downward swing over 13 rad/s is a full smash. 4 of 23 smashes were these.
- NEW: overhead bonus only for a real stroke and additive: `if (chop > 0.45 && pw > 0.55) pw = Math.min(1, pw + 0.2)`.
- shotKind smash threshold 0.62 -> 0.76 (27.3 rad/s ~ this player's p90). Both occurrences in shotKind. Check `hard(n)` (0.45..0.7) users still make sense.
- Reward: in solve(), flight time T for drives gets faster at the top: subtract ~0.07*smoothstep(0.76,1,n) from the level-swing T (0.58 -> ~0.51 at full power). Run test/deep.test.mjs, kitchen, serve, server sweeps: ball must still clear net and land in.
- Expected mix: smash 16% -> ~10-11%, none boosted.

## 2. Lobs intentional (web/main.js where the swing is sent; server underhand())
- Curved (C-shaped) swings are not underhands: client sends `lob: e.lob * (1 - smoothstep(e.turn, 0.6, 1.0))`.
- server underhand(): upward share window 0.55..0.85 -> 0.62..0.88.
- Data: powered lobs 3 -> 1; the survivor is up 0.92 / turn 0.00 / power 27 (the deliberate one). Killed: up .77 turn .96, up .96 turn 1.14.

## 3. Slices a little more common (web/main.js spin maths)
- USER ASKED FOR 27% SLICES. roll: (|roll| - 0.6)/0.3 -> (|roll| - 0.5)/0.3 ; curve: (turn - 1.2)/1.0 -> (turn - 0.9)/0.8. With final rules (smash .76, boost n>.55 +.2, lob gate .6-1.0, underhand .62-.88) measured: slice 27%, smash 11%, drive 17%, lob 1%, dink 3%, tap 41%. (0.48 also 27%; 0.45 -> 29%.)
- test/kinds.mjs hardcodes the old chop rule `e.chop > 0.45 && n > 0.25 ? Math.max(n, 0.86)`: update to the new rule; it greps main.js between 'const roll = Math.max(' and 'const slice = amount'.

## 4. Serve ignores the wind-up (server serve branch + step)
- Data: 30 windup->stroke pairs, gap 0.4-0.8 s (max 0.9), 27/30 opposite dir, windup power median 6.9, p90 15.2, max 21.0. SERVE_POWER is 11.
- NEW logic on a serve swing A (power >= SERVE_POWER, keep ~11-12):
  - power >= 22 -> strike now.
  - a previous swing from this player (any power) within 1.2 s -> A is the real stroke -> strike now. (needs me.lastSwingAt recorded for EVERY swing msg incl. sub-threshold, before the SERVE_POWER return)
  - else hold A as me.servePending until now + 0.7 s; a swing B arriving meanwhile that is stronger (>= 0.9*A) or opposite dir -> strike with B now; timeout (checked in step() serving branch) -> strike with A. serveReach re-checked at strike time. 'swung' broadcast still immediate.
- Serve floor: n = max(pw, 0.35) on serves so a legal soft serve still clears the kitchen properly.
- Add test to test/serve.test.mjs: windup(15, dir +1) then stroke(28, dir -1) 0.6 s later -> ONE hit with n from 28; lone stroke 28 -> immediate; lone stroke 15 -> hit after ~0.7 s; twitch 8 -> nothing.

## 5. Also pending: NPC attract rally behind the blurred menu (client-side, scene.js/main.js), NOTES.md sections, deploy, push.

## 3b. SUPERSEDES the thresholds in 3: spin is CONTINUOUS, every hit carries its own amount (user request)
- Measured on 63 real strokes (power >= 9): OLD gating = 76% exactly zero spin, 16% >= 0.8, almost nothing between. Binary.
- Client (web/main.js spin maths): amount = max( clamp((|roll| - 0.12) / 0.83, 0, 1), clamp((turn - 0.3) / 2.3, 0, 1) )   [roll 0.12..0.95, turn 0.3..2.6, linear]. Sign (`way`) logic unchanged.
- Server: sliced(slice, lob) loses its smoothstep(0.3, 0.7): spin = clamp(|slice|, 0, 1) * (1 - 0.6 * underhand(lob)). Physics (gOf, SLICE.slow, bounce lerp, kick) already scale with spin.
- Result on the recordings: p25 0.14, p50 0.28, p75 0.51, p90 0.80; > 0.5 ("reads as a slice": blue ring, hiss, 'slice' label): 27% (the user's number); >= 0.8: 11%; exactly zero: 5%.
- 'slice' LABEL stays spin > 0.5 (shotKind). Check: FIX re-aim comparison uses sliced() differences > 0.2 (fine), bot shots, test/slice.test.mjs expectations (it may assert on the old dead zone: update the test to the new curve, do not bend the curve to the test), test/kinds.mjs greps the client maths between 'const roll = Math.max(' and 'const slice = amount' (keep those anchors).
- Feel: the trail tint already follows spin continuously (b.cool). Consider scaling the hit hiss volume by spin instead of the > 0.5 gate.

## 6. Controls bar + settings (user answers, 2026-09-20). Files: web/index.html, ui.css, ui.js, main.js (after workflow wel3u5f9a)
- Bottom-right: NO white bar/panel. Just white keyboard-key icons in the corner with a short label each: [C] Calibrate, [M] Move: <mode>. Nothing else. Keep today's fade-when-idle (ui.wake / .is-idle). Must read over both grass and court: white keycap outline/fill + soft text shadow, no backing plate.
- Every other key keeps working silently: R re-center, F full screen, [ ] range, V AirPod, H stats, B / 1 2 3 bot, P.
- NEW hamburger button, top corner (pick the corner that does not collide with the scoreboard/room code; check HUD layout), opens a Settings panel (Wii-style card, same visual language, closes on Esc / click outside, pauses nothing). Contents: Sensitivity (the [ ] range) as - / + steps with the current value; Show AirPod (V) toggle; Show stats (H) toggle; Re-center; Full screen toggle; Leave room (when in a room). Persist toggles + sensitivity in localStorage (try/catch). Copy: terse, per the style guide from the copy audit.
- Bot moves to the MAIN MENU: lobby gets a 4th choice "Play a bot" with Rookie / Club / Pro. Implementation needs no protocol change: send {type:'create', public:false}, then after 'welcome' send {type:'bot', level}. Remove B and 1 2 3 from the bar (keys still work). Check the menu agent's lobby layout fits a 4th card at 1280x720 and 600x900.
- Update test/e2e.mjs / test/shots.mjs / test/menu.mjs if they assert on #keys contents or key hint text.

## 7. Hamburger = pause (user request). Builds on 6.
- Opening the settings panel: vs a BOT -> the match pauses and the court blurs behind the panel (same blur layer as the main menu). vs a HUMAN -> no pause, no blur-freeze: the panel is just an overlay and play continues behind it (make the panel compact/translucent enough that you can see you are still live; show a one-line note like "Online games can't pause").
- Server (per room, after the rooms refactor): `{type:'pause', on}` honoured only when the room has exactly one human (+/- bot). Paused room: step() is skipped (room `now` does not advance; serveBy, swing windows, bot timers all freeze for free since they are in room time), swings/paddle ignored, state still broadcast with `paused:true` so late joiners/reconnects see it. Auto-resume when: the pauser disconnects or leaves, a second human joins (public room) -> broadcast resume + the joiner toast, or after 10 min. Reply `{type:'paused', on, by}` to the room. Legacy LOCAL room gets it too.
- Client netcode gotchas (scene.js): while paused the server's t stands still but arrival time runs -> the clock would age the ball and coast it up to 0.6 s. So: state with paused:true sets ball.frozen (age forced to 0, no coast/hover), and on resume call clock.reset() (otherwise the stale min-offset makes every packet look N seconds old and the ball leaps). The 'net' quality tracker should ignore paused time. NPC/bot paddle animations can keep idling.
- UI: Esc toggles the panel too. Closing the panel resumes (send pause off) with a short 3-2-1? NO countdown unless asked: resume immediately, the ball was mid-flight so give 0.4 s grace by easing time back in? Keep simple: immediate resume; if it feels harsh, add a 1 s "Ready" beat later.
- Tests: rooms.test pause cases: bot room pauses (state t frozen, ball p unchanged over 1 s), human-vs-human pause refused, second human joining a paused public room resumes it, pauser disconnect resumes/cleans up.

## 8. Remove the three status pills top-right (user request)
- Delete #lights (.status-lights: #st-airpod, #st-game, #st-camera) from the HUD + their CSS. ui.setStatus() writes to both st-* and row-*: make it null-safe for the missing st-* elements and drop the 'all-ok' toggle on #lights. KEEP the big status rows on the connect-gear screen (row-airpod / row-game / row-camera): that screen is where setup problems get solved.
- Nothing is lost for live failures: setStatus already toasts 'AirPod signal lost' / 'Reconnecting to the game…' after 1.5 s, and the server-down overlay exists.
- The freed top-right corner is where the hamburger goes (section 6). Put the same three statuses as small rows inside the settings panel (AirPod / Game / Camera + state word), so they are one click away instead of always on screen.
- Tests: grep test/ for st-airpod / st-game / st-camera / #lights (e2e.mjs, shots.mjs) and update.

## 9. Spectators + rematch + seat hold: contract written to docs/SPECTATE.md (user answers: no rematch -> everyone to lobby; mid-game drop -> hold 15 s then forfeit; public games watchable from lobby; default view broadcast side-on).
## LAUNCH PLAN for workflow 3 (after wel3u5f9a finishes; scenery wbset92wm only touches web/scenery/): single OWNER per file, each owner gets ALL pending work for its files (sections 1-9): SERVER (server/game.js+tests), SCENE (web/scene.js: spectator cameras, split screen, attract NPC rally, frozen ball, hiss by spin), UI (index.html/ui.css/ui.js), MAIN (main.js). First an API-contract agent (ui.js + scene.js function names), then the 4 owners in parallel, then an integrator, then 3 verifiers, then a fixer.

## 10. Matt, names, bot avatar (user request)
- Bot is named Matt (all levels). "Play a bot" is a main-menu game mode (already in section 6) with Rookie / Club / Pro as difficulty.
- Bot avatar in web/scene.js (the Mii-ish avatar builder; pd.bot): a Black man in an orange shirt: deep brown skin tone (e.g. 0x6b4226 with slightly lighter 0x7a4e2d highlights if the builder shades), black short hair, orange shirt (~0xf5821f), keep the friendly Mii proportions and face; human opponents keep today's colours. The menu's NPC rally players: one of them is Matt, the other a generic player in the existing palette.
- Player names: contract in docs/SPECTATE.md "Names". Lobby name field (required, prefilled), server sanitises and broadcasts names, all who-did-what copy uses them.

## 11. Menu background = endless NPC rally, cheap (user request; supersedes any server-driven background play)
- Observed bug: with an OLD server (no lobby support) the new client got seated behind the menu, the bot beat the idle seat, and the match-result screen showed over the menu. Guards needed in main.js regardless of server: while phase is title/lobby (no room joined) IGNORE welcome/state/point/match/hit UI effects entirely: no match screen, no banners, no toasts, no score, no sounds. The result screen may only ever show when phase === 'play' (or spectating).
- The background rally is CLIENT-SIDE ONLY (scene.js attract mode): Matt + a generic NPC rally forever. No score, no points, no serve ritual, no win, no sounds, no camera shake, no toasts. A miss never happens: every shot is solved to land in and the receiver always gets there; vary drive / soft / lob-ish arcs and left/right so it does not loop visibly. Uses coast() for the flight and the existing bot swing animation. Starts on title, stops the moment a room is joined (scene.startAttract() / stopAttract()).
- Cheap while the menu is up, because it is blurred anyway: render at half pixel ratio and 30 fps (skip every other rAF), no shadow-map updates if that is a simple switch (renderer.shadowMap.autoUpdate = false after one frame), fx pools idle, scenery update still runs (cheap). Restore full quality on entering play. Pause rendering entirely when the tab is hidden (document.visibilityState).

## 12. Scenery follow-ups (from the scenery workflow's verifiers; web/scene.js owner)
- MENU CAMERA: the play camera shows only ~6 degrees of sky, so the blurred menu read as "green court, green mounds". While a
  menu screen is up use a menu camera: eye about 3.4 m, level gaze, fov ~60, from behind a baseline (see
  test/ui-shots/scenery/final-menu0.png and final-menu0-blur.png for the look), with the slow drift the menu already has. Ease
  to the play camera when the court opens.
- BALL CONTRAST: from side 0 the ball against the low sky measured only 1.1-1.4 : 1. The cure named by the auditor is the ball
  itself: give the ball material enough emissive that its shaded face does not go dark and its lit face stays clearly lighter
  than the sky (check both ends, against sky, ficus band and court; do not blow out the trail colours).

## 10b. Names, added by the player AFTER docs/API-NEXT.md was written (owners: read docs/SPECTATE.md "Names" again)
- "you also never asked for my name when i joined the game and cached it. you should be able to change ur name in settings btw"
- UI owner: a Name row in the settings panel (input, 12 chars, saves on Enter/blur) + the first-visit behaviour of the lobby field. MAIN owner: localStorage `poddle.name`, send `{type:'name', name}` when changed inside a room. SERVER owner: handle `name`, broadcast `names`.

## 13. Small things already done by hand, do not undo
- web/index.html + ui.css + ui.js: the three status lights (#st-airpod/#st-game/#st-camera) are ALREADY removed from the HUD (setStatus is null-safe; #lights now only holds the room pill) and the key strip is ALREADY two white keycaps (C Calibrate, M Move) with no backing plate, bottom-left, fading when idle; #key-leave is kept in the DOM but never shown (.key-off). UI owner: keep these, build the rest on top.
- CORNERS (checked on a real HUD screenshot): the status lights were TOP-LEFT next to the room pill; top-right holds the webcam + AirPod insets. The HAMBURGER goes TOP-LEFT where the lights were, with the room pill beside it. The player calls this corner "top right"; what he means is "where the lights were".
- web/scene.js: the bot avatar is already Matt (COL.matt: skin 0x6b4226, shirt 0xf26b1d, hair 0x15110e, eye whites, repainted in updatePaddle when pd.bot flips, paddle hand included). SCENE owner: keep it, reuse it for the attract rally's Matt.
- web/ui.css: `.logo-mark .lg-a{color:#39434d}` (darker "Pod" in the wordmark, the player asked for more contrast).
- web/ui.css: `.btn::before` has a clip-path that keeps the gloss inside the button's pill (white chunks used to stick out of
  the Play button's top corners). Any new button style must keep it.
