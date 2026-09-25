// Test-only preload (node --require, via NODE_OPTIONS in test/auth.test.mjs): the spawned server may not reach the internet.
// fetch() to any host other than loopback is refused after one stderr line naming the URL, so a test can assert WHERE the server
// tried to go (the production server must go to Google's real key set, never to the test key file) without depending on the network.
// Nothing under server/ knows about this file; production code is unchanged.
'use strict';
const real = globalThis.fetch;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
globalThis.fetch = function (input, init) {
  let url; try { url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url); } catch { url = null; }
  if (url && LOOPBACK.has(url.hostname)) return real.call(this, input, init);
  process.stderr.write(`test: blocked ${url ? url.origin + url.pathname : String(input)}\n`);   // origin + path only: never a query string
  return Promise.reject(new TypeError('fetch failed (test: no network)'));
};
