// Tournaments (docs/COURTS-TOURNEY.md 4, docs/TOURNAMENT.md): a host makes one, people sign up by its code and warm up against Tour Matt, the host
// starts it (4-16), single elimination with Matt in any odd spot (never Matt v Matt unless Matts outnumber people, then settled at once), no vote,
// forfeits, no-shows, host hand-off, watching, the champion; its courts are private, never count against ADDR_ROOMS, and ROOM_CAP stays hard.
// A restart ends it (tourend restart), nothing revived.   TOURNEY_PORT=<base> moves the eight servers (base .. +7; default 8614-8621).
import { spawn } from 'child_process';
import WebSocket from 'ws';
const PORT = +process.env.TOURNEY_PORT || 8614, P_CAP = PORT + 1, P_BOOT = PORT + 2, P_ADDR = PORT + 3, P_SLOW = PORT + 4, P_HARD = PORT + 5, P_GOLD = PORT + 6, P_DEF = PORT + 7, root = new URL('..', import.meta.url).pathname;
const env = { AUTOBOT: '1', SWING_SERVE: '0', READY_S: '0', WIN_BY: '1', TOUR_WIN: '1', TOUR_FINAL: '1', TOUR_VS_S: '0.3', TOUR_ARRIVE_S: '1', TOUR_GAP_S: '0.3', TOUR_DONE_S: '2', HOLD_S: '1', TOUR_CAP: '20' };   // every match is one point; short clocks
const procs = new Map();
const up = (port, more) => new Promise(res => { const p = spawn('node', ['server/game.js'], { cwd: root, env: { ...process.env, PORT: port, ...env, ...more } }); procs.set(port, p);
  p.stdout.on('data', d => { if (/game server on port/.test(d)) res(p); }); p.stderr.on('data', d => process.stderr.write(d)); });
const killAll = () => procs.forEach(p => p.kill());
process.on('exit', killAll); process.on('unhandledRejection', e => { console.error(e); killAll(); process.exit(1); });
await Promise.all([up(PORT), up(P_CAP, { ROOM_CAP: '8', TOUR_CAP: '1', ROOM_TTL: '0.2' }), up(P_BOOT, { REVIVE_S: '3' }), up(P_ADDR, {}), up(P_SLOW, { CAL_S: '2', ROOM_TTL: '0.3', TOUR_ARRIVE_S: '2.5', TOUR_REG_S: '4' }), up(P_HARD, { ROOM_CAP: '8', TOUR_GAP_S: '1' }),
  up(P_GOLD, { WIN_BY: '2', TOUR_WIN: '7', TOUR_FINAL: '7', TOUR_GOLD: '2', CAL_S: '2', TOUR_ARRIVE_S: '2', SCALE: '3' }), up(P_DEF, { TOUR_WIN: '', TOUR_FINAL: '', WIN_BY: '' })]);   // P_GOLD: a golden point at 2 under a target of 7 (only the golden branch can end a match at 2), win by 2, 3x sim time. P_DEF: the default targets
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (f, ms = 5000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await f()) return true; await wait(20); } return !!(await f()); };
let fails = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
let seq = 0; const all = [], CIDS = [];
function client(q = '', port = PORT, cid = 'tCidX' + (++seq) + 'zq', headers) {      // cids are distinctive: no tour payload may carry one
  if (cid) CIDS.push(cid);
  const ws = new WebSocket(`ws://localhost:${port}/?lobby=1${cid ? '&cid=' + cid : ''}${q}`, headers ? { headers } : undefined), c = { ws, cid, log: [], raw: [], closed: false, ready: false };
  ws.on('message', raw => { const m = JSON.parse(raw);
    if (m.type === 'state') { if (c.ready) ws.send('{"type":"paddle","auto":true,"q":[0,0,0,1]}'); return; }   // ready: calibrated, a paddle every frame. Off by default: no serve, so a match only ends the way the test says (a forfeit)
    c.raw.push(String(raw)); c.log.push(m);
    if (m.type === 'lobby') c.lobby = m; if (m.type === 'room') { c.room = m; c.welcome = c.info = null; } if (m.type === 'closed') c.room = null; if (m.type === 'welcome') c.welcome = m; if (m.type === 'botinfo') c.info = m; if (m.type === 'joinfail') c.fail = m; if (m.type === 'tour') c.tour = m; });
  ws.on('close', () => { c.closed = true; }); ws.on('error', () => {});
  c.send = o => ws.send(typeof o === 'string' ? o : JSON.stringify(o)); c.got = (t, f) => c.log.filter(m => m.type === t && (!f || f(m))); c.last = t => c.got(t).pop();
  c.mark = () => { c.log.length = 0; c.fail = null; };
  c.bail = () => { c.send({ type: 'leave' }); c.room = null; };   // Q Q / Forfeit: back to the lobby
  all.push(c); return new Promise(r => ws.on('open', () => r(c)));
}
const lobbied = async (q, port, cid, headers) => { const c = await client(q, port, cid, headers); await until(() => c.lobby); return c; };
const status = async port => (await fetch(`http://localhost:${port}/status.json`)).json();
async function makeTour(port = PORT, name = 'Hana') { const h = await lobbied('', port); h.send({ type: 'tcreate', name }); await until(() => h.tour || h.fail); return h; }
async function joinTour(code, name, port = PORT, headers) { const c = await lobbied('', port, undefined, headers); c.send({ type: 'join', code, name }); await until(() => c.tour || c.fail); return c; }
async function field(n, port = PORT) {                        // a host and n - 1 who signed up, each warming up (or told the courts are full)
  const h = await makeTour(port, 'P1'), ps = [h]; for (let i = 2; i <= n; i++) ps.push(await joinTour(h.tour.code, 'P' + i, port));
  await until(() => h.tour.n === n, 3000); return ps; }
const inMatch = c => c.room && c.room.kind === 'match' && c.welcome && c.welcome.role === 'player';
const snapOf = c => c.tour;
const r1Of = c => c.tour.rounds[0];
const humanMatches = r => r.matches.filter(x => !x.a.bot && !x.b.bot);
const byId = (ps, id) => ps.find(p => p.tour && p.tour.you && p.tour.you.id === id);
async function startAndSeat(ps) {                             // host starts; everyone gets the VS card and then their match
  ps[0].send({ type: 'tstart' }); await until(() => ps[0].tour.phase === 'play');
  await until(() => ps.every(p => p.got('tmove').length), 3000); await until(() => ps.every(inMatch), 4000);
}
await wait(300);

console.log('create, sign up, the count');
const h = await makeTour(PORT, 'Hana<b>');
ok(h.tour && h.tour.phase === 'reg' && /^[A-HJ-NP-Z2-9]{4}$/.test(h.tour.code) && h.tour.n === 1 && h.tour.you.host === true && h.tour.you.id === 1 && h.tour.min === 4 && h.tour.max === 16, `tcreate: a snapshot, the host is member 1 (${JSON.stringify(h.tour && { ...h.tour, rounds: undefined })})`);
ok(!h.room && h.tour.players[0].name === 'Hanab' && h.tour.host === 'Hanab', 'the host is not seated (the code screen), their name is cleaned');
const code = h.tour.code; h.mark(); h.send({ type: 'tcreate' }); await until(() => h.tour && h.log.length);
ok(h.last('tour')?.code === code && (await status(PORT)).tours === 1, 'a second tcreate from a member shows the same one (a double press makes one)');
const look = await lobbied(); await until(() => look.lobby.tours.length);
ok(JSON.stringify(look.lobby.tours) === JSON.stringify([{ code, tour: true, host: 'Hanab', n: 1, max: 16 }]), `the lobby lists it with a tournament flag: ${JSON.stringify(look.lobby.tours)}`);
const j2 = await joinTour(code, 'Ivo');
ok(j2.tour && j2.tour.you.id === 2 && !j2.tour.you.host && await until(() => inMatch(j2) === false && j2.room && j2.room.kind === 'warm' && j2.room.tour === code && j2.welcome && j2.welcome.role === 'player'), `a joiner: tour, then a warm-up court (${JSON.stringify(j2.room)})`);
ok(await until(() => j2.info && j2.info.active && j2.info.level === 3), 'Matt sits down at once, at Tour');
ok(await until(() => h.tour.n === 2 && h.tour.players.map(p => p.name).join() === 'Hanab,Ivo') && await until(() => look.lobby.tours[0]?.n === 2), 'the host and the lobby see the count go up');
ok(await until(() => j2.tour.you.warm === 'on'), 'you.warm is on for the one warming up');
const warm = j2.room.code, str = await lobbied(); str.send({ type: 'join', code: warm }); await until(() => str.fail || str.welcome);
ok(str.fail && str.fail.reason === 'full' && str.fail.watch === true, `a stranger with the warm-up's code may not sit: full, watch (${JSON.stringify(str.fail)})`);
str.send({ type: 'watch', code: warm }); await until(() => str.welcome); str.send({ type: 'ask' }); await until(() => str.got('askstate').length);
ok(str.last('askstate')?.s === 'refused' && str.last('askstate').why === 'tour', 'asking for Matt\'s seat in a warm-up: refused tour');
j2.send({ type: 'pause', on: true }); ok(await until(() => j2.got('paused', m => m.on).length), 'a warm-up can pause (one human against Matt)'); j2.send({ type: 'pause', on: false });
j2.send({ type: 'tstart' }); await wait(300); ok(h.tour.phase === 'reg' && !j2.got('tourfail').length, 'tstart from someone who is not the host: nothing');
h.send({ type: 'tstart' }); await until(() => h.got('tourfail').length);
ok(h.last('tourfail')?.why === 'few' && h.tour.phase === 'reg', `tstart with 2: tourfail few (${JSON.stringify(h.last('tourfail'))})`);
const j3 = await joinTour(code, 'Jo'); h.mark(); h.send({ type: 'tstart' }); await until(() => h.got('tourfail').length);
ok(h.last('tourfail')?.why === 'few', 'with 3: still few');
h.send({ type: 'twarm' }); ok(await until(() => h.room && h.room.kind === 'warm' && h.info && h.info.level === 3), 'twarm: the host warms up with Matt too');

console.log('the host leaves in sign-up: the crown passes; the last one out ends it');
h.mark(); h.send({ type: 'tleave' }); await until(() => h.got('tourend').length);
ok(h.last('tourend')?.why === 'left', 'tleave answers tourend left');
ok(await until(() => j2.tour.you.host === true && j2.tour.host === 'Ivo' && j2.tour.n === 2), `the earliest-joined member still here is host now (${j2.tour.host})`);
ok(await until(() => h.got('lobby').length) && (await status(PORT)).courts === 2, 'and the leaver\'s warm-up went with them (back in the lobby)');
j3.send({ type: 'tleave' }); j2.send({ type: 'tleave' }); await until(() => j2.got('tourend').length && j3.got('tourend').length);
await until(() => !look.lobby.tours.length, 2500);
ok(!look.lobby.tours.length && (await status(PORT)).tours === 0, 'the last one out: it is gone from the list and the server');
str.mark(); str.send({ type: 'join', code }); await until(() => str.fail);
ok(str.fail?.reason === 'notfound', 'its code finds nothing');
[h, j2, j3, str, look].forEach(c => c.ws.close());

console.log('4 players: two matches, no Matt; a whole bracket to a champion by forfeits');
{ const ps = await field(4); const c0 = ps[0].tour.code;
  ps[1].mark(); await startAndSeat(ps);
  ok(ps[1].got('closed', m => m.reason === 'tourstart').length === 1, 'Start closes the warm-ups: closed tourstart');
  const r = r1Of(ps[0]);
  ok(r.name === 'Semifinal' && r.matches.length === 2 && humanMatches(r).length === 2 && r.target === 1, `round 1: Semifinal, 2 matches, nobody against Matt (${JSON.stringify(r.matches.map(x => [x.a.name, x.b.name]))})`);
  ok(ps[0].tour.rounds.length === 2 && ps[0].tour.rounds[1].name === 'Final' && ps[0].tour.rounds[1].matches[0].a.id === null, 'the rest of the bracket is drawn: Final, To be decided');
  const tm = ps[1].last('tmove');
  ok(tm && tm.name === 'Semifinal' && tm.of === 2 && tm.target === 1 && tm.at === 0.3 && typeof tm.vs.name === 'string' && tm.vs.bot === false && tm.round === 1, `tmove: ${JSON.stringify(tm)}`);
  ok(ps.every(p => p.room.tour === c0 && p.room.public === false), 'the matches are private courts tagged with the tournament');
  ok(ps.every(p => !p.info || !p.info.active), 'no Matt in a match between two people');
  ok(await until(() => ps.every(p => p.tour.rounds[0].matches.some(x => x.live && x.room))), 'the snapshot marks both matches live with their court (for twatch)');
  const [m1, m2] = r.matches, lose1 = byId(ps, m1.a.id), win1 = byId(ps, m1.b.id), lose2 = byId(ps, m2.b.id), win2 = byId(ps, m2.a.id);
  lose1.send({ type: 'pause', on: true }); ok(await until(() => lose1.got('paused', m => m.refused).length), 'pause is refused in a match');
  lose1.send({ type: 'bot' }); ok(await until(() => lose1.got('botinfo', m => m.reason === 'tournament').length), 'B is refused in a match');
  const tst = await lobbied(); tst.send({ type: 'join', code: lose1.room.code }); await until(() => tst.fail);
  ok(tst.fail?.reason === 'full' && tst.fail.watch === true, 'a stranger with a match\'s code: full, watch'); tst.ws.close();
  lose1.bail(); await until(() => win1.got('matchover').length);
  const mo = win1.last('matchover');
  ok(mo && mo.forfeit === true && mo.winner === 1 && mo.tour && mo.tour.round === 'Semifinal' && mo.tour.next === 'Final' && mo.tour.final === false && typeof mo.tour.gap === 'number', `leave = forfeit at once; matchover carries tour (${JSON.stringify(mo)})`);
  ok(!win1.got('rematch').length, 'no rematch vote');
  ok(await until(() => win1.got('closed', m => m.reason === 'round').length), 'after the gap: closed round');
  ok(await until(() => lose1.tour.you.out === true && lose1.tour.players.find(p => p.id === lose1.tour.you.id).out), 'the loser is out, and still hears the bracket');
  ok(await until(() => lose1.tour.rounds[0].matches[1].live) && (lose1.send({ type: 'twatch', room: lose1.tour.rounds[0].matches[1].room }), await until(() => lose1.welcome.role === 'spectator' && lose1.room.kind === 'match')), 'the eliminated may watch a live match (twatch)');
  lose1.send({ type: 'ask' }); ok(await until(() => lose1.got('askstate', m => m.s === 'refused' && m.why === 'tour').length), 'ask in a match: refused tour');
  ok(await until(() => ps[0].tour.rounds[0].matches[1].watchers === 1), 'the snapshot counts the watcher');
  win2.mark(); lose2.bail();
  ok(await until(() => lose1.got('closed', m => m.reason === 'round').length), 'the watched match ends: its watchers go back too (closed round)');
  ok(await until(() => win1.got('tmove', m => m.name === 'Final').length && win2.got('tmove', m => m.name === 'Final').length), 'the round is over: both winners get the Final\'s VS card');
  ok(await until(() => inMatch(win1) && inMatch(win2) && win1.room.code === win2.room.code), 'and sit down in the same court');
  ok(win1.last('tmove').final === true && win1.last('tmove').target === 1, 'the final has its own target (TOUR_FINAL)');
  win1.send({ type: 'tleave' }); await until(() => win1.got('tourend').length);
  ok(await until(() => win2.tour.phase === 'done' && win2.tour.champ), `a tleave mid-final: forfeit, the tournament is done (${win2.tour.phase} ${JSON.stringify(win2.tour.rounds.map(r => r.matches.map(x => [x.a.id, x.b.id, x.w, x.forfeit])))} win1 ${win1.tour.you.id}: ${win1.log.map(m => m.type + (m.reason || m.why || m.name || '')).join(' ')})`);
  const ch = win2.tour.champ;   // win2's view: the host may be the one who left
  ok(ch.name === win2.tour.players.find(p => p.id === win2.tour.you.id).name && ch.bot === false && ch.path.length === 2 && ch.path[0].round === 'Semifinal' && ch.path[1].round === 'Final' && ch.path[1].forfeit === true && ch.path.every(s => Array.isArray(s.score) && typeof s.vs === 'string'), `the champion with the road to the title: ${JSON.stringify(ch)}`);
  ok(lose2.tour.champ && lose2.tour.champ.id === ch.id, 'the eliminated see the champion too');
  ok(await until(() => win2.tour.rounds[1].matches[0].w != null && !win2.tour.next), 'the final has its winner, nothing next');
  ps.forEach(c => c.ws.close()); }

console.log('5 players: one Matt; every person forfeits to Matt; Matt v Matt settled at once; Matt is champion');
{ const ps = await field(5); ps[0].send({ type: 'tstart' }); await until(() => ps.every(p => p.got('tmove').length) && ps[0].tour.phase === 'play');   // nobody is ready: no point is played, and the one drawn against Matt forfeits (so round 2 is two people + two Matts)
  await until(() => ps.every(inMatch), 4000);
  const r = r1Of(ps[0]), mt = r.matches.filter(x => x.a.bot || x.b.bot);
  ok(r.matches.length === 3 && r.name === 'Round 1' && mt.length === 1 && !r.matches.some(x => x.a.bot && x.b.bot), `3 matches, exactly one against Matt (${JSON.stringify(r.matches.map(x => [x.a.name, x.b.name]))})`);
  const mp = byId(ps, mt[0].a.bot ? mt[0].b.id : mt[0].a.id);
  ok(await until(() => mp.info && mp.info.active && mp.info.level === 3), 'the one against Matt: Matt is seated at Tour');
  ok(mp.last('tmove').vs.bot === true && mp.last('tmove').vs.name === 'Matt', 'their VS card says Matt');
  const gone = new Set(), t0 = Date.now();                     // now every person forfeits every match they are in
  while (ps[0].tour.phase !== 'done' && Date.now() - t0 < 20000) { for (const p of ps) if (inMatch(p) && !gone.has(p.room.code + p.cid)) { gone.add(p.room.code + p.cid); p.bail(); } await wait(50); }
  ok(ps[0].tour.phase === 'done' && ps[0].tour.champ.bot === true && ps[0].tour.champ.name === 'Matt' && ps[0].tour.champ.id === null, `done: Matt is the champion (${JSON.stringify(ps[0].tour.champ)})`);
  const rs = ps[0].tour.rounds, mm = rs.flatMap(r => r.matches.filter(x => x.a.bot && x.b.bot).map(x => ({ r, x })));
  ok(rs.length === 3 && rs.map(r => r.name).join() === 'Round 1,Semifinal,Final', `three rounds (${rs.map(r => r.name)})`);
  ok(mm.length >= 1 && mm.every(({ r, x }) => { const bots = r.matches.reduce((n, o) => n + o.a.bot + o.b.bot, 0); return bots > r.matches.length && x.w && !x.room && !x.live && Math.max(...x.score) === 1; }), `Matt v Matt only where Matts outnumber people, settled at once, 'Matt advances' (${mm.length} such)`);
  ok(mm.length === 1 && mm[0].r.name === 'Final', 'the final was Matt v Matt');
  ps.forEach(c => c.ws.close()); }

console.log('6 players: no Matt in round 1, one added in round 2; 7 players: a quarterfinal with one Matt');
{ const ps = await field(6); await startAndSeat(ps);
  const r = r1Of(ps[0]); ok(r.matches.length === 3 && humanMatches(r).length === 3, '6: three matches between people');
  ok(ps[0].tour.rounds.map(x => x.name).join() === 'Round 1,Semifinal,Final', `6: the bracket's shape (${ps[0].tour.rounds.map(x => x.name)})`);
  for (const x of r.matches) byId(ps, x.b.id).send({ type: 'leave' });
  ok(await until(() => ps[0].tour.rounds[1]?.matches.every(x => x.a.name && x.b.name), 5000), '6: round 2 drawn');
  const r2 = ps[0].tour.rounds[1]; ok(r2.matches.filter(x => x.a.bot || x.b.bot).length === 1 && !r2.matches.some(x => x.a.bot && x.b.bot), `6: round 2 has 3 winners + one Matt (${JSON.stringify(r2.matches.map(x => [x.a.name, x.b.name]))})`);
  ps.forEach(c => c.ws.close());
  const qs = await field(7); await startAndSeat(qs);
  const q = r1Of(qs[0]); ok(q.name === 'Quarterfinal' && q.matches.length === 4 && q.matches.filter(x => x.a.bot || x.b.bot).length === 1, `7: a quarterfinal of 4, one against Matt (${q.name})`);
  const qm = q.matches.find(x => x.a.bot || x.b.bot), mp = byId(qs, qm.a.bot ? qm.b.id : qm.a.id); mp.ready = true;   // calibrated: Matt serves, a real point
  ok(await until(() => mp.got('matchover').length, 20000), 'a real point against Matt ends it (first to TOUR_WIN = 1)');
  const pm = mp.last('matchover'); ok(Math.max(...pm.score) === 1 && Math.min(...pm.score) === 0 && pm.forfeit === false && pm.tour.round === 'Quarterfinal', `a one-point match: ${JSON.stringify(pm)}`);
  qs.forEach(c => c.ws.close());
  ok(await until(async () => (await status(PORT)).tours === 0, 6000), 'everyone gone: every tournament ended (empty, or done and cleared)'); }

console.log('16 is the cap: the 17th is told tfull; a double Start starts once; the list shows sign-ups only; late joiners may watch');
{ const ps = await field(16); ok(ps.length === 16 && ps[0].tour.n === 16 && ps.slice(1).every(p => p.tour && !p.fail), '16 signed up');
  const lk = await lobbied(); ok(lk.lobby.tours.some(t => t.code === ps[0].tour.code && t.n === 16), 'listed while signing up');
  const x17 = await joinTour(ps[0].tour.code, 'P17'); ok(x17.fail?.reason === 'tfull' && x17.fail.watch === true && !x17.tour, `the 17th: joinfail tfull (${JSON.stringify(x17.fail)})`);
  ps[0].send({ type: 'tstart' }); ps[0].send({ type: 'tstart' }); await until(() => ps.every(p => p.got('tmove').length) && ps[0].tour.phase === 'play');
  await wait(400); ok(ps.every(p => p.got('tmove').length === 1), 'a double tstart: one start, one VS card each');
  ok(ps[0].tour.rounds.map(r => r.name + ':' + r.matches.length).join() === 'Round 1:8,Quarterfinal:4,Semifinal:2,Final:1', `16: ${ps[0].tour.rounds.map(r => r.name + ':' + r.matches.length)}`);
  ok(await until(() => !lk.lobby.tours.some(t => t.code === ps[0].tour.code)), 'once started it leaves the list');
  const late = await joinTour(ps[0].tour.code, 'Late'); ok(late.fail?.reason === 'started' && late.fail.watch === true, `a join after Start: joinfail started, watch (${JSON.stringify(late.fail)})`);
  late.send({ type: 'watch', code: ps[0].tour.code }); ok(await until(() => late.tour && late.tour.you.viewer === true && late.tour.you.id === null && late.tour.phase === 'play'), 'watch by the tournament\'s code: the bracket, as a viewer');
  const lm = late.tour.rounds[0].matches.find(x => x.live); late.send({ type: 'twatch', room: lm.room }); ok(await until(() => late.welcome && late.welcome.role === 'spectator' && late.room.tour === ps[0].tour.code), 'a viewer may twatch a live match');
  late.send({ type: 'tleave' }); ok(await until(() => late.got('tourend', m => m.why === 'left').length), 'a viewer\'s tleave: tourend left');
  ps.concat(lk, x17, late).forEach(c => c.ws.close()); await wait(300); }

console.log('a drop mid-match: held, then a forfeit; a seat retaken by cid; a no-show');
{ const ps = await field(4); await startAndSeat(ps);
  const [m1, m2] = r1Of(ps[0]).matches, a1 = byId(ps, m1.a.id), b1 = byId(ps, m1.b.id), a2 = byId(ps, m2.a.id), b2 = byId(ps, m2.b.id);
  await until(() => a1.welcome && b1.welcome);
  a1.ws.terminate(); ok(await until(() => b1.got('hold').length), 'a player drops: their seat is held (hold)');
  ok(await until(() => b1.got('matchover', m => m.forfeit && m.winner === 1).length, 4000), 'not back in HOLD_S: the other wins by forfeit');
  const back = await client(`&tour=${ps[0].tour.code}&room=${a2.room.code}&name=P`, PORT, a2.cid); a2.ws.terminate();
  ok(await until(() => back.welcome && back.welcome.role === 'player' && back.room.kind === 'match' && back.welcome.side === a2.welcome.side) && !b2.got('matchover').length, `a reload with &tour=: the member is back in their seat, no forfeit (${JSON.stringify(back.room)})`);
  ok(back.tour && back.tour.you.id === a2.tour.you.id, 'and is the same member');
  back.bail(); await until(() => b2.got('matchover').length);
  ok(await until(() => b1.got('tmove', m => m.name === 'Final').length && b2.got('tmove', m => m.name === 'Final').length), 'the final is drawn');
  b1.ws.terminate();                                           // gone before the final's seat: a no-show
  ok(await until(() => inMatch(b2) && b2.room.tour), 'the one still here sits down');
  await wait(600); ok(!b2.info || !b2.info.active, 'no Matt sits down while the other side is arriving');
  ok(await until(() => b2.got('matchover', m => m.forfeit && m.tour && m.tour.final).length, 5000), 'the no-show forfeits after TOUR_ARRIVE_S');
  ok(await until(() => b2.tour.phase === 'done' && b2.tour.champ.id === b2.tour.you.id), 'the one who came is champion');
  ps.concat(back).forEach(c => c.ws.close()); }

console.log('a reload the usual way: the old socket closes first, the seat is held, the member comes back to it');
{ const ps = await field(4); await startAndSeat(ps);
  const m = r1Of(ps[0]).matches[0], a = byId(ps, m.a.id), b = byId(ps, m.b.id), side = a.welcome.side; b.mark();
  a.ws.terminate(); ok(await until(() => b.got('hold').length), 'dropped: held');
  const back = await client(`&tour=${ps[0].tour.code}&room=${a.room.code}&name=P`, PORT, a.cid);
  ok(await until(() => back.welcome && b.got('holdoff').length), 'back within HOLD_S: holdoff to the opponent');
  ok(back.welcome.role === 'player' && back.welcome.side === side && back.room.kind === 'match' && back.tour.you.id === m.a.id, `the same seat and member (side ${back.welcome.side})`);
  await wait(1300); ok(!b.got('matchover').length && !back.got('matchover').length, 'no forfeit after HOLD_S has passed');
  ps.concat(back).forEach(c => c.ws.close()); }

console.log('the host leaves mid-bracket: forfeit, the crown passes');
{ const ps = await field(4); await startAndSeat(ps);
  const hostMatch = r1Of(ps[0]).matches.find(x => x.a.id === 1 || x.b.id === 1), opp = byId(ps, hostMatch.a.id === 1 ? hostMatch.b.id : hostMatch.a.id);
  ps[0].send({ type: 'tleave' }); ok(await until(() => ps[0].got('tourend', m => m.why === 'left').length), 'tleave: tourend left to the host only');
  ok(await until(() => opp.got('matchover', m => m.forfeit).length), 'their opponent is through by forfeit');
  ok(await until(() => ps[1].tour.host !== 'P1' && ps[1].tour.players.find(p => p.id === 1).left === true), `the crown passed (${ps[1].tour.host})`);
  await wait(300); ok(!ps.slice(1).some(p => p.got('tourend').length), 'nobody else hears tourend');
  ps.forEach(c => c.ws.close()); }

console.log('hostile and malformed');
{ const c = await lobbied('', PORT, null); c.send({ type: 'tcreate' }); await until(() => c.fail);
  ok(c.fail?.reason === 'nocid', 'tcreate with no cid: joinfail nocid');
  const d = await lobbied(); for (const m of [{ type: 'tstart' }, { type: 'tleave' }, { type: 'twarm' }, { type: 'twatch', room: 'ABCD' }, { type: 'join', code: ['x'] }, { type: 'join', code: { a: 1 } }, { type: 'join', code: 'Z'.repeat(3000) }, { type: 'watch', code: 7 }, { type: 'tcreate', name: { x: 1 } }, 'null', '[]', '{"type":"twatch","room":{"toString":1}}']) d.send(m);
  await until(() => d.tour, 1500);
  ok(d.tour && d.tour.n === 1 && !d.got('tourend').length, 'a lobby socket\'s t-messages before joining are ignored; junk codes do not throw; its tcreate still works');
  d.send({ type: 'twatch', room: 5 }); d.send({ type: 'twatch', room: '../x' }); d.send({ type: 'twatch' }); await until(() => d.got('joinfail').length >= 3);
  ok(d.got('joinfail', m => m.reason === 'notfound').length >= 3, 'twatch with a bad room: notfound');
  const other = await lobbied(); other.send({ type: 'create', public: true }); await until(() => other.room);
  d.mark(); d.send({ type: 'twatch', room: other.room.code }); await until(() => d.fail);
  ok(d.fail?.reason === 'notfound' && !d.room, 'twatch of an ordinary court: notfound (only this tournament\'s matches)');
  const e = await lobbied(); e.send({ type: 'tstart' }); e.send({ type: 'join', code: d.tour.code }); await until(() => e.tour); e.send({ type: 'tstart' }); await wait(300);
  ok(d.tour.phase === 'reg' && !e.got('tourfail').length, 'tstart from a member who is not the host: ignored');
  ok((await status(PORT)).courts >= 0, 'the server is still up'); [c, d, e, other].forEach(x => x.ws.close()); }

console.log('ROOM_CAP: warm-ups are best effort under ROOM_CAP - 4; tstart near the cap: busy');
{ const own = []; for (let i = 0; i < 3; i++) { const o = await lobbied('', P_CAP); o.send({ type: 'create', public: false }); await until(() => o.room); own.push(o); }
  const ps = [await makeTour(P_CAP, 'C1')]; for (let i = 2; i <= 6; i++) ps.push(await joinTour(ps[0].tour.code, 'C' + i, P_CAP));
  await until(() => ps.every(p => p.tour && p.tour.you.warm !== 'off' || p === ps[0]), 3000);
  ok(ps.slice(1).filter(p => p.tour.you.warm === 'on').length === 1 && ps.slice(2).every(p => p.tour.you.warm === 'full' && !p.room), `3 courts + 1 warm-up = ROOM_CAP - 4: the rest are told 'full' and stay in (${ps.map(p => p.tour.you.warm)})`);
  const t2 = await makeTour(P_CAP, 'Two'); ok(t2.fail?.reason === 'busy', 'TOUR_CAP 1: a second tournament is busy');
  for (let i = 0; i < 3; i++) { const o = await lobbied('', P_CAP); o.send({ type: 'create', public: false }); await until(() => o.room); own.push(o); }   // 6 courts + 1 warm-up = 7
  ps[0].send({ type: 'tstart' }); await until(() => ps[0].got('tourfail').length);
  ok(ps[0].last('tourfail')?.why === 'busy' && ps[0].tour.phase === 'reg', `6 players need 3 courts, only 2 of 8 are free after the warm-up goes: busy (${JSON.stringify(ps[0].last('tourfail'))})`);
  ok((await status(P_CAP)).courts <= 8, 'never over the cap');
  ok(ps[1].tour.you.warm === 'on' && ps[1].room?.kind === 'warm' && !ps[1].got('closed').length, 'a refused Start leaves the warm-ups alone');
  own.pop().ws.close(); own.pop().ws.close(); await until(async () => (await status(P_CAP)).courts <= 5); ps[0].mark(); ps[0].send({ type: 'tstart' });
  ok(await until(() => ps[0].tour.phase === 'play'), 'a court freed: Start goes through');
  ok(await until(() => ps.every(inMatch), 4000) && (await status(P_CAP)).courts <= 8, 'all three matches seated within the cap');
  ps.concat(own).forEach(c => c.ws.close()); }

console.log('ROOM_CAP stays hard between rounds: the next round\'s courts are kept');
{ const ps = await field(6, P_HARD); await startAndSeat(ps);
  const spam = []; let max = 0, stop = false;
  const watcher = (async () => { while (!stop) { max = Math.max(max, (await status(P_HARD)).courts); await wait(50); } })();
  for (const x of r1Of(ps[0]).matches) byId(ps, x.b.id).send({ type: 'leave' });
  const t0 = Date.now(); while (Date.now() - t0 < 1500) { const s = await lobbied('', P_HARD); s.send({ type: 'create', public: false }); await until(() => s.room || s.fail, 800); spam.push(s); }
  ok(await until(() => ps[0].tour.rounds[1]?.matches.every(x => x.room || x.w), 5000), 'round 2 got its courts even with people making courts in the gap');
  stop = true; await watcher;
  ok(max <= 8 && spam.some(s => s.fail?.reason === 'busy'), `courts never went over ROOM_CAP 8 (max ${max}); the spam was told busy`);
  ps.concat(spam).forEach(c => c.ws.close()); }

console.log('ADDR_ROOMS: six entrants behind one address all warm up, and that address can still make its own courts');
{ const ip = { 'fly-client-ip': '203.0.113.7' }, hh = await lobbied('', P_ADDR, undefined, ip); hh.send({ type: 'tcreate', name: 'A1' }); await until(() => hh.tour);
  const ps = [hh]; for (let i = 2; i <= 6; i++) ps.push(await joinTour(hh.tour.code, 'A' + i, P_ADDR, ip));
  ok(await until(() => ps.slice(1).every(p => p.room && p.room.kind === 'warm')), 'five warm-ups from one address (ADDR_ROOMS 4 does not count them)');
  const t2 = await lobbied('', P_ADDR, undefined, ip); t2.send({ type: 'tcreate' }); await until(() => t2.fail);
  ok(t2.fail?.reason === 'busy', 'one standing tournament per address');
  const mine = []; for (let i = 0; i < 4; i++) { const o = await lobbied('', P_ADDR, undefined, ip); o.send({ type: 'create', public: true }); await until(() => o.room || o.fail); mine.push(o); }
  ok(mine.every(o => o.room), 'the same address still makes its 4 ordinary courts');
  const five = await lobbied('', P_ADDR, undefined, ip); five.send({ type: 'create', public: true }); await until(() => five.room || five.fail);
  ok(five.fail?.reason === 'busy', 'and the 5th is busy, as before');
  ps[0].send({ type: 'tstart' }); ok(await until(() => ps.every(inMatch), 4000), 'its matches start too (private, by null)');
  ps.concat(mine, t2, five).forEach(c => c.ws.close()); }

console.log('the TTL sweep never closes a waiting match; a player who never gets ready forfeits; sign-up expires');
{ const ps = await field(4, P_SLOW);
  ps[0].send({ type: 'tstart' }); await until(() => ps.every(p => p.got('tmove').length) && ps[0].tour.phase === 'play');
  const m = r1Of(ps[0]).matches[0], gone = byId(ps, m.a.id), there = byId(ps, m.b.id); gone.ws.terminate(); there.ws.terminate();
  await wait(1500); const snap = ps.find(p => p !== gone && p !== there);
  ok(snap.tour.rounds[0].matches[0].live === true, 'a match nobody has sat in yet is still standing after ROOM_TTL');
  ok(await until(() => snap.tour.rounds[0].matches[0].w != null, 5000), 'the no-show settles it');
  ok(await until(() => snap.tour.rounds[0].matches[1].w != null, 6000) && snap.tour.rounds[0].matches[1].forfeit === true, 'the match whose players never got ready is settled by forfeit (CAL_S after both are seated; readyBy is the backstop)');
  ps.forEach(c => c.ws.close());
  const ex = await makeTour(P_SLOW, 'Exp'); ok(await until(() => ex.got('tourend', m => m.why === 'expired').length, 7000), 'nobody new for TOUR_REG_S: tourend expired'); ex.ws.close(); }

console.log('a full match whose seats sit unready before the first ball is settled after CAL_S, not held for ever; a lone seat is not');
{ const ps = await field(4, P_SLOW); ps[0].send({ type: 'tstart' }); await until(() => ps.every(p => p.got('tmove').length) && ps[0].tour.phase === 'play');
  const [m0, m1] = r1Of(ps[0]).matches, a = byId(ps, m0.a.id), b = byId(ps, m0.b.id), c = byId(ps, m1.a.id); byId(ps, m1.b.id).ws.terminate();      // m1: one side never arrives
  ok(await until(() => inMatch(a) && inMatch(b) && inMatch(c), 3000), 'seated, and nobody ever gets a paddle ready');
  const t0 = Date.now(); ok(await until(() => a.got('closed', m => m.reason === 'away').length + b.got('closed', m => m.reason === 'away').length === 1, 4000), `both seats unready before the first ball: one is out (closed away) after CAL_S (${Date.now() - t0} ms)`);
  ok(await until(() => ps[0].tour.rounds[0].matches[0].w != null) && ps[0].tour.rounds[0].matches[0].forfeit === true, 'and the bracket has its result (a forfeit)');
  ok(!c.got('closed', m => m.reason === 'away').length, 'the lone seat waiting for a no-show is never CAL_S-forfeited itself');
  ps.forEach(x => x.ws.close()); }

console.log('a viewer of a sign-up stays a viewer across a reconnect (&watch=1); a removed member without it signs up again');
{ const hv = await makeTour(PORT, 'Vic'), tc = hv.tour.code, v = await lobbied(); v.send({ type: 'watch', code: tc });
  ok(await until(() => v.tour && v.tour.you.viewer === true && v.tour.phase === 'reg'), 'watching the sign-up by its code');
  v.ws.terminate(); await wait(150); const vb = await client(`&tour=${tc}&watch=1&name=V`, PORT, v.cid);
  ok(await until(() => vb.tour, 3000) && vb.tour.you.viewer === true && vb.tour.n === 1 && !vb.room && !vb.got('joinfail').length, `back with &tour=&watch=1: still a viewer, not signed up, no warm-up (n ${vb.tour && vb.tour.n}, ${JSON.stringify(vb.log.map(m => m.type))})`);
  const nb = await client(`&tour=${tc}&name=N`, PORT); ok(await until(() => nb.tour && nb.tour.n === 2, 3000) && !nb.tour.you.viewer, 'with no &watch=1 a socket that is no member is signed up (a member dropped past HOLD_S)');
  [hv, vb, nb].forEach(x => x.ws.close()); await wait(200); }

console.log('a restart ends it: tourend restart, nothing revived');
{ const ps = await field(4, P_BOOT); const c0 = ps[0].tour.code, wr = ps[1].room.code;
  procs.get(P_BOOT).kill('SIGINT'); await until(() => ps.every(p => p.closed), 3000);
  ok(ps.some(p => p.got('restart').length), 'the restart notice goes out first');
  await up(P_BOOT, { REVIVE_S: '3' });
  const back = await client(`&tour=${c0}&room=${wr}&back=1&side=0&score=0-0&bot=3&name=P2`, P_BOOT, ps[1].cid), host = await client(`&tour=${c0}&name=P1`, P_BOOT, ps[0].cid);
  ok(await until(() => back.got('tourend').length && host.got('tourend').length), 'both are told');
  ok(back.last('tourend').why === 'restart' && host.last('tourend').why === 'restart' && !back.got('room').length && !back.welcome, `tourend restart, and a stray back=1 revives nothing (${JSON.stringify(back.log.map(m => m.type))})`);
  ok((await status(P_BOOT)).courts === 0 && (await status(P_BOOT)).tours === 0, 'no court, no tournament');
  await wait(3200); const late = await client(`&tour=${c0}`, P_BOOT); await until(() => late.got('tourend').length);
  ok(late.last('tourend')?.why === 'gone', 'after REVIVE_S: tourend gone');
  [back, host, late].forEach(c => c.ws.close()); }

console.log('a member on an ordinary court between rounds keeps that seat across a reconnect (&tour= and &room= of the ordinary court)');
{ const host = await makeTour(PORT, 'Olga'), tc = host.tour.code; host.send({ type: 'create', public: false, name: 'Olga' }); await until(() => host.room && host.welcome);
  const own = host.room.code; ok(!host.room.tour && own !== tc, `the host made an ordinary court ${own} while signing people up`);
  host.ws.close(); await wait(150); const again = await client(`&tour=${tc}&room=${own}&name=Olga`, PORT, host.cid);
  ok(await until(() => again.room && again.welcome, 3000) && again.room.code === own && again.welcome.role === 'player' && !again.room.tour && again.got('tour').length === 1 && again.last('tour').you.host === true, `back in ${again.room && again.room.code} as a player, still the tournament's host (tour snapshot ${again.got('tour').length})`);
  again.send({ type: 'tleave' }); again.bail(); again.ws.close(); }

console.log('a warm-up that closed under a wifi blip: a new warm-up, no "Court closed" (&room= of a court that is gone)');
{ const ps = await field(4); const c0 = ps[0].tour.code, a = ps[1], wr = a.room.code; a.ws.terminate();
  await wait(250); const back = await client(`&tour=${c0}&room=${wr}&name=P2`, PORT, a.cid);
  ok(await until(() => back.room && back.room.kind === 'warm' && back.welcome, 3000) && back.room.code !== wr && !back.got('joinfail').length && back.got('closed', m => m.reason === 'round').length === 1, `back: closed round (quiet), then a new warm-up ${back.room && back.room.code}, no joinfail (${JSON.stringify(back.log.map(m => m.type + (m.reason || '')))})`);
  ps.concat(back).forEach(c => c.ws.close()); }

console.log('a held seat never locks out the late opponent; your own match from the bracket is its seat, never its stands');
{ const ps = await field(4); const A = ps[0]; A.send({ type: 'tstart' }); await until(() => A.got('tmove').length);
  const B = ps.find(p => p !== A && p.tour.players.find(q => q.id === p.tour.you.id)?.name === A.last('tmove').vs.name); B.ws.terminate();   // B's socket is down at the seat tick
  ok(await until(() => inMatch(A), 3000), 'A sits down alone');
  const code = A.room.code, side = A.welcome.side; A.ws.terminate(); await wait(100);   // A drops: held
  const B2 = await client(`&tour=${A.tour.code}&name=${B.tour.players.find(q => q.id === B.tour.you.id).name}`, PORT, B.cid);
  ok(await until(() => inMatch(B2), 2000) && B2.room.code === code && B2.welcome.side === 1 - side, `B comes back while A's seat is held: B sits down in the drawn seat (${JSON.stringify(B2.room)} ${B2.log.map(m => m.type).join(' ')})`);
  const A2 = await client(`&tour=${A.tour.code}&room=${code}&name=P1`, PORT, A.cid);
  ok(await until(() => inMatch(A2), 2000) && A2.welcome.side === side, 'A takes the held seat back');
  await wait(1500); ok(!A2.got('matchover').length && !B2.got('matchover').length, 'both here: no no-show, no forfeit after TOUR_ARRIVE_S');
  const [o1, o2] = ps.filter(p => p !== A && p !== B), m = r1Of(o1).matches.find(x => x.a.id === o1.tour.you.id || x.b.id === o1.tour.you.id);
  ok(inMatch(o1) && inMatch(o2), 'the other match is seated'); o1.ws.terminate(); await wait(100);
  const w = await client('', PORT, o1.cid); await until(() => w.lobby); w.send({ type: 'watch', code: A.tour.code }); await until(() => w.tour);   // back by the tournament's code: its bracket, not yet its seat
  w.send({ type: 'twatch', room: m.room }); ok(await until(() => inMatch(w), 2000), `twatch of your own drawn match: seated as a player, never a spectator (${w.welcome && w.welcome.role})`);
  await wait(1200); ok(!o2.got('matchover').length, 'and no no-show');
  ps.concat(B2, A2, w).forEach(c => c.ws.close()); }

console.log('both finalists leave the tournament in the gap: never a champion who quit');
{ const ps = await field(4, P_HARD); await startAndSeat(ps);
  const [m1, m2] = r1Of(ps[0]).matches, l1 = byId(ps, m1.a.id), w1 = byId(ps, m1.b.id), l2 = byId(ps, m2.a.id), w2 = byId(ps, m2.b.id);
  l1.bail(); l2.bail(); await until(() => w1.got('matchover').length && w2.got('matchover').length);
  w1.send({ type: 'tleave' }); w2.send({ type: 'tleave' });
  ok(await until(() => l1.tour.phase === 'done', 5000) && l1.tour.champ.bot === true && l1.tour.champ.id === null, `the Final settles at once: Matt is the champion, not a member who left (${JSON.stringify(l1.tour.champ)})`);
  const fin = l1.tour.rounds.at(-1).matches[0]; ok(fin[fin.w].bot === true && fin.forfeit === true && l1.tour.champ.path.at(-1)?.round === 'Final', `the bracket agrees: Matt holds the Final's winning place (${JSON.stringify(fin)})`);
  ps.forEach(c => c.ws.close()); }

console.log('real scoring: first to TOUR_WIN, win by 2, a golden point at TOUR_GOLD; a stall against Matt forfeits after CAL_S; the default targets');
{ const d = await makeTour(P_DEF, 'Def'); ok(d.tour.win === 7 && d.tour.final === 11, `default: matches to 7, the final to 11 (${d.tour.win}/${d.tour.final})`); d.ws.close();
  const ps = await field(5, P_GOLD); await startAndSeat(ps);
  const mt = r1Of(ps[0]).matches.find(x => x.a.bot || x.b.bot), mp = byId(ps, mt.a.bot ? mt.b.id : mt.a.id); mp.ready = true;
  ok(await until(() => mp.got('point').length, 30000), 'a point against Matt');
  ok(!mp.last('point').final, `one point is not a match (${JSON.stringify(mp.last('point').score)})`);
  mp.ready = false; mp.send({ type: 'status', cal: true });      // calibrating again, and never back: the serve waits, but not for ever
  ok(await until(() => mp.got('closed', m => m.reason === 'away').length, 6000), 'calibrating for CAL_S mid-match against Matt: out of the court (closed away)');
  const mx = () => mp.tour.rounds[0].matches.find(x => x.a.bot || x.b.bot);
  ok(await until(() => mx().w != null) && mx().forfeit === true && mx()[mx().w].bot === true && mp.tour.you.out === true, `a forfeit to Matt, and the bracket moves on (${JSON.stringify(mx())})`);
  ps.forEach(c => c.ws.close());
  const qs = await field(5, P_GOLD); await startAndSeat(qs);
  const qt = r1Of(qs[0]).matches.find(x => x.a.bot || x.b.bot), qp = byId(qs, qt.a.bot ? qt.b.id : qt.a.id); qp.ready = true;
  ok(await until(() => qp.got('matchover').length, 90000), 'a whole match against Matt');
  const pts = qp.got('point'), rule = (a, b) => a >= 7 && a - b >= 2 || a >= 2, bad = pts.filter(m => { const w = m.winner, a = m.score[w], b = m.score[1 - w]; return !!m.final !== rule(a, b); }), mo = qp.last('matchover');
  ok(pts.length >= 2 && !bad.length && pts.at(-1).final && Math.max(...mo.score) === 2 && !mo.forfeit, `the golden point ends a match at TOUR_GOLD, far short of the target; every point's final follows the rule (${pts.map(m => m.score.join('-') + (m.final ? '!' : '')).join(' ')})`);
  qs.forEach(c => c.ws.close()); }

console.log('no cid in any tournament payload');
const leaks = all.flatMap(c => c.raw.filter(s => /"type":"(tour|tmove|tourend|tourfail|lobby)"/.test(s) && CIDS.some(id => s.includes(id))));
ok(!leaks.length && all.some(c => c.raw.some(s => s.includes('"type":"tour"'))), `checked every raw tour/tmove/tourend/tourfail/lobby message (${leaks.length} leaks${leaks.length ? ': ' + leaks[0].slice(0, 200) : ''})`);

console.log(fails ? `FAIL ${fails}` : 'PASS'); killAll(); process.exit(fails ? 1 : 0);
