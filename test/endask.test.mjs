// Asking to restart / to forfeit (NOTES 245): a seated player asks from the settings card ({type:'endask', what}), the other seat answers on the
// Ask to play card ({type:'answer', id, yes}). One request per court, END_S, silence is a no, a no or an expiry rests the asker END_COOL_S.
//  1. Before the first strike there is nothing to restart or concede: refused (notyet).
//  2. A no: the asker hears it and rests; asking again inside the rest is a wait.
//  3. A yes to restart: rematchon (restart), 0-0, nothing recorded, the new match is not under way until its first strike.
//  4. Silence: expired. Both asking the same thing at once is a yes: a forfeit, the asker the loser, both seats still there, a title's clock and a vote.
//  5. Different asks at once: the second is refused (busy). Away: refused. The other seat dropping ends the request (gone).
//  6. Against Matt: Restart at once (botinfo reset), Forfeit at once (matchover conceded, Matt the winner). Tournaments refuse (the rule is in endAsk).
//  ENDASK_PORT=<port> node test/endask.test.mjs
import { spawn } from 'child_process';
import WebSocket from 'ws';
const PORT = +process.env.ENDASK_PORT || 8660, root = new URL('..', import.meta.url).pathname;
const proc = spawn('node', ['server/game.js'], { cwd: root, env: { ...process.env, PORT, WIN_AT: '30', END_S: '3', END_COOL_S: '2', REMATCH_S: '6', STAMP_S: '1', HOLD_S: '3' }, stdio: ['ignore', 'pipe', 'inherit'] });
const slog = []; proc.stdout.on('data', d => slog.push(String(d)));
process.on('exit', () => proc.kill());
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (f, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (f()) return true; await wait(20); } return !!f(); };
let fails = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
setTimeout(() => { console.log('FAIL (timeout)'); proc.kill(); process.exit(1); }, 150000);
await wait(700);
let cidN = 0;
function client() {
  const ws = new WebSocket(`ws://localhost:${PORT}/?lobby=1&cid=ea${++cidN}`), c = { ws, log: [], side: null };
  ws.on('message', raw => { const m = JSON.parse(raw); if (m.type === 'state') { c.st = m; if (c.onState) c.onState(m); return; }
    c.log.push(m); if (m.type === 'room') c.room = m; if (m.type === 'welcome') c.side = m.side; if (m.type === 'lobby') c.lobby = true; });
  ws.on('error', () => {});
  c.send = o => ws.send(JSON.stringify(o)); c.got = (t, f) => c.log.filter(m => m.type === t && (!f || f(m))); c.last = t => c.got(t).pop(); c.n = t => c.got(t).length;
  c.mark = () => { c.log.length = 0; };
  return c;
}
function play(c) { let cool = 0; c.onState = m => {            // serves and hits what comes near (test/rooms.test.mjs)
  c.send({ type: 'paddle', auto: true, q: [0, 0, 0, 1] });
  const me = m.paddles[c.side], s = c.side === 0 ? 1 : -1; if (!me || Date.now() < cool) return;
  if (m.serving === c.side) { cool = Date.now() + 600; return c.send({ type: 'swing', power: 20, dir: 0.2, lob: 0 }); }
  if (m.live && Math.abs(m.p[0] - me.x) < 0.9 && Math.abs(m.p[1] - me.y) < 0.8 && -(m.p[2] - me.z) * s < 1.0 && -(m.p[2] - me.z) * s > -0.5 && m.v[2] * s > 0) { cool = Date.now() + 400; c.send({ type: 'swing', power: 18, dir: 0, lob: 0 }); }
}; }
const ask = (c, what) => c.send({ type: 'endask', what });
const struck = c => until(() => c.got('hit').length > 0, 15000);

const A = client(), B = client(); await until(() => A.lobby && B.lobby);
A.send({ type: 'create', public: false, name: 'Ann' }); await until(() => A.side != null);
B.send({ type: 'join', code: A.room.code, name: 'Ben' }); await until(() => B.side != null);
play(A); play(B);

console.log('1. before the first strike');
ask(A, 'restart'); await until(() => A.n('endstate'));
ok(A.last('endstate')?.s === 'refused' && A.last('endstate').why === 'notyet' && !B.n('askplay'), `refused, nothing to restart yet: ${JSON.stringify(A.last('endstate'))}`);

console.log('2. a no');
ok(await struck(A), 'a ball is struck'); A.mark(); B.mark();
ask(A, 'restart'); await until(() => B.n('askplay') && A.n('endstate'));
let card = B.last('askplay'), st = A.last('endstate');
ok(card && card.what === 'restart' && card.name === 'Ann' && card.left === 3 && Number.isInteger(card.id), `Ben's card: Ann wants to restart, 3 s: ${JSON.stringify(card)}`);
ok(st && st.s === 'sent' && st.what === 'restart' && st.left === 3, `Ann's row: sent, 3 s: ${JSON.stringify(st)}`);
ask(A, 'restart'); await wait(200); ok(A.last('endstate').s === 'sent' && B.n('askplay') === 1, 'asking twice: still the one request');
B.send({ type: 'answer', id: card.id, yes: false }); await until(() => A.last('endstate').s === 'no');
ok(A.last('endstate').s === 'no' && A.last('endstate').left === 2 && B.last('askoff')?.why === 'no', `a no: Ann hears it and rests 2 s, Ben's card goes (${JSON.stringify(A.last('endstate'))})`);
ask(A, 'forfeit'); await until(() => A.last('endstate').s === 'wait');
ok(A.last('endstate').s === 'wait' && A.last('endstate').left >= 1 && B.n('askplay') === 1, `asking again inside the rest: wait ${A.last('endstate').left} s, no card`);

console.log('3. a yes to restart');
await wait(2100); B.onState = () => B.send({ type: 'paddle', x: 3.6 * (B.side === 0 ? 1 : -1), y: 0.4, q: [0, 0, 0, 1] });      // Ben stands in the corner a moment: a point is scored
await until(() => A.st.score[0] + A.st.score[1] > 0, 20000); play(B); const before = A.st.score.join('-'); A.mark(); B.mark();
ask(B, 'restart'); await until(() => A.n('askplay')); card = A.last('askplay');
ok(card && card.name === 'Ben' && card.what === 'restart', `Ben asks this time: Ann's card (${JSON.stringify(card)})`);
A.send({ type: 'answer', id: card.id, yes: true }); await until(() => A.n('rematchon') && B.n('rematchon'));
ok(A.last('rematchon')?.restart === true && B.last('rematchon')?.restart === true, 'both: rematchon (restart)');
await until(() => A.st.score.join('-') === '0-0'); ok(before !== '0-0' && A.st.score.join('-') === '0-0', `the score was ${before}, now ${A.st.score.join('-')}`);
ok(B.last('endstate')?.s === 'yes' && A.last('askoff')?.why === 'yes' && !A.n('profile') && !B.n('profile') && !A.n('matchover'), 'Ben hears yes; no result, nothing recorded');
A.mark(); ask(A, 'forfeit'); await until(() => A.n('endstate')); ok(A.last('endstate').why === 'notyet', 'the new match is not under way before its first strike');

console.log('4. silence; then both ask to forfeit at once');
A.mark(); ok(await struck(A), 'struck again'); A.mark(); B.mark();
ask(A, 'forfeit'); await until(() => A.last('endstate')?.s === 'expired', 4500);
ok(A.last('endstate')?.s === 'expired' && B.last('askoff')?.why === 'expired', `no answer in 3 s: expired (${JSON.stringify(A.last('endstate'))})`);
await wait(2100); A.mark(); B.mark();
ask(A, 'forfeit'); await until(() => B.n('askplay')); ask(B, 'forfeit');
await until(() => A.n('matchover') && B.n('matchover'));
const mo = A.last('matchover');
ok(mo && mo.forfeit === true && mo.conceded === true && mo.winner === B.side, `both asked: Ann concedes, Ben wins, a forfeit conceded: ${JSON.stringify({ w: mo && mo.winner, f: mo && mo.forfeit, c: mo && mo.conceded })}`);
ok(mo.rematchBy === 6, `the vote's clock is a full one (the title has its STAMP_S): ${mo.rematchBy}`);
await wait(300); ok(!A.got('rematch').some(m => m.votes.includes(false)) && !A.n('closed'), 'no seat was forfeited away: both may vote');
ok(/side \d asked to forfeit/.test(slog.join('')) && /both seats agreed to forfeit/.test(slog.join('')), 'the log says who asked and that both agreed');
A.send({ type: 'rematch', yes: true }); B.send({ type: 'rematch', yes: true }); await until(() => A.n('rematchon') && B.n('rematchon'));
ok(A.n('rematchon') && !A.last('rematchon').restart, 'a rematch after a conceded match');

console.log('5. busy, away, gone');
A.mark(); ok(await struck(A), 'struck'); A.mark(); B.mark();
ask(A, 'restart'); await until(() => B.n('askplay')); ask(B, 'forfeit'); await until(() => B.n('endstate'));
ok(B.last('endstate').s === 'refused' && B.last('endstate').why === 'busy', `a different ask while one is out: busy (${JSON.stringify(B.last('endstate'))})`);
B.send({ type: 'answer', id: B.last('askplay').id, yes: false }); await until(() => A.last('endstate')?.s === 'no');
await wait(2100); B.mark(); A.mark();
B.send({ type: 'status', away: true }); await wait(150); ask(A, 'restart'); await until(() => A.n('endstate'));
ok(A.last('endstate').s === 'refused' && A.last('endstate').why === 'away' && !B.n('askplay'), `Ben away: refused (${JSON.stringify(A.last('endstate'))})`);
B.send({ type: 'status', away: false }); await wait(150); A.mark();
ask(A, 'restart'); await until(() => B.n('askplay')); B.onState = null; B.ws.terminate();
await until(() => A.last('endstate')?.s === 'gone'); ok(A.last('endstate')?.s === 'gone' && A.last('endstate').left === 0, `Ben dropped: gone, no rest charged (${JSON.stringify(A.last('endstate'))})`);
A.onState = null; A.ws.terminate();

console.log('6. against Matt');
const C = client(); await until(() => C.lobby); C.send({ type: 'create', public: false, name: 'Cat' }); await until(() => C.side != null);
C.send({ type: 'bot', level: 0 }); await until(() => C.last('botinfo')?.active); play(C);
ok(await struck(C), 'struck against Matt'); C.mark();
ask(C, 'restart'); await until(() => C.got('botinfo', m => m.reset).length);
ok(C.got('botinfo', m => m.reset === true).length === 1 && !C.n('askplay') && !C.n('endstate'), 'Restart: at once, like holding B (botinfo reset)');
C.mark(); ok(await struck(C), 'struck again'); C.mark();
ask(C, 'forfeit'); await until(() => C.n('matchover'));
const cm = C.last('matchover'); ok(cm && cm.conceded === true && cm.forfeit === true && cm.winner === 1 - C.side, `Forfeit: at once, Matt wins (${JSON.stringify({ w: cm && cm.winner, c: cm && cm.conceded })})`);
await until(() => C.n('rematch')); ok(C.last('rematch')?.votes[1 - C.side] === true && C.last('rematch').votes[C.side] === null, 'Matt wants another, Cat can vote');
C.onState = null; C.ws.terminate();

console.log(fails ? `ENDASK FAIL (${fails})` : 'ENDASK PASSED'); proc.kill(); process.exit(fails ? 1 : 0);
