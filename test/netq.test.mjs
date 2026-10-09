// The 60 -> 30 Hz state downgrade must judge the LINK, not the page's main thread (web/netq.js, NOTES 236).
// A modelled page (a 60 Hz display, each frame's own work, long frames / GC stalls, one task at a time, the frame either before or after
// the queued messages once a stall ends) receives a modelled 60 Hz server's state packets over a modelled link (a good one, or the TCP
// over lossy wifi of test/badwifi.mjs: in order, a lost packet holds up everything behind it, then the backlog lands in a burst), and the
// 2 s judge runs on the page's own timer. The old judge (handler gaps, as web/main.js had it) is the reference. Must hold:
//   good link + a janky page    the old judge drops to 30 Hz (the test can tell them apart), the new one never does
//   bad link + a clean page     the new judge decides exactly as the old one, window by window, and drops to 30 Hz
//   bad link + a janky page     the new one still drops to 30 Hz
//   a hidden tab (no frames)    exactly the old decisions, good link or bad
//   good link, clean page       exactly the old decisions (never a drop)
// Usage: node test/netq.test.mjs
import { linkJudge } from '../web/netq.js';

let seed = 1; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const SECS = 120, STEP = 0.25, FRAME = 1000 / 60, DT = 1 / 60, OWD = 15, FLOOR = 2 * OWD;

function oldJudge() {                     // web/main.js before NOTES 236: gaps between the handlers, nothing else
  let last = 0, gaps = 0, late = 0, worst = 0, hz = 60, bad = 0, good = 0;
  return { get hz() { return hz; }, frame() {}, idle() { last = 0; },
    packet(now) { const g = now - last; last = now; if (g > 1000) return; gaps++; if (g > worst) worst = g; if (g > 1000 / hz + 45) late++; },
    judge(online, floor) { const ls = gaps ? late / gaps : 0, poor = online && gaps > 10 && (ls > 0.04 || worst > 250 || floor > 140);
      if (poor) { bad++; good = 0; } else { good++; bad = 0; } let ask = null;
      if (bad >= 2 && hz === 60) ask = hz = 30; if (good >= 8 && hz === 30) ask = hz = 60;
      const o = { poor, worst, lateShare: ls, hz, ask }; gaps = late = worst = 0; return o; } };
}

// link: { loss, stallMin, stallMax, jitter } (badwifi.mjs's model). jank: { every: [min, max] ms between stalls, len: [min, max] ms } or null.
// order: 'frame' = once a stall ends the frame runs before the queued messages, 'msg' = after them. work: ms each frame takes. hidden: no frames
function run({ link, jank, order = 'frame', work = 5, hidden = false, s = 7 }, J) {
  seed = s;
  const jk = []; if (jank) for (let t = 500 + rnd() * jank.every[1]; t < SECS * 1000; t += jank.every[0] + rnd() * (jank.every[1] - jank.every[0])) { const L = jank.len[0] + rnd() * (jank.len[1] - jank.len[0]); jk.push([t, t + L]); t += L; }
  // the server: one packet a tick (every other one at 30 Hz, from when the ask reaches it), made on its 60 Hz clock with a little tick jitter
  const pk = []; let prevA = 0, hzAt = [];   // hzAt: [local ms the server switched, every]
  const every = at => { let e = 1; for (const [t, ev] of hzAt) if (t <= at) e = ev; return e; };
  const sendFrom = k => { const made = 1000 * k * DT + rnd() * 2; let a = made + OWD + rnd() * link.jitter; if (rnd() < link.loss) a += link.stallMin + rnd() * (link.stallMax - link.stallMin); a = Math.max(a, prevA); prevA = a; return { t: k * DT, made, at: a }; };
  let k = 0, ji = 0, qi = 0, busyUntil = 0, vsync = FRAME, frameDue = false, lastFrame = false, nextJudge = 2000;
  const decisions = [];
  const queue = [];
  for (let tau = 0; tau < SECS * 1000; tau += STEP) {
    while (1000 * k * DT <= tau) { if (k % every(1000 * k * DT) === 0) pk.push(sendFrom(k)); k++; }
    while (qi < pk.length && pk[qi].at <= tau) queue.push(pk[qi++]);
    while (ji < jk.length && jk[ji][0] <= tau) { busyUntil = Math.max(busyUntil, jk[ji][1]); ji++; }
    if (!hidden && tau >= vsync) { frameDue = true; while (vsync <= tau) vsync += FRAME; }
    if (tau < busyUntil) continue;
    if (tau >= nextJudge) { nextJudge += 2000; const d = J.judge(true, FLOOR); decisions.push(d); if (d.ask) hzAt.push([tau + OWD, d.ask === 30 ? 2 : 1]); busyUntil = tau + 0.1; continue; }
    const doFrame = frameDue && (!queue.length || order === 'frame' && !lastFrame);      // tasks run between frames: never two frames in a row while messages wait
    if (doFrame) { J.frame(tau); frameDue = false; lastFrame = true; busyUntil = tau + work; continue; }
    if (queue.length) { const p = queue.shift(); J.packet(tau, p.t, hidden); lastFrame = false; busyUntil = tau + 0.2; }
  }
  return { decisions, jank: jk };
}
const sum = r => { const d = r.decisions, firstDrop = d.findIndex(x => x.ask === 30), at30 = d.filter(x => x.hz === 30).length;
  return { poor: d.filter(x => x.poor).length, n: d.length, firstDrop: firstDrop < 0 ? null : (firstDrop + 1) * 2, at30s: at30 * 2, drops: d.filter(x => x.ask === 30).length, worstP50: med(d.map(x => x.worst)) }; };
const med = a => { const b = a.filter(Number.isFinite).sort((x, y) => x - y); return b.length ? Math.round(b[b.length >> 1]) : 0; };
const same = (a, b) => a.decisions.length === b.decisions.length && a.decisions.every((x, i) => x.poor === b.decisions[i].poor && x.hz === b.decisions[i].hz && x.ask === b.decisions[i].ask);

const GOOD = { loss: 0, stallMin: 0, stallMax: 0, jitter: 5 }, HOME = { loss: 0.01, stallMin: 60, stallMax: 150, jitter: 20 }, BAD = { loss: 0.04, stallMin: 100, stallMax: 350, jitter: 60 };
const JANK = { every: [1200, 2600], len: [150, 400] }, GC = { every: [300, 900], len: [55, 110] };
let fails = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
const line = (name, o, n) => console.log(`  ${name.padEnd(54)} old: ${fmt(sum(o))}\n  ${''.padEnd(54)} new: ${fmt(sum(n))}`);
const fmt = s => `poor ${String(s.poor).padStart(3)}/${s.n} windows, 30 Hz for ${String(s.at30s).padStart(3)} s, first drop ${s.firstDrop == null ? '  -' : String(s.firstDrop).padStart(3) + ' s'}, worst gap p50 ${s.worstP50} ms`;
const both = cfg => [run(cfg, oldJudge()), run(cfg, linkJudge())];

console.log(`${SECS} s per case, server 60 Hz, one-way ${OWD} ms; the judge every 2 s on the page's timer (drop: 2 poor windows in a row; back: 8 good)`);
for (const order of ['frame', 'msg']) {
  const [o, n] = both({ link: GOOD, jank: JANK, order });
  line(`good link, page stalls 150-400 ms every 1.2-2.6 s (${order} first)`, o, n);
  ok(sum(o).drops > 0, `  the old judge drops a good link to 30 Hz on the page's stalls (${order} first): the test tells them apart`);
  ok(sum(n).drops === 0 && sum(n).poor === 0, `  the new one never calls it poor (${order} first)`);
  const [o2, n2] = both({ link: GOOD, jank: GC, order, s: 11 });
  line(`good link, 55-110 ms long frames every 0.3-0.9 s (${order} first)`, o2, n2);
  ok(sum(n2).drops === 0, `  ...never drops on long frames either (${order} first)`);
}
{ const [o, n] = both({ link: GOOD, jank: null, work: 40, s: 3 }); line('good link, a slow page (every frame takes 40 ms)', o, n); ok(sum(n).drops === 0, '  a slow page is not a bad link'); }
{ const [o, n] = both({ link: GOOD, jank: null }); line('good link, clean page', o, n); ok(same(o, n) && sum(n).drops === 0, '  identical decisions, never a drop'); }
for (const [nm, L] of [['home wifi (1% loss, 60-150 ms stalls)', HOME], ['the wifi measured today (4% loss, 100-350 ms stalls)', BAD]]) {
  const [o, n] = both({ link: L, jank: null, s: 5 }); line(nm + ', clean page', o, n);
  ok(same(o, n), '  identical decisions window by window on a clean page');
  if (L === BAD) ok(sum(n).drops > 0 && sum(n).firstDrop <= 6, `  drops to 30 Hz by ${sum(n).firstDrop} s, as before (${sum(o).firstDrop} s)`);
  const [oj, nj] = both({ link: L, jank: JANK, s: 5 }); line(nm + ' + page stalls', oj, nj);
  if (L === BAD) ok(sum(nj).drops > 0 && sum(nj).at30s >= 0.7 * SECS, `  still drops to 30 Hz through the page's stalls (by ${sum(nj).firstDrop} s; ${sum(nj).at30s} of ${SECS} s at 30 Hz)`);
  const [oh, nh] = both({ link: L, jank: JANK, hidden: true, s: 5 }); line(nm + ', hidden tab (no frames)', oh, nh);
  ok(same(oh, nh), '  a hidden tab: exactly the old decisions');
}
{ const [oh, nh] = both({ link: GOOD, jank: JANK, hidden: true, s: 9 }); ok(same(oh, nh), 'good link, hidden tab: exactly the old decisions'); }
// idle (a pause): the gap over it is never the link's, and the clock offset starts again (room time stood still)
{ const J = linkJudge(); let t = 0, now = 1000; for (let i = 0; i < 200; i++) { J.packet(now, t); J.frame(now + 1); now += FRAME; t += DT; }
  J.idle(); now += 5000; for (let i = 0; i < 200; i++) { J.packet(now, t); J.frame(now + 1); now += FRAME; t += DT; }
  const d = J.judge(true, FLOOR); ok(!d.poor && d.worst < 30, `a 5 s pause (room time stood still) is not a gap: worst ${Math.round(d.worst)} ms`); }
console.log(fails ? `\n${fails} FAILURE(S)` : '\nNETQ TEST PASSED');
process.exit(fails ? 1 : 0);
