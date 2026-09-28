> **As built (2026-09-28):** sections 1-3, 5 and 6 were built as written. Section 7's own Pro board was NOT: a parallel session
> shipped a global leaderboard first (NOTES 126: GET /api/leaderboard?b=trophies|rally|streak, accounts with a username only, a
> Show me switch, "Pro #N" = the trophies board place), and this work keeps that. The share card reads that place for "PRO #N".

# An eighth rank (Master), medals that evolve by division, and a numbered Pro leaderboard (NOTES 124)

The owner asked (2026-09-28): "add one more rank between diamond and champion ... update everything in the website accordingly
and the ranked system accordingly"; then "i wanted division evolutions" (the medal changes from I to II to III, not only a numeral)
and "pro will not have tiers, you'll be put on the leaderboard and given a number" (sections 6 and 7 below). The name **Master** is Claude's pick (the owner did not name it; the names were otherwise
fixed by the owner, docs/RANKED.md top, and "Olympic/Olympian" wording stays banned). It must be a one-place rename later:
keep the name in the two rank tables (server/ladder.js TIERS, web/emblems.js RANKS) and read it from there everywhere else.

## 1. The ladder (server/ladder.js TIERS, web/emblems.js RANKS + THRESHOLDS: test/ladder.test.mjs asserts they agree)

| tier | name | floor | sticky | Matt wire level while queued | mattWin |
|---|---|---|---|---|---|
| 1 | Bronze | 0 | yes | 0 Rookie | 10 |
| 2 | Silver | 150 | yes | 1 Club | 8 |
| 3 | Gold | 300 | yes | 1 Club | 7 |
| 4 | Platinum | 450 | yes | 3 Tour | 6 |
| 5 | Diamond | 600 | no | 3 Tour | 5 |
| 6 | **Master** (new) | 750 | no | 2 Pro | 4 |
| 7 | Champion | 900 | no | 2 Pro | 0 |
| 8 | Pro (top) | 1050 | no | 2 Pro | 0 |

- A rank stays 150 wide, three divisions of 50 (I, II, III), for Bronze..Champion. **Pro (1050+) has NO divisions** (section 7):
  its div is always 1 wherever a div is stored or sent, and it is never shown as I/II/III. STICKY_TOP stays 4.
- **Matt ceiling stays 899 trophies** (as today): Matt can carry a player to Master III at most; Champion and Pro are won
  against people only. So MATT_CEILING is no longer "top floor - 1": define it as the Champion floor - 1 (name it for that),
  and check every use (mattAward, the queue snapshot `matt.win`/`dayLeft`, the Ranks page / Ranked view copy about Matt).
- humanDelta, halveWin, the day cap, R-rules: unchanged.
- The top rank is still called Pro and is still the one with the laurel/crown art (web/emblems.js), whatever its tier number.
  Every check written as `tier === 7`, `tier >= 7`, `<= 7`, `1..7`, `TOP` must follow the table (8, or better `TIERS.length`
  / `RANKS.length`), in server AND client (web/main.js rankRef, web/ui.js, web/profile.js ladderOf/tierNum, server/card.js,
  server/game.js wire validation, api payload checks).

## 2. Existing players (the live database, Ranked launched 2026-09-27)

`ladder` rows store `tier`, `div`, `best_tier`, `best_div` next to `trophies` / `best_trophies`. With the new floors a
stored count maps to: < 750 the same tier; 750..899 was Champion (6), now Master (6); 900..1049 was Pro (7), now Champion (7);
1050+ Pro (8). Trophies are NEVER changed. Recompute tier/div from `trophies` and best_tier/best_div from `best_trophies`
for every row, idempotently, in server/db.js's existing `extra()` step (the additive, run-every-open step after the numbered
migrations; do NOT add a MIGRATIONS entry and do not touch migration 2). It must be one UPDATE (or a bounded batch) inside a
transaction, safe to run on every boot, and correct if run by an older build afterwards (it only rewrites derived columns).
Also check match_log's per-side trophy deltas and anything that stores a tier number (series state, rk messages) for 7s.
The admin tool (server/admin.js reset-stats etc.) must keep working.

## 3. The Master emblem (web/emblems.js SPRITE)

A new symbol in the sprite, in the style of the other seven (read the file: dark rim, gradient body, white ring, clipped
sheen, the pickleball in the middle in the rank's own tones — the owner: no neon yellow). Colour family: **ruby / crimson**
(between Diamond's sky-cyan and Champion's purple, distinct from Bronze's brown and Pro's rainbow), e.g. deep ~#9b1c3a, mid
~#ff6f8e. Shape: distinct from every other silhouette (shield, hexagon, octagon, gem, winged star, laurel crest): e.g. a
faceted crown-less crest, a star-in-circle, a ruby cut — the designer decides, then renders ALL eight at 150 px and at 24 px
(the xs pill size) and iterates until Master sits naturally between Diamond and Champion. Sprite ids: symbols are
`rank-<tier>` (renumber: Master becomes rank-6, Champion rank-7, Pro rank-8); gradient ids (g2..g8 etc.) are NOT tier numbers
— add new ones rather than renaming. Everything that builds ids from the tier (server/card.js emblems() parses the sprite by
`rank-N` and asserts RANKS.length === 7!) must follow.

## 4. Every surface (web)

Ranks page (the rkx cards road: now eight; check the layout at every size the tests use), Ranked view, the home Ranked tile,
Your stats hero (crest + "Master II"), VS card / MATCH FOUND, scoreboard pills (xs emblems), series result card / RANK UP beat
(rank colours), share card (server/card.js rank + emblem + INK/RANK_NAME fallbacks; re-render test/ui-shots/share/ incl. a
Master card), how-to-play (rank list), changelog (a dated entry), test/emblems.html, docs/RANKED.md (rank table and every
"seven"), CLAUDE.md data flows if it names the count, web/privacy.html + web/terms.html wherever they say "seven ranks" or list
them (formal register; bump Last updated / dateModified / sitemap lastmod if text changes). NOTES.md section 124.

## 5. Tests

test/ladder.test.mjs (table agreement, floors, Matt ceiling 899, tierOf/divOf across 0..1200), test/accounts-unit.test.mjs,
test/ranked.test.mjs (flaky under load on main: compare failures with origin/main before blaming), test/share.test.mjs +
share-shots, test/profile-ui.mjs, test/ui-shots/verify.mjs, test/menu.mjs / ui-next.mjs (known failures on main: ui-next's 4
settings/sound/tab/hostile-name checks x2 sizes, menu ~9). A unit test for the extra() recompute: rows seeded with old
tier numbers at 0, 760, 899, 950, 1100 come out as Bronze I, Master I, Master III, Champion II, Pro I; best_* likewise;
trophies unchanged; running it twice changes nothing.

## 6. Medals evolve by division (web/emblems.js owns this)

Bronze..Champion each get THREE versions of their medal, one per division, so ranking up a division is visible on the medal
itself (the owner: "i wanted division evolutions"). The same silhouette and palette per rank, growing in richness:
- **I**: the medal as it is today (base).
- **II**: adds a metallic trim / second rim in the rank's own metal and small ornaments (e.g. notches, rivets or side fins).
- **III**: adds gems or studs and a soft glow / rays behind it, so III looks one step from ranking up.
Each step must still read at 24 px (the xs pill): at that size at least the trim (II) and the glow (III) must be visible.
Keep the small I / II / III numeral tag as well (clarity), except for Pro (section 7).
Sprite ids: `rank-<tier>-<div>` for tiers 1..7 (div 1..3), `rank-8` for Pro. web/emblems.js exports
`emblemId(tier, div)` -> that id, and every existing helper there that draws an emblem (setEmblem, emblemCard, the badge
helpers, whatever ui.js calls) takes the division and picks the evolved symbol itself. Callers everywhere pass the division
they already have (most do: data-div). server/card.js parses the sprite: it must pick `rank-<tier>-<div>` / `rank-8` too.

## 7. Pro: no divisions, a numbered leaderboard

- Reaching Pro (1050 trophies) puts you on the **Pro leaderboard** and gives you a number: your position among ALL players now
  in Pro, by trophies (desc), ties by who reached their current best rank first (`best_tier_at` asc), then owner id. You leave
  the board when you drop below 1050 (Pro is not sticky). The label everywhere is **"Pro #N"** (share card: "PRO #N"); where
  N is not known yet (an old client, an error) just "Pro".
- server: a db function `proBoard(limit)` -> [{ pos, owner, name, trophies }] and `proPos(owner)` -> N | null (one indexed
  query; add an index on ladder(trophies) in extra() if needed — idempotent `CREATE INDEX IF NOT EXISTS`). name = the account's
  username, else "Poddle player" (guest names are never stored). profile.ladder gains `proPos` (null below Pro); the Ranked
  messages that carry a rank (rk snapshot `you`, rkvs `vs` and `you`, rkres) carry `pro` (N) for a Pro player; the /api/me
  ladder too if it has one.
- API: `GET /api/leaderboard` -> `{ top: [{ pos, name, trophies, you: bool }], you: { pos, trophies } | null, total }`, top 100,
  cached in memory ~30 s, rate-limited like the other GET routes, noindex, no owner ids or anything identifying beyond the name.
- UI: a **Pro leaderboard** section (on the Ranks page, reachable from the Ranked view): position, the Pro emblem, name (the
  DEV pill rule for the developer's username applies as elsewhere), trophies; your own row highlighted and, if you are in Pro
  but outside the top 100, shown pinned below; empty state "No one has reached Pro yet". Your stats hero, the Ranked view,
  the home Ranked tile, VS card, scoreboard pill tooltip/aria, RANK UP card ("Pro #N"), share card: all say "Pro #N".
- Divisions for Pro disappear everywhere: no numeral tag, no "division up" beat inside Pro, no "N to Pro II" progress; the
  progress bar in Pro shows the gap to the next position up (or "Top of the leaderboard" at #1) — the designer decides.
- Legal (CLAUDE.md "Legal pages": anything newly shown to other players): the leaderboard makes a Pro player's name
  (username or "Poddle player") and trophy count visible to every player. Update web/privacy.html (what is shown, to whom,
  that it follows from reaching Pro, how to leave it: dropping below Pro or deleting your data), web/terms.html (a short
  leaderboard clause), CLAUDE.md "Current data flows" (the "no leaderboards" wording), docs/ropa.md. Formal register; bump
  Last updated / dateModified / sitemap lastmod. A changelog entry covers the home-page notice promise.
- Tests: ladder (Pro has no divisions), accounts-unit (proBoard/proPos ordering and ties, leaving the board), an API test for
  /api/leaderboard (shape, top 100, you, no ids), profile-ui (the leaderboard section, Pro #N in the hero).
