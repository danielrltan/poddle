// Identity plumbing for player stats and Google sign-in (docs/ACCOUNTS.md 3, 6.3, 8.1). Pure helpers, nothing runs on require:
// device id checks, session and nonce tokens (random, only their SHA-256 is ever stored), cookie strings, the Origin allowlists,
// the client address (3.5), the Google ID token verifier on node:crypto, and the per-route rate limiter of the API.
// No function here logs an identity, an address, a token or a claim: the two log lines below carry fixed words only.
const crypto = require('crypto'), net = require('net'), fs = require('fs');

// ---- small shared pieces ----
class AuthError extends Error {                                                                          // code: what failed (stable, for tests and api.js); status: the HTTP answer; error: the word the client sees
  constructor(code, status = 401) { super(code); this.name = 'AuthError'; this.code = code; this.status = status; this.error = status === 503 ? 'google_unavailable' : 'bad_token'; }
}
const sha256 = s => crypto.createHash('sha256').update(String(s)).digest();                              // 32-byte Buffer: what the database keeps instead of a device id or a token
function safeEqual(a, b) {                                                                               // constant-time string compare (nonces, tokens): hashing first makes the lengths equal, so length leaks nothing either
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return crypto.timingSafeEqual(sha256(a), sha256(b)) && a.length === b.length;
}

// ---- device id (3.1): a bearer secret for the guest profile, only its hash is kept ----
const DEVICE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$|^[0-9a-f]{32}$/;
const validDevice = d => typeof d === 'string' && d.length <= 36 && DEVICE_RE.test(d);                  // crypto.randomUUID() or 16 random bytes in hex; anything else is "no device id"
const deviceHash = d => validDevice(d) ? sha256(d) : null;                                              // Buffer, or null for a missing/malformed id

// ---- session and nonce tokens (3.3) ----
const SESSION_MAX_AGE = 15552000;                                                                        // 180 days in seconds; the row's expires_at is created_at + the same, no sliding renewal
const SESSION_MS = SESSION_MAX_AGE * 1000, NONCE_MAX_AGE = 600;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/, NONCE_RE = /^[A-Za-z0-9_-]{22}$/;
const newToken = () => crypto.randomBytes(32).toString('base64url');                                    // 43 chars; goes in the cookie only, never a URL, a message, a body or a log
const newNonce = () => crypto.randomBytes(16).toString('base64url');                                    // 22 chars; binds one Google ID token to the browser that asked for it
const tokenHash = raw => sha256(raw);                                                                    // what sessions.token_hash stores and what a socket keeps (ws.tokenHash)

// ---- cookies (3.3): __Host- names when secure, which pins Secure, Path=/ and no Domain ----
const secureCookies = (env = process.env) => !!env.FLY_APP_NAME || env.COOKIE_SECURE === '1';          // read at call time, so tests can flip it
const cookieNames = (secure = secureCookies()) => secure ? { session: '__Host-poddle_s', nonce: '__Host-poddle_n' } : { session: 'poddle_s', nonce: 'poddle_n' };
const cookieStr = (name, value, sameSite, maxAge, secure) => `${name}=${value}; HttpOnly${secure ? '; Secure' : ''}; SameSite=${sameSite}; Path=/; Max-Age=${maxAge}`;   // local http drops Secure (a browser would refuse to store it there)
const sessionCookie = (raw, secure = secureCookies()) => cookieStr(cookieNames(secure).session, raw, 'Lax', SESSION_MAX_AGE, secure);     // Set-Cookie value for a new session
const clearSessionCookie = (secure = secureCookies()) => cookieStr(cookieNames(secure).session, '', 'Lax', 0, secure);                     // same attributes, or a browser keeps the __Host- cookie
const nonceCookie = (nonce, secure = secureCookies()) => cookieStr(cookieNames(secure).nonce, nonce, 'Strict', NONCE_MAX_AGE, secure);   // set by GET /api/signin/nonce
const clearNonceCookie = (secure = secureCookies()) => cookieStr(cookieNames(secure).nonce, '', 'Strict', 0, secure);                     // on every /api/signin answer: single use
function parseCookie(header) {                                                                           // name -> raw value; splits on ';', trims, first '=' separates, the first of a repeated name wins; never throws
  const out = Object.create(null);                                                                      // no prototype: a cookie called __proto__ is just a key
  if (Array.isArray(header)) header = header.join('; ');
  if (typeof header !== 'string' || header.length > 4096) return out;                                    // an oversized header is treated as no cookies (truncating could leave half a token)
  for (const part of header.split(';')) {
    const i = part.indexOf('='); if (i < 1) continue;
    const name = part.slice(0, i).trim(); if (!name || name in out) continue;
    out[name] = part.slice(i + 1).trim();
  }
  return out;
}
const readSession = (header, secure = secureCookies()) => { const v = parseCookie(header)[cookieNames(secure).session]; return v && TOKEN_RE.test(v) ? v : null; };   // the raw session token, format-checked, or null
const readNonce = (header, secure = secureCookies()) => { const v = parseCookie(header)[cookieNames(secure).nonce]; return v && NONCE_RE.test(v) ? v : null; };        // the nonce cookie, format-checked, or null

// ---- Origin (3.4) ----
const HOSTED_ORIGINS = new Set(['https://poddleball.com', 'https://www.poddleball.com', 'https://poddle.fly.dev']);
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/;                          // any port: tests use 8140-9430
const HOST_RE = /^[a-z0-9.\-]{1,253}(:\d{1,5})?$|^\[[0-9a-f:.]{2,45}\](:\d{1,5})?$/;
function originAllowed(origin, host, { hosted = !!process.env.FLY_APP_NAME, scheme = 'http' } = {}) {   // true only for the pages allowed to use a session or write a profile; 'null' and absent are false
  if (typeof origin !== 'string' || origin.length > 300) return false;
  if (HOSTED_ORIGINS.has(origin)) return true;
  if (hosted) return false;                                                                              // production: exactly the three, no localhost and no Host-equal rule (a hostile local dev server must not pass)
  if (LOCAL_ORIGIN.test(origin)) return true;
  const h = typeof host === 'string' ? host.trim().toLowerCase() : '';                                   // LAN play: the page and its socket share host:port, and the scheme must match what this server serves
  return (scheme === 'http' || scheme === 'https') && HOST_RE.test(h) && origin.toLowerCase() === scheme + '://' + h;
}

// ---- client address (3.5) ----
// The header is chosen by the Q1 probe: CLIENT_ADDR_HEADER=fly-client-ip (default) or x-forwarded-for-last (the LAST entry, the one Fly's proxy appends).
// Hosted, a header value that is not a public address becomes the one shared key 'bad' (never a per-socket key: forging junk must not buy extra courts),
// and never the peer (on Fly that is the proxy). Local, only a loopback peer may name its address in the header (tests forge it on purpose).
const NOT_PUBLIC = new net.BlockList();
for (const [a, bits] of [['127.0.0.0', 8], ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['169.254.0.0', 16], ['100.64.0.0', 10], ['0.0.0.0', 32]]) NOT_PUBLIC.addSubnet(a, bits, 'ipv4');   // loopback, private, link-local, CGNAT, unspecified
for (const [a, bits] of [['::', 96], ['fc00::', 7], ['fe80::', 10]]) NOT_PUBLIC.addSubnet(a, bits, 'ipv6');   // ::/96 holds :: and ::1 (and the long-dead IPv4-compatible forms); ULA; link-local. IPv4-mapped forms are matched against the IPv4 rules by BlockList
const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const isLoopbackPeer = (addr, fromPeer) => fromPeer === true && LOOPBACK_PEERS.has(addr);               // this machine: an EXACT match on the TCP peer, never on a header value (replaces game.js loopback())
let badLogAt = -Infinity;
function headerAddr(req, which) {                                                                       // the chosen header's value as a trimmed string, or '' when absent
  const h = req && req.headers || {};
  let v = which === 'x-forwarded-for-last' ? h['x-forwarded-for'] : h['fly-client-ip'];
  if (Array.isArray(v)) v = v.join(',');
  if (typeof v !== 'string') return '';
  if (which === 'x-forwarded-for-last') { const parts = v.split(','); v = parts[parts.length - 1]; }
  return v.trim().slice(0, 64);
}
function publicAddr(v) {                                                                                 // the address with ::ffff: stripped if it is a public IP, else null
  if (!v || !net.isIP(v)) return null;
  const a = /^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(v) ? v.slice(7) : v, fam = net.isIP(a) === 4 ? 'ipv4' : 'ipv6';
  try { return NOT_PUBLIC.check(a, fam) ? null : a; } catch { return null; }                          // a zone id (fe80::1%en0) or anything BlockList chokes on is not public
}
function clientAddr(req, { hosted = !!process.env.FLY_APP_NAME, header = process.env.CLIENT_ADDR_HEADER, now = Date.now, log = console.log } = {}) {   // -> { addr, fromPeer }
  const which = String(header || '').toLowerCase() === 'x-forwarded-for-last' ? 'x-forwarded-for-last' : 'fly-client-ip';   // anything unknown falls back to the default
  const peer = String(req && req.socket && req.socket.remoteAddress || '');
  if (hosted) {
    const a = publicAddr(headerAddr(req, which));
    if (a) return { addr: a, fromPeer: false };
    if (now() - badLogAt >= 3600e3) { badLogAt = now(); log('net: client address header rejected'); }  // at most once an hour, never the value
    return { addr: 'bad', fromPeer: false };
  }
  const v = LOOPBACK_PEERS.has(peer) ? headerAddr(req, which) : '';
  return v ? { addr: v, fromPeer: false } : { addr: peer, fromPeer: true };
}

// ---- Google ID token verifier (6.3), node:crypto only ----
const GOOGLE_ISS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const B64URL = /^[A-Za-z0-9_-]+$/, SUB_RE = /^[0-9A-Za-z_-]{1,255}$/;
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
function decodeJson(seg) { try { const v = JSON.parse(Buffer.from(seg, 'base64url').toString('utf8')); return isObj(v) ? v : null; } catch { return null; } }
function parseJwks(text) {                                                                               // Map kid -> KeyObject; only RSA signing keys of 2048+ bits, only n and e are read
  let doc; try { doc = JSON.parse(text); } catch { return null; }
  if (!isObj(doc) || !Array.isArray(doc.keys)) return null;
  const keys = new Map();
  for (const k of doc.keys.slice(0, 20)) {
    if (!isObj(k) || k.kty !== 'RSA' || (k.alg !== undefined && k.alg !== 'RS256') || (k.use !== undefined && k.use !== 'sig')) continue;
    if (typeof k.kid !== 'string' || !k.kid.length || k.kid.length > 128 || typeof k.n !== 'string' || typeof k.e !== 'string') continue;
    try { const key = crypto.createPublicKey({ key: { kty: 'RSA', n: k.n, e: k.e }, format: 'jwk' }); if (key.asymmetricKeyDetails.modulusLength >= 2048) keys.set(k.kid, key); } catch { /* a bad key is skipped, not fatal */ }
  }
  return keys;
}
const maxAgeMs = cc => { const m = /(?:^|,)\s*max-age\s*=\s*(\d{1,9})/i.exec(String(cc || '')); return Math.min(Math.max(m ? +m[1] * 1000 : 0, 300e3), 86400e3); };   // Google's max-age, clamped to 5 min .. 24 h
function createGoogleVerifier({ clientId, jwksFile, fetchImpl = globalThis.fetch, now = Date.now } = {}) {   // -> { verify(token) -> Promise<{ sub, nonce }> or throws AuthError }
  if (typeof clientId !== 'string' || !clientId) throw new TypeError('createGoogleVerifier: clientId required');
  if (process.env.NODE_ENV === 'production') jwksFile = null;                                          // a key file is a test fixture: production only trusts Google
  let cache = null, lastTry = -Infinity, kidTry = -Infinity, inflight = null;                           // cache: { keys: Map, exp: ms }; lastTry: any load; kidTry: the last load an unknown kid asked for
  async function load() {                                                                                // one fetch (or file read); throws on failure
    if (jwksFile) { const keys = parseJwks(fs.readFileSync(jwksFile, 'utf8')); if (!keys) throw new Error('jwks'); return { keys, exp: now() + 300e3 }; }
    const res = await fetchImpl(JWKS_URL, { signal: AbortSignal.timeout(3000), redirect: 'error' });
    if (!res || !res.ok) throw new Error('jwks');
    const text = await res.text(); if (text.length > 65536) throw new Error('jwks');
    const keys = parseJwks(text); if (!keys || !keys.size) throw new Error('jwks');
    return { keys, exp: now() + maxAgeMs(res.headers && res.headers.get && res.headers.get('cache-control')) };
  }
  function refresh() {                                                                                   // shared in-flight promise; the attempt time is taken before awaiting so concurrent calls fetch once
    if (inflight) return inflight;
    lastTry = now();
    inflight = load().then(c => { cache = c; }, () => { /* keep the old set, if any */ }).finally(() => { inflight = null; });
    return inflight;
  }
  async function keyFor(kid) {
    const t = now(), fresh = cache && t < cache.exp;
    if (fresh && cache.keys.has(kid)) return cache.keys.get(kid);
    if (inflight) await inflight;
    else if (!cache ? t - lastTry >= 5e3 : !fresh ? t - lastTry >= 60e3 : t - kidTry >= 60e3) {         // nothing loaded: retry every 5 s at most; stale set: once a minute; unknown kid in a fresh set: one refetch a minute
      if (fresh) kidTry = t;
      await refresh();
    }
    if (!cache) throw new AuthError('google_unavailable', 503);                                          // never loaded: 503; a failed refresh with a cached set keeps using it
    const key = cache.keys.get(kid); if (!key) throw new AuthError('unknown_kid');
    return key;
  }
  async function verify(token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 4096) throw new AuthError('malformed');
    const seg = token.split('.');
    if (seg.length !== 3 || !seg.every(s => B64URL.test(s))) throw new AuthError('malformed');          // Buffer's base64url decoder skips junk silently, so the alphabet is checked first
    const head = decodeJson(seg[0]); if (!head) throw new AuthError('malformed');
    if (head.alg !== 'RS256') throw new AuthError('alg');                                               // none, HS256 (public key as HMAC secret), RS512, ES256: all refused
    if (typeof head.kid !== 'string' || !head.kid.length || head.kid.length > 128 || (head.typ !== undefined && head.typ !== 'JWT')) throw new AuthError('malformed');   // jku, x5u, jwk are never read
    const key = await keyFor(head.kid);
    if (!crypto.verify('RSA-SHA256', Buffer.from(seg[0] + '.' + seg[1]), key, Buffer.from(seg[2], 'base64url'))) throw new AuthError('signature');   // before any claim is looked at
    const p = decodeJson(seg[1]); if (!p) throw new AuthError('malformed');
    const t = now() / 1000, num = v => typeof v === 'number' && Number.isFinite(v);                    // claims are seconds, the clock is ms
    if (!GOOGLE_ISS.has(p.iss) || typeof p.aud !== 'string' || p.aud !== clientId || (p.azp !== undefined && p.azp !== clientId)) throw new AuthError('claims');   // an aud array is refused
    if (!num(p.exp) || p.exp <= t - 30 || !num(p.iat) || p.iat > t + 60 || (p.nbf !== undefined && (!num(p.nbf) || p.nbf > t + 60))) throw new AuthError('claims');
    if (typeof p.sub !== 'string' || !SUB_RE.test(p.sub) || typeof p.nonce !== 'string' || !p.nonce || p.nonce.length > 128) throw new AuthError('claims');
    return { sub: p.sub, nonce: p.nonce };                                                               // everything else (email, name, picture, locale, hd) is dropped here, unread
  }
  return { verify };
}
function verifierFromEnv(env = process.env, log = console.log) {                                       // the boot-time verifier, or null when sign-in is off (GOOGLE_CLIENT_ID unset or empty)
  let jwksFile = env.GOOGLE_JWKS_FILE || null;
  if (jwksFile && env.NODE_ENV === 'production') { log('auth: GOOGLE_JWKS_FILE ignored in production'); jwksFile = null; }   // said at boot even with sign-in off
  const clientId = String(env.GOOGLE_CLIENT_ID || '').trim(); if (!clientId) return null;
  return createGoogleVerifier({ clientId, jwksFile });
}

// ---- rate limiter (8.1): token buckets per (route, computer node), memory only ----
// key is opaque to this module: the caller passes the keyed hash of 5.4, never a raw address. The map is capped (oldest evicted), and while
// more than floodPerMin never-seen keys a minute arrive (IPv6 /64 rotation) new keys share one fallback bucket per route AND per `wide` key
// (the caller's keyed hash of a wider prefix, IPv6 /48 or IPv4 /24): a flood from one network never locks out everyone else. A key seen in
// the last hour is not new, so a returning user whose full bucket was pruned gets their own bucket back, not the fallback.
function createRateLimiter({ maxKeys = 20000, floodPerMin = 1000, now = Date.now } = {}) {             // -> { take(route, key, limit, windowMs, wide?) -> 0 when allowed, else retry-after seconds (>= 1); size() }
  const buckets = new Map(), fallback = new Map(), seen = new Map();                                    // bucket: { tokens, at, limit, win }; seen: key -> last seen (insertion order = age)
  let minute = -Infinity, fresh = 0, pruned = -Infinity;
  const refill = (b, t) => { b.tokens = Math.min(b.limit, b.tokens + (t - b.at) * b.limit / b.win); b.at = t; };
  function prune(t) {                                                                                    // lazily, once a minute: a full bucket is the same as no bucket
    pruned = t;
    for (const [k, b] of buckets) { refill(b, t); if (b.tokens >= b.limit) buckets.delete(k); }
    for (const [k, b] of fallback) { refill(b, t); if (b.tokens >= b.limit) fallback.delete(k); }
    for (const [k, at] of seen) { if (t - at < 3600e3) break; seen.delete(k); }
  }
  function spend(b, t) {
    refill(b, t);
    if (b.tokens >= 1) { b.tokens -= 1; return 0; }
    return Math.max(1, Math.ceil((1 - b.tokens) * b.win / b.limit / 1000));
  }
  function take(route, key, limit, windowMs, wide = '') {
    const t = now(); if (t - pruned >= 60e3) prune(t);
    if (t - minute >= 60e3) { minute = t; fresh = 0; }
    const k = route + '\n' + key, known = seen.has(key);
    seen.delete(key); seen.set(key, t); if (seen.size > maxKeys * 2) seen.delete(seen.keys().next().value);   // most recent last; capped
    let b = buckets.get(k);
    if (!b) {
      if (!known && ++fresh > floodPerMin) {                                                            // a flood of never-seen keys: they share one bucket per route and wider prefix
        const fk = route + '\n' + String(wide || ''); let f = fallback.get(fk);
        if (!f) { if (fallback.size >= maxKeys) fallback.delete(fallback.keys().next().value); fallback.set(fk, f = { tokens: limit, at: t, limit, win: windowMs }); }
        return spend(f, t);
      }
      if (buckets.size >= maxKeys) buckets.delete(buckets.keys().next().value);                          // Map order is insertion order: the oldest goes
      buckets.set(k, b = { tokens: limit, at: t, limit, win: windowMs });
    }
    return spend(b, t);
  }
  return { take, size: () => buckets.size };
}

module.exports = {
  AuthError, sha256, safeEqual,
  DEVICE_RE, validDevice, deviceHash,
  SESSION_MAX_AGE, SESSION_MS, newToken, newNonce, tokenHash,
  secureCookies, cookieNames, sessionCookie, clearSessionCookie, nonceCookie, clearNonceCookie, parseCookie, readSession, readNonce,
  originAllowed, clientAddr, isLoopbackPeer, publicAddr,
  createGoogleVerifier, verifierFromEnv, createRateLimiter,
};
