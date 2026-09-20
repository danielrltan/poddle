// Glue: AirPod bridge -> MotionModel -> scene + game server.
import { MotionModel } from './motion.js';
import { createScene } from './scene.js';
import { createPodView } from './podview.js';
import { createBodyTracker } from './bodytrack.js';

const $ = id => document.getElementById(id);
const qs = new URLSearchParams(location.search);
const HOST = qs.get('host') || location.hash.slice(1) || 'localhost';      // player 2:  /#<server-ip>
const BRIDGE = `ws://localhost:${qs.get('bridge') || 8787}`;
const GAME = `ws://${HOST}:${qs.get('game') || 8080}`;
const AUTOBOT = qs.get('autobot') === '1';

const model = new MotionModel();
const scene = createScene($('stage'));
const pod = createPodView($('pod'));
$('downurl').textContent = GAME;
const stats = window.__stats = { get cam() { return body ? { ready: body.ready, error: body.error, seen: body.seen(), fps: Math.round(body.fps), via: body.via } : null; }, hits: 0, myHits: 0, whiffs: 0, swings: 0, errors: 0, paddlePath: 0, calibrated: false, events: {} };

let side = 0, state = null, players = 0, calibrating = true;
// body: webcam tracks where you actually stand. auto: server runs you to the ball. aim: wrist angle moves you.
const MODES = ['body', 'auto', 'aim'], MODE_TEXT = { body: 'body-move: step left and right, the camera follows you', auto: 'auto-move: you just swing', aim: 'aim-move: turn your wrist to move' };
let sideDeg = 75, bodyY = 1.0, vX = 0, vY = 0, lastFrame = performance.now();
// critically damped follow (frame-rate independent): smooth, no overshoot
function damp(cur, target, vel, smooth, dt) { const o = 2 / smooth, x = o * dt, e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x), ch = cur - target, tmp = (vel + o * ch) * dt; return [target + (ch + tmp) * e, (vel - o * tmp) * e]; }
let mode = MODES.includes(qs.get('move')) ? qs.get('move') : 'body', body = null, bodyX = 0;
if (qs.get('cam') !== '0') createBodyTracker($('camv'), $('camc')).then(t => {
  body = t; $('camwrap').hidden = !t.ready;
  if (!t.ready) { console.warn('camera tracking unavailable:', t.error); if (mode === 'body') setMode('aim'); }
});
function setMode(m) { mode = m; $('mode').textContent = m; say(MODE_TEXT[m], '#ffe066', 1800); }
const usingBody = () => mode === 'body' && body && body.ready;
const autoNow = () => mode === 'auto' || (mode === 'body' && !(body && body.seen()));   // lost your face: the game runs for you until it's back
const s = () => (side === 0 ? 1 : -1);

// ---------- messages ----------
let sayT;
function say(text, color = '#e6edf3', ms = 1100) {
  const el = $('msg'); el.textContent = text; el.style.color = color; el.style.opacity = 1;
  clearTimeout(sayT); sayT = setTimeout(() => (el.style.opacity = 0), ms);
}
const WHIFF = { early: 'too early', late: 'too late', left: 'ball was to your left', right: 'ball was to your right', high: 'ball was above you', low: 'ball was below you' };

// ---------- peak logger ----------
let peaks = [], sessionPeak = 0, log10 = [];
function logSwing(e) {
  const pk = e.peak, tag = `${e.counted ? pk.toFixed(0) : '×'}(${e.rom.toFixed(0)}°)`;
  log10.push(tag); if (log10.length > 8) log10.shift();
  $('pklist').textContent = log10.join('  ');
  console.log(`swing power=${pk.toFixed(1)} raw=${e.raw.toFixed(1)} rad/s rom=${e.rom.toFixed(0)}deg counted=${e.counted}`);
  if (!e.counted) return;
  peaks.push(pk); sessionPeak = Math.max(sessionPeak, pk);
  $('sw').textContent = peaks.length;
  $('pkmax').textContent = sessionPeak.toFixed(1);
  $('pkavg').textContent = (peaks.reduce((a, b) => a + b, 0) / peaks.length).toFixed(1);
  $('barpk').style.left = Math.min(100, sessionPeak / 40 * 100) + '%';
}
function resetPeaks() { peaks = []; log10 = []; sessionPeak = 0; $('sw').textContent = '0'; $('pkmax').textContent = '0.0'; $('pkavg').textContent = '–'; $('pklist').textContent = '–'; $('barpk').style.left = '0'; }

// ---------- calibration overlay ----------
function showCal(e) {
  $('cal').hidden = false;
  const tilt = e.stage === 'tilt';
  $('calh').textContent = tilt ? 'Step 2 of 2 — tip it up' : 'Step 1 of 2 — hold your grip';
  $('calp').textContent = tilt
    ? 'Now tip the front of the AirPod UP toward the ceiling, like raising a paddle. This tells the game which way is up and which way is right for your grip.'
    : "Stand centred in the camera view (any distance, as long as it can see you). Hold the AirPod the way you'd hold a paddle, pointed at the screen, and keep it still.";
  $('arc').style.strokeDashoffset = 534 * (1 - e.progress);
  $('arc').style.stroke = e.ok ? '#4ade80' : '#ff6b6b';
  $('calmsg').textContent = e.msg; $('calmsg').className = e.ok ? 'good' : 'bad';
}
function startCal() { calibrating = true; stats.calibrated = false; model.startCalibration(); $('cal').hidden = false; }

// ---------- sockets (auto-reconnect) ----------
// urls: tried in turn until one opens. A stale '#<old-ip>' in the address bar must never strand you: this machine's
// own server is always the second candidate, and when it wins the dead address is dropped from the URL.
function connect(urls, el, onmsg, onopen) {
  urls = [].concat(urls); let ws, delay = 400, i = 0, fails = 0;
  const open = () => {
    const url = urls[i % urls.length]; let opened = false;
    ws = new WebSocket(url);
    const sock = ws, giveUp = setTimeout(() => { if (!opened) sock.close(); }, 1500);       // a dead IP just hangs: don't wait for TCP to time out
    ws.onopen = () => { opened = true; clearTimeout(giveUp); delay = 400; fails = 0; $(el).textContent = 'live'; $(el).className = 'good';
      if (el === 'g') { $('down').hidden = true; if (i % urls.length > 0 && location.hash) { history.replaceState(null, '', location.pathname + location.search); say(`old address unreachable — using this Mac's game server`, '#ffe066', 2500); } }
      onopen && onopen(); };
    ws.onmessage = e => { try { onmsg(JSON.parse(e.data)); } catch (err) { stats.errors++; console.error(err); } };
    ws.onclose = () => { $(el).textContent = 'off'; $(el).className = 'bad';
      if (!opened) { i++; fails++; }                                   // never connected: try the next candidate
      if (el === 'g' && fails >= urls.length) { $('downurl').textContent = urls.join('  or  '); $('down').hidden = false; }
      setTimeout(open, opened ? 300 : delay); delay = Math.min(delay * 1.5, 3000); };
    ws.onerror = () => {};
  };
  open();
  return { send: m => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); } };
}

const bridge = connect(BRIDGE, 'm', sample => {
  const power = Math.hypot(sample.r[0], sample.r[1], sample.r[2]);
  $('pw').textContent = power.toFixed(1);
  $('barf').style.width = Math.min(100, power / 40 * 100) + '%';
  for (const e of model.feed(sample, performance.now())) {
    if (e.type === 'cal') showCal(e);
    else if (e.type === 'calibrated') { calibrating = false; stats.calibrated = true; $('cal').hidden = true; if (body) body.center(); say('calibrated', '#4ade80'); }
    else if (e.type === 'swing') { stats.swings++; if (!calibrating) game.send({ type: 'swing', power: e.power, dir: e.dir, lob: e.lob }); }
    else if (e.type === 'flick') { if (!calibrating) say(`too small (${e.rom.toFixed(0)}°) — swing your whole arm`, '#ffe066', 1200); }
    else if (e.type === 'swingEnd') logSwing(e);
  }
});

const game = connect(HOST === 'localhost' ? GAME : [GAME, `ws://localhost:${qs.get('game') || 8080}`], 'g', m => {
  stats.events[m.type] = (stats.events[m.type] || 0) + 1;
  if (m.type === 'welcome') {
    side = m.side; $('side').textContent = side === 0 ? 'near (0)' : 'far (1)';
    scene.setCourt(m.court); scene.setSide(side);
    if (AUTOBOT) game.send({ type: 'bot' });
    return;
  }
  if (m.type === 'state') {
    state = m; scene.updateBall(m.p, m.v, m.live);
    $('score').textContent = `${m.score[side]} : ${m.score[1 - side]}`;
    const o = m.paddles[1 - side];
    players = o ? 2 : 1;
    if (o) scene.updatePaddle(1 - side, { x: o.x, y: o.y, z: o.z, q: o.q, offset: null, bot: !!o.bot });
    return;
  }
  if (m.type === 'botinfo') {
    $('bot').textContent = m.active ? m.name : 'none';
    if (m.reason) say(`no bot: ${m.reason}`, '#ff6b6b', 1600); else if (m.active) say(`bot: ${m.name}`, '#ffe066', 1300);
    return;
  }
  if (m.type === 'full') { say('game is full (2 players already connected)', '#ff6b6b', 4000); return; }
  if (m.type === 'hit') { stats.hits++; if (m.side === side) stats.myHits++; }
  if (m.type === 'whiff') { stats.whiffs++; say(WHIFF[m.why] || 'missed', '#ff6b6b'); }
  if (m.type === 'point') say(m.winner === side ? `your point — ${m.why}` : `their point — ${m.why}`, m.winner === side ? '#4ade80' : '#ff6b6b', 1400);
  scene.onEvent(m);
});

setInterval(() => {                               // 20Hz: tell the server where my paddle is
  if (calibrating) return;
  const p = model.pose(performance.now());
  if (p.calibrated) game.send({ type: 'paddle', auto: autoNow(), autoY: mode === 'auto', x: (usingBody() ? bodyX : p.x) * s(), y: usingBody() ? bodyY : p.y, q: p.P });
}, 50);

// ---------- input ----------
let unlocked = false;
const unlock = () => { if (!unlocked) { unlocked = true; scene.unlockAudio(); } };
addEventListener('pointerdown', unlock);
addEventListener('keydown', e => {
  unlock();
  const k = e.key.toLowerCase();
  if (k === 'c') startCal();
  if (k === 'r') { model.recenter(); if (body) body.center(); say('re-centered', '#ffe066'); }
  if (k === 'p') resetPeaks();
  if (k === 'v') $('podwrap').hidden = !$('podwrap').hidden;
  if (k === 'm') { let i = MODES.indexOf(mode); do { i = (i + 1) % 3; } while (MODES[i] === 'body' && !(body && body.ready)); setMode(MODES[i]); }
  if (k === '[' || k === ']') {                                  // [ = less sensitive, ] = more, for whichever move mode is on
    if (usingBody()) { body.reach = Math.max(0.08, Math.min(0.42, body.reach + (k === ']' ? -0.03 : 0.03))); say(`move ${(body.reach * 100).toFixed(0)}% of the camera view to reach the sideline`, '#ffe066'); }
    else { sideDeg = Math.max(25, Math.min(90, sideDeg + (k === ']' ? -5 : 5))); model.setSidelineDeg(sideDeg); say(`turn ${sideDeg}° to reach the sideline`, '#ffe066'); }
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
    }
    const auto = autoNow() && mine;
    const wx = auto ? mine.x : (usingBody() ? bodyX : p.x) * s(), wy = auto || (mine && mode === 'auto') ? mine.y : usingBody() ? bodyY : p.y;
    if (auto && usingBody()) { bodyX = mine.x * s(); bodyY = mine.y; vX = vY = 0; }                 // hand back smoothly when the camera finds you again
    scene.updatePaddle(side, { x: wx, y: wy, z, q: p.P, offset: p.offset, bot: false });
    $('px').textContent = (wx * s()).toFixed(1); $('py').textContent = wy.toFixed(1);
    const pos = [p.x + p.offset[0], p.y + p.offset[1], p.offset[2]];
    if (lastPos && p.swinging) stats.paddlePath += Math.hypot(pos[0] - lastPos[0], pos[1] - lastPos[1], pos[2] - lastPos[2]);
    lastPos = pos;
  }
  if (!$('podwrap').hidden) pod.update(p.P);
  scene.render(now);
})(performance.now());

addEventListener('error', () => stats.errors++);
