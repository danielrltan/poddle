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

