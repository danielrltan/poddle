# Social: friends, online status, invites (spec, 2026-09-29)

The owner: "you should be able to search and add friends. u can add from looking at a profile, or search them and add them
from the results list. then you should be able to see your friends in a list, and it will show who's online or not. then
you can invite them to games / duels / invite to watch from inside a game. this means the social menu should be in the
game in the pause menu somewhere. think of edge cases and implement slowly and carefully."

## 1. Who can use it
- Friends are ACCOUNTS WITH A USERNAME only (usernames are unique and public already; guests' typed names are not).
- Guest: the Friends entry shows "Sign in to add friends" (profile.signIn()). Signed in, no username: "Pick a username"
  (profile.pickName()). Same gate as Ranked (profile.rkGate()).
- Only shown where the account features are on (HOSTED && LOBBY, or ?acctest=1), like the leaderboard.
- Friend rows key on accounts.id, NEVER on the username (renames keep friendships). The wire carries usernames only,
  never account/owner ids (the leaderboard rule; tests check it).

## 2. Data (server/db.js, in EXTRA: CREATE TABLE IF NOT EXISTS, no numbered migration)
- `friends(a INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, b ... same, since INTEGER NOT NULL,
  PRIMARY KEY(a,b), CHECK(a < b))` + index on b. One row per pair (a < b).
- `friend_reqs(from_id REFERENCES accounts(id) ON DELETE CASCADE, to_id ... same, created_at, declined_at NULL, asked_at NULL,
  sent 0|1, PRIMARY KEY(from_id,to_id))` + index on to_id. created_at = the SENDER's clock (expiry, the `at` the sender sees; a
  blocked re-send restarts it exactly as a fresh request would, so the sender can never date a decline or a removal). asked_at =
  the RECEIVER's (when it reached them; NULL = a removal's block, never a request) and never moves, so the receiver's export never
  shows a blocked re-add. sent 0 = a row its sender does not see (a removal's block, or a declined request the sender withdrew).
- Caps: FRIEND_MAX 100 friends per account; REQ_OUT_MAX 20 pending outgoing; incoming list shows the newest 50.
- Retention: a request expires 30 days after created (sweep step `friendreqs`, key in the counts object). A declined
  request is kept (declined_at) until that same expiry so it cannot be re-sent: the sender keeps seeing "Requested"
  (a decline is silent). Friendships last until either side removes it or an account is deleted (cascade) / swept.
- exportOf lists friends (username, since), requests received (username, when = asked_at, declined), sent (username, when;
  sent 1 only) and removed (username, when: my removals' blocks). A sender's sent 0 rows are left out, and so is a received
  row or a removal past its own 30 days that lives on only through the other side's re-send (either would reveal what the other
  side did); the export's NOTES says so. TABLES / admin counts gain both.
- Account deletion cascades both tables (FK). Index both FK columns so the cascade does not scan.

## 3. Rules
- add(name): target must exist with a username, not self. If already friends: no-op 'friends'. If the target has a
  request TO me that its sender still sees as sent (pending, or declined by me; asked_at set): accept it (friends now; a
  declined sender must not be able to tell by getting a request back instead). Not a re-add my removal blocked: see remove. If I have a request out:
  'requested'. Else a new request (caps: 'full' if either side at FRIEND_MAX, 'limit' if REQ_OUT_MAX). Declined earlier
  (and withdrawn) or blocked by a removal, not expired: answer 'requested' as if sent, nothing reaches the other side, and
  the row's created_at restarts (its sender sees 'just now' and 30 days, as for a fresh request).
- accept(name) / decline(name): only for an incoming pending request. accept makes the pair (cap check).
- cancel(name): withdraw my outgoing request (also deletes a declined one? no: a declined row stays until expiry).
- remove(name): delete the friendship. Silent (the other side's list just loses them).
- Per-account rate limits in memory on top of the per-address route limits: adds 30/hour, searches 60/10 min per account.
- Remove = also writes a declined-style row FROM the removed person TO the remover (friend_reqs, declined_at set), so
  the removed person's re-adds answer 'requested' silently for 30 days from the last one (no spam loop after a removal). The
  remover can still add them back (that deletes the blocking row and sends a normal request, whether or not the removed
  person tried again: the remover never learns of a blocked re-add).
- Search: GET q (2..12 chars; LIKE with `_`, `%` and `\` escaped, ESCAPE '\\'; [A-Za-z0-9_]), signed in with a username; case-insensitive username PREFIX match plus the
  exact confusable-key match (usernames.skeleton), top 20, excludes self; each row {name, rel} with rel in
  none|friend|out|in. lb_hidden accounts ARE searchable (the username is already public on courts); decision to confirm.
- Player data for the profile card (public): GET by name -> {name, dev (the developer badge), rank {tier,div}|null, places, rel,
  st (online status, friends only)}. rank + places (place numbers, never values) only when that account is not lb_hidden OR is my friend (or me). No stats
  beyond that: stats stay private (privacy 4).

## 4. Presence (server/game.js, memory only, gone on restart)
- An account is online while it has at least one live lobby socket (ws.viaLobby, not a pad, ws.acct set).
- Status, most engaged across its sockets: 'ranked' (in a Ranked series / VS card) > 'tour' (tourActive) > 'playing'
  (seated with a person) > 'matt' (seated vs Matt or alone) > 'watching' (a spectator) > 'queue' (Ranked queue) >
  'menu'. Offline otherwise.
- Shown ONLY to accepted friends. A presence tick (every 2 s) computes status per online account, diffs against the last
  tick and pushes fresh snapshots to that account's online friends. Sign-out / delete (stats.forget) clears at once.
- Friend lists cached in memory per online account, invalidated by every friend change (same process as the API).
- NEVER trust ws.acct.username (admin rename / delete run in another process, ids can be reused): every snapshot,
  invite send and invite accept reads the account + username fresh from the DB by id. An account id that no longer
  resolves (or resolves to a different owner) drops the socket's acct. The delete API path invalidates caches and pushes
  fresh snapshots to that account's former friends.
- Logs: social lines carry no names, no ids (privacy 7).

## 5. Live channel (WS)
- Server -> client `{type:'social', friends:[{name, st, rank|null}], inc:[{name, at}], out:[name]}`: a full snapshot,
  sent after a signed-in socket's hello and whenever it changes (friend change, presence change). Guests never get one.
- Social messages are dispatched BEFORE game.js's `if (typeof m.name === 'string') ws.name = ...` line and use `to`,
  never `name`, for a target.
- Invites: client -> `{type:'inv', to, k:'play'|'duel'|'watch'}`; server -> sender `{type:'invs', to, k, r}` with r in
  sent|busy|offline|notfriend|full|bad|rate|gone|yes|no|expired; server -> invitee(s) `{type:'invite', id, from, k,
  left}`; invitee -> `{type:'inva', id, yes}`; server -> all the invitee's other sockets `{type:'inviteoff', id}`.
- One pending invite per (sender, target); a new one replaces it. Lives INVITE_S = 30 s. Per sender 8 a minute; 10 s
  per pair after a no / expiry. Gone when: the sender leaves the court it was about (play/watch), the sender goes
  offline, the friendship ends, or on restart.

### 5.1 Kinds
- watch: come watch the court the sender is on (as player or spectator). Any casual court (not Ranked, not tournament).
  Accept = out of wherever the invitee is (quit), then watchCode(sender's room). Refused 'full' at SPEC_CAP.
- play: take a seat on the sender's casual court. Sender must be seated, court not Ranked/tournament, fewer than two
  people seated. Accept: a free seat and no match under way -> seat(). Sender playing Matt (under way or not) -> the
  invitee takes Matt's seat the way an accepted ask-to-play does (the G3 abandon record, join, promo). Two people
  already -> 'full' (nothing moves).
- duel (default meaning, decision to confirm with the owner): a fresh PRIVATE court reserved for the two friends, no
  Matt, a normal casual match (first to 11, win by 2) with the usual rematch vote; counts as a match vs a person. It can
  be sent from anywhere (the lobby Friends view too). Sender must not be in Ranked/tournament or in a match with a
  person under way. On accept both are moved: each quits where they are (a Matt match the sender leaves this way is an
  abandon, not a loss), the court is created (only: the two cids), both seated.
- Invitee busy: in a Ranked series / VS card or tourActive -> not delivered, sender gets 'busy'. In the Ranked queue:
  delivered; accepting leaves the queue first.
- Invitee seated with a person mid-match: delivered; the card says accepting leaves the match and counts as a loss;
  accept = the normal forfeit.
- A tab that cannot be a paddle (!CAN_PADDLE) can accept only watch.

- A watch/play invite to the court the invitee is already on is a no-op (or a promote from the stands for play),
  never a quit (a quit would forfeit). Server-made duel courts respect ROOM_CAP; they count toward the SENDER's address
  for ADDR_ROOMS. The play promote is a room method (answer() closes over room state); refused while promo is set or
  the court is not askable().
- Client: before building accept, verify main.js handles an unsolicited `room` for a new code while in a court (ask card,
  notes, rematch, URL, reconnect params torn down), while `pending` is set, and during the Ranked queue bar. If not, the
  client does its own leave/cleanup before sending inva.

## 6. Client
- web/social.js: one module rendering the Friends panel into a container: search field + results (Add / Requested /
  Friends / Accept), incoming requests (Accept / Decline), outgoing (Cancel), friends list online first with a status
  dot + label, rank emblem, and per-friend actions (Invite: Play / Duel / Watch where eligible, Remove in a menu).
- Lobby: a Friends entry on the home screen (badge = incoming requests, subtitle = friends online) opening lobby view
  'friends' at /friends (VIEW_PATH + server MENU_PATHS).
- In game: a "Friends" row in the pause/settings card opening a friends card (tourCard pattern: mutual close,
  cardOpen(), esc chain, outside-click exemption). Online games cannot pause: the card sits over a live rally, as the
  settings card does. Adds an "On this court" list: the registered people in the SEATS only (names[] + regs[] are
  already on the wire; spectators' registration is not, and is not added).
- Profile card (merged 2026-09-29 with NOTES 140's leaderboard card, #lbp-card, web/profile.js openPlayer(name, { from, rank, via, back })): ONE card, opened from
  search results, friends rows, leaderboard rows and the "On this court" list. It asks /api/leaderboard/player (the eleven stats; 404 = on no board: a quiet
  line, no stats) and, signed in with a username, /api/player (rank + places + rel + st) at once; web/social.js draws its friend row (cardRow).
- Incoming invite card: a corner card outside #hud, visible on every screen, click to Accept / Decline, countdown,
  never takes focus, never steals game keys. Incoming friend request: a toast + badge.
- Names always via textContent.

- main.js calls new ui exports as ui.x?.() (test/menu.mjs stubs ui.js); social handlers go above `if (!seated()) return;`.

## 9. Shipping
Two pushes. A: friends, requests, search, friends list with presence (lobby view + the pause-menu card), the profile card's friend row,
legal. B: invites (play / watch / duel). Re-fetch origin/main between slices; NOTES numbers checked at commit time.

## 7. Legal
Privacy 2 (friend list, requests, presence use), 4 (online status + activity to friends, username searchable, player
card contents, invites), 7 (retention above), 9 (export includes friends), 15 (dated paragraph); terms 4 (no spamming
requests / invites; sanctions), 5; changelog; sitemap lastmod; CLAUDE.md data flows; docs/ropa.md; the db.js export NOTES string ("Opponents are shown only as Matt or a player");
NOTES section. No home notice or "New:" toast (CLAUDE.md "No announcement notices", NOTES 147).

## 8. Contract for slice A (server and client are built against this)
REST (server/api.js ROUTES, needsSignin-feature flag true, needsDb true; a handler-level `session(req)` check -> 401
`signin`; signed in without a username -> 403 `username`):
- GET  /api/friends -> `{friends:[{name, st, rank}], inc:[{name, at}], out:[{name, at}]}`. friends sorted online first
  (by status weight), then by name. st: off|menu|matt|playing|watching|queue|ranked|tour. rank: {tier,div}|null (the
  friend's current Ranked tier/div; null if never ranked). at: ms epoch. `out` excludes declined-silent rows? NO: the
  sender always sees their request as pending until it expires (a decline is silent).
- GET  /api/friends/search?q=<2..12 chars> -> `{rows:[{name, rel}]}`, rel none|friend|out|in, top 20, never self.
  400 `q` for a bad query.
- GET  /api/player?name=<username> -> `{name, rank, places, rel, st}`; no sign-in needed (then rel 'none',
  st null). rank {tier,div}|null and places `{trophies, rally, streak}`, each `{rank}`|null (the place number only, never
  the value: stats stay private) only when the account is not lb_hidden or is my friend (or me: then a hidden account's
  places are where it would stand), else null. st only for a friend (else null). The client draws the developer badge itself (ui.regBadge).
  404 `notfound` (no such username).
- POST /api/friends `{op, name}`, op add|accept|decline|cancel|remove -> 200 `{r, rel, snap}` where r is
  requested|friends|declined|cancelled|removed and snap is the GET /api/friends body. Errors: 400 `op`, 404 `notfound`,
  409 `self`, 409 `full` (a side at FRIEND_MAX), 409 `limit` (REQ_OUT_MAX), 409 `norequest` (accept/decline with
  nothing incoming), 429 `rate`.
WS: server -> client `{type:'social', friends, inc, out}` (the same body as GET /api/friends) after a signed-in socket's
hello (only sockets with a username), and pushed again whenever it changes. Also `{type:'socialoff'}` when the socket
loses its account (sign-out / delete) so the client clears the panel.
Menu path /friends (server MENU_PATHS) -> lobby view 'friends'.

## 10. Slice B accept flow (from reading main.js, 2026-09-29)
main.js's `room` handler only tears down the old court's UI for a Ranked/tournament move (`moved`); an unsolicited `room`
for another code while phase is 'play' just swaps the `room` variable under the old court's UI. So invites are
CLIENT-DRIVEN, in two steps, and a failed accept never costs the invitee their game:
1. invitee `{type:'inva', id, yes:true}` -> the server re-checks everything (friendship, sender still on that court,
   court alive `!r.dead && rooms.get(code) === r`, not Ranked/tour, seats/stands room, invitee not in Ranked series /
   tourActive) WITHOUT moving anyone, and answers `{type:'invgo', id, k, code, t}` with a single-use ticket t (15 s, bound
   to that socket + room + kind). A duel creates its reserved court here (only: the two sockets' cids, no Matt,
   ROOM_CAP respected, counts toward the sender's address) and sends `invgo` to BOTH (the sender's inviting socket).
   Any failure: `{type:'invs'/'invgo', r:<why>}` and nobody moves.
2. the client leaves where it is the normal way (leave(): a forfeit only if forfeits(), which the invite card warned
   about; the Ranked queue is left first), then sends join/watch with `t`: `{type:'join', code, t}` /
   `{type:'watch', code, t}`. The server honours the ticket: play on a Matt court = the promote path (room method,
   G3 abandon record, join, promo; refused while promo is set or !askable()); a free seat = seat(); watch = watchCode.
   Without a valid ticket join/watch behave as today.
- The sender's Matt match left because a duel was accepted is an abandon, not a loss (the leave carries the duel
  ticket).
