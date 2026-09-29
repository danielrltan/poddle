// The /api/* routes (docs/ACCOUNTS.md 8): profile read, export and delete for guests (device id in the JSON body) and accounts (session
// cookie), and Google sign-in, sign-out and usernames (only when GOOGLE_CLIENT_ID is set; otherwise those answer 404 signin_off).
// game.js routes every /api/ request here first thing. Nothing runs on require: init() once at boot.
// Rules (8.1): every POST/DELETE needs an allowed Origin (403) and Content-Type application/json (415), which forces a CORS preflight that
// this server never answers (no Access-Control-* header anywhere). Bodies: 8 KB, 5 s, a JSON object, fields read one by one with type
// checks and never spread or merged. Rate limits per computer node (a keyed hash, never the address). Logs: one fixed line per failure
// class an hour at most, never an identity, a body, a token or an address. handle() never throws or rejects: a throw answers 500.
// Public, no sign-in: GET /api/leaderboard (NOTES 126) and GET /api/leaderboard/player?u=<name> (a listed player's profile card, NOTES 140).
const crypto = require('node:crypto');
const auth = require('./auth'), db = require('./db'), stats = require('./stats'), abuse = require('./abuse'), share = require('./share');
let names = null; try { names = require('./usernames'); } catch { /* usernames need sign-in, which then answers 503 */ }

const MIN = 60e3, HOUR = 3600e3, DAY = 86400e3, BODY_MAX = 8192, BODY_MS = 5000;
const OLD_HOSTS = new Set(['poddle.fly.dev', 'www.poddleball.com']);   // the cookie is scoped to poddleball.com: never a redirect here (8.1)
let rkSignin = true, verifier = null, clientId = null, limiter = null, salt = crypto.randomBytes(32), saltAt = Date.now(), hosted = false, renameDays = 30;
const logged = new Map();                                        // failure class -> last log time
const NONCE_MS = 600e3, NONCES_MAX = 50000;                      // the nonce cookie's Max-Age (auth.nonceCookie); a bound on the map
const nonces = new Map();                                        // SHA-256 of each nonce this process issued -> expiry, memory only. Single use: a sign-in takes it out

// init({ env }) -> sign-in on when GOOGLE_CLIENT_ID is set (the client id is public; it only ever comes from the environment)
function init({ env = process.env } = {}) {
  hosted = !!env.FLY_APP_NAME; rkSignin = !(env.RK_GUESTS === '1' && env.NODE_ENV !== 'production');   // game.js RK_SIGNIN, the same rule (NOTES 133)
  verifier = auth.verifierFromEnv(env);                          // logs 'auth: GOOGLE_JWKS_FILE ignored in production' when it applies
  clientId = verifier ? String(env.GOOGLE_CLIENT_ID).trim() : null;
  limiter = auth.createRateLimiter(); salt = crypto.randomBytes(32); saltAt = Date.now(); nonces.clear(); boardsChanged();
  const r = Math.floor(Number(env.RENAME_DAYS)); renameDays = env.RENAME_DAYS !== undefined && env.RENAME_DAYS !== '' && Number.isFinite(r) ? Math.min(3650, Math.max(0, r)) : 30;
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
  send(res, 200, { rkSignin, signin: { enabled: signinOn(), clientId }, account: account(s), db: db.ok(), ladder: s ? db.ladderOf(s.ownerId, Date.now()) : null, places: s ? db.leaderPlaces(s.ownerId) : null });   // places (NOTES 126): the home tile's 'Pro #12' from the first screen   // ladder (docs/RANKED.md 10.1): the signed-in account's rank for the home tile; a guest reads it from /api/stats with its device id
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
// one player's profile card from the board (NOTES 140): exactly the share card's subset (share.dataOf), for an account inside a board's top 100.
// Unknown, guest, no username, hidden, renamed away, deleted, outside every top 100 and a malformed u: the same 404, and the name is never logged
const publicCard = (d, ranked) => ({ name: d.name, rank: ranked ? { tier: d.tier, div: d.div, label: d.rank, pro: d.pro } : null, trophies: ranked ? d.trophies : 0, matt: d.matt,
  stats: d.big.map(b => ({ label: b.label, value: b.value, ...(b.cap ? { unit: b.cap } : {}) })) });   // never v, em, guest, mattI, bar or the slug
async function playerRoute(req, res) {
  const u = new URL(String(req.url || ''), 'http://x').searchParams.get('u');
  const key = names && typeof u === 'string' && u.length >= 1 && u.length <= 24 ? names.skeleton(u.normalize('NFKC').trim()) : '';   // the fold validate() and claimUsername use
  if (!key || key.length > 64) return fail(res, 404, 'not_found');
  const t = Date.now(), c = plCache.get(key);
  if (c && t - c.at < PL_MS) return c.body ? send(res, 200, c.body) : fail(res, 404, 'not_found');
  const who = db.leaderOwnerByKey(key); if (who === undefined) return fail(res, 503, 'db_unavailable');
  const d = who ? share.dataOf(who.owner) : null;                 // the share card's own subset (Pro: with its place)
  const body = d && !d.guest ? publicCard(d, who.ranked) : null;   // guest: no username any more (a race with a delete)
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
  if (r === 'ok') { boardsChanged(); return send(res, 200, { username: v.name, renameAt: now + renameDays * DAY }); }   // a new name shows on the boards at once
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
  if (s) { share.forget(s.ownerId); out.account = db.deleteOwner(s.ownerId, now); }   // forget: the card pictures in memory go with the link
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
  '/api/leaderboard/player': { GET: [playerRoute, 60, MIN, false, true] },   // one player's profile card from the board (NOTES 140): public, 60 a minute, its own bucket (never starves the list)
};

// handle(req, res) -> Promise that never rejects. game.js: api.handle(req, res).catch(() => {})
async function handle(req, res) {
  req.on('error', () => {}); res.on('error', () => {});
  try {
    if (!limiter) init();
    const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
    if (OLD_HOSTS.has(host)) return fail(res, 404, 'wrong_host');
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

module.exports = { init, handle, signinOn };
