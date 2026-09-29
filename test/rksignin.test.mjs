// Ranked is for signed-in players with a username (NOTES 133): a real server with the gate on (no RK_GUESTS), accounts and sessions written
// into its database first (as test/auth.test.mjs does). A guest is refused ('signin'), an account without a username too ('username'); a username
// claimed through /api/username counts on the SAME socket; a signed-in player with a username queues; signing out while queued ends the entry;
// /api/me says rkSignin; production ignores the RK_GUESTS test knob. Ports RKS_PORT (default 8480) and +1. Last line: PASS or FAIL n.
import { createRequire } from 'module';
import { spawn } from 'child_process';
import fs from 'fs'; import os from 'os'; import path from 'path'; import crypto from 'crypto';
import WebSocket from 'ws';
const require = createRequire(import.meta.url), root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
let fails = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
const PORT = +process.env.RKS_PORT || 8480, P_PROD = PORT + 1, FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'poddle-rks-')), 'k.db');
const wait = ms => new Promise(r => setTimeout(r, ms));
const db = require('../server/db.js'), quiet = console.error; console.error = () => {};
db.open(FILE); const now = Date.now();
const named = db.createAccount('sub-named', now); db.claimUsername(named.id, 'Ranky', require('../server/usernames.js').skeleton('Ranky'), now);
const bare = db.createAccount('sub-bare', now);
const RAW = { named: db.session.create(named.id, now), bare: db.session.create(bare.id, now) }; db.close(); console.error = quiet;
const procs = [];
const up = (port, env) => new Promise(res => { const p = spawn('node', ['server/game.js'], { cwd: root, env: { ...process.env, PORT: port, PODDLE_DB: FILE, GOOGLE_CLIENT_ID: 'test.apps.googleusercontent.com', RK_ARRIVE_S: '30', ...env }, stdio: ['ignore', 'pipe', 'ignore'] }); procs.push(p); p.stdout.on('data', d => { if (/game server on port/.test(String(d))) res(p); }); });
function tab(port, who) {
  const headers = { origin: `http://localhost:${port}` }; if (who) headers.cookie = `poddle_s=${RAW[who]}`;
  const ws = new WebSocket(`ws://localhost:${port}/?lobby=1&cid=${crypto.randomUUID().slice(0, 12)}`, { headers }), t = { ws, log: [] };
  ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', dev: crypto.randomUUID(), v: 1 })));
  ws.on('message', raw => t.log.push(JSON.parse(raw)));
  t.send = m => ws.send(JSON.stringify(m)); t.last = type => [...t.log].reverse().find(m => m.type === type) || null;
  t.opened = new Promise(r => ws.on('open', r)); return t;
}
const until = async (f, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (f()) return true; await wait(50); } return false; };
const api = (port, method, p, body, who) => fetch(`http://localhost:${port}${p}`, { method, headers: { origin: `http://localhost:${port}`, 'content-type': 'application/json', ...(who ? { cookie: `poddle_s=${RAW[who]}` } : {}) }, body: body ? JSON.stringify(body) : undefined }).then(async r => ({ status: r.status, j: await r.json().catch(() => null) }));

await up(PORT, {});
console.log('the gate');
{ const me = await api(PORT, 'GET', '/api/me'); ok(me.j && me.j.rkSignin === true, `/api/me says Ranked needs a sign-in (rkSignin ${me.j && me.j.rkSignin})`); }
const g = tab(PORT, null); await g.opened; await wait(200); g.send({ type: 'rk', name: 'Guest' });
ok(await until(() => g.last('rkfail')), 'a guest asks for Ranked'); ok(g.last('rkfail') && g.last('rkfail').why === 'signin' && !g.log.some(m => m.type === 'rk' && m.phase === 'queue'), `and is refused: ${JSON.stringify(g.last('rkfail'))}, never queued`);
const b = tab(PORT, 'bare'); await b.opened; await wait(200); b.send({ type: 'rk', name: 'Bare' });
ok(await until(() => b.last('rkfail')) && b.last('rkfail').why === 'username', `an account without a username is refused: ${JSON.stringify(b.last('rkfail'))}`);
{ const r = await api(PORT, 'POST', '/api/username', { username: 'Barely' }, 'bare'); ok(r.status === 200, `it claims Barely through /api/username (${r.status})`); }
await wait(2200); b.send({ type: 'rk', name: 'Bare' });      // RK_COOL_S is not involved (it never queued); the claim counts on the SAME socket
ok(await until(() => b.log.some(m => m.type === 'rk' && m.phase === 'queue')), 'and then queues on the same socket, no reload');
const n = tab(PORT, 'named'); await n.opened; await wait(200); n.send({ type: 'rk', name: 'Ranky' });
ok(await until(() => n.log.some(m => m.type === 'rk' && (m.phase === 'queue' || m.phase === 'vs'))), 'a signed-in player with a username queues');
console.log('signing out while queued');
{ const before = b.log.length; const r = await api(PORT, 'POST', '/api/signout', {}, 'bare'); ok(r.status === 204, `Barely signs out in another tab (${r.status})`);
  ok(await until(() => b.log.slice(before).some(m => m.type === 'rkfail' && m.why === 'signin'), 5000), 'its queued socket is told rkfail signin within a few seconds');
  const q = JSON.parse(JSON.stringify(b.log.slice(before))); ok(!q.some(m => m.type === 'rkvs'), 'and was never paired after signing out'); }
for (const t of [g, b, n]) t.ws.close();
console.log('production');
await up(P_PROD, { NODE_ENV: 'production', RK_GUESTS: '1' });
{ const me = await api(P_PROD, 'GET', '/api/me'); ok(me.j && me.j.rkSignin === true, 'production ignores RK_GUESTS=1: /api/me still says rkSignin'); }
const pg = tab(P_PROD, null); await pg.opened; await wait(200); pg.send({ type: 'rk', name: 'Guest' });
ok(await until(() => pg.last('rkfail')) && pg.last('rkfail').why === 'signin', `and still refuses a guest: ${JSON.stringify(pg.last('rkfail'))}`);
pg.ws.close();
for (const p of procs) p.kill();
console.log(fails ? `FAIL ${fails}` : 'PASS'); process.exit(fails ? 1 : 0);
