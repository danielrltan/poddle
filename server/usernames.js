// Usernames (docs/ACCOUNTS.md 7): the rules for a registered name, its uniqueness key, the reserved and profanity checks,
// the rename cooldown, and the guest-name impersonation check. Pure: no I/O, no clock of its own, nothing but tables built at load.
// The word lists live in server/words.js (never under web/: a list the page can read is a list to route around).
const W = require('./words');

const MAX_IN = 64;                                             // characters looked at before anything else: NFKC can grow a string, and a body field is attacker-sized
const NAME_RE = /^[A-Za-z0-9_]{3,12}$/;                        // after NFKC. ASCII only (Q10): fullwidth ＡＢＣ folds to ABC and passes, a Cyrillic М never does
const DAY = 86400000;
const RENAME_DAYS = () => { const d = +process.env.RENAME_DAYS; return Number.isFinite(d) && d >= 0 ? d : 30; };   // read per call, not at load: tests set it before the server starts, and nothing runs on require

// Look-alike ASCII folded to one letter, so Matt, M4tt, rnatt, MAT_T and Maatt share a key (7.2). Order is the spec's: map, then digraphs until stable, then runs.
const DIGIT = { 0: 'o', 1: 'l', i: 'l', '|': 'l', 5: 's', $: 's', 3: 'e', 4: 'a', '@': 'a', 7: 't', 8: 'b', 9: 'g', 2: 'z', 6: 'g' };
function skeleton(s) {                                         // -> the comparison key of a name: lowercase, no '_', look-alikes folded, rn/vv/cl joined, runs collapsed
  let k = String(s).slice(0, MAX_IN).toLowerCase().replace(/_/g, '').replace(/[0-9i|$@]/g, c => DIGIT[c]);
  for (let prev = ''; prev !== k;) { prev = k; k = k.replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/cl/g, 'd'); }   // 'rrnn' -> 'rmn' -> ... until nothing changes
  return k.replace(/(.)\1+/gu, '$1');
}

// The lists, keyed once at load (7.3). Sets for exact, arrays for prefix/substring: a few dozen entries, scanned per call.
const keys = a => [...new Set(a.map(skeleton))].filter(Boolean);
const b64 = a => a.map(x => Buffer.from(x, 'base64').toString('utf8'));
const RES_PREFIX = keys(W.RESERVED_PREFIX), RES_EXACT = new Set(keys(W.RESERVED_EXACT));
const BAD_SUB = keys(b64(W.PROFANITY_SUB)), BAD_EXACT = new Set(keys(b64(W.PROFANITY_EXACT)));
const IMP_PREFIX = keys(W.IMPERSONATE_PREFIX);
const IMP_EXACT = new Set(keys([...W.IMPERSONATE_EXACT, ...W.LEVELS.flatMap(l => ['matt' + l, l + 'matt'])]));   // matt joined before or after a level word: mattpro, promatt, mattclub ...

const reserved = key => RES_EXACT.has(key) || RES_PREFIX.some(p => key.startsWith(p));      // -> true when the key is one nobody may register
// Profanity (NOTES 204, 'a smart filter'): on top of the skeleton's look-alike folding, a second fold for the spellings people reach for (ph -> f, ck -> k,
// q -> k, x -> ks), applied to the lists and the name alike. Severe stems are blocked anywhere; mild words as the whole key OR as a whole token of the
// name, with '_', digits and a case change as the token edges: Sexy_Cat, pissOff, Damn99, cockLover are out, Cockburn, Dickens, Analyst, Classic stay.
const fold = k => k.replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/q/g, 'k').replace(/x/g, 'ks').replace(/(.)\1+/g, '$1');
const BAD_SUB_F = [...new Set(BAD_SUB.map(fold))], BAD_EXACT_F = new Set([...BAD_EXACT].map(fold));
const profane = key => { const f = fold(key); return BAD_EXACT_F.has(f) || BAD_SUB_F.some(p => f.includes(p)); };      // -> true for a severe stem anywhere in the key, or a mild word as the whole key (Scunthorpe stays playable)
const tokens = v => String(v).slice(0, MAX_IN).replace(/([a-z])([A-Z])/g, '$1 $2').split(/[^\p{L}]+/u).filter(Boolean);   // the words of a name: split at '_', digits, spaces, punctuation and a lower->Upper case change
const AFFIX = ['boy', 'girl', 'man', 'men', 'guy', 'gal', 'lover', 'king', 'queen', 'lord', 'master', 'god', 'bro', 'dude', 'kid', 'baby', 'daddy', 'mommy', 'mama', 'papa', 'big', 'lil', 'little', 'mr', 'mrs', 'your', 'real', 'xx'].map(a => fold(skeleton(a)));   // the words a mild word gets glued to: hornyboy, sexygirl, bigdick, mrcock, realslut. Nothing as short and common as 'the' or 'is': Therapist must stay
const bare = t => { let k = fold(skeleton(t)); for (let again = true; again;) { again = false; for (const a of AFFIX) { if (k.length > a.length + 2 && k.startsWith(a)) { k = k.slice(a.length); again = true; } if (k.length > a.length + 2 && k.endsWith(a)) { k = k.slice(0, -a.length); again = true; } } } return k; };   // -> the token with glued affixes peeled off, both ends, until none is left
const profaneTokens = v => tokens(v).some(t => { const k = fold(skeleton(t)); return BAD_EXACT_F.has(k) || BAD_EXACT_F.has(bare(t)); });   // -> true when any one word of the name is a mild word, on its own or glued to an affix
const profaneName = v => { const k = imp(v); return !!k && (profane(k) || profaneTokens(stripBadges(String(v).slice(0, MAX_IN)).normalize('NFKC').normalize('NFKD').replace(/\p{M}/gu, '').replace(LOOK_RE, c => LOOK[c]))); };   // -> a guest name (any script) that is profane: it shows as Player 1 / 2 (guestShown)

// validate(name) -> { ok: true, name, key } | { ok: false, reason }. reason: length | chars | letter | underscore | reserved | profanity (7.1).
function validate(v, { allowReserved = false } = {}) {      // allowReserved: the operator's own rename only (admin.js rename --reserved, NOTES 229); a player never passes it
  if (typeof v !== 'string') return { ok: false, reason: 'chars' };
  if (v.length > MAX_IN) return { ok: false, reason: 'length' };
  const name = v.normalize('NFKC').trim();
  const n = [...name].length;
  if (n < 3 || n > 12) return { ok: false, reason: 'length' };
  if (!NAME_RE.test(name)) return { ok: false, reason: 'chars' };
  if (!/[A-Za-z]/.test(name)) return { ok: false, reason: 'letter' };
  if (name[0] === '_' || name[name.length - 1] === '_' || name.includes('__')) return { ok: false, reason: 'underscore' };
  const key = skeleton(name);
  if (!allowReserved && (reserved(key) || impersonates(name))) return { ok: false, reason: 'reserved' };   // impersonates: ProMatt, TourMatt, Matt_Tour... would pass as the bot WITH the registered badge
  if (profane(key) || profaneTokens(name)) return { ok: false, reason: 'profanity' };
  return { ok: true, name, key };
}

// renameWait(renamedAt, now, days?) -> 0 when a (re)name is allowed now, else the wall ms it is allowed from (423 {"error":"cooldown","until"}, 7.4).
// renamedAt null/0 = never named: the first claim is free. db.claimUsername repeats this inside its transaction; this is for the route's early answer.
function renameWait(renamedAt, now, days = RENAME_DAYS()) {
  if (!renamedAt) return 0;
  const until = renamedAt + days * DAY;
  return now >= until ? 0 : until;
}

// Guest names (7.3). The badge is an element, never text (7.5); these are the cheap text imitations of it, removed from every guest name.
const BADGE_OUT = new RegExp('[' + W.BADGES + '][\\ufe0e\\ufe0f]?', 'gu');   // with the emoji/text selector after it, which would otherwise be left behind as an invisible mark
const stripBadges = s => String(s).replace(BADGE_OUT, '');     // -> the name without √ ™ ☐☑☒ ✅ ✓ ✔ 🗸 🗹 🆗; game.js cleanName calls it before NAME_OUT (W.BADGES is also exported as a class body)
const LOOK = W.LOOKALIKE, LOOK_RE = new RegExp('[' + Object.keys(LOOK).join('') + ']', 'gu');
// imp(name) -> the COMPARISON form of a guest name (the shown name is unchanged): badges out (™ would NFKC to "TM"), NFKC, NFKD, marks out,
// Cyrillic/Greek look-alikes to Latin, everything but letters and digits dropped, then skeleton(). 'Мatt', 'ΜΑΤΤ', 'M a t t', 'Mat̲t', 'Matt™' -> 'mat'.
function imp(v) {
  if (typeof v !== 'string') return '';
  const s = stripBadges(v.slice(0, MAX_IN)).normalize('NFKC').normalize('NFKD').replace(/\p{M}/gu, '').replace(LOOK_RE, c => LOOK[c]).replace(/[^\p{L}\p{N}]/gu, '');
  return skeleton(s);
}
const impersonates = name => { const k = imp(name); return !!k && (IMP_EXACT.has(k) || IMP_PREFIX.some(p => k.startsWith(p))); };   // -> true for a guest name that passes as Matt or as the site's staff. Matthew, Mateo, Me, Pro, Club stay false
const guestShown = (name, seat) => impersonates(name) || profaneName(name) ? 'Player ' + (seat === 1 ? 2 : 1) : name;   // -> what a guest seat shows: its (already cleaned) name, or 'Player 1'/'Player 2' by seat index 0/1 (passing as Matt or staff, or profane: NOTES 204)

module.exports = { validate, skeleton, reserved, profane, profaneName, renameWait, RENAME_DAYS, stripBadges, BADGES: W.BADGES, imp, impersonates, guestShown };
