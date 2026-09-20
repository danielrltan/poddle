// Glue: AirPod bridge -> MotionModel -> scene + game server.
import { MotionModel } from './motion.js';
import { createScene } from './scene.js';

const $ = id => document.getElementById(id);
const qs = new URLSearchParams(location.search);
const HOST = qs.get('host') || location.hash.slice(1) || 'localhost';      // player 2:  /#<server-ip>
const BRIDGE = `ws://localhost:${qs.get('bridge') || 8787}`;
const GAME = `ws://${HOST}:${qs.get('game') || 8080}`;
const AUTOBOT = qs.get('autobot') === '1';

const model = new MotionModel();
const scene = createScene($('stage'));
const stats = window.__stats = { hits: 0, myHits: 0, whiffs: 0, swings: 0, errors: 0, paddlePath: 0, calibrated: false, events: {} };

let side = 0, state = null, players = 0, calibrating = true;
const s = () => (side === 0 ? 1 : -1);

// ---------- messages ----------
let sayT;
function say(text, color = '#e6edf3', ms = 1100) {
  const el = $('msg'); el.textContent = text; el.style.color = color; el.style.opacity = 1;
  clearTimeout(sayT); sayT = setTimeout(() => (el.style.opacity = 0), ms);
}
const WHIFF = { early: 'too early', late: 'too late', left: 'ball was to your left', right: 'ball was to your right', high: 'ball was above you', low: 'ball was below you' };

// ---------- peak logger ----------
let peaks = [], sessionPeak = 0;
function logSwing(pk) {
  peaks.push(pk); sessionPeak = Math.max(sessionPeak, pk);
  $('sw').textContent = peaks.length;
  $('pkmax').textContent = sessionPeak.toFixed(1);
  $('pkavg').textContent = (peaks.reduce((a, b) => a + b, 0) / peaks.length).toFixed(1);
  $('pklist').textContent = peaks.slice(-10).map(v => v.toFixed(0)).join('  ');
  $('barpk').style.left = Math.min(100, sessionPeak / 40 * 100) + '%';
  console.log(`swing #${peaks.length} peak=${pk.toFixed(1)} rad/s`);
}
function resetPeaks() { peaks = []; sessionPeak = 0; $('sw').textContent = '0'; $('pkmax').textContent = '0.0'; $('pkavg').textContent = '–'; $('pklist').textContent = '–'; $('barpk').style.left = '0'; }

// ---------- calibration overlay ----------
function showCal(e) {
  $('cal').hidden = false;
  const tilt = e.stage === 'tilt';
  $('calh').textContent = tilt ? 'Step 2 of 2 — tip it up' : 'Step 1 of 2 — hold your grip';
  $('calp').textContent = tilt
    ? 'Now tip the front of the AirPod UP toward the ceiling, like raising a paddle. This tells the game which way is up and which way is right for your grip.'
    : "Hold the AirPod the way you'd hold a paddle, pointed at the screen, and keep it still.";
  $('arc').style.strokeDashoffset = 534 * (1 - e.progress);
  $('arc').style.stroke = e.ok ? '#4ade80' : '#ff6b6b';
  $('calmsg').textContent = e.msg; $('calmsg').className = e.ok ? 'good' : 'bad';
}
function startCal() { calibrating = true; stats.calibrated = false; model.startCalibration(); $('cal').hidden = false; }

// ---------- sockets (auto-reconnect) ----------
function connect(url, el, onmsg, onopen) {
  let ws, delay = 500;
  const open = () => {
    ws = new WebSocket(url);
    ws.onopen = () => { delay = 500; $(el).textContent = 'live'; $(el).className = 'good'; onopen && onopen(); };
    ws.onmessage = e => { try { onmsg(JSON.parse(e.data)); } catch (err) { stats.errors++; console.error(err); } };
    ws.onclose = () => { $(el).textContent = 'off'; $(el).className = 'bad'; setTimeout(open, delay); delay = Math.min(delay * 1.7, 4000); };
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
    else if (e.type === 'calibrated') { calibrating = false; stats.calibrated = true; $('cal').hidden = true; say('calibrated', '#4ade80'); }
    else if (e.type === 'swing') { stats.swings++; if (!calibrating) game.send({ type: 'swing', power: e.power, dir: e.dir, lob: e.lob }); }
    else if (e.type === 'swingEnd') logSwing(e.peak);
  }
});

const game = connect(GAME, 'g', m => {
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
    players = o ? 2 : 1; $('bothint').hidden = !!o;
    if (o) scene.updatePaddle(1 - side, { x: o.x, y: o.y, z: o.z, q: o.q, offset: null, bot: !!o.bot });
    return;
  }
  if (m.type === 'hit') { stats.hits++; if (m.side === side) stats.myHits++; }
  if (m.type === 'whiff') { stats.whiffs++; say(WHIFF[m.why] || 'missed', '#ff6b6b'); }
  if (m.type === 'point') say(m.winner === side ? `your point — ${m.why}` : `their point — ${m.why}`, m.winner === side ? '#4ade80' : '#ff6b6b', 1400);
  scene.onEvent(m);
});

setInterval(() => {                               // 20Hz: tell the server where my paddle is
  if (calibrating) return;
  const p = model.pose(performance.now());
  if (p.calibrated) game.send({ type: 'paddle', x: p.x * s(), y: p.y, q: p.P });
}, 50);

// ---------- input ----------
let unlocked = false;
const unlock = () => { if (!unlocked) { unlocked = true; scene.unlockAudio(); } };
addEventListener('pointerdown', unlock);
addEventListener('keydown', e => {
  unlock();
  const k = e.key.toLowerCase();
  if (k === 'c') startCal();
  if (k === 'r') { model.recenter(); say('re-centered', '#ffe066'); }
  if (k === 'p') resetPeaks();
  if (k === 'b') { game.send({ type: 'bot' }); say('bot requested', '#ffe066'); }
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
    scene.updatePaddle(side, { x: p.x * s(), y: p.y, z, q: p.P, offset: p.offset, bot: false });
    $('px').textContent = p.x.toFixed(1); $('py').textContent = p.y.toFixed(1);
    const pos = [p.x + p.offset[0], p.y + p.offset[1], p.offset[2]];
    if (lastPos && p.swinging) stats.paddlePath += Math.hypot(pos[0] - lastPos[0], pos[1] - lastPos[1], pos[2] - lastPos[2]);
    lastPos = pos;
  }
  scene.render(now);
})(performance.now());

addEventListener('error', () => stats.errors++);
