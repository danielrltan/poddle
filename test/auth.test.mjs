// Google sign-in, sessions, usernames and the hosted-mode guards end to end (docs/ACCOUNTS.md 12.3). No request ever reaches Google on
// 9410/9411: the ID tokens are signed here with a local RSA key whose JWKS the server reads from GOOGLE_JWKS_FILE (a test-only knob).
// 9412 runs NODE_ENV=production, which ignores that file: its verifier goes to Google's real key set, which test/no-network.cjs (preloaded
// into that server only) refuses and logs, so the test runs offline and proves production never trusts the file or a local token.
//   node test/auth.test.mjs        AUTH_PORT=<base> moves the servers (base .. +3; default 9410-9413). Takes about 2 minutes.
// Knobs beyond 12.3 (reported): TIMESCALE 2 and STATS_ESTABLISHED 0 as in test/stats.test.mjs. 9413's session is written into its
// database file by this test through server/db.js before that server starts (it has no sign-in to make one with).
import { spawn } from 'child_process';
import { createRequire } from 'module';
import WebSocket from 'ws';
import http from 'http';
import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
const require = createRequire(import.meta.url);
const PORT = +process.env.AUTH_PORT || 9410, P_OFF = PORT + 1, P_PROD = PORT + 2, P_HOST = PORT + 3, root = new URL('..', import.meta.url).pathname;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'poddle-')), DBB = path.join(tmp, 'b.db'), DBC = path.join(tmp, 'c.db'), JWKS = path.join(tmp, 'jwks.json');
const CLIENT = 'test-client.apps.googleusercontent.com', EMAIL = 'secret.tester.' + crypto.randomBytes(4).toString('hex') + '@example.com';
const STATS = { WIN_AT: '2', REMATCH_S: '4', HOLD_S: '3', STATS_MIN_POINT_S: '0', STATS_AFK_MIN: '0', STATS_FORFEIT_MIN: '1', STATS_ESTABLISHED: '0', TIMESCALE: '2' };
const SES = '__Host-poddle_s', NON = '__Host-poddle_n';
const procs = new Set(), logs = [];
function up(port, env) {
  return new Promise(res => { const p = spawn('node', ['server/game.js'], { cwd: root, env: { ...process.env, NODE_ENV: '', FLY_APP_NAME: '', GOOGLE_CLIENT_ID: '', GOOGLE_JWKS_FILE: '', PORT: port, ...env } }); procs.add(p); const mine = { p, out: '' }; logs.push(mine);
    const eat = d => { mine.out += d; if (/game server on port/.test(d)) res(p); }; p.stdout.on('data', eat); p.stderr.on('data', eat); p.on('exit', () => procs.delete(p)); });
}
process.on('exit', () => { for (const p of procs) p.kill(); fs.rmSync(tmp, { recursive: true, force: true }); });
process.on('unhandledRejection', e => { console.error(e); process.exit(1); });
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (f, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (f()) return true; await wait(25); } return !!f(); };
let fails = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
let ipn = 0; const ip = () => `198.51.100.${++ipn}`;                // TEST-NET-2: a fresh computer (and fresh rate-limit buckets) per step
let cn = 0; const cidN = () => 'atc' + (++cn) + 'x' + crypto.randomBytes(3).toString('hex');
const dev = () => crypto.randomUUID();

// ---- a local "Google": an RSA key, its JWKS on disk, and ID tokens signed with it ----
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
fs.writeFileSync(JWKS, JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'test-kid-1', alg: 'RS256', use: 'sig' }] }));
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
function token({ sub, nonce, aud = CLIENT, exp, iss = 'https://accounts.google.com' }) {
  const t = Math.floor(Date.now() / 1000), h = b64({ alg: 'RS256', kid: 'test-kid-1', typ: 'JWT' });
  const p = b64({ iss, aud, azp: aud, sub, nonce, iat: t, exp: exp ?? t + 600, email: EMAIL, email_verified: true, name: 'Secret Tester', picture: 'https://example.com/p.png' });
  return h + '.' + p + '.' + crypto.sign('RSA-SHA256', Buffer.from(h + '.' + p), privateKey).toString('base64url');
}

// ---- HTTP ----
function api(port, method, p, body, { addr = ip(), origin = `http://localhost:${port}`, type = 'application/json', cookie, host } = {}) {
  return new Promise(res => {
    const data = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body), headers = {};
    if (data != null) { headers['content-type'] = type; headers['content-length'] = Buffer.byteLength(data); }
    if (origin) headers.origin = origin; if (addr) headers['fly-client-ip'] = addr; if (cookie) headers.cookie = cookie; if (host) headers.host = host;
    const rq = http.request({ host: '127.0.0.1', port, method, path: p, headers }, r => { let s = ''; r.on('data', d => s += d); r.on('end', () => { let j = null; try { j = JSON.parse(s); } catch { /* not json */ } res({ status: r.statusCode, headers: r.headers, body: s, json: j }); }); });
    rq.on('error', e => res({ status: 0, error: e.code })); if (data != null) rq.write(data); rq.end();
  });
}
const setCookies = r => [].concat(r.headers['set-cookie'] || []);
const cookieOf = (r, name) => { const c = setCookies(r).find(x => x.startsWith(name + '=')); return c ? c.slice(name.length + 1).split(';')[0] : null; };
// sign in as `sub`: a nonce, then the token for it. -> { r, raw, cookie } (cookie: the header to send from now on)
async function signIn(port, sub, { addr = ip(), d, cookie: had, tok } = {}) {
  const n = await api(port, 'GET', '/api/signin/nonce', undefined, { addr, origin: null }), nonce = n.json && n.json.nonce, nv = cookieOf(n, NON);
  const r = await api(port, 'POST', '/api/signin', { credential: tok ? tok(nonce) : token({ sub, nonce }), dev: d }, { addr, cookie: [nv ? `${NON}=${nv}` : null, had].filter(Boolean).join('; ') });
  const raw = cookieOf(r, SES); return { r, n, raw, cookie: raw ? `${SES}=${raw}` : null };
}
const me = (port, cookie) => api(port, 'GET', '/api/me', undefined, { cookie, origin: null });

// ---- game sockets (as test/stats.test.mjs) ----
function tab({ port = PORT, addr = ip(), d, cid = cidN(), q = 'lobby=1', origin, cookie, off } = {}) {
  const headers = { 'fly-client-ip': addr }; if (origin) headers.origin = origin; if (cookie) headers.cookie = cookie;
  const ws = new WebSocket(`ws://localhost:${port}/?${q}&cid=${cid}`, { headers }), c = { ws, cid, d, addr, log: [], side: null, play: null };
  ws.on('open', () => { if (off) ws.send(JSON.stringify({ type: 'nostats' })); if (d) ws.send(JSON.stringify({ type: 'hello', dev: d, v: 1 })); });   // off: Save my stats is off in that browser
  ws.on('message', raw => { const m = JSON.parse(raw); if (m.type === 'state') { c.st = m; if (c.play) c.play(m); return; } c.log.push(m); if (m.type === 'welcome') { c.side = m.side; c.welcome = m; } if (m.type === 'room') c.room = m; });
  ws.on('error', () => {});
  c.send = o => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
  c.got = (t, f) => c.log.filter(m => m.type === t && (!f || f(m))); c.last = t => c.got(t).pop(); c.n = t => c.got(t).length;
  return c;
}
function hit(c) { let cool = 0; c.play = m => {
  c.send({ type: 'paddle', auto: true, q: [0, 0, 0, 1] });
  const me = m.paddles[c.side], s = c.side === 0 ? 1 : -1; if (!me || Date.now() < cool) return;
  if (m.serving === c.side) { cool = Date.now() + 600; return c.send({ type: 'swing', power: 20, dir: 0.3, lob: 0, final: true }); }
  if (m.live && Math.abs(m.p[0] - me.x) < 0.9 && Math.abs(m.p[1] - me.y) < 0.8 && -(m.p[2] - me.z) * s < 1.0 && -(m.p[2] - me.z) * s > -0.5 && m.v[2] * s > 0) {
    cool = Date.now() + 400; c.send({ type: 'swing', power: 14 + Math.random() * 16, dir: (Math.random() - 0.5) * 1.6, lob: 0, final: true }); }
}; }
function lose(c) { let cool = 0; c.play = m => { c.send({ type: 'paddle', auto: true, q: [0, 0, 0, 1] });
  if (m.serving === c.side && m.reach && Date.now() > cool) { cool = Date.now() + 600; c.send({ type: 'swing', power: 30, dir: 0, lob: 0, final: true }); } }; }
async function vsMatt(o = {}, how = lose) {
  const c = tab(o); await until(() => c.n('lobby')); c.send({ type: 'create', public: false }); await until(() => c.side != null || c.n('joinfail'));
  if (c.side == null) return c;
  c.send({ type: 'bot', level: 0 }); await until(() => c.got('botinfo', i => i.active).length); if (how) how(c); return c;
}
const over = (c, k = 1, ms = 45000) => until(() => c.n('matchover') >= k, ms);
const prof = (c, k = 1) => until(() => c.n('profile') >= k, 3000).then(() => c.got('profile')[k - 1] || null);
const bye = (...cs) => cs.forEach(c => { try { c.ws.terminate(); } catch { /* gone */ } });

const U = require('../server/usernames.js'), RAWS = [];             // every session token seen (none may reach a log)
const has = (r, name, re) => setCookies(r).some(x => x.startsWith(name + '=') && re.test(x));
console.log('servers: ' + PORT + ' (sign-in on), ' + P_OFF + ' (off), ' + P_PROD + ' (production)');
await Promise.all([up(PORT, { PODDLE_DB: DBB, GOOGLE_CLIENT_ID: CLIENT, GOOGLE_JWKS_FILE: JWKS, COOKIE_SECURE: '1', RENAME_DAYS: '0', ...STATS }),
  up(P_OFF, { PODDLE_DB: path.join(tmp, 'off.db'), COOKIE_SECURE: '1', ...STATS }), up(P_PROD, { NODE_ENV: 'production', GOOGLE_CLIENT_ID: CLIENT, GOOGLE_JWKS_FILE: JWKS, NODE_OPTIONS: `--require ${root}test/no-network.cjs`, ...STATS })]);
const ORIGIN = `http://localhost:${PORT}`;

console.log('1. the nonce');
{
  const n = await api(PORT, 'GET', '/api/signin/nonce', undefined, { origin: null }), c = setCookies(n).find(x => x.startsWith(NON + '='));
  ok(n.status === 200 && /^[A-Za-z0-9_-]{22}$/.test(n.json.nonce) && cookieOf(n, NON) === n.json.nonce, 'GET /api/signin/nonce: 22 chars, and the same value in the cookie');
  ok(c && /; HttpOnly/.test(c) && /; Secure/.test(c) && /; SameSite=Strict/.test(c) && /; Path=\//.test(c) && /; Max-Age=600/.test(c) && !/domain=/i.test(c), '__Host-poddle_n: HttpOnly, Secure, SameSite=Strict, Path=/, Max-Age=600, no Domain: ' + c);
}

console.log('2. a good sign-in');
const s1 = await signIn(PORT, 'sub-one'); RAWS.push(s1.raw);
{
  const c = setCookies(s1.r).find(x => x.startsWith(SES + '='));
  ok(s1.r.status === 200 && /^[A-Za-z0-9_-]{43}$/.test(s1.raw || '') && /; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=15552000$/.test(c) && !/domain=/i.test(c), 'session cookie: __Host-poddle_s, HttpOnly, Secure, SameSite=Lax, Path=/, 180 days, no Domain: ' + c);
  ok(s1.r.json.account && s1.r.json.account.username === null && s1.r.json.merged === 'none' && s1.r.json.profile && s1.r.json.profile.guest === false && s1.r.json.profile.matt.length === 4, 'body: account with no username yet, merged none, an account profile');
  ok(has(s1.r, NON, /^__Host-poddle_n=; .*Max-Age=0/), 'the nonce cookie is cleared by the answer (single use)');
  ok(!s1.r.body.includes(s1.raw) && !s1.r.body.includes(EMAIL) && !s1.r.body.includes('sub-one'), 'the body carries no token, no e-mail, no Google subject');
  await wait(200);
  const bytes = Buffer.concat([DBB, DBB + '-wal', DBB + '-shm'].filter(f => fs.existsSync(f)).map(f => fs.readFileSync(f)));
  ok(bytes.length > 0 && !bytes.includes(s1.raw) && !bytes.includes(EMAIL) && !bytes.includes('Secret Tester'), 'neither the database file nor its -wal holds the raw token, the e-mail or the name from the token');
}

console.log('3. what sign-in refuses');
{
  const n = await api(PORT, 'GET', '/api/signin/nonce', undefined, { origin: null }), nc = `${NON}=${n.json.nonce}`, good = token({ sub: 'sub-x', nonce: n.json.nonce });
  const post = (body, o = {}) => api(PORT, 'POST', '/api/signin', body, { cookie: nc, ...o });
  ok((await post({ credential: good }, { origin: null })).status === 403, 'no Origin: 403');
  ok((await post({ credential: good }, { origin: 'https://evil.example' })).status === 403, 'a foreign Origin: 403');
  ok((await post(JSON.stringify({ credential: good }), { type: 'text/plain' })).status === 415, 'text/plain: 415');
  ok((await post({ credential: 'x'.repeat(9 * 1024) })).status === 413, 'a 9 KB body: 413');
  const mis = await post({ credential: token({ sub: 'sub-x', nonce: 'not-the-cookie-nonce-00' }) });
  ok(mis.status === 403 && mis.json.error === 'nonce' && !cookieOf(mis, SES), 'a token for another nonce: 403 nonce');
  const n1 = await api(PORT, 'GET', '/api/signin/nonce', undefined, { origin: null }), t1 = token({ sub: 'sub-replay', nonce: n1.json.nonce });
  const first = await api(PORT, 'POST', '/api/signin', { credential: t1 }, { cookie: `${NON}=${n1.json.nonce}` }); RAWS.push(cookieOf(first, SES));
  const n2 = await api(PORT, 'GET', '/api/signin/nonce', undefined, { origin: null }), again = await api(PORT, 'POST', '/api/signin', { credential: t1 }, { cookie: `${NON}=${n2.json.nonce}` });
  ok(first.status === 200 && again.status === 403 && !cookieOf(again, SES), 'the same token replayed with a new nonce cookie: 403');
  const forged = await api(PORT, 'POST', '/api/signin', { credential: t1 }, { cookie: `${NON}=${n1.json.nonce}` });
  ok(forged.status === 403 && forged.json.error === 'nonce' && !cookieOf(forged, SES), 'the same token replayed with a cookie forged from its own nonce claim: 403 (the server keeps the nonces it issued, each used once)');
  const made = 'Zz' + crypto.randomBytes(15).toString('base64url').slice(0, 20), never = await api(PORT, 'POST', '/api/signin', { credential: token({ sub: 'sub-forge', nonce: made }) }, { cookie: `${NON}=${made}` });
  ok(never.status === 403 && !cookieOf(never, SES), 'a nonce the server never issued, even with a matching cookie: 403');
  for (const [name, tok] of [['wrong aud', token({ sub: 'sub-x', nonce: n.json.nonce, aud: 'someone-else.apps.googleusercontent.com' })], ['expired', token({ sub: 'sub-x', nonce: n.json.nonce, exp: Math.floor(Date.now() / 1000) - 120 })]]) {
    const r = await post({ credential: tok }); ok(r.status === 401 && r.json.error === 'bad_token' && !cookieOf(r, SES), `${name}: 401 bad_token, no session cookie`);
  }
}

console.log('4. /api/me');
{
  const a = await me(PORT, s1.cookie), b = await me(PORT);
  ok(a.status === 200 && a.json.signin.enabled === true && a.json.signin.clientId === CLIENT && a.json.account && a.json.account.username === null && a.json.db === true, 'with the cookie: sign-in on, the client id, the account');
  ok(b.status === 200 && b.json.account === null, 'without it: account null');
}

console.log('5. usernames');
const s2 = await signIn(PORT, 'sub-two'); RAWS.push(s2.raw);
{
  const claim = (name, cookie) => api(PORT, 'POST', '/api/username', { username: name }, { cookie });
  const a = await claim('Daniel_1', s1.cookie);
  ok(a.status === 200 && a.json.username === 'Daniel_1' && a.json.renameAt > 0, 'claim Daniel_1: ok');
  ok(U.skeleton('DanieI_1') === U.skeleton('Daniel_1') && (await claim('DanieI_1', s2.cookie)).status === 409, 'the same skeleton (DanieI_1) from a second account: 409 taken');
  const r = await claim('M4tt', s2.cookie); ok(r.status === 422 && r.json.error === 'invalid' && r.json.reason === 'reserved', 'M4tt: 422 reserved');
  ok((await claim('Zed_99', s1.cookie)).status === 200 && (await me(PORT, s1.cookie)).json.account.username === 'Zed_99', 'with RENAME_DAYS=0 a rename succeeds');
  ok((await claim('Daniel_1', s2.cookie)).status === 409, 'the old name is held for 30 days: 409 for the other account');
  ok((await claim('Somebody', null)).status === 401, 'no session: 401');
}

console.log('6, 7, 8. guests merge on sign-in; sockets with the cookie; sign-out');
const [r6, r7, r8] = await Promise.all([
  (async () => {                                                  // 6: a guest's win comes along into the account
    const G = dev(), addr = ip(), g = await vsMatt({ d: G, addr }, hit); let k = 0, won = false;
    while (!won && k < 3) { k++; await over(g, k); await prof(g, k); won = g.got('matchover')[k - 1]?.winner === g.side; if (!won) g.send({ type: 'rematch', yes: true }); }
    bye(g);
    const s3 = await signIn(PORT, 'sub-three', { d: G }), s4 = await signIn(PORT, 'sub-four', { d: G }); RAWS.push(s3.raw, s4.raw);
    const guest = await api(PORT, 'POST', '/api/stats', { dev: G }, { addr });
    const three = await api(PORT, 'POST', '/api/stats', {}, { cookie: s3.cookie });
    return { won, k, s3, s4, guest, three };
  })(),
  (async () => {                                                  // 7: the cookie on a socket from an allowed page, and from a hostile one
    const w = await vsMatt({ cookie: s1.cookie, origin: ORIGIN, d: dev() }, lose); await over(w); const pw = await prof(w);
    const e = await vsMatt({ cookie: s1.cookie, origin: 'https://evil.example', d: dev() }, lose); await over(e); const pe = await prof(e);
    const st = await api(PORT, 'POST', '/api/stats', {}, { cookie: s1.cookie }); bye(w, e);
    return { w, pw, e, pe, st };
  })(),
  (async () => {                                                  // 8: sign-out, fixation, and a socket that was signed in when it happened
    const s5 = await signIn(PORT, 'sub-five'), out = await api(PORT, 'POST', '/api/signout', {}, { cookie: s5.cookie }), after = await me(PORT, s5.cookie);
    const s6 = await signIn(PORT, 'sub-six'), s6b = await signIn(PORT, 'sub-six', { cookie: s6.cookie }), m6 = await me(PORT, s6.cookie), m6b = await me(PORT, s6b.cookie);
    const s7 = await signIn(PORT, 'sub-seven'), D7 = dev(), L = await vsMatt({ cookie: s7.cookie, origin: ORIGIN, d: D7 }, lose); RAWS.push(s5.raw, s6.raw, s6b.raw, s7.raw);
    await until(() => L.n('hit') >= 1, 15000); const so = await api(PORT, 'POST', '/api/signout', {}, { cookie: s7.cookie });
    await over(L); const p1 = await prof(L); L.send({ type: 'rematch', yes: true }); await over(L, 2); const p2 = await prof(L, 2); bye(L);
    const s7b = await signIn(PORT, 'sub-seven'); RAWS.push(s7b.raw);
    const acct = await api(PORT, 'POST', '/api/stats', {}, { cookie: s7b.cookie }), guest = await api(PORT, 'POST', '/api/stats', { dev: D7 }, { addr: L.addr });
    return { out, after, m6, m6b, so, p1, p2, acct, guest };
  })(),
]);
ok(r6.won && r6.s3.r.json.merged === 'merged' && r6.s3.r.json.profile.matt[0].wins === 1 && r6.s3.r.json.profile.played === r6.k, `6: sign-in with the guest's device: merged, and the profile has the win (${r6.s3.r.json.profile && r6.s3.r.json.profile.matt[0].wins})`);
ok(r6.s4.r.json.merged === 'none' && r6.s4.r.json.profile.played === 0 && r6.three.json.profile.played === r6.k, '6: another account with the same device: none, nothing moved');
ok(r6.guest.status === 200 && r6.guest.json.profile === null, '6: the merged device id reads nothing any more (account data needs the cookie)');
ok(r7.w.welcome && r7.w.welcome.reg[r7.w.side] === true && r7.w.welcome.names[r7.w.side] === 'Zed_99', '7: cookie + allowed Origin: welcome says reg true, the username is the name on court');
ok(r7.pw && r7.pw.saved && r7.pw.guest === false && r7.st.json.profile.matt[0].losses === 1, '7: the finished match lands on the account');
ok(r7.e.welcome && r7.e.welcome.reg.every(x => !x) && r7.pe && r7.pe.saved === false, '7: cookie + Origin https://evil.example: anonymous, no reg, nothing recorded');
ok(r8.out.status === 204 && has(r8.out, SES, /^__Host-poddle_s=; .*Max-Age=0/) && r8.after.json.account === null, '8: sign-out: 204, cookie cleared, the old cookie no longer works');
ok(r8.m6.json.account === null && r8.m6b.json.account !== null, '8: a second sign-in with a session cookie present: the old token no longer works (fixation)');
ok(r8.so.status === 204 && r8.p1 && r8.p1.saved && r8.p1.guest === false && r8.acct.json.profile.matt[0].losses === 1, '8: the match under way at sign-out still records the loss on the account');
ok(r8.p2 && r8.p2.saved && r8.p2.guest === true && r8.guest.json.profile && r8.guest.json.profile.matt[0].losses === 1, '8: a match that STARTS after sign-out is a guest match');

console.log('9. deleting an account');
{
  const d = await api(PORT, 'DELETE', '/api/account', { confirm: 'delete' }, { cookie: s1.cookie });
  ok(d.status === 200 && d.json.deleted.account === true && has(d, SES, /^__Host-poddle_s=; .*Max-Age=0/) && (await me(PORT, s1.cookie)).json.account === null, 'DELETE /api/account with the cookie: 200, cookie cleared, the session is gone');
  const again = await signIn(PORT, 'sub-one'); RAWS.push(again.raw);
  ok(again.r.status === 200 && again.r.json.account.username === null && again.r.json.profile.played === 0, 'signing in with the same Google subject makes a NEW, empty account');
  ok((await api(PORT, 'POST', '/api/username', { username: 'Zed_99' }, { cookie: again.cookie })).status === 409, 'the deleted username is held: 409');
}

console.log('9b. deleting an account mid-match, from the browser whose guest profile merged into it');
{
  const D = dev(), addr = ip(), g = await vsMatt({ d: D, addr }, lose); await over(g); await prof(g); bye(g);
  const s9 = await signIn(PORT, 'sub-nine', { d: D, addr }); RAWS.push(s9.raw);
  const c = await vsMatt({ d: D, addr: ip() }, lose); await until(() => c.n('hit') >= 1, 15000);   // a guest socket: its merged device plays for the account
  const del = await api(PORT, 'DELETE', '/api/account', { dev: D, confirm: 'delete' }, { cookie: s9.cookie, addr });
  await over(c); const p = await prof(c); c.send({ type: 'rematch', yes: true }); await over(c, 2); const p2 = await prof(c, 2); bye(c);
  ok(s9.r.json.merged === 'merged' && del.status === 200 && del.json.deleted.account === true, 'the account (with the merged device) is deleted mid-match');
  ok(p && p.saved === false && p2 && p2.saved === false && (await api(PORT, 'POST', '/api/stats', { dev: D }, { addr: ip() })).json.profile === null, 'that match and the rematch save nothing: no guest profile is re-created for the device');
}

console.log('9c. Save my stats off while signed in: nothing is recorded to the account, from the first frame or mid-match');
{
  const sc = await signIn(PORT, 'sub-off'); RAWS.push(sc.raw);
  const a = await vsMatt({ cookie: sc.cookie, origin: ORIGIN, off: true }, lose); await over(a); const pa = await prof(a); bye(a);
  const b = await vsMatt({ cookie: sc.cookie, origin: ORIGIN }, lose); await until(() => b.n('hit') >= 1, 15000); b.send({ type: 'nostats' }); await over(b); const pb = await prof(b); bye(b);
  const st = await api(PORT, 'POST', '/api/stats', {}, { cookie: sc.cookie });
  ok(pa && pa.saved === false && pb && pb.saved === false && st.json.profile && st.json.profile.played === 0, `stats off on a signed-in socket (first frame, and mid-match): saved false, the account still has played 0 (${st.json.profile && st.json.profile.played})`);
  const c = await vsMatt({ cookie: sc.cookie, origin: ORIGIN }, lose); await over(c); const pc = await prof(c); bye(c);
  ok(pc && pc.saved === true && (await api(PORT, 'POST', '/api/stats', {}, { cookie: sc.cookie })).json.profile.played === 1, 'a socket without it still records to the account');
}

console.log('10, 11. rate limit, old hosts');
{
  const addr = ip(), rs = []; for (let i = 0; i < 11; i++) rs.push(await api(PORT, 'POST', '/api/signin', {}, { addr }));
  ok(rs.slice(0, 10).every(r => r.status === 400) && rs[10].status === 429 && +rs[10].headers['retry-after'] >= 1 && rs[10].json.error === 'rate', '11 sign-ins in a minute from one address: the 11th is 429 with Retry-After');
  const w = await api(PORT, 'GET', '/api/me', undefined, { host: 'www.poddleball.com', origin: null });
  ok(w.status === 404 && w.json.error === 'wrong_host' && !w.headers.location, 'Host www.poddleball.com: /api/me is 404 wrong_host, never a redirect');
}

console.log('12. sign-in off (no GOOGLE_CLIENT_ID)');
{
  const m = await me(P_OFF);
  ok(m.json.signin.enabled === false && m.json.signin.clientId === null && m.json.db === true, '/api/me: signin.enabled false');
  const rs = await Promise.all([api(P_OFF, 'GET', '/api/signin/nonce', undefined, { origin: null }), api(P_OFF, 'POST', '/api/signin', { credential: 'x' }), api(P_OFF, 'POST', '/api/signout', {}), api(P_OFF, 'POST', '/api/username', { username: 'Abc' })]);
  ok(rs.every(r => r.status === 404 && r.json.error === 'signin_off') && !rs.some(r => cookieOf(r, 'poddle_n') || cookieOf(r, NON)), 'nonce, signin, signout, username: 404 signin_off, no cookie');
  const g = await vsMatt({ port: P_OFF, d: dev() }, lose); await over(g); await prof(g);
  const x = await api(P_OFF, 'POST', '/api/export', { dev: g.d }, { addr: g.addr }); bye(g);
  ok(x.status === 200 && x.json.kind === 'guest' && x.json.matches.length === 1, 'guest export still works');
}

console.log('13, 14. production ignores the test key file; the API cannot crash the server');
{
  const prod = logs.find(l => l.p.spawnargs && l.out.includes('port ' + P_PROD));
  ok(prod && prod.out.includes('auth: GOOGLE_JWKS_FILE ignored in production'), 'NODE_ENV=production: the boot log says the key file is ignored');
  const s = await signIn(P_PROD, 'sub-prod');
  ok(s.r.status === 503 && !s.raw, `a token signed with the test key: ${s.r.status} (Google's key set unreachable offline), never 200, no cookie`);
  ok(prod.out.includes('test: blocked https://www.googleapis.com/oauth2/v3/certs'), "production asked Google's real key set, not the test key file (test/no-network.cjs refused it: no network needed)");
  const bad = await api(P_PROD, 'POST', '/api/stats', '{"dev": nope', {});
  const proto = await api(P_PROD, 'POST', '/api/stats', '{"__proto__":{"dev":"00000000000040008000000000000000"},"constructor":{"prototype":{"x":1}},"dev":{"toString":1}}', {});
  ok(bad.status === 400 && proto.status === 200 && proto.json.profile === null && ({}).x === undefined, 'invalid JSON: 400; a __proto__ / constructor body: read field by field, nothing polluted');
  await new Promise(res => { const so = net.connect(P_PROD, '127.0.0.1', () => { so.write(`POST /api/stats HTTP/1.1\r\nHost: localhost\r\nOrigin: http://localhost:${P_PROD}\r\nContent-Type: application/json\r\nContent-Length: 400\r\n\r\n{"dev":`); setTimeout(() => { so.destroy(); res(); }, 150); }); so.on('error', res); });
  const big = await api(P_PROD, 'POST', '/api/stats', JSON.stringify({ dev: 'x'.repeat(1024 * 1024) }), {});
  ok(big.status === 413 || big.status === 0, `a 1 MB body: 413 (or the connection closed): ${big.status || big.error}`);
  await wait(300);
  const st = await api(P_PROD, 'GET', '/status.json', undefined, { origin: null });
  const c = await vsMatt({ port: P_PROD, d: dev() }, lose); const played = await until(() => c.st && c.n('hit') >= 1, 15000); bye(c);
  ok(st.status === 200 && st.json && typeof st.json.courts === 'number' && played, 'afterwards /status.json answers and a socket still plays');
}

console.log('15. hosted mode (FLY_APP_NAME) on loopback');
{
  const dbm = require('../server/db.js'), quiet = console.error; console.error = () => {};
  dbm.open(DBC); const a = dbm.createAccount('sub-hosted', Date.now()), raw = dbm.session.create(a.id, Date.now()); dbm.close(); console.error = quiet; RAWS.push(raw);
  await up(P_HOST, { FLY_APP_NAME: 'poddle-test', PODDLE_DB: DBC, ADDR_ROOMS: '4', ...STATS });
  const cookie = `${SES}=${raw}`, pub = ip();
  const local = await api(P_HOST, 'POST', '/api/stats', {}, { origin: `http://localhost:${P_HOST}`, addr: pub, cookie });
  const site = await api(P_HOST, 'POST', '/api/stats', {}, { origin: 'https://poddleball.com', addr: pub, cookie });
  ok(local.status === 403 && site.status === 200 && site.json.profile && site.json.profile.guest === false, 'POST /api/stats from http://localhost: 403; from https://poddleball.com: the account');
  ok(site.headers['strict-transport-security'] === 'max-age=31536000', 'HSTS on Fly');
  const [x, y] = await Promise.all([vsMatt({ port: P_HOST, addr: ip(), origin: `http://localhost:${P_HOST}`, cookie, d: dev() }, lose), vsMatt({ port: P_HOST, addr: ip(), origin: 'https://poddleball.com', cookie, d: dev() }, lose)]);
  await Promise.all([over(x), over(y)]); const [px, py] = [await prof(x), await prof(y)]; bye(x, y);
  ok(px && px.saved === false && py && py.saved && py.guest === false, 'a socket from http://localhost with the cookie is anonymous; from https://poddleball.com it records on the account');
  const courts = async addrs => { const cs = []; for (const addr of addrs) { const c = tab({ port: P_HOST, addr }); await until(() => c.n('lobby')); c.send({ type: 'create', public: false }); await until(() => c.side != null || c.n('joinfail')); cs.push(c); } return cs; };
  const bad = await courts(['127.0.0.1', '10.0.0.1', 'garbage', '127.0.0.1', 'fe80::1']);
  ok(bad.slice(0, 4).every(c => c.side != null) && bad[4].side == null && bad[4].last('joinfail')?.reason === 'busy', 'five sockets whose fly-client-ip is loopback, private, link-local or junk share one key, none is exempt: the 5th gets busy');
  const one = ip(), pubs = await courts([one, one, one, one, one]);
  ok(pubs.slice(0, 4).every(c => c.side != null) && pubs[4].last('joinfail')?.reason === 'busy', 'five from one public address: the 5th gets busy');
  bye(...bad, ...pubs);
  const hl = logs.at(-1).out; ok((hl.match(/net: client address header rejected/g) || []).length === 1, 'the rejected header is logged once, without its value');
}

console.log('logs');
{
  const all = logs.map(l => l.out).join('\n'), leaks = [EMAIL, 'Secret Tester', ...RAWS.filter(Boolean), 'sub-one', 'sub-hosted', 'garbage', '198.51.100.'].filter(v => all.includes(v));
  ok(leaks.length === 0, 'no log line carries an e-mail, a name from a token, a session token, a Google subject or an address' + (leaks.length ? ': ' + leaks.join(', ') : ''));
}

console.log(fails ? fails + ' FAILURES' : 'AUTH TESTS PASSED');
process.exit(fails ? 1 : 0);

