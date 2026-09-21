// ONE shared process, many matches. A match is a room (docs/ROOMS.md): createRoom() holds everything that is one game,
// the lobby layer below it decides which room a socket sits in. Authoritative ball + contact detection. Clients render and send input.
// docs/SPECTATE.md + docs/API-NEXT.md 4: spectators, names, match end -> rematch vote -> closed, a dropped seat held then forfeited, pause.
const { WebSocketServer } = require('ws');
const http = require('http'), fs = require('fs'), path = require('path');

// The same port also serves web/ over plain HTTP, so a hosted copy (fly.io) is one process behind one address:
// the page loads from https://<app>/ and its game socket is wss://<app>/. Locally nothing changes.
const WEB = path.join(__dirname, '..', 'web');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm', '.woff2': 'font/woff2',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml; charset=utf-8', '.ico': 'image/x-icon' };
const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.webp', '.svg', '.ico']);                              // the share card is busted by ?v=, icons rarely change: a week
const MOVED = { '/how-to-play': '/how-to-play.html', '/how-to-play/': '/how-to-play.html' };            // clean URLs: a fixed map, no extension guessing
let PAGE_404 = null; try { PAGE_404 = fs.readFileSync(path.join(WEB, '404.html')); } catch { /* no page: plain words */ }
function notFound(req, res) {                                                                           // a miss is a real 404 (never a soft 200) and never indexed
  const body = PAGE_404 || Buffer.from('not found');
  res.writeHead(404, { 'Content-Type': PAGE_404 ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-cache', 'X-Robots-Tag': 'noindex' });
  res.end(req.method === 'HEAD' ? undefined : body);
}
const SITE = 'poddleball.com', OLD_HOSTS = new Set(['poddle.fly.dev', 'www.poddleball.com']);      // the site's one name, and the names that forward to it
const httpServer = http.createServer((req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Length': 0 }); return res.end(); }   // a WebSocket upgrade never comes through here
  const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
  if (OLD_HOSTS.has(host)) { res.writeHead(301, { Location: 'https://' + SITE + req.url, 'Cache-Control': 'public, max-age=3600', 'Content-Length': 0 }); return res.end(); }   // one address for people, crawlers and share cards. Sockets still connect on any host: an open tab from the old address keeps playing
  const [rawPath, ...query] = req.url.split('?');
  let rel; try { rel = decodeURIComponent(rawPath); } catch { rel = '/'; }
  if (rel.includes('\0')) { res.writeHead(400); return res.end(); }                                     // fs.stat THROWS on a null byte (GET /%00), and a throw in here ends the process and every room in it
  if (MOVED[rel]) { res.writeHead(301, { Location: MOVED[rel] + (query.length ? '?' + query.join('?') : ''), 'Cache-Control': 'no-cache', 'Content-Length': 0 }); return res.end(); }
  if (rel === '/404.html') return notFound(req, res);
  const file = path.join(WEB, path.normalize(rel.endsWith('/') ? rel + 'index.html' : rel));
  if (file !== WEB && !file.startsWith(WEB + path.sep)) { res.writeHead(403); return res.end(); }      // no climbing out of web/
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return notFound(req, res);
    const ext = path.extname(file).toLowerCase(), mtime = Math.floor(st.mtimeMs / 1000) * 1000;
    // Validators make 'no-cache' cheap: a reload is a handful of 304s, not 300 KB of JS and CSS again. The tag is weak because the proxy in front (fly) compresses the body.
    const head = { 'Cache-Control': file.includes(path.sep + 'vendor' + path.sep) ? 'public, max-age=86400' : IMAGE.has(ext) ? 'public, max-age=604800' : 'no-cache',     // vendor/ is 18 MB and never changes
      ETag: `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`, 'Last-Modified': new Date(mtime).toUTCString() };
    const inm = req.headers['if-none-match'], ims = Date.parse(req.headers['if-modified-since']);
    const same = inm ? inm.split(',').some(t => t.trim() === '*' || t.trim().replace(/^W\//, '') === head.ETag.slice(2)) : ims >= mtime;
    if (same) { res.writeHead(304, head); return res.end(); }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': st.size, ...head });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);   // a file that went away after the stat must not be an uncaught 'error'
  });
});
const wss = new WebSocketServer({ server: httpServer, maxPayload: 4096 });   // our biggest message is a few hundred bytes; a huge one is an attack (deep nesting overflows the stack) and closes that socket
httpServer.listen(+process.env.PORT || 8080);

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
// A serve is wound up first, and the wind-up is a swing too (30 recorded pairs: 0.4-0.9 s apart, 27 of 30 the other way, wind-up power median 7, p90 15, max 21).
// The client reports a swing EARLY, on a bet that overshoots (recorded wind-ups: first called 30.4, settled 8.2; 32.3 > 8.0; 26.6 > 6.0), then sends
// the settled power (final). Only a settled report decides a serve: the bets alone still served with 10 of 27 recorded wind-ups, settled ones with 2.
const SERVE_SURE = 17;                    // SETTLED this hard is no wind-up: struck at once (settled wind-ups: median 6.9, p90 15.2, 2 of 31 reach 17)
const SERVE_WAIT = 0.3;                   // s a bet may wait for its settled report (it lands 60-280 ms later) before it is taken as it stands
const SERVE_PREV = 1.2;                   // s: a swing this soon after another one IS the stroke, the one before was its wind-up (if it beats that one: as strong, or the other way)
const SERVE_HOLD = 0.7;                   // s a lone middling swing waits for the real stroke to follow before it serves by itself
const SERVE_FLOOR = 0.35;                 // a legal soft serve still carries past the kitchen
const REACH = 3.2;                        // no shot asks the receiver to get the paddle wider than this
const PASSED = 5.5;                       // a bounced ball this far beyond the baseline is gone
const SCALE = +process.env.TIMESCALE || 1;                     // tests only: run the sim faster than real time
const HEARTBEAT = +process.env.HEARTBEAT || 4000;              // ms between pings; a socket that misses one is dead (sleeping laptop, dropped wifi)

const sgn = side => (side === 0 ? 1 : -1);        // side 0 lives at +z, side 1 at -z
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const num = (v, d) => (Number.isFinite(+v) ? +v : d);          // untrusted input -> finite number
const DT = 1 / 60;

// The bot (one per room at most; the rules are further down, in the room).
// react: s before it starts moving. foot: m/s. err: how far it misjudges x (m). reach: how centred the ball must be
// before it swings. place: 0 = hits anywhere, 1 = always away from you. whiff: chance it simply mistimes a swing.
const BOTS = [
  { name: 'Rookie', react: 0.45, foot: 1.9, err: 0.9, reach: 0.55, power: [0.10, 0.40], place: 0.0, lob: 0.25, slice: 0, whiff: 0.18 },
  { name: 'Club',   react: 0.30, foot: 2.5, err: 0.5, reach: 0.70, power: [0.25, 0.65], place: 0.5, lob: 0.15, slice: 0.1, whiff: 0.07 },
  { name: 'Pro',    react: 0.18, foot: 4.2, err: 0.2, reach: 0.90, power: [0.45, 0.95], place: 0.9, lob: 0.10, slice: 0.18, whiff: 0.02 },
];
const AUTOBOT = process.env.AUTOBOT !== '0';                   // tests turn off auto-join and (in LOCAL) seat takeover
const SWING_SERVE = process.env.SWING_SERVE != null ? process.env.SWING_SERVE !== '0' : AUTOBOT;   // off in tests
const WIN_AT = process.env.WIN_AT != null ? +process.env.WIN_AT : (AUTOBOT ? 11 : 0);   // first to 11, win by 2 (off in tests)
const WIN_BY = process.env.WIN_BY != null ? +process.env.WIN_BY : 2;                  // tests only: a browser test needs a match that is SURE to end (two scripted players can trade points at deuce for ever)
const ROOM_TTL = (process.env.ROOM_TTL != null ? +process.env.ROOM_TTL : 30) * 1000;   // ms a room may stand with no human in it (tests shorten it)
const ROOM_CAP = +process.env.ROOM_CAP || 40;                  // rooms at once: one small machine hosts them all (tests lower it)
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';          // no I, L, O, 0, 1: a code gets read out across a room
const SPEC_CAP = 8;                                            // spectators per room (docs/SPECTATE.md)
const ADDR_ROOMS = +process.env.ADDR_ROOMS || 4;               // rooms one address may have made and still standing: 40 idle sockets from one machine took every court (busy beyond that)
const MSG_DROP = 200 * SCALE, MSG_KILL = 1000 * SCALE;         // messages a second from one socket: a client sends about 25. Past the first the rest are dropped unread, past the second the socket goes (one flooding socket held every court at 8-12 packets a second)
const BUF_MAX = 256 * 1024;                                    // bytes queued on a socket that has stopped reading: it is dead weight, and 8 of them took the process to 1.6 GB on a 256 MB machine
const SMASH = 0.76;                                            // n above this is a smash (27.3 rad/s)
const REMATCH_S = +process.env.REMATCH_S || 20, HOLD_S = +process.env.HOLD_S || 15, PAUSE_S = +process.env.PAUSE_S || 600, CAL_S = +process.env.CAL_S || 60;   // s on the WALL clock (room time stands still in two of them): the rematch vote, a dropped player's seat, the longest pause, the longest a match waits for a seat that says it is calibrating. Tests shorten them
let clock = 0;                            // sim clock of the process. A room starts its own time from it and stops that while paused or holding a seat, so rooms agree until one of them pauses
// A name is untrusted text that lands on other people's screens: strings only, no control, invisible or bidi characters, no angle brackets, 12 characters. '' = none given.
// Nor characters that draw as nothing (Hangul fillers, the braille blank, soft hyphen, tags: a name of those was a blank on every scoreboard), nor more than 2 stacked marks on a letter. What is left must have something to see in it.
const NAME_OUT = /[\u0000-\u001f\u007f-\u009f\p{Cf}\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180f\u2028-\u202e\u2800\u3164\uffa0\ufff9-\ufffb\u{e0000}-\u{e0fff}\ud800-\udfff<>]/gu;
const cleanName = v => { if (typeof v !== 'string') return '';
  const n = [...v.slice(0, 64).replace(NAME_OUT, '').replace(/(\p{M}{2})\p{M}+/gu, '$1').replace(/\s+/g, ' ').trim()].slice(0, 12).join('').trim();
  return /[\p{L}\p{N}\p{S}\p{P}]/u.test(n) ? n : ''; };
const secsTo = ms => Math.max(0, Math.ceil((ms - Date.now()) / 1000));
// Every message leaves through here. A socket that has stopped reading (BUF_MAX queued) is let go instead of fed: whoever it was reconnects by cid if they are still there.
function put(ws, s) { if (!ws || ws.readyState !== 1) return; if (ws.bufferedAmount > BUF_MAX) return ws.terminate(); ws.send(s); }

function newPlayer(ws, side) {
  return { ws, side, x: 0, y: 1.0, z: sgn(side) * HIT_LINE, zT: sgn(side) * HIT_LINE, q: [0, 0, 0, 1], swing: null, lunge: null, contact: null, react: 0, err: 0, bot: !ws, swAt: -Infinity, swPrev: -Infinity, swPow: 0, swDir: 0, pvPow: 0, pvDir: 0, servePending: null };   // sw*: my latest swing (when, and its last reported power and dir), swPrev / pv*: the one before it
}

// Ballistic solve: pick where the ball should land, find the velocity that gets it there
// and clears the net. Every shot is "in" by construction; the skill is reaching and timing it.
// how underhand was the swing? lob is the upward-scoop share of the stroke, 0..0.8 from the client
const underhand = lob => { const t = clamp((lob / 0.8 - 0.62) / 0.26, 0, 1); return t * t * (3 - 2 * t); };   // well over half the stroke must be going UP (upward share 0.62 starts to count, 0.88 is fully underhand): a normal low-to-high swing is not a lob
// how sliced? slice = the spin the client measured in the swing (wrist roll or a curved path), |slice| = how much, its sign = which way it breaks.
// CONTINUOUS: every hit carries its own amount (a threshold made 76 % of real strokes exactly 0 and 16 % full, nothing between). A scoop is never much of a slice.
const sliced = (slice, lob) => clamp(Math.abs(slice || 0), 0, 1) * (1 - 0.6 * underhand(lob));
const hard = n => { const t = clamp((n - 0.45) / 0.25, 0, 1); return t * t * (3 - 2 * t); };   // 0 below n 0.45, 1 from 0.7: power beats spin (nothing in here uses it today; test/kinds.mjs still reads it)
// smash: n 0.76 = 27.3 rad/s: it has to be earned (p90 of every recorded swing, twitches included; of his real strokes, power >= 9, one in four gets there).
// 'slice' is the label for spin that READS as one (> 0.5). A twitch (n < 0.1) is a tap whatever the wrist did: 28 of the 41 recorded 'slices' were under 9 rad/s.
const shotKind = (n, lob, slice) => (n > 0.76 && underhand(lob) <= 0.5 ? 'smash' : n < 0.1 && underhand(lob) <= 0.5 ? 'tap' : sliced(slice, lob) > 0.5 ? 'slice' : underhand(lob) > 0.5 ? (n < 0.2 ? 'dink' : 'lob') : n > 0.76 ? 'smash' : n < 0.1 ? 'tap' : 'drive');
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
  const top = clamp((n - 0.76) / 0.24, 0, 1);                  // a smash is rewarded: above n 0.76 the drive gets faster still, 0.58 s -> 0.51 s at full power (where the net allows: see fly)
  let T = lerp(lerp(1.2, 0.58, Math.pow(n, 0.85)) - 0.07 * top * top * (3 - 2 * top), lerp(1.2, 1.95, nu), u);   // underhands always travel on a high, slow arc
  const spin = sliced(slice, lob), g = gOf(spin), kick = s * ((slice || 0) < 0 ? -1 : (slice || 0) > 0 ? 1 : dir >= 0 ? 1 : -1) * (0.55 + 0.45 * Math.abs(dir)) * SLICE.kick * spin;   // always a real break, the way the paddle cut across it
  T *= 1 + SLICE.slow * spin * (1 - top);                      // same depth (power still sets it), slower and floatier. Not a smash: every swing carries some spin now (median 0.27 on his smashes) and the full slow-down made 3 of 16 recorded smashes SLOWER than a flat 27 rad/s drive
  // From the baseline a flat drive is limited by the net, not by T, and fly()'s 0.05 s steps would hand the 0.07 s straight back (measured:
  // 0.73 s became 0.76 s). So a smash takes the exact fastest flight that clears: never slower than before, as fast as the net lets it be.
  const v = [0, 0, 0]; T = fly(v, px, py, pz, tx, tz, T, g, lerp(0.25, SLICE.clear, spin), top > 0 && !u);
  // wide balls keep drifting after the bounce; pull the target in so the top of the bounce stays within REACH
  const ta = lerp(BOUNCE.up, SLICE.up, spin) * (g * T - v[1]) / G, k = lerp(BOUNCE.along, SLICE.along, spin) * ta / T, xc = tx + (tx - px) * k + kick * ta;
  const late = Math.abs(v[0]) * DT;                            // the 60 Hz sim lands up to a tick after this closed form, a tick further out: fast wide drives topped out at 3.27 m (test/server.test.mjs sweep allows 3.25)
  if (Math.abs(xc) + late > REACH) { tx = (Math.sign(xc) * (REACH - late) - kick * ta + px * k) / (1 + k); v[0] = (tx - px) / T; }
  return { v, land: [tx, tz], T, spin, kick };
}

// the velocity (into v) that lands on (tx, tz) T seconds from now; T grows until the ball clears the net. Returns T.
function fly(v, px, py, pz, tx, tz, T, g = G, clear = 0.25, exact = false) {
  if (exact && pz * tz < 0) {                               // height over the net is py + (R - py) f + g f (1 - f) T^2 / 2 with f = the share of the way to the net: solve it for T
    const f = pz / (pz - tz), need = COURT.net + clear - py - (R - py) * f;
    if (need > 0) T = Math.max(T, Math.sqrt(2 * need / (g * f * (1 - f))) + 1e-6);
  }
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

// ---------- a room: one match ----------
// Everything that used to be one game per process (players, ball, score, serve, bot, ball history, timers) is a local in
// here, with the functions that touch it. Nothing in a room can reach another room's state: there is no way to name it.
function createRoom(code, pub) {
  const LEGACY = code === 'LOCAL';          // the old single game: no votes that count, no seat hold, never closed (a real code has 4 characters)
  const players = [];                       // { ws|null(bot, or a human whose seat is held), side, x, y, z, zT, q, swing, lunge, contact, name, cid }
  const spectators = new Set();             // sockets that watch: never seated, never counted by humans(), never keep the room alive (docs/SPECTATE.md)
  let now = clock;                          // ROOM time: state.t, hit.t and every timer in here. It stands still while paused or holding a seat, so serveBy, swing windows and the bot freeze for free
  let started = false, firstServe = 0;      // has a ball been struck in this match (before that a leaver just leaves); who served first (the next match alternates)
  let over = null, hold = null, paused = null, slow = null;   // over: { winner, forfeit, votes, until, names }  hold: { side, until, said }  paused: { by, until }  slow: { side, until, said } a seat calibrating mid-match   (until = wall clock ms)
  const ball = { spin: 0, kick: 0, aim: null, serving: null, serveBy: 0, hang: [0, 1, 0], hv: [0, 0, 0], drag: [false, false, false], p: [0, 1, 0], v: [0, 0, 0], live: false, lastHit: 0, bounces: 0 };
  const score = [0, 0];
  let server = 0, serveAt = Infinity, tick = 0;     // who serves next; when (sim time); steps taken

  function send(pl, msg) { put(pl.ws, JSON.stringify(msg)); }
  function broadcast(msg, skip) { const s = JSON.stringify(msg); for (const pl of players) if (pl.ws !== skip) put(pl.ws, s); for (const ws of spectators) put(ws, s); }
  const bySide = side => players.find(p => p.side === side);
  // the server owns the names: a human's clean one, Matt for the bot (at every level), null for an empty seat
  const names = () => [0, 1].map(sd => { const p = bySide(sd); return p ? (p.bot ? 'Matt' : p.name) : null; });
  let namesSent = '';
  function tellNames(skip) { const n = names(), s = JSON.stringify(n); if (s !== namesSent) { namesSent = s; broadcast({ type: 'names', names: n }, skip); } }   // whenever a seat changes hands (skip: whoever just read them in their welcome)

  function launch(side, n, dir, lob, hit, slice) {
    const sol = solve(ball.p, side, n, dir, lob, slice);
    ball.p[1] = Math.max(ball.p[1], R);
    ball.v = sol.v; ball.spin = sol.spin; ball.kick = sol.kick; ball.lastHit = side; ball.bounces = 0; ball.aim = null; hLen = 0; started = true;
    planFootwork(1 - side);
    if (hit) broadcast({ ...hit, p: ball.p, v: ball.v, spin: ball.spin, k: ball.kick, t: now });   // p + v: the hitter's screen bends the ball away on this very frame
    broadcast({ type: 'launch', by: side, land: sol.land, spin: sol.spin });
  }

  // A corrected power arrived just after the hit. Never swap the velocity: steer onto the new landing spot over FIX_EASE.
  function reaim(side, n, dir, lob, slice, kind) {
    const sol = solve(ball.p, side, n, dir, lob, slice);
    ball.aim = { land: sol.land, T: sol.T, k: Math.max(1, Math.round(FIX_EASE / DT)), side, clear: lerp(0.25, SLICE.clear, sol.spin) };
    ball.spin = sol.spin; ball.kick = sol.kick;
    planFootwork(1 - side, sol.v);
    broadcast({ type: 'launch', by: side, land: sol.land, spin: sol.spin, k: sol.kick, n, kind });     // the landing marker moves now. n: the trail burns for the real power, not the bet. kind: only when the settled swing changed it (a smash is announced here, never on a bet)
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
    for (const p of players) p.swing = p.lunge = p.servePending = null;
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
    const kind = sw.kind || shotKind(sw.n, sw.lob, sw.slice);
    pl.swing = null; pl.hit = sw.kind ? null : { at: now, n: sw.n, dir: sw.dir, lob: sw.lob, slice: sw.slice || 0, floor: sw.floor || 0, kind };   // a swing (not a block) may still be corrected (floor: a serve's correction keeps the serve floor)
    pl.lunge = { z: pl.z + clamp(ball.p[2] + sgn(pl.side) * CONTACT - pl.z, -0.45, 0.45), until: now + 0.15 };   // a small step into the ball, never a jump
    launch(pl.side, sw.n, sw.dir, sw.lob, { type: 'hit', side: pl.side, n: sw.n, kind }, sw.slice);
  }

  // a fresh pair (human+human or human+bot): clean score, first serve
  function startMatch(first) {
    score[0] = score[1] = 0; server = firstServe = first; ball.live = false; ball.serving = null; serveAt = now + 0.8; started = false; over = null; newMatchAt = Infinity;
    if (pub) lobbyChanged();
  }

  // ---------- match end, rematch vote, closing (docs/SPECTATE.md). A finished match no longer restarts by itself ----------
  const overMsg = () => ({ type: 'matchover', winner: over.winner, score: [...score], forfeit: over.forfeit, rematchBy: secsTo(over.until), names: over.names });   // names: as they were when it ended (a forfeit has emptied a seat by now)
  const voteMsg = () => ({ type: 'rematch', votes: over.votes, left: secsTo(over.until) });
  function endMatch(winner, forfeit, nm) {
    ball.live = false; ball.serving = null; serveAt = Infinity; for (const pl of players) pl.swing = pl.servePending = null;
    over = { winner, forfeit, names: nm || names(), until: Date.now() + (LEGACY ? 5 : REMATCH_S) * 1000,
      votes: [0, 1].map(sd => { const p = bySide(sd); return p ? (p.bot ? true : null) : false; }) };      // Matt always wants another; a seat that was forfeited cannot
    if (LEGACY) newMatchAt = now + 5;                            // LOCAL: a new match after 5 s whatever anyone says (test/e2e.mjs lives there)
    broadcast(overMsg());
    if (!LEGACY && over.votes.some(v => v != null)) broadcast(voteMsg());
    if (pub) lobbyChanged();
  }
  function vote(me, yes) {
    if (!over || LEGACY || typeof yes !== 'boolean' || over.votes[me.side] != null) return;   // one answer each, booleans only
    over.votes[me.side] = yes; broadcast(voteMsg());
    if (over.votes.includes(false)) return close('norematch');  // one no is enough, and after a forfeit there is nobody to play: everyone back to the lobby
    if (over.votes.every(v => v === true)) { broadcast({ type: 'rematchon' }); startMatch(1 - firstServe); }   // spectators stay where they are
  }
  // The room ends NOW: everyone in it (players and spectators alike) is told why and lands in the lobby, the code is free again.
  function close(reason) {
    if (LEGACY || room.dead) return;
    const out = [...players.filter(p => p.ws).map(p => p.ws), ...spectators];
    room.dead = true; players.length = 0; spectators.clear(); over = hold = paused = slow = null;
    if (rooms.get(code) === room) rooms.delete(code);
    for (const ws of out) { ws.room = ws.pl = null; ws.spec = false; tell(ws, { type: 'closed', reason }); if (ws.readyState === 1) enterLobby(ws); }
    console.log(`[${code}] room closed (${reason})`); lobbyChanged();
  }
  function sendOff() {                                            // nobody left to watch: spectators go back to the lobby, the room itself waits out ROOM_TTL as it always has
    for (const ws of [...spectators]) { spectators.delete(ws); ws.room = null; ws.spec = false; tell(ws, { type: 'closed', reason: 'empty' }); if (ws.readyState === 1) enterLobby(ws); }
  }

  // ---------- a dropped player's seat is held (two humans, mid-match): room time stops, everyone counts down with it ----------
  function sayHold() { const l = secsTo(hold.until); if (l !== hold.said) { hold.said = l; broadcast({ type: 'hold', side: hold.side, left: l }); } }   // once a second
  function startHold(me) {
    if (paused) resume();                                        // (a bot court) the pauser went: they pause again when they are back with the panel still open
    me.ws = null; me.swing = me.servePending = null;             // the seat stays taken (humans() still counts it): nobody else can sit down in it
    hold = { side: me.side, until: Date.now() + HOLD_S * 1000, said: -1 }; sayHold();
    console.log(`[${code}] side ${me.side} dropped: seat held ${HOLD_S} s`);
  }
  function forfeitHeld() {                                        // not back in time: the one who stayed wins
    if (humans().length === 1) { const me = bySide(hold.side); hold = null; broadcast({ type: 'holdoff' }); return leave(me); }   // a bot court held for its spectators: nobody else was playing, so the court empties as if they had left (closed empty)
    const sd = hold.side, nm = names(), i = players.findIndex(p => p.side === sd);
    hold = null; if (i >= 0) players.splice(i, 1);
    broadcast({ type: 'holdoff' }); endMatch(1 - sd, true, nm);
  }
  const heldBy = cid => (cid && hold && players.find(p => !p.bot && !p.ws && p.cid === cid)) || null;

  // ---------- a seat that says it is calibrating mid-match holds the next serve. Not for ever: {type:'status',cal:true} and then silence kept a court at
  // 'serving null' for good, the honest player could not pause and his only way out was a forfeit LOSS. CAL_S, the last 30 s counted down to everyone, then the
  // staller is out (closed, reason away) and it is a forfeit for the one who waited.
  function slowSeat(ms) {
    const p = !LEGACY && started && !over && !hold && !ball.live && now >= serveAt && humans().length === 2 ? players.find(q => !ready(q)) : null;   // only while the serve is really waiting for them: a rally in flight plays on
    if (!p) { if (slow) { if (slow.said >= 0) broadcast({ type: 'waitoff' }); slow = null; } return; }
    if (!slow || slow.side !== p.side) { if (slow && slow.said >= 0) broadcast({ type: 'waitoff' }); slow = { side: p.side, until: ms + CAL_S * 1000, said: -1 }; }
    const l = secsTo(slow.until);
    if (ms < slow.until) { if (l <= 30 && l !== slow.said) { slow.said = l; broadcast({ type: 'wait', side: p.side, left: l }); } return; }
    const nm = names(), ws = p.ws; slow = null; broadcast({ type: 'waitoff' }); players.splice(players.indexOf(p), 1);
    if (ws) { ws.room = ws.pl = null; tell(ws, { type: 'closed', reason: 'away' }); enterLobby(ws); }
    console.log(`[${code}] side ${p.side} calibrating for ${CAL_S} s mid-match: forfeit`); endMatch(1 - p.side, true, nm);
  }

  // ---------- pause: only while ONE human is seated (Matt or nobody opposite). Spectators do not prevent it ----------
  function resume() { const by = paused.by; paused = null; broadcast({ type: 'paused', on: false, by }); }
  function pause(me, on) {
    if (typeof on !== 'boolean') return;
    if (on && humans().length !== 1) return send(me, { type: 'paused', on: false, refused: true });   // an online game cannot pause
    if (on === !!paused) return send(me, { type: 'paused', on, by: paused ? paused.by : me.side });     // already so: just the answer
    if (on) { paused = { by: me.side, until: Date.now() + PAUSE_S * 1000 }; broadcast({ type: 'paused', on: true, by: me.side }); } else resume();
  }

  function point(winner, why) {
    score[winner]++; ball.live = false;
    const loser = bySide(1 - winner);
    if (loser && loser.swing && ball.lastHit === winner) send(loser, { type: 'whiff', why: whyMissed(loser.swing, inZone(loser)) });
    for (const pl of players) pl.swing = null;
    const final = WIN_AT > 0 && score[winner] >= WIN_AT && score[winner] - score[1 - winner] >= WIN_BY;
    broadcast({ type: 'point', winner, why, score, final });
    server = 1 - server; serveAt = now + 1.5;                    // serve alternates every point
    if (final) endMatch(winner, false); else if (pub) lobbyChanged();   // the lobby list shows the score of a room that can be watched
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
  let botLevel = 1, botJoinAt = Infinity;
  let newMatchAt = Infinity;
  const humans = () => players.filter(p => !p.bot);
  const theBot = () => players.find(p => p.bot);
  const ready = p => p.bot || p.ready && !p.cal || !AUTOBOT;    // a client sends no 'paddle' until it is calibrated (and says so when it calibrates again, 'status'): until then that player cannot see the court, so no point is played (test clients may never send one)
  // What the others see on that character (docs/SPECTATE.md Seat status): away = the seat is held for a reconnect, paused = this seat stopped the room, calibrating. Matt never has one.
  const statusOf = p => p.bot ? null : hold && hold.side === p.side ? 'away' : paused && paused.by === p.side ? 'paused' : !ready(p) ? 'calibrating' : null;
  const botInfo = () => ({ type: 'botinfo', active: !!theBot(), level: botLevel, name: BOTS[botLevel].name, levels: BOTS.map(b => b.name) });

  function addBot() {
    if (theBot() || humans().length !== 1) return;
    players.push(newPlayer(null, 1 - humans()[0].side));
    console.log(`bot joined (${BOTS[botLevel].name})`);
    broadcast(botInfo());
    startMatch(humans()[0].side); tellNames();
  }
  function removeBot() {
    const i = players.findIndex(p => p.bot);
    if (i >= 0) { players.splice(i, 1); ball.live = false; serveAt = Infinity; broadcast(botInfo()); }
  }
  // B key: alone -> join now; already playing the bot -> next difficulty; two humans -> say why not.
  function botRequest(from, level) {
    if (over) return;                                            // a match is being voted on: nothing starts behind the result screen
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

  // What a socket hears on sitting down, as a player or (side null) to watch: welcome + botinfo as always, then whatever
  // is going on that it missed (a pause, a held seat, a finished match being voted on).
  function greet(ws, side) {
    tell(ws, { type: 'welcome', side, role: side == null ? 'spectator' : 'player', court: COURT, names: names() });
    tell(ws, botInfo());
    if (paused) tell(ws, { type: 'paused', on: true, by: paused.by });
    if (hold) tell(ws, { type: 'hold', side: hold.side, left: secsTo(hold.until) });
    if (over) { tell(ws, overMsg()); if (!LEGACY) tell(ws, voteMsg()); }
  }
  // Seat a socket (the lobby layer has checked there is a seat).
  function join(ws) {
    if (paused) resume();                                        // a second human: an online game cannot pause
    if (over) { over = null; newMatchAt = Infinity; broadcast({ type: 'rematchon' }); }   // (a bot room being voted on) the result screen closes, a fresh match starts below
    if (humans().length >= 1) removeBot();                     // a second human replaces the bot
    botJoinAt = Infinity;
    const side = players.length && players[0].side === 0 ? 1 : 0;
    const me = newPlayer(ws, side); me.cid = ws.cid; me.name = ws.name || (side ? 'Player 2' : 'Player 1');
    players.push(me); ws.room = room; ws.pl = me; ws.spec = false;
    if (humans().length === 1) room.waitAt = Date.now();
    greet(ws, side);
    console.log(`[${code}] player joined as side ${side} (${players.length} connected)`);
    if (players.length === 2) startMatch(0); else if (AUTOBOT) botJoinAt = now + 2.5;       // alone: the bot shows up by itself
    tellNames(ws);
  }
  // The same player on a new socket (their cid): a reconnect while the old socket is still half-open, or a return to a
  // held seat. The seat, its name, the score and the match carry on; nobody is told anyone left.
  function retake(pl, ws) {
    if (pl.ws) pl.ws.room = pl.ws.pl = null;
    pl.ws = ws; ws.room = room; ws.pl = pl; ws.spec = false; pl.ready = pl.cal = false;   // ready: the serve waits for their first paddle message again (a reloaded page is calibrating)
    const back = hold && hold.side === pl.side; if (back) hold = null;
    greet(ws, pl.side);
    if (back) {                                                  // the point is replayed: same server, score kept
      if (ball.live) { ball.live = false; ball.serving = null; serveAt = now + 0.8; for (const p of players) p.swing = p.servePending = null; }
      broadcast({ type: 'holdoff' }); console.log(`[${code}] side ${pl.side} is back`);
    }
  }
  function watch(ws) { spectators.add(ws); ws.room = room; ws.pl = null; ws.spec = true; greet(ws, null); if (pub) lobbyChanged(); }
  function unwatch(ws) { if (spectators.delete(ws)) { ws.room = null; ws.spec = false; if (pub) lobbyChanged(); } }
  // A human goes. again: their seat is wanted by their own arrival from the same machine (legacy LOCAL only: the new
  // socket sits down on this same call, nothing is torn down, nobody is told). dropped: the socket closed by itself.
  function leave(me, again, dropped) {
    const i = players.indexOf(me); if (i < 0) return;
    if (me.ws) me.ws.room = me.ws.pl = null;
    if (again) return void players.splice(i, 1);
    if (!LEGACY) {
      if (over) { players.splice(i, 1); return close('norematch'); }            // walked away from the vote
      if (hold) { players.splice(i, 1); return close('empty'); }                // the other seat is only being held: nobody is left
      if (dropped && humans().length === 1 && spectators.size) return startHold(me);   // a reload or a wifi blip in a bot court with people watching: the court and the score survived it anyway, the stands emptied ('Court closed' at once). Held like any seat; 'leave' stays immediate
      if (humans().length === 2 && started) {                     // two humans, mid-match (before a ball is struck a leaver just leaves)
        if (dropped) return startHold(me);                        // wifi: the seat is held
        const nm = names(); players.splice(i, 1); console.log(`[${code}] side ${me.side} left mid-match: forfeit`);
        return endMatch(1 - me.side, true, nm);                   // 'leave': forfeit at once
      }
    }
    players.splice(i, 1);
    if (paused) resume();                                        // the pauser went
    if (over) { over = null; newMatchAt = Infinity; broadcast({ type: 'rematchon' }); }   // LOCAL: no vote to wait for
    removeBot(); ball.live = false; ball.serving = null; serveAt = Infinity;
    botJoinAt = AUTOBOT && humans().length === 1 ? now + 2.5 : Infinity;   // whoever is left gets the bot back
    broadcast({ type: 'left' }); tellNames();
    if (!humans().length) sendOff();
    room.waitAt = room.idleAt = Date.now();                      // idleAt only counts while nobody is here, waitAt while one is
    if (pub) lobbyChanged();
    console.log(`[${code}] side ${me.side} left (${players.length} connected)`);
  }

  // My serve and I swung (power >= SERVE_POWER decides below). A wind-up is a swing too, and the first report of any swing is a bet, so nothing is
  // struck on a bet: c = { sw, of: whose swing, born, at: when its hold runs out, final: settled?, after: the settled swing already held, prev*: the swing before }.
  function serveStrike(me, c) { me.servePending = null; if (serveReach(me)) { ball.serving = null; strike(me, c.sw); } }   // swung at air: no whiff, no point, the ball keeps hanging
  function serveDecide(me, c) {                                  // c has settled: is it the stroke?
    const a = c.after, pw = c.sw.power, d = c.sw.dir;
    if (a) { if (pw >= 0.9 * a.sw.power || d * a.sw.dir < 0) serveStrike(me, c); else me.servePending = a; return; }   // after a held swing: as strong, or the other way = the stroke, struck with THIS one, now. Weaker the same way changes nothing
    if (pw >= SERVE_SURE || c.born - c.prevAt < SERVE_PREV && (pw >= 0.9 * c.pvPow || d * c.pvDir < 0)) serveStrike(me, c);   // no wind-up is this hard; or the swing just before was the wind-up (any twitch used to count: now this one has to beat it)
  }                                                              // else: held until c.at in case it was a wind-up (step() strikes with it when nothing better came)
  function serveSwing(me, fix, power, sw, final) {
    const pend = me.servePending, own = fix && pend && pend.of === me.swAt;     // own: this corrects the very swing that is being held
    if (power < SERVE_POWER) { if (own) me.servePending = pend.after; return; }   // a twitch, a flick, a quick step: nothing happens at all (and a held swing that settles as one is dropped: the bet said 30, the hand did 8)
    if (me.swSaid !== me.swAt) { me.swSaid = me.swAt; broadcast({ type: 'swung', side: me.side }); }   // animates at once, held or not; once per swing
    sw.power = power;
    if (own) { pend.sw = sw; pend.final = final; }
    else me.servePending = { sw, of: me.swAt, born: now, at: now + SERVE_HOLD, final, after: pend ? (pend.final ? pend : pend.after) : null, prevAt: me.swPrev, pvPow: me.pvPow, pvDir: me.pvDir };
    if (final) serveDecide(me, me.servePending);
  }

  function onMessage(me, m) {
    if (m.type === 'pause') return pause(me, m.on);
    if (m.type === 'rematch') return vote(me, m.yes);
    if (m.type === 'name') { me.name = cleanName(m.name) || (me.side ? 'Player 2' : 'Player 1'); return tellNames(); }   // changed in the settings panel
    if (m.type === 'bot') return botRequest(me, m.level);
    if (m.type === 'status') { if (typeof m.cal === 'boolean') me.cal = m.cal; return; }   // calibrating again (C): the NEXT serve waits, a rally in flight plays on. Booleans only
    if (paused || hold) return;                                  // room time stands still: no paddle, no swing
    if (m.type === 'paddle') {
      me.ready = true; me.cal = false;                           // a paddle is only ever sent by a calibrated client
      me.auto = !!m.auto;                                        // auto: the server runs you to the ball, you just swing
      me.autoY = !!m.autoY;
      me.ownZ = Number.isFinite(m.z) ? clamp(m.z, Z_NEAR, Z_FAR + 0.4) : null;   // camera depth: distance from the net, chosen by the player                                      // autoY: you move sideways yourself, the game handles paddle height
      if (!me.auto) me.x = clamp(num(m.x, me.x), -X_LIMIT, X_LIMIT);
      if (!me.auto && !me.autoY) me.y = clamp(num(m.y, me.y), Y_MIN, Y_MAX);
      if (Array.isArray(m.q) && m.q.length === 4 && m.q.every(Number.isFinite)) me.q = m.q;
    } else if (m.type === 'swing') {
      let pw = clamp((num(m.power, 6) - 6) / 28, 0, 1);
      // an overhead is a smash: the paddle comes DOWN through the ball. But it has to be a real stroke first, and the
      // bonus adds to it (it used to lift ANY downward swing over 13 rad/s to full smash pace: 4 of 23 recorded smashes).
      if (clamp(num(m.chop, 0), 0, 1) > 0.45 && pw > 0.55) pw = Math.min(1, pw + 0.2);
      // final: the settled report (web/motion.js sends one for every swing; a client from before that sends no such field and is taken at its word).
      // A bet never smashes: 38 of 140 recorded swings were FIRST called at smash pace, 14 settled there, 12 settled as taps, and the label, ring, flash, shake and flame went out on the bet.
      const final = m.final !== false; if (!final) pw = Math.min(pw, SMASH);
      const dir = clamp(num(m.dir, 0), -1, 1), lob = clamp(num(m.lob, 0), 0, 1), slice = clamp(num(m.slice, 0), -1, 1);   // signed spin, 0 when the client sends none
      if (!m.fix) { me.swPrev = me.swAt; me.pvPow = me.swPow; me.pvDir = me.swDir; me.swAt = now; }        // EVERY swing, twitches too: what came just before tells a serve's stroke from its wind-up
      me.swPow = num(m.power, 6); me.swDir = dir;                // its latest report: settled by the time the next swing asks
      if (ball.live && ball.serving === me.side) return serveSwing(me, !!m.fix, me.swPow, { n: Math.max(pw, SERVE_FLOOR), dir, lob, slice, floor: SERVE_FLOOR }, final);   // my serve: only a real stroke that meets the ball counts
      if (m.fix) {                                               // clients report a swing early, on a predicted peak; this is the real one
        if (!me.swing && me.hit) pw = Math.max(pw, me.hit.floor);                              // correcting a serve: it keeps the serve floor
        if (me.swing) Object.assign(me.swing, { n: pw, dir, lob, slice });                     // hasn't met the ball yet: just correct it
        else if (me.hit && now - me.hit.at < FIX_WINDOW && ball.live && ball.lastHit === me.side && !ball.bounces && ball.p[2] * sgn(me.side) > 1
          && (Math.abs(pw - me.hit.n) > 0.04 || (pw > SMASH) !== (me.hit.n > SMASH) || Math.abs(dir - me.hit.dir) > 0.1 || Math.abs(lob - me.hit.lob) > 0.1 || Math.abs(sliced(slice, lob) - sliced(me.hit.slice, me.hit.lob)) > 0.2 || (slice < 0) !== (me.hit.slice < 0) && sliced(slice, lob) > 0.3)) {
          const kind = shotKind(pw, lob, slice), changed = kind !== me.hit.kind;
          Object.assign(me.hit, { n: pw, dir, lob, slice, kind }); reaim(me.side, pw, dir, lob, slice, changed ? kind : undefined);   // struck a moment ago on the early guess: bend it onto the real shot while it is still on my side
        }
        return;
      }
      me.swing = { until: now + SWING_WINDOW + (1 - pw) * 0.28,   // gentle swings are long, unhurried motions: give them a longer window
        from: now - clamp((num(m.age, 0) + clamp(num(m.net, 0), 0, 250)) / 1000, 0, LAG_MAX),   // lag compensation: the hand started moving `age` ms ago (sensor + Bluetooth lateness), and `net` = the round trip: the player saw the ball half a trip ago and the swing took the other half to get here
        n: pw,                                                     // 6 = a tap, ~17 = backhand, 30 = solid forehand, 34+ = smash
        dir, lob, slice, why: null, best: Infinity };
      broadcast({ type: 'swung', side: me.side });
      tryHit(me);                                                // ball already there: struck NOW, not on the next tick
    }
  }

  function step() {
    const ms = Date.now();                                       // the three countdowns that run while room time may not
    if (hold) { if (ms >= hold.until) forfeitHeld(); else sayHold(); }
    if (paused && ms >= paused.until) resume();
    if (over && !LEGACY && ms >= over.until) return close('norematch');
    slowSeat(ms);
    const frozen = !!(paused || hold);
    if (!frozen) { now += DT; if (players.length) sim(); }       // an empty room costs nothing while it waits to be joined or closed
    if (!players.length) return;
    const paddles = [null, null];
    for (const pl of players) paddles[pl.side] = { x: pl.x, y: pl.y, z: pl.z, q: pl.q, bot: pl.bot, wait: ready(pl) ? undefined : true, status: statusOf(pl) || undefined };   // wait: still calibrating. status: 'calibrating' | 'paused' | 'away' (both only sent while set)
    const srv = ball.live && ball.serving != null && bySide(ball.serving);
    const packet = JSON.stringify({ type: 'state', t: now, p: ball.p, v: ball.v, spin: ball.spin, b: ball.bounces, k: ball.kick, live: ball.live, serving: ball.serving, reach: srv ? serveReach(srv) : false, score, paddles,
      watchers: spectators.size, paused: frozen || undefined });   // reach: the server could serve it right now. paused (only sent while true): t stands still, by a pause or a held seat; late joiners see it too
    tick++;
    for (const pl of players) if (pl.ws) stateTo(pl.ws, packet);
    for (const ws of spectators) stateTo(ws, packet);             // same rate, same guard as a player
  }
  function stateTo(ws, packet) {
    if (ws.readyState !== 1) return;
    if (ws.every > 1 && tick % ws.every) return;                 // asked for fewer packets (see 'net'): fewer to lose, and every loss stalls a TCP stream
    if (ws.bufferedAmount > 8192) { if (ws.bufferedAmount > BUF_MAX) ws.terminate(); return; }   // link stalled: state is disposable, stale copies must not pile up behind the blockage (and a socket that reads nothing at all goes)
    ws.send(packet);
  }

  function sim() {
    if (now >= botJoinAt) { botJoinAt = Infinity; addBot(); }
    if (now >= newMatchAt) { newMatchAt = Infinity; over = null; broadcast({ type: 'rematchon' }); if (players.length === 2) startMatch(1 - firstServe); }   // LOCAL only
    if (!ball.live && now >= serveAt && players.every(ready)) { serveAt = Infinity; if (players.length === 2) reset(server); }   // the serve waits for a human who is still calibrating

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
        let c = pl.servePending;
        if (c && !c.final && now >= c.born + SERVE_WAIT) { c.final = true; serveDecide(pl, c); c = pl.servePending; }   // its settled report never came (an old client sends none): taken as it stands
        if (c && c.final && now >= c.at) serveStrike(pl, c);     // held in case it was a wind-up; nothing better followed (a bet that came meanwhile is heard out first: strokes follow 0.4-0.9 s after the wind-up, right where the hold ends)
        if (ball.serving != null && now >= ball.serveBy) {
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
  }
  // what the lobby list says about this room (public rooms only get asked). open: a human seat is free. watch: spectator places left
  const free = () => humans().length < 2 && !hold && !(over && over.forfeit);   // a seat to sit down in. Not after a forfeit: that room only waits to close. Not while a seat is held (a bot court's too)
  const info = () => ({ code, players: humans().length, open: free(), watch: SPEC_CAP - spectators.size, watchers: spectators.size, score: [...score], live: started && !over });
  const room = { code, pub, join, leave, retake, heldBy, watch, unwatch, canWatch: () => spectators.size < SPEC_CAP, free, close, info, onMessage, step, humans, time: () => now, idleAt: Date.now(), waitAt: 0, dead: false };
  return room;
}

// ---------- lobby: which room does a socket sit in? ----------
const LOCAL = createRoom('LOCAL', false);                      // every socket without lobby=1 (tests, ?skiptitle=1, old clients): never listed, never deleted
const rooms = new Map(), lobby = new Set();                    // code -> room (LOCAL is not in it, so no code can reach it); sockets that have not chosen yet
const tell = (ws, msg) => put(ws, JSON.stringify(msg));
const lobbyMsg = () => JSON.stringify({ type: 'lobby', online: wss.clients.size,                 // every public room somebody is in: to join while a seat is free, to watch otherwise
  rooms: [...rooms.values()].filter(r => r.pub && r.humans().length).map(r => r.info()) });
// a socket goes from wherever it sits: a seat (dropped = its socket closed by itself: mid-match that seat is held) or a spectator place
const quit = (ws, dropped) => { const r = ws.room; if (!r) return; if (ws.pl) r.leave(ws.pl, false, !!dropped); else r.unwatch(ws); };
// The list goes to everyone choosing, at once if it has been quiet for a second, otherwise when that second is up.
let lobbySent = 0, lobbyTimer = null, lobbyLast = '';
function lobbyChanged() {
  if (lobbyTimer) return;
  lobbyTimer = setTimeout(() => {
    lobbyTimer = null; lobbySent = Date.now();
    const s = lobbyMsg(); if (s === lobbyLast) return; lobbyLast = s;     // came and went within the second: nothing to say
    for (const ws of lobby) if (ws.lobbySeen !== s) put(ws, ws.lobbySeen = s);   // whoever just walked in already has this one
  }, Math.max(0, lobbySent + 1000 - Date.now()));
}
function enterLobby(ws) { lobby.add(ws); put(ws, ws.lobbySeen = lobbyMsg()); lobbyChanged(); }   // its own copy now; the rest hear within the second (online went up)

// false = both seats are taken by other humans
function seat(ws, r) {
  // Bad wifi: the tab reconnects while its old socket is still half-open. That old seat is the SAME player, so it goes
  // now, whatever else is true. Otherwise you would be matched against your own ghost until the heartbeat clears it.
  // In this room that is a takeover; in another room it is that player leaving (they cannot sit in two).
  // A takeover keeps the seat itself (name, score, the match). So does coming back to a seat that is being held for this cid.
  let mine = r.heldBy(ws.cid);
  if (ws.cid) for (const o of wss.clients) if (o !== ws && o.cid === ws.cid && o.room) {
    if (o.room === r && o.pl && !mine) { mine = o.pl; o.room = o.pl = null; } else quit(o);
    o.terminate();
  }
  if (mine) { lobby.delete(ws); if (ws.viaLobby) tell(ws, { type: 'room', code: r.code, public: r.pub, role: 'player' }); r.retake(mine, ws); lobbyChanged(); return true; }
  if (r === LOCAL && AUTOBOT && r.humans().length >= 2) {      // legacy only: a reload / stale tab from the same machine takes over its old seat
    const ghost = r.humans().find(p => p.ws.addr === ws.addr);   // (in a real room two players behind one router are two players)
    if (ghost) { const g = ghost.ws; r.leave(ghost, true); g.close(); }
  }
  if (!r.free()) return false;
  lobby.delete(ws);
  if (ws.viaLobby) tell(ws, { type: 'room', code: r.code, public: r.pub, role: 'player' });
  r.join(ws); lobbyChanged(); return true;
}
const loopback = a => !a || a === '::1' || a.endsWith('127.0.0.1');   // this machine (its own player, every test): no address limit. Hosted, every socket carries fly-client-ip
function create(ws, pub) {
  let mine = 0; if (!loopback(ws.addr)) for (const r of rooms.values()) if (r.by === ws.addr) mine++;
  if (rooms.size >= ROOM_CAP || mine >= ADDR_ROOMS) return tell(ws, { type: 'joinfail', reason: 'busy' });
  let code; do { code = ''; for (let i = 0; i < 4; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]; } while (rooms.has(code));
  const r = createRoom(code, pub); r.by = ws.addr; rooms.set(code, r); seat(ws, r);
}
const roomOf = code => (typeof code === 'string' ? rooms.get(code.trim().toUpperCase().slice(0, 8)) : null) || null;   // strings only: String() of a deeply nested array overflows the stack
function joinCode(ws, code) {
  const r = roomOf(code);
  if (!r) tell(ws, { type: 'joinfail', reason: 'notfound' }); else if (!seat(ws, r)) tell(ws, { type: 'joinfail', reason: 'full', watch: r.canWatch(), code: r.code });   // "Court is full. Watch instead?"
}
// Watch a room (any room whose code you have; a free seat in it does not matter, you chose to watch).
function watchCode(ws, code) {
  const r = roomOf(code); if (!r) return tell(ws, { type: 'joinfail', reason: 'notfound' });
  if (ws.cid) for (const o of wss.clients) if (o !== ws && o.cid === ws.cid && o.room) { quit(o); o.terminate(); }   // this tab's own ghost first (a spectator reconnecting is a spectator again, not a second one)
  if (r.dead) return tell(ws, { type: 'joinfail', reason: 'notfound' });                                           // (that ghost was the last one in it)
  if (!r.canWatch()) return tell(ws, { type: 'joinfail', reason: 'busy', code: r.code });
  lobby.delete(ws); tell(ws, { type: 'room', code: r.code, public: r.pub, role: 'spectator' }); r.watch(ws);
}
// the public room whose one human has waited longest; a public room nobody is in yet will do; otherwise a new one
function quick(ws) {
  let best = null;
  for (const r of rooms.values()) { const n = r.humans().length;
    if (r.pub && r.free() && (!best || n > best.n || n === best.n && r.waitAt < best.r.waitAt)) best = { r, n }; }
  if (!best || !seat(ws, best.r)) create(ws, true);
}

wss.on('connection', (ws, req) => {
  ws.on('error', () => {});                                    // a bad frame must not take the process down
  ws.alive = true; ws.on('pong', () => { ws.alive = true; });
  const hdr = req && req.headers || {};                        // hosted: every socket comes from the proxy, the real address is in a header
  ws.addr = hdr['fly-client-ip'] || ws._socket && ws._socket.remoteAddress;
  let q; try { q = new URL(req.url, 'http://x').searchParams; } catch { q = new URLSearchParams(); }
  ws.cid = q.get('cid') || null; ws.room = ws.pl = null; ws.spec = false; ws.viaLobby = q.get('lobby') === '1';
  ws.name = cleanName(q.get('name'));                          // names a seat taken by URL (room=CODE); otherwise it rides on the seat request

  ws.msgN = 0; ws.msgT = 0;
  ws.on('message', raw => { try {                              // one process hosts every room: no message, however malformed, may throw out of here
    const ms = Date.now(); if (ms - ws.msgT >= 1000) { ws.msgT = ms; ws.msgN = 0; }      // a budget per socket per second, spent before the message is even parsed
    if (++ws.msgN > MSG_DROP) { if (ws.msgN > MSG_KILL) ws.terminate(); return; }
    const m = JSON.parse(raw);
    if (!m || typeof m !== 'object') return;
    if (m.type === 'ping') return tell(ws, { type: 'pong', c: Number.isFinite(m.c) ? m.c : 0, t: ws.room ? ws.room.time() : clock });   // the client times the round trip itself (in the lobby too). c is echoed only as a number
    if (m.type === 'net') return void (ws.every = num(m.hz, 60) <= 30 ? 2 : 1);   // a struggling link asks for half the state packets; it is the link's, so it follows the socket from room to room
    if (typeof m.name === 'string') ws.name = cleanName(m.name);   // rides on quick / create / join / watch / name. Strings only, like every other field
    if (ws.room) {
      if (m.type === 'leave' && ws.viaLobby) { quit(ws); enterLobby(ws); }
      else if (ws.pl) ws.room.onMessage(ws.pl, m);               // a spectator is heard saying ping, net, leave (and its name, shown nowhere): nothing else
    } else if (lobby.has(ws)) {
      if (m.type === 'quick') quick(ws); else if (m.type === 'create') create(ws, m.public === true); else if (m.type === 'join') joinCode(ws, m.code); else if (m.type === 'watch') watchCode(ws, m.code);
    }
  } catch (err) { if (!(err instanceof SyntaxError)) console.error('bad message:', err.message); } });
  ws.on('close', () => { quit(ws, true); lobby.delete(ws); lobbyChanged(); });

  if (!ws.viaLobby) { if (!seat(ws, LOCAL)) { ws.send(JSON.stringify({ type: 'full' })); ws.close(); } return; }
  enterLobby(ws);
  if (q.get('room')) (q.get('watch') === '1' ? watchCode : joinCode)(ws, q.get('room'));   // a reconnect getting its seat (or its place to watch) back, or a shared link
});

// fixed 60Hz steps against the real clock (setInterval alone runs ~2% slow and drifts). Every room steps on every one. One state packet per room per step.
let last = process.hrtime.bigint(), acc = 0;
setInterval(() => {
  const t = process.hrtime.bigint(); acc += Number(t - last) / 1e9 * SCALE; last = t;
  let k = 0;
  while (acc >= DT && k++ < 4) { acc -= DT; clock += DT; LOCAL.step(); for (const r of rooms.values()) r.step(); }
  if (k) { const ms = Date.now();                               // a room nobody has been in for ROOM_TTL goes (its code may be reused); whoever was watching the empty court goes back to the lobby
    for (const r of rooms.values()) if (ms - r.idleAt > ROOM_TTL && !r.humans().length) r.close('empty'); }
  if (acc >= DT) acc = 0;                                       // stalled: drop the backlog rather than fast-forward
}, Math.max(1, Math.floor(4 / SCALE)));

// half-open sockets never fire 'close' and would hold a seat forever ("nobody can join"): ping them out
setInterval(() => {
  for (const ws of wss.clients) { if (!ws.alive) { ws.terminate(); continue; } ws.alive = false; ws.ping(); }
}, HEARTBEAT);

console.log('game server on port ' + (+process.env.PORT || 8080));
module.exports = { COURT, ZONE, BOUNCE, SLICE, G, R, PASSED, solve, shotKind, bounceV, gOf };   // test/server.test.mjs sweeps solve() directly