# Courts, Ask to play, the Tour bot, Tournaments: the build spec

This is the authoritative spec. It takes the best of three designs (player-first, robustness-first, visual-first). Every claim about today's code was checked against `server/game.js`, `web/main.js` and `web/ui.js` on branch `courts-tourney`. The wire protocol keeps saying `room`; the UI always says "court".

| Part | Status |
|---|---|
| Feature 1: Courts screen, code entry, Ask to play | **BUILD NOW** |
| The Tour bot (the fourth Matt) | **BUILD NOW** |
| Feature 2: Tournaments | **BUILD NEXT** (specified here in full so Feature 1 leaves room for it) |

---

## 1. Overview

**Lobby home.** The home view has three tiles: **Quick play**, **Courts** and **Play a bot**. The old "Enter code" tile, the home "Create court" tile and the home court list all go.

**The Courts view** replaces them. It has:
- a search box that filters by code;
- an **Open | Full** switch;
- a scrolling list of every public court, plus tournaments that are signing up;
- a code area (4 boxes) with **Join** and **Watch** side by side;
- **Create court**, and **Create tournament** with the note "Needs at least 4 players".

**Ask to play.** A spectator watching one human play Matt can ask to take Matt's seat. The player gets a small corner card for 10 s and answers with Y or N (or a click). The server enforces the rules: one pending request per court, a 10 s cooldown for each requester, and expiry counts as a decline.

**The Tour bot.** It is appended at `BOTS[3]` and sits between Club and Pro. It is listed as Rookie, Club, Tour, Pro everywhere, and tournaments use it.

**Tournaments** (BUILD NEXT):
- The host gets a Kahoot-style code screen. Joiners stream in and everyone warms up against Matt (Tour), with a "Waiting for the tournament to begin · N joined" pill.
- Start needs 4 players; the cap is 16.
- Single elimination. Matt fills an odd spot. Matches go to 7, the final to 11.
- The bracket shows between rounds, and the winner gets a champion card with confetti.
- A server restart ends the tournament, and every client says so.

### 1.1 The one rule that decides "does joining need the player's OK?"

In today's code the server's `AUTOBOT` is on unless `AUTOBOT=0` (`game.js:141`), and `join()` sets `botJoinAt = now + 2.5` for a lone human (`game.js:641`). So **nearly every one-human court has Matt within 2.5 s**, including a creator still on the share screen or calibrating.

If "Matt is seated" were the guard, Quick play (`quick()` filters `r.free()`) would never pair two humans again, and every friend's code would turn into a request. The guard is therefore **a match against Matt is under way: a ball has been struck**:

```js
const underway = () => !LEGACY && !opts.tour && humans().length === 1 && !!theBot() && started && !over;   // one human playing Matt, a ball already struck: taking that seat needs their OK. Before the first strike (share screen, calibrating, the 3-2-1) a joiner just sits down, as today
```

- `started` is set only in `strike()` (`game.js:290`) and cleared by `startMatch()` (`game.js:420`) and `leave()`.
- So:
  - after a rematch, during the new 3-2-1 before the first strike, a joiner sits down directly;
  - on a bot court's result card (`over`), a joiner also sits down directly, because `join()` already closes the vote with `rematchon`.

  Both follow decision 4 ("has not started").
- `!LEGACY` keeps the `LOCAL` room (legacy e2e) exactly as it is.
- Asking from the stands (a spectator pressing **Ask to play**) is gated by the wider `askable()` (2.2). A spectator never sits down without the player's OK.

---

## 2. Feature 1: Courts screen + Ask to play (BUILD NOW)

### 2.1 Protocol

All changes are additive. Old fields keep their meaning, and old clients ignore the new ones.

**Lobby list.** `lobby.rooms[i]` gains fields:

```
{ code, players, open, ask, bot, watch, watchers, score:[a,b], live, names:[n0,n1] }
```

| Field | Value | Meaning |
|---|---|---|
| `open` | `free() && !underway()` | a join seats you directly (the meaning is unchanged: no cached client is lied to) |
| `ask` | `underway() && canWatch()` | a join puts you in the stands and asks the player |
| `bot` | `!!theBot()` | Matt is seated |
| `names` | `names()` | already shown to anyone who watches a public court. Always rendered with `textContent` |

`lobby` also gains `tours: [...]` (Feature 2; an empty array until then).

**New messages:**

| Message | Direction | Fields | Who may send, and validation |
|---|---|---|---|
| `ask` | spectator → server | `{type:'ask'}` | Routed in the socket handler's `ws.room` branch next to `emote`: `else if (m.type === 'ask') ws.room.ask(ws)`. From a player or the lobby it is never routed |
| `askstate` | server → requester | `{type:'askstate', s, left, why}` | `s` is one of the states below. `left` is a whole number of seconds ≥ 0 |
| `askplay` | server → the seated human | `{type:'askplay', id, name, left}` | `id` is a per-room counter (never a cid). `name` is already cleaned |
| `askoff` | server → the seated human | `{type:'askoff', id, why}` | `why`: `'yes'\|'no'\|'expired'\|'gone'\|'late'`. The card closes on any of them |
| `answer` | seated human → server | `{type:'answer', id, yes}` | Handled in `onMessage` **before** `if (paused \|\| hold) return` (`game.js:722`), so a player with the settings panel open can answer. Dropped unless `Number.isInteger(id) && typeof yes === 'boolean'`. A stale or unknown id is answered with `askoff late` |
| `room` | server → requester | adds `asked:true` | A join or link landed in the stands of an under-way Matt court, and a request went out |
| `room` | server → requester | adds `promoted:true`, `role:'player'` | Accepted. The usual `welcome` follows |
| `room` | server → promoted player | adds `demoted:true`, `role:'spectator'` | Not ready within `PROMO_S`. `welcome` (spectator) follows |
| `promoff` | server → the host | `{type:'promoff', name}` | "Sam wasn't ready. Matt is back." |
| `botinfo` | server → client | adds `order:[0,1,3,2]` | section 3 |

**`askstate.s` values:**

| `s` | When | `left` |
|---|---|---|
| `sent` | the request is pending | seconds until it expires |
| `no` | the player declined | cooldown seconds |
| `expired` | 10 s with no answer | cooldown seconds |
| `wait` | cooldown still running, or the court is busy (another request is pending, or the gap between requests) | seconds until free |
| `gone` | the player left or dropped, or the court changed | 0: the court's doing charges no cooldown |
| `refused` | `why`: `'humans'` (two humans), `'tour'`, `'over'`, `'nomatt'` | none |
| `yes` | accepted (sent just before `room promoted`) | none |

### 2.2 Server (`server/game.js`)

**Constants**, next to `REMATCH_S`:

```js
const ASK_S = +process.env.ASK_S || 10, ASK_COOL_S = +process.env.ASK_COOL_S || 10, ASK_GAP_S = process.env.ASK_GAP_S != null ? +process.env.ASK_GAP_S : 3, PROMO_S = +process.env.PROMO_S || CAL_S;   // s on the wall clock: a request lives 10 s; a requester waits 10 s after it ENDS; a court rests 3 s between requests; a promoted spectator has 60 s to get their paddle ready
```

**Module level**, next to `rooms`:

```js
const askCool = new Map();   // 'c:' + cid (or the socket itself with no cid) -> wall ms before which it may not ask again. Keyed by cid so a reload does not reset it. Pruned of past entries when it passes 2000
```

**Room locals**, next to `over, hold, paused, slow`:

```js
let asking = null, askN = 0, askRest = 0, promo = null;   // asking: { id, ws, name, until } the ONE pending request. askRest: wall ms before the next may start. promo: { side, until, level } a seat just given to a spectator
```

**Predicates**, next to `free`:

```js
const mattSeat = () => humans().length === 1 && !!theBot();
const underway = () => !LEGACY && !opts.tour && mattSeat() && started && !over;                  // 1.1
const askable  = () => !LEGACY && !opts.tour && mattSeat() && !over && !hold && !promo;          // a spectator may ask (paused is fine: the card shows over the settings panel)
```

**`room` exports** gain `underway`, `askable`, `ask`.

**Seating** (lobby layer). In `seat()`, after the `heldBy`/ghost block and the LOCAL ghost block, replace `if (!r.free()) return false;` with:

```js
if (!r.free() || r.underway()) return false;                  // both seats taken, or one human is mid-match with Matt: that seat is theirs to give (joinCode turns this into watch + ask)
```

Reconnects come before this check (`mine`), so a lone human reloading their own court still takes the `retake` path. No extra cid helper is needed.

**`joinCode(ws, code)`:**

```js
function joinCode(ws, code) {
  const t = tourOf(code); if (t) return tourJoin(ws, t);                                  // Feature 2 (absent until built)
  const r = roomOf(code); if (!r) return tell(ws, { type: 'joinfail', reason: 'notfound' });
  if (seat(ws, r)) return;
  if (r.underway() && r.canWatch()) { if (watchCode(ws, r.code, { asked: true })) r.ask(ws, true); return; }   // one human playing Matt: watch, and ask them at once
  tell(ws, { type: 'joinfail', reason: 'full', watch: r.canWatch(), code: r.code });
}
```

`watchCode(ws, code, extra)` puts `extra` on its `room` message and returns `true` when it seated the watcher.

**Other callers:**
- **`quick()`:** the candidate test becomes `r.pub && r.free() && !r.underway()`. Quick play never lands anyone in the stands.
- **Deep links:**
  - `?court=CODE` goes through `joinCode`, so the rule applies.
  - `&watch=1` goes through `watchCode` and only watches, never asks.
  - `revive()` builds a fresh room with no bot, so nothing changes there.

**`ask(ws, auto)`** checks in this order. Each failure answers with `askstate`.
1. `!spectators.has(ws)` → return.
2. `opts.tour` → `refused tour`. `humans().length !== 1` → `refused humans`. `!theBot()` → `refused nomatt`. `over` → `refused over`. `!askable()` for any other reason (hold, promo) → `wait` with `left: 3`.
3. Cooldown: `coolLeft(ws) > 0` → `wait` with that `left`.
4. `asking` → `wait` with `left = secsTo(asking.until) + ASK_GAP_S`. `Date.now() < askRest` → `wait` with `left = secsTo(askRest)`. No cooldown is charged.
5. Otherwise:
   - `asking = { id: ++askN, ws, name: ws.name || 'Someone', until: Date.now() + ASK_S * 1000 }`
   - send `askplay {id, name, left: ASK_S}` to the seated human, if `pl.ws`
   - send `askstate sent left: ASK_S` to the requester

**`askEnd(why, tellPlayer = true, charge = why is no or expired)`**, the one place a request ends. It does nothing if `!asking`. Otherwise:
1. `const a = asking; asking = null; askRest = Date.now() + ASK_GAP_S * 1000;`
2. If `charge` (a `no`, an expiry, or the requester walking off, which `unwatch` passes), `coolSet(a.ws)`: the cooldown runs **from the end** of the request, which keeps the "10 s cooldown" visible after an expiry. It is keyed on `'c:' + cid` (the socket itself with no cid) AND `'a:' + address` (skipped for loopback), so a new cid or none is no way round it; expired entries are pruned on every set. A `gone` the court caused (the player left, dropped or reloaded, the match ended, a second human sat down) charges nothing. `demote()` also charges it.
3. `tellPlayer` → `askoff {id: a.id, why}`.
4. If the requester is still in `spectators` → `askstate {s: why, left: coolLeft(a.ws)}`.

**`answer(me, id, yes)`** runs synchronously inside one message, so it is atomic:
1. Drop the message unless it has an integer `id` and a boolean `yes`.
2. If `!asking || asking.id !== id || humans()[0] !== me` → `send(me, askoff {id, why:'late'})`. This covers a double press, an accept after expiry and a spoofed id.
3. `!yes` → `askEnd('no')`.
4. Take `const w = asking.ws, lv = botLevel;` and set `asking = null` **before** anything else.
5. If the requester is gone (`!spectators.has(w) || w.readyState !== 1`) → `askoff gone` and `askRest` set.
6. If the court changed underneath (`!askable()`) → `askoff gone`, and the requester gets `askstate gone`.
7. **Promote.** `join()` already resumes a pause, removes Matt, seats `w` on Matt's side, calls `startMatch(0)` for a new match from 0-0, and sends `names`, so the host's existing `joinBanner` "Sam joined to play" fires.
   ```js
   spectators.delete(w); tell(w, { type: 'askstate', s: 'yes' }); tell(w, { type: 'room', code, public: pub, role: 'player', promoted: true }); join(w);
   promo = { side: w.pl.side, until: Date.now() + PROMO_S * 1000, level: lv }; send(me, { type: 'askoff', id, why: 'yes' }); if (pub) lobbyChanged();
   ```

**`step()`** wall-clock block, next to `if (hold)`. `step()` runs while frozen too, so a pause does not stop the request clock.
- `if (asking && ms >= asking.until) askEnd('expired');`
- The promo check:
  ```js
  if (promo) { const p = bySide(promo.side); if (!p || p.bot || !p.ws || ready(p)) promo = null; else if (ms >= promo.until) demote(p); }
  ```
  `ready(p)` is true once the first `paddle` arrives. `ready()` is always true under `AUTOBOT=0`, so tests use `AUTOBOT=1` with `PROMO_S` short to reach `demote`.

**`demote(p)`:** the court would otherwise wait for ever, because `countdown()` waits on `ready` and `slowSeat` only runs once `started`.
1. `const ws = p.ws, nm = p.name;`
2. Take `p` out of `players` with no `left` and no score reset: the match never started. Then `spectators.add(ws); ws.pl = null; ws.spec = true;`
3. `tell(ws, {type:'room', code, public: pub, role:'spectator', demoted:true}); greet(ws, null);`
4. `botLevel = promo.level; promo = null; addBot();`. `addBot` starts the match and sends names.
5. Send `promoff {name: nm}` to the host. `if (pub) lobbyChanged();`

**Cancel hooks.** Each calls `askEnd` at most once.

| Where | Call |
|---|---|
| `unwatch(ws)` when `asking && asking.ws === ws` | `askEnd('gone', true, true)`: charged, so leaving and coming back is no way round the cooldown |
| `startHold()` | `askEnd('gone')` (the player can't answer). No cooldown: the requester did nothing |
| `leave()` of the lone human, before `sendOff()` | `askEnd('gone', false)` |
| `endMatch()` | `askEnd('gone')`: the match ended, and a result card is no time to swap seats |
| `close()` | `askEnd('gone', false)`; `promo = null` |
| `leave()` of the one who said yes, while `promo` is pending | `promo = null`: the promoted player is the court's only human now and is never demoted (the `step()` check also needs two humans) |
| `retake()` (the player reloaded) | no cancel. `greet()` re-sends `askplay` with `left: secsTo(asking.until)` to a seated player |
| `greet()` for a spectator with a running cooldown | sends `askstate wait left`, so the button is right after a reload |

### 2.3 Race matrix (each row is a test case in `test/joinreq.test.mjs`)

| Trigger | Server | Player | Requester |
|---|---|---|---|
| Join by code, link or list row, a ball not struck yet (share screen, calibrating, 3-2-1) | `seat()` seats directly, Matt removed | `joinBanner` | normal join |
| Join after a strike | watch + `ask(ws, true)` | card | `room asked:true`, `askstate sent` |
| Lone human reloads mid-match, old socket still half-open | `seat()` → `mine` → `retake` | card comes back with the time left | none |
| Lone human reloads, old socket closed first (the usual case) | `leave(dropped)` → `startHold` → `askEnd('gone')` | the card is gone; back within `HOLD_S` they retake the seat | `gone`, no cooldown: **Ask again** at once |
| Double accept (Y then click) | the second finds `asking === null` → `askoff late` | one promotion | one `room promoted` |
| Accept after expiry (in flight) | id mismatch → `askoff late` | card already closed | `expired` already sent |
| Requester leaves or drops | `unwatch` → `askEnd('gone')` | card closes | none |
| Player leaves | `askEnd('gone', false)`, then `sendOff` | lobby | `closed empty` → toast **Court closed** |
| Player drops with people watching | `startHold` → `askEnd('gone')` | none | **Ask again** at once (no cooldown charged) |
| Two spectators ask in the same tick | first `sent`, second `wait` | one card | second: **Again in 12s**, toast **Someone else asked first** |
| Spam (a new cid, no cid, leave and rejoin) | cooldown on cid AND address, `MSG_DROP` | at most one card per 10 s per requester, and a 3 s gap between any two | `wait N` |
| After a restart, a stranger joins a revived Matt match with points on the board | `resumed` makes it `underway` before its first new strike (also when a spectator's tab rebuilt the court and the player followed with `bot=`: `mattBack`) | card | watch + ask, the score kept |
| `answer` from a spectator, `yes:"true"`, a string id | never routed, or dropped | none | none |
| Match ends while a request is pending | `endMatch` → `askEnd('gone')` | card closes | `gone` |
| Promoted, never calibrates | `PROMO_S` → `demote` | toast **Sam wasn't ready. Matt is back.** | toast **Time’s up. You’re watching again.** |
| Server restart with a request pending | lost (memory) | card cleared on `welcome` | ask UI reset on `welcome` |
| Tournament room | `askable()` false | none | button never shown; `refused tour` |

### 2.4 Client glue (`web/main.js`)

**Promotion and demotion.** In the `room` handler, before the `again` logic (`main.js:400-402`), add a path of its own. Today `again = room === m.code` and a spectator's phase is `watch`, so `begin()` would never run.

```js
function switchSeat(m) { const toSpec = m.role === 'spectator'; role = toSpec ? 'spectator' : 'player'; room = m.code; ui.setRoom(room, shareLink(room)); setUrl(room, toSpec);   // the server moved me between the stands and a seat of the SAME court (and, later, into a tournament court): one path
  ui.askPlay(null); ui.askCard(null); ui.setSpectator(toSpec); syncSettings(); clearFar(); if (toSpec) enterWatch(); else { phase = 'lobby'; begin(); } }   // begin(): connect -> calibrate -> play; a calibrated paddle goes straight to play
```

- `if (m.promoted || m.demoted) { settle(); switchSeat(m); if (m.promoted) say('You’re in. Get your paddle ready.', null, 2600); else say('Time’s up. You’re watching again.', null, 2600); return; }`
- `m.asked`: after the usual spectator entry, show the toast **{name} is playing Matt. We asked if you can play.** (the name comes from the first `names` message; before it arrives, **We asked the player if you can play.**), then `ui.askPlay({s:'sent', left})`.
- The `welcome` handler must not send `bot` after a promotion. Today it sends `bot` only for `botWant` or `?autobot=1`; keep a `noBot` flag set by `promoted` anyway.

**Messages:**
- `askplay` → `if (seated() && !spec()) { askId = m.id; ui.askCard({ name: cleanName(m.name) || 'Someone', left: m.left | 0 }); }`
- `askoff` → `ui.askCard(null)`. For `why:'gone'`, a toast **{name} left** only if the card was showing.
- `askstate` → `ui.askPlay(m)`.
- `promoff` → `say(`${cleanName(m.name) || 'They'} wasn’t ready. Matt is back.`, null, 2600)`.
- `toLobby()` and `welcome` call `ui.askCard(null)` and `ui.askPlay(null)`.

**Keys** (the handler lower-cases `e.key` at `main.js:543`; Y, N and A are unused today):
- Before `if (k === 'f')`: `if ((k === 'y' || k === 'n') && ui.askShowing() && !e.repeat) { answer(k === 'y'); return; }`. This fires only while the card shows; otherwise Y and N do nothing.
- In the `spec()` branch: `if (k === 'a' && !e.repeat && ui.askCan()) { askPlay(); return; }`.
- `answer(yes)` = `game.send({type:'answer', id: askId, yes}); ui.askCard(null);`
- `askPlay()` = `game.send({type:'ask'})`.

**Showing the button.** `#btn-ask` shows only when all of these hold:
- `spec()`;
- the state packet has exactly one human paddle and one `bot`;
- the room is not a tournament room;
- this device can be a paddle: the inverse of `main.js:34`'s viewer-only test, i.e. `CAN_PHONE` or a Mac that runs the helper.

Viewer-only devices never see it.

### 2.5 The Tour bot hooks in the client

See section 3.

### 2.6 UI: lobby home (`#lobby-home`)

Three `.tile`s in this order: `#btn-quick` **Quick play**, `#btn-courts` **Courts**, `#btn-bot` **Play a bot**.

- **Removed:** `#btn-create` (the home tile), `#btn-code`, and the home `.rooms` block.
- **Courts tile art:** a court outline (`art-fill` rect, `art-line` centre line) with a magnifier in `art-accent`, in the same 96×96 SVG style as the other tiles.
- **Tile sub-line:** `<small class="tile-sub" id="courts-n">`. It reads **{n} open** (open + ask + tournament rows). While loading or at 0 it keeps its line box but is invisible (`visibility`, not `display`), so the tile never jumps.
- **Layout:**
  - three across (3 × 17rem + gaps ≈ 54rem) at 1440x900, 1280x720 and 600x900 (60rem wide at the 10px rem floor);
  - under `max-width:480px`, one column of 7.5rem bars with the icon on the left.

  The home view now holds only the tiles, so centre them vertically.
- **Keys:** the arrows walk the three tiles (the existing `#lobby-home [data-nav]` handler); Enter opens.
- **`nameGate()`** dims the tiles and every Courts control listed in 2.7.

### 2.7 UI: the Courts view (`data-view="courts"`, title **Courts**)

`VIEW_TITLE = { home:'Play', courts:'Courts', create:'Create court', share:'Your court', bot:'Play a bot' }`. Feature 2 adds `tour: 'Tournament'` and `bracket: 'Tournament'`.

- `lobbyView('code', …)` stays as an **alias** of `lobbyView('courts', …)`, so old call sites and tests still land.
- A new `VIEW_PARENT = { create:'courts', share:'courts', tour:'courts' }`. `main.js` `back()` goes to `ui.viewParent(v) || 'home'` when the view is not `home`. Share still sends `leave` first, as today.

**Markup** (inside `#screen-lobby .menu-body`; `#lobby-code` stops being a view and becomes a form inside Courts):

```html
<div class="panel panel-wide lobby-view courts" id="lobby-courts" data-view="courts" data-fit hidden>
  <section class="courts-browse" aria-labelledby="courts-h">
    <h2 class="vh" id="courts-h">Court list</h2>
    <div class="courts-tools">
      <label class="search" for="court-search"><svg aria-hidden="true"><!-- magnifier, stroke var(--ink-soft) --></svg><span class="vh">Search courts by code</span>
        <input class="field" id="court-search" type="search" placeholder="Search by code" maxlength="8" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" enterkeyhint="search" aria-controls="room-list"></label>
      <span class="seg seg-sm courts-seg" id="court-seg" role="radiogroup" aria-label="Show">
        <button class="seg-opt" role="radio" aria-checked="true" data-filter="open">Open <b class="seg-n" id="n-open">0</b></button>
        <button class="seg-opt" role="radio" aria-checked="false" tabindex="-1" data-filter="full">Full <b class="seg-n" id="n-full">0</b></button></span>
    </div>
    <div class="room-wrap court-wrap"><ul class="room-list court-list" id="room-list" aria-label="Courts" aria-busy="true"></ul><div class="room-bar" id="room-bar" hidden><i></i></div></div>
    <p class="court-state" id="room-empty" role="status"></p>
  </section>
  <section class="courts-side">
    <form class="courts-code" id="lobby-code" autocomplete="off" aria-labelledby="code-h">
      <h2 class="caps" id="code-h">Have a code?</h2>
      <div class="code-boxes is-sm" id="code-boxes" role="group" aria-labelledby="code-h"> …the same 4 inputs and aria as today… </div>
      <p class="code-err" id="code-err" role="alert"></p>
      <p class="t-note code-hint">Paste a code or a link</p>
      <p class="code-acts"><button class="btn is-tall" id="btn-join" disabled>Join</button><button class="btn is-tall" type="button" id="btn-watch-code" disabled><svg aria-hidden="true"><!-- eye --></svg>Watch</button></p>
    </form>
    <hr class="courts-rule">
    <div class="courts-make">
      <button class="btn is-tall" id="btn-create"><svg aria-hidden="true"><!-- plus --></svg>Create court</button>
      <button class="btn is-tall btn-tour" id="btn-tour" aria-describedby="tour-note"><svg aria-hidden="true"><!-- trophy --></svg>Create tournament</button>
      <p class="t-note tour-note" id="tour-note"><svg aria-hidden="true"><!-- info --></svg>Needs at least 4 players. Up to 16.</p>
    </div>
  </section>
</div>
```

Ids kept so tests and code keep working: `room-list`, `room-bar`, `room-empty`, `lobby-code`, `code-boxes`, `code-err`, `btn-join`, `btn-create` (now inside Courts; it opens the existing `create` view).

**Until Feature 2 is built,** `#btn-tour` is **shown but disabled**: `aria-disabled="true"`, focusable, with the note **Tournaments are coming soon.** added under the disclosure. The layout is final from day one, with no shift later.

#### Layout

**Rem budget.** The root is `clamp(10px, min(1.1806vw, 1.8889vh), 26px)`, so 1440x900 and 1280x720 are both 52.9rem tall, and 600x900 is 60 × 90rem. The lobby chrome takes 9.5rem and the name row about 5.25rem, which leaves **about 38rem** for this view.

**At 1440x900 and 1280x720** (`.panel-wide`): `display:grid; grid-template-columns: 1fr 21rem; gap: var(--s-6)`.

- **List column:**
  - tools row 3.5rem
  - `.court-wrap` with a fixed `height: 26rem` (about 6.5 rows show, which hints at the scroll)
  - state line 1.75rem
  - total about 32.5rem
- **Side column:**
  - code block about 12.75rem
  - rule 1.5rem
  - create block about 10.25rem
  - `justify-content: space-between`, so the create buttons line up with the list's bottom
- **Code boxes:** `.code-boxes.is-sm .code-box{width:max(4.25rem,44px);height:max(5.5rem,52px);font-size:var(--t-2xl)}`

**At 600x900** (`@media (max-width:700px)`), one column in this order:
1. tools: search `flex:1`; the seg wraps under it below 30rem
2. list with `height: min(30rem, 40dvh)`
3. state line
4. code form, centred, with **Join | Watch** at 50/50
5. rule
6. **Create court | Create tournament** side by side, with the note under them

The total is about 79rem including the chrome, which fits in 90rem. `menu-body` scrolls as today if a device is shorter.

**The list height is fixed** (a `height`, not only a `max-height`) in every state: loading, empty, rows, down. Filtering or refreshing never moves the code area. This is checked in `verify.mjs`.

#### Rows

`lobbyRooms(rooms, online, tours)`:
- **Delete `.slice(0, 12)`** (`ui.js:455`). The server already lists every public court with a human in it, bounded by `ROOM_CAP` (40), plus at most `TOUR_CAP` (2) tournaments. The list scrolls inside `.court-wrap` with the existing `roomBar()` thumb. No virtual list is needed at 42 rows.
- Search filters the full set on the client, so it reaches every public court (decision 2).
- Every string goes in through `textContent`. No selector is ever built from a server string: rows are found by comparing `dataset.code`.

A row is one `<li>` holding the main button and, when there is one, a Watch button:

```html
<li class="court" data-kind="open|ask|tour|full">
  <button class="room-row court-row" data-code="KXQ7" data-nav aria-label="Court KXQ7. Dan is waiting. Join">
    <b class="court-code">KXQ7</b><span class="court-who">Dan is waiting</span><span class="court-meta">2 watching</span><span class="court-go">Join</span></button>
  <button class="btn btn-sm is-tall room-watch" data-watch="KXQ7" aria-label="Watch court KXQ7"><svg aria-hidden="true"><!-- eye --></svg>Watch</button>
</li>
```

The class `room-row` stays on the main button so `menu.mjs:51` and `rooms-e2e.mjs:36` keep reading rows. The existing `data-watch` hook stays too.

| kind | Test | Tab | `.court-who` | `.court-meta` | Verb (`.court-go`) → message | Watch button |
|---|---|---|---|---|---|---|
| `tour` | a `tours[]` entry (Feature 2) | Open, listed first | **{host}’s tournament** + gold badge **Tournament** | **{n} of 16 joined** | **Join** → `join` | none |
| `open` | `open` | Open | **{name} is waiting**, or **Empty** when `players === 0` | **{w} watching** when w > 0 | **Join** → `join` | when `players > 0 && watch > 0` |
| `ask` | `ask` | Open | **{name} vs Matt** | `{a}-{b}` | **Ask to play** → `join` (the server turns it into watch + ask) | yes |
| `full` | otherwise | Full | **{n0} vs {n1}** (a held or forfeited seat keeps its name) | `{a}-{b}` · **{w} watching**; **Starting** when `!live` | the row itself = **Watch** → `watch`; disabled with **Stands full** when `watch === 0` | none (the row is the Watch) |

**Tabs** (decision 3): **Open** = `tour` + `open` + `ask`, and **Full** = `full`.

**Sort order:**
- **Open:** tournaments, then `open` courts with someone waiting, then `ask`, then empty `open` courts (each in server order, which is oldest wait first). A waiting human is the fastest real game: Join is instant and never refused, while Ask to play can be refused and has a cooldown. The row carries a `players` flag for this; nothing matches on the row's text.
- **Full:** watchers first, most first.

**Styling** (all tokens exist in `ui.css`):
- `.court-list{display:flex;flex-direction:column;flex-wrap:nowrap;gap:.5rem}`
- `.court-row{display:grid;grid-template-columns:6rem 1fr auto auto;align-items:center;min-height:max(3.5rem,44px)}` with the `.room-row` gloss, border `--line` and radius `--r-pill`.
- `.court-code`: `--t-lg` 900, `.14em` tracking, `--me-ink`.
- `.court-who`: `--ink-strong` 700 with an ellipsis.
- `.court-meta`: `--ink-soft`, `tabular-nums`.
- `.court-go`: a `--me-tint` pill with `--me-ink` text, plus the existing chevron. On `ask` rows it is `--them-tint` / `--them-ink`: asking is a different act.
- `full` rows use the `.room-row.is-full` look.
- `.badge-tour`: a `--gold-1`→`--gold-2` fill, `--gold-4` border and `--ink-strong` text (never white on gold).
- Hover and `:focus-visible` get `box-shadow: var(--glow)` with **no scale**: a scaled row inside a scroll box clips its halo and nudges its neighbours.
- `:active` is `scale(.985)`.
- **At 600 wide:** `grid-template-columns:5rem 1fr auto`, and `.court-meta` drops to row 2 under the name.

**Redraw key.** It must cover every drawn field, or rows go stale:

```
rooms.map(r => [r.code, r.players, r.open, r.ask, r.watch, r.watchers, r.score, r.live, r.names].join(':'))
```

plus `tours.map(t => t.code + ':' + t.n)`, plus the filter and the query. The DOM is touched only when the key changes. Focus is restored by `data-code` / `data-watch` (today's `had` logic). If the focused row has gone, focus moves to the row now at the same index, else to `#court-search` (never `#btn-quick`, which is not in this view).

#### Search and switch

- **Input:** upper-cased, keeping only `cleanCode`'s alphabet, with no 4-character cut.
- **Match:** substring, case-insensitive. Codes that **start** with the query come first, then codes that contain it. Codes only (the decision says code).
- `#n-open` and `#n-full` show the **filtered** counts in `tabular-nums` with `min-width:1.5em`, so a query shows which tab its matches are in.
- The switch is a `role=radiogroup` (the existing `.seg` pattern, one Tab stop). The choice is kept in `localStorage['poddle.courts']` inside try/catch.

#### States (`#room-empty`, one line, `role="status"`)

`courtsState()` picks exactly one, top to bottom:

| State | When | List box | Copy | Extra |
|---|---|---|---|---|
| Down | `.is-down` (`lobbyLink(false)`) | 4 static skeleton rows at 0.4 opacity | **Courts show again when the game is back.** | The existing `#lobby-down` pill. Extend the `.is-down` rule to `.court-row, .room-watch, #btn-join, #btn-watch-code, #btn-create, #btn-tour` |
| Loading | no `lobby` message since the socket opened (a `roomsSeen` flag, reset by `lobbyLink(false)`) | 4 skeleton rows `.court-row.is-skel` (`--sky-2` fill; a `translateX` shimmer over 1.2 s, static under reduced motion); `aria-busy="true"` | visually hidden **Loading courts** | nothing in the list is focusable |
| Open empty | 0 Open, no query | empty | **No open courts right now.** + `btn btn-sm is-tall` **Create court** | focuses `#btn-create` |
| Full empty | 0 Full, no query | empty | **Nobody is playing right now.** | |
| No match | query set, 0 in this tab | empty | **No courts match “{q}”.** + **Clear search** | When the other tab has matches: a button **{n} in Full** / **{n} in Open** that switches the tab. When the query is a full valid 4-letter code: **{Q} isn’t listed. Private courts join by code.** + **Use this code**, which fills the boxes and focuses Join |
| Rows | otherwise | rows | empty; keeps its `min-height` | |

#### The code area

- **Boxes:** the existing box logic moves over unchanged: typing, paste of a code or link, Backspace walks back, the arrows move, Enter submits = **Join**.
- **Enabling:** `#btn-watch-code` follows the same enable rule as Join (4 letters) and calls `on.watch(getCode())`.
- **Join errors** go inline in `#code-err`, using today's copy plus the Feature 2 strings:

  | Reason | Copy |
  |---|---|
  | `notfound` | **Court not found** |
  | `full` | **Court is full** (then the existing `#ask-watch` "Court is full. Watch instead?" when `watch:true`) |
  | `busy` | **No free courts. Try again soon.** |
  | `busy`, when watching | **Too many watching** |
  | `tfull` | **This tournament is full** |
  | `started` | **This tournament has started** |
  | other | **Couldn’t join** |

- **Row-click errors** go to a toast, as today. The `#ask-watch` modal stays (decision 1 does not remove it; deep links to a full court still use it).
- **Deep links:** `play()` calls `ui.lobbyView('courts', { code: wantRoom, watch: wantWatch })`.
  - This fills the boxes and gives `.is-focus` plus first focus to **Join**, or to **Watch** for `&watch=1`. The title stays **Courts**.
  - With no name yet, the name field asks first (the existing `firstFocus`), then the request is sent as today.

#### Keyboard and focus

**Tab order:**
1. Back
2. name
3. search
4. Open/Full (one stop)
5. the list (one stop, roving `tabindex`)
6. code boxes 1-4
7. Join
8. Watch
9. Create court
10. Create tournament

| Where | Key | Result |
|---|---|---|
| Anywhere in the view, not typing | `/` | focus search |
| Search | ↓ | first visible row |
| Search | Enter | exactly one row visible: press it. The query is a full 4-letter code with no row: fill the boxes and focus Join. Never submits anything by itself |
| Search with text | Esc | clear it; `stopPropagation()` so `main.js` `esc()` does not go Back |
| Search empty / elsewhere | Esc | Back, as today |
| Seg | ← → | pick and move (existing `.seg` pattern) |
| List | ↑ ↓ | rows. ↑ on the first row returns to search |
| List | Home / End | first / last row |
| List | → / ← | the row's Watch button / back to the row |
| Code boxes | Enter | Join |
| Code boxes | Shift+Enter | Watch |

**First focus (`viewFocus().courts`):**
- no name → the name field;
- a deep link → Join or Watch;
- `(pointer: fine)` → `#court-search`;
- a coarse pointer → the checked seg option, so no on-screen keyboard pops up.

### 2.8 UI: the player's card (`#ask-card`), decision 5

The card lives **outside `#hud`**, next to `#toast`, so it survives `body[data-settings]`, the paused blur and the result overlay.

```html
<div class="ask-card" id="ask-card" role="group" aria-labelledby="ask-q" data-fit hidden>
  <p class="ask-q" id="ask-q"><b id="ask-name"></b> wants to play<small>Takes Matt’s place.</small></p>
  <p class="ask-btns"><button class="btn btn-sm is-tall ask-yes" id="btn-ask-yes" tabindex="-1" aria-keyshortcuts="Y"><span class="keycap">Y</span>Accept</button>
    <button class="btn btn-sm is-tall ask-no" id="btn-ask-no" tabindex="-1" aria-keyshortcuts="N"><span class="keycap">N</span>Decline</button></p>
  <div class="rematch-bar ask-bar" aria-hidden="true"><i></i></div>
  <span class="vh" id="ask-live" aria-live="polite"></span>
</div>
```

**Placement: the bottom-left corner.** For a player it is empty: `.views` are spectator-only, the key hints are bottom-right, the pill row is top-left, the insets are top-right, the toast is bottom-centre and the scoreboard is top-centre. It is also off the court and away from the ball's path.

- Base rule: `position:fixed; left:var(--edge); bottom:var(--edge); width:min(32rem, calc(100vw - 2*var(--edge))); z-index:calc(var(--z-toast) - 1)`, which is above the settings card and the result overlay, and below the toast. One row: the question (a long name ellipsises at 6em) beside Accept / Decline, the bar under both. Wider and much shorter than the first cut (about 5.5rem): at 1440x900 it sits below the near baseline instead of on the court's corner.
- `body.has-toast .ask-card` moves up 3.75rem so they never stack.
- A short landscape window (`min-aspect-ratio:1/1` and `max-height:820px`, e.g. 1280x720): the near baseline sits so low (y 645 of 720) that the bottom-left corner covers it. The card goes up under the Court pill instead, at `top: var(--edge) + 5.25rem` like portrait, stacked narrow (`width: min(22rem, 50vw - 21.5rem - var(--edge))`, the corner's own limit, so it stops short of the scoreboard) over the trees. Not with settings open or over the result card, which keep their own placement. `verify.mjs` asserts it sits above y = 40% of the window at 1280x720, clear of `#board` and `#corner`.
- Settings open (`body[data-settings]`): beside the settings card, at the offset `.dev-panel` uses, never over its Leave court button. Narrow (≤ 700px) with settings open: bottom-right, above the key strip (the game is paused).
- The result card (`body[data-overlay="match"]`, landscape): stacked narrow (question over the buttons) in the margin left of the centred panel.
- Phone width (≤ 480px, portrait): just above the two-line key strip; the top is the corner, the scoreboard's own row and the insets.
- Portrait (`max-aspect-ratio:1/1`): up at `top: calc(var(--edge) + 5.25rem)`, under the Court pill, over sky and trees where no ball goes (the bottom of a portrait window is the near court, where the paddle swings).

**Look:**
- `.panel-sm` material: 2px `--line-soft` all round, a white-to-sky gradient, `--sh-hud`, `--r-lg`, and a .25rem `--them` keyline drawn INSIDE with `::before` (a thick left border on a round box tapers into a crescent). The joiner takes the orange side.
- About 5.5rem tall. The sub line is only **Takes Matt’s place.**; the live region adds that a new match starts.
- The name is `--ink-strong` `--t-md` 800. The sub line is `--ink` `--t-sm` (not `--ink-soft` on sky).
- **Accept** is the primary: `--me-tint` to `#cfe4fb`, a `--me-ink` border, label and keycap rim. **Decline** is the plain pill.

**Never takes focus, never swallows input:**
- No `.focus()` call anywhere.
- The buttons are `tabindex="-1"`, so they are not in the Tab order and can never be pressed by Space or Enter.
- After a pointer click the button calls `blur()`. `pointerdown` on the card calls `stopPropagation()`, so it does not close the settings card or count as a court tap.
- The card never calls `preventDefault`. Paddle input never passes through the DOM.
- Y and N are read only while it shows (`ui.askShowing()`), and never on `e.repeat`.

**Countdown bar:**
- It reuses `.rematch-bar`: `scaleX(var(--p))`, stepped once a second from the server's `left` with a 1 s linear transition, so a late message still ends on time.
- It keeps draining under reduced motion: it is information.
- Auto-hide on `askoff`, or on a local timer at `left + 0.5 s` as a backstop.

**Screen readers:** `#ask-live` announces once: "Sam wants to play. Press Y to accept or N to decline."

**Motion:**
- In: 320ms `--ease-out`, `translateY(1rem)` plus fade.
- Out: 200ms fade.
- Reduced motion: it appears and disappears at once.

**Where the card cannot show:** the card is not shown on menu screens (the player pressed C to recalibrate, or opened connect). The request simply expires on the server.

**Player-side outcomes:**

| Outcome | What the player sees |
|---|---|
| Accept | `joinBanner` **Sam joined to play**, then the name's **Calibrating** status until they are ready |
| Decline, expiry, requester gone | the card fades, no toast (non-invasive) |
| `promoff` | toast **Sam wasn’t ready. Matt is back.** |

**ui.js API:**
- `askCard({name, left} | null)`
- `askShowing()`
- `onAnswer(fn)`: `fn(true|false)` on clicks

### 2.9 UI: the requester's button (`#btn-ask`)

The button sits on the bottom row, just left of `.emotes` (stacked above them, it sat on the near baseline and corner at 1440x900 and 600x900):

```html
<button class="btn btn-sm is-tall ask-play" id="btn-ask" hidden><svg aria-hidden="true"><!-- paddle --></svg><span id="ask-label">Ask to play</span><span class="keycap">A</span><i class="ask-ring" aria-hidden="true"></i></button>
<span class="vh" id="ask-state" aria-live="polite"></span>
```

- Position: `position:fixed; right: var(--edge) + 20.625rem + .5rem` (the emote row's width), `bottom: var(--edge) + .3125rem`, `width:16rem`. A toast (bottom-centre) hides the emotes; while it shows (`body.has-toast`, over 700px) the button takes their corner. At 700px and under the emotes sit above the view chips (18.95rem wide), and the button sits beside them on that row, with its width capped at `100vw - 2*var(--edge) - 19.325rem` so it never runs off the left edge under 390px. The width is fixed so label changes never shift anything; while it cannot be pressed the border softens and the A keycap goes.
- `.views` wraps inside `max-width: calc(100vw - 2*var(--edge) - 37.625rem)` while `#btn-ask` shows (over 700px), so the chip row never runs under it. shoot.mjs's overlap check covers this, and `#btn-ask` against `#toast`.

States (`ui.askPlay(m | null)`, counting down locally from `left`):

| State | Label | Enabled | Ring / visual | `#ask-state` (announced once) |
|---|---|---|---|---|
| idle | **Ask to play** | yes | none | — |
| `sent` | **Waiting · 9s** (10 → 1): the player's time left to answer | no (`aria-disabled`) | a conic ring drains; reduced motion: a static ring, the number counts | **Asked. Waiting for an answer.** |
| `no` | **Again in 9s** → then **Ask again** | no, until 0 | `--them-tint` fill; toast **{name} said no** (2.6 s) | the toast (`role=status`) |
| `expired` | **Again in 9s** → **Ask again** | no, until 0 | toast **No answer from {name}** | the toast |
| `wait` | **Again in Ns** (a cooldown, or another request plus the court's gap) | no | when busy: toast **Someone else asked first** | the toast, when busy |
| `gone` | **Ask again** | per cooldown | none | none |
| `refused` | hidden until the court changes | none | none | none |
| `yes` | hidden | none | toast **You’re in. Get your paddle ready.** | none |

Two words for two clocks: **Waiting** counts the player's answer, **Again in** counts until you may ask. The why, with the player's name (the one human on the court, from main.js's names), is main.js's toast, so the label never has to fit a name: both labels fit 16rem at 390px (`verify.mjs` checks 1440, 600 and 390). The copy is deliberately neutral: the player is often 2 m away holding a phone. The key is **A** for spectators only (their keys today are 1-4, F, H, Q, Esc).

### 2.10 Mock states to add (`test/ui-mock.html` `R{}`, plus both `SCREENS` lists in `shoot.mjs` and `verify.mjs`)

| Screen | Shows |
|---|---|
| `lobby` | home, 3 tiles, **5 open** |
| `lobby-courts` | Open tab: 8 rows including one `ask` row and (with `&tour=1`) one tournament row |
| `lobby-courts-full` | Full tab |
| `lobby-courts-loading` | skeleton rows |
| `lobby-courts-empty` | Open empty |
| `lobby-courts-empty-full` | Full empty (**Nobody is playing right now.**) |
| `lobby-courts-nomatch` | `&q=ZZ` (no match plus "2 in Full"), and `&q=KXQ9` (Use this code) |
| `lobby-courts-down` | disconnected |
| `lobby-courts-err` | **Court not found** under the boxes |
| `lobby-courts-link` | deep link: boxes filled, Watch focused |
| `lobby-courts-many` | 42 rows, scrollbar |
| `lobby-bot` | 4 levels |
| `hud-ask` | the player's card |
| `hud-ask-settings` | card with the settings panel open (paused) |
| `match-ask` | card over the bot court's result card |
| `watch-ask` | `&s=idle\|sent\|no\|expired\|wait` |

### 2.11 Tests

**Existing tests that change** (each verified by grep):

| File | Change |
|---|---|
| `test/menu.mjs` | `:86` tiles regex `Quick play\|Courts\|Play a bot`. `:93` arrows reach `btn-courts`. `:118` `.room-row[data-code="KXQ7"]` (kept class) inside the Courts view: open Courts first. `:162` `#btn-code` → `#btn-courts`. The code-view steps (errors inline in `#code-err`) → Courts. Add: search filter, Open/Full, Watch by code, `/` focuses search, and the Esc-clears-search rule |
| `test/ui-next.mjs` | `:42` id list: drop `btn-code`; add `btn-courts court-search court-seg btn-watch-code btn-tour btn-bot-3 ask-card btn-ask`. `:132` the name gate list. `:138` "fourth tile" → third tile. `:140` bot string `Rookie…0,Club…1,TourTournament pace3,Pro…2`. `:142` the level walk. `:154-158` the 12-row cap → **20 rows rendered, scrollable**; the empty copy → **No open courts right now.**; focus after → `court-search` |
| `test/rooms-e2e.mjs` | `:63` click `#btn-courts` then type into `#code-boxes`. `:36` keeps working (`.room-row` class kept) once the Courts view is open |
| `test/fixes-e2e.mjs` | `:78`, `:133` open `#btn-courts`, then `#btn-create`. `:80`, `:134` `#btn-code` → `#btn-courts`. Joining Ann's court while she is on the share screen still seats directly (1.1): this is the regression guard for the `started` rule |
| `test/spectate-e2e.mjs` | `:121` `#btn-code` → `#btn-courts`. Audit every place a second human joins a court with Matt **after a strike**: that is now watch + ask |
| `test/revive-e2e.mjs` | `:20`'s button-text regex would also hit **Create tournament**: open Courts and click `#btn-create` by id |
| `test/bot.test.mjs` | `:30` B from Club → **Tour**, then Pro, then Rookie. Add `botinfo.order === [0,1,3,2]` and `level:3` → Tour. Add: Tour's return rate over 10 s sits between Club's and Pro's (same harness) |
| `test/rooms.test.mjs` | the lobby shape gains `ask`, `bot`, `names`, `tours`. `:188` the names list includes `Tour`. Existing join-a-bot-court cases run with `AUTOBOT=0` (no Matt) or before a strike, so they are unaffected; re-run all |
| `test/revive.test.mjs` | add: `bot=3` brings Matt back as Tour |

**New `test/joinreq.test.mjs`** (plain node in the style of `rooms.test.mjs`; `PORT` 8610; `AUTOBOT=1 ASK_S=1 ASK_COOL_S=1 ASK_GAP_S=0.2 PROMO_S=1.5 HOLD_S=1`; strikes are driven the way `bot.test.mjs` drives rallies):
1. **Quick-play pairing survives:** two `quick` sockets land in the same court even though Matt sat down for the first.
2. A join before any strike (Matt seated, 0-0) → seated, Matt gone.
3. A join after a strike → `room asked:true`, the host gets `askplay`, and the lobby row has `open:false, ask:true, names`.
4. Accept → `askstate yes`, `room promoted`, `welcome` as a player, Matt gone, 0-0, `names`, host `askoff yes`, the lobby row turns `full`.
5. Decline → `askstate no` with `left ≈ ASK_COOL_S`. Re-asking at once → `wait`; after the cooldown → `sent`.
6. Expiry → `expired`, host `askoff expired`, and the cooldown counted **from expiry**.
7. A second spectator while one request is pending → `wait` (no cooldown charged).
8. Double answer → one promotion, the second gets `askoff late`. Wrong id → `late`. `yes:"true"` → ignored. `answer` from a spectator → ignored.
9. `ask` with two humans → `refused humans`. During `over` → `refused over`.
10. Requester leaves → host `askoff gone`. Host leaves → requester `closed empty`. Host drops with watchers → `askstate gone` via the hold.
11. Lone human reloads mid-match (`back=1&room`) → retakes the seat, gets `askplay` again with the time left.
12. The cooldown survives a reconnect with the same cid.
13. Promoted but never ready (no `paddle`) → after `PROMO_S`: `room demoted`, Matt back at the **old** level, host `promoff`.
14. `answer` while paused (settings open) is heard.
15. `quick` never picks an under-way Matt court.

**`test/ui-shots/verify.mjs` additions** (UI_PORT 8605, on the mock):
- `askCard()` leaves `document.activeElement` unchanged.
- Space, Enter and the arrows dispatched while it shows are not `defaultPrevented` and press nothing.
- Y and N do nothing when it is hidden.
- The bar reaches 0 at `left` and still steps under emulated reduced motion.
- `#btn-ask` keeps its width across states.
- The Courts list box height is identical across loading, empty, rows and down.
- Every visible `button, input, [role=radio]` in the Courts view, `#ask-card` and `#btn-ask` measures ≥ 44×44 CSS px at 600x900 (inline keycaps excepted).
- Contrast ≥ 4.5:1 for `.seg-n`, `.court-meta`, `.badge-tour`, `.ask-q small` and `.tour-note`.

**`test/ui-shots/shoot.mjs`** (UI_PORT 8600):
- Add the new screens at 1440x900, 1280x720 and 600x900. `[data-fit]` must hold at all three.
- Add an `OVERLAP` check: `#ask-card` against `#keys`, `#toast`, `#settings`, `#board`, `#corner`, `#watchers`, `#camwrap`, `#podwrap`, `#result` and `#notices`, and `#btn-ask` against `.emotes`, `.views` and `#toast`.
- Add a `prefers-reduced-motion` pass on `hud-ask` and `lobby-courts-loading`.
- **Iterate on the screenshots until every size is clean.** That is the QA loop the request asks for.

**Browser e2e:** extend `spectate-e2e.mjs` (SPEC_E2E_PORT 8580):
- Ann plays Matt past the first strike on a public court. Ben opens Courts (Open tab), types two letters, sees one **Ask to play** row for that code and presses Enter on it.
- Ben lands watching with **Waiting · N**. Ann's card shows and does not take `document.activeElement`. Space and Enter press nothing, and the ball is still struck while it shows (the game has no Space serve: a swing serves, so what the card must never block is the paddle). Ann presses Y, and Ben goes to connect/calibrate as a player.
- A second run: N → Ben sees **Again in Ns** and the toast **Ann said no**.
- Built with Cat (already watching Ann against Matt in section 7) as the requester: A, N, the cooldown, Ask again, Y, calibrate, Ann plays Cat.

---

## 3. The Tour bot (BUILD NOW), decision 6

**Server:** append to `BOTS` at index 3. Every stat sits between Club's and Pro's:

```js
  { name: 'Tour',   react: 0.24, foot: 3.3, err: 0.35, reach: 0.80, power: [0.35, 0.80], place: 0.7, lob: 0.12, slice: 0.14, whiff: 0.045 },   // between Club and Pro: the tournaments' Matt. APPENDED at index 3, so revive's bot= and 0-2 keep meaning Rookie/Club/Pro
const BOT_ORDER = [0, 1, 3, 2];   // how every picker lists them: Rookie, Club, Tour, Pro
```

- `botRequest` cycling (B): `else if (theBot()) botLevel = BOT_ORDER[(BOT_ORDER.indexOf(botLevel) + 1) % BOT_ORDER.length];`. B from Club → Tour → Pro → Rookie.
- `botInfo()` adds `order: BOT_ORDER`. `levels` stays in index order.
- `revive()` needs no change: `clamp(level, 0, BOTS.length - 1)` already accepts 3.

**Client.** Every hard-coded 3 goes:

| Where | Change |
|---|---|
| `main.js:266` `backTo()` | `['Rookie', 'Club', 'Pro', 'Tour'].indexOf(botLevel)`. **Index order, not display order**, so `bot=` survives a restart |
| `main.js:522` `onLobby.bot` | `[0, 1, 2, 3].includes(level)` |
| `main.js:532` `onSettings.bot` | `[0, 1, 2, 3].includes(level)` |
| `main.js:558` keys | `'1234'.includes(k)` → `game.send({ type:'bot', level: [0, 1, 3, 2][+k - 1] })`. Keys follow display order |
| `ui.js:522` lobby-bot keydown | `(i < 0 ? 1 : i + d + 3) % 3` → `(i < 0 ? 1 : i + d + bs.length) % bs.length`. In the 2×2 layout ↑↓ move by 2 |
| `ui.js:250` `setBot` | compare by `o.dataset.name` rather than `textContent` (the seg option now holds only the name, but that stays robust) |
| `index.html` `#bot-levels` | 4 buttons in display order: `#btn-bot-0` Rookie **Slow and forgiving** · `#btn-bot-1` Club **A fair match** · `#btn-bot-3` **Tour** **Tournament pace** · `#btn-bot-2` Pro **Fast and accurate**. Ids keep the wire value; first focus stays `#btn-bot-1` |
| `index.html` `#bot-seg` | 4 `seg-opt`s `data-level` 0, 1, 3, 2 with `data-name`. `#bot-seg .seg-opt{min-width:0;padding:0 .75rem}` |
| `index.html` `#key-bot` | keycaps `1 2 3 4` **Difficulty** |
| `ui.css` `.bot-levels` | `repeat(4, 1fr)` inside `.panel-wide` at 1440 and 1280; `repeat(2, 1fr)` (2×2) at `max-width:700px`; each button `min-height:max(6rem,44px)` |
| `docs/ui-spec.md`, `docs/API-NEXT.md` §6, `docs/ROOMS.md` | "1 2 3" → "1 2 3 4" |
| `web/how-to-play.html` | "Rookie, Club or Pro" → "Rookie, Club, Tour or Pro" |

**Tests:** see 2.11 (`bot.test.mjs`, `revive.test.mjs`, `ui-next.mjs:140/142`, the `lobby-bot` mock).

---

## 4. Feature 2: Tournaments (BUILD NEXT), decision 7

### 4.1 Server state (a new section after `quick()`: `// ---------- tournaments (docs/TOURNAMENT.md) ----------`)

```js
const TOUR_MIN = 4, TOUR_MAX = 16, TOUR_CAP = +process.env.TOUR_CAP || 2, TOUR_RESERVE = 4;   // players to start, cap; tournaments standing at once (one fly machine); ordinary courts always kept free of warm-ups
const TOUR_WIN = +process.env.TOUR_WIN || 7, TOUR_FINAL = +process.env.TOUR_FINAL || 11, TOUR_GOLD = +process.env.TOUR_GOLD || 15;   // first to 7 (final 11), win by 2, golden point at 15 so no match runs for ever. Own knobs: WIN_AT is 0 under AUTOBOT=0
const TOUR_VS_S = +process.env.TOUR_VS_S || 4, TOUR_ARRIVE_S = +process.env.TOUR_ARRIVE_S || 30, TOUR_GAP_S = +process.env.TOUR_GAP_S || 6, TOUR_REG_S = +process.env.TOUR_REG_S || 1800, TOUR_DONE_S = 90;
const tourneys = new Map();   // code -> T. Codes are unique across rooms AND tourneys: one newCode() loops while rooms.has(c) || tourneys.has(c)
```

**`T`**:

```js
{ code, phase: 'reg'|'play'|'done', by: addr, made, host: id, seq,
  members: Map<id, { id, cid /* PRIVATE, never sent */, name, ws, on, out, goneAt, warm: code|null, joined }>, viewers: Set<ws>,
  round, rounds: [ { name, matches: [ { n, a: id|'M1', b: id|'M2', room: code|null, score: [x, y], w: 'a'|'b'|null, forfeit, made, final } ] } ],
  champ: null, next: null /* { at, what: 'seat'|'round' } */, dirty, sentAt }
```

- Member ids are small per-tournament integers. **Cids never leave the server**, because a cid is the seat credential (`seat()`/`heldBy`). A test greps every `tour` payload for cids.
- Sockets gain `ws.tour = T` (a member or a viewer) and `ws.tm = id`.

**`createRoom(code, pub, opts = {})`** gains `opts = { tour: T, kind: 'warm'|'match', only: cid => bool, vsBot, winAt, onResult, onClose }`. Every tournament room is `pub = false` with `r.by = null`, so it is **never counted by `ADDR_ROOMS`**, and it carries `r.noTtl = true`.

**Match rooms** (`kind === 'match'`):
- **`point()`:**
  ```js
  const wa = opts.winAt ?? WIN_AT; const final = wa > 0 && (score[winner] >= wa && score[winner] - score[1 - winner] >= WIN_BY || opts.tour && score[winner] >= TOUR_GOLD);
  ```
- **`runBot`:** `band = opts.tour ? 1 : clamp(...)`. No rubber band, so tournament Matt plays at a fixed Tour strength.
- **`join()`:** `vsBot` → `botLevel = 3; addBot()` once the human sits. Human vs human → never set `botJoinAt`; the first arrival waits alone and the board reads **Waiting for Ben**.
- **Refused:** `pause` (`refused:true`), `botRequest`, and `ask` (`askable()` is false).
- **`endMatch()`:**
  - `over = {…, votes:[true,true], until: now + TOUR_GAP_S*1000, tour:true}`;
  - broadcast `matchover` with `tour:true, next` and **no vote**;
  - call `opts.onResult(winner, [...score], !!forfeit)` once (a room-local `reported` flag).
- **`vote()`:** returns at once.
- **`step()`:** `if (over && !LEGACY && ms >= over.until) return close(opts.tour ? 'round' : 'norematch');`
- **`leave(me, again, dropped)`**, before the `over`/`hold` branches:
  ```js
  if (opts.kind === 'match') {
    if (over) { players.splice(i, 1); if (!humans().some(p => p.ws)) close('round'); return; }        // left the result card early
    if (dropped && !hold) return startHold(me);                                                     // any drop is held (HOLD_S), before the first ball too
    const nm = names(); players.splice(i, 1); return endMatch(hold ? hold.side : 1 - me.side, true, nm);   // 'leave' (Q Q, Forfeit) = forfeit at once; both dropped: the one held longer gets the win
  }
  ```
  `forfeitHeld()` in a match vs Matt ends with Matt winning by forfeit.
- **`seat()`:** `if (r.only && !r.only(ws.cid)) return false;`. A stranger with the code gets `joinfail full watch:true` and can watch.
- **`close()`:** calls `opts.onClose()`, which resolves the match idempotently if it has no result yet. **Every exit path of a match room reaches the bracket exactly once.**
- **Main-loop TTL sweep** (`game.js:1065`): `if (!r.noTtl && ms - r.idleAt > ROOM_TTL && !r.humans().length) r.close('empty');`.

**Warm-up rooms** (`kind === 'warm'`):
- Private bot courts with `only = cid`. Matt sits down at once at **Tour** (`botLevel = 3; addBot()`). B and 1-4 still work, and pause works (one human vs Matt).
- Ask is off.

### 4.2 Capacity (`ROOM_CAP` is a hard cap)

- **`tcreate`** needs `tourneys.size < TOUR_CAP`, at most one standing tournament per non-loopback address, and `rooms.size < ROOM_CAP`. Otherwise `joinfail busy`.
- **Warm-ups are best effort.** Each is made only while `rooms.size < ROOM_CAP - TOUR_RESERVE`, which keeps 4 courts for everyone else. Without one the member stays registered, on the tournament screen: **Warm-up courts are full right now. You’re still in.** plus **Try warm-up again** (`twarm`).
- **Start:**
  1. Close every one of this tournament's warm-ups first (`close('tourstart')`).
  2. Require `rooms.size + ceil(n/2) <= ROOM_CAP`. Otherwise `tourfail busy` → **Courts are full right now. Try Start again in a moment.**, and the warm-ups are re-made best effort.
- **Later rounds** only reuse the rooms freed by finished matches (a round never needs more rooms than the one before).
- `/status.json` gains `tours: tourneys.size`, so `deploy.sh` can warn that a deploy ends tournaments.

### 4.3 Protocol

| Message | Direction | Fields | Validation / effect |
|---|---|---|---|
| `tcreate` | lobby → server | `{type, name}` | Lobby only, and not already in a tournament. No cid → `joinfail nocid`. Cap → `joinfail busy`. Creates T with the host as member 1, replies `tour`. The host is **not** seated: they see the code screen |
| `join` | lobby → server | `{type, code}` where code is a tournament | `joinCode` checks `tourneys` first. In `reg` with room left: add a member (a cid already a member re-binds the same member), `tour`, then a warm-up seat. 16 reached → `joinfail tfull`. `play`/`done` → `joinfail started, watch:true` |
| `watch` | lobby → server | `{type, code}` where code is a tournament | Adds to `T.viewers`, sends `tour`. The client shows the bracket |
| `twarm` | member → server | `{type}` | In `reg`, not in a room: seat a warm-up (the host's **Warm up with Matt**) |
| `tstart` | host → server | `{type}` | From the lobby **or** inside a warm-up. Routed before the room/lobby dispatch: `if (ws.tour && ['tstart','tleave','twarm','twatch'].includes(m.type)) return tourMsg(ws, m);`. Needs `phase === 'reg'`, the host, and ≥ 4 members `on`. Otherwise `tourfail few` / `busy`, or ignored if not the host |
| `tleave` | member/viewer → server | `{type}` | `reg`: removed, host passes on. `play`: `out = true`; if seated in a live match that is a forfeit via `room.leave`. Answered with `tourend left` to that socket only |
| `twatch` | member/viewer → server | `{type, room}` | `room` must be a live match of **this** tournament → `watchCode` (keeps `ws.tour`) |
| `tour` | server → members and viewers | snapshot, below | On every change, coalesced to at most 4 a second (`T.dirty` flushed in the main loop). Built once, with `you` stitched in per socket |
| `tmove` | server → member | `{type, round, name, n, of, vs:{name, bot}, target, final, at, side}` (`round` 1-based, `n` 1-based match number, `final` bool, `side` 0 = a, 1 = b) | Sent before the `room` that seats a member in a match. The client must not treat the `closed` / `room` that follow as leaving |
| `tourfail` | server → host | `{type, why:'few'\|'busy', n?}` (`n`: members on, with `few`) | none |
| `tourend` | server → member/viewer | `{type, why:'restart'\|'gone'\|'empty'\|'expired'\|'left'}` | none |
| `closed` | server → client | new reasons `round` (match over, back to the bracket), `tourstart` (warm-up closed at Start), `tourend` (the tournament ended under a court; `tourend` came first) | none |
| `lobby.tours` | server → lobby | `[{ code, tour: true, host: name, n, max: 16 }]` | Phase `reg` only. Always an array (`[]`). Old clients ignore it |
| `joinfail` | server → client | new reasons `nocid` (tcreate/join with no cid), `tfull` (`watch:true, code`), `started` (`watch:true, code`), `intour` (`code` of the one you are in: `tleave` it first) | `busy` as before for the caps |
| `matchover` | server → match | adds `tour: { round, next, final, gap }` (`next`: the next round's name, `null` after the final; `gap`: s until `closed round`) | No `rematch` message follows in a match |
| `room` | server → client | adds `tour: CODE, kind: 'warm'\|'match'` on a tournament's court (seat and watch) | none |

**Snapshot:**

```js
{ type:'tour', code, phase, min: 4, max: 16, n, host: hostName, win: TOUR_WIN, final: TOUR_FINAL,
  you: { id|null, host: bool, out: bool, viewer: bool, warm: 'on'|'off'|'full' },
  players: [{ id, name, host, out, left, on }],
  rounds: [{ name, target, matches: [{ n, a:{ id|null, name|null, bot }, b:{…}, room|null, score:[a,b], live, w:'a'|'b'|null, forfeit, watchers }] }],   // in play: every round to the Final, the undrawn ones with a/b { id:null, name:null, bot:false }
  next: { what: 'seat'|'round', in: s } | null,
  champ: { id|null, name, bot, path: [{ round, vs, bot, score:[champ, them], forfeit }] } | null }
```

### 4.4 State machine and bracket rules

```
reg ── tstart (host, ≥4 on) ─▶ play ── final decided ─▶ done ── TOUR_DONE_S ─▶ deleted
 ├─ TOUR_REG_S idle ─▶ tourend expired        ├─ every human out or gone ─▶ tourend empty
 └─ last member leaves ─▶ deleted             └─ process restart ─▶ (clients) tourend restart
```

**Registration:**
- A dropped member is kept for `HOLD_S` (`on:false`, **Reconnecting**), then removed unless they come back by cid.
- If the host leaves or is removed, `host` passes to the earliest-joined member who is `on`, and that member's client toasts **You’re the host now**.
- `lobbyChanged()` fires on every count change.

**Start:**
1. `phase = 'play'`.
2. Close the warm-ups.
3. Shuffle the members who are `on`.
4. Call `round(T)`.
5. `lobbyChanged()`: the tournament leaves the list.

**`round(T)`:**
1. The entrants are round 1's shuffled humans, or later the previous round's winners in match order.
2. An **odd count adds one Tour Matt** (`'M' + ++seq`).
3. **Pair Matts against humans first.** Two Matts meet only if Matts outnumber humans. Such a pair is resolved at once with a coin flip, score `[TOUR_WIN, 0]`, and is shown as **Matt advances**. Only Matts left means `champ` = Matt.
4. For each unresolved pair:
   - `createRoom(newCode(), false, { tour:T, kind:'match', only, vsBot, winAt: last ? TOUR_FINAL : TOUR_WIN, onResult, onClose })`;
   - send `tmove` with `at: TOUR_VS_S` to each human;
   - set `T.next = { at: now + TOUR_VS_S*1000, what: 'seat' }`.
5. **Seating** (`tourSeat`): if the member is watching anywhere, `quit(ws)` first. Then `lobby.delete(ws)`, `room {role:'player', tour: T.code, kind:'match'}` and `r.join(ws)`.
6. **No-show:** after `TOUR_VS_S + TOUR_ARRIVE_S` with a reserved human not seated, the seated side wins by forfeit. If neither side is seated, the later dropper wins, else side `a`.

**The bracket shape is known at Start:** `pairs(r) = ceil(alive(r)/2)` and `alive(r+1) = pairs(r)`. The client draws every round at once, with **To be decided** boxes.

**After a match:**
- The loser is `out`; they see the bracket and may watch or leave.
- When every match of the round has `w` → `T.next = { at: now + TOUR_GAP_S*1000, what:'round' }` → `round(T)`.
- Members in the stands are pulled out by `tourSeat`.

**Round names**, by matches in the round:

| Matches | Name |
|---|---|
| 1 | **Final** |
| 2 | **Semifinal** |
| 4 | **Quarterfinal** |
| otherwise | **Round N** |

**Match length:** first to 7, win by 2, golden point at 15. The final goes to 11. There is no rematch vote.

**Host powers end at Start.** A host who leaves after that just passes the crown, which matters only for the **Leave** copy.

### 4.5 Reconnect and restart (tournaments are never revived)

**Client:**
- While `tour` is set, the socket URL is `&lobby=1&tour=CODE[&room=CODE[&watch=1]]&name=…` with **no `back=1`** (`backTo()` returns `''`).
- A member between rounds sends `&lobby=1&tour=CODE`. A viewer out of any court sends `&lobby=1&tour=CODE&watch=1`, so a reconnect never signs them up.

**Server connection handler**, right after `enterLobby(ws)` and **before** the `room`/revive line:

```js
const tq = String(q.get('tour') || '').trim().toUpperCase();
if (tq) { const t = tourneys.get(tq);
  if (!t) return tell(ws, { type: 'tourend', why: Date.now() - BOOT < REVIVE_S * 1000 ? 'restart' : 'gone' });   // no revive for anything of a tournament
  tourRebind(ws, t); if (q.get('room')) (q.get('watch') === '1' ? watchCode : joinCode)(ws, q.get('room')); return; }   // a seat comes back through seat()'s heldBy / only
```

- `revive()` gains the guard `if (q.get('tour')) return false;`.
- **Client order:** `tourend` is handled before `joinfail` and `closed`. It sets `tour = null` and calls `toLobby()`, then `ui.tourEnded(why)`.
- During a tournament the `restart` message shows the toast **Updating. The tournament will end.**
- **Hang guard:** if the socket reopens with `tour` set and neither `room`, `tour` nor `tourend` arrives within 5 s, the client acts as if it got `tourend restart`.

### 4.6 UI screens (exact copy)

**1. Courts → Create tournament.**
- The disclosure **Needs at least 4 players. Up to 16.** is always visible under the button.
- One press sends `tcreate`, no extra screen. The rules live on the code screen.

**2. Host code screen** (`data-view="tour"`, title **Tournament**, `panel panel-wide`, `data-fit`, no name row: about 43rem available):
- `h2.tour-join#tour-code-h` at `--t-xl`, 800, over the boxes: **Join at poddleball.com** *with code* (the invite link's host, so a room reads where to type it, as Kahoot's "Join at kahoot.it"). With no link (localhost): **Join in Courts** *with code*.
- `button.code-boxes.is-static.is-huge#tour-code`:
  - boxes are `width:min(8rem,20vw); height:min(10rem,24vw); font-size:min(7rem,15vw)`;
  - a click copies the code alone → **Code copied** under it. The hint under it reads **Click the code to copy it**, or **Tap the code to copy it** on a touch screen (`hover: none`). The card's reads **Click to copy** / **Tap to copy**.
- `.share-link.well`: `span.addr#tour-link` (hidden on localhost) + `button.btn.is-tall#btn-tour-copy` **Copy invite**.
  - It copies **Join my Poddle tournament! Code K24M: https://poddleball.com/?court=K24M**, and the label reads **Copied** for 1.5 s.
  - On localhost it reads **Copy code**.
- `#tour-n` count block (`aria-live="polite"`): big tabular **5** **joined** *of 16*. It pops on change; no pop under reduced motion. At 16, *of 16* is hidden (**Full: 16 players** says it).
- The rules line under the invite: **Knockout. Matches go to 7, the final to 11. Odd numbers are fine: Matt the bot fills the empty spot.** The numbers come from the snapshot's `win` / `final`. It is the one place that names Matt's odd spot (a guest's `#tour-why` hides once it is ready).
- `ul#tour-names`: name chips.
  - The host chip has a **Host** tag and yours has **You**.
  - Offline members are dimmed with **Reconnecting**.
  - Dashed placeholders fill the list up to 4.
  - At most 3 rows, then **+N more**.
  - New chips pop in (fade only under reduced motion).
- `#tour-why`:
  - below 4: **Needs at least 4 players · {4−n} more**
  - 4-15: **Ready when you are.**
  - 16: **Full: 16 players**
- Buttons:
  - `#btn-tour-warm` **Warm up with Matt**;
  - one glow at a time (host): alone, **Copy invite** has `.is-focus` and Warm up is a plain `.btn`; from the second player to 3, Warm up has it; from 4, Start. A guest's Warm up always has it;
  - `#btn-tour-start` **Start tournament**, `disabled` with `aria-describedby="tour-why"` below 4; from 4 it reads **Start with {n} players** and takes `.is-focus`.
- `#btn-tour-leave` **Leave tournament** (right-aligned under the actions) opens an inline confirm: **Leave? The next player becomes host.** with **Leave** / **Stay**. For a host who is alone: **Cancel tournament**.
- **First focus:** **Copy invite** (a host's first act is to share).
- **Esc/Back:** to the warm-up court if seated, else to Courts. The tournament lives on, and `T` brings the screen back.
- **Guest version:** no Start. Instead **Waiting for {host} to start** with `.dots-wait`, plus **Warm up with Matt** if not in a warm-up.

**3. Joiners** (row, code or link) get `tour`, then the warm-up `room`, then `begin()`, which leads to connect/calibrate only if needed. Toast: **You’re in. Warm up with Matt while people join.**

**4. Waiting pill.** `button.hud-pill.tour-pill#tour-pill` goes in `#corner` after the court pill: trophy + **Waiting for the tournament to begin · 5 joined** + keycap **T**.
- Under `max-width:900px` it shortens to **Waiting** over **5 joined** (a 10rem column; the aria-label keeps the whole sentence).
- Host at 4 or more: **5 joined · Press T to start**.
- `aria-live="polite"` announces count changes only.
- It never idles out. The count pops once on change (not under reduced motion).
- The warm-up's own court pill and copy menu are hidden.
- A `watcherNote`-style notice with a trophy says **Ben joined the tournament**. Under `max-width:700px` the notices sit at the bottom left above the key hints (never across the net), at 12px, and hide while the ask card shows.

**5. Tournament card.** `#tour-card` opens on T or a pill click, anchored like `.settings`:
- the code (click copies), **Copy invite**, **{n} of 16 joined**, the names (scrolling, max 12rem);
- host: **Start tournament** (or the reason);
- **Leave tournament** (press twice).

Opening it pauses the warm-up, the same way the settings card does. It takes focus the way `settings()` does. Esc or T closes it, and focus goes back to the pill. Start and Leave are one height (44px or more).

**6. VS intro.** On `tmove`, a new overlay `'tour-vs'` shows for `TOUR_VS_S`:
- caps **Semifinal · Match 1 of 2**
- `chip-me` **You** · **VS** (callout lettering) · `chip-them` **Ben** (or **Matt · Tour**)
- **First to 7, win by 2** / **First to 11, win by 2** (the round line already says Final)

The sides slide in from each edge over 500ms, and VS pops. Reduced motion: it appears static. Then the existing 3-2-1 runs.

**7. In a match:**
- The pill reads **Semifinal · vs Ben**.
- No court pill and no copy menu. `setRoom(T.code, tourLink)` makes the address bar and copy use the **tournament** code, never the private match code.
- Settings: **Leave court** → **Forfeit**. Pause shows **Tournament matches can’t pause**. The key hint hides `1 2 3 4`.
- Q Q: **Press Q again to forfeit**.

**8. Match result.** `matchResult({…, tour:{next, out, round}})`:
- no vote;
- the note: win → **On to the {next}**; loss → **Out in the {round}**; a forfeit win → **Through: {name} left**;
- one button **See bracket** (`.is-focus`), which also happens automatically after `TOUR_GAP_S` (the `rematch-bar` counts it, labelled **Bracket in 6**);
- confetti only on a win.

**9. Bracket** (`data-view="bracket"`, title **Tournament**):
- Header **Tournament K24M**.
- **Status line (`#br-you`):**
  - **You’re through. Your next match starts when the round ends.**
  - **You’re out. Stay and watch, or leave any time.**
  - **Watching {host}’s tournament**
  - **{Round} in {n}** with a draining bar
  - **Your match is next**
- **Wide layout:** one column per round, `grid-auto-flow: column`.
  - Match cards are 13rem × 3.75rem: two name rows, tabular scores, the winner at 800 weight with a gold keyline.
  - `.is-you` gets a `--me` outline and tint.
  - Live cards get a deep red dot (`--bad-deep`, blinking no lower than .6; static under reduced motion), **Live** and `btn btn-sm is-tall` **Watch** (`twatch`). A Watch on your own drawn match seats you in it instead (never its stands).
  - Matt shows as **Matt** with a small **Tour** tag. Forfeits read **(left)**.
  - Four columns for 16 players fit `.panel-wide`. Overflow scrolls inside the panel only, never the page.
- **At `max-width:700px`:** a `.seg` of round tabs (**Round 1 | Semifinal | Final**) shows one column. It opens on the current round.
- **Keys:** arrows walk the cards' Watch buttons, Enter watches. While watching, T or Esc goes back to the bracket.
- **Focus is never hidden:** the first focus and every arrow move scroll the focused card fully into the scroller, below the sticky round header (`verify.mjs` (k) at 1440x900 and 1280x720).
- **Footer:** **Leave tournament** (press twice).
- Skeleton cards until the first `tour`.

**10. Champion.** For everyone (players, the eliminated, viewers): `screen(null)`, then the `match` overlay with `.result-card.is-champion`. It is an overlay because `confetti()` returns early over a menu (`ui.js:84`).
- a gold medal with a trophy glyph;
- title **You’re the champion!**, **{name} is the champion!** or **Matt is the champion!**;
- **The road to the title** · **Beat Sam 7-4 · Beat Ana 7-5 · Beat Matt 11-9**;
- confetti in two bursts, reusing `showOver`'s pattern (skipped under reduced motion, as today);
- one button **Back to courts**.

**11. Ended.** `ui.tourEnded(why)` shows a non-modal `.panel.notice` in the `lobby-down` slot, with a trophy, the text and **OK**:

| `why` | Copy |
|---|---|
| `restart` | **The tournament ended: the server restarted** |
| `empty` | **The tournament ended: everyone left** |
| `expired` | **The tournament ended: it never started** |
| `gone` | **This tournament has ended** |
| `left` | toast **You left the tournament** |

Borrowed from Wii Sports and Mario Tennis cups: the VS splash, round names, the bracket between rounds with your path lit, the eliminated keep watching, the trophy card and the road to the title.

### 4.7 main.js glue (tournament)

- **State:** `tour` (the last snapshot) and `tourMoving`.
- **`tour` handler:** runs before the `seated()` guard and drives `lobbyView('tour'|'bracket')`, the pill and the card.
- **`tmove`:** sets `tourMoving = true` and shows `'tour-vs'`. The following `closed round|tourstart` does **not** call `toLobby()`. The following `room` goes through `switchSeat()` (2.4). `tourMoving` clears on `welcome`.
- **`onLobby` gains:**
  - `tour: () => request({type:'tcreate'})`
  - `twarm`
  - `tstart`
  - `tleave`
  - `twatch: room => game.send({type:'twatch', room})`
- **`request()`** settles on `tour` as well as on `room`.
- **Keys:** T opens the card in a warm-up, and the bracket while watching.

### 4.8 Mock states and tests (with the build)

**Mocks:**

| Screen | Shows |
|---|---|
| `lobby-tour` | `&n=1\|3\|5\|16`, host |
| `lobby-tour-guest` | guest version |
| `lobby-tour-warmfull` | warm-up courts full |
| `hud-tour-wait` | entrant pill |
| `hud-tour-host` | host pill |
| `hud-tour-card` | the tournament card |
| `tour-vs` | VS intro |
| `tour-bracket` | `&n=5\|16`, `&you=through\|out\|watching`, plus the 600x900 tab variant |
| `match-tour-win` | tournament result, win |
| `match-tour-out` | tournament result, out |
| `tour-champion` | champion card |
| `tour-champion-watch` | champion card for everyone else |
| `lobby-tour-ended` | `&why=restart\|empty` |

**`test/tourney.test.mjs`** (as built: `TOURNEY_PORT` base 8614, eight servers 8614-8621 (P_GOLD 8620: a golden point at 2; P_DEF 8621: the default 7 / 11); `AUTOBOT=1 SWING_SERVE=0 READY_S=0 WIN_BY=1 TOUR_WIN=1 TOUR_FINAL=1 TOUR_VS_S=0.3 TOUR_ARRIVE_S=1 TOUR_GAP_S=0.3 TOUR_DONE_S=2 HOLD_S=1 CAL_S=2`, plus a small-cap, a restart, an address, a slow-clock and a hard-cap server). Matches are mostly settled by `leave` forfeits, so they are deterministic.
1. create; joins count; the lobby lists it in `reg` only; the 17th → `tfull`.
2. `tstart` with 3 → `tourfail few`; from a non-host → ignored; double → one start.
3. Host leaves in `reg` → host passes; the last one leaves → deleted.
4. 5 players → 3 matches, exactly one with Matt at level 3, never Matt vs Matt; a forced Matt-vs-Matt is resolved instantly.
5. No `botJoinAt` Matt in a human-vs-human match while one side is arriving; the no-show forfeits after `TOUR_ARRIVE_S`.
6. `pause`, `bot` and `ask` are refused in match rooms; there is no rubber band.
7. No `rematch` vote; `closed round`, then the next round.
8. `leave` before the first ball = forfeit; a drop forfeits after `HOLD_S`; a held seat is retaken by cid.
9. A stranger's `join` on a match room → `full watch:true`.
10. The TTL sweep never closes a match room that is waiting.
11. Warm-ups are exempt from `ADDR_ROOMS` (six entrants behind one `fly-client-ip`), best effort under `ROOM_CAP - 4` (`warm:'full'`); `tstart` near the cap → `busy`.
12. `twatch` only for this tournament's rooms.
13. The champion snapshot has `path`.
14. Restart: kill, respawn, reconnect with `tour=` (and a stray `back=1`) → `tourend restart`, no court revived.
15. No cid string in any `tour` payload.

**Browser e2e:** `test/tourney-e2e.mjs` as built (ports 8622-8624; 4.10). Planned as `test/tour-e2e.mjs` on 8625. Four browsers:
- the host creates, three join by code, and everyone sees **4 joined**;
- Start → VS → the matches;
- a champion card with confetti;
- screenshots at all three sizes.

### 4.9 As built (server): what differs from, or adds to, 4.1-4.8

- **Never ready.** A member seated in a match who never sends a paddle (calibrating) before the first ball would hang the round (`countdown()` waits on `ready`, `slowSeat` only ran once started). In a tournament match `slowSeat` also runs before the first ball once both seats are filled: a side unready for `CAL_S` (from the moment it is both seated and serve-due, or goes unready again: C in the 3-2-1, a reload, `cal:true`) is out, `closed away`, a forfeit (both unready: the first one found goes). Never a lone seat waiting for its opponent (that is the no-show rule). `readyBy`, `TOUR_VS_S + TOUR_ARRIVE_S + CAL_S` after the VS card, stays as the backstop (both unready: side a wins).
- **`ROOM_CAP` is hard between rounds.** `tourKeep()` = for each tournament in play, `max(0, ceil(matches/2) − its match courts still open)`: the courts its next round is owed. `create`, `revive`, `tcreate`, warm-ups (`< ROOM_CAP − 4`) and `tstart` all count it, so ordinary courts cannot take the gap's freed courts.
- **Warm-ups** are not `noTtl`: a warm-up closes the moment its member leaves it (`closed empty` to its watchers), and `you.warm` goes back to `off` (`twarm` makes another). Only match courts are `noTtl`.
- **`tcreate`** from someone already active in a tournament (signed up, or not knocked out) answers that tournament's snapshot and makes nothing. A viewer, an eliminated member or a done one is let go of the old one first.
- **`join`/`watch` of another tournament** while active in one: `joinfail intour`.
- **Where members sit between rounds:** in the lobby (they also get `lobby`). A member in an ordinary court or in the stands when their match is seated is pulled out of it (`tourSeat`).
- **`tleave`** answers `tourend left` to that socket only, in every phase. In `play` the member is `out` and `left` (shown `left: true`), and a match they are drawn in is forfeited at once (seated or not). A member who left before their next round is drawn goes through as a forfeit with no court.
- **`empty`** (in `play`): nobody who has not left is connected (or within `HOLD_S` of dropping). Eliminated members still connected keep it alive.
- **Done:** the champion snapshot goes out at once. After `TOUR_DONE_S` (env knob, default 90) the tournament is deleted **quietly**: no `tourend` (a reconnect then gets `tourend gone`).
- **Reconnect** (`&tour=CODE`): a member's match that is live (or held) seats them again; `&room=` of their own warm-up retakes it, else a new warm-up is made in `reg`; `&watch=1&room=` of a live match of it watches. A non-member gets a viewer snapshot (in `reg` with a cid and no `&watch=1`: signed up, a member dropped past `HOLD_S`; with `&watch=1` a viewer stays a viewer). A stray `back=1` never revives anything.
- **Matt v Matt** is avoided by swapping a Matt with a person from a person-v-person pair; it happens only where Matts outnumber people. Only-Matt rounds are settled at once with no break, so a bracket of Matts runs straight to **Matt is the champion**.
- **Start refused as `busy`** touches nothing: the check is `rooms.size − its own warm-ups + tourKeep() + ceil(n/2) <= ROOM_CAP`, and the warm-ups are closed (`closed tourstart`) only once Start goes through, so `closed tourstart` is always followed by `tmove`.
- **`TOUR_CAP` and one-per-address** count tournaments that are not `done` (a finished one holds no courts).
- **Live bracket:** a live match's `score` is the court's current score, and `watchers` its current spectators (the snapshot is re-sent on each point and each watcher change, coalesced).
- **Log/ids:** match and warm-up courts have `by = null` and `pub = false`, and carry `tag = { tour, kind }`, which rides on their `room` messages.


### 4.10 As built (client): what differs from, or adds to, 4.6-4.8

- **Where the host sees Start.** The lobby's `tour` view is the host's screen only while they are not seated. In a warm-up the same
  things live in the **tournament card** (`#tour-card`, T or the pill), and the HUD corner gets a gold **Start** button beside the pill
  from 4 players (`#btn-tour-go`, labelled **Start tournament with {n} players**), so a lobby screen is never put over a live court. It never starts on one tap mid-rally: it opens the card with focus on the card's own **Start with {n} players**, and it hides while the card is open (one Start at a time). Tab and Shift+Tab stay inside the open card. The card pauses the warm-up like settings does; the
  pause-heal loop, `setDim` and the reconnect re-pause count either card.
- **The pill** is two lines, because the corner is about 335 px wide at 1440 and 1280 (it must stop short of the scoreboard): **Waiting for
  the tournament to begin** over **5 joined** with the T keycap. The host's form is the same text plus the Start button (not "Press T to
  start": the button is the thing to press). Under 900 px the corner is a 10rem column: the trophy, **Waiting** over **5 joined** (in a match: the
  round name). In a match it reads **Semifinal · vs Ben**.
- **Code screen**: two columns in landscape (the code, Copy invite and the rules on the left; the count, chips, reason and actions on the
  right), one column in portrait. The actions stack: **Warm up with Matt** first while under 4, then **Start with {n} players** moves to the
  top as the big gold button. The rules line says how Matt fills an odd count. A guest reads **Waiting for {host} to start** (with the
  count's reason while it is short), plus Warm up with Matt if not in a warm-up. Your own chip reads **You** (not also Host).
- **Leave**: the code screen confirms inline (Stay has focus); the card and the bracket use press-twice ("Press again to leave").
  A viewer's button reads **Stop watching**.
- **Bracket**: `#br-you` says where you stand and `#br-next` separately counts the break (**Final in 4** with its bar), counted down on the
  client (a snapshot only comes on a change). Round headers stick while the columns scroll; the first focus is your own card while you are still in (its Watch if it is live), and the first live match's Watch for a viewer or a player who is out; the focused card (else yours, else the first live match) is scrolled into
  view below its round header once per drawing, and again on every arrow move. The tabs follow the current round; under 480 px they read R1 / Quarters / Semis / Final.
- **Champion**: two buttons, **Back to courts** (Esc) and **See bracket** (the final bracket). A player on the final's court leaves it first
  (its `closed round` would take the card down). The ribbons turn gold.
- **Ended**: `#tour-ended` is a notice at the top of the lobby's home view (above the name), not in the `lobby-down` slot (that is a
  one-line pill); OK or any other view puts it away.
- **Result card**: a forfeit win reads **Through: {name} left**; the final's winner goes straight to the champion card.
- **Mock states** (test/ui-mock.html, `shoot.mjs`): `tourney-courts`, `tourney-host-empty`, `tourney-host-3`, `tourney-host-ready`,
  `tourney-host-16`, `tourney-guest`, `tourney-warmfull`, `tourney-banner`, `tourney-banner-host`, `tourney-card`, `tourney-intro` (`&bot=1`,
  `&final=1`), `tourney-bracket` (`&n=5|16`, `&you=through|out|watching`, `&next=1`), `tourney-win`, `tourney-out`, `tourney-champion`,
  `tourney-champion-watch` (`&matt=1`), `tourney-ended` (`&why=`). `verify.mjs` holds them to 44 px targets, the 12 px floor (600x900 and
  390x844) and AA contrast, and checks a join's count, chip and first focus.
- **Browser e2e**: `test/tourney-e2e.mjs` (ports 8622-8624: game, AirPods, nothing). Four Chromes: the host creates from Courts, Ben joins
  by the list row, Cy by the code boxes, Di by the invite link; the banner counts to 4; Start; VS; a round; the bracket with the losers out;
  a loser watches the final from its Watch button; the champion card with confetti for all four; Back to courts.
- **Ordinary courts are left alone.** A member on an ordinary court between rounds gets the champion and a `tourend` as toasts, never
  a `leave`. A finished tournament (`phase: 'done'`) no longer steers `toLobby()`, the address bar or the reconnect URL; Back from its
  bracket lets it go (`tleave`). Server: `tourRebind` falls through to the normal `joinCode`/`watchCode` when `&room=` is not one of
  the tournament's courts (tourney.test covers it).
- **Lobby focus retries** (every view, not only the tournament's): a view's first focus is tried again up to 4 times, 100 ms apart,
  when the element refuses it (the lobby screen turns visible a frame late under reduced motion).
- **menu.mjs** part B gains B6 (tour, tmove, tourfail, a match court showing the tournament's code, a quiet `closed round` landing on the
  bracket, `&tour=` with no `back=1` on a reconnect, `tourend restart`); its ui.js stub exports the new names.

---

## 5. Docs to update

| Doc | Change (Feature 1 + Tour now; tournament items with Feature 2) |
|---|---|
| `docs/ROOMS.md` | Lobby row fields `ask`, `bot`, `names` (and `tours`); `open` keeps its meaning. Seating: an under-way Matt court → watch + ask; `quick` skips them. Client flow: Quick play / Courts / Play a bot. `1 2 3 4`. Later: code uniqueness across tournaments |
| `docs/SPECTATE.md` | New section **Asking to play**: the message table (2.1), the rules (2.2: underway vs askable, cooldown from the end, 3 s gap, `PROMO_S`), the race matrix (2.3) |
| `docs/API-NEXT.md` | §3.3 Lobby, §4.3 and §4.4 message tables, §6 four levels and keys `1 2 3 4` |
| `docs/ui-spec.md` | §4 components `.court-row`, `.courts-seg`, `.code-boxes.is-sm/.is-huge`, `.ask-card`, `.ask-play`, `.badge-tour`, `.tile-sub` (later `.tour-pill`, `.bracket`, `.vs-card`, `.is-champion`). §5 every copy string above. §6 timings: card in 320ms and out 200ms, bar 10 s linear, skeleton 1.2 s, each with its reduced-motion rule. §7 ids and the ui.js API: `lobbyRooms(rooms, online, tours)`, `lobbyView('courts')`, `viewParent`, `askCard`, `askShowing`, `onAnswer`, `askPlay`, `askCan`, `courtsState` (later `tourView`, `tourPill`, `tourCard`, `tourVs`, `bracket`, `champion`, `tourEnded`). The key list notes Y, N and A are taken |
| new `docs/TOURNAMENT.md` | with Feature 2: 4.1-4.5 in full |
| `web/how-to-play.html` | four levels; later a short "Tournaments" answer |
| `NOTES.md` | **84** Courts: one list, search, Open/Full, a code with Join and Watch (why: two entry points and a 12-row cap hid courts). **85** Ask to play: taking over Matt needs the player's OK (why `started` and not "Matt seated"; 10 s, cooldown from the end, 3 s gap, 60 s promo). **86** Tour: a fourth Matt, appended at index 3. **87** Tournaments (when built: 4-16, 7/11, `TOUR_CAP` 2, reserve 4, no revive) |

---

## 6. Build order and acceptance

### Build order

1. **Tour bot** (server `BOTS`/`BOT_ORDER`/cycling/`botInfo`, client hard-coded 3s, picker 4-wide and 2×2). Run `bot.test.mjs`, `revive.test.mjs` and `pad-e2e.mjs`.
2. **Server ask**: predicates, `seat()`/`joinCode`/`quick`, `info`, messages, `askEnd`, `demote`, hooks. Write `test/joinreq.test.mjs`, then run it, `rooms.test.mjs`, `watcher.test.mjs` and `revive.test.mjs`.
3. **Courts view**: markup, CSS, `lobbyRooms` without the slice, search, switch, states, code area, keyboard, deep links. Then the mocks and `menu.mjs` / `ui-next.mjs` updates.
4. **Ask UI**: `#ask-card`, `#btn-ask`, `switchSeat`, keys. Then the mocks, the `verify.mjs` checks and the `spectate-e2e` flow.
5. **QA loop**: `shoot.mjs` at three sizes plus the reduced-motion pass. Fix, re-shoot, until clean. Run every changed e2e **one at a time** on its assigned port.
6. **Docs** and NOTES 84-86.
7. *(BUILD NEXT)* Tournaments, in order: server (4.1-4.5) with `tour.test.mjs`, then the screens (4.6-4.7), then the mocks, then `tour-e2e.mjs`, then the docs and NOTES 87.

### Acceptance: Feature 1 (each item is a test)

- [ ] Home shows exactly **Quick play**, **Courts**, **Play a bot**. The arrows walk them. `#btn-code` and the home list are gone (`menu.mjs`, `ui-next.mjs`).
- [ ] Courts renders 42 rows (no 12 cap), and search finds row 42 (`ui-next.mjs`).
- [ ] Search is a case-insensitive substring match with prefix matches first; the tab counts follow the query (`menu.mjs`).
- [ ] Open lists `open` + `ask` (+ tournament) rows; Full lists two-human courts; a `watch === 0` Full row is disabled with **Stands full** (`ui-next.mjs`).
- [ ] Code boxes: **Join** seats and **Watch** watches; a full court still offers "Watch instead?"; `?court=CODE` and `&watch=1` still work (`rooms-e2e`, `spectate-e2e`).
- [ ] Loading, empty (both tabs), no-match (with **Use this code**) and down states each show their copy, and the list box height never changes (`verify.mjs`).
- [ ] `/` focuses search; Esc clears a query before going Back; ↑↓/Home/End/←→ walk the list (`menu.mjs`).
- [ ] Two Quick-play sockets are paired even though Matt sat down for the first (`joinreq.test` 1).
- [ ] Joining before any strike seats directly; after a strike it lands watching with a request sent (`joinreq.test` 2-3, `fixes-e2e`).
- [ ] Accept moves the requester into Matt's seat at 0-0; decline, expiry and every cancel path follow 2.3 (`joinreq.test` 4-14).
- [ ] The 10 s cooldown runs from the end of a request and survives a reload; one pending request per court; 3 s gap (`joinreq.test`).
- [ ] A promoted spectator who never gets ready goes back to the stands after `PROMO_S`, and Matt returns at the old level (`joinreq.test` 13).
- [ ] The card sits bottom-left (up under the Court pill in a short landscape window), never takes focus, never blocks Space, Enter, arrows or paddle input, answers to Y/N only while showing, drains for 10 s and auto-dismisses (`verify.mjs`, `spectate-e2e`).
- [ ] The requester's button runs through **Ask to play → Waiting · N → Again in N → Ask again** at a fixed width, with the why in a toast (`verify.mjs` at 1440, 600 and 390, the `watch-ask` mocks).
- [ ] Every Courts/ask control is ≥ 44 px at 600x900; the contrast checks pass; there are no `[data-fit]` clips or overlaps at 1440x900, 1280x720 and 600x900 (`shoot.mjs`, `verify.mjs`).

### Acceptance: Tour bot

- [ ] `BOTS[3].name === 'Tour'`, and every stat lies between Club and Pro (`bot.test`).
- [ ] B cycles Club → Tour → Pro → Rookie; `botinfo.order` is `[0,1,3,2]` (`bot.test`).
- [ ] The picker shows Rookie, Club, Tour, Pro; keys 1-4 send levels 0, 1, 3, 2; the settings seg has 4 options (`ui-next.mjs`, `menu.mjs`).
- [ ] A reload against Tour comes back as Tour (`bot=3`), and `bot=0..2` are unchanged (`revive.test`).
- [ ] Tour's return rate sits between Club's and Pro's (`bot.test`).

### Acceptance: Feature 2 (BUILD NEXT)

- [ ] Create tournament shows the **Needs at least 4 players** disclosure; the host sees a huge code, **Copy invite**, a live count and names (mock plus `tour-e2e`).
- [ ] Joiners warm up against Tour Matt and see **Waiting for the tournament to begin · N joined** (**Waiting** over **N joined** at phone width, `verify.mjs` (l)), updated live (`tour.test` 1, `tour-e2e`).
- [ ] Start is disabled with its reason below 4, and the cap is 16 (`tour.test` 1-2).
- [ ] Odd counts get one Tour Matt; never Matt vs Matt (`tour.test` 4).
- [ ] Matches go to 7 and the final to 11 (win by 2, golden point at 15), with no vote (`tour.test` 7; the defaults and a whole win-by-2 match against Matt on its own servers: `tourney.test` real scoring).
- [ ] Forfeit and hold rules, no-shows and host passing (`tour.test` 3, 5, 8).
- [ ] The bracket between rounds; the eliminated can watch; the champion card has confetti (`tour-e2e`).
- [ ] Tournament rooms are private, exempt from `ADDR_ROOMS`, bounded by `ROOM_CAP` with a reserve of 4, and never closed by the TTL sweep (`tour.test` 9-11).
- [ ] After a restart every client shows **The tournament ended: the server restarted**, and nothing is revived (`tour.test` 14; the words: `verify.mjs` (n)). A member on an ordinary court between rounds gets a toast and reconnects without `&tour=`, so that court comes back like any other.
- [ ] No cid ever appears in a tournament payload (`tour.test` 15).
