# API-NEXT: the contract between the four owners of docs/NEXT.md

Four owners build at the same time, each in their own files, without talking. This file is where they meet. If a name,
argument, id or string is written here, build exactly that. If you need something that is not here, do not invent a
cross-file call: solve it inside your own files and say so in your report.
Read first: docs/NEXT.md (the work), docs/SPECTATE.md (binding protocol), docs/ROOMS.md. Where this file adds to the
protocol it says ADDENDUM; nothing here contradicts SPECTATE.md.

Owners: **SERVER** = server/game.js + server tests. **SCENE** = web/scene.js. **UI** = web/index.html + web/ui.css +
web/ui.js. **MAIN** = web/main.js (+ web/motion.js only if needed). Nobody edits web/scenery/, web/strokes.js,
web/podview.js, web/bodytrack.js, bridge/, motion/.
Ground rules for everyone: be strict in what you export and forgiving in what you accept. MAIN: unknown message types
and missing fields fall through silently. UI: every optional element is null-checked, every argument may be missing.
SCENE: bad arguments are ignored. SERVER: every new field is untrusted (strings only, numbers only, 4 KB cap as today).
MAIN calls the functions of sections 2 and 3 directly, without `?.`: the integrator merges all four before anything
runs together. Names are untrusted text: textContent only. No new dependencies, no build step.

Two facts the docs get wrong, checked in the code: (1) the three status pills are top-LEFT (`.status-lights{left:var(--edge)}`,
see test/ui-shots/rooms-6-hud-1280x720.png); top-right holds the webcam and AirPod insets. So the hamburger goes top-LEFT, in
the corner the pills free up, with the room code beside it. (2) the key hints are bottom-LEFT today; NEXT.md 6 moves them
bottom-RIGHT.

---------------------------------------------------------------------------------------------------------------------
## 1. OWNERSHIP: every item of docs/NEXT.md

| NEXT.md | SERVER | SCENE | UI | MAIN |
|---|---|---|---|---|
| 0 header | nothing to build | | | |
| 1 smash earned + rewarded | all of it: chop bonus rule, shotKind 0.62 -> 0.76 (both), `hard()` users checked, solve() T reward; sweeps in deep / kitchen / serve / server tests | trail "fire" starts at hot 0.55: leave (n is unchanged, only rarer) | | |
| 2 lobs intentional | underhand() window 0.62..0.88 | | | swing sends `lob: e.lob * (1 - smoothstep(0.6, 1.0, e.turn))` |
| 3 slice thresholds | superseded by 3b | | | superseded by 3b |
| 3b continuous spin | `sliced()` loses its smoothstep: `clamp(abs(slice),0,1) * (1 - 0.6*underhand(lob))`; 'slice' label stays spin > 0.5; update test/slice.test.mjs to the new curve; update test/kinds.mjs (new chop rule, the lob gate of item 2 hardcoded the same way) | hit hiss scaled by spin (section 2.9) | | spin maths: `amount = max(clamp((abs(roll)-0.12)/0.83,0,1), clamp((turn-0.3)/2.3,0,1))`. KEEP the local names `roll`, `curve`, `amount`, `way` and the anchors `const roll = Math.max(` ... `const slice = amount`: test/kinds.mjs evals that slice of main.js |
| 4 serve ignores the wind-up | all of it + the four cases in test/serve.test.mjs | | | |
| 5 pending list | | attract rally = item 11 | | attract wiring = item 11. NOTES.md sections: INTEGRATOR, after the merge. Deploy and push: the player, nobody in this workflow |
| 6 keycap hints + settings + Play a bot | none (`create` then `bot` already work) | | keycaps C and M only, no plate, bottom-right; hamburger + settings panel; "Play a bot" tile and view; fits 4 tiles at 1280x720 and 600x900; test/menu.mjs + ui-mock + shoot/verify updated | settings callbacks, persistence (`poddle.settings`), every old key still works silently, Play a bot = `create` private then `bot` level after `welcome`; test/e2e.mjs, test/shots.mjs, test/rooms-e2e.mjs updated |
| 7 hamburger = pause | `pause` / `paused`, room time stops, auto-resume rules, `state.paused`; LOCAL too; rooms.test cases | `setFrozen()` (2.6) | `setPaused()`, blur behind the open panel when paused, "Online games can’t pause" row, "Paused" tag | sends `pause` on open / close when the other seat is Matt or empty; Esc toggles the panel; freezes the ball; net tracker ignores paused time |
| 8 remove the status pills | | | delete `#lights`, `#st-*` and their CSS; `setStatus` null-safe, no `all-ok`; connect-screen rows kept; the three statuses as rows in the settings panel; `#room-pill` moves next to the hamburger | `refreshStatus()` unchanged; fix any test it owns that reads `st-*` |
| 9 spectators, rematch, seat hold | everything in docs/SPECTATE.md + the ADDENDA in section 4.1 | spectator mode and the four views (2.2, 2.3) | Watch buttons, watch prompt, spectator HUD, view chips, result with Rematch / Leave, hold card (section 3) | phase `watch`, message table (section 4), view keys 1-4, `poddle.view` |
| 9 LAUNCH PLAN | this file is its first step | | | |
| 10 Matt, names, bot look | bot is `Matt` in `names`; name sanitising; `names` broadcasts | Matt's look on `bot:true` (2.7); attract: side 1 is Matt | lobby name field; every who-did-what string built from names | sends `name` on quick / create / join / watch; keeps `names`; feeds them to UI |
| 11 menu background = client-side NPC rally | none. (Server-driven background play is dead.) | `startAttract()` / `stopAttract()`, `setMenu()` cheap mode, no render while the tab is hidden | `.glass` unchanged | the no-room guard (4.2); start / stop calls (4.5) |
| 12 menu camera + ball contrast | | both (2.4, 2.8) | | deletes its own menu drift (the `scene.setViewer(sin...)` line in the rAF loop): the menu camera drifts by itself |
| 13 hand fixes, do not undo | | | `.logo-mark .lg-a{color:#39434d}` stays; every new button keeps `.btn::before`'s clip-path (use `.btn`, do not re-roll a pill) | |

---------------------------------------------------------------------------------------------------------------------
## 2. SCENE API (web/scene.js). MAIN is the only caller.

`createScene(containerEl)` returns today's object plus the new members. EVERY existing member keeps its name, arguments
and behaviour: `setCourt, setSide, setViewer, updatePaddle, updateBall, hideBall, onEvent, unlockAudio, render, resize,
_dbg`, and the module exports `coast, coastTo, hover, serverClock`. test/scene-preview.html, hitblend.mjs, parallax.mjs,
coast.test.mjs, badwifi.mjs and smooth.mjs must still run.

Full list after this work:
`setCourt(c) setSide(side) setViewer(v) setView(name, side) getView() setMenu(on) startAttract() stopAttract()
setFrozen(on) updatePaddle(side, d) updateBall(p, v, live, tMs, spin, m) hideBall() onEvent(m) unlockAudio()
render(nowMs) resize() _dbg`

### 2.1 Modes, and which one wins
The scene has three independent switches. Camera choice, top to bottom, first match wins:
1. `menu` on -> menu camera (2.4).
2. spectator (`setSide(null)`) -> the current view: `broadcast` | `split` | `pov` | `free`.
3. seated (`setSide(0|1)`) -> `play`, today's head-coupled camera, untouched.
Changing view is a cut. Leaving the menu camera is an ease (2.4).

### 2.2 `setSide(side)`
- `0 | 1`: exactly today (clock reset, fences, pads re-init). Also forces view `play` and leaves spectator mode.
- `null` (strictly `side === null`; anything else that is not 1 still means side 0, as today): **spectator**. Both paddles are remote: both avatars drawn, no ghost forearm, both smoothed like today's far
  paddle. `clock.reset()` and pads re-init as for a seat. View becomes `broadcast` unless a spectator view is already set.
  In spectator mode: the landing marker is always white; `point` plays the winner chime for either side; hit shake is
  the "not mine" strength (x0.55) for both sides and is OFF in `split` and `free`; `whiff` is silent; audio pan may be
  centred (0). Scenery's `side()` callback reports 0. `setViewer()` is ignored.

### 2.3 `setView(name, side = 0)` -> `{ name, side }` and `getView()` -> `{ name, side }`
Honoured only in spectator mode (a seated player always gets `{ name:'play', side }` back). Unknown name: no change.
`side` matters only for `pov`. MAIN does the "press 3 again flips" logic: `const v = scene.getView(); scene.setView('pov', v.name === 'pov' ? 1 - v.side : 0)`.
- **`broadcast`** (spectator default): side-on, from beyond a net post, elevated, both players in frame.
  Side 0 (+z) MUST be on screen LEFT, because the spectator scoreboard has side 0 on the left. That puts the eye on
  the +x side looking toward -x: start from eye `(halfW + 10, 5.5, 0)`, target `(0, 0.8, 0)`, fov 38, and widen the fov
  on narrow windows until z = +-(halfL + 2) is inside the frame. A slow +-0.3 m drift along z is welcome, shake at the
  spectator strength. Any side wall or fence between this eye and the court is hidden in this view.
- **`split`**: two viewports, ONE scene, one `render()` call. Left half = side 0's point of view, right half = side 1's.
  `renderer.setScissorTest(true)`; per half `setViewport/setScissor(x, 0, w/2, h)`, camera aspect `(w/2)/h` (so the
  tall-window fov rule of `resize()` applies to the half), pose = that side's `pov` camera, then
  `renderer.render`. Before each pass set what that player would see: `backFence[i]` hidden, side i's avatar hidden
  and its ghost forearm shown, the other side's avatar shown. Trail and rings face the pass's camera (recompute the
  camera-facing bits per pass or accept the left camera's, your call; say which). `scenery.update` runs once per
  frame, with the left camera. Scissor test off again afterwards. The divider line and the labels are UI's (DOM).
- **`pov`** (`side` 0|1): behind that player exactly as they see it: today's play pose for that side with the
  paddle-follow offset (the `me.has` branch of `updateCamera`, fed from `pads[side]`), no `setViewer` input, that
  side's back fence hidden, that side's avatar hidden and ghost forearm shown. Shake at "mine" strength for that side.
- **`free`**: orbit around `(0, 0.9, 0)`. Drag = yaw / pitch, wheel = zoom. Defaults yaw 35 deg off the +x axis, pitch
  25 deg, distance 17 m. Clamps: pitch 6..80 deg, distance 6..30 m, eye y >= 1.2 m, and the eye never sits within
  0.6 m of a fence or wall plane (push it outward). A fence panel between the eye and the court centre is hidden.
  Orbit state survives view changes (coming back to `free` is where you left it).
  **Input**: SCENE owns it. In `createScene`, once: `pointerdown / pointermove / pointerup / pointercancel` (with
  `setPointerCapture`) and `wheel` (`{ passive:false }`, `preventDefault`) on `renderer.domElement`, acting ONLY while
  the view is `free` and menu is off; `renderer.domElement.style.touchAction = 'none'` only in that state. 0.25 deg
  per px, wheel zoom `dist *= exp(deltaY * 0.0012)`. MAIN forwards nothing. UI guarantees that during spectating no
  full-window element with pointer events lies over `#stage` (`#hud` has no box; chips and buttons are small).
  MAIN's global `pointerdown -> play()` is harmless (it returns unless phase is title).

### 2.4 `setMenu(on)`: the menu camera and the cheap mode (NEXT 11, 12)
(Added by the fixer: `setDim(on)` is the same cheap picture, half pixel ratio, 30 fps, shadow map as it stands, WITHOUT the menu camera. MAIN turns it on while a match against Matt is paused behind the open settings card, i.e. behind the full blur, and off on resume. Also new on the scene side: a `launch` event may carry `n` and `kind` (a re-aim after the settled swing report: the trail follows `n`, a smash's effects fire on `kind: 'smash'`); split screen stacks the two views when the window is taller than wide; the free camera's target slides along the court, right-drag / shift-drag / arrow keys, and its leash shortens as it gets low: 16 m at 6 degrees, 30 m from 20.)
MAIN calls `setMenu(true)` whenever a menu screen covers the court (title, lobby, connect, calibrate) and
`setMenu(false)` the moment the court opens. Idempotent.
- on: **menu camera**: eye about `(0, 3.4, s*(halfL + 7))`, level gaze (target at eye height, toward the far
  baseline), fov ~60, `s` = the seated side's sign, or side 0 when spectating / attract / nobody seated (side 0 looks
  north at the hills: see test/ui-shots/scenery/final-menu0.png). The slow drift is built in here
  (`sin(t/5.2 s) * 0.9 m` sideways, a little vertical), OFF under `prefers-reduced-motion`. `setViewer()` is ignored
  while on. The back fence behind the eye is hidden.
- on: **cheap**: pixel ratio = half of normal (`min(dpr, 2) / 2`; `resize()` must respect this), 30 fps
  (`render()` returns `false` without drawing when less than 30 ms have passed since the last drawn frame; `dt`
  is measured between DRAWN frames), shadow map frozen (`renderer.shadowMap.autoUpdate = false` after ONE update made
  with the players and the ball hidden from the shadow pass, so no ghost shadow of a moving avatar is baked in; the
  ball's blob stays), fx pools idle (no rings, bursts, flash, shake, marker), scenery update still runs.
- off: pixel ratio, 60 fps, `shadowMap.autoUpdate = true` (+ `needsUpdate`), all restored at once; the camera eases
  from the menu pose to the active camera over ~0.8 s (position + look target + fov, smoothstep). Only this one ease.
- Always, menu or not: `render()` returns `false` and draws nothing while `document.visibilityState === 'hidden'`.
- `render(nowMs)` now returns a boolean (`true` = a frame was drawn). Callers may ignore it.

### 2.5 `startAttract()` / `stopAttract()` (NEXT 11). Both idempotent.
- start: the scene plays an endless rally by itself: side 1 = Matt (2.7), side 0 = a generic player in today's
  colours. Both are drawn as far players (avatar, no ghost forearm) and swing with the existing canned bot swing
  (`SWING`, `startSwing`). Internally "uses the bot animation" and "looks like Matt" are two flags (`pd.bot`,
  `pd.matt`); only side 1 has the second.
  Rally: every shot is solved to land in (keep 0.4 m inside the lines, clear the net by >= 0.25 m), flight is the
  closed form `coast()` from the last contact, one bounce, the receiver always runs there in time and hits at a
  comfortable height. Mix drive / soft / lob-ish arcs (flight time about 0.75 / 1.1 / 1.6 s), left / right and depth
  from a seeded `rng()` so the loop never reads as a loop; a little spin now and then so the trail changes tint.
  NO score, serve ritual, points, win, sounds, shake, rings, bursts, flash or landing marker. Ball + trail + blob only.
  It needs no audio unlock and must not create the AudioContext.
- While attract is on, `updateBall / updatePaddle / onEvent / hideBall` from outside are IGNORED (belt and braces for
  MAIN's guard, 4.2). `setCourt` still works.
- stop: ball, trail, blob hidden (`hideBall`), both pads `has = false`, swings reset, `clock.reset()`. The next
  `welcome` / `state` from MAIN then draws the real match from nothing.
- Attract does not depend on menu mode, but MAIN only runs it with `setMenu(true)`.

### 2.6 `setFrozen(on)`: pause and seat hold (NEXT 7). Idempotent; MAIN may call it on every state packet.
- on: the ball is drawn exactly where it is on this frame and stays there: age forced to 0, no `coast / coastTo /
  hover`, no blend, the trail stops taking points, the spin swirl stops. Packets still update `ball.p / v` silently
  (they are identical while the server is paused). Avatars keep idling; bot swing wind-up does not start.
- off: `clock.reset()` (the server's `t` stood still while wall time ran: a stale minimum would age every packet by
  the length of the pause and the ball would leap), `ball.snap = true`, and the next packet is the truth.
- `updateBall` does NOT read `m.paused`. MAIN is the single switch: `scene.setFrozen(!!m.paused || holding)`.

### 2.7 Matt (NEXT 10): how the scene knows
`updatePaddle(side, d)` with **`d.bot === true` means "this is Matt"**, at every level. No new field. The scene swaps
that pad's look when `bot` changes (recolour the materials or keep two avatars, your call): deep brown skin `0x6b4226`
(lighter `0x7a4e2d` if you shade), short black hair `0x111114`, orange shirt `0xf5821f`; the hand sphere and the
sleeve follow. Same friendly proportions and face. `bot:false` = today's per-side colours, unchanged. In attract,
side 1 is Matt and side 0 is generic without MAIN saying anything.

### 2.8 Ball emissive (NEXT 12). No API.
Raise the ball material's emissive (today `0x6a7400` at 0.35) until the shaded face no longer goes dark from side 0
and the lit face stays clearly lighter than the low sky. Measure with screenshots from both ends, against the low
sky, the ficus band and the court; target >= 1.6 : 1 luminance in the worst case, trail colours not blown out.
Report the numbers. `_dbg` gains `ballMesh` so a test can read the material.

### 2.9 Hit hiss by spin (NEXT 3b). No API: `hit.spin` already arrives.
Today: `if (m.spin > 0.5) noise(..., 0.16, ...)`. New: silent below spin 0.12, above that gain `0.2 * spin^1.5`
(0.5 -> 0.07, 0.8 -> 0.14, 1 -> 0.2). The blue ring / spark tint stays gated at `spin > 0.5`.

### 2.10 `_dbg` (tests only) gains
`view()` -> `{ name, side, menu, attract, frozen, spectator, pixelRatio, drawn }` (`drawn` = frames actually drawn),
`free` -> `{ yaw, pitch, dist }` (writable), `ballMesh`. Existing keys stay.

---------------------------------------------------------------------------------------------------------------------
## 3. UI API (web/ui.js + web/index.html + web/ui.css). MAIN is the only caller.

Kept exactly: `SHOTS shotName showScreen showOverlay currentScreen currentOverlay setNames setScore setServe setRally
callout toast toastOff confetti setStatus setLink setServerAddress calibrationReset calibration setMode toggle
setCamera isVisible setStat fullscreen wake onStart onRetry cleanCode onLobby lobbyView lobbyRooms lobbyBusy lobbyLink
codeError setRoom titleRoom`. Changed but backward compatible: `pointBanner matchResult setStatus setRoom lobbyRooms
onLobby lobbyView`. New: `show playerName askWatch asking onSettings settings setSettings setPaused setSpectator
setWatchers onView setView onRematch rematch hold`.
The markup stays between `<!-- UI:BEGIN -->` and `<!-- UI:END -->` (test/ui-mock.html loads it from there).
ids that tests and MAIN read and that must survive: `hud board name-me sub-me name-them sub-them sc-me sc-them sv-me
sv-them rally banner banner-text callout dev m g pw px py pkmax sw pkavg pklist ping netq nethz keys mode camwrap camv
camc podwrap pod toast glass room-pill room-code btn-start btn-quick btn-create btn-code room-list room-empty result
result-title tally-* screen-* row-airpod row-game row-camera (+ -text, -state) downurl down-lan down-net btn-retry`.
Removed: `lights st-airpod st-game st-camera key-leave`, the B / 1 2 3 / R / [ ] / V / H / F / Q key hints, `.next-up`.

### 3.1 HUD corner, key hints, status (NEXT 6, 8)
- `#corner` (top-left, where `#lights` was, same wrap rule so it never runs under the scoreboard) holds, in order:
  `button#btn-menu` (hamburger, `aria-label="Settings"`, `aria-expanded`), `button#room-pill` > `b#room-code` (as
  today: hidden without a room, click copies the link), `span#watch-tag` ("Watching"), `span#watchers` > `b#watch-n`
  (eye glyph + number, `aria-label` "N watching"), `span#paused-tag` ("Paused").
  `#btn-menu` is part of the HUD: visible in play and while watching, gone under menu screens and overlays like the rest.
  `#dev` (stats) keeps its place under the corner.
- `#keys.keyhints`: bottom-RIGHT, exactly two items, `[C] Calibrate` and `[M] Move: <span id="mode">`. No bar, no
  plate, no border: white keycaps (white fill or outline) + white label with a soft text shadow, readable over grass
  and over the blue court. Keeps `wake()` / `.is-idle` (6 s) and yields to `body.has-toast`. Hidden for spectators.
- `setStatus(next)`: same input. Writes to `row-<key>*` (connect screen) and `set-<key>` + `set-<key>-state` (settings
  rows) when they exist; every element is optional. No `#lights`, no `all-ok`. The 1.5 s "AirPod signal lost" /
  "Reconnecting to the game" toasts stay.
- `setRoom(code, link = '')`: as today minus `#key-leave`.
- `show(id, on)` -> boolean: `el.hidden = !on`. (`toggle(id)` stays.) Null-safe.

### 3.2 Settings panel (NEXT 6, 7, 8)
`div#settings.panel` (a Wii-style card, NOT a `.screen`: `showScreen / showOverlay / currentOverlay` do not know it,
so `inPlay()` in main.js stays true and play continues behind it). Compact, anchored under the hamburger, translucent
enough that a live rally is visible behind it. While open: `body.dataset.settings = 'open'`. It must sit above
`.glass` (z `--z-screen` - 1), because paused + open shows the glass blur behind it:
`body[data-settings][data-paused] .glass{opacity:1;visibility:visible}`.
- `onSettings(h)`: `h = { open(), close(), sens(dir), airpod(on), stats(on), recenter(), leave() }`. `dir` is -1 | +1.
  `open` / `close` fire once per real change, whoever caused it (hamburger click, click outside, `settings()` call).
- `settings(open)`: no argument -> boolean "is it open". `true | false` opens / closes (fires the callback).
  UI handles: hamburger click toggles, pointerdown outside closes, focus moves into the panel and back to `#btn-menu`.
  UI does NOT listen for Esc here: MAIN's keydown owns Esc (`ui.settings(!ui.settings())` in play / watch).
  `showScreen(<any menu>)` and `showOverlay('match')` close it (callback fires).
- `setSettings(partial)`: any subset of
  `{ sens: number, sensMin: bool, sensMax: bool, airpod: bool, stats: bool, inRoom: bool, canPause: bool, spectator: bool }`.
  `sens` is a whole level MAIN computes (1 = least sensitive); `sensMin / sensMax` disable the - / + button.
  `inRoom` shows the Leave room row. `canPause === false` shows the note row. `spectator` hides Sensitivity,
  Show AirPod, Re-center and the AirPod and Camera status rows.
- Rows, top to bottom (ids): title `#set-title` ("Settings", or "Paused" while `body[data-paused]`);
  `#set-sens`: label + `button#btn-sens-less` + `b#set-sens-val` + `button#btn-sens-more`;
  `button#tog-airpod` and `button#tog-stats` (`role="switch"`, `aria-checked`);
  `button#btn-recenter`; `button#tog-full` (`role="switch"`; UI owns this one completely: it calls its own
  `fullscreen()` and follows `fullscreenchange`); `button#btn-leave-room`;
  status rows `#set-airpod` `#set-game` `#set-camera` (light + name + `em#set-<key>-state` state word, classes
  `is-ok | is-wait | is-bad | is-off` like the connect rows); note `p#set-note`.
  UI flips nothing but full screen by itself: a click on a toggle calls the handler with the NEW value and MAIN
  answers with `setSettings`.
- `setPaused(on)`: `body.dataset.paused` set / removed. Effects are CSS: title reads "Paused", the glass blur shows
  while the panel is open, `#paused-tag` shows while the panel is closed (spectators, mostly).

### 3.3 Lobby (NEXT 6, 9, 10)
- Name: `div#name-row` > `label` "Name" + `input#name-input` (`maxlength="12"`, `autocomplete="off"`,
  `spellcheck="false"`), at the top of the lobby body, shown on the views `home`, `create`, `code`, `bot`; hidden on `share`.
  Prefilled from `localStorage['poddle.name']` (try/catch); UI saves it on every change. It is not one of the four
  code boxes: the code form's `input` / `paste` handlers must not swallow it.
  `playerName()` -> the cleaned value: control characters and `<` `>` stripped, spaces collapsed, trimmed, first 12.
  May be `''`. **Required**: when empty, a click on any seat action (Quick play, Create, Join, Watch, a room row, a bot
  level) does not fire its handler: the field shakes (`is-error`, as the code boxes do) and takes focus. Enter in the
  field moves focus to `#btn-quick`. (main.js already ignores game keys while an INPUT has focus.)
- `onLobby(h)` gains two handlers: `watch(code)` and `bot(level)` (0 | 1 | 2). The rest keep their signatures:
  `quick() create(isPublic) join(code) start() back() copied()`. Handlers carry no name: MAIN reads `playerName()`.
- Tiles: a 4th `button#btn-bot.tile[data-nav]` "Play a bot" after Enter code. Four across at 1280x720, 2 x 2 at 600x900.
  It opens `lobbyView('bot')`: `div#lobby-bot.lobby-view[data-view="bot"]` with three big buttons
  `button.btn.btn-lg[data-level="0|1|2"]` (ids `btn-bot-0..2`) "Rookie" "Club" "Pro"; a click fires `on.bot(level)` at
  once (no second confirm). `VIEW_TITLE.bot = 'Play a bot'`. First focus: Club. Left / Right walk the three.
- `lobbyRooms(rooms, online)`: rooms are now `{ code, players, open, watch, watchers, score:[a,b], live }`; old-shape
  entries (`{ code, players, open }`) still render. Heading "Rooms". One `li` per room:
  `button.room-row[data-code][data-nav]` when `open` (click -> `on.join(code)`, as today) or `div.room-row.is-full[data-code]`
  when not; inside: `b` code + `span` state ("1 player" when open, else the score "7-4"; add "N watching" when
  `watchers > 0`); then, when `watch > 0` and `players > 0`, `button.btn.btn-sm.room-watch[data-watch=CODE][data-nav]`
  "Watch" (click -> `on.watch(code)`). The change key must include open, score, watchers and watch, and focus must
  survive a re-render as it does today. Still at most 12 rows.
- Watch prompt: `askWatch(code)` opens `div#ask-watch.panel.notice` over the lobby: "Court is full. Watch instead?" +
  `button#btn-watch-yes` "Yes" (focused; fires `on.watch(code)`) + `button#btn-watch-no` "No". Either button closes it.
  `askWatch(null)` closes it. `asking()` -> boolean. MAIN's Esc handler checks `asking()` first. Leaving the lobby
  screen closes it.

### 3.4 Spectator HUD and view chips (NEXT 9)
- `setSpectator(on)`: `body.dataset.role = 'spectator'` / removed. CSS effects: `#watch-tag` shown; `#keys`,
  `#podwrap`, `#camwrap` hidden; `#views` shown. The scoreboard is reused: MAIN puts side 0 in the `me` (left, blue)
  slot and side 1 in the `them` (right, orange) slot, names in both, never "You".
- `setWatchers(n)`: `#watchers` shown when `n > 0` (players see it too), `#watch-n` = n.
- `div#views` (bottom-left): four `button.view-chip[data-view="broadcast|split|pov|free"]`, each a keycap
  `1 2 3 4` + label "Broadcast" "Split" "Player" "Free". `onView(fn)`: a click calls `fn(name)`; clicking the active
  `pov` chip calls it again (MAIN flips the side). `setView(name, who = '')`: marks the active chip
  (`aria-pressed`), sets `body.dataset.view = name`, and for `pov` shows `who` after the label via textContent
  ("Player: Daniel"). Chips fade with the key hints (`wake()`), and never sit under a toast.
- Split dressing is CSS on `body[data-view="split"]`: a 2 px white centre line (`#split-line`), nothing else.

### 3.5 Who did what: banner, serve, result, rematch, hold (NEXT 9, 10)
- `pointBanner(won, name = '', side)`: `won === true` -> "Your point" (blue). `won === false` -> `"<name> scores"`
  (orange), or "Their point" when no name is given (old callers). `won == null` (spectator) -> `"<name> scores"`,
  blue when `side === 0`, orange when 1.
- `setServe('me' | 'them' | null)`: unchanged (the dot beside the name). Spectators: MAIN maps side 0 -> 'me'.
- `matchResult(o)` with `o = { won, me, them, nameMe = 'You', nameThem, forfeit = false, role = 'player', vote = true }`
  (`me` / `them` = the two scores, left and right). The old positional call `matchResult(won, me, them, name)` still
  works (test/e2e.mjs uses it) and means `{ role:'player', vote:false }`.
  Title `#result-title`: player won -> "You win!"; player lost -> `"<nameThem> wins"`; spectator -> `"<winner's name> wins"`
  (`won` = the left side won). Medal gold for a player's win and for spectators, silver for a player's loss.
  `p#result-note`: when `forfeit` -> `"<loser's name> left"`, else empty.
  `div#rematch` replaces `.next-up`: `button#btn-rematch.btn` "Rematch", `button#btn-leave.btn` "Leave",
  `p#rematch-note`, a countdown bar `#rematch-bar` and `b#rematch-left` (seconds, a bare number).
  `role:'spectator'` -> no buttons, note "Waiting for a rematch". `vote:false` with role player (legacy room) -> no
  buttons, note "Rematch starting". Opens the `match` overlay as today. Focus lands on Rematch.
- `onRematch(fn)`: Rematch -> `fn(true)`, Leave -> `fn(false)`. After a click both buttons disable and the chosen
  one keeps a pressed look.
- `rematch({ mine, theirs, left, name })` (each `true | false | null`; any key may be missing = unchanged):
  note: `theirs === true` -> `"<name> wants a rematch"`; `theirs == null && mine === true` -> `"Waiting for <name>"`;
  `theirs === false` -> `"<name> left"`; otherwise empty. Spectators: the note stays "Waiting for a rematch".
  `left` restarts UI's own 1 s ticker from that number (the server only speaks when a vote changes); the bar drains
  from the first `left` it was given. `showOverlay(null)` (MAIN, on `rematchon` / `closed`) stops the ticker.
- `hold(name, left)`: `div#hold` (a small centred card over the live court, no veil, above the HUD, under menu
  screens): "Waiting for <name>" + `b#hold-left` (seconds). Called once a second by MAIN with the server's number; UI
  draws what it is given. `hold(null)` hides it. Also hidden by `showOverlay('match')`.
- `setNames()`: unchanged. MAIN passes real names; Matt's `themSub` is his level ("Club").

---------------------------------------------------------------------------------------------------------------------
## 4. MESSAGES (web/main.js <-> server/game.js)

### 4.1 Protocol ADDENDA to docs/SPECTATE.md (SERVER builds, MAIN relies on; all additive)
- A1 `state.paused: true` whenever room time is stopped, by `pause` OR by a seat hold. Absent otherwise.
- A2 Time is per room: `state.t` and `hit.t` are ROOM time and stand still while paused / held. (Today `now` is one
  global clock; pause cannot work on that.) The client resets its clock offset on `welcome` and on resume.
- A3 `names` entries: a human's clean name, `'Matt'` for the bot, `null` for an empty seat. `botinfo` is unchanged
  (`name` stays the LEVEL name Rookie / Club / Pro: test/bot.test.mjs reads it, and MAIN shows it under "Matt").
- A4 The socket URL may carry `&name=<urlencoded>`; sanitised like the message field. It names a seat taken by URL
  (`room=CODE`, a reconnect whose old seat is already gone). A seat taken over by `cid` keeps its name.
- A5 Room `LOCAL` (no `lobby=1`): names default to Player 1 / Player 2; `matchover` with `rematchBy: 5`, then
  `rematchon` and a new match after 5 s whatever the votes; never `closed`, never deleted. Pause works there too.
- A6 `hold.left`, `rematch.left`, `matchover.rematchBy` are whole seconds. `closed.reason` is `'norematch' | 'empty'`.
- A7 `match` (the old end-of-match message) is retired: `matchover` replaces it. `point.final` stays.
- A8 `paused.by` is the pauser's side. A `{type:'bot', level}` right after `welcome` seats Matt at once at that level (as today).

### 4.2 The guard (NEXT 11)
`seated = () => !LOBBY || !!room`. In the game socket's handler, after `lobby`, `room`, `joinfail`, `pong` and `closed`
have been dealt with: **`if (!seated()) return;`** Nothing else gets through while no room is joined: no `welcome`
(side, court), no `state` (score, names, ball, paddles), no `point / matchover / hit / serve`, no toast, no sound, no
`scene.onEvent`. An old server that seats a lobby socket by itself is thereby ignored completely.
Second gate, for things the player would SEE or HEAR over a menu: `live = () => (phase === 'play' || phase === 'watch')`.
Toasts, banners, callouts, confetti, the result overlay and the hold card need `live()`. A `matchover` that arrives
while `!live()` (mid-calibration) is kept and shown on entering play, unless `rematchon` / `closed` came first.
`scene.onEvent(m)` needs `seated()` only (the opaque set-up screens hide the court; the serve waits for them anyway).

### 4.3 Server -> client
`role` = 'player' | 'spectator' (from `room.role`, default 'player'). `me` = my side (players). `nameOf(i) = names[i] || (i ? 'Player 2' : 'Player 1')`.

| message | honoured when | MAIN does |
|---|---|---|
| `lobby {rooms, online}` | LOBBY, always | `ui.lobbyRooms(rooms, online)` |
| `room {code, public, role}` | LOBBY, always | `settle()`; `room`, `role`; `ui.setRoom(code, shareLink)`; URL `?room=CODE` (+ `&watch=1` for a spectator); `scene.stopAttract()`. Player: create -> share view, Play a bot / quick / join -> `begin()`. Spectator: `enterWatch()`. Same code again = a reconnect: stay where you are |
| `joinfail {reason, watch, code}` | LOBBY, always | `full` + `watch:true` -> `ui.askWatch(code)`. `full` + no watch -> "Court is full". A failed `watch`: `busy` -> "Too many watching", `notfound` -> "Room not found". Rest as today. While `room` is set -> `toLobby('Room closed')` |
| `closed {reason}` | LOBBY, always | `toLobby(reason === 'norematch' ? 'No rematch' : 'Room closed')`. Legacy page: `ui.showOverlay(null)` only |
| `pong` | always | `net.pong(m)` |
| `full` | legacy | `ui.showOverlay('game-full')` |
| `welcome {side, role, court, names}` | seated | `side`; `names`; `scene.setCourt`; `scene.setSide(role === 'spectator' ? null : side)`; spectator: the saved view through the same function as the chips (4.5); Play a bot pending -> send `bot`; `?autobot=1` as today; `net.rejoined()`; `ui.setSpectator(...)`; `ui.setSettings({ inRoom, spectator })`; redraw names |
| `names {names}` | seated | keep; redraw the scoreboard; if `live()` and a human name appeared in the other seat -> toast "<name> joined" |
| `state` | seated | `frozen = !!m.paused`; `scene.setFrozen(frozen \|\| holding)`; `scene.updateBall(...)`; `net.packet()` unless frozen; `ui.setWatchers(m.watchers \| 0)`. Player: score mine / theirs, opponent paddle -> `scene.updatePaddle(1 - me, {..., bot})`, `wait` -> "Setting up", `serveCoach` when `live()`; self-heal: `m.paused && !ui.settings()` -> send `pause` off. Spectator: `ui.setScore(score[0], score[1])`, BOTH paddles to the scene, `bot` from the packet |
| `botinfo {active, level, name, reason}` | seated | `botLevel = name`; Matt's sub line; `live()`: toast "Matt · <level>" when it changed, or the two-players refusal as today |
| `serve {by, wait}` | seated | rally 0; `ui.setServe`; `live()` + my serve + `wait` -> "Your serve!"; `scene.onEvent` |
| `hit` `swung` `bounce` `launch` `whiff` | seated | stats + rally as today; `scene.onEvent` |
| `point {winner, final}` | seated | not `final` and `live()`: player -> `ui.pointBanner(winner === me, nameOf(winner))` + confetti when mine; spectator -> `ui.pointBanner(null, nameOf(winner), winner)`; `scene.onEvent` |
| `matchover {winner, score, forfeit, rematchBy}` | seated; drawn when `live()` | `ui.setServe(null)`; `ui.hold(null)`; `ui.settings(false)`; `ui.matchResult({...})` then `ui.rematch({ mine:null, theirs:null, left: rematchBy, name })`; confetti for a player's win. Legacy page: `vote:false` |
| `rematch {votes, left}` | seated | `ui.rematch({ mine: votes[me], theirs: votes[1 - me], left, name: nameOf(1 - me) })`; spectator: `{ left }` only |
| `rematchon` | seated | `ui.showOverlay(null)`; rally 0; scores follow in `state` |
| `hold {side, left}` | seated | `holding = true`; `scene.setFrozen(true)`; `live()` -> `ui.hold(nameOf(side), left)` |
| `holdoff` | seated | `holding = false`; `ui.hold(null)`; frozen follows the next `state` |
| `paused {on, by, refused}` | seated | `refused` -> `ui.setSettings({ canPause:false })`. Else `ui.setPaused(on)`; `scene.setFrozen(on \|\| holding)` |
| `left` | seated | only before a match started now: clear the far side; `live()` -> toast "<name> left" |
| anything else | | ignored, no throw |

### 4.4 Client -> server
| message | when | fields |
|---|---|---|
| `quick` | Quick play | `{ type, name }` |
| `create` | Create; Play a bot | `{ type, public, name }`. Play a bot: `public:false`, remember the level, skip the share view, go to `begin()` |
| `bot` | right after the `welcome` that answers a Play a bot create; keys B / 1 2 3 (players, silent keys) | `{ type, level }` (no `level` = B: next level) |
| `join` | a room row, the code form, `?room=CODE` after Play | `{ type, code, name }` |
| `watch` | a Watch button, "Yes" on the prompt, `?room=CODE&watch=1` after Play | `{ type, code, name }`. One lobby request at a time (`request()`), like the others |
| `leave` | Q twice, settings "Leave room", Back on the set-up screens; a spectator's only exit | `{ type }`, then `toLobby()` |
| `swing` | every swing / swingFix once calibrated, players only, not while paused | `{ type, power, dir, lob (gated by turn, NEXT 2), chop, age, net: net.lag(), slice (continuous, NEXT 3b), fix }` |
| `paddle` | 20 Hz, players only, calibrated, in a room | as today |
| `pause` | settings panel opens -> `on:true`, closes -> `on:false`. Only when role is player and the other seat is Matt or empty (`state.paddles[1 - me]` is null or `bot`). Against a human send nothing and `ui.setSettings({ canPause:false })` | `{ type, on }` |
| `rematch` | result screen: Rematch -> `yes:true`, Leave -> `yes:false` (the server then closes the room for everyone; do not also send `leave`) | `{ type, yes }` |
| `ping` `net` | as today; the only two a spectator sends besides `leave` | as today |
Socket URL: `?cid=..&lobby=1[&room=CODE][&watch=1][&name=..]`; `room` / `watch` only on a reconnect while seated.

### 4.5 MAIN's flow
- Phases: `title -> lobby -> connect -> calibrate -> play`, plus **`watch`**: `lobby -> watch` directly (no AirPod, no
  bridge, no calibration, no webcam prompts). `inPlay()` stays play-only; `live()` covers both.
- One wrapper owns menu mode: `screen(name) { ui.showScreen(name); scene.setMenu(!!name); }` used everywhere
  `ui.showScreen` is called today.
- Page load: `scene.setMenu(true)`; with LOBBY also `scene.startAttract()`. `room` -> `scene.stopAttract()`.
  `toLobby()` -> `ui.setSpectator(false)`, `ui.hold(null)`, `ui.setPaused(false)`, `ui.settings(false)`, `holding = false`,
  `scene.setFrozen(false)`, `scene.setSide(0)`, `scene.startAttract()`, then today's clean-up.
- `play()` with `?room=CODE`: if `ui.playerName()` is empty, open the code view prefilled and let the player type a
  name and press Join; else join (or `watch` when `&watch=1`) at once.
- Keys. Esc: `ui.asking()` -> `ui.askWatch(null)`; phase play / watch -> `ui.settings(!ui.settings())`; else `back()`.
  Spectator: `1 2 3 4` = views (3 again flips), `F`, `H`, `Q Q`, Esc; nothing else. One function serves keys and
  chips (`ui.onView`): `scene.setView(...)`, then `ui.setView(v.name, v.name === 'pov' ? nameOf(v.side) : '')` with
  what the scene returned, then save `poddle.view`. A `names` change while in `pov` refreshes the chip. Player: every key of today still
  works and says nothing new: C, M, R, F, [ ], V, H, B, 1 2 3, P, Q. V and H also call `ui.setSettings`.
- Settings callbacks: `sens(dir)` = today's `]` / `[` code path; level shown = `(90 - sideDeg) / 5 + 1` (1..14) or, in
  Body mode, `round((0.42 - body.reach) / 0.03) + 1`. `airpod(on)` / `stats(on)` -> `ui.show('podwrap' | 'dev', on)`.
  `recenter()` = R. `leave()` = send `leave` + `toLobby()`.
- Persistence (try/catch, all MAIN's): `localStorage['poddle.settings'] = { airpod, stats, sideDeg, reach }`, applied
  at load; `localStorage['poddle.view'] = 'broadcast' | 'split' | 'pov' | 'free'`. UI owns `poddle.name`.
- Test hooks: `?uitest=1` also sets `window.__scene = scene`; `__stats` gains `phase`, `role`, `room` getters.

---------------------------------------------------------------------------------------------------------------------
## 5. Every new or changed player-facing string (final)

`<name>` is a player's name or Matt, set with textContent. Apostrophes are typographic (’), as in the rest of the UI.

| where | string | owner |
|---|---|---|
| lobby, name label | Name (the same word as the settings row) | UI |
| lobby, 4th tile and its view title | Play a bot | UI |
| bot view, three buttons | Rookie / Club / Pro | UI |
| lobby, list heading (was "Open rooms") | Rooms | UI |
| room row, waiting room | 1 player (unchanged) | UI |
| room row, full room | 7-4 (the live score, hyphen) | UI |
| room row, when watched | 2 watching | UI |
| room row button | Watch | UI |
| empty list (was "No open rooms...") | No rooms yet. Quick play starts one. | UI |
| watch prompt | Court is full. Watch instead? | UI |
| watch prompt buttons | Yes / No | UI |
| join failed, no place to watch either (was "Room is full") | Court is full | MAIN |
| watch failed, 8 already watching | Too many watching | MAIN |
| HUD key hints (all of them) | Calibrate / Move: Body (Auto, Aim) | UI |
| hamburger, accessible name | Settings | UI |
| settings title | Settings | UI |
| settings title while paused; HUD tag while paused | Paused | UI |
| settings rows | Sensitivity / Show AirPod / Show stats / Re-center / Full screen / Leave room | UI |
| sensitivity buttons, accessible names (glyphs are drawn) | Less / More | UI |
| settings status rows | AirPod / Game / Camera + Ready, Waiting, Problem, Off (unchanged words) | UI |
| settings note, against a human | Online games can’t pause | UI |
| spectator tag | Watching | UI |
| watcher count, accessible name | 2 watching | UI |
| view chips | Broadcast / Split / Player / Free | UI |
| pov chip with a name | Player: <name> | UI |
| point banner, mine | Your point (no exclamation mark except a win) | UI |
| point banner, theirs or spectating (was "Their point") | <name> scores | UI |
| result title | You win! (unchanged) / <name> wins | UI |
| result note, forfeit | <name> left | UI |
| result buttons | Rematch / Leave | UI |
| rematch note | <name> wants a rematch | UI |
| rematch note, I said yes | Waiting for <name> | UI |
| rematch note, spectator | Waiting for a rematch | UI |
| rematch note, legacy room | Rematch starting | UI |
| rematch countdown, hold countdown | 14 (a bare number) | UI |
| hold card | Waiting for <name> | UI |
| toast, second player sits down | <name> joined | MAIN |
| toast (was "Opponent left") | <name> left | MAIN |
| toast, bot level (was "Club Bot") | Matt · Club | MAIN |
| scoreboard, Matt's sub line | Club (the level) | MAIN |
| back in the lobby, nobody wanted another | No rematch | MAIN |
| back in the lobby, room gone (unchanged) | Room closed | MAIN |
| default names | Player 1 / Player 2 | SERVER (MAIN falls back to the same) |
| the bot | Matt | SERVER |
Gone: "Their point" (kept only as `pointBanner(false)` with no name), "Opponent left", "<level> Bot", "Room is full",
"Open rooms", "No open rooms. Quick play starts one.", eight of the ten old key hints, the three status pills.
Unchanged and still used: "B adds a bot" (legacy page only), "Setting up", "Near side" / "Far side", every serve and
connection toast.

---------------------------------------------------------------------------------------------------------------------
## 6. TEST PLAN. Ports: never 8080, 8787, 3000. Every page URL carries `&game=<own port>` (and `&bridge=<own port>`).

| owner | ports | adds | extends / keeps green | how it is proved |
|---|---|---|---|---|
| SERVER | 8700-8729 | (none; the cases go into the files on the right) | test/rooms.test.mjs (names + sanitising, watch / spectator cap / `joinfail full watch`, lobby list shape, `matchover` -> votes -> `rematchon` / `closed`, hold 15 s -> `holdoff` and -> forfeit, explicit leave = forfeit, pre-match leave = plain `left`, pause: bot room freezes `t` and ball for 1 s, human-vs-human refused, second human resumes, pauser drop resumes, hostile input on every new message), test/serve.test.mjs (NEXT 4's four cases), test/slice.test.mjs (new curve), test/kinds.mjs (new rules; expect about slice 27 %, smash 11 %), and unchanged: server.test, deep.test, kitchen.test, bot.test, coast.test, lagcomp, feel | each with `PORT` / `ROOMS_PORT` in range; report each file's real last line |
| SCENE | 8730-8759 | test/scene-next.mjs (serves the repo on 8730, drives test/scene-preview.html) | test/scene-preview.html gains `&spectate=1 &view=broadcast\|split\|pov\|free &pov=0\|1 &attract=1 &menu=1 &frozen=1 &matt=1`; hitblend.mjs, parallax.mjs, coast.test.mjs, badwifi.mjs, smooth.mjs still pass | screenshots LOOKED at: each view at 1280x720 and 600x900 (side 0 left in broadcast; split = two correct halves, fences per half); free cam drag + wheel through real puppeteer mouse events, clamps hold; attract runs 60 s with 0 misses, 0 AudioContext, `drawn` about 30 / s and half pixel ratio in menu, restored after `setMenu(false)`; frozen ball does not move for 2 s and does not leap on release; Matt next to a human avatar; ball contrast numbers from both ends |
| UI | 8760-8789 | test/ui-next.mjs (page on 8760, fake lobby on 8761 in the style of test/menu.mjs, `?uitest=1` -> `window.__ui`) | test/menu.mjs (four tiles, name field, new list rows; run with `MENU_PORT=8770`), test/ui-mock.html + test/ui-shots/shoot.mjs + verify.mjs (new states; `UI_PORT` in range) | every function of section 3 called through `window.__ui` with the CURRENT main.js loaded (so: nothing old may break), a hostile name (`<img src=x onerror=...>`) rendered as text everywhere a name goes; screenshots LOOKED at, 1280x720 and 600x900: key hints over grass and over court, hamburger + room code vs scoreboard, settings (live, paused + blur, spectator variant), lobby with 4 tiles + name + mixed room rows, watch prompt, spectator HUD + chips, result (player, voted, spectator), hold card |
| MAIN | 8790-8819 | test/next-main.mjs (page 8790, scripted fake game server 8791, dead bridge port 8792) | test/e2e.mjs, test/rooms-e2e.mjs, test/shots.mjs: fix what reads `#keys` text, `st-*`, `#lights`, "Player 2" names, the old result card (they need the merged tree to pass fully: say which lines you changed and what you could not run) | MAIN cannot see UI's or SCENE's new code yet, so next-main.mjs intercepts `/ui.js` and `/scene.js` (puppeteer `setRequestInterception`) and serves RECORDING STUBS that export exactly the names in sections 2 and 3 and push every call to `window.__calls`. Against the fake server assert: the guard (a fake that sends welcome / state / point / matchover to a lobby socket produces ZERO ui / scene calls other than lobby ones); every row of 4.3; every row of 4.4 with its fields (name present on quick / create / join / watch, `bot` level after the Play a bot welcome, `pause` on / off only against Matt, `rematch`, `watch`, reconnect URL); attract start / stop and `setMenu` follow the phases; persistence survives a reload. The unstubbed run belongs to the integrator: until the merge the real ui.js / scene.js lack the new exports, so do not paper over that with `?.` |

INTEGRATOR afterwards (not one of the four): runs everything on the merged tree, writes NOTES.md section 17, and owns any
mismatch between this file and what was built.

---------------------------------------------------------------------------------------------------------------------
## 7. AS BUILT: what the merged tree differs in (integrator; docs/NEXT.md 14 came after this contract)
- UI adds `setBot(level | null)`: Matt's level name, or null when the other seat is not Matt. It shows / hides the second key hint
  (`#key-bot`: `1 2 3 Difficulty: <level>`) and the settings row `#set-bot` ("Select difficulty", Rookie / Club / Pro). `setMode(name)`
  now marks the settings row `#set-move` (Body / Auto / Aim); `#mode` survives, hidden. `setSettings` takes `bodyOk` (false = Body
  disabled, "Body needs a camera"). `onSettings` gains `name(text)`, `move(mode)`, `bot(level)`. The M key hint and the M key are gone.
- Key hints stay bottom-RIGHT (the player's words in NEXT 6); NEXT 14d says "bottom-left", which is where the spectator chips are.
- SCENE: `updatePaddle(side, { ..., status })` with `'calibrating' | 'paused' | 'away' | null`: whiteout + tag. `_dbg.pads[n]` has
  `status`, `ghost` (0..1) and `tag` (the sprite) for tests. `setFrozen(false)` also restarts the ball's stamp. Free cam default yaw 20.
- MAIN: `soft()` is gone (a missing member throws again). Sends `{type:'status', cal}` when calibration starts and ends. Page URL
  `?court=`. Every player-facing "room" reads "court": Court closed, Court not found, No free courts. Try again soon.
- Strings changed from section 5: Create court, Your court, Court code, Courts (list heading), No courts yet. Quick play starts one.,
  Shows in the court list, Leave court, Joining court CODE, Select difficulty (+ Slow and forgiving / A fair match / Fast and
  accurate), Move, Calibrating (was Setting up), Paused, Reconnecting.

