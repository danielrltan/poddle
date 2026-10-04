# Record of processing activities (GDPR Art. 30; internal, not served)

Controller: Daniel Tan, operator of Poddle (poddleball.com), hello@danielrltan.com. No processor other than those named
below. No EU/UK representative appointed (see NOTES.md 94, Q18: pending counsel). Source of truth for the fields and
periods: docs/ACCOUNTS.md 2.2 (schema) and 10.5 (retention), server/db.js (`sweep`). Update this file in the same
commit as any change to those, together with web/privacy.html.
Last reviewed: 2026-10-02 (the profile card shows its stats for every account with a username that is not lb_hidden, on a board or not, NOTES 166; also the profile card shows the current win streak, NOTES 164; before that 2026-09-30: Ranked mode removed, NOTES 157, docs/TROPHIES.md: no queue, no series, no stadium; trophies are earned in every
counted match by a signed-in account with a username, the rank emblem shows on every court; no new data stored, `match_log.series` always null; sections 2, 3, 3a, 3b and 4
reworded, together with web/privacy.html); 2026-09-29 (Friends, slice A: friends, friend requests, search, online status to friends, and the profile card's friend row: section 3b, no invites
yet; the same day, leaderboard profile cards, NOTES 140: the share card's subset made public for every listed player (all places since NOTES 141), no new data stored, and the same card now
also opens from Friends with /api/player's rank emblem and leaderboard places); 2026-09-28 (an eighth rank, Master, NOTES 124: no new data, ranks re-derived from stored trophies; Save my stats removed: stats are always recorded, NOTES 116; 2026-09-27 Ranked mode, NOTES 112-113; play counters and share cards, NOTES 114; before that 2026-09-24, the full launch).

## Recipients common to every activity
- Fly.io, Inc. (host; Toronto region `yyz`): process memory, request logs (~7 days), the database volume `poddle_data`
  and its daily snapshots (kept 5 days; snapshot storage location to be confirmed by the operator, Q6).
- No analytics, advertising or data broker recipients. Nothing is sold or shared for advertising.

## 1. Playing the game (live match)
- Data: display name typed (12 chars), tab id `cid`, phone pairing code, court/tournament codes, seats, score, swings,
  position and phone motion (relayed), emotes, IP address.
- Subjects: players and spectators (13+, under 18 with a parent's permission).
- Basis: contract (Art. 6(1)(b)): providing the game the visitor requests (as web/privacy.html states; whether
  legitimate interests suits 13-15-year-olds better is an open question for counsel, and both files change together).
- Recipients: the other players and spectators on the court (names, moves); Fly.io.
- Retention: memory only, until the match ends or the server restarts. Never written to disk.
- Security: TLS; nothing persisted; logs carry court codes only (no names, IPs, cids).

## 2. Abuse limits
- Data: IP address (IPv4 whole, IPv6 first 64 bits), in memory; keyed hashes of it (key replaced daily) for API rate
  limits; court/tournament counts per IP; ask-to-play cooldown. (The Ranked queue's cap of 2 entries per computer key went with the
  mode, 2026-09-30: there is no queue.)
- Basis: legitimate interests (keeping a free service online without spam, flooding or attacks).
- Retention: memory only, at most 24 h, pruned every minute, gone on restart.
- Security: the raw IP never reaches the database or the logs.

## 3. Game statistics
- Data: SHA-256 of a random device id (`localStorage['poddle.device']`); owner rows (created, last match or sign-in);
  profile (matches played, W/L, streaks, points, tournament titles, best rally, hardest hit and fastest swing with
  dates; play totals over every counted match: hits, returns, chances, winners, aces, smashes, points won/lost,
  seconds played); Matt ladder (four rungs Rookie, Club, Tour, Pro: W/L, abandons, streaks, first win date, best margin);
  trophy ladder (`ladder` table, docs/TROPHIES.md 1 and 3, written only for a signed-in account with a username, in every counted match of
  any kind: trophies and best trophies, rank tier and division, best rank/division and when, W/L and streaks in matches against people played
  for trophies (counted games and a leaver's loss, a loss held at a floor included), Matt W/L, Matt trophies awarded today, last change;
  `match_log.mode` ('ladder' when a seat was eligible at the start, else 'casual'), `delta_a/b` (the trophy change per side), `series`
  always null since 2026-09-30).
- Basis: legitimate interests (Art. 6(1)(f)): giving every player a record of their progress. Recorded for every player who
  plays (a guest by the random device id, a signed-in player by the account); there is NO off switch (Save my stats REMOVED
  2026-09-28, NOTES 116; the client deletes a leftover `poddle.stats.on`). Safeguards: self-serve download and deletion
  (privacy page, Your data), the right to object by email (hello@danielrltan.com), private by default, short guest
  retention. A player who deletes and plays again is recorded again under a new id. Canada: implied consent by playing,
  withdrawn by deleting and no longer playing, or by writing to us. Consent is not the GDPR basis (Art. 8 would need
  verified parental consent under 16). The server still honours a `nostats` frame from a tab loaded before the removal
  (that socket stays anonymous) for compatibility only.
- Recipients: only the owner; Fly.io. Exception, the global leaderboard (NOTES 126, 2026-09-28): anyone sees the top 100 of three
  boards (trophies, best rally, best win streak vs people) with username, value, place and rank emblem, for signed-in accounts
  WITH a username only (never guests); on by default, the account's Show me on the global leaderboard switch (accounts.lb_hidden)
  removes it at once; and, by clicking a name anywhere (on a board at any place since NOTES 141; every account with a username that is not lb_hidden, on a board or not, since NOTES 166), the profile card (NOTES 140, 2026-09-29): the share card's subset
  (rank/div/trophies/Pro place, toughest Matt beaten, the card's eleven stats, NOTES 145: win rate + W-L vs people, time on court, best
  streak vs people, return rate, points won %, rally, swing, winners, aces, smashes, titles) plus, since 2026-10-02 (NOTES 164), the current win
  streak (the highest of the streak vs people and at each Matt level; profile card only, not the share card); the same switch
  removes it at once; basis legitimate interests (Art. 6(1)(f)) with that switch and objection by email. Exception, the rank emblem
  (docs/TROPHIES.md 3.9, 2026-09-30; before that only in Ranked mode): the rank and its division, e.g. Gold II, never trophies or record,
  beside the name, to the opponent and to spectators of ANY court the player sits on (scoreboard, result card, tournament VS card and
  bracket; never the court list), for a player with a ladder row (one exists once a match against a person was played for trophies or Matt
  paid trophies, so a 0-trophy Bronze I emblem can show after a first floored loss). Basis for that: contract (Art. 6(1)(b)), part of
  playing on a court (web/privacy.html, the legal-basis table).
  The same profile card also opens from Friends (section 3b, 2026-09-29) and there adds GET /api/player: anyone who knows the username (the endpoint needs no
  sign-in; the game asks it only for a signed-in viewer with a username) gets the rank emblem and the leaderboard places
  ({rank} on each of the three boards, the place number only, never the value; for every listed account)
  of an account with a username that is not lb_hidden; friends and the player see them even when hidden (where it would stand). Basis: legitimate interests, the same switch and objection as the leaderboard.
- Retention: guest statistics 90 days after the last recorded match, 7 days if only one match was ever recorded;
  account statistics with the account (below). Deleted rows are zeroed (`secure_delete=ON`) and the WAL truncated.
- Security: device id stored only as a hash; it never travels in a URL; export/delete need the raw id or a session.

## 3a. Share cards (docs/SHARE.md; opt-in, Your stats > Share card)
- Data: table `share` (owner id, a 10-char random slug from `crypto.randomBytes`, never derived from an id; created
  date). One per owner. In memory only: a keyed hash (daily key) of the requester's network address counting card
  renders a minute (server/share.js), and the last 64 rendered PNGs (until replaced or a restart; privacy section 7 says so).
- Made public to anyone with the link (page /c/<slug> and its PNG, both `noindex`): the username (or "Poddle player";
  guest display names are never stored), the rank and division with its emblem and the trophies
  (Bronze I, 0 trophies, before any trophies are earned), the toughest Matt beaten, the same eleven stats on every card, zeros
  included (NOTES 145: win rate vs people with the W-L record under it, time on court over counted matches of every kind, best win
  streak vs people; return rate, points won %, longest rally, fastest swing, winners, aces, smashes, tournament titles), read from the profile
  at request time.
- Basis: contract (Art. 6(1)(b)): the sharing feature the player asks for; stopped at any time (Stop sharing).
- Recipients: anyone the player gives the link to; the servers of the apps it is pasted into (link-preview
  crawlers: iMessage, WhatsApp, Discord, Slack, X, LinkedIn and so on), which may keep their own preview copy; Fly.io.
- Retention: until Stop sharing, or deleted with the profile (cascade: Delete my data, the guest 90 d / account 24 month
  sweeps). A guest->account merge deletes the guest's link. Responses are `Cache-Control: public, max-age=300`. A guest
  who clears storage can no longer reach Stop sharing: the link lives until the
  guest sweep or an emailed request (the privacy page says so). The operator stops a link with `node server/admin.js
  unshare <link or code>` (sending the link is enough: it grants nothing more than itself) or `unshare-user <username>`
  (an offensive username, Terms 5). Stop sharing while signed in also stops the browser's unmerged guest link (the caps).
  The PNG cache is in memory only: Stop sharing, Delete my data and a merge clear that link's pictures; the sweeps and
  the admin CLI (another process) cannot, but a dead link never serves one (the owner is checked first).
- Security: unknown or malformed slugs get a 404 and nothing is rendered; per-computer render budget; no slug, name or
  id in the logs; the export includes the link (`share: { url, created }`).

## 3b. Friends (docs/SOCIAL.md; accounts with a username only; slice A, 2026-09-29: no invites yet)
- Data: `friends` (the two account ids, a < b, and since; at most 100 per account) and `friend_reqs` (from, to, created,
  declined_at, asked_at, sent). created is the sender's clock (expiry, the time the sender sees; a blocked re-send restarts it as
  a new request would); asked_at is when the request reached the receiver (NULL: a removal's block) and never moves; sent 0 =
  a row its sender does not see (a removal's block, or a declined request the sender withdrew). A decline is silent (the row is
  kept with declined_at until expiry, the sender still sees "Requested"); a removal writes a declined-style row FROM the removed
  person TO the remover so the removed person cannot re-request for 30 days (the remover may still add them back, which deletes
  that row and sends a normal request, whether or not the removed person tried again). Adding a player whose request to you is
  still out on their side (pending, or declined by you) accepts it. In memory only: presence (online + a coarse status:
  Online, Playing Matt, In a game, Watching, In a tournament; never the court
  code), each online account's cached friend list, per-account rate buckets (adds 30/hour, searches 60/10 min). Search text
  (2..12 chars) is used to answer the query, never stored or written to our logs (it rides in the URL, so Fly.io's platform
  logs, ~7 days, may hold it, as for /api/player?name=). Browser: nothing (the one-time notice and its `poddle.friendsSeen` key were removed, NOTES 147).
- Subjects: signed-in players with a username (13+, under 18 with a parent's permission). Guests cannot use it.
- Basis: contract (Art. 6(1)(b)) for the friends list, requests, and the status, rank and places shown to accepted friends
  (the feature the player chooses to use). Legitimate interests (Art. 6(1)(f)) for being findable in search (the username is
  already public on courts; lb_hidden accounts are findable too) and for the profile card's public part (rank emblem + places when
  not lb_hidden; the eleven stats only for an account on a board, section 3); safeguards: the Show me on the global leaderboard switch, silent declines, the 30-day re-request block,
  per-account and per-address limits, objection by email.
- Recipients: the requested player sees the sender's username and the time; accepted friends see username, online status and
  activity, rank emblem and places; anyone can open the profile card (username, developer badge, and rank + places when listed; the eleven stats when on a board);
  the card's friend row shows the viewer the relation and, to a friend, the status;
  other signed-in players see the username in search results with the relation (none, friend, requested, incoming); Fly.io.
  The wire carries usernames only, never account or owner ids.
- Retention: requests 30 days after created (the last send), declined or not (sweep step `friendreqs`), deleted at once on accept or
  cancel (a declined row stays until expiry even if cancelled); friendships until either side removes them or either account is deleted (Delete my data, the 24-month idle
  sweep; FK cascade on both tables, both FK columns indexed). Presence, caches and rate buckets: memory only, gone on sign-out,
  deletion or restart.
- Security: rows keyed on accounts.id, never the username (renames keep friendships); every snapshot re-reads the account
  and username from the database by id; social log lines carry no names and no ids; the export lists friends (username,
  since), requests in (username, asked_at, declined) and out (username, when; only rows the sender sees) and the removals
  (username, when), never ids. A sender's sent 0 rows are left out of their own export, and a received row or a removal past its own 30
  days that lives on only because the other side re-sent is left out of the receiver's (listing either would reveal the other
  side's decline, removal or re-send: Art. 15(4), the rights of others); the export's notes and privacy 9 say so.

## 4. Fair-play checks (the automated counted / did-not-count decision)
- Data: during a match (R19, NOTES 198), each swing report checked against the paddle stream (turn rate and orientation, 20 Hz) the
  client already sends, the last 1.5 s held in memory per seat, only the flag written (in `match_log` reasons: `swing_motion` when enforced, `swing_motion_seen` while STATS_MOTION_ENFORCE is off); at match end, the two players' IPs compared in memory; in memory for up to 24 h, keyed hashes of the network
  address linked to device-id hashes, cids, accounts and recent results (link map); in the database, `match_log`:
  time, kind, Matt level, the two owner ids (never names), score, winner, ending, counted flag (`ranked`), rule reasons, length.
  Trophies (docs/TROPHIES.md 3, 2026-09-30; the Ranked series are history): for a signed-in account with a username, every counted game
  against a person moves trophies (about +30 at a gap of 0; since NOTES 194 a loss costs 6 in Bronze up to 34 in Pro, from both seats' counts at the start; the winner's gain is halved on
  `new_opponent`); a game that does not count awards none. Leaving a game against a person after the first ball is struck (Leave, or a seat
  held past its time) always costs the leaver the full loss, whatever the verdict; the stayer takes the win only when the game carries
  nothing beyond the forfeit's own flags (`early_forfeit`, `leaver_ahead`, `afk`, `too_fast`); before the first strike nothing is written.
  A played-out counted win against Matt at the rank's level or harder pays a few trophies under a daily cap (`MATT_DAY`) and the 899
  ceiling; a Matt loss, leave or drop pays or costs nothing. R10 (repeated pairs) counts games. R11c (a win over a player who is not yet
  established withheld, and the trophy gain halved) is OFF since 2026-09-28 (NOTES 129, the owner's choice): it can be turned back on with STATS_ESTABLISHED=1. The players are told why with the same words as today.
- Basis: legitimate interests (keeping statistics fair; must run whatever an individual player would choose).
- Automated decision: whether a match counts toward statistics. Effect limited to the player's own statistics; no
  legal or similarly significant effect (Art. 22 not engaged). Players can contact the operator to contest.
- Recipients: both players are told when a match did not count (same network / same browser); Fly.io.
- Retention: memory items at most 24 h; `match_log` 30 days (rule R11b looks back 30 days; the export shows recent
  matches), sooner, oldest first, when the database nears its size cap; at most `LOG_CAP_DAY` (100) rows per owner a
  day, and none for leaving a match against Matt; owner columns are nulled when either player deletes.

## 5. Sign in with Google and accounts
- Data kept: Google account identifier (`sub`), username and its folded uniqueness key, account created / renamed
  dates, merge count, merged device hashes (at most 50); sessions: SHA-256 of the `__Host-poddle_s` cookie token,
  created, expires (180 days), last used (hourly). Received but discarded at once: the ID token's email,
  name and picture (Google always includes them); never stored or logged.
- Data in the browser: cookies `__Host-poddle_s` (session, HttpOnly, Secure, 180 days) and `__Host-poddle_n` (nonce,
  10 minutes; the server keeps a SHA-256 of each nonce it issued, in memory only, for the same 10 minutes, so each is
  used once). The sign-in card states the age condition (13+, under 18 with a parent's permission); Google's script loads only when that card is opened.
- Basis: contract (Art. 6(1)(b)): the account the player asks for. Fair-play checks on accounts: legitimate interests.
- Recipients: Google LLC (United States; EU-US Data Privacy Framework) learns the player signed in to Poddle and sets
  or reads its own cookies / FedCM in its sign-in window; the username (with a registered-player badge) is shown to
  opponents, spectators, the court list and tournament brackets, and is findable by other signed-in players in friend
  search, and a public profile card exists for it (sections 3, 3b); Fly.io.
- Retention: until the player deletes the account; deleted after 24 months with no sign-in and no recorded match;
  sessions deleted at sign-out, expiry (180 days) or account deletion; a former username's folded key (no link to any
  account) held 30 days after a rename, 90 days after a deletion. Deleting the account does not remove Poddle from
  the player's Google connections (the privacy page says how to).
- Security: ID token verified with `node:crypto` against Google's keys (issuer, audience, expiry, nonce); `__Host-`
  cookies, Origin allowlist (docs/ACCOUNTS.md 3.4), HSTS and security headers (11.5).

## Backups and copies
- Fly volume snapshots: daily, kept 5 days (`--snapshot-retention 5`). Deleted data leaves them within 5 days.
- `node server/admin.js backup` writes to `/tmp` outside the volume; `sweep` deletes it after a day; any downloaded
  copy is deleted within 5 days of creation. No other copies.

## Data-subject requests
- Self-serve in the game: Your stats > Download my data (JSON, `poddle-export-1`; includes friends, friend requests and
  removals by username, except the rows kept only to keep another player's decline or removal silent) and Delete my data (live database at once; cascades friends and friend requests). By email to hello@danielrltan.com: answered within 30 days (GDPR 1 month, PIPEDA 30 days, CCPA 45 days),
  after checking the requester controls the profile (signed in, or the browser holding the device id).
