// Menu sounds and menu music (NOTES 181). The game's own sounds stay in scene.js; this is the console-menu layer on top:
// soft glassy plinks on hover, a bright two-note rise on select, the same falling on Back, blips for switches and steppers,
// all through a small airy reverb. Every voice is synthesised (no samples). The music is one looping track
// ("Into the Blue" by Gwamm Music, credited in the title footer and the Terms), played on the title and the lobby only.
//
// Levels are 0..10 (Settings > Sound > Music, Menu sounds). The Sound switch mutes both. The AudioContext is scene.js's
// (getAc), so the output device chosen in Settings applies here too.
const SRC = new URL('audio/into-the-blue.mp3', import.meta.url).href;      // beside this file, wherever web/ is served from
function silent() {                                                      // 0.1 s of 8-bit silence, as a WAV: what the first gesture plays to bless the element
  const n = 800, b = new Uint8Array(44 + n).fill(128), v = new DataView(b.buffer), w = (o, t) => { for (let i = 0; i < 4; i++) b[o + i] = t.charCodeAt(i); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true); w(36, 'data'); v.setUint32(40, n, true);
  return URL.createObjectURL(new Blob([b], { type: 'audio/wav' }));
}
const UI_MAX = 1.5, MUSIC_MAX = 0.6;      // at the defaults (6, 5) a select peaks near -19 dBFS over music peaking near -16: high bells cut through
const curve = v => Math.pow(Math.max(0, Math.min(10, v)) / 10, 1.7);      // equal steps sound equal: the top half is not all the same loud
const PENTA = [0, 2, 4, 7, 9];                                           // the stepper climbs a major pentatonic: never a sour step

export function menuAudio(getAc) {
  let ac = null, bus = null, mbus = null, muted = false, uiVol = 6, musVol = 5;
  let el = null, loading = false, ready = false, want = false, playing = false, stopT = 0, hoverAt = 0;
  function init() {
    if (bus) return true;
    ac = getAc(); if (!ac) return false;
    try {
      bus = ac.createGain(); bus.gain.value = muted ? 0 : UI_MAX * curve(uiVol);
      const verb = ac.createConvolver(), wet = ac.createGain(), len = Math.round(ac.sampleRate * 0.7), ir = ac.createBuffer(2, len, ac.sampleRate);
      for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); let s = 1234 + c * 77; for (let i = 0; i < len; i++) { s = (s * 16807) % 2147483647; d[i] = ((s / 2147483647) * 2 - 1) * Math.pow(1 - i / len, 3.2); } }
      verb.buffer = ir; wet.gain.value = 0.28;
      bus.connect(ac.destination); bus.connect(verb); verb.connect(wet); wet.connect(ac.destination);
      mbus = ac.createGain(); mbus.gain.value = 0; mbus.connect(ac.destination);
    } catch { bus = null; return false; }
    return true;
  }
  // a bell: the note, a soft octave over it, and a short glassy partial that gives the attack its "plink"
  function bell(f, at, dur, g, glide = 1) {
    const t = ac.currentTime + at;
    for (const [mul, gg, d, type] of [[1, g, dur, 'sine'], [2, g * 0.22, dur * 0.6, 'sine'], [3.01, g * 0.14, 0.035, 'triangle']]) {
      const o = ac.createOscillator(), v = ac.createGain();
      o.type = type; o.frequency.setValueAtTime(f * mul * glide, t); o.frequency.exponentialRampToValueAtTime(f * mul, t + 0.025);
      v.gain.setValueAtTime(0.0001, t); v.gain.exponentialRampToValueAtTime(gg, t + 0.004); v.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(v); v.connect(bus); o.start(t); o.stop(t + d + 0.03);
    }
  }
  const VOICES = {
    hover: () => bell(2093, 0, 0.07, 0.07, 0.94),                                 // C7, a breath of a plink
    select: () => { bell(1318.5, 0, 0.16, 0.16, 0.97); bell(1975.5, 0.065, 0.32, 0.17, 0.97); },      // E6 -> B6
    back: () => { bell(1567.98, 0, 0.14, 0.12, 1.03); bell(1046.5, 0.065, 0.26, 0.12, 1.03); },      // G6 -> C6
    on: () => { bell(1046.5, 0, 0.09, 0.13, 0.8); bell(1567.98, 0.045, 0.2, 0.13); },
    off: () => { bell(1567.98, 0, 0.09, 0.11, 1.15); bell(1046.5, 0.045, 0.18, 0.1); },
    pick: () => bell(1760, 0, 0.18, 0.14, 0.92),
    open: () => [1046.5, 1318.5, 1567.98, 2093].forEach((f, i) => bell(f, i * 0.035, 0.22, 0.08)),
    close: () => [1567.98, 1318.5, 1046.5].forEach((f, i) => bell(f, i * 0.035, 0.18, 0.07)),
    nope: () => { bell(370, 0, 0.09, 0.12); bell(370, 0.1, 0.12, 0.1); },
  };
  function play(kind, n) {
    if (muted || uiVol <= 0 || !init()) return;
    if (kind === 'hover') { const t = performance.now(); if (t - hoverAt < 45) return; hoverAt = t; }      // a sweep across a row of tiles is a patter, not a buzz
    if (kind === 'step') { const i = Math.max(0, Math.min(10, n | 0)), f = 880 * Math.pow(2, (PENTA[i % 5] + 12 * Math.floor(i / 5)) / 12); bell(f, 0, 0.16, 0.14); return; }
    VOICES[kind]?.();
  }

  // ---------- music ----------
  // The element is blessed in the first gesture (a silent clip played inside it), so iOS lets the real track start later, after
  // the fetch. The track is fetched whole into a blob: the static server has no byte ranges, and Safari will not stream without them.
  function prime() {
    if (el) return;
    try { el = new Audio(); el.loop = true; el.preload = 'auto'; el.src = silent(); const p = el.play(); if (p) p.then(() => el.pause(), () => { }); } catch { el = null; }
    apply();
  }
  function load() {
    if (loading || !el || !init()) return; loading = true;
    fetch(SRC).then(r => r.ok ? r.blob() : Promise.reject(r.status)).then(b => {
      el.pause(); el.src = URL.createObjectURL(b);
      ac.createMediaElementSource(el).connect(mbus); ready = true; apply();
    }).catch(() => { loading = false; });
  }
  function apply() {
    const on = want && !muted && musVol > 0 && !document.hidden;
    if (on && !ready) { load(); return; }
    if (!ready) return;
    const g = mbus.gain, now = ac.currentTime; g.cancelScheduledValues(now); g.setValueAtTime(g.value, now);
    clearTimeout(stopT);
    if (on) { if (!playing) { playing = true; el.play().catch(() => { playing = false; }); } g.linearRampToValueAtTime(MUSIC_MAX * curve(musVol), now + (g.value < 0.01 ? 1.6 : 0.25)); }
    else if (playing) { g.linearRampToValueAtTime(0, now + 0.6); stopT = setTimeout(() => { el.pause(); playing = false; }, 700); }      // paused, not stopped: back to the menu, the song carries on
  }
  addEventListener('visibilitychange', apply);

  return {
    play, prime,      // prime: main.js unlock(), inside the first gesture
    music(on) { want = !!on; apply(); },      // main.js: true on the title and the lobby, false everywhere else
    setMute(on) { muted = !!on; if (bus) bus.gain.value = muted ? 0 : UI_MAX * curve(uiVol); apply(); },
    setUi(v) { uiVol = v; if (bus && !muted) bus.gain.setTargetAtTime(UI_MAX * curve(v), ac.currentTime, 0.01); },
    setMusic(v) { musVol = v; apply(); },
    state: () => ({ ready, playing, want, t: el && ready ? el.currentTime : 0, gain: mbus ? mbus.gain.value : 0 }),      // tests
  };
}

// Hover and click sounds for every control in the menus and the cards. Hover: a mouse entering a new control, or the keyboard
// moving focus (never a focus() the code gives on its own, never a touch). The court's own HUD stays quiet, except the cards.
const SEL = 'button, a[href], [role="switch"], [role="radio"], select, input:not([type="hidden"]), summary';
const SCOPE = '.screen, .settings, [role="dialog"], .acct-layer';
export function wireMenuSounds(sfx) {
  let last = null, keyNav = false;
  const ctl = t => { const c = t?.closest?.(SEL); return c && c.closest(SCOPE) && !c.closest('[data-quiet]') ? c : null; };
  addEventListener('keydown', e => { if (e.key === 'Tab' || e.key.startsWith('Arrow')) keyNav = true; }, true);
  addEventListener('pointerdown', () => { keyNav = false; }, true);
  addEventListener('pointerover', e => {
    if (e.pointerType !== 'mouse') return; const c = ctl(e.target);
    if (c === last) return; last = c; if (c && !c.disabled && c.tagName !== 'INPUT') sfx('hover');
  }, true);
  addEventListener('focusin', e => { if (!keyNav) return; const c = ctl(e.target); if (c && c !== last) { last = c; sfx('hover'); } }, true);
  addEventListener('click', e => {
    const c = ctl(e.target); if (!c || c.matches('input, select, [data-sfx="none"]')) return;
    if (c.disabled || c.getAttribute('aria-disabled') === 'true') return sfx('nope');
    const k = c.dataset.sfx;
    if (k) return sfx(k);
    if (c.matches('[data-back], .btn-back, .fc-back, [aria-label^="Back"], [aria-label="Close"]')) return sfx('back');
    if (c.getAttribute('role') === 'switch') return sfx(c.getAttribute('aria-checked') === 'true' ? 'off' : 'on');      // before the click flips it
    if (c.getAttribute('role') === 'radio') return sfx('pick');
    sfx('select');
  }, true);
}
