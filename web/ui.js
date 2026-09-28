// Poddle UI: every bit of DOM work for the HUD and the screens lives here. No game logic, no sockets, no three.js.
// Design system: ui.css · markup: index.html · spec, copy and this API: docs/ui-spec.md
const $ = id => document.getElementById(id);
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const restart = (el, cls) => { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); };   // replay a one-shot CSS animation
const setText = (el, t) => { if (el && el.textContent !== t) el.textContent = t; };       // names arrive here: textContent only, never markup
const swapText = (el, t, cls) => { if (!el || el.textContent === t) return false; el.textContent = t; if (cls) restart(el, cls); return true; };      // setText that replays a one-shot (cls) when the words really change
{ const ONE = { 'lob-row-in': 'lob-in', 'num-pop': 'lob-pop', 'lob-fill': 'lob-fill', 'lob-clear': 'lob-clear', 'lob-swap': 'lob-swap', nudge: 'lob-nope' };      // one-shot class <- its animation: back to rest when it ends (or a hidden screen cancels it), so nothing replays when it shows again
  const done = e => { const c = ONE[e.animationName]; if (c && e.target.classList?.contains(c) && (e.type === 'animationend' || e.target.closest?.('.screen:not(.is-active)'))) e.target.classList.remove(c); };      // a cancel from restart() itself must not strip the replay it just started
  document.addEventListener('animationend', done); document.addEventListener('animationcancel', done); }
{ const OV = { 'num-pop': 'ov-pop', 'ov-tick-up': 'ov-up', 'ov-tick-down': 'ov-down', nudge: 'ov-nudge', 'ov-recentre': 'ov-spin', 'ov-shine-l': 'ov-scored', 'ov-shine-r': 'ov-scored', 'ov-bump': 'ov-bump', 'ov-emote-sent': 'ov-sent', 'ov-key-press': 'ov-press', 'ov-note-in': 'ov-note', 'rk-pill-in': 'ov-pill', 'rank-pop': 'is-pop', 'chip-in': 'chip-in' };      // rank-pop: an emblem's ceremony (docs/RANKED.md 8.10; rank-down is not here: its shrunk emblem is the resting state until the next result clears it); chip-in: the series pips redrawn      // the settings / HUD one-shots (ov-*): the class may sit on a parent of what moves (Recentre's svg, an emote's img)
  const done = e => { const c = OV[e.animationName], el = c && e.target.closest?.('.' + c); if (el && (e.type === 'animationend' || !el.getClientRects().length)) el.classList.remove(c); };      // a cancel: only when its card or the HUD was hidden mid-way (restart() itself cancels too)
  document.addEventListener('animationend', done); document.addEventListener('animationcancel', done); }
const on2 = (id, type, fn) => { const el = $(id); if (el) el.addEventListener(type, fn); };      // every new element is optional (older markup, a test page)
import { RANKS, THRESHOLDS, DIV_W, divOf, hasDivs, romanOf, rankLabel, emblemEl, setEmblem, emblemCard, installSprite } from './emblems.js';      // the rank emblems (docs/RANKED.md 6): one sprite at the start of <body>, drawn here and nowhere else
installSprite();

// Shot names for the hit callout. Add new kinds here; an unknown kind falls back to its own name, capitalised.
export const SHOTS = { dink: 'Dink', lob: 'Lob', tap: 'Tap', drive: 'Drive', smash: 'Smash', block: 'Block' };
export const shotName = kind => !kind ? '' : SHOTS[kind] || String(kind).replace(/[_-]+/g, ' ').replace(/^./, c => c.toUpperCase());

// ---------- screens ----------
// Two independent slots. Menu screens (title and lobby on glass over the live court; connect and calibrate opaque) cover everything; overlays (match, server-down,
// game-full) sit over the court, under any menu screen (ui.css lifts game-full above them: that one cannot wait). The HUD leaves the render tree under a menu screen.
const MENU = ['title', 'lobby', 'camera', 'connect', 'calibrate'], OVERLAY = ['match', 'server-down', 'game-full', 'tour-vs', 'rk-vs', 'rk-game'];      // tour-vs: a tournament's VS card, before a match. rk-vs: Ranked's MATCH FOUND on the same markup; rk-game: the card between the games of a series (docs/RANKED.md 8.3, 8.7)
const ALIAS = { 'rk-vs': 'tour-vs' }, canon = name => ALIAS[name] || name;      // two overlay names on one section: body[data-overlay] tells them apart for the CSS
const screenEl = name => document.querySelector(`.screen[data-screen="${canon(name)}"]`);
const slots = { menu: null, overlay: null }, hideT = {};
function swap(slot, name) {
  const prev = slots[slot];
  if (prev !== name) {
    slots[slot] = name;
    if (prev) { const el = screenEl(prev); el.classList.remove('is-active'); clearTimeout(hideT[canon(prev)]); hideT[canon(prev)] = setTimeout(() => { el.hidden = true; }, 360); }   // after the fade: out of the render tree
    if (name === 'lobby') { const l = screenEl('lobby'); delete l.dataset.dir; delete l.dataset.live; }      // entering the lobby: its first view rises, it does not slide
    if (name) { const el = screenEl(name); clearTimeout(hideT[canon(name)]); el.hidden = false; void el.offsetWidth; el.classList.add('is-active'); }
  }
  const b = document.body, hud = $('hud');
  b.dataset.screen = slots.menu || 'hud';
  if (slots.overlay) b.dataset.overlay = slots.overlay; else delete b.dataset.overlay;
  if (slots.menu || slots.overlay) { settings(false); tourCard(false); }             // the cards belong to the open court. (Closing fires their callback: a pause must not outlive the panel)
  if (slots.menu !== 'lobby') askWatch(null);
  if (slots.overlay === 'match') hold(null); else stopCount();                        // the result replaces the hold card; leaving the result stops its countdown
  if (slots.overlay !== 'rk-game') gameStop(); if (slots.overlay !== 'rk-vs') vsStop();      // the Ranked cards' own clocks stop with them
  clearTimeout(hideT.hud);
  if (slots.menu) { if (!hud.hidden) hideT.hud = setTimeout(() => { hud.hidden = true; }, 360); }
  else if (hud.hidden) { hud.hidden = false; wake(); }
}
export function showScreen(name) { swap('menu', MENU.includes(name) ? name : null); }
export function showOverlay(name) { swap('overlay', OVERLAY.includes(name) ? name : null); }
export const currentScreen = () => slots.menu;
export const currentOverlay = () => slots.overlay;

// ---------- scoreboard ----------
export function setNames({ me, meSub, them, themSub, reg, rank } = {}) {
  if (me != null) setText($('name-me'), me); if (meSub != null) setText($('sub-me'), meSub);
  if (them != null) setText($('name-them'), them); if (themSub != null) setText($('sub-them'), themSub);
  if (reg !== undefined) { const r = Array.isArray(reg) ? reg : []; regBadge($('name-me'), r[0] === true); regBadge($('name-them'), r[1] === true); }      // [left, right]: a registered username (docs/ACCOUNTS.md 7.5). Left out = unchanged
  if (rank !== undefined) { const r = Array.isArray(rank) ? rank : []; rankBadge($('name-me'), r[0]); rankBadge($('name-them'), r[1]); }      // [left, right]: { tier, div } in a Ranked court, null = no emblem (docs/RANKED.md 6). Left out = unchanged
}
// The registered-name badge: its own element BESIDE the name, never in the name's text, drawn as a pill with an SVG tick, so no
// name a guest can type reproduces it (docs/ACCOUNTS.md 7.5). Made and removed here: a guest's seat has no .reg-badge at all.
const DEV_NAMES = new Set(['dan']);      // usernames that carry the DEV badge and show in orange (unique and confusable-folded on the server, so only the owner's account has them)
export function regBadge(nameEl, on) {                   // on: a registered username sits there. Only the developer's gets a mark: a DEV pill beside the name, and the name in orange (NOTES 106)
  if (!nameEl) return; const dev = !!on && DEV_NAMES.has((nameEl.textContent || '').trim().toLowerCase()), next = nameEl.nextElementSibling, has = !!next && next.classList.contains('reg-badge');
  nameEl.classList.toggle('is-dev', dev);
  if (dev && !has) { const b = document.createElement('span'); b.className = 'reg-badge'; b.setAttribute('role', 'img'); b.setAttribute('aria-label', 'Developer'); b.title = 'Developer'; b.textContent = 'DEV'; nameEl.after(b); }
  else if (!dev && has) next.remove();
}
// The rank emblem beside a name (docs/RANKED.md 6): the same rule as the badge, its own element AFTER the .reg-badge if there is one, else after
// the name; never in the name's text. r = { tier: 1..7, div: 1..3 } shows that rank (aria-label / title carry 'Gold II'), null removes it.
// Beside a name only the emblem shows; from .is-md up the wrapper's data-div draws the division's roman numeral over the emblem (ui.css).
const tierOf = t => Number.isInteger(t) && t >= 1 && t <= RANKS.length ? t : 0;      // 1..8 since Master (NOTES 124)
const rankRef = r => { const o = r && typeof r === 'object' ? r : { tier: r, div: 1 }, tier = tierOf(o.tier); return tier ? { tier, div: o.div === 2 ? 2 : o.div === 3 ? 3 : 1 } : null; };      // a bare number still reads (division I)
// Your stats' crest wears the Ranked emblem (one rank per player, docs/RANKED.md 2): the emblem at .is-lg inside the crest, its division as the tag
export function rankCrest(crest, r) {
  if (!crest) return; r = rankRef(r) || { tier: 1, div: 1 }; lastRank = { tier: r.tier, div: r.div, best: Math.max(r.tier, lastRank && lastRank.best || 1) }; let w = crest.querySelector('.st-em');
  if (!w) { w = document.createElement('span'); w.className = 'st-em'; w.append(emblemEl(r.tier, 'is-lg', r.div)); crest.append(w); } else setEmblem(w.firstElementChild, r.tier, r.div);      // the division's own medal (NOTES 124)
  setDiv(w, r); w.style.setProperty('--rank-ink', RANKS[r.tier - 1].colour.deep); w.setAttribute('role', 'img'); w.setAttribute('aria-label', `Rank: ${rankLabel(r.tier, r.div)}`);
}
const setDiv = (el, r) => { if (hasDivs(r.tier)) el.dataset.div = String(r.div); else delete el.dataset.div; };      // Pro has no divisions (NOTES 126): no numeral pill on its emblem
export function rankBadge(nameEl, r, cls = 'is-xs') {
  if (!nameEl) return; r = rankRef(r);
  let after = nameEl; if (after.nextElementSibling && after.nextElementSibling.classList.contains('reg-badge')) after = after.nextElementSibling;
  const next = after.nextElementSibling, has = !!next && next.classList.contains('rank-badge');
  if (!r) { if (has) next.remove(); return; }
  const name = rankLabel(r.tier, r.div), label = `Rank: ${name}`, ink = RANKS[r.tier - 1].colour.deep;
  if (has) { if (next.title !== name) { setEmblem(next.firstElementChild, r.tier, r.div); next.setAttribute('aria-label', label); next.title = name; setDiv(next, r); next.style.setProperty('--rank-ink', ink); } return; }
  const b = document.createElement('span'); b.className = 'rank-badge'; b.setAttribute('role', 'img'); b.setAttribute('aria-label', label); b.title = name; setDiv(b, r); b.style.setProperty('--rank-ink', ink); b.append(emblemEl(r.tier, cls, r.div)); after.after(b);
}
export function setScore(me, them) {
  for (const [id, v] of [['sc-me', me], ['sc-them', them]]) { const el = $(id); if (el.textContent !== String(v)) { el.textContent = v; restart(el, 'pop'); if (+v > 0) { const t = el.closest('.score-tab'); if (t) restart(t, 'ov-scored'); } } }      // the tab that scored gets a sweep of its colour (not the 0-0 reset)
}
export function setServe(who) { $('sv-me').classList.toggle('on', who === 'me'); $('sv-them').classList.toggle('on', who === 'them'); }
export function setRally(n) { const el = $('rally'); if (el.textContent === String(n)) return; el.textContent = n; if (n > 0) restart(el, 'pop'); }

// ---------- events ----------
export function callout(kind, them = false) {              // only the shot's name, never praise
  const text = shotName(kind); if (!text) return;
  const el = $('callout'); el.textContent = text; el.dataset.text = text; el.classList.toggle('is-them', them); restart(el, 'go');
}
// won: true = mine, false = theirs, null = I am watching (then side says whose colour: 0 blue, 1 orange). "Their point" is only for a caller with no name.
export function pointBanner(won, name = '', side) {
  const b = $('banner'), mine = won === true, blue = won == null ? side !== 1 : mine; name = String(name || '') || (won == null ? (side === 1 ? 'Player 2' : 'Player 1') : '');
  $('banner-text').textContent = mine ? 'Your point' : name ? `${name} scores` : 'Their point';
  b.classList.remove('is-info'); b.classList.toggle('is-me', blue); b.classList.toggle('is-them', !blue); restart(b, 'show');
}
// A human took a seat: the same centre banner the points use says who, in the joiner's colour (a player's opponent is always the orange side).
export function joinBanner(name, them = true) {
  const b = $('banner'); if (!b) return; name = String(name || '');
  $('banner-text').textContent = name ? `${name} joined to play` : 'A player joined';
  b.classList.remove('is-info'); b.classList.toggle('is-me', !them); b.classList.toggle('is-them', !!them); restart(b, 'show');
}
// A Ranked series (docs/RANKED.md 8.4): 'Game 2 of 3' in the same pill, in the house cyan (neither side's colour); the server's 3-2-1 follows
export function gameBanner(text) {
  const b = $('banner'); if (!b) return; $('banner-text').textContent = String(text || ''); b.classList.remove('is-me', 'is-them'); b.classList.add('is-info'); restart(b, 'show');
}
// The count into a match: n = whole seconds left, 0 or null = gone. Each new number pops once (server/game.js 'countdown').
export function countdown(n) {
  const el = $('count'), b = $('count-n'); if (!el || !b) return;
  if (!n) { el.hidden = true; b.textContent = b.dataset.text = ''; return; }
  const t = String(n); el.hidden = false;
  if (b.textContent !== t) { b.textContent = b.dataset.text = t; restart(el, 'tick'); }
}
let toastT;
export function toast(text, ms = 1200) {
  const el = $('toast'), b = document.body, again = el.classList.contains('on') && el.textContent !== text; el.textContent = text; el.classList.add('on'); b.classList.add('has-toast');     // .has-toast: the key strip yields the bottom band
  if (again) restart(el, 'ov-bump');                                                   // new words in a toast that is already up: a small bump, not a silent swap
  clearTimeout(toastT); toastT = setTimeout(() => { el.classList.remove('on'); b.classList.remove('has-toast'); }, ms);
}
export function toastOff() { clearTimeout(toastT); $('toast').classList.remove('on'); document.body.classList.remove('has-toast'); }     // the screen it spoke about is gone
export function confettiOff() { for (const c of document.querySelectorAll('.confetti')) c.remove(); }      // the court it fell over is gone
export function confetti(colors, n = 46) {
  if (reduced() || slots.menu) return;                                               // nothing of a game shows over a menu
  const frag = document.createDocumentFragment(), made = [];
  for (let i = 0; i < n; i++) { const c = document.createElement('div'); c.className = 'confetti';
    c.style.left = Math.random() * 100 + 'vw'; c.style.background = colors[i % colors.length];
    c.style.setProperty('--dx', (Math.random() * 30 - 15) + 'vw'); c.style.setProperty('--rot', (Math.random() * 1400 - 700) + 'deg');
    c.style.animationDuration = 1.4 + Math.random() * 1.2 + 's'; c.style.animationDelay = Math.random() * 0.25 + 's';
    frag.appendChild(c); made.push(c); }
  const host = slots.overlay === 'match' || slots.overlay === 'rk-game' ? screenEl(slots.overlay) : document.body;       // on the result screen (or the game card): behind the card, never across the score
  host.insertBefore(frag, host.firstChild); setTimeout(() => made.forEach(c => c.remove()), 3200);
}
// o = { won, me, them, nameMe, nameThem, forfeit, role, vote }: me / them are the left and right scores, won = the left side won.
// The old positional call (won, me, them, name) still works and means a room with no vote: the next game starts by itself.
let resultRole = 'player', voted = false, votedYes = false, noCount = false, countT = 0, countLeft = 0, countTotal = 0;
let stampT = 0;                                                  // the VICTORY! beat's timer: the card waits for it (NOTES 130)
export function matchResult(o, me, them, name) {
  const legacy = o === null || typeof o !== 'object';                                   // the old positional call: it never carries stats
  if (legacy) o = { won: !!o, me, them, nameThem: name, vote: false };
  const T = o.tour && typeof o.tour === 'object' ? o.tour : null;      // a tournament match (docs/COURTS-TOURNEY.md 4.6 item 8): { round, next, gap }. No vote, one button: See bracket
  const RK = o.rk && typeof o.rk === 'object' ? o.rk : null, MATT = !!(RK && RK.matt), SERIES = !!(RK && !MATT);      // a Ranked court (docs/RANKED.md 8.2, 8.8): a warm-up game vs Matt { matt, next }, or the series card { games, bestOf, scores, done, gap } (games / scores from the left slot's side)
  const won = !!o.won, watching = o.role === 'spectator', nameMe = String(o.nameMe || 'You'), nameThem = String(o.nameThem || 'Opponent'), lost = !watching && !won, vote = !watching && o.vote !== false && !T && !RK;
  $('result').classList.toggle('is-lose', lost); $('result').classList.remove('is-champion'); show('result-road', false); show('champ-acts', false); show('tour-res', !!T);
  $('result').classList.toggle('is-rk', SERIES); resultRkReset();
  $('medal').className = 'medal ' + (lost ? 'is-silver' : 'is-gold');
  const winner = won ? nameMe : nameThem;
  $('result-title').textContent = SERIES ? (watching ? `${winner} wins the match` : won ? 'You win the match' : `${nameThem} wins the match`) : MATT ? (won ? 'You beat Matt' : 'Matt wins') : watching ? `${winner} wins` : won ? 'You win' : `${nameThem} wins`;
  setText($('result-note'), o.forfeit ? `${won ? nameThem : nameMe} left` : '');
  const games = SERIES && Array.isArray(RK.games) ? [RK.games[0] | 0, RK.games[1] | 0] : null, bestOf = SERIES ? Math.max(1, RK.bestOf | 0) || 3 : 0;
  const L = games ? games[0] : o.me ?? 0, R = games ? games[1] : o.them ?? 0;      // the series card tallies games; every other card the points
  $('tally-sc-me').textContent = L; $('tally-sc-them').textContent = R; setText($('tally-name-me'), nameMe); setText($('tally-name-them'), nameThem);
  $('tally-me').classList.toggle('is-winner', won); $('tally-them').classList.toggle('is-winner', !won);
  { const r = Array.isArray(o.reg) ? o.reg : []; regBadge($('tally-name-me'), r[0] === true); regBadge($('tally-name-them'), r[1] === true); }      // reg: [left, right], registered usernames (docs/ACCOUNTS.md 7.5)
  { const r = Array.isArray(o.rank) ? o.rank : []; rankBadge($('tally-name-me'), r[0], 'is-md'); rankBadge($('tally-name-them'), r[1], 'is-md'); }      // rank: [left, right], the tiers in a Ranked court (docs/RANKED.md 6); absent = none. .is-md: the emblem with its division tag beside each name
  if (games) {                                                                          // the final pips over the tally, the per-game scores under it
    const need = Math.ceil(bestOf / 2); drawPips($('result-pips-me'), need, games[0], -1); drawPips($('result-pips-them'), need, games[1], -1); $('result-pips')?.setAttribute('aria-label', `Games ${games[0]} to ${games[1]}`); show('result-pips', true);
    const sc = (Array.isArray(RK.scores) ? RK.scores : []).filter(x => Array.isArray(x)).map(x => `${x[0] | 0}-${x[1] | 0}`); setText($('tally-games'), sc.join(' · ')); show('tally-games', sc.length > 0);
    if (!o.forfeit) setText($('result-note'), `${games[0]}-${games[1]}`);
  }
  countWord = T ? 'Bracket in ' : SERIES ? 'Back in ' : MATT ? 'Next game in ' : '';
  resultRole = watching ? 'spectator' : 'player'; voted = votedYes = false; noCount = !!o.forfeit && !RK; stopCount();      // a forfeit leaves one thing to press (Leave): a bar ticking down beside it read as a rematch clock nobody could answer. The court still closes by itself countTotal = 0; votes = { mine: null, theirs: null, name: nameThem };
  show('rematch-btns', vote); show('rematch-count', false); show('rk-acts', SERIES && !watching);
  for (const id of ['btn-rematch', 'btn-leave', 'btn-rk-again', 'btn-rk-leave']) { const b = $(id); if (b) { b.disabled = false; b.classList.remove('is-pressed'); } }
  setText($('rematch-note'), T || RK ? '' : watching ? (o.forfeit ? '' : 'Waiting for a rematch') : vote ? '' : 'Rematch starting');
  if (T) { setText($('result-note'), watching ? '' : won ? (o.forfeit ? `Through: ${nameThem} left` : T.next ? `On to the ${String(T.next).slice(0, 24)}` : 'You won the final') : `Out in the ${String(T.round || 'tournament').slice(0, 24)}`); noCount = false; }      // the bar counts down to the bracket
  $('result-note').classList.toggle('is-quiet', SERIES && !o.forfeit);      // '2-1' is already the pips and the tally: read out, not drawn a third time. 'Priyanka left' stays in sight
  const card = $('result'); card.classList.toggle('is-forfeit', !!o.forfeit); card.classList.toggle('is-watch', watching); card.classList.toggle('is-them-won', watching && !won);      // a forfeit: nobody left to clap. is-them-won: a spectator's title takes the winner's colour
  $('screen-match').dataset.beat = watching ? (o.forfeit ? 'forfeit' : 'watch') : o.forfeit && won ? 'forfeit' : won ? 'win' : 'lose';      // one attribute drives every beat in ui.css; set before showOverlay so the CSS starts on activation
  { const st = $('result-slam'), scr = $('screen-match'); if (st) { st.textContent = won && !watching && !o.forfeit ? 'VICTORY!' : ''; st.classList.remove('is-rank'); st.classList.toggle('is-victory', !!st.textContent); if (st.textContent) restart(st, 'go'); }
    clearTimeout(stampT); const v = !!(st && st.textContent) && !matchMedia('(prefers-reduced-motion: reduce)').matches; scr?.classList.toggle('is-stamp', v); if (v) stampT = setTimeout(() => scr?.classList.remove('is-stamp'), 780); }      // the stamp on a win of your own only (NOTES 122), paced (NOTES 130): VICTORY! alone first, then the card's whole entrances
  $('tally-sc-me').style.setProperty('--to', L | 0); $('tally-sc-them').style.setProperty('--to', R | 0);      // the count-up is a CSS counter over the real number: textContent is final from the first frame (no stamp: NOTES 104)
  resultStats(!legacy && !o.forfeit && o.stats && typeof o.stats === 'object' ? o.stats : null, card);
  showOverlay('match');
  if (T) { if (T.gap > 0) rematch({ left: T.gap }); setTimeout(() => { if (slots.overlay === 'match') $('btn-see-bracket')?.focus({ preventScroll: true, focusVisible: true }); }, 60); }
  if (SERIES) { if (RK.gap > 0) rematch({ left: RK.gap }); if (!watching) setTimeout(() => { if (slots.overlay === 'match') $('btn-rk-again')?.focus({ preventScroll: true, focusVisible: true }); }, 60); }      // Back in 12: the court closes by itself. Play again has focus: one press queues again
  if (MATT && RK.next > 0) rematch({ left: RK.next });      // Next game in 6: the warm-up's next game starts by itself (rematchon closes this card)
  if (vote) setTimeout(() => { if (slots.overlay === 'match' && !voted) ($('btn-rematch')?.disabled ? $('btn-leave') : $('btn-rematch'))?.focus({ preventScroll: true, focusVisible: true }); }, 60);
}
// the Ranked rows of the card, back to nothing: the pips, the game scores, the trophy roll and its ceremony (matchResult and champion both start clean)
function resultRkReset() { show('result-pips', false); show('tally-games', false); show('rk-acts', false); trophyReset(); }
function trophyReset() {
  clearTimeout(upT); upT = 0; const t = $('trophy'); if (t) { t.hidden = true; t.classList.remove('is-roll'); }
  const em = $('trophy-em'); if (em) { em.querySelector('.medal-rays')?.remove(); em.querySelector('.rank-em')?.classList.remove('is-pop', 'is-down'); em.querySelector('.rank-card-em')?.classList.remove('is-flip'); em.classList.remove('is-up'); }
  { const k = $('rank-kicker'); if (k) { k.hidden = true; k.textContent = ''; } } $('result-flash')?.classList.remove('is-sweep');
  const n = $('result-note'), c = $('result'); n?.querySelector('.result-note-sub')?.remove(); n?.classList.toggle('is-quiet', !!c && c.classList.contains('is-rk') && !c.classList.contains('is-forfeit')); $('result-slam')?.classList.remove('is-rank');
}
// the emblem card in the trophy row: the rank's emblem at .is-lg, its name and division under it (emblems.js emblemCard), re-pointed in place on a change
function trophyCard(tier, div) {
  const em = $('trophy-em'); if (!em) return null; let c = em.querySelector('.rank-card-em');
  if (!c) { c = emblemCard(tier, 'is-lg', div); em.append(c); return c; }
  const R = RANKS[tier - 1]; setEmblem(c.querySelector('.rank-em'), tier, div); setText(c.querySelector('b'), rankLabel(tier, div)); setDiv(c, { tier, div }); c.style.setProperty('--rank-ink', R.colour.deep); c.style.setProperty('--rank-mid', R.colour.mid); c.hidden = false; return c;
}
// bestOf dots as a row of pips: won of them filled, the one at `now` pulsing (the game in play), the one at `fresh` popping (the game just won)
function drawPips(ol, n, won, now, fresh = -1) {
  if (!ol) return; ol.textContent = '';
  for (let i = 0; i < n; i++) { const li = mk('li', (i < won ? 'is-won' : '') + (i === now ? ' is-now' : '') + (i === fresh ? ' is-new' : '')); li.style.setProperty('--i', i); ol.append(li); }
}
// The stats pills under the tally ({ rally, smashes, run } from main.js, counted on this client). A stat under its floor stays out; the one furthest over its norm is starred.
function resultStats(S, card) {
  const ul = $('result-stats'); if (!ul) return; ul.textContent = '';
  const rows = !S ? [] : [['Longest rally', S.rally | 0, 4, 8], ['Smashes', S.smashes | 0, 1, 2], ['Best run', S.run | 0, 3, 4]].filter(r => r[1] >= r[2]);      // [label, n, min, norm]: a 2-hit rally or no smash is nothing to show off
  let best = null; for (const r of rows) if (!best || r[1] / r[3] > best[1] / best[3]) best = r;      // ties go to the first row
  rows.forEach((r, k) => { const li = mk('li', 'stat' + (r === best ? ' is-best' : '')); li.append(mk('b', '', String(r[1])), mk('span', '', r[0])); li.style.setProperty('--i', k); ul.append(li); });      // textContent only
  show('result-stats', rows.length > 0); card.classList.toggle('has-stats', rows.length > 0);
}
function stopCount() { clearInterval(countT); countT = 0; }
let countWord = '';      // a tournament match: 'Bracket in 6' (the vote's own count is a bare number beside its buttons)
function drawCount(n) { countLeft = n; { const l = $('rematch-left'), t = countWord + n; if (l && l.textContent !== t) { l.textContent = t; if (n !== countTotal) restart(l, 'ov-pop'); } }
  $('rematch-bar')?.style.setProperty('--p', (countTotal ? Math.min(1, n / countTotal) : 0).toFixed(3)); }      // each second hops (not the first)
function lockVote(yes) { voted = true; votedYes = yes; for (const [id, mine] of [['btn-rematch', yes], ['btn-leave', !yes], ['btn-rk-again', yes], ['btn-rk-leave', !yes]]) { const b = $(id); if (b) { b.disabled = mine || !yes; b.classList.toggle('is-pressed', mine); } } }      // after Rematch, Leave stays open: nobody is locked in for 20 s behind someone who walked off
let onVote = null;
export function onRematch(fn) { onVote = fn; }                                          // Rematch -> fn(true), Leave -> fn(false)
// { mine, theirs, left, name }: each vote true | false | null, a missing key = unchanged. The server only speaks when a vote changes, so the seconds tick here.
let votes = { mine: null, theirs: null, name: '' };
export function rematch(o = {}) {
  if ('mine' in o) { votes.mine = o.mine; if (o.mine === true || o.mine === false) lockVote(o.mine); }      // null never re-opens the buttons: my click may still be on its way
  if ('theirs' in o) { votes.theirs = o.theirs; const r = $('btn-rematch'); if (o.theirs === false && r && !voted) { const had = document.activeElement === r; r.disabled = true; if (had) $('btn-leave')?.focus({ preventScroll: true }); } }      // they left (a forfeit): there is nobody to play again, only Leave
  if (o.name != null) votes.name = String(o.name);
  if (typeof o.left === 'number' && isFinite(o.left)) { const n = Math.max(0, Math.round(o.left)); countTotal = Math.max(countTotal, n) || 1;       // the bar drains from the first number it was given
    stopCount(); show('rematch-count', !noCount); drawCount(n); countT = setInterval(() => { if (countLeft > 0) drawCount(countLeft - 1); else stopCount(); }, 1000); }
  if (resultRole === 'spectator') return;                                                // their note stays "Waiting for a rematch"
  // (after a forfeit the card already says "<name> left" under the title: not twice)
  if ('mine' in o || 'theirs' in o || o.name != null) { const who = votes.name || 'Opponent';
    swapText($('rematch-note'), votes.theirs === true ? `${who} wants a rematch` : votes.theirs === false ? ($('result-note')?.textContent ? '' : `${who} left`) : votes.mine === true ? `Waiting for ${who}` : '', 'ov-note'); }      // a new note slides up into place
}
// seat hold: a small card over the frozen court. main.js calls it once a second with the server's number; hold(null) hides it.
export function hold(name, left) {
  const el = $('hold'); if (!el) return;
  if (name == null || slots.overlay === 'match') { el.hidden = true; return; }
  setText($('hold-text'), `Waiting for ${name}`); { const b = $('hold-left'), t = left == null ? '' : String(Math.max(0, Math.round(left))); if (b && b.textContent !== t) { b.textContent = t; if (t && !el.hidden) restart(b, 'ov-pop'); } } el.hidden = false;      // each second hops once the card is up
}

// ---------- connection status ----------
// What is in the player's hand (NOTES 34): an AirPod through the helper on this Mac, or a phone through its page.
const PADDLE = {
  airpod: { name: 'AirPod', wait: 'Open Poddle Helper, then take one AirPod out and hold it.', bad: 'Signal lost. Check Poddle Helper is open and the AirPod is connected to this Mac.', lost: 'AirPod signal lost', hold: 'Hold the AirPod like a paddle handle, pointing at the screen.', tilt: 'Tip the front up toward the ceiling.', waiting: 'Waiting for the AirPod' },
  phone: { name: 'Phone', wait: 'Scan the code with your phone’s camera.', bad: 'Signal lost. Wake the phone and keep its Poddle page open.', lost: 'Phone signal lost', hold: 'Hold the phone like a paddle handle, edge up, top end pointing at the screen.', tilt: 'Tip the top end up toward the ceiling.', waiting: 'Waiting for the phone' },
};
let paddle = 'airpod';
export function setPaddle(kind) {
  if (!PADDLE[kind] || kind === paddle) return; paddle = kind; const P = PADDLE[kind];
  ROW.airpod.wait = P.wait; ROW.airpod.bad = P.bad; LOST.airpod = P.lost; LEAD.hold = P.hold; LEAD.tilt = P.tilt;
  setText($('row-airpod-name'), P.name); setText($('set-airpod-name'), P.name);
  $('calart')?.classList.toggle('is-phone', kind === 'phone');                                  // the calibration drawing: a phone in the fist, not a bud
  const tog = $('tog-airpod')?.querySelector('span'); setText(tog, kind === 'phone' ? 'Show phone' : 'Show AirPod');
  const v = status.airpod; if (v) { status.airpod = null; setStatus({ airpod: v }); }      // the row says its line again, in the new words
}
export const paddleKind = () => paddle;
// The set-up screen's phone block: the QR (drawn here, no image fetched), the code to type instead, and the footer's way over
// to the other paddle. o = { show, url, code, title, foot, choose, mode }.
let qrFor = '';
export function padPair(o) {
  const box = $('pad-pair'); if (!box) return;
  box.hidden = !o.show; helperCard(); setText($('connect-title'), o.title || '');
  const seg = $('paddle-seg'); if (seg) { seg.hidden = !o.choose; $('connect-title').hidden = !!o.choose;      // where a phone can pair, the switch is the heading
    for (const b of seg.querySelectorAll('[data-paddle]')) b.setAttribute('aria-checked', String(b.dataset.paddle === o.mode)); } setText($('pad-code'), o.code || ''); setText($('connect-foot-text'), o.foot || '');
  if (o.show && o.url && qrFor !== o.url) { qrFor = o.url;
    import('./vendor/qrcode.mjs').then(({ default: qrcode }) => {
      const q = qrcode(0, 'H'); q.addData(o.url); q.make();                   // 'H', not 'M': the phone in the middle covers modules, and only H's 30 % recovery reads through that (NOTES 67)
      $('pad-qr').innerHTML = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true }).replace('</svg>', phoneGlyph(q.getModuleCount() * 4) + '</svg>');
      const g = $('pad-qr').querySelector('svg'); if (g) g.setAttribute('aria-hidden', 'true');
    }).catch(() => { qrFor = ''; }); }
}
// The phone that sits in the middle of the pairing QR, so the code looks like what it is for. Sized from the REAL module
// count (the URL's length moves it), never a fixed number. 28 % of the width is ~8 % of the area: well inside H's budget.
function phoneGlyph(size) {
  const box = Math.round(size * 0.28), at = Math.round((size - box) / 2), pad = Math.round(box * 0.17), inner = box - pad * 2;
  return `<g><rect x="${at}" y="${at}" width="${box}" height="${box}" rx="${Math.round(box * 0.22)}" fill="#fff"/>`
    + `<svg x="${at + pad}" y="${at + pad}" width="${inner}" height="${inner}" viewBox="0 0 24 24" fill="none" stroke="#1b2a33" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">`
    + `<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M10.5 5.5h3"/><path d="M11 18.5h2"/></svg></g>`;      // the same phone as the paddle picker's chip
}
// The AirPod's block (NOTES 36): where the phone's code would be, Poddle Helper to download, until the AirPod answers.
// setPaddle has already been told which paddle it is, and a phone that scanned in makes it 'phone', so no word from main.js.
function helperCard() { const h = $('pad-helper'); if (h) h.hidden = paddle !== 'airpod' || !$('pad-pair')?.hidden || status.airpod === 'ok'; }
export function onPaddleSwap(fn) {                                                           // fn('phone' | 'airpod'): a press on the switch, or an arrow key inside it
  const seg = $('paddle-seg'); if (!seg) return;
  seg.addEventListener('click', e => { const b = e.target.closest('[data-paddle]'); if (!b) return; e.stopPropagation(); fn(b.dataset.paddle); });
  seg.addEventListener('keydown', e => { if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return; e.preventDefault(); e.stopPropagation();
    const on = seg.querySelector('[aria-checked="true"]'), other = [...seg.querySelectorAll('[data-paddle]')].find(b => b !== on); if (other) { other.focus(); fn(other.dataset.paddle); } });
}
const ROW = {
  airpod: { ok: '', wait: 'Open Poddle Helper, then take one AirPod out and hold it.', bad: 'Signal lost. Check Poddle Helper is open and the AirPod is connected to this Mac.' },
  game: { ok: '', wait: 'Connecting to the game', bad: 'Can’t reach the game. Trying again.' },
  camera: { ok: 'Stand where the camera can see you.', wait: 'Allow the camera so stepping moves you on court.', bad: 'No camera. The game moves you.', off: 'No camera. The game moves you.' },
};
const STATE_WORD = { ok: 'Ready', wait: 'Waiting', bad: 'Problem', off: 'Off' };
const LOST = { airpod: 'AirPod signal lost', game: 'Reconnecting to the game' };
const status = {}, badSince = {}, told = {};
export function setStatus(next) {
  const now = performance.now();
  for (const key in next) {
    const v = next[key]; if (!ROW[key] || !STATE_WORD[v]) continue;
    if (status[key] !== v) {
      status[key] = v; badSince[key] = v === 'bad' ? now : 0; told[key] = false;
      for (const el of [$('set-' + key), $('row-' + key)]) if (el) { el.classList.remove('is-ok', 'is-wait', 'is-bad', 'is-off'); el.classList.add('is-' + v); }      // the HUD lights are gone: big rows on the set-up screen, small rows in the settings panel
      setText($(`row-${key}-text`), ROW[key][v] || ''); setText($(`row-${key}-state`), STATE_WORD[v]); setText($(`set-${key}-state`), STATE_WORD[v]); { const c = $('set-' + key); if (c) c.title = `${c.querySelector('b')?.textContent || key}: ${STATE_WORD[v]}`; }      // the chip in the settings head says its state on hover
      if (setOpen) { const c = $('set-' + key); if (c) restart(c, 'ov-pop'); }      // with the card open, the chip that changed bounces once
      if (key === 'airpod') helperCard();
    }
    // a lost AirPod or server is the likeliest live failure: after 1.5 s say so where the player is looking, once
    if (LOST[key] && v === 'bad' && !told[key] && !slots.menu && !slots.overlay && now - badSince[key] > 1500) { told[key] = true; toast(LOST[key], 2600); }
  }
}
export function setLink(id, live) { setText($(id), live ? 'live' : 'off'); }          // #m / #g: 'live' | 'off' (tests read #g)
export function setServerAddress(text) { setText($('downurl'), String(text).replace(/wss?:\/\//g, '')); }      // people read 'localhost:8080', not a URL scheme

// ---------- calibration ----------
// e = the MotionModel 'cal' event { stage: 'hold'|'tilt', progress, ok, msg }. The big headline always says what to do NOW
// (it is the only thing read from two metres away), so it follows the event, not just the stage.
const HOLD_SECONDS = 5;
const LEAD = { hold: 'Hold the AirPod like a paddle handle, pointing at the screen.', tilt: 'Tip the front up toward the ceiling.', settle: 'Keep it there until the bar fills.', done: 'Done. Loading the court.' };
let calPrev = { ok: true, msg: '' }, badUntil = 0, badHead = '';
export function calibrationReset() {
  calPrev = { ok: true, msg: '' }; badUntil = 0;
  calibration({ stage: 'hold', progress: 0, ok: true, msg: '' }, { waiting: true });
}
export function calibration(e, { waiting = false, camLost = false } = {}) {
  const msg = e.msg || '', tilt = e.stage === 'tilt', settle = tilt && msg.startsWith('Good'), done = msg.startsWith('All set');
  let head = done ? 'All set' : settle ? 'Now hold it how you’ll play' : tilt ? (e.ok ? 'Tip it up' : 'Level out, then tip straight up') : (e.ok ? 'Hold still' : 'You moved. Hold still');
  // "You moved" is a single 20 ms sample in the model: hold the red headline long enough to be read
  const now = performance.now(), fresh = !e.ok && now >= badUntil;
  if (!e.ok) { badUntil = now + 1400; badHead = head; }
  const bad = !e.ok || (now < badUntil && !settle && !done && badHead.startsWith(tilt ? 'Level' : 'You'));
  if (bad) head = badHead;
  const h = $('calh'); swapText(h, head, 'lob-swap'); h.classList.toggle('is-bad', bad); h.classList.toggle('is-good', done);
  setText($('calp'), LEAD[done ? 'done' : settle ? 'settle' : tilt ? 'tilt' : 'hold']);
  $('st1').className = tilt ? 'is-done' : 'is-on'; $('st2').className = done ? 'is-done' : tilt ? 'is-on' : '';
  $('art-hold').toggleAttribute('hidden', tilt); $('art-tilt').toggleAttribute('hidden', !tilt);
  $('art-arrow').toggleAttribute('hidden', settle || done); $('art-screen').style.opacity = tilt ? .4 : 1;
  const bar = $('cal-bar'); bar.style.setProperty('--p', (done ? 1 : bad ? 0 : Math.max(0, Math.min(1, e.progress))).toFixed(3));       // the whole card follows the held 'bad' flag, not the 20 ms sample
  bar.classList.toggle('is-bad', bad); bar.classList.toggle('is-done', done);
  const count = $('cal-count'), showNum = !tilt;
  count.classList.toggle('is-bad', bad); count.classList.toggle('is-done', done);
  count.style.visibility = settle && !done ? 'hidden' : '';                  // settling: the bar alone counts; a tick would read as 'finished'
  $('cal-num').hidden = !showNum; $('cal-up').toggleAttribute('hidden', showNum || settle || done); $('cal-check').toggleAttribute('hidden', !done);
  if (showNum) swapText($('cal-num'), String(bad ? HOLD_SECONDS : Math.max(1, Math.ceil(HOLD_SECONDS * (1 - e.progress)))), 'lob-pop');      // ~50 Hz: only a new second hops
  const m = $('calmsg'), mt = waiting ? PADDLE[paddle].waiting : camLost && !tilt ? 'The camera can’t see you. Step into view.' : ''; swapText(m, mt, mt ? 'lob-swap' : '');
  // replay the sideways nudge for every new mistake (also a second one in a row), not for every 20 ms sample
  if (fresh || (!e.ok && calPrev.msg !== msg)) restart($('calcard'), 'is-error'); else if (!bad) $('calcard').classList.remove('is-error');
  calPrev = { ok: e.ok, msg };
}

// ---------- small things ----------
export function setMode(name) { setText($('mode'), name); for (const o of $('move-seg')?.children || []) o.setAttribute('aria-checked', String(o.dataset.move === String(name).toLowerCase())); }      // how you move lives in the settings panel now (docs/NEXT.md 14d)
// Matt's level, or null when the other seat is not Matt: the 1 2 3 4 key hint and the settings Difficulty row show only against him
export function setBot(level) { const on = !!level; show('key-bot', on); show('set-bot', on); if (!on) return; swapText($('bot-level'), String(level), 'ov-pop'); for (const o of $('bot-seg')?.children || []) o.setAttribute('aria-checked', String((o.dataset.name || o.textContent) === String(level))); }
export function toggle(id) { const el = $(id); if (!el) return false; el.hidden = !el.hidden; return !el.hidden; }
export function show(id, on) { const el = $(id); if (!el) return false; el.hidden = !on; return !el.hidden; }
export function setCamera(ready) { show('camwrap', !!ready); }

// ---------- the camera primer (NOTES 94) ----------
// One screen before the first camera request: why, what stays private, and what the browser is about to ask. When the camera
// fails it turns into the fix: the steps for THIS browser first, the computer's own privacy switch, the rest folded away.
// o = { view: 'ask' | 'wait' | 'help', kind: blocked | system | dismissed | nocam | busy | insecure | other, browser: chrome | edge | safari | firefox | '', os: mac | win | ios | '', again }
const CAM_TEXT = {
  ask: ['Let the game see where you stand', 'Poddle uses this computer’s webcam, not your phone, to see where you are. Step left or right and your player moves with you.'],
  wait: ['Press Allow', 'Your browser is asking to use the camera. Look near the address bar.'],
  blocked: ['The camera is blocked', 'Your browser isn’t letting this page use the camera. Allow it like this, then press Try again.'],
  system: ['Your computer is blocking the camera', 'The browser asked, but your computer’s privacy settings said no. Turn the camera on for your browser, then press Try again.'],
  nocam: ['No camera found', 'Plug in a webcam, or check it isn’t switched off or covered, then press Try again.'],
  busy: ['The camera won’t start', 'Another app may be using it, or your computer may be blocking it. Close any app with the camera on (Zoom, Teams and the like), check the steps below, then press Try again.'],      // Windows' privacy switch in Chrome/Edge also lands here (NotReadableError), so the steps show
  dismissed: ['You closed the camera prompt', 'Press Try again, then choose Allow when your browser asks. If it doesn’t ask, use the steps below.'],      // Chrome blocks after ~3 closes and still says 'dismissed': the steps stay
  insecure: ['This page can’t use a camera', 'Browsers only share the camera with a secure page. Open poddleball.com, or localhost on this computer.'],
  other: ['The camera didn’t start', 'Check your browser lets this page use the camera, then press Try again.'],
};
const CAM_BROWSER = { chrome: 'Chrome', edge: 'Edge', safari: 'Safari', firefox: 'Firefox' };
let camH = {};
export function onCamPrimer(h) { camH = h || {}; }                                        // { allow(), retry(), skip() }
export function camPrimer(o = {}) {
  const card = $('cam-card'); if (!card) return; const view = ['ask', 'wait', 'help'].includes(o.view) ? o.view : 'ask', kind = CAM_TEXT[o.kind] ? o.kind : 'other', was = card.dataset.view;
  const [title, lead] = CAM_TEXT[view === 'help' ? kind : view]; card.dataset.view = view; card.dataset.kind = view === 'help' ? kind : '';
  setText($('cam-title'), title); setText($('cam-lead'), lead); $('cam-title').classList.toggle('is-bad', view === 'help'); card.classList.toggle('is-error', view === 'help');
  show('btn-cam-allow', view !== 'help'); $('btn-cam-allow').disabled = view === 'wait'; show('btn-cam-retry', view === 'help' && kind !== 'insecure');
  setText($('cam-note'), view === 'wait' ? 'Nothing is recorded, saved or sent.' : view === 'help' && o.again ? 'Still not working. Check the steps above.' : '');
  // the help: the steps for the browser in use (and its computer's privacy switch) first, every other one folded under 'Using something else?'
  const help = $('cam-help'), steps = ['blocked', 'system', 'dismissed', 'busy', 'other'].includes(kind) && view === 'help'; help.hidden = !steps;
  if (steps) { const b = CAM_BROWSER[o.browser] ? o.browser : 'chrome', os = ['mac', 'win', 'ios'].includes(o.os) ? o.os : '', more = $('cam-more-list'), mine = os === 'ios' ? ['ios'] : [b];      // an iPad: only its Settings app, the desktop menus don't exist there
    if (os && os !== 'ios' && !(os === 'mac' && b === 'safari')) mine[kind === 'system' || kind === 'busy' ? 'unshift' : 'push'](os);      // Safari needs no switch in macOS's Camera list (it is Apple's own). A 'denied by system' error: the computer's switch first
    for (const el of help.querySelectorAll('.cam-browser')) setText(el, CAM_BROWSER[b]);
    for (const el of help.querySelectorAll('.cam-host')) setText(el, location.hostname || 'poddleball.com');      // a local copy is 'Settings for localhost'
    for (const f of mine) help.insertBefore(help.querySelector(`.cam-how[data-for="${f}"]`), $('cam-more'));
    for (const f of ['chrome', 'edge', 'safari', 'firefox', 'mac', 'win', 'ios']) if (!mine.includes(f)) more.appendChild(help.querySelector(`.cam-how[data-for="${f}"]`));
    for (const el of help.querySelectorAll('.cam-how')) el.classList.toggle('is-main', mine.includes(el.dataset.for)); }
  if (view === 'help' && (was === 'help' || o.again)) restart(card, 'lob-nope');      // Try again against a block fails at once: the card shakes, so the press was not for nothing
  const f = view === 'help' ? (kind === 'insecure' ? 'btn-cam-skip' : 'btn-cam-retry') : view === 'ask' ? 'btn-cam-allow' : 'btn-cam-skip';
  if (slots.menu === 'camera' && !$(f).hidden && document.activeElement?.tagName !== 'INPUT') $(f).focus({ preventScroll: true });      // Enter does the likely thing
}
on2('btn-cam-allow', 'click', e => { e.stopPropagation(); if (camH.allow) camH.allow(); });      // stopPropagation: main.js's pointerdown/keys must not read this press as anything else
on2('btn-cam-retry', 'click', e => { e.stopPropagation(); if (camH.retry) camH.retry(); });
on2('btn-cam-skip', 'click', e => { e.stopPropagation(); if (camH.skip) camH.skip(); });
export function onCamOn(fn) { on2('btn-cam-on', 'click', e => { e.stopPropagation(); fn(); }); }      // the connect screen's Camera row: Turn on, after a 'Play without camera' or a failure
export const isVisible = id => { const el = $(id); return !!el && !el.hidden; };
export function setStat(id, text) { setText($(id), String(text)); }                     // stats panel numbers (#pw, #px, #py, …)
export function fullscreen(on) {
  const d = document;
  if (on === undefined) on = !d.fullscreenElement;
  try { const p = on ? (d.fullscreenElement ? null : d.documentElement.requestFullscreen?.()) : (d.fullscreenElement ? d.exitFullscreen?.() : null); if (p && p.catch) p.catch(() => {}); } catch { /* not allowed: fine */ }
}
const fullSync = () => $('tog-full')?.setAttribute('aria-checked', String(!!document.fullscreenElement));      // the switch follows the browser (F, Esc and the title button change it too)
document.addEventListener('fullscreenchange', fullSync);

// key hints (players) and view chips (spectators): shown on any key press / pointer move and when the HUD first appears, gone six seconds later. Never by game events.
let idleT;
const idle = on => { for (const id of ['keys', 'views']) $(id)?.classList.toggle('is-idle', on); };
export function wake() { idle(false); clearTimeout(idleT); idleT = setTimeout(() => idle(true), 6000); }
addEventListener('keydown', wake); addEventListener('pointermove', wake); addEventListener('pointerdown', wake);
addEventListener('keydown', e => { if (e.repeat || e.key.length !== 1 || e.target?.closest?.('input, select, textarea')) return; const k = e.key.toUpperCase(); for (const c of document.querySelectorAll('#keys .keycap, #views .keycap')) if (c.textContent === k && c.offsetParent) restart(c, 'ov-press'); });      // the key you pressed dips on screen too

// finished one-shots go back to rest so nothing is left promoted or mid-animation
$('callout').addEventListener('animationend', e => { if (e.target === e.currentTarget) e.currentTarget.classList.remove('go'); });
$('banner').addEventListener('animationend', e => { if (e.animationName === 'banner-drop' || e.animationName === 'banner-hold') e.currentTarget.classList.remove('show'); });
for (const id of ['sc-me', 'sc-them', 'rally']) $(id).addEventListener('animationend', e => e.currentTarget.classList.remove('pop'));
export function onStart(fn) { $('btn-start').addEventListener('click', fn); }
export function onRetry(fn) { $('btn-retry').addEventListener('click', fn); }

// ---------- names ----------
// One name, two fields (lobby and settings panel), kept in localStorage. The server cleans it again: this is only so the player sees what they will get.
const NAME_KEY = 'poddle.name';
const BADGE_OUT = /[\u221a\u2122\u2610-\u2612\u2705\u2713\u2714\u{1f5f8}\u{1f5f9}\u{1f197}][\ufe0e\ufe0f]?/gu;      // badge look-alikes (docs/ACCOUNTS.md 7.3), as server/usernames.js stripBadges
const cleanName = t => { const n = [...String(t ?? '').replace(BADGE_OUT, '').replace(/[\u0000-\u001f\u007f-\u009f\p{Cf}\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180f\u2028-\u202e\u2800\u3164\uffa0\ufff9-\ufffb\u{e0000}-\u{e0fff}<>]/gu, '').replace(/(\p{M}{2})\p{M}+/gu, '$1').replace(/\s+/g, ' ').trim()].slice(0, 12).join('').trim(); return /[\p{L}\p{N}\p{S}\p{P}]/u.test(n) ? n : ''; };      // the server's rule (server/game.js cleanName): a name that draws as nothing is no name
let savedName = ''; try { savedName = cleanName(localStorage.getItem(NAME_KEY)); } catch { /* private window: ask every time */ }
for (const id of ['name-input', 'set-name-input']) { const el = $(id); if (el) { el.value = savedName; el.addEventListener('focus', () => el.select()); } }      // like the code boxes: typing replaces what is there
let lockedName = '';                                       // a signed-in player's registered username (docs/ACCOUNTS.md 9.5): both fields show it, read-only, and it is the name
export const playerName = () => lockedName || cleanName(($('name-input') || {}).value ?? savedName);
export function lockName(name) {                           // name: the username, or null to give the fields back (the typed guest name, which was never overwritten)
  lockedName = typeof name === 'string' ? name.slice(0, 12) : '';
  for (const id of ['name-input', 'set-name-input']) { const el = $(id); if (el) { el.readOnly = !!lockedName; el.value = lockedName || savedName; } }
  show('btn-name-change', !!lockedName); show('btn-set-name-change', !!lockedName); nameGate();
}
function keepName(from) {                                  // typing in one field shows in the other; an empty name is never stored
  if (lockedName) return;
  const n = cleanName(from.value); for (const id of ['name-input', 'set-name-input']) { const el = $(id); if (el && el !== from) el.value = n; }
  if (n) { savedName = n; try { localStorage.setItem(NAME_KEY, n); } catch { /* fine */ } }
  nameGate();
}
function nameGate() {                                      // first visit: the choices are dimmed (and say so to a screen reader) until the name has a letter
  const need = !playerName(); $('screen-lobby')?.classList.toggle('needs-name', need); $('name-row')?.classList.remove('is-bad');
  for (const t of document.querySelectorAll('#lobby-home .tile:not(#btn-profile):not(#btn-leaderboard)')) { if (need) t.setAttribute('aria-disabled', 'true'); else t.removeAttribute('aria-disabled'); }      // Your stats and the leaderboard seat nobody: they need no name
}
function needName() {                                      // a seat was asked for with no name: the field says so, nothing is sent
  if (playerName()) return false;
  const row = $('name-row'); if (row) { row.classList.add('is-bad'); restart(row, 'is-error'); row.addEventListener('animationend', function done(e) { if (e.target !== row || e.animationName !== 'nudge') return; row.removeEventListener('animationend', done); row.classList.remove('is-error'); }); } $('name-input')?.focus({ preventScroll: true }); return true;
}

// ---------- settings panel (hamburger). A card, not a screen: inPlay() in main.js stays true and the rally goes on behind it ----------
let setOpen = false, setH = {}, sinkSig = '';
// Why the Output row is not there. browser: no AudioContext.setSinkId (Safari, Firefox). devices: it could move the sound,
// but the browser will not name a single audio device until the page holds MICROPHONE permission — measured, and a camera
// grant does NOT do it (NOTES 64). denied: they said no, and only the browser's own site settings can undo that.
const SINK_HINT = { browser: 'This browser can’t move the game’s sound. Choose your speakers in System Settings › Sound.',
  devices: 'Allow audio once so the browser can list your speakers. Nothing is recorded.',
  denied: 'Audio permission is blocked, so your speakers can’t be listed. Allow it for this site in your browser, or choose them in System Settings › Sound.' };
export function onSettings(h) { setH = h || {}; }                                       // { open(), close(), sens(dir), airpod(on), stats(on), recenter(), leave(), name(text), move(mode), paddle(kind), bot(level), sound(on), sink() }
export function settings(open) {
  if (open === undefined) return setOpen;
  open = !!open && !slots.menu && !slots.overlay; if (open === setOpen) return setOpen;
  const el = $('settings'), btn = $('btn-menu'); if (!el) return false;
  if (open) tourCard(false);                                                         // one card at a time
  setOpen = open; el.hidden = !open; btn?.setAttribute('aria-expanded', String(open));
  if (open) { document.body.dataset.settings = 'open'; fullSync(); placeSettings(); const n = $('set-name-input'); if (n) n.value = lockedName || savedName; el.focus({ preventScroll: true }); }      // the card takes focus, not its name field: Esc and the game keys must still reach main.js
  else { delete document.body.dataset.settings; if (el.contains(document.activeElement)) { if (btn && !slots.menu && !slots.overlay) btn.focus({ preventScroll: true }); else document.activeElement.blur(); } }
  const fn = open ? setH.open : setH.close; if (fn) fn();
  return setOpen;
}
function placeSettings() {                                 // under the hamburger; on a narrow window the corner is a column and the scoreboard reaches over the card, so go under those too
  const el = $('settings'), board = $('board'); if (!el || el.hidden) return; let y = 0;
  for (const c of $('corner').children) if (c.id !== 'dev' && c.offsetParent) y = Math.max(y, c.getBoundingClientRect().bottom);
  const r = el.getBoundingClientRect(), b = board ? board.getBoundingClientRect() : null; if (b && b.width && b.left < r.right && b.right > r.left) y = Math.max(y, b.bottom);
  el.style.setProperty('--set-top', `calc(${Math.round(y)}px + .5rem)`);
}
addEventListener('resize', placeSettings);
export function setSettings(o = {}) {
  if (typeof o.sens === 'number') { const v = $('set-sens-val'), t = String(Math.round(o.sens)), was = +v?.textContent; if (v && v.textContent !== t) { v.textContent = t; if (setOpen) { v.classList.remove('ov-up', 'ov-down'); restart(v, +t > was ? 'ov-up' : 'ov-down'); } } }      // the new number rolls in from the side it came from
  for (const [key, id] of [['sensMin', 'btn-sens-less'], ['sensMax', 'btn-sens-more']]) if (key in o && $(id)) { if (o[key] && document.activeElement === $(id)) $('settings')?.focus({ preventScroll: true }); $(id).disabled = !!o[key]; }   // a disabled button drops focus to <body>: keep it in the card
  for (const [key, id] of [['airpod', 'tog-airpod'], ['sound', 'tog-sound'], ['body', 'tog-body']]) if (key in o) $(id)?.setAttribute('aria-checked', String(!!o[key]));
  // Output: the row shows only when the sound can actually be moved AND the browser is willing to name the devices.
  // Otherwise the hint says which of the two is missing, rather than leaving a dead control on screen.
  if ('sinkWhy' in o) { show('set-sink', !o.sinkWhy); show('sink-hint', !!o.sinkWhy); if (o.sinkWhy) setText($('sink-hint'), SINK_HINT[o.sinkWhy] || SINK_HINT.browser);
    show('btn-find-sinks', o.sinkWhy === 'devices'); }      // only 'devices' is fixable from here: a button that asks, once
  if ('sinks' in o) { const s = $('set-sink-sel'), sig = JSON.stringify(o.sinks);           // rebuilt only when the devices really changed: never under the player's finger while the list is open
    if (s && sig !== sinkSig) { sinkSig = sig; const keep = s.value;
      s.replaceChildren(...(o.sinks || []).map(d => { const op = document.createElement('option'); op.value = d.id; op.textContent = d.label; return op; }));      // device names are the system's text: textContent only
      s.value = o.sink != null ? o.sink : keep; if (!s.selectedOptions.length) s.value = ''; } }
  if ('sink' in o) { const s = $('set-sink-sel'); if (s && s.value !== o.sink) s.value = o.sink || ''; }
  if ('inRoom' in o) show('btn-leave-room', !!o.inRoom);
  { let n = false; for (const k of ['forfeit', 'canPause', 'tourMatch', 'rkMatch', 'rkWarm']) if (k in o) { setNote[k] = !!o[k]; n = true; } if (n) drawNote(); }      // the Leave button and the note under it: what leaving costs, and why a match cannot pause
  if ('bodyOk' in o) { const b = $('move-seg')?.querySelector('[data-move="body"]'); if (b) b.disabled = !o.bodyOk; show('move-note', !o.bodyOk); }
  if ('bodyNote' in o) { const n = $('move-note'); if (n) { setText(n, o.bodyNote || 'Body needs a camera'); if (o.bodyNote) n.hidden = false; } }      // the camera is off but can be asked for: picking Body asks, and the row says so      // no camera: Body cannot be picked, and the row says why
  if ('spectator' in o) $('settings')?.classList.toggle('is-spectator', !!o.spectator);
  if ('paddle' in o) { show('set-paddle', !!o.paddle); for (const b of $('paddle-seg2')?.children || []) b.setAttribute('aria-checked', String(b.dataset.paddle === o.paddle)); }      // null: only an AirPod can be the paddle here, nothing to pick
}
// forfeit: mid-match against a person (or any Ranked / tournament match), leaving is a forfeit and the button says so. rkWarm: the Ranked warm-up (Stop warm-up: you stay queued; Matt is fixed).
// canPause false: the note says why (a tournament match, a Ranked match, or any online game against a person)
const setNote = { forfeit: false, canPause: true, tourMatch: false, rkMatch: false, rkWarm: false };
function drawNote() {
  const b = $('btn-leave-room'), t = setNote.forfeit ? 'Forfeit' : setNote.rkWarm ? 'Stop warm-up' : 'Leave court';
  if (b && swapText(b, t) && setOpen && !b.hidden) restart(b, 'ov-nudge');
  const n = $('set-note'); if (!n) return;
  setText(n, setNote.rkMatch ? 'Ranked matches can’t pause' : setNote.tourMatch ? 'Tournament matches can’t pause' : setNote.canPause ? 'Matt’s level is locked during the Ranked warm-up' : 'Online games can’t pause');
  n.hidden = !(!setNote.canPause || setNote.rkWarm);
}
export function setPaused(on) {                            // the rest is CSS: blur behind the open card, the "Paused" tag while it is closed
  if (on) document.body.dataset.paused = '1'; else delete document.body.dataset.paused;
  swapText($('set-title'), on ? 'Paused' : 'Settings', setOpen ? 'ov-pop' : '');      // with the card open, the new title hops
}
{
  on2('btn-menu', 'click', () => settings(!setOpen));
  addEventListener('pointerdown', e => { if (setOpen && !e.target.closest?.('#settings, #btn-menu')) settings(false); });
  const call = (k, ...a) => { if (setH[k]) setH[k](...a); };
  on2('btn-sens-less', 'click', () => call('sens', -1)); on2('btn-sens-more', 'click', () => call('sens', 1));
  for (const [id, k] of [['tog-airpod', 'airpod'], ['tog-sound', 'sound'], ['tog-body', 'body']]) on2(id, 'click', e => call(k, e.currentTarget.getAttribute('aria-checked') !== 'true'));      // the NEW value; main.js answers with setSettings
  on2('set-sink-sel', 'change', e => call('sink', e.currentTarget.value));      // main.js answers with setSettings: if the device refuses, the row goes back by itself
  on2('btn-find-sinks', 'click', () => call('findSinks'));
  on2('tog-full', 'click', () => fullscreen());
  on2('move-seg', 'click', e => { const o = e.target.closest('[data-move]'); if (o && !o.disabled) call('move', o.dataset.move); });      // main.js answers with setMode / setBot: the UI flips nothing itself
  on2('paddle-seg2', 'click', e => { const o = e.target.closest('[data-paddle]'); if (o) call('paddle', o.dataset.paddle); });      // phone <-> AirPod at any time, not only on the set-up screen
  on2('bot-seg', 'click', e => { const o = e.target.closest('[data-level]'); if (o) call('bot', +o.dataset.level); });
  on2('btn-recenter', 'click', e => { restart(e.currentTarget, 'ov-spin'); call('recenter'); }); on2('btn-leave-room', 'click', () => call('leave'));      // Recentre: the button spins its svg (restart() cannot replay an SVG itself: no offsetWidth)
  // name: saved on Enter / blur. Empty puts the old one back. Esc cancels the edit and hands focus back to the card (main.js owns what Esc does next)
  const commit = el => { if (lockedName) { el.value = lockedName; return; } const n = cleanName(el.value); if (!n) { el.value = savedName; return; } const changed = n !== savedName; el.value = n; keepName(el); if (changed) call('name', n); };
  on2('set-name-input', 'blur', e => commit(e.currentTarget));
  on2('set-name-input', 'keydown', e => { if (e.key === 'Enter') { e.preventDefault(); commit(e.currentTarget); $('settings').focus({ preventScroll: true }); } else if (e.key === 'Escape') { e.currentTarget.value = lockedName || savedName; $('settings').focus({ preventScroll: true }); } });
  // Up / Down walk the card's controls (Tab works too)
  on2('settings', 'keydown', e => { const d = { ArrowDown: 1, ArrowUp: -1 }[e.key]; if (!d || document.activeElement?.tagName === 'SELECT') return;      // on the Output row the arrows are the list's own: Tab leaves it
    const nav = [...$('settings').querySelectorAll('button, input, select')].filter(b => !b.disabled && b.offsetParent), i = nav.indexOf(document.activeElement);      // select: Down from the row above still lands on it
    if (!nav.length) return; e.preventDefault(); nav[(i < 0 ? (d > 0 ? 0 : nav.length - 1) : i + d + nav.length) % nav.length].focus({ preventScroll: true }); });
}

// ---------- spectators ----------
const VIEWS = ['broadcast', 'split', 'pov', 'free'];
let onViewFn = null;
export function setSpectator(on) { const b = document.body; if (on) b.dataset.role = 'spectator'; else { delete b.dataset.role; delete b.dataset.view; } }      // CSS does the rest: tag, chips, no key hints, no insets
export function setWatchers(n) { n = Math.max(0, n | 0); const was = isVisible('watchers'); show('watchers', n > 0); if (swapText($('watch-n'), String(n)) && was && n > 0) restart($('watchers'), 'ov-pop'); $('watchers')?.setAttribute('aria-label', `${n} watching`); }
export function onView(fn) { onViewFn = fn; }                                          // a chip click -> fn(name). The active Player chip calls again: main.js flips the side
export function setView(name, who = '', tier = null) {    // tier: that player's rank in a Ranked court (the emblem beside the chip's name, docs/RANKED.md 6)
  if (!VIEWS.includes(name)) return;
  document.body.dataset.view = name; setText($('view-pov'), name === 'pov' && who ? `Player: ${who}` : 'Player'); rankBadge($('view-pov'), name === 'pov' && who ? tier : null);
  for (const c of document.querySelectorAll('#views .view-chip')) c.setAttribute('aria-pressed', String(c.dataset.view === name));
}
on2('views', 'click', e => { const c = e.target.closest('.view-chip'); if (c && onViewFn) onViewFn(c.dataset.view); });
on2('views', 'keydown', e => { const d = { ArrowRight: 1, ArrowLeft: -1 }[e.key]; if (!d) return; const cs = [...$('views').children], i = cs.indexOf(document.activeElement); if (i < 0) return; e.preventDefault(); cs[(i + d + 4) % 4].focus(); });
// ---------- spectator emotes: a row of Apple emoji bottom-right (web/emoji/, from iamcal/emoji-data img-apple-160), happy to sad.
// A pick goes to the server; it comes back to everyone in the court (the sender too) and pops in from the right edge. No cooldown: tap as fast as you like.
export const EMOTES = [['1f923', '🤣', 'Rolling on the floor laughing'], ['1f975', '🥵', 'Hot'], ['1f92f', '🤯', 'Mind blown'],
  ['1f621', '😡', 'Angry'], ['1f480', '💀', 'Skull'], ['1f940', '🥀', 'Wilted flower'], ['1f622', '😢', 'Crying']];     // the index is the wire value (server EMOTES)
let onEmoteFn = null;
export function onEmote(fn) { onEmoteFn = fn; }
const emoteImg = i => { const img = document.createElement('img'); img.src = new URL(`emoji/${EMOTES[i][0]}.png`, import.meta.url).href; img.alt = EMOTES[i][1]; img.draggable = false; img.decoding = 'async'; return img; };
{ const box = $('emotes');
  if (box) EMOTES.forEach((em, i) => { const b = document.createElement('button'); b.className = 'emote-btn'; b.dataset.e = String(i); b.setAttribute('aria-label', em[2]); b.title = em[2]; b.append(emoteImg(i)); box.append(b); });
  on2('emotes', 'click', e => { const b = e.target.closest('.emote-btn'); if (!b || !onEmoteFn) return; restart(b, 'ov-sent'); onEmoteFn(+b.dataset.e); }); }      // the face squashes and springs as it goes
// one reaction arriving: floats up from the bottom-right corner like a live-stream reaction, swaying, and fades. Eight on screen at most
export function emote(i, name) {
  const layer = $('emote-layer'); if (!layer || !EMOTES[i]) return;
  while (layer.childElementCount >= 8) layer.firstElementChild.remove();
  const el = document.createElement('div'), body = document.createElement('i'), dur = 3.2 + Math.random() * 1.2; el.className = 'emote-pop';
  el.style.setProperty('--x', `${(Math.random() * 3).toFixed(2)}rem`); el.style.setProperty('--sway', `${((Math.random() < .5 ? -1 : 1) * (.5 + Math.random() * 1)).toFixed(2)}rem`); el.style.setProperty('--dur', `${dur.toFixed(2)}s`);
  body.append(emoteImg(i)); if (name) { const n = document.createElement('span'); n.textContent = name; body.append(n); }      // names: textContent only
  el.append(body); el.addEventListener('animationend', e => { if (e.target === el) el.remove(); }); setTimeout(() => el.remove(), dur * 1000 + 500); layer.append(el);
}
// someone sat down in the stands: a small card on the left edge for a few seconds. Three at most; names go in as textContent only
const EYE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z"/><circle cx="12" cy="12" r="2.6"/></svg>';
export function watcherNote(name) {
  const box = $('notices'); if (!box) return;
  while (box.childElementCount >= 3) box.firstElementChild.remove();
  const el = document.createElement('div'), t = document.createElement('span'); el.className = 'notice'; el.innerHTML = EYE;
  t.textContent = name ? `${name} is watching` : 'Someone is watching'; el.append(t); box.append(el);
  setTimeout(() => { el.classList.add('is-out'); setTimeout(() => el.remove(), 400); }, 3600);
}
export function notesOff() { $('notices')?.replaceChildren(); }
export function emotesOff() { const layer = $('emote-layer'); if (layer) layer.replaceChildren(); }     // out of the room: nothing carries over

// ---------- asking to play (docs/SPECTATE.md Asking to play) ----------
// The player's card: bottom-left, 10 s, Y / N. It never takes focus and never swallows a key: its buttons are out of the Tab order
// (so Space and Enter can never press them), a click blurs, and a pointerdown on it is not a court tap. o = { name, left } | null.
let cardOn = false, cardT = 0, cardTick = 0, onAnswerFn = null;
export const askShowing = () => cardOn && !slots.menu;                                // hidden under a menu screen: Y / N do nothing there
export function onAnswer(fn) { onAnswerFn = fn; }                                     // fn(true | false) on a click; Y / N are main.js's
export function askCard(o) {
  const el = $('ask-card'); if (!el) return;
  clearTimeout(cardT); clearInterval(cardTick);
  if (!o) { if (!cardOn) { el.hidden = true; return; } cardOn = false; el.classList.remove('is-on'); setText($('ask-live'), ''); cardT = setTimeout(() => { el.hidden = true; }, reduced() ? 0 : 200); return; }
  const left = Math.max(1, Math.min(60, Math.round(+o.left || 10))), name = String(o.name || 'Someone'), bar = el.querySelector('.ask-bar i');
  setText($('ask-name'), name); cardOn = true; el.classList.remove('is-late'); el.hidden = false; void el.offsetWidth; el.classList.add('is-on'); restart($('ask-name'), 'lob-pop');      // the asker's name hops as the card lands
  setText($('ask-live'), `${name} wants to play. They take Matt’s place and a new match starts. Press Y to accept or N to decline.`);
  let k = 0; const step = () => { k++; el.querySelector('.ask-bar')?.style.setProperty('--p', Math.max(0, (left - k) / left).toFixed(3)); el.classList.toggle('is-late', left - k <= 3); };      // the last 3 s pulse (ui.css)      // stepped once a second from the server's number, each step a 1 s linear slide: it reaches 0 at 'left'
  if (bar) { bar.style.transition = 'none'; el.querySelector('.ask-bar').style.setProperty('--p', '1'); void bar.offsetWidth; bar.style.transition = ''; }
  cardT = setTimeout(() => askCard(null), left * 1000 + 500);                         // the server's askoff closes it; this is the backstop
  requestAnimationFrame(() => { if (cardOn) step(); }); cardTick = setInterval(() => { if (k >= left) clearInterval(cardTick); else step(); }, 1000);
}
{ const card = $('ask-card');
  if (card) { card.addEventListener('pointerdown', e => e.stopPropagation());          // not a court tap, and it does not close the settings card
    for (const [id, yes] of [['btn-ask-yes', true], ['btn-ask-no', false]]) on2(id, 'click', e => { e.currentTarget.blur(); if (cardOn && onAnswerFn) onAnswerFn(yes); }); } }
// The requester's button: on the bottom row left of the emotes, one fixed width. m = the server's askstate { s, left, why, busy } | null (back to Ask to play).
// Counts down here from 'left'; showAsk(on) is main.js's call (a spectator watching one human play Matt, on a device that can be a paddle).
const ASK_SAID = { sent: 'Asked. Waiting for an answer.' };      // no / expired / busy: main.js says why in a toast with the player's name (a role=status, so it is read out too), and the button only counts
let ask = { s: 'idle', left: 0, busy: false }, askT = 0, askOn = false, askedOnce = false;      // askedOnce: a request of mine ended (a no, an expiry): the idle label is Ask again
export const askCan = () => askOn && !$('btn-ask')?.hidden && ask.s === 'idle';
let onAskFn = null;
export function onAsk(fn) { onAskFn = fn; }
export function showAsk(on) { if (askOn === !!on) return; askOn = !!on; drawAsk(); }      // main.js asks on every state packet: only a change draws
export function askPlay(m) {
  clearInterval(askT);
  if (!m || typeof m !== 'object') { ask = { s: 'idle', left: 0, busy: false }; askedOnce = false; }
  else { const s = ['sent', 'no', 'expired', 'wait', 'gone', 'refused', 'yes'].includes(m.s) ? m.s : 'idle', left = Math.max(0, Math.min(99, m.left | 0));
    ask = { s: (s === 'gone' || s === 'wait') && !left ? 'idle' : s, left, busy: !!m.busy }; if (s === 'no' || s === 'expired' || s === 'gone') askedOnce = true; else if (s === 'yes' || s === 'refused') askedOnce = false;
    if (ASK_SAID[s]) setText($('ask-state'), ASK_SAID[s]);
    const ring = $('btn-ask')?.querySelector('.ask-ring'); if (ring && s === 'sent') { ring.style.animationDuration = `${left || 10}s`; restart(ring, 'go'); } }      // the ring drains over the request's life
  if (ask.left > 0 && ['sent', 'no', 'expired', 'wait', 'gone'].includes(ask.s)) askT = setInterval(() => { ask.left--; if (ask.left <= 0) { clearInterval(askT); if (ask.s !== 'sent') ask = { s: 'idle', left: 0, busy: false }; else ask.left = 1; } drawAsk(); }, 1000);      // Asked holds at 1 until the answer comes
  drawAsk();
}
function drawAsk() {
  const b = $('btn-ask'); if (!b) return; const s = ask.s, n = ask.left, was = b.dataset.s;
  b.hidden = !askOn || s === 'refused' || s === 'yes';
  const label = s === 'idle' ? (askedOnce ? 'Ask again' : 'Ask to play') : s === 'sent' ? `Waiting · ${n}s` : `Again in ${n}s`;      // the count says what it counts: Waiting = the player's time left to answer; Again in = until you may ask (a cooldown, or another request). The why (said no, no answer, someone else asked) is main.js's toast. Both fit 16rem at 390 px
  setText($('ask-label'), label); b.dataset.s = s; b.setAttribute('aria-disabled', String(s !== 'idle')); if (was && was !== s && !b.hidden) restart(b, 'ov-bump');      // Asked / Again: the button bumps as it changes
}
on2('btn-ask', 'click', e => { if (e.pointerType) e.currentTarget.blur(); if (askCan() && onAskFn) onAskFn(); });

on2('btn-rematch', 'click', () => { if (voted) return; lockVote(true); if (onVote) onVote(true); });
on2('btn-leave', 'click', () => { if (voted && !votedYes) return; lockVote(false); if (onVote) onVote(false); });      // also after Rematch: a change of mind
on2('btn-rk-again', 'click', () => { if (voted) return; lockVote(true); if (onVote) onVote(true); }); on2('btn-rk-leave', 'click', () => { if (voted && !votedYes) return; lockVote(false); if (onVote) onVote(false); });      // the series card (docs/RANKED.md 8.8): Play again queues again, Leave is Leave; main.js tells them from a rematch vote by the card
on2('rk-acts', 'keydown', e => { if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return; const b = $(e.key === 'ArrowLeft' ? 'btn-rk-again' : 'btn-rk-leave'); if (b && !b.disabled) { e.preventDefault(); b.focus(); } });
on2('rematch-btns', 'keydown', e => { if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return; const b = $(e.key === 'ArrowLeft' ? 'btn-rematch' : 'btn-leave'); if (b && !b.disabled) { e.preventDefault(); b.focus(); } });

// ---------- lobby ----------
// Views inside #screen-lobby, one at a time: home (three tiles), courts (the court list, search, Open | Full, a code to Join or Watch,
// Create court / Create tournament: docs/COURTS-TOURNEY.md 2.7), create (public / private), share (the new court's code and link),
// bot (Matt's four levels). Above them the name field (not on share).
// main.js owns the socket; this only draws and reports what was chosen. Handlers carry no name: main.js reads playerName().
const CODE_OK = /[ABCDEFGHJKMNPQRSTUVWXYZ23456789]/g;                                   // the server's alphabet: no I, L, O, 0, 1
export const cleanCode = t => { t = String(t || '').toUpperCase(); const m = /(?:COURT|ROOM)=([A-Z0-9]{4})/.exec(t); return ((m ? m[1] : t).match(CODE_OK) || []).slice(0, 4).join(''); };   // a pasted link works too
const VIEW_TITLE = { home: 'Play', courts: 'Courts', create: 'Create court', share: 'Your court', bot: 'Play a bot', tour: 'Tournament', bracket: 'Tournament', profile: 'Your stats', ranked: 'Ranked', ranks: 'Ranks', leaderboard: 'Global leaderboard' };      // the board's title says Global: it is everyone, not friends or a region (NOTES 126)
const VIEW_DEPTH = { home: 0, courts: 1, bot: 1, profile: 1, ranked: 1, leaderboard: 1, ranks: 2, create: 2, tour: 2, bracket: 2, share: 3 };      // how deep each view sits: forward slides in from the right, back from the left
const VIEW_PARENT = { create: 'courts', share: 'courts', tour: 'courts', bracket: 'courts' };      // Back from these goes to Courts, not home (a tournament lives on: T brings it back)
const NO_NAME = ['share', 'tour', 'bracket', 'profile', 'ranks', 'leaderboard'];                                 // views with no name row above them
export const viewParent = v => (v === 'ranks' ? ranksFrom : VIEW_PARENT[v] || null);      // Ranks goes back to where it was opened from (Your stats or Ranked)
const boxes = () => [...$('code-boxes').children];
let view = 'home', roomsKey = '', on = {}, deep = null, ranksFrom = 'ranked', lastRank = null;      // lastRank: { tier, div, best } from the last rkView / rankCrest, for the Ranks page                                  // deep: a shared link's Join or Watch, focused and lit until the view changes
export function onLobby(handlers) { on = handlers || {}; }                              // { quick(), create(isPublic), join(code), watch(code), bot(level), start(), back(), copied(), profile(), ranked(), rankedOpen(), view(name) }
export function lobbyView(name, { code, watch } = {}) {
  if (!name) return view;
  if (name === 'code') name = 'courts';                                                 // the old code view lives inside Courts now: old call sites still land
  const was = view, sl = $('screen-lobby');
  view = VIEW_TITLE[name] ? name : 'home';
  if (sl.classList.contains('is-active') && sl.dataset.live && was !== view) { const d = (VIEW_DEPTH[view] ?? 0) - (VIEW_DEPTH[was] ?? 0); if (d) sl.dataset.dir = d > 0 ? 'fwd' : 'back'; else delete sl.dataset.dir; }      // the view slides in from the side it lies on (ui.css); a re-call of the same view keeps its entrance
  sl.dataset.live = '1';
  for (const el of document.querySelectorAll('#screen-lobby .lobby-view')) el.hidden = el.dataset.view !== view; tilesFit();
  { const t = $('lobby-title'), tt = view === 'bracket' && ts ? `Tournament ${ts.code}` : VIEW_TITLE[view]; if (t.textContent !== tt) { setText(t, tt); restart(t, 'swap'); } } codeError(''); show('name-row', !NO_NAME.includes(view)); askWatch(null); show('tour-ended', false); tourConfirm(false);
  if (view === 'bracket') drawBracket(); else if (view === 'tour') drawTour(); else if (view === 'profile' && was !== 'profile' && on.profile) on.profile();      // Your stats: main.js asks web/profile.js to fetch and draw it
  else if (view === 'ranked' && was !== 'ranked' && on.rankedOpen) on.rankedOpen();
  else if (view === 'leaderboard' && was !== 'leaderboard' && on.leaderboard) on.leaderboard();      // the global leaderboard: web/profile.js fetches and draws it (NOTES 126)
  else if (view === 'ranks') { if (was !== 'ranks' && was !== 'home') ranksFrom = was === 'profile' ? 'profile' : 'ranked'; drawRanks(); if (!lastRank && on.ranksOpen) on.ranksOpen(); }      // a reload on /ranks knows no rank yet: main.js fetches it      // Ranked: the same, and the stadium behind the glass (docs/RANKED.md 2)
  deep = null; for (const b of [$('btn-join'), $('btn-watch-code')]) b?.classList.remove('is-focus');
  if (view === 'courts') { setCode(cleanCode(code || '')); if (cleanCode(code).length === 4) { deep = watch ? 'watch' : 'join'; $(deep === 'watch' ? 'btn-watch-code' : 'btn-join')?.classList.add('is-focus'); } drawCourts(); }      // a shared link: the boxes filled in, Join (or Watch) lit
  nameGate();
  const v = view; setTimeout(() => focusView(v), 60);    // after the key that brought us here is up: a held Enter must not press it
  on.view?.(view);      // main.js puts the view in the address bar (/courts, /stats...), so a reload comes back to it
}
function focusView(v, n = 0) { if (slots.menu !== 'lobby' || asking() || view !== v) return; const el = firstFocus(); el.focus({ preventScroll: true, focusVisible: true }); if (v === 'bracket') brReveal(el); if (document.activeElement !== el && n < 4) setTimeout(() => focusView(v, n + 1), 100); }      // a screen still fading in (its visibility turns on a frame later under reduced motion) refuses focus: try again
// where focus lands on a view. No name yet (the first visit): the name field, and nothing else can be chosen until it has a letter
const firstFocus = () => (!NO_NAME.includes(view) && !playerName() && $('name-input')) || viewFocus();
function courtsFocus() {                                                                 // a code half typed: its next box. A link: Join / Watch. A mouse: search. A finger: the switch, so no keyboard pops up
  const c = getCode(); if (c && c.length < 4) return boxes().find(b => !b.value);
  if (deep) return $(deep === 'watch' ? 'btn-watch-code' : 'btn-join');
  return matchMedia('(pointer: fine)').matches ? $('court-search') : $('court-seg').querySelector('[aria-checked="true"]');
}
const vis = el => !!el && !el.hidden && !!el.offsetParent;
const profileFocus = () => [...($('lobby-profile')?.querySelectorAll('button') || [])].find(vis) || $('lobby-profile');      // Next: beat Club Matt when there is one, else the first thing there is to press
const tourFocus = () => (ts && !ts.you?.host && vis($('btn-tour-warm')) ? $('btn-tour-warm') : null) || (vis($('btn-tour-copy')) ? $('btn-tour-copy') : $('tour-code'));      // the host's first act is to share: Copy invite. A guest's: Warm up with Matt
const brFocus = () => { const y = ts && ts.you && !ts.you.viewer && !ts.you.out && $('bracket').querySelector('.br-col.is-current .br-match.is-you'); return y && (y.querySelector('.br-watch') || y) || $('bracket').querySelector('.br-watch') || $('bracket'); };      // a player still in: their own card (what 'You're through' points at; its Watch if it is live). A viewer, or one who is out: the first Watch
const viewFocus = () => ({ home: $('btn-quick'), courts: courtsFocus(), create: $('btn-create-go'), share: $('btn-share-go'), bot: $('btn-bot-1'), tour: tourFocus(), bracket: brFocus(), profile: profileFocus(), ranked: (g => g && !g.disabled ? g : barOn && vis($('btn-rk-warm')) ? $('btn-rk-warm') : $('btn-rk-all'))($('btn-ranked-go')), ranks: $('btn-rkx-go'), leaderboard: $('lb-tabs')?.querySelector('[aria-checked="true"]') }[view] || $('btn-quick'));
// The home tiles: how many show (Ranked and Your stats only where the server keeps stats) decides the layout, through .tiles[data-n] (ui.css). Never :has(nth-child): a hidden
// tile in DOM slot 2 would make the visible fourth the 4th child. Called on every view change and by web/profile.js when it shows or hides a tile
export function tilesFit() { const t = $('lobby-home')?.querySelector('.tiles'); if (!t) return 0; const n = t.querySelectorAll('.tile:not([hidden])').length; if (t.dataset.n !== String(n)) t.dataset.n = String(n); return n; }
// The list scrolls when it is full, and macOS hides scrollbars until you already know to scroll. So the bar is ours: a
// track and a thumb that are always drawn while there is more to see, sized from the list's own scroll numbers. Drag it or wheel.
function roomBar() { const l = $('room-list'), t = $('room-bar'); if (!l || !t) return; const more = l.scrollHeight > l.clientHeight + 1; t.hidden = !more; if (!more) return;
  const th = t.firstElementChild, share = l.clientHeight / l.scrollHeight; th.style.height = share * 100 + '%'; th.style.top = l.scrollTop / l.scrollHeight * 100 + '%'; }
{ const l = $('room-list'), t = $('room-bar'); if (l && t) { l.addEventListener('scroll', roomBar, { passive: true }); addEventListener('resize', roomBar);
  let grab = null; const th = t.firstElementChild;
  th.addEventListener('pointerdown', e => { grab = { y: e.clientY, top: l.scrollTop }; th.setPointerCapture(e.pointerId); e.preventDefault(); });
  th.addEventListener('pointermove', e => { if (grab) l.scrollTop = grab.top + (e.clientY - grab.y) * l.scrollHeight / t.clientHeight; });
  th.addEventListener('pointerup', () => { grab = null; }); th.addEventListener('pointercancel', () => { grab = null; });
  t.addEventListener('pointerdown', e => { if (e.target === t) l.scrollTop += (e.offsetY > th.offsetTop ? 1 : -1) * l.clientHeight * 0.9; }); } }      // a click on the track pages

// ---------- the court list ----------
// rooms: { code, players, open, ask, bot, watch, watchers, score:[a,b], live, names:[n0,n1] } (an older server's { code, players, open } still draws).
// tours: { code, host, n, max } tournaments signing up (docs/COURTS-TOURNEY.md Feature 2; none yet). Every string goes in as textContent.
// Open = tournaments, courts with someone waiting (a join seats you), ask rows (one human playing Matt: a join asks them), empty courts. Full = two humans (the row is Watch).
let list = { rooms: [], tours: [] }, seen = false, filter = 'open', query = '';
let drawn = new Map(), drawnMode = '';      // the rows last drawn (code -> meta) and their state|tab: only NEW rows rise in, only CHANGED metas pop
try { if (localStorage.getItem('poddle.courts') === 'full') filter = 'full'; } catch { /* private window */ }
const kindOf = r => r.open !== false ? 'open' : r.ask ? 'ask' : 'full';
const nm = (r, i) => Array.isArray(r.names) && typeof r.names[i] === 'string' && r.names[i] ? r.names[i].slice(0, 24) : '';
const rg = (r, i) => Array.isArray(r.reg) && r.reg[i] === true;      // a registered username in seat i (docs/ACCOUNTS.md 7.5): the row draws the badge beside it
const sc = r => `${Array.isArray(r.score) ? r.score[0] | 0 : 0}-${Array.isArray(r.score) ? r.score[1] | 0 : 0}`;
function rowsOf() {                                                                      // every court as a row: { kind, code, who, meta, go, watch, label }
  const out = [];
  for (const t of list.tours) out.push({ kind: 'tour', code: t.code, who: `${String(t.host || 'Someone').slice(0, 24)}’s tournament`, meta: `${t.n | 0} of ${t.max | 0 || 16} joined`, go: 'Join' });
  for (const r of list.rooms) { const k = kindOf(r), w = r.watchers | 0, hi = nm(r, 0) && nm(r, 0) !== 'Matt' ? 0 : nm(r, 1) && nm(r, 1) !== 'Matt' ? 1 : -1, human = hi < 0 ? '' : nm(r, hi), hr = hi >= 0 && rg(r, hi);
    if (k === 'open') out.push({ kind: k, code: r.code, who: !r.players ? 'Empty' : `${human || 'A player'} is waiting`, segs: r.players ? [[human || 'A player', hr], ' is waiting'] : null, meta: w > 0 ? `${w} watching` : '', go: 'Join', watch: r.players > 0 && r.watch > 0, w, players: r.players > 0 });      // players: a human is sitting there waiting. segs: who, in pieces: [name, registered] | plain text
    else if (k === 'ask') out.push({ kind: k, code: r.code, who: `${human || 'A player'} vs Matt`, segs: [[human || 'A player', hr], ' vs Matt'], meta: sc(r), go: 'Ask to play', watch: r.watch > 0, w });
    else out.push({ kind: k, code: r.code, who: `${nm(r, 0) || 'Player 1'} vs ${nm(r, 1) || 'Player 2'}`, segs: [[nm(r, 0) || 'Player 1', rg(r, 0)], ' vs ', [nm(r, 1) || 'Player 2', rg(r, 1)]], meta: (r.live === false ? 'Starting' : sc(r)) + (w > 0 ? ` · ${w} watching` : ''), go: r.watch > 0 ? 'Watch' : 'Can’t watch', full: !(r.watch > 0), w }); }
  return out;
}
const tabOf = row => row.kind === 'full' ? 'full' : 'open';
function shown() {                                                                       // this tab's rows that match the search: codes that START with it first, then codes that contain it
  const all = rowsOf(), q = query, hit = r => !q || r.code.includes(q), pick = t => all.filter(r => tabOf(r) === t && hit(r));
  const order = rs => q ? [...rs.filter(r => r.code.startsWith(q)), ...rs.filter(r => !r.code.startsWith(q))] : rs;
  const o = pick('open'), open = order([...o.filter(r => r.kind === 'tour'), ...o.filter(r => r.kind === 'open' && r.players), ...o.filter(r => r.kind === 'ask'), ...o.filter(r => r.kind === 'open' && !r.players)]);      // tournaments, then someone waiting for an opponent (Join is instant and never refused), then a player vs Matt (Ask to play can be refused, and has a cooldown), then empty courts
  const full = order(pick('full').map((r, i) => [r, i]).sort((a, b) => b[0].w - a[0].w || a[1] - b[1]).map(a => a[0]));      // the most watched first (stable)
  return { open, full, all };
}
export function lobbyRooms(rooms = [], online = 0, tours = []) {
  list = { rooms: (Array.isArray(rooms) ? rooms : []).filter(r => r && typeof r.code === 'string'),       // no 12-row cap: the server lists at most ROOM_CAP courts and the list scrolls
    tours: (Array.isArray(tours) ? tours : []).filter(t => t && typeof t.code === 'string') };
  seen = true;
  { const lo = $('lobby-online'), was = !lo.hidden; lo.hidden = !(online > 1); if (swapText(lo, `${online} online`) && was && !lo.hidden) restart(lo, 'lob-pop'); }      // a count that moves hops      // 1 online is you: say nothing
  drawCourts();
}
// One state line under the list, exactly one of: down, loading, open empty, full empty, no match, rows. The list box keeps its height in every one.
export function courtsState() { const down = $('screen-lobby')?.classList.contains('is-down'), s = shown();
  return down ? 'down' : !seen ? 'loading' : s[filter].length ? 'rows' : query ? 'nomatch' : filter === 'open' ? 'empty-open' : 'empty-full'; }
const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const EYE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z"/><circle cx="12" cy="12" r="2.6"/></svg>';
function drawCourts() {
  const ul = $('room-list'); if (!ul) return;
  const s = shown(), st = courtsState(), rows = st === 'rows' ? s[filter] : [];
  const nn = st === 'loading' || st === 'down' ? () => '–' : n => String(n); for (const [id, v] of [['n-open', nn(s.open.length)], ['n-full', nn(s.full.length)]]) swapText($(id), v, view === 'courts' ? 'lob-pop' : '');      // the counts follow the search: a query shows which tab its matches are in. Loading or down: a dash, never a false 0
  const n = s.all.filter(r => r.kind !== 'full').length, sub = $('courts-n'); if (sub) { const t = `${n} open`, was = sub.textContent, off = !(seen && n); if (!off) setText(sub, t); sub.classList.toggle('is-off', off); if (!off && was && was !== t) restart(sub, 'pop'); }      // the home tile: never jumps
  for (const o of $('court-seg')?.children || []) { const yes = o.dataset.filter === filter; o.setAttribute('aria-checked', String(yes)); o.tabIndex = yes ? 0 : -1; }
  const key = [st, filter, query, ...rows.map(r => [r.kind, r.code, r.who, JSON.stringify(r.segs || null), r.meta, r.go, r.watch, r.full].join(':'))].join('|');
  if (key === roomsKey) return; roomsKey = key;                                          // the list arrives every second: only touch the DOM (and the focus) when something drawn changed
  const at = ul.contains(document.activeElement) ? document.activeElement : null, had = at && (at.dataset.watch || at.dataset.code), hadWatch = !!(at && at.dataset.watch),
    idx = at ? [...ul.querySelectorAll('.court-row')].indexOf(at.closest('li')?.firstElementChild) : -1;
  const mode = st + '|' + filter, fresh = mode !== drawnMode, before = new Map();
  if (!fresh && !reduced()) for (const li of ul.children) if (li.dataset.code) before.set(li.dataset.code, li.offsetTop);      // FLIP, first half: where each row sat, read BEFORE the wipe (a layout read between the wipe and the last append would clamp scrollTop to 0)
  ul.textContent = ''; ul.setAttribute('aria-busy', String(st === 'loading'));
  if (st === 'loading' || st === 'down') for (let i = 0; i < 4; i++) { const li = mk('li', 'court is-skel'); li.append(mk('span', 'court-row is-skel')); li.setAttribute('aria-hidden', 'true'); ul.append(li); }      // skeletons: nothing in them is focusable
  rows.forEach((r, i) => { const li = mk('li', 'court'), b = mk('button', 'room-row court-row' + (r.kind === 'full' ? ' is-full' : ''));
    li.dataset.kind = r.kind; b.dataset.code = r.code; b.dataset.nav = ''; b.tabIndex = i ? -1 : 0; if (r.kind === 'full') b.dataset.act = 'watch'; if (r.full) b.setAttribute('aria-disabled', 'true');
    const who = mk('span', 'court-who', r.segs ? '' : r.who); for (const g of r.segs || []) if (typeof g === 'string') who.append(g); else { const n = mk('span', 'court-name', g[0]); who.append(n); regBadge(n, g[1]); }      // a registered name gets its badge beside it, never in its text
    if (r.kind === 'tour') who.prepend(mk('span', 'badge-tour', 'Tournament'));
    const meta = mk('span', 'court-meta', r.meta); b.append(mk('b', 'court-code', r.code), who, meta, mk('span', 'court-go', r.go));
    li.dataset.code = r.code; if (fresh || !drawn.has(r.code)) { li.classList.add('lob-in'); li.style.setProperty('--i', fresh ? Math.min(i, 7) : 0); } else if (r.meta && drawn.get(r.code) !== r.meta) meta.classList.add('lob-pop');      // a court that just opened rises in (a new tab, or the list after the skeletons, staggers); a score or watcher change pops. Classes only here: no layout reads
    b.setAttribute('aria-label', `Court ${r.code}. ${r.who}.${r.meta ? ' ' + r.meta + '.' : ''} ${r.go}${r.watch ? '. Right arrow to watch' : ''}`); if (r.watch) b.setAttribute('aria-keyshortcuts', 'ArrowRight'); li.append(b);      // Watch is off the Tab order: say how to reach it
    if (r.watch) { const w = mk('button', 'btn btn-sm is-tall room-watch'); w.innerHTML = EYE_SVG; w.append('Watch'); w.dataset.watch = r.code; w.tabIndex = -1; w.setAttribute('aria-label', `Watch court ${r.code}`); li.append(w); }
    ul.append(li); });
  drawnMode = mode; drawn = new Map(rows.map(r => [r.code, r.meta]));
  for (const li of before.size ? ul.children : []) { const y = before.get(li.dataset.code); if (y == null) continue; const dy = y - li.offsetTop; if (Math.abs(dy) > 1) li.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 360, easing: 'cubic-bezier(.22,1,.36,1)' }); }      // FLIP, second half: rows that stayed glide to their new place, so a closed court's gap closes smoothly
  drawState(st, s); roomBar();
  if (at) { const all = [...ul.querySelectorAll('.court-row, .room-watch')], cr = [...ul.querySelectorAll('.court-row')];      // no selector built from a server string
    const to = all.find(e => hadWatch && e.dataset.watch === had) || all.find(e => !e.dataset.watch && e.dataset.code === had) || cr[Math.min(idx, cr.length - 1)] || $('court-search');
    if (to.classList.contains('court-row')) rove(to); to.focus({ preventScroll: true }); }
}
function drawState(st, s) {
  const p = $('room-empty'); if (!p) return; const was = p.dataset.state; p.textContent = ''; p.dataset.state = st; if (was !== st && st !== 'rows' && st !== 'loading') restart(p, 'lob-swap');      // a new message rises in; typing inside 'no match' does not flicker
  const btn = (text, fn) => { const b = mk('button', 'btn btn-sm is-tall', text); b.type = 'button'; b.addEventListener('click', fn); return b; };
  const q = query, other = filter === 'open' ? 'full' : 'open';
  if (st === 'down') p.append(mk('span', '', 'Courts will show when the connection is back.'));
  else if (st === 'loading') p.append(mk('span', 'vh', 'Loading courts'));
  else if (st === 'empty-open') p.append(mk('span', '', 'No open courts right now.'), s.full.length ? btn(`${s.full.length} to watch in Full`, () => { setFilter('full'); $('court-seg').querySelector('[aria-checked="true"]')?.focus(); }) : btn('Create court', () => { if (!needName()) lobbyView('create'); }));      // Create court is already beside the list: point at what can be watched instead
  else if (st === 'empty-full') p.append(mk('span', '', 'Nobody is playing right now.'));
  else if (st === 'nomatch') {
    const code = q.length === 4 && cleanCode(q) === q && !s.all.some(r => r.code === q);      // a whole code that is not listed: private courts only join by code
    p.append(mk('span', '', code ? `${q} isn’t listed. It may be a private court.` : `No courts match “${q}”.`));
    if (code) p.append(btn('Use this code', () => useCode(q)));
    else if (s[other].length) p.append(btn(`${s[other].length} in ${other === 'full' ? 'Full' : 'Open'}`, () => { setFilter(other); $('court-seg').querySelector('[aria-checked="true"]')?.focus(); }));
    p.append(btn('Clear search', () => { setQuery(''); $('court-search').focus(); }));
  }
}
function setFilter(f) { filter = f === 'full' ? 'full' : 'open'; try { localStorage.setItem('poddle.courts', filter); } catch { /* fine */ } drawCourts(); }
function setQuery(q) { query = (String(q || '').toUpperCase().match(CODE_OK) || []).join('').slice(0, 8); const i = $('court-search'); if (i && i.value !== query) i.value = query; drawCourts(); }
function useCode(c) { setCode(c); codeError(''); deal(); $('btn-join').focus({ preventScroll: true }); }
const deal = () => boxes().forEach((b, i) => { if (b.value) { b.style.setProperty('--i', i); restart(b, 'lob-fill'); } });      // the letters land box by box
const rove = row => { for (const r of $('room-list').querySelectorAll('.court-row')) r.tabIndex = r === row ? 0 : -1; };      // the list is one Tab stop: the arrows walk it
// "Court is full. Watch instead?" over the lobby. Yes -> on.watch(code). Either button closes it; so does askWatch(null) and leaving the lobby.
let askCode = null, askOutT = 0;
export const asking = () => askCode != null;
export function askWatch(code, title) {                                                // title: a tournament's own question ('This tournament has started. Watch instead?')
  const el = $('ask-watch'); if (!el) return; code = code == null ? null : String(code); if (code != null) setText($('ask-title'), title ? String(title) : 'Court is full. Watch instead?');
  if (code === askCode) return; const was = askCode; askCode = code; clearTimeout(askOutT); el.classList.remove('lob-out'); el.inert = false;
  if (code != null) el.hidden = false; else if (was != null && !reduced() && slots.menu === 'lobby' && !el.hidden) { el.classList.add('lob-out'); el.inert = true; askOutT = setTimeout(() => { el.classList.remove('lob-out'); el.inert = false; if (askCode == null) el.hidden = true; }, 200); } else el.hidden = true;      // it shrinks away instead of vanishing (ui.css .ask.lob-out), inert so Tab cannot land on Yes / No while it fades; the lobby is live again at once
  for (const e of document.querySelectorAll('#screen-lobby .menu-head, #screen-lobby .lobby-view, #name-row')) e.inert = code != null;      // the lobby behind it: no clicks, no Tab stops
  if (code != null) setTimeout(() => { if (askCode === code) $('btn-watch-yes').focus({ preventScroll: true, focusVisible: true }); }, 60);
  else if (was != null && slots.menu === 'lobby') setTimeout(() => { if (slots.menu === 'lobby' && !asking()) viewFocus().focus({ preventScroll: true }); }, 0);
}
export function lobbyBusy(busy) { $('screen-lobby').setAttribute('aria-busy', busy ? 'true' : 'false'); }
export function lobbyLink(up) { if ($('screen-lobby').classList.contains('is-down') === !up && !$('lobby-down').hidden === !up) return;      // called four times a second: only a change does anything
  $('lobby-down').hidden = up; $('screen-lobby').classList.toggle('is-down', !up); if (!up) { list = { rooms: [], tours: [] }; seen = false; $('lobby-online').hidden = true; } drawCourts(); }      // a list from before the drop is not worth tapping; back up, it is 'loading' until the first list
export function codeError(text) {
  setText($('code-err'), text); $('code-boxes').classList.toggle('is-bad', !!text);
  if (text) { const cb = $('code-boxes'); restart(cb, 'is-error'); cb.addEventListener('animationend', function done(e) { if (e.target !== cb || e.animationName !== 'nudge') return; cb.removeEventListener('animationend', done); cb.classList.remove('is-error'); }); boxes()[3].focus(); }
}
function setCode(code) { boxes().forEach((b, i) => { b.value = code[i] || ''; }); codeReady(); }
const getCode = () => boxes().map(b => b.value).join('');
export const typedCode = () => getCode();                                                // what is in the code boxes (a join from them answers under them)
function codeReady() { const off = getCode().length < 4; for (const id of ['btn-join', 'btn-watch-code']) { const b = $(id); if (b) { if (off && document.activeElement === b) boxes()[3].focus(); b.disabled = off; } } }      // Join and Watch: four letters, or neither
// room: the code I am seated in (null = none). link: the address to share, or '' when this page is only reachable on this computer.
// the connection, said quietly: four bars and the round trip. It never turns red and never interrupts; a slow link just shows fewer bars.
export function setPing(ms) { const el = $('ping-pill'); if (!el) return; el.hidden = !(ms > 0); if (!(ms > 0)) return; const r = Math.round(ms);
  el.dataset.bars = r < 60 ? 4 : r < 110 ? 3 : r < 180 ? 2 : 1; setText($('ping-ms'), r + ' ms'); el.title = 'Ping'; }
export function setRoom(code, link = '') {
  $('room-pill').hidden = $('room-menu').hidden = !code; setText($('room-code'), code || ''); $('room-menu').classList.toggle('no-link', !link);      // no link on localhost: no drop-down, promise nothing
  for (const b of document.querySelectorAll('.screen:not(#screen-lobby) [data-back]')) b.hidden = !code;      // set-up screens: Back only when there is a lobby to go back to
  [...$('share-code').children].forEach((el, i) => setText(el, code ? code[i] : ''));
  $('share-row').hidden = !link; setText($('share-link'), link.replace(/^https?:\/\//, '')); $('share-link').dataset.href = link;
}
export function backLabel(text) { for (const t of document.querySelectorAll('.screen .back-text')) setText(t, text); }      // 'Cancel' while a paddle swap mid-game can still be undone
export function titleRoom(code, watch) { $('title-room').hidden = !code; setText($('title-room-code'), code || ''); setText($('title-room-spec'), watch ? '\u00a0as spectator' : ''); }     // opened from a shared link (&watch=1: 'as spectator')
// What lands on the clipboard: a line to paste into a chat, then the link.
const INVITE = { play: 'Play me in Poddle, pickleball with your phone as the paddle:', watch: 'Watch me play Poddle, pickleball with your phone as the paddle:' };
async function copyLink(btn, watch) {      // watch: the viewer link (&watch=1), which opens the court as a spectator
  let href = $('share-link').dataset.href; if (!href) return;
  if (watch) { const u = new URL(href); u.searchParams.set('watch', '1'); href = u.href; }
  href = INVITE[watch ? 'watch' : 'play'] + ' ' + href;
  try { await navigator.clipboard.writeText(href); } catch { const t = document.createElement('textarea'); t.value = href; t.style.cssText = 'position:fixed;opacity:0'; document.body.append(t); t.select(); try { document.execCommand('copy'); } catch { /* nothing more to try */ } t.remove(); }
  if (btn.id === 'btn-copy') { const l = $('copy-label'); setText(l, 'Copied'); restart(l, 'lob-pop'); clearTimeout(copyT); copyT = setTimeout(() => setText(l, 'Copy link'), 1500); } else on.copied && on.copied(watch);
}
let copyT = 0;
// Two copy menus, one way of working: the share screen's Copy link and the court pill in the HUD corner. Hover (or a tap) drops the choices.
const COPY = [['copy-menu', 'btn-copy'], ['room-menu', 'room-pill']];
const copyOpen = (m, open) => { $(m).classList.toggle('is-open', open); $(COPY.find(c => c[0] === m)[1]).setAttribute('aria-expanded', open); };
{
  // no name, no seat: every choice on the home view waits for it (the field shakes and takes focus), and so does the last button of each view
  $('btn-quick').addEventListener('click', () => { if (!needName() && on.quick) on.quick(); });
  on2('btn-courts', 'click', () => { if (!needName()) lobbyView('courts'); });
  on2('btn-create', 'click', () => { if (!needName()) lobbyView('create'); });
  on2('btn-tour', 'click', () => { if (ts && !ts.you?.viewer && ts.phase !== 'done') { tcall('open'); return; } if (!needName()) tcall('create'); });      // one press makes one (docs/COURTS-TOURNEY.md 4.6 item 1). Already in one: Your tournament
  on2('btn-watch-code', 'click', () => { const c = getCode(); if (c.length === 4 && !needName() && on.watch) on.watch(c); });
  on2('btn-bot', 'click', () => { if (!needName()) lobbyView('bot'); });
  on2('btn-profile', 'click', () => lobbyView('profile'));      // no name needed: nobody is seated
  on2('btn-leaderboard', 'click', () => lobbyView('leaderboard')); on2('st-place', 'click', () => lobbyView('leaderboard'));      // the global leaderboard, from its tile or from the #301 beside the rank on Your stats
  on2('btn-ranked', 'click', () => { if (!needName()) lobbyView('ranked'); });      // Ranked seats you: it needs a name, like Quick play
  on2('btn-ranked-go', 'click', () => { if (!needName() && on.ranked) on.ranked(); });
  on2('btn-rk-warm', 'click', () => { if (on.rkWarm) on.rkWarm(); }); on2('btn-rk-cancel', 'click', () => { if (on.rkCancel) on.rkCancel(); });      // the search bar (OPTIONAL WARM-UP): its two actions
  on2('btn-rk-all', 'click', () => lobbyView('ranks')); on2('btn-rkx-go', 'click', () => lobbyView('ranked'));      // the Ranks page, and back into Ranked from it
  for (const id of ['st-crest', 'rk-emblem']) { const el = $(id); if (!el) continue;      // the medal itself opens the Ranks page: a button in all but tag
    el.setAttribute('role', 'button'); el.tabIndex = 0; el.title = 'See all ranks'; el.setAttribute('aria-label', 'See all ranks'); el.classList.add('is-link');
    el.addEventListener('click', () => lobbyView('ranks')); el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); lobbyView('ranks'); } }); }
  $('btn-create-go').addEventListener('click', () => { if (!needName() && on.create) on.create($('seg').querySelector('[aria-checked="true"]').dataset.public === '1'); });
  on2('bot-levels', 'click', e => { const b = e.target.closest('[data-level]'); if (b && !needName() && on.bot) on.bot(+b.dataset.level); });       // one click plays: no second confirm
  on2('lobby-bot', 'keydown', e => { let d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]; if (!d) return; e.preventDefault(); const bs = [...$('bot-levels').children], i = bs.indexOf(document.activeElement);
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && getComputedStyle($('bot-levels')).gridTemplateColumns.split(' ').length === 2) d *= 2;      // two by two: up and down move a row
    bs[(i < 0 ? 1 : i + d + bs.length) % bs.length].focus(); });
  on2('name-input', 'input', e => keepName(e.currentTarget));
  on2('name-input', 'blur', e => { e.currentTarget.value = cleanName(e.currentTarget.value); });
  on2('name-input', 'keydown', e => { if (e.key !== 'Enter' && e.key !== 'ArrowDown') return; e.preventDefault(); if (!needName()) viewFocus().focus({ preventScroll: true, focusVisible: true }); });     // Enter: on to Quick play
  on2('btn-watch-yes', 'click', () => { const c = askCode; askWatch(null); if (c && on.watch) on.watch(c); });
  on2('btn-watch-no', 'click', () => askWatch(null));
  on2('ask-watch', 'keydown', e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); $(e.key === 'ArrowLeft' ? 'btn-watch-yes' : 'btn-watch-no').focus(); } });
  $('btn-share-go').addEventListener('click', () => on.start && on.start());
  for (const [m, b] of COPY) {
    $(b).addEventListener('click', () => { if (!$(m).classList.contains('no-link')) copyOpen(m, !$(m).classList.contains('is-open')); });      // a touch screen has no hover: a tap opens the choices
    $(m).addEventListener('click', e => { const o = e.target.closest('[data-copy]'); if (!o) return; copyLink($(b), o.dataset.copy === 'watch'); copyOpen(m, false); if (o.matches(':focus-visible')) $(b).focus(); else o.blur(); });
    $(m).addEventListener('keydown', e => { const os = [...$(m).querySelectorAll('.copy-opt')], i = os.indexOf(document.activeElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); os[i < 0 ? (e.key === 'ArrowDown' ? 0 : 1) : (i + 1) % 2].focus(); } else if (e.key === 'Escape') { copyOpen(m, false); $(b).blur(); } });
  }
  document.addEventListener('pointerdown', e => { for (const [m] of COPY) if (!e.target.closest('#' + m)) copyOpen(m, false); });
  for (const b of document.querySelectorAll('[data-back]')) b.addEventListener('click', () => on.back && on.back());
  $('room-list').addEventListener('click', e => { const w = e.target.closest('.room-watch'), b = e.target.closest('button.room-row'); if (!w && !b || b && b.getAttribute('aria-disabled') === 'true' || needName()) return;
    if (w) { if (on.watch) on.watch(w.dataset.watch); } else if (b.dataset.act === 'watch') { if (on.watch) on.watch(b.dataset.code); } else if (on.join) on.join(b.dataset.code); });      // an Ask to play row joins too: the server turns it into watch + ask
  // the list: one Tab stop. Up / Down walk the rows (Up on the first goes back to search), Home / End, Right = the row's Watch, Left = back to the row
  $('room-list').addEventListener('keydown', e => { const rs = [...$('room-list').querySelectorAll('.court-row')], a = document.activeElement, row = a.classList.contains('room-watch') ? a.closest('li').firstElementChild : a, i = rs.indexOf(row); if (i < 0) return;
    const go = r => { e.preventDefault(); rove(r); r.focus(); r.scrollIntoView({ block: 'nearest' }); };
    if (e.key === 'ArrowDown') { if (rs[i + 1]) go(rs[i + 1]); else e.preventDefault(); } else if (e.key === 'ArrowUp') { if (i > 0) go(rs[i - 1]); else { e.preventDefault(); $('court-search').focus(); } }
    else if (e.key === 'Home') go(rs[0]); else if (e.key === 'End') go(rs[rs.length - 1]);
    else if (e.key === 'ArrowRight' && a === row) { const w = row.parentElement.querySelector('.room-watch'); if (w) { e.preventDefault(); w.focus(); } } else if (e.key === 'ArrowLeft' && a !== row) { e.preventDefault(); row.focus(); } });
  on2('court-search', 'input', e => { const c = e.currentTarget.selectionStart; setQuery(e.currentTarget.value); try { e.currentTarget.setSelectionRange(c, c); } catch { /* fine */ } });
  on2('court-search', 'keydown', e => { const rs = [...$('room-list').querySelectorAll('.court-row')];
    if (e.key === 'ArrowDown') { if (rs[0]) { e.preventDefault(); rove(rs[0]); rs[0].focus(); } }
    else if (e.key === 'Enter') { e.preventDefault(); if (rs.length === 1) rs[0].click(); else if (query.length === 4 && cleanCode(query) === query && !rs.some(r => r.dataset.code === query)) useCode(query); }      // never submits anything by itself
    else if (e.key === 'Escape' && e.currentTarget.value) { e.preventDefault(); e.stopPropagation(); setQuery(''); } });      // a query is cleared before Esc goes Back (main.js never hears it)
  on2('court-seg', 'click', e => { const o = e.target.closest('.seg-opt'); if (o) setFilter(o.dataset.filter); });
  on2('court-seg', 'keydown', e => { if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return; e.preventDefault(); setFilter(e.key === 'ArrowLeft' ? 'open' : 'full'); $('court-seg').querySelector('[aria-checked="true"]')?.focus(); });
  document.addEventListener('keydown', e => { if (e.key !== '/' || view !== 'courts' || slots.menu !== 'lobby' || asking() || e.target.tagName === 'INPUT' || e.metaKey || e.ctrlKey || e.altKey) return; e.preventDefault(); $('court-search').focus(); });      // '/' = search, the web's usual key, anywhere on Courts
  const pick = opt => { for (const o of $('seg').children) { const yes = o === opt; o.setAttribute('aria-checked', yes); o.tabIndex = yes ? 0 : -1; } swapText($('seg-note'), opt.dataset.public === '1' ? 'Shows in the court list' : 'Join by code only', 'lob-swap'); };      // the note changes with the thumb
  $('seg').addEventListener('click', e => { const o = e.target.closest('.seg-opt'); if (o) pick(o); });
  $('lobby-create').addEventListener('keydown', e => { if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return; e.preventDefault(); const o = $('seg').children[e.key === 'ArrowLeft' ? 0 : 1]; pick(o); if ($('seg').contains(document.activeElement)) o.focus(); });   // Left = Public, Right = Private, from anywhere on the card
  // code boxes: type, paste (a code or a whole link), Backspace walks back, arrows move, Enter joins
  const form = $('lobby-code'), fill = (from, text) => { const bs = boxes(), chars = cleanCode(text); if (chars.length === 4) from = 0;
    [...chars].forEach((c, i) => { const b = bs[from + i]; if (b) { b.value = c; b.style.setProperty('--i', i); restart(b, 'lob-fill'); } });      // each letter lands with a pop; a paste deals them
    (bs[Math.min(3, from + chars.length)] || bs[3]).focus(); codeReady(); codeError(''); };
  form.addEventListener('input', e => { const b = e.target, i = boxes().indexOf(b); if (i < 0) return; const t = b.value; b.value = ''; if (cleanCode(t)) fill(i, t); else codeReady(); });
  form.addEventListener('paste', e => { e.preventDefault(); fill(0, (e.clipboardData || window.clipboardData).getData('text')); });
  form.addEventListener('focusin', e => { if (e.target.select) e.target.select(); });
  form.addEventListener('keydown', e => { const bs = boxes(), i = bs.indexOf(e.target); if (i < 0) return;
    if (e.key === 'Backspace' && !e.target.value && i > 0) { e.preventDefault(); bs[i - 1].value = ''; restart(bs[i - 1], 'lob-clear'); bs[i - 1].focus(); codeReady(); }
    else if (e.key === 'ArrowLeft' && i > 0) { e.preventDefault(); bs[i - 1].focus(); } else if (e.key === 'ArrowRight' && i < 3) { e.preventDefault(); bs[i + 1].focus(); }
    else if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); $('btn-watch-code').click(); } });      // Enter = Join (the form), Shift+Enter = Watch
  form.addEventListener('submit', e => { e.preventDefault(); const c = getCode(); if (c.length === 4 && !needName() && on.join) on.join(c); });
  // arrows walk the three tiles (Tab works too)
  $('lobby-home').addEventListener('keydown', e => { const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]; if (!d) return;
    const nav = [...$('lobby-home').querySelectorAll('[data-nav]:not([hidden])')], i = nav.indexOf(document.activeElement); e.preventDefault(); nav[(i < 0 ? 0 : i + d + nav.length) % nav.length].focus(); });      // hidden tiles (Ranked, Your stats on localhost) are not in the ring: focus() on one is a no-op
}

// ---------- sliding segmented controls ----------
// Every .seg draws its pick as one thumb (.seg::before, ui.css) that slides to the checked option instead of the highlight jumping.
// Options differ in width (Rookie / Club, 'Open 12'), so the thumb is measured from the option. One observer per seg catches every
// aria-checked write, wherever in this file it comes from; a hidden seg (settings closed) measures 0 and is placed, unanimated, when it shows.
{
  const place = seg => {
    const on = seg.querySelector(':scope > [aria-checked="true"]');
    if (!on || !seg.offsetWidth) { seg.classList.remove('has-thumb'); return; }
    const first = !seg.classList.contains('has-thumb');
    if (first) seg.classList.add('thumb-still');
    const s = seg.style; s.setProperty('--tx', on.offsetLeft + 'px'); s.setProperty('--ty', on.offsetTop + 'px'); s.setProperty('--tw', on.offsetWidth + 'px'); s.setProperty('--th', on.offsetHeight + 'px');
    seg.classList.add('has-thumb');
    if (first) { void seg.offsetWidth; requestAnimationFrame(() => seg.classList.remove('thumb-still')); }
  };
  const segs = document.querySelectorAll('.seg');
  const mo = new MutationObserver(ms => { for (const seg of new Set(ms.map(m => m.target.parentElement))) if (seg?.classList.contains('seg')) place(seg); });
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(es => { for (const seg of new Set(es.map(e => e.target.closest('.seg')))) if (seg) place(seg); }) : null;
  for (const seg of segs) { mo.observe(seg, { subtree: true, attributes: true, attributeFilter: ['aria-checked'] }); ro?.observe(seg); for (const o of seg.children) ro?.observe(o); place(seg); }
}
// ---------- tournaments (docs/COURTS-TOURNEY.md 4.6) ----------
// Drawn from the server's snapshot { code, phase, n, max, host, players, rounds, next, champ, you } (setTour), nothing kept of its own:
// the host's code screen (lobby view 'tour'), the pill and the card in a warm-up, the VS card, the bracket (lobby view 'bracket'),
// the champion card and the ended notice. main.js owns the socket and says which snapshot. Every name goes in as textContent.
const TROPHY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4h10v5a5 5 0 0 1-10 0Z"/><path d="M7 6H4v1.5A3.5 3.5 0 0 0 7.5 11M17 6h3v1.5a3.5 3.5 0 0 1-3.5 3.5M12 14v3M8.5 20h7M10 17h4v3h-4Z"/></svg>';
let tourH = {}, ts = null, tLink = '', tKind = null, tCard = false, tSaidN = -1, tLeaveAt = 0, brTab = null, brKey = '', brNext = '', tcKey = '', tourKey = '';
export function onTour(h) { tourH = h || {}; }      // { create(), open(), warm(), start(), leave(), watch(room), bracket(), courts(), cardOpen(), cardClose() }
const tcall = (k, ...a) => { if (tourH[k]) tourH[k](...a); };
const tnm = v => String(v == null ? '' : v).slice(0, 24);
const tPlayers = s => (s && Array.isArray(s.players) ? s.players : []).filter(p => p && typeof p === 'object' && !p.left);
const tOn = s => tPlayers(s).filter(p => p.on !== false).length;      // Start counts who is here now
const who = p => !p ? 'To be decided' : p.bot ? 'Matt' : tnm(p.name) || 'To be decided';
export const tourSnap = () => ts;
// the snapshot to draw (null: no tournament). o = { link } the invite address ('' on localhost: a link is no use to a friend)
export function setTour(s, o = {}) {
  ts = s && typeof s === 'object' && typeof s.code === 'string' ? s : null; if (o.link != null) tLink = String(o.link);
  setText($('btn-tour-label'), ts && !ts.you?.viewer && ts.phase !== 'done' ? 'Your tournament' : 'Create tournament');      // Courts: back to the one you are in
  if (!ts) { tourCard(false); drawPill(); return; }
  drawTour(); drawCard(); drawPill(); drawBracket();
}
// ---- the code screen (the host's, and a guest's without Start)
function drawTour() {
  const s = ts; if (!s || !$('lobby-tour')) return;
  const you = s.you || {}, host = !!you.host, viewer = !!you.viewer, n = tPlayers(s).length, on = tOn(s), max = s.max | 0 || 16, ready = on >= 4;
  [...$('tour-code').children].forEach((el, i) => setText(el, s.code[i] || '')); $('tour-code').setAttribute('aria-label', `Tournament code ${[...s.code].join(' ')}. Copy the code`);
  let jh = ''; try { jh = tLink ? new URL(tLink).host : ''; } catch {} setText($('tour-join-at'), jh ? `Join at ${jh}` : 'Join in Courts');      // Kahoot's 'Join at kahoot.it': where to type the code, readable across a room. Never a host the invite does not use (localhost has no link)
  setText($('tour-link'), tLink.replace(/^https?:\/\//, '')); $('tour-link').hidden = !tLink; if (!copiedT) setText($('tour-copy-label'), tLink ? 'Copy invite' : 'Copy code');
  const num = $('tour-n-num'), was = num.textContent; if (was !== String(n)) { setText(num, String(n)); if (was && +was < n) restart(num, 'pop'); }      // the count pops once when someone joins (not under reduced motion: ui.css)
  setText($('tour-n-of'), `of ${max}`); show('tour-n-of', n < max);      // full: 'Full: 16 players' says it
  names($('tour-names'), s, 9);
  setText($('tour-why'), n >= max ? `Full: ${max} players` : !ready ? `Needs at least 4 players · ${4 - on} more` : 'Ready to start');      // Matt's odd spot is the rules line's (a guest never sees this line once it is ready)
  setText($('tour-rules'), `Knockout. Matches go to ${s.win | 0 || 7}, the final to ${s.final | 0 || 11}. With an odd number of players, Matt fills the empty spot.`);
  if (!copiedT) setText($('tour-copied'), `${tapWord()} the code to copy it`);
  $('tour-why').classList.toggle('is-ready', ready); $('tour-why').hidden = !host && ready;      // a guest reads the count only while it is short; then who they wait for
  show('tour-wait', !host && (ready || viewer)); setText($('tour-wait-text'), `Waiting for ${tnm(s.host) || 'the host'} to start`);
  const start = $('btn-tour-start'); start.hidden = !host; start.disabled = !ready; start.classList.toggle('is-focus', host && ready); setText($('tour-start-label'), ready ? `Start with ${on} players` : 'Start tournament');
  const warm = $('btn-tour-warm'); warm.hidden = viewer || you.warm === 'on'; warm.classList.toggle('is-focus', !host || n >= 2 && !ready); $('btn-tour-copy').classList.toggle('is-focus', host && n < 2);      // one glow at a time: alone, share the code; then warm up; from 4, Start
  setText($('tour-warm-label'), you.warm === 'full' ? 'Try warm-up again' : 'Warm up with Matt');
  show('tour-warmfull', !viewer && you.warm === 'full');
  $('lobby-tour').classList.toggle('is-guest', !host);
  setText($('btn-tour-leave'), viewer ? 'Stop watching' : host && n <= 1 ? 'Cancel tournament' : 'Leave tournament');
  setText($('tour-confirm-q'), host && n > 1 ? 'Leave? The next player becomes host.' : host ? 'Cancel it? Nobody else has joined.' : 'Leave the tournament?');
}
// the name chips: who is in, the host and you marked, someone reconnecting dimmed, dashed places up to the 4 a start needs. New ones pop in.
const chipSeen = new WeakMap();
function names(ul, s, cap) {
  if (!ul) return; const ps = tPlayers(s), me = s.you && s.you.id, list = ps.length > cap ? ps.slice(0, cap - 1) : ps, more = ps.length - list.length;
  const key = JSON.stringify([list.map(p => [p.id, p.name, p.reg === true, p.host, p.on, p.id === me]), more]); if (ul.dataset.key === key) return; ul.dataset.key = key;
  const first = !chipSeen.has(ul), seen = chipSeen.get(ul) || new Set(); ul.textContent = '';
  for (const p of list) { const li = mk('li', 'tour-chip' + (p.on === false ? ' is-off' : '') + (p.id != null && p.id === me ? ' is-you' : '') + (!first && !seen.has(p.id) ? ' is-new' : ''));
    { const n = mk('span', 'tour-chip-name', tnm(p.name) || 'Player'); li.append(n); regBadge(n, p.reg === true); }      // a registered username: the badge beside it (docs/ACCOUNTS.md 7.5)
    if (p.on === false) li.append(mk('span', 'tour-tag is-off', 'Reconnecting')); else if (p.id != null && p.id === me) li.append(mk('span', 'tour-tag is-you', 'You')); else if (p.host) li.append(mk('span', 'tour-tag', 'Host'));
    ul.append(li); seen.add(p.id); }
  if (more > 0) ul.append(mk('li', 'tour-chip is-more', `+${more} more`));
  for (let i = ul.childElementCount; i < 4; i++) { const li = mk('li', 'tour-chip is-empty'); li.setAttribute('aria-hidden', 'true'); ul.append(li); }
  chipSeen.set(ul, seen);
}
export function tourConfirm(on) { const c = $('tour-confirm'); if (!c) return; c.hidden = !on; $('btn-tour-leave').hidden = !!on; if (on) setTimeout(() => $('btn-tour-leave-no')?.focus({ preventScroll: true }), 0); }      // Stay has focus: Enter never leaves by accident
// ---- copying: the code alone (a click on it), or the invite (a line to paste, then the link)
let copiedT = 0;
async function clip(text) { try { await navigator.clipboard.writeText(text); } catch { const t = document.createElement('textarea'); t.value = text; t.style.cssText = 'position:fixed;opacity:0'; document.body.append(t); t.select(); try { document.execCommand('copy'); } catch { /* nothing more to try */ } t.remove(); } }
const invite = () => ts ? (tLink ? `Join my Poddle tournament. Code ${ts.code}: ${tLink}` : ts.code) : '';
const tapWord = () => (matchMedia('(hover: none)').matches ? 'Tap' : 'Click');      // a phone is never clicked
function copied(labelId, text, back) { const l = $(labelId); if (!l) return; setText(l, text); clearTimeout(copiedT); copiedT = setTimeout(() => { copiedT = 0; setText(l, back()); }, 1500); }
// ---- the HUD: a pill in the corner while in one of its courts (warm-up: the count; a match: the round and who), and the host's Start
export function tourCourt(kind) { tKind = kind === 'warm' || kind === 'match' ? kind : null; if (tKind) document.body.dataset.tour = tKind; else delete document.body.dataset.tour; if (tKind !== 'warm') tourCard(false); drawPill(); }
function myMatch(s) { const id = s.you && s.you.id; if (id == null) return null;
  for (let i = (s.rounds || []).length - 1; i >= 0; i--) for (const x of s.rounds[i].matches || []) if (x.a && x.a.id === id || x.b && x.b.id === id) return { round: tnm(s.rounds[i].name), vs: who(x.a && x.a.id === id ? x.b : x.a) };
  return null; }
function drawPill() {
  const p = $('tour-pill'), go = $('btn-tour-go'); if (!p) return; const s = ts, on = !!(s && tKind && (tKind === 'match' || s.phase === 'reg'));
  p.hidden = !on; if (!on) { if (go) go.hidden = true; tSaidN = -1; return; }
  const n = tPlayers(s).length, host = !!(s.you && s.you.host), m = tKind === 'match' ? myMatch(s) : null;
  setText($('tour-pill-long'), m ? `${m.round} · vs ${m.vs}` : tKind === 'match' ? 'Tournament match' : 'Waiting for the tournament to start');
  setText($('tour-pill-short'), m ? m.round : tKind === 'warm' ? 'Waiting' : 'Tournament');      // a narrow window: the warm-up still says what the count is for ('Waiting' over '5 joined'; the label reads it all out)
  const b = $('tour-pill-n'), t = tKind === 'warm' ? `${n} joined` : ''; if (b.textContent !== t) { setText(b, t); if (t && tSaidN >= 0 && n > tSaidN) restart(b, 'pop'); }
  if (tKind === 'warm' && n !== tSaidN) { if (tSaidN >= 0) setText($('tour-live'), `${n} joined`); tSaidN = n; }      // read out on a change only
  p.setAttribute('aria-label', `${m ? `${m.round}, versus ${m.vs}` : `Waiting for the tournament to start, ${n} joined`}. Tournament details (T)`);
  if (go) { go.hidden = !(tKind === 'warm' && host && s.phase === 'reg' && tOn(s) >= 4); go.setAttribute('aria-label', `Start tournament with ${tOn(s)} players`); }
}
// someone joined while you warm up: the watcher card's place and look, with a trophy
export function tourNote(name) {
  const box = $('notices'); if (!box) return; while (box.childElementCount >= 3) box.firstElementChild.remove();
  const el = document.createElement('div'), t = document.createElement('span'); el.className = 'notice is-tour'; el.innerHTML = TROPHY;
  t.textContent = name ? `${tnm(name)} joined the tournament` : 'Someone joined the tournament'; el.append(t); box.append(el);
  setTimeout(() => { el.classList.add('is-out'); setTimeout(() => el.remove(), 400); }, 3600);
}
// ---- the card (T, or the pill): code, invite, count, names, the host's Start, Leave (press twice). It pauses the warm-up, like settings
function drawCard() {
  const s = ts; if (!s || !$('tour-card')) return; const you = s.you || {}, host = !!you.host, n = tPlayers(s).length, on = tOn(s), max = s.max | 0 || 16;
  setText($('tc-code-text'), s.code); if (!copiedT) setText($('tc-copied'), `${tapWord()} to copy`); setText($('tc-n'), String(n)); setText($('tc-of'), `of ${max} joined`); if (!copiedT) setText($('tc-copy-label'), tLink ? 'Copy invite' : 'Copy code');
  names($('tc-names'), s, 12);
  setText($('tc-why'), host ? (on >= 4 ? '' : `Needs at least 4 players · ${4 - on} more`) : `Waiting for ${tnm(s.host) || 'the host'} to start`); show('tc-why', !!$('tc-why').textContent);
  const st = $('btn-tc-start'); st.hidden = !(host && on >= 4 && s.phase === 'reg'); setText(st, `Start with ${on} players`);
  if (!tLeaveAt) setText($('btn-tc-leave'), 'Leave tournament');
}
export function tourCard(open) {
  if (open === undefined) return tCard;
  open = !!open && !slots.menu && !slots.overlay && !!ts && tKind === 'warm'; if (open === tCard) return tCard;
  const el = $('tour-card'), p = $('tour-pill'); if (!el) return false;
  if (open) settings(false);
  const had = el.contains(document.activeElement);      // asked before it hides: a hidden card has already let go of focus, and it went nowhere (the pill never got it back)
  tCard = open; el.hidden = !open; p?.setAttribute('aria-expanded', String(open)); tLeaveAt = 0;
  if (open) { document.body.dataset.tourcard = 'open'; drawCard(); placeCard(); el.focus({ preventScroll: true }); }
  else { delete document.body.dataset.tourcard; if (had) { if (p && !p.hidden && !slots.menu && !slots.overlay) p.focus({ preventScroll: true }); else document.activeElement.blur(); } }
  tcall(open ? 'cardOpen' : 'cardClose');
  return tCard;
}
function placeCard() {                                     // under the corner (it wraps to two rows with the pill), and under the scoreboard where they meet: as settings does
  const el = $('tour-card'), board = $('board'); if (!el || el.hidden) return; let y = 0;
  for (const c of $('corner').children) if (c.id !== 'dev' && c.offsetParent) y = Math.max(y, c.getBoundingClientRect().bottom);
  const r = el.getBoundingClientRect(), b = board ? board.getBoundingClientRect() : null; if (b && b.width && b.left < r.right && b.right > r.left) y = Math.max(y, b.bottom);
  el.style.setProperty('--set-top', `calc(${Math.round(y)}px + .5rem)`);
}
addEventListener('resize', placeCard);
// ---- the VS card: m = the server's tmove { round, name, n, of, vs:{ name, bot }, target, final, at } | null
export function tourVs(m) {
  if (!m || typeof m !== 'object') { if (slots.overlay === 'tour-vs') showOverlay(null); return; }
  const of = m.of | 0, name = tnm(m.name) || 'Next round', bot = !!(m.vs && m.vs.bot);
  setText($('vs-round'), of > 1 ? `${name} · Match ${m.n | 0} of ${of}` : name);
  setText($('vs-them'), bot ? 'Matt' : tnm(m.vs && m.vs.name) || 'Opponent'); show('vs-them-tag', bot); regBadge($('vs-them'), !bot && !!m.vs && m.vs.reg === true);
  rankBadge($('vs-them'), !bot && m.vs ? m.vs : null); rankBadge($('vs-me'), m.you || null);      // a Ranked draw carries both ranks ({ tier, div }, docs/RANKED.md 8.3); a tournament's has none
  setText($('vs-target'), `First to ${m.target | 0 || (m.final ? 11 : 7)}, win by 2`);      // the round line above already says Final
  vsPlain(); showOverlay('tour-vs'); restart($('vs-card'), 'go');
}
// ---- the bracket: one column per round, the rounds still to come drawn as To be decided. Your matches lit, Matt marked, live scores and Watch
function roundNow(s) { const rs = s.rounds || []; let i = 0; rs.forEach((r, k) => { if ((r.matches || []).some(x => x.a && (x.a.name || x.a.bot))) i = k; }); return i; }
function drawBracket() {
  const s = ts, box = $('bracket'); if (!s || !box) return;
  const you = s.you || {}, id = you.id, rs = Array.isArray(s.rounds) ? s.rounds : [], cur = roundNow(s), champ = s.champ, mine = x => id != null && (x.a && x.a.id === id || x.b && x.b.id === id);
  const live = rs[cur] && (rs[cur].matches || []).find(x => mine(x) && !x.w), upcoming = rs.find((r, k) => k > cur && (r.matches || []).every(x => !x.a || !(x.a.name || x.a.bot)));
  setText($('br-you'), s.phase === 'done' && champ ? (champ.id != null && champ.id === id ? 'You’re the champion' : `${champ.bot ? 'Matt' : tnm(champ.name)} is the champion`)
    : you.viewer ? (tnm(s.host) ? `Watching ${tnm(s.host)}’s tournament` : 'Watching a tournament') : s.phase === 'reg' ? 'The bracket is drawn when the host starts' : you.out ? 'You’re out. Stay and watch, or leave any time.'
    : live ? 'Your match is next' : 'You’re through. Your next match starts when the round ends.');
  $('br-you').classList.toggle('is-out', !!you.out && !you.viewer); if (!tLeaveAt) setText($('btn-br-leave'), you.viewer ? 'Stop watching' : 'Leave tournament');      // not mid press-twice: a snapshot then must not wipe 'Press again'
  const nx = s.next && typeof s.next === 'object' ? s.next : null, left = nx ? Math.max(0, Math.round(+nx.in || 0)) : 0;
  show('br-next', !!nx && s.phase === 'play');
  if (nx) { const k = nx.what + ':' + rs.length + ':' + cur; if (k !== brNext) { brNext = k; brEnd = performance.now() + left * 1000; brDur = Math.max(1, left); }      // one drain per wait, from the server's seconds; counted here (a snapshot only comes on a change)
    brLabel = nx.what === 'round' ? `${upcoming ? tnm(upcoming.name) : 'Next round'} in` : 'Matches start in'; tickNext(); if (!brTick) brTick = setInterval(tickNext, 250); }
  else { brNext = ''; clearInterval(brTick); brTick = 0; }
  if (brTab == null || brTab >= rs.length || cur !== brCur) { brTab = cur; brCur = cur; }      // the tabs open on the round being played, and follow it to the next
  const key = JSON.stringify([rs, id, cur]); if (key !== brKey) { brKey = key;
    const at = box.contains(document.activeElement) && document.activeElement.dataset.room ? document.activeElement.dataset.room : null, atYou = box.contains(document.activeElement) && document.activeElement.matches('.br-match.is-you');      // atYou: your own card had focus. Every live score redraws the box
    box.textContent = ''; box.classList.toggle('is-big', rs.length > 0 && (rs[0].matches || []).length > 4);
    rs.forEach((r, k) => { const col = mk('section', 'br-col' + (k === cur ? ' is-current' : '') + (k === brTab ? ' is-shown' : '')), ol = mk('ol', 'br-list'); col.dataset.round = String(k);
      const h = mk('h3', 'br-round', tnm(r.name) || `Round ${k + 1}`); h.append(mk('small', '', `First to ${r.target | 0 || 7}`)); col.append(h);
      for (const x of r.matches || []) { const drawn = x.a && (x.a.name || x.a.bot) || x.b && (x.b.name || x.b.bot), li = mk('li', 'br-match' + (mine(x) ? ' is-you' : '') + (x.live ? ' is-live' : '') + (x.w ? ' is-done' : '') + (drawn ? '' : ' is-tbd')); if (mine(x) && k === cur && !you.viewer && !you.out) li.tabIndex = -1;      // your own card takes the first focus (brFocus)
        for (const sd of ['a', 'b']) { const p = x[sd] || {}, won = x.w === sd, lost = !!x.w && !won, row = mk('div', 'br-p' + (won ? ' is-win' : '') + (lost ? ' is-lose' : '') + (id != null && p.id === id ? ' is-me' : ''));
          const nmEl = mk('span', 'br-name', drawn ? who(p) : 'To be decided'); if (drawn && x.forfeit && lost && !p.bot) nmEl.append(mk('span', 'br-left', ' (left)'));
          row.append(nmEl); if (drawn && !p.bot) regBadge(nmEl, p.reg === true); if (p.bot) row.append(mk('span', 'br-tag', 'Tour'));      // a registered username: its badge beside the name (docs/ACCOUNTS.md 7.5)
          row.append(mk('b', 'br-sc', x.live || x.w ? String(Array.isArray(x.score) ? x.score[sd === 'a' ? 0 : 1] | 0 : 0) : '')); li.append(row); }
        if (x.live && typeof x.room === 'string') { const f = mk('div', 'br-live'), lv = mk('span', '', 'Live'), nw = x.watchers | 0; if (nw > 0) { lv.append(' · '); const e = mk('span', 'br-eye'); e.innerHTML = EYE_SVG; lv.append(e, String(nw)); } f.append(mk('i', 'br-dot'), lv);      // 'Live · (eye) 3': never cut to 'Live · 3 wat…' in a 13rem column; the Watch button's label says '3 watching'
          const w = mk('button', 'btn btn-sm is-tall br-watch'); w.innerHTML = EYE_SVG; w.append('Watch'); w.dataset.room = x.room; w.setAttribute('aria-label', `Watch ${who(x.a)} versus ${who(x.b)}${nw > 0 ? `, live, ${nw} watching` : ', live'}`); f.append(w); li.append(f); }
        li.setAttribute('aria-label', drawn ? `${who(x.a)} ${x.live || x.w ? (x.score || [0, 0]).join(' to ') + ' ' : ''}versus ${who(x.b)}${x.w ? `, ${who(x[x.w])} won` : x.live ? ', live' : ''}` : 'To be decided');
        ol.append(li); }
      col.append(ol); box.append(col); });
    if (at) box.querySelector(`[data-room="${CSS.escape(at)}"]`)?.focus({ preventScroll: true }); else if (atYou) box.querySelector('.br-col.is-current .br-match.is-you[tabindex]')?.focus({ preventScroll: true }); }
  if (brAuto !== brKey && box.clientHeight) { brAuto = brKey; const f = box.contains(document.activeElement) && document.activeElement.closest('.br-match'), l = f || !you.viewer && !you.out && box.querySelector('.br-col.is-current .br-match.is-you') || box.querySelector('.br-col.is-shown .br-match.is-live, .br-col.is-current .br-match.is-live, .br-col.is-current .br-match.is-you');      // once per drawing, when it can be measured: the focused card, else a player still in sees their own card (what 'You're through' points at), and a viewer (or one who is out) the first live match: Watch is what they came for
    if (l && !box.scrollTop) brReveal(l); }
  const tabs = $('br-tabs'), tk = rs.map(r => r.name).join('|') + ':' + brTab; if (tabs && tabs.dataset.key !== tk) { tabs.dataset.key = tk; tabs.textContent = '';      // a narrow window: one round at a time
    rs.forEach((r, k) => { const b = mk('button', 'seg-opt'); b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(k === brTab)); b.tabIndex = k === brTab ? 0 : -1; b.dataset.round = String(k);
      const nm = tnm(r.name) || `Round ${k + 1}`; b.append(mk('span', 'br-tab-long', nm), mk('span', 'br-tab-short', { Quarterfinal: 'Quarters', Semifinal: 'Semis' }[nm] || nm.replace(/^Round /, 'R'))); b.setAttribute('aria-label', nm); tabs.append(b); }); }
  for (const c of box.children) c.classList.toggle('is-shown', c.dataset.round === String(brTab));
}
function brReveal(el) {      // a card (or its Watch) fully in the scroller, below the sticky round header: focus is never hidden (WCAG 2.4.11)
  const box = $('bracket'), c = el && el.closest && el.closest('.br-match'); if (!box || !c || !box.contains(c)) return;
  const r = c.getBoundingClientRect(), b = box.getBoundingClientRect(), hd = c.closest('.br-col')?.querySelector('.br-round')?.offsetHeight || 0;
  if (r.top < b.top + hd + 8) box.scrollTop -= b.top + hd + 8 - r.top; else if (r.bottom > b.bottom - 8) box.scrollTop += Math.min(r.bottom - b.bottom + 8, r.top - b.top - hd - 8); }
let brEnd = 0, brDur = 1, brLabel = '', brTick = 0, brCur = -1, brAuto = '';
function tickNext() { const ms = Math.max(0, brEnd - performance.now()); setText($('br-next-text'), `${brLabel} ${Math.ceil(ms / 1000)}`); $('br-bar')?.style.setProperty('--p', Math.min(1, ms / 1000 / brDur).toFixed(3)); if (!ms) { clearInterval(brTick); brTick = 0; } }
function brPick(k) { brTab = k; drawBracket(); $('br-tabs').querySelector('[aria-checked="true"]')?.focus(); }
// ---- the champion: the result card, gold, with a trophy and the road to the title. c = snapshot.champ, you = my member id (null: a viewer)
export function champion(c, you = null) {
  if (!c || typeof c !== 'object') return; const me = you != null && c.id === you, name = c.bot ? 'Matt' : tnm(c.name) || 'Player';
  const card = $('result'); card.classList.remove('is-lose'); card.classList.add('is-champion'); $('medal').className = 'medal is-gold is-champion';
  { const st = $('result-slam'); if (st) { st.textContent = ''; st.classList.remove('is-victory'); } clearTimeout(stampT); $('screen-match')?.classList.remove('is-stamp'); }      // the champion's card has no stamp: the final's VICTORY! goes with its card
  $('screen-match').dataset.beat = 'champ'; card.classList.remove('is-forfeit', 'is-watch', 'is-them-won', 'is-rk'); resultStats(null, card); resultRkReset();      // the final's own card is replaced at once: its stats, beat and any Ranked rows go with it
  setText($('result-title'), me ? 'You’re the champion' : `${name} is the champion`); setText($('result-note'), me ? 'Your tournament matches' : `${name}’s tournament matches`);
  const road = $('result-road'); road.textContent = '';
  for (const st of Array.isArray(c.path) ? c.path : []) { const li = mk('li', 'road-step'), sc = Array.isArray(st.score) ? st.score : [0, 0], vs = st.bot ? 'Matt' : tnm(st.vs) || 'Player';
    li.append(mk('small', '', tnm(st.round))); li.append(mk('span', '', st.forfeit ? `${vs} left` : `Beat ${vs}`)); if (!st.forfeit || sc[0] | sc[1]) li.append(mk('b', '', `${sc[0] | 0}-${sc[1] | 0}`)); road.append(li); }
  show('result-road', road.childElementCount > 0); show('rematch-btns', false); show('rematch-count', false); show('tour-res', false); show('champ-acts', true); setText($('rematch-note'), ''); stopCount();
  showOverlay('match'); setTimeout(() => { if (slots.overlay === 'match') $('btn-champ-back')?.focus({ preventScroll: true, focusVisible: true }); }, 60);
}
export const championShowing = () => slots.overlay === 'match' && $('result').classList.contains('is-champion');
// ---- the tournament ended under you: a notice on the lobby (why = restart | empty | expired | gone), a toast for your own leave
const ENDED = { restart: 'The tournament ended: the server restarted', empty: 'The tournament ended: everyone left', expired: 'The tournament ended: it didn’t start in time', gone: 'This tournament has ended' };
export function tourEnded(why, asToast = false) {                                          // asToast: the player is on an ordinary court, where the lobby's notice would sit unseen
  const el = $('tour-ended'); if (!el) return;
  if (why === 'left') { toast('You left the tournament', 2600); return; } if (asToast) { if (ENDED[why]) toast(ENDED[why], 3200); return; }
  if (!ENDED[why]) { el.hidden = true; return; }
  setText($('tour-ended-text'), ENDED[why]); el.hidden = false; setTimeout(() => { if (!el.hidden && slots.menu === 'lobby') $('btn-tour-ended-ok').focus({ preventScroll: true, focusVisible: true }); }, 80);
}
{
  on2('tour-code', 'click', () => { if (!ts) return; clip(ts.code); copied('tour-copied', 'Code copied', () => `${tapWord()} the code to copy it`); });
  on2('btn-tour-copy', 'click', () => { if (!ts) return; clip(invite()); copied('tour-copy-label', 'Copied', () => tLink ? 'Copy invite' : 'Copy code'); });
  on2('tc-code', 'click', () => { if (!ts) return; clip(ts.code); copied('tc-copied', 'Code copied', () => `${tapWord()} to copy`); });
  on2('btn-tc-copy', 'click', () => { if (!ts) return; clip(invite()); copied('tc-copy-label', 'Copied', () => tLink ? 'Copy invite' : 'Copy code'); });
  on2('btn-tour-warm', 'click', () => tcall('warm'));
  on2('btn-tour-start', 'click', e => { if (!e.currentTarget.disabled) tcall('start'); });
  on2('btn-tc-start', 'click', e => { e.currentTarget.blur(); tcall('start'); });
  on2('btn-tour-go', 'click', () => { if (tourCard(true)) $('btn-tc-start')?.focus({ preventScroll: true, focusVisible: true }); });      // never one tap mid-rally: it opens the card on its Start (the names, then the one press that starts it for everyone)
  on2('btn-tour-leave', 'click', () => { if (ts && ts.you && ts.you.viewer) tcall('leave'); else tourConfirm(true); });
  on2('btn-tour-leave-yes', 'click', () => { tourConfirm(false); tcall('leave'); });
  on2('btn-tour-leave-no', 'click', () => { tourConfirm(false); $('btn-tour-leave').focus({ preventScroll: true }); });
  on2('tour-confirm', 'keydown', e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); $(e.key === 'ArrowLeft' ? 'btn-tour-leave-yes' : 'btn-tour-leave-no').focus(); } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); tourConfirm(false); $('btn-tour-leave').focus(); } });
  const twice = (id, then) => on2(id, 'click', e => { const b = e.currentTarget, t = performance.now(), v = !!(ts && ts.you && ts.you.viewer), idle = v ? 'Stop watching' : 'Leave tournament'; if (t < tLeaveAt) { tLeaveAt = 0; setText(b, idle); then(); return; } tLeaveAt = t + 3000; setText(b, v ? 'Press again to stop watching' : 'Press again to leave');      // press twice: a knockout cannot be undone
    setTimeout(() => { if (performance.now() >= tLeaveAt) { tLeaveAt = 0; setText(b, idle); } }, 3100); });
  twice('btn-tc-leave', () => tcall('leave')); twice('btn-br-leave', () => tcall('leave'));
  on2('tour-pill', 'click', () => tourCard(!tCard));
  addEventListener('pointerdown', e => { if (tCard && !e.target.closest?.('#tour-card, #tour-pill')) tourCard(false); });
  on2('tour-card', 'keydown', e => { if (e.key === 'Tab') { const f = [...$('tour-card').querySelectorAll('button')].filter(b => !b.disabled && b.offsetParent); if (!f.length) return; const i = f.indexOf(document.activeElement); if (e.shiftKey ? i <= 0 : i === f.length - 1) { e.preventDefault(); f[e.shiftKey ? f.length - 1 : 0].focus({ preventScroll: true }); } return; }      // Tab stays in the card while it is open (T or Esc closes it)
    const d = { ArrowDown: 1, ArrowUp: -1 }[e.key]; if (!d) return; const nav = [...$('tour-card').querySelectorAll('button')].filter(b => !b.disabled && b.offsetParent), i = nav.indexOf(document.activeElement); if (!nav.length) return; e.preventDefault(); nav[(i < 0 ? (d > 0 ? 0 : nav.length - 1) : i + d + nav.length) % nav.length].focus({ preventScroll: true }); });
  on2('bracket', 'click', e => { const w = e.target.closest('.br-watch'); if (w && w.dataset.room) tcall('watch', w.dataset.room); });
  on2('bracket', 'keydown', e => { const d = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key]; if (!d) return; const ws = [...$('bracket').querySelectorAll('.br-watch')].filter(b => b.offsetParent); if (!ws.length) return; e.preventDefault(); const i = ws.indexOf(document.activeElement), w = ws[i < 0 ? 0 : (i + d + ws.length) % ws.length]; w.focus({ preventScroll: true }); brReveal(w); });      // arrows walk the Watch buttons, Enter watches
  on2('br-tabs', 'click', e => { const o = e.target.closest('[data-round]'); if (o) brPick(+o.dataset.round); });
  on2('br-tabs', 'keydown', e => { const d = { ArrowRight: 1, ArrowLeft: -1 }[e.key]; if (!d || !ts) return; e.preventDefault(); const n = (ts.rounds || []).length; if (n) brPick((brTab + d + n) % n); });
  on2('btn-see-bracket', 'click', () => tcall('bracket'));
  on2('btn-champ-bracket', 'click', () => tcall('bracket'));
  on2('btn-champ-back', 'click', () => tcall('courts'));
  on2('champ-acts', 'keydown', e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); $(e.key === 'ArrowLeft' ? 'btn-champ-back' : 'btn-champ-bracket').focus(); } });
  on2('btn-tour-ended-ok', 'click', () => { show('tour-ended', false); if (slots.menu === 'lobby') viewFocus().focus({ preventScroll: true }); });
  for (const id of ['tour-n-num', 'tour-pill-n']) $(id)?.addEventListener('animationend', e => e.currentTarget.classList.remove('pop'));
}
// The spectator's view chips get the same sliding plate (.views::before, ui.css), keyed on aria-pressed. 'Player: Sam' changes a chip's width, so it is measured, not assumed.
{
  const box = $('views');
  if (box) {
    const place = () => {
      const on = box.querySelector(':scope > [aria-pressed="true"]');
      if (!on || !box.offsetWidth) { box.classList.remove('has-thumb'); return; }
      const first = !box.classList.contains('has-thumb');
      if (first) box.classList.add('thumb-still');
      const s = box.style; s.setProperty('--tx', on.offsetLeft + 'px'); s.setProperty('--ty', on.offsetTop + 'px'); s.setProperty('--tw', on.offsetWidth + 'px'); s.setProperty('--th', on.offsetHeight + 'px');
      box.classList.add('has-thumb');
      if (first) { void box.offsetWidth; requestAnimationFrame(() => box.classList.remove('thumb-still')); }
    };
    new MutationObserver(place).observe(box, { subtree: true, attributes: true, attributeFilter: ['aria-pressed'] });
    if (typeof ResizeObserver === 'function') { const ro = new ResizeObserver(place); ro.observe(box); for (const c of box.children) ro.observe(c); }
    place();
  }
}
// ---------- Ranked (docs/RANKED.md 1.3, 2, 8.2): the home tile's line, the view, the queue pill and the court attribute ----------
// Everything here draws from what main.js / web/profile.js hand in; nothing is fetched. Every string is textContent. Rank names come from
// web/emblems.js RANKS; a tier is 1..7, anything else = not known.
const rankName = t => (tierOf(t) ? RANKS[t - 1].name : '');
const proLabel = (tier, div, place) => (tier === RANKS.length && Number.isInteger(place) && place > 0 ? `Pro #${place.toLocaleString('en-US')}` : rankLabel(tier, div));      // Pro is told apart by the global leaderboard place: 'Pro #12' (NOTES 126)
const divIn = (n, tier, div) => (div === 2 || div === 3 ? div : div === 1 ? 1 : divOf(n, tier));      // the division as sent, else from the count
// the tile: { tier, div, trophies, queued }. A tier draws the small emblem beside 'Gold II · 372'; none = the Bronze emblem, dimmed, and 'Play your first match'.
// queued > 0 lights the corner badge '1 waiting' (the strongest lever on a small player base: the home screen says an opponent exists)
export function rkTile(o = {}) {
  const em = $('ranked-em'), tier = tierOf(o.tier), n = Math.max(0, o.trophies | 0);
  if (em) { const d = tier ? divIn(n, tier, o.div) : 1; let e = em.firstElementChild; if (!e) { e = emblemEl(tier || 1, 'is-xs', d); em.append(e); } setEmblem(e, tier || 1, d); e.classList.toggle('is-off', !tier); }
  setText($('ranked-line-text'), tier ? `${proLabel(tier, divIn(n, tier, o.div), o.place)} · ${n}` : 'Play your first match');
  const q = Math.max(0, o.queued | 0), sub = $('ranked-n'); if (sub) { const t = `${q} waiting`, was = sub.textContent; if (q) setText(sub, t); sub.classList.toggle('is-off', !q); if (q && was && was !== t) restart(sub, 'pop'); }
}
// the view: s = { tier, div, trophies, best, bestAt, next, wins, losses, queued, note } from /api/stats (web/profile.js showRanked), or null when nothing is known yet.
// The head ('Gold II'), the bar through the rank's three divisions, the eight-step road (NOTES 124) with its division pips, Find a match and its status line.
let rkQueuedSaid = false;
// The Ranks page: all eight medals, each with where it starts and its three divisions; the player's own rank ringed, the ones reached marked
function drawRanks() {
  const g = $('rkx-grid'); if (!g) return; g.textContent = ''; const me = lastRank;
  RANKS.forEach((r, i) => {
    const t = i + 1, now = !!me && t === me.tier, done = !!me && !now && t <= Math.max(me.tier, me.best || 1), floor = THRESHOLDS[i];
    const li = mk('li', 'rkx-card' + (now ? ' is-now' : done ? ' is-done' : '')); li.dataset.tier = String(t); li.style.setProperty('--rank-ink', r.colour.deep); li.style.setProperty('--rank-mid', r.colour.mid);
    const em = emblemEl(t, 'is-xl', now ? me.div : done ? 3 : 1); if (now) em.classList.add('is-pop');      // your rank at your division's medal, a rank passed at its full III, one ahead at its I (NOTES 124)
    const divs = mk('span', 'rkx-divs'); if (hasDivs(t)) [0, 1, 2].forEach(d => { const on = now && d + 1 <= me.div || done, pip = mk('span', 'rkx-evo' + (on ? ' is-on' : '')); pip.append(emblemEl(t, 'is-sm', d + 1), mk('span', 'rkx-div' + (on ? ' is-on' : ''), romanOf(d + 1)), mk('small', 'rkx-at', String(floor + d * DIV_W))); divs.append(pip); });      // each division's own medal, its numeral and where it starts (NOTES 124): the medal grows I, II, III
    else divs.append(mk('span', 'rkx-div' + (now || done ? ' is-on' : ''), 'By leaderboard place'));      // Pro: no divisions, the global leaderboard tells its players apart
    const tag = now ? mk('span', 'rkx-tag is-now', `You · ${proLabel(t, me.div, me.place)}`) : done ? mk('span', 'rkx-tag', 'Reached') : t <= 4 ? mk('span', 'rkx-tag is-keep', 'Never lost') : null;
    li.append(em, mk('b', 'rkx-name', r.name), mk('small', 'rkx-from', t === 1 ? 'Starting rank' : `From ${floor} trophies`), divs); if (tag) li.append(tag);
    li.setAttribute('aria-label', `${r.name}, from ${floor} trophies${now ? `, your rank, ${rankLabel(t, me.div)}` : done ? ', reached' : ''}`); g.append(li);
  });
}
export function rkView(s) {
  const known = !!(s && typeof s === 'object'), tier = known ? tierOf(s.tier) || 1 : 1, n = known ? Math.max(0, s.trophies | 0) : 0, best = known ? Math.max(tier, tierOf(s.best)) : 1, div = known ? divIn(n, tier, s.div) : 1;
  const place = known && Number.isInteger(s.place) && s.place > 0 ? s.place : null;
  if (known) { lastRank = { tier, div, best, place }; if (view === 'ranks') drawRanks(); }
  const floor = THRESHOLDS[tier - 1] || 0, span = DIV_W * 3, p = tier === RANKS.length ? 1 : Math.max(0, Math.min(1, (n - floor) / span));      // Pro fills it and it stays full      // the bar: through the rank (three divisions of 50); Pro III fills it and stays full
  const head = $('rk-emblem'); if (head) { head.replaceChildren(emblemCard(tier, 'is-xl', known ? div : 0)); head.querySelector('.rank-em')?.classList.toggle('is-off', !known); }
  setText($('rk-tier'), known ? proLabel(tier, div, place) : 'No rank yet');
  setText($('rk-trophies'), String(n)); setText($('rk-count-word'), n === 1 ? ' trophy' : ' trophies');
  { const b = $('rk-bar'); if (b) { b.style.setProperty('--p', p.toFixed(3)); b.setAttribute('aria-valuenow', String(Math.round(p * 100))); } }
  const nextAt = div < 3 ? floor + div * DIV_W : THRESHOLDS[tier], nextName = tier === RANKS.length ? '' : div < 3 ? rankLabel(tier, div + 1) : rankLabel(tier + 1, 1);      // 'Gold III' is 50 on from Gold II; from Gold III the next step is Platinum I
  setText($('rk-next'), !known ? 'Play Ranked for your first trophies' : !nextName ? (place ? 'Top rank · your place on the global leaderboard' : 'Top rank · ranked by global leaderboard place') : `${Math.max(1, nextAt - n)} to ${nextName}`);
  const road = $('rk-road'); if (road) { road.textContent = '';
    RANKS.forEach((r, i) => { const t = i + 1, now = t === tier && known, done = !now && (t < tier || t <= best && known), li = mk('li', 'rk-step' + (now ? ' is-now' : done ? ' is-done' : '')); li.dataset.tier = String(t);
      const pips = mk('span', 'rk-pips'), lit = now ? div : done ? 3 : 0; for (let k = 1; k <= (hasDivs(t) ? 3 : 0); k++) pips.append(mk('i', k <= lit ? 'is-lit' : '')); pips.setAttribute('aria-hidden', 'true');      // three divisions, filled up to the current one
      li.append(emblemEl(t, 'is-md', now ? div : done ? 3 : 1), mk('b', '', r.name), pips, mk('small', '', String(THRESHOLDS[i])));
      const at = known && t === best && Number.isFinite(s.bestAt) && s.bestAt > 0 ? new Date(s.bestAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '';
      const label = `${r.name}, ${THRESHOLDS[i]} trophies${now ? (hasDivs(t) ? `, your rank, division ${romanOf(div)}` : ', your rank') : done ? ', reached' : ''}${at ? `. Reached on ${at}` : ''}`; li.setAttribute('aria-label', label); if (at) li.title = `Reached on ${at}`;
      road.append(li); }); }
  const go = $('btn-ranked-go'); if (go) { setText(go, 'Find a match'); go.disabled = rkInQueue; }
  rkNote(known && s.hold ? s.hold : known && s.note ? s.note : known && s.queued > 0 && !rkInQueue ? 'Someone is waiting to play' : '', known && !s.hold && !s.note && s.queued > 0 && !rkInQueue);      // hold: a line main.js still holds (a result, a refusal): the view's redraws keep it
}
// the status line under Find a match: '' = the default line (in the queue: where its two actions are). accent: someone is waiting (the line takes the accent colour and pops once per wait)
let rkInQueue = false, noteNow = ['', false];
export function rkNote(text, accent = false) {
  noteNow = [text || '', !!accent];
  const el = $('rk-status'); if (!el) return; const t = text || (rkInQueue ? 'Finding a match. Warm up with Matt or cancel from the bar at the top' : 'You can warm up with Matt while you wait');
  el.classList.toggle('is-accent', !!accent); if (swapText(el, t, accent && !rkQueuedSaid ? 'ov-pop' : '') && accent) rkQueuedSaid = true; if (!accent) rkQueuedSaid = false;
}
// the court: kind = 'warm' | 'match' | null. body[data-rk] hides the court pill's invite menu (an rk court is never shared) and themes the HUD
let rkKindNow = null;
export function rkCourt(kind) { rkKindNow = kind === 'warm' || kind === 'match' ? kind : null; if (rkKindNow) document.body.dataset.rk = rkKindNow; else delete document.body.dataset.rk; if (rkKindNow !== 'warm') rkPill({ on: false }); }
// the queue pill (8.2): { on, since (ms, performance.now clock), queued }. The timer is textContent once a second; every 30 s the text hops so the wait reads as alive
let pillT = 0, pillSince = 0, pillOn = false, pillHops = 0;
export function rkPill(o = {}) {
  const el = $('rk-pill'); if (!el) return;
  const on = !!o.on, since = Number.isFinite(o.since) && o.since > 0 ? o.since : 0;      // 0: not known yet (a new entry's warm-up room comes before its snapshot)
  if (on !== pillOn) { pillOn = on; el.hidden = !on; clearInterval(pillT); pillT = 0; pillHops = 0; if (on) { pillSince = since || performance.now(); restart(el, 'ov-pill'); pillT = setInterval(tickPill, 1000); tickPill(); } }
  else if (on && since && since !== pillSince) { pillSince = since; pillHops = Math.floor(Math.max(0, performance.now() - since) / 30000); tickPill(); }      // the snapshot's clock: the 30 s hops count from it
  if (on && 'queued' in o) setText($('rk-pill-sub'), o.queued > 0 ? 'Someone is waiting. Matching you' : 'You stay in the queue if you leave');
}
// the search bar (docs/RANKED.md 8.1, OPTIONAL WARM-UP): { on, since (performance.now clock), tier, div, busy }. On while queued and off court: it hangs from the top of the title
// and of every lobby view (ui.css hides it anywhere else). Its timer is textContent once a second; Warm up with Matt is disabled while that request is out (busy).
// Find a match is disabled while it is up, and the line under it says where the two actions are
let barT = 0, barSince = 0, barOn = false;
export function rkBanner(o = {}) {
  const el = $('rk-search'); if (!el) return;
  const on = !!o.on, since = Number.isFinite(o.since) && o.since !== 0 ? o.since : 0;      // below 0 is fine: a wait older than this page
  if (on !== barOn) {
    const had = el.contains(document.activeElement);
    barOn = on; rkInQueue = on; el.hidden = !on; clearInterval(barT); barT = 0; document.body.classList.toggle('is-rk-search', on);
    if (on) { barSince = since || performance.now(); barT = setInterval(tickBar, 1000); tickBar(); }
    const go = $('btn-ranked-go'); if (go) go.disabled = on;
    rkNote(...noteNow);
    const a = document.activeElement;
    if (on && (!a || a === document.body || a === go)) $('btn-rk-warm')?.focus({ preventScroll: true });      // Find a match just went grey under the focus: the bar's first action takes it
    else if (!on && had && slots.menu === 'lobby') viewFocus()?.focus({ preventScroll: true });      // Cancel pressed: back to the view
  } else if (on && since && since !== barSince) { barSince = since; tickBar(); }
  if (!on) return;
  const t = tierOf(o.tier), em = $('rk-search-em');
  if (em) { const d = o.div === 2 || o.div === 3 ? o.div : 1; let e = em.firstElementChild; if (!e) { e = emblemEl(t || 1, 'is-md', d); em.append(e); } setEmblem(e, t || 1, d); e.classList.toggle('is-off', !t); }
  setText($('rk-search-sub'), t ? `Ranked · ${rankLabel(t, o.div)}` : 'Ranked');
  const w = $('btn-rk-warm'); if (w) w.disabled = !!o.busy;
}
function tickBar() { const s = Math.max(0, Math.floor((performance.now() - barSince) / 1000)); setText($('rk-search-time'), `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`); }
function tickPill() { const s = Math.max(0, Math.floor((performance.now() - pillSince) / 1000)), t = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; setText($('rk-pill-time'), t);
  const hop = Math.floor(s / 30); if (hop > pillHops) { pillHops = hop; restart($('rk-pill-text'), 'ov-pop'); } }
// Find a match was pressed: the button says Searching (and dips) until the queue answers with a court, a snapshot or a refusal
export function rkSearch(on) { const b = $('btn-ranked-go'); if (!b) return; if (on) { setText(b, 'Searching'); restart(b, 'ov-press'); } else setText(b, 'Find a match'); }

// ---------- Ranked: the match show (docs/RANKED.md 8.3-8.10) ----------
// MATCH FOUND (8.3), on the tournament's VS card in navy: m = { vs: { name, reg, tier, div }, you: { tier, div }, bestOf, target, friendly, at, side }. The opponent's
// count is never here (only their rank). 'Get ready' and its bar take the last 1.5 s before the seat (at s); the series welcome closes the card (main.js). rkVs(null) closes it.
let vsT = 0;
function vsStop() { clearTimeout(vsT); vsT = 0; }
function vsPlain() { $('vs-card')?.classList.remove('is-ranked'); for (const id of ['vs-me-em', 'vs-them-em', 'vs-ready']) show(id, false); $('vs-target')?.classList.remove('is-friendly'); vsStop(); }      // the tournament look again
export function rkVs(m) {
  if (!m || typeof m !== 'object') { if (slots.overlay === 'rk-vs') showOverlay(null); return; }
  const card = $('vs-card'); if (!card) return; vsStop(); card.classList.add('is-ranked');
  const vs = m.vs && typeof m.vs === 'object' ? m.vs : {};
  setText($('vs-round'), 'MATCH FOUND'); setText($('vs-me'), 'You'); rankBadge($('vs-me'), null);
  setText($('vs-them'), tnm(vs.name) || 'Opponent'); show('vs-them-tag', false); regBadge($('vs-them'), vs.reg === true); rankBadge($('vs-them'), null);      // the emblem goes UNDER the name here, as a card with the rank's name, never beside it
  for (const [id, r] of [['vs-me-em', m.you], ['vs-them-em', vs]]) { const box = $(id); if (!box) continue; const ref = rankRef(r); box.replaceChildren(); box.hidden = !ref; if (ref) box.append(emblemCard(ref.tier, 'is-lg is-inverse', ref.div)); }
  const t = $('vs-target'); setText(t, m.friendly === true ? 'Friendly match, no trophies' : `Ranked · Best of ${m.bestOf | 0 || 3} · First to ${m.target | 0 || 7}, win by 2`); t.classList.toggle('is-friendly', m.friendly === true);
  const ready = $('vs-ready'), bar = $('vs-bar'); if (ready) ready.hidden = true; bar?.style.setProperty('--p', '1');
  showOverlay('rk-vs'); restart(card, 'go');
  const at = Math.max(0.3, +m.at || 5) * 1000, lead = Math.min(1500, at);
  vsT = setTimeout(() => { vsT = 0; if (slots.overlay !== 'rk-vs' || !ready) return; ready.hidden = false; bar?.style.setProperty('--vs-d', lead + 'ms'); requestAnimationFrame(() => requestAnimationFrame(() => { if (slots.overlay === 'rk-vs') bar?.style.setProperty('--p', '0'); })); }, at - lead);      // the bar drains over the lead (the 1 s transition floor under reduced motion: a countdown is information)
}
// the GAME card between the games of a series (8.7): o = { won, nameMe, nameThem, game, bestOf, games:[left, right], score:[left, right], serve: 'me'|'them', next, deciding, watching }.
// Everything from the LEFT slot's side (main.js orients it: me, or side 0 for a spectator). Closed by rkgo (main.js); rkGame(null) closes it too.
let gameT = 0, gameLeft = 0, gameTotal = 0, gameNo = 0;
function gameStop() { clearInterval(gameT); gameT = 0; }
function drawGame(n) { gameLeft = n; const l = $('game-left'), t = `Game ${gameNo + 1} in ${n}`; if (l && l.textContent !== t) { l.textContent = t; if (n !== gameTotal) restart(l, 'ov-pop'); } $('game-bar')?.style.setProperty('--p', (gameTotal ? Math.min(1, n / gameTotal) : 0).toFixed(3)); }
export function rkGame(o) {
  if (!o || typeof o !== 'object') { if (slots.overlay === 'rk-game') showOverlay(null); return; }
  const sec = $('screen-rk-game'); if (!sec) return;
  const won = !!o.won, watching = !!o.watching, nameMe = String(o.nameMe || 'You'), nameThem = String(o.nameThem || 'Opponent'), game = Math.max(1, o.game | 0), bestOf = Math.max(1, o.bestOf | 0) || 3, need = Math.ceil(bestOf / 2);
  const games = Array.isArray(o.games) ? [o.games[0] | 0, o.games[1] | 0] : [0, 0], score = Array.isArray(o.score) ? [o.score[0] | 0, o.score[1] | 0] : [0, 0], deciding = !!o.deciding;
  sec.dataset.beat = won ? 'win' : 'lose'; sec.classList.toggle('is-deciding', deciding); sec.classList.toggle('is-watch', watching);      // set before showOverlay: the CSS beats start on activation
  setText($('game-kicker'), `Ranked · Best of ${bestOf}`);
  setText($('game-title'), watching ? `${won ? nameMe : nameThem} takes game ${game}` : won ? `You take game ${game}` : `${nameThem} takes game ${game}`);
  for (const [id, v] of [['game-sc-me', score[0]], ['game-sc-them', score[1]]]) { const el = $(id); el.textContent = String(v); el.style.setProperty('--to', v); }      // final from the first frame; the counter rolls over it
  setText($('game-name-me'), nameMe); setText($('game-name-them'), nameThem);
  drawPips($('game-pips-me'), need, games[0], -1, won ? games[0] - 1 : -1); drawPips($('game-pips-them'), need, games[1], -1, won ? -1 : games[1] - 1);
  setText($('game-n-me'), String(games[0])); setText($('game-n-them'), String(games[1]));
  sec.querySelector('.pip-row.is-me')?.classList.toggle('is-won', won); sec.querySelector('.pip-row.is-them')?.classList.toggle('is-won', !won);
  show('game-deciding', deciding);
  setText($('game-serve'), o.serve === 'me' ? (watching ? `${nameMe} serves first` : 'You serve first') : o.serve === 'them' ? `${nameThem} serves first` : '');
  gameNo = game; gameStop(); const n = Math.max(0, Math.round(+o.next || 0)); gameTotal = n || 1; show('game-count', n > 0);
  showOverlay('rk-game');
  if (n > 0) { drawGame(n); gameT = setInterval(() => { if (gameLeft > 0) drawGame(gameLeft - 1); else gameStop(); }, 1000); }
}
// the series pips in the rally lozenge (8.5): { bestOf, games:[left, right], done }. One pip per game a side needs; a win fills it; the next one pulses while the series is on
export function setSeries(o) {
  const box = $('series'); if (!box) return;
  if (!o || typeof o !== 'object') { box.hidden = true; delete box.dataset.sig; return; }
  const bestOf = Math.max(1, o.bestOf | 0) || 3, need = Math.ceil(bestOf / 2), g = Array.isArray(o.games) ? [Math.min(need, o.games[0] | 0), Math.min(need, o.games[1] | 0)] : [0, 0], done = !!o.done;
  const sig = `${bestOf}/${g[0]}-${g[1]}/${done ? 1 : 0}`;
  if (box.dataset.sig !== sig) { const was = box.dataset.sig; box.dataset.sig = sig; drawPips($('series-me'), need, g[0], done ? -1 : g[0]); drawPips($('series-them'), need, g[1], done ? -1 : g[1]); if (was && !box.hidden) restart(box, 'chip-in'); }
  box.setAttribute('aria-label', `Best of ${bestOf}: games ${g[0]} to ${g[1]}`); box.hidden = false;
}
// game point / match point (8.6): { side: 'me' | 'them' | null, kind: 'game' | 'match' }. The pressing side's score wears a ring, the lozenge's word says which; null clears both
export function setPressure(o) {
  const side = o && (o.side === 'me' || o.side === 'them') ? o.side : null, kind = o && o.kind === 'match' ? 'match' : 'game';
  for (const s of ['me', 'them']) $('sc-' + s)?.classList.toggle('is-pressure', side === s);
  const w = $('rally-word'); if (!w) return; w.classList.toggle('is-pressure', !!side); w.classList.toggle('is-them', side === 'them');
  swapText(w, side ? (kind === 'match' ? 'MATCH POINT' : 'GAME POINT') : 'Rally', 'ov-pop');
}
// the trophy roll (8.9): r = the rkres message { matt, void, saved, won, delta, trophies, tier, div, tierWas, divWas, floorHeld, counted, why, dayLeft }.
// The emblem shows the rank the player HAD until the count lands; the number is the new total from frame one (the counter rolls from the old one over it);
// the pill is the change as applied; a small line says why when nothing changed. A changed rank or division is the ceremony at 2100 ms (8.10).
const MATT_LV = ['Rookie', 'Club', 'Pro', 'Tour'];               // Matt's wire level -> name (the trophy note of a practice game, NOTES 128)
const RK_WHY = { not_counted: 'This match didn’t count', self: 'Matches against yourself don’t count', restart: 'Matches resumed after a Poddle update don’t count', too_short: 'Too short to count', left_early: 'They left before a game finished', noshow: 'Your opponent never joined' };
let upT = 0;
export function trophyRow(r) {
  const box = $('trophy'); if (!box || !r || typeof r !== 'object') return; trophyReset();
  const now = rankRef(r), was = rankRef({ tier: r.tierWas, div: r.divWas }) || now, tier = now ? now.tier : 0, n = Math.max(0, r.trophies | 0), d = Number.isInteger(r.delta) ? r.delta : 0;
  const had = was || now || { tier: 1, div: 1 }, card = trophyCard(had.tier, had.div), e = card && card.querySelector('.rank-em'); if (e) e.classList.remove('is-down', 'is-pop');      // the rank I had until the count lands, named under its emblem
  const num = $('trophy-n'); num.textContent = String(n); setText($('trophy-word'), n === 1 ? 'trophy' : 'trophies'); num.style.setProperty('--from', String(Math.max(0, n - d))); num.style.setProperty('--to', String(n));      // final from the first frame
  box.classList.toggle('is-roll', d !== 0);
  const pill = $('trophy-d'); let text, cls = '', note = '';
  const why = (Array.isArray(r.why) ? r.why : []).find(w => RK_WHY[w]);
  if (r.void === true) { text = 'Not counted'; cls = 'is-off'; note = why ? RK_WHY[why] : 'No trophies changed'; }
  else if (d < 0) { text = `−${-d}`; cls = 'is-down'; note = r.leaver === true ? 'Forfeit' : ''; }      // the change as applied comes first: a leaver's loss is never 'No trophies' (it is taken whatever the verdict)
  else if (r.leaver === true) { text = '±0'; note = r.floorHeld === true && tier ? `Forfeit · you keep ${RANKS[tier - 1].name}` : 'Forfeit'; }      // my own forfeit that cost nothing (the floor held, or nothing to save to): never 'They left'
  else if (r.counted === false) { text = 'No trophies'; cls = 'is-off'; note = why ? RK_WHY[why] : ''; }
  else if (r.saved === false) { text = 'No trophies'; cls = 'is-off'; note = r.matt === true ? 'Sign in or finish a game to keep trophies' : 'Couldn’t save trophies right now'; }
  else if (d > 0) { text = `+${d}`; cls = 'is-up'; note = r.forfeit === true ? 'Opponent forfeited' : ''; }      // forfeit: main.js passes the series card's matchover flag (rkres has none)
  else { text = '±0'; note = r.floorHeld === true && tier ? `You keep ${RANKS[tier - 1].name}` : ''; }
  if (r.matt === true && r.dayLeft === 0 && d === 0) note = 'Daily Matt trophy limit reached';
  if (r.matt === true && r.easy === true && d === 0) { text = 'Practice'; cls = 'is-off'; note = `Trophies need ${MATT_LV[r.need] || 'your rank\u2019s'} Matt or harder`; }      // NOTES 128: an easier Matt than the rank's pays nothing
  pill.className = 'trophy-d' + (cls ? ' ' + cls : ''); setText(pill, text); setText($('trophy-note'), note); show('trophy-note', !!note);
  box.hidden = false;
  if (now && was && (now.tier !== was.tier || now.div !== was.div)) { const kind = now.tier > was.tier ? 'rank' : now.tier < was.tier || now.div < was.div ? 'down' : 'div';
    upT = setTimeout(() => { upT = 0; if (slots.overlay === 'match') rankUp({ tier: now.tier, div: now.div, kind }); }, reduced() ? 0 : 2100); }      // after the count lands
}
// the ceremony (8.10; NOTES 117): { tier, div, kind: 'rank' | 'div' | 'down' }. The emblem card in the trophy row names the new rank. rank: the emblem swaps, pops and
// stays grown, rays open behind it, one band of light crosses the card, 'Rank up' under the delta; div: a pop and the numeral flips on its tag, 'Division up';
// down: the emblem shrinks a little and the line under the row says 'Down to Gold I'. #result-note carries the words for a screen reader. Sounds are main.js's (scene.jingle)
export function rankUp(o) {
  const r = rankRef(o); if (!r) return; const kind = o.kind === 'div' || o.kind === 'down' ? o.kind : 'rank', R = RANKS[r.tier - 1], label = rankLabel(r.tier, r.div);
  const em = $('trophy-em'), card = em && em.querySelector('.rank-card-em'), e = card && card.querySelector('.rank-em'); if (!e) return;
  trophyCard(r.tier, r.div); e.classList.remove('is-down', 'is-pop'); em.classList.remove('is-up');      // the card now names the new rank ('Gold I'): the emblem, its tag and its label change together
  const note = (t, sub) => { const n = $('result-note'); if (!n) return; n.textContent = t; if (sub) n.append(mk('small', 'result-note-sub', sub)); n.classList.add('is-quiet'); };      // read out; drawn by the card (the label under the emblem says it)
  const line = t => { const tn = $('trophy-note'); if (!tn) return; const had = tn.hidden ? '' : tn.textContent; setText(tn, had ? had + ' · ' + t.charAt(0).toLowerCase() + t.slice(1) : t); tn.hidden = false; };      // what the moment means, in sight under the row ('Forfeit · down to Platinum III')
  const kick = t => { const k = $('rank-kicker'); if (!k) return; k.hidden = !t; k.textContent = t || ''; k.style.setProperty('--rank-c', R.colour.deep); if (t) restart(k, 'ov-pop'); };      // the words for the moment (no stamp since NOTES 104): a caps pill under the trophy delta, beside the emblem that just changed
  kick(kind === 'rank' ? 'Rank up' : kind === 'div' ? 'Division up' : '');
  if (kind === 'down') { restart(e, 'is-down'); note(`Down to ${label}`); line(`Down to ${label}`); return; }
  restart(e, 'is-pop');
  if (kind === 'div') { restart(card, 'is-flip'); note(label); return; }      // the numeral flips on its tag
  em.classList.add('is-up'); { const f = $('result-flash'); if (f) restart(f, 'is-sweep'); }      // rank up: the emblem grows and stays grown, and one band of light crosses the card
  let rays = em.querySelector('.medal-rays'); if (!rays) { rays = document.createElement('i'); rays.className = 'medal-rays'; rays.setAttribute('aria-hidden', 'true'); em.prepend(rays); }
  rays.style.setProperty('--rank-ray', `color-mix(in srgb, ${R.colour.mid} 55%, transparent)`); restart(rays, 'is-on');
  const s = $('result-slam'); if (s) { s.textContent = 'RANK UP'; s.classList.remove('is-them', 'is-gold', 'is-victory'); s.classList.add('is-rank'); s.style.setProperty('--rank-c', R.colour.mid); s.style.setProperty('--rank-deep', R.colour.deep); restart(s, 'go'); }
  { const sub = r.tier <= 4 ? 'Ranks up to Platinum are never lost once reached' : 'Diamond and above can drop, but never below Platinum'; note(label, sub); if ($('trophy-note')?.hidden) line(sub); }
  confetti([R.colour.mid, '#ffd34a', '#ffffff'], 120);
}
