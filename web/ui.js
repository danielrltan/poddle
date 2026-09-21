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
  $('banner-text').textContent = mine ? 'Your point!' : name ? `${name} scores` : 'Their point';
  b.classList.toggle('is-me', blue); b.classList.toggle('is-them', !blue); restart(b, 'show');
}
let toastT;
export function toast(text, ms = 1200) {
  const el = $('toast'), b = document.body; el.textContent = text; el.classList.add('on'); b.classList.add('has-toast');     // .has-toast: the key strip yields the bottom band
  clearTimeout(toastT); toastT = setTimeout(() => { el.classList.remove('on'); b.classList.remove('has-toast'); }, ms);
}
export function toastOff() { clearTimeout(toastT); $('toast').classList.remove('on'); document.body.classList.remove('has-toast'); }     // the screen it spoke about is gone
export function confetti(colors, n = 46) {
  if (reduced()) return;
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
let resultRole = 'player', voted = false, countT = 0, countLeft = 0, countTotal = 0;
export function matchResult(o, me, them, name) {
  if (o === null || typeof o !== 'object') o = { won: !!o, me, them, nameThem: name, vote: false };
  const won = !!o.won, watching = o.role === 'spectator', nameMe = String(o.nameMe || 'You'), nameThem = String(o.nameThem || 'Opponent'), lost = !watching && !won, vote = !watching && o.vote !== false;
  $('result').classList.toggle('is-lose', lost);
  $('medal').className = 'medal ' + (lost ? 'is-silver' : 'is-gold');
  $('result-title').textContent = watching ? `${won ? nameMe : nameThem} wins` : won ? 'You win!' : `${nameThem} wins`;
  setText($('result-note'), o.forfeit ? `${won ? nameThem : nameMe} left` : '');
  $('tally-sc-me').textContent = o.me ?? 0; $('tally-sc-them').textContent = o.them ?? 0; setText($('tally-name-me'), nameMe); setText($('tally-name-them'), nameThem);
  $('tally-me').classList.toggle('is-winner', won); $('tally-them').classList.toggle('is-winner', !won);
  resultRole = watching ? 'spectator' : 'player'; voted = false; stopCount(); countTotal = 0; votes = { mine: null, theirs: null, name: nameThem };
  show('rematch-btns', vote); show('rematch-count', false);
  for (const id of ['btn-rematch', 'btn-leave']) { const b = $(id); if (b) { b.disabled = false; b.classList.remove('is-pressed'); } }
  setText($('rematch-note'), watching ? 'Waiting for a rematch' : vote ? '' : 'New game starting');
  showOverlay('match');
  if (vote) setTimeout(() => { if (slots.overlay === 'match' && !voted) ($('btn-rematch')?.disabled ? $('btn-leave') : $('btn-rematch'))?.focus({ preventScroll: true, focusVisible: true }); }, 60);
}
function stopCount() { clearInterval(countT); countT = 0; }
function drawCount(n) { countLeft = n; setText($('rematch-left'), String(n)); $('rematch-bar')?.style.setProperty('--p', (countTotal ? Math.min(1, n / countTotal) : 0).toFixed(3)); }
function lockVote(yes) { voted = true; for (const [id, mine] of [['btn-rematch', yes], ['btn-leave', !yes]]) { const b = $(id); if (b) { b.disabled = true; b.classList.toggle('is-pressed', mine); } } }
let onVote = null;
export function onRematch(fn) { onVote = fn; }                                          // Rematch -> fn(true), Leave -> fn(false)
// { mine, theirs, left, name }: each vote true | false | null, a missing key = unchanged. The server only speaks when a vote changes, so the seconds tick here.
let votes = { mine: null, theirs: null, name: '' };
export function rematch(o = {}) {
  if ('mine' in o) { votes.mine = o.mine; if (o.mine === true || o.mine === false) lockVote(o.mine); }      // null never re-opens the buttons: my click may still be on its way
  if ('theirs' in o) { votes.theirs = o.theirs; const r = $('btn-rematch'); if (o.theirs === false && r && !voted) { const had = document.activeElement === r; r.disabled = true; if (had) $('btn-leave')?.focus({ preventScroll: true }); } }      // they left (a forfeit): there is nobody to play again, only Leave
  if (o.name != null) votes.name = String(o.name);
  if (typeof o.left === 'number' && isFinite(o.left)) { const n = Math.max(0, Math.round(o.left)); countTotal = Math.max(countTotal, n) || 1;       // the bar drains from the first number it was given
    stopCount(); show('rematch-count', true); drawCount(n); countT = setInterval(() => { if (countLeft > 0) drawCount(countLeft - 1); else stopCount(); }, 1000); }
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
const ROW = {
  airpod: { ok: '', wait: 'Take one AirPod out and hold it in your hand.', bad: 'Signal lost. Check the AirPod is still connected to this Mac.' },
  game: { ok: '', wait: 'Finding the game', bad: 'Can’t reach the game. Trying again.' },
  camera: { ok: 'Stand where it can see you.', wait: 'Allow the camera when the browser asks.', bad: 'No camera. Turn your wrist to move.', off: 'No camera. Turn your wrist to move.' },
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
      setText($(`row-${key}-text`), ROW[key][v] || ''); setText($(`row-${key}-state`), STATE_WORD[v]); setText($(`set-${key}-state`), STATE_WORD[v]);
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
  const m = $('calmsg'); setText(m, waiting ? 'Waiting for the AirPod' : camLost && !tilt ? 'The camera can’t see you. Step into view.' : '');
  // replay the sideways nudge for every new mistake (also a second one in a row), not for every 20 ms sample
  if (fresh || (!e.ok && calPrev.msg !== msg)) restart($('calcard'), 'is-error'); else if (!bad) $('calcard').classList.remove('is-error');
  calPrev = { ok: e.ok, msg };
}

// ---------- small things ----------
export function setMode(name) { setText($('mode'), name); for (const o of $('move-seg')?.children || []) o.setAttribute('aria-checked', String(o.dataset.move === String(name).toLowerCase())); }      // how you move lives in the settings panel now (docs/NEXT.md 14d)
// Matt's level, or null when the other seat is not Matt: the 1 2 3 key hint and the settings Difficulty row show only against him
export function setBot(level) { const on = !!level; show('key-bot', on); show('set-bot', on); if (!on) return; setText($('bot-level'), String(level)); for (const o of $('bot-seg')?.children || []) o.setAttribute('aria-checked', String(o.textContent === String(level))); }
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
const cleanName = t => String(t ?? '').replace(/[\u0000-\u001f\u007f-\u009f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 12).trim();
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
let setOpen = false, setH = {};
export function onSettings(h) { setH = h || {}; }                                       // { open(), close(), sens(dir), airpod(on), stats(on), recenter(), leave(), name(text), move(mode), bot(level) }
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
  for (const [key, id] of [['airpod', 'tog-airpod'], ['stats', 'tog-stats']]) if (key in o) $(id)?.setAttribute('aria-checked', String(!!o[key]));
  if ('inRoom' in o) show('btn-leave-room', !!o.inRoom);
  if ('canPause' in o) show('set-note', o.canPause === false);
  if ('bodyOk' in o) { const b = $('move-seg')?.querySelector('[data-move="body"]'); if (b) b.disabled = !o.bodyOk; show('move-note', !o.bodyOk); }      // no camera: Body cannot be picked, and the row says why
  if ('spectator' in o) $('settings')?.classList.toggle('is-spectator', !!o.spectator);
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
  for (const [id, k] of [['tog-airpod', 'airpod'], ['tog-stats', 'stats']]) on2(id, 'click', e => call(k, e.currentTarget.getAttribute('aria-checked') !== 'true'));      // the NEW value; main.js answers with setSettings
  on2('tog-full', 'click', () => fullscreen());
  on2('move-seg', 'click', e => { const o = e.target.closest('[data-move]'); if (o && !o.disabled) call('move', o.dataset.move); });      // main.js answers with setMode / setBot: the UI flips nothing itself
  on2('bot-seg', 'click', e => { const o = e.target.closest('[data-level]'); if (o) call('bot', +o.dataset.level); });
  on2('btn-recenter', 'click', () => call('recenter')); on2('btn-leave-room', 'click', () => call('leave'));
  // name: saved on Enter / blur. Empty puts the old one back. Esc cancels the edit and hands focus back to the card (main.js owns what Esc does next)
  const commit = el => { const n = cleanName(el.value); if (!n) { el.value = savedName; return; } const changed = n !== savedName; el.value = n; keepName(el); if (changed) call('name', n); };
  on2('set-name-input', 'blur', e => commit(e.currentTarget));
  on2('set-name-input', 'keydown', e => { if (e.key === 'Enter') { e.preventDefault(); commit(e.currentTarget); $('settings').focus({ preventScroll: true }); } else if (e.key === 'Escape') { e.currentTarget.value = savedName; $('settings').focus({ preventScroll: true }); } });
  // Up / Down walk the card's controls (Tab works too)
  on2('settings', 'keydown', e => { const d = { ArrowDown: 1, ArrowUp: -1 }[e.key]; if (!d) return; const nav = [...$('settings').querySelectorAll('button, input')].filter(b => !b.disabled && b.offsetParent), i = nav.indexOf(document.activeElement);
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
on2('btn-rematch', 'click', () => { if (voted) return; lockVote(true); if (onVote) onVote(true); });
on2('btn-leave', 'click', () => { if (voted) return; lockVote(false); if (onVote) onVote(false); });
on2('rematch-btns', 'keydown', e => { if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return; const b = $(e.key === 'ArrowLeft' ? 'btn-rematch' : 'btn-leave'); if (b && !b.disabled) { e.preventDefault(); b.focus(); } });

// ---------- lobby ----------
// Five views inside #screen-lobby, one at a time: home (four tiles + the room list), create (public / private), share (the
// new room's code and link), code (four letter boxes), bot (Matt's three levels). Above them the name field (not on share).
// main.js owns the socket; this only draws and reports what was chosen. Handlers carry no name: main.js reads playerName().
const CODE_OK = /[ABCDEFGHJKMNPQRSTUVWXYZ23456789]/g;                                   // the server's alphabet: no I, L, O, 0, 1
export const cleanCode = t => { t = String(t || '').toUpperCase(); const m = /(?:COURT|ROOM)=([A-Z0-9]{4})/.exec(t); return ((m ? m[1] : t).match(CODE_OK) || []).slice(0, 4).join(''); };   // a pasted link works too
const VIEW_TITLE = { home: 'Play', create: 'Create court', share: 'Your court', code: 'Enter code', bot: 'Play a bot' };
const boxes = () => [...$('code-boxes').children];
let view = 'home', roomsKey = '', on = {};
export function onLobby(handlers) { on = handlers || {}; }                              // { quick(), create(isPublic), join(code), watch(code), bot(level), start(), back(), copied() }
export function lobbyView(name, { code } = {}) {
  if (!name) return view;
  view = VIEW_TITLE[name] ? name : 'home';
  for (const el of document.querySelectorAll('#screen-lobby .lobby-view')) el.hidden = el.dataset.view !== view;
  setText($('lobby-title'), VIEW_TITLE[view]); codeError(''); show('name-row', view !== 'share'); askWatch(null);
  if (view === 'code') setCode(code || '');
  nameGate();
  setTimeout(() => { if (slots.menu === 'lobby' && !asking()) firstFocus().focus({ preventScroll: true, focusVisible: true }); }, 60);    // after the key that brought us here is up: a held Enter must not press it
}
// where focus lands on a view. No name yet (the first visit): the name field, and nothing else can be chosen until it has a letter
const firstFocus = () => (view !== 'share' && !playerName() && $('name-input')) || viewFocus();
const viewFocus = () => ({ home: $('btn-quick'), create: $('btn-create-go'), share: $('btn-share-go'), code: boxes().find(b => !b.value) || $('btn-join'), bot: $('btn-bot-1') }[view] || $('btn-quick'));
// rooms: { code, players, open, watch, watchers, score:[a,b], live } (the old { code, players, open } still draws). An open room is a button that joins;
// a full one is a plain row with its score. Either gets a Watch button while there is a place to watch and somebody to watch.
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
export function lobbyRooms(rooms = [], online = 0) {
  rooms = (Array.isArray(rooms) ? rooms : []).filter(r => r && typeof r.code === 'string').slice(0, 12);
  const list = $('room-list'), key = rooms.map(r => [r.code, r.players, r.open, r.watch, r.watchers, r.score].join(':')).join();
  $('lobby-online').hidden = !(online > 1); setText($('lobby-online'), `${online} online`);      // 1 online is you: say nothing
  if (key === roomsKey) return; roomsKey = key;                                       // the list arrives every second: only touch the DOM (and the focus) when it changed
  const at = list.contains(document.activeElement) ? document.activeElement : null, had = at && (at.dataset.watch || at.dataset.code), hadWatch = !!(at && at.dataset.watch);
  list.textContent = '';
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  for (const r of rooms) { const open = r.open !== false, li = el('li'), row = el(open ? 'button' : 'div', open ? 'room-row' : 'room-row is-full'), n = r.watchers | 0;
    row.dataset.code = r.code; if (open) row.dataset.nav = '';
    const said = [open ? (r.players ? '1 player' : 'Empty') : `${Array.isArray(r.score) ? r.score[0] | 0 : 0}-${Array.isArray(r.score) ? r.score[1] | 0 : 0}`]; if (n > 0) said.push(`${n} watching`);
    row.append(el('b', '', r.code), el('span', '', said.join(' · '))); li.append(row);
    if (r.watch > 0 && r.players > 0) { const w = el('button', 'btn btn-sm room-watch', 'Watch'); w.dataset.watch = r.code; w.dataset.nav = ''; w.setAttribute('aria-label', `Watch ${r.code}`); li.append(w); }
    list.append(li); }
  $('room-empty').hidden = rooms.length > 0; roomBar();
  if (had) { const all = [...list.querySelectorAll('[data-nav]')]; (all.find(e => hadWatch && e.dataset.watch === had) || all.find(e => (e.dataset.code || e.dataset.watch) === had) || $('btn-quick')).focus({ preventScroll: true }); }     // no selector built from a server string
}
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
export function lobbyLink(up) { $('lobby-down').hidden = up; $('screen-lobby').classList.toggle('is-down', !up); if (!up) lobbyRooms([], 0); }      // a list from before the drop is not worth tapping
export function codeError(text) {
  setText($('code-err'), text); $('code-boxes').classList.toggle('is-bad', !!text);
  if (text) { restart($('code-boxes'), 'is-error'); boxes()[3].focus(); }
}
function setCode(code) { boxes().forEach((b, i) => { b.value = code[i] || ''; }); $('btn-join').disabled = code.length < 4; }
const getCode = () => boxes().map(b => b.value).join('');
// room: the code I am seated in (null = none). link: the address to share, or '' when this page is only reachable on this computer.
// the connection, said quietly: four bars and the round trip. It never turns red and never interrupts; a slow link just shows fewer bars.
export function setPing(ms) { const el = $('ping-pill'); if (!el) return; el.hidden = !(ms > 0); if (!(ms > 0)) return; const r = Math.round(ms);
  el.dataset.bars = r < 60 ? 4 : r < 110 ? 3 : r < 180 ? 2 : 1; setText($('ping-ms'), r + ' ms'); el.title = 'Ping'; }
export function setRoom(code, link = '') {
  $('room-pill').hidden = !code; setText($('room-code'), code || ''); $('room-pill').title = link ? 'Copy link' : '';      // no link on localhost: promise nothing
  for (const b of document.querySelectorAll('.screen:not(#screen-lobby) [data-back]')) b.hidden = !code;      // set-up screens: Back only when there is a lobby to go back to
  [...$('share-code').children].forEach((el, i) => setText(el, code ? code[i] : ''));
  $('share-row').hidden = !link; setText($('share-link'), link.replace(/^https?:\/\//, '')); $('share-link').dataset.href = link;
}
export function titleRoom(code) { $('title-room').hidden = !code; setText($('title-room-code'), code || ''); }     // opened from a shared link
async function copyLink(btn) {
  const href = $('share-link').dataset.href; if (!href) return;
  try { await navigator.clipboard.writeText(href); } catch { const r = document.createRange(); r.selectNodeContents($('share-link')); const s = getSelection(); s.removeAllRanges(); s.addRange(r); try { document.execCommand('copy'); } catch { /* still selected: Cmd+C works */ } }
  if (btn.id === 'btn-copy') { setText(btn, 'Copied'); setTimeout(() => setText(btn, 'Copy link'), 1500); } else on.copied && on.copied();
}
{
  // no name, no seat: every choice on the home view waits for it (the field shakes and takes focus), and so does the last button of each view
  $('btn-quick').addEventListener('click', () => { if (!needName() && on.quick) on.quick(); });
  $('btn-create').addEventListener('click', () => { if (!needName()) lobbyView('create'); });
  $('btn-code').addEventListener('click', () => { if (!needName()) lobbyView('code'); });
  on2('btn-bot', 'click', () => { if (!needName()) lobbyView('bot'); });
  $('btn-create-go').addEventListener('click', () => { if (!needName() && on.create) on.create($('seg').querySelector('[aria-checked="true"]').dataset.public === '1'); });
  on2('bot-levels', 'click', e => { const b = e.target.closest('[data-level]'); if (b && !needName() && on.bot) on.bot(+b.dataset.level); });       // one click plays: no second confirm
  on2('lobby-bot', 'keydown', e => { const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]; if (!d) return; e.preventDefault(); const bs = [...$('bot-levels').children], i = bs.indexOf(document.activeElement); bs[(i < 0 ? 1 : i + d + 3) % 3].focus(); });
  on2('name-input', 'input', e => keepName(e.currentTarget));
  on2('name-input', 'blur', e => { e.currentTarget.value = cleanName(e.currentTarget.value); });
  on2('name-input', 'keydown', e => { if (e.key !== 'Enter' && e.key !== 'ArrowDown') return; e.preventDefault(); if (!needName()) viewFocus().focus({ preventScroll: true, focusVisible: true }); });     // Enter: on to Quick play
  on2('btn-watch-yes', 'click', () => { const c = askCode; askWatch(null); if (c && on.watch) on.watch(c); });
  on2('btn-watch-no', 'click', () => askWatch(null));
  on2('ask-watch', 'keydown', e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); $(e.key === 'ArrowLeft' ? 'btn-watch-yes' : 'btn-watch-no').focus(); } });
  $('btn-share-go').addEventListener('click', () => on.start && on.start());
  $('btn-copy').addEventListener('click', e => copyLink(e.currentTarget)); $('room-pill').addEventListener('click', e => copyLink(e.currentTarget));
  for (const b of document.querySelectorAll('[data-back]')) b.addEventListener('click', () => on.back && on.back());
  $('room-list').addEventListener('click', e => { const w = e.target.closest('.room-watch'), b = e.target.closest('button.room-row'); if (!w && !b || needName()) return;
    if (w) { if (on.watch) on.watch(w.dataset.watch); } else if (on.join) on.join(b.dataset.code); });
  const pick = opt => { for (const o of $('seg').children) { const yes = o === opt; o.setAttribute('aria-checked', yes); o.tabIndex = yes ? 0 : -1; } setText($('seg-note'), opt.dataset.public === '1' ? 'Shows in the court list' : 'Join by code only'); };
  $('seg').addEventListener('click', e => { const o = e.target.closest('.seg-opt'); if (o) pick(o); });
  $('lobby-create').addEventListener('keydown', e => { if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return; e.preventDefault(); const o = $('seg').children[e.key === 'ArrowLeft' ? 0 : 1]; pick(o); if ($('seg').contains(document.activeElement)) o.focus(); });   // Left = Public, Right = Private, from anywhere on the card
  // code boxes: type, paste (a code or a whole link), Backspace walks back, arrows move, Enter joins
  const form = $('lobby-code'), fill = (from, text) => { const bs = boxes(), chars = cleanCode(text); if (chars.length === 4) from = 0;
    [...chars].forEach((c, i) => { if (bs[from + i]) bs[from + i].value = c; }); (bs[Math.min(3, from + chars.length)] || bs[3]).focus(); $('btn-join').disabled = getCode().length < 4; codeError(''); };
  form.addEventListener('input', e => { const b = e.target, i = boxes().indexOf(b); if (i < 0) return; const t = b.value; b.value = ''; if (cleanCode(t)) fill(i, t); else $('btn-join').disabled = getCode().length < 4; });
  form.addEventListener('paste', e => { e.preventDefault(); fill(0, (e.clipboardData || window.clipboardData).getData('text')); });
  form.addEventListener('focusin', e => { if (e.target.select) e.target.select(); });
  form.addEventListener('keydown', e => { const bs = boxes(), i = bs.indexOf(e.target); if (i < 0) return;
    if (e.key === 'Backspace' && !e.target.value && i > 0) { e.preventDefault(); bs[i - 1].value = ''; bs[i - 1].focus(); $('btn-join').disabled = true; }
    else if (e.key === 'ArrowLeft' && i > 0) { e.preventDefault(); bs[i - 1].focus(); } else if (e.key === 'ArrowRight' && i < 3) { e.preventDefault(); bs[i + 1].focus(); } });
  form.addEventListener('submit', e => { e.preventDefault(); const c = getCode(); if (c.length === 4 && !needName() && on.join) on.join(c); });
  // arrows walk the tiles and the room list in reading order (Tab works too)
  $('lobby-home').addEventListener('keydown', e => { const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]; if (!d) return;
    const nav = [...$('lobby-home').querySelectorAll('[data-nav]')], i = nav.indexOf(document.activeElement); e.preventDefault(); nav[(i < 0 ? 0 : i + d + nav.length) % nav.length].focus(); });
}
