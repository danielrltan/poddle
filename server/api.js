// The /api/* routes (docs/ACCOUNTS.md 8): profile read, export and delete for guests (device id in the JSON body) and accounts (session
// cookie), and Google sign-in, sign-out and usernames (only when GOOGLE_CLIENT_ID is set; otherwise those answer 404 signin_off).
// game.js routes every /api/ request here first thing. Nothing runs on require: init() once at boot.
// Rules (8.1): every POST/DELETE needs an allowed Origin (403) and Content-Type application/json (415), which forces a CORS preflight that
// this server never answers (no Access-Control-* header anywhere). Bodies: 8 KB, 5 s, a JSON object, fields read one by one with type
// checks and never spread or merged. Rate limits per computer node (a keyed hash, never the address). Logs: one fixed line per failure
// class an hour at most, never an identity, a body, a token or an address. handle() never throws or rejects: a throw answers 500.
const crypto = require('node:crypto');
const auth = require('./auth'), db = require('./db'), stats = require('./stats'), abuse = require('./abuse');
let names = null; try { names = require('./usernames'); } catch { /* usernames need sign-in, which then answers 503 */ }

const MIN = 60e3, HOUR = 3600e3, DAY = 86400e3, BODY_MAX = 8192, BODY_MS = 5000;
const OLD_HOSTS = new Set(['poddle.fly.dev', 'www.poddleball.com']);   // the cookie is scoped to poddleball.com: never a redirect here (8.1)
let verifier = null, clientId = null, limiter = null, salt = crypto.randomBytes(32), saltAt = Date.now(), hosted = false, renameDays = 30;
const logged = new Map();                                        // failure class -> last log time
const NONCE_MS = 600e3, NONCES_MAX = 50000;                      // the nonce cookie's Max-Age (auth.nonceCookie); a bound on the map
const nonces = new Map();                                        // SHA-256 of each nonce this process issued -> expiry, memory only. Single use: a sign-in takes it out

// init({ env }) -> sign-in on when GOOGLE_CLIENT_ID is set (the client id is public; it only ever comes from the environment)
function init({ env = process.env } = {}) {
  hosted = !!env.FLY_APP_NAME;
  verifier = auth.verifierFromEnv(env);                          // logs 'auth: GOOGLE_JWKS_FILE ignored in production' when it applies
  clientId = verifier ? String(env.GOOGLE_CLIENT_ID).trim() : null;
  limiter = auth.createRateLimiter(); salt = crypto.randomBytes(32); saltAt = Date.now(); nonces.clear();
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
  send(res, 200, { signin: { enabled: signinOn(), clientId }, account: account(s), db: db.ok() });
}
async function statsRoute(req, res, b) {
  const s = session(req); if (s) return send(res, 200, { profile: db.profileOf(s.ownerId) });
  const h = deviceOf(b, req), o = h ? db.guestOwner(h) : null;   // a merged device reads nothing: account data needs the cookie (8.1)
  send(res, 200, { profile: o != null ? db.profileOf(o) : null });
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
  const h = deviceOf(b, req), merged = h ? db.mergeDevice(h, a.id, now) : 'none';
  const out = {}, raw = db.session.create(a.id, now, out); if (!raw) return fail(res, 503, 'db_unavailable', { 'Set-Cookie': clear });
  for (const t of out.evicted || []) stats.forget({ tokenHash: t });   // the 11th session evicted the oldest: its sockets stop speaking for the account
  send(res, 200, { account: account({ accountId: a.id }), merged, profile: db.profileOf(a.owner_id) }, { 'Set-Cookie': [auth.sessionCookie(raw), clear] });
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
  if (r === 'ok') return send(res, 200, { username: v.name, renameAt: now + renameDays * DAY });
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
  if (s) out.account = db.deleteOwner(s.ownerId, now);
  if (g != null) out.device = db.deleteOwner(g, now);
  send(res, 200, { deleted: out }, { 'Set-Cookie': auth.clearSessionCookie() });
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
