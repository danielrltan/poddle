// Test-only preload (node --require, via NODE_OPTIONS in test/share.test.mjs): @resvg/resvg-js cannot be loaded, as on a machine whose
// native binary is missing, so the share card must fall back to web/og.jpg. Nothing under server/ knows about this file.
'use strict';
const Module = require('module');
const real = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === '@resvg/resvg-js' || request.startsWith('@resvg/')) throw Object.assign(new Error(`Cannot find module '${request}' (test: no resvg)`), { code: 'MODULE_NOT_FOUND' });
  return real.call(this, request, ...rest);
};
