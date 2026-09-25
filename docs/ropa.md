# Record of processing activities (GDPR Art. 30; internal, not served)

Controller: Daniel Tan, operator of Poddle (poddleball.com), hello@danielrltan.com. No processor other than those named
below. No EU/UK representative appointed (see NOTES.md 94, Q18: pending counsel). Source of truth for the fields and
periods: docs/ACCOUNTS.md 2.2 (schema) and 10.5 (retention), server/db.js (`sweep`). Update this file in the same
commit as any change to those, together with web/privacy.html.
Last reviewed: 2026-09-24 (full launch: statistics and Sign in with Google together).

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
  limits; court/tournament counts per IP; ask-to-play cooldown.
- Basis: legitimate interests (keeping a free service online without spam, flooding or attacks).
- Retention: memory only, at most 24 h, pruned every minute, gone on restart.
- Security: the raw IP never reaches the database or the logs.

## 3. Game statistics
- Data: SHA-256 of a random device id (`localStorage['poddle.device']`); owner rows (created, last match or sign-in);
  profile (matches played, W/L, streaks, points, tournament titles, best rally, hardest hit and fastest swing with
  dates); Matt ladder (four rungs Rookie, Club, Tour, Pro: W/L, abandons, streaks, first win date, best margin).
- Basis: legitimate interests (Art. 6(1)(f)): giving players a record of their progress; switchable off in Settings
  (Save my stats on this device; off, nothing is recorded, signed in or not), with self-serve download and deletion. Canada: consent by saving statistics,
  withdrawn by turning them off or deleting. Consent is not the GDPR basis (Art. 8 would need verified parental
  consent under 16).
- Recipients: only the owner (stats are never shown to other players; no leaderboards); Fly.io.
- Retention: guest statistics 90 days after the last recorded match, 7 days if only one match was ever recorded;
  account statistics with the account (below). Deleted rows are zeroed (`secure_delete=ON`) and the WAL truncated.
- Security: device id stored only as a hash; it never travels in a URL; export/delete need the raw id or a session.

## 4. Fair-play checks (automated ranked/unranked decision)
- Data: at match end, the two players' IPs compared in memory; in memory for up to 24 h, keyed hashes of the network
  address linked to device-id hashes, cids, accounts and recent results (link map); in the database, `match_log`:
  time, kind, Matt level, the two owner ids (never names), score, winner, ending, ranked flag, rule reasons, length.
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
  used once). An age confirmation checkbox (13+, under 18 with a parent's permission) precedes loading Google's script.
- Basis: contract (Art. 6(1)(b)): the account the player asks for. Fair-play checks on accounts: legitimate interests.
- Recipients: Google LLC (United States; EU-US Data Privacy Framework) learns the player signed in to Poddle and sets
  or reads its own cookies / FedCM in its sign-in window; the username (with a registered-player badge) is shown to
  opponents, spectators, the court list and tournament brackets; Fly.io.
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
- Self-serve in the game: Your stats > Download my data (JSON, `poddle-export-1`) and Delete my data (live database at
  once). By email to hello@danielrltan.com: answered within 30 days (GDPR 1 month, PIPEDA 30 days, CCPA 45 days),
  after checking the requester controls the profile (signed in, or the browser holding the device id).
