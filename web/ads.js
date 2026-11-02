// The banner on the home menu (NOTES 280). One fixed-size display banner, nothing else: no video, no pop-up, no Auto ads, and only ever
// on the lobby's home view. Off a court by construction: the slot leaves the page on the way to any other view, and pad.html never imports this.
// Dormant until the server has ADSENSE_CLIENT and ADSENSE_SLOT (/ads.json answers 404 without them): no slot, no space, no request to Google.
// Each visit to the home gets a fresh <ins>, removed on leaving: AdSense forbids hidden units and timed refresh. A return inside MIN_GAP shows
// nothing rather than asking for another ad. Blocked or unfilled, the slot closes and the menu takes the space back.
// Turn off? (owner, 2026-11-02): beside the banner, opens a small card that says why the ads are there and offers to turn them off. poddle.adsOff keeps the choice on this
// browser; while it is set nothing is mounted and nothing is requested from Google. Settings > Screen > Ads puts them back.
// ?adtest=1 draws a grey box of the same size and contacts nobody, for layouts (test/ads.mjs).
const LOADER = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js';
const MIN_GAP = 60e3, MIN_H = 560;                                         // a window under MIN_H keeps its menu
const TEST = new URLSearchParams(location.search).has('adtest');
const OFF_KEY = 'poddle.adsOff';
const isOff = () => { try { return localStorage.getItem(OFF_KEY) === '1'; } catch { return false; } };
function setOff(off) { try { if (off) localStorage.setItem(OFF_KEY, '1'); else localStorage.removeItem(OFF_KEY); } catch { /* this visit only */ } mem = off; drawSwitch(); if (off) close(); else { shownAt = -1e9; sync(); } }
let mem = null;                                                            // private mode: the choice still holds for this visit
const off = () => mem ?? isOff();
const drawSwitch = () => { const t = document.getElementById('tog-ads'); if (t) { t.hidden = false; t.setAttribute('aria-checked', String(!off())); } };
let cfg = TEST ? { test: true } : null, box = null, shownAt = -1e9, loaded = false, dead = false, fills = null;

const atHome = () => { const s = document.getElementById('screen-lobby'); return !!s && s.classList.contains('is-active') && s.dataset.view === 'home' && !document.body.dataset.overlay; };
const close = () => { fills?.disconnect(); fills = null; box?.remove(); box = null; };

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

function open() {
  if (off() || innerHeight < MIN_H || dead || performance.now() - shownAt < MIN_GAP) return;
  const lobby = document.getElementById('screen-lobby'), [w, h] = innerWidth >= 768 ? [728, 90] : [320, 50];
  box = document.createElement('aside'); box.className = 'ad-home'; box.setAttribute('aria-label', 'Advertisement'); box.style.setProperty('--ad-w', `${w}px`); box.style.setProperty('--ad-h', `${h}px`);
  const unit = document.createElement('div'); unit.className = 'ad-unit'; box.append(unit);
  const btn = document.createElement('button'); btn.className = 'ad-toggle'; btn.textContent = 'Turn off?'; btn.onclick = () => ask(btn); box.append(btn);
  lobby.querySelector(':scope > .menu-body').after(box); shownAt = performance.now();
  if (cfg.test) { unit.classList.add('is-test'); return; }
  const ins = document.createElement('ins'); ins.className = 'adsbygoogle'; ins.style.cssText = `display:inline-block;width:${w}px;height:${h}px`;
  ins.dataset.adClient = cfg.client; ins.dataset.adSlot = cfg.slot; if (location.hostname === 'localhost') ins.dataset.adtest = 'on';
  unit.append(ins);
  fills = new MutationObserver(() => { if (ins.dataset.adStatus === 'unfilled') close(); }); fills.observe(ins, { attributes: true, attributeFilter: ['data-ad-status'] });
  (window.adsbygoogle = window.adsbygoogle || []).push({}); loader();
}

function sync() { if (!cfg) return; const home = atHome(); if (home && !box) open(); else if (!home && box) close(); }

function start() {
  const lobby = document.getElementById('screen-lobby'); if (!lobby) return;
  drawSwitch(); document.getElementById('tog-ads')?.addEventListener('click', () => setOff(!off()));
  new MutationObserver(sync).observe(lobby, { attributes: true, attributeFilter: ['class', 'data-view'] });
  new MutationObserver(sync).observe(document.body, { attributes: true, attributeFilter: ['data-overlay'] });
  sync();
}
if (TEST) start();
else fetch('/ads.json').then(r => (r.ok ? r.json() : null)).then(c => { if (c?.client && c.slot) { cfg = c; start(); } }).catch(() => {});
