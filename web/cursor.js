// The paddle cursor (NOTES 215). On the menus the mouse is a small pickleball paddle with the ball as its hot spot (cursor.css draws
// it). This file builds #cur, keeps it under the mouse and sets its states:
//   is-on / is-off   shown; hidden over a text field, the court list's scrollbar or a busy name (their native cursor says more)
//   is-ready         over something to press (the controls menuaudio.js plays its hover tap for): the paddle winds back, the ball lifts
//   is-down / is-hit the button is down: the face swings through and holds; is-hit replays the burst (ring + ticks) and the squash
//   is-plain         the press was on nothing in particular (the title's "anywhere to start"): a half swing, no burst
//   is-roll          a wheel is turning: the paddle nods the way the page goes, --roll-y
// and it rolls the ball's holes as the mouse travels and the page scrolls (.cur-holes rotate), and leans the whole paddle into fast
// moves around the ball (the hot spot never moves). The native cursor is hidden (html.has-cur) only while the paddle can show: a menu
// screen, an overlay card or the settings card is up (body data-screen / data-overlay / data-settings), and the pointer is a mouse.
// Never on a touch device or a coarse pointer; a touch mid-session hands the native cursor back until the mouse moves again.
import { SEL, SCOPE } from './menuaudio.js';

const NATIVE = 'input, textarea, select, [contenteditable], .room-bar, .is-opening[aria-busy="true"]';      // mirrors the :not() list in cursor.css
const BALL_R = 7.5, HOT = 10, BOX = 64;                                                                      // the drawing: a 64-unit square, the ball's centre at (10,10)
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// the paddle in its own upright frame: the butt of the grip at (0,0), the face up along -y; then turned to hang off the ball bottom-right
const PADDLE = `<svg class="cur-pad" viewBox="0 0 ${BOX} ${BOX}" aria-hidden="true"><defs>
  <linearGradient id="cur-face-g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset=".47" stop-color="#f7fbfd"/><stop offset=".53" stop-color="#e3eef4"/><stop offset="1" stop-color="#edf5f9"/></linearGradient>
  <linearGradient id="cur-gloss-g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
  <linearGradient id="cur-grip-g" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#5a636c"/><stop offset=".5" stop-color="#3c434b"/><stop offset="1" stop-color="#2a2f36"/></linearGradient>
  <clipPath id="cur-face-c"><path d="M-3.5 -17C-3.5 -20 -10 -21 -10 -25L-10 -34Q-10 -41 -3 -41L3 -41Q10 -41 10 -34L10 -25C10 -21 3.5 -20 3.5 -17Z"/></clipPath>
</defs><g transform="translate(46 46) rotate(-45)">
  <path class="cur-face" d="M-3.5 -17C-3.5 -20 -10 -21 -10 -25L-10 -34Q-10 -41 -3 -41L3 -41Q10 -41 10 -34L10 -25C10 -21 3.5 -20 3.5 -17Z"/>
  <g clip-path="url(#cur-face-c)"><rect class="cur-stripe" x="-16" y="-33.8" width="32" height="5" transform="rotate(-26 0 -31)"/><circle class="cur-logo" cx="0" cy="-23.5" r="2.4"/><ellipse class="cur-gloss" cx="0" cy="-37" rx="7.2" ry="3.6"/></g>
  <rect class="cur-grip" x="-2.6" y="-17.5" width="5.2" height="18" rx="1.6"/>
  <path class="cur-wrap" d="M-2.6 -14L2.6 -12M-2.6 -10L2.6 -8M-2.6 -6L2.6 -4"/>
  <rect class="cur-cap" x="-3.4" y="-1.6" width="6.8" height="3.2" rx="1.3"/>
</g></svg>`;
const BALL = `<svg class="cur-ball" viewBox="0 0 ${BOX} ${BOX}" aria-hidden="true"><defs>
  <radialGradient id="cur-ball-g" cx=".36" cy=".3" r=".72"><stop offset="0" stop-color="#fbffd6"/><stop offset=".6" stop-color="#e8fb2a"/><stop offset="1" stop-color="#ffe01a"/></radialGradient>
</defs><circle class="cur-ring" cx="${HOT}" cy="${HOT}" r="${BALL_R + 2.2}"/>
  <circle class="cur-ball-body" cx="${HOT}" cy="${HOT}" r="${BALL_R}"/>
  <g class="cur-holes"><circle cx="7.3" cy="7.6" r="1.1"/><circle cx="12.4" cy="7" r="1.1"/><circle cx="10" cy="11.8" r="1.1"/><circle cx="6.1" cy="12.4" r=".95"/><circle cx="13.9" cy="12.1" r=".95"/></g></svg>`;
const FX = `<svg class="cur-fx" viewBox="0 0 ${BOX} ${BOX}" aria-hidden="true"><circle class="cur-pop" cx="${HOT}" cy="${HOT}" r="9"/>
  <path class="cur-tick" style="--tx:-7px;--ty:0px" d="M-.5 10L-5.5 10"/><path class="cur-tick" style="--tx:-5px;--ty:-5px" d="M2.6 2.6L-.9 -.9"/><path class="cur-tick" style="--tx:0px;--ty:-7px" d="M10 -.5L10 -5.5"/></svg>`;

export function paddleCursor() {
  if (!matchMedia('(hover: hover) and (pointer: fine)').matches) return null;
  const el = document.createElement('div'); el.id = 'cur'; el.setAttribute('aria-hidden', 'true'); el.innerHTML = `<div class="cur-box">${PADDLE}${BALL}${FX}</div>`;
  document.body.appendChild(el);
  const html = document.documentElement, body = document.body, pad = el.querySelector('.cur-pad'), holes = el.querySelector('.cur-holes'), ring = el.querySelector('.cur-ring');
  let x = -100, y = -100, vx = 0, vy = 0, lean = 0, spin = 0, lastT = 0, raf = 0, mouse = false, inside = false, native = false, ready = false, lastTarget = null, rollT = 0, rPx = 0;
  const menuUp = () => body.dataset.screen !== 'hud' || !!body.dataset.overlay || !!body.dataset.settings;      // where the paddle shows; the bare court keeps the native cursor
  function sync() {
    const show = mouse && inside && menuUp() && !html.hasAttribute('data-mobile') && document.visibilityState === 'visible';
    html.classList.toggle('has-cur', show);
    el.classList.toggle('is-on', show && !native); el.classList.toggle('is-off', show && native);
    if (!show) { el.classList.remove('is-ready', 'is-down', 'is-hit'); ring.classList.remove('is-glow'); ready = false; lastTarget = null; }
  }
  const place = () => { el.style.transform = `translate3d(${x}px,${y}px,0) rotate(${lean}deg)`; };
  function look(t) {                                                                 // what is under the mouse: a text field (native), a control (ready) or nothing
    if (t === lastTarget) return; lastTarget = t;
    native = !!t?.closest?.(NATIVE);
    const c = native ? null : t?.closest?.(SEL);
    ready = !!(c && c.closest(SCOPE) && !c.disabled && c.getAttribute('aria-disabled') !== 'true');
    el.classList.toggle('is-ready', ready); ring.classList.toggle('is-glow', ready);
    sync();
  }
  function tick() {                                                                  // the lean eases toward the velocity and dies with it
    raf = 0; vx *= 0.82; vy *= 0.82;
    const want = reduced() ? 0 : clamp((vx - vy) * 0.007, -16, 16);                 // moving right or up, the grip trails clockwise; left or down, the other way
    lean += (want - lean) * 0.22;
    if (Math.abs(lean) < 0.05 && Math.abs(vx) + Math.abs(vy) < 2) { lean = 0; place(); return; }
    place(); raf = requestAnimationFrame(tick);
  }
  function roll(d) { if (reduced()) return; spin += d; holes.style.rotate = `${spin}deg`; }      // d in degrees
  addEventListener('pointermove', e => {
    if (e.pointerType !== 'mouse') { if (mouse) { mouse = false; sync(); } return; }
    const dt = Math.max(4, e.timeStamp - lastT), dx = mouse ? e.clientX - x : 0, dy = mouse ? e.clientY - y : 0;
    lastT = e.timeStamp; x = e.clientX; y = e.clientY;
    if (dt < 120) { vx = vx * 0.5 + (dx / dt) * 500; vy = vy * 0.5 + (dy / dt) * 500; }      // px/s, smoothed; a long pause starts fresh
    if (!rPx) rPx = el.offsetWidth * BALL_R / BOX || 6;
    if (dx || dy) roll((dx + dy) / (rPx * 1.6) * 57.3);                                       // the ball rolls with the travel, a touch slower than a ball its size would
    if (!mouse || !inside) { mouse = true; inside = true; sync(); }
    look(e.target); place(); if (!raf) raf = requestAnimationFrame(tick);
  }, { passive: true, capture: true });
  addEventListener('pointerover', e => { if (e.pointerType === 'mouse') { inside = true; look(e.target); } }, true);
  document.addEventListener('pointerout', e => { if (e.pointerType === 'mouse' && !e.relatedTarget) { inside = false; sync(); } }, true);      // left the window
  addEventListener('pointerdown', e => {
    if (e.pointerType !== 'mouse') { if (mouse) { mouse = false; sync(); } return; }
    look(e.target); if (!el.classList.contains('is-on')) return;
    el.classList.toggle('is-plain', !ready); el.classList.add('is-down');
    el.classList.remove('is-hit'); void el.offsetWidth; el.classList.add('is-hit');                       // replay the burst and the squash on every press
  }, true);
  const up = () => el.classList.remove('is-down');
  addEventListener('pointerup', up, true); addEventListener('pointercancel', up, true); addEventListener('blur', () => { up(); inside = false; sync(); });
  addEventListener('wheel', e => {
    if (!el.classList.contains('is-on')) return;
    const d = clamp(e.deltaY, -120, 120); roll(d * 0.75);
    el.style.setProperty('--roll-y', `${Math.sign(d) * 1.5}px`); el.classList.add('is-roll');
    clearTimeout(rollT); rollT = setTimeout(() => el.classList.remove('is-roll'), 140);
  }, { passive: true, capture: true });
  new MutationObserver(() => { lastTarget = null; sync(); }).observe(body, { attributes: true, attributeFilter: ['data-screen', 'data-overlay', 'data-settings'] });      // a new screen under a still mouse: re-read what is under it on the next move
  document.addEventListener('visibilitychange', sync);
  addEventListener('resize', () => { rPx = 0; });
  sync();
  return { el, state: () => ({ on: el.classList.contains('is-on'), off: el.classList.contains('is-off'), ready, down: el.classList.contains('is-down'), plain: el.classList.contains('is-plain'), native: html.classList.contains('has-cur'), x, y, lean, spin }) };      // tests
}

const cur = paddleCursor();
if (new URLSearchParams(location.search).get('uitest') === '1') window.__cur = cur;      // test/cursor-e2e.mjs
