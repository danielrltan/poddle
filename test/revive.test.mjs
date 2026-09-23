// A restart must not end a match. The server forgets every court when its process is replaced (each deploy); tabs reconnect
// within a second and bring their court back: same code, same seats, same score. Also: the notice sent on SIGINT.
//   node test/revive.test.mjs        (REVIVE_PORT=<base> moves the ports)
import { spawn } from 'child_process'; import WebSocket from 'ws';
const P = +process.env.REVIVE_PORT || 9200, root = new URL('..', import.meta.url).pathname, sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
const up = (port, env = {}) => new Promise(res => { const p = spawn('node', ['server/game.js'], { cwd: root, env: { ...process.env, PORT: port, ...env } }); p.stdout.on('data', d => { if (/game server on port/.test(d)) res(p); }); p.stderr.on('data', d => process.stderr.write(d)); });
const tab = (port, q) => new Promise(res => { const ws = new WebSocket(`ws://localhost:${port}/?lobby=1&${q}`), c = { ws, all: [], st: null, got: t => c.all.filter(m => m.type === t) };
  ws.on('message', d => { const m = JSON.parse(d); if (m.type === 'state') c.st = m; else c.all.push(m); }); ws.on('open', () => res(c)); ws.on('error', () => res(c)); });
const until = async (f, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { if (f()) return true; await sleep(40); } return false; };

console.log('a fresh server, two tabs come back from a court it never knew');
let srv = await up(P);
const b = await tab(P, 'cid=bb&room=kq7m&back=1&side=1&score=5-3&pub=0&name=Ben');
ok(await until(() => b.got('welcome').length) && b.got('room')[0]?.code === 'KQ7M' && b.got('room')[0].role === 'player' && b.got('welcome')[0].side === 1, `the first one back rebuilds KQ7M and sits where it sat (side ${b.got('welcome')[0]?.side})`);
const a = await tab(P, 'cid=aa&room=KQ7M&back=1&side=0&score=5-3&pub=0&name=Ann');
ok(await until(() => a.got('welcome').length) && a.got('welcome')[0].side === 0 && !a.got('joinfail').length, 'the second finds the court standing and takes the other seat');
ok(await until(() => a.st && a.st.score.join() === '5,3' && b.st && b.st.score.join() === '5,3'), `the score came back with them (${a.st && a.st.score})`);
const namesOf = c => (c.all.filter(m => (m.type === 'names' || m.type === 'welcome') && Array.isArray(m.names)).at(-1) || {}).names || [];
ok(await until(() => namesOf(a).join() === 'Ann,Ben' && namesOf(b).join() === 'Ann,Ben'), `and the names, on both sides (${namesOf(a)} / ${namesOf(b)})`);
const w = await tab(P, 'cid=ww&room=KQ7M&back=1&watch=1&pub=0');
ok(await until(() => w.got('welcome').length) && w.got('room')[0]?.role === 'spectator', 'a spectator comes back as a spectator');

console.log('alone against Matt');
const m = await tab(P, 'cid=mm&room=M3PD&back=1&side=0&score=2-7&pub=0&name=Sue&bot=2');
ok(await until(() => m.got('botinfo').some(i => i.active && i.level === 2)) && await until(() => m.st && m.st.score.join() === '2,7'), `Matt is back at Pro and the score is ${m.st && m.st.score}`);
const x = await tab(P, 'cid=xx'); await until(() => x.got('lobby').length); x.ws.send(JSON.stringify({ type: 'join', code: 'M3PD', name: 'Xi' }));
ok(await until(() => x.got('room').length) && x.got('room')[0].role === 'spectator' && x.got('room')[0].asked === true && m.st.score.join() === '2,7', `a stranger joining while Sue recalibrates does not take Matt's seat: the match is under way, they watch and ask (${JSON.stringify(x.got('room')[0])}, ${m.st.score})`);
x.ws.close();

const t3 = await tab(P, 'cid=t3&room=T3UR&back=1&side=0&score=1-1&pub=0&name=Tia&bot=3');
ok(await until(() => t3.got('botinfo').some(i => i.active && i.level === 3 && i.name === 'Tour')), 'bot=3 brings Matt back as Tour (appended at index 3, so 0-2 keep their meaning)');

console.log('a spectator is first back');
const w2 = await tab(P, 'cid=w2&room=WXYZ&back=1&watch=1&pub=1'), p2 = await tab(P, 'cid=p2&room=WXYZ&back=1&side=1&score=1-0&pub=1&name=Pat');
ok(await until(() => w2.got('welcome').length && p2.got('welcome').length) && w2.got('room')[0].role === 'spectator' && p2.got('welcome')[0].side === 1, 'the court is rebuilt for the spectator, and the player who follows gets their own seat');

const w3 = await tab(P, 'cid=w3&room=QRST&back=1&watch=1&pub=1&score=3-5'); await until(() => w3.got('welcome').length);
const h3 = await tab(P, 'cid=h3&room=QRST&back=1&side=0&score=3-5&pub=1&name=Hal&bot=3');
ok(await until(() => h3.got('botinfo').some(i => i.active && i.level === 3)) && await until(() => h3.st && h3.st.score.join() === '3,5'), `a spectator rebuilt the court first: Hal gets Matt back as Tour at ${h3.st && h3.st.score}`);
const x3 = await tab(P, 'cid=x3'); await until(() => x3.got('lobby').length); x3.ws.send(JSON.stringify({ type: 'join', code: 'QRST', name: 'Xu' }));
ok(await until(() => x3.got('room').length) && x3.got('room')[0].asked === true && h3.st.score.join() === '3,5', `and that match is under way too: a stranger watches and asks (${JSON.stringify(x3.got('room')[0])})`);
[w3, h3, x3].forEach(c => c.ws.close());

console.log('what it will not do');
const n1 = await tab(P, 'cid=n1&room=QQQQ'), n2 = await tab(P, 'cid=n2&room=IIII&back=1&side=0'), n3 = await tab(P, 'cid=n3&room=R2D2&back=1&side=0&score=11-3&name=Fin');
ok(await until(() => n1.got('joinfail').length) && n1.got('joinfail')[0].reason === 'notfound', 'a code typed by hand (no back=1) that does not exist is still not found');
ok(await until(() => n2.got('joinfail').length) && n2.got('joinfail')[0].reason === 'notfound', 'a code outside the alphabet is refused');
ok(await until(() => n3.st) && n3.st.score.join() === '0,0', `a finished score is not brought back (${n3.st && n3.st.score})`);

console.log('the notice before a restart');
srv.kill('SIGINT'); const code = await new Promise(r => srv.on('exit', r));
ok(a.got('restart').length === 1 && w.got('restart').length === 1 && code === 0, `players and spectators are told, and the process exits cleanly (code ${code})`);

console.log('after the window closes');
srv = await up(P + 1, { REVIVE_S: '1' }); await sleep(1300);
const late = await tab(P + 1, 'cid=zz&room=KQ7M&back=1&side=0&score=5-3');
ok(await until(() => late.got('joinfail').length) && late.got('joinfail')[0].reason === 'notfound', 'a court nobody reclaimed in time is gone: not found');
srv.kill(); console.log(fails ? fails + ' FAILURES' : 'REVIVE TESTS PASSED'); process.exit(fails ? 1 : 0);
