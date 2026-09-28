// Download or delete the data Poddle holds for this browser (docs/ACCOUNTS.md 9.7), from the privacy page. The game page and this
// one share an origin, so the guest device id (localStorage) and, for a signed-in player, the session cookie are both at hand.
// Nothing runs until a button is pressed. Classic script: the legal pages load no modules.
(() => {
  const $ = id => document.getElementById(id), DEV_OK = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$|^[0-9a-f]{32}$/;      // the server's own check (3.1)
  const dev = () => { try { const v = localStorage.getItem('poddle.device'); return v && DEV_OK.test(v) ? v : null; } catch { return null; } };
  const say = t => { const s = $('data-status'); if (s) s.textContent = t; };
  const call = (path, method, extra) => fetch(path, { method, credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign(dev() ? { dev: dev() } : {}, extra || {})) });
  async function download() {
    say('Preparing your file.');
    let r; try { r = await call('/api/export', 'POST'); } catch { r = null; }
    if (!r || !r.ok) return say(r && r.status === 404 ? 'Nothing is saved for this browser. If you have an account, sign in to Poddle first, then return here.' : r && r.status === 429 ? 'Too many downloads. Please try again later.' : 'The download is not available right now. Please try again later.');
    const blob = await r.blob(), m = /filename="(poddle-data-[0-9-]{10}\.json)"/.exec(r.headers.get('Content-Disposition') || '');      // only a name of our own shape is used
    const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = m ? m[1] : 'poddle-data.json'; a.hidden = true; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000); say('Your file has been downloaded.');
  }
  async function erase() {
    const y = $('btn-delete-yes'); if (y) y.disabled = true;
    let r; try { r = await call('/api/account', 'DELETE', { confirm: 'delete' }); } catch { r = null; }
    if (y) y.disabled = false; $('data-confirm').hidden = true;
    if (!r || !r.ok) return say('The deletion did not go through. Please try again later.');
    let d = {}; try { d = (await r.json()).deleted || {}; } catch { d = {}; }      // the server says what it deleted: a 200 alone is not a deletion
    try { localStorage.removeItem('poddle.device'); } catch { /* nothing to remove */ }
    say(d.account === true ? 'Your account and your statistics have been deleted. If Poddle is open in another tab, reload it.'
      : d.device === true ? 'The statistics saved by this browser have been deleted. If you also have a Poddle account, sign in to Poddle first, then return here to delete it.'      // the session may have ended: the account is untouched until it is deleted while signed in
      : 'Nothing was saved for this browser. If you have an account, sign in to Poddle first, then return here.');
  }
  $('btn-export')?.addEventListener('click', download);
  $('btn-delete')?.addEventListener('click', () => { $('data-confirm').hidden = false; say(''); $('btn-delete-no')?.focus(); });      // Cancel is focused: a second press deletes nothing
  $('btn-delete-no')?.addEventListener('click', () => { $('data-confirm').hidden = true; });
  $('btn-delete-yes')?.addEventListener('click', erase);
})();
