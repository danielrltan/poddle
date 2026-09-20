// Glue: AirPod bridge -> MotionModel -> scene + game server.
import { MotionModel, qrot } from './motion.js';
import { createScene } from './scene.js';
import { createPodView } from './podview.js';
import { createBodyTracker } from './bodytrack.js';
import * as ui from './ui.js';                  // every HUD / screen DOM change goes through here

const $ = id => document.getElementById(id);
const qs = new URLSearchParams(location.search);
const HOST = qs.get('host') || location.hash.slice(1) || 'localhost';      // player 2:  /#<server-ip>
const BRIDGE = `ws://localhost:${qs.get('bridge') || 8787}`;
const HOSTED = HOST === 'localhost' && !['localhost', '127.0.0.1', ''].includes(location.hostname);      // page came from the game server itself (fly.io)
const GAME = HOSTED ? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}` : `ws://${HOST}:${qs.get('game') || 8080}`;
const AUTOBOT = qs.get('autobot') === '1';
const LOBBY = qs.get('skiptitle') !== '1';                       // ?skiptitle=1 is the legacy path: no lobby, the server seats the socket in room LOCAL at once (docs/ROOMS.md)
// One id per tab, kept across reloads and reconnects: the server gives a returning tab its seat back instead of seating
// it against its own half-dead socket (bad wifi drops connections without telling the server).
let CID = ''; try { CID = sessionStorage.getItem('cid') || ''; if (!CID) sessionStorage.setItem('cid', CID = Math.random().toString(36).slice(2, 12)); } catch { CID = Math.random().toString(36).slice(2, 12); }

const model = new MotionModel();
const scene = createScene($('stage'));
const pod = createPodView($('pod'));
ui.setServerAddress(GAME);
if (HOSTED) { $('down-lan').hidden = true; $('down-net').hidden = false; }      // online, 'start the server on this Mac' is no help: it is the player's own connection
const stats = window.__stats = { get cam() { return body ? { ready: body.ready, error: body.error, seen: body.seen(), fps: Math.round(body.fps), via: body.via } : null; }, hits: 0, myHits: 0, whiffs: 0, swings: 0, errors: 0, paddlePath: 0, calibrated: false, events: {} };

let side = 0, state = null, players = 0, calibrating = true;
// Flow: title -> lobby (pick a room) -> connect (only while there is no AirPod data) -> calibrate -> play. ?skiptitle=1 starts at connect.
let phase = 'title', lastSample = -1e9, gameEver = false;
let room = null, wantRoom = LOBBY ? ui.cleanCode(qs.get('room')) : '', pending = null, leaveAt = 0;   // room: seated here. wantRoom: from a shared link (or a reload). pending: the lobby request still waiting for its answer
const link = { m: false, g: false }, airpodLive = () => performance.now() - lastSample < 1000;
const inPlay = () => phase === 'play' && !ui.currentScreen() && !ui.currentOverlay();      // the court is what the player is looking at
if (qs.get('uitest') === '1') window.__ui = ui;                 // test hook: lets test/e2e.mjs force UI states for screenshots
// body: webcam tracks where you actually stand. auto: server runs you to the ball. aim: wrist angle moves you.
const MODES = ['body', 'auto', 'aim'], MODE_TEXT = { body: 'Body: step to move, tilt the AirPod to walk', auto: 'Auto: the game runs, you swing', aim: 'Aim: turn your wrist to move' }, MODE_NAME = { body: 'Body', auto: 'Auto', aim: 'Aim' };
let sideDeg = 75, bodyZ = 6.5, walkV = 0, walkHold = 0, bodyY = 1.0, vX = 0, vY = 0, lastFrame = performance.now();
// critically damped follow (frame-rate independent): smooth, no overshoot
function damp(cur, target, vel, smooth, dt) { const o = 2 / smooth, x = o * dt, e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x), ch = cur - target, tmp = (vel + o * ch) * dt; return [target + (ch + tmp) * e, (vel - o * tmp) * e]; }
let mode = MODES.includes(qs.get('move')) ? qs.get('move') : 'body', body = null, bodyX = 0;
if (qs.get('cam') !== '0') createBodyTracker($('camv'), $('camc')).then(t => {
  body = t; ui.setCamera(t.ready);
  if (!t.ready) { console.warn('camera tracking unavailable:', t.error); if (mode === 'body') setMode('aim', !inPlay()); }       // quiet on the set-up screens: nobody asked yet
});
function setMode(m, quiet) { mode = m; ui.setMode(MODE_NAME[m]); if (!quiet) say(MODE_TEXT[m], null, 2400); }
const usingBody = () => mode === 'body' && body && body.ready;
const autoNow = () => mode === 'auto' || (mode === 'body' && !(body && body.seen()));   // lost your face: the game runs for you until it's back
const s = () => (side === 0 ? 1 : -1);

// ---------- messages ----------
const say = (text, _color, ms = 1200) => ui.toast(text, ms);   // small pill toast
let rally = 0;
let oppName = 'Opponent';
const alone = () => ({ them: 'Waiting', themSub: room ? '' : 'B adds a bot', meSub: '' });      // the far side of the scoreboard with nobody on it. In a room the bot walks in by itself
const clearFar = () => { rally = 0; ui.setRally(0); scene.updatePaddle(1 - side, null); scene.hideBall(); };      // nobody over there any more: no avatar, no ball, no rally

// My serve: the ball hangs and follows late. One quiet nudge per serve, from the server's reach hint, never in reply to a swing.
let svT = 0, svFar = 0, svSaid = true;
function serveCoach(m) {
  const t = performance.now();
  if (m.serving !== side || calibrating) { svT = 0; return; }
  if (!svT) { svT = t; svFar = 0; svSaid = false; }
  svFar = m.reach ? 0 : svFar || t;
  if (svSaid) return;
  if (svFar && t - svFar > 1500 && t - svT > 2800) { svSaid = true; say('Line up with the ball, then swing', null, 2200); }
  else if (m.reach && t - svT > 4500) { svSaid = true; say('Swing through the ball to serve', null, 2200); }
}

// ---------- peak logger ----------
let peaks = [], sessionPeak = 0, log10 = [];
function logSwing(e) {
  const pk = e.peak, tag = `${e.counted ? pk.toFixed(0) : '×'} (${e.rom.toFixed(0)}°)`;
  log10.push(tag); if (log10.length > 5) log10.shift();
  ui.setStat('pklist', log10.join(' · '));
  console.log(`swing power=${pk.toFixed(1)} raw=${e.raw.toFixed(1)} rad/s rom=${e.rom.toFixed(0)}deg counted=${e.counted}`);
  if (!e.counted) return;
  peaks.push(pk); sessionPeak = Math.max(sessionPeak, pk);
  ui.setStat('sw', peaks.length); ui.setStat('pkmax', sessionPeak.toFixed(1));
  ui.setStat('pkavg', (peaks.reduce((a, b) => a + b, 0) / peaks.length).toFixed(1));
}
function resetPeaks() { peaks = []; log10 = []; sessionPeak = 0; ui.setStat('sw', 0); ui.setStat('pkmax', '0.0'); ui.setStat('pkavg', '-'); ui.setStat('pklist', '-'); }

// ---------- screens: title -> connect -> calibrate -> play ----------
function showCal(e) { if (phase === 'calibrate') ui.calibration(e, { camLost: !!(body && body.ready && !body.seen()) }); }
function startCal() { calibrating = true; stats.calibrated = false; model.startCalibration(); phase = 'calibrate'; ui.calibrationReset(); ui.showScreen('calibrate'); }
function play() {                                  // leave the title for the lobby. A shared link (?room=CODE) joins at once.
  if (phase !== 'title') return;
  phase = 'lobby'; ui.showScreen('lobby');
  if (wantRoom.length === 4) { ui.lobbyView('code', { code: wantRoom }); request({ type: 'join', code: wantRoom }); } else ui.lobbyView('home');
}
function begin() {                                 // seated: straight to calibration if the AirPod is already streaming, straight to the court if that is done too
  phase = 'connect';
  if (stats.calibrated && airpodLive()) { phase = 'play'; ui.showScreen(null); } else if (airpodLive()) startCal(); else ui.showScreen('connect');
}
let pendT = 0;
function settle() { pending = null; clearTimeout(pendT); ui.lobbyBusy(false); }
function request(m) {                               // one lobby request at a time. Not connected right now: it goes out when the socket opens
  if (pending) return; pending = m; ui.lobbyBusy(true); game.send(m);
  pendT = setTimeout(() => { if (pending !== m) return; settle(); if (link.g) say('No answer. Try again.', null, 2600); }, 5000);      // an old server never answers: do not leave the lobby dimmed for good
}
function setUrl(code) { const u = new URL(location.href); if (code) u.searchParams.set('room', code); else u.searchParams.delete('room'); history.replaceState(null, '', u); }   // the address bar is the invite, and a reload comes back to the same room
const shareLink = code => ['localhost', '127.0.0.1', ''].includes(location.hostname) ? '' : `${location.origin}${location.pathname}?room=${code}`;      // a localhost link is no use to a friend
function toLobby(msg) {                            // out of a room, back to the three choices. Calibration is kept.
  room = null; wantRoom = ''; state = null; clearFar(); phase = 'lobby'; setUrl(null); settle();
  ui.setRoom(null); ui.showOverlay(null); ui.showScreen('lobby'); ui.lobbyView('home');
  ui.setScore(0, 0); ui.setServe(null); ui.setNames(alone());
  if (msg) say(msg, null, 2600); else ui.toastOff();                                // 'Press Q again to leave' has been answered
}
function back() {                                  // Back button / Esc, wherever it is
  if (!LOBBY) return;
  if (phase === 'lobby') { const v = ui.lobbyView(); if (room) { game.send({ type: 'leave' }); toLobby(); } else if (v !== 'home') ui.lobbyView('home'); else { phase = 'title'; ui.showScreen('title'); } }
  else if (phase === 'connect' || phase === 'calibrate') { game.send({ type: 'leave' }); toLobby(); }
}
function refreshStatus() {
  const setup = phase === 'title' || phase === 'lobby' || phase === 'connect';
  ui.setStatus({ airpod: airpodLive() ? 'ok' : setup ? 'wait' : 'bad', game: link.g ? 'ok' : setup && !gameEver ? 'wait' : 'bad',
    camera: qs.get('cam') === '0' ? 'off' : !body ? 'wait' : body.ready ? 'ok' : 'off' });
  if (phase === 'calibrate' && !airpodLive()) ui.calibrationReset();      // stream dropped mid-calibration: say so
  if (LOBBY) ui.lobbyLink(link.g || !gameEver && performance.now() < 2500);       // the lobby sits above the 'server down' card, so it says so itself (not in the first moments of a page load)
}
if (!LOBBY) { phase = 'connect'; ui.showScreen('connect'); } else { ui.titleRoom(wantRoom.length === 4 ? wantRoom : ''); ui.showScreen('title'); }
refreshStatus(); setInterval(refreshStatus, 250);

// ---------- sockets (auto-reconnect) ----------
// urls: tried in turn until one opens. A stale '#<old-ip>' in the address bar must never strand you: this machine's
// own server is always the second candidate, and when it wins the dead address is dropped from the URL.
function connect(urls, el, onmsg, onopen) {
  urls = [].concat(urls); let ws, delay = 400, i = 0, fails = 0;
  const open = () => {
    const url = urls[i % urls.length]; let opened = false;
    ws = new WebSocket(el === 'g' ? url + '?cid=' + CID + (LOBBY ? '&lobby=1' + (room ? '&room=' + room : '') : '') : url);      // room: a reconnect asks for its seat back
    const sock = ws, giveUp = setTimeout(() => { if (!opened) sock.close(); }, 1500);       // a dead IP just hangs: don't wait for TCP to time out
    ws.onopen = () => { opened = true; clearTimeout(giveUp); delay = 400; fails = 0; link[el] = true; ui.setLink(el, true);
      if (el === 'g') { gameEver = true; if (ui.currentOverlay() === 'server-down') ui.showOverlay(null); if (i % urls.length > 0 && location.hash) { history.replaceState(null, '', location.pathname + location.search); say('Saved address didn’t answer. Using this Mac.', null, 2800); } }
      onopen && onopen(); };
    ws.onmessage = e => { try { onmsg(JSON.parse(e.data)); } catch (err) { stats.errors++; console.error(err); } };
    ws.onclose = () => { link[el] = false; ui.setLink(el, false);
      if (!opened) { i++; fails++; }                                   // never connected: try the next candidate
      if (el === 'g' && fails >= urls.length) { ui.setServerAddress(urls.join('  or  ')); if (ui.currentOverlay() !== 'game-full') ui.showOverlay('server-down'); }
      setTimeout(open, opened ? 300 : delay); delay = Math.min(delay * 1.5, 3000); };
    ws.onerror = () => {};
  };
  open();
  return { send: m => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); } };
}

const bridge = connect(BRIDGE, 'm', sample => {
  const power = Math.hypot(sample.r[0], sample.r[1], sample.r[2]);
  lastSample = performance.now();
  ui.setStat('pw', power.toFixed(1));
  if (phase === 'title') { if (power > 12) play(); return; }         // a swing presses Play. The model is not fed until calibration
  if (phase === 'lobby') return;
  if (phase === 'connect') startCal();                              //  begins, so a bud lying on the desk cannot calibrate itself.
  for (const e of model.feed(sample, performance.now())) {
    if (e.type === 'cal') showCal(e);
    else if (e.type === 'calibrated') { calibrating = false; stats.calibrated = true; phase = 'play'; if (body) body.center();
      // 'All set' arrives in this same batch: hold the green card long enough to be read, then open the court
      setTimeout(() => { if (phase !== 'play') return; ui.showScreen(null);
        setTimeout(() => { if (inPlay() && state && state.serving === side) say('Your serve. Swing to hit it.', null, 2600); }, 380); }, 900); }     // after the fade
    else if (e.type === 'swing' || e.type === 'swingFix') { const fix = e.type === 'swingFix'; if (!fix) stats.swings++;     // swings are reported early; a fix follows if the real peak differs
      if (!calibrating) {
                // Spin comes from any of three things, whichever is strongest: the paddle held level (a slice), the wrist
        // rolling through the ball, or a curved "C" shaped swing. Its sign says which way the ball breaks off the bounce.
        // (How level the paddle is held is NOT used: this player rests the bud flat in the hand, so it read "level"
        // nearly all the time and made every shot a slice.) Thresholds sit above what plain swings do in real play:
        // the rotation axis of an ordinary swing wanders ~0.4 rad (p75 ~1.1) and rolls ~0.2 (p75 ~0.5).
        const roll = Math.max(0, Math.min(1, (Math.abs(e.roll || 0) - 0.6) / 0.3)), curve = Math.max(0, Math.min(1, ((e.turn || 0) - 1.2) / 1.0));
        const amount = Math.max(roll, curve), way = curve >= roll && Math.abs(e.curl || 0) > 0.05 ? Math.sign(e.curl) : Math.abs(e.roll || 0) > 0.1 ? -Math.sign(e.roll) : Math.sign(e.dir || 1);
        const slice = amount * (way || 1);
        game.send({ type: 'swing', power: e.power, dir: e.dir, lob: e.lob, chop: e.chop, age: e.age, net: net.lag(), slice, fix });
        if (!fix) scene.onEvent({ type: 'swung', side });            // whoosh now; the server's echo is de-duplicated
      } }
    else if (e.type === 'swingEnd') logSwing(e);
  }
});

const game = connect(HOST === 'localhost' ? GAME : [GAME, `ws://localhost:${qs.get('game') || 8080}`], 'g', m => {
  stats.events[m.type] = (stats.events[m.type] || 0) + 1;
  if (!LOBBY && ['lobby', 'room', 'joinfail', 'left'].includes(m.type)) return;          // legacy path: no room UI, whatever the server says
  if (m.type === 'lobby') { ui.lobbyRooms(m.rooms, m.online); return; }
  if (m.type === 'room') {                                       // seated (the normal 'welcome' follows). Also the answer to a reconnect with room=CODE.
    const made = pending && pending.type === 'create', again = room === m.code; settle(); room = m.code; wantRoom = '';
    ui.setRoom(room, shareLink(room)); setUrl(room);
    if (phase === 'lobby' && !again) { if (made) ui.lobbyView('share'); else begin(); }        // again: a reconnect got the seat back, the player stays where they were
    return;
  }
  if (m.type === 'joinfail') {
    const was = pending; settle(); wantRoom = '';
    if (room) { toLobby('Room closed'); return; }                                            // a reconnect found the room gone
    const text = { notfound: 'Room not found', full: 'Room is full', busy: 'No free rooms. Try again soon.' }[m.reason] || 'Couldn’t join';
    setUrl(null); if (was && was.type === 'join' && ui.lobbyView() === 'code') ui.codeError(text); else say(text, null, 2600);
    return;
  }
  if (m.type === 'left') { clearFar(); ui.setServe(null); if (inPlay()) say('Opponent left', null, 2200); return; }
  if (m.type === 'welcome') {
    side = m.side; if (ui.currentOverlay() === 'game-full') ui.showOverlay(null);
    scene.setCourt(m.court); scene.setSide(side);
    if (AUTOBOT) game.send({ type: 'bot' });
    net.rejoined();
    return;
  }
  if (m.type === 'state') {
    state = m; scene.updateBall(m.p, m.v, m.live, undefined, m.spin, m); net.packet();
    serveCoach(m);
    ui.setScore(m.score[side], m.score[1 - side]);
    const o = m.paddles[1 - side];
    players = o ? 2 : 1; if (!o) ui.setNames(alone()); else if (!o.bot) { oppName = side === 0 ? 'Player 2' : 'Player 1'; ui.setNames({ them: oppName, themSub: o.wait ? 'Setting up' : side === 0 ? 'Far side' : 'Near side', meSub: side === 0 ? 'Near side' : 'Far side' }); }   // wait: they are still calibrating, the server holds the serve
    scene.updatePaddle(1 - side, o ? { x: o.x, y: o.y, z: o.z, q: o.q, offset: null, bot: !!o.bot } : null);
    return;
  }
  if (m.type === 'botinfo') {
    if (m.active) { oppName = m.name + ' Bot'; ui.setNames({ them: oppName, themSub: '', meSub: '' }); }
    if (m.reason) say('Can’t add a bot with two players in', null, 1800); else if (m.active && inPlay()) say(`${m.name} Bot`, null, 1400);
    return;
  }
  if (m.type === 'pong') { net.pong(m); return; }
  if (m.type === 'full') { ui.showOverlay('game-full'); return; }
  if (m.type === 'hit') { stats.hits++; if (m.side === side) stats.myHits++; rally++; ui.setRally(rally); }   // the shot's name only, and only for my own hits
  if (m.type === 'serve') { bodyZ = 6.5; walkV = 0; rally = 0; ui.setRally(0); ui.setServe(m.by === side ? 'me' : 'them'); if (ui.currentOverlay() === 'match') ui.showOverlay(null);
    if (m.wait && m.by === side && inPlay()) say('Your serve. Swing to hit it.', null, 2600); }
  if (m.type === 'match') { const won = m.winner === side; ui.matchResult(won, m.score[side], m.score[1 - side], oppName); ui.setServe(null);
    setTimeout(() => { if (ui.currentOverlay() === 'match') ui.showOverlay(null); }, 6000);        // normally the next 'serve' closes it after 5 s
    if (won) { ui.confetti(['#3aa0ff', '#ffd34a', '#3ecf72', '#ffffff'], 120); setTimeout(() => ui.confetti(['#3aa0ff', '#ffd34a', '#ffffff'], 80), 900); } return; }
  if (m.type === 'whiff') stats.whiffs++;                        // no commentary: you can see that you missed
  if (m.type === 'point' && !m.final) { const won = m.winner === side;
    ui.pointBanner(won);                                         // exactly "Your point!" / "Their point", nothing else
    if (won) ui.confetti(['#3aa0ff', '#ffd34a', '#ffffff']); }
  scene.onEvent(m);
}, () => { if (pending && !room) game.send(pending); });       // the request made while the socket was down

// ---------- link quality ----------
// The ball already rides out gaps by itself (scene.js coast()). This watches the connection so that (1) a swing can be
// back-dated by the round trip, (2) a struggling link gets half the state packets: over TCP every lost packet stalls
// everything behind it, so fewer packets means fewer stalls, and (3) the player is told it is the wifi, not the game.
const net = (() => {
  const rtts = []; let lastPacket = 0, gaps = 0, late = 0, worst = 0, hz = 60, bad = 0, good = 0, told = false;
  const floor = () => rtts.length ? Math.min(...rtts) : 0;
  setInterval(() => game.send({ type: 'ping', c: performance.now() }), 500);
  setInterval(() => {                                                   // judged every 2 s
    const lateShare = gaps ? late / gaps : 0, rtt = rtts.length ? rtts[rtts.length - 1] : 0, poor = link.g && gaps > 10 && (lateShare > 0.04 || worst > 250 || floor() > 140);
    stats.net = { rtt: Math.round(rtt), floor: Math.round(floor()), late: +lateShare.toFixed(3), worst: Math.round(worst), hz };
    ui.setStat('ping', link.g && rtts.length ? Math.round(rtt) + ' ms' : '-'); ui.setStat('netq', !link.g ? 'offline' : poor ? `weak (worst gap ${Math.round(worst)} ms)` : 'good'); ui.setStat('nethz', hz);
    if (poor) { bad++; good = 0; } else { good++; bad = 0; }
    if (bad >= 2 && hz === 60) { hz = 30; game.send({ type: 'net', hz }); if (!told && inPlay()) { told = true; say('Weak connection. Smoothing it out.', null, 2600); } }
    if (good >= 8 && hz === 30) { hz = 60; game.send({ type: 'net', hz }); }
    gaps = late = worst = 0;
  }, 2000);
  return {
    packet() { const t = performance.now(), g = t - lastPacket; lastPacket = t; if (g > 1000) return; gaps++; if (g > worst) worst = g; if (g > 1000 / hz + 45) late++; },
    pong(m) { const r = performance.now() - m.c; if (r >= 0 && r < 5000) { rtts.push(r); if (rtts.length > 12) rtts.shift(); } },
    lag: () => Math.round(floor()),                                     // the quietest recent round trip: queueing spikes are not the link's real delay
    rejoined() { hz = 60; bad = good = 0; rtts.length = 0; },           // a new socket starts at the full rate on the server
  };
})();

setInterval(() => {                               // 20Hz: tell the server where my paddle is
  if (calibrating || (LOBBY && !room)) return;
  const p = model.pose(performance.now());
  if (p.calibrated) game.send({ type: 'paddle', auto: autoNow(), autoY: mode === 'auto', x: (usingBody() ? bodyX : p.x) * s(), y: usingBody() ? bodyY : p.y, z: usingBody() && !autoNow() ? bodyZ : undefined, q: p.Pd });
}, 50);

// ---------- input ----------
let unlocked = false;
const unlock = () => { if (!unlocked) { unlocked = true; scene.unlockAudio(); } };
addEventListener('pointerdown', () => { unlock(); play(); });
ui.onStart(() => { unlock(); ui.fullscreen(true); play(); });           // the big title button (a click is a user gesture: go full screen)
ui.onLobby({ quick: () => request({ type: 'quick' }), create: pub => request({ type: 'create', public: pub }), join: code => request({ type: 'join', code }),
  start: () => { if (room && phase === 'lobby') begin(); }, back, copied: () => say('Link copied', null, 1600) });
ui.onRetry(() => location.reload());
addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.altKey || ['Meta', 'Control', 'Alt', 'Shift', 'CapsLock', 'Tab'].includes(e.key)) return;   // browser shortcuts are not ours
  unlock();
  const k = e.key.toLowerCase();
  if (e.target.tagName === 'INPUT') { if (k === 'escape') back(); return; }     // typing a room code: F, C, B, M are letters there
  if (k === 'f') { ui.fullscreen(); return; }
  if (phase === 'title') { if (e.repeat) return; if (k === ' ' || k === 'enter') { e.preventDefault(); ui.fullscreen(true); } play(); return; }   // first gesture: any key presses Play
  if (k === 'escape') { back(); return; }
  if (phase === 'lobby') return;                                 // the lobby's keys live in ui.js; game keys wait for a room
  if (k === 'q' && room) { const t = performance.now(); if (t < leaveAt) { game.send({ type: 'leave' }); toLobby(); } else { leaveAt = t + 2500; say('Press Q again to leave', null, 2500); } return; }
  if (k === 'c') startCal();
  if (k === 'r') { model.recenter(); if (body) body.center(); say('Re-centered'); }
  if (k === 'p') resetPeaks();
  if (k === 'v') ui.toggle('podwrap');
  if (k === 'h') ui.toggle('dev');
  if (k === 'm') { let i = MODES.indexOf(mode); do { i = (i + 1) % 3; } while (MODES[i] === 'body' && !(body && body.ready)); setMode(MODES[i]); }
  if (k === '[' || k === ']') {                                  // [ = less sensitive, ] = more, for whichever move mode is on
    if (usingBody()) { body.reach = Math.max(0.08, Math.min(0.42, body.reach + (k === ']' ? -0.03 : 0.03))); say(`Range: step ${(body.reach * 100).toFixed(0)}% of the view to reach the sideline`); }
    else { sideDeg = Math.max(25, Math.min(90, sideDeg + (k === ']' ? -5 : 5))); model.setSidelineDeg(sideDeg); say(`Range: turn ${sideDeg}° to reach the sideline`); }
  }
  if (k === 'b') game.send({ type: 'bot' });                     // alone: join now. playing the bot: next difficulty
  if ('123'.includes(k)) game.send({ type: 'bot', level: +k - 1 });
});
addEventListener('resize', () => scene.resize());

// ---------- render loop: local paddle straight from the model every frame ----------
let lastPos = null;
(function loop(now) {
  requestAnimationFrame(loop);
  const p = model.pose(now);
  if (p.calibrated) {
    const mine = state && state.paddles[side];
    const z = mine ? mine.z : s() * 6.5;
    const dt = Math.min(0.05, (now - lastFrame) / 1000); lastFrame = now;
    if (usingBody() && body.seen()) {
      [bodyX, vX] = damp(bodyX, Math.max(-3.5, Math.min(3.5, body.x())), vX, 0.085, dt);
      [bodyY, vY] = damp(bodyY, Math.max(0.3, Math.min(2.3, body.y())), vY, 0.085, dt);
      scene.setViewer({ x: bodyX / 3, y: (bodyY - 1) / 1.3 });          // head-coupled camera: the screen is a window onto the court
      // Forward/back is a tilt, like pushing a stick: tip the AirPod forward to walk up to the kitchen, tip it back to
      // retreat, hold it level to stay put. Ignored while the hand is moving fast, and for a moment after a swing.
      if (p.swinging || p.rate > 3.5) walkHold = now + 450;
      const dead = 14 * Math.PI / 180, full = 38 * Math.PI / 180, t = p.tilt;
      const push = now < walkHold || Math.abs(t) < dead ? 0 : Math.sign(t) * Math.min(1, (Math.abs(t) - dead) / (full - dead));
      [walkV] = damp(walkV, push * 3.2, 0, 0.12, dt);                     // ease in and out of walking, m/s
      bodyZ = Math.max(2.6, Math.min(7.2, bodyZ + walkV * dt));          // tilt back (up) = further from the net
    }
    const auto = autoNow() && mine;
    const wx = auto ? mine.x : (usingBody() ? bodyX : p.x) * s(), wy = auto || (mine && mode === 'auto') ? mine.y : usingBody() ? bodyY : p.y;
    if (auto && usingBody()) { bodyX = mine.x * s(); bodyY = mine.y; vX = vY = 0; }                 // hand back smoothly when the camera finds you again
    scene.updatePaddle(side, { x: wx, y: wy, z, q: p.Pd, offset: p.offset, bot: false });   // Pd: the bud's real attitude
    if (ui.isVisible('dev')) { ui.setStat('px', (wx * s()).toFixed(1)); ui.setStat('py', wy.toFixed(1)); }
    const pos = [p.x + p.offset[0], p.y + p.offset[1], p.offset[2]];
    if (lastPos && p.swinging) stats.paddlePath += Math.hypot(pos[0] - lastPos[0], pos[1] - lastPos[1], pos[2] - lastPos[2]);
    lastPos = pos;
  }
  if ((phase === 'title' || phase === 'lobby') && !matchMedia('(prefers-reduced-motion: reduce)').matches) scene.setViewer({ x: Math.sin(now / 5200) * 0.9, y: 0.35 + Math.sin(now / 7300) * 0.45 });   // glass menus: the court drifts slowly behind them
  if (phase !== 'title' && phase !== 'lobby' && ui.isVisible('podwrap')) pod.update(p.Pd);
  scene.render(now);
})(performance.now());

addEventListener('error', () => stats.errors++);
