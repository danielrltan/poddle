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
const stats = window.__stats = { get phase() { return phase; }, get role() { return role; }, get room() { return room; }, get cam() { return body ? { ready: body.ready, error: body.error, seen: body.seen(), fps: Math.round(body.fps), via: body.via } : null; }, hits: 0, myHits: 0, whiffs: 0, swings: 0, errors: 0, paddlePath: 0, calibrated: false, events: {} };

let side = 0, role = 'player', names = [null, null], state = null, players = 0, calibrating = true;      // role: 'player' | 'spectator' (docs/SPECTATE.md). names: the server's truth, null = empty seat
// Flow: title -> lobby (pick a room) -> connect (only while there is no AirPod data) -> calibrate -> play. ?skiptitle=1 starts at connect.
let phase = 'title', lastSample = -1e9, gameEver = false;
let room = null, wantRoom = LOBBY ? ui.cleanCode(qs.get('court') || qs.get('room')) : '', wantWatch = LOBBY && qs.get('watch') === '1', pending = null, leaveAt = 0;   // room: the court I am seated in (the wire still says 'room'). wantRoom / wantWatch: from a shared link ?court=CODE (?room= is the old spelling and still works) or a reload. pending: the lobby request still waiting for its answer
let botWant = null, botLevel = '', holding = false, frozen = false, pausedUi = false, watchers = 0, over = null, overAt = 0, votedNo = false, lastOpp = '';   // botWant: 'Play a bot' level, sent after the welcome. over: a matchover nobody has seen yet
const link = { m: false, g: false }, airpodLive = () => performance.now() - lastSample < 1000;
const inPlay = () => phase === 'play' && !ui.currentScreen() && !ui.currentOverlay();      // the court is what the player is looking at
// The two gates of docs/API-NEXT.md 4.2. seated: nothing from the game gets past the lobby messages while no room is joined
// (an old server seats a lobby socket by itself, and its bot then beat the idle seat behind the menu). live: what is seen
// or heard over the court (toasts, banners, the result, the hold card) waits until the court is what is on screen.
const seated = () => !LOBBY || !!room, live = () => phase === 'play' || phase === 'watch', spec = () => role === 'spectator';
if (qs.get('uitest') === '1') { window.__ui = ui; window.__scene = scene; }      // test hooks: test/e2e.mjs forces UI states for screenshots, test/menu.mjs reads the scene's mode
const ls = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* private window: nothing is kept */ } } };
const cleanName = t => String(t == null ? '' : t).replace(/[\u0000-\u001f\u007f-\u009f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 12).trim();      // the server's rule (docs/SPECTATE.md Names); it cleans again anyway
const myName = () => cleanName(ui.playerName()) || cleanName(ls.get('poddle.name'));      // the lobby field; what was kept last time when the field is not there
const nameOf = i => names[i] || (state && state.paddles[i] && state.paddles[i].bot ? 'Matt' : i ? 'Player 2' : 'Player 1');
const prefs = (() => { try { return JSON.parse(ls.get('poddle.settings')) || {}; } catch { return {}; } })();      // { airpod, stats, sideDeg, reach }
// body: webcam tracks where you actually stand. auto: server runs you to the ball. aim: wrist angle moves you.
const MODES = ['body', 'auto', 'aim'], MODE_TEXT = { body: 'Body: step to move, tilt the AirPod to walk', auto: 'Auto: the game runs, you swing', aim: 'Aim: turn your wrist to move' }, MODE_NAME = { body: 'Body', auto: 'Auto', aim: 'Aim' };
let sideDeg = Number.isFinite(prefs.sideDeg) ? Math.max(25, Math.min(90, Math.round(prefs.sideDeg / 5) * 5)) : 75, bodyZ = 6.5, walkV = 0, walkHold = 0, bodyY = 1.0, vX = 0, vY = 0, lastFrame = performance.now();
// critically damped follow (frame-rate independent): smooth, no overshoot
function damp(cur, target, vel, smooth, dt) { const o = 2 / smooth, x = o * dt, e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x), ch = cur - target, tmp = (vel + o * ch) * dt; return [target + (ch + tmp) * e, (vel - o * tmp) * e]; }
let mode = MODES.includes(qs.get('move')) ? qs.get('move') : qs.get('cam') === '0' ? 'aim' : 'body', body = null, bodyX = 0;      // ?cam=0: there will be no camera, so not Body
let camOn = false;
function startCam() {                              // the webcam is asked for when a seat is taken, never on the way to watching (docs/SPECTATE.md: spectators get no camera prompt)
  if (camOn || qs.get('cam') === '0') return; camOn = true;
  createBodyTracker($('camv'), $('camc')).then(t => {
    body = t; ui.setCamera(t.ready); if (Number.isFinite(prefs.reach)) t.reach = Math.max(0.08, Math.min(0.42, prefs.reach)); syncSettings();
    if (!t.ready) { console.warn('camera tracking unavailable:', t.error); if (mode === 'body') setMode('aim', !inPlay()); return; }       // quiet on the set-up screens: nobody asked yet
    if (stats.calibrated) { const c = setInterval(() => { if (t.seen()) { clearInterval(c); t.center(); } }, 100); }      // calibration finished before the camera was up: centre on the first sight of the player instead
  });
}
function setMode(m, quiet) {                       // chosen in the settings panel (the M key is gone from the court). Every switch starts the mode from rest, in this ONE place: nothing of the last mode's motion is carried in
  if (m !== mode) { vX = vY = walkV = 0; walkHold = 0; bodyZ = 6.5; const mine = state && state.paddles[side]; if (mine) { bodyX = mine.x * s(); bodyY = mine.y; } }
  mode = m; ui.setMode(MODE_NAME[m]); syncSettings(); if (!quiet) say(MODE_TEXT[m], null, 2400);
}
const usingBody = () => mode === 'body' && body && body.ready;
const autoNow = () => mode === 'auto' || (mode === 'body' && !(body && body.seen()));   // lost your face: the game runs for you until it's back
const s = () => (side === 0 ? 1 : -1);

// ---------- messages ----------
const say = (text, _color, ms = 1200) => ui.toast(text, ms);   // small pill toast
let rally = 0;
const alone = () => ({ them: 'Waiting', themSub: room ? '' : 'B adds a bot', meSub: '' });      // the far side of the scoreboard with nobody on it. In a room the bot walks in by itself
const clearFar = () => { rally = 0; ui.setRally(0); scene.updatePaddle(1 - side, null); if (spec()) scene.updatePaddle(side, null); scene.hideBall(); };      // nobody over there any more: no avatar, no ball, no rally
const cleanNames = a => [0, 1].map(i => Array.isArray(a) && typeof a[i] === 'string' && a[i] ? a[i].slice(0, 24) : null);      // untrusted text: ui.js writes it with textContent only
// Who is on the scoreboard. A player reads 'You' on the left and the other seat on the right; a spectator reads side 0 on the
// left (blue) and side 1 on the right (orange), names in both, never 'You'. Matt's second line is his level.
function drawNames() {
  const pd = state ? state.paddles : [], sub = i => !pd[i] ? '' : pd[i].bot ? botLevel : STATUS_WORD[pd[i].status] || (pd[i].wait ? 'Calibrating' : '');      // the same word as the tag over their character (wait: a server from before 'status')
  ui.setBot(!spec() && pd[1 - side] && pd[1 - side].bot && botLevel ? botLevel : null);      // the 1 2 3 hint and the Difficulty row: only against Matt
  if (spec()) { ui.setNames({ me: pd[0] || names[0] ? nameOf(0) : 'Waiting', meSub: sub(0), them: pd[1] || names[1] ? nameOf(1) : 'Waiting', themSub: sub(1) }); return; }
  const o = pd[1 - side];
  if (!o) ui.setNames({ me: 'You', ...alone() });
  else if (o.bot) ui.setNames({ me: 'You', meSub: '', them: nameOf(1 - side), themSub: botLevel });
  else ui.setNames({ me: 'You', meSub: side === 0 ? 'Near side' : 'Far side', them: lastOpp = nameOf(1 - side), themSub: sub(1 - side) || (side === 0 ? 'Far side' : 'Near side') });
}
const STATUS_WORD = { calibrating: 'Calibrating', paused: 'Paused', away: 'Reconnecting' };
function setPaused(on) { if (on !== pausedUi) ui.setPaused(pausedUi = on); }

// ---------- match end, rematch (docs/SPECTATE.md) ----------
function showOver() {                              // the result card. A matchover that came while a set-up screen was up waits in `over` for the court to open
  const m = over; over = null; if (!m) return;
  const L = spec() ? 0 : side, won = m.winner === L, sc = Array.isArray(m.score) ? m.score : [0, 0], vote = LOBBY && m.type === 'matchover';      // the left slot: me, or side 0 for a spectator. Legacy room / old server: it restarts by itself
  ui.setServe(null); ui.hold(null); ui.settings(false);
  ui.matchResult({ won, me: sc[L] | 0, them: sc[1 - L] | 0, nameMe: spec() ? nameOf(0) : 'You', nameThem: nameOf(1 - L), forfeit: !!m.forfeit, role, vote });
  const left = Math.max(0, Math.round((+m.rematchBy || 20) - (performance.now() - overAt) / 1000));      // less what was spent behind a set-up screen
  if (vote) ui.rematch(spec() ? { left } : { mine: null, theirs: null, left, name: nameOf(1 - L) });
  else setTimeout(() => { if (ui.currentOverlay() === 'match') ui.showOverlay(null); }, 6000);        // normally the next 'serve' closes it after 5 s
  if (won && !spec()) { ui.confetti(['#3aa0ff', '#ffd34a', '#3ecf72', '#ffffff'], 120); setTimeout(() => ui.confetti(['#3aa0ff', '#ffd34a', '#ffffff'], 80), 900); }
}

// ---------- spectator views: keys 1-4 and the chips are one function (docs/API-NEXT.md 2.3, 3.4) ----------
const VIEWS = ['broadcast', 'split', 'pov', 'free'];
function showView() { const v = scene.getView(); if (v && spec()) ui.setView(v.name, v.name === 'pov' ? nameOf(v.side) : ''); }
function setView(name, flip) {                     // flip: asked for by the viewer (Player again = the other player), not by a restore
  if (!spec() || !VIEWS.includes(name)) return;
  const was = scene.getView() || {}, v = scene.setView(name, name === 'pov' && was.name === 'pov' ? (flip ? 1 - was.side : was.side) : 0) || { name, side: 0 };
  ui.setView(v.name, v.name === 'pov' ? nameOf(v.side) : ''); if (VIEWS.includes(v.name)) ls.set('poddle.view', v.name);
}

// ---------- settings panel (docs/API-NEXT.md 3.2): every row is also a silent key ----------
let showPod = prefs.airpod !== false, showStats = prefs.stats === true;
const savePrefs = () => ls.set('poddle.settings', JSON.stringify({ airpod: showPod, stats: showStats, sideDeg, reach: body ? body.reach : prefs.reach }));
const sensOf = () => usingBody() ? { sens: Math.round((0.42 - body.reach) / 0.03) + 1, sensMin: body.reach > 0.419, sensMax: body.reach < 0.081 } : { sens: (90 - sideDeg) / 5 + 1, sensMin: sideDeg >= 90, sensMax: sideDeg <= 25 };      // 1 = least sensitive
function syncSettings() { ui.setSettings({ ...sensOf(), airpod: showPod, stats: showStats, inRoom: LOBBY && !!room, spectator: spec(), bodyOk: !!(body && body.ready) }); }
function sens(dir, quiet) {                        // ] / + = more sensitive, [ / - = less, for whichever move mode is on. The panel shows the number, the keys say it
  if (usingBody()) { body.reach = Math.max(0.08, Math.min(0.42, body.reach - dir * 0.03)); if (!quiet) say(`Range: step ${(body.reach * 100).toFixed(0)}% of the view to reach the sideline`); }
  else { sideDeg = Math.max(25, Math.min(90, sideDeg - dir * 5)); model.setSidelineDeg(sideDeg); if (!quiet) say(`Range: turn ${sideDeg}° to reach the sideline`); }
  savePrefs(); syncSettings();
}
const show = ui.show;
function setPod(on) { showPod = !!on; show('podwrap', showPod); savePrefs(); syncSettings(); }
function setStats(on) { showStats = !!on; show('dev', showStats); savePrefs(); syncSettings(); }
function recenter() { model.recenter(); if (body) body.center(); say('Re-centered'); }
function leave() { if (!LOBBY || !room) return; game.send({ type: 'leave' }); toLobby(); }
// Opening the panel pauses a match against Matt (or an empty court); against a human it is only a card over a live rally.
const vsHuman = () => { const o = state && state.paddles[1 - side]; return !!o && !o.bot; };
function pause(on) {
  if (spec() || !seated() || !live()) return;
  if (vsHuman()) { if (on) ui.setSettings({ canPause: !(noPause = true) }); return; }
  if (on) ui.setSettings({ canPause: !(noPause = false) }); game.send({ type: 'pause', on });
}
let sentName = '', polledName = '', healAt = 0, noPause = false;
function rename(n) {                               // the settings panel's Name row (docs/NEXT.md 10b): kept, and told to the room
  n = cleanName(n); if (!n) return; ls.set('poddle.name', n);
  if (seated() && LOBBY && n !== sentName) game.send({ type: 'name', name: sentName = n });
}

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
function screen(name) { ui.showScreen(name); scene.setMenu(!!name); }      // a menu screen over the court = the menu camera and the cheap render mode (docs/API-NEXT.md 2.4)
function openCourt() { screen(null); if (over) showOver(); }
function startCal() { calibrating = true; stats.calibrated = false; model.startCalibration(); phase = 'calibrate'; ui.calibrationReset(); screen('calibrate'); tellCal(true); }
function tellCal(on) { if (seated() && !spec()) game.send({ type: 'status', cal: on }); }      // the others see 'Calibrating' on my character, and the next serve waits for me (docs/NEXT.md 14a)
function play() {                                  // leave the title for the lobby. A shared link (?room=CODE) joins at once, or watches (&watch=1).
  if (phase !== 'title') return;
  phase = 'lobby'; screen('lobby');
  if (wantRoom.length === 4) { ui.lobbyView('code', { code: wantRoom }); if (myName()) request({ type: wantWatch ? 'watch' : 'join', code: wantRoom }); } else ui.lobbyView('home');      // no name yet: the code is filled in, the field asks, Join does the rest
}
function begin() {                                 // seated: straight to calibration if the AirPod is already streaming, straight to the court if that is done too
  phase = 'connect'; startCam();
  if (stats.calibrated && airpodLive()) { phase = 'play'; openCourt(); } else if (airpodLive()) startCal(); else screen('connect');
}
function enterWatch() { phase = 'watch'; openCourt(); }      // a spectator: no AirPod, no bridge, no calibration, no camera. Lobby -> court.
let pendT = 0;
function settle() { pending = null; clearTimeout(pendT); ui.lobbyBusy(false); }
function request(m) {                               // one lobby request at a time, each carrying the player's name. Not connected right now: it goes out when the socket opens
  if (pending) return; const n = myName(); m.name = sentName = n; if (n) ls.set('poddle.name', n);
  pending = m; ui.lobbyBusy(true); game.send(m);
  pendT = setTimeout(() => { if (pending !== m) return; settle(); botWant = null; if (link.g) say('No answer. Try again.', null, 2600); }, 5000);      // an old server never answers: do not leave the lobby dimmed for good
}
function setUrl(code, watch) { const u = new URL(location.href), q = u.searchParams; q.delete('room'); if (code) q.set('court', code); else q.delete('court'); if (code && watch) q.set('watch', '1'); else q.delete('watch'); history.replaceState(null, '', u); }   // the address bar is the invite, and a reload comes back to the same room, in the same role
const shareLink = code => ['localhost', '127.0.0.1', ''].includes(location.hostname) ? '' : `${location.origin}${location.pathname}?court=${code}`;      // a localhost link is no use to a friend
function toLobby(msg) {                            // out of a room, back to the choices. Calibration is kept. The menu's rally takes the court back.
  clearFar(); room = null; role = 'player'; side = 0; names = [null, null]; wantRoom = ''; wantWatch = false; state = null; over = null; botWant = null; botLevel = ''; holding = frozen = votedNo = false; watchers = 0; phase = 'lobby'; setUrl(null); settle();
  ui.setSpectator(false); ui.hold(null); setPaused(false); ui.settings(false); ui.setWatchers(0); syncSettings(); ui.setSettings({ canPause: true });
  scene.setFrozen(false); scene.setSide(0); scene.startAttract();
  ui.setRoom(null); ui.showOverlay(null); screen('lobby'); ui.lobbyView('home');
  ui.setScore(0, 0); ui.setServe(null); ui.setNames({ me: 'You', ...alone() });
  if (msg) say(msg, null, 2600); else ui.toastOff();                                // 'Press Q again to leave' has been answered
}
function back() {                                  // Back button / Esc, wherever it is
  if (!LOBBY) return;
  if (phase === 'lobby') { const v = ui.lobbyView(); if (room) { game.send({ type: 'leave' }); toLobby(); } else if (v !== 'home') ui.lobbyView('home'); else { phase = 'title'; screen('title'); } }
  else if (phase === 'connect' || phase === 'calibrate') { game.send({ type: 'leave' }); toLobby(); }
}
function refreshStatus() {
  const setup = phase === 'title' || phase === 'lobby' || phase === 'connect', off = phase === 'watch';      // watching needs no AirPod and no camera: never 'signal lost'
  ui.setStatus({ airpod: off ? 'off' : airpodLive() ? 'ok' : setup ? 'wait' : 'bad', game: link.g ? 'ok' : setup && !gameEver ? 'wait' : 'bad',
    camera: off || qs.get('cam') === '0' ? 'off' : !body ? 'wait' : body.ready ? 'ok' : 'off' });
  if (phase === 'calibrate' && !airpodLive()) ui.calibrationReset();      // stream dropped mid-calibration: say so
  if (LOBBY) ui.lobbyLink(link.g || !gameEver && performance.now() < 2500);       // the lobby sits above the 'server down' card, so it says so itself (not in the first moments of a page load)
  const n = myName(); if (n !== polledName) { polledName = n; if (room) rename(n); }      // the name was changed in the settings panel while in a room
}
if (sideDeg !== 75) model.setSidelineDeg(sideDeg);
show('podwrap', showPod); show('dev', showStats); ui.setMode(MODE_NAME[mode]); syncSettings();      // what was chosen last time (poddle.settings)
if (LOBBY && qs.get('room')) setUrl(wantRoom.length === 4 ? wantRoom : null, wantWatch);      // an old ?room= link: same court, the address bar now says ?court=
if (!LOBBY) { phase = 'connect'; screen('connect'); startCam(); } else { ui.titleRoom(wantRoom.length === 4 ? wantRoom : ''); screen('title'); scene.startAttract(); }      // the menu's own endless rally, client-side only (docs/NEXT.md 11)
refreshStatus(); setInterval(refreshStatus, 250);

// ---------- sockets (auto-reconnect) ----------
// urls: tried in turn until one opens. A stale '#<old-ip>' in the address bar must never strand you: this machine's
// own server is always the second candidate, and when it wins the dead address is dropped from the URL.
function connect(urls, el, onmsg, onopen) {
  urls = [].concat(urls); let ws, delay = 400, i = 0, fails = 0;
  const open = () => {
    const url = urls[i % urls.length]; let opened = false;
    ws = new WebSocket(el === 'g' ? url + '?cid=' + CID + (LOBBY ? '&lobby=1' + (room ? '&room=' + room + (spec() ? '&watch=1' : '') + (myName() ? '&name=' + encodeURIComponent(myName()) : '') : '') : '') : url);      // room: a reconnect asks for its seat (or its place to watch) back
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
  if (phase === 'lobby' || phase === 'watch') return;                //  A spectator's AirPod is nobody's paddle.
  if (phase === 'connect') startCal();                              //  begins, so a bud lying on the desk cannot calibrate itself.
  for (const e of model.feed(sample, performance.now())) {
    if (e.type === 'cal') showCal(e);
    else if (e.type === 'calibrated') { calibrating = false; stats.calibrated = true; phase = 'play'; if (body) body.center(); tellCal(false);
      // 'All set' arrives in this same batch: hold the green card long enough to be read, then open the court
      setTimeout(() => { if (phase !== 'play') return; openCourt();
        setTimeout(() => { if (inPlay() && state && state.serving === side) say('Your serve. Swing to hit it.', null, 2600); }, 380); }, 900); }     // after the fade
    else if (e.type === 'swing' || e.type === 'swingFix') { const fix = e.type === 'swingFix'; if (!fix) stats.swings++;     // swings are reported early; a fix follows if the real peak differs
      if (!calibrating && !spec() && seated() && !frozen && !holding) {      // a paused or held room takes no swings
        // Spin comes from the wrist rolling through the ball or from a curved "C" shaped swing, whichever is stronger. Its
        // sign says which way the ball breaks off the bounce. (How level the paddle is held is NOT used: this player rests
        // the AirPod flat in the hand, so it read "level" nearly all the time and made every shot a slice.)
        // The amount is CONTINUOUS (docs/NEXT.md 3b): every hit carries its own spin, linear from what a plain swing does
        // (roll 0.12, turn 0.3) to the most the wrist gives (roll 0.95, turn 2.6). The old gates (0.6, 1.2) left 76 % of real
        // strokes at exactly zero and 16 % at 0.8+. Now p50 0.28, p75 0.51, and 27 % read as a slice (> 0.5 on the server).
        const roll = Math.max(0, Math.min(1, (Math.abs(e.roll || 0) - 0.12) / 0.83)), curve = Math.max(0, Math.min(1, ((e.turn || 0) - 0.3) / 2.3));
        const amount = Math.max(roll, curve), way = curve >= roll && Math.abs(e.curl || 0) > 0.05 ? Math.sign(e.curl) : Math.abs(e.roll || 0) > 0.1 ? -Math.sign(e.roll) : Math.sign(e.dir || 1);
        const slice = amount * (way || 1);
        // A lob is meant (docs/NEXT.md 2): a curved swing ends travelling upward without being an underhand, so the upward
        // share fades out as the swing's axis turns 0.6 -> 1.0 rad. Of the recorded powered lobs only the deliberate one stays.
        const g = Math.max(0, Math.min(1, ((e.turn || 0) - 0.6) / 0.4)), lob = e.lob * (1 - g * g * (3 - 2 * g));
        game.send({ type: 'swing', power: e.power, dir: e.dir, lob, chop: e.chop, age: e.age, net: net.lag(), slice, fix });
        if (!fix) scene.onEvent({ type: 'swung', side });            // whoosh now; the server's echo is de-duplicated
      } }
    else if (e.type === 'swingEnd') logSwing(e);
  }
});

const SCENE_EVENTS = ['serve', 'hit', 'swung', 'bounce', 'launch', 'whiff', 'point'];
const game = connect(HOST === 'localhost' ? GAME : [GAME, `ws://localhost:${qs.get('game') || 8080}`], 'g', m => {
  stats.events[m.type] = (stats.events[m.type] || 0) + 1;
  if (m.type === 'pong') { net.pong(m); return; }
  if (!LOBBY) { if (m.type === 'closed') { ui.showOverlay(null); return; } if (['lobby', 'room', 'joinfail', 'left'].includes(m.type)) return; }          // legacy path: no room UI, whatever the server says
  if (m.type === 'lobby') { ui.lobbyRooms(m.rooms, m.online); return; }
  if (m.type === 'room') {                                       // seated, or let in to watch (the normal 'welcome' follows). Also the answer to a reconnect with room=CODE.
    const made = pending && pending.type === 'create' && botWant == null, again = room === m.code; settle(); room = m.code; role = m.role === 'spectator' ? 'spectator' : 'player'; wantRoom = ''; wantWatch = false;
    ui.askWatch(null); ui.setRoom(room, shareLink(room)); setUrl(room, spec()); scene.stopAttract();      // the menu's rally ends the moment a room is joined
    if (phase === 'lobby' && !again) { if (spec()) enterWatch(); else if (made) ui.lobbyView('share'); else begin(); }        // again: a reconnect got the seat back, the player stays where they were. Play a bot skips the share view
    return;
  }
  if (m.type === 'joinfail') {
    const was = pending, watching = !!was && was.type === 'watch'; settle(); wantRoom = ''; wantWatch = false; botWant = null;
    if (room) { toLobby('Court closed'); return; }                                            // a reconnect found the room gone
    setUrl(null);
    if (m.reason === 'full' && m.watch === true && !watching) { const code = ui.cleanCode(typeof m.code === 'string' ? m.code : was && was.code); if (code.length === 4) { ui.askWatch(code); return; } }      // 'Court is full. Watch instead?'
    const text = (watching ? { notfound: 'Court not found', busy: 'Too many watching', full: 'Too many watching' } : { notfound: 'Court not found', full: 'Court is full', busy: 'No free courts. Try again soon.' })[m.reason] || 'Couldn’t join';
    if (was && (was.type === 'join' || watching) && ui.lobbyView() === 'code') ui.codeError(text); else say(text, null, 2600);
    return;
  }
  if (m.type === 'closed') { if (room) toLobby(m.reason === 'norematch' ? (votedNo ? '' : 'No rematch') : 'Court closed'); return; }      // everyone goes back to the lobby; the one who pressed Leave needs no telling
  if (m.type === 'full') { if (!LOBBY) ui.showOverlay('game-full'); return; }
  if (!seated()) return;                                         // THE GUARD (docs/API-NEXT.md 4.2): no room joined = no side, court, score, names, ball, banner, result, toast or sound, whatever the server sends
  if (m.type === 'welcome') {
    side = m.side === 1 ? 1 : 0; if (LOBBY && m.role) role = m.role === 'spectator' ? 'spectator' : 'player'; names = cleanNames(m.names); holding = false;
    if (ui.currentOverlay() === 'game-full') ui.showOverlay(null);
    scene.setCourt(m.court); scene.setSide(spec() ? null : side);
    if (spec()) setView(VIEWS.includes(ls.get('poddle.view')) ? ls.get('poddle.view') : 'broadcast', false);
    if (botWant != null) { game.send({ type: 'bot', level: botWant }); botWant = null; } else if (AUTOBOT) game.send({ type: 'bot' });      // Play a bot: Matt sits down at once, at the level picked in the menu
    net.rejoined(); ui.setSpectator(spec()); syncSettings(); drawNames();
    if (ui.settings() && live()) pause(true);                    // a reconnect with the panel still open: the server let time run when the socket dropped
    return;
  }
  if (m.type === 'names') {
    const was = names; names = cleanNames(m.names); drawNames(); showView();
    for (const i of [0, 1]) if ((spec() || i !== side) && live() && names[i] && names[i] !== 'Matt' && (!was[i] || was[i] === 'Matt')) say(`${names[i]} joined`, null, 2200);      // a human sat down (a changed name is not news)
    return;
  }
  if (m.type === 'state') {
    state = m; frozen = !!m.paused; scene.setFrozen(frozen || holding);
    scene.updateBall(m.p, m.v, m.live, undefined, m.spin, m); if (frozen || holding) net.idle(); else net.packet();      // a stopped room is not a bad link
    if ((m.watchers | 0) !== watchers) ui.setWatchers(watchers = m.watchers | 0);
    setPaused(frozen && !holding); drawNames();
    if (spec()) { ui.setScore(m.score[0], m.score[1]); for (const i of [0, 1]) { const o = m.paddles[i]; scene.updatePaddle(i, o ? { x: o.x, y: o.y, z: o.z, q: o.q, offset: null, bot: !!o.bot, status: o.status } : null); } return; }
    if (ui.settings() && noPause !== vsHuman()) ui.setSettings({ canPause: !(noPause = vsHuman()) });      // somebody sat down (or left) while the panel was open: the note follows
    if (live() && !frozen && !holding) serveCoach(m); else svT = 0;      // no serve coaching over a set-up screen or a stopped room; its clock starts again afterwards
    ui.setScore(m.score[side], m.score[1 - side]);
    const o = m.paddles[1 - side]; players = o ? 2 : 1;
    scene.updatePaddle(1 - side, o ? { x: o.x, y: o.y, z: o.z, q: o.q, offset: null, bot: !!o.bot, status: o.status } : null);
    if (frozen && !holding && !ui.settings() && performance.now() > healAt) { healAt = performance.now() + 1000; game.send({ type: 'pause', on: false }); }      // paused with the panel shut (a lost 'pause off', a reload): nobody could ever resume it
    return;
  }
  if (m.type === 'botinfo') {
    const said = botLevel; if (m.active && typeof m.name === 'string') botLevel = m.name.slice(0, 12); drawNames();
    if (m.reason) { if (live()) say('Can’t add a bot with two players in', null, 1800); } else if (m.active && live() && botLevel !== said) say(`Matt · ${botLevel}`, null, 1400);
    return;
  }
  if (m.type === 'left') { const who = lastOpp || nameOf(1 - side); clearFar(); ui.setServe(null); if (live() && !spec()) say(`${who} left`, null, 2200); return; }      // only before a match has started now; mid-match it is a hold or a forfeit
  if (m.type === 'match' || m.type === 'matchover') { over = m; overAt = performance.now(); votedNo = false; if (live()) showOver(); return; }      // 'match': a server from before docs/SPECTATE.md
  if (m.type === 'rematch') { const v = Array.isArray(m.votes) ? m.votes : []; ui.rematch(spec() ? { left: m.left } : { mine: v[side], theirs: v[1 - side], left: m.left, name: nameOf(1 - side) }); return; }
  if (m.type === 'rematchon') { over = null; if (ui.currentOverlay() === 'match') ui.showOverlay(null); rally = 0; ui.setRally(0); return; }      // the scores follow in 'state'
  if (m.type === 'hold') { holding = true; scene.setFrozen(true); setPaused(false); if (live()) ui.hold(nameOf(m.side === 1 ? 1 : 0), m.left | 0); return; }      // their wifi dropped: the seat is held, the ball waits where it is
  if (m.type === 'holdoff') { holding = false; ui.hold(null); return; }                     // frozen follows the next 'state'
  if (m.type === 'paused') { if (m.refused) ui.setSettings({ canPause: false }); else { setPaused(!!m.on); scene.setFrozen(!!m.on || holding); } return; }
  if (m.type === 'hit') { stats.hits++; if (m.side === side && !spec()) stats.myHits++; rally++; ui.setRally(rally); }   // the shot's name only, and only for my own hits
  if (m.type === 'serve') { over = null; bodyZ = 6.5; walkV = 0; rally = 0; ui.setRally(0); ui.setServe(m.by === (spec() ? 0 : side) ? 'me' : 'them'); if (ui.currentOverlay() === 'match') ui.showOverlay(null);
    if (m.wait && m.by === side && !spec() && inPlay()) say('Your serve. Swing to hit it.', null, 2600); }
  if (m.type === 'whiff') stats.whiffs++;                        // no commentary: you can see that you missed
  if (m.type === 'point' && !m.final && live()) {
    if (spec()) ui.pointBanner(null, nameOf(m.winner === 1 ? 1 : 0), m.winner === 1 ? 1 : 0);
    else { const won = m.winner === side; ui.pointBanner(won, nameOf(m.winner === 1 ? 1 : 0)); if (won) ui.confetti(['#3aa0ff', '#ffd34a', '#ffffff']); } }      // "Your point!" / "<name> scores", nothing else
  if (SCENE_EVENTS.includes(m.type)) scene.onEvent(m);           // anything else: ignored, no throw
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
    if (bad >= 2 && hz === 60) { hz = 30; game.send({ type: 'net', hz }); }      // said nowhere: the player cannot do anything about it mid-rally; the ping bars show it
    if (good >= 8 && hz === 30) { hz = 60; game.send({ type: 'net', hz }); }
    gaps = late = worst = 0;
  }, 2000);
  return {
    packet() { const t = performance.now(), g = t - lastPacket; lastPacket = t; if (g > 1000) return; gaps++; if (g > worst) worst = g; if (g > 1000 / hz + 45) late++; },
    pong(m) { const r = performance.now() - m.c; if (r >= 0 && r < 5000) { rtts.push(r); if (rtts.length > 12) rtts.shift(); if (ui.setPing) ui.setPing(room || !LOBBY ? [...rtts].sort((a, b) => a - b)[rtts.length >> 1] : 0); } },      // the median of the last 6 s: a number that sits still
    lag: () => Math.round(floor()),                                     // the quietest recent round trip: queueing spikes are not the link's real delay
    rejoined() { hz = 60; bad = good = 0; rtts.length = 0; },           // a new socket starts at the full rate on the server
    idle() { lastPacket = 0; },                                         // paused or held: the gap to the next live packet is not the link's
  };
})();

setInterval(() => {                               // 20Hz: tell the server where my paddle is
  if (calibrating || !seated() || spec()) return;
  const p = model.pose(performance.now());
  if (p.calibrated) game.send({ type: 'paddle', auto: autoNow(), autoY: mode === 'auto', x: (usingBody() ? bodyX : p.x) * s(), y: usingBody() ? bodyY : p.y, z: usingBody() && !autoNow() ? bodyZ : undefined, q: p.Pd });
}, 50);

// ---------- input ----------
let unlocked = false;
const unlock = () => { if (!unlocked) { unlocked = true; scene.unlockAudio(); } };
addEventListener('pointerdown', () => { unlock(); play(); });
ui.onStart(() => { unlock(); ui.fullscreen(true); play(); });           // the big title button (a click is a user gesture: go full screen)
ui.onLobby({ quick: () => request({ type: 'quick' }), create: pub => request({ type: 'create', public: !!pub }), join: code => request({ type: 'join', code }),
  watch: code => request({ type: 'watch', code }),             // a Watch button, or Yes on 'Court is full. Watch instead?'
  bot: level => { if (pending) return; botWant = [0, 1, 2].includes(level) ? level : 1; request({ type: 'create', public: false }); },      // Play a bot = a private room, then 'bot' right after the welcome. No protocol of its own
  start: () => { if (room && phase === 'lobby') begin(); }, back, copied: () => say('Link copied', null, 1600) });
ui.onSettings({ open: () => pause(true), close: () => pause(false), sens: dir => sens(dir < 0 ? -1 : 1, true), airpod: setPod, stats: setStats, recenter, leave, name: rename,
  move: m => { if (MODES.includes(m) && m !== mode && (m !== 'body' || body && body.ready)) setMode(m); },      // how you move is chosen here now, not on the court
  bot: level => { if ([0, 1, 2].includes(level) && !spec()) game.send({ type: 'bot', level }); } });
ui.onView(name => setView(name, true));
ui.onRematch(yes => { if (!room || spec()) return; votedNo = !yes; game.send({ type: 'rematch', yes: !!yes });      // Leave = no: the server closes the room for everyone, 'closed' brings us back to the lobby
  if (!yes) { const r = room; setTimeout(() => { if (room === r && votedNo) leave(); }, 3000); } });      // unless it never answers
ui.onRetry(() => location.reload());
function esc() { if (ui.asking()) ui.askWatch(null); else if (live() && !ui.currentScreen()) { if (!ui.currentOverlay()) ui.settings(!ui.settings()); } else back(); }      // in play and while watching Esc is the hamburger
addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.altKey || ['Meta', 'Control', 'Alt', 'Shift', 'CapsLock', 'Tab'].includes(e.key)) return;   // browser shortcuts are not ours
  unlock();
  const k = e.key.toLowerCase();
  if (e.target.tagName === 'INPUT') { if (k === 'escape') esc(); return; }      // typing a room code or a name: F, C, B, M are letters there
  if (k === 'f') { ui.fullscreen(); return; }
  if (phase === 'title') { if (e.repeat) return; if (k === ' ' || k === 'enter') { e.preventDefault(); ui.fullscreen(true); } play(); return; }   // first gesture: any key presses Play
  if (k === 'escape') { esc(); return; }
  if (phase === 'lobby') return;                                 // the lobby's keys live in ui.js; game keys wait for a room
  if (k === 'q' && room) { const t = performance.now(); if (t < leaveAt) { game.send({ type: 'leave' }); toLobby(); } else { leaveAt = t + 2500; say('Press Q again to leave', null, 2500); } return; }
  if (k === 'h') setStats(!showStats);
  if (spec()) { if ('1234'.includes(k) && !e.repeat) setView(VIEWS[+k - 1], true); return; }      // watching: 1-4 pick the view (3 again = the other player), F, H, Q Q and Esc. Nothing else
  if (k === 'c') startCal();
  if (k === 'r') recenter();
  if (k === 'p') resetPeaks();
  if (k === 'v') setPod(!showPod);
  if (k === '[' || k === ']') sens(k === ']' ? 1 : -1);          // [ = less sensitive, ] = more (the settings panel's - / +)
  if (k === 'b') game.send({ type: 'bot' });                     // alone: join now. playing the bot: next difficulty
  if ('123'.includes(k)) game.send({ type: 'bot', level: +k - 1 });
});
addEventListener('resize', () => scene.resize());

// ---------- render loop: local paddle straight from the model every frame ----------
let lastPos = null;
(function loop(now) {
  requestAnimationFrame(loop);
  const p = model.pose(now);
  if (p.calibrated && seated() && !spec()) {                     // my own paddle: only with a seat of my own
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
  if (phase !== 'title' && phase !== 'lobby' && phase !== 'watch' && ui.isVisible('podwrap')) pod.update(p.Pd);      // (the menu camera drifts by itself now: scene.setMenu)
  scene.render(now);
})(performance.now());

addEventListener('error', () => stats.errors++);
