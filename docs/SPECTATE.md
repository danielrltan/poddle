# Spectators, rematch, seat hold, pause: protocol contract (extends docs/ROOMS.md)

Decisions are the player's (2026-09-20): a full court offers "watch instead"; spectators stay through rematches; no
rematch agreed -> EVERYONE (both players, all spectators) goes back to the lobby; a player who drops mid-match gets his
seat held briefly, then the match ends; public games can be found and watched from the lobby; spectators land in the
broadcast side-on view and can switch views.

## Roles
A socket in a room is a **player** (seat 0 or 1, at most 2 humans) or a **spectator** (at most 8). Spectators are never
counted by `humans()`, never take a seat, never block or trigger the bot, never keep a room alive.

## Joining to watch
- `{type:'join', code}` on a room whose two human seats are taken -> `{type:'joinfail', reason:'full', watch:true, code}`.
  (`watch:false` when the 8 spectator places are gone.) The client asks: "Court is full. Watch instead?" Yes / No.
- `{type:'watch', code}` (lobby only) -> `{type:'room', code, public, role:'spectator'}` then
  `{type:'welcome', side:null, role:'spectator', court, names:[n0,n1]}` and the normal `state` stream. Fails with
  `joinfail` `notfound` | `busy` (spectator cap). Watching a room that still has a free seat is allowed (you chose to watch).
- `room` for players gains `role:'player'`. Page URL / reconnect: `?room=CODE&watch=1`; socket URL `lobby=1&room=CODE&watch=1`.
  A spectator reconnecting with its `cid` is simply a spectator again.
- From a spectator the server accepts only `ping`, `net`, `leave`. Everything else is ignored.
- `state` gains `watchers` (count). Spectators obey the same per-socket `net` rate and bufferedAmount guard as players.

## Lobby list
`lobby.rooms` now lists every **public** room: `{ code, players, open, watch, watchers, score:[a,b], live }`.
`open` = a human seat is free (joinable). `watch` = spectator places left. Private rooms are never listed; they can be
watched with the code.

## Match end and rematch
- Today a finished match restarts by itself (`newMatchAt`). That goes. At match end the server sends to the whole room
  `{type:'matchover', winner, score:[a,b], forfeit:boolean, rematchBy: seconds}` (20 s) and the ball stays dead.
- Players answer `{type:'rematch', yes:boolean}`. Every change is broadcast:
  `{type:'rematch', votes:[v0,v1], left: secondsLeft}` with `v` = true | false | null. A bot seat always votes true.
- All seated players true -> `{type:'rematchon'}`, new match, first serve alternates from the last match, scores 0-0,
  spectators stay where they are.
- Any false, a player leaving, or the 20 s running out -> `{type:'closed', reason:'norematch'}` to players and
  spectators alike; every socket is returned to the lobby (fresh `lobby` message) and the room is deleted at once.

## A player drops mid-match (two-human rooms)
- Socket closes without `leave` (wifi): the seat is **held 15 s**. Room time stops (as in pause), everyone gets
  `{type:'hold', side, left: seconds}` once a second. Same `cid` returns -> `{type:'holdoff'}`, the point is replayed
  (re-serve by the same server), score kept. Not back in 15 s -> forfeit: `matchover` with `forfeit:true`, winner = the
  one who stayed, then the rematch rules above (the leaver cannot vote, so it ends in `closed` for everyone).
- Explicit `{type:'leave'}` from a player mid-match: immediate forfeit, same path, no hold.
- This REPLACES the ROOMS.md rule "the stayer gets `left`, then the bot comes back" for rooms that had two humans.
  Rooms that were human + bot are unchanged (the human leaving empties the room; spectators get `closed`, reason `empty`).
- Before a match has started (waiting alone in a room, bot not yet joined, or still 0-0 with no serve struck) a leaver
  just leaves: no forfeit, no hold.

## Pause (see also the settings panel)
`{type:'pause', on}` from a player, honoured only when the room has exactly ONE human player (the other seat is the bot or
empty). Spectators do not prevent it. Paused: room time does not advance, swings and paddle input are ignored, `state`
keeps flowing with `paused:true` and an unchanged `t`. `{type:'paused', on, by}` tells the room. Auto-resume: the pauser
leaves or drops, a second human takes the other seat, or 10 minutes pass. Refused (two humans) -> `{type:'paused', on:false, refused:true}`.
Clients: while `paused` or `hold` the ball is frozen where it is (no coasting); on resume the server clock offset is
reset (the server's `t` stood still while wall time ran).

## Spectator client
No AirPod, no bridge, no calibration, no webcam. Title -> lobby -> Watch -> straight onto the court.
Views, switchable at any time (on-screen chips and keys 1-4; the choice is remembered):
 1. **Broadcast** (default): side-on from beyond a net post, elevated, both players in frame left and right.
 2. **Split screen**: both players' own points of view side by side (two viewports, one scene; per-view fence visibility).
 3. **Player view**: behind one player exactly as they see it; pressing 3 again flips to the other player.
 4. **Free cam**: drag to orbit, scroll to zoom, clamped above the ground and outside the fences' interior clutter.
HUD: both names and the score, the room code, a "Watching" tag, the watcher count. Players see the watcher count too.
Result screen: players get Rematch / Leave with the other player's choice and the countdown; spectators see the result
and "Waiting for a rematch" and are carried into the next match or back to the lobby.

## Names (player request)
- The player types a name on the lobby screen before choosing anything (one field, prefilled from last time, kept in
  localStorage). 1-12 characters after trimming; the server strips control characters and angle brackets, collapses
  spaces, and falls back to `Player 1` / `Player 2` when empty. No accounts, no uniqueness.
- It rides on the seat request: `{type:'quick'|'create'|'join'|'watch', ..., name}`. The server owns the truth:
  `welcome.names = [n0, n1]` and `{type:'names', names:[n0,n1]}` to the whole room whenever a seat changes hands
  (spectators' names are not shown anywhere).
- The bot is called **Matt** at every level (levels stay Rookie / Club / Pro as a difficulty, e.g. "Matt · Club").
- Names are used wherever the game says who did something: scoreboard, point banner ("Daniel scores"), serve
  indicator, match result ("Daniel wins"), rematch votes, hold ("Waiting for Daniel"), spectator HUD. The local player
  may still be addressed as "You" where that reads better ("You win"); spectators always see names.
- Changing it later: the settings panel has a Name row (same field, same rules). In a room the client sends
  `{type:'name', name}`; the server sanitises, stores it on the seat and sends `names` to the room. In the lobby it only
  updates localStorage. Spectators may send it too (stored, shown nowhere).
- The name is asked for ONCE: the first time a player reaches the lobby the field is empty and focused and the tiles stay
  disabled until it has 1+ characters; after that it is remembered (localStorage `poddle.name`) and prefilled, never asked again.
- Names are rendered with textContent only, never innerHTML.

## Seat status (shown on the character)
`state.paddles[n].status` is `'calibrating' | 'paused' | 'away' | null`. `calibrating`: no `paddle` received yet from that
seat, or the client sent `{type:'status', cal:true}` (cleared by `cal:false` or the next `paddle` after it). The next serve
waits while any human is calibrating. `paused`: the seat that paused the room. `away`: the seat being held for a reconnect.
Clients white out that character and float a tag over it: Paused / Calibrating / Reconnecting, each with an icon.

## As built (the integrator's notes; where the code and the text above differ, this is what runs)
- `matchover` also carries `names` (as they were at the end: a forfeit has emptied a seat by then). A `rematch` message follows
  it at once whenever a vote is already known (Matt's yes, a forfeiter's no).
- After a forfeit the room stays until the stayer answers, leaves, or the 20 s run out, so the result card can be read; it seats
  nobody meanwhile (`open:false`, a join gets `full`). The client disables Rematch there: only Leave is left.
- Hold and forfeit do not apply in the legacy room LOCAL (no `lobby=1`). When the last human leaves, spectators get
  `closed empty`; the room itself still waits out its 30 s as before.
- The lobby lists public rooms with at least one human in them (an empty public room is not listed).
- A `pause` that changes nothing answers only the asker. `bot` is ignored during a rematch vote. A human joining a bot room
  during its vote gets `rematchon` and a fresh match. Watching with a cid that is seated somewhere counts as that seat leaving.
- Names also lose zero-width and bidi characters. The joiner is not sent `names` (the welcome has them). `pong.t` is room time.
- Page URL: `?court=CODE[&watch=1]` (`?room=` is a silent alias, rewritten). Socket URL and messages keep `room`.
- Seat status: `status` is only present while set (like `wait`). `{type:'status', cal}` is heard from players only, booleans only.

## Added by the fixer (after the attack, the critics and the verifiers)
- **A calibrating seat cannot hold a match for ever.** Two humans, a ball already struck, the serve waiting on a seat that is `calibrating`: after 60 s
  (`CAL_S`) that seat is out (`{type:'closed', reason:'away'}`, back to the lobby) and it is a forfeit for the one who waited (`matchover`, `forfeit:true`).
  The last 30 s are counted down to the room, `{type:'wait', side, left}` once a second, then `{type:'waitoff'}` (also when the seat is ready again in time).
  Clients show the same card as a held seat ("Waiting for Ben 27"). Before it: `status cal:true` and silence held the serve for good, `pause` was refused,
  and the only way out for the honest player was his own forfeit.
- **A bot court with people watching is held too.** A socket that closes without `leave` while ONE human is seated and at least one spectator watches: the
  seat is held `HOLD_S` like any other (`hold`, room time stops, `holdoff` when the same `cid` is back, nobody else may sit down meanwhile). Not back in time:
  the court empties as it always did (`closed empty` for the spectators). `leave` stays immediate. Nobody watching: nothing changes. This REPLACES "Rooms that
  were human + bot are unchanged" above for a dropped socket; the pauser dropping ends the pause first, then the hold starts.
- **Names** also lose every character that draws as nothing (format characters, Hangul fillers, the braille blank, the grapheme joiner, tags), keep at most
  2 combining marks in a row, and must have a letter, digit, symbol or punctuation mark left, otherwise it is `Player N`. A human may still be called Matt.
- **Swings carry `final`** (`web/motion.js` settles every swing): the first report is a bet, the settled one follows 60-280 ms later. The server serves at
  once, and calls a smash, only on a settled report (absent = settled, for a client from before). A re-aim's `launch` carries `n`, and `kind` when the settled
  swing changed it: that is where a smash is announced when the hit went out on a bet.
- **Limits.** 200 messages a second per socket are heard, the rest dropped unread, past 1000 the socket is closed. A socket with 256 KB unread is closed.
  One address (`fly-client-ip`; never this machine's own) may have 4 rooms of its making standing: `busy` beyond.
- **Result card.** After Rematch the Leave button stays open (Leave then = leaving the vote: `leave`, which closes the court for everyone). After a forfeit
  there is no countdown on the card and spectators are not told to wait for a rematch.


## Asking to play (docs/COURTS-TOURNEY.md 2.1-2.3; test/joinreq.test.mjs)
A spectator watching ONE human play Matt may ask for Matt's seat. The player gets a small corner card for 10 s and answers Y or
N (or a click); the server enforces every rule, the clients only draw.

**When.** Two predicates in the room (never in `LOCAL`):
- `underway` = one human, Matt seated, a ball already struck, no result card. A `join` (code, link or list row) into such a court
  is not a seat: the joiner is let in to watch (`room` with `asked:true`, role spectator) and asked at once. Before the first
  strike (share screen, calibrating, the 3-2-1) and on a bot court's result card a joiner still sits down directly, as always:
  Matt is seated within 2.5 s of nearly every lone human, so "Matt is seated" alone would turn every friend's code into a request
  and stop Quick play from pairing. `quick` never picks an under-way court. `&watch=1` / `watch` only watches, never asks.
- `askable` = one human, Matt seated, no result card, no held seat, no seat just given away. Paused is fine (the card shows over
  the settings panel). A spectator's `ask` is heard only here.

**Rules.** ONE pending request per court. It lives `ASK_S` (10 s); silence is a no. A requester waits `ASK_COOL_S` (10 s) counted
from the END of their request (a no, an expiry, walking out of the stands mid-request, or being sent back to the stands after
`PROMO_S`), keyed by `cid` so a reload does not reset it, and by address so a new cid is no way round it. A request the court
ended (the player left, dropped or reloaded, the match ended) charges nothing. A court rests `ASK_GAP_S` (3 s) between two requests. Asking while another request is pending
or during the gap charges no cooldown. A spectator let into the seat has `PROMO_S` (= `CAL_S`, 60 s) to get a paddle ready;
otherwise they go back to the stands and Matt returns at the level he had. If the player who said yes leaves first, the new player
is the court's only human and keeps the seat. After a restart a revived Matt match with points on the board is under way at once,
so a stranger cannot take Matt's seat while the player recalibrates.

| message | direction | fields |
|---|---|---|
| `ask` | spectator -> server | `{type}`. From a player or the lobby it is never routed |
| `askstate` | server -> requester | `{type, s, left, why, busy}`. `s`: `sent` (pending, `left` = s to expiry), `no` / `expired` (`left` = cooldown), `wait` (cooldown running, or `busy:true`: someone else's request or the gap), `gone` (the player left, dropped, the match ended; `left` = cooldown), `refused` (`why`: `humans`, `nomatt`, `over`), `yes` (just before `room promoted`) |
| `askplay` | server -> the seated human | `{type, id, name, left}`. `id` counts up per court (never a cid); `name` already cleaned. Re-sent with the time left when the player reloads mid-request |
| `askoff` | server -> the seated human | `{type, id, why}`, `why`: `yes`, `no`, `expired`, `gone`, `late`. The card closes on any of them |
| `answer` | seated human -> server | `{type, id, yes}`. Heard BEFORE the pause gate. Dropped unless `id` is an integer and `yes` a boolean. A stale, repeated or unknown `id` gets `askoff late` |
| `room` | server -> requester | `asked:true` (in the stands, a request went out); `promoted:true, role:'player'` (accepted: `welcome` as a player follows, Matt gone, 0-0, `names`); `demoted:true, role:'spectator'` (not ready in `PROMO_S`) |
| `promoff` | server -> the player | `{type, name}`: "Sam wasn't ready. Matt is back." |
| `lobby.rooms[i]` | server -> lobby | adds `ask` (under way and a place to watch), `bot`, `names`; `open` now also means "not under way" |

**Race matrix** (each row a case in test/joinreq.test.mjs): a join before a strike seats directly; after a strike it is watch + ask;
the player reloading mid-request on a half-open socket retakes the seat and gets the card again (a clean reload drops the seat into a hold, which ends the request with no cooldown); a double accept promotes once (the second is `late`);
accept after expiry is `late`; the requester leaving closes the card (`askoff gone`); the player leaving sends the requester
`askstate gone` then `closed empty`; the player dropping with people watching holds the seat and ends the request (`gone`, no cooldown);
a second spectator asking while one is pending, or inside the gap after one, gets `wait busy`; the match ending ends the request; a promoted spectator who
never sends a paddle is demoted after `PROMO_S` and the player hears `promoff`; `answer` while paused is heard.

**Clients.** The player's card sits bottom-left outside `#hud`, never takes focus, never swallows a key (its buttons are out of
the Tab order), answers to Y / N only while it shows, drains for `left` s. The requester's button (`#btn-ask`, key A) shows only
to a spectator watching one human and one Matt, on a device that can be a paddle; it reads Ask to play -> Waiting · Ns (the
player's time to answer) -> Again in Ns (until you may ask; the why, with the player's name, is a toast) -> Ask again, at one
fixed width.
