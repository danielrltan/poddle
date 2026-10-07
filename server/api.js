// The /api/* routes (docs/ACCOUNTS.md 8): profile read, export and delete for guests (device id in the JSON body) and accounts (session
// cookie), and Google sign-in, sign-out, usernames and friends (docs/SOCIAL.md 8; only when GOOGLE_CLIENT_ID is set; otherwise those answer 404 signin_off).
// game.js routes every /api/ request here first thing. Nothing runs on require: init() once at boot.
// Rules (8.1): every POST/DELETE needs an allowed Origin (403) and Content-Type application/json (415), which forces a CORS preflight that
// this server never answers (no Access-Control-* header anywhere). Bodies: 8 KB, 5 s, a JSON object, fields read one by one with type
// checks and never spread or merged. Rate limits per computer node (a keyed hash, never the address). Logs: one fixed line per failure
// class an hour at most, never an identity, a body, a token or an address. handle() never throws or rejects: a throw answers 500.
// Public, no sign-in: GET /api/leaderboard (NOTES 126), GET /api/leaderboard/player?u=<name> (a listed player's profile card, NOTES 140) and GET /api/player?name=
// (the same card's rank, places and friend row, docs/SOCIAL.md 8: rank + places only when not hidden or to a friend, st only to a friend).
const crypto = require('node:crypto');
const auth = require('./auth'), db = require('./db'), stats = require('./stats'), abuse = require('./abuse'), share = require('./share'), traffic = require('./traffic');
let names = null; try { names = require('./usernames'); } catch { /* usernames need sign-in, which then answers 503 */ }

const MIN = 60e3, HOUR = 3600e3, DAY = 86400e3, BODY_MAX = 8192, BODY_MS = 5000;
const OLD_HOSTS = new Set(['poddle.fly.dev', 'www.poddleball.com']);   // the cookie is scoped to poddleball.com: never a redirect here (8.1)
let statsKey = '', verifier = null, clientId = null, limiter = null, salt = crypto.randomBytes(32), saltAt = Date.now(), hosted = false, renameDays = 30;
const logged = new Map();                                        // failure class -> last log time
const NONCE_MS = 600e3, NONCES_MAX = 50000;                      // the nonce cookie's Max-Age (auth.nonceCookie); a bound on the map
const nonces = new Map();                                        // SHA-256 of each nonce this process issued -> expiry, memory only. Single use: a sign-in takes it out

// init({ env, social }) -> sign-in on when GOOGLE_CLIENT_ID is set (the client id is public; it only ever comes from the environment).
// social (game.js, docs/SOCIAL.md 4): { status: accountId -> 'off'|'menu'|..., changed: (push ids, invalidate ids) }: the presence it keeps in memory,
// and the hook that drops its friend-list caches and pushes fresh 'social' snapshots. Without it (the in-process tests) everyone is 'off' and nothing is pushed
function init({ env = process.env, social: so = null } = {}) {
  hosted = !!env.FLY_APP_NAME; statsKey = String(env.STATS_KEY || '').trim();
  verifier = auth.verifierFromEnv(env);                          // logs 'auth: GOOGLE_JWKS_FILE ignored in production' when it applies
  clientId = verifier ? String(env.GOOGLE_CLIENT_ID).trim() : null;
  limiter = auth.createRateLimiter(); salt = crypto.randomBytes(32); saltAt = Date.now(); nonces.clear(); boardsChanged();
  const r = Math.floor(Number(env.RENAME_DAYS)); renameDays = env.RENAME_DAYS !== undefined && env.RENAME_DAYS !== '' && Number.isFinite(r) ? Math.min(3650, Math.max(0, r)) : 30;
  social = { status: so && typeof so.status === 'function' ? so.status : () => 'off', changed: so && typeof so.changed === 'function' ? so.changed : () => {} };
  const knob = (k, d) => { const v = Math.floor(Number(env[k])); return env[k] !== undefined && env[k] !== '' && Number.isFinite(v) && v >= 1 ? Math.min(100000, v) : d; };
  addsMax = knob('FRIEND_ADDS_HOUR', 30); searchMax = knob('FRIEND_SEARCH_10M', 60); acctHits.clear();   // docs/SOCIAL.md 3: per account, on top of the per-address route limits (test knobs)
}
const signinOn = () => !!verifier;

function say(cls) { const t = Date.now(); if (t - (logged.get(cls) || -Infinity) < HOUR) return; logged.set(cls, t); console.log('api: ' + cls); }
function send(res, status, body, extra = {}) {                  // every answer: JSON, no-store, noindex, same-origin only, a length
  if (res.headersSent || res.writableEnded) return;
  const s = body === undefined ? '' : JSON.stringify(body);
  const head = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Cross-Origin-Resource-Policy': 'same-origin', 'Content-Length': Buffer.byteLength(s), ...extra };
  if (s) head['Content-Type'] = 'application/json; charset=utf-8';
  res.writeHead(status, head); res.end(s || undefined);
}
const fail = (res, status, error, extra, more) => { say(status + ' ' + error); send(res, status, { error, ...more }, extra); };
const own = (b, k) => (Object.prototype.hasOwnProperty.call(b, k) ? b[k] : undefined);   // a parsed body is read field by field, own keys only
// the rate-limit keys: keyed hashes of the computer key (5.4) and of its wider network (IPv4 /24, IPv6 /48, for the flood fallback). The key
// lives in memory only and is replaced every 24 h
const keyed = s => { const t = Date.now(); if (t - saltAt >= DAY) { salt = crypto.randomBytes(32); saltAt = t; } return crypto.createHmac('sha256', salt).update(s).digest().subarray(0, 16).toString('hex'); };
const wideOf = k => /^\d+\.\d+\.\d+\.\d+$/.test(k) ? k.split('.').slice(0, 3).join('.') + '/24' : k.includes(':') ? k.split(':').slice(0, 3).join(':') + '/48' : k;
const nodeKey = addr => keyed(abuse.computerKey(addr)), wideKey = addr => keyed(wideOf(abuse.computerKey(addr)));
const nonceKey = n => crypto.createHash('sha256').update(n).digest('base64');
function nonceIssue(n, t) {                                       // insertion order is expiry order (one TTL): expired or over-cap entries go from the front
  for (const [k, exp] of nonces) { if (exp > t && nonces.size < NONCES_MAX) break; nonces.delete(k); }
  nonces.set(nonceKey(n), t + NONCE_MS);
}
function nonceUse(n, t) { if (typeof n !== 'string' || !n) return false; const k = nonceKey(n), exp = nonces.get(k); nonces.delete(k); return exp != null && exp > t; }

function readBody(req) {                                          // -> the parsed object, or throws { status, error }
  return new Promise((resolve, reject) => {
    let n = 0, done = false; const parts = [];
    const end = (err, v) => { if (done) return; done = true; clearTimeout(timer); req.removeListener('data', onData); err ? reject(err) : resolve(v); };
    const timer = setTimeout(() => end({ status: 408, error: 'timeout' }), BODY_MS);
    const onData = c => { n += c.length; if (n > BODY_MAX) return end({ status: 413, error: 'too_large' }); parts.push(c); };
    req.on('data', onData);
    req.on('end', () => { let v; try { v = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { return end({ status: 400, error: 'bad_request' }); }
      if (!v || typeof v !== 'object' || Array.isArray(v)) return end({ status: 400, error: 'bad_request' }); end(null, v); });
    req.on('aborted', () => end({ status: 0, error: 'aborted' })); req.on('close', () => end({ status: 0, error: 'aborted' }));
  });
}
function session(req) {                                           // the signed-in session named by the cookie, or null
  const raw = auth.readSession(req.headers.cookie); if (!raw) return null;
  const s = db.session.lookup(raw, Date.now()); return s ? { ...s, raw } : null;
}
const account = s => { const a = s && db.accountById(s.accountId); return a ? { username: a.username, renameAt: a.renamed_at == null ? null : a.renamed_at + renameDays * DAY } : null; };
const deviceOf = (b, req) => {                                    // the body's device id, format-checked and hashed; the link map learns it (5.4)
  const h = auth.deviceHash(own(b, 'dev')); if (h) stats.seen({ devHash: h, computer: abuse.computerKey(auth.clientAddr(req).addr), cid: null });
  return h;
};

// ---- the routes (8.2) ----
async function me(req, res) {
  const s = db.isOpen() ? session(req) : null;                   // a failed write elsewhere (a full disk) does not sign anyone out
  send(res, 200, { signin: { enabled: signinOn(), clientId }, account: account(s), db: db.ok(), ladder: s ? db.ladderOf(s.ownerId, Date.now()) : null, places: s ? db.leaderPlaces(s.ownerId) : null });   // places (NOTES 126): the home tile's 'Pro #12' from the first screen   // ladder (docs/RANKED.md 10.1): the signed-in account's rank for the home tile; a guest reads it from /api/stats with its device id
}
const withShare = (p, o, req) => (p ? Object.assign(p, { share: share.linkOf(o, req) }) : p);   // the live share link ({ url, image } | null): the page knows it before any click (docs/SHARE.md 2)
const withPlaces = (p, o) => (p ? Object.assign(p, { places: db.leaderPlaces(o) }) : p);   // the global leaderboard places (NOTES 126): Your stats shows 'Champion #301'. Not in profileOf: the export and the card stay as they are
async function statsRoute(req, res, b) {
  const s = session(req); if (s) return send(res, 200, { profile: withPlaces(withShare(db.profileOf(s.ownerId), s.ownerId, req), s.ownerId) });
  const h = deviceOf(b, req), o = h ? db.guestOwner(h) : null;   // a merged device reads nothing: account data needs the cookie (8.1)
  send(res, 200, { profile: o != null ? withPlaces(withShare(db.profileOf(o), o, req), o) : null });
}
// the global leaderboards (NOTES 126): the top 100 of one board, the same for every visitor, kept LB_MS in memory (a new match shows within a minute)
const LB_MS = 30e3, lbCache = new Map();                          // board -> { at, body }
const PL_MS = 30e3, PL_MAX = 500, plCache = new Map();          // the leaderboard profile (NOTES 140): skeleton key -> { at, body | null }. 404s are cached too, so hammering one name is cheap
const boardsChanged = () => { lbCache.clear(); plCache.clear(); };   // hide, rename, delete: the boards and the profiles change at once, not after the cache
async function leaderRoute(req, res) {
  const q = new URL(String(req.url || ''), 'http://x').searchParams.get('b') || 'trophies';
  if (!db.BOARDS.includes(q)) return fail(res, 400, 'bad_request');
  const t = Date.now(), c = lbCache.get(q);
  if (c && t - c.at < LB_MS) return send(res, 200, c.body);
  const L = db.leaderboard(q); if (!L) return fail(res, 503, 'db_unavailable');
  const body = { board: q, total: L.total, at: t, rows: L.rows };
  lbCache.set(q, { at: t, body }); send(res, 200, body);
}
// one player's profile card from the board (NOTES 140): exactly the share card's subset (share.dataOf), for any account on a board (NOTES 141: at any place, not only the top 100).
// Unknown, guest, no username, hidden, on no board, renamed away, deleted and a malformed u: the same 404, and the name is never logged
const publicCard = (d, ranked, streak = 0) => ({ name: d.name, streak, rank: ranked ? { tier: d.tier, div: d.div, label: d.rank, pro: d.pro } : null, trophies: ranked ? d.trophies : 0, matt: d.matt,
  stats: d.big.map(b => ({ label: b.label, tag: b.tag, value: b.value, ...(b.cap ? { unit: b.cap } : {}), ...(b.sub ? { note: b.sub } : {}), ...(b.hero ? { hero: true } : {}) })) });   // the card's eleven, in its order: the three headline figures first (hero, with their note: '31-12 vs people'). Never v, em, guest, mattI or the slug
async function playerRoute(req, res) {
  const u = new URL(String(req.url || ''), 'http://x').searchParams.get('u');
  const key = names && typeof u === 'string' && u.length >= 1 && u.length <= 24 ? names.skeleton(u.normalize('NFKC').trim()) : '';   // the fold validate() and claimUsername use
  if (!key || key.length > 64) return fail(res, 404, 'not_found');
  const t = Date.now(), c = plCache.get(key);
  if (c && t - c.at < PL_MS) return c.body ? send(res, 200, c.body) : fail(res, 404, 'not_found');
  const who = db.leaderOwnerByKey(key); if (who === undefined) return fail(res, 503, 'db_unavailable');
  const d = who ? share.dataOf(who.owner, true) : null;                 // the share card's own subset (Pro: with its place)
  const body = d && !d.guest ? publicCard(d, who.ranked, share.streakOf(who.owner)) : null;   // guest: no username any more (a race with a delete)
  if (plCache.size >= PL_MAX) plCache.delete(plCache.keys().next().value);
  plCache.set(key, { at: t, body });
  return body ? send(res, 200, body) : fail(res, 404, 'not_found');
}
async function leaderHide(req, res, b) {                         // Show me on the global leaderboard (signed in only: a guest is never on it)
  const s = session(req); if (!s) return fail(res, 401, 'signin');
  const v = own(b, 'hidden'); if (typeof v !== 'boolean') return fail(res, 400, 'bad_request');
  if (!db.leaderHide(s.ownerId, v)) return fail(res, 503, 'db_unavailable');
  boardsChanged(); send(res, 200, { hidden: v, places: db.leaderPlaces(s.ownerId) });   // hiding takes the name (and its profile, NOTES 140) off every board at once, not after the cache
}
async function nonce(req, res) {
  const n = auth.newNonce(); nonceIssue(n, Date.now());          // kept, so a token can only be used with a nonce this server handed out, once
  send(res, 200, { nonce: n }, { 'Set-Cookie': auth.nonceCookie(n) });
}
async function signin(req, res, b) {
  const clear = auth.clearNonceCookie(), cookieNonce = auth.readNonce(req.headers.cookie), cred = own(b, 'credential');   // the nonce cookie is single use: cleared on every answer
  if (typeof cred !== 'string' || !cred || cred.length > 4096) return fail(res, 400, 'bad_request', { 'Set-Cookie': clear });
  let p; try { p = await verifier.verify(cred); } catch (e) {
    const st = e && e.name === 'AuthError' ? e.status : 401; return fail(res, st === 503 ? 503 : 401, st === 503 ? 'google_unavailable' : 'bad_token', { 'Set-Cookie': clear }); }
  if (!cookieNonce || !auth.safeEqual(p.nonce, cookieNonce) || !nonceUse(p.nonce, Date.now())) return fail(res, 403, 'nonce', { 'Set-Cookie': clear });   // the cookie alone can be forged from the token's own claim: the server's copy decides
  if (!db.ok()) return fail(res, 503, 'db_unavailable', { 'Set-Cookie': clear });
  const now = Date.now(), old = auth.readSession(req.headers.cookie);
  if (old) { stats.forget({ tokenHash: auth.tokenHash(old) }); db.session.revoke(old); }   // fixation: the session the request carried goes first, whoever's it was
  const a = db.accountBySub(p.sub) || db.createAccount(p.sub, now); if (!a) return fail(res, 503, 'db_unavailable', { 'Set-Cookie': clear });
  const h = deviceOf(b, req), g0 = h ? db.guestOwner(h) : null; if (g0 != null) share.forget(g0);   // a merge deletes the guest's link: its pictures leave memory first
  const merged = h ? db.mergeDevice(h, a.id, now) : 'none';
  const out = {}, raw = db.session.create(a.id, now, out); if (!raw) return fail(res, 503, 'db_unavailable', { 'Set-Cookie': clear });
  for (const t of out.evicted || []) stats.forget({ tokenHash: t });   // the 11th session evicted the oldest: its sockets stop speaking for the account
  send(res, 200, { account: account({ accountId: a.id }), merged, profile: withShare(db.profileOf(a.owner_id), a.owner_id, req) }, { 'Set-Cookie': [auth.sessionCookie(raw), clear] });
}
async function signout(req, res) {
  const raw = auth.readSession(req.headers.cookie);
  if (raw) { stats.forget({ tokenHash: auth.tokenHash(raw) }); db.session.revoke(raw); }
  send(res, 204, undefined, { 'Set-Cookie': auth.clearSessionCookie() });
}
async function username(req, res, b) {
  const s = session(req); if (!s) return fail(res, 401, 'signin');
  if (!names) return fail(res, 503, 'db_unavailable');
  const v = names.validate(own(b, 'username')); if (!v.ok) return fail(res, 422, 'invalid', undefined, { reason: v.reason });
  const now = Date.now(), r = db.claimUsername(s.accountId, v.name, v.key, now);
  if (r === 'ok') { boardsChanged(); try { social.changed(peersOf(s.accountId, now), []); } catch { /* best effort */ } return send(res, 200, { username: v.name, renameAt: now + renameDays * DAY }); }   // a new name shows on the boards (and their profile cards) at once, and on every friends list and request list naming it (not only online friends' at the next tick)
  if (r === 'taken' || r === 'held') return fail(res, 409, 'taken');   // never says which
  if (r === 'cooldown') { const a = db.accountById(s.accountId); return fail(res, 423, 'cooldown', undefined, { until: a && a.renamed_at != null ? a.renamed_at + renameDays * DAY : now }); }
  fail(res, 503, 'db_unavailable');
}
async function del(req, res, b) {
  if (own(b, 'confirm') !== 'delete') return fail(res, 400, 'bad_request');
  const now = Date.now(), s = session(req), h = auth.deviceHash(own(b, 'dev')), out = { account: false, device: false };
  const g = h ? db.guestOwner(h) : null;                         // only an UNMERGED guest: a merged device id deletes nothing by itself (8.1)
  const merged = !!h && !!s && db.accountByDevice(h) === s.accountId;   // ...but with the session it names this account's own browser
  if (s || g != null) stats.forget({ accountId: s ? s.accountId : null, devHash: g != null || merged ? h : null, deleted: true });   // first: no live seat or socket frozen on this account or device may write it again (3.3)
  const former = s ? peersOf(s.accountId, now) : [];              // before the cascade takes the rows: they hear the friendship (or the request) is gone (docs/SOCIAL.md 4)
  if (s) { share.forget(s.ownerId); out.account = db.deleteOwner(s.ownerId, now); }   // forget: the card pictures in memory go with the link
  if (s) try { social.changed(former, [s.accountId]); } catch { /* best effort */ }
  if (g != null) { share.forget(g); out.device = db.deleteOwner(g, now); }
  boardsChanged(); send(res, 200, { deleted: out }, { 'Set-Cookie': auth.clearSessionCookie() });   // a deleted account leaves the boards at once, not after the cache
}
async function exportRoute(req, res, b) {
  const s = session(req), h = auth.deviceHash(own(b, 'dev')), g = h ? db.guestOwner(h) : null, o = s ? s.ownerId : g;
  const x = o != null ? db.exportOf(o, Date.now()) : null; if (!x) return fail(res, 404, 'nothing');
  if (s && g != null) x.guestProfile = db.exportOf(g, Date.now());   // this browser's guest profile that did not merge (the caps): Delete my data deletes it too, so it is downloaded too
  const body = JSON.stringify(x, null, 2), day = new Date().toISOString().slice(0, 10);
  if (res.headersSent) return;
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="poddle-data-${day}.json"`, 'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex', 'Cross-Origin-Resource-Policy': 'same-origin', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
// the share link (docs/SHARE.md 2): the session's owner, else this browser's unmerged guest (like /api/stats)
const shareOwner = (req, b) => { const s = session(req); if (s) return s.ownerId; const h = deviceOf(b, req); return h ? db.guestOwner(h) : null; };
async function shareMake(req, res, b) {
  const o = shareOwner(req, b); if (o == null) return fail(res, 404, 'nothing');
  const r = share.make(o, req, Date.now());
  if (r === 'nothing') return fail(res, 404, 'nothing');
  if (!r) return fail(res, 503, 'db_unavailable');
  send(res, 200, r);
}
async function shareStop(req, res, b) {                            // idempotent: no link, no owner, still 204
  const o = shareOwner(req, b); if (o != null) share.drop(o);
  if (session(req)) { const h = deviceOf(b, req), g = h ? db.guestOwner(h) : null; if (g != null && g !== o) share.drop(g); }   // signed in on a browser whose guest stats did not merge (the caps): its link stops too, as Delete my data deletes both
  send(res, 204);
}
// ---- friends (docs/SOCIAL.md 3, 8) ----
// Accounts WITH a username only; a typed name is found by its confusable key (usernames.skeleton), so case and look-alikes never matter. The wire
// carries usernames, never an account or owner id. A friend change pushes fresh 'social' snapshots through the game's hook (social.changed)
const ST_W = Object.freeze({ off: 0, menu: 1, watching: 2, matt: 3, playing: 4, tour: 5 });   // most engaged last: game.js picks an account's status across its sockets with it, the list sorts by it
let social = { status: () => 'off', changed: () => {} }, addsMax = 30, searchMax = 60;
const acctHits = new Map();                                       // kind + account id -> { n, at }: a fixed window per account, memory only
function acctRate(kind, id, max, win) {                           // -> 0 when allowed, else retry-after seconds
  const t = Date.now(), k = kind + id;
  if (acctHits.size > 20000) for (const [x, b] of acctHits) if (t - b.at >= HOUR) acctHits.delete(x);   // every window is at most an hour: expired buckets are the same as none
  let b = acctHits.get(k); if (!b || t - b.at >= win) acctHits.set(k, b = { n: 0, at: t });
  if (b.n >= max) return Math.max(1, Math.ceil((b.at + win - t) / 1000));
  b.n++; return 0;
}
const stOf = id => { let s = 'off'; try { s = social.status(id); } catch { /* presence is best effort */ } return Object.prototype.hasOwnProperty.call(ST_W, s) ? s : 'off'; };
const byName = (x, y) => (x.toLowerCase() < y.toLowerCase() ? -1 : x.toLowerCase() > y.toLowerCase() ? 1 : 0);
// friendsBody(accountId) -> the GET /api/friends body, also the POST's snap and the WS 'social' message (game.js): { friends: [{ name, st, rank }], inc: [{ name, at }],
// out: [{ name, at }] } | null. Read fresh from the database every time (names change in admin.js, another process); online first by status weight, then by name
function friendsBody(id) {
  const L = db.friendsOf(id, Date.now()); if (!L) return null;
  const friends = L.friends.map(f => ({ name: f.name, st: stOf(f.id), rank: f.rank })).sort((x, y) => ST_W[y.st] - ST_W[x.st] || byName(x.name, y.name));
  return { friends, inc: L.inc, out: L.out };
}
const peersOf = (id, now) => [...new Set([...(db.friendIds(id) || []), ...(db.friendPeers(id, now) || [])])];   // every account whose lists show this one: its friends and its requests' other sides
function member(req, res) {                                       // the signed-in account with a username, or null after answering 401 signin / 403 username
  const s = session(req); if (!s) { fail(res, 401, 'signin'); return null; }
  const a = db.accountById(s.accountId); if (!a || !a.username) { fail(res, 403, 'username'); return null; }
  return s;
}
const nameKey = n => (typeof n === 'string' && n.length >= 1 && n.length <= 64 && names ? names.skeleton(n.normalize('NFKC').trim()) : null);   // a typed username -> its key (null: not a name)
const rate = (res, wait) => fail(res, 429, 'rate', { 'Retry-After': String(wait) }, { retryAfter: wait });
async function friendsGet(req, res) {
  const s = member(req, res); if (!s) return;
  const body = friendsBody(s.accountId); if (!body) return fail(res, 503, 'db_unavailable');
  send(res, 200, body);
}
const Q_RE = /^[A-Za-z0-9_]{2,12}$/;                              // what a username is made of; 2 characters at least, so one letter never lists half the players
async function friendSearch(req, res) {
  const s = member(req, res); if (!s) return;
  const q = new URL(String(req.url || ''), 'http://x').searchParams.get('q');
  if (typeof q !== 'string' || !Q_RE.test(q) || !names) return fail(res, 400, 'q');
  const wait = acctRate('s', s.accountId, searchMax, 10 * MIN); if (wait) return rate(res, wait);
  const rows = db.friendSearch(s.accountId, q.replace(/[\\%_]/g, c => '\\' + c) + '%', names.skeleton(q), Date.now());   // LIKE's own characters escaped (ESCAPE '\\'): '_' is a letter of a username here
  if (!rows) return fail(res, 503, 'db_unavailable');
  send(res, 200, { rows });                                       // the search text is answered, never stored or logged
}
// the profile card's friend half (web/profile.js openPlayer asks this and /api/leaderboard/player at once): public (a guest may open it). rank + places only when the account shows itself on the leaderboard, or to a friend (or itself: then a hidden
// account's places too, where it would stand); st only to a friend. A place is its number only, never the value under it: stats stay private (docs/SOCIAL.md 3)
const placesOut = p => (p ? Object.fromEntries(db.BOARDS.map(b => [b, p[b] ? { rank: p[b].rank } : null])) : null);
async function playerCard(req, res) {
  const k = nameKey(new URL(String(req.url || ''), 'http://x').searchParams.get('name')), P = k ? db.playerByKey(k) : null;
  if (!P) return fail(res, 404, 'notfound');
  const s = session(req), me = s ? s.accountId : null, rel = me != null && me !== P.id ? db.friendRel(me, P.id, Date.now()) : 'none', friend = rel === 'friend';
  const open = !P.hidden || friend || me === P.id;
  send(res, 200, { name: P.name, rank: open ? P.rank : null, places: open ? placesOut(db.leaderPlaces(P.ownerId, friend || me === P.id)) : null, rel, st: friend ? stOf(P.id) : null });
}
const OPS = new Set(['add', 'accept', 'decline', 'cancel', 'remove']), OP_ERR = { self: 409, notfound: 404, full: 409, limit: 409, norequest: 409, username: 403 };
async function friendsPost(req, res, b) {
  const s = member(req, res); if (!s) return;
  const op = own(b, 'op'); if (typeof op !== 'string' || !OPS.has(op)) return fail(res, 400, 'op');
  if (op === 'add') { const wait = acctRate('a', s.accountId, addsMax, HOUR); if (wait) return rate(res, wait); }   // before the lookup: a probe for names spends it too
  const k = nameKey(own(b, 'name')), t = k ? db.accountByKey(k) : null;
  if (!t || !t.username) return fail(res, 404, 'notfound');
  if (t.id === s.accountId) return fail(res, 409, 'self');
  const r = db.friendOp(s.accountId, t.id, op, Date.now());
  if (!r) return fail(res, 503, 'db_unavailable');
  if (r.err) return fail(res, OP_ERR[r.err] || 409, r.err);
  try { social.changed(r.other ? [s.accountId, t.id] : [s.accountId], [t.id]); } catch { /* the snapshots are best effort: the answer below is the truth */ }   // the other side hears only when its own lists changed
  send(res, 200, { r: r.r, rel: r.rel, snap: friendsBody(s.accountId) });
}

// path -> method -> [handler, per-minute-or-hour limit, window, needs sign-in on, needs the database]
const ROUTES = {
  '/api/me': { GET: [me, 60, MIN, false, false] },
  '/api/stats': { POST: [statsRoute, 30, MIN, false, true] },
  '/api/signin/nonce': { GET: [nonce, 20, MIN, true, false] },
  '/api/signin': { POST: [signin, 10, MIN, true, false] },       // db checked after the token (its own 503 db_unavailable)
  '/api/signout': { POST: [signout, 20, MIN, true, false] },
  '/api/username': { POST: [username, 10, MIN, true, true] },
  '/api/account': { DELETE: [del, 5, HOUR, false, true] },
  '/api/export': { POST: [exportRoute, 10, HOUR, false, true] },
  '/api/share': { POST: [shareMake, 20, MIN, false, true], DELETE: [shareStop, 20, MIN, false, true] },
  '/api/leaderboard': { GET: [leaderRoute, 60, MIN, false, true] },
  '/api/leaderboard/hide': { POST: [leaderHide, 20, MIN, true, true] },
  '/api/friends': { GET: [friendsGet, 60, MIN, true, true], POST: [friendsPost, 60, MIN, true, true] },   // one limiter bucket per path: both methods share it, so the same numbers
  '/api/friends/search': { GET: [friendSearch, 60, MIN, true, true] },
  '/api/player': { GET: [playerCard, 60, MIN, true, true] },   // the profile card's rank, places and friend row (docs/SOCIAL.md 8); the six stats come from /api/leaderboard/player
  '/api/leaderboard/player': { GET: [playerRoute, 60, MIN, false, true] },   // one player's profile card from the board (NOTES 140): public, 60 a minute, its own bucket (never starves the list)
};

// GET /api/traffic?days=N (NOTES 231): traffic.report() for the owner's stats panel at danielrltan.com/stats, with Authorization: Bearer STATS_KEY
// (a Fly secret; unset = 404, a wrong key = 401). The one route that answers a CORS preflight, for the panel's origins and localhost only. It
// never reads a cookie and never sends Allow-Credentials: the key is the only way in. Counts of pages and sources only, no person in them
const PANEL = new Set(['https://danielrltan.com', 'https://www.danielrltan.com']);
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
function trafficRoute(req, res) {
  if (!statsKey) return fail(res, 404, 'not_found');
  const origin = String(req.headers.origin || ''), cors = { Vary: 'Origin' };
  if (PANEL.has(origin) || /^http:\/\/(localhost|127\.0\.0\.1):\d{1,5}$/.test(origin)) cors['Access-Control-Allow-Origin'] = origin;
  if (req.method === 'OPTIONS') { res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Headers': 'Authorization', 'Access-Control-Max-Age': '86400' }); return void res.end(); }
  if (req.method !== 'GET') return fail(res, 405, 'method', { Allow: 'GET, OPTIONS', ...cors });
  const addr = auth.clientAddr(req).addr, wait = limiter.take('/api/traffic', nodeKey(addr), 30, MIN, wideKey(addr));
  if (wait) return fail(res, 429, 'rate', { 'Retry-After': String(wait), ...cors }, { retryAfter: wait });
  const m = /^Bearer (\S{1,200})$/.exec(String(req.headers.authorization || ''));
  if (!m || !crypto.timingSafeEqual(sha(m[1]), sha(statsKey))) return fail(res, 401, 'key', cors);
  if (!db.isOpen()) return fail(res, 503, 'db_unavailable', cors);
  const q = new URLSearchParams(String(req.url).split('?')[1] || ''), days = Math.min(400, Math.max(1, Math.floor(Number(q.get('days'))) || 30));
  send(res, 200, { site: 'poddleball.com', days: traffic.report(days) }, { ...cors, 'Cross-Origin-Resource-Policy': 'cross-origin' });
}

// handle(req, res) -> Promise that never rejects. game.js: api.handle(req, res).catch(() => {})
async function handle(req, res) {
  req.on('error', () => {}); res.on('error', () => {});
  try {
    if (!limiter) init();
    const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
    if (OLD_HOSTS.has(host)) return fail(res, 404, 'wrong_host');
    if (String(req.url || '').split('?')[0] === '/api/traffic') return trafficRoute(req, res);
    const route = ROUTES[String(req.url || '').split('?')[0]];
    if (!route) return fail(res, 404, 'not_found');
    const r = route[req.method]; if (!r) return fail(res, 405, 'method', { Allow: Object.keys(route).join(', ') });
    const [fn, limit, win, needsSignin, needsDb] = r;
    if (needsSignin && !signinOn()) return fail(res, 404, 'signin_off');
    const writes = req.method === 'POST' || req.method === 'DELETE';
    if (writes) {
      if (!auth.originAllowed(req.headers.origin, req.headers.host, { hosted, scheme: hosted ? 'https' : 'http' })) return fail(res, 403, 'origin');
      const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (ct !== 'application/json') return fail(res, 415, 'content_type');
    }
    const addr = auth.clientAddr(req).addr, wait = limiter.take(req.url.split('?')[0], nodeKey(addr), limit, win, wideKey(addr));
    if (wait) return fail(res, 429, 'rate', { 'Retry-After': String(wait) }, { retryAfter: wait });
    let body = null;
    if (writes) {
      try { body = await readBody(req); } catch (e) {
        if (!e || !e.status) return;                              // the client went away mid-body: nobody to answer
        if (e.status === 413) res.setHeader('Connection', 'close');
        return fail(res, e.status, e.error);
      }
    }
    if (needsDb && !db.isOpen()) return fail(res, 503, 'db_unavailable');   // open is enough: a read or a delete is worth trying after a failed write (a delete frees pages, and its success clears ok())
    await fn(req, res, body || {});
  } catch (e) {
    say('500 internal'); send(res, 500, { error: 'internal' });
  }
}

module.exports = { init, handle, signinOn, friendsBody, ST_W };
