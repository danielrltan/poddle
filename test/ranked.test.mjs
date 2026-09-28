// Ranked, server side (docs/RANKED.md 3-5, 9, 11.1): the queue waits in the lobby, rkwarm is an optional warm-up court vs Matt (OPTIONAL WARM-UP 2026-09-28), two queued players are pulled into one private series room
// (best of 3, games to RK_WIN), every game is judged and logged (mode ladder), trophies settle once per series, Matt pays a capped bounty, refusals,
// forfeits, no-shows, reconnects, restarts, and no cid / owner id / opponent count in any Ranked frame. Scripted ws clients, every clock shrunk by env.
//   RANKED_PORT=<base> moves the six servers (base .. +5; default 8630-8635). Runs in about five minutes.
import { spawn } from 'child_process';
import WebSocket from 'ws';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const PORT = +process.env.RANKED_PORT || 8630, P_CAP = PORT + 1, P_BOOT = PORT + 2, P_ADDR = PORT + 3, P_GP = PORT + 4, P_AFK = PORT + 5, root = new URL('..', import.meta.url).pathname;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'poddle-rk-')), DBA = path.join(tmp, 'a.db'), DBB = path.join(tmp, 'b.db');
const env = { AUTOBOT: '1', SWING_SERVE: '0', READY_S: '0', WIN_BY: '1', RK_WIN: '1', RK_BEST: '3', RK_GOLD: '3', RK_VS_S: '0.3', RK_GAME_GAP_S: '0.3', RK_DONE_S: '0.5', RK_ARRIVE_S: '1', RK_WINDOW_S: '1', RK_CAP: '20',
  HOLD_S: '1', ROOM_TTL: '0.5', STATS_FORFEIT_MIN: '1', STATS_AFK_MIN: '0', STATS_ESTABLISHED: '0', STATS_MIN_POINT_S: '0', TIMESCALE: '2', TOUR_VS_S: '0.3', TOUR_ARRIVE_S: '1', TOUR_GAP_S: '0.3', TOUR_WIN: '1', TOUR_FINAL: '1' };   // every game is one point; short clocks; every Matt game counts
const procs = new Map(), logs = new Map();
const up = (port, more) => new Promise(res => { const p = spawn('node', ['server/game.js'], { cwd: root, env: { ...process.env, PORT: port, ...env, ...more } }); procs.set(port, p); logs.set(port, (logs.get(port) || '') );
  const eat = d => { logs.set(port, logs.get(port) + d); if (/game server on port/.test(d)) res(p); }; p.stdout.on('data', eat); p.stderr.on('data', d => { logs.set(port, logs.get(port) + d); if (!/ExperimentalWarning|trace-warnings/.test(d)) process.stderr.write(d); }); });
const killAll = () => procs.forEach(p => p.kill());
process.on('exit', () => { killAll(); fs.rmSync(tmp, { recursive: true, force: true }); }); process.on('unhandledRejection', e => { console.error(e); killAll(); process.exit(1); });
await Promise.all([up(PORT, { PODDLE_DB: DBA }), up(P_CAP, { ROOM_CAP: '6', PODDLE_DB: path.join(tmp, 'c.db') }), up(P_BOOT, { REVIVE_S: '3', PODDLE_DB: DBB }), up(P_ADDR, { RK_ADDR: '1', RK_MATT_DAY: '12', PODDLE_DB: path.join(tmp, 'd.db') }),
  up(P_GP, { RK_WIN: '2', RK_GOLD: '3', CAL_S: '2', STATS_ESTABLISHED: '1', PODDLE_DB: path.join(tmp, 'e.db') }),
  up(P_AFK, { STATS_AFK_MIN: '2', RK_WIN: '2', RK_GOLD: '3', CAL_S: '2', READY_S: '2', STATS_ESTABLISHED: '1', PODDLE_DB: path.join(tmp, 'f.db') })]);   // P_AFK: R9 on (2 contacts a seat), a 3-2-1 before each serve; P_GP and P_AFK: R11c on
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (f, ms = 5000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await f()) return true; await wait(20); } return !!(await f()); };
let fails = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let seq = 0, ipn = 0; const all = [], CIDS = [], DEVS = [], IPS = [];
const ip = () => { const a = `203.0.113.${++ipn}`; IPS.push(a); return a; };                         // TEST-NET-3: one fresh "computer" per call (the loopback peer makes the header trusted)
const dev = () => { const d = crypto.randomUUID(); DEVS.push(d); return d; };
// A tab: hello{dev} first thing (a distinct computer per client unless told otherwise), everything kept in log and raw, a paddle per state while ready, play(): a behaviour
function client(q = '', port = PORT, o = {}) {
  const cid = o.cid === null ? null : o.cid || 'rkCidX' + (++seq) + 'zq'; if (cid) CIDS.push(cid);
  const addr = o.addr === null ? null : o.addr || ip(), d = o.dev === null ? null : o.dev || dev(), headers = {}; if (addr) headers['fly-client-ip'] = addr;
  const ws = new WebSocket(`ws://localhost:${port}/?lobby=1${cid ? '&cid=' + cid : ''}${q}`, { headers }), c = { ws, cid, addr, d, port, log: [], raw: [], closed: false, ready: false, play: null, st: null };
  ws.on('open', () => { if (d) ws.send(JSON.stringify({ type: 'hello', dev: d, v: 1 })); if (o.nostats) ws.send('{"type":"nostats"}'); });
  ws.on('message', raw => { const m = JSON.parse(raw);
    if (m.type === 'state') { c.st = m; if (c.play) c.play(m); else if (c.ready) ws.send('{"type":"paddle","auto":true,"q":[0,0,0,1]}'); return; }
    c.raw.push(String(raw)); c.log.push(m);
    if (m.type === 'lobby') c.lobby = m; if (m.type === 'room') { c.room = m; c.welcome = c.info = null; } if (m.type === 'closed') c.room = null; if (m.type === 'welcome') { c.welcome = m; c.side = m.side; } if (m.type === 'botinfo') c.info = m;
    if (m.type === 'joinfail' || m.type === 'rkfail') c.fail = m; if (m.type === 'rk') c.rk = m; if (m.type === 'rkres') c.res = m; });
  ws.on('close', () => { c.closed = true; }); ws.on('error', () => {});
  c.send = x => { if (ws.readyState === 1) ws.send(typeof x === 'string' ? x : JSON.stringify(x)); }; c.got = (t, f) => c.log.filter(m => m.type === t && (!f || f(m))); c.last = t => c.got(t).pop(); c.n = t => c.got(t).length;
  c.mark = () => { c.log.length = 0; c.fail = null; c.res = null; };
  c.bail = () => { c.send({ type: 'leave' }); c.room = null; };
  all.push(c); return new Promise(r => ws.on('open', () => r(c)));
}
const lobbied = async (q, port, o) => { const c = await client(q, port, o); await until(() => c.lobby); return c; };
const status = async port => (await fetch(`http://localhost:${port}/status.json`)).json();
const api = async (port, p, body, addr) => (await fetch(`http://localhost:${port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: `http://localhost:${port}`, 'fly-client-ip': addr }, body: JSON.stringify(body) })).json();
const ladderOf = async (c, port = c.port) => ((await api(port, '/api/stats', { dev: c.d }, c.addr)).profile || {}).ladder || null;
// behaviours (test/stats.test.mjs): hit returns everything and serves hard; still is ready and never swings (a serve goes by itself under SWING_SERVE 0)
function hit(c) { let cool = 0; c.ready = true; c.play = m => { c.send({ type: 'paddle', auto: true, q: [0, 0, 0, 1] });
  const me = m.paddles[c.side], s = c.side === 0 ? 1 : -1; if (!me || Date.now() < cool) return;
  if (m.live && Math.abs(m.p[0] - me.x) < 0.9 && Math.abs(m.p[1] - me.y) < 0.8 && -(m.p[2] - me.z) * s < 1.0 && -(m.p[2] - me.z) * s > -0.5 && m.v[2] * s > 0) {
    cool = Date.now() + 400; c.send({ type: 'swing', power: 14 + Math.random() * 16, dir: (Math.random() - 0.5) * 1.6, lob: 0, final: true, pk: 22, src: 'airpod' }); } }; }
const still = c => { c.ready = true; c.play = null; };
// rally(c, n): returns the first n balls of every point, then lets the next one go (a seat with real contacts that still loses the point)
function rally(c, n) { let cool = 0, key = '', k = 0; c.ready = true; c.play = m => { c.send({ type: 'paddle', auto: true, q: [0, 0, 0, 1] });
  const me = m.paddles[c.side], s = c.side === 0 ? 1 : -1; if (!me || Date.now() < cool) return; const sc = m.score.join(); if (sc !== key) { key = sc; k = 0; }
  if (k < n && m.live && Math.abs(m.p[0] - me.x) < 0.9 && Math.abs(m.p[1] - me.y) < 0.8 && -(m.p[2] - me.z) * s < 1.0 && -(m.p[2] - me.z) * s > -0.5 && m.v[2] * s > 0) {
    cool = Date.now() + 400; k++; c.send({ type: 'swing', power: 18, dir: (Math.random() - 0.5) * 0.6, lob: 0, final: true, pk: 22, src: 'airpod' }); } }; }
// into the queue: waiting in the lobby (rk phase queue, warm false), or a VS card at once (rk phase vs), or a refusal. A fresh answer each time (c.rk may be an old one)
async function queue(c, name = 'P') { c.rk = null; c.fail = null; c.send({ type: 'rk', name }); await until(() => c.fail || (c.rk && (c.rk.phase === 'queue' || c.rk.phase === 'vs'))); return c; }
// the optional warm-up: rkwarm from the lobby seats a queued player on a private court against Matt (room kind warm), or rkfail busy { warm: true }
async function warm(c) { c.fail = null; c.send({ type: 'rkwarm' }); await until(() => inWarm(c) || c.fail); return c; }
const inWarm = c => !!(c.room && c.room.rk === true && c.room.kind === 'warm' && c.welcome && c.welcome.role === 'player');
const inLobbyQ = c => !!(c.rk && c.rk.phase === 'queue' && c.rk.warm === false);   // queued, waiting in the lobby (no court)
const inMatch = c => !!(c.room && c.room.rk === true && c.room.kind === 'match' && c.welcome && c.welcome.role === 'player');
const R = (tier, div = 1) => ({ tier, div });                   // a rank on the wire (DIVISIONS)
const lastRank = c => (c.got('names').at(-1) || c.welcome || {}).rank;   // the seats' ranks as last told (welcome is sent before the second seat arrives)
// two fresh computers into one series: a queues and takes the warm-up (o.lobby: waits in the lobby instead), b queues (paired), both seated
async function pairUp(port = PORT, o = {}) {
  const a = await lobbied('', port, o.a), b = await lobbied('', port, o.b);
  await queue(a, o.na || 'Ann'); if (!o.lobby) await warm(a); await queue(b, o.nb || 'Ben');
  await until(() => a.got('rkvs').length && b.got('rkvs').length, 3000); await until(() => inMatch(a) && inMatch(b), 4000);
  return [a, b];
}
const bye = (...cs) => cs.forEach(c => { try { c.ws.close(); } catch { /* gone */ } });
const DAY = 86400e3;
// the test's own connection to the base server's database file (seeding ranks, reading rows): the same node:sqlite, a second process
process.env.RK_MATT_DAY = '12';
const db = require('../server/db.js'), auth = require('../server/auth.js'), LAD = require('../server/ladder.js');
await wait(300);

console.log('1. queue alone: waiting in the lobby (no court); rkwarm: a private warm-up vs Matt, unlisted, unjoinable; leaving it keeps the queue place');
{ const a = await lobbied(); await queue(a, 'Ann<b>');
  ok(inLobbyQ(a) && !a.room && a.rk.you.tier === 1 && a.rk.you.div === 1 && a.rk.you.trophies === 0 && a.rk.you.floor === 0 && a.rk.you.divFloor === 0 && a.rk.you.next === 150 && a.rk.you.nextDiv === 50 && a.rk.you.best === 1 && a.rk.you.bestDiv === 1 && a.rk.queued === 1 && a.rk.place === 1 && typeof a.rk.since === 'number', `rk from the lobby: rk { phase queue, warm false }, no room (${JSON.stringify(a.rk)})`);
  let s = await status(PORT); ok(s.rk && s.rk.queued === 1 && s.rk.series === 0 && s.courts === 0, `/status.json rk { queued: 1, series: 0 }, no court made (${JSON.stringify(s)})`);
  const look = await lobbied(); await until(() => look.lobby && look.lobby.rk && look.lobby.rk.queued === 1);
  ok(look.lobby.rk.queued === 1 && look.lobby.rooms.length === 0, `a bystander's lobby says rk.queued 1 and lists no room (${JSON.stringify(look.lobby.rk)}, ${look.lobby.rooms.length} rooms)`);
  a.mark(); look.send({ type: 'create', public: true, name: 'L' }); await until(() => look.room); ok(await until(() => a.got('lobby', m => m.rooms.length === 1).length), 'the queued socket still hears the lobby pushes (a court opened)'); look.bail(); await until(() => look.lobby && !look.room);
  for (const t of ['quick', 'create', 'join', 'watch', 'tcreate']) { a.fail = null; a.send({ type: t, code: 'ABCD', public: true, name: 'Ann' }); await until(() => a.fail); ok(a.fail && a.fail.type === 'joinfail' && a.fail.reason === 'inrk' && !a.room, `queued: ${t} is refused with joinfail inrk (${JSON.stringify(a.fail)})`); }
  await wait(2700); s = await status(PORT);
  ok(inLobbyQ(a) && !a.room && s.rk.queued === 1 && !a.got('rkend').length && !a.got('rk', m => m.phase === 'off').length, `past ROOM_TTL, RK_ARRIVE_S and HOLD_S an open lobby entry is still queued (${JSON.stringify(s.rk)})`);
  a.mark(); await warm(a);
  ok(inWarm(a) && a.room.public === false && a.room.role === 'player', `rkwarm: room { rk:true, kind:'warm', public:false } (${JSON.stringify(a.room)})`);
  ok(await until(() => a.got('rk', m => m.phase === 'queue' && m.warm === true).length) && a.rk.since === a.got('rk')[0].since, 'and a snapshot with warm true, the wait clock unchanged');
  ok(a.welcome.venue === 'stadium' && eq(a.welcome.rank, a.welcome.side === 0 ? [R(1), null] : [null, R(1)]) && a.welcome.series === undefined, `welcome: venue stadium, rank [{ tier 1, div 1 }, null] (${JSON.stringify([a.welcome.venue, a.welcome.rank])})`);
  ok(await until(() => a.info && a.info.active && a.info.level === 0 && a.info.name === 'Rookie'), 'Matt sits down at once, at Rookie (the Bronze rank\'s level)');
  ok(a.got('names').every(m => Array.isArray(m.rank)), 'names carries rank');
  s = await status(PORT); ok(s.rk && s.rk.queued === 1 && s.rk.series === 0 && s.courts === 1, `/status.json rk { queued: 1, series: 0 }, one court (${JSON.stringify(s.rk)})`);
  look.send({ type: 'quick', name: 'Q' }); await until(() => look.room);
  ok(look.room && look.room.code !== a.room.code && look.room.public === true && !look.room.rk, 'quick play never lands in the warm-up: a fresh public court');
  look.bail(); await until(() => look.lobby && !look.room);
  const str = await lobbied(); str.send({ type: 'join', code: a.room.code, name: 'S' }); await until(() => str.fail || str.welcome);
  ok(str.fail && str.fail.reason === 'full' && str.fail.watch === true, `a stranger's join with the warm-up's code: joinfail full, watch (${JSON.stringify(str.fail)})`);
  str.send({ type: 'watch', code: a.room.code }); await until(() => str.welcome);
  ok(str.room && str.room.role === 'spectator' && str.room.rk === true && str.room.kind === 'warm' && str.welcome.venue === 'stadium', `watching a Ranked court: room { role: spectator, rk, kind } (${JSON.stringify(str.room)})`);
  str.send({ type: 'ask' }); await until(() => str.got('askstate').length);
  ok(str.last('askstate')?.s === 'refused' && str.last('askstate').why === 'rk', 'ask for Matt\'s seat: refused rk');
  a.send({ type: 'bot', level: 2 }); await until(() => a.got('botinfo', m => m.reason).length);
  ok(a.last('botinfo').reason === 'ranked' && a.last('botinfo').level === 0, 'bot { level }: botinfo reason ranked, the level unchanged');
  a.send({ type: 'pause', on: true }); ok(await until(() => a.got('paused', m => m.on === true).length), 'pause is allowed in the warm-up (one human)'); a.send({ type: 'pause', on: false });
  a.mark(); a.send({ type: 'rk' }); await until(() => a.got('rk').length);
  ok(a.last('rk').phase === 'queue' && a.last('rk').warm === true && a.n('room') === 0, 'rk while queued: a fresh snapshot, nothing else');
  a.mark(); a.send({ type: 'rkwarm' }); await wait(300); ok(!a.got('room').length && !a.got('rkfail').length && inWarm(a), 'rkwarm on the warm-up court: ignored');
  a.mark(); a.bail(); ok(await until(() => a.got('lobby').length && a.got('rk', m => m.phase === 'queue' && m.warm === false).length) && !a.got('closed').length && !a.got('rk', m => m.phase === 'off').length, `leave from the warm-up: back in the lobby STILL QUEUED, rk { queue, warm false }, no closed (${a.log.map(m => m.type + (m.phase || '')).join(' ')})`);
  ok(await until(async () => (await status(PORT)).rk.queued === 1 && (await status(PORT)).courts === 0), 'the warm-up court went, the queue place stayed');
  ok(await until(() => str.got('closed', m => m.reason === 'empty').length === 1), 'its spectator heard closed empty');
  a.mark(); await warm(a); ok(a.fail && a.fail.why === 'busy' && a.fail.warm === true && !a.room && (await status(PORT)).rk.queued === 1, `rkwarm right after a warm-up closed: rkfail busy { warm: true }, still queued (${JSON.stringify(a.fail)})`);
  await wait(1100); a.mark(); await warm(a); ok(inWarm(a) && a.got('rk', m => m.warm === true).length >= 1, 'after RK_WARM_COOL_S: Warm up again, a new court');
  a.mark(); a.send({ type: 'rkleave' }); a.room = null; ok(await until(() => a.got('lobby').length && a.got('rk', m => m.phase === 'off').length) && !a.got('closed').length, `rkleave on the warm-up: out of the court (quietly, as leave) and the queue, rk phase off (${a.log.map(m => m.type + (m.phase || '')).join(' ')})`);
  ok(await until(async () => (await status(PORT)).rk.queued === 0 && (await status(PORT)).courts === 0), 'the warm-up went with them');
  a.mark(); a.send({ type: 'rkwarm' }); await wait(300); ok(!a.got('room').length && !a.got('rk').length && !a.got('rkfail').length && (await status(PORT)).courts === 0, 'rkwarm when not queued: ignored (no court, no answer)');
  bye(a, look, str); }

console.log('2. Matt games while queued: a loss pays 0, a win pays the bounty; the next game starts by itself; nostats and addr refusals');
{ const a = await lobbied(); still(a); await queue(a, 'Ann'); await warm(a);
  ok(await until(() => a.n('matchover') >= 1, 20000), 'a point against Matt ends a game (RK_WIN 1)');
  const mo = a.last('matchover'); ok(mo.rk && mo.rk.matt === true && typeof mo.rk.next === 'number' && mo.tour === undefined && Array.isArray(mo.rank) && !a.got('rematch').length, `matchover { rk: { matt, next } }, no tour, no vote (${JSON.stringify(mo.rk)})`);
  ok(await until(() => a.res && a.res.matt === true), `rkres arrives for the Matt game (${JSON.stringify(a.res)})`);
  ok(await until(() => a.got('rematchon').length, 3000) && a.room && a.room.kind === 'warm' && (await status(PORT)).rk.queued === 1, 'after the gap: rematchon, the next Matt game; the warm-up court and the queue place are kept');
  ok(await until(() => a.got('rkres', m => !m.won).length, 60000), `a loss to Matt (Rookie sometimes loses to a parked paddle: ${a.n('matchover')} games)`);
  const lost = a.got('rkres', m => !m.won)[0]; ok(lost.delta === 0 && lost.counted === true && lost.saved === true && lost.tier === 1 && lost.div === 1, `a loss pays 0 (${JSON.stringify(lost)})`);
  hit(a); ok(await until(() => a.got('rkres', m => m.won).length, 90000), `a win against Matt (${a.n('matchover')} games played)`);
  const wins = a.got('rkres', m => m.won), w1 = wins[0], wn = wins.length;
  ok(w1.saved === true && w1.delta === 10 && w1.trophies === 10 && w1.tier === 1 && w1.div === 1 && w1.tierWas === 1 && w1.divWas === 1 && w1.counted === true && w1.dayLeft === 30, `the first win: rkres { matt, saved, delta 10, trophies 10, dayLeft 30 } (${JSON.stringify(w1)})`);
  ok(wins.every((w, i) => w.delta === 10 && w.trophies === 10 * (i + 1) && w.dayLeft === 40 - 10 * (i + 1)), `every win pays 10 and the day count falls (${wn} wins)`);
  ok(await until(() => a.rk && a.rk.you.trophies === 10 * wn && a.rk.you.matt.dayLeft === 40 - 10 * wn, 2000), 'the snapshot follows');
  const lad = await ladderOf(a); ok(lad && lad.trophies === 10 * wn && lad.tier === 1 && lad.div === 1 + Math.min(2, Math.floor(wn / 5)) && lad.botWins === wn && lad.botLosses >= 1 && lad.wins === 0 && lad.mattDayLeft === 40 - 10 * wn && lad.best_div === lad.bestDiv, `/api/stats ladder: trophies, div, botWins, botLosses (${JSON.stringify(lad)})`);
  ok(/match recorded: bot Rookie ranked/.test(logs.get(PORT)), 'the Matt game was recorded as a bot game (the Beat Matt ladder)');
  a.send({ type: 'rkleave' }); await until(() => a.lobby && a.rk && a.rk.phase === 'off');   // out of the queue too (a leave alone keeps the place now)
  const ns = await lobbied('', PORT, { nostats: true }); await queue(ns, 'Off');
  ok(ns.fail && ns.fail.type === 'rkfail' && ns.fail.why === 'nostats' && !ns.room, 'a socket with stats off: rkfail nostats');
  const one = { addr: ip() }, x1 = await lobbied('', P_ADDR, one), x2 = await lobbied('', P_ADDR, one); await queue(x1, 'X1'); await queue(x2, 'X2');
  ok(inLobbyQ(x1) && x2.fail && x2.fail.why === 'addr' && !x2.room, `RK_ADDR 1: a second entry from one address: rkfail addr (${JSON.stringify(x2.fail)})`);
  bye(x1, x2); await until(async () => (await status(P_ADDR)).rk.queued === 0);   // nobody waiting on P_ADDR (a closed socket's entry is kept a moment, never counted or paired): the next entry waits instead of being paired
  const x3 = await lobbied('', P_ADDR, { addr: '2a01:4f8:c010:1234::1' }), x4 = await lobbied('', P_ADDR, { addr: '2a01:4f8:c010:1234:abcd::2' }); await queue(x3, 'X3'); await queue(x4, 'X4');
  ok(inLobbyQ(x3) && x4.fail && x4.fail.why === 'addr' && !x4.room, `the cap is per computer key: two addresses in one IPv6 /64 are one (${JSON.stringify(x4.fail)})`);
  bye(a, ns, x3, x4); }

console.log('3. a second human on another computer: both get the VS card, then one private series room');
{ const [a, b] = await pairUp();
  const va = a.last('rkvs'), vb = b.last('rkvs');
  ok(va && vb && va.side === 0 && vb.side === 1 && va.bestOf === 3 && va.target === 1 && va.at === 0.3 && va.friendly === false && va.vs.name === 'Ben' && vb.vs.name === 'Ann' && eq(va.vs, { name: 'Ben', reg: false, tier: 1, div: 1 }) && eq(va.you, { tier: 1, div: 1 }), `rkvs to both: side, bestOf 3, target, vs { name, reg, tier, div }, you { tier, div } (${JSON.stringify(va)})`);
  ok(!('trophies' in va.vs) && !('trophies' in vb.vs) && !('cid' in va.vs), 'the opponent\'s trophy count is never sent');
  ok(b.got('rk', m => m.phase === 'vs').length >= 1 && !b.got('room', m => m.kind === 'warm').length, 'the joiner never saw a warm-up: rk { phase: vs } settles it');
  ok(!a.got('closed').length && !b.got('closed').length, 'no closed to either player (the warm-up is left quietly)');
  ok(inMatch(a) && inMatch(b) && a.room.code === b.room.code && a.room.public === false && a.welcome.side === 0 && b.welcome.side === 1, `both seated in one room { rk, kind: match } (${JSON.stringify(a.room)})`);
  ok(eq(a.welcome.series, { game: 1, games: [0, 0], bestOf: 3 }) && a.welcome.venue === 'stadium' && eq(lastRank(b), [R(1), R(1)]), `welcome { series, venue, rank }, names { rank } (${JSON.stringify([b.welcome.series, lastRank(b)])})`);
  ok(await until(() => a.got('rkgo', m => m.game === 1).length && b.got('rkgo').length), 'rkgo game 1 once the seats are full');
  ok(!a.info || !a.info.active, 'no Matt in a series');
  const s = await status(PORT); ok(s.rk.queued === 0 && s.rk.series === 1, `/status.json rk { queued: 0, series: 1 } (${JSON.stringify(s.rk)})`);
  const str = await lobbied(); str.send({ type: 'join', code: a.room.code, name: 'S' }); await until(() => str.fail);
  ok(str.fail?.reason === 'full' && str.fail.watch === true, 'a third socket with the code: full, watch');
  str.send({ type: 'watch', code: a.room.code }); await until(() => str.welcome);
  ok(str.welcome.role === 'spectator' && eq(str.welcome.rank, [R(1), R(1)]) && str.welcome.series && str.welcome.series.bestOf === 3, `a spectator sees rank and the series (${JSON.stringify(str.welcome.rank)})`);
  a.send({ type: 'pause', on: true }); ok(await until(() => a.got('paused', m => m.refused).length), 'pause is refused in a series');
  a.send({ type: 'bot' }); ok(await until(() => a.got('botinfo', m => m.reason === 'ranked').length), 'bot is refused: reason ranked');
  a.send({ type: 'rkleave' }); await wait(300); ok(inMatch(a) && !a.got('rkend').length, 'rkleave in a live series: ignored');
  a.mark(); a.send({ type: 'rkwarm' }); await wait(300); ok(inMatch(a) && !a.got('room').length && !a.got('rkfail').length && (await status(PORT)).courts === 1, 'rkwarm in a live series: ignored');
  bye(a, b, str); await until(async () => (await status(PORT)).courts === 0, 6000);
  // both waiting in the lobby: the second one's rk pairs them, straight from the lobby to the VS card and the series (no warm-up court anywhere)
  const [c, d] = await pairUp(PORT, { lobby: true, na: 'Cal', nb: 'Dee' });
  ok(c.got('rkvs').length === 1 && d.got('rkvs').length === 1 && !c.got('room', m => m.kind === 'warm').length && !d.got('room', m => m.kind === 'warm').length && c.got('rk', m => m.phase === 'queue' && m.warm === false).length >= 1, 'two lobby entries: MATCH FOUND for both, neither ever had a warm-up court');
  ok(inMatch(c) && inMatch(d) && c.room.code === d.room.code && c.welcome.side === 0, `and both sit in one series room (${JSON.stringify(c.room)})`);
  bye(c, d); await until(async () => (await status(PORT)).courts === 0, 6000); }

console.log('4. best of 3: rkgame, rkgo, rkres to both exactly once, the rows, Play again');
{ const [a, b] = await pairUp(); hit(a); still(b);
  ok(await until(() => a.got('rkgame').length, 20000), 'game 1 ends: rkgame');
  const g1 = a.last('rkgame'); ok(g1.winner === 0 && eq(g1.score, [1, 0]) && eq(g1.games, [1, 0]) && g1.game === 1 && g1.bestOf === 3 && g1.serve === 1 && eq(g1.names, ['Ann', 'Ben']) && eq(g1.rank, [R(1), R(1)]) && g1.next === 0.3, `rkgame { winner, score, games [1,0], game 1, serve 1, names, rank, next } (${JSON.stringify(g1)})`);
  ok(inMatch(a) && !a.got('matchover').length && !a.got('rematch').length && !a.got('closed').length, 'the room stays open, no matchover, no vote');
  ok(await until(() => a.got('rkgo', m => m.game === 2).length, 3000), 'rkgo game 2 after the gap');
  const go = a.last('rkgo'); ok(eq(go.games, [1, 0]) && go.bestOf === 3, `rkgo { game 2, games [1,0], bestOf } (${JSON.stringify(go)})`);
  ok(await until(() => a.st && a.st.score.join() === '0,0'), 'the score is back to 0-0');
  ok(await until(() => a.got('serve').length >= 2, 5000) && a.got('serve').at(-1).by === 1, `the serve alternates per game (game 2 served by side 1: ${a.got('serve').map(m => m.by)})`);
  ok(await until(() => a.got('matchover').length && b.got('matchover').length, 20000), 'game 2 won by the same side: the series is over');
  const mo = a.last('matchover'); ok(mo.winner === 0 && mo.forfeit === false && mo.rk && mo.rk.done === true && eq(mo.rk.games, [2, 0]) && mo.rk.bestOf === 3 && mo.rk.game === 2 && eq(mo.rk.scores, [[1, 0], [1, 0]]) && typeof mo.rk.gap === 'number' && mo.tour === undefined && eq(mo.rank, [R(1), R(1)]), `matchover { rk: { games [2,0], scores, done, gap }, rank } (${JSON.stringify(mo.rk)})`);
  ok(await until(() => a.res && b.res) && a.n('rkres') === 1 && b.n('rkres') === 1, 'rkres to both, exactly once');
  ok(a.res.won === true && a.res.saved === true && a.res.counted === true && a.res.delta === 33 && a.res.trophies === 33 && a.res.tier === 1 && a.res.div === 1 && a.res.tierWas === 1 && a.res.divWas === 1 && a.res.floorHeld === false && eq(a.res.why, []) && eq(a.res.games, [2, 0]) && eq(a.res.scores, [[1, 0], [1, 0]]) && !a.res.matt && !a.res.void, `the winner: +33 (a sweep from equal counts) (${JSON.stringify(a.res)})`);
  ok(b.res.won === false && b.res.saved === true && b.res.counted === true && b.res.delta === 0 && b.res.trophies === 0 && b.res.floorHeld === true && b.res.tier === 1, `the loser: -20 held at Bronze's floor of 0 (delta ${b.res.delta}, floorHeld ${b.res.floorHeld})`);
  const la = await ladderOf(a), lb = await ladderOf(b);
  ok(la && la.trophies === 33 && la.div === 1 && la.wins === 1 && la.losses === 0 && la.streak === 1 && la.bestTrophies === 33 && la.bestTier === 1 && la.bestDiv === 1 && lb && lb.losses === 1 && lb.wins === 0 && lb.trophies === 0, `/api/stats ladder on both: ${JSON.stringify(la)} / ${JSON.stringify(lb)}`);
  ok(db.open(DBA) && db.ok(), 'the test opens the same database file');
  const oa = db.guestOwner(auth.deviceHash(a.d)), ob = db.guestOwner(auth.deviceHash(b.d));
  ok(oa != null && ob != null && db.recentPairs(oa, ob, Date.now() - DAY) === 1, `two counted games, ONE series between the pair (R10 by series: ${db.recentPairs(oa, ob, Date.now() - DAY)})`);
  const rows = db.exportOf(oa, Date.now()).matches.filter(m => m.mode === 'ladder');
  ok(rows.length === 2 && rows.every(r => r.kind === 'human' && r.counted && r.result === 'win' && r.trophyDelta === 33), `the export shows both games with mode ladder and trophyDelta +33 (${JSON.stringify(rows.map(r => [r.kind, r.mode, r.result, r.trophyDelta]))})`);
  ok(db.exportOf(ob, Date.now()).matches.filter(m => m.mode === 'ladder').every(r => r.trophyDelta === 0 && r.result === 'loss'), 'the loser\'s side of the same rows: trophyDelta 0 (the floor held)');
  ok((logs.get(PORT).match(/match recorded: human ranked/g) || []).length >= 2 && /ranked series over: side 0 2-0 \(\+33\/0\)/.test(logs.get(PORT)), 'the log lines: human ranked per game, the series line with codes and numbers only');
  ok(await until(() => a.got('closed', m => m.reason === 'round').length && b.got('closed', m => m.reason === 'round').length, 3000), 'closed round after RK_DONE_S');
  ok(a.lobby && !a.room && (await status(PORT)).courts === 0, 'both back in the lobby');
  // Play again from the finished card: a third player and the winner
  const [c, d] = await pairUp(PORT, { na: 'Cal', nb: 'Dee' }); hit(c); still(d);
  ok(await until(() => c.got('matchover').length, 40000) && !c.got('closed').length, 'another series, on its result card');
  c.mark(); c.send({ type: 'rkleave' }); await wait(150); ok(!c.got('rkend').length && !c.got('rk').length && c.room && c.room.kind === 'match', 'rkleave on the finished card: ignored');
  c.send({ type: 'rk' }); ok(await until(() => inLobbyQ(c) && c.got('lobby').length, 3000) && !c.got('room').length, `Play again (rk on the card, after that rkleave): out of the card, queued in the lobby (${c.log.map(m => m.type + (m.reason || m.phase || m.kind || '')).join(' ')})`);
  ok(c.rk.you.trophies === 33 && !d.got('closed').length, 'the new snapshot carries the new count; the other side keeps its card');
  bye(a, b, c, d); await until(async () => (await status(PORT)).courts === 0, 6000); }

console.log('5. queue order: a third player queues during a series and meets the first to Play again');
{ const [a, b] = await pairUp(); hit(a); still(b);
  const c = await lobbied(); await queue(c, 'Cal'); ok(inLobbyQ(c) && !c.room, 'C queues during A-B: waits in the lobby (nobody to pair with)');
  ok(await until(() => a.got('matchover').length, 40000), 'A-B ends');
  a.mark(); a.send({ type: 'rk' }); ok(await until(() => a.got('rkvs').length && c.got('rkvs').length, 4000), 'A\'s Play again: paired with C at once (rkvs to both)');
  ok(c.last('rkvs').side === 0 && a.last('rkvs').side === 1 && a.got('rk', m => m.phase === 'vs').length === 1, 'C waited longer: C is side 0; A heard rk phase vs, never a warm-up; C went from the lobby');
  ok(await until(() => inMatch(a) && inMatch(c), 4000) && a.room.code === c.room.code, `and both sit in one room (A: ${a.log.map(m => m.type + (m.reason || m.phase || m.kind || '')).join(' ')} | C: ${c.log.map(m => m.type + (m.reason || m.phase || m.kind || '')).join(' ')})`);
  bye(a, b, c); await until(async () => (await status(PORT)).courts === 0, 6000); }

console.log('6. forfeit, drop, reconnect, no-show, never ready');
{ const [a, b] = await pairUp(); hit(a); still(b);
  ok(await until(() => a.got('rkgame').length, 20000), 'one game in the book');
  b.bail(); ok(await until(() => a.got('matchover', m => m.forfeit).length), 'the loser leaves mid-series: forfeit at once');
  ok(await until(() => a.res && b.res), 'rkres to both (the leaver is in the lobby by now)');
  ok(a.res.won && a.res.counted && a.res.delta === 30 && eq(a.res.games, [1, 0]) && b.res.delta === 0 && b.res.floorHeld && b.res.counted === true && b.res.won === false, `stayer +30 with one counted game; leaver -20 (held at 0) (${JSON.stringify([a.res, b.res])})`);
  ok(eq(a.res.scores, [[1, 0]]) && eq(b.res.scores, [[1, 0]]) && eq(a.last('matchover').rk.scores, [[1, 0]]), `a forfeit on the card between games reports no phantom second game (${JSON.stringify(a.res.scores)})`);
  bye(a, b); await until(async () => (await status(PORT)).courts === 0, 6000);
  // stats switched off mid-series: the seat is forfeited at once, the loss lands on the identity frozen at pairing, the stayer's win stands
  { const [a, b] = await pairUp(); hit(a); still(b); ok(await until(() => a.got('rkgame').length, 20000), 'one game in the book');
    b.send('{"type":"nostats"}'); ok(await until(() => a.got('matchover', m => m.forfeit).length, 3000), 'nostats in a live series: a forfeit at once');
    ok(await until(() => a.res && b.res) && a.res.won && a.res.counted && a.res.delta === 30 && b.res.counted === true && b.res.saved === true && b.res.delta === 0 && b.res.floorHeld, `the stayer +30, the opt-out takes the loss on its frozen owner (${JSON.stringify([a.res, b.res])})`);
    const lb = await ladderOf(b); ok(lb && lb.losses === 1, `the ladder row behind the opted-out seat took the loss (${JSON.stringify(lb)})`);
    ok(b.fail && b.fail.why === 'nostats', 'and heard rkfail nostats'); b.mark(); b.send({ type: 'rk' }); await until(() => b.fail); ok(b.fail && b.fail.why === 'nostats' && !b.got('room').length, 'that socket cannot queue again');
    const c = await lobbied(); await queue(c, 'Cal'); await warm(c); c.send('{"type":"nostats"}');
    ok(await until(() => c.fail && c.fail.why === 'nostats', 3000) && await until(() => c.got('lobby').length >= 2) && await until(async () => (await status(PORT)).rk.queued === 0 && (await status(PORT)).courts === 0), 'nostats on a warm-up: out of the court (a lobby list follows, as after leave) and the queue');
    bye(a, b, c); await until(async () => (await status(PORT)).courts === 0, 6000); }
  const [c, d] = await pairUp(); still(c); still(d);
  ok(await until(() => c.got('serve').length || c.got('launch').length, 8000), 'a ball in play');
  d.bail(); ok(await until(() => c.res && d.res, 5000), 'a leave after the first strike with no game finished');
  ok(c.res.delta === 0 && c.res.counted === false && c.res.saved === true && eq(c.res.why, ['left_early']) && d.res.delta === 0 && d.res.won === false && d.res.counted === false && eq(d.res.why, ['left_early']) && d.res.saved === false, `stayer +0 left_early (nothing to save); the leaver owes a loss but has no owner yet: saved false (${JSON.stringify([c.res, d.res])})`);
  bye(c, d); await until(async () => (await status(PORT)).courts === 0, 6000);
  const [e, f] = await pairUp(); const code = e.room.code, side = e.welcome.side;
  e.ws.terminate(); ok(await until(() => f.got('hold').length), 'a drop mid-series: the seat is held');
  const e2 = await client(`&rk=1&room=${code}&name=Ann`, PORT, { cid: e.cid, addr: e.addr, dev: e.d });
  ok(await until(() => e2.welcome && e2.welcome.role === 'player' && e2.room && e2.room.kind === 'match' && e2.welcome.side === side && f.got('holdoff').length, 3000), `back with &rk=1&room=: the same seat, holdoff to the other side (${JSON.stringify(e2.room)})`);
  ok(await until(() => e2.rk && e2.rk.phase === 'match'), 'and an rk snapshot in phase match');
  await wait(1300); ok(!f.got('matchover').length, 'no forfeit after HOLD_S');
  e2.ws.terminate(); ok(await until(() => f.got('matchover', m => m.forfeit).length, 4000), 'dropped again and not back in HOLD_S: forfeit to the stayer');
  bye(e2, f); await until(async () => (await status(PORT)).courts === 0, 6000);
  // the drop / return loop is bounded: HOLD_MAX (2) holds a seat per room, the third drop is the forfeit at once
  { const [g, h] = await pairUp(); const code = g.room.code; let gx = g;
    for (let k = 1; k <= 2; k++) { gx.ws.terminate(); await until(() => h.got('hold').length, 2000); gx = await client(`&rk=1&room=${code}&name=Ann`, PORT, { cid: g.cid, addr: g.addr, dev: g.d }); ok(await until(() => h.got('holdoff').length === k, 3000) && gx.welcome && gx.welcome.role === 'player', `drop and return ${k}: the seat back`); await wait(150); }
    const t = Date.now(); gx.ws.terminate(); ok(await until(() => h.got('matchover', m => m.forfeit).length, 3000) && Date.now() - t < 800 && /dropped once too often a ranked match: forfeit/.test(logs.get(PORT)), `the third drop is a forfeit at once, no hold (${Date.now() - t} ms)`);
    bye(gx, h); await until(async () => (await status(PORT)).courts === 0, 6000); }
  // a held seat whose opponent then leaves wins the series: the rkres waits for its &rk=1 return (its socket was down when it settled)
  { const [e, f] = await pairUp(); const code = e.room.code; hit(e); still(f); ok(await until(() => e.got('rkgame').length, 20000), 'one game in the book');
    e.ws.terminate(); await until(() => f.got('hold').length, 2000); f.bail(); await until(async () => (await status(PORT)).rk.series === 0, 3000);
    const e2 = await client(`&rk=1&room=${code}&name=Ann`, PORT, { cid: e.cid, addr: e.addr, dev: e.d });
    ok(await until(() => e2.res || e2.got('rkend').length, 3000) && e2.res && e2.res.won && e2.res.counted && e2.res.delta === 30 && !e2.got('rkend').length, `back within the hold: the rkres it missed (won, +30), no rkend (${JSON.stringify(e2.res || e2.last('rkend'))})`);
    bye(e2, f); await until(async () => (await status(PORT)).courts === 0, 6000); }
  // a no-show: the partner's socket goes under the VS card
  const g = await lobbied(); await queue(g, 'Gil'); await warm(g); const h = await lobbied(); await queue(h, 'Hal'); await until(() => g.got('rkvs').length && h.got('rkvs').length);
  h.ws.terminate(); ok(await until(() => inMatch(g), 3000), 'G sits down alone');
  ok(await until(() => g.res && g.res.void === true, 4000) && eq(g.res.why, ['noshow']) && g.res.delta === 0 && g.res.counted === false, `the no-show after RK_ARRIVE_S: rkres void noshow (${JSON.stringify(g.res)})`);
  ok(await until(() => inLobbyQ(g) && g.got('closed', m => m.reason === 'round').length, 3000) && !g.room, 'G is back in the lobby, still queued (closed round, then rk { queue, warm false })');
  const i = await lobbied(); await queue(i, 'Ivy'); ok(await until(() => g.got('rkvs').length === 2 && i.got('rkvs').length, 3000) && g.last('rkvs').side === 0, 'and is first in line: paired at once as side 0');
  bye(g, i); await until(async () => (await status(PORT)).courts === 0, 6000);
  // never ready (CAL_S 2 on the pressure server): a seat that stalls in game 2 is out after CAL_S, a forfeit for the one who waited
  const [j, k] = await pairUp(P_GP); hit(j); still(k); ok(await until(() => j.got('rkgame').length, 25000), 'game 1 done (RK_WIN 2)');
  await until(() => j.got('rkgo', m => m.game === 2).length, 3000); k.ready = false; k.play = null; k.send({ type: 'status', cal: true });   // calibrating for ever from game 2
  ok(await until(() => k.got('closed', m => m.reason === 'away').length, 8000) && await until(() => j.res && j.res.won && eq(j.res.games, [1, 0]), 3000), `calibrating for CAL_S mid-series: closed away, a forfeit, the stayer's rkres (${JSON.stringify(j.res)})`);
  bye(j, k); await until(async () => (await status(P_GP)).courts === 0, 8000); }

console.log('7. never paired: one computer, one device; a capped pair plays a friendly (no trophies); R10 counts series');
{ const same = { addr: ip() }, a = await lobbied('', PORT, same), b = await lobbied('', PORT, same); await queue(a, 'A'); await queue(b, 'B');
  await warm(b); await wait(2500); ok(inLobbyQ(a) && inWarm(b) && !a.got('rkvs').length && !b.got('rkvs').length && (await status(PORT)).rk.queued === 2, 'two entries from one computer group (one waiting in the lobby, one warming up) are never paired');
  const c = await lobbied('', PORT, { dev: a.d }); await queue(c, 'C'); await wait(1500);
  ok(inLobbyQ(c) && !c.got('rkvs').length && !a.got('rkvs').length, 'one device id on two computers: never paired with itself');
  const d = await lobbied(); await queue(d, 'D'); ok(await until(() => d.got('rkvs').length, 3000) && d.last('rkvs').vs.name === 'A', 'a clean stranger pairs with the oldest of them');
  bye(a, b, c, d); await until(async () => (await status(PORT)).courts === 0, 6000);
  // R10: three counted series between two owners today -> the fourth is a friendly. Seed the rows (one series of three games counts once)
  const dx = dev(), dy = dev(), ox = db.ownerForDevice(auth.deviceHash(dx), Date.now(), { create: true }), oy = db.ownerForDevice(auth.deviceHash(dy), Date.now(), { create: true });
  const row = (series, i, winner = 0) => db.recordMatch({ now: Date.now() - 1000 + i, kind: 'human', winner, ending: 'won', score: [1, 0], secs: 5, ranked: true, flags: [], mode: 'ladder', series, seats: [{ owner: ox, record: true, bests: false }, { owner: oy, record: true, bests: false }] });
  row(901, 1); row(901, 2); row(901, 3);
  ok(db.recentPairs(ox, oy, Date.now() - DAY) === 1, 'three rows of one series: recentPairs 1');
  row(902, 4, 1); ok(db.recentPairs(ox, oy, Date.now() - DAY) === 2 && db.recentPairs(ox, oy, Date.now() - DAY, 902) === 1, 'two series: 2; the one named as in progress is left out');
  const x = await lobbied('', PORT, { dev: dx }), y = await lobbied('', PORT, { dev: dy }); await queue(x, 'X'); await warm(x); await queue(y, 'Y');
  ok(await until(() => x.got('rkvs').length && y.got('rkvs').length, 3000) && x.last('rkvs').friendly === false, 'the third series of the day is drawn clean');
  await until(() => inMatch(x) && inMatch(y), 4000); hit(x); still(y);
  x.res = y.res = null; ok(await until(() => x.res && !x.res.matt && y.res && !y.res.matt, 40000) && x.res.counted === true && x.res.delta === 33 && y.res.counted === true, `and COUNTS through game 2 (R10 never counts the series being played against itself) (${JSON.stringify(x.res)})`);
  ok(db.recentPairs(ox, oy, Date.now() - DAY) === 3, 'three series now');
  await until(() => x.got('closed').length && y.got('closed').length, 3000); x.mark(); y.mark(); await queue(x, 'X'); await queue(y, 'Y');
  ok(await until(() => x.got('rkvs').length && y.got('rkvs').length, 5000) && x.last('rkvs').friendly === true && y.last('rkvs').friendly === true, `after 2 x RK_WINDOW_S with no clean partner: paired as a friendly (${JSON.stringify(x.last('rkvs'))})`);
  await until(() => inMatch(x) && inMatch(y), 4000); hit(x); still(y);
  x.res = y.res = null; ok(await until(() => x.res && !x.res.matt && y.res && !y.res.matt, 40000) && x.res.delta === 0 && y.res.delta === 0 && x.res.counted === false && eq(x.res.why, ['not_counted']) && x.res.saved === true, `a friendly settles 0 both ways, not counted (${JSON.stringify(x.res)})`);
  ok((db.ladderOf(ox) || {}).wins === 1 && (db.ladderOf(oy) || {}).losses === 1, 'and changes no record (the one win / loss is the third series)');
  bye(x, y); await until(async () => (await status(PORT)).courts === 0, 6000); }

console.log('8. tier crossing and the sticky floor; the Matt ceiling; the day cap');
{ const da = dev(), oa = db.ownerForDevice(auth.deviceHash(da), Date.now(), { create: true });
  const sd = db.ladderApply({ owner: oa, delta: 147, won: true, vsBot: false, now: Date.now() });
  ok(sd && sd.tier === 1 && sd.div === 3 && sd.divWas === 1, `seed: 147 trophies (Bronze III) (${JSON.stringify(sd)})`);
  const a = await lobbied('', PORT, { dev: da }); hit(a); await queue(a, 'Ann'); await warm(a);
  ok(a.rk.you.trophies === 147 && a.rk.you.tier === 1 && a.rk.you.div === 3 && a.rk.you.nextDiv === 150 && a.rk.you.bestDiv === 3, `queued at 147, Bronze III (${JSON.stringify(a.rk.you)})`);
  ok(await until(() => a.res && a.res.won && a.res.delta > 0, 90000), 'a Matt win');
  ok(a.res.delta === 10 && a.res.trophies === 157 && a.res.tierWas === 1 && a.res.divWas === 3 && a.res.tier === 2 && a.res.div === 1, `crosses into Silver I: rkres { tierWas 1, divWas 3, tier 2, div 1, trophies 157 } (${JSON.stringify(a.res)})`);
  ok(await until(() => a.got('names', m => m.rank && eq(m.rank[a.side], R(2, 1))).length, 2000), 'names carries the new rank at once');
  ok(a.info && a.info.level === 0, 'Matt stays at the level the warm-up was made with');
  a.send({ type: 'rkleave' }); await until(() => a.rk && a.rk.phase === 'off');   // out of the queue (a leave from the warm-up would keep the place, and B would meet this entry instead of a2)
  const b = await lobbied(); await queue(b, 'Ben'); await warm(b); const a2 = await lobbied('', PORT, { dev: da }); await queue(a2, 'Ann');
  await until(() => inMatch(a2) && inMatch(b), 5000); ok(eq(a2.last('rkvs').you, R(2, 1)) && eq(b.last('rkvs').vs, { name: 'Ann', reg: false, tier: 2, div: 1 }) && eq(lastRank(b), [R(1), R(2, 1)]), `a Silver I emblem on the VS card and beside the name (${JSON.stringify([a2.last('rkvs').you, b.last('rkvs').vs, lastRank(b)])})`);
  hit(b); still(a2);
  ok(await until(() => a2.res && b.res, 40000), 'B beats A 2-0');
  ok(a2.res.delta === -7 && a2.res.trophies === 150 && a2.res.tier === 2 && a2.res.div === 1 && a2.res.floorHeld === true && a2.res.tierWas === 2 && a2.res.divWas === 1, `A owes 26 but the Silver floor holds: 150, floorHeld (${JSON.stringify(a2.res)})`);
  ok(b.res.delta === 39 && b.res.trophies === 39 && b.res.tier === 1 && b.res.div === 1, `B, 157 below, gets +36 +3 sweep = 39 (${b.res.delta})`);
  bye(a2, b); await until(async () => (await status(PORT)).courts === 0, 6000);
  const c = await lobbied('', PORT, { dev: da }); await queue(c, 'Ann'); await warm(c); ok(await until(() => inWarm(c) && c.info && c.info.active) && c.info.level === 1 && c.info.name === 'Club', 'Silver warms up against Matt at Club');
  bye(c); await until(async () => (await status(PORT)).courts === 0, 6000);
  const dc = dev(), oc = db.ownerForDevice(auth.deviceHash(dc), Date.now(), { create: true }); db.ladderApply({ owner: oc, delta: 897, won: true, vsBot: false, now: Date.now() });
  const m = await lobbied('', PORT, { dev: dc }); still(m); await queue(m, 'Max'); await warm(m);
  ok(m.rk.you.tier === 6 && m.rk.you.div === 3 && m.rk.you.next === 900 && m.rk.you.nextDiv === 900 && m.info && m.info.level === 2 && m.info.name === 'Pro', `a Champion III at 897: Matt at Pro (${JSON.stringify(m.rk.you)})`);
  ok(await until(() => m.res, 30000) && !m.res.won && m.res.delta === 0 && m.res.trophies === 897 && m.res.tier === 6 && m.res.div === 3, `a loss to Pro Matt pays 0 and moves nothing (the 899 ceiling on a win is pinned by test/accounts-unit.test.mjs and test/ladder.test.mjs) (${JSON.stringify(m.res)})`);
  bye(m); await until(async () => (await status(PORT)).courts === 0, 6000);
  // the day cap on the RK_MATT_DAY 12 server: seed 10 of today's 12 through the test's own connection
  ok(db.open(path.join(tmp, 'd.db')), 'open the RK_MATT_DAY 12 server\'s file'); const dd = dev(), od = db.ownerForDevice(auth.deviceHash(dd), Date.now(), { create: true });
  const seeded = db.ladderApply({ owner: od, delta: 10, won: true, vsBot: true, now: Date.now() }); ok(seeded && seeded.delta === 10 && seeded.dayLeft === 2, 'seed: one Matt win today, 2 left');
  const n = await lobbied('', P_ADDR, { dev: dd }); hit(n); await queue(n, 'Ned'); await warm(n);
  ok(n.rk.you.matt.dayLeft === 2, 'the snapshot says 2 left today');
  ok(await until(() => n.res && n.res.won && n.res.saved, 90000) && n.res.delta === 2 && n.res.trophies === 12 && n.res.dayLeft === 0, `the next win pays the 2 that are left, dayLeft 0 (${JSON.stringify(n.res)})`);
  n.res = null; ok(await until(() => n.res && n.res.won, 90000) && n.res.delta === 0 && n.res.dayLeft === 0 && n.res.counted === true, `past the cap a win pays 0 (${JSON.stringify(n.res)})`);
  bye(n); await until(async () => (await status(P_ADDR)).courts === 0, 6000); }

console.log('9. pressure: point.gp / point.mp (RK_WIN 2)');
{ const [a, b] = await pairUp(P_GP); hit(a); still(b);
  ok(await until(() => a.got('point').length, 15000), 'a point');
  const p1 = a.got('point')[0]; ok(p1.gp === 0 && p1.mp === null && p1.final === false, `1-0 in game 1: game point for side 0, no match point (${JSON.stringify(p1)})`);
  ok(await until(() => a.got('rkgame').length, 15000) && a.got('point').at(-1).final === true, 'game 1 to 2');
  ok(await until(() => a.got('point').length >= 3, 20000) && a.got('point')[2].gp === 0 && a.got('point')[2].mp === 0, `1-0 in game 2 with a game in hand: match point (${JSON.stringify(a.got('point')[2])})`);
  bye(a, b); await until(async () => (await status(P_GP)).courts === 0, 8000); }

console.log('10. caps and hostile payloads');
{ const own = []; for (let i = 0; i < 2; i++) { const o = await lobbied('', P_CAP); o.send({ type: 'create', public: false }); await until(() => o.room); own.push(o); }   // 2 courts of 6: ROOM_CAP - TOUR_RESERVE = 2 reached
  const a = await lobbied('', P_CAP); await queue(a, 'A'); ok(inLobbyQ(a) && !a.fail && (await status(P_CAP)).rk.queued === 1, `no court free: still queued, in the lobby (waiting needs no court) (${JSON.stringify(a.rk)})`);
  await warm(a); ok(a.fail && a.fail.why === 'busy' && a.fail.warm === true && !a.room && (await status(P_CAP)).rk.queued === 1, `rkwarm with no court free: rkfail busy { warm: true }, still queued (${JSON.stringify(a.fail)})`);
  own[0].bail(); await until(async () => (await status(P_CAP)).courts === 1);
  a.mark(); await warm(a); ok(inWarm(a), 'a court freed: Warm up works');
  const c = await lobbied('', P_CAP, { cid: null }); await queue(c, 'C'); ok(c.fail && c.fail.why === 'nocid', 'no cid: rkfail nocid');
  const t = await lobbied('', P_CAP); t.send({ type: 'tcreate', name: 'T' }); await until(() => t.got('tour').length); await queue(t, 'T'); ok(t.fail && t.fail.why === 'intour', 'in a tournament: rkfail intour');
  const spec = await lobbied('', P_CAP); spec.send({ type: 'watch', code: a.room.code }); await until(() => spec.welcome); spec.mark(); spec.send({ type: 'rk' }); spec.send({ type: 'rkleave' }); await wait(300);
  ok(!spec.got('rk').length && !spec.got('rkfail').length && spec.room, 'rk / rkleave from a spectator: ignored');
  a.send({ type: 'rkleave' }); await until(async () => (await status(P_CAP)).rk.queued === 0 && (await status(P_CAP)).courts === 1);   // out of the queue, a court free again
  const d = await lobbied('', P_CAP); for (const m of [{ type: 'rk', name: ['x'] }, { type: 'rk', name: { a: 1 } }, { type: 'rkleave', x: 'Z'.repeat(3000) }, '{"type":"rk","name":{"toString":1}}', { type: 'rk', name: 7 }, '[]', 'null']) d.send(m);
  await wait(300); ok((await status(P_CAP)).courts >= 1, 'malformed rk payloads: the server keeps answering');
  ok(await until(() => d.got('rk', m => m.phase === 'queue').length >= 1, 3000), 'and the junk-named one still got queued (the rkleave among the junk then took it out)');
  bye(a, c, t, spec, d, ...own); await until(async () => (await status(P_CAP)).courts === 0, 6000); }

console.log('11. a restart voids everything: rkend restart, then gone; nothing revived');
{ const [a, b] = await pairUp(P_BOOT); hit(a); still(b); ok(await until(() => a.got('rkgame').length, 20000), 'one game played on the restarting server');
  const code = a.room.code; procs.get(P_BOOT).kill('SIGINT'); await until(() => a.closed && b.closed, 3000);
  ok(a.got('restart').length === 1, 'the restart notice went out');
  await up(P_BOOT, { REVIVE_S: '3', PODDLE_DB: DBB }); const upAt = Date.now();
  const a2 = await client(`&rk=1&room=${code}&name=Ann`, P_BOOT, { cid: a.cid, addr: a.addr, dev: a.d }), b2 = await client(`&rk=1&room=${code}&back=1&side=1&score=0-0&name=Ben`, P_BOOT, { cid: b.cid, addr: b.addr, dev: b.d });
  ok(await until(() => a2.got('rkend').length && b2.got('rkend').length) && a2.last('rkend').why === 'restart' && b2.last('rkend').why === 'restart', 'both hear rkend restart');
  ok(!a2.got('room').length && !b2.got('room').length && !b2.welcome && (await status(P_BOOT)).courts === 0 && (await status(P_BOOT)).rk.series === 0, 'nothing revived, a stray back=1 neither');
  ok(db.open(DBB), 'the restarted server\'s file'); const oa = db.guestOwner(auth.deviceHash(a.d));
  const rows = oa != null ? db.exportOf(oa, Date.now()).matches.filter(m => m.mode === 'ladder') : [];
  ok(rows.length === 1 && rows[0].trophyDelta === null && (db.ladderOf(oa) || {}).trophies === 0, `the finished game stays in the log with a NULL delta; no trophies changed (${JSON.stringify(rows)})`);
  hit(a2); still(b2); await queue(a2, 'Ann'); await warm(a2); await queue(b2, 'Ben'); await until(() => inMatch(a2) && inMatch(b2), 4000);
  ok(await until(() => a2.res && b2.res, 40000) && a2.res.delta === 33, 'the same pair plays a series on the new process');
  const rows2 = db.exportOf(oa, Date.now()).matches.filter(m => m.mode === 'ladder').map(r => r.trophyDelta), ob = db.guestOwner(auth.deviceHash(b.d));
  ok(eq(rows2, [null, 33, 33]) && db.recentPairs(oa, ob, Date.now() - DAY) === 2, `series ids are unique across restarts: the old game keeps its NULL delta, R10 sees two series (${JSON.stringify(rows2)}, ${db.recentPairs(oa, ob, Date.now() - DAY)})`);
  await until(async () => (await status(P_BOOT)).courts === 0, 6000); await wait(Math.max(0, upAt + 3300 - Date.now()));
  const late = await client('&rk=1', P_BOOT); await until(() => late.got('rkend').length);
  ok(late.last('rkend')?.why === 'gone', 'after REVIVE_S: rkend gone');
  const rv = await client(`&room=${code}&rk=1&back=1&side=0&score=1-0&name=X`, P_BOOT); await until(() => rv.got('rkend').length || rv.got('room').length);
  ok(!rv.got('room').length, 'revive() never brings a Ranked court back');
  bye(a2, b2, late, rv); }

console.log('13. a socket that never says hello is never paired and is dropped; the re-queue cooldown');
{ const nh = await lobbied('', PORT, { dev: null }); await queue(nh, 'Nix'); ok(inLobbyQ(nh), 'no hello: queued all the same (its hello may still come)');
  const cl = await lobbied(); await queue(cl, 'Cal'); await wait(600);
  ok(inLobbyQ(cl) && !cl.got('rkvs').length && !nh.got('rkvs').length, 'an identified player queueing after it is NOT paired with it');
  ok(await until(() => nh.fail && nh.fail.why === 'nostats', 3000) && await until(async () => (await status(PORT)).rk.queued === 1 && (await status(PORT)).courts === 0), 'after RK_ARRIVE_S with no hello: rkfail nostats, out of the queue; the other entry stays');
  cl.mark(); cl.send({ type: 'rkleave' }); cl.room = null; await until(() => cl.got('rk', m => m.phase === 'off').length); cl.send({ type: 'rk' }); await until(() => cl.fail || cl.room);
  ok(cl.fail && cl.fail.why === 'busy' && !cl.room, `rk right after rkleave: rkfail busy (the RK_COOL_S cooldown) (${JSON.stringify(cl.fail)})`);
  await wait(2100); cl.mark(); await queue(cl, 'Cal'); ok(inLobbyQ(cl), 'after the cooldown: queued');
  bye(nh, cl); await until(async () => (await status(PORT)).courts === 0, 6000); }

console.log('14. a sign-in during the warm-up: the Matt bounty follows the merged owner');
{ const dg = dev(), g = await lobbied('', PORT, { dev: dg }); hit(g); await queue(g, 'Gus'); await warm(g);
  ok(await until(() => g.res && g.res.won && g.res.saved, 90000) && g.res.trophies === 10, 'a first Matt win: the guest owner exists with 10');
  ok(db.open(DBA), 'the base file'); const G = db.guestOwner(auth.deviceHash(dg)), acct = db.createAccount('sub-merge-' + Date.now(), Date.now());
  ok(G != null && acct && db.mergeDevice(auth.deviceHash(dg), acct.id, Date.now()) === 'merged' && db.ownerExists(G) === false, 'the device is merged into an account (the guest owner row is gone)');
  g.res = null; ok(await until(() => g.res && g.res.won, 90000) && g.res.saved === true && g.res.delta === 10, `the next Matt win is saved, onto the account (${JSON.stringify(g.res)})`);
  const la = db.ladderOf(acct.owner_id); ok(la && la.botWins >= 1 && la.trophies >= 10 && db.ladderOf(G) === null, `the account's ladder row took it, nothing landed on the dead id (${JSON.stringify(la)})`);
  bye(g); await until(async () => (await status(PORT)).courts === 0, 6000); }

console.log('15. new_opponent halves a win OVER a new player, never the new player\'s own win (RK_WIN 2, R11c on)');
{ ok(db.open(path.join(tmp, 'e.db')), 'the P_GP file'); const dv = dev(), ov = db.ownerForDevice(auth.deviceHash(dv), Date.now() - 2 * DAY, { create: true }); db.ladderApply({ owner: ov, delta: 100, won: true, vsBot: false, now: Date.now() });
  const [n, v] = await pairUp(P_GP, { b: { dev: dv }, na: 'New', nb: 'Vet' }); hit(n); still(v);
  ok(await until(() => n.got('rkgame').length === 1, 25000) && n.last('rkgame').winner === 0, 'game 1 to the newcomer'); still(n); hit(v);
  ok(await until(() => n.got('rkgame').length === 2, 25000) && n.last('rkgame').winner === 1, 'game 2 to the veteran (the newcomer, not established, lost it: new_opponent)'); hit(n); still(v);
  ok(await until(() => n.res && v.res, 30000) && n.res.won && n.res.counted && n.res.delta === 34 && v.res.delta === -24 && v.res.counted, `the newcomer's 2-1 pays the full +34 (100 below) (game 2's new_opponent names the newcomer as the loser, not the veteran) (${JSON.stringify([n.res, v.res])})`);
  const on = db.guestOwner(auth.deviceHash(n.d)); ok(on != null && db.exportOf(on, Date.now()).matches.some(m => m.reasons.includes('new_opponent')), 'game 2 carries new_opponent in the log');
  bye(n, v); await until(async () => (await status(P_GP)).courts === 0, 8000); }

console.log('16. R9 on (STATS_AFK_MIN 2): a forfeit at 0-0 of game 2 never denies the stayer; the stall loop is bounded (CAL_S 2, READY_S 2)');
{ ok(db.open(path.join(tmp, 'f.db')), 'the P_AFK file'); const dA = dev(), dB = dev(); for (const d of [dA, dB]) db.ownerForDevice(auth.deviceHash(d), Date.now() - 2 * DAY, { create: true });   // established: R11c stays out of it
  let done = false, tries = 0;
  while (!done && tries++ < 5) {
    const [a, b] = await pairUp(P_AFK, { a: { dev: dA }, b: { dev: dB } }); hit(a); rally(b, 2); const at = logs.get(P_AFK).length;   // b returns two balls a point then lets the third go: both seats have contacts, a wins
    if (!await until(() => a.got('rkgame').length, 40000)) { console.log('  (no game 1 in 40 s)'); bye(a, b); await until(async () => (await status(P_AFK)).courts === 0, 8000); continue; }
    if (!/match recorded: human ranked/.test(logs.get(P_AFK).slice(at))) { console.log('  (game 1 came back unranked with R9 on: again)'); bye(a, b); await until(async () => (await status(P_AFK)).courts === 0, 8000); continue; }
    const w = a.last('rkgame').winner, L = w === a.side ? b : a, S = L === a ? b : a;
    await until(() => L.got('rkgo', m => m.game === 2).length, 4000); await wait(60); L.bail();
    ok(await until(() => S.res && L.res, 5000) && S.res.won && S.res.counted === true && S.res.delta === 30 && L.res.counted === true && L.res.delta === 0 && L.res.floorHeld && eq(S.res.games, w === 0 ? [1, 0] : [0, 1]), `the loser leaves right after rkgo game 2 (a 0-0 forfeit R9 flags afk): the stayer still takes +30, the leaver the loss (${JSON.stringify([S.res, L.res])})`);
    ok(eq(S.res.scores, [S.res.scores[0], [0, 0]]) && S.res.scores.length === 2, `the forfeited game is in the scores as 0-0 (${JSON.stringify(S.res.scores)})`);
    done = true; bye(a, b); await until(async () => (await status(P_AFK)).courts === 0, 8000);
  }
  ok(done, `game 1 came back ranked with both seats making contacts (${tries} tries)`);
  // calibrating on / off / on: each window restarts, the sum does not. 2 x CAL_S of stalling in one room is the forfeit
  const [j, k] = await pairUp(P_AFK, { a: { dev: dA }, b: { dev: dB } }); hit(j); still(k); ok(await until(() => j.got('rkgame').length, 40000), 'game 1 done');
  await until(() => k.got('rkgo', m => m.game === 2).length, 4000); k.ready = false; k.play = null; const t0 = Date.now(); let cycles = 0;
  while (!k.got('closed').length && cycles < 8) { k.send({ type: 'status', cal: true }); await wait(1200); if (k.got('closed').length) break; k.send('{"type":"paddle","auto":true,"q":[0,0,0,1]}'); await wait(120); cycles++; }
  ok(await until(() => k.got('closed', m => m.reason === 'away').length, 3000) && await until(() => j.res && j.res.won, 3000), `stalling in 1.2 s windows: still out after ~2 x CAL_S in all (${cycles} cycles, ${Date.now() - t0} ms), a forfeit for the stayer`);
  ok(Date.now() - t0 >= 3500, 'and not a moment earlier: the readyBy backstop never fires past game 1 (slowSeat\'s grace applies)');
  bye(j, k); await until(async () => (await status(P_AFK)).courts === 0, 8000); }

console.log('17. OPTIONAL WARM-UP: a reconnect in the lobby and on the warm-up, the grace for a closed socket, a warming player pulled into MATCH FOUND');
{ const a = await lobbied(); await queue(a, 'Ann'); const since = a.rk.since;
  a.ws.terminate(); ok(await until(async () => (await status(PORT)).rk.queued === 0), 'a closed socket\'s entry is not counted (nor paired) while it is kept');
  const a2 = await client('&rk=1&name=Ann', PORT, { cid: a.cid, addr: a.addr, dev: a.d });
  ok(await until(() => a2.rk && a2.rk.phase === 'queue', 3000) && inLobbyQ(a2) && a2.rk.since === since && !a2.got('room').length && !a2.got('rkend').length && (await status(PORT)).rk.queued === 1 && (await status(PORT)).courts === 0, `back with &rk=1 from the lobby: re-queued in the lobby, the same wait clock, no court (${JSON.stringify(a2.rk)})`);
  await warm(a2); const code = a2.room && a2.room.code; ok(inWarm(a2), 'Warm up on the new socket');
  a2.ws.terminate(); await until(async () => (await status(PORT)).courts === 0);   // the warm-up closes with the drop (no hold on a one-human court)
  const a3 = await client(`&rk=1&room=${code}&name=Ann`, PORT, { cid: a.cid, addr: a.addr, dev: a.d });
  ok(await until(() => inWarm(a3) && a3.rk && a3.rk.warm === true, 3000) && a3.rk.since === since && (await status(PORT)).rk.queued === 1 && (await status(PORT)).courts === 1, `back with &rk=1&room= from a warm-up: the warm-up back (a new court), still queued from the same clock (${JSON.stringify(a3.room)})`);
  const b = await lobbied(); await queue(b, 'Ben');
  ok(await until(() => a3.got('rkvs').length && b.got('rkvs').length, 3000) && !a3.got('closed').length && !a3.got('rkres').length && b.last('rkvs').vs.name === 'Ann', 'a lobby entry pairs with the warming one: MATCH FOUND for both, the warm-up left quietly with no Matt result');
  bye(a3, b); await until(async () => (await status(PORT)).courts === 0 && (await status(PORT)).rk.series === 0, 6000);
  const c = await lobbied(); await queue(c, 'Cal'); c.ws.terminate(); await wait(1700);   // RK_BACK_S = HOLD_S = 1 here
  const c2 = await client('&rk=1&name=Cal', PORT, { cid: c.cid, addr: c.addr, dev: c.d });
  ok(await until(() => c2.got('rkend').length, 3000) && ['gone', 'restart'].includes(c2.last('rkend').why) && !c2.got('rk').length && (await status(PORT)).rk.queued === 0, `not back within RK_BACK_S: the entry is gone, &rk=1 hears rkend (${JSON.stringify(c2.last('rkend'))})`);
  bye(c2); }

console.log('12. no cid, owner id or opponent count in any Ranked frame');
{ const RK = /"type":"(rk|rkvs|rkgo|rkgame|rkres|rkend|rkfail|lobby|matchover|welcome|names)"/;
  const frames = all.flatMap(c => c.raw.filter(s => RK.test(s)));
  const leaks = frames.filter(s => CIDS.some(id => s.includes(id)) || /"owner|ownerId|"acct|devHash|"dev"/.test(s));
  ok(frames.some(s => s.includes('"type":"rkres"')) && frames.some(s => s.includes('"type":"rkvs"')) && !leaks.length, `checked ${frames.length} frames (${leaks.length} leaks${leaks.length ? ': ' + leaks[0].slice(0, 160) : ''})`);
  const vs = all.flatMap(c => c.raw.filter(s => s.includes('"type":"rkvs"'))).filter(s => /"vs":\{[^}]*trophies/.test(s));
  ok(!vs.length, 'no rkvs names the opponent\'s trophies');
  const out = [...logs.values()].join('\n'), hashes = DEVS.map(d => crypto.createHash('sha256').update(d).digest('hex'));
  ok(![...DEVS, ...hashes, ...IPS, ...CIDS].some(v => out.includes(v)), 'no server printed a device id, a hash, an address or a cid'); }

console.log(fails ? `FAIL ${fails}` : 'PASS'); killAll(); process.exit(fails ? 1 : 0);
