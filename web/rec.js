// A capture of real play for tuning (NOTES 239), only with ?rec=1 in the address. Every paddle sample this tab receives (the phone's,
// relayed by the server, or the AirPod helper's) is kept as {t, q, r, a, at, src} in the same shape test/record.mjs writes, so every
// harness that reads data/*.jsonl replays it unchanged (they keep the lines with q, r and at). Interleaved, lines with `ev`: the swing
// reports this tab sends and what the server says about the ball (state packets cut to the ball and both paddles, hit, launch,
// bounce, whiff, point), so a swing can be lined up against the ball it met. Nothing is sent anywhere: the file is handed to the
// player as a download when they leave the court (or from the console: __rec.save()), and the memory is freed.
const MAX = 400000;                              // ~25 min of 60 Hz samples plus the ball: a forgotten tab cannot eat the memory
const now = () => performance.timeOrigin + performance.now();
const r3 = v => Array.isArray(v) ? v.map(x => Math.round(x * 1000) / 1000) : v;

export function createRec(on, calOf) {
  if (!on) return { sample() {}, sent() {}, got() {}, save() {} };
  let rows = [], kept = 0, started = new Date();
  const put = o => { if (rows.length < MAX) rows.push(JSON.stringify(o)); };
  const rec = {
    sample(s, src) { if (s && Array.isArray(s.q) && Array.isArray(s.r)) put({ t: s.t, q: s.q, r: s.r, a: s.a, at: now(), src }); },
    sent(m) { if (m && m.type === 'swing') put({ ev: 'send', at: now(), m }); },
    got(m, side) {
      if (!m || !m.type) return;
      if (m.type === 'state') { const P = m.paddles || [];
        put({ ev: 'state', at: now(), t: m.t, p: r3(m.p), v: r3(m.v), live: m.live, side, pd: P.map(o => o ? [o.x, o.y, o.z].map(x => Math.round(x * 1000) / 1000) : null) }); return; }
      if (['hit', 'launch', 'bounce', 'whiff', 'point', 'serve', 'swung'].includes(m.type)) put({ ev: m.type, at: now(), side, m });
    },
    save() {
      if (!rows.some(l => l.startsWith('{"t":'))) return false;      // no paddle sample yet: nothing worth a file
      const head = JSON.stringify({ ev: 'meta', at: now(), started: started.toISOString(), ua: navigator.userAgent, cal: calOf() });
      const blob = new Blob([head + '\n' + rows.join('\n') + '\n'], { type: 'application/x-ndjson' });
      const a = document.createElement('a'), stamp = started.toISOString().slice(0, 19).replace(/[:T]/g, '-');
      a.href = URL.createObjectURL(blob); a.download = `poddle-capture-${stamp}-${++kept}.jsonl`; document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      rows = []; started = new Date(); return true;
    },
  };
  window.__rec = rec;
  return rec;
}
