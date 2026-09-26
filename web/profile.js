// Player stats in the browser (docs/ACCOUNTS.md 9): the device id, the /api calls, Google's sign-in (loaded only after the age box is
// ticked, never on page load) and the DOM of what is new for it: Your stats, the result card's line, the sign-in and confirm cards,
// Settings > You and the home notice. main.js owns the socket and calls in here. No named import from ui.js on purpose: test/menu.mjs
// stubs ui.js with a fixed list of names, so main.js hands in the few ui calls this needs (init).
// Every string from the server or the player goes in as textContent. Nothing here logs an id, a name or a token.
const $ = id => document.getElementById(id);
const DEV_KEY = 'poddle.device', ON_KEY = 'poddle.stats.on', GSI = 'https://accounts.google.com/gsi/client';
const LEVEL = ['Rookie', 'Club', 'Pro', 'Tour'], ORDER = [0, 1, 3, 2];
const TIERS = [['Bronze', 0], ['Silver', 50], ['Gold', 150], ['Platinum', 300], ['Diamond', 600], ['Legend', 1000]], FIRST_WIN = [25, 50, 75, 100];      // the rank tiers by trophies, and the first-win bounty per Matt in difficulty order (NOTES 107)      // wire level -> name; the ladder in difficulty order (Tour is 3 on the wire, between Club and Pro)
const DEV_OK = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$|^[0-9a-f]{32}$/;      // the server's own check (3.1): anything else is no device id
// its own keys, NOT poddle.settings: savePrefs() rebuilds that one from a fixed list and would drop them
const ls = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* private window: nothing is kept */ } }, del(k) { try { localStorage.removeItem(k); } catch { /* same */ } } };
const show = (id, on) => { const el = $(id); if (el) el.hidden = !on; return !!el && !el.hidden; };
const text = (id, t) => { const el = $(id); if (el && el.textContent !== t) el.textContent = t; };
const mk = (tag, cls, t) => { const e = document.createElement(tag); if (cls) e.className = cls; if (t != null) e.textContent = t; return e; };
const day = ms => Number.isFinite(ms) && ms > 0 ? new Date(ms).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }) : '';
const degs = v => Math.round(v * 180 / Math.PI / 10) * 10;      // rad/s -> deg/s rounded to 10 (Q7): 27.4 rad/s = 1570°/s
const num = v => Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;

let nonceP = null;      // one sign-in nonce per card: a reopened card reuses it, so the cookie (set by whichever response lands last) always holds the nonce Google is given
let on = false, h = {}, sockHello = false, saved = null, viewGen = 0, loadGen = 0, gsi = null, lastFocus = null;      // saved: the server has a guest profile for this device (true / false / null = not asked)
let me = { enabled: false, clientId: null, account: null, db: false };      // GET /api/me: sign-in on or off, the Google client id, who is signed in

// ---------- the device id (3.1): made at the first seat, never at load. A bearer secret for the guest profile: never in a URL or a log ----------
export const statsOn = () => ls.get(ON_KEY) !== '0';      // Save my stats on this device: ON unless turned off (Q5)
export const deviceId = () => { const v = ls.get(DEV_KEY); return v && DEV_OK.test(v) ? v : ''; };
function newId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();      // not there on plain-http LAN pages: 16 random bytes in hex instead, never Math.random
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
}
export const hello = () => { if (!on) return null; if (!statsOn()) return { type: 'nostats' }; const dev = deviceId(); return dev ? { type: 'hello', dev, v: 1 } : null; };      // stats off: the server is told, so a signed-in socket records nothing either
export function opened() { const m = hello(); sockHello = !!m; return m; }      // the socket's open handler sends this FIRST (9.2); null = say nothing
export function seated() {                                  // a 'welcome' with a seat of my own: the id is made now if there is none, and its hello follows at once
  if (!on || !statsOn()) return;
  let dev = deviceId(); if (!dev) { dev = newId(); ls.set(DEV_KEY, dev); if (deviceId() !== dev) return; }      // storage refused it: a new guest every load is worse than none
  if (!sockHello) { sockHello = true; h.send({ type: 'hello', dev, v: 1 }); }      // the server keeps a socket's first hello and ignores the rest
}
const forgetDevice = () => { ls.del(DEV_KEY); saved = null; };      // rotated (3.1): sign-out, Delete my data, stats off. A fresh one is made at the next seat

// ---------- /api (8): same origin, JSON, the session cookie rides along by itself ----------
async function api(path, method = 'GET', body) {
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
      me = { enabled: s.enabled === true && !!id, clientId: id, account: s.enabled === true ? acct(j.account) : null, db: j.db === true }; } } catch { /* no answer: a guest with sign-in off */ }
  drawAcct(); return me;
}
export async function fetchProfile() {                      // -> the Profile of 8.2, null = nothing saved yet, undefined = the request failed
  if (!on) return undefined; await mePromise; const dev = deviceId(); if (!me.account && !dev) return null;      // who is signed in first (/api/me). Nothing to ask about: no request at all
  try { const r = await api('/api/stats', 'POST', devBody()); if (!r.ok || !r.j) return undefined;
    const p = r.j.profile && typeof r.j.profile === 'object' ? r.j.profile : null; if (!me.account) saved = !!p; return p; } catch { return undefined; }
}

// ---------- after a match: one line on the result card (9.3) ----------
const WHY = { not_counted: 'This match doesn’t count toward your record', self: 'Matches against yourself don’t count', restart: 'Matches brought back after an update don’t count', too_short: 'Too short to count' };
const BEST = { rally: v => `longest rally ${v}`, speed: v => `fastest swing ${degs(v)}°/s` };      // hit (power) is kept and exported but never shown: it is a unitless internal number
let overTour = false, nudged = false;      // nudged: the sign-in nudge shows once a visit, and on every first win
export function matchover(tour) { overTour = !!tour; show('result-save', false); }      // a new result: last match's line goes (result() fills it again for this one). tour: a tournament's card (the line, no nudge)
export function result(p) {                                 // the 'profile' message (8.3), right after matchover, to my seat only
  if (!on || !p || typeof p !== 'object') return; const tour = overTour;
  if (p.saved === true && p.guest === true) saved = true;
  const lv = Number.isInteger(p.level) && LEVEL[p.level] ? LEVEL[p.level] : '', why = Array.isArray(p.why) ? p.why.filter(w => typeof w === 'string') : [], bests = Array.isArray(p.bests) ? p.bests.filter(b => b && BEST[b.what] && Number.isFinite(b.v)) : [];
  let line = '';
  if (p.saved === true) {                                  // saved:false (no database, stats off, anonymous, the new-guest cap): nothing to say
    if (p.first === true) line = lv ? `First win against ${lv} Matt!` : 'Your first win!';
    else if (bests.length) { const b = bests[0], prev = Number.isFinite(b.prev) && b.prev > 0 ? b.prev : 0; line = `New best: ${BEST[b.what](b.what === 'speed' ? b.v : Math.round(b.v))}` + (prev ? ` (was ${b.what === 'speed' ? degs(prev) + '°/s' : Math.round(prev)})` : ''); }
    else if (num(p.streak) >= 2) line = `${num(p.streak)} wins in a row`;
    else if (p.ranked === false) { const w = why.find(x => WHY[x]); if (w) line = WHY[w]; }
    else if (why.includes('level')) line = 'Counted at the easiest level you played';      // R13: a level changed mid-match
  }
  const notice = p.created === true && statsOn(), nudge = p.nudge === true && !tour && me.enabled && !me.account && (p.first === true || !nudged);      // a win only (the server decides), never for a signed-in player; not after every win
  if (nudge) nudged = true; { const el = $('result-save-text'); if (el) el.classList.toggle('is-first', p.first === true && !!line); }
  text('result-save-text', line); show('result-save-text', !!line); show('result-notice', notice); show('btn-save-signin', nudge);
  show('result-save', !!(line || notice || nudge));      // no focus is taken: the rematch buttons keep it
}

// ---------- Your stats (9.4): the player card. drawRoad (the hero and the four boss nodes), drawPeople and drawTiles fill index.html's markup ----------
const NS = 'http://www.w3.org/2000/svg', dayS = ms => Number.isFinite(ms) && ms > 0 ? new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(new Date(ms).getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }) }) : '';      // "Sep 19": the card's dates are chips, the long form is for sentences
const ICON = {      // the boss discs: won = the result card's star, next = Matt's face, locked = a padlock. Constants only: nothing from the server goes through here
  star: ['0 0 48 48', [['path', { d: 'M24 4l6.2 12.6 13.8 2-10 9.8 2.4 13.8L24 35.6 11.6 42.2 14 28.4 4 18.6l13.8-2Z' }]]],
  face: ['0 0 24 24', [['circle', { cx: 12, cy: 8.25, r: 4.25 }], ['path', { d: 'M5 20.5c.5-4.75 3.25-6.75 7-6.75s6.5 2 7 6.75Z' }], ['path', { d: 'M10.25 8.5v.75M13.75 8.5v.75', 'stroke-width': 2.5 }], ['path', { d: 'M10.5 17.25h3', 'stroke-width': 2.5 }]]],      // Matt: the Play a bot tile's head and shoulders (index.html #btn-bot), scaled 96 -> 24
  lock: ['0 0 24 24', [['rect', { x: 5, y: 10.5, width: 14, height: 10, rx: 2.5 }], ['path', { d: 'M8 10.5V7.5a4 4 0 0 1 8 0v3M12 14.5v2.5' }]]] };
function svg(name) { const [box, parts] = ICON[name], s = document.createElementNS(NS, 'svg'); s.setAttribute('viewBox', box); s.setAttribute('aria-hidden', 'true');
  for (const [tag, at] of parts) { const e = document.createElementNS(NS, tag); for (const k of Object.keys(at)) e.setAttribute(k, at[k]); s.append(e); } return s; }
const cls = (id, c, onOff) => { const el = $(id); if (el) el.classList.toggle(c, !!onOff); };
const human = p => p && p.human && typeof p.human === 'object' ? p.human : {};
function rungs(p) {                                         // the four Matt rows in difficulty order, and what the card makes of them
  const rows = ORDER.map(lv => (p && Array.isArray(p.matt) ? p.matt : []).find(x => x && x.level === lv) || {}), won = rows.map(r => Number.isFinite(r.firstWinAt) && r.firstWinAt > 0);
  return { rows, won, beaten: won.filter(Boolean).length, top: won.lastIndexOf(true), nextI: won.indexOf(false) };      // top: the hardest Matt beaten = the rank (-1: none); nextI: -1 once all four are
}
function drawRoad(p) {
  const { rows, won, beaten, top, nextI } = rungs(p), H = human(p), name = i => `${LEVEL[ORDER[i]]} Matt`;
  // the hero: trophies (10 a win against people, 25/50/75/100 for a first win over each Matt, 50 a tournament title: all derived
  // from the stored record, nothing new is kept) place the player in a tier; the crest wears the tier's metal and the bar fills to the next
  const T = 10 * num(H.wins) + won.reduce((a, w, i) => a + (w ? FIRST_WIN[i] : 0), 0) + 50 * num(p && p.titles);
  let ti = 0; TIERS.forEach((t, i) => { if (T >= t[1]) ti = i; }); const cur = TIERS[ti], nxt = TIERS[ti + 1] || null;
  const crest = $('st-crest'); if (crest) crest.className = 'st-crest is-' + cur[0].toLowerCase() + (nxt ? '' : ' is-top');
  text('st-rank', cur[0]); text('st-trophies', String(T));
  text('st-rank-cap', !T ? 'Win a match for your first trophies' : nxt ? `${T === 1 ? 'trophy' : 'trophies'} · ${nxt[1] - T} to ${nxt[0]}` : `${T === 1 ? 'trophy' : 'trophies'} · top tier`);
  const bar = $('st-rank-bar'); if (bar) { const f = nxt ? (T - cur[1]) / (nxt[1] - cur[1]) : 1; bar.style.setProperty('--p', f.toFixed(3)); bar.setAttribute('aria-valuenow', String(Math.round(f * 100))); }
  let hot = { n: num(H.streak), who: 'people' }; rows.forEach((r, i) => { if (num(r.streak) && num(r.streak) >= hot.n) hot = { n: num(r.streak), who: name(i) }; });      // ties go to the harder Matt, people last
  const best = Math.max(num(H.bestStreak), ...rows.map(r => num(r.bestStreak))), st = $('st-streak');
  if (st) st.className = 'st-streak' + (hot.n >= 2 ? ' is-hot' : hot.n === 1 ? ' is-one' : '');      // gold from two wins up, never for one
  text('st-streak-n', String(hot.n));
  const cap = $('st-streak-cap'); if (cap) { cap.textContent = hot.n === 1 ? `vs ${hot.who} · win again to build it` : hot.n ? `vs ${hot.who} · best ` : 'Win one match to light the flame'; if (hot.n >= 2) cap.append(mk('b', '', String(best))); }
  // the road: a node a Matt, the gold track to the last one beaten. The Next button is the SAME element every draw (its click handler is wired once): it moves into the next node
  const ol = $('pf-rungs'), btn = $('btn-pf-next'); if (!ol) return; ol.textContent = '';
  rows.forEach((r, i) => {
    const lv = ORDER[i], state = won[i] ? 'won' : i === nextI ? 'next' : 'locked', li = mk('li', 'st-node is-' + state); li.dataset.level = lv;
    const disc = mk('i', 'st-disc'); disc.append(svg(state === 'won' ? 'star' : state === 'next' ? 'face' : 'lock'));
    const who = mk('span', 'pf-level'), rec = mk('small', '', `${num(r.wins)}-${num(r.losses)}`);      // the record leads (test/profile-ui.mjs reads it), the streak is its small print
    if (num(r.streak)) rec.append(mk('i', '', `· streak ${num(r.streak)}`)); else if (num(r.bestStreak)) rec.append(mk('i', '', `· best ${num(r.bestStreak)}`));
    who.append(mk('b', '', name(i)), rec);
    const tag = mk('span', 'st-tag' + (state === 'won' ? ' is-medal' : state === 'next' ? ' is-next' : ''), state === 'won' ? `Beaten ${dayS(r.firstWinAt)}` : state === 'next' ? (top < 0 ? 'Start here' : 'Up next') : i === 3 ? 'The final boss' : `Beat ${LEVEL[ORDER[i - 1]]} first`);
    li.append(disc, who, tag);
    if (state === 'next' && btn) { btn.hidden = false; btn.dataset.level = String(lv); btn.textContent = `Next: beat ${LEVEL[lv]} Matt`; btn.classList.add('is-focus'); li.append(btn); }
    ol.append(li);
  });
  if (btn && nextI < 0) { btn.hidden = true; btn.dataset.level = ''; btn.textContent = ''; btn.classList.remove('is-focus'); ol.after(btn); }      // all four beaten: parked, hidden, back under the list
}
function drawPeople(p) {                                    // W-L, the tug-of-war bar with its two labels, the streak chips; nothing played: the empty track and a coaching line
  const H = human(p), w = num(H.wins), l = num(H.losses), played = w + l, pct = played ? Math.round(100 * w / played) : 0;
  text('st-w', String(w)); text('st-l', String(l));
  const bar = $('st-bar'); if (bar) { bar.style.setProperty('--w', pct + '%'); bar.classList.toggle('is-empty', !played); }
  text('st-bar-l', `${pct}% won`); text('st-pts', `${num(H.pointsWon)}-${num(H.pointsLost)}`); show('st-bar-l', !!played); show('st-bar-r', !!played); show('st-people-hint', !played);
  show('st-chips', !!played); text('st-hstreak', String(num(H.streak))); text('st-hbest', String(num(H.bestStreak))); cls('st-hchip', 'is-one', num(H.streak) >= 1);
}
function tile(id, v, cap, chip) {                           // one number tile: the number (blue even at 0), its unit only with a value, the caption (a coaching line in blue when there is nothing yet), the gold chip
  const t = $(id); if (!t) return; const b = t.querySelector('.st-num b'), u = t.querySelector('.st-num small'), c = t.querySelector('.st-cap'), ch = t.querySelector('.st-chip');
  if (b) b.textContent = String(v); if (u) u.hidden = !v || !u.textContent; if (c) { c.firstElementChild.textContent = cap; c.classList.toggle('is-hint', !v); } if (ch) { ch.hidden = !v; if (chip) ch.textContent = chip; }
}
function drawTiles(p) {
  const B = p && p.bests && typeof p.bests === 'object' ? p.bests : {}, best = k => { const x = B[k] && typeof B[k] === 'object' ? B[k] : {}; return Number.isFinite(x.v) && x.v > 0 ? x : null; }, titles = num(p && p.titles);
  tile('st-t-titles', titles, titles ? `Tournament win${titles === 1 ? '' : 's'}` : 'Win a tournament to lift a cup', titles > 1 ? `Champion ×${titles}` : 'Champion');
  const r = best('rally'), s = best('speed');      // no Hardest hit: a unitless number nobody can read
  tile('st-t-rally', r ? Math.round(r.v) : 0, r ? `Set on ${dayS(r.at)}` : 'Keep the ball in play');
  tile('st-t-speed', s ? degs(s.v) : 0, s ? `Set on ${dayS(s.at)}` : 'Swing hard, it counts');
}
function drawHead(p) {
  const n = $('pf-name'), name = me.account && me.account.username, typed = (($('name-input') || {}).value || '').trim().slice(0, 12);      // the lobby's name field holds the cleaned display name
  if (n) { n.textContent = name || typed || (me.account ? 'Signed in' : 'Guest'); h.badge(n, !!name); }
  text('pf-sub', !statsOn() ? 'Stats are off' : me.account ? 'Stats saved to your account' : p && Number.isFinite(p.expiresAt) ? `Stats saved on this device until ${day(p.expiresAt)}` : 'Stats saved on this device');
  show('pf-notice', !!(p && p.guest === true && statsOn() && !me.account));      // the one-time notice (9.3) for everyone, always here: a player who left or forfeited never gets the result card's copy
}
export function drawProfile(p) {                           // p: a Profile, null (nothing yet) or undefined (not available). Guest or signed in changes only the header: every stat draws the same way
  drawHead(p); drawRoad(p || null); drawPeople(p || null); drawTiles(p || null); drawAcct();
  const msg = p === undefined ? 'Stats aren’t available right now. The game still works.' : '';      // nothing yet: no bar, the card's own lines say it (Start here, the people hint, the tile captions)
  text('pf-msg', msg); show('pf-msg', !!msg); // download and delete live on the privacy page (web/data-tools.js): the footer links there
}
export async function showProfile() {                      // the lobby view opened: draw what is known at once (empty), then the answer
  const g = ++viewGen; drawProfile(on ? null : undefined); if (!on) return;
  text('pf-msg', 'Loading your stats'); show('pf-msg', true);
  const p = await fetchProfile(); if (g === viewGen && h.view() === 'profile') drawProfile(p);
}

// ---------- the account cards (9.5, 9.7): over everything, one at a time. Escape closes; game keys never reach main.js behind them ----------
export const cardOpen = () => { const l = $('acct-layer'); return !!l && !l.hidden; };
function openCard(id) {
  const l = $('acct-layer'), c = $(id); if (!l || !c) return;
  if (!cardOpen()) lastFocus = document.activeElement;
  for (const k of l.children) k.hidden = k !== c; l.hidden = false;
  setTimeout(() => { if (!c.hidden) (c.querySelector('[data-first]:not([hidden])') || c).focus({ preventScroll: true }); }, 30);
}
export function closeCard() {
  const l = $('acct-layer'); if (!l || l.hidden) return; l.hidden = true; loadGen++;
  const f = lastFocus; lastFocus = null; if (f && f.isConnected && f.offsetParent) f.focus({ preventScroll: true });      // back where the player was (the result card's own buttons keep theirs)
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
  me.account = acct(r.j.account) || { username: null, renameAt: null }; saved = null; drawAcct(); h.redial();      // the socket opens again (after the match) so its upgrade carries the cookie
  if (h.view() === 'profile') showProfile();
  if (!me.account.username) claimCard(); else { closeCard(); h.toast(`Signed in as ${me.account.username}`, 2400); }      // no username yet: pick one now (Skip for now is there)
}
export async function signOut() {                           // only the server's 204 clears the HttpOnly cookie: anything else leaves the player signed in, and says so
  if (!on) return;
  let r; try { r = await api('/api/signout', 'POST', {}); } catch { r = { ok: false, status: 0, j: null }; }
  if (r.status !== 204) { h.toast(r.status === 429 ? `Couldn’t sign you out. Try again in ${Math.max(1, num(r.j && r.j.retryAfter))} s.` : 'Couldn’t sign you out. Try again.', 2600); return; }
  me.account = null; forgetDevice(); drawAcct(); h.redial(); h.toast('Signed out', 1800);
  if (h.view() === 'profile') showProfile();
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
    closeCard(); h.toast(`You’re ${me.account.username}`, 2400); if (h.view() === 'profile') showProfile(); return true;
  }
  const j = r.j || {};
  err('claim-err', r.status === 409 ? 'That name is taken' : r.status === 422 ? CLAIM_ERR[j.reason] || 'That name isn’t allowed' : r.status === 423 ? `You can change your name again on ${day(j.until) || 'a later day'}` : r.status === 401 ? 'You’re signed out. Sign in again to pick a name.' : 'Couldn’t save that name. Try again.');
  return false;
}

// ---------- who is signed in, everywhere it shows. Everything signed-in-only stays hidden unless /api/me said sign-in is on (9) ----------
function drawAcct() {
  const en = on && me.enabled, a = en ? me.account : null, name = a && a.username;
  show('btn-pf-signin', en && !a); show('btn-pf-signout', !!a); show('btn-pf-rename', !!a); show('pf-acct', en);
  { const b = $('btn-pf-rename'); if (b) { const t = name ? 'Change username' : 'Pick a username'; b.setAttribute('aria-label', t); b.title = t; } }      // the pen beside the name
  show('btn-set-signin', en && !a); show('set-account', !!a); text('set-account-name', name ? `Signed in as ${name}` : 'Signed in');
  if (!en || a) show('btn-save-signin', false);      // the nudge is for guests only
  h.lockName(name || null);                                  // a username is the name: both name fields show it, read-only, with Change
  show('btn-profile', on);
}

// ---------- Save my stats lives on the privacy page (web/data-tools.js, NOTES 108). This tab hears the key change through the storage event ----------
function statsChanged() {
  if (!on) return;
  if (statsOn()) { drawAcct(); h.redial(); return; }        // on again: a NEW id at the next seat (3.1), and the socket opens again after the match so that hello is its first
  forgetDevice(); sockHello = true;                        // no hello goes out on this socket any more, even at a seat
  h.send({ type: 'nostats' });                              // and the server stops recording this socket now, the match under way and a signed-in account included
  drawAcct(); h.redial();                                   // the server keeps the device of a socket's first hello: the next match is on a new socket
}

// ---------- wiring: main.js calls init() once, while it loads (before the first socket opens) ----------
// hooks: { on, send(m), redial(), toast(text, ms), view(), badge(el, on), lockName(name|null), stats(), bot(level) }. on: this page's server keeps stats
// (hosted, or ?acctest=1 for test/profile-ui.mjs). Off, nothing here sends a request, makes an id or shows a control.
let mePromise = Promise.resolve(me);
const click = (id, f) => { const el = $(id); if (el) el.addEventListener('click', f); };
export function init(hooks) {
  const noop = () => {};
  h = { send: noop, redial: noop, toast: noop, view: () => '', badge: noop, lockName: noop, stats: noop, bot: noop };
  for (const k of Object.keys(h)) if (hooks && typeof hooks[k] === 'function') h[k] = hooks[k];      // only the names above: nothing else is copied in
  on = !!(hooks && hooks.on === true);
  wire(); drawAcct(); if (on) mePromise = loadMe();
}
function wire() {
  for (const id of ['btn-pf-signin', 'btn-set-signin', 'btn-save-signin']) click(id, () => signIn());
  for (const id of ['btn-pf-signout', 'btn-set-signout']) click(id, () => signOut());
  for (const id of ['btn-pf-rename', 'btn-name-change', 'btn-set-name-change']) click(id, () => claimCard());      // Change: the lobby's name row and Settings > You (9.5)
  click('btn-pf-next', e => { const lv = +e.currentTarget.dataset.level; if (ORDER.includes(lv)) h.bot(lv); });
  addEventListener('storage', e => { if (e.key === ON_KEY || e.key === null) statsChanged(); });      // the privacy page (another tab) flipped Save my stats, or the site's storage was cleared
  click('btn-signin-close', () => closeCard());
  click('btn-claim-skip', () => closeCard());
  const f = $('name-claim'); if (f) f.addEventListener('submit', e => { e.preventDefault(); claimName(($('claim-input') || {}).value); });
  const ci = $('claim-input'); if (ci) ci.addEventListener('input', () => err('claim-err', nameProblem(ci.value)));      // live, as the rules of 7.1
  const l = $('acct-layer'); if (!l) return;
  l.addEventListener('pointerdown', e => { e.stopPropagation(); if (e.target === l) closeCard(); });      // the title screen starts the game on any pointerdown: not through a card. The veil around the card closes it
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
