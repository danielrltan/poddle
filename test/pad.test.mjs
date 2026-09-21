// A phone as the paddle (NOTES 34): the phone's socket (?padfor=CODE) is passed on to the tab that named the code
// (?pad=CODE or {type:'padcode'}), and to nobody else; either side may come first or come back; a phone is never a player
// and never counted; what it sends is rebuilt, not forwarded.   PAD_PORT=<port> moves the server.
import { spawn } from 'child_process';
import WebSocket from 'ws';
const PORT = +process.env.PAD_PORT || 8360, root = new URL('..', import.meta.url).pathname;
const proc = spawn('node', ['server/game.js'], { cwd: root, env: { ...process.env, PORT }, stdio: 'ignore' });
process.on('exit', () => proc.kill());
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (f, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (f()) return true; await wait(20); } return !!f(); };
let fails = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
function sock(query) {
  const ws = new WebSocket(`ws://localhost:${PORT}/?${query}`), c = { ws, log: [], closed: false };
  ws.on('message', raw => { const m = JSON.parse(raw); if (m.type !== 'state') c.log.push(m); }); ws.on('error', () => {}); ws.on('close', () => { c.closed = true; });
  c.send = o => ws.send(typeof o === 'string' ? o : JSON.stringify(o)); c.of = t => c.log.filter(m => m.type === t); c.last = t => c.of(t).pop();
  return new Promise(r => ws.on('open', () => r(c)));
}
const S = (t, x = 0) => ({ type: 'm', t, q: [0, 0, 0, 1], r: [x, 0, 0], a: [0, 0, 0] });
const status = async () => (await fetch(`http://localhost:${PORT}/status.json`)).json();
await wait(700);

const tab = await sock('lobby=1&cid=tab1&pad=ABC234'), other = await sock('lobby=1&cid=tab2&pad=XYZ789');
const phone = await sock('padfor=abc234');                     // typed in lower case
await until(() => phone.last('padhost') && tab.last('pad'));
ok(phone.last('padhost').on === true, 'the phone hears its computer is there');
ok(tab.last('pad').on === true && !other.of('pad').length, 'the tab hears its phone arrived; another tab hears nothing');
ok(!phone.of('lobby').length && !phone.of('welcome').length, 'a phone is in no lobby and on no court');
{ const st = await status(); ok(st.online === 2 && st.phones === 1, `status.json counts 2 online and 1 phone (${st.online}, ${st.phones})`); }

for (let i = 1; i <= 5; i++) phone.send(S(i / 60, i));
await until(() => tab.of('m').length === 5);
ok(tab.of('m').length === 5 && tab.of('m')[4].r[0] === 5 && tab.of('m')[4].q.length === 4, 'five samples reach the tab, in order');
ok(!other.of('m').length, 'and no other tab');

phone.send({ type: 'm', t: 1, q: [0, 0, 0, 1], r: [0, 0, 0], a: [0, 0, 0], extra: 'x', side: 1 }); await until(() => tab.of('m').length === 6);
ok(!('extra' in tab.of('m')[5]) && !('side' in tab.of('m')[5]), 'a sample is rebuilt: extra fields do not travel');
for (const bad of [{ type: 'm', t: 'x', q: [0, 0, 0, 1], r: [0, 0, 0], a: [0, 0, 0] }, { type: 'm', t: 1, q: [0, 0, 1], r: [0, 0, 0], a: [0, 0, 0] }, { type: 'm', t: 1, q: [0, 0, 0, null], r: [0, 0, 0], a: [0, 0, 0] },
  { type: 'room', code: 'EVIL', role: 'player' }, { type: 'welcome', side: 1 }, { type: 'create', public: true, name: 'Phone' }, { type: 'padkey', k: 'q' }, '{not json', '[]', 'null']) phone.send(bad);
await wait(300);
ok(tab.of('m').length === 6 && !tab.of('room').length && !tab.of('welcome').length && !tab.of('padkey').length, 'bad samples, server words and lobby requests from a phone go nowhere');
{ const st = await status(); ok(st.courts === 0, 'a phone cannot make a court'); }
phone.send({ type: 'padkey', k: 'c' }); await until(() => tab.of('padkey').length);
ok(tab.last('padkey') && tab.last('padkey').k === 'c', 'Calibrate pressed on the phone reaches the tab');
phone.send({ type: 'ping', c: 7 }); await until(() => phone.of('pong').length);
ok(phone.last('pong') && phone.last('pong').c === 7, 'the phone can time its round trip');

tab.send({ type: 'padfx', fx: 'hit', n: 0.6 }); other.send({ type: 'padfx', fx: 'hit', n: 1 }); tab.send({ type: 'padfx', fx: 'nonsense' }); await until(() => phone.of('fx').length);
await wait(150);
ok(phone.of('fx').length === 1 && phone.of('fx')[0].fx === 'hit' && phone.of('fx')[0].n === 0.6, 'a hit buzzes this tab\'s phone only, and only known words pass');

// the tab plays on while its phone streams: the game socket still works as a player's
tab.send({ type: 'create', public: false, name: 'Tab' }); await until(() => tab.of('room').length);
ok(tab.last('room') && tab.last('room').role === 'player', 'the tab takes a seat as usual');
phone.send(S(2)); await until(() => tab.of('m').length === 7); ok(tab.of('m').length === 7, 'samples keep arriving while seated');

// a reloaded phone page replaces the old socket
const phone2 = await sock('padfor=ABC234'); await until(() => phone.closed);
ok(phone.closed, 'a second phone on the code replaces the first');
await wait(100); ok(tab.last('pad').on === true, 'the tab still has a phone (the newcomer)');
phone2.send(S(3)); await until(() => tab.of('m').length === 8); ok(tab.of('m').length === 8, 'the new phone is heard');
phone2.ws.close(); await until(() => tab.last('pad').on === false); ok(tab.last('pad').on === false, 'the phone leaving is told to the tab');

// phone first, tab later (a reconnect after a restart, in either order); the code can also be named by message
const early = await sock('padfor=LATE22'); await until(() => early.last('padhost'));
ok(early.last('padhost').on === false, 'a phone with no computer yet is told to wait');
const late = await sock('lobby=1&cid=tab3'); late.send({ type: 'padcode', code: 'LATE22' });
await until(() => early.last('padhost').on && late.last('pad'));
ok(early.last('padhost').on === true && late.last('pad').on === true, 'the tab arrives and names its code: both are told');
early.send(S(1)); await until(() => late.of('m').length === 1); ok(late.of('m').length === 1, 'and the samples flow');
late.ws.close(); await until(() => early.last('padhost').on === false); ok(early.last('padhost').on === false, 'the tab closing is told to the phone');

const junk = await sock('padfor=<script>'); await until(() => junk.closed);
ok(junk.closed && junk.last('padhost') && junk.last('padhost').bad, 'a malformed code is refused');

// 60 Hz for a while stays inside the message budget
const tab4 = await sock('lobby=1&cid=tab4&pad=FAST99'), fast = await sock('padfor=FAST99'); await until(() => tab4.last('pad'));
for (let i = 0; i < 180; i++) { fast.send(S(10 + i / 60)); await wait(1000 / 60); }
await wait(200); ok(tab4.of('m').length === 180, `three seconds at 60 Hz all arrive (${tab4.of('m').length}/180)`);

console.log(fails ? `\nFAIL: ${fails}` : '\nPASS'); process.exit(fails ? 1 : 0);
