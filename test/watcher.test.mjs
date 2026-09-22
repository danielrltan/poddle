// "Sam is watching": a spectator sitting down tells the players (and only them) once, with its name. A reload of the same tab
// (same cid) is not news; a stranger in another court is not either.   WATCHER_PORT=<port> moves the server.
import { spawn } from 'child_process';
import WebSocket from 'ws';
const PORT = +process.env.WATCHER_PORT || 8355, root = new URL('..', import.meta.url).pathname;
const proc = spawn('node', ['server/game.js'], { cwd: root, env: { ...process.env, PORT }, stdio: 'ignore' });
process.on('exit', () => proc.kill());
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (f, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (f()) return true; await wait(20); } return !!f(); };
let fails = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
function client(cid) {
  const ws = new WebSocket(`ws://localhost:${PORT}/?lobby=1&cid=${cid}`), c = { ws, log: [] };
  ws.on('message', raw => { const m = JSON.parse(raw); if (m.type !== 'state') c.log.push(m); if (m.type === 'room') c.room = m; }); ws.on('error', () => {});
  c.send = o => ws.send(JSON.stringify(o)); c.seen = () => c.log.filter(m => m.type === 'watcher');
  return new Promise(r => ws.on('open', () => r(c)));
}
await wait(700);
const ann = await client('ann'), bob = await client('bob'), eve = await client('eve');
ann.send({ type: 'create', public: false, name: 'Ann' }); await until(() => ann.room);
bob.send({ type: 'join', code: ann.room.code, name: 'Bob' }); eve.send({ type: 'create', public: false, name: 'Eve' }); await until(() => bob.room && eve.room);
const cat = await client('cat'); cat.send({ type: 'watch', code: ann.room.code, name: 'Cat' });
await until(() => ann.seen().length && bob.seen().length);
ok(ann.seen().length === 1 && ann.seen()[0].name === 'Cat' && bob.seen()[0]?.name === 'Cat', 'both players hear {type:watcher, name:Cat}');
ok(cat.seen().length === 0 && eve.seen().length === 0, 'not the spectator itself, not another court');
const dan = await client('dan'); dan.send({ type: 'watch', code: ann.room.code, name: 'Dan' }); await until(() => ann.seen().length === 2);
ok(ann.seen()[1]?.name === 'Dan' && cat.seen().length === 0, 'a second spectator: the players hear it, the first spectator does not');
cat.ws.close(); await wait(200);
const cat2 = await client('cat'); cat2.send({ type: 'watch', code: ann.room.code, name: 'Cat' }); await until(() => cat2.room); await wait(400);
ok(ann.seen().length === 2, 'the same tab coming back (reload) is not announced again');
const anon = await client('zed'); anon.send({ type: 'watch', code: ann.room.code }); await until(() => ann.seen().length === 3);
ok(ann.seen()[2]?.name === '', 'a nameless spectator comes through with an empty name (the page says "Someone is watching")');
console.log(fails ? `FAIL ${fails}` : 'PASS'); process.exit(fails ? 1 : 0);
