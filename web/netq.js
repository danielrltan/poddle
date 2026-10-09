// The link judge (web/main.js `net`, NOTES 236): is the connection struggling, so that the server should send half the state packets?
// It used to time the gaps between the state packets' message handlers, which is the main thread's view: a long frame or a GC pause on a
// good link holds the packets in the page's queue, they run in a burst after it, and that one long gap read as a lost packet. Two
// such windows in a row asked the server for 30 Hz, and the page stayed there for 16 s.
// Now the page's own stalls are taken out first. The main thread demonstrably ran at every frame (frame()) and every packet handler; a
// stretch of more than STALL_MS with neither is the page's own, not the link's. Each state packet carries the server's time t, so with the
// least-delayed packet of the last ~2 s it has an expected arrival (made + the quickest trip); whatever part of the wait from then (never
// before the previous packet's) to its handler fell inside a stall of the page's is not counted against the link. On a page that never
// stalls nothing changes: same gaps, same thresholds, same decisions. A hidden tab draws no frames, so there it judges the raw gaps.
// Pure (no DOM, no timers): test/netq.test.mjs drives it with a modelled page and link.
export const STALL_MS = 50;                // no frame and no handler for this long: the main thread was busy (a 30 fps page draws every 33 ms)
const KEEP_MS = 3000, OFF_N = 120;         // stalls older than this cannot overlap a packet still to come; the clock offset's window (~2 s at 60 Hz)

export function linkJudge({ stall = STALL_MS } = {}) {
  let hz = 60, bad = 0, good = 0, gaps = 0, late = 0, worst = 0, paged = 0;   // paged: ms the page itself did not run this window (dev stats)
  let beatAt = -Infinity, prev = NaN;      // prev: the last packet's arrival with the page's stalls taken out (NaN: the next gap is not the link's)
  const offs = new Float64Array(OFF_N); let nOff = 0, off = NaN;
  const st = [];                           // [from, to, from, to, ...] stretches the page did not run, oldest first
  const beat = (now, hidden) => {
    if (!hidden && now - beatAt > stall && beatAt > -Infinity) { st.push(beatAt, now); paged += now - beatAt; while (st.length && st[1] < now - KEEP_MS) st.splice(0, 2); }
    if (now > beatAt) beatAt = now;
  };
  const busy = (lo, hi) => { let s = 0; for (let i = 0; i < st.length; i += 2) s += Math.max(0, Math.min(hi, st[i + 1]) - Math.max(lo, st[i])); return s; };
  const fresh = () => { prev = NaN; nOff = 0; off = NaN; st.length = 0; };
  return {
    get hz() { return hz; },
    frame(now) { beat(now, false); },      // every animation frame: the page is free
    // a state packet's handler starts: now (local ms, performance.now()), t (its server time, s). hidden: document.hidden
    packet(now, t, hidden = false) {
      beat(now, hidden);
      let a = now;
      if (Number.isFinite(t)) {
        const d = now - 1000 * t;
        if (!(Math.abs(d - off) <= 1500)) nOff = 0;                                  // the server restarted, the room stood still, the tab slept
        offs[nOff++ % OFF_N] = d; off = Infinity; for (let i = Math.min(nOff, OFF_N) - 1; i >= 0; i--) if (offs[i] < off) off = offs[i];
        if (!hidden && st.length) { const lo = Math.max(1000 * t + off, prev === prev ? prev : -Infinity), b = busy(lo, now); a = now - b; }
      }
      const g = a - prev; prev = a;
      if (!(g <= 1000)) return;                                                      // the first packet, or after a long silence (a sleeping tab)
      gaps++; if (g > worst) worst = g; if (g > 1000 / hz + 45) late++;
    },
    // every 2 s. online: the game socket is up; floor: the quietest recent round trip (ms). -> the window's numbers, and ask: the rate to ask the server for, or null
    judge(online, floor) {
      const lateShare = gaps ? late / gaps : 0, poor = !!online && gaps > 10 && (lateShare > 0.04 || worst > 250 || floor > 140);
      if (poor) { bad++; good = 0; } else { good++; bad = 0; }
      let ask = null;
      if (bad >= 2 && hz === 60) ask = hz = 30;
      if (good >= 8 && hz === 30) ask = hz = 60;
      const out = { poor, lateShare, worst, gaps, paged, hz, ask };
      gaps = late = worst = paged = 0;
      return out;
    },
    idle() { fresh(); },                                                              // paused or held: the gap to the next live packet is not the link's
    rejoined() { hz = 60; bad = good = 0; fresh(); },                                 // a new socket starts at the full rate on the server
  };
}
