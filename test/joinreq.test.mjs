// Asking to play (docs/SPECTATE.md Asking to play, docs/COURTS-TOURNEY.md 2.2-2.3): a spectator watching one human play Matt asks for Matt's seat.
// One request per court, it expires, the player accepts or declines, a cooldown from the END of each request, a join into an under-way Matt court
// becomes watch + ask, and none of it works where there is no Matt to replace.   JOINREQ_PORT=<base> moves the four servers (base .. +3).
import { spawn } from 'child_process';
import WebSocket from 'ws';
const PORT = +process.env.JOINREQ_PORT || 8610, PORT2 = PORT + 1, PORT3 = PORT + 2, PORT4 = PORT + 3, root = new URL('..', import.meta.url).pathname;
const env = { AUTOBOT: '1', SWING_SERVE: '0', READY_S: '0', ASK_S: '2', ASK_COOL_S: '1', ASK_GAP_S: '0.2', PROMO_S: '1.5', HOLD_S: '1' };   // short clocks; a ball goes out by itself so a match is under way within ~4 s
const up = (port, more) => spawn('node', ['server/game.js'], { cwd: root, env: { ...process.env, PORT: port, ...env, ...more }, stdio: 'ignore' });
const procs = [up(PORT, { WIN_AT: '0' }), up(PORT2, { WIN_AT: '1', REMATCH_S: '20', ASK_S: '8' }), up(PORT3, { WIN_AT: '0', ASK_GAP_S: '1', ASK_COOL_S: '6' }), up(PORT4, { WIN_AT: '0', SWING_SERVE: '1' })];   // the second: a match is one point (the result card, and a request still pending when it ends). The third: a gap between requests, and a cooldown, long enough to see. The fourth: the serve waits for a swing
process.on('exit', () => procs.forEach(p => p.kill()));
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (f, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { if (f()) return true; await wait(20); } return !!f(); };
let fails = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
let seq = 0;
function client(q = '', port = PORT, cid = 'c' + (++seq), headers) {      // cid null: a socket with no cid. headers: e.g. fly-client-ip, a real (non-loopback) address
  const ws = new WebSocket(`ws://localhost:${port}/?lobby=1${cid ? '&cid=' + cid : ''}${q}`, headers ? { headers } : undefined), c = { ws, cid, log: [], closed: false };
  ws.on('message', raw => { const m = JSON.parse(raw);
    if (m.type === 'state') { c.st = m; if (c.onState) c.onState(m); return; }
    c.log.push(m); if (m.type === 'lobby') c.lobby = m; if (m.type === 'room') c.room = m; if (m.type === 'welcome') c.welcome = m; if (m.type === 'botinfo') c.info = m; if (m.type === 'joinfail') c.fail = m; });
  ws.on('close', () => { c.closed = true; }); ws.on('error', () => {});
  c.send = o => ws.send(JSON.stringify(o)); c.got = (t, f) => c.log.filter(m => m.type === t && (!f || f(m))); c.last = t => c.got(t).pop();
  c.mark = () => { c.log.length = 0; };
  c.row = code => c.lobby && c.lobby.rooms.find(r => r.code === code);
  return new Promise(r => ws.on('open', () => r(c)));
}
const lobbied = async (q, port, cid, headers) => { const c = await client(q, port, cid, headers); await until(() => c.lobby); return c; };
const ready = c => { c.onState = () => c.send({ type: 'paddle', auto: true, q: [0, 0, 0, 1] }); };   // calibrated: sends a paddle every frame (and returns nothing)
async function host(name, port = PORT, isReady = true) {       // a public court, one human, Matt seated; isReady: a ball struck (the match is under way)
  const h = await lobbied('', port); if (isReady) ready(h);
  h.send({ type: 'create', public: true, name }); await until(() => h.welcome);
  await until(() => h.info && h.info.active, 5000);
  if (isReady) await until(() => h.got('launch').length, 5000);
  return h;
}
const askState = (c, s) => c.got('askstate', m => !s || m.s === s);
await wait(800);

console.log('quick play and joining before a strike');
const q1 = await lobbied(); q1.send({ type: 'quick', name: 'Q1' }); await until(() => q1.info && q1.info.active, 5000);
const q2 = await lobbied(); q2.send({ type: 'quick', name: 'Q2' }); await until(() => q2.welcome || q2.fail);
ok(q2.room && q2.room.code === q1.room.code && q2.welcome.role === 'player', `two quick plays are paired even though Matt sat down for the first (${q1.room?.code} / ${q2.room?.code})`);
q1.ws.close(); q2.ws.close();
const pre = await host('Pre', PORT, false);
const pj = await lobbied(); pj.send({ type: 'join', code: pre.room.code, name: 'Pj' }); await until(() => pj.welcome || pj.fail);
ok(pj.welcome && pj.welcome.role === 'player' && !pj.room.asked, 'a join before any ball is struck (Matt seated, 0-0) sits down directly');
ok(await until(() => pre.info && !pre.info.active) && JSON.stringify(pj.welcome.names) !== '["Pre","Matt"]', 'Matt is gone');
pre.ws.close(); pj.ws.close();

console.log('a join after a strike becomes a request');
const ann = await host('Ann');
const code = ann.room.code;
const look = await lobbied(); await until(() => look.row(code) && look.row(code).live, 3000);
const r0 = look.row(code);
ok(r0 && r0.open === false && r0.ask === true && r0.bot === true && JSON.stringify(r0.names) === '["Ann","Matt"]', `lobby row: open false, ask true, bot true, names: ${JSON.stringify(r0)}`);
ok(Array.isArray(look.lobby.tours) && look.lobby.tours.length === 0, 'lobby.tours is an empty list');
const qq = await lobbied(); qq.send({ type: 'quick', name: 'Qq' }); await until(() => qq.room);
ok(qq.room && qq.room.code !== code && qq.room.role === 'player', 'quick play never lands in an under-way Matt court (nor in its stands)'); qq.ws.close();
const ben = await lobbied(); ben.send({ type: 'join', code, name: 'Ben' }); await until(() => ben.room && askState(ben).length);
ok(ben.room && ben.room.asked === true && ben.room.role === 'spectator' && ben.welcome && ben.welcome.role === 'spectator', `join lands in the stands with room.asked: ${JSON.stringify(ben.room)}`);
ok(askState(ben)[0]?.s === 'sent' && askState(ben)[0].left === 2, `the requester hears askstate sent, left 2 (ASK_S): ${JSON.stringify(askState(ben)[0])}`);
await until(() => ann.last('askplay'));
const ap = ann.last('askplay');
ok(ap && Number.isInteger(ap.id) && ap.name === 'Ben' && ap.left === 2, `the player hears askplay {id, name, left}: ${JSON.stringify(ap)}`);

console.log('expiry, and the cooldown from the end');
await until(() => askState(ben, 'expired').length, 3000);
const ex = askState(ben, 'expired')[0];
ok(ex && ex.left === 1, `no answer in ASK_S: askstate expired with the cooldown left: ${JSON.stringify(ex)}`);
ok(await until(() => ann.last('askoff')?.why === 'expired'), 'the player\'s card is closed with askoff expired');
ben.mark(); ben.send({ type: 'ask' }); await until(() => askState(ben).length);
ok(askState(ben)[0]?.s === 'wait' && askState(ben)[0].left >= 1, `asking again at once: wait (the cooldown runs from the expiry): ${JSON.stringify(askState(ben)[0])}`);
ann.send({ type: 'answer', id: ap.id, yes: true }); await until(() => ann.got('askoff', m => m.why === 'late').length);
ok(ann.got('askoff', m => m.why === 'late').length === 1 && !ben.got('room', m => m.promoted).length, 'accepting after the expiry: askoff late, nobody promoted');

console.log('one pending request per court');
await wait(1300); ben.mark(); ann.mark(); ben.send({ type: 'ask' }); await until(() => askState(ben).length);
ok(askState(ben)[0]?.s === 'sent', `after the cooldown: sent again (${JSON.stringify(askState(ben)[0])})`);
const cat = await lobbied(); cat.send({ type: 'watch', code, name: 'Cat' }); await until(() => cat.welcome);
ok(!askState(cat).length && !cat.room.asked, 'watching (not joining) never asks');
cat.send({ type: 'ask' }); await until(() => askState(cat).length);
ok(askState(cat)[0]?.s === 'wait' && askState(cat)[0].busy === true, `a second spectator while one request is pending: wait, busy: ${JSON.stringify(askState(cat)[0])}`);
await until(() => ann.last('askplay'));
ok(ann.got('askplay').length === 1, 'the player gets one card, not two');

console.log('decline');
const id1 = ann.last('askplay').id;
ann.send({ type: 'answer', id: id1, yes: 'true' }); ann.send({ type: 'answer', id: String(id1), yes: false }); await wait(250);
ok(!askState(ben, 'no').length && !ann.got('askoff').length, 'yes:"true" and a string id are dropped unread');
cat.send({ type: 'answer', id: id1, yes: true }); await wait(250);
ok(!ben.got('room', m => m.promoted).length && !cat.got('room', m => m.promoted).length, 'an answer from a spectator is never heard');
ann.send({ type: 'answer', id: id1, yes: false }); await until(() => askState(ben, 'no').length);
ok(askState(ben, 'no')[0]?.left === 1, `declined: askstate no with the cooldown: ${JSON.stringify(askState(ben, 'no')[0])}`);
ok(await until(() => ann.last('askoff')?.why === 'no'), 'the card closes with askoff no');
ben.mark(); ben.send({ type: 'ask' }); await until(() => askState(ben).length);
ok(askState(ben)[0]?.s === 'wait', 'asking again at once after a no: wait');

console.log('the cooldown survives a reload');
const benCid = ben.cid; ben.ws.close(); await wait(200);
const ben2 = await lobbied('', PORT, benCid); ben2.send({ type: 'watch', code, name: 'Ben' }); await until(() => ben2.welcome && askState(ben2).length);
ok(askState(ben2)[0]?.s === 'wait' && askState(ben2)[0].left >= 1, `same cid, new socket: askstate wait at once: ${JSON.stringify(askState(ben2)[0])}`);

console.log('accept');
await wait(1300); ann.mark(); ben2.mark(); ben2.send({ type: 'ask' }); await until(() => ann.last('askplay'));
const id2 = ann.last('askplay').id;
ok(id2 > id1, `ids count up per court (${id1} -> ${id2})`);
ann.send({ type: 'answer', id: 999, yes: true }); await until(() => ann.got('askoff', m => m.id === 999).length);
ok(ann.got('askoff', m => m.id === 999)[0]?.why === 'late' && !ben2.got('room', m => m.promoted).length, 'a wrong id: askoff late, nothing happens');
ann.send({ type: 'answer', id: id2, yes: true }); ann.send({ type: 'answer', id: id2, yes: true });
await until(() => ben2.got('welcome').length && ann.got('askoff').length >= 3);
ok(askState(ben2, 'yes').length === 1 && ben2.got('room', m => m.promoted && m.role === 'player').length === 1, 'the requester hears askstate yes, then room promoted (once)');
ok(ben2.last('welcome')?.role === 'player' && JSON.stringify(ben2.last('welcome').names) === (ben2.last('welcome').side === 1 ? '["Ann","Ben"]' : '["Ben","Ann"]'), `welcome as a player in Matt's seat: ${JSON.stringify(ben2.last('welcome'))}`);
ok(ann.got('askoff', m => m.why === 'yes').length === 1 && ann.got('askoff', m => m.id === id2 && m.why === 'late').length === 1, 'the player: askoff yes, and the double press askoff late');
ok(await until(() => ann.info && !ann.info.active) && ann.got('names').some(m => m.names.includes('Ben')), 'Matt is gone and the names say Ben');
ok(await until(() => { const r = look.row(code); return r && r.players === 2 && !r.open && !r.ask && !r.bot && r.score.join() === '0,0'; }, 3000), `the lobby row turns full at 0-0: ${JSON.stringify(look.row(code))}`);
cat.mark(); cat.send({ type: 'ask' }); await until(() => askState(cat).length);
ok(askState(cat)[0]?.s === 'refused' && askState(cat)[0].why === 'humans', `asking in a two-human court: refused humans: ${JSON.stringify(askState(cat)[0])}`);
const dan = await lobbied(); dan.send({ type: 'join', code, name: 'Dan' }); await until(() => dan.fail);
ok(dan.fail && dan.fail.reason === 'full' && dan.fail.watch === true && !askState(dan).length, 'joining a two-human court: joinfail full (watch instead), no request');
ann.mark(); ann.send({ type: 'ask' }); await wait(250);
ok(!askState(ann).length && !ann.got('askplay').length, 'a player sending ask is never heard');
[ann, ben2, cat, dan, look].forEach(c => c.ws.close());

console.log('promoted but never ready');
const eve = await host('Eve'); eve.send({ type: 'bot', level: 0 }); await until(() => eve.info && eve.info.name === 'Rookie');
const fay = await lobbied(); fay.send({ type: 'join', code: eve.room.code, name: 'Fay' }); await until(() => eve.last('askplay'));
eve.send({ type: 'pause', on: true }); await until(() => eve.got('paused', m => m.on).length);
eve.send({ type: 'answer', id: eve.last('askplay').id, yes: true }); await until(() => fay.got('room', m => m.promoted).length);
ok(fay.got('room', m => m.promoted).length === 1, 'an answer while paused (settings open) is heard: promoted');
ok(await until(() => fay.got('room', m => m.demoted).length, 4000), 'no paddle within PROMO_S: room demoted');
ok(await until(() => fay.last('welcome')?.role === 'spectator', 1000), 'and a spectator welcome');
ok(await until(() => eve.last('promoff')?.name === 'Fay') && await until(() => eve.info.active && eve.info.name === 'Rookie'), `the player: promoff Fay, Matt back at the old level (${eve.info && eve.info.name})`);
fay.mark(); fay.send({ type: 'ask' }); await until(() => askState(fay).length);
ok(askState(fay)[0]?.s === 'wait' && askState(fay)[0].left >= 1, `demoted: the cooldown runs from the demotion, asking at once is wait: ${JSON.stringify(askState(fay)[0])}`);
fay.ws.close();

console.log('after a demote, before the next strike, Matt\'s seat still needs the player\'s OK');      // SWING_SERVE on: the player serves first and nothing is struck for ~9 s, the window a demote leaves open
{ const hy = await lobbied('', PORT4); ready(hy); hy.send({ type: 'create', public: true, name: 'Hy' }); await until(() => hy.welcome); await until(() => hy.got('launch').length, 14000);
  const hc = hy.room.code, fi = await lobbied('', PORT4); fi.send({ type: 'join', code: hc, name: 'Fi' }); await until(() => hy.last('askplay'));
  hy.send({ type: 'answer', id: hy.last('askplay').id, yes: true }); await until(() => fi.got('room', m => m.demoted).length, 5000); hy.mark(); await until(() => hy.info && hy.info.active);
  const row = await lobbied('', PORT4); ok(await until(() => { const r = row.row(hc); return r && !r.open && r.ask; }, 2000) && !hy.got('launch').length, `demoted, nothing struck yet: the court lists as Ask to play, not open (${JSON.stringify(row.row(hc))})`);
  fi.mark(); fi.send({ type: 'leave' }); await until(() => fi.last('lobby'), 1000); fi.send({ type: 'join', code: hc, name: 'Fi' }); await until(() => fi.last('welcome') || fi.fail, 2000); await wait(200);
  ok(fi.last('welcome')?.role === 'spectator' && !fi.got('welcome', m => m.role === 'player').length && hy.info.active, `the demoted one presses Back, then Join: watching, never in Matt's seat (${fi.log.map(m => m.type + (m.role ? ':' + m.role : '')).join(',')})`);
  const gi = await lobbied('', PORT4); gi.send({ type: 'join', code: hc, name: 'Gi' }); await until(() => gi.welcome || gi.fail, 2000);
  ok(gi.welcome?.role === 'spectator' && gi.room?.asked && hy.info.active && !hy.got('launch').length, `any other joiner in that gap: watch + ask, Matt stays (${JSON.stringify(gi.room)})`);
  [hy, fi, gi, row].forEach(c => c.ws.close()); }

console.log('the one who said yes leaves before the new player is ready');
const uli = await host('Uli'); const vi = await lobbied(); vi.send({ type: 'join', code: uli.room.code, name: 'Vi' }); await until(() => uli.last('askplay'));
uli.send({ type: 'answer', id: uli.last('askplay').id, yes: true }); await until(() => vi.got('room', m => m.promoted).length);
uli.send({ type: 'leave' }); await until(() => vi.info && vi.info.active, 5000);      // Matt comes back for Vi, who is still getting a paddle ready
await wait(2500);                                                                     // past PROMO_S (1.5 s)
ok(!vi.got('room', m => m.demoted).length && !vi.got('closed').length && vi.last('welcome')?.role === 'player', `Vi is the court's only human now: never sent to the stands (${vi.log.map(m => m.type).filter(t => t !== 'names').join(',')})`);
[uli, vi].forEach(c => c.ws.close());

console.log('cancel paths');
eve.mark(); await until(() => eve.got('launch').length, 5000);                  // the new match against Matt is under way again
const gus = await lobbied(); gus.send({ type: 'join', code: eve.room.code, name: 'Gus' }); await until(() => eve.got('askplay', m => m.name === 'Gus').length);
eve.mark(); gus.ws.close(); await until(() => eve.last('askoff'));
ok(eve.last('askoff')?.why === 'gone', 'the requester leaves: askoff gone');
const hal = await lobbied(); await wait(300); hal.send({ type: 'join', code: eve.room.code, name: 'Hal' }); await until(() => askState(hal, 'sent').length);
eve.send({ type: 'leave' }); await until(() => hal.got('closed').length);
ok(askState(hal, 'gone').length === 1 && hal.last('closed')?.reason === 'empty', `the player leaves: askstate gone, then closed empty (${hal.log.map(m => m.type).join(',')})`);
const ivy = await host('Ivy'), ivyCode = ivy.room.code;
const jo = await lobbied(); jo.send({ type: 'join', code: ivyCode, name: 'Jo' }); await until(() => askState(jo, 'sent').length && ivy.last('askplay'));
ivy.ws.terminate(); await until(() => askState(jo, 'gone').length, 3000);
ok(askState(jo, 'gone').length === 1 && askState(jo, 'gone')[0].left === 0, `the player drops with people watching: the seat is held and the request ends, askstate gone, no cooldown charged: ${JSON.stringify(askState(jo, 'gone')[0])}`);
jo.ws.close();
const kim = await host('Kim'), kimCode = kim.room.code;
const lu = await lobbied(); lu.send({ type: 'join', code: kimCode, name: 'Lu' }); await until(() => kim.last('askplay'));
const kimCid = kim.cid;                                        // a reload whose old socket is still half-open: the new one takes the seat over
const kim2 = await client(`&room=${kimCode}&back=1`, PORT, kimCid); ready(kim2); await until(() => kim2.last('askplay'), 3000);
ok(kim2.welcome?.role === 'player' && kim2.last('askplay')?.name === 'Lu' && kim2.last('askplay').left <= 2, `the player reloads mid-request: seat retaken, the card comes back with the time left: ${JSON.stringify(kim2.last('askplay'))}`);
kim2.ws.close(); lu.ws.close();

console.log('where nobody may ask');
const mo = await host('Mo', PORT, false); await wait(100);
const two = await lobbied(); two.send({ type: 'join', code: mo.room.code, name: 'Two' }); await until(() => two.welcome);
const ned = await lobbied(); ned.send({ type: 'watch', code: mo.room.code }); await until(() => ned.welcome); ned.send({ type: 'ask' }); await until(() => askState(ned).length);
ok(askState(ned)[0]?.s === 'refused' && askState(ned)[0].why === 'humans', 'not a bot court (two humans): refused humans');
[mo, two, ned].forEach(c => c.ws.close());
const oz = await lobbied(); oz.send({ type: 'create', public: true, name: 'Oz' }); await until(() => oz.welcome);
const pat = await lobbied(); pat.send({ type: 'watch', code: oz.room.code }); await until(() => pat.welcome); pat.send({ type: 'ask' }); await until(() => askState(pat).length);
ok(askState(pat)[0]?.s === 'refused' && askState(pat)[0].why === 'nomatt', 'one human and no Matt yet: refused nomatt');
[oz, pat].forEach(c => c.ws.close());
const rae = await host('Rae', PORT2); await until(() => rae.got('matchover').length, 15000);
const sam = await lobbied('', PORT2); sam.send({ type: 'watch', code: rae.room.code }); await until(() => sam.welcome); sam.send({ type: 'ask' }); await until(() => askState(sam).length);
ok(rae.got('matchover').length && askState(sam)[0]?.s === 'refused' && askState(sam)[0].why === 'over', `on the result card: refused over (${JSON.stringify(askState(sam)[0])})`);
const tia = await lobbied('', PORT2); tia.send({ type: 'join', code: rae.room.code, name: 'Tia' }); await until(() => tia.welcome || tia.fail);
ok(tia.welcome?.role === 'player' && !tia.room.asked, 'a join on a bot court\'s result card sits down directly (the match is over)');
[rae, sam, tia].forEach(c => c.ws.close());

console.log('the match ends while a request is pending');
const una = await host('Una', PORT2); const val = await lobbied('', PORT2); val.send({ type: 'join', code: una.room.code, name: 'Val' });
await until(() => askState(val).length && una.last('askplay'));
ok(askState(val, 'sent').length === 1, `joined after the first strike: asked (${JSON.stringify(askState(val)[0])})`);
await until(() => una.got('matchover').length, 15000);
ok(await until(() => askState(val, 'gone').length && una.got('askoff', m => m.why === 'gone').length), `the point ends the match: the requester hears gone, the player askoff gone (${JSON.stringify(askState(val).map(m => m.s))})`);
[una, val].forEach(c => c.ws.close());

console.log('the cooldown also sits on the address (a new cid, or none, is no way round it)');
{ const ip = { 'fly-client-ip': '203.0.113.5' }, zed = await host('Zed', PORT3);
  const r1 = await lobbied('', PORT3, 'addr1', ip); r1.send({ type: 'watch', code: zed.room.code, name: 'R1' }); await until(() => r1.welcome);
  r1.send({ type: 'ask' }); await until(() => zed.last('askplay')); zed.send({ type: 'answer', id: zed.last('askplay').id, yes: false }); await until(() => askState(r1, 'no').length);
  const r2 = await lobbied('', PORT3, 'addr2', ip); r2.send({ type: 'watch', code: zed.room.code, name: 'R2' }); await until(() => r2.welcome); await wait(1100);      // past the court's 1 s gap: only the cooldown can stop it now
  r2.send({ type: 'ask' }); await until(() => askState(r2).length);
  ok(askState(r2)[0]?.s === 'wait' && !askState(r2)[0].busy && askState(r2)[0].left >= 1, `a new cid from the same address after a no: wait (${JSON.stringify(askState(r2)[0])})`);
  const r3 = await lobbied('', PORT3, null, ip); r3.send({ type: 'watch', code: zed.room.code, name: 'R3' }); await until(() => r3.welcome);
  r3.send({ type: 'ask' }); await until(() => askState(r3).length);
  ok(askState(r3)[0]?.s === 'wait' && !askState(r3)[0].busy, `no cid at all from that address: wait (${JSON.stringify(askState(r3)[0])})`);
  const r4 = await lobbied('', PORT3, null, { 'fly-client-ip': '203.0.113.9' }); r4.send({ type: 'watch', code: zed.room.code, name: 'R4' }); await until(() => r4.welcome);
  r4.send({ type: 'ask' }); await until(() => askState(r4).length);
  ok(askState(r4)[0]?.s === 'sent', `another address with no cid may ask: sent (${JSON.stringify(askState(r4)[0])})`);
  [zed, r1, r2, r3, r4].forEach(c => c.ws.close()); await wait(300); }

console.log('the court rests ASK_GAP_S between two requests');
const wes = await host('Wes', PORT3), xan = await lobbied('', PORT3), yul = await lobbied('', PORT3);
xan.send({ type: 'watch', code: wes.room.code, name: 'Xan' }); yul.send({ type: 'watch', code: wes.room.code, name: 'Yul' }); await until(() => xan.welcome && yul.welcome);
xan.send({ type: 'ask' }); await until(() => wes.last('askplay'));
wes.send({ type: 'answer', id: wes.last('askplay').id, yes: false }); await until(() => askState(xan, 'no').length);
yul.send({ type: 'ask' }); await until(() => askState(yul).length);
ok(askState(yul)[0]?.s === 'wait' && askState(yul)[0].busy === true && askState(yul)[0].left >= 1, `another spectator asking inside the gap: wait busy (${JSON.stringify(askState(yul)[0])})`);
await wait(1200); yul.mark(); yul.send({ type: 'ask' }); await until(() => askState(yul).length);
ok(askState(yul)[0]?.s === 'sent', `after the gap: sent, no cooldown was charged for the wait (${JSON.stringify(askState(yul)[0])})`);
[wes, xan, yul].forEach(c => c.ws.close());

console.log(fails ? `FAIL ${fails}` : 'PASS'); process.exit(fails ? 1 : 0);
