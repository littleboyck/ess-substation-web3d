// 储能变电站 · three.js WebGPURenderer + TSL
// ------------------------------------------------------------
import * as THREE from 'three/webgpu';
import {
  color, float, mix, smoothstep, pow, max, dot,
  positionLocal, positionWorld, uniform
} from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

const $ = (id) => document.getElementById(id);
const SITE = { radius: 60 };

// ---------- 渲染器 ----------
let renderer;
try {
  renderer = new THREE.WebGPURenderer({ antialias: true, powerPreference: 'high-performance' });
  await renderer.init();
} catch (e) {
  $('err').style.display = 'block';
  $('err').textContent = '初始化失败：' + e.message;
  throw e;
}
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const isWebGPU = renderer.backend?.isWebGPUBackend === true;
$('backend').textContent = isWebGPU ? 'WebGPU' : 'WebGL2';
document.body.appendChild(renderer.domElement);

// ---------- 场景 / 相机 ----------
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xdfeaf6, 380, 1450);

const camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 0.5, 6000);
camera.position.set(120, 70, 150);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.maxPolarAngle = Math.PI * 0.495;
controls.minDistance = 6;
controls.maxDistance = 900;

// 太阳方向
const sunDir = new THREE.Vector3(0.45, 0.72, 0.35).normalize();

// ---------- 天空（Canvas 渐变贴图 + 太阳光晕，稳定可控） ----------
function makeSkyTexture() {
  const c = document.createElement('canvas');
  c.width = 16; c.height = 512;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0.00, '#0f3f9e');
  grad.addColorStop(0.22, '#2a63c2');
  grad.addColorStop(0.44, '#6f9edd');
  grad.addColorStop(0.58, '#b9d3ee');
  grad.addColorStop(0.66, '#e3eef8');
  grad.addColorStop(0.70, '#f4f3ea');
  grad.addColorStop(0.76, '#d9e6f2');
  grad.addColorStop(1.00, '#c9dae9');
  g.fillStyle = grad; g.fillRect(0, 0, 16, 512);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.LinearFilter;
  return t;
}
const skyTex = makeSkyTexture();
function makeEnvTexture() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0.00, '#0d3f9c');
  grad.addColorStop(0.35, '#4a7fd0');
  grad.addColorStop(0.48, '#b9d3ee');
  grad.addColorStop(0.52, '#e8e2d2');
  grad.addColorStop(0.56, '#8f9a6f');
  grad.addColorStop(1.00, '#3c4630');
  g.fillStyle = grad; g.fillRect(0, 0, 512, 256);
  const rg = g.createRadialGradient(340, 78, 0, 340, 78, 90);
  rg.addColorStop(0, 'rgba(255,250,235,1)');
  rg.addColorStop(0.3, 'rgba(255,240,205,0.55)');
  rg.addColorStop(1, 'rgba(255,240,205,0)');
  g.fillStyle = rg; g.fillRect(0, 0, 512, 256);
  const t = new THREE.CanvasTexture(c);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
try {
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromEquirectangular(makeEnvTexture()).texture;
  scene.environmentIntensity = 0.85;
} catch (e) {
  scene.environment = makeEnvTexture();
}

const skyDome = new THREE.Mesh(
  new THREE.SphereGeometry(2600, 40, 24),
  new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, depthWrite: false, fog: false, toneMapped: false })
);
skyDome.frustumCulled = false;
scene.add(skyDome);

// 太阳光晕
function makeGlowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const rg = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  rg.addColorStop(0.00, 'rgba(255,252,240,1)');
  rg.addColorStop(0.16, 'rgba(255,244,214,0.85)');
  rg.addColorStop(0.42, 'rgba(255,232,182,0.28)');
  rg.addColorStop(1.00, 'rgba(255,232,182,0)');
  g.fillStyle = rg; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({
  map: makeGlowTexture(), color: 0xffffff, transparent: true,
  depthWrite: false, depthTest: false, fog: false, toneMapped: false, blending: THREE.AdditiveBlending
}));
sunSprite.scale.setScalar(320);
scene.add(sunSprite);

// ---------- 灯光 ----------
const hemi = new THREE.HemisphereLight(0xdfeaf7, 0x6d7358, 0.50);
scene.add(hemi);

const sun = new THREE.DirectionalLight(0xfff4e2, 4.2);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0006;
sun.shadow.normalBias = 0.045;
{
  const c = sun.shadow.camera;
  c.left = -80; c.right = 80; c.top = 80; c.bottom = -80; c.near = 1; c.far = 420;
  c.updateProjectionMatrix();
}
scene.add(sun);
scene.add(sun.target);

const fill = new THREE.DirectionalLight(0xbcd2ff, 0.18);
fill.position.set(-80, 40, -60);
scene.add(fill);

function setSunElevation(deg) {
  const el = THREE.MathUtils.degToRad(deg);
  const az = THREE.MathUtils.degToRad(58);
  sunDir.set(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)).normalize();
  sun.position.copy(sunDir).multiplyScalar(240);
  sun.target.position.set(4, 0, 0);
  sun.target.updateMatrixWorld();
  sunSprite.position.copy(sunDir).multiplyScalar(2100);
  sunSprite.material.opacity = 0.55 + 0.45 * Math.sin(el);
  sun.intensity = 3.4 + 2.6 * Math.sin(el);
  hemi.intensity = 0.30 + 0.55 * Math.sin(el);
}
setSunElevation(46);

// ---------- TSL 做旧涂装材质（替代 Blender 的盒子投影贴图） ----------
function weatheredPaint(baseHex, grimeHex, metalness, roughA, roughB, dirtStrength) {
  const m = new THREE.MeshStandardNodeMaterial({ metalness, roughness: roughA });
  const grime = smoothstep(0.10, 2.2, positionWorld.y).oneMinus();
  const blotch = grime.mul(0.75).add(grime.mul(0.25));
  m.colorNode = mix(color(baseHex), color(grimeHex), blotch.mul(dirtStrength));
  m.roughnessNode = mix(float(roughA), float(roughB), grime);
  return m;
}

const matWall = weatheredPaint(0xf3f5f7, 0xa9b0b6, 0.10, 0.40, 0.82, 0.55);
const matFrame = weatheredPaint(0x4b5157, 0x2b3034, 0.55, 0.34, 0.70, 0.65);
const matDark = weatheredPaint(0x2a2f34, 0x171a1d, 0.45, 0.42, 0.75, 0.5);

// ---------- 载入 GLB ----------
const loader = new GLTFLoader();
const draco = new DRACOLoader();
draco.setDecoderPath('./vendor/three/libs/draco/');
loader.setDRACOLoader(draco);
const bar = document.querySelector('#bar i');
const pct = $('pct');
const loaderEl = $('loader');
const slowTimer = setTimeout(() => {
  if (!window.__ready) loaderEl.style.display = 'flex';
}, 400);

const gltf = await new Promise((resolve, reject) => {
  loader.load('./model/ess-substation.glb', resolve, (ev) => {
    if (ev.total) {
      const p = Math.min(100, Math.round(ev.loaded / ev.total * 100));
      bar.style.width = p + '%';
      pct.textContent = p + '%';
    } else {
      pct.textContent = (ev.loaded / 1048576).toFixed(1) + ' MB';
    }
  }, reject);
});

const model = gltf.scene;
scene.add(model);

// 材质替换 / 参数修正
const matCache = new Map();
model.traverse((o) => {
  if (!o.isMesh) return;
  o.castShadow = true;
  o.receiveShadow = true;
  o.frustumCulled = false;

  const apply = (mat) => {
    if (!mat) return mat;
    if (matCache.has(mat.name)) return matCache.get(mat.name);
    let out = mat;
    switch (mat.name) {
      case '箱体_白灰': out = matWall; break;
      case '钢构_深灰': out = matFrame; break;
      case '百叶_深色':
      case '面板_深蓝': out = matDark; break;
      case '草坪_贴图': {
        if (mat.map) {
          mat.map.anisotropy = Math.min(16, renderer.getMaxAnisotropy?.() ?? 16);
          mat.map.colorSpace = THREE.SRGBColorSpace;
          mat.map.wrapS = mat.map.wrapT = THREE.RepeatWrapping;
        }
        mat.color = new THREE.Color(0x8fbb63);   // 把偏黄的草地贴图压成青绿
        mat.roughness = 0.96;
        mat.metalness = 0.0;
        out = mat;
        break;
      }
      default: {
        if (mat.map) mat.map.colorSpace = THREE.SRGBColorSpace;
        const nm = mat.name || '';
        if (nm.includes('风机_法兰')) {
          mat.map = null; mat.color = new THREE.Color(0x8b9199);
          mat.metalness = 0.22; mat.roughness = 0.58; mat.needsUpdate = true;
        } else if (nm.includes('风机_叶轮')) {
          mat.color = new THREE.Color(0x9aa0a8); mat.metalness = 0.85; mat.roughness = 0.30;
        } else if (nm.includes('风机_护罩')) {
          mat.metalness = 0.85; mat.roughness = 0.28;
        } else if (nm.includes('金属_银')) {
          mat.metalness = 0.55; mat.roughness = 0.38;
        }
        const n = mat.name || '';
        if (/sapling|twig|branch/i.test(n)) {
          mat.alphaTest = 0.42;
          mat.transparent = false;
          mat.side = THREE.DoubleSide;
          mat.depthWrite = true;
          mat.metalness = 0.0;
          if (/twig|branch/i.test(n)) mat.roughness = 0.85;
          else mat.roughness = 0.72;
        }
        out = mat;
      }
    }
    matCache.set(mat.name, out);
    return out;
  };

  o.material = Array.isArray(o.material) ? o.material.map(apply) : apply(o.material);

  // 草坪大地不投影（省 shadow 开销）
  if (o.name.includes('草坪')) o.castShadow = false;
});

// ---------- 取景 ----------
const siteRef = model.getObjectByName('储能单元_R2C2');
const center = new THREE.Vector3();
if (siteRef) siteRef.getWorldPosition(center);
if (center.lengthSq() < 1e-6) {
  const b = new THREE.Box3().setFromObject(model);
  b.getCenter(center);
}
center.y = 0;

const VIEWS = {
  pano:   { pos: [center.x + 27, 9.5, center.z + 40], tgt: [center.x - 1, 6, center.z - 1], fov: 44 },
  aerial: { pos: [center.x + 34, 74, center.z + 46], tgt: [center.x, 0, center.z], fov: 40 },
  close:  { pos: [center.x - 17, 2.3, center.z + 17], tgt: [center.x + 8, 2.6, center.z - 2], fov: 40 },
  detail: { pos: [center.x - 0.75, 1.85, center.z + 5.8], tgt: [center.x - 1.55, 1.45, center.z + 1.30], fov: 34 }
};

let camAnim = null;
function goView(name) {
  const v = VIEWS[name];
  if (!v) return;
  document.querySelectorAll('#views button').forEach(b =>
    b.classList.toggle('active', b.dataset.view === name));
  camAnim = {
    t: 0,
    fromPos: camera.position.clone(), toPos: new THREE.Vector3(...v.pos),
    fromTgt: controls.target.clone(), toTgt: new THREE.Vector3(...v.tgt),
    fromFov: camera.fov, toFov: v.fov
  };
}
document.querySelectorAll('#views button').forEach(b =>
  b.addEventListener('click', () => goView(b.dataset.view)));

controls.target.set(...VIEWS.pano.tgt);
camera.position.set(...VIEWS.pano.pos);
camera.fov = VIEWS.pano.fov;
camera.updateProjectionMatrix();

// ---------- UI ----------
$('expo').addEventListener('input', (e) => {
  renderer.toneMappingExposure = +e.target.value;
  $('expoVal').textContent = (+e.target.value).toFixed(2);
});
$('sun').addEventListener('input', (e) => {
  setSunElevation(+e.target.value);
  $('sunVal').textContent = e.target.value + '°';
});

const state = { rotate: false, shadow: true, fog: true };
const sw = (id, key, fn) => {
  const el = $(id);
  el.addEventListener('click', () => {
    state[key] = !state[key];
    el.classList.toggle('on', state[key]);
    fn(state[key]);
  });
};
sw('rotate', 'rotate', v => { controls.autoRotate = v; controls.autoRotateSpeed = 0.55; });
sw('shadow', 'shadow', v => { renderer.shadowMap.enabled = v; sun.castShadow = v; });
sw('fog', 'fog', v => { scene.fog = v ? new THREE.Fog(0xdfeaf6, 380, 1450) : null; });

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------- 统计 ----------
let frames = 0, last = performance.now(), tris = 0;
model.traverse(o => {
  if (o.isMesh && o.geometry?.index) tris += o.geometry.index.count / 3;
  else if (o.isMesh && o.geometry?.attributes?.position) tris += o.geometry.attributes.position.count / 3;
});
$('tris').textContent = (tris / 1000).toFixed(0) + 'k';

// ---------- 主循环 ----------
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = clock.getDelta();

  if (camAnim) {
    camAnim.t = Math.min(1, camAnim.t + dt * 1.6);
    const e = 1 - Math.pow(1 - camAnim.t, 3);
    camera.position.lerpVectors(camAnim.fromPos, camAnim.toPos, e);
    controls.target.lerpVectors(camAnim.fromTgt, camAnim.toTgt, e);
    camera.fov = THREE.MathUtils.lerp(camAnim.fromFov, camAnim.toFov, e);
    camera.updateProjectionMatrix();
    if (camAnim.t >= 1) camAnim = null;
  }

  controls.update();
  skyDome.position.copy(camera.position);
  renderer.render(scene, camera);

  frames++;
  const now = performance.now();
  if (now - last > 500) {
    $('fps').textContent = Math.round(frames * 1000 / (now - last));
    frames = 0; last = now;
  }
});

// 加载完成
clearTimeout(slowTimer);
loaderEl.style.display = 'none';
window.__ready = true;
window.__scene = scene;
window.__model = model;
window.__renderer = renderer;
