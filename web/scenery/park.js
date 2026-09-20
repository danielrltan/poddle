// The ground and the built things between the fences and the distance (contract: docs/SCENERY.md, layout: the lead's FINAL SPEC).
// Six draws: ground overlay, stucco boxes, merged props, see-through chainlink/nets, shade sails, painted shadows. Everything is
// static except the sails (S.sway), so update() is empty. Compass: -z north, +x east (street, stucco), -x west (courts, sand, sea).
export function create(THREE, S) {
  const pal = S.pal, group = new THREE.Group(), hi = !S.low, sh = S.shadowPerM, col = S.color, PI = Math.PI;
  const mix = (a, b, t) => new THREE.Color().lerpColors(col(a), col(b), t);
  let bad = 0;                                                            // layout-rule violations we refused to build (should stay 0)
  const clearOf = (x, z, hx = 0, hz = hx) => Math.abs(x) - hx >= S.world.keepX || Math.abs(z) - hz >= S.world.keepZ;   // rect-aware keepOut

  // ---------------------------------------------------------------- ground: one flat vertex-colour overlay --------------------
  // scene.js owns the 600 m grass slab (y = -0.02, MeshStandard r 0.92). We only paint what is NOT plain grass, in the SAME material
  // model so a blob that fades to pal.grass really vanishes into the slab. Four bands: lawn tone (-1), tiles (0), paths/courts (1), paint (2).
  // They are ONE mesh, so depth could never separate them (1.5 cm apart in a 0.3-500 m depth range combed wherever a lawn patch ran under
  // a sidewalk or the sand). Instead nothing here writes depth and the index buffer is in band order: within a draw call triangles
  // land in buffer order, so it is painter's algorithm for free. The mesh draws after scene.js's slab (renderOrder) and is depth-TESTED only.
  const BANDS = [[[], []], [[], []], [[], []], [[], []]], LY = [0.01, 0.025, 0.04]; LY[-1] = 0.01;
  const V = (L, x, y, z, c) => { const b = BANDS[L + 1]; b[0].push(x, y, z); b[1].push(c.r, c.g, c.b); };
  const tri = (L, ax, az, ca, bx, bz, cb, cx, cz, cc) => { const y = LY[L], up = (bz - az) * (cx - ax) - (bx - ax) * (cz - az) > 0;
    V(L, ax, y, az, ca); if (up) { V(L, bx, y, bz, cb); V(L, cx, y, cz, cc); } else { V(L, cx, y, cz, cc); V(L, bx, y, bz, cb); } };
  const q4 = (L, ax, az, ca, bx, bz, cb, cx, cz, cc, dx, dz, cd) => { tri(L, ax, az, ca, bx, bz, cb, cx, cz, cc); tri(L, ax, az, ca, cx, cz, cc, dx, dz, cd); };
  const rect = (L, x0, z0, x1, z1, hex, hex2 = hex) => { const a = col(hex), b = col(hex2);      // hex at x0, hex2 at x1
    if (!clearOf((x0 + x1) / 2, (z0 + z1) / 2, Math.abs(x1 - x0) / 2, Math.abs(z1 - z0) / 2)) { bad++; return; }
    q4(L, x0, z0, a, x1, z0, b, x1, z1, b, x0, z1, a); };
  const placed = [];                                                      // coplanar blobs must never overlap: they would z-fight
  const blob = (L, x, z, rx, rz, rot, cIn, cOut, n = hi ? 12 : 8) => {      // soft patch: full colour to 55 % radius, then fades to cOut
    const R = Math.max(rx, rz); if (!clearOf(x, z, R) || placed.some(b => b[0] === L && Math.hypot(b[1] - x, b[2] - z) < b[3] + R)) return false; placed.push([L, x, z, R]); const c = Math.cos(rot), s = Math.sin(rot), P = (k, f) => { const a = k / n * 2 * PI, u = Math.cos(a) * rx * f, w = Math.sin(a) * rz * f; return [x + u * c - w * s, z + u * s + w * c]; };
    for (let k = 0; k < n; k++) { const a = P(k, 0.55), b = P(k + 1, 0.55), A = P(k, 1), B = P(k + 1, 1); tri(L, x, z, cIn, a[0], a[1], cIn, b[0], b[1], cIn); q4(L, a[0], a[1], cIn, A[0], A[1], cOut, B[0], B[1], cOut, b[0], b[1], cIn); } return true; };
  // strip along z: f(z) -> [x values left to right], colours per column
  const strip = (L, z0, z1, step, f, hexes) => { const cs = hexes.map(h => (h.isColor ? h : col(h))); let pz = z0, px = f(z0);
    for (let z = z0 + step; z < z1 + step * 0.5; z += step) { const zz = Math.min(z, z1), x = f(zz); for (let i = 0; i + 1 < x.length; i++) q4(L, px[i], pz, cs[i], px[i + 1], pz, cs[i + 1], x[i + 1], zz, cs[i + 1], x[i], zz, cs[i]); pz = zz; px = x; } };

  const ZS = 118.5, ZA = 122, ZB = 129;                                   // the N-S streets T into cross streets at |z| 122-129
  const walk = '#' + mix(pal.sidewalk, pal.curb, 0.4).getHexString();      // a shade under pal.sidewalk: in this sun the raw value blows out to the court lines' white
  // east: sidewalk | Poddle Ave | sidewalk | stucco lots | the boulevard | hero-palm sidewalk | far lots
  rect(0, 14.5, -ZS, 18.5, ZS, walk); rect(0, 18.5, -ZA, 25.5, ZA, pal.asphalt); rect(0, 25.5, -ZS, 30, ZS, walk);
  rect(0, 30, -ZS, 44, ZS, pal.dg, pal.dgShade); rect(0, 44, -ZS, 48, ZS, walk); rect(0, 48, -ZA, 57, ZA, pal.asphalt);
  rect(0, 57, -ZS, 65, ZS, walk); rect(0, 65, -ZS, 82, ZS, pal.dgShade, pal.grassWorn);
  for (const s of [-1, 1]) {                                              // cross streets: palms stand in the near sidewalk (z = +-120)
    rect(0, -44, s * ZA, 140, s * ZB, pal.asphalt); rect(0, -44, s * ZB, 140, s * (ZB + 2.5), walk);
    for (const [a, b] of [[-44, 18.5], [25.5, 48], [57, 140]]) rect(0, a, s * ZS, b, s * ZA, walk);
    for (let x = -40; x < 138 && hi; x += 9) rect(2, x, s * 125.4, x + 3, s * 125.6, pal.lanePaint);
  }
  for (const x of [18.5, 25.5, 48, 57]) rect(1, x - 0.12, -ZS, x + 0.12, ZS, pal.curb);                 // kerb lines
  for (let z = -116; z < 116; z += 9) { rect(2, 21.92, z, 22.08, z + 3, pal.lanePaint); if (hi) rect(2, 52.4, z, 52.6, z + 3, pal.lanePaint); }   // never pure white
  for (const z of [-27, 30]) for (let i = 0; i < 6; i++) rect(2, 19 + i * 1.12, z, 19.6 + i * 1.12, z + 3, pal.lanePaint);   // one ladder crosswalk per end
  if (hi) for (let z = -60; z <= 60; z += 5) { rect(1, 14.5, z - 0.04, 18.4, z + 0.04, pal.curb); rect(1, 25.6, z - 0.04, 30, z + 0.04, pal.curb); }   // expansion joints
  // the decomposed-granite loop round our fence (the hedge stands in its side legs like a planting bed), the sail plaza, two walks
  for (const s of [-1, 1]) { rect(1, s * 9.2, -17.3, s * 11.7, 17.3, s > 0 ? pal.dg : pal.dgShade, s > 0 ? pal.dgShade : pal.dg); rect(1, -9.2, s * 14.8, 9.2, s * 17.3, pal.dg); }
  rect(1, -17, -9.5, -11.7, 9.5, pal.dgShade, pal.dg); rect(1, 11.7, -1.5, 14.5, 1.5, pal.dg);
  for (const s of [-1, 1]) strip(1, s > 0 ? 17.3 : -ZS, s > 0 ? ZS : -17.3, 5, zz => { const a = Math.abs(zz), x = -10.4 - 3 * Math.sin((a - 17.3) / (s > 0 ? 30 : 24)) * S.smoothstep(17.3, 30, a); return [x - 1.1, x + 1.1]; }, [pal.dg, pal.dgShade]);
  // west: neighbour courts either side of the date-palm island, bike path, sand, surf, the Pacific out to r 300 (fog blends it into the dome)
  const NC = [[-22.4, -9], [-22.4, 9]];
  for (const [cx, cz] of NC) {
    rect(1, cx - 5.4, cz - 8.6, cx + 5.4, cz + 8.6, pal.courtGreen); rect(2, cx - 3.05, cz - 6.7, cx + 3.05, cz + 6.7, pal.courtBlue);
  }
  const bikeX = z => -38 + 3 * Math.sin(z / 28);
  strip(1, -240, 240, hi ? 6 : 12, z => [bikeX(z) - 1.8, bikeX(z) + 1.8], [pal.bikePath, pal.bikePath]);
  if (hi) for (let z = -236; z < 236; z += 8) rect(2, bikeX(z + 1.2) - 0.07, z, bikeX(z + 1.2) + 0.07, z + 2.4, pal.lanePaint);
  const sandX = z => -45 + 2.2 * Math.sin(z / 19) + 1.2 * Math.sin(z / 7.7 + 1), shoreX = z => -120 + 3 * Math.sin(z / 40) + 1.2 * Math.sin(z / 11 + 2);
  strip(0, -240, 240, hi ? 8 : 16, z => { const e = sandX(z), w = shoreX(z); return [Math.min(-Math.sqrt(9e4 - z * z), w - 45), w - 40, w - 7.5, w - 5.5, w - 3, w, e - 4, e]; },
    [pal.oceanFar, pal.ocean, pal.ocean, pal.surf, pal.sandWet, pal.sand, pal.sand, mix(pal.sand, pal.grassWorn, 0.6)]);
  if (hi) for (const o of [0, 1.9]) strip(2, -200, 200, 8, z => { const x = -96 + o + 5 * Math.sin(z / 47 + 1) + 1.5 * Math.sin(z / 13); return [x - 0.22, x + 0.22]; }, [mix(pal.sand, pal.sandWet, 0.55), mix(pal.sand, pal.sandWet, 0.55)]);   // the lifeguard truck's tyre tracks
  if (hi) strip(1, -240, 240, 8, z => { const w = shoreX(z) - 15 - 2 * Math.sin(z / 23); return [w - 1.6, w - 0.5, w]; }, [pal.ocean, mix(pal.ocean, pal.surf, 0.55), pal.ocean]);   // a second, fainter breaker line
  // lawn tone: big soft patches (dry, worn, lush) that fade to the slab's own green. West lawn, the north/south lawns, east of the far lots.
  {
    const r = S.rng(991), lawns = [[-44, -110, -12, 110, 0.5], [-12, 19, 14, 116, 0.2], [-12, -116, 14, -19, 0.2], [84, -116, 150, 116, 0.1]];
    const tones = [mix(pal.grass, pal.grassDry, 0.85), mix(pal.grass, pal.grassDry, 0.5), mix(pal.grass, pal.grassWorn, 0.6), mix(pal.grass, pal.hedge, 0.45)];
    for (let i = 0, n = 0, want = S.pick(54, 24); n < want && i < 900; i++) {
      const w = r(); let acc = 0, A = lawns[0]; for (const l of lawns) { acc += l[4]; if (w < acc) { A = l; break; } }
      const x = A[0] + r() * (A[2] - A[0]), z = A[1] + r() * (A[3] - A[1]), rx = 4 + r() * 9, rz = rx * (0.5 + r() * 0.6), t = tones[(r() * tones.length) | 0], rot = r() * PI;
      if (x > -30 && x < -11 && Math.abs(z) < 19) continue;               // courts + plaza have their own ground
      if (blob(-1, x, z, rx, rz, rot, t, col(pal.grass))) n++;
    }
    for (let i = 0, n = S.pick(22, 10); i < n; i++) { const z = (r() * 2 - 1) * 200, x = -52 - r() * 58, rx = 5 + r() * 12, wet = r() < 0.5;          // sand: damp hollows and sun-bleached rises, layer 1 over the beach strip
      blob(1, x, z, rx * 0.6, rx * 1.6, (r() - 0.5) * 0.5, wet ? mix(pal.sand, pal.sandWet, 0.4) : mix(pal.sand, pal.lifeguardTrim, 0.4), col(pal.sand)); }
    for (const [cx, cz] of NC) blob(-1, cx, cz + Math.sign(cz) * 10.6, 7, 2.6, 0, mix(pal.grass, pal.grassWorn, 0.6), col(pal.grass));   // worn where people queue
  }
  // muted court lines on the neighbours (layer 2 sits on the blue)
  for (const [cx, cz] of NC) { const W = 3.05, Ln = 6.7, K = 2.13, lw = 0.05, ln = (x0, z0, x1, z1) => rect(2, cx + x0, cz + z0, cx + x1, cz + z1, pal.courtLine); LY[2] = 0.05;
    for (const s of [-1, 1]) { ln(-W, s * Ln - lw, W, s * Ln + lw); ln(s * W - lw, -Ln, s * W + lw, Ln); ln(-W, s * K - lw, W, s * K + lw); ln(-lw, Math.min(s * K, s * Ln), lw, Math.max(s * K, s * Ln)); } LY[2] = 0.04; }
  {
    const GP = [].concat(...BANDS.map(b => b[0])), GC = [].concat(...BANDS.map(b => b[1]));
    const n = GP.length / 3, uv = new Float32Array(n * 2), nor = new Float32Array(n * 3); for (let i = 0; i < n; i++) { uv[i * 2] = GP[i * 3] / 3; uv[i * 2 + 1] = GP[i * 3 + 2] / 3; nor[i * 3 + 1] = 1; }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(GP, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(GC, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    let lin = 0; const grain = S.tex(256, 256, (c, w, h) => { c.fillStyle = '#f4f4f4'; c.fillRect(0, 0, w, h); const r = S.rng(3);   // fine grain only: nothing big enough to show its 3 m tiling
      for (let i = 0; i < 5200; i++) { c.fillStyle = r() < 0.4 ? `rgba(255,255,255,${0.2 + r() * 0.5})` : `rgba(0,0,0,${0.03 + r() * 0.08})`; c.fillRect(r() * w, r() * h, 1.5, 1.5); }
      const d = c.getImageData(0, 0, w, h).data; for (let i = 0; i < d.length; i += 4) lin += Math.pow(d[i] / 255, 2.2); lin /= w * h; }, { repeat: [1, 1], aniso: 8 });
    const m = new THREE.MeshStandardMaterial({ vertexColors: true, map: grain, roughness: 0.92, metalness: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    m.color.setScalar(1 / lin);                                           // the grain must not darken the average, or blob rims would show against the slab
    const mesh = new THREE.Mesh(g, m); mesh.name = 'ground'; mesh.renderOrder = 0.5; mesh.frustumCulled = false; group.add(mesh);   // after the slab and every other opaque thing (they still hide it: depth test stays on)
  }

  // ---------------------------------------------------------------- painted shadows (collected as things are placed) -----------
  const SH = [];                                                          // [x, z, sx, sz, rot, kind (0 palm crown, 1 soft), strength]
  const shBlob = (x, z, sx, sz, rot, kind, str) => { if (S.keepOut(x, z, Math.max(sx, sz) / 2)) return; SH.push([x, z, sx, sz, rot, kind, str]); };
  const shStreak = (x0, z0, x1, z1, w, str) => {                          // a pole/trunk shadow, clipped to the part that stays off the court's ground
    if (S.keepOut(x0, z0, w)) return; let t = 1; for (let k = 1; k <= 16; k++) if (S.keepOut(x0 + (x1 - x0) * k / 16, z0 + (z1 - z0) * k / 16, w)) { t = (k - 1) / 16; break; }
    if (t < 0.1) return; const ex = x0 + (x1 - x0) * t, ez = z0 + (z1 - z0) * t, L = Math.hypot(ex - x0, ez - z0); SH.push([(x0 + ex) / 2, (z0 + ez) / 2, w, L * 1.12, Math.atan2(ex - x0, ez - z0), 1, str]); };
  const cast = (x, z, h, w, str = 0.3) => shStreak(x, z, x + h * sh.x, z + h * sh.z, w, str);
  const shBox = (x, z, w, d, h, str = 0.3) => shBlob(x + h * sh.x * 0.5, z + h * sh.z * 0.5, w + Math.abs(h * sh.x) + 1, d + Math.abs(h * sh.z) + 1, 0, 1, str);

  // ---------------------------------------------------------------- stucco boxes: one InstancedMesh, one 64 px window bay ------
  const parts = [], veil = [];                                            // merged props / merged see-through panels
  const tone = (hex, lo = 0.74, top = 1.4) => (x, y, z, i, out) => out.copy(col(hex)).multiplyScalar(lo + (1 - lo) * S.smoothstep(0, top, y));   // darker feet: nothing floats
  const put = (list, g, hex, x, y, z, ry) => { if (ry) g.rotateY(ry); g.translate(x, y, z); list.push(S.paint(g, typeof hex === 'string' ? tone(hex) : hex)); return g; };
  const box = (w, h, d, x, y, z, hex, o = {}) => { const g = new THREE.BoxGeometry(w, h, d);
    if (o.tx != null || o.tz != null) { const p = g.attributes.position; for (let i = 0; i < p.count; i++) if (p.getY(i) > 0) p.setXYZ(i, p.getX(i) * (o.tx == null ? 1 : o.tx), p.getY(i), p.getZ(i) * (o.tz == null ? 1 : o.tz)); g.computeVertexNormals(); }
    if (o.rz) g.rotateZ(o.rz); if (o.rx) g.rotateX(o.rx); if (o.veil) { const u = g.attributes.uv; for (let i = 0; i < u.count; i++) u.setXY(i, u.getX(i) * Math.max(w, d) / 0.4, u.getY(i) * h / 0.4); }   // 40 cm diamonds whatever the panel size
    return put(o.veil ? veil : parts, g, hex, x, y + h / 2, z, o.ry); };
  const pole = (x, z, h, r0, r1, hex = pal.pole) => { if (S.keepOut(x, z) || (h > 2.4 && S.noTall(x, z)) || (h > 5 && S.inCorridor(x, z))) { bad++; return false; } put(parts, new THREE.CylinderGeometry(r1, r0, h, 6, 1, true), hex, x, h / 2, z); return true; };
  {
    const r = S.rng(2207), B = [];                                        // [x0, z0, w (along z), d (along x), h, colour index]
    for (let z = -92; z < 86;) { const w = 9 + r() * 9, h = 4 + r() * 3, d = 9 + r() * 3, x0 = 30 + r() * 1.6; B.push([x0, z, w, d, h, (r() * 5) | 0, 1]); z += w + (r() < 0.3 ? 3 + r() * 3 : 0.5 + r()); }
    for (let z = -200, k = 0; z < 184; k++) { const w = 14 + r() * 12, h = 5 + r() * 4, d = 10 + r() * 4, x0 = 66 + r() * 2, skip = !hi; if (!skip) B.push([x0, z, w, d, h, (r() * 5) | 0, 0]); z += w + (r() < 0.35 ? 4 + r() * 5 : 0.6 + r()); }
    const n0 = B.length; for (let i = 0; i < n0; i++) { const b = B[i]; if (b[6] && b[4] < 5 && r() < 0.6) B.push([b[0] + 2.5, b[1] + 1.5, b[2] * 0.55, b[3] - 3.5, b[4] + 2.8, b[5], 2, b[4]]); }   // set-back upper storey, <= 7.8 m
    const geo = new THREE.BoxGeometry(1, 1, 1); geo.translate(0, 0.5, 0); S.paint(geo, (x, y, z, i, out) => out.setScalar(y > 0.5 ? 1 : 0.8));
    const bay = S.tex(64, 64, (c, w, h) => { c.fillStyle = '#fff'; c.fillRect(0, 0, w, h); c.fillStyle = 'rgba(0,0,0,0.10)'; c.fillRect(0, h - 5, w, 5); c.fillStyle = pal.windowBand; c.fillRect(12, 18, 40, 26); c.fillStyle = 'rgba(0,0,0,0.18)'; c.fillRect(12, 44, 40, 3); }, { repeat: [1, 1], aniso: 8 });
    const mat = new THREE.MeshLambertMaterial({ map: bay, vertexColors: true });
    mat.onBeforeCompile = s => { s.vertexShader = s.vertexShader.replace('#include <uv_vertex>', `#include <uv_vertex>
      #if defined(USE_MAP) && defined(USE_INSTANCING)
        vec3 bS = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz)); float bW = abs(normal.x) > 0.5 ? bS.z : bS.x;
        vMapUv = abs(normal.y) > 0.5 ? vec2(0.04) : vec2(uv.x * max(1.0, floor(bW / 3.4 + 0.5)), uv.y * max(1.0, floor(bS.y / 3.1 + 0.5)));   // whole bays per wall, whole storeys per height
      #endif`); };
    mat.customProgramCacheKey = () => 'park-bays';
    const im = new THREE.InstancedMesh(geo, mat, B.length), M = new THREE.Matrix4(), Q = new THREE.Quaternion(), P = new THREE.Vector3(), Sc = new THREE.Vector3();
    B.forEach((b, i) => {
      const [x0, z0, w, d, h, ci, kind, y0 = 0] = b, cx = x0 + d / 2, cz = z0 + w / 2, hh = kind === 2 ? h - y0 : h;
      M.compose(P.set(cx, y0, cz), Q, Sc.set(d, hh, w)); im.setMatrixAt(i, M); im.setColorAt(i, col(pal.stucco[ci]));
      // roofs: terracotta hips on the houses, pale parapet slabs on the flat-tops (merged props). Awnings face the street and the sun.
      if ((ci + i) % 3) box(d + 0.9, 1.3, w + 0.9, cx, h, cz, tone(pal.roof, 1), { tx: 0.06, tz: Math.max(0.1, 1 - d / w) }); else box(d + 0.3, 0.35, w + 0.3, cx, h, cz, tone(pal.stucco[3], 1));
      if (kind === 1 && i % 2 === 0) box(1.3, 0.12, w * 0.6, x0 - 0.55, 2.7, cz, tone(i % 4 ? pal.awning : pal.mural[2], 1), { rz: 0.32 });
      if (kind !== 2) shBox(cx, cz, d, w, h, 0.34);
    });
    im.name = 'stucco'; im.frustumCulled = false; group.add(im);
    // the mural: the longest near wall, facing west at the street. Big flat shapes only: sunset field, sun, purple hills, two palm silhouettes.
    const mb = B.filter(b => b[6] === 1 && b[1] < -20 && b[1] > -75).sort((a, b) => b[2] - a[2])[0];
    if (mb) { const [x0, z0, w, , h] = mb, x = x0 - 0.06, flat = (g, hex, y, z, e = 0) => { g.rotateY(-PI / 2); put(parts, g, typeof hex === 'string' ? tone(hex, 1) : hex, x - e, y, z); };
      const top = col(pal.mural[0]), lowc = col(pal.mural[1]); flat(new THREE.PlaneGeometry(w, h), (px, y, pz, i, out) => out.lerpColors(lowc, top, S.clamp(y / h, 0, 1)), h / 2, z0 + w / 2);
      flat(new THREE.CircleGeometry(h * 0.42, 20, 0, PI), (px, y, pz, i, out) => out.lerpColors(col(pal.mural[1]), col(pal.sunHalo), 0.5), h * 0.18, z0 + w * 0.5, 0.02);
      for (let k = 0; k < 5; k++) flat(new THREE.CircleGeometry(w * 0.17, 12, 0, PI), pal.mural[2], 0, z0 + w * (0.08 + k * 0.21), 0.04);
      for (const [f, ph] of [[0.24, 0.8], [0.73, 0.66]]) { const pz = z0 + w * f, H = h * ph; flat(new THREE.PlaneGeometry(0.22, H), pal.mural[2], H / 2, pz, 0.05);
        for (let k = 0; k < 7; k++) { const g = new THREE.PlaneGeometry(h * 0.3, 0.16); g.translate(h * 0.13, 0, 0); g.rotateZ(-0.5 + k * (PI + 1) / 6); flat(g, pal.mural[2], H, pz, 0.05); } } }
  }

  // ---------------------------------------------------------------- merged props ---------------------------------------------
  // street: cobra-head lights on both kerbs, parked cars, a low planter wall on the court side of the sidewalk
  const dark = '#' + mix(pal.pole, '#2a2d36', 0.55).getHexString();     // poles a step darker and thinner than palm trunks: they were out-shouting them
  for (const [x, z] of [[18.1, -51], [18.1, 51], [25.9, -78], [25.9, -26], [25.9, 26], [25.9, 78]]) { const d = x > 20 ? -1 : 1;   // near kerb: only +-51. At |z| < 35 the cobra heads stood in the ball band as its one thin dark detail, further out is the calm corridor
    if (!pole(x, z, 9, 0.1, 0.06, dark)) continue; box(2.4, 0.08, 0.08, x + d * 1.15, 8.9, z, tone(dark, 1), { rz: d * 0.12 }); box(0.9, 0.16, 0.34, x + d * 2.5, 9.0, z, tone(pal.asphalt, 1)); cast(x, z, 9, 0.35, 0.26); }
  { const r = S.rng(77), spots = [[19.6, -34, 0], [19.6, -12.5, 1], [19.7, 9, 2], [24.4, -22, 3], [24.4, 21, 0], [19.6, 41, 3], [24.3, -52, 1]];
    spots.slice(0, S.pick(7, 5)).forEach(([x, z, c], i) => { const hex = pal.cars[c], j = (r() - 0.5) * 0.06;
      box(1.78, 0.62, 4.3, x, 0.32, z, hex, { tx: 0.94, tz: 0.96, ry: j }); box(1.6, 0.52, 2.3, x, 0.94, z - 0.25, tone(pal.windowBand, 1), { tx: 0.84, tz: 0.72, ry: j }); box(1.34, 0.06, 1.66, x, 1.46, z - 0.25, tone(hex, 1), { ry: j });
      for (const s of [-1, 1]) box(1.84, 0.62, 0.66, x, 0, z + s * 1.35, tone('#2a2d36', 1), { ry: j });                     // the tyres: one dark axle block each
      shBlob(x + 0.45, z - 0.55, 3.3, 6.0, 0, 1, 0.42); }); }
  for (const [z0, z1] of [[-30, -19], [-15, -2.2], [2.2, 15], [19, 30]]) { box(0.4, 0.46, z1 - z0, 14.2, 0, (z0 + z1) / 2, pal.stucco[3]); shBlob(14.55, (z0 + z1) / 2 - 0.2, 1.0, z1 - z0 + 0.6, 0, 1, 0.3); }
  // court floodlights (not emissive: it is mid-afternoon), just outside the no-tall box
  // half way down each side fence, 11 m from the corner date palms. In the corners (z 15.5) the pole speared the crown with its lamp heads
  // poking out of the fronds, and anywhere beyond |z| 9 it still crosses that crown on screen from the far baseline (palm at 23 deg, crown to 31).
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) { const x = sx * 12.5, z = sz * 8.5; if (!pole(x, z, 8, 0.085, 0.055, dark)) continue;
    box(0.08, 0.08, 1.7, x, 7.9, z, tone(dark, 1)); for (const k of [-0.6, 0.6]) box(0.5, 0.34, 0.5, x - sx * 0.22, 7.45, z + k, tone(pal.asphalt, 1), { rz: sx * 0.5 }); cast(x, z, 8, 0.32, 0.26); }
  // neighbour courts: 2 m windscreen on the west run, chainlink (see-through draw) on the rest, posts, rails, nets
  { const xe = -17, xw = -27.9, H = 2.5, link = tone(pal.pole, 1);   // 2.5 m, not the usual 3: the eye is at 3.1 m and the Pacific sits in that last half metre
    box(0.05, 2, 35.4, xw, 0, 0, tone(pal.windscreen, 0.85)); box(0.06, 0.06, 35.4, xw, H - 0.03, 0, tone(pal.pole, 1)); box(0.02, H - 2, 35.4, xw, 2, 0, link, { veil: 1 });
    for (let z = -17.7; z <= 17.71; z += 5.9) { box(0.09, H, 0.09, xw, 0, z, pal.pole); }
    shBlob(xw + 0.55, -0.6, 1.5, 36, 0, 1, 0.3);
    for (const [cx, cz] of NC) { const z0 = cz - 8.6, z1 = cz + 8.6;
      box(0.02, H, 17.2, xe, 0, cz, link, { veil: 1 }); box(0.06, 0.06, 17.2, xe, H - 0.03, cz, tone(pal.pole, 1));
      for (const z of [cz < 0 ? z0 : z1, 0]) { if (z === 0 && cz > 0) continue; box(xe - xw, H, 0.02, (xe + xw) / 2, 0, z, link, { veil: 1 }); box(xe - xw, 0.06, 0.06, (xe + xw) / 2, H - 0.03, z, tone(pal.pole, 1)); }
      for (let k = 0; k < 4; k++) box(0.09, H, 0.09, xe, 0, z0 + k * 17.2 / 3, pal.pole);
      box(6.9, 0.84, 0.02, cx, 0.05, cz, tone('#20242c', 1), { veil: 1 }); box(6.9, 0.06, 0.04, cx, 0.86, cz, tone(pal.courtLine, 1)); for (const s of [-1, 1]) box(0.08, 0.95, 0.08, cx + s * 3.45, 0, cz, tone('#2a2d36', 1));
      shBlob(cx + 0.2, cz - 0.3, 7.2, 0.9, 0, 1, 0.3); } }
  // shade-sail posts (the sails themselves billow: their own draw below)
  const SAILS = [[[-12.5, 4.9, -7.4], [-16.4, 3.0, -5.6], [-13.4, 3.4, -1.6]], [[-16.4, 5.0, -3.0], [-12.5, 3.0, -0.6], [-15.6, 3.5, 3.2]], [[-12.5, 4.8, 1.8], [-16.4, 3.1, 5.4], [-13.2, 3.3, 7.6]]];
  { const seen = new Set(); for (const s of SAILS) for (const [x, y, z] of s) { const k = x + ',' + z; if (seen.has(k)) continue; seen.add(k); if (pole(x, z, y + 0.25, 0.08, 0.06)) cast(x, z, y, 0.25, 0.26); } }
  // the beach: two county lifeguard towers, volleyball nets, a scatter of umbrellas
  for (const [x, z] of [[-75, -50], [-80, 60]]) {
    for (const a of [-1, 1]) for (const b of [-1, 1]) box(0.16, 1.9, 0.16, x + a * 1.5, 0, z + b * 1.5, pal.lifeguardTrim);
    box(4.6, 0.16, 4.4, x, 1.9, z, tone(pal.lifeguardTrim, 1)); box(3, 2.3, 3, x + 0.3, 2.06, z, tone(pal.lifeguard, 1)); box(0.06, 0.9, 2.2, x - 1.22, 3.0, z, tone(pal.windowBand, 1));
    box(4.4, 0.14, 4.2, x, 4.4, z, tone(pal.lifeguardTrim, 1), { rz: -0.1 }); box(3.6, 0.12, 1.1, x + 3.9, 0.9, z + 1, tone(pal.lifeguardTrim, 1), { rz: -0.5 });
    for (const b of [-1, 1]) box(4.6, 0.06, 0.06, x, 2.95, z + b * 2.15, tone(pal.lifeguardTrim, 1));
    shBlob(x + 1.6, z - 2, 7.5, 7.5, 0, 1, 0.36);
  }
  { const r = S.rng(515), hues = [...pal.sails, pal.mural[0], pal.mural[1], pal.lifeguard];
    for (const [x, z] of [[-60, -16], [-63, 14]]) { for (const s of [-1, 1]) { box(0.1, 2.5, 0.1, x, 0, z + s * 4.6, pal.pole); cast(x, z + s * 4.6, 2.5, 0.2, 0.24); } box(0.02, 1, 9.2, x, 1.45, z, tone('#20242c', 1), { veil: 1 }); box(0.04, 0.06, 9.2, x, 2.42, z, tone(pal.courtLine, 1)); }
    for (let i = 0, n = S.pick(12, 6); i < n; i++) { const x = -52 - r() * 58, z = (r() * 2 - 1) * 95, hex = hues[i % hues.length], g = new THREE.ConeGeometry(1.35, 0.5, 8, 1, true);
      put(parts, g, tone(hex, 1), x, 2.05, z); box(0.06, 2, 0.06, x, 0, z, tone(pal.pole, 1)); shBlob(x + 0.9, z - 1.15, 2.6, 2.6, 0, 1, 0.34); } }
  { const m = new THREE.Mesh(S.merge(parts), new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide })); m.name = 'props'; m.frustumCulled = false; group.add(m); }
  if (hi) { const wire = S.tex(64, 64, (c, w, h) => { c.fillStyle = '#000'; c.fillRect(0, 0, w, h); c.strokeStyle = '#fff'; c.lineWidth = 7; c.lineCap = 'square'; for (const o of [-64, 0, 64]) { c.beginPath(); c.moveTo(o, 0); c.lineTo(o + 64, 64); c.moveTo(o + 64, 0); c.lineTo(o, 64); c.stroke(); } }, { repeat: [1, 1], data: true, aniso: 8 });   // mips average it to the even grey veil a real fence is at range
    const m = new THREE.Mesh(S.merge(veil), new THREE.MeshLambertMaterial({ vertexColors: true, alphaMap: wire, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true })); m.name = 'veil'; m.renderOrder = 1; group.add(m); }   // single pass: r160's two-pass transparent DoubleSide re-keys the program twice a frame (12 KB of garbage)

  // ---------------------------------------------------------------- shade sails: taut edges, a belly that lifts with the gust ---
  { const n = S.pick(6, 4), P = [], C = [], Pin = [], A = new THREE.Vector3(), B = new THREE.Vector3(), Cc = new THREE.Vector3(), G = new THREE.Vector3(), o = new THREE.Vector3();
    const at = (i, j, c) => { const a = i / n, b = j / n, w = 1 - a - b, e = a * b + b * w + w * a; o.set(0, 0, 0).addScaledVector(A, a).addScaledVector(B, b).addScaledVector(Cc, w); o.lerp(G, e * 1.1);   // cable-cut edges curve inward
      const pin = 27 * a * b * w; o.y -= 0.3 * pin; P.push(o.x, o.y, o.z); Pin.push(pin); const k = 0.86 + 0.14 * pin; C.push(c.r * k, c.g * k, c.b * k); };
    SAILS.forEach((s, si) => { A.fromArray(s[0]); B.fromArray(s[1]); Cc.fromArray(s[2]); G.copy(A).add(B).add(Cc).multiplyScalar(1 / 3); const c = col(pal.sails[si % 3]);
      for (let i = 0; i < n; i++) for (let j = 0; j < n - i; j++) { at(i, j, c); at(i + 1, j, c); at(i, j + 1, c); if (i + j < n - 1) { at(i + 1, j, c); at(i + 1, j + 1, c); at(i, j + 1, c); } }
      shBlob(G.x + G.y * sh.x, G.z + G.y * sh.z, 4.2, 5.2, 0.4, 1, 0.34); });
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3)); g.setAttribute('aPin', new THREE.Float32BufferAttribute(Pin, 1)); g.computeVertexNormals();
    const mat = S.sway(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }), 'float sG = sWind(P.xz); P.y += aPin * sG * (0.34 + 0.2 * sin(uTime * 2.6 + P.x * 1.9 + P.z * 1.3)); P.xz += uWind.xy * aPin * sG * 0.12;', 'attribute float aPin;\n');
    const swayHook = mat.onBeforeCompile; mat.onBeforeCompile = s => { swayHook(s); s.fragmentShader = s.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance += diffuseColor.rgb * 0.42;'); };   // cloth is translucent: the underside the player sees glows with the sun behind it
    mat.customProgramCacheKey = () => 'park-sails';
    const m = new THREE.Mesh(g, mat); m.name = 'sails'; m.frustumCulled = false; group.add(m); }

  // ---------------------------------------------------------------- painted shadows: palms and trees, then the one draw -------
  // flora.js is created AFTER us, so this runs once from the first update(). It publishes group.userData.palms [{x, z, h, crown}];
  // its broadleaf blobs are the InstancedMesh with instanceColor. If either is missing we fall back to the lead's row layout.
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), P = new THREE.Vector3(), Sc = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0);
  const buildShadows = () => {
    const flora = group.parent && group.parent.children.find(g => g.name === 'flora'), r = S.rng(64), list = flora && flora.userData.palms;
    const palm = (x, z, h, cr, trunk = true) => { const cx = x + h * sh.x, cz = z + h * sh.z; if (trunk) shStreak(x, z, cx, cz, 0.3 + 0.5 * h / 16, 0.3); shBlob(cx, cz, cr * 2.6, cr * 2.6, r() * PI, 0, 0.42); };
    if (list && list.length) { for (const p of list) if (hi || p.h < 21 || Math.abs(p.z) < 80) palm(p.x, p.z, p.h * 0.95, p.crown, Math.hypot(p.x, p.z) < 110); }   // west corner dates: crown blob lands inside the fence -> keepOut refuses it, trunk streak is clipped
    else { for (let z = -70; z <= 70; z += 10) { palm(17, z, 13 + r() * 6, 2.6); palm(27, z + 5, 13 + r() * 6, 2.6); } for (let z = -80; z <= 80; z += 10) palm(-32, z, 13 + r() * 6, 2.6);
      for (const [x, z] of [[12.5, 17.5], [12.5, -17.5], [-14.5, 17.5], [-14.5, -17.5]]) palm(x, z, 8.2, 4.2); }
    if (flora) flora.traverse(o => { if (!o.isInstancedMesh || !o.instanceColor) return;
      for (let i = 0; i < o.count; i++) { o.getMatrixAt(i, M); M.decompose(P, Q, Sc); if (Math.hypot(P.x, P.z) > 125 || (S.low && i % 2)) continue; const hc = P.y + Sc.y * 0.55; shBlob(P.x + hc * sh.x, P.z + hc * sh.z, Sc.x * 2.5, Sc.z * 2.5, 0, 1, 0.36); } });
    const atlas = S.tex(256, 128, (c, w, h) => { c.fillStyle = '#000'; c.fillRect(0, 0, w, h);
      let g = c.createRadialGradient(64, 64, 0, 64, 64, 40); g.addColorStop(0, 'rgba(255,255,255,0.85)'); g.addColorStop(0.5, 'rgba(255,255,255,0.6)'); g.addColorStop(1, 'rgba(255,255,255,0)'); c.fillStyle = g; c.fillRect(0, 0, 128, 128);
      c.save(); c.beginPath(); c.rect(2, 2, 124, 124); c.clip(); c.translate(64, 64); c.filter = 'blur(1.5px)'; c.fillStyle = 'rgba(255,255,255,0.6)'; const rr = S.rng(8);
      for (let k = 0; k < 20; k++) { c.save(); c.rotate(k / 20 * 2 * PI + rr() * 0.2); c.beginPath(); c.ellipse(30, 0, 27 + rr() * 4, 4.5, 0, 0, 2 * PI); c.fill(); c.restore(); } c.restore(); c.filter = 'none';
      g = c.createRadialGradient(192, 64, 0, 192, 64, 62); g.addColorStop(0, '#fff'); g.addColorStop(0.45, 'rgba(255,255,255,0.85)'); g.addColorStop(1, 'rgba(255,255,255,0)'); c.fillStyle = g; c.fillRect(128, 0, 128, 128); }, { data: true });
    const geo = new THREE.PlaneGeometry(1, 1); geo.rotateX(-PI / 2); const aS = new Float32Array(SH.length * 2);
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color('rgb(20,40,60)'), alphaMap: atlas, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    mat.onBeforeCompile = s => { s.vertexShader = 'attribute vec2 aShade; varying float vStr;\n' + s.vertexShader.replace('#include <uv_vertex>', '#include <uv_vertex>\n vAlphaMapUv.x = (vAlphaMapUv.x + aShade.x) * 0.5; vStr = aShade.y;');
      s.fragmentShader = 'varying float vStr;\n' + s.fragmentShader.replace('#include <alphamap_fragment>', '#include <alphamap_fragment>\n diffuseColor.a *= vStr;'); };
    mat.customProgramCacheKey = () => 'park-shadows';
    const im = new THREE.InstancedMesh(geo, mat, SH.length);
    SH.forEach((s, i) => { M.compose(P.set(s[0], 0.06, s[1]), Q.setFromAxisAngle(Y, s[4]), Sc.set(s[2], 1, s[3])); im.setMatrixAt(i, M); aS[i * 2] = s[5]; aS[i * 2 + 1] = s[6]; });
    geo.setAttribute('aShade', new THREE.InstancedBufferAttribute(aS, 2)); im.name = 'shadows'; im.frustumCulled = false; im.renderOrder = -1; group.add(im);
    group.userData.shadows = SH.length;
  };

  group.userData = { violations: bad, shadows: 0 }; let shadowsDone = false;
  return { group, update(dt, t, camera) { if (!shadowsDone) { shadowsDone = true; buildShadows(); } } };                             // all motion is in the sails' vertex shader (shared uniforms)
}
