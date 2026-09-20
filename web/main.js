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
const GAME = `ws://${HOST}:${qs.get('game') || 8080}`;
const AUTOBOT = qs.get('autobot') === '1';

const model = new MotionModel();
const scene = createScene($('stage'));
const pod = createPodView($('pod'));
ui.setServerAddress(GAME);
const stats = window.__stats = { get cam() { return body ? { ready: body.ready, error: body.error, seen: body.seen(), fps: Math.round(body.fps), via: body.via } : null; }, hits: 0, myHits: 0, whiffs: 0, swings: 0, errors: 0, paddlePath: 0, calibrated: false, events: {} };

let side = 0, state = null, players = 0, calibrating = true;
// Flow: title -> connect (only while there is no AirPod data) -> calibrate -> play. ?skiptitle=1 starts at connect.
let phase = 'title', lastSample = -1e9, gameEver = false;
const link = { m: false, g: false }, airpodLive = () => performance.now() - lastSample < 1000;
const inPlay = () => phase === 'play' && !ui.currentScreen() && !ui.currentOverlay();      // the court is what the player is looking at
if (qs.get('uitest') === '1') window.__ui = ui;                 // test hook: lets test/e2e.mjs force UI states for screenshots
// body: webcam tracks where you actually stand. auto: server runs you to the ball. aim: wrist angle moves you.
const MODES = ['body', 'auto', 'aim'], MODE_TEXT = { body: 'Body Move — step to move, tilt the AirPod to walk', auto: 'Auto Move — the game runs for you, just swing', aim: 'Aim Move — turn your wrist to move' }, MODE_NAME = { body: 'Body', auto: 'Auto', aim: 'Aim' };
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
function resetPeaks() { peaks = []; log10 = []; sessionPeak = 0; ui.setStat('sw', 0); ui.setStat('pkmax', '0.0'); ui.setStat('pkavg', '–'); ui.setStat('pklist', '–'); }

// ---------- screens: title -> connect -> calibrate -> play ----------
function showCal(e) { if (phase === 'calibrate') ui.calibration(e, { camLost: !!(body && body.ready && !body.seen()) }); }
function startCal() { calibrating = true; stats.calibrated = false; model.startCalibration(); phase = 'calibrate'; ui.calibrationReset(); ui.showScreen('calibrate'); }
function begin() {                                 // leave the title: straight to calibration if the AirPod is already streaming
  if (phase !== 'title') return;
  phase = 'connect'; if (airpodLive()) startCal(); else ui.showScreen('connect');
}
function refreshStatus() {
  const setup = phase === 'title' || phase === 'connect';
  ui.setStatus({ airpod: airpodLive() ? 'ok' : setup ? 'wait' : 'bad', game: link.g ? 'ok' : setup && !gameEver ? 'wait' : 'bad',
    camera: qs.get('cam') === '0' ? 'off' : !body ? 'wait' : body.ready ? 'ok' : 'off' });
  if (phase === 'calibrate' && !airpodLive()) ui.calibrationReset();      // stream dropped mid-calibration: say so
}
if (qs.get('skiptitle') === '1') { phase = 'connect'; ui.showScreen('connect'); } else ui.showScreen('title');
refreshStatus(); setInterval(refreshStatus, 250);

// ---------- sockets (auto-reconnect) ----------
// urls: tried in turn until one opens. A stale '#<old-ip>' in the address bar must never strand you: this machine's
// own server is always the second candidate, and when it wins the dead address is dropped from the URL.
function connect(urls, el, onmsg, onopen) {
  urls = [].concat(urls); let ws, delay = 400, i = 0, fails = 0;
  const open = () => {
    const url = urls[i % urls.length]; let opened = false;
    ws = new WebSocket(url);
    const sock = ws, giveUp = setTimeout(() => { if (!opened) sock.close(); }, 1500);       // a dead IP just hangs: don't wait for TCP to time out
    ws.onopen = () => { opened = true; clearTimeout(giveUp); delay = 400; fails = 0; link[el] = true; ui.setLink(el, true);
      if (el === 'g') { gameEver = true; if (ui.currentOverlay() === 'server-down') ui.showOverlay(null); if (i % urls.length > 0 && location.hash) { history.replaceState(null, '', location.pathname + location.search); say('Couldn’t reach the saved address — connected to this Mac instead', null, 2800); } }
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
  if (phase === 'title') { if (power > 12) begin(); return; }        // "Swing to start". The model is not fed until calibration
  if (phase === 'connect') startCal();                              //  begins, so a bud lying on the desk cannot calibrate itself.
  for (const e of model.feed(sample, performance.now())) {
    if (e.type === 'cal') showCal(e);
    else if (e.type === 'calibrated') { calibrating = false; stats.calibrated = true; phase = 'play'; if (body) body.center();
      // 'All set!' arrives in this same batch: hold the green card long enough to be read, then open the court
      setTimeout(() => { if (phase !== 'play') return; ui.showScreen(null);
        setTimeout(() => { if (inPlay()) say(state && state.serving === side ? 'Your serve — swing to hit it!' : 'Calibrated — let’s play!', null, 2600); }, 380); }, 900); }     // after the fade
    else if (e.type === 'swing' || e.type === 'swingFix') { const fix = e.type === 'swingFix'; if (!fix) stats.swings++;     // swings are reported early; a fix follows if the real peak differs
      if (!calibrating) {
                // Spin comes from any of three things, whichever is strongest: the paddle held level (a slice), the wrist
        // rolling through the ball, or a curved "C" shaped swing. Its sign says which way the ball breaks off the bounce.
        const top = qrot(model.pose(performance.now()).Pd, [0, 1, 0]);
        const level = Math.max(0, 1 - Math.abs(top[1]) / 0.75), roll = Math.max(0, Math.min(1, (Math.abs(e.roll || 0) - 0.4) / 0.4)), curve = Math.max(0, Math.min(1, ((e.turn || 0) - 0.7) / 1.0));   // measured on real play: a plain swing wanders ~0.4 rad and rolls ~0.2, so spin starts above that
        const amount = Math.max(level, roll, curve), way = curve >= roll && Math.abs(e.curl || 0) > 0.05 ? Math.sign(e.curl) : Math.abs(e.roll || 0) > 0.1 ? -Math.sign(e.roll) : Math.sign(e.dir || 1);
        const slice = amount * (way || 1);
        game.send({ type: 'swing', power: e.power, dir: e.dir, lob: e.lob, chop: e.chop, age: e.age, slice, fix });
        if (!fix) scene.onEvent({ type: 'swung', side });            // whoosh now; the server's echo is de-duplicated
      } }
    else if (e.type === 'swingEnd') logSwing(e);
  }
});

const game = connect(HOST === 'localhost' ? GAME : [GAME, `ws://localhost:${qs.get('game') || 8080}`], 'g', m => {
  stats.events[m.type] = (stats.events[m.type] || 0) + 1;
  if (m.type === 'welcome') {
    side = m.side; if (ui.currentOverlay() === 'game-full') ui.showOverlay(null);
    scene.setCourt(m.court); scene.setSide(side);
    if (AUTOBOT) game.send({ type: 'bot' });
    return;
  }
  if (m.type === 'state') {
    state = m; scene.updateBall(m.p, m.v, m.live);
    serveCoach(m);
    ui.setScore(m.score[side], m.score[1 - side]);
    const o = m.paddles[1 - side];
    players = o ? 2 : 1; if (!o) ui.setNames({ them: 'Waiting…', themSub: 'Press B to add a bot', meSub: '' }); else if (!o.bot) { oppName = side === 0 ? 'Player 2' : 'Player 1'; ui.setNames({ them: oppName, themSub: side === 0 ? 'Far side' : 'Near side', meSub: side === 0 ? 'Near side' : 'Far side' }); }
    if (o) scene.updatePaddle(1 - side, { x: o.x, y: o.y, z: o.z, q: o.q, offset: null, bot: !!o.bot });
    return;
  }
  if (m.type === 'botinfo') {
    if (m.active) { oppName = m.name + ' Bot'; ui.setNames({ them: oppName, themSub: '', meSub: '' }); }
    if (m.reason) say('Can’t add a bot — two players are connected', null, 1800); else if (m.active && inPlay()) say(`Opponent: ${m.name} Bot`, null, 1400);
    return;
  }
  if (m.type === 'full') { ui.showOverlay('game-full'); return; }
  if (m.type === 'hit') { stats.hits++; if (m.side === side) stats.myHits++; rally++; ui.setRally(rally); if (m.side === side) ui.callout(m.kind); }   // the shot's name only, and only for my own hits
  if (m.type === 'serve') { bodyZ = 6.5; walkV = 0; rally = 0; ui.setRally(0); ui.setServe(m.by === side ? 'me' : 'them'); if (ui.currentOverlay() === 'match') ui.showOverlay(null);
    if (m.wait && m.by === side && inPlay()) say('Your serve — swing to hit it!', null, 2600); }
  if (m.type === 'match') { const won = m.winner === side; ui.matchResult(won, m.score[side], m.score[1 - side], oppName); ui.setServe(null);
    setTimeout(() => { if (ui.currentOverlay() === 'match') ui.showOverlay(null); }, 6000);        // normally the next 'serve' closes it after 5 s
    if (won) { ui.confetti(['#3aa0ff', '#ffd34a', '#3ecf72', '#ffffff'], 120); setTimeout(() => ui.confetti(['#3aa0ff', '#ffd34a', '#ffffff'], 80), 900); } return; }
  if (m.type === 'whiff') stats.whiffs++;                        // no commentary: you can see that you missed
  if (m.type === 'point' && !m.final) { const won = m.winner === side;
    ui.pointBanner(won);                                         // exactly "Your point!" / "Enemy’s point!", nothing else
    if (won) ui.confetti(['#3aa0ff', '#ffd34a', '#ffffff']); }
  scene.onEvent(m);
});

setInterval(() => {                               // 20Hz: tell the server where my paddle is
  if (calibrating) return;
  const p = model.pose(performance.now());
  if (p.calibrated) game.send({ type: 'paddle', auto: autoNow(), autoY: mode === 'auto', x: (usingBody() ? bodyX : p.x) * s(), y: usingBody() ? bodyY : p.y, z: usingBody() && !autoNow() ? bodyZ : undefined, q: p.Pd });
}, 50);

// ---------- input ----------
let unlocked = false;
const unlock = () => { if (!unlocked) { unlocked = true; scene.unlockAudio(); } };
addEventListener('pointerdown', () => { unlock(); begin(); });
ui.onStart(() => { unlock(); ui.fullscreen(true); begin(); });          // the big title button (a click is a user gesture: go full screen)
ui.onRetry(() => location.reload());
addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.altKey || ['Meta', 'Control', 'Alt', 'Shift', 'CapsLock', 'Tab'].includes(e.key)) return;   // browser shortcuts are not ours
  unlock();
  const k = e.key.toLowerCase();
  if (k === 'f') { ui.fullscreen(); return; }
  if (phase === 'title') { if (k === ' ' || k === 'enter') { e.preventDefault(); ui.fullscreen(true); } begin(); if (k !== 'c') return; }   // first gesture: any key starts
  if (k === 'c') startCal();
  if (k === 'r') { model.recenter(); if (body) body.center(); say('Re-centered'); }
  if (k === 'p') resetPeaks();
  if (k === 'v') ui.toggle('podwrap');
  if (k === 'h') ui.toggle('dev');
  if (k === 'm') { let i = MODES.indexOf(mode); do { i = (i + 1) % 3; } while (MODES[i] === 'body' && !(body && body.ready)); setMode(MODES[i]); }
  if (k === '[' || k === ']') {                                  // [ = less sensitive, ] = more, for whichever move mode is on
    if (usingBody()) { body.reach = Math.max(0.08, Math.min(0.42, body.reach + (k === ']' ? -0.03 : 0.03))); say(`Range: move ${(body.reach * 100).toFixed(0)}% of the camera view to reach the sideline`); }
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
  if (phase !== 'title' && ui.isVisible('podwrap')) pod.update(p.Pd);
  scene.render(now);
})(performance.now());

addEventListener('error', () => stats.errors++);
