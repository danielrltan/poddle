// ONE shared process. Authoritative ball + contact detection. Clients render and send input.
const { WebSocketServer } = require('ws');
const wss = new WebSocketServer({ port: +process.env.PORT || 8080 });

const COURT = { halfW: 3.05, halfL: 6.7, kitchen: 2.13, net: 0.91 };
const G = 9.81, R = 0.11;                 // gravity, ball radius
const HIT_LINE = 6.5;                     // where you stand by default (distance from net)
const X_LIMIT = 3.8, Y_MIN = 0.3, Y_MAX = 2.3;
const Z_NEAR = 2.6, Z_FAR = 7.0;          // footwork range (distance from net)
const AUTO_SPEED = 5.5;                   // sideways run speed in auto-move mode, m/s
const FOOT_SPEED = 7;                     // auto-footwork forward/back, m/s
const STANCE = 0.3;                       // stand this far behind the predicted contact: you meet the ball out in front
const SWING_WINDOW = 0.32;                // s a swing stays "live" waiting for the ball
const ZONE = { x: 1.15, y: 0.95, front: 1.6, behind: 0.9 };   // contact box around the paddle
const BOUNCE = { up: 0.7, along: 0.78 };
const REACH = 3.2;                        // no shot asks the receiver to get the paddle wider than this
const PASSED = 5.5;                       // a bounced ball this far beyond the baseline is gone
const SCALE = +process.env.TIMESCALE || 1;                     // tests only: run the sim faster than real time
const HEARTBEAT = +process.env.HEARTBEAT || 4000;              // ms between pings; a socket that misses one is dead (sleeping laptop, dropped wifi)

const sgn = side => (side === 0 ? 1 : -1);        // side 0 lives at +z, side 1 at -z
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const num = (v, d) => (Number.isFinite(+v) ? +v : d);          // untrusted input -> finite number

const players = [];                       // { ws|null(bot), side, x, y, z, zT, q, swing, lunge, contact }
const ball = { serving: null, serveBy: 0, p: [0, 1, 0], v: [0, 0, 0], live: false, lastHit: 0, bounces: 0 };
const score = [0, 0];
let now = 0, server = 0, serveAt = Infinity;      // sim clock; who serves next; when (sim time)

function send(pl, msg) { if (pl.ws && pl.ws.readyState === 1) pl.ws.send(JSON.stringify(msg)); }
function broadcast(msg) { const s = JSON.stringify(msg); for (const pl of players) if (pl.ws && pl.ws.readyState === 1) pl.ws.send(s); }
const bySide = side => players.find(p => p.side === side);

function newPlayer(ws, side) {
  return { ws, side, x: 0, y: 1.0, z: sgn(side) * HIT_LINE, zT: sgn(side) * HIT_LINE, q: [0, 0, 0, 1], swing: null, lunge: null, contact: null, react: 0, err: 0, bot: !ws };
}

// Ballistic solve: pick where the ball should land, find the velocity that gets it there
// and clears the net. Every shot is "in" by construction; the skill is reaching and timing it.
function solve(p, side, n, dir, lob) {
  const s = sgn(side);
  let tx = s * clamp(dir * 2.4, -2.5, 2.5);
  const tz = -s * (lerp(4.7, 3.4, n) + lob * 1.2);
  const px = p[0], py = Math.max(p[1], R), pz = s * Math.max(p[2] * s, 0.3);   // never launch from the far side of the net
  let T = lerp(1.15, 0.78, n) + lob * 0.55, v;
  for (let i = 0; i < 80; i++) {
    v = [(tx - px) / T, (R - py) / T + 0.5 * G * T, (tz - pz) / T];
    const tn = -pz / v[2];                                  // time the ball crosses the net plane (always > 0)
    const yn = py + v[1] * tn - 0.5 * G * tn * tn;
    if (yn >= COURT.net + 0.25) break;
    T += 0.05;
  }
  // wide balls keep drifting after the bounce; pull the target in so the top of the bounce stays within REACH
  const k = BOUNCE.along * BOUNCE.up * (G * T - v[1]) / G / T, xc = tx + (tx - px) * k;
  if (Math.abs(xc) > REACH) { tx = (Math.sign(xc) * REACH + px * k) / (1 + k); v[0] = (tx - px) / T; }
  return { v, land: [tx, tz], T };
}

function launch(side, n, dir, lob) {
  const sol = solve(ball.p, side, n, dir, lob);
  ball.p[1] = Math.max(ball.p[1], R);
  ball.v = sol.v; ball.lastHit = side; ball.bounces = 0;
  planFootwork(1 - side);
  broadcast({ type: 'launch', by: side, land: sol.land });
}

// Where should the receiver stand? Simulate ahead to the top of the first bounce on their side;
// if that is deeper than they can go (lobs), meet the ball on the rise at the back of their range.
function planFootwork(side) {
  const pl = bySide(side); if (!pl) return;
  const s = sgn(side);
  const p = [...ball.p], v = [...ball.v]; let bounced = false;
  pl.zT = s * HIT_LINE; pl.contact = null; pl.botSwung = false; pl.react = now + 0.3; pl.err = (Math.random() - 0.5) * 0.6;     // react/err: bot only
  for (let t = 0; t < 4; t += 1 / 120) {
    v[1] -= G / 120; for (let i = 0; i < 3; i++) p[i] += v[i] / 120;
    if (p[1] < R) { if (bounced) break; p[1] = R; v[1] *= -BOUNCE.up; v[0] *= BOUNCE.along; v[2] *= BOUNCE.along; bounced = true; }
    if (bounced && (v[1] <= 0 || p[2] * s >= Z_FAR - STANCE)) { pl.zT = s * clamp(p[2] * s + STANCE, Z_NEAR, Z_FAR); pl.contact = [p[0], p[1]]; break; }
  }
}

function reset(by) {
  const s = sgn(by), pl = bySide(by);
  for (const p of players) p.swing = p.lunge = null;
  ball.live = true; ball.bounces = 0;
  if (SWING_SERVE && pl) {                                     // the ball floats in front of the server until they swing at it
    ball.serving = by; ball.lastHit = 1 - by; ball.v = [0, 0, 0];
    ball.serveBy = now + (pl.bot ? 1.1 : 9);                   // bots serve after a beat; a human who never swings gets served for
    broadcast({ type: 'serve', by, wait: true });
    return;
  }
  ball.p = [(Math.random() - 0.5) * 2, 1.1, s * HIT_LINE];
  launch(by, 0.15, (Math.random() - 0.5) * 1.2, 0.25);
  broadcast({ type: 'serve', by });
}

// a fresh pair (human+human or human+bot): clean score, first serve
function startMatch(first) {
  score[0] = score[1] = 0; server = first; ball.live = false; serveAt = now + 0.8;
}

function point(winner, why) {
  score[winner]++; ball.live = false;
  const loser = bySide(1 - winner);
  if (loser && loser.swing && ball.lastHit === winner) send(loser, { type: 'whiff', why: whyMissed(loser.swing, inZone(loser)) });
  for (const pl of players) pl.swing = null;
  const final = WIN_AT > 0 && score[winner] >= WIN_AT && score[winner] - score[1 - winner] >= 2;
  broadcast({ type: 'point', winner, why, score, final });
  server = 1 - server; serveAt = now + 1.5;                    // serve alternates every point
  if (final) { broadcast({ type: 'match', winner, score: [...score] }); newMatchAt = now + 5; serveAt = Infinity; }
}

function inZone(pl) {
  const s = sgn(pl.side);
  const dx = ball.p[0] - pl.x, dy = ball.p[1] - pl.y, ahead = -(ball.p[2] - pl.z) * s;
  const depth = ahead > -ZONE.behind && ahead < ZONE.front;
  return { ok: depth && Math.abs(dx) < ZONE.x && Math.abs(dy) < ZONE.y, depth, dx, dy, ahead, s };
}
// reason = where the ball was relative to the paddle (player's own left/right) or the timing
const aside = z => (Math.abs(z.dx) >= ZONE.x ? (z.dx * z.s > 0 ? 'right' : 'left') : (z.dy > 0 ? 'high' : 'low'));
const whyMissed = (sw, z) => sw.why || (z.depth ? aside(z) : z.ahead >= ZONE.front ? 'early' : 'late');

// ---------- bot opponent ----------
// Joins by itself when a human is alone, leaves when a second human connects, comes back when they go.
// react: s before it starts moving. foot: m/s. err: how far it misjudges x (m). reach: how centred the ball must be
// before it swings. place: 0 = hits anywhere, 1 = always away from you. whiff: chance it simply mistimes a swing.
const BOTS = [
  { name: 'Rookie', react: 0.45, foot: 1.9, err: 0.9, reach: 0.55, power: [0.10, 0.40], place: 0.0, lob: 0.25, whiff: 0.18 },
  { name: 'Club',   react: 0.30, foot: 2.5, err: 0.5, reach: 0.70, power: [0.25, 0.65], place: 0.5, lob: 0.15, whiff: 0.07 },
  { name: 'Pro',    react: 0.18, foot: 4.2, err: 0.2, reach: 0.90, power: [0.45, 0.95], place: 0.9, lob: 0.10, whiff: 0.02 },
];
let botLevel = 1, botJoinAt = Infinity;
const AUTOBOT = process.env.AUTOBOT !== '0';
const SWING_SERVE = process.env.SWING_SERVE != null ? process.env.SWING_SERVE !== '0' : AUTOBOT;   // off in tests
const WIN_AT = process.env.WIN_AT != null ? +process.env.WIN_AT : (AUTOBOT ? 11 : 0);   // first to 11, win by 2 (off in tests)
let newMatchAt = Infinity;            // tests turn off auto-join and seat takeover
const humans = () => players.filter(p => !p.bot);
const theBot = () => players.find(p => p.bot);
const botInfo = () => ({ type: 'botinfo', active: !!theBot(), level: botLevel, name: BOTS[botLevel].name, levels: BOTS.map(b => b.name) });

function addBot() {
  if (theBot() || humans().length !== 1) return;
  players.push(newPlayer(null, 1 - humans()[0].side));
  console.log(`bot joined (${BOTS[botLevel].name})`);
  broadcast(botInfo());
  startMatch(humans()[0].side);
}
function removeBot() {
  const i = players.findIndex(p => p.bot);
  if (i >= 0) { players.splice(i, 1); ball.live = false; serveAt = Infinity; broadcast(botInfo()); }
}
// B key: alone -> join now; already playing the bot -> next difficulty; two humans -> say why not.
function botRequest(from, level) {
  if (humans().length > 1) return send(from, { type: 'botinfo', active: false, level: botLevel, name: BOTS[botLevel].name, reason: 'two players are connected' });
  if (Number.isInteger(level)) botLevel = clamp(level, 0, BOTS.length - 1);
  else if (theBot()) botLevel = (botLevel + 1) % BOTS.length;
  if (!theBot()) addBot(); else broadcast(botInfo());
}

// Auto-footwork for humans: run to where the ball will be, drift home between shots. Foot speed is finite,
// so a wide enough shot still beats you.
function runAuto(pl, dt) {
  const incoming = ball.live && ball.lastHit !== pl.side;
  const tgt = incoming ? (pl.contact || [ball.p[0], 1.0]) : [0, 1.0];
  const vx = incoming ? AUTO_SPEED : 2.5;
  if (pl.auto) pl.x = clamp(pl.x + clamp(tgt[0] - pl.x, -vx * dt, vx * dt), -X_LIMIT, X_LIMIT);
  pl.y += clamp(clamp(tgt[1], Y_MIN, Y_MAX) - pl.y, -4 * dt, 4 * dt);
}

function runBot(pl, dt) {
  const B = BOTS[botLevel], foe = humans()[0];
  // rubber band: ease off when well ahead, sharpen when well behind, so rallies stay alive in a demo
  const lead = score[pl.side] - score[1 - pl.side], band = clamp(1 - lead * 0.06, 0.7, 1.1);
  if (!ball.live || ball.lastHit === pl.side) { pl.x += (0 - pl.x) * 2 * dt; pl.y += (1.0 - pl.y) * 2 * dt; return; }
  if (now < pl.react + B.react - 0.3) return;                  // planFootwork sets react = now + 0.3
  const tgt = pl.contact || [ball.p[0], 1.0], foot = B.foot * band;
  pl.x = clamp(pl.x + clamp(tgt[0] + pl.err * B.err / 0.6 - pl.x, -foot * dt, foot * dt), -X_LIMIT, X_LIMIT);
  pl.y += clamp(clamp(tgt[1], Y_MIN, Y_MAX) - pl.y, -4 * dt, 4 * dt);
  const z = inZone(pl);
  if (!pl.swing && !pl.botSwung && z.ok && z.ahead < 0.7 && Math.abs(z.dx) < B.reach) {
    pl.botSwung = true;                                        // one decision per incoming ball
    broadcast({ type: 'swung', side: pl.side });
    if (Math.random() < B.whiff / band) return;                // mistimed it: the ball goes past
    const away = foe ? -Math.sign(foe.x || (Math.random() - 0.5)) * 2.1 : 0;           // world x, the side you are NOT on
    const tx = lerp((Math.random() - 0.5) * 4.2, away + (Math.random() - 0.5) * 0.8, B.place);
    const lob = Math.random() < B.lob ? 0.6 : 0;
    pl.swing = { until: now + 0.1, n: lerp(B.power[0], B.power[1], Math.random()) * (lob ? 0.5 : 1), dir: clamp(tx / (2.4 * sgn(pl.side)), -1, 1), lob, why: null, best: Infinity };
  }
}

wss.on('connection', ws => {
  ws.on('error', () => {});                                    // a bad frame must not take the process down
  ws.alive = true; ws.on('pong', () => { ws.alive = true; });
  ws.addr = ws._socket && ws._socket.remoteAddress;
  if (humans().length >= 2) {                                  // full: a reload / stale tab from the same machine takes over its old seat
    const ghost = AUTOBOT && humans().find(p => p.ws.addr === ws.addr);
    if (!ghost) { ws.send(JSON.stringify({ type: 'full' })); ws.close(); return; }
    players.splice(players.indexOf(ghost), 1); ghost.gone = true; ghost.ws.close();
  }
  if (humans().length >= 1) removeBot();                       // a second human replaces the bot
  botJoinAt = Infinity;
  const side = players.length && players[0].side === 0 ? 1 : 0;
  const me = newPlayer(ws, side);
  players.push(me);
  ws.send(JSON.stringify({ type: 'welcome', side, court: COURT }));
  console.log(`player joined as side ${side} (${players.length} connected)`);
  if (players.length === 2) startMatch(0); else if (AUTOBOT) botJoinAt = now + 2.5;       // alone: the bot shows up by itself
  ws.send(JSON.stringify(botInfo()));

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (m.type === 'paddle') {
      me.auto = !!m.auto;                                        // auto: the server runs you to the ball, you just swing
      me.autoY = !!m.autoY;
      me.ownZ = Number.isFinite(m.z) ? clamp(m.z, Z_NEAR, Z_FAR + 0.4) : null;   // camera depth: distance from the net, chosen by the player                                      // autoY: you move sideways yourself, the game handles paddle height
      if (!me.auto) me.x = clamp(num(m.x, me.x), -X_LIMIT, X_LIMIT);
      if (!me.auto && !me.autoY) me.y = clamp(num(m.y, me.y), Y_MIN, Y_MAX);
      if (Array.isArray(m.q) && m.q.length === 4 && m.q.every(Number.isFinite)) me.q = m.q;
    } else if (m.type === 'swing') {
      me.swing = { until: now + SWING_WINDOW, n: clamp((num(m.power, 9) - 9) / 26, 0, 1), dir: clamp(num(m.dir, 0), -1, 1), lob: clamp(num(m.lob, 0), 0, 1), why: null, best: Infinity };
      broadcast({ type: 'swung', side: me.side });
    } else if (m.type === 'bot') botRequest(me, m.level);
  });

  ws.on('close', () => {
    const i = players.indexOf(me); if (i < 0) return;
    players.splice(i, 1);
    removeBot(); ball.live = false; serveAt = Infinity;
    botJoinAt = AUTOBOT && humans().length === 1 ? now + 2.5 : Infinity;   // whoever is left gets the bot back
    console.log(`side ${side} left (${players.length} connected)`);
  });
});

const DT = 1 / 60;
function step() {
  now += DT;
  if (now >= botJoinAt) { botJoinAt = Infinity; addBot(); }
  if (now >= newMatchAt) { newMatchAt = Infinity; if (players.length === 2) startMatch(1 - server); }
  if (!ball.live && now >= serveAt) { serveAt = Infinity; if (players.length === 2) reset(server); }

  for (const pl of players) {
    if (pl.bot) runBot(pl, DT); else if (pl.auto || pl.autoY) runAuto(pl, DT);
    if (pl.lunge && now < pl.lunge.until) {                     // just hit: step into the ball so it leaves from the paddle
      pl.z += clamp(pl.lunge.z - pl.z, -3 * FOOT_SPEED * DT, 3 * FOOT_SPEED * DT);
      continue;
    }
    if (pl.ownZ != null && !pl.auto) { pl.z += clamp(sgn(pl.side) * pl.ownZ - pl.z, -FOOT_SPEED * DT, FOOT_SPEED * DT); continue; }   // you walk yourself
    const home = !ball.live || ball.lastHit === pl.side;
    const zT = home ? sgn(pl.side) * HIT_LINE : pl.zT;
    pl.z += clamp(zT - pl.z, -FOOT_SPEED * DT, FOOT_SPEED * DT);
  }

  if (ball.live && ball.serving != null) {
    const pl = bySide(ball.serving);
    if (!pl || ball.lastHit === ball.serving) ball.serving = null;            // it's been struck (or the server left)
    else {
      const s = sgn(pl.side);
      ball.p = [pl.x + 0.05 * s, clamp(pl.y + 0.1, 0.8, 1.5) + Math.sin(now * 3) * 0.04, pl.z - s * 0.55]; ball.v = [0, 0, 0];
      if (now >= ball.serveBy) {
        ball.serving = null; broadcast({ type: 'swung', side: pl.side }); broadcast({ type: 'hit', side: pl.side, n: 0.3, p: ball.p });
        launch(pl.side, pl.bot ? 0.2 + Math.random() * 0.3 : 0.25, (Math.random() - 0.5) * 1.4, 0.2);
      }
    }
  } else if (ball.live) {
    ball.v[1] -= G * DT;
    for (let i = 0; i < 3; i++) ball.p[i] += ball.v[i] * DT;
  }

  // contact: a live swing + the ball actually inside the box around that paddle.
  // The ball is NOT moved on contact (no teleport); the paddle lunges to it instead.
  for (const pl of players) {
    const sw = pl.swing; if (!sw) continue;
    const mine = ball.live && ball.lastHit !== pl.side;          // is this ball mine to hit?
    const z = inZone(pl);
    if (mine && z.ok) {
      pl.swing = null;
      pl.lunge = { z: ball.p[2] + sgn(pl.side) * 0.25, until: now + 0.12 };
      broadcast({ type: 'hit', side: pl.side, n: sw.n, p: ball.p });
      launch(pl.side, sw.n, sw.dir, sw.lob);
      continue;
    }
    // remember the near miss closest to the paddle plane, so the reason isn't always 'late' by the time the window ends
    if (mine && z.depth && Math.abs(z.ahead) < sw.best) { sw.best = Math.abs(z.ahead); sw.why = aside(z); }
    if (now > sw.until) {
      pl.swing = null;
      if (mine && ball.serving == null) send(pl, { type: 'whiff', why: whyMissed(sw, z) });
    }
  }

  if (ball.live && ball.p[1] < R) {
    ball.p[1] = R; ball.v[1] *= -BOUNCE.up; ball.v[0] *= BOUNCE.along; ball.v[2] *= BOUNCE.along; ball.bounces++;
    broadcast({ type: 'bounce', p: ball.p });
    const landSide = ball.p[2] > 0 ? 0 : 1;
    const inb = Math.abs(ball.p[0]) <= COURT.halfW + 0.1 && Math.abs(ball.p[2]) <= COURT.halfL + 0.1 && landSide !== ball.lastHit;
    if (ball.bounces === 1 && !inb) point(1 - ball.lastHit, 'out');
    else if (ball.bounces === 2) point(ball.lastHit, 'double bounce');
  }
  if (ball.live && (Math.abs(ball.p[2]) > COURT.halfL + PASSED || Math.abs(ball.p[0]) > COURT.halfW + PASSED))
    point(ball.bounces ? ball.lastHit : 1 - ball.lastHit, ball.bounces ? 'passed' : 'out');

  const paddles = [null, null];
  for (const pl of players) paddles[pl.side] = { x: pl.x, y: pl.y, z: pl.z, q: pl.q, bot: pl.bot };
  broadcast({ type: 'state', p: ball.p, v: ball.v, live: ball.live, serving: ball.serving, score, paddles });
}

// fixed 60Hz steps against the real clock (setInterval alone runs ~2% slow and drifts). One state packet per step.
let last = process.hrtime.bigint(), acc = 0;
setInterval(() => {
  const t = process.hrtime.bigint(); acc += Number(t - last) / 1e9 * SCALE; last = t;
  let k = 0;
  while (acc >= DT && k++ < 4) { acc -= DT; step(); }
  if (acc >= DT) acc = 0;                                       // stalled: drop the backlog rather than fast-forward
}, Math.max(1, Math.floor(4 / SCALE)));

// half-open sockets never fire 'close' and would hold a seat forever ("nobody can join"): ping them out
setInterval(() => {
  for (const ws of wss.clients) { if (!ws.alive) { ws.terminate(); continue; } ws.alive = false; ws.ping(); }
}, HEARTBEAT);

console.log('game server on port ' + (+process.env.PORT || 8080));
module.exports = { COURT, ZONE, BOUNCE, G, R, PASSED, solve };   // test/server.test.mjs sweeps solve() directly
