// The Wii-style pointer (NOTES 216; it replaced the paddle cursor of NOTES 215). On the menus the mouse is the white pointing glove
// of a console menu, drawn in the UI's own white and outline blue with a soft shadow (cursor.css draws it). This file builds #cur,
// keeps it under the mouse and sets its states:
//   is-on / is-off   shown; hidden over a text field, the court list's scrollbar or a busy name (their native cursor says more)
//   is-ready         over something to press (the controls menuaudio.js plays its hover tap for): the hand lifts a little
//   is-down          the button is down: the finger pushes in; is-plain when the press was on nothing in particular (a lighter push)
//   is-roll          a wheel is turning: the hand closes into the grab fist and nudges the way the page goes (--roll-y)
// and it tilts with fast moves, as a pointer does when the remote rolls in the hand (the hot spot, the fingertip, never moves).
// The native cursor is hidden (html.has-cur) only while the hand can show: a menu screen, an overlay card or the settings card is
// up (body data-screen / data-overlay / data-settings), and the pointer is a mouse. Never on a touch device or a coarse pointer;
// a touch mid-session hands the native cursor back until the mouse moves again.
import { SEL, SCOPE } from './menuaudio.js';

const NATIVE = 'input, textarea, select, [contenteditable], .room-bar, .is-opening[aria-busy="true"]';      // mirrors the :not() list in cursor.css
export const HOT = [14, 4], BOX = 64;                                                                        // the drawing: a 64-unit square, the fingertip at (14,4) = the hot spot
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// the pointing glove: the index finger up from the fingertip, three curled fingers as knuckle bumps to its right, the thumb out to
// the left, a cuff at the wrist. One outline, so the stroke never crosses the inside; the creases are their own light strokes
const HAND = `<svg class="cur-hand" viewBox="0 0 ${BOX} ${BOX}" aria-hidden="true"><defs>
  <linearGradient id="cur-skin-g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset=".55" stop-color="#fbfdfe"/><stop offset="1" stop-color="#e9f2f7"/></linearGradient>
  <linearGradient id="cur-cuff-g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5ccdf3"/><stop offset="1" stop-color="#1a9fd0"/></linearGradient>
</defs><g class="cur-body">
  <path class="cur-glove" d="M10 30L10 9Q10 4 14 4Q18 4 18 9L18 25Q19.5 20.5 24 21.5Q28 22.5 28 27.5Q29.5 23.5 33.5 24.5Q37.5 25.5 37 30Q38.5 27 41.5 28.5Q44.5 30 44 34L44 43Q44 51 36 51L15 51Q8 51 8 44L8 37Q3.5 35 2.6 30Q2 25.5 5.8 24.8Q9.2 24.2 10 28Z"/>
  <path class="cur-crease" d="M18 27L18 35M28 29.5L28 37M37 31.5L37 38.5M8 37.5Q11 34.5 10.5 30.5"/>
  <rect class="cur-cuff" x="9" y="47" width="34" height="8" rx="3.5"/>
</g></svg>`;
// the grab: the same glove closed, four knuckles over the top, the thumb folded across. Shown while a wheel turns (is-roll)
const FIST = `<svg class="cur-fist" viewBox="0 0 ${BOX} ${BOX}" aria-hidden="true"><g class="cur-body">
  <path class="cur-glove" d="M9 24Q9.5 18.5 14.5 18.5Q19.5 18.5 19.5 23.5Q20.5 18 25.5 18Q30.5 18 30.5 23.5Q31.5 18.5 36.5 18.5Q41.5 18.5 41.5 24Q44.5 21.5 46.5 24.5Q48 27 46.5 32L45 42Q44 50 36 50L15 50Q8 50 8 43Z"/>
  <path class="cur-crease" d="M19.5 24L19.5 30M30.5 24L30.5 30M41.5 25L41.5 31"/>
  <path class="cur-thumb" d="M8 36Q8 31 13 30.5L34 30.5Q39 30.5 39 35Q39 39.5 34 39.5L13 39.5Q8 39.5 8 36Z"/>
  <rect class="cur-cuff" x="9" y="46" width="34" height="8" rx="3.5"/>
</g></svg>`;

export function wiiCursor() {
  if (!matchMedia('(hover: hover) and (pointer: fine)').matches) return null;
  const el = document.createElement('div'); el.id = 'cur'; el.setAttribute('aria-hidden', 'true'); el.innerHTML = `<div class="cur-box">${HAND}${FIST}</div>`;
  document.body.appendChild(el);
  const html = document.documentElement, body = document.body;
  let x = -100, y = -100, vx = 0, vy = 0, lean = 0, lastT = 0, raf = 0, mouse = false, inside = false, native = false, ready = false, lastTarget = null, rollT = 0;
  const menuUp = () => body.dataset.screen !== 'hud' || !!body.dataset.overlay || !!body.dataset.settings;      // where the hand shows; the bare court keeps the native cursor
  function sync() {
    const show = mouse && inside && menuUp() && !html.hasAttribute('data-mobile') && document.visibilityState === 'visible';
    html.classList.toggle('has-cur', show);
    el.classList.toggle('is-on', show && !native); el.classList.toggle('is-off', show && native);
    if (!show) { el.classList.remove('is-ready', 'is-down', 'is-roll'); ready = false; lastTarget = null; }
  }
  const place = () => { el.style.transform = `translate3d(${x}px,${y}px,0) rotate(${lean}deg)`; };
  function look(t) {                                                                 // what is under the mouse: a text field (native), a control (ready) or nothing
    if (t === lastTarget) return; lastTarget = t;
    native = !!t?.closest?.(NATIVE);
    const c = native ? null : t?.closest?.(SEL);
    ready = !!(c && c.closest(SCOPE) && !c.disabled && c.getAttribute('aria-disabled') !== 'true');
    el.classList.toggle('is-ready', ready);
    sync();
  }
  function tick() {                                                                  // the tilt eases toward the velocity and dies with it
    raf = 0; vx *= 0.82; vy *= 0.82;
    const want = reduced() ? 0 : clamp(vx * 0.006, -12, 12);                         // a quick move right rolls the hand clockwise, left the other way, as a remote does
    lean += (want - lean) * 0.2;
    if (Math.abs(lean) < 0.05 && Math.abs(vx) + Math.abs(vy) < 2) { lean = 0; place(); return; }
    place(); raf = requestAnimationFrame(tick);
  }
  addEventListener('pointermove', e => {
    if (e.pointerType !== 'mouse') { if (mouse) { mouse = false; sync(); } return; }
    const dt = Math.max(4, e.timeStamp - lastT), dx = mouse ? e.clientX - x : 0, dy = mouse ? e.clientY - y : 0;
    lastT = e.timeStamp; x = e.clientX; y = e.clientY;
    if (dt < 120) { vx = vx * 0.5 + (dx / dt) * 500; vy = vy * 0.5 + (dy / dt) * 500; }      // px/s, smoothed; a long pause starts fresh
    if (!mouse || !inside) { mouse = true; inside = true; sync(); }
    look(e.target); place(); if (!raf) raf = requestAnimationFrame(tick);
  }, { passive: true, capture: true });
  addEventListener('pointerover', e => { if (e.pointerType === 'mouse') { inside = true; look(e.target); } }, true);
  document.addEventListener('pointerout', e => { if (e.pointerType === 'mouse' && !e.relatedTarget) { inside = false; sync(); } }, true);      // left the window
  addEventListener('pointerdown', e => {
    if (e.pointerType !== 'mouse') { if (mouse) { mouse = false; sync(); } return; }
    look(e.target); if (!el.classList.contains('is-on')) return;
    el.classList.toggle('is-plain', !ready); el.classList.add('is-down');
  }, true);
  const up = () => el.classList.remove('is-down');
  addEventListener('pointerup', up, true); addEventListener('pointercancel', up, true); addEventListener('blur', () => { up(); inside = false; sync(); });
  addEventListener('wheel', e => {
    if (!el.classList.contains('is-on')) return;
    el.style.setProperty('--roll-y', `${Math.sign(e.deltaY) * 2}px`); el.classList.add('is-roll');
    clearTimeout(rollT); rollT = setTimeout(() => el.classList.remove('is-roll'), 220);
  }, { passive: true, capture: true });
  new MutationObserver(() => { lastTarget = null; sync(); }).observe(body, { attributes: true, attributeFilter: ['data-screen', 'data-overlay', 'data-settings'] });      // a new screen under a still mouse: re-read what is under it on the next move
  document.addEventListener('visibilitychange', sync);
  sync();
  return { el, state: () => ({ on: el.classList.contains('is-on'), off: el.classList.contains('is-off'), ready, down: el.classList.contains('is-down'), plain: el.classList.contains('is-plain'), roll: el.classList.contains('is-roll'), native: html.classList.contains('has-cur'), x, y, lean }) };      // tests
}

const cur = wiiCursor();
if (new URLSearchParams(location.search).get('uitest') === '1') window.__cur = cur;      // test/cursor-e2e.mjs
