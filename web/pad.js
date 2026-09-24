// The phone's side of a phone paddle (NOTES 34). Motion events -> padmotion.js -> one socket to the game server, which
// passes every sample on to the tab whose code this is. Nothing is installed: the page is the controller.
import { PadMotion } from './padmotion.js';

const $ = id => document.getElementById(id);
const qs = new URLSearchParams(location.search);
// A paddle code is P- and 4 letters or numbers (NOTES 81). The P- is built into the box, so whatever arrives (typed, pasted as
// "P-ABCD", or a 'P' typed out of habit before the four) comes down to the four. A 6-character code from before the switch still works.
const clean = t => { let c = String(t == null ? '' : t).toUpperCase().replace(/^\s*P\s*-\s*/, '').replace(/[^A-HJ-NP-Z2-9]/g, ''); if (c.length === 5 && c[0] === 'P') c = c.slice(1); return c.slice(0, 6); };
const shown = c => (c.length === 4 ? 'P-' + c : c);
const ok = c => c.length === 4 || c.length === 6;
const GAME = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
const view = v => { document.body.dataset.view = v; };
// Motion (decorative only; pad.css holds the rest). WAAPI ignores the CSS media query, so reduced motion is checked here. The
// keyframes use the individual translate/scale properties so they compose with pad.css's view-rise entry instead of cutting it off.
const RM = matchMedia('(prefers-reduced-motion: reduce)'), still = el => RM.matches || !el.animate;
const restart = (el, c) => { el.classList.remove(c); void el.offsetWidth; el.classList.add(c);      // same idea as ui.js restart(); off again once played, so a redisplay does not replay it
  el.addEventListener('animationend', function f(e) { if (e.target !== el || !/^(nudge|note-in)$/.test(e.animationName)) return; el.classList.remove(c); el.removeEventListener('animationend', f); }); };
const say = (el, t) => { if (el.textContent === t) return; el.textContent = t;      // new words slide up into place; unchanged ones never re-animate
  if (still(el) || el.getAnimations().some(a => a.animationName)) return;      // still rising in with the view: that is enough
  el.animate([{ opacity: 0, translate: '0 .25rem' }, { opacity: 1, translate: '0 0' }], { duration: 260, easing: 'cubic-bezier(.22,1,.36,1)' }); };
const bad = t => { $('code-note').textContent = t; restart(document.querySelector('.code-field'), 'is-bad'); restart($('code-note'), 'is-new'); };
const IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
const pad = new PadMotion(IOS ? 'xyz' : 'zxy');      // WebKit names rotationRate x,y,z; Chrome and Firefox follow the spec's z,x,y
const stats = window.__pad = { sent: 0, hz: 0, rtt: 0, host: false, open: false, get view() { return document.body.dataset.view; }, get naming() { return pad.naming + (pad.locked ? '' : '?'); } };
let code = clean(qs.get('k')), ws = null, started = false, sawMotion = false, peak = 0, fxText = '';

// ---------- the code ----------
if (ok(code)) { $('start-code').textContent = shown(code); view('start'); } else { view('code'); if (qs.get('k')) $('code-note').textContent = 'That code didn’t look right. It is P- and 4 letters or numbers.'; }
$('code-in').addEventListener('input', e => { e.target.value = clean(e.target.value); });
$('code-form').addEventListener('submit', e => { e.preventDefault(); const c = clean($('code-in').value);
  if (!ok(c)) { bad('The code is P- and 4 letters or numbers.'); return; }
  code = c; history.replaceState(null, '', 'pad.html?k=' + c); $('start-code').textContent = shown(c); view('start'); });

// ---------- the sensors ----------
const now = e => { const p = performance.now(), t = e && e.timeStamp; return (t > 0 && Math.abs(t - p) < 1000 ? t : p) / 1000; };      // the event's own clock when it is on the page's timeline (some browsers stamp with the wall clock)
const r5 = v => Math.round(v * 1e5) / 1e5, r3 = v => Math.round(v * 1e3) / 1e3;
function onOrientation(e) { pad.orientation(e, now(e)); }
function onMotion(e) {
  if (e.rotationRate && Number.isFinite(e.rotationRate.alpha)) window.__rates = true;
  const s = pad.motion(e, now(e)); if (!s) return;
  sawMotion = true;
  const p = Math.hypot(s.r[0], s.r[1], s.r[2]); if (p > peak) peak = p;
  if (ws && ws.readyState === 1 && stats.host) { ws.send(JSON.stringify({ type: 'm', t: r5(s.t), q: s.q.map(r5), r: s.r.map(r3), a: s.a.map(r3) })); stats.sent++; }
}
async function allow() {                            // iOS asks once per visit, and only from a tap. Everyone else has no such call
  // Motion first: it is the one that matters, and it is asked while the tap still counts. Orientation after the dialog may be
  // refused for want of a tap (WebKit varies), so any grant is enough to carry on; the 2.5 s check in start() says what is missing.
  let asked = 0, granted = 0;
  for (const E of [window.DeviceMotionEvent, window.DeviceOrientationEvent]) if (E && typeof E.requestPermission === 'function') {
    asked++; try { if (await E.requestPermission() === 'granted') granted++; } catch { /* not from a tap, or blocked */ }
  }
  return !asked || granted > 0;
}
let lock = null;
if (!('wakeLock' in navigator)) $('live-note').textContent = 'If the screen dims, set Auto-Lock to Never while you play.';
async function stayAwake() { try { if ('wakeLock' in navigator && document.visibilityState === 'visible') lock = await navigator.wakeLock.request('screen'); } catch { /* low battery, or not allowed: the screen may dim */ } }
document.addEventListener('visibilitychange', () => { if (started && document.visibilityState === 'visible') stayAwake(); });

async function start() {
  if (!window.DeviceMotionEvent || !window.DeviceOrientationEvent) { view('nomotion'); return; }
  if (!window.isSecureContext) { $('nomotion-p').textContent = 'Phones only share their motion sensors with a secure (https) page. Open poddleball.com instead.'; view('nomotion'); return; }
  if (!await allow()) { view('denied'); return; }
  if (!started) { window.addEventListener('deviceorientation', onOrientation); window.addEventListener('devicemotion', onMotion); }
  started = true; sawMotion = false; stayAwake(); connect(); view('live'); render();
  setTimeout(() => { if (stats.view !== 'live' || sawMotion) return;      // nothing came: a laptop (events, no sensors), or iOS let one sensor through and not the other
    view(pad.q || window.__rates ? 'denied' : 'nomotion'); started = false; }, 2500);
}
$('go').addEventListener('click', start); $('retry1').addEventListener('click', start); $('retry2').addEventListener('click', start);

// ---------- the socket ----------
let delay = 300, pingAt = 0;
function connect() {
  if (ws && ws.readyState < 2) return;
  const s = ws = new WebSocket(`${GAME}/?padfor=${code}`);
  s.onopen = () => { delay = 300; stats.open = true; render(); };
  s.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.type === 'padhost') { if (m.bad) { view('code'); bad('That code didn’t work. Check it and try again.'); started = false; s.close(); return; } stats.host = !!m.on; render(); }
    else if (m.type === 'pong') stats.rtt = performance.now() - pingAt;
    else if (m.type === 'fx') fx(m); };
  s.onclose = () => { if (ws !== s) return; stats.open = false; stats.host = false; render(); if (started) setTimeout(connect, delay); delay = Math.min(delay * 1.6, 2500); };
  s.onerror = () => {};
}
setInterval(() => { if (ws && ws.readyState === 1) { pingAt = performance.now(); ws.send(JSON.stringify({ type: 'ping', c: 1 })); } }, 2000);
const key = k => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'padkey', k })); };
// A gripped phone gets its screen pressed all rally long, so these two only answer to a press held for 0.7 s (the button fills up meanwhile).
for (const [id, k] of [['btn-cal', 'c'], ['btn-center', 'r']]) { const b = $(id); let t = 0;
  const off = () => { clearTimeout(t); b.classList.remove('is-held'); };
  b.addEventListener('pointerdown', () => { off(); b.classList.add('is-held'); t = setTimeout(() => { off(); key(k); b.classList.add('is-done'); setTimeout(() => b.classList.remove('is-done'), 600); }, 700); });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, off);
  b.addEventListener('contextmenu', e => e.preventDefault()); }

// ---------- done playing ----------
// The X hangs up properly: the sensors are let go, the screen may sleep again and the socket is closed for good (started =
// false, so onclose does not reconnect). The computer sees the paddle leave, as it would if the tab had gone.
// A tab can only close itself when a script opened it, and this one was opened by hand or by scanning the code, so
// window.close() is very likely refused: the 'done' view is shown first and says the last step out loud.
function quit() {
  started = false;
  window.removeEventListener('deviceorientation', onOrientation); window.removeEventListener('devicemotion', onMotion);
  if (lock) { try { lock.release(); } catch { /* already gone */ } lock = null; }
  if (ws) { const s = ws; ws = null; try { s.close(); } catch { /* already closing */ } }
  stats.open = stats.host = false;
  view('done');
  window.close();
}
{ const b = $('btn-quit'); let t = 0;
  const off = () => { clearTimeout(t); b.classList.remove('is-held'); };
  b.addEventListener('pointerdown', () => { off(); b.classList.add('is-held'); t = setTimeout(() => { off(); b.classList.add('is-done'); quit(); }, 700); });      // is-done closes the ring in green: window.close() is usually refused, so the button is still on screen behind the 'done' view
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, off);
  b.addEventListener('contextmenu', e => e.preventDefault()); }
$('again').addEventListener('click', start);      // changed their mind, or hit it by accident: straight back to playing

// ---------- what the tab says back ----------
// The screen flash on a hit (the whole screen, brightest at the edges), in the trail's colour for that power: scene.js trailHeat + trailRamp exactly (white -> yellow ->
// orange up to SMASH_N, red only past it; n is already scene.js shownN, so a lob comes in as 0 = white). Change one, change both.
const SMASH_N = 0.76, SMASH_RED = 0.95, lerp = (a, b, t) => a + (b - a) * t, cl = v => Math.max(0, Math.min(1, v));
function trailRGB(n) { const u = 3 * (n > SMASH_N ? 0.8 + 0.2 * Math.pow(cl((n - SMASH_N) / (SMASH_RED - SMASH_N)), 2) : 0.70 * Math.pow(cl((n - 0.06) / (SMASH_N - 0.06)), 0.8));
  const g = u < 1 ? lerp(1, 0.9, u) : u < 2 ? lerp(0.9, 0.5, u - 1) : lerp(0.5, 0.12, u - 2), b = u < 1 ? lerp(1, 0.3, u) : u < 2 ? lerp(0.3, 0.12, u - 1) : lerp(0.12, 0.08, u - 2);
  return `rgb(255 ${Math.round(g * 255)} ${Math.round(b * 255)})`; }
let glowAnim = null, glowAt = -1e9;
function glow(n, fresh) {
  const el = $('glow'); if (!el || !el.animate) return; n = Math.max(0, Math.min(1, n));
  if (!fresh && !(glowAnim && glowAnim.playState === 'running')) return;      // a late recolour after the flash has gone: nothing to show (a bet's tint comes 0.3 s + two hops after it: a fixed 300 ms dropped them all)
  el.style.setProperty('--c', trailRGB(n)); el.style.setProperty('--n', n.toFixed(2));
  const smash = n > SMASH_N;      // a smash flares twice (strict: every bet and every capped drive sits at exactly SMASH_N, and 60% of real swings double-flared)
  if (!fresh && !(smash && !glowAnim.smash)) return;      // a human's smash is only ever a tint (the flash went out on the bet, pale): it restarts as the smash's flare, once, no second buzz
  glowAt = performance.now(); if (glowAnim) glowAnim.cancel();
  glowAnim = el.animate(smash ? [{ opacity: 0 }, { opacity: 1, offset: 0.04 }, { opacity: 0.35, offset: 0.3 }, { opacity: 0.95, offset: 0.38 }, { opacity: 0 }] : [{ opacity: 0 }, { opacity: 0.9 + 0.1 * n, offset: 0.05 }, { opacity: 0.55 + 0.3 * n, offset: 0.3 }, { opacity: 0 }],
    { duration: smash ? 900 : 420 + 380 * n, easing: 'cubic-bezier(.2,.7,.3,1)' }); glowAnim.smash = smash;
}
window.__glow = glow;      // test/pad-glow shots
// A buzz: navigator.vibrate where there is one (Android). iPhone Safari has none, so there a click on the hidden switch's
// label gives one fixed-strength system tick (iOS 18+); iOS may only allow it close to a tap, so mid-rally it can stay silent.
const tickEl = $('tick'), CAN_VIBRATE = typeof navigator.vibrate === 'function';
function buzz(ms, ticks = 1) {
  if (CAN_VIBRATE) { try { navigator.vibrate(ms); } catch { /* blocked */ } return; }
  for (let i = 0; i < ticks; i++) setTimeout(() => { try { tickEl && tickEl.click(); } catch { /* no switch (older iOS) */ } }, i * 90);
}
const FX_TEXT = { cal: 'Follow the steps on your computer', play: 'Swing!', idle: '' };
function fx(m) {
  if (m.fx === 'hit') { buzz(20 + Math.round(50 * (m.b != null ? m.b : m.n || 0)), (m.n || 0) > SMASH_N ? 2 : 1); glow(m.n || 0, true); }      // a smash ticks twice on an iPhone (a tick has no strength)
  else if (m.fx === 'tint') glow(m.n || 0, false);      // the settled swing, a moment after the hit went out on the early guess: recolour, no second buzz
  else if (m.fx === 'point') buzz([30, 60, 30], 2);
  else if (m.fx in FX_TEXT) { fxText = FX_TEXT[m.fx]; render(); }
}

// ---------- the screen ----------
function render() {
  const on = stats.open && stats.host, was = document.body.dataset.link; document.body.dataset.link = on ? 'on' : 'wait';
  const ring = $('ring'); if (on && was === 'wait' && !still(ring)) ring.animate([{ scale: 1 }, { scale: 1.07, offset: 0.4 }, { scale: 1 }], { duration: 440, easing: 'cubic-bezier(.34,1.56,.64,1)' });      // a little 'hello' when the computer answers
  say($('live-h'), on ? (fxText || 'Connected') : stats.open ? 'Looking for your computer' : 'Reconnecting');
  say($('live-p'), on ? 'Watch the computer, not the phone. Keep this page open.' : stats.open ? `Open poddleball.com on a computer and press Play. This phone is paddle ${code}.` : 'Check this phone is online.');
}
let lastSent = 0;
setInterval(() => { stats.hz = stats.sent - lastSent; lastSent = stats.sent; $('live-stats').textContent = stats.open && stats.host ? `${stats.hz} samples/s · ${Math.round(stats.rtt)} ms` : ''; }, 1000);
setInterval(() => { $('ring-fill').style.transform = `scaleY(${Math.min(1, peak / 25).toFixed(3)})`; const w = $('ring-word'), t = peak > 20 ? 'Smash' : peak > 9 ? 'Swing' : 'Ready';
  if (w.textContent !== t) { w.textContent = t; if (t !== 'Ready' && !still(w)) w.animate([{ scale: 1.25 }, { scale: 1 }], { duration: 280, easing: 'cubic-bezier(.34,1.56,.64,1)' }); } peak *= 0.8; }, 100);      // the meter jumps with a swing and sinks back. 'Smash' from 20 rad/s: below ~19 phone rad/s the game can no longer call one, however wide the stroke (web/motion.js PACE_R x sqrt(RATE_GAIN), NOTES 82); it said so from 18
