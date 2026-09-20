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
const MODES = ['body', 'auto', 'aim'], MODE_TEXT = { body: 'Body Move — step left and right, the camera follows you', auto: 'Auto Move — the game runs for you, just swing', aim: 'Aim Move — turn your wrist to move' }, MODE_NAME = { body: 'Body', auto: 'Auto', aim: 'Aim' };
let sideDeg = 75, bodyZ = 6.5, walkV = 0, walkHold = 0, bodyY = 1.0, vX = 0, vY = 0, lastFrame = performance.now();
// critically damped follow (frame-rate independent): smooth, no overshoot
function damp(cur, target, vel, smooth, dt) { const o = 2 / smooth, x = o * dt, e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x), ch = cur - target, tmp = (vel + o * ch) * dt; return [target + (ch + tmp) * e, (vel - o * tmp) * e]; }
let mode = MODES.includes(qs.get('move')) ? qs.get('move') : 'body', body = null, bodyX = 0;
if (qs.get('cam') !== '0') createBodyTracker($('camv'), $('camc')).then(t => {
  body = t; $('camwrap').hidden = !t.ready;
  if (!t.ready) { console.warn('camera tracking unavailable:', t.error); if (mode === 'body') setMode('aim'); }
});
function setMode(m) { mode = m; $('mode').textContent = MODE_NAME[m]; say(MODE_TEXT[m], '#ffe066', 1800); }
const usingBody = () => mode === 'body' && body && body.ready;
const autoNow = () => mode === 'auto' || (mode === 'body' && !(body && body.seen()));   // lost your face: the game runs for you until it's back
const s = () => (side === 0 ? 1 : -1);

// ---------- messages ----------
let sayT;
function say(text, _color, ms = 1200) {                       // small pill toast
  const el = $('msg'); el.textContent = text; el.classList.add('on');
  clearTimeout(sayT); sayT = setTimeout(() => el.classList.remove('on'), ms);
}
const pop = el => { el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop'); };
function banner(title, sub, color, long) {
  const b = $('banner'); $('bh').textContent = title; $('bp').textContent = sub || '';
  $('rib').style.background = color; b.classList.remove('show', 'long'); void b.offsetWidth; b.classList.add('show'); if (long) b.classList.add('long');
}
function confetti(colors, n = 46) {
  for (let i = 0; i < n; i++) { const c = document.createElement('div'); c.className = 'confetti';
    c.style.left = Math.random() * 100 + 'vw'; c.style.background = colors[i % colors.length];
    c.style.setProperty('--dx', (Math.random() * 30 - 15) + 'vw'); c.style.setProperty('--rot', (Math.random() * 1400 - 700) + 'deg');
    c.style.animationDuration = 1.4 + Math.random() * 1.2 + 's'; c.style.animationDelay = Math.random() * 0.25 + 's';
    document.body.appendChild(c); setTimeout(() => c.remove(), 3200); }
}
let rally = 0, meterT;
function hitFx(mine, n, kind) {
  if (!mine) return;
  const w = $('hitword'); w.textContent = kind === 'dink' ? 'DINK!' : kind === 'lob' ? 'LOB!' : kind === 'smash' ? 'SMASH!' : n > 0.55 ? 'GREAT!' : n > 0.3 ? 'NICE!' : 'GOT IT';
  w.style.color = n > 0.8 ? '#ff5a3d' : n > 0.55 ? '#ffe066' : '#ffffff';
  w.classList.remove('go'); $('flash').classList.remove('go'); void w.offsetWidth; w.classList.add('go'); $('flash').classList.add('go');
  $('meterf').style.width = Math.round(12 + n * 88) + '%'; $('meter').classList.add('on');
  clearTimeout(meterT); meterT = setTimeout(() => $('meter').classList.remove('on'), 900);
}
// why a point ended, from each side's point of view
const WHY_WON = { 'double bounce': 'They couldn’t reach it', out: 'Their shot went out', passed: 'Too fast for them' };
const WHY_LOST = { 'double bounce': 'It bounced twice on your side', out: 'Your shot went out', passed: 'It got past you' };
let oppName = 'Opponent';

// ---------- peak logger ----------
let peaks = [], sessionPeak = 0, log10 = [];
function logSwing(e) {
  const pk = e.peak, tag = `${e.counted ? pk.toFixed(0) : '×'}(${e.rom.toFixed(0)}°)`;
  log10.push(tag); if (log10.length > 5) log10.shift();
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
  $('calh').textContent = tilt ? 'Tip it up' : 'Hold your grip';
  $('st1').className = tilt ? '' : 'on'; $('st2').className = tilt ? 'on' : '';
  $('calp').textContent = tilt
    ? 'Tip the front of the AirPod up toward the ceiling, like raising a paddle. This teaches the game which way is up for your grip.'
    : 'Stand where the camera can see you. Hold the AirPod the way you’d hold a paddle, point it at the screen, and keep it still.';
  $('arc').style.strokeDashoffset = 515 * (1 - e.progress);
  $('arc').style.stroke = e.ok ? '#22c55e' : '#ef4444';
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
    ws.onopen = () => { opened = true; clearTimeout(giveUp); delay = 400; fails = 0; $(el).textContent = 'live'; $('d' + el).classList.add('good');
      if (el === 'g') { $('down').hidden = true; if (i % urls.length > 0 && location.hash) { history.replaceState(null, '', location.pathname + location.search); say('Couldn’t reach the saved address — connected to this Mac instead', null, 2800); } }
      onopen && onopen(); };
    ws.onmessage = e => { try { onmsg(JSON.parse(e.data)); } catch (err) { stats.errors++; console.error(err); } };
    ws.onclose = () => { $(el).textContent = 'off'; $('d' + el).classList.remove('good');
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
    else if (e.type === 'calibrated') { calibrating = false; stats.calibrated = true; $('cal').hidden = true; if (body) body.center(); say('Calibrated — let’s play!'); }
    else if (e.type === 'swing') { stats.swings++; if (!calibrating) game.send({ type: 'swing', power: e.power, dir: e.dir, lob: e.lob }); }
    else if (e.type === 'swingEnd') logSwing(e);
  }
});

const game = connect(HOST === 'localhost' ? GAME : [GAME, `ws://localhost:${qs.get('game') || 8080}`], 'g', m => {
  stats.events[m.type] = (stats.events[m.type] || 0) + 1;
  if (m.type === 'welcome') {
    side = m.side; $('sidelbl').textContent = side === 0 ? 'Near side' : 'Far side';
    scene.setCourt(m.court); scene.setSide(side);
    if (AUTOBOT) game.send({ type: 'bot' });
    return;
  }
  if (m.type === 'state') {
    state = m; scene.updateBall(m.p, m.v, m.live);
    for (const [id, v] of [['sc-me', m.score[side]], ['sc-them', m.score[1 - side]]]) if ($(id).textContent !== String(v)) { $(id).textContent = v; pop($(id)); }
    const o = m.paddles[1 - side];
    players = o ? 2 : 1; if (!o) { $('themname').textContent = 'Waiting…'; } else if (!o.bot) { oppName = 'Player 2'; $('themname').textContent = oppName; $('bot').textContent = 'Far side'; }
    if (o) scene.updatePaddle(1 - side, { x: o.x, y: o.y, z: o.z, q: o.q, offset: null, bot: !!o.bot });
    return;
  }
  if (m.type === 'botinfo') {
    if (m.active) { oppName = m.name + ' Bot'; $('themname').textContent = oppName; $('bot').textContent = 'Press B to change level'; } else $('bot').textContent = 'Press B to add a bot';
    if (m.reason) say('Can’t add a bot — two players are connected', null, 1800); else if (m.active) say(`Opponent: ${m.name} Bot`, null, 1400);
    return;
  }
  if (m.type === 'full') { say('This game is full — two players are already connected', null, 4000); return; }
  if (m.type === 'hit') { stats.hits++; if (m.side === side) stats.myHits++; rally++; $('rally').textContent = rally; pop($('rally')); hitFx(m.side === side, m.n, m.kind); }
  if (m.type === 'serve') { bodyZ = 6.5; walkV = 0; if (m.wait) if (m.by === side) say('Your serve — swing to hit it!', null, 2600); rally = 0; $('rally').textContent = 0; $('sv-me').classList.toggle('on', m.by === side); $('sv-them').classList.toggle('on', m.by !== side); }
  if (m.type === 'match') { const won = m.winner === side; banner(won ? 'YOU WIN!' : `${oppName.toUpperCase()} WINS`, `${m.score[side]} – ${m.score[1 - side]} · New game starting…`, won ? 'linear-gradient(#2f8cff,#1463d8)' : 'linear-gradient(#ff7a3d,#e4521b)', true); if (won) { confetti(['#2f8cff', '#ffc83d', '#22c55e', '#ffffff'], 120); setTimeout(() => confetti(['#2f8cff', '#ffc83d', '#ffffff'], 80), 900); } return; }
  if (m.type === 'whiff') stats.whiffs++;                        // no commentary: you can see that you missed
  if (m.type === 'point' && !m.final) { const won = m.winner === side;
    banner(won ? (rally >= 6 ? 'WHAT A RALLY!' : 'POINT!') : `${oppName.toUpperCase()} SCORES`, (won ? WHY_WON : WHY_LOST)[m.why] || '', won ? 'linear-gradient(#2f8cff,#1463d8)' : 'linear-gradient(#ff7a3d,#e4521b)');
    if (won) confetti(['#2f8cff', '#ffc83d', '#ffffff']); }
  scene.onEvent(m);
});

setInterval(() => {                               // 20Hz: tell the server where my paddle is
  if (calibrating) return;
  const p = model.pose(performance.now());
  if (p.calibrated) game.send({ type: 'paddle', auto: autoNow(), autoY: mode === 'auto', x: (usingBody() ? bodyX : p.x) * s(), y: usingBody() ? bodyY : p.y, z: usingBody() && !autoNow() ? bodyZ : undefined, q: p.P });
}, 50);

// ---------- input ----------
let unlocked = false;
const unlock = () => { if (!unlocked) { unlocked = true; scene.unlockAudio(); } };
addEventListener('pointerdown', unlock);
addEventListener('keydown', e => {
  unlock();
  const k = e.key.toLowerCase();
  if (k === 'c') startCal();
  if (k === 'r') { model.recenter(); if (body) body.center(); say('Re-centered'); }
  if (k === 'p') resetPeaks();
  if (k === 'v') $('podwrap').hidden = !$('podwrap').hidden;
  if (k === 'h') $('dev').hidden = !$('dev').hidden;
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
