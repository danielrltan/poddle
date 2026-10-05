// One person, one court (NOTES 214): a second tab of the same browser (the same device id in its hello) may not join, watch, quick-play, create
// or start a tournament while the first tab is on a court or in a tournament; it is told joinfail 'self'. Another browser (another device id)
// is another person. The same tab coming back (its cid) still takes its seat over. The first tab leaving frees the person.   SELFTAB_PORT=<port> moves the server.
// The second server (PORT + 1) has sign-in (a local 'Google', as test/auth.test.mjs): two tabs of one account are one person, and a tab that signs
// out and reconnects (its device id rotated, its account gone) is still that person for KIN_MS (game.js kin, stats.forget).
import { spawn } from 'child_process';
import WebSocket from 'ws';
import http from 'http'; import fs from 'fs'; import os from 'os'; import path from 'path'; import crypto from 'crypto';
const PORT = +process.env.SELFTAB_PORT || 8365, P_IN = PORT + 1, root = new URL('..', import.meta.url).pathname;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'poddle-')), JWKS = path.join(tmp, 'jwks.json'), CLIENT = 'test-client.apps.googleusercontent.com', SES = '__Host-poddle_s', NON = '__Host-poddle_n';
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
fs.writeFileSync(JWKS, JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'test-kid-1', alg: 'RS256', use: 'sig' }] }));
const proc = spawn('node', ['server/game.js'], { cwd: root, env: { ...process.env, PORT }, stdio: 'ignore' });
const proc2 = spawn('node', ['server/game.js'], { cwd: root, env: { ...process.env, NODE_ENV: '', FLY_APP_NAME: '', PORT: P_IN, PODDLE_DB: path.join(tmp, 'a.db'), GOOGLE_CLIENT_ID: CLIENT, GOOGLE_JWKS_FILE: JWKS, COOKIE_SECURE: '1' }, stdio: 'ignore' });
process.on('exit', () => { proc.kill(); proc2.kill(); fs.rmSync(tmp, { recursive: true, force: true }); });
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (f, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (f()) return true; await wait(20); } return !!f(); };
let fails = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
const DEV_A = '0123456789abcdef0123456789abcdef', DEV_B = 'fedcba9876543210fedcba9876543210';      // two browsers' device ids (16 random bytes in hex)
function client(cid, dev, extra = '', { port = PORT, cookie = null } = {}) {
  const ws = new WebSocket(`ws://localhost:${port}/?lobby=1&cid=${cid}${extra}`, { headers: { 'fly-client-ip': '198.51.100.7', origin: `http://localhost:${port}`, ...(cookie ? { cookie } : {}) } }), c = { ws, log: [] };
  ws.on('message', raw => { const m = JSON.parse(raw); if (m.type !== 'state') c.log.push(m); if (m.type === 'room') c.room = m; }); ws.on('error', () => {});
  c.send = o => ws.send(JSON.stringify(o)); c.fails = () => c.log.filter(m => m.type === 'joinfail'); c.last = () => c.log.at(-1);
  return new Promise(r => ws.on('open', () => { if (dev) c.send({ type: 'hello', dev, v: 1 }); r(c); }));      // the hello first, as web/profile.js opened() sends it
}
await wait(700);
const a1 = await client('a1', DEV_A), a2 = await client('a2', DEV_A), b1 = await client('b1', DEV_B);      // a1, a2: two tabs of browser A; b1: browser B
a1.send({ type: 'create', public: true, name: 'Ann' }); await until(() => a1.room);
ok(a1.room?.role === 'player', 'tab 1 of browser A sits on a new court');
const code = a1.room.code;
for (const [what, m] of [['join its own court', { type: 'join', code }], ['watch its own court', { type: 'watch', code }], ['quick play', { type: 'quick' }], ['create a court', { type: 'create', public: false }], ['make a tournament', { type: 'tcreate' }]]) {
  const n = a2.fails().length; a2.send({ ...m, name: 'Ann2' }); await until(() => a2.fails().length > n);
  ok(a2.fails().at(-1)?.reason === 'self' && !a2.room, `tab 2 of browser A may not ${what}: joinfail self (${a2.last()?.type} ${a2.last()?.reason || ''})`);
}
b1.send({ type: 'join', code, name: 'Ben' }); await until(() => b1.room);
ok(b1.room?.role === 'player' && b1.room.code === code, 'browser B joins the same court: another device id is another person');
const b2 = await client('b2', DEV_B); { const n = b2.fails().length; b2.send({ type: 'watch', code, name: 'Ben2' }); await until(() => b2.fails().length > n); ok(b2.fails().at(-1)?.reason === 'self', 'a second tab of browser B may not watch the court either'); }
const b2x = await client('b2', DEV_B);      // the same cid again (a reload of that tab), b1 still on the court
await wait(100); { const n = b2x.fails().length; b2x.send({ type: 'watch', code, name: 'Ben2' }); await until(() => b2x.fails().length > n); ok(b2x.fails().at(-1)?.reason === 'self', 'and not after a reload of that tab'); }
const a1x = await client('a1', DEV_A); a1x.send({ type: 'join', code, name: 'Ann' }); await until(() => a1x.room);      // tab 1 of browser A reconnects with its cid (a reload) and asks for its court: its seat, never 'self'
ok(a1x.room?.role === 'player' && a1x.room.code === code, 'the same tab coming back (its cid) takes its seat over, as before');
a1x.send({ type: 'leave' }); await wait(300);
a2.send({ type: 'watch', code, name: 'Ann2' }); await until(() => a2.room);
ok(a2.room?.role === 'spectator' && a2.room.code === code, 'once tab 1 has left the court, tab 2 may watch it');
// a crafted socket URL (room= at connect, as a reconnect sends) from a second tab of browser A: the URL is acted on before the hello, so the
// court lets it in for a moment (an account would link at connect); its hello then links it to a1 and the server puts it back in the lobby
const a3 = await client('a3', null, `&room=${code}`); await until(() => a3.room);
ok(['player', 'spectator'].includes(a3.room?.role) && a3.room.code === code, `a crafted room= URL gets a second tab of browser A onto its own court before its hello (${a3.room?.role})`);
{ const n = a3.fails().length; a3.send({ type: 'hello', dev: DEV_A, v: 1 }); await until(() => a3.fails().length > n);
  ok(a3.fails().at(-1)?.reason === 'self' && a3.log.some(m => m.type === 'lobby'), 'its hello links it to tab 1: joinfail self and back in the lobby'); }
// a tournament counts as being somewhere too: tab 1 of browser B (b1 is on the court) ... use a fresh browser D: tab 1 makes a tournament, tab 2 may not join a court
const d1 = await client('d1', 'dddddddddddddddddddddddddddddddd'), d2 = await client('d2', 'dddddddddddddddddddddddddddddddd');
d1.send({ type: 'tcreate', name: 'Dee' }); await until(() => d1.log.some(m => m.type === 'tour'));
{ const n = d2.fails().length; d2.send({ type: 'join', code, name: 'Dee2' }); await until(() => d2.fails().length > n); ok(d2.fails().at(-1)?.reason === 'self', 'tab 1 of browser D is in a tournament it made: tab 2 may not join a court (joinfail self)'); }
const c1 = await client('c1', null), c2 = await client('c2', null);      // no device id (never seated, or not hosted): nothing links the tabs; the server cannot tell, and does not guess
c1.send({ type: 'create', public: false, name: 'Cal' }); await until(() => c1.room);
c2.send({ type: 'watch', code: c1.room.code, name: 'Cal2' }); await until(() => c2.room);
ok(c2.room?.role === 'spectator', 'with no device id on either socket nothing is linked (an address is a household, NOTES 153)');

// ---- signed in (the second server) ----
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
function token({ sub, nonce }) { const t = Math.floor(Date.now() / 1000), h = b64({ alg: 'RS256', kid: 'test-kid-1', typ: 'JWT' }), p = b64({ iss: 'https://accounts.google.com', aud: CLIENT, azp: CLIENT, sub, nonce, iat: t, exp: t + 600, email: 'x@example.com', email_verified: true, name: 'T', picture: 'https://example.com/p.png' }); return h + '.' + p + '.' + crypto.sign('RSA-SHA256', Buffer.from(h + '.' + p), privateKey).toString('base64url'); }
function api(method, p, body, cookie) { return new Promise(res => { const data = body === undefined ? null : JSON.stringify(body), headers = { origin: `http://localhost:${P_IN}`, 'fly-client-ip': '198.51.100.7' }; if (data != null) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); } if (cookie) headers.cookie = cookie;
  const rq = http.request({ host: '127.0.0.1', port: P_IN, method, path: p, headers }, r => { let t = ''; r.on('data', d => t += d); r.on('end', () => { let j = null; try { j = JSON.parse(t); } catch { /* not json */ } res({ status: r.statusCode, headers: r.headers, json: j }); }); }); rq.on('error', e => res({ status: 0, error: e.code })); if (data != null) rq.write(data); rq.end(); }); }
const cookieOf = (r, name) => { const c = [].concat(r.headers['set-cookie'] || []).find(x => x.startsWith(name + '=')); return c ? c.slice(name.length + 1).split(';')[0] : null; };
const n = await api('GET', '/api/signin/nonce'), nonce = n.json?.nonce;
const si = await api('POST', '/api/signin', { credential: token({ sub: 'sub-selftab', nonce }), dev: DEV_A }, `${NON}=${cookieOf(n, NON)}`), cookie = `${SES}=${cookieOf(si, SES)}`;
ok(si.status === 200 && cookieOf(si, SES), `signed in on the second server (${si.status})`);
const s1 = await client('s1', DEV_A, '', { port: P_IN, cookie }), s2 = await client('s2', 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', '', { port: P_IN, cookie });      // the same account on two devices (a laptop and a phone's home, say)
s1.send({ type: 'create', public: false, name: 'Sam' }); await until(() => s1.room); const sc = s1.room?.code;
{ const k = s2.fails().length; s2.send({ type: 'watch', code: sc, name: 'Sam' }); await until(() => s2.fails().length > k); ok(s2.fails().at(-1)?.reason === 'self', 'the same account on another device may not watch its own court: joinfail self'); }
const so = await api('POST', '/api/signout', {}, cookie); await wait(200);      // tab 2 signs out: its account leaves every socket of the session (stats.forget), and the browser rotates its device id (profile.js forgetDevice) before it redials
ok(so.status === 200 || so.status === 204, `signed out (${so.status})`);
const s2x = await client('s2', 'ffffffffffffffffffffffffffffffff', '', { port: P_IN });      // tab 2 back: the same cid, a new device id, no cookie
{ const k = s2x.fails().length; s2x.send({ type: 'join', code: sc, name: 'Sam2' }); await until(() => s2x.fails().length > k); ok(s2x.fails().at(-1)?.reason === 'self' && !s2x.room, 'signed out and back with a new device id, tab 2 is still that person (kin): joinfail self'); }
const s3 = await client('s3', 'abababababababababababababababab', '', { port: P_IN }); s3.send({ type: 'join', code: sc, name: 'Stranger' }); await until(() => s3.room);
ok(s3.room?.role === 'player', 'a stranger on the same address joins: kin links tabs, never addresses');
console.log(fails ? `SELFTAB FAIL (${fails})` : 'SELFTAB PASS'); process.exit(fails ? 1 : 0);
