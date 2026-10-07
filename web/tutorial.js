// The tutorial (NOTES 217): a few cards over the menu that teach the game in a minute. The owner asked for it on 2026-10-05,
// so it is the one first-visit overlay the "No announcement notices" rule allows (CLAUDE.md). It opens by itself ONCE, for a
// new browser, on the home; after that only Settings > Tutorial opens it.
// Remembered in localStorage poddle.tutorial ('1' = seen; sessionStorage if localStorage is blocked, memory if both are) and
// marked the moment it opens, so a reload halfway never brings it back. A browser that already holds any Poddle key is a
// returning player: it is marked seen without being shown. Never on its own under automation (navigator.webdriver: the
// browser tests start empty) or on a court / watch link; ?tut=1 forces it, ?tut=0 keeps it shut.
import * as ui from './ui.js';

const KEY = 'poddle.tutorial', OLD = ['poddle.name', 'poddle.settings', 'poddle.device', 'poddle.cal', 'poddle.courts', 'poddle.view', 'poddle.camPrimer'];
const store = s => { try { const t = window[s]; t.getItem(KEY); return t; } catch { return null; } };
let memSeen = false;
const seen = () => { for (const s of ['localStorage', 'sessionStorage']) { const t = store(s); if (t && t.getItem(KEY)) return true; } return memSeen; };
const markSeen = () => { memSeen = true; for (const s of ['localStorage', 'sessionStorage']) { const t = store(s); if (t) { try { t.setItem(KEY, '1'); return; } catch { /* full or blocked: the next one */ } } } };
const returning = () => { const t = store('localStorage'); return !!t && OLD.some(k => t.getItem(k) != null); };

const qs = new URLSearchParams(location.search), FORCE = qs.get('tut');
const MOBILE = () => document.documentElement.hasAttribute('data-mobile');

// ---- the art: small inline SVGs in the game's colours, animated in CSS (.tut-art *) ----
const PHONE = (x, y, s = 1, cls = '') => `<g class="${cls}" transform="translate(${x} ${y}) scale(${s})"><rect x="-11" y="-20" width="22" height="40" rx="5" fill="#fff" stroke="#4b535b" stroke-width="3"/><rect x="-7" y="-14" width="14" height="25" rx="2" fill="#d6f0fa"/><path d="M-3 15h6" stroke="#4b535b" stroke-width="2.5" stroke-linecap="round"/></g>`;
const BALL = (x, y, r = 9, cls = '') => `<g class="${cls}"><circle cx="${x}" cy="${y}" r="${r}" fill="#e8fb2a" stroke="#cfae00" stroke-width="2"/><circle cx="${x - r * .35}" cy="${y - r * .2}" r="${r * .16}" fill="#cfae00"/><circle cx="${x + r * .3}" cy="${y + r * .3}" r="${r * .16}" fill="#cfae00"/><circle cx="${x + r * .25}" cy="${y - r * .45}" r="${r * .13}" fill="#cfae00"/></g>`;
const ART = {
  pair: `<svg viewBox="0 0 240 130" aria-hidden="true"><rect x="22" y="14" width="120" height="78" rx="8" fill="#fff" stroke="#4b535b" stroke-width="3.5"/><rect x="32" y="24" width="100" height="58" rx="3" fill="#bfe1f4"/>
    <g fill="#4b535b"><rect x="62" y="31" width="40" height="40" rx="3" fill="#fff"/><rect x="66" y="35" width="10" height="10"/><rect x="88" y="35" width="10" height="10"/><rect x="66" y="57" width="10" height="10"/><rect x="80" y="49" width="5" height="5"/><rect x="88" y="60" width="5" height="5"/><rect x="80" y="38" width="4" height="4"/></g>
    <path d="M10 98h144l-10 10H20z" fill="#d9e9f2" stroke="#4b535b" stroke-width="3.5" stroke-linejoin="round"/>
    <path class="tut-beam" d="M168 64 Q150 52 106 50" fill="none" stroke="#34beed" stroke-width="3" stroke-dasharray="5 6" stroke-linecap="round"/>${PHONE(190, 70, 1.25, 'tut-bob')}</svg>`,
  grip: `<svg viewBox="0 0 240 130" aria-hidden="true"><path d="M60 112 Q120 6 190 60" fill="none" stroke="#d6f0fa" stroke-width="10" stroke-linecap="round"/><path class="tut-arc" d="M60 112 Q120 6 190 60" fill="none" stroke="#34beed" stroke-width="4" stroke-dasharray="7 9" stroke-linecap="round"/>
    <g class="tut-swing"><g transform="translate(120 96)"><rect x="-6" y="-46" width="12" height="44" rx="4" fill="#fff" stroke="#4b535b" stroke-width="3"/><circle cx="0" cy="8" r="13" fill="#ffd9b8" stroke="#4b535b" stroke-width="3"/></g></g>${BALL(196, 46, 9, 'tut-pop')}</svg>`,
  read: `<svg viewBox="0 0 240 130" aria-hidden="true"><path d="M8 118 L58 54 H182 L232 118Z" fill="#3f73c2"/><path d="M58 54H182" stroke="#fff" stroke-width="3"/><path d="M8 118 L58 54 H182 L232 118Z" fill="none" stroke="#fff" stroke-width="3"/>
    <ellipse class="tut-ring" cx="150" cy="100" rx="20" ry="7" fill="none" stroke="#fff" stroke-width="3.5"/>
    <path d="M30 40 Q80 4 132 34" fill="none" stroke="url(#tut-heat)" stroke-width="7" stroke-linecap="round" opacity=".9"/>
    <defs><linearGradient id="tut-heat" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity=".2"/><stop offset=".45" stop-color="#ffe14a"/><stop offset=".75" stop-color="#ff9440"/><stop offset="1" stop-color="#ff4b3a"/></linearGradient></defs>
    <g class="tut-swirl"><path d="M120 26 a20 20 0 0 1 28 0" fill="none" stroke="#1a9fd0" stroke-width="3.5" stroke-linecap="round"/><path d="M151 46 a20 20 0 0 1 -28 0" fill="none" stroke="#1a9fd0" stroke-width="3.5" stroke-linecap="round"/></g>${BALL(136, 36, 10)}</svg>`,
  move: `<svg viewBox="0 0 240 130" aria-hidden="true"><rect x="96" y="6" width="48" height="16" rx="5" fill="#4b535b"/><circle cx="120" cy="14" r="4.5" fill="#34beed"/>
    <path d="M120 22 L60 120 M120 22 L180 120" stroke="#a9e0f6" stroke-width="2" stroke-dasharray="4 6"/>
    <g class="tut-step"><circle cx="120" cy="58" r="12" fill="#ffd9b8" stroke="#4b535b" stroke-width="3"/><path d="M120 70v28M104 82h32M120 98l-12 18M120 98l12 18" stroke="#4b535b" stroke-width="4" stroke-linecap="round"/></g>
    <path d="M70 116h-26m0 0 8-6m-8 6 8 6M170 116h26m0 0-8-6m8 6-8 6" stroke="#34beed" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`,
  rules: `<svg viewBox="0 0 240 130" aria-hidden="true"><rect x="42" y="30" width="72" height="62" rx="12" fill="#e3f1ff" stroke="#3aa0ff" stroke-width="3.5"/><text x="78" y="76" text-anchor="middle" font-size="38" font-weight="800" fill="#1670d8" font-family="var(--font)">11</text>
    <rect x="126" y="30" width="72" height="62" rx="12" fill="#fff0e2" stroke="#ff9440" stroke-width="3.5"/><text x="162" y="76" text-anchor="middle" font-size="38" font-weight="800" fill="#e6561a" font-family="var(--font)">9</text>${BALL(120, 104, 9, 'tut-bounce')}</svg>`,
};

// ---- the cards ----
const shot = (name, how, path) => `<li class="tut-shot"><svg viewBox="0 0 48 28" aria-hidden="true"><path d="${path}" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg><b>${name}</b><span>${how}</span></li>`;
const key = (k, what) => `<li><span class="keycap">${k}</span>${what}</li>`;
function cards() {
  const phone = MOBILE();
  const list = [
    { art: ART.pair, title: 'Your phone is the paddle',
      body: phone ? '<p>Open <b>poddleball.com</b> on a computer and press Play. Scan the code it shows with this phone. Nothing to install.</p>'
        : '<p>Press Play and pick a court. Scan the code with your phone’s camera, tap <b>Start</b>, and you’re holding the paddle. Nothing to install.</p>',
      more: 'On a Mac, one AirPod can be the paddle too. Pick AirPod at the top of the set-up screen.' },
    { art: ART.grip, title: 'Grip it, then rip it',
      body: '<p>Hold the phone like a paddle handle: edge up, screen sideways, top pointing at the screen. Keep still a moment while it calibrates, then swing for real.</p>',
      more: 'It has no strap. Hold on tight and check behind you first.' },
    { title: 'Pick your shot', cls: 'is-shots',
      body: '<ul class="tut-shots">'
        + shot('Drive', 'A normal, solid swing', 'M4 20 Q24 10 44 16')
        + shot('Smash', 'Your hardest swing, level or down through it', 'M6 4 L42 24 M34 24h8v-7')
        + shot('Lob', 'Scoop up under it, high and deep', 'M4 24 Q24 -8 44 24')
        + shot('Dink', 'A soft little scoop into the kitchen', 'M6 22 Q16 6 26 22')
        + shot('Slice', 'Roll your wrist or curve the swing', 'M4 18 Q20 22 30 12 T44 8')
        + shot('Block', 'Hold the paddle still in its path at the net', 'M19 3h10v15h-10z M24 18v7')
        + '</ul>',
      more: 'The shot’s name pops up on screen the moment you hit it, so you always know what you played.' },
    { art: ART.read, title: 'Read the ball',
      body: '<ul class="tut-facts"><li><b>The ring</b> on the court shows where the ball will land.</li>'
        + '<li><b>The swirl</b> around a sliced ball turns the way it will kick when it bounces. Spin only bites on that first bounce.</li>'
        + '<li><b>The trail</b> heats up with power: white, yellow, orange, red. Red means smash.</li>'
        + '<li><b>Your phone</b> flashes on every hit, from white for a soft one to red for a smash.</li></ul>' },
    { art: ART.move, title: 'Move your feet',
      body: '<p><b>Body:</b> step side to side in front of your webcam and your player follows. Tip the paddle forward to creep up to the net, back to retreat.</p><p><b>Auto:</b> no camera needed. The game runs you to the ball, and all you do is swing.</p>',
      more: 'Switch between them any time under Settings, Move. The camera only looks for where you stand and nothing is recorded.' },
    { art: ART.rules, title: 'Rules, the Poddle way',
      body: '<ul class="tut-facts"><li>First to <b>11</b>, win by 2. Every rally scores.</li><li><b>Serving:</b> the ball waits for your swing. After 9 seconds it serves for you.</li>'
        + '<li>A rally ends on a double bounce, a ball out, or one that gets past you.</li><li>Volley from anywhere. No kitchen faults here.</li></ul>' },
  ];
  if (!phone) list.push({ title: 'Handy keys', cls: 'is-keys',
    body: '<ul class="tut-keys">' + key('Esc', 'Pause against Matt') + key('B', 'Matt’s level. Hold 2 s to restart') + key('V', 'Change the camera') + key('F', 'Full screen')
      + key('C', 'Calibrate again') + key('R', 'Recenter') + key('1 to 0', 'Emotes') + key('Y / N', 'Answer a watcher who asks to play') + '</ul>',
    more: 'Everything else is in <a href="/how-to-play.html" target="_blank" rel="noopener">How to play</a>.' });
  return list;
}

let el = null, at = 0, list = [], back = null, keyH = null;
function build() {
  el = document.createElement('div'); el.className = 'tut'; el.id = 'tutorial'; el.hidden = true;
  el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-labelledby', 'tut-title');
  el.innerHTML = `<div class="tut-card panel" tabindex="-1"><button class="tut-x" id="tut-skip" aria-label="Close the tutorial"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
    <div class="tut-page" id="tut-page" aria-live="polite"></div>
    <div class="tut-foot"><button class="btn btn-sm tut-back" id="tut-back">Back</button><ol class="tut-dots" id="tut-dots"></ol><button class="btn btn-sm tut-next" id="tut-next">Next</button></div></div>`;
  document.body.append(el);
  el.addEventListener('click', e => { if (e.target === el) close(); });
  el.querySelector('#tut-skip').addEventListener('click', close);
  el.querySelector('#tut-back').addEventListener('click', () => go(at - 1));
  el.querySelector('#tut-next').addEventListener('click', () => (at >= list.length - 1 ? close() : go(at + 1)));
  el.querySelector('#tut-dots').addEventListener('click', e => { const d = e.target.closest('[data-i]'); if (d) go(+d.dataset.i); });
  let x0 = null; el.addEventListener('pointerdown', e => { x0 = e.pointerType === 'touch' ? e.clientX : null; });      // a swipe turns the page on a touch screen
  el.addEventListener('pointerup', e => { if (x0 == null) return; const d = e.clientX - x0; x0 = null; if (Math.abs(d) > 60) go(at + (d < 0 ? 1 : -1)); });
}
function go(i) {
  if (i < 0 || i >= list.length) return; const dir = i > at ? 1 : -1; at = i; const c = list[i];
  const page = el.querySelector('#tut-page');
  page.className = 'tut-page ' + (c.cls || ''); page.style.setProperty('--dir', dir);
  page.innerHTML = (c.art ? `<div class="tut-art">${c.art}</div>` : '') + `<h2 class="tut-title" id="tut-title">${c.title}</h2><div class="tut-body">${c.body}</div>` + (c.more ? `<p class="tut-more">${c.more}</p>` : '');
  page.classList.remove('is-in'); void page.offsetWidth; page.classList.add('is-in');
  el.querySelector('#tut-dots').innerHTML = list.map((_, k) => `<li><button data-i="${k}" aria-label="Card ${k + 1} of ${list.length}"${k === i ? ' aria-current="step"' : ''}></button></li>`).join('');
  el.querySelector('#tut-back').style.visibility = i ? '' : 'hidden';
  const next = el.querySelector('#tut-next'); next.textContent = i === list.length - 1 ? 'Let’s play' : 'Next'; next.classList.toggle('is-last', i === list.length - 1);
}
export const isOpen = () => !!el && !el.hidden;
export function open() {
  if (!el) build(); if (isOpen()) return; markSeen();
  ui.settings(false); back = document.activeElement; list = cards(); at = 0; el.hidden = false; document.body.dataset.tutorial = '';
  go(0); el.querySelector('#tut-next').focus({ preventScroll: true });
  keyH = e => {                                         // while it is up, every key is the tutorial's: the game and the menus never see them
    if (!isOpen()) return; const k = e.key;
    if (k === 'Tab') { const f = [...el.querySelectorAll('button, a[href]')].filter(b => b.offsetParent && b.style.visibility !== 'hidden'), i = f.indexOf(document.activeElement);
      e.preventDefault(); f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length]?.focus(); }
    else if (k === 'Escape') close();
    else if (k === 'ArrowRight') go(at + 1); else if (k === 'ArrowLeft') go(at - 1);
    else if ((k === 'Enter' || k === ' ') && !e.target.closest?.('#tutorial button, #tutorial a')) { e.preventDefault(); el.querySelector('#tut-next').click(); }
    else if (k === 'Enter' || k === ' ') return void e.stopImmediatePropagation();      // the focused button clicks itself
    e.stopImmediatePropagation();
  };
  addEventListener('keydown', keyH, true);
}
export function close() {
  if (!isOpen()) return; el.hidden = true; delete document.body.dataset.tutorial; removeEventListener('keydown', keyH, true); keyH = null;
  if (back && back.isConnected && back.offsetParent) back.focus({ preventScroll: true }); else document.activeElement?.blur?.(); back = null;
}
// main.js calls this when a player lands on the home: the first time ever, the cards come up over it
export function maybe() {
  if (FORCE === '0' || isOpen()) return;
  if (FORCE !== '1') { if (seen()) return; if (returning() || navigator.webdriver) { if (!navigator.webdriver) markSeen(); return; } }
  setTimeout(() => { if (document.body.dataset.screen === 'lobby' || FORCE === '1' || document.querySelector('#screen-lobby.is-active')) open(); }, 450);      // after the home's own entrance
}
document.getElementById('btn-set-tut')?.addEventListener('click', () => open());
