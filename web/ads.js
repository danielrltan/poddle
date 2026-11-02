// The banners on the home menu (NOTES 280, 281). Fixed-size display banners, nothing else: one under the menu and, where the window has the room, one in each side margin.
// No video, no pop-up, no Auto ads, and only ever
// on the lobby's home view. Off a court by construction: the slot leaves the page on the way to any other view, and pad.html never imports this.
// Dormant until the server has ADSENSE_CLIENT and ADSENSE_SLOT (/ads.json answers 404 without them): no slot, no space, no request to Google.
// Each visit to the home gets a fresh <ins>, removed on leaving: AdSense forbids hidden units and timed refresh. A return inside MIN_GAP shows
// nothing rather than asking for another ad. Blocked or unfilled, a slot closes; Turn off? stays while any ad is up, and with none left the menu takes the space back.
// Turn off? (owner, 2026-11-02): beside the banner, opens a small card that says why the ads are there and offers to turn them off. poddle.adsOff keeps the choice on this
// browser; while it is set nothing is mounted and nothing is requested from Google. Settings > Screen > Ads puts them back.
// ?adtest=1 draws a grey box of the same size and contacts nobody, for layouts (test/ads.mjs).
const LOADER = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js';
const MIN_GAP = 60e3, MIN_H = 560, SIDE_H = 600, SIDE_PAD = 16;                                         // a window under MIN_H keeps its menu
const TEST = new URLSearchParams(location.search).has('adtest');
const OFF_KEY = 'poddle.adsOff';
const isOff = () => { try { return localStorage.getItem(OFF_KEY) === '1'; } catch { return false; } };
function setOff(off) { try { if (off) localStorage.setItem(OFF_KEY, '1'); else localStorage.removeItem(OFF_KEY); } catch { /* this visit only */ } mem = off; drawSwitch(); if (off) close(); else { shownAt = -1e9; sync(); } }
let mem = null;                                                            // private mode: the choice still holds for this visit
const off = () => mem ?? isOff();
const drawSwitch = () => { const t = document.getElementById('tog-ads'); if (t) { t.hidden = false; t.setAttribute('aria-checked', String(!off())); } };
let cfg = TEST ? { test: true } : null, box = null, sides = [], shownAt = -1e9, loaded = false, dead = false, watch = [];

const atHome = () => { const s = document.getElementById('screen-lobby'); return !!s && s.classList.contains('is-active') && s.dataset.view === 'home' && !document.body.dataset.overlay; };
const close = () => { for (const w of watch) w.disconnect(); watch = []; for (const e of sides) e.remove(); sides = []; box?.remove(); box = null; };

function loader() {
  if (loaded) return; loaded = true;
  const go = () => { const s = document.createElement('script'); s.async = true; s.crossOrigin = 'anonymous'; s.src = `${LOADER}?client=${cfg.client}`; s.onerror = () => { dead = true; close(); }; document.head.append(s); };
  (window.requestIdleCallback || setTimeout)(go, { timeout: 2000 });        // never in the way of the menu's first frames
}

function ask(btn) {
  if (box.querySelector('.ad-ask')) return;
  const card = document.createElement('div'); card.className = 'panel ad-ask'; card.setAttribute('role', 'dialog'); card.setAttribute('aria-label', 'Turn off ads');
  card.innerHTML = '<p>We run ads strictly to break even on the cost of running Poddle, like its servers. If you would rather not see them, you can turn them off.</p><p class="ad-ask-btns"><button class="btn btn-sm" data-off>Turn off ads</button><button class="btn btn-sm" data-keep>Keep ads</button></p>';
  const shut = () => { card.remove(); btn.focus(); };
  card.querySelector('[data-off]').onclick = () => setOff(true); card.querySelector('[data-keep]').onclick = shut;
  card.onkeydown = e => { if (e.key === 'Escape') { e.stopPropagation(); shut(); } };
  box.append(card); card.querySelector('[data-keep]').focus();
}

// one ad unit into `into`: a grey box under ?adtest=1. Unfilled, it goes on its own; the last one to go takes Turn off? with it
function fill(unit, w, h) {
  if (cfg.test) { unit.classList.add('is-test'); return; }
  const ins = document.createElement('ins'); ins.className = 'adsbygoogle'; ins.style.cssText = `display:inline-block;width:${w}px;height:${h}px`;
  ins.dataset.adClient = cfg.client; ins.dataset.adSlot = cfg.slot; if (location.hostname === 'localhost') ins.dataset.adtest = 'on';
  unit.append(ins);
  const m = new MutationObserver(() => { if (ins.dataset.adStatus !== 'unfilled') return; unit.remove(); sides = sides.filter(e => e !== unit); if (box && !sides.length && !box.querySelector('.ad-unit')) close(); });
  m.observe(ins, { attributes: true, attributeFilter: ['data-ad-status'] }); watch.push(m);
  (window.adsbygoogle = window.adsbygoogle || []).push({}); loader();
}

// where a side ad goes: in the margin beside the tiles, between the header and the footer or the Product Hunt badge. Measured, null when it does not fit
function sideSpot() {
  const lobby = document.getElementById('screen-lobby'), tiles = lobby.querySelector('#lobby-home .tiles')?.getBoundingClientRect();
  if (!tiles?.width) return null;
  const top = lobby.querySelector('.menu-head').getBoundingClientRect().bottom + SIDE_PAD, badge = lobby.querySelector('.ph-badge')?.getBoundingClientRect();
  const floor = Math.min(box.getBoundingClientRect().top < top ? innerHeight : lobby.querySelector('.menu-foot').getBoundingClientRect().top, badge?.width ? badge.top : Infinity) - SIDE_PAD;
  const room = tiles.left, w = room >= 160 + 2 * SIDE_PAD ? 160 : room >= 120 + 2 * SIDE_PAD ? 120 : 0;
  if (!w || floor - top < SIDE_H) return null;
  return { w, x: Math.round((room - w) / 2), y: Math.round(top + (floor - top - SIDE_H) / 2) };
}
function openSides() {
  if (!box) return; const at = sideSpot(); if (!at) return;
  for (const side of ['left', 'right']) { const u = document.createElement('aside'); u.className = 'ad-unit ad-side'; u.setAttribute('aria-label', 'Advertisement'); u.dataset.w = at.w; u.style.cssText = `--ad-w:${at.w}px;--ad-h:${SIDE_H}px;top:${at.y}px;${side}:${at.x}px`; document.getElementById('screen-lobby').append(u); sides.push(u); fill(u, at.w, SIDE_H); }
}
function resized() {                                                       // a narrower window loses the side ads rather than letting them touch the menu
  if (box && innerWidth < parseInt(box.style.getPropertyValue('--ad-w')) + 16) { close(); return; }      // a unit never changes size once it has an ad
  if (!sides.length) return; const at = sideSpot();
  if (!at || at.w !== +sides[0].dataset.w) { for (const e of sides) e.remove(); sides = []; return; }
  for (const e of sides) { e.style.top = `${at.y}px`; e.style[e.style.left ? 'left' : 'right'] = `${at.x}px`; }
}

function open() {
  if (off() || innerHeight < MIN_H || dead || performance.now() - shownAt < MIN_GAP) return;
  const lobby = document.getElementById('screen-lobby'), [w, h] = innerWidth >= 768 ? [728, 90] : [320, 50];
  box = document.createElement('aside'); box.className = 'ad-home'; box.setAttribute('aria-label', 'Advertisement'); box.style.setProperty('--ad-w', `${w}px`); box.style.setProperty('--ad-h', `${h}px`);
  const unit = document.createElement('div'); unit.className = 'ad-unit'; box.append(unit);
  const btn = document.createElement('button'); btn.className = 'ad-toggle'; btn.textContent = 'Turn off?'; btn.onclick = () => ask(btn); box.append(btn);
  lobby.querySelector(':scope > .menu-body').after(box); shownAt = performance.now();
  fill(unit, w, h);
  requestAnimationFrame(() => requestAnimationFrame(openSides));           // measured after the bottom band has taken its space
}

function sync() { if (!cfg) return; const home = atHome(); if (home && !box) open(); else if (!home && box) close(); }

function start() {
  const lobby = document.getElementById('screen-lobby'); if (!lobby) return;
  drawSwitch(); document.getElementById('tog-ads')?.addEventListener('click', () => setOff(!off()));
  addEventListener('resize', resized);
  new MutationObserver(sync).observe(lobby, { attributes: true, attributeFilter: ['class', 'data-view'] });
  new MutationObserver(sync).observe(document.body, { attributes: true, attributeFilter: ['data-overlay'] });
  sync();
}
if (TEST) start();
else fetch('/ads.json').then(r => (r.ok ? r.json() : null)).then(c => { if (c?.client && c.slot) { cfg = c; start(); } }).catch(() => {});
