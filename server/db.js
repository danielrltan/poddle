// Player stats storage (docs/ACCOUNTS.md section 2): one SQLite file on the Fly volume, one process, one connection.
// A pure data layer: no game knowledge, no clock of its own (every caller passes `now`), no identities in any log line.
// Loading this file does nothing: node:sqlite is required inside open(), so a server with stats off never touches it.
// Every function is a no-op returning null/false (or its documented empty value) while the database is not open, and
// NONE of them throws: endMatch runs inside sim() on the 60 Hz interval, and a throw there ends every room (4.2, 11.4).
// SQL: every value is a bound parameter of a statement prepared once in open(). The only numbers spliced into SQL text are
// max_page_count (a PRAGMA cannot take a parameter): an operator env value, forced to a clamped integer first; and the rank table's own
// integer constants (server/ladder.js FLOORS / DIV_W, frozen, never input) in extra()'s tier recompute.
const crypto = require('node:crypto'), fs = require('node:fs'), path = require('node:path');
const LAD = require('./ladder');                                  // the trophy ladder's pure table: tiers, floors, the Matt ceiling (docs/TROPHIES.md 1)

const WEB = path.join(__dirname, '..', 'web');                    // served publicly: the database may never live under it (11.1)
const DAY = 24 * 3600e3, HOUR = 3600e3;
const LEVEL_NAME = ['Rookie', 'Club', 'Pro', 'Tour'];             // wire index -> name. The ladder is four rungs in BOT_ORDER (Rookie, Club, Tour, Pro): Tour sits between Club and Pro (operator correction, Q2)
const BOT_ORDER = [0, 1, 3, 2];                                   // BOT_ORDER position -> wire index (server/game.js:142). Tour is easier than Pro
const KINDS = new Set(['bot', 'human', 'tour', 'tourbot']), HUMAN = new Set(['human', 'tour']), ENDINGS = new Set(['won', 'forfeit', 'left', 'dropped']);
const SESSION_DAYS = 180, SESSIONS_MAX = 10, SEEN_EVERY = HOUR;  // 3.3: absolute 180-day expiry, 10 live per account, seen_at at most hourly
const HOLD_RENAME_DAYS = 30, HOLD_DELETE_DAYS = 90;               // 7.4: an old name after a rename, a deleted account's name
const ACCOUNT_IDLE_DAYS = 730;                                    // 10.5 / Q8: no sign-in and no match for 24 months -> deleted
const BATCH = 500;                                                // 10.5: rows per sweep transaction; setImmediate between batches
// a match_log row that moved trophies to its winner: a counted win, or a paid forfeit win (ranked = 0 under early_forfeit, delta on the winner's side > 0:
// the leaver rule, docs/TROPHIES.md 3.4). The anti-abuse counts (R10 pairs, R11b one-way, R12 daily) take both, so forfeits cap like played-out games
const PAID = "(ranked = 1 OR (winner = 0 AND coalesce(delta_a, 0) > 0) OR (winner = 1 AND coalesce(delta_b, 0) > 0))";
const TRIM = 50;                                                  // log rows trimmed before one match is recorded near the size cap: small, since that runs inside sim() (each match adds at most one row)
const SQLITE = { 5: 'SQLITE_BUSY', 7: 'SQLITE_NOMEM', 8: 'SQLITE_READONLY', 10: 'SQLITE_IOERR', 11: 'SQLITE_CORRUPT', 13: 'SQLITE_FULL', 14: 'SQLITE_CANTOPEN', 19: 'SQLITE_CONSTRAINT', 26: 'SQLITE_NOTADB' };
const BROKEN = new Set([10, 11, 13]);                             // the write failures that turn ok() false (11.4); a constraint race does not

// Schema version 1, exactly section 2.2. Migration N runs when PRAGMA user_version < N, in one transaction.
const MIGRATIONS = [null, `
CREATE TABLE owners (
  id          INTEGER PRIMARY KEY,
  kind        TEXT    NOT NULL CHECK (kind IN ('device','account')),
  created_at  INTEGER NOT NULL,
  touched_at  INTEGER NOT NULL
);
CREATE INDEX owners_kind_touched ON owners(kind, touched_at);
CREATE TABLE devices (
  id          INTEGER PRIMARY KEY,
  dev_hash    BLOB    NOT NULL UNIQUE CHECK (length(dev_hash) = 32),
  owner_id    INTEGER UNIQUE REFERENCES owners(id) ON DELETE CASCADE,
  account_id  INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  merged_at   INTEGER
);
CREATE INDEX devices_account ON devices(account_id);
CREATE TABLE accounts (
  id            INTEGER PRIMARY KEY,
  owner_id      INTEGER NOT NULL UNIQUE REFERENCES owners(id) ON DELETE CASCADE,
  google_sub    TEXT    NOT NULL UNIQUE CHECK (length(google_sub) BETWEEN 1 AND 255),
  username      TEXT    UNIQUE,
  username_key  TEXT    UNIQUE,
  created_at    INTEGER NOT NULL,
  renamed_at    INTEGER,
  merges        INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE sessions (
  token_hash  BLOB    PRIMARY KEY CHECK (length(token_hash) = 32),
  account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  seen_at     INTEGER NOT NULL
);
CREATE INDEX sessions_account ON sessions(account_id);
CREATE INDEX sessions_expires ON sessions(expires_at);
CREATE TABLE name_holds (
  username_key TEXT    PRIMARY KEY,
  until_at     INTEGER NOT NULL
);
CREATE TABLE profile (
  owner_id        INTEGER PRIMARY KEY REFERENCES owners(id) ON DELETE CASCADE,
  played          INTEGER NOT NULL DEFAULT 0,
  h_wins          INTEGER NOT NULL DEFAULT 0,
  h_losses        INTEGER NOT NULL DEFAULT 0,
  h_streak        INTEGER NOT NULL DEFAULT 0,
  h_best_streak   INTEGER NOT NULL DEFAULT 0,
  h_points_won    INTEGER NOT NULL DEFAULT 0,
  h_points_lost   INTEGER NOT NULL DEFAULT 0,
  tour_titles     INTEGER NOT NULL DEFAULT 0,
  best_rally      INTEGER NOT NULL DEFAULT 0,
  best_rally_at   INTEGER,
  best_hit        INTEGER NOT NULL DEFAULT 0,
  best_hit_at     INTEGER,
  best_speed      REAL    NOT NULL DEFAULT 0,
  best_speed_at   INTEGER,
  updated_at      INTEGER NOT NULL
);
CREATE TABLE bot_record (
  owner_id      INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  level         INTEGER NOT NULL CHECK (level BETWEEN 0 AND 3),
  wins          INTEGER NOT NULL DEFAULT 0,
  losses        INTEGER NOT NULL DEFAULT 0,
  abandons      INTEGER NOT NULL DEFAULT 0,
  streak        INTEGER NOT NULL DEFAULT 0,
  best_streak   INTEGER NOT NULL DEFAULT 0,
  first_win_at  INTEGER,
  best_margin   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (owner_id, level)
);
CREATE TABLE match_log (
  id          INTEGER PRIMARY KEY,
  at          INTEGER NOT NULL,
  kind        TEXT    NOT NULL CHECK (kind IN ('bot','human','tour','tourbot')),
  bot_level   INTEGER,
  owner_a     INTEGER REFERENCES owners(id) ON DELETE SET NULL,
  owner_b     INTEGER REFERENCES owners(id) ON DELETE SET NULL,
  score_a     INTEGER NOT NULL,
  score_b     INTEGER NOT NULL,
  winner      INTEGER CHECK (winner IN (0,1)),
  ending      TEXT    NOT NULL CHECK (ending IN ('won','forfeit','left','dropped')),
  ranked      INTEGER NOT NULL CHECK (ranked IN (0,1)),
  flags       TEXT    NOT NULL DEFAULT '',
  secs        INTEGER NOT NULL
);
CREATE INDEX match_log_at ON match_log(at);
CREATE INDEX match_log_a  ON match_log(owner_a, at);
CREATE INDEX match_log_b  ON match_log(owner_b, at);
`,
// Schema version 2 (docs/RANKED.md 10.1, history): the trophy ladder, one row per owner, and the mode / series / trophy-delta columns on match_log (series is always NULL since docs/TROPHIES.md; the column stays).
// A separate table, not profile columns: profSet is a positional full-row update. kind keeps human/bot (its CHECK cannot be widened by ALTER).
`
CREATE TABLE ladder (
  owner_id      INTEGER PRIMARY KEY REFERENCES owners(id) ON DELETE CASCADE,
  trophies      INTEGER NOT NULL DEFAULT 0,
  tier          INTEGER NOT NULL DEFAULT 1,
  div           INTEGER NOT NULL DEFAULT 1,
  best_trophies INTEGER NOT NULL DEFAULT 0,
  best_tier     INTEGER NOT NULL DEFAULT 1,
  best_div      INTEGER NOT NULL DEFAULT 1,
  best_tier_at  INTEGER,
  wins          INTEGER NOT NULL DEFAULT 0,
  losses        INTEGER NOT NULL DEFAULT 0,
  streak        INTEGER NOT NULL DEFAULT 0,
  best_streak   INTEGER NOT NULL DEFAULT 0,
  bot_wins      INTEGER NOT NULL DEFAULT 0,
  bot_losses    INTEGER NOT NULL DEFAULT 0,
  matt_day      INTEGER NOT NULL DEFAULT 0,
  matt_day_at   INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL
);
ALTER TABLE match_log ADD COLUMN mode    TEXT    NOT NULL DEFAULT 'casual';
ALTER TABLE match_log ADD COLUMN series  INTEGER;
ALTER TABLE match_log ADD COLUMN delta_a INTEGER;
ALTER TABLE match_log ADD COLUMN delta_b INTEGER;
`];

// Additive schema outside the numbered migrations (NOTES 114): new profile counters and the share table. Idempotent, run on every open
// after the migrations. It deliberately takes no MIGRATIONS slot: the ladder (NOTES 112) owns migration 2, and the two were built in parallel, so
// whichever deployed first would have owned a shared slot while the other's migration silently never ran. Columns are only ever ADDED here (never renamed or dropped).
const PLAY_COLS = ['hits', 'returns', 'chances', 'winners', 'aces', 'smashes', 'pts_won', 'pts_lost', 'secs_played'];   // profile: every match kind, see stats.js play counters
const EXTRA = `
CREATE TABLE IF NOT EXISTS share (
  owner_id    INTEGER PRIMARY KEY REFERENCES owners(id) ON DELETE CASCADE,
  slug        TEXT    NOT NULL UNIQUE CHECK (length(slug) = 10),
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ladder_trophies ON ladder(trophies);
CREATE INDEX IF NOT EXISTS profile_rally ON profile(best_rally);
CREATE INDEX IF NOT EXISTS profile_hstreak ON profile(h_best_streak);
CREATE TABLE IF NOT EXISTS friends (
  a      INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  b      INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  since  INTEGER NOT NULL,
  PRIMARY KEY (a, b),
  CHECK (a < b)
);
CREATE INDEX IF NOT EXISTS friends_b ON friends(b);
CREATE TABLE IF NOT EXISTS friend_reqs (
  from_id      INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  to_id        INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  declined_at  INTEGER,
  asked_at     INTEGER,
  sent         INTEGER NOT NULL DEFAULT 1 CHECK (sent IN (0,1)),
  PRIMARY KEY (from_id, to_id),
  CHECK (from_id <> to_id)
);
CREATE INDEX IF NOT EXISTS friend_reqs_to ON friend_reqs(to_id);`;   // the global leaderboards (NOTES 126): each board reads one column, highest first. friends / friend_reqs (docs/SOCIAL.md 2): one row per pair (a < b);
// a request from -> to (the PK indexes from_id, friend_reqs_to the other side: an account's cascade never scans). sent 0 = a row its from side never sent
// (a removal's block, or a declined request its sender cancelled): it still blocks re-requests until it expires, but nobody is ever shown it. created_at is
// the from side's clock (expiry, the 'at' its sender sees; a blocked re-add restarts it as a real request would); asked_at is the to side's and never moves
// (when the request reached it: its export; NULL = a removal's block, never a request), so neither side learns what the other did since
// the rank table as SQL (NOTES 124): tier / div of a trophy count, exactly ladder.js tierOf / divOf (top rank first; Pro has one division; negatives are
// Bronze I: max(0, ...) matches JS's floor clamp although SQLite's integer division truncates toward zero). Built once from the frozen table (constants, never
// input), so a new rank or floor needs no SQL edit
const tierSql = c => 'CASE ' + LAD.FLOORS.map((f, i) => [f, i + 1]).reverse().map(([f, t]) => `WHEN ${c} >= ${f} THEN ${t} `).join('') + 'ELSE 1 END';
const divSql = c => 'CASE ' + LAD.FLOORS.map((f, i) => [f, i + 1]).reverse().map(([f, t]) => `WHEN ${c} >= ${f} THEN 1 + min(${LAD.hasDivs(t) ? LAD.DIVS - 1 : 0}, max(0, (${c} - ${f}) / ${LAD.DIV_W})) `).join('') + 'ELSE 1 END';
// Every open: tier / div from trophies and best_tier / best_div from best_trophies, for every row whose derived columns disagree with the table (Master
// moved Champion and Pro up one tier, NOTES 124). Trophies are never touched, so it is idempotent (a second run changes 0 rows) and heals rows an older build wrote
const RECOMPUTE = `UPDATE ladder SET tier = ${tierSql('trophies')}, div = ${divSql('trophies')}, best_tier = ${tierSql('best_trophies')}, best_div = ${divSql('best_trophies')}
  WHERE tier IS NOT ${tierSql('trophies')} OR div IS NOT ${divSql('trophies')} OR best_tier IS NOT ${tierSql('best_trophies')} OR best_div IS NOT ${divSql('best_trophies')}`;
let recomputed = 0;                                               // rows the last open's recompute rewrote (the unit test reads it through ladderRecomputed())
function extra() {
  const have = new Set(D.prepare('PRAGMA table_info(profile)').all().map(c => c.name)), acct = new Set(D.prepare('PRAGMA table_info(accounts)').all().map(c => c.name));
  D.exec('BEGIN IMMEDIATE');
  try {
    for (const c of PLAY_COLS) if (!have.has(c)) D.exec(`ALTER TABLE profile ADD COLUMN ${c} INTEGER NOT NULL DEFAULT 0`);   // c is a constant from PLAY_COLS, never input
    if (!acct.has('lb_hidden')) D.exec('ALTER TABLE accounts ADD COLUMN lb_hidden INTEGER NOT NULL DEFAULT 0');   // NOTES 126: 1 = the owner turned off Show me on the global leaderboard
    D.exec(EXTRA); recomputed = Number(D.prepare(RECOMPUTE).run().changes); D.exec('COMMIT');
  } catch (e) { if (D.isTransaction) D.exec('ROLLBACK'); throw e; }
}

let D = null, S = null, file = null, cfg = null;                  // the connection, its prepared statements, its path (null = memory), limits
let broken = false, sweeping = false;                             // broken: the last write failed with FULL/IOERR/CORRUPT (ok() false until one succeeds)
const logged = new Map();                                         // error code -> last log time: one line per code per hour (11.4)

const intEnv = (env, k, d, lo, hi) => { const v = Math.floor(Number(env[k])); return env[k] !== undefined && env[k] !== '' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
const codeOf = e => (e && Number.isInteger(e.errcode) && SQLITE[e.errcode & 0xff]) || (e && typeof e.code === 'string' && /^[A-Z_]{1,40}$/.test(e.code) ? e.code : 'error');   // a code name only, never a message (it can quote values)
function fail(e) {                                                // every caught database error lands here: maybe flip ok(), maybe one log line
  const primary = e && Number.isInteger(e.errcode) ? e.errcode & 0xff : -1;
  if (BROKEN.has(primary)) broken = true;                          // a constraint error (19) is logged but never flips ok(): it is a caller bug, not a broken disk
  const c = codeOf(e), now = Date.now();
  if (!(now - (logged.get(c) || -Infinity) < HOUR)) { logged.set(c, now); console.error('stats: database write failed (' + c + ')'); }
}
const guard = (empty, fn) => (...a) => { if (!D) return empty; try { return fn(...a); } catch (e) { fail(e); return empty; } };   // not open -> the empty value; any throw -> logged, the empty value
function tx(fn) {                                                 // one BEGIN IMMEDIATE ... COMMIT; rolled back on any throw (which is re-thrown to guard)
  D.exec('BEGIN IMMEDIATE');
  try { const r = fn(); D.exec('COMMIT'); broken = false; return r; }
  catch (e) { try { if (D.isTransaction) D.exec('ROLLBACK'); } catch { /* SQLite may have rolled back already */ } throw e; }
}
const sha256 = s => crypto.createHash('sha256').update(s).digest();
const isHash = h => (Buffer.isBuffer(h) || h instanceof Uint8Array) && h.length === 32;
const isId = n => Number.isSafeInteger(n) && n > 0;
const num = (v, lo, hi) => Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;
const iso = ms => ms == null ? null : new Date(ms).toISOString();
const checkpoint = () => { if (file) D.exec('PRAGMA wal_checkpoint(TRUNCATE)'); };   // deleted rows must not linger in the -wal file (2.1); memory has no WAL

// open(path, opts) -> true | false. Never throws. Unset/empty path = ':memory:'. opts.busyMs: admin.js waits longer than the server's 50 ms.
function open(p, opts = {}) {
  if (D) close();
  const env = process.env;
  cfg = { guestDays: intEnv(env, 'GUEST_DAYS', 90, 1, 3650), guestOneDays: intEnv(env, 'GUEST_ONE_DAYS', 7, 1, 3650), logDays: intEnv(env, 'LOG_DAYS', 30, 1, 3650),
    renameDays: intEnv(env, 'RENAME_DAYS', 30, 0, 3650), mergeMax: intEnv(env, 'MERGE_MAX', 10, 0, 1000), devicesMax: intEnv(env, 'DEVICES_MAX', 50, 0, 10000),
    maxMb: intEnv(env, 'DB_MAX_MB', 256, 1, 65536), logCap: intEnv(env, 'LOG_CAP_DAY', 100, 1, 100000), mattDay: intEnv(env, 'MATT_DAY', 40, 0, 100000),   // mattDay: trophies Matt may pay one owner per UTC day (docs/TROPHIES.md 3.3; was RK_MATT_DAY, nothing set it)
    friendMax: intEnv(env, 'FRIEND_MAX', 100, 1, 10000), reqOutMax: intEnv(env, 'REQ_OUT_MAX', 20, 1, 1000) };   // docs/SOCIAL.md 2: friends per account, pending requests out per account (test knobs like the rest)
  const where = p && String(p) !== ':memory:' ? path.resolve(String(p)) : null;
  try {
    if (where) {
      let dir = path.dirname(where); try { dir = fs.realpathSync(dir); } catch { /* missing dir: sqlite reports CANTOPEN below */ }
      const web = (() => { try { return fs.realpathSync(WEB); } catch { return WEB; } })();
      const inside = d => d === web || d.startsWith(web + path.sep) || d === WEB || d.startsWith(WEB + path.sep);
      if (inside(path.dirname(where)) || inside(dir)) { console.error('stats: database path refused'); return false; }
    }
    const { DatabaseSync } = require('node:sqlite');              // lazily: nothing SQLite happens until a server asks for stats (2.1)
    D = new DatabaseSync(where || ':memory:', { enableForeignKeyConstraints: true, allowExtension: false });
    D.exec('PRAGMA journal_mode=WAL');                            // 2.1, in this order. ':memory:' answers 'memory', which is fine
    D.exec('PRAGMA synchronous=NORMAL');
    D.exec('PRAGMA foreign_keys=ON');
    D.exec('PRAGMA busy_timeout=' + intEnv({ b: opts.busyMs }, 'b', 50, 0, 60000));
    D.exec('PRAGMA trusted_schema=OFF');
    D.exec('PRAGMA secure_delete=ON');                            // deleted rows are zeroed in the file, not left in free pages
    const pageSize = D.prepare('PRAGMA page_size').get().page_size;
    cfg.maxPages = Math.max(64, Math.floor(cfg.maxMb * 1048576 / pageSize));   // 256 MB / 4 KB = 65536; SQLITE_FULL beyond, never a full volume (5.5)
    D.exec('PRAGMA max_page_count=' + cfg.maxPages);              // the one spliced number: an integer computed above
    let v = D.prepare('PRAGMA user_version').get().user_version;
    if (v >= MIGRATIONS.length) throw Object.assign(new Error('schema'), { code: 'SQLITE_SCHEMA_NEWER' });   // a newer build wrote this file: do not guess
    for (v++; v < MIGRATIONS.length; v++) { D.exec('BEGIN IMMEDIATE'); try { D.exec(MIGRATIONS[v]); D.exec('PRAGMA user_version=' + v); D.exec('COMMIT'); } catch (e) { if (D.isTransaction) D.exec('ROLLBACK'); throw e; } }
    extra();
    prepare();
    file = where; broken = false;
    return true;
  } catch (e) {
    console.error('stats: database unavailable (' + codeOf(e) + ')');   // once per open; the game plays on without stats (11.4)
    try { if (D) D.close(); } catch { /* already unusable */ }
    D = S = null; file = null;
    return false;
  }
}
function close() { const d = D; D = S = null; file = null; try { if (d) d.close(); } catch { /* idempotent */ } }   // SIGINT/SIGTERM, before exit (11.3)
const isOpen = () => !!D;                                        // open, whatever the last write did: reads and deletes are still worth trying (a delete frees pages)
const ok = () => !!D && !broken;                                 // open and the last write did not fail with FULL/IOERR/CORRUPT
const nearFull = guard(false, () => S.pageCount.get().page_count - S.freePages.get().freelist_count >= 0.95 * cfg.maxPages);   // 95% of the cap in USED pages (free pages are reused): no new guest owners until sweep frees space (2.1)
const isNow = t => Number.isSafeInteger(t) && t > 0;             // every write takes the caller's clock; a missing one would fail NOT NULL deep inside

// The global leaderboards (NOTES 126). Only counted results feed them (the swing figures are reported by the phone, so they stay off: docs/ACCOUNTS.md Q14).
// col/from/min are constants spliced into prepare()'s SQL, never input. Everyone on a board is an account with a username that did not turn the board off
const BOARDS = Object.freeze({
  trophies: { col: 'l.trophies', min: 1, from: 'ladder l JOIN accounts a ON a.owner_id = l.owner_id' },
  rally:    { col: 'p.best_rally', min: 3, from: 'profile p JOIN accounts a ON a.owner_id = p.owner_id LEFT JOIN ladder l ON l.owner_id = p.owner_id' },
  streak:   { col: 'p.h_best_streak', min: 1, from: 'profile p JOIN accounts a ON a.owner_id = p.owner_id LEFT JOIN ladder l ON l.owner_id = p.owner_id' },
});
const LB_WHO = 'a.username IS NOT NULL AND a.lb_hidden = 0';
const LB_MAX = 100;
const REQ_DAYS = 30, INC_MAX = 50, SEARCH_MAX = 20;               // docs/SOCIAL.md 2-3: a request lives 30 days (declined or not); the newest 50 incoming are listed; search answers 20

function prepare() {                                             // every statement, once (2.1)
  const q = sql => D.prepare(sql);
  S = {
    pageCount: q('PRAGMA page_count'), freePages: q('PRAGMA freelist_count'),
    devByHash: q('SELECT id, owner_id, account_id FROM devices WHERE dev_hash = ?'),
    ownerIns: q('INSERT INTO owners (kind, created_at, touched_at) VALUES (?, ?, ?)'),
    ownerGet: q('SELECT id, kind, created_at, touched_at FROM owners WHERE id = ?'),
    ownerDel: q('DELETE FROM owners WHERE id = ?'),
    ownerTouch: q('UPDATE owners SET touched_at = max(touched_at, ?) WHERE id = ?'),
    devIns: q('INSERT INTO devices (dev_hash, owner_id, created_at) VALUES (?, ?, ?)'),
    devLink: q('UPDATE devices SET owner_id = NULL, account_id = ?, merged_at = ? WHERE id = ?'),
    devCount: q('SELECT count(*) AS n FROM devices WHERE account_id = ?'),
    devOfOwner: q('SELECT created_at FROM devices WHERE owner_id = ?'),
    devsOfAcct: q('SELECT created_at, merged_at FROM devices WHERE account_id = ? ORDER BY merged_at'),
    profIns: q('INSERT INTO profile (owner_id, updated_at) VALUES (?, ?)'),
    profGet: q('SELECT * FROM profile WHERE owner_id = ?'),
    profSet: q(`UPDATE profile SET played = ?, h_wins = ?, h_losses = ?, h_streak = ?, h_best_streak = ?, h_points_won = ?, h_points_lost = ?, tour_titles = ?,
      best_rally = ?, best_rally_at = ?, best_hit = ?, best_hit_at = ?, best_speed = ?, best_speed_at = ?, updated_at = ? WHERE owner_id = ?`),
    playAdd: q(`UPDATE profile SET ${PLAY_COLS.map(c => c + ' = ' + c + ' + ?').join(', ')} WHERE owner_id = ?`),   // the play counters, PLAY_COLS order (constants, never input). Its own statement: profSet stays as the ladder work left it
    botGet: q('SELECT * FROM bot_record WHERE owner_id = ? AND level = ?'),
    botAll: q('SELECT * FROM bot_record WHERE owner_id = ? ORDER BY level'),
    botPut: q(`INSERT INTO bot_record (owner_id, level, wins, losses, abandons, streak, best_streak, first_win_at, best_margin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (owner_id, level) DO UPDATE SET wins = excluded.wins, losses = excluded.losses, abandons = excluded.abandons, streak = excluded.streak,
      best_streak = excluded.best_streak, first_win_at = excluded.first_win_at, best_margin = excluded.best_margin`),
    acctIns: q('INSERT INTO accounts (owner_id, google_sub, created_at) VALUES (?, ?, ?)'),
    acctBySub: q('SELECT id, owner_id, username, renamed_at FROM accounts WHERE google_sub = ?'),
    acctById: q('SELECT id, owner_id, username, username_key, renamed_at, created_at, merges, google_sub FROM accounts WHERE id = ?'),
    acctByOwner: q('SELECT id, owner_id, username, username_key, renamed_at, created_at, merges, google_sub, lb_hidden FROM accounts WHERE owner_id = ?'),
    acctByKey: q('SELECT id, owner_id, username, renamed_at FROM accounts WHERE username_key = ?'),
    acctMerges: q('UPDATE accounts SET merges = merges + 1 WHERE id = ?'),
    acctName: q('UPDATE accounts SET username = ?, username_key = ?, renamed_at = ? WHERE id = ?'),
    sesIns: q('INSERT INTO sessions (token_hash, account_id, created_at, expires_at, seen_at) VALUES (?, ?, ?, ?, ?)'),
    sesGet: q('SELECT s.account_id, s.seen_at, a.owner_id, a.username FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ? AND s.expires_at > ?'),
    sesSeen: q('UPDATE sessions SET seen_at = ? WHERE token_hash = ?'),
    sesDel: q('DELETE FROM sessions WHERE token_hash = ?'),
    sesDelAll: q('DELETE FROM sessions WHERE account_id = ?'),
    sesDelDead: q('DELETE FROM sessions WHERE account_id = ? AND expires_at <= ?'),
    sesLive: q('SELECT token_hash FROM sessions WHERE account_id = ? ORDER BY created_at, rowid'),
    sesOfAcct: q('SELECT created_at, expires_at, seen_at FROM sessions WHERE account_id = ? ORDER BY created_at'),
    holdGet: q('SELECT until_at FROM name_holds WHERE username_key = ? AND until_at > ?'),
    holdPut: q('INSERT INTO name_holds (username_key, until_at) VALUES (?, ?) ON CONFLICT (username_key) DO UPDATE SET until_at = max(until_at, excluded.until_at)'),   // a 30-day hold never shortens a 90-day one
    holdDel: q('DELETE FROM name_holds WHERE username_key = ?'),
    logIns: q('INSERT INTO match_log (at, kind, bot_level, owner_a, owner_b, score_a, score_b, winner, ending, ranked, flags, secs, mode, series) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    logMoveA: q('UPDATE match_log SET owner_a = ? WHERE owner_a = ?'),
    logMoveB: q('UPDATE match_log SET owner_b = ? WHERE owner_b = ?'),
    logOf: q('SELECT * FROM match_log WHERE (owner_a = ? OR owner_b = ?) AND at >= ? ORDER BY at'),
    // series is always NULL now (docs/TROPHIES.md 3.8): every match is its own. Old rows may still carry a series id (the removed Ranked mode's best-of-3),
    // which R10 counts once ('s' / 'i' are two number spaces)
    // ...and a paid forfeit win (ranked = 0, but delta on the winner's side > 0: the leaver rule, TROPHIES.md 3.4) counts like a counted win for R10 / R11b / R12,
    // so repeated forfeits by one pair hit pair_cap and the stayer's day hits daily_cap (then the stayer gets +0 while the leaver still pays)
    pairs: q(`SELECT count(DISTINCT CASE WHEN series IS NULL THEN 'i' || id ELSE 's' || series END) AS n FROM match_log WHERE kind IN ('human','tour') AND ${PAID} AND at >= ? AND winner IS NOT NULL
      AND ((owner_a = ? AND owner_b = ?) OR (owner_a = ? AND owner_b = ?)) AND (series IS NULL OR series <> ?)`),
    // the trophy ladder (docs/TROPHIES.md 1)
    ladGet: q('SELECT * FROM ladder WHERE owner_id = ?'),
    ladTier: q('SELECT tier, div, trophies, best_tier, best_div, matt_day, matt_day_at FROM ladder WHERE owner_id = ?'),
    ladPut: q(`INSERT INTO ladder (owner_id, trophies, tier, div, best_trophies, best_tier, best_div, best_tier_at, wins, losses, streak, best_streak, bot_wins, bot_losses, matt_day, matt_day_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (owner_id) DO UPDATE SET trophies = excluded.trophies, tier = excluded.tier, div = excluded.div, best_trophies = excluded.best_trophies, best_tier = excluded.best_tier, best_div = excluded.best_div,
      best_tier_at = excluded.best_tier_at, wins = excluded.wins, losses = excluded.losses, streak = excluded.streak, best_streak = excluded.best_streak,
      bot_wins = excluded.bot_wins, bot_losses = excluded.bot_losses, matt_day = excluded.matt_day, matt_day_at = excluded.matt_day_at, updated_at = excluded.updated_at`),
    logDeltaA: q('UPDATE match_log SET delta_a = ? WHERE owner_a = ? AND (series = ? OR id = ?)'),   // the trophy change on that side's rows of a series (or the one Matt game)
    logDeltaB: q('UPDATE match_log SET delta_b = ? WHERE owner_b = ? AND (series = ? OR id = ?)'),
    humanOf: q(`SELECT owner_a, owner_b, winner FROM match_log WHERE kind IN ('human','tour') AND winner IS NOT NULL AND at >= ? AND (owner_a = ? OR owner_b = ?)`),
    winsOf: q(`SELECT count(*) AS n FROM match_log WHERE kind IN ('human','tour') AND ${PAID} AND at >= ? AND ((owner_a = ? AND winner = 0) OR (owner_b = ? AND winner = 1))`),
    winsOver: q(`SELECT count(*) AS n FROM match_log WHERE kind IN ('human','tour') AND ${PAID} AND at >= ?
      AND ((owner_a = ? AND owner_b = ? AND winner = 0) OR (owner_b = ? AND owner_a = ? AND winner = 1)) AND (series IS NULL OR series <> ?)`),   // R11b, per game, the series being played left out (REVIEW FIX: a clean best-of-3 must not flag itself mid-series)
    // sweep (10.5): rowid batches, one short transaction each
    swGuests: q(`DELETE FROM owners WHERE rowid IN (SELECT o.rowid FROM owners o LEFT JOIN profile p ON p.owner_id = o.id WHERE o.kind = 'device'
      AND (o.touched_at < ? OR (o.touched_at < ? AND coalesce(p.played, 0) <= 1)) LIMIT ${BATCH})`),
    swIdle: q(`SELECT o.id, a.username_key FROM owners o JOIN accounts a ON a.owner_id = o.id WHERE o.kind = 'account' AND o.touched_at < ? LIMIT ${BATCH}`),
    swSessions: q(`DELETE FROM sessions WHERE rowid IN (SELECT rowid FROM sessions WHERE expires_at <= ? LIMIT ${BATCH})`),
    swLog: q(`DELETE FROM match_log WHERE rowid IN (SELECT rowid FROM match_log WHERE at < ? LIMIT ${BATCH})`),
    swOldest: q(`DELETE FROM match_log WHERE rowid IN (SELECT rowid FROM match_log ORDER BY rowid LIMIT ?)`),   // size-aware retention: the oldest rows first, whatever their age
    logDay: q('SELECT count(*) AS n FROM match_log WHERE (owner_a = ? OR owner_b = ?) AND at >= ?'),   // the per-owner daily cap on log rows
    swHolds: q(`DELETE FROM name_holds WHERE rowid IN (SELECT rowid FROM name_holds WHERE until_at <= ? LIMIT ${BATCH})`),
    // share links (docs/SHARE.md 2): one row per owner. OR IGNORE: a second link for the owner or a slug collision inserts nothing, and the read-back tells which
    shareGet: q('SELECT slug, created_at FROM share WHERE owner_id = ?'),
    shareBySlug: q('SELECT owner_id FROM share WHERE slug = ?'),
    shareIns: q('INSERT OR IGNORE INTO share (owner_id, slug, created_at) VALUES (?, ?, ?)'),
    shareDel: q('DELETE FROM share WHERE owner_id = ?'),
    // the global leaderboards (NOTES 126): accounts with a username that did not hide themselves; one query for the top of a board, one for a place
    ...Object.fromEntries(Object.entries(BOARDS).map(([b, B]) => [
      ['lbTop_' + b, q(`SELECT a.username AS name, ${B.col} AS v, l.tier AS tier, l.div AS div FROM ${B.from} WHERE ${LB_WHO} AND ${B.col} >= ${B.min} ORDER BY ${B.col} DESC, a.username_key LIMIT ?`)],
      ['lbAbove_' + b, q(`SELECT count(*) AS n FROM ${B.from} WHERE ${LB_WHO} AND ${B.col} > ?`)],
      ['lbCount_' + b, q(`SELECT count(*) AS n FROM ${B.from} WHERE ${LB_WHO} AND ${B.col} >= ${B.min}`)],
    ]).flat()),
    lbMe: q(`SELECT a.username, a.lb_hidden, l.trophies, p.best_rally, p.h_best_streak FROM accounts a JOIN profile p ON p.owner_id = a.owner_id LEFT JOIN ladder l ON l.owner_id = a.owner_id WHERE a.owner_id = ?`),
    lbHide: q('UPDATE accounts SET lb_hidden = ? WHERE owner_id = ?'),
    // friends (docs/SOCIAL.md 2-3). A request is live while created_at > the expiry cutoff (the caller's now - 30 d): every read filters it, the sweep only tidies
    acctFresh: q('SELECT id, owner_id, username, lb_hidden FROM accounts WHERE id = ?'),
    frGet: q('SELECT since FROM friends WHERE a = ? AND b = ?'),
    frIns: q('INSERT OR IGNORE INTO friends (a, b, since) VALUES (?, ?, ?)'),
    frDel: q('DELETE FROM friends WHERE a = ? AND b = ?'),
    frCount: q('SELECT (SELECT count(*) FROM friends WHERE a = ?) + (SELECT count(*) FROM friends WHERE b = ?) AS n'),   // two index reads, not an OR scan
    frIds: q('SELECT b AS id FROM friends WHERE a = ? UNION ALL SELECT a FROM friends WHERE b = ?'),
    frList: q(`SELECT x.id, x.since, c.username AS name, l.tier AS tier, l.div AS div FROM (SELECT b AS id, since FROM friends WHERE a = ? UNION ALL SELECT a, since FROM friends WHERE b = ?) x
      JOIN accounts c ON c.id = x.id LEFT JOIN ladder l ON l.owner_id = c.owner_id WHERE c.username IS NOT NULL`),
    reqGet: q('SELECT created_at, declined_at, asked_at, sent FROM friend_reqs WHERE from_id = ? AND to_id = ? AND created_at > ?'),
    reqPut: q(`INSERT INTO friend_reqs (from_id, to_id, created_at, declined_at, asked_at, sent) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (from_id, to_id) DO UPDATE SET created_at = excluded.created_at, declined_at = excluded.declined_at, asked_at = excluded.asked_at, sent = excluded.sent`),
    reqDel: q('DELETE FROM friend_reqs WHERE from_id = ? AND to_id = ?'),
    reqDecline: q('UPDATE friend_reqs SET declined_at = ? WHERE from_id = ? AND to_id = ? AND declined_at IS NULL AND created_at > ?'),
    reqSent: q('UPDATE friend_reqs SET sent = ? WHERE from_id = ? AND to_id = ?'),
    reqResend: q('UPDATE friend_reqs SET sent = 1, created_at = ? WHERE from_id = ? AND to_id = ?'),   // a blocked re-add: its sender's clock restarts, declined_at / asked_at stay
    // whose lists name this account in a request (a rename or a delete changes them): the ones it asked (pending: their inc) and the ones asking it (sent: their out)
    reqPeers: q(`SELECT to_id AS id FROM friend_reqs WHERE from_id = ? AND sent = 1 AND declined_at IS NULL AND created_at > ?
      UNION SELECT from_id FROM friend_reqs WHERE to_id = ? AND sent = 1 AND created_at > ?`),
    reqOutN: q('SELECT count(*) AS n FROM friend_reqs WHERE from_id = ? AND sent = 1 AND created_at > ?'),   // declined ones count: their sender still sees them pending (a decline is silent)
    reqIn: q(`SELECT c.username AS name, r.created_at AS at FROM friend_reqs r JOIN accounts c ON c.id = r.from_id
      WHERE r.to_id = ? AND r.declined_at IS NULL AND r.created_at > ? AND c.username IS NOT NULL ORDER BY r.created_at DESC LIMIT ${INC_MAX}`),
    reqOut: q(`SELECT c.username AS name, r.created_at AS at FROM friend_reqs r JOIN accounts c ON c.id = r.to_id
      WHERE r.from_id = ? AND r.sent = 1 AND r.created_at > ? AND c.username IS NOT NULL ORDER BY r.created_at DESC`),
    // search (3): a case-insensitive prefix (LIKE is ASCII case-insensitive; usernames are ASCII) or the exact confusable key, never self; the exact key first
    frSearch: q(`SELECT id, username AS name FROM accounts WHERE username IS NOT NULL AND id <> ? AND (username LIKE ? ESCAPE '\\' OR username_key = ?)
      ORDER BY (username_key = ?) DESC, username COLLATE NOCASE LIMIT ${SEARCH_MAX}`),
    // the export (10.6 + docs/SOCIAL.md 2): by username only, never an id
    exFriends: q(`SELECT c.username AS name, x.since FROM (SELECT b AS id, since FROM friends WHERE a = ? UNION ALL SELECT a, since FROM friends WHERE b = ?) x JOIN accounts c ON c.id = x.id ORDER BY x.since`),
    // received: every row addressed to the account, sent or not (a request to it and its own decline, or its own removal's block), by asked_at / declined_at, which
    // never move: nothing shows what the other side did since, e.g. a blocked re-add. sent: only what its sender sees (a sent 0 row would reveal a silent decline or a removal)
    exReqIn: q('SELECT c.username AS name, r.asked_at AS at, r.declined_at, r.created_at AS live FROM friend_reqs r JOIN accounts c ON c.id = r.from_id WHERE r.to_id = ? ORDER BY coalesce(r.asked_at, r.declined_at)'),
    exReqOut: q('SELECT c.username AS name, r.created_at AS at FROM friend_reqs r JOIN accounts c ON c.id = r.to_id WHERE r.from_id = ? AND r.sent = 1 ORDER BY r.created_at'),
    swReqs: q(`DELETE FROM friend_reqs WHERE rowid IN (SELECT rowid FROM friend_reqs WHERE created_at <= ? LIMIT ${BATCH})`),
    // the leaderboard profile (NOTES 140): the account behind a username key, and whether it sits inside a board's top LB_MAX rows (the same WHERE and ORDER BY as lbTop_)
    lbKey: q(`SELECT a.owner_id, a.username, a.username_key, a.lb_hidden, l.owner_id IS NOT NULL AS ranked, l.trophies, p.best_rally, p.h_best_streak
              FROM accounts a JOIN profile p ON p.owner_id = a.owner_id LEFT JOIN ladder l ON l.owner_id = a.owner_id WHERE a.username_key = ?`),
  };
}

function newOwner(kind, now) { const id = Number(S.ownerIns.run(kind, now, now).lastInsertRowid); S.profIns.run(id, now); return id; }

// ownerForDevice(devHash, now, {create, out}) -> owner id | null. The device's own guest owner, or the owner of the account it merged
// into (4.7). Rows are created ONLY with create:true (a completed match, 5.5) and never while nearFull(). out.created = true when made here.
const ownerForDevice = guard(null, (devHash, now, opts) => {
  opts = opts || {};
  if (!isHash(devHash) || !isNow(now)) return null;
  const d = S.devByHash.get(devHash);
  if (d && d.owner_id != null) return d.owner_id;
  if (d && d.account_id != null) { const a = S.acctById.get(d.account_id); return a ? a.owner_id : null; }
  if (d || !opts.create || nearFull()) return null;
  return tx(() => { const id = newOwner('device', now); S.devIns.run(Buffer.from(devHash), id, now); if (opts.out) opts.out.created = true; return id; });
});
const guestOwner = guard(null, devHash => { if (!isHash(devHash)) return null; const d = S.devByHash.get(devHash); return d && d.owner_id != null ? d.owner_id : null; });   // what a device id may read/export/delete (8.1)
const accountByDevice = guard(null, devHash => { if (!isHash(devHash)) return null; const d = S.devByHash.get(devHash); return d && d.account_id != null ? d.account_id : null; });
const accountBySub = guard(null, sub => typeof sub === 'string' && sub.length >= 1 && sub.length <= 255 ? (row => row ? { id: row.id, owner_id: row.owner_id, username: row.username, renamed_at: row.renamed_at } : null)(S.acctBySub.get(sub)) : null);
const accountById = guard(null, id => { if (!isId(id)) return null; const r = S.acctById.get(id); return r ? { id: r.id, owner_id: r.owner_id, username: r.username, renamed_at: r.renamed_at } : null; });   // addition: /api/me and /api/username need renamed_at for a session's account
const accountByKey = guard(null, key => typeof key === 'string' && key.length && key.length <= 64 ? (r => r ? { id: r.id, owner_id: r.owner_id, username: r.username, renamed_at: r.renamed_at } : null)(S.acctByKey.get(key)) : null);   // addition: admin.js finds a username by its skeleton
const createAccount = guard(null, (sub, now) => {                // -> the account row (new owner + profile); the existing row if this sub already has one
  if (typeof sub !== 'string' || sub.length < 1 || sub.length > 255 || !isNow(now)) return null;
  return tx(() => { const have = S.acctBySub.get(sub); if (have) return accountBySub(sub);
    const oid = newOwner('account', now); const id = Number(S.acctIns.run(oid, sub, now).lastInsertRowid); return { id, owner_id: oid, username: null, renamed_at: null }; });
});
const deviceCount = guard(0, acct => isId(acct) ? S.devCount.get(acct).n : 0);   // device rows linked to the account (cap DEVICES_MAX, 2.4)
const ownerExists = guard(false, id => isId(id) && !!S.ownerGet.get(id));

// Fold guest G into account owner A (2.4): counts add, bests take the max (with their _at), streaks keep A's, first_win_at the earlier.
function fold(g, a, now) {
  const G = S.profGet.get(g), A = S.profGet.get(a);
  if (G && A) {
    const best = (k) => (G[k] > A[k] ? [G[k], G[k + '_at']] : [A[k], A[k + '_at']]);
    const [r, ra] = best('best_rally'), [h, ha] = best('best_hit'), [sp, spa] = best('best_speed');
    S.profSet.run(A.played + G.played, A.h_wins + G.h_wins, A.h_losses + G.h_losses, A.h_streak, Math.max(A.h_best_streak, G.h_best_streak),
      A.h_points_won + G.h_points_won, A.h_points_lost + G.h_points_lost, A.tour_titles + G.tour_titles, r, ra, h, ha, sp, spa, now, a);
    S.playAdd.run(...PLAY_COLS.map(c => Math.round(num(G[c], 0, 1e9))), a);   // the play counters add (docs/SHARE.md 1)
  }
  for (const gb of S.botAll.all(g)) {
    const ab = S.botGet.get(a, gb.level) || { wins: 0, losses: 0, abandons: 0, streak: 0, best_streak: 0, first_win_at: null, best_margin: 0 };
    const first = gb.first_win_at == null ? ab.first_win_at : ab.first_win_at == null ? gb.first_win_at : Math.min(gb.first_win_at, ab.first_win_at);
    S.botPut.run(a, gb.level, ab.wins + gb.wins, ab.losses + gb.losses, ab.abandons + gb.abandons, ab.streak, Math.max(ab.best_streak, gb.best_streak), first, Math.max(ab.best_margin, gb.best_margin));
  }
  S.logMoveA.run(a, g); S.logMoveB.run(a, g);                    // the pair caps keep working across the merge
  // the trophy ladder (docs/TROPHIES.md 1): a merge must never double a position: trophies / best_* / tier take the max, W/L and Matt games add, the streak is
  // the account's, and Matt's day count is the sum (capped) when both rows are on the same day, else the later day's
  const LG = S.ladGet.get(g); if (LG) {
    const LA = S.ladGet.get(a) || ladZero(a);
    const trophies = Math.max(LA.trophies, LG.trophies), bestT = Math.max(LA.best_trophies, LG.best_trophies), bestTier = Math.max(LA.best_tier, LG.best_tier);
    const bestDiv = LA.best_tier === LG.best_tier ? Math.max(LA.best_div, LG.best_div) : LA.best_tier > LG.best_tier ? LA.best_div : LG.best_div;
    const at = LG.best_tier > LA.best_tier ? LG.best_tier_at : LA.best_tier > LG.best_tier ? LA.best_tier_at : LA.best_tier_at == null ? LG.best_tier_at : LG.best_tier_at == null ? LA.best_tier_at : Math.min(LA.best_tier_at, LG.best_tier_at);
    const [md, mdAt] = LA.matt_day_at === LG.matt_day_at ? [Math.min(cfg.mattDay, LA.matt_day + LG.matt_day), LA.matt_day_at] : LA.matt_day_at > LG.matt_day_at ? [LA.matt_day, LA.matt_day_at] : [LG.matt_day, LG.matt_day_at];
    S.ladPut.run(a, trophies, LAD.tierOf(trophies), LAD.divOf(trophies), bestT, bestTier, bestDiv, at, LA.wins + LG.wins, LA.losses + LG.losses, LA.streak, Math.max(LA.best_streak, LG.best_streak),
      LA.bot_wins + LG.bot_wins, LA.bot_losses + LG.bot_losses, md, mdAt, now);
  }
}
// mergeDevice(devHash, accountId, now) -> 'merged' | 'none' (the table in 2.4; 'linked', which dropped the guest stats past MERGE_MAX, is never returned now). One transaction. Never inserts a row for an unknown device.
const mergeDevice = guard('none', (devHash, acctId, now) => {
  if (!isHash(devHash) || !isId(acctId) || !isNow(now)) return 'none';
  return tx(() => {
    const d = S.devByHash.get(devHash), acct = S.acctById.get(acctId);
    if (!d || !acct || d.account_id != null || d.owner_id == null) return 'none';   // unknown, already merged (here or into another account)
    if (S.devCount.get(acctId).n >= cfg.devicesMax) return 'none';                // the guest profile stays a guest (expires on its own)
    if (acct.merges >= cfg.mergeMax) return 'none';             // past MERGE_MAX the guest profile stays a guest too: the sign-in card promises "Your stats from this browser come with you", so none is ever dropped
    const g = d.owner_id;
    fold(g, acct.owner_id, now); S.acctMerges.run(acctId);
    S.devLink.run(acctId, now, d.id);                           // owner_id NULL BEFORE the owner goes, or the cascade would take the device row too
    S.shareDel.run(g);                                          // the guest's share link dies, never moves: it pointed at the guest card (the cascade would take it too; this says so)
    S.ownerDel.run(g);
    S.ownerTouch.run(now, acct.owner_id);
    return 'merged';
  });
});

// Sessions (3.3). The raw token is returned once and never stored: only SHA-256(raw).
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const session = {
  // create(accountId, now, out?) -> raw token (base64url, 43 chars). Expired rows of the account go; the 11th live one evicts the oldest.
  // out.evicted (addition) = the evicted token hashes, for stats.forget. A new sign-in also touches the owner (retention, 10.5).
  create: guard(null, (acct, now, out) => {
    if (!isId(acct) || !isNow(now)) return null;
    const raw = crypto.randomBytes(32).toString('base64url');
    return tx(() => {
      const a = S.acctById.get(acct); if (!a) return null;
      S.sesDelDead.run(acct, now);
      const live = S.sesLive.all(acct), evicted = [];
      for (let i = 0; i <= live.length - SESSIONS_MAX; i++) { S.sesDel.run(live[i].token_hash); evicted.push(Buffer.from(live[i].token_hash)); }
      S.sesIns.run(sha256(raw), acct, now, now + SESSION_DAYS * DAY, now);
      S.ownerTouch.run(now, a.owner_id);
      if (out) out.evicted = evicted;
      return raw;
    });
  }),
  // lookup(raw, now) -> {accountId, ownerId, username, tokenHash} | null. Found by its hash through the primary key, so no raw comparison happens.
  lookup: guard(null, (raw, now) => {
    if (typeof raw !== 'string' || !TOKEN.test(raw) || !isNow(now)) return null;
    const h = sha256(raw), r = S.sesGet.get(h, now);
    if (!r) return null;
    if (now - r.seen_at >= SEEN_EVERY) { try { S.sesSeen.run(now, h); broken = false; } catch (e) { fail(e); } }   // a failed touch never fails the sign-in state
    return { accountId: r.account_id, ownerId: r.owner_id, username: r.username, tokenHash: h };
  }),
  revoke: guard(false, raw => typeof raw === 'string' && TOKEN.test(raw) && S.sesDel.run(sha256(raw)).changes > 0),
  revokeAll: guard(0, acct => isId(acct) ? Number(S.sesDelAll.run(acct).changes) : 0),
};

// recordMatch(m): ONE transaction (4.7 step 4). The shape (built by stats.onEnd from the judge's verdict):
//   { now, kind: 'bot'|'human'|'tour'|'tourbot', level: WIRE index 0..3 (bot kinds; tourbot defaults to 3) | levelRank: BOT_ORDER position (converted),
//     winner: 0|1|null, ending: 'won'|'forfeit'|'left'|'dropped', score: [a, b], secs, ranked: bool, flags: string[] | 'a,b',
//     seats: [ { owner: id|null, record: bool, bests: bool, swingBad?: bool, bestRally, bestHit (0..100), bestSpeed (rad/s),
//       play?: { hits, returns, chances, winners, aces, smashes, ptsWon, ptsLost } (added with secs only when record && bests: docs/SHARE.md 1) } | null, x2 ] }
// A seat whose owner no longer exists is recorded as no owner (the other seat is kept). No owner at all -> nothing written.
// No log row for leaving Matt ('left'/'dropped', bot_record counts it) or past LOG_CAP_DAY rows for a seat's owner in 24 h (capped: a bot result still
// counts, a human one changes no record, since R10-R12 read the log). Near the size cap the oldest log rows go first, in their own transaction.
// -> { logged: bool (something was saved), row: bool (a match_log row was written), capped: bool, seats: [ { saved, guest, first, streak, bests: [{what, v, prev}] } | { saved: false } ] } ; null when not open or on a failed write.
const recordMatch = guard(null, m => {
  if (!m || typeof m !== 'object') return null;
  const now = m.now, kind = m.kind, ending = m.ending, winner = m.winner === 0 || m.winner === 1 ? m.winner : null;
  const sc = Array.isArray(m.score) ? [0, 1].map(i => Math.round(num(m.score[i], 0, 1e4))) : null;
  const flags = Array.isArray(m.flags) ? m.flags.join(',') : typeof m.flags === 'string' ? m.flags : '';
  if (!isNow(now) || !KINDS.has(kind) || !ENDINGS.has(ending) || !sc || !Array.isArray(m.seats) || flags.length > 400 || !/^[a-z0-9_,]*$/.test(flags)) return null;
  const bot = !HUMAN.has(kind);
  let level = null;
  if (bot) { level = Number.isInteger(m.level) ? m.level : Number.isInteger(m.levelRank) ? BOT_ORDER[m.levelRank] : kind === 'tourbot' ? 3 : null;   // never read a rank as a level: rank 2 is Tour (3), rank 3 is Pro (2)
    if (!(level >= 0 && level <= 3)) return null; }
  const secs = Math.round(num(m.secs, 0, 1e7)), ranked = m.ranked ? 1 : 0;
  const mode = m.mode === 'ladder' ? 'ladder' : 'casual', series = Number.isSafeInteger(m.series) && m.series > 0 ? m.series : null;   // the mode ('ladder': a seat could earn trophies) and series, history: always null now (docs/TROPHIES.md 3.8)
  if (broken || nearFull()) trimLog();                            // size-aware retention, in its OWN transaction first: a SQLITE_FULL rollback of this match must not undo it, and its success clears `broken`
  return tx(() => {
    const seats = [0, 1].map(i => { const s = m.seats[i]; return s && typeof s === 'object' && isId(s.owner) && S.ownerGet.get(s.owner) ? s : null; });   // ownerExists per seat, inside the transaction
    const out = { logged: false, row: false, capped: false, logId: null, seats: [{ saved: false }, { saved: false }] };
    if (!seats[0] && !seats[1]) return out;                     // 5.5: no owner, no row
    out.logged = true;
    const quit = bot && (ending === 'left' || ending === 'dropped');   // leaving Matt: bot_record counts it, no log row (one owner could otherwise loop join, strike, leave into the size cap)
    out.capped = !quit && seats.some(s => s && S.logDay.get(s.owner, s.owner, now - DAY).n >= cfg.logCap);   // LOG_CAP_DAY rows per owner a day
    if (!quit && !out.capped) { out.logId = Number(S.logIns.run(now, kind, level, seats[0] ? seats[0].owner : null, seats[1] ? seats[1].owner : null, sc[0], sc[1], winner, ending, ranked, flags, secs, mode, series).lastInsertRowid); out.row = true; }
    const done = new Set();
    for (const i of [0, 1]) {
      const s = seats[i]; if (!s) continue;
      const o = s.owner, P = S.profGet.get(o), won = winner === i, lost = winner === 1 - i, rec = !!s.record && !(out.capped && !bot);   // past the cap a human result has no row for R10-R12 to see: it changes no record
      if (!P) continue;
      const res = { saved: true, guest: S.ownerGet.get(o).kind === 'device', first: false, streak: 0, bests: [] };
      const p = { ...P }; if (!done.has(o)) { p.played++; done.add(o); }   // one person in both seats (R6) plays one match, not two
      if (!bot) {
        if (rec && won) { p.h_wins++; p.h_streak++; p.h_best_streak = Math.max(p.h_best_streak, p.h_streak); }
        else if (rec && lost) { p.h_losses++; p.h_streak = 0; }
        if (rec && (won || lost)) { p.h_points_won += sc[i]; p.h_points_lost += sc[1 - i]; }
        res.streak = p.h_streak;
      } else {
        const b = S.botGet.get(o, level) || { wins: 0, losses: 0, abandons: 0, streak: 0, best_streak: 0, first_win_at: null, best_margin: 0 };
        if (rec) {
          if (won) { b.wins++; b.streak++; b.best_streak = Math.max(b.best_streak, b.streak); b.best_margin = Math.max(b.best_margin, sc[i] - sc[1 - i]);
            if (b.first_win_at == null) { b.first_win_at = now; res.first = true; } }
          else if (lost || ending === 'left') { b.losses++; b.streak = 0; }        // G1a: quitting after the first strike is a loss
          else if (ending === 'dropped') { b.abandons++; b.streak = 0; }           // G1b / C': no W/L, streak broken
          S.botPut.run(o, level, b.wins, b.losses, b.abandons, b.streak, b.best_streak, b.first_win_at, b.best_margin);
        }
        res.streak = b.streak;
      }
      if (rec && s.bests) {                                        // judge()'s bests is the only switch (4.4); swingBad drops hit/speed only (R15)
        const bump = (what, col, v) => { if (v > p[col]) { res.bests.push({ what, v, prev: p[col] }); p[col] = v; p[col + '_at'] = now; } };
        bump('rally', 'best_rally', Math.round(num(s.bestRally, 0, 1e4)));
        if (!s.swingBad) { bump('hit', 'best_hit', Math.round(num(s.bestHit, 0, 100))); bump('speed', 'best_speed', Math.round(num(s.bestSpeed, 0, 45) * 100) / 100); }
      }
      S.profSet.run(p.played, p.h_wins, p.h_losses, p.h_streak, p.h_best_streak, p.h_points_won, p.h_points_lost, p.tour_titles,
        p.best_rally, p.best_rally_at, p.best_hit, p.best_hit_at, p.best_speed, p.best_speed_at, now, o);
      if (rec && s.bests && s.play && typeof s.play === 'object') S.playAdd.run(...playRow(s.play, i === 1 && seats[0] && seats[0].owner === o ? 0 : secs), o);   // the bests' switch: a result that did not count adds nothing. One owner in both seats (R6) plays the minutes once
      S.ownerTouch.run(now, o);
      out.seats[i] = res;
    }
    return out;
  });
});
// playRow(play, secs) -> the PLAY_COLS values for playAdd, each clamped (stats.js seat counters: docs/SHARE.md 1)
const playRow = (x, secs) => [x.hits, x.returns, x.chances, x.winners, x.aces, x.smashes, x.ptsWon, x.ptsLost, secs].map(v => Math.round(num(v, 0, 1e6)));
function trimLog() { try { tx(() => Number(S.swOldest.run(TRIM).changes)); } catch (e) { fail(e); } }   // the oldest TRIM log rows (a delete goes to the WAL, which max_page_count does not cap)
// addTitle(ownerId, now) -> true when credited (addition: section 4.3 stats.title needs a write for tour_titles; the spec lists none).
const addTitle = guard(false, (o, now) => isId(o) && isNow(now) && tx(() => { const P = S.profGet.get(o); if (!P) return false;
  S.profSet.run(P.played, P.h_wins, P.h_losses, P.h_streak, P.h_best_streak, P.h_points_won, P.h_points_lost, P.tour_titles + 1,
    P.best_rally, P.best_rally_at, P.best_hit, P.best_hit_at, P.best_speed, P.best_speed_at, now, o); S.ownerTouch.run(now, o); return true; }));

// ---- the trophy ladder (docs/TROPHIES.md 1, 3): one row per owner who has been paid or charged once ----
const ladZero = o => ({ owner_id: o, trophies: 0, tier: 1, div: 1, best_trophies: 0, best_tier: 1, best_div: 1, best_tier_at: null, wins: 0, losses: 0, streak: 0, best_streak: 0, bot_wins: 0, bot_losses: 0, matt_day: 0, matt_day_at: 0 });
const dayOf = now => Math.floor(now / DAY);                      // the UTC day number Matt's daily trophies belong to
const mattLeft = (r, now) => (r.matt_day_at === dayOf(now) ? Math.max(0, cfg.mattDay - r.matt_day) : cfg.mattDay);
// ladderTier(ownerId, now) -> { tier, div, trophies, bestTier, bestDiv, dayLeft, row }: the one cheap read for a seat (a missing row is Bronze I, 0, with row false:
// the emblem is shown only for a player who has been paid or charged once, docs/TROPHIES.md 3.9)
const proDiv = r => { if (r.tier === LAD.TOP) r.div = 1; if (r.best_tier === LAD.TOP) r.best_div = 1; return r; };   // a Pro row written before Pro lost its divisions (NOTES 126) reads as plain Pro
const ladderTier = guard(null, (o, now = Date.now()) => { if (!isId(o)) return null; const have = S.ladTier.get(o), r = proDiv({ ...(have || ladZero(o)) });
  return { tier: r.tier, div: r.div, trophies: r.trophies, bestTier: r.best_tier, bestDiv: r.best_div, dayLeft: mattLeft(r, now), row: !!have }; });
// ladderOf(ownerId, now) -> the Profile.ladder shape of RANKED.md 10.1 | null (a missing row = tier 1 zeros, never null for a real owner)
const ladderOf = guard(null, (o, now = Date.now()) => {
  if (!isId(o) || !S.ownerGet.get(o)) return null;
  const have = S.ladGet.get(o), r = proDiv({ ...(have || ladZero(o)) });
  return { trophies: r.trophies, tier: r.tier, div: r.div, floor: LAD.floorOf(r.tier), divFloor: LAD.divFloorOf(r.tier, r.div), next: LAD.nextFloorOf(r.tier), nextDiv: LAD.nextDivFloorOf(r.tier, r.div),
    bestTrophies: r.best_trophies, bestTier: r.best_tier, bestDiv: r.best_div, best_tier: r.best_tier, best_div: r.best_div, bestTierAt: r.best_tier_at,   // best_tier / best_div: the DIVISIONS note's spelling, beside the camelCase of 10.1
    wins: r.wins, losses: r.losses, streak: r.streak, bestStreak: r.best_streak, botWins: r.bot_wins, botLosses: r.bot_losses, mattDayLeft: mattLeft(r, now), row: !!have };      // row: a ladder row exists (false = no trophies yet; the client draws the empty hero, docs/TROPHIES.md 4)
});
// ladderApply({ owner, delta, won, vsBot, seriesId, side, logId, now }) -> { trophies, tier, div, tierWas, divWas, floorHeld, delta (as applied), dayLeft } | null.
// ONE transaction: the trophies (the sticky floors applied), tier, best_*, W/L and streak (vsBot: bot_wins/bot_losses, the day cap and the MATT_CEILING applied
// HERE), and delta_a / delta_b on the game's own match_log row (logId + side; seriesId is history, always null now). null when not open, on a
// failed write, or for an owner that no longer exists (a deleted player mid-game: the other seat is still written by its own call).
const ladderApply = guard(null, o => {
  if (!o || typeof o !== 'object' || !isId(o.owner) || !isNow(o.now) || !Number.isFinite(o.delta)) return null;
  const now = o.now, day = dayOf(now);
  return tx(() => {
    if (!S.ownerGet.get(o.owner)) return null;
    const r = proDiv({ ...(S.ladGet.get(o.owner) || ladZero(o.owner)) });
    if (r.best_tier_at == null) r.best_tier_at = now;             // Bronze was reached with the first row
    if (r.matt_day_at !== day) { r.matt_day = 0; r.matt_day_at = day; }
    const was = r.trophies, tierWas = r.tier, divWas = r.div; let delta = Math.round(o.delta);
    if (o.vsBot) { delta = LAD.mattAward(delta, r.matt_day, cfg.mattDay, r.trophies); r.matt_day += delta; if (o.won) r.bot_wins++; else r.bot_losses++; }
    else if (o.won) { r.wins++; r.streak++; r.best_streak = Math.max(r.best_streak, r.streak); }
    else { r.losses++; r.streak = 0; }
    const raw = r.trophies + delta, t = LAD.applyFloor(r.best_tier, raw);   // the sticky floor (5.2): held = the count would have gone under it
    r.trophies = t; r.tier = LAD.tierOf(t); r.div = LAD.divOf(t, r.tier); if (t > r.best_trophies) r.best_trophies = t;
    if (r.tier > r.best_tier) { r.best_tier = r.tier; r.best_div = r.div; r.best_tier_at = now; } else if (r.tier === r.best_tier && r.div > r.best_div) r.best_div = r.div;
    S.ladPut.run(o.owner, r.trophies, r.tier, r.div, r.best_trophies, r.best_tier, r.best_div, r.best_tier_at, r.wins, r.losses, r.streak, r.best_streak, r.bot_wins, r.bot_losses, r.matt_day, r.matt_day_at, now);
    S.ownerTouch.run(now, o.owner);
    const sid = Number.isSafeInteger(o.seriesId) && o.seriesId > 0 ? o.seriesId : null, lid = isId(o.logId) ? o.logId : null;
    if (sid != null || lid != null) {                            // the change on the requester's side of the rows it belongs to (the export shows it as trophyDelta)
      if (o.side === 0) S.logDeltaA.run(t - was, o.owner, sid, lid); else if (o.side === 1) S.logDeltaB.run(t - was, o.owner, sid, lid);
      else { S.logDeltaA.run(t - was, o.owner, sid, lid); S.logDeltaB.run(t - was, o.owner, sid, lid); }   // a Matt game: whichever side the human sat on
    }
    return { trophies: t, tier: r.tier, div: r.div, tierWas, divWas, floorHeld: t > raw, delta: t - was, dayLeft: Math.max(0, cfg.mattDay - r.matt_day) };
  });
});

// Anti-abuse history (5.2), all from match_log. "o won" = (owner_a = o AND winner = 0) OR (owner_b = o AND winner = 1).
const recentPairs = guard(0, (a, b, since, series = null) => isId(a) && isId(b) ? S.pairs.get(since, a, b, b, a, isId(series) ? series : -1).n : 0);   // R10: ranked human matches between the two, either way (old series rows count once); series: history, null
const recentLosses = guard({ losses: 0, wins: 0, topTwoShare: 0 }, (o, since) => {   // R11: over ALL human results, ranked or not
  if (!isId(o)) return { losses: 0, wins: 0, topTwoShare: 0 };
  let losses = 0, wins = 0; const by = new Map();
  for (const r of S.humanOf.all(since, o, o)) {
    const side = r.owner_a === o ? 0 : 1;
    if (r.winner === side) wins++;
    else { losses++; const w = side === 0 ? r.owner_b : r.owner_a; if (w != null) by.set(w, (by.get(w) || 0) + 1); }   // an anonymous winner is nobody's feeder target
  }
  const top = [...by.values()].sort((x, y) => y - x); const two = (top[0] || 0) + (top[1] || 0);
  return { losses, wins, topTwoShare: losses ? two / losses : 0 };
});
const recentWins = guard(0, (o, since) => isId(o) ? S.winsOf.get(since, o, o).n : 0);   // R12
const oneWay = guard({ aOverB: 0, bOverA: 0 }, (a, b, since, series = null) => { const x = isId(series) ? series : -1; return isId(a) && isId(b) ? { aOverB: S.winsOver.get(since, a, b, a, b, x).n, bOverA: S.winsOver.get(since, b, a, b, a, x).n } : { aOverB: 0, bOverA: 0 }; });   // R11b; series: the one in progress, not counted
const established = guard(false, (o, now) => { if (!isId(o)) return false; const w = S.ownerGet.get(o), p = S.profGet.get(o); return !!w && (now - w.created_at >= DAY || (!!p && p.played >= 3)); });   // R11c

// profileOf(ownerId) -> the Profile shape of section 8.2 | null.
function levelRow(o, lv) { const b = S.botGet.get(o, lv); return { level: lv, name: LEVEL_NAME[lv], wins: b ? b.wins : 0, losses: b ? b.losses : 0, abandons: b ? b.abandons : 0,
  streak: b ? b.streak : 0, bestStreak: b ? b.best_streak : 0, firstWinAt: b ? b.first_win_at : null, bestMargin: b ? b.best_margin : 0 }; }
function expiresOf(w, p) { return w.kind === 'device' ? w.touched_at + (p.played <= 1 ? cfg.guestOneDays : cfg.guestDays) * DAY : null; }
const profileOf = guard(null, (o, now = Date.now()) => {
  if (!isId(o)) return null;
  const w = S.ownerGet.get(o), p = S.profGet.get(o); if (!w || !p) return null;
  return { guest: w.kind === 'device', since: w.created_at, expiresAt: expiresOf(w, p), played: p.played,
    human: { wins: p.h_wins, losses: p.h_losses, streak: p.h_streak, bestStreak: p.h_best_streak, pointsWon: p.h_points_won, pointsLost: p.h_points_lost },
    titles: p.tour_titles, matt: BOT_ORDER.map(lv => levelRow(o, lv)),   // four rungs, easiest first: Rookie, Club, Tour, Pro (every Tour result, tournaments and warm-ups included, is the Tour rung)
    bests: { rally: { v: p.best_rally, at: p.best_rally_at }, hit: { v: p.best_hit, at: p.best_hit_at }, speed: { v: p.best_speed, at: p.best_speed_at } },
    play: { hits: p.hits || 0, returns: p.returns || 0, chances: p.chances || 0, winners: p.winners || 0, aces: p.aces || 0, smashes: p.smashes || 0,   // every match kind (docs/SHARE.md 1)
      pointsWon: p.pts_won || 0, pointsLost: p.pts_lost || 0, secs: p.secs_played || 0 },
    ladder: ladderOf(o, now) };                                   // the trophy ladder (docs/TROPHIES.md): tier 1 zeros until a game pays or charges trophies
});
// exportOf(ownerId, now?) -> the section 10.6 export object | null. Matches from the requester's side, opponents never identified.
const SHARE_URL = 'https://poddleball.com/c/';                   // a share link's public address (server/share.js makes it; locally the page answers on the test host)
const NOTES = 'This file contains all personal information that Poddle holds about this profile, except the records kept only so that a declined friend request or a removal stays silent (described in the privacy policy). Opponents in matches are shown only as Matt or a player; friends and friend requests are listed by username. We do not store your IP address, your email address or names typed as a guest. The purposes, recipients and retention periods are described at https://poddleball.com/privacy.html.';
const exportOf = guard(null, (o, now = Date.now()) => {
  const prof = profileOf(o); if (!prof) return null;
  const w = S.ownerGet.get(o), a = w.kind === 'account' ? S.acctByOwner.get(o) : null, d = w.kind === 'device' ? S.devOfOwner.get(o) : null;
  const matches = S.logOf.all(o, o, 0).map(r => {                  // every row that still names this owner, whatever its age (the sweep may not have run yet)
    const side = r.owner_a === o ? 0 : 1, bot = r.kind === 'bot' || r.kind === 'tourbot';
    const result = r.winner === side ? 'win' : r.winner === 1 - side ? 'loss' : r.ending === 'left' ? 'loss' : 'abandoned';
    return { at: iso(r.at), kind: r.kind, mode: r.mode, mattLevel: bot && r.bot_level != null ? LEVEL_NAME[r.bot_level] : null, result, score: side ? [r.score_b, r.score_a] : [r.score_a, r.score_b],
      ending: r.ending, counted: r.ranked === 1, reasons: r.flags ? r.flags.split(',') : [], secs: r.secs, trophyDelta: side ? r.delta_b : r.delta_a };   // mode / trophyDelta: RANKED.md 10.1 (export format 2)
  });
  const x = { format: 'poddle-export-2', exportedAt: iso(now), kind: a ? 'account' : 'guest', account: null, device: null, profile: prof, matches, notes: NOTES };
  const sh = S.shareGet.get(o); x.share = sh ? { url: SHARE_URL + sh.slug, created: iso(sh.created_at) } : null;   // the public card link, if one is live
  if (a) {
    x.account = { username: a.username, created: iso(a.created_at), renamed: iso(a.renamed_at), lastActivity: iso(w.touched_at), merges: a.merges, google: 'linked', googleSubject: a.google_sub,
      globalLeaderboard: a.lb_hidden === 1 ? 'hidden' : 'shown' };   // NOTES 126: the Show me on the global leaderboard switch
    x.sessions = S.sesOfAcct.all(a.id).map(s => ({ created: iso(s.created_at), expires: iso(s.expires_at), lastUsed: iso(s.seen_at) }));
    x.mergedDevices = S.devsOfAcct.all(a.id).map(v => ({ created: iso(v.created_at), merged: iso(v.merged_at) }));
    x.friends = S.exFriends.all(a.id, a.id).map(r => ({ username: r.name, since: iso(r.since) }));   // docs/SOCIAL.md 2: by username, never an id; unswept expired requests too (they still name this account)
    const c = cutOf(now), rin = S.exReqIn.all(a.id).filter(r => !((r.at != null ? r.at : r.declined_at) <= c && r.live > c));   // asked_at NULL: a block my own removal wrote (docs/SOCIAL.md 3), not a
    // request anyone sent me. A row past its own 30 days that lives on only because the other side re-sent it is left out: listing it would tell of the re-send
    x.friendRequests = { received: rin.filter(r => r.at != null).map(r => ({ username: r.name, when: iso(r.at), declined: iso(r.declined_at) })), sent: S.exReqOut.all(a.id).map(r => ({ username: r.name, when: iso(r.at) })),
      removed: rin.filter(r => r.at == null).map(r => ({ username: r.name, when: iso(r.declined_at) })) };   // removed: whom I removed in the last 30 days (their requests reach me again after)
  } else x.device = { created: iso(d ? d.created_at : w.created_at), lastPlayed: iso(w.touched_at), deletedAfter: iso(prof.expiresAt) };
  return x;
});

// Share links (docs/SHARE.md 2; server/share.js makes the slug). One per owner; deleteOwner and the sweeps take it through the cascade.
// shareOf(ownerId) -> { slug, createdAt } | null. shareOwner(slug) -> owner id | null. shareMake(ownerId, slug, now) -> 'made' | 'have' (the owner
// already has one: shareOf reads it) | 'taken' (the slug belongs to someone else: make another) | null. shareDrop(ownerId) -> true when a row went.
const SLUG_RE = /^[A-Za-z0-9]{10}$/;
const shareOf = guard(null, o => { if (!isId(o)) return null; const r = S.shareGet.get(o); return r ? { slug: r.slug, createdAt: r.created_at } : null; });
const shareOwner = guard(null, slug => { if (typeof slug !== 'string' || !SLUG_RE.test(slug)) return null; const r = S.shareBySlug.get(slug); return r ? r.owner_id : null; });
const shareMake = guard(null, (o, slug, now) => {
  if (!isId(o) || typeof slug !== 'string' || !SLUG_RE.test(slug) || !isNow(now)) return null;
  return tx(() => { if (!S.ownerGet.get(o)) return null; const had = S.shareGet.get(o); if (had) return 'have';
    S.shareIns.run(o, slug, now); const r = S.shareGet.get(o); return !r ? 'taken' : r.slug === slug ? 'made' : 'have'; });
});
const shareDrop = guard(false, o => isId(o) && tx(() => S.shareDel.run(o).changes > 0));
const usernameOf = guard(null, o => { if (!isId(o)) return null; const a = S.acctByOwner.get(o); return a && a.username ? a.username : null; });   // the account's username, null for a guest or an account without one

// ---- the global leaderboards (NOTES 126) ----
// leaderboard(board, limit) -> { board, rows: [{ rank, name, v, tier, div }], total } | null. rank: 1 + everyone listed above (a tie shares its number).
// Never an owner id: a row is what any visitor may see. tier/div: the rank emblem, null for a player with no trophies yet (no ladder row)
const leaderboard = guard(null, (b, limit = LB_MAX) => {
  if (!Object.prototype.hasOwnProperty.call(BOARDS, b)) return null;
  const n = Math.max(1, Math.min(LB_MAX, Math.floor(Number(limit)) || LB_MAX)), rows = [];
  let prev = null, rank = 0;
  S['lbTop_' + b].all(n).forEach((r, i) => { if (r.v !== prev) { rank = i + 1; prev = r.v; } rows.push({ rank, name: r.name, v: r.v, tier: r.tier == null ? null : r.tier, div: r.div == null ? null : r.tier === LAD.TOP ? 1 : r.div }); });
  return { board: b, rows, total: S['lbCount_' + b].get().n };
});
// leaderPlaces(ownerId, evenHidden?) -> { listed, why, hidden, trophies, rally, streak } | null. listed false: why 'guest' | 'noname' | 'hidden' and no places.
// Each place is { rank, v } on the same population and order as leaderboard(), or null under the board's minimum. evenHidden: a hidden account's places anyway
// (still listed false, why 'hidden'): where it would stand among the listed ones, for the profile card of a friend or its own (docs/SOCIAL.md 3)
const leaderPlaces = guard(null, (o, evenHidden = false) => {
  if (!isId(o)) return null;
  const w = S.ownerGet.get(o); if (!w) return null;
  const out = { listed: false, why: null, hidden: false, trophies: null, rally: null, streak: null };
  if (w.kind !== 'account') { out.why = 'guest'; return out; }
  const r = S.lbMe.get(o); if (!r) return null;
  out.hidden = r.lb_hidden === 1;
  if (!r.username) { out.why = 'noname'; return out; }
  if (out.hidden) { out.why = 'hidden'; if (!evenHidden) return out; } else out.listed = true;
  const v = { trophies: r.trophies || 0, rally: r.best_rally || 0, streak: r.h_best_streak || 0 };
  for (const b of Object.keys(BOARDS)) if (v[b] >= BOARDS[b].min) out[b] = { rank: S['lbAbove_' + b].get(v[b]).n + 1, v: v[b] };
  return out;
});
// leaderOwnerByKey(key) -> { owner, name, ranked } for an account on at least one board, at any place (the leaderboard profile, NOTES 140; every
// listed player since NOTES 141, not only the top 100); null for nobody (unknown key, no username, hidden, on no board yet); undefined when the
// database is closed or the read threw (the route says 503)
const leaderOwnerByKey = guard(undefined, key => {
  if (typeof key !== 'string' || !key || key.length > 64) return null;
  const r = S.lbKey.get(key); if (!r || !r.username || r.lb_hidden === 1) return null;
  const v = { trophies: r.trophies || 0, rally: r.best_rally || 0, streak: r.h_best_streak || 0 };
  const on = Object.keys(BOARDS).some(b => (b !== 'trophies' || r.ranked) && v[b] >= BOARDS[b].min);   // trophies: FROM ladder, so never without a ladder row
  return on ? { owner: r.owner_id, name: r.username, ranked: !!r.ranked } : null;
});
// leaderHide(ownerId, hidden) -> true when the account's switch was written (a guest has no switch: false)
const leaderHide = guard(false, (o, hidden) => isId(o) && S.lbHide.run(hidden ? 1 : 0, o).changes > 0);

// ---- friends (docs/SOCIAL.md 2-3) ----
// Account ids in (the caller finds a typed name by its key), usernames out: a row the wire may carry never holds an id, except friendsOf's `id` (game.js
// needs it for presence; api.js strips it). Only accounts WITH a username take part. `now` decides expiry on every read: the sweep only tidies after it
const REQ_MS = REQ_DAYS * DAY, FR_OPS = new Set(['add', 'accept', 'decline', 'cancel', 'remove']);
const pairOf = (x, y) => (x < y ? [x, y] : [y, x]);              // one row per pair, a < b (the CHECK)
const cutOf = now => now - REQ_MS;                               // a request created at or before this has expired, whatever the sweep did yet
const isFriend = (x, y) => !!S.frGet.get(...pairOf(x, y));
const nFriends = x => S.frCount.get(x, x).n;
const rankOf = (tier, div) => (tier == null ? null : { tier, div: tier === LAD.TOP ? 1 : div });   // null: no trophies yet (no ladder row). Pro has no divisions (NOTES 126)
function relOf(me, o, now) {                                     // me's view of o: friend | out (my request, pending or silently declined) | in (theirs, pending) | none
  if (isFriend(me, o)) return 'friend';
  const c = cutOf(now), mine = S.reqGet.get(me, o, c); if (mine && mine.sent) return 'out';
  const theirs = S.reqGet.get(o, me, c); return theirs && theirs.sent && theirs.declined_at == null ? 'in' : 'none';
}
// friendOp(me, other, op, now) -> { r, rel, other } | { err } | null (not open / a failed write). op add | accept | decline | cancel | remove (3), ONE transaction.
// r: requested | friends | declined | cancelled | removed; err: self | username (me has none) | notfound | full | limit | norequest. cancel / remove with
// nothing to act on answer as done (idempotent). A declined request, and a removal's block, answer an add exactly as a fresh one would ('full' / 'limit'
// first, then 'requested', its 'at' now and 30 days to live): the sender can never tell a silent decline from a pending request. Adding someone whose own
// request to me is out (pending, or declined by me) accepts it, as a pending one would: its sender never learns it was declined. Not a re-add my removal
// blocked (asked_at NULL): that goes, and a normal request is sent, exactly as when they never tried (the remover must not learn of the attempt, 3)
// other: true when the other side's own lists changed, so the caller pushes them a snapshot ONLY then (a push after a silent decline or a blocked re-add
// would tell by its timing alone)
const friendOp = guard(null, (me, o, op, now) => {
  if (!isId(me) || !isId(o) || !isNow(now) || !FR_OPS.has(op)) return null;
  if (me === o) return { err: 'self' };
  return tx(() => {
    const A = S.acctFresh.get(me), B = S.acctFresh.get(o);
    if (!A || !A.username) return { err: 'username' };
    if (!B || !B.username) return { err: 'notfound' };
    const c = cutOf(now), mine = S.reqGet.get(me, o, c), theirs = S.reqGet.get(o, me, c), friends = isFriend(me, o);
    const done = (r, other = false) => ({ r, rel: relOf(me, o, now), other });
    const full = () => nFriends(me) >= cfg.friendMax || nFriends(o) >= cfg.friendMax;
    const befriend = () => { S.frIns.run(...pairOf(me, o), now); S.reqDel.run(me, o); S.reqDel.run(o, me); };   // both directions' rows go: a friendship carries no request
    const pending = theirs && theirs.sent && theirs.declined_at == null;
    if (op === 'add') {
      if (friends) return done('friends');
      if (theirs && theirs.sent && theirs.asked_at != null) { if (full()) return { err: 'full' }; befriend(); return done('friends', true); }   // they asked (still out on their side, even if I declined it): adding them is accepting
      if (mine && mine.sent) return done('requested');          // already out (pending, or declined silently): nothing changes
      if (full()) return { err: 'full' };
      if (S.reqOutN.get(me, c).n >= cfg.reqOutMax) return { err: 'limit' };
      if (mine) { S.reqResend.run(now, me, o); return done('requested'); }   // cancelled after a decline, or a removal's block, not expired: 'requested' as if sent (at now, as a fresh one), nothing reaches the other side
      if (theirs) S.reqDel.run(o, me);                            // a declined one they withdrew, or the block my removal wrote (re-added on their side or not): adding them back clears it (3)
      S.reqPut.run(me, o, now, null, now, 1); return done('requested', true);   // an upsert: my own expired row (still unswept) becomes a fresh request
    }
    if (op === 'accept') { if (!pending) return { err: 'norequest' }; if (full()) return { err: 'full' }; befriend(); return done('friends', true); }
    if (op === 'decline') { if (!pending) return { err: 'norequest' }; S.reqDecline.run(now, o, me, c); return done('declined'); }   // silent: kept until it expires, so it cannot be re-sent
    if (op === 'cancel') { const live = !!mine && !!mine.sent && mine.declined_at == null; if (live) S.reqDel.run(me, o); else if (mine && mine.sent) S.reqSent.run(0, me, o); return done('cancelled', live); }   // a declined one stays as a block (3), just no longer shown to me
    if (friends) { S.frDel.run(...pairOf(me, o)); S.reqDel.run(me, o); S.reqPut.run(o, me, now, now, null, 0); }   // remove: silent, and the removed person's re-adds answer 'requested' for 30 days (3)
    return done('removed', friends);
  });
});
// friendsOf(accountId, now) -> { friends: [{ id, name, since, rank }], inc: [{ name, at }], out: [{ name, at }] } | null. inc: pending, newest INC_MAX;
// out: every request its sender still sees (a silently declined one included). friends unsorted: the caller orders by presence
const friendsOf = guard(null, (me, now) => {
  if (!isId(me) || !isNow(now)) return null;
  const c = cutOf(now);
  return { friends: S.frList.all(me, me).map(r => ({ id: r.id, name: r.name, since: r.since, rank: rankOf(r.tier, r.div) })),
    inc: S.reqIn.all(me, c).map(r => ({ name: r.name, at: r.at })), out: S.reqOut.all(me, c).map(r => ({ name: r.name, at: r.at })) };
});
const friendIds = guard(null, me => (isId(me) ? S.frIds.all(me, me).map(r => r.id) : []));   // presence: whom a status change is pushed to. null: the read failed (not 'no friends': game.js must not cache it)
// friendPeers(accountId, now) -> account ids whose request lists show this account (a rename or a delete changes what they see) | null (a failed read)
const friendPeers = guard(null, (me, now) => { if (!isId(me) || !isNow(now)) return []; const c = cutOf(now); return S.reqPeers.all(me, c, me, c).map(r => r.id); });
const friendRel = guard('none', (me, o, now) => (isId(me) && isId(o) && me !== o && isNow(now) ? relOf(me, o, now) : 'none'));
// friendSearch(me, like, key, now) -> [{ name, rel }] | null. like: an escaped LIKE prefix pattern ('ab%'), key: the confusable key (usernames.skeleton), both from api.js
const friendSearch = guard(null, (me, like, key, now) => {
  if (!isId(me) || !isNow(now) || typeof like !== 'string' || typeof key !== 'string' || like.length > 40 || key.length > 64) return null;
  return S.frSearch.all(me, like, key, key).map(r => ({ name: r.name, rel: relOf(me, r.id, now) }));
});
// accountFresh(accountId, ownerId?) -> { id, ownerId, username } | false (gone, or the id now belongs to another owner) | null (not open / an error: UNKNOWN,
// so a caller never signs anyone out on it). game.js checks a socket's account with it: admin.js deletes and renames from another process, and ids can be reused
const accountFresh = guard(null, (id, owner) => { if (!isId(id)) return false; const r = S.acctFresh.get(id);
  return r && (owner == null || r.owner_id === owner) ? { id: r.id, ownerId: r.owner_id, username: r.username } : false; });
// playerByKey(key) -> { id, ownerId, name, hidden, rank } | null: the profile card's account (/api/player) (a username only), rank {tier, div} | null when never ranked
const playerByKey = guard(null, key => {
  if (typeof key !== 'string' || !key.length || key.length > 64) return null;
  const k = S.acctByKey.get(key), a = k && S.acctFresh.get(k.id); if (!a || !a.username) return null;
  const L = S.ladTier.get(a.owner_id);
  return { id: a.id, ownerId: a.owner_id, name: a.username, hidden: a.lb_hidden === 1, rank: L ? rankOf(L.tier, L.div) : null };
});

// deleteOwner(ownerId, now) -> true when something was deleted. Cascades (profile, bot_record, device/account, sessions, merged device rows),
// nulls match_log, holds an account's username key for 90 days, then checkpoints the WAL (10.6; secure_delete zeroes the rows).
function dropOwner(o, key, now) { if (key) S.holdPut.run(key, now + HOLD_DELETE_DAYS * DAY); return S.ownerDel.run(o).changes > 0; }
const deleteOwner = guard(false, (o, now) => {
  if (!isId(o) || !isNow(now)) return false;
  const gone = tx(() => { const a = S.acctByOwner.get(o); return dropOwner(o, a && a.username_key, now); });
  try { checkpoint(); } catch (e) { fail(e); }
  return gone;
});

// resetStats(ownerId, now) -> true when the owner exists. The operator's reset (admin.js reset-stats, the owner's own request): the profile row
// back to a fresh one, the Matt record and the trophy ladder gone, the owner unlinked from match_log (so R10/R11 history starts again);
// the owner, account, username, devices, sessions and any share link stay
const resetStats = guard(false, (o, now) => {
  if (!isId(o) || !isNow(now)) return false;
  return tx(() => {
    if (!D.prepare('SELECT 1 FROM owners WHERE id = ?').get(o)) return false;
    for (const t of ['bot_record', 'ladder', 'profile']) D.prepare(`DELETE FROM ${t} WHERE owner_id = ?`).run(o);
    D.prepare('UPDATE match_log SET owner_a = NULL WHERE owner_a = ?').run(o); D.prepare('UPDATE match_log SET owner_b = NULL WHERE owner_b = ?').run(o);
    S.profIns.run(o, now); return true;
  });
});

// claimUsername(accountId, name, key, now) -> 'ok' | 'taken' | 'held' | 'cooldown' (7.4). name and key come from usernames.validate().
// One BEGIN IMMEDIATE: cooldown, holds, the old key's 30-day hold and the UPDATE; a concurrent claim loses on the UNIQUE index -> 'taken'.
// opts.admin (admin.js rename): no cooldown or hold check, and renamed_at is cleared so the player may pick their own name at once.
function claim(acct, name, key, now, admin) {
  if (!isId(acct) || !isNow(now) || typeof name !== 'string' || typeof key !== 'string' || !name || !key || name.length > 64 || key.length > 64) return null;
  try {
    return tx(() => {
      const a = S.acctById.get(acct); if (!a) return null;
      if (a.username === name) return 'ok';
      if (!admin && a.username != null && a.renamed_at != null && now - a.renamed_at < cfg.renameDays * DAY) return 'cooldown';
      const other = S.acctByKey.get(key);
      if (other && other.id !== acct) return 'taken';
      if (!admin && a.username_key !== key && S.holdGet.get(key, now)) return 'held';
      if (a.username_key && a.username_key !== key) S.holdPut.run(a.username_key, now + HOLD_RENAME_DAYS * DAY);
      if (admin) S.holdDel.run(key);
      S.acctName.run(name, key, admin ? null : now, acct);
      return 'ok';
    });
  } catch (e) { if (e && (e.errcode & 0xff) === 19) return 'taken'; throw e; }
}
const claimUsername = guard(null, (acct, name, key, now) => claim(acct, name, key, now, false));
const adminRename = guard(null, (acct, name, key, now) => claim(acct, name, key, now, true));   // addition for admin.js rename
const releaseHold = guard(false, key => typeof key === 'string' && S.holdDel.run(key).changes > 0);   // addition for admin.js release

// sweep(now) -> Promise<counts | null>, never rejects (an unhandled rejection ends the process in Node 24). Retention of 10.5 in batches of
// 500, one short transaction each, setImmediate between them so the 60 Hz loop never stalls; ends with a WAL checkpoint and the backup files.
async function sweep(now) {
  if (!D || sweeping) return null;
  sweeping = true;
  const n = { guests: 0, accounts: 0, sessions: 0, matches: 0, holds: 0, friendreqs: 0, files: 0 };
  const yieldNow = () => new Promise(r => setImmediate(r));
  const batches = async (key, step) => { for (;;) { if (!D) return; const k = tx(step); n[key] += k; if (k < BATCH) return; await yieldNow(); } };
  try {
    const t = Math.floor(Number(now)); if (!Number.isSafeInteger(t)) return null;
    await batches('guests', () => Number(S.swGuests.run(t - cfg.guestDays * DAY, t - cfg.guestOneDays * DAY).changes));
    await batches('accounts', () => { const rows = S.swIdle.all(t - ACCOUNT_IDLE_DAYS * DAY); for (const r of rows) dropOwner(r.id, r.username_key, t); return rows.length; });
    await batches('sessions', () => Number(S.swSessions.run(t).changes));
    await batches('matches', () => Number(S.swLog.run(t - cfg.logDays * DAY).changes));
    await batches('matches', () => nearFull() ? Number(S.swOldest.run(BATCH).changes) : 0);   // still near the size cap: the oldest rows go, whatever their age
    await batches('holds', () => Number(S.swHolds.run(t).changes));
    await batches('friendreqs', () => Number(S.swReqs.run(t - REQ_MS).changes));   // docs/SOCIAL.md 2: 30 days after created, declined or not (friendships go with an account, by the cascade)
    if (!D) return null;
    checkpoint();
    if (file) n.files = cleanBackups(t, path.dirname(file));      // memory databases (every test) never touch the disk
    return n;
  } catch (e) { fail(e); return null; }
  finally { sweeping = false; }
}
function cleanBackups(now, dir) {                                // 11.6: /tmp/poddle-backup-*.db older than a day, and any backup-*.db beside the database
  let k = 0;
  const rm = (d, re, older) => { let names = []; try { names = fs.readdirSync(d); } catch { return; }
    for (const f of names) { if (!re.test(f)) continue; const p = path.join(d, f);
      try { const st = fs.lstatSync(p); if (st.isFile() && now - st.mtimeMs >= older) { fs.unlinkSync(p); k++; } } catch { /* raced or not ours */ } } };
  rm('/tmp', /^poddle-backup-[0-9-]+\.db$/, DAY);
  rm(dir, /^backup-.*\.db$/, 0);
  return k;
}

// Operator helpers for admin.js (additions, never reachable over HTTP).
const TABLES = ['owners', 'devices', 'accounts', 'sessions', 'name_holds', 'profile', 'bot_record', 'match_log', 'ladder', 'share', 'friends', 'friend_reqs'];
const counts = guard(null, () => Object.fromEntries(TABLES.map(t => [t, D.prepare('SELECT count(*) AS n FROM ' + t).get().n])));   // table names are literals from TABLES
const vacuumInto = guard(false, out => { if (typeof out !== 'string' || !/^\/tmp\/poddle-backup-\d{8}-\d{4}\.db$/.test(out)) return false; D.prepare('VACUUM INTO ?').run(out); return true; });

const ladderRecomputed = () => recomputed;                       // rows the last open()'s tier recompute rewrote (NOTES 124; 0 on every open after the first)
module.exports = { resetStats, open, close, isOpen, ok, nearFull, ownerForDevice, guestOwner, accountByDevice, accountBySub, accountById, accountByKey, createAccount, mergeDevice,
  session, recordMatch, addTitle, profileOf, exportOf, deleteOwner, claimUsername, adminRename, releaseHold, recentPairs, recentLosses, recentWins, oneWay,
  established, ownerExists, deviceCount, sweep, counts, vacuumInto, hash: sha256, LEVEL_NAME, ladderOf, ladderTier, ladderApply, shareOf, shareOwner, shareMake, shareDrop, usernameOf,
  leaderboard, leaderPlaces, leaderHide, leaderOwnerByKey, BOARDS: Object.keys(BOARDS), ladderRecomputed, friendOp, friendsOf, friendIds, friendPeers, friendRel, friendSearch, accountFresh, playerByKey };
