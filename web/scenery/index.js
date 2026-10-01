// Everything beyond the fences. Contract: docs/SCENERY.md. This file only wires: one shared context + root per VENUE (park, the one there
// is since the Ranked stadium went, docs/TROPHIES.md 2), the modules of each (each isolated, so one broken module never takes the scene down), a hitch-free
// arrival (staged build, shaders compiled off the frame, one-frame swap), lighting/fog from the shown venue's palette, update fan-out, debug handle.
import { makeShared } from './shared.js';
import * as sky from './sky.js';
import * as flora from './flora.js';
import * as park from './park.js';
import * as wind from './wind.js';

const MODULES = {                                                              // far to near, fx last
  park: [['sky', sky], ['park', park], ['flora', flora], ['wind', wind]],
};

export function createScenery(THREE, ctx) {
  const V = {}; let shown = null, want = null;                                 // venues by name; the one on screen; the one asked for (maybe still building)
  // Arriving must not hitch the game (measured on an M4: 74 ms to build + 50-65 ms compiling 17 programs inside the first frame that saw
  // them). So: one module per task, everything hidden, shaders compiled off the frame (KHR_parallel_shader_compile through r160's
  // compileAsync), and only THEN the swap: old look out, new look in, in a single frame. `ready` gates update() and the debug handle.
  const make = name => {
    const S = makeShared(THREE, ctx, name), root = new THREE.Group(), v = { name, S, root, live: [], built: {}, sky: false, ready: false, done: [] };
    root.name = name === 'park' ? 'scenery' : 'scenery:' + name; root.visible = false; root.userData.sceneryRoot = true; ctx.scene.add(root); V[name] = v;
    const mods = MODULES[name]; let next = 0;
    const build = ([n, mod]) => {
      try {
        const m = mod.create(THREE, S); if (!m || !m.group) throw new Error('create() returned no group');
        m.group.name = n; root.add(m.group); v.built[n] = m.group.children.length > 0; if (v.built[n] && (n === 'sky' || m.sky)) v.sky = true;
        if (typeof m.update === 'function') v.live.push({ name: n, update: m.update, dead: false });
      } catch (e) { v.built[n] = false; console.warn('scenery: ' + n + ' failed, carrying on without it:', e); }
    };
    const ok = () => { if (v.ready) return; v.ready = true; const d = v.done; v.done = []; for (const f of d) f(); };
    const finish = () => {
      root.traverse(o => { o.castShadow = false; o.receiveShadow = false; });   // the sun's shadow frustum is fitted to the court: ours are painted
      fanOut(v, 0, 0, ctx.camera);                                              // park.js paints its shadows on the first update (it needs flora's palms): do it before compiling
      root.traverse(o => { o.castShadow = false; o.receiveShadow = false; });
      let p = null; try { if (typeof ctx.renderer.compileAsync === 'function') p = ctx.renderer.compileAsync(root, ctx.camera, ctx.scene); } catch (e) { p = null; }
      if (p && typeof p.then === 'function') { p.then(ok, ok); setTimeout(ok, 4000); } else ok();   // a lost context must not leave the old look up for ever: after 4 s just show it
    };
    const step = () => { build(mods[next++]); if (next < mods.length) setTimeout(step, 0); else finish(); };
    step(); return v;
  };
  const fanOut = (v, dt, t, camera) => {
    v.S._tick(t);
    for (let i = 0; i < v.live.length; i++) {
      const m = v.live[i]; if (m.dead) continue;
      try { m.update(dt, t, camera); } catch (e) { m.dead = true; console.warn('scenery: ' + m.name + ' update failed, stopped updating it:', e); }
    }
  };
  // the swap, and where the lighting/fog becomes the venue's palette: same sun VECTOR (short readable court shadows), R-B kept small so the white lines stay white
  const show = name => {
    const v = V[name], pal = v.S.pal, L = v.S.light; shown = name;
    for (const k in V) V[k].root.visible = k === name;
    ctx.sun.color.set(pal.sunLight); ctx.sun.intensity = L.sun;
    ctx.hemi.color.set(pal.hemiSky); ctx.hemi.groundColor.set(pal.hemiGround); ctx.hemi.intensity = L.hemi;
    ctx.fog.near = L.fogNear; ctx.fog.far = L.fogFar;
    // the old look is only retired by what replaces it: plain dome + sphere clouds (and the fog colour that matches that dome's horizon)
    // go once this venue's sky has built; scene.js's lollipop trees, which stand exactly in the calm band, go once flora.js has (update()).
    for (const o of ctx.plainSky) o.visible = !v.sky; if (v.sky) ctx.fog.color.set(pal.fog);
    if (typeof window !== 'undefined') window.__scenery = handle;
  };
  const hide = () => { shown = null; for (const k in V) V[k].root.visible = false; for (const o of ctx.plainSky) o.visible = true; };   // between venues: scene.js's plain look (it has just set that venue's sky/fog/lights)

  // scene.js rebuilds its court group on setCourt() and does not expose it: spot it by its 600 m grass slab, hide its instanced trees.
  const pruneOldTrees = () => {
    const kids = ctx.scene.children;
    for (let i = 0; i < kids.length; i++) {
      const g = kids[i]; if (!g.isGroup || g.userData.sceneryRoot || g.userData.sceneryPruned) continue; g.userData.sceneryPruned = true;
      let slab = false; for (let j = 0; j < g.children.length; j++) { const p = g.children[j].geometry && g.children[j].geometry.parameters; if (p && p.width >= 300) slab = true; }
      if (slab) for (let j = 0; j < g.children.length; j++) if (g.children[j].isInstancedMesh) g.children[j].visible = false;
    }
  };

  // verifier handle (for the venue on screen). drawCalls()/triangles(): renderer.info for a frame with the scenery minus the same frame
  // without it (current camera, so frustum-culled things do not count: check the wide view too). census(): camera-independent upper bound.
  const cur = () => V[shown] || V[want];
  const measure = key => {
    const r = ctx.renderer, info = r.info.render, d = [0, 0], root = cur().root;
    for (let k = 0; k < 2; k++) { root.visible = k === 0; r.render(ctx.scene, ctx.camera); d[k] = info[key]; }
    root.visible = true; r.render(ctx.scene, ctx.camera); return d[0] - d[1];
  };
  const handle = {   // published as window.__scenery at the reveal: tools that wait for it never see a half-built scene
    get S() { return cur().S; }, get root() { return cur().root; }, get built() { return cur().built; }, get quality() { return cur().S.quality; },
    get modules() { const v = cur(); return MODULES[v.name].map(([n]) => n + (v.built[n] ? '' : ' (empty)')).join(', '); },
    venue: () => shown, venues: () => Object.keys(V).filter(k => V[k].ready),
    drawCalls: () => measure('calls'), triangles: () => measure('triangles'), textureMB: () => +(cur().S.texBytes / 1048576).toFixed(2),
    census() { const out = {}; for (const g of cur().root.children) { let calls = 0, tris = 0; g.traverse(o => { if (!o.isMesh && !o.isLine && !o.isPoints && !o.isSprite) return; calls += Array.isArray(o.material) ? o.material.length : 1;
      const geo = o.geometry, n = geo ? (geo.index ? geo.index.count : geo.attributes.position ? geo.attributes.position.count : 0) / 3 : 2; tris += n * (o.isInstancedMesh ? o.count : 1); }); out[g.name] = { calls, tris: Math.round(tris) }; } return out; },
    update: (dt, t, camera) => api.update(dt, t, camera),
  };

  const api = {
    update(dt, t, camera) { const v = shown && V[shown]; if (!v) return; if (v.built.flora) pruneOldTrees(); fanOut(v, dt, t, camera); },
    // scene.js: the court has been rebuilt for `name` and its plain look applied. A venue built before is a one-frame swap; a new one is
    // built staged like the first, with the plain look showing meanwhile.
    setVenue(name) {
      if (!MODULES[name] || name === want) return; want = name;
      const v = V[name] || make(name);
      if (v.ready) show(name); else { if (shown) hide(); v.done.push(() => { if (want === name) show(name); }); }
    },
    venue: () => want,
  };
  api.setVenue(ctx.venue && MODULES[ctx.venue()] ? ctx.venue() : 'park');
  return api;
}
