// Load probe (NOTES 197): N courts of two fake players, each sending paddle positions at 60 Hz, against one local server. Prints the
// server's CPU and RSS and the state-packet interval the clients see (60 Hz = 16.7 ms; a wide p99 is a stalling loop).
//   node test/load.mjs <courts> [seconds]        ROOM_CAP=200 node test/load.mjs 150     (the server's cap is 40 without it)
// 2026-10-04 on an M-series core: 40 courts 22% CPU, 120 courts 35%, 200 courts 40% / 99 MB, p99 tick under 30 ms throughout.
import { spawn, execSync } from 'child_process'; import WebSocket from 'ws';
const N = +process.argv[2] || 20, SECS = +process.argv[3] || 10, PORT = +process.env.LOAD_PORT || 8970, root = new URL('..', import.meta.url).pathname;
const wait = ms => new Promise(r => setTimeout(r, ms));
const srv = spawn('node', ['--disable-warning=ExperimentalWarning', 'server/game.js'], { cwd: root, env: { ...process.env, PORT, PODDLE_DB: ':memory:', NODE_ENV: 'production' }, stdio: 'ignore' });
process.on('exit', () => { try { srv.kill(); } catch { /* gone */ } });   // a crashed run must not leave a server holding the port and its courts
await wait(900);
const gaps = [], clients = [];
function client(ip) { const ws = new WebSocket(`ws://localhost:${PORT}/?lobby=1`, { headers: { 'fly-client-ip': ip } }), c = { ws, last: 0 };   // one address per court: ADDR_ROOMS caps courts per address
  ws.on('message', raw => { const m = JSON.parse(raw); if (m.type === 'lobby') c.lobby = true; if (m.type === 'welcome') c.side = m.side; if (m.type === 'room') c.room = m; if (m.type === 'joinfail') c.fail = m.reason;
    if (m.type === 'state') { const t = performance.now(); if (c.last && c.measuring) gaps.push(t - c.last); c.last = t; } });
  ws.on('error', () => {}); c.send = o => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); }; clients.push(c); return c; }
const until = async (f, ms = 5000) => { const t = Date.now(); while (Date.now() - t < ms) { if (f()) return true; await wait(10); } return false; };
let made = 0;
for (let i = 0; i < N; i++) {
  const ip = `10.${(i >> 8) & 255}.${i & 255}.1`, a = client(ip), b = client(ip + '0');
  await until(() => a.lobby && b.lobby); a.send({ type: 'create', public: false });
  if (!await until(() => a.side != null || a.fail) || a.fail) { console.log(`create failed at court ${i + 1}: ${a.fail || 'timeout'}`); break; }
  b.send({ type: 'join', code: a.room.code });
  if (!await until(() => b.side != null || b.fail) || b.fail) { console.log(`join failed at court ${i + 1}: ${b.fail || 'timeout'}`); break; }
  made++;
}
console.log(`courts: ${made} (${clients.length} sockets)`);
let swings = 0;   // every player moves at 60 Hz and swings now and then
const movers = clients.map(c => { let ph = Math.random() * 6; return setInterval(() => { ph += 0.05; c.send({ type: 'paddle', x: Math.sin(ph) * 0.8, y: 1 + Math.cos(ph * 1.3) * 0.3, z: 6.5, q: [0, 0, 0, 1] }); if (Math.random() < 0.01) { swings++; c.send({ type: 'swing', power: 25, dir: 0.1, lob: 0 }); } }, 1000 / 60); });
await wait(2000); for (const c of clients) c.measuring = true;
const cpu = () => { try { return execSync(`ps -o %cpu=,rss= -p ${srv.pid}`).toString().trim().split(/\s+/); } catch { return ['?', '?']; } };
const samples = []; let rss = '?';
for (let s = 0; s < SECS; s++) { await wait(1000); const [pc, r] = cpu(); samples.push(+pc); rss = Math.round(r / 1024); process.stdout.write(`  t+${s + 1}s cpu ${pc}% rss ${rss} MB\r`); }
console.log();
gaps.sort((a, b) => a - b); const q = p => gaps[Math.floor(gaps.length * p)].toFixed(1);
console.log(`state packets: ${gaps.length}; interval ms p50 ${q(0.5)} p90 ${q(0.9)} p99 ${q(0.99)} max ${gaps[gaps.length - 1].toFixed(1)} (ideal 16.7)`);
console.log(`server cpu avg ${(samples.reduce((a, b) => a + b, 0) / samples.length).toFixed(0)}% peak ${Math.max(...samples)}%, rss ${rss} MB; swings ${swings}`);
for (const m of movers) clearInterval(m); for (const c of clients) c.ws.close(); srv.kill(); process.exit(0);
