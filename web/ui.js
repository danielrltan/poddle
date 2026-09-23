// Poddle UI: every bit of DOM work for the HUD and the screens lives here. No game logic, no sockets, no three.js.
// Design system: ui.css · markup: index.html · spec, copy and this API: docs/ui-spec.md
const $ = id => document.getElementById(id);
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const restart = (el, cls) => { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); };   // replay a one-shot CSS animation
const setText = (el, t) => { if (el && el.textContent !== t) el.textContent = t; };       // names arrive here: textContent only, never markup
const on2 = (id, type, fn) => { const el = $(id); if (el) el.addEventListener(type, fn); };      // every new element is optional (older markup, a test page)

// Shot names for the hit callout. Add new kinds here; an unknown kind falls back to its own name, capitalised.
export const SHOTS = { dink: 'Dink', lob: 'Lob', tap: 'Tap', drive: 'Drive', smash: 'Smash', block: 'Block' };
export const shotName = kind => !kind ? '' : SHOTS[kind] || String(kind).replace(/[_-]+/g, ' ').replace(/^./, c => c.toUpperCase());

// ---------- screens ----------
// Two independent slots. Menu screens (title and lobby on glass over the live court; connect and calibrate opaque) cover everything; overlays (match, server-down,
// game-full) sit over the court, under any menu screen (ui.css lifts game-full above them: that one cannot wait). The HUD leaves the render tree under a menu screen.
const MENU = ['title', 'lobby', 'connect', 'calibrate'], OVERLAY = ['match', 'server-down', 'game-full'];
const screenEl = name => document.querySelector(`.screen[data-screen="${name}"]`);
const slots = { menu: null, overlay: null }, hideT = {};
function swap(slot, name) {
  const prev = slots[slot];
  if (prev !== name) {
    slots[slot] = name;
    if (prev) { const el = screenEl(prev); el.classList.remove('is-active'); clearTimeout(hideT[prev]); hideT[prev] = setTimeout(() => { el.hidden = true; }, 360); }   // after the fade: out of the render tree
    if (name) { const el = screenEl(name); clearTimeout(hideT[name]); el.hidden = false; void el.offsetWidth; el.classList.add('is-active'); }
  }
  const b = document.body, hud = $('hud');
  b.dataset.screen = slots.menu || 'hud';
  if (slots.overlay) b.dataset.overlay = slots.overlay; else delete b.dataset.overlay;
  if (slots.menu || slots.overlay) settings(false);                                  // the card belongs to the open court. (Closing fires its callback: a pause must not outlive the panel)
  if (slots.menu !== 'lobby') askWatch(null);
  if (slots.overlay === 'match') hold(null); else stopCount();                        // the result replaces the hold card; leaving the result stops its countdown
  clearTimeout(hideT.hud);
  if (slots.menu) { if (!hud.hidden) hideT.hud = setTimeout(() => { hud.hidden = true; }, 360); }
  else if (hud.hidden) { hud.hidden = false; wake(); }
}
export function showScreen(name) { swap('menu', MENU.includes(name) ? name : null); }
export function showOverlay(name) { swap('overlay', OVERLAY.includes(name) ? name : null); }
export const currentScreen = () => slots.menu;
export const currentOverlay = () => slots.overlay;

// ---------- scoreboard ----------
export function setNames({ me, meSub, them, themSub } = {}) {
  if (me != null) setText($('name-me'), me); if (meSub != null) setText($('sub-me'), meSub);
  if (them != null) setText($('name-them'), them); if (themSub != null) setText($('sub-them'), themSub);
}
export function setScore(me, them) {
  for (const [id, v] of [['sc-me', me], ['sc-them', them]]) { const el = $(id); if (el.textContent !== String(v)) { el.textContent = v; restart(el, 'pop'); } }
}
export function setServe(who) { $('sv-me').classList.toggle('on', who === 'me'); $('sv-them').classList.toggle('on', who === 'them'); }
export function setRally(n) { const el = $('rally'); if (el.textContent === String(n)) return; el.textContent = n; if (n > 0) restart(el, 'pop'); }

// ---------- events ----------
export function callout(kind, them = false) {              // only the shot's name, never praise
  const text = shotName(kind); if (!text) return;
  const el = $('callout'); el.textContent = text; el.dataset.text = text; el.classList.toggle('is-them', them); restart(el, 'go');
}
// won: true = mine, false = theirs, null = I am watching (then side says whose colour: 0 blue, 1 orange). "Their point" is only for a caller with no name.
export function pointBanner(won, name = '', side) {
  const b = $('banner'), mine = won === true, blue = won == null ? side !== 1 : mine; name = String(name || '') || (won == null ? (side === 1 ? 'Player 2' : 'Player 1') : '');
  $('banner-text').textContent = mine ? 'Your point' : name ? `${name} scores` : 'Their point';
  b.classList.toggle('is-me', blue); b.classList.toggle('is-them', !blue); restart(b, 'show');
}
// A human took a seat: the same centre banner the points use says who, in the joiner's colour (a player's opponent is always the orange side).
export function joinBanner(name, them = true) {
  const b = $('banner'); if (!b) return; name = String(name || '');
  $('banner-text').textContent = name ? `${name} joined to play` : 'A player joined';
  b.classList.toggle('is-me', !them); b.classList.toggle('is-them', !!them); restart(b, 'show');
}
// The count into a match: n = whole seconds left, 0 or null = gone. Each new number pops once (server/game.js 'countdown').
export function countdown(n) {
  const el = $('count'), b = $('count-n'); if (!el || !b) return;
  if (!n) { el.hidden = true; b.textContent = b.dataset.text = ''; return; }
  const t = String(n); el.hidden = false;
  if (b.textContent !== t) { b.textContent = b.dataset.text = t; restart(el, 'tick'); }
}
let toastT;
export function toast(text, ms = 1200) {
  const el = $('toast'), b = document.body; el.textContent = text; el.classList.add('on'); b.classList.add('has-toast');     // .has-toast: the key strip yields the bottom band
  clearTimeout(toastT); toastT = setTimeout(() => { el.classList.remove('on'); b.classList.remove('has-toast'); }, ms);
}
export function toastOff() { clearTimeout(toastT); $('toast').classList.remove('on'); document.body.classList.remove('has-toast'); }     // the screen it spoke about is gone
export function confettiOff() { for (const c of document.querySelectorAll('.confetti')) c.remove(); }      // the court it fell over is gone
export function confetti(colors, n = 46) {
  if (reduced() || slots.menu) return;                                               // nothing of a game shows over a menu
  const frag = document.createDocumentFragment(), made = [];
  for (let i = 0; i < n; i++) { const c = document.createElement('div'); c.className = 'confetti';
    c.style.left = Math.random() * 100 + 'vw'; c.style.background = colors[i % colors.length];
    c.style.setProperty('--dx', (Math.random() * 30 - 15) + 'vw'); c.style.setProperty('--rot', (Math.random() * 1400 - 700) + 'deg');
    c.style.animationDuration = 1.4 + Math.random() * 1.2 + 's'; c.style.animationDelay = Math.random() * 0.25 + 's';
    frag.appendChild(c); made.push(c); }
  const host = slots.overlay === 'match' ? screenEl('match') : document.body;       // on the result screen: behind the card, never across the score
  host.insertBefore(frag, host.firstChild); setTimeout(() => made.forEach(c => c.remove()), 3200);
}
// o = { won, me, them, nameMe, nameThem, forfeit, role, vote }: me / them are the left and right scores, won = the left side won.
// The old positional call (won, me, them, name) still works and means a room with no vote: the next game starts by itself.
let resultRole = 'player', voted = false, votedYes = false, noCount = false, countT = 0, countLeft = 0, countTotal = 0;
export function matchResult(o, me, them, name) {
  if (o === null || typeof o !== 'object') o = { won: !!o, me, them, nameThem: name, vote: false };
  const won = !!o.won, watching = o.role === 'spectator', nameMe = String(o.nameMe || 'You'), nameThem = String(o.nameThem || 'Opponent'), lost = !watching && !won, vote = !watching && o.vote !== false;
  $('result').classList.toggle('is-lose', lost);
  $('medal').className = 'medal ' + (lost ? 'is-silver' : 'is-gold');
  $('result-title').textContent = watching ? `${won ? nameMe : nameThem} wins` : won ? 'You win!' : `${nameThem} wins`;
  setText($('result-note'), o.forfeit ? `${won ? nameThem : nameMe} left` : '');
  $('tally-sc-me').textContent = o.me ?? 0; $('tally-sc-them').textContent = o.them ?? 0; setText($('tally-name-me'), nameMe); setText($('tally-name-them'), nameThem);
  $('tally-me').classList.toggle('is-winner', won); $('tally-them').classList.toggle('is-winner', !won);
  resultRole = watching ? 'spectator' : 'player'; voted = votedYes = false; noCount = !!o.forfeit; stopCount();      // a forfeit leaves one thing to press (Leave): a bar ticking down beside it read as a rematch clock nobody could answer. The court still closes by itself countTotal = 0; votes = { mine: null, theirs: null, name: nameThem };
  show('rematch-btns', vote); show('rematch-count', false);
  for (const id of ['btn-rematch', 'btn-leave']) { const b = $(id); if (b) { b.disabled = false; b.classList.remove('is-pressed'); } }
  setText($('rematch-note'), watching ? (o.forfeit ? '' : 'Waiting for a rematch') : vote ? '' : 'Rematch starting');
  showOverlay('match');
  if (vote) setTimeout(() => { if (slots.overlay === 'match' && !voted) ($('btn-rematch')?.disabled ? $('btn-leave') : $('btn-rematch'))?.focus({ preventScroll: true, focusVisible: true }); }, 60);
}
function stopCount() { clearInterval(countT); countT = 0; }
function drawCount(n) { countLeft = n; setText($('rematch-left'), String(n)); $('rematch-bar')?.style.setProperty('--p', (countTotal ? Math.min(1, n / countTotal) : 0).toFixed(3)); }
function lockVote(yes) { voted = true; votedYes = yes; for (const [id, mine] of [['btn-rematch', yes], ['btn-leave', !yes]]) { const b = $(id); if (b) { b.disabled = mine || !yes; b.classList.toggle('is-pressed', mine); } } }      // after Rematch, Leave stays open: nobody is locked in for 20 s behind someone who walked off
let onVote = null;
export function onRematch(fn) { onVote = fn; }                                          // Rematch -> fn(true), Leave -> fn(false)
// { mine, theirs, left, name }: each vote true | false | null, a missing key = unchanged. The server only speaks when a vote changes, so the seconds tick here.
let votes = { mine: null, theirs: null, name: '' };
export function rematch(o = {}) {
  if ('mine' in o) { votes.mine = o.mine; if (o.mine === true || o.mine === false) lockVote(o.mine); }      // null never re-opens the buttons: my click may still be on its way
  if ('theirs' in o) { votes.theirs = o.theirs; const r = $('btn-rematch'); if (o.theirs === false && r && !voted) { const had = document.activeElement === r; r.disabled = true; if (had) $('btn-leave')?.focus({ preventScroll: true }); } }      // they left (a forfeit): there is nobody to play again, only Leave
  if (o.name != null) votes.name = String(o.name);
  if (typeof o.left === 'number' && isFinite(o.left)) { const n = Math.max(0, Math.round(o.left)); countTotal = Math.max(countTotal, n) || 1;       // the bar drains from the first number it was given
    stopCount(); show('rematch-count', !noCount); drawCount(n); countT = setInterval(() => { if (countLeft > 0) drawCount(countLeft - 1); else stopCount(); }, 1000); }
  if (resultRole === 'spectator') return;                                                // their note stays "Waiting for a rematch"
  // (after a forfeit the card already says "<name> left" under the title: not twice)
  if ('mine' in o || 'theirs' in o || o.name != null) { const who = votes.name || 'Opponent';
    setText($('rematch-note'), votes.theirs === true ? `${who} wants a rematch` : votes.theirs === false ? ($('result-note')?.textContent ? '' : `${who} left`) : votes.mine === true ? `Waiting for ${who}` : ''); }
}
// seat hold: a small card over the frozen court. main.js calls it once a second with the server's number; hold(null) hides it.
export function hold(name, left) {
  const el = $('hold'); if (!el) return;
  if (name == null || slots.overlay === 'match') { el.hidden = true; return; }
  setText($('hold-text'), `Waiting for ${name}`); setText($('hold-left'), left == null ? '' : String(Math.max(0, Math.round(left)))); el.hidden = false;
}

// ---------- connection status ----------
// What is in the player's hand (NOTES 34): an AirPod through the helper on this Mac, or a phone through its page.
const PADDLE = {
  airpod: { name: 'AirPod', wait: 'Open Poddle Helper, then take one AirPod out and hold it.', bad: 'Signal lost. Check Poddle Helper is open and the AirPod is connected to this Mac.', lost: 'AirPod signal lost', hold: 'Hold the AirPod like a paddle handle, pointing at the screen.', tilt: 'Tip the front up toward the ceiling.', waiting: 'Waiting for the AirPod' },
  phone: { name: 'Phone', wait: 'Scan the code with your phone’s camera.', bad: 'Signal lost. Wake the phone and keep its Poddle page open.', lost: 'Phone signal lost', hold: 'Hold the phone like a paddle handle, edge up, top end pointing at the screen.', tilt: 'Tip the top end up toward the ceiling.', waiting: 'Waiting for the phone' },
};
let paddle = 'airpod';
export function setPaddle(kind) {
  if (!PADDLE[kind] || kind === paddle) return; paddle = kind; const P = PADDLE[kind];
  ROW.airpod.wait = P.wait; ROW.airpod.bad = P.bad; LOST.airpod = P.lost; LEAD.hold = P.hold; LEAD.tilt = P.tilt;
  setText($('row-airpod-name'), P.name); setText($('set-airpod-name'), P.name);
  $('calart')?.classList.toggle('is-phone', kind === 'phone');                                  // the calibration drawing: a phone in the fist, not a bud
  const tog = $('tog-airpod')?.querySelector('span'); setText(tog, kind === 'phone' ? 'Show phone' : 'Show AirPod');
  const v = status.airpod; if (v) { status.airpod = null; setStatus({ airpod: v }); }      // the row says its line again, in the new words
}
export const paddleKind = () => paddle;
// The set-up screen's phone block: the QR (drawn here, no image fetched), the code to type instead, and the footer's way over
// to the other paddle. o = { show, url, code, title, foot, choose, mode }.
let qrFor = '';
export function padPair(o) {
  const box = $('pad-pair'); if (!box) return;
  box.hidden = !o.show; helperCard(); setText($('connect-title'), o.title || '');
  const seg = $('paddle-seg'); if (seg) { seg.hidden = !o.choose; $('connect-title').hidden = !!o.choose;      // where a phone can pair, the switch is the heading
    for (const b of seg.querySelectorAll('[data-paddle]')) b.setAttribute('aria-checked', String(b.dataset.paddle === o.mode)); } setText($('pad-code'), o.code || ''); setText($('connect-foot-text'), o.foot || '');
  if (o.show && o.url && qrFor !== o.url) { qrFor = o.url;
    import('./vendor/qrcode.mjs').then(({ default: qrcode }) => {
      const q = qrcode(0, 'H'); q.addData(o.url); q.make();                   // 'H', not 'M': the phone in the middle covers modules, and only H's 30 % recovery reads through that (NOTES 67)
      $('pad-qr').innerHTML = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true }).replace('</svg>', phoneGlyph(q.getModuleCount() * 4) + '</svg>');
      const g = $('pad-qr').querySelector('svg'); if (g) g.setAttribute('aria-hidden', 'true');
    }).catch(() => { qrFor = ''; }); }
}
// The phone that sits in the middle of the pairing QR, so the code looks like what it is for. Sized from the REAL module
// count (the URL's length moves it), never a fixed number. 28 % of the width is ~8 % of the area: well inside H's budget.
function phoneGlyph(size) {
  const box = Math.round(size * 0.28), at = Math.round((size - box) / 2), pad = Math.round(box * 0.17), inner = box - pad * 2;
  return `<g><rect x="${at}" y="${at}" width="${box}" height="${box}" rx="${Math.round(box * 0.22)}" fill="#fff"/>`
    + `<svg x="${at + pad}" y="${at + pad}" width="${inner}" height="${inner}" viewBox="0 0 24 24" fill="none" stroke="#1b2a33" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">`
    + `<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M10.5 5.5h3"/><path d="M11 18.5h2"/></svg></g>`;      // the same phone as the paddle picker's chip
}
// The AirPod's block (NOTES 36): where the phone's code would be, Poddle Helper to download, until the AirPod answers.
// setPaddle has already been told which paddle it is, and a phone that scanned in makes it 'phone', so no word from main.js.
function helperCard() { const h = $('pad-helper'); if (h) h.hidden = paddle !== 'airpod' || !$('pad-pair')?.hidden || status.airpod === 'ok'; }
export function onPaddleSwap(fn) {                                                           // fn('phone' | 'airpod'): a press on the switch, or an arrow key inside it
  const seg = $('paddle-seg'); if (!seg) return;
  seg.addEventListener('click', e => { const b = e.target.closest('[data-paddle]'); if (!b) return; e.stopPropagation(); fn(b.dataset.paddle); });
  seg.addEventListener('keydown', e => { if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return; e.preventDefault(); e.stopPropagation();
    const on = seg.querySelector('[aria-checked="true"]'), other = [...seg.querySelectorAll('[data-paddle]')].find(b => b !== on); if (other) { other.focus(); fn(other.dataset.paddle); } });
}
const ROW = {
  airpod: { ok: '', wait: 'Open Poddle Helper, then take one AirPod out and hold it.', bad: 'Signal lost. Check Poddle Helper is open and the AirPod is connected to this Mac.' },
  game: { ok: '', wait: 'Finding the game', bad: 'Can’t reach the game. Trying again.' },
  camera: { ok: 'Stand where it can see you.', wait: 'Allow the camera so stepping moves you on court.', bad: 'No camera. The game moves you.', off: 'No camera. The game moves you.' },
};
const STATE_WORD = { ok: 'Ready', wait: 'Waiting', bad: 'Problem', off: 'Off' };
const LOST = { airpod: 'AirPod signal lost', game: 'Reconnecting to the game' };
const status = {}, badSince = {}, told = {};
export function setStatus(next) {
  const now = performance.now();
  for (const key in next) {
    const v = next[key]; if (!ROW[key] || !STATE_WORD[v]) continue;
    if (status[key] !== v) {
      status[key] = v; badSince[key] = v === 'bad' ? now : 0; told[key] = false;
      for (const el of [$('set-' + key), $('row-' + key)]) if (el) { el.classList.remove('is-ok', 'is-wait', 'is-bad', 'is-off'); el.classList.add('is-' + v); }      // the HUD lights are gone: big rows on the set-up screen, small rows in the settings panel
      setText($(`row-${key}-text`), ROW[key][v] || ''); setText($(`row-${key}-state`), STATE_WORD[v]); setText($(`set-${key}-state`), STATE_WORD[v]); { const c = $('set-' + key); if (c) c.title = `${c.querySelector('b')?.textContent || key}: ${STATE_WORD[v]}`; }      // the chip in the settings head says its state on hover
      if (key === 'airpod') helperCard();
    }
    // a lost AirPod or server is the likeliest live failure: after 1.5 s say so where the player is looking, once
    if (LOST[key] && v === 'bad' && !told[key] && !slots.menu && !slots.overlay && now - badSince[key] > 1500) { told[key] = true; toast(LOST[key], 2600); }
  }
}
export function setLink(id, live) { setText($(id), live ? 'live' : 'off'); }          // #m / #g: 'live' | 'off' (tests read #g)
export function setServerAddress(text) { setText($('downurl'), String(text).replace(/wss?:\/\//g, '')); }      // people read 'localhost:8080', not a URL scheme

// ---------- calibration ----------
// e = the MotionModel 'cal' event { stage: 'hold'|'tilt', progress, ok, msg }. The big headline always says what to do NOW
// (it is the only thing read from two metres away), so it follows the event, not just the stage.
const HOLD_SECONDS = 5;
const LEAD = { hold: 'Hold the AirPod like a paddle handle, pointing at the screen.', tilt: 'Tip the front up toward the ceiling.', settle: 'Keep it there until the bar fills.', done: 'Here comes the court.' };
let calPrev = { ok: true, msg: '' }, badUntil = 0, badHead = '';
export function calibrationReset() {
  calPrev = { ok: true, msg: '' }; badUntil = 0;
  calibration({ stage: 'hold', progress: 0, ok: true, msg: '' }, { waiting: true });
}
export function calibration(e, { waiting = false, camLost = false } = {}) {
  const msg = e.msg || '', tilt = e.stage === 'tilt', settle = tilt && msg.startsWith('Good'), done = msg.startsWith('All set');
  let head = done ? 'All set' : settle ? 'Now hold it how you’ll play' : tilt ? (e.ok ? 'Tip it up' : 'Level out, then tip straight up') : (e.ok ? 'Hold still' : 'You moved. Hold still');
  // "You moved" is a single 20 ms sample in the model: hold the red headline long enough to be read
  const now = performance.now(), fresh = !e.ok && now >= badUntil;
  if (!e.ok) { badUntil = now + 1400; badHead = head; }
  const bad = !e.ok || (now < badUntil && !settle && !done && badHead.startsWith(tilt ? 'Level' : 'You'));
  if (bad) head = badHead;
  const h = $('calh'); setText(h, head); h.classList.toggle('is-bad', bad); h.classList.toggle('is-good', done);
  setText($('calp'), LEAD[done ? 'done' : settle ? 'settle' : tilt ? 'tilt' : 'hold']);
  $('st1').className = tilt ? 'is-done' : 'is-on'; $('st2').className = done ? 'is-done' : tilt ? 'is-on' : '';
  $('art-hold').toggleAttribute('hidden', tilt); $('art-tilt').toggleAttribute('hidden', !tilt);
  $('art-arrow').toggleAttribute('hidden', settle || done); $('art-screen').style.opacity = tilt ? .4 : 1;
  const bar = $('cal-bar'); bar.style.setProperty('--p', (done ? 1 : bad ? 0 : Math.max(0, Math.min(1, e.progress))).toFixed(3));       // the whole card follows the held 'bad' flag, not the 20 ms sample
  bar.classList.toggle('is-bad', bad); bar.classList.toggle('is-done', done);
  const count = $('cal-count'), showNum = !tilt;
  count.classList.toggle('is-bad', bad); count.classList.toggle('is-done', done);
  count.style.visibility = settle && !done ? 'hidden' : '';                  // settling: the bar alone counts; a tick would read as 'finished'
  $('cal-num').hidden = !showNum; $('cal-up').toggleAttribute('hidden', showNum || settle || done); $('cal-check').toggleAttribute('hidden', !done);
  if (showNum) setText($('cal-num'), String(bad ? HOLD_SECONDS : Math.max(1, Math.ceil(HOLD_SECONDS * (1 - e.progress)))));
  const m = $('calmsg'); setText(m, waiting ? PADDLE[paddle].waiting : camLost && !tilt ? 'The camera can’t see you. Step into view.' : '');
  // replay the sideways nudge for every new mistake (also a second one in a row), not for every 20 ms sample
  if (fresh || (!e.ok && calPrev.msg !== msg)) restart($('calcard'), 'is-error'); else if (!bad) $('calcard').classList.remove('is-error');
  calPrev = { ok: e.ok, msg };
}

// ---------- small things ----------
export function setMode(name) { setText($('mode'), name); for (const o of $('move-seg')?.children || []) o.setAttribute('aria-checked', String(o.dataset.move === String(name).toLowerCase())); }      // how you move lives in the settings panel now (docs/NEXT.md 14d)
// Matt's level, or null when the other seat is not Matt: the 1 2 3 4 key hint and the settings Difficulty row show only against him
export function setBot(level) { const on = !!level; show('key-bot', on); show('set-bot', on); if (!on) return; setText($('bot-level'), String(level)); for (const o of $('bot-seg')?.children || []) o.setAttribute('aria-checked', String((o.dataset.name || o.textContent) === String(level))); }
export function toggle(id) { const el = $(id); if (!el) return false; el.hidden = !el.hidden; return !el.hidden; }
export function show(id, on) { const el = $(id); if (!el) return false; el.hidden = !on; return !el.hidden; }
export function setCamera(ready) { show('camwrap', !!ready); }
export const isVisible = id => { const el = $(id); return !!el && !el.hidden; };
export function setStat(id, text) { setText($(id), String(text)); }                     // stats panel numbers (#pw, #px, #py, …)
export function fullscreen(on) {
  const d = document;
  if (on === undefined) on = !d.fullscreenElement;
  try { const p = on ? (d.fullscreenElement ? null : d.documentElement.requestFullscreen?.()) : (d.fullscreenElement ? d.exitFullscreen?.() : null); if (p && p.catch) p.catch(() => {}); } catch { /* not allowed: fine */ }
}
const fullSync = () => $('tog-full')?.setAttribute('aria-checked', String(!!document.fullscreenElement));      // the switch follows the browser (F, Esc and the title button change it too)
document.addEventListener('fullscreenchange', fullSync);

// key hints (players) and view chips (spectators): shown on any key press / pointer move and when the HUD first appears, gone six seconds later. Never by game events.
let idleT;
const idle = on => { for (const id of ['keys', 'views']) $(id)?.classList.toggle('is-idle', on); };
export function wake() { idle(false); clearTimeout(idleT); idleT = setTimeout(() => idle(true), 6000); }
addEventListener('keydown', wake); addEventListener('pointermove', wake); addEventListener('pointerdown', wake);

// finished one-shots go back to rest so nothing is left promoted or mid-animation
$('callout').addEventListener('animationend', e => { if (e.target === e.currentTarget) e.currentTarget.classList.remove('go'); });
$('banner').addEventListener('animationend', e => { if (e.animationName === 'banner-drop' || e.animationName === 'banner-hold') e.currentTarget.classList.remove('show'); });
for (const id of ['sc-me', 'sc-them', 'rally']) $(id).addEventListener('animationend', e => e.currentTarget.classList.remove('pop'));
export function onStart(fn) { $('btn-start').addEventListener('click', fn); }
export function onRetry(fn) { $('btn-retry').addEventListener('click', fn); }

// ---------- names ----------
// One name, two fields (lobby and settings panel), kept in localStorage. The server cleans it again: this is only so the player sees what they will get.
const NAME_KEY = 'poddle.name';
const cleanName = t => { const n = [...String(t ?? '').replace(/[\u0000-\u001f\u007f-\u009f\p{Cf}\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180f\u2028-\u202e\u2800\u3164\uffa0\ufff9-\ufffb\u{e0000}-\u{e0fff}<>]/gu, '').replace(/(\p{M}{2})\p{M}+/gu, '$1').replace(/\s+/g, ' ').trim()].slice(0, 12).join('').trim(); return /[\p{L}\p{N}\p{S}\p{P}]/u.test(n) ? n : ''; };      // the server's rule (server/game.js cleanName): a name that draws as nothing is no name
let savedName = ''; try { savedName = cleanName(localStorage.getItem(NAME_KEY)); } catch { /* private window: ask every time */ }
for (const id of ['name-input', 'set-name-input']) { const el = $(id); if (el) { el.value = savedName; el.addEventListener('focus', () => el.select()); } }      // like the code boxes: typing replaces what is there
export const playerName = () => cleanName(($('name-input') || {}).value ?? savedName);
function keepName(from) {                                  // typing in one field shows in the other; an empty name is never stored
  const n = cleanName(from.value); for (const id of ['name-input', 'set-name-input']) { const el = $(id); if (el && el !== from) el.value = n; }
  if (n) { savedName = n; try { localStorage.setItem(NAME_KEY, n); } catch { /* fine */ } }
  nameGate();
}
function nameGate() {                                      // first visit: the choices are dimmed (and say so to a screen reader) until the name has a letter
  const need = !playerName(); $('screen-lobby')?.classList.toggle('needs-name', need); $('name-row')?.classList.remove('is-bad');
  for (const t of document.querySelectorAll('#lobby-home .tile')) { if (need) t.setAttribute('aria-disabled', 'true'); else t.removeAttribute('aria-disabled'); }
}
function needName() {                                      // a seat was asked for with no name: the field says so, nothing is sent
  if (playerName()) return false;
  const row = $('name-row'); if (row) { row.classList.add('is-bad'); restart(row, 'is-error'); } $('name-input')?.focus({ preventScroll: true }); return true;
}

// ---------- settings panel (hamburger). A card, not a screen: inPlay() in main.js stays true and the rally goes on behind it ----------
let setOpen = false, setH = {}, sinkSig = '';
// Why the Output row is not there. browser: no AudioContext.setSinkId (Safari, Firefox). devices: it could move the sound,
// but the browser will not name a single audio device until the page holds MICROPHONE permission — measured, and a camera
// grant does NOT do it (NOTES 64). denied: they said no, and only the browser's own site settings can undo that.
const SINK_HINT = { browser: 'This browser can’t move the game’s sound. Choose your speakers in System Settings › Sound.',
  devices: 'Allow audio once so the browser can list your speakers. Nothing is recorded.',
  denied: 'Audio permission is blocked, so your speakers can’t be listed. Allow it for this site in your browser, or choose them in System Settings › Sound.' };
export function onSettings(h) { setH = h || {}; }                                       // { open(), close(), sens(dir), airpod(on), stats(on), recenter(), leave(), name(text), move(mode), paddle(kind), bot(level), sound(on), sink() }
export function settings(open) {
  if (open === undefined) return setOpen;
  open = !!open && !slots.menu && !slots.overlay; if (open === setOpen) return setOpen;
  const el = $('settings'), btn = $('btn-menu'); if (!el) return false;
  setOpen = open; el.hidden = !open; btn?.setAttribute('aria-expanded', String(open));
  if (open) { document.body.dataset.settings = 'open'; fullSync(); placeSettings(); const n = $('set-name-input'); if (n) n.value = savedName; el.focus({ preventScroll: true }); }      // the card takes focus, not its name field: Esc and the game keys must still reach main.js
  else { delete document.body.dataset.settings; if (el.contains(document.activeElement)) { if (btn && !slots.menu && !slots.overlay) btn.focus({ preventScroll: true }); else document.activeElement.blur(); } }
  const fn = open ? setH.open : setH.close; if (fn) fn();
  return setOpen;
}
function placeSettings() {                                 // under the hamburger; on a narrow window the corner is a column and the scoreboard reaches over the card, so go under those too
  const el = $('settings'), board = $('board'); if (!el || el.hidden) return; let y = 0;
  for (const c of $('corner').children) if (c.id !== 'dev' && c.offsetParent) y = Math.max(y, c.getBoundingClientRect().bottom);
  const r = el.getBoundingClientRect(), b = board ? board.getBoundingClientRect() : null; if (b && b.width && b.left < r.right && b.right > r.left) y = Math.max(y, b.bottom);
  el.style.setProperty('--set-top', `calc(${Math.round(y)}px + .5rem)`);
}
addEventListener('resize', placeSettings);
export function setSettings(o = {}) {
  if (typeof o.sens === 'number') setText($('set-sens-val'), String(Math.round(o.sens)));
  for (const [key, id] of [['sensMin', 'btn-sens-less'], ['sensMax', 'btn-sens-more']]) if (key in o && $(id)) { if (o[key] && document.activeElement === $(id)) $('settings')?.focus({ preventScroll: true }); $(id).disabled = !!o[key]; }   // a disabled button drops focus to <body>: keep it in the card
  for (const [key, id] of [['airpod', 'tog-airpod'], ['sound', 'tog-sound'], ['body', 'tog-body']]) if (key in o) $(id)?.setAttribute('aria-checked', String(!!o[key]));
  // Output: the row shows only when the sound can actually be moved AND the browser is willing to name the devices.
  // Otherwise the hint says which of the two is missing, rather than leaving a dead control on screen.
  if ('sinkWhy' in o) { show('set-sink', !o.sinkWhy); show('sink-hint', !!o.sinkWhy); if (o.sinkWhy) setText($('sink-hint'), SINK_HINT[o.sinkWhy] || SINK_HINT.browser);
    show('btn-find-sinks', o.sinkWhy === 'devices'); }      // only 'devices' is fixable from here: a button that asks, once
  if ('sinks' in o) { const s = $('set-sink-sel'), sig = JSON.stringify(o.sinks);           // rebuilt only when the devices really changed: never under the player's finger while the list is open
    if (s && sig !== sinkSig) { sinkSig = sig; const keep = s.value;
      s.replaceChildren(...(o.sinks || []).map(d => { const op = document.createElement('option'); op.value = d.id; op.textContent = d.label; return op; }));      // device names are the system's text: textContent only
      s.value = o.sink != null ? o.sink : keep; if (!s.selectedOptions.length) s.value = ''; } }
  if ('sink' in o) { const s = $('set-sink-sel'); if (s && s.value !== o.sink) s.value = o.sink || ''; }
  if ('inRoom' in o) show('btn-leave-room', !!o.inRoom);
  if ('forfeit' in o) setText($('btn-leave-room'), o.forfeit ? 'Forfeit' : 'Leave court');      // mid-match against a person, leaving is a forfeit: the button says so
  if ('canPause' in o) show('set-note', o.canPause === false);
  if ('bodyOk' in o) { const b = $('move-seg')?.querySelector('[data-move="body"]'); if (b) b.disabled = !o.bodyOk; show('move-note', !o.bodyOk); }      // no camera: Body cannot be picked, and the row says why
  if ('spectator' in o) $('settings')?.classList.toggle('is-spectator', !!o.spectator);
  if ('paddle' in o) { show('set-paddle', !!o.paddle); for (const b of $('paddle-seg2')?.children || []) b.setAttribute('aria-checked', String(b.dataset.paddle === o.paddle)); }      // null: only an AirPod can be the paddle here, nothing to pick
}
export function setPaused(on) {                            // the rest is CSS: blur behind the open card, the "Paused" tag while it is closed
  if (on) document.body.dataset.paused = '1'; else delete document.body.dataset.paused;
  setText($('set-title'), on ? 'Paused' : 'Settings');
}
{
  on2('btn-menu', 'click', () => settings(!setOpen));
  addEventListener('pointerdown', e => { if (setOpen && !e.target.closest?.('#settings, #btn-menu')) settings(false); });
  const call = (k, ...a) => { if (setH[k]) setH[k](...a); };
  on2('btn-sens-less', 'click', () => call('sens', -1)); on2('btn-sens-more', 'click', () => call('sens', 1));
  for (const [id, k] of [['tog-airpod', 'airpod'], ['tog-sound', 'sound'], ['tog-body', 'body']]) on2(id, 'click', e => call(k, e.currentTarget.getAttribute('aria-checked') !== 'true'));      // the NEW value; main.js answers with setSettings
  on2('set-sink-sel', 'change', e => call('sink', e.currentTarget.value));      // main.js answers with setSettings: if the device refuses, the row goes back by itself
  on2('btn-find-sinks', 'click', () => call('findSinks'));
  on2('tog-full', 'click', () => fullscreen());
  on2('move-seg', 'click', e => { const o = e.target.closest('[data-move]'); if (o && !o.disabled) call('move', o.dataset.move); });      // main.js answers with setMode / setBot: the UI flips nothing itself
  on2('paddle-seg2', 'click', e => { const o = e.target.closest('[data-paddle]'); if (o) call('paddle', o.dataset.paddle); });      // phone <-> AirPod at any time, not only on the set-up screen
  on2('bot-seg', 'click', e => { const o = e.target.closest('[data-level]'); if (o) call('bot', +o.dataset.level); });
  on2('btn-recenter', 'click', () => call('recenter')); on2('btn-leave-room', 'click', () => call('leave'));
  // name: saved on Enter / blur. Empty puts the old one back. Esc cancels the edit and hands focus back to the card (main.js owns what Esc does next)
  const commit = el => { const n = cleanName(el.value); if (!n) { el.value = savedName; return; } const changed = n !== savedName; el.value = n; keepName(el); if (changed) call('name', n); };
  on2('set-name-input', 'blur', e => commit(e.currentTarget));
  on2('set-name-input', 'keydown', e => { if (e.key === 'Enter') { e.preventDefault(); commit(e.currentTarget); $('settings').focus({ preventScroll: true }); } else if (e.key === 'Escape') { e.currentTarget.value = savedName; $('settings').focus({ preventScroll: true }); } });
  // Up / Down walk the card's controls (Tab works too)
  on2('settings', 'keydown', e => { const d = { ArrowDown: 1, ArrowUp: -1 }[e.key]; if (!d || document.activeElement?.tagName === 'SELECT') return;      // on the Output row the arrows are the list's own: Tab leaves it
    const nav = [...$('settings').querySelectorAll('button, input, select')].filter(b => !b.disabled && b.offsetParent), i = nav.indexOf(document.activeElement);      // select: Down from the row above still lands on it
    if (!nav.length) return; e.preventDefault(); nav[(i < 0 ? (d > 0 ? 0 : nav.length - 1) : i + d + nav.length) % nav.length].focus({ preventScroll: true }); });
}

// ---------- spectators ----------
const VIEWS = ['broadcast', 'split', 'pov', 'free'];
let onViewFn = null;
export function setSpectator(on) { const b = document.body; if (on) b.dataset.role = 'spectator'; else { delete b.dataset.role; delete b.dataset.view; } }      // CSS does the rest: tag, chips, no key hints, no insets
export function setWatchers(n) { n = Math.max(0, n | 0); show('watchers', n > 0); setText($('watch-n'), String(n)); $('watchers')?.setAttribute('aria-label', `${n} watching`); }
export function onView(fn) { onViewFn = fn; }                                          // a chip click -> fn(name). The active Player chip calls again: main.js flips the side
export function setView(name, who = '') {
  if (!VIEWS.includes(name)) return;
  document.body.dataset.view = name; setText($('view-pov'), name === 'pov' && who ? `Player: ${who}` : 'Player');
  for (const c of document.querySelectorAll('#views .view-chip')) c.setAttribute('aria-pressed', String(c.dataset.view === name));
}
on2('views', 'click', e => { const c = e.target.closest('.view-chip'); if (c && onViewFn) onViewFn(c.dataset.view); });
on2('views', 'keydown', e => { const d = { ArrowRight: 1, ArrowLeft: -1 }[e.key]; if (!d) return; const cs = [...$('views').children], i = cs.indexOf(document.activeElement); if (i < 0) return; e.preventDefault(); cs[(i + d + 4) % 4].focus(); });
// ---------- spectator emotes: a row of Apple emoji bottom-right (web/emoji/, from iamcal/emoji-data img-apple-160), happy to sad.
// A pick goes to the server; it comes back to everyone in the court (the sender too) and pops in from the right edge. No cooldown: tap as fast as you like.
export const EMOTES = [['1f923', '🤣', 'Rolling on the floor laughing'], ['1f975', '🥵', 'Hot'], ['1f92f', '🤯', 'Mind blown'],
  ['1f621', '😡', 'Angry'], ['1f480', '💀', 'Skull'], ['1f940', '🥀', 'Wilted flower'], ['1f622', '😢', 'Crying']];     // the index is the wire value (server EMOTES)
let onEmoteFn = null;
export function onEmote(fn) { onEmoteFn = fn; }
const emoteImg = i => { const img = document.createElement('img'); img.src = new URL(`emoji/${EMOTES[i][0]}.png`, import.meta.url).href; img.alt = EMOTES[i][1]; img.draggable = false; img.decoding = 'async'; return img; };
{ const box = $('emotes');
  if (box) EMOTES.forEach((em, i) => { const b = document.createElement('button'); b.className = 'emote-btn'; b.dataset.e = String(i); b.setAttribute('aria-label', em[2]); b.title = em[2]; b.append(emoteImg(i)); box.append(b); });
  on2('emotes', 'click', e => { const b = e.target.closest('.emote-btn'); if (!b || !onEmoteFn) return; onEmoteFn(+b.dataset.e); }); }
// one reaction arriving: floats up from the bottom-right corner like a live-stream reaction, swaying, and fades. Eight on screen at most
export function emote(i, name) {
  const layer = $('emote-layer'); if (!layer || !EMOTES[i]) return;
  while (layer.childElementCount >= 8) layer.firstElementChild.remove();
  const el = document.createElement('div'), body = document.createElement('i'), dur = 3.2 + Math.random() * 1.2; el.className = 'emote-pop';
  el.style.setProperty('--x', `${(Math.random() * 3).toFixed(2)}rem`); el.style.setProperty('--sway', `${((Math.random() < .5 ? -1 : 1) * (.5 + Math.random() * 1)).toFixed(2)}rem`); el.style.setProperty('--dur', `${dur.toFixed(2)}s`);
  body.append(emoteImg(i)); if (name) { const n = document.createElement('span'); n.textContent = name; body.append(n); }      // names: textContent only
  el.append(body); el.addEventListener('animationend', e => { if (e.target === el) el.remove(); }); setTimeout(() => el.remove(), dur * 1000 + 500); layer.append(el);
}
// someone sat down in the stands: a small card on the left edge for a few seconds. Three at most; names go in as textContent only
const EYE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z"/><circle cx="12" cy="12" r="2.6"/></svg>';
export function watcherNote(name) {
  const box = $('notices'); if (!box) return;
  while (box.childElementCount >= 3) box.firstElementChild.remove();
  const el = document.createElement('div'), t = document.createElement('span'); el.className = 'notice'; el.innerHTML = EYE;
  t.textContent = name ? `${name} is watching` : 'Someone is watching'; el.append(t); box.append(el);
  setTimeout(() => { el.classList.add('is-out'); setTimeout(() => el.remove(), 400); }, 3600);
}
export function notesOff() { $('notices')?.replaceChildren(); }
export function emotesOff() { const layer = $('emote-layer'); if (layer) layer.replaceChildren(); }     // out of the room: nothing carries over

// ---------- asking to play (docs/SPECTATE.md Asking to play) ----------
// The player's card: bottom-left, 10 s, Y / N. It never takes focus and never swallows a key: its buttons are out of the Tab order
// (so Space and Enter can never press them), a click blurs, and a pointerdown on it is not a court tap. o = { name, left } | null.
let cardOn = false, cardT = 0, cardTick = 0, onAnswerFn = null;
export const askShowing = () => cardOn && !slots.menu;                                // hidden under a menu screen: Y / N do nothing there
export function onAnswer(fn) { onAnswerFn = fn; }                                     // fn(true | false) on a click; Y / N are main.js's
export function askCard(o) {
  const el = $('ask-card'); if (!el) return;
  clearTimeout(cardT); clearInterval(cardTick);
  if (!o) { if (!cardOn) { el.hidden = true; return; } cardOn = false; el.classList.remove('is-on'); setText($('ask-live'), ''); cardT = setTimeout(() => { el.hidden = true; }, reduced() ? 0 : 200); return; }
  const left = Math.max(1, Math.min(60, Math.round(+o.left || 10))), name = String(o.name || 'Someone'), bar = el.querySelector('.ask-bar i');
  setText($('ask-name'), name); cardOn = true; el.hidden = false; void el.offsetWidth; el.classList.add('is-on');
  setText($('ask-live'), `${name} wants to play. They take Matt’s place and a new match starts. Press Y to accept or N to decline.`);
  let k = 0; const step = () => { k++; el.querySelector('.ask-bar')?.style.setProperty('--p', Math.max(0, (left - k) / left).toFixed(3)); };      // stepped once a second from the server's number, each step a 1 s linear slide: it reaches 0 at 'left'
  if (bar) { bar.style.transition = 'none'; el.querySelector('.ask-bar').style.setProperty('--p', '1'); void bar.offsetWidth; bar.style.transition = ''; }
  cardT = setTimeout(() => askCard(null), left * 1000 + 500);                         // the server's askoff closes it; this is the backstop
  requestAnimationFrame(() => { if (cardOn) step(); }); cardTick = setInterval(() => { if (k >= left) clearInterval(cardTick); else step(); }, 1000);
}
{ const card = $('ask-card');
  if (card) { card.addEventListener('pointerdown', e => e.stopPropagation());          // not a court tap, and it does not close the settings card
    for (const [id, yes] of [['btn-ask-yes', true], ['btn-ask-no', false]]) on2(id, 'click', e => { e.currentTarget.blur(); if (cardOn && onAnswerFn) onAnswerFn(yes); }); } }
// The requester's button: on the bottom row left of the emotes, one fixed width. m = the server's askstate { s, left, why, busy } | null (back to Ask to play).
// Counts down here from 'left'; showAsk(on) is main.js's call (a spectator watching one human play Matt, on a device that can be a paddle).
const ASK_SAID = { sent: 'Asked. Waiting for an answer.' };      // no / expired / busy: main.js says why in a toast with the player's name (a role=status, so it is read out too), and the button only counts
let ask = { s: 'idle', left: 0, busy: false }, askT = 0, askOn = false, askedOnce = false;      // askedOnce: a request of mine ended (a no, an expiry): the idle label is Ask again
export const askCan = () => askOn && !$('btn-ask')?.hidden && ask.s === 'idle';
let onAskFn = null;
export function onAsk(fn) { onAskFn = fn; }
export function showAsk(on) { if (askOn === !!on) return; askOn = !!on; drawAsk(); }      // main.js asks on every state packet: only a change draws
export function askPlay(m) {
  clearInterval(askT);
  if (!m || typeof m !== 'object') { ask = { s: 'idle', left: 0, busy: false }; askedOnce = false; }
  else { const s = ['sent', 'no', 'expired', 'wait', 'gone', 'refused', 'yes'].includes(m.s) ? m.s : 'idle', left = Math.max(0, Math.min(99, m.left | 0));
    ask = { s: (s === 'gone' || s === 'wait') && !left ? 'idle' : s, left, busy: !!m.busy }; if (s === 'no' || s === 'expired' || s === 'gone') askedOnce = true; else if (s === 'yes' || s === 'refused') askedOnce = false;
    if (ASK_SAID[s]) setText($('ask-state'), ASK_SAID[s]);
    const ring = $('btn-ask')?.querySelector('.ask-ring'); if (ring && s === 'sent') { ring.style.animationDuration = `${left || 10}s`; restart(ring, 'go'); } }      // the ring drains over the request's life
  if (ask.left > 0 && ['sent', 'no', 'expired', 'wait', 'gone'].includes(ask.s)) askT = setInterval(() => { ask.left--; if (ask.left <= 0) { clearInterval(askT); if (ask.s !== 'sent') ask = { s: 'idle', left: 0, busy: false }; else ask.left = 1; } drawAsk(); }, 1000);      // Asked holds at 1 until the answer comes
  drawAsk();
}
function drawAsk() {
  const b = $('btn-ask'); if (!b) return; const s = ask.s, n = ask.left;
  b.hidden = !askOn || s === 'refused' || s === 'yes';
  const label = s === 'idle' ? (askedOnce ? 'Ask again' : 'Ask to play') : s === 'sent' ? `Waiting · ${n}s` : `Again in ${n}s`;      // the count says what it counts: Waiting = the player's time left to answer; Again in = until you may ask (a cooldown, or another request). The why (said no, no answer, someone else asked) is main.js's toast. Both fit 16rem at 390 px
  setText($('ask-label'), label); b.dataset.s = s; b.setAttribute('aria-disabled', String(s !== 'idle'));
}
on2('btn-ask', 'click', e => { if (e.pointerType) e.currentTarget.blur(); if (askCan() && onAskFn) onAskFn(); });

on2('btn-rematch', 'click', () => { if (voted) return; lockVote(true); if (onVote) onVote(true); });
on2('btn-leave', 'click', () => { if (voted && !votedYes) return; lockVote(false); if (onVote) onVote(false); });      // also after Rematch: a change of mind
on2('rematch-btns', 'keydown', e => { if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return; const b = $(e.key === 'ArrowLeft' ? 'btn-rematch' : 'btn-leave'); if (b && !b.disabled) { e.preventDefault(); b.focus(); } });

// ---------- lobby ----------
// Views inside #screen-lobby, one at a time: home (three tiles), courts (the court list, search, Open | Full, a code to Join or Watch,
// Create court / Create tournament: docs/COURTS-TOURNEY.md 2.7), create (public / private), share (the new court's code and link),
// bot (Matt's four levels). Above them the name field (not on share).
// main.js owns the socket; this only draws and reports what was chosen. Handlers carry no name: main.js reads playerName().
const CODE_OK = /[ABCDEFGHJKMNPQRSTUVWXYZ23456789]/g;                                   // the server's alphabet: no I, L, O, 0, 1
export const cleanCode = t => { t = String(t || '').toUpperCase(); const m = /(?:COURT|ROOM)=([A-Z0-9]{4})/.exec(t); return ((m ? m[1] : t).match(CODE_OK) || []).slice(0, 4).join(''); };   // a pasted link works too
const VIEW_TITLE = { home: 'Play', courts: 'Courts', create: 'Create court', share: 'Your court', bot: 'Play a bot' };
const VIEW_PARENT = { create: 'courts', share: 'courts' };                                // Back from these goes to Courts, not home
export const viewParent = v => VIEW_PARENT[v] || null;
const boxes = () => [...$('code-boxes').children];
let view = 'home', roomsKey = '', on = {}, deep = null;                                  // deep: a shared link's Join or Watch, focused and lit until the view changes
export function onLobby(handlers) { on = handlers || {}; }                              // { quick(), create(isPublic), join(code), watch(code), bot(level), start(), back(), copied() }
export function lobbyView(name, { code, watch } = {}) {
  if (!name) return view;
  if (name === 'code') name = 'courts';                                                 // the old code view lives inside Courts now: old call sites still land
  view = VIEW_TITLE[name] ? name : 'home';
  for (const el of document.querySelectorAll('#screen-lobby .lobby-view')) el.hidden = el.dataset.view !== view;
  setText($('lobby-title'), VIEW_TITLE[view]); codeError(''); show('name-row', view !== 'share'); askWatch(null);
  deep = null; for (const b of [$('btn-join'), $('btn-watch-code')]) b?.classList.remove('is-focus');
  if (view === 'courts') { setCode(cleanCode(code || '')); if (cleanCode(code).length === 4) { deep = watch ? 'watch' : 'join'; $(deep === 'watch' ? 'btn-watch-code' : 'btn-join')?.classList.add('is-focus'); } drawCourts(); }      // a shared link: the boxes filled in, Join (or Watch) lit
  nameGate();
  setTimeout(() => { if (slots.menu === 'lobby' && !asking()) firstFocus().focus({ preventScroll: true, focusVisible: true }); }, 60);    // after the key that brought us here is up: a held Enter must not press it
}
// where focus lands on a view. No name yet (the first visit): the name field, and nothing else can be chosen until it has a letter
const firstFocus = () => (view !== 'share' && !playerName() && $('name-input')) || viewFocus();
function courtsFocus() {                                                                 // a code half typed: its next box. A link: Join / Watch. A mouse: search. A finger: the switch, so no keyboard pops up
  const c = getCode(); if (c && c.length < 4) return boxes().find(b => !b.value);
  if (deep) return $(deep === 'watch' ? 'btn-watch-code' : 'btn-join');
  return matchMedia('(pointer: fine)').matches ? $('court-search') : $('court-seg').querySelector('[aria-checked="true"]');
}
const viewFocus = () => ({ home: $('btn-quick'), courts: courtsFocus(), create: $('btn-create-go'), share: $('btn-share-go'), bot: $('btn-bot-1') }[view] || $('btn-quick'));
// The list scrolls when it is full, and macOS hides scrollbars until you already know to scroll. So the bar is ours: a
// track and a thumb that are always drawn while there is more to see, sized from the list's own scroll numbers. Drag it or wheel.
function roomBar() { const l = $('room-list'), t = $('room-bar'); if (!l || !t) return; const more = l.scrollHeight > l.clientHeight + 1; t.hidden = !more; if (!more) return;
  const th = t.firstElementChild, share = l.clientHeight / l.scrollHeight; th.style.height = share * 100 + '%'; th.style.top = l.scrollTop / l.scrollHeight * 100 + '%'; }
{ const l = $('room-list'), t = $('room-bar'); if (l && t) { l.addEventListener('scroll', roomBar, { passive: true }); addEventListener('resize', roomBar);
  let grab = null; const th = t.firstElementChild;
  th.addEventListener('pointerdown', e => { grab = { y: e.clientY, top: l.scrollTop }; th.setPointerCapture(e.pointerId); e.preventDefault(); });
  th.addEventListener('pointermove', e => { if (grab) l.scrollTop = grab.top + (e.clientY - grab.y) * l.scrollHeight / t.clientHeight; });
  th.addEventListener('pointerup', () => { grab = null; }); th.addEventListener('pointercancel', () => { grab = null; });
  t.addEventListener('pointerdown', e => { if (e.target === t) l.scrollTop += (e.offsetY > th.offsetTop ? 1 : -1) * l.clientHeight * 0.9; }); } }      // a click on the track pages

// ---------- the court list ----------
// rooms: { code, players, open, ask, bot, watch, watchers, score:[a,b], live, names:[n0,n1] } (an older server's { code, players, open } still draws).
// tours: { code, host, n, max } tournaments signing up (docs/COURTS-TOURNEY.md Feature 2; none yet). Every string goes in as textContent.
// Open = tournaments, courts with someone waiting (a join seats you), ask rows (one human playing Matt: a join asks them), empty courts. Full = two humans (the row is Watch).
let list = { rooms: [], tours: [] }, seen = false, filter = 'open', query = '';
try { if (localStorage.getItem('poddle.courts') === 'full') filter = 'full'; } catch { /* private window */ }
const kindOf = r => r.open !== false ? 'open' : r.ask ? 'ask' : 'full';
const nm = (r, i) => Array.isArray(r.names) && typeof r.names[i] === 'string' && r.names[i] ? r.names[i].slice(0, 24) : '';
const sc = r => `${Array.isArray(r.score) ? r.score[0] | 0 : 0}-${Array.isArray(r.score) ? r.score[1] | 0 : 0}`;
function rowsOf() {                                                                      // every court as a row: { kind, code, who, meta, go, watch, label }
  const out = [];
  for (const t of list.tours) out.push({ kind: 'tour', code: t.code, who: `${String(t.host || 'Someone').slice(0, 24)}’s tournament`, meta: `${t.n | 0} of ${t.max | 0 || 16} joined`, go: 'Join' });
  for (const r of list.rooms) { const k = kindOf(r), w = r.watchers | 0, human = nm(r, 0) && nm(r, 0) !== 'Matt' ? nm(r, 0) : nm(r, 1) && nm(r, 1) !== 'Matt' ? nm(r, 1) : '';
    if (k === 'open') out.push({ kind: k, code: r.code, who: !r.players ? 'Empty' : `${human || 'A player'} is waiting`, meta: w > 0 ? `${w} watching` : '', go: 'Join', watch: r.players > 0 && r.watch > 0, w, players: r.players > 0 });      // players: a human is sitting there waiting
    else if (k === 'ask') out.push({ kind: k, code: r.code, who: `${human || 'A player'} vs Matt`, meta: sc(r), go: 'Ask to play', watch: r.watch > 0, w });
    else out.push({ kind: k, code: r.code, who: `${nm(r, 0) || 'Player 1'} vs ${nm(r, 1) || 'Player 2'}`, meta: (r.live === false ? 'Starting' : sc(r)) + (w > 0 ? ` · ${w} watching` : ''), go: r.watch > 0 ? 'Watch' : 'Stands full', full: !(r.watch > 0), w }); }
  return out;
}
const tabOf = row => row.kind === 'full' ? 'full' : 'open';
function shown() {                                                                       // this tab's rows that match the search: codes that START with it first, then codes that contain it
  const all = rowsOf(), q = query, hit = r => !q || r.code.includes(q), pick = t => all.filter(r => tabOf(r) === t && hit(r));
  const order = rs => q ? [...rs.filter(r => r.code.startsWith(q)), ...rs.filter(r => !r.code.startsWith(q))] : rs;
  const o = pick('open'), open = order([...o.filter(r => r.kind === 'tour'), ...o.filter(r => r.kind === 'open' && r.players), ...o.filter(r => r.kind === 'ask'), ...o.filter(r => r.kind === 'open' && !r.players)]);      // tournaments, then someone waiting for an opponent (Join is instant and never refused), then a player vs Matt (Ask to play can be refused, and has a cooldown), then empty courts
  const full = order(pick('full').map((r, i) => [r, i]).sort((a, b) => b[0].w - a[0].w || a[1] - b[1]).map(a => a[0]));      // the most watched first (stable)
  return { open, full, all };
}
export function lobbyRooms(rooms = [], online = 0, tours = []) {
  list = { rooms: (Array.isArray(rooms) ? rooms : []).filter(r => r && typeof r.code === 'string'),       // no 12-row cap: the server lists at most ROOM_CAP courts and the list scrolls
    tours: (Array.isArray(tours) ? tours : []).filter(t => t && typeof t.code === 'string') };
  seen = true;
  $('lobby-online').hidden = !(online > 1); setText($('lobby-online'), `${online} online`);      // 1 online is you: say nothing
  drawCourts();
}
// One state line under the list, exactly one of: down, loading, open empty, full empty, no match, rows. The list box keeps its height in every one.
export function courtsState() { const down = $('screen-lobby')?.classList.contains('is-down'), s = shown();
  return down ? 'down' : !seen ? 'loading' : s[filter].length ? 'rows' : query ? 'nomatch' : filter === 'open' ? 'empty-open' : 'empty-full'; }
const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const EYE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z"/><circle cx="12" cy="12" r="2.6"/></svg>';
function drawCourts() {
  const ul = $('room-list'); if (!ul) return;
  const s = shown(), st = courtsState(), rows = st === 'rows' ? s[filter] : [];
  const nn = st === 'loading' || st === 'down' ? () => '–' : n => String(n); setText($('n-open'), nn(s.open.length)); setText($('n-full'), nn(s.full.length));      // the counts follow the search: a query shows which tab its matches are in. Loading or down: a dash, never a false 0
  const n = s.all.filter(r => r.kind !== 'full').length, sub = $('courts-n'); if (sub) { setText(sub, n ? `${n} open` : ''); sub.style.visibility = seen && n ? '' : 'hidden'; }      // the home tile: never jumps
  for (const o of $('court-seg')?.children || []) { const yes = o.dataset.filter === filter; o.setAttribute('aria-checked', String(yes)); o.tabIndex = yes ? 0 : -1; }
  const key = [st, filter, query, ...rows.map(r => [r.kind, r.code, r.who, r.meta, r.go, r.watch, r.full].join(':'))].join('|');
  if (key === roomsKey) return; roomsKey = key;                                          // the list arrives every second: only touch the DOM (and the focus) when something drawn changed
  const at = ul.contains(document.activeElement) ? document.activeElement : null, had = at && (at.dataset.watch || at.dataset.code), hadWatch = !!(at && at.dataset.watch),
    idx = at ? [...ul.querySelectorAll('.court-row')].indexOf(at.closest('li')?.firstElementChild) : -1;
  ul.textContent = ''; ul.setAttribute('aria-busy', String(st === 'loading'));
  if (st === 'loading' || st === 'down') for (let i = 0; i < 4; i++) { const li = mk('li', 'court is-skel'); li.append(mk('span', 'court-row is-skel')); li.setAttribute('aria-hidden', 'true'); ul.append(li); }      // skeletons: nothing in them is focusable
  rows.forEach((r, i) => { const li = mk('li', 'court'), b = mk('button', 'room-row court-row' + (r.kind === 'full' ? ' is-full' : ''));
    li.dataset.kind = r.kind; b.dataset.code = r.code; b.dataset.nav = ''; b.tabIndex = i ? -1 : 0; if (r.kind === 'full') b.dataset.act = 'watch'; if (r.full) b.setAttribute('aria-disabled', 'true');
    const who = mk('span', 'court-who', r.who); if (r.kind === 'tour') who.prepend(mk('span', 'badge-tour', 'Tournament'));
    b.append(mk('b', 'court-code', r.code), who, mk('span', 'court-meta', r.meta), mk('span', 'court-go', r.go));
    b.setAttribute('aria-label', `Court ${r.code}. ${r.who}.${r.meta ? ' ' + r.meta + '.' : ''} ${r.go}${r.watch ? '. Right arrow to watch' : ''}`); if (r.watch) b.setAttribute('aria-keyshortcuts', 'ArrowRight'); li.append(b);      // Watch is off the Tab order: say how to reach it
    if (r.watch) { const w = mk('button', 'btn btn-sm is-tall room-watch'); w.innerHTML = EYE_SVG; w.append('Watch'); w.dataset.watch = r.code; w.tabIndex = -1; w.setAttribute('aria-label', `Watch court ${r.code}`); li.append(w); }
    ul.append(li); });
  drawState(st, s); roomBar();
  if (at) { const all = [...ul.querySelectorAll('.court-row, .room-watch')], cr = [...ul.querySelectorAll('.court-row')];      // no selector built from a server string
    const to = all.find(e => hadWatch && e.dataset.watch === had) || all.find(e => !e.dataset.watch && e.dataset.code === had) || cr[Math.min(idx, cr.length - 1)] || $('court-search');
    if (to.classList.contains('court-row')) rove(to); to.focus({ preventScroll: true }); }
}
function drawState(st, s) {
  const p = $('room-empty'); if (!p) return; p.textContent = ''; p.dataset.state = st;
  const btn = (text, fn) => { const b = mk('button', 'btn btn-sm is-tall', text); b.type = 'button'; b.addEventListener('click', fn); return b; };
  const q = query, other = filter === 'open' ? 'full' : 'open';
  if (st === 'down') p.append(mk('span', '', 'Courts show again when the game is back.'));
  else if (st === 'loading') p.append(mk('span', 'vh', 'Loading courts'));
  else if (st === 'empty-open') p.append(mk('span', '', 'No open courts right now.'), s.full.length ? btn(`${s.full.length} to watch in Full`, () => { setFilter('full'); $('court-seg').querySelector('[aria-checked="true"]')?.focus(); }) : btn('Create court', () => { if (!needName()) lobbyView('create'); }));      // Create court is already beside the list: point at what can be watched instead
  else if (st === 'empty-full') p.append(mk('span', '', 'Nobody is playing right now.'));
  else if (st === 'nomatch') {
    const code = q.length === 4 && cleanCode(q) === q && !s.all.some(r => r.code === q);      // a whole code that is not listed: private courts only join by code
    p.append(mk('span', '', code ? `${q} isn’t listed. Private courts join by code.` : `No courts match “${q}”.`));
    if (code) p.append(btn('Use this code', () => useCode(q)));
    else if (s[other].length) p.append(btn(`${s[other].length} in ${other === 'full' ? 'Full' : 'Open'}`, () => { setFilter(other); $('court-seg').querySelector('[aria-checked="true"]')?.focus(); }));
    p.append(btn('Clear search', () => { setQuery(''); $('court-search').focus(); }));
  }
}
function setFilter(f) { filter = f === 'full' ? 'full' : 'open'; try { localStorage.setItem('poddle.courts', filter); } catch { /* fine */ } drawCourts(); }
function setQuery(q) { query = (String(q || '').toUpperCase().match(CODE_OK) || []).join('').slice(0, 8); const i = $('court-search'); if (i && i.value !== query) i.value = query; drawCourts(); }
function useCode(c) { setCode(c); codeError(''); $('btn-join').focus({ preventScroll: true }); }
const rove = row => { for (const r of $('room-list').querySelectorAll('.court-row')) r.tabIndex = r === row ? 0 : -1; };      // the list is one Tab stop: the arrows walk it
// "Court is full. Watch instead?" over the lobby. Yes -> on.watch(code). Either button closes it; so does askWatch(null) and leaving the lobby.
let askCode = null;
export const asking = () => askCode != null;
export function askWatch(code) {
  const el = $('ask-watch'); if (!el) return; code = code == null ? null : String(code);
  if (code === askCode) return; const was = askCode; askCode = code; el.hidden = code == null; $('screen-lobby').classList.toggle('is-asking', code != null);
  for (const e of document.querySelectorAll('#screen-lobby .menu-head, #screen-lobby .lobby-view, #name-row')) e.inert = code != null;      // the lobby behind it: no clicks, no Tab stops
  if (code != null) setTimeout(() => { if (askCode === code) $('btn-watch-yes').focus({ preventScroll: true, focusVisible: true }); }, 60);
  else if (was != null && slots.menu === 'lobby') setTimeout(() => { if (slots.menu === 'lobby' && !asking()) viewFocus().focus({ preventScroll: true }); }, 0);
}
export function lobbyBusy(busy) { $('screen-lobby').setAttribute('aria-busy', busy ? 'true' : 'false'); }
export function lobbyLink(up) { if ($('screen-lobby').classList.contains('is-down') === !up && !$('lobby-down').hidden === !up) return;      // called four times a second: only a change does anything
  $('lobby-down').hidden = up; $('screen-lobby').classList.toggle('is-down', !up); if (!up) { list = { rooms: [], tours: [] }; seen = false; $('lobby-online').hidden = true; } drawCourts(); }      // a list from before the drop is not worth tapping; back up, it is 'loading' until the first list
export function codeError(text) {
  setText($('code-err'), text); $('code-boxes').classList.toggle('is-bad', !!text);
  if (text) { restart($('code-boxes'), 'is-error'); boxes()[3].focus(); }
}
function setCode(code) { boxes().forEach((b, i) => { b.value = code[i] || ''; }); codeReady(); }
const getCode = () => boxes().map(b => b.value).join('');
export const typedCode = () => getCode();                                                // what is in the code boxes (a join from them answers under them)
function codeReady() { const off = getCode().length < 4; for (const id of ['btn-join', 'btn-watch-code']) { const b = $(id); if (b) { if (off && document.activeElement === b) boxes()[3].focus(); b.disabled = off; } } }      // Join and Watch: four letters, or neither
// room: the code I am seated in (null = none). link: the address to share, or '' when this page is only reachable on this computer.
// the connection, said quietly: four bars and the round trip. It never turns red and never interrupts; a slow link just shows fewer bars.
export function setPing(ms) { const el = $('ping-pill'); if (!el) return; el.hidden = !(ms > 0); if (!(ms > 0)) return; const r = Math.round(ms);
  el.dataset.bars = r < 60 ? 4 : r < 110 ? 3 : r < 180 ? 2 : 1; setText($('ping-ms'), r + ' ms'); el.title = 'Ping'; }
export function setRoom(code, link = '') {
  $('room-pill').hidden = $('room-menu').hidden = !code; setText($('room-code'), code || ''); $('room-menu').classList.toggle('no-link', !link);      // no link on localhost: no drop-down, promise nothing
  for (const b of document.querySelectorAll('.screen:not(#screen-lobby) [data-back]')) b.hidden = !code;      // set-up screens: Back only when there is a lobby to go back to
  [...$('share-code').children].forEach((el, i) => setText(el, code ? code[i] : ''));
  $('share-row').hidden = !link; setText($('share-link'), link.replace(/^https?:\/\//, '')); $('share-link').dataset.href = link;
}
export function backLabel(text) { for (const t of document.querySelectorAll('.screen .back-text')) setText(t, text); }      // 'Cancel' while a paddle swap mid-game can still be undone
export function titleRoom(code, watch) { $('title-room').hidden = !code; setText($('title-room-code'), code || ''); setText($('title-room-spec'), watch ? '\u00a0as spectator' : ''); }     // opened from a shared link (&watch=1: 'as spectator')
// What lands on the clipboard: a line to paste into a chat, then the link.
const INVITE = { play: 'Play against me in Poddle! Pickleball you swing with your phone, on any computer:', watch: 'Watch me play Poddle, pickleball with your phone as the paddle:' };
async function copyLink(btn, watch) {      // watch: the viewer link (&watch=1), which opens the court as a spectator
  let href = $('share-link').dataset.href; if (!href) return;
  if (watch) { const u = new URL(href); u.searchParams.set('watch', '1'); href = u.href; }
  href = INVITE[watch ? 'watch' : 'play'] + ' ' + href;
  try { await navigator.clipboard.writeText(href); } catch { const t = document.createElement('textarea'); t.value = href; t.style.cssText = 'position:fixed;opacity:0'; document.body.append(t); t.select(); try { document.execCommand('copy'); } catch { /* nothing more to try */ } t.remove(); }
  if (btn.id === 'btn-copy') { const l = $('copy-label'); setText(l, 'Copied'); clearTimeout(copyT); copyT = setTimeout(() => setText(l, 'Copy link'), 1500); } else on.copied && on.copied(watch);
}
let copyT = 0;
// Two copy menus, one way of working: the share screen's Copy link and the court pill in the HUD corner. Hover (or a tap) drops the choices.
const COPY = [['copy-menu', 'btn-copy'], ['room-menu', 'room-pill']];
const copyOpen = (m, open) => { $(m).classList.toggle('is-open', open); $(COPY.find(c => c[0] === m)[1]).setAttribute('aria-expanded', open); };
{
  // no name, no seat: every choice on the home view waits for it (the field shakes and takes focus), and so does the last button of each view
  $('btn-quick').addEventListener('click', () => { if (!needName() && on.quick) on.quick(); });
  on2('btn-courts', 'click', () => { if (!needName()) lobbyView('courts'); });
  on2('btn-create', 'click', () => { if (!needName()) lobbyView('create'); });
  on2('btn-tour', 'click', e => { e.currentTarget.blur?.(); });                         // shown from day one so the layout never shifts; tournaments are coming soon (aria-disabled, still focusable)
  on2('btn-watch-code', 'click', () => { const c = getCode(); if (c.length === 4 && !needName() && on.watch) on.watch(c); });
  on2('btn-bot', 'click', () => { if (!needName()) lobbyView('bot'); });
  $('btn-create-go').addEventListener('click', () => { if (!needName() && on.create) on.create($('seg').querySelector('[aria-checked="true"]').dataset.public === '1'); });
  on2('bot-levels', 'click', e => { const b = e.target.closest('[data-level]'); if (b && !needName() && on.bot) on.bot(+b.dataset.level); });       // one click plays: no second confirm
  on2('lobby-bot', 'keydown', e => { let d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]; if (!d) return; e.preventDefault(); const bs = [...$('bot-levels').children], i = bs.indexOf(document.activeElement);
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && getComputedStyle($('bot-levels')).gridTemplateColumns.split(' ').length === 2) d *= 2;      // two by two: up and down move a row
    bs[(i < 0 ? 1 : i + d + bs.length) % bs.length].focus(); });
  on2('name-input', 'input', e => keepName(e.currentTarget));
  on2('name-input', 'blur', e => { e.currentTarget.value = cleanName(e.currentTarget.value); });
  on2('name-input', 'keydown', e => { if (e.key !== 'Enter' && e.key !== 'ArrowDown') return; e.preventDefault(); if (!needName()) viewFocus().focus({ preventScroll: true, focusVisible: true }); });     // Enter: on to Quick play
  on2('btn-watch-yes', 'click', () => { const c = askCode; askWatch(null); if (c && on.watch) on.watch(c); });
  on2('btn-watch-no', 'click', () => askWatch(null));
  on2('ask-watch', 'keydown', e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); $(e.key === 'ArrowLeft' ? 'btn-watch-yes' : 'btn-watch-no').focus(); } });
  $('btn-share-go').addEventListener('click', () => on.start && on.start());
  for (const [m, b] of COPY) {
    $(b).addEventListener('click', () => { if (!$(m).classList.contains('no-link')) copyOpen(m, !$(m).classList.contains('is-open')); });      // a touch screen has no hover: a tap opens the choices
    $(m).addEventListener('click', e => { const o = e.target.closest('[data-copy]'); if (!o) return; copyLink($(b), o.dataset.copy === 'watch'); copyOpen(m, false); if (o.matches(':focus-visible')) $(b).focus(); else o.blur(); });
    $(m).addEventListener('keydown', e => { const os = [...$(m).querySelectorAll('.copy-opt')], i = os.indexOf(document.activeElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); os[i < 0 ? (e.key === 'ArrowDown' ? 0 : 1) : (i + 1) % 2].focus(); } else if (e.key === 'Escape') { copyOpen(m, false); $(b).blur(); } });
  }
  document.addEventListener('pointerdown', e => { for (const [m] of COPY) if (!e.target.closest('#' + m)) copyOpen(m, false); });
  for (const b of document.querySelectorAll('[data-back]')) b.addEventListener('click', () => on.back && on.back());
  $('room-list').addEventListener('click', e => { const w = e.target.closest('.room-watch'), b = e.target.closest('button.room-row'); if (!w && !b || b && b.getAttribute('aria-disabled') === 'true' || needName()) return;
    if (w) { if (on.watch) on.watch(w.dataset.watch); } else if (b.dataset.act === 'watch') { if (on.watch) on.watch(b.dataset.code); } else if (on.join) on.join(b.dataset.code); });      // an Ask to play row joins too: the server turns it into watch + ask
  // the list: one Tab stop. Up / Down walk the rows (Up on the first goes back to search), Home / End, Right = the row's Watch, Left = back to the row
  $('room-list').addEventListener('keydown', e => { const rs = [...$('room-list').querySelectorAll('.court-row')], a = document.activeElement, row = a.classList.contains('room-watch') ? a.closest('li').firstElementChild : a, i = rs.indexOf(row); if (i < 0) return;
    const go = r => { e.preventDefault(); rove(r); r.focus(); r.scrollIntoView({ block: 'nearest' }); };
    if (e.key === 'ArrowDown') { if (rs[i + 1]) go(rs[i + 1]); else e.preventDefault(); } else if (e.key === 'ArrowUp') { if (i > 0) go(rs[i - 1]); else { e.preventDefault(); $('court-search').focus(); } }
    else if (e.key === 'Home') go(rs[0]); else if (e.key === 'End') go(rs[rs.length - 1]);
    else if (e.key === 'ArrowRight' && a === row) { const w = row.parentElement.querySelector('.room-watch'); if (w) { e.preventDefault(); w.focus(); } } else if (e.key === 'ArrowLeft' && a !== row) { e.preventDefault(); row.focus(); } });
  on2('court-search', 'input', e => { const c = e.currentTarget.selectionStart; setQuery(e.currentTarget.value); try { e.currentTarget.setSelectionRange(c, c); } catch { /* fine */ } });
  on2('court-search', 'keydown', e => { const rs = [...$('room-list').querySelectorAll('.court-row')];
    if (e.key === 'ArrowDown') { if (rs[0]) { e.preventDefault(); rove(rs[0]); rs[0].focus(); } }
    else if (e.key === 'Enter') { e.preventDefault(); if (rs.length === 1) rs[0].click(); else if (query.length === 4 && cleanCode(query) === query && !rs.some(r => r.dataset.code === query)) useCode(query); }      // never submits anything by itself
    else if (e.key === 'Escape' && e.currentTarget.value) { e.preventDefault(); e.stopPropagation(); setQuery(''); } });      // a query is cleared before Esc goes Back (main.js never hears it)
  on2('court-seg', 'click', e => { const o = e.target.closest('.seg-opt'); if (o) setFilter(o.dataset.filter); });
  on2('court-seg', 'keydown', e => { if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return; e.preventDefault(); setFilter(e.key === 'ArrowLeft' ? 'open' : 'full'); $('court-seg').querySelector('[aria-checked="true"]')?.focus(); });
  document.addEventListener('keydown', e => { if (e.key !== '/' || view !== 'courts' || slots.menu !== 'lobby' || asking() || e.target.tagName === 'INPUT' || e.metaKey || e.ctrlKey || e.altKey) return; e.preventDefault(); $('court-search').focus(); });      // '/' = search, the web's usual key, anywhere on Courts
  const pick = opt => { for (const o of $('seg').children) { const yes = o === opt; o.setAttribute('aria-checked', yes); o.tabIndex = yes ? 0 : -1; } setText($('seg-note'), opt.dataset.public === '1' ? 'Shows in the court list' : 'Join by code only'); };
  $('seg').addEventListener('click', e => { const o = e.target.closest('.seg-opt'); if (o) pick(o); });
  $('lobby-create').addEventListener('keydown', e => { if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return; e.preventDefault(); const o = $('seg').children[e.key === 'ArrowLeft' ? 0 : 1]; pick(o); if ($('seg').contains(document.activeElement)) o.focus(); });   // Left = Public, Right = Private, from anywhere on the card
  // code boxes: type, paste (a code or a whole link), Backspace walks back, arrows move, Enter joins
  const form = $('lobby-code'), fill = (from, text) => { const bs = boxes(), chars = cleanCode(text); if (chars.length === 4) from = 0;
    [...chars].forEach((c, i) => { if (bs[from + i]) bs[from + i].value = c; }); (bs[Math.min(3, from + chars.length)] || bs[3]).focus(); codeReady(); codeError(''); };
  form.addEventListener('input', e => { const b = e.target, i = boxes().indexOf(b); if (i < 0) return; const t = b.value; b.value = ''; if (cleanCode(t)) fill(i, t); else codeReady(); });
  form.addEventListener('paste', e => { e.preventDefault(); fill(0, (e.clipboardData || window.clipboardData).getData('text')); });
  form.addEventListener('focusin', e => { if (e.target.select) e.target.select(); });
  form.addEventListener('keydown', e => { const bs = boxes(), i = bs.indexOf(e.target); if (i < 0) return;
    if (e.key === 'Backspace' && !e.target.value && i > 0) { e.preventDefault(); bs[i - 1].value = ''; bs[i - 1].focus(); codeReady(); }
    else if (e.key === 'ArrowLeft' && i > 0) { e.preventDefault(); bs[i - 1].focus(); } else if (e.key === 'ArrowRight' && i < 3) { e.preventDefault(); bs[i + 1].focus(); }
    else if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); $('btn-watch-code').click(); } });      // Enter = Join (the form), Shift+Enter = Watch
  form.addEventListener('submit', e => { e.preventDefault(); const c = getCode(); if (c.length === 4 && !needName() && on.join) on.join(c); });
  // arrows walk the three tiles (Tab works too)
  $('lobby-home').addEventListener('keydown', e => { const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]; if (!d) return;
    const nav = [...$('lobby-home').querySelectorAll('[data-nav]')], i = nav.indexOf(document.activeElement); e.preventDefault(); nav[(i < 0 ? 0 : i + d + nav.length) % nav.length].focus(); });
}

// ---------- sliding segmented controls ----------
// Every .seg draws its pick as one thumb (.seg::before, ui.css) that slides to the checked option instead of the highlight jumping.
// Options differ in width (Rookie / Club, 'Open 12'), so the thumb is measured from the option. One observer per seg catches every
// aria-checked write, wherever in this file it comes from; a hidden seg (settings closed) measures 0 and is placed, unanimated, when it shows.
{
  const place = seg => {
    const on = seg.querySelector(':scope > [aria-checked="true"]');
    if (!on || !seg.offsetWidth) { seg.classList.remove('has-thumb'); return; }
    const first = !seg.classList.contains('has-thumb');
    if (first) seg.classList.add('thumb-still');
    const s = seg.style; s.setProperty('--tx', on.offsetLeft + 'px'); s.setProperty('--ty', on.offsetTop + 'px'); s.setProperty('--tw', on.offsetWidth + 'px'); s.setProperty('--th', on.offsetHeight + 'px');
    seg.classList.add('has-thumb');
    if (first) { void seg.offsetWidth; requestAnimationFrame(() => seg.classList.remove('thumb-still')); }
  };
  const segs = document.querySelectorAll('.seg');
  const mo = new MutationObserver(ms => { for (const seg of new Set(ms.map(m => m.target.parentElement))) if (seg?.classList.contains('seg')) place(seg); });
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(es => { for (const seg of new Set(es.map(e => e.target.closest('.seg')))) if (seg) place(seg); }) : null;
  for (const seg of segs) { mo.observe(seg, { subtree: true, attributes: true, attributeFilter: ['aria-checked'] }); ro?.observe(seg); for (const o of seg.children) ro?.observe(o); place(seg); }
}
