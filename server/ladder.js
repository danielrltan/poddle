// The trophy ladder (docs/TROPHIES.md 1; docs/RANKED.md 5, DIVISIONS, NOTES 124 are history): eight ranks, three divisions each below Pro (Pro has none, NOTES 126), their trophy floors,
// what a game against a person and a game against Matt are worth. Pure CommonJS, no state, nothing runs on require. web/emblems.js mirrors the rank table (names, floors); test/ladder.test.mjs asserts they agree.
// Vocabulary (TROPHIES.md 0): "trophies" is the count, "tier" the rank index 1..8, "div" the division 1..3 inside it (I lowest, III highest: after III you
// rank up to the next rank's I; always 1 in Pro). `ranked` elsewhere in this codebase means "counted", never this mode.

// tier, name, floor (trophies where the rank starts), sticky (a floor you never fall below once reached), matt (the LOWEST Matt level, on the wire, a win pays at
// for this rank: Rookie 0, Club 1, Pro 2, Tour 3; difficulty order 0 < 1 < 3 < 2, an easier Matt is practice), mattWin (trophies for a played-out counted win against him; 0 from Champion up, and MATT_CEILING stops him under Champion)
// loss (what a loss to a person of equal trophies costs, NOTES 194: the owner wanted losses to bite harder as you climb, 'like brawlstars'). Against an equal opponent a
// rank holds at loss / (30 + loss) wins: 17% in Bronze, 37.5% in Platinum, 50% in Champion, 53% in Pro; it was 40% everywhere at a flat 20
const TIERS = Object.freeze([
  Object.freeze({ tier: 1, name: 'Bronze',   floor: 0,   sticky: true,  matt: 0, mattWin: 10, loss: 6 }),
  Object.freeze({ tier: 2, name: 'Silver',   floor: 150, sticky: true,  matt: 1, mattWin: 8, loss: 10 }),
  Object.freeze({ tier: 3, name: 'Gold',     floor: 300, sticky: true,  matt: 1, mattWin: 7, loss: 14 }),
  Object.freeze({ tier: 4, name: 'Platinum', floor: 450, sticky: true,  matt: 3, mattWin: 6, loss: 18 }),
  Object.freeze({ tier: 5, name: 'Diamond',  floor: 600, sticky: false, matt: 3, mattWin: 5, loss: 22 }),
  Object.freeze({ tier: 6, name: 'Master',   floor: 750, sticky: false, matt: 2, mattWin: 4, loss: 26 }),   // NOTES 124: the eighth rank (its name lives here and in web/emblems.js RANKS only)
  Object.freeze({ tier: 7, name: 'Champion', floor: 900, sticky: false, matt: 2, mattWin: 0, loss: 30 }),
  Object.freeze({ tier: 8, name: 'Pro',      floor: 1050, sticky: false, matt: 2, mattWin: 0, loss: 34 }),
]);
const TOP = TIERS.length;                                        // 8: Pro, the top rank (no divisions, NOTES 126)
const RANK_W = 150, DIV_W = 50, DIVS = 3;                        // a rank is 150 trophies wide, a division 50: Bronze I 0, II 50, III 100, Silver I 150 ... Champion III 1000. Pro (1050 and up, no cap) has NO divisions: its players are told apart by their global leaderboard place (NOTES 126, the owner: 'like Valorant')
const STICKY_TOP = 4;                                            // Bronze .. Platinum are kept for good (divisions inside them can be lost); Diamond and above can drop, never below Platinum's floor
const NAMES = Object.freeze(TIERS.map(t => t.name));
const FLOORS = Object.freeze(TIERS.map(t => t.floor));
const ROMAN = Object.freeze(['I', 'II', 'III']);
const CHAMPION = TIERS.findIndex(t => t.mattWin === 0) + 1;     // 7, Champion: the first rank Matt pays nothing in (found by the table, never by name)
const MATT_CEILING = TIERS[CHAMPION - 1].floor - 1;              // 899 = the Champion floor - 1: Matt carries a player to Master III at most (NOTES 124; before Master it was the Pro floor - 1, the same 899)

const int = v => (Number.isFinite(+v) ? Math.trunc(+v) : 0);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// tierOf(trophies) -> 1..8: the highest rank floor reached (anything unparseable or negative is Bronze)
function tierOf(trophies) { const t = int(trophies); let i = 0; while (i + 1 < TOP && t >= FLOORS[i + 1]) i++; return i + 1; }
// divOf(trophies, tier?) -> 1..3: the division inside the rank (tier defaults to tierOf(trophies)); always 1 in Pro, which has no divisions
function divOf(trophies, tier) { const t = clamp(int(tier == null ? tierOf(trophies) : tier), 1, TOP); return t === TOP ? 1 : 1 + clamp(Math.floor((int(trophies) - FLOORS[t - 1]) / DIV_W), 0, DIVS - 1); }
// hasDivs(tier) -> false for Pro: no numeral after its name, no division pill on its emblem
const hasDivs = tier => clamp(int(tier), 1, TOP) < TOP;
// romanOf(div) -> 'I' | 'II' | 'III'
function romanOf(div) { return ROMAN[clamp(int(div), 1, DIVS) - 1]; }
// rankName(tier, div) -> the player-facing rank string, 'Gold II' (div omitted, or Pro: the rank alone)
function rankName(tier, div) { const n = TIERS[clamp(int(tier), 1, TOP) - 1].name; return div == null || !hasDivs(tier) ? n : n + ' ' + romanOf(div); }
// floorOf(tier) -> that rank's first trophy count (a tier outside 1..8 is clamped)
function floorOf(tier) { return FLOORS[clamp(int(tier), 1, TOP) - 1]; }
// divFloorOf(tier, div) -> the division's first trophy count
function divFloorOf(tier, div) { return floorOf(tier) + (hasDivs(tier) ? clamp(int(div), 1, DIVS) - 1 : 0) * DIV_W; }   // Pro: its floor, whatever div is asked
// nextFloorOf(tier) -> the next rank's floor, null at the top
function nextFloorOf(tier) { const t = clamp(int(tier), 1, TOP); return t < TOP ? FLOORS[t] : null; }
// nextDivFloorOf(tier, div) -> where the next division (or the next rank) starts, null in Pro
function nextDivFloorOf(tier, div) { const t = clamp(int(tier), 1, TOP), d = clamp(int(div), 1, DIVS); if (t === TOP) return null; return d < DIVS ? divFloorOf(t, d + 1) : nextFloorOf(t); }
// applyFloor(bestTier, trophies) -> trophies, never below the sticky floor of the best RANK reached (Bronze..Platinum), never below 0
function applyFloor(bestTier, trophies) { return Math.max(int(trophies), floorOf(clamp(int(bestTier), 1, STICKY_TOP))); }

// humanDelta(me, them, won, sweep) -> trophies for one side of a game against a person, from BOTH sides' counts at the game's start (TROPHIES.md 3.3; sweep is history, always false now):
//   gap = clamp(them - me, -300, 300); win = winOf(me) + round(gap / 25) (+3 for a sweep) = 10..45; loss = -round(loss of MY rank * (1 - gap / 600)): half of it to someone
//   300 above, one and a half times it to someone 300 below. Bronze -3..-9, Platinum -9..-27, Pro -17..-51 (NOTES 194; it was -(20 - round(gap / 25)) = -32..-8 for every rank)
function humanDelta(me, them, won, sweep) {
  const gap = clamp(int(them) - int(me), -300, 300);
  return won ? winOf(int(me)) + Math.round(gap / 25) + (sweep ? 3 : 0) : -Math.round(lossOf(tierOf(me)) * (1 - gap / 600));
}
// winOf(trophies) -> what a win over an equal opponent pays at this count: 30 through Bronze, then one less every two or three divisions
// (30 - floor(0.4 * division index): Silver I 29, Gold I 28, Platinum I 27, Diamond I 26, Master I 24, Champion I 23, Champion III and Pro 22;
// NOTES 203: the owner wanted the climb 'slightly more intensive', a little less for every rank and division). Keep the table of lossOf in mind: a
// rank now holds at loss / (win + loss) wins: Bronze 17%, Platinum 40%, Champion 57%, Pro 61%
function winOf(trophies) { const t = tierOf(trophies), step = (t - 1) * DIVS + (divOf(trophies, t) - 1); return 30 - Math.floor(0.4 * step); }
// lossOf(tier) -> the rank's loss to an equal opponent (6 in Bronze .. 34 in Pro)
function lossOf(tier) { return TIERS[clamp(int(tier), 1, TOP) - 1].loss; }
// halveWin(delta) -> the winner's delta over a not-yet-established opponent (R11c new_opponent): half, never under 8
function halveWin(delta) { return Math.max(8, Math.round(int(delta) / 2)); }
// mattDelta(tier) -> a played-out counted win against Matt, by the rank at the START of that game
function mattDelta(tier) { return TIERS[clamp(int(tier), 1, TOP) - 1].mattWin; }
// mattLevel(tier) -> the lowest Matt wire level a win pays at for this rank
function mattLevel(tier) { return TIERS[clamp(int(tier), 1, TOP) - 1].matt; }
// mattAward(delta, dayUsed, dayCap, trophies) -> what a Matt win may really pay: the day cap and the ceiling applied, never negative
function mattAward(delta, dayUsed, dayCap, trophies) { return Math.max(0, Math.min(int(delta), int(dayCap) - int(dayUsed), MATT_CEILING - int(trophies))); }

const EXPORT_NAMES = NAMES;                                      // the export file names ranks by these words (never by tier number alone)

module.exports = { TIERS, NAMES, FLOORS, ROMAN, TOP, DIVS, RANK_W, DIV_W, STICKY_TOP, CHAMPION, MATT_CEILING, EXPORT_NAMES,
  tierOf, divOf, hasDivs, romanOf, rankName, floorOf, divFloorOf, nextFloorOf, nextDivFloorOf, applyFloor, humanDelta, winOf, lossOf, halveWin, mattDelta, mattLevel, mattAward };
