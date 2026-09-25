// Player stats storage (docs/ACCOUNTS.md section 2): one SQLite file on the Fly volume, one process, one connection.
// A pure data layer: no game knowledge, no clock of its own (every caller passes `now`), no identities in any log line.
// Loading this file does nothing: node:sqlite is required inside open(), so a server with stats off never touches it.
// Every function is a no-op returning null/false (or its documented empty value) while the database is not open, and
// NONE of them throws: endMatch runs inside sim() on the 60 Hz interval, and a throw there ends every room (4.2, 11.4).
// SQL: every value is a bound parameter of a statement prepared once in open(). The only number spliced into SQL text is
// max_page_count (a PRAGMA cannot take a parameter): an operator env value, forced to a clamped integer first.
const crypto = require('node:crypto'), fs = require('node:fs'), path = require('node:path');

const WEB = path.join(__dirname, '..', 'web');                    // served publicly: the database may never live under it (11.1)
const DAY = 24 * 3600e3, HOUR = 3600e3;
const LEVEL_NAME = ['Rookie', 'Club', 'Pro', 'Tour'];             // wire index -> name. The ladder is four rungs in BOT_ORDER (Rookie, Club, Tour, Pro): Tour sits between Club and Pro (operator correction, Q2)
const BOT_ORDER = [0, 1, 3, 2];                                   // BOT_ORDER position -> wire index (server/game.js:142). Tour is easier than Pro
const KINDS = new Set(['bot', 'human', 'tour', 'tourbot']), HUMAN = new Set(['human', 'tour']), ENDINGS = new Set(['won', 'forfeit', 'left', 'dropped']);
const SESSION_DAYS = 180, SESSIONS_MAX = 10, SEEN_EVERY = HOUR;  // 3.3: absolute 180-day expiry, 10 live per account, seen_at at most hourly
const HOLD_RENAME_DAYS = 30, HOLD_DELETE_DAYS = 90;               // 7.4: an old name after a rename, a deleted account's name
const ACCOUNT_IDLE_DAYS = 730;                                    // 10.5 / Q8: no sign-in and no match for 24 months -> deleted
const BATCH = 500;                                                // 10.5: rows per sweep transaction; setImmediate between batches
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
`];

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
    maxMb: intEnv(env, 'DB_MAX_MB', 256, 1, 65536), logCap: intEnv(env, 'LOG_CAP_DAY', 100, 1, 100000) };
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
    botGet: q('SELECT * FROM bot_record WHERE owner_id = ? AND level = ?'),
    botAll: q('SELECT * FROM bot_record WHERE owner_id = ? ORDER BY level'),
    botPut: q(`INSERT INTO bot_record (owner_id, level, wins, losses, abandons, streak, best_streak, first_win_at, best_margin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (owner_id, level) DO UPDATE SET wins = excluded.wins, losses = excluded.losses, abandons = excluded.abandons, streak = excluded.streak,
      best_streak = excluded.best_streak, first_win_at = excluded.first_win_at, best_margin = excluded.best_margin`),
    acctIns: q('INSERT INTO accounts (owner_id, google_sub, created_at) VALUES (?, ?, ?)'),
    acctBySub: q('SELECT id, owner_id, username, renamed_at FROM accounts WHERE google_sub = ?'),
    acctById: q('SELECT id, owner_id, username, username_key, renamed_at, created_at, merges, google_sub FROM accounts WHERE id = ?'),
    acctByOwner: q('SELECT id, owner_id, username, username_key, renamed_at, created_at, merges, google_sub FROM accounts WHERE owner_id = ?'),
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
    logIns: q('INSERT INTO match_log (at, kind, bot_level, owner_a, owner_b, score_a, score_b, winner, ending, ranked, flags, secs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    logMoveA: q('UPDATE match_log SET owner_a = ? WHERE owner_a = ?'),
    logMoveB: q('UPDATE match_log SET owner_b = ? WHERE owner_b = ?'),
    logOf: q('SELECT * FROM match_log WHERE (owner_a = ? OR owner_b = ?) AND at >= ? ORDER BY at'),
    pairs: q(`SELECT count(*) AS n FROM match_log WHERE kind IN ('human','tour') AND ranked = 1 AND at >= ? AND winner IS NOT NULL
      AND ((owner_a = ? AND owner_b = ?) OR (owner_a = ? AND owner_b = ?))`),
    humanOf: q(`SELECT owner_a, owner_b, winner FROM match_log WHERE kind IN ('human','tour') AND winner IS NOT NULL AND at >= ? AND (owner_a = ? OR owner_b = ?)`),
    winsOf: q(`SELECT count(*) AS n FROM match_log WHERE kind IN ('human','tour') AND ranked = 1 AND at >= ? AND ((owner_a = ? AND winner = 0) OR (owner_b = ? AND winner = 1))`),
    winsOver: q(`SELECT count(*) AS n FROM match_log WHERE kind IN ('human','tour') AND ranked = 1 AND at >= ?
      AND ((owner_a = ? AND owner_b = ? AND winner = 0) OR (owner_b = ? AND owner_a = ? AND winner = 1))`),
    // sweep (10.5): rowid batches, one short transaction each
    swGuests: q(`DELETE FROM owners WHERE rowid IN (SELECT o.rowid FROM owners o LEFT JOIN profile p ON p.owner_id = o.id WHERE o.kind = 'device'
      AND (o.touched_at < ? OR (o.touched_at < ? AND coalesce(p.played, 0) <= 1)) LIMIT ${BATCH})`),
    swIdle: q(`SELECT o.id, a.username_key FROM owners o JOIN accounts a ON a.owner_id = o.id WHERE o.kind = 'account' AND o.touched_at < ? LIMIT ${BATCH}`),
    swSessions: q(`DELETE FROM sessions WHERE rowid IN (SELECT rowid FROM sessions WHERE expires_at <= ? LIMIT ${BATCH})`),
    swLog: q(`DELETE FROM match_log WHERE rowid IN (SELECT rowid FROM match_log WHERE at < ? LIMIT ${BATCH})`),
    swOldest: q(`DELETE FROM match_log WHERE rowid IN (SELECT rowid FROM match_log ORDER BY rowid LIMIT ?)`),   // size-aware retention: the oldest rows first, whatever their age
    logDay: q('SELECT count(*) AS n FROM match_log WHERE (owner_a = ? OR owner_b = ?) AND at >= ?'),   // the per-owner daily cap on log rows
    swHolds: q(`DELETE FROM name_holds WHERE rowid IN (SELECT rowid FROM name_holds WHERE until_at <= ? LIMIT ${BATCH})`),
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
  }
  for (const gb of S.botAll.all(g)) {
    const ab = S.botGet.get(a, gb.level) || { wins: 0, losses: 0, abandons: 0, streak: 0, best_streak: 0, first_win_at: null, best_margin: 0 };
    const first = gb.first_win_at == null ? ab.first_win_at : ab.first_win_at == null ? gb.first_win_at : Math.min(gb.first_win_at, ab.first_win_at);
    S.botPut.run(a, gb.level, ab.wins + gb.wins, ab.losses + gb.losses, ab.abandons + gb.abandons, ab.streak, Math.max(ab.best_streak, gb.best_streak), first, Math.max(ab.best_margin, gb.best_margin));
  }
  S.logMoveA.run(a, g); S.logMoveB.run(a, g);                    // the pair caps keep working across the merge
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
//     seats: [ { owner: id|null, record: bool, bests: bool, swingBad?: bool, bestRally, bestHit (0..100), bestSpeed (rad/s) } | null, x2 ] }
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
  if (broken || nearFull()) trimLog();                            // size-aware retention, in its OWN transaction first: a SQLITE_FULL rollback of this match must not undo it, and its success clears `broken`
  return tx(() => {
    const seats = [0, 1].map(i => { const s = m.seats[i]; return s && typeof s === 'object' && isId(s.owner) && S.ownerGet.get(s.owner) ? s : null; });   // ownerExists per seat, inside the transaction
    const out = { logged: false, row: false, capped: false, seats: [{ saved: false }, { saved: false }] };
    if (!seats[0] && !seats[1]) return out;                     // 5.5: no owner, no row
    out.logged = true;
    const quit = bot && (ending === 'left' || ending === 'dropped');   // leaving Matt: bot_record counts it, no log row (one owner could otherwise loop join, strike, leave into the size cap)
    out.capped = !quit && seats.some(s => s && S.logDay.get(s.owner, s.owner, now - DAY).n >= cfg.logCap);   // LOG_CAP_DAY rows per owner a day
    if (!quit && !out.capped) { S.logIns.run(now, kind, level, seats[0] ? seats[0].owner : null, seats[1] ? seats[1].owner : null, sc[0], sc[1], winner, ending, ranked, flags, secs); out.row = true; }
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
      S.ownerTouch.run(now, o);
      out.seats[i] = res;
    }
    return out;
  });
});
function trimLog() { try { tx(() => Number(S.swOldest.run(TRIM).changes)); } catch (e) { fail(e); } }   // the oldest TRIM log rows (a delete goes to the WAL, which max_page_count does not cap)
// addTitle(ownerId, now) -> true when credited (addition: section 4.3 stats.title needs a write for tour_titles; the spec lists none).
const addTitle = guard(false, (o, now) => isId(o) && isNow(now) && tx(() => { const P = S.profGet.get(o); if (!P) return false;
  S.profSet.run(P.played, P.h_wins, P.h_losses, P.h_streak, P.h_best_streak, P.h_points_won, P.h_points_lost, P.tour_titles + 1,
    P.best_rally, P.best_rally_at, P.best_hit, P.best_hit_at, P.best_speed, P.best_speed_at, now, o); S.ownerTouch.run(now, o); return true; }));

// Anti-abuse history (5.2), all from match_log. "o won" = (owner_a = o AND winner = 0) OR (owner_b = o AND winner = 1).
const recentPairs = guard(0, (a, b, since) => isId(a) && isId(b) ? S.pairs.get(since, a, b, b, a).n : 0);   // R10: ranked human results between the two, either way
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
const oneWay = guard({ aOverB: 0, bOverA: 0 }, (a, b, since) => isId(a) && isId(b) ? { aOverB: S.winsOver.get(since, a, b, a, b).n, bOverA: S.winsOver.get(since, b, a, b, a).n } : { aOverB: 0, bOverA: 0 });   // R11b
const established = guard(false, (o, now) => { if (!isId(o)) return false; const w = S.ownerGet.get(o), p = S.profGet.get(o); return !!w && (now - w.created_at >= DAY || (!!p && p.played >= 3)); });   // R11c

// profileOf(ownerId) -> the Profile shape of section 8.2 | null.
function levelRow(o, lv) { const b = S.botGet.get(o, lv); return { level: lv, name: LEVEL_NAME[lv], wins: b ? b.wins : 0, losses: b ? b.losses : 0, abandons: b ? b.abandons : 0,
  streak: b ? b.streak : 0, bestStreak: b ? b.best_streak : 0, firstWinAt: b ? b.first_win_at : null, bestMargin: b ? b.best_margin : 0 }; }
function expiresOf(w, p) { return w.kind === 'device' ? w.touched_at + (p.played <= 1 ? cfg.guestOneDays : cfg.guestDays) * DAY : null; }
const profileOf = guard(null, o => {
  if (!isId(o)) return null;
  const w = S.ownerGet.get(o), p = S.profGet.get(o); if (!w || !p) return null;
  return { guest: w.kind === 'device', since: w.created_at, expiresAt: expiresOf(w, p), played: p.played,
    human: { wins: p.h_wins, losses: p.h_losses, streak: p.h_streak, bestStreak: p.h_best_streak, pointsWon: p.h_points_won, pointsLost: p.h_points_lost },
    titles: p.tour_titles, matt: BOT_ORDER.map(lv => levelRow(o, lv)),   // four rungs, easiest first: Rookie, Club, Tour, Pro (every Tour result, tournaments and warm-ups included, is the Tour rung)
    bests: { rally: { v: p.best_rally, at: p.best_rally_at }, hit: { v: p.best_hit, at: p.best_hit_at }, speed: { v: p.best_speed, at: p.best_speed_at } } };
});
// exportOf(ownerId, now?) -> the section 10.6 export object | null. Matches from the requester's side, opponents never identified.
const NOTES = 'This file contains all personal information that Poddle holds about this profile. Opponents are shown only as Matt or a player. We do not store your IP address, your email address or names typed as a guest. The purposes, recipients and retention periods are described at https://poddleball.com/privacy.html.';
const exportOf = guard(null, (o, now = Date.now()) => {
  const prof = profileOf(o); if (!prof) return null;
  const w = S.ownerGet.get(o), a = w.kind === 'account' ? S.acctByOwner.get(o) : null, d = w.kind === 'device' ? S.devOfOwner.get(o) : null;
  const matches = S.logOf.all(o, o, 0).map(r => {                  // every row that still names this owner, whatever its age (the sweep may not have run yet)
    const side = r.owner_a === o ? 0 : 1, bot = r.kind === 'bot' || r.kind === 'tourbot';
    const result = r.winner === side ? 'win' : r.winner === 1 - side ? 'loss' : r.ending === 'left' ? 'loss' : 'abandoned';
    return { at: iso(r.at), kind: r.kind, mattLevel: bot && r.bot_level != null ? LEVEL_NAME[r.bot_level] : null, result, score: side ? [r.score_b, r.score_a] : [r.score_a, r.score_b],
      ending: r.ending, counted: r.ranked === 1, reasons: r.flags ? r.flags.split(',') : [], secs: r.secs };
  });
  const x = { format: 'poddle-export-1', exportedAt: iso(now), kind: a ? 'account' : 'guest', account: null, device: null, profile: prof, matches, notes: NOTES };
  if (a) {
    x.account = { username: a.username, created: iso(a.created_at), renamed: iso(a.renamed_at), lastActivity: iso(w.touched_at), merges: a.merges, google: 'linked', googleSubject: a.google_sub };
    x.sessions = S.sesOfAcct.all(a.id).map(s => ({ created: iso(s.created_at), expires: iso(s.expires_at), lastUsed: iso(s.seen_at) }));
    x.mergedDevices = S.devsOfAcct.all(a.id).map(v => ({ created: iso(v.created_at), merged: iso(v.merged_at) }));
  } else x.device = { created: iso(d ? d.created_at : w.created_at), lastPlayed: iso(w.touched_at), deletedAfter: iso(prof.expiresAt) };
  return x;
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
  const n = { guests: 0, accounts: 0, sessions: 0, matches: 0, holds: 0, files: 0 };
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
const TABLES = ['owners', 'devices', 'accounts', 'sessions', 'name_holds', 'profile', 'bot_record', 'match_log'];
const counts = guard(null, () => Object.fromEntries(TABLES.map(t => [t, D.prepare('SELECT count(*) AS n FROM ' + t).get().n])));   // table names are literals from TABLES
const vacuumInto = guard(false, out => { if (typeof out !== 'string' || !/^\/tmp\/poddle-backup-\d{8}-\d{4}\.db$/.test(out)) return false; D.prepare('VACUUM INTO ?').run(out); return true; });

module.exports = { open, close, isOpen, ok, nearFull, ownerForDevice, guestOwner, accountByDevice, accountBySub, accountById, accountByKey, createAccount, mergeDevice,
  session, recordMatch, addTitle, profileOf, exportOf, deleteOwner, claimUsername, adminRename, releaseHold, recentPairs, recentLosses, recentWins, oneWay,
  established, ownerExists, deviceCount, sweep, counts, vacuumInto, hash: sha256, LEVEL_NAME };
