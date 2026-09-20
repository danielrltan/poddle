// ONE shared process. Authoritative ball + contact detection. Clients render and send input.
const { WebSocketServer } = require('ws');
const wss = new WebSocketServer({ port: +process.env.PORT || 8080 });

const COURT = { halfW: 3.05, halfL: 6.7, kitchen: 2.13, net: 0.91 };
const G = 9.81, R = 0.11;                 // gravity, ball radius
const HIT_LINE = 6.5;                     // where you stand by default (distance from net)
const X_LIMIT = 3.8, Y_MIN = 0.3, Y_MAX = 2.3;
const Z_NEAR = 2.6, Z_FAR = 8.4;          // footwork range (distance from net)
const AUTO_SPEED = 5.5;                   // sideways run speed in auto-move mode, m/s
const FOOT_SPEED = 7;                     // auto-footwork forward/back, m/s
const STANCE = 0.3;                       // stand this far behind the predicted contact: you meet the ball out in front
const SWING_WINDOW = 0.32;                // s a swing stays "live" waiting for the ball
const LAG_MAX = 0.3;                     // s a swing may be back-dated by its reported age
const FIX_WINDOW = 0.25;                  // s after a hit that a corrected power may still re-aim the ball
const FIX_EASE = 0.1;                     // s that re-aim is spread over: the ball bends onto the new path, it never kinks
const CONTACT = 0.25;                     // a stroke meets the ball this far in front of the paddle
const Z_ASSIST = 0.9;                      // share of the forward/back footwork the game does for a player who walks themselves
const BLOCK_ON = process.env.BLOCK !== '0';   // scripted tests with a parked paddle turn the net block off
const BLOCK = { within: 5.0, x: 0.95, y: 0.8, front: 1.2, behind: 0.3, volley: 5.2 };   // up at the net a paddle simply held in the ball's path taps it back
const REACH_X = 1.0, REACH_Y = 0.5;          // extra metres of reach for a full-effort swing
const ZONE = { x: 1.15, y: 0.95, front: 1.6, behind: 1.25 };   // contact box around the paddle
const BOUNCE = { up: 0.7, along: 0.78 };
// Slice = backspin (flat, open paddle face). It floats: lift takes a share of gravity off and the same depth takes longer.
// Then it bites: the first bounce stays low, loses most of its forward speed and kicks a little the way it was aimed.
const SLICE = { lift: 0.3, slow: 0.3, up: 0.55, along: 0.45, kick: 3.4, clear: 0.15 };   // kick: sideways m/s the bounce throws the ball — a spinning ball does not come off the floor straight
// Serve: the ball hangs in the air and only drifts after the server when they walk away from it.
const SERVE_AHEAD = 0.55;                 // it wants to sit this far in front of the paddle
const SERVE_DEAD = [0.4, 0.2, 0.35];      // x,y,z slack: move this far from it and it stays exactly where it is
const SERVE_SETTLE = 0.4;                 // once it follows, it keeps drifting until it is back within this share of the slack
const SERVE_FOLLOW = 3.5;                 // critically damped spring, rad/s: ~0.6 s to cover 63 % of a step, ~1.1 s for 90 %
const SERVE_ZONE = { x: 0.9, y: 0.9, front: 1.4, behind: 0.5 };   // a serve has to meet the ball: tighter than the rally box
const SERVE_POWER = 11;                   // swing power (rad/s scale: 6 = twitch/tap, 14+ = real stroke) needed to serve
const REACH = 3.2;                        // no shot asks the receiver to get the paddle wider than this
const PASSED = 5.5;                       // a bounced ball this far beyond the baseline is gone
const SCALE = +process.env.TIMESCALE || 1;                     // tests only: run the sim faster than real time
const HEARTBEAT = +process.env.HEARTBEAT || 4000;              // ms between pings; a socket that misses one is dead (sleeping laptop, dropped wifi)

const sgn = side => (side === 0 ? 1 : -1);        // side 0 lives at +z, side 1 at -z
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const num = (v, d) => (Number.isFinite(+v) ? +v : d);          // untrusted input -> finite number

const players = [];                       // { ws|null(bot), side, x, y, z, zT, q, swing, lunge, contact }
const ball = { spin: 0, kick: 0, aim: null, serving: null, serveBy: 0, hang: [0, 1, 0], hv: [0, 0, 0], drag: [false, false, false], p: [0, 1, 0], v: [0, 0, 0], live: false, lastHit: 0, bounces: 0 };
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
// how underhand was the swing? lob is the upward-scoop share of the stroke, 0..0.8 from the client
const underhand = lob => { const t = clamp((lob / 0.8 - 0.55) / 0.3, 0, 1); return t * t * (3 - 2 * t); };   // more than half the stroke must be going UP: a normal low-to-high swing is not a lob   // upward share of the stroke: 0.18 starts to count, 0.48 is fully underhand
// how sliced? slice = how flat / open the paddle face was through the swing, 0..1 from the client. A scoop is never a slice.
// spin is easy to put on: it starts at 0.25 and is full by 0.6. |slice| = how much, its sign = which way it breaks.
const sliced = (slice, lob) => { const t = clamp((Math.abs(slice || 0) - 0.3) / 0.4, 0, 1); return t * t * (3 - 2 * t) * (1 - 0.6 * underhand(lob)); };
const hard = n => { const t = clamp((n - 0.45) / 0.25, 0, 1); return t * t * (3 - 2 * t); };   // 0 below n 0.45, 1 from 0.7: power beats spin
const shotKind = (n, lob, slice) => (n > 0.62 && underhand(lob) <= 0.5 ? 'smash' : sliced(slice, lob) > 0.5 ? 'slice' : underhand(lob) > 0.5 ? (n < 0.2 ? 'dink' : 'lob') : n > 0.62 ? 'smash' : n < 0.1 ? 'tap' : 'drive');
const gOf = spin => G * (1 - SLICE.lift * spin);                // gravity a spinning ball feels until it first lands
// the bounce, in place on v. spin/kick only bite on the first one. Shared by the sim and by everything that predicts it.
function bounceV(v, spin, kick) {
  v[1] *= -lerp(BOUNCE.up, SLICE.up, spin); const al = lerp(BOUNCE.along, SLICE.along, spin);
  v[0] = v[0] * al + kick; v[2] *= al;
}

function solve(p, side, n, dir, lob, slice) {
  const s = sgn(side);
  let tx = s * clamp(dir * 2.4, -2.5, 2.5);
  // The stroke decides the shot, the way it does on a real court:
  //   level swing      -> a drive: more power = deeper and flatter
  //   underhand scoop  -> the ball goes UP, and much softer: a gentle one is a dink that drops in the kitchen,
  //                       a big one is a lob that floats high and lands deep
  const u = underhand(lob), nu = n < 0.2 ? n * 0.6 : lerp(0.45, 1, (n - 0.2) / 0.8);   // gentle = dink in the kitchen; anything more = a proper lob, deep and high                  // an underhand takes a lot of pace off
  const depth = lerp(lerp(2.6, 5.9, n), lerp(1.2, 6.0, nu), u);
  const tz = -s * Math.min(6.2, depth);
  const px = p[0], py = Math.max(p[1], R), pz = s * Math.max(p[2] * s, 0.3);   // never launch from the far side of the net
  let T = lerp(lerp(1.2, 0.58, Math.pow(n, 0.85)), lerp(1.2, 1.95, nu), u);   // underhands always travel on a high, slow arc
  const spin = sliced(slice, lob), g = gOf(spin), kick = s * ((slice || 0) < 0 ? -1 : (slice || 0) > 0 ? 1 : dir >= 0 ? 1 : -1) * (0.55 + 0.45 * Math.abs(dir)) * SLICE.kick * spin;   // always a real break, the way the paddle cut across it
  T *= 1 + SLICE.slow * spin;                                  // same depth (power still sets it), slower and floatier
  const v = [0, 0, 0]; T = fly(v, px, py, pz, tx, tz, T, g, lerp(0.25, SLICE.clear, spin));
  // wide balls keep drifting after the bounce; pull the target in so the top of the bounce stays within REACH
  const ta = lerp(BOUNCE.up, SLICE.up, spin) * (g * T - v[1]) / G, k = lerp(BOUNCE.along, SLICE.along, spin) * ta / T, xc = tx + (tx - px) * k + kick * ta;
  if (Math.abs(xc) > REACH) { tx = (Math.sign(xc) * REACH - kick * ta + px * k) / (1 + k); v[0] = (tx - px) / T; }
  return { v, land: [tx, tz], T, spin, kick };
}

// the velocity (into v) that lands on (tx, tz) T seconds from now; T grows until the ball clears the net. Returns T.
function fly(v, px, py, pz, tx, tz, T, g = G, clear = 0.25) {
  for (let i = 0; i < 80; i++) {
    v[0] = (tx - px) / T; v[1] = (R - py) / T + 0.5 * g * T; v[2] = (tz - pz) / T;
    if (pz * tz >= 0) break;                                // already over the net (a re-aim in flight)
    const tn = -pz / v[2];                                  // time the ball crosses the net plane (> 0)
    const yn = py + v[1] * tn - 0.5 * g * tn * tn;
    if (yn >= COURT.net + clear) break;
    T += 0.05;
  }
  return T;
}

function launch(side, n, dir, lob, hit, slice) {
  const sol = solve(ball.p, side, n, dir, lob, slice);
  ball.p[1] = Math.max(ball.p[1], R);
  ball.v = sol.v; ball.spin = sol.spin; ball.kick = sol.kick; ball.lastHit = side; ball.bounces = 0; ball.aim = null; hLen = 0;
  planFootwork(1 - side);
  if (hit) broadcast({ ...hit, p: ball.p, v: ball.v, spin: ball.spin });   // p + v: the hitter's screen bends the ball away on this very frame
  broadcast({ type: 'launch', by: side, land: sol.land, spin: sol.spin });
}

// A corrected power arrived just after the hit. Never swap the velocity: steer onto the new landing spot over FIX_EASE.
function reaim(side, n, dir, lob, slice) {
  const sol = solve(ball.p, side, n, dir, lob, slice);
  ball.aim = { land: sol.land, T: sol.T, k: Math.max(1, Math.round(FIX_EASE / DT)), side, clear: lerp(0.25, SLICE.clear, sol.spin) };
  ball.spin = sol.spin; ball.kick = sol.kick;
  planFootwork(1 - side, sol.v);
  broadcast({ type: 'launch', by: side, land: sol.land, spin: sol.spin });     // the landing marker moves now
}
const aimV = [0, 0, 0];
function easeAim() {
  const a = ball.aim;
  a.T = fly(aimV, ball.p[0], Math.max(ball.p[1], R), ball.p[2], a.land[0], a.land[1], Math.max(a.T, 0.1), gOf(ball.spin), a.clear);
  for (let i = 0; i < 3; i++) ball.v[i] += (aimV[i] - ball.v[i]) / a.k;   // equal shares: the last one lands exactly on the solution
  a.T -= DT;
  if (--a.k <= 0) { ball.aim = null; planFootwork(1 - a.side); }
}

// ---------- ball history: lets a swing that was reported late meet the ball where it WAS ----------
const HN = 24, HF = 10, hist = new Float64Array(HN * HF);   // per tick: t, ball xyz, paddle xyz of side 0, of side 1
let hHead = 0, hLen = 0;
function remember() {
  const o = hHead * HF; hist[o] = now; hist[o + 1] = ball.p[0]; hist[o + 2] = ball.p[1]; hist[o + 3] = ball.p[2];
  for (let sd = 0; sd < 2; sd++) { const pl = bySide(sd), q = o + 4 + sd * 3; hist[q] = pl ? pl.x : NaN; hist[q + 1] = pl ? pl.y : NaN; hist[q + 2] = pl ? pl.z : NaN; }
  hHead = (hHead + 1) % HN; if (hLen < HN) hLen++;
}

// Where should the receiver stand? Simulate ahead to the top of the first bounce on their side;
// if that is deeper than they can go (lobs), meet the ball on the rise at the back of their range.
function planFootwork(side, vel) {
  const pl = bySide(side); if (!pl) return;
  const s = sgn(side);
  const p = [...ball.p], v = [...(vel || ball.v)]; let bounced = false;
  pl.zT = s * HIT_LINE; pl.contact = null; pl.botSwung = false; pl.react = now + 0.3; pl.err = (Math.random() - 0.5) * 0.6;     // react/err: bot only
  for (let t = 0; t < 4; t += 1 / 120) {
    v[1] -= (bounced ? G : gOf(ball.spin)) / 120; for (let i = 0; i < 3; i++) p[i] += v[i] / 120;
    if (p[1] < R) { if (bounced) break; p[1] = R; bounceV(v, ball.spin, ball.kick); bounced = true; }
    if (bounced && (v[1] <= 0 || p[2] * s >= Z_FAR - STANCE)) { pl.zT = s * clamp(p[2] * s + STANCE, Z_NEAR, Z_FAR); pl.contact = [p[0], p[1]]; break; }
  }
}

function reset(by) {
  const s = sgn(by), pl = bySide(by);
  for (const p of players) p.swing = p.lunge = null;
  ball.live = true; ball.bounces = 0;
  if (SWING_SERVE && pl) {                                     // the ball floats in front of the server until they swing at it
    ball.serving = by; ball.lastHit = 1 - by;
    ball.hang = serveSpot(pl); ball.hv = [0, 0, 0]; ball.drag = [false, false, false]; hangBall(0);
    ball.serveBy = now + (pl.bot ? 1.1 : 9);                   // bots serve after a beat; a human who never swings gets served for
    broadcast({ type: 'serve', by, wait: true });
    return;
  }
  ball.p = [(Math.random() - 0.5) * 2, 1.1, s * HIT_LINE];
  launch(by, 0.15, (Math.random() - 0.5) * 1.2, 0.25);
  broadcast({ type: 'serve', by });
}

// ---------- serve: a ball that hangs, and follows late ----------
const serveSpot = pl => [pl.x + 0.05 * sgn(pl.side), clamp(pl.y + 0.1, 0.7, 1.8), pl.z - sgn(pl.side) * SERVE_AHEAD];
function hangBall(dt) {
  const pl = bySide(ball.serving), s = sgn(pl.side), want = serveSpot(pl), h = ball.hang, hv = ball.hv;
  for (let i = 0; i < 3; i++) {
    const off = Math.abs(want[i] - h[i]);
    if (off > SERVE_DEAD[i]) ball.drag[i] = true; else if (off < SERVE_DEAD[i] * SERVE_SETTLE) ball.drag[i] = false;
    const pull = ball.drag[i] ? want[i] - h[i] : 0;            // inside the slack nothing pulls it: it just coasts to a stop
    hv[i] += (SERVE_FOLLOW * SERVE_FOLLOW * pull - 2 * SERVE_FOLLOW * hv[i]) * dt;
    h[i] += hv[i] * dt;
  }
  const x = clamp(h[0], -X_LIMIT, X_LIMIT), z = s * clamp(h[2] * s, 1.0, Z_FAR);       // always on the server's own half
  if (x !== h[0]) { h[0] = x; hv[0] = 0; } if (z !== h[2]) { h[2] = z; hv[2] = 0; }
  const w = 3, bob = 0.04;                                     // p/v are what clients see: v is the real drift, so their extrapolation stays smooth
  ball.p = [h[0], h[1] + Math.sin(now * w) * bob, h[2]]; ball.v = [hv[0], hv[1] + Math.cos(now * w) * w * bob, hv[2]];
}
function serveReach(pl) {
  const s = sgn(pl.side), ahead = -(ball.p[2] - pl.z) * s;
  return Math.abs(ball.p[0] - pl.x) < SERVE_ZONE.x && Math.abs(ball.p[1] - pl.y) < SERVE_ZONE.y && ahead > -SERVE_ZONE.behind && ahead < SERVE_ZONE.front;
}
function strike(pl, sw) {
  // A ball taken out of the air up near the net with a short, soft stroke is a block: it just pops back over, soft and short.
  if (!sw.kind && ball.serving == null && ball.bounces === 0 && Math.abs(pl.z) <= BLOCK.volley && sw.n < 0.4 && underhand(sw.lob) < 0.5)
    sw = { ...sw, kind: 'block', n: Math.min(sw.n, 0.12), lob: 0.55 };
  pl.swing = null; pl.hit = sw.kind ? null : { at: now, n: sw.n, dir: sw.dir, lob: sw.lob, slice: sw.slice || 0 };   // a swing (not a block) may still be corrected
  pl.lunge = { z: pl.z + clamp(ball.p[2] + sgn(pl.side) * CONTACT - pl.z, -0.45, 0.45), until: now + 0.15 };   // a small step into the ball, never a jump
  launch(pl.side, sw.n, sw.dir, sw.lob, { type: 'hit', side: pl.side, n: sw.n, kind: sw.kind || shotKind(sw.n, sw.lob, sw.slice) }, sw.slice);
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
  // Reach: a big committed swing is a stretched arm. The sensor can't see the arm extend, but it can see the effort, so
  // the harder the swing, the further out to the side (and up) it connects. A poke reaches no further than before.
  const r = pl.swing && !pl.bot ? pl.swing.n : 0;
  return { ok: depth && Math.abs(dx) < ZONE.x + REACH_X * r && Math.abs(dy) < ZONE.y + REACH_Y * r, depth, dx, dy, ahead, s };
}

// Contact: a live swing + the ball inside the box around that paddle. Runs every tick AND the instant a swing arrives.
// A swing reaches us `age` after the hand moved, so the ball may already be past the paddle: it counts if the ball was
// in the box at any time since the swing began. Either way the ball is struck where it WAS when it was nearest the
// contact plane (looking back at most LAG_MAX): it never leaves from behind the player, and the client blends the
// drawn ball onto the new path.
function tryHit(pl) {
  const sw = pl.swing; if (!sw || !ball.live || ball.serving != null || ball.lastHit === pl.side) return false;
  const z = inZone(pl), s = z.s, r = pl.bot ? 0 : sw.n, q = 4 + pl.side * 3;
  let grant = z.ok, best = z.ok ? Math.abs(z.ahead - CONTACT) : Infinity, at = -1;
  if (!z.ok || z.ahead < CONTACT) for (let k = 1; k <= hLen; k++) {           // at or past the paddle: look back
    const o = ((hHead - k + HN) % HN) * HF; if (!(hist[o] > now - LAG_MAX - DT / 2)) break;
    const ahead = -(hist[o + 3] - hist[o + q + 2]) * s, d = Math.abs(ahead - CONTACT);
    if (!(ahead > -ZONE.behind && ahead < ZONE.front && Math.abs(hist[o + 1] - hist[o + q]) < ZONE.x + REACH_X * r && Math.abs(hist[o + 2] - hist[o + q + 1]) < ZONE.y + REACH_Y * r)) continue;
    if (hist[o] >= sw.from) grant = true;
    if (d < best) { best = d; at = o; }
  }
  if (!grant) return false;
  if (at >= 0) { ball.p[0] = hist[at + 1]; ball.p[1] = hist[at + 2]; ball.p[2] = hist[at + 3]; }
  strike(pl, sw); return true;
}
// reason = where the ball was relative to the paddle (player's own left/right) or the timing
const aside = z => (Math.abs(z.dx) >= ZONE.x ? (z.dx * z.s > 0 ? 'right' : 'left') : (z.dy > 0 ? 'high' : 'low'));
const whyMissed = (sw, z) => sw.why || (z.depth ? aside(z) : z.ahead >= ZONE.front ? 'early' : 'late');

// ---------- bot opponent ----------
// Joins by itself when a human is alone, leaves when a second human connects, comes back when they go.
// react: s before it starts moving. foot: m/s. err: how far it misjudges x (m). reach: how centred the ball must be
// before it swings. place: 0 = hits anywhere, 1 = always away from you. whiff: chance it simply mistimes a swing.
const BOTS = [
  { name: 'Rookie', react: 0.45, foot: 1.9, err: 0.9, reach: 0.55, power: [0.10, 0.40], place: 0.0, lob: 0.25, slice: 0, whiff: 0.18 },
  { name: 'Club',   react: 0.30, foot: 2.5, err: 0.5, reach: 0.70, power: [0.25, 0.65], place: 0.5, lob: 0.15, slice: 0.1, whiff: 0.07 },
  { name: 'Pro',    react: 0.18, foot: 4.2, err: 0.2, reach: 0.90, power: [0.45, 0.95], place: 0.9, lob: 0.10, slice: 0.18, whiff: 0.02 },
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
  const incoming = ball.live && ball.lastHit !== pl.side, serving = ball.live && ball.serving === pl.side;
  const tgt = serving ? [ball.hang[0], ball.hang[1] - 0.1] : incoming ? (pl.contact || [ball.p[0], 1.0]) : [0, 1.0];   // your serve: line up with the hanging ball
  const vx = incoming ? AUTO_SPEED : 2.5;
  if (pl.auto) pl.x = clamp(pl.x + clamp(tgt[0] - pl.x, -vx * dt, vx * dt), -X_LIMIT, X_LIMIT);
  pl.y += clamp(clamp(tgt[1], Y_MIN, Y_MAX) - pl.y, -4 * dt, 4 * dt);
}

function runBot(pl, dt) {
  const B = BOTS[botLevel], foe = humans()[0];
  // rubber band: ease off when well ahead, sharpen when well behind, so rallies stay alive in a demo
  const lead = score[pl.side] - score[1 - pl.side], band = clamp(1 - lead * 0.06, 0.7, 1.1);
  if (!ball.live || ball.lastHit === pl.side || ball.serving === pl.side) { pl.x += (0 - pl.x) * 2 * dt; pl.y += (1.0 - pl.y) * 2 * dt; return; }
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
    const lob = Math.random() < B.lob ? 0.6 : 0, slice = !lob && Math.random() < B.slice ? 0.9 : 0;   // now and then it slices one at you
    pl.swing = { until: now + 0.1, n: lerp(B.power[0], B.power[1], Math.random()) * (lob ? 0.5 : 1), dir: clamp(tx / (2.4 * sgn(pl.side)), -1, 1), lob, slice, why: null, best: Infinity, from: now };
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
      let pw = clamp((num(m.power, 6) - 6) / 28, 0, 1);
      // an overhead is a smash: the paddle comes DOWN through the ball. Any committed downward swing gets smash pace,
      // the player doesn't also have to make it their biggest, longest swing of the day.
      if (clamp(num(m.chop, 0), 0, 1) > 0.45 && pw > 0.25) pw = Math.max(pw, 0.86);
      if (ball.live && ball.serving === me.side) {               // my serve: only a real stroke that meets the ball counts.
        if (num(m.power, 6) < SERVE_POWER) return;               // a twitch, a flick, a quick step: nothing happens at all
        broadcast({ type: 'swung', side: me.side });
        if (serveReach(me)) { ball.serving = null; strike(me, { n: pw, dir: clamp(num(m.dir, 0), -1, 1), lob: clamp(num(m.lob, 0), 0, 1), slice: clamp(num(m.slice, 0), -1, 1) }); }   // struck on arrival, not on the next tick
        return;                                                  // swung at air: no whiff, no point, the ball keeps hanging
      }
      const dir = clamp(num(m.dir, 0), -1, 1), lob = clamp(num(m.lob, 0), 0, 1), slice = clamp(num(m.slice, 0), -1, 1);   // signed spin, 0 when the client sends none
      if (m.fix) {                                               // clients report a swing early, on a predicted peak; this is the real one
        if (me.swing) Object.assign(me.swing, { n: pw, dir, lob, slice });                     // hasn't met the ball yet: just correct it
        else if (me.hit && now - me.hit.at < FIX_WINDOW && ball.live && ball.lastHit === me.side && !ball.bounces && ball.p[2] * sgn(me.side) > 1
          && (Math.abs(pw - me.hit.n) > 0.04 || Math.abs(dir - me.hit.dir) > 0.1 || Math.abs(lob - me.hit.lob) > 0.1 || Math.abs(sliced(slice, lob) - sliced(me.hit.slice, me.hit.lob)) > 0.2 || (slice < 0) !== (me.hit.slice < 0) && sliced(slice, lob) > 0.3)) {
          Object.assign(me.hit, { n: pw, dir, lob, slice }); reaim(me.side, pw, dir, lob, slice);   // struck a moment ago on the early guess: bend it onto the real shot while it is still on my side
        }
        return;
      }
      me.swing = { until: now + SWING_WINDOW + (1 - pw) * 0.28,   // gentle swings are long, unhurried motions: give them a longer window
        from: now - clamp(num(m.age, 0) / 1000, 0, LAG_MAX),       // lag compensation: the hand started moving `age` ms ago (sensor + Bluetooth lateness)
        n: pw,                                                     // 6 = a tap, ~17 = backhand, 30 = solid forehand, 34+ = smash
        dir, lob, slice, why: null, best: Infinity };
      broadcast({ type: 'swung', side: me.side });
      tryHit(me);                                                // ball already there: struck NOW, not on the next tick
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
      pl.z += clamp(pl.lunge.z - pl.z, -1.2 * FOOT_SPEED * DT, 1.2 * FOOT_SPEED * DT);
      continue;
    }
    if (pl.ownZ != null && !pl.auto) {
      // Forward/back is shared. The game carries you most of the way to where the ball can be reached (a short ball in the
      // kitchen must never be unreachable); your own lean on the AirPod (ownZ, 6.5 = neutral) adds the rest, either way.
      const sd = sgn(pl.side), incoming = ball.live && ball.serving == null && ball.lastHit !== pl.side;
      const assist = incoming ? lerp(HIT_LINE, pl.zT * sd, Z_ASSIST) : HIT_LINE;
      const want = clamp(assist + (pl.ownZ - HIT_LINE), Z_NEAR, Z_FAR + 0.4);
      pl.z += clamp(sd * want - pl.z, -FOOT_SPEED * DT, FOOT_SPEED * DT); continue;
    }
    const home = !ball.live || ball.serving != null || ball.lastHit === pl.side;   // nobody wanders off while a serve is hanging
    const zT = home ? sgn(pl.side) * HIT_LINE : pl.zT;
    pl.z += clamp(zT - pl.z, -FOOT_SPEED * DT, FOOT_SPEED * DT);
  }

  if (ball.live && ball.serving != null) {
    const pl = bySide(ball.serving);
    if (!pl || ball.lastHit === ball.serving) ball.serving = null;            // it's been struck (or the server left)
    else {
      hangBall(DT);
      if (now >= ball.serveBy) {
        ball.serving = null; broadcast({ type: 'swung', side: pl.side });
        launch(pl.side, pl.bot ? 0.2 + Math.random() * 0.3 : 0.25, (Math.random() - 0.5) * 1.4, 0.2, { type: 'hit', side: pl.side, n: 0.3 });
      }
    }
  } else if (ball.live) {
    if (ball.aim) easeAim();
    ball.v[1] -= (ball.bounces ? G : gOf(ball.spin)) * DT;
    for (let i = 0; i < 3; i++) ball.p[i] += ball.v[i] * DT;
    remember();
  }

  // Close to the net you don't need a swing: hold the paddle in the ball's path and it pops back as a soft dink.
  // Only for players who place the paddle themselves, never on a serve, never twice in a row.
  for (const pl of players) {
    if (!BLOCK_ON || pl.bot || pl.auto || pl.swing || !ball.live || ball.serving != null || ball.lastHit === pl.side) continue;
    const z = inZone(pl);
    if (Math.abs(pl.z) <= BLOCK.within && Math.abs(z.dx) < BLOCK.x && Math.abs(z.dy) < BLOCK.y && z.ahead < BLOCK.front && z.ahead > -BLOCK.behind)
      strike(pl, { n: 0.06, dir: clamp(-pl.x * sgn(pl.side) / 3, -0.6, 0.6), lob: 0.6, kind: 'block' });
  }

  // contact (see tryHit); the paddle lunges to the ball
  for (const pl of players) {
    const sw = pl.swing; if (!sw || tryHit(pl)) continue;
    const mine = ball.live && ball.lastHit !== pl.side, z = inZone(pl);          // is this ball mine to hit?
    // remember the near miss closest to the paddle plane, so the reason isn't always 'late' by the time the window ends
    if (mine && z.depth && Math.abs(z.ahead) < sw.best) { sw.best = Math.abs(z.ahead); sw.why = aside(z); }
    if (now > sw.until) {
      pl.swing = null;
      if (mine && ball.serving == null) send(pl, { type: 'whiff', why: whyMissed(sw, z) });
    }
  }

  if (ball.live && ball.p[1] < R) {
    ball.p[1] = R; if (ball.bounces) bounceV(ball.v, 0, 0); else bounceV(ball.v, ball.spin, ball.kick); ball.bounces++;
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
  const srv = ball.live && ball.serving != null && bySide(ball.serving);
  broadcast({ type: 'state', t: now, p: ball.p, v: ball.v, spin: ball.spin, live: ball.live, serving: ball.serving, reach: srv ? serveReach(srv) : false, score, paddles });   // reach: the server could serve it right now
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
module.exports = { COURT, ZONE, BOUNCE, SLICE, G, R, PASSED, solve, shotKind };   // test/server.test.mjs sweeps solve() directly
