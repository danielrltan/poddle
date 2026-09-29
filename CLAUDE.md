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
  per IP, ask-to-play cooldown, 2 Ranked queue entries per computer (Ranked only for signed-in accounts with a username, NOTES 133) and never paired within one computer group), tab id `cid`, phone pairing code, court/tournament codes, seats, score, swings, bot
  level, emotes, pause/rematch, position (~60 Hz, relayed), phone motion (relayed to the paired tab only). Reconnect URL
  carries name, cid, code, score, side, bot (revive()); never the device id or any sign-in value. Logs: activity lines
  with court codes and ranked/unranked, no names/IPs/cids/device ids/account ids/Google subs/tokens.
- Server memory only, up to 24 h, gone on restart (server/abuse.js): keyed hashes (daily key) of IPs / IPv6 /64s linked
  to device-id hashes, cids and recent results (link map, pair and new-guest counters), and API rate-limit buckets keyed
  the same way (server/api.js, its own key, also replaced every 24 h). SHA-256 of each sign-in nonce issued, 10 min,
  single use. The raw IP is compared in memory at match end and never written to the database. Share cards
  (server/share.js, card.js): a keyed hash (own daily key) of the network address counting card renders a minute; and,
  until evicted or a restart, the last 64 card PNGs.
- Server database (SQLite `node:sqlite` at PODDLE_DB=/data/poddle.db on the Fly volume poddle_data; server/db.js,
  docs/ACCOUNTS.md 2.2): owners (kind, created, last match/sign-in); devices (SHA-256 of the device id, merge date);
  accounts (Google `sub` only, username + confusable-folded key, created, renamed, merge count, lb_hidden (Show me on the global leaderboard off); NO email, name or
  picture from Google); sessions (SHA-256 of the cookie token, created, expires 180 d, last seen hourly; max 10);
  profile + bot_record (W/L, streaks, points, titles, best rally/hit/speed + dates, four Matt rungs: wire 0,1,3,2;
  play totals over counted matches: hits, returns, chances, winners, aces, smashes, points won/lost, seconds played);
  share (owner, random 10-char slug, created; one per owner, opt-in via Share card, deleted by Stop sharing, with the
  owner, for the guest on a merge, or by the operator: `admin.js unshare <link>` / `unshare-user <username>`);
  match_log (time, kind, Matt level, the two owner ids, score, winner, ending, ranked flag + rule reasons, length, and for
  Ranked mode: mode 'ladder'|'casual', series id, the trophy change per side); ladder (per owner: trophies, rank tier 1..8 and
  division (Pro: none; tier/div re-derived from the trophy counts at every open, NOTES 124), best rank/division and when, Ranked wins/losses/streaks, Matt queue wins/losses, Matt trophies awarded today).
  No IPs, no guest display names, no emails. Retention (db.sweep at boot + every 24 h): guests 90 d after last
  recorded match (7 d if only one), accounts 24 months idle, match_log 30 d (sooner, oldest first, near the DB_MAX_MB
  cap; at most LOG_CAP_DAY=100 rows per owner a day; no row for leaving Matt), sessions at expiry, name holds 30 d
  (rename) / 90 d (deleted account). Fly volume snapshots daily, kept 5 d; admin backups in /tmp, gone within 5 d.
- Public: player names, scores, moves; spectator names to players on watch / ask-to-play, to all on emotes;
  tournament host and player names, bracket; listed courts in the court list. Registered usernames
  (replace the display name) to opponents, spectators, court list, brackets; the developer's username (Dan) shows a hammer badge
  (tooltip "Developer") and always plays as its own fixed character; so does the username Mae (a white lop-eared bunny) (scene.js LOOKS,
  NOTES 137 and 144: derived from the public username on the client, nothing new sent or stored). In Ranked courts the rank emblem (the rank's tier and division only, never trophies or record) beside a
  name, to the opponent and spectators (VS card, scoreboard, result card). The global leaderboard (NOTES 126; GET /api/leaderboard, public, no sign-in): the top 100 of three boards (Ranked
  trophies, best rally, best win streak vs people), each row place + username + value + rank emblem (tier/div), accounts WITH a
  username only, never guests, never an owner id; accounts.lb_hidden = 1 (Show me on the global leaderboard off) takes a name off
  at once. Clicking a row opens that player's profile card (NOTES 140; GET /api/leaderboard/player?u=<name>, public, no sign-in, 60 a minute, 30 s
  cache cleared by hide/rename/delete; admin.js changes wait out the TTL): exactly the share card's subset (share.dataOf / card.dataOf: username,
  Ranked rank/div + emblem + trophies, Pro #N, toughest Matt beaten, the eleven card stats with the headline three's notes), rank null when never played Ranked, for every account on at
  least one board, at any place (NOTES 141); unknown, guest, no-username, hidden, on-no-board, renamed-away and deleted all answer the same 404;
  never an owner id. A player's own places ride on /api/stats and /api/me. Stats are otherwise private to their owner unless the owner presses Share card: then anyone with poddleball.com/c/<slug> sees the card page and PNG
  (noindex, max-age 300): username or "Poddle player" (never a guest's typed name), Ranked rank + ladder trophies and its
  emblem, toughest Matt beaten, the same eleven card stats for everyone, zeros included (NOTES 145: win rate vs people with the W-L record under it,
  time on court over counted matches of every kind, best win streak vs people; return rate, points won %, longest rally, fastest swing, winners, aces,
  smashes, tournament titles), also in the og tags and alt text; the apps it is pasted into fetch it for
  previews and may keep them. Both players are told when a match did not count.
- Browser only: webcam frames -> MediaPipe face/pose points -> one centre point (points discarded, never sent).
  Storage: poddle.name, poddle.settings {airpod, stats, reach, sound, body, sink}, poddle.camPrimer (allow|skip), poddle.lbSeen ('1': the one-time global leaderboard notice was shown; '2': the profile-card notice too, NOTES 140), poddle.view, poddle.airpod,
  poddle.courts, poddle.device (random device id, made at the first seat or Ranked queue entry; rotated on sign-out and delete). Stats are recorded for
  every player, no off switch: poddle.stats.on (the old Save my stats key) is no longer used and profile.js deletes it at load (REMOVED 2026-09-28,
  NOTES 116; the server still accepts an old tab's `nostats` frame for compatibility); sessionStorage cid, pad. Cookies (only if the player signs in): `__Host-poddle_s`
  (session, HttpOnly, 180 d), `__Host-poddle_n` (sign-in nonce, 10 min).
- Third parties: Fly.io (host, logs ~7 days, the database volume + 5-day snapshots), Cloudflare (cdnjs three.js
  fallback; email forwarding for hello@danielrltan.com), the mailbox provider, GitHub (Helper source, only on click),
  Google (Sign in with Google: its script loads only after the player opens the sign-in card; its ID
  token carries email/name/picture, which the server discards, keeping only `sub`; Google sets its own cookies / FedCM
  in its window). No analytics, no ads.
- Poddle Helper (Mac, MIT, ~/poddle-helper): AirPod motion over localhost only; accepts poddleball.com,
  www.poddleball.com, poddle.fly.dev, localhost pages.

## Commits
Commit as Daniel Tan <83306809+danielrltan@users.noreply.github.com>, one-line subject, no Co-Authored-By or other
Claude trailers. Add a numbered NOTES.md section per change.
