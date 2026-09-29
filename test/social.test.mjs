// Friends live (docs/SOCIAL.md 4, 5, 8): a real server (the presence tick at its default 2 s) on a database seeded first, as test/rksignin.test.mjs does.
// Amy and Ben are friends, Cal is not. Signed-in lobby sockets get the 'social' snapshot after their hello (a guest never does); Amy sees Ben come online
// (menu), Ben sees Amy go menu -> matt (create + Matt) -> Ben watching her court, and off when his socket closes; Cal's add reaches Amy at once; Cal never
// hears of Amy's status; signing out (POST /api/signout) says socialoff and takes Amy offline for Ben; an account deleted from another process (admin.js)
// loses its socket's sign-in at the next tick; no id on the wire. Port SOCIAL_PORT (default 9510).
// Last line: PASS or FAIL n.
import { createRequire } from 'module';
import { spawn } from 'child_process';
import fs from 'fs'; import os from 'os'; import path from 'path'; import crypto from 'crypto';
import WebSocket from 'ws';
const require = createRequire(import.meta.url), root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
let fails = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
const PORT = +process.env.SOCIAL_PORT || 9510, DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'poddle-social-')), FILE = path.join(DIR, 's.db');
const wait = ms => new Promise(r => setTimeout(r, ms));
const db = require('../server/db.js'), U = require('../server/usernames.js'), quiet = console.error; console.error = () => {};
db.open(FILE); const now = Date.now();
const mk = (sub, name) => { const a = db.createAccount(sub, now); db.claimUsername(a.id, name, U.skeleton(name), now); return a; };
const AMY = mk('sub-amy', 'Amy'), BEN = mk('sub-ben', 'Ben'), CAL = mk('sub-cal', 'Cal');
db.friendOp(AMY.id, BEN.id, 'add', now); db.friendOp(BEN.id, AMY.id, 'accept', now);
const RAW = { amy: db.session.create(AMY.id, now), ben: db.session.create(BEN.id, now), cal: db.session.create(CAL.id, now) }; db.close(); console.error = quiet;
let proc = null;
const up = () => new Promise((res, rej) => { proc = spawn('node', ['server/game.js'], { cwd: root, env: { ...process.env, PORT, PODDLE_DB: FILE, GOOGLE_CLIENT_ID: 'test.apps.googleusercontent.com' }, stdio: ['ignore', 'pipe', 'ignore'] });
  proc.stdout.on('data', d => { if (/game server on port/.test(String(d))) res(); }); proc.on('exit', c => rej(new Error('server exited ' + c))); });
function tab(who) {
  const headers = { origin: `http://localhost:${PORT}` }; if (who) headers.cookie = `poddle_s=${RAW[who]}`;
  const ws = new WebSocket(`ws://localhost:${PORT}/?lobby=1&cid=${crypto.randomUUID().slice(0, 12)}`, { headers }), t = { ws, log: [], raw: [] };
  ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', dev: crypto.randomUUID(), v: 1 })));
  ws.on('message', raw => { t.raw.push(String(raw)); t.log.push(JSON.parse(raw)); });
  t.send = m => ws.send(JSON.stringify(m)); t.socials = () => t.log.filter(m => m.type === 'social'); t.last = type => [...t.log].reverse().find(m => m.type === type) || null;
  t.opened = new Promise(r => ws.on('open', r)); return t;
}
const until = async (f, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (f()) return true; await wait(50); } return !!f(); };
const stOf = (t, name) => { const s = t.last('social'); const f = s && s.friends.find(x => x.name === name); return f ? f.st : null; };
const post = (p, body, who) => fetch(`http://localhost:${PORT}${p}`, { method: 'POST', headers: { origin: `http://localhost:${PORT}`, 'content-type': 'application/json', cookie: `poddle_s=${RAW[who]}` }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, j: await r.json().catch(() => null) }));

const tabs = [];
try {
  await up();
  console.log('the snapshot after hello');
  const amy = tab('amy'), guest = tab(null); tabs.push(amy, guest); await amy.opened; await guest.opened;
  ok(await until(() => amy.socials().length > 0, 3000), 'Amy (signed in, a username) gets a social snapshot after her hello');
  const s0 = amy.socials()[0];
  ok(s0 && JSON.stringify(s0) === '{"type":"social","friends":[{"name":"Ben","st":"off","rank":null}],"inc":[],"out":[]}', `exactly {type, friends:[{name, st, rank}], inc, out} with Ben off (${JSON.stringify(s0)})`);
  await wait(300); ok(!guest.log.some(m => m.type === 'social'), 'a guest never gets one');
  console.log('presence');
  const ben = tab('ben'), cal = tab('cal'); tabs.push(ben, cal); await ben.opened; await cal.opened;
  ok(await until(() => stOf(amy, 'Ben') === 'menu'), `Ben comes online: Amy sees him menu within a few seconds (${stOf(amy, 'Ben')})`);
  ok(await until(() => stOf(ben, 'Amy') === 'menu', 3000), `and Ben's own snapshot has Amy menu (${stOf(ben, 'Amy')})`);
  amy.send({ type: 'create', public: false });
  ok(await until(() => amy.last('room')), 'Amy makes a private court'); const code = amy.last('room') && amy.last('room').code;
  amy.send({ type: 'bot', level: 0 });
  ok(await until(() => stOf(ben, 'Amy') === 'matt'), `Ben sees her playing Matt (${stOf(ben, 'Amy')})`);
  ben.send({ type: 'watch', code });
  ok(await until(() => ben.last('room') && ben.last('room').role === 'spectator'), 'Ben watches her court');
  ok(await until(() => stOf(amy, 'Ben') === 'watching'), `Amy sees him watching (${stOf(amy, 'Ben')})`);
  console.log('a friend change reaches the other side at once');
  const before = amy.socials().length, t0 = Date.now();
  const add = await post('/api/friends', { op: 'add', name: 'amy' }, 'cal');
  ok(add.status === 200 && add.j.r === 'requested' && add.j.snap.out[0].name === 'Amy', `Cal adds Amy over the API (${add.status} ${JSON.stringify(add.j)})`);
  ok(await until(() => amy.socials().slice(before).some(s => s.inc.some(i => i.name === 'Cal')), 1500) && Date.now() - t0 < 1500, `Amy's socket hears the request well inside a tick (${Date.now() - t0} ms)`);
  ok(await until(() => cal.socials().some(s => s.out.some(o => o.name === 'Amy')), 1500), "Cal's own socket gets the fresh snapshot too");
  ok(!cal.socials().some(s => s.friends.length), 'Cal (not a friend) never hears any status');
  console.log('off, and sign-out');
  ben.ws.close();
  ok(await until(() => stOf(amy, 'Ben') === 'off'), `Ben's tab closes: Amy sees him off (${stOf(amy, 'Ben')})`);
  const ben2 = tab('ben'); tabs.push(ben2); await ben2.opened;
  ok(await until(() => stOf(ben2, 'Amy') === 'matt', 3000), `Ben's new tab sees Amy still on her court (${stOf(ben2, 'Amy')})`);
  const out = await fetch(`http://localhost:${PORT}/api/signout`, { method: 'POST', headers: { origin: `http://localhost:${PORT}`, 'content-type': 'application/json', cookie: `poddle_s=${RAW.amy}` }, body: '{}' });
  ok(out.status === 204, `Amy signs out (${out.status})`);
  ok(await until(() => amy.log.some(m => m.type === 'socialoff'), 3000), 'her socket is told socialoff');
  ok(await until(() => stOf(ben2, 'Amy') === 'off', 3000), `Ben sees her off at once, not a tick later (${stOf(ben2, 'Amy')})`);
  const n = amy.socials().length; amy.send({ type: 'socialget' }); await wait(400); ok(amy.socials().length === n, 'a signed-out socket gets no snapshot, even asked');
  console.log('an account deleted by another process (admin.js delete-account)');
  console.error = () => {}; db.open(FILE, { busyMs: 5000 }); const gone = db.deleteOwner(CAL.owner_id, Date.now()); db.close(); console.error = quiet;
  ok(gone, 'Cal is deleted from outside the server');
  ok(await until(() => cal.log.some(m => m.type === 'socialoff'), 5000), "the presence tick finds the account gone: Cal's socket loses it (socialoff)");
  console.log('no ids on the wire');
  const all = tabs.flatMap(t => t.raw.filter(r => /"type":"social/.test(r)));
  ok(all.length > 5 && all.every(r => !/"id"|owner|account|sub"/i.test(r)), `${all.length} social frames: no id, owner or account in any`);
  ok(tabs.flatMap(t => t.socials()).every(s => Object.keys(s).join() === 'type,friends,inc,out' && s.friends.every(f => Object.keys(f).join() === 'name,st,rank')), 'every frame is {type, friends, inc, out}, every friend {name, st, rank}');
} catch (e) { ok(false, 'threw: ' + (e && e.message)); }
finally {
  for (const t of tabs) try { t.ws.close(); } catch { /* closed */ }
  if (proc) proc.kill();
  fs.rmSync(DIR, { recursive: true, force: true });
}
console.log(fails ? `FAIL ${fails}` : 'PASS'); process.exit(fails ? 1 : 0);
