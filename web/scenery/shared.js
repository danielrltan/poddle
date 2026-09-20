// Shared context for everything in web/scenery/ (contract: docs/SCENERY.md). ONE palette, ONE wind field (the same
// formula in JS and GLSL, so palms bend exactly when the breeze lines arrive), seeded rng, canvas textures, geometry
// merge (the UMD three build ships no BufferGeometryUtils), the quality switch and the layout rules that protect play.

// Place: a public rec-park court on LA's Westside, ~3:30 pm, late summer. -z north (hills, downtown to the NE),
// +x east (palm-lined street, pastel stucco), -x west (lawn, neighbour courts, then sand and the Pacific), +z south
// (headland, marine layer, pier wheel to the SW). Sun high in the SW: scene.js's vector, untouched.
export const PAL = {
  // sky by elevation (deg). Above the hills the ball must see MEDIUM saturated blue (the complement of its yellow);
  // cream lives only under ~1.5 deg where hills/city hide it, and equals the fog so the ground seam vanishes.
  // Where a lob leaves the frame (4-9 deg up) the sky must not share the ball's luminance, and the ball is NOT one value: looking north
  // (side 0) the player sees its sunlit face (L ~0.4), looking south (side 1) its shaded face (L ~0.2). So the sky does what a real one does:
  // deep blue opposite the sun (sky6/sky12: L <= 0.28, darker than the lit ball, and reached by 4.5 deg so the cross-over hides behind the
  // ridge), milky to the south, the sun's side (sky6Sun/sky12Sun: L ~0.5, lighter than the shaded ball; sky.js keeps it to +-40 deg of due south). One flat sky6 '#6fb4ea' measured 1.04 : 1 from side 0.
  skyZenith: '#347bcd', sky40: '#3984d5', sky12: '#3b86d6', sky6: '#4a93dc', sky12Sun: '#5fa6e4', sky6Sun: '#8cc4ee', sky2: '#a5d3f0', horizon: '#e4dacb', fog: '#e4dacb',
  sunGlow: '#ffd9b0', sunDisc: '#fff6da', sunHalo: '#ffe2a8',
  sunLight: '#ffeccb', hemiSky: '#cfe6ff', hemiGround: '#7f8a5e',
  cloudLit: '#fbf6ec', cloudMid: '#e6ebf3', cloudShade: '#b9c3e0', marineLit: '#f1e8dc', marineShade: '#b4bfd0',   // never pure white: the ball owns white
  // far layers: fog:false, haze baked in as a top -> base gradient
  foothill: '#8e9f7e', foothillBase: '#c3c9bd', ridge: '#8197bf', ridgeBase: '#c5cfde', farRange: '#aebcd6', farRangeBase: '#dbe1ea',
  headland: '#a9b9cc', observatory: '#c4ccd6', skylineLit: '#c2bccd', skylineShade: '#949cba', skylineBase: '#d3d6e0', wheel: '#a4527e',
  ocean: '#4f8fb0', oceanFar: '#9ebfd0', glitter: '#e9e6d6', surf: '#e4eae6', sand: '#d8c79f', sandWet: '#b9a98a',
  // ground (scene.js owns the 600 m grass slab, colour = grass)
  grass: '#4f9a4a', grassDry: '#7fa84f', grassWorn: '#9aa468', dg: '#d9b98a', dgShade: '#bfa077', sidewalk: '#d6cec2', curb: '#b9b2a6',
  asphalt: '#5d6170', lanePaint: '#e8e2d0', bikePath: '#c9c2b2', courtBlue: '#2f62a3', courtGreen: '#2e7d56', courtLine: '#dfe6e6',
  paintedShadow: 'rgba(20,40,60,0.28)',
  // palms: Washingtonia trunks are grey-brown, not orange; the dead-frond skirt is the authentic tell
  trunkLit: '#a98c6c', trunkDark: '#755c46', skirt: '#9a7f55', skirtDark: '#6f5d3a',
  fanLit: '#6fae4a', fanMid: '#3f8f45', fanDark: '#2a6a3c', dateLit: '#86b391', dateDark: '#2c6355',   // dates are blue-grey green: a different tree from the fan palms at a glance
  leafLit: '#57a84f', leafDark: '#3f8f45', hedge: '#2f7a47', treeMassFar: '#5f7a57', jacaranda: '#8f7fd6', jacarandaLit: '#b3a4ea',
  bougainvillea: '#cf3f8f', bougainvilleaLit: '#e46aa9',
  // built things
  stucco: ['#e8c9a8', '#e6a58e', '#a8cfc4', '#f0e2c8', '#9db7d6'], roof: '#b9603f', windowBand: '#5a6a82', awning: '#2f8f8a',
  mural: ['#ef7f5a', '#f2b36b', '#5a4a9a'], sails: ['#2fa8a0', '#2d5fa8', '#c8468c'], cars: ['#3a9aa0', '#d68a9a', '#8fae8a', '#33486e'],
  lifeguard: '#8fc1d8', lifeguardTrim: '#e6e4da', windscreen: '#17513a', chainlink: '#aab0b4', pole: '#8d949c',
  // wind fx: nothing here is pure white or yellow, and nothing here may enter the calm corridor
  breeze: '#fffaf0', leafGreen: '#5f9a4a', leafBrown: '#8a6a45', bird: '#3c4660',
};

export const LIGHT = { sun: 3.35, hemi: 1.35, fogNear: 45, fogFar: 270 };   // court is <= 27 m from the eye: untouched by fog
export const WORLD = { keepX: 9, keepZ: 14.6, tallX: 9, tallZ: 18, domeR: 440, farR: [250, 400], maxR: 420 };   // camera.far is 500

const clamp = (v, a, b) => Math.max(a, Math.min(b, v)), sstep = (a, b, v) => { v = clamp((v - a) / (b - a), 0, 1); return v * v * (3 - 2 * v); };
export function rng(seed) { seed = (seed >>> 0) || 1; return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296); }
export function hash(a, b = 0) { let h = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca6b)) >>> 0; h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d) >>> 0; h ^= h >>> 12; return h >>> 0; }

// ---- the wind field. Prevailing onshore breeze (from the west, toward +x and a little north), veering slowly +-18 deg.
// Gust fronts 90 m apart travel downwind at 6 m/s (one every ~15 s, strong for ~6 s) with 20 m ripples on top.
export const WIND = { speed: 6, calm: 0.3, gain: 0.7, theta0: -0.3 };
const windTheta = t => WIND.theta0 + 0.22 * Math.sin(0.043 * t) + 0.09 * Math.sin(0.11 * t + 1.3);
const gustAt = (s, c, t) => sstep(-0.6, 0.9, 0.7 * Math.sin(0.07 * s - 0.42 * t + 0.6 * Math.sin(0.05 * c)) + 0.3 * Math.sin(0.31 * s - 1.7 * t + 2.1));
export const WIND_GLSL = /* glsl */`
uniform float uTime; uniform vec4 uWind;   // uWind: xy = unit direction in world (x,z), z = calm strength, w = gust gain
float sGust(vec2 p) { vec2 d = uWind.xy; float s = dot(p, d), c = dot(p, vec2(-d.y, d.x));
  return smoothstep(-0.6, 0.9, 0.7 * sin(0.07 * s - 0.42 * uTime + 0.6 * sin(0.05 * c)) + 0.3 * sin(0.31 * s - 1.7 * uTime + 2.1)); }
float sWind(vec2 p) { return uWind.z + uWind.w * sGust(p); }   // strength 0.3 (calm) .. 1 (full gust) at world (x,z)
float sHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
`;

export function makeShared(THREE, ctx) {
  const Q = new URLSearchParams(typeof location !== 'undefined' ? location.search : ''), q = Q.get('q');
  const small = typeof window !== 'undefined' && (Math.min(window.innerWidth, window.innerHeight) < 500 || ((window.devicePixelRatio || 1) < 1.5 && (navigator.hardwareConcurrency || 8) <= 4) || (navigator.deviceMemory || 8) < 4);
  const quality = q === 'low' || q === 'high' ? q : small ? 'low' : 'high', low = quality === 'low';
  const uniforms = { uTime: { value: 0 }, uWind: { value: new THREE.Vector4(Math.cos(WIND.theta0), Math.sin(WIND.theta0), WIND.calm, WIND.gain) } };
  const scratch = { x: 0, z: 0, gust: 0, dx: 0, dz: 0 }, colors = new Map();
  const sd = ctx.sun.position.clone().sub(ctx.sun.target.position).normalize();
  const S = {
    ctx, pal: PAL, light: LIGHT, world: WORLD, rng, hash, quality, low, uniforms, windGLSL: WIND_GLSL, windSpeed: WIND.speed, texBytes: 0,
    pick: (high, lo) => (low ? lo : high),                                  // S.pick(87, 44): every count goes through this
    color: hex => { let c = colors.get(hex); if (!c) colors.set(hex, c = new THREE.Color(hex)); return c; },   // shared, sRGB-correct: do not mutate
    sunDir: sd, shadowPerM: { x: -sd.x / sd.y, z: -sd.z / sd.y },           // painted shadow of a point h metres up lands at (x + h*shadowPerM.x, z + h*shadowPerM.z)
    // wind at world (x,z), time t -> { x, z: direction * strength (0.3..1), gust: 0..1, dx, dz: unit direction }. Returns `out`, or a
    // SHARED scratch object when omitted (read it before the next call). Pure function of its arguments: frozen t = frozen wind.
    wind(x, z, t, out = scratch) {
      const th = windTheta(t), dx = Math.cos(th), dz = Math.sin(th), g = gustAt(x * dx + z * dz, -x * dz + z * dx, t), k = WIND.calm + WIND.gain * g;
      out.x = dx * k; out.z = dz * k; out.gust = g; out.dx = dx; out.dz = dz; return out;
    },
    // vertex sway for any built-in material. `body` is GLSL that may move `vec3 P` (WORLD position, after the instance matrix).
    // In scope: vec3 O (world origin of the instance/object), float sScale (instance y scale), `position` (local), uTime, uWind,
    // sGust(xz), sWind(xz), sHash(xz), plus whatever attributes `decl` declares. All sway materials share S.uniforms.
    sway(mat, body, decl = '') {
      const key = 'sway:' + decl + body;
      mat.onBeforeCompile = sh => {
        sh.uniforms.uTime = uniforms.uTime; sh.uniforms.uWind = uniforms.uWind;
        sh.vertexShader = decl + WIND_GLSL + sh.vertexShader.replace('#include <project_vertex>', `
          vec4 sP4 = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            sP4 = instanceMatrix * sP4; vec3 O = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz; float sScale = length(instanceMatrix[1].xyz);
          #else
            vec3 O = modelMatrix[3].xyz; float sScale = 1.0;
          #endif
          vec3 P = (modelMatrix * sP4).xyz;
          ${body}
          vec4 mvPosition = viewMatrix * vec4(P, 1.0);
          gl_Position = projectionMatrix * mvPosition;`);
      };
      mat.customProgramCacheKey = () => key;                                // three keys programs on onBeforeCompile's SOURCE, which is identical for every body
      return mat;
    },
    // canvas texture. opts: { repeat: [u, v] (turns on RepeatWrapping), data: true (not colour: no sRGB decode), aniso }
    tex(w, h, draw, opts = {}) {
      const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h);
      const t = new THREE.CanvasTexture(c); if (!opts.data) t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = opts.aniso || 4;
      if (opts.repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(opts.repeat[0], opts.repeat[1]); }
      S.texBytes += w * h * 4 * 1.34; return t;
    },
    // merge geometries into one non-indexed BufferGeometry (consumes them). Keeps the attributes EVERY input has (position, normal,
    // uv, color, custom floats). Bake transforms first with geo.applyMatrix4 / translate / rotateY / scale.
    merge(geos) {
      const flat = geos.map(g => (g.index ? g.toNonIndexed() : g)), names = Object.keys(flat[0].attributes).filter(n => flat.every(g => g.attributes[n] && g.attributes[n].itemSize === flat[0].attributes[n].itemSize));
      const out = new THREE.BufferGeometry();
      for (const n of names) {
        const size = flat[0].attributes[n].itemSize, arr = new Float32Array(flat.reduce((a, g) => a + g.attributes[n].count * size, 0)); let o = 0;
        for (const g of flat) { arr.set(g.attributes[n].array, o); o += g.attributes[n].count * size; }
        out.setAttribute(n, new THREE.BufferAttribute(arr, size));
      }
      for (let i = 0; i < geos.length; i++) { geos[i].dispose(); if (flat[i] !== geos[i]) flat[i].dispose(); }
      return out;
    },
    // vertex colours: paint(geo, '#hex') or paint(geo, (x, y, z, i, outColor) => outColor.set(...)/.lerpColors(...)). Returns geo.
    paint(geo, how) {
      const p = geo.attributes.position, arr = new Float32Array(p.count * 3), c = new THREE.Color(), flatc = typeof how === 'function' ? null : S.color(how);
      for (let i = 0; i < p.count; i++) { if (flatc) c.copy(flatc); else how(p.getX(i), p.getY(i), p.getZ(i), i, c); arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
      geo.setAttribute('color', new THREE.BufferAttribute(arr, 3)); return geo;
    },
    // ---- layout rules (world metres). Build-time checks: call them on everything you place.
    keepOut: (x, z, pad = 0) => Math.abs(x) < WORLD.keepX + pad && Math.abs(z) < WORLD.keepZ + pad,            // court, run-off, fences: NOTHING of ours
    noTall: (x, z) => Math.abs(x) < WORLD.tallX + 3 && Math.abs(z) < WORLD.tallZ,                                 // the camera drifts back to z~16.3: nothing to clip into
    corridorHalf: z => 9 + 0.2 * Math.max(0, Math.abs(z) - 13),                                                   // half-width of the calm corridor at depth z (~ +-11 deg from either baseline camera)
    inCorridor: (x, z) => Math.abs(x) < 9 + 0.2 * Math.max(0, Math.abs(z) - 13),                                  // inside: only <= 5 m tall, static, mid-value things; hills; sky
    inFxBan: (x, z) => Math.abs(x) < 14 + 0.3 * Math.max(0, Math.abs(z) - 13),                                    // breeze lines, leaves, birds: never inside this (~ +-22 deg)
    visibleTop: d => 3.1 + 0.155 * d,                                                                              // play camera: highest visible y at forward distance d (16:9)
    smoothstep: sstep, clamp,
    _tick(t) { const th = windTheta(t); uniforms.uTime.value = t; uniforms.uWind.value.x = Math.cos(th); uniforms.uWind.value.y = Math.sin(th); },
  };
  return S;
}
