# Play stats and the share card (NOTES 114)

The owner asked (2026-09-27): more stats on Your stats, "like return rate (amount of balls you actually are able to hit back)",
and a **Share card** button that makes a poddleball.com link which unfurls as a stylised image when pasted anywhere
(iMessage, Discord, X, WhatsApp, Slack, LinkedIn). It is a selling feature for word of mouth: the card must look great.

This file is the contract between the three build parts: **A** (server: counting), **B** (server: share link, page, image),
**C** (client: Your stats tiles and the share sheet). Field and route names here are fixed; do not rename them.

Already done on this branch (do not redo): the Matt badge (NOTES 111) and the database groundwork in server/db.js
(`PLAY_COLS`, `EXTRA`, `extra()`): nine new `profile` columns and the `share` table, added idempotently after the
numbered migrations. **Never add a MIGRATIONS entry** for them: Ranked (merged, NOTES 112) owns migration 2, and `extra()` runs
after the migrations loop.

## 1. Counting (part A: server/stats.js, server/game.js, server/db.js recordMatch + fold + profileOf)

Per human seat, per match, in the stats accumulator (`seatAcc`), for EVERY match kind (Matt, people, tournament):

| counter | meaning |
|---|---|
| hits | every contact the seat made (serves, returns, held-paddle blocks) |
| returns | contacts on the OPPONENT's ball: every contact except the seat's own serve |
| chances | balls the opponent put in play that this seat had to return = returns + misses |
| winners | points this seat won because the opponent never touched its (non-serve) shot |
| aces | points this seat won because the opponent never touched its serve |
| smashes | contacts whose shot kind is `smash` (server/game.js shotKind; the kind strike() decides) |
| pts_won / pts_lost | points won and lost, every kind of match (the existing h_points_* stay people-only) |
| secs_played | the match length in seconds (onEnd's `secs`) |

Rules, pinned (verify each against server/game.js before relying on it):
- **A serve** is a contact made while `m.rally === 0` (rallyReset zeroes it at every point; `launched()` increments it
  AFTER the contact). Do NOT use `ball.serving`: serveStrike() clears it before strike() runs.
- **A miss** (the receiver's failed return): point() ends with why `'double bounce'` or `'passed'`, won by `ball.lastHit`.
  The loser (1 - winner) gets `chances += 1`; the winner gets `aces += 1` if `m.rally === 1` (only the serve was struck)
  else `winners += 1`. `'out'` is the hitter's fault and counts for nobody's chances/winners. A volley of a ball that
  was going out is still a contact, so it is still a return.
- Every return also counts one chance (`chances += 1` with `returns += 1`).
- `stats.pointEnd(m)` must gain `(winner, why)` (game.js point() has both). Keep it no-throw (it runs in sim()).
  Seat index == side: confirm how `m.seats` is indexed before using `winner` as an index.
- **Gate**: the counters are added in recordMatch only when the seat's `rec && s.bests` (the same switch as the
  personal bests), so a result that did not count cannot inflate them. Add them with ONE new prepared statement
  (`playAdd`: `UPDATE profile SET hits = hits + ?, ... WHERE owner_id = ?`) called after `S.profSet.run(...)` — do not
  widen `profSet` (Ranked edits those lines too; a separate statement merged cleanly). Clamp each value with
  `num(v, 0, 1e6)` like the rest.
- **fold()** (guest merged into an account) adds the guest's nine counters into the account's (a separate statement too).
- **profileOf** returns them as `play`:
  `play: { hits, returns, chances, winners, aces, smashes, pointsWon, pointsLost, secs }` (secs = secs_played).
  exportOf includes them automatically through profileOf. Update docs/ACCOUNTS.md's Profile shape if it lists fields.
- Tests: extend test/stats.test.mjs (or a new test) so a scripted rally proves: a serve is a hit but not a return; a
  return adds returns+chances; a double bounce/passed miss adds a chance to the receiver and a winner or ace to the
  striker; 'out' adds none; the counters survive recordMatch and fold; a non-counted match adds nothing.

## 2. Share link, page and image (part B: new server/share.js + server/card.js, routes in api.js / game.js)

**Storage**: table `share(owner_id PK, slug UNIQUE, created_at)`. One live link per owner. `slug` = 10 chars of
`[A-Za-z0-9]` from `crypto.randomBytes` (reject-sample; never derived from any id). Deleting an owner cascades.
Stop sharing deletes the row; sharing again makes a NEW slug (old links die). On a guest->account merge (db.mergeDevice
/ fold) the GUEST's share row is deleted, never moved. exportOf includes `share: { url, created } | null`.

**API** (server/api.js ROUTES, same origin/JSON/rate-limit rules as the others; needs the database):
- `POST /api/share` body `{ dev? }` (session cookie wins, like /api/stats) -> `200 { url, image }` creating the row if
  there is none; `404 { error: 'nothing' }` when there is no saved profile. `url` = `https://poddleball.com/c/<slug>`
  (the `SITE` origin when hosted; `http://<host>` locally, so tests work), `image` = `<url>.png?v=<hash>`.
- `DELETE /api/share` body `{ dev? }` -> `204` (idempotent).
- `/api/stats`'s profile gains `share: { url, image } | null` so the page knows the link before any click (Safari only
  lets a click write the clipboard synchronously).

**Public routes** (server/game.js static handler, before the web/ files; GET/HEAD only):
- `/c/<slug>` -> an HTML page (`text/html`, `Cache-Control: public, max-age=300`, `X-Robots-Tag: noindex`) with
  absolute `og:title` ("<Name> on Poddle"), `og:description` (one line of the best stats + "Play free at poddleball.com"),
  `og:image` (`https://poddleball.com/c/<slug>.png?v=<hash>`), `og:image:width` 1200, `og:image:height` 630,
  `og:image:alt`, `og:url`, `og:site_name` Poddle, `twitter:card` summary_large_image, `<meta name=robots content=noindex>`.
  Body: the card image big, a primary "Play Poddle free" button to `/`, and a small "Make your own card: play, then
  open Your stats" line. Same look as the site (web/ui.css tokens and the Poddle Rounded font), phone friendly.
- `/c/<slug>.png` -> `image/png` 1200x630, `Cache-Control: public, max-age=300`, an ETag from the hash; the query string
  is ignored for the cache key (the hash is recomputed from the stored stats).
- Unknown or malformed slug: 404 (the site's 404 page for the HTML, an empty 404 for .png). NEVER render for them.
- The hash = a short sha256 of exactly the fields drawn on the card, so a stats change changes the og:image URL and
  unfurlers fetch the new picture.

**What the card shows** (the profile's owner, read at request time; nothing from the query string):
- The name: the signed-in account's `username`; a guest (or an account with no username yet) is "Poddle player".
  Guest display names are NOT stored (privacy promise) — the client tells guests "Sign in to put your name on it".
- The rank: the Ranked ladder's, exactly what Your stats' hero shows (web/profile.js drawRoad, docs/RANKED.md 2: one
  rank per player): `profile.ladder` tier and division as "Gold II", the ladder's trophies, and the rank's emblem, drawn
  from web/emblems.js's own SVG sprite (exported as `SPRITE`, its ids prefixed `em-` on the card, the tier's symbol
  inlined; `rankOf(profile)` in server/card.js). The division is a white pill over the emblem's lower edge, as
  `.st-em[data-div]`. No ladder (never played Ranked, an older server) is Bronze I with 0 trophies, as Your stats reads
  it; the card leaves the trophy pill off at 0. og:description and the alt texts say "Gold II rank" (the alts add the
  trophies). The emblem artwork is hashed with `CARD_V`, so a redrawn emblem is a new picture URL (NOTES 114).
- The Matt badge: the toughest Matt beaten in difficulty order (Rookie, Club, Tour, Pro; wire 0, 1, 3, 2), level colour
  as web/ui.css .st-matt (Rookie #3ecf72, Club #3aa0ff, Tour #a77bf3, Pro gold), or nothing if none.
- The stats: return rate (returns / chances, shown only from 10 chances up; since the review fixes, NOTES 114: a card tile only from 20 chances at 50% or better, the rally from 5 hits; since design round 1: W-L vs people only from 3 wins with more wins than losses, matches played as a chip only, the swing after record / streak / titles), longest rally, fastest swing (deg/s,
  rounded to 10 like the page), W-L vs people, best win streak, titles, winners/aces if room. Choose what reads best;
  zero or missing values are left off rather than shown as 0.
- The brand: the Poddle wordmark/ball, "poddleball.com", a plain call to action ("Play free at poddleball.com" over "Pickleball in your browser · your phone is the paddle"; no taunt line, NOTES 118).
- The look: the game's bright sky/court palette, chunky rounded type (M PLUS Rounded 1c 800/900), gold accents,
  crisp at 1200x630 and legible when a chat app shrinks it to ~400 px wide. It has to make people want to click.

**Rendering**: SVG string -> PNG with `@resvg/resvg-js` (add to dependencies; package-lock.json MUST contain the
`@resvg/resvg-js-linux-x64-musl` entry: the Docker image is node:24-alpine — check the lockfile text). resvg cannot read
woff2: convert web/vendor/fonts/mplus-rounded-1c-{500,800,900}.woff2 (+ nunito if an ellipsis is needed) to TTF with
fontTools in a venv under the session scratchpad (never pip into the system), commit them under server/fonts/ with the
OFL licence file. The card text must use only glyphs in those subsets (usernames are ASCII [A-Za-z0-9_]).
Safety (the server is one process; a crash ends every live match): require resvg lazily inside try/catch; on failure
serve web/og.jpg and log one line an hour; render one card at a time (a promise queue); LRU cache of the last 64 PNGs
keyed slug+hash; a per-IP limit on cache-miss renders; nothing thrown can escape the request handler. Log no slugs,
names or ids (court codes only, as today).

Tests (new test/share.test.mjs, its own port base via env): create/get/delete, one link per owner, new slug after
delete, 404 for unknown/malformed slugs without rendering, the page's meta tags are absolute and complete, the PNG is a
valid 1200x630 PNG, the hash changes when a stat changes, merge deletes the guest's share, export includes it,
cascade on delete, rate limit, resvg missing -> og.jpg fallback. Save rendered PNGs under test/ui-shots/share/ for review.

## 3. Your stats (part C: web/profile.js, web/index.html, web/ui.css, test/profile-ui.mjs)

- **New stats** from `profile.play` (absent on an older server: draw nothing new then, no errors).
  Return rate is the headline (big %, with "N of M returned"; under 10 chances a coaching line "Return 10 balls to see
  it"). Then compact figures: winners, aces, smashes, total hits, points won %, time on court (h m). Fit them into the
  existing card without making it scroll at 1280x800 (it fits today with room to spare only on phones — check the
  1280x800 and 390x844 screenshots, and every size in the test's SIZES list).
- **Share card button** in the card header (next to Sign in / Sign out; visible whenever a profile is saved). Click:
  if `profile.share` is known, copy its url synchronously; if not, `POST /api/share` and copy with
  `navigator.clipboard.write([new ClipboardItem({ 'text/plain': promiseOfBlob })])` inside the click (Safari), falling
  back to writeText, then to a selected read-only input. Then open the **share sheet** (a card like the sign-in card,
  web/profile.js openCard/closeCard pattern, Escape closes, focus trapped/returned): the card image preview
  (`image` url, 1200x630 aspect, a skeleton until it loads), the link in a read-only field with Copy (shows "Copied!"),
  Download image (fetch the PNG -> blob -> `poddle-card.png`), Share... (`navigator.share({ url, title })` only where
  it exists), a guest line "Sign in to put your name on your card" (opens sign-in) when there is no username, and a
  small "Stop sharing" (DELETE /api/share, confirms inline, then the link is dead and the button makes a new one).
  Toast "Link copied" on success.
- Every server string goes in as textContent / attribute, never innerHTML. Respect prefers-reduced-motion.
- test/profile-ui.mjs: extend the fake /api with `/api/share` (POST/DELETE) and `profile.play`, assert the tiles'
  numbers, the empty/coaching states, the button, the sheet, the copied text (grant clipboard permissions in
  puppeteer), Stop sharing, and the old-server case (no `play`, no `share`). Screenshots: stats + sheet at 1280x800
  and 390x844.

## 4. Legal (done at integration, same commit as the feature)

Privacy: the new counters (profile table), the share table and slug, what a share link makes PUBLIC to anyone with
it (username or "Poddle player", rank, the Matt badge, the stats on the card), that crawlers of the apps it is pasted
into fetch it, how to stop sharing, retention (lives with the profile; deleted with it; merge deletes a guest's link).
Terms: a short clause on shared cards. CLAUDE.md "Current data flows": the same. Bump Last updated / dateModified /
sitemap lastmod. A home-page notice is not needed (sharing is opt-in) unless the pages say otherwise.
