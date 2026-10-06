// 盤（5×5）の 3D 表示。three.js。ゲームの状態は持たず、main.js の render() から sync() で渡される。
import * as THREE from 'three';

const W = 0.63, D = 0.88, T = 0.03;      // カードの幅・奥行き・厚み
const PX = 0.76, PZ = 1.0;               // マスの間隔
const REST = T / 2 + 0.002;
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const ease = (u) => 1 - (1 - u) * (1 - u);
const pos = (k) => [(k % 5 - 2) * PX, (Math.floor(k / 5) - 2) * PZ];

// カードの絵は main.js の SVG（cardHtml / backHtml）をそのまま画像にして使う。色の組み合わせごとにキャッシュ
const texCache = new Map();
function texture(key, html) {
  let t = texCache.get(key);
  if (t) return t;
  const cv = document.createElement('canvas');
  cv.width = 315; cv.height = 440;
  const x = cv.getContext('2d');
  x.fillStyle = '#16182B'; x.fillRect(0, 0, 315, 440);
  t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  const svg = html.match(/<svg[\s\S]*<\/svg>/)[0].replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" width="315" height="440" ');
  const img = new Image();
  img.onload = () => { x.drawImage(img, 0, 0, 315, 440); t.needsUpdate = true; };
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  texCache.set(key, t);
  return t;
}

export function createBoard3D(el, { front, back, onCell, isHot }) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.domElement.style.cssText = 'display:block;width:100%;height:100%';
  renderer.domElement.setAttribute('aria-label', '盤面（5×5 のマス）');
  el.appendChild(renderer.domElement);

  const BG = 0x16182B;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BG);
  scene.fog = new THREE.Fog(BG, 12, 22);
  const cam = new THREE.PerspectiveCamera(32, 1, 0.1, 40);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x777ca0, 1.6));
  const sun = new THREE.DirectionalLight(0xfff4e0, 3.2);
  sun.position.set(-2.5, 7, 3.5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4, near: 1, far: 16 });
  sun.shadow.bias = -0.0004;
  scene.add(sun);

  const table = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.MeshStandardMaterial({ color: 0x20244a, roughness: 0.95 }));
  table.rotation.x = -Math.PI / 2;
  table.receiveShadow = true;
  scene.add(table);

  // マス（空きマスの目印。押せるものは縁が光る。タップの判定にも使う）
  const ACCENT = new THREE.Color(0xF2B632);
  const slots = [];
  for (let k = 0; k < 25; k++) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(W + 0.1, D + 0.1), new THREE.MeshStandardMaterial({ color: 0x2c315c, roughness: 1, emissive: ACCENT, emissiveIntensity: 0 }));
    m.rotation.x = -Math.PI / 2;
    const [x, z] = pos(k);
    m.position.set(x, 0.001, z);
    m.receiveShadow = true;
    m.userData = { k, hot: false, flash: null };
    scene.add(m);
    slots.push(m);
  }

  // 辺は紙の色、上面が表、下面が裏。UV は面ごとに貼り直す（裏返しても絵が正しい向きになるように）
  const geo = new THREE.BoxGeometry(W, T, D);
  const uv = geo.attributes.uv, nor = geo.attributes.normal, p = geo.attributes.position;
  for (let i = 0; i < uv.count; i++) {
    const up = nor.getY(i) > 0.5, down = nor.getY(i) < -0.5;
    if (up) uv.setXY(i, p.getX(i) / W + 0.5, 0.5 - p.getZ(i) / D);
    if (down) uv.setXY(i, p.getX(i) / W + 0.5, 0.5 + p.getZ(i) / D);
  }
  const edge = new THREE.MeshStandardMaterial({ color: 0xe9e2d0, roughness: 0.8 });
  const face = (map) => new THREE.MeshStandardMaterial({ map, roughness: 0.55 });

  const cards = Array(25).fill(null);
  const tweens = [];
  // ponytail: 動きを止める設定のときは、時間 0 で最後の形にする
  function tween(dur, fn, done) {
    if (reduce || dur <= 0) { fn(1); if (done) done(); return; }
    tweens.push({ t0: performance.now(), dur, fn, done });
  }

  function flash(k, hex) { slots[k].userData.flash = { c: new THREE.Color(hex), t0: performance.now() }; }

  function setFaces(c, key, up, card, mine) {
    const f = front(card), b = back(mine ? card.c : null);
    c.mesh.material = [edge, edge, face(texture('f' + card.c.join(''), f)), face(texture('b' + (mine ? card.c.join('') : ''), b)), edge, edge];
    // BoxGeometry の面の並びは +x -x +y -y +z -z
    c.key = key;
    c.up = up;
  }

  function create(k, cell) {
    const mesh = new THREE.Mesh(geo);
    mesh.castShadow = mesh.receiveShadow = true;
    const [x, z] = pos(k);
    const c = { mesh, x, z, busy: 0, key: '', up: false };
    cards[k] = c;
    setFaces(c, key(cell), cell.up, cell.card, cell.owner === 0);
    mesh.rotation.x = cell.up ? 0 : Math.PI;
    mesh.position.set(x, REST, z);
    scene.add(mesh);
    if (cell.owner < 0) return;   // 最初の 1 枚はそのまま置く
    // 置く: 手札のある画面の下から、弧を描いて飛んでくる
    c.busy++;
    const sx = x * 0.4, sz = 6.2;
    tween(700, (u) => {
      const e = ease(u);
      mesh.position.set(sx + (x - sx) * e, REST + Math.sin(Math.PI * u) * 1.4 + (1 - e) * 1.2, sz + (z - sz) * e);
      mesh.rotation.y = (1 - e) * 0.7;
      mesh.rotation.z = (1 - e) * 0.25;
    }, () => { c.busy--; mesh.rotation.y = mesh.rotation.z = 0; mesh.position.set(x, REST, z); });
  }

  function flipUp(k, c, cell, fx) {
    c.busy++;
    const m = c.mesh;
    setFaces(c, key(cell), true, cell.card, false);
    tween(650, (u) => {
      m.position.y = REST + Math.sin(Math.PI * u) * 1.0;
      m.rotation.x = Math.PI * (1 - ease(u));
    }, () => {
      m.rotation.x = 0; m.position.y = REST;
      const r = fx && fx.k === k ? fx.r : 'none';
      if (r === 'ok') {          // 成功: 2 回弾んで緑に光る
        flash(k, 0x30c47c);
        tween(500, (u) => { m.position.y = REST + Math.abs(Math.sin(u * Math.PI * 2)) * 0.35 * (1 - u); }, () => { m.position.y = REST; c.busy--; });
      } else if (r === 'ng') {   // 失敗: 小さく揺れて赤く光る
        flash(k, 0xe5484d);
        tween(450, (u) => { m.position.x = c.x + Math.sin(u * Math.PI * 6) * 0.07 * (1 - u); }, () => { m.position.x = c.x; c.busy--; });
      } else c.busy--;
    });
  }

  const key = (cell) => (cell.up ? 'f' : 'b' + (cell.owner === 0 ? 'm' : ''));

  function sync(board, fx) {
    board.forEach((cell, k) => {
      const c = cards[k];
      if (!cell) { if (c) { scene.remove(c.mesh); cards[k] = null; } }
      else if (!c) create(k, cell);
      else if (key(cell) !== c.key) {
        if (cell.up && !c.up) flipUp(k, c, cell, fx);
        else { setFaces(c, key(cell), cell.up, cell.card, cell.owner === 0); c.mesh.rotation.x = cell.up ? 0 : Math.PI; }
      }
      slots[k].userData.hot = !!isHot(k);
    });
  }

  // 大きさ。盤の四隅（カードの高さ込み）が画面に収まる距離までカメラを引く
  let aspect = 1;
  function resize() {
    const w = el.clientWidth, h = el.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    aspect = w / h;
    cam.aspect = aspect;
    cam.updateProjectionMatrix();
    placeCamera(0);
  }
  const tilt = 1.0;   // 見下ろす角（ラジアン。大きいほど真上に近い）
  const corners = [-1, 1].flatMap((sx) => [-1, 1].map((sz) => new THREE.Vector3(sx * 2 * PX + sx * 0.4, 0.3, sz * 2 * PZ + sz * 0.55)));
  function placeCamera(t) {
    const sway = reduce ? 0 : Math.sin(t / 2600) * 0.22;
    for (let d = 4; d < 30; d += 0.15) {
      cam.position.set(sway * d * 0.4, Math.sin(tilt) * d, Math.cos(tilt) * d);
      cam.lookAt(0, 0, 0.1);
      cam.updateMatrixWorld();
      if (corners.every((v) => { const q = v.clone().project(cam); return Math.abs(q.x) < 0.97 && Math.abs(q.y) < 0.97; })) break;
    }
  }
  new ResizeObserver(resize).observe(el);

  function frame(now) {
    requestAnimationFrame(frame);
    if (!el.isConnected || !el.clientWidth) return;
    for (let i = tweens.length - 1; i >= 0; i--) {
      const a = tweens[i], u = Math.min(1, (now - a.t0) / a.dur);
      a.fn(u);
      if (u >= 1) { tweens.splice(i, 1); if (a.done) a.done(); }
    }
    const s = reduce ? 0 : Math.sin(now / 520);
    slots.forEach((m, k) => {
      const d = m.userData, mat = m.material;
      let e = d.hot ? 0.35 + 0.25 * s : 0;
      mat.emissive.copy(ACCENT);
      if (d.flash) {
        const u = (now - d.flash.t0) / 900;
        if (u >= 1) d.flash = null;
        else { mat.emissive.copy(d.flash.c); e = Math.max(e, 1.2 * (1 - u)); }
      }
      mat.emissiveIntensity = e;
      const c = cards[k];
      if (c && !c.busy) c.mesh.position.y = REST + (d.hot && !reduce ? 0.06 + 0.05 * s : 0);
    });
    placeCamera(now);
    sun.position.x = -2.5 + (reduce ? 0 : Math.sin(now / 3300) * 0.8);
    renderer.render(scene, cam);
  }
  requestAnimationFrame(frame);

  // タップしたマスの番号
  const ray = new THREE.Raycaster(), pt = new THREE.Vector2();
  renderer.domElement.addEventListener('click', (e) => {
    const r = renderer.domElement.getBoundingClientRect();
    pt.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(pt, cam);
    const hit = ray.intersectObjects(slots)[0];
    if (hit) onCell(hit.object.userData.k);
  });

  return { sync };
}
