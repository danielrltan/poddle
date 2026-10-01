// Player stats in the browser (docs/ACCOUNTS.md 9): the device id, the /api calls, Google's sign-in (loaded only after the age box is
// ticked, never on page load) and the DOM of what is new for it: Your stats, the result card's line, the sign-in and confirm cards,
// Settings > You and the home notice. main.js owns the socket and calls in here. No named import from ui.js on purpose: test/menu.mjs
// stubs ui.js with a fixed list of names, so main.js hands in the few ui calls this needs (init).
// Every string from the server or the player goes in as textContent. Nothing here logs an id, a name or a token.
const $ = id => document.getElementById(id);
const DEV_KEY = 'poddle.device', OLD_ON_KEY = 'poddle.stats.on', LB_SEEN = 'poddle.lbSeen', OLD_FR_SEEN = 'poddle.friendsSeen', GSI = 'https://accounts.google.com/gsi/client';
const LEVEL = ['Rookie', 'Club', 'Pro', 'Tour'], ORDER = [0, 1, 3, 2];
const DEV_OK = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$|^[0-9a-f]{32}$/;      // the server's own check (3.1): anything else is no device id
// its own keys, NOT poddle.settings: savePrefs() rebuilds that one from a fixed list and would drop them
const ls = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* private window: nothing is kept */ } }, del(k) { try { localStorage.removeItem(k); } catch { /* same */ } } };
const show = (id, on) => { const el = $(id); if (el) el.hidden = !on; return !!el && !el.hidden; };
const cupT = new WeakMap();      // data-cup elements (NOTES 138): main.js's hook turns 'trophies' into the gold icon, so the words last set are kept here
const text = (id, t) => { const el = $(id); if (!el) return; if (el.hasAttribute('data-cup')) { if (cupT.get(el) !== t) { cupT.set(el, t); el.textContent = t; h.cup(el); } return; } if (el.textContent !== t) el.textContent = t; };
const mk = (tag, cls, t) => { const e = document.createElement(tag); if (cls) e.className = cls; if (t != null) e.textContent = t; return e; };
const day = ms => Number.isFinite(ms) && ms > 0 ? new Date(ms).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }) : '';
const degs = v => Math.round(v * 180 / Math.PI / 10) * 10;      // rad/s -> deg/s rounded to 10 (Q7): 27.4 rad/s = 1570°/s
const num = v => Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;

let nonceP = null;      // one sign-in nonce per card: a reopened card reuses it, so the cookie (set by whichever response lands last) always holds the nonce Google is given
let on = false, h = {}, sockHello = false, saved = null, viewGen = 0, loadGen = 0, gsi = null, lastFocus = null, lastBack = null, openAt = 0, meDone = false, lostP = null;      // openAt: when a card last opened (the veil ignores the rest of a double click). meDone: /api/me has answered (or failed). lostP: acctLost's /api/me check in flight      // saved: the server has a guest profile for this device (true / false / null = not asked)
let me = { enabled: false, clientId: null, account: null, db: false };      // GET /api/me: sign-in on or off, the Google client id, who is signed in
let meLadder = null, loading = false;      // meLadder: my ladder as last heard (/api/me for a signed-in account, then every /api/stats answer and each game's trophies): the hero draws it while /api/stats is asked, so Your stats never opens on 'No trophies yet' and then grows (NOTES 150). loading: showProfile's first draw, before the answer
let share = null, shareable = false, shareP = null;      // share: { url, image } of my live link (docs/SHARE.md 2), null = none yet. shareable: the server answered a profile with a share field (an older server has no /api/share)

// ---------- the device id (3.1): made at the first seat, never at load. A bearer secret for the guest profile: never in a URL or a log ----------
export const deviceId = () => { const v = ls.get(DEV_KEY); return v && DEV_OK.test(v) ? v : ''; };
function newId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();      // not there on plain-http LAN pages: 16 random bytes in hex instead, never Math.random
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
}
export const hello = () => { if (!on) return null; const dev = deviceId(); return dev ? { type: 'hello', dev, v: 1 } : null; };      // stats are always kept (NOTES 116: the Save my stats switch is gone)
export function opened() { const m = hello(); sockHello = !!m; return m; }      // the socket's open handler sends this FIRST (9.2); null = say nothing
export function seated() {                                  // a 'welcome' with a seat of my own: the id is made now if there is none, and its hello follows at once
  closePlayer();                                            // a leaderboard profile open (NOTES 140): the court is coming, its veil must not sit over it
  if (!on) return;
  let dev = deviceId(); if (!dev) { dev = newId(); ls.set(DEV_KEY, dev); if (deviceId() !== dev) return; }      // storage refused it: a new guest every load is worse than none
  if (!sockHello) { sockHello = true; h.send({ type: 'hello', dev, v: 1 }); }      // the server keeps a socket's first hello and ignores the rest
}
const forgetDevice = () => { ls.del(DEV_KEY); saved = null; };      // rotated (3.1): sign-out, Delete my data (the privacy page removes it). A fresh one is made at the next seat

// ---------- /api (8): same origin, JSON, the session cookie rides along by itself. web/social.js calls it too ----------
export async function api(path, method = 'GET', body) {
  const o = { method, credentials: 'same-origin', cache: 'no-store', headers: {} };
  if (body !== undefined) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }      // every POST and DELETE: JSON or the server says 415
  const r = await fetch(path, o); let j = null; if (r.status !== 204) { try { j = await r.json(); } catch { j = null; } }
  return { ok: r.ok, status: r.status, j: j && typeof j === 'object' && !Array.isArray(j) ? j : null };
}
const devBody = () => { const dev = deviceId(); return dev ? { dev } : {}; };
const acct = a => a && typeof a === 'object' ? { username: typeof a.username === 'string' && a.username ? a.username.slice(0, 12) : null, renameAt: Number.isFinite(a.renameAt) ? a.renameAt : null } : null;
export async function loadMe() {                            // once after boot: is sign-in on, and who is signed in
  if (!on) return me;
  try { const r = await api('/api/me'), j = r.ok && r.j;
    if (j) { const s = j.signin && typeof j.signin === 'object' ? j.signin : {}, id = typeof s.clientId === 'string' && /^[\w.-]{1,200}$/.test(s.clientId) ? s.clientId : null;
      me = { enabled: s.enabled === true && !!id, clientId: id, account: s.enabled === true ? acct(j.account) : null, db: j.db === true }; meLadder = me.account ? ladderOf(j) : null;      // the account's ladder and places ride on /api/me (server/api.js)
      const seen = ls.get(LB_SEEN), listed = !!(j.places && j.places.listed === true);      // '1': the leaderboard notice was shown; '2': the profile-card one too (NOTES 140)
      if (me.account && me.account.username && me.db && seen !== '2' && (!seen || listed)) lbNotice(0, !seen); } } catch { /* no answer: a guest with sign-in off */ }
  meDone = true;
  drawAcct(); return me;
}
// the notice the privacy page promises (NOTES 126): once per browser, only to a name that can be on a board. It waits until the lobby is up and has sat
// there a moment (opening the lobby clears any toast), and is marked seen only once it has been shown. first: this browser never showed the NOTES 126 one,
// so both are said at once; else (it said '1' and the player is listed now) only the profile card's (NOTES 140). A hidden '1' is not told here: toggleShow's own toast tells it when Show me is turned on
let lbT = 0;
function lbNotice(n = 0, first = true) {
  clearTimeout(lbT); if (n > 600 || ls.get(LB_SEEN) === '2') return;      // gives up after ten minutes on the title or in a court: the next load tries again
  if (!h.view()) { lbT = setTimeout(() => lbNotice(n + 1, first), 1000); return; }
  lbT = setTimeout(() => { if (!h.view()) return lbNotice(n + 1, first);
    h.toast(first ? 'Your username can now appear on the global leaderboard, and anyone can open your profile card from it. You can turn this off on the Leaderboard page' : 'Anyone can now open your profile card from the global leaderboard. You can turn this off on the Leaderboard page', 8000); ls.set(LB_SEEN, '2'); }, 1200);
}
// No "New: ..." feature announcements (NOTES 147, CLAUDE.md "No announcement notices"): the Friends one is gone, and its key with it (below)
export async function fetchProfile() {                      // -> the Profile of 8.2, null = nothing saved yet, undefined = the request failed
  if (!on) return undefined; await mePromise; const dev = deviceId(); if (!me.account && !dev) return null;      // who is signed in first (/api/me). Nothing to ask about: no request at all
  try { const r = await api('/api/stats', 'POST', devBody()); if (!r.ok || !r.j) return undefined;
    const p = r.j.profile && typeof r.j.profile === 'object' ? r.j.profile : null; if (!me.account) saved = !!p; return p; } catch { return undefined; }
}

// ---------- after a match: one line on the result card (9.3) ----------
const WHY = { not_counted: 'This match doesn’t count toward your record', self: 'Matches against yourself don’t count', restart: 'Matches resumed after a Poddle update don’t count', too_short: 'Too short to count' };
const BEST = { rally: v => `longest rally ${v}`, speed: v => `fastest swing ${degs(v)}°/s` };      // hit (power) is kept and exported but never shown: it is a unitless internal number
let overTour = false, nudged = false;      // nudged: the sign-in nudge shows once a visit, and on every first win
export function matchover(tour) { overTour = !!tour; show('result-save', false); }      // a new result: last match's line goes (result() fills it again for this one). tour: a tournament's card (the line, no nudge)
export function result(p) {                                 // the 'profile' message (8.3), right after matchover, to my seat only. Its `trophies` object is main.js's (ui.trophyRow, docs/TROPHIES.md 4): this is the record line
  if (!on || !p || typeof p !== 'object') return; const tour = overTour;
  { const t = p.trophies; if (t && typeof t === 'object' && Number.isInteger(t.trophies) && t.saved === true) { const L = meLadder || { place: null, best: 1, bestDiv: 1, bestAt: 0, next: 0, wins: 0, losses: 0, streak: 0, botWins: 0, botLosses: 0, mattDayLeft: 0 }, tier = tierNum(t.tier), div = tier === TOP ? 1 : divNum(t.div), up = tier > L.best || tier === L.best && div > L.bestDiv;
    meLadder = { ...L, tier, div, trophies: Math.max(0, t.trophies), best: up ? tier : L.best, bestDiv: up ? div : L.bestDiv }; } }      // the hero's next open starts from this count (drawRoad)
  if (p.saved === true && p.guest === true) saved = true;
  const lv = Number.isInteger(p.level) && LEVEL[p.level] ? LEVEL[p.level] : '', why = Array.isArray(p.why) ? p.why.filter(w => typeof w === 'string') : [], bests = Array.isArray(p.bests) ? p.bests.filter(b => b && BEST[b.what] && Number.isFinite(b.v)) : [];
  let line = '';
  if (p.saved === true) {                                  // saved:false (no database, anonymous, the new-guest cap): nothing to say
    if (p.first === true) line = lv ? `First win against ${lv} Matt` : 'Your first win';
    else if (bests.length) { const b = bests[0], prev = Number.isFinite(b.prev) && b.prev > 0 ? b.prev : 0; const shown = v => (b.what === 'speed' ? degs(v) + '°/s' : String(Math.round(v))), was = prev ? shown(prev) : ''; line = `New best: ${BEST[b.what](b.what === 'speed' ? b.v : Math.round(b.v))}` + (was && was !== shown(b.v) ? ` (was ${was})` : ''); }      // a gain below the rounding step would read '1330°/s (was 1330°/s)': the old value is left out then
    else if (num(p.streak) >= 2) line = `${num(p.streak)} wins in a row`;
    else if (p.ranked === false) { const w = why.find(x => WHY[x]); if (w) line = WHY[w]; }
    else if (why.includes('level')) line = 'Counted at the easiest level you played';      // R13: a level changed mid-match
  }
  const notice = p.created === true, nudge = p.nudge === true && !tour && me.enabled && !me.account && (p.first === true || !nudged);      // a win only (the server decides), never for a signed-in player; not after every win
  if (nudge) nudged = true; { const el = $('result-save-text'); if (el) el.classList.toggle('is-first', p.first === true && !!line); }
  text('result-save-text', line); show('result-save-text', !!line); show('result-notice', notice); show('btn-save-signin', nudge);
  show('result-save', !!(line || notice || nudge));      // no focus is taken: the rematch buttons keep it
}

// ---------- Your stats (9.4): the player card. drawRoad (the hero, then drawMatt: the Matt badge), drawPeople and drawTiles fill index.html's markup ----------
const dayS = ms => Number.isFinite(ms) && ms > 0 ? new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(new Date(ms).getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }) }) : '';      // "Sep 19": the card's dates are chips, the long form is for sentences
const FLAME = '<svg class="st-flame" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2c1 4.5 5.5 5.5 5.5 10.5a5.5 5.5 0 0 1-11 0c0-2 1-3.2 2.2-4.2 0 2 1 3.2 2.3 3.2 0-3.5-1-5.5 1-9.5Z"/></svg>';      // index.html's flame: it stands for the words 'win streak' wherever it shows
const cls = (id, c, onOff) => { const el = $(id); if (el) el.classList.toggle(c, !!onOff); };
const human = p => p && p.human && typeof p.human === 'object' ? p.human : {};
function rungs(p) {                                         // the four Matt rows in difficulty order, and what the card makes of them
  const rows = ORDER.map(lv => (p && Array.isArray(p.matt) ? p.matt : []).find(x => x && x.level === lv) || {}), won = rows.map(r => Number.isFinite(r.firstWinAt) && r.firstWinAt > 0);
  return { rows, won, beaten: won.filter(Boolean).length, top: won.lastIndexOf(true), nextI: won.indexOf(false) };      // top: the hardest Matt beaten = the rank (-1: none); nextI: -1 once all four are
}
function drawRoad(p) {
  const { rows } = rungs(p), H = human(p), name = i => `${LEVEL[ORDER[i]]} Matt`;
  // the hero is the trophy ladder (docs/TROPHIES.md 4, one rank per player): the crest, "Gold II", the place, the trophies, the bar to the next division
  // or rank, the trophy road and the keep line, all drawn by ui.rankCrest (main.js's h.crest) from the ladder with its place. null = no trophies yet
  // (nothing saved, an older server): the dimmed crest and 'Win a game for your first trophies', or 'Sign in to earn trophies' for a guest
  if (p) { meLadder = ladderOf(p); h.crest(meLadder, signedIn()); }      // the answer: the hero is the trophy view
  else if (p === null && !loading) { meLadder = null; h.crest(null, signedIn()); }      // answered: nothing saved yet
  else if (meLadder) h.crest(meLadder, signedIn());      // asking (loading), or no answer (undefined): what is known, in the shape the answer takes; with nothing known the last draw (or the page's own markup) stands
  let hot = { n: num(H.streak), who: 'people' }; rows.forEach((r, i) => { if (num(r.streak) && num(r.streak) >= hot.n) hot = { n: num(r.streak), who: name(i) }; });      // ties go to the harder Matt, people last
  const best = Math.max(num(H.bestStreak), ...rows.map(r => num(r.bestStreak))), st = $('st-streak');
  if (st) st.className = 'st-streak' + (hot.n >= 2 ? ' is-hot' : hot.n === 1 ? ' is-one' : '');      // gold from two wins up, never for one
  text('st-streak-n', String(hot.n));      // the flame says streak: no words beside it (NOTES 158). Who it is against and the best ride in the tooltip
  if (st) { const tip = hot.n ? `Win streak vs ${hot.who} · best ${best}` : best ? `Win streak · best ${best}` : 'Win streak'; st.title = tip; st.setAttribute('aria-label', tip.replace('Win streak', 'Win streak: ' + hot.n)); }
  drawMatt(p);
}
// the Matt badge: every level can be picked at any time, so this is a badge for the toughest one beaten (difficulty order, never the
// wire number: Tour is 3 on the wire but easier than Pro), and a chip a level with its record. No order to climb, no locks, no Next
function drawMatt(p) {
  const { rows, won, top } = rungs(p), badge = $('st-mbadge'), ul = $('pf-rungs');
  if (badge) badge.className = 'st-mbadge ' + (top < 0 ? 'is-none' : 'is-lv' + top);
  text('st-mbest', top < 0 ? 'None yet' : `${LEVEL[ORDER[top]]} Matt`);
  const r = top < 0 ? null : rows[top];
  text('st-mcap', r ? dayS(r.firstWinAt) : '');      // the day it was first beaten; nothing beaten: no coaching line
  if (!ul) return; ul.textContent = '';
  rows.forEach((row, i) => {
    const li = mk('li', 'st-mlv' + (won[i] ? ' is-won' : '') + (i === top ? ' is-top' : '')); li.dataset.level = ORDER[i];
    const rec = mk('small', '', `${num(row.wins)}-${num(row.losses)}`);      // the record (test/profile-ui.mjs reads it), the streak its small print
    if (num(row.streak)) { const s = mk('i', ''); s.innerHTML = FLAME; s.append(String(num(row.streak))); s.title = 'Win streak'; rec.append(s); }      // the flame is the word
    li.append(mk('b', '', LEVEL[ORDER[i]]), rec); li.title = won[i] ? `${LEVEL[ORDER[i]]} Matt: beaten ${dayS(row.firstWinAt)}` : `${LEVEL[ORDER[i]]} Matt: not beaten yet`;
    ul.append(li);
  });
}
function drawPeople(p) {                                    // W-L, the tug-of-war bar with its two labels, the streak chips; nothing played: the empty track and a coaching line
  const H = human(p), w = num(H.wins), l = num(H.losses), played = w + l, pct = played ? Math.round(100 * w / played) : 0;
  text('st-w', String(w)); text('st-l', String(l));
  const bar = $('st-bar'); if (bar) { bar.style.setProperty('--w', pct + '%'); bar.classList.toggle('is-empty', !played); }
  text('st-bar-l', `${pct}% won`); text('st-pts', `${num(H.pointsWon)}-${num(H.pointsLost)}`); show('st-bar-l', !!played); show('st-bar-r', !!played);
  show('st-chips', !!played); text('st-hstreak', String(num(H.streak))); text('st-hbest', String(num(H.bestStreak))); cls('st-hchip', 'is-one', num(H.streak) >= 1);
}
function tile(id, v, cap = '') {                            // one number tile: the number (blue even at 0), its unit only with a value, the day a best was set under it
  const t = $(id); if (!t) return; const b = t.querySelector('.st-num b'), u = t.querySelector('.st-num small'), c = t.querySelector('.st-cap');
  if (b) b.textContent = String(v); if (u) u.hidden = !v || !u.textContent; if (c) c.textContent = cap;
}
function drawTiles(p) {
  const B = p && p.bests && typeof p.bests === 'object' ? p.bests : {}, best = k => { const x = B[k] && typeof B[k] === 'object' ? B[k] : {}; return Number.isFinite(x.v) && x.v > 0 ? x : null; }, titles = num(p && p.titles);
  tile('st-t-titles', titles);
  const r = best('rally'), s = best('speed');      // no Hardest hit: a unitless number nobody can read
  tile('st-t-rally', r ? Math.round(r.v) : 0, r ? dayS(r.at) : '');
  tile('st-t-speed', s ? degs(s.v) : 0, s ? dayS(s.at) : '');
}
// the play row (docs/SHARE.md 3): profile.play's counters. An older server sends no play: the row stays hidden, nothing else changes
const clock = s => s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m` : s ? '<1m' : '0m';      // time on court: "1h 20m", "12m"
const fig = (id, v) => { const d = $(id) && $(id).querySelector('dd'); if (d && d.textContent !== v) d.textContent = v; };
function drawPlay(p) {
  const P = p && p.play && typeof p.play === 'object' ? p.play : null; if (!show('pf-play', !!P)) return;
  const ch = num(P.chances), rt = Math.min(num(P.returns), ch), ok = ch >= 10, f = ok ? rt / ch : 0;      // under 10 chances a percentage says nothing: the coaching line instead
  const ring = $('st-ring'); if (ring) { ring.style.setProperty('--p', f.toFixed(3)); ring.classList.toggle('is-zero', !f); }
  text('st-ret-pct', ok ? `${Math.round(100 * f)}%` : ''); show('st-ret-pct', ok); text('st-ret-cap', ok ? `${rt.toLocaleString()} of ${ch.toLocaleString()} returned` : ''); cls('st-ret', 'is-hint', !ok);      // under 10 chances: the empty ring alone, no coaching line
  const pw = num(P.pointsWon), pl = num(P.pointsLost);      // every kind of match (h_points_* in human stay people-only)
  fig('st-f-winners', num(P.winners).toLocaleString()); fig('st-f-aces', num(P.aces).toLocaleString()); fig('st-f-smashes', num(P.smashes).toLocaleString()); fig('st-f-hits', num(P.hits).toLocaleString());
  fig('st-f-points', `${pw + pl ? Math.round(100 * pw / (pw + pl)) : 0}%`); fig('st-f-time', clock(num(P.secs)));
}
function drawHead(p) {
  const n = $('pf-name'), name = me.account && me.account.username, typed = (($('name-input') || {}).value || '').trim().slice(0, 12);      // the lobby's name field holds the cleaned display name
  if (n) { n.textContent = name || typed || (me.account ? 'Signed in' : 'Guest'); h.badge(n, !!name); }
  text('pf-sub', me.account ? '' : p && Number.isFinite(p.expiresAt) ? `Stats saved on this device until ${day(p.expiresAt)}` : 'Stats saved on this device');
  show('pf-notice', !!(p && p.guest === true && !me.account));      // the one-time notice (9.3) for everyone, always here: a player who left or forfeited never gets the result card's copy
}
export function drawProfile(p) {                           // p: a Profile, null (nothing yet) or undefined (not available). Guest or signed in changes only the header: every stat draws the same way
  shareable = !!p && typeof p === 'object' && 'share' in p; share = shareable ? shareOf(p.share) : null;      // fresh at every draw: the image's ?v= changes with the stats
  drawHead(p); drawRoad(p); drawPlace(p || null); drawPeople(p || null); drawPlay(p || null); drawTiles(p || null); drawAcct();
  const msg = p === undefined ? 'Stats aren’t available right now. You can still play.' : '';      // nothing yet: no bar, the card's own lines say it (Start here, the people hint, the tile captions)
  text('pf-msg', msg); show('pf-msg', !!msg); // download and delete live on the privacy page (web/data-tools.js): the footer links there
}
export async function showProfile() {                      // the lobby view opened: draw what is known at once (empty), then the answer
  const g = ++viewGen; loading = on; drawProfile(on ? null : undefined); loading = false; if (!on) return;
  text('pf-msg', 'Loading your stats'); show('pf-msg', true);
  const p = await fetchProfile(); if (g === viewGen && h.view() === 'profile') drawProfile(p);
}

// ---------- the global leaderboard (NOTES 126): three boards of counted results, GET /api/leaderboard; my places ride on /api/stats ----------
const BOARD = {
  trophies: { what: 'Trophies', unit: n => (n === 1 ? 'trophy' : 'trophies'), none: 'Win a game for your first trophies' },
  rally: { what: 'Longest rally, in hits', unit: n => (n === 1 ? 'hit' : 'hits'), none: 'Keep the ball in play for a rally of 3 or more' },
  streak: { what: 'Best win streak against people', unit: n => (n === 1 ? 'win' : 'wins'), none: 'Win a match against a person' },
};
let board = 'rally', boardGen = 0, places = null;      // Longest rally is the first tab (NOTES 131); the #N beside the rank on Your stats opens Trophies (lb-tabs data-want)
      // places: the last /api/stats answer's places ({ listed, why, hidden, trophies, rally, streak }), null = not known
const CUP_SVG = '<svg class="cup-ic" viewBox="0 0 24 24" role="img" aria-label="${label}"><path class="cup-h" d="M7 5.5H4.5a1 1 0 0 0-1 1V8a4 4 0 0 0 4 4M17 5.5h2.5a1 1 0 0 1 1 1V8a4 4 0 0 1-4 4"/><path class="cup-c" d="M6.5 3h11v6.5a5.5 5.5 0 0 1-11 0Z"/><path class="cup-s" d="M10.5 14.5h3v3h-3Z"/><rect class="cup-b" x="7" y="17" width="10" height="4" rx="1.2"/><path class="cup-g" d="M9 5.5v3.8a3.2 3.2 0 0 0 1.4 2.6"/></svg>';      // the gold trophy (index.html st-rank-cap has the same): stands for the word 'trophies' (NOTES 136)
const unitOf = n => { if (board !== 'trophies') return mk('small', '', ' ' + BOARD[board].unit(n)); const i = mk('i', 'lb-cup'); i.innerHTML = CUP_SVG.replace('${label}', BOARD.trophies.unit(n)); return i; };
const placeOf = p => (p && p.places && typeof p.places === 'object' ? p.places : null);
const rankNum = n => '#' + Number(n).toLocaleString('en-US');
// Your stats: the trophy place beside the rank name ('Champion II  #301'). Only for a listed player with trophies: a guest, a player with no username
// or one who hid is on no board, so no number
function drawPlace(p) {
  const P = placeOf(p), t = P && P.listed && P.trophies && num(P.trophies.rank) ? P.trophies : null, b = $('st-place');
  if (!b) return; b.hidden = !t; if (!t) return;
  text('st-place-n', rankNum(t.rank)); const l = `Global rank ${rankNum(t.rank)} for trophies. See the global leaderboard`; b.setAttribute('aria-label', l); b.title = l;
}
const rankName = (t, d) => (t === TOP ? RANK_NAME[TOP - 1] : `${RANK_NAME[tierNum(t) - 1]} ${ROMAN[divNum(d)]}`);      // 'Gold II', 'Pro' (the place only comes with the profile)
function boardRow(r, mine) {      // a row is a button (NOTES 140): it opens that player's profile card. li.lb-item > button.lb-row, like the court list
  const li = mk('li', 'lb-item'), b = mk('button', 'lb-row' + (r.rank <= 3 ? ' is-top is-top' + r.rank : '') + (mine ? ' is-me' : '')), hasRank = Number.isInteger(r.tier);
  b.type = 'button'; b.dataset.name = r.name; b.setAttribute('aria-haspopup', 'dialog');
  if (hasRank) { b.dataset.tier = String(r.tier); b.dataset.div = String(r.div); }      // the sheet's hero draws from these at once, before the profile answers
  const who = mk('span', 'lb-who'), nm = mk('b', 'lb-name', r.name), v = Number(r.v).toLocaleString('en-US'), unit = BOARD[board].unit(r.v);
  who.append(nm); b.append(mk('span', 'lb-rank', String(r.rank)), who, mk('span', 'lb-v'));
  b.lastChild.append(mk('b', '', v), unitOf(r.v));      // the trophy icon for the Trophies board (NOTES 136)
  h.badge(nm, true);      // the hammer on the developer's name, as in a court
  if (hasRank) h.rankBadge(nm, { tier: r.tier, div: r.div });      // the rank emblem, as beside a name on a court. None for a player with no trophies yet
  b.setAttribute('aria-label', `${r.rank}. ${r.name}${nm.classList.contains('is-dev') ? ', Developer' : ''}${hasRank ? ', ' + rankName(r.tier, r.div) : ''}, ${v} ${unit}${mine ? ', you' : ''}. Open profile`);
  li.append(b); return li;
}
function drawYou() {
  const en = on && me.enabled, a = en ? me.account : null, P = places, B = BOARD[board], mine = P && P.listed ? P[board] : null;
  const go = $('btn-lb-go'); let cap = '', act = null;
  if (!en) cap = '';
  else if (!a) { cap = 'Sign in to get on the global leaderboard'; act = ['Sign in', () => signIn()]; }
  else if (!a.username) { cap = 'Pick a username to get on the global leaderboard'; act = ['Pick a username', () => claimCard()]; }
  else if (P && P.hidden) cap = 'You’re hidden from the global leaderboard';
  else if (!mine) cap = B.none;
  else cap = mine.rank <= 100 ? 'Your global rank' : 'Your global rank, outside the top 100';
  show('lb-you', !!cap); text('lb-you-cap', cap); text('lb-you-rank', mine ? rankNum(mine.rank) : '');
  { const v = $('lb-you-v'); if (v) { v.textContent = ''; if (mine) v.append(mk('b', '', Number(mine.v).toLocaleString('en-US')), unitOf(mine.v)); } }
  $('lb-you')?.classList.toggle('is-on', !!mine);
  { const y = $('lb-you'), link = !!mine && !!(a && a.username); if (y) {      // on the board: the You card opens my own profile card, as my row does (NOTES 141: everyone on the leaderboard is clickable)
    y.classList.toggle('is-link', link);
    if (link) { y.dataset.name = a.username; y.setAttribute('role', 'button'); y.tabIndex = 0; y.setAttribute('aria-haspopup', 'dialog'); y.setAttribute('aria-label', `You, ${rankNum(mine.rank)}, ${Number(mine.v).toLocaleString('en-US')} ${B.unit(mine.v)}. Open your profile card`); }
    else { delete y.dataset.name; for (const k of ['role', 'tabindex', 'aria-haspopup', 'aria-label']) y.removeAttribute(k); } } }
  if (go) { go.hidden = !act; if (act) { go.textContent = act[0]; go.onclick = act[1]; } }
  const t = $('tog-lb-show'); if (t) { t.hidden = !(a && a.username && P); t.setAttribute('aria-checked', String(!(P && P.hidden))); }      // the switch: only for a name that could be on a board
}
async function drawBoard() {
  const g = ++boardGen, B = BOARD[board], list = $('lb-list'), st = $('lb-state');
  for (const o of $('lb-tabs')?.children || []) { const yes = o.dataset.board === board; o.setAttribute('aria-checked', String(yes)); o.tabIndex = yes ? 0 : -1; }
  text('lb-what', B.what); drawYou();
  if (!list) return;
  list.setAttribute('aria-busy', 'true');
  let j = null; try { const r = await api('/api/leaderboard?b=' + board); j = r.ok ? r.j : null; } catch { j = null; }
  if (g !== boardGen) return;
  list.textContent = ''; list.setAttribute('aria-busy', 'false');
  const rows = j && Array.isArray(j.rows) ? j.rows.filter(r => r && typeof r.name === 'string' && Number.isFinite(r.v) && Number.isInteger(r.rank)) : null;
  const myName = me.account && me.account.username && !(places && places.hidden) ? me.account.username : null;
  if (rows) for (const r of rows) list.append(boardRow({ ...r, name: r.name.slice(0, 12) }, r.name === myName));
  const msg = !rows ? 'The leaderboard isn’t available right now' : !rows.length ? 'Nobody is on this board yet' : '';
  if (st) { st.textContent = msg; st.hidden = !msg; }
  list.scrollTop = 0;
}
export async function showBoard() {                        // the view opened: the board at once, then my places from /api/stats
  { const tabs = $('lb-tabs'), w = tabs && tabs.dataset.want; if (w) { delete tabs.dataset.want; if (BOARD[w]) board = w; } }      // opened from a place pill: that pill's board
  drawBoard(); if (!on) return;
  const p = await fetchProfile(); places = placeOf(p);
  if (h.view() === 'leaderboard') drawBoard();      // my row lights up once the list knows whether I am hidden
}
function setBoard(b) { if (!BOARD[b] || b === board) return; board = b; drawBoard(); }
async function toggleShow() {
  const t = $('tog-lb-show'); if (!t || !me.account) return;
  const hide = t.getAttribute('aria-checked') === 'true';
  t.setAttribute('aria-checked', String(!hide));      // at once: the answer confirms or puts it back
  let r = null; try { r = await api('/api/leaderboard/hide', 'POST', { hidden: hide }); } catch { r = null; }
  if (r && r.ok && r.j) { places = placeOf(r.j);
    if (hide) h.toast('You’re hidden from the global leaderboard', 2000);
    else if (ls.get(LB_SEEN) !== '2') { clearTimeout(lbT); h.toast('You’re on the global leaderboard. Anyone can open your profile card from it', 5000); ls.set(LB_SEEN, '2'); }      // the profile-card notice the privacy page promises, said now, not on the next load (NOTES 140)
    else h.toast('You’re on the global leaderboard', 2000); }
  else { t.setAttribute('aria-checked', String(hide)); h.toast('Couldn’t change that. Try again.', 2400); }
  if (h.view() === 'leaderboard') drawBoard();
}

// ---------- a player's profile card (NOTES 140 + docs/SOCIAL.md 6): ONE card, opened from a leaderboard row, a friends list, search results and On this court.
// It asks two things at once: GET /api/leaderboard/player?u=<name> (the share card's subset: rank, trophies, the toughest Matt, the eleven stats (NOTES 145); public, any
// account on a board, else 404) and, when I am signed in with a username, GET /api/player?name=<name> (rank, places, what we are to each other, a friend's status).
// The friend row under it is web/social.js's (h.friend): it owns the lists and the requests. No URL of its own ----------
let lbpGen = 0, lbpName = '', lbpFrom = 'board', lbpSaid = null, lbpRow = 'off';      // lbpRow: the friend row's kind now (on | self | off); lbpGen: this sheet's own generation (loadGen is sign-in's); lbpName: the name it shows, to find its row again (a list redraws under the sheet); lbpFrom: 'board' | 'friends' | 'court'; lbpSaid: /api/player's answer
const STAT_LABELS = ['Win rate', 'On court', 'Best streak', 'Returns', 'Points won', 'Rally', 'Swing', 'Winners', 'Aces', 'Smashes', 'Titles'], HERO_N = 3, MATT = ['Rookie', 'Club', 'Tour', 'Pro'];      // the share card's eleven tags in its order (server/card.js dataOf, NOTES 145): the first three are its headline figures. MATT: difficulty order, as is-lv<i>
const figB = v => { const b = mk('b'); if (v === '-' || v === '–') { b.textContent = v; b.className = 'is-none'; return b; } for (const r of v.match(/\d[\d,-]*|[^\d]+/g) || [v]) b.append(/^\d/.test(r) ? r : mk('i', '', r)); return b; };      // "72%", "11h 6m": the digits big, % h m small, as the card draws them (textContent stays the whole value)
const PLACE_BOARDS = [['trophies', 'Trophies'], ['rally', 'Longest rally'], ['streak', 'Win streak']];      // /api/player's places, in the leaderboard's own words
export const playerOpen = () => cardOpen() && !!$('lbp-card') && !$('lbp-card').hidden;
export const inLobby = () => !!h.view();      // web/social.js: the lobby is up (not a court, not the title): a sign-in from the card is safe there, never mid-match
export function closePlayer() { if (playerOpen()) closeCard(); }      // main.js: MATCH FOUND and a tournament's VS card; seated(): a seat of my own
// openPlayer(name, { from, rank, via, back }): from = the element pressed (focus goes back to it; Safari does not focus a clicked button); rank = {tier,div}
// for the loading face; via = 'board' | 'friends' | 'court'; back() = where focus goes when a redraw replaced `from` (web/social.js: that name's new row)
// NOTES 150: the card opens ONCE, whole. It used to open at once on a skeleton (dashes, no places, no friend row) and then grow into the full card
// when the answers came, which read as a second, lesser card popping up first. Now the name pressed shows it is busy (.is-opening) and the card
// opens when both answers are in (or at the 8 s cap, on its error face). Esc, another name, or leaving the view while it waits drops the opening.
let lbpWait = null;      // { g, mark }: an opening waiting for its answers
const lbpUnwait = () => { if (!lbpWait) return; const m = lbpWait.mark; if (m) { m.classList.remove('is-opening'); m.removeAttribute('aria-busy'); } lbpWait = null; };
export function openPlayer(name, { from = null, rank = null, via = 'board', back = null } = {}) {
  name = typeof name === 'string' ? name.slice(0, 12) : ''; if (!name || !$('lbp-card')) return;
  if (from && document.activeElement !== from && from.isConnected) from.focus({ preventScroll: true });
  lbpUnwait(); const v0 = h.view(), mark = from && from.isConnected ? from : null;
  if (mark) { mark.classList.add('is-opening'); mark.setAttribute('aria-busy', 'true'); }
  loadPlayer(name, rank && Number.isInteger(rank.tier) ? { tier: rank.tier, div: rank.div } : null, g => {      // the answers are in: open now, unless the moment has passed
    const ok = lbpWait && lbpWait.g === g && h.view() === v0 && !cardOpen(); lbpUnwait();      // a list redrawn under the name (a push, the board refreshing) still opens: Close finds the focus through back()
    if (!ok) return false; lbpName = name; lbpFrom = via; openCard('lbp-card', back, mark); return true; });
  lbpWait = { g: lbpGen, mark };
}
addEventListener('keydown', e => { if (e.key === 'Escape' && lbpWait) { e.preventDefault(); e.stopImmediatePropagation(); lbpGen++; lbpUnwait(); } }, true);      // Esc while a card is on its way: no card, and not the lobby's Back
const asked = () => !!(on && me.enabled && me.account && me.account.username);      // /api/player is asked only by a player who can have friends: its rel and st are for them
async function loadPlayer(name, rank, open = null) {      // rank: the opener's emblem for a retry's loading face. open(g): a first opening (the card is not up yet: no loading face, NOTES 150)
  const g = ++lbpGen; lbpSaid = null; if (!open) drawPlayer({ name, rank }, 'loading');      // a retry (Try again, the card is up): its own loading face
  const get = u => Promise.race([api(u).catch(() => null), new Promise(r => setTimeout(() => r(null), 8000))]), both = await Promise.all([get('/api/leaderboard/player?u=' + encodeURIComponent(name)), asked() ? get('/api/player?name=' + encodeURIComponent(name)) : null]);
  if (g !== lbpGen) return;      // another name, Esc or a close meanwhile: these answers are stale
  if (open ? !open(g) : !playerOpen()) return;      // a first opening that is no longer wanted, or a retry whose card was closed
  const [r, q] = both, lb = r && r.ok && r.j && typeof r.j.name === 'string' ? r.j : null, pl = q && q.ok && q.j && typeof q.j.name === 'string' ? q.j : null;
  lbpSaid = pl ? { rel: pl.rel, st: pl.st } : null;
  if (lb) drawPlayer({ ...lb, places: pl && pl.places }, 'ok');
  else if (pl) drawPlayer({ name: pl.name, rank: pl.rank, places: pl.places, open: pl.places !== null && pl.places !== undefined }, r && r.status === 404 ? 'part' : 'partx');      // not on a board (or the stats failed): the rank and places, no stats
  else drawPlayer({ name }, r && r.status === 404 && (!q || q.status === 404) ? 'gone' : 'error');      // 404 (both, or the only one asked): hidden, renamed, deleted or on no board (the server never says which). 429, 503, offline: Try again
}
const strOf = (v, n) => (typeof v === 'string' || Number.isFinite(v) ? String(v).slice(0, n) : '');
function drawPlayer(p, state) {
  const c = $('lbp-card'); if (!c) return;
  const name = String(p.name || '').slice(0, 12), nm = $('lbp-name'); if (nm) { nm.textContent = name; h.badge(nm, true); }      // the hammer beside the developer's name
  const part = state === 'part' || state === 'partx';
  c.dataset.state = part ? 'part' : state;      // loading | ok | part (no stats: not on a board) | gone | error. An attribute, not a class: .panel.is-error is the red nudge of a form
  const rank = p.rank && typeof p.rank === 'object' && Number.isInteger(p.rank.tier) ? { tier: tierNum(p.rank.tier), div: divNum(p.rank.div) } : null;
  const hero = $('lbp-hero'); if (hero) { hero.className = 'lbp-hero well' + (rank ? ' is-' + RANK_NAME[rank.tier - 1].toLowerCase() : ' is-none') + (part ? ' no-matt' : ''); hero.hidden = part && !rank && !p.open; }      // no Matt without the board's answer. A hidden account's rank (not my friend): no hero at all, never 'No trophies yet'
  h.emblem($('lbp-em'), rank);
  text('lbp-rank', rank ? (state === 'ok' && typeof p.rank.label === 'string' ? p.rank.label.slice(0, 24) : rankName(rank.tier, rank.div)) : state === 'loading' ? '' : 'No trophies yet');      // 'Pro #3' only from the board's answer
  const tro = num(p.trophies); show('lbp-tro', !!rank && state === 'ok'); text('lbp-trophies', tro.toLocaleString('en-US')); text('lbp-tro-cap', tro === 1 ? 'trophy' : 'trophies');
  const mi = MATT.indexOf(p.matt), mb = $('lbp-matt'); if (mb) mb.className = 'lbp-matt st-mbadge ' + (mi < 0 ? 'is-none' : 'is-lv' + mi);
  text('lbp-mbest', state === 'loading' ? '–' : mi < 0 ? 'None yet' : `${MATT[mi]} Matt`);
  const pl = $('lbp-places');      // the place numbers /api/player gave (never the values): one short line
  if (pl) { pl.textContent = ''; const P = p.places && typeof p.places === 'object' ? p.places : null;
    for (const [k, l] of PLACE_BOARDS) { const x = P && P[k] && Number.isInteger(P[k].rank) && P[k].rank > 0 ? P[k].rank : 0; if (!x) continue;
      const li = mk('li', 'lbp-place' + (x <= 3 ? ' is-top' + x : '')); li.append(mk('b', '', '#' + x.toLocaleString('en-US')), mk('span', '', l)); pl.append(li); }
    pl.hidden = !pl.children.length || (state !== 'ok' && !part); }
  const dl = $('lbp-stats');
  if (dl) {
    const S = Array.isArray(p.stats) && p.stats.length === STAT_LABELS.length && p.stats.every(s => s && typeof s.label === 'string' && (typeof s.value === 'string' || Number.isFinite(s.value))) ? p.stats : null;
    dl.textContent = ''; dl.setAttribute('aria-busy', String(state === 'loading'));
    STAT_LABELS.forEach((l, i) => { const s = S ? S[i] : null, d = mk('div', 'lbp-stat' + (i < HERO_N ? ' is-hero' : '') + (s ? '' : ' is-skel')), dd = mk('dd');      // a div of dt + dd (+ the note's own dd): the only children a dl allows
      dd.append(s ? figB(strOf(s.value, 12) || '–') : mk('b', '', '–')); if (s && s.unit) dd.append(mk('small', '', strOf(s.unit, 6)));
      const dt = mk('dt', '', s ? strOf(s.tag, 16) || s.label.slice(0, 24) : l); if (s) dt.title = s.label.slice(0, 32);      // the card's short caps; the long name ("Win rate vs people") on hover
      d.append(dt, dd); if (i < HERO_N) d.append(mk('dd', 'lbp-note', s ? strOf(s.note, 28) : '\u00a0')); dl.append(d); });      // the headline's note: "31-12 vs people", "all modes"
  }
  const msg = state === 'gone' ? (lbpFrom === 'board' ? 'This player isn’t on the leaderboard any more' : 'No player with that username any more') : state === 'error' ? 'Couldn’t load this player' : state === 'partx' ? 'Couldn’t load the stats' : state === 'part' ? 'Stats show for players on the global leaderboard' : '';
  text('lbp-msg', msg); show('lbp-msg', !!msg); $('lbp-msg')?.classList.toggle('is-note', part); show('lbp-retry', state === 'error' || state === 'partx');
  const mine = (state === 'ok' || part) && !!(me.account && me.account.username) && name.toLowerCase() === me.account.username.toLowerCase();      // my own card: the same public view, and the way to Your stats
  show('lbp-foot', mine);
  lbpRow = state === 'ok' || part ? (mine ? 'self' : 'on') : 'off'; drawFriend();
}
function drawFriend() {      // the friend row (web/social.js draws it into #lbp-friend): only on a card that loaded, never on my own
  const f = $('lbp-friend'); if (!f) return;
  if (lbpRow !== 'on') { f.hidden = true; f.textContent = ''; delete f.dataset.sig; return; }
  h.friend(f, { name: lbpName, rel: lbpSaid && lbpSaid.rel, st: lbpSaid && lbpSaid.st, gen: lbpGen });      // gen: a new opening (a confirm left open last time starts closed)
}
export function friendRow() { if (playerOpen()) drawFriend(); }      // web/social.js: a push, a request answered, a sign-in: the open card's row follows
function retryPlayer() {
  const c = $('lbp-card'); if (!lbpName || !playerOpen()) return;
  if (c) c.focus({ preventScroll: true });      // Try again hides itself: focus waits on the card, not on <body>
  loadPlayer(lbpName, null);
}

// ---------- the trophy ladder (docs/TROPHIES.md 1, 4): Your stats and the profile card draw from the Profile's ladder ----------
const RANK_NAME = ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Master', 'Champion', 'Pro'], ROMAN = ['', 'I', 'II', 'III'], TOP = RANK_NAME.length;   // eight since Master (NOTES 124); TOP: Pro, no divisions      // web/emblems.js RANKS, by tier (this file imports nothing from ui.js or emblems.js: see the header)
const tierNum = t => Number.isInteger(t) && t >= 1 && t <= TOP ? t : 1, divNum = d => (d === 2 || d === 3 ? d : 1);
const trophyPlace = p => { const P = placeOf(p); return P && P.listed && P.trophies && Number.isInteger(P.trophies.rank) ? P.trophies.rank : null; };      // my trophy leaderboard place: Pro shows it as 'Pro #12'
function ladderOf(p) {                                      // p.ladder as the server sends it (10.1 profileOf), or null when the Profile has none (an older server, nothing saved)
  const L = p && p.ladder && typeof p.ladder === 'object' ? p.ladder : null; if (!L || L.row === false) return null;      // row false: the server says no ladder row yet
  if (!num(L.trophies) && tierNum(L.tier) === 1 && !num(L.wins) && !num(L.losses) && !num(L.botWins) && !num(L.botLosses)) return null;      // an older server sends tier 1 zeros for a player never paid or charged (db.ladderOf): no trophies yet, not Bronze I
  return { place: trophyPlace(p), tier: tierNum(L.tier), div: tierNum(L.tier) === TOP ? 1 : divNum(L.div), trophies: num(L.trophies), best: tierNum(L.bestTier), bestDiv: divNum(L.bestDiv), bestAt: Number.isFinite(L.bestTierAt) ? L.bestTierAt : 0, next: num(L.next), wins: num(L.wins), losses: num(L.losses), streak: num(L.streak), botWins: num(L.botWins), botLosses: num(L.botLosses), mattDayLeft: num(L.mattDayLeft) };
}
let ranksGen = 0;
const signedIn = () => (!on || !me.account ? false : !me.account.username ? 'username' : true);      // the hero's empty line (ui.rankCrest): a guest is asked to sign in, an account without a username to pick one, an account to win a game
// acctGate() -> '' when this player can have friends (docs/SOCIAL.md 1), else 'off' (no sign-in or no database here: nobody can) | 'signin' | 'username' |
// 'wait' (/api/me has not answered yet: until then `me` is its default, which would read as 'off', and a reload on /friends said 'not available')
export const acctGate = () => (!on ? 'off' : !meDone ? 'wait' : !me.enabled || !me.db ? 'off' : !me.account ? 'signin' : !me.account.username ? 'username' : '');
export const ready = () => mePromise;      // /api/me has answered (a reload straight onto /friends waits for it)
// the server answered a signed-in call with 401 signin (the session expired, or was signed out or deleted elsewhere) or 403 username (no username after all):
// /api/me is asked again first (a busy database answers a session lookup the same way), and only what it confirms is dropped; then this page follows, so the
// Friends gate asks for the right step and Sign in / Pick a username work again. web/social.js calls it. -> 'signin' | 'username' (what went) | '' (nothing)
export function acctLost() {
  if (!on || !me.account) return Promise.resolve(''); if (lostP) return lostP;
  lostP = (async () => { let r = null; try { r = await api('/api/me'); } catch { r = null; }
    if (!me.account || !r || !r.ok || !r.j) return '';      // no answer: unknown, so nothing is dropped
    const a = acct(r.j.account), what = !a ? 'signin' : !a.username ? 'username' : '';
    if (what) { me.account = a; meLadder = null; drawAcct(); redrawView(); } return what; })().finally(() => { lostP = null; });
  return lostP;
}
const redrawView = () => { const v = h.view(); if (v === 'profile') showProfile(); else if (v === 'leaderboard') showBoard(); else if (v === 'ranks') showRanks(); };      // after a sign-in, sign-out or new username: the open view redraws
export const pickName = () => claimCard();      // Pick a username, from the friends gate (web/social.js)
export async function showRanks() {                        // the Ranks page opened with no rank known (a reload on /ranks): /api/stats, then the crest (ui.rankCrest keeps the rank and its place for the page)
  const g = ++ranksGen; if (!on) return;
  const p = await fetchProfile(); if (g !== ranksGen || h.view() !== 'ranks' || p === undefined) return;      // no answer: the page reads as before (no rank of mine on it)
  h.crest(ladderOf(p), signedIn());      // the same draw as Your stats' hero, so the two agree
}

// ---------- the account cards (9.5, 9.7): over everything, one at a time. Escape closes; game keys never reach main.js behind them ----------
export const cardOpen = () => { const l = $('acct-layer'); return !!l && !l.hidden; };
function openCard(id, back, from = null) {      // from: the element that asked for it, when the card opens later than the press (a profile card waits for its answers, NOTES 150)      // back() -> where Close puts the focus if the opener's element is gone (a friends panel redrew: openPlayer's back)
  const l = $('acct-layer'), c = $(id); if (!l || !c) return;
  if (!cardOpen()) { lastFocus = from || document.activeElement; lastBack = typeof back === 'function' ? back : null; }
  for (const k of l.children) k.hidden = k !== c; l.hidden = false; openAt = performance.now();
  setTimeout(() => { if (!c.hidden) (c.querySelector('[data-first]:not([hidden])') || c).focus({ preventScroll: true }); }, 30);
}
export function closeCard() {
  const l = $('acct-layer'); if (!l || l.hidden) return; l.hidden = true; loadGen++; lbpGen++;
  let f = lastFocus, again = false; const b = lastBack; lastFocus = lastBack = null;
  if (f && !f.isConnected && lbpName) { f = [...($('lb-list')?.querySelectorAll('button.lb-row') || [])].find(b => b.dataset.name === lbpName) || null; again = !!f; }      // the board redrew under the profile sheet: the same player's new row (.find, never a selector built from a name)
  if ((!f || !f.isConnected || !f.offsetParent) && b) f = b();      // a friends panel redrew under it: back() finds that name's row, or the search (web/social.js)
  lbpName = '';
  if (f && f.isConnected && f.offsetParent) { f.focus({ preventScroll: true }); if (again) f.scrollIntoView({ block: 'nearest' }); }      // back where the player was (the result card's own buttons keep theirs)
}
const err = (id, t) => text(id, t || '');
export function signIn() {                                  // our own button (the nudge, Your stats, Settings) opens the card: NOTHING goes to Google yet
  if (!on || !me.enabled || me.account) return;
  nonceP = null;                                            // a fresh nonce for this card
  show('signin-main', true); show('name-claim', false); show('signin-btn', false); show('signin-hint', true); text('signin-hint', 'Loading Google sign-in'); err('signin-err');
  openCard('signin-card'); loadGoogle();                    // opening the card is the player's act: Google's script and button come now
}
function loadGis() {                                        // Google's script, injected once, only after the player opens the card. A failure lets a later open try again
  if (window.google && window.google.accounts && window.google.accounts.id) return Promise.resolve();
  if (gsi) return gsi;
  gsi = new Promise((res, rej) => { const s = document.createElement('script'); s.src = GSI; s.async = true;
    const t = setTimeout(() => { s.remove(); rej(new Error('timeout')); }, 8000);
    s.onload = () => { clearTimeout(t); window.google && window.google.accounts && window.google.accounts.id ? res() : rej(new Error('empty')); };
    s.onerror = () => { clearTimeout(t); s.remove(); rej(new Error('blocked')); }; document.head.append(s); });
  gsi.catch(() => { gsi = null; }); return gsi;
}
async function loadGoogle() {                               // 6.2 steps 2-3: the nonce and Google's script, in parallel, then Google's own button in the card
  const g = ++loadGen; err('signin-err'); show('signin-google', true); show('signin-btn', false); show('signin-hint', true); text('signin-hint', 'Loading Google sign-in');
  try {
    if (!nonceP) { const p = nonceP = api('/api/signin/nonce'); p.then(n => { if (!n.ok && nonceP === p) nonceP = null; }, () => { if (nonceP === p) nonceP = null; }); }
    const [n] = await Promise.all([nonceP, loadGis()]); if (g !== loadGen) return;      // the card was closed meanwhile
    if (!n.ok || !n.j || typeof n.j.nonce !== 'string') throw new Error('nonce');
    const id = window.google.accounts.id, el = $('signin-btn');
    id.initialize({ client_id: me.clientId, nonce: n.j.nonce, callback: onCredential, ux_mode: 'popup', auto_select: false, cancel_on_tap_outside: true, context: 'signin', itp_support: true, use_fedcm_for_button: true });      // One Tap (prompt()) is never called
    el.replaceChildren(); id.renderButton(el, { type: 'standard', theme: 'outline', size: 'large', text: 'signin_with', shape: 'pill', logo_alignment: 'left' });
    show('signin-hint', false); show('signin-btn', true);
  } catch { if (g === loadGen) { show('signin-google', false); err('signin-err', 'Google sign-in could not load. You can keep playing as a guest.'); } }      // the button's room goes with it: no gap over the message
}
async function onCredential(resp) {                        // Google's popup answered: the ID token goes to our server once, and is dropped
  const credential = resp && typeof resp.credential === 'string' ? resp.credential : ''; if (!credential) return;
  err('signin-err');
  let r; try { r = await api('/api/signin', 'POST', { credential, ...devBody() }); } catch { r = { ok: false, status: 0 }; }
  nonceP = null;                                            // single use: the server cleared it with this answer
  if (!r.ok || !r.j) { const msg = r.status === 403 ? 'That sign-in timed out. Try again.' : r.status === 503 ? 'Sign-in isn’t available right now. You can keep playing as a guest.' : 'Couldn’t sign you in. Try again.';
    if (r.status === 503) { show('signin-btn', false); show('signin-hint', false); err('signin-err', msg); } else loadGoogle().then(() => err('signin-err', msg)); return; }      // the nonce is single use: Google's button comes back with a new one
  me.account = acct(r.j.account) || { username: null, renameAt: null }; saved = null; meLadder = null; drawAcct(); h.redial();      // the socket opens again (after the match) so its upgrade carries the cookie
  redrawView();
  if (!me.account.username) claimCard(); else { closeCard(); h.toast(`Signed in as ${me.account.username}`, 2400); }      // no username yet: pick one now (Skip for now is there)
}
export async function signOut() {                           // only the server's 204 clears the HttpOnly cookie: anything else leaves the player signed in, and says so
  if (!on) return;
  let r; try { r = await api('/api/signout', 'POST', {}); } catch { r = { ok: false, status: 0, j: null }; }
  if (r.status !== 204) { h.toast(r.status === 429 ? `Couldn’t sign you out. Try again in ${Math.max(1, num(r.j && r.j.retryAfter))} s.` : 'Couldn’t sign you out. Try again.', 2600); return; }
  me.account = null; meLadder = null; forgetDevice(); drawAcct(); h.redial(); h.toast('Signed out', 1800);
  redrawView();
}

// ---------- Share card (docs/SHARE.md 2-3): one public link per profile that unfurls as a picture. The click copies it, then the sheet opens ----------
const WEB = /^https?:\/\/[^\s"'<>\\]{1,400}$/;      // what the server makes: https://poddleball.com/c/<slug> and its .png (http://<host> locally)
const shareOf = x => x && typeof x === 'object' && typeof x.url === 'string' && WEB.test(x.url) && typeof x.image === 'string' && WEB.test(x.image) ? { url: x.url, image: x.image } : null;
function clip(what) {                                       // -> a promise of true once the clipboard has it. Called INSIDE the click, before any await (Safari's rule)
  const c = navigator.clipboard, wt = u => c && typeof c.writeText === 'function' ? c.writeText(u).then(() => true, () => false) : false;      // writeText: the fallback where ClipboardItem is missing or refused
  try {
    if (typeof what === 'string') return Promise.resolve(wt(what));
    if (c && typeof c.write === 'function' && typeof ClipboardItem === 'function')      // the link is not known yet: hand Safari a promise of it now
      return c.write([new ClipboardItem({ 'text/plain': what.then(u => new Blob([u], { type: 'text/plain' })) })]).then(() => true, () => what.then(wt, () => false));
    return what.then(wt, () => false);
  } catch { return Promise.resolve(what && typeof what.then === 'function' ? what.then(wt, () => false) : false); }
}
function makeLink() {                                       // POST /api/share once at a time -> a promise of the url (rejects: no link)
  if (!shareP) { shareP = api('/api/share', 'POST', devBody()).then(r => { const s = r.ok && shareOf(r.j); if (!s) throw new Error(String(r.status)); share = s; return s.url; }); shareP.then(() => { shareP = null; }, () => { shareP = null; }); }
  return shareP;
}
async function shareCard() {                                // Share card: copy first (synchronously when the link is known), then the sheet
  if (!on || !shareable) return;
  const b = $('btn-pf-share'); if (b && document.activeElement !== b) b.focus({ preventScroll: true });      // the sheet hands focus back here (Safari does not focus a clicked button)
  let copied;
  if (share) copied = clip(share.url);
  else { const p = makeLink(); copied = clip(p);
    try { await p; } catch { copied.catch(() => {}); h.toast('Couldn’t make a link. Try again.', 2400); return; } }
  openShare(); copied.then(ok => { if (ok) { h.toast('Link copied', 1800); flashCopied(); } else pickUrl(); }, () => pickUrl());
}
let copiedT = 0;
function flashCopied() { const b = $('btn-share-copy'); if (!b) return; b.textContent = 'Copied'; b.classList.add('is-done'); clearTimeout(copiedT); copiedT = setTimeout(() => { b.textContent = 'Copy'; b.classList.remove('is-done'); }, 1800); }
function pickUrl() { const i = $('share-url'); if (i && !i.closest('[hidden]')) { i.focus({ preventScroll: true }); i.select(); } }      // no clipboard: the link is selected for the player to copy
function openShare() {
  if (!share) return; const s = share, i = $('share-url'), img = $('share-img'), fg = $('share-prev');
  if (i) i.value = s.url;
  if (img && fg && img.getAttribute('src') !== s.image) { fg.className = 'share-prev is-loading'; img.onload = () => { fg.className = 'share-prev'; }; img.onerror = () => { fg.className = 'share-prev is-broken'; }; img.src = s.image; }      // a skeleton until the picture lands
  const a = me.enabled ? me.account : null, nm = a ? (a.username ? '' : 'Pick a username to put it on your card') : me.enabled ? 'Sign in to put your name on your card' : '';      // guests are "Poddle player" on the card: their display names are never stored
  text('btn-share-name', nm); show('share-name', !!nm);
  show('btn-share-native', typeof navigator.share === 'function'); show('share-stop', true); show('share-confirm', false);
  { const b = $('btn-share-copy'); if (b) { clearTimeout(copiedT); b.textContent = 'Copy'; b.classList.remove('is-done'); } }
  openCard('share-card');
}
async function downloadCard() {                             // the PNG as a file: poddle-card.png
  if (!share) return; const u = share.image;
  try { const r = await fetch(u, { credentials: 'same-origin' }); if (!r.ok) throw new Error(String(r.status)); const blob = await r.blob(), href = URL.createObjectURL(blob), a = mk('a');
    a.href = href; a.download = 'poddle-card.png'; a.hidden = true; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(href), 4000);
  } catch { h.toast('Couldn’t download the picture. Try again.', 2400); }
}
async function stopSharing() {                              // DELETE /api/share (204, idempotent): the link dies; Share card makes a new one next time
  let r; try { r = await api('/api/share', 'DELETE', devBody()); } catch { r = { ok: false, status: 0 }; }
  if (!r.ok) { h.toast('Couldn’t stop sharing. Try again.', 2400); return; }
  share = null; closeCard(); h.toast('Sharing stopped. That link no longer works.', 2600);
}
function wireShare() {
  click('btn-pf-share', () => { shareCard(); });
  click('btn-share-close', () => closeCard());
  click('btn-share-copy', () => { if (share) clip(share.url).then(ok => { if (ok) { flashCopied(); h.toast('Link copied', 1800); } else pickUrl(); }); });
  click('btn-share-dl', () => { downloadCard(); });
  click('btn-share-native', () => { if (share && typeof navigator.share === 'function') navigator.share({ url: share.url, title: 'My Poddle card' }).catch(() => {}); });      // cancelled: nothing to say
  click('btn-share-name', () => { if (me.account) claimCard(); else signIn(); });
  click('btn-share-stop', () => { show('share-stop', false); show('share-confirm', true); const k = $('btn-share-stop-no'); if (k) k.focus({ preventScroll: true }); });      // an inline confirm, Keep it focused
  click('btn-share-stop-no', () => { show('share-confirm', false); show('share-stop', true); const k = $('btn-share-stop'); if (k) k.focus({ preventScroll: true }); });
  click('btn-share-stop-yes', () => { stopSharing(); });
  const i = $('share-url'); if (i) i.addEventListener('focus', () => i.select());
}

// ---------- the username (7.1, 7.4, 9.5): the same card, its second face. Checked here as the server checks it, the server decides ----------
const NAME_OK = /^[A-Za-z0-9_]{3,12}$/;
function nameProblem(v) {                                   // -> words for the first rule it breaks, '' = fine to send
  const n = String(v || '').normalize('NFKC');
  if (n.length < 3 || n.length > 12) return n.length ? '3 to 12 letters, numbers or _' : '';
  if (!NAME_OK.test(n)) return 'Letters, numbers and _ only';
  if (!/[A-Za-z]/.test(n)) return 'Needs at least one letter';
  if (n[0] === '_' || n[n.length - 1] === '_' || n.includes('__')) return 'No _ at the start or end, and no __';
  return '';
}
const CLAIM_ERR = { length: '3 to 12 letters, numbers or _', chars: 'Letters, numbers and _ only', letter: 'Needs at least one letter', underscore: 'No _ at the start or end, and no __', reserved: 'That name isn’t allowed', profanity: 'That name isn’t allowed' };
function claimCard() {                                      // right after a sign-in with no username, or Change name
  if (!me.account) return;
  const i = $('claim-input'); if (i) i.value = me.account.username || '';
  text('claim-title', me.account.username ? 'Change your username' : 'Pick a username'); text('btn-claim-skip', me.account.username ? 'Cancel' : 'Skip for now');
  err('claim-err'); show('signin-main', false); show('name-claim', true); openCard('signin-card');
  setTimeout(() => { if (i && !i.closest('[hidden]')) i.focus({ preventScroll: true }); }, 40);
}
export async function claimName(name) {                    // -> true when the server took it
  const n = String(name || '').normalize('NFKC').trim(), bad = nameProblem(n);
  if (bad || !n) { err('claim-err', bad || '3 to 12 letters, numbers or _'); return false; }
  let r; try { r = await api('/api/username', 'POST', { username: n }); } catch { r = { ok: false, status: 0, j: null }; }
  if (r.ok && r.j && typeof r.j.username === 'string') {
    me.account = { username: r.j.username.slice(0, 12), renameAt: Number.isFinite(r.j.renameAt) ? r.j.renameAt : null }; drawAcct(); h.redial();      // the court shows the badge once the socket's upgrade carries the cookie again
    closeCard(); h.toast(`Your username is ${me.account.username}`, 2400); redrawView(); return true;
  }
  const j = r.j || {};
  err('claim-err', r.status === 409 ? 'That name is taken' : r.status === 422 ? CLAIM_ERR[j.reason] || 'That name isn’t allowed' : r.status === 423 ? `You can change your name again on ${day(j.until) || 'a later day'}` : r.status === 401 ? 'You’re signed out. Sign in again to pick a name.' : 'Couldn’t save that name. Try again.');
  return false;
}

// ---------- who is signed in, everywhere it shows. Everything signed-in-only stays hidden unless /api/me said sign-in is on (9) ----------
function drawAcct() {
  const en = on && me.enabled, a = en ? me.account : null, name = a && a.username;
  show('btn-pf-signin', en && !a); show('btn-pf-signout', !!a); show('btn-pf-rename', !!a); show('btn-pf-share', on && shareable); show('pf-acct', en || (on && shareable));      // Share card shows with sign-in off too
  { const b = $('btn-pf-rename'); if (b) { const t = name ? 'Change username' : 'Pick a username'; b.setAttribute('aria-label', t); b.title = t; } }      // the pen beside the name
  show('btn-set-signin', en && !a); show('set-account', !!a); text('set-account-name', name ? `Signed in as ${name}` : 'Signed in');
  if (!en || a) show('btn-save-signin', false);      // the nudge is for guests only
  { const b = $('btn-head-acct'); if (b) { b.hidden = !en; b.classList.toggle('is-in', !!a); text('head-acct-t', !a ? 'Sign in' : name || 'Pick a username');      // the header's account button (NOTES 151): only where accounts exist
    b.setAttribute('aria-label', !a ? 'Sign in' : name ? `${name}: your stats` : 'Pick a username'); b.dataset.tip = !a ? 'Sign in' : name ? 'Your stats' : 'Pick a username'; } }
  h.lockName(name || null);                                  // a username is the name: both name fields show it, read-only, with Change
  show('btn-profile', on); show('btn-leaderboard', on && me.db); show('btn-friends', on && me.db && me.enabled); h.tiles(); h.acct();      // Friends (docs/SOCIAL.md 1): accounts only, so only where one can be made. h.acct: web/social.js follows who is signed in      // the leaderboard reads the database too (NOTES 126); the tiles lay out for what shows
}

// ---------- the site's storage cleared in another tab: the device id went with it. Its socket keeps the old hello, so the next match is on a new one (3.1) ----------
function storageCleared() { if (!on) return; saved = null; drawAcct(); h.redial(); }

// ---------- wiring: main.js calls init() once, while it loads (before the first socket opens) ----------
// hooks: { on, send(m), redial(), toast(text, ms), view(), badge(el, on), lockName(name|null), stats(), bot(level), tiles(), crest(L, signedIn), emblem(el, r), rankBadge(el, r), board(), cup(el), acct(), friend(box, p) }. on: this page's server keeps stats
// (hosted, or ?acctest=1 for test/profile-ui.mjs). Off, nothing here sends a request, makes an id or shows a control.
let mePromise = Promise.resolve(me);
const click = (id, f) => { const el = $(id); if (el) el.addEventListener('click', f); };
export function init(hooks) {
  const noop = () => {};
  h = { send: noop, redial: noop, toast: noop, view: () => '', badge: noop, lockName: noop, stats: noop, bot: noop, tiles: noop, crest: noop, emblem: noop, rankBadge: noop, board: noop, cup: noop, acct: noop, friend: noop };      // acct, friend: web/social.js (the account changed; the profile card's friend row)
  for (const k of Object.keys(h)) if (hooks && typeof hooks[k] === 'function') h[k] = hooks[k];      // only the names above: nothing else is copied in
  on = !!(hooks && hooks.on === true);
  ls.del(OLD_ON_KEY);      // Save my stats was removed (NOTES 116): a browser that had turned it off would otherwise keep a dead key. Stats are always kept now
  ls.del(OLD_FR_SEEN);      // the one-time Friends notice was removed (NOTES 147): its seen flag is a dead key
  wire(); drawAcct(); if (on) mePromise = loadMe();
}
function wire() {
  for (const id of ['btn-pf-signin', 'btn-set-signin', 'btn-save-signin']) click(id, () => signIn());
  for (const id of ['btn-pf-signout', 'btn-set-signout']) click(id, () => signOut());
  for (const id of ['btn-pf-rename', 'btn-name-change', 'btn-set-name-change']) click(id, () => claimCard());      // Change: the lobby's name row and Settings > You (9.5)

  addEventListener('storage', e => { if (e.key === null) storageCleared(); });      // the site's storage was cleared in another tab
  click('btn-head-acct', () => { const a = me.account; if (!a) signIn(); else if (!a.username) claimCard(); else h.stats(); });      // the header's account button (NOTES 151)
  click('btn-signin-close', () => closeCard()); wireShare();
  click('tog-lb-show', () => toggleShow());      // Show me on the global leaderboard (NOTES 126)
  const tabs = $('lb-tabs'); if (tabs) {
    tabs.addEventListener('click', e => { const o = e.target.closest('[data-board]'); if (o) setBoard(o.dataset.board); });
    tabs.addEventListener('keydown', e => { if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return; e.preventDefault(); e.stopPropagation();      // a radio group: the arrows move the pick
      const o = [...tabs.children], i = o.findIndex(x => x.dataset.board === board), n = o[(i + (e.key === 'ArrowRight' ? 1 : -1) + o.length) % o.length]; setBoard(n.dataset.board); n.focus(); });
  }
  { const y = $('lb-you'); if (y) { const go = e => y.classList.contains('is-link') && y.dataset.name && !e.target.closest('button') && openPlayer(y.dataset.name, { from: y, rank: y.dataset.tier ? { tier: +y.dataset.tier, div: +y.dataset.div } : null });      // the You card, when I am on the board (NOTES 141)
    y.addEventListener('click', go); y.addEventListener('keydown', e => { if (e.target === y && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); go(e); } }); } }
  { const list = $('lb-list'); if (list) list.addEventListener('click', e => { const b = e.target.closest('button.lb-row'); if (b && b.dataset.name) openPlayer(b.dataset.name, { from: b, rank: b.dataset.tier ? { tier: +b.dataset.tier, div: +b.dataset.div } : null }); }); }      // a row opens that player's profile card (NOTES 140): one listener, the rows redraw
  click('btn-lbp-close', () => closeCard()); click('btn-lbp-retry', () => retryPlayer());
  click('btn-lbp-mine', () => { closeCard(); h.stats(); });      // my own row's card: Your stats, one tap away
  click('btn-claim-skip', () => closeCard());
  const f = $('name-claim'); if (f) f.addEventListener('submit', e => { e.preventDefault(); claimName(($('claim-input') || {}).value); });
  const ci = $('claim-input'); if (ci) ci.addEventListener('input', () => err('claim-err', nameProblem(ci.value)));      // live, as the rules of 7.1
  const l = $('acct-layer'); if (!l) return;
  l.addEventListener('pointerdown', e => { e.stopPropagation(); if (e.target === l) e.preventDefault(); });      // the title screen starts the game on any pointerdown: not through a card. preventDefault: no mousedown, so the focus closeCard hands back is not blurred to <body>
  l.addEventListener('click', e => { e.stopPropagation(); if (e.target === l && performance.now() - openAt > 350) closeCard(); });      // the veil around the card closes it on the CLICK, while the veil is still there to take it: closed on pointerdown, a tap's click fell through to the leaderboard row under it and opened that player (NOTES 140). Not the second press of the double click that opened it
  l.addEventListener('keydown', e => {                      // the card keeps the keys: Esc closes it, Tab stays inside, no game or lobby key reaches main.js or ui.js
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); closeCard(); return; }
    if (e.key !== 'Tab') return;
    const c = [...l.children].find(k => !k.hidden); if (!c) return;
    const f = [...c.querySelectorAll('button, input, a[href], iframe, [tabindex="0"]')].filter(x => !x.disabled && x.offsetParent); if (!f.length) return;
    const i = f.indexOf(document.activeElement), n = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : (i < 0 || i === f.length - 1 ? 0 : i + 1);
    e.preventDefault(); f[n].focus();
  });
}
export const username = () => (on && me.account && me.account.username) || '';      // the registered name while signed in: main.js keeps the typed guest name in poddle.name, never this
