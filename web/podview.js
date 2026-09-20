// Corner inset: a 3D AirPod that mirrors the rotation of the one in your hand (relative to your calibrated grip),
// seen from behind you like the game camera. For eyeballing tracking against the real thing.
export function createPodView(el) {
  const T = window.THREE, W = 190, H = 190;
  const renderer = new T.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.setSize(W, H); el.appendChild(renderer.domElement);
  const scene = new T.Scene(), cam = new T.PerspectiveCamera(32, W / H, 0.1, 20);
  cam.position.set(0, 0.35, 4.2); cam.lookAt(0, -0.1, 0);
  scene.add(new T.HemisphereLight(0xffffff, 0x8899aa, 1.0));
  const sun = new T.DirectionalLight(0xffffff, 1.6); sun.position.set(2, 3, 4); scene.add(sun);

  const white = new T.MeshStandardMaterial({ color: 0xf4f5f7, roughness: 0.32, metalness: 0.05 });
  const dark = new T.MeshStandardMaterial({ color: 0x1b1d21, roughness: 0.5 });
  const tipM = new T.MeshStandardMaterial({ color: 0xe9eaee, roughness: 0.85 });
  const steel = new T.MeshStandardMaterial({ color: 0xc9ccd2, roughness: 0.25, metalness: 0.8 });
  const pod = new T.Group();
  const head = new T.Mesh(new T.SphereGeometry(0.42, 40, 32), white); head.scale.set(1.0, 0.92, 0.8); head.position.set(0, 0.55, 0); pod.add(head);
  const neck = new T.Mesh(new T.SphereGeometry(0.3, 32, 24), white); neck.scale.set(0.95, 1.1, 0.8); neck.position.set(0.02, 0.22, 0.02); pod.add(neck);
  const stem = new T.Mesh(new T.CapsuleGeometry(0.115, 1.05, 12, 24), white); stem.position.set(0.05, -0.42, 0.06); pod.add(stem);
  const cap = new T.Mesh(new T.CylinderGeometry(0.117, 0.117, 0.05, 24), steel); cap.position.set(0.05, -1.04, 0.06); pod.add(cap);
  const tip = new T.Mesh(new T.SphereGeometry(0.27, 32, 24), tipM); tip.scale.set(1, 1, 0.75); tip.position.set(-0.3, 0.55, -0.3); tip.rotation.y = 0.8; pod.add(tip);
  const sensor = new T.Mesh(new T.CapsuleGeometry(0.05, 0.16, 8, 16), dark); sensor.position.set(0.08, 0.62, 0.325); sensor.rotation.z = 0.5; pod.add(sensor);
  const force = new T.Mesh(new T.BoxGeometry(0.06, 0.34, 0.02), new T.MeshStandardMaterial({ color: 0xdfe1e6, roughness: 0.5 })); force.position.set(0.05, -0.35, 0.175); pod.add(force);
  const mic = new T.Mesh(new T.CircleGeometry(0.05, 20), dark); mic.position.set(0.22, 0.78, 0.27); mic.rotation.set(-0.5, 0.6, 0); pod.add(mic);
  scene.add(pod);

  // reference: faint upright ghost of the calibrated pose + a floor ring, so tilt is readable at a glance
  const ring = new T.Mesh(new T.RingGeometry(0.95, 1.0, 48), new T.MeshBasicMaterial({ color: 0x9fb0c0, transparent: true, opacity: 0.35, side: T.DoubleSide }));
  ring.rotation.x = -Math.PI / 2; ring.position.y = -1.25; scene.add(ring);
  const fwd = new T.Mesh(new T.ConeGeometry(0.07, 0.22, 12), new T.MeshBasicMaterial({ color: 0x4ade80 })); fwd.position.set(0, -1.25, -1.0); fwd.rotation.x = -Math.PI / 2; scene.add(fwd);

  const q = new T.Quaternion();
  return {
    update(P) { q.set(P[0], P[1], P[2], P[3]); pod.quaternion.slerp(q, 0.6); renderer.render(scene, cam); },
    el,
  };
}
