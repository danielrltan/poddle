import http from 'http'; import fs from 'fs'; import path from 'path'; import puppeteer from 'puppeteer-core';
const root = new URL('../..', import.meta.url).pathname, PORT = +process.env.UI_PORT || 8245;
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.woff2': 'font/woff2' };
const srv = http.createServer((q, r) => { const f = path.join(root, decodeURIComponent(new URL(q.url, 'http://x').pathname)); fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); r.end(d); }); }).listen(PORT, '127.0.0.1');
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const open = async (q, reduce, w = 1440, h = 900) => { const p = await browser.newPage(); await p.setViewport({ width: w, height: h }); if (reduce) await p.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]); await p.goto(`http://127.0.0.1:${PORT}/test/ui-mock.html?${q}`); await p.waitForFunction(() => document.title.startsWith('ready')); await p.evaluate(() => document.fonts.ready); return p; };
let fails = 0; const check = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++; };      // the Courts / Ask to play block gates: a FAIL exits non-zero
try {
  let p = await open('screen=hud'); await sleep(600);
  console.log('running animations on hud:', await p.evaluate(() => document.getAnimations().map(a => (a.animationName || a.transitionProperty) + '@' + (a.effect.target.id || a.effect.target.className)).join(', ') || 'none'));
  console.log('backdrop-filter users:', await p.evaluate(() => [...document.querySelectorAll('*')].filter(e => { const c = getComputedStyle(e); return (c.backdropFilter && c.backdropFilter !== 'none'); }).length));
  console.log('monospace users:', await p.evaluate(() => [...document.querySelectorAll('body *')].filter(e => /mono|courier|menlo|consolas/i.test(getComputedStyle(e).fontFamily)).length));
  const tl = await p.evaluate(async () => { const out = [], c = document.getElementById('callout'); window.__ui.callout('drive'); const t0 = performance.now();
    while (performance.now() - t0 < 1400) { await new Promise(r => requestAnimationFrame(r)); const s = getComputedStyle(c), m = new DOMMatrix(s.transform); out.push([Math.round(performance.now() - t0), +(+s.opacity).toFixed(2), +Math.hypot(m.a, m.b).toFixed(3)]); } return out; });
  const at = ms => tl.reduce((b, x) => Math.abs(x[0] - ms) < Math.abs(b[0] - ms) ? x : b);
  console.log('callout [ms, opacity, scale]:', [100, 180, 250, 300, 400, 600, 900, 1000, 1100, 1200, 1300].map(at).map(x => x.join('/')).join('  '));
  console.log('callout text + rect:', await p.evaluate(() => { window.__ui.callout('smash'); const r = document.getElementById('callout').getBoundingClientRect(); return document.getElementById('callout').textContent + ' y ' + Math.round(r.top) + '-' + Math.round(r.bottom); }));
  console.log('unknown kind ->', await p.evaluate(() => { window.__ui.callout('around_the_post'); return document.getElementById('callout').textContent; }), '| empty kind keeps:', await p.evaluate(() => { window.__ui.callout(undefined); return document.getElementById('callout').textContent; }));
  await sleep(1500); console.log('callout .go removed after end:', await p.evaluate(() => !document.getElementById('callout').classList.contains('go')));
  console.log('score pop "10" inside tab:', await p.evaluate(async () => { window.__ui.setScore(10, 5); const n = document.getElementById('sc-me'), tab = n.closest('.score-tab'); let worst = 0; const t0 = performance.now();
    while (performance.now() - t0 < 500) { await new Promise(r => requestAnimationFrame(r)); const a = n.getBoundingClientRect(), b = tab.getBoundingClientRect(); worst = Math.max(worst, b.top - a.top, a.bottom - b.bottom); } return 'max overflow px = ' + worst.toFixed(1); }));
  console.log('keys idle now:', await p.evaluate(() => document.getElementById('keys').classList.contains('is-idle')));
  await sleep(5200); console.log('keys idle after ~7.5 s:', await p.evaluate(() => document.getElementById('keys').classList.contains('is-idle') + ' opacity ' + getComputedStyle(document.getElementById('keys')).opacity));
  await p.keyboard.press('KeyH'); console.log('keys after keydown:', await p.evaluate(() => document.getElementById('keys').classList.contains('is-idle')));
  await p.screenshot({ path: root + 'test/ui-shots/hud-idle-1440x900.png' });
  await p.close();
  p = await open('screen=match-win'); await p.evaluate(() => window.__ui.toast('Recentred', 5000)); await sleep(500);
  console.log('toast over veil: z', await p.evaluate(() => getComputedStyle(document.getElementById('toast')).zIndex + ' vs screen ' + getComputedStyle(document.getElementById('screen-match')).zIndex)); await p.close();
  p = await open('screen=title', true); await sleep(300);
  console.log('reduced motion: start button glow opacity =', await p.evaluate(() => getComputedStyle(document.getElementById('btn-start'), '::after').opacity)); await p.close();
  p = await open('screen=calibrate-error'); await sleep(200);
  console.log('second error replays nudge:', await p.evaluate(async () => { const c = document.getElementById('calcard'); let n = 0; c.addEventListener('animationstart', e => { if (e.animationName === 'nudge') n++; });
    window.__ui.calibration({ stage: 'hold', progress: .1, ok: true, msg: 'x' }); await new Promise(r => setTimeout(r, 1500)); window.__ui.calibration({ stage: 'hold', progress: 0, ok: false, msg: 'You moved — hold still and we’ll start again.' });
    await new Promise(r => setTimeout(r, 100)); const head1 = document.getElementById('calh').textContent; window.__ui.calibration({ stage: 'hold', progress: .02, ok: true, msg: 'x' }); const latched = document.getElementById('calh').textContent;
    window.__ui.calibration({ stage: 'tilt', progress: 0, ok: false, msg: 'That was a twist — level out, then tip it straight up.' }); await new Promise(r => setTimeout(r, 100)); return `nudges=${n} headline="${head1}" latched="${latched}" then="${document.getElementById('calh').textContent}"`; })); await p.close();
  // ---------- Courts and Ask to play (docs/COURTS-TOURNEY.md 2.11) ----------
  for (const [w, h] of [[1440, 900], [600, 900]]) {                 // (a) the list box keeps one height in every state
    const hs = []; for (const s of ['lobby-courts', 'lobby-courts-loading', 'lobby-courts-empty', 'lobby-courts-empty-full', 'lobby-courts-nomatch', 'lobby-courts-down']) { p = await open('screen=' + s + '&freeze=1', false, w, h); hs.push(await p.evaluate(() => Math.round(document.querySelector('.court-wrap').getBoundingClientRect().height))); await p.close(); }
    check(hs.every(x => x === hs[0]), `${w}x${h} the court list box is one height in rows, loading, empty (Open and Full), no match and down: ${hs.join(', ')}`);
  }
  p = await open('screen=hud', true);                               // (b) the card never takes focus nor a key; (c) Y / N only while it shows, and the bar reaches 0 at 'left' (reduced motion too)
  const b = await p.evaluate(async () => { const ui = window.__ui, before = document.activeElement; ui.askCard({ name: 'Sam', left: 2 });
    const keys = ['Space', 'Enter', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].map(code => { const e = new KeyboardEvent('keydown', { key: code === 'Space' ? ' ' : code, code, bubbles: true, cancelable: true }); (document.activeElement || document.body).dispatchEvent(e); return e.defaultPrevented ? code : null; }).filter(Boolean);
    const out = { focus: document.activeElement === before, prevented: keys, showing: ui.askShowing(), tab: [...document.querySelectorAll('#ask-card button')].every(x => x.tabIndex === -1) };
    await new Promise(r => setTimeout(r, 2300)); out.bar = +getComputedStyle(document.querySelector('#ask-card .ask-bar')).getPropertyValue('--p');
    ui.askCard(null); await new Promise(r => setTimeout(r, 50)); out.after = ui.askShowing(); ui.askCard({ name: 'Sam', left: 5 }); ui.showScreen('lobby'); out.menu = ui.askShowing(); return out; });
  check(b.focus && !b.prevented.length && b.tab, `the ask card takes no focus, swallows no key (${b.prevented.join() || 'none'} prevented), its buttons are off the Tab order`);
  check(b.showing && !b.after && !b.menu, `Y / N count only while the card shows (showing ${b.showing}, hidden ${b.after}, under a menu ${b.menu})`);
  check(b.bar === 0, `reduced motion: the bar is at 0 when 'left' runs out (--p ${b.bar})`); await p.close();
  for (const [w, h] of [[1440, 900], [600, 900], [390, 844]]) {    // (d) the spectator's button: one width through every label, nothing cut off, at every size
  p = await open('screen=watch-ask', false, w, h);
  const d = await p.evaluate(() => { const ui = window.__ui, bt = document.getElementById('btn-ask'), l = document.getElementById('ask-label'), out = [];
    const look = () => out.push({ t: l.textContent, w: Math.round(bt.getBoundingClientRect().width), cut: l.scrollWidth > l.clientWidth + 1 });
    look(); for (const m of [{ s: 'sent', left: 10 }, { s: 'no', left: 10 }, { s: 'expired', left: 10 }, { s: 'wait', left: 10, busy: true }, { s: 'wait', left: 10 }, { s: 'gone', left: 0 }]) { ui.askPlay(m); look(); } return out; });
  check(d.every(x => x.w === d[0].w) && !d.some(x => x.cut), `${w}x${h} #btn-ask keeps ${d[0].w}px and cuts nothing: ${d.map(x => `${x.t}${x.cut ? ' (CUT)' : ''} ${x.w}`).join(' | ')}`);
  check(d.at(-1).t === 'Ask again', `${w}x${h} after a request ends the idle label is Ask again ("${d.at(-1).t}")`); await p.close(); }
  p = await open('screen=hud-ask&freeze=1', false, 1280, 720);      // (d2) a short landscape window: the card sits up over the trees, above the far baseline (y 293 of 720 in the frozen mock), clear of the corner and the scoreboard
  const cr = await p.evaluate(() => { const r = document.getElementById('ask-card').getBoundingClientRect(), b = id => document.getElementById(id).getBoundingClientRect(), hit = (a, q) => a.left < q.right && a.right > q.left && a.top < q.bottom && a.bottom > q.top; return { top: Math.round(r.top), bottom: Math.round(r.bottom), right: Math.round(r.right), limit: Math.round(innerHeight * 0.4), board: hit(r, b('board')), corner: hit(r, b('corner')) }; });
  check(cr.bottom <= cr.limit && !cr.board && !cr.corner, `1280x720 the ask card is off the court (y ${cr.top}-${cr.bottom}, above ${cr.limit}), clear of the scoreboard and the corner`); await p.close();
  const rgb = c => (c.match(/[\d.]+/g) || []).map(Number), lum = ([r, g, b]) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  for (const [scr, sels] of [['lobby-courts&tour=1', ['.seg-n', '.court-meta', '.badge-tour', '.tour-note', '.court[data-kind="ask"] .court-go', '.court-go']], ['hud-ask', ['.ask-q small', '.ask-q']]]) {      // (e) contrast: text against every colour its background is painted with (gradients: each stop; see-through: over white)
    p = await open('screen=' + scr + '&freeze=1');
    const cs = await p.evaluate(ss => ss.map(sel => { const e = document.querySelector(sel); if (!e) return { sel, miss: true }; const fg = getComputedStyle(e).color; let n = e, bgs = [];
      while (n && n !== document.documentElement) { const c = getComputedStyle(n), img = c.backgroundImage, col = c.backgroundColor;
        if (img && img !== 'none' && /gradient/.test(img)) { bgs = img.match(/rgba?\([^)]+\)/g) || []; if (bgs.length) break; }
        if (col && !/rgba\(0, 0, 0, 0\)|transparent/.test(col)) { bgs = [col]; break; } n = n.parentElement; }
      return { sel, fg, bgs: bgs.length ? bgs : ['rgb(255, 255, 255)'] }; }), sels);
    for (const c of cs) { if (c.miss) { check(false, `${c.sel} is on ${scr}`); continue; }
      const over = s => { const v = rgb(s), a = v.length > 3 ? v[3] : 1; return v.slice(0, 3).map(x => x * a + 255 * (1 - a)); }, worst = Math.min(...c.bgs.map(bg => ratio(over(c.fg), over(bg))));
      check(worst >= 4.5, `contrast ${c.sel}: ${worst.toFixed(2)}:1`); }
    await p.close();
  }
  for (const scr of ['lobby-courts', 'hud-ask', 'watch-ask']) {      // (e) every control on Courts, the card and the button is at least 44 x 44 px at 600 x 900
    p = await open('screen=' + scr + '&freeze=1', false, 600, 900);
    const small = await p.evaluate(() => [...document.querySelectorAll('.courts button, .courts input, .courts .code-box, #ask-card button, #btn-ask')].filter(e => { const r = e.getBoundingClientRect(); return r.width && getComputedStyle(e).visibility !== 'hidden' && (r.width < 43.5 || r.height < 43.5); }).map(e => `${e.id || e.className.split(' ').pop()} ${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`));
    check(!small.length, `600x900 ${scr}: every control is 44 x 44 or more${small.length ? ': ' + small.join(', ') : ''}`); await p.close();
  }
  for (const [w, h] of [[600, 900], [390, 844]]) for (const scr of ['lobby', 'lobby-courts', 'lobby-courts-err', 'hud-ask', 'watch-ask']) {      // (f) the 12 px floor on Courts, the card, the button and the Courts tile (keycaps and the small caps are 11 px by design; .vh is read out, never seen)
    p = await open('screen=' + scr + '&freeze=1', false, w, h);
    const tiny = await p.evaluate(() => [...document.querySelectorAll('.courts *, #ask-card *, #btn-ask *, .tile-sub')].filter(e => { const r = e.getBoundingClientRect(), c = getComputedStyle(e); return r.width && c.visibility !== 'hidden' && [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) && !e.closest('.keycap, .caps, .vh') && parseFloat(c.fontSize) < 11.95; }).map(e => `${e.id || e.className || e.tagName} "${e.textContent.trim().slice(0, 16)}" ${parseFloat(getComputedStyle(e).fontSize).toFixed(1)}px`));
    check(!tiny.length, `${w}x${h} ${scr}: no text under 12 px${tiny.length ? ': ' + tiny.join(', ') : ''}`); await p.close();
  }
} finally { await browser.close(); srv.close(); }
if (fails) { console.log(`verify: ${fails} FAIL`); process.exitCode = 1; } else console.log('verify: the Courts / Ask to play checks pass');
