// Friends in the browser (docs/SOCIAL.md 6, 8; slice A: friends, requests, search, who is online, the profile card's friend row). One panel, drawn into
// every container it is mounted in: the lobby view 'friends' and the in-game friends card (Settings > Friends). Its DOM is its own, like
// web/profile.js: main.js owns the socket and hands the live snapshots in (snap / off / fresh), and the few ui calls this needs (init).
// No named import from ui.js on purpose: test/menu.mjs stubs ui.js with a fixed list of names. profile.js gives the /api helper, the
// account gate and the profile card (#lbp-card, NOTES 140): a name here opens it (openPlayer) and this draws its friend row (cardRow, profile's h.friend).
// Invites (slice B) hang off the friend rows' .fr-invite slot.
// Every string from the server or the player goes in as textContent. Nothing here logs a name.
import { api, acctGate, acctLost, username, signIn, pickName, closeCard, ready, openPlayer, friendRow as cardRedraw, inLobby } from './profile.js';
import { TOP } from './emblems.js';

const $ = id => document.getElementById(id);
const mk = (tag, cls, t) => { const e = document.createElement(tag); if (cls) e.className = cls; if (t != null) e.textContent = t; return e; };
const text = (el, t) => { if (el && el.textContent !== t) el.textContent = t; };
const btn = (cls, t, fn) => { const b = mk('button', cls, t); b.type = 'button'; if (fn) b.addEventListener('click', fn); return b; };
const low = n => String(n).toLowerCase();      // usernames are unique ignoring case on the server (usernames.skeleton): so is every match here
// the presence words (docs/SOCIAL.md 4), and how engaged each is: the list is online first, the busiest on top (the server's own order, kept if a push arrives unsorted)
const ST = { off: 'Offline', menu: 'Online', matt: 'Playing Matt', playing: 'In a game', watching: 'Watching', tour: 'In a tournament' };
const WEIGHT = { tour: 6, playing: 5, matt: 4, watching: 3, menu: 1, off: 0 };
const BUSY = new Set(['matt', 'playing', 'tour']);      // in a match: the dot goes amber (slice B's invites read the same set)
const Q_OK = /^[A-Za-z0-9_]*$/;      // what a username is made of (7.1): anything else can match nobody, so it is never sent

// ---------- the wire, untrusted (docs/SOCIAL.md 8): the same shape from GET /api/friends, a POST's snap and a {type:'social'} push ----------
const nameOf = v => (typeof v === 'string' && v ? v.slice(0, 12) : '');
const rankOf = r => r && typeof r === 'object' && Number.isInteger(r.tier) && r.tier >= 1 && r.tier <= TOP ? { tier: r.tier, div: r.tier === TOP ? 1 : r.div === 2 || r.div === 3 ? r.div : 1 } : null;
const when = v => (Number.isFinite(v) && v > 0 ? v : 0);
function snapOf(j) {                                        // -> { friends, inc, out } or null when it is not one
  if (!j || typeof j !== 'object' || !Array.isArray(j.friends)) return null;
  const friends = j.friends.map(f => f && typeof f === 'object' ? { name: nameOf(f.name), st: ST[f.st] ? f.st : 'off', rank: rankOf(f.rank) } : null).filter(f => f && f.name);
  const inc = (Array.isArray(j.inc) ? j.inc : []).map(x => x && typeof x === 'object' ? { name: nameOf(x.name), at: when(x.at) } : null).filter(x => x && x.name);
  const out = (Array.isArray(j.out) ? j.out : []).map(x => typeof x === 'string' ? { name: nameOf(x), at: 0 } : x && typeof x === 'object' ? { name: nameOf(x.name), at: when(x.at) } : null).filter(x => x && x.name);      // 5 says names, 8 says {name, at}: both read
  friends.sort((a, b) => (WEIGHT[b.st] - WEIGHT[a.st]) || (low(a.name) < low(b.name) ? -1 : low(a.name) > low(b.name) ? 1 : 0));
  return { friends, inc, out };
}

// ---------- state: one list per tab, whoever it belongs to (who). known: every incoming name already seen, so only a NEW one toasts ----------
let h = {}, on = false, snap = null, who = null, loadGen = 0, snapGen = 0, quiet = true, seats = [], early = null;      // early: a socket's snapshot that came before /api/me said who is signed in. snapGen: lists applied so far (a GET older than one drops)
const known = new Set(), seen = new Set(), busy = new Set(), rels = new Map(), panels = []; let tallies = [];      // tallies: the result card's friend slots (NOTES 226)      // rels: what the server last said a name is to me (a POST's rel), for the profile card until the lists hold the name. seen: every name the lists have held, so a name that LEFT them (removed me, withdrew) reads as none, not as the server's older answer
const gate = () => acctGate();      // '' = friends work; 'signin' | 'username' = the step that is missing; 'off' = no accounts here (sign-in or the database is off); 'wait' = /api/me has not answered yet
const me = () => low(username());
const relOf = name => { const n = low(name); if (n === me()) return 'self'; if (!snap) return 'none';
  return snap.friends.some(f => low(f.name) === n) ? 'friend' : snap.inc.some(x => low(x.name) === n) ? 'in' : snap.out.some(x => low(x.name) === n) ? 'out' : 'none'; };
const relNow = (name, said) => { const r = relOf(name); return r !== 'none' || seen.has(low(name)) ? r : said; };      // the lists know best once they have held the name; the server's own answer (search, the profile card) until then: a silent decline stays Requested
const online = () => (snap ? snap.friends.filter(f => f.st !== 'off').length : 0);

function setSnap(s, silent) {                               // a fresh list: new incoming names toast unless this is the first one of a socket (or a REST answer)
  const fresh = s.inc.filter(x => !known.has(low(x.name)));
  for (const x of s.inc) known.add(low(x.name));
  for (const x of [...s.friends, ...s.inc, ...s.out]) seen.add(low(x.name));
  snap = s; snapGen++;
  if (!silent && fresh.length && gate() === '') h.toast(fresh.length === 1 ? `${fresh[0].name} sent you a friend request` : `${fresh[0].name} and ${fresh.length - 1} more sent you friend requests`, 3200);
  redraw();
}
export function snapIn(m) { const s = snapOf(m); if (!s) return; const q = quiet; quiet = false; if (!who) { early = s; return; } setSnap(s, q); }      // {type:'social'} (docs/SOCIAL.md 8): the first after a socket opens is the state, not news. Before /api/me answers it waits for acct()
export function fresh() { quiet = true; early = null; if (who) h.send({ type: 'socialget' }); }      // main.js: the game socket (re)opened. Whatever changed while it was down is on the lists, never a burst of toasts. socialget: the server's first snapshot otherwise waits for a hello, which a tab with no device id never sends
export function off() { snap = null; early = null; quiet = true; known.clear(); seen.clear(); for (const p of panels) p.rows = null; redraw(); }      // {type:'socialoff'}: the socket lost its account (sign-out, delete). Whoever signs in next starts quiet
async function load() {                                     // GET /api/friends: the view or the card opened, or a new account. The socket's snapshot needs a hello first, and a lobby-only visit may never send one
  if (!on || gate()) return; const g = ++loadGen, s0 = snapGen;
  let r; try { r = await api('/api/friends'); } catch { r = { ok: false, status: 0, j: null }; }
  if (g !== loadGen || s0 !== snapGen) return;      // a newer answer (another GET, a POST's snap, a push) landed first: this one may be older than what is drawn
  if (r.ok) { const s = snapOf(r.j); if (s) setSnap(s, true); return; }
  if (lost(r)) acctLost();      // the session (or the name) may have gone since /api/me: profile.js asks /api/me again and follows, then acct() here
}
const lost = r => (r.status === 401 && r.j?.error === 'signin') || (r.status === 403 && r.j?.error === 'username');      // only these two say the account went: a 403 origin, or a busy database, is just a failed call
// profile.js drew the account (a sign-in, a sign-out, a new username, /api/me answering): a different player's lists are not these
export function acct() {
  const u = username() || null;
  if (u === who) { redraw(); return; }      // the same player, but the gate may have moved (/api/me answering 'off' -> 'username')
  who = u; snap = null; known.clear(); seen.clear(); busy.clear(); rels.clear(); loadGen++; for (const p of panels) { p.rows = null; p.q = ''; if (p.els) p.els.q.value = ''; }
  const e = early; early = null;
  if (u && e) setSnap(e, true); else if (u) { load(); h.send({ type: 'socialget' }); }      // its lists at once (the socket's, or GET): the home tile's badge and line need them before any view opens. The socket's own first snapshot too, so the next push is news
  redraw();
}

// ---------- errors: a short toast. 401 / 403 bring the gate back (the session or the username went since /api/me): profile.js drops it, the page follows ----------
const ERR = { full: 'One of you already has 100 friends', limit: 'You have 20 requests waiting. Cancel one first', self: 'That’s you', notfound: 'No player with that username', norequest: 'That request isn’t there any more', rate: 'Too many tries. Wait a minute, then try again', q: 'Usernames are 2 to 12 letters, numbers or _' };
function fail(r) {
  const e = r.j && typeof r.j.error === 'string' ? r.j.error : '';
  if (lost(r)) { acctLost().then(gone => h.toast(gone === 'signin' ? 'You’re signed out. Sign in again to add friends' : gone === 'username' ? 'Pick a username to add friends' : 'Couldn’t do that. Try again.', 2800)); return; }      // said only once /api/me agrees
  h.toast(ERR[e] || (r.status === 429 ? ERR.rate : r.status === 0 || r.status >= 500 ? 'Couldn’t reach Poddle. Try again.' : 'Couldn’t do that. Try again.'), 2800);
  if (e === 'norequest' || e === 'notfound') load();      // the lists were stale: fetch them again
}
const DONE = { add: n => r => (r === 'friends' ? `You and ${n} are friends` : `Request sent to ${n}`), accept: n => () => `You and ${n} are friends`, remove: n => () => `${n} was removed` };      // decline and cancel say nothing: the row going is the answer
async function act(op, name) {                              // POST /api/friends { op, name } -> { r, rel, snap }
  const k = low(name); if (busy.has(k) || gate()) return; busy.add(k); redraw();
  let r; try { r = await api('/api/friends', 'POST', { op, name }); } catch { r = { ok: false, status: 0, j: null }; }
  busy.delete(k);
  if (r.ok && r.j) { const s = snapOf(r.j.snap); if (s) setSnap(s, true);
    const rel = ['none', 'friend', 'out', 'in'].includes(r.j.rel) ? r.j.rel : null; if (rel) { rels.set(k, rel); for (const p of panels) for (const x of p.rows || []) if (low(x.name) === k) x.rel = rel; }      // the search rows and the profile card keep what the server said
    if (DONE[op]) h.toast(DONE[op](name)(r.j.r), 2200); }
  else fail(r);
  redraw();
}

// ---------- the rows ----------
const ago = at => { if (!at) return ''; const s = Math.max(0, (Date.now() - at) / 1000); return s < 90 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };
function whoEl(name, ctx, rank, sub) {                     // the name (a button: the profile card), the developer badge, the rank emblem, a small line under it
  const w = mk('span', 'fr-who'), top = mk('span', 'fr-top'), b = btn('fr-name', name, e => player(name, ctx, rank, e.currentTarget));
  b.setAttribute('aria-label', `${name}: open profile`); b.setAttribute('aria-haspopup', 'dialog'); top.append(b); w.append(top);
  h.badge(b, true); if (rank) h.rankBadge(b, rank);      // the hammer beside the developer’s name, the rank emblem beside everyone’s who has one (ui.js draws both)
  if (sub) w.append(sub); return w;
}
function relActs(name, rel) {                              // what can be done about this name now: one control, never a destructive one
  const k = low(name), wait = busy.has(k), a = [];
  if (rel === 'none') a.push(addIc(btn('btn btn-sm fr-act is-add fr-add', 'Add friend', () => act('add', name))));
  else if (rel === 'in') a.push(btn('btn btn-sm fr-act is-add', 'Accept', () => act('accept', name)));
  else if (rel === 'out') a.push(mk('span', 'fr-tag', 'Requested'));
  else if (rel === 'friend') { const t = mk('span', 'fr-tag is-friend', 'Friends'); t.prepend(tick()); a.push(t); }
  else if (rel === 'self') a.push(mk('span', 'fr-tag', 'You'));
  for (const x of a) if (x.tagName === 'BUTTON') x.disabled = wait;
  return a;
}
const addIc = b => { const i = mk('i', 'fr-add-ic'); i.setAttribute('aria-hidden', 'true'); i.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.6"/><path d="M2.5 20c.6-4.2 3.1-6.3 6.5-6.3s5.9 2.1 6.5 6.3Z"/><path class="fr-add-plus" d="M19 7v6M16 10h6"/></svg>'; b.prepend(i); return b; };      // Add friend's person-plus (NOTES 150): it waves, the + pops (ui.css .fr-add)
const tick = () => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true'); s.innerHTML = '<path d="m5 12.5 4.5 4.5L19 7.5"/>'; return s; };
const dots = () => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true'); s.innerHTML = '<circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/>'; return s; };
function row(cls, name, kids, acts) { const li = mk('li', 'fr-row ' + cls); li.dataset.name = name; li.append(...kids, mk('span', 'fr-acts')); li.lastChild.append(...acts); return li; }
function friendRow(f, ctx, p) {                             // a dot, the name with its status, the (slice B) invite slot and the ... menu. Remove is behind a confirm, never one click
  const k = low(f.name), sure = p.confirm === k, st = mk('small', 'fr-st', ST[f.st]), dot = mk('i', 'fr-dot' + (f.st === 'off' ? '' : BUSY.has(f.st) ? ' is-busy' : ' is-on'));
  dot.setAttribute('aria-hidden', 'true');
  const acts = [];
  if (sure) { const yes = btn('btn btn-sm btn-danger fr-act', 'Remove', () => { p.confirm = ''; act('remove', f.name); }), no = btn('btn btn-sm btn-quiet fr-act', 'Keep', () => { p.confirm = ''; draw(p); focusRow(p, k, '.fr-more'); });
    yes.disabled = busy.has(k); acts.push(mk('span', 'fr-ask', `Remove ${f.name}?`), yes, no); }
  else { const more = btn('btn btn-icon fr-more', '', () => { p.confirm = k; draw(p); focusRow(p, k, '.btn-quiet'); }); more.append(dots()); more.setAttribute('aria-label', `More for ${f.name}`); more.dataset.tip = 'More';      // data-tip, never title: ui.js turns a title into data-tip on the live node, so a fresh row would never equal it (fill) and every push would swap it
    acts.push(mk('span', 'fr-invite'), more); }      // .fr-invite: slice B's Play / Duel / Watch go here
  const li = row('is-friend' + (f.st === 'off' ? ' is-off' : '') + (sure ? ' is-confirm' : ''), f.name, [dot, whoEl(f.name, ctx, f.rank, st)], acts); li.dataset.st = f.st; return li;
}
const focusRow = (p, k, sel) => { const li = [...p.root.querySelectorAll('.fr-row')].find(x => low(x.dataset.name) === k); const b = li && li.querySelector(sel); if (b) b.focus({ preventScroll: true }); };
function incRow(x, ctx) {
  const k = low(x.name), yes = btn('btn btn-sm fr-act is-add', 'Accept', () => act('accept', x.name)), no = btn('btn btn-sm btn-quiet fr-act', 'Decline', () => act('decline', x.name));
  yes.disabled = no.disabled = busy.has(k);
  return row('is-inc', x.name, [whoEl(x.name, ctx, null, mk('small', 'fr-st', ago(x.at) ? `Wants to be friends · ${ago(x.at)}` : 'Wants to be friends'))], [yes, no]);
}
function outRow(x, ctx) {
  const c = btn('btn btn-sm btn-quiet fr-act', 'Cancel', () => act('cancel', x.name)); c.disabled = busy.has(low(x.name)); c.setAttribute('aria-label', `Cancel the request to ${x.name}`);
  return row('is-out', x.name, [whoEl(x.name, ctx, null, mk('small', 'fr-st', ago(x.at) ? `Requested ${ago(x.at)}` : 'Requested'))], [c]);
}
const resultRow = (x, ctx) => row('is-result', x.name, [whoEl(x.name, ctx, null, null)], relActs(x.name, relNow(x.name, x.rel)));

// ---------- a panel: mount() builds it once into a container, draw() fills it from the state ----------
const SEARCH_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/></svg>', X_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
function sec(cls, title) { const s = mk('section', 'fr-sec ' + cls), hd = mk('h3', 'fr-label'), t = mk('span', '', title); hd.append(t, mk('b', 'fr-count'), mk('small', 'fr-more-n')); s.append(hd, mk('ul', 'fr-list')); s.hidden = true; return s; }
export function mount(root, ctx) {                          // ctx: 'lobby' (the view: the gate has its button) | 'game' (the card: the gate is words only, a sign-in mid-match redials = a forfeit)
  if (!root) return null; root.textContent = ''; root.classList.add('fr-panel');
  const p = { root, ctx, q: '', rows: null, gen: 0, t: 0, confirm: '', els: {} }, E = p.els;
  E.gate = mk('div', 'fr-gate'); E.gateT = mk('p', 'fr-gate-t'); E.gateS = mk('p', 'fr-gate-s'); E.gateB = btn('btn btn-sm is-tall fr-gate-b', '', () => { const g = gate(); if (g === 'signin') signIn(); else if (g === 'username') pickName(); });
  E.gate.append(E.gateT, E.gateS, E.gateB);
  E.search = mk('label', 'fr-search'); E.search.innerHTML = SEARCH_SVG;
  E.q = mk('input', 'field fr-q'); Object.assign(E.q, { type: 'text', maxLength: 12, placeholder: 'Search usernames', autocomplete: 'off', spellcheck: false, enterKeyHint: 'search' }); E.q.setAttribute('autocapitalize', 'off'); E.q.setAttribute('autocorrect', 'off'); E.q.setAttribute('aria-label', 'Search usernames');
  E.x = btn('fr-clear', '', () => { setQuery(p, ''); E.q.focus({ preventScroll: true }); }); E.x.innerHTML = X_SVG; E.x.setAttribute('aria-label', 'Clear search'); E.x.hidden = true;
  E.search.append(E.q, E.x);
  E.hint = mk('p', 'fr-hint'); E.hint.setAttribute('role', 'status');
  E.res = mk('ul', 'fr-list fr-results'); E.res.setAttribute('aria-label', 'Search results');
  E.scroll = mk('div', 'fr-scroll');
  E.court = sec('fr-court', 'On this court'); E.inc = sec('fr-inc', 'Requests'); E.fr = sec('fr-friends', 'Friends'); E.out = sec('fr-out', 'Sent');
  E.empty = mk('div', 'fr-empty'); E.empty.append(mk('b', '', 'No friends yet'), mk('span', '', 'Search for a username above to add someone. Friends see when you’re online.'));
  E.fr.append(E.empty);
  E.scroll.append(E.hint, E.res, E.court, E.inc, E.fr, E.out);
  root.append(E.gate, E.search, E.scroll);
  E.q.addEventListener('input', () => setQuery(p, E.q.value));
  E.q.addEventListener('keydown', e => {
    if (e.key === 'Escape' && E.q.value) { e.preventDefault(); e.stopPropagation(); setQuery(p, ''); }      // a query is cleared before Esc closes the card or goes Back (main.js never hears it)
    else if (e.key === 'ArrowDown' || e.key === 'Enter') { const f = E.scroll.querySelector('button:not(:disabled)'); if (f) { e.preventDefault(); e.stopPropagation(); f.focus({ preventScroll: true }); } } });
  root.addEventListener('keydown', e => { if (e.key === 'Escape' && p.confirm) { e.preventDefault(); e.stopPropagation(); const k = p.confirm; p.confirm = ''; draw(p); focusRow(p, k, '.fr-more'); } });      // Esc on a Remove? confirm is Keep
  panels.push(p); draw(p); return p;
}
function setQuery(p, v) {                                   // typed: 250 ms after the last key, 2 letters or more, only what a username can hold. A slower older answer is dropped (gen)
  const q = String(v || '').trim(); if (!v) p.els.q.value = ''; p.q = q; p.gen++; clearTimeout(p.t); p.confirm = '';
  p.rows = null;
  if (q.length >= 2 && Q_OK.test(q) && !gate()) { p.rows = 'wait'; const g = p.gen; p.t = setTimeout(() => search(p, g), 250); }
  draw(p);
}
async function search(p, g) {
  let r; try { r = await api('/api/friends/search?q=' + encodeURIComponent(p.q)); } catch { r = { ok: false, status: 0, j: null }; }
  if (g !== p.gen) return;      // typed on meanwhile: this answer is for an older query
  if (r.ok && r.j && Array.isArray(r.j.rows)) p.rows = r.j.rows.map(x => x && typeof x === 'object' ? { name: nameOf(x.name), rel: ['none', 'friend', 'out', 'in'].includes(x.rel) ? x.rel : 'none' } : null).filter(x => x && x.name && low(x.name) !== me()).slice(0, 20);
  else { p.rows = 'err'; if (r.status === 401 || r.status === 403 || r.status === 429) fail(r); }
  draw(p);
}
// a row that would be drawn exactly as it is (isEqualNode: text, classes, disabled) stays the same node: a push every 2 s never swaps the button under a
// press (a click needs the node it went down on) or under the keyboard's focus. Only what changed is moved, added or dropped
function fill(ul, items) {
  const old = new Map(); for (const c of ul.children) old.set(c.className + '\n' + c.dataset.name, c);
  const next = items.map(n => { const o = old.get(n.className + '\n' + n.dataset.name); return o && o.isEqualNode(n) ? o : n; });
  next.forEach((n, i) => { if (ul.children[i] !== n) ul.insertBefore(n, ul.children[i] || null); });
  while (ul.children.length > next.length) ul.lastElementChild.remove();
}
function draw(p) {
  const E = p.els, g = gate(), game = p.ctx === 'game';
  E.gate.hidden = !g; E.search.hidden = E.scroll.hidden = !!g;
  if (g) {                                                  // the missing step, said once. In a court only words: signing in or naming yourself there redials (a forfeit, index.html's Settings note)
    text(E.gateT, g === 'wait' ? 'Loading' : g === 'off' ? 'Friends aren’t available right now' : game ? (g === 'signin' ? 'Sign in from the menu to add friends' : 'Pick a username from the menu to add friends') : g === 'signin' ? 'Sign in to add friends' : 'Pick a username to add friends');
    text(E.gateS, g === 'off' || g === 'wait' ? '' : g === 'signin' ? 'Find players by their username and see when your friends are online.' : 'Friends find you by your username. Other players already see it on court.');
    E.gateT.classList.toggle('is-wait', g === 'wait'); E.gateS.hidden = !E.gateS.textContent; E.gateB.hidden = game || g === 'off' || g === 'wait'; text(E.gateB, g === 'signin' ? 'Sign in' : 'Pick a username'); return; }
  const q = p.q, searching = q.length > 0;
  E.x.hidden = !E.q.value;
  // search mode: the results (or why there are none) in place of the lists
  const bad = searching && !Q_OK.test(q), rows = Array.isArray(p.rows) ? p.rows : null;
  text(E.hint, !searching ? '' : bad ? 'Usernames only have letters, numbers and _' : q.length < 2 ? 'Type at least 2 letters' : p.rows === 'wait' && !rows ? 'Searching' : p.rows === 'err' ? 'Couldn’t search right now. Try again.' : rows && !rows.length ? `No usernames start with “${q}”` : '');
  E.hint.hidden = !E.hint.textContent; E.hint.classList.toggle('is-wait', p.rows === 'wait');
  E.res.hidden = !rows || !rows.length || !searching; fill(E.res, E.res.hidden ? [] : rows.map(x => resultRow(x, p.ctx)));
  const S = snap || { friends: [], inc: [], out: [] };
  // On this court (the card only): the registered seats, never spectators, never me
  const court = game ? seats.filter(s => low(s.name) !== me()) : [];
  E.court.hidden = searching || !court.length; fill(E.court.lastChild, court.map(s => row('is-court', s.name, [whoEl(s.name, p.ctx, s.rank, null)], relActs(s.name, relNow(s.name, 'none')))));
  E.inc.hidden = searching || !S.inc.length; text(E.inc.querySelector('.fr-count'), S.inc.length ? String(S.inc.length) : ''); fill(E.inc.lastChild, S.inc.map(x => incRow(x, p.ctx)));
  E.fr.hidden = searching; const n = online();
  text(E.fr.querySelector('.fr-more-n'), !snap ? '' : S.friends.length ? (n ? `${n} online` : 'Nobody online') : '');
  E.fr.querySelector('.fr-list').hidden = !S.friends.length; E.empty.hidden = !!S.friends.length || !snap;
  fill(E.fr.querySelector('.fr-list'), S.friends.map(f => friendRow(f, p.ctx, p)));
  E.out.hidden = searching || !S.out.length; fill(E.out.lastChild, S.out.map(x => outRow(x, p.ctx)));
}
// every panel, the home tile, the Settings row and an open profile card: one state, drawn everywhere it shows
function redraw() {
  const a = document.activeElement, p0 = a && panels.find(p => p.root.contains(a)), keep = p0 && a.closest('.fr-row') ? [low(a.closest('.fr-row').dataset.name), a.classList.contains('fr-more') ? '.fr-more' : a.classList.contains('fr-name') ? '.fr-name' : 'button:not(:disabled)'] : null;
  for (const p of panels) draw(p); entry(); cardRedraw(); drawTallies();      // an open profile card's friend row follows too (its buttons wait while a request is out)
  if (keep && !p0.root.contains(document.activeElement)) { focusRow(p0, keep[0], keep[1]); if (!p0.root.contains(document.activeElement)) (p0.els.q.offsetParent ? p0.els.q : p0.root.closest('[tabindex]') || p0.root).focus({ preventScroll: true }); }      // a redraw rebuilt the row under the player's focus: the same control on the new row, else the search
}
// the home tile (index.html #btn-friends) and Settings > Friends: requests as a badge, who is online as the line
function entry() {
  const g = gate(), n = online(), inc = snap ? snap.inc.length : 0, badge = $('friends-n'), dot = $('friends-dot');      // 'wait' (a reload, /api/me not back yet): blank, never 'not available'
  text($('friends-line-text'), g === 'signin' ? 'Sign in to add friends' : g === 'username' ? 'Pick a username first' : g ? '' : !snap ? 'See who’s online' : !snap.friends.length ? 'Add your first friend' : n ? `${n} online` : 'Nobody online');
  if (dot) { dot.hidden = !!g || !n; dot.className = 'fr-dot is-on'; }
  if (badge) { const t = inc ? `${inc} request${inc === 1 ? '' : 's'}` : '', was = badge.textContent; if (t) text(badge, t); badge.classList.toggle('is-off', !t); if (t && was && was !== t) { badge.classList.remove('pop'); void badge.offsetWidth; badge.classList.add('pop'); } }
  const grp = $('grp-social'); if (grp) grp.hidden = !on || g === 'off';
  { const b = $('set-friends-n'); if (b) { b.hidden = !inc; text(b, String(inc)); b.setAttribute('aria-label', `${inc} friend request${inc === 1 ? '' : 's'}`); } }
  text($('set-friends-sub'), g || !snap || !snap.friends.length ? '' : n ? `${n} online` : '');
}

// ---------- the lobby view and the in-game card ----------
export async function showView() {                          // the view 'friends' opened (a reload on /friends too: /api/me may not have answered yet)
  const v = $('lobby-friends'); if (v && !panels.some(p => p.root === v)) mount(v, 'lobby');
  redraw(); await ready(); acct(); if (!gate()) load();
}
export function card(open) {                                // the friends card opened (or closed): its panel is built the first time, the lists fetched fresh
  const b = $('fc-body'); if (b && !panels.some(p => p.root === b)) mount(b, 'game');
  const p = panels.find(x => x.root === b); if (!open) { if (p) { setQuery(p, ''); p.confirm = ''; } return; }
  redraw(); if (!gate()) load();
}
export function court(list) {                               // main.js: who sits on this court now ([{ name, rank }] of the registered seats that are not mine). [] off the court
  seats = (Array.isArray(list) ? list : []).map(s => s && typeof s === 'object' ? { name: nameOf(s.name), rank: rankOf(s.rank) } : null).filter(s => s && s.name);
  for (const p of panels) if (p.ctx === 'game') draw(p);
}

// ---------- the result card (NOTES 226, the owner: "make it so you can add friends after a game"): under a registered player's name in the tally,
// the same one control the profile card has (Add friend / Requested / Accept / Friends), live with the lists. Only for a signed-in player with a
// username (a guest gets nothing: signing in from a court would redial). main.js result(): [{ el, name }] of the tally slots to fill, [] to empty them (tallies)
export function result(list) {
  for (const t of tallies) { t.el.textContent = ''; t.el.hidden = true; delete t.el.dataset.sig; }
  tallies = (Array.isArray(list) ? list : []).map(x => x && x.el ? { el: x.el, name: nameOf(x.name) } : null).filter(x => x && x.name);
  drawTallies(); if (tallies.length && on && !gate() && !snap) load();      // the lists, if this tab has none yet: Requested or Friends must not show as Add friend
}
function drawTallies() {
  const g = gate();
  for (const t of tallies) {
    const k = low(t.name), rel = !on || g ? '' : relNow(t.name, rels.get(k) || 'none'), wait = busy.has(k), sig = rel + '|' + wait;
    t.el.hidden = !rel || rel === 'self'; if (t.el.dataset.sig === sig) continue;
    const had = t.el.contains(document.activeElement); t.el.dataset.sig = sig; t.el.textContent = ''; if (t.el.hidden) continue;
    const B = (cls, txt, fn) => { const x = btn('btn btn-sm ' + cls, txt, fn); x.disabled = wait; return x; };
    if (rel === 'none') { const x = addIc(B('fr-add tally-fr-btn', 'Add friend', () => act('add', t.name))); x.setAttribute('aria-label', `Add ${t.name} as a friend`); t.el.append(x); }
    else if (rel === 'in') { const x = B('is-add tally-fr-btn', 'Accept', () => act('accept', t.name)); x.setAttribute('aria-label', `Accept ${t.name}'s friend request`); t.el.append(x); }
    else if (rel === 'out') t.el.append(mk('span', 'fr-tag', 'Requested'));
    else if (rel === 'friend') { const x = mk('span', 'fr-tag is-friend', 'Friends'); x.prepend(tick()); t.el.append(x); }
    if (had && !t.el.contains(document.activeElement)) t.el.closest('[tabindex]')?.focus({ preventScroll: true });
  }
}

// ---------- the profile card (#lbp-card, web/profile.js): a name opens it; its friend row is drawn here, from the lists (the pushes keep it live) ----------
function player(name, ctx, rank, from) {
  name = nameOf(name); if (!name || !on) return;
  const p0 = from && panels.find(p => p.root.contains(from)), k = low(name);
  openPlayer(name, { from, rank, via: ctx === 'game' ? 'court' : 'friends', back: () => {      // Close gives the focus back to this name's row, or the search, when a redraw replaced the button it came from
    if (!p0 || !p0.root.offsetParent) return null; const li = [...p0.root.querySelectorAll('.fr-row')].find(x => low(x.dataset.name) === k);
    return (li && li.querySelector('.fr-name')) || (p0.els.q.offsetParent ? p0.els.q : null); } });
}
let sure = '', sureGen = 0;      // sure: the name whose Remove is asking Are you sure on the card; sureGen: the card opening it belongs to
// cardRow(box, { name, rel, st }): profile.js calls it for every draw of a loaded card that is not mine. rel / st: /api/player's answer (undefined for a guest
// or when it failed). The row is rebuilt only when what it shows changes (sig): a push every 2 s never swaps a button under a press or the keyboard's focus
export function cardRow(box, info) {
  if (!box || !info || !info.name) return; const name = nameOf(info.name), k = low(name), g = gate(), lobby = inLobby();
  if (info.gen !== sureGen) { sureGen = info.gen; sure = ''; }      // a new opening, or another player's card: never open on a confirm
  const said = rels.has(k) ? rels.get(k) : ['none', 'friend', 'out', 'in'].includes(info.rel) ? info.rel : 'none', rel = g ? '' : relNow(name, said), wait = busy.has(k);
  const fr = rel === 'friend' && snap ? snap.friends.find(f => low(f.name) === k) : null, st = rel !== 'friend' ? null : fr ? fr.st : ST[info.st] ? info.st : null;      // a friend's status follows the pushes; nobody else's is ever shown
  const sig = [name, g, lobby, rel, st, wait, sure === k].join('\n');
  box.hidden = g === 'off' || g === 'wait'; if (box.hidden) { box.textContent = ''; delete box.dataset.sig; const e = document.getElementById('lbp-st'); if (e) { e.textContent = ''; e.hidden = true; } return; }
  if (box.dataset.sig === sig) return;
  const had = box.contains(document.activeElement); box.dataset.sig = sig; box.textContent = ''; box.className = 'lbp-friend' + (rel ? ' is-' + rel : ' is-gate') + (sure === k ? ' is-confirm' : '');
  // NOTES 166: the friend control sits in the card's header, left of Close: one compact button a state (two for an incoming request and for the Remove confirm).
  // What a state has to say (a friend's live status, 'Wants to be friends', 'Remove Bea?') is the line under the name, #lbp-st
  const acts = mk('div', 'lbp-fr-acts'), B = (cls, t, fn) => { const b = btn('btn btn-sm is-tall ' + cls, t, fn); b.disabled = wait; return b; }, stEl = document.getElementById('lbp-st');
  const say = (t, dot) => { if (!stEl) return; stEl.textContent = t || ''; if (t && dot) stEl.prepend(dot); stEl.hidden = !t; };
  say('');
  if (g) {      // a guest, or no username yet. A button only in the lobby: signing in or naming yourself mid-match redials (a forfeit)
    const t = g === 'signin' ? 'Sign in to add friends' : 'Pick a username to add friends';
    if (lobby) { const b = addIc(btn('btn btn-sm is-tall lbp-fr-add fr-add lbp-fr-go', 'Add friend', () => { closeCard(); if (gate() === 'signin') signIn(); else if (gate() === 'username') pickName(); })); b.setAttribute('aria-label', t); b.title = t; acts.append(b); }
    else say(t);
  } else if (sure === k) {
    say(`Remove ${name}?`);
    acts.append(B('btn-danger', 'Remove', () => { sure = ''; act('remove', name); }), B('btn-quiet', 'Keep', () => { sure = ''; cardRedraw(); box.querySelector('.lbp-fr-rm')?.focus({ preventScroll: true }); }));
  } else if (rel === 'friend') {
    if (st) { const dot = mk('i', 'fr-dot' + (st === 'off' ? '' : BUSY.has(st) ? ' is-busy' : ' is-on')); dot.setAttribute('aria-hidden', 'true'); say(ST[st], dot); }
    const rm = B('btn-quiet lbp-fr-rm lbp-fr-tag', 'Friends', () => { sure = k; cardRedraw(); box.querySelector('.btn-quiet')?.focus({ preventScroll: true }); }); rm.prepend(tick()); rm.setAttribute('aria-label', `Friends with ${name}. Remove`); rm.title = 'Remove friend'; acts.append(rm);      // Remove asks first (Keep has focus)
  } else if (rel === 'out') {      // a decline is silent: it stays Requested until it expires. Pressing it takes the request back
    const c = B('btn-quiet lbp-fr-out', 'Requested', () => act('cancel', name)); c.setAttribute('aria-label', `Requested. Cancel the request to ${name}`); c.title = 'Cancel request'; acts.append(c);
  } else if (rel === 'in') {
    say('Wants to be friends');
    const no = B('btn-quiet btn-icon lbp-fr-no', '', () => act('decline', name)); no.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>'; no.setAttribute('aria-label', 'Decline'); no.title = 'Decline';
    acts.append(B('lbp-fr-add', 'Accept', () => act('accept', name)), no);
  } else acts.append(addIc(B('lbp-fr-add fr-add', 'Add friend', () => act('add', name))));
  box.append(acts);
  if (had && !box.contains(document.activeElement)) (box.querySelector('button:not(:disabled)') || box.closest('[tabindex]'))?.focus({ preventScroll: true });      // rebuilt under the focus (a request went out): it stays in the card, where its Tab trap and Esc work
}

// ---------- wiring: main.js calls init() once, while it loads ----------
// hooks: { on, send(m), toast(text, ms), badge(el, on), rankBadge(el, r) }. on: the account features can be here (hosted, or ?acctest=1). Off, nothing is fetched or shown
export function init(hooks) {
  const noop = () => {};
  h = { send: noop, toast: noop, badge: noop, rankBadge: noop };
  for (const k of Object.keys(h)) if (hooks && typeof hooks[k] === 'function') h[k] = hooks[k];
  on = !!(hooks && hooks.on === true);
  entry();
}
