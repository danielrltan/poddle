# Poddle: rules for every session

## Legal pages (keep them true on every change)
web/privacy.html and web/terms.html describe exactly what the code does. Before any commit or push, check whether the
change adds or alters any of these. If it does, update the page(s) in the SAME commit, bump "Last updated" and the
`dateModified` in their ld+json (and `<lastmod>` in web/sitemap.xml), and say so in the change's NOTES.md section.
- data sent to the server, stored, or logged (a new `console.log` with names, IPs or tab ids -> Privacy section 7)
- anything newly shown to other players (names, profiles, chat, leaderboards, replays, recordings, user content)
- localStorage / sessionStorage keys or cookies (Privacy section 5 table)
- device permissions: camera, motion, mic, location, local network, notifications (Privacy 2, Terms 3)
- third-party scripts, CDNs, fonts, SDKs, analytics, auth providers, email tools; vendored libraries that phone home
- accounts or sign-in (e.g. Google Sign-In: adds an account, email / Google ID, Google as a recipient, tokens or cookies,
  account deletion, probably a consent banner; the privacy page promises an update BEFORE it launches), payments, prizes
- the age audience (now 13+, under 18 with a parent's permission)
- a MediaPipe upgrade: re-apply the "Poddle:" patch in web/vendor/mp/vision_bundle.js (usage logging to Google off);
  `node test/seo.test.mjs` fails without it
Important changes also need a notice on the home page. Open questions for the operator are in NOTES.md 94.

### Current data flows (diff new features against this)
- Server (Fly.io, Toronto; memory): display name (12 chars), IP (4 courts per IP, 1 open tournament
  per IP, ask-to-play cooldown), tab id `cid`, phone pairing code, court/tournament codes, seats, score, swings, bot
  level, emotes, pause/rematch, position (~60 Hz, relayed), phone motion (relayed to the paired tab only). Reconnect URL
  carries name, cid, code, score, side, bot (revive()); never the device id or any sign-in value. Logs: activity lines
  with court codes and ranked/unranked, no names/IPs/cids/device ids/account ids/Google subs/tokens.
- Server memory only, up to 24 h, gone on restart (server/abuse.js): keyed hashes (daily key) of IPs / IPv6 /64s linked
  to device-id hashes, cids and recent results (link map, pair and new-guest counters), and API rate-limit buckets keyed
  the same way (server/api.js, its own key, also replaced every 24 h). SHA-256 of each sign-in nonce issued, 10 min,
  single use. The raw IP is compared in memory at match end and never written to the database.
- Server database (SQLite `node:sqlite` at PODDLE_DB=/data/poddle.db on the Fly volume poddle_data; server/db.js,
  docs/ACCOUNTS.md 2.2): owners (kind, created, last match/sign-in); devices (SHA-256 of the device id, merge date);
  accounts (Google `sub` only, username + confusable-folded key, created, renamed, merge count; NO email, name or
  picture from Google); sessions (SHA-256 of the cookie token, created, expires 180 d, last seen hourly; max 10);
  profile + bot_record (W/L, streaks, points, titles, best rally/hit/speed + dates, four Matt rungs: wire 0,1,3,2);
  match_log (time, kind, Matt level, the two owner ids, score, winner, ending, ranked flag + rule reasons, length).
  No IPs, no guest display names, no emails. Retention (db.sweep at boot + every 24 h): guests 90 d after last
  recorded match (7 d if only one), accounts 24 months idle, match_log 30 d (sooner, oldest first, near the DB_MAX_MB
  cap; at most LOG_CAP_DAY=100 rows per owner a day; no row for leaving Matt), sessions at expiry, name holds 30 d
  (rename) / 90 d (deleted account). Fly volume snapshots daily, kept 5 d; admin backups in /tmp, gone within 5 d.
- Public: player names, scores, moves; spectator names to players on watch / ask-to-play, to all on emotes;
  tournament host and player names, bracket; listed courts in the court list. Registered usernames with a badge
  (replace the display name) to opponents, spectators, court list, brackets. Stats are private to their owner (no
  leaderboards); both players are told when a match did not count.
- Browser only: webcam frames -> MediaPipe face/pose points -> one centre point (points discarded, never sent).
  Storage: poddle.name, poddle.settings {airpod, stats, reach, sound, body, sink}, poddle.camPrimer (allow|skip), poddle.view, poddle.airpod,
  poddle.courts, poddle.device (random device id, made at first seat with stats on; rotated on sign-out, delete,
  stats off/on), poddle.stats.on ('0': every socket says `nostats` first and nothing is recorded, signed in or not); sessionStorage cid, pad. Cookies (only if the player signs in): `__Host-poddle_s`
  (session, HttpOnly, 180 d), `__Host-poddle_n` (sign-in nonce, 10 min).
- Third parties: Fly.io (host, logs ~7 days, the database volume + 5-day snapshots), Cloudflare (cdnjs three.js
  fallback; email forwarding for hello@danielrltan.com), the mailbox provider, GitHub (Helper source, only on click),
  Google (Sign in with Google: its script loads only after the player opens sign-in and ticks the age box; its ID
  token carries email/name/picture, which the server discards, keeping only `sub`; Google sets its own cookies / FedCM
  in its window). No analytics, no ads.
- Poddle Helper (Mac, MIT, ~/poddle-helper): AirPod motion over localhost only; accepts poddleball.com,
  www.poddleball.com, poddle.fly.dev, localhost pages.

## Commits
Commit as Daniel Tan <83306809+danielrltan@users.noreply.github.com>, one-line subject, no Co-Authored-By or other
Claude trailers. Add a numbered NOTES.md section per change.
