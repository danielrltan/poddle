// Player stats end to end (docs/ACCOUNTS.md 12.2): real servers, scripted clients that say hello with fixed test device ids from distinct
// fly-client-ip addresses (the loopback peer makes that header trusted off Fly, 3.5), the profile message, /api/stats, export and delete,
// every way a match ends, the anti-abuse rules that need a server, a restart on the same database file, and the logs.
//   node test/stats.test.mjs        STATS_PORT=<base> moves the servers (base, +1, +2; default 9400-9402). Takes about 3 minutes.
// Each scenario has its OWN devices, cids and addresses: one device seen on two addresses joins them into one computer for 24 h (5.4).
// Knobs beyond 12.2 (reported): TIMESCALE 2 (the sim runs twice as fast, so the scripted matches take half as long) and STATS_ESTABLISHED 0
// (fresh test devices are never "established", R11c, so no human win could be ranked otherwise). Test 20 is scaled down (NEW_GUEST_DAY 3).
import { spawn } from 'child_process';
import WebSocket from 'ws';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
const PORT = +process.env.STATS_PORT || 9400, P2 = PORT + 1, P3 = PORT + 2, root = new URL('..', import.meta.url).pathname;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'poddle-')), DBA = path.join(tmp, 'a.db');
const BASE = { WIN_AT: '2', REMATCH_S: '4', HOLD_S: '3', STATS_MIN_POINT_S: '0', STATS_AFK_MIN: '0', STATS_FORFEIT_MIN: '1', STATS_ESTABLISHED: '0', TIMESCALE: '2' };
const procs = new Set(), logs = [];                                // every byte any server printed (test 16)
function up(port, env) {
  return new Promise(res => { const p = spawn('node', ['server/game.js'], { cwd: root, env: { ...process.env, PORT: port, ...env } }); procs.add(p); const mine = { p, out: '' }; logs.push(mine);
    const eat = d => { mine.out += d; if (/game server on port/.test(d)) res(p); }; p.stdout.on('data', eat); p.stderr.on('data', eat); p.on('exit', () => procs.delete(p)); });
}
const stop = (p, sig = 'SIGINT') => new Promise(r => { if (p.exitCode != null) return r(); p.on('exit', r); p.kill(sig); });
process.on('exit', () => { for (const p of procs) p.kill(); fs.rmSync(tmp, { recursive: true, force: true }); });
process.on('unhandledRejection', e => { console.error(e); process.exit(1); });
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (f, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (f()) return true; await wait(25); } return !!f(); };
let fails = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
const DEVS = [], IPS = [];
let dn = 0, ipn = 0;
const dev = () => { const d = crypto.randomUUID(); DEVS.push(d); dn++; return d; };                  // UUID v4, as crypto.randomUUID() in the page makes it
const ip = () => { const a = `203.0.113.${++ipn}`; IPS.push(a); return a; };                         // TEST-NET-3: one fresh "computer" per call
let cn = 0; const cidN = () => 'stc' + (++cn) + 'x' + crypto.randomBytes(3).toString('hex');

// A tab: hello first thing on the socket (when it has a device id), everything it hears kept in log, state kept apart.
function tab({ port = PORT, addr, d, cid = cidN(), q = 'lobby=1', origin, hello = true } = {}) {
  const headers = {}; if (addr) headers['fly-client-ip'] = addr; if (origin) headers.origin = origin;
  const ws = new WebSocket(`ws://localhost:${port}/?${q}&cid=${cid}`, { headers }), c = { ws, cid, d, addr, port, log: [], st: null, side: null, closed: false, play: null };
  ws.on('open', () => { if (hello && d !== undefined) ws.send(JSON.stringify({ type: 'hello', dev: d, v: 1 })); });
  ws.on('message', raw => { const m = JSON.parse(raw);
    if (m.type === 'state') { c.st = m; if (c.play) c.play(m); return; }
    c.log.push(m); if (m.type === 'welcome') c.side = m.side; if (m.type === 'room') c.room = m; });
  ws.on('close', () => { c.closed = true; }); ws.on('error', () => {});
  c.send = o => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
  c.got = (t, f) => c.log.filter(m => m.type === t && (!f || f(m))); c.last = t => c.got(t).pop(); c.n = t => c.got(t).length;
  c.open = () => until(() => ws.readyState === 1, 4000);
  return c;
}
// behaviours, driven by every state packet (like test/bot.test.mjs): hit plays well, lose serves hard and never returns, still sends a paddle only
function hit(c) { let cool = 0; c.play = m => {
  c.send({ type: 'paddle', auto: true, q: [0, 0, 0, 1] });
  const me = m.paddles[c.side], s = c.side === 0 ? 1 : -1; if (!me || Date.now() < cool) return;
  if (m.serving === c.side) { cool = Date.now() + 600; return c.send({ type: 'swing', power: 20, dir: 0.3, lob: 0, final: true, pk: 20, src: 'airpod' }); }
  if (m.live && Math.abs(m.p[0] - me.x) < 0.9 && Math.abs(m.p[1] - me.y) < 0.8 && -(m.p[2] - me.z) * s < 1.0 && -(m.p[2] - me.z) * s > -0.5 && m.v[2] * s > 0) {
    cool = Date.now() + 400; c.send({ type: 'swing', power: 14 + Math.random() * 16, dir: (Math.random() - 0.5) * 1.6, lob: 0, final: true, pk: 22, src: 'airpod' }); }
}; }
function lose(c) { let cool = 0; c.play = m => { c.send({ type: 'paddle', auto: true, q: [0, 0, 0, 1] });
  if (m.serving === c.side && m.reach && Date.now() > cool) { cool = Date.now() + 600; c.send({ type: 'swing', power: 30, dir: 0, lob: 0, final: true }); } }; }
const still = c => { c.play = () => c.send({ type: 'paddle', auto: true, q: [0, 0, 0, 1] }); };        // ready, never swings (a serve waits 9 s, then goes by itself)

// HTTP: the API as a page on this server would call it
function api(port, method, p, body, { addr, origin = `http://localhost:${port}`, type = 'application/json', cookie, host } = {}) {
  return new Promise(res => {
    const data = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body), headers = {};
    if (data != null) { headers['content-type'] = type; headers['content-length'] = Buffer.byteLength(data); }
    if (origin) headers.origin = origin; if (addr) headers['fly-client-ip'] = addr; if (cookie) headers.cookie = cookie; if (host) headers.host = host;
    const rq = http.request({ host: '127.0.0.1', port, method, path: p, headers }, r => { let s = ''; r.on('data', d => s += d); r.on('end', () => { let j = null; try { j = JSON.parse(s); } catch { /* not json */ } res({ status: r.statusCode, headers: r.headers, body: s, json: j }); }); });
    rq.on('error', e => res({ status: 0, error: e.code })); if (data != null) rq.write(data); rq.end();
  });
}
const profileOf = async (d, addr, port = PORT) => (await api(port, 'POST', '/api/stats', { dev: d }, { addr })).json?.profile ?? null;
const exportOf = async (d, addr, port = PORT) => (await api(port, 'POST', '/api/export', { dev: d }, { addr })).json;

// A court of one against Matt at `level`, as `how` plays it; resolves with the tab once it is seated and Matt is on
async function vsMatt({ port = PORT, addr = ip(), d = dev(), level = 0, how = lose, origin, q, hello } = {}) {
  const c = tab({ port, addr, d, origin, q, hello }); await c.open(); await until(() => c.n('lobby'));
  c.send({ type: 'create', public: false }); await until(() => c.side != null);
  c.send({ type: 'bot', level }); await until(() => c.got('botinfo', i => i.active).length);
  if (how) how(c); return c;
}
const over = (c, k = 1, ms = 45000) => until(() => c.n('matchover') >= k, ms);
const prof = (c, k = 1, ms = 3000) => until(() => c.n('profile') >= k, ms).then(() => c.got('profile')[k - 1] || null);
const struck = (c, k = 1, ms = 15000) => until(() => c.n('hit') + c.n('launch') >= k, ms);
// two people on one court: a makes it, b joins by its code; nobody plays until both are seated (no Matt in between)
async function pair({ port = PORT, A, B }) {
  const a = tab({ port, ...A }), b = tab({ port, ...B }); await a.open(); await b.open(); await until(() => a.n('lobby') && b.n('lobby'));
  a.send({ type: 'create', public: false }); await until(() => a.room);
  b.send({ type: 'join', code: a.room.code }); await until(() => a.side != null && b.side != null && a.got('names', m => m.names.every(Boolean)).length);
  return [a, b];
}
const bye = (...cs) => cs.forEach(c => { try { c.ws.terminate(); } catch { /* gone */ } });

// Scenarios run side by side (each on its own court, devices and addresses); their lines are printed in order once all are done.
function sc(name, fn) { const lines = [], t = { ok: (c, m) => lines.push([!!c, m]) };
  return fn(t).catch(e => lines.push([false, 'threw: ' + (e && e.stack || e)])).then(() => ({ name, lines })); }
function report(rs) { for (const r of rs) { console.log(r.name); for (const [c, m] of r.lines) ok(c, m); } }
const F = {};                                                     // facts later scenarios reuse (devices and their addresses)

console.log('servers: ' + PORT + ' (stats), then ' + P2 + ' on the same file, ' + P3 + ' without a database');
let A = await up(PORT, { PODDLE_DB: DBA, ...BASE });

report(await Promise.all([
  sc('1. bot matches: a win and a loss against Rookie, the first win, /api/stats', async t => {
    const c = await vsMatt({ level: 0, how: hit }); let k = 0, won = false;
    while (!won && k < 3) { k++; await over(c, k); await prof(c, k); won = c.got('matchover')[k - 1]?.winner === c.side; if (!won) c.send({ type: 'rematch', yes: true }); }
    const ps = c.got('profile'), w = ps[k - 1];
    t.ok(won, `the hitter beat Rookie Matt within 3 matches (${k})`);
    t.ok(w && w.saved && w.kind === 'bot' && w.level === 0 && w.first === true && w.ranked === true && w.streak === 1, 'the win: profile saved, bot, level 0, first win, ranked: ' + JSON.stringify(w));
    t.ok(ps.length === k && ps.every(p => p.saved), 'one profile message per match, every one saved');
    t.ok(ps[0].created === true && ps.slice(1).every(p => !p.created), 'created:true exactly once: the match that first stored data for this device');
    const P = await profileOf(c.d, c.addr);
    t.ok(P && P.guest && P.matt.length === 4 && P.matt.map(x => x.name).join() === 'Rookie,Club,Tour,Pro' && P.matt[0].wins === 1 && P.matt[0].losses === k - 1 && P.matt[0].firstWinAt > 0 && P.played === k, '/api/stats: four rungs, Rookie W-L ' + (P && P.matt[0].wins + '-' + P.matt[0].losses));
    F.win = { d: c.d, addr: c.addr, played: k }; bye(c);
    const l = await vsMatt({ level: 0, how: lose }); await over(l); const lp = await prof(l);
    t.ok(l.last('matchover').winner !== l.side && lp && lp.saved && lp.first === false && lp.streak === 0 && lp.kind === 'bot' && lp.level === 0, 'a loss to Rookie: saved, no first, streak 0');
    const LP = await profileOf(l.d, l.addr); t.ok(LP && LP.matt[0].losses === 1 && LP.matt[0].wins === 0 && LP.human.losses === 0, 'the loss is on the Rookie rung, not against people');
    bye(l);
  }),
  sc('2. Matt level changes: after the first strike the easiest level used, before it the new level', async t => {
    const a = await vsMatt({ level: 0, how: lose }); await struck(a); a.send({ type: 'bot', level: 2 }); await over(a); const pa = await prof(a);
    t.ok(pa && pa.level === 0 && pa.why.includes('level'), 'Rookie -> Pro after the first strike: recorded at Rookie, why says level: ' + JSON.stringify(pa));
    const PA = await profileOf(a.d, a.addr); t.ok(PA && PA.matt[0].losses === 1 && PA.matt[3].losses === 0, 'the Rookie rung has it, Pro does not');
    const b = await vsMatt({ level: 3, how: lose }); await struck(b); b.send({ type: 'bot', level: 2 }); await over(b); const pb = await prof(b);
    t.ok(pb && pb.level === 3, 'Tour -> Pro after the first strike: recorded at Tour (wire 3; Tour is easier than Pro)');
    const PB = await profileOf(b.d, b.addr); t.ok(PB && PB.matt[2].name === 'Tour' && PB.matt[2].losses === 1 && PB.matt[3].losses === 0, 'the Tour rung (third of four) has it');
    const c = await vsMatt({ level: 0, how: null }); c.send({ type: 'bot', level: 2 }); await until(() => c.got('botinfo', i => i.level === 2).length); lose(c); await over(c); const pc = await prof(c);
    t.ok(pc && pc.level === 2 && !pc.why.includes('level'), 'a change before the first strike is free: recorded at Pro');
    bye(a, b, c);
  }),
  sc('3. leaving Matt mid-match: an explicit leave is a loss, a dropped socket an abandon', async t => {
    const a = await vsMatt({ level: 1, how: lose }); await over(a); await prof(a); a.send({ type: 'rematch', yes: true });
    await until(() => a.n('rematchon')); await struck(a, a.n('hit') + a.n('launch') + 1); a.send({ type: 'leave' });
    await wait(400); t.ok(a.n('profile') === 1, 'leave after the first strike: no result message for the leaver (they are in the lobby; the profile view shows it)');
    const PA = await profileOf(a.d, a.addr); t.ok(PA && PA.matt[1].losses === 2 && PA.matt[1].abandons === 0 && PA.matt[1].streak === 0, `Club rung: the leave is a second loss (${PA && PA.matt[1].losses})`);
    const b = await vsMatt({ level: 1, how: lose }); await over(b); await prof(b); b.send({ type: 'rematch', yes: true });
    await until(() => b.n('rematchon')); await struck(b, b.n('hit') + b.n('launch') + 1); b.ws.terminate(); await wait(600);
    const PB = await profileOf(b.d, b.addr); t.ok(PB && PB.matt[1].losses === 1 && PB.matt[1].abandons === 1 && PB.matt[1].streak === 0, `terminate() mid-match: an abandon, no second loss (${PB && JSON.stringify(PB.matt[1])})`);
    const n = tab({ addr: ip(), d: dev() }); await n.open(); await until(() => n.n('lobby')); n.send({ type: 'create', public: false }); await until(() => n.side != null);
    n.send({ type: 'bot', level: 0 }); lose(n); await struck(n); n.send({ type: 'leave' }); await wait(500);
    t.ok(await profileOf(n.d, n.addr) === null, 'a device never seen before that leaves mid-match: nothing is created (5.5)');
    bye(a, n);
  }),
  sc('G3. giving Matt\'s seat away after the first strike is an abandon: a second tab of one\'s own cannot erase a match being lost', async t => {
    const addr = ip(), a = await vsMatt({ addr, level: 0, how: lose }); await over(a); await prof(a); a.send({ type: 'rematch', yes: true });
    await until(() => a.n('rematchon')); await struck(a, a.n('hit') + a.n('launch') + 1);
    const b = tab({ addr, d: dev() }); await b.open(); await until(() => b.n('lobby')); b.send({ type: 'watch', code: a.room.code, name: 'PoddleAdmin' }); await until(() => b.room && b.room.role === 'spectator');
    b.send({ type: 'ask' }); await until(() => a.n('askplay')); a.send({ type: 'answer', id: a.last('askplay').id, yes: true }); await until(() => b.side != null); await wait(400);
    t.ok(a.got('watcher').every(w => w.name === '') && a.last('askplay').name === 'Someone', `a guest named PoddleAdmin is not shown by that name to the player (watcher ${JSON.stringify(a.got('watcher').map(w => w.name))}, ask ${a.last('askplay').name})`);
    const P = await profileOf(a.d, addr); t.ok(P && P.matt[0].losses === 1 && P.matt[0].abandons === 1 && P.matt[0].streak === 0 && P.played === 2, `yielded mid-match: the Rookie rung has an abandon and the streak ends (${P && JSON.stringify(P.matt[0])})`);
    bye(a, b);
  }),
  sc('Tour is a rung: a tournament warm-up against Matt lands on the Tour rung', async t => {
    const c = tab({ addr: ip(), d: dev() }); await c.open(); await until(() => c.n('lobby'));
    c.send({ type: 'tcreate' }); await until(() => c.n('tour')); c.send({ type: 'twarm' });
    await until(() => c.side != null && c.got('botinfo', i => i.active && i.level === 3).length); lose(c); await over(c); const p = await prof(c);
    t.ok(p && p.saved && p.kind === 'bot' && p.level === 3, 'the warm-up (Tour Matt) is recorded as a bot match at level 3: ' + JSON.stringify(p));
    const P = await profileOf(c.d, c.addr); t.ok(P && P.matt[2].name === 'Tour' && P.matt[2].losses === 1 && P.matt[3].losses === 0 && P.matt.length === 4, 'the Tour rung (third of four) has it; no separate tournament line');
    c.send({ type: 'tleave' }); bye(c);
  }),
]));
const lastMatch = x => (x && x.matches || []).slice().sort((p, q) => (p.at < q.at ? -1 : 1)).pop() || null;   // the export's most recent match
async function duel(a, b) { hit(a); lose(b); await over(a); await over(b); return [await prof(a, a.n('matchover')), await prof(b, b.n('matchover'))]; }   // a beats b
async function drop(b, extra = {}) {                              // b's socket dies mid-match; the same tab (cid) comes back to its held seat
  const code = b.room.code, side = b.side; b.ws.terminate(); await wait(300);
  const b2 = tab({ addr: b.addr, d: b.d, cid: b.cid, q: `lobby=1&room=${code}&back=1&side=${side}`, ...extra }); await until(() => b2.side != null); return b2;
}
report(await Promise.all([
  sc('4, 6, 7. two people: ranked W/L both sides, forfeits before and after the first point, the pair cap', async t => {
    const A = { addr: ip(), d: dev() }, B = { addr: ip(), d: dev() }; F.people = A;
    let [a, b] = await pair({ A, B }), [pa, pb] = await duel(a, b);
    t.ok(pa && pa.saved && pa.ranked && pa.kind === 'human' && pa.streak === 1 && pb && pb.saved && pb.ranked && pb.streak === 0, `4: different addresses and devices: ranked on both sides (${JSON.stringify(pa)})`);
    const PA = await profileOf(A.d, A.addr), PB = await profileOf(B.d, B.addr);
    t.ok(PA && PA.human.wins === 1 && PA.human.losses === 0 && PB && PB.human.losses === 1 && PB.human.wins === 0 && PA.matt.every(x => !x.wins && !x.losses), '4: /api/stats: 1-0 and 0-1 against people, Matt untouched');
    bye(a, b);
    [a, b] = await pair({ A, B }); hit(a); lose(b); await until(() => a.n('hit') >= 1, 15000); b.send({ type: 'leave' }); await over(a);
    pa = await prof(a); pb = await prof(b);
    t.ok(a.last('matchover').forfeit && pa && !pa.ranked && pa.why.join() === 'not_counted' && pb === null, '6: a forfeit with 0 points is not counted (the leaver, in the lobby, gets no result message)');
    const PB6 = await profileOf(B.d, B.addr); t.ok(PB6 && PB6.human.losses === 1 && PB6.played === 2, '6: the leaver: played, no loss for an early forfeit');
    t.ok(lastMatch(await exportOf(A.d, A.addr))?.reasons.includes('early_forfeit'), '6: the export says early_forfeit');
    bye(a, b);
    for (const [k, name] of [[2, '6: a forfeit after a point is ranked'], [3, '7: the third ranked result of the day is ranked'], [4, '7: the fourth is not: pair_cap']]) {
      [a, b] = await pair({ A, B }); hit(a); lose(b); await until(() => a.n('point') >= 1, 20000); b.send({ type: 'leave' }); await over(a); pa = await prof(a);
      t.ok(pa && pa.ranked === (k < 4), `${name} (ranked ${pa && pa.ranked})`);
      if (k === 4) t.ok(lastMatch(await exportOf(A.d, A.addr))?.reasons.includes('pair_cap') && pa.why.join() === 'not_counted', '7: pair_cap in the export only; the card says not_counted');
      bye(a, b);
    }
  }),
  sc('5. one computer: same address -> same_computer; same device on two addresses -> same_device', async t => {
    const X = ip(); let [a, b] = await pair({ A: { addr: X, d: dev() }, B: { addr: X, d: dev() } }), [pa, pb] = await duel(a, b);
    t.ok(pa && !pa.ranked && pa.why.join() === 'not_counted' && pb && !pb.ranked && pb.why.join() === 'not_counted', 'same fly-client-ip: unranked, and the card never says why (it would reveal the other player\'s network)');
    t.ok(lastMatch(await exportOf(a.d, X))?.reasons.includes('same_computer'), 'the export says same_computer'); bye(a, b);
    const D = dev(); [a, b] = await pair({ A: { addr: ip(), d: D }, B: { addr: ip(), d: D } }); [pa, pb] = await duel(a, b);
    t.ok(pa && !pa.ranked && pa.why.join() === 'self' && pb.why.join() === 'self', 'one device id in both seats: unranked, why self');
    const P = await profileOf(D, a.addr); t.ok(P && P.played === 1 && P.human.wins === 0 && P.human.losses === 0, 'one owner in both seats: played once, no W/L'); bye(a, b);
  }),
  sc('17. identity downgrade mid-match: the loss stays on the frozen device', async t => {
    const A = { addr: ip(), d: dev() }, B = { addr: ip(), d: dev() };
    for (const [k, extra, name] of [[1, { hello: false }, 'reconnects with no hello'], [2, { d: dev() }, 'reconnects with a DIFFERENT device id'], [3, {}, 'reconnects with the same device id']]) {
      const [a, b] = await pair({ A, B }); hit(a); lose(b); await until(() => a.n('hit') >= 1, 15000);
      const b2 = await drop(b, extra); lose(b2); await over(a); const pa = await prof(a), pb = await prof(b2);
      const PB = await profileOf(B.d, B.addr), PA = await profileOf(A.d, A.addr), x = lastMatch(await exportOf(A.d, A.addr));
      t.ok(pa && pa.ranked && PA.human.wins === k && PB && PB.human.losses === k, `${k}: the loser ${name}: loss on the original device (${PB && PB.human.losses}), the winner's win ranked`);
      t.ok(pb && pb.saved && !pb.why.some(w => w !== 'not_counted' && w !== 'restart' && w !== 'too_short' && w !== 'self'), `${k}: the loser's card says nothing about the opponent (${pb && pb.why})`);
      t.ok(x && x.reasons.includes('ident_changed') === (k < 3), `${k}: ident_changed ${k < 3 ? 'flagged' : 'not flagged for a plain reconnect'} (${x && x.reasons})`);
      bye(a, b2);
    }
  }),
  sc('18. a network hop onto the opponent\'s address mid-match -> same_computer', async t => {
    const X = ip(), [a, b] = await pair({ A: { addr: X, d: dev() }, B: { addr: ip(), d: dev() } }); hit(a); lose(b); await until(() => a.n('hit') >= 1, 15000);
    b.addr = X; const b2 = await drop(b); lose(b2); await over(a); const pa = await prof(a);
    t.ok(pa && !pa.ranked && lastMatch(await exportOf(a.d, X))?.reasons.includes('same_computer'), 'the seat\'s computer set meets the other seat\'s: unranked same_computer');
    bye(a, b2);
  }),
  sc('21. deleting a guest profile mid-match', async t => {
    const A = { addr: ip(), d: dev() }, B = { addr: ip(), d: dev() }, [a, b] = await pair({ A, B }); await duel(a, b);
    a.send({ type: 'rematch', yes: true }); b.send({ type: 'rematch', yes: true }); await until(() => a.n('rematchon'));
    const h0 = a.n('hit'); await until(() => a.n('hit') > h0, 15000);
    const r = await api(PORT, 'DELETE', '/api/account', { dev: A.d, confirm: 'delete' }, { addr: A.addr });
    t.ok(r.status === 200 && r.json.deleted.device === true && r.json.deleted.account === false, 'DELETE /api/account {dev}: 200, the device\'s profile deleted');
    await over(a, 2); const pa = await prof(a, 2), pb = await prof(b, 2);
    t.ok(pa && pa.saved === false, 'the deleted seat\'s match ends saved:false');
    t.ok(await profileOf(A.d, A.addr) === null, 'no owner was re-created for that device');
    const x = lastMatch(await exportOf(B.d, B.addr));
    t.ok(pb && pb.saved && x && !x.reasons.includes('anon_opponent') && (await profileOf(B.d, B.addr)).played === 2, `the other seat is recorded, never anon_opponent (${x && x.reasons})`);
    bye(a, b);
  }),
  sc('22. a teleporting paddle wins no ranked result against Matt', async t => {
    const c = await vsMatt({ level: 0, how: hit }), h = c.play; let burst = -1, k = 0, won = false;
    c.play = m => { if (burst !== c.n('matchover') && m.live) { burst = c.n('matchover'); for (const x of [-3.5, 3.5, -3.5, 3.5]) c.send({ type: 'paddle', x, y: 1, q: [0, 0, 0, 1] }); } h(m); };
    while (!won && k < 3) { k++; await over(c, k); await prof(c, k); won = c.got('matchover')[k - 1]?.winner === c.side; if (!won) c.send({ type: 'rematch', yes: true }); }
    const p = c.got('profile')[k - 1], P = await profileOf(c.d, c.addr), x = lastMatch(await exportOf(c.d, c.addr));
    t.ok(won && p && !p.ranked && p.first === false, `the teleporter won (${won}) and it is not ranked, no first win`);
    t.ok(P && P.matt[0].wins === 0 && P.matt[0].firstWinAt === null && P.matt[0].losses === k - 1 && x && x.reasons.includes('paddle_teleport'), 'no win on the rung, paddle_teleport in the export (its losses still count)');
    bye(c);
  }),
  sc('10, 11, 13. sockets that record nothing: a phone pad, a bad Origin, a malformed device id', async t => {
    const pd = dev(), pad = tab({ q: 'padfor=QRST', d: pd, addr: ip() }); await pad.open(); await until(() => pad.n('padhost'));
    await wait(200); t.ok(!pad.closed && await profileOf(pd, pad.addr) === null, '10: a pad socket\'s hello is ignored, nothing is stored');
    const e = await vsMatt({ level: 0, how: lose, origin: 'https://evil.example' }); await over(e); const pe = await prof(e);
    t.ok(pe && pe.saved === false && await profileOf(e.d, e.addr) === null, '11: Origin https://evil.example: it plays, records nothing');
    const g = await vsMatt({ level: 0, how: lose, origin: `http://localhost:${PORT}` }); await over(g); const pg = await prof(g);
    t.ok(pg && pg.saved === true, '11: an allowed Origin records');
    for (const bad of ['not-a-device-id', 'a'.repeat(100), 'ABCDEF01ABCDEF01ABCDEF01ABCDEF01']) {
      const m = await vsMatt({ level: 0, how: lose, d: bad }); await over(m); const pm = await prof(m);
      t.ok(pm && pm.saved === false, `13: malformed dev ${JSON.stringify(bad.slice(0, 12))}...: ignored, the seat is anonymous`); bye(m);
    }
    bye(pad, e, g);
  }),
  sc('12. the legacy LOCAL room records nothing', async t => {
    const c = tab({ q: 'x=1', d: dev(), addr: ip() }); await until(() => c.side != null); lose(c); await over(c, 1, 30000); await wait(400);
    t.ok(c.n('matchover') >= 1 && c.n('profile') === 0 && await profileOf(c.d, c.addr) === null, 'a finished LOCAL match: no profile message, nothing stored');
    bye(c);
  }),
]));

console.log('14. export and delete a guest profile');
{
  const { d, addr } = F.win, r = await api(PORT, 'POST', '/api/export', { dev: d }, { addr }), x = r.json;
  ok(r.status === 200 && /^attachment; filename="poddle-data-\d{4}-\d{2}-\d{2}\.json"$/.test(r.headers['content-disposition'] || '') && r.headers['cache-control'] === 'no-store', 'POST /api/export {dev}: a JSON attachment, no-store');
  ok(x && x.format === 'poddle-export-1' && x.kind === 'guest' && x.account === null && x.device && x.device.created && x.device.deletedAfter && x.profile && x.profile.matt.length === 4 && typeof x.notes === 'string', 'the 10.6 shape: format, kind guest, device dates, the profile, notes');
  const m = x && x.matches[0];
  ok(x && x.matches.length === F.win.played && m.kind === 'bot' && m.mattLevel === 'Rookie' && ['win', 'loss'].includes(m.result) && m.score.length === 2 && m.ending === 'won' && typeof m.counted === 'boolean' && Array.isArray(m.reasons), 'matches from the requester\'s side: ' + JSON.stringify(m));
  ok(!r.body.includes(d) && !/[0-9a-f]{64}/.test(r.body), 'the export carries neither the device id nor its hash');
  const del = await api(PORT, 'DELETE', '/api/account', { dev: d, confirm: 'delete' }, { addr });
  ok(del.status === 200 && del.json.deleted.device === true && del.json.deleted.account === false, 'DELETE /api/account {dev, confirm}: 200');
  ok(await profileOf(d, addr) === null && (await api(PORT, 'POST', '/api/export', { dev: d }, { addr })).status === 404, 'then /api/stats says profile:null and export 404 nothing');
  ok((await api(PORT, 'DELETE', '/api/account', { dev: d }, { addr })).status === 400, 'DELETE without confirm: 400');
  ok((await api(PORT, 'POST', '/api/stats', { dev: d }, { addr, origin: null })).status === 403 && (await api(PORT, 'POST', '/api/stats', { dev: d }, { addr, origin: 'https://evil.example' })).status === 403, 'no Origin or a foreign one: 403');
  ok((await api(PORT, 'POST', '/api/stats', 'dev=x', { addr, type: 'text/plain' })).status === 415, 'text/plain: 415');
  const me = await api(PORT, 'GET', '/api/me');
  ok(me.status === 200 && me.json.db === true && me.json.signin.enabled === false && me.json.signin.clientId === null && me.json.account === null, 'GET /api/me: db true, sign-in off (no GOOGLE_CLIENT_ID)');
  ok(me.headers['x-robots-tag'] === 'noindex' && me.headers['cross-origin-resource-policy'] === 'same-origin' && !Object.keys(me.headers).some(h => h.startsWith('access-control-')), 'API headers: noindex, CORP same-origin, no Access-Control-*');
  const home = await api(PORT, 'GET', '/', undefined, { origin: null });
  ok(home.headers['x-frame-options'] === 'DENY' && home.headers['content-security-policy'] === "frame-ancestors 'none'" && home.headers['referrer-policy'] === 'strict-origin-when-cross-origin' && home.headers['cross-origin-opener-policy'] === 'same-origin-allow-popups' && !home.headers['strict-transport-security'], 'security headers on every response (11.5); no HSTS off Fly');
}

console.log('8, 9, 19. a restart on the same database file');
const R = { addr: ip(), d: dev() }, rc = await vsMatt({ ...R, level: 2, how: still }); await wait(500);
const before = await profileOf(F.people.d, F.people.addr), code8 = rc.room.code, side8 = rc.side;
await stop(A); A = null;
ok(rc.got('restart').length === 1, 'SIGINT: the tab is told the server is restarting');
const B2 = await up(P2, { PODDLE_DB: DBA, ...BASE, REVIVE_S: '30' });
{
  const c = tab({ port: P2, ...R, cid: rc.cid, q: `lobby=1&room=${code8}&back=1&side=${side8}&score=1-0&pub=0&bot=2` }); await until(() => c.side != null && c.got('botinfo', i => i.active && i.level === 2).length);
  lose(c); await over(c); const p1 = await prof(c);
  ok(c.last('matchover').score.join() !== '0,2' && p1 && p1.saved && !p1.ranked && p1.why.includes('restart'), `8: the revived match (${c.last('matchover').score}) is saved but unranked: restart`);
  c.send({ type: 'rematch', yes: true }); await over(c, 2); const p2 = await prof(c, 2);
  ok(p2 && p2.ranked === true && p2.why.length === 0, '8: the rematch after it is ranked');
  bye(c, rc);
  const after = await profileOf(F.people.d, F.people.addr, P2);
  ok(before && after && JSON.stringify(after) === JSON.stringify(before), '9: after the restart /api/stats returns the same totals: ' + JSON.stringify(after && after.human));
  const h = tab({ port: P2, addr: ip(), d: dev(), q: 'lobby=1&room=WXYZ&back=1&side=0&score=0-0&pub=0' }); await until(() => h.side != null);
  await until(() => h.got('botinfo', i => i.active).length, 8000); lose(h); await over(h); const ph = await prof(h);
  ok(ph && !ph.ranked && ph.why.includes('restart') && ph.bests.length === 0, '19: a revived people court that falls back to Matt: the first match is unranked (restart), no bests');
  bye(h);
}
await stop(B2);

console.log('15. no database: the game plays exactly as before');
{
  const C = await up(P3, { ...BASE, PODDLE_DB: '/nonexistent/dir/x.db' });
  const c = await vsMatt({ port: P3, level: 0, how: lose }); await over(c); const p = await prof(c);
  ok(c.last('matchover') && p && p.saved === false, 'a bot match plays to the end; the profile message says saved:false');
  const me = await api(P3, 'GET', '/api/me'), st = await api(P3, 'POST', '/api/stats', { dev: c.d }, { addr: c.addr });
  ok(me.status === 200 && me.json.db === false && st.status === 503 && st.json.error === 'db_unavailable', `/api/me db:false, /api/stats 503 (${st.status})`);
  ok(/stats: database unavailable \([A-Z_]+\)/.test(logs.at(-1).out), 'one log line with the error code');
  bye(c); await stop(C);
}

console.log('20. database growth: only completed matches create profiles, and new guests are capped per computer (scaled: NEW_GUEST_DAY 3)');
{
  const C = await up(P3, { ...BASE, PODDLE_DB: path.join(tmp, 'd.db'), ADDR_ROOMS: '100', ROOM_CAP: '100', NEW_GUEST_DAY: '3' }), out = logs.at(-1);
  const X = ip(), quitters = await Promise.all(Array.from({ length: 12 }, async () => {
    const c = await vsMatt({ port: P3, addr: X, level: 0, how: lose }); await struck(c); c.send({ type: 'leave' }); await wait(300); return c; }));
  ok(quitters.every(c => c.got('welcome').length && c.got('botinfo', i => i.active).length), 'all 12 fresh devices got a court and Matt (none was turned away busy)');
  const none = await Promise.all(quitters.map(c => profileOf(c.d, X, P3)));
  ok(none.every(x => x === null) && !/match recorded/.test(out.out), 'create -> Matt -> one swing -> leave, 12 times: no profile, no match_log row');
  const Y = ip(), done = await Promise.all(Array.from({ length: 5 }, async () => { const c = await vsMatt({ port: P3, addr: Y, level: 0, how: lose }); await over(c); return [c, await prof(c)]; }));
  const saved = done.filter(([, p]) => p && p.saved).length;
  ok(saved === 3 && done.length === 5 && (out.out.match(/match recorded/g) || []).length === 3, `5 completed matches from one address: exactly 3 new guests saved (${saved}), the rest saved:false`);
  bye(...quitters, ...done.map(x => x[0])); await stop(C);
}

console.log('16. logs');
{
  const all = logs.map(l => l.out).join('\n'), hashes = DEVS.map(d => crypto.createHash('sha256').update(d).digest('hex'));
  const leaks = [...DEVS, ...hashes, ...IPS].filter(v => all.includes(v));
  ok(leaks.length === 0, `no server printed a device id, a device hash or an address (${DEVS.length} ids, ${IPS.length} addresses checked${leaks.length ? ': ' + leaks.length + ' found' : ''})`);
  ok(/match recorded: bot Rookie ranked/.test(all) && /match recorded: human (un)?ranked/.test(all), 'the match log line: court code, kind, level, counted or not');
}

console.log(fails ? fails + ' FAILURES' : 'STATS TESTS PASSED');
process.exit(fails ? 1 : 0);

