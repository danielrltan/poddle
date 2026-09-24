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
- Server (Fly.io, Toronto; memory only, no database): display name (12 chars), IP (4 courts per IP, 1 open tournament
  per IP, ask-to-play cooldown), tab id `cid`, phone pairing code, court/tournament codes, seats, score, swings, bot
  level, emotes, pause/rematch, position (~60 Hz, relayed), phone motion (relayed to the paired tab only). Reconnect URL
  carries name, cid, code, score, side, bot (revive()). Logs: activity lines with court codes, no names/IPs/cids.
- Public: player names, scores, moves; spectator names to players on watch / ask-to-play, to all on emotes;
  tournament host and player names, bracket; listed courts in the court list.
- Browser only: webcam frames -> MediaPipe face/pose points -> one centre point (points discarded, never sent).
  Storage: poddle.name, poddle.settings {airpod, stats, reach, sound, body, sink}, poddle.view, poddle.airpod,
  poddle.courts; sessionStorage cid, pad. No cookies.
- Third parties: Fly.io (host, logs ~7 days), Cloudflare (cdnjs three.js fallback; email forwarding for
  hello@danielrltan.com), the mailbox provider, GitHub (Helper source, only on click). No analytics, no ads.
- Poddle Helper (Mac, MIT, ~/poddle-helper): AirPod motion over localhost only; accepts poddleball.com,
  www.poddleball.com, poddle.fly.dev, localhost pages.

## Commits
Commit as Daniel Tan <83306809+danielrltan@users.noreply.github.com>, one-line subject, no Co-Authored-By or other
Claude trailers. Add a numbered NOTES.md section per change.
