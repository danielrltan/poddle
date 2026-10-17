// Swing timing, counted here and nowhere else (NOTES 265): record-only, aggregate, in memory. Per paddle type (src: airpod | phone | none = a
// client that sends no src) and never per player: running counts and fixed-bin histograms of how human rally swings meet the ball. Nothing is
// written to disk or logged, and a restart starts it over. Read with GET /api/swingtime (the stats panel's key, api.js) or, on the machine,
// `node server/admin.js swingtime` (which asks the running server for it). game.js calls the recorders; none of them can throw into the game.
//
// What it answers (the strike-at-paddle rollout, NOTES 265; the judge's stop lines are re-aims > 60%, wait p90 > 200 ms, phone window ends > 5%):
//   strikes    rally swings struck by tryHit (never a serve or a held block). exempt: of them near-net (game.js nearNet: where the paddle is, any
//              loft), struck on arrival and re-aimed by design (reaimedNear); they are kept out of every other count and histogram, and the shares are
//              over strikes - exempt. waited: struck at the contact plane after waiting for the ball; windowEnd: a waiting swing whose window ran out before the plane
//              (strikes where the ball is: the fallback); late: the ball had passed the face, put back by the look-back (NOTES 238)
//   folded     the settled report was in before contact (the strike is final: nothing left to re-aim); bet: struck on the early report
//   reaimed    a struck rally ball the settled report then bent (reaim) / settledSame: the settled report changed nothing; whiffs: window ends
//   lost       a swing still live when its player lost the point (the ball it was for bounced twice before it struck); lostWaiting: of them,
//              swings that were waiting for that ball (STRIKE_WAIT): the losses the wait itself can cause, which no whiff count sees
//   waitMs     swing arrival -> strike; aheadCm: where the ball was struck, cm in front of the paddle (CONTACT 25; negative = behind the face)
//   betMs / settledMs   when the bet / the settled report reached the server, ms after the ball reached (or would reach) the contact plane:
//              the ALIGN proxy. The client's hand-peak time is not on the wire, so ALIGN itself is not here: the settled report arrives ~35 ms
//              motion.js's call after the peak + that sample's lateness + the one-way trip after the hand's peak. Measured on the AirPod captures
//              (test/strikeat.mjs with STATS_KEY, STRIKE_WAIT=0, ALIGN -60 / +30 / +100, 6.5 ms one way; NOTES 265): ALIGN ~ betMs + 40 (37-41)
//              ~ settledMs - 65 (59-71). A phone's samples come later (a relay leg each way), so read its offsets as rough. settledMs < 0
//              is a swing whose settled report would fold in at the plane (with the wait off: the counterfactual share).
//   reaimMs    strike -> re-aim (the recalculation the owner sees)
const SRC = ['airpod', 'phone', 'none'];
const HISTS = { waitMs: [-50, 500, 10], aheadCm: [-150, 170, 5], betMs: [-600, 400, 10], settledMs: [-600, 600, 10], reaimMs: [0, 400, 10] };
const COUNTS = ['strikes', 'exempt', 'reaimedNear', 'waited', 'windowEnd', 'late', 'folded', 'bet', 'reaimed', 'settledSame', 'whiffs', 'lost', 'lostWaiting'];
let since = Date.now(), by = null, mode = {};
function fresh() {
  by = {}; for (const s of SRC) { const o = { n: Object.fromEntries(COUNTS.map(k => [k, 0])), h: {} };
    for (const [k, [lo, hi, st]] of Object.entries(HISTS)) o.h[k] = new Uint32Array(Math.round((hi - lo) / st) + 2);   // [0] under lo, [last] at or over hi
    by[s] = o; }
}
fresh();
const srcOf = s => (s === 'airpod' || s === 'phone' ? s : 'none');
function init(o = {}) { mode = { ...o }; }                           // what the server runs with (strikeWait, replan): reported beside the counts
function reset() { since = Date.now(); fresh(); }
function count(src, k) { try { by[srcOf(src)].n[k]++; } catch { /* never into the game */ } }
function add(src, k, v) {
  try { if (!Number.isFinite(v)) return; const [lo, hi, st] = HISTS[k], a = by[srcOf(src)].h[k];
    a[v < lo ? 0 : v >= hi ? a.length - 1 : 1 + Math.floor((v - lo) / st)]++; } catch { /* never into the game */ }
}
// p (0..1) of a histogram, linear inside the bin; the end bins answer their edge
function quant(k, a, p) {
  const [lo, hi, st] = HISTS[k], n = a.reduce((x, y) => x + y, 0); if (!n) return null;
  let want = p * n, i = 0; for (; i < a.length; i++) { if (want <= a[i]) break; want -= a[i]; }
  if (i === 0) return lo; if (i >= a.length - 1) return hi;
  return Math.round(lo + (i - 1) * st + st * (a[i] ? want / a[i] : 0));
}
function report() {
  const src = {};
  for (const s of SRC) { const o = by[s], h = {};
    for (const k of Object.keys(HISTS)) { const a = o.h[k], n = a.reduce((x, y) => x + y, 0), [lo, , st] = HISTS[k];
      let neg = 0; for (let i = 0; i < a.length; i++) if (i === 0 || lo + (i - 1) * st + st <= 0) neg += a[i];   // bins wholly under 0 (the settled report in before the plane)
      h[k] = { n, p10: quant(k, a, 0.1), p50: quant(k, a, 0.5), p90: quant(k, a, 0.9), under0: n ? +(neg / n).toFixed(3) : null,
        bins: Object.fromEntries([...a].map((c, i) => [i === 0 ? '<' + lo : String(lo + (i - 1) * st), c]).filter(([, c]) => c)) }; }
    const n = o.n, share = (a, b) => (b ? +(a / b).toFixed(3) : null), rally = n.strikes - n.exempt;
    src[s] = { ...n, share: { waited: share(n.waited, rally), folded: share(n.folded, rally), reaimed: share(n.reaimed, rally), windowEnd: share(n.windowEnd, n.waited + n.windowEnd), late: share(n.late, rally), reaimedNear: share(n.reaimedNear, n.exempt), lostWaiting: share(n.lostWaiting, n.waited + n.windowEnd + n.lostWaiting) }, hist: h };
  }
  return { since: new Date(since).toISOString(), mode, src };
}
module.exports = { init, reset, count, add, report, HISTS, COUNTS };
