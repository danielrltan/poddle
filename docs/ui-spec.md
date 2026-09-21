# Poddle UI spec

> Newer than parts of this file: docs/API-NEXT.md sections 3, 5 and 7. The three HUD status pills, `.next-up`, the ten key hints
> and the word "room" are gone: a hamburger + settings card top-left, `C Calibrate` and (against Matt) `1 2 3 Difficulty` bottom-right,
> spectator chips bottom-left, Rematch / Leave on the result card, a hold card, status tags in the 3D scene, "court" everywhere.

The look: a bright, airy, glossy-white living-room sports game. White and pale blue-grey panels with big radii, a thin
light-blue outline, soft shadows; pill buttons that glow and breathe when focused; pale striped menu grounds; rounded
friendly type in dark grey; a minimal HUD pushed to the edges; big outlined callouts that pop and fade. Everything is
original CSS/SVG. No third-party artwork, names or fonts other than the two open-licence families below.

| File | What it is |
|---|---|
| `web/ui.css` | The design system: tokens, components, keyframes. The only stylesheet the game page needs. |
| `web/ui.js` | Every DOM change for the HUD and the screens (ES module, no dependencies, no game logic). API in section 7. |
| `web/index.html` | The page. The UI markup sits between `<!-- UI:BEGIN -->` and `<!-- UI:END -->`. |
| `web/vendor/fonts/` | Vendored woff2 files + licence texts (works offline). |
| `test/ui-mock.html` | Mock of every state: `?screen=<name>`, `?screen=all` for a contact sheet, `&freeze=1` pauses animations at a representative frame. It has **no markup of its own**: it fetches `web/index.html`, injects the `UI:BEGIN…UI:END` block and drives it through the real `web/ui.js`, so it cannot drift from the game. Must be served over http. |
| `test/ui-shots/shoot.mjs` | `node test/ui-shots/shoot.mjs [screen ...]` — screenshots every state at 1440x900 and 1280x720 into `test/ui-shots/`, fails loudly on console errors, 404s, or any `[data-fit]` element leaving the viewport. Serves on port 8240 in-process and closes it. |
| `test/ui-shots/verify.mjs` | Live (unfrozen) behaviour checks on the mock: running animations on the HUD, no `backdrop-filter`, no monospace, callout timeline, score pop stays inside its tab, key strip idles after 6 s, toast above the veil, reduced-motion glow, calibration nudge replay. Port 8245. |
| `test/e2e.mjs` | Whole game headless; also saves `test/shots/ui-1-title.png … ui-8-match-result.png` and asserts the flow (`E2E_PORT=<base>` moves its four ports). |
| `test/ui-shots/*.png` | Reference renders of the mock. `contact-sheet.png` shows all states. `test/shots/ui-*.png` are the same moments in the real game. |

## 1. Typeface

**M PLUS Rounded 1c** (SIL OFL 1.1), weights 400/500/700/800/900, exposed as the family **`"Poddle Rounded"`**. Chosen
over Varela Round, Nunito and Quicksand after rendering real UI strings side by side: it is the only candidate with the
Japanese rounded-gothic construction (even stroke, squarish bowls, open apertures, single-storey feel at heavy weights)
that the reference era is built on, and it has a true Black cut for callouts.

**Nunito** (SIL OFL 1.1) 600/800 is vendored for exactly one character: the ellipsis `…` (U+2026). The M PLUS ellipsis
floats at mid-height. It is merged into the same family with `unicode-range`. Gotcha, already handled: composite faces only
merge when their descriptors match, so the Nunito faces are declared once per M PLUS weight (400, 500, 700, 800, 900).

Fallback stack (`--font`): `"Poddle Rounded", ui-rounded, "SF Pro Rounded", "Hiragino Maru Gothic ProN", "Arial Rounded MT Bold", "Nunito", "Varela Round", "Helvetica Neue", Arial, sans-serif`.
No monospace anywhere; numbers use `font-variant-numeric: tabular-nums`.

| Use | Weight | Token |
|---|---|---|
| Body, leads, notes | 500 | `--t-md` 1.0625rem, `--t-lg` 1.4375rem, `--t-sm` .9375rem |
| Labels in small caps | 700–800, tracking `--track-caps` .16em, uppercase | `--t-xs` .8125rem (HUD labels are floored: `max(var(--t-xs), 11px)`) |
| Headings, buttons, names | 700 (contrast comes from size, not weight) | `--t-xl` 1.875rem, `--t-2xl` 3rem |
| Score digits, result title, logo, callouts | 900 (tally digits 800) | `--t-score` 3.25rem, `--t-3xl` 3.5rem, `--t-callout` 4.5rem |

## 2. Scale

`html{font-size:clamp(10px, min(1.1806vw, 1.8889vh), 26px)}` → **17px at 1440x900, 13.6px at 1280x720**. Every size in
`ui.css` is in rem, so the whole interface scales like a game rendered at a fixed resolution. Never size UI in px — two exceptions: the
scan-line / stripe textures are in device pixels (rem-sized lines fall off the pixel grid and band), and small HUD labels carry an 11px floor.
A normal browser window is shorter than 900px, so the title's start button also requests full screen (and `F` toggles it).
(Do not put a `font:` shorthand on `html` — it overrides this. `ui.css` sets it on `body` only.)

## 3. Tokens (all on `:root`)

**Ink** (never pure black; all ≥ 4.5:1 on white except `-faint`) `--ink #555e67` · `--ink-strong #4b535b` · `--ink-soft #65717b` · `--ink-faint #a7b2bb`
**Grounds** `--white` · `--sky-1 #f6fafd` · `--sky-2 #eaf3f8` · `--sky-3 #d9e9f2` · `--sky-4 #c3dbe8`
**Outline blue** `--line #34beed` · `--line-deep #1a9fd0` · `--line-soft #a9e0f6` · `--line-faint #d6f0fa`
**You (blue)** `--me #3aa0ff` · `--me-deep #1670d8` · `--me-ink #1b63b8` · `--me-navy #0e3f8c` · `--me-tint #e3f1ff`
**Opponent (orange)** `--them #ff9440` · `--them-deep #e6561a` · `--them-ink #c4490f` · `--them-navy #8a2f06` · `--them-tint #fff0e2`
**Signals** `--good #3ecf72 / --good-deep #13803f` · `--warn #ffb534 / --warn-deep #a86400` · `--bad #ff6464 / --bad-deep #d23232` (the `-deep` values are text colours, ≥ 4.5:1 on white; lamp gradients use `--good-lamp #1fa353` / `--warn-lamp #e08d00`)
**Medals** `--gold-1..4` · `--silver-1..4` · **Ball** `--ball #e6f03c` · `--ball-deep #b9c916`
**Radii** `--r-xs .375rem` · `--r-sm .625rem` · `--r-md 1rem` · `--r-lg 1.5rem` · `--r-xl 2.25rem` · `--r-pill 999px`
**Shadows** short and tight — a hard 2–3px lower edge plus a small blur, never a wide floating-card haze: `--sh-1` hairline lift · `--sh-2` button/thumbnail · `--sh-3` panel · `--sh-hud` anything over the court · `--glow` focus halo · `--inner-hi` glossy inner highlight
**Textures** `--tex-scan` faint horizontal scan lines · `--tex-diag` diagonal stripes (bars, wells) · `--tex-vignette` · `--gloss`
**Spacing** `--s-1 .25` · `--s-2 .5` · `--s-3 .75` · `--s-4 1` · `--s-5 1.5` · `--s-6 2` · `--s-7 3` · `--s-8 4` (rem) · `--edge 1rem` (HUD to window edge)
**Motion** `--ease-out cubic-bezier(.22,1,.36,1)` · `--ease-soft cubic-bezier(.45,0,.25,1)` · `--ease-bounce cubic-bezier(.34,1.56,.64,1)` · `--d-fast 160ms` · `--d-med 320ms` · `--d-slow 600ms` · `--d-pulse 1600ms` · `--d-callout 1200ms` · `--d-banner 1900ms` · `--d-newgame 5000ms`
**Layers** `--z-hud 10` · `--z-banner 11` · `--z-callout 13` · `--z-toast 24` (above every screen) · `--z-veil 18` · `--z-screen 20` · `--z-confetti 22`

## 4. Components

State classes are always `is-*` (or `on` / `show` / `go` / `pop` for one-shot triggers, kept from the old page).

### Screen shell — `.screen`
`<section class="screen menu-bg|veil" data-screen="<name>" hidden>`. Fixed, full-window. `ui.js` removes `hidden`, adds `.is-active`
(320ms opacity fade; the `.panel`/`.result-card` inside plays `panel-in` 600ms) and puts `hidden` back 360ms after deactivating, so an
inactive screen is out of the render tree. `.screen:not(.is-active) *{animation:none!important}` stops anything ticking during the fade.
- `.menu-bg` — opaque pale grey-blue ground + 1px/4px scan lines + vignette, for title / connect / calibrate. Children: optional
  `header.menu-head` (5rem, centred `span.menu-title`), `div.menu-body` (centred column; on calibrate its first child is `ol.steps`),
  `footer.menu-foot` (4.5rem; left note, right `ul.keyhints-inline`).
- `.veil` — an overlay above the court for notice cards: scan lines over a .9-alpha white wash. **No `backdrop-filter` anywhere in the system.**
  `.veil.is-result` (match result) is a fully opaque diagonal-striped results ground.
`ui.js` mirrors the state on `<body>`: `data-screen="title|connect|calibrate|hud"` and `data-overlay="match|server-down|game-full"` (absent when none).
CSS uses these to park the insets over connect/calibrate and to fade the HUD chrome out under an overlay.

### Glossy panel — `.panel`
`div.panel` + width helper `.panel-wide` (64rem) / `.panel-mid` (50rem) / `.panel-narrow` (34rem) / `.panel-cal` (56rem column). Crisp 3px `--line` keyline,
3px white inner ring, pale grey-blue body with a white top sheen, short tight shadow. `.panel-sm` = compact (2px `--line-soft`, no sheen).
`.panel.is-error` = `--bad` outline + one 420ms sideways nudge (re-add the class to replay it). `.well` = recessed striped tray (illustration,
tally, icon discs).

### Pill button — `.btn`
`<button class="btn [btn-lg|btn-sm] [is-focus]">Label</button>`. Idle: two-zone glossy pill (bright top half, cooler grey lower half, soft break at mid-height), 3px `--line` outline.
`.is-focus`: halo (static .8 opacity base, so it survives reduced motion) pulses and the pill breathes 2.5%, period `--d-pulse`. Hover /
`:focus-visible`: steady halo. `:active` / `.is-pressed`: scale .955, pale blue fill. Exactly one `.is-focus` per screen.

### Key-cap chip — `.keycap`
`<span class="keycap">M</span>`. HUD strip: `div.keyhints#keys > ul > li > span.keycap + text` (no tip sentence; the Body Move toast carries it). The strip shows on a key press / pointer move and when the HUD first appears, idles after 6 s, is never woken by game events (points, serves), and fades out while a toast is up (`body.has-toast`).
The strip is help, not HUD: `ui.js` adds `.is-idle` (fade + .5rem drop, 500ms) six seconds after the last key press / pointer move / point, and
removes it on the next one. Max width 46vw so it never crosses the court's centre line. Menu footers: `ul.keyhints-inline`.

### Scoreboard — `.scoreboard`
```html
<div class="scoreboard" id="board">
  <div class="score-tab is-me"><span class="chip chip-me"></span>
    <span class="score-who"><b id="name-me">You</b><small id="sub-me"></small></span>
    <span class="serve-ind" id="sv-me"></span><span class="score-num" id="sc-me">0</span></div>
  <div class="rally"><small>Rally</small><b id="rally">0</b></div>
  <div class="score-tab is-them"><span class="chip chip-them"></span>
    <span class="score-who"><b id="name-them">Waiting</b><small id="sub-them"></small></span>
    <span class="serve-ind" id="sv-them"></span><span class="score-num" id="sc-them">0</span></div>
</div>
```
Two fixed-width tabs (17.5rem x 4.25rem, so the rally lozenge stays centred), flat colour underline, 3.25rem/900 digits — the score is the one
thing read from two metres. `.is-them` mirrors itself (row-reverse) — keep the same child order in both tabs. The sub-labels are **empty in
normal play** (`small:empty` collapses): they only carry "B adds a bot" while waiting outside a room, and "Near side"/"Far side" (or "Setting up" for an opponent still calibrating) in a two-human game.
Add `.pop` to `.score-num` / `#rally` when the value changes (450ms; the score pop peaks at 1.18 so a two-digit score stays inside the tab's
`overflow:hidden`; the rally has its own bigger `rally-pop`). `.serve-ind.on` shows the bobbing ball on the server's tab.
**Player chips** `.chip.chip-me|chip-them` (+ `.chip-sm`, `.chip-lg`): empty span, drawn in CSS.

### Point banner tag — `.banner-tag`
`<div class="banner-tag is-me|is-them" id="banner"><span id="banner-text">Your point!</span></div>`. Sits directly under the
scoreboard. Add `.show` to play (`--d-banner` 1900ms: drop in 0–17%, hold, lift out 84–100%; easing is per keyframe, the animation itself is
`linear`). Small on purpose; darker fills (`#2a86ea→#0f5cc0`, `#ee6c25→#c0400a`) so the white text passes contrast.

### Shot callout — `.callout`
`<div class="callout-layer"><div class="callout" id="callout" data-text="Smash">Smash</div></div>` — **`data-text` must equal
the text** (both layers are pseudo-elements that read it). Glossy colour-filled rounded letters (`::after`, gradient clipped to the text),
ONE clean white outline (`::before`, .3em stroke) with a single soft coloured drop shadow. No dark outlines. `.is-them` = orange variant
(not used today; only the local player's hits are called out).
**Position: `top:16%`** — the sky band under the banner tag. It must never sit over the paddle, the contact point, the net or the ball's
landing zone (it fires on the player's own hit). Add `.go` to play (`--d-callout` 1200ms, `linear` with per-keyframe easing: pop to 112% by
15%, settle by 33%, static and opaque ~400–940ms, then a 1rem rise and fade). `ui.js` restarts it so a fast volley replaces rather than
stacks, and removes `.go` on `animationend`.

### Toast — `.toast`
`<div class="toast" id="toast"></div>`; `.on` shows it (320ms fade + bounce-up), remove to hide. One at a time, bottom centre. Over the court (`body[data-screen="hud"]`) it sits at `bottom:var(--edge)`, in the apron under the near baseline — never on the court, the paddle or the serve ball; on a menu screen it floats above the footer (7.5rem). `max-width` keeps a long string inside the window (it wraps rather than clips). `ui.toast()` sets `body.has-toast` so the key strip yields the bottom band. Hidden while any overlay card is up (`body[data-overlay] .toast.on{opacity:0}`).

### Status lights — `.light`
`span.light` coloured by a state class on itself **or its parent**: `is-ok` green, `is-wait` amber blinking, `is-bad` red,
`is-off` grey. HUD: `div.status-lights#lights > span.status-pill.is-ok#st-airpod > span.light + "AirPod"` (also `#st-game`,
`#st-camera`). When all three are ok/off the row collapses to three quiet dots (`.status-lights.all-ok`). A problem changes **shape and fill**, not
just hue: `.is-bad` is a taller solid red pill with a white "!" lamp and its label back; `.is-wait` is cream. After 1.5 s of `bad` during play
`ui.js` also raises a toast ("AirPod signal lost" / "Reconnecting to the game…"). Connect screen: `ul.status-list > li.status-row.is-wait#row-airpod > span.light.light-lg + b.status-name +
span.status-text#row-airpod-text + em.status-state` (also `row-game`, `row-camera`).

### Inset frame — `.inset`
`<div class="inset inset-cam" id="camwrap"><canvas id="camc" width="240" height="135"></canvas></div>` (top right, 15.6rem)
and `<div class="inset inset-pod" id="podwrap"><div id="pod"></div></div>` (9rem, stacked directly under the webcam frame on the right wall: `top:calc(var(--edge) + 9.25rem + .5rem)`, or `top:var(--edge)` when `#camwrap` is `[hidden]`. It must never sit in the bottom band: at 16:10 the near-right court corner is there). The frame forces any
canvas inside to `width:100%;height:auto` (with `!important`, because three.js writes inline px sizes), so the canvases keep
their own pixel buffers and just scale. No captions. The insets live **outside `#hud`** because they are live feedback during set-up too:
`body[data-screen="connect"]` parks the camera bottom-right above the footer; `body[data-screen="calibrate"]` parks the camera bottom-right and
the 3D AirPod bottom-left (both clear of the 56rem card); on the title and under overlays they fade out.

### Calibration progress — `.cal-bar` + `.cal-count`
```html
<div class="cal-progress">
  <div class="cal-bar" id="cal-bar" style="--p:.62"><i></i></div>
  <span class="cal-count" id="cal-count"><b id="cal-num">5</b><svg id="cal-up" hidden>…</svg><svg id="cal-check" hidden>…</svg></span>
</div>
```
One glossy horizontal pill, driven by `--p` (0–1) only, plus a round badge: **seconds left** while holding (5 → 1; back to 5 after a mistake),
an **up arrow** while tipping, **nothing** while settling (the bar alone counts; a tick would read as finished), a **tick** (with a small pop) only when done. The bar and the badge follow the same held error flag as the headline: for 1.4 s after a mistake the bar is empty and red and the badge shows a red 5. No percentages anywhere. `.is-bad` = red, `.is-done` = green.

### Step indicator — `.steps`
`<ol class="steps" id="steps">` — centred, first child of the calibrate screen's `.menu-body`, directly above the card. `li` states: none (upcoming),
`.is-on` (current), `.is-done` (green).

### Result card / medal — `.result-card`
```html
<section class="screen veil is-result" id="screen-match" data-screen="match"><div class="result-card [is-lose]" id="result">
  <div class="medal is-gold|is-silver" id="medal"><div class="medal-disc"><svg viewBox="0 0 48 48"><path d="M24 4l6.2 12.6 13.8 2-10 9.8 2.4 13.8L24 35.6 11.6 42.2 14 28.4 4 18.6l13.8-2Z"/></svg></div></div>
  <h1 id="result-title">You win!</h1>
  <div class="tally well">
    <div class="tally-side [is-winner]" id="tally-me"><span class="chip chip-me chip-lg"></span><b id="tally-name-me">You</b></div>
    <span class="tally-num" id="tally-sc-me">11</span><span class="tally-dash"></span><span class="tally-num is-them" id="tally-sc-them">8</span>
    <div class="tally-side [is-winner]" id="tally-them"><span class="chip chip-them chip-lg"></span><b id="tally-name-them">Club Bot</b></div>
  </div>
  <div class="next-up"><span>New game starting…</span><div class="next-bar"><i></i></div></div>
</div></section>
```
On `.is-active`: medal drops in (900ms bounce, 200ms delay), a shine sweeps the disc every 2.6s, `.next-bar` fills over
`--d-newgame` (5s = the server's `newMatchAt`). `.is-winner` rings that player's chip in gold.

### Notice card — `.panel.notice`
`div.panel.notice > div.notice-icon.well > svg` + `div > h2 + p… `. Waiting line: `<p class="t-note is-wait"><span class="light"></span>Trying again<span class="dots-wait"><i></i><i></i><i></i></span></p>`. Addresses go in `span.addr` (a pill, not code type).

### Illustrations
Line art uses `.art-line` / `.art-fill` / `.art-skin` (5px `#5b6670` round strokes), `.art-ghost` (dashed blue "this is your
paddle"), `.art-faint`, `.art-accent` / `.art-accent-fill` (blue arrow), `.art-nudge` (arrow nudges 1.4s). The calibration
drawing is one `<svg viewBox="0 -4 470 240">` filling a 47:24 well (35rem wide), with two reusable groups — `#grip-hand` (fist with only the
bud's head and ~20 units of stem showing, the way it really sits in a fist) and `#grip-face` (the dashed ghost paddle face) — a side-on
laptop labelled "Screen" (`#art-screen`), and two poses: `#art-hold` (level, dotted sight line to the screen) and `#art-tilt` (faded level
fist + the grip rotated −30° about the wrist + a heavy curved arrow `#art-arrow`, hidden while settling). Toggle their `hidden` attribute.

### Title lockup — `.logo`
`div.logo > div.logo-mark[aria-label=Poddle] > span.lg-a "P" + span.logo-ball + span.lg-a "d" + span.lg-b "dle"`, then
`p.logo-tag`. Grey "P●d" + blue "dle", the "o" is a CSS pickleball, grounded by a short flat drop shadow. **No mirrored floor reflection** —
that was the one element close to the reference's trade dress.

### Also defined
`.dev-panel#dev` (stats, hidden by default) — numbers only, no meter bar (the user asked for no power bar anywhere); `.confetti` (script-spawned, same inline
custom properties as today: `left`, `background`, `--dx`, `--rot`, `animation-duration`, `animation-delay`); text helpers
`.t-title`, `.t-lead`, `.t-note`, `.caps`, `.is-good`, `.is-bad`, `.is-warn`.

## 5. Screens and exact copy

| `?screen=` | Shell | Copy |
|---|---|---|
| `title` | `#screen-title.menu-glass` (the live court, blurred, behind it) | Logo **Poddle** · tag **AirPod pickleball** · chip **Joining room** `CODE` (only when the page was opened from a `?room=` link) · button **Play** (a swing over 12 rad/s, any key, or a click; Space / Enter / the button also go full screen) · note **or swing the AirPod** · card title **Clear some space** · card body **Check behind you before you swing. Hold the AirPod tight, it has no strap.** · footer right **First to 11, win by 2** |
| (no mock) lobby: `home` | `#screen-lobby.menu-glass` | Header **Back** · title **Play** · right **{n} online** (hidden unless n > 1: 1 is you) · tiles **Quick play** · **Create room** · **Enter code** (white border; the outline blue marks the one that is focused or hovered) · list heading **Open rooms** · row `CODE` **1 player** · empty list **No open rooms. Quick play starts one.** · link down **Can’t reach the game. Trying again** + dots · footer `Esc` **Back** · `F` **Full screen** |
| (no mock) lobby: `create` / `share` / `code` | same | **Create room**: **Public** / **Private** · note **Shows in open rooms** / **Join by code only** · button **Create**. **Your room**: **Room code** (caps) · four boxes · link + **Copy link** ▾ (hover, tap or keyboard drops **Player link** / **Viewer link**, the second with `&watch=1`; **Copied** for 1.5 s; the row is hidden on localhost) · button **Start**. **Enter code**: four boxes (aria **Code, 1 of 4** to **4 of 4**) · error **Room not found** / **Room is full** / **No free rooms. Try again soon.** / **Couldn’t join** · button **Join** |
| `connect` | `#screen-connect.menu-bg` (only shown while there is no AirPod data; skipped if the stream is already live) | Header **Getting ready** (+ **Back** when in a room) · title **Connect your AirPod** (no lead: the rows say the rest) · rows: **AirPod** waiting: **Take one AirPod out and hold it in your hand.** / bad: **Signal lost. Check the AirPod is still connected to this Mac.** · **Game** waiting: **Finding the game** / bad: **Can’t reach the game. Trying again.** · **Camera** waiting: **Allow the camera when the browser asks.** / ok: **Stand where it can see you.** / bad or off: **No camera. Press M to change how you move.** · state words **Waiting** / **Ready** / **Problem** / **Off** · footer left **Still waiting? Start the Poddle helper on this Mac.** · footer right `F` **Full screen** |
| `calibrate1` | `#cal.menu-bg` (`data-screen="calibrate"`; the id stays `cal` because other code and tests look for it) | Header **Calibration** · steps **1 Hold still**, **2 Tip up** · headline **Hold still** · lead **Hold the AirPod like a paddle handle, pointing at the screen.** · badge counts **5 4 3 2 1** · message line is empty except **Waiting for the AirPod** (no data) and **The camera can’t see you. Step into view.** (tracker ready but no face/body, step 1 only) · footer left **Any grip works. The game learns yours.** · footer right `C` **Start over** |
| `calibrate2` | same | Headline **Tip it up** · lead **Tip the front up toward the ceiling.** · badge = up arrow. Then (`calibrate-settle`, model message starts "Good") headline **Now hold it how you’ll play** · lead **Keep it there until the bar fills.** · no badge, arrow hidden. Then (`calibrate-done`) **All set** (green headline, green full bar, tick; no exclamation mark, those are for a won point or match) · lead **Here comes the court.** `main.js` holds this for 0.9 s before it opens the court (the model sends 'All set' and `calibrated` in the same batch), and the first toast waits for the fade to finish. |
| `calibrate-error` (`&err=twist` for the second) | same + `.panel.is-error`, `.cal-bar.is-bad`, `.cal-count.is-bad`, `#calh.is-bad` (red + a white-on-red "!" disc, so it is not colour-only) | Headline **You moved. Hold still** / **Level out, then tip straight up**. The headline always says what to do *now*: it is driven by the model event (`stage`, `ok`, `msg`), not just the stage, and an error headline is held for 1.4 s because "You moved" is a single 20 ms sample. The model's own `msg` strings are not shown. |
| `hud` | HUD over the court | Lights **AirPod** **Game** **Camera** (dots only when all is well) · in a room: pill **Room** `CODE` (click copies the link; tooltip **Copy link**, none on localhost) · tabs **You**; opponent **Waiting** (+ **B adds a bot** outside a room; in a room the bot comes by itself), **Rookie Bot** · **Club Bot** · **Pro Bot**, **Player 2** (what the near-side player sees) / **Player 1** (what the far-side player sees) (+ **Near side** / **Far side** under both names in a two-human game; **Setting up** under the opponent while they are still calibrating and the server holds the serve) · **Rally** · keys: `M` **Move: Body** (or **Auto**) · `B` **Bot** · `1 2 3` **Level** · `C` **Calibrate** · `R` **Re-center** · `[ ]` **Range** · `V` **AirPod** · `H` **Stats** · `F` **Full screen** · in a room `Q` **Leave**. At 900 px wide and below the lights and the room pill stack in the left corner, the webcam inset shrinks and the scoreboard drops its avatar chips, so nothing covers the room code. |
| `hud-callout` (`&kind=dink` etc., `&them=1`) | + `.callout.go` | Exactly one of **Dink** · **Lob** · **Tap** · **Drive** · **Smash** · **Block** from the `SHOTS` lookup table in `ui.js`; a kind that is not in the table shows as its own name, capitalised (`around_the_post` → **Around the post**); a hit with no kind (the serve) shows nothing. Local player's hits only. No punctuation, no praise. |
| `hud-point-you` / `hud-point-enemy` | + `.banner-tag.show` | **Your point!** / **Their point**. Nothing else, ever. |
| `serve-prompt` | + `.toast.on` | **Your serve!** (only during play). Other toasts: **Re-centered** · **Line up with the ball, then swing** · **Swing through the ball to serve** · **Body: step to move, tilt the AirPod to walk** · **Auto: the game runs, you swing** · **Club Bot** (during play only) · **Can’t add a bot with two players in** · **Range: step 25% of the view to reach the sideline** · **Range: turn 75° to reach the sideline** · **Saved address didn’t answer. Using this Mac.** · **Weak connection. Smoothing it out.** · **AirPod signal lost** · **Reconnecting to the game** (`hud-airpod-lost`) · rooms: **Opponent left** · **Press Q again to leave** · **Link copied** · **Room closed** · **No answer. Try again.** No toast on a miss. |
| `match-win` / `match-lose` | `#screen-match.veil.is-result` | **You win!** (gold medal) / **{Opponent name} wins** (silver medal, e.g. **Club Bot wins**) · scores · names **You**, opponent name · **New game starting**. Closed by the next `serve` event (6 s safety timeout). |
| `server-down` | `#screen-server-down.veil` | **Can’t reach the game** · **No answer from** `{address}` · on a hosted page (`HOSTED` in `main.js`): **Check your internet.** · otherwise: **Hosting? Run** `node server/game.js` **on this Mac. Joining a friend’s Mac? Check the address after the # in your link.** · **Trying again** + dots |
| `game-full` | `#screen-game-full.veil` (legacy room `LOCAL` only; a full room in the lobby is the **Room is full** error) | **This game is full** · **Two players are already in. Wait for one to leave.** · button **Try again** (reloads; the socket also keeps retrying and the card closes on `welcome`) |
| `hud-stats` | HUD + `#dev` visible | **Swing speed** n **rad/s** · **Paddle x** n **· y** n **m** · **Session peak** n (own line) · **Swings** n **· Average** n · **Last swings: power (range of motion)** · **Ping** n · **Connection** good / weak / offline · n **Hz** |
| `all` | contact sheet of the above | |

There is no power bar, no hit-quality words, no reasons on point banners and no commentary on misses anywhere in the system.

## 6. Animation timings

| Name | Where | Duration / curve | What moves |
|---|---|---|---|
| screen fade | `.screen` ↔ `.is-active` | 320ms `--ease-soft` | opacity |
| `panel-in` | panel / result card on activate | 600ms `--ease-out` | translateY 1rem→0, scale .965→1, opacity |
| `nudge` | `.screen.is-active .panel.is-error` | 420ms once per mistake (`ui.js` re-adds the class) | translate x ±.375rem |
| `glow-pulse` + `btn-breathe` | `.btn.is-focus` | 1600ms loop `--ease-soft` | halo opacity .25↔1 (static .8 under reduced motion), pill scale 1↔1.025 |
| key strip idle | `.keyhints.is-idle` | 500ms | opacity → 0, translateY .5rem |
| press | `.btn:active` | 160ms `--ease-bounce` | scale .955 |
| `num-pop` / `rally-pop` | `.score-num.pop` / `#rally.pop` | 450ms `--ease-bounce` | scale 1→1.18→1, −3° (stays inside the tab) / 1→1.4→1, −4° |
| `serve-bob` | `.serve-ind.on` | 900ms loop | translateY, slight squash |
| `banner-drop` | `.banner-tag.show > span` | 1900ms `linear`, easing per keyframe | in by 17% (overshoot 1.06), hold, soft lift out from 84% |
| `callout-pop` | `.callout.go` | 1200ms `linear`, easing per keyframe (ease-out into an extreme, ease-in-out between extremes, soft ease for the exit) | .3→1.12 (15%)→.96 (25%)→1 (33%), hold to 78%, rise 1rem + fade. Measured live: opaque by ~180ms, static 400–940ms, gone at 1200ms |
| toast | `.toast.on` | 320ms (`--ease-bounce` on transform) | opacity, translateY .75rem, scale .96→1 |
| `light-blink` | `.is-wait .light` | 1200ms loop | opacity 1↔.35 |
| `art-nudge` | calibration arrow | 1400ms loop | translate (−3,−9) |
| `medal-drop` | `.medal` | 900ms `--ease-bounce`, 200ms delay | from −4rem, .6 scale, −14° |
| `shine` | `.medal-disc::after` | 2600ms loop, first at 900ms | skewed highlight sweeps across |
| `bar-fill` | `.next-bar i` | 5000ms linear | scaleX 0→1 |
| `dot-wait` | `.dots-wait i` | 1200ms loop, 150ms stagger | hop + opacity |
| `confetti-fall` | `.confetti` | 1.4–2.6s linear (set inline) | translate + rotate |

All keyframes touch only `transform` / `translate` / `opacity`. Shadows and glows never animate (the glow is a static shadow
on a pseudo-element whose opacity animates). Under `prefers-reduced-motion: reduce` every animation and transition collapses
to 1ms, except: banner and callout keep their full on-screen time as a plain hold-then-fade (so information is not lost),
the new-game bar still fills, the focused button keeps a static glow, and confetti is not shown.
No infinite animation runs on anything hidden: with the HUD up, `document.getAnimations()` reports only `serve-bob`.

## 7. How it is wired (as built)

### Page skeleton (`web/index.html`)
```html
<link rel="stylesheet" href="ui.css">
<div id="stage"></div>                           <!-- three.js canvas -->
<!-- UI:BEGIN -->
<div id="hud" hidden> …status-lights, scoreboard, banner, callout-layer, dev, keys… </div>
<div class="inset inset-cam" id="camwrap" hidden> <video id="camv"> <canvas id="camc"> </div>     <!-- outside #hud: also shown on connect / calibrate -->
<div class="inset inset-pod" id="podwrap"><div id="pod"></div></div>
<div class="toast" id="toast"></div>                                                            <!-- outside #hud: toasts work on every screen -->
<section class="screen menu-bg" id="screen-title"   data-screen="title" hidden>…</section>
<section class="screen menu-bg" id="screen-connect" data-screen="connect" hidden>…</section>
<section class="screen menu-bg" id="cal"            data-screen="calibrate" hidden>…</section>
<section class="screen veil is-result" id="screen-match" data-screen="match" hidden>…</section>
<section class="screen veil" id="screen-server-down" data-screen="server-down" hidden>…</section>
<section class="screen veil" id="screen-game-full"   data-screen="game-full" hidden>…</section>
<!-- UI:END -->
```
`three.min.js` is still loaded from `vendor/` with the CDN fallback, then `<script type="module" src="main.js">`.

### ids
| Area | ids |
|---|---|
| HUD root | `hud` (`hidden` while a menu screen is up) |
| Status | `lights`, `st-airpod`, `st-game`, `st-camera` |
| Scoreboard | `board`, `name-me`, `sub-me`, `sv-me`, `sc-me`, `rally`, `name-them`, `sub-them`, `sv-them`, `sc-them` |
| Events | `banner`, `banner-text`, `callout`, `toast` |
| Insets | `camwrap` (hidden until the tracker is ready), `camv`, `camc`, `podwrap`, `pod` |
| Hints | `keys`, `mode` (the word after "Move:") |
| Stats | `dev` (hidden by default), `m`, `g` (hidden spans holding `live` / `off`; tests read `#g`), `pw` (live swing speed; `test/e2e.mjs` reads it), `bar`, `barf`, `barpk`, `px`, `py`, `pkmax`, `sw`, `pkavg`, `pklist` |
| Title | `screen-title`, `btn-start`, `safety` |
| Connect | `screen-connect`, `row-airpod`, `row-airpod-text`, `row-airpod-state` (+ `-game`, `-camera`) |
| Calibrate | `cal`, `calcard`, `steps`, `st1`, `st2`, `calh`, `calp`, `calart`, `art-screen`, `art-hold`, `art-tilt`, `art-arrow`, `cal-bar`, `cal-count`, `cal-num`, `cal-up`, `cal-check`, `calmsg` |
| Result | `screen-match`, `result`, `medal`, `result-title`, `tally-me`, `tally-them`, `tally-name-me`, `tally-name-them`, `tally-sc-me`, `tally-sc-them` |
| Notices | `screen-server-down`, `down`, `downurl`, `screen-game-full`, `full`, `btn-retry` |

Gone from the old page: `#dm/#dg/#dmode`, `#themname`, `#bot`, `#sidelbl`, `#rib/#bh/#bp`, `#hitfx/#hitword`, `#flash`, `#meter`, `#meterf` (no flash,
no power bar), `#msg`, `#ring/#arc`, `#side`.

### `web/ui.js` API (`import * as ui from './ui.js'`)
```js
export const SHOTS = { dink: 'Dink', lob: 'Lob', tap: 'Tap', drive: 'Drive', smash: 'Smash', block: 'Block' };   // add new kinds here
ui.shotName(kind)          // SHOTS[kind], else the kind itself capitalised ('around_the_post' -> 'Around the post'); '' for no kind

ui.showScreen(name)        // menu slot: 'title' | 'connect' | 'calibrate' | null (= just the HUD). Hides #hud under a menu screen.
ui.showOverlay(name)       // overlay slot: 'match' | 'server-down' | 'game-full' | null. Independent of the menu slot (an overlay sits under a menu, except 'game-full', which CSS raises above the menu screens so a third player is told before calibrating).
ui.currentScreen() / ui.currentOverlay()
ui.setNames({ me, meSub, them, themSub })   // any subset; textContent only, no-op when unchanged (safe at state rate)
ui.setScore(me, them)      // writes #sc-me/#sc-them; re-triggers .pop on whichever changed
ui.setServe(who)           // 'me' | 'them' | null
ui.setRally(n)             // .pop when n > 0 and changed
ui.callout(kind, them?)    // shot name only; sets textContent AND data-text, restarts .go; no kind -> nothing
ui.pointBanner(won)        // exactly 'Your point!' / 'Enemy’s point!'; restarts .show (does not wake the key strip)
ui.toast(text, ms = 1200)  // one at a time; a new toast replaces the old
ui.matchResult(won, me, them, name)   // fills the card and opens the 'match' overlay; the caller closes it on the next 'serve'
ui.confetti(colors, n)     // spawned inside #screen-match (behind the result card) while the match overlay is up, else on <body>; removed after 3.2 s; nothing under prefers-reduced-motion
ui.setStatus({ airpod, game, camera })   // each 'ok' | 'wait' | 'bad' | 'off' (omit to leave unchanged): pill + connect row + row copy + state word,
                           //   collapses the pills to dots when all ok/off, and toasts once after 1.5 s of 'bad' during play
ui.setLink('m' | 'g', live)   // hidden 'live' / 'off' text the tests read
ui.setServerAddress(text)  // #downurl (ws:// is stripped)
ui.calibration(e, { waiting, camLost })   // e = the MotionModel 'cal' event. Headline / lead / steps / art pose / --p on #cal-bar / countdown badge / error latch + nudge
ui.calibrationReset()      // back to "Hold still · Waiting for the AirPod…"
ui.setMode(name)           // 'Body' | 'Auto' | 'Aim' -> #mode
ui.setCamera(ready)        // shows #camwrap
ui.toggle(id)              // 'dev' | 'podwrap' -> flips [hidden] (H and V); returns visible
ui.isVisible(id)
ui.setStat(id, text)       // stats panel numbers (there is no meter bar)
ui.fullscreen(on?)         // request / exit / toggle; failures are swallowed
ui.wake()                  // show the key strip for another six seconds
ui.onStart(fn) / ui.onRetry(fn)   // click handlers for #btn-start / #btn-retry
```
`?uitest=1` exposes the module as `window.__ui` (used by `test/e2e.mjs` to force the match result, and the banner / callout if the rally did not show them).

### Flow (in `main.js`; `phase` = `title` → `lobby` → `connect` → `calibrate` → `play`)
- **lobby** (docs/ROOMS.md): Quick play / Create room / Enter code and the open rooms. Left when the server answers `room`. `?room=CODE` joins at once
  after Play. In a room: `Q` twice leaves, `left` clears the far avatar, the ball and the rally and says **Opponent left**, and the serve waits
  while the other human is still calibrating (`paddles[n].wait`, shown as **Setting up**).
- **title**: left by a swing (> 12 rad/s on the raw stream), any key, or a click. That first key / click also calls `scene.unlockAudio()`.
  `?skiptitle=1` starts at `connect`.
- **connect**: only waits for AirPod data. If the stream is already live when the title is left, this screen is skipped. Camera and game server never block.
- **calibrate**: `startCal()` restarts the model's calibration, so nothing that happened on the title counts. The model is **not fed** during
  title / connect (a bud lying on the desk would otherwise pass "hold still" by itself). `C` re-opens it from anywhere.
- **play**: `ui.showScreen(null)`; `#cal` gets `hidden` 360 ms later.
- Status is refreshed four times a second: AirPod = a sample in the last second; Game = socket open; Camera = tracker ready (`off` when unavailable or `?cam=0`).
- `hit` (mine) → `ui.callout(m.kind)` · `point` → `ui.pointBanner(won)` (+ small confetti on a won point) · `match` → `ui.matchResult(…)` + confetti ·
  `serve` → serve ball, rally 0, close the result card · `whiff` → counted, nothing shown · `full` → game-full overlay ·
  every game-server address failing → server-down overlay until a socket opens.
- Keys: M, B, 1 2 3, C, R, [ ], V, H, F (full screen), P (resets the stats panel). Browser shortcuts (Cmd / Ctrl / Alt combos) are ignored.

## 8. Verified / not verified
Verified in headless Chrome (macOS): every mock state at 1440x900 and 1280x720 with no console errors, 404s or clipped elements
(`node test/ui-shots/shoot.mjs`); the live behaviour list in `test/ui-shots/verify.mjs`; the whole flow in the real game with the real three.js
scene, webcam canvas and AirPod view (`node test/e2e.mjs`, screenshots `test/shots/ui-*.png`).
Not verified: a real AirPod / real face (the "swing to start" threshold and the camera-lost hint were only exercised by code path), full screen
(headless has none), Safari / Firefox (`-webkit-text-stroke` and `background-clip:text` degrade to plain blue text), frame-rate on the demo
laptop with the screen recorder running, and loading with the network physically off (every request the page makes is a local path).
