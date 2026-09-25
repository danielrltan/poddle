// Accounts unit tests (docs/ACCOUNTS.md 12.1): server/db.js, abuse.js, usernames.js/words.js and auth.js, loaded with createRequire.
// No server and no port. The database is ':memory:' except where a file is the point (secure_delete, the size cap, sweep's files):
// those use a temp dir under os.tmpdir(), removed on exit. Every clock is injected. Last line: ACCOUNTS UNIT PASSED or N FAILURES.
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
const require = createRequire(import.meta.url);
const db = require('../server/db.js'), abuse = require('../server/abuse.js'), U = require('../server/usernames.js'), W = require('../server/words.js'), auth = require('../server/auth.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'poddle-'));
process.on('exit', () => { try { db.close(); } catch { /* already closed */ } fs.rmSync(tmp, { recursive: true, force: true }); });
let fails = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const DAY = 86400e3, HOUR = 3600e3, T0 = Date.UTC(2026, 8, 24, 12);   // a fixed wall clock: every db/abuse call takes `now`
const dev = n => crypto.createHash('sha256').update('device-' + n).digest();   // a device hash, as auth.deviceHash would make it
const quiet = f => { const e = console.error, l = console.log; console.error = console.log = () => {}; try { return f(); } finally { console.error = e; console.log = l; } };   // db logs one line on an expected failure
const quietAsync = async f => { const e = console.error; console.error = () => {}; try { return await f(); } finally { console.error = e; } };

// ======================================================================= usernames / words (7)
console.log('usernames');
{
  const r = (n, reason) => { const v = U.validate(n); ok(reason ? !v.ok && v.reason === reason : v.ok, `validate(${JSON.stringify(n)}) -> ${reason || 'ok'}${v.ok ? '' : ' (got ' + v.reason + ')'}`); return v; };
  r('ab', 'length'); r('abcdefghijklm', 'length'); r('x'.repeat(70), 'length'); r('abc'); r('Abcdefghijkl');
  r('ab-c', 'chars'); r('a b c', 'chars'); r('Мatt', 'chars'); r('Dan<b>', 'chars'); r(42, 'chars'); r(null, 'chars');
  const fw = r('ＡＢＣ'); ok(fw.name === 'ABC', 'NFKC: fullwidth ＡＢＣ is stored as ABC');
  r('123', 'letter'); r('1_2_3', 'letter');
  r('ProMatt', 'reserved'); r('TourMatt', 'reserved'); r('Matt_Tour', 'reserved'); r('Rookie_Matt', 'reserved'); r('Matthew'); r('Mateo');   // Matt + a level would carry the registered badge
  r('_abc', 'underscore'); r('abc_', 'underscore'); r('a__bc', 'underscore'); r('a_bc');
  const keys = ['Matt', 'M4tt', 'rnatt', 'MAT_T', 'Maatt'].map(U.skeleton);
  ok(keys.every(k => k === keys[0]) && keys[0] === 'mat', 'skeleton: Matt, M4tt, rnatt, MAT_T and Maatt share one key (' + keys.join(',') + ')');
  ok(U.skeleton('vvcl') === 'wd' && U.skeleton('rrnn') === 'rmn', 'skeleton: digraphs folded until stable, then runs collapse');
  r('Matthew'); r('Mateo');
  r('Matt', 'reserved'); r('M4tt', 'reserved'); r('PoddleTeam', 'reserved'); r('P0ddle', 'reserved'); r('Admin_2', 'reserved'); r('SystemBot', 'reserved');
  r('Mod', 'reserved'); r('Pro', 'reserved'); r('Player1', 'reserved'); r('Opponent', 'reserved'); r('Moda'); r('Proton');
  const d = s => Buffer.from(s, 'base64').toString();                  // the lists are base64 in words.js; the test builds its inputs from them, never spelled out
  const sev = d(W.PROFANITY_SUB[W.PROFANITY_SUB.indexOf('ZnVjaw==')]), mild = d(W.PROFANITY_EXACT[W.PROFANITY_EXACT.indexOf('Y29jaw==')]);
  r('xx' + sev + 'yy', 'profanity'); r(sev.toUpperCase().replace('U', 'U'), 'profanity');
  r(mild[0].toUpperCase() + mild.slice(1), 'profanity'); r('Cockburn'); r('Dickens'); r('Pomona'); r('Therapist'); r('Classic');
  ok(U.renameWait(null, T0) === 0 && U.renameWait(T0 - 31 * DAY, T0, 30) === 0 && U.renameWait(T0 - DAY, T0, 30) === T0 + 29 * DAY, 'renameWait: first claim free, 30-day cooldown, the until time');
  // guest names (7.3)
  for (const n of ['Мatt', 'Mаtt', 'ΜΑΤΤ', 'MAΤT', 'Matt.', 'Matt!', 'M a t t', 'Matt™', 'Mat̲t', 'ProMatt', 'Matt_bot', 'MattPro', 'TourMatt', 'PoddleHQ', 'Admin'])
    ok(U.impersonates(n), `impersonates(${JSON.stringify(n)})`);
  for (const n of ['Matthew', 'Mateo', 'Pro', 'Club', 'Me', 'Daniel', '', 'Mat'.slice(0, 2)]) ok(!U.impersonates(n), `guest name ${JSON.stringify(n)} allowed`);
  ok(U.guestShown('Мatt', 0) === 'Player 1' && U.guestShown('Matt!', 1) === 'Player 2' && U.guestShown('Daniel', 1) === 'Daniel', 'guestShown: an impersonating guest shows as Player 1/2 by seat');
  ok(U.stripBadges('Daniel ✓').trim() === 'Daniel' && U.stripBadges('✔Dan✅☑√™🗸️').trim() === 'Dan', 'stripBadges removes ✓ ✔ ✅ ☑ √ ™ 🗸 (and their variation selector)');
  ok(!fs.existsSync(new URL('../web/words.js', import.meta.url)), 'words.js is not under web/');
}

// ======================================================================= auth: device id, tokens, cookies, Origin (3)
console.log('auth: device ids, tokens, cookies, Origin');
{
  const uuid = crypto.randomUUID();
  ok(auth.validDevice(uuid) && auth.validDevice('0123456789abcdef0123456789abcdef'), 'validDevice: randomUUID and 32 hex');
  ok(!auth.validDevice(uuid.toUpperCase()) && !auth.validDevice(uuid + 'a') && !auth.validDevice('../../etc/passwd') && !auth.validDevice(123) && !auth.validDevice(''), 'validDevice refuses upper case, long, junk, non-strings');
  ok(auth.deviceHash(uuid).length === 32 && auth.deviceHash('nope') === null, 'deviceHash: 32 bytes, null for a malformed id');
  const t = auth.newToken(), n = auth.newNonce();
  ok(/^[A-Za-z0-9_-]{43}$/.test(t) && /^[A-Za-z0-9_-]{22}$/.test(n) && t !== auth.newToken(), 'newToken 43 chars, newNonce 22, random');
  ok(auth.safeEqual('abc', 'abc') && !auth.safeEqual('abc', 'abd') && !auth.safeEqual('abc', 'abcd') && !auth.safeEqual('abc', null), 'safeEqual');
  const p = auth.parseCookie('a=1; b = 2 ;a=3;  poddle_s=' + t + ';=x;noeq;__proto__=p');
  ok(p.a === '1' && p.b === '2' && p.poddle_s === t && p.__proto__ === 'p' && Object.getPrototypeOf(p) === null, 'parseCookie: first of a repeated name wins, spaces trimmed, __proto__ is just a key');
  ok(Object.keys(auth.parseCookie('a=' + 'x'.repeat(5000))).length === 0 && Object.keys(auth.parseCookie(undefined)).length === 0, 'parseCookie: a 5 KB header or none is no cookies, never a throw');
  ok(auth.readSession('poddle_s=' + t, false) === t && auth.readSession('poddle_s=short', false) === null && auth.readSession('__Host-poddle_s=' + t, true) === t && auth.readSession('poddle_s=' + t, true) === null, 'readSession: name by mode, format-checked');
  const sc = auth.sessionCookie(t, true), sl = auth.sessionCookie(t, false);
  ok(sc.startsWith('__Host-poddle_s=' + t) && /; HttpOnly/.test(sc) && /; Secure/.test(sc) && /SameSite=Lax/.test(sc) && /Path=\//.test(sc) && /Max-Age=15552000/.test(sc) && !/Domain/i.test(sc), 'session cookie: __Host-, HttpOnly, Secure, Lax, Path=/, 180 days, no Domain');
  ok(sl.startsWith('poddle_s=') && !/Secure/.test(sl), 'local session cookie: poddle_s, no Secure');
  ok(/Max-Age=0/.test(auth.clearSessionCookie(true)) && /SameSite=Strict/.test(auth.nonceCookie(n, true)) && /Max-Age=600/.test(auth.nonceCookie(n, true)), 'clear cookie Max-Age=0; nonce cookie Strict, 10 min');
  ok(auth.secureCookies({ FLY_APP_NAME: 'poddle' }) && auth.secureCookies({ COOKIE_SECURE: '1' }) && !auth.secureCookies({}), 'secureCookies from FLY_APP_NAME or COOKIE_SECURE=1');
  // Origin matrix (3.4)
  const L = (o, h, s = 'http') => auth.originAllowed(o, h, { hosted: false, scheme: s }), H = (o, h, s = 'https') => auth.originAllowed(o, h, { hosted: true, scheme: s });
  ok(['https://poddleball.com', 'https://www.poddleball.com', 'https://poddle.fly.dev', 'http://localhost', 'http://localhost:9420', 'http://127.0.0.1:8080', 'http://[::1]:3000'].every(o => L(o, 'x')), 'local: the three hosts, localhost/127.0.0.1/[::1] any port pass');
  ok(L('http://192.168.1.5:8080', '192.168.1.5:8080') && !L('https://192.168.1.5:8080', '192.168.1.5:8080') && !L('http://192.168.1.5:8080', '192.168.1.6:8080'), 'local: Host-equal LAN origin with the same scheme only');
  ok(!L('null', 'x') && !L(undefined, 'x') && !L('https://poddleball.com.evil.test', 'x') && !L('http://poddleball.com', 'x') && !L('http://localhost.evil.test', 'x') && !L('https://evil.test', 'evil.test', 'http'), 'local: null, absent, suffix trick, http://poddleball.com, other scheme refused');
  ok(['https://poddleball.com', 'https://www.poddleball.com', 'https://poddle.fly.dev'].every(o => H(o, 'poddleball.com')), 'hosted: the three https origins pass');
  ok(!H('http://localhost:3000', 'x') && !H('http://127.0.0.1:8080', 'x') && !H('https://poddle-x.fly.dev', 'poddle-x.fly.dev') && !H('http://poddleball.com', 'poddleball.com') && !H('null', 'x'), 'hosted: localhost, loopback, Host-equal and http refused');
}

// ======================================================================= auth: client address (3.5)
console.log('auth: clientAddr / loopback');
{
  const req = (peer, hdr = {}) => ({ socket: { remoteAddress: peer }, headers: hdr });
  const logs = []; let clock = T0; const opt = (o = {}) => ({ hosted: true, header: undefined, now: () => clock, log: s => logs.push(s), ...o });
  for (const v of ['127.0.0.1', '10.0.0.1', 'fe80::1', '100.64.0.1', 'garbage', '172.16.5.5', '192.168.1.1', '::1', 'fc00::1', '0.0.0.0', '::', '::ffff:10.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:a00:1', '::127.0.0.1', 'FE80::1', 'fd00::1', 'fe80::1%eth0', '169.254.1.1', 'x127.0.0.1', '1.2.3.4.5', '08.8.8.8']) {
    const a = auth.clientAddr(req('172.19.0.2', { 'fly-client-ip': v }), opt());
    ok(a.addr === 'bad' && a.fromPeer === false && !auth.isLoopbackPeer(a.addr, a.fromPeer), `hosted fly-client-ip ${v} -> 'bad', not loopback-exempt`);
  }
  ok(auth.clientAddr(req('172.19.0.2', {}), opt()).addr === 'bad', 'hosted, no header -> bad (never the proxy peer)');
  ok(logs.length === 1 && logs[0] === 'net: client address header rejected', 'the rejection logs once an hour, with no value');
  clock += HOUR; auth.clientAddr(req('1.1.1.1', { 'fly-client-ip': '10.1.1.1' }), opt()); ok(logs.length === 2 && !logs.join().includes('10.1.1.1'), '... again after an hour, still without the value');
  const pub = auth.clientAddr(req('172.19.0.2', { 'fly-client-ip': ' 8.8.8.8 ' }), opt());
  ok(pub.addr === '8.8.8.8' && pub.fromPeer === false && !auth.isLoopbackPeer(pub.addr, pub.fromPeer), 'hosted public address -> that address');
  ok(auth.clientAddr(req('x', { 'fly-client-ip': '::ffff:8.8.4.4' }), opt()).addr === '8.8.4.4' && auth.clientAddr(req('x', { 'fly-client-ip': '2001:4860::1' }), opt()).addr === '2001:4860::1', 'hosted: mapped IPv4 stripped, public IPv6 kept');
  const xf = o => auth.clientAddr(req('172.19.0.2', { 'x-forwarded-for': '9.9.9.9, 127.0.0.1, 8.8.8.8', 'fly-client-ip': '7.7.7.7', ...o }), opt({ header: 'x-forwarded-for-last' })).addr;
  ok(xf() === '8.8.8.8' && xf({ 'x-forwarded-for': '8.8.8.8, 10.0.0.1' }) === 'bad', 'CLIENT_ADDR_HEADER=x-forwarded-for-last reads the LAST entry only (a forged first entry is ignored)');
  ok(auth.clientAddr(req('x', { 'fly-client-ip': '8.8.8.8' }), opt({ header: 'something-else' })).addr === '8.8.8.8', 'an unknown CLIENT_ADDR_HEADER falls back to fly-client-ip');
  const lh = auth.clientAddr(req('127.0.0.1', { 'fly-client-ip': '5.6.7.8' }), { hosted: false });
  ok(lh.addr === '5.6.7.8' && lh.fromPeer === false && !auth.isLoopbackPeer(lh.addr, lh.fromPeer), 'local, loopback peer with a header -> the header, not exempt');
  const ln = auth.clientAddr(req('::ffff:127.0.0.1'), { hosted: false });
  ok(ln.addr === '::ffff:127.0.0.1' && ln.fromPeer && auth.isLoopbackPeer(ln.addr, ln.fromPeer), 'local, loopback peer without a header -> exempt');
  const lx = auth.clientAddr(req('127.0.0.1', { 'fly-client-ip': 'x127.0.0.1' }), { hosted: false });
  ok(!auth.isLoopbackPeer(lx.addr, lx.fromPeer) && !auth.isLoopbackPeer('x127.0.0.1', true) && !auth.isLoopbackPeer('127.0.0.1', false), "'x127.0.0.1' is never exempt, and a header value is never exempt");
  const lan = auth.clientAddr(req('192.168.1.9', { 'fly-client-ip': '127.0.0.1' }), { hosted: false });
  ok(lan.addr === '192.168.1.9' && lan.fromPeer && !auth.isLoopbackPeer(lan.addr, lan.fromPeer), 'local, non-loopback peer: the header is ignored');
}

// ======================================================================= auth: rate limiter (8.1)
console.log('auth: rate limiter');
{
  let clock = T0; const rl = auth.createRateLimiter({ now: () => clock });
  ok(rl.take('r', 'k', 3, 60e3) === 0 && rl.take('r', 'k', 3, 60e3) === 0 && rl.take('r', 'k', 3, 60e3) === 0 && rl.take('r', 'k', 3, 60e3) >= 1, 'limit 3: the 4th is refused with retry-after >= 1 s');
  clock += 20e3; ok(rl.take('r', 'k', 3, 60e3) === 0, 'a token refills after window/limit');
  const big = auth.createRateLimiter({ now: () => clock, floodPerMin: 1e9 });
  for (let i = 0; i < 25000; i++) big.take('r', 'key' + i, 5, 60e3);
  ok(big.size() <= 20000, '25 000 distinct keys -> the map stays at or under 20 000 (' + big.size() + ')');
  const fl = auth.createRateLimiter({ now: () => clock });
  for (let i = 0; i < 1000; i++) fl.take('r', 'n' + i, 1, 60e3);
  ok(fl.take('r', 'flood-a', 1, 60e3) === 0 && fl.take('r', 'flood-b', 1, 60e3) >= 1, 'a flood of new keys shares one fallback bucket per route');
  // the flood fallback is per wider network, and a known key keeps its own bucket (a /48 of fresh /64s must not lock everyone out of DELETE /api/account)
  clock = T0; const fw = auth.createRateLimiter({ now: () => clock });
  ok(fw.take('/api/account', 'legit', 5, 3600e3, 'home') === 0, 'a user deletes once');
  clock += 13 * 60e3; fw.take('/api/me', 'tick', 60, 60e3, 'x');   // their bucket refilled and was pruned
  for (let i = 0; i < 1001; i++) fw.take('/api/me', 'fl' + i, 60, 60e3, 'attacker48');
  for (let i = 0; i < 6; i++) fw.take('/api/account', 'fl-d' + i, 5, 3600e3, 'attacker48');
  const waits = [fw.take('/api/account', 'legit', 5, 3600e3, 'home'), ...[1, 2, 3].map(k => fw.take('/api/account', 'new' + k, 5, 3600e3, 'net' + k))];
  ok(waits.every(w => w === 0) && fw.take('/api/account', 'fl-d9', 5, 3600e3, 'attacker48') >= 1, 'during a flood from one /48: a returning user and new users elsewhere are served (' + waits + '), the flooding network shares its own bucket');
}

// ======================================================================= auth: Google ID token verifier (6.3)
console.log('auth: Google ID token verifier');
{
  const CID = 'test-client.apps.googleusercontent.com';                // a fixture: the real client id only ever arrives through env GOOGLE_CLIENT_ID
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
  const jwks = JSON.stringify({ keys: [jwk, { kty: 'EC', kid: 'ec', crv: 'P-256', x: 'a', y: 'b' }] });
  const b = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const sign = (h, p, key = privateKey) => { const s = b(h) + '.' + b(p); return s + '.' + crypto.sign('RSA-SHA256', Buffer.from(s), key).toString('base64url'); };
  let clock = T0, fetches = 0, down = false, maxAge = 600;
  const fetchImpl = async url => { fetches++; if (down || url !== 'https://www.googleapis.com/oauth2/v3/certs') throw new Error('offline');
    return { ok: true, text: async () => jwks, headers: { get: k => k.toLowerCase() === 'cache-control' ? 'public, max-age=' + maxAge + ', must-revalidate' : null } }; };
  const v = auth.createGoogleVerifier({ clientId: CID, fetchImpl, now: () => clock });
  const s = () => Math.floor(clock / 1000);
  const claims = o => ({ iss: 'https://accounts.google.com', aud: CID, azp: CID, sub: '109876543210987654321', nonce: 'n0nce', iat: s(), exp: s() + 3600, email: 'x@example.com', name: 'X', ...o });
  const H = { alg: 'RS256', kid: 'k1', typ: 'JWT' };
  const code = async tok => { try { await v.verify(tok); return 'ok'; } catch (e) { return e instanceof auth.AuthError ? e.code + (e.status === 503 ? ':503' : '') : 'THREW ' + e; } };
  const good = await v.verify(sign(H, claims()));
  ok(eq(good, { sub: '109876543210987654321', nonce: 'n0nce' }), 'a good token -> { sub, nonce } only (email, name dropped)');
  ok(fetches === 1, 'JWKS fetched once');
  const cases = [
    ['wrong aud', sign(H, claims({ aud: 'other.apps.googleusercontent.com' })), 'claims'],
    ['aud as an array', sign(H, claims({ aud: [CID] })), 'claims'],
    ['wrong azp', sign(H, claims({ azp: 'other' })), 'claims'],
    ['wrong iss', sign(H, claims({ iss: 'https://evil.test' })), 'claims'],
    ['iss without https but google', sign(H, claims({ iss: 'accounts.google.com' })), 'ok'],
    ['expired beyond the 30 s skew', sign(H, claims({ exp: s() - 31 })), 'claims'],
    ['expired inside the skew', sign(H, claims({ exp: s() - 20 })), 'ok'],
    ['iat in the future', sign(H, claims({ iat: s() + 120 })), 'claims'],
    ['nbf in the future', sign(H, claims({ nbf: s() + 120 })), 'claims'],
    ['bad sub', sign(H, claims({ sub: 'a b' })), 'claims'],
    ['nonce missing', sign(H, claims({ nonce: undefined })), 'claims'],
    ['alg none, empty signature', b({ alg: 'none', kid: 'k1' }) + '.' + b(claims()) + '.', 'malformed'],
    ['alg none with a signature', b({ alg: 'none', kid: 'k1' }) + '.' + b(claims()) + '.AAAA', 'alg'],
    ['alg HS256 keyed with the public key (confusion)', (() => { const h = b({ alg: 'HS256', kid: 'k1' }) + '.' + b(claims()); return h + '.' + crypto.createHmac('sha256', publicKey.export({ type: 'spki', format: 'pem' })).update(h).digest('base64url'); })(), 'alg'],
    ['alg RS512', (() => { const h = b({ alg: 'RS512', kid: 'k1' }) + '.' + b(claims()); return h + '.' + crypto.sign('RSA-SHA512', Buffer.from(h), privateKey).toString('base64url'); })(), 'alg'],
    ['typ not JWT', sign({ ...H, typ: 'JWS' }, claims()), 'malformed'],
    ['kid missing', sign({ alg: 'RS256' }, claims()), 'malformed'],
    ['signed by another key', sign(H, claims(), other.privateKey), 'signature'],
    ['payload tampered after signing', (() => { const t = sign(H, claims()).split('.'); t[1] = b(claims({ sub: '1' })); return t.join('.'); })(), 'signature'],
    ['signature truncated', sign(H, claims()).slice(0, -4), 'signature'],
    ['5 KB token', sign(H, claims({ pad: 'x'.repeat(5000) })), 'malformed'],
    ['malformed base64', 'eyJhbGciOiJSUzI1NiJ9.e!yJ.abc', 'malformed'],
    ['two segments', b(H) + '.' + b(claims()), 'malformed'],
    ['not a string', 12345, 'malformed'],
  ];
  for (const [name, tok, want] of cases) { const got = await code(tok); ok(got === want, `${name} -> ${want}${got === want ? '' : ' (got ' + got + ')'}`); }
  ok(fetches === 1, 'no refetch for known-kid failures');
  const unk = sign({ ...H, kid: 'k9' }, claims());
  ok(await code(unk) === 'unknown_kid' && fetches === 2, 'unknown kid: one refetch, then unknown_kid');
  ok(await code(sign({ ...H, kid: 'k8' }, claims())) === 'unknown_kid' && fetches === 2, 'another unknown kid within 60 s: no second refetch');
  ok(await code(sign({ ...H, kid: 'ec' }, claims())) === 'unknown_kid', 'a non-RSA key in the JWKS is never imported');
  clock += 590e3; ok(await code(sign(H, claims())) === 'ok' && fetches === 2, 'JWKS cache honours max-age=600 (no fetch at 590 s)');
  clock += 20e3; ok(await code(sign(H, claims())) === 'ok' && fetches === 3, '... and refetches once it is stale');
  down = true; clock += 700e3; ok(await code(sign(H, claims())) === 'ok' && fetches === 4, 'Google down with a cached set: the old keys keep working');
  const cold = auth.createGoogleVerifier({ clientId: CID, fetchImpl, now: () => clock });
  ok(await (async () => { try { await cold.verify(sign(H, claims())); return false; } catch (e) { return e.code === 'google_unavailable' && e.status === 503 && e.error === 'google_unavailable'; } })(), 'Google down with nothing cached -> 503 google_unavailable');
  maxAge = 5; down = false; const shortV = auth.createGoogleVerifier({ clientId: CID, fetchImpl, now: () => clock }); const f0 = fetches;
  await shortV.verify(sign(H, claims())); clock += 200e3; await shortV.verify(sign(H, claims()));
  ok(fetches === f0 + 1, 'max-age below 5 min is clamped up to 5 min');
  const jf = path.join(tmp, 'jwks.json'); fs.writeFileSync(jf, jwks);
  const fileV = auth.createGoogleVerifier({ clientId: CID, jwksFile: jf, fetchImpl: () => { throw new Error('no fetch'); }, now: () => clock });
  ok((await fileV.verify(sign(H, claims()))).sub === '109876543210987654321', 'jwksFile fixture replaces the fetch');
  const logs = [];
  ok(auth.verifierFromEnv({}, s => logs.push(s)) === null && auth.verifierFromEnv({ GOOGLE_CLIENT_ID: '  ' }) === null, 'verifierFromEnv: GOOGLE_CLIENT_ID unset or blank -> sign-in off');
  ok(auth.verifierFromEnv({ GOOGLE_CLIENT_ID: CID }) !== null, 'verifierFromEnv: a client id from env -> a verifier');
  auth.verifierFromEnv({ NODE_ENV: 'production', GOOGLE_JWKS_FILE: jf }, s => logs.push(s));
  ok(logs.length === 1 && logs[0] === 'auth: GOOGLE_JWKS_FILE ignored in production', 'production ignores GOOGLE_JWKS_FILE and says so');
  const srv = new URL('../server/', import.meta.url), idShape = /\d{6,}-[a-z0-9]{20,}\.apps\.googleusercontent\.com/;
  ok(fs.readdirSync(srv).filter(n => n.endsWith('.js')).every(n => !idShape.test(fs.readFileSync(new URL(n, srv), 'utf8'))), 'no Google client id is hard-coded in server/*.js (it comes only from env GOOGLE_CLIENT_ID)');
}

// ======================================================================= abuse: computerKey, rank, config (3.5, 5.1, 5.3)
console.log('abuse: computerKey, rank, config');
{
  const K = abuse.computerKey;
  ok(K('1.2.3.4') === '1.2.3.4' && K('::ffff:1.2.3.4') === '1.2.3.4' && K('::FFFF:7f00:1') === '127.0.0.1', 'IPv4 whole; IPv4-mapped IPv6 as the IPv4');
  ok(K('2001:db8:1:2::5') === K('2001:0DB8:0001:0002:ffff::9') && K('2001:db8:1:2::5') === '2001:db8:1:2', 'two addresses in one /64 share a key');
  ok(K('2001:db8:1:3::5') !== K('2001:db8:1:2::5'), 'a different /64 is a different key');
  ok(K('') === 'local' && K(undefined) === 'local' && K('bad') === 'bad' && K('garbage') === 'bad' && K('x'.repeat(100)) === 'bad', "empty -> 'local', 'bad' and junk -> 'bad'");
  ok(K(K('2001:db8:1:2::5')) === K('2001:db8:1:2::5') && K(K('1.2.3.4')) === '1.2.3.4', 'idempotent on its own output');
  const r = abuse.rank; ok(r(0) < r(1) && r(1) < r(3) && r(3) < r(2) && r(7) === -1, 'rank: Rookie < Club < Tour < Pro (by BOT_ORDER, not the wire index)');
  const dev0 = abuse.config({}), prod = abuse.config({ NODE_ENV: 'production', STATS_SAME_IP: '0', STATS_AFK_MIN: '0', STATS_TELEPORT_MS: '0', STATS_ESTABLISHED: '0', STATS_FORFEIT_MIN: '1', WIN_AT: '11' });
  ok(dev0.sameIp && dev0.minPointS === 2.5 && dev0.forfeitMin === 6 && dev0.pairDay === 3 && dev0.afkMin === 2 && dev0.teleportMs === 12 && dev0.established && dev0.newGuestDay === 30 && dev0.newGuestHour === 600, 'config defaults (5.3)');
  ok(prod.sameIp && prod.afkMin === 2 && prod.teleportMs === 12 && prod.established && prod.forfeitMin === 6, 'production ignores STATS_SAME_IP=0, AFK_MIN=0, TELEPORT_MS=0, ESTABLISHED=0 and STATS_FORFEIT_MIN');
  const test = abuse.config({ STATS_SAME_IP: '0', STATS_AFK_MIN: '0', STATS_TELEPORT_MS: '0', STATS_ESTABLISHED: '0', STATS_FORFEIT_MIN: '1', STATS_MIN_POINT_S: 'junk' });
  ok(!test.sameIp && test.afkMin === 0 && test.teleportMs === 0 && !test.established && test.forfeitMin === 1 && test.minPointS === 2.5 && Object.isFrozen(test), 'test knobs honoured off production; junk -> default; frozen');
}

// ======================================================================= abuse: judge, one case per rule (5.2)
console.log('abuse: judge');
const CFG = abuse.config({ WIN_AT: '11' });
const seat = (n, o = {}) => ({ owner: 100 + n, ident: { devHash: dev(n), cid: 'cid' + n }, groups: new Set(['g' + n]), computers: new Set(['9.9.9.' + n]), cids: new Set(['cid' + n]),
  contacts: 20, held: 0, established: true, ...o });
const human = (o = {}, sa = {}, sb = {}) => ({ now: T0, kind: 'human', winner: 0, ending: 'won', score: [11, 5], secs: 300, seats: [seat(1, sa), seat(2, sb)], ...o });
const MATT = { bot: true };
const vsBot = (o = {}, sa = {}) => ({ now: T0, kind: 'bot', winner: 0, ending: 'won', score: [11, 5], secs: 300, seats: [seat(1, sa), MATT], ...o });
const J = (f, h = {}, c = CFG) => abuse.judge(f, h, c);
const rec = v => v.seats.map(s => (s.record ? 'R' : '-') + (s.bests ? 'B' : '-')).join(' ');
const has = (v, ...ids) => ids.every(i => v.flags.includes(i));
{
  let v = J(human()); ok(v.ranked && v.flags.length === 0 && rec(v) === 'RB RB', 'baseline human match: ranked, both recorded with bests');
  v = J(vsBot()); ok(v.ranked && rec(v) === 'RB --', 'baseline bot win: ranked, the human recorded');
  v = J(vsBot({ winner: 1, score: [5, 11] })); ok(v.ranked && rec(v) === 'RB --', 'bot loss: the loss is recorded');
  v = J({ ...human(), legacy: true }); ok(!v.ranked && eq(v.flags, ['legacy']) && rec(v) === '-- --', 'R0 legacy: ignored');
  v = J(human({}, {}, { pad: true })); ok(!v.ranked && has(v, 'pad') && !v.seats[1].record, 'R1 pad: that socket ignored');
  v = J(vsBot({}, { ident: null })); ok(!v.ranked && has(v, 'anon') && rec(v) === '-- --', 'R3 anon (bot): ignored for that seat');
  v = J(vsBot({}, { ident: null, originBad: true })); ok(has(v, 'origin_bad', 'anon') && !v.seats[0].record, 'R17 origin_bad: treated as anonymous');
  v = J(vsBot({ revived: true })); ok(!v.ranked && has(v, 'revived') && rec(v) === '-- --', 'R2 revived bot win: unranked, no bests');
  v = J(human({ revived: true })); ok(!v.ranked && has(v, 'revived') && rec(v) === '-- --', 'R2 revived human: unranked');
  v = J(human({}, {}, { ident: null })); ok(!v.ranked && has(v, 'anon_opponent', 'anon') && rec(v) === '-- --', 'R4 anon_opponent: the winner over an anonymous seat gets nothing');
  v = J(human({}, {}, { gone: true })); ok(v.ranked && !has(v, 'anon_opponent'), 'R4 not triggered by gone (the frozen identity still judges)');
  v = J(human({}, {}, { pendingAnon: true })); ok(!has(v, 'anon_opponent') && has(v, 'ident_changed'), 'R4 not triggered by a mid-match downgrade (that is R6b)');
  v = J(human({}, {}, { groups: new Set(['g1']) })); ok(!v.ranked && has(v, 'same_computer') && rec(v) === '-- --', 'R5 same_computer: unranked');
  v = J(human({}, { ident: { accountId: 1, cid: 'a' }, groups: new Set(['home']) }, { ident: { accountId: 2, cid: 'b' }, groups: new Set(['home']) }));
  ok(!v.ranked && has(v, 'same_computer'), 'accepted false positive (Q4 strict): two established accounts in one household stay unranked');
  const loop = { computers: new Set(['127.0.0.1']), groups: new Set(['gL']) };
  v = J(human({}, loop, loop), {}, abuse.config({ STATS_SAME_IP: '0' })); ok(v.ranked && !has(v, 'same_computer'), 'R5 off with STATS_SAME_IP=0 when both seats are loopback');
  v = J(human({}, { groups: new Set(['gX']) }, { groups: new Set(['gX']) }), {}, abuse.config({ STATS_SAME_IP: '0' })); ok(has(v, 'same_computer'), 'STATS_SAME_IP=0 never disables R5 for real addresses');
  v = J(human({}, loop, loop), {}, abuse.config({ STATS_SAME_IP: '0', NODE_ENV: 'production' })); ok(has(v, 'same_computer'), 'production applies R5 even on loopback');
  v = J(human({}, {}, { ident: { devHash: Buffer.from(dev(1)), cid: 'x' } })); ok(!v.ranked && has(v, 'same_device'), 'R6 same_device (hash equality)');
  v = J(human({}, { ident: { accountId: 7, cid: 'a' } }, { ident: { accountId: 7, cid: 'b' } })); ok(!v.ranked && has(v, 'same_account'), 'R6 same_account');
  v = J(human({}, {}, { cids: new Set(['cid2', 'cid1']) })); ok(!v.ranked && has(v, 'same_cid'), 'R6 same_cid (any cid seen on either seat)');
  v = J(human({}, {}, { identChanged: true }));
  ok(v.ranked && has(v, 'ident_changed') && rec(v) === 'RB R-', 'R6b identity-changed LOSER: loss recorded (no bests), the winner ranked');
  v = J(human({}, { identChanged: true })); ok(!v.ranked && rec(v) === '-- RB', 'R6b identity-changed WINNER: win withheld, the loser\'s loss recorded');
  v = J(human({ ending: 'forfeit', score: [3, 2] })); ok(!v.ranked && has(v, 'early_forfeit') && rec(v) === '-- --', 'R7 forfeit after 5 points (FORFEIT_MIN = ceil(11/2) = 6): unranked');
  v = J(human({ ending: 'forfeit', score: [4, 2] })); ok(v.ranked && !has(v, 'early_forfeit'), 'R7 forfeit after 6 points: counted');
  v = J(human({ ending: 'forfeit', score: [3, 6] })); ok(!v.ranked && has(v, 'leaver_ahead'), 'R7b leaver ahead by 3: unranked');
  v = J(human({ ending: 'forfeit', score: [4, 6] })); ok(v.ranked && !has(v, 'leaver_ahead'), 'R7b leaver ahead by 2: counted');
  v = J(human({ secs: 30 })); ok(!v.ranked && has(v, 'too_fast') && rec(v) === '-- R-', 'R8 too_fast human: win unranked, loss still counts');
  v = J(vsBot({ secs: 30 })); ok(!v.ranked && rec(v) === '-- --', 'R8 too_fast bot win: unranked');
  v = J(vsBot({ secs: 30, winner: 1, score: [5, 11] })); ok(has(v, 'too_fast') && rec(v) === 'R- --', 'R8 too_fast bot loss: the loss counts');
  v = J(vsBot({ winner: 1, score: [5, 11] }, { contacts: 1 })); ok(has(v, 'afk') && rec(v) === 'R- --', 'R9 idle seat LOSING to Matt: loss counted');
  v = J(vsBot({}, { contacts: 1 })); ok(!v.ranked && has(v, 'afk') && rec(v) === '-- --', 'R9 idle seat beating Matt: win unranked');
  v = J(vsBot({ ending: 'left', winner: null, score: [2, 6] }, { contacts: 0 })); ok(rec(v) === 'R- --', "R9 idle seat LEAVING Matt ('left'): still a recorded loss");
  v = J(human({}, { contacts: 1 })); ok(!v.ranked && rec(v) === '-- --', 'R9 idle WINNER: win unranked and the loss withheld');
  v = J(human({}, {}, { contacts: 1 })); ok(!v.ranked && rec(v) === '-- R-', 'R9 idle LOSER: the win over it unranked, its loss counted');
  v = J(human({}, { contacts: 1 }, {}), {}, abuse.config({ STATS_AFK_MIN: '0' })); ok(v.ranked && !has(v, 'afk'), 'STATS_AFK_MIN=0 disables R9 (tests)');
  v = J(human(), { pairRanked24h: 3 }); ok(!v.ranked && has(v, 'pair_cap'), 'R10 pair_cap by owners');
  v = J(human(), { cpuPair24h: 3 }); ok(!v.ranked && has(v, 'pair_cap'), 'R10 pair_cap by computer groups');
  v = J(human(), { pairRanked24h: 2, cpuPair24h: 2 }); ok(v.ranked, 'R10 below the cap: counted');
  v = J(human(), { pairRanked24h: 3, loserHuman7d: { losses: 6, wins: 0, topTwoShare: 1 } }); ok(has(v, 'pair_cap', 'feeder'), 'R11 fires TOGETHER with R10');
  v = J(human(), { loserHuman7d: { losses: 5, wins: 0, topTwoShare: 1 } }); ok(!has(v, 'feeder'), 'R11: 5 losses is not a feeder');
  v = J(human(), { loserHuman7d: { losses: 6, wins: 0, topTwoShare: 0.5 } }); ok(!has(v, 'feeder'), 'R11: losses spread over many winners is not a feeder');
  v = J(human(), { loserHuman7d: { losses: 6, wins: 2, topTwoShare: 1 } }); ok(!has(v, 'feeder'), 'R11: a loser who wins 25% is not a feeder');
  v = J(human(), { cpuLoser24h: { losses: 6, distinctWinnerGroups: 2 } }); ok(has(v, 'feeder') && !v.ranked, 'R11 by computer group');
  v = J(human(), { cpuLoser24h: { losses: 6, distinctWinnerGroups: 3 } }); ok(!has(v, 'feeder'), 'R11 by computer: 3 winner groups is not a feeder');
  v = J(human(), { oneWay30d: { aOverB: 5, bOverA: 0 } }); ok(!v.ranked && has(v, 'one_way'), 'R11b after 5 one-way ranked wins');
  v = J(human(), { oneWay30d: { aOverB: 5, bOverA: 1 } }); ok(v.ranked, 'R11b: one win back is a rivalry');
  v = J(human(), { oneWay30d: { aOverB: 4, bOverA: 0 } }); ok(v.ranked, 'R11b: 4 wins is fine');
  v = J(human({}, {}, { established: false })); ok(!v.ranked && has(v, 'new_opponent') && rec(v) === '-- RB', 'R11c new loser: winner credit withheld, loss (and the loser\'s own bests) recorded');
  v = J(human({}, { established: false })); ok(v.ranked && !has(v, 'new_opponent'), 'R11c looks only at the LOSER');
  v = J(human({}, {}, { established: false }), {}, abuse.config({ STATS_ESTABLISHED: '0' })); ok(v.ranked, 'STATS_ESTABLISHED=0 disables R11c');
  v = J(human(), { winnerWins24h: 30 }); ok(!v.ranked && has(v, 'daily_cap'), 'R12 daily_cap at 30 wins');
  v = J(human(), { winnerWins24h: 29 }); ok(v.ranked, 'R12: 29 is fine');
  v = J(vsBot({ levelChanged: true })); ok(v.ranked && has(v, 'level_changed') && rec(v) === 'RB --', 'R13 level_changed: informational, counted');
  v = J(vsBot(), { pairRanked24h: 99, winnerWins24h: 99, oneWay30d: { aOverB: 9, bOverA: 0 }, cpuLoser24h: { losses: 99, distinctWinnerGroups: 1 } }, CFG);
  ok(v.ranked && v.flags.length === 0, 'R14 bot: no pair / daily / feeder caps apply');
  v = J(vsBot({}, { established: false })); ok(v.ranked, 'R14 bot: R11c does not apply to Matt');
  v = J(human({}, { swingBad: true })); ok(v.ranked && has(v, 'swing_implausible') && v.seats[0].bests && !v.seats[0].swing && v.seats[1].swing, 'R15 swingBad: result and rally best kept, hit/speed dropped for that seat');
  v = J(human({}, { teleport: true })); ok(!v.ranked && has(v, 'paddle_teleport') && rec(v) === '-- RB', 'R18 teleporting WINNER: win unranked, no bests; the loss counts (R18 withholds only its own seat\'s bests)');
  v = J(human({}, {}, { teleport: true })); ok(v.ranked && rec(v) === 'RB R-', 'R18 teleporting LOSER: its loss counts, the winner ranked');
  v = J(vsBot({}, { teleport: true })); ok(!v.ranked && rec(v) === '-- --', 'R18 teleporting win over Matt: unranked');
  v = J(human({}, { teleport: true }), {}, abuse.config({ STATS_TELEPORT_MS: '0' })); ok(v.ranked, 'STATS_TELEPORT_MS=0 disables R18 (tests)');
  v = J(human({ revived: true, secs: 10 }, {}, { groups: new Set(['g1']) }), { pairRanked24h: 5, winnerWins24h: 40 });
  ok(has(v, 'revived', 'too_fast', 'same_computer', 'pair_cap', 'daily_cap') && !v.ranked, 'several flags at once: every failing id is collected');
  // why (8.3): a human match never names the opponent's network
  const allowed = new Set(['self', 'not_counted', 'restart', 'too_short']);
  const hv = [human({}, {}, { groups: new Set(['g1']) }), human(), human({}, {}, { established: false }), human({ secs: 1 }), human({ revived: true }), human({}, {}, { cids: new Set(['cid1']) })];
  const hh = [{}, { cpuPair24h: 3 }, {}, {}, {}, {}];
  let clean = true; hv.forEach((f, k) => { const verdict = J(f, hh[k]); for (const i of [0, 1]) for (const w of abuse.why(verdict, f, i)) if (!allowed.has(w)) clean = false; });
  ok(clean, 'why: human reasons only self / not_counted / restart / too_short');
  ok(eq(abuse.why(J(human({}, {}, { groups: new Set(['g1']) })), human(), 1), ['not_counted']) && eq(abuse.why(J(human({}, {}, { cids: new Set(['cid1']) })), human(), 0), ['self']), 'why: same_computer -> not_counted, same_cid -> self');
  // titles (R16)
  const L0 = abuse.createLinks({ now: () => T0 });
  const m = (n, o = {}) => ({ ident: { devHash: dev(n) }, computers: ['8.8.0.' + n], rankedWins: 0, ...o });
  const champ = m(1, { rankedWins: 1 });
  ok(abuse.titleCounts([champ, m(2), m(3)], champ, L0, CFG).ok, 'R16: 3 distinct people and a ranked win -> title');
  ok(!abuse.titleCounts([champ, m(2), m(3, { computers: ['8.8.0.2'] })], champ, L0, CFG).ok, 'R16: two members on one computer -> 2 people, no title');
  ok(!abuse.titleCounts([champ, m(2), m(3, { ident: { devHash: dev(2) } })], champ, L0, CFG).ok, 'R16: two members with one device -> no title');
  const c0 = m(1); ok(!abuse.titleCounts([c0, m(2), m(3)], c0, L0, CFG).ok, 'R16: no ranked human win -> no title');
  const c1 = m(1, { rankedWins: 1, identChanged: true }); ok(!abuse.titleCounts([c1, m(2), m(3)], c1, L0, CFG).ok, 'R16: an identity-changed champion -> no title');
}

// ======================================================================= abuse: link map (5.4, 5.5)
console.log('abuse: link map');
{
  let clock = T0; const logs = [];
  const L = abuse.createLinks({ now: () => clock, log: s => logs.push(s) });
  const meet = (a, b) => { const ga = L.groups(a), gb = L.groups(b); return [...ga].some(x => gb.has(x)); };
  ok(!meet(['1.2.3.4'], ['2001:db8:1:2::5']), 'unrelated keys are separate groups');
  L.see({ devHash: dev(1) }, '1.2.3.4'); L.see({ devHash: dev(1) }, '2001:db8:1:2::5');
  ok(meet(['1.2.3.4'], ['2001:db8:1:2::77']), 'one device hash on an IPv4 key and an IPv6 /64 -> one group');
  L.see({ cid: 'tab-7' }, '5.5.5.5'); L.see({ cid: 'tab-7' }, '6.6.6.6');   // home, then the same tab on a VPN
  ok(meet(['6.6.6.6'], ['5.5.5.5']), 'a seat that hopped to a VPN keeping its cid: {vpn} meets {home} -> R5');
  const f = human({}, { groups: L.groups(['6.6.6.6']) }, { groups: L.groups(['5.5.5.5']) }); ok(has(J(f), 'same_computer'), '... and judge flags same_computer');
  ok(!JSON.stringify([...L.groups(['5.5.5.5'])]).includes('5.5.5.5'), 'group roots are hashes, never the address');
  // salt rotation: links made 23 h in keep working after the salt changes at 24 h
  clock = T0 + 23 * HOUR; L.see({ devHash: dev(2) }, '7.7.7.7'); L.see({ devHash: dev(2) }, '8.8.8.8');
  clock = T0 + 25 * HOUR; L.prune();
  ok(meet(['7.7.7.7'], ['8.8.8.8']), 'salt rotation keeps the previous day linked');
  L.see({ devHash: dev(9) }, '7.7.7.7'); L.see({ devHash: dev(9) }, '9.9.9.9');
  ok(meet(['8.8.8.8'], ['9.9.9.9']), 'a link made after rotation joins one made before it');
  clock = T0 + 48 * HOUR; L.prune();
  ok(!meet(['7.7.7.7'], ['8.8.8.8']) && !meet(['1.2.3.4'], ['2001:db8:1:2::5']), 'entries expire at 24 h');
  // computer-keyed history: a feeder that mints a new device id every match from one IP
  clock = T0 + 50 * HOUR;
  for (let k = 0; k < 3; k++) { L.see({ devHash: dev('feed' + k) }, '66.1.1.1'); L.result(['55.1.1.1'], ['66.1.1.1'], true); }
  ok(L.pair(['55.1.1.1'], ['66.1.1.1']) === 3 && L.pair(['66.1.1.1'], ['55.1.1.1']) === 3, 'pair count by computer catches rotating device ids (either direction)');
  ok(has(J(human(), { cpuPair24h: L.pair(['55.1.1.1'], ['66.1.1.1']) }), 'pair_cap'), '... which is R10');
  for (let k = 0; k < 3; k++) L.result(['55.1.1.1'], ['66.1.1.1'], false);
  const lo = L.loser(['66.1.1.1']); ok(lo.losses === 6 && lo.distinctWinnerGroups === 1, 'loser(): 6 losses (ranked or not) to 1 winner group');
  ok(has(J(human(), { cpuLoser24h: lo }), 'feeder'), '... which is R11 by computer');
  ok(L.pair(['55.1.1.1'], ['77.1.1.1']) === 0, 'an unrelated pair counts 0');
  // new-guest cap (5.5)
  for (let k = 0; k < 30; k++) L.guestAdd(['44.4.4.4']);
  ok(!L.guestOk(['44.4.4.4'], CFG) && L.guestOk(['45.4.4.4'], CFG), 'NEW_GUEST_DAY: 30 guests on one computer, the 31st refused; another computer fine');
  L.guestOk(['44.4.4.4'], CFG); ok(logs.length === 1 && logs[0] === 'stats: new guest cap reached', 'the cap logs once an hour, no values');
  const hc = abuse.config({ NEW_GUEST_HOUR: '31' }); L.guestAdd(['46.4.4.4']); ok(!L.guestOk(['47.4.4.4'], hc), 'NEW_GUEST_HOUR caps all computers together');
  clock += 25 * HOUR; L.prune(); ok(L.guestOk(['44.4.4.4'], CFG), 'the guest cap resets after 24 h');
  // the 50 000 cap evicts the oldest
  const C = abuse.createLinks({ now: () => clock, maxEntries: 50000 });
  C.see({ devHash: dev('old') }, '11.0.0.1'); C.see({ devHash: dev('old') }, '11.0.0.2');
  const cm = (a, b) => { const ga = C.groups([a]), gb = C.groups([b]); return [...ga].some(x => gb.has(x)); };
  ok(cm('11.0.0.1', '11.0.0.2'), 'before the flood the two keys are linked');
  for (let k = 0; k < 50000; k++) C.see({ cid: 'c' + k }, '12.' + (k >> 16 & 255) + '.' + (k >> 8 & 255) + '.' + (k & 255));
  ok(C.size().links <= 50000 && !cm('11.0.0.1', '11.0.0.2'), 'the 50 000 cap evicts the oldest entries first (' + C.size().links + ')');
}

// ======================================================================= db (2, 5.5, 10.5, 10.6)
console.log('db');
ok(db.ok() === false && db.ownerForDevice(dev(1), T0, { create: true }) === null && db.recordMatch({}) === null && db.mergeDevice(dev(1), 1, T0) === 'none', 'not open: every call is a no-op, nothing throws');
ok(quiet(() => db.open('/nonexistent/dir/x.db')) === false && !db.ok(), 'open on a missing directory -> false');
ok(quiet(() => db.open(new URL('../web/stats.db', import.meta.url).pathname)) === false && !fs.existsSync(new URL('../web/stats.db', import.meta.url)), 'a path under web/ is refused');
const fresh = (env = {}) => { const keep = {}; for (const k in env) { keep[k] = process.env[k]; process.env[k] = env[k]; } const r = db.open(':memory:'); for (const k in env) { if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k]; } return r; };
const P = o => db.profileOf(o);
const H = (o = {}) => ({ now: T0, kind: 'human', winner: 0, ending: 'won', score: [11, 7], secs: 300, ranked: true, flags: [], ...o });
const S2 = (a, b, ra = true, rb = true) => [{ owner: a, record: ra, bests: ra }, { owner: b, record: rb, bests: rb }];
{
  ok(fresh() && db.ok(), 'open(:memory:)');
  const out = {};
  ok(db.ownerForDevice(dev(1), T0, { create: false }) === null && db.counts().owners === 0 && db.counts().devices === 0, 'ownerForDevice(create:false) creates nothing');
  const g1 = db.ownerForDevice(dev(1), T0, { create: true, out });
  ok(g1 > 0 && out.created === true && db.counts().owners === 1 && db.counts().devices === 1 && db.counts().profile === 1, 'create:true makes device + owner + profile, out.created');
  const out2 = {}; ok(db.ownerForDevice(dev(1), T0 + 1, { create: true, out: out2 }) === g1 && !out2.created && db.counts().owners === 1, 'a second call returns the same owner, creates nothing');
  ok(db.guestOwner(dev(1)) === g1 && db.guestOwner(dev(99)) === null && db.ownerForDevice(Buffer.alloc(5), T0, { create: true }) === null && db.ownerForDevice(dev(3), NaN, { create: true }) === null, 'guestOwner; a bad hash or clock creates nothing');
  // human results: ranked vs unranked, streaks
  const g2 = db.ownerForDevice(dev(2), T0, { create: true });
  let r = db.recordMatch(H({ seats: S2(g1, g2) }));
  ok(r && r.logged && r.seats[0].saved && r.seats[0].guest && r.seats[0].streak === 1 && r.seats[1].streak === 0, 'recordMatch human ranked: summaries');
  let a = P(g1), b = P(g2);
  ok(a.played === 1 && a.human.wins === 1 && a.human.losses === 0 && a.human.streak === 1 && a.human.bestStreak === 1 && a.human.pointsWon === 11 && a.human.pointsLost === 7, 'winner: played, W, streak, points');
  ok(b.played === 1 && b.human.losses === 1 && b.human.streak === 0 && b.human.pointsWon === 7 && b.human.pointsLost === 11, 'loser: played, L, points');
  db.recordMatch(H({ now: T0 + 1000, seats: S2(g1, g2) }));
  db.recordMatch(H({ now: T0 + 2000, ranked: false, flags: ['pair_cap'], seats: S2(g1, g2, false, false) }));
  a = P(g1); b = P(g2);
  ok(a.played === 3 && a.human.wins === 2 && a.human.streak === 2 && a.human.pointsWon === 22 && b.human.losses === 2, 'an unranked result: played+1 only, no W/L, points or streak change');
  db.recordMatch(H({ now: T0 + 3000, winner: 1, score: [8, 11], seats: S2(g1, g2) }));
  a = P(g1); ok(a.human.streak === 0 && a.human.bestStreak === 2 && a.human.losses === 1, 'a ranked loss resets the streak, best kept');
  ok(db.recentPairs(g1, g2, T0 - DAY) === 3 && db.recentPairs(g2, g1, T0 - DAY) === 3, 'recentPairs: ranked results only, either way');
  ok(eq(db.oneWay(g1, g2, T0 - DAY), { aOverB: 2, bOverA: 1 }) && db.recentWins(g1, T0 - DAY) === 2, 'oneWay and recentWins count ranked wins');
  const rl = db.recentLosses(g2, T0 - DAY); ok(rl.losses === 3 && rl.wins === 1 && rl.topTwoShare === 1, 'recentLosses counts ALL human results, ranked or not');
  // one person in both seats (R6)
  const same = db.recordMatch(H({ now: T0 + 4000, ranked: false, seats: S2(g1, g1, false, false) })); ok(same && P(g1).played === 5, 'one owner in both seats plays one match, not two');
  // bot levels
  const g3 = db.ownerForDevice(dev(3), T0, { create: true });
  const B = (o = {}) => ({ now: T0, kind: 'bot', level: 2, winner: 0, ending: 'won', score: [11, 4], secs: 300, ranked: true, flags: [], seats: [{ owner: g3, record: true, bests: true, bestRally: 9, bestHit: 81, bestSpeed: 22.5 }, null], ...o });
  r = db.recordMatch(B()); ok(r.seats[0].first && r.seats[0].streak === 1 && r.seats[0].bests.length === 3, 'first Pro win: first=true, three bests');
  r = db.recordMatch(B({ now: T0 + 1, score: [11, 9] })); ok(!r.seats[0].first && r.seats[0].streak === 2, 'second win: not first, streak 2');
  let pro = P(g3).matt[3]; ok(pro.wins === 2 && pro.firstWinAt === T0 && pro.bestMargin === 7 && pro.bestStreak === 2 && P(g3).human.wins === 0, 'bot_record: wins, first_win_at, best margin; human W/L untouched');
  db.recordMatch(B({ now: T0 + 2, winner: 1, score: [3, 11] })); db.recordMatch(B({ now: T0 + 3, winner: null, ending: 'left', score: [2, 5] })); db.recordMatch(B({ now: T0 + 4, winner: null, ending: 'dropped', score: [1, 1] }));
  pro = P(g3).matt[3]; ok(pro.losses === 2 && pro.abandons === 1 && pro.streak === 0 && pro.bestStreak === 2, "loss and 'left' are losses, 'dropped' an abandon; each resets the streak");
  db.recordMatch(B({ now: T0 + 5, level: undefined, levelRank: 2 })); ok(P(g3).matt[2].level === 3 && P(g3).matt[2].name === 'Tour' && P(g3).matt[2].wins === 1 && P(g3).matt[3].wins === 2, 'levelRank 2 is Tour (wire 3), never Pro');
  ok(eq(P(g3).matt.map(x => x.name), ['Rookie', 'Club', 'Tour', 'Pro']) && !('tourMatt' in P(g3)), 'matt: four rungs in difficulty order, Tour a rung like the others (no tourMatt)');
  db.recordMatch(B({ now: T0 + 6, level: 0, seats: [{ owner: g3, record: false, bests: false, bestRally: 50 }, null] }));
  ok(P(g3).matt[0].wins === 0 && P(g3).played === 7 && P(g3).bests.rally.v === 9, 'record:false: played only, no bot row change, no bests');
  db.recordMatch(B({ now: T0 + 7, seats: [{ owner: g3, record: true, bests: true, swingBad: true, bestRally: 12, bestHit: 99, bestSpeed: 34 }, null] }));
  let bb = P(g3).bests; ok(bb.rally.v === 12 && bb.hit.v === 81 && bb.speed.v === 22.5, 'swingBad keeps the rally best, drops hit and speed');
  // rally bests: a revived bot match with a 20-ball rally saves no best (judge bests:false is the only switch)
  const fr = vsBot({ revived: true }, { owner: g3 }), vr = abuse.judge(fr, {}, CFG);
  db.recordMatch(B({ now: T0 + 8, ranked: vr.ranked, flags: vr.flags, seats: [{ owner: g3, record: vr.seats[0].record, bests: vr.seats[0].bests, bestRally: 20, bestHit: 100, bestSpeed: 30 }, null] }));
  bb = P(g3).bests; ok(bb.rally.v === 12 && bb.hit.v === 81 && P(g3).matt[3].wins === 3, 'revived bot match with a 20-ball rally: no best, no win (judge -> db)');
  // owners missing
  const g4 = db.ownerForDevice(dev(4), T0, { create: true }); db.deleteOwner(g4, T0);
  const before = db.counts().match_log; r = db.recordMatch(H({ now: T0 + 9, seats: S2(g1, g4) }));
  ok(r && r.seats[0].saved && !r.seats[1].saved && db.counts().match_log === before + 1 && db.ok(), "one seat's owner deleted: the other seat is written, no FOREIGN KEY failure");
  r = db.recordMatch(H({ now: T0 + 10, seats: S2(null, 999999) })); ok(r && !r.logged && db.counts().match_log === before + 1, 'no owners -> no match_log row');
  ok(db.recordMatch(H({ flags: ["x'); DROP TABLE owners;--"], seats: S2(g1, g2) })) === null && db.counts().owners > 0, 'flags outside [a-z0-9_,] are refused');
  ok(db.recordMatch({ ...H({ seats: S2(g1, g2) }), __proto__: { ranked: true }, kind: 'nope' }) === null, 'a bad kind is refused');
  // established (R11c)
  const g5 = db.ownerForDevice(dev(5), T0, { create: true });
  db.recordMatch(B({ now: T0 + HOUR, seats: [{ owner: g5, record: true }, null] }));
  ok(!db.established(g5, T0 + HOUR), 'created 1 h ago with 1 match: not established');
  db.recordMatch(B({ now: T0 + HOUR + 1, seats: [{ owner: g5, record: true }, null] })); db.recordMatch(B({ now: T0 + HOUR + 2, seats: [{ owner: g5, record: true }, null] }));
  ok(db.established(g5, T0 + HOUR + 3) && db.established(g2, T0 + DAY), 'established at 3 matches, or at 24 h');
  // R11 together with R10, from the database
  const w = db.ownerForDevice(dev(6), T0 - 2 * DAY, { create: true }), l = db.ownerForDevice(dev(7), T0 - 2 * DAY, { create: true });
  for (let k = 0; k < 6; k++) db.recordMatch(H({ now: T0 + k, ranked: k < 3, flags: k < 3 ? [] : ['pair_cap'], seats: S2(w, l, k < 3, k < 3) }));
  const hist = { pairRanked24h: db.recentPairs(w, l, T0 + 10 - DAY), loserHuman7d: db.recentLosses(l, T0 + 10 - 7 * DAY), oneWay30d: db.oneWay(w, l, T0 + 10 - 30 * DAY), winnerWins24h: db.recentWins(w, T0 + 10 - DAY) };
  const vf = abuse.judge(human({}, { owner: w }, { owner: l }), hist, CFG);
  ok(hist.pairRanked24h === 3 && hist.loserHuman7d.losses === 6 && has(vf, 'pair_cap', 'feeder'), 'a loser with 3 ranked + 3 pair-capped losses to one winner in 7 days -> feeder alongside pair_cap');
  for (let k = 0; k < 2; k++) db.recordMatch(H({ now: T0 - 5 * DAY + k, seats: S2(w, l) }));
  ok(has(abuse.judge(human(), { oneWay30d: db.oneWay(w, l, T0 - 30 * DAY) }, CFG), 'one_way'), 'R11b from the database after 5 one-way ranked wins in 30 days');
  // accounts, merge (2.4)
  const acct = db.createAccount('sub-A', T0); ok(acct && acct.id > 0 && acct.owner_id > 0 && db.createAccount('sub-A', T0).id === acct.id && db.accountBySub('sub-A').id === acct.id, 'createAccount, idempotent per sub');
  const nDev = db.counts().devices;
  ok(db.mergeDevice(dev('never'), acct.id, T0) === 'none' && db.counts().devices === nDev, 'merge with an unknown device -> none, no row');
  // give the account its own profile first, so the fold rules can be seen
  const ao = acct.owner_id;
  db.recordMatch(H({ now: T0 + 20, seats: S2(ao, g2) })); db.recordMatch(B({ now: T0 + 21, seats: [{ owner: ao, record: true, bests: true, bestRally: 30, bestHit: 50, bestSpeed: 10 }, null] }));
  const G = P(g3), A = P(ao), logG = db.recentLosses(g2, 0);
  ok(db.mergeDevice(dev(3), acct.id, T0 + 100) === 'merged', 'a guest device folds into the account -> merged');
  const M = P(ao);
  ok(M.played === A.played + G.played && M.human.wins === A.human.wins + G.human.wins && M.human.streak === A.human.streak, 'fold: played and W add, h_streak keeps the account\'s');
  ok(M.bests.rally.v === 30 && M.bests.hit.v === 81 && M.bests.speed.v === 22.5 && M.bests.hit.at === G.bests.hit.at, 'fold: bests take the max with their time');
  ok(M.matt[3].wins === A.matt[3].wins + G.matt[3].wins && M.matt[3].streak === A.matt[3].streak && M.matt[3].firstWinAt === T0 && M.matt[3].bestMargin === 7 && M.matt[3].bestStreak === 2, 'fold per level: wins add, streak keeps the account\'s, first_win_at the earlier, best margin/streak max');
  ok(P(g3) === null && db.guestOwner(dev(3)) === null && db.accountByDevice(dev(3)) === acct.id && db.ownerForDevice(dev(3), T0 + 101, { create: true }) === ao, 'after the merge: guest gone, the device follows the account');
  ok(eq(db.recentLosses(g2, 0), logG) && db.oneWay(ao, g2, 0).aOverB >= 1, 'match_log rows naming the guest now name the account');
  ok(db.mergeDevice(dev(3), acct.id, T0 + 102) === 'none', 'a device already merged into THIS account -> none');
  const acct2 = db.createAccount('sub-B', T0);
  ok(db.mergeDevice(dev(3), acct2.id, T0 + 103) === 'none' && db.accountByDevice(dev(3)) === acct.id, 'merged into a DIFFERENT account -> none, account_id untouched');
  // sessions (3.3)
  const ev = {}; const t1 = db.session.create(acct.id, T0, ev);
  ok(/^[A-Za-z0-9_-]{43}$/.test(t1) && eq(ev.evicted, []), 'session.create: a 43-char token');
  const lk = db.session.lookup(t1, T0 + 1); ok(lk && lk.accountId === acct.id && lk.ownerId === ao && lk.tokenHash.length === 32, 'session.lookup');
  ok(db.session.lookup(t1, T0 + 180 * DAY) === null && db.session.lookup(t1, T0 + 180 * DAY - 1) !== null, 'absolute 180-day expiry');
  ok(db.session.lookup('x'.repeat(43), T0) === null && db.session.lookup(t1 + 'a', T0) === null, 'unknown or malformed tokens -> null');
  const toks = [t1]; let evicted = [];
  for (let k = 1; k <= 10; k++) { const o = {}; toks.push(db.session.create(acct.id, T0 + k, o)); evicted = evicted.concat(o.evicted); }
  ok(db.session.lookup(toks[0], T0 + 20) === null && db.session.lookup(toks[1], T0 + 20) !== null && evicted.length === 1 && evicted[0].equals(auth.tokenHash(t1)), 'the 11th session evicts the oldest (and reports its hash)');
  ok(db.session.revoke(toks[5]) && db.session.lookup(toks[5], T0 + 20) === null && !db.session.revoke(toks[5]), 'session.revoke');
  ok(db.session.revokeAll(acct.id) === 9 && db.session.lookup(toks[10], T0 + 20) === null, 'session.revokeAll');
  // usernames (7.4)
  const acct3 = db.createAccount('sub-C', T0);
  ok(db.claimUsername(acct.id, 'Daniel', U.skeleton('Daniel'), T0) === 'ok' && db.accountById(acct.id).username === 'Daniel', 'first claim ok');
  ok(db.claimUsername(acct2.id, 'Danie1', U.skeleton('Danie1'), T0) === 'taken', 'a look-alike of a taken name -> taken');
  ok(db.claimUsername(acct.id, 'Dan2', U.skeleton('Dan2'), T0 + DAY) === 'cooldown', 'rename inside 30 days -> cooldown');
  ok(db.claimUsername(acct.id, 'Dan2', U.skeleton('Dan2'), T0 + 30 * DAY) === 'ok', 'rename after 30 days -> ok');
  ok(db.claimUsername(acct2.id, 'Daniel', U.skeleton('Daniel'), T0 + 31 * DAY) === 'held', 'the old name is held for 30 days');
  ok(db.claimUsername(acct2.id, 'Daniel', U.skeleton('Daniel'), T0 + 61 * DAY) === 'ok', '... and free after the hold');
  ok(db.claimUsername(acct3.id, 'Dan2', U.skeleton('Dan2'), T0 + 61 * DAY) === 'taken' && db.claimUsername(acct3.id, 'Dan2', 'dan2', NaN) === null, 'two claims of one key: one ok, the other taken; a bad clock -> null');
  ok(db.claimUsername(acct3.id, 'Daniel', 'zzzunique', T0 + 61 * DAY) === 'taken' && db.ok(), "a UNIQUE clash on accounts.username (name taken, key free) -> 'taken', ok() stays true");
  // deletion (10.6)
  const nLog = db.counts().match_log;
  ok(db.deleteOwner(acct2.owner_id, T0 + 62 * DAY) && db.accountBySub('sub-B') === null && db.counts().match_log === nLog, 'deleteOwner: account gone, match_log rows kept');
  ok(db.claimUsername(acct3.id, 'Daniel', U.skeleton('Daniel'), T0 + 63 * DAY) === 'held' && db.claimUsername(acct3.id, 'Daniel', U.skeleton('Daniel'), T0 + 153 * DAY) === 'ok', "a deleted account's name is held 90 days");
  db.session.create(acct.id, T0 + 70 * DAY); const devs0 = db.counts().devices;
  ok(db.deleteOwner(ao, T0 + 70 * DAY) && db.counts().sessions === 0 && db.counts().devices === devs0 - 1 && db.accountByDevice(dev(3)) === null, 'account deletion cascades to sessions and merged device rows');
  const ex = db.exportOf(g1, T0 + 100); ok(ex && ex.format === 'poddle-export-1' && ex.kind === 'guest' && ex.matches.length > 0 && !JSON.stringify(ex).includes('owner'), 'exportOf a guest: no opponent identity');
  ok(ex.matches.every(x => Number.isInteger(x.secs)) && db.exportOf(g1, T0 + 100 * DAY).matches.length === ex.matches.length, 'the export lists each match\'s length (secs), and every row still stored, whatever its age');
  db.close();
}
{ // merge rows 3 and 4 (MERGE_MAX, DEVICES_MAX), each on a fresh database with small caps
  fresh({ MERGE_MAX: '1' });
  const a = db.createAccount('s1', T0);
  db.ownerForDevice(dev(1), T0, { create: true }); db.ownerForDevice(dev(2), T0, { create: true });
  ok(db.mergeDevice(dev(1), a.id, T0) === 'merged', 'MERGE_MAX 1: the first device merges');
  const g2 = db.guestOwner(dev(2));
  ok(db.mergeDevice(dev(2), a.id, T0) === 'none' && P(g2) !== null && db.guestOwner(dev(2)) === g2 && db.accountByDevice(dev(2)) === null, 'merges >= MERGE_MAX -> none: the guest profile stays a guest, nothing is deleted');
  db.close();
  fresh({ DEVICES_MAX: '2' });
  const b = db.createAccount('s2', T0);
  for (const n of [1, 2, 3]) db.ownerForDevice(dev(n), T0, { create: true });
  db.mergeDevice(dev(1), b.id, T0); db.mergeDevice(dev(2), b.id, T0);
  ok(db.mergeDevice(dev(3), b.id, T0) === 'none' && db.guestOwner(dev(3)) !== null && db.deviceCount(b.id) === 2, 'DEVICES_MAX reached -> none, the guest profile stays a guest');
  db.close();
  fresh();
  const c = db.createAccount('s3', T0);
  for (let n = 0; n < 51; n++) db.ownerForDevice(dev('m' + n), T0, { create: true });
  const res = []; for (let n = 0; n < 51; n++) res.push(db.mergeDevice(dev('m' + n), c.id, T0));
  ok(res.filter(x => x === 'merged').length === 10 && res.slice(10).every(x => x === 'none') && db.deviceCount(c.id) === 10, 'default caps: 10 merged, then none (the guest profiles stay guests)');
  db.close();
}
{ // LOG_CAP_DAY and leaving Matt: match_log rows per owner are bounded (a loop of short matches must not fill the size cap)
  fresh({ LOG_CAP_DAY: '5' });
  const g = db.ownerForDevice(dev('cap'), T0, { create: true }), h = db.ownerForDevice(dev('cap2'), T0, { create: true });
  const B = (o, t, ending = 'won', winner = 0) => db.recordMatch({ now: t, kind: 'bot', level: 0, winner, ending, score: [2, 0], secs: 10, ranked: true, flags: [], seats: [{ owner: o, record: true, bests: true }, null] });
  const n0 = db.counts().match_log;
  for (let k = 0; k < 4; k++) B(g, T0 + k, k % 2 ? 'dropped' : 'left', null);
  ok(db.counts().match_log === n0 && P(g).matt[0].losses === 2 && P(g).matt[0].abandons === 2 && P(g).played === 4, 'leaving Matt: a loss or an abandon in bot_record, no match_log row');
  for (let k = 0; k < 8; k++) B(g, T0 + 10 + k);
  ok(db.counts().match_log === n0 + 5 && P(g).matt[0].wins === 8, 'LOG_CAP_DAY 5: no 6th row that day, the bot result still counts');
  const r = db.recordMatch(H({ now: T0 + 30, seats: S2(g, h) }));
  ok(r && r.capped && !r.row && P(g).human.wins === 0 && P(h).human.losses === 0 && P(g).played === 13, 'past the cap a human result has no row and changes no record (R10-R12 read the log)');
  ok(B(g, T0 + DAY + 20).row === true, 'a day later rows are written again');
  db.close();
}
{ // sweep (10.5), on memory
  fresh();
  const at = (n, t, played) => { const o = db.ownerForDevice(dev(n), t, { create: true }); for (let k = 0; k < played; k++) db.recordMatch({ now: t, kind: 'bot', level: 0, winner: 0, ending: 'won', score: [2, 0], secs: 10, ranked: true, flags: [], seats: [{ owner: o, record: true }, null] }); return o; };
  const NOW = T0 + 400 * DAY;
  const g91 = at(1, NOW - 91 * DAY, 2), g89 = at(2, NOW - 89 * DAY, 2), one8 = at(3, NOW - 8 * DAY, 1), one6 = at(4, NOW - 6 * DAY, 1);
  const recent = at(5, NOW - DAY, 2);
  const oldLog = db.counts().match_log;
  const acc = db.createAccount('idle', NOW - 25 * 30 * DAY); db.claimUsername(acc.id, 'Idler', 'idler', NOW - 25 * 30 * DAY);
  const acc2 = db.createAccount('busy', NOW - 23 * 30 * DAY);
  const tok = db.session.create(acc2.id, NOW - 181 * DAY);
  const n = await quietAsync(() => db.sweep(NOW));
  ok(n && P(g91) === null && P(g89) !== null, 'sweep: a guest at 91 days deleted, 89 kept');
  ok(P(one8) === null && P(one6) !== null && P(recent) !== null, 'sweep: a one-match guest at 8 days deleted, 6 kept');
  ok(db.counts().match_log < oldLog && db.exportOf(recent, NOW).matches.length === 2, 'sweep: match_log older than 30 days deleted, recent kept');
  ok(db.accountBySub('idle') === null && db.accountBySub('busy') !== null, 'sweep: an account idle 25 months deleted, 23 months kept');
  ok(db.session.lookup(tok, NOW) === null && db.counts().sessions === 0, 'sweep: an expired session deleted');
  const acc3 = db.createAccount('c', NOW); ok(db.claimUsername(acc3.id, 'Idler', 'idler', NOW) === 'held', "the idle account's name is held");
  await quietAsync(() => db.sweep(NOW + 91 * DAY)); ok(db.counts().name_holds === 0 && db.claimUsername(acc3.id, 'Idler', 'idler', NOW + 91 * DAY) === 'ok', 'sweep: expired holds deleted');
  db.close();
}
{ // file database: secure_delete, hashes only, the size cap
  const f = path.join(tmp, 'a.db');
  ok(db.open(f), 'open a file database');
  const SUB = 'ZqXdistinctGoogleSubject0123456789';
  const acc = db.createAccount(SUB, T0), raw = db.session.create(acc.id, T0);
  db.recordMatch({ now: T0, kind: 'bot', level: 2, winner: 0, ending: 'won', score: [11, 3], secs: 300, ranked: true, flags: [], seats: [{ owner: acc.owner_id, record: true }, null] });
  const g = db.ownerForDevice(dev('file'), T0, { create: true });
  const bytes = () => Buffer.concat([f, f + '-wal'].filter(p => fs.existsSync(p)).map(p => fs.readFileSync(p)));
  let all = bytes();
  ok(all.includes(Buffer.from(SUB)) && !all.includes(Buffer.from(raw)) && all.includes(auth.tokenHash(raw)), 'the raw session token is never in the file bytes, only its hash');
  ok(!all.includes(Buffer.from(crypto.createHash('sha256').update('device-file').digest('hex'))), 'no device hash spelled as hex text');
  ok(db.deleteOwner(acc.owner_id, T0 + 1), 'deleteOwner on a file database');
  all = bytes(); ok(!all.includes(Buffer.from(SUB)) && !all.includes(auth.tokenHash(raw)), 'after deleteOwner + checkpoint, the deleted sub and token hash are absent from .db and -wal bytes (secure_delete)');
  ok(P(g) !== null, 'other rows survive');
  fs.writeFileSync(path.join(tmp, 'backup-x.db'), 'x'); fs.writeFileSync(path.join(tmp, 'keep.db'), 'k');
  // sweep on a file database also removes /tmp/poddle-backup-*.db older than a day (11.6): never run it where the operator has one
  if (fs.readdirSync('/tmp').some(n => n.startsWith('poddle-backup-'))) console.log('  skip sweep of backup files: a /tmp/poddle-backup-* exists on this machine');
  else {
    const sw = await quietAsync(() => db.sweep(Date.now() + 1000));   // the real clock: the files' mtimes are real
    ok(sw && !fs.existsSync(path.join(tmp, 'backup-x.db')) && fs.existsSync(path.join(tmp, 'keep.db')) && fs.existsSync(f), 'sweep removes backup-*.db beside the database, keeps other files');
  }
  db.close();
}
{ // the size cap (2.1, 11.4), on memory: sweep there never scans the real /tmp for backups
  ok(fresh({ DB_MAX_MB: '1', LOG_CAP_DAY: '100000' }), 'open with DB_MAX_MB=1 (and no per-owner log cap: the trim is what is tested)');
  let owners = 0, refused = false;
  for (let k = 0; k < 20000; k++) { const o = db.ownerForDevice(dev('fill' + k), T0, { create: true }); if (o === null) { refused = true; break; } owners++; }
  ok(refused && db.ok() && db.nearFull(), 'near the cap, new guest owners are refused while ok() stays true (' + owners + ' made)');
  const keep = db.guestOwner(dev('fill0'));
  let saved = 0; const errs = [], e0 = console.error; console.error = (...a) => errs.push(a.join(' '));
  for (let k = 0; k < 20000; k++) { const r = db.recordMatch({ now: T0 + k, kind: 'bot', level: 0, winner: 0, ending: 'won', score: [11, 0], secs: 300, ranked: true, flags: ['level_changed'], seats: [{ owner: keep, record: true }, null] }); if (r && r.seats[0].saved) saved++; }
  console.error = e0;
  ok(saved === 20000 && db.ok() && !errs.length, 'near the cap matches keep saving for everyone: the oldest log rows go first, in their own transaction (' + saved + ' saved, ' + db.counts().match_log + ' rows kept' + errs.join('|') + ')');
  let full = false, threw = false; console.error = (...a) => errs.push(a.join(' '));
  (() => { try { for (let k = 0; k < 100000; k++) if (db.createAccount('fullsub' + k, T0) === null) { full = true; break; } } catch { threw = true; } })(); console.error = e0;
  ok(full && !threw && !db.ok() && db.isOpen(), 'at max_page_count a write fails with SQLITE_FULL: null returned, ok() false (still open), nothing thrown');
  ok(errs.length >= 1 && errs.every(x => /^stats: database write failed \([A-Z_]+\)$/.test(x)), 'the failure is logged as a code only, no values (' + errs.join(' | ') + ')');
  ok(db.profileOf(keep) !== null && db.deleteOwner(keep, T0 + 5) && db.profileOf(keep) === null && db.ok(), 'a full database still reads and deletes (a delete frees pages), and the delete makes ok() true again');
  await quietAsync(() => db.sweep(T0 + 40 * DAY));
  ok(db.recordMatch({ now: T0 + 40 * DAY, kind: 'bot', level: 0, winner: 0, ending: 'won', score: [11, 0], secs: 300, ranked: true, flags: [], seats: [{ owner: keep, record: true }, null] }) !== null && db.ok(), 'after sweep frees space, writes succeed and ok() is true again');
  db.close();
}

// ======================================================================= stats.js (4.1-4.8): no database, no server
console.log('stats');
{
  const stats = require('../server/stats.js');
  const S = () => stats.seatAcc({ cid: 'c1', sockIdent: null });
  let s = S(); stats.swingBest(s, 0.9, 50, 'airpod'); ok(s.swingBad && s.bestSpeed === 0 && s.bestHit === 90, `swingBest: pk 50 (over ${stats.SPEED_BAD}) -> swing_implausible, no speed; the hit still counts in the match`);
  s = S(); stats.swingBest(s, 0.5, 46, 'phone'); ok(!s.swingBad && s.bestSpeed === stats.SPEED_CAP, `pk 46 -> kept at the cap ${stats.SPEED_CAP} (Q3: the recordings peak at 44.1 rad/s)`);
  s = S(); stats.swingBest(s, 0.5, 38, 'airpod'); ok(!s.swingBad && s.bestSpeed === 38, 'pk 38 (under the observed maximum) -> 38 as it is');
  s = S(); stats.swingBest(s, 0.5, null, 'airpod'); stats.swingBest(s, 0.5, 30, null); ok(!s.swingBad && s.bestSpeed === 0 && s.bestHit === 50, 'pk null or no source -> no speed for that swing');
  s = S(); stats.swingBest(s, 0.9, 8, 'phone'); ok(s.swingBad, 'a settled smash (n 0.9) with pk 8 -> swing_implausible');
  s = S(); stats.swingBest(s, 1.7, 20, 'airpod'); ok(s.bestHit === 100, 'hit is clamped to 0..100');
  const bet = () => ({ at: 10, n: 0.3, statted: false });
  ok(!stats.fixRecords(bet(), 0.3, 1.0, false, 10.1, 0.35), 'fix path: contact on a soft bet (0.3), then a settled 1.0 that re-aims nothing -> NOT recorded');
  ok(stats.fixRecords(bet(), 0.3, 0.42, false, 10.1, 0.35), 'a settled report within 0.15 of the bet, inside the window -> recorded');
  ok(!stats.fixRecords(bet(), 0.3, 0.42, false, 10.5, 0.35), '...but not after the window');
  ok(stats.fixRecords(bet(), 0.3, 1.0, true, 10.1, 0.35), 'a settled report that re-aimed the ball -> recorded at the fix\'s power');
  ok(!stats.fixRecords({ ...bet(), statted: true }, 0.3, 0.3, true, 10.1, 0.35), 'statted: a second settled report never counts twice');
  // a match: identity freeze-or-compare, contacts, rallies, level, teleport
  const devA = dev('sa'), devB = dev('sb'), ws = (d, extra = {}) => ({ devHash: d, computer: '1.2.3.4', cid: 'cidA', ...extra });
  const pa = { cid: 'cidA' }, pb = { bot: true };
  stats.identify(null, pa, ws(null));                                                       // seated before the hello (anonymous)
  const m = stats.newMatch({ rank: 0, seats: [pa, pb] }), a = m.seats[0];
  ok(a.ident === null && m.seats[1].bot === true && a.computers.has('1.2.3.4'), 'newMatch: an anonymous seat has no frozen identity yet; Matt is a bot seat');
  stats.identify(m, pa, ws(devA)); ok(a.ident && a.ident.devHash.equals(devA) && !a.identChanged && !a.pendingAnon, 'a late hello freezes the identity');
  stats.identify(m, pa, ws(null)); ok(a.pendingAnon && a.ident.devHash.equals(devA), 'a reconnect before its hello: pendingAnon, the frozen identity untouched');
  stats.identify(m, pa, ws(devA)); ok(!a.pendingAnon && !a.identChanged, '...cleared by the same device saying hello');
  stats.identify(m, pa, ws(devB, { computer: '5.6.7.8' })); ok(a.identChanged && a.ident.devHash.equals(devA) && a.computers.has('5.6.7.8'), 'another device: identChanged (never cleared), the frozen one kept, the new computer remembered');
  stats.launched(m); ok(m.t0 > 0 && m.rally === 1, 'launched: the first strike sets t0');
  stats.contact(m, pa, { n: 0.5, sure: true, pk: 20, src: 'airpod' }); stats.contact(m, pa, { held: true }); stats.launched(m); stats.launched(m);
  stats.pointEnd(m); ok(a.contacts === 1 && a.held === 1 && a.bestRally === 3 && a.bestHit === 50 && a.bestSpeed === 20, 'contacts, held blocks and a 3-ball rally best');
  stats.rallyReset(m); stats.launched(m); stats.launched(m); stats.launched(m); stats.launched(m); stats.contact(m, pa, { held: true }); stats.pointEnd(m);
  ok(a.bestRally === 3, 'a rally won by parking the paddle (no real contact in it) is not a best');
  stats.level(m, 3); stats.level(m, 1); ok(m.levelChanged && m.rank === 0, 'a level change after the first strike: flagged, recorded at the easiest used');
  const m2 = stats.newMatch({ rank: 0, seats: [pa, pb] }); stats.level(m2, 3); ok(!m2.levelChanged && m2.rank === 3, 'before the first strike a change is free');
  for (const x of [0, 3.5, -3.5]) stats.sample(m2, pa, x, 1, true);
  ok(m2.seats[0].teleport, 'two teleports in a row while the ball is live -> teleport');
  const m3 = stats.newMatch({ rank: 0, seats: [pa, pb] }); for (const x of [0, 3.5, 3.4]) stats.sample(m3, pa, x, 1, true);
  ok(!m3.seats[0].teleport, 'one fast sample alone -> no flag');
  const r = stats.onEnd(m3, { now: Date.now(), kind: 'bot', winner: 1, ending: 'won', score: [0, 2] });
  ok(r && m3.done && r.msgs[0] && r.msgs[0].saved === false && r.msgs[1] === null && stats.onEnd(m3, { kind: 'bot', winner: 1, ending: 'won', score: [0, 2] }) === null, 'onEnd with no database open: saved:false, Matt gets no message, and it runs once only');
  stats.forget({ devHash: devA, deleted: true }); ok(m.seats[0].gone && !m2.seats[0].gone && m2.seats[0].ident.devHash.equals(devB), 'forget (deletion): a live seat frozen on that device is gone; a newer match seeded from the socket\'s current device is not');
  const m5 = stats.newMatch({ rank: 0, seats: [pa, pb] }); stats.identify(m5, pa, ws(devA)); stats.optOut(m5, pa, ws(devA, { statsOff: true }));
  ok(m5.seats[0].ident && m5.seats[0].gone && pa.sockIdent.anon && stats.identOf({ acct: { accountId: 7, ownerId: 9 }, tokenHash: null, statsOff: true }).anon, 'optOut (Save my stats off): the seat under way is gone (no owner), and the socket is anonymous even when signed in');
  for (const x of [m, m2, m5]) stats.drop(x);
}

console.log(fails ? fails + ' FAILURES' : 'ACCOUNTS UNIT PASSED'); process.exit(fails ? 1 : 0);
