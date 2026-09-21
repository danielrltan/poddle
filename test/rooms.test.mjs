// Rooms (docs/ROOMS.md): lobby list, create / join / quick, two matches at once that never touch, leave, reconnect by cid,
// empty rooms closing, the room cap, hostile input, the legacy socket in LOCAL, and 60 state packets a second in every one of 10 rooms.
// And docs/SPECTATE.md: names, spectators, match end -> rematch vote -> closed, a dropped player's seat held then forfeited,
// leave = forfeit, pause.   ROOMS_PORT=<base> moves the three servers (base, +1, +2).
import { spawn } from 'child_process';
import WebSocket from 'ws';
import http from 'http';
const PORT = +process.env.ROOMS_PORT || 8300, PORT2 = PORT + 1, PORT3 = PORT + 2, root = new URL('..', import.meta.url).pathname;
const up = (port, env) => spawn('node', ['server/game.js'], { cwd: root, env: { ...process.env, PORT: port, ...env }, stdio: 'ignore' });
const procs = [up(PORT, {}), up(PORT2, { ROOM_CAP: '2', ROOM_TTL: '2' }),                   // the second one only for the cap and the closing of empty rooms
  up(PORT3, { WIN_AT: '2', REMATCH_S: '4', HOLD_S: '3', PAUSE_S: '3' })];                   // the third: a match is 2 points, and the three countdowns are short enough to sit through
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
    if (m.type === 'lobby') { c.lobby = m; c.lobbies.push(m); } if (m.type === 'room') c.room = m; if (m.type === 'welcome') { c.side = m.side; c.welcome = m; c.names = m.names; }
    if (m.type === 'names') c.names = m.names;
    if (m.type === 'botinfo') c.info = m; if (m.type === 'joinfail') { c.fail = m.reason; c.failMsg = m; } if (m.type === 'point') c.score = m.score; });
  ws.on('close', () => { c.closed = true; }); ws.on('error', () => {});
  c.send = o => ws.send(JSON.stringify(o)); c.types = () => c.log.map(m => m.type).join(',');
  c.got = (type, f) => c.log.filter(m => m.type === type && (!f || f(m))); c.last = type => c.got(type).pop();
  c.listed = code => !!c.lobby && c.lobby.rooms.find(r => r.code === code);
  all.push(c); return c;
}
const inLobby = async (q, port) => { const c = client(q || 'lobby=1', port); await until(() => c.lobby); return c; };
const make = async (pub, q, port, name) => { const c = await inLobby(q, port); c.send({ type: 'create', public: pub, name }); await until(() => c.side != null || c.fail); return c; };
const joined = async (code, q, port, name) => { const c = await inLobby(q, port); c.send({ type: 'join', code, name }); await until(() => c.side != null || c.fail); return c; };
const watching = async (code, q, port) => { const c = await inLobby(q, port); c.send({ type: 'watch', code }); await until(() => c.welcome || c.fail); return c; };
// a player who serves by swinging and hits what comes near, like test/bot.test.mjs
function play(c) { let cool = 0; c.onState = m => {
  c.send({ type: 'paddle', auto: true, q: [0, 0, 0, 1] });
  const me = m.paddles[c.side], s = c.side === 0 ? 1 : -1; if (!me || Date.now() < cool) return;
  if (m.serving === c.side) { cool = Date.now() + 600; return c.send({ type: 'swing', power: 20, dir: 0.2, lob: 0 }); }
  if (m.live && Math.abs(m.p[0] - me.x) < 0.9 && Math.abs(m.p[1] - me.y) < 0.8 && -(m.p[2] - me.z) * s < 1.0 && -(m.p[2] - me.z) * s > -0.5 && m.v[2] * s > 0) { cool = Date.now() + 400; c.send({ type: 'swing', power: 16 + Math.random() * 10, dir: (Math.random() - 0.5), lob: 0 }); }
}; }
const park = c => { c.onState = () => c.send({ type: 'paddle', x: 3.6 * (c.side === 0 ? 1 : -1), y: 0.4, q: [0, 0, 0, 1] }); };   // stands in the corner, never touches a ball
const serveOnly = c => { let cool = 0; c.onState = m => { c.send({ type: 'paddle', auto: true, q: [0, 0, 0, 1] });                      // serves hard, returns nothing: loses every point
  if (m.serving === c.side && m.reach && Date.now() > cool) { cool = Date.now() + 600; c.send({ type: 'swing', power: 30, dir: 0, lob: 0 }); } }; };

console.log('legacy socket and the lobby');
const leg = client('cid=leg1'); await until(() => leg.n.state > 5);
ok(leg.side === 0 && !leg.n.room && !leg.n.lobby && leg.n.state > 5, `no lobby=1: seated at once, welcome + state, no room or lobby message (${leg.types()})`);
ok(leg.welcome.role === 'player' && JSON.stringify(leg.welcome.names) === '["Player 1",null]' && leg.st.watchers === 0 && !('paused' in leg.st), `LOCAL: role player, names ${JSON.stringify(leg.welcome.names)}, state.watchers 0, no state.paused`);
const a = await inLobby('lobby=1&cid=a');
ok(a.lobby && Array.isArray(a.lobby.rooms) && a.lobby.rooms.length === 0 && a.lobby.online === 2 && a.side == null && !a.n.state, `lobby=1: a list and nothing else: ${JSON.stringify(a.lobby)}`);
a.send({ type: 'ping', c: 7 }); ok(await until(() => a.log.find(m => m.type === 'pong' && m.c === 7 && m.t > 0)), 'ping is answered in the lobby too');
a.send({ type: 'paddle', x: 1 }); a.send({ type: 'swing', power: 30 }); a.send({ type: 'bot' }); a.send({ type: 'leave' }); await wait(200);
ok(leg.info && !leg.info.reason && !leg.n.swung && a.n.lobby === 1, 'game messages from the lobby reach no room');

console.log('create');
const watcher = await inLobby();
a.send({ type: 'create', public: false }); await until(() => a.side != null);
ok(a.room && /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/.test(a.room.code) && a.room.public === false && a.room.role === 'player', `create private: ${JSON.stringify(a.room)}`);
ok(a.types().includes('room,welcome,botinfo') && a.side === 0, `room, then welcome straight after (${a.types()})`);
await wait(1300); ok(watcher.lobby.rooms.length === 0, 'a private room is not listed');
const b = await make(true, 'lobby=1&cid=b');
ok(b.room && b.room.public === true && await until(() => watcher.listed(b.room.code), 2500), `create public: listed ${JSON.stringify(watcher.lobby.rooms)}`);
const row = watcher.listed(b.room.code); ok(row && row.players === 1 && row.open === true && row.watch === 8 && row.watchers === 0 && row.score.join() === '0,0' && row.live === false, `listed with players 1, open true, 8 places to watch: ${JSON.stringify(row)}`);
const late = await inLobby(); ok(late.listed(b.room.code) && late.lobby.online === all.length, `someone arriving later gets the list at once, online ${late.lobby.online}`);

console.log('join by code');
const d = await joined('  ' + b.room.code.toLowerCase() + ' ', 'lobby=1&cid=d');
ok(d.room && d.room.code === b.room.code && d.side === 1, 'lower case with spaces around it finds the room, second seat');
ok(await until(() => watcher.listed(b.room.code) && watcher.listed(b.room.code).players === 2 && watcher.listed(b.room.code).open === false, 2500), `full: still listed (it can be watched), players 2, open false: ${JSON.stringify(watcher.listed(b.room.code))}`);   // NEW RULE (SPECTATE.md): was "full: no longer listed"
ok(watcher.lobbies.length <= 1 + Math.ceil((Date.now() - watcher.t0) / 1000), `list updates are rationed: ${watcher.lobbies.length} in ${((Date.now() - watcher.t0) / 1000).toFixed(1)} s`);
const e = await joined(b.room.code); ok(e.fail === 'full' && e.side == null && e.failMsg.watch === true && e.failMsg.code === b.room.code, `third joiner: joinfail full, and it may watch: ${JSON.stringify(e.failMsg)}`);
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
const a1 = await make(false, 'lobby=1', PORT, 'Ann'), a2 = await joined(a1.room.code, 'lobby=1', PORT, 'Art'), b1 = await make(false, 'lobby=1', PORT, 'Bea'), b2 = await joined(b1.room.code, 'lobby=1&cid=b2x', PORT, 'Bob');
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

// NEW RULES (SPECTATE.md) for a room that HAD two humans and a match under way: 'leave' is a forfeit, a closed socket gets
// its seat held. (Was: the stayer gets 'left' and the bot comes back. That is still what happens before a ball is struck.)
console.log('leave mid-match = forfeit');
const aWatch = await watching(a1.room.code), aCode = a1.room.code;
a1.onState = null; a1.send({ type: 'leave' });
ok(await until(() => a1.lobby && a1.log[a1.log.length - 1].type === 'lobby') && await until(() => a2.n.matchover === 1) && !a2.n.left, `leaver gets a fresh lobby list, the one who stayed gets 'matchover', not 'left'`);
const mo = a2.last('matchover'), rv = a2.last('rematch');
ok(mo.forfeit === true && mo.winner === 1 && mo.rematchBy === 20 && mo.score.join() === a2.st.score.join() && JSON.stringify(mo.names) === '["Ann","Art"]', `forfeit: the one who stayed wins, 20 s to vote, names as they were: ${JSON.stringify(mo)}`);
ok(rv && rv.votes[0] === false && rv.votes[1] === null && rv.left <= 20 && rv.left >= 19 && aWatch.n.matchover === 1 && !a1.n.matchover, `the leaver's vote is already no: ${JSON.stringify(rv)}; the spectator saw the result too, the leaver did not`);
const st0 = a1.n.state; await wait(300); ok(a1.n.state === st0 && !a2.st.live && a2.n.state > 0, 'no more state for the one who left; the ball stays dead for the one who stayed');
a1.side = null; a1.send({ type: 'join', code: b1.room.code }); await until(() => a1.fail); ok(a1.fail === 'full', 'and the leaver really is in the lobby again (can ask to join)');
a2.send({ type: 'rematch', yes: true });
ok(await until(() => a2.n.closed === 1 && aWatch.n.closed === 1) && a2.last('closed').reason === 'norematch' && a2.log[a2.log.length - 1].type === 'lobby' && aWatch.log[aWatch.log.length - 1].type === 'lobby',
  `nobody to play a rematch with: closed norematch for the player and the spectator, both get the lobby list (${a2.types().split(',').slice(-4)})`);
a1.fail = null; a1.send({ type: 'join', code: aCode }); await until(() => a1.fail); ok(a1.fail === 'notfound', 'and the room is gone at once: its code is notfound');

console.log('leave before a ball is struck = a plain leave');
const p1 = await make(false, 'lobby=1', PORT, 'Pam'), p2 = await joined(p1.room.code, 'lobby=1', PORT, 'Pip');       // neither sends a paddle: the serve waits, nothing is struck
p2.send({ type: 'leave' });
ok(await until(() => p2.lobby && p2.log[p2.log.length - 1].type === 'lobby' && p1.n.left === 1) && !p1.n.matchover && !p1.n.hold, `0-0, no serve struck: the one who stayed gets 'left', no forfeit, no hold`);
ok(await until(() => p1.info && p1.info.active, 4000) && await until(() => JSON.stringify(p1.names) === '["Pam","Matt"]'), `then the bot comes back for them (${p1.info.name}), names ${JSON.stringify(p1.names)}`);
const p3 = await joined(p1.room.code, 'lobby=1', PORT, 'Pat'); p3.ws.close();
ok(await until(() => p1.n.left === 2) && !p1.n.hold, `a closed socket before the match counts as leaving too: 'left', no hold`);
const p4 = await joined(p1.room.code); ok(p4.side === 1 && p4.room.code === p1.room.code, 'the freed seat can be taken');

console.log('a dropped player: the seat is held');
const hScore = b1.st.score.join(), hSpec = await watching(b1.room.code); b1.onState = null; park(b1);
b2.ws.close();
ok(await until(() => b1.n.hold >= 1) && !b1.n.left && !b1.n.matchover, `socket closed mid-match (score ${hScore}): 'hold', not 'left'`);
ok(b1.last('hold').side === 1 && b1.got('hold')[0].left === 15 && hSpec.n.hold >= 1, `hold says whose seat and 15 s: ${JSON.stringify(b1.got('hold')[0])}; spectators hear it too`);
const hT = []; b1.ws.on('message', raw => { const m = JSON.parse(raw); if (m.type === 'state') hT.push(m); }); await wait(1300);
ok(hT.length > 60 && hT.every(m => m.paused === true && m.t === hT[0].t && m.p.join() === hT[0].p.join()) && hT[0].paddles[1], `room time stands still: ${hT.length} packets in 1.3 s, all paused:true with t ${hT[0].t.toFixed(3)} and the same ball, the held paddle still there`);
ok(b1.got('hold').length >= 2 && b1.got('hold').length <= 3 && b1.last('hold').left === 14, `hold counts down once a second (${b1.got('hold').map(m => m.left)})`);
const b3 = await joined(b1.room.code); ok(b3.fail === 'full' && b3.failMsg.watch === true, 'the held seat is taken: a stranger cannot sit in it');
b1.send({ type: 'pause', on: true }); await wait(150); ok(b1.last('paused') && b1.last('paused').refused === true, 'and a held seat still counts as a human: no pause');
const b2b = client(`lobby=1&cid=b2x&room=${b1.room.code}&name=Robert`); await until(() => b2b.side != null); park(b2b);
ok(b2b.side === 1 && b2b.room.role === 'player' && JSON.stringify(b2b.welcome.names) === '["Bea","Bob"]', `same cid comes back: seat 1 again, and the seat keeps its name (${JSON.stringify(b2b.welcome.names)}, not the new socket's)`);
ok(await until(() => b1.n.holdoff === 1 && hSpec.n.holdoff === 1) && !b1.n.left && !b1.n.matchover, `'holdoff' for everyone, nobody left, no forfeit`);
hT.length = 0; await wait(500);
ok(hT.length > 20 && hT.every(m => !('paused' in m)) && hT[hT.length - 1].t > hT[0].t + 0.3 && hT[0].score.join() === hScore, `time runs again, score kept (${hT[0].score})`);
const hServes = b1.n.serve; ok(await until(() => b1.n.serve > hServes || b1.st.live, 3000) && b1.st.score.join() === hScore, 'and the point is served again');

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

console.log('names');
const nest = n => '['.repeat(n) + ']'.repeat(n);
const n1 = await make(true, 'lobby=1&cid=n1', PORT, '  Dan<b>\u0000iel ‮  the   Great!!  ');
ok(JSON.stringify(n1.welcome.names) === '["Danbiel the",null]' && n1.welcome.role === 'player', `control characters, bidi marks and angle brackets go, spaces collapse, 12 characters, trimmed: ${JSON.stringify(n1.welcome.names)}`);
const n2 = await joined(n1.room.code, 'lobby=1&cid=n2');
ok(JSON.stringify(n2.welcome.names) === '["Danbiel the","Player 2"]' && await until(() => n1.names && n1.names[1] === 'Player 2') && n1.n.names === 1, `no name given: Player 2. The one already seated hears it in 'names' (${JSON.stringify(n1.names)})`);
n2.send({ type: 'name', name: 'Zed' }); ok(await until(() => n1.names[1] === 'Zed' && n2.names[1] === 'Zed'), `{type:'name'} inside a room renames the seat for everyone: ${JSON.stringify(n1.names)}`);
n2.ws.send(`{"type":"name","name":${nest(1500)}}`); n2.send({ type: 'name', name: { toString: 1 } }); n2.send({ type: 'name', name: 7 }); n2.send({ type: 'name', name: '<<>>\u0007 ' });
ok(await until(() => n1.names[1] === 'Player 2') && n1.st && n1.n.state > 0, `a nested array, an object, a number, only brackets as a name: back to Player 2, server still up (${JSON.stringify(n1.names)})`);
n2.send({ type: 'name', name: 'x'.repeat(3000) }); ok(await until(() => n1.names[1] === 'xxxxxxxxxxxx'), '3000 characters: the first 12');
n2.send({ type: 'name', name: '👍'.repeat(20) }); ok(await until(() => n1.names[1] === '👍'.repeat(12)), '12 characters, not 12 half characters (emoji are not cut in two)');
n2.send({ type: 'leave' }); ok(await until(() => n1.names[1] === null && n1.n.left === 1), `the seat empties: ${JSON.stringify(n1.names)}`);
ok(await until(() => n1.info && n1.info.active && n1.names[1] === 'Matt', 4000) && ['Rookie', 'Club', 'Pro'].includes(n1.info.name), `the bot is Matt in names (${JSON.stringify(n1.names)}); botinfo.name stays the level (${n1.info.name})`);
n1.send({ type: 'bot', level: 2 }); await until(() => n1.info.name === 'Pro'); ok(n1.names[1] === 'Matt', 'Matt at every level');
const n3 = client(`lobby=1&room=${n1.room.code}&name=${encodeURIComponent('Url <Guy>')}`); await until(() => n3.side != null);
ok(n3.side === 1 && await until(() => n1.names[1] === 'Url Guy') && n3.welcome.names[1] === 'Url Guy', `a seat taken by URL takes its name from &name= (${JSON.stringify(n1.names)}), sanitised the same way`);
const n1b = client(`lobby=1&cid=n1&room=${n1.room.code}&name=Impostor`); await until(() => n1b.side != null);
ok(n1b.side === 0 && n1b.welcome.names[0] === 'Danbiel the' && await until(() => n1.closed), 'a seat taken over by cid keeps its name');

console.log('spectators');
const sA = await make(true, 'lobby=1', PORT, 'Sue'), sB = await joined(sA.room.code, 'lobby=1', PORT, 'Sam'), sCode = sA.room.code; play(sA); serveOnly(sB);
const sLobby = await inLobby();
const sp1 = await watching(sCode.toLowerCase(), 'lobby=1&cid=sp1');
ok(sp1.room && sp1.room.role === 'spectator' && sp1.room.code === sCode && sp1.welcome.side === null && sp1.welcome.role === 'spectator' && JSON.stringify(sp1.welcome.names) === '["Sue","Sam"]' && sp1.welcome.court && sp1.types().startsWith('lobby,room,welcome,botinfo'),
  `watch: room (role spectator), welcome side null with the names and the court (${sp1.types()})`);
ok(await until(() => sp1.n.state > 30 && sp1.st.watchers === 1 && sA.st.watchers === 1) && await until(() => sp1.n.hit >= 2 && sp1.n.serve >= 1, 6000), `the state stream and every event reach it (${sp1.n.hit} hits); state.watchers is 1 for spectator and players alike`);
ok(await until(() => { const r = sLobby.listed(sCode); return r && r.players === 2 && !r.open && r.watch === 7 && r.watchers === 1 && r.live === true; }, 2500), `the lobby list shows it: ${JSON.stringify(sLobby.listed(sCode))}`);
for (const m of [{ type: 'swing', power: 30 }, { type: 'paddle', x: 1 }, { type: 'bot' }, { type: 'pause', on: true }, { type: 'rematch', yes: false }, { type: 'create', public: true }, { type: 'quick' }, { type: 'join', code: sCode }]) sp1.send(m);
sp1.send({ type: 'ping', c: 3 }); await until(() => sp1.got('pong', m => m.c === 3).length);
ok(!sA.n.paused && !sA.n.closed && sA.got('botinfo', m => m.reason).length === 0 && sp1.n.room === 1 && sA.st.paddles.every(p => p && !p.bot) && Math.abs(sp1.last('pong').t - sp1.st.t) < 0.5,
  `a spectator is heard saying ping (answered in room time), net and leave: swing, paddle, bot, pause, rematch, create, quick, join change nothing`);
const sScore = () => sLobby.listed(sCode).score.join('-');
ok(await until(() => sA.st.score[0] + sA.st.score[1] > 0, 15000) && await until(() => sScore() === sA.st.score.join('-'), 2500), `the list carries the live score: ${sScore()}`);
const w1b = client(`lobby=1&cid=sp1&room=${sCode}&watch=1`); await until(() => w1b.welcome);
ok(w1b.room.role === 'spectator' && await until(() => sp1.closed) && await until(() => w1b.st && w1b.st.watchers === 1), `a spectator reconnecting with its cid (socket URL room=CODE&watch=1) is a spectator again, not a second one (watchers ${w1b.st && w1b.st.watchers})`);
const more = []; for (let i = 0; i < 7; i++) more.push(await watching(sCode));
ok(more.every(c => c.welcome && c.welcome.role === 'spectator') && await until(() => sA.st.watchers === 8), '8 can watch');
const w9 = await watching(sCode); ok(w9.fail === 'busy' && !w9.welcome && w9.lobby, `the 9th: joinfail busy, stays in the lobby (${JSON.stringify(w9.failMsg)})`);
w9.fail = null; w9.send({ type: 'join', code: sCode }); await until(() => w9.fail); ok(w9.fail === 'full' && w9.failMsg.watch === false, `and a joiner is told there is no place to watch either: ${JSON.stringify(w9.failMsg)}`);
w9.fail = null; w9.send({ type: 'watch', code: 'QQQQ' }); await until(() => w9.fail); ok(w9.fail === 'notfound', 'watch an unknown code: notfound');
const nl0 = more[0].n.lobby; more[0].send({ type: 'leave' });
ok(await until(() => more[0].n.lobby > nl0 && sA.st.watchers === 7) && !sA.n.left, `a spectator leaves: back in the lobby with a fresh list, watchers 7, the players hear nothing`);
more[1].ws.close(); ok(await until(() => sA.st.watchers === 6), 'a spectator whose socket closes is gone too: watchers 6');
const so = await make(false, 'lobby=1', PORT, 'Solo'), sw = await watching(so.room.code);
ok(sw.welcome && sw.welcome.role === 'spectator' && JSON.stringify(sw.welcome.names) === '["Solo",null]' && so.side === 0, 'a private room can be watched with its code, free seat or not');
ok(await until(() => so.info && so.info.active && sw.names && sw.names[1] === 'Matt', 4000) && await until(() => sw.got('botinfo', m => m.active).length), `a spectator does not count as a second human: Matt still comes (${JSON.stringify(sw.names)}), and the spectator hears botinfo`);
const so2 = await joined(so.room.code, 'lobby=1', PORT, 'Duo'); ok(so2.side === 1 && await until(() => JSON.stringify(sw.names) === '["Solo","Duo"]'), `and does not take a seat: a second human still sits down (${JSON.stringify(sw.names)})`);
so2.send({ type: 'leave' }); await until(() => so.n.left === 1); so.send({ type: 'leave' });
ok(await until(() => sw.n.closed === 1) && sw.last('closed').reason === 'empty' && sw.log[sw.log.length - 1].type === 'lobby', `the last human leaves: spectators get closed (empty) and the lobby list (${sw.types().split(',').slice(-3)})`);

console.log('match end, rematch vote, closed (WIN_AT=2, REMATCH_S=4)');
const pair = async (pub, na, nb) => { const A = await make(pub, 'lobby=1&cid=' + na, PORT3, na), B = await joined(A.room.code, 'lobby=1&cid=' + nb, PORT3, nb), W = await watching(A.room.code, 'lobby=1', PORT3); play(A); serveOnly(B); return [A, B, W]; };
const overs = c => c.n.matchover || 0;
let [mA, mB, mW] = await pair(true, 'Ma', 'Mb');
ok(await until(() => overs(mA) === 1 && overs(mB) === 1 && overs(mW) === 1, 40000), `first to 2: matchover for both players and the spectator (${JSON.stringify(mA.last('matchover'))})`);
let mo1 = mA.last('matchover');
ok(mo1 && mo1.winner === 0 && mo1.score.join() === '2,0' && mo1.forfeit === false && mo1.rematchBy === 4 && !mA.n.match && mA.got('point').pop().final === true, `winner, score, forfeit false, rematchBy in whole seconds; the old 'match' message is gone, point.final stays`);
await wait(1200); ok(!mA.st.live && mA.log.slice(mA.log.indexOf(mo1)).every(m => m.type !== 'serve'), 'the ball stays dead: no serve after matchover (the auto-restart is gone)');
mA.ws.send(`{"type":"rematch","yes":${nest(1500)}}`); mA.send({ type: 'rematch', yes: 'true' }); mA.send({ type: 'rematch', yes: 1 }); mA.send({ type: 'rematch' }); mW.send({ type: 'rematch', yes: false }); await wait(200);
ok(!mA.n.rematch && !mA.n.closed, 'a vote that is not a boolean, and a spectator voting: nothing');
mA.send({ type: 'rematch', yes: true }); ok(await until(() => mB.n.rematch === 1 && mW.n.rematch === 1) && JSON.stringify(mB.last('rematch').votes) === '[true,null]' && mB.last('rematch').left >= 1 && mB.last('rematch').left <= 3, `one yes: everyone hears ${JSON.stringify(mB.last('rematch'))}`);
mA.send({ type: 'rematch', yes: false }); await wait(150); ok(mB.n.rematch === 1 && !mB.n.closed, 'one answer each: a second one is ignored');
mB.send({ type: 'rematch', yes: true });
ok(await until(() => mA.n.rematchon === 1 && mB.n.rematchon === 1 && mW.n.rematchon === 1) && !mW.n.closed, `yes + yes: rematchon for players and spectator, the spectator stays where it is`);
const s0 = mA.got('serve').length; await until(() => mA.got('serve').length > s0, 4000);
ok(mA.got('serve')[s0] && mA.got('serve')[s0].by === 1 && mA.st.score.join() === '0,0', `new match at 0-0, first serve alternates from the last match (side ${mA.got('serve')[s0] && mA.got('serve')[s0].by} serves)`);
ok(await until(() => overs(mA) === 2 && overs(mW) === 2, 40000), 'and it is played to the end again');
const mCode = mA.room.code; mA.send({ type: 'rematch', yes: true }); await until(() => mB.n.rematch >= 2); mB.send({ type: 'rematch', yes: false });
ok(await until(() => mA.n.closed === 1 && mB.n.closed === 1 && mW.n.closed === 1) && [mA, mB, mW].every(c => c.last('closed').reason === 'norematch' && c.log[c.log.length - 1].type === 'lobby'), 'yes + no: closed (norematch) for both players and the spectator, each gets a fresh lobby list');
ok(JSON.stringify(mA.got('rematch').pop().votes) === '[true,false]', `and they saw the vote first: ${JSON.stringify(mA.got('rematch').pop())}`);
const gone = await joined(mCode, 'lobby=1', PORT3); ok(gone.fail === 'notfound' && !mA.lobby.rooms.find(r => r.code === mCode), 'the room is deleted at once: notfound, not listed');
mA.side = null; mA.send({ type: 'create', public: false }); await until(() => mA.side != null); ok(mA.side === 0 && mA.room.code !== mCode, 'and everyone really is in the lobby: can create again');
[mA, mB, mW] = await pair(false, 'Ta', 'Tb');
ok(await until(() => overs(mA) === 1, 40000), 'another match ends; this time nobody answers');
const tOver = Date.now(); ok(await until(() => mA.n.closed === 1 && mB.n.closed === 1 && mW.n.closed === 1, 6000) && Date.now() - tOver > 3000 && Date.now() - tOver < 5200 && mA.last('closed').reason === 'norematch', `the vote runs out: closed norematch ${((Date.now() - tOver) / 1000).toFixed(1)} s after matchover (REMATCH_S=4)`);

console.log('rematch against Matt');
const vb = await make(false, 'lobby=1', PORT3, 'Vera'); vb.send({ type: 'bot', level: 2 }); serveOnly(vb);
ok(await until(() => overs(vb) === 1, 90000), `Matt (Pro) beats someone who never returns a ball: ${JSON.stringify(vb.last('matchover'))}`);
ok(vb.last('matchover').winner === 1 && JSON.stringify(vb.last('matchover').names) === '["Vera","Matt"]' && await until(() => vb.n.rematch === 1) && JSON.stringify(vb.last('rematch').votes) === '[null,true]', `Matt always wants another: ${JSON.stringify(vb.last('rematch'))}`);
const vs0 = vb.got('serve').length; vb.send({ type: 'bot' }); await wait(100); vb.send({ type: 'rematch', yes: true });
ok(await until(() => vb.n.rematchon === 1) && await until(() => vb.got('serve').length > vs0, 4000) && vb.got('serve')[vs0].by === 1 && !vb.n.closed && vb.info.name === 'Pro', `yes: rematchon, and Matt serves first this time (the human did last time); B during the vote changed nothing (${vb.info.name})`);

console.log('hold runs out = forfeit (HOLD_S=3)');
[mA, mB, mW] = await pair(true, 'Ha', 'Hb'); await until(() => mA.n.hit >= 1, 8000);
mB.ws.terminate(); const tDrop = Date.now();
ok(await until(() => overs(mA) === 1, 6000) && Date.now() - tDrop > 2500 && Date.now() - tDrop < 4200, `not back in 3 s: matchover ${((Date.now() - tDrop) / 1000).toFixed(1)} s after the drop`);
ok(mA.got('hold').map(m => m.left).join() === '3,2,1' && mA.last('matchover').forfeit === true && mA.last('matchover').winner === 0 && JSON.stringify(mA.last('matchover').names) === '["Ha","Hb"]' && mA.n.holdoff === 1 && mA.log.indexOf(mA.last('holdoff')) < mA.log.indexOf(mA.last('matchover')),
  `hold ${mA.got('hold').map(m => m.left)}, holdoff, then matchover forfeit for the one who stayed: ${JSON.stringify(mA.last('matchover'))}`);
ok(await until(() => mA.n.rematch === 1) && JSON.stringify(mA.last('rematch').votes) === '[null,false]' && mW.n.matchover === 1, 'the leaver cannot vote: their vote is no');
const back = client(`lobby=1&cid=Hb&room=${mA.room.code}`, PORT3); await until(() => back.fail || back.side != null);
ok(back.fail === 'full' && back.side == null && !mA.n.rematchon, `too late to come back: a forfeited room seats nobody (${back.fail})`);
mA.send({ type: 'rematch', yes: false }); ok(await until(() => mA.n.closed === 1 && mW.n.closed === 1) && mW.last('closed').reason === 'norematch', 'Leave on the result screen: closed for player and spectator');
[mA, mB, mW] = await pair(false, 'Da', 'Db'); await until(() => mA.n.hit >= 1, 8000);
mB.ws.terminate(); await until(() => mA.n.hold >= 1); mA.ws.terminate();
ok(await until(() => mW.n.closed === 1) && mW.last('closed').reason === 'empty', 'both players drop: nobody is left to hold a seat for, spectators get closed (empty)');

console.log('pause');
const pz = await make(true, 'lobby=1&cid=pz', PORT, 'Paz'), pzW = await watching(pz.room.code);
pz.send({ type: 'pause', on: true });
ok(await until(() => pz.n.paused === 1 && pzW.n.paused === 1) && pz.last('paused').on === true && pz.last('paused').by === 0 && !pz.last('paused').refused, `alone in the room (no Matt yet): paused ${JSON.stringify(pz.last('paused'))}, the spectator hears it`);
await wait(3200); ok(!pz.info.active && pz.st.paused === true, 'room time stands still: Matt, due after 2.5 s, has not come in 3.2 s');
pz.send({ type: 'pause', on: false }); ok(await until(() => pz.n.paused === 2 && pz.last('paused').on === false && pz.last('paused').by === 0) && await until(() => pz.info.active, 4000), 'resumed: and now he comes');
play(pz); await until(() => pz.st.live && pz.st.serving == null && Math.abs(pz.st.v[2]) > 1, 15000);
pz.send({ type: 'pause', on: true }); await until(() => pz.n.paused === 3);
const pT = []; pz.ws.on('message', raw => { const m = JSON.parse(raw); if (m.type === 'state') pT.push(m); }); const hits0 = pz.n.hit, sw0 = pz.n.swung || 0; await wait(200); pT.length = 0;
pz.send({ type: 'swing', power: 30, dir: 0, lob: 0 }); await wait(1000);
ok(pT.length > 50 && pT.every(m => m.paused === true && m.t === pT[0].t && m.p.join() === pT[0].p.join() && m.live) && Math.abs(pT[0].v[2]) > 1, `vs Matt, ball in flight: ${pT.length} packets in 1 s, every one paused:true, t ${pT[0].t.toFixed(3)} and the ball at ${pT[0].p.map(v => v.toFixed(2))} never move`);
ok(pz.n.hit === hits0 && (pz.n.swung || 0) === sw0 && pT.every(m => JSON.stringify(m.paddles) === JSON.stringify(pT[0].paddles)), 'swings and paddles are ignored while paused, Matt stands still');
const late2 = await watching(pz.room.code); ok(late2.got('paused', m => m.on === true).length === 1 && await until(() => late2.st && late2.st.paused === true), 'someone who arrives during the pause is told, and sees paused:true in state');
pz.send({ type: 'pause', on: true }); pz.send({ type: 'pause', on: 'yes' }); pz.ws.send(`{"type":"pause","on":${nest(1500)}}`); pz.send({ type: 'pause' }); await wait(200);
ok(pzW.n.paused === 3 && pz.st.paused === true, 'pause again, or with something that is not a boolean: nothing changes for the room');
const pj = await joined(pz.room.code, 'lobby=1', PORT, 'Joy');
ok(pj.side === 1 && await until(() => pzW.got('paused', m => m.on === false).length === 2 && pz.last('paused').on === false) && await until(() => pz.st && !pz.st.paused && pj.st && !pj.st.paused), `a second human sits down in the paused public room: it resumes (${JSON.stringify(pz.last('paused'))})`);
play(pj); pz.send({ type: 'pause', on: true }); const np = pj.n.paused || 0;
ok(await until(() => pz.last('paused').refused === true && pz.last('paused').on === false) && (pj.n.paused || 0) === np && !pz.st.paused, `two humans: refused, only the one who asked hears it: ${JSON.stringify(pz.last('paused'))}`);
const pd = await make(false, 'lobby=1', PORT, 'Pod'), pdW = await watching(pd.room.code); pd.send({ type: 'bot', level: 0 }); await until(() => pd.info.active); pd.send({ type: 'pause', on: true }); await until(() => pdW.n.paused === 1);
pd.ws.terminate();
ok(await until(() => pdW.n.closed === 1) && pdW.got('paused').pop().on === false && pdW.last('closed').reason === 'empty', `the pauser drops: the pause ends (${JSON.stringify(pdW.got('paused').pop())}) and the empty room sends its spectators home`);
const pd2 = await joined(pd.room.code); ok(pd2.side === 0 && await until(() => pd2.n.state > 10 && !pd2.st.paused), 'the room itself is not stuck paused');
const pm = await make(false, 'lobby=1', PORT3, 'Max'); pm.send({ type: 'pause', on: true }); await until(() => pm.n.paused === 1); const tP = Date.now();
ok(await until(() => pm.n.paused === 2, 5000) && pm.last('paused').on === false && Date.now() - tP > 2500 && Date.now() - tP < 4200, `nobody pauses for ever: resumed by itself after ${((Date.now() - tP) / 1000).toFixed(1)} s (PAUSE_S=3; 10 minutes in real life)`);
leg.send({ type: 'pause', on: true }); ok(await until(() => leg.n.paused === 1 && leg.st.paused === true), 'LOCAL pauses too (one human and Matt in it)');
leg.send({ type: 'pause', on: false }); ok(await until(() => leg.n.paused === 2 && !leg.st.paused), 'and resumes');

console.log('seat status: calibrating / paused / away on state.paddles (docs/NEXT.md 14a)');
const z1 = await make(false, 'lobby=1&cid=zz1', PORT3, 'Sue'), zW = await watching(z1.room.code, 'lobby=1', PORT3); await until(() => zW.st && zW.st.paddles[0]);
ok(zW.st.paddles[0].status === 'calibrating' && zW.st.paddles[0].wait === true, `seated, no paddle yet: status ${zW.st.paddles[0].status} (and wait:true as before)`);
const z2 = await joined(z1.room.code, 'lobby=1&cid=zz2', PORT3, 'Tom'); play(z1); play(z2);
ok(await until(() => zW.st.paddles[1] && !('status' in zW.st.paddles[0]) && !('status' in zW.st.paddles[1])), 'both calibrated: no status key at all');
await until(() => (z1.n.hit || 0) >= 1 && z1.st.live && z1.st.serving == null, 15000);
z2.onState = null; z2.send({ type: 'status', cal: true }); const zHits = z1.n.hit, zPts = z1.n.point || 0;
ok(await until(() => zW.st.paddles[1].status === 'calibrating' && z1.st.paddles[1].status === 'calibrating') && z1.st.live && !z1.st.paused, 'status cal:true mid-rally: the seat reads calibrating for player and spectator, the rally plays on');
await until(() => (z1.n.point || 0) > zPts, 15000); const zSv = z1.n.serve; await wait(2600);
ok(z1.n.serve === zSv && !z1.st.live, `the NEXT serve is held while Tom calibrates (${z1.n.serve - zSv} serves in 2.6 s)`);
zW.send({ type: 'status', cal: false }); z2.send({ type: 'status', cal: 'no' }); z2.send({ type: 'status' }); z2.ws.send(`{"type":"status","cal":${nest(1500)}}`); await wait(400);
ok(z1.st.paddles[1].status === 'calibrating' && z1.n.serve === zSv, 'a spectator, a string, nothing, a nested array: the status stands');
z2.send({ type: 'status', cal: false }); ok(await until(() => !z1.st.paddles[1].status && z1.n.serve > zSv, 4000), 'cal:false: the status goes and the serve comes');
z2.send({ type: 'status', cal: true }); await until(() => z1.st.paddles[1].status === 'calibrating'); z2.send({ type: 'paddle', auto: true, q: [0, 0, 0, 1] });
ok(await until(() => !z1.st.paddles[1].status), 'the next paddle clears it too (only a calibrated client sends one)'); play(z2);
await until(() => (z1.n.hit || 0) > zHits && z1.st.live, 15000); z2.ws.terminate();
ok(await until(() => zW.st.paddles[1] && zW.st.paddles[1].status === 'away' && zW.st.paused === true) && !zW.st.paddles[0].status, 'a dropped player: away while the seat is held');
const z3 = await make(false, 'lobby=1', PORT, 'Una'), z3W = await watching(z3.room.code); z3.send({ type: 'bot', level: 0 }); play(z3); await until(() => z3.info.active && z3W.st && z3W.st.paddles[1] && !z3W.st.paddles[0].status);
z3.send({ type: 'pause', on: true });
ok(await until(() => z3W.st.paddles[0].status === 'paused') && !('status' in z3W.st.paddles[1]), 'the seat that paused reads paused; Matt never has a status');
z3.send({ type: 'pause', on: false }); ok(await until(() => !z3W.st.paddles[0].status), 'resumed: gone');

console.log('hostile input');
const h1 = await inLobby(), h2 = await inLobby();
h1.ws.send(`{"type":"join","code":${nest(1500)}}`); h1.ws.send(`{"type":"ping","c":${nest(1500)}}`); h1.ws.send('{"type":"join","code":{"trim":1}}');
h1.ws.send(`{"type":"watch","code":${nest(1500)}}`); h1.ws.send('{"type":"watch","code":{"trim":1}}'); h1.ws.send('{"type":"watch"}'); h1.ws.send(`{"type":"quick","name":${nest(1500)}}`);   // the new messages get the same treatment
ok(await until(() => h1.side === 0 && h1.welcome.names[0] === 'Player 1') && h1.got('joinfail').length === 5, `watch with a nested array, an object, nothing as code: notfound x3. quick with a nested array as name: seated as ${h1.welcome && h1.welcome.names[0]}`);
for (const junk of [`{"type":"rematch","yes":${nest(1500)}}`, `{"type":"pause","on":${nest(1500)}}`, `{"type":"name","name":${nest(1500)}}`, '{"type":"pause","on":{"valueOf":1}}', '{"type":"rematch","yes":[true]}', '{"type":"name"}', '{"type":"watch","code":"ABCD"}', '{"type":"bot","level":"2"}']) h1.ws.send(junk);
await wait(200); ok(!h1.n.paused && !h1.n.rematch && !h1.n.closed && h1.names[0] === 'Player 1' && h1.n.state > 5, 'junk in every field of rematch, pause, name from a seated player: nothing happens');
h1.send({ type: 'leave' }); await until(() => h1.got('lobby').length >= 2);
h2.ws.send(`{"type":"ping","c":${nest(100000)}}`);
const get = path => new Promise(res => { const r = http.request({ port: PORT, path }, x => { x.resume(); res(x.statusCode); }); r.on('error', () => res(0)); r.end(); });
const codes = [await get('/%00'), await get('/a%00b.js'), await get('/%E0%A4%A'), await get('/../server/game.js'), await get('/index.html')];
ok(await until(() => h1.log.filter(m => m.type === 'joinfail').length === 5 && h1.log.find(m => m.type === 'pong' && m.c === 0)), 'a nested array or an object as code: notfound. As ping c: echoed as 0');
ok(await until(() => h2.closed), 'a 200 KB message closes that socket (maxPayload)');
ok(codes.join() === '400,400,404,404,200' || codes.join() === '400,400,200,404,200', `GET /%00, /a%00b.js, bad escape, ../, index.html: ${codes}`);
const h3 = await inLobby(); ok(h3.lobby && g1.n.state > 0, 'and the server is still up');

console.log('legacy');
const leg2 = client('cid=leg2'); await until(() => leg2.side != null);
ok(leg2.side === 1 && !leg2.n.room && leg.n.state > 100, 'second socket without lobby=1 joins the first in LOCAL');
ok(all.every(c => c.lobbies.every(m => m.rooms.every(r => r.code !== 'LOCAL'))), `LOCAL was never listed (${all.reduce((n, c) => n + c.lobbies.length, 0)} lists checked)`);
const shape = r => /^[A-Z2-9]{4}$/.test(r.code) && (r.players === 1 || r.players === 2) && typeof r.open === 'boolean' && !(r.open && r.players === 2) && Number.isInteger(r.watch) && r.watch >= 0 && r.watch <= 8 && r.watchers === 8 - r.watch   // NEW RULE: was "every listed room is open with 1 player"
  && Array.isArray(r.score) && r.score.length === 2 && r.score.every(Number.isInteger) && typeof r.live === 'boolean';
ok(all.every(c => c.lobbies.every(m => m.rooms.every(shape))), 'every row of every list: { code, players 1|2, open, watch, watchers, score:[a,b], live }');

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
