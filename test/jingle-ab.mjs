// Result jingles before/after (NOTES 262): renders the OLD dry jingles (scene.js's inline voices, verbatim apart from the start time) and the
// NEW ones (web/courtsfx.js jingleScore through the same tone()/noise(), into the jingle bus + its hall send) in Chrome's OfflineAudioContext,
// through the game's master (gain 0.7 -> DynamicsCompressor), to WAV files, and prints peak / RMS / the tail's length per file.
//   node test/jingle-ab.mjs        Env: SFX_AB_OUT=<dir> (default test/sfx-ab/), JINGLE_AB_PORT=8763
// Last line: JINGLE AB PASS (every file rendered, no clipping, each new one rings at least as long as its old one) or JINGLE AB FAIL.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import puppeteer from 'puppeteer-core';
const root = new URL('..', import.meta.url).pathname, WEB = root + 'web/', OUT = process.env.SFX_AB_OUT || root + 'test/sfx-ab/', PORT = +process.env.JINGLE_AB_PORT || 8763;
const CHROME = process.env.CHROME || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => fs.existsSync(p));
fs.mkdirSync(OUT, { recursive: true });
const srv = http.createServer((q, r) => { const f = path.join(WEB, decodeURIComponent(q.url.split('?')[0]));
  if (q.url === '/') { r.setHeader('content-type', 'text/html'); r.end('<!doctype html><title>jingle ab</title>'); return; }
  if (!f.startsWith(WEB) || !fs.existsSync(f)) { r.statusCode = 404; r.end(); return; } r.setHeader('content-type', 'text/javascript'); r.end(fs.readFileSync(f)); }).listen(PORT);
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });
const page = await browser.newPage(); page.on('pageerror', e => console.log('PAGE ERROR', e.message));
await page.goto(`http://127.0.0.1:${PORT}/`);
const res = await page.evaluate(async () => {
  const m = await import('/courtsfx.js'), SR = 48000, LEN = 3.4, out = {};
  for (const kind of ['win', 'lose', 'watch', 'forfeit', 'champ']) for (const which of ['old', 'new']) {
    const ac = new OfflineAudioContext(2, Math.round(SR * LEN), SR), master = ac.createGain(); master.gain.value = 0.7;
    const comp = ac.createDynamicsCompressor(); master.connect(comp); comp.connect(ac.destination);
    const noiseBuf = ac.createBuffer(1, SR, SR); { const d = noiseBuf.getChannelData(0), r = m.rng(5); for (let i = 0; i < d.length; i++) d[i] = r() * 2 - 1; }
    const rr = m.rng(42), rnd = () => rr(), T0 = 0.05;
    function tone(dst, type, f0, f1, tGlide, gain, decay, at = 0) { const t = T0 + at, o = ac.createOscillator(), g = ac.createGain();
      o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + tGlide);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + 0.002); g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
      o.connect(g); g.connect(dst); o.start(t); o.stop(t + decay + 0.02); }
    function noise(dst, f0, f1, f2, Q, gain, dur, attack, at = 0) { const t = T0 + at, src = ac.createBufferSource(), bp = ac.createBiquadFilter(), g = ac.createGain();
      src.buffer = noiseBuf; src.loop = true; bp.type = 'bandpass'; bp.Q.value = Q;
      bp.frequency.setValueAtTime(f0, t); bp.frequency.exponentialRampToValueAtTime(f1, t + dur * 0.45); bp.frequency.exponentialRampToValueAtTime(f2, t + dur);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(bp); bp.connect(g); g.connect(dst); src.start(t, rnd() * 0.5); src.stop(t + dur + 0.02); }
    const d = ac.createGain(); d.connect(master);
    if (which === 'old') {      // scene.js sfx.jingle before NOTES 262, verbatim
      const n = (f, at, dur, g, type = 'triangle') => { tone(d, type, f, f, 0.01, g, dur, at); tone(d, 'sine', 2 * f, 2 * f, 0.01, g * 0.25, dur * 0.6, at); };
      const pickup = g => { n(392, 0.14, 0.16, g); n(523.25, 0.23, 0.16, g); n(659.25, 0.32, 0.16, g); };
      if (kind === 'forfeit') { pickup(0.12); n(783.99, 0.44, 0.16, 0.12); }
      else if (kind === 'lose') { tone(d, 'sine', 130.81, 130.81, 0.01, 0.10, 1.6, 0.44); n(440, 0.44, 0.4, 0.12); n(392, 0.60, 0.4, 0.12);
        for (const f of [329.63, 392, 523.25]) tone(d, 'sine', f, f, 0.02, 0.10, 1.3, 0.80); }
      else { tone(d, 'sine', 120, 50, 0.12, 0.4, 0.3, 0.11); noise(d, 7000, 5200, 3800, 0.6, 0.12, 0.7, 0.002, 0.11);
        pickup(0.16); n(783.99, 0.44, 0.6, 0.2); tone(d, 'square', 783.99, 783.99, 0.01, 0.06, 0.5, 0.44);
        for (const f of [523.25, 659.25, 783.99, 1046.5]) n(f, 0.62, 1.0, 0.12);
        if (kind === 'champ') { [[1318.5, 0.95], [1568, 1.02], [2093, 1.09]].forEach(([f, at]) => tone(d, 'sine', f, f, 0.01, 0.08, 0.5, at)); noise(d, 7000, 5200, 3800, 0.6, 0.10, 0.7, 0.002, 0.95); } }
    } else {                    // scene.js now: the score into the bus, the bus into the hall at 0.45
      const h = m.hall(SR), ir = ac.createBuffer(2, h[0].length, SR); ir.getChannelData(0).set(h[0]); ir.getChannelData(1).set(h[1]);
      const hv = ac.createConvolver(), hin = ac.createGain(); hv.buffer = ir; hin.gain.value = 0.45; d.connect(hin); hin.connect(hv); hv.connect(master);
      for (const e of m.jingleScore(kind)) if (e[0] === 't') tone(d, e[1], e[2], e[3], e[4], e[5], e[6], e[7]); else noise(d, e[1], e[2], e[3], e[4], e[5], e[6], e[7], e[8]);
    }
    const b = await ac.startRendering(); out[which + '-' + kind] = [Array.from(b.getChannelData(0)), Array.from(b.getChannelData(1))];
  }
  return out;
});
await browser.close(); srv.close();
function wav(file, [L, R]) {
  const n = L.length, b = Buffer.alloc(44 + n * 4); b.write('RIFF', 0); b.writeUInt32LE(36 + n * 4, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22);
  b.writeUInt32LE(48000, 24); b.writeUInt32LE(48000 * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) { b.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(L[i] * 32767))), 44 + i * 4); b.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(R[i] * 32767))), 46 + i * 4); }
  fs.writeFileSync(file, b);
}
let bad = 0; const db = x => (x > 0 ? (20 * Math.log10(x)).toFixed(1) : '-inf'), tails = {};
for (const [k, ch] of Object.entries(res).sort()) {
  let pk = 0, ss = 0, n = 0; for (const d of ch) for (const x of d) { pk = Math.max(pk, Math.abs(x)); ss += x * x; n++; }
  let last = 0; const L = ch[0]; for (let i = 0; i < L.length; i++) if (Math.abs(L[i]) > pk * 0.01) last = i;      // the tail: the last sample above -40 dB of the peak
  tails[k] = last / 48000; wav(OUT + k + '.wav', ch); if (pk >= 1) { bad++; console.log('CLIP', k); }
  console.log(`${k.padEnd(14)} peak ${db(pk).padStart(6)} dBFS  rms ${db(Math.sqrt(ss / n)).padStart(6)} dBFS  rings to ${tails[k].toFixed(2)} s`);
}
for (const k of ['win', 'lose', 'watch', 'forfeit', 'champ']) if (tails['new-' + k] < tails['old-' + k]) { bad++; console.log(`FAIL ${k}: the new one ends sooner than the old`); }
console.log('wrote', OUT); console.log(bad ? 'JINGLE AB FAIL' : 'JINGLE AB PASS');
