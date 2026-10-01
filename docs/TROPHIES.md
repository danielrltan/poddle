# Poddle trophies: the ladder without a Ranked mode

Written 2026-09-30. The owner: "get rid of the ranked mode. i think it's pointless; we can keep the ranked medals as like trophy
tiers / ranges, like in brawlstars, just for fun and achievements, but the main mode should just be a ladder mode where you just get
trophies and such. so no more ranked mode, as that'll just confuse things ... on profiles and stats, try to remake things clearly a
bit ... the ranked gamemode itself should be removed and folded in to normal stream of games to make things simpler."

This file is the spec for that change. docs/RANKED.md and docs/RANK8.md are history (superseded banners at their top); where they
disagree with this file, this file wins. Line numbers below were verified on main `ecc92ed` (2026-09-30).

## 0. Vocabulary (unchanged trap)

`ranked` in match_log / abuse / stats / the `profile` message / profile.js means **counted toward stats**. It stays. The MODE
(`rk` on the wire and in game.js/main.js, `opts.rk`, `ws.rk`, `RK_*`, the `ladder` mode of match_log) is what goes away. The
numbers are "trophies"; "tier" is the rank index 1..8; "div" the division 1..3. Player copy says "trophies", "rank", "counted".

## 1. What stays (the ladder)

- `server/ladder.js`: the whole table (Bronze 0, Silver 150, Gold 300, Platinum 450, Diamond 600, Master 750, Champion 900, Pro
  1050; three divisions of 50 below Pro; Pro has none), `tierOf`, `divOf`, `hasDivs`, `romanOf`, `rankName`, floors, `applyFloor`
  (Bronze..Platinum are kept for good; Diamond and above can drop, never below 450), `humanDelta`, `halveWin`, `mattDelta`,
  `mattLevel`, `mattAward`, `MATT_CEILING` 899. `TIERS[].matt` is now "the lowest Matt level a win pays at for this rank".
  `test/ladder.test.mjs` stays green as is.
- `server/db.js`: the `ladder` table, migration 2, RECOMPUTE in `extra()`, `ladderApply` (`seriesId` is always null from now
  on; `logId` + `side` write `delta_a`/`delta_b` on the game's own match_log row), `ladderOf`, `ladderTier`, BOARDS, leaderboard,
  `leaderPlaces`, the merge fold, `cfg.mattDay` (env `MATT_DAY`, default 40; keep reading `RK_MATT_DAY` as a fallback for one release
  is NOT needed: nothing sets it in fly.toml). A ladder row exists only for a player who has been paid or charged at least once, so
  "rank null" still means "no trophies yet" (leaderboard.test.mjs:97 stays).
- `web/emblems.js`, the sprite, `.rank-em` sizes, `rankBadge`/`rankEmblem`/`rankCrest`, the Ranks page (`/ranks`, `#lobby-ranks`,
  `drawRanks`, `proLabel`), the leaderboard (trophies board, Pro #N), the share card (`PRO #N`), the profile card's rank + trophies,
  friends' rank on the friends list, emblems on the tournament VS card and brackets, `ui.trophyRow` / `rankUp` / `trophyCard` /
  `RK_WHY` (rename the RK-named things to trophy-named things; keep the behaviour), the `#trophy` row on the result card.
- `admin.js reset-stats` still clears the ladder.

## 2. What goes (the mode)

Everything the two maps list as mode-only. Server: the whole Ranked block in game.js (keep `envNum`, move it up), `SERIES`,
`gameWon`, `between`, `rkgo`/`rkgame`/`rkvs`/`rkres`/`rkend`/`rkfail`/`rk`/`rkleave`/`rkwarm` messages, `RK_MSGS`, the hold and
stall caps (`HOLD_MAX`, `me.holds`, `heldMs`, `stallMs`), `mp`, `canHold` (tournaments keep an unbounded hold as they do today),
`joinfail inrk`, `ask why 'rk'`, `botRequest reason 'ranked'`, `venue: 'stadium'`, `/status.json.rk`, the lobby message's `rk`,
`/ranked` in MENU_PATHS (301 it to `/ranks`), the `?rk=1` socket path, presence `queue`/`ranked` (socialSt, api.js ST_W,
social.js ST), PAD_FX `found`/`game`/`series`, `rkSignin`/`RK_GUESTS`, `opts.rk` everywhere (`MATCH && !opts.rk` becomes
`MATCH`). Client: the Ranked tile, `#lobby-ranked`, `#rk-search`, `#rk-pill`, `#series`, `#result-pips`, `#tally-games`,
`#rk-acts`, `#vs-ready`/`#vs-bar`/`#vs-me-em`/`#vs-them-em`, `#screen-rk-game`, every `rk*` function and state var in ui.js and
main.js, `VIEW_PATH.ranked`, `venueSync`/`setVenue` and the stadium venue (scene.js VENUE.stadium, scenery/stadium.js,
PAL_STADIUM/LIGHT_STADIUM/VENUES, `body[data-venue]` CSS, test/venue-shots.mjs), `gameBanner`, `setSeries`, `setPressure`, the
`gp`/`mp` readers, `RK_NAMES`, the mode-only CSS blocks. Tests: `test/ranked.test.mjs`, `test/ranked-e2e.mjs`,
`test/rksignin.test.mjs` are deleted; deploy.sh's list swaps `ranked.test.mjs` for `trophies.test.mjs`.

An old tab (pre-deploy client) may still send `rk`, `rkleave`, `rkwarm` or connect with `?rk=1`: the server must ignore them
without logging or crashing (the unknown-type path), never answer with a mode message.

## 3. How trophies are earned now (server)

One hook, in `record()` (game.js:521-530), after `stats.onEnd` and before `tellProfiles`, for every kind of game
(`bot`, `human`, `tour`, `tourbot`) on every path that records (endMatch, forfeitHeld, answer, leave). It never runs twice for one
match (guard on the room, like `X.done`). Rules, in order:

1. **Eligibility** per seat: an owner that is a signed-in account WITH a username (the owner's decision 2026-09-29: "rank should
   be disabled for guest accounts"). Resolve the owner the way rkOwnerOf did (the account's owner row through the identity frozen at
   hello / sign-in, never a verdict's owner id). A guest or a no-username account: no ladder row is read or written, its
   `profile` message carries `trophies: { none: 'signin' | 'username' }`.
2. **Counted?** `r.ranked` from `stats.onEnd` (abuse.judge). Not counted: `+0`, `trophies: { counted: false, why }` with the
   existing `WHY` words. Exception (the leaver rule, 4).
3. **Deltas.**
   - vs a person (`human`, `tour`): `humanDelta(me, them, won, false)` from both seats' trophies read at match START (freeze
     them on the room in `startMatch`, like `Q` did: a Matt bounty landing elsewhere mid-game never changes it). An opponent with no
     ladder row or not eligible counts as `them = me` (gap 0: +30 / -20). `new_opponent` on the game: the winner's delta is
     `halveWin` (the loser's is the plain loss).
   - vs Matt (`bot`, `tourbot`, the tournament warm-up too): a played-out counted WIN pays `mattDelta(tier at game start)`
     only when Matt's level is at or above `mattLevel(tier)` in difficulty order (wire 0 Rookie < 1 Club < 3 Tour < 2 Pro; the
     `easy` check rkMatt had), through `ladderApply({ vsBot: true })`, which applies the day cap (`cfg.mattDay`) and the 899
     ceiling. A loss, a leave, a drop: 0, and the card says which limit stopped a win from paying (`day`, `ceiling`, `easy`).
4. **Leaving a person game** after the first strike (`leave`, Q Q, a drop past the hold, `forfeitHeld`): the leaver pays the full
   loss delta whatever the verdict; the stayer takes the win delta only when the game's flags hold nothing beyond the forfeit's own
   (`early_forfeit`, `leaver_ahead`, `afk`, `too_fast`: the RK_CUT set), else `+0` with `why: ['left_early']`. Before the first
   strike: nothing (void, no message about trophies). Leaving a Matt game: 0.
5. **Floors** (`applyFloor`), then tier/div re-derived (ladderApply does this). `wins/losses/streak/best_streak` on the ladder row
   now count person games that moved trophies; `bot_wins/bot_losses` the Matt games that were eligible.
6. **Tell**: fold the result into each seat's `profile` message (`r.msgs[i].trophies = { delta, trophies, tier, div, tierWas,
   divWas, floorHeld, counted, saved, why, matt: bool, limit }`), the same fields `ui.trophyRow` already draws. No separate
   message type. `saved: false` when the db is off (`Couldn't save trophies right now`).
7. **Log**: `[CODE] match recorded: human ranked (+30/-20)`: codes and numbers only, never names.
8. `stats.newMatch` mode: `'ladder'` when at least one seat is eligible at start, else `'casual'`; `series` always null. The
   export's `mode` / `trophyDelta` keep working.
9. Emblems: `ranks()` / `seatTier` are set for every seat that has a ladder row, on every court (join():796 no longer gated on
   `ws.rk`): opponents and spectators see the emblem (tier + div only) on the scoreboard, result card, tournament VS card,
   brackets, view chip. Read the tier at join from `db.ladderTier(owner)`; refresh it after the hook so the next game shows the
   new rank. Two people on one network (NOTES 153) are unchanged.

Edge cases to handle and to name in the NOTES section: guest vs guest (nothing), guest vs account (only the account moves, gap
0), account without username, sign-in mid-match (the identity frozen at hello decides; a sign-in after the first strike does not
earn), reload mid-match (`revived` flag: not counted, 0), server restart mid-match (revive, same), two tabs of one person
(`same_*` flags: not counted), a tournament's Matt filler games, a phone paddle (no seat, nothing), watchers (see emblems only),
the day cap and the ceiling on Matt, a deleted account mid-match (`saved: false`), db off (`saved: false`), old clients after
deploy.

## 4. Client

- **Result card** (`matchResult`, ui.js:218-259) for every game: after `trophyReset`, when the `profile` message brings
  `trophies`, draw `ui.trophyRow(t)` (count-up, +N pill, rank-up / division-up kicker, `rankUp()` ceremony and jingle) exactly as
  the series card did; when it brings `none`, one quiet line in the trophy row's place: `Sign in to earn trophies` /
  `Pick a username to earn trophies` (a reply to what the player just did, not an announcement; no toast). `counted: false`: the
  existing WHY word line, no roll. Matt limits: `Matt pays trophies at Club or above for your rank` (easy), `Today's Matt trophies
  are all earned` (day), `Matt cannot take you past Master` (ceiling): plain, short, no cute copy. The `profile` message can arrive
  before or after `matchover`: park it like `rkRes` was parked (main.js:184, 413-422) and draw it once the `match` overlay is up.
  Check the card still fits at 1280x720 and 1366x600 (the `.result-card.is-rk` vertical budget, ui.css:1944-1948, becomes the
  ordinary card's when a trophy row is present: use a class like `.has-trophies`).
- **Home**: tiles are Friends, Quick play (heroes) + Courts, Play a bot, Your stats, Leaderboard. Signed in with the stats server:
  6 tiles = the existing `data-n="6"` layout. Signed out with the stats server: 5 tiles with ONE hero: add a `[data-n="5"]` rule
  where Quick play spans the full hero row and the four utilities sit in one row of four (portrait: hero full width, 2x2 under it;
  phone: unchanged one column). Remove the old two-hero n=5 rule. `tilesFit` unchanged. Arrow order = DOM order.
- **Your stats** (the hero at index.html:516-523): make it the one clear trophy view. Crest (links to Ranks), `Gold II`, the place
  (`#N on the leaderboard` when on it), `340 trophies`, a progress bar to the next division / rank with the line `10 to Gold III`
  (Pro: `Top rank`), then a compact trophy road (`#st-road`: the eight medals `is-md`, reached ones lit, the current one ringed,
  the rest dimmed, each titled with its floor; moved from the Ranked view's `#rk-road`), one line `Bronze to Platinum are yours to
  keep. Diamond and above can drop.`, and `Best: Platinum I` when the best is above the current. Before any trophies: crest dimmed,
  `No trophies yet`, `Win a game for your first trophies` (signed in) / `Sign in to earn trophies` (guest). (Since NOTES 158 the signed-in line is gone, the keep line under the bar is gone and the streak is the flame and its number alone: how ranks work is the Ranks page, opened by the crest or the (i) beside the rank.) Record lines stay as
  they are. Keep `rankCrest` and `drawRoad` names if convenient.
- **Ranks page**: copy becomes: `Win games to earn trophies. A win against a person is worth about 30, a loss costs about 20;
  a win against Matt at your rank's level or harder pays a few. Bronze to Platinum are never lost once reached.` `ranksFrom`
  defaults to `profile`; `lastRank` is set by `rankCrest` (with the place from `/api/stats`).
- **Profile card**: `Not ranked yet` becomes `No trophies yet`. Leaderboard: `Ranked Trophies` becomes `Trophies`, its empty
  line `Win a game for your first trophies`.
- **Friends** presence strings: drop `queue` and `ranked`. **Pad**: drop the three FX. **Scene**: park only.
- `/ranked` in `PATH_VIEW` goes; the server 301s it to `/ranks`.
- Meta descriptions (index.html 6/17/29/45, site.webmanifest:4): `climb the Ranked ladder` becomes `earn trophies and climb
  the ranks` (check `test/seo.test.mjs` for the exact strings it pins).

## 5. Copy, legal, docs (same commit)

- `web/privacy.html`, `web/terms.html`: every "Ranked mode" sentence becomes the truth above: trophies are earned in every
  counted game by signed-in players with a username; the rank emblem (tier and division only, never trophies or record) is shown
  beside your name to your opponent and anyone watching ANY court, on the scoreboard, result card, tournament VS card and bracket;
  the ladder row's fields (drop "series"; "Matt games while you wait" becomes "Matt games"); the device id is created at the first
  seat (no queue); no queue-per-network limit; presence strings without the two Ranked ones; the legal-basis row for the emblem:
  `contract` still (part of playing a court). Bump `Last updated` to September 30, 2026, ld+json `dateModified`, and
  `web/sitemap.xml` `<lastmod>`; append a dated line to privacy section 13. No contractions in legal text.
- `web/how-to-play.html`: the "Play Ranked" section becomes "Trophies and ranks" (the three copies, FAQ ld+json included).
- `web/changelog.html`: one new entry at the top (history entries untouched).
- `CLAUDE.md` data flows: the queue-per-computer line, the ladder table description, the VS card / Ranked courts emblem line, the
  presence statuses, the storage line (`poddle.device` "or Ranked queue entry"). `README.md:79`.
- `docs/`: this file is the spec; superseded banners on RANKED.md and RANK8.md; fix the mode sentences in ACCOUNTS.md,
  SOCIAL.md, SHARE.md, ui-spec.md, SCENERY.md. `NOTES.md` section 157 with the edge-case list and the decisions made without the
  owner (eligibility = signed in with a username; per-game humanDelta; Matt pays in every game at your rank's level or harder;
  the leaver rule; emblems on every court; the stadium removed).

## 6. Tests

- New `test/trophies.test.mjs` (server, one process, `AUTOBOT`-style like stats.test.mjs §21 was): two accounts with usernames
  play a game: `profile.trophies` +30 / -20, ladder rows, `delta_a/delta_b` on the row, export `mode: 'ladder'`, `trophyDelta`;
  a guest gets `none: 'signin'`; a username-less account `none: 'username'`; a Matt win pays `mattDelta` and the day cap (env
  `MATT_DAY=1`) and ceiling hold; a Matt win at an easy level pays 0 with `limit: 'easy'`; a leaver after the first strike pays
  the loss and the stayer wins; a leave before the first strike is silent; the rank emblem rides `welcome.rank` / `names.rank` on
  a plain court; old-client `rk` messages are ignored. Under 90 s.
- `test/stats.test.mjs` §21 is replaced by a pointer to trophies.test. Client tests (`menu.mjs`, `ui-next.mjs`,
  `profile-ui.mjs`, `lb-profile-ui.mjs`, `mobile-ui.mjs`, `social-ui.mjs`, `ui-mock.html`, `ui-shots/*`) lose their Ranked
  assertions and gain: 5-tile home signed out, 6-tile signed in, the Your stats road, the result card trophy row from a `profile`
  message. Pre-existing failures on main (menu.mjs 7-8, ui-next 7) are not ours: compare against main before blaming a change.
