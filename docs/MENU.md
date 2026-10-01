# Poddle main menu: one panel, Quick play on top, five flat rows

Written 2026-10-01 on branch `menu-rework` (main `3953ee1`). The owner: "i dont think the big buttons / the layout of them works
very nice anymore. would like to see something cleaner". Four prototypes were judged (rows 77, bar 71, launcher 69, twopane 54);
this file is the implementation spec for the winner, "rows", with the judges' grafts folded in. Prototype and shots:
`/private/tmp/claude-501/-Users-danieltan/cb7dbb06-a8a6-4282-92a9-f705ce8ddbbb/scratchpad/menu/protos/rows*.{html,png}`.
Line numbers below are ui.css / index.html / ui.js on `3953ee1`; the brief (same scratchpad, `brief.md`) has the full map.
Where docs/TROPHIES.md 4 ("Home", :116-119) disagrees with this file, this file wins.

## 0. The decision

The six glossy cards become ONE object: a 34rem panel (the `.panel-narrow` width) centred over the court, on the same axis as
the title's Play and every other lobby panel. Inside it, top to bottom:

1. For a guest, the name as the panel's top cap: a flat bar, caps label `NAME`, the field filling the bar with no border of its
   own. A signed-in player has no cap at all (the username is already the header's account button, NOTES 151; Change lives on
   Your stats).
2. Quick play as a full-width `.btn` pill, 5rem tall, the title's Play material (gradient, gloss cap, `.25rem --line` border):
   the ONE blue-bordered thing on the page.
3. Five flat rows, each an icon at one fixed size (2.5rem), a label, and a quiet grey status at the right end: Friends, Courts,
   Play a bot, Your stats, Leaderboard. 1px hairlines between them. No chevrons, no corner badges, no gloss, no inset rings.

Materials: the panel and the cap are `rgba(255,255,255,.9)` with a white hairline border and `--sh-1` (the name row's old
material, raised from .72/.78 so the kitchen's orange and the court's blue no longer band through the rows). The hovered or
focused row gets a sky tint; the focused row also gets the inset `--line` ring; the row's contents step `.25rem` right. The
request count stays the one coloured chip (orange, `#friends-n`). Nothing floats, nothing is announced, no new copy.

Grafts adopted from the judges (by source):
- launcher: panel and cap at .9 white (all three judges); the cap is one flat bar with a borderless field (judge 1, 3); the
  lit row steps right with the blue ring as one obvious state (judge 1, 3; done on the row's children so the panel's edges and
  the hairlines never move, which answers judge 2); friends status = social.js's real strings with the `.fr-dot` inline and the
  request chip in the row end (all three).
- bar: Quick play at the title's Play material and a size between (5rem, `.25rem` border, `--t-xl` label; judge 1, 2);
  `.tile-line:has(> span:last-child:empty){display:none}` so an empty Friends line leaves no gap (judge 3).
- twopane: first visit keeps the cap joined to the panel; only the field breathes (judge 2, 3). The one-line rank + trophies
  under Your stats for an account is NOT in this change (judge 1's "later"): see 13.
- the judges' own notes: no chevrons (judge 2, 3; judge 1 "or drop them"); `8 open` as quiet grey text so the primary's border
  is the only blue at rest (judge 2; judge 1 wanted a chip, judge 3 blue text: grey keeps one accent per row, the chip stays
  for requests only); hide the account's name row with a class set in `lockName()` rather than by changing `noName()` (judge 3).

Not changed: the header (Back, title, `N online`, the account button), the footer, the title screen (no CSS needed: the title's
`.btn-xl` and the panel's Quick play share `.btn`'s material already), every other lobby view and the name row's capsule look on
Courts / Create / Play a bot. Scope stays the lobby home.

## 1. Markup (web/index.html)

Replace `.tiles` and its six buttons (:331-352). Everything before it in `#lobby-home` (`#m-pad` :322-329, `h2.caps.m-only.m-more`
:330) and everything around it (header :304-308, `#lobby-down` :310, `#tour-ended` :313, `#name-row` :315, the courts panel
onward, the footer :536) stays byte for byte. The six SVGs are the current ones verbatim (the icon play, ui.css :645-680, keys
on the ids). `tile` stays on every entry as a bare marker (tilesFit, nameGate, the dim rules, every test count it); `is-hero`
stays on Quick play only.

```html
      <!-- The home list (docs/MENU.md): Quick play, the one primary, over five flat rows in one panel. DOM order = arrow order (ui.js, the [data-nav] ring).
           "tile" is a marker for ui.tilesFit / nameGate / the dim rules and the tests; the layout classes are hm-list, hm-primary, hm-row.
           Friends, Your stats and Leaderboard show only where the server keeps stats (web/profile.js drawAcct); a phone hides Quick play and Play a bot (.desk-only) -->
      <div class="tiles hm-list" data-fit>
        <button class="btn tile hm-primary is-hero desk-only" id="btn-quick" data-nav>
          <svg viewBox="0 0 96 96" aria-hidden="true"><circle class="art-fill" cx="48" cy="48" r="34" style="stroke-width:4.5"/><path class="art-accent-fill" d="M40 33 66 48 40 63Z"/></svg>
          <b>Quick play</b></button>
        <!-- Friends (docs/SOCIAL.md 6): its line says who is online (web/social.js entry), the chip counts requests -->
        <button class="tile hm-row" id="btn-friends" data-nav hidden>
          <svg viewBox="0 0 96 96" aria-hidden="true"><g class="art-fill" style="stroke-width:4.5"><path d="M47 80c1.5-15 10-22 22-22s20.5 7 22 22Z"/><circle cx="69" cy="40" r="12.5"/><path d="M5 82c2-18 12.5-26 27-26s25 8 27 26Z"/><circle cx="32" cy="35" r="15.5"/></g><path class="art-accent" d="M77 9v15M69.5 16.5h15" style="stroke-width:5.5"/></svg>
          <b>Friends</b><small class="tile-line" id="friends-line"><i class="fr-dot" id="friends-dot" hidden></i><span id="friends-line-text">Sign in to add friends</span></small><small class="tile-sub is-off" id="friends-n"></small></button>
        <button class="tile hm-row" id="btn-courts" data-nav>
          <svg viewBox="0 0 96 96" aria-hidden="true"><rect class="art-fill" x="12" y="18" width="58" height="60" rx="10" style="stroke-width:4.5"/><path class="art-line" d="M12 48h58M41 18v60" style="stroke-width:3"/><circle cx="63" cy="59" r="13" style="fill:#fff;stroke:var(--line);stroke-width:6.5"/><path class="art-accent" d="m73 69 11 11" style="stroke-width:7"/></svg>
          <b>Courts</b><small class="tile-sub is-off" id="courts-n"></small></button>
        <button class="tile hm-row desk-only" id="btn-bot" data-nav>
          <svg viewBox="0 0 96 96" aria-hidden="true"><g class="art-fill" style="stroke-width:4.5"><path d="M20 82c2-19 13-27 28-27s26 8 28 27Z"/><circle cx="48" cy="33" r="17"/></g><g class="art-accent" style="stroke-width:5"><path d="M41 34v3M55 34v3"/></g><path class="art-accent" d="M42 69h12" style="stroke-width:6"/></svg>
          <b>Play a bot</b></button>
        <button class="tile hm-row" id="btn-profile" data-nav hidden>
          <svg viewBox="0 0 96 96" aria-hidden="true"><g class="art-fill" style="stroke-width:4.5"><rect x="14" y="52" width="18" height="28" rx="5"/><rect x="39" y="34" width="18" height="46" rx="5"/><rect x="64" y="44" width="18" height="36" rx="5"/></g><path class="art-accent" d="m43 17 5 5 9-10" style="stroke-width:5.5"/></svg>
          <b>Your stats</b></button>
        <!-- Leaderboard (NOTES 126): the global boards. Shows where the server keeps stats, like Your stats -->
        <button class="tile hm-row" id="btn-leaderboard" data-nav hidden>
          <svg viewBox="0 0 96 96" aria-hidden="true"><g class="art-fill" style="stroke-width:4.5"><rect x="35" y="40" width="26" height="42" rx="4"/><rect x="10" y="56" width="25" height="26" rx="4"/><rect x="61" y="64" width="25" height="18" rx="4"/></g><path class="art-accent-fill" d="M48 10l4.1 7.6 8.5 1.5-6 6.2 1.2 8.5L48 30.1l-7.8 3.7 1.2-8.5-6-6.2 8.5-1.5Z"/></svg>
          <b>Leaderboard</b></button>
      </div>
```

What changed in the markup, and nothing else:
- `#btn-quick` moves before `#btn-friends` (DOM order = arrow order, ui.js :1022-1023; the primary must be the first thing in
  the column). NOTES 150's "Friends | Quick play" was the order of two equal heroes in a row; with one primary on top of a list
  the primary leads. The orchestrator should tell the owner this one order change.
- `is-hero` comes off Friends. `.tile-text` is gone: the label `<b>` and the status `<small>`s are direct children of the row
  (tests read `b.textContent` and `#friends-line-text`; social.js and the courts badge set text and `.is-off` only).
- New classes `hm-list` (on `.tiles`), `hm-primary`, `hm-row`. `data-fit` stays on `.tiles` (shoot.mjs / verify.mjs). `tilesFit`
  keeps writing `data-n`; no CSS reads it any more.
- The comment at :317-318 ("keyed on .tiles[data-n]") becomes the one above.
- `#name-row` (:315) is unchanged: `label[for=name-input]` "Name", `#name-input` maxlength 12, `#btn-name-change` hidden. On the
  home it is styled as the panel's cap by CSS (2.3); on Courts / Create / Play a bot it keeps the capsule (ui.css :582-590).

## 2. States

| state | what shows | how |
|---|---|---|
| guest, stats server (n=6 with accounts on, n=5 without Friends) | cap (NAME + field), Quick play, the rows | default |
| guest, no stats server (n=3: Quick play, Courts, Play a bot) | cap, Quick play, two rows | `#btn-profile/#btn-leaderboard/#btn-friends` keep `hidden` |
| desktop with stats but no db (n=4) | cap, Quick play, Courts, Play a bot, Your stats | as now |
| first visit (no name) | the cap is white, the field carries the blue ring + `--glow` and breathes; Quick play and the rows at opacity .5, still, `aria-disabled` on the seat-takers; a click on a dimmed entry nudges the cap and focuses the field | `#screen-lobby.needs-name` (ui.js nameGate :524-527, needName :528-531) |
| signed in (any count) | no cap; the panel starts with Quick play; the username is the header button | `#screen-lobby.is-acct` set in `lockName()` (6) |
| socket down | `#lobby-down` hangs from the header as now; Quick play and the rows at .5, still | `#screen-lobby.is-down` (:576) |
| tournament ended under you | the `#tour-ended` notice above the panel, both centred as one group | `#screen-lobby[data-view="home"] .tour-ended{margin-bottom:var(--s-5)}` |
| phone (html[data-mobile]) | the paddle card untouched, `ON THIS PHONE`, then the same list (n=4: Friends, Watch a match, Your stats, Leaderboard; n=3 without Friends) in the card's family of material, full width like the card | 5 |
| landscape phone | card left, list right (ui.css :2102-2104 kept) | 5 |

Counts need no layout rule any more: every count is one column. The old `.tiles[data-n="3|4|5|6"]` shapes, the 785px and 480px
tile breakpoints and the portrait tile grid all go (3).

## 3. CSS to delete (web/ui.css)

- :579 `#screen-lobby.needs-name .tile:hover,... .tile:focus-visible{transform:none;...} #screen-lobby.needs-name .tile::after{display:none}` (replaced in 4.6). Keep :576 and :578 as they are: `.tile` is still on every entry and opacity .5 is right for the primary and the rows.
- :606-620 the whole `.tiles` / `.tile` block: `.tiles{display:flex...}`, `.tile{...17rem x 14.5rem...}`, `.tile::before`, `.tile::after`, `.tile svg`, `.tile b`, `.tile:hover,.tile:focus-visible`, `.tile:focus-visible{transform...}`, the `@media (hover:hover){ .tile:hover...}` line, `.tile:active`, `.tile svg{transition:scale}`, the `.tile{animation:hm-tile...}` deal-in and its `:nth-child` delays.
- :621 `@media (max-width:480px){ #btn-quick{order:-1} }` and :622 the `.tiles[data-n="4"]` 2x2 rule. KEEP :623 `@keyframes hm-tile` (`.ranks-card` :1837 uses it).
- :624-632 the five-entry block (`.tiles[data-n="5"]...`), :633 `.tile-text`, :635 `.tile:not(.is-hero) .tile-text,...`, :636 the narrow n=5 rule, :637-644 the six-entry block. KEEP :634 `.tile-line{...}` (the row's status builds on it) and :645-680 (icon play) untouched, including :648 `.tile svg *{transform-box:view-box}` and :669.
- In `@media (max-aspect-ratio:1/1)` (:749): the thirteen tile lines :751-763 (`.tiles{display:grid...}` through `.tile svg{width:5.5rem}`). Keep :750 (`.menu-glass .menu-body{...}`) and :764 (`.name-row .field{width:14rem}`: the capsule on the other views).
- In `@media (max-width:480px)` (:1075): the `.tiles,.tiles[data-n="4"],...{grid-template-columns:1fr;width:100%}` line, the `.tile,.tiles[data-n="5"] .tile,...` line, the `.tiles[data-n="5"] .tile-text,...` line and the `.tiles .tile-sub,...{top:...;right:...}` line (:1076-1078, :1082). Keep the rest of the block.
- :988-990 `.tile-sub{position:absolute;...}` and its fade: replaced by 4.4. Keep `.tile-sub.pop{animation:num-pop ...}` (the last rule on :990) and :991. Delete :992 (`.tiles[data-n="5"] ... .tile-sub{top:...}`).
- :1302 the fragment `.tile-sub{font-size:max(var(--t-sm),12px);height:max(1.75rem,22px)}` inside `@media (max-width:700px)` (:1297, the Courts floors block; 4.4 carries its own 13px floor).
- :2097-2101 the phone tile grid (`html[data-mobile] .lobby-home .tiles{display:grid...}`, the two `.tile` lines, `.tile .tile-text`, the odd-count `#btn-courts` rule) and, inside the landscape block, :2105-2106 (the `height:8rem` / `6rem` tile rules). Keep :2102-2104 and :2107.
- :1981 `.tile-line .fr-dot{...}` stays. :1982 `#friends-n:not(.is-off){orange}` stays (it is the chip's colour).

## 4. CSS to add (web/ui.css, in place of :606-644)

All rem; px floors only where the 10px root would drop a target under 44px or text under 12px. Selectors are written to beat the
rules that stay (:567, :582-590, :748-750, :987, :2095-2096).

### 4.1 the panel and the home's stacking

```css
/* ===== THE HOME (docs/MENU.md): one panel. The name row is the panel's cap for a guest; Quick play is the one primary; five flat rows under it ===== */
.hm-list{display:flex;flex-direction:column;align-items:stretch;gap:0;width:min(34rem,92vw);padding:var(--s-3);border-radius:var(--r-lg);
  background:rgba(255,255,255,.9);border:.125rem solid rgba(255,255,255,.9);box-shadow:var(--sh-1)}      /* .9: the court's colour bands must not stripe the rows (the old .72 name row did) */
#screen-lobby[data-view="home"] .menu-body{justify-content:safe center;gap:0}      /* the cap and the panel centre as one group (the other views keep :567's flex-start) */
#screen-lobby[data-view="home"] .lobby-home{flex:none}
#screen-lobby[data-view="home"] .tour-ended{margin-bottom:var(--s-5)}      /* the ended-tournament notice sits over the panel, in the same group */
```

### 4.2 the cap (a guest's name row, home only)

```css
/* the cap: the name row restyled as the panel's flat top bar. Only on the home, only for a guest (.is-acct hides it: an account's username is the header button) */
#screen-lobby[data-view="home"]:not(.is-acct) .name-row{width:min(34rem,92vw);min-height:max(3.75rem,44px);padding:0 var(--s-3) 0 var(--s-5);gap:var(--s-4);
  border-radius:var(--r-lg) var(--r-lg) 0 0;border-bottom:0;background:rgba(255,255,255,.9);box-shadow:none;transition:background-color var(--d-fast) linear}
#screen-lobby[data-view="home"]:not(.is-acct) .name-row .field{flex:1;width:auto;height:auto;min-height:max(3rem,40px);padding:0 var(--s-3);border:0;border-radius:var(--r-md);
  background:none;box-shadow:none;font-size:max(var(--t-lg),16px);transition:box-shadow var(--d-fast) linear}      /* borderless: the bar is the field. 16px: iOS zooms on anything smaller */
#screen-lobby[data-view="home"]:not(.is-acct) .name-row:hover,#screen-lobby[data-view="home"]:not(.is-acct) .name-row:focus-within{background:#fff}
#screen-lobby[data-view="home"]:not(.is-acct) .name-row .field:focus{box-shadow:inset 0 0 0 .1875rem var(--line)}      /* the one blue ring, as a focused row has */
#screen-lobby[data-view="home"]:not(.is-acct) .name-row:not([hidden]) + .lobby-home .hm-list{border-radius:0 0 var(--r-lg) var(--r-lg);border-top:0;padding-top:0}      /* the panel joins the cap */
#screen-lobby[data-view="home"]:not(.is-acct) .name-row:not([hidden]) + .lobby-home .hm-primary{margin-top:var(--s-1)}
#screen-lobby.is-acct[data-view="home"] .name-row{display:none}      /* signed in: no cap. Change is on Your stats (#btn-pf-rename) */
/* first visit: the cap stays joined (no capsule floating off the panel); the field is the one thing to do and breathes until it is in use */
#screen-lobby.needs-name[data-view="home"] .name-row{background:#fff;border-color:rgba(255,255,255,.9)}      /* :589 would turn the bar's border blue; here the blue is the field's */
#screen-lobby.needs-name[data-view="home"] .name-row::after{display:none}      /* :590's pulsing halo on the capsule: off on the home */
#screen-lobby.needs-name[data-view="home"] .name-row .field:not(:focus){box-shadow:inset 0 0 0 .1875rem var(--line), var(--glow);animation:field-breathe var(--d-pulse) var(--ease-soft) infinite}
@keyframes field-breathe{50%{transform:scale(1.015)}}
```

### 4.3 the primary

```css
/* Quick play: a full-width .btn at the top of the panel, the title's Play material a size down (.btn-xl is 5.75rem / --t-2xl; this is 5rem / --t-xl with the same .25rem border) */
.hm-primary{width:100%;min-width:0;height:5rem;min-height:44px;padding:0 var(--s-5);margin:0 0 var(--s-3);border-width:.25rem;font-size:var(--t-xl);font-weight:800;letter-spacing:.04em;gap:var(--s-3)}
.hm-primary svg{width:2.5rem;height:2.5rem}      /* one icon size for the whole panel */
.hm-primary::after{inset:-.25rem}
@media (hover:hover){ .hm-list .btn:hover{scale:none} }      /* a full-width pill never grows past its panel: the halo (.btn::after, :148) says hover */
```

### 4.4 the rows

```css
/* a row: icon, label, the status at the right end. A flat list item: no border, no gloss, a hairline to the row above */
.hm-row{position:relative;display:flex;align-items:center;gap:var(--s-4);width:100%;min-height:max(4rem,44px);padding:0 var(--s-4) 0 var(--s-3);border:0;border-radius:var(--r-md);
  background:none;color:var(--ink-strong);font:800 var(--t-lg)/1.1 var(--font);letter-spacing:.02em;text-align:left;cursor:pointer;outline:0;-webkit-tap-highlight-color:transparent;
  transition:background-color var(--d-fast) linear, transform var(--d-fast) var(--ease-bounce), opacity var(--d-med) var(--ease-soft)}
.hm-row > *{transition:translate 220ms var(--ease-bounce)}      /* the lit row's contents step right; the row box, its tint and the hairlines stay put */
.hm-row svg{flex:none;width:2.5rem;height:2.5rem;transition:translate 220ms var(--ease-bounce), scale var(--d-fast) var(--ease-bounce)}
.hm-row > b{flex:1 1 auto;min-width:max-content;font-weight:800}      /* the label never clips; the status shrinks (ellipsis from :634) */
.hm-row + .hm-row::before{content:"";position:absolute;left:calc(2.5rem + var(--s-3) + var(--s-4));right:var(--s-4);top:-.5px;height:1px;background:rgba(85,94,103,.14);pointer-events:none}      /* 1px on purpose: a rem hairline bands at some roots */
/* the status, inline at the row end: Friends' line (dot + social.js's words), Courts' 'N open', Friends' request count. Quiet grey; the request chip is the one colour */
.hm-row .tile-line{flex:0 1 auto;min-width:0;font-size:max(var(--t-sm),13px);font-weight:700;color:var(--ink-soft);letter-spacing:0}
.hm-row .tile-line:has(> span:last-child:empty){display:none}      /* social.js's '' state (a reload before /api/me): no gap, no stray dot */
.hm-row .tile-sub{position:static;flex:none;height:auto;min-height:0;padding:0;border:0;background:none;color:var(--ink-soft);font-size:max(var(--t-sm),13px);font-weight:700;letter-spacing:0;font-variant-numeric:tabular-nums;white-space:nowrap;transition:none}
.hm-row .tile-sub.is-off{display:none}      /* an absent count takes no room (the old corner badge faded in place; nothing is to its right now, so nothing jumps) */
.hm-row #friends-n{display:inline-flex;align-items:center;height:max(1.5rem,20px);padding:0 .5rem;border-radius:var(--r-pill);border:.0625rem solid transparent;font-weight:800}      /* :1982 colours it orange when on; .pop (num-pop, :990) still bumps it */
```

### 4.5 hover, focus, press

```css
.hm-row:focus-visible{background:rgba(52,190,237,.10);box-shadow:inset 0 0 0 .1875rem var(--line)}      /* the keyboard ring: the one blue thing besides the primary's border */
.hm-row:focus-visible > *{translate:.25rem 0}
@media (hover:hover){ .hm-row:hover{background:rgba(52,190,237,.08)} .hm-row:hover > *{translate:.25rem 0} }
.hm-row:active{transform:scale(.985);background:rgba(52,190,237,.16);transition-duration:60ms} .hm-row:active svg{scale:.9}      /* the press goes in fast; the icon squashes under the thumb (as before) */
```

The icon animations need nothing: :653-667 key on `#btn-x:focus-visible` / `#btn-x:hover` and the SVG parts, not on `.tile`.

### 4.6 dimmed (first visit, socket down)

```css
/* :576 and :578 keep the .5 opacity on .tile (every entry). A dimmed entry shows no tint, ring, step or halo, and its icon holds still (:669) */
#screen-lobby.needs-name .hm-row:hover,#screen-lobby.needs-name .hm-row:focus-visible,#screen-lobby.is-down .hm-row:hover,#screen-lobby.is-down .hm-row:focus-visible{background:none;box-shadow:none}
#screen-lobby.needs-name .hm-row > *,#screen-lobby.is-down .hm-row > *{translate:none}
#screen-lobby.needs-name .hm-primary::after,#screen-lobby.is-down .hm-primary::after{display:none}
```

### 4.7 deal-in

```css
/* the primary first, then the rows top to bottom: transform and opacity only, backwards fill, nothing held (hover and focus still apply). The global reduced-motion rule (:501) covers it */
.hm-primary,.hm-row{animation:hm-row-in 420ms var(--ease-out) backwards}
.hm-list > :nth-child(2){animation-delay:50ms} .hm-list > :nth-child(3){animation-delay:100ms} .hm-list > :nth-child(4){animation-delay:150ms} .hm-list > :nth-child(5){animation-delay:200ms} .hm-list > :nth-child(6){animation-delay:250ms}
@keyframes hm-row-in{from{opacity:0;translate:0 .75rem}}
```

`#screen-lobby #lobby-home{animation:hm-fade}` (:570) stays: the container fades, the entries deal in. `.screen:not(.is-active) *{animation:none!important}`
(:106) restarts the deal-in on every entry to the lobby, as the tiles did.

## 5. The phone (html[data-mobile]), in place of :2097-2101 and :2105-2106

The paddle card and `ON THIS PHONE` are untouched. The list sits under them, as wide as the card, in the card's family of
material (white, a soft blue border, the card's radius), so the card and the list are one family rather than two panel types.

```css
html[data-mobile] #screen-lobby[data-view="home"] .lobby-home{flex:1}      /* the body scrolls from the top (:2095); the card and the list centre in it as before (:987) */
html[data-mobile] .lobby-home .hm-list{width:min(40rem,100%);padding:var(--s-2) var(--s-3);background:#fff;border:.1875rem solid var(--line-soft);border-radius:var(--r-xl);box-shadow:var(--sh-1)}
html[data-mobile] .hm-row{min-height:max(4.75rem,52px);gap:var(--s-3);font-size:max(var(--t-lg),17px)}
html[data-mobile] .hm-row svg{width:max(2.5rem,28px);height:max(2.5rem,28px)}
html[data-mobile] .hm-row + .hm-row::before{left:calc(max(2.5rem,28px) + var(--s-3) * 2)}
html[data-mobile] .m-more{margin-top:var(--s-3)}
```

The landscape block (:2102-2104) still works: `.lobby-home .tiles{grid-area:tiles;width:100%}` matches the same element. The
`:is([data-n="1"],[data-n="3"]) #btn-courts` odd-count rule goes: every row is full width. `#btn-quick` and `#btn-bot` are
`.desk-only` (:2075, `display:none!important`): the deal-in's `:nth-child` delays count them, so Friends starts at 50ms, fine.

Measured on the prototype at 390x844 (10px root): card 360x254 at y60, list 360x220 under `ON THIS PHONE`, rows 52px, status
13px, last row's bottom at 672 of 844, no scroll, 12px+ gutters (mobile-ui :74-75 hold). Landscape 844x390 was not shot: check
it once (mobile-ui :137-138: card left of the list, no sideways scroll).

## 6. JavaScript

- `web/ui.js lockName()` (:513-517): add `$('screen-lobby')?.classList.toggle('is-acct', !!lockedName);` before `nameGate()`.
  That is the whole JS change. The class drives 4.2's `display:none`; `lobbyView`'s `show('name-row', !noName(view))` (:768)
  and `noName` (:781) stay as they are, so the row still shows on Courts / Create / Play a bot for an account (locked, with
  Change) and `hidden` stays the mechanism on the phone's home. profile-ui :142 keeps passing: it reads `#name-input.readOnly`
  and `#btn-name-change.hidden`, which `lockName` still sets. A late `/api/me` (drawAcct after the home is drawn) needs no
  re-run of `lobbyView`: the class toggles and the cap goes.
- `firstFocus` (:782) never lands on the hidden cap: `playerName()` is the locked name for an account. `needName()` never
  fires for one. `viewFocus` (:792), `nameGate` (:524), `tilesFit` (:796), the arrow ring (:1022), `setMobile` (:43): unchanged.
  Update two comments: :796's "decides the layout, through .tiles[data-n]" (data-n is written for the tests only now) and
  :1021's "arrows walk the three tiles" (the list).
- `web/profile.js drawAcct()` (:555-565): unchanged, `show('btn-profile' | 'btn-leaderboard' | 'btn-friends')` and `h.tiles()`
  as now. `web/social.js entry()` (:218-223): unchanged (text, `.is-off`, `.pop`, the dot). The courts badge (ui.js :855): unchanged.

## 7. Focus order and the arrow ring

Arrow ring = visible `[data-nav]` in DOM order (ui.js :1022). Tab follows the same order.

- Desktop guest: name field (Enter or Down: Quick play, :970) > Quick play > Friends > Courts > Play a bot > Your stats >
  Leaderboard > wraps. No stats server: Quick play > Courts > Play a bot (menu.mjs :97 Right from Quick play = Courts; ui-next
  :136 two Rights = Play a bot). Signed out with stats (n=5, no Friends): Quick play > Courts > Play a bot > Your stats >
  Leaderboard (menu.mjs :157).
- Desktop account: Back, account button, Quick play, the rows (the cap is `display:none`, so it takes no Tab stop).
- Phone: Friends > Watch a match > Your stats > Leaderboard; entry focus Watch a match (`viewFocus`, mobile-ui :71).
- Entry focus on the home: Quick play (or the cap's field on a first visit). Enter on the lobby = Quick play (e2e :88).
- Focus is visible: the primary's `.btn::after` halo at .7; a row's inset ring + tint + the step; the cap's field's inset ring.

## 8. Motion and reduced motion

- Hover (hover:hover only): row tint `.08` sky, contents step `.25rem` right (translate, 220ms `--ease-bounce`); primary: halo
  only, no scale (4.3). Focus-visible: the same plus the inset ring. Press: row `scale(.985)` and the icon `.9`; primary
  `.btn:active` (:151). Icons: the existing once-on-focus / loop-on-hover play (:653-667).
- Deal-in: 420ms, 50ms steps, opacity + translate, backwards fill (4.7). First visit: the field breathes (`transform:scale`)
  with the `--glow` halo, stops in focus. Everything is transform or opacity; the hairline, tint, ring and halo are static
  box-shadow / background changes with the existing `--d-fast` linear transition, never animated shadows.
- Reduced motion: the global rule (:501-502) makes every animation 1ms, one iteration; no rule above relies on an animation
  end state (backwards fills, static box-shadows), so nothing is held or missing.

## 9. Fit budget (sum of rem heights)

The root font is `clamp(10px, min(1.1806vw, 1.8889vh), 26px)`: 17px at 1440x900, 13.6px at 1280x720, 11.33px at 1366x600 (height
bound), 10px at 600x900 and on a 390 phone. Header 5rem, footer 4.5rem, body padding `--s-5` x 2 = 3rem. Height bound, the body
is always 52.94rem - 9.5 - 3 = 40.4rem of usable space at 1440x900, 1280x720 and 1366x600 alike.

Guest, six entries (the tallest home):
- cap `max(3.75rem, 44px)` = 3.75rem (3.88 at 1366x600)
- Quick play 5rem + `--s-3` margin .75rem
- five rows x `max(4rem, 44px)` = 20rem
- panel padding-bottom `--s-3` .75rem, borders .25rem
- total 30.5rem (30.6 at 1366x600 = 347px): 9.9rem (112px) free at 1366x600 above the footer. With `#tour-ended` over it
  (about 7rem + 1.5rem margin) 39.1rem, still inside 40.4rem.
- Account, six: 27.25rem (padding-top .75 replaces the cap). Guest, three: 18.6rem. Phone list, four rows: 4 x 5.2rem + 1rem =
  21.8rem under the 25.4rem card.
- 600x900 (10px root): body 77.5rem usable, panel 30.5rem (44px floors), 340px wide; measured rows 44px, nothing clipped.
- Widths: `min(34rem, 92vw)` is 578px at 1440, 462 at 1280, 385 at 1366x600, 340 at 600x900 and 359 at a 390 desktop mock. The
  widest row at the 10px floor (Friends signed in: 17.5px padding + 25 icon + 10 + "Friends" ~60 + 10 + "3 online" ~55 + 10 +
  "1 request" chip ~75) is about 262px of 340: no label or status cut (social-ui :114-118 `cut` stays empty); a longer line
  ("Add your first friend", ~135px) still fits and would ellipsise before the label ever does.

Prototype measurements (17px root): panel 578x448 under a 70px cap, Quick play 77px, rows 68px; 1280x720 rows 54px; 1366x600
panel 385x298, 80px free; 600x900 rows 44px; every `[data-fit]` inside the viewport, no console errors. The 5rem primary and the
.9 material in this spec change those numbers by a few px only (the proto's primary was 4.5rem).

## 10. Player-facing strings (all existing; nothing new)

Labels: `Quick play`, `Friends`, `Courts` (a phone: `Watch a match`, ui.js :43), `Play a bot`, `Your stats`, `Leaderboard`.
Cap: `Name` (the label, uppercased by CSS), `Change` (never on the home now; still on Courts / Create / Play a bot for an account).
Header: `Play` / `Poddle`, `N online`, `Sign in` | `Pick a username` | the username. Phone: `On this phone`.
Statuses: `N open` (ui.js :855); Friends' line from social.js :220: `Sign in to add friends` | `Pick a username first` | `` |
`See who's online` | `Add your first friend` | `N online` | `Nobody online`; the chip `N request` / `N requests` (:222).
Footer: unchanged. No announcements, badges, hints or toasts (NOTES 147).

## 11. Tests and the mock (changes need the orchestrator's consent; all are mechanical)

- `test/menu.mjs` :152-154: `rows` becomes `'1,1,1,1,1'` in both orientations (labels `Quick play|Courts|Play a bot|Your stats|
  Leaderboard`, `n === '5'`, `heroes === 1`, focus `btn-quick` hold). :90, :97, :157, :173, :216 hold.
- `test/ui-next.mjs` :121-126 (`lobby-first`): "three across" (`new Set(r.tops).size === 1`) becomes three stacked rows
  (`new Set(r.tops).size === 3` and one shared `left`); keep `inside`, `sub === '8 open'`, `!list`, the dim and aria checks.
  :277-281: `lobby-five` rows `'1,1,1,1,1'`; `lobby-six` labels `'Quick play|Friends|Courts|Play a bot|Your stats|Leaderboard'`,
  `heroes === 1`, rows `'1,1,1,1,1,1'`. :42-43 (ids present / gone), :129-136 hold.
- `test/profile-ui.mjs` :142-143 holds (6); :157-161 holds (`'1,1,1,1,1'` is accepted at every size); :163-164 holds.
- `test/mobile-ui.mjs` :147-148: the desktop id order becomes `['btn-quick','btn-friends','btn-courts','btn-bot','btn-profile',
  'btn-leaderboard']`. :71, :74-75, :110-113, :137-138 hold.
- `test/social-ui.mjs` :104-105 holds (`n === '6'`, line, chip, dot); :114-118 holds (`'1,1,1,1,1,1'` accepted; `cut` empty, 9).
- `test/e2e.mjs` :88-89 holds. `test/ui-shots/verify.mjs` :170-179 holds (`#lobby-home .tile` still matches the six entries, all
  at least 44px both ways; `[data-fit]` inside); :80-82 holds (`.tile-sub` text 13px+; a `display:none` chip has no width and is
  skipped).
- `test/ui-mock.html`: add one state after `lobby-six` (:212): `'lobby-acct': () => { lobby(); six(); ui.lockName('Dan'); }`
  (the signed-in home: no cap, the panel starts with Quick play; the mock has no profile.js, so the header button stays hidden
  and the Friends line is the static text), and `'lobby-acct'` in the mock's own `SCREENS` list (:65, the contact sheet). Add
  `'lobby-acct'` to `SCREENS` in `test/ui-shots/shoot.mjs` (:21, after `'lobby-six'`) and a row in docs/ui-spec.md's screen
  table (:219). `lobby-first` needs nothing: the mock empties the name.
- Shots to refresh: `test/ui-shots/lobby-*`, `next-lobby-*`, `menu-2-lobby-*`, `menu-11-home-five-*`, `mobile-home.png`,
  `mobile-land.png`, social-ui's `home-desktop` / `home-phone`.

## 12. Docs and notes to touch in the same commit

- docs/TROPHIES.md 4 "Home" (:116-119): replace the layout sentence with "the home is one panel, docs/MENU.md; Friends, Your
  stats and Leaderboard show where the server keeps stats, as before". docs/ACCOUNTS.md :1110 and docs/API-NEXT.md :239 are
  history (leave, or one-line pointers).
- NOTES.md: a new numbered section (the owner's words, the four candidates and the judges' totals, the decisions taken without
  the owner: Quick play before Friends; no cap for an account; chevrons and corner badges gone; `8 open` grey). Mention that
  150's "Friends | Quick play" row order is superseded.
- web/index.html comments (1). ui.css comments at :567 (the name row "sits at the same spot on every view": still true for the
  other views; on the home it is the cap) and :987.
- Legal pages: nothing changes in data, storage or what is shown to others; no edit, no date bump.

## 13. Edge cases to check before shipping (NOTES rule: list them first)

1. Guest, first visit: the cap is white, the field ringed and breathing, Quick play and the rows at .5 and still; typing one
   letter lifts the dim (nameGate on input); Enter goes to Quick play; a click on a dimmed row nudges the cap (`.is-error` on the
   row box, `nudge` is translate-only) and focuses the field; nothing is sent (ui-next :129-130, menu :216).
2. Guest, returning: the cap shows the saved name flat; hover lightens the bar; focus rings the field; Esc / blur commits
   (ui.js :608-610 behaviour unchanged).
3. Sign in on the home: `/api/me` answers after the home is drawn; `lockName(name)` sets `.is-acct`, the cap disappears and the
   panel regains its top radius and padding in one frame (no transition on the join: a snap, like the Friends row arriving in the
   same answer). Sign out (`lockName(null)`): the cap comes back, `is-acct` off. The two joins never animate.
4. An account on Courts / Create / Play a bot still sees the locked capsule with Change above the panel (the home-only selectors
   do not match there). The phone's home has no row at all (hidden by `lobbyView`); Watch a match's Courts shows it (mobile-ui :110).
5. Reload on `/stats`, `/friends`, `/leaderboard`: those views have no name row (NO_NAME); Back to the home draws the cap or not
   by `.is-acct`, and the deal-in replays (:106).
6. The socket down: `#lobby-down` hangs from the header (absolute, :560), the panel dims (.5) and takes no hover state; the cap
   stays live (a name can still be typed).
7. Tournament ended: the gold notice above the panel, both centred; OK hides it and refocuses Quick play (:1267). At 1366x600 the
   pair is 39.1rem of 40.4rem: nothing scrolls.
8. Counts: 3 (localhost), 4 (stats, no db), 5 (stats, signed out), 6 (accounts on) on a computer; 3 and 4 on a phone. One column
   every time; `data-n` still written. Friends arriving late (me.db) adds a row under Quick play with no reflow of the rest.
9. The Friends line: `''` (a reload before `/api/me`) hides the line; `Nobody online` / `N online` with the green dot; the orange
   chip pops on a new request (`num-pop` is a transform). Courts: `8 open` appears when the first room list arrives (display,
   no fade); `.pop` on a change.
10. Keyboard only: Tab from the header lands on Quick play (guest: the field first); the ring is unmistakable; arrows wrap; Esc
    is Back (title). A screen reader reads each row as "Friends, 3 online, 1 request, button" through the row's text; the
    status `small`s carry no new aria.
11. Sizes: 1440x900, 1280x720, 1366x600, 600x900 (portrait: the panel is 340px, rows 44px), 390x844 as a desktop mock (359px
    panel) and as the phone (5); 1920x1080 (root 20.4px: panel 694px, rows 82px, still one object); a 844x390 phone on its
    side (card left, list right, the list scrolls with the body if it must).
12. `prefers-reduced-motion`: the deal-in and the breathe collapse to 1ms; the first-visit ring and glow are static and still show.

## 14. Later, not in this change

- One line under Your stats for an account (`Silver II, 120 trophies`, from profile.js rankCrest), empty for a guest, so there
  is never a second "Sign in to ..." line (twopane's one good idea, judge 1's graft "later").
- The header's `Play` title says little now that the panel is the whole view; the owner may want `Poddle` there as on the phone.
  Not touched: menu.mjs :89 and mobile-ui :148 pin `Play`.
