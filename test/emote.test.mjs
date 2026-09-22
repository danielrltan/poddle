// Spectator emotes: a spectator's pick reaches everyone in the court (players and spectators, the sender too) with its name,
// with no cooldown a person can feel (60 ms per socket stops a flood), only a valid index, only from a spectator, never into another court.   EMOTE_PORT=<port> moves the server.
import { spawn } from 'child_process';
import WebSocket from 'ws';
const PORT = +process.env.EMOTE_PORT || 8350, root = new URL('..', import.meta.url).pathname;
const proc = spawn('node', ['server/game.js'], { cwd: root, env: { ...process.env, PORT }, stdio: 'ignore' });
process.on('exit', () => proc.kill());
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (f, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (f()) return true; await wait(20); } return !!f(); };
let fails = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
function client(name) {
  const ws = new WebSocket(`ws://localhost:${PORT}/?lobby=1&cid=${name}`), c = { ws, log: [] };
  ws.on('message', raw => { const m = JSON.parse(raw); if (m.type !== 'state') c.log.push(m); if (m.type === 'room') c.room = m; }); ws.on('error', () => {});
  c.send = o => ws.send(JSON.stringify(o)); c.emotes = () => c.log.filter(m => m.type === 'emote');
  return new Promise(r => ws.on('open', () => r(c)));
}
await wait(700);
const ann = await client('ann'), cat = await client('cat'), dan = await client('dan'), eve = await client('eve'), far = await client('far');
ann.send({ type: 'create', public: true, name: 'Ann' }); await until(() => ann.room);
cat.send({ type: 'watch', code: ann.room.code, name: 'Cat' }); dan.send({ type: 'watch', code: ann.room.code, name: 'Dan' });
eve.send({ type: 'create', public: false, name: 'Eve' }); await until(() => cat.room && dan.room && eve.room);
far.send({ type: 'watch', code: eve.room.code, name: 'Far' }); await until(() => far.room);
ok(cat.room.role === 'spectator' && far.room.role === 'spectator', 'Cat, Dan and Far are watching');

cat.send({ type: 'emote', e: 0 });
await until(() => ann.emotes().length && dan.emotes().length && cat.emotes().length);
ok([ann, cat, dan].every(c => c.emotes().length === 1 && c.emotes()[0].e === 0 && c.emotes()[0].name === 'Cat'), 'the player, the other spectator and the sender all get {e:0, name:Cat}');
await wait(120); cat.send({ type: 'emote', e: 3 }); await until(() => ann.emotes().length === 2);
ok(ann.emotes()[1]?.e === 3, 'no cooldown: a second emote a moment later gets through');
for (let i = 0; i < 30; i++) cat.send({ type: 'emote', e: 4 }); await wait(400);
ok(ann.emotes().length < 6, `a script's burst of 30 at once is mostly dropped (${ann.emotes().length - 2} got through)`);
const had = ann.emotes().length; await wait(100);
dan.send({ type: 'emote', e: 6 }); await until(() => ann.emotes().length === had + 1);
ok(ann.emotes()[had]?.e === 6 && ann.emotes()[had]?.name === 'Dan', 'Dan gets through too');
for (const e of [7, -1, 1.5, '2', null]) far.send({ type: 'emote', e });
const n = ann.emotes().length; ann.send({ type: 'emote', e: 1 }); await wait(400);
ok(far.emotes().length === 0 && eve.emotes().length === 0, 'bad indexes are dropped');
ok(ann.emotes().length === n, 'a player cannot emote');
far.send({ type: 'emote', e: 5 }); await until(() => eve.emotes().length);
ok(eve.emotes()[0]?.e === 5 && ann.emotes().length === n, "Far's emote stays in Eve's court");
console.log(fails ? `EMOTE FAIL (${fails})` : 'EMOTE PASS'); process.exit(fails ? 1 : 0);
