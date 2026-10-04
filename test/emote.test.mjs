// Emotes (NOTES 205): a spectator's or a player's pick reaches everyone in the court (players and spectators, the sender too) with its name,
// one per 0.9 s per socket (the client waits 1 s), only a valid index (0-9), never into another court.   EMOTE_PORT=<port> moves the server.
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
await wait(300); cat.send({ type: 'emote', e: 3 }); await wait(400);
ok(ann.emotes().length === 1, 'the cooldown: a second emote 0.3 s later is dropped');
await wait(500); cat.send({ type: 'emote', e: 3 }); await until(() => ann.emotes().length === 2);
ok(ann.emotes()[1]?.e === 3, 'one a second later gets through');
await wait(1000); for (let i = 0; i < 30; i++) cat.send({ type: 'emote', e: 4 }); await wait(400);
ok(ann.emotes().length === 3, `a burst of 30 at once lets one through (${ann.emotes().length - 2})`);
const had = ann.emotes().length;
dan.send({ type: 'emote', e: 9 }); await until(() => ann.emotes().length === had + 1);
ok(ann.emotes()[had]?.e === 9 && ann.emotes()[had]?.name === 'Dan', 'the cooldown is per person: Dan gets the tenth (0) through at once');
for (const e of [10, -1, 1.5, '2', null]) far.send({ type: 'emote', e });
const c0 = cat.emotes().length; await wait(1000); ann.send({ type: 'emote', e: 0 }); await until(() => cat.emotes().length === c0 + 1);
ok(far.emotes().length === 0 && eve.emotes().length === 0, 'bad indexes are dropped');
ok([ann, cat, dan].every(c => c.emotes().at(-1)?.e === 0 && c.emotes().at(-1)?.name === 'Ann'), 'a player emotes too: GG reaches the court with her name');
const n = ann.emotes().length;
far.send({ type: 'emote', e: 5 }); await until(() => eve.emotes().length);
ok(eve.emotes()[0]?.e === 5 && ann.emotes().length === n, "Far's emote stays in Eve's court");
console.log(fails ? `EMOTE FAIL (${fails})` : 'EMOTE PASS'); process.exit(fails ? 1 : 0);
