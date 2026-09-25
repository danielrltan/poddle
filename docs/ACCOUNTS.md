# Player stats, anti-abuse and optional Google sign-in (implementation spec)

Status: spec, nothing built yet. Written 2026-09-24 against `server/game.js` at 1452 lines (commit 6eef0d4), revised
the same day after a security and privacy critique (every issue is resolved in place; the choices and the few issues
declined are listed in section 15, "Decisions"). Every `file:line` below refers to that revision; implementers
re-find the line by the quoted code if it has moved.

Binding rules that this spec obeys and that every implementer must also obey:
- CLAUDE.md "Legal pages" and "Current data flows". Every change that stores data, sets a cookie or storage key,
  adds a third party or adds accounts updates web/privacy.html and web/terms.html IN THE SAME COMMIT (section 10).
- Sign-in NEVER gates play. With the database missing, broken or full, the game plays exactly as it does today.
- No new npm dependency on the server. `ws` stays the only one. SQLite comes from `node:sqlite` (built into Node 24).
- No log line carries a name, IP, cid, device id, account id, Google sub or token.

Words used in this document (chosen so they do not clash with the existing "stats" dev panel, `poddle.settings.stats`,
`#dev`, `window.__stats`):
- **profile**: a player's saved record (the new feature). Code: `profile*`, DOM: `#lobby-profile`, `#profile-*`.
- **owner**: the database row a profile hangs off: either a guest **device** or a signed-in **account**.
- **device id**: a random id kept in `localStorage['poddle.device']` in one browser profile. Not the tab's `cid`.
- **computer key**: what the server treats as "the same computer": the client IP (IPv4 whole, IPv6 first 64 bits),
  widened by the in-memory **link map** (section 5.4): two keys seen with one device id, cid or account in the last
  24 h are the same computer.
- **frozen identity**: the identity a seat had at its first non-anonymous identify in a match (section 3.2). It is
  what the match is recorded against; later reconnects only compare with it.
- **ranked**: a result the anti-abuse rules accept, so it moves W/L, streaks and firsts. **unranked**: played, logged
  with its reason, moves nothing except the "matches played" count.

---

> **OPERATOR CORRECTION (2026-09-24, overrides every other mention of Tour in this spec):** Tour is a real,
> selectable Matt difficulty between Club and Pro (Play a bot shows Rookie, Club, Tour, Pro; wire levels 0, 1, 3, 2).
> The Matt ladder therefore has FOUR rungs in difficulty order: Rookie (0), Club (1), Tour (3), Pro (2). Every
> Tour-level result (Play a bot at Tour, tournament matches and warm-ups against Matt) lands on the Tour rung, with
> its own W/L, first win, current streak and best streak like the other rungs. There is no separate "Tournament Matt"
> line and no `tourMatt` field: `matt` is a four-entry array in difficulty order. Where this spec says "three rungs"
> or "not a rung", read "four rungs" / "the Tour rung". Q2 is resolved this way.

## 1. Goals and non-goals

### Goals
1. Retention. Give players a reason to come back:
   - beat Matt at each level of the ladder (Rookie, Club, Tour, Pro) for the first time, then build a streak at that level
     (Tour Matt is the tournaments' Matt: its results are kept and shown on their own line, not as a rung; Q2);
   - personal bests: hardest hit, fastest swing, longest rally, longest winning streak;
   - a running W/L record against people.
2. Stats work with no account (a guest profile on the device) and survive a server restart (SQLite on a Fly volume).
3. Optional Google sign-in (step B) gives a registered unique username, keeps the profile across devices, and is
   offered after a match ("Sign in to keep this win"). Never required.
4. Stats cannot be farmed by playing yourself: two tabs, two browsers or two devices behind one address (IPv4 or
   IPv6, or a device that hops networks mid-match), one account in both seats, a mid-match identity swap, forfeit
   farming, win trading, throwaway feeder profiles, forged revive scores, teleporting paddles and mid-match Matt level
   switching are all caught by pure, unit-tested rules (section 5).
5. Privacy by design: the database stores no IP address, no e-mail, no Google profile data, no name history. Guest
   profiles expire after 90 days untouched (7 days when only one match was ever recorded). Deletion reaches the live
   database at once and every backup within 5 days. Self-serve export and deletion ship on day one (step A).
6. Abuse cannot take the service down: the database has a hard size cap, owners are created only for completed
   matches, and new guest profiles are capped per computer and per hour (section 5.5).

### Non-goals (not in this project)
- Public leaderboards, public profiles, friend lists, chat. Profiles are shown only to their owner. (A registered
  username is shown to opponents and spectators exactly where a guest name is shown today.)
- Ratings (Elo etc.). The data model leaves room for one later, but nothing is computed now.
- Proving that a swing was real. Swing values are client-reported and forgeable by design (section 4.5); they stay
  personal-only and plausibility-capped.
- Stopping a determined cheater with two computers on two networks and two identities that never touch the same
  computer key. The rules make farming slow and visible (per-pair caps on owners AND computers, feeder and one-way
  transfer detection, established-opponent rule), not impossible. Nothing public depends on it. One computer with a
  free VPN is NOT this case: the link map (5.4) joins the VPN key to the home key through the device id or cid.
- Other sign-in providers, e-mail/password, account recovery flows. Google is the only identity provider.
- Changing the legacy `LOCAL` room (tests, `?skiptitle=1`). It never records anything.

---

## 2. Data model (server/db.js)

### 2.1 Engine and file
- `const { DatabaseSync } = require('node:sqlite')`, required lazily INSIDE `open()` so that loading `server/db.js`
  (and therefore `server/game.js`) never touches SQLite when stats are off.
- Path: `process.env.PODDLE_DB`. Unset or empty means `':memory:'` (every existing test stays off disk and isolated).
  Production: `/data/poddle.db` on the Fly volume (section 11).
- Pragmas on open, in this order: `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=50`,
  `trusted_schema=OFF`, `secure_delete=ON` (deleted rows are overwritten with zeros in the file, not left in free
  pages), `max_page_count` = `DB_MAX_MB` (default 256) MB / `page_size` (so 65536 pages at 4 KB). One process, one
  connection: contention cannot happen; 50 ms is a safety net, not a wait.
- Size cap: at `max_page_count` a write fails with `SQLITE_FULL`; that path is 11.4 (the match is lost to stats, not
  to play) and the database never fills the volume. A separate `nearFull()` (true at 95% of the cap) makes
  `ownerForDevice({create})` refuse NEW guest owners (existing owners keep recording, `ok()` is unaffected, the API
  keeps working) until `sweep` frees space.
- `PRAGMA wal_checkpoint(TRUNCATE)` runs after every `deleteOwner` and at the end of every `sweep`, so deleted rows
  do not linger in the `-wal` file (with `secure_delete` they are already zeroed in the main file).
- Schema version in `PRAGMA user_version`. `open()` runs the migrations whose number is above it, each in one
  transaction. Version 1 is the schema below.
- Every statement is a prepared statement created once in `open()`. No SQL is ever built by string concatenation
  with a value in it. (All values are bound parameters; table and column names are literals.)
- All times are integer **milliseconds since the epoch, UTC** (`Date.now()`), column suffix `_at`.

### 2.2 Schema version 1 (exact DDL)

```sql
-- An owner is whatever a profile belongs to: exactly one device (guest) or exactly one account.
CREATE TABLE owners (
  id          INTEGER PRIMARY KEY,
  kind        TEXT    NOT NULL CHECK (kind IN ('device','account')),
  created_at  INTEGER NOT NULL,
  touched_at  INTEGER NOT NULL            -- last match recorded or last sign-in; drives guest retention
);
CREATE INDEX owners_kind_touched ON owners(kind, touched_at);

-- A guest browser profile. The raw device id is NEVER stored: only SHA-256(device id).
CREATE TABLE devices (
  id          INTEGER PRIMARY KEY,
  dev_hash    BLOB    NOT NULL UNIQUE CHECK (length(dev_hash) = 32),
  owner_id    INTEGER UNIQUE REFERENCES owners(id) ON DELETE CASCADE,   -- NULL once merged into an account
  account_id  INTEGER REFERENCES accounts(id) ON DELETE CASCADE,        -- set when this device merged into an account
  created_at  INTEGER NOT NULL,
  merged_at   INTEGER
);
CREATE INDEX devices_account ON devices(account_id);

-- A signed-in player. Only Google's stable subject id is kept: no e-mail, name, picture or locale.
CREATE TABLE accounts (
  id            INTEGER PRIMARY KEY,
  owner_id      INTEGER NOT NULL UNIQUE REFERENCES owners(id) ON DELETE CASCADE,
  google_sub    TEXT    NOT NULL UNIQUE CHECK (length(google_sub) BETWEEN 1 AND 255),
  username      TEXT    UNIQUE,            -- as the player typed it (case kept); NULL until claimed
  username_key  TEXT    UNIQUE,            -- skeleton (section 7.2): what uniqueness is decided on
  created_at    INTEGER NOT NULL,
  renamed_at    INTEGER,                   -- last claim or change; drives the rename cooldown
  merges        INTEGER NOT NULL DEFAULT 0 -- guest devices folded in so far (cap MERGE_MAX)
);

-- Signed-in sessions. The cookie holds 32 random bytes; only their SHA-256 is stored.
CREATE TABLE sessions (
  token_hash  BLOB    PRIMARY KEY CHECK (length(token_hash) = 32),
  account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  seen_at     INTEGER NOT NULL             -- updated at most once per hour per session
);
CREATE INDEX sessions_account ON sessions(account_id);
CREATE INDEX sessions_expires ON sessions(expires_at);

-- Usernames nobody may claim yet: an old name after a rename (30 days), a deleted account's name (90 days).
CREATE TABLE name_holds (
  username_key TEXT    PRIMARY KEY,
  until_at     INTEGER NOT NULL
);

-- One row per owner: human-match record and personal bests.
CREATE TABLE profile (
  owner_id        INTEGER PRIMARY KEY REFERENCES owners(id) ON DELETE CASCADE,
  played          INTEGER NOT NULL DEFAULT 0,   -- every finished or abandoned match with this owner in a seat, ranked or not
  h_wins          INTEGER NOT NULL DEFAULT 0,   -- ranked wins over people (includes forfeit wins that passed the rules)
  h_losses        INTEGER NOT NULL DEFAULT 0,   -- ranked losses to people (includes leaving mid-match = forfeit loss)
  h_streak        INTEGER NOT NULL DEFAULT 0,   -- current ranked winning streak against people
  h_best_streak   INTEGER NOT NULL DEFAULT 0,
  h_points_won    INTEGER NOT NULL DEFAULT 0,   -- ranked human matches only
  h_points_lost   INTEGER NOT NULL DEFAULT 0,
  tour_titles     INTEGER NOT NULL DEFAULT 0,   -- tournaments won (section 4.3 rule)
  best_rally      INTEGER NOT NULL DEFAULT 0,   -- most struck balls in one point (section 4.4)
  best_rally_at   INTEGER,
  best_hit        INTEGER NOT NULL DEFAULT 0,   -- hardest settled hit that met the ball, 0..100 (section 4.5)
  best_hit_at     INTEGER,
  best_speed      REAL    NOT NULL DEFAULT 0,   -- fastest settled swing that met the ball, rad/s, capped (section 4.5)
  best_speed_at   INTEGER,
  updated_at      INTEGER NOT NULL
);

-- One row per owner per Matt level. level is the wire index: 0 Rookie, 1 Club, 2 Pro (the ladder), 3 Tour (the
-- tournaments' Matt: tourbot matches, warm-ups, and Play a bot at Tour while it stays selectable; not a rung, Q2).
CREATE TABLE bot_record (
  owner_id      INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  level         INTEGER NOT NULL CHECK (level BETWEEN 0 AND 3),
  wins          INTEGER NOT NULL DEFAULT 0,
  losses        INTEGER NOT NULL DEFAULT 0,   -- includes explicit leave after the first strike (section 4.2 row G1a)
  abandons      INTEGER NOT NULL DEFAULT 0,   -- dropped connection mid-match (no W/L, streak broken)
  streak        INTEGER NOT NULL DEFAULT 0,
  best_streak   INTEGER NOT NULL DEFAULT 0,
  first_win_at  INTEGER,                      -- the "you beat Pro Matt" moment
  best_margin   INTEGER NOT NULL DEFAULT 0,   -- biggest winning margin at this level
  PRIMARY KEY (owner_id, level)
);

-- Minimal match log: only what the anti-abuse rules (R10 24 h, R11 7 days, R11b one_way 30 days) and the export
-- ("your recent matches") need. 30-day retention. No IP, no names, no cid. A row is written only when at least one
-- seat has an owner (section 4.7). flags may hold IP-derived outcomes ('same_computer'): see 10.1 #collect.
CREATE TABLE match_log (
  id          INTEGER PRIMARY KEY,
  at          INTEGER NOT NULL,              -- end time
  kind        TEXT    NOT NULL CHECK (kind IN ('bot','human','tour','tourbot')),
  bot_level   INTEGER,                        -- the level recorded (easiest used, section 4.6); NULL for human
  owner_a     INTEGER REFERENCES owners(id) ON DELETE SET NULL,   -- side 0's owner (NULL: anonymous seat or Matt)
  owner_b     INTEGER REFERENCES owners(id) ON DELETE SET NULL,   -- side 1's owner
  score_a     INTEGER NOT NULL,
  score_b     INTEGER NOT NULL,
  winner      INTEGER CHECK (winner IN (0,1)),                    -- NULL: abandoned
  ending      TEXT    NOT NULL CHECK (ending IN ('won','forfeit','left','dropped')),
  ranked      INTEGER NOT NULL CHECK (ranked IN (0,1)),
  flags       TEXT    NOT NULL DEFAULT '',   -- comma list of rule ids from section 5, e.g. 'same_computer,too_fast'
  secs        INTEGER NOT NULL               -- wall seconds from first strike to end
);
CREATE INDEX match_log_at ON match_log(at);
CREATE INDEX match_log_a  ON match_log(owner_a, at);
CREATE INDEX match_log_b  ON match_log(owner_b, at);
```

Notes on the model:
- Stats hang off `owners`, so a guest and an account are handled by the same code. Deleting an owner cascades to
  `profile`, `bot_record` and its `devices`/`accounts` row, and nulls it out of `match_log`.
- `devices.owner_id` is NULL after a merge; the device row is then kept only as "this browser was merged into account
  N" so it can never merge twice. The row is deleted with the account.
- A Matt seat is never an owner. `owner_a/owner_b` is NULL for Matt and for an anonymous human (stats switched off,
  an old client, a seat with no `hello`).
- Tour-level Matt is stored as level 3 (its wire index). Its DIFFICULTY sits between Club and Pro (`BOTS` comment at
  server/game.js:140; `BOT_ORDER = [0, 1, 3, 2]` at :142). Every "easier/harder" comparison uses
  `rank(level) = BOT_ORDER.indexOf(level)`, NEVER the index itself.

### 2.3 db.js API (pure data layer, no game knowledge)

```js
// server/db.js - CommonJS. Loading it does nothing. All functions are no-ops returning null/false when not open.
open(path)                       // -> true | false. Never throws. Logs 'stats: database unavailable (<err.code>)' once on failure.
close()                          // idempotent; called from the SIGINT/SIGTERM handler before exit
ok()                             // -> boolean: open and last write did not fail with SQLITE_FULL/IOERR/CORRUPT
ownerForDevice(devHash, now)     // -> owner id for recording: the guest owner (device + owner + profile rows created on
                                 //    first sight ONLY when the caller passes create:true, section 4.7 / 5.5) or, when the
                                 //    device merged, the merged account's owner. Signature: ownerForDevice(devHash, now, {create})
guestOwner(devHash)              // -> the UNMERGED guest owner id or null (what a device id may read/export/delete, section 8.1)
accountByDevice(devHash)         // -> account id the device merged into, or null
accountBySub(sub)                // -> {id, owner_id, username, renamed_at} | null
createAccount(sub, now)          // -> account row (new owner + profile)
mergeDevice(devHash, accountId, now)   // section 2.4; -> 'merged' | 'none' ('linked' is no longer returned)
session.create(accountId, now)   // -> raw token (base64url, 43 chars); stores the hash
session.lookup(rawToken, now)    // -> {accountId, ownerId, username} | null (expired rows are ignored)
session.revoke(rawToken)
session.revokeAll(accountId)
recordMatch(m)                   // section 4.7 shape; ONE transaction; -> per-seat result summary for the client
profileOf(ownerId)               // -> the section 8 profile shape
exportOf(ownerId)                // -> the section 10.6 export shape
deleteOwner(ownerId, now)        // cascades; adds name_holds for an account's username (90 days)
claimUsername(accountId, name, key, now)   // -> 'ok' | 'taken' | 'held' | 'cooldown'
recentPairs(ownerA, ownerB, sinceAt)       // -> ranked human results between the two owners since sinceAt (R10)
recentLosses(ownerId, sinceAt)             // -> {losses, wins, topTwoShare} over ALL human results, ranked or not (R11)
recentWins(ownerId, sinceAt)               // -> ranked human wins since sinceAt (R12)
oneWay(winnerOwner, loserOwner, sinceAt)   // -> {aOverB, bOverA} ranked human wins each way (R11b one_way, 30 days)
established(ownerId, now)                  // -> true when created >= 24 h ago or >= 3 recorded matches (R11c)
ownerExists(ownerId)                       // -> boolean; checked per seat INSIDE recordMatch (section 4.7)
deviceCount(accountId)                     // -> device rows linked to the account (cap DEVICES_MAX 50, section 2.4)
sweep(now)                       // section 10.5; returns counts; runs at boot and every 24 h (setInterval(...).unref())
```

### 2.4 Guest profile merge on sign-in
Sign-in (`POST /api/signin`, section 8) carries the browser's device id in the JSON body when stats are on.
`mergeDevice(devHash, accountId, now)` runs in one transaction:

| Device state | Result |
| --- | --- |
| Unknown device (never played) | Nothing to merge and NOTHING inserted (a row per random `dev` would let `/api/signin` grow the database without limit). Return `'none'`. While signed in the session owns every match; after sign-out the client rotates the id (3.1), so no second profile can start on it. |
| Device has its own owner (guest profile, never merged) and `accounts.merges < MERGE_MAX` (10) | Fold the guest profile into the account (rules below), delete the guest owner (cascade), set `owner_id NULL, account_id = acct, merged_at = now`, `merges + 1`. Return `'merged'`. |
| Same, but `merges >= MERGE_MAX` | (Changed 2026-09-25: the sign-in card says "Your stats from this browser come with you" and never mentions a cap, so no guest stats are dropped.) Do nothing, like the `DEVICES_MAX` row: the guest profile stays a guest and expires on its own. Return `'none'`. |
| Any row that would link a device while `deviceCount(acct) >= DEVICES_MAX` (50) | Nothing changes; the guest profile stays a guest profile (it expires on its own). Return `'none'`. |
| Device already merged into THIS account | Nothing. Return `'none'`. |
| Device already merged into a DIFFERENT account (a shared family computer) | Nothing moves in either direction. `account_id` is left pointing at the first account (it only records history). Return `'none'`. The new account simply starts receiving that browser's matches while signed in. |

Fold rules (guest G into account A): `played, h_wins, h_losses, h_points_*, tour_titles` add. `h_best_streak,
best_rally, best_hit, best_speed` take the max (and its `_at`). `h_streak` keeps A's value (a streak is not summed
across devices). Per level: `wins, losses, abandons` add, `best_streak, best_margin` max, `streak` keeps A's,
`first_win_at` takes the earlier non-null. `match_log` rows naming G are rewritten to A (so pair caps keep working).

After sign-OUT the client rotates the device id (section 3.1), so the next guest session on that browser is a fresh
guest profile and never writes into the account.

---

## 3. Identity

### 3.1 Device id
- Created lazily on the client, NEVER on page load: the first time this browser takes a SEAT to play (the `welcome`
  message with `side` 0 or 1 in a lobby court, not as a spectator, not on the title screen, not in the LOCAL room)
  while stats are on (Settings "Save my stats on this device", default ON, section 9.6). It is created at seat time,
  not at match end, because the server must know the seat before the match is judged (a seat with no identity is
  anonymous, R3); the `hello` is sent at once on the open socket and `helloMsg` identifies the already-seated player.
  Just-in-time notice: the result card of the match that first STORES data for this id shows, once, "Your stats are
  saved on this device. You can turn this off in Settings. Privacy Policy": the server sets `created: true` in the
  `profile` message when `ownerForDevice` created the owner in that call (8.3, 9.3). No storage key is needed, and
  the notice appears exactly when data is first stored, whichever page load that is. Q5 asks whether EU/UK/Quebec traffic needs a
  one-tap "Save my stats" opt-in instead (then the id is created on that tap and match one is not saved).
- Value: `crypto.randomUUID()` (fallback: 16 bytes from `crypto.getRandomValues`, hex). Never `Math.random`.
- Stored in `localStorage['poddle.device']` through the existing safe `ls` wrapper (web/main.js:50). Its own key:
  `savePrefs()` (web/main.js:171) rebuilds `poddle.settings` from a fixed list and would drop it.
- Format check on the server: `/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$|^[0-9a-f]{32}$/`.
  Anything else is treated as no device id.
- It is a **bearer secret for the guest profile** (it authorises export and deletion of that guest profile), so:
  - it NEVER goes in a URL (the WS URL at web/main.js:383 and `backTo()` :377-378 are logged by Fly);
  - the server stores only `SHA-256(device id)` (32 bytes) and keeps the raw value only on the socket object in memory;
  - it is not a cookie (no cookie is needed for guests; this keeps step A cookie-free).
- Rotated (a fresh one generated and the old key removed) on: sign-out, "Delete my data", turning stats off then on.
- Turning "Save my stats" off removes `poddle.device` and stops sending `hello.dev` (and offers to delete what was
  saved first, section 9.6).
- Its uses are closed: saving the player's own statistics and the fair-play checks inside Poddle. Never advertising,
  analytics, profiling or sharing (the privacy page says so, and COPPA's internal-operations exception depends on it).

### 3.2 How identity reaches the server
- **WebSocket, device id**: a new first message `{"type":"hello","dev":"<device id>","v":1}` sent in the socket's
  `open` handler before anything else (web/main.js reconnect loop :379-400). Server (message loop, server/game.js
  :1390-1411, before the `ws.pad` line): `if (m.type === 'hello') return helloMsg(ws, m)`. `helloMsg`:
  1. ignores a second hello on the same socket (`ws.helloSeen`);
  2. ignores it on a pad socket (`ws.pad`) and when `ws.originBad` (section 3.4);
  3. validates the format; sets `ws.devHash = sha256(dev)` (Buffer);
  4. if `ws.acct` (signed-in session) is set, the account wins: device id is kept only for the merge path;
  5. if `ws.pl` already exists (the socket was seated inside the connection handler by `back=1`/`room=` BEFORE the
     hello arrived: revive() :1094, joinCode :1425, or the lazily created id of 3.1 arriving just after `welcome`),
     calls `ws.room.identify(ws.pl, ws)`, which follows the freeze-or-compare rule below (it never overwrites a
     frozen identity).
  Owner lookup (`db.ownerForDevice`) is NOT done here; it is done once, at match end (section 4.7), so a socket that
  never finishes a match never creates a database row.
- **WebSocket, account**: the session cookie rides the upgrade request automatically (same-origin `wss://`). Read in
  the connection handler (server/game.js:1383-1387) from `req.headers.cookie`, ONLY when the Origin passes
  (section 3.4). `ws.acct = db.session.lookup(token)` → `{accountId, ownerId, username}` or null. A lookup error is
  caught: the socket is a guest.
- **Pad sockets** (`?padfor=`, server/game.js:1414-1415) never read the cookie, never accept `hello`, never own a seat.
  The tab that owns the seat owns the profile.
- **Seat identity is sticky (freeze, then compare).** A reconnect through `backTo()` (web/main.js:377-383) is seated
  inside the connection handler (joinCode :1424 → `seat()` :1047 → `retake()` :696) BEFORE any message is read, so
  at that moment the new socket is always anonymous. Identity must therefore never be REPLACED by a later socket.
  `identify(pl, ws)` (new room method, next to `retake`) computes `id = identOf(ws)` = `{ devHash, accountId,
  ownerId (account's, if signed in), tokenHash (session, if any), computer: computerKey(ws.addr), cid: ws.cid,
  anon: !devHash && !accountId }` and then, on the seat's match accumulator `acc` (4.1; when no match exists yet the
  same fields live on `pl` and are copied into `acc` by `seatAcc`):
  1. ALWAYS: `acc.computers.add(id.computer)` and `acc.cids.add(id.cid)` (every socket that ever held the seat, even
     an anonymous one), and the link map records the pair (5.4).
  2. If `acc.ident` is not yet frozen and `!id.anon`: freeze it, `acc.ident = id`. This can happen at `join`, at a
     late `hello`, or at a `retake`, before or after the first strike (t0).
  3. If `acc.ident` is frozen: compare only, never touching `acc.ident`. An anonymous `id` (a reconnect before its
     hello arrives, or a reload with stats switched off) sets `acc.pendingAnon = true`; a later hello on that socket
     with the frozen device or account clears it (a plain reconnect therefore leaves no trace). A DIFFERENT
     `devHash` / `accountId` sets `acc.identChanged = true`, which is never cleared. At record time R6b fires when
     `identChanged || pendingAnon`.
  Called from:
  - `join()` server/game.js:686 (right after `me.cid = ws.cid`);
  - `retake()` :696 (the same cid on a new socket);
  - `helloMsg` when the socket is already seated (above);
  - `answer()` :750 goes through `join()`, nothing extra.
  Rematch: `seatAcc(pl)` for a new match starts with `acc.ident` = the identity of the socket that holds the seat
  NOW (`pl.sockIdent`, kept by `identify`, frozen at once if not anonymous) and `acc.computers = {its computer}`.
  The effect (R6b, 5.2): an identity change withholds only that seat's WIN credit and bests; a loss is still recorded
  against the frozen owner, and the opponent is judged on the frozen identities, so a loser cannot erase a loss (or
  turn the honest winner's result into `anon_opponent`) by reloading with stats off or with another device id.

### 3.3 Session cookie
- Name: `__Host-poddle_s` when `SECURE_COOKIES` (true when `FLY_APP_NAME` is set, or env `COOKIE_SECURE=1`);
  otherwise `poddle_s` (local development over http). The `__Host-` prefix forces Secure, Path=/ and no Domain, so
  the cookie is bound to poddleball.com exactly (not www, not poddle.fly.dev).
- Value: 32 bytes from `crypto.randomBytes`, base64url (43 chars). Stored as `SHA-256(raw)`.
- Attributes: `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=15552000` (180 days). Absolute expiry: `expires_at =
  created_at + 180 d`. No sliding renewal (keeps it simple; a returning player re-clicks Sign in once every 6 months).
- At most 10 live sessions per account: creating the 11th deletes the oldest.
- Session fixation: every successful sign-in issues a NEW token, and if the request carried a session cookie, the
  session it names is deleted first (whatever account it belonged to).
- Live sockets follow revocation. The socket keeps `ws.tokenHash` (never the raw token). `stats.forget({ tokenHash,
  accountId, devHash })` is called by sign-out (that token), by `DELETE /api/account` (the account and/or the device)
  and by session eviction (the evicted token). It walks the open sockets and live match accumulators in this process:
  - sign-out and eviction: clear `ws.acct` / `ws.tokenHash` on matching sockets, so matches that START after that
    point are guest matches. A match already in progress stays on its frozen account, which still exists: signing
    out (or evicting the session by signing in 10 more times) mid-match must not erase a loss;
  - deletion only (`DELETE /api/account`, `admin.js delete-account`): additionally mark every seat accumulator whose
    frozen identity matches as `gone` (recorded as no owner for that seat only, 4.7; the opponent is still judged on
    the frozen identities, so R4 does not fire). The data is gone, so there is nothing to erase.
  This is synchronous and in the same process as the API, so there is no window in which a deleted account or device
  can be re-created by a match that ends afterwards.
- Sign-out: `POST /api/signout` deletes the row and answers `Set-Cookie: <name>=; Max-Age=0; ...same attributes`.
  Deleting the account deletes every session (cascade).
- The token never appears in a URL, a WS message, a log line or a response body. The client JS cannot read it.
- Cookie parsing: `auth.parseCookie(header)` - splits on `;`, trims, first `=` separates, ignores names seen twice
  after the first, caps the header at 4 KB, never throws.
- Login nonce cookie: `__Host-poddle_n` (or `poddle_n`), 16 random bytes base64url, `HttpOnly; Secure; SameSite=Strict;
  Path=/; Max-Age=600`, set by `GET /api/signin/nonce`, cleared by `/api/signin` (section 6).

### 3.4 Origin checks
`auth.originAllowed(origin, host, { hosted, scheme })`, where `hosted = !!process.env.FLY_APP_NAME` and `scheme` is
the scheme this server is serving the request on (`'https'` behind Fly's TLS, `'http'` for a plain local server):
- hosted (production): allowed EXACTLY `https://poddleball.com`, `https://www.poddleball.com`, `https://poddle.fly.dev`
  and nothing else (no localhost, no loopback, no Host-equal rule: a hostile page on the player's own machine, such as
  any local dev server, must not pass);
- not hosted (local development, tests, LAN play), additionally:
  - `http://localhost`, `http://127.0.0.1`, `http://[::1]`, any port (tests use ports 8140-9430);
  - an Origin whose scheme equals `scheme` AND whose host:port equals the request's `Host` header (LAN play,
    README:95-96: a page served from `http://192.168.x.y:8080` opens its socket to the same host). The rule is not
    scheme-blind: `http://poddleball.com` against a server serving https is refused;
- everything else, including `null`, is NOT allowed.

**WebSocket upgrade** (connection handler, server/game.js:1380): never reject a socket (tests and LAN play send no
Origin; the `ws` library sends none).
- Origin header present and not allowed → `ws.originBad = true`: the cookie is ignored and `hello` is ignored. The
  socket plays as an anonymous guest (can play, records nothing). This stops cross-site WebSocket hijacking: a
  hostile page cannot ride the victim's session cookie or write into the victim's profile.
- Origin header absent → a non-browser client (a browser ALWAYS sends Origin on a WS upgrade). The cookie is ignored
  (a script has no victim's cookie to ride); `hello` is accepted (test clients use it; a script could send any device
  id anyway).
- Origin allowed → cookie read, hello accepted.

**HTTP API** (section 8): every `POST` and `DELETE` requires BOTH an allowed `Origin` header (missing → 403) AND
`Content-Type: application/json` (else 415). The JSON content type forces a CORS preflight for any cross-site
fetch, and the server never answers preflights (no `Access-Control-*` headers anywhere), so a cross-site form or
fetch cannot reach a state-changing route (login CSRF and delete CSRF). `GET` routes return only the caller's own data
and set `Cache-Control: no-store`, `X-Robots-Tag: noindex`, `Cross-Origin-Resource-Policy: same-origin`.

### 3.5 Client IP (computer key)
R5 (the user's main requirement), the link map, the computer-keyed caps, R16 and every existing per-address limit
rest on this address, so it is specified defensively and its production behaviour is MEASURED before step A (Q1 is a
hard gate, 14.1).
- Today: `ws.addr = hdr['fly-client-ip'] || remoteAddress` (server/game.js:1384), trusted from anyone. And
  `loopback()` (:1062) is `a => !a || a === '::1' || a.endsWith('127.0.0.1')`, applied to that value, so a forged
  `Fly-Client-IP: 127.0.0.1` (or `x127.0.0.1`) skips every per-address limit: `create()` :1063-1064 (ADDR_ROOMS),
  the tournament limit :1179 and `askKeys` :173.
- New `auth.clientAddr(req)` → `{ addr, fromPeer }`:
  - `peer` = `req.socket.remoteAddress`.
  - Hosted (`FLY_APP_NAME` set): take the header chosen by Q1 (`fly-client-ip` if Fly overwrites it, else the LAST
    entry of `x-forwarded-for`, which the proxy appends). Trim it; it must pass `net.isIP()`; after stripping
    `::ffff:` it must NOT be loopback (127.0.0.0/8, ::1), private (10/8, 172.16/12, 192.168/16, fc00::/7), link-local
    (169.254/16, fe80::/10), unspecified (0.0.0.0, ::) or CGNAT (100.64/10). A value that fails (or a missing header): `addr = 'bad'`, ONE shared key for every such socket. It gets NO loopback
    exemption, so all of them together share the per-address limits (4 courts, 1 tournament, the ask cooldown) and
    the new-guest cap; for R5 two `bad` seats are the same computer (unranked, the conservative answer). A per-socket
    random key was rejected: forging an invalid header would then buy unlimited courts. It never falls back to the
    peer either (on Fly that is the proxy's internal address). Honest traffic never lands here once Q1 has chosen the
    right header. `fromPeer = false`. One log line
    per hour at most: `net: client address header rejected` (no value).
  - Not hosted: if the peer is exactly loopback, the header is used when present (tests forge it on purpose:
    test/rooms.test.mjs:19-20, joinreq :201, tourney :254) with `fromPeer = false`, else `addr = peer, fromPeer =
    true`. If the peer is not loopback, the header is ignored: `addr = peer, fromPeer = true`.
- New `loopback(ws)`: `ws.addrFromPeer && (a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1')`: an
  EXACT match, and only on the TCP peer, never on a header value. It replaces the old helper in all three callers
  (:173, :1064, :1179). The existing tests keep their meaning: a test client with no header is this machine (exempt),
  a test client with a forged header is that address (limited: rooms.test.mjs:353 still sees `busy`).
- `abuse.computerKey(addr)`: strip `::ffff:` from IPv4-mapped addresses; IPv4 → the address; IPv6 → the first four
  hextets after expanding `::` (the /64); `'bad'` → itself; empty → `'local'`. Never stored, never logged;
  lives on the socket and, for up to 24 h, only as a keyed hash in the memory maps of 5.4.
- Q1 (hard gate, 14.3): whether Fly's proxy overwrites a client-supplied `Fly-Client-IP` has NOT been measured. Until
  it is, this spec claims nothing about it; the probe and its result go into NOTES before step A ships.

---

## 4. Stats recording (server/stats.js + hooks in server/game.js)

### 4.1 Per-match accumulator (in memory, one per room)
`createRoom` gets `let match = null`. `startMatch()` (server/game.js:454) builds it AFTER the score reset:

```js
match = {
  id: ++matchSeq,            // process-local, for the once-only guard
  done: false,               // set by the first record/abandon; every later path is a no-op
  t0: 0,                     // wall ms of the first strike (set in launch() when !started); 0 = no ball struck yet
  revived: !!room.reviveTaint,          // section 5 rule R2
  rank: theBot() ? rank(botLevel) : null,   // easiest Matt level used (BOT_ORDER position), section 4.6
  levelChanged: false,
  rally: 0,                  // struck balls in the current point
  seats: [0, 1].map(sd => seatAcc(bySide(sd))),   // see below; a seat that fills later is added in join()
};
// seatAcc(pl) -> pl ? { pl, bot: !!pl.bot, contacts: 0, held: 0, rallyReal: 0, rallyHeld: 0,
//                       bestRally: 0, bestHit: 0, bestSpeed: 0, swingBad: false,
//                       ident: <frozen identity or null>, computers: Set, cids: Set,   // section 3.2
//                       identChanged: false, pendingAnon: false, gone: false,          // 3.2, 3.3 forget()
//                       mv: { x, y, at, fast: 0 }, teleport: false } : null             // 4.8
```
- The accumulator holds the player object (`pl`) AND the seat's frozen identity (`acc.ident`, section 3.2), plus the
  SET of computer keys and cids seen on that seat during the match. The frozen identity is what is recorded; an
  identity that arrives late (a `hello` after a revive, a reconnect or the lazy device id seated the socket) freezes
  it if nothing was frozen yet, and a later different or missing identity only sets `identChanged` (or
  `pendingAnon`). Forfeit paths splice the loser out of `players[]` BEFORE `endMatch` (:515, :546, :774, :785); the
  accumulator still has them.
- `room.reviveTaint` is set to `true` where `revive()` creates the room (server/game.js:1087, right after
  `createRoom`), whatever the URL carried (score, pub, side and bot are all client-asserted). The first `startMatch`
  copies it into `match.revived` and then clears `room.reviveTaint = false`, so a rematch in the same court is a
  clean match. (`revived` itself is nulled at :455 and cannot be used as the marker.)
- `join()` (:686) when `match` exists and the joining seat's slot is null: `match.seats[side] = seatAcc(me)`.
- Nothing is written anywhere during the match. The accumulator is dropped with the room.

### 4.2 Every way a match ends, and what is recorded
The hook is `recordEnd(winner, ending)` / `recordAbandon(pl, ending)` inside `createRoom`. Both start with
`if (LEGACY || !match || match.done) return; match.done = true;` and wrap everything in `try { ... } catch (e) {
console.error('stats: ' + e.code) }`. **A stats or database error must never throw out**: `endMatch` runs inside
`point()` inside `sim()` on the 60 Hz interval, and a throw there ends the process and every room in it.

| # | Path (file:line) | Hook call | What is recorded |
| --- | --- | --- | --- |
| A | Normal win: `point()` :568 → `endMatch(winner,false)` | top of `endMatch` :464, before the `MATCH` branch: `recordEnd(winner, forfeit ? 'forfeit' : 'won')` | Human: W/L if ranked. Bot: level W/L. Rally/swing bests. |
| B | Two humans, explicit `leave` after first strike :783-786 | same (`endMatch(...,true,nm)`) | Forfeit: leaver L, stayer W, if ranked (rule R7 minimum points). |
| C | Held seat not back in HOLD_S, two humans: `forfeitHeld()` :516 | same | As B. |
| C' | Held seat, ONE human (bot court held for its spectators): `forfeitHeld()` :513 calls `leave(me)` | add `recordAbandon(me, 'dropped')` immediately before that `leave(me)` | Bot: `abandons+1`, level streak reset to 0. No W/L. |
| D | Calibration stall: `slowSeat()` :548 | top of `endMatch` | As B (staller loses). |
| E | Tournament match, leave or drop: `leave()` MATCH branch :775 | top of `endMatch` | kind `tour`/`tourbot`, as A/B. |
| F | Tournament `room.force(sd)` :1010-1011 (tourLeave :1282, no-show :1337-1340, never-ready :1341-1342) | top of `endMatch` | Forfeit. Almost always unranked by R7 (0 points played). |
| F' | Tournament result with no `endMatch`: `onClose` without result :1236, Matt v Matt :1231, member left before the match :1232 | none | Nothing (no match was played). |
| G1a | Bot match, explicit `leave` after the first strike: `leave()` fall-through :789, when `theBot() && match.t0 && !over && !dropped` | `recordAbandon(me, 'left')` at the top of the fall-through, BEFORE the score wipe at :795 | Bot: `losses+1` at the recorded level, streak reset. Quitting while losing to Matt is a loss. |
| G1b | Same, but the socket dropped (closing the tab, wifi) and nobody watches (no hold, :782 does not apply) | `recordAbandon(me, 'dropped')` at the same place | Bot: `abandons+1`, streak reset. No loss (the server cannot tell a closed tab from bad wifi). |
| G1c | Leaving before the first strike (any room), or the second human leaving before `started`; against Matt also any forfeit before it (a tournament's never-ready or dropped seat at 0-0) | none (`match.t0 === 0`) | Nothing. |
| G2 | A second human replaces Matt: `join()` :683 | none | Only reachable before the first strike or during `over` (`seat()` refuses when `underway()`), so there is nothing to record. |
| G3 | A spectator takes Matt's seat with the player's OK: `answer()` | `record(null, 'dropped')` before `join(w)` when `match.t0` (changed 2026-09-25) | An abandon (no W/L, the streak ends), as G1b: otherwise a second tab of one's own could ask and be let in to erase a match being lost. |
| G4 | `close(reason)` mid-match (ROOM_TTL sweep, tourEnd, tourStart closing warm-ups) | none | Nothing. |
| G5 | Process restart (SIGINT/SIGTERM) | none | Nothing. The court's next match is revived → unranked (R2). |
| G6 | Legacy `LOCAL` room (all of it, including `again` takeover :768) | none | Nothing, ever. |
| H | Rematch: `vote()` :485 → `startMatch` | new `match` | A fresh match. |

The per-seat outcome codes written to `match_log.ending`: `won` (A), `forfeit` (B-F), `left` (G1a), `dropped` (C',
G1b). For G1a/G1b/C' the `winner` column is NULL and the score is the score at the moment of leaving.

Owner creation (anti-DoS, 5.5): a device that has no owner yet gets one ONLY from a COMPLETED match: ending `won`, or
`forfeit` with at least `FORFEIT_MIN` points played. A `left`/`dropped` ending, or an early forfeit, on a device never
seen before records nothing for that seat (its existing owner, if it has one, is recorded as the table says).

Streak effects: a ranked human win `h_streak+1`; a ranked human loss (incl. forfeit loss) `h_streak=0`. Unranked
results do not touch streaks. Bot: win at level L → that level's `streak+1`; loss, `left` or `dropped` at L → 0.

### 4.3 Tournaments
- Tournament matches pass through `endMatch` (rows A-F) with `kind = 'tour'` (two humans) or `'tourbot'` (vs Matt,
  level 3). They follow the same rules as other matches (section 5). Warm-up rooms (`kind 'warm'`) are ordinary bot
  matches at Tour (level 3).
- Member identity: `tourAdd` (:1162) and `tourBind` (:1164) set `m.ident = identOf(ws)` ONLY when that identity is
  not anonymous (a reconnect through `tourRebind` :1298 runs inside the connection handler before `hello` arrives
  and would otherwise overwrite a good identity with an empty one). `helloMsg` also refreshes the member when
  `ws.tour && ws.tm` are set: `m.ident = identOf(ws)`.
- Title: in `tourChamp()` (:1258), when the champion is a human member, `stats.title(t, m)` credits `tour_titles+1`
  ONLY if, over the whole tournament, at least 3 human members had distinct computer GROUPS AND distinct
  device/account identities, and the champion won at least one ranked human match in it (the stats hook sets
  `m.rankedWins++`). A member's computers are the SET of keys seen on any of its sockets (`m.computers`, added to on
  `tourAdd`, `tourBind`, `tourRebind` and hello); two members are the same computer when their sets, canonicalised
  through the link map (5.4), intersect. A member identity is frozen like a seat's (3.2): set on the first
  non-anonymous identify, never overwritten, a different later identity marks the member `identChanged` and makes it
  ineligible for the title.
  Otherwise nothing (one person with four tabs cannot farm titles). Wrapped in the same try/catch.

### 4.4 Rallies (server-decided: trustworthy)
- `reset(by)` (:386): `if (match) { match.rally = 0; for (const s of match.seats) if (s) s.rallyReal = s.rallyHeld = 0; }`.
- `launch()` (:301-305), the one chokepoint for every struck ball: `if (match) { if (!match.t0) match.t0 = Date.now(); match.rally++; }`.
- `strike(pl, sw)` (:430), human contacts only (`!pl.bot`): `sw.held ? s.held++ & s.rallyHeld++ : s.contacts++ & s.rallyReal++`.
  The auto-serve (:951) and the non-swing serve (:398) go through `launch()` but not `strike()`: they count toward the
  rally length but are not a contact.
- `point()` (:560), before `score[winner]++`: for each human seat `s`, if `match.rally >= 3 && s.rallyReal >= 1 &&
  s.rallyReal >= s.rallyHeld` then `s.bestRally = max(s.bestRally, match.rally)`. (A rally won by parking the
  paddle does not count.)
- Saved to `profile.best_rally` only when `judge()` returns `seats[i].bests === true` for that seat. That is the ONLY
  source: a revived (R2), too-fast (R8), idle (R9), teleporting (R18) or identity-changed (R6b) match saves no rally
  best, bot or human.

### 4.5 Swings (client-reported: personal-only and capped)
Client change (web/main.js:493 and :498, web/motion.js swing events): add two fields to every `swing` message:
`pk` = the UNGAINED peak rate in rad/s (motion.js `sw.peak` before `PHONE_GAIN`, web/main.js:405 multiplies `raw` by
0.5-3 and must not reach stats), and `src` = `'airpod' | 'phone'`. `raw` keeps its current gained meaning for serves.

Server (`onMessage` swing branch :841-853):
- `const sure = m.final === true;` A missing `final` counts as settled for play (:847, legacy clients) but NEVER for
  stats. Stored as `sure` on `me.swing` (the object built at :877) and passed to the fix paths.
- `const pk = Number.isFinite(m.pk) ? m.pk : null`, `src` must be one of the two strings else null. Stored on `me.swing`.
- `me.swPow` stays as it is for play; stats never read `swPow` (it is unclamped, :850).

Carrying `sure`, `pk`, `src` to every place a swing can become a contact (all three are required, or most bests never record):
- The rally swing object built at :877 (`me.swing = { until, from, n, dir, lob, slice, final, ... }`): add `sure, pk, src`.
- The serve path returns early with its own literal: `serveSwing(me, !!m.fix, clamp(sp, 0, 60), { n: Math.max(pw,
  SERVE_FLOOR), dir, lob, slice, floor: SERVE_FLOOR }, final, through)` (:853). Add `sure, pk, src` to that literal,
  so a serve struck through `serveStrike` :807 → `strike()` carries them.
- The fix path's first branch, a bet that SETTLES BEFORE CONTACT (the common case): `if (me.swing)
  Object.assign(me.swing, { n: pw, dir, lob, slice, final })` must also assign `sure: m.final === true, pk, src`.

Recording (only at contact, only settled, only a real swing):
- `strike(pl, sw)` :430 when `!pl.bot && !sw.held && sw.sure` → `swingBest(s, sw.n, sw.pk, sw.src)`.
- The settled correction sites that change a hit already struck: `fixBlock()` :445 (called at :861 and :874) and the
  re-aim at :862-865; both are reached only with `final` true; call `swingBest(s, pw, m.pk, m.src)` there when
  `m.final === true`.
- A hit struck on a BET whose settled report lands close to it: the re-aim branch's difference test fails and nothing
  runs, so neither site above fires. Therefore, in the fix path, when `m.final === true && !me.swing && me.hit &&
  !me.hit.statted && now - me.hit.at < Math.max(FIX_WINDOW, PUSH.fix)` AND the settled report agrees with the bet
  that struck the ball (`Math.abs(pw - me.hit.n) <= 0.15`, recorded before any re-aim assigns `me.hit.n`), call
  `swingBest(s, pw, pk, src)` and set `me.hit.statted = true`. A settled report that DISAGREES by more than 0.15
  records only if `fixBlock` or the re-aim actually ran for it (the struck ball really changed to that power); a
  settled report after contact that changes nothing records nothing. This stops "strike on a soft bet, then send a
  settled fix at 34 within FIX_WINDOW". `statted` stops a second settled report counting twice. `strike()` sets
  `pl.hit.statted = true` when it recorded a sure swing itself.
- A bet (`final === false`) never records: its power is capped at SMASH for play (:847) and would read too low or high.

`swingBest(s, n, pk, src)` (in server/stats.js, pure):
| Value | Rule | Justification |
| --- | --- | --- |
| hit | `round(clamp(n, 0, 1) * 100)`; best of the match | `n` is already the server-clamped `(power-6)/28` (:842). power 6..34 is the whole range motion.js can produce (`TAP=6`, `POWER_MAX=34`, web/motion.js:23,31). |
| speed | `pk` required finite and `src` set, else no speed for this swing. `pk > 40` → `s.swingBad = true` (flag `swing_implausible`). `35 < pk <= 40` → clamp to 35. | Consumer gyros commonly saturate near ±2000 deg/s = 34.9 rad/s (general knowledge, UNVERIFIED for AirPods and phones: section 14 Q3). Real strokes in the repo's recordings: about 8-32 rad/s (motion.js comments). |
| consistency | `n >= SMASH (0.76)` with `pk != null && pk < 12` → `swingBad` | A settled smash needs about 19 rad/s on a phone and 23.4 on an AirPod (NOTES 82, SMASH comment at server/game.js:157). 12 leaves wide margin. This compares two client-chosen numbers, so it only catches careless forgeries; a forged client that sends power 34 and pk 34.9 passes it. Accepted: swing bests are personal-only for good (Q14). |
| serves | included only when struck by a real swing through `serveStrike` :807 → `strike`; the auto-serve is not a contact | |

`swingBad` on a seat: that seat's hit/speed bests from this match are discarded (the result itself is unaffected;
points are server-decided). Display units: hit as 0-100 ("Hardest hit 92"), speed as rad/s converted in the UI to
"km/h at the paddle" ONLY if the operator approves a conversion (section 14 Q7); default display is "°/s" = rad/s ×
57.3, rounded to 10.

### 4.6 Matt level during a match
- `botRequest()` (:628-634), after `botLevel` is set and when `theBot()` was already seated:
  `if (match) { if (match.t0) { match.levelChanged = true; match.rank = Math.min(match.rank, rank(botLevel)); } else match.rank = rank(botLevel); }`
  Changing level before the first strike is free; after it, the match is recorded at the EASIEST level used.
  `rank(l) = BOT_ORDER.indexOf(l)`: Rookie 0 < Club 1 < Tour 2 < Pro 3. Never compare wire indexes (Tour = 3 is easier
  than Pro = 2).
- `addBot()` (:616) calls `startMatch`, which builds a fresh `match` with `rank(botLevel)`.
- `mattBack()` (:1015) after a revive: the match is revived anyway (unranked).
- Recorded level: `BOT_ORDER[match.rank]`, flag `level_changed` when it moved.

### 4.7 Recording flow at match end (`stats.onEnd`, synchronous, one transaction)
```js
// server/stats.js
onEnd({ now, kind /* 'bot'|'human'|'tour'|'tourbot' */, winner /* 0|1|null */, ending, score: [a, b],
        secs /* t0 -> now, wall */, revived, levelRank, levelChanged, seats /* [acc|null, acc|null] */ }, db, cfg)
```
1. For each human seat, `ident = acc.ident` (the FROZEN identity, 3.2; null = anonymous). A seat marked `gone` by
   `stats.forget` (3.3, deletion only) is recorded with no owner, for that seat only; its frozen identity is still
   used to judge the OPPONENT (so a mid-match deletion never turns the honest opponent's result into
   `anon_opponent`). Sign-out or session eviction mid-match changes nothing for the match in progress.
   Owner: `ident.accountId ? the account's owner : ident.devHash ? db.ownerForDevice(devHash, now, { create }) : null`
   with `create` true only when the seat's ending is a completed one (4.2 "Owner creation") AND the new-guest caps
   of 5.5 allow it (a refused creation → that seat `saved:false`, no owner). `ownerForDevice` returns the device's
   own guest owner, or, if the device has merged, the owner of the account it merged into (so a player who signs in
   mid-match still gets that match). After sign-out the client rotates its id, so a merged id is never used again
   for guest play.
2. History (human kinds only):
   - owner-keyed, from the database (both owners known): `db.recentPairs(ownerA, ownerB, now-24h)` (R10),
     `db.recentLosses(loserOwner, now-7d)` (R11), `db.oneWay(winnerOwner, loserOwner, now-30d)` (R11b),
     `db.established(loserOwner, now)` (R11c), `db.recentWins(winnerOwner, now-24h)` (R12);
   - computer-keyed, from memory (5.4, even when an owner is missing or freshly minted): the pair count between the
     two seats' computer groups and the loser group's losses and distinct winner groups over the last 24 h.
3. `abuse.judge(facts, history, cfg)` (pure, section 5) → `{ ranked, flags, seats: [{ record, bests }] }`. `facts`
   carries, per seat, the frozen identity, the canonical computer groups of `acc.computers` (5.4) and `acc.cids`.
4. `db.recordMatch(...)`: one `BEGIN IMMEDIATE ... COMMIT`. First, per seat, `ownerExists(owner)`; a missing owner
   (deleted in a race that `forget` did not see) is treated as no owner FOR THAT SEAT ONLY and never fails the
   transaction, so the other seat's result is kept. If no seat has an owner, nothing is written at all (no
   `match_log` row). Otherwise insert `match_log`; for each seat with an owner: `played+1`, W/L and streaks if its
   `record`, bot record, bests if `seats[i].bests`, `owners.touched_at = now`.
5. The in-memory computer-keyed history (5.4) records the result (ranked or not) after the transaction.
6. Returns per-seat summaries; `game.js` sends each human seat that still has an open socket the `profile` message
   (section 8.3). A seat whose socket is gone gets nothing (their profile panel will show it next time).
7. Log line (no identities, no reasons): `[CODE] match recorded: bot Pro ranked` / `[CODE] match recorded: human
   unranked`. The rule ids stay in `match_log.flags` (30 days) and the player's own export; they are not logged,
   because the privacy page says log entries record only the court code and whether the match counted.

Cost: at most ~12 statements, WAL, `synchronous=NORMAL`: well under 2 ms on the Fly volume. It runs once per match,
never per tick. If the DB is not open, step 4 is skipped and the client gets `{ saved: false }`.

### 4.8 Paddle plausibility (server-decided, cheap)
The paddle position has no speed limit (`me.x = clamp(num(m.x, me.x), ...)` at server/game.js:838-839), so a script
can teleport to every ball and beat Pro Matt without effort. In the `paddle` branch, for a human seat with an
accumulator, while `ball.live` and `!me.auto`: `dt = max(0.05, (now - acc.mv.at) / 1000)` (the floor stops bunched TCP
packets reading as huge speeds), `v = max(|x - acc.mv.x|, |y - acc.mv.y|) / dt`; `v > TELEPORT_MS` (default 12 m/s)
increments `acc.mv.fast`, anything slower resets it to 0; `acc.mv.fast >= 2` sets `acc.teleport = true` (R18). No
positions or speeds are kept beyond the last sample and the flag; nothing is logged or stored except the flag id in
`match_log.flags`. The 12 m/s threshold is a guess to be checked against recorded play before step A (Q16).

---

## 5. Anti-abuse rules (server/abuse.js, pure functions)

### 5.1 API
```js
computerKey(addr)          // section 3.5
rank(level)                // BOT_ORDER.indexOf(level)
config(env)                // reads the knobs in 5.3 once; NODE_ENV=production forces the safe values
judge(facts, history, cfg) // -> { ranked: boolean, flags: string[], seats: [{ record: boolean, bests: boolean }, ...] }
titleCounts(members, champ, links, cfg)   // section 4.3
createLinks({ now, ttlMs, maxEntries })   // section 5.4: the in-memory link map and computer-keyed history (the
                                          // only stateful export; its clock is injected, so it is unit-testable)
```
`facts` = the `onEnd` argument with, per human seat, `{ owner, ident /* frozen, 3.2 */, groups /* canonical
computer groups of acc.computers, 5.4 */, cids, anon, gone, contacts, held, swingBad, identChanged, teleport, left,
established }`. `history` = `{ pairRanked24h, winnerWins24h, loserHuman7d: { losses, wins, topTwoShare },
oneWay30d: { aOverB, bOverA }, cpuPair24h, cpuLoser24h: { losses, distinctWinnerGroups } }`. No I/O, no clock (the
caller passes `now`), so every rule is unit-testable.

### 5.2 Rules
Outcomes: **counted** (ranked: W/L, streaks, firsts, bests), **unranked** (logged with the flag, `played+1`, no W/L,
no streak change, no firsts, no bests), **ignored** (nothing recorded at all). Some rules act on ONE seat only
("seat" in the Applies column).

| id | Rule | Signal | Applies to | Outcome |
| --- | --- | --- | --- | --- |
| R0 `legacy` | The legacy LOCAL room | `LEGACY` | all | ignored |
| R1 `pad` | Phone pad sockets never own a seat or a profile | `ws.pad` / `?padfor=` | all | ignored for that socket |
| R2 `revived` | First match of a court rebuilt by `revive()` (client-asserted score, side, bot level, pub; the 120 s window reopens after every deploy AND every autostop wake). Includes a revived human court that falls back to Matt (`addBot` → first `startMatch` still carries the taint) | `match.revived` | bot, human | unranked, no bests |
| R3 `anon` | A seat that never had a non-anonymous identity during the match (stats off, old client, bad Origin) | `acc.ident === null` | seat | ignored for that seat |
| R4 `anon_opponent` | Human match against a seat that was anonymous for the WHOLE match (no frozen identity). Never triggered by a mid-match downgrade (that is R6b) or by `gone` (3.3) | other seat `ident === null` | human, tour | unranked |
| R5 `same_computer` | The two seats' computer SETS intersect after link-map canonicalisation (5.4): multi-tab, multi-browser, two devices on one home IP, one seat hopping to a VPN or hotspot mid-match, a browser seen on both its IPv4 and IPv6 key | `groups(A) ∩ groups(B) ≠ ∅` | human, tour | unranked |
| R6 `same_device` / `same_account` / `same_cid` | Both seats share a device id hash, an account, or a cid (frozen identities, and every cid seen on either seat) | equality | human, tour | unranked |
| R6b `ident_changed` | The seat's identity changed after it was frozen: a different device or account, or a reconnect that stayed anonymous (stats switched off, no hello) until the end (3.2) | `acc.identChanged` (or `pendingAnon` still set) | seat | THAT seat's win credit and bests are withheld; its LOSS is still recorded against the frozen owner; the opponent is judged normally on the frozen identities |
| R7 `early_forfeit` | A forfeit (B-F) before `FORFEIT_MIN` total points were played. Default `ceil(WIN_AT / 2)` (6 at WIN_AT 11); `STATS_FORFEIT_MIN` overrides in tests only | `ending==='forfeit' && a+b < FORFEIT_MIN` | human, tour | unranked (no win for the stayer, no loss for the leaver) |
| R7b `leaver_ahead` | A forfeit where the LEAVER was ahead by more than 2 points (a colluding leader handing over a win) | score | human, tour | unranked |
| R8 `too_fast` | Match shorter than `MIN_POINT_S` (default 2.5 s) wall time per point played | `secs < 2.5 * (a+b)` | all | the WIN is unranked (no W, no first, no win streak, no bests); a LOSS still counts |
| R9 `afk` | A human seat made fewer real contacts than `max(2, ceil((a+b)/4))` (never swung; won by auto-serve and parked-paddle blocks) | `contacts` | all | a win BY the idle seat and a win OVER the idle seat are unranked (no bests); the idle seat's own LOSS still counts (going idle while losing to Matt must not dodge the loss) |
| R10 `pair_cap` | The pair already has `PAIR_DAY` (default 3) ranked results in the last 24 h, in either direction, counted BOTH by owners (database) AND by computer groups (memory, 5.4). A feeder that mints a new device id every match still repeats its computer | `history.pairRanked24h`, `history.cpuPair24h` | human, tour | unranked |
| R11 `feeder` | The loser has at least 6 human results lost in the last 7 days, counting ALL results, ranked or unranked; at least 80% of those losses went to at most 2 distinct winners; and the loser won fewer than 20% of their human matches in those 7 days. Also, from memory: the loser's computer group lost at least 6 matches in 24 h to at most 2 distinct winner groups. Counting unranked results is what lets R11 fire alongside R10 (R10 alone caps a pair at 3 RANKED results a day, so a ranked-only count could never reach the threshold) | `history.loserHuman7d`, `history.cpuLoser24h` | human, tour | unranked |
| R11b `one_way` | Over the last 30 days (the match log), the winner has at least 5 ranked wins over this loser and the loser none over the winner: further wins one way are a transfer, not a rivalry | `history.oneWay30d` | human, tour | unranked |
| R11c `new_opponent` | The LOSER's owner is not established: created less than 24 h ago AND fewer than 3 recorded matches (bot matches count). Throwaway guests cannot feed wins | `facts.seats[loser].established` | human, tour | the winner's credit is withheld; the loser's loss is recorded |
| R12 `daily_cap` | The winner already has 30 ranked human wins in the last 24 h (rapid-fire farming) | `history.winnerWins24h` | human, tour | unranked |
| R13 `level_changed` | Matt's level changed after the first strike | `match.levelChanged` | bot | counted at the easiest level used (section 4.6) |
| R14 `bot` | Bot matches: only bot-level progress, uncapped (no pair/daily caps). Never touch human W/L or `h_streak` | kind `bot`/`tourbot` | bot | counted if R2, R6b, R8, R9, R18 pass |
| R15 `swing_implausible` | Swing values outside the caps (section 4.5) | `s.swingBad` | seat | result unchanged; that seat's hit/speed bests from this match discarded |
| R16 `title` | Tournament title needs 3 distinct human computer GROUPS (5.4) AND identities, and one ranked human win by the champion | `titleCounts` | tour | counted / ignored |
| R17 `origin_bad` | Socket opened from a page not on the allowlist | `ws.originBad` | that socket | treated as R3 (anonymous) |
| R18 `paddle_teleport` | The seat's paddle moved faster than `TELEPORT_MS` on 2+ consecutive samples while the ball was live (4.8) | `acc.teleport` | seat | a WIN by that seat (bot or human) is unranked with no bests; its LOSS still counts |

Evaluation order: R0, R1, R3 first (decide which seats exist); then R2, R6b, R8, R9, R18 (match-wide or per seat);
then for human kinds R4, R5, R6, R7, R7b, R10, R11, R11b, R11c, R12. `judge` returns `seats[i].record` per seat:
- the winner's credit is withheld (no W, first, streak or bests) when R8, R11c, or R6b/R18 on the WINNER fires, or
  when R9 fires for EITHER seat;
- the loser's loss is still recorded when the loser is the idle seat (R9), when the loser's identity changed (R6b)
  or the loser teleported (R18), or when only R8 or R11c fires;
- the loser's loss is withheld when the WINNER was the idle seat (a loss to someone who never swung is not a real
  result, and withholding it keeps a pair from farming losses onto an alt), and for every match-wide unranked rule
  (R2, R4, R5, R6, R7, R7b, R10, R11, R11b, R12).
- `seats[i].bests` is true only when that seat's `record` is true AND no rule withheld its bests (R2, R6b, R8, R9,
  R18 for its own seat; R15 withholds only hit/speed). This is the ONLY switch for rally, hit and speed bests (4.4).
All failing ids are collected into `flags` (not just the first) so the log shows every reason. `ranked` (the
`match_log` column and the `profile` message) = no unranked flag present and every seat's `record` true; R13 and R15
are informational.

Known false positives, accepted:
- Two people in one household or on one school/office network (one public IP) never get ranked human results
  against each other (R5). Bot progress is unaffected. Q4 asks whether to relax R5 for two established accounts.
- A school lab with more than `NEW_GUEST_DAY` (30) first-time players on one public IP in 24 h: the extra players'
  first matches get `saved:false` until the next day (5.5). Play is unaffected.
- Friends with a large skill gap: after 5 one-way ranked wins in 30 days, the stronger player's further wins over
  that friend stop counting (R11b), and a player who keeps losing mostly to the same one or two people for a week is
  treated as a feeder (R11). Both only unrank; neither is shown to the other player (8.3).
- A brand-new player's losses count but beating one gives the winner no ranked win until the new player has 3
  matches (any kind) or is a day old (R11c).
- During a flood, `NEW_GUEST_HOUR` refuses first profiles for every new player until the hour rolls over (their
  matches play normally with `saved:false`).
- A very fast but real paddle move could trip R18 if the 12 m/s guess is too low (Q16 measures it first).

Known gaps (documented, not solved):
- IPv4/IPv6 split. poddleball.com has both A and AAAA records. Two DIFFERENT browsers on one computer, one reaching the
  server over IPv4 and the other over IPv6 (for example with IPv6 disabled in one), present two unrelated computer
  keys and share no device id or cid, so R5 misses them. What covers it: R6 if they share an account; the link map
  as soon as either browser is ever seen on both families (happy-eyeballs fallbacks do this naturally); R10 by
  computer group and owner; R11/R11b/R11c; R12. The residual is a slow, capped, private-only gain. A wall-clock skew
  signal was considered and declined (section 15).
- Two devices on two networks with two identities that never share a computer key (a phone on mobile data vs a
  laptop on wifi, each with its own device id): R10-R12 limit it to 3 ranked results per pair per day, R11b stops a
  one-way transfer after 5 wins, and R11c makes throwaway feeders cost a day or 3 matches each.
- One computer switching to a VPN BEFORE the match with a fresh device id and cid (a fresh incognito window on the
  VPN): unlinked, it is the previous case.
- Staying anonymous for the whole match denies the opponent a ranked win (R4). It gives the anonymous player nothing.
- Wins against Matt are scriptable by a forged client (swing timing and power are client-asserted); R18 stops the
  cheapest version (teleporting), not a careful bot. Bot progress is therefore personal-only and never shown to
  anyone else (Q14).

### 5.3 Knobs (env, read once by `abuse.config`)
| Env | Default | Tests | Production |
| --- | --- | --- | --- |
| `STATS_SAME_IP` | `1` (rule R5 on) | `0` disables R5 ONLY when both addresses are loopback (browser e2e tests that cannot set `fly-client-ip`) | ignored: `NODE_ENV=production` always applies R5 |
| `STATS_MIN_POINT_S` | `2.5` | `0` with `TIMESCALE` | honoured |
| `STATS_FORFEIT_MIN` | `ceil(WIN_AT / 2)` | small numbers | ignored: production always uses `ceil(WIN_AT / 2)` |
| `STATS_PAIR_DAY` | `3` | honoured | honoured |
| `STATS_AFK_MIN` | `2` (the floor in R9) | `0` DISABLES R9 (scripted clients that never swing) | honoured (production ignores `0` and uses 2) |
| `STATS_TELEPORT_MS` | `12` | `0` disables R18 (scripted clients that jump to the ball) | production ignores `0` |
| `STATS_ESTABLISHED` | `1` (R11c on) | `0` disables R11c | production ignores `0` |
| `NEW_GUEST_DAY` / `NEW_GUEST_HOUR` | `30` / `600` | honoured | honoured |

Server integration tests that need RANKED human matches do not use `STATS_SAME_IP=0`: they send distinct
`fly-client-ip` headers per simulated computer (test/rooms.test.mjs:19-20 pattern); the loopback peer makes the header
trusted off Fly (section 3.5), and those addresses are then subject to the per-address limits like any other.

### 5.4 Link map and computer-keyed history (memory only, 24 h, never persisted)
- Keys: `node(computerKey) = HMAC-SHA256(salt, computerKey)`, first 16 bytes. `salt` is 32 random bytes generated at
  boot and replaced every 24 h; the previous salt is kept for the next 24 h so lookups compute both nodes. The salt
  is never written anywhere, so no stored or logged value can be turned back into an IP. Identity keys are the
  device hash, the account id and `SHA-256(cid)`.
- Link map: whenever `identify`, `tourAdd`/`tourBind`/`tourRebind`, `helloMsg` or an `/api/*` call with a `dev` sees
  one identity key on a computer node, it records `(identity, node, at)`. Two nodes that share an identity within
  24 h are joined (union-find, rebuilt lazily from the live entries). `groups(set of keys)` = the set of canonical
  roots. An honest dual-stack browser links its own IPv4 and IPv6 keys; a player who moves one seat to a VPN or a
  hotspot while keeping the device id or the tab's cid links the VPN key to the home key.
- Computer-keyed history: after every human result, `(winnerNode, loserNode, ranked, at)`. R10 counts ranked entries
  between the two groups; R11 counts the loser group's losses and distinct winner groups.
- New-guest counter (5.5): `(node, at)` per guest owner created.
- Hygiene: entries older than 24 h are dropped on the once-a-minute prune; each map is capped at 50 000 entries
  (oldest evicted first). Everything resets on restart, which is acceptable: the owner-keyed rules persist, and the
  first match after a restart is usually revived and unranked anyway (R2).
- Privacy: this is IP-derived data held for up to 24 h in memory. It is disclosed in the privacy page's IP row and
  retention section (10.1) and in the CLAUDE.md inventory (10.3). The 10.5 promise holds: no IP is ever written to
  disk.

### 5.5 Abuse of the database itself (growth and denial of service)
A script could loop "fresh device id → create a court → play Matt → one swing → leave" to mint rows. Limits:
1. Owners are created only by COMPLETED matches (4.2 "Owner creation"); `left`, `dropped` and early forfeits never
   create one.
2. At most `NEW_GUEST_DAY` (30) new guest owners per computer group per 24 h, and `NEW_GUEST_HOUR` (600) in total per
   hour. Beyond that, the seat is `saved:false` (play unaffected); one log line per hour, no identities.
3. No `match_log` row when neither seat has an owner (4.7 step 4).
4. Guest owners with `played <= 1` are deleted 7 days after `touched_at` (`GUEST_ONE_DAYS`), not 90.
5. Device rows linked to one account are capped at `DEVICES_MAX` (50); sign-in with an unknown `dev` inserts nothing
   (2.4).
6. The database has a hard cap (`max_page_count`, 256 MB, 2.1) far below the 1 GB volume, so a flood can at worst
   stop NEW stats, never fill the volume or stop play.
7. The existing per-address limits (ADDR_ROOMS 4, ROOM_CAP 40, message rate) still bound the rate, now with the exact
   loopback rule of 3.5.

---

## 6. Google sign-in (step B; code built in step A, hidden)

### 6.1 Gating
- `GOOGLE_CLIENT_ID` env unset or empty → sign-in is OFF: `/api/signin/nonce`, `/api/signin`, `/api/signout`,
  `/api/username` answer `404 {"error":"signin_off"}`; `/api/me` says `signin.enabled: false`; the client shows no
  sign-in button, no nudge, no account row, and never loads anything from Google. Guest profiles, export and delete
  still work.
- The client ID is public (it appears in the page's requests to Google). Set it in fly.toml `[env]` or as a Fly
  secret; either is fine.
- Google Cloud console (operator): OAuth client type "Web application", Authorized JavaScript origins
  `https://poddleball.com` only (www and poddle.fly.dev redirect there). No redirect URIs (popup mode). Consent screen
  with app name Poddle, the privacy and terms URLs, scopes `openid` only (GIS always adds email/profile to the ID
  token; the server discards them, section 6.4).

### 6.2 Flow, step by step
1. Page load: no request to Google. `web/main.js` calls `GET /api/me` once after boot (hosted only, `HOSTED` at
   web/main.js:10-13) to learn `signin.enabled`, `clientId` and the current account.
2. The player presses our own "Sign in with Google" button (nudge, Profile view or Settings; section 9). The client
   opens `#signin-card` (text: what Google sends and what is kept, links to Privacy and Terms) with an UNTICKED age
   checkbox (6.5). Nothing is requested from Google yet. Only when the box is ticked does the client, in parallel:
   - `GET /api/signin/nonce` → `{ "nonce": "<22 chars>" }` and the `__Host-poddle_n` cookie (section 3.3);
   - injects `<script src="https://accounts.google.com/gsi/client" async>` once (never before this click; a second
     click reuses it). Load failure (blocked, offline, 8 s timeout) → the card says "Google sign-in could not load.
     You can keep playing as a guest."
3. (Box ticked.) `google.accounts.id.initialize({ client_id, nonce, callback, ux_mode: 'popup', auto_select: false,
   cancel_on_tap_outside: true, context: 'signin', itp_support: true, use_fedcm_for_button: true })`, then
   `google.accounts.id.renderButton(#signin-google, { type: 'standard', theme: 'outline', size: 'large', text:
   'signin_with', shape: 'pill', logo_alignment: 'left' })`. One Tap (`prompt()`) is NEVER called.
4. The player presses Google's button; Google's popup/FedCM returns `{ credential }` (an ID token JWT) to `callback`.
5. `fetch('/api/signin', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type':
   'application/json' }, body: JSON.stringify({ credential, dev: deviceIdOrUndefined }) })`.
6. Server (section 6.3) verifies, finds or creates the account, merges the device (section 2.4), creates a session,
   answers `Set-Cookie` + `{ account, merged, profile }` and clears the nonce cookie.
7. Client: no username yet → the username card (section 9.5). Then, if the game socket is NOT seated in a live match,
   it reconnects the socket so the upgrade carries the cookie (badge, account-owned recording). If it is mid-match,
   it reconnects after the match ends. Recording is correct either way: a merged device id resolves to its account's
   owner at record time (`db.ownerForDevice`, section 4.7 step 1).
8. Sign-out: `POST /api/signout`, `google.accounts.id.disableAutoSelect()` if the script is loaded, rotate the device
   id (section 3.1), reconnect the socket after the current match.

### 6.3 Server verification (`server/auth.js`, `node:crypto`, no dependency)
`createGoogleVerifier({ clientId, jwksFile, fetchImpl = fetch, now = Date.now })` → `async verify(token)` returning
`{ sub, nonce }` or throwing `AuthError(code)`:
1. `typeof token === 'string'`, length 20..4096, exactly three base64url segments.
2. Header JSON: `alg === 'RS256'` exactly (rejects `none`, `HS256`, `RS512`, `ES256`), `kid` a string of 1..128
   chars, `typ` absent or `'JWT'`. No `jku`, `x5u`, `jwk` header is ever followed.
3. Key: from the JWKS cache by `kid`. Unknown kid → refetch the JWKS at most once per 60 s → still unknown:
   `unknown_kid`. Keys accepted only with `kty: 'RSA'` and `alg` absent or `'RS256'`; imported with
   `crypto.createPublicKey({ key: jwk, format: 'jwk' })`.
4. Signature: `crypto.verify('RSA-SHA256', Buffer.from(h + '.' + p), key, sig)` BEFORE any claim is trusted.
5. Claims: `iss` ∈ {`accounts.google.com`, `https://accounts.google.com`}; `aud` is a string equal to `clientId`
   (an array is rejected); `azp`, if present, equals `clientId`; `exp` (s) > now − 30 s; `iat` ≤ now + 60 s; `nbf`,
   if present, ≤ now + 60 s; `sub` matches `/^[0-9A-Za-z_-]{1,255}$/`; `nonce` is a string.
6. Everything else in the payload (email, name, picture, locale, hd) is ignored and never stored or logged.
- JWKS source: `https://www.googleapis.com/oauth2/v3/certs`, `AbortSignal.timeout(3000)`, cached for the
  `Cache-Control: max-age` it returns, clamped to 5 min..24 h. Fetch failure with a cached set → keep using it;
  with none → `503 google_unavailable`.
- Test injection: `GOOGLE_JWKS_FILE` (a JSON JWKS file) replaces the fetch, ONLY when `NODE_ENV !== 'production'`.
  Under production it is ignored and the boot log says `auth: GOOGLE_JWKS_FILE ignored in production`. Unit tests
  pass `fetchImpl`/`jwksFile` directly.
- Route checks in `/api/signin` after `verify`: `payload.nonce === cookie nonce` (constant-time compare) else
  `403 {"error":"nonce"}`; the nonce cookie is single-use (cleared on every `/api/signin` answer).
- Replay: the nonce binds a token to the browser that asked for it; a token lifted from another browser fails. The
  server keeps SHA-256 of every nonce it issues (memory, 10 minutes, capped) and a sign-in must name one of them, once
  (added 2026-09-25): the cookie alone could be forged from the token's own `nonce` claim.

### 6.4 What is kept from Google
Only `sub` is kept; email, name and picture arrive in the token and are discarded unread. Google Identity Services
ALWAYS puts `email`, `email_verified`, `name`, `picture`, `given_name`, `family_name` and `locale` into the ID token,
and Google's consent screen tells the player that Poddle receives their name, email address and profile picture, so
the privacy page says exactly that (10.1 #sharing) rather than "only an identifier". The server parses the payload
once to read the claims it checks (6.3 step 5) and `sub`, never copies any other field into a variable, a row, a log
line or a response, and drops the token. Google also learns that this Google account signed in to Poddle, sets or
reads its own cookies and may use FedCM in its sign-in window, and keeps Poddle in the user's Google "connections"
after a Poddle account is deleted (the user removes it there; the privacy page says so).

### 6.5 Age
Google's own minimum age does NOT protect Poddle: Google accounts supervised with Family Link can belong to children
under 13 and can use Sign in with Google. An account creates a persistent username other players see, so sign-in
requires an affirmative act:
- `#signin-card` holds an unticked checkbox, placed BEFORE Google's button area: "I am 13 or older. If I am under 18,
  my parent or guardian has agreed to the Terms of Use and the Privacy Policy." Google's script is loaded and its
  button rendered only after it is ticked (6.2). Unticking hides the button again.
- Nothing about the answer is sent or stored; no birth date is asked for or stored.
- Reports of an under-13 account: the operator deletes it with `node server/admin.js delete-account <username>`
  (11.7), which is operator-initiated only (a report of an under-13 user or a Terms breach), never a self-service
  path by email. The privacy and terms text is in 10.1 and 10.2 (step B).

---

## 7. Usernames (server/usernames.js, pure)

### 7.1 Rules for a registered username
- Input is NFKC-normalised first (`s.normalize('NFKC')`), then must match `/^[A-Za-z0-9_]{3,12}$/`
  (ASCII only after NFKC: fullwidth `ＡＢＣ` becomes `ABC` and passes; `Мatt` with a Cyrillic М fails `chars`).
- Must contain at least one letter; may not start or end with `_`; no `__`.
- Stored as typed after NFKC (case kept) in `accounts.username`; displayed that way.
- Reasons returned (`validate(name)` → `{ ok, name, key }` or `{ ok: false, reason }`):
  `length | chars | letter | underscore | reserved | profanity`.

### 7.2 Uniqueness key (confusables without a dependency)
Because usernames are ASCII-only, the confusable problem shrinks to look-alike ASCII. `skeleton(name)`:
1. lowercase; 2. remove `_`; 3. map `0→o`, `1→l`, `i→l`, `|→l`, `5→s`, `$→s`, `3→e`, `4→a`, `@→a`, `7→t`, `8→b`,
   `9→g`, `2→z`, `6→g`; 4. replace `rn→m`, `vv→w`, `cl→d` (applied left to right, repeatedly until stable);
5. collapse runs of the same character to one (`Matt`, `Mattt` and `Maatt` all become `mat`).
`username_key = skeleton(name)`. Uniqueness is decided on the key (UNIQUE index), so `Matt`, `M4tt`, `rnatt`,
`MAT_T` and `Maatt` all collide. The key is also what the reserved and profanity checks run on.

### 7.3 Reserved and profanity lists (`server/words.js`, ships in the image, never under web/)
- Reserved: `words.js` stores plain words; `usernames.js` runs `skeleton()` on each ONCE at load and compares keys.
  - prefix (the key STARTS with it): `poddle`, `admin`, `moderator`, `staff`, `official`, `support`, `system`, `google`;
  - exact (the key EQUALS it): `matt`, `mattbot`, `botmatt`, `realmatt`, `thematt`, `mattpro`, `mod`, `rookie`,
    `club`, `pro`, `tour`, `bot`, `player`, `player1`, `player2`, `guest`, `anonymous`, `null`, `undefined`, `you`,
    `me`, `host`, `champion`, `referee`, `root`, `help`, `privacy`, `terms`, `opponent`.
  - `matt` is exact, not a prefix, so `Matthew` and `Mateo` stay available. The operator can add the owner's own
    names (section 14 Q9).
- Profanity: a short curated list (about 150 skeleton-form stems) compared as a SUBSTRING of the key for severe slurs
  and as an exact match for mild words (to avoid the "Scunthorpe" problem). The file holds the words base64-encoded
  so the source stays readable in reviews; the list is maintained by the operator. The same check is exported for a
  possible later guest-name filter (not in scope).
- Guest names: `cleanName` (server/game.js:164-169) keeps its rules, plus two additions.
  1. Badge look-alikes are removed from every guest name (added to `NAME_OUT`): U+221A √, U+2122 ™, U+2610-2612
     ☐☑☒, U+2705 ✅, U+2713 ✓, U+2714 ✔, U+1F5F8 🗸, U+1F5F9 🗹, U+1F197 🆗. (The badge itself is not text anyway,
     7.5; this removes the cheap imitation.)
  2. The impersonation check, on a COMPARISON form only (the displayed name is unchanged): `imp(name)` = NFKC → NFKD →
     strip `\p{M}` (so `Mat̲t` loses its mark) → map a built-in look-alike table to Latin (Cyrillic а е о р с у х і ј ѕ
     һ ԁ М Т Н В К А Е О Р С Х, Greek Α Β Ε Η Ι Κ Μ Ν Ο Ρ Τ Χ Υ Ζ ο ν; about 40 entries in `server/words.js`) → drop
     every character that is not a letter or digit (`Matt.`, `Matt!`, `M a t t`, `Matt™` all become `Matt`) →
     `skeleton()`. It is compared with `skeleton()` of each listed word, computed once at load (as for the reserved
     list): a guest name whose `imp()` EQUALS the key of `matt`, `mattbot`, `botmatt`, `realmatt`, `thematt`, or of
     `matt` joined before or after a level word (`mattpro`, `promatt`, `mattclub`, `clubmatt`, `mattrookie`,
     `rookiematt`, `matttour`, `tourmatt`), or STARTS with the key of `poddle`, `admin`, `moderator`, `staff`,
     `official`, shows as `Player 1`/`Player 2`. `Matthew` and `Mateo` stay allowed (their keys differ from `matt`'s). Ordinary words from the username list (Me, You, Host, Guest, Player, Pro,
     Club...) stay allowed as guest names. (The existing tests use no such guest names; `Matt` appears only as the
     server's bot name in fake-server fixtures.)

### 7.4 Claim and rename
- First claim: any time after sign-in, free.
- Rename: allowed when `now - renamed_at >= RENAME_DAYS` (default 30). Otherwise `423 {"error":"cooldown","until":ms}`.
- The OLD key goes into `name_holds` for 30 days (nobody else can take it at once and impersonate). A deleted
  account's key is held 90 days.
- A held or taken key → `409 {"error":"taken"}` (the response does not say which).
- `claimUsername` runs the cooldown check, the `name_holds` check, the old-key hold insert and the `UPDATE` in ONE
  `BEGIN IMMEDIATE` transaction; a concurrent claim of the same key is settled by the UNIQUE index (a constraint
  error maps to `'taken'`).
- Operator reclaim of an offensive name: `node server/admin.js rename <username> <newname>` (CLI, runs against the
  volume via `fly ssh console`), which also resets `renamed_at`. Terms section 4 says names may be changed or
  removed.
- Until a username is claimed, a signed-in player's name on court is their typed guest name (no badge).

### 7.5 Display
- Server: the `names` broadcast (tellNames, server/game.js:~298) gains `reg: [bool, bool]` (true = registered
  username); `welcome` and `matchover` carry the same. A registered seat's `name` IS its username (the typed name is
  ignored while signed in; `name` messages are ignored for that seat).
- Client: a registered name gets a badge that name text cannot reproduce: a separate `<span class="reg-badge"
  role="img" aria-label="Registered player" title="Registered player">` element OUTSIDE the name's text node, drawn
  as a filled pill (accent background colour, 1.1 em high) holding an inline SVG tick; no text glyph. It appears in
  the scoreboard (`#name-me`/`#name-them`, index.html:106-118, `ui.setNames` ui.js:50), the tally, the court list and
  the bracket. Guest names never get it, whatever they type (and badge-like symbols are stripped from guest names,
  7.3).
- Names always go through `textContent` (ui.js:6 `setText`), never markup.

---

## 8. API endpoints

### 8.1 Common rules (`server/api.js`)
- Routed at the TOP of the HTTP handler (server/game.js:22), after `nosniff` and BEFORE the 405 check at :24 and the
  OLD_HOSTS 301 at :26: `if (req.url.startsWith('/api/')) return api.handle(req, res)`. On an old host
  (`poddle.fly.dev`, `www.poddleball.com`) every `/api/*` answers `404 {"error":"wrong_host"}` (never a redirect:
  the cookie is scoped to poddleball.com).
- Response headers: `Content-Type: application/json; charset=utf-8`, `Cache-Control: no-store`, `X-Robots-Tag:
  noindex`, `Cross-Origin-Resource-Policy: same-origin`, `Content-Length`. No `Access-Control-*` header, ever.
- State-changing routes (every POST and DELETE): allowed `Origin` required (`403 {"error":"origin"}`), `Content-Type:
  application/json` required (`415 {"error":"content_type"}`), body at most 8 KB (`413 {"error":"too_large"}`),
  body read timeout 5 s (`408`), body must parse as a JSON object (`400 {"error":"bad_request"}`). Handlers read the
  fields they need one by one with type checks (`typeof b.dev === 'string'`); a parsed body is never spread,
  `Object.assign`ed or merged into any other object (`__proto__` / `constructor` keys).
- Session: from the cookie (section 3.3). Device: from the JSON body field `dev` (format-checked, hashed).
- A device id only ever authorises a GUEST (unmerged) owner. Once merged, the device id reads and deletes nothing:
  account data needs the session cookie.
- Requests by e-mail (privacy #rights): the operator acts only on proof of control, never on a username or a
  description alone: an account request must come from the person signed in (they use the in-game tools, or sign in
  so the operator can match the Google `sub` of that session); a guest request needs the browser that holds the
  device id (the in-game tools). The only operator-initiated deletions are 6.5 (under-13 report) and Terms breaches
  (11.7).
- Database not open → `503 {"error":"db_unavailable"}` (except `/api/me`, which answers with `db: false`).
- Rate limits: in-memory token buckets per computer node (the keyed hash of 5.4, never the raw address), per route;
  `429 {"error":"rate","retryAfter":s}` with a `Retry-After` header. Buckets pruned every minute; never persisted.
  The map is capped at 20 000 keys: when full, the oldest bucket is evicted, and while more than 1 000 new keys a
  minute arrive (IPv6 /64 rotation within a /48) new keys share one fallback bucket per route and per wider network
  (changed 2026-09-25: keyed by the hash of the IPv4 /24 or IPv6 /48, so one flooding network never locks everyone else
  out; a key seen in the last hour is not new, so a returning user keeps their own bucket). The hash key is replaced
  every 24 h.
- Unknown `/api/*` path → `404 {"error":"not_found"}`; known path, wrong method → `405 {"error":"method"}` + `Allow`.
- Logs: one line per failure class at most (`api: 403 origin`), no identities, no bodies.
- Crash safety (same rule as `endMatch`): `api.handle` is `async` and its whole body sits in `try/catch`, answering
  `500 {"error":"internal"}` on anything thrown, synchronous or asynchronous; the caller does
  `api.handle(req, res).catch(() => {})`. `req.on('error')` and `res.on('error')` listeners are attached first thing.
  In Node 24 an unhandled rejection ends the process, and with it every room.

### 8.2 Routes
| Method, path | Body | Success | Errors | Limit |
| --- | --- | --- | --- | --- |
| `GET /api/me` | none | `200 {"signin":{"enabled":bool,"clientId":str|null},"account":null|{"username":str|null,"renameAt":ms|null},"db":bool}` | 429 | 60/min |
| `POST /api/stats` | `{"dev"?:str}` | `200 {"profile":Profile|null}` (session → the account's; else the guest device's; else null) | 400, 403, 415, 429, 503 | 30/min |
| `GET /api/signin/nonce` | none | `200 {"nonce":str}` + nonce cookie | 404 signin_off, 429 | 20/min |
| `POST /api/signin` | `{"credential":str,"dev"?:str}` | `200 {"account":{"username":str|null,"renameAt":ms|null},"merged":"merged"|"linked"|"none","profile":Profile}` + session cookie | 400, 401 `bad_token`, 403 `origin`/`nonce`, 404 `signin_off`, 415, 429, 503 `google_unavailable`/`db_unavailable` | 10/min |
| `POST /api/signout` | `{}` | `204` + cookie cleared (also when not signed in) | 403, 404, 415 | 20/min |
| `POST /api/username` | `{"username":str}` | `200 {"username":str,"renameAt":ms}` | 401 `signin`, 409 `taken`, 422 `{"error":"invalid","reason":...}`, 423 `{"error":"cooldown","until":ms}`, 403, 404, 415, 429, 503 | 10/min |
| `DELETE /api/account` | `{"dev"?:str,"confirm":"delete"}` | `200 {"deleted":{"account":bool,"device":bool}}` + cookie cleared | 400 (no `confirm`), 403, 415, 429, 503 | 5/hour |
| `POST /api/export` | `{"dev"?:str}` | `200` JSON file (section 10.6), `Content-Disposition: attachment; filename="poddle-data-YYYY-MM-DD.json"` | 403, 404 `{"error":"nothing"}`, 415, 429, 503 | 10/hour |

`Profile` (also the body of the WS `profile` snapshot):
```json
{
  "guest": true, "since": 1790000000000, "expiresAt": 1797776000000,
  "played": 42,
  "human": { "wins": 7, "losses": 5, "streak": 2, "bestStreak": 4, "pointsWon": 120, "pointsLost": 101 },
  "titles": 0,
  "matt": [ { "level": 0, "name": "Rookie", "wins": 5, "losses": 1, "abandons": 0, "streak": 3, "bestStreak": 5, "firstWinAt": 1790000000000, "bestMargin": 9 },
            { "level": 1, "name": "Club",  "...": "..." }, { "level": 2, "name": "Pro", "...": "..." } ],
  "tourMatt": { "level": 3, "name": "Tour", "wins": 1, "losses": 2, "...": "..." },
  "bests": { "rally": { "v": 14, "at": 1790000000000 }, "hit": { "v": 92, "at": 1790000000000 }, "speed": { "v": 27.4, "at": 1790000000000 } }
}
```
`matt` is the three-rung ladder, easiest first (Rookie, Club, Pro). `tourMatt` is the level-3 row (tournament Matt,
warm-ups, and Play a bot at Tour while it stays selectable; Q2), or null. `expiresAt` only for guests (`touched_at +
GUEST_DAYS`, or `+ GUEST_ONE_DAYS` while `played <= 1`).

### 8.3 WebSocket additions
- Client → server: `{"type":"hello","dev":str,"v":1}` (section 3.2). No other new client message.
- Server → client, to each human seat after a recorded match (right after `matchover`, never broadcast):
  ```json
  { "type": "profile", "saved": true, "ranked": false, "why": ["not_counted"], "kind": "bot", "level": 2,
    "first": true, "bests": [ { "what": "rally", "v": 14, "prev": 11 } ], "streak": 3, "guest": true, "nudge": true }
  ```
  `why` maps rule ids to user-facing words, and never reveals anything about the OPPONENT's network:
  - human and tour matches: `self` ONLY when both seats are the same owner or share a device (R6 `same_device`,
    `same_account`, `same_cid`: it is one person); every other unranked reason (R4, R5, R7, R7b, R10, R11, R11b, R11c,
    R12, the opponent's R6b/R9/R18) is the single generic `not_counted`. Telling two strangers "same network" would
    reveal that the opponent shares their public IP (CWE-203). Own-seat reasons that reveal nothing about the other
    player may still be shown: `restart` (R2), `too_short` (own R8/R9);
  - bot matches: `restart` (R2), `too_short` (R8/R9), `level` (R13, informational).
  The precise rule ids stay in `match_log.flags` and in that player's own export only. `nudge` = sign-in enabled AND
  the seat is a guest AND (a bot win OR a ranked human win). `saved:false` when the DB is unavailable, the seat is
  anonymous, or the new-guest cap refused a first profile (5.5). `created: true` when this match created the seat's
  guest owner (the first data ever stored for that device id; drives the one-time notice, 9.3).
- `names` / `welcome` / `matchover`: add `reg: [bool, bool]` (section 7.5).

---

## 9. Client UI

All new markup goes between `<!-- UI:BEGIN -->` and `<!-- UI:END -->` (web/index.html:78 and :551) so
test/ui-mock.html picks it up. Every new element is optional in ui.js (the `on2` helper, ui.js:14). Copy is short,
plain and direct (typographic apostrophes in UI strings). Every button is at least 44 px (`.is-tall`). Anything
signed-in-only is `hidden` unless `/api/me` said `signin.enabled`.

### 9.1 New client module `web/profile.js` (ES module, imported by main.js)
Owns: the device id (`poddle.device` via the `ls` wrapper), `/api/*` calls (`fetch` with `credentials:
'same-origin'`, JSON), the GIS lazy loader, and the `me` state `{ enabled, clientId, account, db }`. Exposes
`deviceId()`, `hello()` (the message object for the socket's `open`), `loadMe()`, `fetchProfile()`, `signIn()`,
`signOut()`, `claimName(name)`, `exportData()`, `deleteData()`. `ui.js` stays drawing-only.

### 9.2 Sending `hello`
web/main.js reconnect loop (:379-400), in the socket's `open` handler, FIRST: `game.send(profile.hello())` when
stats are on AND a device id already exists (`{type:'hello', dev, v:1}`). When the id is created lazily (3.1: the
first `welcome` as a seated player), `profile.js` creates it and sends the `hello` at once on the open socket. The URL
builder at :383 and `backTo()` :377-378 are NOT changed.

### 9.3 After a match: result card line and nudge
- Markup: a new `<p class="result-save" id="result-save" hidden>` between `.tally` and `#rematch` (web/index.html,
  between :502 and :504), holding `<span id="result-save-text"></span>` and
  `<button class="btn btn-sm is-tall" id="btn-save-signin" hidden>Sign in to keep this win</button>`.
- main.js: the `profile` WS message (section 8.3) arriving after `matchover` (handler switch :507-612) calls
  `ui.matchSaved(p)`. Text, first match wins:
  - `first` → "First win against {Level} Matt!"; a best → "New best: longest rally 14 (was 11)" (hit: "hardest hit
    92", speed: "fastest swing 1570°/s"); `streak >= 2` → "{n} wins in a row"; `ranked:false` with `why` →
    `not_counted` "This match doesn’t count toward your record" (the one line for every human-match reason that could
    say something about the opponent), `self` "Matches against yourself don’t count", `restart` "Matches brought back
    after an update don’t count", `too_short` "Too short to count"; `saved:false` → nothing is shown.
  - One-time save notice (3.1): when the `profile` message has `created: true`, a second line: "Your stats are saved
    on this device. You can turn this off in Settings." + a "Privacy Policy" link (`/privacy.html#storage`, same
    stopPropagation guard as 9.9). The server sends `created: true` exactly once per guest owner.
  - `nudge` → `#btn-save-signin` visible (win only; never on a loss, never for a signed-in player).
- The button opens `#signin-card` (9.5), which is NOT part of the result overlay, so it survives the card closing
  (`swap()` ui.js:25-43 closes settings/tour cards; `#signin-card` is registered as exempt). It must not take focus
  from the rematch buttons (ui.js:126): no autofocus.
- Tournament result cards (`tour`): the line shows, the nudge does not.

### 9.4 Profile view (lobby)
- A 4th tile in `#lobby-home .tiles` (web/index.html:256-266): `<button class="tile" id="btn-profile" data-nav>`,
  label "Your stats", a simple chart/trophy line-art SVG in the same style. ui.css: add `nth-child(4)` to the tile
  deal-in stagger (ui.css:565) and check the 4-tile row wraps to 2×2 below 72 rem (`.tile` is 17 rem wide, ui.css:553).
- New view `<div class="panel panel-mid lobby-view" id="lobby-profile" data-view="profile" data-fit hidden>`.
  Register in ui.js :535-538: `VIEW_TITLE.profile = 'Your stats'`, `VIEW_DEPTH.profile = 1`, add to `NO_NAME`,
  and a `firstFocus`. main.js `ui.onLobby` (:658-662): `profile()` → `profile.fetchProfile()` → `ui.drawProfile(p)`.
- Contents, top to bottom:
  1. Header row: registered username with badge, or "Guest" + "Stats saved on this device until {date}" (from
     `expiresAt`). Signed-in only when enabled: "Sign in with Google" (`.btn`) or "Signed in · Change name · Sign out".
  2. Matt ladder: three rungs, Rookie, Club, Pro (Tour is the tournaments' Matt and is not a rung; Q2). Under the
     ladder, only when `tourMatt` is not null, one quiet line "Tournament Matt: W-L". Each rung: level name, W-L, current streak,
     a medal chip when `firstWinAt` is set ("Beaten on {date}") or a locked chip "Not beaten yet". The easiest level
     not yet beaten gets a "Next: beat {Level} Matt" call-to-action button that goes straight to Play a bot at that
     level (`request({type:'create',public:false})` with `botWant` set, as the bot view does).
  3. Against people: W-L, current and best streak, points won/lost, tournament titles.
  4. Personal bests: longest rally, hardest hit, fastest swing, each with its date.
  5. A one-line note: "Only you can see this page."
  6. Footer (`.set-foot` style): "Download my data" (`.btn-quiet`) and "Delete my data" (`.btn-danger`).
- Empty state (no profile yet): "Play a match to start your record" + the three rungs all locked.
- DB unavailable / request failed: "Stats aren’t available right now. The game still works."

### 9.5 Sign-in card and username claim
- `#signin-card` (`.panel.panel-sm`, role dialog, `aria-modal`, Escape closes). Text: "Sign in to keep your stats on
  any device and claim a username. Your stats from this browser come with you. Google sends us your name, e-mail and
  picture with the sign-in; we keep only an ID from Google and throw the rest away." Links to Privacy and Terms.
  Then the age checkbox (6.5, unticked, `#signin-age`): "I am 13 or older. If I am under 18, my parent or guardian
  has agreed to the Terms of Use and the Privacy Policy." Then `#signin-google`, where GIS renders its button ONLY
  after the box is ticked (before that, a short hint "Tick the box to continue"), and a "Not now" button.
- After sign-in with no username: the same card switches to `#name-claim`: a `.field` (maxlength 12,
  `autocapitalize="off"`, `pattern` hint), live client-side validation mirroring 7.1 (letters, numbers and _ only,
  3-12), "Claim" button → `POST /api/username`; errors from 409/422/423 in plain words ("That name is taken",
  "Letters, numbers and _ only", "That name isn’t allowed", "You can change your name again on {date}").
  "Skip for now" keeps playing with the typed guest name (no badge).
- The lobby name row (`#name-row`, index.html:253) and Settings > You name field (index.html:174): when signed in
  with a username, the field becomes read-only showing the username + "Change" (opens `#name-claim`). ui.js
  `keepName`/`nameGate` (:336-358) treat a username as a name.

### 9.6 Settings > You (web/index.html:173-175, `#grp-you`)
- New switch row `<button class="set-row set-switch" id="tog-save-stats" role="switch">Save my stats on this device</button>`.
  Default ON (Q5). Off, when a device id exists and the server has a guest profile for it (`POST /api/stats` said
  so, or it is unknown because the request failed): a small confirm "Also delete the stats saved so far?" with
  "Delete" (`.btn-danger`) and "Keep" (focused). Delete → `DELETE /api/account {dev, confirm:'delete'}` BEFORE the id
  is removed; Keep → the note "Saved stats are deleted automatically 90 days after your last match." Then either way:
  remove `poddle.device`, stop `hello`, show "Stats are off. Matches aren’t recorded.", and reconnect the game socket
  after the current match (as 9.7 and 6.2 step 8 do), because the server keeps the device hash of the socket's first
  hello and ignores a second one. On again → a NEW device id is created at the next seat (3.1; fresh guest profile),
  and the socket is likewise reconnected after the current match so the new hello is the socket's first. Stored in `localStorage['poddle.stats.on']` (`'0'` or `'1'`),
  its own key. (Added 2026-09-25) Off is honoured by the server too, signed in or not: while it is off every socket
  sends `{type:'nostats'}` as its first frame, and turning it off sends one on the current socket at once. The server
  (game.js `noStats`) marks the socket `statsOff`: `stats.identOf` is anonymous from then on (the account stays on the
  socket for the name and badge), the seat's match under way is recorded with no owner (`gone`, like a deletion) and
  a tournament member takes no title. The Keep note says "... 90 days after your last recorded match (7 days if only
  one match was recorded)" for a guest and "Stats already saved to your account stay there." when signed in.
- When enabled and signed in: an account row "Signed in as {username}" + "Sign out".
- "Your stats" action row (`.set-action`) that opens the lobby Profile view (reachable in a match only after leaving;
  in a match it shows a note instead).

### 9.7 Delete and export
- "Download my data" → `POST /api/export` → the response is saved with a Blob URL and an `<a download>` click
  (filename from `Content-Disposition`). Works for guests and accounts.
- "Delete my data" → a confirm card: "This deletes your stats{, your username and your sign-in} from Poddle right
  away. Our backups are deleted within 5 days. {Your old username stays reserved for 90 days so nobody can pretend to
  be you.} It can’t be undone." (the braces are account-only). Buttons "Delete" (`.btn-danger`) and "Cancel" (focused). → `DELETE /api/account {dev, confirm:'delete'}`
  → on 200: rotate the device id, clear account state, reconnect the socket after the current match, toast
  "Your data is deleted".

### 9.8 Registered-name badge
Section 7.5. ui.js `setNames({ me, meSub, them, themSub, reg })` (ui.js:50) draws the badge; also the tally, the
court list (`drawCourts`) and the bracket (`drawTour`).

### 9.9 Home-page notice (title screen)
A sibling of `#safety` (web/index.html:229-235): `<div class="panel panel-sm notice" id="news" data-fit>` with
"New: your stats are saved. Beat Matt at every level and track your best rally. Stats are saved with a random
identifier in this browser, and you can turn this off in Settings. Privacy Policy updated {Month D, YYYY}." The "Privacy Policy" link carries `onpointerdown="event.stopPropagation()"` and the `onkeydown` Enter guard
(the title screen starts the game on any pointerdown, main.js:654; test/seo.test.mjs:102-103 checks this pattern).
Removed ~60 days after launch.

---

## 10. Privacy and legal deliverables

All in the SAME commit as the code they describe (CLAUDE.md). Formal register, NO contractions, in privacy.html and
terms.html. Step A and step B each bump both pages ("Last updated", `dateModified`, sitemap `<lastmod>`). The quoted
text below is the text to use (adjust only line numbers and dates); "(step A)" text ships with step A and stays unless
step B replaces it; "(step B)" text ships only when `GOOGLE_CLIENT_ID` goes live.

### 10.1 web/privacy.html (section numbers as today)

**Head** (meta description and ld+json description, :70):
- (step A) "What Poddle collects, why, who sees it and how long it lasts. No cookies, no advertising, no analytics.
  Your webcam video stays on your computer."
- (step B) "What Poddle collects, why, who sees it and how long it lasts. Optional Google sign-in, no advertising, no
  analytics. Your webcam video stays on your computer."
- `dateModified` (:73) and "Last updated" (:90) to the ship date. Header comment (:2-11): add the sections that now
  describe statistics and accounts.

**Summary `#short`** (:95-104):
- Keep (step A) "No accounts, cookies, advertising or analytics." (still true in step A). (step B) replace it with:
  "Signing in with Google is optional and is never required to play. We use one sign-in cookie only if you sign in.
  We do not use advertising or analytics, and we never sell your information or share it for advertising purposes."
- (step A) replace the "memory only ... We maintain no database" bullet (:101) with: "<strong>Our server keeps game
  statistics in a database in Canada</strong>, linked to a random identifier in your browser (step B adds: "or, if
  you sign in, to your account"). Your IP address and display name are held in memory only, in order to operate the game, prevent
  abuse and check that matches are fair, and are never written to the database."
- (step A) add: "<strong>Statistics are optional.</strong> You may turn them off in Settings, and you may download or
  delete them at any time from Your stats."

**For teens and parents `#family`** (:107-116):
- (step A) replace "There is no chat, profile or account. The game server discards your name when the match ends or
  the server restarts." with: "There is no chat. Your statistics are private and are shown only to you. The game
  server discards the display name you type when the match ends or the server restarts."
- (step B) add: "If you sign in, your username is saved and is shown to other players whenever you play, so do not
  use your real name in it. Players under 18 may sign in only with a parent's or guardian's permission."

**2 `#collect`** (:146, table :149-159):
- (step A) after "Poddle does not require registration.", nothing else in the first paragraph changes.
- (step A) add these rows:
  - "<tr><td>A random device identifier created by your browser the first time you take a seat to play while
    statistics are switched on. Our server stores only a one-way hash of it, which remains linked to your
    statistics.</td><td>To save your statistics without an account, and to recognise when both players in a match
    are using the same browser.</td></tr>"
  - "<tr><td>Match results and statistics: the result and score, how the match ended, its length, the Matt level
    played, rally lengths, your hardest hit and fastest swing as reported by your device, winning streaks, tournament
    titles, and the time each match ended</td><td>To show you your statistics and personal bests.</td></tr>"
  - "<tr><td>A record of each match from the last 30 days: the two players' statistics records (never their names),
    the score, how the match ended, whether it counted toward statistics and, if it did not, the reason (for example,
    that both players appeared to be on the same network)</td><td>To detect results that should not count, such as
    matches played against oneself, repeated matches between the same players and arranged wins, and to show you
    your recent matches.</td></tr>"
- (step A) append to the IP address row's purpose: "To decide whether a match counts toward statistics: at the end of
  a match, the server compares the two players' IP addresses (for IPv6 addresses, the network portion only) in
  memory. For up to 24 hours, the server also keeps in memory a scrambled form of the network address (a keyed
  one-way hash that is replaced every day), linked to recent match outcomes and to the random identifiers seen with
  it, so that it can recognise the same computer from one match to the next. The IP address itself is never written
  to our database; only the outcome of the comparison is recorded. We also use the scrambled form to limit how often
  statistics and data requests may be made." (step B: "statistics, sign-in and data requests")
- (step B) add these rows:
  - "<tr><td>Your Google account identifier (a code that Google assigns to your account), the date your account was
    created, your username and the date it was last changed</td><td>To sign you in, to keep your statistics across
    devices and to display your username.</td></tr>"
  - "<tr><td>Sign-in session records: a one-way hash of your sign-in cookie, when it was created, when it expires and
    when it was last used</td><td>To keep you signed in and to allow you to sign out.</td></tr>"
- (step A) after the table, add: "Statistics are optional. You may turn off Save my stats on this device in
  Settings. When it is off, the game does not create a device identifier and saves no statistics, and you can still
  play every mode. When you turn it off, you are offered the choice to delete the statistics already saved; if you
  keep them, they are deleted automatically 90 days after your last recorded match."
- (step A) replace the IP paragraph (:162) with: "We use your IP address only to keep a free game online without
  spam, flooding or attacks, and to prevent players from counting matches played against themselves. We do not use
  it to determine your location or your identity."
- (step A) after the reconnect paragraph (:164), add: "The device identifier is never included in that connection
  address." (step B: "Neither the device identifier nor any sign-in information is ever included in that connection
  address.")
- (step A) "What we do not do" (:177): replace the first sentence with: "We do not sell personal information, share
  it for advertising purposes, or build advertising or marketing profiles. The only automated decision that Poddle
  makes is whether a match counts toward statistics, which is decided by fixed fair-play rules and affects nothing
  other than the statistics shown to you. If you believe that a result was wrongly excluded, you may contact us."
  The rest of the paragraph is unchanged.

**4 `#public`** (:196):
- (step A) add: "<li><strong>Statistics:</strong> your statistics, including your record against Matt and your
  personal bests, are shown only to you. We do not publish leaderboards. If a match does not count because both
  players appear to be using the same network or the same browser, both players are told that the match did not
  count.</li>"
- (step B) add: "<li><strong>Usernames:</strong> if you sign in and choose a username, it replaces your display name
  whenever you play. It is shown with a registered-player mark to opponents and spectators, in the public court list
  and in tournament brackets. Because a username stays the same from match to match, other players can recognise you
  each time you play. Do not include your real name or any other personal information in it.</li>"

**5 `#storage`** (:208):
- (step A) keep "<strong>Poddle does not use cookies.</strong>" and add these rows:
  - "<tr><td><code>poddle.device</code></td><td>A random identifier used to save your statistics on our server
    without an account. It is created the first time you take a seat to play, and it is replaced with a new one when
    you delete your data or turn statistics off and on again.</td><td>Until you clear it, turn statistics
    off or delete your data</td></tr>" (step B: "when you sign out, delete your data or ...")
  - "<tr><td><code>poddle.stats.on</code></td><td>Whether you have chosen to save your statistics</td><td>Until you
    clear it</td></tr>"
- (step A) replace "Each item is used to provide a feature you have requested, so no consent banner is required."
  (:225) with: "Each item is used to provide a feature that you have requested or that you may switch off. The device
  identifier is used only to save your own statistics and for fair-play checks within Poddle. It is never used for
  advertising or analytics and is never shared. You may switch it off at any time in Settings, under Save my stats on
  this device. If we ever introduce analytics, advertising or any non-essential storage, we will ask for your consent
  first and update this policy." (Q5: review by counsel before step A if EU, UK or Quebec traffic matters.)
- (step B) replace the first sentence with "<strong>Poddle uses a cookie only if you sign in.</strong>" and add:
  - "<tr><td><code>__Host-poddle_s</code> (cookie)</td><td>Keeps you signed in. It contains a random value that our
    server matches to your account, and it cannot be read by the page's scripts.</td><td>180 days, or until you sign
    out or delete your account</td></tr>"
  - "<tr><td><code>__Host-poddle_n</code> (cookie)</td><td>A one-time random value that protects the sign-in process
    from misuse</td><td>10 minutes, and removed when sign-in completes</td></tr>"
  - then: "When you choose to sign in, Google may set or read its own cookies in its sign-in window, under Google's
    Privacy Policy. Poddle cannot read those cookies."

**6 `#sharing`** (:229):
- (step A) append to the Fly.io bullet: "It also stores our statistics database on a storage volume in its Toronto
  region, together with daily snapshots of that volume, which may be stored elsewhere in Canada or the United
  States." (Q6 confirms the snapshot location.)
- (step A) replace "Because we keep very little information, there is usually little to disclose." with "Because we
  keep little information, and none of it names you, there is usually little to disclose."
- (step B) add: "<li><strong>Google LLC</strong> (United States) provides the optional Sign in with Google feature.
  Nothing is loaded from Google until you press the sign-in button. When you do, your browser loads Google's sign-in
  software and communicates directly with Google. Google receives your IP address, your browser details and the fact
  that you are signing in to Poddle, and it may set or read its own cookies in its sign-in window. Google then sends
  us a signed sign-in token. Because Google always includes them, that token contains your Google account
  identifier, your email address, your name and your profile picture. We verify the token, keep only the account
  identifier, and discard everything else immediately, without storing or logging it. Google handles your
  information under its own Privacy Policy. Deleting your Poddle account does not remove Poddle from the list of
  connected services in your Google Account; you may remove it there at any time.</li>"

**7 `#retention`** (:243):
- (step A) first bullet: prefix it with "Display names that you type," so it reads "Display names that you type, IP
  addresses, court and tournament details: ...", and replace "The server writes none of this information to disk."
  with "The server writes none of this information to disk. A scrambled form of the network address is kept in
  memory for up to 24 hours for fair-play checks, as described in Information we use and why."
- (step A) add:
  - "<li><strong>Statistics saved without an account:</strong> deleted automatically 90 days after the last match
    recorded for them, or 7 days after it if only one match was ever recorded. If you clear your browser storage, you
    can no longer view or delete those statistics yourself, and they are deleted automatically on the same
    schedule.</li>"
  - "<li><strong>Match records:</strong> deleted 30 days after the match.</li>"
  - "<li><strong>Backups:</strong> our hosting provider takes a snapshot of the database storage each day, and each
    snapshot is kept for 5 days. Information that you delete is removed from the live database immediately and is
    removed from all backups within 5 days. We do not keep any other copies of the database.</li>"
- (step A) append to the activity-logs bullet: "Log entries about matches record only the court code and whether the
  match counted, never who played."
- (step B) add:
  - "<li><strong>Accounts:</strong> kept until you delete your account. An account that has not signed in or recorded
    a match for 24 months is deleted automatically, together with its statistics.</li>"
  - "<li><strong>Sign-in sessions:</strong> deleted when you sign out, 180 days after you signed in, or when you
    delete your account.</li>"
  - "<li><strong>Former usernames:</strong> after a username is changed, or an account is deleted, a simplified form
    of the former username, which is not linked to any account, is kept for 30 days after a change or 90 days after
    a deletion, so that no one else can immediately take it to impersonate the former holder.</li>"

**9 `#rights`** (:261):
- (step A) replace "Because we have no accounts and keep very little information, we will often hold nothing that
  we can link to you. In that case, we will inform you." with: "You may also exercise the most common rights
  yourself, immediately, in the game. Open Your stats and choose Download my data to receive a copy of your
  statistics and recent matches in a machine-readable file (JSON), or Delete my data to delete your statistics from our live database at once. To protect your statistics, we can
  act on a request sent by email only if you can show that the statistics are yours, for example by making the
  request from the browser that holds them. Statistics saved without an account are
  linked only to a random identifier in your browser. If that identifier has been cleared, we cannot find those
  statistics, and they are deleted automatically after 90 days." (step B) insert "(and, if you are signed in, your
  account, username and sign-in sessions)" after "delete your statistics", replace "for example by making the request
  from the browser that holds them" with "for example by making the request while signed in or from the browser that
  holds them", and add: "If your username contains
  personal information and you wish to change or remove it sooner than the 30-day limit on changes allows, please
  contact us."
- (step A) add to the "take action yourself" paragraph: "turn off Save my stats on this device in Settings".

**10 `#children`** (step B) add: "An account may be created only by a person who is 13 or older, and a person under
18 may create one only with the permission of a parent or guardian. Poddle does not ask for a date of birth. Before
signing in, you are asked to confirm that you meet these conditions. If we learn that an account belongs to a child
under 13, we will delete the account and its statistics. A parent or guardian may ask us to delete a child's account
or statistics by writing to hello@danielrltan.com." (The operator verifies such a request as in 8.1 and 11.7 and Q17.)

**11 `#security`** (:282): (step A) replace "Game data is held in memory rather than in a database." with: "Live game
data is held in memory. Our database holds no email addresses, no IP addresses and no display names typed by guests.
Device identifiers are stored only as one-way hashes, which cannot be converted back into the original values,
although they remain linked to your statistics." (step B: "Device identifiers and sign-in cookies are stored only as
one-way hashes, ..." and add "The sign-in cookie cannot be read by the page's scripts and is sent only over encrypted
connections to poddleball.com.")

**13 `#laws`** (:300):
- GDPR table (:306-313), (step A) add:
  - "<tr><td>Game statistics, the random device identifier and recent match records</td><td>Our legitimate interest
    in giving players a record of their progress, which you may switch off at any time in Settings (Art.
    6(1)(f))</td></tr>"
  - "<tr><td>Fair-play checks at the end of a match (comparison of IP addresses and device identifiers, and the
    reasons recorded when a match does not count)</td><td>Our legitimate interest in keeping statistics fair and
    preventing cheating (Art. 6(1)(f))</td></tr>" (step B: "IP addresses, device identifiers and accounts")
  - (step B) "<tr><td>Google account identifier, username and sign-in sessions</td><td>Necessary to provide the
    account that you ask us to create (contract, Art. 6(1)(b))</td></tr>"
  Consent is NOT used as a basis: EU consent from a child under 16 would need verified parental consent (Art. 8),
  and the fair-play checks must run whatever an individual player would choose.
- (step A) Canada: add "By saving statistics, you consent to the handling described in this policy. You may
  withdraw that consent at any time by turning statistics off in Settings or by deleting your data." (step B:
  "By saving statistics or signing in, ...")
- (step B) after the Cloudflare sentence: "Google LLC participates in the EU-US Data Privacy Framework. When you choose
  to sign in, your browser communicates with Google directly."
- (step A) EU/UK representative (:316): replace with "We have not appointed a representative in the EU or UK, because
  Poddle is not directed at individuals in the EU or UK and our processing is small in scale and low in risk. You may
  contact us directly at hello@danielrltan.com." ONLY after counsel confirms Q18; otherwise appoint one before step A.
- (step A) United States (:318): add "The categories of personal information we collect are identifiers (a random
  device identifier), internet activity (your IP address, used only as described in this policy) and game
  statistics." (step B: "identifiers (a random device identifier and, if you sign in, a Google account identifier
  and a username)")

**15 `#changes`** (:331): (step B) replace paragraph 2 with: "Sign in with Google was added on {date}. This policy sets
out what we receive from Google, how long we keep it and how you can delete your account. Signing in is optional and
is never required to play."

### 10.2 web/terms.html
- 1 `#agree` (:109), (step A): "Poddle is provided free of charge. It saves game statistics, as described in the
  Privacy Policy. It does not offer purchases or subscriptions." (step B) add: "It offers optional accounts through
  Sign in with Google."
- 2 `#who` (step B), add: "You may create an account only if you meet these conditions. By signing in, you confirm
  that you are 13 or older and, if you are under 18, that your parent or guardian has agreed to these terms and to
  the Privacy Policy on your behalf."
- 4 `#names` conduct list (:156), (step A) add: "inflate your statistics by playing against yourself (for example, in
  several tabs, browsers or devices), by arranging results with another player, by trading wins or by deliberately
  forfeiting, or send false swing or motion data or modify the game's software in order to improve your statistics;"
  and after the list: "We may decline to count, reset or delete statistics that result from such conduct." (step B:
  "by deliberately forfeiting or by using more than one account" and "..., and we may suspend the account
  involved.")
- New section 5, titled "Statistics" in step A and "Statistics, accounts and usernames" in step B, after 4 `#names` (id `#stats`; renumber the later sections, the
  TOC and the survival clause in section 13, which today says "Sections 3, 8 and 10 to 15"). (step A) text: "Poddle
  records game statistics so that you can follow your progress. Statistics are provided for enjoyment only. They
  have no monetary value, are not your property and cannot be transferred or sold. Whether a match counts toward
  statistics is decided by automated fair-play rules. Matches between players on the same network or the same
  browser, very short matches, early forfeits and repeated matches between the same players may not count. We may
  correct, reset or delete statistics that we believe result from cheating or from a fault in the game." (step B)
  add: "Signing in is optional. You may hold one account only. Usernames must follow the rules shown in the game and
  the rules for display names in section 4. We may change or remove a username that is offensive, impersonates
  anyone or is reserved. A username may be changed once every 30 days. You may delete your account at any time from
  Your stats."
- Public courts, Tournaments (today section 5, :177), (step A): replace "and results are not saved" with "and
  tournament results are not saved, except that a tournament win may be added to the champion's statistics".
- Disclaimer (today 10, :217), (step A): replace "Scores and names are not saved." with "Matches in progress are not
  saved. Statistics from completed matches are saved as described in the Privacy Policy, but we do not guarantee that
  they will be preserved, and they may be lost, corrected or reset."
- Changes, suspension and discontinuation (today 13), Suspension, (step A) add: "We may delete statistics if we
  believe that they result from a breach of these terms." (step B: "We may suspend or delete an account, or delete its
  statistics, if we believe that it has been used in breach of these terms.") Your right to stop (step A): "You may
  stop using Poddle at any time by closing the page. You may delete your saved statistics at any time from Your
  stats, using Delete my data. To remove your saved settings, clear your browser's data for poddleball.com." (step B:
  "your saved statistics and, if you have one, your account")
- `dateModified` (:62), "Last updated" (:79), meta description (:13).

### 10.3 Other files
- web/sitemap.xml: `<lastmod>` of /privacy.html and /terms.html (lines 5-6) and / (line 3, the home notice) to the
  ship date. NO new URLs (test/seo.test.mjs:116 pins the list; `/api/*` is noindex anyway).
- CLAUDE.md "Current data flows": Server line: "memory only, no database" becomes "memory, plus a SQLite database on
  a Fly volume (stats, match log 30 days with fair-play flags derived from the in-memory IP comparison, guest devices
  90 days or 7 days after a single match, accounts: Google sub + username, session hashes; daily volume snapshots
  kept 5 days)". Add: "memory only, up to 24 h: keyed hashes of IPs / IPv6 /64s linked to device-id hashes, cids and
  recent results (link map, pair and new-guest counters), and API rate-limit buckets keyed the same way". Storage
  line: add `poddle.device`, `poddle.stats.on`; "No cookies" becomes "Cookies: `__Host-poddle_s`, `__Host-poddle_n`
  (step B only)". Public line: registered usernames + badge (step B). Third parties: Google (sign-in, only after the
  click and the age checkbox; step B).
- NOTES.md: section 96 (step A) and 97 (step B) in house style, each ending with the legal-page statement. Section 96
  also records: the Q1 probe result (14.3), the confirmed snapshot retention and location (Q6), the match_log
  justification (30 days: R11b needs a 30-day lookback and the export shows recent matches), and the rule that any
  database copy taken off the volume is deleted within 5 days (11.6).
- docs/ropa.md (new, stage d): the internal record of processing (GDPR Art. 30): for each purpose (play, abuse
  limits, statistics, fair-play checks, sign-in), the categories of data, recipients (Fly.io, Google in step B),
  retention (10.5), security measures (2.1, 3.3, 11.5) and the lawful basis (10.1 #laws). Taken from sections 2.2
  and 10.5; updated whenever they change. Not served under web/.

### 10.4 Home notice
Section 9.9. Required by CLAUDE.md ("important changes also need a notice on the home page").

### 10.5 Retention schedule (enforced by `db.sweep`, at boot and every 24 h)
`sweep` deletes in batches (`... WHERE rowid IN (SELECT rowid ... LIMIT 500)`), one short transaction per batch,
yielding with `setImmediate` between batches, so the daily run never stalls the 60 Hz loop. It ends with
`wal_checkpoint(TRUNCATE)` and deletes stray backup files (11.6).
| Data | Kept | Then |
| --- | --- | --- |
| Guest device + its profile (not merged) | 90 days since `owners.touched_at` (`GUEST_DAYS`); 7 days when `played <= 1` (`GUEST_ONE_DAYS`) | deleted with all its stats |
| Account + profile | until the player deletes it; accounts with no sign-in and no recorded match for 24 months are deleted (Q8, must be decided before step B) | deleted |
| Sessions | 180 days from creation, or sign-out, or account deletion | deleted |
| Match log | 30 days (`LOG_DAYS`): R11b looks back 30 days, and the export lists recent matches. Sooner, oldest first, while `nearFull()` (before a match is recorded, in its own transaction, and in the sweep). At most `LOG_CAP_DAY` (100) rows per owner a day; past it a bot result still counts, a human one is played only (unranked, `daily_cap`). No row for leaving Matt (`left`/`dropped`: `bot_record` counts it). (Added 2026-09-25) | deleted; owners already nulled on deletion |
| Name holds | 30 days (rename) / 90 days (deleted account); a skeleton string with no link to any account | deleted |
| Merged device rows | as long as the account (at most 50 per account) | deleted with the account |
| IP addresses | never stored; the raw address lives on the socket for its life | - |
| Keyed IP hashes, link map, computer-keyed results, new-guest and rate-limit counters | memory only, at most 24 h (5.4), gone on restart | pruned every minute |
| Volume snapshots | 5 days (`--snapshot-retention 5`, confirmed by Q6 before step A) | rotate out |
| Manual backups (`admin.js backup`) and any file copied off the volume | written outside `/data` (11.6); deleted within 5 days of creation, and any downloaded copy deleted within 5 days | deleted by the operator; `sweep` removes any `/data/backup-*.db` it finds |

### 10.6 Deletion semantics and export format
- Delete (`DELETE /api/account`): with a session → the account's owner (cascade: profile, bot_record, sessions,
  merged device rows), the username key into `name_holds` for 90 days, `match_log` owner columns set NULL; the cookie
  cleared. With a guest `dev` (unmerged) → that device's owner and device row. Both when both are given. Then
  `stats.forget(...)` (3.3) so no live socket or match re-creates it, and `wal_checkpoint(TRUNCATE)` (with
  `secure_delete=ON` the rows are overwritten in the file). The client then rotates its device id. What remains:
  the name hold (a skeleton string, no link to anyone, 90 days), the opponent-side `match_log` rows with this
  player's column nulled, and the daily snapshots taken before the deletion, which rotate out within 5 days. The
  privacy page and the confirm text (9.7) state both periods.
- Google connection: the deletion does not call Google (`google.accounts.id.revoke` would load Google's script and
  need the `sub` on the client); the privacy page tells the user to remove Poddle from their Google Account (10.1
  #sharing). Declined as a feature, section 15.
- Export (`POST /api/export`), JSON, UTF-8, pretty-printed:
```json
{
  "format": "poddle-export-1",
  "exportedAt": "2026-10-01T12:00:00.000Z",
  "kind": "guest",
  "account": null,
  "device": { "created": "2026-09-30T10:00:00.000Z", "lastPlayed": "2026-10-01T11:58:00.000Z", "deletedAfter": "2026-12-30T11:58:00.000Z" },
  "profile": { "...": "the Profile shape of section 8.2" },
  "matches": [ { "at": "2026-10-01T11:58:00.000Z", "kind": "bot", "mattLevel": "Pro", "result": "win", "score": [11, 7], "ending": "won", "counted": true, "reasons": [] } ],
  "notes": "This file contains all personal information that Poddle holds about this profile. Opponents are shown only as Matt or a player. We do not store your IP address, your email address or names typed as a guest. The purposes, recipients and retention periods are described at https://poddleball.com/privacy.html."
}
```
  For an account: `"kind":"account"`, `"account": {"username", "created", "renamed", "lastActivity", "merges",
  "google": "linked", "googleSubject"}` (the sub itself is included so the export is complete), `"sessions":
  [{"created", "expires", "lastUsed"}]`, `"mergedDevices": [{"created", "merged"}]`, `device` null, and when the body's
  `dev` names this browser's guest profile that did not merge, `"guestProfile"`: that profile's own export. `matches`
  is every log row that still names the owner (the log's retention, whatever the sweep has not yet removed), each with
  its `secs`, from the requester's side, with the precise `reasons` (rule ids,
  including the opponent-network ones hidden from the result card); the opponent's identity is never included.

---

## 11. Infrastructure

### 11.1 Fly volume and config
- Create once (operator): `fly volumes create poddle_data --app poddle --region yyz --size 1 --snapshot-retention 5 --yes`
  (1 GB is decades of this data: a match_log row is ~100 bytes; 10 000 matches a day × 30 days ≈ 30 MB; the database
  itself is capped at 256 MB by `max_page_count`, 2.1). `--snapshot-retention 5` is set explicitly because the
  privacy page promises 5 days; Q6 confirms the value and the snapshot location with `fly volumes snapshots list`
  before step A.
- fly.toml additions:
  ```toml
  [mounts]
    source = "poddle_data"
    destination = "/data"

  [env]
    PODDLE_DB = "/data/poddle.db"
    # GOOGLE_CLIENT_ID = "....apps.googleusercontent.com"   # step B only
  ```
- The volume pins the machine to its host. `min_machines_running = 0` and autostop stay: the volume survives a stop,
  and a wake is a fresh process (which is why R2 and the boot-time sweep matter).
- deploy.sh:16, the keep rule: `const keep = m.find(x => (x.config?.mounts || []).length) || m.find(x => x.region === 'yyz') || m[0]`
  so the machine that owns the volume is never destroyed. Add the new quick tests to the loop at :12:
  `accounts-unit.test.mjs stats.test.mjs auth.test.mjs`.
- Dockerfile: `CMD ["node", "--disable-warning=ExperimentalWarning", "server/game.js"]`. Nothing else changes
  (`server/` already ships whole, so `server/words.js` is included; `.dockerignore` unchanged). Runs as root today,
  so the volume is writable; if a non-root user is ever added, `chown` /data at start.
- .gitignore: add `*.db`, `*.db-wal`, `*.db-shm`.
- The database path must never be under `web/` (served publicly by the static handler). `db.open` refuses a path
  that resolves inside `web/` and logs `stats: database path refused`.

### 11.2 Environment variables
| Env | Default | Meaning |
| --- | --- | --- |
| `PODDLE_DB` | unset = `:memory:` | SQLite file. Production `/data/poddle.db`. |
| `GOOGLE_CLIENT_ID` | unset = sign-in off | Step B. |
| `GOOGLE_JWKS_FILE` | unset | Tests only; ignored under `NODE_ENV=production`. |
| `COOKIE_SECURE` | unset | `1` forces `__Host-` + `Secure` off Fly (tests). On Fly (`FLY_APP_NAME` set) always secure. |
| `GUEST_DAYS` / `GUEST_ONE_DAYS` / `LOG_DAYS` / `RENAME_DAYS` / `MERGE_MAX` / `DEVICES_MAX` | 90 / 7 / 30 / 30 / 10 / 50 | Retention and limits. |
| `LOG_CAP_DAY` | 100 | match_log rows per owner per 24 h (10.5, added 2026-09-25). |
| `DB_MAX_MB` | 256 | Database size cap (`max_page_count`). |
| `STATS_*` | section 5.3 | Anti-abuse knobs. |
| `FLY_APP_NAME` | set by Fly | Hosted: read the client address header chosen by Q1 with the checks of 3.5, production-only Origin allowlist (3.4), secure cookies, HSTS. |

### 11.3 Boot and shutdown order (server/game.js)
1. After the requires (:5): `const db = require('./db'), stats = require('./stats'), auth = require('./auth'),
   api = require('./api')`. None does anything when loaded.
2. Before `httpServer.listen` (:53): `db.open(process.env.PODDLE_DB || ':memory:')`, then `db.sweep(Date.now())`, then
   `setInterval(() => db.sweep(Date.now()), 24 * 3600e3).unref()`. All inside try/catch.
3. SIGINT/SIGTERM handler (:1449): `db.close()` before `process.exit(0)` (inside the 50 ms timeout callback, first
   line). Writes are synchronous (`DatabaseSync`), so no result that finished before the signal is lost.

### 11.4 When the database is unavailable
- `open` fails (volume missing, permissions, corrupt file): one log line, `db.ok() === false`, the game plays as today,
  `/api/me` says `db:false`, other `/api/*` answer 503, `profile` messages say `saved:false`, the Profile view shows
  "Stats aren’t available right now". The server does NOT create a fresh database elsewhere.
- A write fails at runtime (`SQLITE_FULL`, `SQLITE_IOERR`, `SQLITE_CORRUPT`): the transaction rolls back, the match
  is lost to stats (not to play), one log line per error code per hour, and `ok()` turns false until a later write
  succeeds.
- Corruption recovery (operator): stop, restore a snapshot with `fly volumes create --snapshot-id`. Copying
  `/data/poddle.db*` off with `fly ssh sftp get` is allowed only for diagnosis, and the copy is deleted within 5 days
  of being taken (recorded in NOTES), so the privacy page's "removed from all backups within 5 days" stays true.

### 11.5 Security headers (global; today only `nosniff` is set, server/game.js:23)
Added next to `nosniff` (server/game.js:23) for every response:
- `Referrer-Policy: strict-origin-when-cross-origin`
- `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'` (a frame-ancestors-only CSP breaks
  nothing inline; a full CSP is section 14 Q13)
- `Cross-Origin-Opener-Policy: same-origin-allow-popups` (NOT `same-origin`, which breaks the Google popup)
- `Strict-Transport-Security: max-age=31536000` only when `FLY_APP_NAME` is set (no `preload` without the operator's
  decision; `force_https` already redirects)

### 11.6 Backups
- Fly volume snapshots: daily, kept 5 days (`--snapshot-retention 5`, Q6). Deleted data remains in snapshots taken
  before the deletion until they rotate out, at most 5 days; the privacy page says so.
- `node server/admin.js backup` runs `VACUUM INTO '/tmp/poddle-backup-YYYYMMDD-HHMM.db'`: OUTSIDE `/data`, on the
  machine's ephemeral root filesystem, so it is never captured by a volume snapshot and vanishes on the next restart.
  `admin.js backup --clean` deletes it after download; `sweep` deletes any `/tmp/poddle-backup-*.db` older than 1 day
  and any `/data/backup-*.db` (none should exist). Any downloaded copy is deleted within 5 days of creation (NOTES).
- There are no other copies. This is what lets 10.1 say "removed from all backups within 5 days".

### 11.7 `server/admin.js` (operator CLI, never reachable over HTTP)
`node server/admin.js <cmd>` against `PODDLE_DB`: `counts` (rows per table), `rename <username> <new>`, `release
<username>` (drop a name hold), `delete-account <username>`, `backup [--clean]` (11.6), `sweep`. Run with `fly ssh
console -C`. `delete-account` is for OPERATOR-initiated cases only: an under-13 report (6.5) or a Terms breach. It is
never used to honour an e-mailed "delete account X" on a username alone (anyone who knows a username could then
delete it); a player's own request goes through the in-game tools or a signed-in session (8.1).

---

## 12. Test plan

Conventions: plain `.mjs`, `node test/X.mjs`, `ok(c, msg)`, last line `... PASSED` or `N FAILURES`, `process.exit`.
Temp DB via `fs.mkdtempSync(path.join(os.tmpdir(), 'poddle-'))`, removed on exit. Ports 94xx are free today
(8950 is `CAM_PORT`, so not 89xx).

### 12.1 test/accounts-unit.test.mjs (no server, no port; `createRequire` loads the modules)
- usernames: every 7.1 rule and reason; NFKC (fullwidth passes, Cyrillic `Мatt` fails `chars`); skeleton collisions
  (`Matt`/`M4tt`/`rnatt`/`MAT_T`/`Maatt`); `Matthew` and `Mateo` allowed; reserved prefix/exact; profanity substring
  vs exact.
- abuse: table-driven, one case per rule R0-R17 (ranked, unranked, ignored as specified); several flags at once;
  `computerKey` for IPv4, IPv4-mapped IPv6, IPv6 /64 grouping (two addresses in one /64 equal, different /64 not),
  empty; `rank`: Rookie < Club < Tour < Pro; `config` under `NODE_ENV=production` ignores `STATS_SAME_IP=0` and
  `STATS_AFK_MIN=0`.
- stats: `swingBest` caps (pk 50 → bad, pk 38 → 35, pk null → no speed, smash with pk 8 → bad, bet not recorded).
  Fix path: contact on a soft bet (n 0.3) then a settled fix at n 1.0 with no re-aim → NOT recorded; a settled fix
  within 0.15 of the bet → recorded once; a settled fix that re-aims → recorded at the fix's power.
- rally bests: a revived bot match with a 20-ball rally → no best saved (judge `bests:false` is the only switch).
- abuse, new rules: R11 fires TOGETHER with R10 (a loser with 6 unranked-by-pair-cap losses to one winner in 7 days
  → `feeder`, proving R11 is reachable); R11b after 5 one-way ranked wins in 30 days; R11c (loser created 1 h ago
  with 1 match → winner credit withheld, loss recorded); R7b leaver ahead by 3; R7 with `FORFEIT_MIN = ceil(WIN_AT/2)`;
  R18 teleport (winner teleporting → win unranked, no bests; loser teleporting → loss counts; one fast sample alone
  → no flag); R6b asymmetry (identity-changed LOSER → loss recorded against the frozen owner, opponent's win
  ranked; identity-changed WINNER → win withheld); R4 not triggered by a mid-match downgrade or `gone`; `why`
  mapping never yields an opponent-network reason for human matches (only `self`, `not_counted`, `restart`,
  `too_short`).
- link map (`createLinks` with injected clock): one device hash on an IPv4 key and an IPv6 /64 → one group; a seat
  whose set is {home, vpn} vs a seat on {home} → R5; entries expire at 24 h; salt rotation keeps lookups working for
  the previous day; the 50 000 cap evicts oldest; computer-keyed pair count catches a feeder that rotates device ids
  every match from one IP.
- guest names: `imp()` hides Cyrillic `Мatt` / `Mаtt`, Greek `ΜΑΤΤ` and `Τ` variants, `Matt.`, `Matt!`, `M a t t`,
  `Matt™`, `Mat̲t`, `ProMatt`, `Matt_bot`; allows `Matthew`, `Mateo`, `Pro`, `Club`, `Me`; `cleanName` removes ✓ ✔ ✅
  ☑ √ ™ 🗸 from `Daniel ✓`.
- `clientAddr` / `loopback`: hosted with `fly-client-ip: 127.0.0.1`, `10.0.0.1`, `fe80::1`, `100.64.0.1`, `garbage`
  → the shared `'bad'` key, not loopback-exempt; hosted with a public address → that address; not hosted, loopback peer
  with a header → the header, not exempt; not hosted, loopback peer without a header → exempt; `x127.0.0.1` never
  exempt.
- abuse R8/R9 asymmetry: an idle seat LOSING to Matt → loss counted; an idle seat winning → win unranked.
- auth verifier with a locally generated RSA key (`crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })`, JWK
  with `kid`): good token; wrong `aud`; `aud` as array; wrong `azp`; wrong `iss`; expired beyond skew; `iat` in the
  future; `alg: none`; `alg: HS256` signed with the public key as the HMAC secret (algorithm confusion); unknown
  `kid` (refetch attempted once, then rejected); bad signature; payload tampered after signing; 5 KB token; malformed
  base64. JWKS cache honours `max-age` (injected `now`).
- `parseCookie` (duplicates, spaces, 5 KB header), `originAllowed` matrix: not hosted (the three hosts, localhost any
  port, `[::1]`, Host-equal LAN origin with the same scheme, the same host with the other scheme refused, `null`,
  `https://poddleball.com.evil.test`, `http://poddleball.com` refused); hosted (`FLY_APP_NAME` set): only the three
  https origins pass, `http://localhost:3000`, `http://127.0.0.1:8080` and a Host-equal origin are refused.
- rate limiter: 25 000 distinct keys → map size stays at or under 20 000; the fallback bucket applies during a flood.
- db (`:memory:`): `ownerForDevice` creates once and follows a merge; `guestOwner` returns null once merged; `recordMatch` ranked vs unranked effects on every column; streak rules;
  bot level rows; merge: all five rows of the 2.4 table and the fold rules; `deleteOwner` cascade + name hold;
  `claimUsername` taken/held/cooldown with injected `now`, and two claims of one key racing → one `ok`, one `taken`;
  `sweep` with injected `now` (guest at 91 days deleted, 89 kept; a one-match guest at 8 days deleted, 6 kept; log
  at 31 days deleted; expired sessions and holds deleted); sessions: lookup, expiry, the 11th evicts the oldest,
  hash stored (the raw token is not in the database file bytes); `ownerForDevice(create:false)` creates nothing;
  `recordMatch` with one seat's owner deleted → the other seat's result is written, no FOREIGN KEY failure;
  `recordMatch` with no owners → no `match_log` row; merge with an unknown device → `'none'`, no row; the 51st
  device link → `'none'`; after `deleteOwner` + checkpoint, a distinctive value from the deleted profile is absent
  from the database and `-wal` file bytes (`secure_delete`); a database at its `max_page_count` → `SQLITE_FULL`
  handled, `ok()` false, nothing thrown.
- Last line: `ACCOUNTS UNIT PASSED`.

### 12.2 test/stats.test.mjs (`STATS_PORT` 9400, 9401, 9402)
Servers: 9400 `{ PODDLE_DB: tmp/a.db, WIN_AT: '2', REMATCH_S: '4', HOLD_S: '3', STATS_MIN_POINT_S: '0',
STATS_AFK_MIN: '0', STATS_FORFEIT_MIN: '1' }`; 9401 on the same file for persistence/revive (`REVIVE_S:
'30'`), started only AFTER the 9400 process has exited (two processes never open one file); 9402 `{ PODDLE_DB: '/nonexistent/dir/x.db' }` (DB unavailable). Clients send `hello` with fixed test device ids
and distinct `fly-client-ip` headers per simulated computer.
1. A bot match (Matt via `{type:'bot',level:0}`) played to the end. How a scripted client scores against Matt: reuse
   the hitter from test/bot.test.mjs (it tracks the ball from `state` and sends `paddle` + settled `swing`), and play
   at Rookie (whiff 0.18) with `WIN_AT=2`, retrying up to 3 matches until one is won; the loss path is asserted from
   the same runs. Then: `profile` message arrives, `saved:true`, correct
   level W/L; `first:true` on the first win; `POST /api/stats {dev}` shows it (with `Origin: http://localhost:9400`).
2. Level change after the first strike (Rookie → Pro) is recorded at Rookie; Tour → Pro recorded at Tour; a change
   before the first strike is recorded at the new level.
3. Explicit `leave` mid bot match → level loss; `terminate()` mid bot match → abandon, streak 0.
4. Two humans, different `fly-client-ip`, different devices → ranked W/L both sides.
5. Same `fly-client-ip` → unranked `same_computer`; different IPs but same device id → `same_device`.
6. Forfeit (leave) with 0 points → unranked `early_forfeit`; after enough points → ranked.
7. Pair cap: the 4th result between the same two devices within the run → unranked `pair_cap`.
8. Revive: SIGINT 9400 mid-match, start 9401 on the same file, reconnect with `back=1&room=CODE&score=1-0&bot=2` →
   that match unranked `revived`; the rematch after it is ranked.
9. Persistence: after the restart, `/api/stats` returns the earlier totals.
10. Pad socket (`?padfor=`) sending `hello` → nothing recorded for it.
11. A socket with `Origin: https://evil.example` and `hello` → plays, records nothing; no Origin → records.
12. The LOCAL room (no `lobby=1`) with `hello` finishing a match → nothing recorded.
13. Malformed `dev` (too long, not hex) → ignored.
14. `POST /api/export {dev}` → attachment with the section 10.6 shape; `DELETE /api/account {dev,confirm}` → 200,
    then `/api/stats` → `profile:null`.
15. 9402: boots, a bot match still plays to the end, `profile` says `saved:false`, `/api/me` `db:false`,
    `/api/stats` 503.
16. Logs: the captured stdout+stderr of every server contains none of the test device ids, hashes or IP strings.
17. Identity downgrade: in a ranked human match (two IPs, two devices), the losing seat reconnects mid-match with
    its cid and sends NO hello → the match ends; the loss lands on the ORIGINAL device, the winner's win is ranked,
    the loser's result card says nothing about the opponent. Repeat with the loser reconnecting and sending a
    DIFFERENT dev → same outcome (loss on the original device). A plain reconnect that re-sends the SAME dev → no
    `ident_changed` at all.
18. Network hop: one seat reconnects mid-match from a different `fly-client-ip` with the same dev and cid, where the
    other seat is on the first address → `same_computer` (the seat's computer set intersects).
19. Revived human court that falls back to Matt after 2.5 s (the first `startMatch` comes from `addBot`) → the bot
    match is unranked `revived`, no bests.
20. DoS: 50 fresh device ids from one `fly-client-ip`, each doing create → bot → serve one swing → leave → at most 0
    owners and 0 `match_log` rows (`left` on an unseen device creates nothing); 40 fresh ids that each COMPLETE a
    match from one IP with `NEW_GUEST_DAY=30` → exactly 30 owners, the rest `saved:false`.
21. Deletion mid-match: `DELETE /api/account {dev}` for seat A while its match is live → the match ends, seat A gets
    `saved:false`, no owner is re-created for that dev, seat B's result is recorded and is not `anon_opponent`.
22. Teleport: a scripted client that sets `x` to the ball's x every message against Rookie Matt and wins → the win
    is unranked `paddle_teleport`, no first win.
- Last line: `STATS TESTS PASSED`.

### 12.3 test/auth.test.mjs (`AUTH_PORT` 9410, 9411, 9412, 9413)
Servers: 9410 `{ PODDLE_DB: tmp/b.db, GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com', GOOGLE_JWKS_FILE:
tmp/jwks.json, COOKIE_SECURE: '1', RENAME_DAYS: '0', WIN_AT: '2', STATS_*: as 12.2 }`; 9411 same without
`GOOGLE_CLIENT_ID`; 9412 `NODE_ENV=production` with `GOOGLE_JWKS_FILE` set.
1. Nonce: `GET /api/signin/nonce` sets `__Host-poddle_n` with HttpOnly, Secure, SameSite=Strict, Max-Age=600.
2. Good sign-in: `Set-Cookie: __Host-poddle_s=...; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=15552000`, no
   `Domain`; body has `account.username: null`; neither the database file nor its `-wal` file contains the raw token or any
   e-mail placed in the test token's payload.
3. Rejections: no Origin 403; foreign Origin 403; `text/plain` 415; 9 KB body 413; nonce mismatch 403; the same
   token replayed with a new nonce cookie 403; bad tokens (wrong aud, expired) 401 with no cookie.
4. `/api/me` with the cookie shows the account; without it, null.
5. Username: claim ok; the same skeleton from a second account 409; reserved `M4tt` 422 `reserved`; with
   `RENAME_DAYS=0` a rename succeeds and the old key is then 409 for the other account (hold).
6. Merge: play a bot match as a guest device, then sign in with that `dev` → `merged:'merged'` and the profile has the
   win; a second sign-in with another account and the same device → `'none'`, nothing moved.
7. WS with the cookie and `Origin: http://localhost:9410` → `welcome` has `reg` true for the seat; a finished match
   lands on the account. WS with the cookie and `Origin: https://evil.example` → anonymous (no `reg`, nothing
   recorded).
8. Sign-out → 204, cookie cleared, the old cookie value no longer works on `/api/me`. A second sign-in while a
   session cookie is present → the old token no longer works (fixation). A socket opened with the cookie before
   sign-out → a match that STARTS after the sign-out is recorded as a guest, not on the account; a match that was
   already under way at sign-out (the player losing) still records the loss on the account.
9. `DELETE /api/account` with the cookie → 200, cookie cleared, `/api/signin` with the same Google sub creates a NEW
   empty account; the deleted username is held (409).
10. Rate limit: 11 `/api/signin` in a minute from one `fly-client-ip` → 429 with `Retry-After`.
11. `Host: www.poddleball.com` → `/api/me` 404 `wrong_host` (no 301).
12. 9411: `/api/me` `signin.enabled:false`; `/api/signin/nonce` and `/api/signin` 404 `signin_off`; guest export works.
13. 9412: a self-signed test token → 401 or 503, never 200, no cookie; stdout shows the "ignored in production" line.
14. Crash safety: on 9412 (JWKS unreachable or rejecting) send a sign-in, a body that is invalid JSON, a body that
    stops mid-way (socket destroyed), a body with a `__proto__` key, and a 1 MB body; afterwards `/status.json` still
    answers and a WS still plays.
15. 9413 `{ FLY_APP_NAME: 'poddle-test', PODDLE_DB: tmp/c.db, ADDR_ROOMS: '4' }` (hosted mode on loopback): `POST
    /api/stats` with `Origin: http://localhost:9413` → 403; a WS with that Origin and the cookie → anonymous; five
    sockets with `fly-client-ip: 127.0.0.1` (or `10.0.0.1`, or `garbage`) each creating a court → they share the
    `'bad'` key, none is exempt, and the 5th gets `busy`; five with one public test address → the 5th gets `busy`.
- Last line: `AUTH TESTS PASSED`.

### 12.4 test/profile-ui.mjs (`PROFILE_UI_PORT` 9420 pages, 9421 fake game+API, 9422 dead; puppeteer-core like test/ui-next.mjs)
- ui-mock: `#btn-profile`, `#lobby-profile`, `#result-save`, `#signin-card`, `#tog-save-stats`, `#news` exist and are
  optional (removing each from the mock does not throw).
- Real page against a fake server: no request to `accounts.google.com` or `gstatic.com` on load (request
  interception); with `signin.enabled:false` no sign-in control is visible anywhere; with it enabled, pressing
  "Sign in with Google" requests `https://accounts.google.com/gsi/client` (intercepted and aborted → the card shows
  the load-failure text).
- A `profile` WS message after `matchover` fills `#result-save`; `nudge:true` shows the button; the rematch button
  keeps focus.
- The Profile view draws a fixture profile (four Matt rows in BOT_ORDER, locked/unlocked chips, bests).
- No `poddle.device` after page load, the title screen, the lobby or watching a court; it is created (UUID v4
  pattern, `crypto.randomUUID`) when the page first receives `welcome` as a seated player, a `hello` frame follows at
  once, the id is never in any WebSocket URL, and after a reload it is sent in the first frame of the socket.
- A `profile` message with `created:true` shows the one-time save notice, on whichever page load it arrives (seat on
  one load with no finished match, finish a match on the next); a later message without it does not.
- A guest name containing ✓ (from a fake `names` message, as the server would never send it) renders the text only,
  and no `.reg-badge` element exists; a `reg:true` seat renders a `.reg-badge` element that is not part of the name's
  text node.
- With sign-in enabled: pressing "Sign in with Google" makes NO request to `accounts.google.com` until `#signin-age`
  is ticked.
- Turning "Save my stats" off with a saved profile shows the delete-or-keep choice; Delete sends `DELETE
  /api/account` before `poddle.device` is removed; with Keep, the socket reconnects after the current match and a
  match that starts after the toggle sends no `hello` (fake server: the new socket's first frame is not a hello).
- The `#news` Privacy link stops propagation (a click opens the link, not the game).
- Last line: `PROFILE UI PASSED`.

### 12.5 Existing tests that must still pass unchanged
`revive`, `rooms`, `seo` (with the new dates), `server`, `tourney`, `joinreq`, `watcher`, `emote`, `pad`, `padquit`,
`countdown`, `ui-next`, `menu`. Run the quick three plus the new three before every deploy (deploy.sh).

### 12.6 Security review gate
After each implementation stage (13a, 13b, 13c) run `/security-review` from `/Users/danieltan/poddle-accounts` (it
needs a git repository and reviews the diff; it could not run for this spec because the orchestrating session's
working directory was not a repository). Checklist to review against (general knowledge, OWASP Session Management,
CSRF Prevention and JSON Web Token cheat sheets): token entropy and hashing at rest; cookie flags and prefix; session
fixation (a new token on every sign-in); logout and deletion invalidate server-side; CSRF on every state change
(Origin + JSON content type, no CORS); cross-site WebSocket hijacking; JWT alg pinning, key selection, claim checks;
no secrets or identifiers in URLs or logs; rate limits; input size limits; SQL only through bound parameters; error
messages that do not reveal whether a name is held or an account exists.

Privacy gate for stage (d): run the `legal:compliance-check` skill (or `operations:compliance-tracking`, whose triggers
include GDPR) with section 10, section 2.2 and question Q5 as input, before the step A and step B commits. It checks
the privacy/terms changes against what the code stores; it does not replace a lawyer's view on Q5.

---

## 13. Implementation split (in order; each stage ends with its tests green and a `/security-review` pass)

### (a) New server modules, independent of game.js (one implementer, or four in parallel)
| File | Owns | Depends on |
| --- | --- | --- |
| `server/db.js` | section 2 (schema, migrations, every query, merge, sweep, sessions, name holds, export shape) | `node:sqlite`, `node:crypto` |
| `server/abuse.js` | section 5 (pure), `computerKey`, `rank`, `config`, `titleCounts`, `createLinks` (5.4: link map, computer-keyed history, new-guest counter, keyed hashing with the rotating salt) | `node:crypto` |
| `server/usernames.js` + `server/words.js` | section 7 (pure), including `imp()` and the look-alike table for guest names (7.3) | nothing |
| `server/auth.js` | section 6.3 verifier, `parseCookie`, cookie building, `originAllowed` (hosted and local modes), `clientAddr` + `isLoopbackPeer` (3.5), token/nonce generation, rate limiter with the size cap (8.1) | `node:crypto`, `node:net` |
| `server/stats.js` | section 4.5 `swingBest`, 4.7 `onEnd` orchestration (db + abuse), `title`, `forget` (3.3), `identify` freeze-or-compare logic as a pure helper (3.2), the teleport sampler (4.8) | db, abuse |
| `test/accounts-unit.test.mjs` | section 12.1 | the above |
Rules: CommonJS; nothing runs on require; no dependency added to package.json; every exported function documented in
one comment line in the house style.

### (b) game.js integration, HTTP routes, infra (one implementer; needs (a))
- `server/game.js`: requires and boot order (11.3); `clientAddr` at :1384 and the exact `loopback(ws)` at its three
  callers :173, :1064, :1179 (3.5); `cleanName` badge look-alikes (7.3); teleport sampling in the `paddle` branch
  :838-839 (4.8); Origin + cookie + `hello` (3.2-3.4);
  `identify` freeze-or-compare on `acc.ident` (join :686, retake :696, hello); `match` accumulator (4.1); hooks in `launch` :301-305,
  `reset` :386, `strike` :430, `fixBlock` :445 / :861 / :862-865 / :874, `point` :560, `endMatch` :464,
  `forfeitHeld` :513, `leave` :789, `answer` :750, `botRequest` :632-634, `revive` :1087 (`reviveTaint`),
  `tourAdd`/`tourBind` :1162, `tourChamp` :1258; `reg` in names/welcome/matchover; guest names with reserved
  skeletons; `profile` message; security headers (11.5); `/api/` dispatch before :24.
- `server/api.js` (section 8), `server/admin.js` (11.7).
- Dockerfile, fly.toml, deploy.sh, .gitignore (11.1).
- `test/stats.test.mjs`, `test/auth.test.mjs` (12.2, 12.3).

### (c) Client UI (one implementer; needs (b)'s message shapes, can start against a fake server)
- `web/profile.js` (new), `web/main.js` (hello, `/api/me`, `profile` message, handlers :658-670, reconnect after
  sign-in/out), `web/motion.js` + `web/main.js:493,498` (`pk`, `src`), `web/ui.js` (views, `matchSaved`,
  `drawProfile`, badge, name field), `web/ui.css` (tile stagger, profile view, badge, result line, cards),
  `web/index.html` (markup inside UI:BEGIN/END, 9.9 notice), `test/profile-ui.mjs`, `test/ui-mock.html` if it needs
  the new fixture hooks. docs/ui-spec.md gets a short section for the new screens.

### (d) Legal, notes, inventory (one implementer; needs (b) and (c) to describe what exists)
- `web/privacy.html`, `web/terms.html` (10.1, 10.2), `web/sitemap.xml` (10.3), `CLAUDE.md` data flows, `NOTES.md`
  section 96 (and 97 for step B), with the open questions below copied into NOTES as the operator list (CLAUDE.md
  says they live there, next to NOTES 94).
- `node test/seo.test.mjs` must pass (one h1, one ld+json, "Last updated" equals `dateModified`, sitemap list).
- `docs/ropa.md` (10.3), NOTES entries for Q1, Q6, the match_log justification and the 5-day rule for off-volume copies.
- Gate: the privacy check in 12.6 (`legal:compliance-check`) before each commit.

Commits (when the orchestrator commits): author Daniel Tan <83306809+danielrltan@users.noreply.github.com>, one-line
subject, NO Co-Authored-By or other trailers (CLAUDE.md, overriding any tool default). Step A is one commit that
includes its legal pages; step B another. Work only in /Users/danieltan/poddle-accounts, never ~/airpod-pickleball.

---

## 14. Ship plan and open questions

### 14.1 Step A: stats, anti-abuse, device id, export/delete (no sign-in visible)
1. HARD GATES (step A does not ship until each has a recorded answer in NOTES):
   - Q1: run the Fly-Client-IP probe against the live app and pick the header `clientAddr` reads in production.
   - Q6: snapshot retention confirmed at 5 days and the snapshot location known (the privacy page states both).
   - Q11, Q12: node:sqlite in the image, and the volume attached to the machine.
   - Q16: the teleport threshold checked against recorded play.
   - Q5 and Q18: counsel's view if EU, UK or Quebec traffic matters (device id default, EU representative wording).
   Then the operator creates the volume (11.1).
2. Merge (a)+(b)+(c)+(d, step A wording: no Google, no cookies) with `GOOGLE_CLIENT_ID` unset.
3. `./deploy.sh` (quick tests now include the three new files).
4. After deploy: `curl https://poddleball.com/api/me` → `{"signin":{"enabled":false,...},"db":true}`; play one bot
   match on a phone; open Your stats; download and delete; `fly ssh console -C "node server/admin.js counts"`.
5. Home notice on; NOTES 96.

### 14.2 Step B: Google sign-in and usernames
1. Operator: Google Cloud OAuth client (6.1) and consent screen; decide Q8 (inactive accounts) and Q17 (parent
   requests); check that the consent screen's list of data matches the 10.1 #sharing text.
2. Legal pages step B (Google recipient, cookies, accounts, usernames, terms section), CLAUDE.md, NOTES 97, notice
   text "Sign in to keep your stats on any device".
3. Set `GOOGLE_CLIENT_ID` in fly.toml `[env]` (or `fly secrets set`), deploy. The code is already there.
4. Verify on the live site: nothing loads from Google before the click; the cookie is `__Host-`, HttpOnly, Secure,
   SameSite=Lax; delete works end to end.

### 14.3 Open questions for the operator (defaults this spec uses in brackets)
- **Q1 Client address header (HARD GATE before step A).** Nobody has measured whether Fly's proxy overwrites a
  client-sent `Fly-Client-IP`. Probe against the live app, before any stats code ships: from one machine, open 5
  WebSocket clients to `wss://poddleball.com/?lobby=1`, each sending a different forged `Fly-Client-IP` (public
  test addresses, plus one `127.0.0.1`), and `create` a court from each. `ADDR_ROOMS` is 4: if the 5th gets
  `joinfail busy`, the header is overwritten by the proxy and `clientAddr` reads it; if all 5 succeed (or the
  `127.0.0.1` one escapes the limit), the header passes through and `clientAddr` must read the proxy-appended LAST
  entry of `X-Forwarded-For` instead (re-run the probe against that). Close the probe's courts at once. Record the
  commands and result in NOTES. Until then the spec claims nothing about Fly's behaviour. [No assumption.]
- **Q2 Tour (confirm).** The task says the ladder is Rookie, Club, Pro and Tour is tournament-only. This spec
  follows that: three rungs; level-3 results (tournament Matt, warm-ups) are kept and shown on one "Tournament Matt"
  line. Tour is still selectable in Play a bot today: hide it there (a small game change outside this project), or
  keep it and let those results land on the Tournament Matt line? Decide before stage (c). [Three rungs; Tour
  results on their own line; hiding it is the operator's call.]
- **Q3 Swing speed ceiling.** 35 rad/s is a general-knowledge gyro range (±2000 °/s), not measured on AirPods or
  phones here. Check the maximum `peak` in data/live-capture.jsonl and data/live2.jsonl and adjust the cap. [35,
  implausible above 40.]
- **Q4 Households on one IP.** R5 unranks two real people sharing a router. Relax it when both seats are signed in
  with different accounts that each have 10+ ranked matches against other opponents? [No: strict, as the user asked.]
- **Q5 Consent for the device id (counsel before step A if EU, UK or Quebec traffic matters).** The spec creates the
  id lazily at the first seat, shows a just-in-time notice on the first result card, and keeps "Save my stats"
  default ON with a switch. The strictest EU/Quebec reading (ePrivacy Art. 5(3) as read by EDPB Guidelines 2/2023;
  Quebec Law 25 s. 9.1 privacy by default) may require default OFF with a one-tap "Save my stats" opt-in on the first
  result card, in which case that first match is not saved. [Lazy + notice + default ON.]
- **Q6 Snapshots (gate).** Confirm `--snapshot-retention 5` took effect (`fly volumes snapshots list poddle_data`)
  and where snapshots are stored. The privacy page states 5 days and "elsewhere in Canada or the United States".
  [Daily, 5 days.]
- **Q7 Speed units.** Show fastest swing as °/s, rad/s, or an invented "paddle speed" score? [°/s rounded to 10.]
- **Q8 Inactive accounts (decide before step B).** Delete accounts with no sign-in and no match for 24 months? [Yes,
  with the privacy page saying so.]
- **Q9 Reserved names.** Add the owner's own names or other brand words to `server/words.js`? [List in 7.3 only.]
- **Q10 Non-ASCII usernames.** ASCII-only keeps confusables tractable without a dependency. Allow other scripts
  later with a vendored confusables table? [ASCII only.]
- **Q11 node:sqlite in the image (gate).** Confirm `docker run --rm node:24-alpine node -e "require('node:sqlite')"`
  works and consider pinning `node:24.11-alpine` so a Node update cannot change the experimental API under us. [Pin.]
- **Q12 Attaching the volume (gate).** Does `fly deploy` with a new `[mounts]` recreate the existing volume-less
  machine, or must the operator destroy it (`fly machine destroy <id>`) and deploy again? Check `fly machines list
  --json` `config.mounts` after the first deploy. [Destroy and redeploy if the mount is missing.]
- **Q13 Full CSP.** A page-wide CSP would need `'unsafe-inline'` or hashes for the inline title-screen handlers
  (index.html:237), the ld+json, and the cdnjs `document.write` fallback (index.html:553-554), plus
  `https://accounts.google.com/gsi/` for script, frame, connect and style. [Deferred; only frame-ancestors now.]
- **Q14 Public stats later.** Leaderboards would make swing values and bot wins public; both are forgeable. [Never
  public in this project; a future leaderboard would use ranked human results only.]
- **Q15 Dropped connection vs Matt = no loss.** Closing the tab mid-match counts as an abandon (streak lost) rather
  than a loss, because the server cannot tell it from bad wifi. [Yes.]
- **Q16 Teleport threshold (gate).** Check the fastest real paddle movement (camera and Auto-off play) in the
  recordings under data/ and set `TELEPORT_MS` well above it. [12 m/s over 2 consecutive samples.]
- **Q17 Parent and guardian requests.** How does the operator verify a parent asking to delete a child's account
  when the parent cannot sign in as the child? [Ask the parent to use the child's browser (Delete my data) or to
  have the child sign in; otherwise treat a credible under-13 report as an operator-initiated deletion (6.5, 11.7).]
- **Q18 EU/UK representative (counsel).** With a persistent database the Art. 27(2) "occasional" exemption is
  weaker. Either appoint a representative, or have counsel confirm that Poddle does not target the EU/UK under Art.
  3(2) (English only, no EU pricing or localisation, Canadian server) and use the 10.1 #laws wording. Keep
  docs/ropa.md either way (Art. 30(5) no longer applies). [Counsel before step A.]
- **Q19 COPPA (counsel).** A Wii-Sports-style game with a cartoon Matt may attract under-13s. Confirm that the site
  is not "directed to children" under the COPPA factors and that the device id stays within the
  support-for-internal-operations exception (it is used only for the player's own statistics and fair-play checks,
  never for advertising, analytics or profiling, 3.1). [13+ policy unchanged; age checkbox at sign-in.]

---

## 15. Decisions (how each critique issue was resolved)

Blockers and majors are all fixed in place. Minor issues are fixed unless listed as declined.

Fixed (where):
- Client address trust (blocker): 3.5 (validated header, shared `bad` key, exact peer-only loopback at :173, :1064,
  :1179), Q1 as a hard gate (14.1, 14.3), tests 12.1 and 12.3 #15.
- Identity downgrade on reconnect (major): frozen seat identity (3.2, 4.1), R6b as a per-seat rule, R4 only for
  whole-match anonymity (5.2), tests 12.1 and 12.2 #17.
- Computer key per socket, IPv4/IPv6 split, VPN hop (major): per-seat computer SETS and the 24 h link map (5.4), R5
  on set intersection, R16 on groups (4.3), known gap documented (5.2), tests 12.1 and 12.2 #18.
- Rotating feeders and the dead R11 (major): R11 over all results in 7 days plus a computer-keyed 24 h count, R10 on
  owners AND computer groups, R11b `one_way` over 30 days, R11c established loser (5.2), tests 12.1.
- Database growth (major): 5.5 (owners only from completed matches, new-guest caps, no ownerless log rows, 7-day
  retention for one-match guests, 50 device links per account, no row for unknown devices at sign-in, 256 MB cap),
  test 12.2 #20.
- Guest impersonation of Matt (major): `imp()` comparison form (7.3), tests 12.1.
- Badge spoofing (major): look-alikes stripped from guest names, badge drawn as an element (7.3, 7.5), test 12.4.
- Origin allowlist in production (major): 3.4, tests 12.1 and 12.3 #15.
- Stale sessions and deleted accounts mid-match (minor): `stats.forget` (3.3; sign-out and eviction affect only
  matches that start afterwards, so they cannot be used to erase a loss; deletion drops that seat only), per-seat
  `ownerExists` inside the transaction (4.7), new token and old session revoked on every sign-in (3.3), tests 12.2
  #21 and 12.3 #8.
- Fix-path swing bests (minor): 4.5 (agreement within 0.15, or a fix that really changed the ball), test 12.1.
- Teleporting paddles (minor): 4.8 and R18, test 12.2 #22.
- `same_network` leak to strangers (minor): generic `not_counted` for human matches (8.3, 9.3).
- Rally bests vs R2/R8 (minor): 4.4 uses `judge().seats[i].bests` only, test 12.1.
- Tour (minor): three-rung ladder, Tour results on their own line, Q2 kept only as a confirmation (Goals, 2.2, 8.2,
  9.4, 14.3).
- Forged revive scores (coverage): unchanged, test added for the revived court that falls back to Matt (12.2 #19).
- Forfeit farming (coverage): `FORFEIT_MIN = ceil(WIN_AT/2)` in production, R7b `leaver_ahead` (5.2, 5.3).
- JSON bodies read field by field (8.1); rate-limit map capped (8.1); `claimUsername` in one BEGIN IMMEDIATE (7.4).
- Every privacy and terms text issue (Google as recipient, sentences that become false, backups and deletion,
  step A vs step B head, device id notice, lawful bases, EU representative and record of processing, age at
  sign-in, collect table, public usernames, storage rows, retention, rights and e-mail verification, terms,
  stats toggle, export completeness, match_log justification, COPPA, Fly/changes/US/home notice/CLAUDE.md): 10.1,
  10.2, 10.3, 10.5, 10.6, 6.4, 6.5, 9.3, 9.5-9.7, 9.9, 11.4, 11.6, 11.7, Q5, Q17-Q19.

Choices made where critique items pulled in different directions:
- Lazy device id vs saving the first match: the critique suggested creating the id when the first match ENDS, but
  then the seat is anonymous when the match is judged and match one can never be saved. The id is created at the
  first SEAT instead (never on page load), and the just-in-time notice appears on that match's result card (3.1).
  Q5 keeps the stricter opt-in as an option for counsel.
- Stale-session re-lookup vs frozen identities: a seat whose account or device was deleted is dropped for THAT seat
  only, and the opponent is still judged on the frozen identities, so the minor fix cannot reopen the downgrade
  attack (3.3, 4.7).
- Invalid client-address header: one shared `bad` key rather than a per-socket random key (which would let a forged
  header buy unlimited courts) or a peer fallback (the proxy's address) (3.5).
- New retained data introduced by these fixes (the 24 h in-memory link map and counters, the 7-day retention for
  one-match guests) is disclosed in 10.1 (IP row, retention), 10.3 (CLAUDE.md) and 10.5.
- match_log keeps 30 days: R11b needs a 30-day lookback, and the export shows recent matches; both purposes are
  stated in the privacy row (10.1) and recorded in NOTES (10.3).
- Parent deletion requests vs "never act on a username alone": in-game tools or a signed-in session for players;
  `admin.js delete-account` only for operator-initiated cases (under-13 report, Terms breach) (6.5, 8.1, 11.7, Q17).
- Backups: `admin.js backup` writes to `/tmp` (never snapshotted), off-volume copies are deleted within 5 days,
  `secure_delete` and a WAL checkpoint after deletions, so "removed from all backups within 5 days" is true (2.1,
  11.6, 10.5).

Declined, with reasons:
- Wall-clock skew signal in the ping (critique 5.2 (c), optional): `c` is `performance.now()` today (web/main.js:623),
  so it would need a new client-reported value that a cheater controls anyway, and it would add a new piece of
  personal data to disclose. The link map covers the same-browser case; the residual IPv4/IPv6 two-browser case is
  documented as a known gap (5.2).
- Limiting a Google `sub` to one new account per 30 days after a deletion (squatting minor): it means keeping the
  sub (or a hash of it) after the user asked for everything to be deleted, which contradicts 10.6 and the privacy
  page. Name churn is already slowed by the 90-day hold on a deleted account's name and the 30-day rename cooldown.
- `google.accounts.id.revoke(sub)` on account deletion (optional): it would load Google's script at deletion time
  (a request to Google the player did not ask for) and need the `sub` on the client. The privacy page tells users how
  to remove Poddle from their Google Account instead (10.1 #sharing, 10.6).
- Nulling `owner_a/owner_b` after 48 hours (match_log minor, alternative): declined in favour of the stated 30-day
  justification above, which R11b now needs.
