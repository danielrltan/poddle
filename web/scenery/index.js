// Everything beyond the fences. Contract: docs/SCENERY.md. This file only wires: shared context, the four modules (each
// isolated, so one broken module never takes the scene down), a hitch-free arrival (staged build, shaders compiled off the frame,
// one-frame swap), lighting/fog from the palette, update fan-out, debug handle.
import { makeShared, LIGHT } from './shared.js';
import * as sky from './sky.js';
import * as flora from './flora.js';
import * as park from './park.js';
import * as wind from './wind.js';

const MODULES = [['sky', sky], ['park', park], ['flora', flora], ['wind', wind]];   // far to near, fx last

export function createScenery(THREE, ctx) {
  const S = makeShared(THREE, ctx), pal = S.pal, root = new THREE.Group(), live = [], built = {};
  root.name = 'scenery'; root.visible = false; ctx.scene.add(root);
  // Arriving must not hitch the game (measured on an M4: 74 ms to build + 50-65 ms compiling 17 programs inside the first frame that saw
  // them). So: one module per task, everything hidden, shaders compiled off the frame (KHR_parallel_shader_compile through r160's
  // compileAsync), and only THEN the swap: old look out, new look in, in a single frame. `ready` gates update() and the debug handle.
  let ready = false, next = 0;
  const build = ([name, mod]) => {
    try {
      const m = mod.create(THREE, S); if (!m || !m.group) throw new Error('create() returned no group');
      m.group.name = name; root.add(m.group); built[name] = m.group.children.length > 0;
      if (typeof m.update === 'function') live.push({ name, update: m.update, dead: false });
    } catch (e) { built[name] = false; console.warn('scenery: ' + name + ' failed, carrying on without it:', e); }
  };
  const fanOut = (dt, t, camera) => {
    S._tick(t);
    for (let i = 0; i < live.length; i++) {
      const m = live[i]; if (m.dead) continue;
      try { m.update(dt, t, camera); } catch (e) { m.dead = true; console.warn('scenery: ' + m.name + ' update failed, stopped updating it:', e); }
    }
  };
  const reveal = () => {
    if (ready) return; ready = true; root.visible = true;
    // light: a touch warmer, same sun VECTOR (short readable court shadows) and R-B kept small so the white lines stay white
    ctx.sun.color.set(pal.sunLight); ctx.sun.intensity = LIGHT.sun;
    ctx.hemi.color.set(pal.hemiSky); ctx.hemi.groundColor.set(pal.hemiGround); ctx.hemi.intensity = LIGHT.hemi;
    ctx.fog.near = LIGHT.fogNear; ctx.fog.far = LIGHT.fogFar;
    // the old look is only retired by what replaces it: plain dome + sphere clouds (and the fog colour that matches that dome's horizon)
    // go once sky.js has built something; scene.js's lollipop trees, which stand exactly in the calm band, go once flora.js has.
    if (built.sky) { for (const o of ctx.plainSky) o.visible = false; ctx.fog.color.set(pal.fog); }
    if (typeof window !== 'undefined') window.__scenery = handle;
  };
  const finish = () => {
    root.traverse(o => { o.castShadow = false; o.receiveShadow = false; });   // the sun's shadow frustum is fitted to the court: ours are painted
    fanOut(0, 0, ctx.camera);                                                 // park.js paints its shadows on the first update (it needs flora's palms): do it before compiling
    root.traverse(o => { o.castShadow = false; o.receiveShadow = false; });
    let p = null; try { if (typeof ctx.renderer.compileAsync === 'function') p = ctx.renderer.compileAsync(root, ctx.camera, ctx.scene); } catch (e) { p = null; }
    if (p && typeof p.then === 'function') { p.then(reveal, reveal); setTimeout(reveal, 4000); } else reveal();   // a lost context must not leave the old look up for ever: after 4 s just show it
  };
  const step = () => { build(MODULES[next++]); if (next < MODULES.length) setTimeout(step, 0); else finish(); };

  // scene.js rebuilds its court group on setCourt() and does not expose it: spot it by its 600 m grass slab, hide its instanced trees.
  const pruneOldTrees = () => {
    const kids = ctx.scene.children;
    for (let i = 0; i < kids.length; i++) {
      const g = kids[i]; if (!g.isGroup || g === root || g.userData.sceneryPruned) continue; g.userData.sceneryPruned = true;
      let slab = false; for (let j = 0; j < g.children.length; j++) { const p = g.children[j].geometry && g.children[j].geometry.parameters; if (p && p.width >= 300) slab = true; }
      if (slab) for (let j = 0; j < g.children.length; j++) if (g.children[j].isInstancedMesh) g.children[j].visible = false;
    }
  };

  // verifier handle. drawCalls()/triangles(): renderer.info for a frame with the scenery minus the same frame without it (current
  // camera, so frustum-culled things do not count: check the wide view too). census(): camera-independent upper bound.
  const measure = key => {
    const r = ctx.renderer, info = r.info.render, d = [0, 0];
    for (let k = 0; k < 2; k++) { root.visible = k === 0; r.render(ctx.scene, ctx.camera); d[k] = info[key]; }
    root.visible = true; r.render(ctx.scene, ctx.camera); return d[0] - d[1];
  };
  const handle = {   // published as window.__scenery at the reveal: tools that wait for it never see a half-built scene
    S, root, built, quality: S.quality, get modules() { return MODULES.map(([n]) => n + (built[n] ? '' : ' (empty)')).join(', '); },
    drawCalls: () => measure('calls'), triangles: () => measure('triangles'), textureMB: () => +(S.texBytes / 1048576).toFixed(2),
    census() { const out = {}; for (const g of root.children) { let calls = 0, tris = 0; g.traverse(o => { if (!o.isMesh && !o.isLine && !o.isPoints && !o.isSprite) return; calls += Array.isArray(o.material) ? o.material.length : 1;
      const geo = o.geometry, n = geo ? (geo.index ? geo.index.count : geo.attributes.position ? geo.attributes.position.count : 0) / 3 : 2; tris += n * (o.isInstancedMesh ? o.count : 1); }); out[g.name] = { calls, tris: Math.round(tris) }; } return out; },
    update: (dt, t, camera) => api.update(dt, t, camera),
  };

  const api = { update(dt, t, camera) { if (!ready) return; if (built.flora) pruneOldTrees(); fanOut(dt, t, camera); } };
  step();
  return api;
}
