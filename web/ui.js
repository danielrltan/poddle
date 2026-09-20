// Poddle UI: every bit of DOM work for the HUD and the screens lives here. No game logic, no sockets, no three.js.
// Design system: ui.css · markup: index.html · spec, copy and this API: docs/ui-spec.md
const $ = id => document.getElementById(id);
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const restart = (el, cls) => { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); };   // replay a one-shot CSS animation
const setText = (el, t) => { if (el.textContent !== t) el.textContent = t; };

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
export function pointBanner(won) {                         // small tag under the scoreboard; these two strings and nothing else
  const b = $('banner'); $('banner-text').textContent = won ? 'Your point!' : 'Their point';
  b.classList.toggle('is-me', won); b.classList.toggle('is-them', !won); restart(b, 'show');
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
export function matchResult(won, me, them, name) {
  $('result').classList.toggle('is-lose', !won);
  $('medal').className = 'medal ' + (won ? 'is-gold' : 'is-silver');
  $('result-title').textContent = won ? 'You win!' : `${name} wins`;
  $('tally-sc-me').textContent = me; $('tally-sc-them').textContent = them; $('tally-name-them').textContent = name;
  $('tally-me').classList.toggle('is-winner', won); $('tally-them').classList.toggle('is-winner', !won);
  showOverlay('match');
}

// ---------- connection status ----------
const ROW = {
  airpod: { ok: '', wait: 'Take one AirPod out and hold it in your hand.', bad: 'Signal lost. Check the AirPod is still connected to this Mac.' },
  game: { ok: '', wait: 'Finding the game', bad: 'Can’t reach the game. Trying again.' },
  camera: { ok: 'Stand where it can see you.', wait: 'Allow the camera when the browser asks.', bad: 'No camera. Press M to change how you move.', off: 'No camera. Press M to change how you move.' },
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
      for (const el of [$('st-' + key), $('row-' + key)]) if (el) { el.classList.remove('is-ok', 'is-wait', 'is-bad', 'is-off'); el.classList.add('is-' + v); }      // the HUD lights are gone; the rows on the set-up screen stay
      $(`row-${key}-text`).textContent = ROW[key][v] || ''; $(`row-${key}-state`).textContent = STATE_WORD[v];
      $('lights').classList.toggle('all-ok', ['airpod', 'game', 'camera'].every(k => status[k] === 'ok' || status[k] === 'off'));
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
export function setMode(name) { setText($('mode'), name); }
export function toggle(id) { const el = $(id); el.hidden = !el.hidden; return !el.hidden; }
export function setCamera(ready) { $('camwrap').hidden = !ready; }
export const isVisible = id => !$(id).hidden;
export function setStat(id, text) { setText($(id), String(text)); }                     // stats panel numbers (#pw, #px, #py, …)
export function fullscreen(on) {
  const d = document;
  if (on === undefined) on = !d.fullscreenElement;
  try { const p = on ? (d.fullscreenElement ? null : d.documentElement.requestFullscreen?.()) : (d.fullscreenElement ? d.exitFullscreen?.() : null); if (p && p.catch) p.catch(() => {}); } catch { /* not allowed: fine */ }
}

// key strip: shown on any key press / pointer move and when the HUD first appears, gone six seconds later. Never by game events.
let idleT;
export function wake() { const k = $('keys'); k.classList.remove('is-idle'); clearTimeout(idleT); idleT = setTimeout(() => k.classList.add('is-idle'), 6000); }
addEventListener('keydown', wake); addEventListener('pointermove', wake); addEventListener('pointerdown', wake);

// finished one-shots go back to rest so nothing is left promoted or mid-animation
$('callout').addEventListener('animationend', e => { if (e.target === e.currentTarget) e.currentTarget.classList.remove('go'); });
$('banner').addEventListener('animationend', e => { if (e.animationName === 'banner-drop' || e.animationName === 'banner-hold') e.currentTarget.classList.remove('show'); });
for (const id of ['sc-me', 'sc-them', 'rally']) $(id).addEventListener('animationend', e => e.currentTarget.classList.remove('pop'));
export function onStart(fn) { $('btn-start').addEventListener('click', fn); }
export function onRetry(fn) { $('btn-retry').addEventListener('click', fn); }

// ---------- lobby ----------
// Four views inside #screen-lobby, one at a time: home (three tiles + open rooms), create (public / private), share (the
// new room's code and link), code (four letter boxes). main.js owns the socket; this only draws and reports what was chosen.
const CODE_OK = /[ABCDEFGHJKMNPQRSTUVWXYZ23456789]/g;                                   // the server's alphabet: no I, L, O, 0, 1
export const cleanCode = t => { t = String(t || '').toUpperCase(); const m = /ROOM=([A-Z0-9]{4})/.exec(t); return ((m ? m[1] : t).match(CODE_OK) || []).slice(0, 4).join(''); };   // a pasted link works too
const VIEW_TITLE = { home: 'Play', create: 'Create room', share: 'Your room', code: 'Enter code' };
const boxes = () => [...$('code-boxes').children];
let view = 'home', roomsKey = '', on = {};
export function onLobby(handlers) { on = handlers; }                                    // { quick(), create(isPublic), join(code), start(), back(), copied() }
export function lobbyView(name, { code } = {}) {
  if (!name) return view;
  view = VIEW_TITLE[name] ? name : 'home';
  for (const el of document.querySelectorAll('#screen-lobby .lobby-view')) el.hidden = el.dataset.view !== view;
  setText($('lobby-title'), VIEW_TITLE[view]); codeError('');
  if (view === 'code') setCode(code || '');
  const first = { home: $('btn-quick'), create: $('btn-create-go'), share: $('btn-share-go'), code: boxes().find(b => !b.value) || $('btn-join') }[view];
  setTimeout(() => { if (slots.menu === 'lobby') first.focus({ preventScroll: true, focusVisible: true }); }, 60);    // after the key that brought us here is up: a held Enter must not press it
}
export function lobbyRooms(rooms = [], online = 0) {
  const list = $('room-list'), key = rooms.map(r => r.code + r.players).join();
  $('lobby-online').hidden = !(online > 1); setText($('lobby-online'), `${online} online`);      // 1 online is you: say nothing
  if (key === roomsKey) return; roomsKey = key;                                       // the list arrives every second: only touch the DOM (and the focus) when it changed
  const had = document.activeElement && document.activeElement.dataset.code;
  list.textContent = '';
  for (const r of rooms.slice(0, 12)) { const li = document.createElement('li'), b = document.createElement('button');
    b.className = 'room-row'; b.dataset.code = r.code; b.dataset.nav = ''; b.innerHTML = `<b></b><span>${r.players ? '1 player' : 'Empty'}</span>`; b.firstChild.textContent = r.code;
    li.appendChild(b); list.appendChild(li); }
  $('room-empty').hidden = rooms.length > 0;
  if (had) (list.querySelector(`[data-code="${had}"]`) || $('btn-quick')).focus({ preventScroll: true });
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
export function setRoom(code, link = '') {
  $('room-pill').hidden = $('key-leave').hidden = !code; setText($('room-code'), code || ''); $('room-pill').title = link ? 'Copy link' : '';      // no link on localhost: promise nothing
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
  $('btn-quick').addEventListener('click', () => on.quick && on.quick());
  $('btn-create').addEventListener('click', () => lobbyView('create'));
  $('btn-code').addEventListener('click', () => lobbyView('code'));
  $('btn-create-go').addEventListener('click', () => on.create && on.create($('seg').querySelector('[aria-checked="true"]').dataset.public === '1'));
  $('btn-share-go').addEventListener('click', () => on.start && on.start());
  $('btn-copy').addEventListener('click', e => copyLink(e.currentTarget)); $('room-pill').addEventListener('click', e => copyLink(e.currentTarget));
  for (const b of document.querySelectorAll('[data-back]')) b.addEventListener('click', () => on.back && on.back());
  $('room-list').addEventListener('click', e => { const b = e.target.closest('.room-row'); if (b && on.join) on.join(b.dataset.code); });
  const pick = opt => { for (const o of $('seg').children) { const yes = o === opt; o.setAttribute('aria-checked', yes); o.tabIndex = yes ? 0 : -1; } setText($('seg-note'), opt.dataset.public === '1' ? 'Shows in open rooms' : 'Join by code only'); };
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
  form.addEventListener('submit', e => { e.preventDefault(); const c = getCode(); if (c.length === 4 && on.join) on.join(c); });
  // arrows walk the tiles and the room list in reading order (Tab works too)
  $('lobby-home').addEventListener('keydown', e => { const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]; if (!d) return;
    const nav = [...$('lobby-home').querySelectorAll('[data-nav]')], i = nav.indexOf(document.activeElement); e.preventDefault(); nav[(i < 0 ? 0 : i + d + nav.length) % nav.length].focus(); });
}
