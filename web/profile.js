// Player stats in the browser (docs/ACCOUNTS.md 9): the device id, the /api calls, Google's sign-in (loaded only after the age box is
// ticked, never on page load) and the DOM of what is new for it: Your stats, the result card's line, the sign-in and confirm cards,
// Settings > You and the home notice. main.js owns the socket and calls in here. No named import from ui.js on purpose: test/menu.mjs
// stubs ui.js with a fixed list of names, so main.js hands in the few ui calls this needs (init).
// Every string from the server or the player goes in as textContent. Nothing here logs an id, a name or a token.
const $ = id => document.getElementById(id);
const DEV_KEY = 'poddle.device', ON_KEY = 'poddle.stats.on', GSI = 'https://accounts.google.com/gsi/client';
const LEVEL = ['Rookie', 'Club', 'Pro', 'Tour'], ORDER = [0, 1, 3, 2];      // wire level -> name; the ladder in difficulty order (Tour is 3 on the wire, between Club and Pro)
const DEV_OK = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$|^[0-9a-f]{32}$/;      // the server's own check (3.1): anything else is no device id
// its own keys, NOT poddle.settings: savePrefs() rebuilds that one from a fixed list and would drop them
const ls = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* private window: nothing is kept */ } }, del(k) { try { localStorage.removeItem(k); } catch { /* same */ } } };
const show = (id, on) => { const el = $(id); if (el) el.hidden = !on; return !!el && !el.hidden; };
const text = (id, t) => { const el = $(id); if (el && el.textContent !== t) el.textContent = t; };
const mk = (tag, cls, t) => { const e = document.createElement(tag); if (cls) e.className = cls; if (t != null) e.textContent = t; return e; };
const day = ms => Number.isFinite(ms) && ms > 0 ? new Date(ms).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }) : '';
const degs = v => Math.round(v * 180 / Math.PI / 10) * 10;      // rad/s -> deg/s rounded to 10 (Q7): 27.4 rad/s = 1570°/s
const num = v => Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;

let nonceP = null;      // one sign-in nonce per card: re-ticking the box reuses it, so the cookie (set by whichever response lands last) always holds the nonce Google is given
let on = false, h = {}, sockHello = false, saved = null, viewGen = 0, ageGen = 0, gsi = null, lastFocus = null;      // saved: the server has a guest profile for this device (true / false / null = not asked)
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

// ---------- Your stats (9.4) ----------
function row(dl, label, value, sub) { const d = mk('div', 'pf-row'); d.append(mk('dt', '', label)); const dd = mk('dd', '', value); if (sub) dd.append(mk('small', '', sub)); d.append(dd); dl.append(d); }
function drawLadder(p) {
  const ol = $('pf-rungs'); if (!ol) return; ol.textContent = ''; let next = null;
  const rows = p && Array.isArray(p.matt) ? p.matt : [];
  for (const lv of ORDER) {
    const r = rows.find(x => x && x.level === lv) || {}, won = Number.isFinite(r.firstWinAt) && r.firstWinAt > 0, li = mk('li', 'pf-rung' + (won ? ' is-won' : ' is-locked'));
    li.dataset.level = lv; if (!won && next == null) next = lv;
    const who = mk('span', 'pf-level'); who.append(mk('b', '', `${LEVEL[lv]} Matt`), mk('small', '', `${num(r.wins)}-${num(r.losses)}` + (num(r.streak) ? ` · streak ${num(r.streak)}` : '') + (num(r.bestStreak) ? ` · best ${num(r.bestStreak)}` : '')));
    const chip = mk('span', 'pf-chip' + (won ? ' is-medal' : ''), won ? `Beaten on ${day(r.firstWinAt)}` : 'Not beaten yet');
    li.append(mk('i', 'pf-dot'), who, chip); ol.append(li);
  }
  const b = $('btn-pf-next'); if (b) { b.hidden = next == null; b.dataset.level = next == null ? '' : String(next); b.textContent = next == null ? '' : `Next: beat ${LEVEL[next]} Matt`; }
}
function drawSide(p) {
  const hu = $('pf-human'), be = $('pf-bests'); if (!hu || !be) return; hu.textContent = be.textContent = '';
  const H = p && p.human && typeof p.human === 'object' ? p.human : {}, B = p && p.bests && typeof p.bests === 'object' ? p.bests : {};
  row(hu, 'Record', `${num(H.wins)}-${num(H.losses)}`); row(hu, 'Win streak', `${num(H.streak)}`, `best ${num(H.bestStreak)}`);
  row(hu, 'Points', `${num(H.pointsWon)}-${num(H.pointsLost)}`); row(hu, 'Tournament titles', `${num(p && p.titles)}`);
  const best = (k, f) => { const x = B[k] && typeof B[k] === 'object' ? B[k] : {}, v = Number.isFinite(x.v) && x.v > 0 ? x.v : 0; return v ? [f(v), day(x.at)] : ['None yet', '']; };
  row(be, 'Longest rally', ...best('rally', v => `${Math.round(v)} hits`)); row(be, 'Fastest swing', ...best('speed', v => `${degs(v)}°/s`));      // no Hardest hit: a unitless number nobody can read
}
function drawHead(p) {
  const n = $('pf-name'), name = me.account && me.account.username, typed = (($('name-input') || {}).value || '').trim().slice(0, 12);      // the lobby's name field holds the cleaned display name
  if (n) { n.textContent = name || typed || (me.account ? 'Signed in' : 'Guest'); h.badge(n, !!name); }
  text('pf-sub', !statsOn() ? 'Stats are off' : me.account ? 'Stats saved to your account' : p && Number.isFinite(p.expiresAt) ? `Stats saved on this device until ${day(p.expiresAt)}` : 'Stats saved on this device');
  show('pf-notice', !!(p && p.guest === true && statsOn() && !me.account));      // the one-time notice (9.3) for everyone, always here: a player who left or forfeited never gets the result card's copy
}
export function drawProfile(p) {                           // p: a Profile, null (nothing yet) or undefined (not available)
  drawHead(p); drawLadder(p || null); drawSide(p || null); drawAcct();
  const msg = p === undefined ? 'Stats aren’t available right now. The game still works.' : p === null ? 'Play a match to start your record' : '';
  text('pf-msg', msg); show('pf-msg', !!msg); show('btn-pf-export', on && (!!p || !!me.account)); show('btn-pf-delete', on && (!!p || !!me.account || !!deviceId()));
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
  const l = $('acct-layer'); if (!l || l.hidden) return; l.hidden = true; ageGen++;
  const f = lastFocus; lastFocus = null; if (f && f.isConnected && f.offsetParent) f.focus({ preventScroll: true });      // back where the player was (the result card's own buttons keep theirs)
}
const err = (id, t) => text(id, t || '');
export function signIn() {                                  // our own button (the nudge, Your stats, Settings) opens the card: NOTHING goes to Google yet
  if (!on || !me.enabled || me.account) return;
  const box = $('signin-age'); if (box) box.checked = false; nonceP = null;      // unticked every time (6.5); a fresh nonce for this card
  show('signin-main', true); show('name-claim', false); show('signin-btn', false); show('signin-hint', true); text('signin-hint', 'Tick the box to continue'); err('signin-err');
  openCard('signin-card');
}
function loadGis() {                                        // Google's script, injected once, only after the age box is ticked. A failure lets a later tick try again
  if (window.google && window.google.accounts && window.google.accounts.id) return Promise.resolve();
  if (gsi) return gsi;
  gsi = new Promise((res, rej) => { const s = document.createElement('script'); s.src = GSI; s.async = true;
    const t = setTimeout(() => { s.remove(); rej(new Error('timeout')); }, 8000);
    s.onload = () => { clearTimeout(t); window.google && window.google.accounts && window.google.accounts.id ? res() : rej(new Error('empty')); };
    s.onerror = () => { clearTimeout(t); s.remove(); rej(new Error('blocked')); }; document.head.append(s); });
  gsi.catch(() => { gsi = null; }); return gsi;
}
async function ageTicked() {                                // 6.2 steps 2-3: the nonce and Google's script, in parallel, then Google's own button
  const box = $('signin-age'), g = ++ageGen; err('signin-err');
  if (!box || !box.checked) { show('signin-btn', false); show('signin-hint', true); text('signin-hint', 'Tick the box to continue'); return; }      // unticking hides Google's button again
  text('signin-hint', 'Loading Google sign-in');
  try {
    if (!nonceP) { const p = nonceP = api('/api/signin/nonce'); p.then(n => { if (!n.ok && nonceP === p) nonceP = null; }, () => { if (nonceP === p) nonceP = null; }); }
    const [n] = await Promise.all([nonceP, loadGis()]); if (g !== ageGen || !box.checked) return;
    if (!n.ok || !n.j || typeof n.j.nonce !== 'string') throw new Error('nonce');
    const id = window.google.accounts.id, el = $('signin-btn');
    id.initialize({ client_id: me.clientId, nonce: n.j.nonce, callback: onCredential, ux_mode: 'popup', auto_select: false, cancel_on_tap_outside: true, context: 'signin', itp_support: true, use_fedcm_for_button: true });      // One Tap (prompt()) is never called
    el.replaceChildren(); id.renderButton(el, { type: 'standard', theme: 'outline', size: 'large', text: 'signin_with', shape: 'pill', logo_alignment: 'left' });
    show('signin-hint', false); show('signin-btn', true);
  } catch { if (g === ageGen) { show('signin-hint', false); err('signin-err', 'Google sign-in could not load. You can keep playing as a guest.'); } }
}
async function onCredential(resp) {                        // Google's popup answered: the ID token goes to our server once, and is dropped
  const credential = resp && typeof resp.credential === 'string' ? resp.credential : ''; if (!credential) return;
  err('signin-err');
  let r; try { r = await api('/api/signin', 'POST', { credential, ...devBody() }); } catch { r = { ok: false, status: 0 }; }
  nonceP = null;                                            // single use: the server cleared it with this answer
  if (!r.ok || !r.j) { const box = $('signin-age'); if (box) box.checked = false; show('signin-btn', false); show('signin-hint', true);
    err('signin-err', r.status === 403 ? 'That sign-in timed out. Tick the box to try again.' : r.status === 503 ? 'Sign-in isn’t available right now. You can keep playing as a guest.' : 'Couldn’t sign you in. Tick the box to try again.'); return; }      // the nonce is single use: a new tick asks for a new one
  me.account = acct(r.j.account) || { username: null, renameAt: null }; saved = null; drawAcct(); h.redial();      // the socket opens again (after the match) so its upgrade carries the cookie
  if (h.view() === 'profile') showProfile();
  if (!me.account.username) claimCard(); else { closeCard(); h.toast(`Signed in as ${me.account.username}`, 2400); }
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
  show('btn-pf-signin', en && !a); show('pf-signed', !!a); show('btn-pf-rename', !!a); show('pf-acct', en);
  show('btn-set-signin', en && !a); show('set-account', !!a); text('set-account-name', name ? `Signed in as ${name}` : 'Signed in');
  if (!en || a) show('btn-save-signin', false);      // the nudge is for guests only
  h.lockName(name || null);                                  // a username is the name: both name fields show it, read-only, with Change
  show('tog-save-stats', on); show('btn-set-stats', on); show('btn-profile', on);
  const t = $('tog-save-stats'); if (t) t.setAttribute('aria-checked', String(statsOn()));
}

// ---------- Settings > You: Save my stats on this device (9.6). Its own key, '0' or '1' ----------
function statsNote(t) { text('stats-hint', t || ''); show('stats-hint', !!t); }
async function statsToggle() {
  if (!on) return;
  if (!statsOn()) { ls.set(ON_KEY, '1'); drawAcct(); statsNote(''); show('stats-off-ask', false); h.redial(); return; }      // on again: a NEW id at the next seat (3.1), and the socket opens again after the match so that hello is its first
  if (deviceId() && !me.account && saved !== false) { show('stats-off-ask', true); const k = $('btn-stats-keep'); if (k) k.focus({ preventScroll: true }); return; }      // something may be saved for this device (or the server could not say): ask first
  statsOff(false);
}
async function statsOff(del) {                              // del: Delete (the request goes BEFORE the id is removed: the id is what proves the profile is this browser's)
  show('stats-off-ask', false);
  if (del) { const ok = await deleteNow(); if (!ok) { statsNote('Couldn’t delete right now. Stats are still on.'); return; } }
  ls.set(ON_KEY, '0'); forgetDevice(); sockHello = true;      // no hello goes out on this socket any more, even at a seat
  h.send({ type: 'nostats' });                              // and the server stops recording this socket now, the match under way and a signed-in account included
  const kept = del ? '' : me.account ? 'Stats already saved to your account stay there. ' : 'Saved stats are deleted automatically 90 days after your last recorded match (7 days if only one match was recorded). ';
  drawAcct(); statsNote(kept + 'Stats are off. Matches aren’t recorded.');
  h.redial();                                               // the server keeps the device of a socket's first hello: the next match is on a new socket
  const t = $('tog-save-stats'); if (t) t.focus({ preventScroll: true });
}

// ---------- Download my data, Delete my data (9.7) ----------
export async function exportData() {
  if (!on) return false;
  let r; try { r = await fetch('/api/export', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(devBody()) }); } catch { r = null; }
  if (!r || !r.ok) { h.toast(r && r.status === 404 ? 'Nothing saved yet' : r && r.status === 429 ? 'Too many downloads. Try again later.' : 'Couldn’t download your data right now', 2600); return false; }
  const blob = await r.blob(), cd = r.headers.get('Content-Disposition') || '', m = /filename="(poddle-data-[0-9-]{10}\.json)"/.exec(cd);      // only a name of our own shape is used
  const url = URL.createObjectURL(blob), a = mk('a'); a.href = url; a.download = m ? m[1] : 'poddle-data.json'; a.hidden = true; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000); return true;
}
async function deleteNow() {                                // -> null when the request failed; else { any: something was deleted, out: signed in here but the session had ended, so the account was NOT deleted }
  const had = !!me.account;
  let r; try { r = await api('/api/account', 'DELETE', { ...devBody(), confirm: 'delete' }); } catch { r = { ok: false, status: 0 }; }
  if (!r.ok) return null;
  const d = r.j && r.j.deleted && typeof r.j.deleted === 'object' ? r.j.deleted : {};      // the server says what it deleted: a 200 alone is not a deletion
  me.account = null; forgetDevice(); saved = false; drawAcct(); h.redial();      // a fresh id at the next seat; the socket opens again after the match without the old cookie
  const out = had && d.account !== true; if (out) loadMe();      // signed out in another tab, expired or evicted: ask again who is signed in
  return { any: d.account === true || d.device === true, out };
}
export function deleteData() {                              // the confirm card: Cancel is focused
  if (!on) return;
  const a = !!me.account;
  text('acct-confirm-text', `This deletes your stats${a ? ', your username and your sign-in' : ''} from Poddle right away. Our backups are deleted within 5 days.${a ? ' Your old username stays reserved for 90 days so nobody can pretend to be you.' : ''} It can’t be undone.`);
  openCard('acct-confirm'); setTimeout(() => { const n = $('btn-confirm-no'); if (n && !n.closest('[hidden]')) n.focus({ preventScroll: true }); }, 40);
}
async function confirmDelete() {
  const y = $('btn-confirm-yes'); if (y) y.disabled = true;
  const res = await deleteNow(); if (y) y.disabled = false; closeCard();
  h.toast(!res ? 'Couldn’t delete right now. Try again.' : res.out ? 'You’re signed out. Sign in again to delete your account data.' : res.any ? 'Your data is deleted' : 'Nothing was saved to delete', 2600);
  if (res && h.view() === 'profile') showProfile();
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
  click('btn-set-stats', () => h.stats()); click('btn-pf-export', () => exportData()); click('btn-pf-delete', () => deleteData());
  click('btn-pf-next', e => { const lv = +e.currentTarget.dataset.level; if (ORDER.includes(lv)) h.bot(lv); });
  click('tog-save-stats', () => statsToggle()); click('btn-stats-del', () => statsOff(true)); click('btn-stats-keep', () => statsOff(false));
  click('btn-confirm-yes', () => confirmDelete()); click('btn-confirm-no', () => closeCard()); click('btn-signin-close', () => closeCard());
  click('btn-claim-skip', () => closeCard());
  const age = $('signin-age'); if (age) age.addEventListener('change', () => ageTicked());
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
