// Word lists for server/usernames.js (docs/ACCOUNTS.md 7.3). Ships in the image, never under web/: a list the page can read is a list to route around.
// Plain words here; usernames.js keys each with skeleton() once at load and compares keys, so 'Adm1n' and 'P0ddle' hit the same entries.
// Maintained by the operator (Q9: the spec's list only for now). Data only: nothing runs on require.

const RESERVED_PREFIX = ['poddle', 'admin', 'moderator', 'staff', 'official', 'support', 'system', 'google'];   // the key STARTS with one: PoddleTeam, admin_2, SystemBot
const RESERVED_EXACT = ['matt', 'mattbot', 'botmatt', 'realmatt', 'thematt', 'mattpro', 'mod', 'rookie',       // the key EQUALS one. 'matt' is exact, not a prefix: Matthew and Mateo stay free
  'club', 'pro', 'tour', 'bot', 'player', 'player1', 'player2', 'guest', 'anonymous', 'null', 'undefined', 'you',
  'me', 'host', 'champion', 'referee', 'root', 'help', 'privacy', 'terms', 'opponent'];

// Guest names that pass as Matt or as the site show as Player 1/2 (7.3): EXACT on the imp() key, matt joined to a level word, PREFIX on the key.
const IMPERSONATE_EXACT = ['matt', 'mattbot', 'botmatt', 'realmatt', 'thematt'];
const LEVELS = ['pro', 'club', 'rookie', 'tour'];                                                    // Matt's levels: mattpro, promatt, mattclub ... are added from these
const IMPERSONATE_PREFIX = ['poddle', 'admin', 'moderator', 'staff', 'official'];

// Text that imitates the registered badge (a drawn element, 7.5): removed from every guest name. A regex character class body.
// √ ™ ☐☑☒ ✅ ✓ ✔ 🗸 🗹 🆗
const BADGES = '\\u221a\\u2122\\u2610-\\u2612\\u2705\\u2713\\u2714\\u{1f5f8}\\u{1f5f9}\\u{1f197}';

// Cyrillic and Greek letters that draw as Latin ones, for the guest-name comparison form only (imp(), 7.3). NFKD has already taken marks off.
const LOOKALIKE = {
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'і': 'i', 'ј': 'j', 'ѕ': 's', 'һ': 'h', 'ԁ': 'd',   // Cyrillic lower
  'т': 't', 'м': 'm', 'к': 'k', 'н': 'h', 'в': 'b', 'ԛ': 'q', 'ԝ': 'w',                                                   // Cyrillic lower that read as small capitals
  'М': 'M', 'Т': 'T', 'Н': 'H', 'В': 'B', 'К': 'K', 'А': 'A', 'Е': 'E', 'О': 'O', 'Р': 'P', 'С': 'C', 'Х': 'X',          // Cyrillic upper
  'І': 'I', 'Ј': 'J', 'Ѕ': 'S', 'Ү': 'Y', 'Ԁ': 'D',
  'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Η': 'H', 'Ι': 'I', 'Κ': 'K', 'Μ': 'M', 'Ν': 'N', 'Ο': 'O', 'Ρ': 'P', 'Τ': 'T', 'Χ': 'X',   // Greek upper
  'Υ': 'Y', 'Ζ': 'Z', 'ο': 'o', 'ν': 'v', 'α': 'a', 'ι': 'i', 'κ': 'k', 'τ': 't', 'ρ': 'p', 'υ': 'u', 'ε': 'e',          // Greek lower
  'ı': 'i', 'ł': 'l', 'ø': 'o', 'đ': 'd', 'ħ': 'h', 'ŧ': 't',                                                            // Latin letters NFKD leaves whole
};

// Profanity, base64 so the file reads cleanly in review (decode: Buffer.from(x, 'base64')). Chosen against /usr/share/dict/words so that few
// ordinary words are caught once skeleton() folds them: a stem that matched 'therapist', 'click' or 'sweetwater' went to EXACT or out.
const PROFANITY_SUB = [                                                                              // severe: blocked ANYWHERE in the key
  'bmlnZ2Vy', 'bmlnZ2Vycw==', 'bmlnZ2Fo', 'bmlnZ3Vo', 'ZmFnZ290', 'ZmFnZ2l0', 'dHJhbm55', 'dHJhbm5pZQ==', 'cmV0YXJk',
  'cmFnaGVhZA==', 'dG93ZWxoZWFk', 'c2FuZG5pZ2dlcg==', 'anVuZ2xlYnVubnk=', 'cG9yY2htb25rZXk=', 'emlwcGVyaGVhZA==',
  'Y2FtZWxqb2NrZXk=', 'amlnYWJvbw==', 'amlnZ2Fib28=', 'c2hlbWFsZQ==', 'aGVpbGhpdGxlcg==', 'aGl0bGVy', 'c2llZ2hlaWw=',
  'd2hpdGVwb3dlcg==', 'ZnVjaw==', 'ZnVr', 'ZmNr', 'ZnVja2Vy', 'bW90aGVyZnVja2Vy', 'cGh1Y2s=', 'ZnZjaw==', 'c2hpdA==',
  'YnVsbHNoaXQ=', 'aG9yc2VzaGl0', 'Y3VudA==', 'Y3ZudA==', 'Y29ja3N1Y2tlcg==', 'ZGlja2hlYWQ=', 'ZGlja3N1Y2tlcg==',
  'cHVzc3k=', 'cGVuaXM=', 'dmFnaW5h', 'Y2xpdG9yaXM=', 'Ymxvd2pvYg==', 'aGFuZGpvYg==', 'cmltam9i', 'Y3Vtc2hvdA==',
  'aml6eg==', 'c3B1bms=', 'ZGlsZG9z', 'YnV0dHBsdWc=', 'YXNzaG9sZQ==', 'YXJzZWhvbGU=', 'Yml0Y2g=', 'd2hvcmU=',
  'c2x1dA==', 'cG9ybmh1Yg==', 'YnVra2FrZQ==', 'Y3JlYW1waWU=', 'aGVudGFp', 'Z2FuZ2Jhbmc=', 'cGVkb3BoaWxl',
  'cGFlZG9waGlsZQ==', 'Y2hpbGRwb3Ju', 'aW5jZXN0', 'YmVzdGlhbGl0eQ==', 'em9vcGhpbGU=', 'bmVjcm9waGls', 'bWFzdHVyYmF0',
  'd2Fua2Vy', 'amVya29mZg==', 'YmFsbHNhY2s=', 'bnV0c2Fjaw==', 'a2lsbHlvdXJzZWxm'
];
const PROFANITY_EXACT = [                                                                            // mild: blocked only as the WHOLE key (Cockburn, Dickens, Pomona stay playable)
  'bmlnZ2E=', 'bmlnZ2Fz', 'bmlnZ2F6', 'a2lrZQ==', 'a3lrZQ==', 'Y2hpbms=', 'Y2hpbmtz', 'c3BpY2s=', 'c3BpY3M=',
  'c3BpYw==', 'Y29vbmFzcw==', 'ZGFya2ll', 'Z29vaw==', 'ZmFn', 'ZmFncw==', 'ZHlrZQ==', 'aG9tbw==', 'bGVzYm8=',
  'cGFraQ==', 'd29n', 'bmF6aQ==', 'bmF6aXM=', 'a2tr', 'eHh4', 'cG9ybg==', 'cG9ybm8=', 'cmFwaXN0', 'cGFlZG8=',
  'dHdhdA==', 'dHdhdHM=', 'bWlsZg==', 'b3JneQ==', 'cmFwZQ==', 'cmFwaW5n', 'cGVkbw==', 'YW5hbA==', 'YW51cw==', 'Y3Vt',
  'Ym9uZXI=', 'aG9va2Vy', 'dGl0dHk=', 'dGl0dGllcw==', 'dGl0cw==', 'Ym9vYmllcw==', 'bmlwcGxl', 'bmlwcGxlcw==',
  'aG9ybnk=', 'ZXJlY3Rpb24=', 'c2VtZW4=', 'dGVzdGljbGU=', 'c2Nyb3R1bQ==', 'd2Fuaw==', 'ZmFw', 'bWV0aA==', 'Y3JhY2s=',
  'Y29jYWluZQ==', 'aGVyb2lu', 'a3lz', 'c3VpY2lkZQ==', 'Y29jaw==', 'Y29ja3M=', 'YXNz', 'YXNzZXM=', 'YXJzZQ==',
  'YnV0dGhvbGU=', 'ZGFtbg==', 'Y3JhcA==', 'cGlzcw==', 'cGlzc2Vk', 'Ym9sbG9ja3M=', 'YnVnZ2Vy', 'cHJpY2s=', 'a25vYg==',
  'dG9zc2Vy', 'YmFzdGFyZA==', 'c2V4', 'c2V4eQ==', 'bnVkZQ==', 'bnVkZXM=', 'bmFrZWQ=', 'bnV0cw==', 'ZGlja2ZhY2U='
];

module.exports = { RESERVED_PREFIX, RESERVED_EXACT, IMPERSONATE_EXACT, IMPERSONATE_PREFIX, LEVELS, BADGES, LOOKALIKE, PROFANITY_SUB, PROFANITY_EXACT };
