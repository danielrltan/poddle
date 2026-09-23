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
  // ---------- Tournaments (docs/COURTS-TOURNEY.md 4.6): the same three gates on every new screen ----------
  const TOUR_SEL = '#lobby-tour button, #tour-card button, #tour-pill, #btn-tour-go, #lobby-bracket button, #champ-acts button, #tour-res button, #tour-ended button';
  for (const scr of ['tourney-courts', 'tourney-host-3', 'tourney-guest', 'tourney-warmfull', 'tourney-banner', 'tourney-banner-host', 'tourney-card', 'tourney-intro', 'tourney-bracket', 'tourney-bracket&n=16&you=watching', 'tourney-win', 'tourney-out', 'tourney-champion', 'tourney-ended', 'tourney-match', 'tourney-match-settings']) for (const [w, h] of [[1280, 720], [600, 900], [390, 844]]) {      // (g) 44 x 44 targets, at a short landscape window too
    p = await open('screen=' + scr + '&freeze=1', false, w, h);
    const small = await p.evaluate(sel => [...document.querySelectorAll(sel)].filter(e => { const r = e.getBoundingClientRect(); return r.width && getComputedStyle(e).visibility !== 'hidden' && (r.width < 43.5 || r.height < 43.5); }).map(e => `${e.id || e.className.split(' ').pop()} ${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`), TOUR_SEL);
    check(!small.length, `${w}x${h} ${scr}: every tournament control is 44 x 44 or more${small.length ? ': ' + small.join(', ') : ''}`); await p.close();
    p = await open('screen=' + scr + '&freeze=1', false, w, h);      // (h) the 12 px floor on a phone-width window (keycaps are exempt, the small caps have an 11 px floor)
    if (w < 1000) { const tiny = await p.evaluate(() => [...document.querySelectorAll('#lobby-tour *, #tour-card *, #tour-pill *, #btn-tour-go, #lobby-bracket *, #screen-tour-vs *, #result-road *, #tour-res *, #champ-acts *, #tour-ended *, .notices *, #rematch-count *, .badge-tour, #result .tally-side b')].filter(e => { const r = e.getBoundingClientRect(), c = getComputedStyle(e), fs = parseFloat(c.fontSize); return r.width && c.visibility !== 'hidden' && +c.opacity > 0.05 && [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) && !(e.closest('.keycap, .vh') || e.closest('.caps') && fs >= 10.95) && fs < 11.95; }).map(e => `${e.id || e.className || e.tagName} "${e.textContent.trim().slice(0, 16)}" ${parseFloat(getComputedStyle(e).fontSize).toFixed(1)}px`));
    check(!tiny.length, `${w}x${h} ${scr}: no tournament text under 12 px (small caps 11)${tiny.length ? ': ' + tiny.join(', ') : ''}`); } await p.close();
  }
  for (const [scr, sels] of [['tourney-host-3', ['.tour-join', '.tour-join small', '.tour-why', '.tour-chip-name', '.tour-tag', '.tour-copied', '.tour-rules', '.tour-n small']], ['tourney-host-ready', ['.tour-why.is-ready', '#tour-start-label']], ['tourney-warmfull', ['.tour-full']],
    ['tourney-bracket', ['.br-you', '.br-name', '.br-round', '.br-round small', '.br-live span', '.br-tag', '.br-p.is-me .br-name']], ['tourney-bracket&you=out&next=1', ['.br-next', '.br-p.is-lose .br-name']], ['tourney-bracket&n=16&you=watching', ['.br-left', '.br-you']], ['tourney-banner', ['.tp-long', '.tp-sub b', '.notice.is-tour span']],
    ['tourney-card', ['.tc-code b', '.tc-code small', '.tc-n']], ['tourney-intro', ['.vs-round', '.vs-target', '#vs-them']], ['tourney-champion', ['#result-title', '.road-step small', '.road-step span', '#result-note']], ['tourney-ended', ['#tour-ended-text']]]) {      // (i) contrast, as (e)
    p = await open('screen=' + scr + '&freeze=1');
    const cs = await p.evaluate(ss => ss.map(sel => { const e = document.querySelector(sel); if (!e) return { sel, miss: true }; const fg = getComputedStyle(e).color; let n = e, bgs = [];
      while (n && n !== document.documentElement) { const c = getComputedStyle(n), img = c.backgroundImage, col = c.backgroundColor;
        if (img && img !== 'none' && /gradient/.test(img)) { bgs = img.match(/rgba?\([^)]+\)/g) || []; if (bgs.length) break; }
        if (col && !/rgba\(0, 0, 0, 0\)|transparent/.test(col)) { bgs = [col]; break; } n = n.parentElement; }
      return { sel, fg, bgs: bgs.length ? bgs : ['rgb(255, 255, 255)'] }; }), sels);
    for (const c of cs) { if (c.miss) { check(false, `${c.sel} is on ${scr}`); continue; }
      const over = s => { const v = rgb(s), a = v.length > 3 ? v[3] : 1; return v.slice(0, 3).map(x => x * a + 255 * (1 - a)); }, worst = Math.min(...c.bgs.map(bg => ratio(over(c.fg), over(bg))));
      check(worst >= 4.5, `${scr} contrast ${c.sel}: ${worst.toFixed(2)}:1`); }
    await p.close();
  }
  for (const reduce of [true, false]) {      // (j) the count pops on a join, and not under reduced motion; focus lands on Copy invite. No freeze: it would end the pop before it is looked at
    p = await open('screen=tourney-host-3', reduce);
    const pop = await p.evaluate(async () => { await new Promise(r => setTimeout(r, 400)); const f = document.activeElement?.id, ui = window.__ui, snap = { type: 'tour', code: 'K24M', phase: 'reg', n: 4, max: 16, host: 'Daniel', win: 7, final: 11, you: { id: 1, host: true, warm: 'off' }, players: ['Daniel', 'Kim', 'Ben', 'Sam'].map((name, i) => ({ id: i + 1, name, host: !i, on: true })), rounds: [] };
      ui.setTour(snap, { link: 'https://poddleball.com/?court=K24M' }); const b = document.getElementById('tour-n-num'), an = b.getAnimations(), start = document.getElementById('btn-tour-start');
      return { f, n: b.textContent, anim: an.map(x => x.animationName).join(), dur: an[0] ? an[0].effect.getTiming().duration : null, start: !start.disabled, label: start.textContent.trim(), fresh: document.querySelectorAll('#tour-names .tour-chip.is-new').length }; });
    const motion = reduce ? pop.dur == null || pop.dur <= 1 : pop.anim === 'num-pop' && pop.dur === 450;
    check(pop.f === 'btn-tour-copy' && pop.n === '4' && pop.start && /Start with 4 players/.test(pop.label) && pop.fresh === 1 && motion, `a join${reduce ? ' (reduced motion)' : ''}: focus ${pop.f}, count ${pop.n}, Start on "${pop.label}", one new chip, ${reduce ? 'no motion' : 'the pop'} (${pop.anim || 'none'} ${pop.dur} ms)`); await p.close(); }
  for (const [w, h] of [[1440, 900], [1280, 720]]) {      // (k) the first focus on the 16-player bracket is fully in view: inside the scroller, not under a sticky round header
    for (const you of ['through', 'watching']) { p = await open(`screen=tourney-bracket&n=16&you=${you}&freeze=1`, false, w, h); await sleep(500);
      const f = await p.evaluate(() => { const a = document.activeElement, r = a.getBoundingClientRect(), b = document.getElementById('bracket').getBoundingClientRect(), hit = [...document.querySelectorAll('.br-round')].filter(x => x.offsetParent).some(x => { const q = x.getBoundingClientRect(); return r.left < q.right && r.right > q.left && r.top < q.bottom && r.bottom > q.top; });
        const y = document.querySelector('.br-col.is-current .br-match.is-you'), yr = y && y.getBoundingClientRect(), yhit = !!yr && [...document.querySelectorAll('.br-round')].filter(x => x.offsetParent).some(x => { const q = x.getBoundingClientRect(); return yr.left < q.right && yr.right > q.left && yr.top < q.bottom && yr.bottom > q.top; });
        return { id: a.className || a.id, t: Math.round(r.top), bt: Math.round(r.bottom), b0: Math.round(b.top), b1: Math.round(b.bottom), inside: r.top >= b.top - .5 && r.bottom <= b.bottom + .5, hit, onYou: !!y && y.contains(a), yClear: !!yr && yr.top >= b.top - .5 && yr.bottom <= b.bottom + .5 && !yhit }; });
      check(f.inside && !f.hit, `${w}x${h} bracket n=16 you=${you}: first focus (${f.id}) y ${f.t}-${f.bt} inside the scroller ${f.b0}-${f.b1}, clear of the round headers`);
      if (you === 'through') check(f.onYou && f.yClear, `${w}x${h} bracket n=16 you=through: first focus is your own card (${f.onYou}), in view and clear of the round headers (${f.yClear})`);
      const g = await p.evaluate(async () => { const out = []; for (let i = 0; i < 3; i++) { document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); await new Promise(r => setTimeout(r, 50)); const a = document.activeElement.getBoundingClientRect(), b = document.getElementById('bracket').getBoundingClientRect(); out.push(a.top >= b.top - .5 && a.bottom <= b.bottom + .5); } return out; });
      check(g.every(Boolean), `${w}x${h} bracket n=16 you=${you}: the arrows keep the focused Watch in view (${g.join()})`); await p.close(); } }
  for (const [w, h] of [[600, 900], [390, 844]]) {      // (l) a narrow warm-up still says what the count is for
    p = await open('screen=tourney-banner&freeze=1', false, w, h);
    const t = await p.evaluate(() => { const pl = document.getElementById('tour-pill'); return [...pl.querySelectorAll('.tp-text > *')].filter(e => e.offsetParent && getComputedStyle(e).display !== 'none').map(e => e.textContent.trim()).join(' / '); });
    check(/Waiting/.test(t) && /joined/.test(t), `${w}x${h} the warm-up pill reads "${t}"`); await p.close(); }
  p = await open('screen=tourney-card&freeze=1');                   // (m) Esc and T close the card, and focus goes back to the pill
  for (const key of ['Escape', 't']) { const k = await p.evaluate(async key => { const ui = window.__ui; if (!ui.tourCard()) ui.tourCard(true); await new Promise(r => setTimeout(r, 50)); document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); await new Promise(r => setTimeout(r, 50)); return { open: ui.tourCard(), f: document.activeElement.id }; }, key);
    check(!k.open && k.f === 'tour-pill', `${key} on the card: closed (${k.open}), focus on ${k.f}`); }
  await p.close();
  for (const [why, re] of [['restart', /^The tournament ended: the server restarted$/], ['empty', /^The tournament ended: everyone left$/]]) {      // (n) the ended notice's words
    p = await open(`screen=tourney-ended&why=${why}&freeze=1`); const t = await p.evaluate(() => document.getElementById('tour-ended-text').textContent);
    check(re.test(t), `tourney-ended why=${why}: "${t}"`); await p.close(); }
  for (const you of ['watching', 'through']) {      // (o) the bracket's leave button: a viewer stops watching, a player leaves; both press twice
    p = await open(`screen=tourney-bracket&n=16&you=${you}&freeze=1`); const l = await p.evaluate(async () => { const b = document.getElementById('btn-br-leave'), t0 = b.textContent.trim(); b.click(); await new Promise(r => setTimeout(r, 50)); return [t0, b.textContent.trim()]; });
    const want = you === 'watching' ? ['Stop watching', 'Press again to stop watching'] : ['Leave tournament', 'Press again to leave'];
    check(l[0] === want[0] && l[1] === want[1], `bracket you=${you}: leave reads "${l[0]}", then "${l[1]}"`); await p.close(); }
} finally { await browser.close(); srv.close(); }
if (fails) { console.log(`verify: ${fails} FAIL`); process.exitCode = 1; } else console.log('verify: the Courts / Ask to play / Tournament checks pass');
