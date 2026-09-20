// Rooms (docs/ROOMS.md): lobby list, create / join / quick, two matches at once that never touch, leave, reconnect by cid,
// empty rooms closing, the room cap, hostile input, the legacy socket in LOCAL, and 60 state packets a second in every one of 10 rooms.
import { spawn } from 'child_process';
import WebSocket from 'ws';
import http from 'http';
const PORT = +process.env.ROOMS_PORT || 8300, PORT2 = PORT + 1, root = new URL('..', import.meta.url).pathname;
const up = (port, env) => spawn('node', ['server/game.js'], { cwd: root, env: { ...process.env, PORT: port, ...env }, stdio: 'ignore' });
const procs = [up(PORT, {}), up(PORT2, { ROOM_CAP: '2', ROOM_TTL: '2' })];                  // the second one only for the cap and the closing of empty rooms
process.on('exit', () => procs.forEach(p => p.kill()));
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (f, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (f()) return true; await wait(20); } return !!f(); };
await wait(700);
let fails = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
const all = [];                                              // every client ever made: LOCAL must never show up in anyone's list
function client(q = 'lobby=1', port = PORT) {
  const ws = new WebSocket(`ws://localhost:${port}/?${q}`), c = { ws, log: [], n: {}, lobbies: [], closed: false, t0: Date.now() };
  ws.on('message', raw => { const m = JSON.parse(raw); c.n[m.type] = (c.n[m.type] || 0) + 1;
    if (m.type === 'state') { c.st = m; if (c.onState) c.onState(m); return; }
    c.log.push(m);
    if (m.type === 'lobby') { c.lobby = m; c.lobbies.push(m); } if (m.type === 'room') c.room = m; if (m.type === 'welcome') c.side = m.side;
    if (m.type === 'botinfo') c.info = m; if (m.type === 'joinfail') c.fail = m.reason; if (m.type === 'point') c.score = m.score; });
  ws.on('close', () => { c.closed = true; }); ws.on('error', () => {});
  c.send = o => ws.send(JSON.stringify(o)); c.types = () => c.log.map(m => m.type).join(',');
  c.listed = code => !!c.lobby && c.lobby.rooms.find(r => r.code === code);
  all.push(c); return c;
}
const inLobby = async (q, port) => { const c = client(q || 'lobby=1', port); await until(() => c.lobby); return c; };
const make = async (pub, q, port) => { const c = await inLobby(q, port); c.send({ type: 'create', public: pub }); await until(() => c.side != null || c.fail); return c; };
const joined = async (code, q, port) => { const c = await inLobby(q, port); c.send({ type: 'join', code }); await until(() => c.side != null || c.fail); return c; };
// a player who serves by swinging and hits what comes near, like test/bot.test.mjs
function play(c) { let cool = 0; c.onState = m => {
  c.send({ type: 'paddle', auto: true, q: [0, 0, 0, 1] });
  const me = m.paddles[c.side], s = c.side === 0 ? 1 : -1; if (!me || Date.now() < cool) return;
  if (m.serving === c.side) { cool = Date.now() + 600; return c.send({ type: 'swing', power: 20, dir: 0.2, lob: 0 }); }
  if (m.live && Math.abs(m.p[0] - me.x) < 0.9 && Math.abs(m.p[1] - me.y) < 0.8 && -(m.p[2] - me.z) * s < 1.0 && -(m.p[2] - me.z) * s > -0.5 && m.v[2] * s > 0) { cool = Date.now() + 400; c.send({ type: 'swing', power: 16 + Math.random() * 10, dir: (Math.random() - 0.5), lob: 0 }); }
}; }
const park = c => { c.onState = () => c.send({ type: 'paddle', x: 3.6 * (c.side === 0 ? 1 : -1), y: 0.4, q: [0, 0, 0, 1] }); };   // stands in the corner, never touches a ball

console.log('legacy socket and the lobby');
const leg = client('cid=leg1'); await until(() => leg.n.state > 5);
ok(leg.side === 0 && !leg.n.room && !leg.n.lobby && leg.n.state > 5, `no lobby=1: seated at once, welcome + state, no room or lobby message (${leg.types()})`);
const a = await inLobby('lobby=1&cid=a');
ok(a.lobby && Array.isArray(a.lobby.rooms) && a.lobby.rooms.length === 0 && a.lobby.online === 2 && a.side == null && !a.n.state, `lobby=1: a list and nothing else: ${JSON.stringify(a.lobby)}`);
a.send({ type: 'ping', c: 7 }); ok(await until(() => a.log.find(m => m.type === 'pong' && m.c === 7 && m.t > 0)), 'ping is answered in the lobby too');
a.send({ type: 'paddle', x: 1 }); a.send({ type: 'swing', power: 30 }); a.send({ type: 'bot' }); a.send({ type: 'leave' }); await wait(200);
ok(leg.info && !leg.info.reason && !leg.n.swung && a.n.lobby === 1, 'game messages from the lobby reach no room');

console.log('create');
const watcher = await inLobby();
a.send({ type: 'create', public: false }); await until(() => a.side != null);
ok(a.room && /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/.test(a.room.code) && a.room.public === false, `create private: ${JSON.stringify(a.room)}`);
ok(a.types().includes('room,welcome,botinfo') && a.side === 0, `room, then welcome straight after (${a.types()})`);
await wait(1300); ok(watcher.lobby.rooms.length === 0, 'a private room is not listed');
const b = await make(true, 'lobby=1&cid=b');
ok(b.room && b.room.public === true && await until(() => watcher.listed(b.room.code), 2500), `create public: listed ${JSON.stringify(watcher.lobby.rooms)}`);
const row = watcher.listed(b.room.code); ok(row && row.players === 1 && row.open === true, 'listed with players 1, open true');
const late = await inLobby(); ok(late.listed(b.room.code) && late.lobby.online === all.length, `someone arriving later gets the list at once, online ${late.lobby.online}`);

console.log('join by code');
const d = await joined('  ' + b.room.code.toLowerCase() + ' ', 'lobby=1&cid=d');
ok(d.room && d.room.code === b.room.code && d.side === 1, 'lower case with spaces around it finds the room, second seat');
ok(await until(() => !watcher.listed(b.room.code), 2500), 'full: no longer listed');
ok(watcher.lobbies.length <= 1 + Math.ceil((Date.now() - watcher.t0) / 1000), `list updates are rationed: ${watcher.lobbies.length} in ${((Date.now() - watcher.t0) / 1000).toFixed(1)} s`);
const e = await joined(b.room.code); ok(e.fail === 'full' && e.side == null, 'third joiner: joinfail full');
e.fail = null; e.send({ type: 'join', code: 'ZZ' }); await until(() => e.fail); ok(e.fail === 'notfound', 'unknown code: joinfail notfound');
e.fail = null; e.send({ type: 'join', code: 'local' }); await until(() => e.fail); ok(e.fail === 'notfound', 'LOCAL cannot be joined by code');
e.fail = null; e.send({ type: 'join' }); await until(() => e.fail); ok(e.fail === 'notfound', 'no code at all: notfound, server still up');
e.send({ type: 'join', code: a.room.code }); await until(() => e.side != null); ok(e.side === 1 && e.room.code === a.room.code && e.room.public === false, 'still in the lobby after a joinfail: joins the private room by its code');

console.log('quick play');
const w1 = await make(true); await wait(60); const w2 = await make(true);
const q1 = await inLobby(); q1.send({ type: 'quick' }); await until(() => q1.side != null);
ok(q1.room && q1.room.code === w1.room.code && q1.side === 1, 'quick: the public room that has waited longest');
const q2 = await inLobby(); q2.send({ type: 'quick' }); await until(() => q2.side != null); ok(q2.room.code === w2.room.code, 'next quick: the other waiting room');
const s1 = await inLobby(), s2 = await inLobby(), s3 = await inLobby();
s1.send({ type: 'quick' }); await until(() => s1.side != null); s2.send({ type: 'quick' }); await until(() => s2.side != null); s3.send({ type: 'quick' }); await until(() => s3.side != null);
ok(s1.room.public && s1.room.code === s2.room.code && s1.side !== s2.side && ![w1, w2, b, a].some(c => c.room.code === s1.room.code), 'nothing waiting: two strangers end up in the same new public room');
ok(s3.room.code !== s1.room.code && s3.room.public && s3.side === 0, 'a third gets a room of their own');
for (const c of [w1, w2, q1, q2, s1, s2, s3, late, watcher]) c.ws.close();

console.log('two matches at once');
const a1 = await make(false), a2 = await joined(a1.room.code), b1 = await make(false), b2 = await joined(b1.room.code);
ok(a1.room.code !== b1.room.code && a2.side === 1 && b2.side === 1, `rooms ${a1.room.code} and ${b1.room.code}, two humans each`);
for (const c of [a1, a2, b1, b2]) { c.hits = 0; c.ws.on('message', raw => { if (JSON.parse(raw).type === 'hit') c.hits++; }); }
let bBad = 0, bSeen = 0; b1.onState = m => { bSeen++; if (bSeen === 1) b1.send({ type: 'paddle', auto: true, q: [0, 0, 0, 1] });      // calibrated: the serve waits for that
   if (m.score[0] || m.score[1] || m.live && (m.serving !== 0 || m.p[2] < 1)) bBad++; };   // B's ball may only ever hang in front of its own server
play(a1); play(a2); park(b2);
await wait(5000);
ok(a1.hits >= 2 && a1.hits === a2.hits, `room A: served by a swing and rallied (${a1.hits} hits), score ${a1.st.score}`);
ok(b1.hits === 0 && b2.hits === 0 && bBad === 0 && b1.st.serving === 0 && !b1.n.bounce && !b1.n.swung && !b1.n.launch && !b1.n.point,
  `room B saw none of it: 0 hits, 0 swung, 0 launch, still 0-0 with its own serve hanging in every one of ${bSeen} packets`);
ok(Math.abs(a1.st.t - b1.st.t) < 0.1, `one clock for both rooms (${a1.st.t.toFixed(2)} / ${b1.st.t.toFixed(2)})`);
const aPts = () => (a1.n.point || 0), aHits = a1.hits;
b1.onState = m => { if (m.serving === 0 && !b1.served) { b1.served = true; b1.send({ type: 'swing', power: 20, dir: 0, lob: 0 }); } };
ok(await until(() => b1.n.point >= 1, 8000), `room B: served, nobody returned it, point: ${JSON.stringify(b1.score)}`);
await wait(300);                                             // let room A's next packets arrive: a leaked score would be in them
ok(b1.hits === 1 && b2.hits === 1 && b1.score[0] + b1.score[1] === 1 && b1.st.score.join() === b1.score.join(), 'room B heard exactly its own one hit and its own one point');
ok(a1.hits > aHits && (a1.st.score[0] + a1.st.score[1]) === aPts() && (a2.n.point || 0) === aPts(), `room A kept rallying meanwhile (${a1.hits} hits) and its score ${a1.st.score} is exactly its own ${aPts()} point(s)`);
ok(a1.st.p.join() !== b1.st.p.join(), `two different balls: A ${a1.st.p.map(v => v.toFixed(1))}  B ${b1.st.p.map(v => v.toFixed(1))}`);

console.log('leave');
a1.onState = null; a1.send({ type: 'leave' });
ok(await until(() => a1.lobby && a1.log[a1.log.length - 1].type === 'lobby') && a2.n.left === 1, `leaver gets a fresh lobby list, the one who stayed gets 'left'`);
const st0 = a1.n.state; await wait(300); ok(a1.n.state === st0, 'no more state for the one who left');
ok(await until(() => a2.info && a2.info.active, 4000) && a2.log.findIndex(m => m.type === 'left') < a2.log.length - 1, `then the bot comes back for them (${a2.info.name})`);
a1.side = null; a1.send({ type: 'join', code: b1.room.code }); await until(() => a1.fail); ok(a1.fail === 'full', 'and the leaver really is in the lobby again (can ask to join)');
b2.ws.close(); ok(await until(() => b1.n.left === 1), `a closed socket counts as leaving too: 'left'`);
a1.fail = null; a1.send({ type: 'join', code: b1.room.code }); await until(() => a1.side != null); ok(a1.side === 1 && a1.room.code === b1.room.code, 'the freed seat can be taken');

console.log('reconnect by cid');
const r1 = await make(false, 'lobby=1&cid=rc1'), r2 = await joined(r1.room.code, 'lobby=1&cid=rc2'), code = r1.room.code;
const r1b = client(`lobby=1&cid=rc1&room=${code.toLowerCase()}`); await until(() => r1b.side != null);
ok(r1b.room && r1b.room.code === code && r1b.side === 0 && r1b.types().startsWith('lobby,room,welcome'), `same cid + room=CODE: seat 0 back in ${code} (${r1b.types()})`);
ok(await until(() => r1.closed) && !r2.n.left, 'the old socket is dropped, the other player is not told anyone left');
const x = await joined(code); ok(x.fail === 'full', 'the room still has exactly two humans');
const bad = client('lobby=1&room=QQ'); await until(() => bad.fail); ok(bad.fail === 'notfound' && bad.lobby && bad.side == null, 'room=CODE that does not exist: joinfail, stays in the lobby');
const r1c = await make(false, 'lobby=1&cid=rc1');
ok(r1c.room.code !== code && await until(() => r2.n.left === 1 && r1b.closed), 'same cid sitting down in a different room: taken out of the old one first');

console.log('the serve waits for a player who is still calibrating');
const g1 = await make(false), g2 = await joined(g1.room.code); play(g1); await wait(2500);
ok(g1.st && !g1.st.live && g1.st.score.join() === '0,0' && g1.st.paddles[1].wait === true && !g1.st.paddles[0].wait, `no paddle message from the second human yet: no ball in 2.5 s, their paddle says wait (${JSON.stringify(g1.st.paddles[1].wait)})`);
park(g2); ok(await until(() => g1.st.live && g1.st.serving === 0 && !g1.st.paddles[1].wait, 3000), 'their first paddle message: the serve comes');

console.log('hostile input');
const nest = n => '['.repeat(n) + ']'.repeat(n), h1 = await inLobby(), h2 = await inLobby();
h1.ws.send(`{"type":"join","code":${nest(1500)}}`); h1.ws.send(`{"type":"ping","c":${nest(1500)}}`); h1.ws.send('{"type":"join","code":{"trim":1}}');
h2.ws.send(`{"type":"ping","c":${nest(100000)}}`);
const get = path => new Promise(res => { const r = http.request({ port: PORT, path }, x => { x.resume(); res(x.statusCode); }); r.on('error', () => res(0)); r.end(); });
const codes = [await get('/%00'), await get('/a%00b.js'), await get('/%E0%A4%A'), await get('/../server/game.js'), await get('/index.html')];
ok(await until(() => h1.log.filter(m => m.type === 'joinfail').length === 2 && h1.log.find(m => m.type === 'pong' && m.c === 0)), 'a nested array or an object as code: notfound. As ping c: echoed as 0');
ok(await until(() => h2.closed), 'a 200 KB message closes that socket (maxPayload)');
ok(codes.join() === '400,400,404,404,200' || codes.join() === '400,400,200,404,200', `GET /%00, /a%00b.js, bad escape, ../, index.html: ${codes}`);
const h3 = await inLobby(); ok(h3.lobby && g1.n.state > 0, 'and the server is still up');

console.log('legacy');
const leg2 = client('cid=leg2'); await until(() => leg2.side != null);
ok(leg2.side === 1 && !leg2.n.room && leg.n.state > 100, 'second socket without lobby=1 joins the first in LOCAL');
ok(all.every(c => c.lobbies.every(m => m.rooms.every(r => r.code !== 'LOCAL' && r.open === true && r.players === 1))), `LOCAL was never listed (${all.reduce((n, c) => n + c.lobbies.length, 0)} lists checked)`);

console.log('10 rooms at 60 Hz');
const ten = []; for (let i = 0; i < 10; i++) ten.push(await make(false));
ok(new Set(ten.map(c => c.room.code)).size === 10, '10 rooms: ' + ten.map(c => c.room.code).join(' '));
ten[9].send({ type: 'net', hz: 30 });
ok(await until(() => ten.every(c => c.info && c.info.active), 5000), 'a bot walked into every one of them');
for (const c of ten) play(c);
await wait(1000); const n0 = ten.map(c => c.n.state), t0 = Date.now(); await wait(5000); const secs = (Date.now() - t0) / 1000;
const rate = ten.map((c, i) => (c.n.state - n0[i]) / secs);
ok(rate.slice(0, 9).every(r => r > 58 && r < 62), `state packets per second in each room: ${rate.slice(0, 9).map(r => r.toFixed(1)).join(' ')}`);
ok(rate[9] > 28.5 && rate[9] < 31.5, `the socket that asked for 30: ${rate[9].toFixed(1)}`);
ok(ten.filter(c => c.st.live).length >= 8 && new Set(ten.map(c => c.st.p.join())).size >= 8, `and they are all playing: ${ten.filter(c => c.st.live).length} live balls, ${new Set(ten.map(c => c.st.p.join())).size} different positions`);

console.log('room cap and empty rooms (ROOM_CAP=2, ROOM_TTL=2 s)');
const c1 = await make(true, 'lobby=1', PORT2), c2 = await make(false, 'lobby=1', PORT2), c3 = await make(false, 'lobby=1', PORT2);
ok(c1.side === 0 && c2.side === 0 && c3.fail === 'busy' && c3.side == null, 'third room over the cap: joinfail busy');
const c4 = await inLobby('lobby=1', PORT2); c4.send({ type: 'quick' }); await until(() => c4.side != null); ok(c4.room && c4.room.code === c1.room.code, 'quick still finds the waiting public room at the cap');
c4.send({ type: 'leave' }); await until(() => c4.n.lobby >= 2); c1.ws.close();
ok(await until(() => c3.n.lobby >= 2 && !c3.listed(c1.room.code), 1500), 'a public room with nobody in it is not listed (nobody is coming to it)');
c3.fail = null; c3.send({ type: 'join', code: c1.room.code }); await until(() => c3.side != null || c3.fail);
ok(c3.side === 0 && c3.room.code === c1.room.code, 'inside ROOM_TTL an empty room can still be joined');
const nl = c3.n.lobby; c3.send({ type: 'leave' }); await until(() => c3.n.lobby > nl); const tLeft = Date.now(); let tFree = 0; c3.side = null;
while (!tFree && Date.now() - tLeft < 5000) { c3.fail = null; c3.send({ type: 'create', public: false }); await until(() => c3.side != null || c3.fail, 500); if (c3.side != null) tFree = Date.now(); else await wait(50); }   // at the cap: 'busy' until the empty room goes
ok(tFree - tLeft > 1900 && tFree - tLeft < 3600, `empty for ROOM_TTL: closed ${((tFree - tLeft) / 1000).toFixed(1)} s after the last human left, and that made space under the cap`);
const c5 = await joined(c1.room.code, 'lobby=1', PORT2); ok(c5.fail === 'notfound', 'its code: notfound');
const c6 = await inLobby('lobby=1', PORT2); c6.send({ type: 'join', code: c2.room.code }); await until(() => c6.side != null || c6.fail);
ok(c6.side === 1, 'a room with a human in it is not closed, however long it has stood');

for (const c of all) c.ws.close();
console.log(fails ? fails + ' FAILURES' : 'ROOMS TESTS PASSED'); process.exit(fails ? 1 : 0);
