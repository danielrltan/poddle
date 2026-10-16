// Court sounds before/after (NOTES 259): renders the OLD oscillator voices (copied from scene.js before the change) and the NEW buffer
// voices (web/courtsfx.js through scene.js play()'s chain: distance gain + lowpass, pan; dry since NOTES 263) in Chrome's OfflineAudioContext, through
// the same master (gain 0.7 -> DynamicsCompressor) the game uses, to WAV files to listen to, and prints peak / RMS per file.
//   node test/sfx-ab.mjs        Env: SFX_AB_OUT=<dir> (default test/sfx-ab/), SFX_AB_PORT=8761 (a static server over web/)
// Last line: SFX AB PASS (every file rendered, no clipping: peak < 1.0 after the compressor) or SFX AB FAIL.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import puppeteer from 'puppeteer-core';
const root = new URL('..', import.meta.url).pathname, WEB = root + 'web/', OUT = process.env.SFX_AB_OUT || root + 'test/sfx-ab/', PORT = +process.env.SFX_AB_PORT || 8761;
const CHROME = process.env.CHROME || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => fs.existsSync(p));
fs.mkdirSync(OUT, { recursive: true });
const srv = http.createServer((q, r) => { const f = path.join(WEB, decodeURIComponent(q.url.split('?')[0])); if (q.url === '/') { r.setHeader('content-type', 'text/html'); r.end('<!doctype html><title>sfx</title>'); return; }
  if (!f.startsWith(WEB) || !fs.existsSync(f)) { r.statusCode = 404; r.end(); return; } r.setHeader('content-type', f.endsWith('.js') ? 'text/javascript' : 'application/octet-stream'); r.end(fs.readFileSync(f)); }).listen(PORT);
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage(); page.on('pageerror', e => console.log('PAGE ERROR', e.message));
await page.goto(`http://127.0.0.1:${PORT}/`);
const res = await page.evaluate(async () => {
  const m = await import('/courtsfx.js'), SR = 48000;
  // the scene: [time s, kind, args]. near = 3 m from the camera (my own hits), far = 15 m (the other end)
  const SCENES = {
    'swing-mine-medium': [[0.05, 'whoosh', { mine: true, n: 0.65, d: 2.5 }]],
    'swing-mine-hard': [[0.05, 'whoosh', { mine: true, n: 1, d: 2.5 }]],
    'swing-theirs': [[0.05, 'whoosh', { mine: false, n: 0.65, d: 15 }]],
    'swing-variety': [0.05, 0.55, 1.05, 1.55, 2.05].map((t, i) => [t, 'whoosh', { mine: true, n: [0.65, 1, 0.3, 0.65, 1][i], d: 2.5 }]),
    'hit-dink': [[0.05, 'pock', { n: 0, d: 3 }]],
    'hit-drive': [[0.05, 'pock', { n: 0.5, d: 3 }]],
    'hit-smash': [[0.05, 'pock', { n: 1, d: 3 }]],
    'hit-theirs-drive': [[0.05, 'pock', { n: 0.5, d: 15 }]],
    'bounce-near': [[0.05, 'bounce', { h: 0.8, d: 4 }]],
    'bounce-far': [[0.05, 'bounce', { h: 0.6, d: 13 }]],
    // a short rally: my swing + drive, its bounce at the far end, their swing + hit, the bounce on my side, a plant, my smash
    'rally': [[0.1, 'whoosh', { mine: true, n: 0.6, d: 2.5 }], [0.16, 'pock', { n: 0.55, d: 3 }], [0.85, 'bounce', { h: 0.7, d: 11 }], [1.2, 'whoosh', { mine: false, n: 0.65, d: 15 }],
      [1.32, 'pock', { n: 0.45, d: 15 }], [1.95, 'bounce', { h: 0.7, d: 5 }], [2.35, 'whoosh', { mine: true, n: 1, d: 2.5 }], [2.42, 'pock', { n: 1, d: 3 }], [3.0, 'bounce', { h: 1, d: 12 }]],
  };
  const LEN = { rally: 3.6, 'swing-variety': 2.6 };
  async function render(name, evs, which) {
    const ac = new OfflineAudioContext(2, Math.round(SR * (LEN[name] || 0.8)), SR), master = ac.createGain(); master.gain.value = 0.7;
    const comp = ac.createDynamicsCompressor(); master.connect(comp); comp.connect(ac.destination);
    const noiseBuf = ac.createBuffer(1, SR, SR); { const d = noiseBuf.getChannelData(0), r = m.rng(5); for (let i = 0; i < d.length; i++) d[i] = r() * 2 - 1; }
    const rnd = m.rng(99), out = pan => { const p = ac.createStereoPanner(); p.pan.value = pan; p.connect(master); return p; };
    // ---- OLD (scene.js before NOTES 259, verbatim apart from the start time) ----
    let T0 = 0;
    function tone(dst, type, f0, f1, tGlide, gain, decay, at = 0) { const t = T0 + at, o = ac.createOscillator(), g = ac.createGain();
      o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + tGlide);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + 0.002); g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
      o.connect(g); g.connect(dst); o.start(t); o.stop(t + decay + 0.02); }
    function noise(dst, f0, f1, f2, Q, gain, dur, attack, at = 0) { const t = T0 + at, src = ac.createBufferSource(), bp = ac.createBiquadFilter(), g = ac.createGain();
      src.buffer = noiseBuf; src.loop = true; bp.type = 'bandpass'; bp.Q.value = Q;
      bp.frequency.setValueAtTime(f0, t); bp.frequency.exponentialRampToValueAtTime(f1, t + dur * 0.45); bp.frequency.exponentialRampToValueAtTime(f2, t + dur);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(bp); bp.connect(g); g.connect(dst); src.start(t, rnd() * 0.5); src.stop(t + dur + 0.02); }
    const OLD = {
      pock(n) { const d = out(0), f = 880 + 520 * n, g = 0.6 + 0.7 * n; tone(d, 'sine', 170 + 60 * n, 70, 0.004, 0.35 + 0.5 * n, 0.16);
        tone(d, 'sine', f * 1.6, f, 0.018, g, 0.085); tone(d, 'triangle', f * 0.5, f * 0.46, 0.05, g * 0.5, 0.13); noise(d, 3200, 2400, 1800, 0.8, g * 0.5, 0.03, 0.001); },
      bounce() { const d = out(0); tone(d, 'sine', 760, 560, 0.03, 0.16, 0.07); tone(d, 'triangle', 300, 250, 0.05, 0.1, 0.1); noise(d, 1500, 1100, 800, 0.7, 0.05, 0.03, 0.001); },
      whoosh(g, mine) { noise(out(0), 420, 2100, 650, 1.3, g, mine ? 0.22 : 0.3, mine ? 0.025 : 0.09); },
    };
    // ---- NEW: scene.js play() ----
    const bank = {}; for (const [k, f] of m.bankJobs(SR)) { const d = f(), b = ac.createBuffer(1, d.length, SR); b.getChannelData(0).set(d); (bank[k] ||= []).push(b); }
    const near = (v, ks) => ks.reduce((a, k) => (Math.abs(k - v) < Math.abs(a - v) ? k : a));
    function play(k, gain, dist, { rate = 1, offset = 0 } = {}) { const list = bank[k], buf = list[(rnd() * list.length) | 0], src = ac.createBufferSource(), lp = ac.createBiquadFilter(), g = ac.createGain();
      const far = Math.max(0, dist - 3), att = 1 / (1 + far / 6); src.buffer = buf; src.playbackRate.value = rate * (0.97 + 0.06 * rnd());
      lp.type = 'lowpass'; lp.frequency.value = 16000 / (1 + far / 3.5); lp.Q.value = 0.5; g.gain.value = gain * att;
      src.connect(lp); lp.connect(g); g.connect(out(0));      // dry: no room on the court (NOTES 263)
      src.start(T0, Math.min(offset, buf.duration * 0.9)); }
    const NEW = {
      pock(n, d) { play('pock' + near(n, [0, 0.25, 0.5, 0.75, 1]), 1 + 1.1 * n, d); },
      bounce(h, d) { play(h < 0.6 ? 'bounce0.35' : 'bounce0.9', 0.3 + 0.32 * h, d); },
      whoosh(g, mine, n, d) { const k = 'whoosh' + near(n, [0.3, 0.65, 1]); play(k, g * (0.5 + 0.7 * n), d, { offset: mine ? bank[k][0].duration * 0.3 : 0 }); },
    };
    for (const [t, kind, a] of evs) { T0 = t;
      if (which === 'old') { if (kind === 'pock') OLD.pock(a.n); else if (kind === 'bounce') OLD.bounce(); else if (kind === 'whoosh') OLD.whoosh(a.mine ? 0.22 : 0.12, a.mine); }
      else { if (kind === 'pock') NEW.pock(a.n, a.d); else if (kind === 'bounce') NEW.bounce(a.h, a.d); else NEW.whoosh(a.mine ? 0.22 : 0.12, a.mine, a.n, a.d); } }
    const b = await ac.startRendering(); return [Array.from(b.getChannelData(0)), Array.from(b.getChannelData(1))];
  }
  const outp = {};
  for (const [name, evs] of Object.entries(SCENES)) for (const which of ['old', 'new']) { outp[which + '-' + name] = await render(name, evs, which); }
  return outp;
});
await browser.close(); srv.close();
function wav(file, [L, R]) {
  const n = L.length, b = Buffer.alloc(44 + n * 4); b.write('RIFF', 0); b.writeUInt32LE(36 + n * 4, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22);
  b.writeUInt32LE(48000, 24); b.writeUInt32LE(48000 * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) { b.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(L[i] * 32767))), 44 + i * 4); b.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(R[i] * 32767))), 46 + i * 4); }
  fs.writeFileSync(file, b);
}
let bad = 0; const db = x => (x > 0 ? (20 * Math.log10(x)).toFixed(1) : '-inf');
for (const [k, ch] of Object.entries(res).sort()) {
  let pk = 0, ss = 0, n = 0, cen = 0, tot = 0; for (const d of ch) for (const x of d) { pk = Math.max(pk, Math.abs(x)); ss += x * x; n++; }
  // spectral centroid of the loudest 2048 samples (a quick brightness number)
  const d = ch[0]; let at = 0, best = 0; for (let i = 0; i + 2048 < d.length; i += 256) { let e = 0; for (let j = 0; j < 2048; j++) e += d[i + j] ** 2; if (e > best) { best = e; at = i; } }
  for (let f = 100; f < 12000; f *= 1.06) { let re = 0, im = 0; for (let j = 0; j < 2048; j++) { const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * j / 2047), x = d[at + j] * w; re += x * Math.cos(2 * Math.PI * f * j / 48000); im -= x * Math.sin(2 * Math.PI * f * j / 48000); } const mag = Math.hypot(re, im); cen += f * mag; tot += mag; }
  wav(OUT + k + '.wav', ch); if (pk >= 1) bad++;
  console.log(`${k.padEnd(24)} peak ${db(pk).padStart(6)} dBFS  rms ${db(Math.sqrt(ss / n)).padStart(6)} dBFS  centroid ${(cen / tot | 0).toString().padStart(5)} Hz`);
}
console.log('wrote', OUT); console.log(bad ? 'SFX AB FAIL' : 'SFX AB PASS');
