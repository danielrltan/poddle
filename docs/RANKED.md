# Poddle RANKED: the final spec

Menu overhaul, the Ranked queue with Matt as the warm-up, best-of-3 series in a night stadium, a seven-rank trophy road, and the match show (VS, game cards, series card, trophy roll, rank-up). Implementation-ready. Every `file:line` below was verified in the worktree at `/Users/danieltan/poddle-ranked` (branch `ranked`, head `6f6488d`), including the uncommitted work already in it (section 0.2).

Base design: the systems design (judged best by two of three judges), with the grafts the judges asked for and every flaw they listed fixed. Where the judges disagreed, the tie was broken by the owner's two asks (fun and progressable solo; fair when two humans meet) and the tiny player base.

---

## 0. Ground rules

### 0.1 Vocabulary (load-bearing)

`ranked` already means **"this match counted toward stats"** in this codebase: `match_log.ranked` (`server/db.js:105`), the verdict `v.ranked` from `abuse.judge`, the `profile` message's `ranked` (`server/stats.js:199`), the log line `match recorded: human ranked|unranked` (`server/game.js:486`, pinned by `test/stats.test.mjs:329`), `web/profile.js:78` (`p.ranked === false` = not counted). So:

| Layer | Word |
|---|---|
| Player-facing copy, DOM ids, CSS classes, lobby view name | **Ranked** / `btn-ranked` / `lobby-ranked` / `data-view="ranked"` / `.ranked-view` |
| Server state, wire messages, client `main.js` state, env knobs | `rk` / `ws.rk` / `RK_MSGS` / `opts.rk` / `r.tag = { rk: true, kind }` / `rk`, `rkvs`, `rkgo`, `rkgame`, `rkres`, `rkend`, `rkfail`, `rkleave` / `RK_*` / `rkKind` |
| Database | table `ladder`, `match_log.mode = 'ladder'` |
| Numbers | "trophies" for the count, "tier" for the rank index 1..7 |

`match_log.kind` keeps `human`/`bot` for Ranked games (the CHECK at `db.js:97` cannot be widened by ALTER; `KINDS`/`HUMAN` at `db.js:14`, `stats.js:10`, `abuse.js:9` stay).

### 0.2 What is already in the worktree (uncommitted, adopt it, do not redo it)

- **`web/emblems.js`** (new): `RANKS` (7 entries `{ id, key, name, colour:{deep,mid} }`), `THRESHOLDS`, `rankOf(trophies)`, `emblem(rank, cls)` (HTML string), `emblemEl(rank, cls)` (DOM), `setEmblem(el, rank)`, `emblemCard(rank, cls)` (emblem + rank name in a `<b>` under it, `.rank-card-em`), `installSprite()` (prepends one `<svg class="rank-sprite">` with `<symbol id="rank-1..7">` to `<body>`). Art: seven original frames (bronze shield, silver shield, gold hexagon, platinum octagon, diamond gem, winged star, laurel crest with crown), each with the pickleball as the centrepiece. No text inside the SVG.
- **`web/ui.css:1490-1502`**: `.rank-sprite`, `.rank-em` (1.5rem) with `.is-xs` 1.25rem / `.is-md` 2.5rem / `.is-lg` 5rem / `.is-xl` 7.5rem, `.is-pop` one-shot (`rank-pop`), `.rank-card-em` (+ `.is-inverse` for the navy ground); reduced-motion line at `:508`.
- **`test/emblems.html` + `test/emblems-shot.mjs`** (port 8471): the emblem contact sheet, light and navy grounds.
- **`web/scenery/shared.js:42-58`**: `PAL_STADIUM` (sky by elevation, `sunLight '#dfe8ff'`, `hemiSky '#55699a'`, `hemiGround '#151a26'`, stands, seats, crowd bodies/heads, hoarding, LED, mast, lamp, beam colours), `LIGHT_STADIUM = { sun: 1.75, hemi: 1.15, fogNear: 24, fogFar: 150 }`, `VENUES = { park, stadium }`; `makeShared(THREE, ctx, venue = 'park')` now takes the venue and sets `S.venue`, `S.pal`, `S.light` from `VENUES`.

Two things in that work must change to match this spec (section 5.1): `RANKS` names and `THRESHOLDS` become the final table, and the comment in `emblems.js` that says `installSprite()` is called from `main.js` becomes `ui.js` (ui.js owns the DOM; `test/menu.mjs` stubs ui.js by name, so main.js never touches the sprite).

### 0.3 Design-system rules honoured everywhere below

rem sizing, `is-*` state classes, no `backdrop-filter` on any overlay (`ui.css:118`; the one exception is `.glass` under the title/lobby), transform/opacity-only keyframes, `textContent` for every string (names are untrusted), every count-up writes its final value to `textContent` on frame one and animates an overlay (the `@property --n` counter, `ui.css:402-406`, `:1178-1180`, `:1223-1224`) so the reduced-motion clamp (`ui.css:500-509`) leaves a correct screen. New one-shot classes go in the `OV` sweeper (`ui.js:11`). New overlay names go in `OVERLAY` (`ui.js:23`). No third-party art, fonts or libraries. Lobby copy has no `— – … !` (`test/menu.mjs:83`, `test/seo.test.mjs`).

---

## 1. Lobby home: five entries

### 1.1 Layout: a hero row and a utility row

Today `#lobby-home .tiles` (`web/index.html:284-297`) is a flex-wrap row of four 17rem × 14.5rem tiles (`ui.css:597-609`); five do not fit one row at 1280 px, and three rules key on `.tiles:has(> .tile:nth-child(4):not([hidden]))` (`ui.css:611`, `:710`, `:1018`). Those positional rules are **not** dead with a fifth tile: with Ranked hidden in DOM slot 2, `#btn-bot` becomes the visible 4th child and the 2×2 rule fires on localhost with three visible tiles (`test/ui-next.mjs:129` "three across" fails at 600×900). So the layout is keyed on a **data attribute written by JS**, never on `:has(nth-child)`.

```
┌────────────────────┐ ┌────────────────────┐
│   ▶   Quick play   │ │ [emblem]  Ranked   │   hero row: 2 tiles, 12rem tall, art left of the label
│                    │ │  Silver · 240│
└────────────────────┘ └────────────────────┘
┌────────────┐ ┌────────────┐ ┌────────────┐
│ ▦ Courts   │ │ ☺ Play a bot│ │ ▥ Your stats│   utility row: 3 tiles, 8.5rem tall, icon left (today's ≤480 px row look)
│   3 open   │ │            │ │            │
└────────────┘ └────────────┘ └────────────┘
```

- `ui.js` exports **`tilesFit()`**: counts `#lobby-home .tile:not([hidden])` and writes `$('lobby-home').querySelector('.tiles').dataset.n = String(n)`. Called from `lobbyView()` (`ui.js:582`, right after the views are hidden/shown) and from `profile.js:221 drawAcct` through a new hook `h.tiles()` (add `tiles` to the hook list at `profile.js:266`; `main.js:702` passes `tiles: () => ui.tilesFit?.()`).
- CSS: replace the three `:has(> .tile:nth-child(4):not([hidden]))` selectors with `.tiles[data-n="4"]` (same declarations, so 4 tiles keep today's shapes: one row / 2×2 / one column) and add `[data-n="5"]`:
  - landscape ≥ 785 px: `.tiles[data-n="5"]{display:grid;grid-template-columns:repeat(6,1fr);width:min(58rem,92vw);gap:var(--s-4)}` `.tiles[data-n="5"] .tile.is-hero{grid-column:span 3;height:12rem;flex-direction:row;justify-content:flex-start;padding:0 var(--s-5);gap:var(--s-4)}` `.tiles[data-n="5"] .tile:not(.is-hero){grid-column:span 2;height:8.5rem;flex-direction:row;justify-content:flex-start;padding:0 var(--s-4);gap:var(--s-3)}` `.tiles[data-n="5"] .tile svg{width:5rem;height:5rem}` `.tiles[data-n="5"] .tile:not(.is-hero) svg{width:4rem;height:4rem}`. Total height 21.75rem: fits 1366×500 (rem at its 10 px floor: 218 px + header 50 + footer 45 + name row) and 1280×720.
  - landscape < 785 px (`@media (min-aspect-ratio:1/1) and (max-width:784px)`): same grid at `width:min(58rem,94vw)`; heroes 10.5rem tall.
  - portrait (`@media (max-aspect-ratio:1/1)`, `ui.css:707`): `.tiles[data-n="5"]{grid-template-columns:1fr 1fr;width:min(40rem,100%)}` heroes `grid-column:span 1;height:12rem;flex-direction:column`, utilities `grid-column:span 2;height:6.5rem` (rows: 2, 1, 1, 1).
  - `@media (max-width:480px)` (`ui.css:1017`): `.tiles[data-n="5"]{grid-template-columns:1fr}` every tile the existing 7.5rem row, `grid-column:auto` (rows: 1,1,1,1,1).
- Deal-in: add `.tile:nth-child(5){animation-delay:280ms}` beside `ui.css:610`.
- DOM order = visual order = arrow order: `#btn-quick` (gains `class="tile is-hero"`), **`#btn-ranked`** (`class="tile is-hero" data-nav hidden`), `#btn-courts`, `#btn-bot`, `#btn-profile`. `.tile:nth-child(2):hover{rotate:.6deg}` (`ui.css:607`) now tips Ranked: fine.
- **Arrow walker fix** (`ui.js:813-814`): `querySelectorAll('[data-nav]:not([hidden])')`. Today a hidden tile is in the ring and `.focus()` on it is a no-op, which would break `test/menu.mjs:93` (ArrowRight from Quick play → `btn-courts`) and `test/ui-next.mjs:139` once a hidden Ranked sits in slot 2.
- Focus stays on `#btn-quick` on entry (`viewFocus`, `ui.js:602`). `test/e2e.mjs:85-86` (Enter on the lobby = Quick play) holds.

### 1.2 Gating

`#btn-ranked` is unhidden by `profile.js:221 drawAcct`: `show('btn-ranked', on && me.db)` (trophies need the stats server and a database; `me.db` is `/api/me`'s `db: db.ok()`, `server/api.js:76`). On localhost without `?acctest=1` the tile stays hidden, so `test/menu.mjs:86` (`/^Quick play\|Courts\|Play a bot$/`), `:88`, `:93`, `test/ui-next.mjs:128-129,138-139` and `test/e2e.mjs:85-86` need no edits. `test/profile-ui.mjs` (`?acctest=1`, fake `/api/me {db:true}`) sees five tiles (section 11).

`nameGate()` (`ui.js:380-383`) already dims every `#lobby-home .tile:not(#btn-profile)`: Ranked seats you, so it stays inside the gate. Add `#btn-ranked-go` to the `.is-down` and `.needs-name` lists at `ui.css:567-569`.

### 1.3 The Ranked tile

- Art: the player's current emblem, `emblemEl(tier, 'is-lg')` inserted by `ui.rkTile()`; before a rank is known (fresh guest, no profile) the Bronze emblem with `.is-off` (opacity .55, a new rule beside `.rank-em`).
- Label `<b>Ranked</b>` and a second line `<small class="tile-line" id="ranked-line">` (a new class: under the label, left-aligned in the hero row, `--t-sm`, `--ink-soft`): `Silver · 240 trophies` once known, `Play your first match` before.
- Corner badge `<small class="tile-sub is-off" id="ranked-n">` (the `#courts-n` model, `ui.js:658`, CSS `:933-935`): **`1 waiting`** when the lobby message says `rk.queued > 0`. This is the strongest matchmaking lever on a one-person-online base: the home screen says an opponent exists. While shown it pulses: `#ranked-n:not(.is-off){animation:glow-pulse var(--d-pulse) var(--ease-soft) infinite}` (an existing keyframe).
- Icon block beside `ui.css:616-631`: `#btn-ranked .rank-em{transform-origin:50% 55%}`; `#btn-ranked:focus-visible .rank-em{animation:ic-tilt 1800ms var(--ease-soft) 1}` and the hover loop (reuses `ic-tilt`).
- `ui.rkTile({ tier, trophies, queued })` (exported; all `textContent`).

Settings > You (`index.html:181` pattern, wired at `profile.js:271` `click('btn-set-stats', …)`) gains `<button class="set-row set-action" id="btn-set-ranked" hidden><span>Ranked</span>…</button>` → hook `h.ranked` → `main.js` `openRanked()` = `openStats()` (`main.js:233`) with `lobbyView('ranked')`. DEVIATION: the Settings rows for stats left Settings when Save my stats moved to the privacy page (NOTES 109); `#btn-set-ranked` was never kept (test/profile-ui.mjs asserts it is absent). The Ranked tile and `/ranked` open the view.

Title screen, footer and keys are unchanged. `docs/ui-spec.md` copy table (`:218-219`) and id list (`:287-305`) gain the tile, the view and the new ids.

---

## 2. The Ranked view (`#lobby-ranked`, `data-view="ranked"`)

Markup after `#lobby-bot` (`index.html:384`):

```html
<div class="panel panel-mid lobby-view ranked-view" id="lobby-ranked" data-view="ranked" data-fit hidden>
  <div class="rk-head"><div id="rk-emblem"></div><h2 id="rk-tier">Silver</h2>
    <p class="rk-count"><b id="rk-trophies">240</b> trophies</p>
    <div class="rk-bar" id="rk-bar"><i></i></div><small id="rk-next">10 to Gold</small></div>
  <ol class="rk-road" id="rk-road" aria-label="Trophy road"></ol>
  <button class="btn btn-xl" id="btn-ranked-go">Find a match</button>
  <p class="t-note" id="rk-status" role="status"></p>
  <p class="t-note rk-rules" id="rk-rules"></p>
</div>
```

- Tables at `ui.js:567-570`: `VIEW_TITLE.ranked = 'Ranked'`, `VIEW_DEPTH.ranked = 1`, not in `VIEW_PARENT`, not in `NO_NAME` (it seats you). `viewFocus()` (`:602`): `ranked: $('btn-ranked-go')`. Clicks (`:754-760`): `on2('btn-ranked','click', () => { if (!needName()) lobbyView('ranked'); })`, `on2('btn-ranked-go','click', () => { if (!needName() && on.ranked) on.ranked(); })`. `lobbyView()` (`:584`): entering `ranked` calls `on.rankedOpen()` (main.js → `profile.showRanked()`, a `showProfile` twin at `profile.js:117-121` that fetches `/api/stats` and calls `ui.rkView(p.ladder)`). `onLobby` handler set (`:574`) gains `ranked()`, `rankedOpen()`.
- **Opening the view switches the scene to the stadium** (`scene.setVenue('stadium')`, section 7) so the staged scenery build (~130 ms) happens behind the lobby glass, never on court; `lobbyView('home')`, `toLobby()` and Back switch it to `'park'` unless `rkOn()`.
- `ui.rkView(s)` draws from `s = { tier, trophies, best, floor, next, wins, losses, streak, matt: { level, win, dayLeft }, queued, note }` (`statsOff` REMOVED 2026-09-28 (NOTES 116): the Save my stats switch is gone, stats are always kept):
  1. **Head**: `emblemCard(tier, 'is-xl')` into `#rk-emblem`; `#rk-tier` the rank name; `#rk-trophies`; `#rk-bar` `--p = (trophies − floor) / (nextFloor − floor)` (1 at the top tier); `#rk-next`: `10 to Gold` / `Top rank` / unknown: emblem `.is-off`, `No rank yet`, `Play a Ranked match to place`.
  2. **Road**: seven `li.rk-step` (emblem `is-md` · `<b>` name · `<small>` floor `0`, `100`, …), horizontal, `flex-wrap` centred (7 / 4+3 at 600 px); `.is-done` for reached tiers, `.is-now` (ringed, `glow-pulse`) for the current, future ones at 45% opacity; `title`/`aria-label` `Reached on 2 Oct` from `bestTierAt` when known. Under the road one line `small`: `Bronze to Platinum are yours to keep. Diamond and above can drop.` (section 5.2).
  3. **Find a match** + `#rk-status`: default `You play Matt while it looks for someone`; `queued > 0`: **`Someone is waiting to play`** (accent colour, `ov-pop` once); (`statsOff`: button `disabled`, `Turn on Save my stats…`: REMOVED 2026-09-28 (NOTES 116); Find a match is never disabled now); after `rkfail busy`: `Courts are full right now. Try again in a moment`; after `rkfail intour`: `Leave your tournament first`; after a forfeit notice (`rkres` while on the view): `Forfeit: 20 trophies` (`Forfeit: you keep Bronze` when the floor held). Every such line is held for its time over the view's own redraws.
  4. **Rules line** `#rk-rules`: `Best of 3 games, first to 7, win by 2. Matt warms you up while you wait. Leaving a match counts as a loss. Your rank emblem is shown to your opponent and to anyone watching.` (the in-product disclosure of the one newly public thing).
- Record line in Your stats: `profile.drawSide` (`profile.js:98-105`) gains `row(hu, 'Ranked', `${name} · ${trophies}`, `${wins}-${losses} in series`)` from `p.ladder`.
- `.ranked-view` uses `panel-mid` (`min(50rem,92vw)`, `ui.css:132`). Check `data-fit` at 1440×900, 1280×720, 600×900, 390×844.

---

## 3. Queue and matchmaking (server, `server/game.js`, next to the tournament block)

### 3.1 The rule: being in the queue == being seated in an rk room

No separate leave message, no drop timers, no "warm-up full" state: a queued player is on a warm-up court against Matt (or, when a partner is already waiting, straight in the VS card). Leaving the court (Back, Q Q, socket close) leaves the queue. The one exception is the five seconds of the VS card, when the entry is held by `q.series`.

### 3.2 State and knobs (after `game.js:1399`)

```js
const RK_WIN = +env.RK_WIN || 7, RK_BEST = +env.RK_BEST || 3, RK_GOLD = +env.RK_GOLD || 11;          // a game: first to 7, win by WIN_BY, golden point at 11; a series: best of 3
const RK_VS_S = num(env.RK_VS_S, 5), RK_GAME_GAP_S = num(env.RK_GAME_GAP_S, 6), RK_DONE_S = num(env.RK_DONE_S, 12), RK_ARRIVE_S = num(env.RK_ARRIVE_S, 30);
const RK_WINDOW_S = num(env.RK_WINDOW_S, 15), RK_CAP = +env.RK_CAP || 12, RK_ADDR = +env.RK_ADDR || 2, RK_MATT_DAY = +env.RK_MATT_DAY || 40;
const RK_MSGS = new Set(['rk', 'rkleave']);                    // heard from a queued socket wherever it is (the TOUR_MSGS pattern, :1169/:1475)
const rkQ = new Map();       // cid -> Q { cid, ws, name, reg, on, since, warm: code|null, ident, owner, tier, trophies, series: code|null, seatAt, friendly }
const rkSeries = new Map();  // code -> X { id: ++rkSeq, code, r, a: Q, b: Q, games: [0,0], scores: [], verdicts: [], friendly, done, arriveAt, readyBy }
```

All env knobs are read like `TOUR_*` (`game.js:1166-1168`) so `test/ranked.test.mjs` can shrink every clock. `ws.rk = Q` marks the socket (like `ws.tour`).

### 3.3 Dispatch

- `game.js:1475`: `if (ws.rk && RK_MSGS.has(m.type)) return rkMsg(ws, m);` before the room block. `rkMsg`: `rkleave` → `rkLeave(ws, 'left')` (from the lobby: out of the queue; on a warm-up court: `quit(ws); enterLobby(ws)` first; in a live series: ignored, `leave` is the forfeit); `rk` from a socket on a **finished** rk series card (`ws.room.tag.rk && ws.room.kind === 'match'` and the room is `over`): `quit(ws)` (the MATCH over-branch at `:808` only splices) `; enterLobby(ws); rkQueue(ws)` (this is **Play again**; judge 1's flaw: `rk` was lobby-only and `ws.rk` was already cleared).
- `game.js:1483` (lobby-only): `else if (m.type === 'rk') rkQueue(ws);`.
- `game.js:1486` close handler: `rkGone(ws)` after `tourGone(ws)`.
- `game.js:1511`: `rkTick(ms)` after `tourTick(ms)`.
- `game.js:1478` (`leave` via lobby from a room): after `quit(ws); enterLobby(ws);` add `if (ws.rk && !ws.rk.series) rkLeave(ws, 'left');` (leaving the warm-up leaves the queue).

### 3.4 Entry: `rkQueue(ws)`

Refusals, each `tell(ws, { type: 'rkfail', why })` and nothing else:

| why | when |
|---|---|
| `nocid` | `!ws.cid` |
| `intour` | `tourActive(ws)` (`:1181`) |
| `nostats` | `ws.statsOff` only. NOT `identOf(ws).anon`: a first-ever visitor has no device id until the first seat (`web/profile.js:32-36 seated()`), so the hello arrives after `welcome`; the socket identifies itself through `helloMsg` (`:1435-1441`) → `room.identify` before anything is settled. (The client gate on `profile.statsOn()` was REMOVED 2026-09-28 (NOTES 116); `ws.statsOff` now comes only from a tab loaded before the removal.) REVIEW FIX: an entry whose identity is still anonymous is admitted to its warm-up but never paired (3.6: `rkHello` refreshes `q.ident`); one that has still not said hello `RK_ARRIVE_S` after entry is dropped with `rkfail nostats` (a crafted client or a bad-Origin socket voided every series it joined at no cost). A `nostats` arriving later on a Ranked socket (an old tab only, since 2026-09-28) ends the entry where it stands (3.9). |
| `addr` | `RK_ADDR` (2) entries already queued from the same COMPUTER key (`q.ws.computer === ws.computer`: `abuse.computerKey`, IPv4 whole, IPv6 its /64, docs/ACCOUNTS.md 3.5; REVIEW FIX: it compared exact addresses, and an IPv6 /64 with privacy extensions has a fresh one per socket), unless `loopback(ws)` (`:1109`). Two people behind one NAT can both queue (they can never be paired with each other, section 3.5, but each may meet a third party). |
| `full` | `rkQ.size >= RK_CAP` |
| `busy` | `rooms.size + tourKeep() >= ROOM_CAP - TOUR_RESERVE` (the warm-up gate of `:1255`) and no partner is pairable at once; also within `RK_COOL_S` (2 s) of this socket's own `rkleave` / `leave` from the queue (REVIEW FIX: an `rk` / `rkleave` loop made and tore down a court per message) |

Already queued (`ws.rk`): just `rkSend(q)`. Otherwise:

```js
const ident = stats.identOf(ws), owner = ident.ownerId ?? (ident.devHash ? db.ownerForDevice(ident.devHash, now, { create: false }) : null);
const L = owner != null ? db.ladderTier(owner) : null;                      // { tier, trophies, best_tier } | null (a first-time guest has no owner yet)
const q = { cid: ws.cid, ws, name: ws.name, reg: !!(ws.acct && ws.acct.username), on: true, since: Date.now(), warm: null, ident, owner, tier: L ? L.tier : 1, trophies: L ? L.trophies : 0, bestTier: L ? L.best_tier : 1, series: null, seatAt: 0, friendly: false };
rkQ.set(q.cid, q); ws.rk = q; lobbyChanged();                               // lobbyChanged: the home tile's '1 waiting' (lobby pushes only go out on a change, :1077-1084)
const p = rkPick(q); if (p) { tell(ws, rkSnap(q, 'vs')); return rkPair(p, q); }   // a partner is already waiting: no warm-up, straight to the VS card (the snapshot settles request())
rkWarm(q);
```

`rkSnap(q, phase)` = `{ type: 'rk', phase: 'queue'|'vs'|'match'|'off', you: { tier, trophies, floor, next, best, matt: { level, win, dayLeft } }, queued, place, since }` (never a cid, never an owner id). `rkSend(q)` sends it to `q.ws`; pushes are coalesced at ≤ 4 Hz by `rkTick` (a `dirty` flag per entry, the `tourFlush` pattern `:1398`).

### 3.5 Warm-up vs Matt: `rkWarm(q)` (clone of `tourWarm`, `:1253-1259`)

```js
if (rooms.size + tourKeep() >= ROOM_CAP - TOUR_RESERVE) { rkQ.delete(q.cid); q.ws.rk = null; return tell(q.ws, { type: 'rkfail', why: 'busy' }); }
const code = newCode(), r = createRoom(code, false, { rk: q, kind: 'warm', only: cid => !!cid && cid === q.cid, botLevel: MATT_OF[q.tier], winAt: RK_WIN, gold: RK_GOLD,
  onClose: () => { if (q.warm === code) { q.warm = null; if (rkQ.get(q.cid) === q && !q.series) rkLeave(q.ws, 'left'); } } });   // the court went (leave, drop, TTL): out of the queue, unless a series is taking them
r.by = null; r.tag = { rk: true, kind: 'warm' }; rooms.set(code, r); q.warm = code;   // by null: never counted by ADDR_ROOMS (:1111); RK_ADDR is the address cap instead
if (!seat(q.ws, r)) r.close('empty'); else rkSend(q);
```

`seat()` (`:1088-1108`) sends `room { code, public:false, role:'player', rk:true, kind:'warm' }` (it spreads `r.tag`, `:1106`) then `join()` → `welcome`; `join` (`:727`) adds Matt at once because `opts.kind === 'warm'`. The client's `request()` settles on `room` (`main.js:302`).

Room edits for the warm-up (all in `createRoom`):
- `:639` `let botLevel = opts.botLevel ?? (opts.tour ? 3 : 1)`.
- `:682` `band = opts.tour || opts.rk ? 1 : clamp(…)` (fixed strength).
- `:661` `if (MATCH || opts.rk) return send(from, { ...botInfo(), reason: opts.rk ? 'ranked' : 'tournament' });` (keys 1-4/B at `main.js:743-744` would change Matt's level; the client treats `'ranked'` as silent at `main.js:614`).
- `:586` `pause`: allowed in the warm-up (one human), refused in the series (`MATCH`).
- `:759` `ask()`: `if (opts.tour || opts.rk) return askSay(ws, 'refused', undefined, { why: opts.rk ? 'rk' : 'tour' });`. `:1053-1054` `underway()`/`askable()`: `!opts.tour && !opts.rk`. So a typed rk code lands on `joinfail full, watch:true` (`:1122`) and never in the stands with a request.
- `:836` `botJoinAt = AUTOBOT && !opts.tour && !opts.rk && …`.
- `quick()` (`:1157`) never picks rk rooms (`pub` false); `lobbyMsg()` (`:1071`) never lists them.

**A warm-up game** is an ordinary Matt game: first to `RK_WIN`, win by `WIN_BY`, golden point `RK_GOLD`, recorded through `record()` as `kind:'bot'` with `mode:'ladder'` (it lands on the Beat Matt ladder honestly), Matt bounty per section 5.3. When it ends (`endMatch` non-MATCH branch, `:505-511`): for `opts.rk`: `over.votes = [true, true]`, `over.until = Date.now() + RK_GAME_GAP_S * 1000`, no `voteMsg`, and `overMsg()` carries `rk: { matt: true, next: secsTo(over.until) }`. In `step()` before the `:939` line: `if (over && opts.rk && !MATCH && ms >= over.until) { over = null; broadcast({ type: 'rematchon' }); startMatch(1 - firstServe); return; }` (the client's `rematchon` handler `main.js:622` closes the card; the 3-2-1 follows). A Matt game never ends the queue.

Leaving the warm-up: `leave()` non-MATCH path records a Matt loss after the first strike (G1a, `:827`), the room closes (`:839`, `kind === 'warm'`), `onClose` removes the entry. A dropped socket: `quit(ws, true)` → `record(null,'dropped')` (an abandon, `:827`), same close; `rkGone` marks `q.on = false` and the entry goes with the room. A reload therefore re-queues at the back: acceptable (nothing is lost but the place, and the queue is usually one person).

### 3.6 Pairing: `rkPick(q)` and `rkTick`

`rkPick(q)` returns the best partner or null. Candidates: entries `c !== q` with `on && !series && c.ws.readyState === 1` and an identity (`!c.ident.anon`; REVIEW FIX: `q` itself must be identified too, a first-timer's hello follows its warm-up seat and `rkHello` takes it into `q.ident`). **Never** (cannot be paired at all): same `devHash`, same `accountId`, same `owner` (both known), or `meets(L.groups([q.ws.computer]), L.groups([c.ws.computer]))` with `L = stats.linkMap()` (R5 `same_computer` would void every game: `abuse.js:130`). Otherwise a pair is **clean** or **friendly**:

- friendly when `db.recentPairs(q.owner, c.owner, now - DAY) >= cfg.pairDay` (R10, 3 series a day between the same two owners, section 5.6 counts by series) or `L.pair(qKeys, cKeys) >= cfg.pairDay` (R10 by computer group) or `db.oneWay(...)` would flag R11b; friendly pairs still play, for fun, and the VS card says **Friendly match, no trophies** (honest beats silent: a series that awards nothing says so before it starts, never after).
- Trophy window: `|q.trophies − c.trophies| <= 200 + 100 * floor(min(waitQ, waitC) / RK_WINDOW_S)` (any gap after 2 min).
- Pick: the clean candidate with the smallest gap (ties by `since`); a friendly candidate only when both have waited ≥ 2 × `RK_WINDOW_S` and no clean one exists.
- Capacity: `rooms.size + tourKeep() < ROOM_CAP` (the warm-ups are about to close).

`rkTick(ms)` every 250 ms: for the oldest entry with `on && !series`, `rkPick` → `rkPair`; then the VS timers (`seatAt`), the no-show/never-ready backstops (3.8), the coalesced snapshots, and entries whose socket is gone and whose warm-up has closed are dropped.

### 3.7 The match: `rkPair(a, b)` and the seat

```js
const code = newCode(), X = { id: ++rkSeq, code, a, b, games: [0, 0], scores: [], verdicts: [], friendly: a.friendly || b.friendly, done: false };   // REVIEW FIX: rkSeq starts at floor(BOOT / 1000) * 1e6, so a series id is unique across restarts (match_log.series, its trophy deltas and R10 key on it)
X.r = createRoom(code, false, { rk: X, kind: 'match', only: cid => !!cid && (cid === a.cid || cid === b.cid), sideOf: cid => (cid === a.cid ? 0 : cid === b.cid ? 1 : null),
  vsBot: false, winAt: RK_WIN, bestOf: RK_BEST, gold: RK_GOLD, label: [a.name, b.name], ranks: [a.tier, b.tier],
  onGame: (w, sc, rec) => rkGame(X, w, sc, rec), onResult: (w, games, forfeit) => rkResult(X, w, games, forfeit),
  onClose: (why, seated) => { if (!X.done) rkResult(X, seated[0] && !seated[1] ? 0 : seated[1] && !seated[0] ? 1 : null, X.games, true, 'gone'); } });
X.r.by = null; X.r.noTtl = true; X.r.tag = { rk: true, kind: 'match' }; rooms.set(code, X.r); rkSeries.set(code, X);
for (const [q, o, sd] of [[a, b, 0], [b, a, 1]]) {
  q.series = code; q.seatAt = Date.now() + RK_VS_S * 1000;
  const w = q.warm && rooms.get(q.warm); if (w && q.ws.room === w && q.ws.pl) { w.leave(q.ws.pl, true); w.close('rkmatch'); }   // OUT of the warm-up NOW (not quit(): see below)
  tell(q.ws, { type: 'rkvs', vs: { name: o.name, reg: o.reg, tier: o.tier }, you: { tier: q.tier }, bestOf: RK_BEST, target: RK_WIN, friendly: X.friendly, at: RK_VS_S, side: sd });
}
console.log(`[${code}] ranked series drawn`); lobbyChanged();
```

Why `w.leave(pl, true)` + `w.close()` and never `quit(ws)`: `quit` runs the non-MATCH `leave()` path, which at `game.js:827` records a **Matt loss** after the first strike; `leave(me, again = true)` (`:806`) only splices the seat and `close()` (`:520-531`) drops the match with nothing recorded (`stats.drop`, G4) and sends `closed` only to whoever is still in `players`/`spectators` (a warm-up spectator hears `closed rkmatch` and lands in the lobby; the player hears nothing). The client still holds `room = <warm code>`, so the series room's `room` message takes the proven **moved** branch (`main.js:544`, once `tk` accepts the rk tag). Taking the player out at PAIR time (not at the seat) also means a Matt point cannot land, and pay a bounty, under the VS card.

At `seatAt` (`rkTick`), for each of a, b: `if (q.ws.readyState !== 1) continue; if (q.ws.room) quit(q.ws); if (!seat(q.ws, X.r)) enterLobby(q.ws);` (the `tourSeat` recipe, `:1316-1321`). `seat()` sends `room { rk:true, kind:'match' }` then `welcome`; `join` (`:727`) calls `startMatch(0)` when the second seat arrives. Then `X.arriveAt = Date.now() + RK_ARRIVE_S * 1000; X.readyBy = X.arriveAt + CAL_S * 1000`.

### 3.8 Backstops (copied from `tourTick` `:1389-1395`)

- No-show at `arriveAt`: `const s = X.r.seatedSides(); if (!(s[0] && s[1])) X.r.force(s[0] ? 0 : s[1] ? 1 : 0)` (`force`, `:1057`, ends the match as a forfeit for the seated side; with nobody seated the room closes through `onClose` → `rkResult(null, …, 'gone')` = void).
- Never ready at `readyBy`: `const u = X.r.unready(); if (u.length) X.r.force(u.length === 1 ? 1 - u[0] : 0)`. REVIEW FIX: `unready()` is empty from game 2 on (`game > 1`), so a `readyBy` that lands in a later game's pre-strike window (a reload, `status cal:true` at rkgo) forfeits nothing: that window is `slowSeat`'s, with its `CAL_S` grace.
- A seat that goes unready mid-match: `slowSeat` (`:571-581`) already handles a MATCH room (`CAL_S`, `closed away`, forfeit). REVIEW FIX: the stalling is SUMMED per seat over the whole room (`pl.stallMs`, counted only while the serve waits for that seat): a cal on / off / on loop restarted the `CAL_S` window for ever; at `2 x CAL_S` in all the seat is out as if one window had run down.
- Drops are bounded the same way (REVIEW FIX): a MATCH seat (tournament or Ranked) is held at most `HOLD_MAX` (2) times per room and for at most `2 x HOLD_S` in all (`pl.holds`, `pl.heldMs`); the next drop is that seat's forfeit at once (`leave()` MATCH branch, `canHold`). A drop / reconnect loop replayed every losing point for ever, and the stayer's only exit paid the staller.

### 3.9 Leaving, dropping, ending

The series room is `MATCH` (`kind:'match'`, `:291`): `leave` = forfeit (`:807-816`), a drop = `startHold` for `HOLD_S` then `forfeitHeld` (`:543-548`), every exit reaches `onResult` exactly once (`reported`). `leave` during the between-games card: `over` is null then, so the MATCH branch forfeits the series (correct). After `rkResult` both `Q` entries leave `rkQ` (the player re-queues from the card's Play again or the view), `ws.rk` is kept until the socket leaves the result card (so `rk` on the card works, 3.3), the room closes `RK_DONE_S` after the final card (`step()` `:939` → `close('round')`).

`rkLeave(ws, why)`: `rkQ.delete`, `ws.rk = null`, `lobbyChanged()`, `tell(ws, { type: 'rkend', why })` only for `restart`/`gone` (a player's own leave is silent, and starts the `RK_COOL_S` re-queue cooldown). `rkGone(ws)`: `q.on = false` (the warm-up or the series hold does the rest).

REVIEW FIX, `nostats` on a Ranked socket (`rkOptOut`; kept for a tab loaded before the switch was REMOVED 2026-09-28 (NOTES 116), unreachable from today's client): trophies need stats, so the entry ends where it stands, with `rkfail nostats`: on a warm-up the seat is left (out of the queue); seated in a live series it is that seat's forfeit (`quit`, the leaver's loss lands on the identity frozen at pairing, 5.5 rule 5); under the VS card the seat is never taken (`rkSeat` refuses a stats-off socket: a no-show). Before this the opted-out seat played on anonymously, which voided the opponent's win and left the loss with no owner.

REVIEW FIX, a seat whose socket is down when the series settles (held, and the other side left or dropped past its own hold): its `rkres` is kept in `rkLate` (cid → result, for `RK_DONE_S + HOLD_S`) and replayed to its `&rk=1` return instead of `rkend restart|gone`, so the player who did nothing wrong sees the win (the trophies were written either way).

### 3.10 Reconnect, restart, revive (nothing of the ladder is ever revived)

- Client socket URL (`main.js:404-408`): `&rk=1` whenever `rkOn()` (queued or in an rk court) and **never** `backTo()` for rk courts (`room && !tourOn() && !rkKind ? backTo() : ''`).
- Server, beside the `&tour=` branch (`:1493-1497`), before the `back=1` line: `if (q.get('rk') === '1') { const e = ws.cid && rkQ.get(ws.cid); if (!e) return tell(ws, { type: 'rkend', why: Date.now() - BOOT < REVIVE_S * 1000 ? 'restart' : 'gone' }); return rkRebind(ws, e, q); }`. `rkRebind`: `e.ws = ws; ws.rk = e; e.on = true;` a live or held series → `seat(ws, X.r)` (`heldBy` at `:1094` gives the seat back, the point is replayed); a standing warm-up named in `&room=` → `joinCode(ws, code)` (retake); else `rkWarm(e)`; then `rkSend(e)`.
- `revive()` (`:1133`): add `q.get('rk')` to the refusal list.
- Restart: every rk room dies with the process (SIGTERM `:1523-1525`); a series in flight is **void**: nothing was settled, `stats.drop` recorded nothing for the game in flight, finished games stay in `match_log` with `mode='ladder'` and NULL deltas. The client hears `rkend restart` and says `Updating. The ranked match is void, no trophies changed.`
- Client: the restart toast (`main.js:535`) gains `else if (rkOn()) say('Updating. The Ranked match will end.')`; the 5 s `tourHang` watchdog (`:651`) gets an `rkHang` twin (no `rk`/`room`/`rkend` in 5 s after a reconnect while `rkOn()` → `endRk('restart')`).

### 3.11 Spectators

`watchCode` (`:1146-1152`) has no `only` gate: anyone with the code may watch (codes of rk courts are never shown or put in the address bar, so this is the reconnect-as-viewer case). The `room` message carries `rk:true, kind`, so the client sets `rkKind` for spectators too: no Ask button (`askSync` `:309` gains `&& !rkKind`), no invite menu (`body[data-rk] #room-menu{display:none!important}` beside `ui.css:1287`), `esc()` (`:720-721`) leaves for `rkKind === 'match'` as it does for tournaments, `setUrl(null)` for rk courts (`:549`: `shown = tk ? m.tour : rkKind ? null : room`). `rkvs`/`rkres` are never sent to spectators; `welcome.rank` is (section 4.4).

### 3.12 Lobby and status

`lobbyMsg()` (`:1070-1072`) gains `rk: { queued }` where `queued = [...rkQ.values()].filter(q => q.on && !q.series).length` (a count, no identity); `rkQueue`/`rkLeave`/`rkPair`/`rkResult` call `lobbyChanged()`. `/status.json` (`:38-40`) gains `rk: { queued, series: rkSeries.size }`.

---

## 4. Series format and the round state machine (inside `createRoom`)

Best of `RK_BEST` = 3 games, each first to `RK_WIN` = 7, win by `WIN_BY` (2), golden point at `RK_GOLD` = 11. Serve alternates per point (`:599`); the first server alternates per game. About 8-12 minutes a series with a phone paddle.

New closure state (`:293`): `const SERIES = MATCH && (opts.bestOf | 0) > 1; const games = [0, 0]; let game = 1, between = null;`

```
seat both ─ 3-2-1 ─ game 1 ─┬─ rkgame card (RK_GAME_GAP_S) ─ rkgo ─ 3-2-1 ─ game 2 ─┬─ [1-1: rkgame "Deciding game" ─ rkgo ─ 3-2-1 ─ game 3] ─ matchover{rk.done} (RK_DONE_S) ─ close('round')
                             └─ leave / drop+HOLD_S / CAL_S stall / no-show ─────────────────────────────────────────────────────────────────┘ forfeit → onResult once
```

- `point()` (`:597`): `final = wa > 0 && (score[winner] >= wa && diff >= WIN_BY || MATCH && score[winner] >= (opts.gold ?? TOUR_GOLD))`; the warm-up uses `opts.winAt`/`opts.gold` too (`opts.rk && score[winner] >= opts.gold` joins the MATCH term). Before the broadcast compute pressure: `gp` = the side one point from taking this game (`score[s] >= wa - 1 && score[s] - score[1-s] >= WIN_BY - 1`, or at `gold - 1`), `mp` = that side if `SERIES && games[s] + 1 > bestOf / 2`; broadcast `{ type: 'point', winner, why, score, final, gp: side|null, mp: side|null }`. Then `if (final) { if (SERIES && games[winner] + 1 <= opts.bestOf / 2) gameWon(winner); else endMatch(winner, false); } else …` (keep the `opts.tour.dirty` write guarded: `else if (MATCH && opts.tour) opts.tour.dirty = true`).
- `gameWon(w)`: `games[w]++`; `const rec = record(w, 'won')` (each game is one `match_log` row: `startMatch` builds a fresh `stats.newMatch` per game, `:474`); stop play exactly as `endMatch` `:496` does (`ball.live = false; ball.serving = null; serveAt = Infinity; counting = null; swings cleared`); `askEnd('gone')`; `opts.onGame(w, [...score], rec)`; `broadcast({ type: 'rkgame', winner: w, score: [...score], games: [...games], game, bestOf: opts.bestOf, serve: 1 - firstServe, names: names(), reg: regs(), rank: ranks(), next: RK_GAME_GAP_S })`; `between = { until: Date.now() + RK_GAME_GAP_S * 1000 }`. No `tellProfiles` between games (one private line per series, on the final card).
- `step()` (`:939` neighbourhood): `if (between && ms >= between.until) { between = null; game++; startMatch(1 - firstServe); broadcast({ type: 'rkgo', game, games: [...games], bestOf: opts.bestOf }); }`. `startMatch` resets the score, alternates the serve, re-arms the 3-2-1 and builds a fresh stats match; `rkgo` for game 1 is broadcast at the end of `startMatch` when `SERIES && game === 1`. Between games `over === null`, `ball.live === false`, `serveAt === Infinity`: `countdown()` (`:560`) and `sim()` wait; `slowSeat` (`:572`) needs `now >= serveAt`, so it counts nothing (critic-verified); `free()` (`:1051`) is false with both seats taken; `only` keeps strangers out anyway. `endMatch` sets `between = null`.
- The deciding point goes through `endMatch(winner, false)` as today; `games[winner]++` there when the last game was played out (not on a forfeit). `overMsg()` (`:492`): `rank: ranks()`, `tour: MATCH && !opts.rk ? { ...opts.info, gap } : undefined`, `rk: SERIES ? { games: [...games], bestOf: opts.bestOf, game, scores: X.scores (from opts.rk.scores), done: true, gap: secsTo(over.until) } : opts.rk ? { matt: true, next: secsTo(over.until) } : undefined`. MATCH branch (`:498-504`): `over.until = Date.now() + (opts.rk ? RK_DONE_S : TOUR_GAP_S) * 1000`; the log line becomes `ranked series over: side N 2-1` for rk rooms; `opts.onResult(winner, SERIES ? [...games] : [...score], !!forfeit)`.
- `record()` (`:483`): `kind = MATCH && !opts.rk ? (bot ? 'tourbot' : 'tour') : bot ? 'bot' : 'human'`; `stats.newMatch` (`:474`) gains `mode: opts.rk ? 'ladder' : 'casual', series: opts.rk && opts.rk.id || null` → `stats.js:67 newMatch` stores `m.mode`, `m.series` → `onEnd` passes them to `db.recordMatch`. The log line at `:486` is unchanged.
- `names()`/`regs()` (`:309-310`) get a sibling `ranks()` = `[0,1].map(sd => { const p = bySide(sd); return p && !p.bot && p.tier != null ? p.tier : null; })`; `join()` (`:720`) sets `me.tier = ws.rk ? ws.rk.tier : null` (a non-rk court sends `[null, null]`, so no emblem shows outside Ranked); `tellNames` (`:312`) compares and sends `rank`; `greet` (`:703`) `welcome` gains `rank: ranks(), venue: opts.rk ? 'stadium' : 'park', series: SERIES ? { game, games: [...games], bestOf: opts.bestOf } : undefined`. `info()` (`:1056`) is unchanged (rk rooms are never listed). Room export (`:1062`) gains `gamesNow: () => [...games]`.
- `PAD_FX` (`:1408`) gains `'found', 'game', 'series'`.

---

## 5. Trophies and ranks (`server/ladder.js`, a new pure CommonJS module; `web/emblems.js` mirrors its table)

### 5.1 The seven ranks, three divisions each (DIVISIONS: the owner's table of 2026-09-25 overrides the earlier floors)

| tier | name | rank floor | I / II / III | sticky floor | Matt while you wait (wire level) | Matt win | Matt loss | emblem (already drawn, `#rank-N`) |
|---|---|---|---|---|---|---|---|---|
| 1 | Bronze | 0 | 0 / 50 / 100 | yes | Rookie (0) | +10 | 0 | bronze shield, the ball |
| 2 | Silver | 150 | 150 / 200 / 250 | yes | Club (1) | +8 | 0 | silver shield with an inner rim |
| 3 | Gold | 300 | 300 / 350 / 400 | yes | Club (1) | +7 | 0 | gold hexagon with six rivets |
| 4 | Platinum | 450 | 450 / 500 / 550 | yes | Tour (3) | +6 | 0 | platinum octagon, double frame |
| 5 | Diamond | 600 | 600 / 650 / 700 | no (never below 450) | Tour (3) | +5 | 0 | cut cyan gem with a sparkle |
| 6 | Champion | 750 | 750 / 800 / 850 | no | Pro (2) | +4 | 0 | purple star with wings |
| 7 | Pro | 900 | 900 / 950 / 1000+ | no | Pro (2) | 0 | 0 | laurel crest, crown, prism ramp |

DIVISIONS: `RANK_W = 150`, `DIV_W = 50`; `divOf(trophies, tier) = 1 + min(2, floor((trophies - floor) / 50))` (I is the lowest, after III you rank up to the next rank's I; Pro III is 1000 and up, no cap). Player-facing rank string `rankName(tier, div)` = `Gold II`. Beside a name only the emblem shows (its title/aria is the full string). Every wire field that carries `tier` carries `div` beside it (section 9).

- As built: Bronze, Silver, Gold, Platinum, Diamond, Champion, Pro. The metals and stones give the order at a glance; the top two are what you are. `Pro` is also one of Matt's levels (`server/words.js:12 LEVELS`, so a guest cannot type it as a name); a rank's name is only ever shown as the emblem's label or aria-label, never in a name line, so no name can pose as a rank. No emblem carries a glyph (nothing to add to `W.BADGES`, `:17`).
- `server/ladder.js` exports `TIERS` (the table above: `{ tier, name, floor, sticky, matt, mattWin }`), `NAMES`, `FLOORS`, `ROMAN`, `RANK_W`, `DIV_W`, `DIVS`, `tierOf(t)`, `divOf(t, tier?)`, `romanOf(div)`, `rankName(tier, div?)`, `floorOf(tier)`, `divFloorOf(tier, div)`, `nextFloorOf(tier)`, `nextDivFloorOf(tier, div)`, `applyFloor(bestTier, t)`, `humanDelta(me, them, won, sweep)`, `halveWin(delta)`, `mattDelta(tier)`, `mattLevel(tier)`, `mattAward(delta, dayUsed, dayCap, trophies)`, `MATT_CEILING = floorOf(7) - 1` (899, DIVISIONS), `EXPORT_NAMES`. `web/emblems.js` `RANKS` names and `THRESHOLDS` are retuned to this table (`[0, 150, 300, 450, 600, 750, 900]`); `test/ladder.test.mjs` imports both (`createRequire` for the server side) and asserts they agree, and covers every division boundary.
- Rank names are never rendered in a name line. They appear as `aria-label`/`title` on the emblem beside a name and as the `<b>` under `emblemCard()` on the Ranked view and the VS card (DOM text, not the name's text node).

### 5.2 Floors

`applyFloor(bestTier, t) = max(t, floorOf(min(bestTier, 4)))`. Once Bronze to Platinum is reached, trophies never fall below that RANK's floor (season-less, permanent; DIVISIONS: the divisions inside it can be lost, a Silver III can fall to Silver I but never out of Silver): that is what makes queueing at 11 pm against the one other person online feel safe. Diamond, Champion and Pro can drop trophies and demote (down to, never below, Platinum's 450) so the top of the road stays meaningful and a floor-sitter cannot lose for free forever. `best_tier` / `best_div` are remembered and shown only to the owner. The view says it (section 2).

### 5.3 Matt games in the queue (solo progression)

- A **played-out win** against Matt while queued pays `mattWin[tier]` (tier at the start of the game), only when the game's verdict came back `ranked:true` from `stats.onEnd` (R8 `too_fast`, R9 `afk`, R18 `paddle_teleport`, R2 `revived`, `level_changed` all award nothing), only while `matt_day < RK_MATT_DAY` (40 per owner per UTC day; `matt_day`/`matt_day_at` in `ladder`), and never past `MATT_CEILING` (899, DIVISIONS: the top rank is only won against people).
- A loss, a leave, a drop: **0**. A negative Matt delta is dodgeable (a dropped socket is an abandon, `game.js:827`, ACCOUNTS.md Q15), so it would only punish the honest player who plays it out.
- Matt results are client-forgeable (ACCOUNTS.md Q14): the day cap and the ceiling bound a scripted client to ~35 days per solo climb to tier 6, and `bot_wins`/`bot_losses` sit in their own columns. About 25 sessions of six wins carry an honest player from Bronze to Champion; Pro needs people.

### 5.4 Human series

Both sides settle from the SAME pre-series trophies, frozen in `Q` at queue entry (a Matt bounty landing between games never changes the human delta).

```
gap  = clamp(them - me, -300, 300)
win  = 30 + round(gap / 25)  (+3 for a 2-0 sweep)      // 18 .. 45
loss = -(20 - round(gap / 25))                          // -32 .. -8
```

- `new_opponent` (R11c, `abuse.js:148`) on any game whose LOSER is the series loser (REVIEW FIX: the flag names the game's loser as the new player; a new player's own 2-1 win over a veteran carries the flag on the game the newcomer lost, and that must not halve the newcomer's win): the winner's delta is **halved** (min +8) instead of withheld. In Ranked the loser being new is not the winner's doing, and withholding would zero most early wins on a recruiting player base. It is bounded by R11 `feeder` by computer group (`abuse.js:71`, 6 losses with ≤ 2 distinct winner groups) and `NEW_GUEST_DAY` 30, not by R12 (a `new_opponent` game is unranked and never accrues in `winsOf`): say so in the ACCOUNTS.md rule table.
- Forfeit (leave, Q Q, tab closed past the hold, `CAL_S` stall) after the first strike of game 1: the leaver takes the full loss delta whatever the verdict (a ladder-only rule at settlement; `judge` untouched); the stayer takes the win delta **only if at least one game of the series came back `ranked:true`**, else `+0` with `why: ['left_early']`. REVIEW FIX: the game the forfeit cut short is judged only for what the players did; the flags the forfeit itself put on it (`early_forfeit`, `leaver_ahead`, and `afk` / `too_fast` from nobody striking or too few points, `RK_CUT`) are never held against the stayer, otherwise a leave timed right after `rkgo` (or a drop at 0-0) denied the stayer the win while the leaver paid the same either way. Only counted games accrue in `db.js:229-232` `pairs`/`winsOf` and `abuse.js:272-277` `L.pair`, so this is the one rule that lets R10/R12 bound a colluding pair (an in-memory per-pair counter resets on every deploy and is dodged by fresh guest devices).
- No-show (forfeit before the first strike of game 1, `!match.t0`): **void**, `rkres { void: true, why: ['noshow'] }` to both, no deltas; the stayer goes back to the FRONT of the queue (`since` kept) and hears `Your opponent never arrived. Still looking.`; the no-show's entry is removed.
- Friendly series (3.6) and voided series (5.5): 0 both ways, said up front (VS card) or explained after with the existing `WHY` words (`profile.js:62`).

### 5.5 Settlement: `rkResult(X, winner, games, forfeit, why)` (once per series, guarded by `X.done`)

Games are judged one by one through the existing `record()` → `stats.onEnd` → `abuse.judge` → `db.recordMatch` path. `stats.onEnd` (`stats.js:203`) returns two more fields: `owners: info.map(i => i ? i.owner : null)` and `flags: v.flags` (two lines); `rkGame` keeps `X.verdicts[i] = { ranked, flags, owners }` and `X.scores[i]`. Rules, in order:

1. `winner == null` (nobody seated, restart, `'gone'`): void, nothing written, `rkend gone` to any socket still around.
2. No-show: void (5.4).
3. **Counted** = every played game's flags contain none of: the `MATCH_WIDE` set (`abuse.js:12-13`: `legacy, revived, anon_opponent, same_computer, same_device, same_account, same_cid, early_forfeit, leaver_ahead, pair_cap, feeder, one_way, daily_cap`) except the forfeit's own flags on the forfeited game itself (`early_forfeit`, `leaver_ahead`, `afk`, `too_fast`: REVIEW FIX, 5.4); nor `anon`, `pad`, `origin_bad`, `too_fast`, `afk`, `paddle_teleport`, `ident_changed`. (`new_opponent` halves instead.) Not counted → both `+0`, `counted:false`, `why` = `abuse.why()` words only (never the opponent's network); the friendly flag from 3.6 is the same outcome announced earlier.
4. Deltas (5.4), then floors (5.2), then `tier = tierOf(trophies)`.
5. Owners are resolved at settlement **through the identity frozen in `Q` at queue entry / hello** (`rkOwnerOfId(q.ident)`: an account's owner row, else `db.ownerForDevice(devHash, now, { create: false })`, which follows a device merged into an account since; REVIEW FIX: never the socket's current state and never a verdict's owner id): a first-time guest's owner is created by game 1's `recordMatch` (`stats.js:149-160`) and is found through its device; stats switched off or a sign-out mid-series change nothing (the loss still lands); a deleted identity resolves to nothing (`saved:false`), never to a reused owner id. A seat still without an owner (every game capped, never identified, deleted mid-series) is skipped: `saved:false`, and the card says `Sign in or finish a game to keep trophies`. The Matt bounty (`rkMatt`) resolves the same way at award time, so a sign-in during the warm-up (which merges the guest owner away) lands the bounty on the account.
6. Write: `db.ladderApply({ owner, delta, won, vsBot:false, seriesId: X.id, side, now })` per seat, one transaction each: `trophies`, `tier`, `div`, `best_*`, `wins/losses/streak/best_streak`, and `UPDATE match_log SET delta_a|delta_b = ? WHERE series = ? AND (owner_a|owner_b) = ?`. Returns `{ trophies, tier, div, tierWas, divWas, floorHeld, delta (as applied, after the floor), dayLeft }` or null (`db.ok()` false → `saved:false`, the card says `Couldn't save trophies right now`). DIVISIONS: `tier` and `div` are recomputed from `trophies` on every write; `best_div` moves with `best_tier`. As built: a write happens only when the series counted or the delta is not 0; an uncounted series with nothing to write is `saved:true` (nothing was lost). A seat owing a delta with no owner yet (a first-time guest who finished no game, stats off, deleted) is `saved:false`.
7. `tell` each seat's socket (heard anywhere: the leaver is in the lobby by now) `rkres` (section 9); update both `Q` (`tier`, `trophies`) for the tile; delete both from `rkQ`; `rkSeries.delete`; `X.done = true`; `lobbyChanged()`. Log: `[CODE] ranked series over: side N 2-1 (+33/-20)`, codes and numbers only.

Matt games: `rkMatt(q, rec)` from the warm-up's `record()` path (`opts.rk` non-MATCH `endMatch`): `if (winner === human && rec.ranked && !forfeit)` → `db.ladderApply({ owner, delta: mattDelta(tier), won: true, vsBot: true, logId: rec.logId, now })` (the day cap and ceiling are applied inside; the one game's `match_log` row gets the delta) → `rkres { matt: true, … }` to the seat; loss/leave/drop: `rkres { matt: true, delta: 0, … }` on a played-out loss only (a counted loss still writes `bot_losses`). A played-out game whose verdict was not `ranked` pays nothing and says `counted:false` with the `WHY` word.

### 5.6 R10 by series (`db.js`, `abuse.js`)

A best-of-3 writes up to three counted rows, so `pairs` (`db.js:229-230`) must count series, not games, or the second series between two friends voids from game 1: `SELECT count(DISTINCT CASE WHEN series IS NULL THEN 'i' || id ELSE 's' || series END) AS n FROM match_log WHERE … AND (series IS NULL OR series <> ?)`: series ids and row ids are two number spaces, and the series being played is left out (REVIEW FIX: game 1's row made game 2 of the third series of the day `pair_cap`, voiding it after the VS card had promised trophies; the effective cap was 2). `recentPairs(a, b, since, series)`, `oneWay(a, b, since, series)` (R11b `winsOver`, per game, the same exclusion: REVIEW FIX, a clean best-of-3 between a pair at 4 one-way wins flagged `one_way` on its own game 2) and `L.pair(ka, kb, series)` take the current series id; `rkFriendly` at pair time passes none. In the link map (`abuse.js:271-277`), `result(wk, lk, ranked, series)` stores `series` on the `hist` entry and `pair()` counts distinct `(series ?? index)`, skipping the current one. `stats.onEnd` passes `m.series` to all three. `oneWay`/`recentLosses`/`recentWins` stay per game (they are about volume; R12's 30 counted wins a day means ~10 series a day, the practical cap).

### 5.7 Anti-abuse contract (unchanged: `server/abuse.js` R0-R18 are not loosened)

`abuse.judge` and `MATCH_WIDE` are respected verbatim; every Ranked game is judged as today. The ladder-side rules (leaver penalty, halved `new_opponent`, no-show void, friendly announcement) live in `rkResult`/`rkPick`. The matchmaker refuses same computer group/device/account/owner pairs outright and announces capped pairs as friendly, so R5/R10 never silently void play. `LOG_CAP_DAY` and `daily_cap` count per game as before.

---

## 6. Emblems: placements

`ui.js` imports `{ emblemEl, setEmblem, emblemCard, installSprite, RANKS } from './emblems.js'` and calls `installSprite()` at module load (before the first `lobbyView`). The sprite is in `<body>`, outside `UI:BEGIN`/`UI:END`, and `test/ui-mock.html` gets it through the real `ui.js` it imports (`:62`).

- **`ui.rankBadge(nameEl, tier)`**, a twin of `regBadge` (`ui.js:58-62`): inserts, updates (`setEmblem`) or removes `<span class="rank-badge" role="img" aria-label="Rank: Gold" title="Gold"><svg class="rank-em is-xs">…</svg></span>` as the sibling **after the `.reg-badge` if present, else after the name**, keyed by class; `tier` null removes it. Never inside the name text.
- Call sites: `setNames` (`ui.js:53`, from a new `rank: [t0, t1]` key), the result tally (`:126`, from `o.rank`), the VS card (`:956`, both sides), the spectator POV chip (`setView`, `:471-475`). Not the court list, tournament chips or brackets: rk rooms are unlisted and tournaments have no ranks (dead code and wider privacy surface).
- Sizes: `.is-xs` (1.25rem) beside names in the score tabs and tally; `.is-md` on the VS card and the HUD queue pill; `.is-lg` on the tile; `.is-xl` on the Ranked view head. CSS: extend the `:has(> .reg-badge)` grid rules at `ui.css:1484-1486` to `:has(> .reg-badge), :has(> .rank-badge)` with a third column; `.score-who:has(> .rank-badge)` keeps the name on one line with both badges; verify a 12-char name + reg badge + emblem in the 17.5rem `overflow:hidden` tab (`ui.css:181-212`) at 1280×720 and the ≤ 900 px chip-less layout; if it ellipsizes, drop to `.rank-em` 1.1em there.
- Where tiers come from: `welcome.rank`, `names.rank`, `matchover.rank`, `rkgame.rank`, `rkvs.vs.tier`/`you.tier`; the client keeps `ranks = [null, null]` beside `regs` (`main.js:38`), `cleanRanks = a => [0,1].map(i => Array.isArray(a) && Number.isInteger(a[i]) && a[i] >= 1 && a[i] <= 7 ? a[i] : null)` beside `cleanRegs` (`:138`), applied in `drawNames()` (`:141-149`: `rank: [false-side null, ranks[1 - side]]` for the player, both for a spectator) and in `showOver()`. A guest's owner is only known after `hello`, so `helloMsg` (`:1435-1441`) re-reads `db.ladderTier` for a seated rk socket and calls `tellNames()`.
- No 3D emblem over heads in v1 (the far head is the ball's backdrop, `docs/SCENERY.md` calm band). The VS card and the rank-up moment are DOM.

---

## 7. The stadium (`web/scene.js`, `web/scenery/`)

The park is a sunny afternoon; Ranked is a **night session under floodlights**: quieter, darker, more serious, built from the existing scenery toolkit (`S.merge/S.paint/S.tex`), no new textures on disk. `docs/SCENERY.md:7` says scenery work does not edit `scene.js`; the venue switch necessarily does (court colours, banner, trees, API), and SCENERY.md gets a line saying so.

### 7.1 Selection

- `scene.js:287`: `let venue = 'park'`. API (`:1290`): `setVenue(name) { if (!VENUE[name] || name === venue) return; venue = name; buildCourt(); if (scenery) scenery.setVenue(name); document.body.dataset.venue = name === 'park' ? '' : name; }` (delete the attribute for park). Pass `venue: () => venue` in the ctx at `:337`.
- `web/scenery/index.js`: `MODULES` (`:10`) becomes `{ park: [['sky', sky], ['park', park], ['flora', flora], ['wind', wind]], stadium: [['sky', sky], ['stadium', stadium]] }`. Factor `build/finish/reveal` (`:19-50`) into `buildVenue(name)` returning `{ S: makeShared(THREE, ctx, name), root, live, built, ready }`; `applyLight(S)` extracted from `reveal()` (`:35-42`, keeps `ctx.sun.position`; sets `ctx.fog.color` to `S.pal.fog` when that venue's sky built); `api.setVenue(name)`: hide the other root, build lazily on first call (staged, one module per macrotask as now), `applyLight` for the shown venue; `api.update` fans out to the visible venue only. Both roots stay built after first use so queue/cancel is a visibility flip. `pruneOldTrees` (`:53-59`) keys on the ≥ 300 m slab: the stadium `buildCourt` keeps that slab (dark asphalt) so the prune still works for the park's trees.
- `sky.js` reads `S.pal.night`: no sun sprite, glow, cirrus, marine bank or clouds; ~300 `Points` stars above 25° (never in the play frame: `visibleTop`); the far `curtain` ring lightened toward the horizon as city glow (`pal.glow`). Same dome shader (`sky.js:20-39`) with `PAL_STADIUM`'s elevation colours.
- Call sites: `lobbyView('ranked')` (behind the glass, section 2); `welcome` (`main.js:575`): `scene.setVenue(m.venue === 'stadium' ? 'stadium' : 'park')` before `setCourt`; `toLobby()` (`:363-374`): `scene.setVenue(rkOn() ? 'stadium' : 'park')`; `lobbyView('home')` → `'park'` when not `rkOn()`. `meta[name=theme-color]` (`index.html:9`) is set to `#0b1116` in the stadium and `#dfeef6` back by the same code.

### 7.2 The court (`scene.js:354-431`)

`COL` (`:76`) becomes `VENUE = { park: COL, stadium: { ...COL, grass: 0x23272e, apron: 0x1e2a3c, court: 0x173a6e, kitchen: 0xb35f2a, line: 0xffffff, screen: 0x0f1a2c } }`; `slab()`/`buildCourt()` read `VENUE[venue]`. Banner (`:395-403`): a stadium branch paints a flat `#0f1a2c` hoarding with a thin `#8fd6ff` top stripe, a `RANKED` wordmark once per screen at 40% white, no yellow dots, nothing white behind a baseline; both banner textures are built once at module level (cached: `buildCourt` disposes geometries but not materials, `:355`). Trees (`:416-429`): skipped when `venue !== 'park'`. Net, posts, line colour unchanged (`test/scene-next.mjs`'s fence detection holds). Kitchen a muted orange for readability.

### 7.3 Light

The sun **vector never moves** (`scene.js:308-311` shadow frustum, `S.sunDir`/`shadowPerM` at `shared.js:89`). `LIGHT_STADIUM` and `PAL_STADIUM` as already in `shared.js`. The ball is emissive (`scene.js:504`) and reads brighter than ever on the dark court; check shirt contrast in `test/scene-preview.html?venue=stadium`.

### 7.4 `web/scenery/stadium.js` (new, `create(THREE, S) → { group, update }`)

- (a) Tiered stands on four sides from |x| 12.5 / |z| 18.5 (outside `noTall`/`keepOut`), 12 rows rising 0.45 m per 0.9 m to ~6.5 m, merged boxes via `S.merge` + `S.paint` (`pal.stand/standAlt/parapet`), corner blocks (`pal.cornerBlock`), one Lambert draw, ~3k tris.
- (b) A crowd strip via `S.tex` (`pal.seat/seatAlt` seats, `pal.crowdBody`/`crowdHead` dotted heads, mid value, **static**: the far stand is the whole backdrop of the ball) on the riser faces; one draw.
- (c) An LED hoarding ring at |x| 9.5 / |z| 15 (`pal.hoarding` with a `pal.led` edge), `MeshBasicMaterial`; one draw.
- (d) Four 18 m masts at (±16, ±22) (`pal.mast`, heads `pal.lamp` emissive), outside `inCorridor`; one draw.
- (e) A TV gantry gap on +x for |z| < 3, x 12-14.5, so `broadcastPose` (`scene.js:959-960`, X = 13.05, Y = 5.5) is not inside a stand.
- (f) On `!S.low` only: four thin additive spotlight cones (apex ≤ 12°, opacity .07, `depthWrite:false`, `fog:false`, colour `pal.beam`) and a soft ground light pool (the `park.js:10-92` band technique). Skip the wind/flora/park modules.
- Budget ≈ 8 draws / ~10k tris / < 0.5 MB, measured with `test/scene-next.mjs:112-121`'s cost block and `window.__scenery.census()` under `?venue=stadium` (add the param to `test/scene-preview.html:23`).

### 7.5 Page tint

`body[data-venue="stadium"]` variants: `html,body` background (`ui.css:82`) `#0b1116`; `.menu-bg` (`:109`) a navy gradient; `.glass` (`:517-521`) `linear-gradient(180deg,rgba(10,16,30,.55),rgba(14,22,40,.5))` with `brightness(.9)` (blur unchanged); `.menu-glass .menu-head/.menu-foot` (`:526-527`) `rgba(14,22,40,.9)`; `.veil` (`:119`) `rgba(10,16,30,.86)` (the `.veil.is-night` class the new cards use); `--ink`, `--ink-strong`, `--ink-soft` swapped to light values on `body[data-venue="stadium"]`; the HUD keeps `--me`/`--them`. `body[data-rk]` (set by `ui.rkCourt(kind)`, the `tourCourt` twin at `ui.js:901`) hides `#room-menu` (`ui.css:1287` pattern).

### 7.6 Sound of the place

Default: **no crowd bed** (cut for v1; open question). The venue is heard through the new jingles (section 8.11) and the pressure hit (8.6).

---

## 8. Presentation: every card, copy and timing

New overlays in `OVERLAY` (`ui.js:23`): `'rk-vs'` (the `#screen-tour-vs` section reused with ids added and `.vs-card.is-ranked`), `'rk-game'` (new `<section class="screen veil is-night" id="screen-rk-game" data-screen="rk-game">`). New one-shots in `OV` (`ui.js:11`): `'rank-pop': 'is-pop'` (emblems), `'ov-trophy-pop': 'ov-trophy'`, `'ov-pip-in': 'ov-pip'`. New `ui.js` exports: `tilesFit rkTile rkView rkCourt rkPill setSeries setPressure rkVs rkGame trophyRow rankBadge rankUp gameBanner` (add every one to `test/menu.mjs:219 UI_NAMES` and `test/ui-next.mjs:39`; call the optional ones from main.js as `ui.fn?.()`).

### 8.1 Find a match

Button text → `Searching` with `ov-press` (600 ms); `request({ type: 'rk' })`. `request()` settles on `room` (a warm-up), `rk` (a snapshot: pair at once) or `rkfail` (add both to the settle list at `main.js:302`/`:325`). `rkfail` toasts: `nocid` `Reload and try again`; `busy`/`full` `Ranked is full right now. Try again in a minute`; `addr` `Two players on your network are already in the queue`; `nostats` `Ranked couldn’t save your trophies. Reload and try again` (the old `Turn on Save my stats…` copy REMOVED 2026-09-28 (NOTES 116); today it only follows a missing hello); `intour` `Leave your tournament first`.

### 8.2 The warm-up court (stadium, vs Matt)

- **Queue pill** `#rk-pill` (`role="status"`, the `.rally` lozenge style, bottom-centre above `#keys`, `--z-hud`, hidden under any overlay like the toast): `● Finding an opponent · 0:42`; `small`: `Matt keeps you warm`. Enters with `ov-pill-in` (380 ms); the dot breathes (`glow-pulse` `--d-pulse`); the timer is `textContent` once a second (no animation); every 30 s the text does `ov-pop`. `ui.rkPill({ on, since, queued })`. Every 30 s the phone gets `padFx('queue')`? No: one `padFx('play')` as today; the phone learns nothing new here.
- Scoreboard: `them: 'Matt', themSub: 'Club'` (from `botinfo`), the emblem beside `You`; `ui.setBot(null)` (no `1 2 3 4` hint: `main.js:143` adds `&& !rkKind`). Settings: the Difficulty row hidden, note `Ranked: Matt is fixed while you wait` (`ui.setSettings({ rkWarm: true })`, `ui.js:432`); Leave button `Leave queue`; `pause` allowed.
- Matt game over: the result card (`matchResult`) with `o.rk = { matt: true, next }`: stamp `GAME!` / soft `GAME` as today, title `You beat Matt` / `Matt wins`, note `Next game in 6` with the `rematch-bar` (`countWord = 'Next game in '`), no vote (`vote:false`), the trophy row (8.7) `+8 · 248` rolling from 1100 ms, `#result-save` as today. Closed by `rematchon`. `dayLeft === 0`: the trophy row reads `Daily Matt trophies reached`. The pill stays.

### 8.3 MATCH FOUND (`rkvs`, overlay `rk-vs`, `RK_VS_S` = 5 s)

`main.js` `rkMove(m)` (the `tourMove` model, `:334-338`): `clearTimeout(rkHang); rkMoving = true; ui.settings(false); if (ui.currentScreen() === 'lobby') screen(null); scene.setFrozen(true); scene.jingle('found'); padFx('found'); ui.rkVs(m); rkVsT = setTimeout(close, ((+m.at || 5) + 10) * 1000)` (the seat never came). If the card arrives while `camera`/`connect`/`calibrate` is up it shows over that screen (`#screen-rk-vs{z-index:calc(var(--z-screen) + 1)}` like `game-full`, `ui.css:308`) and the set-up carries on into the series court.

`ui.rkVs({ vs, you, bestOf, target, friendly, side })` on `#screen-tour-vs` markup (give the left name `id="vs-me"`; add `<div class="vs-em" id="vs-me-em"></div>` / `#vs-them-em` under each name): `.vs-card.is-ranked` navy variant (border `--line`, ground `#0f1a2c → #14213a`, names white, VS in a cyan-white gloss).

| t | beat |
|---|---|
| 0 | veil `.is-night` fades in (320 ms); `#vs-round` **`MATCH FOUND`** in caps slams (`ov-slam` 380 ms, letter-spaced, cyan). Sound `found` (8.11). |
| 400 | the two sides slide in (`vs-in-l`/`vs-in-r`, 500 ms, existing): chip · `You` / opponent name (+ reg badge) |
| 900 | `emblemCard(tier, 'is-md')` with `.is-inverse` lands under each name (`vs-emblem-in` 360 ms: scale .6 → 1.1 → 1, opacity); the VS mark pops (`count-pop`, existing) |
| 1000 | `#vs-target`: `Ranked · Best of 3 · First to 7, win by 2`, or **`Friendly match, no trophies`** when `friendly` |
| 3500 | `#vs-ready` `caps` `Get ready` with a slim `.rematch-bar` draining to 5000 |
| 5000 | the series `welcome` closes it (`main.js:577` gains `'rk-vs'`); the server's 3-2-1 follows |

The opponent's trophy COUNT is never sent (only `vs.tier`); the card shows the emblem and the rank name, never a number for them. Reduced motion: everything static from frame one; the bar keeps its 1 s transition.

### 8.4 Game start (`rkgo`)

Closes `rk-game` if up; `ui.gameBanner(`Game ${game} of ${bestOf}`)` = the `#banner` pill (`joinBanner` style, `banner-drop` 1.9 s), then the server's `countdown` (`3, 2, 1 · Get ready`, `ui.countdown`). `main.js`: `over = null; struck = false; ms = null; rally = 0; ui.setRally(0); ui.setSeries({ …, game })` (the `rematchon` handler `:622` **minus** `redialDue()`: a sign-in toggle must never drop the socket mid-series; `midMatch()` `:230` adds `|| rkKind === 'match'`). `padFx('play')` re-arms the phone. `serve` (`:641`) also closes `'rk-game'` as a fallback.

### 8.5 In a game

As today (callouts, `Your point` / `Sam scores` banners, confetti on a won point). HUD additions: emblems beside names; **series pips** `#series` beside `.rally` (`ui.setSeries({ bestOf, games, game, side })`: `bestOf` pips per side in the lozenge, `.is-me`/`.is-them` filled by wins, the current game's pip with a pulsing outline, unplayed hollow; `chip-in` 320 ms on change). Settings note `Ranked matches can't pause` (`ui.js:432`, `syncSettings` sends `rkMatch: rkKind === 'match'`); Leave button `Forfeit` (`forfeits()` `:237` includes `rkKind === 'match'`); the Q toast says forfeit.

### 8.6 Game point and match point (`point.gp`/`point.mp`)

`ui.setPressure({ side: 'me'|'them'|null, kind: 'game'|'match' })`: the pressing side's `.score-num` gets `.is-pressure` (a .125rem outline ring in that side's colour, `glow-pulse` on `--d-pulse`); the rally lozenge's `small` swaps `Rally` for **`GAME POINT`** / **`MATCH POINT`** (`swapText` with `ov-pop`, caps, the pressing side's colour). Sound: one soft floor-tom hit (`tone 90→60 Hz, .25 s, gain .2`) when pressure first appears (`scene.onEvent` reads `m.gp`/`m.mp` on `point`; `SCENE_EVENTS` already carries `point`). Cleared on the next `point` without it, on `serve` of a new game, and on `rkgame`. Never a banner over the court: the scoreboard tells it.

### 8.7 GAME CARD between games (`rkgame`, overlay `rk-game`, `RK_GAME_GAP_S` = 6 s)

Not `#screen-match` (fully opaque, fires the jingle and the vote). `ui.rkGame({ won, nameMe, nameThem, game, bestOf, games, score, serve, next, deciding, watching })`, `$('screen-rk-game').dataset.beat = won ? 'win' : 'lose'` set before `showOverlay`:

| t | beat |
|---|---|
| 0 | navy veil .85 (the court and the stands stay visible, darkened); `.round-card` (a `.panel`, 44rem) `panel-in` 600 ms; phone `game` (won) / nothing (lost) |
| 114 | stamp `#game-slam` **`GAME 1`** in the winner's colour (`ov-slam` win / `ov-slam-soft` lose). Sound `game` / `gamelose` (8.11) |
| 380 | title `You take game 1` / `Sam takes game 1` (spectator: `Sam takes game 1`), `ov-title-pop` |
| 560 | the game score `7` `.tally-dash` `4` in tally digits (final from frame one, the `--to` counter roll 600-1040 ms, existing CSS) |
| 700 | series pips `<ol class="pips" id="game-pips">`: two rows (You / Sam) of `bestOf` dots, filled by wins in each side's colour, hollow for games to come (`ov-pip-in` 320 ms each, 80 ms stagger); the pip that just filled `ov-pop` at 1000 |
| 1100 | note: `Game 2 in 6` with the draining bar (`drawCount` `:152` with `countWord = 'Game 2 in '`); at 1-1 the caps line **`Deciding game`** above it and the veil a shade warmer (`data-beat="win"` + `.is-deciding`); second line `small` `Sam serves first` / `You serve first` (from `serve`) |
| 1100+ | won: 46-piece confetti behind the card. Lost: none |

Closed by `rkgo`. Reduced motion: stamp hidden, everything static, the bar keeps its 1 s transition. `#screen-rk-game` gets `data-fit` on the card; `OVERLAP` pairs vs `keys`/`toast` in `shoot.mjs`.

### 8.8 SERIES CARD (`matchover{ rk.done }`, overlay `match`, `RK_DONE_S` = 12 s)

`matchResult(o)` with `o.rk = { games, bestOf, scores, forfeit }` and `o.rank`; `dataset.beat` as today so the stamp/crash sync at 114 ms is untouched.

- Stamp **`MATCH!`** (win) / soft `MATCH` (lose); forfeit: empty as today.
- Title `You win the match` / `Sam wins the match` (spectator: `Sam wins the match`); note `2-1` (forfeit: `Sam left` as today); `#result-pips` row above the tally (final pips, `.is-final`); the tally shows **games** (2 and 1, `--to` roll) and a `small` line of game scores `7-4 · 5-7 · 7-3` under it; emblems beside the tally names.
- **Trophy row** `<div class="trophy" id="trophy" hidden>` between the tally and `#result-stats`, filled by `rkres` (8.9). The stats pills (`resultStats`) stay for the last game only when `ms` saw it from 0-0.
- Buttons: `Play again` (`#btn-rk-again`, primary, focused at 60 ms) and `Leave` (`#btn-rk-leave`); no vote (`vote:false`, `ui.rematch` not called for votes); bar `countWord = 'Back in '` with `rk.gap`. `Play again` sends `{ type: 'rk' }` (heard on the card, 3.3): the server quits you and queues you; the card closes on the next `room`/`rk`. `Leave`/Esc → `leave` → `closed round` (silent) → the Ranked view.
- Loss: no shake, no flash (existing `lose` beat), silver medal, focus on `Play again`. The copy never scolds.
- Opponent forfeit: note `Sam left`, trophy row `+30` with `small` `Walkover` (or `No trophies · They left before a game finished` when nothing counted).
- Own forfeit: you are in the lobby; `rkres` (heard anywhere) shows a one-line notice on the Ranked view `Forfeit: 20 trophies` and the road updates.
- `profile.matchover(tour, quiet)` (`profile.js:65`, `main.js:619` passes `quiet = rkKind === 'match' && !(m.rk && m.rk.done)`): the sign-in nudge and the "saved on this device" notice show once per series, on the final card only; the per-game `profile` messages are not drawn (main.js's `profile` handler `:620` returns early while `rkSeries && !rkSeries.done`).

### 8.9 Trophy count-up (`rkres`)

`ui.trophyRow(r)`: `#trophy` = `emblemEl(tier, 'is-md')` · `<b class="trophy-n" id="trophy-n">` · `<span class="trophy-d" id="trophy-d">`. `textContent` of the number = the new total from frame one; `--from`/`--to` on it; `::before` counts via the `@property --n` counter over 900 ms starting at 1100 ms (after the tally lands), `ov-ink` masking as the tally does; each 100 ms of the roll ticks a tiny click (`tone 2000 Hz, .02 s, gain .05`, 8 ticks). The delta pill pops (`ov-pop`) at 1000 ms: green `+33`, grey `−20`, `±0` at a floor with `small` `You keep Gold`. `counted:false` → `No trophies` + the `WHY` word (`profile.js:62`, plus `left_early: 'They left before a game finished'`, `noshow: 'Your opponent never arrived'`); `void` → `Void`; `saved:false` → `Couldn't save trophies right now` / `Sign in or finish a game to keep trophies`. Reduced motion: `.trophy-n::before{display:none}` in the `:500` block.

### 8.10 Rank up and rank down

`tierWas < tier`: at 2100 ms (the count landed) `ui.rankUp(tier)`: the emblem swaps (`setEmblem` + `restart(el, 'is-pop')`, the existing `rank-pop`), `.medal-rays` clone opens behind it (`ov-rays-in`, then `ov-spin` 8 s), the stamp re-fires **`RANK UP!`** with `.is-rank` (colour `RANKS[tier-1].colour.mid`), `#result-note` becomes the rank name (`Gold`) with `small` `Bronze to Platinum are yours to keep`, `scene.jingle('rankup')`, 120-piece confetti in `colour.mid`/`--gold-2`/white; phone `series`. Under reduced motion the new emblem and number are static from frame one (`ui.css:508` already lands `.is-pop`). `tierWas > tier`: the emblem does `ov-down` (scale 1 → .9, 300 ms), note `Down to Diamond`, no sound.

### 8.11 Sounds and the phone

`sfx.jingle` (`scene.js:1061-1072`) and the whitelist at `:1297` gain: `found` (low thump `tone 120→50` at 0, a rising fifth G4→D5 at 120 ms, a short filtered-noise shimmer at 400 ms), `game` (the pickup's three notes G-C-E only + one soft crash at 114 ms), `gamelose` (the two-note A→G sigh, no chord), `rankup` (the champ sparkle 1318/1568/2093 Hz + second crash, no thump). `jingleOut()` (`:1040`) fades the previous one in 60 ms, so never two within 800 ms (the series card's `win` fires at 0 and `rankup` at 2100). `PAD_FX` (`game.js:1408`) and `web/pad.js:133 FX_TEXT` gain `found: 'Match found'`, `game: 'Game won'`, `series: 'Match over'`; `pad.js:134-140 fx()` buzzes `found [80, 60, 80, 60, 200]`, `game [120]`, `series [300]`. `padPhase()` (`main.js:440`) is unchanged.

### 8.12 Ends and errors

`rkend restart` → toast `Updating. The Ranked match is void, no trophies changed.` and the Ranked view; `rkend gone` → the view; a `closed` on an rk court with reason `round|rkmatch|empty|away` is silent (`main.js:568` gains `rkKind && […]`). `window.__stats.rk = { phase, kind, tier, trophies, series }` beside `tour` (`main.js:37`) for browser tests.

---

## 9. Server protocol (every message, with fields)

Client → server:
- `rk { name }` — join the queue (from the lobby, or from a finished rk series card = Play again).
- `rkleave {}` — out of the queue (lobby or warm-up); ignored in a live series (`leave` forfeits).
- `leave {}` — warm-up: out of the court AND the queue; series: forfeit; result card: just out. Everything else unchanged (`paddle`, `swing`, `pause` warm-up only, `status`, `ping`, `net`, `padfx`).

Server → client (beside today's `room`, `welcome`, `names`, `state`, `countdown`, `serve`, `point`, `hit`, `matchover`, `profile`, `closed`, `hold*`, `wait*`, `paused`, `botinfo`, `joinfail`):
- `rk { phase: 'queue'|'vs'|'match'|'off', you: { tier, div, trophies, floor, divFloor, next, nextDiv, best, bestDiv, matt: { level, win, dayLeft } }, queued, place, since }` — on entry, on change (≤ 4 Hz), `phase:'off'` when the entry ends. Settles `request()`. DIVISIONS: `div` 1..3; `divFloor` = where this division starts, `nextDiv` = where the next division (or the next rank) starts, null at Pro III; `next` = the next RANK's floor, null at Pro; `best`/`bestDiv` = the best rank and division reached. `since` is a wall-clock ms timestamp.
- `rkfail { why: 'nocid'|'intour'|'nostats'|'addr'|'full'|'busy' }`. REVIEW FIX: `nostats` also reaches a queued socket that switches stats off (an old tab only: the switch was REMOVED 2026-09-28 (NOTES 116); the entry ends, 3.9) or never says hello within `RK_ARRIVE_S`; `busy` also answers an `rk` within `RK_COOL_S` of the socket's own leave from the queue; `addr` is per computer key.
- `room { code, public:false, role:'player'|'spectator', rk:true, kind:'warm'|'match' }`.
- `welcome { side, role, court, names, reg, rank:[{ tier, div }|null, { tier, div }|null], venue:'stadium'|'park', series?: { game, games:[a,b], bestOf } }`. DIVISIONS: every `rank` array (welcome, names, matchover, rkgame) holds `{ tier, div }` objects, null for an empty seat, Matt, or any seat outside Ranked; a court outside Ranked says `venue:'park'` and `rank:[null,null]`. `welcome` goes out when THAT seat sits down: the second seat's rank arrives in the `names` that follows.
- `names { names, reg, rank }`. `botinfo { …, reason:'ranked' }` on a refused `bot`.
- `point { winner, why, score, final, gp: 0|1|null, mp: 0|1|null }`.
- `rkvs { vs: { name, reg, tier, div }, you: { tier, div }, bestOf, target, friendly, at, side }` — the opponent's trophy count is never sent (DIVISIONS: `div` beside every `tier`).
- `rkgo { game, games, bestOf }`. `rkgame { winner, score:[a,b], games:[a,b], game, bestOf, serve, names, reg, rank, next }`.
- `matchover { winner, score, forfeit, rematchBy, names, reg, rank, rk: { games, bestOf, game, scores:[[a,b]…], done:true, gap } | { matt:true, next } }` (`tour` absent for rk rooms; the client's `vote = … && !T && !m.rk`). `rank` here is the seats' ranks as they were when the series ended (a forfeit has emptied a seat by now).
- `rkres { matt?:true, void?:true, saved, won, delta, trophies, tier, div, tierWas, divWas, floorHeld, counted, why: string[], dayLeft?, games?, scores? }` — to each seat's socket only (a leaver in the lobby included). DIVISIONS: `div`/`divWas` beside `tier`/`tierWas`; a division up inside one rank is `tierWas === tier && divWas < div`. `delta` is the change AS APPLIED (after the floor: `-7` when a `-26` loss was held at 150, `0` at a floor already sat on, with `floorHeld:true`). `why` words: the existing `WHY` set plus `left_early`, `noshow`; a friendly says `not_counted`. A Matt `rkres` carries `dayLeft`; a series `rkres` carries `games` and `scores`.
- `rkend { why: 'restart'|'gone' }`. A socket back with `&rk=1` whose series settled while it was down (held) gets its `rkres` instead (3.9, REVIEW FIX).
- `closed { reason: 'rkmatch'|'round'|'empty'|'away' }` (`rkmatch` reaches only a warm-up's spectators).
- `lobby { …, rk: { queued } }`; `/status.json { …, rk: { queued, series } }`.
- `profile { … }` per game, unchanged fields (`ranked` still means counted); the client draws it on the final card only.

No message carries a cid, an owner id, an address, or the opponent's trophies (extend the cid-leak check to every `rk|rkvs|rkgo|rkgame|rkres|rkend|rkfail|lobby` frame).

DEVIATION (as built in workstream A, none changes a message name; fields are only added):
- `rkleave` from a warm-up answers `rk { phase:'off' }` (the entry ended) and then the lobby list; no `closed` is sent (the seat was left the way `leave` leaves it). `rkleave` from the lobby with a live entry answers the same; from a live series it is ignored; on a finished series card it is ignored too (use `leave`, or `rk` = Play again).
- `rk` while already queued answers a fresh `rk { phase:'queue' }` snapshot (no `room`).
- `/api/me` gains `ladder` (the signed-in account's ladder block, null for a guest, who reads `/api/stats` with the device id). The ladder block (`/api/stats profile.ladder`, `/api/me ladder`) is `{ trophies, tier, div, floor, divFloor, next, nextDiv, bestTrophies, bestTier, bestDiv, best_tier, best_div, bestTierAt, wins, losses, streak, bestStreak, botWins, botLosses, mattDayLeft }` (`best_tier`/`best_div` duplicate `bestTier`/`bestDiv` because the DIVISIONS note spells them that way).
- A no-show (`rkres { void:true, why:['noshow'] }`) also closes the series court with `closed round` right away; the stayer then gets a fresh `room { rk, kind:'warm' }` (back at the front of the queue) and the no-show hears nothing more (its entry is gone). With NOBODY seated at `RK_ARRIVE_S` the court closes as `empty` and both hear `rkend gone` (void, nothing written).
- After a settled series the socket's Ranked entry is gone; `rk` on the finished card is Play again (out of the card, a new warm-up or a VS card at once). A `leave` from the card is silent. A socket returning with `&rk=1` after its warm-up closed (its old socket dropped: the court goes with it) hears `rkend restart|gone` and must queue afresh (RANKED.md 3.5 accepted this).
- `botinfo { reason:'ranked' }` answers `bot` on BOTH the warm-up and the series; `pause` is allowed on the warm-up only.
- `lobby` and `/status.json` carry `rk: { queued }` / `rk: { queued, series }` as specified; a queued player is not in the lobby set, so the count reaches them through their `rk` snapshot (`queued`).
- `point.gp` / `point.mp` are `null` when both sides are at game point with a tied score (only possible with `WIN_BY` 1 in tests).

DEVIATION (client, NOTES 113):
- An `rkres` that answers a `&rk=1` reconnect (the rkLate replay) ends the watchdog like `rkend` does: the client leaves the dead court for the Ranked view and shows the line there (`+33 trophies`, `Forfeit: 20 trophies`), never the restart toast.
- The view's line puts the applied change first: void, then `Forfeit: N trophies` / `−N trophies`, `+N trophies`, the floor (`You keep Silver`, `Forfeit: you keep Silver`), and `No trophies: that match didn’t count` only when nothing moved and I did not leave. The card's trophy row uses the same order. `rkres` has no `forfeit` field: the client takes Walkover from the series card's `matchover.forfeit`, and knows its own forfeit from its Leave / Q Q / stats-off (or `why: ['left_early']` on a loss).
- A spectator of a Ranked court never sends `&rk=1` and never gets the queue state or pill: it reconnects with `&room=CODE&watch=1` like any spectator.
- `rkfail` while on a Ranked court (Play again refused, no hello; stats off only from an old tab) takes the client off that court at once (the server already pulled the seat; no `closed` follows). The VS card's fallback does the same from a warm-up.
- A sign-in or sign-out (or, before 2026-09-28, a stats switch) while queued waits: the socket is not reopened while `rkOn()`, it opens once Ranked is left (a warm-up has no hold, so a redial would drop the entry). A forfeit's `rkres` is waited for too.
- Q, C, B and 1-4 do nothing under the VS card (the seat is already drawn).

Client state (`main.js`, beside `tour` `:317`): `rkKind = null|'warm'|'match'`, `rkQueued = false`, `rkMoving = false`, `rkSeries = null|{ bestOf, game, games, done }`, `rkYou = { tier, trophies }`, `ranks = [null, null]`; `rkOn = () => rkQueued || !!rkKind`. `room` handler (`:544`): `tk` as today; `const rkk = m.rk === true && (m.kind === 'warm' || m.kind === 'match') ? m.kind : null; moved = (tk === 'match' || rkk === 'match') && m.role !== 'spectator' && room !== m.code && room != null`; `rkKind = rkk; ui.rkCourt(rkk); if (rkk) noBot = true; shown = tk ? m.tour : rkk ? null : room`. `toLobby` resets `rkKind, rkSeries, ranks, rkMoving` (keeps `rkQueued` only while the VS card is up), calls `scene.setVenue(rkOn() ? 'stadium' : 'park')`, and redirects `ui.lobbyView('ranked')` when the court that closed was an rk court (the `tourScreen(true)` spot, `:372`).

---

## 10. Data and privacy

### 10.1 Migration 2 (`server/db.js:24 MIGRATIONS[2]`, run by `open()` at `:165-167`)

```sql
CREATE TABLE ladder (
  owner_id      INTEGER PRIMARY KEY REFERENCES owners(id) ON DELETE CASCADE,
  trophies      INTEGER NOT NULL DEFAULT 0,
  tier          INTEGER NOT NULL DEFAULT 1,      -- 1..7 = tierOf(trophies), stored for the one-read seat lookup
  best_trophies INTEGER NOT NULL DEFAULT 0,
  best_tier     INTEGER NOT NULL DEFAULT 1,      -- the sticky floor (tiers 1..4) and the road's best mark
  best_tier_at  INTEGER,
  wins          INTEGER NOT NULL DEFAULT 0,      -- series vs people
  losses        INTEGER NOT NULL DEFAULT 0,
  streak        INTEGER NOT NULL DEFAULT 0,
  best_streak   INTEGER NOT NULL DEFAULT 0,
  bot_wins      INTEGER NOT NULL DEFAULT 0,      -- queue games vs Matt, kept apart (forgeable, ACCOUNTS.md Q14)
  bot_losses    INTEGER NOT NULL DEFAULT 0,
  matt_day      INTEGER NOT NULL DEFAULT 0,      -- Matt trophies awarded this UTC day
  matt_day_at   INTEGER NOT NULL DEFAULT 0,      -- the day number they belong to
  updated_at    INTEGER NOT NULL
);
ALTER TABLE match_log ADD COLUMN mode    TEXT    NOT NULL DEFAULT 'casual';   -- 'casual' | 'ladder' (kind keeps human/bot: the CHECK cannot be widened)
ALTER TABLE match_log ADD COLUMN series  INTEGER;                             -- series id shared by a series' games (NULL for casual and Matt games); boot second x 1e6 + n, unique across restarts (REVIEW FIX)
ALTER TABLE match_log ADD COLUMN delta_a INTEGER;                             -- trophy change written at settlement on that side's rows, NULL otherwise
ALTER TABLE match_log ADD COLUMN delta_b INTEGER;
```

A separate table, not `profile` columns: `profSet` (`db.js:200-201`) is a positional full-row update used by `fold` (`:279`), `recordMatch` (`:393`) and `addTitle` (`:404`). Statements in `prepare()`: `ladGet`, `ladPut` (upsert like `botPut` `:204-206`), `ladTier` (`SELECT tier, trophies, best_tier FROM ladder WHERE owner_id = ?`), `logDeltaA/B`; `logIns` (`:225`) and its call (`:364`) gain `mode, series`; `pairs` (`:229`) counts `DISTINCT coalesce(series, id)`. New exports: `ladderOf(owner)`, `ladderTier(owner)`, `ladderApply({ owner, delta, won, vsBot, seriesId, side, now })` (guarded, never throws, null when not `ok()`; applies the Matt day cap and ceiling itself when `vsBot`), `recentPairs` unchanged in signature. `recordMatch` accepts `m.mode`, `m.series`. `fold()` (`:274-288`): `trophies/best_*/tier = max` (a merge must never double a position), `wins/losses/bot_* = sum`, `streak/best_streak` the account's / max, `matt_day = min(RK_MATT_DAY, sum)` when the same day. `deleteOwner`: the cascade takes `ladder`; `match_log` deltas identify nobody. `sweep`: unchanged (guest trophies expire with the guest owner: 90 d after the last recorded match, 7 d if only one; a rotated device id orphans them like stats). `TABLES` (`:524`) += `'ladder'`. `profileOf` (`:428`) adds `ladder: { trophies, tier, floor, next, bestTrophies, bestTier, bestTierAt, wins, losses, streak, botWins, botLosses, mattDayLeft }` (a missing row = tier 1 zeros). `exportOf` (`:438`): `format: 'poddle-export-2'` (update `test/accounts-unit.test.mjs:478`), each match gains `mode` and `trophyDelta` (the requester's side), `profile.ladder` rides along; the JSON still never contains the string `owner`. Rehearse the migration on a `vacuumInto` copy of the live v1 file (`admin.js backup`) before the first deploy: a failed migration makes `db.open` return false and the game runs with stats off.

### 10.2 What others see

Only the **rank tier** (the emblem and its name) beside a name, to the opponent and to anyone watching a Ranked court (VS card, scoreboard, result card). Trophy counts, deltas, records, Matt day counts stay private to the owner. Nothing new in the browser (no caching of tier/trophies; `poddle.*` keys unchanged).

### 10.3 Legal and inventory pages (same commit as the first client surface that shows an emblem; `CLAUDE.md` "Legal pages")

- `web/privacy.html`: header comment (`:3-14`); Summary `:106` and For teens `:116`: "They are shown only to you, except your rank emblem in Ranked mode, which your opponent and anyone watching that court can see"; section 2 rows `:165-166`: add "your Ranked trophies, rank, best rank and the date you reached it, Ranked wins and losses, a count of Matt games awarded each day, and each match's mode and trophy change"; section 4 `:215-216` new bullet: "Rank emblem: if you play Ranked, the emblem of your current rank is shown beside your name to your opponent and to anyone watching that court. It shows which of the seven ranks you have reached, never your trophy count or your record"; section 7 `:269-272`: trophies follow the same retention as statistics; section 13 GDPR table `:345`: rank/trophies on the statistics row and a new row "Rank emblem shown to other players in Ranked mode: necessary to provide the mode you chose to enter (contract, Art. 6(1)(b))"; CCPA `:355` "game statistics and rank"; section 15 `:368` a dated line; `Last updated` `:94` and `dateModified` `:77`.
- `web/terms.html:172-173`: the emblem exception to "shown only to you"; "trophies may be withheld, corrected or reset under the fair-play rules"; `Last updated` `:79`, `dateModified` `:62` (`test/seo.test.mjs:103-105` fails if the two disagree).
- `web/sitemap.xml` `<lastmod>` for `/`, `/privacy.html`, `/terms.html`, `/how-to-play.html` (`seo.test.mjs:115` pins the exact loc list: no new page).
- `CLAUDE.md:29-42` inventory: the `ladder` table and the four `match_log` columns on the database line; the Public line gains "rank emblem (tier only) beside names in Ranked to opponents and spectators"; the "Stats are private" clause gets the exception. `docs/ropa.md:32-47`: sections 3 and 4 (data, recipients, the R10-by-series note). `docs/ACCOUNTS.md` 2.2 DDL, 2.3 API, 8.2 Profile shape, 8.3 messages, the rule table (R11c halving bounded by R11), Q14 note. `NOTES.md` **section 103** (last is 102 at `:1851`).
- `web/how-to-play.html:184-191`: a "Ranked" card: "Choose Ranked and press Find a match. You play Matt in the stadium until an opponent arrives, then a best of 3, games to 7. Win trophies to climb seven ranks, from Bronze to Pro. Bronze to Platinum are yours to keep." and the same as a FAQ entry in both the visible list (`:215-239`) and the JSON-LD (`:63-103`).
- `web/changelog.html` entry (+ its meta descriptions `:7,18,29`: "…ranked matches with a trophy road, stats and sign-in, tournaments…"); `web/index.html:6,17,29` descriptions (keep 70-160 chars with `phone`, `any computer`, `friends`; og = twitter ≤ 110); `web/site.webmanifest:4`; `README.md:79`.

Changelog copy: **Ranked.** "A new Ranked mode. Press Find a match: you warm up against Matt in a night stadium until another player queues, then play a best of 3 (games to 7). Win trophies, climb seven ranks from Bronze to Pro, and keep every rank up to Platinum for good. Your rank emblem is shown beside your name to your opponent and to anyone watching a Ranked court; everything else about your record stays private. The home screen now has Quick play and Ranked up top, with Courts, Play a bot and Your stats under them."

---

## 11. Tests (ports move every run: shared checkout rule; anything over 90 s runs in the background)

1. **`test/ranked.test.mjs`** (new; server only; `RANKED_PORT` base 8630-8633, the `tourney.test.mjs:7-51` harness copied: `up/client/lobbied/status`, `c.ready`, raw-frame capture, `CIDS` + the leak check). Clients send `hello{dev}` first (`stats.test.mjs:37-49`) with a distinct `fly-client-ip` per "computer". Env: `{ AUTOBOT:'1', SWING_SERVE:'0', READY_S:'0', WIN_BY:'1', RK_WIN:'1', RK_BEST:'3', RK_GOLD:'3', RK_VS_S:'0.3', RK_GAME_GAP_S:'0.3', RK_DONE_S:'0.5', RK_ARRIVE_S:'1', RK_WINDOW_S:'1', RK_CAP:'20', HOLD_S:'1', STATS_FORFEIT_MIN:'1', STATS_AFK_MIN:'0', STATS_ESTABLISHED:'0', STATS_MIN_POINT_S:'0', PODDLE_DB: <tmp file> }`; servers: base; `+1 { ROOM_CAP:'6' }`; `+2 { REVIVE_S:'3' }`; `+3 { RK_ADDR:'1', RK_MATT_DAY:'12' }`; `+4 { RK_WIN:'2', CAL_S:'2', STATS_ESTABLISHED:'1' }`; `+5 { STATS_AFK_MIN:'2', RK_WIN:'2', CAL_S:'2', READY_S:'2', STATS_ESTABLISHED:'1' }` (REVIEW FIX regressions: sections 13-16 and the additions to 2, 4, 6, 7, 11). Scenarios: (1) queue alone: `rk{phase:'queue'}`, `room{rk,kind:'warm'}`, `welcome{venue:'stadium', rank:[1,null]}`, `botinfo` Rookie, `/status.json.rk.queued === 1`, a bystander's `lobby.rk.queued === 1` and no room listed, `quick` never lands in it, stranger `join{code}` → `joinfail full watch:true`, `ask` → refused `why:'rk'`, `bot{level}` → `reason:'ranked'`, `pause` allowed; (2) a Matt game with `c.ready = true`: `matchover.rk.matt`, `rkres{matt:true, delta:10, trophies:10, tier:1}`, `rematchon` after the gap, a loss → `delta:0`, `dayLeft` counts down to 0 on the `RK_MATT_DAY:'12'` server, `nostats` socket → `rkfail nostats`, second entry from the same address → `rkfail addr` on the `RK_ADDR:'1'` server; (3) second human on another computer: both `rkvs` (side, bestOf 3, `vs.tier`, no `trophies` key), no `closed` to the players, both `room{kind:'match'}` + `welcome{series}`, `rkgo game 1`, a third socket with the code → full/watch; a partner already waiting → the joiner gets `rk{phase:'vs'}` and never a warm room; (4) best of 3: `rkgame{games:[1,0]}`, room open, no `rematch`, `rkgo game 2` with score 0-0 and `serve.by` alternated, `point.gp/mp` set at the right points, `matchover{rk:{games:[2,0], done:true}}` then `rkres` to both exactly once (+33/−20 from equal trophies with the sweep), `closed round` after `RK_DONE_S`, `/api/stats.ladder.trophies` on both; `rk` from the result card re-queues (Play again); (5) queue order: C queues during A-B; A Play again → matched with C; (6) leave = forfeit after a strike (leaver −20, stayer +30 with one counted game; stayer +0 `left_early` when none), drop → `hold` then forfeit after `HOLD_S`, reconnect `&rk=1&room=CODE` with the same cid keeps the seat, no-show → void + the stayer back in front, never-ready → `force` after `CAL_S`; (7) same computer group never pairs; a fourth series in a day is `friendly:true` with deltas 0; `pairs` counts one series; (8) tier crossing: play Matt games to 100 and assert `rkres.tierWas 1, tier 2`, then lose a series at 100 and stay at 100 (floor); (9) caps and hostile payloads (`ROOM_CAP` → `rkfail busy`, `RK_CAP`, malformed `rk` payloads, `rk` from a spectator ignored, the server keeps answering `/status.json`); (10) restart with `REVIVE_S=3`: `&rk=1` → `rkend restart` then `gone`, nothing revived; (11) no cid, owner id or opponent trophies in any `rk*|lobby` frame. Last line `PASS`/`FAIL n`; add to the `deploy.sh:13` loop.
2. **`test/ladder.test.mjs`** (new; pure): `createRequire('server/ladder.js')` and `import('web/emblems.js')`: the two tables agree (names, floors), `tierOf`, `floorOf`, sticky floors ≤ 4 and demotion above (never below 450), `humanDelta` bounds (18..45, −32..−8, sweep +3), `mattDelta` per tier, the 1399 ceiling, the day cap, `new_opponent` halving (min 8). Last line `PASS`.
3. **`test/accounts-unit.test.mjs`**: migration 2 from `:memory:` and from a v1 fixture file; `counts()` includes `ladder`; `ladderApply` in one transaction (floors, best, streak, day cap, ceiling, `delta_a/b` written); `fold` max/sum rules; `deleteOwner` cascades the row; `recentPairs` counts distinct series; `exportOf` format `poddle-export-2` with no `owner` string.
4. **`test/stats.test.mjs`** (`STATS_PORT=9430`, background): a ladder series records `mode:'ladder'`, `kind:'human'`, the `match recorded: human ranked` line unchanged (`:329`); `/api/stats` returns `ladder`.
5. **`test/menu.mjs`** (`MENU_PORT=8340`, background; baseline run first, it has been red before): Part A untouched on the plain localhost run (the tile is hidden); a new block behind a fake `/api/me {db:true}`: click `#btn-ranked` → view `ranked`, title `Ranked`, copy rule, `data-fit` at 1280×720 and 600×900, `#btn-ranked-go` sends exactly `{type:'rk', name:'Dan'}` → the fake answers `seat(ws,'RNKD',false)` + an `rk` snapshot → `connect`; Part B: `UI_NAMES` (`:219`) += the new exports, `ranked`/`rankedOpen` in the stub's `onLobby`, `rkvs`/`rkgame`/series `matchover`/`rkres` pushed and the recorded `ui.*` calls asserted.
6. **`test/ui-next.mjs`** (`UI_NEXT_PORT=8770`): `:39` exports += the new names; `:42` ids += `btn-ranked lobby-ranked btn-ranked-go rk-pill series`; `:128-139` unchanged (three tiles on localhost; the walker skips hidden).
7. **`test/profile-ui.mjs`** (`PROFILE_UI_PORT=9450`): `FIXTURE` (`:16-19`) += `ladder:{trophies:240, tier:2, floor:100, next:250, bestTrophies:240, bestTier:2, bestTierAt:day, wins:3, losses:1, streak:1, botWins:9, botLosses:4, mattDayLeft:32}`; the row-shape assertion (`:134-138`) becomes `r.n === 5` and shapes `['2,3', '2,1,1,1', '1,1,1,1,1']`; new checks: `#btn-ranked` visible, `#ranked-line` `Silver · 240 trophies`, the Ranked view fits at every `SIZES` entry, the road has 7 items with `.is-now` on the 2nd. DEVIATION: no `#btn-set-ranked` row (see 2); the test asserts it is absent.
8. **`test/ui-mock.html`** `SCREENS` (`:59-60`) + `R{}` (`:120`) and **`test/ui-shots/shoot.mjs:15-21`**: `lobby-ranked` (`&tier=2&t=240`), `lobby-ranked&tier=7`, `ranked-queue` (HUD + pill, `&bg=stadium`), `ranked-vs`, `ranked-vs&friendly=1`, `ranked-game` (1-0, Game 2 in 6), `ranked-game&deciding=1`, `ranked-win`, `ranked-lose`, `ranked-rankup`, `ranked-hud` (emblems + reg badge in the tabs, game point), `ranked-emblems`; `OVERLAP` pairs for `rk-pill` and the game card vs `keys`/`toast`; `UI_PORT=8250 node test/ui-shots/shoot.mjs <subset>` at 1440×900, 1280×720, 600×900 and a `UI_REDUCED=1` pass; **look at the PNGs**. **`verify.mjs`** (`UI_PORT=8255`): emblem + name + badge on one line and nothing cut at 1440×900, 600×900, 390×844; the game card's bar reaches 0 under reduced motion; the road keeps one height across tiers. `node test/emblems-shot.mjs` for the sprite.
9. **`test/scene-next.mjs`** cost block (`:112-121`) and `census()` with `&venue=stadium` in `scene-preview.html`; `docs/SCENERY.md` budget (≤ 40 draws / ≤ 90k tris / ≤ 8 MB).
10. **`test/seo.test.mjs`** (`SEO_PORT=9035 STRICT=1`): dates, sitemap, description lengths, copy rule.
11. **`test/pad.test.mjs:47-49`**: the new `PAD_FX` words pass, unknown still dropped. **`test/revive.test.mjs`** (`REVIVE_PORT=9210`): a `&rk=1` socket is never revived.
12. Optional **`test/ranked-e2e.mjs`** (8625-8627, two Chromes, cloned from `tourney-e2e.mjs`): A queues → stadium + pill; B queues → both see the VS card, a game, the game card, the series card with the trophy roll, a rank-up; screenshots `test/ui-shots/ranked-e2e-*`; server log lines with codes only. After the first deploy.

Commands: `RANKED_PORT=8650 node test/ranked.test.mjs`, `node test/ladder.test.mjs`, `node test/accounts-unit.test.mjs`, `STATS_PORT=9430 node test/stats.test.mjs`, `TOURNEY_PORT=8660 node test/tourney.test.mjs`, `ROOMS_PORT=8310 node test/rooms.test.mjs`, `MENU_PORT=8340 node test/menu.mjs`, `PROFILE_UI_PORT=9450 node test/profile-ui.mjs`, `UI_NEXT_PORT=8770 node test/ui-next.mjs`, `E2E_PORT=8170 node test/e2e.mjs`, `UI_PORT=8250 node test/ui-shots/shoot.mjs lobby-ranked ranked-vs ranked-game ranked-win ranked-rankup ranked-hud`, `UI_PORT=8255 node test/ui-shots/verify.mjs`, `SEO_PORT=9035 STRICT=1 node test/seo.test.mjs`, `REVIVE_PORT=9210 node test/revive.test.mjs`, `node test/scene-next.mjs 8735`. Then `./deploy.sh` (gate: revive, rooms, seo, accounts-unit, stats, auth, ranked).

---

## 12. Build order: five parallel-safe workstreams

Each stream owns its files; nobody edits another stream's file. Streams A, B and C touch no common file. D and E share `web/index.html`, `web/ui.js`, `web/ui.css`, `web/main.js`: **D builds first, E builds on D's result** (E's edits are additive sections listed below, so D can land and be tested alone). The legal/docs edits (10.3) ship with D (the first surface that shows an emblem).

### A. Server: queue + series + trophies (`server/*.js`)

Owns `server/ladder.js` (new), `server/db.js`, `server/stats.js`, `server/abuse.js`, `server/game.js`, `test/ranked.test.mjs`, `test/ladder.test.mjs`, `test/accounts-unit.test.mjs`, `test/stats.test.mjs` additions, `deploy.sh`.
1. `server/ladder.js` (5.1-5.4) + `test/ladder.test.mjs` (server half; the emblems half joins when B lands).
2. `db.js`: migration 2, statements, `ladderOf/ladderTier/ladderApply`, `recordMatch` mode/series, `pairs` by series, `fold`, `profileOf`, `exportOf`, `TABLES`, exports; accounts-unit cases; rehearse the migration on a copy of the live file.
3. `stats.js`: `newMatch` mode/series; `onEnd` returns `owners`/`flags` and passes `series` to `L.result`; `abuse.js` `result(…, series)`/`pair()` by series.
4. `game.js` room: `SERIES/games/game/between`, `point()` (gp/mp, `gameWon`), `step()` (between; warm-up auto-next), `endMatch` (`over.until`, `overMsg.rk/rank`, `onResult` games), `record()` kind + mode, `ranks()`/`join me.tier`/`welcome rank+venue+series`/`tellNames`, guards at `:639, :661, :682, :759, :836, :1053-1054`, `PAD_FX`, room export `gamesNow`.
5. `game.js` queue: knobs, `rkQ/rkSeries`, `rkQueue/rkWarm/rkPick/rkPair/rkTick/rkResult/rkMatt/rkLeave/rkGone/rkRebind/rkSnap/rkSend`, dispatch lines (`:1475, :1478, :1483, :1486, :1511`), `&rk=1` branch (`:1493-1497`), `revive` refusal (`:1133`), `lobbyMsg.rk`, `/status.json`, `helloMsg` tier re-read.
6. `test/ranked.test.mjs` scenarios 1-11; `stats.test.mjs` case; add to `deploy.sh`.

### B. Emblems module (`web/emblems.js`, `web/ui.css` emblem block only, `test/emblems*`)

Owns `web/emblems.js`, the `/* rank emblems */` block of `web/ui.css` (`:1490-1502`) and the `:508` reduced-motion line, `test/emblems.html`, `test/emblems-shot.mjs`, the emblems half of `test/ladder.test.mjs`.
1. Retune `RANKS` names/`THRESHOLDS` to the table in 5.1; the `installSprite()` comment → ui.js; export `RANK_NAMES` for the aria labels.
2. Add `.rank-em.is-off` (opacity .55, grayscale via `filter:saturate(.2)`), `.rank-badge` (the sibling span: `display:inline-grid;margin-left:.35em;vertical-align:-.12em`), `.score-who:has(> .rank-badge)` / `.tally-side:has(> .rank-badge)` / `.vs-side > .rank-badge` grid extensions next to the `.reg-badge` rules, `.rank-em.is-inverse` on navy.
3. Keep `node test/emblems-shot.mjs` green; a name line with reg badge + emblem at 20 px on both grounds in `test/emblems.html`.

### C. Stadium venue (`web/scenery/stadium.js`, `web/scenery/index.js`, `web/scenery/sky.js`, `web/scenery/shared.js`, `web/scene.js` venue hooks, `test/scene-preview.html`, `docs/SCENERY.md`)

Owns those files (in `scene.js` only: `VENUE` colours `:76`, `venue` state `:287`, ctx `:337`, `slab/buildCourt/banner/trees` `:348-431`, `setVenue` in the API `:1290`; the jingle additions in `scene.js:1061-1072`/`:1297` belong to E, in a separate region of the file, so C and E must coordinate one rebase on `scene.js`).
1. `index.js` per-venue build/reveal/`setVenue`; `sky.js` night branch; `stadium.js` (7.4); `scene.js` venue hooks (7.1-7.2); `body[data-venue]` attribute + theme-color swap live in `scene.setVenue` so no main.js change is needed for the tint.
2. `test/scene-preview.html?venue=stadium`; `scene-next` cost block within budget; `docs/SCENERY.md` note.
3. The page-tint CSS variants (7.5) are D's (`ui.css`); C supplies the colour values.

### D. Lobby reorg + Ranked home view + rank views (`web/index.html`, `web/ui.js`, `web/main.js`, `web/ui.css`, `web/profile.js`, legal/docs, lobby tests)

Owns: `index.html` tiles (`:283-298`), `#lobby-ranked` (after `:384`), the Settings row (`:181`); `ui.js` `tilesFit`, view tables (`:567-570`), `viewFocus` (`:602`), clicks (`:754-760`), walker (`:813-814`), `rkTile`, `rkView`, `rankBadge`, `setNames.rank`, `rkCourt` (`:901` twin), `setSettings` notes (`:432`), `installSprite()` import; `main.js` protocol wiring: state (`:317` neighbourhood), `request()` settle (`:302/:325`), `room` handler (`:542-553`), `closed` (`:568`), `welcome` (`:571-584`: `ranks`, venue, VS close), `names` (`:585`), `botinfo` (`:614`), `midMatch` (`:230`), `forfeits` (`:237`), `syncSettings` (`:189`), `drawNames` (`:141-149`), `askSync` (`:309`), `esc` (`:720`), `toLobby` (`:363-374`), socket URL (`:404-408`), restart toast (`:535`), `rkHang`, `onLobby` (`:695-699`) `ranked/rankedOpen`, `profile.init` hooks (`:702`), `window.__stats.rk`, the `rk`/`rkfail`/`rkend`/`rkres`(view notice) handlers above the guard (`:539-541`), `lobby.rk`; `ui.css` hero grid + `data-n` swap (`:597-611, :707-721, :1017-1020`), `#btn-ranked` icon block, `.ranked-view/.rk-*`, `.tile-line`, dimming lists (`:567-569`), `body[data-venue]` tint (7.5), `body[data-rk] #room-menu`; `profile.js` `showRanked`, `drawAcct` (`:221`), `drawSide` row, hooks `tiles/ranked`, `matchover(tour, quiet)`; legal/docs (10.3); `test/menu.mjs`, `test/ui-next.mjs`, `test/profile-ui.mjs`, `test/ui-mock.html` (`lobby-ranked`, `ranked-hud`, `ranked-emblems`), `docs/ui-spec.md`.
D ships a working Ranked with plain cards: the warm-up court, the VS card in its tournament look, the game card as a bare `.round-card` with text only, the series card reusing `matchResult` with the trophy row as text. That is a playable v1.

### E. Match presentation (`web/ui.js`, `web/ui.css`, `web/main.js`, `web/index.html`, `web/scene.js` sounds, `web/pad.js`, shots)

Builds after D on the same files, in separate regions: `index.html` `#screen-rk-game` section (new, after `#screen-tour-vs`), the `#screen-tour-vs` ids/`.is-ranked` additions, `#series` lozenge (`:113`), `#rk-pill`, `#result-pips`/`#trophy` inside `#result` (`:560-563`), `#btn-rk-again/#btn-rk-leave` in `.rematch`; `ui.js` `OVERLAY` (`:23`), `OV` (`:11`), `rkVs`, `rkGame`, `rkPill`, `setSeries`, `setPressure`, `trophyRow`, `rankUp`, `gameBanner`, the `matchResult` rk branch (`:115-141`); `ui.css` the "RESULT / NOTICE CARDS" additions after `.rematch-bar` (`:437`: `.round-card`, `.pips`, `.trophy*`, `.is-pressure`, `.rk-pill`), the beat timeline (`:1176-1202`) and keyframes (`:1205-1231`: `vs-emblem-in`, `ov-trophy-pop`, `ov-pip-in`, `ov-down`), the VS `.is-ranked` variant (`:1316-1330`), reduced-motion additions (`:500-509`); `main.js` `rkMove`, `rkvs`/`rkgo`/`rkgame` handlers, `showOver` rk branch (`:154-170`), `point.gp/mp` → `setPressure`, `serve` closes `rk-game` (`:641`), `profile` handler gating (`:620`), `padFx` calls, `rematchon` for the warm-up; `scene.js:1061-1072` + `:1297` jingles and the pressure hit in `onEvent` (`:1128-1134`); `web/pad.js:133-140`; `test/ui-mock.html` + `shoot.mjs` card screens, `verify.mjs`, `test/pad.test.mjs`, the optional `ranked-e2e`.

### Landing order

A, B, C in parallel from the start (A is the long pole). D starts at once on the lobby/view/protocol and integrates B's module when it lands (D needs `emblems.js`'s API, already present). E starts when D's `main.js`/`ui.js` wiring is in. Legal/docs land with D. Deploy after A + D (playable), then E and C as follow-ups if they are not ready; the stadium and the beats are visible polish, the queue and the ladder are the product.

---

## 13. Refusal rules, at a glance

| Situation | Answer |
|---|---|
| `rk` without a cid / in a tournament / stats off / 3rd entry from an address / queue full / no courts | `rkfail nocid|intour|nostats|addr|full|busy` |
| `bot` or keys 1-4 in any rk court | `botinfo reason:'ranked'` (client silent) |
| `pause` in the series | `paused refused` (warm-up: allowed) |
| A stranger's `join` with an rk code | `joinfail full, watch:true` (may watch; never asked to play) |
| `ask` from a spectator of an rk court | `askstate refused why:'rk'` |
| `rkleave` in a live series, or on a finished series card | ignored (use `leave` = forfeit; `rk` = Play again). REVIEW FIX: on the finished card it used to clear the entry and kill Play again |
| `nostats` on a Ranked socket (an old tab; the switch was REMOVED 2026-09-28 (NOTES 116)) | `rkfail nostats`; warm-up left, live series forfeited, a drawn seat never taken (REVIEW FIX) |
| No `hello` within `RK_ARRIVE_S` of queueing | never paired; `rkfail nostats`, out (REVIEW FIX) |
| `rk` within `RK_COOL_S` of leaving the queue | `rkfail busy` (REVIEW FIX) |
| A third drop, or `2 x HOLD_S` held in all; `2 x CAL_S` calibrating in all | that seat's forfeit (REVIEW FIX) |
| `rk` while already queued | a fresh `rk` snapshot |
| `&back=1` or `revive()` for an rk court | never revived; `rkend restart|gone` |
| Same device / account / owner / computer group | never paired |
| Pair capped by R10 / R11b | paired as a friendly (announced), no trophies |
| A series with an uncounted game | trophies 0 both, the `WHY` word |
| Forfeit with no counted game | leaver −loss, stayer 0 `left_early` (the forfeited game's own `early_forfeit`/`leaver_ahead`/`afk`/`too_fast` never count against the stayer, REVIEW FIX) |
| No-show before the first strike | void, stayer re-fronted |
| Deploy mid-series | void, no trophies changed |

---

## 14. Open questions for Daniel (with the defaults this spec ships)

1. **Rank names.** FIXED by the owner: Bronze, Silver, Gold, Platinum, Diamond, Champion, Pro (the familiar ladder; no Olympic wording anywhere).
2. **Floors.** Sticky through Platinum, demotion possible from Diamond up (never below Platinum's 450). Alternative: every reached rank is a floor. Default: sticky through Platinum.
3. **Matt trophies.** +10 … +4 per played-out counted win, 0 for a loss, 40 a day, ceiling 1399 (Pro needs people). A scripted client can reach Champion on Matt alone in ~35 days (ACCOUNTS.md Q14). Alternative: cap solo progress at the Platinum gate. Default: as specified.
4. **Series length.** Best of 3, games to 7, golden point 11 (8-12 min). Alternative: games to 11 like Quick play (~15 min). Default: to 7.
5. **`new_opponent` (R11c).** Halve the winner's trophies (min +8) rather than withhold. Default: halve.
6. **Friendly pairs.** Same-network or R10-capped pairs are matched as announced friendlies rather than refused. Default: yes; a clean partner always wins over a friendly one.
7. **Privacy scope.** The only new public fact is the rank emblem (+ its name) beside your name in Ranked courts; no rank in the court list, no leaderboard, no opponent trophy count on the VS card. Default: yes.
8. **Stadium crowd bed.** Cut for v1 (silence except the stings). Alternative: a synthesised crowd hum at gain .02 swelling on points. Default: cut.
9. **Export format.** Bump to `poddle-export-2` (new `profile.ladder`, per-match `mode`/`trophyDelta`). Default: bump.
10. **Deploy order.** Ship A + D (playable Ranked in the park with plain cards, legal pages in) before E and C if either is late. Default: yes.
11. **Migration rehearsal.** Run migration 2 against a `vacuumInto` copy of `/data/poddle.db` before the first deploy. Default: yes.
12. **ranked-e2e.** After the first deploy. Default: after.
