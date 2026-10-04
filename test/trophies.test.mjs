// Trophies, server side (docs/TROPHIES.md 3 and 6): one real server on a database seeded with accounts (usernames, sessions, a few ladder rows),
// scripted ws clients signed in by cookie. Two accounts play a game: profile.trophies +30 / -6 (a Bronze loss, NOTES 194), the ladder rows, delta_a / delta_b (the export's
// trophyDelta), mode ladder; a guest gets none: signin, a username-less account none: username; Matt pays mattDelta, then the day cap (MATT_DAY)
// and the ceiling; an easy Matt pays 0 with limit easy; a leaver after the first strike pays the loss and the stayer wins; a leave before the
// first strike is silent; the emblem rides welcome.rank / names.rank / matchover.rank on a plain court; old-client rk messages are ignored;
// /ranked is a 301 to /ranks. Then (the verify round): four forfeits by one pair hit pair_cap on the fourth (a paid forfeit win counts like a
// counted one, db.js PAID); an eligible opponent without a row is gap 0 (3.3); one person on both seats or an anonymous seat: +0 left_early, and
// the same_account leaver pays nothing; an account deleted mid-game saves nothing; a tournament of four pays +30 / -6 as kind tour and carries
// the emblem on tmove (vs, you) and the bracket snapshot. Every game is one point (WIN_AT 1); scenarios run side by side on their own courts. Under 90 s.
//   node test/trophies.test.mjs        TROPHIES_PORT=<port> moves the server (default 9460). Last line: TROPHIES TESTS PASSED or n FAILURES.
import { spawn } from 'child_process';
import WebSocket from 'ws';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const PORT = +process.env.TROPHIES_PORT || 9460, root = new URL('..', import.meta.url).pathname;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'poddle-tro-')), FILE = path.join(tmp, 't.db');
const MATT_DAY = 11;                                              // Bronze pays 10: the second win pays 1, the third 0 (limit day)
const ENV = { PODDLE_DB: FILE, GOOGLE_CLIENT_ID: 'test.apps.googleusercontent.com', WIN_AT: '1', WIN_BY: '1', READY_S: '0', SWING_SERVE: '0', REMATCH_S: '5', HOLD_S: '2',
  STATS_MIN_POINT_S: '0', STATS_AFK_MIN: '0', STATS_FORFEIT_MIN: '1', STATS_ESTABLISHED: '0', TIMESCALE: '2', ROOM_CAP: '100', ADDR_ROOMS: '100', MATT_DAY: String(MATT_DAY),
  TOUR_WIN: '1', TOUR_FINAL: '1', TOUR_VS_S: '0.3', TOUR_ARRIVE_S: '3', TOUR_GAP_S: '0.3', TOUR_DONE_S: '2', TOUR_CAP: '4' };   // a tournament of one-point matches on short clocks (test/tourney.test.mjs)
const LAD = require('../server/ladder.js'), U = require('../server/usernames.js');

// the database first, as the server will find it: accounts with usernames (and one without), a session each, a few ladder rows (docs/ACCOUNTS.md 12.2 style)
const RAW = {}, OWNER = {};
{ const db = require('../server/db.js'), quiet = console.error; console.error = () => {};
  db.open(FILE); const now = Date.now();
  const mk = (sub, name, trophies = 0) => { const a = db.createAccount(sub, now); if (name) db.claimUsername(a.id, name, U.skeleton(name), now); RAW[sub] = db.session.create(a.id, now); OWNER[sub] = a.owner_id;
    if (trophies) db.ladderApply({ owner: a.owner_id, delta: trophies, won: true, vsBot: false, now }); };   // a seeded row: paid once (one win on its record)
  mk('ann', 'Ann', 140); mk('ben', 'Ben', 140);                  // Bronze III both: the gap is 0, so +30 / -6 exactly (Bronze's loss); Ann's win is a rank-up to Silver I
  mk('cal', 'Cal'); mk('dee', 'Dee'); mk('bare', null);          // Cal plays a guest, Dee a username-less account
  mk('fay', 'Fay'); mk('hal', 'Hal', 160);                       // Fay: Matt at Rookie (Bronze pays there); Hal: Silver needs Club, Rookie is easy
  mk('ivy', 'Ivy', 100); mk('jon', 'Jon', 100);                  // the leaver rule
  mk('kim', 'Kim', 100); mk('lou', 'Lou', 100);                  // a leave before the first strike
  mk('eve', 'Eve', 899);                                         // Master III at the ceiling: Matt cannot take her further
  mk('pam', 'Pam', 100); mk('quin', 'Quin', 100);                // four forfeits by one pair: the pair cap
  mk('max', 'Max', 180); mk('ned', 'Ned');                       // Silver Max (180: a loss of 20 stays over Silver's floor) against an eligible opponent without a row
  mk('ron', 'Ron', 100); mk('sid', 'Sid', 100);                  // Ron on both seats; Sid against an anonymous seat
  mk('wes', 'Wes', 100); mk('xan', 'Xan', 100);                  // Xan deletes the account mid-game
  mk('tia', 'Tia', 100); mk('uli', 'Uli', 100); mk('vera', 'Vera', 100); mk('wil', 'Wil', 100);   // a tournament of four, Bronze III all: gap 0 everywhere
  db.close(); console.error = quiet; }

const procs = new Set(); let out = '';
function up(port, env) {
  return new Promise(res => { const p = spawn('node', ['server/game.js'], { cwd: root, env: { ...process.env, PORT: port, ...env } }); procs.add(p);
    const eat = d => { out += d; if (/game server on port/.test(d)) res(p); }; p.stdout.on('data', eat); p.stderr.on('data', eat); p.on('exit', () => procs.delete(p)); });
}
process.on('exit', () => { for (const p of procs) p.kill(); fs.rmSync(tmp, { recursive: true, force: true }); });
process.on('unhandledRejection', e => { console.error(e); process.exit(1); });
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (f, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (f()) return true; await wait(25); } return !!f(); };
let fails = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
const J = v => JSON.stringify(v);
let ipn = 0; const ip = () => `203.0.113.${++ipn}`;              // TEST-NET-3: one fresh computer per call (the loopback peer makes the header trusted)
let cn = 0; const cidN = () => 'tro' + (++cn) + 'x' + crypto.randomBytes(3).toString('hex');

// A tab: signed in as `who` (a cookie), hello with a device id first thing, everything it hears kept in log, state kept apart
function tab({ who = null, addr = ip(), d = crypto.randomUUID(), cid = cidN(), q = 'lobby=1', hello = true } = {}) {
  const headers = { origin: `http://localhost:${PORT}`, 'fly-client-ip': addr }; if (who) headers.cookie = `poddle_s=${RAW[who]}`;
  const ws = new WebSocket(`ws://localhost:${PORT}/?${q}&cid=${cid}`, { headers }), c = { ws, who, cid, d, addr, log: [], st: null, side: null, closed: false, play: null };
  ws.on('open', () => { if (hello) ws.send(JSON.stringify({ type: 'hello', dev: d, v: 1 })); });
  ws.on('message', raw => { const m = JSON.parse(raw);
    if (m.type === 'state') { c.st = m; if (c.play) c.play(m); return; }
    c.log.push(m); if (m.type === 'welcome') c.side = m.side; if (m.type === 'room') c.room = m; if (m.type === 'tour') c.tour = m; });
  ws.on('close', () => { c.closed = true; }); ws.on('error', () => {});
  c.send = o => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
  c.got = (t, f) => c.log.filter(m => m.type === t && (!f || f(m))); c.last = t => c.got(t).pop(); c.n = t => c.got(t).length;
  c.open = () => until(() => ws.readyState === 1, 4000);
  return c;
}
// behaviours (test/stats.test.mjs): hit plays well and serves; still is ready and never swings (a serve goes by itself under SWING_SERVE 0)
function hit(c) { let cool = 0; c.play = m => {
  c.send({ type: 'paddle', auto: true, q: [0, 0, 0, 1] });
  const me = m.paddles[c.side], s = c.side === 0 ? 1 : -1; if (!me || Date.now() < cool) return;
  if (m.serving === c.side) { cool = Date.now() + 600; return c.send({ type: 'swing', power: 20, dir: 0.3, lob: 0, final: true, pk: 20, src: 'airpod' }); }
  if (m.live && Math.abs(m.p[0] - me.x) < 0.9 && Math.abs(m.p[1] - me.y) < 0.8 && -(m.p[2] - me.z) * s < 1.0 && -(m.p[2] - me.z) * s > -0.5 && m.v[2] * s > 0) {
    cool = Date.now() + 400; c.send({ type: 'swing', power: 14 + Math.random() * 16, dir: (Math.random() - 0.5) * 1.6, lob: 0, final: true, pk: 22, src: 'airpod' }); }
}; }
const still = c => { c.play = () => c.send({ type: 'paddle', auto: true, q: [0, 0, 0, 1] }); };
const over = (c, k = 1, ms = 45000) => until(() => c.n('matchover') >= k, ms);
const prof = (c, k = 1, ms = 3000) => until(() => c.n('profile') >= k, ms).then(() => c.got('profile')[k - 1] || null);
const struck = (c, k = 1, ms = 15000) => until(() => c.n('hit') + c.n('launch') >= k, ms);
// HTTP as the page would call it
function api(method, p, body, { who, addr = '203.0.113.250', origin = `http://localhost:${PORT}` } = {}) {
  return new Promise(res => {
    const data = body === undefined ? null : JSON.stringify(body), headers = { 'fly-client-ip': addr }; if (origin) headers.origin = origin; if (who) headers.cookie = `poddle_s=${RAW[who]}`;
    if (data != null) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    const rq = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers }, r => { let s = ''; r.on('data', d => s += d); r.on('end', () => { let j = null; try { j = JSON.parse(s); } catch { /* not json */ } res({ status: r.statusCode, headers: r.headers, body: s, json: j }); }); });
    rq.on('error', e => res({ status: 0, error: e.code })); if (data != null) rq.write(data); rq.end();
  });
}
const ladderOf = async who => ((await api('POST', '/api/stats', {}, { who })).json?.profile ?? {}).ladder ?? null;   // a signed-in tab asks with its cookie
const exportOf = async who => (await api('POST', '/api/export', {}, { who })).json;
const lastMatch = x => (x && x.matches || []).slice().sort((p, q) => (p.at < q.at ? -1 : 1)).pop() || null;
// two people on one court: a makes it, b joins by its code; nobody plays until both are seated
async function pair(A, B) {
  const a = tab(A), b = tab(B); await a.open(); await b.open(); await until(() => a.n('lobby') && b.n('lobby'));
  a.send({ type: 'create', public: false }); await until(() => a.room);
  b.send({ type: 'join', code: a.room.code }); await until(() => a.side != null && b.side != null && a.got('names', m => m.names.every(Boolean)).length);
  return [a, b];
}
async function vsMatt({ who, level = 0, how = hit } = {}) {      // a court of one against Matt at `level`
  const c = tab({ who }); await c.open(); await until(() => c.n('lobby'));
  c.send({ type: 'create', public: false }); await until(() => c.side != null);
  c.send({ type: 'bot', level }); await until(() => c.got('botinfo', i => i.active && i.level === level).length);
  if (how) how(c); return c;
}
// play Matt until `wins` wins (rematch after every game); -> the profile messages of the won games, in order
async function beatMatt(c, wins, most = 9) {
  const won = []; let k = 0;
  while (won.length < wins && k < most) { k++; await over(c, k); const p = await prof(c, k); if (c.got('matchover')[k - 1]?.winner === c.side) won.push(p); if (won.length < wins && k < most) c.send({ type: 'rematch', yes: true }); }
  return won;
}
const bye = (...cs) => cs.forEach(c => { try { c.ws.terminate(); } catch { /* gone */ } });
function sc(name, fn) { const lines = [], t = { ok: (c, m) => lines.push([!!c, m]) };
  return fn(t).catch(e => lines.push([false, 'threw: ' + (e && e.stack || e)])).then(() => ({ name, lines })); }
function report(rs) { for (const r of rs) { console.log(r.name); for (const [c, m] of r.lines) ok(c, m); } }
const T0 = Date.now();

console.log('server: ' + PORT + ' (MATT_DAY ' + MATT_DAY + ')');
await up(PORT, ENV);

report(await Promise.all([
  sc('1. two accounts with usernames: +30 / -6, the ladder rows, delta_a / delta_b, mode ladder, the emblem on a plain court', async t => {
    const [a, b] = await pair({ who: 'ann' }, { who: 'ben' });
    t.ok(J(a.last('welcome').rank) === J([{ tier: 1, div: 3 }, null]) && J(b.last('welcome').rank) === J([{ tier: 1, div: 3 }, { tier: 1, div: 3 }]) && J(a.got('names').at(-1).rank) === J([{ tier: 1, div: 3 }, { tier: 1, div: 3 }]), `welcome.rank / names.rank carry the emblems (Bronze III both) on a plain court: ${J(a.got('names').at(-1).rank)}`);
    hit(a); still(b); await over(a); await over(b); const pa = await prof(a), pb = await prof(b);
    const ta = pa && pa.trophies, tb = pb && pb.trophies;
    t.ok(pa && pa.saved && pa.ranked && pa.kind === 'human' && ta && ta.delta === 30 && ta.trophies === 170 && ta.tierWas === 1 && ta.divWas === 3 && ta.tier === 2 && ta.div === 1 && ta.counted === true && ta.saved === true && ta.matt === false && ta.floorHeld === false && J(ta.why) === '[]' && ta.limit === undefined,
      `Ann's profile message: trophies +30, 140 -> 170, Bronze III -> Silver I: ${J(ta)}`);
    t.ok(tb && tb.delta === -6 && tb.trophies === 134 && tb.tier === 1 && tb.div === 3 && tb.counted === true && tb.saved === true && tb.floorHeld === false, `Ben's: -6, 140 -> 134, still Bronze III: ${J(tb)}`);
    t.ok(J(a.last('matchover').rank) === J([{ tier: 2, div: 1 }, { tier: 1, div: 3 }]) && J(a.got('names').at(-1).rank[0]) === J({ tier: 2, div: 1 }), `matchover.rank and names.rank show the new rank: ${J(a.last('matchover').rank)}`);
    const la = await ladderOf('ann'), lb = await ladderOf('ben');
    t.ok(la && la.trophies === 170 && la.tier === 2 && la.div === 1 && la.wins === 2 && la.losses === 0 && la.streak === 2 && la.bestTier === 2 && lb && lb.trophies === 134 && lb.losses === 1 && lb.streak === 0, `/api/stats ladder rows: Ann ${J(la && [la.trophies, la.wins, la.losses])}, Ben ${J(lb && [lb.trophies, lb.wins, lb.losses])}`);
    const xa = lastMatch(await exportOf('ann')), xb = lastMatch(await exportOf('ben'));
    t.ok(xa && xa.mode === 'ladder' && xa.kind === 'human' && xa.trophyDelta === 30 && xa.result === 'win' && xb && xb.mode === 'ladder' && xb.trophyDelta === -6 && xb.result === 'loss', `the export: mode ladder, trophyDelta 30 (delta_a) and -6 (delta_b): ${J([xa && xa.trophyDelta, xb && xb.trophyDelta])}`);
    t.ok(/match recorded: human ranked \(\+30\/-6\)/.test(out), 'the log line: match recorded: human ranked (+30/-6)');
    bye(a, b);
  }),
  sc('2. a guest against an account: only the account moves (gap 0), the guest hears none: signin', async t => {
    const [g, c] = await pair({}, { who: 'cal' }); still(g); hit(c); await over(c); await over(g); const pg = await prof(g), pc = await prof(c);
    t.ok(pg && pg.saved && J(pg.trophies) === J({ none: 'signin' }), `the guest's profile message: trophies { none: signin } (${J(pg && pg.trophies)})`);
    t.ok(pc && pc.trophies && pc.trophies.delta === 30 && pc.trophies.trophies === 30 && pc.trophies.counted, `Cal's: +30 from 0 (an opponent without a row is gap 0): ${J(pc && pc.trophies)}`);
    t.ok(J(c.last('welcome').rank) === J([null, null]) && J(c.last('matchover').rank) === J([null, { tier: 1, div: 1 }]), `no emblem before a first row, Cal's Bronze I after it: ${J(c.last('matchover').rank)}`);
    const lc = await ladderOf('cal'); t.ok(lc && lc.trophies === 30 && lc.wins === 1, 'Cal has a ladder row now');
    t.ok(lastMatch(await exportOf('cal'))?.mode === 'ladder', 'mode ladder: one seat was eligible');
    bye(g, c);
  }),
  sc('3. an account without a username hears none: username', async t => {
    const [n, d] = await pair({ who: 'bare' }, { who: 'dee' }); still(n); hit(d); await over(d); await over(n); const pn = await prof(n), pd = await prof(d);
    t.ok(pn && J(pn.trophies) === J({ none: 'username' }), `the username-less seat: trophies { none: username } (${J(pn && pn.trophies)})`);
    t.ok(pd && pd.trophies && pd.trophies.delta === 30 && pd.trophies.saved, `Dee's: +30 (${J(pd && pd.trophies)})`);
    t.ok((await ladderOf('bare')).trophies === 0 && (await api('POST', '/api/stats', {}, { who: 'bare' })).json.profile.ladder.wins === 0, 'no ladder row was written for the account without a username');
    bye(n, d);
  }),
  sc('4. Matt: a counted win pays mattDelta at the rank\'s level, the day cap holds after it, a loss pays 0', async t => {
    const c = await vsMatt({ who: 'fay', level: 2, how: still }); await over(c); const p0 = await prof(c), l0 = await ladderOf('fay');   // the first game is lost on purpose (no swing, against Pro: Rookie can whiff a serve): a loss before any row
    t.ok(c.last('matchover').winner !== c.side && p0 && p0.trophies && p0.trophies.matt === true && p0.trophies.delta === 0 && p0.trophies.limit === undefined && p0.trophies.counted && l0 && l0.trophies === 0 && l0.botLosses === 0, `a loss to Matt before any row: 0, no limit, and no row written (bot_losses ${l0 && l0.botLosses}): ${J(p0 && p0.trophies)}`);
    c.send({ type: 'rematch', yes: true }); await until(() => c.n('rematchon')); c.send({ type: 'bot', level: 0 }); await until(() => c.got('botinfo', i => i.active && i.level === 0).length);   // Rookie from here (before the first strike: the game counts at the easiest level used)
    hit(c); const won = await beatMatt(c, 3, 10);
    t.ok(won.length === 3, `Fay beat Rookie three times within ten games (${won.length})`);
    const w = won.map(p => p && p.trophies);
    t.ok(w[0] && w[0].matt === true && w[0].delta === 10 && w[0].trophies === 10 && w[0].counted && w[0].saved && w[0].limit === undefined && w[0].need === 0, `the first win pays mattDelta(Bronze) 10 (${J(w[0])})`);
    t.ok(w[1] && w[1].delta === 1 && w[1].trophies === 11 && w[1].limit === undefined, `the second pays what the day has left, 1 (MATT_DAY ${MATT_DAY}): ${J(w[1])}`);
    t.ok(w[2] && w[2].delta === 0 && w[2].trophies === 11 && w[2].limit === 'day' && w[2].counted, `the third pays 0 with limit day: ${J(w[2])}`);
    const all = c.got('profile'), lost = all.filter(p => !won.includes(p)).map(p => p.trophies), after = all.slice(all.indexOf(won[0]) + 1).filter(p => !won.includes(p)).length;   // losses after the first win: the row exists by then and counts them
    t.ok(lost.length >= 1 && lost.every(x => x && x.matt && x.delta === 0 && x.limit === undefined), `every loss to Matt is 0 with no limit (${lost.length} losses)`);
    const l = await ladderOf('fay'); t.ok(l && l.trophies === 11 && l.botWins === 3 && l.botLosses === after && l.wins === 0 && l.mattDayLeft === 0, `the ladder row: 11 trophies, bot W-L ${l && l.botWins + '-' + l.botLosses} (a loss before the first row writes nothing), nothing on the person record, day used up`);
    t.ok(lastMatch(await exportOf('fay'))?.mode === 'ladder' && /match recorded: bot Rookie ranked \(\+10\)/.test(out), 'mode ladder and the log line (+10) for the Matt game');
    bye(c);
  }),
  sc('5. Matt at an easy level pays 0 with limit easy', async t => {
    const c = await vsMatt({ who: 'hal', level: 0 }), won = await beatMatt(c, 1, 6), w = won[0] && won[0].trophies;
    t.ok(won.length === 1 && w && w.delta === 0 && w.limit === 'easy' && w.need === 1 && w.matt && w.counted && w.trophies === 160 && w.tier === 2, `Silver Hal beats Rookie: 0, limit easy, need 1 (Club): ${J(w)}`);
    const l = await ladderOf('hal'); t.ok(l && l.trophies === 160 && l.botWins === 1, 'the win is on the row (bot_wins), the count unchanged');
    bye(c);
  }),
  sc('6. a leaver after the first strike pays the loss, the stayer takes the win', async t => {
    const [a, b] = await pair({ who: 'ivy' }, { who: 'jon' }); hit(a); still(b); await struck(a); b.send({ type: 'leave' }); await over(a); const pa = await prof(a);
    t.ok(a.last('matchover').forfeit && pa && !pa.ranked && pa.trophies && pa.trophies.delta === 30 && pa.trophies.counted === true && pa.trophies.trophies === 130 && J(pa.trophies.why) === '[]', `the stayer: not counted as a match (early forfeit) but +30 trophies: ${J(pa && pa.trophies)}`);
    await wait(300); const lb = await ladderOf('jon'), la = await ladderOf('ivy');
    t.ok(lb && lb.trophies === 94 && lb.losses === 1 && lb.streak === 0 && la && la.trophies === 130 && la.wins === 2, `Jon paid -6 (100 -> ${lb && lb.trophies}), Ivy took +30 (100 -> ${la && la.trophies})`);
    t.ok(lastMatch(await exportOf('jon'))?.trophyDelta === -6 && lastMatch(await exportOf('jon'))?.reasons.includes('early_forfeit') && /match recorded: human unranked \(\+30\/-6\)/.test(out), 'the export: trophyDelta -6 on an early_forfeit row; the log line (+30/-6)');
    bye(a, b);
  }),
  sc('7. a leave before the first strike is silent', async t => {
    const [a, b] = await pair({ who: 'kim' }, { who: 'lou' }); await wait(300); b.send({ type: 'leave' }); await until(() => a.n('left')); await wait(400);
    t.ok(a.n('matchover') === 0 && a.n('profile') === 0 && b.n('profile') === 0, 'no matchover, no profile message on either side');
    t.ok((await ladderOf('kim')).trophies === 100 && (await ladderOf('lou')).trophies === 100 && (await ladderOf('lou')).losses === 0, 'nothing moved on either row');
    bye(a, b);
  }),
  sc('9. at the ceiling (Master III, 899) a game against Pro Matt that is lost pays 0 and stays at 899', async t => {   // a scripted client cannot beat Pro Matt (the rally never ends), so the win that limit ceiling would stop is covered by the db test (accounts-unit: mattAward, the 899 ceiling)
    const c = await vsMatt({ who: 'eve', level: 2, how: still }); await over(c); const p = await prof(c), w = p && p.trophies;
    t.ok(c.last('matchover').winner !== c.side && w && w.matt === true && w.delta === 0 && w.trophies === 899 && w.tier === 6 && w.div === 3 && w.counted && w.saved && w.limit === undefined, `the loss: 0, still 899 Master III, no limit (${J(w)})`);
    const l = await ladderOf('eve'); t.ok(l && l.trophies === 899 && l.botLosses === 1 && l.botWins === 0, 'the row counts the Matt loss');
    t.ok(J(c.last('welcome').rank) === J([{ tier: 6, div: 3 }, null]), `the Master III emblem on her seat against Matt: ${J(c.last('welcome').rank)}`);
    bye(c);
  }),
  sc('8. old clients: rk, rkleave, rkwarm and ?rk=1 are ignored; /ranked is a 301; no mode fields', async t => {
    const c = tab({ who: 'ann' }); await c.open(); await until(() => c.n('lobby')); const n0 = c.log.length;
    c.send({ type: 'rk', name: 'Ann' }); c.send({ type: 'rkwarm' }); c.send({ type: 'rkleave' }); await wait(500);
    t.ok(!c.closed && c.log.slice(n0).every(m => m.type === 'lobby' || m.type === 'social') && !c.log.some(m => ['rk', 'rkfail', 'rkend', 'rkvs', 'rkres'].includes(m.type)), `the lobby socket stays open and hears no mode message (${J(c.log.slice(n0).map(m => m.type))})`);
    const r = tab({ who: 'ben', q: 'lobby=1&rk=1' }); await r.open(); await until(() => r.n('lobby')); await wait(300);
    t.ok(!r.closed && r.n('lobby') >= 1 && !r.log.some(m => ['rk', 'rkfail', 'rkend'].includes(m.type)), 'a socket connecting with ?rk=1 is an ordinary lobby socket');
    t.ok(!/bad message/.test(out), 'the server logged nothing about them');
    const h = await api('GET', '/ranked', undefined, { origin: null }), h2 = await api('GET', '/ranked?x=1', undefined, { origin: null });
    t.ok(h.status === 301 && h.headers.location === '/ranks' && h2.status === 301 && h2.headers.location === '/ranks?x=1', `GET /ranked -> 301 /ranks (${h.status} ${h.headers.location})`);
    const st = await api('GET', '/status.json', undefined, { origin: null }), me = await api('GET', '/api/me', undefined, { who: 'ann' });
    t.ok(st.json && !('rk' in st.json) && me.json && !('rkSignin' in me.json) && me.json.ladder && me.json.ladder.trophies >= 140, 'status.json has no rk, /api/me no rkSignin (its ladder block stays)');
    const w = tab({ who: 'ann' }); await w.open(); await until(() => w.n('lobby')); w.send({ type: 'create', public: false }); await until(() => w.side != null);
    t.ok(!('venue' in w.last('welcome')) && !('series' in w.last('welcome')) && Array.isArray(w.last('welcome').rank), 'welcome carries rank but no venue or series');
    bye(c, r, w);
  }),
  sc('10. four forfeits by one pair in a day: the fourth pays the stayer 0 (pair_cap counts paid forfeit wins), the leaver still pays', async t => {
    const got = [];
    for (let k = 1; k <= 4; k++) { const [a, b] = await pair({ who: 'pam' }, { who: 'quin' }); hit(a); still(b); await struck(a); b.send({ type: 'leave' }); await over(a); const pa = await prof(a); got.push(pa && pa.trophies); bye(a, b); await wait(200); }
    t.ok(J(got.slice(0, 3).map(x => x && x.delta)) === J([30, 29, 26]) && got.slice(0, 3).every(x => x.counted === true), `the first three forfeit wins pay, the gap growing each time and the third from Silver I (winOf 29, NOTES 203): ${J(got.slice(0, 3).map(x => x && x.delta))} (30, 29, 26)`);
    t.ok(got[3] && got[3].delta === 0 && got[3].counted === false && J(got[3].why) === J(['left_early']) && got[3].trophies === 185, `the fourth: +0, why left_early (pair_cap, R10 sees the three paid rows): ${J(got[3])}`);
    const lp = await ladderOf('pam'), lq = await ladderOf('quin');
    t.ok(lp && lp.trophies === 185 && lp.wins === 4 && lq && lq.trophies === 78 && lq.losses === 4, `Pam 100 -> 185 (three paid), Quin 100 -> 78 (four Bronze losses: 6, 6, 5, 5): ${J([lp && lp.trophies, lq && lq.trophies])}`);
    t.ok((lastMatch(await exportOf('pam')) || {}).reasons?.includes('pair_cap') && lastMatch(await exportOf('quin'))?.trophyDelta === -5, 'the fourth row carries pair_cap and the leaver\'s -5');
  }),
  sc('11. an eligible opponent without a ladder row counts as gap 0 for the one with a row; the newcomer reads the real gap', async t => {
    const [n, m] = await pair({ who: 'ned' }, { who: 'max' }); hit(n); still(m); await over(n); await over(m); const pn = await prof(n), pm = await prof(m);
    t.ok(pn && pn.trophies && pn.trophies.delta === 37 && pn.trophies.trophies === 37 && pn.trophies.counted, `Ned (no row) beats Silver Max (180): +37, the gap of 180: ${J(pn && pn.trophies)}`);
    t.ok(pm && pm.trophies && pm.trophies.delta === -10 && pm.trophies.trophies === 170 && pm.trophies.floorHeld === false, `Max loses to a rowless opponent: Silver's -10 (gap 0, not -15 from Ned's 0): ${J(pm && pm.trophies)}`);
    bye(n, m);
  }),
  sc('12. one person on both seats (same_account): a leave charges nobody; a stayer facing an anonymous seat gets +0 left_early', async t => {
    const [a, b] = await pair({ who: 'ron' }, { who: 'ron' }); hit(a); still(b); await struck(a); b.send({ type: 'leave' }); await over(a); const pa = await prof(a);
    t.ok(a.last('matchover').forfeit && pa && pa.trophies && pa.trophies.delta === 0 && pa.trophies.counted === false && J(pa.trophies.why) === J(['left_early']) && pa.trophies.trophies === 100, `the stayer: +0, left_early (same_account is beyond the forfeit's own flags): ${J(pa && pa.trophies)}`);
    await wait(300); const lr = await ladderOf('ron'); t.ok(lr && lr.trophies === 100 && lr.losses === 0 && lr.wins === 1, `Ron paid nothing as the leaver either (R6: nobody left anyone): ${J(lr && [lr.trophies, lr.wins, lr.losses])}`);
    t.ok(/match recorded: human unranked \(0\/0\)/.test(out), 'the log line: human unranked (0/0)');
    bye(a, b);
    const [x, s] = await pair({ hello: false }, { who: 'sid' }); still(x); hit(s); await struck(s); x.send({ type: 'leave' }); await over(s); const ps = await prof(s);
    t.ok(ps && ps.trophies && ps.trophies.delta === 0 && ps.trophies.counted === false && J(ps.trophies.why) === J(['left_early']), `Sid, left by an anonymous seat (anon_opponent): +0, left_early: ${J(ps && ps.trophies)}`);
    t.ok((await ladderOf('sid')).trophies === 100, 'nothing moved on Sid\'s row');
    bye(x, s);
  }),
  sc('14. an account deleted mid-game: its seat saves nothing (saved false); the other seat is paid from the counts frozen at the start', async t => {
    const [w, x] = await pair({ who: 'wes' }, { who: 'xan' }); hit(w); still(x); await struck(w);
    const d = await api('DELETE', '/api/account', { confirm: 'delete' }, { who: 'xan' });
    t.ok(d.status === 200 && d.json && d.json.deleted && d.json.deleted.account === true, `Xan deletes the account mid-game (${d.status} ${J(d.json)})`);
    await over(w); const pw = await prof(w), px = await prof(x);
    t.ok(pw && pw.trophies && pw.trophies.delta === 30 && pw.trophies.trophies === 130 && pw.trophies.saved === true, `Wes: +30 (gap 0, frozen at the start): ${J(pw && pw.trophies)}`);
    t.ok(px && px.saved === false && px.trophies && px.trophies.saved === false && px.trophies.delta === 0 && px.trophies.trophies === 100, `Xan's profile message: saved false, nothing moved: ${J(px && px.trophies)}`);
    t.ok((await api('POST', '/api/stats', {}, { who: 'xan' })).json?.profile?.ladder == null, 'Xan\'s session no longer reads a ladder row');
    bye(w, x);
  }),
  sc('15. a tournament: kind tour pays +30 / -6 per match; the rank emblem rides tmove (vs and you) and the bracket snapshot', async t => {
    const h = tab({ who: 'tia' }); await h.open(); await until(() => h.n('lobby')); h.send({ type: 'tcreate', name: 'Tia' }); await until(() => h.tour);
    const ps = [h]; for (const who of ['uli', 'vera', 'wil']) { const c = tab({ who }); await c.open(); await until(() => c.n('lobby')); c.send({ type: 'join', code: h.tour.code, name: who }); await until(() => c.tour); ps.push(c); }   // nobody is ready yet: the warm-ups never serve
    await until(() => h.tour.n === 4); h.send({ type: 'tstart' }); await until(() => ps.every(p => p.n('tmove')), 5000); ps.forEach(still);   // ready from the VS card on: the serve goes by itself and the receiver whiffs, one point ends a match
    const tm = ps.map(p => p.last('tmove'));
    t.ok(tm.every(m => m && m.vs && m.vs.tier === 1 && m.vs.div === 3 && m.vs.bot === false && m.you && m.you.tier === 1 && m.you.div === 3), `tmove carries both emblems, Bronze III (vs and you): ${J(tm[0])}`);
    await until(() => h.tour && h.tour.phase === 'play' && h.tour.rounds[0].matches.every(x => x.a.id != null));
    t.ok(h.tour.players.length === 4 && h.tour.players.every(p => p.tier === 1 && p.div === 3) && h.tour.rounds[0].matches.every(x => x.a.tier === 1 && x.a.div === 3 && x.b.tier === 1 && x.b.div === 3) && h.tour.rounds[1].matches[0].a.tier === null, `the bracket snapshot: tier / div on every player and both sides of a drawn match, null on To be decided: ${J(h.tour.rounds[0].matches[0].a)}`);
    t.ok(await until(() => ps.every(p => p.n('matchover') >= 1), 20000), 'both semifinals end');
    const sem = await Promise.all(ps.map(p => prof(p, 1)));
    t.ok(sem.every(p => p && p.kind === 'tour' && p.ranked && p.saved && p.trophies && p.trophies.counted) && sem.filter(p => p.trophies.delta === 30 && p.trophies.trophies === 130).length === 2 && sem.filter(p => p.trophies.delta === -6 && p.trophies.trophies === 94).length === 2, `the semifinals: kind tour, two +30 and two -6: ${J(sem.map(p => p && p.trophies && p.trophies.delta))}`);
    t.ok(await until(() => h.tour && h.tour.phase === 'done', 25000), 'the final ends, a champion');
    const fin = ps.filter(p => p.n('matchover') >= 2), pf = await Promise.all(fin.map(p => prof(p, 2)));
    t.ok(fin.length === 2 && pf.some(p => p && p.trophies && p.trophies.delta === 30 && p.trophies.trophies === 160) && pf.some(p => p && p.trophies && p.trophies.delta === -6 && p.trophies.trophies === 124), `the final: +30 to 160, -6 to 124: ${J(pf.map(p => p && p.trophies && [p.trophies.delta, p.trophies.trophies]))}`);
    const x = lastMatch(await exportOf('tia')); t.ok(x && x.kind === 'tour' && x.mode === 'ladder' && [30, -6].includes(x.trophyDelta), `Tia's export: kind tour, mode ladder, trophyDelta ${x && x.trophyDelta}`);
    t.ok(/match recorded: tour ranked \((\+30\/-6|-6\/\+30)\)/.test(out), 'the log line: tour ranked (+30/-6)');
    bye(...ps);
  }),
]));

console.log(`done in ${Math.round((Date.now() - T0) / 1000)} s`);
console.log(fails ? fails + ' FAILURES' : 'TROPHIES TESTS PASSED');
process.exit(fails ? 1 : 0);
