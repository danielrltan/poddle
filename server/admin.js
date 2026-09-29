// Operator CLI for the stats database (docs/ACCOUNTS.md 11.7). Never reachable over HTTP: nothing requires it, it has no routes, and
// requiring it does nothing. Run on the machine: fly ssh console -C "node server/admin.js <cmd>" (PODDLE_DB is set there by fly.toml).
//   counts                      rows per table (numbers only; friends and friend_reqs included, docs/SOCIAL.md 2)
//   rename <username> <new>     operator rename of an offensive name; clears renamed_at so the player may choose their own at once
//   release <username>          drop a name hold
//   reset-stats <username>      the account's own stats, Matt record and Ranked ladder back to zero (the owner's request); the account stays
//   delete-account <username>   OPERATOR-initiated only: an under-13 report (6.5) or a Terms breach. Never on an e-mailed username alone (8.1)
//   backup [--clean]            VACUUM INTO /tmp/poddle-backup-YYYYMMDD-HHMM.db (outside /data: never in a volume snapshot, 11.6); --clean deletes them
//   sweep                       the retention sweep of 10.5, now
//   unshare <link or code>      stop one share link (docs/SHARE.md 2): a request by e-mail that sends the link itself (holding the link is all
//                               the link grants, so no proof of ownership is needed to stop it), or a link the Terms let us disable
//   unshare-user <username>     stop the share link of that account (an offensive username on a card: Terms 5)
// Output never carries a Google subject, a device hash or an account id.
const fs = require('node:fs'), path = require('node:path');
const db = require('./db');

const USAGE = 'usage: node server/admin.js counts | rename <username> <new> | release <username> | reset-stats <username> | delete-account <username> | backup [--clean] | sweep | unshare <link or code> | unshare-user <username>';
function names() {                                               // usernames.js (7.1-7.2) is loaded only by the commands that need it
  try { return require('./usernames'); } catch { throw new Error('server/usernames.js is not available'); }
}
function keyOf(name) {                                           // the skeleton decides who a typed username is, whatever its case or look-alikes
  const u = names(), s = String(name || '').normalize('NFKC');
  if (typeof u.skeleton === 'function') return u.skeleton(s);
  const v = u.validate(s); if (v && v.key) return v.key;
  throw new Error('cannot compute the username key');
}
function find(name) { const a = db.accountByKey(keyOf(name)); if (!a) throw new Error('no account with that username'); return a; }
const slugIn = s => { const m = /(?:^|\/c\/)([A-Za-z0-9]{10})(?:\.png)?(?:[?#].*)?$/.exec(String(s || '').trim()); return m ? m[1] : null; };   // the code alone, or any form of the link (poddleball.com/c/<code>, .png, ?v=)
const stamp = d => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);   // YYYYMMDD-HHMM, UTC

async function main(argv) {
  const [cmd, a1, a2] = argv;
  if (!cmd || !['counts', 'rename', 'release', 'reset-stats', 'delete-account', 'backup', 'sweep', 'unshare', 'unshare-user'].includes(cmd)) throw new Error(USAGE);
  if (cmd === 'backup' && a1 === '--clean') {                    // needs no database: deletes the /tmp copies after they were downloaded
    let k = 0; for (const f of fs.readdirSync('/tmp')) if (/^poddle-backup-[0-9-]+\.db$/.test(f)) { const p = path.join('/tmp', f); if (fs.lstatSync(p).isFile()) { fs.unlinkSync(p); k++; } }
    return console.log('removed ' + k + ' backup file(s)');
  }
  const where = process.env.PODDLE_DB;
  if (!where || where === ':memory:') throw new Error('PODDLE_DB is not set (a memory database has nothing to administer)');
  if (!fs.existsSync(where)) throw new Error('no database at PODDLE_DB');   // never create a fresh database by accident (11.4)
  if (!db.open(where, { busyMs: 5000 })) throw new Error('database unavailable');   // the server holds the same file: wait for its short writes
  try {
    const now = Date.now();
    if (cmd === 'counts') { const c = db.counts(); if (!c) throw new Error('count failed'); for (const [t, n] of Object.entries(c)) console.log(t.padEnd(11) + ' ' + n); return; }
    if (cmd === 'sweep') { const n = await db.sweep(now); if (!n) throw new Error('sweep failed'); return console.log(JSON.stringify(n)); }
    if (cmd === 'backup') { const out = '/tmp/poddle-backup-' + stamp(new Date(now)) + '.db'; if (fs.existsSync(out)) throw new Error('a backup from this minute exists');
      if (!db.vacuumInto(out)) throw new Error('backup failed'); fs.chmodSync(out, 0o600);
      return console.log('wrote ' + out + ' (download it, then run: node server/admin.js backup --clean; delete any copy within 5 days, and note it in NOTES)'); }
    if (!a1) throw new Error(USAGE);
    if (cmd === 'unshare') {                                     // the running server's in-memory card pictures are never served for a dead link (share.page checks the owner first)
      const slug = slugIn(a1); if (!slug) throw new Error('not a share link or code');
      const o = db.shareOwner(slug); if (o == null) throw new Error('no live link with that code');
      if (!db.shareDrop(o)) throw new Error('unshare failed'); return console.log('removed (the link now answers 404)');
    }
    if (cmd === 'unshare-user') { const a = find(a1); if (!db.shareDrop(a.owner_id)) throw new Error('that account has no live link'); return console.log('removed (the link now answers 404)'); }
    if (cmd === 'release') { if (!db.releaseHold(keyOf(a1))) throw new Error('no hold on that name'); return console.log('released'); }
    if (cmd === 'reset-stats') { const a = find(a1); if (!db.resetStats(a.owner_id, now)) throw new Error('reset failed'); return console.log('reset (profile, Matt record and Ranked ladder cleared; the account, name and sessions stay)'); }
    if (cmd === 'delete-account') {
      const a = find(a1);
      if (!db.deleteOwner(a.owner_id, now)) throw new Error('delete failed');
      // This is a separate process, so it cannot call stats.forget(): a match in progress on the live server finds the owner gone
      // at record time (recordMatch checks every seat's owner inside its transaction, 4.7) and records that seat as no owner. Its friendships and
      // requests go by the cascade; the live server's presence tick finds the account gone within seconds and signs its sockets out (docs/SOCIAL.md 4).
      return console.log('deleted (sessions, stats and merged devices; the name is held for 90 days)');
    }
    if (cmd === 'rename') {
      if (!a2) throw new Error(USAGE);
      const v = names().validate(a2); if (!v || !v.ok) throw new Error('invalid new name (' + (v && v.reason) + ')');
      const a = find(a1), r = db.adminRename(a.id, v.name, v.key, now);
      if (r !== 'ok') throw new Error('rename refused (' + r + ')');
      return console.log('renamed (the old name is held for 30 days; the player may choose another name at once)');
    }
  } finally { db.close(); }
}

if (require.main === module) main(process.argv.slice(2)).then(() => process.exit(0), e => { console.error('admin: ' + (e && e.message || e)); process.exit(1); });
module.exports = { main };
